// Runs the collector and the dashboard together in one terminal (handy on Windows and macOS, where
// there is no systemd service). Ctrl+C stops both.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = process.env.DASHBOARD_PORT ?? "8787";
const children = [
  spawn(process.execPath, ["src/cli.ts", "run"], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, ["src/api/server.ts"], { cwd: root, stdio: "inherit" }),
];
console.log(`AH Tracker running. Dashboard: http://localhost:${port}/  (Ctrl+C to stop)`);
const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => { if (code) { console.error(`a process exited with code ${code}; stopping`); stop(); } });
