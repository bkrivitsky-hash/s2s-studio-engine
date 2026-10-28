/*
 * Stem to Stream Studio: pitch correction ("auto-tune") for an isolated vocal
 * stem, and song key detection.
 *
 *   var P = S2S.studio.pitch;
 *   var key = P.estimateKey([left, right], 48000);       // { name: 'A minor', ... }
 *   var res = P.autoTune([left, right], 48000, { key: 'A', mode: 'minor', speed: 40 });
 *   // res.channels: tuned audio, same length; res.report: key, cents off before/after
 *
 * The chain is: yin() pitch track (f0 every 5 ms) -> targetRatios() per-frame
 * pitch-shift ratio toward the nearest scale note -> psola() TD-PSOLA
 * resynthesis, which keeps the duration and the formants (no chipmunk voice).
 *
 * Same module pattern as fft.js: the factory is self-contained, so it can also
 * be rebuilt inside a Web Worker from S2S.studio.factories.pitch.toString().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.factories = root.S2S.studio.factories || {};
    root.S2S.studio.factories.pitch = factory;
    root.S2S.studio.pitch = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var fftLib = (typeof module === 'object' && module.exports) ? require('./fft.js') : self.S2S.studio.fft;

  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var FLAT_NAMES = { DB: 1, EB: 3, GB: 6, AB: 8, BB: 10, CB: 11, FB: 4, 'E#': 5, 'B#': 0 };
  var SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],          // natural minor
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  };
  // Krumhansl-Kessler probe-tone profiles, tonic first.
  var KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  /* ---------- small helpers ---------- */

  function opt(o, name, def) {
    return (o && o[name] !== undefined && o[name] !== null) ? o[name] : def;
  }

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  function report(o, f) {
    if (o && typeof o.onProgress === 'function') o.onProgress(clamp(f, 0, 1));
  }

  // onProgress for one stage of a longer job, mapped into [from, to].
  function stage(o, from, to) {
    if (!o || typeof o.onProgress !== 'function') return null;
    return function (f) { o.onProgress(clamp(from + (to - from) * f, 0, 1)); };
  }

  function hzToMidi(f) { return 69 + 12 * Math.log(f / 440) / Math.LN2; }

  function mod12(x) { return ((x % 12) + 12) % 12; }

  /** Average of all channels (the same array back when there is only one). */
  function mixdown(channels) {
    if (!channels || !channels.length) return new Float32Array(0);
    if (channels.length === 1) return channels[0];
    var n = channels[0].length, out = new Float32Array(n), c, i, g = 1 / channels.length;
    for (c = 0; c < channels.length; c++) {
      var ch = channels[c];
      for (i = 0; i < n; i++) out[i] += ch[i];
    }
    for (i = 0; i < n; i++) out[i] *= g;
    return out;
  }

  /** Pitch class 0-11 from 'C', 'F#', 'Bb' or a number. */
  function keyIndex(key) {
    if (typeof key === 'number' && isFinite(key)) return mod12(Math.round(key));
    var s = String(key || '').trim();
    var up = s.charAt(0).toUpperCase() + s.slice(1);
    var i = NOTE_NAMES.indexOf(up);
    if (i >= 0) return i;
    if (FLAT_NAMES[up.toUpperCase()] !== undefined) return FLAT_NAMES[up.toUpperCase()];
    throw new Error('Unknown key: ' + key);
  }

  function modeName(mode) {
    var m = String(mode || 'major').toLowerCase();
    if (m === 'major' || m === 'maj' || m === 'ionian') return 'major';
    if (m === 'minor' || m === 'min' || m === 'aeolian') return 'minor';
    if (m === 'chromatic') return 'chromatic';
    throw new Error('Unknown mode: ' + mode);
  }

  /** Sorted pitch classes of a scale. */
  function scale(key, mode) {
    var root = keyIndex(key), steps = SCALES[modeName(mode)], out = [];
    for (var i = 0; i < steps.length; i++) out.push((root + steps[i]) % 12);
    return out.sort(function (a, b) { return a - b; });
  }

  function allowedTable(key, mode) {
    var pcs = scale(key, mode), t = [];
    for (var i = 0; i < 12; i++) t.push(false);
    for (i = 0; i < pcs.length; i++) t[pcs[i]] = true;
    return t;
  }

  /** Nearest allowed MIDI note (integer) to fractional MIDI pitch m. */
  function nearestNote(m, allowed) {
    var best = Math.round(m), bestD = Infinity, lo = Math.floor(m) - 6, hi = Math.ceil(m) + 6;
    for (var k = lo; k <= hi; k++) {
      if (!allowed[mod12(k)]) continue;
      var d = Math.abs(m - k);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  function median(arr, from, to, tmp) {
    var n = to - from, i, j;
    for (i = 0; i < n; i++) tmp[i] = arr[from + i];
    // Insertion sort: windows here are a handful of values.
    for (i = 1; i < n; i++) {
      var v = tmp[i];
      for (j = i - 1; j >= 0 && tmp[j] > v; j--) tmp[j + 1] = tmp[j];
      tmp[j + 1] = v;
    }
    return (n & 1) ? tmp[(n - 1) >> 1] : 0.5 * (tmp[n / 2 - 1] + tmp[n / 2]);
  }

  /*
   * Low-pass (Blackman-windowed sinc) and keep every `factor`-th sample, into
   * a buffer with `pad` zeros on both sides (so frame loops need no bounds
   * checks). Analysis only, so a short filter is enough.
   */
  function decimate(x, factor, pad) {
    var n = x.length, m = Math.ceil(n / factor), out = new Float64Array(m + 2 * pad), i, k;
    if (factor <= 1) {
      for (i = 0; i < n; i++) out[pad + i] = x[i];
      return out;
    }
    var half = 8 * factor, len = 2 * half + 1, taps = new Float64Array(len), fc = 0.4 / factor, sum = 0;
    for (k = 0; k < len; k++) {
      var t = k - half;
      var s = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
      var w = 0.42 + 0.5 * Math.cos(Math.PI * t / (half + 1)) + 0.08 * Math.cos(2 * Math.PI * t / (half + 1));
      taps[k] = s * w; sum += taps[k];
    }
    for (k = 0; k < len; k++) taps[k] /= sum;
    for (var j = 0; j < m; j++) {
      var c = j * factor - half, acc = 0;
      if (c >= 0 && c + len <= n) {
        for (k = 0; k < len; k++) acc += taps[k] * x[c + k];
      } else {
        for (k = 0; k < len; k++) { var idx = c + k; if (idx >= 0 && idx < n) acc += taps[k] * x[idx]; }
      }
      out[pad + j] = acc;
    }
    return out;
  }

  /* ---------- 1. YIN pitch tracking ---------- */

  /*
   * f0 per frame with YIN (de Cheveigne & Kawahara 2002). The signal is
   * analysed at ~16 kHz and the difference function comes from an FFT
   * autocorrelation, so a minute of vocal takes about a second.
   *   opts: minHz 70, maxHz 1100, hopSeconds 0.005, windowSeconds 0.04,
   *         threshold 0.12, gateDb -50 (quieter frames are unvoiced), onProgress
   *   -> { hop (samples), frameRate, sampleRate, times, f0 (0 = unvoiced), clarity }
   * Frame i is centred on sample i * hop.
   */
  function yin(samples, sampleRate, opts) {
    var minHz = opt(opts, 'minHz', 70), maxHz = opt(opts, 'maxHz', 1100);
    var hopSec = opt(opts, 'hopSeconds', 0.005), winSec = opt(opts, 'windowSeconds', 0.04);
    var threshold = opt(opts, 'threshold', 0.12), gateDb = opt(opts, 'gateDb', -50);
    var n = samples.length;
    var hop = Math.max(1, Math.round(hopSec * sampleRate));
    var nFrames = n > 0 ? Math.floor((n - 1) / hop) + 1 : 0;
    var times = new Float64Array(nFrames), f0 = new Float32Array(nFrames), clarity = new Float32Array(nFrames);
    var result = { hop: hop, frameRate: sampleRate / hop, sampleRate: sampleRate, times: times, f0: f0, clarity: clarity };
    var i;
    for (i = 0; i < nFrames; i++) times[i] = i * hop / sampleRate;
    if (!nFrames) { report(opts, 1); return result; }

    var D = Math.max(1, Math.round(sampleRate / 16000)), fsA = sampleRate / D;
    var W = Math.max(16, Math.round(winSec * fsA));
    var tauMin = Math.max(2, Math.floor(fsA / maxHz));
    var tauMax = Math.max(tauMin + 2, Math.ceil(fsA / minHz));
    var K = tauMax + 1;                 // d() up to tauMax + 1 for the interpolation
    var L = W + K, N = nextPow2(L), half = N >> 1;
    // Frame start so that a typical lag is centred on the frame time.
    var lead = (W + Math.sqrt(tauMin * tauMax)) / 2;
    var pad = L + Math.ceil(lead) + 2;
    var x = decimate(samples, D, pad), mp = x.length;

    var P = new Float64Array(mp + 1);   // running sum of squares
    for (i = 0; i < mp; i++) P[i + 1] = P[i] + x[i] * x[i];

    var fft = new fftLib.FFT(N), re = new Float64Array(N), im = new Float64Array(N);
    // The inverse runs as a half-size complex FFT of the real result.
    var ifft = new fftLib.FFT(half), re2 = new Float64Array(half), im2 = new Float64Array(half);
    var rr = new Float64Array(half + 1), ri = new Float64Array(half + 1);
    var tc = new Float64Array(half), tsn = new Float64Array(half);
    for (i = 0; i < half; i++) { tc[i] = Math.cos(2 * Math.PI * i / N); tsn[i] = Math.sin(2 * Math.PI * i / N); }
    var d = new Float64Array(K + 1), dn = new Float64Array(K + 1);
    var gate = Math.pow(10, gateDb / 20), gateE = gate * gate * W;
    var j, k, tau;

    for (i = 0; i < nFrames; i++) {
      if ((i & 255) === 0) report(opts, i / nFrames);
      var s = pad + Math.round(i * hop / D - lead);
      var e0 = P[s + W] - P[s];
      if (!(e0 > gateE)) { f0[i] = 0; clarity[i] = 0; continue; }

      // Pack a = x[s, s+W) and b = x[s, s+L) into one complex FFT.
      for (j = 0; j < W; j++) { re[j] = x[s + j]; im[j] = x[s + j]; }
      for (; j < L; j++) { re[j] = 0; im[j] = x[s + j]; }
      for (; j < N; j++) { re[j] = 0; im[j] = 0; }
      fft.forward(re, im);
      // r(tau) = sum a[j] b[j+tau]  <=>  R = conj(A) * B, with A, B split from Z.
      for (k = 0; k <= half; k++) {
        var km = (N - k) & (N - 1);
        var zr = re[k], zi = im[k], mr = re[km], mi = im[km];
        var ar = 0.5 * (zr + mr), ai = 0.5 * (zi - mi), br = 0.5 * (zi + mi), bi = 0.5 * (mr - zr);
        rr[k] = ar * br + ai * bi; ri[k] = ar * bi - ai * br;
      }
      // Real inverse: even/odd halves E, O packed as E + iO, R[k + N/2] = conj(R[N/2 - k]).
      for (k = 0; k < half; k++) {
        var hr = rr[half - k], hi = -ri[half - k];
        var er = 0.5 * (rr[k] + hr), ei = 0.5 * (ri[k] + hi);
        var dr = 0.5 * (rr[k] - hr), di = 0.5 * (ri[k] - hi);
        var or = dr * tc[k] - di * tsn[k], oi = dr * tsn[k] + di * tc[k];
        re2[k] = er - oi; im2[k] = ei + or;
      }
      ifft.inverse(re2, im2);

      // Difference function and its cumulative-mean normalisation.
      var run = 0;
      d[0] = 0; dn[0] = 1;
      for (tau = 1; tau <= K; tau++) {
        var r = (tau & 1) ? im2[tau >> 1] : re2[tau >> 1];
        var dv = e0 + (P[s + tau + W] - P[s + tau]) - 2 * r;
        d[tau] = dv > 0 ? dv : 0;
        run += d[tau];
        dn[tau] = run > 0 ? d[tau] * tau / run : 1;
      }
      // First dip below the threshold, then walk down to its minimum.
      var best = -1, minDn = 1;
      for (tau = tauMin; tau <= tauMax; tau++) {
        if (dn[tau] < minDn) minDn = dn[tau];
        if (dn[tau] < threshold) {
          while (tau + 1 <= tauMax && dn[tau + 1] < dn[tau]) tau++;
          best = tau;
          break;
        }
      }
      if (best < 0) { f0[i] = 0; clarity[i] = clamp(1 - minDn, 0, 1); continue; }
      // Parabolic interpolation on the raw difference (less biased than on dn).
      var y0 = d[best - 1], y1 = d[best], y2 = d[best + 1], den = y0 - 2 * y1 + y2;
      var shift = den > 0 ? clamp(0.5 * (y0 - y2) / den, -1, 1) : 0;
      f0[i] = fsA / (best + shift);
      clarity[i] = clamp(1 - dn[best], 0, 1);
    }

    cleanTrack(f0, Math.max(1, Math.round(0.02 / hopSec)));
    report(opts, 1);
    return result;
  }

  /*
   * Drop voiced blips shorter than minRun frames, then median-of-5 on log f0
   * inside each voiced run, which removes single-frame octave jumps.
   */
  function cleanTrack(f0, minRun) {
    var n = f0.length, i, s, e, tmp = new Float64Array(5);
    for (i = 0; i < n;) {
      if (!(f0[i] > 0)) { i++; continue; }
      for (s = i; i < n && f0[i] > 0; i++);
      if (i - s < minRun) for (e = s; e < i; e++) f0[e] = 0;
    }
    var lf = new Float64Array(n);
    for (i = 0; i < n; i++) lf[i] = f0[i] > 0 ? Math.log(f0[i]) : 0;
    for (i = 0; i < n;) {
      if (!(f0[i] > 0)) { i++; continue; }
      for (s = i; i < n && f0[i] > 0; i++);
      for (e = s; e < i; e++) {
        var a = Math.max(s, e - 2), b = Math.min(i, e + 3);
        f0[e] = Math.exp(median(lf, a, b, tmp));
      }
    }
  }

  /* ---------- 2. Key detection ---------- */

  function pearson(a, b) {
    var n = a.length, ma = 0, mb = 0, i;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0;
    for (i = 0; i < n; i++) {
      var da = a[i] - ma, db = b[i] - mb;
      sab += da * db; saa += da * da; sbb += db * db;
    }
    return (saa > 0 && sbb > 0) ? sab / Math.sqrt(saa * sbb) : 0;
  }

  /*
   * Key from a chroma vector: spectral peaks of an STFT (55 Hz - 5 kHz) are
   * placed on a semitone (log-frequency) axis, folded into 12 pitch classes,
   * summed over the song with louder frames counting more, and correlated
   * with the Krumhansl-Kessler profiles for all 24 keys.
   *   opts: minHz 55, maxHz 5000, onProgress
   *   -> { key, mode, name, confidence 0..1, scores [{name, r}] best first,
   *        chroma (12, sums to 1), tuningCents (the material's offset from A440) }
   */
  function estimateKey(channels, sampleRate, opts) {
    var x = mixdown(channels), n = x.length;
    var loHz = opt(opts, 'minHz', 55), hiHz = opt(opts, 'maxHz', 5000);
    var N = Math.max(256, Math.pow(2, Math.round(Math.log(sampleRate * 4096 / 44100) / Math.LN2)));
    var hop = N >> 1, win = fftLib.hann(N), fft = new fftLib.FFT(N);
    var re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
    var kLo = Math.max(2, Math.floor(loHz * N / sampleRate)), kHi = Math.min(N / 2 - 2, Math.ceil(hiHz * N / sampleRate));
    var winPow = 0, i, k;
    for (i = 0; i < N; i++) winPow += win[i] * win[i];
    var nFrames = n <= N ? 1 : Math.floor((n - N) / hop) + 1;
    // Peaks of every frame: fractional MIDI pitch and weight.
    var pk = [], pw = [], fk = [], fw = [];

    for (var f = 0; f < nFrames; f++) {
      if ((f & 63) === 0) report(opts, 0.9 * f / nFrames);
      var s = f * hop, e = 0;
      for (i = 0; i < N; i++) {
        var v = s + i < n ? x[s + i] * win[i] : 0;
        re[i] = v; im[i] = 0; e += v * v;
      }
      var rms = Math.sqrt(e / winPow);
      if (!(rms > 1e-5)) continue;             // below -100 dBFS: skip
      fft.forward(re, im);
      var maxMag = 0;
      for (k = kLo - 1; k <= kHi + 1; k++) {
        mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (k >= kLo && k <= kHi && mag[k] > maxMag) maxMag = mag[k];
      }
      var minMag = maxMag * 0.01, sum = 0;         // ignore peaks 40 dB under the frame's top
      fk.length = 0; fw.length = 0;
      for (k = kLo; k <= kHi; k++) {
        var mk = mag[k];
        if (mk <= minMag || mk <= mag[k - 1] || mk < mag[k + 1]) continue;
        // Parabolic interpolation on log magnitude for the true peak frequency.
        var la = Math.log(mag[k - 1] + 1e-12), lb = Math.log(mk), lc = Math.log(mag[k + 1] + 1e-12);
        var den = la - 2 * lb + lc, delta = den < 0 ? clamp(0.5 * (la - lc) / den, -0.5, 0.5) : 0;
        var hz = (k + delta) * sampleRate / N;
        if (hz < loHz || hz > hiHz) continue;
        // Log-frequency weighting: each octave of the harmonic series has twice
        // the partials of the one below, so higher peaks count a little less.
        var w = mk / Math.sqrt(hz / loHz);
        fk.push(hzToMidi(hz)); fw.push(w); sum += w;
      }
      if (!(sum > 0)) continue;
      for (i = 0; i < fk.length; i++) { pk.push(fk[i]); pw.push(fw[i] / sum * rms); }
    }

    // Tuning offset of the material (fraction of a semitone, circular mean).
    var cs = 0, sn = 0;
    for (i = 0; i < pk.length; i++) { cs += pw[i] * Math.cos(2 * Math.PI * pk[i]); sn += pw[i] * Math.sin(2 * Math.PI * pk[i]); }
    var tuning = (cs !== 0 || sn !== 0) ? Math.atan2(sn, cs) / (2 * Math.PI) : 0;
    var chroma = new Float64Array(12);
    for (i = 0; i < pk.length; i++) {
      var mm = pk[i] - tuning, note = Math.round(mm), dev = mm - note;
      var taper = Math.cos(Math.PI * dev);
      chroma[mod12(note)] += pw[i] * taper * taper;   // half-way between notes counts for nothing
    }

    var scores = [], prof = new Float64Array(12), total = 0;
    for (i = 0; i < 12; i++) total += chroma[i];
    for (var root = 0; root < 12; root++) {
      for (var mode = 0; mode < 2; mode++) {
        var base = mode ? KK_MINOR : KK_MAJOR;
        for (i = 0; i < 12; i++) prof[i] = base[mod12(i - root)];
        scores.push({
          name: NOTE_NAMES[root] + (mode ? ' minor' : ' major'),
          key: NOTE_NAMES[root], mode: mode ? 'minor' : 'major',
          r: total > 0 ? pearson(chroma, prof) : 0
        });
      }
    }
    scores.sort(function (a, b) { return b.r - a.r; });
    var top = scores[0], second = scores[1];
    // Confident when the best key correlates well and clearly beats the next one.
    var confidence = total > 0 ? clamp(top.r, 0, 1) * clamp((top.r - second.r) / 0.1, 0, 1) : 0;
    if (total > 0) for (i = 0; i < 12; i++) chroma[i] /= total;
    report(opts, 1);
    return {
      key: top.key, mode: top.mode, name: top.name, confidence: confidence,
      scores: scores.map(function (sc) { return { name: sc.name, r: sc.r }; }),
      chroma: chroma, tuningCents: Math.round(tuning * 1000) / 10
    };
  }

  /* ---------- 3. Correction curve ---------- */

  /*
   * Pitch-shift ratio per frame. Each voiced run is split into notes (stable
   * nearest-scale-note runs, with hysteresis so vibrato does not flicker
   * between notes). Within a note the target is the scale note plus
   * `vibrato` of the fast movement around the note's centre; the correction
   * toward it is smoothed by a one-pole filter (`speed` ms) that restarts at
   * every new note, so notes land quickly without dragging the old offset.
   *   opts: key 'C', mode 'major' | 'minor' | 'chromatic', speed 40 (ms, 0 = hard
   *         snap), strength 1 (0..1), vibrato 0.3 (0..1), tuningCents 0 (shift
   *         the note grid, e.g. for a song tuned to A442 use +7.9)
   *   -> Float32Array, one ratio per frame (1 = unchanged, always 1 when unvoiced)
   */
  function targetRatios(track, opts) {
    var f0 = track.f0, n = f0.length, ratios = new Float32Array(n), i, j;
    for (i = 0; i < n; i++) ratios[i] = 1;
    var frameSec = track.frameRate ? 1 / track.frameRate : (track.times && track.times.length > 1 ? track.times[1] - track.times[0] : 0.005);
    var allowed = allowedTable(opt(opts, 'key', 'C'), opt(opts, 'mode', 'major'));
    var tuning = opt(opts, 'tuningCents', 0) / 100;
    var speed = Math.max(0, opt(opts, 'speed', 40));
    var strength = clamp(opt(opts, 'strength', 1), 0, 1);
    var vibrato = clamp(opt(opts, 'vibrato', 0.3), 0, 1);
    var hyst = 0.3;                                         // semitones
    var maxOff = 1.5;                                       // semitones from the note, beyond: leave as sung
    var minNote = Math.max(1, Math.round(0.06 / frameSec)); // shorter wobbles join a neighbour
    var vibHalf = Math.max(1, Math.round(0.08 / frameSec)); // note-centre averaging, about one vibrato cycle
    var alpha = speed > 0 ? 1 - Math.exp(-frameSec * 1000 / speed) : 1;
    var p = new Float64Array(n), q = new Float64Array(n), slow = new Float64Array(n), full = new Float64Array(n);
    var tmp = new Float64Array(Math.max(5, n));
    for (i = 0; i < n; i++) p[i] = f0[i] > 0 ? hzToMidi(f0[i]) - tuning : 0;

    for (i = 0; i < n;) {
      if (!(f0[i] > 0)) { i++; continue; }
      var rs = i;
      while (i < n && f0[i] > 0) i++;
      var re = i;
      // Note decisions use a short median, which keeps note changes sharp.
      for (j = rs; j < re; j++) q[j] = median(p, Math.max(rs, j - 2), Math.min(re, j + 3), tmp);
      var segs = [], cur = nearestNote(q[rs], allowed), start = rs;
      for (j = rs + 1; j < re; j++) {
        var cand = nearestNote(q[j], allowed);
        if (cand !== cur && Math.abs(q[j] - cur) - Math.abs(q[j] - cand) > hyst) {
          segs.push({ s: start, e: j }); cur = cand; start = j;
        }
      }
      segs.push({ s: start, e: re });
      mergeShortNotes(segs, p, allowed, minNote, tmp);
      // Each note's target is the scale note nearest to its median pitch.
      for (j = 0; j < segs.length; j++) segs[j].note = nearestNote(median(p, segs[j].s, segs[j].e, tmp), allowed);
      for (j = segs.length - 1; j > 0; j--) {
        if (segs[j].note === segs[j - 1].note) { segs[j - 1].e = segs[j].e; segs.splice(j, 1); }
      }

      var c = 0;
      for (var g = 0; g < segs.length; g++) {
        var sg = segs[g], a, t;
        // Note centre: moving average of the pitch inside the note. Frames far
        // from the note (a missed octave, a quick grace note) are left as sung.
        var acc = 0, cnt = 0, lo = sg.s, hi = sg.s;    // window [lo, hi)
        for (t = sg.s; t < sg.e; t++) {
          var wl = Math.max(sg.s, t - vibHalf), wh = Math.min(sg.e, t + vibHalf + 1);
          for (; hi < wh; hi++) if (Math.abs(p[hi] - sg.note) <= maxOff) { acc += p[hi]; cnt++; }
          for (; lo < wl; lo++) if (Math.abs(p[lo] - sg.note) <= maxOff) { acc -= p[lo]; cnt--; }
          slow[t] = cnt > 0 ? acc / cnt : sg.note;
          full[t] = Math.abs(p[t] - sg.note) <= maxOff ? sg.note - p[t] + vibrato * (p[t] - slow[t]) : NaN;
        }
        for (t = sg.s; t < sg.e; t++) {
          if (full[t] !== full[t]) {
            if (t === rs) c = 0;               // outlier frame: hold the correction
          } else if (t === rs) {
            c = full[t];                       // after a breath: start on pitch
          } else if (t === sg.s) {
            // New note: drop the old note's correction. Keep the output pitch
            // continuous when the singer glides, else snap to the new note.
            var want = p[t - 1] + c - p[t];
            a = clamp(want, Math.min(0, full[t]), Math.max(0, full[t]));
            c = a + alpha * (full[t] - a);
          } else {
            c += alpha * (full[t] - c);
          }
          ratios[t] = clamp(Math.pow(2, strength * c / 12), 0.5, 2);
        }
      }
    }
    return ratios;
  }

  // Merge notes shorter than minLen frames into the neighbour nearest in pitch.
  function mergeShortNotes(segs, p, allowed, minLen, tmp) {
    while (segs.length > 1) {
      var shortest = -1, len = minLen;
      for (var g = 0; g < segs.length; g++) {
        if (segs[g].e - segs[g].s < len) { len = segs[g].e - segs[g].s; shortest = g; }
      }
      if (shortest < 0) return;
      var sg = segs[shortest], into;
      if (shortest === 0) into = 1;
      else if (shortest === segs.length - 1) into = shortest - 1;
      else {
        var mid = median(p, sg.s, sg.e, tmp);
        var prev = segs[shortest - 1], next = segs[shortest + 1];
        var dp = Math.abs(mid - nearestNote(median(p, prev.s, prev.e, tmp), allowed));
        var dx = Math.abs(mid - nearestNote(median(p, next.s, next.e, tmp), allowed));
        into = dp <= dx ? shortest - 1 : shortest + 1;
      }
      var other = segs[into];
      other.s = Math.min(other.s, sg.s); other.e = Math.max(other.e, sg.e);
      segs.splice(shortest, 1);
    }
  }

  /* ---------- 4. TD-PSOLA resynthesis ---------- */

  // Zero-phase 2nd-order low-pass (RBJ biquad run forward then backward).
  function lowpassZeroPhase(x, fc, sampleRate) {
    var w0 = 2 * Math.PI * fc / sampleRate, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
    var a0 = 1 + al, b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    var n = x.length, y = new Float64Array(n), i, x1 = 0, x2 = 0, y1 = 0, y2 = 0, v;
    for (i = 0; i < n; i++) {
      v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    x1 = x2 = y1 = y2 = 0;
    for (i = n - 1; i >= 0; i--) {
      var xi = y[i];
      v = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  /*
   * Pitch-shift the voiced parts by `ratios` (one per track frame) with
   * TD-PSOLA: two-period Hann grains cut around glottal pitch marks are
   * overlap-added at the new spacing (period / ratio). Grain contents are
   * not resampled, so formants and duration stay put. The same marks serve
   * every channel, so stereo images stay coherent.
   *   opts: onProgress -> new channels, same count and length. When every
   *   ratio is 1 the copies are sample-exact.
   */
  function psola(channels, sampleRate, track, ratios, opts) {
    var nCh = channels.length, n = nCh ? channels[0].length : 0, c, i;
    var out = [];
    for (c = 0; c < nCh; c++) out.push(new Float32Array(channels[c]));
    var f0 = track.f0, nF = f0.length;
    var hop = track.hop || Math.round(sampleRate / track.frameRate);
    var regions = [], total = 0;
    for (i = 0; i < nF;) {
      if (!(f0[i] > 0)) { i++; continue; }
      var i0 = i, moved = false;
      for (; i < nF && f0[i] > 0; i++) if (Math.abs(ratios[i] - 1) > 1e-7) moved = true;
      if (!moved) continue;
      var a = Math.max(0, Math.round((i0 - 0.5) * hop)), b = Math.min(n, Math.round((i - 0.5) * hop));
      if (b - a < 8) continue;
      regions.push({ i0: i0, i1: i - 1, a: a, b: b });
      total += b - a;
    }
    if (!regions.length) { report(opts, 1); return out; }
    var mono = mixdown(channels), done = 0;
    for (var r = 0; r < regions.length; r++) {
      psolaRegion(channels, out, mono, sampleRate, f0, ratios, hop, regions[r]);
      done += regions[r].b - regions[r].a;
      report(opts, done / total);
    }
    return out;
  }

  function psolaRegion(channels, out, mono, sr, f0, ratios, hop, reg) {
    var n = mono.length, nCh = channels.length, a = reg.a, b = reg.b, i0 = reg.i0, i1 = reg.i1, i, j, c;
    // Per-frame values interpolated at sample t, held at the region's edges.
    function frameAt(arr, t) {
      var pos = clamp(t / hop, i0, i1), k = Math.floor(pos), fr = pos - k;
      return k >= i1 ? arr[i1] : arr[k] + (arr[k + 1] - arr[k]) * fr;
    }
    function periodAt(t) { return sr / frameAt(f0, t); }
    function ratioAt(t) { return clamp(frameAt(ratios, t), 0.5, 2); }

    var minF = Infinity, list = [];
    for (i = i0; i <= i1; i++) { list.push(f0[i]); if (f0[i] < minF) minF = f0[i]; }
    list.sort(function (x, y) { return x - y; });
    var medF = list[list.length >> 1], maxT = Math.ceil(sr / minF) + 2;

    // Low-passed mono near the fundamental: one clear peak per period.
    var la = Math.max(0, a - 2 * maxT), lb = Math.min(n, b + 3 * maxT);
    var seg = new Float64Array(lb - la);
    for (i = la; i < lb; i++) seg[i - la] = mono[i];
    var lp = lowpassZeroPhase(seg, clamp(1.5 * medF, 80, Math.min(1500, 0.45 * sr)), sr);
    function lpAt(t) { return lp[t - la]; }

    // Analysis marks: strongest peak in the first period, then one period on.
    var marks = [], T = periodAt(a), m = a, best = -Infinity, t;
    for (t = a; t < Math.min(lb, a + Math.ceil(T)); t++) if (lpAt(t) > best) { best = lpAt(t); m = t; }
    marks.push(m);
    while (m < b) {
      T = periodAt(m);
      var pred = m + T, lo = Math.max(m + 1, Math.round(pred - 0.35 * T)), hi = Math.min(lb - 2, Math.round(pred + 0.35 * T));
      if (lo > hi) break;
      var next = -1;
      best = -Infinity;
      for (t = Math.max(lo, la + 1); t <= hi; t++) {
        var vt = lpAt(t);
        if (vt > best && vt >= lpAt(t - 1) && vt >= lpAt(t + 1)) { best = vt; next = t; }
      }
      if (next < 0) next = Math.round(pred);   // no peak in the window: keep the rhythm
      if (next <= m) break;
      marks.push(next);
      m = next;
    }
    var nm = marks.length;

    // Overlap-add grains at the synthesis marks (spacing = analysis period / ratio).
    var pad = 2 * maxT + 2, base = a - pad, len = (b - a) + 2 * pad;
    var wsum = new Float64Array(len), acc = [], wbuf = new Float64Array(4 * maxT + 4), halves = {};
    for (c = 0; c < nCh; c++) acc.push(new Float64Array(len));
    // Half a Hann window, 1 at the mark down to 0 at `size` samples away (cached per size).
    function halfHann(size) {
      var h = halves[size];
      if (!h) {
        h = halves[size] = new Float64Array(size + 1);
        for (var q = 0; q <= size; q++) h[q] = 0.5 + 0.5 * Math.cos(Math.PI * q / size);
      }
      return h;
    }
    var ts = marks[0], k = 0, kk = 0;
    for (;;) {
      while (k + 1 < nm && Math.abs(marks[k + 1] - ts) < Math.abs(marks[k] - ts)) k++;
      var mk = marks[k];
      // Grain: from the previous mark to the next one (two periods), Hann shaped.
      var L = k > 0 ? mk - marks[k - 1] : (nm > 1 ? marks[1] - mk : Math.round(periodAt(mk)));
      var R = k + 1 < nm ? marks[k + 1] - mk : L;
      L = Math.max(1, Math.min(L, 2 * maxT)); R = Math.max(1, Math.min(R, 2 * maxT));
      var tsi = Math.round(ts), off = tsi - base;
      var jlo = Math.max(-L + 1, -off, -mk), jhi = Math.min(R - 1, len - 1 - off, n - 1 - mk);
      var hl = halfHann(L), hr = halfHann(R);
      for (j = jlo; j <= jhi; j++) {
        var w = j < 0 ? hl[-j] : hr[j];
        wbuf[j - jlo] = w;
        wsum[off + j] += w;
      }
      for (c = 0; c < nCh; c++) {
        var ac = acc[c], ch = channels[c];
        for (j = jlo; j <= jhi; j++) ac[off + j] += wbuf[j - jlo] * ch[mk + j];
      }
      if (ts >= b) break;
      // Local analysis period from the marks around ts, falling back to f0.
      while (kk + 1 < nm && marks[kk + 1] <= ts) kk++;
      var spacing = (kk + 1 < nm && marks[kk] <= ts) ? marks[kk + 1] - marks[kk] : periodAt(ts);
      ts += spacing / ratioAt(ts);
    }

    // Normalise by the window sum and crossfade ~10 ms into and out of the region.
    var X = Math.max(1, Math.min(Math.round(0.01 * sr), (b - a) >> 1));
    for (t = a; t < b; t++) {
      var g = 1;
      if (t - a < X) g = 0.5 - 0.5 * Math.cos(Math.PI * (t - a + 0.5) / X);
      if (b - 1 - t < X) g = Math.min(g, 0.5 - 0.5 * Math.cos(Math.PI * (b - t - 0.5) / X));
      var ws = wsum[t - base];
      for (c = 0; c < nCh; c++) {
        var x = channels[c][t];
        var y = ws > 1e-6 ? acc[c][t - base] / ws : x;
        out[c][t] = x + g * (y - x);
      }
    }
  }

  /* ---------- 5. The whole job ---------- */

  function centsOff(track, allowed, tuning) {
    var f0 = track.f0, sum = 0, count = 0;
    for (var i = 0; i < f0.length; i++) {
      if (!(f0[i] > 0)) continue;
      var m = hzToMidi(f0[i]) - tuning;
      sum += Math.abs(m - nearestNote(m, allowed)) * 100; count++;
    }
    return { mean: count ? sum / count : 0, count: count };
  }

  /*
   * Tune a vocal: detect the key unless given (from opts.keyChannels, e.g. the
   * instrumental, or else the vocal itself), track pitch, build the correction
   * curve, resynthesise, and measure the result again.
   *   opts: key, mode (no key: detected, mode too unless given; a key
   *         without a mode is major), speed, strength, vibrato, tuningCents
   *         (see targetRatios), keyChannels, minHz, maxHz, threshold, gateDb
   *         (see yin), onProgress
   *   -> { channels, report: { key, mode, name, keyDetected, keyConfidence,
   *        tuningCents, voicedSeconds, centsBefore, centsAfter } }
   * centsBefore/After: mean |cents| from the nearest scale note over voiced frames.
   */
  function autoTune(channels, sampleRate, opts) {
    opts = opts || {};
    var key = opts.key, mode = opts.mode ? modeName(opts.mode) : null, detected = null;
    if (!key && mode !== 'chromatic') {
      detected = estimateKey(opts.keyChannels || channels, sampleRate, { onProgress: stage(opts, 0, 0.1) });
      key = detected.key;
      if (!mode) mode = detected.mode;
    }
    key = NOTE_NAMES[keyIndex(key || 'C')];
    mode = mode || 'major';
    var tuning = opt(opts, 'tuningCents', 0);
    var yinOpts = {
      minHz: opts.minHz, maxHz: opts.maxHz, threshold: opts.threshold, gateDb: opts.gateDb,
      onProgress: stage(opts, 0.1, 0.4)
    };
    var track = yin(mixdown(channels), sampleRate, yinOpts);
    var ratios = targetRatios(track, {
      key: key, mode: mode, tuningCents: tuning,
      speed: opts.speed, strength: opts.strength, vibrato: opts.vibrato
    });
    var tuned = psola(channels, sampleRate, track, ratios, { onProgress: stage(opts, 0.4, 0.75) });
    yinOpts.onProgress = stage(opts, 0.75, 1);
    var after = yin(mixdown(tuned), sampleRate, yinOpts);
    var allowed = allowedTable(key, mode), before = centsOff(track, allowed, tuning / 100);
    report(opts, 1);
    return {
      channels: tuned,
      report: {
        key: key, mode: mode, name: key + ' ' + mode,
        keyDetected: !!detected, keyConfidence: detected ? detected.confidence : null,
        tuningCents: tuning,
        voicedSeconds: before.count * track.hop / sampleRate,
        centsBefore: before.mean,
        centsAfter: centsOff(after, allowed, tuning / 100).mean
      }
    };
  }

  return {
    NOTE_NAMES: NOTE_NAMES,
    yin: yin,
    scale: scale,
    estimateKey: estimateKey,
    targetRatios: targetRatios,
    psola: psola,
    autoTune: autoTune
  };
});
