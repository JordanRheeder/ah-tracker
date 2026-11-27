"""Price forecasts for trade goods (and anything on the watchlist) on EU PvP Alliance, learned from four
Forever PvP markets.

EU PvP Alliance (your house) is the source of truth: the model is scored and used only there. EU PvP
Horde, US PvP Alliance and US PvP Horde launched the same day under the same rules, so they add
training examples and a cross-market signal (how far an item sits from, and how it moved on, the
other markets).

For every trade good and watched item, every 6 hours, it learns the change in log price over the next 1, 3 and 7 days
as quantiles (10%, 50%, 90%) with LightGBM, from:
  recent moves (6h, 1d, 3d), distance from the 3- and 7-day medians, recent volatility,
  listed quantity and its change, the item's sales rate and price level, its category,
  days since launch, and the other markets' price level and recent move.

Before anything is shown it is tested walk-forward: trained only on what was known at each cutoff and
scored on the following day of EU Alliance prices, against "no change" and the snap-back estimate the
dashboard uses today. Results go to ml_eval; forecasts to ml_forecast (only used by the dashboard when
the model beats both baselines) and ml_forecast_log (kept 30 days, scored live against what happened). Trade goods and the other watched items (consumables and so on) are
also scored separately ("groups"): a group's forecasts are shown only when the model passes on that group.

Run: .venv/bin/python ml/forecast.py [path/to/ah-tracker.sqlite]
"""
import json
import os
import sqlite3
import sys
import time

import numpy as np
import pandas as pd
import lightgbm as lgb

DB = sys.argv[1] if len(sys.argv) > 1 else "data/ah-tracker.sqlite"
OWN_HOUSE = 110  # EU PvP Alliance
OWN = "eu-alliance"
BIN = 6 * 3600  # 6-hour bins
HORIZONS = {"1d": 4, "3d": 12, "7d": 28}  # in bins
QUANTILES = (0.1, 0.5, 0.9)
WARMUP_BINS = 8  # skip launch's first 2 days as forecast origins
# Training starts this many days after launch: the launch weeks' crash (prices falling 20-30% every 3 days)
# is a different market from today's. Walk-forward test, 2026-11-21: starting at day 4-6 scored best on 3-day
# forecasts (day 2: 18.8% better than no change, day 6: 19.9%); day 8+ leaves too little to test. Override
# with AHT_TRAIN_START_DAYS.
TRAIN_START_DAYS = float(os.environ.get("AHT_TRAIN_START_DAYS", "6"))
# Other markets are re-downloaded once a day, so their last price is carried forward for up to two days
# (8 bins); your own house is polled hourly, so only 12 hours. A gap here made every current row look
# like launch, when other markets were often missing, and pushed all 3-day forecasts down.
FILL_BINS = {OWN: 2}
REF_FILL_BINS = 8
PARAMS = dict(n_estimators=300, learning_rate=0.04, num_leaves=31, min_child_samples=40,
              subsample=0.8, subsample_freq=1, colsample_bytree=0.8, verbose=-1)


def load(conn):
    items = pd.read_sql("""
        SELECT i.item_id, coalesce(i.class_id, -1) * 100 + coalesce(i.subclass_id, -1) subclass,
               CASE WHEN i.class_id = 7 THEN 'trade' ELSE 'other' END grp,
               coalesce(g.sold_per_day, 0) sold, coalesce(g.sale_rate, 0) rate
        FROM item i LEFT JOIN tsm_region g ON g.item_id = i.item_id AND g.updated_at = (SELECT max(updated_at) FROM tsm_region)
        WHERE i.class_id = 7 OR i.item_id IN (SELECT item_id FROM watch_item)""", conn)
    ids = ",".join(str(i) for i in items.item_id)
    own = pd.read_sql(f"""
        SELECT '{OWN}' market, s.item_id, s.ts, s.min_buyout price, s.quantity qty
        FROM item_snapshot s JOIN snapshot sn ON sn.id = s.snapshot_id
        WHERE sn.house_id = {OWN_HOUSE} AND sn.source = 'undermine' AND s.min_buyout > 0 AND s.item_id IN ({ids})""", conn)
    ref = pd.read_sql(f"SELECT market, item_id, ts, price, qty FROM ref_price WHERE price > 0 AND item_id IN ({ids})", conn)
    return items, pd.concat([own, ref], ignore_index=True)


def to_bins(raw):
    """Median price and quantity per (market, item, 6-hour bin), on a regular grid, gaps up to 12h filled."""
    raw = raw.assign(bin=(raw.ts // BIN) * BIN)
    agg = raw.groupby(["market", "item_id", "bin"]).agg(price=("price", "median"), qty=("qty", "median")).reset_index()
    lo, hi = agg.bin.min(), agg.bin.max()
    grid = np.arange(lo, hi + BIN, BIN)
    out = []
    for (m, i), g in agg.groupby(["market", "item_id"]):
        g = g.set_index("bin").reindex(grid)
        g[["price", "qty"]] = g[["price", "qty"]].ffill(limit=FILL_BINS.get(m, REF_FILL_BINS))
        g["market"], g["item_id"] = m, i
        out.append(g.reset_index(names="bin"))
    return pd.concat(out, ignore_index=True)


def features(df, items):
    df = df.sort_values(["market", "item_id", "bin"]).copy()
    df["lp"] = np.log(df.price)
    df["lq"] = np.log1p(df.qty)
    g = df.groupby(["market", "item_id"], sort=False)
    df["r6h"] = g.lp.diff(1)
    df["r1d"] = g.lp.diff(4)
    df["r3d"] = g.lp.diff(12)
    df["dev3d"] = df.lp - g.lp.transform(lambda s: s.rolling(12, min_periods=6).median())
    df["dev7d"] = df.lp - g.lp.transform(lambda s: s.rolling(28, min_periods=12).median())
    df["vol"] = g.r6h.transform(lambda s: s.rolling(8, min_periods=4).std())
    df["dq1d"] = g.lq.diff(4)
    df["dq3d"] = g.lq.diff(12)
    launch = df.bin.min()
    df["age"] = (df.bin - launch) / 86400
    df["bin_idx"] = ((df.bin - launch) // BIN).astype(int)
    # Cross-market: the other markets' average log price and 1-day move for the same item and time.
    tot = df.groupby(["item_id", "bin"]).agg(sum_lp=("lp", "sum"), n=("lp", "count"), sum_r=("r1d", "sum"), n_r=("r1d", "count")).reset_index()
    df = df.merge(tot, on=["item_id", "bin"], how="left")
    others = (df.n - df.lp.notna()).clip(lower=0)
    df["gap"] = np.where(others > 0, df.lp - (df.sum_lp - df.lp.fillna(0)) / others.replace(0, np.nan), np.nan)
    others_r = (df.n_r - df.r1d.notna()).clip(lower=0)
    df["other_r1d"] = np.where(others_r > 0, (df.sum_r - df.r1d.fillna(0)) / others_r.replace(0, np.nan), np.nan)
    df = df.drop(columns=["sum_lp", "n", "sum_r", "n_r"])
    df = df.merge(items, on="item_id", how="left")
    df["lsold"] = np.log1p(df.sold)
    df["market_c"] = df.market.astype("category")
    df["subclass_c"] = df.subclass.astype("category")
    g = df.groupby(["market", "item_id"], sort=False)
    for name, h in HORIZONS.items():
        df[f"y_{name}"] = g.lp.shift(-h) - df.lp
    return df


FEATURES = ["lp", "r6h", "r1d", "r3d", "dev3d", "dev7d", "vol", "lq", "dq1d", "dq3d", "age", "gap", "other_r1d",
            "lsold", "rate", "market_c", "subclass_c"]


def fit(train, ycol):
    models = {}
    for q in QUANTILES:
        m = lgb.LGBMRegressor(objective="quantile", alpha=q, **PARAMS)
        m.fit(train[FEATURES], train[ycol])
        models[q] = m
    return models


def predict(models, rows):
    p = np.column_stack([models[q].predict(rows[FEATURES]) for q in QUANTILES])
    p.sort(axis=1)  # keep quantiles in order
    return p


def evaluate(df, name, h):
    """Walk-forward on EU Alliance: for each of the last test days, train on everything whose outcome was
    known by then (all markets) and score the next day's EU Alliance origins."""
    ycol = f"y_{name}"
    usable = df[(df.bin_idx >= WARMUP_BINS) & df.lp.notna() & df[ycol].notna()]
    train_ok = usable.age >= TRAIN_START_DAYS
    last = usable.bin_idx.max()
    rows, held, by_group = [], [], {}
    for k in range(3):  # three test days, newest last
        test_lo = last - (k + 1) * 4 + 1
        test = usable[(usable.bin_idx >= test_lo) & (usable.bin_idx < test_lo + 4) & (usable.market == OWN)]
        train = usable[(usable.bin_idx + h < test_lo) & train_ok]  # outcome known before the test day starts
        if len(test) < 50 or len(train) < 1000:
            continue
        models = fit(train, ycol)
        p = predict(models, test)
        y = test[ycol].to_numpy()
        snap = -0.5 * test.dev3d.fillna(0).to_numpy()
        held.append((y, p))
        rows.append(dict(n=len(test), mae_model=np.mean(np.abs(y - p[:, 1])), mae_naive=np.mean(np.abs(y)),
                         mae_snap=np.mean(np.abs(y - snap)), cover=np.mean((y >= p[:, 0]) & (y <= p[:, 2])),
                         direction=np.mean(np.sign(p[:, 1]) == np.sign(y))))
        for grp in test.grp.unique():
            m = (test.grp == grp).to_numpy()
            b = by_group.setdefault(grp, dict(y=[], p=[], snap=[]))
            b["y"].append(y[m]); b["p"].append(p[m]); b["snap"].append(snap[m])
    if not rows:
        return None
    r = pd.DataFrame(rows)
    w = r.n / r.n.sum()
    out = {k: float((r[k] * w).sum()) for k in ["mae_model", "mae_naive", "mae_snap", "cover", "direction"]}
    out["n"] = int(r.n.sum())
    out["folds"] = len(r)
    out["skill_naive"] = 1 - out["mae_model"] / out["mae_naive"]
    out["skill_snap"] = 1 - out["mae_model"] / out["mae_snap"]
    # Calibrate the range: widen (or narrow) the distance from the median so that 80% of the held-out
    # outcomes fall inside it, then report coverage with that scale.
    y = np.concatenate([a for a, _ in held]); p = np.vstack([b for _, b in held])
    def cover(s):
        return np.mean((y >= p[:, 1] - s * (p[:, 1] - p[:, 0])) & (y <= p[:, 1] + s * (p[:, 2] - p[:, 1])))
    scales = np.arange(0.5, 3.01, 0.05)
    out["range_scale"] = float(scales[np.argmin([abs(cover(s) - 0.8) for s in scales])])
    out["cover_calibrated"] = float(cover(out["range_scale"]))
    out["passed"] = bool(out["skill_naive"] > 0.02 and out["skill_snap"] > 0.0)
    # Per group, with the overall range scale: is the model also better than the baselines on these items?
    out["groups"] = {}
    for grp, b in by_group.items():
        gy, gp, gs = np.concatenate(b["y"]), np.vstack(b["p"]), np.concatenate(b["snap"])
        if len(gy) < 30:
            out["groups"][grp] = dict(n=int(len(gy)), passed=False, note="too few test cases")
            continue
        sc = out["range_scale"]
        mm, mn, ms = np.mean(np.abs(gy - gp[:, 1])), np.mean(np.abs(gy)), np.mean(np.abs(gy - gs))
        lo, hi = gp[:, 1] - sc * (gp[:, 1] - gp[:, 0]), gp[:, 1] + sc * (gp[:, 2] - gp[:, 1])
        out["groups"][grp] = dict(n=int(len(gy)), mae_model=float(mm), mae_naive=float(mn), mae_snap=float(ms),
                                  skill_naive=float(1 - mm / mn), skill_snap=float(1 - mm / ms),
                                  direction=float(np.mean(np.sign(gp[:, 1]) == np.sign(gy))),
                                  cover_calibrated=float(np.mean((gy >= lo) & (gy <= hi))),
                                  passed=bool(1 - mm / mn > 0.02 and 1 - mm / ms > 0.0))
    return out


def alignment(df):
    """How EU Alliance's daily moves line up with each other market's: same day and the day before."""
    d = df[df.bin_idx % 4 == 0][["market", "item_id", "bin", "r1d"]].dropna()
    piv = d.pivot_table(index=["item_id", "bin"], columns="market", values="r1d")
    out = {}
    for m in piv.columns:
        if m == OWN or OWN not in piv:
            continue
        same = piv[[OWN, m]].dropna()
        lead = pd.concat([piv[OWN], piv[m].groupby(level=0).shift(1)], axis=1, keys=["own", "lag"]).dropna()
        out[m] = dict(corr_same_day=float(same[OWN].corr(same[m])) if len(same) > 30 else None,
                      corr_leads_by_1d=float(lead.own.corr(lead.lag)) if len(lead) > 30 else None, n=len(same))
    return out


def main():
    started = time.time()
    conn = sqlite3.connect(DB, timeout=30)
    items, raw = load(conn)
    df = features(to_bins(raw), items)
    now = int(time.time())
    evals, forecasts = {}, []
    latest_idx = df[df.market == OWN].dropna(subset=["lp"]).bin_idx.max()
    current = df[(df.market == OWN) & (df.bin_idx == latest_idx) & df.lp.notna()]
    for name, h in HORIZONS.items():
        ev = evaluate(df, name, h)
        evals[name] = ev
        ycol = f"y_{name}"
        train = df[(df.bin_idx >= WARMUP_BINS) & (df.age >= TRAIN_START_DAYS) & df.lp.notna() & df[ycol].notna()]
        if len(train) < 1000 or current.empty:
            continue
        p = predict(fit(train, ycol), current)
        s = (ev or {}).get("range_scale", 1.0)
        p[:, 0] = p[:, 1] - s * (p[:, 1] - p[:, 0])
        p[:, 2] = p[:, 1] + s * (p[:, 2] - p[:, 1])
        for (_, row), (q10, q50, q90) in zip(current.iterrows(), p):
            # Chance of going up, from a piecewise-linear CDF through the three quantiles.
            if q50 <= 0 <= q90:
                p_up = 0.5 - 0.4 * (0 - q50) / max(q90 - q50, 1e-9)
            elif q10 <= 0 < q50:
                p_up = 0.5 + 0.4 * (q50 - 0) / max(q50 - q10, 1e-9)
            else:
                p_up = 0.95 if q10 > 0 else 0.05
            forecasts.append((int(row.item_id), name, float(row.price), float(np.exp(q10) * row.price),
                              float(np.exp(q50) * row.price), float(np.exp(q90) * row.price), float(p_up), now))
    align = alignment(df)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS ml_forecast (item_id INTEGER NOT NULL, horizon TEXT NOT NULL, price_now REAL NOT NULL,
          q10 REAL NOT NULL, q50 REAL NOT NULL, q90 REAL NOT NULL, p_up REAL NOT NULL, computed_at INTEGER NOT NULL,
          PRIMARY KEY (item_id, horizon)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS ml_forecast_log (item_id INTEGER NOT NULL, horizon TEXT NOT NULL, made_at INTEGER NOT NULL,
          price_now REAL NOT NULL, q10 REAL NOT NULL, q50 REAL NOT NULL, q90 REAL NOT NULL, p_up REAL NOT NULL,
          PRIMARY KEY (item_id, horizon, made_at)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS ml_eval (computed_at INTEGER PRIMARY KEY, report TEXT NOT NULL);""")
    with conn:
        conn.execute("DELETE FROM ml_forecast")
        conn.executemany("INSERT INTO ml_forecast VALUES (?, ?, ?, ?, ?, ?, ?, ?)", forecasts)
        # Keep what was published so the dashboard can score it against what happened (30 days).
        conn.executemany("INSERT OR REPLACE INTO ml_forecast_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         [(i, h, t, p, a, b, c, u) for i, h, p, a, b, c, u, t in forecasts])
        conn.execute("DELETE FROM ml_forecast_log WHERE made_at < ?", (now - 30 * 86400,))
        conn.execute("INSERT INTO ml_eval VALUES (?, ?)", (now, json.dumps(dict(
            evals=evals, alignment=align, rows=len(df), markets=sorted(df.market.unique().tolist()),
            items=int(df.item_id.nunique()), forecasts=len(forecasts), train_start_days=TRAIN_START_DAYS,
            seconds=round(time.time() - started, 1)))))
    print(json.dumps(dict(evals=evals, alignment=align, forecasts=len(forecasts), seconds=round(time.time() - started, 1)), indent=1))


if __name__ == "__main__":
    main()
