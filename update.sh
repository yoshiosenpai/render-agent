#!/usr/bin/env bash
# Updates the render helper from GitHub and restarts it. Your render-agent.env is kept.
#   bash update.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
git pull --ff-only
sudo systemctl restart cytron-render
sleep 2
systemctl --no-pager --lines=5 status cytron-render || true
echo "Updated to $(grep -o "VERSION = '[^']*'" agent.mjs | cut -d"'" -f2)."
