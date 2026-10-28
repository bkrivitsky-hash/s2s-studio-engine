// Unit tests for melody to MIDI (js/studio/dsp/melody.js). Signals are
// synthesised here: a sung-like line with vibrato, a re-sung syllable on
// the same pitch, rests, a slide and an overall tuning offset.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/studio/dsp/melody.js');

const SR = 44100;

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

/**
 * Renders notes [{p, t, d, amp, slideFrom?}] as a vowel-like voice: formant-
 * shaped harmonics, 5.5 Hz vibrato of `vibCents`, 12 ms attack, 40 ms release,
 * all detuned by `cents`.
 */
function sing(notes, seconds, opts = {}) {
  const x = new Float32Array(Math.round(seconds * SR)), rand = rng(5);
  const cents = opts.cents || 0, vib = opts.vibCents == null ? 25 : opts.vibCents;
  for (const nt of notes) {
    const s0 = Math.round(nt.t * SR), n = Math.round(nt.d * SR), att = 0.012 * SR, rel = 0.04 * SR;
    let ph = 0;
    for (let i = 0; i < n && s0 + i < x.length; i++) {
      const tt = i / SR;
      let m = nt.p + cents / 100 + (vib / 100) * Math.sin(2 * Math.PI * 5.5 * tt) * Math.min(1, tt / 0.2);
      if (nt.slideFrom != null && tt < 0.06) m = nt.slideFrom + (m - nt.slideFrom) * (tt / 0.06);
      const f = 440 * Math.pow(2, (m - 69) / 12);
      ph += 2 * Math.PI * f / SR;
      let g = Math.min(1, i / att, (n - i) / rel);
      let v = 0;
      for (let h = 1; h * f < 6000; h++) {
        const hf = h * f;
        v += Math.sin(h * ph) * (Math.exp(-(((hf - 650) / 300) ** 2)) + 0.5 * Math.exp(-(((hf - 1100) / 350) ** 2)) + 0.06) / Math.sqrt(h);
      }
      x[s0 + i] += (nt.amp || 0.5) * g * v * 0.4;
    }
  }
  for (let i = 0; i < x.length; i++) x[i] += 0.002 * (rand() * 2 - 1);
  return x;
}

const LINE = [
  { p: 60, t: 0.30, d: 0.40, amp: 0.5 },
  { p: 62, t: 0.75, d: 0.40, amp: 0.5 },
  { p: 64, t: 1.20, d: 0.70, amp: 0.7 },
  { p: 64, t: 1.92, d: 0.35, amp: 0.5 },   // the same pitch sung again right away
  { p: 67, t: 2.60, d: 0.50, amp: 0.25, slideFrom: 64.5 },
  { p: 65, t: 3.20, d: 0.30, amp: 0.5 },
  { p: 57, t: 3.70, d: 0.80, amp: 0.6 }
];

test('a sung line comes back as the right notes, in time, with tuning removed', () => {
  const x = sing(LINE, 5, { cents: 28 });
  const r = M.transcribe([x, x], SR, {});
  assert.ok(Math.abs(r.tuningCents - 28) <= 8, `tuning ${r.tuningCents}`);
  assert.deepEqual(r.notes.map((n) => n.p), LINE.map((n) => n.p), JSON.stringify(r.notes.map((n) => [n.p, +n.t.toFixed(3), +n.d.toFixed(3)])));
  r.notes.forEach((n, i) => {
    assert.ok(Math.abs(n.t - LINE[i].t) < 0.03, `note ${i} starts at ${n.t}, sung at ${LINE[i].t}`);
    assert.ok(Math.abs(n.t + n.d - (LINE[i].t + LINE[i].d)) < 0.07, `note ${i} ends at ${n.t + n.d}, sung until ${LINE[i].t + LINE[i].d}`);
  });
  assert.ok(r.notes[2].v > r.notes[4].v, 'the loud note has a higher velocity than the quiet one');
  assert.ok(r.voicedSeconds > 3 && r.voicedSeconds < 4.2, String(r.voicedSeconds));
});

test('a window keeps source times and only the notes inside it', () => {
  const x = sing(LINE, 5, {});
  const r = M.transcribe([x], SR, { from: 1.17, to: 3.0 });
  assert.deepEqual(r.notes.map((n) => n.p), [64, 64, 67]);
  assert.ok(Math.abs(r.notes[0].t - 1.2) < 0.03);
});

test('hiss and silence give no notes', () => {
  const hiss = new Float32Array(SR * 2), rand = rng(9);
  for (let i = 0; i < hiss.length; i++) hiss[i] = 0.01 * (rand() * 2 - 1);
  assert.equal(M.transcribe([hiss], SR, {}).notes.length, 0);
  assert.equal(M.transcribe([new Float32Array(SR)], SR, {}).notes.length, 0);
  assert.equal(M.transcribe([new Float32Array(100)], SR, {}).notes.length, 0);
});

test('tuning offset: consistent offsets count, random ones do not', () => {
  const consistent = Float64Array.from({ length: 200 }, (_, i) => 60 + (i % 5) + 0.3);
  assert.equal(M.tuningOf(consistent), 30);
  const wrap = Float64Array.from({ length: 200 }, (_, i) => 60 + (i % 5) - 0.4);
  assert.equal(M.tuningOf(wrap), -40);
  const random = Float64Array.from({ length: 400 }, (_, i) => 60 + ((i * 37) % 100) / 100);
  assert.equal(M.tuningOf(random), 0);
});
