// Unit tests for the vocal tools the studio runs (dsp/vocal.js) and for
// the Web Worker that runs them (jobs.js). Signals are synthesised here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../js/studio/dsp/vocal.js');

const SR = 22050;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Vowel-like note: formant-shaped harmonics, 10 ms attack, 40 ms release.
function vowel(x, t0, dur, f0, amp) {
  const s0 = Math.round(t0 * SR), n = Math.round(dur * SR);
  const att = 0.01 * SR, rel = 0.04 * SR, harm = [];
  for (let h = 1; h * f0 < 6000; h++) {
    const f = h * f0;
    harm.push((Math.exp(-(((f - 700) / 250) ** 2)) + 0.6 * Math.exp(-(((f - 1150) / 300) ** 2)) + 0.08) / Math.sqrt(h));
  }
  let ph = 0;
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    let g = i < att ? i / att : 1;
    if (i > n - rel) g *= 0.5 - 0.5 * Math.cos(Math.PI * (n - i) / rel);
    ph += 2 * Math.PI * f0 / SR;
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin((h + 1) * ph);
    x[s0 + i] += amp * g * v * 0.3;
  }
}

// Kick on every beat (accented on 1), noise hats on the eighths.
function drums(bpm, seconds, firstDownbeat) {
  const x = new Float32Array(Math.round(seconds * SR)), rand = rng(7), beat = 60 / bpm;
  for (let b = 0; firstDownbeat + b * beat < seconds; b++) {
    const t = firstDownbeat + b * beat, s0 = Math.round(t * SR);
    let ph = 0;
    for (let i = 0; i < 0.3 * SR && s0 + i < x.length; i++) {
      const u = i / SR;
      ph += 2 * Math.PI * (60 + 90 * Math.exp(-u / 0.03)) / SR;
      x[s0 + i] += (b % 4 === 0 ? 1 : 0.55) * Math.exp(-u / 0.1) * Math.min(1, (0.3 - u) / 0.05) * Math.sin(ph);
    }
    [t, t + beat / 2].forEach((th) => {
      const h0 = Math.round(th * SR);
      let prev = 0;
      for (let i = 0; i < 0.06 * SR && h0 + i < x.length; i++) {
        const n = rand() * 2 - 1;
        x[h0 + i] += 0.12 * Math.exp(-i / SR / 0.012) * (n - prev);
        prev = n;
      }
    });
  }
  return x;
}

function delayed(x, seconds) {
  const d = Math.round(seconds * SR), y = new Float32Array(x.length);
  for (let i = d; i < x.length; i++) y[i] = x[i - d];
  return y;
}

// A clip that plays source time 1.0 at song time 3.0: shift = start - offset = 2.
const CLIP = { start: 3, offset: 1, duration: 6 };
const SHIFT = CLIP.start - CLIP.offset;
const GRID = { bpm: 120, offset: 0.25, subdivision: 8 };
const EIGHTH = 0.25;

// Notes on the song's eighth-note grid (song time), some sung late.
function phrase(lateMs) {
  const x = new Float32Array(Math.round(8 * SR)), notes = [];
  for (let k = 0; ; k += 2) {
    const song = GRID.offset + 8 * EIGHTH + k * EIGHTH;   // from song time 2.25
    const src = song - SHIFT;
    if (src > 7) break;
    const late = lateMs(k) / 1000;
    vowel(x, src + late, 0.3, 196 + 20 * (k % 3), 0.8);
    notes.push({ song, src, late });
  }
  return { x, notes };
}

test('sourceGrid moves the grid by the clip shift', () => {
  assert.deepEqual(V.sourceGrid({ bpm: 100, offset: 0.4 }, 2), { bpm: 100, offset: -1.6, subdivision: 16 });
  assert.deepEqual(V.sourceGrid({ bpm: 90, offset: 0, subdivision: 8 }), { bpm: 90, offset: 0, subdivision: 8 });
});

test('timing: onsets come back in song time, only for the clip, judged against the song grid', () => {
  const { x, notes } = phrase((k) => (k % 4 === 2 ? 60 : 0));
  const r = V.timing({ channels: [x], sampleRate: SR }, {
    grid: GRID, shift: SHIFT, from: CLIP.offset, to: CLIP.offset + CLIP.duration, toleranceMs: 25
  });
  const inside = notes.filter((n) => n.src + n.late >= CLIP.offset && n.src < CLIP.offset + CLIP.duration);
  assert.ok(notes.length > inside.length, 'some notes sit before the clip starts');
  assert.equal(r.report.count, inside.length);
  assert.equal(r.report.late, inside.filter((n) => n.late > 0).length);
  assert.equal(r.report.onGrid, inside.filter((n) => n.late === 0).length);
  assert.equal(r.report.early, 0);
  r.report.items.forEach((it, i) => {
    const n = inside[i];
    assert.ok(Math.abs(it.time - (n.song + n.late)) < 0.012, `onset ${i} at ${it.time}, expected ${n.song + n.late}`);
    assert.ok(Math.abs(it.gridTime - n.song) < 1e-9);
  });
});

test('tighten: late phrases land near the grid, same length, nothing moved when already tight', () => {
  const { x } = phrase((k) => (k % 4 === 2 ? 45 : 0));
  const r = V.tighten({ channels: [x], sampleRate: SR }, { grid: GRID, shift: SHIFT, strength: 1, maxShiftMs: 80, toleranceMs: 15 });
  assert.equal(r.channels.length, 1);
  assert.equal(r.channels[0].length, x.length);
  assert.ok(r.report.moved > 0);
  assert.ok(r.report.before.late > 0);
  assert.equal(r.report.after.late, 0, JSON.stringify(r.report.after.items.map((i) => Math.round(i.deviationMs))));
  assert.ok(r.report.after.meanAbsMs < r.report.before.meanAbsMs / 2);

  const tight = phrase(() => 0);
  const same = V.tighten({ channels: [tight.x], sampleRate: SR }, { grid: GRID, shift: SHIFT, strength: 1, toleranceMs: 15 });
  assert.equal(same.report.moved, 0);
});

test('align: a stem 30 ms late reads +30 ms, 20 ms early reads -20 ms', () => {
  const ref = drums(120, 10, 0.5);
  const late = V.align({ channels: [delayed(ref, 0.03)], ref: [ref], sampleRate: SR }, { maxLag: 0.25 });
  assert.ok(Math.abs(late.offset - 0.03) < 0.003, String(late.offset));
  assert.ok(late.confidence >= 0.2);
  const early = V.align({ channels: [ref], ref: [delayed(ref, 0.02)], sampleRate: SR }, {});
  assert.ok(Math.abs(early.offset + 0.02) < 0.003, String(early.offset));
});

test('grid: tempo and bar 1 from a drum loop', () => {
  const r = V.grid({ channels: [drums(120, 12, 0.37)], sampleRate: SR }, {});
  assert.ok(Math.abs(r.bpm - 120) < 0.2, String(r.bpm));
  assert.ok(Math.abs(r.barOffset - 0.37) < 0.02, String(r.barOffset));
});

test('clean: unticked steps are skipped and the length is kept', () => {
  const x = new Float32Array(SR * 2), rand = rng(3);
  vowel(x, 0.2, 1.4, 220, 0.8);
  for (let i = 0; i < x.length; i++) x[i] += 0.003 * (rand() * 2 - 1);
  const r = V.clean({ channels: [x, x.slice()], sampleRate: SR }, { preset: 'vocal', denoise: false, deess: false });
  assert.equal(r.channels.length, 2);
  assert.equal(r.channels[0].length, x.length);
  const steps = r.report.map((s) => s.step);
  assert.ok(!steps.includes('denoise') && !steps.includes('deess'));
  assert.ok(steps.includes('declick'));
  r.report.forEach((s) => assert.equal(typeof s.detail, 'string'));
});

test('key and tune: a sharp note is pulled to the scale', () => {
  const x = new Float32Array(SR * 2);
  const f = 220 * Math.pow(2, 30 / 1200);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR) * Math.min(1, i / 400, (x.length - i) / 400);
  const r = V.tune({ channels: [x], sampleRate: SR }, { key: 'A', mode: 'minor', speed: 0, strength: 1 });
  assert.equal(r.channels[0].length, x.length);
  assert.ok(r.report.voicedSeconds > 1.5);
  assert.ok(r.report.centsBefore > 20 && r.report.centsAfter < 6, JSON.stringify(r.report));
  const k = V.key({ channels: [x], sampleRate: SR }, {});
  assert.equal(typeof k.name, 'string');
  assert.equal(k.scores.length, 24);
});

// Loads the page scripts into one context, builds the worker source the way
// the studio does, and runs jobs through the worker's message handler.
test('the worker built by jobs.js runs every tool and hands back the audio', () => {
  const g = { Math, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Array, Error, Date, JSON, Object, Number, String, isFinite, isNaN };
  const page = Object.assign({}, g);
  page.self = page;
  page.window = page;
  for (const f of ['fft', 'pitch', 'rhythm', 'cleanup', 'melody', 'vocal']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../js/studio/dsp/${f}.js`), 'utf8'), page, { filename: f + '.js' });
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/studio/jobs.js'), 'utf8'), page, { filename: 'jobs.js' });
  const src = page.S2S.studio.jobs.workerSource();

  const posted = [];
  const worker = Object.assign({}, g);
  worker.self = worker;
  worker.postMessage = (msg, transfer) => posted.push({ msg, transfer });
  vm.runInNewContext(src, worker, { filename: 'worker.js' });

  const { x } = phrase((k) => (k % 4 === 2 ? 45 : 0));
  worker.onmessage({ data: { id: 1, op: 'tighten', input: { channels: [x], sampleRate: SR }, opts: { grid: GRID, shift: SHIFT, strength: 1 } } });
  const done = posted.filter((p) => p.msg.id === 1 && !('progress' in p.msg));
  assert.equal(done.length, 1);
  assert.equal(done[0].msg.error, undefined);
  assert.equal(done[0].msg.result.channels[0].length, x.length);
  assert.equal(done[0].transfer.length, 1, 'the new audio is transferred, not copied');
  assert.ok(done[0].msg.result.report.moved > 0);

  worker.onmessage({ data: { id: 2, op: 'timing', input: { channels: [x], sampleRate: SR }, opts: { grid: GRID, shift: SHIFT, from: 1, to: 7 } } });
  const timing = posted.find((p) => p.msg.id === 2 && p.msg.result);
  assert.ok(timing.msg.result.report.count > 3);

  worker.onmessage({ data: { id: 4, op: 'melody', input: { channels: [x], sampleRate: SR }, opts: { from: 1, to: 7 } } });
  const mel = posted.find((p) => p.msg.id === 4 && p.msg.result);
  assert.ok(mel && mel.msg.result.notes.length > 3 && mel.msg.result.notes.every((n) => n.t >= 1 - 0.05), 'melody runs in the worker and keeps source times');

  worker.onmessage({ data: { id: 3, op: 'nope', input: { channels: [x], sampleRate: SR }, opts: {} } });
  const bad = posted.find((p) => p.msg.id === 3);
  assert.equal(typeof bad.msg.error, 'string');
});
