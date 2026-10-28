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
