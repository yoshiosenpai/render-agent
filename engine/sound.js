/* Cytron video engine — sound kit (original, Web Audio only, no samples).
 * Everything is synthesised, so the same score sounds the same in the preview and in the MP4.
 *
 *   HMSound.kit(audioCtx, destination, { shift, from }) -> k
 *     k.play(name, t, { gain, pitch, pan, dur })      one-shot from the list below
 *     k.tone(t, { f, f2, dur, type, gain, attack, release, pan })
 *     k.noise(t, { dur, gain, filter, f, f2, q, attack, release, pan })
 *     k.bed(name, a, b, { gain, key, bpm, mode })    a loop from a to b (seconds)
 *   HMSound.NAMES / HMSound.BEDS                      what exists
 *   HMSound.live(scoreFn, fromT) -> { stop() }        plays in the browser from fromT
 *   HMSound.offline(scoreFn, duration, sampleRate)    -> Promise<AudioBuffer>
 *
 * scoreFn(k) is HM.score: it calls k.play / k.bed with times on the video's clock.
 */
(function () {
  'use strict';
  const S = (window.HMSound = {});
  const NOTE = n => 440 * Math.pow(2, (n - 69) / 12);
  const KEYS = { C: 60, 'C#': 61, Db: 61, D: 62, 'D#': 63, Eb: 63, E: 64, F: 65, 'F#': 66, Gb: 66, G: 67, 'G#': 68, Ab: 68, A: 57, 'A#': 58, Bb: 58, B: 59 };
  const rng = (seed = 9) => { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

  S.NAMES = ['pop', 'tick', 'click', 'tock', 'blip', 'beep', 'whoosh', 'swish', 'riser', 'drop', 'thud', 'impact', 'stamp', 'ding', 'chime', 'success', 'error', 'alarm', 'sparkle', 'typing', 'stroke', 'snap', 'shutter', 'scan', 'glitch', 'clank', 'hiss-burst'];
  S.BEDS = ['room', 'hum', 'hiss', 'factory', 'drone', 'pad', 'pulse', 'lofi', 'tension'];

  S.kit = function (ac, dest, { shift = 0, from = 0 } = {}) {
    // shift: audio-clock time of video t = 0. from: skip one-shots that end before this video time.
    const master = ac.createDynamicsCompressor();
    master.threshold.value = -10; master.knee.value = 6; master.ratio.value = 4; master.attack.value = 0.003; master.release.value = 0.2;
    master.connect(dest);
    const R = rng(17);
    let white = null;
    const noiseBuf = () => {
      if (white) return white;
      const len = Math.floor(ac.sampleRate * 2), b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0), r = rng(5);
      for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
      return (white = b);
    };
    const at = t => shift + t;
    const out = (pan = 0) => { if (!pan || !ac.createStereoPanner) return master; const p = ac.createStereoPanner(); p.pan.value = pan; p.connect(master); return p; };
    const env = (g, t0, attack, peak, hold, release) => {
      const p = g.gain; p.setValueAtTime(0.0001, t0); p.linearRampToValueAtTime(peak, t0 + attack);
      if (hold > 0) p.setValueAtTime(peak, t0 + attack + hold);
      p.exponentialRampToValueAtTime(0.0001, t0 + attack + Math.max(0, hold) + release);
      return t0 + attack + Math.max(0, hold) + release;
    };
    const skip = (t, len) => t + len < from - 0.02;

    function tone(t, { f = 440, f2 = null, dur = 0.2, type = 'sine', gain = 0.3, attack = 0.005, release = null, pan = 0, detune = 0 } = {}) {
      if (skip(t, dur)) return;
      const t0 = Math.max(at(t), ac.currentTime), o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.detune.value = detune; o.frequency.setValueAtTime(f, t0);
      if (f2 && f2 !== f) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + dur);
      const end = env(g, t0, attack, gain, 0, release ?? Math.max(0.01, dur - attack));
      o.connect(g); g.connect(out(pan)); o.start(t0); o.stop(end + 0.05);
    }
    function noise(t, { dur = 0.3, gain = 0.2, filter = 'bandpass', f = 1200, f2 = null, q = 1, attack = 0.005, release = null, pan = 0, hold = 0 } = {}) {
      if (skip(t, dur)) return;
      const t0 = Math.max(at(t), ac.currentTime), src = ac.createBufferSource(), bq = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf(); src.loop = true; bq.type = filter; bq.Q.value = q; bq.frequency.setValueAtTime(f, t0);
      if (f2 && f2 !== f) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
      const end = env(g, t0, attack, gain, hold, release ?? Math.max(0.01, dur - attack - hold));
      src.connect(bq); bq.connect(g); g.connect(out(pan)); src.start(t0, R() * 1.5); src.stop(end + 0.05);
    }

    const SFX = {
      pop: (t, o) => { tone(t, { f: 620 * o.pitch, f2: 170 * o.pitch, dur: 0.09, gain: 0.45 * o.gain, pan: o.pan }); noise(t, { dur: 0.012, gain: 0.12 * o.gain, filter: 'highpass', f: 3500, pan: o.pan }); },
      tick: (t, o) => tone(t, { f: 2300 * o.pitch, dur: 0.025, type: 'square', gain: 0.07 * o.gain, pan: o.pan }),
      click: (t, o) => { noise(t, { dur: 0.018, gain: 0.25 * o.gain, f: 2600 * o.pitch, q: 3, pan: o.pan }); tone(t, { f: 1300 * o.pitch, dur: 0.02, gain: 0.08 * o.gain, pan: o.pan }); },
      tock: (t, o) => tone(t, { f: 330 * o.pitch, f2: 250 * o.pitch, dur: 0.07, type: 'triangle', gain: 0.35 * o.gain, pan: o.pan }),
      blip: (t, o) => { tone(t, { f: 880 * o.pitch, dur: 0.06, type: 'square', gain: 0.07 * o.gain, pan: o.pan }); tone(t + 0.06, { f: 1320 * o.pitch, dur: 0.08, type: 'square', gain: 0.06 * o.gain, pan: o.pan }); },
      beep: (t, o) => tone(t, { f: 1000 * o.pitch, dur: o.dur || 0.16, attack: 0.004, release: 0.03, gain: 0.12 * o.gain, pan: o.pan, type: 'sine' }),
      whoosh: (t, o) => noise(t, { dur: o.dur || 0.5, gain: 0.32 * o.gain, f: 350 * o.pitch, f2: 2600 * o.pitch, q: 0.9, attack: (o.dur || 0.5) * 0.45, pan: o.pan }),
      swish: (t, o) => noise(t, { dur: o.dur || 0.26, gain: 0.22 * o.gain, filter: 'highpass', f: 1400 * o.pitch, f2: 5200 * o.pitch, attack: 0.08, pan: o.pan }),
      riser: (t, o) => { const d = o.dur || 1.4; noise(t, { dur: d, gain: 0.22 * o.gain, f: 280 * o.pitch, f2: 3400 * o.pitch, q: 1.4, attack: d * 0.9, release: 0.08, pan: o.pan }); tone(t, { f: 110 * o.pitch, f2: 440 * o.pitch, dur: d, type: 'sawtooth', gain: 0.05 * o.gain, attack: d * 0.9, release: 0.08 }); },
      drop: (t, o) => { tone(t, { f: 900 * o.pitch, f2: 60 * o.pitch, dur: 0.6, gain: 0.25 * o.gain, type: 'triangle' }); },
      thud: (t, o) => { tone(t, { f: 95 * o.pitch, f2: 38 * o.pitch, dur: 0.32, gain: 0.8 * o.gain, pan: o.pan }); noise(t, { dur: 0.08, gain: 0.18 * o.gain, filter: 'lowpass', f: 260, pan: o.pan }); },
      impact: (t, o) => { SFX.thud(t, o); tone(t, { f: 55 * o.pitch, dur: 0.9, gain: 0.5 * o.gain, release: 0.85 }); noise(t, { dur: 0.5, gain: 0.28 * o.gain, filter: 'lowpass', f: 1600, f2: 200 }); },
      stamp: (t, o) => { tone(t, { f: 140 * o.pitch, f2: 60, dur: 0.14, gain: 0.6 * o.gain, pan: o.pan }); noise(t, { dur: 0.07, gain: 0.3 * o.gain, f: 900, q: 1.5, pan: o.pan }); },
      ding: (t, o) => { tone(t, { f: 1318 * o.pitch, dur: 1.2, gain: 0.2 * o.gain, release: 1.19, pan: o.pan }); tone(t, { f: 2637 * o.pitch, dur: 0.6, gain: 0.06 * o.gain, release: 0.59, pan: o.pan }); },
      chime: (t, o) => [0, 4, 7].forEach((s, i) => tone(t + i * 0.07, { f: NOTE(84 + s) * o.pitch, dur: 1, gain: 0.1 * o.gain, release: 0.98, pan: o.pan })),
      success: (t, o) => [0, 4, 7, 12].forEach((s, i) => tone(t + i * 0.09, { f: NOTE(72 + s) * o.pitch, dur: 0.35, type: 'triangle', gain: 0.16 * o.gain, pan: o.pan })),
      error: (t, o) => { tone(t, { f: 233 * o.pitch, dur: 0.16, type: 'square', gain: 0.08 * o.gain }); tone(t + 0.18, { f: 185 * o.pitch, dur: 0.24, type: 'square', gain: 0.08 * o.gain }); },
      alarm: (t, o) => { const d = o.dur || 1.2; for (let x = 0; x < d; x += 0.3) tone(t + x, { f: (Math.round(x / 0.3) % 2 ? 660 : 880) * o.pitch, dur: 0.28, type: 'square', gain: 0.06 * o.gain, attack: 0.01, release: 0.05 }); },
      sparkle: (t, o) => { const r = rng(Math.round(t * 1000) + 3); for (let i = 0; i < 7; i++) tone(t + i * 0.045, { f: (2200 + r() * 3000) * o.pitch, dur: 0.25, gain: 0.05 * o.gain, release: 0.24, pan: (r() - 0.5) * 0.8 }); },
      typing: (t, o) => { const d = o.dur || 1, r = rng(Math.round(t * 1000) + 11); for (let x = 0; x < d; x += 0.055 + r() * 0.07) noise(t + x, { dur: 0.02, gain: (0.1 + r() * 0.08) * o.gain, f: 1800 + r() * 1600, q: 4, pan: o.pan }); },
      stroke: (t, o) => { const d = o.dur || 0.4; noise(t, { dur: d, gain: 0.07 * o.gain, f: 2400 * o.pitch, f2: 1900 * o.pitch, q: 2.5, attack: 0.03, hold: d * 0.6, release: d * 0.3, pan: o.pan }); },
      snap: (t, o) => { noise(t, { dur: 0.03, gain: 0.3 * o.gain, filter: 'highpass', f: 4000, pan: o.pan }); tone(t, { f: 1800 * o.pitch, f2: 900, dur: 0.03, gain: 0.1 * o.gain, pan: o.pan }); },
      shutter: (t, o) => { noise(t, { dur: 0.03, gain: 0.3 * o.gain, f: 3000, q: 2 }); noise(t + 0.07, { dur: 0.04, gain: 0.25 * o.gain, f: 2200, q: 2 }); },
      scan: (t, o) => { const d = o.dur || 0.8; tone(t, { f: 600 * o.pitch, f2: 1800 * o.pitch, dur: d, type: 'sawtooth', gain: 0.03 * o.gain, attack: 0.05, release: 0.1 }); noise(t, { dur: d, gain: 0.05 * o.gain, f: 3000, q: 6, attack: 0.05 }); },
      glitch: (t, o) => { const r = rng(Math.round(t * 1000) + 21); for (let i = 0; i < 6; i++) tone(t + i * 0.03, { f: 200 + r() * 1800, dur: 0.025, type: 'square', gain: 0.05 * o.gain }); },
      clank: (t, o) => { [523, 1187, 1763].forEach((f, i) => tone(t, { f: f * o.pitch, dur: 0.5, type: 'triangle', gain: (0.12 - i * 0.03) * o.gain, release: 0.49, pan: o.pan })); noise(t, { dur: 0.05, gain: 0.25 * o.gain, filter: 'highpass', f: 2000, pan: o.pan }); },
      'hiss-burst': (t, o) => noise(t, { dur: o.dur || 0.6, gain: 0.16 * o.gain, filter: 'highpass', f: 3000, attack: 0.02, pan: o.pan }),
    };

    function play(name, t, o = {}) {
      const fn = SFX[name]; if (!fn) return;
      fn(t, { gain: o.gain ?? 1, pitch: o.pitch ?? 1, pan: o.pan ?? 0, dur: o.dur });
    }

    // ---- beds and music: loops between a and b, faded in and out
    function loopNoise(a, b, { gain, filter, f, q = 0.7 }) {
      const t0 = Math.max(at(a), at(from), ac.currentTime), t1 = at(b); if (t1 <= t0) return;
      const src = ac.createBufferSource(), bq = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf(); src.loop = true; bq.type = filter; bq.frequency.value = f; bq.Q.value = q;
      g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.8); g.gain.setValueAtTime(gain, Math.max(t0 + 0.8, t1 - 0.8)); g.gain.linearRampToValueAtTime(0.0001, t1);
      src.connect(bq); bq.connect(g); g.connect(master); src.start(t0); src.stop(t1 + 0.05);
    }
    function loopTone(a, b, { f, type = 'sine', gain, lfo = 0, detune = 0 }) {
      const t0 = Math.max(at(a), at(from), ac.currentTime), t1 = at(b); if (t1 <= t0) return;
      const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = f; o.detune.value = detune;
      g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(gain, t0 + 1); g.gain.setValueAtTime(gain, Math.max(t0 + 1, t1 - 1)); g.gain.linearRampToValueAtTime(0.0001, t1);
      if (lfo) { const l = ac.createOscillator(), lg = ac.createGain(); l.frequency.value = lfo; lg.gain.value = gain * 0.4; l.connect(lg); lg.connect(g.gain); l.start(t0); l.stop(t1 + 0.05); }
      o.connect(g); g.connect(master); o.start(t0); o.stop(t1 + 0.05);
    }
    // Chord progressions by degree (semitones from the root): minor i-VI-III-VII, major I-V-vi-IV.
    const PROG = { minor: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], major: [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]] };
    function pad(a, b, { gain = 0.05, key = 'A', mode = 'minor', bpm = 90, bars = 2 }) {
      const root = KEYS[key] ?? 57, bar = (60 / bpm) * 4 * bars, prog = PROG[mode] || PROG.minor;
      for (let x = a, i = 0; x < b - 0.2; x += bar, i++) {
        const s = Math.max(x, from), e = Math.min(b, x + bar + 0.6); if (e <= s) continue;
        for (const n of prog[i % 4]) { tone(s, { f: NOTE(root + n), dur: e - s, type: 'triangle', gain: gain * 0.6, attack: Math.min(0.9, (e - s) / 3), release: Math.min(1, (e - s) / 2) }); tone(s, { f: NOTE(root + n), dur: e - s, type: 'sine', gain: gain * 0.5, attack: Math.min(0.9, (e - s) / 3), release: Math.min(1, (e - s) / 2), detune: 7 }); }
        tone(s, { f: NOTE(root + prog[i % 4][0] - 12), dur: e - s, gain: gain * 0.8, attack: 0.3, release: Math.min(1, (e - s) / 2) });
      }
    }
    function pulse(a, b, { gain = 0.08, key = 'A', mode = 'minor', bpm = 110, hats = true }) {
      const root = KEYS[key] ?? 57, beat = 60 / bpm, prog = PROG[mode] || PROG.minor;
      let i = 0;
      for (let x = a; x < b - 0.05; x += beat, i++) {
        if (x < from - 0.05) continue;
        const fade = Math.min(1, (x - a) / 1.5, (b - x) / 1.5);
        if (i % 2 === 0) tone(x, { f: 120, f2: 45, dur: 0.22, gain: gain * 2.2 * fade });
        if (hats) noise(x + beat / 2, { dur: 0.04, gain: gain * 0.5 * fade, filter: 'highpass', f: 7000 });
        const chord = prog[Math.floor(i / 8) % 4];
        tone(x, { f: NOTE(root + chord[0] - 24), dur: beat * 0.9, type: 'sawtooth', gain: gain * 0.45 * fade, attack: 0.01, release: beat * 0.6 });
        if (i % 4 === 3) tone(x + beat / 2, { f: NOTE(root + chord[(i >> 2) % 3] + 12), dur: 0.18, type: 'triangle', gain: gain * 0.5 * fade });
      }
    }
    function lofi(a, b, { gain = 0.06, key = 'D', mode = 'major', bpm = 80 }) {
      pad(a, b, { gain: gain * 0.8, key, mode, bpm, bars: 1 });
      const beat = 60 / bpm; let i = 0;
      for (let x = a; x < b - 0.05; x += beat, i++) {
        if (x < from - 0.05) continue;
        if (i % 4 === 0 || i % 4 === 2) tone(x, { f: 110, f2: 50, dur: 0.18, gain: gain * 1.6 });
        if (i % 4 === 1 || i % 4 === 3) noise(x, { dur: 0.12, gain: gain * 0.6, f: 1800, q: 0.8 });
        noise(x + beat / 2, { dur: 0.03, gain: gain * 0.3, filter: 'highpass', f: 6000 });
      }
      loopNoise(a, b, { gain: gain * 0.15, filter: 'highpass', f: 4000 });
    }
    function factory(a, b, { gain = 0.05 }) {
      loopTone(a, b, { f: 50, gain: gain * 0.5 }); loopTone(a, b, { f: 100, gain: gain * 0.25, lfo: 0.3 });
      loopNoise(a, b, { gain: gain * 0.6, filter: 'lowpass', f: 500 });
      const r = rng(31); for (let x = a + 0.7; x < b - 0.5; x += 1.3 + r() * 2.2) if (x >= from) SFX.clank(x, { gain: 0.25 * (gain / 0.05), pitch: 0.7 + r() * 0.5, pan: (r() - 0.5) * 1.2 });
    }
    function bed(name, a, b, o = {}) {
      const g = o.gain;
      if (name === 'room') loopNoise(a, b, { gain: g ?? 0.03, filter: 'lowpass', f: 380 });
      else if (name === 'hum') { loopTone(a, b, { f: 50, gain: g ?? 0.03 }); loopTone(a, b, { f: 100, gain: (g ?? 0.03) * 0.4 }); }
      else if (name === 'hiss') loopNoise(a, b, { gain: g ?? 0.012, filter: 'highpass', f: 6000 });
      else if (name === 'factory') factory(a, b, { gain: g ?? 0.05 });
      else if (name === 'drone') { const f = NOTE((KEYS[o.key] ?? 57) - 12); loopTone(a, b, { f, type: 'sawtooth', gain: (g ?? 0.03) * 0.35, lfo: 0.15 }); loopTone(a, b, { f: f * 1.5, type: 'triangle', gain: (g ?? 0.03) * 0.4, detune: 6 }); loopNoise(a, b, { gain: (g ?? 0.03) * 0.3, filter: 'lowpass', f: 300 }); }
      else if (name === 'pad') pad(a, b, { gain: g ?? 0.05, ...o });
      else if (name === 'pulse') pulse(a, b, { gain: g ?? 0.08, ...o });
      else if (name === 'lofi') lofi(a, b, { gain: g ?? 0.06, ...o });
      else if (name === 'tension') { bed('drone', a, b, { gain: (g ?? 0.04), key: o.key || 'E' }); for (let x = a; x < b; x += 60 / (o.bpm || 70)) if (x >= from) tone(x, { f: 70, f2: 50, dur: 0.25, gain: (g ?? 0.04) * 3 }); }
    }
    return { play, tone, noise, bed, sampleRate: ac.sampleRate, names: S.NAMES, beds: S.BEDS };
  };

  // ---- the browser preview: plays the score from fromT on the real clock
  S.live = function (scoreFn, fromT = 0, volume = 1) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return { stop() {} };
    const ac = new AC(), g = ac.createGain(); g.gain.value = volume; g.connect(ac.destination);
    const shift = ac.currentTime + 0.08 - fromT;
    try { scoreFn(S.kit(ac, g, { shift, from: fromT })); } catch (e) { console.error(e); }
    return { stop() { try { ac.close(); } catch {} }, ac };
  };

  // ---- the render: the whole score, offline, sample-exact
  S.offline = function (scoreFn, duration, sampleRate = 48000) {
    const len = Math.max(1, Math.ceil((duration + 0.5) * sampleRate));
    const ac = new OfflineAudioContext(2, len, sampleRate);
    scoreFn(S.kit(ac, ac.destination, { shift: 0, from: 0 }));
    return ac.startRendering();
  };
  // 16-bit little-endian interleaved PCM as base64 chunks (the renderer reads them over CDP).
  S.toPCM16 = function (buf) {
    const L = buf.getChannelData(0), Rr = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = L.length, out = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) { out[i * 2] = Math.max(-1, Math.min(1, L[i])) * 32767; out[i * 2 + 1] = Math.max(-1, Math.min(1, Rr[i])) * 32767; }
    return new Uint8Array(out.buffer);
  };
  S.b64 = function (u8, start, end) { let s = ''; const sub = u8.subarray(start, end); for (let i = 0; i < sub.length; i += 0x8000) s += String.fromCharCode.apply(null, sub.subarray(i, i + 0x8000)); return btoa(s); };
})();
