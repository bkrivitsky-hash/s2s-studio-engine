/*
 * Stem to Stream Studio: rhythm analysis and vocal timing.
 *
 * Finds the song's tempo and bar grid from audio, measures how a vocal's
 * syllables land against that grid, lines up a stem that is offset from the
 * others, and nudges late or early vocal phrases toward the grid.
 *
 *   var R = S2S.studio.rhythm;
 *   var song = R.analyzeSong([drumsL, drumsR], 48000);
 *     // {bpm, confidence, beatOffset, barOffset}; barOffset -> project.gridOffset
 *   var env = R.onsetEnvelope([vocal], 48000);
 *   var onsets = R.detectOnsets(env);
 *   var report = R.timingReport(onsets, {bpm: song.bpm, offset: song.barOffset});
 *   var plan = R.tightenPlan(onsets, env.duration, {bpm: song.bpm, offset: song.barOffset});
 *   var tight = R.applyPlan([vocal], 48000, plan);
 *
 * Conventions used by every function:
 *   - Times are in seconds from the start of the audio.
 *   - Envelope frame i describes time i / frameRate. The STFT frames are
 *     placed (see FLUX_LEAD) so that a sharp attack at time t peaks at
 *     frame t * frameRate, which keeps onset, tempo-phase and alignment
 *     results in plain audio time.
 *   - BPM counts quarter notes, as in core.js: beatSec = 60 / bpm * 4 / beatUnit,
 *     barSec = beatSec * beatsPerBar, and a bar line falls at
 *     gridOffset + k * barSec.
 *   - Positive deviations and offsets mean LATE.
 *
 * Module pattern as in fft.js: the factory is self-contained so the app can
 * rebuild it inside a Web Worker from S2S.studio.factories.rhythm.toString().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.factories = root.S2S.studio.factories || {};
    root.S2S.studio.factories.rhythm = factory;
    root.S2S.studio.rhythm = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var fftLib = (typeof module === 'object' && module.exports) ? require('./fft.js') : self.S2S.studio.fft;

  // Log-compressed spectral flux peaks a little before the true attack: the
  // log rises fastest while the window's leading edge first meets the sound.
  // Frames are centred this fraction of the window earlier than their nominal
  // time to cancel that lead (6.8 ms at 48 kHz). Measured on synthetic hits:
  // kicks then read ~5 ms early, snares, hats and 2 ms attacks within 1 ms,
  // 10 ms vocal-like attacks 3-5 ms late, 30 ms attacks ~9 ms late.
  var FLUX_LEAD = 0.16;
  // Share of the bin-wise decrease subtracted from the increase. A note that
  // stops smears energy into quiet bins for a frame, which log compression
  // would otherwise turn into a small false onset at every note end.
  var DECAY_WEIGHT = 0.5;

  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round(v, digits) { var m = Math.pow(10, digits); return Math.round(v * m) / m; }
  function progress(opts, f) { if (opts && typeof opts.onProgress === 'function') opts.onProgress(clamp(f, 0, 1)); }

  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  /** Average of all channels, as one Float32Array. */
  function mixDown(channels) {
    var nch = channels.length, len = nch ? channels[0].length : 0;
    if (nch === 1) return channels[0];
    var out = new Float32Array(len), g = 1 / nch;
    for (var c = 0; c < nch; c++) {
      var x = channels[c];
      for (var i = 0; i < len; i++) out[i] += x[i] * g;
    }
    return out;
  }

  /** Catmull-Rom interpolation of x at fractional index pos (zero outside). */
  function cubicAt(x, pos) {
    var i = Math.floor(pos), f = pos - i, n = x.length;
    if (i < -1 || i > n) return 0;
    var y0 = i - 1 >= 0 && i - 1 < n ? x[i - 1] : 0;
    var y1 = i >= 0 && i < n ? x[i] : 0;
    var y2 = i + 1 >= 0 && i + 1 < n ? x[i + 1] : 0;
    var y3 = i + 2 >= 0 && i + 2 < n ? x[i + 2] : 0;
    return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
  }

  /** Vertex offset (-0.5..0.5) of the parabola through three equally spaced points. */
  function parabolic(a, b, c) {
    var d = a - 2 * b + c;
    if (!(d < 0)) return 0;
    return clamp(0.5 * (a - c) / d, -0.5, 0.5);
  }

  // ---------------------------------------------------------- envelope ---

  /*
   * Spectral flux for several frequency bands from one STFT pass.
   * Returns raw (unnormalised) flux arrays, one per band, of nFrames values.
   * Flux index i compares the frames centred at (i - 1/2) and (i + 1/2) hops
   * (both moved earlier by FLUX_LEAD), so it describes time i * hop. Per bin:
   * log(1 + 100 |X|) with |X| scaled so a sine of amplitude A reads A; the
   * flux is sum(increase) - DECAY_WEIGHT * sum(decrease), floored at 0.
   */
  function bandFlux(mono, sampleRate, hop, bands, opts) {
    var len = mono.length;
    var N = nextPow2(4 * hop), half = N >> 1;
    var win = fftLib.hann(N), fft = new fftLib.FFT(N);
    var wsum = 0, i, k, b;
    for (i = 0; i < N; i++) wsum += win[i];
    var scale = 2 / wsum;               // a sine of amplitude A reads |X| = A
    var nb = bands.length, lo = new Int32Array(nb), hi = new Int32Array(nb);
    var kMin = half, kMax = 0;
    for (b = 0; b < nb; b++) {
      lo[b] = clamp(Math.ceil(bands[b][0] * N / sampleRate), 1, half - 1);
      hi[b] = clamp(Math.floor(bands[b][1] * N / sampleRate), lo[b], half - 1);
      if (lo[b] < kMin) kMin = lo[b];
      if (hi[b] > kMax) kMax = hi[b];
    }
    var nFrames = Math.floor(len / hop) + 1;
    var out = [];
    for (b = 0; b < nb; b++) out.push(new Float32Array(nFrames));
    // STFT frame j (j = 0..nFrames) is centred at sample (j - 1/2) * hop - lead.
    var lead = Math.round(FLUX_LEAD * N);
    var base = Math.round(-hop / 2) - lead - half;   // first sample of frame 0
    var re = new Float64Array(N), im = new Float64Array(N);
    var magA = new Float64Array(half + 1), magB = new Float64Array(half + 1);
    var prev = new Float64Array(half + 1), have = false;
    var total = nFrames + 1, lastTick = 0;

    function load(buf, start) {
      // Windowed frame starting at sample `start`; returns false when silent.
      var m, energy = 0, v;
      if (start >= 0 && start + N <= len) {
        for (m = 0; m < N; m++) {
          v = mono[start + m];
          buf[m] = v * win[m];
          energy += v * v;
        }
        return energy > 0;
      }
      for (m = 0; m < N; m++) {
        var s = start + m;
        v = s >= 0 && s < len ? mono[s] : 0;
        buf[m] = v * win[m];
        energy += v * v;
      }
      return energy > 0;
    }

    function emit(j, mag) {
      // Flux between frame j-1 (prev) and frame j (mag) lands at index j-1.
      if (have && j - 1 < nFrames) {
        for (var bb = 0; bb < nb; bb++) {
          var up = 0, down = 0;
          for (var kk = lo[bb]; kk <= hi[bb]; kk++) {
            var d = mag[kk] - prev[kk];
            if (d > 0) up += d; else down -= d;
          }
          out[bb][j - 1] = up > DECAY_WEIGHT * down ? up - DECAY_WEIGHT * down : 0;
        }
      }
      for (var q = kMin; q <= kMax; q++) prev[q] = mag[q];
      have = true;
    }

    // Two real frames per complex FFT: frame j in re, frame j+1 in im.
    for (var j = 0; j < total; j += 2) {
      var startA = base + j * hop, startB = startA + hop;
      var anyA = load(re, startA);
      var anyB = j + 1 < total ? load(im, startB) : false;
      if (!anyB) for (i = 0; i < N; i++) im[i] = 0;
      if (anyA || anyB) {
        fft.forward(re, im);
        for (k = kMin; k <= kMax; k++) {
          var xr = re[k], xi = im[k], yr = re[N - k], yi = im[N - k];
          var ar = 0.5 * (xr + yr), ai = 0.5 * (xi - yi);
          var br = 0.5 * (xi + yi), bi = -0.5 * (xr - yr);
          magA[k] = Math.log(1 + 100 * scale * Math.sqrt(ar * ar + ai * ai));
          magB[k] = Math.log(1 + 100 * scale * Math.sqrt(br * br + bi * bi));
        }
      } else {
        for (k = kMin; k <= kMax; k++) { magA[k] = 0; magB[k] = 0; }
      }
      emit(j, magA);
      if (j + 1 < total) emit(j + 1, magB);
      if (j - lastTick >= 2000) { lastTick = j; progress(opts, j / total); }
    }
    return out;
  }

  /** Subtract a ~0.5 s moving average, clip at zero and scale to a peak of 1. */
  function finishEnvelope(flux, frameRate) {
    var n = flux.length, w = Math.max(1, Math.round(0.25 * frameRate));
    var cum = new Float64Array(n + 1), i;
    for (i = 0; i < n; i++) cum[i + 1] = cum[i] + flux[i];
    var env = new Float32Array(n), peak = 0;
    for (i = 0; i < n; i++) {
      var a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
      var v = flux[i] - (cum[b] - cum[a]) / (b - a);
      if (v > 0) { env[i] = v; if (v > peak) peak = v; }
    }
    if (peak > 0) for (i = 0; i < n; i++) env[i] /= peak;
    return env;
  }

  function envelopes(channels, sampleRate, bands, opts) {
    opts = opts || {};
    var hop = Math.max(16, Math.round(num(opts.hop, sampleRate / 100)));
    var frameRate = sampleRate / hop;
    var mono = mixDown(channels);
    var flux = bandFlux(mono, sampleRate, hop, bands, opts);
    var out = [];
    for (var b = 0; b < flux.length; b++) {
      out.push({
        env: finishEnvelope(flux[b], frameRate),
        frameRate: frameRate,
        hop: hop,
        sampleRate: sampleRate,
        duration: mono.length / sampleRate
      });
    }
    progress(opts, 1);
    return out;
  }

  /**
   * Onset-strength envelope (log spectral flux) of the mono mix.
   * opts: band [loHz, hiHz] = [30, 8000], hop (samples) = round(sampleRate / 100),
   *       onProgress(fraction).
   * Returns {env: Float32Array (0..1), frameRate, hop, sampleRate, duration};
   * env[i] is the onset strength at time i / frameRate.
   */
  function onsetEnvelope(channels, sampleRate, opts) {
    opts = opts || {};
    var band = opts.band || [30, 8000];
    return envelopes(channels, sampleRate, [[band[0], Math.min(band[1], sampleRate / 2)]], opts)[0];
  }

  // ------------------------------------------------------------ onsets ---

  function medianOf(x, a, b, tmp) {
    var n = 0, i;
    for (i = a; i < b; i++) tmp[n++] = x[i];
    var s = tmp.subarray(0, n);
    Array.prototype.sort.call(s, function (p, q) { return p - q; });
    return n & 1 ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1]);
  }

  /**
   * Onset times (s) from an envelope: local maxima that rise above the local
   * median (window +-opts.windowMs = 100) by opts.delta (0.07), at least
   * opts.minGapMs (50) apart (the stronger one wins), refined to sub-frame
   * time with a parabola. Returns a Float64Array in ascending order.
   */
  function detectOnsets(envObj, opts) {
    opts = opts || {};
    var e = envObj.env, fr = envObj.frameRate, n = e.length;
    var delta = num(opts.delta, 0.07);
    var w = Math.max(1, Math.round(num(opts.windowMs, 100) / 1000 * fr));
    var minGap = num(opts.minGapMs, 50) / 1000 * fr;
    var tmp = new Float64Array(2 * w + 1);
    var pos = [], amp = [];
    for (var i = 0; i < n; i++) {
      var v = e[i];
      if (!(v > 0)) continue;
      var l = i > 0 ? e[i - 1] : 0, r = i + 1 < n ? e[i + 1] : 0;
      if (v < l || v <= r) continue;    // plateaus count once, at their right edge
      if (v < medianOf(e, Math.max(0, i - w), Math.min(n, i + w + 1), tmp) + delta) continue;
      var p = i + parabolic(l, v, r);
      var last = pos.length - 1;
      if (last >= 0 && p - pos[last] < minGap) {
        if (v > amp[last]) { pos[last] = p; amp[last] = v; }
        continue;
      }
      pos.push(p); amp.push(v);
    }
    var out = new Float64Array(pos.length);
    for (var j = 0; j < pos.length; j++) out[j] = Math.max(0, pos[j] / fr);
    return out;
  }

  // ------------------------------------------------------------- tempo ---

  /** Autocorrelation r[L] = sum x[i] x[i+L] / (n - L) for L = 0..maxLag. */
  function autocorr(x, maxLag) {
    var n = x.length, r = new Float64Array(maxLag + 1);
    for (var L = 0; L <= maxLag; L++) {
      var s = 0, m = n - L;
      for (var i = 0; i < m; i++) s += x[i] * x[i + L];
      r[L] = m > 0 ? s / m : 0;
    }
    return r;
  }

  /** Best mean envelope value over beat phases for a period of p frames. */
  function combScore(e, p, phaseStep) {
    var n = e.length, best = -Infinity, bestPhase = 0;
    for (var ph = 0; ph < p; ph += phaseStep) {
      var s = 0, c = 0;
      for (var t = ph; t < n - 1; t += p) { s += cubicAt(e, t); c++; }
      if (c && s / c > best) { best = s / c; bestPhase = ph; }
    }
    return { score: best, phase: bestPhase };
  }

  /**
   * Tempo from the onset envelope.
   * opts: minBpm = 60, maxBpm = 200, priorBpm = 120, priorOctaves = 1, onProgress.
   * Autocorrelation of the (square-rooted) envelope, enhanced with its 2x and
   * 4x lags and weighted by a log-Gaussian prior around priorBpm, picks the
   * beat period on a 0.1-frame lag grid; a fit of the first 8 multiples of
   * the lag and then a comb/phase search (+-0.5 BPM, 0.01 steps) refine it.
   * The bpm is the pulse rate counted as quarter notes.
   * Returns {bpm (2 decimals; 0 when no beat is found), confidence 0..1,
   * candidates [{bpm, score}] best first}.
   */
  function estimateTempo(envObj, opts) {
    opts = opts || {};
    var e = envObj.env, fr = envObj.frameRate, n = e.length;
    var minBpm = num(opts.minBpm, 60), maxBpm = num(opts.maxBpm, 200);
    var priorBpm = num(opts.priorBpm, 120), sigma = num(opts.priorOctaves, 1);
    var none = { bpm: 0, confidence: 0, candidates: [] };
    var lagLo = 60 * fr / maxBpm, lagHi = 60 * fr / minBpm;
    if (!(lagLo >= 2) || n < 2 * lagHi + 4) return none;

    // Autocorrelate the square root of the envelope, mean removed. The root
    // evens out accents (a broadband snare outweighs a kick several times in
    // the flux), so the ACF hears where hits fall more than how loud they are;
    // a backbeat otherwise repeats most strongly every 2 beats, pulling
    // tempos near 140 down to 70.
    var x = new Float64Array(n), mean = 0, i, j;
    for (i = 0; i < n; i++) { x[i] = Math.sqrt(e[i]); mean += x[i]; }
    mean /= n;
    for (i = 0; i < n; i++) x[i] -= mean;
    var maxLag = Math.min(n - 1, Math.ceil(8 * lagHi) + 10);
    var r = autocorr(x, maxLag);
    progress(opts, 0.3);
    if (!(r[0] > 0)) return none;
    function rAt(lag) { return lag < maxLag - 1 ? cubicAt(r, lag) : 0; }

    // Harmonic-enhanced, prior-weighted score on a 0.1-frame lag grid: beat
    // periods are rarely whole frames, and 2L and 4L must hit their own peaks.
    var dL = 0.1, size = Math.floor((lagHi - lagLo) / dL) + 3;
    var raw = new Float64Array(size), sw = new Float64Array(size);
    function lagOf(idx) { return lagLo + (idx - 1) * dL; }
    for (j = 0; j < size; j++) {
      var L = lagOf(j);
      var s = rAt(L) + 0.5 * rAt(2 * L) + 0.25 * rAt(4 * L);
      var oct = Math.log(60 * fr / L / priorBpm) / Math.LN2 / sigma;
      raw[j] = s;
      sw[j] = s * Math.exp(-0.5 * oct * oct);
    }
    var peaks = [];
    for (j = 1; j < size - 1; j++) {
      if (sw[j] > 0 && sw[j] >= sw[j - 1] && sw[j] > sw[j + 1]) peaks.push(j);
    }
    if (!peaks.length) return none;
    peaks.sort(function (a, b) { return sw[b] - sw[a] || a - b; });
    var refined = peaks.map(function (pk) {
      return lagOf(pk) + dL * parabolic(sw[pk - 1], sw[pk], sw[pk + 1]);
    });

    // Multi-lag fit: the period whose first K multiples all sit on ACF peaks.
    var L0 = refined[0];
    var K = Math.max(1, Math.min(8, Math.floor((maxLag - 2) / (L0 + 1))));
    var bestF = -Infinity, L1 = L0;
    for (var cand = L0 - 1; cand <= L0 + 1 + 1e-9; cand += 0.01) {
      var F = 0;
      for (var k = 1; k <= K; k++) F += cubicAt(r, k * cand);
      if (F > bestF) { bestF = F; L1 = cand; }
    }
    progress(opts, 0.5);

    // Comb/phase search around the fitted tempo.
    var centre = 60 * fr / L1, steps = 50, scores = new Float64Array(2 * steps + 1);
    var bestIdx = steps;
    for (var m = -steps; m <= steps; m++) {
      var bpm = centre + m * 0.01;
      scores[m + steps] = bpm > 0 ? combScore(e, 60 * fr / bpm, 0.25).score : -Infinity;
      if (scores[m + steps] > scores[bestIdx]) bestIdx = m + steps;
    }
    var off = bestIdx > 0 && bestIdx < 2 * steps ?
      parabolic(scores[bestIdx - 1], scores[bestIdx], scores[bestIdx + 1]) : 0;
    var finalBpm = round(clamp(centre + (bestIdx - steps + off) * 0.01, minBpm, maxBpm), 2);
    progress(opts, 1);

    // Up to five distinct candidates (at least 1% apart), best first.
    var top = sw[peaks[0]], candidates = [], seen = [];
    for (i = 0; i < peaks.length && candidates.length < 5; i++) {
      var cb = 60 * fr / refined[i], dup = false;
      for (j = 0; j < seen.length; j++) if (Math.abs(cb / seen[j] - 1) < 0.01) dup = true;
      if (dup) continue;
      seen.push(cb);
      candidates.push({ bpm: i === 0 ? finalBpm : round(cb, 2), score: round(sw[peaks[i]] / top, 3) });
    }
    return {
      bpm: finalBpm,
      confidence: round(clamp(raw[peaks[0]] / (1.75 * r[0]), 0, 1), 3),
      candidates: candidates
    };
  }

  // -------------------------------------------------------------- grid ---

  /** Area of x within +-radius of pos: unlike a peak value, it does not
   *  depend on where the hit falls between two frames. */
  function localSum(x, pos, radius) {
    var a = Math.max(0, Math.ceil(pos - radius)), b = Math.min(x.length - 1, Math.floor(pos + radius));
    var s = 0;
    for (var i = a; i <= b; i++) s += x[i];
    return s;
  }

  /**
   * Beat and bar phase for a known tempo.
   * opts: beatsPerBar = 4, beatUnit = 4, lowEnv (an onsetEnvelope result for
   * band [30, 200], used to find the downbeat; defaults to envObj).
   * The beat phase maximises the mean envelope (cubic-interpolated) at every
   * beat over phases 1 ms apart, then a parabola refines it; the downbeat is
   * the beat of the bar whose bar lines carry the most low-band onset
   * strength (area within +-20 ms). confidence = beatConfidence *
   * (0.5 + 0.5 * barConfidence): beat = peak over mean of the phase scores,
   * bar = margin of the chosen downbeat over the runner-up.
   * Returns {beatOffset in [0, beatSec), barOffset in [0, barSec) (store it as
   * project.gridOffset), confidence 0..1, beatConfidence, barConfidence}.
   */
  function estimateGrid(envObj, bpm, opts) {
    opts = opts || {};
    var bpb = Math.max(1, Math.round(num(opts.beatsPerBar, 4))), unit = num(opts.beatUnit, 4);
    var e = envObj.env, fr = envObj.frameRate, n = e.length;
    var empty = { beatOffset: 0, barOffset: 0, confidence: 0, beatConfidence: 0, barConfidence: 0 };
    if (!(bpm > 0) || n < 2) return empty;
    var beatSec = 60 / bpm * 4 / unit, barSec = beatSec * bpb;
    var nPh = Math.max(1, Math.round(beatSec * 1000)), step = beatSec / nPh;
    var scores = new Float64Array(nPh), best = 0, mean = 0, m;
    var period = beatSec * fr, end = n - 1;
    for (m = 0; m < nPh; m++) {
      var s = 0, c = 0;
      for (var t = m * step * fr; t < end; t += period) { s += cubicAt(e, t); c++; }
      scores[m] = c ? s / c : 0;
      mean += scores[m];
      if (scores[m] > scores[best]) best = m;
    }
    mean /= nPh;
    if (!(scores[best] > 0)) return empty;
    var off = nPh > 2 ? parabolic(scores[(best - 1 + nPh) % nPh], scores[best], scores[(best + 1) % nPh]) : 0;
    var beatOffset = ((best + off) * step) % beatSec;
    if (beatOffset < 0) beatOffset += beatSec;
    var beatConf = clamp((scores[best] - mean) / scores[best], 0, 1);

    // Downbeat: which beat of the bar has the strongest low-band hits.
    var low = opts.lowEnv ? (opts.lowEnv.env || opts.lowEnv) : e;
    var lowFr = opts.lowEnv && opts.lowEnv.frameRate ? opts.lowEnv.frameRate : fr;
    var kBest = 0, sBest = -1, sSecond = 0;
    if (bpb > 1) {
      for (var k = 0; k < bpb; k++) {
        var sum = 0, cnt = 0;
        for (var tb = beatOffset + k * beatSec; tb * lowFr < low.length - 1; tb += barSec) {
          sum += localSum(low, tb * lowFr, 2); cnt++;
        }
        var sc = cnt ? sum / cnt : 0;
        if (sc > sBest) { sSecond = Math.max(sBest, 0); sBest = sc; kBest = k; }
        else if (sc > sSecond) sSecond = sc;
      }
    }
    var barConf = bpb > 1 ? (sBest > 0 ? clamp((sBest - sSecond) / sBest, 0, 1) : 0) : 1;
    var barOffset = (beatOffset + kBest * beatSec) % barSec;
    return {
      beatOffset: round(beatOffset, 4),
      barOffset: round(barOffset, 4),
      confidence: round(beatConf * (0.5 + 0.5 * barConf), 3),
      beatConfidence: round(beatConf, 3),
      barConfidence: round(barConf, 3)
    };
  }

  // --------------------------------------------------------- alignment ---

  /**
   * Time offset between two envelopes with the same frameRate.
   * opts: maxLag (s) = 0.25.
   * Positive offset: B is LATE relative to A, so move B earlier by `offset`
   * (or A later) to line them up. Cross-correlation of the mean-removed
   * envelopes over +-maxLag, with parabolic sub-frame refinement.
   * Returns {offset (s), confidence 0..1 (normalised correlation at the peak)}.
   */
  function alignmentOffset(envA, envB, opts) {
    opts = opts || {};
    var fr = envA.frameRate;
    if (Math.abs(envB.frameRate - fr) > 1e-6 * fr) throw new Error('Envelopes need the same frame rate.');
    var a = envA.env, b = envB.env, n = Math.min(a.length, b.length), i;
    var maxLag = Math.max(1, Math.min(n - 1, Math.round(num(opts.maxLag, 0.25) * fr)));
    if (n < 2) return { offset: 0, confidence: 0 };
    var x = new Float64Array(n), y = new Float64Array(n), ma = 0, mb = 0, ea = 0, eb = 0;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    for (i = 0; i < n; i++) { x[i] = a[i] - ma; y[i] = b[i] - mb; ea += x[i] * x[i]; eb += y[i] * y[i]; }
    if (!(ea > 0 && eb > 0)) return { offset: 0, confidence: 0 };
    var size = 2 * maxLag + 1, c = new Float64Array(size), best = 0;
    for (var L = -maxLag; L <= maxLag; L++) {
      var s = 0, i0 = Math.max(0, -L), i1 = Math.min(n, n - L);
      for (i = i0; i < i1; i++) s += x[i] * y[i + L];
      c[L + maxLag] = s;
      if (s > c[best]) best = L + maxLag;
    }
    var off = best > 0 && best < size - 1 ? parabolic(c[best - 1], c[best], c[best + 1]) : 0;
    return {
      offset: round((best - maxLag + off) / fr, 5),
      confidence: round(clamp(c[best] / Math.sqrt(ea * eb), 0, 1), 3)
    };
  }

  // ------------------------------------------------------------ timing ---

  /** Grid step in seconds: grid.subdivision notes per whole note (16 = sixteenths). */
  function gridStep(grid) {
    if (!grid || !(grid.bpm > 0)) throw new Error('grid.bpm must be a positive number.');
    return 60 / grid.bpm * 4 / Math.max(1, num(grid.subdivision, 16));
  }

  function nearestGrid(t, grid, step) {
    var off = num(grid.offset, 0);
    return off + Math.round((t - off) / step) * step;
  }

  /**
   * How onsets land against a grid {bpm, offset (= gridOffset), subdivision = 16}.
   * opts: toleranceMs = 20. deviationMs > 0 means late.
   * Returns {items [{time, gridTime, deviationMs}], meanAbsMs, medianAbsMs,
   * meanMs (signed average: the overall lean), early, late, onGrid, count}.
   */
  function timingReport(onsets, grid, opts) {
    opts = opts || {};
    var tol = num(opts.toleranceMs, 20), step = gridStep(grid);
    var items = [], abs = [], sum = 0, sumSigned = 0, early = 0, late = 0, onGrid = 0;
    for (var i = 0; i < onsets.length; i++) {
      var t = onsets[i], g = nearestGrid(t, grid, step), dev = (t - g) * 1000;
      items.push({ time: t, gridTime: g, deviationMs: dev });
      abs.push(Math.abs(dev));
      sum += Math.abs(dev); sumSigned += dev;
      if (Math.abs(dev) <= tol) onGrid++;
      else if (dev < 0) early++;
      else late++;
    }
    abs.sort(function (p, q) { return p - q; });
    var n = abs.length, median = !n ? 0 : (n & 1 ? abs[n >> 1] : 0.5 * (abs[(n >> 1) - 1] + abs[n >> 1]));
    return {
      items: items,
      meanAbsMs: n ? sum / n : 0,
      medianAbsMs: median,
      meanMs: n ? sumSigned / n : 0,
      early: early,
      late: late,
      onGrid: onGrid,
      count: n
    };
  }

  /**
   * Plan that moves each phrase start toward the grid.
   * grid: {bpm, offset, subdivision = 16}. opts: strength 0..1 = 0.6,
   * maxShiftMs = 80, toleranceMs = 15, preRollMs = 12, minSegmentMs = 120.
   * Returns [{start, end, shift}] in OUTPUT time covering [0, duration] with
   * no gaps; output at time t plays the source at t - shift (shift > 0 moves
   * later). Onsets closer than minSegmentMs to the previous kept onset ride
   * along with it. Each shift is strength * (gridTime - onset), clamped to
   * +-maxShift and 0 within tolerance; the first segment from 0 keeps 0.
   * A segment starts preRoll before where its onset will land, but never
   * after the point where the previous segment's own material ends:
   * start = onset - preRoll + min(previous shift, shift). So a moved attack
   * is always inside its own segment and is never played twice.
   */
  function tightenPlan(onsets, duration, grid, opts) {
    opts = opts || {};
    var strength = clamp(num(opts.strength, 0.6), 0, 1);
    var maxShift = Math.max(0, num(opts.maxShiftMs, 80)) / 1000;
    var tol = Math.max(0, num(opts.toleranceMs, 15)) / 1000;
    var preRoll = Math.max(0, num(opts.preRollMs, 12)) / 1000;
    var minSeg = Math.max(0, num(opts.minSegmentMs, 120)) / 1000;
    var minLen = 0.03;     // shortest segment we cut, so crossfades fit
    var minChange = 0.002; // smaller changes of shift are not worth a cut
    var step = gridStep(grid);
    var sorted = Array.prototype.slice.call(onsets).filter(function (t) {
      return t >= 0 && t < duration;
    }).sort(function (a, b) { return a - b; });

    var segs = [{ start: 0, shift: 0 }], prevShift = 0, lastKept = -Infinity;
    for (var i = 0; i < sorted.length; i++) {
      var o = sorted[i];
      if (o - lastKept < minSeg) continue;   // part of the previous phrase start
      lastKept = o;
      var dev = nearestGrid(o, grid, step) - o;
      var shift = Math.abs(dev) <= tol ? 0 : clamp(strength * dev, -maxShift, maxShift);
      if (Math.abs(shift - prevShift) < minChange) continue;   // same move: no cut
      var start = Math.max(0, o - preRoll + Math.min(prevShift, shift));
      if (start < segs[segs.length - 1].start + minLen || start > duration - minLen) continue;
      segs.push({ start: start, shift: shift });
      prevShift = shift;
    }
    var plan = [];
    for (var k = 0; k < segs.length; k++) {
      plan.push({ start: segs[k].start, end: k + 1 < segs.length ? segs[k + 1].start : duration, shift: segs[k].shift });
    }
    return plan;
  }

  /**
   * Render a plan from tightenPlan. Output sample at time t reads the source
   * at t - shift(t), whole-sample shifts, zeros outside the source. Each
   * segment reads the continuous source, so a later move never leaves
   * silence, and neighbours with different shifts are joined by an
   * equal-power crossfade of opts.fadeMs (10) centred on the boundary.
   * Segment k runs from plan[k].start to plan[k+1].start; time before the
   * first start uses shift 0. Returns new Float32Arrays of the same length.
   */
  function applyPlan(channels, sampleRate, plan, opts) {
    opts = opts || {};
    var fadeHalf = Math.max(1, Math.round(num(opts.fadeMs, 10) / 2000 * sampleRate));
    var len = channels.length ? channels[0].length : 0;
    var segs = (plan || []).slice().sort(function (a, b) { return a.start - b.start; });
    if (!segs.length || segs[0].start > 0) segs.unshift({ start: 0, shift: 0 });
    var starts = [], shifts = [];
    for (var k = 0; k < segs.length; k++) {
      var s = clamp(Math.round(segs[k].start * sampleRate), 0, len);
      var d = Math.round(num(segs[k].shift, 0) * sampleRate);
      if (starts.length && s <= starts[starts.length - 1]) { shifts[shifts.length - 1] = d; continue; }
      if (shifts.length && d === shifts[shifts.length - 1]) continue;   // nothing changes here
      starts.push(s); shifts.push(d);
    }
    starts[0] = 0;
    var nseg = starts.length, out = [];
    for (var c = 0; c < channels.length; c++) {
      var x = channels[c], y = new Float32Array(len), i, j;
      for (k = 0; k < nseg; k++) {
        var a = starts[k], b = k + 1 < nseg ? starts[k + 1] : len, sh = shifts[k];
        for (i = a; i < b; i++) { j = i - sh; y[i] = j >= 0 && j < len ? x[j] : 0; }
      }
      for (k = 1; k < nseg; k++) {
        var B = starts[k], prevLen = B - starts[k - 1];
        var nextLen = (k + 1 < nseg ? starts[k + 1] : len) - B;
        var h = Math.min(fadeHalf, prevLen >> 1, nextLen >> 1);
        if (h < 1) continue;
        var d0 = shifts[k - 1], d1 = shifts[k];
        if (d0 === d1) continue;
        for (i = B - h; i < B + h; i++) {
          var u = (i - (B - h) + 0.5) / (2 * h) * Math.PI / 2;
          var j0 = i - d0, j1 = i - d1;
          var v0 = j0 >= 0 && j0 < len ? x[j0] : 0, v1 = j1 >= 0 && j1 < len ? x[j1] : 0;
          y[i] = Math.cos(u) * v0 + Math.sin(u) * v1;
        }
      }
      out.push(y);
      progress(opts, (c + 1) / channels.length);
    }
    return out;
  }

  // -------------------------------------------------------------- song ---

  /**
   * Tempo and bar grid of a song in one call: onsetEnvelope (full band and
   * [30, 200] Hz from one STFT pass), estimateTempo, then estimateGrid with
   * the low band for the downbeat. Feed it the drums stem or the full mix;
   * a vocal alone rarely carries a steady pulse.
   * opts: minBpm, maxBpm, priorBpm, beatsPerBar = 4, beatUnit = 4, hop, onProgress.
   * Returns {bpm, confidence, beatOffset, barOffset (-> project.gridOffset),
   * gridConfidence, candidates}.
   */
  function analyzeSong(channels, sampleRate, opts) {
    opts = opts || {};
    var envs = envelopes(channels, sampleRate, [[30, 8000], [30, 200]], {
      hop: opts.hop,
      onProgress: function (f) { progress(opts, 0.85 * f); }
    });
    var tempo = estimateTempo(envs[0], { minBpm: opts.minBpm, maxBpm: opts.maxBpm, priorBpm: opts.priorBpm });
    progress(opts, 0.95);
    var grid = estimateGrid(envs[0], tempo.bpm, {
      beatsPerBar: opts.beatsPerBar, beatUnit: opts.beatUnit, lowEnv: envs[1]
    });
    progress(opts, 1);
    return {
      bpm: tempo.bpm,
      confidence: tempo.confidence,
      beatOffset: grid.beatOffset,
      barOffset: grid.barOffset,
      gridConfidence: grid.confidence,
      candidates: tempo.candidates
    };
  }

  return {
    onsetEnvelope: onsetEnvelope,
    detectOnsets: detectOnsets,
    estimateTempo: estimateTempo,
    estimateGrid: estimateGrid,
    alignmentOffset: alignmentOffset,
    timingReport: timingReport,
    tightenPlan: tightenPlan,
    applyPlan: applyPlan,
    analyzeSong: analyzeSong
  };
});
