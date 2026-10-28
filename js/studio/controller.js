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
