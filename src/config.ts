import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface House {
  /** Short key used in the dashboard and addon: alliance | neutral | horde. */
  key: string;
  /** Blizzard auction house id for Forever EU (110 = PvP Alliance, 116 = PvP Blackwater/neutral). */
  houseId: number;
  /** Undermine Exchange realm slug in region "euf". */
  ueRealm: string;
  label: string;
  /** AH cut taken from sales on this house (Classic-style rules: 5% faction, 15% neutral; unverified for Forever). */
  cut: number;
}

/** Auction houses AH Tracker follows. TSM publishes per-house prices for PvP Alliance only. */
export const HOUSES: House[] = [
  { key: "alliance", houseId: 110, ueRealm: "pvp-alliance", label: "PvP Alliance", cut: Number(process.env.CUT_ALLIANCE ?? 0.05) },
  { key: "neutral", houseId: 116, ueRealm: "pvp-neutral", label: "PvP Neutral", cut: Number(process.env.CUT_NEUTRAL ?? 0.15) },
];

/**
 * Items nobody on a house will buy, by house key. Opportunities, sell targets and inventory valuation
 * never plan a sale there (buying there to sell elsewhere is still fine).
 * Shredder Operating Manual pages 1-12 are for a Horde-only quest, so the Alliance AH has no buyers.
 */
export const NO_BUYERS: Record<string, ReadonlySet<number>> = {
  alliance: new Set([16645, 16646, 16647, 16648, 16649, 16650, 16651, 16652, 16653, 16654, 16655, 16656]),
};

/** Whether anyone on this house buys the item. */
export function sellsOn(house: { key: string }, itemId: number): boolean {
  return !NO_BUYERS[house.key]?.has(itemId);
}

export function houseByKey(key: string | null | undefined): House | undefined {
  return HOUSES.find((h) => h.key === key?.toLowerCase());
}

export interface Config {
  blizzard: {
    clientId: string;
    clientSecret: string;
    region: string;
    namespace: string;
    rulesetId: number;
    houseId: number;
    /** Whether `buyout` covers the whole stack (Classic-style) or one unit. Verify with `verify-buyout`. */
    buyoutIsStackTotal: boolean;
  };
  tsm: { game: string; region: string; realm: string };
  auctionator: {
    /** The WoW `_forever_` folder; AHTracker.lua files are read from its WTF/Account/<account>/SavedVariables. */
    wowForeverDir: string;
  };
  undermine: {
    apiKey: string;
    region: string;
    /** Backfill hourly history for items selling at least this many per day across EU (TSM). */
    backfillMinSoldPerDay: number;
    /** Points kept in reserve so the hourly summaries always fit in the rate limit. */
    reservePoints: number;
  };
  pollMinutes: { blizzard: number; tsm: number; auctionator: number; undermine: number };
  rawRetentionDays: number;
  dataDir: string;
}

const root = resolve(import.meta.dirname, "..");

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

export function loadConfig(): Config {
  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  return {
    blizzard: {
      clientId: str("BLIZZARD_CLIENT_ID", ""),
      clientSecret: str("BLIZZARD_CLIENT_SECRET", ""),
      region: str("BLIZZARD_REGION", "eu"),
      namespace: str("BLIZZARD_NAMESPACE", "dynamic-forever-eu"),
      rulesetId: num("BLIZZARD_RULESET_ID", 1),
      houseId: num("AUCTION_HOUSE_ID", 110),
      buyoutIsStackTotal: str("BLIZZARD_BUYOUT_IS_STACK_TOTAL", "true") === "true",
    },
    tsm: {
      game: str("TSM_GAME", "forever"),
      region: str("TSM_REGION", "eu"),
      realm: str("TSM_REALM", "pvp-alliance"),
    },
    auctionator: {
      wowForeverDir: str("WOW_FOREVER_DIR", ""),
    },
    undermine: {
      apiKey: str("UNDERMINE_API_KEY", ""),
      region: str("UNDERMINE_REGION", "euf"),
      backfillMinSoldPerDay: num("UNDERMINE_BACKFILL_MIN_SOLD_PER_DAY", 0),
      reservePoints: num("UNDERMINE_RESERVE_POINTS", 100),
    },
    pollMinutes: {
      blizzard: num("BLIZZARD_POLL_MINUTES", 15),
      tsm: num("TSM_POLL_MINUTES", 60),
      auctionator: num("SCAN_IMPORT_MINUTES", 1),
      undermine: num("UNDERMINE_POLL_MINUTES", 20),
    },
    rawRetentionDays: num("RAW_RETENTION_DAYS", 30),
    dataDir: resolve(root, str("DATA_DIR", "./data")),
  };
}

export function hasBlizzardCredentials(config: Config): boolean {
  return config.blizzard.clientId !== "" && config.blizzard.clientSecret !== "";
}
