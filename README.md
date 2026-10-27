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

## Update
```
bash ~/render-agent/update.sh
```

## Files
- `agent.mjs`: the helper (polls the Hub, runs Claude Code, runs the engine, uploads).
- `engine/`: the video engine. `engine/README.md` is how a video is written (Claude reads it).
- `install.sh`, `update.sh`, `render-agent.env.example`.

Logs: `journalctl -u cytron-render -f`. Work folders: `~/hub-video-work/`.
