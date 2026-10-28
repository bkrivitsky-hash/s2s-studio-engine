/*
 * Stem to Stream Studio: radix-2 FFT and analysis windows, shared by the
 * vocal tools (pitch, timing, cleanup).
 *
 *   var f = new S2S.studio.fft.FFT(2048);
 *   f.forward(re, im);   // in place, re/im are Float64Array(2048)
 *   f.inverse(re, im);   // in place, scaled by 1/n
 *
 * Module pattern used by every file in js/studio/dsp/: the factory is
 * self-contained, so it can also be rebuilt inside a Web Worker from
 * S2S.studio.factories.<name>.toString().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.factories = root.S2S.studio.factories || {};
    root.S2S.studio.factories.fft = factory;
    root.S2S.studio.fft = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function FFT(n) {
    if (!(n >= 2) || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two.');
    this.n = n;
    var bits = Math.round(Math.log(n) / Math.LN2);
    this.rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0, x = i;
      for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
  }

  FFT.prototype.transform = function (re, im, inverse) {
    var n = this.n, rev = this.rev, i, j, t;
    for (i = 0; i < n; i++) {
      j = rev[i];
      if (j > i) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    var sign = inverse ? 1 : -1;
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (i = 0; i < n; i += size) {
        for (j = 0, t = 0; j < half; j++, t += step) {
          var wr = this.cos[t], wi = sign * this.sin[t];
          var a = i + j, b2 = a + half;
          var xr = re[b2] * wr - im[b2] * wi;
          var xi = re[b2] * wi + im[b2] * wr;
          re[b2] = re[a] - xr; im[b2] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
    if (inverse) {
      for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  };

  FFT.prototype.forward = function (re, im) { this.transform(re, im, false); };
  FFT.prototype.inverse = function (re, im) { this.transform(re, im, true); };

  /** Periodic Hann window (sums to a constant at 50% and 75% overlap). */
  function hann(n) {
    var w = new Float64Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
  }

  /** Frequency in Hz of FFT bin k. */
  function binHz(k, n, sampleRate) { return k * sampleRate / n; }

  return { FFT: FFT, hann: hann, binHz: binHz };
});
