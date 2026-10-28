# Stem to Stream Studio engine

The engine behind Stem to Stream Studio, a multitrack studio that runs in the browser. Bring your own UI:

- Audio engine: Web Audio playback, track effects (EQ, compressor, reverb, delay, drive), a true-peak master limiter (AudioWorklet), offline WAV render.
- Instruments: four synth types, 12 presets.
- Vocal tools, run in a Web Worker:
  - tempo and bar 1 detection;
  - AI-artifact clean-up;
  - timing check and tighten;
  - key detection and pitch correction;
  - melody to MIDI.
- Files and storage:
  - loudness analysis (LUFS, true peak);
  - WAV, ZIP and MIDI files;
  - song files;
  - IndexedDB autosave.
- A headless **controller** (`js/studio/controller.js`). It owns the song, undo history, selection, transport and every command a UI needs, and never touches the DOM.

## Use it

Load the bundle as a classic script, **before** your app, pinned to a commit:

```html
<script src="https://cdn.jsdelivr.net/gh/bkrivitsky-hash/s2s-studio-engine@<commit>/dist/studio-engine.js"></script>
```

```js
const studio = window.S2S.studio.createController();
studio.subscribe((e) => { /* change, select, transport, save, busy, progress, message, midi */ });
await studio.init();                  // opens browser storage and the last song (or the demo)
// on a click (browsers start audio only from a user gesture):
studio.play();
```

Types: [`types/studio.d.ts`](types/studio.d.ts). Copy it into your app, for example as `src/studio.d.ts`.

### React

```ts
import { useSyncExternalStore } from 'react';
const studio = window.S2S.studio.createController();

// Re-renders when anything in the studio changes; select keeps components narrow.
export function useStudio<T>(select: (s: typeof studio) => T): T {
  useSyncExternalStore(studio.subscribe, studio.getVersion);
  return select(studio);
}

// The playhead and meters: once per frame, into refs or a canvas, never React state.
function loop() {
  const f = studio.frame();           // {playing, position, levels}
  /* draw f.position and f.levels */
  requestAnimationFrame(loop);
}
```

## Rules a UI must follow

- **Don't import the files through a bundler.** Load `dist/studio-engine.js` as a plain `<script>`. Inside a bundle each file exports to the bundler instead of attaching to `window.S2S`.
- **Don't minify or transform it.** `jobs.js` and `fx.js` build the Web Worker and the limiter worklet from each factory's source text.
- **Allow `blob:` workers and scripts in your CSP.** Without them, vocal tools run on the main thread and the limiter falls back to a basic one (`studio.limiterMode === false`).
- **Start audio from a click.** `play()`, `audition()` and `connectMidiInput()` need a user gesture.
- **The song is mutable and owned by the controller.** Don't freeze it (Immer, Redux Toolkit) or replace it.
- **Change it only through controller methods.** For sliders, call `gestureStart()` on pointer down, the setter on every move and `gestureEnd(kind)` on release: one undo step per drag. For timeline drags, use `dragClips` / `dragTrim` / `dragFade` / `dragLoop` / `dragNotes`: `update()` while moving, `end()` once.
- **Times are seconds.** A clip plays source time `t` at song time `t + start − offset`. MIDI note times are source times too. Changing the BPM moves the grid, not the clips.
- **Call `frame()` once per animation frame and nowhere else.** The meters report peaks since the last call.

## Develop

```sh
node --test tests/*.test.js          # unit tests (no install needed)
node tests/controller.browser.mjs    # the controller on the real engine in Chromium (needs Playwright)
node scripts/bundle.mjs              # rebuild dist/studio-engine.js after changing js/
```

CI runs all three and fails if `dist/` is out of date.

No license is granted yet: all rights reserved by the author.
