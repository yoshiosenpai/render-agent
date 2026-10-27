#!/usr/bin/env node
// The Marketing Hub's render helper. Runs on the render machine (a Linux PC; a Pi works too). It asks
// the Hub for video jobs, has Claude Code write or change each video's code (Cytron's own canvas
// engine, in ./engine: no Remotion), then uses the engine to check it, draw the storyboard stills,
// make the live preview page and render the MP4, and sends them back to the Hub.
//
// It only makes outgoing calls to the Hub (HUB_URL) with RENDER_TOKEN, at low priority. RENDER_JOBS
// jobs run at once (never two for the same script). No packages to install: Node 22+, Chrome or
// Chromium, ffmpeg and Claude Code (signed in, or ANTHROPIC_API_KEY in render-agent.env) are enough.
//
// Settings: render-agent.env next to this file (see render-agent.env.example).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '2.3.0';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(here, 'render-agent.env')]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const E = process.env;
const HUB = String(E.HUB_URL || 'https://marketinghub.cytron.io').replace(/\/$/, '');
const TOKEN = E.RENDER_TOKEN || '';
const ENGINE = path.join(here, 'engine');
const WORK = E.WORK_DIR || path.join(os.homedir(), 'hub-video-work');
const NICE = String(Number(E.RENDER_NICE || 10) || 10);
const CLAUDE = E.CLAUDE_BIN || 'claude';
const POLL = (Number(E.POLL_SECONDS || 15) || 15) * 1000;
const MAX_TURNS = String(Number(E.CLAUDE_MAX_TURNS || 80) || 80);
const BUILD_MIN = Number(E.BUILD_TIMEOUT_MIN || 30) || 30;
const RENDER_MIN = Number(E.RENDER_TIMEOUT_MIN || 40) || 40;
const MACHINE = E.MACHINE_NAME || os.hostname();
const RENDER = path.join(ENGINE, 'render.mjs');
// What Claude Code may do: edit files in the video's work folder, read the engine, run the engine's
// check and stills, and measure voice-over files.
const ALLOWED = `Read,Write,Edit,MultiEdit,Glob,Grep,LS,Bash(node ${RENDER}:*),Bash(ffprobe:*),Bash(ls:*),Bash(mkdir:*)`;

const say = (...a) => console.log(new Date().toISOString(), ...a);
if (!TOKEN) { say('RENDER_TOKEN must be set in render-agent.env'); process.exit(1); }

const api = (p, opts = {}) => fetch(HUB + p, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 60000) });
async function status(job, body) {
  try { await api(`/render-agent/jobs/${job.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { say('status failed:', e.message); }
}

// Runs a command; keeps the Hub told it's alive; returns { code, out } (stdout+stderr, last 200 kB).
function run(cmd, args, { cwd, minutes, onLine, keepAlive } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let out = '', rest = '';
    // Whole lines only (a chunk can end in the middle of one).
    const take = d => { const t = d.toString(); out = (out + t).slice(-200000); if (!onLine) return; const lines = (rest + t).split(/\r?\n/); rest = lines.pop(); for (const l of lines) if (l.trim()) onLine(l.trim()); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const alive = keepAlive ? setInterval(keepAlive, 30000) : null;
    const timer = setTimeout(() => { out += `\n[stopped after ${minutes} minutes]`; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000); }, minutes * 60000);
    child.on('error', e => { out += `\n${e.message}`; });
    child.on('close', code => { clearTimeout(timer); if (alive) clearInterval(alive); resolve({ code, out }); });
  });
}
const tail = (t, n = 3000) => String(t || '').slice(-n);
// The engine prints its result as JSON on stdout (progress goes to stderr, mixed in here): take the last object.
const lastJson = out => { const i = out.lastIndexOf('\n{'); for (const at of [i + 1, out.indexOf('{')]) { if (at < 0) continue; try { return JSON.parse(out.slice(at)); } catch { /* next */ } } return null; };
const engine = (ws, args, opts = {}) => run('nice', ['-n', NICE, process.execPath, RENDER, ws, ...args], { cwd: ws, ...opts });

async function claude(job, ws, prompt, stage) {
  // Streamed, so the Hub can show what Claude is doing: which scene files are written, when it checks its work.
  const total = (job.timeline || []).length;
  const written = new Set();
  let doing = '', result = null, lastSent = 0;
  const now = () => `${stage}${total ? ` · ${written.size} of ${total} scenes written` : ''}${doing ? ` · ${doing}` : ''}`;
  const tell = (force = false) => { if (force || Date.now() - lastSent > 4000) { lastSent = Date.now(); status(job, { stage: now() }); } };
  const onLine = line => {
    if (!line.startsWith('{')) return;
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'result') { result = m; return; }
    if (m.type !== 'assistant') return;
    for (const c of m.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const file = String(c.input?.file_path || '');
      const sc = file.match(/scene-(\d+)\.js$/);
      if (sc && ['Write', 'Edit', 'MultiEdit'].includes(c.name)) { written.add(sc[1]); doing = `writing scene ${sc[1]}`; }
      else if (/style\.js$/.test(file)) doing = 'writing the style';
      else if (/video\.js$/.test(file)) doing = 'putting the scenes in order';
      else if (/STORYBOARD\.json$/.test(file)) doing = 'writing the storyboard notes';
      else if (c.name === 'Bash' && /--mode check/.test(c.input?.command || '')) doing = 'checking its work';
      else if (c.name === 'Bash' && /--mode stills/.test(c.input?.command || '')) doing = 'looking at the frames';
      else if (c.name === 'Read' && /\.(jpg|png)$/.test(file)) doing = 'looking at the frames';
      else if (c.name === 'Read' && /(README|skills\/|BRIEF)/.test(file)) doing = 'reading the brief and skills';
      tell();
    }
  };
  const c = await run(CLAUDE, ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED, '--disallowedTools', 'WebFetch,WebSearch', '--add-dir', ENGINE, '--max-turns', MAX_TURNS, ...(E.CLAUDE_MODEL ? ['--model', E.CLAUDE_MODEL] : [])],
    { cwd: ws, minutes: BUILD_MIN, onLine, keepAlive: () => tell(true) });
  // Without a result line (an old Claude Code, or it stopped), the last JSON object stands in.
  if (!result) for (const line of c.out.split('\n').reverse()) { if (!line.trim().startsWith('{')) continue; try { const j = JSON.parse(line); if (j.type === 'result' || 'is_error' in j) { result = j; break; } } catch { /* not this one */ } }
  const cost = Number(result?.total_cost_usd);
  if (c.code !== 0 || !result || result.is_error) {
    const why = /login|auth|credential|sign in|api key/i.test(c.out) ? 'Claude Code isn\'t signed in on the Pi (run `claude` there once as this user and sign in).' : `Claude Code couldn't finish: ${tail(result?.result || c.out, 400)}`;
    return { ok: false, why, log: tail(c.out), cost: Number.isFinite(cost) ? cost : undefined };
  }
  return { ok: true, text: result.result || '', cost: Number.isFinite(cost) ? cost : 0 };
}

// The work folder: one per video, kept between jobs so changes build on what's there.
async function prepare(job, ws) {
  for (const d of ['scenes', 'assets', 'media', 'skills', 'style-frames', 'out']) fs.mkdirSync(path.join(ws, d), { recursive: true });
  fs.writeFileSync(path.join(ws, 'BRIEF.md'), job.brief);
  for (const k of (job.skills || []).filter(x => x?.text && x.slug)) {
    fs.writeFileSync(path.join(ws, 'skills', `${k.slug.replace(/[^a-z0-9-]/g, '')}.md`), k.text);
    for (const f of k.frames || []) {
      if (k.id == null) continue;
      const r = await api(`/render-agent/frames/${k.id}/${f.id}`).catch(() => null);
      if (r?.ok) fs.writeFileSync(path.join(ws, 'style-frames', `frame-${f.id}.${f.mime === 'image/png' ? 'png' : f.mime === 'image/webp' ? 'webp' : 'jpg'}`), Buffer.from(await r.arrayBuffer()));
    }
  }
  // The voice-overs and photos people added in the Hub, where the brief says they are.
  for (const m of job.media || []) {
    const dest = path.resolve(ws, m.path);
    if (!['media', 'assets'].some(d => dest.startsWith(path.join(ws, d) + path.sep))) continue;
    if (fs.existsSync(dest)) continue;
    const r = await api(`/render-agent/media/${m.id}`, { timeout: 5 * 60000 }).catch(() => null);
    if (!r?.ok) { say(`job ${job.id}: couldn't fetch media ${m.id}`); continue; }
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
}

// A recorded voice-over without a vo.json from Claude: place it at its scene's start.
function ensureVo(job, ws, timeline) {
  const vos = (job.media || []).filter(m => m.kind === 'vo' && fs.existsSync(path.join(ws, m.path)));
  const file = path.join(ws, 'vo.json');
  if (!vos.length || fs.existsSync(file)) return;
  const at = m => (m.scene == null ? 0 : (timeline.find(s => String(s.n) === String(m.sceneLabel))?.start ?? 0) + 0.15);
  fs.writeFileSync(file, JSON.stringify(vos.map(m => ({ file: m.path, start: Math.round(at(m) * 100) / 100, gain: 1 })), null, 2));
}

async function upload(job, what, file, type, query = '') {
  let up = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) await new Promise(z => setTimeout(z, attempt * 10000));
    up = await api(`/render-agent/jobs/${job.id}/${what}${query}`, { method: 'PUT', headers: { 'Content-Type': type }, body: await fs.openAsBlob(file), timeout: 18 * 60000 }).catch(e => ({ ok: false, statusText: e.message }));
    if (up.ok || [409, 413, 415, 401].includes(up.status)) break;
    say(`job ${job.id}: ${what} upload try ${attempt} failed: ${up.status || ''} ${up.statusText || ''}`);
  }
  return up;
}

async function doJob(job) {
  if (job.engine !== 'canvas') return status(job, { status: 'error', error: 'This job was made for the old Remotion helper. Ask for it again.' });
  const ws = path.join(WORK, String(job.base).replace(/[^A-Za-z0-9]/g, ''));
  const fmt = job.format === 'horizontal' ? 'horizontal' : 'vertical';
  const what = job.scope === 'full' ? 'the whole video' : job.scope === 'storyboard' ? 'the storyboard' : `scene ${job.sceneLabel}`;
  await status(job, { status: 'building', stage: 'Preparing the work folder' });
  await prepare(job, ws);
  // A new look: the old code goes, so nothing of the earlier style is carried over.
  if (job.restyle && !job.renderOnly) for (const f of ['style.js', 'video.js', 'scenes', 'vo.json', 'STORYBOARD.json']) fs.rmSync(path.join(ws, f), { recursive: true, force: true });
  fs.mkdirSync(path.join(ws, 'scenes'), { recursive: true });
  let cost = 0;

  // 1. Claude Code writes or changes the code (not for a video already approved in the storyboard).
  const hasCode = fs.existsSync(path.join(ws, 'video.js'));
  if (!job.renderOnly || !hasCode) {
    const stage = job.kind === 'change' ? `Claude is changing ${what}` : `Claude is building ${what}`;
    await status(job, { status: 'building', stage });
    const c = await claude(job, ws, job.instructions.replaceAll('ENGINE/', `${ENGINE}/`), stage);
    if (!c.ok) return status(job, { status: 'error', error: c.why, log: c.log, cost_usd: c.cost });
    cost += c.cost;
    await status(job, { status: 'building', stage: 'Checking the code', log: tail(c.text, 2000), cost_usd: cost });
  }

  // 2. The engine checks it; one round of fixes if it isn't clean.
  let chk = lastJson((await engine(ws, ['--mode', 'check', '--format', fmt], { minutes: 5 })).out);
  if (!chk?.ok && !job.renderOnly) {
    await status(job, { status: 'building', stage: 'Claude is fixing what the check found' });
    const fix = `The engine check of this video failed. Fix the code so \`node ${RENDER} . --mode check --format ${fmt}\` reports no errors (and no warnings if you can), without changing what the video shows. Read ${ENGINE}/README.md if you need the rules.\nCheck output (data): ${JSON.stringify({ errors: chk?.errors || ['no result'], warnings: chk?.warnings || [] }).slice(0, 4000)}`;
    const c = await claude(job, ws, fix, 'Claude is fixing what the check found');
    if (c.ok) cost += c.cost;
    chk = lastJson((await engine(ws, ['--mode', 'check', '--format', fmt], { minutes: 5 })).out);
  }
  if (!chk?.ok) return status(job, { status: 'error', error: `The video's code doesn't run cleanly: ${tail((chk?.errors || ['the check gave no result']).join(' | '), 400)}`, log: tail(JSON.stringify(chk || {}), 3000), cost_usd: cost || undefined });
  ensureVo(job, ws, chk.scenes || []);

  // 3. The live preview (one self-contained page) for the Hub.
  const pv = path.join(ws, 'out', `preview-${job.id}.html`);
  await engine(ws, ['--mode', 'bundle', '--format', fmt, '--out', pv], { minutes: 3 });
  if (fs.existsSync(pv)) { await upload(job, 'preview', pv, 'text/html; charset=utf-8'); try { fs.unlinkSync(pv); } catch { /* gone */ } }

  if (job.scope === 'storyboard') return storyboard(job, ws, fmt, chk, cost);

  // 4. Render: one scene (its own range of the timeline) or the whole video.
  const sc = job.scope === 'scene' ? (chk.scenes || []).find(s => String(s.n) === String(job.sceneLabel)) : null;
  if (job.scope === 'scene' && !sc) return status(job, { status: 'error', error: `Scene ${job.sceneLabel} isn't in the video's timeline (video.js).` });
  const mp4 = path.join(ws, 'out', `job-${job.id}.mp4`), jpg = path.join(ws, 'out', `job-${job.id}.jpg`);
  let last = '';
  await status(job, { status: 'rendering', stage: `Rendering ${what}` });
  const r = await engine(ws, ['--mode', 'video', '--format', fmt, '--out', mp4, '--poster', jpg, ...(sc ? ['--from', String(sc.start), '--to', String(sc.end)] : [])], {
    minutes: RENDER_MIN,
    keepAlive: () => status(job, { stage: `Rendering ${what}${last ? ` · ${last}` : ''}` }),
    onLine: l => { const m = l.match(/frame (\d+)\/(\d+)/); if (m) last = `${Math.round(100 * Number(m[1]) / Number(m[2]))}%`; },
  });
  const res = lastJson(r.out);
  if (r.code !== 0 || !fs.existsSync(mp4)) return status(job, { status: 'error', error: `The render failed: ${tail((res?.errors || [r.out]).join(' | '), 400)}`, log: tail(r.out), cost_usd: cost || undefined });

  // 5. Send it to the Hub.
  const mb = (fs.statSync(mp4).size / 1048576).toFixed(1);
  await status(job, { status: 'rendering', stage: `Sending the video to the Hub (${mb} MB)` });
  if (fs.existsSync(jpg)) await upload(job, 'poster', jpg, 'image/jpeg');
  const up = await upload(job, 'video', mp4, 'video/mp4', `?seconds=${res?.seconds ?? job.seconds ?? ''}`);
  for (const f of [mp4, jpg]) try { fs.unlinkSync(f); } catch { /* gone */ }
  if (!up?.ok) return status(job, { status: 'error', error: `The video was made but couldn't be sent to the Hub (${up?.status || ''} ${up?.statusText || ''}).` });
  say(`job ${job.id}: ${what} done (${mb} MB)`);
}

// Storyboard: one still per scene at the moment Claude picked (each scene's still:), with the notes
// from STORYBOARD.json. The Hub shows them for approval.
async function storyboard(job, ws, fmt, chk, cost) {
  await status(job, { status: 'rendering', stage: 'Drawing the storyboard frames' });
  const dir = path.join(ws, 'stills');
  fs.rmSync(dir, { recursive: true, force: true });
  const r = await engine(ws, ['--mode', 'stills', '--format', fmt, '--out', dir, '--width', fmt === 'horizontal' ? '960' : '540'], { minutes: 10 });
  const res = lastJson(r.out);
  if (!res?.stills?.length) return status(job, { status: 'error', error: `No storyboard frame could be drawn: ${tail((res?.errors || [r.out]).join(' | '), 400)}`, log: tail(r.out) });
  let notes = {};
  try { notes = JSON.parse(fs.readFileSync(path.join(ws, job.storyboard?.file || 'STORYBOARD.json'), 'utf8')); } catch { /* no notes */ }
  const panels = [];
  for (const [i, sc] of (job.storyboard?.scenes || []).entries()) {
    const still = res.stills.find(s => String(s.n) === String(sc.label));
    const t = (chk.scenes || []).find(s => String(s.n) === String(sc.label));
    if (!still || !fs.existsSync(still.file)) continue;
    const up = await upload(job, `frame/${i}`, still.file, 'image/jpeg');
    const note = (notes.panels || []).find(p => String(p.scene) === String(sc.label)) || {};
    if (up?.ok) panels.push({ scene: i, t: still.t, start: t?.start, end: t?.end, visual: note.visual || '', transition: note.transition || '', sounds: note.sounds || '' });
  }
  if (!panels.length) return status(job, { status: 'error', error: 'The storyboard frames couldn\'t be sent to the Hub.' });
  const done = await api(`/render-agent/jobs/${job.id}/storyboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ panels, assumptions: Array.isArray(notes.assumptions) ? notes.assumptions : [] }) }).catch(e => ({ ok: false, statusText: e.message }));
  if (!done.ok) return status(job, { status: 'error', error: `The storyboard couldn't be sent to the Hub (${done.status || ''} ${done.statusText || ''}).`, cost_usd: cost || undefined });
  say(`job ${job.id}: storyboard done (${panels.length} frames)`);
}

// Several jobs at once (RENDER_JOBS, 1–4): each worker asks the Hub for work. The Hub never hands out two
// jobs for the same script at once, so workers never share a work folder.
const SLOTS = Math.max(1, Math.min(4, Number(E.RENDER_JOBS || 1) || 1));
const current = new Set();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  say(`${sig}: stopping`);
  await Promise.all([...current].map(j => status(j, { status: 'error', error: 'The render helper was restarted while making this. Ask for it again.' })));
  process.exit(0);
});

async function worker(n) {
  await new Promise(z => setTimeout(z, n * 1500)); // don't all ask at the same moment
  for (;;) {
    let job = null;
    try {
      const r = await api(`/render-agent/next?machine=${encodeURIComponent(MACHINE)}&v=${VERSION}&slots=${SLOTS}`);
      if (r.status === 401) { say('The Hub refused RENDER_TOKEN. Check it matches the Hub\'s .env.'); await new Promise(z => setTimeout(z, 60000)); continue; }
      if (r.ok) job = (await r.json()).job;
    } catch (e) { if (n === 0) say('Hub not reachable:', e.message); }
    if (!job) { await new Promise(z => setTimeout(z, POLL)); continue; }
    current.add(job);
    say(`job ${job.id} (worker ${n + 1}): ${job.kind} ${job.scope}${job.scope === 'scene' ? ` ${job.sceneLabel}` : ''} of "${job.title}"`);
    try { await doJob(job); } catch (e) { say(`job ${job.id} failed:`, e.message); await status(job, { status: 'error', error: `The render helper hit an error: ${e.message}` }); }
    current.delete(job);
  }
}

say(`render helper ${VERSION} on ${MACHINE}: ${SLOTS} job${SLOTS === 1 ? '' : 's'} at once, work ${WORK}, Hub ${HUB}, nice ${NICE}`);
fs.mkdirSync(WORK, { recursive: true });
await Promise.all(Array.from({ length: SLOTS }, (_, n) => worker(n)));
