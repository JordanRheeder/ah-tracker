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

-- One row per distinct Blizzard auction snapshot that was stored
CREATE TABLE IF NOT EXISTS snapshot (
  id            INTEGER PRIMARY KEY,
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

-- ST-1: per snapshot and item aggregates, kept indefinitely
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
  listings    INTEGER NOT NULL,
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
  item_id    INTEGER PRIMARY KEY,
  name       TEXT,
  name_source TEXT,                          -- tsm | blizzard
  updated_at INTEGER NOT NULL
);

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
