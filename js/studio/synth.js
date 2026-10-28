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
