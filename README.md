# AH Tracker

Tracks WoW: Forever auction prices around the clock: price history, time-of-day patterns, flips
between houses, shopping lists and price forecasts. Defaults are EU PvP Alliance (house 110) and
PvP Neutral (house 116).

It has two parts:

- **The AHTracker addon** (`addon/AHTracker`). It saves every Auctionator scan with its time and
  shows the app's shopping lists and prices in game. It only reads scan results and never acts on
  the auction house by itself.
- **The app** (Node, this repo). It imports those scans, pulls public price data (TSM, and
  optionally Undermine Exchange and the Blizzard API), stores everything in a local SQLite
  database and serves a dashboard at http://localhost:8787/.

## What you need

- WoW: Forever with **Auctionator** installed (the addon depends on it). TSM is optional; with it
  installed, the app reads your TSM accounting data so it can track inventory and open purchases.
- Node 24 or newer and pnpm
- Python 3.12 or newer (optional, only for the forecasting model)

## Setup

```bash
git clone <this repo> ah-tracker && cd ah-tracker
pnpm install
pnpm run setup        # creates .env from .env.example and turns on the secret-guard git hook
```

Then open `.env` and fill in:

| Setting | Required | Where to get it |
| --- | --- | --- |
| `WOW_FOREVER_DIR` | **yes** | Your WoW `_forever_` folder, the one that contains `Interface/` and `WTF/` |
| `UNDERMINE_API_KEY` | no | https://undermine.exchange/api.html. Adds hourly prices for every Forever house and backfills history |
| `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET` | no | Create a client at https://develop.battle.net/access/clients |

TSM public price data needs no key. A source whose key is blank is switched off, and the app
works on Auctionator scans plus TSM alone. Everything else in `.env.example` has a working
default (house, region, polling intervals, AH cut, dashboard port).

To track a different realm or faction, change `TSM_REALM` and `AUCTION_HOUSE_ID` in `.env`, and
the `HOUSES` list in `src/config.ts`. `node src/cli.ts houses` lists the Forever house ids (this
needs the Blizzard keys).

### Forecasting model (optional)

```bash
python3 -m venv .venv
.venv/bin/pip install -r ml/requirements.txt
```

The service retrains every 6 hours if `.venv` exists. To run it by hand: `node src/cli.ts model`.

## Installing the addon

Pick one:

- **From the app:** `pnpm install-addon` copies `addon/AHTracker` into
  `$WOW_FOREVER_DIR/Interface/AddOns/AHTracker` and writes fresh shopping lists. It keeps an
  existing `Lists.lua`.
- **By hand:** `pnpm package-addon` builds `dist/AHTracker-<version>.zip`. Unzip it into
  `_forever_/Interface/AddOns/`, so you end up with `Interface/AddOns/AHTracker/AHTracker.toc`.

Restart WoW or `/reload`, and make sure **AH Tracker** and **Auctionator** are both enabled on
the character select AddOns screen.

## Using it

### In game

1. Open the auction house and run an Auctionator **full scan**. Browse scans also count, with
   less detail.
2. Type `/reload` (or log out). WoW writes the scans to
   `WTF/Account/<account>/SavedVariables/AHTracker.lua`, and the app imports them within a minute.
3. After each statistics refresh, the app rewrites the addon's `Lists.lua`. On your next
   `/reload`, the addon turns it into Auctionator shopping lists with max buy prices.

| Slash command | Does |
| --- | --- |
| `/ahtracker` | How many scans are waiting for the app, and the latest one |
| `/ahtracker lists` | Rebuild the Auctionator shopping lists now |
| `/ahtracker autoprice on\|off` | Turn the app's suggested prices on the Selling tab on or off |
| `/ahtracker mailto <name>` | The character to mail AH purchases to (adds a button at the mailbox) |

### The app

Run it in the background (Linux, systemd user services):

```bash
mkdir -p ~/.config/systemd/user
ln -s "$PWD/deploy/ah-tracker.service" "$PWD/deploy/ah-dashboard.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ah-tracker ah-dashboard
```

Both unit files assume the repo is at `~/Projects/ah-tracker` and node is at
`~/.local/share/pnpm/bin/node`. Edit `WorkingDirectory` and `ExecStart` if yours differ. Logs:
`journalctl --user -u ah-tracker -f`. To keep the service running after logout, run
`loginctl enable-linger $USER`.

Without systemd, run `pnpm start` (collector) and `pnpm dashboard` in two terminals.
`deploy/ah-tracker-open.sh` is a desktop-shortcut script: it starts both services, imports new
data and opens the dashboard.

The dashboard is at **http://localhost:8787/** and listens on loopback only. It has these pages:
Overview, item charts (candles, volume, heat map by hour), Flips, What to trade, Enchanting
shuffles, Crafting, Materials, Watchlist, Forecasts, Anomalies, Your inventory, Profit calculator
and Data health. The **Sync** button pulls everything now.

### Commands

| Command | Does |
| --- | --- |
| `node src/cli.ts status` | Last fetch per source, snapshot count, gaps over 2 h |
| `node src/cli.ts poll-once` | One fetch of every source, then exit |
| `node src/cli.ts sync` | Pull everything now and recompute (the dashboard's Sync button) |
| `node src/cli.ts import-scans` | Import new Auctionator scans now |
| `node src/cli.ts stats` | Recompute statistics, opportunities and anomalies |
| `node src/cli.ts opportunities [alliance\|neutral] [buy-now\|time-flip\|sell-now\|cross-house] [n]` | Best current opportunities |
| `node src/cli.ts lists` | Rewrite the addon's `Lists.lua` and print each list's top items |
| `node src/cli.ts auctionator-import` | Text to paste into Auctionator's Shopping > Import |
| `node src/cli.ts export-tsm [house] [kind\|all] [n]` | TSM group import string for the top opportunities |
| `node src/cli.ts tsm-groups` | Write the AH Tracker groups and operation into TSM (close WoW first) |
| `node src/cli.ts backfill` | Undermine Exchange history backfill, until done or rate-limited |
| `node src/cli.ts model` | Train and test the forecasting model |
| `node src/cli.ts houses` / `verify-buyout` | Blizzard API checks (need the Blizzard keys) |
| `pnpm test` / `pnpm typecheck` | Unit tests and type check |

Prices are in copper. `price_20` is the average unit cost of buying the cheapest 20 units, and it
is the price every signal uses.

## Your data stays local

Your data lives in `data/ah-tracker.sqlite` and is never committed. That includes scans, prices
and your TSM accounting (buys, sales, gold, inventory). `.gitignore` excludes `.env`, `data/`,
`reports/`, `*.sqlite`, WoW `WTF/` and `SavedVariables/` folders, and TSM ledger or accounting
exports. The `.githooks/pre-commit` hook (turned on by `pnpm run setup`) refuses any commit
that contains:

- a `.env` file, or a line that assigns a value to a `*KEY`, `*SECRET`, `*TOKEN`, `*PASSWORD` or
  `CLIENT_ID` setting
- a database, a SavedVariables file, a `TradeSkillMaster*.lua`, or ledger/accounting exports

The ledger rows in the test files are made up and use placeholder character names.
