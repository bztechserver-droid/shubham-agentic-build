#!/bin/bash
# Brings this build up to the newest one published, on Linux (F-116): what Update.cmd is on Windows. git pull from the
# build repo, then its packages again if they changed. The app runs this itself when you press Update on its Build page
# (through start.sh). By hand, stop the app first: systemctl --user stop shubham-agentic
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
before=$(git rev-parse HEAD)
echo "[$(date '+%F %T')] updating from $before"
if ! git pull --ff-only; then
  echo "The pull failed: this build is unchanged. Is the PC online, and signed in to GitHub (gh auth login)?"
  exit 1
fi
git diff --quiet "$before" HEAD -- package-lock.json || npm ci --omit=dev --no-audit --no-fund
echo "[$(date '+%F %T')] now at $(git rev-parse --short HEAD)"
exit 0
