// Unit tests for the studio's pitch tools: YIN tracking, key detection,
// the correction curve and TD-PSOLA auto-tune. Signals are generated here.
// Run: node --test tests/studio-pitch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../js/studio/dsp/pitch.js');

const SR = 48000;
const C4 = 261.6255653, E4 = 329.6275569;
const cents = (f, ref) => 1200 * Math.log2(f / ref);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const detune = (hz, c) => hz * Math.pow(2, c / 1200);

// One cycle of a sum of harmonics (amps[h - 1] for harmonic h), read with linear interpolation.
const TABLE = 4096;
function cycle(amps) {
  const t = new Float64Array(TABLE + 1);
  amps.forEach((a, h) => { for (let i = 0; i <= TABLE; i++) t[i] += a * Math.sin(2 * Math.PI * (h + 1) * i / TABLE); });
  return t;
}
function readCycle(t, phase) {
  const p = phase * TABLE, i = Math.floor(p);
  return t[i] + (t[i + 1] - t[i]) * (p - i);
}

// Voice-like tone: harmonics 1..20 rolling off as 1/h, shaped by three vowel formants.
function formantGain(hz) {
  let g = 0.02;
  for (const [fc, bw, a] of [[700, 130, 1], [1220, 70, 0.5], [2600, 160, 0.25]]) g += a / (1 + ((hz - fc) / bw) ** 2);
  return g;
}
const voiceCycles = new Map();
function voiceCycle(f0, sr) {
  const key = f0 + '@' + sr;
  if (!voiceCycles.has(key)) {
    const amps = [];
    for (let h = 1; h <= 20 && h * f0 < sr / 2; h++) amps.push(formantGain(h * f0) / h);
    voiceCycles.set(key, cycle(amps));
  }
  return voiceCycles.get(key);
}

// notes: [{ hz, sec, vib }] (hz 0 = silence, vib = vibrato depth in cents at 5.5 Hz).
// Continuous phase, 30 ms fades at phrase edges and a slight 4 Hz tremolo.
function voice(notes, sr = SR, peak = 0.3) {
  const n = Math.round(notes.reduce((s, x) => s + x.sec, 0) * sr), out = new Float32Array(n);
  let i = 0, phase = 0;
  notes.forEach((note, k) => {
    const len = Math.round(note.sec * sr), table = note.hz > 0 ? voiceCycle(note.hz, sr) : null;
    const fadeIn = !(k > 0 && notes[k - 1].hz > 0), fadeOut = !(k + 1 < notes.length && notes[k + 1].hz > 0);
    const fade = 0.03 * sr;
    for (let j = 0; j < len && i < n; j++, i++) {
      if (!table) continue;
      let env = 1 + 0.05 * Math.sin(2 * Math.PI * 4 * i / sr);
      if (fadeIn) env *= Math.min(1, j / fade);
      if (fadeOut) env *= Math.min(1, (len - j) / fade);
      const hz = note.vib ? note.hz * Math.pow(2, note.vib * Math.sin(2 * Math.PI * 5.5 * i / sr) / 1200) : note.hz;
      phase += hz / sr;
      phase -= Math.floor(phase);
      out[i] = env * readCycle(table, phase);
    }
  });
  let max = 0;
  for (let j = 0; j < n; j++) max = Math.max(max, Math.abs(out[j]));
  if (max > 0) for (let j = 0; j < n; j++) out[j] *= peak / max;
  return out;
}

function voicedMedian(track, t0 = -Infinity, t1 = Infinity) {
  const v = [];
  for (let i = 0; i < track.f0.length; i++) {
    if (track.f0[i] > 0 && track.times[i] >= t0 && track.times[i] < t1) v.push(track.f0[i]);
  }
  v.sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}
const unvoicedShare = (track) => Array.from(track.f0).filter((f) => !(f > 0)).length / track.f0.length;
const rmsDb = (x) => 10 * Math.log10(x.reduce((s, v) => s + v * v, 0) / x.length);
const allFinite = (x) => x.every((v) => Number.isFinite(v));
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test('note names and scales', () => {
  assert.deepEqual(P.NOTE_NAMES, ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
  assert.deepEqual(P.scale('C', 'major'), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(P.scale('A', 'minor'), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(P.scale('E', 'minor'), [0, 2, 4, 6, 7, 9, 11]);
  assert.deepEqual(P.scale('F#', 'major'), [1, 3, 5, 6, 8, 10, 11]);
  assert.deepEqual(P.scale('Bb', 'major'), [0, 2, 3, 5, 7, 9, 10]);
  assert.equal(P.scale('D', 'chromatic').length, 12);
  assert.throws(() => P.scale('H', 'major'), /Unknown key/);
  assert.throws(() => P.scale('C', 'dorian'), /Unknown mode/);
});

test('yin: a 220 Hz sine and a 330 Hz sawtooth read within 0.5%', () => {
  const n = SR, sine = new Float32Array(n), saw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sine[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / SR);
    const ph = (330 * i / SR) % 1;
    saw[i] = 0.5 * (2 * ph - 1);
  }
  const a = P.yin(sine, SR), b = P.yin(saw, SR);
  assert.equal(a.f0.length, a.times.length);
  assert.equal(a.hop, 240);
  assert.equal(a.frameRate, 200);
  assert.ok(Math.abs(a.times[1] - 0.005) < 1e-12);
  assert.ok(Math.abs(voicedMedian(a) / 220 - 1) < 0.005, `sine read ${voicedMedian(a)}`);
  assert.ok(Math.abs(voicedMedian(b) / 330 - 1) < 0.005, `saw read ${voicedMedian(b)}`);
  assert.ok(unvoicedShare(a) < 0.05 && unvoicedShare(b) < 0.05);
  assert.ok(a.clarity[100] > 0.9 && a.clarity[100] <= 1);
});

test('yin: -60 dBFS noise and digital silence are unvoiced', () => {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const noise = new Float32Array(SR);
  for (let i = 0; i < SR; i++) noise[i] = (rnd() * 2 - 1) * 0.001 * Math.sqrt(3); // RMS 0.001 = -60 dBFS
  assert.ok(unvoicedShare(P.yin(noise, SR)) > 0.9);
  assert.ok(unvoicedShare(P.yin(new Float32Array(SR), SR)) > 0.9);
  assert.equal(P.yin(new Float32Array(0), SR).f0.length, 0);
});

// Triads of harmonic tones (octave 4) with the root in the bass (octave 2).
const CHORDS = { Am: [[69, 72, 76], 45], F: [[65, 69, 72], 41], C: [[60, 64, 67], 36], G: [[67, 71, 74], 43] };
function progression(seq, unit, reps, sr) {
  const tone = cycle([1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6]);
  const total = seq.reduce((s, [, u]) => s + u, 0) * unit * reps;
  const out = new Float32Array(Math.round(total * sr));
  let i = 0;
  for (let r = 0; r < reps; r++) {
    for (const [name, units] of seq) {
      const [triad, bass] = CHORDS[name], len = Math.round(units * unit * sr);
      const voices = triad.map((m) => [mtof(m), 0.15]).concat([[mtof(bass), 0.25]]);
      for (let j = 0; j < len && i < out.length; j++, i++) {
        const env = Math.min(1, j / (0.01 * sr), (len - j) / (0.05 * sr));
        let s = 0;
        for (const [hz, a] of voices) s += a * readCycle(tone, (hz * j / sr) % 1);
        out[i] = env * s;
      }
    }
  }
  return out;
}

test('estimateKey: Am-F-C-G with a long Am is A minor; C-G-Am-F with a long C is C major', () => {
  const sr = 44100;
  const minor = P.estimateKey([progression([['Am', 2], ['F', 1], ['C', 1], ['G', 1]], 1.6, 2, sr)], sr);
  assert.equal(minor.name, 'A minor');
  assert.equal(minor.key, 'A');
  assert.equal(minor.mode, 'minor');
  assert.equal(minor.scores.length, 24);
  for (let i = 1; i < 24; i++) assert.ok(minor.scores[i - 1].r >= minor.scores[i].r);
  assert.ok(minor.confidence > 0 && minor.confidence <= 1);

  const left = progression([['C', 2], ['G', 1], ['Am', 1], ['F', 1]], 1.6, 2, sr);
  const major = P.estimateKey([left, Float32Array.from(left)], sr);
  assert.equal(major.name, 'C major');
  assert.equal(major.scores[0].name, 'C major');
  assert.ok(Math.abs(major.tuningCents) < 5);
});

test('targetRatios: snaps to the scale, scales by strength, leaves unvoiced frames alone', () => {
  const f0 = new Float32Array(100).fill(detune(220, 30));
  for (let i = 0; i < 10; i++) f0[i] = 0;
  const track = { f0, frameRate: 200, hop: 240 };
  const hard = P.targetRatios(track, { key: 'A', mode: 'minor', speed: 0 });
  for (let i = 0; i < 10; i++) assert.equal(hard[i], 1);
  for (let i = 10; i < 100; i++) assert.ok(Math.abs(cents(hard[i], 1) + 30) < 0.01);
  const half = P.targetRatios(track, { key: 'A', mode: 'minor', speed: 0, strength: 0.5 });
  assert.ok(Math.abs(cents(half[50], 1) + 15) < 0.01);
  // G# is not in A minor: 60 cents sharp of G goes down to G, while chromatic goes up to G#.
  const g = { f0: new Float32Array(50).fill(detune(mtof(67), 60)), frameRate: 200, hop: 240 };
  assert.ok(Math.abs(cents(P.targetRatios(g, { key: 'A', mode: 'minor', speed: 0 })[25], 1) + 60) < 0.01);
  assert.ok(Math.abs(cents(P.targetRatios(g, { key: 'A', mode: 'chromatic', speed: 0 })[25], 1) - 40) < 0.01);
});

test('autoTune: a note 30 cents sharp of A3 lands within 5 cents, same length and loudness', () => {
  const input = voice([{ hz: detune(220, 30), sec: 2 }]);
  const res = P.autoTune([input], SR, { key: 'A', mode: 'minor', speed: 0 });
  const out = res.channels[0];
  assert.equal(res.channels.length, 1);
  assert.equal(out.length, input.length);
  assert.ok(allFinite(out));
  const got = cents(voicedMedian(P.yin(out, SR)), 220);
  assert.ok(Math.abs(got) < 5, `output is ${got.toFixed(2)} cents off`);
  assert.ok(Math.abs(rmsDb(out) - rmsDb(input)) < 1);
  assert.equal(res.report.key, 'A');
  assert.equal(res.report.mode, 'minor');
  assert.ok(res.report.voicedSeconds > 1.8);
  assert.ok(Math.abs(res.report.centsBefore - 30) < 3, `before ${res.report.centsBefore}`);
  assert.ok(res.report.centsAfter < 5, `after ${res.report.centsAfter}`);
});

test('autoTune: C4 -40 cents then E4 +25 cents both land within 8 cents (speed 20)', () => {
  const input = voice([{ hz: detune(C4, -40), sec: 1 }, { hz: detune(E4, 25), sec: 1 }]);
  const res = P.autoTune([input], SR, { key: 'C', mode: 'major', speed: 20 });
  assert.equal(res.channels[0].length, input.length);
  assert.ok(allFinite(res.channels[0]));
  const track = P.yin(res.channels[0], SR);
  const first = cents(voicedMedian(track, 0.1, 0.9), C4), second = cents(voicedMedian(track, 1.1, 1.9), E4);
  assert.ok(Math.abs(first) < 8, `C4 note is ${first.toFixed(2)} cents off`);
  assert.ok(Math.abs(second) < 8, `E4 note is ${second.toFixed(2)} cents off`);
});

test('strength 0 and all-ones ratios leave the audio untouched', () => {
  const input = voice([{ hz: detune(C4, -40), sec: 1 }, { hz: 0, sec: 0.2 }, { hz: detune(E4, 25), sec: 1 }]);
  const res = P.autoTune([input], SR, { key: 'C', mode: 'major', strength: 0 });
  assert.ok(maxDiff(res.channels[0], input) < 1e-4);
  const track = P.yin(input, SR), ones = new Float32Array(track.f0.length).fill(1);
  const out = P.psola([input], SR, track, ones);
  assert.notEqual(out[0], input);            // a new array...
  assert.deepEqual(out[0], input);           // ...with the same samples
});

test('stereo: identical channels stay identical, a half-level copy stays a half-level copy', () => {
  const left = voice([{ hz: detune(220, 30), sec: 1, vib: 30 }, { hz: detune(E4, -20), sec: 1 }]);
  const same = P.autoTune([left, Float32Array.from(left)], SR, { key: 'A', mode: 'minor' });
  assert.equal(same.channels.length, 2);
  assert.deepEqual(same.channels[0], same.channels[1]);
  // Both channels share the pitch marks and grain windows, so the image is kept exactly.
  const scaled = P.autoTune([left, left.map((v) => v * 0.5)], SR, { key: 'A', mode: 'minor' });
  assert.ok(maxDiff(scaled.channels[1], scaled.channels[0].map((v) => v * 0.5)) < 1e-7);
  assert.ok(Math.abs(cents(voicedMedian(P.yin(scaled.channels[0], SR), 0.1, 0.9), 220)) < 8);
});

test('the factory is self-contained and rebuilds from its source, as in a Web Worker', () => {
  const dir = path.join(__dirname, '..', 'js', 'studio', 'dsp');
  const fftSrc = fs.readFileSync(path.join(dir, 'fft.js'), 'utf8');
  const page = { console };
  page.self = page;
  vm.createContext(page);
  vm.runInContext(fftSrc, page);
  vm.runInContext(fs.readFileSync(path.join(dir, 'pitch.js'), 'utf8'), page);
  assert.equal(typeof page.S2S.studio.pitch.autoTune, 'function');
  const src = page.S2S.studio.factories.pitch.toString();
  // A fresh "worker" with only the FFT loaded.
  const worker = {};
  worker.self = worker;
  vm.createContext(worker);
  vm.runInContext(fftSrc, worker);
  const api = vm.runInContext('(' + src + ')()', worker);
  assert.equal(api.scale('D', 'major').join(','), '1,2,4,6,7,9,11');
  const tone = new Float32Array(SR / 2);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin(2 * Math.PI * 330 * i / SR);
  const track = api.yin(tone, SR);
  assert.ok(Math.abs(track.f0[50] / 330 - 1) < 0.005);
});

test('performance: a minute of vocal with silences', () => {
  const melody = [57, 60, 62, 64, 65, 64, 62, 60, 59, 57, 55, 57];
  const offsets = [30, -20, 15, -35, 25, -10, 40, -25, 5, -15, 20, -30];
  const notes = [];
  for (let k = 0; notes.reduce((s, x) => s + x.sec, 0) < 60 - 1e-9; k++) {
    const j = k % melody.length;
    notes.push(k % 4 === 3 ? { hz: 0, sec: 0.5 } : { hz: detune(mtof(melody[j]), offsets[j]), sec: 0.5, vib: 20 });
  }
  const input = voice(notes);
  assert.equal(input.length, 60 * SR);
  const progress = [];
  const t0 = Date.now();
  const res = P.autoTune([input], SR, { onProgress: (f) => progress.push(f) });
  const ms = Date.now() - t0;
  console.log(`autoTune, 60 s mono at 48 kHz (key detection included): ${ms} ms;`,
    `key ${res.report.name}, ${res.report.voicedSeconds.toFixed(1)} s voiced,`,
    `${res.report.centsBefore.toFixed(1)} -> ${res.report.centsAfter.toFixed(1)} cents off`);
  assert.ok(ms < 20000, `took ${ms} ms`);
  assert.equal(res.channels[0].length, input.length);
  assert.ok(allFinite(res.channels[0]));
  assert.ok(res.report.centsAfter < res.report.centsBefore);
  assert.ok(progress.length > 3);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1]);
  assert.equal(progress[progress.length - 1], 1);
});
