// Unit tests for the shared FFT used by the studio's vocal tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FFT, hann } = require('../js/studio/dsp/fft.js');

test('FFT matches a direct DFT and inverts exactly', () => {
  const n = 64, f = new FFT(n);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.37) + 0.2 * Math.cos(i * 1.9); im[i] = 0.1 * Math.sin(i); }
  const r0 = Float64Array.from(re), i0 = Float64Array.from(im);
  f.forward(re, im);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = -2 * Math.PI * k * t / n;
      sr += r0[t] * Math.cos(a) - i0[t] * Math.sin(a);
      si += r0[t] * Math.sin(a) + i0[t] * Math.cos(a);
    }
    assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9, `bin ${k}`);
  }
  f.inverse(re, im);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - r0[i]) < 1e-12 && Math.abs(im[i] - i0[i]) < 1e-12);
});

test('a sine lands in its bin, and Hann windows overlap-add to a constant', () => {
  const n = 1024, f = new FFT(n), re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos(2 * Math.PI * 37 * i / n);
  f.forward(re, im);
  assert.ok(Math.abs(Math.hypot(re[37], im[37]) - n / 2) < 1e-6);
  assert.ok(Math.hypot(re[36], im[36]) < 1e-6);
  const w = hann(n), hop = n / 4, sum = new Float64Array(n);
  for (let s = 0; s < n; s += hop) for (let i = 0; i < n; i++) sum[(s + i) % n] += w[i];
  for (let i = 0; i < n; i++) assert.ok(Math.abs(sum[i] - 2) < 1e-9);
  assert.throws(() => new FFT(100), /power of two/);
});
