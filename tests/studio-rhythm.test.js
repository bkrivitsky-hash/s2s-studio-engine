// Unit tests for the studio's rhythm tools: tempo, bar grid, onsets,
// stem alignment and vocal tightening. Signals are synthesised here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../js/studio/dsp/rhythm.js');

const SR = 48000;

// Seeded PRNG (mulberry32) so every run hears the same noise.
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

// Kick: 150 -> 60 Hz pitch drop, exponential decay, faded out at 0.35 s.
function kick(x, t0, amp) {
  const s0 = Math.round(t0 * SR);
  let ph = 0;
  for (let i = 0; i < 0.35 * SR && s0 + i < x.length; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * (60 + 90 * Math.exp(-t / 0.03)) / SR;
    x[s0 + i] += amp * Math.exp(-t / 0.12) * Math.min(1, (0.35 - t) / 0.05) * Math.sin(ph);
  }
}

// Snare: noise burst plus a 180 Hz body.
function snare(x, t0, rand) {
  const s0 = Math.round(t0 * SR);
  for (let i = 0; i < 0.3 * SR && s0 + i < x.length; i++) {
    const t = i / SR, fade = Math.min(1, (0.3 - t) / 0.05);
    x[s0 + i] += fade * (0.35 * Math.exp(-t / 0.06) * (rand() * 2 - 1) +
      0.2 * Math.exp(-t / 0.04) * Math.sin(2 * Math.PI * 180 * t));
  }
}

// Hi-hat: short high-passed (differenced) noise.
function hat(x, t0, rand) {
  const s0 = Math.round(t0 * SR);
  let prev = 0;
  for (let i = 0; i < 0.08 * SR && s0 + i < x.length; i++) {
    const t = i / SR, n = rand() * 2 - 1;
    x[s0 + i] += 0.12 * Math.exp(-t / 0.015) * Math.min(1, (0.08 - t) / 0.02) * (n - prev);
    prev = n;
  }
}

// 4/4 groove: kick on 1 (accented) and 3, snare on 2 and 4, hats on eighths.
function drums(bpm, seconds, firstDownbeat) {
  const x = new Float32Array(Math.round(seconds * SR)), rand = rng(1234), beat = 60 / bpm;
  for (let b = 0; firstDownbeat + b * beat < seconds; b++) {
    const t = firstDownbeat + b * beat, pos = b % 4;
    if (pos === 0) kick(x, t, 1.0);
    if (pos === 2) kick(x, t, 0.6);
    if (pos === 1 || pos === 3) snare(x, t, rand);
    hat(x, t, rand);
    hat(x, t + beat / 2, rand);
  }
  return x;
}

// Vowel-like note: harmonics shaped by two formants, gentle vibrato,
// 10 ms linear attack and a 40 ms raised-cosine release.
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
    ph += 2 * Math.PI * f0 * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * i / SR)) / SR;
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin((h + 1) * ph);
    x[s0 + i] += amp * g * v * 0.3;
  }
}

function noiseFloor(x, level, seed) {
  const rand = rng(seed);
  for (let i = 0; i < x.length; i++) x[i] += level * (rand() * 2 - 1);
  return x;
}

function delayed(x, seconds) {
  const d = Math.round(seconds * SR), y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const j = i - d;
    if (j >= 0 && j < x.length) y[i] = x[j];
  }
  return y;
}

function maxJump(x) {
  let m = 0;
  for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

function nearest(list, t) {
  let best = Infinity;
  for (const v of list) if (Math.abs(v - t) < Math.abs(best)) best = v - t;
  return best;
}

const circ = (a, b, period) => {
  const d = ((a - b) % period + period) % period;
  return Math.min(d, period - d);
};

test('drums at 120 BPM: tempo, beat phase and the accented downbeat', () => {
  const x = drums(120, 30, 0.37);
  const env = R.onsetEnvelope([x, x], SR);
  assert.equal(env.hop, 480);
  assert.equal(env.frameRate, 100);
  assert.equal(env.env.length, Math.floor(x.length / 480) + 1);
  assert.ok(Math.abs(env.duration - 30) < 1e-9);
  const tempo = R.estimateTempo(env);
  assert.ok(Math.abs(tempo.bpm - 120) <= 0.5, `bpm ${tempo.bpm}`);
  assert.ok(tempo.confidence > 0.3 && tempo.confidence <= 1, `confidence ${tempo.confidence}`);
  assert.equal(tempo.candidates[0].bpm, tempo.bpm);

  const low = R.onsetEnvelope([x, x], SR, { band: [30, 200] });
  const grid = R.estimateGrid(env, tempo.bpm, { lowEnv: low });
  assert.ok(circ(grid.beatOffset, 0.37, 0.5) <= 0.010, `beatOffset ${grid.beatOffset}`);
  assert.ok(Math.abs(grid.barOffset - 0.37) <= 0.015, `barOffset ${grid.barOffset}`);
  assert.ok(grid.beatOffset >= 0 && grid.beatOffset < 0.5);
  assert.ok(grid.confidence > 0 && grid.confidence <= 1);

  const song = R.analyzeSong([x, x], SR);
  assert.ok(Math.abs(song.bpm - 120) <= 0.5);
  assert.ok(Math.abs(song.barOffset - 0.37) <= 0.015, `analyzeSong barOffset ${song.barOffset}`);
});

for (const bpm of [96, 140]) {
  test(`drums at ${bpm} BPM: no half- or double-tempo error`, () => {
    const x = drums(bpm, 30, 0.37);
    const env = R.onsetEnvelope([x], SR);
    const tempo = R.estimateTempo(env);
    assert.ok(Math.abs(tempo.bpm - bpm) <= 0.5, `bpm ${tempo.bpm}`);
    const low = R.onsetEnvelope([x], SR, { band: [30, 200] });
    const grid = R.estimateGrid(env, tempo.bpm, { lowEnv: low });
    assert.ok(circ(grid.beatOffset, 0.37, 60 / bpm) <= 0.010, `beatOffset ${grid.beatOffset}`);
    assert.ok(Math.abs(grid.barOffset - 0.37) <= 0.015, `barOffset ${grid.barOffset}`);
  });
}

test('grid follows the time signature: 3/4 bars and 6/8 eighth-note beats', () => {
  // Waltz at 150 BPM: accented kick on 1, hats on 2 and 3.
  const x = new Float32Array(20 * SR), rand = rng(9), beat = 0.4;
  for (let b = 0; 0.5 + b * beat < 20; b++) {
    if (b % 3 === 0) kick(x, 0.5 + b * beat, 1); else hat(x, 0.5 + b * beat, rand);
  }
  const env = R.onsetEnvelope([x], SR), low = R.onsetEnvelope([x], SR, { band: [30, 200] });
  const g = R.estimateGrid(env, 150, { beatsPerBar: 3, lowEnv: low });
  assert.ok(Math.abs(g.barOffset - 0.5) <= 0.015, `3/4 barOffset ${g.barOffset}`);
  // 6/8 at 100 BPM (quarter): beat = eighth = 0.3 s, bar = 1.8 s.
  const g68 = R.estimateGrid(env, 100, { beatsPerBar: 6, beatUnit: 8 });
  assert.ok(g68.beatOffset < 0.3 && g68.barOffset < 1.8);
});

test('alignmentOffset: positive when B is late, negative when B is early', () => {
  const x = drums(120, 30, 0.37);
  const a = R.onsetEnvelope([x], SR);
  const late = R.alignmentOffset(a, R.onsetEnvelope([delayed(x, 0.037)], SR));
  assert.ok(Math.abs(late.offset - 0.037) <= 0.003, `late ${late.offset}`);
  assert.ok(late.confidence > 0.5);
  const early = R.alignmentOffset(a, R.onsetEnvelope([delayed(x, -0.020)], SR));
  assert.ok(Math.abs(early.offset + 0.020) <= 0.003, `early ${early.offset}`);
  const same = R.alignmentOffset(a, a);
  assert.ok(Math.abs(same.offset) < 1e-9 && same.confidence > 0.99);
  assert.throws(() => R.alignmentOffset(a, R.onsetEnvelope([x], SR, { hop: 512 })), /frame rate/);
});

test('detectOnsets finds every vowel-like note within 10 ms and nothing else', () => {
  const rand = rng(42), x = new Float32Array(16 * SR), truth = [];
  let t = 0.3;
  for (let k = 0; t < 15; k++) {
    const dur = 0.15 + 0.25 * rand();
    vowel(x, t, dur, 150 + 250 * rand(), 0.12 + 0.25 * rand());
    truth.push(t);
    t += dur + 0.08 + 0.3 * rand();
  }
  noiseFloor(x, 0.0005, 7);
  const onsets = R.detectOnsets(R.onsetEnvelope([x], SR));
  assert.ok(onsets instanceof Float64Array);
  const errs = truth.map((tt) => nearest(onsets, tt) * 1000);
  assert.equal(onsets.length, truth.length, `found ${onsets.length} of ${truth.length}`);
  for (const e of errs) assert.ok(Math.abs(e) <= 10, `onset error ${e.toFixed(2)} ms`);
  for (let i = 1; i < onsets.length; i++) assert.ok(onsets[i] > onsets[i - 1]);
});

test('timingReport measures deviation from the sixteenth grid', () => {
  const grid = { bpm: 120, offset: 0.25, subdivision: 16 };   // step 0.125 s
  const onsets = [];
  for (let k = 0; k < 40; k++) onsets.push(0.25 + (3 * k + 1) * 0.125 + (k % 2 ? 0.02 : -0.02));
  const rep = R.timingReport(onsets, grid, { toleranceMs: 10 });
  assert.ok(Math.abs(rep.meanAbsMs - 20) <= 2, `meanAbsMs ${rep.meanAbsMs}`);
  assert.ok(Math.abs(rep.medianAbsMs - 20) <= 2);
  assert.equal(rep.early, 20);
  assert.equal(rep.late, 20);
  assert.equal(rep.onGrid, 0);
  assert.ok(Math.abs(rep.items[1].gridTime - (0.25 + 4 * 0.125)) < 1e-9);
  assert.ok(Math.abs(rep.items[1].deviationMs - 20) < 1e-6);
  const loose = R.timingReport(onsets, grid, { toleranceMs: 25 });
  assert.equal(loose.onGrid, 40);
  const eighths = R.timingReport([0.25 + 0.25 + 0.06], { bpm: 120, offset: 0.25, subdivision: 8 });
  assert.ok(Math.abs(eighths.items[0].deviationMs - 60) < 1e-6);
});

// Notes on a 100 BPM sixteenth grid (step 0.15 s), each `devs[k]` seconds off.
function phrase(devs) {
  const grid = { bpm: 100, offset: 0.2137, subdivision: 16 };
  const idx = [2, 5, 9, 12, 16, 19, 23, 27, 30, 34];
  const rand = rng(5), x = new Float32Array(Math.round(6.5 * SR)), gridTimes = [];
  idx.forEach((g, k) => {
    const gt = grid.offset + g * 0.15;
    gridTimes.push(gt);
    vowel(x, gt + devs[k % devs.length], 0.15 + 0.2 * rand(), 180 + 120 * rand(), 0.15 + 0.15 * rand());
  });
  noiseFloor(x, 0.0003, 3);
  return { x, grid, gridTimes };
}

function tighten(x, grid, opts) {
  const env = R.onsetEnvelope([x], SR);
  const plan = R.tightenPlan(R.detectOnsets(env), env.duration, grid, opts);
  return { plan, out: R.applyPlan([x], SR, plan) };
}

function checkPlan(plan, duration) {
  assert.equal(plan[0].start, 0);
  assert.equal(plan[0].shift, 0);
  for (let k = 0; k < plan.length; k++) {
    assert.ok(plan[k].end > plan[k].start);
    if (k > 0) assert.equal(plan[k].start, plan[k - 1].end);
  }
  assert.ok(Math.abs(plan[plan.length - 1].end - duration) < 1e-9);
}

test('tightenPlan + applyPlan pull late notes onto the grid without clicks', () => {
  const { x, grid, gridTimes } = phrase([0.04]);
  const { plan, out } = tighten(x, grid, { strength: 1, maxShiftMs: 80 });
  checkPlan(plan, x.length / SR);
  assert.ok(plan.some((s) => Math.abs(s.shift + 0.04) < 0.008), 'notes move about 40 ms earlier');
  assert.equal(out.length, 1);
  assert.equal(out[0].length, x.length);
  const after = R.detectOnsets(R.onsetEnvelope(out, SR));
  assert.equal(after.length, gridTimes.length);
  for (const g of gridTimes) {
    const e = nearest(after, g) * 1000;
    assert.ok(Math.abs(e) <= 6, `output onset ${e.toFixed(2)} ms from grid`);
  }
  assert.ok(maxJump(out[0]) <= 1.5 * maxJump(x), `jump ${maxJump(out[0])} vs ${maxJump(x)}`);

  const none = tighten(x, grid, { strength: 0 });
  assert.equal(none.plan.length, 1);
  assert.deepEqual(Array.from(none.out[0]), Array.from(x));
});

test('mixed early and late notes all land on the grid; small misses stay put', () => {
  const devs = [0.04, -0.03, 0.025, -0.02, 0.005, 0.035, -0.045, 0.05, -0.025, 0.03];
  const { x, grid, gridTimes } = phrase(devs);
  const { plan, out } = tighten(x, grid, { strength: 1, maxShiftMs: 80 });
  checkPlan(plan, x.length / SR);
  assert.ok(plan.some((s) => s.shift > 0) && plan.some((s) => s.shift < 0));
  const before = R.detectOnsets(R.onsetEnvelope([x], SR));
  const after = R.detectOnsets(R.onsetEnvelope(out, SR));
  assert.equal(after.length, gridTimes.length);
  gridTimes.forEach((g, k) => {
    if (Math.abs(devs[k]) > 0.015) {
      const e = nearest(after, g) * 1000;
      assert.ok(Math.abs(e) <= 6, `output onset ${e.toFixed(2)} ms from grid`);
    } else {
      // Within the 15 ms tolerance: the note is left exactly where it was.
      const t = g + devs[k], moved = nearest(after, t) - nearest(before, t);
      assert.ok(Math.abs(moved) < 0.0005, `on-time note moved ${moved * 1000} ms`);
    }
  });
  assert.ok(maxJump(out[0]) <= 1.5 * maxJump(x));

  // Half strength and a 20 ms cap only go part of the way.
  const half = tighten(x, grid, { strength: 0.5, maxShiftMs: 20 }).plan;
  for (const s of half) assert.ok(Math.abs(s.shift) <= 0.02 + 1e-12);
});

test('applyPlan crossfades equal-power and keeps reading the source when moving later', () => {
  const n = SR, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 220 * i / SR) * 0.5;
  const plan = [{ start: 0, end: 0.5, shift: 0 }, { start: 0.5, end: 1, shift: 0.05 }];
  const [y] = R.applyPlan([x], SR, plan, { fadeMs: 10 });
  assert.equal(y.length, n);
  // Well after the boundary the output is the source 50 ms (2400 samples) later.
  for (let i = 30000; i < 30100; i++) assert.ok(Math.abs(y[i] - x[i - 2400]) < 1e-6);
  // No silence right after the boundary: it plays earlier material.
  let e = 0;
  for (let i = 24300; i < 26000; i++) e += y[i] * y[i];
  assert.ok(e / 1700 > 0.1);
  assert.ok(maxJump(y) <= 1.5 * maxJump(x));
});

test('the factory is self-contained and rebuilds from its source, as in a worker', () => {
  const fftSrc = fs.readFileSync(path.join(__dirname, '../js/studio/dsp/fft.js'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '../js/studio/dsp/rhythm.js'), 'utf8');
  const page = { Math, Float32Array, Float64Array, Int32Array, Uint32Array, Array, Error };
  page.self = page;
  vm.runInNewContext(fftSrc + '\n' + src, page);
  assert.equal(typeof page.S2S.studio.factories.rhythm, 'function');
  const worker = { Math, Float32Array, Float64Array, Int32Array, Uint32Array, Array, Error };
  worker.self = { S2S: { studio: { fft: page.S2S.studio.fft } } };
  const rebuilt = vm.runInNewContext('(' + page.S2S.studio.factories.rhythm.toString() + ')()', worker);
  const x = drums(120, 8, 0.37);
  const a = R.estimateTempo(R.onsetEnvelope([x], SR));
  const b = rebuilt.estimateTempo(rebuilt.onsetEnvelope([x], SR));
  assert.equal(b.bpm, a.bpm);
});

test('edge cases: silence, short input and empty lists', () => {
  const silent = R.onsetEnvelope([new Float32Array(SR * 5)], SR);
  assert.equal(R.detectOnsets(silent).length, 0);
  assert.equal(R.estimateTempo(silent).bpm, 0);
  assert.equal(R.estimateGrid(silent, 120).confidence, 0);
  assert.equal(R.estimateTempo(R.onsetEnvelope([new Float32Array(1000)], SR)).bpm, 0);
  const rep = R.timingReport([], { bpm: 120, offset: 0 });
  assert.equal(rep.meanAbsMs, 0);
  assert.equal(rep.items.length, 0);
  const plan = R.tightenPlan([], 3, { bpm: 120, offset: 0 });
  assert.deepEqual(plan, [{ start: 0, end: 3, shift: 0 }]);
  assert.throws(() => R.timingReport([1], { offset: 0 }), /bpm/);
});

test('4 minutes of stereo 48 kHz analyses quickly', () => {
  const x = drums(124, 240, 0.37);
  let last = -1, monotonic = true;
  const t0 = process.hrtime.bigint();
  const env = R.onsetEnvelope([x, x], SR, {
    onProgress: (f) => { if (f < last) monotonic = false; last = f; }
  });
  const t1 = process.hrtime.bigint();
  const tempo = R.estimateTempo(env);
  const t2 = process.hrtime.bigint();
  const grid = R.estimateGrid(env, tempo.bpm);
  const t3 = process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;
  console.log(`rhythm 4 min stereo: envelope ${ms(t0, t1).toFixed(0)} ms, tempo ${ms(t1, t2).toFixed(0)} ms, ` +
    `grid ${ms(t2, t3).toFixed(0)} ms, total ${ms(t0, t3).toFixed(0)} ms (bpm ${tempo.bpm}, beatOffset ${grid.beatOffset})`);
  assert.ok(ms(t0, t3) < 20000);
  assert.ok(monotonic && last === 1, 'progress runs 0..1');
  assert.ok(Math.abs(tempo.bpm - 124) <= 0.05, `bpm ${tempo.bpm}`);
  assert.ok(circ(grid.beatOffset, 0.37, 60 / 124) <= 0.010, `beatOffset ${grid.beatOffset}`);
});
