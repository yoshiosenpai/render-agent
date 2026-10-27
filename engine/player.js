/* Cytron video engine — the player. Loads last, after hm.js, sound.js, style.js, scenes/*.js and video.js.
 * In a browser it is a preview with controls; with ?render=1 it is a bare canvas the renderer drives:
 *   window.HM_READY (bool), window.HM_ERRORS (list), window.seek(t), window.HM_FRAME(t, q) -> JPEG base64,
 *   window.HM_STILL(t, width, q) -> JPEG base64, window.HM_CHECK() -> report, window.DURATION.
 */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const RENDER = q.has('render');
  const errors = (window.HM_ERRORS = window.HM_ERRORS || []);
  const note = (where, e) => { const m = `${where}: ${(e && (e.stack || e.message)) || e}`; if (!errors.includes(m)) errors.push(m); };
  window.addEventListener('error', e => note('script', e.error || e.message));
  if (q.get('subtitles') === '0') window.HM_SUBTITLES = false;

  const cv = document.getElementById('cv');
  cv.width = HM.W; cv.height = HM.H;
  const ctx = cv.getContext('2d', { alpha: false });
  document.body.dataset.format = HM.fmt;
  document.body.classList.toggle('render', RENDER);

  function frame(t) {
    try { HM.draw(ctx, t); }
    catch (e) {
      note(`draw at ${t.toFixed(2)}s`, e);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#2a1414'; ctx.fillRect(0, 0, HM.W, HM.H);
      ctx.fillStyle = '#ff8a7a'; ctx.font = HM.font(700, 36); ctx.fillText(`Error at ${t.toFixed(2)}s — ${String(e.message || e).slice(0, 60)}`, 60, 140);
    }
  }

  // ---- renderer hooks
  window.HM_FRAME = (t, quality = 0.9) => { frame(t); return cv.toDataURL('image/jpeg', quality).slice(23); };
  const small = document.createElement('canvas');
  window.HM_STILL = (t, width = 540, quality = 0.86) => {
    frame(t);
    small.width = width; small.height = Math.round((width * HM.H) / HM.W);
    const c = small.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(cv, 0, 0, small.width, small.height);
    return small.toDataURL('image/jpeg', quality).slice(23);
  };
  // A quick self-check: every scene exists, draws without throwing, isn't blank, and keeps its text on the canvas.
  window.HM_CHECK = () => {
    const info = HM.info(), warn = [], offText = new Map(), notesDrawn = new Set();
    const P = CanvasRenderingContext2D.prototype, orig = P.fillText;
    P.fillText = function (txt, x, y, mw) {
      try {
        if (this === ctx || this.canvas.width === HM.W) {
          const m = this.measureText(String(txt)), w = mw ? Math.min(mw, m.width) : m.width, a = this.textAlign;
          const x0 = a === 'center' ? x - w / 2 : a === 'right' || a === 'end' ? x - w : x, T = this.getTransform();
          const pts = [[x0, y - m.actualBoundingBoxAscent], [x0 + w, y + m.actualBoundingBoxDescent]].map(([px, py]) => [T.a * px + T.c * py + T.e, T.b * px + T.d * py + T.f]);
          const out = pts.some(([px, py]) => px < -6 || px > HM.W + 6 || py < -6 || py > HM.H + 6);
          if (/\[\s*(?:SEMAK|CHECK|VERIFY|TBD|TODO|TBC)\b|\bTBD\b|placeholder/i.test(String(txt))) notesDrawn.add(String(txt).slice(0, 60));
          if (out && String(txt).trim().length > 1 && this.globalAlpha > 0.2) offText.set(String(txt).slice(0, 40), (offText.get(String(txt).slice(0, 40)) || 0) + 1);
        }
      } catch {}
      return orig.apply(this, arguments);
    };
    const probe = document.createElement('canvas'); probe.width = 48; probe.height = Math.round((48 * HM.H) / HM.W);
    const pc = probe.getContext('2d', { willReadFrequently: true });
    const samples = [];
    for (const s of info.scenes) for (const k of [0.05, 0.5, 0.95]) samples.push({ n: s.n, t: s.start + (s.end - s.start) * k });
    for (const s of samples) {
      const before = errors.length; frame(s.t);
      if (errors.length > before) continue;
      pc.drawImage(cv, 0, 0, probe.width, probe.height);
      const d = pc.getImageData(0, 0, probe.width, probe.height).data; let mn = 255, mx = 0;
      for (let i = 0; i < d.length; i += 4) { const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; if (l < mn) mn = l; if (l > mx) mx = l; }
      if (mx - mn < 6 && s.t - info.scenes.find(x => x.n === s.n).start > 0.3) warn.push(`scene ${s.n} looks blank at ${s.t.toFixed(2)}s`);
    }
    P.fillText = orig;
    for (const [txt, c] of offText) warn.push(`text runs off the canvas: "${txt}" (${c}×)`);
    for (const txt of notesDrawn) note('editor note drawn', `"${txt}" is a note for the editor ([SEMAK], [check], TBD…), not video text. Leave it out.`);
    let sound = null;
    try { const names = new Set(); HM.score({ play: n => names.add(n), tone() {}, noise() {}, bed: n => names.add(`bed:${n}`) }); sound = [...names]; const bad = sound.filter(n => !(n.startsWith('bed:') ? HMSound.BEDS.includes(n.slice(4)) : HMSound.NAMES.includes(n))); if (bad.length) warn.push(`unknown sounds: ${bad.join(', ')}`); }
    catch (e) { note('sound score', e); }
    return { ...info, errors: [...errors], warnings: warn, sounds: sound };
  };

  // ---- ready: fonts (canvas never triggers a font load by itself), images, first frame
  const ready = async () => {
    try { await Promise.all([...document.fonts].map(f => f.load().catch(() => null))); await document.fonts.ready; } catch {}
    try { await HM.imagesReady(); } catch {}
    frame(0); window.HM_READY = true; if (!RENDER) { ui(); if (q.has('autoplay')) toggle(); }
  };

  // ---- the preview controls
  let t = 0, playing = false, last = 0, snd = null, soundOn = q.get('sound') !== '0';
  const bar = document.createElement('div'); bar.className = 'bar';
  if (!RENDER) {
    bar.innerHTML = '<button class="b play" title="Play (space)">▶</button><input class="scrub" type="range" min="0" step="0.01" value="0"><span class="time">0.0s</span><button class="b snd" title="Sound">Sound</button><button class="b sub" title="Subtitles">CC</button><span class="chips"></span>';
    document.body.appendChild(bar);
  }
  const $ = s => bar.querySelector(s);
  const fmt = x => `${x.toFixed(1)}s`;
  function ui() {
    if (RENDER) return;
    const sc = $('.scrub'); sc.max = String(window.DURATION || 0); sc.value = String(t);
    $('.time').textContent = `${fmt(t)} / ${fmt(window.DURATION || 0)}`;
    $('.play').textContent = playing ? '❚❚' : '▶';
    $('.snd').classList.toggle('off', !soundOn);
    $('.sub').classList.toggle('off', window.HM_SUBTITLES === false);
    const chips = $('.chips');
    if (!chips.childElementCount) for (const s of HM.timeline()) { const b = document.createElement('button'); b.className = 'chip'; b.textContent = String(s.n); b.title = `Scene ${s.n} · ${fmt(s.start)}–${fmt(s.end)}`; b.onclick = () => window.seek(s.start + 0.001); chips.appendChild(b); }
    for (const b of chips.children) { const s = HM.timeline().find(x => String(x.n) === b.textContent); b.classList.toggle('on', !!s && t >= s.start && t < s.end); }
  }
  const stopSound = () => { if (snd) { snd.stop(); snd = null; } };
  const startSound = () => { stopSound(); if (soundOn && playing) snd = HMSound.live(k => HM.score(k), t); };
  function tick(now) {
    if (!playing) return;
    t += Math.min(0.1, (now - last) / 1000); last = now;
    if (t >= (window.DURATION || 0)) { t = 0; startSound(); }
    frame(t); ui(); requestAnimationFrame(tick);
  }
  function toggle() { playing = !playing; if (playing) { last = performance.now(); startSound(); requestAnimationFrame(tick); } else stopSound(); ui(); }
  window.seek = x => { t = Math.max(0, Math.min(Number(x) || 0, (window.DURATION || 0) - 1e-3)); frame(t); ui(); if (playing) startSound(); };
  window.scoreSound = k => HM.score(k);
  if (!RENDER) {
    $('.play').onclick = toggle;
    $('.scrub').oninput = e => window.seek(e.target.value);
    $('.snd').onclick = () => { soundOn = !soundOn; startSound(); ui(); };
    $('.sub').onclick = () => { window.HM_SUBTITLES = window.HM_SUBTITLES === false ? true : false; frame(t); ui(); };
    cv.onclick = toggle;
    window.addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); toggle(); } if (e.code === 'ArrowRight') window.seek(t + 1); if (e.code === 'ArrowLeft') window.seek(t - 1); });
    if (q.has('t')) t = Number(q.get('t')) || 0;
  }
  ready();
})();
