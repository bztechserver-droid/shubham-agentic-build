#!/bin/bash
# Shubham Agentic (the build) on Linux (F-116): what Start.cmd is on Windows. Keeps the app running on this PC: its
# device agent, which also serves the page at http://localhost:5173. install.sh makes a systemd user service run this
# at login. When the app asks to update (exit code 75, its Build page's Update), this runs update.sh and starts it
# again; when it stops for any other reason, it starts again 5 s later.
# The first time on a hub: start.sh --role hub (the role is remembered after that).
# Output goes to <state>/agent-console.log; the agent's own log is in <state>/agent/logs. <state> is $SAD_HOME, else
# $XDG_DATA_HOME/shubham-agentic, else ~/.local/share/shubham-agentic (agent/config.ts works it out the same way).
# Run through bash (bash start.sh): a build published from Windows doesn't keep the files' executable bit.
cd "$(dirname "$0")" || exit 1
export SAD_SUPERVISED=1
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
LOGDIR="${SAD_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/shubham-agentic}"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/agent-console.log"
[ -d node_modules ] || npm ci --omit=dev --no-audit --no-fund >> "$LOG" 2>&1
child=
# systemctl --user stop: the agent stops cleanly first (it is told with SIGTERM), then this loop ends.
trap 'stopping=1; [ -n "$child" ] && kill -TERM "$child" 2>/dev/null' TERM INT
stopping=
while [ -z "$stopping" ]; do
  node agent/main.ts --app app "$@" >> "$LOG" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  # A signal interrupts wait before the agent has ended: wait for it again.
  while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done
  child=
  [ -n "$stopping" ] && break
  [ "$code" -eq 75 ] && bash ./update.sh >> "$LOG" 2>&1
  sleep 5
done
