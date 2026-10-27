#!/usr/bin/env bash
# Installs the Marketing Hub render helper as a service on the render machine (Ubuntu/Debian PC,
# or a Raspberry Pi). Run it from the cloned repo, as the user who is signed in to Claude Code:
#   bash install.sh
# It asks for sudo to install Chrome (or Chromium) and ffmpeg and to write the service file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"
SERVICE=cytron-render
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. $2"; exit 1; }; }
need node "Install Node 22 or newer (for example with nvm), then run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node $NODE_MAJOR is too old: the helper needs Node 22 or newer."; exit 1; }

# A browser the engine can drive. Google Chrome on a PC (Ubuntu's Chromium is a snap, which can't
# be driven headless from a service); Chromium from apt on a Pi.
not_snap() { [ -n "$1" ] && ! readlink -f "$1" | grep -q '/snap/'; }
CHROME=""
for c in google-chrome-stable google-chrome chromium chromium-browser; do
  p="$(command -v "$c" || true)"; if not_snap "$p"; then CHROME="$p"; break; fi
done
if [ -z "$CHROME" ]; then
  if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "x86_64" ]; then
    echo "Installing Google Chrome (sudo)..."
    TMPDEB="$(mktemp --suffix=.deb)"
    curl -fsSL -o "$TMPDEB" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo apt-get install -y "$TMPDEB"; rm -f "$TMPDEB"
    CHROME="$(command -v google-chrome-stable || true)"
  else
    echo "Installing Chromium (sudo)..."
    sudo apt-get update -qq
    sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
    CHROME="$(command -v chromium || command -v chromium-browser || true)"
  fi
fi
not_snap "$CHROME" || { echo "No usable Chrome/Chromium. Install Google Chrome, or set CHROMIUM_PATH in render-agent.env."; exit 1; }
if ! command -v ffmpeg >/dev/null 2>&1; then echo "Installing ffmpeg (sudo)..."; sudo apt-get update -qq; sudo apt-get install -y ffmpeg; fi
need claude "Install Claude Code (npm install -g @anthropic-ai/claude-code), run claude once and sign in (or put ANTHROPIC_API_KEY in render-agent.env), then run this again."

if [ ! -f "$HERE/render-agent.env" ]; then
  cp "$HERE/render-agent.env.example" "$HERE/render-agent.env"
  echo "Created $HERE/render-agent.env"
fi
chmod 600 "$HERE/render-agent.env"

# shellcheck disable=SC1091
set -a; . "$HERE/render-agent.env"; set +a
if [ -z "${RENDER_TOKEN:-}" ]; then
  echo
  echo "Next: open $HERE/render-agent.env in an editor and type the RENDER_TOKEN"
  echo "(the same one as in the Hub's .env), then run this script again."
  exit 0
fi
HUB="${HUB_URL:-https://marketinghub.cytron.io}"
# Checks the address and the token without taking a job (asks for a file that doesn't exist: 404 = fine).
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $RENDER_TOKEN" "$HUB/render-agent/media/0" || true)"
case "$CODE" in
  404) echo "The Hub answers at $HUB and accepts the token." ;;
  401) echo "The Hub at $HUB refused RENDER_TOKEN: type the same token as in the Hub's .env into render-agent.env."; exit 1 ;;
  *) echo "Can't reach the Hub at $HUB (HTTP $CODE). Check HUB_URL in render-agent.env and the machine's internet."; exit 1 ;;
esac

# A quick test of the engine: a two-second video in a temporary folder.
echo "Testing the video engine..."
TEST="$(mktemp -d)"
mkdir -p "$TEST/scenes"
cat > "$TEST/scenes/scene-1.js" <<'JS'
HM.scene({ n: 1, draw(ctx, f) { ctx.fillStyle = '#101112'; ctx.fillRect(0, 0, f.W, f.H); HM.headline(ctx, f, ['Engine test']); }, sound(k) { k.play('pop', 0.3); } });
JS
echo "HM.video({ scenes: [{ n: 1, start: 0, end: 2 }] });" > "$TEST/video.js"
START=$(date +%s)
if CHROMIUM_PATH="${CHROMIUM_PATH:-$CHROME}" node "$HERE/engine/render.mjs" "$TEST" --mode video --out "$TEST/test.mp4" >/dev/null 2>"$TEST/err.txt" && [ -s "$TEST/test.mp4" ]; then
  echo "Engine OK ($(( $(date +%s) - START )) s for a 2-second test video)."
else
  echo "The engine test failed:"; tail -20 "$TEST/err.txt"; rm -rf "$TEST"; exit 1
fi
rm -rf "$TEST"

# Limits: half the machine's memory (at most 16 GB) and most of its cores, at low priority, so other
# services on it (ChirpStack and its databases) stay responsive. Override in render-agent.env.
MEM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
MEM_MAX_MB="${RENDER_MEMORY_MAX_MB:-$(( MEM_KB / 1024 / 2 < 16384 ? MEM_KB / 1024 / 2 : 16384 ))}"
CORES="$(nproc)"
CPU_QUOTA="${RENDER_CPU_PERCENT:-$(( CORES > 2 ? (CORES - 1) * 100 : 100 ))}"

# The service runs with this user's PATH, so node, claude and the browser are found as in your terminal.
NODE_DIR="$(dirname "$(command -v node)")"
CLAUDE_DIR="$(dirname "$(command -v claude)")"
SVC_PATH="$NODE_DIR:$CLAUDE_DIR:/usr/local/bin:/usr/bin:/bin"

sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<UNIT
[Unit]
Description=Cytron Marketing Hub render helper (Claude Code + the canvas video engine)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$HERE
Environment=HOME=$HOME
Environment=PATH=$SVC_PATH
Environment=CHROMIUM_PATH=${CHROMIUM_PATH:-$CHROME}
ExecStart=$(command -v node) $HERE/agent.mjs
Restart=always
RestartSec=20
Nice=${RENDER_NICE:-10}
CPUWeight=30
CPUQuota=${CPU_QUOTA}%
MemoryHigh=$(( MEM_MAX_MB * 3 / 4 ))M
MemoryMax=${MEM_MAX_MB}M
IOSchedulingClass=idle
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

# Auto-update: every 5 minutes the machine asks GitHub for a new commit. If there is one it is
# pulled, checked (code loads, a 2-second test video renders) and used once the videos in hand are
# done; if the check fails the previous version is put back. Turn off with AUTO_UPDATE=0.
if [ "${AUTO_UPDATE:-1}" != "0" ]; then
  sudo tee /etc/systemd/system/$SERVICE-update.service >/dev/null <<UNIT
[Unit]
Description=Cytron render helper: pull and apply updates from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER_NAME
WorkingDirectory=$HERE
Environment=HOME=$HOME
Environment=PATH=$SVC_PATH
Environment=CHROMIUM_PATH=${CHROMIUM_PATH:-$CHROME}
ExecStart=/bin/bash $HERE/update.sh --auto
Nice=15
TimeoutStartSec=10min
UNIT
  sudo tee /etc/systemd/system/$SERVICE-update.timer >/dev/null <<UNIT
[Unit]
Description=Check GitHub for render helper updates every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30
Persistent=true

[Install]
WantedBy=timers.target
UNIT
fi

sudo systemctl daemon-reload
sudo systemctl enable $SERVICE
sudo systemctl restart $SERVICE
if [ "${AUTO_UPDATE:-1}" != "0" ]; then
  sudo systemctl enable --now $SERVICE-update.timer
  AUTO_MSG="Auto-update: on (checks GitHub every 5 minutes). Log:  journalctl -u $SERVICE-update"
else
  sudo systemctl disable --now $SERVICE-update.timer 2>/dev/null || true
  AUTO_MSG="Auto-update: off (AUTO_UPDATE=0). Update by hand with:  bash $HERE/update.sh"
fi
sleep 3
systemctl --no-pager --lines=8 status $SERVICE || true
echo
echo "Installed: ${RENDER_JOBS:-1} job(s) at once, up to ${MEM_MAX_MB} MB memory and ${CPU_QUOTA}% CPU."
echo "Follow it with:  journalctl -u $SERVICE -f"
echo "$AUTO_MSG"
echo "The Hub's System health page shows the render machine as online within a minute."
