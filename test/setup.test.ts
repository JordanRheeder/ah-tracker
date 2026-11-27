import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWowDir, listDirs, readEnvFile, saveEnv } from "../src/setup.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "aht-setup-"));

test("saveEnv keeps other lines and comments, and Windows paths read back unchanged", () => {
  const file = join(tmp(), ".env");
  writeFileSync(file, "# comment\r\nWOW_FOREVER_DIR=\r\nTSM_REALM=pvp-alliance\r\n");
  const win = String.raw`C:\Program Files (x86)\World of Warcraft\_forever_`;
  saveEnv({ WOW_FOREVER_DIR: win, UNDERMINE_API_KEY: "abc#123'x" }, file);
  const env = readEnvFile(file);
  assert.equal(env.WOW_FOREVER_DIR, win);
  assert.equal(env.UNDERMINE_API_KEY, "abc#123'x");
  assert.equal(env.TSM_REALM, "pvp-alliance");
  const text = readFileSync(file, "utf8");
  assert.ok(text.startsWith("# comment\r\n"), "keeps CRLF line endings and comments");
  saveEnv({ UNDERMINE_API_KEY: "" }, file);
  assert.equal(readEnvFile(file).UNDERMINE_API_KEY, "");
});

test("saveEnv refuses fields the Setup page does not own, and multi-line values", () => {
  const file = join(tmp(), ".env");
  assert.throws(() => saveEnv({ DATA_DIR: "/x" } as never, file));
  assert.throws(() => saveEnv({ UNDERMINE_API_KEY: "a\nB=1" }, file));
});

test("checkWowDir tells the World of Warcraft folder apart from _forever_", () => {
  const wow = tmp();
  mkdirSync(join(wow, "_forever_", "Interface", "AddOns", "Auctionator"), { recursive: true });
  mkdirSync(join(wow, "_forever_", "WTF", "Account", "MYACCOUNT"), { recursive: true });
  const outer = checkWowDir(wow);
  assert.equal(outer.looksRight, false);
  assert.match(outer.hint ?? "", /_forever_ folder inside/);
  const inner = checkWowDir(join(wow, "_forever_"));
  assert.equal(inner.looksRight, true);
  assert.deepEqual(inner.accounts, ["MYACCOUNT"]);
  assert.equal(inner.auctionatorInstalled, true);
  assert.equal(inner.addonInstalled, false);
});

test("listDirs lists folders only, skips hidden ones, and reports missing folders", () => {
  const d = tmp();
  mkdirSync(join(d, "b")); mkdirSync(join(d, "A")); mkdirSync(join(d, ".hidden"));
  writeFileSync(join(d, "file.txt"), "");
  const r = listDirs(d);
  assert.deepEqual(r.dirs, ["A", "b"]);
  assert.ok(r.parent);
  assert.equal(listDirs(join(d, "missing")).error, "Folder not found");
});
