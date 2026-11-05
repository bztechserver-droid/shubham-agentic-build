#!/bin/bash
# Makes this build start at login on Linux (F-116): what Install.cmd is on Windows, with a systemd user service,
# shubham-agentic, that runs start.sh. No administrator needed. Then it starts it and opens http://localhost:5173.
#   bash install.sh                 install (or update the service) and start
#   bash install.sh --role hub      the same, the first time on a hub
#   bash install.sh --remove        stop it and take it out of the login programs
# The service starts when you log in to this PC. To start it at boot, before anyone logs in, run once:
#   loginctl enable-linger "$USER"
# Its log: journalctl --user -u shubham-agentic, and <state>/agent-console.log (see start.sh).
set -e
cd "$(dirname "$0")"
here=$(pwd)
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/shubham-agentic.service"

if [ "$1" = "--remove" ]; then
  systemctl --user disable --now shubham-agentic.service 2>/dev/null || true
  rm -f "$unit"
  systemctl --user daemon-reload
  echo "Stopped, and taken out of the login programs."
  exit 0
fi

role_args=""
if [ "$1" = "--role" ] && [ -n "$2" ]; then role_args=" --role $2"; fi

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
command -v node >/dev/null || { echo "Node isn't installed (it goes in ~/.local/node): see README.md"; exit 1; }
command -v git >/dev/null || { echo "git isn't installed: sudo apt install -y git"; exit 1; }
[ -d node_modules ] || npm ci --omit=dev --no-audit --no-fund

mkdir -p "$unit_dir"
cat > "$unit" <<EOF
[Unit]
Description=Shubham Agentic (the app: its agent and the page on http://localhost:5173)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$here
ExecStart=/bin/bash "$here/start.sh"$role_args
# Stop: the agent is told first (start.sh passes it on) and stops its chats itself; whatever is left after 30 s goes.
KillMode=mixed
TimeoutStopSec=30
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable shubham-agentic.service
systemctl --user restart shubham-agentic.service
echo "Installed: it starts when you log in. Starting it now..."

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://localhost:5173/ 2>/dev/null; then
    echo "The app is up on http://localhost:5173"
    command -v xdg-open >/dev/null && [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && xdg-open http://localhost:5173 >/dev/null 2>&1 &
    exit 0
  fi
  sleep 1
done
echo "The page doesn't answer yet. See: journalctl --user -u shubham-agentic"
exit 1
