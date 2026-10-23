#!/usr/bin/env node
// The Marketing Hub's render helper. Runs on the render machine (Linux, next to the Remotion
// project), asks the Hub for the next video job, has Claude Code build or change the Remotion
// code for it, renders it, and sends the MP4 back to the Hub.
//
// It only makes outgoing calls to the Hub (HUB_URL) with RENDER_TOKEN, and one job runs at a time,
// at low priority, so other services on the machine (ChirpStack) keep running smoothly.
// No packages to install: Node 22 or newer is enough.
//
// Settings: render-agent.env next to this file (see render-agent.env.example).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.1';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(here, 'render-agent.env')]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const E = process.env;
const HUB = String(E.HUB_URL || '').replace(/\/$/, '');
const TOKEN = E.RENDER_TOKEN || '';
const PROJECT = E.REMOTION_DIR || path.join(os.homedir(), 'Desktop', 'marketing-hub');
const CONCURRENCY = Number(E.RENDER_CONCURRENCY || 2) || 2;
const NICE = String(Number(E.RENDER_NICE || 15) || 15);
const CLAUDE = E.CLAUDE_BIN || 'claude';
const POLL = (Number(E.POLL_SECONDS || 15) || 15) * 1000;
const MAX_TURNS = String(Number(E.CLAUDE_MAX_TURNS || 60) || 60);
const BUILD_MIN = Number(E.BUILD_TIMEOUT_MIN || 25) || 25;
const RENDER_MIN = Number(E.RENDER_TIMEOUT_MIN || 30) || 30;
const MACHINE = E.MACHINE_NAME || os.hostname();
// What Claude Code may do on this machine: edit the project, check compositions, add npm packages.
const ALLOWED = 'Read,Write,Edit,MultiEdit,Glob,Grep,LS,Bash(npx remotion:*),Bash(npm install:*),Bash(npx tsc:*),Bash(ls:*),Bash(cat:*)';

const say = (...a) => console.log(new Date().toISOString(), ...a);
if (!HUB || !TOKEN) { say('HUB_URL and RENDER_TOKEN must be set in render-agent.env'); process.exit(1); }
if (!fs.existsSync(path.join(PROJECT, 'package.json'))) { say(`No Remotion project at ${PROJECT} (set REMOTION_DIR)`); process.exit(1); }

const api = (p, opts = {}) => fetch(HUB + p, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 60000) });
async function status(job, body) {
  try { await api(`/render-agent/jobs/${job.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { say('status failed:', e.message); }
}

// Runs a command; keeps the Hub told it's alive; returns { code, out } (stdout+stderr, last 200 kB).
function run(cmd, args, { minutes, onLine, keepAlive } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd: PROJECT, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let out = '';
    const take = d => { const t = d.toString(); out = (out + t).slice(-200000); if (onLine) for (const l of t.split(/\r?\n/)) if (l.trim()) onLine(l.trim()); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const alive = keepAlive ? setInterval(keepAlive, 30000) : null;
    const timer = setTimeout(() => { out += `\n[stopped after ${minutes} minutes]`; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000); }, minutes * 60000);
    child.on('error', e => { out += `\n${e.message}`; });
    child.on('close', code => { clearTimeout(timer); if (alive) clearInterval(alive); resolve({ code, out }); });
  });
}
const tail = (t, n = 3000) => String(t || '').slice(-n);

// Is the composition in the project? `--quiet` prints only the IDs; older Remotion versions get the
// normal table instead. (The table is printed at the "info" log level, so never pass --log=error here.)
async function listed(id) {
  const has = out => out.split(/[\s│|,]+/).includes(id);
  const q = await run('npx', ['remotion', 'compositions', '--quiet'], { minutes: 6 });
  if (has(q.out)) return { ok: true, out: q.out };
  const full = await run('npx', ['remotion', 'compositions'], { minutes: 6 });
  return { ok: has(full.out), out: `${tail(q.out, 1500)}\n${tail(full.out, 3000)}` };
}

async function doJob(job) {
  const folder = path.join(PROJECT, job.folder);
  const outDir = path.join(PROJECT, 'out', 'hub');
  fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
  const what = job.scope === 'full' ? 'the whole video' : `scene ${job.sceneLabel}`;
  await status(job, { status: 'building', stage: 'Preparing the project' });

  // The brief, the style skill and its example frames, where the instructions say they are.
  fs.writeFileSync(path.join(folder, 'BRIEF.md'), job.brief);
  if (job.skill?.text) {
    const dir = path.join(PROJECT, '.claude', 'skills', job.skill.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), job.skill.text);
    if (job.skill.frames?.length && job.skill.id != null) {
      const fdir = path.join(folder, 'style-frames'); fs.mkdirSync(fdir, { recursive: true });
      for (const f of job.skill.frames) {
        const r = await api(`/render-agent/frames/${job.skill.id}/${f.id}`).catch(() => null);
        if (r?.ok) fs.writeFileSync(path.join(fdir, `frame-${f.id}.${f.mime === 'image/png' ? 'png' : f.mime === 'image/webp' ? 'webp' : 'jpg'}`), Buffer.from(await r.arrayBuffer()));
      }
    }
  }

  // 1. Claude Code writes or changes the code.
  await status(job, { status: 'building', stage: job.kind === 'change' ? `Claude is changing ${what}` : `Claude is building ${what}` });
  const keepAlive = stage => () => status(job, { stage });
  const c = await run(CLAUDE, ['-p', job.instructions, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED, '--disallowedTools', 'WebFetch,WebSearch', '--max-turns', MAX_TURNS],
    { minutes: BUILD_MIN, keepAlive: keepAlive(job.kind === 'change' ? `Claude is changing ${what}` : `Claude is building ${what}`) });
  let result = null;
  // The result is the last JSON line (anything printed to stderr comes before it).
  for (const line of c.out.split('\n').reverse()) { if (!line.trim().startsWith('{')) continue; try { result = JSON.parse(line); break; } catch { /* not this one */ } }
  if (!result) try { result = JSON.parse(c.out.slice(c.out.indexOf('{'))); } catch { /* not JSON */ }
  const cost = Number(result?.total_cost_usd);
  if (c.code !== 0 || !result || result.is_error) {
    const why = /login|auth|credential|sign in/i.test(c.out) ? 'Claude Code isn\'t signed in on the render machine (run `claude` there once and sign in).' : `Claude Code couldn't finish: ${tail(result?.result || c.out, 400)}`;
    return status(job, { status: 'error', error: why, log: tail(c.out), cost_usd: Number.isFinite(cost) ? cost : undefined });
  }
  await status(job, { status: 'building', stage: 'Checking the composition', log: tail(result.result, 2000), cost_usd: Number.isFinite(cost) ? cost : undefined });
  const list = await listed(job.composition);
  if (!list.ok) return status(job, { status: 'error', error: `Claude finished, but the composition ${job.composition} isn't in the project. Ask for it again.`, log: tail(`${result.result || ''}\n\n--- npx remotion compositions ---\n${list.out}`) });

  // 2. Render it, at low priority.
  const mp4 = path.join(outDir, `job-${job.id}.mp4`);
  const jpg = path.join(outDir, `job-${job.id}.jpg`);
  let last = 0;
  await status(job, { status: 'rendering', stage: `Rendering ${what}` });
  const r = await run('nice', ['-n', NICE, 'npx', 'remotion', 'render', job.composition, mp4, `--concurrency=${CONCURRENCY}`, '--log=info'], {
    minutes: RENDER_MIN,
    keepAlive: () => status(job, { stage: `Rendering ${what}${last ? ` · ${last}%` : ''}` }),
    onLine: l => { const m = l.match(/(\d+)\s*\/\s*(\d+)/); if (/render/i.test(l) && m && Number(m[2])) last = Math.round(100 * Number(m[1]) / Number(m[2])); },
  });
  if (r.code !== 0 || !fs.existsSync(mp4)) return status(job, { status: 'error', error: `The render failed: ${tail(r.out, 400)}`, log: tail(r.out) });
  const mid = Math.max(0, Math.floor((job.seconds || 2) * (job.fps || 30) / 2));
  await run('nice', ['-n', NICE, 'npx', 'remotion', 'still', job.composition, jpg, `--frame=${mid}`, '--image-format=jpeg', '--log=error'], { minutes: 5 });

  // 3. Send it to the Hub.
  await status(job, { status: 'rendering', stage: 'Sending the video to the Hub' });
  if (fs.existsSync(jpg)) await api(`/render-agent/jobs/${job.id}/poster`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: await fs.openAsBlob(jpg), timeout: 120000 }).catch(e => say('poster:', e.message));
  const up = await api(`/render-agent/jobs/${job.id}/video?seconds=${job.seconds || ''}`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: await fs.openAsBlob(mp4), timeout: 15 * 60000 }).catch(e => ({ ok: false, statusText: e.message }));
  for (const f of [mp4, jpg]) try { fs.unlinkSync(f); } catch { /* gone */ }
  if (!up.ok) return status(job, { status: 'error', error: `The video was made but couldn't be sent to the Hub (${up.status || ''} ${up.statusText || ''}).` });
  say(`job ${job.id}: ${what} done`);
}

let current = null;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  say(`${sig}: stopping`);
  if (current) await status(current, { status: 'error', error: 'The render helper was restarted while making this. Ask for it again.' });
  process.exit(0);
});

say(`render helper ${VERSION} on ${MACHINE}: project ${PROJECT}, Hub ${HUB}, concurrency ${CONCURRENCY}, nice ${NICE}`);
for (;;) {
  let job = null;
  try {
    const r = await api(`/render-agent/next?machine=${encodeURIComponent(MACHINE)}&v=${VERSION}`);
    if (r.status === 401) { say('The Hub refused RENDER_TOKEN. Check it matches the Hub\'s .env.'); await new Promise(z => setTimeout(z, 60000)); continue; }
    if (r.ok) job = (await r.json()).job;
  } catch (e) { say('Hub not reachable:', e.message); }
  if (!job) { await new Promise(z => setTimeout(z, POLL)); continue; }
  current = job;
  say(`job ${job.id}: ${job.kind} ${job.scope}${job.scope === 'scene' ? ` ${job.sceneLabel}` : ''} of "${job.title}"`);
  try { await doJob(job); } catch (e) { say(`job ${job.id} failed:`, e.message); await status(job, { status: 'error', error: `The render helper hit an error: ${e.message}` }); }
  current = null;
}
