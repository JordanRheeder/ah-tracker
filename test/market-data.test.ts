import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/db.ts";
import { exportMarketData, importMarketData } from "../src/marketData.ts";

function sourceDb(path: string) {
  const db = openDb(path);
  db.prepare("INSERT INTO item (item_id, name, updated_at) VALUES (4338, 'Mageweave Cloth', 1)").run();
  db.prepare(`INSERT INTO snapshot (id, house_id, fetched_at, content_hash, auction_count, item_count, raw_path, source)
    VALUES (7, 110, 1000, 'abc', 3, 1, '/home/someone/ah-tracker/data/raw/x.gz', 'auctionator-browse')`).run();
  db.prepare("INSERT INTO item_snapshot (snapshot_id, item_id, ts, min_buyout, price_20, quantity) VALUES (7, 4338, 1000, 90, 100, 40)").run();
  db.prepare("INSERT INTO tsm_realm (item_id, updated_at, market_value) VALUES (4338, 1000, 120)").run();
  // Private: must never be exported.
  db.prepare("INSERT INTO purchase (ts, item_id, qty, unit, house) VALUES (1000, 4338, 20, 95, 'alliance')").run();
  db.prepare(`INSERT INTO tsm_ledger (kind, item_id, item_string, qty, price, other, player, ts, source)
    VALUES ('buy', 4338, 'i:4338', 20, 100, 'Multiple Sellers', 'Testchar', 1000, 'Auction')`).run();
  db.close();
}

test("export keeps scans and public prices, drops purchases, the ledger and local paths; import merges once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aht-market-"));
  const src = join(dir, "src.sqlite"), out = join(dir, "market.sqlite.gz");
  sourceDb(src);
  const counts = await exportMarketData(src, out);
  assert.equal(counts.item_snapshot, 1);

  const plain = join(dir, "check.sqlite");
  writeFileSync(plain, gunzipSync(readFileSync(out)));
  const exp = new DatabaseSync(plain, { readOnly: true });
  const n = (t: string) => (exp.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
  assert.equal(n("purchase"), 0);
  assert.equal(n("tsm_ledger"), 0);
  assert.equal(n("tsm_realm"), 1);
  assert.equal((exp.prepare("SELECT raw_path FROM snapshot").get() as { raw_path: string | null }).raw_path, null);
  assert.ok(!readFileSync(plain).includes("Testchar"), "no character names anywhere in the file");
  exp.close();

  const target = openDb(join(dir, "target.sqlite"));
  target.prepare(`INSERT INTO snapshot (id, house_id, fetched_at, content_hash, auction_count, item_count, source)
    VALUES (7, 116, 500, 'mine', 1, 1, 'undermine')`).run(); // id 7 already taken: the import must renumber
  const first = await importMarketData(target, out);
  assert.equal(first.snapshot, 1);
  assert.equal(first.item_snapshot, 1);
  const row = target.prepare("SELECT s.house_id, i.price_20 FROM item_snapshot i JOIN snapshot s ON s.id = i.snapshot_id WHERE i.item_id = 4338").get() as { house_id: number; price_20: number };
  assert.deepEqual({ ...row }, { house_id: 110, price_20: 100 });
  const again = await importMarketData(target, out);
  assert.equal(again.snapshot, 0);
  assert.equal(again.item_snapshot, 0);
});
