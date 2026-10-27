#!/usr/bin/env node
// Cytron video engine — renderer. Zero npm dependencies: Node 22+, a Chromium, and ffmpeg.
//
//   node engine/render.mjs <workdir> --mode check   [--format vertical|horizontal]
//   node engine/render.mjs <workdir> --mode stills  --out <dir> [--width 540]
//   node engine/render.mjs <workdir> --mode video   --out <file.mp4> [--from s --to s] [--fps 30] [--no-subtitles] [--no-sound] [--poster <file.jpg>]
//   node engine/render.mjs <workdir> --mode bundle  --out <preview.html>
//
// <workdir> holds:  engine/ (this folder) · style.js (optional) · scenes/scene-<n>.js · video.js
//                   assets/ (photos, optional) · vo.json (optional: [{ "file": "media/vo-1.mp3", "start": 0, "gain": 1 }])
// Env: CHROMIUM_PATH (else chromium / chromium-browser / google-chrome on PATH), FFMPEG_PATH (else ffmpeg).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, extname, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ENGINE = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.json': 'application/json' };
const log = (...a) => console.error('[render]', ...a);

// ------------------------------------------------------------------ args
export function parseArgs(argv) {
  const o = { dir: null, mode: 'check', format: null, out: null, fps: null, from: null, to: null, width: 540, subtitles: true, sound: true, poster: null, quality: 0.9, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--mode') o.mode = v(); else if (a === '--format') o.format = v(); else if (a === '--out') o.out = v();
    else if (a === '--fps') o.fps = Number(v()); else if (a === '--from') o.from = Number(v()); else if (a === '--to') o.to = Number(v());
    else if (a === '--width') o.width = Number(v()); else if (a === '--no-subtitles') o.subtitles = false; else if (a === '--no-sound') o.sound = false;
    else if (a === '--poster') o.poster = v(); else if (a === '--quality') o.quality = Number(v()); else if (a === '--keep') o.keep = true;
    else if (!a.startsWith('--') && !o.dir) o.dir = a;
  }
  return o;
}

// ------------------------------------------------------------------ the page
const sceneFiles = dir => (existsSync(join(dir, 'scenes')) ? readdirSync(join(dir, 'scenes')).filter(f => /^scene-\d+\.js$/.test(f)).sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6))).map(f => `scenes/${f}`) : []);
const engineRel = () => 'engine'; // always served from this folder, wherever the workdir is
const fileOf = (dir, p) => (p.startsWith('engine/') ? join(ENGINE, p.slice(7)) : join(dir, p));
export function pageScripts(dir) {
  const e = engineRel(dir);
  return [`${e}/hm.js`, `${e}/sound.js`, ...(existsSync(join(dir, 'style.js')) ? ['style.js'] : []), ...sceneFiles(dir), 'video.js', `${e}/player.js`];
}
export function buildHtml(dir, format, title = 'Video preview') {
  const e = engineRel(dir);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title.replace(/[<&]/g, '')}</title>
<link rel="stylesheet" href="${e}/fonts.css"><link rel="stylesheet" href="${e}/player.css"></head>
<body><canvas id="cv"></canvas>
<script>window.HM_FORMAT = ${JSON.stringify(format || 'vertical')};</script>
${pageScripts(dir).map(s => `<script src="${s}"></script>`).join('\n')}
</body></html>`;
}
// One self-contained file (fonts, scripts and photos inlined) for the Hub's sandboxed preview.
export function bundleHtml(dir, format, { maxAssetBytes = 12e6 } = {}) {
  const fonts = readFileSync(join(ENGINE, 'fonts.css'), 'utf8').replace(/url\('fonts\/([^']+)'\)/g, (_, f) => `url(data:font/woff2;base64,${readFileSync(join(ENGINE, 'fonts', f)).toString('base64')})`);
  const css = readFileSync(join(ENGINE, 'player.css'), 'utf8');
  const assets = {}; let used = 0;
  for (const sub of ['assets', 'media']) {
    const root = join(dir, sub); if (!existsSync(root)) continue;
    for (const f of readdirSync(root)) {
      const ext = extname(f).toLowerCase(); if (!['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'].includes(ext)) continue;
      const b = readFileSync(join(root, f)); if (used + b.length > maxAssetBytes) continue; used += b.length;
      assets[`${sub}/${f}`] = `data:${TYPES[ext]};base64,${b.toString('base64')}`;
    }
  }
  const safe = s => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  const scripts = pageScripts(dir).map(p => `<script>${safe(readFileSync(fileOf(dir, p), 'utf8'))}</script>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Video preview</title>
<style>${fonts}\n${css}</style></head>
<body><canvas id="cv"></canvas>
<script>window.HM_FORMAT = ${JSON.stringify(format || 'vertical')}; window.HM_ASSETS = ${safe(JSON.stringify(assets))};</script>
${scripts.join('\n')}
</body></html>`;
}

// ------------------------------------------------------------------ a tiny static server (fonts don't load from file://)
function serve(dir, html) {
  const roots = [resolve(dir), resolve(ENGINE)];
  const srv = createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }); return res.end(html); }
    const file = url.startsWith('/engine/') ? resolve(ENGINE, '.' + url.slice(7)) : resolve(dir, '.' + url);
    if (!roots.some(r => file.startsWith(r + sep)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}

// ------------------------------------------------------------------ Chromium over the DevTools protocol
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // Google Chrome first; a snap-packaged Chromium (Ubuntu) can't see the temporary profile folder, so it's skipped.
  for (const c of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    try { const p = execFileSync('which', [c], { encoding: 'utf8' }).trim(); if (p && !/\/snap\//.test(execFileSync('readlink', ['-f', p], { encoding: 'utf8' }))) return p; } catch {}
  }
  throw new Error('No Chrome or Chromium found. Install Google Chrome (install.sh does it) or set CHROMIUM_PATH.');
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.wait = new Map(); this.listeners = []; ws.onmessage = e => this._msg(JSON.parse(e.data)); }
  _msg(m) {
    if (m.id && this.wait.has(m.id)) { const { ok, no } = this.wait.get(m.id); this.wait.delete(m.id); m.error ? no(new Error(`${m.error.message} ${m.error.data || ''}`)) : ok(m.result); }
    else if (m.method) for (const l of this.listeners) l(m);
  }
  send(method, params = {}, sessionId) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); return new Promise((ok, no) => this.wait.set(id, { ok, no })); }
}
export async function openBrowser() {
  const exe = findChromium(), profile = mkdtempSync(join(tmpdir(), 'hm-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--force-color-profile=srgb', '--autoplay-policy=no-user-gesture-required', 'about:blank'];
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((ok, no) => {
    let buf = ''; const to = setTimeout(() => no(new Error(`Chromium didn't start in 60s: ${buf.slice(-400)}`)), 60e3);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); ok(m[1]); } });
    proc.on('exit', c => { clearTimeout(to); no(new Error(`Chromium exited (${c}): ${buf.slice(-400)}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('could not connect to Chromium')); });
  const cdp = new CDP(ws);
  const close = () => { try { ws.close(); } catch {} try { proc.kill('SIGKILL'); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  return { cdp, close };
}
export async function openPage(cdp, url, W, H) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);
  const consoleErrors = [];
  cdp.listeners.push(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await S('Runtime.enable'); await S('Page.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await S('Page.navigate', { url });
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const t0 = Date.now();
  for (;;) {
    let ok = false; try { ok = await evaluate('window.HM_READY === true'); } catch {}
    if (ok) break;
    if (Date.now() - t0 > 90e3) throw new Error(`The page never got ready. ${consoleErrors.slice(0, 3).join(' | ')}`);
    await new Promise(r => setTimeout(r, 120));
  }
  return { evaluate, consoleErrors };
}

// ------------------------------------------------------------------ audio
function wav(pcm, sr = 48000, ch = 2) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function renderScore(page, duration, sr = 48000) {
  const bytes = await page.evaluate(`HMSound.offline(k => HM.score(k), ${duration}, ${sr}).then(b => { window.__pcm = HMSound.toPCM16(b); return window.__pcm.length; })`, true);
  const parts = [], CH = 3 << 20;
  for (let i = 0; i < bytes; i += CH) parts.push(Buffer.from(await page.evaluate(`HMSound.b64(window.__pcm, ${i}, ${Math.min(bytes, i + CH)})`), 'base64'));
  await page.evaluate('window.__pcm = null');
  return wav(Buffer.concat(parts), sr);
}

// ------------------------------------------------------------------ ffmpeg
function ffmpeg(args, { input = false } = {}) {
  const p = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', d => { err += d; });
  const done = new Promise((ok, no) => p.on('close', c => (c === 0 ? ok() : no(new Error(`ffmpeg failed (${c}): ${err.slice(-800)}`)))));
  return { p, done };
}
function readVo(dir) {
  const f = join(dir, 'vo.json'); if (!existsSync(f)) return [];
  try { return JSON.parse(readFileSync(f, 'utf8')).filter(v => v && v.file && existsSync(join(dir, v.file))); } catch { return []; }
}

// ------------------------------------------------------------------ the modes
export async function run(o) {
  const dir = resolve(o.dir || '.');
  if (!existsSync(join(dir, 'video.js'))) throw new Error(`${dir} has no video.js`);
  const format = o.format || 'vertical', W = format === 'horizontal' ? 1920 : 1080, H = format === 'horizontal' ? 1080 : 1920;
  if (o.mode === 'bundle') { const out = resolve(o.out || join(dir, 'preview.html')); writeFileSync(out, bundleHtml(dir, format)); return { ok: true, out, bytes: statSync(out).size }; }

  const { srv, port } = await serve(dir, buildHtml(dir, format));
  const browser = await openBrowser();
  try {
    const page = await openPage(browser.cdp, `http://127.0.0.1:${port}/index.html?render=1&format=${format}${o.subtitles ? '' : '&subtitles=0'}`, W, H);
    const info = await page.evaluate('HM.info()');
    if (!info.duration) throw new Error('video.js defines no scenes (HM.video({ scenes: [...] }))');

    if (o.mode === 'check') {
      const report = await page.evaluate('HM_CHECK()');
      report.errors = [...new Set([...(report.errors || []), ...page.consoleErrors])];
      if (report.missing?.length) report.errors.push(`scene files missing for: ${report.missing.join(', ')}`);
      report.ok = report.errors.length === 0;
      return report;
    }

    if (o.mode === 'stills') {
      const out = resolve(o.out || join(dir, 'stills')); mkdirSync(out, { recursive: true });
      const list = [];
      for (const s of info.scenes) {
        const at = await page.evaluate(`(() => { const d = HM.scenes.get(${Number(s.n)}); const k = d && d.still != null ? d.still : 0.62; return k <= 1 ? ${s.start} + (${s.end - s.start}) * k : ${s.start} + k; })()`);
        const t = Math.min(s.end - 0.02, Math.max(s.start, at));
        const file = join(out, `scene-${s.n}.jpg`);
        writeFileSync(file, Buffer.from(await page.evaluate(`HM_STILL(${t}, ${o.width || 540})`), 'base64'));
        list.push({ n: s.n, t: Number(t.toFixed(2)), file });
      }
      const errors = [...new Set([...(await page.evaluate('HM_ERRORS')), ...page.consoleErrors])];
      writeFileSync(join(out, 'stills.json'), JSON.stringify({ format, scenes: list, errors }, null, 2));
      return { ok: errors.length === 0, stills: list, errors };
    }

    if (o.mode === 'video') {
      const fps = o.fps || info.fps || 30, from = Math.max(0, o.from ?? 0), to = Math.min(info.duration, o.to ?? info.duration);
      if (!(to > from)) throw new Error(`empty range ${from}–${to}`);
      const out = resolve(o.out || join(dir, 'video.mp4')); mkdirSync(dirname(out), { recursive: true });
      const tmp = mkdtempSync(join(tmpdir(), 'hm-audio-'));
      try {
        const inputs = ['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0'];
        const vo = readVo(dir); let filter = null, amap = null;
        if (o.sound !== false) {
          const t0 = Date.now(); writeFileSync(join(tmp, 'score.wav'), await renderScore(page, info.duration)); log(`sound score in ${Date.now() - t0} ms`);
          inputs.push('-i', join(tmp, 'score.wav'));
          vo.forEach(v => inputs.push('-i', join(dir, v.file)));
          const trim = `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS`;
          if (!vo.length) filter = `[1:a]${trim},alimiter=limit=0.95[a]`;
          else {
            const parts = vo.map((v, i) => { const ms = Math.max(0, Math.round((Number(v.start) || 0) * 1000)); return `[${i + 2}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${Number(v.gain) || 1},adelay=${ms}|${ms}[v${i}]`; });
            filter = `${parts.join(';')};${vo.map((_, i) => `[v${i}]`).join('')}amix=inputs=${vo.length}:normalize=0:duration=longest,apad[vo];[vo]asplit=2[voa][vosc];[1:a][vosc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[duck];[duck][voa]amix=inputs=2:normalize=0:duration=first,${trim},alimiter=limit=0.95[a]`;
          }
          amap = '[a]';
        }
        const args = [...inputs, ...(filter ? ['-filter_complex', filter, '-map', '0:v', '-map', amap, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : ['-map', '0:v']),
          '-c:v', 'libx264', '-preset', process.env.HM_X264_PRESET || 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', String(to - from), '-movflags', '+faststart', out];
        const ff = ffmpeg(args, { input: true });
        const n = Math.max(1, Math.round((to - from) * fps)), t0 = Date.now();
        let lastLog = 0;
        for (let i = 0; i < n; i++) {
          const t = from + i / fps;
          const jpg = Buffer.from(await page.evaluate(`HM_FRAME(${t}, ${o.quality || 0.9})`), 'base64');
          if (!ff.p.stdin.write(jpg)) await new Promise(r => ff.p.stdin.once('drain', r));
          if (Date.now() - lastLog > 5000) { lastLog = Date.now(); log(`frame ${i + 1}/${n} (${((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1)} fps)`); }
        }
        ff.p.stdin.end(); await ff.done;
        if (o.poster) {
          // The poster is a frame of what was rendered: the video's poster time when it falls inside the
          // range, otherwise the first scene's storyboard moment (its still:), so it matches the video.
          const pt = await page.evaluate(`(() => { const a = ${from}, b = ${to}, i = HM.info(); if (i.poster != null && i.poster >= a && i.poster < b) return i.poster; const sc = i.scenes.find(s => a >= s.start - 1e-6 && a < s.end) || i.scenes[0]; const d = HM.scenes.get(Number(sc.n)); const k = d && d.still != null ? d.still : 0.62; const t = k <= 1 ? sc.start + (sc.end - sc.start) * k : sc.start + k; return Math.min(b - 0.05, Math.max(a, t)); })()`);
          writeFileSync(resolve(o.poster), Buffer.from(await page.evaluate(`HM_FRAME(${pt}, 0.88)`), 'base64'));
        }
        const errors = [...new Set([...(await page.evaluate('HM_ERRORS')), ...page.consoleErrors])];
        log(`${n} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${out}`);
        return { ok: errors.length === 0, out, frames: n, seconds: Number((to - from).toFixed(2)), errors, format };
      } finally { if (!o.keep) rmSync(tmp, { recursive: true, force: true }); }
    }
    throw new Error(`unknown mode ${o.mode}`);
  } finally { browser.close(); srv.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  run(o).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok === false ? 2 : 0); })
    .catch(e => { console.log(JSON.stringify({ ok: false, errors: [String(e.message || e)] }, null, 2)); process.exit(1); });
}
