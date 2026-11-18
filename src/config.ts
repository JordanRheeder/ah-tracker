import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
  pollMinutes: { blizzard: number; tsm: number };
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
    pollMinutes: {
      blizzard: num("BLIZZARD_POLL_MINUTES", 15),
      tsm: num("TSM_POLL_MINUTES", 180),
    },
    rawRetentionDays: num("RAW_RETENTION_DAYS", 30),
    dataDir: resolve(root, str("DATA_DIR", "./data")),
  };
}

export function hasBlizzardCredentials(config: Config): boolean {
  return config.blizzard.clientId !== "" && config.blizzard.clientSecret !== "";
}
