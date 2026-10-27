# Cytron video engine — how to write a video

Original code by Cytron. No Remotion, no npm packages: a `<canvas>`, a small helper library (`HM`), a synthesised
sound kit (`HMSound`), a player, and a renderer that drives headless Chromium and ffmpeg.

## The work folder

```
<work>/
  style.js            optional · the look: palette, fonts, shared drawing helpers (copy it from the style skill)
  scenes/scene-1.js   one file per scene: HM.scene({ n: 1, draw(ctx, f) {…}, sound(k, f) {…} })
  scenes/scene-2.js
  video.js            the timeline: HM.video({ scenes: [{ n, start, end }], transitions, background, overlay, sound, subtitles })
  assets/             photos you were given (jpg/png/webp) — load with HM.preload('assets/x.jpg')
  vo.json             optional · voice-over clips: [{ "file": "media/vo-scene-1.mp3", "start": 0.0, "gain": 1 }]
  STORYBOARD.json     what each scene shows (the Hub reads it)
```
The engine itself is not copied: the renderer serves it. Check, stills, video and the preview file:
```
node <engine>/render.mjs <work> --mode check  --format vertical
node <engine>/render.mjs <work> --mode stills --format vertical --out <work>/stills
node <engine>/render.mjs <work> --mode video  --format vertical --out <work>/out/video.mp4 --poster <work>/out/poster.jpg [--from 0 --to 4.5] [--no-subtitles]
node <engine>/render.mjs <work> --mode bundle --format vertical --out <work>/out/preview.html
```
`check` returns JSON: `errors` (must be empty), `warnings` (text off the canvas, blank frames, unknown sound names).

## Hard rules
1. **Every frame is a pure function of time.** `draw(ctx, f)` may only use `f` (and constants). No `Math.random()`
   (use `HM.rng(seed)` created once at the top of the file), no `Date`, no `performance.now()`, no state carried
   between frames, no timers. The renderer seeks to arbitrary times in any order.
2. **No network, no DOM.** Draw on `ctx` only. Fonts are bundled: Inter (400–900), IBM Plex Mono (400/600/700),
   DM Sans (400/500/700), Caveat (500/700, handwriting), Fraunces (400/600/800, serif), Anton (400, poster caps).
3. **Two formats from one code base.** Read `f.fmt` (`'vertical'` 1080×1920 or `'horizontal'` 1920×1080) and lay
   out from `f.safe`, never from hard-coded 1080/1920. Test both when the brief asks for both.
4. **Safe zone.** Everything that matters (headlines, product, numbers, labels, CTA, logo) inside
   `f.safe.x0…x1, y0…y1`. The subtitle box `f.safe.sub` is reserved for subtitles. Below `f.safe.freeBelow`
   only background.
   - vertical: x 140–840, y 260–1050, centre x 490, subtitles 140/1100 680×140, free below 1280
   - horizontal: x 96–1824, y 80–900, centre x 960, subtitles 360/920 1200×110, free below 1040
5. **Only facts from the script.** On-screen text comes from the script's on-screen text column. Sample values get
   an "Illustrative" tag. No invented numbers, logos or certifications.
6. **Real things are drawn, not described.** If the scene says "operator writes downtime on a clipboard", draw the
   operator, the clipboard and the pen moving — not a caption saying so.

## The frame object `f`
| key | meaning |
|---|---|
| `W`, `H` | canvas size |
| `t` | video time (s) |
| `u` | time since this scene started (s) — animate with this |
| `d` | scene length (s) · `p` = `u / d` (0…1) |
| `n` | scene number · `start`, `end` on the video clock |
| `fmt` | `'vertical'` or `'horizontal'` · `safe` = the safe zone above |

## HM — helpers
- Timing: `HM.on(u, at, dur=0.5, ease)` 0→1 from `at` · `HM.win(u, a, b, fade)` in at a, out at b ·
  `HM.ph(u, a, b)` linear 0…1 · `HM.ease.{out,in,inOut,back,elastic}` · `HM.clamp lerp map smooth`
- Random and noise (deterministic): `const R = HM.rng(42)` → `R()`, `R.range(a,b)`, `R.int(a,b)`, `R.pick(arr)`,
  `R.chance(p)`, `R.gauss()` · `const N = HM.noise(3)` → `N.n2(x, y)`, `N.fbm(x, y, oct)`
- Colour: `HM.hex`, `HM.mix(a, b, k)`, `HM.rgba(c, alpha)`, `HM.shade(base, shadow)` → `{ top, left, right, edge }`
- Shapes: `HM.poly(ctx, pts, fill, stroke, lw)`, `HM.rrect(ctx, x, y, w, h, r, fill, stroke, lw)`,
  `HM.arrow(ctx, a, ctrl, b, k, { color, width, dash, head })`, `HM.layer(w, h)` (offscreen canvas)
- Text: `HM.font(weight, px, family='Inter')`, `HM.mono(weight, px)`, `HM.wrap(ctx, text, maxW)`,
  `HM.fit(ctx, text, maxW, maxPx, minPx, lines)`, `HM.headline(ctx, f, ['line', { text, color }], { x, y, size, at, stagger, align, out })`,
  `HM.tag(ctx, x, y, text, { k, size, bg, color, dot, anchor:'left'|'center'|'right' })`, `HM.num(v, dec)`, `HM.counter(u, a, b, from, to)`
- Isometric: `const P = HM.iso(ox, oy, scale)` → `P(x, y, z)` · `HM.box(ctx, P, x, y, z, w, d, h, HM.shade('#…'))` ·
  `HM.onWall / onRightWall / onFloor(ctx, P(...), s)` (then draw flat art in that plane)
- Texture: `HM.grain(ctx, t, amount)`, `HM.vignette(ctx, strength)`, `HM.paper(ctx, base)`, `HM.dots(ctx, color, gap)`,
  `HM.glow(ctx, x, y, r, color, alpha)`
- Images: `HM.preload('assets/photo.jpg')` at the top of a scene file; `HM.image('assets/photo.jpg')` in draw (null until loaded)
- Subtitles: put them in `video.js` → `subtitles: [{ start, end, text }]` (burned in unless the Hub turns them off)

## video.js
```js
HM.video({
  title: 'What is IRIV?', fps: 30, poster: 1.4,
  scenes: [{ n: 1, start: 0, end: 3 }, { n: 2, start: 3, end: 8.5 }],
  transitions: { 2: { type: 'circle', dur: 0.6, x: 540, y: 700 } },   // into scene 2: crossfade | circle | wipe | push | zoom | cut
  background(ctx, f) { /* drawn under every scene (optional) */ },
  overlay(ctx, f) { /* drawn over every scene: grain, logo bug, progress (optional) */ },
  sound(k) { k.bed('pad', 0, 8.5, { key: 'A', mode: 'minor', bpm: 92, gain: 0.05 }); },
  subtitles: [{ start: 0.2, end: 2.9, text: 'Every stop on this line gets written by hand.' }],
});
```

## Sound — `sound(k, f)` in a scene (times are scene time) and in video.js (video time)
- `k.play(name, t, { gain, pitch, pan, dur })` — names: pop, tick, click, tock, blip, beep, whoosh, swish, riser, drop,
  thud, impact, stamp, ding, chime, success, error, alarm, sparkle, typing, stroke, snap, shutter, scan, glitch, clank, hiss-burst
- `k.bed(name, a, b, { gain, key, mode, bpm })` — beds: room, hum, hiss, factory, drone; music: pad, pulse, lofi, tension
- `k.tone(t, { f, f2, dur, type, gain })`, `k.noise(t, { dur, filter, f, f2, q, gain })` for anything custom.
- One sound per visual event, 1–2 frames before it lands. Music under a voice-over ducks automatically.

## Scene template
```js
// scenes/scene-2.js — Operator logs a stop by hand
(() => {
  const R = HM.rng(2);
  HM.scene({
    n: 2, still: 0.6,            // still: where the storyboard frame is taken (fraction of the scene, or seconds if > 1)
    draw(ctx, f) {
      const S = f.safe, V = f.fmt === 'vertical';
      ctx.fillStyle = '#14161b'; ctx.fillRect(0, 0, f.W, f.H);
      HM.headline(ctx, f, ['Every stop,', { text: 'written by hand.', color: '#ff4d4f' }], { at: 0.2 });
      // … the actual picture, animated with f.u …
    },
    sound(k) { k.play('whoosh', 0); k.play('stroke', 0.9, { dur: 0.8 }); },
  });
})();
```
