// HM: the Hub's motion-graphics engine for canvas videos (Cytron Marketing Hub).
//
// A video is plain JavaScript drawn on one <canvas>: every frame is a pure function of time t, so
// the same t always gives the same picture, and the video can be rendered frame by frame.
//
//   HM.scene({ n: 1, draw(ctx, f) {…}, sound(k, f) {…} })    one file per scene (scenes/scene-1.js …)
//   HM.video({ scenes: [{ n: 1, start: 0, end: 3.5 }, …], transitions: { 2: { type: 'circle', dur: 0.8 } },
//              background(ctx, f), overlay(ctx, f), sound(k), subtitles: [{ start, end, text }] })   video.js
//
// f (the frame): { W, H, t (seconds, whole video), u (seconds into this scene), d (scene length),
//                  p (u / d, 0..1), n (scene number), fmt ('vertical' | 'horizontal'), safe (rectangle), s (scale) }
// Scene sound: k.play('pop', 0.4) inside a scene is 0.4 s after that scene starts.
(function () {
  'use strict';
  const HM = (window.HM = window.HM || {});
  HM.version = '1.0.0';

  // ---------------------------------------------------------------- format
  // Vertical 1080×1920 (TikTok, Reels, Shorts) or horizontal 1920×1080 (YouTube, LinkedIn).
  const q = new URLSearchParams(location.search);
  HM.fmt = (q.get('format') || window.HM_FORMAT || 'vertical') === 'horizontal' ? 'horizontal' : 'vertical';
  HM.W = HM.fmt === 'vertical' ? 1080 : 1920;
  HM.H = HM.fmt === 'vertical' ? 1920 : 1080;
  // s: 1 unit = 1 px on the short side of 1080. Draw sizes as n * f.s so both formats read the same.
  HM.s = 1;
  // Safe zones. Vertical: the platform overlays (top bar, caption and buttons at the bottom, action
  // rail on the right) leave x 140–840, y 260–1050 for everything essential; subtitles go in the
  // box below it; 1050–1280 is decoration only. Horizontal: 96 px margins, subtitles at the bottom.
  HM.SAFE = HM.fmt === 'vertical'
    ? { x0: 140, x1: 840, y0: 260, y1: 1050, cx: 490, cy: 655, sub: { x: 140, y: 1100, w: 680, h: 140 }, freeBelow: 1280 }
    : { x0: 96, x1: 1824, y0: 80, y1: 900, cx: 960, cy: 490, sub: { x: 360, y: 920, w: 1200, h: 110 }, freeBelow: 1040 };

  // ---------------------------------------------------------------- seeded randomness and noise
  // HM.rng(seed) → r() in [0, 1) with r.range(a, b), r.int(a, b), r.pick(list), r.chance(p), r.gauss()
  const strSeed = s => { let h = 2166136261 >>> 0; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  HM.rng = function (seed = 1) {
    let a = (typeof seed === 'number' ? seed : strSeed(seed)) >>> 0 || 0x9e3779b9;
    const r = () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    r.range = (lo, hi) => lo + (hi - lo) * r();
    r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    r.pick = list => list[Math.floor(r() * list.length)];
    r.chance = p => r() < p;
    r.gauss = () => { const u = Math.max(1e-9, r()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
    return r;
  };
  // HM.noise(seed) → { n2(x, y), fbm(x, y, octaves) } smooth value noise, roughly -1..1
  HM.noise = function (seed = 1) {
    const r = HM.rng(seed); const T = new Float32Array(1024); for (let i = 0; i < 1024; i++) T[i] = r() * 2 - 1;
    const h = (x, y) => T[((x * 374761393 + y * 668265263) >>> 0) % 1024];
    const sm = v => v * v * (3 - 2 * v);
    const n2 = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi); const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1); return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf; };
    const fbm = (x, y, oct = 4) => { let s = 0, amp = 0.5, fr = 1, norm = 0; for (let i = 0; i < oct; i++) { s += amp * n2(x * fr, y * fr); norm += amp; amp *= 0.5; fr *= 2; } return s / norm; };
    return { n2, fbm };
  };

  // ---------------------------------------------------------------- maths and easing
  HM.clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
  HM.lerp = (a, b, k) => a + (b - a) * k;
  HM.map = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
  HM.smooth = (a, b, v) => { const k = HM.clamp((v - a) / (b - a)); return k * k * (3 - 2 * k); };
  HM.ease = {
    out: k => 1 - Math.pow(1 - k, 3),
    in: k => k * k * k,
    inOut: k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    back: k => { const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }, // springy overshoot
    elastic: k => (k <= 0 ? 0 : k >= 1 ? 1 : Math.pow(2, -9 * k) * Math.sin((k * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
  };
  // Progress helpers on a clock u: ph(u, a, b) 0→1 between a and b; on(u, a, d, ease) eased over d seconds from a;
  // win(u, a, b, fade) fades in at a and out ending at b.
  HM.ph = (u, a, b) => HM.clamp((u - a) / (b - a));
  HM.on = (u, a, d = 0.5, e = HM.ease.out) => e(HM.clamp((u - a) / d));
  HM.win = (u, a, b, fade = 0.35) => Math.min(HM.on(u, a, fade), 1 - HM.on(u, b - fade, fade, k => k));

  // ---------------------------------------------------------------- colour
  HM.hex = c => { if (Array.isArray(c)) return c; let h = String(c).replace('#', ''); if (h.length === 3) h = h.replace(/./g, x => x + x); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  HM.mix = (a, b, k) => { const x = HM.hex(a), y = HM.hex(b); return [0, 1, 2].map(i => x[i] + (y[i] - x[i]) * k); };
  HM.rgba = (c, al = 1) => { const [r, g, b] = HM.hex(c); return `rgba(${r | 0},${g | 0},${b | 0},${al})`; };
  // Three-tone face shading for isometric solids: top light, left base, right in shadow.
  HM.shade = (base, shadow = '#3c3a6e', k = 1) => ({ top: HM.rgba(HM.mix(base, '#ffffff', 0.38 * k)), left: HM.rgba(base), right: HM.rgba(HM.mix(base, shadow, 0.3 * k)), edge: HM.rgba(HM.mix(base, '#ffffff', 0.7), 0.85) });

  // ---------------------------------------------------------------- canvas helpers
  HM.layer = (w = HM.W, h = HM.H) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  HM.poly = (ctx, pts, fill, stroke, lw = 1) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); } };
  HM.rrect = (ctx, x, y, w, h, r, fill, stroke, lw = 1) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); } };
  HM.font = (weight, px, family = 'Inter') => `${weight} ${Math.round(px)}px "${family}", "DM Sans", system-ui, sans-serif`;
  HM.mono = (weight, px) => `${weight} ${Math.round(px)}px "IBM Plex Mono", ui-monospace, Consolas, monospace`;
  // Wrap text to a width; returns lines. Text helpers measure with the current ctx.font.
  HM.wrap = (ctx, text, maxW) => { const out = []; for (const para of String(text).split('\n')) { let line = ''; for (const w of para.split(/\s+/)) { const tryL = line ? `${line} ${w}` : w; if (ctx.measureText(tryL).width > maxW && line) { out.push(line); line = w; } else line = tryL; } out.push(line); } return out; };
  // Largest font size (≤ max, ≥ min) at which text fits in maxW on at most `lines` lines.
  HM.fit = (ctx, text, maxW, max, min, lines = 2, weight = 800, family = 'Inter') => { for (let px = max; px >= min; px -= 2) { ctx.font = HM.font(weight, px, family); if (HM.wrap(ctx, text, maxW).length <= lines) return px; } return min; };

  // Headline: lines rise in one after another. lines: ['text', { text, color, size }], at: start (s, scene clock u).
  HM.headline = (ctx, f, lines, { x = f.safe.x0, y = f.safe.y0 + 8, size = f.fmt === 'vertical' ? 64 : 72, color = '#f2f3f5', weight = 800, family = 'Inter', at = 0.1, stagger = 0.18, align = 'left', u = f.u, out = null, lh = 1.1, maxW = f.safe.x1 - f.safe.x0 } = {}) => {
    ctx.save(); ctx.textBaseline = 'top'; ctx.textAlign = align;
    let yy = y;
    lines.forEach((l, i) => {
      if (typeof l === 'string') l = { text: l };
      const k = HM.on(u, at + i * stagger, 0.45) * (out == null ? 1 : 1 - HM.on(u, out, 0.3, k2 => k2));
      ctx.font = HM.font(l.weight || weight, l.size || size, l.family || family);
      for (const w of HM.wrap(ctx, l.text, maxW)) {
        ctx.globalAlpha = k; ctx.fillStyle = l.color || color;
        ctx.fillText(w, x, yy + (1 - k) * 18);
        yy += (l.size || size) * lh;
      }
    });
    ctx.restore();
    return yy;
  };
  // Pill tag (label, chip): centred at x, y (anchor 'left' puts its left edge at x); k scales it in (use HM.ease.back for a pop).
  HM.tag = (ctx, x, y, text, { k = 1, size = 28, weight = 700, bg = '#ffffff', color = '#1d2033', dot = null, family = 'Inter', shadow = 'rgba(20,20,60,0.25)', border = null, pad = 0.7, anchor = 'center' } = {}) => {
    if (k <= 0.01) return;
    ctx.save(); ctx.font = HM.font(weight, size, family);
    const w = ctx.measureText(text).width + size * (dot ? 2.2 : pad * 2), h = size * 1.75;
    ctx.translate(anchor === 'left' ? x + w / 2 : anchor === 'right' ? x - w / 2 : x, y); ctx.scale(k, k);
    if (shadow) { ctx.shadowColor = shadow; ctx.shadowBlur = size * 0.6; ctx.shadowOffsetY = size * 0.15; }
    HM.rrect(ctx, -w / 2, -h / 2, w, h, h / 2, bg); ctx.shadowColor = 'transparent';
    if (border) { ctx.strokeStyle = border; ctx.lineWidth = 2; ctx.stroke(); }
    if (dot) { ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(-w / 2 + size * 0.75, 0, size * 0.22, 0, 7); ctx.fill(); }
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, dot ? size * 0.45 : 0, size * 0.04);
    ctx.restore();
  };
  // Arrow drawn on along a quadratic curve a → c (control) → b, up to progress k. Returns the curve function.
  HM.arrow = (ctx, a, c, b, k, { color = '#0fa6dd', width = 4, dash = null, head = 14 } = {}) => {
    const qf = v => [(1 - v) * (1 - v) * a[0] + 2 * v * (1 - v) * c[0] + v * v * b[0], (1 - v) * (1 - v) * a[1] + 2 * v * (1 - v) * c[1] + v * v * b[1]];
    if (k <= 0) return qf;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); for (let i = 1; i <= 36; i++) { const p = qf(k * i / 36); ctx.lineTo(p[0], p[1]); } ctx.stroke(); ctx.setLineDash([]);
    const e = qf(k), e0 = qf(Math.max(0, k - 0.03)), ang = Math.atan2(e[1] - e0[1], e[0] - e0[0]);
    ctx.translate(e[0], e[1]); ctx.rotate(ang); ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(head * 0.5, 0); ctx.lineTo(-head, -head * 0.6); ctx.lineTo(-head, head * 0.6); ctx.closePath(); ctx.fill();
    ctx.restore(); return qf;
  };
  // Number with thousands separators; counter(u, a, b, from, to) eases a value between two times.
  HM.num = (v, dec = 0) => Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  HM.counter = (u, a, b, from, to, e = HM.ease.out) => HM.lerp(from, to, e(HM.ph(u, a, b)));

  // ---------------------------------------------------------------- isometric helpers
  // HM.iso(ox, oy, s) → P(x, y, z) world units to screen px (true 30° projection, s px per unit).
  const C30 = Math.cos(Math.PI / 6);
  HM.iso = (ox, oy, s) => (x, y, z = 0) => [ox + (x - y) * C30 * s, oy + (x + y) * 0.5 * s - z * s];
  // A box with three shaded faces (+ optional light edges). c from HM.shade().
  HM.box = (ctx, P, x, y, z, w, d, h, c, edges = true) => {
    HM.poly(ctx, [P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)], c.right);
    HM.poly(ctx, [P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)], c.left);
    HM.poly(ctx, [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)], c.top);
    if (edges) { ctx.save(); ctx.strokeStyle = c.edge; ctx.lineWidth = 1.2; ctx.lineJoin = 'round'; ctx.beginPath(); const A = P(x, y + d, z + h), B = P(x + w, y + d, z + h), C = P(x + w, y, z + h), D = P(x + w, y + d, z); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.moveTo(B[0], B[1]); ctx.lineTo(D[0], D[1]); ctx.stroke(); ctx.restore(); }
  };
  // Draw on a face plane: HM.onWall(ctx, P(x, y+d, z)) maps 2D drawing onto the +y (front-left) wall; onFloor onto the floor.
  HM.onWall = (ctx, p, s = 1) => ctx.transform(C30 * s, 0.5 * s, 0, s, p[0], p[1]);
  HM.onRightWall = (ctx, p, s = 1) => ctx.transform(C30 * s, -0.5 * s, 0, s, p[0], p[1]);
  HM.onFloor = (ctx, p, s = 1) => ctx.transform(C30 * s, 0.5 * s, -C30 * s, 0.5 * s, p[0], p[1]);

  // ---------------------------------------------------------------- finishing passes (cached, fast)
  const cache = new Map();
  const cached = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };
  // Film grain from a pre-made noise tile, offset per frame (deterministic). amount ≈ 0.03–0.12.
  HM.grain = (ctx, t, amount = 0.06, seed = 7, mono = true) => {
    const tile = cached(`grain:${seed}:${mono}`, () => { const c = HM.layer(256, 256), g = c.getContext('2d'), im = g.createImageData(256, 256), r = HM.rng(seed); for (let i = 0; i < im.data.length; i += 4) { const v = r() * 255; im.data[i] = mono ? v : r() * 255; im.data[i + 1] = mono ? v : r() * 255; im.data[i + 2] = mono ? v : r() * 255; im.data[i + 3] = 255; } g.putImageData(im, 0, 0); return c; });
    const fr = Math.floor(t * 24), r = HM.rng(fr + seed * 31);
    ctx.save(); ctx.globalAlpha = amount; ctx.globalCompositeOperation = 'overlay';
    const ox = -r.int(0, 255), oy = -r.int(0, 255);
    for (let y = oy; y < HM.H; y += 256) for (let x = ox; x < HM.W; x += 256) ctx.drawImage(tile, x, y);
    ctx.restore();
  };
  HM.vignette = (ctx, strength = 0.45, color = '0,0,0') => { const g = ctx.createRadialGradient(HM.W / 2, HM.H / 2, Math.min(HM.W, HM.H) * 0.3, HM.W / 2, HM.H / 2, Math.hypot(HM.W, HM.H) * 0.6); g.addColorStop(0, `rgba(${color},0)`); g.addColorStop(1, `rgba(${color},${strength})`); ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, HM.W, HM.H); ctx.restore(); };
  // Paper texture (cached once per base colour).
  HM.paper = (ctx, base = '#f3ecdc', seed = 3, strength = 0.05) => {
    const c = cached(`paper:${base}:${seed}:${strength}:${HM.W}`, () => { const L = HM.layer(), g = L.getContext('2d'), nz = HM.noise(seed), [br, bgc, bb] = HM.hex(base); g.fillStyle = base; g.fillRect(0, 0, HM.W, HM.H); for (let y = 0; y < HM.H; y += 4) for (let x = 0; x < HM.W; x += 4) { const v = nz.fbm(x * 0.012, y * 0.012, 3) * 0.7 + nz.n2(x * 0.2, y * 0.05) * 0.3, k = 1 + v * strength * 2; g.fillStyle = `rgb(${br * k | 0},${bgc * k | 0},${bb * k | 0})`; g.fillRect(x, y, 4, 4); } return L; });
    ctx.drawImage(c, 0, 0);
  };
  HM.dots = (ctx, color = 'rgba(255,255,255,0.06)', gap = 32, size = 2) => { ctx.save(); ctx.fillStyle = color; for (let y = gap / 2; y < HM.H; y += gap) for (let x = gap / 2 + ((y / gap) % 2) * gap / 2; x < HM.W; x += gap) ctx.fillRect(x, y, size, size); ctx.restore(); };
  HM.glow = (ctx, x, y, r, color, al = 0.35) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, HM.rgba(color, al)); g.addColorStop(1, HM.rgba(color, 0)); ctx.save(); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.restore(); };

  // Images placed by the person (public/… in the brief): HM.image('refs/ref-12.jpg') → loaded <img> or null.
  const imgs = new Map();
  HM.image = src => { const im = imgs.get(src); return im && im.complete && im.naturalWidth ? im : null; };
  HM.preload = (...srcs) => srcs.forEach(src => { if (!imgs.has(src)) { const im = new Image(); im.src = (window.HM_ASSETS || {})[src] || src; imgs.set(src, im); } });
  HM.imagesReady = () => Promise.all([...imgs.values()].map(im => (im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))));

  // ---------------------------------------------------------------- subtitles (burned in, optional)
  HM.subtitle = (ctx, f, text, k = 1, { size = f.fmt === 'vertical' ? 46 : 44, color = '#ffffff', box = true } = {}) => {
    if (!text || k <= 0.01) return;
    const S = f.safe.sub; ctx.save(); ctx.globalAlpha = k; ctx.font = HM.font(700, size); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = HM.wrap(ctx, text, S.w).slice(0, 2), lh = size * 1.22, top = S.y + S.h / 2 - (lines.length * lh) / 2 + lh / 2;
    if (box) { const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + size; HM.rrect(ctx, S.x + S.w / 2 - w / 2, top - lh / 2 - size * 0.25, w, lines.length * lh + size * 0.5, size * 0.4, 'rgba(10,12,16,0.72)'); }
    ctx.fillStyle = color; ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 8;
    lines.forEach((l, i) => ctx.fillText(l, S.x + S.w / 2, top + i * lh));
    ctx.restore();
  };

  // ---------------------------------------------------------------- scenes and the timeline
  const SCENES = new Map();
  HM.scene = def => { SCENES.set(Number(def.n), def); };
  HM.scenes = SCENES;
  let V = null;
  HM.video = def => {
    V = { fps: 30, transitions: {}, subtitles: [], ...def };
    V.scenes = V.scenes.map(s => ({ ...s, d: s.end - s.start }));
    window.DURATION = V.scenes.length ? V.scenes[V.scenes.length - 1].end : 0;
  };
  const frameOf = (t, sc) => ({ W: HM.W, H: HM.H, t, u: t - sc.start, d: sc.d, p: HM.clamp((t - sc.start) / sc.d), n: sc.n, fmt: HM.fmt, safe: HM.SAFE, s: HM.s, start: sc.start, end: sc.end });
  const drawScene = (ctx, sc, t) => {
    const def = SCENES.get(Number(sc.n));
    if (!def) { ctx.fillStyle = '#1b1d24'; ctx.fillRect(0, 0, HM.W, HM.H); ctx.fillStyle = '#ff6b5b'; ctx.font = HM.font(700, 40); ctx.fillText(`Scene ${sc.n} is missing`, 80, 160); return; }
    ctx.save(); def.draw(ctx, frameOf(t, sc)); ctx.restore();
  };
  // Transitions into scene n (from n-1): crossfade, circle (opens from cx, cy), wipe, push, zoom, cut.
  const L1 = () => (HM._L1 = HM._L1 || HM.layer()), L2 = () => (HM._L2 = HM._L2 || HM.layer());
  HM.draw = function (ctx, t) {
    if (!V) return;
    t = HM.clamp(t, 0, Math.max(0, window.DURATION - 1e-6));
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    let i = V.scenes.findIndex(s => t >= s.start && t < s.end); if (i < 0) i = V.scenes.length - 1;
    const sc = V.scenes[i], prev = V.scenes[i - 1], tr = V.transitions[sc.n] || null;
    if (V.background) { ctx.save(); V.background(ctx, frameOf(t, sc)); ctx.restore(); }
    const k = prev && tr && tr.type !== 'cut' ? HM.clamp((t - sc.start) / (tr.dur || 0.6)) : 1;
    if (k >= 1) drawScene(ctx, sc, t);
    else {
      const a = L1(), b = L2(), ca = a.getContext('2d'), cb = b.getContext('2d');
      ca.setTransform(1, 0, 0, 1, 0, 0); ca.clearRect(0, 0, HM.W, HM.H); drawScene(ca, prev, Math.min(t, prev.end - 1e-3) + 0);
      cb.setTransform(1, 0, 0, 1, 0, 0); cb.clearRect(0, 0, HM.W, HM.H); drawScene(cb, sc, t);
      const e = HM.ease.inOut(k);
      ctx.drawImage(a, 0, 0);
      ctx.save();
      if (tr.type === 'circle') { const cx = tr.x ?? HM.W / 2, cy = tr.y ?? HM.H / 2; ctx.beginPath(); ctx.arc(cx, cy, e * Math.hypot(HM.W, HM.H), 0, 7); ctx.clip(); ctx.drawImage(b, 0, 0); }
      else if (tr.type === 'wipe') { ctx.beginPath(); ctx.rect(0, 0, HM.W * e, HM.H); ctx.clip(); ctx.drawImage(b, 0, 0); }
      else if (tr.type === 'push') { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, HM.W, HM.H); const dx = (tr.dir === 'up' ? 0 : HM.W), dy = (tr.dir === 'up' ? HM.H : 0); ctx.drawImage(a, -dx * e, -dy * e); ctx.drawImage(b, dx * (1 - e), dy * (1 - e)); }
      else if (tr.type === 'zoom') { ctx.globalAlpha = e; const z = 1.15 - 0.15 * e; ctx.translate(HM.W / 2, HM.H / 2); ctx.scale(z, z); ctx.translate(-HM.W / 2, -HM.H / 2); ctx.drawImage(b, 0, 0); }
      else { ctx.globalAlpha = e; ctx.drawImage(b, 0, 0); }
      ctx.restore();
    }
    if (V.overlay) { ctx.save(); V.overlay(ctx, frameOf(t, sc)); ctx.restore(); }
    if (window.HM_SUBTITLES !== false) for (const s of V.subtitles || []) if (t >= s.start && t < s.end) HM.subtitle(ctx, frameOf(t, sc), s.text, HM.win(t, s.start, s.end, 0.15));
  };
  // The whole sound score: the video's own (beds, music) plus each scene's, shifted to its start.
  HM.score = function (k) {
    if (!V) return;
    if (V.sound) V.sound(k);
    for (const sc of V.scenes) {
      const def = SCENES.get(Number(sc.n)); if (!def?.sound) continue;
      const sh = { ...k, play: (name, t, o) => k.play(name, sc.start + t, o), tone: (t, o) => k.tone(sc.start + t, o), noise: (t, o) => k.noise(sc.start + t, o), bed: (name, a, b, o) => k.bed(name, sc.start + a, sc.start + b, o), withMinor: k.withMinor };
      def.sound(sh, frameOf(sc.start, sc));
    }
  };
  HM.timeline = () => (V ? V.scenes.map(s => ({ n: s.n, start: s.start, end: s.end })) : []);
  HM.info = () => ({ format: HM.fmt, W: HM.W, H: HM.H, fps: V?.fps || 30, duration: window.DURATION || 0, scenes: HM.timeline(), missing: V ? V.scenes.filter(s => !SCENES.has(Number(s.n))).map(s => s.n) : [], poster: V && V.poster != null ? V.poster : null, title: V?.title || '' });
})();
