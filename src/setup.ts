// First-run setup shared by the CLI and the dashboard's Setup page: the WoW folder, API keys in .env,
// a folder browser for picking the WoW folder (Windows, macOS and Linux), and installing the addon.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { parseEnv } from "node:util";
import { ENV_EXAMPLE, ENV_FILE } from "./config.ts";

/** Settings the Setup page can change. Keys are write-only: the page only learns whether each is set. */
export const SETUP_FIELDS = ["WOW_FOREVER_DIR", "UNDERMINE_API_KEY", "BLIZZARD_CLIENT_ID", "BLIZZARD_CLIENT_SECRET"] as const;
export type SetupField = (typeof SETUP_FIELDS)[number];
export const SECRET_FIELDS: ReadonlySet<SetupField> = new Set(["UNDERMINE_API_KEY", "BLIZZARD_CLIENT_ID", "BLIZZARD_CLIENT_SECRET"]);

export const ADDON_SRC = resolve(import.meta.dirname, "..", "addon", "AHTracker");

export function readEnvFile(file = ENV_FILE): Record<string, string> {
  try { return parseEnv(readFileSync(file, "utf8")) as Record<string, string>; } catch { return {}; }
}

/**
 * A .env value that Node's parser reads back unchanged. Single quotes keep backslashes literal, which
 * Windows paths need (in double quotes "\n" would become a newline).
 */
function envValue(v: string): string {
  if (v === "") return "";
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes("\\")) return `"${v}"`;
  if (!v.includes("`")) return `\`${v}\``;
  throw new Error("value cannot contain all of ' \" and `");
}

/** Sets values in .env (created from .env.example if missing), keeping every other line and comment. */
export function saveEnv(updates: Partial<Record<SetupField, string>>, file = ENV_FILE): void {
  for (const [k, v] of Object.entries(updates)) {
    if (!SETUP_FIELDS.includes(k as SetupField)) throw new Error(`${k} cannot be set here`);
    if (/[\r\n]/.test(v ?? "")) throw new Error(`${k} must be a single line`);
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : existsSync(ENV_EXAMPLE) ? readFileSync(ENV_EXAMPLE, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (const [k, v] of Object.entries(updates) as [SetupField, string][]) {
    const line = `${k}=${envValue(v.trim())}`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = line;
    else lines.splice(lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, line);
  }
  writeFileSync(file, lines.join(eol), { mode: 0o600 });
}

export interface WowDirCheck {
  path: string;
  exists: boolean;
  /** Looks like a `_forever_` folder: has Interface/ or WTF/ (WTF appears after the first login). */
  looksRight: boolean;
  accounts: string[];
  addonInstalled: boolean;
  auctionatorInstalled: boolean;
  hint: string | null;
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function checkWowDir(path: string): WowDirCheck {
  const p = path.trim();
  const exists = p !== "" && isDir(p);
  const accountsDir = join(p, "WTF", "Account");
  const accounts = exists && isDir(accountsDir) ? readdirSync(accountsDir).filter((a) => a !== "SavedVariables" && isDir(join(accountsDir, a))) : [];
  const looksRight = exists && (isDir(join(p, "Interface")) || isDir(join(p, "WTF")));
  let hint: string | null = null;
  if (!p) hint = "Pick your WoW: Forever folder.";
  else if (!exists) hint = "That folder does not exist.";
  else if (!looksRight) {
    hint = isDir(join(p, "_forever_")) ? "This is the World of Warcraft folder; open the _forever_ folder inside it." : "No Interface or WTF folder here; pick the _forever_ folder inside World of Warcraft.";
  } else if (!accounts.length) hint = "Log in to WoW once so it creates WTF/Account, then scans can be found.";
  return {
    path: p, exists, looksRight, accounts,
    addonInstalled: exists && existsSync(join(p, "Interface", "AddOns", "AHTracker", "AHTracker.toc")),
    auctionatorInstalled: exists && existsSync(join(p, "Interface", "AddOns", "Auctionator")),
    hint,
  };
}

/** Windows drive roots that exist (C:\, D:\, ...). */
function windowsDrives(): string[] {
  return "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter(isDir);
}

/** Usual install locations of the `_forever_` folder that exist on this machine. */
export function wowDirCandidates(): string[] {
  const home = homedir();
  const wow = (base: string) => [join(base, "World of Warcraft", "_forever_"), join(base, "Games", "World of Warcraft", "_forever_")];
  let bases: string[] = [];
  if (process.platform === "win32") {
    for (const d of windowsDrives()) bases.push(join(d, "Program Files (x86)"), join(d, "Program Files"), d);
  } else if (process.platform === "darwin") {
    bases = ["/Applications", join(home, "Applications")];
  } else {
    // Wine prefixes: plain Wine, Lutris, Bottles, Faugus, Steam/Proton-style folders under ~/Games.
    const prefixes = [join(home, ".wine")];
    for (const parent of [join(home, "Games"), join(home, "Faugus"), join(home, ".local", "share", "lutris", "prefixes"), join(home, ".var", "app", "com.usebottles.bottles", "data", "bottles", "bottles")])
      if (isDir(parent)) for (const d of readdirSync(parent)) prefixes.push(join(parent, d));
    for (const pre of prefixes) bases.push(join(pre, "drive_c", "Program Files (x86)"), join(pre, "drive_c", "Program Files"));
  }
  return [...new Set(bases.flatMap(wow))].filter((p) => checkWowDir(p).looksRight);
}

export interface DirListing {
  path: string;
  parent: string | null;
  /** Shortcuts shown above the list: home, drives on Windows, filesystem root elsewhere. */
  places: { label: string; path: string }[];
  dirs: string[];
  error: string | null;
}

/** Sub-folders of `path` for the Setup page's folder browser (folders only, hidden ones skipped). */
export function listDirs(path: string | null): DirListing {
  const home = homedir();
  const places = [
    { label: "Home", path: home },
    ...(process.platform === "win32" ? windowsDrives().map((d) => ({ label: d, path: d })) : [{ label: "/", path: "/" }]),
  ];
  const p = resolve(path && path.trim() ? path.trim() : home);
  const root = parse(p).root;
  const parent = p === root ? null : dirname(p);
  try {
    const dirs = readdirSync(p, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && isDir(join(p, d.name)))) && !d.name.startsWith(".") && !d.name.startsWith("$"))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return { path: p, parent, places, dirs, error: null };
  } catch (err) {
    return { path: p, parent, places, dirs: [], error: (err as NodeJS.ErrnoException).code === "EACCES" || (err as NodeJS.ErrnoException).code === "EPERM" ? "No permission to open this folder" : "Folder not found" };
  }
}

/** Copies addon/AHTracker into <WoW>/Interface/AddOns/AHTracker, keeping an existing Lists.lua. */
export function installAddon(wowForeverDir: string): string {
  if (!wowForeverDir) throw new Error("set the WoW folder (WOW_FOREVER_DIR) first");
  if (!checkWowDir(wowForeverDir).looksRight) throw new Error(`${wowForeverDir} does not look like a WoW _forever_ folder`);
  const dest = join(wowForeverDir, "Interface", "AddOns", "AHTracker");
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(ADDON_SRC))
    if (f !== "Lists.lua" || !existsSync(join(dest, f))) copyFileSync(join(ADDON_SRC, f), join(dest, f));
  return dest;
}
