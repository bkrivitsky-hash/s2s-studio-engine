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
