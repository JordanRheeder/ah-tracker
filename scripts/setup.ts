// First-time setup: creates .env from .env.example and turns on the secret-guard git hook.
// The rest (WoW folder, addon, API keys) is done on the dashboard's Setup page.
import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = join(root, ".env");
if (existsSync(env)) console.log(".env already exists; leaving it as it is");
else { copyFileSync(join(root, ".env.example"), env); console.log("created .env from .env.example"); }

const git = spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
console.log(git.status === 0 ? "git pre-commit hook on (blocks keys and ledger data)" : "git not found; skipped the pre-commit hook");

console.log("\nNext: run `pnpm serve`, open http://localhost:8787/#/setup and pick your WoW folder there.");
