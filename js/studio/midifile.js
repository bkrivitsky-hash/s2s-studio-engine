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
