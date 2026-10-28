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
