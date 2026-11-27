-- AH Tracker schema. Prices are in copper; timestamps are Unix seconds (UTC).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- IN-6: every fetch attempt, so gaps in the data are visible
CREATE TABLE IF NOT EXISTS fetch_log (
  id          INTEGER PRIMARY KEY,
  source      TEXT    NOT NULL,              -- blizzard | tsm-realm | tsm-region
  started_at  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status      TEXT    NOT NULL,              -- stored | unchanged | error
  http_status INTEGER,
  bytes       INTEGER,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS fetch_log_source_time ON fetch_log (source, started_at);

-- One row per distinct auction house snapshot (an Auctionator full scan, or a Blizzard API snapshot)
CREATE TABLE IF NOT EXISTS snapshot (
  id            INTEGER PRIMARY KEY,
  source        TEXT    NOT NULL DEFAULT 'blizzard', -- auctionator-full | auctionator-browse | undermine | blizzard
  house_id      INTEGER NOT NULL,
  fetched_at    INTEGER NOT NULL,
  last_modified INTEGER,                     -- from the Last-Modified header, when sent
  content_hash  TEXT    NOT NULL,
  auction_count INTEGER NOT NULL,
  item_count    INTEGER NOT NULL,
  raw_path      TEXT,                        -- IN-3: compressed raw JSON, pruned after retention
  UNIQUE (house_id, content_hash)
);
CREATE INDEX IF NOT EXISTS snapshot_time ON snapshot (house_id, fetched_at);

-- ST-1: per snapshot and item aggregates, kept indefinitely. Browse-scan (summary) snapshots only
-- know the cheapest unit price and total quantity, so price_20, p10-p50 and listings are NULL there.
CREATE TABLE IF NOT EXISTS item_snapshot (
  snapshot_id INTEGER NOT NULL REFERENCES snapshot (id),
  item_id     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,              -- copy of snapshot.fetched_at for range scans
  min_buyout  INTEGER,                       -- lowest unit buyout
  price_20    INTEGER,                       -- avg unit cost of the cheapest 20 units (or all stock)
  p10         INTEGER,                       -- quantity-weighted unit price percentiles
  p25         INTEGER,
  p50         INTEGER,
  quantity    INTEGER NOT NULL,
  listings    INTEGER,
  PRIMARY KEY (snapshot_id, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS item_snapshot_item_time ON item_snapshot (item_id, ts);

-- ST-2: individual auctions between snapshots, to estimate units that likely sold
CREATE TABLE IF NOT EXISTS auction_seen (
  auction_id     INTEGER PRIMARY KEY,
  item_id        INTEGER NOT NULL,
  unit_price     INTEGER,
  quantity       INTEGER NOT NULL,
  first_seen     INTEGER NOT NULL,           -- snapshot id
  last_seen      INTEGER NOT NULL,           -- snapshot id
  last_time_left TEXT,                       -- SHORT | MEDIUM | LONG | VERY_LONG
  gone_at        INTEGER,                    -- snapshot id where it was first missing
  gone_reason    TEXT                        -- likely_sold | expired
);
CREATE INDEX IF NOT EXISTS auction_seen_open ON auction_seen (gone_at, item_id);
CREATE INDEX IF NOT EXISTS auction_seen_item_gone ON auction_seen (item_id, gone_at);

CREATE TABLE IF NOT EXISTS item (
  item_id      INTEGER PRIMARY KEY,
  name         TEXT,
  name_source  TEXT,                         -- tsm | wowhead | blizzard
  updated_at   INTEGER NOT NULL,
  -- From the game client via the AHTracker addon:
  class_id     INTEGER,                      -- e.g. 7 = Trade Goods
  subclass_id  INTEGER,                      -- e.g. 9 = Herb
  quality      INTEGER,                      -- 0 poor .. 5 legendary
  icon_file_id INTEGER,
  equip_loc    TEXT,
  vendor_price INTEGER,                      -- what a vendor pays for one (copper)
  deposit_unit INTEGER,                      -- auction deposit for one unit at your Auctionator duration
  -- From Wowhead's tooltip service (cached):
  icon_name    TEXT,
  wowhead_checked_at INTEGER
);

-- Item class / subclass names as the game client reports them (subclass_id -1 = the class itself)
CREATE TABLE IF NOT EXISTS item_class (
  class_id    INTEGER NOT NULL,
  subclass_id INTEGER NOT NULL,
  name        TEXT NOT NULL,
  PRIMARY KEY (class_id, subclass_id)
) WITHOUT ROWID;

-- IN-2: TSM realm file versions (house prices)
CREATE TABLE IF NOT EXISTS tsm_realm (
  item_id      INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,             -- the file's updatedAt (upstream scan time)
  market_value INTEGER,
  min_buyout   INTEGER,
  recent       INTEGER,
  historical   INTEGER,
  PRIMARY KEY (item_id, updated_at)
) WITHOUT ROWID;

-- IN-2: TSM region file versions (EU-wide sales)
CREATE TABLE IF NOT EXISTS tsm_region (
  item_id        INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  market_value   INTEGER,
  historical     INTEGER,
  avg_sale_price INTEGER,
  sale_rate      REAL,
  sold_per_day   REAL,
  PRIMARY KEY (item_id, updated_at)
) WITHOUT ROWID;

-- IN-4: TSM groups read from the addon's SavedVariables
CREATE TABLE IF NOT EXISTS tsm_group_item (
  group_path TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  read_at    INTEGER NOT NULL,
  PRIMARY KEY (group_path, item_id)
) WITHOUT ROWID;

-- Undermine Exchange hourly-history backfill progress, per house and item
CREATE TABLE IF NOT EXISTS ue_backfill (
  house_id INTEGER NOT NULL,
  item_id  INTEGER NOT NULL,
  points   INTEGER NOT NULL,                 -- hourly points returned
  done_at  INTEGER NOT NULL,
  PRIMARY KEY (house_id, item_id)
) WITHOUT ROWID;

-- Statistics engine output (src/stats), recomputed after each Undermine poll
CREATE TABLE IF NOT EXISTS stats_item (
  house_id     INTEGER NOT NULL,
  item_id      INTEGER NOT NULL,
  computed_at  INTEGER NOT NULL,
  days         INTEGER NOT NULL,
  points       INTEGER NOT NULL,
  current      INTEGER NOT NULL,
  median       REAL    NOT NULL,             -- usual price over the lookback window
  median3d     REAL    NOT NULL,
  buy_price    REAL    NOT NULL,             -- median of the 3 cheapest hours
  sell_price   REAL    NOT NULL,             -- median of the 3 dearest hours
  buy_hours    TEXT    NOT NULL,             -- UTC hours, e.g. "5,6,4"
  sell_hours   TEXT    NOT NULL,
  hour_medians TEXT    NOT NULL,             -- JSON array of 24 medians (UTC)
  consistency  REAL    NOT NULL,
  pattern_days INTEGER NOT NULL,
  z            REAL,
  PRIMARY KEY (house_id, item_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stats_opportunity (
  house_id      INTEGER NOT NULL,            -- where you buy
  item_id       INTEGER NOT NULL,
  kind          TEXT    NOT NULL,            -- buy-now | time-flip | sell-now | cross-house
  sell_house_id INTEGER NOT NULL,            -- where you sell (differs only for cross-house)
  buy_price     REAL    NOT NULL,
  sell_price    REAL    NOT NULL,
  profit        REAL    NOT NULL,            -- per unit, after the sell house's cut
  margin        REAL    NOT NULL,
  confidence    REAL    NOT NULL,
  score         REAL    NOT NULL,            -- profit x sqrt(EU sold/day) x confidence, for ranking only
  why           TEXT    NOT NULL,
  safe_buy      REAL,                        -- pessimistic buy price (high typical)
  safe_sell     REAL,                        -- pessimistic sell price (low typical)
  safe_profit   REAL,                        -- per unit after the cut, in the pessimistic case
  safe_margin   REAL,
  safe_evidence INTEGER,                     -- 1 = meets the safer-trade evidence bar
  sell_now      REAL,                        -- between houses: the sell house's price in your latest Auctionator scan
  sell_now_ts   INTEGER,                     -- when that scan was
  profit_now    REAL,                        -- per unit if sold at sell_now, after the cut and lost deposits
  margin_now    REAL,
  sell_item_id  INTEGER,                     -- conversions: the item you sell (item_id is the one you buy)
  convert_in    INTEGER,                     -- conversions: units bought per conversion (3 Lesser, or 1 Greater)
  convert_out   INTEGER,                     -- conversions: units sold per conversion
  computed_at   INTEGER NOT NULL,
  PRIMARY KEY (house_id, item_id, kind, sell_house_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stats_anomaly (
  house_id   INTEGER NOT NULL,
  item_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,               -- price-spike | price-crash | buyout | new-normal
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  closed_at  INTEGER,                        -- NULL while still open
  severity   REAL    NOT NULL,
  detail     TEXT    NOT NULL,
  PRIMARY KEY (house_id, item_id, kind, first_seen)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS stats_anomaly_open ON stats_anomaly (closed_at, house_id);

-- User settings changed from the dashboard (e.g. min_margin)
CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Your auction-house purchases, recorded by the AHTracker addon
CREATE TABLE IF NOT EXISTS purchase (
  ts       INTEGER NOT NULL,
  item_id  INTEGER NOT NULL,
  qty      INTEGER NOT NULL,
  unit     INTEGER NOT NULL,                 -- copper paid per unit
  house    TEXT,
  PRIMARY KEY (ts, item_id, qty, unit)
) WITHOUT ROWID;

-- Items you ticked on the Inventory page: greyed out (or hidden) and left out of the totals
CREATE TABLE IF NOT EXISTS inventory_ignore (
  item_id    INTEGER PRIMARY KEY,
  ignored_at INTEGER NOT NULL
);

-- TSM's accounting ledger (TradeSkillMaster.lua): auction and vendor buys and sales, expired and
-- cancelled listings. TSM files both PvP auction houses under one realm, so the house is unknown.
CREATE TABLE IF NOT EXISTS tsm_ledger (
  kind        TEXT    NOT NULL,                -- buy | sale | expired | cancelled
  item_id     INTEGER NOT NULL,
  item_string TEXT    NOT NULL,                -- TSM item string, e.g. "i:15260::1:12718" (random suffix)
  qty         INTEGER NOT NULL,
  price       INTEGER NOT NULL,                -- copper per unit (buys and sales; 0 otherwise)
  other       TEXT    NOT NULL,                -- the other player, "Multiple Sellers" or "Merchant" ('' if none)
  player      TEXT    NOT NULL,                -- your character
  ts          INTEGER NOT NULL,
  source      TEXT,                            -- Auction | Vendor | Trade ... (buys and sales)
  PRIMARY KEY (kind, item_string, player, ts, qty, price, other)
);
CREATE INDEX IF NOT EXISTS tsm_ledger_item ON tsm_ledger (item_id, ts);

-- TSM's money ledger: income and expenses that are not item trades (postage, money transfers,
-- repairs, ...). Transfers between your own characters show up on both sides.
CREATE TABLE IF NOT EXISTS tsm_money (
  kind   TEXT    NOT NULL,                     -- income | expense
  type   TEXT    NOT NULL,                     -- Postage | Money Transfer | Repair Bill | ...
  amount INTEGER NOT NULL,                     -- copper
  other  TEXT    NOT NULL,                     -- the other player ('' if none)
  player TEXT    NOT NULL,                     -- your character
  ts     INTEGER NOT NULL,
  PRIMARY KEY (kind, type, amount, other, player, ts)
) WITHOUT ROWID;

-- Gold on hand per character, from TSM: the latest exact amount and its gold log (rounded to the gold)
CREATE TABLE IF NOT EXISTS tsm_character (
  character  TEXT    PRIMARY KEY,              -- character name
  faction    TEXT,
  money      INTEGER NOT NULL,                 -- copper
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tsm_gold_log (
  character TEXT    NOT NULL,
  ts        INTEGER NOT NULL,                  -- TSM logs by the minute
  copper    INTEGER NOT NULL,
  PRIMARY KEY (character, ts)
) WITHOUT ROWID;

-- Sellable (not soulbound) items per character, from the AHTracker addon's bag and bank scans
CREATE TABLE IF NOT EXISTS inventory (
  character  TEXT    NOT NULL,                -- "Name-Realm"
  location   TEXT    NOT NULL,                -- bags | bank
  item_id    INTEGER NOT NULL,
  qty        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,                -- when the addon scanned it
  PRIMARY KEY (character, location, item_id)
) WITHOUT ROWID;

-- Trends and next-days estimates per item and house (src/stats/forecast.ts), rebuilt on every refresh
CREATE TABLE IF NOT EXISTS stats_forecast (
  house_id     INTEGER NOT NULL,
  item_id      INTEGER NOT NULL,
  computed_at  INTEGER NOT NULL,
  days         INTEGER NOT NULL,             -- days of history
  level        REAL    NOT NULL,             -- latest daily price
  next         REAL    NOT NULL,             -- snap-back estimate for the next 1-3 days
  trend        REAL    NOT NULL,             -- fraction per day over the last 6 days
  consistency  REAL    NOT NULL,             -- Kendall's tau, -1..1
  supply_trend REAL,                         -- quantity listed, fraction per day
  peak         REAL    NOT NULL,
  low          REAL    NOT NULL,
  skill        REAL,                         -- snap-back back-test skill vs "no change" on this item
  backtests    INTEGER NOT NULL,
  PRIMARY KEY (house_id, item_id)
) WITHOUT ROWID;

-- Back-test accuracy of each forecasting method per house, pooled over liquid items
CREATE TABLE IF NOT EXISTS stats_forecast_method (
  house_id    INTEGER NOT NULL,
  method      TEXT    NOT NULL,              -- snap-back | trend
  skill       REAL,                          -- 1 - error / "no change" error (above 0 = better than no change)
  wins        REAL,                          -- share of items where it beat "no change"
  items       INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (house_id, method)
) WITHOUT ROWID;

-- Sell-now alerts on items you bought (src/alerts.ts): one row per item, notified when it becomes ready
CREATE TABLE IF NOT EXISTS sell_alert (
  item_id     INTEGER PRIMARY KEY,
  ready       INTEGER NOT NULL,              -- 1 = selling now makes at least your minimum margin
  house       TEXT,                          -- where to sell (house key)
  list_price  REAL,                          -- the going price there, per unit
  net         REAL,                          -- per unit after the AH cut and expected lost deposits
  paid        REAL,                          -- average paid per unit for the units you hold
  qty         INTEGER,                       -- bought units you hold
  margin      REAL,
  since       INTEGER,                       -- when it became ready
  notified_at INTEGER,
  updated_at  INTEGER NOT NULL
);

-- Your own sell targets (src/alerts.ts): notify when an item's cheapest listing on either house reaches
-- the target. Items with a target skip the usual minimum-margin sell alert.
CREATE TABLE IF NOT EXISTS price_target (
  item_id     INTEGER PRIMARY KEY,
  target      REAL    NOT NULL,              -- copper per unit
  created_at  INTEGER NOT NULL,
  triggered   INTEGER NOT NULL DEFAULT 0,    -- 1 while the price is at or above the target (one notification)
  notified_at INTEGER,
  last_price  REAL,                          -- best cheapest listing at the last check
  last_house  TEXT
);

-- What every character owns per TSM (bags, bank, mail, auctions), as of TSM's last save (logout or
-- /reload). Caps "still held" so purchases used, crafted or given away do not count as stock.
CREATE TABLE IF NOT EXISTS tsm_holding (
  character TEXT    NOT NULL,
  location  TEXT    NOT NULL,                -- bag | bank | mail | auction
  item_id   INTEGER NOT NULL,
  qty       INTEGER NOT NULL,
  PRIMARY KEY (character, location, item_id)
) WITHOUT ROWID;

-- Alerts shown on the dashboard's Notifications page (src/alerts.ts): sell-now alerts and price targets
CREATE TABLE IF NOT EXISTS notification (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,                  -- sell-now | target
  title   TEXT    NOT NULL,
  body    TEXT    NOT NULL,
  item_id INTEGER,
  read    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS notification_time ON notification (ts);

-- Other Forever PvP markets used as supporting evidence for forecasting (src/ingest/markets.ts): hourly
-- cheapest price and quantity of trade goods from Undermine Exchange. Your own houses stay in item_snapshot.
CREATE TABLE IF NOT EXISTS ref_price (
  market  TEXT    NOT NULL,                  -- eu-horde | us-alliance | us-horde
  item_id INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  price   INTEGER,                           -- copper per unit (cheapest listing)
  qty     INTEGER NOT NULL,
  PRIMARY KEY (market, item_id, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ref_backfill (
  market     TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  points     INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (market, item_id)
) WITHOUT ROWID;

-- Forecasts from the pooled model (ml/forecast.py, run by the service every 6 hours) for EU PvP Alliance
-- trade goods: price now and the 10/50/90% quantiles at each horizon, chance of going up.
CREATE TABLE IF NOT EXISTS ml_forecast (
  item_id     INTEGER NOT NULL,
  horizon     TEXT    NOT NULL,              -- 1d | 3d | 7d
  price_now   REAL    NOT NULL,
  q10         REAL    NOT NULL,
  q50         REAL    NOT NULL,
  q90         REAL    NOT NULL,
  p_up        REAL    NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, horizon)
) WITHOUT ROWID;
-- Every run's published forecasts (same columns as ml_forecast, keyed by run), kept 30 days so they can be
-- scored against what actually happened (modelScoreboard in src/api/queries.ts).
CREATE TABLE IF NOT EXISTS ml_forecast_log (
  item_id     INTEGER NOT NULL,
  horizon     TEXT    NOT NULL,              -- 1d | 3d | 7d
  made_at     INTEGER NOT NULL,              -- the run's time (ml_forecast.computed_at)
  price_now   REAL    NOT NULL,
  q10         REAL    NOT NULL,
  q50         REAL    NOT NULL,
  q90         REAL    NOT NULL,
  p_up        REAL    NOT NULL,
  PRIMARY KEY (item_id, horizon, made_at)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ml_forecast_log_made ON ml_forecast_log (made_at);
-- Each run's walk-forward test results (JSON): accuracy against baselines, range calibration, market alignment
CREATE TABLE IF NOT EXISTS ml_eval (computed_at INTEGER PRIMARY KEY, report TEXT NOT NULL);

-- Watchlist: items whose trends are rechecked every few hours (src/watch.ts). buy_below (copper per unit,
-- optional) is the price you would buy at on PvP Alliance: it puts the item on the [WATCH] Auctionator
-- list with that limit and notifies you when the cheapest listing drops to it. signals holds the last
-- check's labels (trend, forecast, other realms, supply) so a notification only goes out when one changes.
CREATE TABLE IF NOT EXISTS watch_item (
  item_id       INTEGER PRIMARY KEY,
  buy_below     REAL,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  signals       TEXT,                        -- JSON, see WatchSignals
  checked_at    INTEGER,
  notified_price REAL,                       -- price at the last notification, for the big-move check
  buy_triggered INTEGER NOT NULL DEFAULT 0   -- 1 while the price is at or below buy_below (one notification)
);

-- Your own listing price per item (copper per unit) for the AHTracker addon's Selling-tab pricing on PvP
-- Alliance: replaces the app's usual/dear-hour target for that item in Lists.lua sellTargets. The addon
-- still never lists below your break-even-plus-margin price, and undercuts the cheapest listing if it is
-- higher. Separate from price_target, which is an alert level.
CREATE TABLE IF NOT EXISTS list_price (
  item_id    INTEGER PRIMARY KEY,
  price      INTEGER NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);

-- Crafting alerts (src/stats/crafting.ts): whether each recipe paid at the last check, so a notification
-- goes out only when one starts paying.
CREATE TABLE IF NOT EXISTS craft_alert (
  spell       INTEGER PRIMARY KEY,
  pays        INTEGER NOT NULL,
  profit      REAL,
  margin      REAL,
  updated_at  INTEGER NOT NULL,
  notified_at INTEGER
);
