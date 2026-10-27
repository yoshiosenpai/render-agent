# Cytron Marketing Hub: render helper

Makes the Hub's videos. It asks the Hub (`https://marketinghub.cytron.io`) for jobs, has Claude Code
write each video's animation for Cytron's own canvas engine (`engine/`, no Remotion), then checks it,
draws the storyboard frames, makes the live preview and renders the MP4, and sends them back.
It only makes outgoing calls to the Hub, with `RENDER_TOKEN`.

Needs: Linux (Ubuntu/Debian PC, or a Raspberry Pi), Node 22+, Claude Code signed in (or
`ANTHROPIC_API_KEY` in `render-agent.env`). `install.sh` adds Google Chrome (Chromium on a Pi) and
ffmpeg.

## Install
```
git clone https://github.com/yoshiosenpai/render-agent.git ~/render-agent
cd ~/render-agent
npm install -g @anthropic-ai/claude-code
claude
bash install.sh
nano render-agent.env
bash install.sh
```
`claude`: sign in, then `/exit`. The first `install.sh` creates `render-agent.env`: type the
`RENDER_TOKEN` (same as the Hub's `.env`), then run it again. It checks the Hub answers, tests the
engine with a 2-second video and installs the `cytron-render` service.

## Updates (automatic)
`install.sh` also installs a timer: every 5 minutes the machine checks GitHub. When there is a new
commit it pulls it, checks it (the code loads and the engine renders a 2-second test video) and the
helper switches to it once the videos it is making are done. If the check fails, the previous
version is put back and keeps running. So: push to `main`, and within about 5 minutes the render
machine runs it. Nobody needs to be at the machine.

- See what it did: `journalctl -u cytron-render-update` (the Hub's System health shows the new version).
- Update now by hand: `bash ~/render-agent/update.sh`
- Turn it off: `AUTO_UPDATE=0` in `render-agent.env`, then `bash install.sh`.
- A change to `install.sh` itself (service limits, new packages) still needs one `bash install.sh` at the machine.
- It never overwrites edits made on the machine: it stops and logs it instead (`git status`).
- Anyone who can push to this repo can run code on this machine: keep the repo's push access to the
  team, and protect `main` (Settings > Branches). If the repo is private, give the machine a
  read-only deploy key.

## Files
- `agent.mjs`: the helper (polls the Hub, runs Claude Code, runs the engine, uploads).
- `engine/`: the video engine. `engine/README.md` is how a video is written (Claude reads it).
- `install.sh`, `update.sh`, `render-agent.env.example`.

Logs: `journalctl -u cytron-render -f`. Work folders: `~/hub-video-work/`.
