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
