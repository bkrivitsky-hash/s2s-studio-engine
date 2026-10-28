/*
 * Stem to Stream Studio: AI artifact cleanup for Suno songs and stems.
 * Plain signal processing (no neural networks): it can lower clicks, hiss,
 * HF shimmer, harsh "s" sounds, rumble and wide bass. It cannot add detail
 * that the generator never produced, or fix garbled words.
 *
 *   var c = S2S.studio.cleanup;
 *   var r = c.cleanAI([left, right], 48000, 'vocal');   // or { preset: 'mix', onProgress: fn }
 *   r.channels;   // new Float32Arrays, same length as the input
 *   r.report;     // [{ step: 'declick', detail: 'Repaired 3 clicks' }, ...]
 *
 * Every tool takes channels = [Float32Array, ...] (1 or 2 channels), never
 * modifies them, and returns new arrays of exactly the same length.
 *
 * Module pattern used by every file in js/studio/dsp/: the factory is
 * self-contained, so it can also be rebuilt inside a Web Worker from
 * S2S.studio.factories.cleanup.toString().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.factories = root.S2S.studio.factories || {};
    root.S2S.studio.factories.cleanup = factory;
    root.S2S.studio.cleanup = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var fftLib = (typeof module === 'object' && module.exports) ? require('./fft.js') : self.S2S.studio.fft;

  // ---------------------------------------------------------------------------
  // Small helpers

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /** Numeric option with a default (ignores missing, NaN and non-numbers). */
  function opt(o, key, def) {
    var v = o ? o[key] : undefined;
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  function dbToAmp(db) { return Math.pow(10, db / 20); }
  function powToDb(p) { return 10 * Math.log(p > 1e-30 ? p : 1e-30) / Math.LN10; }

  function checkChannels(channels, sampleRate) {
    if (!channels || !channels.length) throw new Error('cleanup: expected channels = [Float32Array, ...].');
    var len = channels[0].length;
    for (var c = 1; c < channels.length; c++) {
      if (channels[c].length !== len) throw new Error('cleanup: all channels must have the same length.');
    }
    if (!(sampleRate > 0)) throw new Error('cleanup: sampleRate must be a positive number.');
    return len;
  }

  function newChannels(count, len) {
    var out = [];
    for (var c = 0; c < count; c++) out.push(new Float32Array(len));
    return out;
  }

  function copyChannels(channels) {
    var out = [];
    for (var c = 0; c < channels.length; c++) out.push(new Float32Array(channels[c]));
    return out;
  }

  /** Progress reporter limited to 0..1, or a no-op. */
  function progressFn(opts) {
    var fn = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
    return function (f) { if (fn) fn(clamp(f, 0, 1)); };
  }

  /** k-th smallest of a[0..n) by quickselect (reorders a). */
  function select(a, n, k) {
    var lo = 0, hi = n - 1;
    while (hi > lo) {
      var pivot = a[(lo + hi) >> 1], i = lo, j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { var t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return a[k];
    }
    return a[k];
  }

  /** Power-of-two frame size closest to `seconds` at this sample rate. */
  function stftSize(sampleRate, seconds) {
    var bits = Math.round(Math.log(seconds * sampleRate) / Math.LN2);
    return 1 << clamp(bits, 6, 15);
  }

  function hzLabel(hz) {
    return hz >= 1000 ? (Math.round(hz / 100) / 10) + ' kHz' : Math.round(hz) + ' Hz';
  }

  // ---------------------------------------------------------------------------
  // Biquads (RBJ cookbook), run in double precision, direct form II transposed

  var BW4_Q = [0.5411961001461970, 1.3065629648763766]; // 4th-order Butterworth = two biquads

  function biquad(type, f0, q, sampleRate) {
    var w0 = 2 * Math.PI * clamp(f0, 1, sampleRate * 0.49) / sampleRate;
    var cw = Math.cos(w0), al = Math.sin(w0) / (2 * q), a0 = 1 + al, b0, b1;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); }
    return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: -2 * cw / a0, a2: (1 - al) / a0 };
  }

  /** Filters x into y (they may be the same array), forwards or backwards in time. */
  function runBiquad(x, y, f, backward) {
    var n = x.length, z1 = 0, z2 = 0, i, v, o;
    var b0 = f.b0, b1 = f.b1, b2 = f.b2, a1 = f.a1, a2 = f.a2;
    if (!backward) {
      for (i = 0; i < n; i++) { v = x[i]; o = b0 * v + z1; z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o; y[i] = o; }
    } else {
      for (i = n - 1; i >= 0; i--) { v = x[i]; o = b0 * v + z1; z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o; y[i] = o; }
    }
  }

  // ---------------------------------------------------------------------------
  // STFT engine with perfect reconstruction.
  // sqrt-Hann analysis and synthesis windows at 75% overlap: the squared windows
  // overlap-add to exactly 2, so an untouched spectrum gives back the input.
  // Frame t starts at t * hop - (n - hop): the signal is padded so every sample
  // is covered by four frames, including the first and last ones.
  // Two real channels share one complex FFT (left in re, right in im).

  function Stft(n) {
    this.n = n;
    this.hop = n >> 2;
    this.nb = (n >> 1) + 1;
    this.fft = new fftLib.FFT(n);
    this.win = new Float64Array(n);
    this.winInv = new Float64Array(n);
    for (var i = 0; i < n; i++) { this.win[i] = Math.sin(Math.PI * i / n); this.winInv[i] = this.win[i] / n; }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  function frameCount(len, n, hop) { return Math.floor((len - 1 + n - hop) / hop) + 1; }

  function makeSpecs(nch, nb) {
    var s = [];
    for (var c = 0; c < nch; c++) s.push({ re: new Float64Array(nb), im: new Float64Array(nb) });
    return s;
  }

  /** Windowed spectra (bins 0..n/2) of the frame starting at `start`, for every channel. */
  Stft.prototype.analyze = function (chs, start, specs) {
    var n = this.n, w = this.win, re = this.re, im = this.im, nb = this.nb, len = chs[0].length;
    var j0 = Math.max(0, -start), j1 = Math.min(n, len - start), j, k;
    for (var c = 0; c < chs.length; c += 2) {
      var a = chs[c], b = c + 1 < chs.length ? chs[c + 1] : null;
      for (j = 0; j < n; j++) { re[j] = 0; im[j] = 0; }
      for (j = j0; j < j1; j++) {
        re[j] = a[start + j] * w[j];
        if (b) im[j] = b[start + j] * w[j];
      }
      this.fft.forward(re, im);
      var A = specs[c], B = b ? specs[c + 1] : null;
      for (k = 0; k < nb; k++) {
        var nk = (n - k) & (n - 1);
        if (B) {
          // split the packed spectrum: X = (Z + conj Z[-k]) / 2, Y = (Z - conj Z[-k]) / 2i
          A.re[k] = 0.5 * (re[k] + re[nk]); A.im[k] = 0.5 * (im[k] - im[nk]);
          B.re[k] = 0.5 * (im[k] + im[nk]); B.im[k] = 0.5 * (re[nk] - re[k]);
        } else {
          A.re[k] = re[k]; A.im[k] = im[k];
        }
      }
    }
  };

  /** Inverse of analyze: windowed frames added into the overlap buffers acc[c]. */
  Stft.prototype.synthesize = function (specs, acc) {
    var n = this.n, nb = this.nb, w = this.win, re = this.re, im = this.im, j, k;
    for (var c = 0; c < specs.length; c += 2) {
      var A = specs[c], B = c + 1 < specs.length ? specs[c + 1] : null;
      for (k = 0; k < nb; k++) {
        var xr = A.re[k], xi = A.im[k], yr = B ? B.re[k] : 0, yi = B ? B.im[k] : 0;
        if (k === 0 || k === nb - 1) { xi = 0; yi = 0; } // DC and Nyquist are real
        re[k] = xr - yi; im[k] = xi + yr;                 // Z = X + iY
        if (k > 0 && k < nb - 1) { re[n - k] = xr + yi; im[n - k] = yr - xi; } // conj(X) + i conj(Y)
      }
      // Unscaled inverse FFT: a forward transform with re and im swapped
      // (skips the shared inverse's divide pass; the 1/n is in winInv).
      this.fft.forward(im, re);
      var a = acc[c], b = B ? acc[c + 1] : null, wi = this.winInv;
      for (j = 0; j < n; j++) a[j] += re[j] * wi[j];
      if (b) for (j = 0; j < n; j++) b[j] += im[j] * wi[j];
    }
  };

  /**
   * Runs one STFT pass over chs with `look` frames of lookahead.
   * hooks.analyzed(a, slot) runs right after frame a is analysed;
   * hooks.process(t, slot) runs before frame t is resynthesised into out.
   * Slots live in a ring of `ring.length` frames.
   */
  function runStft(st, chs, out, ring, look, hooks, prog) {
    var len = chs[0].length, n = st.n, hop = st.hop, T = frameCount(len, n, hop), R = ring.length;
    var nch = chs.length, acc = [], a, c, j;
    for (c = 0; c < nch; c++) acc.push(new Float64Array(n));
    for (a = 0; a < T + look; a++) {
      if (a < T) {
        st.analyze(chs, a * hop - (n - hop), ring[a % R].specs);
        if (hooks.analyzed) hooks.analyzed(a, ring[a % R]);
      }
      if (hooks.tick) hooks.tick(a);
      var t = a - look;
      if (t < 0) continue;
      var slot = ring[t % R];
      if (hooks.process) hooks.process(t, slot);
      st.synthesize(slot.specs, acc);
      var s = t * hop - (n - hop);
      for (c = 0; c < nch; c++) {
        var buf = acc[c], o = out[c];
        for (j = 0; j < hop; j++) {
          var i = s + j;
          if (i >= 0 && i < len) o[i] = buf[j] * 0.5; // squared windows sum to 2
        }
        for (j = hop; j < n; j++) buf[j - hop] = buf[j];
        for (j = n - hop; j < n; j++) buf[j] = 0;
      }
      if (prog && (t & 31) === 0) prog(t / T);
    }
    return T;
  }

  // ---------------------------------------------------------------------------
  // 1. Declick: impulsive discontinuities found in a linear-prediction residual,
  // repaired by least-squares autoregressive interpolation.

  /** Levinson-Durbin: autocorrelation r[0..p] -> predictor a[1..p], x[i] ~ sum a[k] x[i-k]. */
  function levinson(r, p, a, tmp) {
    var m, k;
    for (k = 0; k <= p; k++) a[k] = 0;
    var err = r[0];
    if (!(err > 0)) return;
    for (m = 1; m <= p; m++) {
      var acc = r[m];
      for (k = 1; k < m; k++) acc -= a[k] * r[m - k];
      var kr = acc / err;
      if (!(Math.abs(kr) < 1)) break; // numerical breakdown: keep the lower order
      for (k = 1; k < m; k++) tmp[k] = a[k] - kr * a[m - k];
      for (k = 1; k < m; k++) a[k] = tmp[k];
      a[m] = kr;
      err *= 1 - kr * kr;
      if (!(err > r[0] * 1e-14)) break;
    }
  }

  /**
   * Adds the autocorrelation r[0..p] of the Hann-windowed segment x[s0..s1]
   * into r. `hw` is an optional precomputed window of the same length.
   */
  function addAutocorr(x, s0, s1, p, r, z, hw) {
    var L = s1 - s0 + 1, j, k;
    if (L <= p + 1) return;
    if (hw && hw.length === L) for (j = 0; j < L; j++) z[j] = x[s0 + j] * hw[j];
    else for (j = 0; j < L; j++) z[j] = x[s0 + j] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (j + 0.5) / L));
    for (k = 0; k <= p; k++) {
      var s = 0;
      for (j = k; j < L; j++) s += z[j] * z[j - k];
      r[k] += s;
    }
  }

  /** Solves A x = b in place (b becomes x) for a symmetric positive definite band matrix. */
  function cholSolve(A, m, b, bw) {
    var i, j, k, s, k0;
    for (j = 0; j < m; j++) {
      k0 = Math.max(0, j - bw);
      s = A[j * m + j];
      for (k = k0; k < j; k++) s -= A[j * m + k] * A[j * m + k];
      if (!(s > 0)) return false;
      var d = Math.sqrt(s);
      A[j * m + j] = d;
      for (i = j + 1; i < Math.min(m, j + bw + 1); i++) {
        s = A[i * m + j];
        for (k = Math.max(0, i - bw); k < j; k++) s -= A[i * m + k] * A[j * m + k];
        A[i * m + j] = s / d;
      }
    }
    for (i = 0; i < m; i++) {
      s = b[i];
      for (k = Math.max(0, i - bw); k < i; k++) s -= A[i * m + k] * b[k];
      b[i] = s / A[i * m + i];
    }
    for (i = m - 1; i >= 0; i--) {
      s = b[i];
      for (k = i + 1; k < Math.min(m, i + bw + 1); k++) s -= A[k * m + i] * b[k];
      b[i] = s / A[i * m + i];
    }
    return true;
  }

  /**
   * Least-squares AR interpolation (Janssen, Veldhuis and Vries 1986):
   * chooses y[u0..u1] so the prediction error of filter c[0..p] (c[0] = 1)
   * over the gap and p samples either side is as small as possible.
   */
  function arInterpolate(y, len, u0, u1, c, p) {
    var m = u1 - u0 + 1, s0 = Math.max(0, u0 - p), s1 = Math.min(len - 1, u1 + p);
    var A = new Float64Array(m * m), b = new Float64Array(m), i, k, k1, k2, cc = 0;
    for (i = s0 + p; i <= s1; i++) {
      var e0 = 0;
      for (k = 0; k <= p; k++) { var j = i - k; if (j < u0 || j > u1) e0 += c[k] * y[j]; }
      var kLo = Math.max(0, i - u1), kHi = Math.min(p, i - u0);
      for (k1 = kLo; k1 <= kHi; k1++) {
        var r1 = (i - k1 - u0) * m, c1 = c[k1];
        b[i - k1 - u0] -= c1 * e0;
        for (k2 = kLo; k2 <= kHi; k2++) A[r1 + i - k2 - u0] += c1 * c[k2];
      }
    }
    for (k = 0; k <= p; k++) cc += c[k] * c[k];
    for (i = 0; i < m; i++) A[i * m + i] += 1e-9 * cc + 1e-20; // tiny ridge for safety at the file edges
    if (cholSolve(A, m, b, p)) {
      for (i = 0; i < m; i++) y[u0 + i] = b[i];
      return;
    }
    // Fallback: straight line between the neighbours.
    var ya = u0 > 0 ? y[u0 - 1] : 0, yb = u1 < len - 1 ? y[u1 + 1] : ya;
    for (i = 0; i < m; i++) y[u0 + i] = ya + (yb - ya) * (i + 1) / (m + 1);
  }

  function declickChannel(input, sampleRate, k, maxLen, prog) {
    var len = input.length, P = 16, i, j;
    var x = new Float64Array(len);
    for (i = 0; i < len; i++) x[i] = input[i];
    if (len < 8 * P) return { y: new Float32Array(input), runs: [] };

    // Prediction residual of order-16 predictors fitted on ~21 ms windows that
    // start every ~10 ms. Each sample keeps the smallest residual among three
    // windows: just before its block, starting at its block, and just after.
    // No predictor can anticipate a click, so a click stays large in all of
    // them, while a note onset or release is predicted well by a window that
    // contains the note (one predictor per block made the first milliseconds
    // of a note look like a click).
    var blk = stftSize(sampleRate, 0.0107), win = 2 * blk, nBlk = Math.ceil(len / blk), b;
    var e = new Float64Array(len), r = new Float64Array(P + 1), tmp = new Float64Array(P + 1);
    var z = new Float64Array(win), coef = new Float64Array(nBlk * (P + 1)), a = new Float64Array(P + 1);
    var ok = new Uint8Array(nBlk), hwin = new Float64Array(win);
    for (j = 0; j < win; j++) hwin[j] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (j + 0.5) / win);
    for (b = 0; b < nBlk; b++) {
      var w0 = b * blk, w1 = Math.min(len - 1, w0 + win - 1);
      if (w1 - w0 < 4 * P) continue;
      for (j = 0; j <= P; j++) r[j] = 0;
      addAutocorr(x, w0, w1, P, r, z, hwin);
      r[0] *= 1 + 1e-5; // white-noise correction keeps the predictor well conditioned
      levinson(r, P, a, tmp);
      for (j = 0; j <= P; j++) coef[b * (P + 1) + j] = a[j];
      ok[b] = 1;
      if (prog && (b & 127) === 0) prog(0.2 * b / nBlk);
    }
    // Coefficients of the three predictors side by side: cs[j * 3 + q].
    var cs = new Float64Array((P + 1) * 3), cand = [0, 0, 0];
    for (b = 0; b < nBlk; b++) {
      var b0 = Math.max(b * blk, P), bEnd = Math.min(len, b * blk + blk), nq = 0, q;
      cand[0] = b - 2; cand[1] = b; cand[2] = b + 1;
      for (q = 0; q < 3; q++) {
        var pj = cand[q];
        if (pj < 0 || pj >= nBlk || !ok[pj]) continue;
        for (j = 1; j <= P; j++) cs[j * 3 + nq] = coef[pj * (P + 1) + j];
        nq++;
      }
      for (q = nq; q < 3; q++) for (j = 1; j <= P; j++) cs[j * 3 + q] = cs[j * 3]; // pad with a copy
      for (i = b0; i < bEnd; i++) {
        if (!nq) { e[i] = x[i] - x[i - 1]; continue; }
        var p0 = 0, p1 = 0, p2 = 0;
        for (j = 1; j <= P; j++) {
          var xv = x[i - j], o = j * 3;
          p0 += cs[o] * xv; p1 += cs[o + 1] * xv; p2 += cs[o + 2] * xv;
        }
        var xi = x[i], e0 = xi - p0, best = e0 < 0 ? -e0 : e0, ev = e0, av;
        e0 = xi - p1; av = e0 < 0 ? -e0 : e0; if (av < best) { best = av; ev = e0; }
        e0 = xi - p2; av = e0 < 0 ? -e0 : e0; if (av < best) { ev = e0; }
        e[i] = ev;
      }
      if (prog && (b & 127) === 0) prog(0.2 + 0.3 * b / nBlk);
    }

    // Robust local scale: 1.4826 x median |residual| over ~27 ms (median of
    // five 5 ms medians), floored relative to the music (-60 dB) and
    // absolutely (-94 dBFS).
    var sub = blk >> 1, nSub = Math.ceil(len / sub), scale = new Float64Array(nSub);
    var subMed = new Float64Array(nSub), subPow = new Float64Array(nSub), buf = new Float64Array(sub), five = new Float64Array(5);
    for (var s = 0; s < nSub; s++) {
      var lo = s * sub, hi = Math.min(len, lo + sub), n2 = 0, ss = 0;
      for (i = lo; i < hi; i++) { buf[n2++] = Math.abs(e[i]); ss += x[i] * x[i]; }
      subMed[s] = select(buf, n2, n2 >> 1);
      subPow[s] = ss / n2;
    }
    for (s = 0; s < nSub; s++) {
      var m5 = 0, pw = 0;
      for (j = Math.max(0, s - 2); j <= Math.min(nSub - 1, s + 2); j++) { five[m5++] = subMed[j]; pw += subPow[j]; }
      scale[s] = Math.max(1.4826 * select(five, m5, m5 >> 1), 1e-3 * Math.sqrt(pw / m5), 2e-5);
    }
    if (prog) prog(0.5);

    // Candidate runs: residual above k x scale. Gaps up to P + 0.5 ms are
    // merged: the predictor smears a click over the next P samples, and an
    // oscillating burst is partly predictable in its middle.
    var runs = [], start = -1, last = -1, gap = P + Math.round(0.0005 * sampleRate);
    for (i = 0; i < len; i++) {
      if (Math.abs(e[i]) > k * scale[(i / sub) | 0]) {
        if (start >= 0 && i - last <= gap) last = i;
        else { if (start >= 0) runs.push([start, last]); start = i; last = i; }
      }
    }
    if (start >= 0) runs.push([start, last]);

    // A click must be short, must stand out from BOTH sides (a drum attack has
    // a loud residual right after it), and must not be the start of sustained
    // sound: when the level jumps up after it (a note onset, a consonant), it
    // only counts if it towers over what follows.
    var W = Math.round(0.003 * sampleRate), W2 = Math.round(0.01 * sampleRate), G = 2, accepted = [], ri;
    var side = new Float64Array(W);
    function sideScale(from, to) {
      from = Math.max(0, from); to = Math.min(len - 1, to);
      var n = 0;
      for (var q = from; q <= to; q++) side[n++] = Math.abs(e[q]);
      return n > 8 ? 1.4826 * select(side, n, n >> 1) : 0;
    }
    // The forward residual smears a click over the next P samples. The
    // backward residual (same predictors run in reverse time) smears it the
    // other way, so its last exceedance marks where the click really ends.
    function clickEnd(ra, rb) {
      for (var q = rb; q > ra; q--) {
        if (q + P >= len) continue;
        var bb = (q / blk) | 0, bestAbs = Infinity;
        for (var pj = bb - 2; pj <= bb + 1; pj++) {
          if (pj === bb - 1 || pj < 0 || pj >= nBlk || !ok[pj]) continue;
          var off = pj * (P + 1), pr = 0;
          for (var jj = 1; jj <= P; jj++) pr += coef[off + jj] * x[q + jj];
          bestAbs = Math.min(bestAbs, Math.abs(x[q] - pr));
        }
        if (bestAbs < Infinity && bestAbs > k * scale[(q / sub) | 0]) return q;
      }
      return ra;
    }
    function rms(from, to) {
      from = Math.max(0, from); to = Math.min(len - 1, to);
      var acc = 0;
      for (var q = from; q <= to; q++) acc += x[q] * x[q];
      return to >= from ? Math.sqrt(acc / (to - from + 1)) : 0;
    }
    for (ri = 0; ri < runs.length; ri++) {
      var ra = runs[ri][0], rb = runs[ri][1];
      if (rb - ra + 1 > maxLen) continue;
      var peak = 0;
      for (i = ra; i <= rb; i++) peak = Math.max(peak, Math.abs(e[i]));
      var sB = sideScale(ra - G - W, ra - G - 1), sA = sideScale(rb + G + 1, rb + G + W);
      var floor = scale[(ra / sub) | 0] * 0.25;
      if (!(peak > k * Math.max(sB, sA, floor))) continue;
      var before = rms(ra - G - W2, ra - G - 1), after = rms(rb + G + 1, rb + G + W2);
      if (after > 3 * before && peak < 3 * after) continue;
      accepted.push([ra, clickEnd(ra, rb)]);
    }

    // Repair: least-squares AR interpolation across each click plus 0.1 ms,
    // with an order-40 model (enough for ~20 partials) fitted to ~15 ms of
    // audio on both sides.
    var M = Math.max(2, Math.round(0.0001 * sampleRate)), PR = 40, ctx = Math.round(0.015 * sampleRate);
    var rr = new Float64Array(PR + 1), ar = new Float64Array(PR + 1), cf = new Float64Array(PR + 1);
    var tmp2 = new Float64Array(PR + 1), zz = new Float64Array(ctx + 2), done = [];
    for (ri = 0; ri < accepted.length; ri++) {
      var u0 = Math.max(0, accepted[ri][0] - M), u1 = Math.min(len - 1, accepted[ri][1] + M);
      var prevEnd = done.length ? done[done.length - 1][1] + 1 : 0;
      var nextStart = ri + 1 < accepted.length ? accepted[ri + 1][0] - M - 1 : len - 1;
      var l0 = Math.max(prevEnd, u0 - ctx), r1 = Math.min(nextStart, u1 + ctx), p = PR;
      if ((u0 - l0) + (r1 - u1) < 3 * p) p = 8;
      for (j = 0; j <= PR; j++) rr[j] = 0;
      addAutocorr(x, l0, u0 - 1, p, rr, zz);
      addAutocorr(x, u1 + 1, r1, p, rr, zz);
      rr[0] *= 1 + 1e-6;
      levinson(rr, p, ar, tmp2);
      cf[0] = 1;
      for (j = 1; j <= p; j++) cf[j] = -ar[j];
      arInterpolate(x, len, u0, u1, cf, p);
      done.push([u0, u1]);
      if (prog) prog(0.5 + 0.5 * (ri + 1) / accepted.length);
    }

    var y = new Float32Array(len);
    for (i = 0; i < len; i++) y[i] = x[i];
    return { y: y, runs: done };
  }

  /**
   * Removes clicks and pops.
   * opts: sensitivity 0..1 (0.5), maxClickMs (2), onProgress.
   * Returns { channels, repaired } (repaired counts click events across channels).
   */
  function declick(channels, sampleRate, opts) {
    opts = opts || {};
    var len = checkChannels(channels, sampleRate), nch = channels.length, prog = progressFn(opts);
    var sens = clamp(opt(opts, 'sensitivity', 0.5), 0, 1);
    var maxMs = clamp(opt(opts, 'maxClickMs', 2), 0.05, 20);
    var k = 12 * Math.pow(1.5, 1 - 2 * sens); // threshold in robust standard deviations: 18..12..8
    var maxLen = Math.round(maxMs * sampleRate / 1000) + 16 + Math.round(0.0005 * sampleRate);
    var out = [], regions = [], c, i;
    for (c = 0; c < nch; c++) {
      var res = declickChannel(channels[c], sampleRate, k, maxLen, function (f) { prog((c + f) / nch); });
      out.push(res.y);
      regions = regions.concat(res.runs);
    }
    // Count click events: a click in both channels at once counts once.
    regions.sort(function (p, q) { return p[0] - q[0]; });
    var count = 0, end = -1;
    for (i = 0; i < regions.length; i++) {
      if (regions[i][0] > end) count++;
      end = Math.max(end, regions[i][1]);
    }
    prog(1);
    return { channels: out, repaired: count };
  }

  // ---------------------------------------------------------------------------
  // 2. Denoise: spectral gate against a per-bin noise profile.

  /**
   * Lowers a steady hiss/noise bed.
   * opts: reductionDb (12), sensitivity 0..1 (0.5), onProgress.
   * Returns { channels, noiseFloorDb, reductionDb }.
   */
  function denoise(channels, sampleRate, opts) {
    opts = opts || {};
    var len = checkChannels(channels, sampleRate), nch = channels.length, prog = progressFn(opts);
    var reduction = Math.max(0, opt(opts, 'reductionDb', 12));
    var sens = clamp(opt(opts, 'sensitivity', 0.5), 0, 1);
    var out = newChannels(nch, len);
    if (!len) return { channels: out, noiseFloorDb: -200, reductionDb: 0 };

    var n = stftSize(sampleRate, 0.0427), st = new Stft(n), hop = st.hop, nb = st.nb;
    var T = frameCount(len, n, hop), c, k, t, i;
    var pw = 2 / n; // |X|^2 * 2/n reads as the variance of white noise
    var specs = makeSpecs(nch, nb);

    // Pass 1: histogram of each bin's power (0.5 dB steps) over frames that lie
    // fully inside the signal; long files are sampled with a stride.
    var HB = 520, H0 = -220, HS = 0.5, hist = [];
    for (c = 0; c < nch; c++) hist.push(new Uint32Array(nb * HB));
    var tA = 3, tB = Math.floor((len - hop) / hop);
    if (tB - tA + 1 < 8) { tA = 0; tB = T - 1; }
    var stride = Math.max(1, Math.round((tB - tA + 1) / 1500)), used = 0;
    for (t = tA; t <= tB; t += stride) {
      st.analyze(channels, t * hop - (n - hop), specs);
      used++;
      for (c = 0; c < nch; c++) {
        var S = specs[c], h = hist[c];
        for (k = 0; k < nb; k++) {
          var p = (S.re[k] * S.re[k] + S.im[k] * S.im[k]) * pw;
          var idx = p > 0 ? Math.floor((10 * Math.log(p) / Math.LN10 - H0) / HS) : 0;
          h[k * HB + clamp(idx, 0, HB - 1)]++;
        }
      }
      if ((used & 31) === 0) prog(0.25 * (t - tA) / Math.max(1, tB - tA));
    }

    // Noise power per bin = 10th percentile / 0.1054 (the 10th percentile of
    // Gaussian noise power sits 9.8 dB under its mean). Noise power is spread
    // out: its median sits 8.2 dB over its 10th percentile. A bin whose spread
    // is under 5 dB holds a steady tone (a held pad, the bass), not noise, so
    // it is left out and filled from noise-like neighbours. A median across
    // neighbouring bins then removes the remaining tonal peaks.
    var noise = [], raw = new Float64Array(nb), like = new Uint8Array(nb), tmpMed = new Float64Array(nb), floorPow = 0;
    var need10 = Math.max(1, Math.round(0.1 * used)), need50 = Math.max(1, Math.round(0.5 * used));
    for (c = 0; c < nch; c++) {
      var anyLike = false;
      for (k = 0; k < nb; k++) {
        var cum = 0, b = 0, b10 = -1;
        for (b = 0; b < HB; b++) {
          cum += hist[c][k * HB + b];
          if (b10 < 0 && cum >= need10) b10 = b;
          if (cum >= need50) break;
        }
        raw[k] = Math.pow(10, (H0 + (b10 + 0.5) * HS) / 10) / 0.10536;
        like[k] = (b - b10) * HS >= 5 ? 1 : 0;
        if (like[k]) anyLike = true;
      }
      var prof = new Float64Array(nb);
      for (k = 0; k < nb; k++) {
        var wdt = Math.max(2, Math.round(0.04 * k)), lo = Math.max(0, k - wdt), hi = Math.min(nb - 1, k + wdt), m = 0;
        for (i = lo; i <= hi; i++) if (like[i]) tmpMed[m++] = raw[i];
        if (m) { prof[k] = select(tmpMed, m, m >> 1); continue; }
        // no noise-like bin nearby: take the quieter of the nearest ones on each side
        var left = -1, right = -1;
        for (i = lo - 1; i >= 0; i--) if (like[i]) { left = i; break; }
        for (i = hi + 1; i < nb; i++) if (like[i]) { right = i; break; }
        prof[k] = !anyLike ? 1e-24 : Math.min(left >= 0 ? raw[left] : Infinity, right >= 0 ? raw[right] : Infinity);
      }
      for (k = 0; k < nb; k++) prof[k] = Math.max(prof[k], 1e-24);
      noise.push(prof);
      var tot = prof[0] + prof[nb - 1];
      for (k = 1; k < nb - 1; k++) tot += 2 * prof[k];
      floorPow += tot / n / nch;
    }
    var noiseFloorDb = Math.round(powToDb(floorPow) * 10) / 10;

    // Pass 2: soft gate. Gain reaches the floor below thr - 3 dB and 1 above
    // thr + 3 dB (thr is 3..10 dB over the noise mean by sensitivity), measured
    // on power smoothed over 5 bins and 2 frames. Instant attack, ~80 ms
    // release, then a 3-bin smoothing of the gain, keep "musical noise" down.
    var floorG = dbToAmp(-reduction), thr = 3 + 7 * sens, dLo = thr - 3, dHi = thr + 3;
    var rel = 1 - Math.exp(-hop / (0.08 * sampleRate));
    var gs = new Float64Array(nb), gf = new Float64Array(nb), pc = new Float64Array(nb), best = new Float64Array(nb);
    var prevPd = [];
    for (c = 0; c < nch; c++) prevPd.push(new Float64Array(nb));
    var ring = [{ specs: makeSpecs(nch, nb) }];
    runStft(st, channels, out, ring, 0, {
      process: function (t, slot) {
        var c, k, S;
        for (k = 0; k < nb; k++) best[k] = 0;
        for (c = 0; c < nch; c++) {
          S = slot.specs[c];
          for (k = 0; k < nb; k++) pc[k] = S.re[k] * S.re[k] + S.im[k] * S.im[k];
          var nz = noise[c], pp = prevPd[c];
          for (k = 0; k < nb; k++) {
            var k1 = k > 0 ? k - 1 : 0, k2 = k > 1 ? k - 2 : 0, k3 = k < nb - 1 ? k + 1 : nb - 1, k4 = k < nb - 2 ? k + 2 : nb - 1;
            var pd = (pc[k2] + 2 * pc[k1] + 3 * pc[k] + 2 * pc[k3] + pc[k4]) * (pw / 9);
            var snr = 0.5 * (pd + pp[k]) / nz[k]; // also averaged with the previous frame
            pp[k] = pd;
            if (snr > best[k]) best[k] = snr;
          }
        }
        for (k = 0; k < nb; k++) {
          var g = 1;
          if (floorG < 1) {
            var x = (powToDb(best[k]) - dLo) / (dHi - dLo);
            x = x < 0 ? 0 : (x > 1 ? 1 : x);
            g = floorG + (1 - floorG) * x * x * (3 - 2 * x);
          }
          if (g >= gs[k]) gs[k] = g; else gs[k] += (g - gs[k]) * rel;
        }
        for (k = 0; k < nb; k++) {
          gf[k] = 0.25 * gs[k > 0 ? k - 1 : k] + 0.5 * gs[k] + 0.25 * gs[k < nb - 1 ? k + 1 : k];
        }
        for (c = 0; c < nch; c++) {
          S = slot.specs[c];
          for (k = 0; k < nb; k++) { S.re[k] *= gf[k]; S.im[k] *= gf[k]; }
        }
      }
    }, function (f) { prog(0.25 + 0.75 * f); });
    prog(1);
    return { channels: out, noiseFloorDb: noiseFloorDb, reductionDb: reduction };
  }

  // ---------------------------------------------------------------------------
  // 3. Deshimmer: tames fast HF flicker ("metallic/watery shimmer") and the
  // wide, phasey side signal that comes with it.
  //
  // For every bin above the transition, the log magnitude (smoothed over +-2
  // bins) is followed over +-40 ms. A Hann-weighted straight-line fit gives
  // the slow envelope: steady tones, syllables, tremolo and exponential decays
  // (straight lines in log) sit on it and are left alone. The residual spread
  // around that line is the flicker; the target is the line minus 2 x the
  // spread beyond 1.5 dB (steady noise has about that much), and any excess
  // over the target is pulled down by `amount`. Never boosts.

  /** Weighted sums for the per-bin line fit: sum w*L, sum w*x*L, sum w*L^2. */
  function accumulateFit(row, w, wx, k0, nb, accL, accXL, accLL) {
    for (var k = k0; k < nb; k++) {
      var lv = row[k];
      accL[k] += w * lv; accXL[k] += wx * lv; accLL[k] += w * lv * lv;
    }
  }

  /**
   * opts: amount 0..1 (0.5), fromHz (5000), onProgress.
   * Returns { channels, reductionDb } (HF energy change above fromHz).
   */
  function deshimmer(channels, sampleRate, opts) {
    opts = opts || {};
    var len = checkChannels(channels, sampleRate), nch = channels.length, prog = progressFn(opts);
    var amount = clamp(opt(opts, 'amount', 0.5), 0, 1);
    var fromHz = clamp(opt(opts, 'fromHz', 5000), 200, sampleRate * 0.45);
    if (!len || amount <= 0) { prog(1); return { channels: copyChannels(channels), reductionDb: 0 }; }
    var out = newChannels(nch, len);

    // ~21 ms frames, ~5 ms hop: short enough to follow 20-40 Hz flicker.
    var n = stftSize(sampleRate, 0.0213), st = new Stft(n), hop = st.hop, nb = st.nb;
    var T = frameCount(len, n, hop), k, c, i;

    // Bin weight: 0 below 0.7 x fromHz, raised-cosine up to 1 at fromHz.
    var wk = new Float64Array(nb), f1 = 0.7 * fromHz, k0 = nb, kFrom = nb;
    for (k = 0; k < nb; k++) {
      var f = k * sampleRate / n;
      wk[k] = f >= fromHz ? 1 : (f <= f1 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * (f - f1) / (fromHz - f1)));
      if (wk[k] > 0 && k0 === nb) k0 = k;
      if (f >= fromHz && kFrom === nb) kFrom = k;
    }
    var sideG = new Float64Array(nb);
    for (k = 0; k < nb; k++) sideG[k] = dbToAmp(-6 * amount * wk[k]);

    var W = Math.max(2, Math.round(0.04 * sampleRate / hop));   // envelope fit: +-40 ms
    var WF = Math.max(8, Math.round(0.25 * sampleRate / hop));  // onset threshold: +-250 ms
    var look = W + WF, R = look + W + 2;
    var ring = [];
    for (i = 0; i < R; i++) {
      var lm = [];
      for (c = 0; c < nch; c++) lm.push(new Float64Array(nb));
      ring.push({ specs: makeSpecs(nch, nb), lm: lm, msum: new Float64Array(nb) });
    }
    var hw = new Float64Array(2 * W + 1);
    for (i = -W; i <= W; i++) hw[i + W] = 0.5 + 0.5 * Math.cos(Math.PI * i / (W + 1));
    var flux = new Float32Array(T), fluxHF = new Float32Array(T), onset = new Uint8Array(T);
    var kLow = Math.max(1, Math.round(100 * n / sampleRate));
    var medBuf = new Float64Array(2 * WF + 1), pc = new Float64Array(nb), cs = new Float64Array(nb + 1);
    var B = 2, KAPPA = 2, SIG0 = 1.5 / 8.686, gMin = 0.1;
    var accL = new Float64Array(nb), accXL = new Float64Array(nb), accLL = new Float64Array(nb);
    var eIn = 0, eOut = 0, lastOnset = -1000;

    function median(arr, from, to) {
      var m = 0;
      for (var q = from; q <= to; q++) medBuf[m++] = arr[q];
      return m ? select(medBuf, m, m >> 1) : 0;
    }

    runStft(st, channels, out, ring, look, {
      analyzed: function (a, slot) {
        var c, k, S, ms = slot.msum, lmc;
        for (k = 0; k < nb; k++) ms[k] = 0;
        for (c = 0; c < nch; c++) {
          S = slot.specs[c]; lmc = slot.lm[c];
          cs[0] = 0;
          for (k = 0; k < nb; k++) {
            pc[k] = S.re[k] * S.re[k] + S.im[k] * S.im[k];
            ms[k] += Math.sqrt(pc[k]);
            cs[k + 1] = cs[k] + pc[k];
          }
          // log magnitude of the power averaged over +-B bins
          for (k = k0; k < nb; k++) {
            var lo = k - B < 0 ? 0 : k - B, hi = k + B > nb - 1 ? nb - 1 : k + B;
            lmc[k] = 0.5 * Math.log((cs[hi + 1] - cs[lo]) / (hi - lo + 1) + 1e-12);
          }
        }
        // Positive spectral flux relative to this frame's level, broadband and HF.
        if (a > 0) {
          var prev = ring[(a - 1) % R].msum, pos = 0, sum = 0, posH = 0, sumH = 0, d;
          for (k = kLow; k < nb; k++) {
            d = ms[k] - prev[k];
            sum += ms[k];
            if (d > 0) pos += d;
            if (k >= k0) { sumH += ms[k]; if (d > 0) posH += d; }
          }
          flux[a] = pos / (sum + 1e-20);
          fluxHF[a] = posH / (sumH + 1e-20);
        }
      },
      tick: function (a) {
        // Onset decision for frame d once its +-250 ms neighbourhood is known.
        var d = a - WF;
        if (d < 1 || d >= T) return;
        var lo = Math.max(1, d - WF), hi = Math.min(T - 1, a);
        var mb = median(flux, lo, hi), mh = median(fluxHF, lo, hi);
        if ((flux[d] > 0.25 && flux[d] > 2.5 * mb) || (fluxHF[d] > 0.4 && fluxHF[d] > 2.5 * mh)) onset[d] = 1;
      },
      process: function (t, slot) {
        var c, k, u, S, lmc;
        if (onset[t]) lastOnset = t;
        // The fit window never crosses an onset, and frames right at an onset
        // are left alone, so real transients keep their attack.
        var lo = Math.max(0, t - W, lastOnset), hi = Math.min(T - 1, t + W), nextOn = 1000;
        for (u = t + 1; u <= hi; u++) if (onset[u]) { hi = u - 1; nextOn = u - t; break; }
        var guard = (t - lastOnset <= 3) || nextOn <= 2;
        // Weighted least-squares line L(u) ~ a + b (u - t) over every other
        // frame of the window (frames overlap 75%, so that loses little).
        var u0 = lo + ((lo - t) & 1), sw = 0, sx = 0, sxx = 0;
        for (u = u0; u <= hi; u += 2) { var w = hw[u - t + W], x = u - t; sw += w; sx += w * x; sxx += w * x * x; }
        var det = sw * sxx - sx * sx, invDet = det > 1e-9 ? 1 / det : 0, invSw = 1 / sw;
        for (c = 0; c < nch; c++) {
          S = slot.specs[c]; lmc = slot.lm[c];
          for (k = kFrom; k < nb; k++) eIn += S.re[k] * S.re[k] + S.im[k] * S.im[k];
          if (guard) continue;
          for (k = k0; k < nb; k++) { accL[k] = 0; accXL[k] = 0; accLL[k] = 0; }
          for (u = u0; u <= hi; u += 2) {
            var wu = hw[u - t + W];
            accumulateFit(ring[u % R].lm[c], wu, wu * (u - t), k0, nb, accL, accXL, accLL);
          }
          for (k = k0; k < nb; k++) {
            var sl = accL[k], sxl = accXL[k];
            var slope = (sw * sxl - sx * sl) * invDet, icpt = (sl - slope * sx) * invSw;
            var vr = (accLL[k] - icpt * sl - slope * sxl) * invSw, sd = vr > 0 ? Math.sqrt(vr) : 0;
            var ex = lmc[k] - icpt + (sd > SIG0 ? KAPPA * (sd - SIG0) : 0);
            if (ex > 0) {
              var g = Math.exp(-amount * wk[k] * ex);
              if (g < gMin) g = gMin;
              S.re[k] *= g; S.im[k] *= g;
            }
          }
        }
        if (nch === 2) {
          // Narrow the image above fromHz: side signal down by up to amount x 6 dB.
          var L = slot.specs[0], Rr = slot.specs[1];
          for (k = k0; k < nb; k++) {
            var mr = 0.5 * (L.re[k] + Rr.re[k]), mi = 0.5 * (L.im[k] + Rr.im[k]);
            var sr = 0.5 * (L.re[k] - Rr.re[k]) * sideG[k], si = 0.5 * (L.im[k] - Rr.im[k]) * sideG[k];
            L.re[k] = mr + sr; L.im[k] = mi + si; Rr.re[k] = mr - sr; Rr.im[k] = mi - si;
          }
        }
        for (c = 0; c < nch; c++) {
          S = slot.specs[c];
          for (k = kFrom; k < nb; k++) eOut += S.re[k] * S.re[k] + S.im[k] * S.im[k];
        }
      }
    }, prog);
    prog(1);
    var red = eOut > 0 && eIn > 0 ? powToDb(eIn / eOut) : 0;
    return { channels: out, reductionDb: Math.round(Math.max(0, red) * 10) / 10 };
  }

  // ---------------------------------------------------------------------------
  // 4. De-esser: split band, subtractive, linked across channels.

  /**
   * opts: thresholdDb (-30, dBFS on the band envelope), rangeDb (8),
   * fromHz (5500), toHz (10000), onProgress.
   * Returns { channels, maxReductionDb }.
   */
  function deess(channels, sampleRate, opts) {
    opts = opts || {};
    var len = checkChannels(channels, sampleRate), nch = channels.length, prog = progressFn(opts);
    var thrDb = opt(opts, 'thresholdDb', -30), range = Math.max(0, opt(opts, 'rangeDb', 8));
    var fa = clamp(opt(opts, 'fromHz', 5500), 500, sampleRate * 0.45);
    var fb = clamp(opt(opts, 'toHz', 10000), fa * 1.05, sampleRate * 0.5);
    if (!len || range <= 0) { prog(1); return { channels: copyChannels(channels), maxReductionDb: 0 }; }
    var i, j, c;

    // Side chain: 4th-order Butterworth band (causal) and full-band power, averaged over channels.
    var flt = [biquad('hp', fa, BW4_Q[0], sampleRate), biquad('hp', fa, BW4_Q[1], sampleRate)];
    if (fb < sampleRate * 0.49) flt.push(biquad('lp', fb, BW4_Q[0], sampleRate), biquad('lp', fb, BW4_Q[1], sampleRate));
    var bandPow = new Float64Array(len), fullPow = new Float64Array(len), tmp = new Float64Array(len);
    for (c = 0; c < nch; c++) {
      var x = channels[c];
      for (i = 0; i < len; i++) { tmp[i] = x[i]; fullPow[i] += x[i] * x[i] / nch; }
      for (j = 0; j < flt.length; j++) runBiquad(tmp, tmp, flt[j], false);
      for (i = 0; i < len; i++) bandPow[i] += tmp[i] * tmp[i] / nch;
    }
    prog(0.2);

    // Envelopes (1 ms attack, 60 ms release). Reduce when the band is over the
    // threshold AND dominates the full band (s-sounds do, bright vowels don't).
    var aAtt = 1 - Math.exp(-1 / (0.001 * sampleRate)), aRel = 1 - Math.exp(-1 / (0.06 * sampleRate));
    var thrPow = Math.pow(10, thrDb / 10), eB = 0, eF = 0, maxRed = 0;
    var gain = tmp; // reuse
    for (i = 0; i < len; i++) {
      var pb = bandPow[i], pf = fullPow[i], red = 0;
      eB += (pb > eB ? aAtt : aRel) * (pb - eB);
      eF += (pf > eF ? aAtt : aRel) * (pf - eF);
      if (eB > thrPow) {
        var over = powToDb(eB) - thrDb, relDb = powToDb(eB) - powToDb(eF + 1e-30);
        var dom = clamp((relDb + 15) / 9, 0, 1);
        red = Math.min(range, over) * dom;
        if (red > maxRed) maxRed = red;
      }
      gain[i] = red > 0 ? dbToAmp(-red) : 1;
    }
    prog(0.4);

    // Linear-phase band-pass (Hann-windowed sinc, ~2.8 ms long), only evaluated
    // where the gain is below 1: out = x - (1 - g) * band(x). Outside the band
    // and wherever g = 1 the signal is untouched. Gain looks ahead 1 ms.
    var H = Math.max(8, Math.round(0.0014 * sampleRate)), h = new Float64Array(H + 1);
    var wa = fa / sampleRate, wb = Math.min(0.5, fb / sampleRate);
    h[0] = 2 * (wb - wa);
    for (j = 1; j <= H; j++) {
      h[j] = (Math.sin(2 * Math.PI * wb * j) - Math.sin(2 * Math.PI * wa * j)) / (Math.PI * j) * (0.5 + 0.5 * Math.cos(Math.PI * j / (H + 1)));
    }
    var la = Math.max(1, Math.round(0.001 * sampleRate)), out = [];
    for (c = 0; c < nch; c++) {
      var src = channels[c], y = new Float32Array(src);
      for (i = 0; i < len; i++) {
        var g = Math.min(gain[i], gain[i + la < len ? i + la : len - 1]);
        if (g > 0.999999) continue;
        var bsum = h[0] * src[i];
        for (j = 1; j <= H; j++) {
          var aI = i - j, bI = i + j;
          bsum += h[j] * ((aI >= 0 ? src[aI] : 0) + (bI < len ? src[bI] : 0));
        }
        y[i] = src[i] - (1 - g) * bsum;
      }
      out.push(y);
      prog(0.4 + 0.6 * (c + 1) / nch);
    }
    return { channels: out, maxReductionDb: Math.round(maxRed * 10) / 10 };
  }

  // ---------------------------------------------------------------------------
  // 5. Low end: rumble high-pass and mono bass.

  /**
   * opts: highPassHz (30, 0 = off), monoBelowHz (120, 0 = off; stereo only).
   * Returns { channels }.
   */
  function lowEnd(channels, sampleRate, opts) {
    opts = opts || {};
    var len = checkChannels(channels, sampleRate), nch = channels.length, prog = progressFn(opts);
    var hp = Math.max(0, opt(opts, 'highPassHz', 30)), mono = Math.max(0, opt(opts, 'monoBelowHz', 120));
    var work = [], c, i, j;
    for (c = 0; c < nch; c++) {
      var w = new Float64Array(len), x = channels[c];
      for (i = 0; i < len; i++) w[i] = x[i];
      // 4th-order Butterworth high-pass (two cascaded biquads) against rumble.
      if (hp > 0 && len) {
        runBiquad(w, w, biquad('hp', hp, BW4_Q[0], sampleRate), false);
        runBiquad(w, w, biquad('hp', hp, BW4_Q[1], sampleRate), false);
      }
      work.push(w);
    }
    prog(0.5);
    if (mono > 0 && nch === 2 && len) {
      // Mono bass: zero-phase Linkwitz-Riley crossover on the side signal.
      // The 4th-order Butterworth low-pass run forwards and backwards has the
      // LR8 magnitude and no phase shift, so S - low(S) is its exact
      // complement: highs and the mid signal pass bit-for-bit.
      var f = Math.min(mono, sampleRate * 0.45), L = work[0], R = work[1], s = new Float64Array(len);
      for (i = 0; i < len; i++) s[i] = 0.5 * (L[i] - R[i]);
      var lp = [biquad('lp', f, BW4_Q[0], sampleRate), biquad('lp', f, BW4_Q[1], sampleRate)];
      for (j = 0; j < 2; j++) runBiquad(s, s, lp[j], false);
      for (j = 0; j < 2; j++) runBiquad(s, s, lp[j], true);
      for (i = 0; i < len; i++) { L[i] -= s[i]; R[i] += s[i]; }
    }
    var out = [];
    for (c = 0; c < nch; c++) out.push(new Float32Array(work[c]));
    prog(1);
    return { channels: out };
  }

  // ---------------------------------------------------------------------------
  // 6. Presets and 7. the one-button chain

  var presets = {
    // A Suno vocal stem: mono-ish, hiss and shimmer between phrases, harsh "s".
    vocal: {
      declick: { sensitivity: 0.5, maxClickMs: 2 },
      lowEnd: { highPassHz: 80, monoBelowHz: 0 },
      denoise: { reductionDb: 10, sensitivity: 0.5 },
      deshimmer: { amount: 0.5, fromHz: 6000 },
      deess: { thresholdDb: -30, rangeDb: 6, fromHz: 5500, toHz: 10000 }
    },
    // A full mix or instrumental: keep the music, only clean the edges.
    mix: {
      declick: { sensitivity: 0.5, maxClickMs: 2 },
      lowEnd: { highPassHz: 30, monoBelowHz: 120 },
      denoise: { reductionDb: 6, sensitivity: 0.4 },
      deshimmer: { amount: 0.4, fromHz: 7000 },
      deess: false
    },
    // About half of "mix".
    gentle: {
      declick: { sensitivity: 0.35, maxClickMs: 1.5 },
      lowEnd: { highPassHz: 20, monoBelowHz: 80 },
      denoise: { reductionDb: 3, sensitivity: 0.3 },
      deshimmer: { amount: 0.2, fromHz: 7000 },
      deess: false
    }
  };

  var ORDER = ['declick', 'lowEnd', 'denoise', 'deshimmer', 'deess'];
  var COST = { declick: 1, lowEnd: 0.2, denoise: 2.5, deshimmer: 3, deess: 0.8 };

  function merge(a, b) {
    var o = {}, key;
    for (key in a) if (Object.prototype.hasOwnProperty.call(a, key)) o[key] = a[key];
    for (key in b) if (Object.prototype.hasOwnProperty.call(b, key)) o[key] = b[key];
    return o;
  }

  /** Step options from a preset name or { preset?, declick?, lowEnd?, ... }. */
  function resolvePlan(opts) {
    if (typeof opts === 'string') opts = { preset: opts };
    opts = opts || {};
    var hasSteps = false, i, name;
    for (i = 0; i < ORDER.length; i++) if (opts[ORDER[i]] !== undefined) hasSteps = true;
    var base = null;
    if (opts.preset) {
      base = presets[opts.preset];
      if (!base) throw new Error('cleanup: unknown preset "' + opts.preset + '".');
    } else if (!hasSteps) {
      base = presets.mix;
    }
    var plan = {};
    for (i = 0; i < ORDER.length; i++) {
      name = ORDER[i];
      var fromBase = base ? base[name] : false, v = opts[name] !== undefined ? opts[name] : fromBase;
      if (v === true) v = fromBase || {};
      else if (v && typeof v === 'object' && fromBase) v = merge(fromBase, v);
      plan[name] = v ? merge(v, {}) : false;
    }
    return plan;
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /**
   * Runs the enabled steps in order: declick, lowEnd, denoise, deshimmer, deess.
   * opts: a preset name ('vocal', 'mix', 'gentle'), or { preset, onProgress,
   * declick: false | {...}, lowEnd, denoise, deshimmer, deess }.
   * Returns { channels, report: [{ step, detail }] }.
   */
  function cleanAI(channels, sampleRate, opts) {
    checkChannels(channels, sampleRate);
    var plan = resolvePlan(opts), prog = progressFn(typeof opts === 'object' ? opts : null);
    var total = 0, done = 0, i, name, cur = channels, report = [];
    for (i = 0; i < ORDER.length; i++) if (plan[ORDER[i]]) total += COST[ORDER[i]];
    for (i = 0; i < ORDER.length; i++) {
      name = ORDER[i];
      var o = plan[name];
      if (!o) continue;
      var span = COST[name] / total, base = done;
      o.onProgress = function (f) { prog(base + span * f); };
      var res, detail;
      if (name === 'declick') {
        res = declick(cur, sampleRate, o);
        detail = res.repaired ? 'Repaired ' + plural(res.repaired, 'click') : 'No clicks found';
      } else if (name === 'lowEnd') {
        res = lowEnd(cur, sampleRate, o);
        var hp = Math.max(0, opt(o, 'highPassHz', 30)), mono = Math.max(0, opt(o, 'monoBelowHz', 120)), parts = [];
        if (hp > 0) parts.push('Rumble cut below ' + hzLabel(hp));
        if (mono > 0 && cur.length === 2) parts.push('bass mono below ' + hzLabel(mono));
        detail = parts.length ? parts.join(', ') : 'No change';
      } else if (name === 'denoise') {
        res = denoise(cur, sampleRate, o);
        detail = 'Noise floor ' + Math.round(res.noiseFloorDb) + ' dBFS, reduced up to ' + res.reductionDb + ' dB';
      } else if (name === 'deshimmer') {
        res = deshimmer(cur, sampleRate, o);
        detail = (res.reductionDb >= 0.1
          ? 'Shimmer above ' + hzLabel(opt(o, 'fromHz', 5000)) + ' reduced about ' + res.reductionDb.toFixed(1) + ' dB'
          : 'No shimmer found above ' + hzLabel(opt(o, 'fromHz', 5000))) + (cur.length === 2 ? ', highs narrowed' : '');
      } else {
        res = deess(cur, sampleRate, o);
        detail = res.maxReductionDb >= 0.1
          ? 'Sibilance ' + hzLabel(opt(o, 'fromHz', 5500)) + ' to ' + hzLabel(opt(o, 'toHz', 10000)) + ' reduced up to ' + res.maxReductionDb.toFixed(1) + ' dB'
          : 'No harsh sibilance found';
      }
      cur = res.channels;
      report.push({ step: name, detail: detail });
      done += span;
    }
    if (cur === channels) cur = copyChannels(channels);
    prog(1);
    return { channels: cur, report: report };
  }

  return {
    declick: declick,
    denoise: denoise,
    deshimmer: deshimmer,
    deess: deess,
    lowEnd: lowEnd,
    presets: presets,
    cleanAI: cleanAI
  };
});
