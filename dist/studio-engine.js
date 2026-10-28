/*! Stem to Stream Studio engine 1.0.0: 19 files, load order kept.
 * Load as a classic <script> (not an ES module, not through a bundler), then:
 *   const studio = window.S2S.studio.createController(); studio.init();
 * Source: js/ in this repository. Built by scripts/bundle.mjs; do not edit. */

// ---- js/audio-analysis.js ----
/*
 * Stem to Stream — audio analysis.
 *
 * Loudness and peak metering for the "Master Check" tool:
 *   - integrated loudness, momentary/short-term maxima (ITU-R BS.1770-4, EBU R128)
 *   - loudness range (EBU Tech 3342)
 *   - true peak via polyphase oversampling (BS.1770-4 Annex 2 method)
 *   - format, clipping, silence, abrupt-ending and stereo checks
 *
 * Runs in the browser (window.S2S.audio) and in Node (module.exports) so the
 * maths is unit-tested against the EBU reference signals in tests/.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.S2S = root.S2S || {};
    root.S2S.audio = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SILENCE_THRESHOLD = Math.pow(10, -60 / 20); // -60 dBFS
  var CLIP_THRESHOLD = 0.9999;                     // ~ -0.001 dBFS
  var ABSOLUTE_GATE = -70;                         // LUFS

  // ---------------------------------------------------------------- WAV ---

  function fourCC(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3));
  }

  /**
   * Parse a RIFF/RF64 WAVE file (PCM 8/16/24/32-bit, IEEE float 32/64-bit,
   * WAVE_FORMAT_EXTENSIBLE). Returns de-interleaved Float32 channel data.
   */
  function parseWav(buffer) {
    if (!buffer || buffer.byteLength < 12) throw new Error('This file is too small to be a WAV file.');
    var view = new DataView(buffer);
    var riff = fourCC(view, 0);
    if ((riff !== 'RIFF' && riff !== 'RF64') || fourCC(view, 8) !== 'WAVE') {
      throw new Error('This is not a WAV file. Export a WAV from Suno Studio or your mastering tool.');
    }

    var offset = 12, fmt = null, dataOffset = -1, dataSize = 0, rf64DataSize = null;
    while (offset + 8 <= buffer.byteLength) {
      var id = fourCC(view, offset);
      var size = view.getUint32(offset + 4, true);
      var body = offset + 8;
      if (id === 'ds64' && size >= 16) {
        rf64DataSize = view.getUint32(body + 8, true) + view.getUint32(body + 12, true) * 4294967296;
      } else if (id === 'fmt ') {
        fmt = {
          tag: view.getUint16(body, true),
          channels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          blockAlign: view.getUint16(body + 12, true),
          bits: view.getUint16(body + 14, true),
          validBits: 0
        };
        if (fmt.tag === 0xFFFE && size >= 40) {
          fmt.validBits = view.getUint16(body + 18, true);
          fmt.tag = view.getUint16(body + 24, true); // SubFormat GUID begins with the format code
        }
      } else if (id === 'data') {
        dataOffset = body;
        dataSize = size;
        if (riff === 'RF64' && size === 0xFFFFFFFF && rf64DataSize !== null) dataSize = rf64DataSize;
        // Streaming writers leave 0 or 0xFFFFFFFF; truncated files are shorter than declared.
        if (dataSize === 0 || dataOffset + dataSize > buffer.byteLength) dataSize = buffer.byteLength - dataOffset;
        if (fmt) break;
      }
      if (size === 0xFFFFFFFF) break;
      offset = body + size + (size & 1);
    }

    if (!fmt) throw new Error('The WAV file has no format chunk, so it cannot be read.');
    if (dataOffset < 0) throw new Error('The WAV file has no audio data chunk.');
    if (fmt.tag !== 1 && fmt.tag !== 3) {
      throw new Error('Unsupported WAV encoding (format code ' + fmt.tag + '). Export as PCM or 32-bit float WAV.');
    }
    var channels = fmt.channels;
    var bytes = fmt.bits / 8;
    if (!channels || !fmt.sampleRate || [1, 2, 3, 4, 8].indexOf(bytes) < 0) {
      throw new Error('The WAV header is damaged (channels, sample rate or bit depth is invalid).');
    }
    var isFloat = fmt.tag === 3;
    if (isFloat && bytes !== 4 && bytes !== 8) throw new Error('Unsupported float WAV bit depth: ' + fmt.bits + '.');
    if (!isFloat && bytes === 8) throw new Error('Unsupported 64-bit integer WAV.');

    var frameBytes = fmt.blockAlign || channels * bytes;
    var frames = Math.floor(dataSize / frameBytes);
    var out = [];
    for (var c = 0; c < channels; c++) out.push(new Float32Array(frames));

    // Typed-array views need aligned offsets; copy the data chunk when it is not.
    var src = buffer, base = dataOffset;
    if (base % 8 !== 0) {
      src = buffer.slice(dataOffset, dataOffset + frames * frameBytes);
      base = 0;
    }
    var i, v, idx;
    if (frameBytes === channels * bytes && (bytes === 2 || bytes === 4 || bytes === 8)) {
      var arr;
      if (isFloat && bytes === 4) arr = new Float32Array(src, base, frames * channels);
      else if (isFloat) arr = new Float64Array(src, base, frames * channels);
      else if (bytes === 2) arr = new Int16Array(src, base, frames * channels);
      else arr = new Int32Array(src, base, frames * channels);
      var scale = isFloat ? 1 : (bytes === 2 ? 1 / 32768 : 1 / 2147483648);
      for (c = 0; c < channels; c++) {
        var ch = out[c];
        for (i = 0, idx = c; i < frames; i++, idx += channels) ch[i] = arr[idx] * scale;
      }
    } else {
      var u8 = new Uint8Array(src, base, frames * frameBytes);
      for (c = 0; c < channels; c++) {
        var chan = out[c];
        for (i = 0; i < frames; i++) {
          idx = i * frameBytes + c * bytes;
          if (bytes === 3) {
            v = u8[idx] | (u8[idx + 1] << 8) | (u8[idx + 2] << 16);
            if (v & 0x800000) v -= 0x1000000;
            chan[i] = v / 8388608;
          } else if (bytes === 1) {
            chan[i] = (u8[idx] - 128) / 128;
          } else {
            // Unusual padding: fall back to DataView for 16/32/64-bit samples.
            var dv = new DataView(src, base + idx, bytes);
            if (isFloat) chan[i] = bytes === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
            else if (bytes === 2) chan[i] = dv.getInt16(0, true) / 32768;
            else chan[i] = dv.getInt32(0, true) / 2147483648;
          }
        }
      }
    }

    return {
      container: riff === 'RF64' ? 'RF64' : 'WAV',
      encoding: isFloat ? 'float' : 'pcm',
      bitsPerSample: fmt.validBits || fmt.bits,
      sampleRate: fmt.sampleRate,
      channels: channels,
      frames: frames,
      duration: frames / fmt.sampleRate,
      channelData: out
    };
  }

  // ------------------------------------------------------ K-weighting ---

  /**
   * K-weighting biquads for any sample rate (BS.1770-4). The analog
   * prototype parameters are the ones libebur128 derives from the 48 kHz
   * coefficients published in the recommendation, so 48 kHz matches the
   * table exactly and other rates follow via the bilinear transform.
   */
  function kWeighting(sampleRate) {
    var f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    var K = Math.tan(Math.PI * f0 / sampleRate);
    var Vh = Math.pow(10, G / 20);
    var Vb = Math.pow(Vh, 0.4996667741545416);
    var a0 = 1 + K / Q + K * K;
    var shelf = {
      b0: (Vh + Vb * K / Q + K * K) / a0,
      b1: 2 * (K * K - Vh) / a0,
      b2: (Vh - Vb * K / Q + K * K) / a0,
      a1: 2 * (K * K - 1) / a0,
      a2: (1 - K / Q + K * K) / a0
    };
    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / sampleRate);
    var d = 1 + K / Q + K * K;
    var highpass = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / d, a2: (1 - K / Q + K * K) / d };
    return { shelf: shelf, highpass: highpass };
  }

  function channelWeights(count) {
    // BS.1770 weights: 1.0 for L/R/C, 0 for LFE, 1.41 for surrounds (5.1 order L R C LFE Ls Rs).
    if (count === 6) return [1, 1, 1, 0, 1.41, 1.41];
    var w = [];
    for (var i = 0; i < count; i++) w.push(1);
    return w;
  }

  // ----------------------------------------------- true-peak filter ---

  function besselI0(x) {
    var sum = 1, term = 1, q = x * x / 4;
    for (var k = 1; k < 200; k++) {
      term *= q / (k * k);
      sum += term;
      if (term < sum * 1e-15) break;
    }
    return sum;
  }

  /** Kaiser-windowed sinc interpolator split into `factor` polyphase branches. */
  function designInterpolator(factor, tapsPerPhase, beta) {
    var n, k, p, N = factor * tapsPerPhase, center = (N - 1) / 2, i0b = besselI0(beta);
    var h = new Float64Array(N);
    for (n = 0; n < N; n++) {
      var t = (n - center) / factor;
      var r = 2 * n / (N - 1) - 1;
      var w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
      h[n] = (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
    }
    var phases = [];
    for (p = 0; p < factor; p++) {
      var taps = new Float64Array(tapsPerPhase), sum = 0;
      for (k = 0; k < tapsPerPhase; k++) { taps[k] = h[p + k * factor]; sum += taps[k]; }
      for (k = 0; k < tapsPerPhase; k++) taps[k] /= sum; // unity gain per branch
      phases.push(taps);
    }
    return phases;
  }

  var interpolatorCache = {};
  function interpolatorFor(factor) {
    if (!interpolatorCache[factor]) {
      var phases = designInterpolator(factor, 16, 8), gain = 0;
      var flat = new Float64Array(factor * phases[0].length);
      // Largest possible output for a full-scale input: sum of |taps| per branch.
      phases.forEach(function (taps, p) {
        var s = 0;
        for (var i = 0; i < taps.length; i++) {
          s += Math.abs(taps[i]);
          flat[p * taps.length + i] = taps[i];
        }
        if (s > gain) gain = s;
      });
      interpolatorCache[factor] = { phases: phases, flat: flat, gain: gain };
    }
    return interpolatorCache[factor];
  }

  // ------------------------------------------------------- analyzer ---

  function toDb(linear) {
    return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
  }

  function energyToLufs(energy) {
    return energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity;
  }

  function percentile(sorted, q) {
    if (!sorted.length) return NaN;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * Incremental analyzer: call step() until done, then result().
   * Splitting the work lets the browser UI stay responsive on long files.
   */
  function createAnalyzer(channelData, sampleRate) {
    if (!channelData || !channelData.length) throw new Error('No audio channels to analyze.');
    var chCount = channelData.length;
    var frames = channelData[0].length;
    var k = kWeighting(sampleRate);
    var weights = channelWeights(chCount);
    var hopSize = Math.max(1, Math.round(sampleRate * 0.1)); // 100 ms hop, 75 % block overlap
    var factor = sampleRate < 96000 ? 4 : (sampleRate < 192000 ? 2 : 1);
    var interp = factor > 1 ? interpolatorFor(factor) : null;
    var phases = interp ? interp.phases : null;
    var taps = phases ? phases[0].length : 0;
    var TP_BLOCK = 64;

    var filt = [], hopEnergy = [], hopAcc = new Float64Array(chCount), hopFill = 0;
    var samplePeak = new Float64Array(chCount), truePeak = new Float64Array(chCount);
    var clipEvents = 0, clipRun = new Int32Array(chCount), clippedSamples = 0;
    var firstLoud = Infinity, lastLoud = -1, sums = new Float64Array(chCount);
    var sumLL = 0, sumRR = 0, sumLR = 0;
    for (var c = 0; c < chCount; c++) {
      filt.push(new Float64Array(8));
      hopEnergy.push([]);
    }
    var pos = 0;

    function step(maxFrames) {
      var start = pos, end = Math.min(frames, pos + (maxFrames || frames));
      var fillAfter = hopFill;
      for (var c = 0; c < chCount; c++) {
        var x = channelData[c], s = filt[c];
        var x1 = s[0], x2 = s[1], y1 = s[2], y2 = s[3], u1 = s[4], u2 = s[5], z1 = s[6], z2 = s[7];
        var sh = k.shelf, hp = k.highpass;
        var acc = hopAcc[c], fill = hopFill, energies = hopEnergy[c];
        var peak = samplePeak[c], tp = truePeak[c], run = clipRun[c], dc = sums[c];
        var i, j, t, v, a, y, z;
        for (i = start; i < end; i++) {
          v = x[i];
          // K-weighting: high shelf then RLB high-pass (direct form I, float64 state)
          y = sh.b0 * v + sh.b1 * x1 + sh.b2 * x2 - sh.a1 * y1 - sh.a2 * y2;
          x2 = x1; x1 = v; y2 = y1; y1 = y;
          z = hp.b0 * y + hp.b1 * u1 + hp.b2 * u2 - hp.a1 * z1 - hp.a2 * z2;
          u2 = u1; u1 = y; z2 = z1; z1 = z;
          acc += z * z;
          if (++fill === hopSize) { energies.push(acc); acc = 0; fill = 0; }

          a = v < 0 ? -v : v;
          dc += v;
          if (a > peak) peak = a;
          if (a >= CLIP_THRESHOLD) {
            clippedSamples++;
            if (++run === 3) clipEvents++;
          } else {
            run = 0;
          }
          if (a > SILENCE_THRESHOLD) {
            if (i < firstLoud) firstLoud = i;
            if (i > lastLoud) lastLoud = i;
          }
        }
        if (phases) {
          // True peak: interpolate `factor` points per input sample. A block
          // is skipped only when even the filter's worst-case gain applied to
          // the block's loudest input sample cannot beat the running maximum,
          // so skipping never changes the result.
          for (var b0 = start; b0 < end; b0 += TP_BLOCK) {
            var b1 = Math.min(end, b0 + TP_BLOCK), wmax = 0;
            for (i = Math.max(0, b0 - taps + 1); i < b1; i++) {
              a = x[i] < 0 ? -x[i] : x[i];
              if (a > wmax) wmax = a;
            }
            if (wmax * interp.gain <= tp) continue;
            var flat = interp.flat, sum, base;
            for (i = b0; i < b1; i++) {
              if (i >= taps - 1) {
                for (t = 0, base = 0; t < factor; t++, base += taps) {
                  sum = 0;
                  for (j = 0; j < taps; j++) sum += flat[base + j] * x[i - j];
                  if (sum < 0) sum = -sum;
                  if (sum > tp) tp = sum;
                }
              } else {
                for (t = 0, base = 0; t < factor; t++, base += taps) {
                  sum = 0; // history before the file start is silence
                  for (j = 0; j <= i; j++) sum += flat[base + j] * x[i - j];
                  if (sum < 0) sum = -sum;
                  if (sum > tp) tp = sum;
                }
              }
            }
          }
        }
        s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2; s[4] = u1; s[5] = u2; s[6] = z1; s[7] = z2;
        hopAcc[c] = acc; samplePeak[c] = peak; truePeak[c] = tp; clipRun[c] = run; sums[c] = dc;
        fillAfter = fill;
      }
      if (chCount >= 2) {
        var L = channelData[0], R = channelData[1];
        for (var m = start; m < end; m++) {
          var l = L[m], r = R[m];
          sumLL += l * l; sumRR += r * r; sumLR += l * r;
        }
      }
      hopFill = fillAfter;
      pos = end;
      return frames ? pos / frames : 1;
    }

    function blockLoudness(fromHop, hopCount) {
      var energy = 0;
      for (var c = 0; c < chCount; c++) {
        if (!weights[c]) continue;
        var e = hopEnergy[c], s = 0;
        for (var h = fromHop; h < fromHop + hopCount; h++) s += e[h];
        energy += weights[c] * s / (hopCount * hopSize);
      }
      return energy;
    }

    function result() {
      if (pos < frames) throw new Error('Analysis is not finished yet.');
      var hops = hopEnergy[0].length;

      // Integrated loudness: 400 ms blocks, absolute then relative gate.
      var blocks = [];
      for (var b = 0; b + 4 <= hops; b++) blocks.push(blockLoudness(b, 4));
      var momentaryMax = -Infinity, sumAbs = 0, nAbs = 0, i;
      var blockLufs = blocks.map(energyToLufs);
      for (i = 0; i < blocks.length; i++) {
        if (blockLufs[i] > momentaryMax) momentaryMax = blockLufs[i];
        if (blockLufs[i] > ABSOLUTE_GATE) { sumAbs += blocks[i]; nAbs++; }
      }
      var integrated = -Infinity;
      if (nAbs) {
        var relativeGate = energyToLufs(sumAbs / nAbs) - 10;
        var sumRel = 0, nRel = 0;
        for (i = 0; i < blocks.length; i++) {
          if (blockLufs[i] > ABSOLUTE_GATE && blockLufs[i] > relativeGate) { sumRel += blocks[i]; nRel++; }
        }
        if (nRel) integrated = energyToLufs(sumRel / nRel);
      }

      // Short-term loudness (3 s window, 10 Hz) and loudness range (EBU Tech 3342).
      var shortTerm = [], shortTermMax = -Infinity;
      for (b = 0; b + 30 <= hops; b++) {
        var st = energyToLufs(blockLoudness(b, 30));
        shortTerm.push(st);
        if (st > shortTermMax) shortTermMax = st;
      }
      var lra = NaN;
      var stAbs = shortTerm.filter(function (v) { return v > ABSOLUTE_GATE; });
      if (stAbs.length) {
        var meanEnergy = stAbs.reduce(function (s, v) { return s + Math.pow(10, v / 10); }, 0) / stAbs.length;
        var stGate = 10 * Math.log10(meanEnergy) - 20;
        var stKept = stAbs.filter(function (v) { return v > stGate; }).sort(function (a, z) { return a - z; });
        if (stKept.length) lra = percentile(stKept, 0.95) - percentile(stKept, 0.10);
      }

      // Peaks and housekeeping.
      var sp = 0, tp = 0, dc = 0;
      for (var c = 0; c < chCount; c++) {
        if (samplePeak[c] > sp) sp = samplePeak[c];
        if (Math.max(truePeak[c], samplePeak[c]) > tp) tp = Math.max(truePeak[c], samplePeak[c]);
        var mean = frames ? Math.abs(sums[c] / frames) : 0;
        if (mean > dc) dc = mean;
      }

      var tailFrames = Math.min(frames, Math.round(sampleRate * 0.25)), tailEnergy = 0;
      for (c = 0; c < chCount; c++) {
        var x = channelData[c];
        for (i = frames - tailFrames; i < frames; i++) tailEnergy += x[i] * x[i];
      }
      var tailRms = tailFrames ? Math.sqrt(tailEnergy / (tailFrames * chCount)) : 0;

      var correlation = null;
      if (chCount >= 2 && sumLL > 0 && sumRR > 0) correlation = sumLR / Math.sqrt(sumLL * sumRR);

      return {
        sampleRate: sampleRate,
        channels: chCount,
        frames: frames,
        duration: frames / sampleRate,
        integrated: integrated,
        momentaryMax: momentaryMax,
        shortTermMax: shortTermMax,
        loudnessRange: lra,
        samplePeakDb: toDb(sp),
        truePeakDb: toDb(tp),
        oversampling: factor,
        clipEvents: clipEvents,
        clippedSamples: clippedSamples,
        leadingSilence: lastLoud < 0 ? frames / sampleRate : firstLoud / sampleRate,
        trailingSilence: lastLoud < 0 ? frames / sampleRate : (frames - 1 - lastLoud) / sampleRate,
        tailLevelDb: toDb(tailRms),
        correlation: correlation,
        dcOffsetDb: toDb(dc)
      };
    }

    return {
      step: step,
      result: result,
      get done() { return pos >= frames; },
      get progress() { return frames ? pos / frames : 1; }
    };
  }

  /** Analyze in one go (Node tests, short files). */
  function analyze(channelData, sampleRate) {
    var a = createAnalyzer(channelData, sampleRate);
    while (!a.done) a.step(1 << 16);
    return a.result();
  }

  /** Analyze without freezing the page; onProgress receives 0..1. */
  function analyzeAsync(channelData, sampleRate, onProgress) {
    var a = createAnalyzer(channelData, sampleRate);
    var chunk = Math.max(4096, Math.round(sampleRate * 2));
    return new Promise(function (resolve, reject) {
      function tick() {
        try {
          var started = Date.now();
          while (!a.done && Date.now() - started < 40) a.step(chunk);
          if (onProgress) onProgress(a.progress);
          if (a.done) resolve(a.result());
          else setTimeout(tick, 0);
        } catch (err) {
          reject(err);
        }
      }
      tick();
    });
  }

  // ------------------------------------------------------- verdicts ---

  /**
   * Turn measurements into release-readiness findings. Thresholds follow
   * Spotify's published guidance (-14 LUFS reference; keep true peak below
   * -1 dBTP, or below -2 dBTP when the master is louder than -14 LUFS) and
   * common distributor file requirements.
   */
  function assess(m, fileInfo) {
    var findings = [];
    function add(level, title, detail) { findings.push({ level: level, title: title, detail: detail }); }
    fileInfo = fileInfo || {};

    if (fileInfo.container && fileInfo.container !== 'WAV' && fileInfo.container !== 'RF64') {
      add('fail', 'Not a WAV file',
        'Most distributors want a lossless WAV (or FLAC). Upload the WAV export, not an MP3.');
    }
    if (fileInfo.encoding === 'float' || fileInfo.bitsPerSample > 24) {
      add('warn', fileInfo.bitsPerSample + '-bit float file',
        'Great for mixing and mastering. Many distributors ask for 16- or 24-bit PCM, so convert your final master to 24-bit (or 16-bit) WAV before upload.');
    } else if (fileInfo.bitsPerSample && fileInfo.bitsPerSample < 16) {
      add('fail', fileInfo.bitsPerSample + '-bit audio', 'Export at 16-bit or 24-bit.');
    }
    if (m.sampleRate !== 44100 && m.sampleRate !== 48000) {
      add('warn', 'Sample rate ' + (m.sampleRate / 1000) + ' kHz',
        '44.1 kHz and 48 kHz are the safe choices. Check what your distributor accepts.');
    }
    if (m.channels === 1) {
      add('warn', 'Mono file', 'Distributors and streaming services expect a stereo file. Export stereo.');
    } else if (m.channels > 2) {
      add('warn', m.channels + ' channels', 'Deliver a stereo (2-channel) master for streaming.');
    }

    var lufs = m.integrated;
    if (!isFinite(lufs)) {
      add('fail', 'No audio detected', 'The file is silent or too quiet to measure.');
    } else if (lufs > -7) {
      add('warn', 'Very loud master (' + lufs.toFixed(1) + ' LUFS)',
        'Spotify turns it down ' + (lufs + 14).toFixed(1) + ' dB to -14 LUFS by default, so the extra loudness buys nothing and the heavy limiting stays audible. Consider backing off the limiter.');
    } else if (lufs < -18) {
      add('warn', 'Quiet master (' + lufs.toFixed(1) + ' LUFS)',
        'Spotify raises quiet songs only as far as their peaks allow, keeping 1 dB of headroom, so it may play quieter than other songs. Spotify recommends mastering to about -14 LUFS.');
    } else {
      add('pass', 'Loudness ' + lufs.toFixed(1) + ' LUFS', 'A normal range for streaming. Spotify plays songs at -14 LUFS by default.');
    }

    var ceiling = lufs > -14 ? -2 : -1;
    if (m.truePeakDb > 0) {
      add('fail', 'True peak above 0 dBTP (' + m.truePeakDb.toFixed(2) + ')',
        'The waveform goes over full scale between samples and will distort after encoding. Lower the limiter ceiling to ' + ceiling + ' dBTP.');
    } else if (m.truePeakDb > ceiling) {
      add('warn', 'True peak ' + m.truePeakDb.toFixed(2) + ' dBTP',
        'Spotify recommends keeping true peak below ' + ceiling + ' dBTP for a master at this loudness, to avoid distortion when it is converted to streaming formats.');
    } else {
      add('pass', 'True peak ' + m.truePeakDb.toFixed(2) + ' dBTP', 'Below the ' + ceiling + ' dBTP ceiling.');
    }

    if (m.clipEvents > 0) {
      add('fail', m.clipEvents + ' clipping event' + (m.clipEvents === 1 ? '' : 's'),
        'Three or more samples in a row hit full scale. Turn the mix down before the limiter, or lower the limiter ceiling.');
    }
    if (m.leadingSilence > 2) {
      add('warn', m.leadingSilence.toFixed(1) + ' s of silence at the start', 'Trim the start so the song begins within a second.');
    }
    if (m.trailingSilence > 10) {
      add('warn', m.trailingSilence.toFixed(1) + ' s of silence at the end', 'Trim the end. Long silence counts against listeners who skip.');
    }
    if (m.duration > 3 && m.tailLevelDb > -24) {
      add('warn', 'Ends abruptly',
        'The last quarter-second is still loud (' + m.tailLevelDb.toFixed(1) + ' dBFS). AI songs often stop mid-note. Add a fade-out or regenerate a proper ending.');
    }
    if (m.duration < 30) {
      add('warn', 'Shorter than 30 seconds', 'On Spotify a play has to last 30 seconds to count as a stream.');
    }
    if (m.correlation !== null) {
      if (m.correlation < 0) {
        add('fail', 'Phase problem (correlation ' + m.correlation.toFixed(2) + ')',
          'Left and right partly cancel each other. The song will lose parts on mono speakers. Check stereo-widening effects and stems that are out of phase.');
      } else if (m.correlation > 0.999) {
        add('info', 'Left and right are identical', 'The file is effectively mono. Fine if intended, but most songs have some stereo width.');
      }
    }
    if (m.dcOffsetDb > -50) {
      add('warn', 'DC offset', 'The waveform is shifted off center. A high-pass filter at 20 to 30 Hz on the master removes it.');
    }
    return findings;
  }

  return {
    parseWav: parseWav,
    kWeighting: kWeighting,
    designInterpolator: designInterpolator,
    createAnalyzer: createAnalyzer,
    analyze: analyze,
    analyzeAsync: analyzeAsync,
    assess: assess
  };
});
;

// ---- js/demo-loop.js ----
/*
 * Stem to Stream: the synthesized demo loop (96 BPM, 4 bars, A minor).
 * Five mono stems rendered offline: drums, hats, bass, keys and a lead line.
 * Used by the course's Mixer Trainer and demo master, and by the studio's
 * demo song. Each stem is normalized to peak at -6 dBFS.
 */
(function () {
  'use strict';

  var S2S = (window.S2S = window.S2S || {});

  var LOOP = { bpm: 96, bars: 4, key: 'A minor' };
  LOOP.beat = 60 / LOOP.bpm;
  LOOP.seconds = LOOP.bars * 4 * LOOP.beat;

  var TRACKS = [
    { id: 'drums', name: 'Drums', color: 3 },
    { id: 'hats', name: 'Hats', color: 2 },
    { id: 'bass', name: 'Bass', color: 4 },
    { id: 'keys', name: 'Keys', color: 1 },
    { id: 'lead', name: 'Lead vocal*', color: 7 }
  ];

  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  var loopCache = {};
  function renderLoop(sr) {
    if (loopCache[sr]) return loopCache[sr];
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error('Web Audio is not available.'));
    var frames = Math.ceil(LOOP.seconds * sr);
    var beat = LOOP.beat;
    var chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]; // Am F C G
    var bassRoots = [33, 29, 36, 31];
    var mudRoots = [45, 41, 48, 43];
    var melody = [
      [76, 0, 1], [74, 1, 0.5], [72, 1.5, 0.5], [69, 2, 2],
      [72, 4, 1], [69, 5, 1], [65, 6, 0.5], [69, 6.5, 0.5], [72, 7, 1],
      [67, 8, 1], [64, 9, 0.5], [67, 9.5, 0.5], [72, 10, 2],
      [71, 12, 1], [69, 13, 0.5], [67, 13.5, 0.5], [74, 14, 1.5]
    ];

    function make() {
      var ctx = new Offline(1, frames, sr);
      return ctx;
    }
    function noiseBuffer(ctx) {
      var b = ctx.createBuffer(1, sr, sr), d = b.getChannelData(0), s = 24681;
      for (var i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
      return b;
    }
    function env(ctx, t, peak, attack, hold, release) {
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, t + attack + hold);
      g.gain.linearRampToValueAtTime(0, t + attack + hold + release);
      return g;
    }
    function tone(ctx, dest, type, freq, t, peak, attack, hold, release, detune) {
      var o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (detune) o.detune.setValueAtTime(detune, t);
      var g = env(ctx, t, peak, attack, hold, release);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + attack + hold + release + 0.02);
      return o;
    }

    function drums() {
      var ctx = make(), nb = noiseBuffer(ctx);
      for (var b = 0; b < LOOP.bars; b++) {
        [0, 2, 2.5].forEach(function (pos) {
          var t = (b * 4 + pos) * beat;
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.setValueAtTime(140, t);
          o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(1, t + 0.004);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
          o.connect(g); g.connect(ctx.destination);
          o.start(t); o.stop(t + 0.4);
        });
        [1, 3].forEach(function (pos) {
          var t = (b * 4 + pos) * beat;
          var src = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
          src.buffer = nb;
          hp.type = 'highpass'; hp.frequency.value = 1200;
          g.gain.setValueAtTime(0.75, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          src.connect(hp); hp.connect(g); g.connect(ctx.destination);
          src.start(t, (b * 0.13 + pos * 0.07) % 0.6); src.stop(t + 0.22);
          tone(ctx, ctx.destination, 'triangle', 190, t, 0.45, 0.002, 0.01, 0.1);
        });
      }
      return ctx.startRendering();
    }

    function hats() {
      var ctx = make(), nb = noiseBuffer(ctx);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7000;
      hp.connect(ctx.destination);
      for (var i = 0; i < LOOP.bars * 8; i++) {
        var t = i * beat / 2, g = ctx.createGain(), src = ctx.createBufferSource();
        src.buffer = nb;
        g.gain.setValueAtTime(i % 2 ? 0.5 : 0.3, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        src.connect(g); g.connect(hp);
        src.start(t, (i * 0.031) % 0.8); src.stop(t + 0.06);
      }
      return ctx.startRendering();
    }

    function bass() {
      var ctx = make(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 750; lp.Q.value = 3;
      lp.connect(ctx.destination);
      for (var b = 0; b < LOOP.bars; b++) {
        for (var e = 0; e < 8; e++) {
          var note = bassRoots[b] + (e === 3 || e === 7 ? 12 : 0);
          tone(ctx, lp, 'sawtooth', midiHz(note), (b * 4 + e / 2) * beat, 0.6, 0.005, beat / 2 - 0.06, 0.04);
        }
      }
      return ctx.startRendering();
    }

    function keys() {
      var ctx = make(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2400;
      lp.connect(ctx.destination);
      for (var b = 0; b < LOOP.bars; b++) {
        var t = b * 4 * beat, hold = 4 * beat - 0.25;
        chords[b].forEach(function (n) {
          tone(ctx, lp, 'sawtooth', midiHz(n), t, 0.16, 0.06, hold, 0.15, -6);
          tone(ctx, lp, 'sawtooth', midiHz(n), t, 0.16, 0.06, hold, 0.15, 6);
        });
        // Low-mid build-up that the "clean up the low end" exercise removes.
        tone(ctx, lp, 'sine', midiHz(mudRoots[b]), t, 0.55, 0.06, hold, 0.15);
        tone(ctx, lp, 'sawtooth', midiHz(mudRoots[b] - 12), t, 0.22, 0.06, hold, 0.15);
      }
      return ctx.startRendering();
    }

    function lead() {
      var ctx = make(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3600;
      lp.connect(ctx.destination);
      melody.forEach(function (n) {
        var t = n[1] * beat, dur = n[2] * beat, f = midiHz(n[0]);
        var o = tone(ctx, lp, 'triangle', f, t, 0.7, 0.03, Math.max(0.05, dur - 0.12), 0.08);
        tone(ctx, lp, 'sine', f * 2, t, 0.12, 0.03, Math.max(0.05, dur - 0.12), 0.08);
        var lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(f * 0.007, t + Math.min(0.3, dur));
        lfo.connect(depth); depth.connect(o.frequency);
        lfo.start(t); lfo.stop(t + dur + 0.1);
      });
      return ctx.startRendering();
    }

    loopCache[sr] = Promise.all([drums(), hats(), bass(), keys(), lead()]).then(function (buffers) {
      return {
        frames: frames,
        sampleRate: sr,
        tracks: TRACKS.map(function (t, i) {
          var data = buffers[i].getChannelData(0), peak = 0;
          for (var k = 0; k < data.length; k++) { var a = Math.abs(data[k]); if (a > peak) peak = a; }
          var norm = peak > 0 ? 0.5 / peak : 1; // every stem peaks at -6 dBFS
          var out = new Float32Array(data.length);
          for (k = 0; k < data.length; k++) out[k] = data[k] * norm;
          return { id: t.id, buffer: out };
        })
      };
    });
    loopCache[sr].catch(function () { delete loopCache[sr]; });
    return loopCache[sr];
  }

  S2S.demoLoop = { LOOP: LOOP, TRACKS: TRACKS, render: renderLoop, midiHz: midiHz };
})();
;

// ---- js/studio/core.js ----
/*
 * Stem to Stream Studio: song model and timeline maths.
 *
 * Plain data and pure functions, with no DOM or Web Audio, so the same code
 * runs in the browser (S2S.studio.core) and in the Node unit tests.
 *
 * A song holds:
 *   tracks   [{id, name, color, volumeDb, pan, mute, solo, fx,
 *              type?: 'midi', inst?: {type, preset, p}}]
 *   clips    [{id, trackId, sourceId, name, start, offset, duration,
 *              fadeIn, fadeOut, gainDb, disabled, versions?}]
 *            MIDI clips (on MIDI tracks) have kind: 'midi', sourceId: null
 *            and notes [{p: pitch, t: seconds, d: seconds, v: velocity}].
 *   sources  {id: {id, name, type, duration, sampleRate, channels, demo?}}
 * Times are in seconds. A clip plays `duration` seconds of its source,
 * starting `offset` seconds into the source, placed at `start` on the timeline.
 * A MIDI clip's notes are its source: note time t plays at song time
 * start + (t - offset) when it falls inside the clip.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.core = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var APP_ID = 'stem-to-stream-studio';
  var MIN_CLIP = 0.01;   // seconds
  var MIN_LOOP = 0.05;   // seconds
  var FLOOR_DB = -60;    // fader bottom: silence
  var MAX_DB = 6;
  var FADE_STEPS = 24;   // straight segments that approximate one fade curve
  var COLORS = 8;        // clip colour tokens --clip-0 to --clip-7
  var SNAPS = ['off', 'bar', '1/2', '1/4', '1/8', '1/16'];
  var DENOMINATORS = [2, 4, 8, 16];
  var INSTRUMENT_TYPES = ['synth', 'fm', 'organ', 'drums'];
  var MIN_NOTE = 0.005;     // seconds
  var MAX_NOTES = 20000;    // per clip
  var MAX_MIDI_CLIP = 3600; // seconds

  /*
   * Insert effects. Each parameter: label, min, max, step, unit, default,
   * and log (slider moves on a log scale) or options (a pick list).
   */
  var FX_TYPES = {
    eq: {
      name: 'EQ',
      params: {
        hpHz: { label: 'Low cut', min: 0, max: 500, step: 5, unit: 'Hz', def: 0, offAt: 0 },
        lowHz: { label: 'Low freq', min: 40, max: 500, step: 1, unit: 'Hz', def: 100, log: true },
        lowDb: { label: 'Low', min: -18, max: 18, step: 0.5, unit: 'dB', def: 0 },
        midHz: { label: 'Mid freq', min: 120, max: 4000, step: 1, unit: 'Hz', def: 600, log: true },
        midDb: { label: 'Mid', min: -18, max: 18, step: 0.5, unit: 'dB', def: 0 },
        midQ: { label: 'Mid width (Q)', min: 0.3, max: 8, step: 0.1, unit: '', def: 1 },
        presHz: { label: 'Presence freq', min: 1000, max: 10000, step: 10, unit: 'Hz', def: 3500, log: true },
        presDb: { label: 'Presence', min: -18, max: 18, step: 0.5, unit: 'dB', def: 0 },
        presQ: { label: 'Presence width (Q)', min: 0.3, max: 8, step: 0.1, unit: '', def: 1.2 },
        highHz: { label: 'High freq', min: 2000, max: 16000, step: 10, unit: 'Hz', def: 9000, log: true },
        highDb: { label: 'High', min: -18, max: 18, step: 0.5, unit: 'dB', def: 0 },
        lpHz: { label: 'High cut', min: 2000, max: 20000, step: 100, unit: 'Hz', def: 20000, log: true, offAt: 20000 }
      }
    },
    comp: {
      name: 'Compressor',
      params: {
        thresholdDb: { label: 'Threshold', min: -60, max: 0, step: 0.5, unit: 'dB', def: -18 },
        ratio: { label: 'Ratio', min: 1, max: 20, step: 0.1, unit: ':1', def: 3 },
        attackMs: { label: 'Attack', min: 0.5, max: 100, step: 0.5, unit: 'ms', def: 10, log: true },
        releaseMs: { label: 'Release', min: 20, max: 1000, step: 5, unit: 'ms', def: 150, log: true },
        kneeDb: { label: 'Knee', min: 0, max: 30, step: 1, unit: 'dB', def: 6 },
        makeupDb: { label: 'Make-up gain', min: 0, max: 24, step: 0.5, unit: 'dB', def: 0 }
      }
    },
    reverb: {
      name: 'Reverb',
      params: {
        mix: { label: 'Mix', min: 0, max: 100, step: 1, unit: '%', def: 20 },
        decayS: { label: 'Decay', min: 0.2, max: 10, step: 0.1, unit: 's', def: 1.8, log: true },
        preDelayMs: { label: 'Pre-delay', min: 0, max: 200, step: 1, unit: 'ms', def: 20 },
        toneHz: { label: 'Tone', min: 1000, max: 16000, step: 10, unit: 'Hz', def: 7000, log: true }
      }
    },
    delay: {
      name: 'Delay',
      params: {
        mix: { label: 'Mix', min: 0, max: 100, step: 1, unit: '%', def: 20 },
        sync: { label: 'Time (tempo)', options: ['off', '1/4', '1/8', '1/8d', '1/16', '1/4t', '1/8t'], def: '1/8' },
        timeMs: { label: 'Time (free)', min: 1, max: 2000, step: 1, unit: 'ms', def: 375, log: true },
        feedback: { label: 'Feedback', min: 0, max: 90, step: 1, unit: '%', def: 35 },
        toneHz: { label: 'Tone', min: 1000, max: 16000, step: 10, unit: 'Hz', def: 6000, log: true }
      }
    },
    drive: {
      name: 'Drive',
      params: {
        amount: { label: 'Drive', min: 0, max: 100, step: 1, unit: '%', def: 30 },
        toneHz: { label: 'Tone', min: 1000, max: 20000, step: 10, unit: 'Hz', def: 12000, log: true },
        mix: { label: 'Mix', min: 0, max: 100, step: 1, unit: '%', def: 100 },
        outDb: { label: 'Output', min: -24, max: 6, step: 0.5, unit: 'dB', def: 0 }
      }
    }
  };

  /** The master limiter, last in the chain: lookahead, true-peak aware. */
  var LIMITER = {
    driveDb: { label: 'Drive', min: -24, max: 24, step: 0.1, unit: 'dB', def: 0 },
    ceilingDb: { label: 'Ceiling', min: -6, max: 0, step: 0.1, unit: 'dBTP', def: -1 },
    releaseMs: { label: 'Release', min: 10, max: 1000, step: 5, unit: 'ms', def: 120, log: true }
  };

  var counter = 0;
  function uid(prefix) {
    counter = (counter + 1) % 1679616;
    return (prefix || '') + Date.now().toString(36).slice(-6) +
      Math.random().toString(36).slice(2, 7) + counter.toString(36);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function str(v, fallback, max) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max || 120) : fallback;
  }

  function dbToGain(db) { return db <= FLOOR_DB ? 0 : Math.pow(10, db / 20); }
  function gainToDb(g) { return g > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(g)) : FLOOR_DB; }

  // -------------------------------------------------------------- time ---

  /** Seconds per quarter note: BPM counts quarter notes, as most DAWs do. */
  function quarterSec(p) { return 60 / p.bpm; }
  /** Seconds per beat of the time signature (an eighth note in 6/8). */
  function beatSec(p) { return quarterSec(p) * 4 / p.sig[1]; }
  function barSec(p) { return beatSec(p) * p.sig[0]; }

  /** Grid step in seconds for a snap setting ('bar', '1/8', '1/8t' for triplets); 0 means no snapping. */
  function snapStep(p, snap) {
    if (snap === 'bar') return barSec(p);
    var m = /^1\/(\d+)(t?)$/.exec(snap || '');
    return m ? quarterSec(p) * 4 / Number(m[1]) * (m[2] ? 2 / 3 : 1) : 0;
  }

  function snapTime(p, t, snap) {
    var step = snapStep(p, snap === undefined ? p.snap : snap);
    if (!step) return t;
    return p.gridOffset + Math.round((t - p.gridOffset) / step) * step;
  }

  /** Bar, beat and sixteenth of the beat (all 1-based); bar 1 starts at gridOffset. */
  function toBBT(p, t) {
    var bar = barSec(p), beat = beatSec(p), rel = t - p.gridOffset;
    var b = Math.floor(rel / bar + 1e-9);
    var inBar = Math.max(0, rel - b * bar);
    var bt = Math.min(p.sig[0] - 1, Math.floor(inBar / beat + 1e-9));
    var sub = Math.floor((inBar - bt * beat) / (beat / 4) + 1e-9);
    return { bar: b + 1, beat: bt + 1, sub: clamp(sub + 1, 1, 4) };
  }

  function barToTime(p, bar) { return p.gridOffset + (bar - 1) * barSec(p); }

  function fmtBBT(p, t) {
    var x = toBBT(p, t);
    return x.bar + '.' + x.beat + '.' + x.sub;
  }

  function fmtClock(t) {
    var neg = t < 0, ms = Math.round(Math.abs(t) * 1000);
    var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return (neg ? '-' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + ('00' + r).slice(-3);
  }

  // ------------------------------------------------------------- model ---

  function createProject(opts) {
    opts = opts || {};
    var now = Date.now();
    return {
      app: APP_ID,
      version: 1,
      id: opts.id || uid('p'),
      name: opts.name || 'Untitled song',
      bpm: opts.bpm || 120,
      sig: opts.sig ? opts.sig.slice(0, 2) : [4, 4],
      gridOffset: opts.gridOffset || 0,
      snap: opts.snap || '1/4',
      masterDb: 0,
      master: { fx: [], limiter: limiterDefaults() },
      loop: { on: false, start: 0, end: 0 },
      tracks: [],
      clips: [],
      sources: {},
      created: now,
      updated: now
    };
  }

  function find(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function getTrack(p, id) { return find(p.tracks, id); }
  function getClip(p, id) { return find(p.clips, id); }
  function trackIndex(p, id) {
    for (var i = 0; i < p.tracks.length; i++) if (p.tracks[i].id === id) return i;
    return -1;
  }

  function clipEnd(c) { return c.start + c.duration; }

  function songEnd(p) {
    var end = 0;
    p.clips.forEach(function (c) { end = Math.max(end, clipEnd(c)); });
    return end;
  }

  /** Adds a track. opts.type 'midi' makes an instrument track playing opts.inst. */
  function addTrack(p, opts) {
    opts = opts || {};
    var t = {
      id: uid('t'),
      name: str(opts.name, 'Track ' + (p.tracks.length + 1), 60),
      color: opts.color != null ? clamp(Math.round(opts.color), 0, COLORS - 1) : p.tracks.length % COLORS,
      volumeDb: opts.volumeDb != null ? clamp(opts.volumeDb, FLOOR_DB, MAX_DB) : 0,
      pan: opts.pan != null ? clamp(opts.pan, -1, 1) : 0,
      mute: false,
      solo: false,
      fx: []
    };
    if (opts.type === 'midi') {
      t.type = 'midi';
      t.inst = cleanInst(opts.inst);
    }
    var at = opts.index != null ? clamp(opts.index, 0, p.tracks.length) : p.tracks.length;
    p.tracks.splice(at, 0, t);
    return t;
  }

  /** Removes a track and every clip on it. */
  function removeTrack(p, id) {
    p.tracks = p.tracks.filter(function (t) { return t.id !== id; });
    p.clips = p.clips.filter(function (c) { return c.trackId !== id; });
  }

  function moveTrack(p, id, delta) {
    var i = trackIndex(p, id), j = i + delta;
    if (i < 0 || j < 0 || j >= p.tracks.length) return false;
    var t = p.tracks.splice(i, 1)[0];
    p.tracks.splice(j, 0, t);
    return true;
  }

  function addSource(p, meta) {
    var s = {
      id: meta.id || uid('s'),
      name: str(meta.name, 'Audio', 120),
      type: meta.type || '',
      duration: meta.duration,
      sampleRate: meta.sampleRate,
      channels: meta.channels
    };
    if (meta.demo) s.demo = meta.demo;
    p.sources[s.id] = s;
    return s;
  }

  function addClip(p, opts) {
    var src = p.sources[opts.sourceId];
    if (!src) throw new Error('Unknown audio source.');
    var offset = clamp(num(opts.offset, 0), 0, Math.max(0, src.duration - MIN_CLIP));
    var c = {
      id: uid('c'),
      trackId: opts.trackId,
      sourceId: src.id,
      name: str(opts.name, src.name, 120),
      start: Math.max(0, num(opts.start, 0)),
      offset: offset,
      duration: clamp(num(opts.duration, src.duration - offset), MIN_CLIP, src.duration - offset),
      fadeIn: 0,
      fadeOut: 0,
      gainDb: 0,
      disabled: false
    };
    if (opts.fadeIn) setFade(c, 'in', opts.fadeIn);
    if (opts.fadeOut) setFade(c, 'out', opts.fadeOut);
    p.clips.push(c);
    return c;
  }

  function copyClip(c) {
    var x = {};
    for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) x[k] = c[k];
    if (c.versions) x.versions = c.versions.slice();
    if (c.notes) x.notes = c.notes.map(copyNote);
    x.id = uid('c');
    return x;
  }

  // -------------------------------------------------------------- midi ---

  function isMidiTrack(t) { return !!t && t.type === 'midi'; }
  function isMidiClip(c) { return !!c && c.kind === 'midi'; }

  /** An instrument {type, preset, p}: the synth module checks p against its own ranges. */
  function cleanInst(inst) {
    inst = inst && typeof inst === 'object' ? inst : {};
    var out = {
      type: INSTRUMENT_TYPES.indexOf(inst.type) >= 0 ? inst.type : 'synth',
      preset: str(inst.preset, '', 60),
      p: {}
    };
    var p = inst.p && typeof inst.p === 'object' ? inst.p : {};
    Object.keys(p).slice(0, 64).forEach(function (k) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) return;
      var v = p[k];
      if (typeof v === 'number' && isFinite(v)) out.p[k] = v;
      else if (typeof v === 'string' && v.length <= 32) out.p[k] = v;
      else if (typeof v === 'boolean') out.p[k] = v;
    });
    return out;
  }

  function copyNote(n) { return { p: n.p, t: n.t, d: n.d, v: n.v }; }

  function cleanNote(n) {
    if (!n || typeof n !== 'object') return null;
    var pitch = Math.round(num(n.p, -1)), t = num(n.t, NaN), d = num(n.d, NaN);
    if (pitch < 0 || pitch > 127 || !(t >= 0) || !(d > 0)) return null;
    return { p: pitch, t: t, d: Math.max(MIN_NOTE, d), v: clamp(Math.round(num(n.v, 100)), 1, 127) };
  }

  function sortNotes(notes) {
    notes.sort(function (a, b) { return a.t - b.t || a.p - b.p; });
    return notes;
  }

  /** Valid notes only, sorted by time then pitch, at most MAX_NOTES. */
  function cleanNotes(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (n) {
      var x = cleanNote(n);
      if (x && out.length < MAX_NOTES) out.push(x);
    });
    return sortNotes(out);
  }

  /** Source time where the last note ends (0 for none). */
  function notesEnd(notes) {
    var end = 0;
    for (var i = 0; i < notes.length; i++) end = Math.max(end, notes[i].t + notes[i].d);
    return end;
  }

  /** Adds a MIDI clip: opts {trackId, name, start, offset, duration, notes}. */
  function addMidiClip(p, opts) {
    var notes = cleanNotes(opts.notes);
    var offset = Math.max(0, num(opts.offset, 0));
    var c = {
      id: uid('c'),
      trackId: opts.trackId,
      kind: 'midi',
      sourceId: null,
      name: str(opts.name, 'MIDI', 120),
      start: Math.max(0, num(opts.start, 0)),
      offset: offset,
      duration: clamp(num(opts.duration, notesEnd(notes) - offset), MIN_CLIP, MAX_MIDI_CLIP),
      fadeIn: 0,
      fadeOut: 0,
      gainDb: 0,
      disabled: false,
      notes: notes
    };
    p.clips.push(c);
    return c;
  }

  /** Song time of a note in clip c. */
  function noteSongTime(c, n) { return c.start + (n.t - c.offset); }

  /**
   * MIDI notes that start between song times `from` and `to`:
   * [{trackId, clipId, p, v, at, d}] sorted by time. A note is cut at the
   * clip's end and at opts.limit (a loop end). opts.chase also returns
   * notes already sounding at `from`, starting at `from`.
   */
  function midiEvents(p, from, to, opts) {
    opts = opts || {};
    var tracks = {}, out = [], limit = opts.limit == null ? Infinity : opts.limit;
    p.tracks.forEach(function (t) { if (isMidiTrack(t)) tracks[t.id] = t; });
    p.clips.forEach(function (c) {
      if (c.disabled || !isMidiClip(c) || !tracks[c.trackId]) return;
      var ws = c.start, we = Math.min(clipEnd(c), limit);
      if (we <= from || ws >= to) return;
      var shift = c.start - c.offset;
      c.notes.forEach(function (n) {
        var s = n.t + shift, e = Math.min(s + n.d, we);
        if (s < ws - 1e-9 || e - s < MIN_NOTE / 2) return;
        if (s >= from - 1e-9 && s < to) out.push({ trackId: c.trackId, clipId: c.id, p: n.p, v: n.v, at: Math.max(s, from), d: e - Math.max(s, from) });
        else if (opts.chase && s < from && e > from + 0.02) out.push({ trackId: c.trackId, clipId: c.id, p: n.p, v: n.v, at: from, d: e - from });
      });
    });
    out.sort(function (a, b) { return a.at - b.at || a.p - b.p; });
    return out;
  }

  /**
   * Moves the notes of clip c with the given indexes (all when null) toward
   * the song grid of `step` seconds by `strength` (0..1). With opts.ends the
   * note ends snap too (lengths at least one step).
   */
  function quantizeNotes(p, c, indexes, step, strength, opts) {
    if (!(step > 0)) return;
    strength = clamp(num(strength, 1), 0, 1);
    var shift = c.start - c.offset, ends = opts && opts.ends;
    (indexes || c.notes.map(function (n, i) { return i; })).forEach(function (i) {
      var n = c.notes[i];
      if (!n) return;
      var s = n.t + shift, g = p.gridOffset + Math.round((s - p.gridOffset) / step) * step;
      var t = Math.max(0, n.t + (g - s) * strength);
      if (ends) {
        var e = n.t + n.d + shift, ge = p.gridOffset + Math.round((e - p.gridOffset) / step) * step;
        var end = n.t + n.d + (ge - e) * strength;
        n.d = Math.max(strength >= 1 ? step : MIN_NOTE, end - t);
      }
      n.t = t;
    });
    sortNotes(c.notes);
  }

  /**
   * The song's MIDI as plain tracks for a MIDI file: times in quarter notes
   * from the song start, only notes inside their clips. Drum kits use
   * channel 10 (index 9).
   */
  function midiExport(p) {
    var q = quarterSec(p), channel = 0, tracks = [];
    p.tracks.forEach(function (t) {
      if (!isMidiTrack(t)) return;
      var drums = t.inst && t.inst.type === 'drums';
      var notes = midiEvents({ tracks: [t], clips: p.clips }, 0, Infinity).map(function (e) {
        return { pitch: e.p, start: e.at / q, duration: e.d / q, velocity: e.v };
      });
      tracks.push({ name: t.name, channel: drums ? 9 : channel, program: null, notes: notes });
      if (!drums) channel = (channel + 1) % 16 === 9 ? 10 : (channel + 1) % 16;
    });
    return { name: p.name, bpm: p.bpm, sig: p.sig.slice(), tracks: tracks };
  }

  /**
   * Switches a clip to a processed version of its audio (newSourceId),
   * remembering the versions it had so you can switch back.
   */
  function addVersion(c, newSourceId) {
    var list = (c.versions || [c.sourceId]).filter(function (id) { return id !== newSourceId; });
    list.push(newSourceId);
    c.versions = list.slice(-12);
    c.sourceId = newSourceId;
  }

  function clampFades(c) {
    c.fadeIn = clamp(c.fadeIn || 0, 0, c.duration);
    c.fadeOut = clamp(c.fadeOut || 0, 0, c.duration - c.fadeIn);
  }

  function setFade(c, which, len) {
    len = num(len, 0);
    if (which === 'in') c.fadeIn = clamp(len, 0, c.duration - (c.fadeOut || 0));
    else c.fadeOut = clamp(len, 0, c.duration - (c.fadeIn || 0));
  }

  /** Moves the clip's left edge to song time t, revealing or hiding audio. */
  function trimStart(p, c, t) {
    var earliest = Math.max(0, c.start - c.offset);
    t = clamp(t, earliest, clipEnd(c) - MIN_CLIP);
    var d = t - c.start;
    c.offset = Math.max(0, c.offset + d);
    c.duration -= d;
    c.start = t;
    clampFades(c);
  }

  /** Moves the clip's right edge to song time t, up to the end of its audio (MIDI clips can grow). */
  function trimEnd(p, c, t) {
    var src = p.sources[c.sourceId];
    var latest = isMidiClip(c) ? c.start + MAX_MIDI_CLIP : c.start + (src ? src.duration - c.offset : c.duration);
    c.duration = clamp(t, c.start + MIN_CLIP, Math.max(c.start + MIN_CLIP, latest)) - c.start;
    clampFades(c);
  }

  /** Splits a clip at song time t. Returns the new right-hand clip, or null. */
  function splitClip(p, c, t) {
    if (t <= c.start + MIN_CLIP || t >= clipEnd(c) - MIN_CLIP) return null;
    var right = copyClip(c);
    right.start = t;
    right.offset = c.offset + (t - c.start);
    right.duration = clipEnd(c) - t;
    right.fadeIn = 0;
    right.fadeOut = c.fadeOut;
    c.duration = t - c.start;
    c.fadeOut = 0;
    clampFades(c);
    clampFades(right);
    p.clips.splice(p.clips.indexOf(c) + 1, 0, right);
    return right;
  }

  /** Copies clips so the copies start where the group ends, on the same tracks. */
  function duplicateClips(p, clips) {
    if (!clips.length) return [];
    var start = Infinity, end = 0;
    clips.forEach(function (c) { start = Math.min(start, c.start); end = Math.max(end, clipEnd(c)); });
    var copies = clips.map(function (c) {
      var x = copyClip(c);
      x.start = c.start + (end - start);
      return x;
    });
    copies.forEach(function (x) { p.clips.push(x); });
    return copies;
  }

  function deleteClips(p, ids) {
    var gone = {};
    ids.forEach(function (id) { gone[id] = true; });
    p.clips = p.clips.filter(function (c) { return !gone[c.id]; });
  }

  /**
   * The clips in `ids` win over anything they overlap on their own track:
   * a clip they cover is removed, one they partly cover is trimmed back, and
   * one they sit inside is split around them. Clips in `ids` don't affect
   * each other. Call after moving, trimming, duplicating or placing clips.
   */
  function resolveOverlaps(p, ids) {
    var win = {}, eps = 1e-6;
    ids.forEach(function (id) { win[id] = true; });
    p.clips.filter(function (c) { return win[c.id]; }).forEach(function (x) {
      var xs = x.start, xe = clipEnd(x), gone = [];
      p.clips.slice().forEach(function (y) {
        if (win[y.id] || y.trackId !== x.trackId) return;
        var ys = y.start, ye = clipEnd(y);
        if (ye <= xs + eps || ys >= xe - eps) return;
        var keepLeft = xs - ys >= MIN_CLIP, keepRight = ye - xe >= MIN_CLIP;
        if (keepLeft && keepRight) {
          splitClip(p, y, xe);
          trimEnd(p, y, xs);
        } else if (keepLeft) {
          trimEnd(p, y, xs);
        } else if (keepRight) {
          trimStart(p, y, xe);
        } else {
          gone.push(y.id);
        }
      });
      if (gone.length) deleteClips(p, gone);
    });
  }

  // ----------------------------------------------------------- effects ---

  function paramValue(spec, v) {
    if (spec.options) return spec.options.indexOf(v) >= 0 ? v : spec.def;
    return clamp(num(v, spec.def), spec.min, spec.max);
  }

  function fxDefaults(type) {
    var specs = FX_TYPES[type].params, out = {};
    Object.keys(specs).forEach(function (k) { out[k] = specs[k].def; });
    return out;
  }

  function limiterDefaults() {
    var out = { on: true };
    Object.keys(LIMITER).forEach(function (k) { out[k] = LIMITER[k].def; });
    return out;
  }

  /** A new effect of `type` with default settings, added to `list` (a track's or the master's). */
  function addFx(list, type, index) {
    if (!FX_TYPES[type]) throw new Error('Unknown effect: ' + type);
    var fx = { id: uid('f'), type: type, on: true, p: fxDefaults(type) };
    list.splice(index == null ? list.length : clamp(index, 0, list.length), 0, fx);
    return fx;
  }

  function findFx(p, id) {
    var lists = [p.master.fx].concat(p.tracks.map(function (t) { return t.fx; }));
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) if (lists[i][j].id === id) return { list: lists[i], index: j, fx: lists[i][j] };
    }
    return null;
  }

  function setFxParam(fx, key, value) {
    var spec = FX_TYPES[fx.type].params[key];
    if (spec) fx.p[key] = paramValue(spec, value);
  }

  function cleanFxList(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (f) {
      if (!f || !FX_TYPES[f.type] || out.length >= 16) return;
      var id = typeof f.id === 'string' && !seen[f.id] ? f.id : uid('f');
      seen[id] = true;
      var specs = FX_TYPES[f.type].params, params = {};
      Object.keys(specs).forEach(function (k) { params[k] = paramValue(specs[k], f.p ? f.p[k] : undefined); });
      out.push({ id: id, type: f.type, on: f.on !== false, p: params });
    });
    return out;
  }

  function cleanLimiter(l) {
    var out = { on: !l || l.on !== false };
    Object.keys(LIMITER).forEach(function (k) { out[k] = paramValue(LIMITER[k], l ? l[k] : undefined); });
    return out;
  }

  // ------------------------------------------------------- mute / solo ---

  function anySolo(p) {
    return p.tracks.some(function (t) { return t.solo; });
  }

  /** A track sounds when it is not muted and either it is soloed or nothing is. */
  function trackAudible(p, t) {
    return !t.mute && (t.solo || !anySolo(p));
  }

  function trackGain(p, t) { return trackAudible(p, t) ? dbToGain(t.volumeDb) : 0; }

  // ------------------------------------------------------------- fades ---

  /** Gain of a clip's fades at t seconds into the clip (quarter-sine curves). */
  function fadeGain(c, t) {
    var g = 1;
    if (c.fadeIn > 0 && t < c.fadeIn) g *= Math.sin(Math.max(0, t) / c.fadeIn * Math.PI / 2);
    if (c.fadeOut > 0 && t > c.duration - c.fadeOut) {
      g *= Math.sin(Math.max(0, c.duration - t) / c.fadeOut * Math.PI / 2);
    }
    return g;
  }

  /**
   * Gain breakpoints for playing a clip from `from` to `to` seconds into it:
   * [{t, g}], with t in clip time and straight lines between points. Includes
   * the clip gain. Fades are approximated with FADE_STEPS segments each.
   */
  function gainPoints(c, from, to) {
    var k = dbToGain(c.gainDb || 0), ts = [from, to];
    function addRange(a, b) {
      for (var i = 0; i <= FADE_STEPS; i++) {
        var t = a + (b - a) * i / FADE_STEPS;
        if (t > from && t < to) ts.push(t);
      }
    }
    if (c.fadeIn > 0) addRange(0, c.fadeIn);
    if (c.fadeOut > 0) addRange(c.duration - c.fadeOut, c.duration);
    ts.sort(function (a, b) { return a - b; });
    var out = [];
    ts.forEach(function (t) {
      if (out.length && t - out[out.length - 1].t < 1e-6) return;
      out.push({ t: t, g: k * fadeGain(c, t) });
    });
    return out;
  }

  // ---------------------------------------------------------- playback ---

  /** The clip pieces that sound between song times `from` and `to`. */
  function planSegments(p, from, to) {
    var tracks = {}, out = [];
    p.tracks.forEach(function (t) { tracks[t.id] = t; });
    p.clips.forEach(function (c) {
      if (c.disabled || !tracks[c.trackId] || !p.sources[c.sourceId]) return;
      var s = Math.max(from, c.start), e = Math.min(to, clipEnd(c));
      if (e - s < 1e-4) return;
      out.push({ clip: c, at: s, inClip: s - c.start, offset: c.offset + (s - c.start), duration: e - s });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  /**
   * The transport runs from song position anchor.pos, starting at audio-clock
   * time anchor.ctxTime. With an active loop it plays on to loop.end and then
   * repeats loop.start to loop.end. A loop only applies when playback starts
   * before its end.
   */
  function loopActive(loop, pos) {
    return !!(loop && loop.on && loop.end - loop.start >= MIN_LOOP && pos < loop.end);
  }

  function positionAt(anchor, loop, ctxTime) {
    var el = Math.max(0, ctxTime - anchor.ctxTime);
    if (!loopActive(loop, anchor.pos)) return anchor.pos + el;
    var first = loop.end - anchor.pos;
    if (el < first) return anchor.pos + el;
    var len = loop.end - loop.start;
    var k = Math.floor((el - first) / len + 1e-9);
    return loop.start + Math.max(0, el - first - k * len);
  }

  /**
   * Splits audio-clock time [a, b) into pieces in which the song position
   * runs straight: [{ctxStart, ctxEnd, pos}] where pos is the song position
   * at ctxStart. Used to schedule the metronome across loop jumps.
   */
  function transportPieces(anchor, loop, a, b) {
    a = Math.max(a, anchor.ctxTime);
    if (b <= a) return [];
    if (!loopActive(loop, anchor.pos)) {
      return [{ ctxStart: a, ctxEnd: b, pos: anchor.pos + (a - anchor.ctxTime) }];
    }
    var len = loop.end - loop.start, first = loop.end - anchor.pos, out = [], t = a;
    while (t < b - 1e-9) {
      var el = t - anchor.ctxTime, pos, boundary;
      if (el < first) {
        pos = anchor.pos + el;
        boundary = anchor.ctxTime + first;
      } else {
        var k = Math.floor((el - first) / len + 1e-9);
        var iterStart = anchor.ctxTime + first + k * len;
        pos = loop.start + Math.max(0, t - iterStart);
        boundary = iterStart + len;
      }
      var end = Math.min(b, boundary);
      if (end <= t) end = Math.min(b, t + len); // guard against rounding stalls
      out.push({ ctxStart: t, ctxEnd: end, pos: pos });
      t = end;
    }
    return out;
  }

  // ----------------------------------------------------------- history ---

  /** Undo history of song snapshots (JSON strings). */
  function History(limit) {
    this.limit = limit || 100;
    this.past = [];
    this.future = [];
  }
  History.prototype.record = function (snapshot) {
    this.past.push(snapshot);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  };
  History.prototype.undo = function (current) {
    if (!this.past.length) return null;
    this.future.push(current);
    return this.past.pop();
  };
  History.prototype.redo = function (current) {
    if (!this.future.length) return null;
    this.past.push(current);
    return this.future.pop();
  };
  History.prototype.clear = function () { this.past = []; this.future = []; };

  // ----------------------------------------------------- serialization ---

  function serialize(p) { return JSON.stringify(p); }

  /** Reads a saved song, repairing anything out of range. Throws if it isn't one. */
  function parseProject(input) {
    var d = typeof input === 'string' ? JSON.parse(input) : input;
    if (!d || d.app !== APP_ID || !Array.isArray(d.tracks) || !Array.isArray(d.clips)) {
      throw new Error('This file is not a Stem to Stream Studio song.');
    }
    var sig = Array.isArray(d.sig) ? d.sig : [4, 4];
    var p = createProject({
      id: str(d.id, undefined, 64),
      name: str(d.name, 'Untitled song', 120),
      bpm: clamp(num(d.bpm, 120), 20, 300),
      sig: [clamp(Math.round(num(sig[0], 4)), 1, 32), DENOMINATORS.indexOf(sig[1]) >= 0 ? sig[1] : 4],
      gridOffset: Math.max(0, num(d.gridOffset, 0)),
      snap: SNAPS.indexOf(d.snap) >= 0 ? d.snap : '1/4'
    });
    p.masterDb = clamp(num(d.masterDb, 0), FLOOR_DB, MAX_DB);
    p.master = { fx: cleanFxList(d.master && d.master.fx), limiter: cleanLimiter(d.master && d.master.limiter) };
    p.created = num(d.created, p.created);
    p.updated = num(d.updated, p.updated);
    if (d.loop) {
      var ls = Math.max(0, num(d.loop.start, 0)), le = Math.max(0, num(d.loop.end, 0));
      p.loop = { on: !!d.loop.on && le - ls >= MIN_LOOP, start: Math.min(ls, le), end: Math.max(ls, le) };
    }
    var sources = d.sources && typeof d.sources === 'object' ? d.sources : {};
    Object.keys(sources).forEach(function (key) {
      var s = sources[key];
      if (!s || typeof s.id !== 'string' || s.id !== key) return;
      var duration = num(s.duration, 0);
      if (!(duration > 0)) return;
      addSource(p, {
        id: s.id,
        name: s.name,
        type: typeof s.type === 'string' ? s.type.slice(0, 80) : '',
        duration: duration,
        sampleRate: clamp(Math.round(num(s.sampleRate, 48000)), 3000, 768000),
        channels: clamp(Math.round(num(s.channels, 2)), 1, 32),
        demo: typeof s.demo === 'string' ? s.demo.slice(0, 20) : undefined
      });
    });
    var seen = {};
    d.tracks.forEach(function (t) {
      if (!t || typeof t.id !== 'string' || seen[t.id]) return;
      seen[t.id] = true;
      var track = {
        id: t.id,
        name: str(t.name, 'Track', 60),
        color: clamp(Math.round(num(t.color, 0)), 0, COLORS - 1),
        volumeDb: clamp(num(t.volumeDb, 0), FLOOR_DB, MAX_DB),
        pan: clamp(num(t.pan, 0), -1, 1),
        mute: !!t.mute,
        solo: !!t.solo,
        fx: cleanFxList(t.fx)
      };
      if (t.type === 'midi') {
        track.type = 'midi';
        track.inst = cleanInst(t.inst);
      }
      p.tracks.push(track);
    });
    var midiTracks = {};
    p.tracks.forEach(function (t) { if (isMidiTrack(t)) midiTracks[t.id] = true; });
    var clipSeen = {};
    d.clips.forEach(function (c) {
      if (!c || typeof c.id !== 'string' || clipSeen[c.id]) return;
      if (c.kind === 'midi') {
        // MIDI clips only live on MIDI tracks; audio clips only on audio tracks.
        if (!midiTracks[c.trackId]) return;
        clipSeen[c.id] = true;
        var m = addMidiClip(p, {
          trackId: c.trackId, name: c.name, start: c.start, offset: c.offset,
          duration: num(c.duration, MIN_CLIP), notes: c.notes
        });
        m.id = c.id;
        m.gainDb = clamp(num(c.gainDb, 0), FLOOR_DB, 24);
        m.disabled = !!c.disabled;
        return;
      }
      var src = p.sources[c.sourceId];
      if (!src || !seen[c.trackId] || midiTracks[c.trackId]) return;
      clipSeen[c.id] = true;
      var offset = clamp(num(c.offset, 0), 0, Math.max(0, src.duration - MIN_CLIP));
      var clip = {
        id: c.id,
        trackId: c.trackId,
        sourceId: c.sourceId,
        name: str(c.name, src.name, 120),
        start: Math.max(0, num(c.start, 0)),
        offset: offset,
        duration: clamp(num(c.duration, src.duration - offset), MIN_CLIP, Math.max(MIN_CLIP, src.duration - offset)),
        fadeIn: Math.max(0, num(c.fadeIn, 0)),
        fadeOut: Math.max(0, num(c.fadeOut, 0)),
        gainDb: clamp(num(c.gainDb, 0), FLOOR_DB, 24),
        disabled: !!c.disabled
      };
      if (Array.isArray(c.versions)) {
        // Versions must be real sources of the same length; the active one is always listed.
        var vs = [];
        c.versions.forEach(function (id) {
          var s = typeof id === 'string' && p.sources[id];
          if (s && vs.indexOf(id) < 0 && Math.abs(s.duration - src.duration) < 0.01) vs.push(id);
        });
        if (vs.indexOf(clip.sourceId) < 0) vs.push(clip.sourceId);
        if (vs.length > 1) clip.versions = vs.slice(-12);
      }
      clampFades(clip);
      p.clips.push(clip);
    });
    return p;
  }

  return {
    APP_ID: APP_ID,
    MIN_CLIP: MIN_CLIP,
    MIN_LOOP: MIN_LOOP,
    FLOOR_DB: FLOOR_DB,
    MAX_DB: MAX_DB,
    COLORS: COLORS,
    SNAPS: SNAPS,
    DENOMINATORS: DENOMINATORS,
    INSTRUMENT_TYPES: INSTRUMENT_TYPES,
    MIN_NOTE: MIN_NOTE,
    FX_TYPES: FX_TYPES,
    LIMITER: LIMITER,
    uid: uid,
    clamp: clamp,
    dbToGain: dbToGain,
    gainToDb: gainToDb,
    quarterSec: quarterSec,
    beatSec: beatSec,
    barSec: barSec,
    snapStep: snapStep,
    snapTime: snapTime,
    toBBT: toBBT,
    barToTime: barToTime,
    fmtBBT: fmtBBT,
    fmtClock: fmtClock,
    createProject: createProject,
    getTrack: getTrack,
    getClip: getClip,
    trackIndex: trackIndex,
    clipEnd: clipEnd,
    songEnd: songEnd,
    addTrack: addTrack,
    removeTrack: removeTrack,
    moveTrack: moveTrack,
    addSource: addSource,
    addClip: addClip,
    setFade: setFade,
    clampFades: clampFades,
    trimStart: trimStart,
    trimEnd: trimEnd,
    splitClip: splitClip,
    duplicateClips: duplicateClips,
    deleteClips: deleteClips,
    resolveOverlaps: resolveOverlaps,
    addVersion: addVersion,
    isMidiTrack: isMidiTrack,
    isMidiClip: isMidiClip,
    cleanInst: cleanInst,
    cleanNotes: cleanNotes,
    sortNotes: sortNotes,
    notesEnd: notesEnd,
    addMidiClip: addMidiClip,
    noteSongTime: noteSongTime,
    midiEvents: midiEvents,
    quantizeNotes: quantizeNotes,
    midiExport: midiExport,
    fxDefaults: fxDefaults,
    limiterDefaults: limiterDefaults,
    addFx: addFx,
    findFx: findFx,
    setFxParam: setFxParam,
    anySolo: anySolo,
    trackAudible: trackAudible,
    trackGain: trackGain,
    fadeGain: fadeGain,
    gainPoints: gainPoints,
    planSegments: planSegments,
    loopActive: loopActive,
    positionAt: positionAt,
    transportPieces: transportPieces,
    History: History,
    serialize: serialize,
    parseProject: parseProject
  };
});
;

// ---- js/studio/wav.js ----
/*
 * Stem to Stream Studio: WAV writer.
 *
 *   encodeWav([left, right], 48000, { bits: 24 })  ->  ArrayBuffer
 *
 * bits 16 and 24 write PCM with TPDF dither (one LSB, from a fixed seed so
 * the same mix always gives the same file); bits 32 writes IEEE float.
 * Samples beyond full scale are clipped in PCM and kept in float.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.wav = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function encodeWav(channels, sampleRate, opts) {
    var bits = (opts && opts.bits) || 24;
    if ([16, 24, 32].indexOf(bits) < 0) throw new Error('Unsupported bit depth: ' + bits + '.');
    var nch = channels.length;
    if (!nch) throw new Error('Nothing to write: the audio has no channels.');
    var frames = channels[0].length, isFloat = bits === 32, bytes = bits / 8;
    var block = nch * bytes, dataSize = frames * block;
    // Float files carry the extended fmt chunk and a fact chunk, as the spec asks.
    var header = isFloat ? 58 : 44;
    if (header + dataSize > 0xFFFFFFFF) throw new Error('The export is longer than a WAV file can hold (4 GB).');

    var buf = new ArrayBuffer(header + dataSize), v = new DataView(buf);
    writeAscii(v, 0, 'RIFF');
    v.setUint32(4, header - 8 + dataSize, true);
    writeAscii(v, 8, 'WAVE');
    writeAscii(v, 12, 'fmt ');
    v.setUint32(16, isFloat ? 18 : 16, true);
    v.setUint16(20, isFloat ? 3 : 1, true);
    v.setUint16(22, nch, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * block, true);
    v.setUint16(32, block, true);
    v.setUint16(34, bits, true);
    var p = 36;
    if (isFloat) {
      v.setUint16(36, 0, true); // cbSize
      writeAscii(v, 38, 'fact');
      v.setUint32(42, 4, true);
      v.setUint32(46, frames, true);
      p = 50;
    }
    writeAscii(v, p, 'data');
    v.setUint32(p + 4, dataSize, true);

    var i, c, x, o = header;
    if (isFloat) {
      for (i = 0; i < frames; i++) {
        for (c = 0; c < nch; c++, o += 4) v.setFloat32(o, channels[c][i], true);
      }
      return buf;
    }

    var scale = bits === 16 ? 32768 : 8388608, hi = scale - 1, lo = -scale;
    var seed = 0x9e3779b9;
    function rand() { // xorshift32 in [0, 1)
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    }
    if (bits === 16) {
      var pcm16 = new Int16Array(buf, header, frames * nch);
      for (i = 0, o = 0; i < frames; i++) {
        for (c = 0; c < nch; c++) {
          x = Math.round(channels[c][i] * scale + rand() - rand());
          pcm16[o++] = x > hi ? hi : x < lo ? lo : x;
        }
      }
      return buf;
    }
    var u8 = new Uint8Array(buf, header);
    for (i = 0, o = 0; i < frames; i++) {
      for (c = 0; c < nch; c++) {
        x = Math.round(channels[c][i] * scale + rand() - rand());
        x = x > hi ? hi : x < lo ? lo : x;
        u8[o++] = x & 0xff;
        u8[o++] = (x >> 8) & 0xff;
        u8[o++] = (x >> 16) & 0xff;
      }
    }
    return buf;
  }

  /** Highest absolute sample value across channels. */
  function peak(channels) {
    var m = 0;
    for (var c = 0; c < channels.length; c++) {
      var d = channels[c];
      for (var i = 0; i < d.length; i++) {
        var a = d[i] < 0 ? -d[i] : d[i];
        if (a > m) m = a;
      }
    }
    return m;
  }

  return { encodeWav: encodeWav, peak: peak };
});
;

// ---- js/studio/zip.js ----
/*
 * Stem to Stream Studio: a small ZIP writer and reader.
 *
 * Writes "stored" (uncompressed) entries: audio barely compresses, and this
 * keeps exports fast. Each added file is handed to a Blob straight away, so a
 * stems export doesn't hold every WAV in memory at once.
 * Reads stored entries, and deflated ones where the browser has
 * DecompressionStream, so a song file re-zipped by another tool still opens.
 * No ZIP64: one archive must stay under 4 GB.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.zip = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function toBytes(data) {
    if (typeof data === 'string') return utf8(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('Unsupported zip entry data.');
  }

  function dosDateTime(date) {
    var d = date || new Date();
    var year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function ZipWriter() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  /** Adds one file. `data` is a string, ArrayBuffer or typed array. */
  ZipWriter.prototype.add = function (name, data, date) {
    var bytes = toBytes(data), nameBytes = utf8(name), dt = dosDateTime(date);
    if (this.offset + 30 + nameBytes.length + bytes.length > 0xFFFFFFFF) {
      throw new Error('The archive would be larger than 4 GB. Export fewer tracks at a time.');
    }
    var head = new Uint8Array(30 + nameBytes.length), v = new DataView(head.buffer), crc = crc32(bytes);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);       // version needed
    v.setUint16(6, 0x0800, true);   // UTF-8 names
    v.setUint16(8, 0, true);        // stored
    v.setUint16(10, dt.time, true);
    v.setUint16(12, dt.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true);
    v.setUint32(22, bytes.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    head.set(nameBytes, 30);
    this.parts.push(head, typeof Blob !== 'undefined' ? new Blob([bytes]) : bytes);
    this.entries.push({ name: nameBytes, crc: crc, size: bytes.length, offset: this.offset, dt: dt });
    this.offset += head.length + bytes.length;
  };

  /** Finishes the archive and returns it as a Blob. */
  ZipWriter.prototype.finish = function () {
    var cdStart = this.offset, cdSize = 0, self = this;
    this.entries.forEach(function (e) {
      var rec = new Uint8Array(46 + e.name.length), v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);     // version made by
      v.setUint16(6, 20, true);     // version needed
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.dt.time, true);
      v.setUint16(14, e.dt.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      self.parts.push(rec);
      cdSize += rec.length;
    });
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.entries.length, true);
    ev.setUint16(10, this.entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    this.parts.push(end);
    return new Blob(this.parts, { type: 'application/zip' });
  };

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('This song file is compressed in a way this browser cannot open. Open it in a current Chrome, Edge, Firefox or Safari.'));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  /** Reads a ZIP archive. Resolves [{name, data: Uint8Array}]. */
  function readZip(buffer) {
    return Promise.resolve().then(function () {
      var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), eocd = -1;
      for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
        if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('This file is not a ZIP archive.');
      var count = v.getUint16(eocd + 10, true), cd = v.getUint32(eocd + 16, true);
      if (cd === 0xFFFFFFFF || count === 0xFFFF) throw new Error('Archives larger than 4 GB are not supported.');
      var decoder = new TextDecoder(), jobs = [], p = cd;
      for (var n = 0; n < count; n++) {
        if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP archive is damaged.');
        var method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
        var compSize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
        var nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
        var local = v.getUint32(p + 42, true);
        var name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (name.slice(-1) === '/') continue; // folder entry
        if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new Error('The ZIP archive is damaged.');
        var dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        var raw = bytes.subarray(dataStart, dataStart + compSize);
        if (raw.length !== compSize) throw new Error('The ZIP archive is cut short.');
        jobs.push(readEntry(name, method, raw, size, crc));
      }
      return Promise.all(jobs);
    });
  }

  function readEntry(name, method, raw, size, crc) {
    var data;
    if (method === 0) data = Promise.resolve(raw);
    else if (method === 8) data = inflateRaw(raw);
    else return Promise.reject(new Error('"' + name + '" uses a ZIP compression method this app does not read.'));
    return data.then(function (out) {
      if (out.length !== size || crc32(out) !== crc) throw new Error('"' + name + '" in the archive is damaged.');
      return { name: name, data: out };
    });
  }

  return { crc32: crc32, ZipWriter: ZipWriter, readZip: readZip };
});
;

// ---- js/studio/midifile.js ----
/*
 * Stem to Stream Studio: Standard MIDI File reader and writer.
 *
 *   parse(bytes)              ->  { format, ppq, tracks, tempos, timeSigs, duration }
 *   write(song, { ppq: 480 }) ->  Uint8Array (a format 1 file)
 *
 * Every time is in beats (quarter notes): at 480 PPQ, tick 720 is beat 1.5.
 * parse() keeps the exact tick / ppq fraction. tempoAt(), beatsToSeconds()
 * and secondsToBeats() turn beats into seconds along the tempo map.
 *
 * Reading handles formats 0, 1 and 2, running status, note-on velocity 0 as
 * note-off, and repeated notes of one pitch, paired first on, first off.
 * Notes are split by channel: each (track, channel) pair with notes becomes
 * one track. A note never released ends at its track's End of Track and lasts
 * at least 1/16 beat. Format 2 patterns are laid side by side, each from beat 0.
 *
 * SMPTE files (negative division) count ticks in real time, not beats. Their
 * ticks become seconds, then beats at the file's first tempo (120 BPM if it
 * has none). Only that tempo is kept, so beatsToSeconds() still gives the
 * file's real times.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.midifile = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NOT_MIDI = 'This is not a MIDI file.';
  var CUT_SHORT = 'The MIDI file is cut short.';
  var DAMAGED = 'The MIDI file is damaged.';

  /** The 128 General MIDI program names, indexed by program number 0..127. */
  var GM_PROGRAMS = (
    'Acoustic Grand Piano|Bright Acoustic Piano|Electric Grand Piano|Honky-tonk Piano|' +
    'Electric Piano 1|Electric Piano 2|Harpsichord|Clavi|' +
    'Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer|' +
    'Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion|' +
    'Acoustic Guitar (nylon)|Acoustic Guitar (steel)|Electric Guitar (jazz)|Electric Guitar (clean)|' +
    'Electric Guitar (muted)|Overdriven Guitar|Distortion Guitar|Guitar Harmonics|' +
    'Acoustic Bass|Electric Bass (finger)|Electric Bass (pick)|Fretless Bass|' +
    'Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2|' +
    'Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani|' +
    'String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|' +
    'Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit|' +
    'Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2|' +
    'Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet|' +
    'Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina|' +
    'Lead 1 (square)|Lead 2 (sawtooth)|Lead 3 (calliope)|Lead 4 (chiff)|' +
    'Lead 5 (charang)|Lead 6 (voice)|Lead 7 (fifths)|Lead 8 (bass + lead)|' +
    'Pad 1 (new age)|Pad 2 (warm)|Pad 3 (polysynth)|Pad 4 (choir)|' +
    'Pad 5 (bowed)|Pad 6 (metallic)|Pad 7 (halo)|Pad 8 (sweep)|' +
    'FX 1 (rain)|FX 2 (soundtrack)|FX 3 (crystal)|FX 4 (atmosphere)|' +
    'FX 5 (brightness)|FX 6 (goblins)|FX 7 (echoes)|FX 8 (sci-fi)|' +
    'Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai|' +
    'Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal|' +
    'Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot'
  ).split('|');

  /** General MIDI drum names for notes 35..81 (channel 10). */
  var GM_DRUMS = (function () {
    var names = (
      'Acoustic Bass Drum|Bass Drum 1|Side Stick|Acoustic Snare|Hand Clap|Electric Snare|' +
      'Low Floor Tom|Closed Hi-Hat|High Floor Tom|Pedal Hi-Hat|Low Tom|Open Hi-Hat|' +
      'Low-Mid Tom|Hi-Mid Tom|Crash Cymbal 1|High Tom|Ride Cymbal 1|Chinese Cymbal|' +
      'Ride Bell|Tambourine|Splash Cymbal|Cowbell|Crash Cymbal 2|Vibraslap|Ride Cymbal 2|' +
      'Hi Bongo|Low Bongo|Mute Hi Conga|Open Hi Conga|Low Conga|High Timbale|Low Timbale|' +
      'High Agogo|Low Agogo|Cabasa|Maracas|Short Whistle|Long Whistle|Short Guiro|Long Guiro|' +
      'Claves|Hi Wood Block|Low Wood Block|Mute Cuica|Open Cuica|Mute Triangle|Open Triangle'
    ).split('|');
    var map = {};
    for (var i = 0; i < names.length; i++) map[35 + i] = names[i];
    return map;
  })();

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error(NOT_MIDI);
  }

  function ascii(bytes, p, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(bytes[p + i]);
    return s;
  }

  function u16(b, p) { return b[p] * 256 + b[p + 1]; }
  function u32(b, p) { return b[p] * 16777216 + b[p + 1] * 65536 + b[p + 2] * 256 + b[p + 3]; }

  /** Text events are UTF-8 from most current tools, Latin-1 from older ones. */
  function decodeText(bytes) {
    var s = null;
    if (typeof TextDecoder !== 'undefined') {
      try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { s = null; }
    }
    if (s === null) {
      s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    }
    return s.replace(/\u0000/g, '').trim();
  }

  function encodeText(text) {
    var out = [], i;
    if (typeof TextEncoder !== 'undefined') {
      var b = new TextEncoder().encode(String(text));
      for (i = 0; i < b.length; i++) out.push(b[i]);
    } else {
      for (i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xff);
    }
    return out;
  }

  function byTick(a, b) { return a.tick - b.tick || a.seq - b.seq; }

  /** Sorts by tick and keeps the last entry at each tick. */
  function collapse(list) {
    list.sort(byTick);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (out.length && out[out.length - 1].tick === list[i].tick) out[out.length - 1] = list[i];
      else out.push(list[i]);
    }
    return out;
  }

  /**
   * Reads one MTrk body (bytes[p..end)). Tempos, time signatures and program
   * changes go into the song-wide lists; returns the track's name, notes (in
   * ticks, off = -1 while never released) and its End of Track tick.
   */
  function readTrack(bytes, p, end, index, song) {
    var tick = 0, status = 0, name = '', open = {}, notes = [];
    var b, type, len, ch, d1, d2, key, note, queue;

    function vlq() {
      var value = 0, c, count = 0;
      do {
        if (p >= end) throw new Error(CUT_SHORT);
        c = bytes[p++];
        value = value * 128 + (c & 0x7f);
      } while ((c & 0x80) && ++count < 4); // 4 bytes at most, so a bad file can't run away
      return value;
    }

    while (p < end) {
      tick += vlq();
      if (p >= end) throw new Error(CUT_SHORT);
      b = bytes[p];
      if (b & 0x80) {
        p++;
        if (b < 0xf0) status = b;
      } else if (status) {
        b = status; // running status: this byte is already the first data byte
      } else {
        throw new Error(DAMAGED);
      }

      if (b < 0xf0) {
        type = b & 0xf0;
        ch = b & 0x0f;
        len = type === 0xc0 || type === 0xd0 ? 1 : 2;
        if (p + len > end) throw new Error(CUT_SHORT);
        d1 = bytes[p] & 0x7f;
        d2 = len === 2 ? bytes[p + 1] & 0x7f : 0;
        p += len;
        key = ch * 128 + d1;
        if (type === 0x90 && d2) {
          note = { pitch: d1, on: tick, off: -1, velocity: d2, channel: ch };
          notes.push(note);
          (open[key] || (open[key] = [])).push(note);
        } else if (type === 0x80 || type === 0x90) {
          queue = open[key];
          if (queue && queue.length) queue.shift().off = tick; // first on, first off
        } else if (type === 0xc0) {
          song.programs.push({ track: index, channel: ch, tick: tick, program: d1 });
        }
      } else if (b === 0xff) {
        if (p >= end) throw new Error(CUT_SHORT);
        type = bytes[p++];
        len = vlq();
        if (p + len > end) throw new Error(CUT_SHORT);
        if (type === 0x2f) break; // End of Track
        if (type === 0x03 && !name) {
          name = decodeText(bytes.subarray(p, p + len));
        } else if (type === 0x51 && len >= 3) {
          var us = bytes[p] * 65536 + bytes[p + 1] * 256 + bytes[p + 2];
          if (us) song.tempos.push({ tick: tick, bpm: 60000000 / us, seq: song.seq++ });
        } else if (type === 0x58 && len >= 2 && bytes[p] && bytes[p + 1] < 8) {
          song.timeSigs.push({ tick: tick, num: bytes[p], den: Math.pow(2, bytes[p + 1]), seq: song.seq++ });
        }
        p += len;
      } else if (b === 0xf0 || b === 0xf7) {
        len = vlq(); // sysex, or an escaped packet
        if (p + len > end) throw new Error(CUT_SHORT);
        p += len;
      } else {
        // F1..FE have no place in a file; skip their usual data bytes.
        p += b === 0xf2 ? 2 : b === 0xf1 || b === 0xf3 ? 1 : 0;
      }
    }
    return { name: name, notes: notes, end: tick };
  }

  /**
   * The last program change on `channel` at or before `tick`: from the same
   * track first, then (except in format 2) from any other track.
   */
  function programFor(programs, index, channel, tick, format) {
    var own = null, other = null;
    for (var i = 0; i < programs.length; i++) {
      var pc = programs[i];
      if (pc.channel !== channel || pc.tick > tick) continue;
      if (pc.track === index) own = pc;
      else if (format !== 2 && (!other || pc.tick >= other.tick)) other = pc;
    }
    return own ? own.program : other ? other.program : null;
  }

  /**
   * Reads a Standard MIDI File from a Uint8Array or ArrayBuffer. Throws an
   * Error with a plain message when the file isn't MIDI or is cut short.
   * Track names get " (ch N)" (N = 1..16) only when one file track holds
   * several channels; a track without a name is "Track N", counting the file
   * tracks that have notes. For SMPTE files `ppq` is the derived ticks per beat.
   */
  function parse(data) {
    var bytes = toBytes(data);
    if (bytes.length < 8 || ascii(bytes, 0, 4) !== 'MThd') throw new Error(NOT_MIDI);
    var headLen = u32(bytes, 4);
    if (headLen < 6) throw new Error(NOT_MIDI);
    if (8 + headLen > bytes.length) throw new Error(CUT_SHORT);
    var format = u16(bytes, 8), count = u16(bytes, 10), division = u16(bytes, 12);
    if (format > 2) throw new Error('This MIDI file uses an unknown format (' + format + ').');

    var song = { programs: [], tempos: [], timeSigs: [], seq: 0 };
    var raw = [], p = 8 + headLen, len;
    while (raw.length < count && p < bytes.length) {
      if (p + 8 > bytes.length) throw new Error(CUT_SHORT);
      len = u32(bytes, p + 4);
      if (p + 8 + len > bytes.length) throw new Error(CUT_SHORT);
      // Unknown chunk types are allowed by the spec and skipped.
      if (ascii(bytes, p, 4) === 'MTrk') raw.push(readTrack(bytes, p + 8, p + 8 + len, raw.length, song));
      p += 8 + len;
    }

    var tempos = collapse(song.tempos), sigs = collapse(song.timeSigs), ppq;
    if (division & 0x8000) {
      // SMPTE: the high byte is -frames per second (-29 means 29.97 drop frame).
      var fps = 256 - (division >> 8), ticksPerSecond = (fps === 29 ? 29.97 : fps) * (division & 0xff);
      if (!(ticksPerSecond > 0)) throw new Error(DAMAGED);
      var firstBpm = tempos.length ? tempos[0].bpm : 120;
      ppq = ticksPerSecond * 60 / firstBpm;
      tempos = [{ tick: 0, bpm: firstBpm }];
    } else {
      ppq = division;
      if (!ppq) throw new Error(DAMAGED);
    }
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
    if (!sigs.length || sigs[0].tick > 0) sigs.unshift({ tick: 0, num: 4, den: 4 });

    var tracks = [], ordinal = 0, duration = 0, t, i;
    for (t = 0; t < raw.length; t++) {
      var src = raw[t], byChannel = [], used = [];
      for (i = 0; i < src.notes.length; i++) {
        var ch = src.notes[i].channel;
        if (!byChannel[ch]) { byChannel[ch] = []; used.push(ch); }
        byChannel[ch].push(src.notes[i]);
      }
      if (!used.length) continue;
      ordinal++;
      used.sort(function (a, b) { return a - b; });
      var base = src.name || 'Track ' + ordinal;
      for (var u = 0; u < used.length; u++) {
        var list = byChannel[used[u]], notes = [];
        for (i = 0; i < list.length; i++) {
          var n = list[i], start = n.on / ppq;
          var length = n.off >= 0 ? (n.off - n.on) / ppq : Math.max((src.end - n.on) / ppq, 1 / 16);
          if (start + length > duration) duration = start + length;
          notes.push({ pitch: n.pitch, start: start, duration: length, velocity: n.velocity, channel: n.channel });
        }
        tracks.push({
          name: used.length > 1 ? base + ' (ch ' + (used[u] + 1) + ')' : base,
          notes: notes,
          program: programFor(song.programs, t, used[u], list[0].on, format),
          channel: used[u],
          isDrums: used[u] === 9
        });
      }
    }

    return {
      format: format,
      ppq: ppq,
      tracks: tracks,
      tempos: tempos.map(function (e) { return { tick: e.tick, bpm: e.bpm, beat: e.tick / ppq }; }),
      timeSigs: sigs.map(function (e) { return { tick: e.tick, num: e.num, den: e.den, beat: e.tick / ppq }; }),
      duration: duration
    };
  }

  function tempoList(tempos) {
    return tempos && tempos.length ? tempos : [{ tick: 0, bpm: 120, beat: 0 }];
  }

  /** BPM in effect at `beat`. `tempos` is a sorted map like parse() returns. */
  function tempoAt(tempos, beat) {
    var list = tempoList(tempos), bpm = list[0].bpm;
    for (var i = 1; i < list.length && list[i].beat <= beat; i++) bpm = list[i].bpm;
    return bpm;
  }

  /** Seconds from beat 0 to `beat`, following the tempo map. */
  function beatsToSeconds(tempos, beat) {
    var list = tempoList(tempos), sec = 0, at = 0, bpm = list[0].bpm;
    for (var i = 1; i < list.length && list[i].beat < beat; i++) {
      sec += (list[i].beat - at) * 60 / bpm;
      at = list[i].beat;
      bpm = list[i].bpm;
    }
    return sec + (beat - at) * 60 / bpm;
  }

  /** The beat reached after `sec` seconds; the inverse of beatsToSeconds. */
  function secondsToBeats(tempos, sec) {
    var list = tempoList(tempos), t = 0, at = 0, bpm = list[0].bpm;
    for (var i = 1; i < list.length; i++) {
      var span = (list[i].beat - at) * 60 / bpm;
      if (t + span > sec) break;
      t += span;
      at = list[i].beat;
      bpm = list[i].bpm;
    }
    return at + (sec - t) * bpm / 60;
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function pushVlq(out, n) {
    if (n > 0x0fffffff) throw new Error('The MIDI clip is too long to write.');
    var groups = [n & 0x7f];
    while (n > 127) {
      n = Math.floor(n / 128);
      groups.unshift((n & 0x7f) | 0x80);
    }
    for (var i = 0; i < groups.length; i++) out.push(groups[i]);
  }

  function meta(type, data) {
    var out = [0xff, type];
    pushVlq(out, data.length);
    return out.concat(data);
  }

  function chunk(id, body) {
    var n = body.length;
    return [id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3),
      (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].concat(body);
  }

  /**
   * One MTrk from {tick, order, seq, data} events. Sorted by tick, then order
   * (names and program changes, then note-offs, then note-ons), so a note
   * repeated at the same pitch is never cut short by its own previous note-off.
   */
  function trackChunk(events) {
    events.sort(function (a, b) { return a.tick - b.tick || a.order - b.order || a.seq - b.seq; });
    var out = [], last = 0;
    for (var i = 0; i < events.length; i++) {
      pushVlq(out, events[i].tick - last);
      last = events[i].tick;
      for (var j = 0; j < events[i].data.length; j++) out.push(events[i].data[j]);
    }
    out.push(0, 0xff, 0x2f, 0);
    return chunk('MTrk', out);
  }

  /**
   * Writes a format 1 file and returns it as a Uint8Array.
   * song: { name?, bpm, sig: [num, den], tracks: [{ name, channel 0-15,
   * program 0-127 or null, notes: [{ pitch, start, duration, velocity }] }] },
   * times in beats. opts: { ppq: 480 }. Track 0 holds the tempo and meter.
   */
  function write(song, opts) {
    var ppq = Math.round((opts && opts.ppq) || 480);
    if (!(ppq >= 1 && ppq <= 32767)) throw new Error('PPQ must be between 1 and 32767.');
    song = song || {};
    var tracks = song.tracks || [];
    if (tracks.length > 65534) throw new Error('A MIDI file holds at most 65534 tracks.');

    var bpm = song.bpm > 0 ? song.bpm : 120;
    var us = clamp(Math.round(60000000 / bpm), 1, 0xffffff);
    var sig = song.sig || [4, 4];
    var num = clamp(Math.round(sig[0]) || 4, 1, 255);
    var dd = clamp(Math.round(Math.log(sig[1] > 0 ? sig[1] : 4) / Math.LN2), 0, 7); // den = 2^dd

    var conductor = [], seq = 0;
    if (song.name) conductor.push({ tick: 0, order: 0, seq: seq++, data: meta(0x03, encodeText(song.name)) });
    conductor.push({ tick: 0, order: 0, seq: seq++, data: meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]) });
    conductor.push({ tick: 0, order: 0, seq: seq++, data: meta(0x58, [num, dd, 24, 8]) });
    var chunks = [trackChunk(conductor)];

    for (var t = 0; t < tracks.length; t++) {
      var track = tracks[t], ch = clamp(Math.round(track.channel) || 0, 0, 15), events = [];
      seq = 0;
      if (track.name) events.push({ tick: 0, order: 0, seq: seq++, data: meta(0x03, encodeText(track.name)) });
      if (track.program !== null && track.program !== undefined) {
        events.push({ tick: 0, order: 1, seq: seq++, data: [0xc0 | ch, clamp(Math.round(track.program) || 0, 0, 127)] });
      }
      var notes = track.notes || [];
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (!isFinite(n.pitch) || !isFinite(n.start) || !isFinite(n.duration)) continue;
        var pitch = clamp(Math.round(n.pitch), 0, 127);
        var vel = isFinite(n.velocity) ? clamp(Math.round(n.velocity), 1, 127) : 100;
        var on = Math.max(0, Math.round(n.start * ppq));
        var off = Math.round((n.start + n.duration) * ppq);
        if (off <= on) off = on + 1;
        events.push({ tick: on, order: 3, seq: seq++, data: [0x90 | ch, pitch, vel] });
        events.push({ tick: off, order: 2, seq: seq++, data: [0x80 | ch, pitch, 0x40] });
      }
      chunks.push(trackChunk(events));
    }

    var head = chunk('MThd', [0, 1, (chunks.length >> 8) & 0xff, chunks.length & 0xff, (ppq >> 8) & 0xff, ppq & 0xff]);
    var size = head.length, c;
    for (c = 0; c < chunks.length; c++) size += chunks[c].length;
    var out = new Uint8Array(size), o = 0;
    out.set(head, o);
    o += head.length;
    for (c = 0; c < chunks.length; c++) {
      out.set(chunks[c], o);
      o += chunks[c].length;
    }
    return out;
  }

  return {
    parse: parse,
    write: write,
    tempoAt: tempoAt,
    beatsToSeconds: beatsToSeconds,
    secondsToBeats: secondsToBeats,
    GM_PROGRAMS: GM_PROGRAMS,
    GM_DRUMS: GM_DRUMS
  };
});
;

// ---- js/studio/dsp/limiter.js ----
/*
 * Stem to Stream Studio: the master limiter.
 *
 * A lookahead peak limiter that also watches the peaks between samples
 * (4x interpolation), so the output stays under the ceiling as a true-peak
 * meter reads it, within a small margin. How it keeps that promise:
 *   r[k]    = gain sample k needs: min(1, ceiling / peak around k)
 *   hold[k] = min(r[k-L .. k])            (L = lookahead in samples)
 *   s[k]    = mean(hold[k-L+1 .. k])       a smooth attack that is already
 *                                           at or below r[k-L] by then
 *   g[k]    = s[k] when falling, else rises toward s[k] at the release rate
 *   out[k]  = in[k-L] * g[k]
 * so every output sample gets a gain no larger than the one it needs.
 *
 * LimiterCore runs in Node (tests), on the main thread, and inside an
 * AudioWorklet (workletSource() builds the processor from this same code).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.factories = root.S2S.studio.factories || {};
    root.S2S.studio.factories.limiter = factory;
    root.S2S.studio.limiter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The same 4x, 16-tap Kaiser (beta 8) interpolator as the true-peak meter in
  // audio-analysis.js, so the limiter aims at exactly what gets measured.
  var FACTOR = 4, TAPS = 16, BETA = 8;

  function besselI0(x) {
    var sum = 1, term = 1, q = x * x / 4;
    for (var k = 1; k < 100; k++) {
      term *= q / (k * k);
      sum += term;
      if (term < sum * 1e-14) break;
    }
    return sum;
  }

  /** Kaiser-windowed sinc phases: FACTOR points between each pair of samples. */
  function makePhases() {
    var N = FACTOR * TAPS, centre = (N - 1) / 2, beta = BETA, i0 = besselI0(beta), phases = [];
    var h = new Float64Array(N);
    for (var n = 0; n < N; n++) {
      var t = (n - centre) / FACTOR, r = 2 * n / (N - 1) - 1;
      h[n] = (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0;
    }
    for (var p = 0; p < FACTOR; p++) {
      var taps = new Float64Array(TAPS), sum = 0;
      for (var k = 0; k < TAPS; k++) { taps[k] = h[p + k * FACTOR]; sum += taps[k]; }
      for (k = 0; k < TAPS; k++) taps[k] /= sum;
      phases.push(taps);
    }
    return phases;
  }

  function LimiterCore(sampleRate, channels) {
    this.sr = sampleRate;
    this.nch = channels;
    this.L = Math.max(4, Math.round(sampleRate * 0.005)); // 5 ms lookahead
    this.D = TAPS / 2;                                      // interpolator delay
    this.phases = makePhases();
    this.hist = [];      // last TAPS input samples per channel (for interpolation)
    this.delay = [];     // audio delay line per channel
    for (var c = 0; c < channels; c++) {
      this.hist.push(new Float64Array(TAPS));
      this.delay.push(new Float64Array(this.L + this.D + 1));
    }
    this.histPos = 0;
    this.delayPos = 0;
    // Sliding minimum of r over L+1 values (monotonic deque of indices into rBuf).
    this.rBuf = new Float64Array(this.L + 2);
    this.dqIdx = new Int32Array(this.L + 2);
    this.dqVal = new Float64Array(this.L + 2);
    this.dqHead = 0;
    this.dqLen = 0;
    this.k = 0;
    // Moving average of hold over L values.
    this.avgBuf = new Float64Array(this.L);
    for (var i = 0; i < this.L; i++) this.avgBuf[i] = 1;
    this.avgSum = this.L;
    this.avgPos = 0;
    this.g = 1;
    this.minGain = 1;
    this.clipped = 0;
    this.on = true;
    this.set({ ceilingDb: -1, driveDb: 0, releaseMs: 120 });
  }

  /** Total delay from input to output, in samples. */
  LimiterCore.prototype.latency = function () { return this.L + this.D; };

  LimiterCore.prototype.set = function (o) {
    if (!o) return;
    if (o.ceilingDb != null) this.ceiling = Math.pow(10, Math.min(0, o.ceilingDb) / 20);
    if (o.driveDb != null) this.drive = Math.pow(10, o.driveDb / 20);
    if (o.releaseMs != null) this.rel = 1 - Math.exp(-1 / (Math.max(1, o.releaseMs) / 1000 * this.sr));
    if (o.on != null) this.on = !!o.on;
  };

  /** Lowest gain applied since the last call (1 = no limiting). */
  LimiterCore.prototype.takeMinGain = function () {
    var m = this.minGain;
    this.minGain = 1;
    return m;
  };

  /**
   * Processes n frames. inputs/outputs are arrays of Float32Array, one per
   * channel; outputs may be the same arrays as inputs.
   */
  LimiterCore.prototype.process = function (inputs, outputs, n) {
    var nch = this.nch, L = this.L, D = this.D, dlen = this.L + this.D + 1;
    var phases = this.phases, ceiling = this.ceiling, drive = this.on ? this.drive : 1;
    for (var i = 0; i < n; i++) {
      // 1. Push the driven input into the interpolation history and the delay line.
      var hp = this.histPos, peak = 0, c, x;
      for (c = 0; c < nch; c++) {
        x = (inputs[c] ? inputs[c][i] : 0) * drive;
        this.hist[c][hp] = x;
        this.delay[c][this.delayPos] = x;
      }
      this.histPos = (hp + 1) % TAPS;
      // 2. Peak at the sample D steps back, including the points just before it.
      for (c = 0; c < nch; c++) {
        var hist = this.hist[c], centre = hist[(this.histPos + D - 1 + TAPS) % TAPS];
        var a = centre < 0 ? -centre : centre;
        if (a > peak) peak = a;
        for (var ph = 0; ph < FACTOR; ph++) {
          var taps = phases[ph], acc = 0;
          for (var t = 0; t < TAPS; t++) acc += taps[t] * hist[(this.histPos + t) % TAPS];
          if (acc < 0) acc = -acc;
          if (acc > peak) peak = acc;
        }
      }
      var r = peak > ceiling ? ceiling / peak : 1;
      // 3. Sliding minimum of r over the last L+1 samples.
      var k = this.k++, cap = this.dqIdx.length;
      while (this.dqLen && this.dqVal[(this.dqHead + this.dqLen - 1) % cap] >= r) this.dqLen--;
      this.dqIdx[(this.dqHead + this.dqLen) % cap] = k;
      this.dqVal[(this.dqHead + this.dqLen) % cap] = r;
      this.dqLen++;
      while (this.dqIdx[this.dqHead] <= k - L - 1) { this.dqHead = (this.dqHead + 1) % cap; this.dqLen--; }
      var hold = this.dqVal[this.dqHead];
      // 4. Moving average over L, then the release.
      this.avgSum += hold - this.avgBuf[this.avgPos];
      this.avgBuf[this.avgPos] = hold;
      this.avgPos = (this.avgPos + 1) % L;
      var s = this.avgSum / L;
      if (s > 1) s = 1;
      var g = s < this.g ? s : this.g + (s - this.g) * this.rel;
      if (!this.on) g = 1;
      this.g = g;
      if (g < this.minGain) this.minGain = g;
      // 5. Output the sample that entered L + D samples ago.
      var outPos = (this.delayPos + 1) % dlen;
      for (c = 0; c < nch; c++) {
        var y = this.delay[c][outPos] * g;
        if (this.on && (y > ceiling || y < -ceiling)) {
          // Safety net only: the gain above already keeps samples under the ceiling.
          this.clipped++;
          y = y > 0 ? ceiling : -ceiling;
        }
        outputs[c][i] = y;
      }
      this.delayPos = outPos;
    }
  };

  /** Source of an AudioWorklet module that runs this limiter as 's2s-limiter'. */
  function workletSource(factorySource) {
    return 'var LimiterCore = (' + factorySource + ')().LimiterCore;\n' +
      'class S2SLimiter extends AudioWorkletProcessor {\n' +
      '  constructor(options) {\n' +
      '    super();\n' +
      '    this.settings = (options && options.processorOptions) || {};\n' +
      '    this.core = null;\n' +
      '    this.count = 0;\n' +
      '    this.port.onmessage = (e) => {\n' +
      '      Object.assign(this.settings, e.data);\n' +
      '      if (this.core) this.core.set(e.data);\n' +
      '    };\n' +
      '  }\n' +
      '  process(inputs, outputs) {\n' +
      '    var input = inputs[0], output = outputs[0], n = output[0].length;\n' +
      '    if (!this.core) { this.core = new LimiterCore(sampleRate, output.length); this.core.set(this.settings); }\n' +
      '    this.core.process(input && input.length ? input : [], output, n);\n' +
      '    this.count += n;\n' +
      '    if (this.count >= 2048) { this.count = 0; this.port.postMessage({ gain: this.core.takeMinGain() }); }\n' +
      '    return true;\n' +
      '  }\n' +
      '}\n' +
      'registerProcessor("s2s-limiter", S2SLimiter);\n';
  }

  return { LimiterCore: LimiterCore, workletSource: workletSource };
});
;

// ---- js/studio/dsp/fft.js ----
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
;

// ---- js/studio/dsp/pitch.js ----
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
;

// ---- js/studio/dsp/rhythm.js ----
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
;

// ---- js/studio/dsp/cleanup.js ----
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
;

// ---- js/studio/dsp/melody.js ----
/*
 * Stem to Stream Studio: melody to MIDI.
 *
 * Turns a single-voice part (a sung or played melody) into MIDI notes. The
 * pitch track from pitch.yin is split into notes where the voice stops,
 * where the pitch settles on a new semitone, and where a new syllable starts
 * on the same pitch (an onset from rhythm.js). Each note takes the median
 * pitch of its frames, rounded to the nearest semitone after the part's
 * overall tuning offset is removed, and a velocity from its loudness.
 *
 *   transcribe(channels, sampleRate, { from, to, minNoteMs: 60, onProgress })
 *     -> { notes: [{p, t, d, v}], tuningCents, voicedSeconds }
 * Note times are seconds into the input (so `from` is kept), which is the
 * same clock as a clip's source time.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.factories = root.S2S.studio.factories || {};
    root.S2S.studio.factories.melody = factory;
    root.S2S.studio.melody = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var node = typeof module === 'object' && module.exports;
  var pitch = node ? require('./pitch.js') : self.S2S.studio.pitch;
  var rhythm = node ? require('./rhythm.js') : self.S2S.studio.rhythm;

  var CHANGE = 0.7;      // semitones away from the current note that count as a new pitch
  var HOLD_MS = 45;      // a new pitch must last this long to start a note
  var ONSET_SNAP_MS = 45;

  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function median(list) {
    if (!list.length) return NaN;
    var s = list.slice().sort(function (a, b) { return a - b; }), n = s.length;
    return n & 1 ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1]);
  }

  function monoSlice(channels, s0, s1) {
    var n = Math.max(0, s1 - s0), out = new Float32Array(n), k = channels.length;
    for (var c = 0; c < k; c++) {
      var ch = channels[c];
      for (var i = 0; i < n; i++) out[i] += ch[s0 + i] / k;
    }
    return out;
  }

  /** The part's tuning offset in cents (-50..50): the circular mean of every voiced frame's distance from a semitone. */
  function tuningOf(midi) {
    var x = 0, y = 0, n = 0;
    for (var i = 0; i < midi.length; i++) {
      if (!(midi[i] > 0)) continue;
      var a = 2 * Math.PI * (midi[i] - Math.floor(midi[i]));
      x += Math.cos(a); y += Math.sin(a); n++;
    }
    if (!n) return 0;
    // Only a consistent offset counts; a singer who is out of tune at random keeps 0.
    if (Math.sqrt(x * x + y * y) / n < 0.5) return 0;
    var c = Math.atan2(y, x) / (2 * Math.PI) * 100;
    return Math.round(c > 50 ? c - 100 : c);
  }

  function transcribe(channels, sampleRate, opts) {
    opts = opts || {};
    var prog = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var len = channels[0].length, total = len / sampleRate;
    var from = clamp(num(opts.from, 0), 0, total), to = clamp(num(opts.to, total), from, total);
    var s0 = Math.floor(from * sampleRate), s1 = Math.ceil(to * sampleRate);
    var mono = monoSlice(channels, s0, s1);
    if (mono.length < sampleRate * 0.05) return { notes: [], tuningCents: 0, voicedSeconds: 0 };

    var track = pitch.yin(mono, sampleRate, { onProgress: function (f) { prog(f * 0.7); } });
    var env = rhythm.onsetEnvelope([mono], sampleRate, {});
    var onsets = rhythm.detectOnsets(env, {});
    prog(0.85);

    var f0 = track.f0, n = f0.length, hopSec = track.hop / sampleRate;
    var midi = new Float64Array(n), voiced = 0;
    for (var i = 0; i < n; i++) {
      midi[i] = f0[i] > 0 ? 69 + 12 * Math.log(f0[i] / 440) / Math.LN2 : 0;
      if (midi[i] > 0) voiced++;
    }

    // Level per frame, to tell a re-sung syllable (the level dips, then rises) from vibrato.
    var level = new Float64Array(n), hop = track.hop;
    for (i = 0; i < n; i++) {
      var c0 = Math.max(0, i * hop - hop), c1 = Math.min(mono.length, i * hop + hop), acc = 0;
      for (var z = c0; z < c1; z++) acc += mono[z] * mono[z];
      level[i] = Math.sqrt(acc / Math.max(1, c1 - c0));
    }
    function dipBefore(of) {
      var lo = Infinity, hi = 0;
      for (var z = Math.max(0, of - 8); z <= of && z < n; z++) lo = Math.min(lo, level[z]);
      for (z = of; z < Math.min(n, of + 10); z++) hi = Math.max(hi, level[z]);
      return hi > 0 && lo / hi < 0.5;   // at least 6 dB
    }
    var hold = Math.max(2, Math.round(HOLD_MS / 1000 / hopSec));
    var minFrames = Math.max(2, Math.round(num(opts.minNoteMs, 60) / 1000 / hopSec));
    var onsetFrames = [];
    for (i = 0; i < onsets.length; i++) onsetFrames.push(Math.round(onsets[i] / hopSec));

    // 1. Split voiced runs where the pitch moves to a new semitone and stays there.
    var segs = [];
    i = 0;
    while (i < n) {
      if (!(midi[i] > 0)) { i++; continue; }
      var start = i, cur = midi[i], frames = [midi[i]], streak = 0;
      i++;
      while (i < n && midi[i] > 0) {
        if (Math.abs(midi[i] - cur) > CHANGE) {
          streak++;
          if (streak >= hold) {
            var cut = i - streak + 1;
            segs.push({ a: start, b: cut });
            start = cut;
            frames = [];
            for (var k = cut; k <= i; k++) frames.push(midi[k]);
            cur = median(frames);
            streak = 0;
          }
        } else {
          streak = 0;
          frames.push(midi[i]);
          if (frames.length <= 8 || frames.length % 8 === 0) cur = median(frames);
        }
        i++;
      }
      segs.push({ a: start, b: i });
    }

    // 2. A new syllable on the same pitch: split at onsets well inside a segment.
    var split = [];
    segs.forEach(function (sg) {
      var a = sg.a, byOnset = false;
      onsetFrames.forEach(function (of) {
        if (of - a >= minFrames && sg.b - of >= minFrames && dipBefore(of)) {
          split.push({ a: a, b: of, byOnset: byOnset });
          a = of;
          byOnset = true;
        }
      });
      split.push({ a: a, b: sg.b, byOnset: byOnset });
    });

    // 3. Drop specks; give each note its median pitch, snap starts to nearby onsets.
    var snap = Math.round(ONSET_SNAP_MS / 1000 / hopSec), notes = [], maxDb = -Infinity;
    split.forEach(function (sg) {
      if (sg.b - sg.a < minFrames) return;
      var vals = [];
      for (var j = sg.a; j < sg.b; j++) if (midi[j] > 0) vals.push(midi[j]);
      var med = median(vals);
      if (!(med > 0)) return;
      var a = sg.a;
      for (var q = 0; q < onsetFrames.length; q++) {
        if (Math.abs(onsetFrames[q] - sg.a) <= snap) { a = onsetFrames[q]; break; }
      }
      var t = a * hopSec, e = sg.b * hopSec;
      var x0 = Math.max(0, Math.floor(t * sampleRate)), x1 = Math.min(mono.length, Math.ceil(e * sampleRate)), sum = 0;
      for (j = x0; j < x1; j++) sum += mono[j] * mono[j];
      var db = 10 * Math.log(sum / Math.max(1, x1 - x0) + 1e-12) / Math.LN10;
      maxDb = Math.max(maxDb, db);
      notes.push({ med: med, frames: sg.b - sg.a, t: t, e: e, db: db, byOnset: sg.byOnset });
    });

    // The part's tuning, from each note's median (vibrato averages out), weighted by length.
    var weighted = [];
    notes.forEach(function (nt) { for (var w = 0; w < nt.frames; w += 4) weighted.push(nt.med); });
    var tuning = tuningOf(weighted), shift = tuning / 100;
    notes = notes.filter(function (nt) {
      nt.p = Math.round(nt.med - shift);
      return nt.p >= 0 && nt.p <= 127;
    });

    // 4. Join pieces of one held note that only a pitch wobble split (not a new syllable).
    var result = [];
    notes.forEach(function (nt) {
      var last = result[result.length - 1];
      if (last && last.p === nt.p && !nt.byOnset && nt.t - last.e < hopSec * 1.5) {
        last.e = nt.e;
        last.db = Math.max(last.db, nt.db);
      } else {
        result.push(nt);
      }
    });

    prog(1);
    return {
      notes: result.map(function (nt) {
        return {
          p: nt.p,
          t: from + nt.t,
          d: Math.max(0.005, nt.e - nt.t),
          v: clamp(Math.round(110 + 2 * (nt.db - maxDb)), 20, 127)
        };
      }),
      tuningCents: tuning,
      voicedSeconds: voiced * hopSec
    };
  }

  return { transcribe: transcribe, tuningOf: tuningOf };
});
;

// ---- js/studio/dsp/vocal.js ----
/*
 * Stem to Stream Studio: the vocal tools the studio runs, in one place.
 *
 * Each tool takes ({ channels, sampleRate, ... }, opts) and returns plain
 * data (and new channels when it changes audio), so the same calls run in
 * a Web Worker, on the main thread, or in Node tests:
 *   clean   AI-artifact cleanup (cleanup.cleanAI)
 *   tune    pitch correction to a key (pitch.autoTune)
 *   key     song key (pitch.estimateKey)
 *   grid    tempo and bar 1 (rhythm.analyzeSong)
 *   timing  where a clip's syllables land against the song's grid
 *   tighten move late or early phrases toward the grid
 *   align   how far a stem is offset from the rest of the music
 *   melody  a single-voice part as MIDI notes (melody.transcribe)
 *
 * Clip time vs song time: a clip plays source time `offset` at song time
 * `start`, so song time = source time + shift, where shift = start - offset.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.factories = root.S2S.studio.factories || {};
    root.S2S.studio.factories.vocal = factory;
    root.S2S.studio.vocal = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var node = typeof module === 'object' && module.exports;
  var pitch = node ? require('./pitch.js') : self.S2S.studio.pitch;
  var rhythm = node ? require('./rhythm.js') : self.S2S.studio.rhythm;
  var cleanup = node ? require('./cleanup.js') : self.S2S.studio.cleanup;
  var melodyLib = node ? require('./melody.js') : self.S2S.studio.melody;

  /** The song grid as the source sees it: same tempo, offset moved by the clip's shift. */
  function sourceGrid(grid, shift) {
    return { bpm: grid.bpm, offset: grid.offset - (shift || 0), subdivision: grid.subdivision || 16 };
  }

  function clean(input, opts) {
    return cleanup.cleanAI(input.channels, input.sampleRate, opts || {});
  }

  function tune(input, opts) {
    return pitch.autoTune(input.channels, input.sampleRate, opts || {});
  }

  function key(input, opts) {
    return pitch.estimateKey(input.channels, input.sampleRate, opts || {});
  }

  function grid(input, opts) {
    return rhythm.analyzeSong(input.channels, input.sampleRate, opts || {});
  }

  /**
   * Onsets of the audio between source times opts.from and opts.to, judged
   * against the song grid. Returns onset times in song time.
   */
  function timing(input, opts) {
    var shift = opts.shift || 0, from = opts.from || 0, to = opts.to == null ? Infinity : opts.to;
    var env = rhythm.onsetEnvelope(input.channels, input.sampleRate, { onProgress: opts.onProgress });
    var all = rhythm.detectOnsets(env, {});
    var onsets = [];
    for (var i = 0; i < all.length; i++) if (all[i] >= from && all[i] < to) onsets.push(all[i] + shift);
    var report = rhythm.timingReport(onsets, opts.grid, { toleranceMs: opts.toleranceMs });
    return { onsets: onsets, report: report };
  }

  /** Moves phrases toward the grid. Returns new channels of the same length, and before/after reports. */
  function tighten(input, opts) {
    var shift = opts.shift || 0, g = sourceGrid(opts.grid, shift);
    var duration = input.channels[0].length / input.sampleRate;
    var env = rhythm.onsetEnvelope(input.channels, input.sampleRate, {});
    var onsets = rhythm.detectOnsets(env, {});
    var before = rhythm.timingReport(onsets, g, { toleranceMs: opts.toleranceMs });
    var plan = rhythm.tightenPlan(onsets, duration, g, {
      strength: opts.strength, maxShiftMs: opts.maxShiftMs, toleranceMs: opts.toleranceMs
    });
    var out = rhythm.applyPlan(input.channels, input.sampleRate, plan, {});
    var env2 = rhythm.onsetEnvelope(out, input.sampleRate, {});
    var after = rhythm.timingReport(rhythm.detectOnsets(env2, {}), g, { toleranceMs: opts.toleranceMs });
    var moved = 0;
    for (var i = 0; i < plan.length; i++) if (plan[i].shift !== 0) moved++;
    return { channels: out, report: { before: before, after: after, moved: moved } };
  }

  /**
   * How late (positive) or early (negative) `input.channels` are against
   * `input.ref` (both rendered over the same song time range). Move the
   * stem earlier by `offset` seconds to line it up.
   */
  function align(input, opts) {
    var a = rhythm.onsetEnvelope(input.ref, input.sampleRate, {});
    var b = rhythm.onsetEnvelope(input.channels, input.sampleRate, {});
    return rhythm.alignmentOffset(a, b, { maxLag: (opts && opts.maxLag) || 0.25 });
  }

  /** MIDI notes of the audio between source times opts.from and opts.to (times stay in source time). */
  function melody(input, opts) {
    return melodyLib.transcribe(input.channels, input.sampleRate, opts || {});
  }

  return {
    melody: melody,
    sourceGrid: sourceGrid,
    clean: clean,
    tune: tune,
    key: key,
    grid: grid,
    timing: timing,
    tighten: tighten,
    align: align
  };
});
;

// ---- js/studio/jobs.js ----
/*
 * Stem to Stream Studio: runs the vocal tools off the main thread.
 *
 * The worker is built from the same module factories the page loaded
 * (fft, pitch, rhythm, cleanup, melody, vocal), so it needs no extra files. Where a
 * browser won't start the worker, the job runs on the page instead (slower
 * to respond while it works, same result).
 *
 *   S2S.studio.jobs.run('clean', { channels, sampleRate }, opts, onProgress)
 *     -> Promise of the tool's result (see dsp/vocal.js)
 */
(function () {
  'use strict';

  var S2S = window.S2S, S = S2S.studio;
  var MODULES = ['fft', 'pitch', 'rhythm', 'cleanup', 'melody', 'vocal'];
  var worker = null, broken = false, seq = 0, pending = {};

  var DISPATCH = [
    'self.onmessage = function (e) {',
    '  var d = e.data, V = self.S2S.studio.vocal, last = 0;',
    '  try {',
    '    var opts = d.opts || {};',
    '    opts.onProgress = function (f) {',
    '      var now = Date.now();',
    '      if (now - last > 100) { last = now; self.postMessage({ id: d.id, progress: f }); }',
    '    };',
    '    var res = V[d.op](d.input, opts), transfer = [];',
    '    if (res && res.channels) res.channels.forEach(function (c) { if (transfer.indexOf(c.buffer) < 0) transfer.push(c.buffer); });',
    '    self.postMessage({ id: d.id, result: res }, transfer);',
    '  } catch (err) {',
    '    self.postMessage({ id: d.id, error: err && err.message ? err.message : String(err) });',
    '  }',
    '};'
  ].join('\n');

  function workerSource() {
    var parts = ['self.S2S = { studio: { factories: {} } };'];
    MODULES.forEach(function (m) {
      parts.push('self.S2S.studio.' + m + ' = (' + S.factories[m].toString() + ')();');
    });
    parts.push(DISPATCH);
    return parts.join('\n');
  }

  function plainOpts(opts) {
    var out = {};
    Object.keys(opts || {}).forEach(function (k) { if (typeof opts[k] !== 'function') out[k] = opts[k]; });
    return out;
  }

  /** Runs on the page: same result, but the page waits while it works. */
  function runHere(op, input, opts, onProgress) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var o = plainOpts(opts);
          o.onProgress = onProgress || function () {};
          resolve(S.vocal[op](input, o));
        } catch (e) {
          reject(e);
        }
      }, 30);
    });
  }

  function failAll(message) {
    broken = true;
    if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
    worker = null;
    var jobs = pending;
    pending = {};
    // Jobs that never got an answer run again on the page.
    Object.keys(jobs).forEach(function (id) {
      var j = jobs[id];
      runHere(j.op, j.input, j.opts, j.onProgress).then(j.resolve, j.reject);
    });
    if (message && window.console) console.warn('Vocal tools are running on the page: ' + message);
  }

  function startWorker() {
    if (worker || broken) return worker;
    try {
      var url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = function (e) {
        var d = e.data, j = pending[d.id];
        if (!j) return;
        if (d.progress != null) { if (j.onProgress) j.onProgress(d.progress); return; }
        delete pending[d.id];
        if (d.error) j.reject(new Error(d.error));
        else j.resolve(d.result);
      };
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        failAll(e && e.message);
      };
    } catch (e) {
      failAll(e && e.message);
    }
    return worker;
  }

  /**
   * Runs a vocal tool. The worker gets copies of input.channels (and
   * input.ref); the caller's audio is never handed away or changed.
   */
  function run(op, input, opts, onProgress) {
    if (!startWorker()) return runHere(op, input, opts, onProgress);
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      // The original input is kept (not copied) in case the job must rerun on the page.
      pending[id] = { op: op, input: input, opts: opts, onProgress: onProgress, resolve: resolve, reject: reject };
      try {
        var sent = { sampleRate: input.sampleRate }, moved = [];
        ['channels', 'ref'].forEach(function (k) {
          if (!input[k]) return;
          sent[k] = input[k].map(function (c) { var x = new Float32Array(c); moved.push(x.buffer); return x; });
        });
        worker.postMessage({ id: id, op: op, input: sent, opts: plainOpts(opts) }, moved);
      } catch (e) {
        failAll(e && e.message);
      }
    });
  }

  S.jobs = { run: run, workerSource: workerSource };
})();
;

// ---- js/studio/fx.js ----
/*
 * Stem to Stream Studio: effect units built from Web Audio nodes.
 *
 *   var u = fx.createUnit(ctx, effect, env);  // env: { bpm }
 *   source.connect(u.input); u.output.connect(next);
 *   u.set(effect, env);   // after a parameter change
 *   u.dispose();
 *
 * The same units run live and in the offline export, so what you hear is
 * what you export. eqResponse() draws the EQ curve with the Web Audio
 * biquad formulas, without needing an audio context.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.fx = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function dbGain(db) { return Math.pow(10, db / 20); }

  function isOffline(ctx) {
    var O = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : null;
    return !!(O && ctx instanceof O);
  }

  /** Sets an AudioParam: smoothly while playing, at once before an offline render. */
  function setParam(ctx, param, value) {
    if (isOffline(ctx)) param.value = value;
    else param.setTargetAtTime(value, ctx.currentTime, 0.015);
  }

  /** Seconds for a tempo-synced note value. */
  function noteSec(sync, bpm) {
    var q = 60 / bpm;
    return { '1/4': q, '1/8': q / 2, '1/8d': q * 0.75, '1/16': q / 4, '1/4t': q * 2 / 3, '1/8t': q / 3 }[sync] || q / 2;
  }

  // Butterworth Q for the high- and low-pass filters, in dB as Web Audio reads it.
  var BUTTERWORTH_Q_DB = -3.0103;

  function biquad(ctx, type) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    return f;
  }

  function mixGains(mixPct) {
    var m = Math.max(0, Math.min(1, mixPct / 100));
    return { dry: Math.cos(m * Math.PI / 2), wet: Math.sin(m * Math.PI / 2) };
  }

  // -------------------------------------------------------------- units ---

  function eqUnit(ctx) {
    var nyq = ctx.sampleRate / 2;
    var hp = biquad(ctx, 'highpass'), low = biquad(ctx, 'lowshelf'), mid = biquad(ctx, 'peaking');
    var pres = biquad(ctx, 'peaking'), high = biquad(ctx, 'highshelf'), lp = biquad(ctx, 'lowpass');
    var chain = [hp, low, mid, pres, high, lp];
    for (var i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    hp.Q.value = lp.Q.value = BUTTERWORTH_Q_DB;
    return {
      input: hp,
      output: lp,
      set: function (fx) {
        var p = fx.p;
        setParam(ctx, hp.frequency, p.hpHz > 0 ? p.hpHz : 5);
        setParam(ctx, low.frequency, p.lowHz);
        setParam(ctx, low.gain, p.lowDb);
        setParam(ctx, mid.frequency, p.midHz);
        setParam(ctx, mid.gain, p.midDb);
        setParam(ctx, mid.Q, p.midQ);
        setParam(ctx, pres.frequency, Math.min(p.presHz, nyq * 0.9));
        setParam(ctx, pres.gain, p.presDb);
        setParam(ctx, pres.Q, p.presQ);
        setParam(ctx, high.frequency, Math.min(p.highHz, nyq * 0.9));
        setParam(ctx, high.gain, p.highDb);
        setParam(ctx, lp.frequency, Math.min(p.lpHz >= 20000 ? nyq : p.lpHz, nyq * 0.98));
      },
      dispose: function () { chain.forEach(function (n) { n.disconnect(); }); }
    };
  }

  function compUnit(ctx) {
    var comp = ctx.createDynamicsCompressor(), makeup = ctx.createGain();
    comp.connect(makeup);
    return {
      input: comp,
      output: makeup,
      set: function (fx) {
        var p = fx.p;
        setParam(ctx, comp.threshold, p.thresholdDb);
        setParam(ctx, comp.ratio, p.ratio);
        setParam(ctx, comp.attack, p.attackMs / 1000);
        setParam(ctx, comp.release, p.releaseMs / 1000);
        setParam(ctx, comp.knee, p.kneeDb);
        setParam(ctx, makeup.gain, dbGain(p.makeupDb));
      },
      /** Current gain reduction in dB (0 or negative). */
      reduction: function () {
        var r = comp.reduction;
        return typeof r === 'number' ? r : r && typeof r.value === 'number' ? r.value : 0;
      },
      dispose: function () { comp.disconnect(); makeup.disconnect(); }
    };
  }

  /** Decorrelated stereo noise with an exponential decay that falls 60 dB in `decay` seconds. */
  function impulse(ctx, decay) {
    var sr = ctx.sampleRate, len = Math.max(1, Math.ceil(Math.min(10, decay * 1.15 + 0.05) * sr));
    var buf = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c), seed = c ? 0x2545f491 : 0x9e3779b9, fadeIn = Math.round(sr * 0.002);
      for (var i = 0; i < len; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        var n = ((seed >>> 0) / 4294967296) * 2 - 1;
        var env = Math.exp(-6.9078 * (i / sr) / decay);
        d[i] = n * env * (i < fadeIn ? i / fadeIn : 1);
      }
    }
    return buf;
  }

  function reverbUnit(ctx) {
    var input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    var pre = ctx.createDelay(1), conv = ctx.createConvolver(), tone = biquad(ctx, 'lowpass');
    tone.Q.value = BUTTERWORTH_Q_DB;
    input.connect(dry); dry.connect(output);
    input.connect(pre); pre.connect(conv); conv.connect(tone); tone.connect(wet); wet.connect(output);
    var decay = 0, timer = 0;
    function load(d) { decay = d; conv.buffer = impulse(ctx, d); }
    return {
      input: input,
      output: output,
      set: function (fx) {
        var p = fx.p, g = mixGains(p.mix);
        setParam(ctx, dry.gain, g.dry);
        setParam(ctx, wet.gain, g.wet);
        setParam(ctx, pre.delayTime, p.preDelayMs / 1000);
        setParam(ctx, tone.frequency, Math.min(p.toneHz, ctx.sampleRate * 0.45));
        if (Math.abs(p.decayS - decay) > 0.001) {
          // Building an impulse takes a few ms; while dragging, wait for a pause.
          if (!decay || isOffline(ctx)) load(p.decayS);
          else { clearTimeout(timer); timer = setTimeout(function () { load(p.decayS); }, 120); }
        }
      },
      dispose: function () {
        clearTimeout(timer);
        [input, output, dry, wet, pre, conv, tone].forEach(function (n) { n.disconnect(); });
      }
    };
  }

  function delayUnit(ctx) {
    var input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    var delay = ctx.createDelay(4), tone = biquad(ctx, 'lowpass'), fb = ctx.createGain();
    tone.Q.value = BUTTERWORTH_Q_DB;
    input.connect(dry); dry.connect(output);
    input.connect(delay); delay.connect(tone); tone.connect(wet); wet.connect(output);
    tone.connect(fb); fb.connect(delay);
    return {
      input: input,
      output: output,
      set: function (fx, env) {
        var p = fx.p, g = mixGains(p.mix);
        var time = p.sync !== 'off' ? noteSec(p.sync, (env && env.bpm) || 120) : p.timeMs / 1000;
        setParam(ctx, dry.gain, g.dry);
        setParam(ctx, wet.gain, g.wet);
        setParam(ctx, delay.delayTime, Math.min(3.9, Math.max(0.001, time)));
        setParam(ctx, fb.gain, Math.min(0.9, p.feedback / 100));
        setParam(ctx, tone.frequency, Math.min(p.toneHz, ctx.sampleRate * 0.45));
      },
      dispose: function () { [input, output, dry, wet, delay, tone, fb].forEach(function (n) { n.disconnect(); }); }
    };
  }

  function driveCurve(amount) {
    var k = 1 + amount / 100 * 24, n = 2048, curve = new Float32Array(n), norm = Math.tanh(k);
    for (var i = 0; i < n; i++) {
      var x = i / (n - 1) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
  }

  function driveUnit(ctx) {
    var input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    var shaper = ctx.createWaveShaper(), tone = biquad(ctx, 'lowpass'), trim = ctx.createGain();
    shaper.oversample = '4x';
    tone.Q.value = BUTTERWORTH_Q_DB;
    input.connect(dry); dry.connect(output);
    input.connect(shaper); shaper.connect(tone); tone.connect(trim); trim.connect(wet); wet.connect(output);
    var amount = -1;
    return {
      input: input,
      output: output,
      set: function (fx) {
        var p = fx.p, m = Math.max(0, Math.min(1, p.mix / 100));
        if (p.amount !== amount) { amount = p.amount; shaper.curve = driveCurve(amount); }
        setParam(ctx, dry.gain, 1 - m);
        setParam(ctx, wet.gain, m);
        setParam(ctx, tone.frequency, Math.min(p.toneHz, ctx.sampleRate * 0.45));
        // Saturation makes things louder; pull the level back so the drive is heard, not just the volume.
        setParam(ctx, trim.gain, dbGain(-p.amount * 0.08));
        setParam(ctx, output.gain, dbGain(p.outDb));
      },
      dispose: function () { [input, output, dry, wet, shaper, tone, trim].forEach(function (n) { n.disconnect(); }); }
    };
  }

  var MAKERS = { eq: eqUnit, comp: compUnit, reverb: reverbUnit, delay: delayUnit, drive: driveUnit };

  function createUnit(ctx, fx, env) {
    var u = MAKERS[fx.type](ctx);
    u.type = fx.type;
    u.id = fx.id;
    u.set(fx, env);
    return u;
  }

  // ------------------------------------------------------------ limiter ---

  var workletUrl = null, loaded = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  /** Loads the limiter's AudioWorklet into a context. Resolves true, or false when the browser won't. */
  function ensureWorklet(ctx) {
    if (!ctx.audioWorklet || !loaded || typeof Blob === 'undefined') return Promise.resolve(false);
    if (loaded.has(ctx)) return loaded.get(ctx);
    if (!workletUrl) {
      var S = self.S2S.studio;
      var src = S.limiter.workletSource(S.factories.limiter.toString());
      workletUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    }
    var p = ctx.audioWorklet.addModule(workletUrl).then(function () { return true; }, function () { return false; });
    loaded.set(ctx, p);
    return p;
  }

  function limiterSettings(l) {
    return { on: l.on, driveDb: l.driveDb, ceilingDb: l.ceilingDb, releaseMs: l.releaseMs };
  }

  /**
   * The master limiter. Uses the AudioWorklet when it loaded (precise,
   * true-peak); otherwise a basic one from a compressor and a clipper.
   */
  function limiterUnit(ctx, settings, useWorklet) {
    var minGain = 1;
    if (useWorklet) {
      var node = new AudioWorkletNode(ctx, 's2s-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: limiterSettings(settings)
      });
      node.port.onmessage = function (e) { if (e.data && e.data.gain < minGain) minGain = e.data.gain; };
      return {
        input: node,
        output: node,
        precise: true,
        latency: (Math.max(4, Math.round(ctx.sampleRate * 0.005)) + 8) / ctx.sampleRate,
        set: function (l) { node.port.postMessage(limiterSettings(l)); },
        reduction: function () { var g = minGain; minGain = 1; return g < 1 ? 20 * Math.log10(g) : 0; },
        dispose: function () { node.port.onmessage = null; node.disconnect(); }
      };
    }
    var drive = ctx.createGain(), comp = ctx.createDynamicsCompressor(), clip = ctx.createWaveShaper(), out = ctx.createGain();
    drive.connect(comp); comp.connect(clip); clip.connect(out);
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0.001;
    function apply(l) {
      var c = l.on ? dbGain(l.ceilingDb) : 1, curve = new Float32Array(1025);
      for (var i = 0; i < curve.length; i++) {
        var x = i / 512 - 1;
        curve[i] = l.on ? Math.max(-c, Math.min(c, x)) : x;
      }
      clip.curve = curve;
      setParam(ctx, drive.gain, l.on ? dbGain(l.driveDb) : 1);
      setParam(ctx, comp.threshold, l.on ? l.ceilingDb - 0.5 : 0);
      setParam(ctx, comp.ratio, l.on ? 20 : 1);
      setParam(ctx, comp.release, l.releaseMs / 1000);
    }
    apply(settings);
    return {
      input: drive,
      output: out,
      precise: false,
      latency: 0.006,
      set: apply,
      reduction: function () { var r = comp.reduction; return typeof r === 'number' ? r : 0; },
      dispose: function () { [drive, comp, clip, out].forEach(function (n) { n.disconnect(); }); }
    };
  }

  // ---------------------------------------------------------- EQ curve ---

  /** Biquad coefficients exactly as the Web Audio spec defines them. */
  function coefs(type, f0, q, gainDb, sr) {
    var w0 = 2 * Math.PI * f0 / sr, cw = Math.cos(w0), sw = Math.sin(w0), A = Math.pow(10, gainDb / 40), a;
    var b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass' || type === 'highpass') {
      a = sw / (2 * Math.pow(10, q / 20));
      if (type === 'lowpass') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
      else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
      a0 = 1 + a; a1 = -2 * cw; a2 = 1 - a;
    } else if (type === 'peaking') {
      a = sw / (2 * q);
      b0 = 1 + a * A; b1 = -2 * cw; b2 = 1 - a * A; a0 = 1 + a / A; a1 = -2 * cw; a2 = 1 - a / A;
    } else {
      a = sw / 2 * Math.sqrt(2);
      var sq = 2 * Math.sqrt(A) * a;
      if (type === 'lowshelf') {
        b0 = A * ((A + 1) - (A - 1) * cw + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sq);
        a0 = (A + 1) + (A - 1) * cw + sq; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sq;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sq);
        a0 = (A + 1) - (A - 1) * cw + sq; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sq;
      }
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  function magnitude(c, f, sr) {
    var w = 2 * Math.PI * f / sr, cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    var nr = c[0] + c[1] * cw + c[2] * c2, ni = -(c[1] * sw + c[2] * s2);
    var dr = 1 + c[3] * cw + c[4] * c2, di = -(c[3] * sw + c[4] * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  /** The EQ's response in dB at each frequency in `freqs`. */
  function eqResponse(p, sampleRate, freqs) {
    var nyq = sampleRate / 2;
    var stages = [
      coefs('highpass', p.hpHz > 0 ? p.hpHz : 5, BUTTERWORTH_Q_DB, 0, sampleRate),
      coefs('lowshelf', p.lowHz, 0, p.lowDb, sampleRate),
      coefs('peaking', p.midHz, p.midQ, p.midDb, sampleRate),
      coefs('peaking', Math.min(p.presHz, nyq * 0.9), p.presQ, p.presDb, sampleRate),
      coefs('highshelf', Math.min(p.highHz, nyq * 0.9), 0, p.highDb, sampleRate),
      coefs('lowpass', Math.min(p.lpHz >= 20000 ? nyq : p.lpHz, nyq * 0.98), BUTTERWORTH_Q_DB, 0, sampleRate)
    ];
    var out = new Float32Array(freqs.length);
    for (var i = 0; i < freqs.length; i++) {
      var m = 1;
      for (var s = 0; s < stages.length; s++) m *= magnitude(stages[s], freqs[i], sampleRate);
      out[i] = 20 * Math.log10(Math.max(m, 1e-9));
    }
    return out;
  }

  return {
    createUnit: createUnit,
    limiterUnit: limiterUnit,
    ensureWorklet: ensureWorklet,
    eqResponse: eqResponse,
    noteSec: noteSec,
    driveCurve: driveCurve
  };
});
;

// ---- js/studio/synth.js ----
/*
 * Stem to Stream Studio: built-in instruments (synths and a drum kit) made
 * from standard Web Audio nodes.
 *
 *   var inst = synth.createInstrument(ctx, { type: 'synth', p: params }, output);
 *   inst.play(pitch, velocity, time, duration);  // a whole note, scheduled ahead
 *   inst.noteOn(pitch, velocity, time);          // live keyboard
 *   inst.noteOff(pitch, time);
 *   inst.stopAll(time);                          // pause or seek
 *   inst.set({ type, p });  inst.dispose();
 *
 * The same voices run live and in the offline export, so what you hear is
 * what you export. Every envelope is a list of breakpoints joined by linear
 * ramps (adsrPoints), so a release, a voice steal or a stop starts from the
 * exact level the envelope has at that moment, without a click. Noise comes
 * from a seeded generator, so an export renders the same every time.
 *
 * Offline, the browser processes every node that exists, even before its
 * note starts, so scheduling a whole song's notes up front would cost
 * notes x song length. Notes more than BUILD_AHEAD away are queued, and the
 * render pauses (OfflineAudioContext.suspend) to build them shortly before
 * they start. Ended voices disconnect themselves (onended).
 *
 * Gain staging: one note at velocity 127 peaks around -6 to -8 dBFS. Each
 * instrument ends in a soft ceiling (linear up to -6 dBFS, then a smooth
 * knee that never passes -0.2 dBFS), so big chords bend instead of clipping.
 * Oscillators start at turning phases so chord notes don't add up in step.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.synth = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_VOICES = 24;       // per instrument; the oldest voice is stolen
  var STEAL_FADE = 0.005;    // seconds: a stolen voice fades out this fast
  var STOP_FADE = 0.015;     // stopAll()
  var CHOKE_FADE = 0.012;    // a closed hi-hat cutting an open one
  var STOP_PAD = 0.002;      // sources stop this long after their envelope reaches 0
  var DECAY_STEPS = 8;       // straight segments that approximate one decay curve
  var RELEASE_STEPS = 10;    // ... and one release curve (6 dB each)
  var MIN_ATTACK = 0.001;
  var MIN_RELEASE = 0.003;
  var NOISE_SEC = 2;         // the shared noise buffer loops
  var BUILD_AHEAD = 0.25;    // offline, a voice is built at most this long before it starts
  var QUANTUM = 128;         // frames per render quantum
  var HARMONICS = 1024;      // partials in the oscillator waves (above Nyquist for any note)
  var BUTTERWORTH_Q_DB = -3.0103;

  // Output stage: a soft ceiling. Linear below KNEE, then a tanh knee that
  // approaches CEILING. The curve covers +-CLIP_RANGE, so the level gain
  // divides by it and the curve multiplies back: unity gain below the knee.
  var KNEE = 0.5, CEILING = 0.975, CLIP_RANGE = 8;

  // Level of each voice type at velocity 127, before the instrument level.
  var SYNTH_GAIN = 0.62, FM_GAIN = 0.4, ORGAN_GAIN = 0.27;
  var UNISON_NORM = [1, 1, 0.72, 0.6, 0.52];  // by number of unison voices
  var SUB_GAIN = 0.7;
  var INDEX_FLOOR = 0.1;     // FM index settles at this fraction of its peak
  var TINE_RATIO = 14, TINE_INDEX = 1.1, TINE_DECAY = 0.3;
  var ORGAN_RELEASE = 0.06, PERC_DECAY = 0.45, ROTARY_DELAY = 0.005, ROTARY_MOD = 0.0006;
  var DRUM_VEL = 0.75;       // velocity sensitivity of the drum kit

  var WAVES = ['sine', 'triangle', 'sawtooth', 'square'];

  /*
   * Instrument types. Each parameter: label, min, max, step, unit, default,
   * and log (slider moves on a log scale) or options (a pick list), the same
   * shape as the effect parameters in core.js.
   */
  var INSTRUMENTS = {
    synth: {
      name: 'Analog synth',
      kind: 'synth',
      params: {
        osc1Wave: { label: 'Osc 1 wave', options: WAVES.slice(), def: 'sawtooth' },
        osc2Wave: { label: 'Osc 2 wave', options: WAVES.slice(), def: 'sawtooth' },
        osc2Semi: { label: 'Osc 2 pitch', min: -24, max: 24, step: 1, unit: 'st', def: 0 },
        osc2Detune: { label: 'Osc 2 detune', min: -50, max: 50, step: 1, unit: 'ct', def: 7 },
        oscMix: { label: 'Osc 1 / 2 mix', min: 0, max: 1, step: 0.01, unit: '', def: 0.5 },
        subLevel: { label: 'Sub oscillator', min: 0, max: 1, step: 0.01, unit: '', def: 0 },
        cutoffHz: { label: 'Cutoff', min: 40, max: 18000, step: 1, unit: 'Hz', def: 2000, log: true },
        resonance: { label: 'Resonance', min: 0, max: 20, step: 0.1, unit: 'dB', def: 3 },
        filterEnv: { label: 'Filter envelope', min: 0, max: 6, step: 0.05, unit: 'oct', def: 2 },
        keyTrack: { label: 'Key tracking', min: 0, max: 1, step: 0.01, unit: '', def: 0.5 },
        ampAttackMs: { label: 'Attack', min: 1, max: 5000, step: 1, unit: 'ms', def: 5, log: true },
        ampDecayMs: { label: 'Decay', min: 5, max: 10000, step: 1, unit: 'ms', def: 400, log: true },
        ampSustain: { label: 'Sustain', min: 0, max: 1, step: 0.01, unit: '', def: 0.75 },
        ampReleaseMs: { label: 'Release', min: 5, max: 10000, step: 1, unit: 'ms', def: 250, log: true },
        filtAttackMs: { label: 'Filter attack', min: 1, max: 5000, step: 1, unit: 'ms', def: 5, log: true },
        filtDecayMs: { label: 'Filter decay', min: 5, max: 10000, step: 1, unit: 'ms', def: 400, log: true },
        filtSustain: { label: 'Filter sustain', min: 0, max: 1, step: 0.01, unit: '', def: 0.3 },
        filtReleaseMs: { label: 'Filter release', min: 5, max: 10000, step: 1, unit: 'ms', def: 300, log: true },
        glideMs: { label: 'Glide (mono)', min: 0, max: 2000, step: 1, unit: 'ms', def: 0, offAt: 0 },
        poly: { label: 'Voices', options: ['poly', 'mono'], def: 'poly' },
        unison: { label: 'Unison voices', min: 1, max: 4, step: 1, unit: '', def: 1 },
        spreadCents: { label: 'Unison spread', min: 0, max: 50, step: 1, unit: 'ct', def: 12 },
        vibRateHz: { label: 'Vibrato rate', min: 0.5, max: 12, step: 0.1, unit: 'Hz', def: 5.5, log: true },
        vibDepth: { label: 'Vibrato depth', min: 0, max: 100, step: 1, unit: 'ct', def: 0 },
        velFilter: { label: 'Velocity to cutoff', min: 0, max: 1, step: 0.01, unit: '', def: 0.4 },
        velAmp: { label: 'Velocity to level', min: 0, max: 1, step: 0.01, unit: '', def: 0.6 },
        levelDb: { label: 'Level', min: -24, max: 6, step: 0.5, unit: 'dB', def: 0 }
      }
    },
    fm: {
      name: 'FM piano / bell',
      kind: 'synth',
      params: {
        ratio: { label: 'Mod ratio', min: 0.5, max: 16, step: 0.01, unit: ':1', def: 1 },
        index: { label: 'Mod index', min: 0, max: 12, step: 0.05, unit: '', def: 2 },
        indexDecayMs: { label: 'Index decay', min: 20, max: 10000, step: 1, unit: 'ms', def: 800, log: true },
        tine: { label: 'Attack tine', min: 0, max: 1, step: 0.01, unit: '', def: 0 },
        attackMs: { label: 'Attack', min: 1, max: 5000, step: 1, unit: 'ms', def: 2, log: true },
        decayMs: { label: 'Decay', min: 5, max: 10000, step: 1, unit: 'ms', def: 2500, log: true },
        sustain: { label: 'Sustain', min: 0, max: 1, step: 0.01, unit: '', def: 0.2 },
        releaseMs: { label: 'Release', min: 5, max: 10000, step: 1, unit: 'ms', def: 400, log: true },
        brightVel: { label: 'Velocity to brightness', min: 0, max: 1, step: 0.01, unit: '', def: 0.6 },
        tremDepth: { label: 'Tremolo (stereo)', min: 0, max: 1, step: 0.01, unit: '', def: 0 },
        tremRateHz: { label: 'Tremolo rate', min: 0.5, max: 10, step: 0.1, unit: 'Hz', def: 4.5, log: true },
        levelDb: { label: 'Level', min: -24, max: 6, step: 0.5, unit: 'dB', def: 0 }
      }
    },
    organ: {
      name: 'Drawbar organ',
      kind: 'synth',
      params: {
        draw16: { label: "16' drawbar", min: 0, max: 8, step: 1, unit: '', def: 8 },
        draw8: { label: "8' drawbar", min: 0, max: 8, step: 1, unit: '', def: 8 },
        draw4: { label: "4' drawbar", min: 0, max: 8, step: 1, unit: '', def: 6 },
        draw2: { label: "2' drawbar", min: 0, max: 8, step: 1, unit: '', def: 0 },
        perc: { label: 'Percussion click', min: 0, max: 1, step: 0.01, unit: '', def: 0.5 },
        rotary: { label: 'Rotary depth', min: 0, max: 1, step: 0.01, unit: '', def: 0.5 },
        rotaryHz: { label: 'Rotary speed', min: 0.5, max: 8, step: 0.1, unit: 'Hz', def: 1.2, log: true },
        levelDb: { label: 'Level', min: -24, max: 6, step: 0.5, unit: 'dB', def: 0 }
      }
    },
    drums: {
      name: 'Drum kit',
      kind: 'drums',
      params: {
        kickTune: { label: 'Kick tune', min: -12, max: 12, step: 0.5, unit: 'st', def: 0 },
        kickDecayMs: { label: 'Kick decay', min: 80, max: 2000, step: 1, unit: 'ms', def: 450, log: true },
        snareTone: { label: 'Snare tone', min: 0, max: 1, step: 0.01, unit: '', def: 0.5 },
        snareSnappy: { label: 'Snare snappiness', min: 0, max: 1, step: 0.01, unit: '', def: 0.7 },
        hatDecayMs: { label: 'Hi-hat decay', min: 20, max: 400, step: 1, unit: 'ms', def: 80, log: true },
        hatTone: { label: 'Hi-hat tone', min: 0, max: 1, step: 0.01, unit: '', def: 0.5 },
        tomTune: { label: 'Tom tune', min: -12, max: 12, step: 0.5, unit: 'st', def: 0 },
        levelDb: { label: 'Level', min: -24, max: 6, step: 0.5, unit: 'dB', def: 0 }
      }
    }
  };

  // ------------------------------------------------------------ helpers ---

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function num(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function dbGain(db) { return Math.pow(10, db / 20); }
  function tanh(x) { var e = Math.exp(2 * x); return x > 20 ? 1 : (e - 1) / (e + 1); }

  function isOffline(ctx) {
    var O = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : null;
    return !!(O && ctx instanceof O);
  }

  /** Sets an AudioParam: smoothly while playing, at once before an offline render. */
  function setParam(ctx, param, value) {
    if (isOffline(ctx)) param.value = value;
    else param.setTargetAtTime(value, ctx.currentTime, 0.015);
  }

  // --------------------------------------------------------- pure maths ---

  /** Frequency in Hz of MIDI note `pitch` (69 = A4); fractional pitches bend. */
  function midiHz(pitch, tuningA4) {
    var a4 = num(tuningA4, 440);
    return (a4 > 0 ? a4 : 440) * Math.pow(2, (num(pitch, 69) - 69) / 12);
  }

  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** Note name with octave, middle C (60) = 'C4'. Empty for a non-number. */
  function noteName(pitch) {
    if (typeof pitch !== 'number' || !isFinite(pitch)) return '';
    var n = Math.round(pitch);
    return NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
  }

  /**
   * Gain for MIDI velocity 1..127. amount 0 ignores velocity; amount 1 is
   * the General MIDI / DLS curve, 40 log10(vel / 127) dB. 127 is always 1.
   */
  function velocityGain(vel, amount) {
    var v = clamp(num(vel, 100), 1, 127) / 127;
    return Math.pow(v, 2 * clamp(num(amount, 1), 0, 1));
  }

  /** 1 at x = 0 down to 0 at x = 1, falling 60 dB evenly: how decays and releases sound natural. */
  function decayShape(x) { return x >= 1 ? 0 : (Math.pow(1000, -x) - 0.001) / 0.999; }

  /** Release breakpoints from `level` at time t0, reaching 0 after `release` seconds. */
  function releasePoints(level, release, t0) {
    var out = [];
    if (!(level > 0)) return out;
    for (var k = 1; k <= RELEASE_STEPS; k++) {
      out.push({ t: t0 + release * k / RELEASE_STEPS, v: level * decayShape(k / RELEASE_STEPS) });
    }
    return out;
  }

  /** Value of a breakpoint list at time t (linear between points, held outside them). */
  function envelopeAt(points, t) {
    if (!points || !points.length) return 0;
    if (t <= points[0].t) return points[0].v;
    for (var i = 1; i < points.length; i++) {
      if (t <= points[i].t) {
        var a = points[i - 1], b = points[i];
        return b.t > a.t ? a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t) : b.v;
      }
    }
    return points[points.length - 1].v;
  }

  /**
   * Envelope breakpoints [{t, v}] for adsr = {attack, decay, sustain,
   * release} (seconds; sustain 0..1) and a note `noteDurationSec` long
   * (Infinity or null: held until released). Times are from the note start;
   * the points are joined by straight lines. It starts at 0 and, for a
   * finished note, ends at 0: the release begins at the note's end from
   * whatever level the envelope reached, so a short note never jumps.
   */
  function adsrPoints(adsr, noteDurationSec) {
    adsr = adsr || {};
    var a = Math.max(MIN_ATTACK, num(adsr.attack, 0.005)), d = Math.max(0.001, num(adsr.decay, 0.1));
    var s = clamp(num(adsr.sustain, 1), 0, 1), r = Math.max(MIN_RELEASE, num(adsr.release, 0.1));
    var dur = typeof noteDurationSec === 'number' && noteDurationSec === noteDurationSec ? Math.max(0, noteDurationSec) : Infinity;
    var hold = [{ t: 0, v: 0 }, { t: a, v: 1 }];
    if (s < 1) {
      for (var k = 1; k <= DECAY_STEPS; k++) hold.push({ t: a + d * k / DECAY_STEPS, v: s + (1 - s) * decayShape(k / DECAY_STEPS) });
    }
    var pts = hold;
    if (dur < Infinity) {
      var level = envelopeAt(hold, dur);
      pts = [];
      for (var i = 0; i < hold.length && hold[i].t < dur; i++) pts.push(hold[i]);
      pts.push({ t: dur, v: level });
      pts = pts.concat(releasePoints(level, r, dur));
    }
    // Once the level is 0 for good (sustain 0, or after the release), the envelope is over.
    while (pts.length > 2 && pts[pts.length - 1].v === 0 && pts[pts.length - 2].v === 0) pts.pop();
    return pts;
  }

  /** Breakpoints of a drum hit: rise, hold, then a 60 dB decay to 0. */
  function hitPoints(attack, hold, decay) {
    var pts = [{ t: 0, v: 0 }, { t: attack, v: 1 }];
    if (hold > 0) pts.push({ t: attack + hold, v: 1 });
    for (var k = 1; k <= DECAY_STEPS; k++) pts.push({ t: attack + hold + decay * k / DECAY_STEPS, v: decayShape(k / DECAY_STEPS) });
    return pts;
  }

  /** A fast drop to `mid` over `fall` seconds, then a slow decay to 0 (cymbals, cowbell). */
  function twoStage(attack, mid, fall, decay) {
    var pts = [{ t: 0, v: 0 }, { t: attack, v: 1 }], k;
    for (k = 1; k <= 4; k++) pts.push({ t: attack + fall * k / 4, v: mid + (1 - mid) * decayShape(k / 4) });
    for (k = 1; k <= DECAY_STEPS; k++) pts.push({ t: attack + fall + decay * k / DECAY_STEPS, v: mid * decayShape(k / DECAY_STEPS) });
    return pts;
  }

  // ------------------------------------------------------- parameters ---

  function typeOf(type) { return typeof type === 'string' && has(INSTRUMENTS, type) ? type : 'synth'; }

  function paramValue(spec, v) {
    if (spec.options) return spec.options.indexOf(v) >= 0 ? v : spec.def;
    var x = clamp(num(v, spec.def), spec.min, spec.max);
    // Whole-number steps (semitones, voices, drawbars, ms) stay whole.
    if (spec.step >= 1 && spec.step % 1 === 0) x = clamp(spec.min + Math.round((x - spec.min) / spec.step) * spec.step, spec.min, spec.max);
    return x;
  }

  /**
   * A complete, valid parameter set for `type` (unknown types count as
   * 'synth'): numbers clamped to their range, picks checked against their
   * options, unknown keys dropped and missing ones set to the default.
   */
  function clampParams(type, p) {
    var specs = INSTRUMENTS[typeOf(type)].params, src = p && typeof p === 'object' ? p : {}, out = {};
    Object.keys(specs).forEach(function (k) { out[k] = paramValue(specs[k], has(src, k) ? src[k] : undefined); });
    return out;
  }

  function defaults(type) { return clampParams(type, null); }

  // ------------------------------------------------------------ presets ---

  var PRESETS = [];
  function preset(id, name, type, over) {
    var p = defaults(type);
    Object.keys(over).forEach(function (k) { p[k] = over[k]; });
    PRESETS.push({ id: id, name: name, type: type, p: p });
  }

  preset('analog-lead', 'Analog lead', 'synth', {
    osc1Wave: 'sawtooth', osc2Wave: 'square', osc2Semi: 0, osc2Detune: 6, oscMix: 0.4, subLevel: 0.25,
    cutoffHz: 1600, resonance: 6, filterEnv: 2.2, keyTrack: 0.6,
    ampAttackMs: 4, ampDecayMs: 500, ampSustain: 0.85, ampReleaseMs: 180,
    filtAttackMs: 3, filtDecayMs: 380, filtSustain: 0.35, filtReleaseMs: 200,
    glideMs: 60, poly: 'mono', unison: 1, vibRateHz: 5.5, vibDepth: 12, velFilter: 0.5, velAmp: 0.4
  });
  preset('soft-pad', 'Soft pad', 'synth', {
    osc1Wave: 'sawtooth', osc2Wave: 'triangle', osc2Semi: 12, osc2Detune: 4, oscMix: 0.3, subLevel: 0,
    cutoffHz: 1300, resonance: 1.5, filterEnv: 1.2, keyTrack: 0.4,
    ampAttackMs: 700, ampDecayMs: 1500, ampSustain: 0.85, ampReleaseMs: 1600,
    filtAttackMs: 1200, filtDecayMs: 2000, filtSustain: 0.5, filtReleaseMs: 1600,
    poly: 'poly', unison: 4, spreadCents: 20, vibDepth: 0, velFilter: 0.3, velAmp: 0.35
  });
  preset('sub-bass', 'Sub bass', 'synth', {
    osc1Wave: 'sine', osc2Wave: 'triangle', osc2Semi: 0, osc2Detune: 0, oscMix: 0.15, subLevel: 0,
    cutoffHz: 500, resonance: 0, filterEnv: 0.3, keyTrack: 0.3,
    ampAttackMs: 4, ampDecayMs: 300, ampSustain: 0.9, ampReleaseMs: 90,
    filtAttackMs: 2, filtDecayMs: 150, filtSustain: 0, filtReleaseMs: 100,
    poly: 'mono', glideMs: 0, unison: 1, vibDepth: 0, velFilter: 0.2, velAmp: 0.3
  });
  preset('acid-bass', 'Acid bass', 'synth', {
    osc1Wave: 'sawtooth', osc2Wave: 'square', osc2Semi: 0, osc2Detune: 0, oscMix: 0, subLevel: 0,
    cutoffHz: 200, resonance: 15, filterEnv: 3.4, keyTrack: 0.5,
    ampAttackMs: 2, ampDecayMs: 400, ampSustain: 0.7, ampReleaseMs: 60,
    filtAttackMs: 1, filtDecayMs: 650, filtSustain: 0.05, filtReleaseMs: 150,
    poly: 'mono', glideMs: 45, unison: 1, vibDepth: 0, velFilter: 0.6, velAmp: 0.35
  });
  preset('pluck', 'Pluck', 'synth', {
    osc1Wave: 'sawtooth', osc2Wave: 'square', osc2Semi: 12, osc2Detune: 0, oscMix: 0.25, subLevel: 0,
    cutoffHz: 650, resonance: 4, filterEnv: 3.4, keyTrack: 0.6,
    ampAttackMs: 1, ampDecayMs: 600, ampSustain: 0, ampReleaseMs: 300,
    filtAttackMs: 1, filtDecayMs: 200, filtSustain: 0, filtReleaseMs: 200,
    poly: 'poly', unison: 2, spreadCents: 10, vibDepth: 0, velFilter: 0.6, velAmp: 0.6
  });
  preset('brass-stab', 'Brass stab', 'synth', {
    osc1Wave: 'sawtooth', osc2Wave: 'sawtooth', osc2Semi: 0, osc2Detune: 9, oscMix: 0.5, subLevel: 0,
    cutoffHz: 850, resonance: 2, filterEnv: 2.4, keyTrack: 0.5,
    ampAttackMs: 20, ampDecayMs: 350, ampSustain: 0.8, ampReleaseMs: 160,
    filtAttackMs: 60, filtDecayMs: 350, filtSustain: 0.45, filtReleaseMs: 180,
    poly: 'poly', unison: 2, spreadCents: 12, vibRateHz: 5.2, vibDepth: 6, velFilter: 0.7, velAmp: 0.5, levelDb: 3
  });
  preset('strings', 'Strings', 'synth', {
    osc1Wave: 'sawtooth', osc2Wave: 'sawtooth', osc2Semi: 0, osc2Detune: 5, oscMix: 0.45, subLevel: 0,
    cutoffHz: 2800, resonance: 0.5, filterEnv: 0.6, keyTrack: 0.3,
    ampAttackMs: 280, ampDecayMs: 800, ampSustain: 0.9, ampReleaseMs: 700,
    filtAttackMs: 400, filtDecayMs: 900, filtSustain: 0.6, filtReleaseMs: 600,
    poly: 'poly', unison: 3, spreadCents: 16, vibRateHz: 5.2, vibDepth: 9, velFilter: 0.3, velAmp: 0.5, levelDb: 0.5
  });
  preset('e-piano', 'E-piano', 'fm', {
    ratio: 1, index: 2.2, indexDecayMs: 700, tine: 0.6,
    attackMs: 2, decayMs: 3500, sustain: 0.12, releaseMs: 380,
    brightVel: 0.7, tremDepth: 0.35, tremRateHz: 4.2
  });
  preset('bell', 'Bell', 'fm', {
    ratio: 3.5, index: 3.5, indexDecayMs: 2500, tine: 0,
    attackMs: 1, decayMs: 4500, sustain: 0, releaseMs: 2000,
    brightVel: 0.4, tremDepth: 0
  });
  preset('organ', 'Organ', 'organ', {
    draw16: 6, draw8: 8, draw4: 6, draw2: 4, perc: 0.5, rotary: 0.7, rotaryHz: 1.2
  });
  preset('drum-kit', 'Drum kit', 'drums', {
    kickTune: 0, kickDecayMs: 420, snareTone: 0.5, snareSnappy: 0.7, hatDecayMs: 80, hatTone: 0.55, tomTune: 0
  });
  preset('808-kit', '808 kit', 'drums', {
    kickTune: -2, kickDecayMs: 1100, snareTone: 0.35, snareSnappy: 0.55, hatDecayMs: 55, hatTone: 0.7, tomTune: -3
  });

  function copyPreset(x) {
    var p = {};
    Object.keys(x.p).forEach(function (k) { p[k] = x.p[k]; });
    return { id: x.id, name: x.name, type: x.type, p: p };
  }

  /** A copy of the preset with this id, or null. */
  function presetById(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return copyPreset(PRESETS[i]);
    return null;
  }

  /** The parameters an instrument {type, preset, p} plays with: p when given, else the preset's, else defaults. */
  function paramsOf(type, inst) {
    if (inst && inst.p && typeof inst.p === 'object') return clampParams(type, inst.p);
    var pr = inst && presetById(inst.preset);
    return clampParams(type, pr && pr.type === type ? pr.p : null);
  }

  // Drum lengths (seconds), shared by the voices and releaseOf().
  var CRASH = { 49: [0.15, 2.4], 57: [0.12, 2] }, RIDE = [0.05, 1.8], COWBELL = [0.025, 0.33];
  var TOMS = { 41: [80, 0.55], 43: [95, 0.5], 45: [110, 0.46], 47: [130, 0.42], 48: [150, 0.38], 50: [175, 0.34] };

  function openHatSec(p) { return Math.min(2, p.hatDecayMs / 1000 * 6 + 0.12); }

  /**
   * Seconds an instrument {type, p} keeps sounding after a note's end: the
   * release, the rotary delay, or for drums the longest hit. No audio
   * context needed; the engine sizes export tails with it.
   */
  function releaseOf(inst) {
    var type = typeOf(inst && inst.type), p = paramsOf(type, inst);
    if (type === 'synth') return p.ampReleaseMs / 1000 + 0.01;
    if (type === 'fm') return p.releaseMs / 1000 + 0.01;
    if (type === 'organ') return ORGAN_RELEASE + ROTARY_DELAY + ROTARY_MOD + 0.01;
    return Math.max(0.03 + p.kickDecayMs / 1000, 0.001 + CRASH[49][0] + CRASH[49][1], openHatSec(p), 0.6) + 0.01;
  }

  // ------------------------------------------------- per-context caches ---

  var caches = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function cacheOf(ctx) {
    var c = caches && caches.get(ctx);
    if (!c) {
      c = { noise: null, waves: {}, organ: [], wake: {} };
      if (caches) caches.set(ctx, c);
    }
    return c;
  }

  function quiet(promise) { if (promise && promise.then) promise.then(null, function () { /* not suspended */ }); }

  /**
   * Runs fn while an OfflineAudioContext is paused at `frame` (a render
   * quantum boundary). Calls for the same frame share one pause; when
   * someone else already pauses there (the export's progress report), the
   * next quantum is used.
   */
  function atFrame(ctx, frame, fn) {
    var w = cacheOf(ctx).wake;
    if (w[frame]) { w[frame].push(fn); return; }
    var fns = (w[frame] = [fn]), p = null;
    function run() {
      delete w[frame];
      fns.forEach(function (f) { f(); });
    }
    try { p = ctx.suspend(frame / ctx.sampleRate); } catch (e) { p = null; }
    if (!p || !p.then) { run(); return; }
    p.then(function () {
      try { run(); } finally { quiet(ctx.resume()); }
    }, function () {
      delete w[frame];
      var next = frame + QUANTUM;
      fns.forEach(function (f) {
        if (next < ctx.length && next > ctx.currentTime * ctx.sampleRate) atFrame(ctx, next, f);
        else f();
      });
    });
  }

  /** Two seconds of white noise from a seeded generator, made once per context. */
  function noiseBuffer(ctx) {
    var c = cacheOf(ctx);
    if (!c.noise) {
      var len = Math.round(ctx.sampleRate * NOISE_SEC), buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0), seed = 0x6d2b79f5;
      for (var i = 0; i < len; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        d[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
      }
      c.noise = buf;
    }
    return c.noise;
  }

  // Oscillators start at one of 8 phases (eighths of a cycle), turning from
  // voice to voice and layer to layer, so the notes of a chord and the layers
  // of a unison sound don't all start in step (which would stack their peaks).
  var PHASE_STEPS = 8;

  function waveCoef(type, n) {
    if (type === 'sine') return n === 1 ? 1 : 0;
    if (type === 'sawtooth') return 2 / (Math.PI * n) * (n % 2 ? 1 : -1);
    if (n % 2 === 0) return 0;
    if (type === 'square') return 4 / (Math.PI * n);
    return 8 / (Math.PI * Math.PI * n * n) * ((n - 1) / 2 % 2 ? -1 : 1);
  }

  /** The standard waveform `type`, started `phase` eighths of a cycle in. Cached per context. */
  function oscWave(ctx, type, phase) {
    phase = ((phase % PHASE_STEPS) + PHASE_STEPS) % PHASE_STEPS;
    var c = cacheOf(ctx), key = type + ':' + phase;
    if (!c.waves[key]) {
      var h = type === 'sine' ? 1 : HARMONICS, re = new Float32Array(h + 1), im = new Float32Array(h + 1);
      var ph = 2 * Math.PI * phase / PHASE_STEPS;
      for (var n = 1; n <= h; n++) {
        var b = waveCoef(type, n);
        re[n] = b * Math.sin(n * ph);
        im[n] = b * Math.cos(n * ph);
      }
      c.waves[key] = ctx.createPeriodicWave(re, im);
    }
    return c.waves[key];
  }

  function drawbarGain(d) { return d > 0 ? Math.pow(10, -3 * (8 - d) / 20) : 0; }

  var ORGAN_PHASES = [0, 3, 5, 6]; // eighths of the 16' cycle; one of four per note

  /** The organ's tone wheel mix as one wave at the 16' pitch, and its loudness normalization. */
  function organWave(ctx, p, variant) {
    var c = cacheOf(ctx), key = [p.draw16, p.draw8, p.draw4, p.draw2, variant % 4].join(',');
    for (var i = 0; i < c.organ.length; i++) if (c.organ[i].key === key) return c.organ[i];
    var amps = [drawbarGain(p.draw16), drawbarGain(p.draw8), drawbarGain(p.draw4), drawbarGain(p.draw2)];
    var re = new Float32Array(9), im = new Float32Array(9), ph = 2 * Math.PI * ORGAN_PHASES[variant % 4] / PHASE_STEPS;
    [1, 2, 4, 8].forEach(function (h, j) { re[h] = amps[j] * Math.sin(h * ph); im[h] = amps[j] * Math.cos(h * ph); });
    var power = amps[0] * amps[0] + amps[1] * amps[1] + amps[2] * amps[2] + amps[3] * amps[3];
    var entry = { key: key, wave: ctx.createPeriodicWave(re, im, { disableNormalization: true }), norm: 1 / Math.max(0.5, Math.sqrt(power)) };
    c.organ.push(entry);
    if (c.organ.length > 16) c.organ.shift();
    return entry;
  }

  var clipCurveCache = null;

  /** The soft ceiling's curve (see KNEE and CEILING). */
  function clipCurve() {
    if (!clipCurveCache) {
      var n = 4097, w = CEILING - KNEE;
      clipCurveCache = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = (i / (n - 1) * 2 - 1) * CLIP_RANGE, a = Math.abs(x);
        var y = a <= KNEE ? a : KNEE + w * tanh((a - KNEE) / w);
        clipCurveCache[i] = x < 0 ? -y : y;
      }
    }
    return clipCurveCache;
  }

  // ---------------------------------------------------------- envelopes ---

  /** Schedules breakpoints `rel` (from time t0) on every param, times `scale`. */
  function envNew(params, scale, rel, t0) {
    var env = { params: params, scale: scale, pts: rel.map(function (q) { return { t: t0 + q.t, v: q.v }; }) };
    params.forEach(function (prm) {
      var pts = env.pts;
      prm.setValueAtTime(pts[0].v * scale, pts[0].t);
      for (var i = 1; i < pts.length; i++) prm.linearRampToValueAtTime(pts[i].v * scale, pts[i].t);
    });
    return env;
  }

  /**
   * Replaces what an envelope does from time t on with `tail` (absolute
   * breakpoints), starting from the exact level it has at t. Uses
   * cancelAndHoldAtTime where the browser has it; otherwise cancels and
   * redraws the segment that was running, which gives the same line.
   */
  function envRetime(env, t, tail) {
    var level = envelopeAt(env.pts, t), last = env.pts[env.pts.length - 1];
    env.params.forEach(function (prm) {
      if (prm.cancelAndHoldAtTime) prm.cancelAndHoldAtTime(t);
      else {
        prm.cancelScheduledValues(t);
        if (t > env.pts[0].t && t < last.t) prm.linearRampToValueAtTime(level * env.scale, t);
      }
      prm.setValueAtTime(level * env.scale, t);
      tail.forEach(function (q) { prm.linearRampToValueAtTime(q.v * env.scale, q.t); });
    });
    env.pts = env.pts.filter(function (q) { return q.t < t; }).concat([{ t: t, v: level }], tail);
    return level;
  }

  // ------------------------------------------------------- instruments ---

  function biquad(ctx, type, freq, q, gainDb) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(freq, ctx.sampleRate * 0.45);
    f.Q.value = q;
    if (gainDb) f.gain.value = gainDb;
    return f;
  }

  /**
   * These params update once per 128-sample block instead of every sample:
   * a slow filter sweep or a vibrato sounds the same, and a swept filter
   * costs a fraction as much. Fast envelopes stay per-sample, since one big
   * step in a filter's coefficients makes it overshoot. (Browsers without
   * automationRate ignore this.)
   */
  function blockRate(params) {
    params.forEach(function (prm) { try { if (prm.automationRate) prm.automationRate = 'k-rate'; } catch (e) { /* fixed rate */ } });
  }

  /**
   * An instrument for inst = {type, preset?, p} on `ctx`, connected to
   * `output` (default: the speakers). See the top of the file for its methods.
   */
  function createInstrument(ctx, inst, output) {
    var type = typeOf(inst && inst.type);
    var I = {
      ctx: ctx, type: type, p: paramsOf(type, inst),
      all: {},        // id -> voice, until the voice has ended and been disconnected
      poly: [],       // voices that may still sound at the time being scheduled
      held: {},       // pitch -> voices held by noteOn (poly)
      keys: [],       // keys held, in order (mono)
      queue: [],      // offline: notes not built yet, by time
      wakes: {},      // offline: frames where the render pauses to build them
      count: 0, seq: 0, seed: 0x2545f491, disposed: false
    };
    var lazy = isOffline(ctx) && typeof ctx.suspend === 'function';
    var bus = (I.bus = ctx.createGain()), level = ctx.createGain(), shaper = ctx.createWaveShaper(), out = ctx.createGain();
    bus.channelCount = 2;
    bus.channelCountMode = 'explicit';
    bus.channelInterpretation = 'speakers';
    level.gain.value = dbGain(I.p.levelDb) / CLIP_RANGE;
    shaper.curve = clipCurve();
    shaper.oversample = 'none';
    var post = POSTS[type] ? POSTS[type](ctx, bus, level, I.p) : null;
    if (!post) bus.connect(level);
    level.connect(shaper);
    shaper.connect(out);
    out.connect(output || ctx.destination);

    I.rand = function () {
      var s = I.seed;
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      I.seed = s;
      return (s >>> 0) / 4294967296;
    };

    function when(time) {
      var now = ctx.currentTime;
      return typeof time === 'number' && isFinite(time) && time > now ? time : now;
    }
    function pitchOf(pitch) { return typeof pitch === 'number' && isFinite(pitch) ? clamp(pitch, 0, 127) : null; }
    function velOf(vel) { return clamp(num(vel, 100), 1, 127); }
    function isMono() { return I.type === 'synth' && I.p.poly === 'mono'; }

    // ---- voice bookkeeping

    function finish(v) {
      if (v.done) return;
      v.done = true;
      v.srcs[0].onended = null;
      v.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* already */ } });
      if (I.all[v.id]) { delete I.all[v.id]; I.count--; }
    }

    function stopSrc(v, i, at) {
      try { v.srcs[i].stop(at); v.stops[i] = at; } catch (e) { /* already stopped */ }
    }

    /** Stops the voice's sources when its envelope is over (extend: also later than before). */
    function setStop(v, end, extend) {
      var at = end + STOP_PAD;
      for (var i = 0; i < v.srcs.length; i++) {
        if (at < v.stops[i] || (extend && v.follow[i] && at < Infinity)) stopSrc(v, i, at);
      }
    }

    /** A note that hasn't started yet: never let it start. */
    function drop(v) {
      for (var i = 0; i < v.srcs.length; i++) if (v.start < v.stops[i]) stopSrc(v, i, v.start);
      finish(v);
    }

    /** Fades a voice to silence over `len` seconds from time t (steal, choke, stop). */
    function fade(v, t, len) {
      if (v.done || v.end <= t + len) return;
      if (v.start >= t) { drop(v); return; }
      envRetime(v.amp, t, [{ t: t + len, v: 0 }]);
      v.relStart = Math.min(v.relStart, t);
      v.end = t + len;
      v.stolen = true;
      setStop(v, v.end);
    }

    /** Starts the voice's release at time t (note off). */
    function release(v, t) {
      if (v.done || t >= v.relStart || t >= v.end) return;
      if (t <= v.start) { drop(v); return; }
      var lvl = envelopeAt(v.amp.pts, t);
      envRetime(v.amp, t, releasePoints(lvl, v.release, t));
      if (v.filt) envRetime(v.filt, t, releasePoints(envelopeAt(v.filt.pts, t), v.filtRelease, t));
      v.relStart = t;
      v.end = lvl > 0 ? t + v.release : t;
      setStop(v, v.end);
    }

    function extendEnv(env, t, rel, t0) {
      var tail = [];
      rel.forEach(function (q) { if (t0 + q.t > t) tail.push({ t: t0 + q.t, v: q.v }); });
      envRetime(env, t, tail);
    }

    /** Mono legato: the sounding voice glides to `pitch` and holds on for the new note. */
    function legato(v, pitch, t, dur) {
      envRetime(v.bend, t, [{ t: t + Math.max(0.001, I.p.glideMs / 1000), v: (pitch - v.basePitch) * 100 }]);
      var length = dur === Infinity ? Infinity : t + dur - v.start;
      extendEnv(v.amp, t, adsrPoints(v.adsr, length), v.start);
      if (v.filt) extendEnv(v.filt, t, adsrPoints(v.fadsr, length), v.start);
      v.pitch = pitch;
      var last = v.amp.pts[v.amp.pts.length - 1];
      v.end = last.v === 0 ? last.t : Infinity;
      v.relStart = Math.min(dur === Infinity ? Infinity : t + dur, v.end);
      if (v.end < Infinity) setStop(v, v.end, true);
    }

    function prune(t) {
      if (I.poly.length) I.poly = I.poly.filter(function (v) { return !v.done && v.end > t; });
    }

    /** Steals the oldest voices so a new one at time t stays within MAX_VOICES. */
    function makeRoom(t) {
      var on = I.poly.filter(function (v) { return v.start <= t && v.end > t && !v.stolen; });
      while (on.length >= MAX_VOICES) {
        var k = 0;
        for (var i = 1; i < on.length; i++) if (on[i].start < on[k].start) k = i;
        fade(on[k], t, STEAL_FADE);
        on.splice(k, 1);
      }
    }

    /** The mono voice sounding at time t, if any. */
    function monoVoice(t) {
      var cur = null;
      I.poly.forEach(function (v) {
        if (!v.done && !v.stolen && v.start <= t && v.end > t && (!cur || v.start >= cur.start)) cur = v;
      });
      return cur;
    }

    function newVoice(pitch, vel, t) {
      var out = ctx.createGain();
      out.gain.value = 0;
      out.connect(I.bus);
      return {
        id: ++I.seq, pitch: pitch, vel: vel, start: t, relStart: Infinity, end: Infinity,
        out: out, srcs: [], stops: [], follow: [], nodes: [out], amp: null, filt: null, bend: null,
        done: false, stolen: false
      };
    }

    function launch(v, dur) {
      var last = v.amp.pts[v.amp.pts.length - 1];
      v.end = v.oneShot ? v.start + v.oneShot : last.v === 0 ? last.t : Infinity;
      v.relStart = Math.min(dur === Infinity ? Infinity : v.start + dur, v.end);
      if (v.end < Infinity) setStop(v, v.end);
      v.srcs[0].onended = function () { finish(v); };
      I.all[v.id] = v;
      I.count++;
      I.poly.push(v);
      return v;
    }

    function startNote(pitch, vel, t, dur) {
      prune(t);
      if (I.type === 'drums') return drumHit(pitch, vel, t);
      if (isMono()) {
        var cur = monoVoice(t);
        if (cur && cur.bend && I.p.glideMs > 0 && cur.relStart > t && (dur < Infinity || cur.relStart === Infinity)) {
          legato(cur, pitch, t, dur);
          return cur;
        }
        if (cur) fade(cur, t, STEAL_FADE);
      }
      makeRoom(t);
      var v = newVoice(pitch, vel, t);
      BUILDERS[I.type](I, v, I.p, dur);
      return launch(v, dur);
    }

    // ---- keyboard

    function keyDown(n, vel, t) {
      if (I.type === 'drums') return startNote(n, vel, t, 0);
      if (isMono()) {
        var i = I.keys.indexOf(n);
        if (i >= 0) I.keys.splice(i, 1);
        I.keys.push(n);
        return startNote(n, vel, t, Infinity);
      }
      var v = startNote(n, vel, t, Infinity);
      if (v) (I.held[n] = I.held[n] || []).push(v);
      return v;
    }

    function keyUp(n, t) {
      if (isMono()) {
        var i = I.keys.indexOf(n);
        if (i < 0) return;
        I.keys.splice(i, 1);
        var cur = monoVoice(t);
        if (!cur || cur.pitch !== n || cur.relStart !== Infinity) return;
        if (I.keys.length) {
          // Back to the key still held: glide there, or play it again.
          var back = I.keys[I.keys.length - 1];
          if (cur.bend && I.p.glideMs > 0) legato(cur, back, t, Infinity);
          else startNote(back, cur.vel, t, Infinity);
        } else release(cur, t);
        return;
      }
      var list = I.held[n];
      if (!list || !list.length) return;
      release(list.shift(), t);
      if (!list.length) delete I.held[n];
    }

    // ---- offline queue

    /** Runs fn(t) now, or (offline, for a far-off time) shortly before t. */
    function at(t, fn) {
      if (!lazy || t < ctx.currentTime + BUILD_AHEAD) return fn(t);
      var c = { t: t, fn: fn, stopAt: Infinity }, i = I.queue.length;
      while (i > 0 && I.queue[i - 1].t > t) i--;
      I.queue.splice(i, 0, c);
      plan();
    }

    function pump() {
      if (I.disposed) { I.queue = []; return; }
      var horizon = ctx.currentTime + BUILD_AHEAD;
      while (I.queue.length && I.queue[0].t < horizon) {
        var c = I.queue.shift(), v = c.fn(c.t);
        if (v && v.amp && c.stopAt < Infinity) fade(v, c.stopAt, STOP_FADE);
      }
      plan();
    }

    function plan() {
      if (!I.queue.length) return;
      var frame = Math.floor((I.queue[0].t - BUILD_AHEAD / 2) * ctx.sampleRate / QUANTUM) * QUANTUM;
      if (frame >= ctx.length) { I.queue = []; return; } // starts after the render ends
      if (I.wakes[frame]) return;
      I.wakes[frame] = true;
      atFrame(ctx, frame, function () { delete I.wakes[frame]; pump(); });
    }

    // ---- drums

    function drumHit(pitch, vel, t) {
      var n = Math.round(pitch), make = has(DRUMS, n) ? DRUMS[n] : null;
      if (!make) return null;
      if (n === 42 || n === 44) {
        I.poly.forEach(function (o) { if (o.choke === 'open' && o.start < t) fade(o, t, CHOKE_FADE); });
      }
      makeRoom(t);
      var v = newVoice(n, vel, t);
      v.amp = envNew([v.out.gain], 1, [{ t: 0, v: 1 }], t);
      v.oneShot = make(I, v, I.p, n, velocityGain(vel, DRUM_VEL));
      launch(v, 0); // a one-shot: note-off does nothing
      if (n === 46) {
        // A closed hat already scheduled later cuts this one.
        var cut = Infinity;
        I.poly.forEach(function (o) { if (o.choke === 'closed' && o.start > t && o.start < cut) cut = o.start; });
        if (cut < Infinity) fade(v, cut, CHOKE_FADE);
      }
      return v;
    }

    // ---- the instance

    var api = {
      type: type,
      output: out,

      /** Schedules a whole note: pitch 0..127, velocity 1..127, at ctx time `time`, released after `duration` s. */
      play: function (pitch, velocity, time, duration) {
        var n = pitchOf(pitch), vel = velOf(velocity), d = Math.max(0.005, num(duration, 0.25));
        if (I.disposed || n === null) return;
        at(when(time), function (t) { return startNote(n, vel, t, d); });
      },

      noteOn: function (pitch, velocity, time) {
        var n = pitchOf(pitch), vel = velOf(velocity);
        if (I.disposed || n === null) return;
        at(when(time), function (t) { return keyDown(n, vel, t); });
      },

      noteOff: function (pitch, time) {
        var n = pitchOf(pitch);
        if (I.disposed || n === null || I.type === 'drums') return;
        at(when(time), function (t) { keyUp(n, t); });
      },

      /** Fast fade of everything sounding at `time`; notes due to start later are cancelled. */
      stopAll: function (time) {
        var t = when(time);
        Object.keys(I.all).forEach(function (id) { if (I.all[id]) fade(I.all[id], t, STOP_FADE); });
        I.queue = I.queue.filter(function (c) { c.stopAt = Math.min(c.stopAt, t); return c.t < t; });
        I.held = {};
        I.keys = [];
      },

      /** New settings: new notes use them; level, cutoff and resonance also move on sounding notes. */
      set: function (next) {
        if (I.disposed) return;
        var t = typeOf(next && next.type);
        if (t !== I.type) {
          // The engine rebuilds on a type change; this keeps a stray call safe.
          api.stopAll(ctx.currentTime);
          if (post) post.dispose(); else bus.disconnect();
          I.type = api.type = t;
          post = POSTS[t] ? POSTS[t](ctx, bus, level, paramsOf(t, next)) : null;
          if (!post) bus.connect(level);
        }
        var old = I.p, p = (I.p = paramsOf(t, next));
        if (p.levelDb !== old.levelDb) setParam(ctx, level.gain, dbGain(p.levelDb) / CLIP_RANGE);
        if (post) post.set(p, old);
        if (t === 'synth' && (p.cutoffHz !== old.cutoffHz || p.resonance !== old.resonance || p.keyTrack !== old.keyTrack || p.velFilter !== old.velFilter)) {
          var nyq = ctx.sampleRate / 2;
          I.poly.forEach(function (v) {
            if (v.done || !v.f1) return;
            var fc = cutoffFor(p, v.pitch, v.vel, nyq);
            setParam(ctx, v.f1.frequency, fc);
            setParam(ctx, v.f2.frequency, fc);
            setParam(ctx, v.f2.Q, p.resonance + BUTTERWORTH_Q_DB);
          });
        }
      },

      /** Seconds a note keeps sounding after its end (see releaseOf). */
      tail: function () { return releaseOf({ type: I.type, p: I.p }); },

      /** Voices not yet ended and disconnected, counting notes still queued. */
      active: function () { return I.count + I.queue.length; },

      dispose: function () {
        if (I.disposed) return;
        I.disposed = true;
        I.queue = [];
        var now = ctx.currentTime, live = !isOffline(ctx);
        if (live) out.gain.setTargetAtTime(0, now, 0.004);
        function cut() {
          Object.keys(I.all).forEach(function (id) {
            var v = I.all[id];
            for (var i = 0; i < v.srcs.length; i++) if (v.stops[i] > now + 0.03) stopSrc(v, i, Math.max(v.start, now + 0.03));
            finish(v);
          });
          I.poly = [];
          if (post) post.dispose();
          [bus, level, shaper, out].forEach(function (n) { n.disconnect(); });
        }
        if (live && typeof setTimeout === 'function') setTimeout(cut, 60);
        else cut();
      }
    };
    return api;
  }

  /** Starts source `src` for voice v at `when`; ownStop: stops then, else with the voice. */
  function addSrc(v, src, when, ownStop, offset) {
    if (offset) src.start(when, offset); else src.start(when);
    v.srcs.push(src);
    v.nodes.push(src);
    v.stops.push(Infinity);
    v.follow.push(ownStop == null);
    if (ownStop != null) {
      try { src.stop(ownStop); v.stops[v.stops.length - 1] = ownStop; } catch (e) { /* ignore */ }
    }
    return src;
  }

  function osc(I, v, type, freq) {
    var o = I.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  /**
   * A sine at `freq` whose phase follows a carrier started at `phase` eighths:
   * `ratio` x as far through its cycle, so FM keeps the same timbre on every note.
   */
  function sine(I, freq, phase, ratio) {
    var o = I.ctx.createOscillator(), x = phase / PHASE_STEPS * ratio;
    o.setPeriodicWave(oscWave(I.ctx, 'sine', Math.round((x - Math.floor(x)) * PHASE_STEPS)));
    o.frequency.value = freq;
    return o;
  }

  function noiseSrc(I, v, ownStop) {
    var s = I.ctx.createBufferSource();
    s.buffer = noiseBuffer(I.ctx);
    s.loop = true;
    return addSrc(v, s, v.start, ownStop, 0.01 + I.rand() * (NOISE_SEC - 0.1));
  }

  /** src -> chain of nodes -> gain with breakpoints `rel` x scale -> the voice. */
  function part(I, v, src, chain, rel, scale) {
    var g = I.ctx.createGain(), prev = src;
    g.gain.value = 0;
    chain.forEach(function (n) { prev.connect(n); prev = n; v.nodes.push(n); });
    prev.connect(g);
    g.connect(v.out);
    v.nodes.push(g);
    envNew([g.gain], scale, rel, v.start);
    return g;
  }

  function mixer(I, v, gain) {
    var g = I.ctx.createGain();
    g.gain.value = gain;
    v.nodes.push(g);
    return g;
  }

  // ----------------------------------------------------- synth voices ---

  /** Filter cutoff for a note: the knob, key tracking and velocity. */
  function cutoffFor(p, pitch, vel, nyq) {
    var oct = p.keyTrack * (pitch - 60) / 12 + p.velFilter * 2 * (vel / 127 - 1);
    return clamp(p.cutoffHz * Math.pow(2, oct), 20, nyq * 0.98);
  }

  /** Resonance makes the filter ring louder; pull the voice back so it stays in level. */
  function resonanceTrim(res) { return 1 / (1 + res / 10); }

  function layer(I, v, wave, phase, f, cents, dest, pitchParams) {
    var o = I.ctx.createOscillator();
    o.setPeriodicWave(oscWave(I.ctx, wave, phase));
    o.frequency.value = f;
    o.detune.value = cents;
    o.connect(dest);
    addSrc(v, o, v.start);
    pitchParams.push(o.detune);
  }

  /**
   * Subtractive voice: two oscillators (x unison layers spread in pitch and
   * stereo) and a sub, through a 24 dB/oct low-pass whose envelope moves
   * the filters' detune (so the cutoff knob can still move smoothly), into
   * the amp envelope.
   */
  function synthVoice(I, v, p, dur) {
    var ctx = I.ctx, f = midiHz(v.pitch), nyq = ctx.sampleRate / 2, vn = v.vel / 127;
    var f1 = biquad(ctx, 'lowpass', nyq, BUTTERWORTH_Q_DB), f2 = biquad(ctx, 'lowpass', nyq, p.resonance + BUTTERWORTH_Q_DB);
    var fc = cutoffFor(p, v.pitch, v.vel, nyq), cents = p.filterEnv * 1200 * (1 - p.velFilter * (1 - vn));
    var fadsr = { attack: p.filtAttackMs / 1000, decay: p.filtDecayMs / 1000, sustain: p.filtSustain, release: p.filtReleaseMs / 1000 };
    // The envelope's steepest move in one block, in octaves: per-sample if over a semitone.
    var step = cents / 1200 * QUANTUM / ctx.sampleRate * Math.max(1 / fadsr.attack, 4.6 * (1 - fadsr.sustain) / fadsr.decay, 5 / fadsr.release);
    f1.frequency.value = f2.frequency.value = fc;
    blockRate([f1.frequency, f1.Q, f2.frequency, f2.Q]);
    if (step <= 1 / 12) blockRate([f1.detune, f2.detune]);
    f1.connect(f2);
    f2.connect(v.out);
    v.nodes.push(f1, f2);
    v.f1 = f1;
    v.f2 = f2;
    var pitchParams = [], n = Math.round(p.unison), g1 = 1 - p.oscMix, g2 = p.oscMix, norm = UNISON_NORM[n];
    // Unison layers go left, right (alternately) or centre; each side has one
    // mix gain per oscillator and one panner, however many layers it holds.
    var gains = {}, pans = {};
    function sideMix(side, which, gain) {
      var key = side + which, dest = f1;
      if (!gains[key]) {
        if (side && !pans[side]) {
          pans[side] = ctx.createStereoPanner();
          pans[side].pan.value = 0.6 * side;
          pans[side].connect(f1);
          v.nodes.push(pans[side]);
        }
        if (side) dest = pans[side];
        gains[key] = mixer(I, v, gain * norm);
        gains[key].connect(dest);
      }
      return gains[key];
    }
    for (var i = 0; i < n; i++) {
      var off = n > 1 ? p.spreadCents * (i / (n - 1) - 0.5) : 0;
      var side = n === 1 ? 0 : n === 3 ? i - 1 : i % 2 ? 1 : -1;
      if (g1 > 0.001) layer(I, v, p.osc1Wave, v.id * 3 + i * 5, f, off, sideMix(side, 'a', g1), pitchParams);
      if (g2 > 0.001) layer(I, v, p.osc2Wave, v.id * 3 + i * 5 + 4, f, off + p.osc2Semi * 100 + p.osc2Detune, sideMix(side, 'b', g2), pitchParams);
    }
    if (p.subLevel > 0.001) {
      var sub = ctx.createOscillator(), sg = mixer(I, v, p.subLevel * SUB_GAIN);
      sub.setPeriodicWave(oscWave(ctx, 'sine', v.id * 3 + 2));
      sub.frequency.value = f / 2;
      sub.connect(sg);
      sg.connect(f1);
      addSrc(v, sub, v.start);
      pitchParams.push(sub.detune);
    }
    // Vibrato is slow enough for block rate; a mono glide (one voice) stays per-sample.
    if (p.vibDepth > 0 && !(p.poly === 'mono' && p.glideMs > 0)) blockRate(pitchParams);
    if (p.vibDepth > 0) {
      // Vibrato fades in, the way a player adds it.
      var lfo = osc(I, v, 'sine', p.vibRateHz), vg = mixer(I, v, 0);
      lfo.connect(vg);
      pitchParams.forEach(function (prm) { vg.connect(prm); });
      envNew([vg.gain], p.vibDepth, [{ t: 0, v: 0 }, { t: 0.15, v: 0 }, { t: 0.5, v: 1 }], v.start);
      addSrc(v, lfo, v.start);
    }
    if (p.poly === 'mono' && p.glideMs > 0 && ctx.createConstantSource) {
      var bend = ctx.createConstantSource();
      bend.offset.value = 0;
      pitchParams.forEach(function (prm) { bend.connect(prm); });
      v.bend = envNew([bend.offset], 1, [{ t: 0, v: 0 }], v.start);
      v.basePitch = v.pitch;
      addSrc(v, bend, v.start);
    }
    v.adsr = { attack: p.ampAttackMs / 1000, decay: p.ampDecayMs / 1000, sustain: p.ampSustain, release: p.ampReleaseMs / 1000 };
    v.release = v.adsr.release;
    v.amp = envNew([v.out.gain], SYNTH_GAIN * velocityGain(v.vel, p.velAmp) * resonanceTrim(p.resonance), adsrPoints(v.adsr, dur), v.start);
    if (cents > 0) {
      v.fadsr = fadsr;
      v.filtRelease = fadsr.release;
      v.filt = envNew([f1.detune, f2.detune], cents, adsrPoints(v.fadsr, dur), v.start);
    }
  }

  /**
   * Two-operator FM: a sine modulator at `ratio` x the note bends the
   * carrier's frequency by `index` x its own, decaying over `indexDecayMs`.
   * The tine is a short, high (14:1) modulator burst for an e-piano's ping.
   */
  function fmVoice(I, v, p, dur) {
    var ctx = I.ctx, f = midiHz(v.pitch), nyq = ctx.sampleRate / 2, vn = v.vel / 127, ph = (v.id * 3) % PHASE_STEPS;
    var car = sine(I, f, ph, 1);
    car.connect(v.out);
    addSrc(v, car, v.start);
    var bright = 1 - p.brightVel * (1 - vn), fm = f * p.ratio;
    // Keep the sidebands under Nyquist (Carson's rule) so high notes don't alias.
    var beta = Math.min(p.index * bright, (nyq * 0.9 - f) / fm - 1);
    if (beta > 0.01) {
      var mod = sine(I, fm, ph, p.ratio), mg = mixer(I, v, 0);
      mod.connect(mg);
      mg.connect(car.frequency);
      envNew([mg.gain], beta * fm, adsrPoints({ attack: 0.001, decay: p.indexDecayMs / 1000, sustain: INDEX_FLOOR }, Infinity), v.start);
      addSrc(v, mod, v.start);
    }
    var ft = f * TINE_RATIO, bt = Math.min(p.tine * TINE_INDEX * bright, (nyq * 0.9 - f) / ft - 1);
    if (bt > 0.01) {
      var tine = sine(I, ft, ph, TINE_RATIO), tg = mixer(I, v, 0);
      tine.connect(tg);
      tg.connect(car.frequency);
      envNew([tg.gain], bt * ft, hitPoints(0.0005, 0, TINE_DECAY), v.start);
      addSrc(v, tine, v.start, v.start + TINE_DECAY + 0.002);
    }
    v.adsr = { attack: p.attackMs / 1000, decay: p.decayMs / 1000, sustain: p.sustain, release: p.releaseMs / 1000 };
    v.release = v.adsr.release;
    v.amp = envNew([v.out.gain], FM_GAIN * velocityGain(v.vel, 0.5), adsrPoints(v.adsr, dur), v.start);
  }

  /** Drawbar organ: one wave holding the four drawbars, a percussion harmonic and a key click. Like a tonewheel organ, it ignores velocity. */
  function organVoice(I, v, p, dur) {
    var ctx = I.ctx, f = midiHz(v.pitch), w = organWave(ctx, p, v.id), nyq = ctx.sampleRate / 2;
    var o = I.ctx.createOscillator(), body = mixer(I, v, w.norm);
    o.setPeriodicWave(w.wave);
    o.frequency.value = f / 2;
    o.connect(body);
    body.connect(v.out);
    addSrc(v, o, v.start);
    if (p.perc > 0 && f * 3 < nyq * 0.9) {
      var po = osc(I, v, 'sine', f * 3);
      part(I, v, po, [], hitPoints(0.001, 0, PERC_DECAY), p.perc * 0.9);
      addSrc(v, po, v.start, v.start + PERC_DECAY + 0.002);
      var click = noiseSrc(I, v, v.start + 0.008);
      part(I, v, click, [biquad(ctx, 'bandpass', 2500, 0.7)], [{ t: 0, v: 0 }, { t: 0.0005, v: 1 }, { t: 0.006, v: 0 }], p.perc * 0.5);
    }
    v.adsr = { attack: 0.005, decay: 0.001, sustain: 1, release: ORGAN_RELEASE };
    v.release = ORGAN_RELEASE;
    v.amp = envNew([v.out.gain], ORGAN_GAIN, adsrPoints(v.adsr, dur), v.start);
  }

  var BUILDERS = { synth: synthVoice, fm: fmVoice, organ: organVoice };

  // ------------------------------------------------------ drum sounds ---
  // Each takes (instrument, voice, params, note, velocity gain), adds its
  // parts to the voice and returns how long the hit lasts in seconds.

  var METAL = [205.3, 304.4, 369.6, 522.7, 540, 800]; // the TR-808's six square oscillators

  function metal(I, v, scale, gain) {
    var m = mixer(I, v, gain / METAL.length);
    METAL.forEach(function (hz) {
      var o = osc(I, v, 'square', hz * scale);
      o.connect(m);
      addSrc(v, o, v.start);
    });
    return m;
  }

  function kick(I, v, p, n, vg) {
    var t = v.start, f0 = 50 * Math.pow(2, p.kickTune / 12) * (n === 35 ? 0.9 : 1), dec = p.kickDecayMs / 1000;
    var o = osc(I, v, 'sine', f0);
    o.frequency.setValueAtTime(f0 * 8, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.8, t + 0.012);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.1);
    addSrc(v, o, t);
    part(I, v, o, [], hitPoints(0.001, 0.025, dec), 0.4 * vg);
    // The beater: a 7 ms burst of bright noise.
    var click = noiseSrc(I, v, t + 0.01);
    part(I, v, click, [biquad(I.ctx, 'bandpass', 3000, 0.6)], [{ t: 0, v: 0 }, { t: 0.0003, v: 1 }, { t: 0.002, v: 0.45 }, { t: 0.007, v: 0 }], 0.8 * vg);
    return 0.026 + dec;
  }

  function snare(I, v, p, n, vg) {
    var t = v.start, tone = p.snareTone, snap = p.snareSnappy, ctx = I.ctx;
    var fb = (n === 40 ? 200 : 180) * Math.pow(2, (tone - 0.5) * 0.7);
    var body = mixer(I, v, 1), bodyDec = 0.08 + 0.1 * (1 - tone);
    [1, 1.62].forEach(function (r, i) {
      var o = osc(I, v, i ? 'sine' : 'triangle', fb * r);
      o.frequency.setValueAtTime(fb * r * 1.35, t);
      o.frequency.exponentialRampToValueAtTime(fb * r, t + 0.025);
      o.connect(body);
      addSrc(v, o, t);
    });
    part(I, v, body, [], hitPoints(0.0008, 0.004, bodyDec), 0.3 * vg * (1.1 - 0.4 * snap));
    var noiseDec = 0.1 + 0.22 * snap;
    var ns = noiseSrc(I, v);
    part(I, v, ns, [biquad(ctx, 'highpass', 900 + 1800 * tone, 0.5), biquad(ctx, 'peaking', 4500, 0.8, 5), biquad(ctx, 'lowpass', 7000 + 6000 * tone, BUTTERWORTH_Q_DB)],
      hitPoints(0.0008, 0.006, noiseDec), 0.32 * vg * (0.35 + 0.65 * snap));
    return 0.007 + Math.max(bodyDec, noiseDec);
  }

  function clap(I, v, p, n, vg) {
    var pts = [{ t: 0, v: 0 }], s, k;
    for (k = 0; k < 3; k++) {
      s = k * 0.0105;
      pts.push({ t: s + 0.0006, v: 1 }, { t: s + 0.0095, v: 0.12 });
    }
    s = 0.0315;
    pts.push({ t: s + 0.0006, v: 1 });
    for (k = 1; k <= DECAY_STEPS; k++) pts.push({ t: s + 0.0006 + 0.22 * k / DECAY_STEPS, v: decayShape(k / DECAY_STEPS) });
    var ns = noiseSrc(I, v);
    part(I, v, ns, [biquad(I.ctx, 'bandpass', 1150, 1.1), biquad(I.ctx, 'highpass', 600, 0.5)], pts, 0.6 * vg);
    return s + 0.0006 + 0.22;
  }

  function rim(I, v, p, n, vg) {
    var m = mixer(I, v, 0.5);
    [480, 1660].forEach(function (hz) {
      var o = osc(I, v, 'triangle', hz);
      o.connect(m);
      addSrc(v, o, v.start);
    });
    part(I, v, m, [biquad(I.ctx, 'highpass', 400, 0.7)], hitPoints(0.0003, 0, 0.045), 0.42 * vg);
    var ns = noiseSrc(I, v, v.start + 0.015);
    part(I, v, ns, [biquad(I.ctx, 'bandpass', 3500, 1)], hitPoints(0.0003, 0, 0.012), 0.18 * vg);
    return 0.046;
  }

  function hat(I, v, p, n, vg) {
    var ctx = I.ctx, open = n === 46, pedal = n === 44;
    var len = open ? openHatSec(p) : p.hatDecayMs / 1000 * (pedal ? 0.6 : 1);
    var hp = 5600 * Math.pow(2, p.hatTone);
    var m = metal(I, v, 1, 1);
    var ns = noiseSrc(I, v), ng = mixer(I, v, 0.45);
    ns.connect(ng);
    ng.connect(m);
    part(I, v, m, [biquad(ctx, 'highpass', hp, BUTTERWORTH_Q_DB), biquad(ctx, 'highpass', hp, BUTTERWORTH_Q_DB), biquad(ctx, 'peaking', hp * 1.3, 1.2, 5)],
      hitPoints(0.0005, open ? 0.01 : 0.002, len), 2 * vg * (pedal ? 0.7 : 1));
    v.choke = open ? 'open' : 'closed';
    return 0.0005 + (open ? 0.01 : 0.002) + len;
  }

  function crash(I, v, p, n, vg) {
    var ctx = I.ctx, c = CRASH[n], m = metal(I, v, n === 57 ? 1.07 : 1, 1);
    var ns = noiseSrc(I, v), ng = mixer(I, v, 0.8);
    ns.connect(ng);
    ng.connect(m);
    part(I, v, m, [biquad(ctx, 'highpass', 4200, BUTTERWORTH_Q_DB), biquad(ctx, 'highpass', 4200, BUTTERWORTH_Q_DB)], twoStage(0.001, 0.45, c[0], c[1]), 1.2 * vg);
    return 0.001 + c[0] + c[1];
  }

  function ride(I, v, p, n, vg) {
    var ctx = I.ctx, m = metal(I, v, n === 59 ? 1.38 : 1.5, 1);
    var ns = noiseSrc(I, v), ng = mixer(I, v, 0.2);
    ns.connect(ng);
    ng.connect(m);
    part(I, v, m, [biquad(ctx, 'bandpass', 6000, 1.2), biquad(ctx, 'highpass', 3000, BUTTERWORTH_Q_DB)], twoStage(0.001, 0.5, RIDE[0], RIDE[1]), 1.8 * vg);
    return 0.001 + RIDE[0] + RIDE[1];
  }

  function cowbell(I, v, p, n, vg) {
    var m = mixer(I, v, 0.5);
    [540, 800].forEach(function (hz) {
      var o = osc(I, v, 'square', hz);
      o.connect(m);
      addSrc(v, o, v.start);
    });
    part(I, v, m, [biquad(I.ctx, 'bandpass', 900, 1.2), biquad(I.ctx, 'highpass', 450, 0.7)], twoStage(0.0008, 0.35, COWBELL[0], COWBELL[1]), 0.45 * vg);
    return 0.0008 + COWBELL[0] + COWBELL[1];
  }

  function tom(I, v, p, n, vg) {
    var t = v.start, d = TOMS[n], f0 = d[0] * Math.pow(2, p.tomTune / 12);
    var o = osc(I, v, 'sine', f0);
    o.frequency.setValueAtTime(f0 * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.1, t + 0.04);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.2);
    addSrc(v, o, t);
    part(I, v, o, [], hitPoints(0.001, 0.012, d[1]), 0.4 * vg);
    var ns = noiseSrc(I, v, t + 0.04);
    part(I, v, ns, [biquad(I.ctx, 'bandpass', 900 + f0 * 4, 0.8)], hitPoints(0.0005, 0, 0.03), 0.08 * vg);
    return 0.013 + d[1];
  }

  /** General MIDI drum map; notes not listed play nothing. */
  var DRUMS = {
    35: kick, 36: kick, 37: rim, 38: snare, 39: clap, 40: snare,
    41: tom, 42: hat, 43: tom, 44: hat, 45: tom, 46: hat, 47: tom, 48: tom, 50: tom,
    49: crash, 57: crash, 51: ride, 59: ride, 56: cowbell
  };

  // ------------------------------------------- per-instrument effects ---

  function lfoOsc(ctx, hz) {
    var o = ctx.createOscillator();
    o.frequency.value = hz;
    o.start(ctx.currentTime);
    return o;
  }

  /** FM: stereo tremolo, left and right swell in turn (an e-piano's auto-pan). Mono sums flat. */
  function tremoloPost(ctx, bus, dest, p) {
    bus.channelCount = 1;
    var gL = ctx.createGain(), gR = ctx.createGain(), merge = ctx.createChannelMerger(2);
    var lfo = lfoOsc(ctx, p.tremRateHz), dP = ctx.createGain(), dN = ctx.createGain();
    bus.connect(gL); bus.connect(gR);
    gL.connect(merge, 0, 0); gR.connect(merge, 0, 1);
    merge.connect(dest);
    lfo.connect(dP); lfo.connect(dN);
    dP.connect(gL.gain); dN.connect(gR.gain);
    var d = p.tremDepth / 2;
    gL.gain.value = gR.gain.value = 1 - d;
    dP.gain.value = d;
    dN.gain.value = -d;
    return {
      set: function (q, old) {
        if (q.tremRateHz !== old.tremRateHz) setParam(ctx, lfo.frequency, q.tremRateHz);
        if (q.tremDepth === old.tremDepth) return;
        var h = q.tremDepth / 2;
        setParam(ctx, gL.gain, 1 - h); setParam(ctx, gR.gain, 1 - h);
        setParam(ctx, dP.gain, h); setParam(ctx, dN.gain, -h);
      },
      dispose: function () {
        try { lfo.stop(); } catch (e) { /* ignore */ }
        [bus, gL, gR, merge, lfo, dP, dN].forEach(function (n) { n.disconnect(); });
        bus.channelCount = 2;
      }
    };
  }

  /** Organ: rotary-ish chorus, two short delays swept in opposite directions, panned apart. */
  function rotaryPost(ctx, bus, dest, p) {
    bus.channelCount = 1;
    var dry = ctx.createGain(), wet = ctx.createGain(), dL = ctx.createDelay(0.05), dR = ctx.createDelay(0.05);
    var pL = ctx.createStereoPanner(), pR = ctx.createStereoPanner();
    var lfo = lfoOsc(ctx, p.rotaryHz), mL = ctx.createGain(), mR = ctx.createGain();
    dL.delayTime.value = dR.delayTime.value = ROTARY_DELAY;
    pL.pan.value = -0.75;
    pR.pan.value = 0.75;
    bus.connect(dry); dry.connect(dest);
    bus.connect(dL); dL.connect(pL); pL.connect(wet);
    bus.connect(dR); dR.connect(pR); pR.connect(wet);
    wet.connect(dest);
    lfo.connect(mL); lfo.connect(mR);
    mL.connect(dL.delayTime); mR.connect(dR.delayTime);
    function levels(q, now) {
      var set = now ? function (prm, x) { prm.value = x; } : function (prm, x) { setParam(ctx, prm, x); };
      set(dry.gain, 1 - 0.4 * q.rotary);
      set(wet.gain, 0.75 * q.rotary);
      set(mL.gain, q.rotary * ROTARY_MOD);
      set(mR.gain, -q.rotary * ROTARY_MOD);
    }
    levels(p, true);
    return {
      set: function (q, old) {
        if (q.rotaryHz !== old.rotaryHz) setParam(ctx, lfo.frequency, q.rotaryHz);
        if (q.rotary !== old.rotary) levels(q, false);
      },
      dispose: function () {
        try { lfo.stop(); } catch (e) { /* ignore */ }
        [bus, dry, wet, dL, dR, pL, pR, lfo, mL, mR].forEach(function (n) { n.disconnect(); });
        bus.channelCount = 2;
      }
    };
  }

  var POSTS = { fm: tremoloPost, organ: rotaryPost };

  return {
    INSTRUMENTS: INSTRUMENTS,
    PRESETS: PRESETS,
    MAX_VOICES: MAX_VOICES,
    defaults: defaults,
    presetById: presetById,
    clampParams: clampParams,
    releaseOf: releaseOf,
    createInstrument: createInstrument,
    midiHz: midiHz,
    noteName: noteName,
    velocityGain: velocityGain,
    adsrPoints: adsrPoints,
    envelopeAt: envelopeAt
  };
});
;

// ---- js/studio/engine.js ----
/*
 * Stem to Stream Studio: audio engine (Web Audio).
 *
 * Each clip piece is an AudioBufferSourceNode with its own gain node (fades
 * and clip gain), feeding its track: track effects -> track gain (volume x
 * mute/solo) -> stereo pan -> master sum -> master effects -> master fader
 * -> limiter -> speakers. Instrument (MIDI) tracks have a synth from
 * S2S.studio.synth feeding the same track chain; their notes are scheduled
 * a little ahead while playing. Analysers tap every track and the master's
 * left and right channels for the meters. Export renders the same graph in
 * an OfflineAudioContext.
 */
(function () {
  'use strict';

  var S2S = window.S2S;
  var core = S2S.studio.core, fxLib = S2S.studio.fx;

  var LEAD = 0.06;          // seconds between pressing Play and the first sample
  var AHEAD = 1.5;          // loop passes are scheduled this far ahead
  var CLICK_AHEAD = 0.15;   // metronome lookahead
  var MIDI_AHEAD = 0.3;     // MIDI notes are scheduled this far ahead
  var TICK_MS = 25;

  function synthLib() { return S2S.studio.synth || null; }

  /**
   * The instrument settings a synth gets: the track's own values over its
   * preset's (a song may store only the preset), checked against the synth's ranges.
   */
  function instOf(t) {
    var lib = synthLib(), inst = t.inst || { type: 'synth', p: {} };
    if (!lib) return inst;
    var pr = inst.preset && lib.presetById(inst.preset), p = {};
    if (pr && pr.type === inst.type) Object.keys(pr.p || {}).forEach(function (k) { p[k] = pr.p[k]; });
    Object.keys(inst.p || {}).forEach(function (k) { p[k] = inst.p[k]; });
    return { type: inst.type, preset: inst.preset, p: lib.clampParams(inst.type, p) };
  }

  function makeInstrument(ctx, t, output) {
    var lib = synthLib();
    if (!lib || !core.isMidiTrack(t)) return null;
    try {
      return lib.createInstrument(ctx, instOf(t), output);
    } catch (e) {
      if (window.console) console.error(e);
      return null;
    }
  }

  /** Schedules one clip piece; returns {src, gain} or null when nothing would sound. */
  function schedulePiece(ctx, dest, seg, buffer, when) {
    var offset = Math.min(seg.offset, buffer.duration);
    var duration = Math.min(seg.duration, buffer.duration - offset);
    if (duration <= 0) return null;
    var src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    var pts = core.gainPoints(seg.clip, seg.inClip, seg.inClip + duration);
    gain.gain.setValueAtTime(pts[0].g, when);
    for (var i = 1; i < pts.length; i++) {
      gain.gain.linearRampToValueAtTime(pts[i].g, when + (pts[i].t - seg.inClip));
    }
    src.connect(gain);
    gain.connect(dest);
    src.start(when, offset, duration);
    return { src: src, gain: gain };
  }

  function peakOf(analyser, scratch) {
    analyser.getFloatTimeDomainData(scratch);
    var m = 0;
    for (var i = 0; i < scratch.length; i++) {
      var a = scratch[i] < 0 ? -scratch[i] : scratch[i];
      if (a > m) m = a;
    }
    return m;
  }

  function Engine() {
    this.ctx = null;
    this.tracks = {};
    this.voices = [];
    this.playing = false;
    this.metronome = false;
    this.anchor = null;
    this.loop = null;
    this.onEnded = null;
    this.timer = 0;
    this.workletOk = null; // null until the limiter's worklet has loaded (or failed to)
  }

  /** Signature of the effects that are switched on; a change means the chain is rebuilt. */
  function chainSig(list) {
    return list.filter(function (f) { return f.on; }).map(function (f) { return f.id + ':' + f.type; }).join(',');
  }

  /** Builds units for the effects that are on and wires input -> units -> output. */
  function buildChain(ctx, list, env, input, output) {
    var units = [], prev = input;
    list.forEach(function (f) {
      if (!f.on) return;
      var u = fxLib.createUnit(ctx, f, env);
      prev.connect(u.input);
      prev = u.output;
      units.push(u);
    });
    prev.connect(output);
    return units;
  }

  /** Creates the audio context on first use. Throws if the browser has no Web Audio. */
  Engine.prototype.ensure = function () {
    if (this.ctx) return this.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser has no Web Audio support. Use a current Chrome, Edge, Firefox or Safari.');
    var ctx = (this.ctx = new AC({ latencyHint: 'interactive' })), self = this;
    // Tracks -> master sum -> master effects -> master fader -> limiter -> out.
    this.masterSum = ctx.createGain();
    this.masterFader = ctx.createGain();
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    var split = ctx.createChannelSplitter(2);
    this.out.connect(split);
    this.meterL = ctx.createAnalyser();
    this.meterR = ctx.createAnalyser();
    this.meterL.fftSize = this.meterR.fftSize = 2048;
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
    this.masterUnits = [];
    this.limiter = null;
    this.masterSig = null;
    this.clickBus = ctx.createGain();
    this.clickBus.gain.value = 0.45;
    this.clickBus.connect(ctx.destination);
    this.scratch = new Float32Array(2048);
    fxLib.ensureWorklet(ctx).then(function (ok) {
      self.workletOk = ok;
      if (self.project) self.sync(self.project);
    });
    return ctx;
  };

  /** Decodes compressed audio (MP3, M4A, FLAC, OGG...) at the device sample rate. */
  Engine.prototype.decode = function (arrayBuffer) {
    var ctx = this.ensure();
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(arrayBuffer, resolve, function () {
        reject(new Error('The browser could not decode this audio file.'));
      });
      if (p && p.catch) p.catch(function () {}); // the callbacks above report the result
    });
  };

  /** Matches the audio graph to the song: track nodes, effect chains, master chain. */
  Engine.prototype.sync = function (p) {
    var ctx = this.ensure(), self = this, keep = {}, env = { bpm: p.bpm };
    this.project = p;
    p.tracks.forEach(function (t) {
      keep[t.id] = true;
      var n = self.tracks[t.id];
      if (!n) {
        n = self.tracks[t.id] = {
          sum: ctx.createGain(), vol: ctx.createGain(), pan: ctx.createStereoPanner(),
          meter: ctx.createAnalyser(), units: [], sig: null
        };
        n.meter.fftSize = 1024;
        n.vol.connect(n.pan);
        n.pan.connect(self.masterSum);
        n.pan.connect(n.meter);
      }
      var sig = chainSig(t.fx);
      if (sig !== n.sig) {
        n.sum.disconnect();
        n.units.forEach(function (u) { u.dispose(); });
        n.units = buildChain(ctx, t.fx, env, n.sum, n.vol);
        n.sig = sig;
      }
      var itype = core.isMidiTrack(t) ? t.inst.type : null;
      if (itype !== n.itype) {
        if (n.inst) n.inst.dispose();
        n.inst = makeInstrument(ctx, t, n.sum);
        n.itype = itype;
      }
    });
    Object.keys(this.tracks).forEach(function (id) {
      if (keep[id]) return;
      var n = self.tracks[id];
      if (n.inst) n.inst.dispose();
      n.sum.disconnect();
      n.units.forEach(function (u) { u.dispose(); });
      n.vol.disconnect();
      n.pan.disconnect();
      delete self.tracks[id];
    });
    var msig = chainSig(p.master.fx) + '|' + this.workletOk;
    if (msig !== this.masterSig) {
      this.masterSum.disconnect();
      this.masterUnits.forEach(function (u) { u.dispose(); });
      this.masterFader.disconnect();
      if (this.limiter) this.limiter.dispose();
      this.masterUnits = buildChain(ctx, p.master.fx, env, this.masterSum, this.masterFader);
      // Until the worklet has answered, play without a limiter rather than wait.
      this.limiter = this.workletOk === null ? null : fxLib.limiterUnit(ctx, p.master.limiter, this.workletOk);
      if (this.limiter) { this.masterFader.connect(this.limiter.input); this.limiter.output.connect(this.out); }
      else this.masterFader.connect(this.out);
      this.masterSig = msig;
    }
    this.applyMix(p);
    this.applyFx(p);
  };

  /** Volume, pan, mute/solo and master level, smoothed to avoid clicks. */
  Engine.prototype.applyMix = function (p) {
    if (!this.ctx) return;
    var now = this.ctx.currentTime, self = this;
    p.tracks.forEach(function (t) {
      var n = self.tracks[t.id];
      if (!n) return;
      n.vol.gain.setTargetAtTime(core.trackGain(p, t), now, 0.012);
      n.pan.pan.setTargetAtTime(t.pan, now, 0.012);
    });
    this.masterFader.gain.setTargetAtTime(core.dbToGain(p.masterDb), now, 0.012);
  };

  /** Pushes effect and limiter settings into the running units. */
  Engine.prototype.applyFx = function (p) {
    if (!this.ctx) return;
    var self = this, env = { bpm: p.bpm };
    function update(units, list) {
      units.forEach(function (u) {
        for (var i = 0; i < list.length; i++) if (list[i].id === u.id) { u.set(list[i], env); return; }
      });
    }
    p.tracks.forEach(function (t) {
      var n = self.tracks[t.id];
      if (!n) return;
      update(n.units, t.fx);
      if (n.inst && core.isMidiTrack(t)) n.inst.set(instOf(t));
    });
    update(this.masterUnits, p.master.fx);
    if (this.limiter) this.limiter.set(p.master.limiter);
  };

  /** True when the precise (worklet) limiter is running; false for the basic one; null while loading. */
  Engine.prototype.limiterMode = function () { return this.workletOk; };

  /** Starts playback of song `p` at position `pos` (seconds). Call from a click or key press. */
  Engine.prototype.play = function (p, buffers, pos) {
    var ctx = this.ensure();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    this.stopVoices();
    clearInterval(this.timer);
    this.project = p;
    this.buffers = buffers;
    this.sync(p);
    var t0 = ctx.currentTime + LEAD;
    this.anchor = { ctxTime: t0, pos: pos };
    this.loop = { on: p.loop.on, start: p.loop.start, end: p.loop.end };
    this.end = core.songEnd(p);
    this.playing = true;
    this.clickFrom = t0;
    this.midiFrom = t0;
    this.midiChase = true;
    if (core.loopActive(this.loop, pos)) {
      this.scheduleRange(pos, this.loop.end, t0);
      this.nextPass = t0 + (this.loop.end - pos);
    } else {
      this.scheduleRange(pos, Math.max(pos, this.end), t0);
      this.nextPass = Infinity;
    }
    this.timer = setInterval(this.tick.bind(this), TICK_MS);
    this.tick();
  };

  Engine.prototype.scheduleRange = function (from, to, when) {
    var self = this;
    core.planSegments(this.project, from, to).forEach(function (seg) {
      var n = self.tracks[seg.clip.trackId], buffer = self.buffers[seg.clip.sourceId];
      if (!n || !buffer) return;
      var v = schedulePiece(self.ctx, n.sum, seg, buffer, when + (seg.at - from));
      if (!v) return;
      self.voices.push(v);
      v.src.onended = function () {
        var i = self.voices.indexOf(v);
        if (i >= 0) self.voices.splice(i, 1);
        v.gain.disconnect();
      };
    });
  };

  Engine.prototype.tick = function () {
    if (!this.playing) return;
    var now = this.ctx.currentTime, len = this.loop.end - this.loop.start;
    while (this.nextPass < now + AHEAD) {
      this.scheduleRange(this.loop.start, this.loop.end, this.nextPass);
      this.nextPass += len;
    }
    if (this.metronome) this.scheduleClicks(Math.max(this.clickFrom, now), now + CLICK_AHEAD);
    this.clickFrom = Math.max(this.clickFrom, now + CLICK_AHEAD);
    if (now + MIDI_AHEAD > this.midiFrom) {
      this.scheduleMidi(this.midiFrom, now + MIDI_AHEAD);
      this.midiFrom = now + MIDI_AHEAD;
    }
    if (this.nextPass === Infinity && core.positionAt(this.anchor, this.loop, now) > this.end + 0.2) {
      var start = this.anchor.pos;
      this.stop();
      if (this.onEnded) this.onEnded(start);
    }
  };

  Engine.prototype.scheduleClicks = function (a, b) {
    var p = this.project, beat = core.beatSec(p), perBar = p.sig[0], self = this;
    core.transportPieces(this.anchor, this.loop, a, b).forEach(function (piece) {
      var posEnd = piece.pos + (piece.ctxEnd - piece.ctxStart);
      for (var k = Math.ceil((piece.pos - p.gridOffset) / beat - 1e-9); ; k++) {
        var at = p.gridOffset + k * beat;
        if (at >= posEnd - 1e-9) break;
        self.click(piece.ctxStart + (at - piece.pos), ((k % perBar) + perBar) % perBar === 0);
      }
    });
  };

  /** Schedules the MIDI notes for audio-clock time [a, b), following loop jumps. */
  Engine.prototype.scheduleMidi = function (a, b) {
    var p = this.project, self = this;
    if (!p.tracks.some(core.isMidiTrack)) return;
    var limit = core.loopActive(this.loop, this.anchor.pos) ? this.loop.end : Infinity;
    core.transportPieces(this.anchor, this.loop, a, b).forEach(function (piece) {
      var from = piece.pos, to = piece.pos + (piece.ctxEnd - piece.ctxStart);
      core.midiEvents(p, from, to, { chase: self.midiChase, limit: limit }).forEach(function (ev) {
        var n = self.tracks[ev.trackId];
        if (n && n.inst) n.inst.play(ev.p, ev.v, piece.ctxStart + (ev.at - from), ev.d);
      });
      self.midiChase = false;
    });
  };

  /** Plays one note now on a MIDI track (note previews in the editor). */
  Engine.prototype.audition = function (p, trackId, pitch, velocity, duration) {
    var ctx = this.ensure();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    this.sync(p);
    var n = this.tracks[trackId];
    if (n && n.inst) n.inst.play(pitch, velocity || 100, ctx.currentTime + 0.01, duration || 0.3);
  };

  /** Live playing from a MIDI keyboard: note on (velocity > 0) or off. */
  Engine.prototype.liveNote = function (p, trackId, pitch, velocity) {
    var ctx = this.ensure();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    if (!this.tracks[trackId]) this.sync(p);
    var n = this.tracks[trackId];
    if (!n || !n.inst) return;
    if (velocity > 0) n.inst.noteOn(pitch, velocity, ctx.currentTime);
    else n.inst.noteOff(pitch, ctx.currentTime);
  };

  Engine.prototype.click = function (when, accent) {
    var ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 1 : 0.55, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g);
    g.connect(this.clickBus);
    o.start(when);
    o.stop(when + 0.06);
  };

  Engine.prototype.setMetronome = function (on) {
    this.metronome = on;
    if (on && this.playing) this.clickFrom = this.ctx.currentTime + 0.02;
  };

  Engine.prototype.stopVoices = function () {
    if (!this.ctx) return;
    var now = this.ctx.currentTime, self = this;
    Object.keys(this.tracks).forEach(function (id) { if (self.tracks[id].inst) self.tracks[id].inst.stopAll(now); });
    this.voices.forEach(function (v) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, 0.004);
        v.src.stop(now + 0.03);
      } catch (e) { /* already stopped */ }
    });
    this.voices = [];
  };

  Engine.prototype.stop = function () {
    this.playing = false;
    clearInterval(this.timer);
    this.stopVoices();
  };

  /** Song position being heard now, or null when stopped. */
  Engine.prototype.position = function () {
    if (!this.playing) return null;
    var latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return core.positionAt(this.anchor, this.loop, this.ctx.currentTime - latency);
  };

  /**
   * Levels since the last call: peaks (linear) for the master and each
   * track, and gain reduction (dB) for the limiter and each compressor.
   */
  Engine.prototype.levels = function () {
    var out = { left: 0, right: 0, tracks: {}, limiterDb: 0, comps: {} };
    if (!this.ctx) return out;
    var self = this;
    function grab(units) {
      units.forEach(function (u) { if (u.reduction) out.comps[u.id] = u.reduction(); });
    }
    Object.keys(this.tracks).forEach(function (id) { grab(self.tracks[id].units); });
    grab(this.masterUnits);
    if (this.limiter) out.limiterDb = this.limiter.reduction();
    if (!this.playing) return out;
    var s = this.scratch, small = this.scratch.subarray(0, 1024);
    out.left = peakOf(this.meterL, s);
    out.right = peakOf(this.meterR, s);
    Object.keys(this.tracks).forEach(function (id) { out.tracks[id] = peakOf(self.tracks[id].meter, small); });
    return out;
  };

  /** Seconds of reverb, delay and instrument release tail after the last clip (0 when there are none). */
  Engine.tail = function (p) {
    var tail = 0, lib = synthLib();
    p.tracks.forEach(function (t) {
      if (core.isMidiTrack(t) && lib && lib.releaseOf) tail = Math.max(tail, lib.releaseOf(instOf(t)));
    });
    p.tracks.concat([{ fx: p.master.fx }]).forEach(function (t) {
      t.fx.forEach(function (f) {
        if (!f.on) return;
        if (f.type === 'reverb') tail = Math.max(tail, f.p.decayS + f.p.preDelayMs / 1000);
        if (f.type === 'delay' && f.p.feedback > 0) {
          var time = f.p.sync !== 'off' ? fxLib.noteSec(f.p.sync, p.bpm) : f.p.timeMs / 1000;
          tail = Math.max(tail, time * Math.ceil(Math.log(0.001) / Math.log(f.p.feedback / 100)));
        }
      });
    });
    return Math.min(10, tail);
  };

  /**
   * Renders song time [from, to) to stereo at `sampleRate`, through the same
   * effects, master chain and limiter as playback. opts.trackIds limits the
   * render to those tracks and opts.master = false skips the master effects
   * and limiter (stems). Resolves {getChannelData(c), length, sampleRate}.
   */
  Engine.render = function (p, buffers, opts) {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error('This browser cannot render audio offline.'));
    var sr = opts.sampleRate, from = opts.from, to = opts.to, useMaster = opts.master !== false;
    var length = Math.max(1, Math.ceil((to - from) * sr)), spare = Math.ceil(0.05 * sr);
    var ctx = new Offline(2, length + spare, sr), env = { bpm: p.bpm };
    return (useMaster ? fxLib.ensureWorklet(ctx) : Promise.resolve(false)).then(function (workletOk) {
      var masterIn = ctx.createGain(), fader = ctx.createGain(), latency = 0;
      fader.gain.value = core.dbToGain(p.masterDb);
      if (useMaster) {
        buildChain(ctx, p.master.fx, env, masterIn, fader);
        var lim = fxLib.limiterUnit(ctx, p.master.limiter, workletOk);
        fader.connect(lim.input);
        lim.output.connect(ctx.destination);
        latency = Math.round(lim.latency * sr);
      } else {
        masterIn.connect(fader);
        fader.connect(ctx.destination);
      }
      var inputs = {}, insts = {};
      p.tracks.forEach(function (t) {
        if (opts.trackIds && opts.trackIds.indexOf(t.id) < 0) return;
        var g = core.trackGain(p, t);
        if (!g) return;
        var sum = ctx.createGain(), vol = ctx.createGain(), pan = ctx.createStereoPanner();
        vol.gain.value = g;
        pan.pan.value = t.pan;
        buildChain(ctx, t.fx, env, sum, vol);
        vol.connect(pan);
        pan.connect(masterIn);
        inputs[t.id] = sum;
        if (core.isMidiTrack(t)) insts[t.id] = makeInstrument(ctx, t, sum);
      });
      core.planSegments(p, from, to).forEach(function (seg) {
        var dest = inputs[seg.clip.trackId], buffer = buffers[seg.clip.sourceId];
        if (dest && buffer) schedulePiece(ctx, dest, seg, buffer, seg.at - from);
      });
      core.midiEvents(p, from, to, { chase: true }).forEach(function (ev) {
        var inst = insts[ev.trackId];
        if (inst) inst.play(ev.p, ev.v, ev.at - from, ev.d);
      });
      if (opts.onProgress && ctx.suspend) {
        // Pause at whole render quanta (128 frames) to report progress.
        var total = (length + spare) / sr, used = {};
        for (var i = 1; i < 10; i++) {
          var q = Math.floor((length + spare) * i / 10 / 128) * 128;
          if (q <= 0 || q >= length + spare || used[q]) continue;
          used[q] = true;
          (function (t) {
            try {
              ctx.suspend(t).then(function () {
                opts.onProgress(t / total);
                ctx.resume();
              }, function () { /* progress is optional */ });
            } catch (e) { /* progress is optional */ }
          })(q / sr);
        }
      }
      return ctx.startRendering().then(function (buf) {
        // Skip the limiter's lookahead delay so the export lines up with the song.
        var off = Math.min(latency, spare);
        return {
          length: length,
          sampleRate: sr,
          numberOfChannels: 2,
          limiter: useMaster ? (workletOk ? 'precise' : 'basic') : 'none',
          getChannelData: function (c) { return buf.getChannelData(c).subarray(off, off + length); }
        };
      });
    });
  };

  S2S.studio.Engine = Engine;
})();
;

// ---- js/studio/store.js ----
/*
 * Stem to Stream Studio: songs kept in this browser (IndexedDB).
 *
 *   songs  {id, name, updated, tracks, json}   one record per song
 *   audio  {key: songId/sourceId, songId, blob} the original imported files
 *
 * Browser storage can be missing (private windows, blocked site data,
 * previews) or cleared by the browser, so open() resolves null when it is
 * unavailable and the studio keeps working in memory. A song file (.zip)
 * is the copy that doesn't depend on the browser.
 */
(function () {
  'use strict';

  var S2S = window.S2S;
  var DB_NAME = 's2s-studio', VERSION = 1;

  function promisify(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Browser storage failed.')); };
    });
  }

  function Store(db) { this.db = db; }

  Store.prototype.tx = function (names, mode, fn) {
    var db = this.db;
    return new Promise(function (resolve, reject) {
      var t = db.transaction(names, mode), result;
      t.oncomplete = function () { resolve(result); };
      t.onerror = t.onabort = function () { reject(t.error || new Error('Browser storage failed.')); };
      Promise.resolve(fn(t)).then(function (r) { result = r; }, function (e) { try { t.abort(); } catch (x) { /* done */ } reject(e); });
    });
  };

  Store.prototype.saveSong = function (p) {
    var rec = { id: p.id, name: p.name, updated: p.updated, tracks: p.tracks.length, json: JSON.stringify(p) };
    return this.tx(['songs'], 'readwrite', function (t) { return promisify(t.objectStore('songs').put(rec)); });
  };

  Store.prototype.loadSong = function (id) {
    return this.tx(['songs'], 'readonly', function (t) {
      return promisify(t.objectStore('songs').get(id)).then(function (rec) { return rec ? rec.json : null; });
    });
  };

  /** Summaries of every saved song, newest first. */
  Store.prototype.listSongs = function () {
    return this.tx(['songs'], 'readonly', function (t) {
      return promisify(t.objectStore('songs').getAll()).then(function (all) {
        return all.map(function (r) { return { id: r.id, name: r.name, updated: r.updated, tracks: r.tracks }; })
          .sort(function (a, b) { return b.updated - a.updated; });
      });
    });
  };

  Store.prototype.deleteSong = function (id) {
    return this.tx(['songs', 'audio'], 'readwrite', function (t) {
      t.objectStore('songs').delete(id);
      var audio = t.objectStore('audio');
      return promisify(audio.index('song').getAllKeys(id)).then(function (keys) {
        keys.forEach(function (k) { audio.delete(k); });
      });
    });
  };

  Store.prototype.saveAudio = function (songId, sourceId, blob) {
    var rec = { key: songId + '/' + sourceId, songId: songId, blob: blob };
    return this.tx(['audio'], 'readwrite', function (t) { return promisify(t.objectStore('audio').put(rec)); });
  };

  Store.prototype.loadAudio = function (songId, sourceId) {
    return this.tx(['audio'], 'readonly', function (t) {
      return promisify(t.objectStore('audio').get(songId + '/' + sourceId)).then(function (r) { return r ? r.blob : null; });
    });
  };

  /** Opens browser storage. Resolves a Store, or null when the browser won't keep data. */
  function open() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      setTimeout(function () { finish(null); }, 4000);
      var req;
      try {
        if (!window.indexedDB) return finish(null);
        req = window.indexedDB.open(DB_NAME, VERSION);
      } catch (e) {
        return finish(null);
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'key' }).createIndex('song', 'songId');
        }
      };
      req.onsuccess = function () { finish(new Store(req.result)); };
      req.onerror = function () { finish(null); };
      req.onblocked = function () { finish(null); };
    });
  }

  S2S.studio.store = { open: open };
})();
;

// ---- js/studio/controller.js ----
/*
 * Stem to Stream Studio: the controller.
 *
 * The headless half of the studio. It owns the open song, the decoded
 * audio, undo history, autosave, selection and transport, and runs every
 * command a UI needs: import, export, songs, clips, tracks, effects, vocal
 * tools and MIDI. It never touches the DOM, so any UI can drive it.
 *
 *   var studio = S2S.studio.createController();
 *   var off = studio.subscribe(function (e) { ... });  // see EVENTS below
 *   studio.init();                                     // storage + last song (or the demo)
 *
 * Every change to the song goes through one of three doors, which record
 * one undo step, autosave 700 ms later and keep the audio engine in step:
 *   edit(fn, kind)                       fn(song) changes it in place
 *   gestureStart(), setters, gestureEnd  a slider or drag: one undo step
 *   drag sessions (dragClips etc.)       update() while dragging, end() once
 *
 * Events (subscribe): {type, version, ...}
 *   change     {kind, live?, fit?}  the song changed; kind as in edit()
 *   select     selection changed
 *   transport  play, pause, seek, metronome
 *   save       {state} saved | dirty | saving | error | nostore
 *   busy       a vocal tool started or finished ({job})
 *   progress   {job, value 0..1} (at most 10 a second)
 *   message    {text, tone: info|success|warn|error, ms} a toast; ms 0 = until the next one
 *   midi       {name} a MIDI keyboard connected
 * Every event but `message` bumps `version`, for React's useSyncExternalStore.
 */
(function (root) {
  'use strict';

  var S2S = root.S2S, S = S2S.studio, core = S.core;

  var AUDIO_EXT = /\.(wav|wave|mp3|flac|aif|aiff|aifc|ogg|oga|opus|m4a|aac|mp4|webm|caf)$/i;
  var ANALYSIS_RATE = 22050;
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var TARGETS = [
    { lufs: -14, label: '−14 LUFS (Spotify normal)' },
    { lufs: -11, label: '−11 LUFS (Spotify loud)' },
    { lufs: -9, label: '−9 LUFS (very loud)' }
  ];
  var SYNC_LABELS = { off: 'Off (use free time)', '1/4': '1/4 note', '1/8': '1/8 note', '1/8d': '1/8 dotted', '1/16': '1/16 note', '1/4t': '1/4 triplet', '1/8t': '1/8 triplet' };
  var NOTE_GRIDS = [['1/4', '1/4'], ['1/8', '1/8'], ['1/16', '1/16'], ['1/32', '1/32'], ['1/8t', '1/8 triplet'], ['1/16t', '1/16 triplet']];
  var SHORTCUTS = [
    ['Space', 'Play / pause'],
    ['Home', 'Go to the start'],
    ['← →', 'Nudge selected clips by the snap step (Alt: 10 ms); with nothing selected, move the playhead a bar'],
    ['Mod+E', 'Split at the playhead'],
    ['Mod+D', 'Duplicate selected clips'],
    ['Delete', 'Delete selected clips'],
    ['0', 'Turn selected clips off or on'],
    ['Mod+A', 'Select all clips'],
    ['Esc', 'Clear the selection'],
    ['Shift+T', 'Add a track'],
    ['Shift+M / Shift+S', 'Mute / solo the selected track'],
    ['Mod+L', 'Loop on or off'],
    ['Shift+C', 'Metronome'],
    ['Mod+= / Mod+−', 'Zoom in / out'],
    ['F', 'Fit the song to the window'],
    ['2', 'Show or hide the mixer'],
    ['3', 'Show or hide effects for the selected track'],
    ['4', 'Show or hide the vocal tools'],
    ['5', 'Show or hide the piano roll'],
    ['Mod+Z / Shift+Mod+Z', 'Undo / redo'],
    ['Mod+S', 'Save now (Shift+Mod+S saves a song file)'],
    ['Alt + drag', 'Move, trim or set a loop without snapping to the grid']
  ];

  // ----------------------------------------------------------- helpers ---

  function lsGet(k, fallback) {
    try { var v = root.localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function lsSet(k, v) {
    try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
  }

  function isMidiFile(f) {
    return /\.(mid|midi|smf)$/i.test(f.name || '') || /^audio\/(x-)?midi$/.test(f.type || '');
  }
  function isAudioFile(f) {
    return !isMidiFile(f) && (/^audio\//.test(f.type || '') || AUDIO_EXT.test(f.name || ''));
  }
  function baseName(name) {
    return (name || 'Audio').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ').trim().slice(0, 60) || 'Audio';
  }
  function safeName(name) {
    return (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'song';
  }
  function channelsOf(buffer) {
    var out = [];
    for (var c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
  }
  function errText(e, fallback) { return (e && e.message) || (typeof e === 'string' ? e : fallback); }
  function fmtMs(v) { return Math.round(v) + ' ms'; }
  function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }

  /** Waveform overview: peak and RMS per 256 samples, and per 8192 for zoomed-out views. */
  function computePeaks(buffer) {
    var n = buffer.length, chans = channelsOf(buffer), B0 = 256, GROUP = 32;
    var n0 = Math.ceil(n / B0), max0 = new Float32Array(n0), rms0 = new Float32Array(n0);
    for (var b = 0; b < n0; b++) {
      var s = b * B0, e = Math.min(n, s + B0), m = 0, sq = 0;
      for (var c = 0; c < chans.length; c++) {
        var d = chans[c];
        for (var i = s; i < e; i++) {
          var v = d[i], a = v < 0 ? -v : v;
          if (a > m) m = a;
          sq += v * v;
        }
      }
      max0[b] = m;
      rms0[b] = Math.sqrt(sq / ((e - s) * chans.length || 1));
    }
    var n1 = Math.ceil(n0 / GROUP), max1 = new Float32Array(n1), rms1 = new Float32Array(n1);
    for (b = 0; b < n1; b++) {
      var m1 = 0, r1 = 0, cnt = 0;
      for (i = b * GROUP; i < Math.min(n0, (b + 1) * GROUP); i++) {
        if (max0[i] > m1) m1 = max0[i];
        r1 += rms0[i] * rms0[i];
        cnt++;
      }
      max1[b] = m1;
      rms1[b] = Math.sqrt(r1 / (cnt || 1));
    }
    return { sampleRate: buffer.sampleRate, levels: [{ block: B0, max: max0, rms: rms0 }, { block: B0 * GROUP, max: max1, rms: rms1 }] };
  }

  function usedSourceIds(p) {
    var used = {};
    p.clips.forEach(function (c) {
      used[c.sourceId] = true;
      (c.versions || []).forEach(function (id) { used[id] = true; });
    });
    return Object.keys(p.sources).filter(function (id) { return used[id]; });
  }

  function extFor(source, blob) {
    var m = blob && blob.name && /\.([a-z0-9]{2,5})$/i.exec(blob.name);
    if (m) return m[1].toLowerCase();
    var t = (blob && blob.type) || source.type || '';
    return /mpeg|mp3/.test(t) ? 'mp3' : /flac/.test(t) ? 'flac' : /ogg/.test(t) ? 'ogg' : /mp4|m4a|aac/.test(t) ? 'm4a' : /aiff/.test(t) ? 'aiff' : 'wav';
  }

  /** Lengthens a MIDI clip so notes past its end are heard. */
  function fitClip(c) {
    var end = 0;
    c.notes.forEach(function (n) { end = Math.max(end, n.t + n.d); });
    if (end > c.offset + c.duration) c.duration = Math.min(3600, end - c.offset);
  }

  // -------------------------------------------------------- controller ---

  /**
   * opts (all optional):
   *   engine       an Engine (default: new S2S.studio.Engine())
   *   Engine       the class used for offline renders (default S2S.studio.Engine)
   *   store        a Store, or null for no browser storage (default: S2S.studio.store.open())
   *   initialSong  'last' (default: last song, else newest, else demo) | 'demo' | 'empty'
   */
  function createController(opts) {
    opts = opts || {};
    var EngineClass = opts.Engine || S.Engine;
    var engine = opts.engine || new EngineClass();
    var history = new core.History(opts.historyLimit || 150);
    var song = core.createProject({ name: 'Untitled song' });
    var buffers = {}, peaks = {}, blobs = {};
    var sel = { clips: [], track: null };
    var pos = 0, version = 0, listeners = [];
    var store = null, storeKnown = false, initPromise = null;
    var saveState = 'saving', saveTimer = 0;
    var metronome = !!lsGet('studio:metronome', false);
    var gesture = null;
    var busy = null, progressValue = 0, progressAt = 0;
    var marks = {}, results = {}, detectedKey = null, limiterNote = '';
    var demoAudio = null, downloadsReady = null;
    var taps = [], tapTimer = 0;
    var midiAccess = null, midiName = '', midiTarget = null;

    // ------------------------------------------------------ events ---

    function emit(type, data) {
      if (type !== 'message') version++;
      var e = { type: type, version: version };
      if (data) Object.keys(data).forEach(function (k) { e[k] = data[k]; });
      listeners.slice().forEach(function (fn) {
        try { fn(e); } catch (err) { if (root.console) root.console.error(err); }
      });
    }

    function message(text, tone, ms) {
      emit('message', { text: text, tone: tone || 'info', ms: ms == null ? 4000 : ms });
    }

    function subscribe(fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    // ------------------------------------------------------- audio ---

    function makeBuffer(channels, length, sampleRate) {
      try {
        return new root.AudioBuffer({ numberOfChannels: channels, length: Math.max(1, length), sampleRate: sampleRate });
      } catch (e) {
        return engine.ensure().createBuffer(channels, Math.max(1, length), sampleRate);
      }
    }

    /** Decodes an audio file. WAVs are read directly (32-bit float stays exact); others go through the browser. */
    function decodeBlob(blob) {
      return blob.arrayBuffer().then(function (ab) {
        var head = new Uint8Array(ab, 0, Math.min(12, ab.byteLength));
        var tag = String.fromCharCode.apply(null, head.subarray(0, 4)), wave = String.fromCharCode.apply(null, head.subarray(8, 12));
        if ((tag === 'RIFF' || tag === 'RF64') && wave === 'WAVE') {
          try {
            var w = S2S.audio.parseWav(ab);
            if (w.channels <= 32 && w.sampleRate >= 3000 && w.sampleRate <= 768000) {
              var b = makeBuffer(w.channels, w.frames, w.sampleRate);
              w.channelData.forEach(function (d, i) { b.copyToChannel(d, i); });
              return b;
            }
          } catch (e) { /* fall back to the browser's decoder */ }
        }
        return engine.decode(ab);
      });
    }

    function addAudio(sourceId, buffer, blob) {
      buffers[sourceId] = buffer;
      peaks[sourceId] = computePeaks(buffer);
      if (blob) blobs[sourceId] = blob;
    }

    function storageFailed() {
      setSaveState('error');
      message('This browser refused to store the audio (it may be out of space). Save a song file to keep your work.', 'error', 8000);
    }

    function saveAudioBlob(sourceId, blob) {
      if (store) store.saveAudio(song.id, sourceId, blob).catch(storageFailed);
    }

    /** The five synthesized demo stems (mono, 48 kHz), rendered once. */
    function getDemoAudio() {
      if (demoAudio) return demoAudio;
      demoAudio = S2S.demoLoop.render(48000).then(function (loop) {
        var out = {};
        loop.tracks.forEach(function (t) {
          var b = makeBuffer(1, t.buffer.length, loop.sampleRate);
          b.copyToChannel(t.buffer, 0);
          out[t.id] = b;
        });
        return out;
      });
      demoAudio.catch(function () { demoAudio = null; });
      return demoAudio;
    }

    // ------------------------------------------------------- songs ---

    /** Makes `p` the open song. Audio for its sources must already be loaded. */
    function setSong(p, o) {
      if (engine.playing) engine.stop();
      gesture = null;
      song = p;
      history.clear();
      sel = { clips: [], track: p.tracks[0] ? p.tracks[0].id : null };
      pos = 0;
      marks = {};
      results = {};
      detectedKey = null;
      limiterNote = '';
      if (engine.ctx) engine.sync(p);
      lsSet('studio:last', p.id);
      if (!o || o.save !== false) saveNow();
      else setSaveState(store ? 'saved' : 'nostore');
      emit('change', { kind: 'open', fit: true });
      return p;
    }

    function newSong() {
      setSong(core.createProject({ name: 'Untitled song' }));
      message('New song. Drop your stems onto the timeline.');
      return song;
    }

    /** The demo song: a synthesized loop arranged over 16 bars. */
    function openDemo() {
      return getDemoAudio().then(function (audio) {
        var p = core.createProject({ name: 'Demo song', bpm: 96, sig: [4, 4], snap: 'bar' });
        var bar = core.barSec(p);
        var plan = [
          { id: 'drums', name: 'Drums', color: 3, vol: -3, pan: 0, bars: [4, 8, 12] },
          { id: 'hats', name: 'Hats', color: 2, vol: -9, pan: 0.3, bars: [4, 8, 12] },
          { id: 'bass', name: 'Bass', color: 4, vol: -5, pan: 0, bars: [4, 8, 12] },
          { id: 'keys', name: 'Keys', color: 1, vol: -8, pan: -0.25, bars: [0, 4, 8, 12] },
          { id: 'lead', name: 'Lead synth', color: 7, vol: -3, pan: 0, bars: [8, 12] }
        ];
        plan.forEach(function (s) {
          var buffer = audio[s.id];
          var src = core.addSource(p, { name: s.name, type: 'audio/wav', duration: buffer.duration, sampleRate: buffer.sampleRate, channels: 1, demo: s.id });
          addAudio(src.id, buffer);
          var t = core.addTrack(p, { name: s.name, color: s.color, volumeDb: s.vol, pan: s.pan });
          s.bars.forEach(function (b, i) {
            var c = core.addClip(p, { trackId: t.id, sourceId: src.id, start: b * bar });
            if (s.id === 'keys' && i === 0) core.setFade(c, 'in', bar);
            if (b === 12 && (s.id === 'keys' || s.id === 'lead')) core.setFade(c, 'out', bar * 0.8);
          });
        });
        p.loop = { on: false, start: 8 * bar, end: 12 * bar };
        return setSong(p);
      });
    }

    /** Loads a song saved in this browser, decoding its audio. Resolves {song, missing}. */
    function loadStored(id) {
      if (!store) return Promise.reject(new Error('This browser isn’t keeping songs for this page.'));
      return store.loadSong(id).then(function (json) {
        if (!json) throw new Error('That song is no longer saved in this browser.');
        var p = core.parseProject(json), missing = 0;
        message('Opening “' + p.name + '”…', 'info', 0);
        var ids = Object.keys(p.sources);
        var demoNeeded = ids.some(function (sid) { return p.sources[sid].demo; });
        return (demoNeeded ? getDemoAudio() : Promise.resolve(null)).then(function (demo) {
          return ids.reduce(function (chain, sid) {
            return chain.then(function () {
              var s = p.sources[sid];
              if (buffers[sid] && buffers[sid].length) return null;
              if (s.demo && demo && demo[s.demo]) { addAudio(sid, demo[s.demo]); return null; }
              return store.loadAudio(p.id, sid).then(function (blob) {
                if (!blob) { missing++; return null; }
                return decodeBlob(blob).then(function (b) { addAudio(sid, b, blob); }, function () { missing++; });
              });
            });
          }, Promise.resolve());
        }).then(function () {
          setSong(p, { save: false });
          if (missing) message(missing + ' audio file' + (missing > 1 ? 's are' : ' is') + ' missing from this browser. Import ' + (missing > 1 ? 'them' : 'it') + ' again.', 'warn', 7000);
          else message('Opened “' + p.name + '”.', 'success', 2000);
          return { song: p, missing: missing };
        });
      });
    }

    function chooseInitialSong() {
      var mode = opts.initialSong || 'last';
      if (mode === 'empty') { setSong(core.createProject({ name: 'Untitled song' }), { save: false }); return Promise.resolve(song); }
      if (mode === 'demo' || !store) return openDemo();
      var last = lsGet('studio:last', null);
      return (last ? loadStored(last) : Promise.reject(new Error('none')))
        .catch(function () {
          return store.listSongs().then(function (list) {
            return list.length ? loadStored(list[0].id) : openDemo();
          });
        })
        .catch(function () { return openDemo(); });
    }

    /** Opens browser storage and the first song. Call once; later calls return the same promise. */
    function init() {
      if (initPromise) return initPromise;
      setSaveState('saving');
      var opening = opts.store !== undefined ? Promise.resolve(opts.store)
        : S.store ? S.store.open() : Promise.resolve(null);
      initPromise = opening.then(function (st) {
        store = st || null;
        storeKnown = true;
        return chooseInitialSong();
      }).then(function () { return api; }, function (e) {
        message('Couldn’t start the studio: ' + errText(e, 'unknown error'), 'error', 10000);
        throw e;
      });
      if (root.document && root.document.addEventListener) {
        root.document.addEventListener('visibilitychange', function () {
          if (root.document.visibilityState === 'hidden' && saveState === 'dirty') saveNow();
        });
      }
      return initPromise;
    }

    function listSongs() {
      if (!store) return Promise.resolve([]);
      return store.listSongs().then(function (list) {
        return list.map(function (s) {
          return { id: s.id, name: s.name, updated: s.updated, tracks: s.tracks, current: s.id === song.id };
        });
      });
    }

    function openSong(id) {
      return saveNow().then(function () { return loadStored(id); });
    }

    function deleteSong(id) {
      if (!store) return Promise.resolve(false);
      return store.deleteSong(id).then(function () {
        lsSet('studio:view:' + id, null);
        if (id === song.id) newSong();
        return true;
      });
    }

    // ------------------------------------------------------ saving ---

    function setSaveState(state) {
      if (saveState === state) return;
      saveState = state;
      emit('save', { state: state });
    }

    function scheduleSave() {
      setSaveState(store ? 'dirty' : (storeKnown ? 'nostore' : 'dirty'));
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 700);
    }

    function saveNow() {
      clearTimeout(saveTimer);
      if (!store) { setSaveState(storeKnown ? 'nostore' : 'dirty'); return Promise.resolve(false); }
      setSaveState('saving');
      var p = song;
      return store.saveSong(p).then(function () {
        if (p === song) setSaveState('saved');
        lsSet('studio:last', p.id);
        return true;
      }, function () {
        setSaveState('error');
        return false;
      });
    }

    // ----------------------------------------------------- editing ---

    function pruneSelection() {
      var before = sel.clips.length;
      sel.clips = sel.clips.filter(function (id) { return core.getClip(song, id); });
      if (sel.track && !core.getTrack(song, sel.track)) sel.track = song.tracks[0] ? song.tracks[0].id : null;
      return before !== sel.clips.length;
    }

    function restartIfPlaying() {
      if (engine.playing) engine.play(song, buffers, engine.position());
    }

    /** After any change: autosave and keep the audio in step. */
    function changed(kind, extra) {
      var p = song;
      p.updated = Date.now();
      scheduleSave();
      if (kind === 'notes') {
        p.clips.forEach(function (c) {
          if (core.isMidiClip(c)) { core.sortNotes(c.notes); fitClip(c); }
        });
      } else if (kind === 'fx') {
        engine.applyFx(p);
      } else if (kind === 'fxchain') {
        if (engine.ctx) engine.sync(p);
      } else if (kind === 'mix') {
        engine.applyMix(p);
      } else if (kind === 'loop') {
        restartIfPlaying();
      } else if (kind !== 'name') {
        pruneSelection();
        if (engine.ctx) engine.sync(p);
        restartIfPlaying();
      }
      var data = { kind: kind };
      if (extra) Object.keys(extra).forEach(function (k) { data[k] = extra[k]; });
      emit('change', data);
    }

    /** Runs fn(song) as one undoable edit. Return false from fn for "no change". */
    function edit(fn, kind) {
      var before = core.serialize(song);
      var result = fn(song);
      if (result === false) return result;
      history.record(before);
      changed(kind || 'arrange');
      return result;
    }

    /** Records an edit already made in place, given core.serialize(song) from before it. */
    function commit(before, kind, extra) {
      history.record(before);
      changed(kind || 'arrange', extra);
    }

    /** Starts a gesture (slider drag, tap tempo): setters change the song live until gestureEnd. */
    function gestureStart() { if (gesture == null) gesture = core.serialize(song); }

    /** Ends a gesture: one undo step for all of it (none if nothing changed). */
    function gestureEnd(kind) {
      if (gesture == null) return false;
      var before = gesture;
      gesture = null;
      if (before === core.serialize(song)) return false;
      commit(before, kind || 'mix');
      return true;
    }

    /** Inside a gesture: change live (no undo step yet). Outside: one undoable edit. */
    function apply(fn, kind) {
      if (gesture == null) return edit(fn, kind);
      var r = fn(song);
      if (r === false) return r;
      if (kind === 'mix') engine.applyMix(song);
      else if (kind === 'fx') engine.applyFx(song);
      emit('change', { kind: kind, live: true });
      return r;
    }

    function restore(json) {
      song = core.parseProject(json);
      pruneSelection();
      if (engine.ctx) engine.sync(song);
      restartIfPlaying();
      emit('change', { kind: 'all' });
    }

    function undo() {
      gestureEnd();
      var prev = history.undo(core.serialize(song));
      if (prev == null) { message('Nothing to undo.', 'info', 1500); return false; }
      song = core.parseProject(prev);
      changed('all');
      return true;
    }

    function redo() {
      var next = history.redo(core.serialize(song));
      if (next == null) { message('Nothing to redo.', 'info', 1500); return false; }
      song = core.parseProject(next);
      changed('all');
      return true;
    }

    // --------------------------------------------------- selection ---

    function selectedClips() {
      return sel.clips.map(function (id) { return core.getClip(song, id); }).filter(Boolean);
    }

    function select(ids) {
      sel.clips = (ids || []).filter(function (id) { return core.getClip(song, id); });
      emit('select');
    }

    function toggleSelect(id) {
      var i = sel.clips.indexOf(id);
      if (i >= 0) sel.clips.splice(i, 1);
      else if (core.getClip(song, id)) sel.clips.push(id);
      emit('select');
    }

    function selectAll() { select(song.clips.map(function (c) { return c.id; })); }

    function selectTrack(id) {
      sel.track = id && core.getTrack(song, id) ? id : null;
      emit('select');
    }

    // --------------------------------------------------- transport ---

    function currentPos() {
      if (engine.playing) {
        var p = engine.position();
        if (p != null) pos = p;
      }
      return pos;
    }

    function play() {
      try {
        engine.play(song, buffers, pos);
        engine.setMetronome(metronome);
      } catch (e) {
        message(errText(e, 'Playback failed.'), 'error', 6000);
      }
      emit('transport');
    }

    function pause() {
      var p = engine.position();
      engine.stop();
      if (p != null) pos = p;
      emit('transport');
    }

    function togglePlay() { if (engine.playing) pause(); else play(); }

    function seek(t) {
      pos = Math.max(0, Number(t) || 0);
      if (engine.playing) engine.play(song, buffers, pos);
      emit('transport');
    }

    engine.onEnded = function (start) {
      pos = start;
      emit('transport');
    };

    /** Loop on/off; with no loop yet, loops the selected clips (or 4 bars from the playhead). */
    function toggleLoop() {
      var p = song, before = core.serialize(p);
      if (p.loop.end - p.loop.start < core.MIN_LOOP) {
        var clips = selectedClips(), bar = core.barSec(p);
        if (clips.length) {
          var a = Infinity, b = 0;
          clips.forEach(function (c) { a = Math.min(a, c.start); b = Math.max(b, core.clipEnd(c)); });
          p.loop = { on: true, start: a, end: b };
        } else {
          var s = Math.max(0, core.snapTime(p, currentPos(), 'bar'));
          p.loop = { on: true, start: s, end: s + 4 * bar };
        }
      } else {
        p.loop.on = !p.loop.on;
      }
      commit(before, 'loop');
    }

    function setLoop(o) {
      return edit(function (p) {
        var start = Math.max(0, Number(o.start != null ? o.start : p.loop.start));
        var end = Math.max(start + core.MIN_LOOP, Number(o.end != null ? o.end : p.loop.end));
        p.loop = { on: o.on != null ? !!o.on : p.loop.on, start: start, end: end };
      }, 'loop');
    }

    function setMetronome(on) {
      metronome = !!on;
      engine.setMetronome(metronome);
      lsSet('studio:metronome', metronome);
      emit('transport');
    }

    function toggleMetronome() { setMetronome(!metronome); }

    /** Tap on the beat; from the third tap the tempo follows (one undo step per run of taps). */
    function tapTempo() {
      var t = now();
      if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
      taps.push(t);
      if (taps.length > 9) taps.shift();
      if (taps.length < 3) return { bpm: null, taps: taps.length };
      var bpm = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)) * 10) / 10;
      if (bpm < 20 || bpm > 300) return { bpm: null, taps: taps.length };
      gestureStart();
      song.bpm = bpm;
      emit('change', { kind: 'song', live: true });
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () { gestureEnd('song'); }, 2100);
      return { bpm: bpm, taps: taps.length };
    }

    function alignGridToPlayhead() {
      var p = song, bar = core.barSec(p), at = currentPos(), off = ((at % bar) + bar) % bar;
      edit(function (q) { q.gridOffset = Math.round(off * 1e6) / 1e6; }, 'song');
      message('Bar lines now fall on the playhead (' + core.fmtClock(at) + ').', 'info', 3000);
    }

    function setBpm(v) {
      v = Number(v);
      if (!(v >= 20 && v <= 300)) { message('Tempo must be between 20 and 300 BPM.', 'warn'); return false; }
      return edit(function (p) { if (p.bpm === Math.round(v * 100) / 100) return false; p.bpm = Math.round(v * 100) / 100; }, 'song');
    }

    function setTimeSignature(num, den) {
      num = Math.round(Number(num));
      den = Number(den);
      if (!(num >= 1 && num <= 32) || core.DENOMINATORS.indexOf(den) < 0) return false;
      return edit(function (p) { p.sig = [num, den]; }, 'song');
    }

    /** Snap is a view setting: saved with the song, not an undo step. */
    function setSnap(snap) {
      if (core.SNAPS.indexOf(snap) < 0) return;
      song.snap = snap;
      scheduleSave();
      emit('change', { kind: 'snap' });
    }

    function renameSong(name) {
      var v = String(name || '').trim() || 'Untitled song';
      return edit(function (p) { if (p.name === v.slice(0, 120)) return false; p.name = v.slice(0, 120); }, 'name');
    }

    /** Call once per animation frame: where playback is, and the meters (levels() resets the peaks). */
    function frame() {
      var playing = !!engine.playing;
      return { playing: playing, position: currentPos(), levels: engine.levels() };
    }

    // ----------------------------------------------- clip commands ---

    function splitAtPlayhead() {
      var p = song, at = currentPos();
      var inside = function (c) { return at > c.start + core.MIN_CLIP && at < core.clipEnd(c) - core.MIN_CLIP; };
      var targets = selectedClips().filter(inside);
      if (!targets.length && sel.track) targets = p.clips.filter(function (c) { return c.trackId === sel.track && inside(c); });
      if (!targets.length) { message('Put the playhead over a clip, select the clip, then split.'); return []; }
      var rights = [];
      edit(function (q) {
        targets.forEach(function (c) {
          var r = core.splitClip(q, core.getClip(q, c.id), at);
          if (r) rights.push(r.id);
        });
      }, 'arrange');
      select(rights);
      return rights;
    }

    function duplicateSelected() {
      var clips = selectedClips();
      if (!clips.length) { message('Select a clip to duplicate.'); return []; }
      var copies = edit(function (q) {
        var made = core.duplicateClips(q, clips.map(function (c) { return core.getClip(q, c.id); }));
        core.resolveOverlaps(q, made.map(function (c) { return c.id; }));
        return made;
      }, 'arrange');
      var ids = copies.map(function (c) { return c.id; });
      select(ids);
      return ids;
    }

    function deleteSelected() {
      var ids = sel.clips.slice();
      if (!ids.length) return false;
      edit(function (q) { core.deleteClips(q, ids); }, 'arrange');
      select([]);
      return true;
    }

    function toggleDisabled() {
      var clips = selectedClips();
      if (!clips.length) return false;
      var turnOff = clips.some(function (c) { return !c.disabled; });
      edit(function (q) { clips.forEach(function (c) { core.getClip(q, c.id).disabled = turnOff; }); }, 'arrange');
      return true;
    }

    /** Clip gain of the selected audio clips, by `delta` dB. Returns the new gain of the last one. */
    function clipGain(delta) {
      var clips = selectedClips().filter(function (c) { return !core.isMidiClip(c); });
      if (!clips.length) return null;
      var last = 0;
      edit(function (q) {
        clips.forEach(function (c) {
          var x = core.getClip(q, c.id);
          x.gainDb = core.clamp(Math.round((x.gainDb + delta) * 10) / 10, core.FLOOR_DB, 24);
          last = x.gainDb;
        });
      }, 'arrange');
      message('Clip gain ' + (last > 0 ? '+' : '') + last.toFixed(1) + ' dB', 'info', 1500);
      return last;
    }

    function setClipGain(id, db) {
      return apply(function (q) {
        var c = core.getClip(q, id);
        if (!c) return false;
        c.gainDb = core.clamp(Math.round(Number(db) * 10) / 10, core.FLOOR_DB, 24);
      }, 'arrange');
    }

    function renameClip(id, name) {
      var v = String(name || '').trim();
      if (!v) return false;
      return edit(function (q) {
        var c = core.getClip(q, id);
        if (!c || c.name === v.slice(0, 120)) return false;
        c.name = v.slice(0, 120);
      }, 'arrange');
    }

    /** Nudges the selected clips one snap step (fine: 10 ms); with none selected, moves the playhead a bar. */
    function nudge(dir, fine) {
      var clips = selectedClips(), p = song;
      if (!clips.length) {
        seek(Math.max(0, core.snapTime(p, currentPos() + dir * core.barSec(p), 'bar')));
        return false;
      }
      var step = fine ? 0.01 : core.snapStep(p, p.snap) || 0.01;
      var min = Infinity;
      clips.forEach(function (c) { min = Math.min(min, c.start); });
      var delta = Math.max(-min, dir * step);
      if (!delta) return false;
      edit(function (q) {
        clips.forEach(function (c) { core.getClip(q, c.id).start += delta; });
        core.resolveOverlaps(q, clips.map(function (c) { return c.id; }));
      }, 'arrange');
      return true;
    }

    // ------------------------------------------------ drag sessions ---

    /**
     * A drag: update() changes the song live (redraw on 'change' events with
     * live: true), end() records one undo step, cancel() puts everything back.
     */
    function session(kind, applyFn, finish) {
      var before = core.serialize(song), moved = false, done = false;
      return {
        update: function () {
          if (done) return;
          moved = true;
          applyFn.apply(null, arguments);
          emit('change', { kind: kind, live: true });
        },
        end: function () {
          if (done) return false;
          done = true;
          if (!moved) return false;
          if (finish) finish();
          if (core.serialize(song) === before) { emit('change', { kind: kind }); return false; }
          commit(before, kind);
          return true;
        },
        cancel: function () {
          if (done) return;
          done = true;
          if (moved) restore(before);
        }
      };
    }

    function snapT(t, free) { return free ? Math.max(0, t) : Math.max(0, core.snapTime(song, t)); }

    /**
     * Moves clips: the selection if `id` is in it, else just `id`.
     * update(deltaSeconds, targetTrackId?, free?) — the delta is from where the drag began,
     * snapped by the clip `id`'s start; targetTrackId is the lane under the pointer.
     * Audio clips stay on audio tracks and MIDI clips on instrument tracks.
     */
    function dragClips(id, o) {
      var ids = sel.clips.indexOf(id) >= 0 ? sel.clips.slice() : [id], orig = {};
      ids.forEach(function (cid) {
        var x = core.getClip(song, cid);
        if (x) orig[cid] = { start: x.start, trackId: x.trackId };
      });
      ids = Object.keys(orig);
      var anchor = orig[id] || orig[ids[0]];
      return session('arrange', function (dt, targetTrackId, free) {
        var p = song;
        if (!anchor) return;
        var start = snapT(anchor.start + (Number(dt) || 0), free || (o && o.free)), delta = start - anchor.start, minStart = Infinity;
        ids.forEach(function (cid) { minStart = Math.min(minStart, orig[cid].start); });
        if (minStart + delta < 0) delta = -minStart;
        var rowDelta = 0;
        if (targetTrackId && core.getTrack(p, targetTrackId)) {
          rowDelta = core.trackIndex(p, targetTrackId) - core.trackIndex(p, anchor.trackId);
          ids.forEach(function (cid) {
            var i = core.trackIndex(p, orig[cid].trackId);
            if (i + rowDelta < 0) rowDelta = -i;
            if (i + rowDelta > p.tracks.length - 1) rowDelta = p.tracks.length - 1 - i;
          });
        }
        ids.forEach(function (cid) {
          var x = core.getClip(p, cid), ox = orig[cid];
          if (!x) return;
          x.start = ox.start + delta;
          var t = p.tracks[core.trackIndex(p, ox.trackId) + rowDelta];
          x.trackId = t && core.isMidiTrack(t) === core.isMidiClip(x) ? t.id : ox.trackId;
        });
      }, function () { core.resolveOverlaps(song, ids); });
    }

    /** Trims a clip's start or end: update(songTime, free?). */
    function dragTrim(id, edge) {
      var c0 = core.getClip(song, id);
      if (!c0) return session('arrange', function () {});
      var o = { start: c0.start, offset: c0.offset, duration: c0.duration, fadeIn: c0.fadeIn, fadeOut: c0.fadeOut };
      return session('arrange', function (t, free) {
        var c = core.getClip(song, id);
        if (!c) return;
        c.start = o.start; c.offset = o.offset; c.duration = o.duration; c.fadeIn = o.fadeIn; c.fadeOut = o.fadeOut;
        if (edge === 'start') core.trimStart(song, c, snapT(t, free));
        else core.trimEnd(song, c, snapT(t, free));
      }, function () { core.resolveOverlaps(song, [id]); });
    }

    /** Sets a fade's length: update(seconds). which: 'in' | 'out'. */
    function dragFade(id, which) {
      return session('arrange', function (seconds) {
        var c = core.getClip(song, id);
        if (c) core.setFade(c, which === 'out' ? 'out' : 'in', Math.max(0, Number(seconds) || 0));
      });
    }

    /**
     * Loop region on the ruler. mode 'new' (from t0), 'start', 'end' or 'move' (grabbed at t0).
     * update(songTime, free?).
     */
    function dragLoop(mode, t0) {
      var L0 = { start: song.loop.start, end: song.loop.end, on: song.loop.on };
      t0 = Number(t0) || 0;
      return session('loop', function (t, free) {
        var L = song.loop, min = core.MIN_LOOP;
        if (mode === 'new') {
          var a = snapT(Math.min(t0, t), free), b = snapT(Math.max(t0, t), free);
          if (b - a >= min) { L.start = a; L.end = b; L.on = true; }
        } else if (mode === 'start') {
          L.start = Math.min(snapT(t, free), L0.end - min);
        } else if (mode === 'end') {
          L.end = Math.max(snapT(t, free), L0.start + min);
        } else {
          var shift = snapT(L0.start + (t - t0), free) - L0.start;
          if (L0.start + shift < 0) shift = -L0.start;
          L.start = L0.start + shift;
          L.end = L0.end + shift;
        }
      });
    }

    // ----------------------------------------------- track commands ---

    function insertIndex() { return sel.track ? core.trackIndex(song, sel.track) + 1 : song.tracks.length; }

    function addTrack(o) {
      var idx = insertIndex();
      var t = edit(function (q) { return core.addTrack(q, { index: idx, name: o && o.name }); }, 'arrange');
      selectTrack(t.id);
      return t.id;
    }

    function presetList() { return S.synth && S.synth.PRESETS ? S.synth.PRESETS : []; }

    function instFromPreset(id) {
      var lib = S.synth, pr = lib && (lib.presetById(id) || lib.PRESETS[0]);
      if (!pr) return { type: 'synth', preset: '', p: {} };
      return { type: pr.type, preset: pr.id, p: JSON.parse(JSON.stringify(pr.p || {})) };
    }

    function barAtPlayhead(q) {
      var bar = core.barSec(q);
      return Math.max(0, q.gridOffset + Math.floor((currentPos() - q.gridOffset) / bar + 1e-9) * bar);
    }

    /** An instrument (MIDI) track playing `presetId`, with an empty one-bar clip at the playhead. */
    function addInstrumentTrack(presetId) {
      var idx = insertIndex(), inst = instFromPreset(presetId), pr = S.synth && S.synth.presetById(inst.preset);
      var made = edit(function (q) {
        var t = core.addTrack(q, { index: idx, type: 'midi', inst: inst, name: pr ? pr.name : 'Instrument' });
        var c = core.addMidiClip(q, { trackId: t.id, name: t.name, start: barAtPlayhead(q), duration: core.barSec(q) });
        return { trackId: t.id, clipId: c.id };
      }, 'arrange');
      sel.track = made.trackId;
      select([made.clipId]);
      return made;
    }

    function deleteTrack(id) {
      var t = core.getTrack(song, id);
      if (!t) return false;
      edit(function (q) { core.removeTrack(q, id); }, 'arrange');
      message('Deleted “' + t.name + '”. Undo brings it back.', 'info');
      return true;
    }

    function renameTrack(id, name) {
      var v = String(name || '').trim().slice(0, 60);
      if (!v) return false;
      return edit(function (q) {
        var t = core.getTrack(q, id);
        if (!t || t.name === v) return false;
        t.name = v;
      }, 'arrange');
    }

    function setTrackColor(id, color) {
      return edit(function (q) {
        var t = core.getTrack(q, id);
        if (!t) return false;
        t.color = color == null ? (t.color + 1) % core.COLORS : core.clamp(Math.round(color), 0, core.COLORS - 1);
      }, 'arrange');
    }

    function moveTrack(id, dir) {
      return edit(function (q) { return core.moveTrack(q, id, dir < 0 ? -1 : 1); }, 'arrange');
    }

    function toggleMute(id) {
      return edit(function (q) { var t = core.getTrack(q, id); if (!t) return false; t.mute = !t.mute; }, 'mix');
    }

    function toggleSolo(id) {
      return edit(function (q) { var t = core.getTrack(q, id); if (!t) return false; t.solo = !t.solo; }, 'mix');
    }

    /** Track volume in dB (core.FLOOR_DB is silence). Live inside a gesture. */
    function setVolume(id, db) {
      return apply(function (q) {
        var t = core.getTrack(q, id);
        if (!t) return false;
        t.volumeDb = core.clamp(Number(db), core.FLOOR_DB, core.MAX_DB);
      }, 'mix');
    }

    /** Track pan, −1 (left) to 1 (right). Live inside a gesture. */
    function setPan(id, pan) {
      return apply(function (q) {
        var t = core.getTrack(q, id);
        if (!t) return false;
        t.pan = core.clamp(Number(pan), -1, 1);
      }, 'mix');
    }

    function setMasterDb(db) {
      return apply(function (q) { q.masterDb = core.clamp(Number(db), core.FLOOR_DB, core.MAX_DB); }, 'mix');
    }

    // ------------------------------------------------------ effects ---

    function fxListOf(p, target) {
      if (target === 'master') return p.master.fx;
      var t = core.getTrack(p, target);
      return t ? t.fx : null;
    }

    function fxList(target) { return fxListOf(song, target) || []; }

    function addFx(target, type) {
      return edit(function (q) {
        var list = fxListOf(q, target);
        if (!list) return false;
        return core.addFx(list, type).id;
      }, 'fxchain');
    }

    function removeFx(fxId) {
      return edit(function (q) {
        var hit = core.findFx(q, fxId);
        if (!hit) return false;
        hit.list.splice(hit.index, 1);
      }, 'fxchain');
    }

    function moveFx(fxId, dir) {
      return edit(function (q) {
        var hit = core.findFx(q, fxId);
        if (!hit) return false;
        var j = hit.index + (dir < 0 ? -1 : 1);
        if (j < 0 || j >= hit.list.length) return false;
        hit.list.splice(hit.index, 1);
        hit.list.splice(j, 0, hit.fx);
      }, 'fxchain');
    }

    function toggleFx(fxId) {
      return edit(function (q) {
        var hit = core.findFx(q, fxId);
        if (!hit) return false;
        hit.fx.on = !hit.fx.on;
      }, 'fxchain');
    }

    /** One effect parameter (clamped to its schema). Live inside a gesture. */
    function setFxParam(fxId, key, value) {
      return apply(function (q) {
        var hit = core.findFx(q, fxId);
        if (!hit) return false;
        core.setFxParam(hit.fx, key, value);
      }, 'fx');
    }

    function toggleLimiter() {
      return edit(function (q) { q.master.limiter.on = !q.master.limiter.on; }, 'fxchain');
    }

    function setLimiterParam(key, value) {
      var ps = core.LIMITER[key];
      if (!ps) return false;
      return apply(function (q) { q.master.limiter[key] = Math.min(ps.max, Math.max(ps.min, Number(value))); }, 'fx');
    }

    function setPreset(trackId, presetId) {
      var next = instFromPreset(presetId);
      return edit(function (q) {
        var t = core.getTrack(q, trackId);
        if (!t || !core.isMidiTrack(t)) return false;
        t.inst = next;
      }, 'fxchain');
    }

    /** One instrument parameter (clamped to its schema). Live inside a gesture. */
    function setInstParam(trackId, key, value) {
      return apply(function (q) {
        var t = core.getTrack(q, trackId), lib = S.synth;
        if (!t || !core.isMidiTrack(t) || !lib) return false;
        var spec = lib.INSTRUMENTS[t.inst.type], ps = spec && spec.params[key];
        if (!ps) return false;
        t.inst.p[key] = ps.options ? value : Math.min(ps.max, Math.max(ps.min, Number(value)));
      }, 'fx');
    }

    /** Current instrument parameters of a MIDI track, filled in from its type's defaults. */
    function instParams(trackId) {
      var t = core.getTrack(song, trackId), lib = S.synth;
      if (!t || !core.isMidiTrack(t) || !lib) return null;
      return lib.clampParams(t.inst.type, t.inst.p);
    }

    /** The EQ curve in dB at `freqs` (Hz), without audio. */
    function eqCurve(params, freqs) {
      return S.fx.eqResponse(params, engine.ctx ? engine.ctx.sampleRate : 48000, freqs);
    }

    /** Sets the limiter drive so the whole song measures `target` LUFS. Resolves {integrated, truePeakDb, driveDb, text}. */
    function matchLoudness(target, onProgress) {
      var p = song;
      if (!p.clips.length) return Promise.reject(new Error('Add some audio first.'));
      if (busy) return Promise.reject(new Error('Wait for ' + busy + ' to finish.'));
      lsSet('studio:target', Number(target));
      var before = core.serialize(p), lim = p.master.limiter, rate = 48000;
      var to = core.songEnd(p) + EngineClass.tail(p), pass = 0, last = null;
      var prog = typeof onProgress === 'function' ? onProgress : function () {};
      lim.on = true;
      busy = 'loudness';
      emit('busy', { job: 'loudness' });
      function measure() {
        pass++;
        limiterNote = 'Measuring the whole song, pass ' + pass + '…';
        emit('progress', { job: 'loudness', value: (pass - 1) / 4 });
        return EngineClass.render(p, buffers, { from: 0, to: to, sampleRate: rate, onProgress: function (f) { prog(Math.min(0.99, (pass - 1 + f) / 4)); } })
          .then(function (audio) {
            return S2S.audio.analyzeAsync([audio.getChannelData(0), audio.getChannelData(1)], rate, function () {});
          });
      }
      function step(m) {
        if (!isFinite(m.integrated)) throw new Error('The song is silent, so there is nothing to measure.');
        var diff = target - m.integrated;
        if (Math.abs(diff) <= 0.3 || pass >= 4) return m;
        // How much louder each dB of drive made it last time (limiting gives less than 1 dB per dB).
        var slope = last ? (m.integrated - last.lufs) / (lim.driveDb - last.drive) : 1;
        slope = isFinite(slope) ? Math.min(1, Math.max(0.25, slope)) : 1;
        last = { lufs: m.integrated, drive: lim.driveDb };
        var next = Math.min(core.LIMITER.driveDb.max, Math.max(core.LIMITER.driveDb.min, lim.driveDb + diff / slope));
        if (Math.abs(next - lim.driveDb) < 0.05) return m;
        lim.driveDb = Math.round(next * 10) / 10;
        engine.applyFx(p);
        return measure().then(step);
      }
      return measure().then(step).then(function (m) {
        limiterNote = 'Now ' + m.integrated.toFixed(1) + ' LUFS, true peak ' + m.truePeakDb.toFixed(1) + ' dBTP (drive ' +
          (lim.driveDb > 0 ? '+' : '') + lim.driveDb.toFixed(1) + ' dB).' +
          (Math.abs(m.integrated - target) > 0.5 ? ' The limiter can’t get closer without the drive limit; lower the target or turn the mix up.' : '');
        busy = null;
        prog(1);
        if (p === song) commit(before, 'fxchain');
        emit('busy', { job: null });
        return { integrated: m.integrated, truePeakDb: m.truePeakDb, driveDb: lim.driveDb, text: limiterNote };
      }, function (e) {
        busy = null;
        limiterNote = errText(e, 'Measuring failed.');
        if (p === song) restore(before);
        emit('busy', { job: null });
        throw e;
      });
    }

    // ------------------------------------------------------- import ---

    /** Guesses a preset from a General MIDI program number. */
    function presetForProgram(program, isDrums) {
      var ids = presetList().map(function (pr) { return pr.id; });
      function pick() {
        for (var i = 0; i < arguments.length; i++) if (ids.indexOf(arguments[i]) >= 0) return arguments[i];
        return ids[0];
      }
      if (!S.synth) return null;
      if (isDrums) return pick('drum-kit', '808-kit');
      switch (program == null ? -1 : Math.floor(program / 8)) {
        case 0: return pick('e-piano');
        case 1: return pick('bell', 'e-piano');
        case 2: return pick('organ');
        case 3: return pick('pluck');
        case 4: return pick('sub-bass', 'acid-bass');
        case 5: case 6: return pick('strings', 'soft-pad');
        case 7: return pick('brass-stab');
        case 8: case 9: case 10: return pick('analog-lead');
        case 11: return pick('soft-pad');
        default: return pick('analog-lead');
      }
    }

    /** MIDI files: each part becomes an instrument track with one clip, at o.at. */
    function importMidiFiles(files, o) {
      var p = song, before = core.serialize(p), added = [], failed = [];
      var at = Math.max(0, o.at || 0), wasEmpty = !p.clips.length, insertAt = insertIndex();
      if (!S.midifile) return Promise.reject(new Error('MIDI import did not load.'));
      return files.reduce(function (chain, file) {
        return chain.then(function () {
          return file.arrayBuffer().then(function (ab) {
            var mf = S.midifile.parse(ab);
            if (wasEmpty && !added.length && mf.tempos.length) {
              // An empty song takes the file's tempo and time signature.
              p.bpm = Math.round(Math.min(300, Math.max(20, mf.tempos[0].bpm)) * 100) / 100;
              var ts = mf.timeSigs[0];
              if (ts && core.DENOMINATORS.indexOf(ts.den) >= 0) p.sig = [Math.min(32, Math.max(1, ts.num)), ts.den];
            }
            var parts = mf.tracks.filter(function (t) { return t.notes.length; });
            if (!parts.length) throw new Error('no notes');
            parts.forEach(function (part) {
              var inst = instFromPreset(presetForProgram(part.program, part.isDrums));
              var name = (parts.length === 1 ? baseName(file.name) : part.name || baseName(file.name)).slice(0, 60);
              var t = core.addTrack(p, { name: name, type: 'midi', inst: inst, index: insertAt++ });
              var notes = part.notes.map(function (n) {
                var t0 = S.midifile.beatsToSeconds(mf.tempos, n.start);
                var t1 = S.midifile.beatsToSeconds(mf.tempos, n.start + n.duration);
                return { p: n.pitch, t: t0, d: Math.max(core.MIN_NOTE, t1 - t0), v: n.velocity };
              });
              var end = core.notesEnd(notes), bar = core.barSec(p);
              var c = core.addMidiClip(p, { trackId: t.id, name: name, start: at, duration: Math.max(bar, Math.ceil(end / bar - 1e-6) * bar), notes: notes });
              added.push(c.id);
            });
          }).catch(function (e) {
            failed.push(file.name + ' (' + (e && e.message === 'no notes' ? 'no notes in it' : errText(e, 'unreadable')) + ')');
          });
        });
      }, Promise.resolve()).then(function () {
        if (added.length) commit(before, 'arrange', { fit: wasEmpty });
        return { added: added, failed: failed };
      });
    }

    function importAudioFiles(files, o) {
      var p = song, before = core.serialize(p), added = [], failed = [], wasEmpty = !p.clips.length;
      var at = Math.max(0, o.at || 0), insertAt = insertIndex();
      return files.reduce(function (chain, file, i) {
        return chain.then(function () {
          message('Importing ' + (i + 1) + ' of ' + files.length + ': ' + file.name, 'info', 0);
          return decodeBlob(file).then(function (buffer) {
            var name = baseName(file.name);
            var src = core.addSource(p, { name: name, type: file.type, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });
            addAudio(src.id, buffer, file);
            var trackId = o.trackId && i === 0 && core.getTrack(p, o.trackId) && !core.isMidiTrack(core.getTrack(p, o.trackId))
              ? o.trackId : core.addTrack(p, { name: name, index: insertAt++ }).id;
            var clip = core.addClip(p, { trackId: trackId, sourceId: src.id, start: at });
            if (trackId === o.trackId) core.resolveOverlaps(p, [clip.id]);
            added.push(clip.id);
            if (store) store.saveAudio(p.id, src.id, file).catch(storageFailed);
          }, function (e) {
            failed.push(file.name + ' (' + errText(e, 'unreadable') + ')');
          });
        });
      }, Promise.resolve()).then(function () {
        if (added.length) commit(before, 'arrange', { fit: wasEmpty });
        return { added: added, failed: failed };
      });
    }

    /**
     * Adds audio and MIDI files. Audio: a new track each (or onto o.trackId), at o.at.
     * MIDI: an instrument track per part. Resolves {added: clipIds, failed: descriptions}.
     */
    function importFiles(fileList, o) {
      o = o || {};
      if (o.at == null) o.at = song.tracks.length ? currentPos() : 0;
      var all = [].slice.call(fileList || []), midi = all.filter(isMidiFile), audio = all.filter(isAudioFile);
      var out = { added: [], failed: all.filter(function (f) { return !isMidiFile(f) && !isAudioFile(f); }).map(function (f) { return f.name + ' (not audio or MIDI)'; }) };
      if (!midi.length && !audio.length) {
        message('Those aren’t audio or MIDI files. Drop WAV, MP3, FLAC, AIFF, OGG, M4A or MIDI (.mid) files.', 'warn', 5000);
        return Promise.resolve(out);
      }
      return (midi.length ? importMidiFiles(midi, o) : Promise.resolve({ added: [], failed: [] })).then(function (r) {
        out.added = out.added.concat(r.added);
        out.failed = out.failed.concat(r.failed);
        return audio.length ? importAudioFiles(audio, o) : { added: [], failed: [] };
      }).then(function (r) {
        out.added = out.added.concat(r.added);
        out.failed = out.failed.concat(r.failed);
        if (out.added.length) select(out.added);
        if (out.failed.length) message('Couldn’t read ' + out.failed.join(', ') + '.', 'error', 8000);
        else message('Added ' + out.added.length + ' clip' + (out.added.length === 1 ? '' : 's') + '.', 'success', 2500);
        return out;
      });
    }

    // ------------------------------------------------ files & export ---

    function downloads() {
      if (!downloadsReady) {
        var c = root.claude;
        downloadsReady = c && typeof c.use === 'function'
          ? c.use('downloads').then(function (d) { return d; }, function () { return null; })
          : Promise.resolve(null);
      }
      return downloadsReady;
    }

    /**
     * Hands a file to the user: the downloads capability inside a claude.ai
     * artifact (which only takes ZIPs for audio and MIDI), a normal download elsewhere.
     * Resolves 'saved' or 'started'.
     */
    function saveFile(name, blob) {
      return downloads().then(function (dl) {
        if (dl) {
          if (/\.(wav|mid)$/i.test(name)) {
            var z = new S.zip.ZipWriter();
            return blob.arrayBuffer().then(function (ab) {
              z.add(name, ab);
              return saveFile(name.replace(/\.(wav|mid)$/i, '.zip'), z.finish());
            });
          }
          return dl.save({ filename: name, data: blob }).then(function () { return 'saved'; }, function (e) {
            var code = e && e.code;
            if (code === 'declined') throw new Error('Not saved: the download was declined.');
            if (code === 'too_large') throw new Error('The file is too large to save from here.');
            throw new Error('Saving files isn’t available in this view (' + (code || 'unavailable') + ').');
          });
        }
        var doc = root.document;
        if (!doc) return 'started';
        var url = URL.createObjectURL(blob), a = doc.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        doc.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
        return 'started';
      });
    }

    /** A song file: song.json plus the original audio, in one ZIP. Resolves {file, how}. */
    function saveSongFile(o) {
      var p = song, ids = usedSourceIds(p), z = new S.zip.ZipWriter();
      var copy = JSON.parse(core.serialize(p));
      copy.sources = {};
      ids.forEach(function (id) { copy.sources[id] = p.sources[id]; });
      return ids.reduce(function (chain, id) {
        return chain.then(function () {
          var blob = blobs[id], buffer = buffers[id];
          if (blob) return blob.arrayBuffer().then(function (ab) { z.add('audio/' + id + '.' + extFor(p.sources[id], blob), ab); });
          if (buffer) z.add('audio/' + id + '.wav', S.wav.encodeWav(channelsOf(buffer), buffer.sampleRate, { bits: 32 }));
          return null;
        });
      }, Promise.resolve()).then(function () {
        z.add('song.json', JSON.stringify(copy));
        var file = { name: safeName(p.name) + '.studio.zip', blob: z.finish() };
        if (o && o.save === false) return { file: file, how: null };
        return saveFile(file.name, file.blob).then(function (how) { return { file: file, how: how }; });
      });
    }

    /** Opens a .studio.zip song file (a File or Blob). Resolves {song, missing}. */
    function openSongFile(file) {
      message('Opening ' + (file.name || 'the song file') + '…', 'info', 0);
      return file.arrayBuffer().then(S.zip.readZip).then(function (entries) {
        var songEntry = entries.filter(function (e) { return /(^|\/)song\.json$/.test(e.name); })[0];
        if (!songEntry) throw new Error('This ZIP has no song.json, so it isn’t a Stem to Stream Studio song file.');
        var p = core.parseProject(new TextDecoder().decode(songEntry.data));
        p.id = core.uid('p');
        var missing = 0;
        return Object.keys(p.sources).reduce(function (chain, sid) {
          return chain.then(function () {
            var entry = entries.filter(function (e) { return e.name.indexOf('audio/' + sid + '.') >= 0; })[0];
            if (!entry) { missing++; return null; }
            var ext = entry.name.split('.').pop().toLowerCase();
            var blob = new Blob([entry.data], { type: ext === 'wav' ? 'audio/wav' : 'audio/' + ext });
            delete p.sources[sid].demo;
            return decodeBlob(blob).then(function (b) {
              addAudio(sid, b, blob);
              if (store) return store.saveAudio(p.id, sid, blob).catch(storageFailed);
              return null;
            }, function () { missing++; });
          });
        }, Promise.resolve()).then(function () {
          setSong(p);
          message(missing ? missing + ' audio file(s) in the song file couldn’t be read.' : 'Opened “' + p.name + '”.', missing ? 'warn' : 'success', missing ? 7000 : 2500);
          return { song: p, missing: missing };
        });
      }, function (e) {
        message(errText(e, 'Couldn’t open that file.'), 'error', 7000);
        throw e;
      });
    }

    /** What the export dialog needs to offer. */
    function exportInfo() {
      var p = song, rates = Object.keys(p.sources).map(function (id) { return p.sources[id].sampleRate; });
      return {
        songEnd: core.songEnd(p),
        hasClips: p.clips.length > 0,
        hasLoop: p.loop.end - p.loop.start >= core.MIN_LOOP,
        loop: { start: p.loop.start, end: p.loop.end },
        hasMidi: p.tracks.some(core.isMidiTrack),
        defaultRate: rates.indexOf(48000) < 0 && rates.indexOf(44100) >= 0 ? 44100 : 48000,
        missingAudio: p.clips.filter(function (c) { return !c.disabled && !core.isMidiClip(c) && !buffers[c.sourceId]; }).length
      };
    }

    function exportRange(o) {
      var p = song;
      if (o.range === 'loop') return { from: p.loop.start, to: p.loop.end, suffix: ' (loop)' };
      // A whole-song export keeps the reverb, delay and release tails after the last clip.
      return { from: 0, to: core.songEnd(p) + EngineClass.tail(p), suffix: '' };
    }

    /** Loudness and peak checks of an exported mix (the course's Master Check rules). */
    function mixChecks(m, peak, bits) {
      var out = [], ceiling = m.integrated > -14 ? -2 : -1;
      if (peak > 1 && bits !== 32) {
        out.push({ tone: 'fail', text: 'Clipped: the mix went past 0 dBFS and the file was cut off there. Lower the master by ' + (20 * Math.log10(peak) + 1).toFixed(1) + ' dB and export again.' });
      } else if (m.truePeakDb > ceiling) {
        out.push({ tone: 'warn', text: 'True peak is above ' + ceiling + ' dBTP, Spotify’s ceiling for a master at this loudness. Lower the master by ' + (m.truePeakDb - ceiling).toFixed(1) + ' dB, or limit it when you master.' });
      } else {
        out.push({ tone: 'pass', text: 'Peaks are under the ' + ceiling + ' dBTP streaming ceiling.' });
      }
      if (isFinite(m.integrated) && m.integrated < -20) {
        out.push({ tone: 'info', text: 'Quiet for a release (Spotify plays at −14 LUFS). Fine if you’re going to master it next.' });
      }
      return out;
    }

    /**
     * The mix as one stereo WAV. o: {range: 'song'|'loop', bits: 16|24|32, rate: 44100|48000, save?: true}.
     * Resolves {file: {name, blob}, how, analysis, peak, limiter, checks: [{tone, text}]}.
     */
    function exportMix(o, onProgress) {
      o = o || {};
      var p = song, bits = Number(o.bits) || 24, rate = Number(o.rate) || 48000, r = exportRange(o);
      var prog = typeof onProgress === 'function' ? onProgress : function () {};
      if (!p.clips.length) return Promise.reject(new Error('Nothing to export yet. Add some audio first.'));
      if (engine.playing) pause();
      var result = { checks: [] };
      return EngineClass.render(p, buffers, { from: r.from, to: r.to, sampleRate: rate, onProgress: function (f) { prog(f * 0.5); } })
        .then(function (audio) {
          var ch = [audio.getChannelData(0), audio.getChannelData(1)];
          result.peak = S.wav.peak(ch);
          result.limiter = audio.limiter;
          var bytes = S.wav.encodeWav(ch, rate, { bits: bits });
          result.file = { name: safeName(p.name) + ' - mix' + r.suffix + '.wav', blob: new Blob([bytes], { type: 'audio/wav' }) };
          prog(0.55);
          return S2S.audio.analyzeAsync(ch, rate, function (f) { prog(0.55 + f * 0.4); });
        })
        .then(function (m) {
          result.analysis = m;
          result.checks = mixChecks(m, result.peak, bits);
          if (result.limiter === 'basic' && p.master.limiter.on) result.checks.push({ tone: 'info', text: 'This browser blocked the precise limiter, so the basic one was used. Check the true peak above.' });
          var missing = exportInfo().missingAudio;
          if (missing) result.checks.unshift({ tone: 'warn', text: missing + ' clip' + (missing > 1 ? 's have' : ' has') + ' no audio in this browser and played silent.' });
          prog(1);
          if (o.save === false) return null;
          return saveFile(result.file.name, result.file.blob);
        })
        .then(function (how) { result.how = how; return result; });
    }

    /** One WAV per audible track (track effects on, master effects and limiter off), in a ZIP. */
    function exportStems(o, onProgress) {
      o = o || {};
      var p = song, bits = Number(o.bits) || 24, rate = Number(o.rate) || 48000, r = exportRange(o);
      var prog = typeof onProgress === 'function' ? onProgress : function () {};
      var tracks = p.tracks.filter(function (t) {
        return core.trackAudible(p, t) && p.clips.some(function (c) { return c.trackId === t.id && !c.disabled; });
      });
      if (!tracks.length) return Promise.reject(new Error('No track is playing: unmute a track with audio on it.'));
      if (engine.playing) pause();
      var z = new S.zip.ZipWriter(), names = {}, result = {};
      return tracks.reduce(function (chain, t, i) {
        return chain.then(function () {
          return EngineClass.render(p, buffers, {
            from: r.from, to: r.to, sampleRate: rate, trackIds: [t.id], master: false,
            onProgress: function (f) { prog((i + f) / tracks.length * 0.95); }
          }).then(function (audio) {
            var file = ('0' + (i + 1)).slice(-2) + ' ' + safeName(t.name), n = file, k = 2;
            while (names[n]) n = file + ' ' + k++;
            names[n] = true;
            z.add(n + '.wav', S.wav.encodeWav([audio.getChannelData(0), audio.getChannelData(1)], rate, { bits: bits }));
          });
        });
      }, Promise.resolve()).then(function () {
        result.file = { name: safeName(p.name) + ' - stems' + r.suffix + '.zip', blob: z.finish() };
        result.count = tracks.length;
        result.checks = [{ tone: 'pass', text: tracks.length + ' stems, ' + bits + '-bit ' + (rate / 1000) + ' kHz, each the full length of the export so they line up. Each has its track effects; the master effects and limiter are left off.' }];
        prog(1);
        if (o.save === false) return null;
        return saveFile(result.file.name, result.file.blob);
      }).then(function (how) { result.how = how; return result; });
    }

    /** Every instrument track as a type 1 MIDI file (480 PPQ, drums on channel 10). */
    function exportMidi(o) {
      var p = song, mf = core.midiExport(p), n = 0;
      mf.tracks.forEach(function (t) { n += t.notes.length; });
      if (!n) return Promise.reject(new Error('The instrument tracks have no notes yet.'));
      var bytes = S.midifile.write(mf, { ppq: 480 });
      var result = {
        file: { name: safeName(p.name) + '.mid', blob: new Blob([bytes], { type: 'audio/midi' }) },
        tracks: mf.tracks.length, notes: n,
        checks: [{ tone: 'pass', text: mf.tracks.length + ' track' + (mf.tracks.length > 1 ? 's' : '') + ', ' + n + ' notes at ' + p.bpm + ' BPM. Drum kits are on channel 10.' }]
      };
      if (o && o.save === false) return Promise.resolve(result);
      return saveFile(result.file.name, result.file.blob).then(function (how) { result.how = how; return result; });
    }

    // ------------------------------------------------- vocal tools ---

    function setProgress(f) {
      progressValue = f;
      var t = now();
      if (t - progressAt < 100 && f < 1) return;
      progressAt = t;
      emit('progress', { job: busy, value: f });
    }

    /** Runs one tool; `work` resolves {text, ...}. Only one at a time. */
    function runJob(name, work) {
      if (busy) return Promise.reject(new Error('Wait for ' + busy + ' to finish.'));
      busy = name;
      progressValue = 0;
      results[name] = '';
      emit('busy', { job: name });
      return Promise.resolve().then(work).then(function (res) {
        busy = null;
        results[name] = res.text;
        emit('busy', { job: null, done: name });
        return res;
      }, function (e) {
        busy = null;
        results[name] = 'Didn’t work: ' + errText(e, 'unknown error');
        emit('busy', { job: null, done: name });
        throw e;
      });
    }

    function needClip(clipId) {
      var c = core.getClip(song, clipId || sel.clips[0]);
      if (!c) throw new Error('Select a clip on the timeline first.');
      if (core.isMidiClip(c)) throw new Error('Vocal tools work on audio clips. For MIDI, use the piano roll: Quantize fixes timing.');
      if (!buffers[c.sourceId]) throw new Error('This clip’s audio is missing. Import the file again.');
      return c;
    }

    /** The song (or some of its tracks) rendered for analysis: no master effects, mute and solo ignored. */
    function renderTracks(trackIds) {
      var q = core.parseProject(core.serialize(song));
      q.tracks.forEach(function (t) { t.mute = false; t.solo = false; });
      return EngineClass.render(q, buffers, { from: 0, to: Math.max(0.5, core.songEnd(q)), sampleRate: ANALYSIS_RATE, trackIds: trackIds, master: false })
        .then(function (audio) { return [audio.getChannelData(0), audio.getChannelData(1)]; });
    }

    function tracksWithAudio(exceptId) {
      var p = song;
      return p.tracks.filter(function (t) {
        return t.id !== exceptId && p.clips.some(function (c) {
          return c.trackId === t.id && !c.disabled && (core.isMidiClip(c) ? c.notes.length > 0 : !!buffers[c.sourceId]);
        });
      }).map(function (t) { return t.id; });
    }

    /** Adds processed audio as a new version of the clip's source, on every clip using it. */
    function addVersion(clip, channels, sampleRate, label, sameShiftOnly) {
      var p = song, src = p.sources[clip.sourceId], id = core.uid('s');
      var buffer = makeBuffer(channels.length, channels[0].length, sampleRate);
      channels.forEach(function (d, i) { buffer.copyToChannel(d, i); });
      var blob = new Blob([S.wav.encodeWav(channels, sampleRate, { bits: 32 })], { type: 'audio/wav' });
      addAudio(id, buffer, blob);
      saveAudioBlob(id, blob);
      var shift = clip.start - clip.offset, from = clip.sourceId, count = 0;
      edit(function (q) {
        core.addSource(q, {
          id: id, name: (src ? src.name : 'Audio') + ' · ' + label, type: 'audio/wav',
          duration: channels[0].length / sampleRate, sampleRate: sampleRate, channels: channels.length
        });
        q.clips.forEach(function (c) {
          if (c.sourceId !== from) return;
          if (sameShiftOnly && Math.abs(c.start - c.offset - shift) > 0.001) return;
          core.addVersion(c, id);
          count++;
        });
      }, 'arrange');
      return count;
    }

    /** Tempo and bar 1 from the music. */
    function detectGrid() {
      return runJob('grid', function () {
        var ids = tracksWithAudio(null);
        if (!ids.length) throw new Error('Add some audio first.');
        return renderTracks(ids).then(function (ch) {
          return S.jobs.run('grid', { channels: ch, sampleRate: ANALYSIS_RATE }, {}, setProgress);
        }).then(function (r) {
          var bpm = Math.round(r.bpm * 100) / 100, bar1 = Math.round(r.barOffset * 1e6) / 1e6;
          edit(function (q) { q.bpm = bpm; q.gridOffset = bar1; }, 'song');
          return {
            text: bpm + ' BPM, bar 1 at ' + core.fmtClock(bar1) + '.' + (r.confidence < 0.3
              ? ' Low confidence: play it with the metronome and fix the tempo by hand if it drifts.'
              : ' Play it with the metronome to check.'),
            bpm: bpm, barOffset: bar1, confidence: r.confidence
          };
        });
      });
    }

    /** Half (0.5) or double (2) the tempo; bar 1 stays. */
    function scaleTempo(f) {
      var bpm = Math.round(song.bpm * f * 100) / 100;
      if (bpm < 20 || bpm > 300) return false;
      results.grid = '';
      return edit(function (q) { q.bpm = bpm; }, 'song');
    }

    /**
     * Reduces AI artifacts. o: {preset: 'vocal'|'mix'|'gentle', steps: {declick, lowEnd, denoise, deshimmer, deess}}
     * (a step set to false is skipped). Adds a 'cleaned' version.
     */
    function cleanUp(clipId, o) {
      o = o || {};
      return runJob('clean', function () {
        var c = needClip(clipId), buf = buffers[c.sourceId], jo = { preset: o.preset || 'vocal' };
        Object.keys(o.steps || {}).forEach(function (k) { if (o.steps[k] === false) jo[k] = false; });
        return S.jobs.run('clean', { channels: channelsOf(buf), sampleRate: buf.sampleRate }, jo, setProgress).then(function (r) {
          var n = addVersion(c, r.channels, buf.sampleRate, 'cleaned');
          var details = (r.report || []).map(function (x) { return x.detail; }).filter(Boolean);
          return {
            text: (details.length ? details.join('. ') + '.' : 'Cleaned.') + ' Now playing the cleaned version' + (n > 1 ? ' on ' + n + ' clips' : '') + '.',
            report: r.report
          };
        });
      });
    }

    function gridFor(subdivision) {
      return { bpm: song.bpm, offset: song.gridOffset, subdivision: Number(subdivision) === 8 ? 8 : 16 };
    }

    /** Where each syllable lands against the grid. Sets marks[clipId] = [{t: songTime, ok}]. */
    function checkTiming(clipId, o) {
      o = o || {};
      return runJob('timing', function () {
        var c = needClip(clipId), buf = buffers[c.sourceId];
        return S.jobs.run('timing', { channels: channelsOf(buf), sampleRate: buf.sampleRate }, {
          grid: gridFor(o.subdivision), shift: c.start - c.offset, from: c.offset, to: c.offset + c.duration, toleranceMs: 25
        }, setProgress).then(function (r) {
          var rep = r.report;
          marks[c.id] = rep.items.map(function (it) { return { t: it.time, ok: Math.abs(it.deviationMs) <= 25 }; });
          emit('change', { kind: 'marks' });
          if (!rep.items.length) return { text: 'No syllables found in this clip. Is it a vocal with singing in it?', report: rep };
          return {
            text: rep.items.length + ' syllables: ' + rep.onGrid + ' on the grid (within 25 ms), ' + rep.late + ' late, ' + rep.early +
              ' early. Typically ' + fmtMs(rep.medianAbsMs) + ' off. Ticks on the clip: green on the grid, amber off it.',
            report: rep
          };
        });
      });
    }

    /** Moves late or early phrases toward the grid. o: {strength 0..1 (default 0.6), subdivision 8|16}. */
    function tighten(clipId, o) {
      o = o || {};
      return runJob('timing', function () {
        var c = needClip(clipId), buf = buffers[c.sourceId];
        return S.jobs.run('tighten', { channels: channelsOf(buf), sampleRate: buf.sampleRate }, {
          grid: gridFor(o.subdivision), shift: c.start - c.offset, strength: o.strength != null ? Number(o.strength) : 0.6, maxShiftMs: 80, toleranceMs: 15
        }, setProgress).then(function (r) {
          delete marks[c.id];
          if (!r.report.moved) return { text: 'Nothing to move: every phrase is already within 15 ms of the grid.', report: r.report };
          addVersion(c, r.channels, buf.sampleRate, 'tightened', true);
          return {
            text: 'Moved ' + r.report.moved + ' phrases toward the grid. Typical timing error ' + fmtMs(r.report.before.medianAbsMs) +
              ' → ' + fmtMs(r.report.after.medianAbsMs) + '. Listen for doubled or cut syllables; use a lower strength if you hear any.',
            report: r.report
          };
        });
      });
    }

    /** Shifts the clip's whole track so it lines up with the other tracks. */
    function lineUp(clipId) {
      return runJob('timing', function () {
        var c = needClip(clipId), others = tracksWithAudio(c.trackId), mine;
        if (!others.length) throw new Error('Lining up needs at least one other track with audio to compare against.');
        return renderTracks([c.trackId]).then(function (ch) {
          mine = ch;
          return renderTracks(others);
        }).then(function (ref) {
          return S.jobs.run('align', { channels: mine, ref: ref, sampleRate: ANALYSIS_RATE }, { maxLag: 0.25 }, setProgress);
        }).then(function (r) {
          var ms = Math.round(r.offset * 1000), track = core.getTrack(song, c.trackId);
          if (Math.abs(r.offset) < 0.004) return { text: track.name + ' is already lined up with the music (within 4 ms).', offset: r.offset };
          if (r.confidence < 0.2) return { text: 'No clear offset found (' + ms + ' ms at low confidence). This part may not share the beat with the others, so nothing was moved.', offset: r.offset };
          edit(function (q) {
            q.clips.forEach(function (x) { if (x.trackId === c.trackId) x.start = Math.max(0, x.start - r.offset); });
          }, 'arrange');
          return { text: 'Moved ' + track.name + ' ' + Math.abs(ms) + ' ms ' + (ms > 0 ? 'earlier' : 'later') + ' to line up with the music. Undo if it sounds worse.', offset: r.offset };
        });
      });
    }

    function keyOf(clipId, scale) {
      var c = core.getClip(song, clipId || sel.clips[0]), ids = tracksWithAudio(c ? c.trackId : null);
      if (!ids.length) ids = tracksWithAudio(null);
      if (!ids.length) return Promise.reject(new Error('Add some audio first.'));
      return renderTracks(ids).then(function (ch) {
        return S.jobs.run('key', { channels: ch, sampleRate: ANALYSIS_RATE }, {}, function (f) { setProgress(f * scale); });
      }).then(function (k) {
        detectedKey = k;
        emit('change', { kind: 'key' });
        return k;
      });
    }

    /** The song's key, from the other tracks (or all of them). */
    function detectKey(clipId) {
      return runJob('pitch', function () {
        return keyOf(clipId, 1).then(function (k) {
          return { text: 'The music is in ' + k.name + ' (confidence ' + Math.round(k.confidence * 100) + '%).', key: k };
        });
      });
    }

    /**
     * Corrects the clip's pitch to a key. o: {key: 'auto'|'C'..'B', mode: 'auto'|'major'|'minor'|'chromatic',
     * speed ms (0 = instant, default 40), strength 0..1 (default 1), vibrato 0..1 (default 0.3)}.
     */
    function tune(clipId, o) {
      o = o || {};
      return runJob('pitch', function () {
        var c = needClip(clipId), buf = buffers[c.sourceId];
        var wantKey = o.key || 'auto', wantMode = o.mode || 'auto';
        var keyReady = wantKey === 'auto' || wantMode === 'auto'
          ? (detectedKey ? Promise.resolve(detectedKey) : keyOf(clipId, 0.2))
          : Promise.resolve(null);
        return keyReady.then(function (k) {
          return S.jobs.run('tune', { channels: channelsOf(buf), sampleRate: buf.sampleRate }, {
            key: wantKey === 'auto' ? k.key : wantKey,
            mode: wantMode === 'auto' ? k.mode : wantMode,
            speed: o.speed != null ? Number(o.speed) : 40,
            strength: o.strength != null ? Number(o.strength) : 1,
            vibrato: o.vibrato != null ? Number(o.vibrato) : 0.3,
            tuningCents: k && k.tuningCents ? k.tuningCents : 0
          }, function (f) { setProgress(0.2 + f * 0.8); });
        }).then(function (r) {
          var rep = r.report;
          if (!rep.voicedSeconds) return { text: 'No sung notes found in this clip, so nothing was changed.', report: rep };
          addVersion(c, r.channels, buf.sampleRate, 'tuned');
          return {
            text: 'Tuned to ' + rep.name + ' over ' + rep.voicedSeconds.toFixed(1) + ' s of singing. Average pitch error ' +
              Math.round(rep.centsBefore) + ' → ' + Math.round(rep.centsAfter) + ' cents.',
            report: rep
          };
        });
      });
    }

    /** The clip's melody as notes on a new instrument track right below it. Resolves {text, trackId, clipId, notes}. */
    function melodyToMidi(clipId, presetId) {
      return runJob('melody', function () {
        var c = needClip(clipId), buf = buffers[c.sourceId];
        return S.jobs.run('melody', { channels: channelsOf(buf), sampleRate: buf.sampleRate }, {
          from: c.offset, to: c.offset + c.duration
        }, setProgress).then(function (r) {
          if (!r.notes.length) return { text: 'No sung or played notes found. Melody to MIDI needs one voice or instrument, such as a lead vocal stem.', notes: 0 };
          var inst = instFromPreset(presetId || 'analog-lead');
          var made = edit(function (q) {
            var src = core.getTrack(q, c.trackId);
            var t = core.addTrack(q, { name: ((src ? src.name : c.name) + ' MIDI').slice(0, 60), type: 'midi', inst: inst, index: core.trackIndex(q, c.trackId) + 1 });
            var m = core.addMidiClip(q, { trackId: t.id, name: c.name + ' (MIDI)', start: c.start, offset: c.offset, duration: c.duration, notes: r.notes });
            return { t: t, m: m };
          }, 'arrange');
          var tuneNote = r.tuningCents ? ' The part sits ' + Math.abs(r.tuningCents) + ' cents ' + (r.tuningCents > 0 ? 'sharp' : 'flat') + ' of standard tuning, so notes are rounded from there.' : '';
          return {
            text: 'Made ' + r.notes.length + ' notes on a new instrument track, “' + made.t.name + '”.' + tuneNote + ' Fix any wrong notes in the piano roll.',
            trackId: made.t.id, clipId: made.m.id, notes: r.notes.length
          };
        });
      });
    }

    /** The clip's audio versions, oldest (the original) first. */
    function versionsOf(clipId) {
      var c = core.getClip(song, clipId);
      if (!c || core.isMidiClip(c)) return [];
      var list = c.versions && c.versions.length ? c.versions : [c.sourceId];
      return list.map(function (id, i) {
        var s = song.sources[id];
        return { id: id, label: i === 0 ? 'Original' : (s ? s.name.split(' · ').slice(1).join(' + ') : 'Version ' + (i + 1)), current: id === c.sourceId };
      });
    }

    /** Plays another version of the clip's audio (on every clip sharing it). */
    function useVersion(clipId, sourceId) {
      var clip = core.getClip(song, clipId);
      if (!clip) return false;
      var from = clip.sourceId;
      return edit(function (q) {
        var n = 0;
        q.clips.forEach(function (c) {
          if (c.sourceId === from && c.versions && c.versions.indexOf(sourceId) >= 0) { c.sourceId = sourceId; n++; }
        });
        if (!n) return false;
      }, 'arrange');
    }

    // --------------------------------------------------------- MIDI ---

    /** A new, empty MIDI clip on an instrument track. Resolves to its id. */
    function newMidiClip(trackId, at, length) {
      var t = core.getTrack(song, trackId);
      if (!t || !core.isMidiTrack(t)) return null;
      var id = edit(function (q) {
        var x = core.addMidiClip(q, { trackId: trackId, name: t.name, start: at != null ? Math.max(0, at) : barAtPlayhead(q), duration: length || core.barSec(q) });
        core.resolveOverlaps(q, [x.id]);
        return x.id;
      }, 'arrange');
      sel.track = trackId;
      select([id]);
      return id;
    }

    function midiClip(q, clipId) {
      var c = core.getClip(q, clipId);
      return c && core.isMidiClip(c) ? c : null;
    }

    /** Grid step (seconds) for a note grid like '1/16' or '1/8t'. */
    function noteStep(grid) { return core.snapStep(song, grid || '1/16') || core.quarterSec(song) / 4; }

    /** Snaps a song time to a note grid (floor: the grid line before it). */
    function snapNote(t, grid, floor) {
      var step = noteStep(grid), k = (t - song.gridOffset) / step;
      return song.gridOffset + (floor ? Math.floor(k + 1e-9) : Math.round(k)) * step;
    }

    /**
     * Replaces a MIDI clip's notes ([{p, t, d, v}], t in source time: song time = t + start − offset).
     * Live inside a gesture; notes are sorted by time when the edit is recorded.
     */
    function setNotes(clipId, notes) {
      return apply(function (q) {
        var c = midiClip(q, clipId);
        if (!c) return false;
        c.notes = notes.map(function (n) { return { p: n.p, t: n.t, d: n.d, v: n.v }; });
      }, 'notes');
    }

    /** Adds a note at song time `songT` (snapped down to `grid` unless free). Resolves the note's index. */
    function addNote(clipId, pitch, songT, o) {
      o = o || {};
      var idx = edit(function (q) {
        var c = midiClip(q, clipId);
        if (!c) return false;
        var s = Math.max(c.start, o.free ? songT : snapNote(songT, o.grid, true));
        var n = { p: core.clamp(Math.round(pitch), 0, 127), t: s - c.start + c.offset, d: o.length || noteStep(o.grid), v: o.velocity || 100 };
        c.notes.push(n);
        core.sortNotes(c.notes);
        fitClip(c);
        return c.notes.indexOf(n);
      }, 'notes');
      return idx === false ? -1 : idx;
    }

    function deleteNotes(clipId, indexes) {
      return edit(function (q) {
        var c = midiClip(q, clipId);
        if (!c || !indexes || !indexes.length) return false;
        c.notes = c.notes.filter(function (n, i) { return indexes.indexOf(i) < 0; });
      }, 'notes');
    }

    function eachNote(c, indexes, fn) {
      (indexes && indexes.length ? indexes : c.notes.map(function (n, i) { return i; })).forEach(function (i) {
        if (c.notes[i]) fn(c.notes[i]);
      });
    }

    /** Transposes notes (all when indexes is empty) by `semitones`. */
    function transposeNotes(clipId, indexes, semitones) {
      return edit(function (q) {
        var c = midiClip(q, clipId);
        if (!c) return false;
        eachNote(c, indexes, function (n) { n.p = core.clamp(n.p + semitones, 0, 127); });
      }, 'notes');
    }

    function moveNotes(clipId, indexes, seconds) {
      return edit(function (q) {
        var c = midiClip(q, clipId);
        if (!c) return false;
        eachNote(c, indexes, function (n) { n.t = Math.max(0, n.t + seconds); });
      }, 'notes');
    }

    /** Velocity 1–127 of notes. Live inside a gesture. */
    function setVelocity(clipId, indexes, v) {
      return apply(function (q) {
        var c = midiClip(q, clipId);
        if (!c) return false;
        eachNote(c, indexes, function (n) { n.v = core.clamp(Math.round(v), 1, 127); });
      }, 'notes');
    }

    /** Copies notes to right after themselves (rounded up to whole grid steps). Resolves the copies' indexes. */
    function duplicateNotes(clipId, indexes, grid) {
      var copies = [];
      edit(function (q) {
        var c = midiClip(q, clipId);
        if (!c || !indexes || !indexes.length) return false;
        var a = Infinity, b = 0, step = noteStep(grid);
        eachNote(c, indexes, function (n) { a = Math.min(a, n.t); b = Math.max(b, n.t + n.d); });
        var len = Math.max(step, Math.ceil((b - a) / step - 1e-6) * step);
        eachNote(c, indexes, function (n) { copies.push({ p: n.p, t: n.t + len, d: n.d, v: n.v }); });
        copies.forEach(function (n) { c.notes.push(n); });
        core.sortNotes(c.notes);
        fitClip(c);
      }, 'notes');
      var c2 = midiClip(song, clipId);
      return c2 ? copies.map(function (n) { return c2.notes.indexOf(n); }).filter(function (i) { return i >= 0; }) : [];
    }

    /** Moves notes (all when indexes is null) toward `grid` by strength 0..1. */
    function quantize(clipId, indexes, grid, strength) {
      return edit(function (q) {
        var c = midiClip(q, clipId);
        if (!c) return false;
        core.quantizeNotes(q, c, indexes && indexes.length ? indexes : null, noteStep(grid), strength == null ? 1 : strength);
      }, 'notes');
    }

    /**
     * Drags notes in the piano roll. mode 'move': update(dtSeconds, dSemitones, free?);
     * 'length': update(dtSeconds, free?) on the note ends; 'velocity': update(v).
     * Times snap to o.grid (default '1/16') by the first note's start (or end).
     */
    function dragNotes(clipId, indexes, mode, o) {
      o = o || {};
      var c0 = midiClip(song, clipId);
      if (!c0) return session('notes', function () {});
      var idx = indexes && indexes.length ? indexes.slice() : c0.notes.map(function (n, i) { return i; });
      var orig = idx.map(function (i) { var n = c0.notes[i]; return n ? { i: i, t: n.t, p: n.p, d: n.d, v: n.v } : null; }).filter(Boolean);
      var a = orig[0];
      return session('notes', function (x, y, z) {
        var c = midiClip(song, clipId);
        if (!c || !a) return;
        if (mode === 'velocity') {
          orig.forEach(function (ob) { if (c.notes[ob.i]) c.notes[ob.i].v = core.clamp(Math.round(x), 1, 127); });
          return;
        }
        var shift = c.start - c.offset;
        if (mode === 'length') {
          var free = y, endSong = a.t + a.d + shift + (Number(x) || 0);
          var newEnd = free ? endSong : snapNote(endSong, o.grid);
          var dd = newEnd - (a.t + a.d + shift), minLen = free ? core.MIN_NOTE : noteStep(o.grid) * 0.5;
          orig.forEach(function (ob) { if (c.notes[ob.i]) c.notes[ob.i].d = Math.max(minLen, ob.d + dd); });
          return;
        }
        var startSong = a.t + shift, raw = startSong + (Number(x) || 0);
        var dt = (z ? raw : snapNote(raw, o.grid)) - startSong, dp = Math.round(Number(y) || 0);
        var minT = Infinity, minP = 127, maxP = 0;
        orig.forEach(function (ob) { minT = Math.min(minT, ob.t); minP = Math.min(minP, ob.p); maxP = Math.max(maxP, ob.p); });
        dt = Math.max(dt, -minT);
        dp = core.clamp(dp, -minP, 127 - maxP);
        orig.forEach(function (ob) {
          var n = c.notes[ob.i];
          if (n) { n.t = ob.t + dt; n.p = ob.p + dp; }
        });
      });
    }

    /** Plays one note now on an instrument track (previews). */
    function audition(trackId, pitch, velocity, duration) {
      try { engine.audition(song, trackId, pitch, velocity || 100, duration || 0.35); } catch (e) { message(errText(e, 'No audio.'), 'error'); }
    }

    /** Live playing: velocity > 0 is note on, 0 is note off. */
    function liveNote(trackId, pitch, velocity) {
      try { engine.liveNote(song, trackId, pitch, velocity); } catch (e) { message(errText(e, 'No audio.'), 'error'); }
    }

    function midiTrackForInput() {
      var id = typeof midiTarget === 'function' ? midiTarget() : midiTarget;
      var t = id && core.getTrack(song, id);
      if (t && core.isMidiTrack(t)) return t.id;
      t = sel.track && core.getTrack(song, sel.track);
      if (t && core.isMidiTrack(t)) return t.id;
      var c = core.getClip(song, sel.clips[0]);
      return c && core.isMidiClip(c) ? c.trackId : null;
    }

    function onMidiMessage(ev) {
      var d = ev.data, type = d[0] & 0xf0, pitch = d[1], vel = d[2], id = midiTrackForInput();
      if (!id) return;
      if (type === 0x90 && vel > 0) liveNote(id, pitch, vel);
      else if (type === 0x80 || (type === 0x90 && vel === 0)) liveNote(id, pitch, 0);
    }

    /**
     * Plays MIDI keyboards through an instrument track (Chrome and Edge; call from a click).
     * target: a track id or a function returning one; default the selected instrument track.
     * Resolves {name}.
     */
    function connectMidiInput(target) {
      midiTarget = target || null;
      var nav = root.navigator;
      if (!nav || !nav.requestMIDIAccess) return Promise.reject(new Error('This browser can’t use MIDI keyboards. Chrome and Edge can.'));
      return nav.requestMIDIAccess().then(function (access) {
        midiAccess = access;
        function hook() {
          var names = [];
          access.inputs.forEach(function (input) { input.onmidimessage = onMidiMessage; names.push(input.name); });
          midiName = names.length ? names[0] + (names.length > 1 ? ' +' + (names.length - 1) : '') : '';
          emit('midi', { name: midiName });
        }
        hook();
        access.onstatechange = hook;
        return { name: midiName };
      }, function () {
        throw new Error('MIDI access was blocked. Allow MIDI devices for this page and try again.');
      });
    }

    // ---------------------------------------------------- drawing ---

    /**
     * Waveform columns for part of an audio clip, scaled by its gain and fades:
     * {max, rms} Float32Arrays of length `columns`, 0..1. from/to are seconds
     * from the clip's start (default the whole clip). null for MIDI or missing audio.
     */
    function waveform(clipId, columns, from, to) {
      var c = core.getClip(song, clipId);
      if (!c || core.isMidiClip(c)) return null;
      var pk = peaks[c.sourceId];
      if (!pk) return null;
      columns = Math.max(1, Math.round(columns));
      from = from == null ? 0 : Math.max(0, from);
      to = to == null ? c.duration : Math.min(c.duration, to);
      var secPerCol = Math.max(1e-6, (to - from) / columns);
      var L = pk.levels[0];
      if (secPerCol > (L.block / pk.sampleRate) * 24 && pk.levels[1]) L = pk.levels[1];
      var bs = L.block / pk.sampleRate, n = L.max.length, k = core.dbToGain(c.gainDb || 0);
      var max = new Float32Array(columns), rms = new Float32Array(columns);
      for (var x = 0; x < columns; x++) {
        var tc = from + x * secPerCol, ts = c.offset + tc, i0 = Math.floor(ts / bs);
        if (i0 >= n) break;
        var i1 = Math.min(n, Math.max(i0 + 1, Math.floor((ts + secPerCol) / bs))), m = 0, r = 0;
        for (var i = i0; i < i1; i++) {
          if (L.max[i] > m) m = L.max[i];
          if (L.rms[i] > r) r = L.rms[i];
        }
        var f = k * core.fadeGain(c, tc);
        max[x] = Math.min(1, m * f);
        rms[x] = Math.min(1, r * f);
      }
      return { max: max, rms: rms };
    }

    /**
     * A MIDI clip's notes for drawing: {lo, hi, notes: [{i, p, start, end, v}]} with
     * start/end in seconds from the clip's start (cut to the clip) and lo..hi the pitch range shown.
     */
    function noteBars(clipId) {
      var c = core.getClip(song, clipId);
      if (!c || !core.isMidiClip(c)) return null;
      var lo = 127, hi = 0, out = [];
      c.notes.forEach(function (n, i) {
        lo = Math.min(lo, n.p); hi = Math.max(hi, n.p);
        var s = n.t - c.offset, e = Math.min(s + n.d, c.duration);
        if (e > 0 && s < c.duration) out.push({ i: i, p: n.p, start: Math.max(0, s), end: e, v: n.v });
      });
      if (!c.notes.length) return { lo: 60, hi: 71, notes: [] };
      var pad = Math.max(0, Math.ceil((12 - (hi - lo + 1)) / 2));
      return { lo: Math.max(0, lo - pad), hi: Math.min(127, hi + pad), notes: out };
    }

    /** One line for a status bar. */
    function summary() {
      var p = song, n = p.tracks.length, s = sel.clips.length;
      var parts = [n + ' track' + (n === 1 ? '' : 's'), core.fmtClock(core.songEnd(p)).replace(/\.\d+$/, '') + ' long'];
      if (s) parts.push(s + ' clip' + (s === 1 ? '' : 's') + ' selected');
      var demo = Object.keys(p.sources).some(function (id) { return p.sources[id].demo; });
      if (demo) parts.push('demo stems are synthesized examples');
      return { tracks: n, length: core.songEnd(p), selected: s, demo: demo, text: parts.join(' · ') };
    }

    // ---------------------------------------------------------- api ---

    var api = {
      // events and lifecycle
      subscribe: subscribe, getVersion: function () { return version; }, init: init, frame: frame, message: message,
      // editing
      edit: edit, commit: commit, gestureStart: gestureStart, gestureEnd: gestureEnd, undo: undo, redo: redo,
      snapshot: function () { return core.serialize(song); },
      // songs and files
      newSong: newSong, openDemo: openDemo, listSongs: listSongs, openSong: openSong, deleteSong: deleteSong,
      saveNow: saveNow, saveSongFile: saveSongFile, openSongFile: openSongFile, saveFile: saveFile,
      importFiles: importFiles, exportInfo: exportInfo, exportMix: exportMix, exportStems: exportStems, exportMidi: exportMidi,
      // selection
      select: select, toggleSelect: toggleSelect, selectAll: selectAll, selectTrack: selectTrack, selectedClips: selectedClips,
      // transport and song settings
      play: play, pause: pause, togglePlay: togglePlay, seek: seek, toggleLoop: toggleLoop, setLoop: setLoop,
      setMetronome: setMetronome, toggleMetronome: toggleMetronome, tapTempo: tapTempo, alignGridToPlayhead: alignGridToPlayhead,
      setBpm: setBpm, setTimeSignature: setTimeSignature, setSnap: setSnap, renameSong: renameSong,
      // clips
      splitAtPlayhead: splitAtPlayhead, duplicateSelected: duplicateSelected, deleteSelected: deleteSelected,
      toggleDisabled: toggleDisabled, clipGain: clipGain, setClipGain: setClipGain, renameClip: renameClip, nudge: nudge,
      dragClips: dragClips, dragTrim: dragTrim, dragFade: dragFade, dragLoop: dragLoop,
      // tracks and mix
      addTrack: addTrack, addInstrumentTrack: addInstrumentTrack, deleteTrack: deleteTrack, renameTrack: renameTrack,
      setTrackColor: setTrackColor, moveTrack: moveTrack, toggleMute: toggleMute, toggleSolo: toggleSolo,
      setVolume: setVolume, setPan: setPan, setMasterDb: setMasterDb,
      // effects and instruments
      fxList: fxList, addFx: addFx, removeFx: removeFx, moveFx: moveFx, toggleFx: toggleFx, setFxParam: setFxParam,
      toggleLimiter: toggleLimiter, setLimiterParam: setLimiterParam, matchLoudness: matchLoudness, eqCurve: eqCurve,
      setPreset: setPreset, setInstParam: setInstParam, instParams: instParams,
      // vocal tools
      detectGrid: detectGrid, scaleTempo: scaleTempo, cleanUp: cleanUp, checkTiming: checkTiming, tighten: tighten,
      lineUp: lineUp, detectKey: detectKey, tune: tune, melodyToMidi: melodyToMidi, versionsOf: versionsOf, useVersion: useVersion,
      // MIDI
      newMidiClip: newMidiClip, setNotes: setNotes, addNote: addNote, deleteNotes: deleteNotes, transposeNotes: transposeNotes,
      moveNotes: moveNotes, setVelocity: setVelocity, duplicateNotes: duplicateNotes, quantize: quantize, dragNotes: dragNotes,
      noteStep: noteStep, snapNote: snapNote, audition: audition, liveNote: liveNote, connectMidiInput: connectMidiInput,
      // drawing and status
      waveform: waveform, noteBars: noteBars, summary: summary,
      // the modules underneath, for drawing helpers and schemas
      core: core, engine: engine, presetForProgram: presetForProgram,
      schemas: {
        fx: core.FX_TYPES, limiter: core.LIMITER,
        instruments: S.synth ? S.synth.INSTRUMENTS : {}, presets: presetList(),
        syncLabels: SYNC_LABELS, targets: TARGETS, noteGrids: NOTE_GRIDS, noteNames: NOTE_NAMES,
        snaps: core.SNAPS, denominators: core.DENOMINATORS, colors: core.COLORS, shortcuts: SHORTCUTS
      }
    };

    function getter(name, fn) { Object.defineProperty(api, name, { get: fn, enumerable: true }); }
    getter('song', function () { return song; });
    getter('buffers', function () { return buffers; });
    getter('peaks', function () { return peaks; });
    // The same object until something changes, so it is safe as a React snapshot.
    var selCache = { v: -1, value: null };
    getter('selection', function () {
      if (selCache.v !== version) selCache = { v: version, value: { clips: sel.clips.slice(), track: sel.track } };
      return selCache.value;
    });
    getter('position', currentPos);
    getter('playing', function () { return !!engine.playing; });
    getter('metronome', function () { return metronome; });
    getter('version', function () { return version; });
    getter('saveState', function () { return saveState; });
    getter('storage', function () { return !storeKnown ? 'unknown' : store ? 'browser' : 'none'; });
    getter('canUndo', function () { return history.past.length > 0; });
    getter('canRedo', function () { return history.future.length > 0; });
    getter('busy', function () { return busy; });
    getter('progress', function () { return progressValue; });
    getter('results', function () { return results; });
    getter('marks', function () { return marks; });
    getter('detectedKey', function () { return detectedKey; });
    getter('limiterNote', function () { return limiterNote; });
    getter('limiterMode', function () { return engine.limiterMode ? engine.limiterMode() : null; });
    getter('sampleRate', function () { return engine.ctx ? engine.ctx.sampleRate : null; });
    getter('midiInput', function () { return midiAccess ? midiName : null; });
    getter('target', function () { return Number(lsGet('studio:target', -14)); });

    return api;
  }

  S.createController = createController;
})(typeof self !== 'undefined' ? self : this);
;
