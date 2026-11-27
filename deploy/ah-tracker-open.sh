#!/usr/bin/env bash
# Desktop shortcut: make sure AH Tracker is running, import new data now, open the dashboard.
set -u
cd "$HOME/Projects/ah-tracker" || exit 1
NODE="$HOME/.local/share/pnpm/bin/node"
LOG="$HOME/Projects/ah-tracker/data/shortcut.log"
mkdir -p "$(dirname "$LOG")"

notify() { command -v notify-send >/dev/null && notify-send -a "AH Tracker" -i office-chart-line "AH Tracker" "$1"; }

systemctl --user start ah-tracker.service ah-dashboard.service

# Import Auctionator scans and fetch TSM now instead of waiting for the next scheduled run.
{ echo "== $(date -Is)"; "$NODE" src/cli.ts poll-once; } >>"$LOG" 2>&1
summary=$(tail -5 "$LOG" | grep -Eo 'auctionator: [0-9]+ new|tsm-(realm|region): (stored|unchanged)' | paste -sd ', ' -)
notify "Data refreshed: ${summary:-see data/shortcut.log}"

# Wait for the dashboard to answer (up to 10 s), then open it.
for _ in $(seq 20); do curl -s -o /dev/null http://127.0.0.1:8787/ && break; sleep 0.5; done
xdg-open http://localhost:8787/ >/dev/null 2>&1 &
