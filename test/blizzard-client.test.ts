import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.ts";
import { fetchHouse } from "../src/ingest/blizzard.ts";

const config: Config = {
  blizzard: { clientId: "id", clientSecret: "secret", region: "eu", namespace: "dynamic-forever-eu", rulesetId: 1, houseId: 110, buyoutIsStackTotal: true },
  tsm: { game: "forever", region: "eu", realm: "pvp-alliance" },
  pollMinutes: { blizzard: 15, tsm: 180 },
  rawRetentionDays: 30,
  dataDir: "/nonexistent",
};

function fakeFetch(houseStatus: number) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("https://oauth.battle.net/token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    if (houseStatus === 304) return new Response(null, { status: 304 });
    return new Response('{"id":110,"auctions":[]}', { status: houseStatus, headers: { "last-modified": "Wed, 18 Nov 2026 18:00:00 GMT" } });
  }) as typeof fetch;
  return { impl, calls };
}

test("fetchHouse requests the Forever house with a bearer token", async () => {
  const { impl, calls } = fakeFetch(200);
  const res = await fetchHouse(config, null, impl);
  assert.equal(res.status, 200);
  assert.equal(res.lastModified, "Wed, 18 Nov 2026 18:00:00 GMT");
  const house = calls.find((c) => c.url.includes("/auctions/"));
  assert.equal(house?.url, "https://eu.api.blizzard.com/data/wow/ruleset/1/auctions/110?namespace=dynamic-forever-eu&locale=en_GB");
  assert.equal((house?.init?.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("fetchHouse sends If-Modified-Since and reports 304 as no body", async () => {
  const { impl, calls } = fakeFetch(304);
  const res = await fetchHouse(config, "Wed, 18 Nov 2026 18:00:00 GMT", impl);
  assert.equal(res.body, null);
  const house = calls.find((c) => c.url.includes("/auctions/"));
  assert.equal((house?.init?.headers as Record<string, string>)["If-Modified-Since"], "Wed, 18 Nov 2026 18:00:00 GMT");
});

test("fetchHouse surfaces HTTP errors with their status", async () => {
  const { impl } = fakeFetch(503);
  await assert.rejects(fetchHouse(config, null, impl), (err: { httpStatus?: number }) => err.httpStatus === 503);
});
