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
