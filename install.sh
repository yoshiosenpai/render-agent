#!/usr/bin/env bash
# Installs the Marketing Hub render helper as a service on the render machine (Ubuntu).
# Run it as the user who owns the Remotion project and is signed in to Claude Code:
#   bash install.sh
# It asks for sudo only to write the service file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
SERVICE=cytron-render

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2"; exit 1; }; }
need node "Install Node 22 or newer (e.g. with nvm), then run this again."
need npx "It comes with Node."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node $NODE_MAJOR is too old: the helper needs Node 22 or newer."; exit 1; }
need claude "Install Claude Code (npm install -g @anthropic-ai/claude-code), run claude once and sign in with the Claude subscription, then run this again."

if [ ! -f "$HERE/render-agent.env" ]; then
  cp "$HERE/render-agent.env.example" "$HERE/render-agent.env"
  chmod 600 "$HERE/render-agent.env"
  echo "Created $HERE/render-agent.env"
fi
chmod 600 "$HERE/render-agent.env"

# shellcheck disable=SC1091
set -a; . "$HERE/render-agent.env"; set +a
PROJECT="${REMOTION_DIR:-$HOME/Desktop/marketing-hub}"
[ -f "$PROJECT/package.json" ] || { echo "No Remotion project at $PROJECT. Set REMOTION_DIR in render-agent.env."; exit 1; }
if [ -z "${RENDER_TOKEN:-}" ]; then
  echo
  echo "Next: open $HERE/render-agent.env in an editor and type the RENDER_TOKEN"
  echo "(the same one as in the Hub's .env), then run this script again."
  exit 0
fi

# The service runs with this user's PATH, so node, npx and claude are found as they are in your terminal.
NODE_DIR="$(dirname "$(command -v node)")"
CLAUDE_DIR="$(dirname "$(command -v claude)")"
SVC_PATH="$NODE_DIR:$CLAUDE_DIR:/usr/local/bin:/usr/bin:/bin"

sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=Cytron Marketing Hub render helper (Remotion + Claude Code)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$HERE
Environment=HOME=$HOME
Environment=PATH=$SVC_PATH
ExecStart=$(command -v node) $HERE/agent.mjs
Restart=always
RestartSec=20
# Gentle on the machine: ChirpStack and its databases come first.
Nice=15
CPUWeight=20
CPUQuota=400%
MemoryHigh=12G
MemoryMax=16G
IOSchedulingClass=idle
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE
sleep 3
systemctl --no-pager --lines=8 status $SERVICE || true
echo
echo "Installed. Follow it with:  journalctl -u $SERVICE -f"
echo "The Hub's System health page shows the machine as online within a minute."
