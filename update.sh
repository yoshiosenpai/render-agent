#!/usr/bin/env bash
# Updates the render helper from GitHub. Your render-agent.env is kept (git ignores it).
#   bash update.sh          update now (by hand)
#   bash update.sh --auto   what the cytron-render-update timer runs every few minutes: does nothing
#                           unless GitHub has a new commit
# A new version is checked before it's used (the code loads, the engine renders a 2-second test
# video). If the check fails, the previous version is put back and keeps running. The helper then
# finishes the videos in hand before it restarts, so an update never cuts a job off.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
AUTO=0; [ "${1:-}" = "--auto" ] && AUTO=1
say() { echo "$(date '+%F %T') $*"; }

# shellcheck disable=SC1091
[ -f "$HERE/render-agent.env" ] && { set -a; . "$HERE/render-agent.env"; set +a; }

git fetch --quiet origin || { say "Can't reach GitHub; trying again next time."; exit 0; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "$OLD")"
if [ "$OLD" = "$NEW" ]; then [ "$AUTO" = 1 ] || say "Already up to date ($(git log -1 --format='%h %s'))."; exit 0; fi
# A commit that already failed its check is not tried again until something newer is pushed.
SKIP="$HERE/.update-failed"
if [ "$AUTO" = 1 ] && [ -f "$SKIP" ] && [ "$(cat "$SKIP")" = "$NEW" ]; then exit 0; fi
if ! git merge-base --is-ancestor "$OLD" "$NEW"; then say "This copy has its own commits or edits that aren't on GitHub, so it wasn't updated. Fix it by hand: git status"; exit 1; fi
if ! git diff --quiet || ! git diff --cached --quiet; then say "Files here were edited by hand, so it wasn't updated. See: git status (git checkout -- . puts them back)"; exit 1; fi

say "Updating $(git log -1 --format='%h' "$OLD") -> $(git log -1 --format='%h %s' "$NEW")"
git merge --ff-only --quiet "$NEW" || { say "git merge failed"; exit 1; }

# Check the new version before the helper uses it.
fail() { say "The new version failed its check ($1). Putting back $(git log -1 --format='%h' "$OLD")."; git reset --hard --quiet "$OLD"; echo "$NEW" > "$SKIP"; exit 1; }
node --check agent.mjs >/dev/null 2>&1 || fail "agent.mjs doesn't load"
for f in engine/render.mjs engine/hm.js engine/sound.js engine/player.js; do node --check "$f" >/dev/null 2>&1 || fail "$f doesn't load"; done
TEST="$(mktemp -d)"
mkdir -p "$TEST/scenes"
cat > "$TEST/scenes/scene-1.js" <<'JS'
HM.scene({ n: 1, draw(ctx, f) { ctx.fillStyle = '#101112'; ctx.fillRect(0, 0, f.W, f.H); HM.headline(ctx, f, ['Update test']); }, sound(k) { k.play('pop', 0.3); } });
JS
echo "HM.video({ scenes: [{ n: 1, start: 0, end: 2 }] });" > "$TEST/video.js"
if ! nice -n 15 node engine/render.mjs "$TEST" --mode video --out "$TEST/test.mp4" >/dev/null 2>"$TEST/err.txt" || [ ! -s "$TEST/test.mp4" ]; then
  tail -5 "$TEST/err.txt"; rm -rf "$TEST"; fail "the engine test video didn't render"
fi
rm -rf "$TEST"
rm -f "$SKIP"

VERSION="$(grep -o "VERSION = '[^']*'" agent.mjs | cut -d"'" -f2)"
# The helper finishes its jobs, then exits; systemd starts the new version.
if pgrep -u "$(id -u)" -f "$HERE/agent.mjs" >/dev/null; then
  pkill -USR2 -u "$(id -u)" -f "$HERE/agent.mjs"
  say "Updated to $VERSION. The helper restarts with it as soon as the videos in hand are done."
else
  sudo -n systemctl start cytron-render 2>/dev/null || true
  say "Updated to $VERSION. (The helper wasn't running; start it with: sudo systemctl start cytron-render)"
fi
if git diff --name-only "$OLD" "$NEW" | grep -qx 'install.sh'; then
  say "install.sh changed: run bash install.sh once by hand to apply its changes to the service."
fi
