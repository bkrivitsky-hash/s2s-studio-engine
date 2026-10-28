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
