// Unit tests for the headless controller (js/studio/controller.js). The page
// scripts run in one VM context, as in a browser, with a fake audio engine,
// a fake AudioBuffer and an in-memory store, so no audio hardware is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = [
  'js/audio-analysis.js', 'js/demo-loop.js', 'js/studio/core.js', 'js/studio/wav.js', 'js/studio/zip.js',
  'js/studio/midifile.js', 'js/studio/dsp/limiter.js', 'js/studio/fx.js', 'js/studio/synth.js',
  'js/studio/engine.js', 'js/studio/store.js', 'js/studio/controller.js'
];

class FakeBuffer {
  constructor(o) {
    this.numberOfChannels = o.numberOfChannels;
    this.length = o.length;
    this.sampleRate = o.sampleRate;
    this.duration = o.length / o.sampleRate;
    this.data = Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length));
  }
  getChannelData(c) { return this.data[c]; }
  copyToChannel(d, c) { this.data[c].set(d.subarray(0, this.length)); }
}

class FakeEngine {
  constructor() { this.ctx = null; this.playing = false; this.calls = []; this.pos = 0; }
  ensure() { return { createBuffer: (n, length, sampleRate) => new FakeBuffer({ numberOfChannels: n, length, sampleRate }) }; }
  decode() { return Promise.reject(new Error('no decoder in tests')); }
  sync() { this.calls.push('sync'); }
  applyMix() { this.calls.push('mix'); }
  applyFx() { this.calls.push('fx'); }
  play(p, b, pos) { this.playing = true; this.pos = pos; this.calls.push('play'); }
  stop() { this.playing = false; this.calls.push('stop'); }
  position() { return this.playing ? this.pos : null; }
  setMetronome(on) { this.metro = on; }
  levels() { return { left: 0, right: 0, tracks: {}, limiterDb: 0, comps: {} }; }
  limiterMode() { return null; }
  audition(p, trackId, pitch) { this.calls.push('audition:' + pitch); }
  liveNote() {}
}

class MemoryStore {
  constructor() { this.songs = new Map(); this.audio = new Map(); }
  saveSong(p) { this.songs.set(p.id, { id: p.id, name: p.name, updated: p.updated, tracks: p.tracks.length, json: JSON.stringify(p) }); return Promise.resolve(); }
  loadSong(id) { const r = this.songs.get(id); return Promise.resolve(r ? r.json : null); }
  listSongs() { return Promise.resolve([...this.songs.values()].sort((a, b) => b.updated - a.updated)); }
  deleteSong(id) { this.songs.delete(id); return Promise.resolve(); }
  saveAudio(songId, sourceId, blob) { this.audio.set(songId + '/' + sourceId, blob); return Promise.resolve(); }
  loadAudio(songId, sourceId) { return Promise.resolve(this.audio.get(songId + '/' + sourceId) || null); }
}

function page() {
  const ctx = {
    console, Math, Date, JSON, Promise, setTimeout, clearTimeout, Float32Array, Float64Array, Uint8Array,
    Int16Array, Int32Array, Uint32Array, DataView, ArrayBuffer, TextDecoder, TextEncoder, Blob, File, URL,
    Object, Array, String, Number, Error, isFinite, isNaN, AudioBuffer: FakeBuffer
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
  return ctx;
}

async function setup(opts = {}) {
  const ctx = page();
  const engine = new FakeEngine();
  const studio = ctx.S2S.studio.createController(Object.assign({ engine, store: null, initialSong: 'empty' }, opts));
  const events = [];
  studio.subscribe((e) => events.push(e));
  await studio.init();
  return { ctx, S: ctx.S2S.studio, studio, engine, events };
}

function wavFile(ctx, name, seconds, freq, rate = 48000) {
  const n = Math.round(seconds * rate), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / rate);
  return new File([ctx.S2S.studio.wav.encodeWav([x, x], rate, { bits: 24 })], name, { type: 'audio/wav' });
}

// Arrays made inside the VM have another Array prototype, so copy them before deepEqual.
const A = (x) => JSON.parse(JSON.stringify(x));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('starts empty without storage; version bumps and events arrive', async () => {
  const { studio, events } = await setup();
  assert.equal(studio.storage, 'none');
  assert.equal(studio.song.tracks.length, 0);
  assert.equal(studio.saveState, 'nostore');
  const v = studio.getVersion();
  studio.addTrack();
  assert.ok(studio.getVersion() > v);
  assert.ok(events.some((e) => e.type === 'change' && e.kind === 'arrange'));
  assert.equal(studio.song.tracks.length, 1);
  assert.equal(studio.selection.track, studio.song.tracks[0].id);
});

test('undo and redo walk the history; nothing to undo says so', async () => {
  const { studio, events } = await setup();
  const id = studio.addTrack();
  studio.renameTrack(id, 'Vocals');
  assert.equal(studio.song.tracks[0].name, 'Vocals');
  assert.ok(studio.canUndo);
  studio.undo();
  assert.notEqual(studio.song.tracks[0].name, 'Vocals');
  studio.redo();
  assert.equal(studio.song.tracks[0].name, 'Vocals');
  studio.undo(); studio.undo();
  assert.equal(studio.song.tracks.length, 0);
  assert.equal(studio.undo(), false);
  assert.ok(events.some((e) => e.type === 'message' && /Nothing to undo/.test(e.text)));
});

test('a slider gesture is one undo step and updates the engine live', async () => {
  const { studio, engine } = await setup();
  const id = studio.addTrack();
  engine.calls = [];
  studio.gestureStart();
  for (const db of [-1, -2, -3, -6]) studio.setVolume(id, db);
  assert.equal(engine.calls.filter((c) => c === 'mix').length, 4);
  assert.equal(studio.song.tracks[0].volumeDb, -6);
  assert.equal(studio.gestureEnd('mix'), true);
  studio.undo();
  assert.equal(studio.song.tracks[0].volumeDb, 0);
  // A gesture that changed nothing records nothing.
  studio.gestureStart();
  assert.equal(studio.gestureEnd('mix'), false);
  // Outside a gesture a setter is one edit of its own.
  studio.setPan(id, 2);
  assert.equal(studio.song.tracks[0].pan, 1);
});

test('selection is a stable snapshot until it changes', async () => {
  const { studio } = await setup();
  const a = studio.selection, b = studio.selection;
  assert.equal(a, b);
  studio.addTrack();
  assert.notEqual(studio.selection, a);
});

test('importing a WAV adds a track, a clip, peaks and a waveform', async () => {
  const { ctx, studio } = await setup();
  const r = await studio.importFiles([wavFile(ctx, 'Lead_vocal.wav', 2, 220), { name: 'notes.txt', type: 'text/plain' }], { at: 1 });
  assert.equal(r.added.length, 1);
  assert.equal(r.failed.length, 1);
  const c = studio.song.clips[0];
  assert.equal(c.start, 1);
  assert.equal(studio.song.tracks[0].name, 'Lead vocal');
  assert.ok(Math.abs(c.duration - 2) < 1e-3);
  assert.deepEqual(A(studio.selection.clips), [c.id]);
  const w = studio.waveform(c.id, 100);
  assert.equal(w.max.length, 100);
  assert.ok(w.max[50] > 0.45 && w.max[50] <= 0.51, String(w.max[50]));
  assert.ok(w.rms[50] > 0.3 && w.rms[50] < 0.4, String(w.rms[50]));
});

test('clip commands: split, duplicate, gain, disable, nudge, delete', async () => {
  const { ctx, studio } = await setup();
  await studio.importFiles([wavFile(ctx, 'a.wav', 4, 110)], { at: 0 });
  const first = studio.song.clips[0].id;
  studio.seek(1.5);
  const rights = studio.splitAtPlayhead();
  assert.equal(rights.length, 1);
  assert.equal(studio.song.clips.length, 2);
  assert.ok(Math.abs(studio.song.clips.find((c) => c.id === first).duration - 1.5) < 1e-9);
  studio.select([first]);
  const copies = studio.duplicateSelected();
  assert.equal(copies.length, 1);
  assert.equal(studio.clipGain(2), 2);
  studio.toggleDisabled();
  assert.equal(studio.song.clips.find((c) => c.id === copies[0]).disabled, true);
  const before = studio.song.clips.find((c) => c.id === copies[0]).start;
  studio.nudge(1, true);
  assert.ok(Math.abs(studio.song.clips.find((c) => c.id === copies[0]).start - before - 0.01) < 1e-9);
  assert.equal(studio.deleteSelected(), true);
  assert.ok(!studio.song.clips.some((c) => c.id === copies[0]));
});

test('dragging clips snaps to the grid, changes track, and is one undo step', async () => {
  const { ctx, studio } = await setup();
  await studio.importFiles([wavFile(ctx, 'a.wav', 1, 110), wavFile(ctx, 'b.wav', 1, 220)], { at: 0 });
  const [ta, tb] = studio.song.tracks.map((t) => t.id);
  const clip = studio.song.clips.find((c) => c.trackId === ta);
  studio.select([clip.id]);
  studio.setSnap('1/4');
  const beat = 60 / studio.song.bpm;
  const d = studio.dragClips(clip.id);
  d.update(beat * 2.2, tb);
  assert.ok(Math.abs(clip.start - beat * 2) < 1e-9, 'snapped to beat 3');
  assert.equal(clip.trackId, tb);
  d.update(beat * 3.4, tb, true);
  assert.ok(Math.abs(clip.start - beat * 3.4) < 1e-9, 'free movement');
  assert.equal(d.end(), true);
  studio.undo();
  const back = studio.song.clips.find((c) => c.id === clip.id);
  assert.equal(back.start, 0);
  assert.equal(back.trackId, ta);
  // Cancel puts it back without an undo step.
  const d2 = studio.dragClips(back.id);
  d2.update(5);
  d2.cancel();
  assert.equal(studio.song.clips.find((c) => c.id === back.id).start, 0);
});

test('trim, fade and loop drags', async () => {
  const { ctx, studio } = await setup();
  await studio.importFiles([wavFile(ctx, 'a.wav', 4, 110)], { at: 0 });
  studio.setSnap('off');
  const id = studio.song.clips[0].id;
  const t = studio.dragTrim(id, 'end');
  t.update(3);
  t.end();
  assert.ok(Math.abs(studio.song.clips[0].duration - 3) < 1e-9);
  const s = studio.dragTrim(id, 'start');
  s.update(0.5);
  s.end();
  const c = studio.song.clips[0];
  assert.ok(Math.abs(c.start - 0.5) < 1e-9 && Math.abs(c.offset - 0.5) < 1e-9 && Math.abs(c.duration - 2.5) < 1e-9);
  const f = studio.dragFade(id, 'in');
  f.update(0.25);
  f.end();
  assert.ok(Math.abs(studio.song.clips[0].fadeIn - 0.25) < 1e-9);
  const l = studio.dragLoop('new', 1);
  l.update(2);
  l.end();
  assert.deepEqual(A([studio.song.loop.start, studio.song.loop.end, studio.song.loop.on]), [1, 2, true]);
  studio.toggleLoop();
  assert.equal(studio.song.loop.on, false);
});

test('instrument tracks and note editing', async () => {
  const { studio, engine } = await setup();
  const made = studio.addInstrumentTrack('e-piano');
  const t = studio.song.tracks.find((x) => x.id === made.trackId);
  assert.equal(t.type, 'midi');
  assert.equal(t.inst.preset, 'e-piano');
  const step = studio.noteStep('1/16');
  const i = studio.addNote(made.clipId, 60, step * 2.6, { grid: '1/16' });
  const clip = () => studio.song.clips.find((c) => c.id === made.clipId);
  assert.equal(i, 0);
  assert.ok(Math.abs(clip().notes[0].t - step * 2) < 1e-9, 'snapped down to the grid line');
  studio.addNote(made.clipId, 64, 0, { grid: '1/16' });
  assert.deepEqual(A(clip().notes.map((n) => n.p)), [64, 60], 'sorted by time');
  studio.transposeNotes(made.clipId, [1], 12);
  assert.equal(clip().notes[1].p, 72);
  const d = studio.dragNotes(made.clipId, [1], 'move', { grid: '1/16' });
  d.update(step * 1.1, -2);
  d.end();
  assert.equal(clip().notes[1].p, 70);
  assert.ok(Math.abs(clip().notes[1].t - step * 3) < 1e-9);
  studio.gestureStart();
  studio.setVelocity(made.clipId, [0, 1], 40);
  studio.setVelocity(made.clipId, [0, 1], 90);
  studio.gestureEnd('notes');
  assert.deepEqual(A(clip().notes.map((n) => n.v)), [90, 90]);
  const copies = studio.duplicateNotes(made.clipId, [0, 1], '1/16');
  assert.equal(copies.length, 2);
  assert.equal(clip().notes.length, 4);
  const bars = studio.noteBars(made.clipId);
  assert.equal(bars.notes.length, 4);
  assert.ok(bars.lo <= 64 && bars.hi >= 70);
  studio.deleteNotes(made.clipId, copies);
  assert.equal(clip().notes.length, 2);
  studio.audition(made.trackId, 60);
  assert.ok(engine.calls.includes('audition:60'));
});

test('MIDI import and export round trip', async () => {
  const { ctx, studio, S } = await setup();
  const bytes = S.midifile.write({
    bpm: 100, sig: [3, 4],
    tracks: [{ name: 'Bass', program: 33, isDrums: false, notes: [{ pitch: 40, start: 0, duration: 1, velocity: 90 }, { pitch: 43, start: 1, duration: 1, velocity: 80 }] }]
  }, { ppq: 480 });
  const r = await studio.importFiles([new File([bytes], 'line.mid', { type: 'audio/midi' })], { at: 0 });
  assert.equal(r.added.length, 1);
  assert.equal(studio.song.bpm, 100, 'an empty song takes the file tempo');
  assert.deepEqual(A(studio.song.sig), [3, 4]);
  const t = studio.song.tracks[0];
  assert.equal(t.type, 'midi');
  assert.ok(['sub-bass', 'acid-bass'].includes(t.inst.preset));
  const out = await studio.exportMidi({ save: false });
  assert.equal(out.notes, 2);
  const back = S.midifile.parse(await out.file.blob.arrayBuffer());
  assert.deepEqual(A(back.tracks[0].notes.map((n) => n.pitch)), [40, 43]);
  void ctx;
});

test('effects: add, live params, reorder, bypass, remove, limiter', async () => {
  const { studio, engine } = await setup();
  const tid = studio.addTrack();
  const eq = studio.addFx(tid, 'eq');
  const comp = studio.addFx(tid, 'comp');
  assert.deepEqual(A(studio.fxList(tid).map((f) => f.type)), ['eq', 'comp']);
  const key = Object.keys(studio.schemas.fx.eq.params)[0];
  engine.calls = [];
  studio.gestureStart();
  studio.setFxParam(eq, key, studio.schemas.fx.eq.params[key].max + 1000);
  studio.gestureEnd('fx');
  assert.ok(engine.calls.includes('fx'));
  assert.equal(studio.fxList(tid)[0].p[key], studio.schemas.fx.eq.params[key].max, 'clamped to the schema');
  studio.moveFx(comp, -1);
  assert.deepEqual(A(studio.fxList(tid).map((f) => f.type)), ['comp', 'eq']);
  studio.toggleFx(eq);
  assert.equal(studio.fxList(tid)[1].on, false);
  studio.removeFx(comp);
  assert.deepEqual(A(studio.fxList(tid).map((f) => f.type)), ['eq']);
  studio.setLimiterParam('ceilingDb', -50);
  assert.equal(studio.song.master.limiter.ceilingDb, studio.schemas.limiter.ceilingDb.min);
  const curve = studio.eqCurve(studio.fxList(tid)[0].p, [100, 1000, 10000]);
  assert.equal(curve.length, 3);
});

test('song file round trip keeps the arrangement and the audio', async () => {
  const { ctx, studio } = await setup();
  await studio.importFiles([wavFile(ctx, 'a.wav', 1, 110)], { at: 0.5 });
  studio.addInstrumentTrack('pluck');
  studio.renameSong('Round trip');
  const { file } = await studio.saveSongFile({ save: false });
  assert.equal(file.name, 'Round trip.studio.zip');
  const before = { tracks: studio.song.tracks.length, clips: studio.song.clips.length, id: studio.song.id };
  studio.newSong();
  assert.equal(studio.song.tracks.length, 0);
  const r = await studio.openSongFile(file.blob);
  assert.equal(r.missing, 0);
  assert.equal(studio.song.name, 'Round trip');
  assert.equal(studio.song.tracks.length, before.tracks);
  assert.equal(studio.song.clips.length, before.clips);
  assert.notEqual(studio.song.id, before.id, 'an opened file is a new song');
  const audioClip = studio.song.clips.find((c) => !c.notes);
  assert.ok(studio.buffers[audioClip.sourceId].length > 0);
  assert.equal(studio.canUndo, false, 'history starts fresh');
});

test('autosave to the store, list, reopen and delete songs', async () => {
  const store = new MemoryStore();
  const { studio } = await setup({ store });
  assert.equal(studio.storage, 'browser');
  studio.renameSong('First');
  assert.equal(studio.saveState, 'dirty');
  await tick(800);
  assert.equal(studio.saveState, 'saved');
  const firstId = studio.song.id;
  studio.newSong();
  studio.renameSong('Second');
  await studio.saveNow();
  const list = await studio.listSongs();
  assert.deepEqual(A(list.map((s) => s.name).sort()), ['First', 'Second']);
  assert.ok(list.find((s) => s.name === 'Second').current);
  await studio.openSong(firstId);
  assert.equal(studio.song.name, 'First');
  await studio.deleteSong(firstId);
  assert.ok(!(await studio.listSongs()).some((s) => s.id === firstId));
  assert.notEqual(studio.song.id, firstId, 'deleting the open song starts a new one');
});

test('transport, tempo and grid settings', async () => {
  const { studio, engine } = await setup();
  studio.seek(3);
  studio.play();
  assert.equal(engine.playing, true);
  assert.equal(studio.frame().position, 3);
  studio.pause();
  assert.equal(studio.playing, false);
  assert.equal(studio.setBpm(500), false);
  studio.setBpm(90);
  assert.equal(studio.song.bpm, 90);
  studio.setTimeSignature(6, 8);
  assert.deepEqual(A(studio.song.sig), [6, 8]);
  studio.seek(1.25);
  studio.alignGridToPlayhead();
  assert.ok(Math.abs(studio.song.gridOffset - 1.25 % (6 * 0.5 * 60 / 90)) < 1e-6);
  studio.setMetronome(true);
  assert.equal(studio.metronome, true);
  const s = studio.summary();
  assert.equal(s.tracks, 0);
});

test('vocal tools refuse without an audio clip, and only one runs at a time', async () => {
  const { studio } = await setup();
  await assert.rejects(studio.cleanUp(null), /Select a clip/);
  assert.equal(studio.busy, null);
  assert.match(studio.results.clean, /Didn’t work/);
  studio.addInstrumentTrack('pluck');
  await assert.rejects(studio.tune(studio.song.clips[0].id), /audio clips/);
});
