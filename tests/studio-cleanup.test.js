// Unit tests for the AI artifact cleanup tools (declick, denoise, deshimmer,
// de-esser, low end and the one-button chain), on seeded synthetic signals.
// Run: node --test tests/studio-cleanup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { FFT } = require('../js/studio/dsp/fft.js');
const cleanup = require('../js/studio/dsp/cleanup.js');

const SR = 48000;

// ---- signal helpers -------------------------------------------------------

function rng(seed) { // mulberry32
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
const db = (ratio) => 10 * Math.log10(ratio);
function energy(x, a = 0, b = x.length) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return s; }
function sine(freq, amp, seconds, phase = 0) {
  const n = Math.round(seconds * SR), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR + phase);
  return x;
}
function spectrum(x, a, b) {
  let n = 1; while (n < b - a) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = a; i < b; i++) re[i - a] = x[i];
  new FFT(n).forward(re, im);
  return { re, im, n };
}
/** Energy of x[a..b) between f1 and f2 Hz. */
function bandEnergy(x, f1, f2, a = 0, b = x.length) {
  const { re, im, n } = spectrum(x, a, b);
  let s = 0;
  for (let k = 0; k <= n / 2; k++) {
    const f = k * SR / n;
    if (f >= f1 && f <= f2) s += (re[k] * re[k] + im[k] * im[k]) * (k === 0 || k === n / 2 ? 1 : 2);
  }
  return s / n;
}
/** Brick-wall band-pass through one big FFT. */
function bandFilter(x, f1, f2) {
  const { re, im, n } = spectrum(x, 0, x.length);
  for (let k = 0; k < n; k++) {
    const hz = (k <= n / 2 ? k : n - k) * SR / n;
    if (hz < f1 || hz > f2) { re[k] = 0; im[k] = 0; }
  }
  new FFT(n).inverse(re, im);
  return Float64Array.from(re.subarray(0, x.length));
}
/** Amplitude of the f Hz component (correlation over the whole signal). */
function toneLevel(x, f) {
  let c = 0, q = 0;
  for (let i = 0; i < x.length; i++) { c += x[i] * Math.cos(2 * Math.PI * f * i / SR); q += x[i] * Math.sin(2 * Math.PI * f * i / SR); }
  return Math.hypot(c, q);
}
function assertFinite(channels) {
  for (const ch of channels) for (let i = 0; i < ch.length; i++) assert.ok(Number.isFinite(ch[i]), `sample ${i} is ${ch[i]}`);
}

/**
 * Clean synthetic vocal (the integration repro): 11 notes on eighth notes at
 * 96 BPM, f0 from MIDI [57,60,64,62,60,57,55,57] + 30 cents, a 700 Hz formant,
 * linear 10 ms attack / 40 ms release, uniform hiss of 0.002. Stereo, L = R.
 */
function vocalNotes() {
  const n = 8 * SR, x = new Float32Array(n), midi = [57, 60, 64, 62, 60, 57, 55, 57], r = rng(1), starts = [];
  for (let k = 0; k < 11; k++) {
    const s = Math.round(((k + 1) * 0.625 + (k % 2 ? 0.05 : 0)) * SR), len = Math.round(0.42 * SR);
    const f0 = 440 * Math.pow(2, (midi[k % 8] + 0.3 - 69) / 12);
    starts.push(s);
    for (let i = 0; i < len && s + i < n; i++) {
      const ph = 2 * Math.PI * f0 * i / SR;
      let v = 0;
      for (let h = 1; h * f0 < 5000; h++) v += Math.sin(h * ph) * (Math.exp(-(((h * f0 - 700) / 300) ** 2)) + 0.1) / Math.sqrt(h);
      x[s + i] += 0.25 * Math.min(1, i / (0.01 * SR), (len - i) / (0.04 * SR)) * v;
    }
  }
  for (let i = 0; i < n; i++) x[i] += 0.002 * (2 * r() - 1);
  return { x, starts };
}

/** Timing edits like rhythm.applyPlan: shifted segments joined by 10 ms equal-power crossfades. */
function crossfadeEdits(x, starts, shifts) {
  const n = x.length, y = new Float32Array(n), h = Math.round(0.005 * SR);
  const at = (i, sh) => (i - sh >= 0 && i - sh < n ? x[i - sh] : 0);
  const bounds = [0].concat(starts), sh = [0].concat(shifts);
  for (let k = 0; k < bounds.length; k++) {
    const end = k + 1 < bounds.length ? bounds[k + 1] : n;
    for (let i = bounds[k]; i < end; i++) y[i] = at(i, sh[k]);
  }
  for (let k = 1; k < bounds.length; k++) {
    for (let i = bounds[k] - h; i < bounds[k] + h; i++) {
      const a = (i - (bounds[k] - h)) / (2 * h);
      y[i] = Math.cos(a * Math.PI / 2) * at(i, sh[k - 1]) + Math.sin(a * Math.PI / 2) * at(i, sh[k]);
    }
  }
  return y;
}

/**
 * The deshimmer test signal: a 300 Hz harmonic tone up to 3.9 kHz, identical
 * in L and R, plus 12 HF sinusoids per channel (7-12 kHz, different in L and R)
 * whose amplitude flickers with a random 20-40 Hz modulation (about +-6 dB).
 */
function shimmerSignal(seconds = 3) {
  const n = seconds * SR, r = rng(5), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 13; h++) v += 0.3 / h * Math.sin(2 * Math.PI * 300 * h * i / SR + h);
    L[i] = v; R[i] = v;
  }
  for (const ch of [L, R]) {
    for (let s = 0; s < 12; s++) {
      const f = 7000 + 5000 * r(), ph = 2 * Math.PI * r(), mods = [];
      for (let j = 0; j < 4; j++) mods.push([20 + 20 * r(), 2 * Math.PI * r()]);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        let m = 0;
        for (const [fm, p] of mods) m += Math.sin(2 * Math.PI * fm * t + p);
        ch[i] += 0.02 * Math.exp(0.7 * m / Math.SQRT2) * Math.sin(2 * Math.PI * f * t + ph);
      }
    }
  }
  return [L, R];
}

/** Energy of the fast part (above ~10 Hz) of the 6.5-12.5 kHz band envelope, in 2 ms steps. */
function flickerEnergy(x) {
  const h = bandFilter(x, 6500, 12500), blk = Math.round(0.002 * SR), nb = Math.floor(x.length / blk), env = new Float64Array(nb);
  for (let b = 0; b < nb; b++) env[b] = Math.sqrt(energy(h, b * blk, (b + 1) * blk) / blk);
  const W = 25; // +-50 ms moving average = the slow part
  let e = 0;
  for (let b = W; b < nb - W; b++) {
    let m = 0;
    for (let j = -W; j <= W; j++) m += env[b + j];
    e += (env[b] - m / (2 * W + 1)) ** 2;
  }
  return e;
}

// ---- declick --------------------------------------------------------------

test('declick repairs spikes and 1 ms bursts on a sine, and leaves drum hits alone', () => {
  const r = rng(7), clean = sine(440, 0.5, 2), x = new Float32Array(clean), pos = [];
  for (let c = 0; c < 10; c++) {
    const p = Math.round((0.1 + c * 0.18 + r() * 0.05) * SR);
    pos.push(p);
    if (c % 2 === 0) x[p] += r() < 0.5 ? 0.8 : -0.8;                 // single-sample spike
    else for (let j = 0; j < 48; j++) x[p + j] += 0.4 * (2 * r() - 1); // 1 ms burst
  }
  const before = Float32Array.from(x);
  const res = cleanup.declick([x], SR);
  assert.deepEqual(x, before, 'input untouched');
  assert.equal(res.channels[0].length, x.length);
  assert.ok(res.repaired >= 9, `repaired ${res.repaired}`);
  for (const p of pos) {
    const a = p - 96, b = p + 144; // 2 ms before to 3 ms after
    let err = 0;
    for (let i = a; i < b; i++) err += (res.channels[0][i] - clean[i]) ** 2;
    const rel = db(err / energy(clean, a, b));
    assert.ok(rel < -40, `click at ${p}: error ${rel.toFixed(1)} dB`);
  }

  // Decaying noise bursts with 5 ms attacks every 250 ms: real transients.
  const drums = new Float32Array(2 * SR), r2 = rng(3);
  for (let hit = 0; hit < 8; hit++) {
    const s = Math.round(hit * 0.25 * SR);
    for (let j = 0; j < 0.24 * SR; j++) {
      const env = j < 240 ? j / 240 : Math.exp(-(j - 240) / (0.04 * SR));
      drums[s + j] = 0.3 * env * gauss(r2);
    }
  }
  for (const sensitivity of [0.5, 1]) {
    const d = cleanup.declick([drums], SR, { sensitivity });
    assert.ok(d.repaired <= 1, `drums at sensitivity ${sensitivity}: ${d.repaired} repairs`);
  }
});

test('declick ignores note attacks, releases and crossfaded edits on a clean vocal, but still repairs a real click', () => {
  const { x, starts } = vocalNotes();
  const edited = crossfadeEdits(x, starts.map((s) => s - Math.round(0.03 * SR)), starts.map((_, k) => (k % 2 ? -1 : 1) * (96 + 48 * (k % 3))));
  for (const [name, sig] of [['plain', x], ['crossfaded', edited]]) {
    const stereo = [sig, Float32Array.from(sig)];
    for (const sensitivity of [0.5, 1]) {
      assert.equal(cleanup.declick(stereo, SR, { sensitivity }).repaired, 0, `${name} vocal at sensitivity ${sensitivity}`);
    }
    assert.equal(cleanup.cleanAI(stereo, SR, { preset: 'vocal' }).report[0].detail, 'No clicks found', name);

    // A click inside a held note and one in the gap between notes are still found.
    const clicked = Float32Array.from(sig), p1 = Math.round(0.9 * SR), p2 = Math.round(1.15 * SR);
    clicked[p1] += 0.3; clicked[p2] -= 0.2;
    const res = cleanup.declick([clicked, Float32Array.from(clicked)], SR);
    assert.equal(res.repaired, 2, `${name}: repaired ${res.repaired}`);
    for (const p of [p1, p2]) {
      let eIn = 0, eOut = 0;
      for (let i = p - 96; i < p + 144; i++) { eIn += (clicked[i] - sig[i]) ** 2; eOut += (res.channels[0][i] - sig[i]) ** 2; }
      assert.ok(db(eIn / eOut) > 20, `${name}: click at ${p} only reduced ${db(eIn / eOut).toFixed(1)} dB`);
    }
  }
});

// ---- denoise --------------------------------------------------------------

test('denoise lowers the hiss between tone bursts, keeps the tones, and is exact at 0 dB', () => {
  const seconds = 4, n = seconds * SR, r = rng(21), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (Math.floor(t / 0.5) % 2 === 0) for (let h = 1; h <= 10; h++) v += 0.25 / h * Math.sin(2 * Math.PI * 220 * h * t);
    x[i] = v + 0.01 * gauss(r); // white noise at -40 dBFS RMS
  }
  // Steady parts only: skip the gate's ~80 ms release and the 43 ms frame around each switch.
  const parts = (on) => {
    const out = [];
    for (let s = 0; s < seconds / 0.5; s++) {
      if ((s % 2 === 0) !== on) continue;
      out.push([Math.round((s * 0.5 + (on ? 0.05 : 0.15)) * SR), Math.round(((s + 1) * 0.5 - (on ? 0.05 : 0.06)) * SR)]);
    }
    return out;
  };
  const sum = (sig, ranges) => ranges.reduce((acc, [a, b]) => acc + energy(sig, a, b), 0);

  const res = cleanup.denoise([x], SR, { reductionDb: 12 }), y = res.channels[0];
  assert.equal(y.length, n);
  assert.ok(Math.abs(res.noiseFloorDb + 40) < 3, `noise floor ${res.noiseFloorDb} dBFS`);
  assert.equal(res.reductionDb, 12);
  const offDrop = db(sum(x, parts(false)) / sum(y, parts(false)));
  const onChange = db(sum(y, parts(true)) / sum(x, parts(true)));
  assert.ok(offDrop >= 10, `noise only dropped ${offDrop.toFixed(2)} dB`);
  assert.ok(Math.abs(onChange) < 1, `tone parts changed ${onChange.toFixed(3)} dB`);

  // reductionDb 0: the STFT must reconstruct perfectly, edges included (odd length, stereo).
  const L = x.subarray(1, 50001), R = x.subarray(7, 50007);
  const zero = cleanup.denoise([L, R], SR, { reductionDb: 0 });
  let worst = 0;
  for (let i = 0; i < L.length; i++) worst = Math.max(worst, Math.abs(zero.channels[0][i] - L[i]), Math.abs(zero.channels[1][i] - R[i]));
  assert.ok(worst < 1e-6, `max error ${worst}`);
});

// ---- deshimmer ------------------------------------------------------------

test('deshimmer cuts fast HF flicker and narrows the highs without touching the low end', () => {
  const sig = shimmerSignal(), res = cleanup.deshimmer(sig, SR, { amount: 0.8 }), out = res.channels;
  const both = (f, chs) => f(chs[0]) + f(chs[1]);
  const flickerDrop = db(both(flickerEnergy, sig) / both(flickerEnergy, out));
  const hf = (x) => bandEnergy(x, 6500, 12500), lf = (x) => bandEnergy(x, 0, 4200);
  const hfDrop = db(both(hf, sig) / both(hf, out)), lfChange = db(both(lf, out) / both(lf, sig));
  console.log(`deshimmer at 0.8: flicker -${flickerDrop.toFixed(1)} dB, HF energy -${hfDrop.toFixed(1)} dB, below 4 kHz ${lfChange.toFixed(3)} dB (reported ${res.reductionDb} dB)`);
  assert.ok(flickerDrop >= 6, `flicker dropped ${flickerDrop.toFixed(2)} dB`);
  assert.ok(hfDrop >= 6, `HF energy dropped ${hfDrop.toFixed(2)} dB`);
  assert.ok(Math.abs(lfChange) < 0.5, `below 4 kHz changed ${lfChange.toFixed(3)} dB`);
  assert.ok(res.reductionDb > 3);

  // Collateral on legitimate HF: steady noise (cymbal wash) loses little,
  // and hi-hat hits keep their peaks.
  const n = 3 * SR, r = rng(9), wn = new Float32Array(n);
  for (let i = 0; i < n; i++) wn[i] = gauss(r);
  const air = bandFilter(wn, 6000, 16000), wash = Float32Array.from(air, (v) => 0.05 * v), hats = new Float32Array(n);
  for (let i = 0; i < n; i++) { const ph = (i / SR) % 0.125; hats[i] = 0.3 * air[i] * Math.exp(-ph / 0.02) * Math.min(1, ph / 0.0005); }
  const washOut = cleanup.deshimmer([wash], SR, { amount: 0.8 }).channels[0];
  const washDrop = db(hf(wash) / hf(washOut));
  assert.ok(washDrop < 2, `steady HF noise dropped ${washDrop.toFixed(2)} dB`);
  const hatsOut = cleanup.deshimmer([hats, hats], SR, { amount: 0.8 }).channels[0];
  const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(db((peak(hatsOut) / peak(hats)) ** 2)) < 0.5, 'hi-hat peaks kept');

  // amount 0 is a plain copy.
  const off = cleanup.deshimmer(sig, SR, { amount: 0 });
  assert.deepEqual(off.channels[0], sig[0]);
  assert.notEqual(off.channels[0], sig[0]);
});

// ---- de-esser -------------------------------------------------------------

test('deess lowers band-limited "s" bursts and leaves a 300 Hz tone alone', () => {
  const n = 3 * SR, r = rng(4), wn = new Float32Array(n);
  for (let i = 0; i < n; i++) wn[i] = gauss(r);
  const ess = bandFilter(wn, 6000, 9000), essRms = Math.sqrt(energy(ess) / n), x = sine(300, 0.3, 3), bursts = [];
  for (let b = 0; b < 5; b++) {
    const a = Math.round((0.3 + b * 0.55) * SR), L = Math.round(0.08 * SR);
    bursts.push([a, a + L]);
    for (let j = 0; j < L; j++) x[a + j] += 0.15 / essRms * ess[a + j] * Math.min(1, j / 240, (L - j) / 240);
  }
  const burstPeak = (y) => { // loudest 5 ms of the 5.5-9.5 kHz band inside the bursts
    const h = bandFilter(y, 5500, 9500);
    let pk = 0;
    for (const [a, b] of bursts) for (let i = a; i + 240 <= b; i += 120) pk = Math.max(pk, energy(h, i, i + 240));
    return pk;
  };
  const res = cleanup.deess([x], SR), y = res.channels[0];
  const drop = db(burstPeak(x) / burstPeak(y)), toneChange = 20 * Math.log10(toneLevel(y, 300) / toneLevel(x, 300));
  assert.ok(drop >= 4, `burst peak dropped ${drop.toFixed(2)} dB`);
  assert.ok(Math.abs(toneChange) < 0.5, `300 Hz changed ${toneChange.toFixed(3)} dB`);
  assert.ok(res.maxReductionDb > 4 && res.maxReductionDb <= 8, `max reduction ${res.maxReductionDb}`);

  // A bright vowel (harmonics to 8.8 kHz, no "s") is not a sibilant.
  const vowel = new Float32Array(n);
  for (let i = 0; i < n; i++) for (let h = 1; h <= 40; h++) vowel[i] += 0.1 / h * Math.sin(2 * Math.PI * 220 * h * i / SR);
  assert.ok(cleanup.deess([vowel], SR).maxReductionDb < 2);
});

// ---- low end --------------------------------------------------------------

test('lowEnd makes the bass mono, removes rumble and keeps a 1 kHz tone', () => {
  const n = 3 * SR, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, common = 0.2 * Math.sin(2 * Math.PI * 15 * t) + 0.2 * Math.sin(2 * Math.PI * 1000 * t);
    L[i] = common + 0.3 * Math.sin(2 * Math.PI * 60 * t);
    R[i] = common + 0.25 * Math.sin(2 * Math.PI * 60 * t + 1.7);
  }
  const [Lo, Ro] = cleanup.lowEnd([L, R], SR).channels, a = Math.round(0.5 * SR), b = n - Math.round(0.5 * SR);
  const diff = (p, q) => Float32Array.from(p, (v, i) => v - q[i]);
  const sideDrop = db(bandEnergy(diff(L, R), 0, 120, a, b) / bandEnergy(diff(Lo, Ro), 0, 120, a, b));
  const rumbleDrop = db(bandEnergy(L, 5, 25, a, b) / bandEnergy(Lo, 5, 25, a, b));
  const toneChange = db(bandEnergy(Lo, 900, 1100, a, b) / bandEnergy(L, 900, 1100, a, b));
  assert.ok(sideDrop >= 30, `L-R below 120 Hz dropped ${sideDrop.toFixed(1)} dB`);
  assert.ok(rumbleDrop >= 12, `15 Hz dropped ${rumbleDrop.toFixed(1)} dB`);
  assert.ok(Math.abs(toneChange) < 0.3, `1 kHz changed ${toneChange.toFixed(3)} dB`);

  // With the high-pass off, a mono-compatible (L = R) input passes bit for bit.
  const same = cleanup.lowEnd([L, Float32Array.from(L)], SR, { highPassHz: 0 }).channels;
  assert.deepEqual(same[0], L);
  assert.deepEqual(same[1], L);
});

// ---- shape contract -------------------------------------------------------

test('every tool returns new arrays of the input length and never modifies the input', () => {
  const r = rng(33);
  for (const len of [0, 1, 777, 4097, 30011]) {
    for (const nch of [1, 2]) {
      const chans = [];
      for (let c = 0; c < nch; c++) chans.push(Float32Array.from({ length: len }, (_, i) => 0.3 * Math.sin(i * 0.05 * (c + 1)) + 0.01 * gauss(r)));
      const copies = chans.map((ch) => Float32Array.from(ch));
      for (const name of ['declick', 'denoise', 'deshimmer', 'deess', 'lowEnd']) {
        const res = cleanup[name](chans, SR);
        assert.equal(res.channels.length, nch, name);
        res.channels.forEach((ch, c) => {
          assert.ok(ch instanceof Float32Array, name);
          assert.equal(ch.length, len, `${name} length ${len}`);
          assert.notEqual(ch, chans[c], `${name} returned the input array`);
        });
        assertFinite(res.channels);
      }
      chans.forEach((ch, c) => assert.deepEqual(ch, copies[c], 'input modified'));
    }
  }
  assert.throws(() => cleanup.denoise([new Float32Array(10), new Float32Array(11)], SR), /same length/);
  assert.throws(() => cleanup.lowEnd([], SR), /channels/);
});

// ---- the chain --------------------------------------------------------------

test('cleanAI runs every preset on mono and stereo input and reports each step', () => {
  const n = Math.round(1.5 * SR), r = rng(44), base = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    base[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 7300 * t) * (1 + Math.sin(2 * Math.PI * 31 * t)) + 0.003 * gauss(r);
  }
  base[30000] += 0.6;
  const order = ['declick', 'lowEnd', 'denoise', 'deshimmer', 'deess'];
  for (const name of Object.keys(cleanup.presets)) {
    const preset = cleanup.presets[name], enabled = order.filter((s) => preset[s]);
    for (const nch of [1, 2]) {
      const input = nch === 1 ? [base] : [base, Float32Array.from(base, (v, i) => 0.8 * v + 0.01 * Math.sin(i * 0.001))];
      const copies = input.map((ch) => Float32Array.from(ch));
      const progress = [];
      const res = cleanup.cleanAI(input, SR, { preset: name, onProgress: (f) => progress.push(f) });
      assert.equal(res.channels.length, nch);
      res.channels.forEach((ch) => assert.equal(ch.length, n));
      assertFinite(res.channels);
      assert.deepEqual(res.report.map((e) => e.step), enabled, `${name} report`);
      res.report.forEach((e) => assert.ok(typeof e.detail === 'string' && e.detail.length > 3, e.detail));
      input.forEach((ch, c) => assert.deepEqual(ch, copies[c], 'input modified'));
      assert.ok(progress.length > 3 && progress.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= progress[i - 1])), 'progress is monotonic');
      assert.equal(progress[progress.length - 1], 1);
    }
  }
  // A preset name alone, explicit steps, and errors.
  const byName = cleanup.cleanAI([base], SR, 'gentle');
  assert.equal(byName.report.length, order.filter((s) => cleanup.presets.gentle[s]).length);
  assert.match(byName.report[0].detail, /Repaired 1 click$/);
  const custom = cleanup.cleanAI([base, base], SR, { lowEnd: { highPassHz: 50 }, denoise: true });
  assert.deepEqual(custom.report.map((e) => e.step), ['lowEnd', 'denoise']);
  assert.match(custom.report[0].detail, /50 Hz.*mono below 120 Hz/);
  const noDeess = cleanup.cleanAI([base], SR, { preset: 'vocal', deess: false, denoise: { reductionDb: 4 } });
  assert.deepEqual(noDeess.report.map((e) => e.step), ['declick', 'lowEnd', 'denoise', 'deshimmer']);
  assert.match(noDeess.report[2].detail, /reduced up to 4 dB/);
  assert.equal(cleanup.presets.vocal.denoise.reductionDb, 10, 'presets are not mutated');
  assert.throws(() => cleanup.cleanAI([base], SR, 'loud'), /unknown preset/);
});

test('cleanAI with the vocal preset handles 60 s of stereo 48 kHz quickly', () => {
  const n = 60 * SR, r = rng(55), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, note = Math.floor(t / 0.5) % 4 === 3 ? 0 : 1;
    const v = note * (0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.08 * Math.sin(2 * Math.PI * 440 * t) + 0.04 * Math.sin(2 * Math.PI * 660 * t));
    const air = 0.01 * Math.sin(2 * Math.PI * 8100 * t) * (1 + Math.sin(2 * Math.PI * 27 * t));
    L[i] = v + air + 0.003 * gauss(r);
    R[i] = 0.9 * v + air + 0.003 * gauss(r);
  }
  for (let c = 0; c < 20; c++) L[Math.round((1.3 + c * 2.9) * SR)] += 0.5;
  const t0 = Date.now();
  const res = cleanup.cleanAI([L, R], SR, 'vocal');
  const seconds = (Date.now() - t0) / 1000;
  console.log(`cleanAI vocal preset, 60 s stereo 48 kHz: ${seconds.toFixed(2)} s`);
  for (const e of res.report) console.log(`  ${e.step}: ${e.detail}`);
  assert.equal(res.channels[0].length, n);
  assert.ok(seconds < 40, `took ${seconds} s`);
});
