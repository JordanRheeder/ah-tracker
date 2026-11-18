# AH Tracker

Records WoW: Forever auction prices for EU PvP Alliance (auction house 110) around the clock,
so price history, time-of-day patterns and buy/sell windows can be analysed later.
See the PRD: https://claude.ai/artifact/JEi3rudjjmQRPyVTwSVybX

## Phase 1: data collection (this release)

| Source | What is stored | Cadence |
| --- | --- | --- |
| Blizzard API, `dynamic-forever-eu`, house 110 | Every snapshot: per-item prices (`item_snapshot`), auction tracking (`auction_seen`), raw JSON for 30 days | Polled every 15 min, stored when changed |
| TSM realm file (`pvp-alliance`) | marketValue, minBuyout, recent, historical, item names | Every 3 h, stored per `updatedAt` |
| TSM region file (EU) | saleRate, soldPerDay, avgSalePrice | Every 3 h, stored per `updatedAt` |

Prices are copper. `price_20` is the average unit cost of buying the cheapest 20 units, and is
the price every later signal uses. Data lives in `data/ah-tracker.sqlite`.

## Setup

1. Create a client at https://develop.battle.net/access/clients and put its ID and secret in `.env`.
2. Restart the service: `systemctl --user restart ah-tracker`
3. Confirm house 110 is PvP Alliance: `node src/cli.ts houses`
4. After the first snapshot, check how buyouts are priced: `node src/cli.ts verify-buyout`

## Commands

Node lives at `~/.local/share/pnpm/bin`.

| Command | Does |
| --- | --- |
| `node src/cli.ts status` | Last fetch per source, snapshot count, gaps over 2 h (UI-7 in text form) |
| `node src/cli.ts poll-once` | One fetch of every source, then exit |
| `node src/cli.ts houses` | Lists Forever auction houses and marks the configured one |
| `node src/cli.ts verify-buyout` | Compares per-stack vs per-unit buyout readings with TSM |
| `node src/cli.ts run` | The service loop (what systemd runs) |
| `pnpm test` / `pnpm typecheck` | Unit tests / type check |

## Service

`deploy/ah-tracker.service` is linked into `~/.config/systemd/user/`. Logs:
`journalctl --user -u ah-tracker -f`. It runs while you are logged in; to keep it running after
logout, enable lingering with `loginctl enable-linger $USER` (a system setting, left to you).
