// Unit tests for the studio's song model and timeline maths.
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/studio/core.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function song(opts) {
  const p = core.createProject(Object.assign({ bpm: 120, sig: [4, 4] }, opts));
  const src = core.addSource(p, { name: 'Vocals', duration: 10, sampleRate: 48000, channels: 2 });
  const t = core.addTrack(p, { name: 'Vocals' });
  const c = core.addClip(p, { trackId: t.id, sourceId: src.id, start: 2 });
  return { p, src, t, c };
}

test('bars, beats and snapping follow BPM, time signature and bar-1 offset', () => {
  const p = core.createProject({ bpm: 120, sig: [4, 4] });
  close(core.beatSec(p), 0.5);
  close(core.barSec(p), 2);
  assert.deepEqual(core.toBBT(p, 0), { bar: 1, beat: 1, sub: 1 });
  assert.deepEqual(core.toBBT(p, 2.75), { bar: 2, beat: 2, sub: 3 });
  assert.equal(core.fmtBBT(p, 6), '4.1.1');

  const six8 = core.createProject({ bpm: 120, sig: [6, 8] });
  close(core.beatSec(six8), 0.25);   // an eighth note
  close(core.barSec(six8), 1.5);

  p.gridOffset = 0.3; // bar 1 starts 0.3 s in
  assert.deepEqual(core.toBBT(p, 0.3), { bar: 1, beat: 1, sub: 1 });
  assert.equal(core.toBBT(p, 0).bar, 0);
  close(core.barToTime(p, 3), 4.3);
  close(core.snapTime(p, 1.1, 'bar'), 0.3);
  close(core.snapTime(p, 1.4, 'bar'), 2.3);
  close(core.snapTime(p, 1.1, '1/4'), 1.3);
  close(core.snapTime(p, 1.1, '1/16'), 1.05);
  assert.equal(core.snapTime(p, 1.1, 'off'), 1.1);
});

test('clock format', () => {
  assert.equal(core.fmtClock(0), '0:00.000');
  assert.equal(core.fmtClock(65.25), '1:05.250');
  assert.equal(core.fmtClock(59.9996), '1:00.000');
  assert.equal(core.fmtClock(-1.5), '-0:01.500');
});

test('a new clip covers its whole source and the song end follows it', () => {
  const { p, c } = song();
  assert.equal(c.offset, 0);
  assert.equal(c.duration, 10);
  assert.equal(core.songEnd(p), 12);
});

test('split keeps the audio continuous and moves the fade-out to the right part', () => {
  const { p, c } = song();
  c.fadeIn = 1; c.fadeOut = 2;
  const right = core.splitClip(p, c, 5);
  assert.ok(right);
  close(c.duration, 3);
  close(right.start, 5);
  close(right.offset, 3);
  close(right.duration, 7);
  assert.equal(c.fadeIn, 1);
  assert.equal(c.fadeOut, 0);
  assert.equal(right.fadeIn, 0);
  assert.equal(right.fadeOut, 2);
  assert.equal(p.clips.indexOf(right), p.clips.indexOf(c) + 1);
  assert.equal(core.splitClip(p, c, 2), null, 'split at the edge does nothing');
  assert.equal(core.splitClip(p, c, 9), null, 'split outside the clip does nothing');
});

test('trimming stops at the ends of the source audio and at zero', () => {
  const { p, c } = song();
  core.trimStart(p, c, 4);
  close(c.start, 4); close(c.offset, 2); close(c.duration, 8);
  core.trimStart(p, c, -5); // can only reveal the 2 s that were hidden
  close(c.start, 2); close(c.offset, 0); close(c.duration, 10);
  core.trimEnd(p, c, 30);
  close(core.clipEnd(c), 12);
  core.trimEnd(p, c, 1);
  close(c.duration, core.MIN_CLIP);

  const { p: p2, c: c2 } = song();
  c2.start = 0.5; c2.offset = 3; c2.duration = 5;
  core.trimStart(p2, c2, -1); // the song starts at 0
  close(c2.start, 0); close(c2.offset, 2.5); close(c2.duration, 5.5);
});

test('fades never overlap and shrink with the clip', () => {
  const { p, c } = song();
  core.setFade(c, 'in', 4);
  core.setFade(c, 'out', 9);
  assert.equal(c.fadeIn, 4);
  assert.equal(c.fadeOut, 6);
  core.trimEnd(p, c, 7); // duration 5
  assert.ok(c.fadeIn + c.fadeOut <= c.duration + 1e-9);
});

test('duplicate places copies after the group; delete removes them', () => {
  const { p, c, t, src } = song();
  const c2 = core.addClip(p, { trackId: t.id, sourceId: src.id, start: 14, duration: 2 });
  const copies = core.duplicateClips(p, [c, c2]);
  assert.equal(copies.length, 2);
  close(copies[0].start, 2 + 14);   // group spans 2..16, so it shifts by 14
  close(copies[1].start, 14 + 14);
  assert.notEqual(copies[0].id, c.id);
  core.deleteClips(p, copies.map((x) => x.id));
  assert.equal(p.clips.length, 2);
});

test('a moved clip replaces what it lands on, on its own track only', () => {
  const p = core.createProject();
  const src = core.addSource(p, { name: 'A', duration: 60, sampleRate: 48000, channels: 2 });
  const t = core.addTrack(p), other = core.addTrack(p);
  const mk = (track, start, duration) => core.addClip(p, { trackId: track.id, sourceId: src.id, start, duration });
  const covered = mk(t, 10, 2);       // fully under the winner: removed
  const left = mk(t, 0, 9);           // ends inside: trimmed back to 8
  const right = mk(t, 13, 5);         // starts inside: trimmed to start at 14
  const elsewhere = mk(other, 8, 6);  // other track: untouched
  const win = mk(t, 8, 6);            // 8..14
  core.resolveOverlaps(p, [win.id]);
  assert.equal(core.getClip(p, covered.id), null);
  close(left.duration, 8);
  close(right.start, 14); close(right.offset, 1); close(right.duration, 4);
  assert.equal(elsewhere.start, 8); assert.equal(elsewhere.duration, 6);

  const q = core.createProject();
  const s2 = core.addSource(q, { name: 'B', duration: 30, sampleRate: 48000, channels: 2 });
  const tr = core.addTrack(q);
  const long = core.addClip(q, { trackId: tr.id, sourceId: s2.id, start: 0, duration: 30 });
  long.fadeOut = 3;
  const inside = core.addClip(q, { trackId: tr.id, sourceId: s2.id, start: 10, duration: 5 });
  const twin = core.addClip(q, { trackId: tr.id, sourceId: s2.id, start: 12, duration: 1 });
  core.resolveOverlaps(q, [inside.id, twin.id]);
  assert.equal(core.getClip(q, twin.id).start, 12, 'winners do not cut each other');
  const parts = q.clips.filter((c) => c.id !== inside.id && c.id !== twin.id).sort((a, b) => a.start - b.start);
  assert.equal(parts.length, 2, 'the long clip is split around the winner');
  close(core.clipEnd(parts[0]), 10);
  close(parts[1].start, 15); close(parts[1].offset, 15); close(core.clipEnd(parts[1]), 30);
  assert.equal(parts[1].fadeOut, 3, 'the right part keeps the fade-out');
});

test('processed versions of a clip are kept, switchable and repaired on load', () => {
  const { p, c, src } = song();
  const v2 = core.addSource(p, { name: 'Vocals (cleaned)', duration: 10, sampleRate: 48000, channels: 2 });
  core.addVersion(c, v2.id);
  assert.equal(c.sourceId, v2.id);
  assert.deepEqual(c.versions, [src.id, v2.id]);
  const right = core.splitClip(p, c, 5);
  assert.notEqual(right.versions, c.versions, 'split parts do not share the version list');
  core.addVersion(c, src.id); // back to the original
  assert.deepEqual(c.versions, [v2.id, src.id]);
  const raw = JSON.parse(core.serialize(p));
  raw.clips[0].versions.push('missing', v2.id);
  const back = core.parseProject(raw);
  assert.deepEqual(back.clips[0].versions, [v2.id, src.id]);
});

test('mute and solo decide which tracks sound', () => {
  const p = core.createProject();
  const a = core.addTrack(p, { name: 'A', volumeDb: -6 });
  const b = core.addTrack(p, { name: 'B' });
  close(core.trackGain(p, a), Math.pow(10, -6 / 20));
  b.solo = true;
  assert.equal(core.trackGain(p, a), 0);
  assert.equal(core.trackGain(p, b), 1);
  b.mute = true;
  assert.equal(core.trackGain(p, b), 0, 'mute beats solo');
  b.solo = false; b.mute = false; a.mute = true;
  assert.equal(core.trackGain(p, a), 0);
  assert.equal(core.dbToGain(-60), 0);
  removeTrackKeepsClipsConsistent();
});

function removeTrackKeepsClipsConsistent() {
  const { p, t } = song();
  core.removeTrack(p, t.id);
  assert.equal(p.tracks.length, 0);
  assert.equal(p.clips.length, 0);
}

test('fade gain points follow the quarter-sine curves and include clip gain', () => {
  const { c } = song();
  c.fadeIn = 2; c.fadeOut = 2; c.gainDb = -6;
  const k = Math.pow(10, -6 / 20);
  const pts = core.gainPoints(c, 0, 10);
  close(pts[0].t, 0); close(pts[0].g, 0);
  close(pts[pts.length - 1].t, 10); close(pts[pts.length - 1].g, 0);
  const mid = pts.find((x) => Math.abs(x.t - 1) < 1e-9);
  close(mid.g, k * Math.sin(Math.PI / 4), 1e-12);
  const flat = core.gainPoints(c, 3, 6);
  assert.equal(flat.length, 2, 'no breakpoints between the fades');
  close(flat[0].g, k); close(flat[1].g, k);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].t > pts[i - 1].t);
});

test('playback plan cuts clips to the window and skips disabled clips', () => {
  const { p, c, t, src } = song();
  const d = core.addClip(p, { trackId: t.id, sourceId: src.id, start: 20, duration: 3 });
  let segs = core.planSegments(p, 5, 21);
  assert.equal(segs.length, 2);
  close(segs[0].at, 5); close(segs[0].inClip, 3); close(segs[0].offset, 3); close(segs[0].duration, 7);
  close(segs[1].at, 20); close(segs[1].duration, 1);
  d.disabled = true;
  segs = core.planSegments(p, 0, 100);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].clip, c);
});

test('transport position wraps at the loop end and pieces split at the jump', () => {
  const anchor = { ctxTime: 10, pos: 3 };
  const loop = { on: true, start: 2, end: 6 };
  close(core.positionAt(anchor, loop, 9), 3);    // before start: holds
  close(core.positionAt(anchor, loop, 12), 5);
  close(core.positionAt(anchor, loop, 13), 2);   // reached loop end, back to start
  close(core.positionAt(anchor, loop, 18.5), 3.5); // 13 + 4 = 17 is the next jump
  const off = { on: false, start: 2, end: 6 };
  close(core.positionAt(anchor, off, 18.5), 11.5);
  assert.equal(core.loopActive(loop, 7), false, 'starting after the loop plays straight on');

  const pieces = core.transportPieces(anchor, loop, 12, 18);
  assert.equal(pieces.length, 3);
  close(pieces[0].ctxStart, 12); close(pieces[0].ctxEnd, 13); close(pieces[0].pos, 5);
  close(pieces[1].ctxStart, 13); close(pieces[1].ctxEnd, 17); close(pieces[1].pos, 2);
  close(pieces[2].ctxStart, 17); close(pieces[2].ctxEnd, 18); close(pieces[2].pos, 2);
  const straight = core.transportPieces(anchor, off, 12, 18);
  assert.equal(straight.length, 1);
  close(straight[0].pos, 5);
});

test('undo history keeps the order and drops redo after a new edit', () => {
  const h = new core.History(3);
  h.record('a'); h.record('b');
  assert.equal(h.undo('c'), 'b');
  assert.equal(h.undo('b'), 'a');
  assert.equal(h.undo('a'), null);
  assert.equal(h.redo('a'), 'b');
  h.record('x');
  assert.equal(h.redo('y'), null);
  h.record('1'); h.record('2'); h.record('3');
  assert.equal(h.past.length, 3, 'history is capped');
});

test('a saved song survives a round trip and bad values are repaired', () => {
  const { p, c } = song({ name: 'My Song' });
  c.fadeIn = 1;
  p.loop = { on: true, start: 2, end: 6 };
  const back = core.parseProject(core.serialize(p));
  assert.deepEqual(back, p);

  const bad = JSON.parse(core.serialize(p));
  bad.bpm = 9999;
  bad.sig = [0, 5];
  bad.tracks[0].pan = 7;
  bad.tracks.push({ id: bad.tracks[0].id, name: 'dupe' });
  bad.clips[0].duration = 500;
  bad.clips.push({ id: 'orphan', trackId: 'nope', sourceId: c.sourceId });
  const fixed = core.parseProject(bad);
  assert.equal(fixed.bpm, 300);
  assert.deepEqual(fixed.sig, [1, 4]);
  assert.equal(fixed.tracks.length, 1);
  assert.equal(fixed.tracks[0].pan, 1);
  assert.equal(fixed.clips.length, 1);
  assert.equal(fixed.clips[0].duration, 10);
  assert.throws(() => core.parseProject('{"tracks":[]}'), /not a Stem to Stream Studio song/);
});

function midiSong() {
  const p = core.createProject({ bpm: 120, sig: [4, 4] });
  const t = core.addTrack(p, { name: 'Keys', type: 'midi', inst: { type: 'synth', preset: 'pad', p: { cutoff: 900 } } });
  const c = core.addMidiClip(p, {
    trackId: t.id, start: 4, notes: [
      { p: 60, t: 0, d: 0.5, v: 90 }, { p: 64, t: 0.52, d: 0.5 }, { p: 67, t: 1.0, d: 1.5, v: 127 }
    ]
  });
  return { p, t, c };
}

test('MIDI clips: notes play at song time inside the clip, cut at its end and at a loop end', () => {
  const { p, c } = midiSong();
  close(c.duration, 2.5);
  const all = core.midiEvents(p, 0, 100);
  assert.deepEqual(all.map((e) => [e.p, e.at, e.d]), [[60, 4, 0.5], [64, 4.52, 0.5], [67, 5, 1.5]]);
  assert.equal(all[1].v, 100, 'velocity defaults to 100');

  // Trimming the clip's left edge hides the first note; its end cuts the last.
  core.trimStart(p, c, 4.5);
  core.trimEnd(p, c, 5.5);
  assert.deepEqual(core.midiEvents(p, 0, 100).map((e) => [e.p, e.at, Math.round(e.d * 1000)]), [[64, 4.52, 500], [67, 5, 500]]);

  // MIDI clips can be lengthened past their last note.
  core.trimEnd(p, c, 12);
  close(core.clipEnd(c), 12);

  // A window only returns notes starting in it; chase also returns sounding ones.
  assert.deepEqual(core.midiEvents(p, 5.2, 6).map((e) => e.p), []);
  const chased = core.midiEvents(p, 5.2, 6, { chase: true });
  assert.deepEqual(chased.map((e) => [e.p, e.at]), [[67, 5.2]]);
  close(chased[0].d, 1.3);
  close(core.midiEvents(p, 0, 100, { limit: 5.5 })[1].d, 0.5);

  // Muting the clip silences it; MIDI clips never become audio pieces.
  assert.equal(core.planSegments(p, 0, 100).length, 0);
  c.disabled = true;
  assert.equal(core.midiEvents(p, 0, 100).length, 0);
});

test('MIDI clips split, duplicate and quantize without touching other copies', () => {
  const { p, c } = midiSong();
  const right = core.splitClip(p, c, 5);
  assert.ok(right);
  assert.deepEqual(core.midiEvents(p, 0, 100).map((e) => [e.clipId === c.id ? 'L' : 'R', e.p]), [['L', 60], ['L', 64], ['R', 67]]);
  right.notes[2].p = 72;
  assert.equal(c.notes[2].p, 67, 'split halves own separate note lists');

  const [copy] = core.duplicateClips(p, [c]);
  copy.notes[0].v = 1;
  assert.equal(c.notes[0].v, 90);

  // 1/8 grid at 120 BPM is 0.25 s; the 4.52 s note moves to 4.5.
  core.quantizeNotes(p, c, null, core.snapStep(p, '1/8'), 1);
  assert.deepEqual(c.notes.map((n) => Math.round(n.t * 1000)), [0, 500, 1000]);
  core.quantizeNotes(p, right, [2], 0.25, 0.5);
  close(right.notes[2].t, 1.0, 1e-9);
  close(core.snapStep(p, '1/8t'), 0.25 * 2 / 3);
});

test('MIDI tracks and clips survive a save, and bad MIDI data is repaired', () => {
  const { p, t, c } = midiSong();
  const back = core.parseProject(core.serialize(p));
  assert.deepEqual(back, p);

  const bad = JSON.parse(core.serialize(p));
  bad.tracks[0].inst = { type: 'kazoo', p: { cutoff: 'x'.repeat(99), ok: 3, 'bad key': 1, nested: { a: 1 } } };
  bad.clips[0].notes.push({ p: 128, t: 0, d: 1 }, { p: 60, t: -1, d: 1 }, { p: 60, t: 0, d: 0 }, null, { p: 59.6, t: 0.1, d: 0.0001, v: 400 });
  bad.clips.push({ id: 'audio-on-midi', trackId: t.id, sourceId: 'nope' });
  const audio = core.addTrack(p, { name: 'Audio' });
  bad.tracks.push(JSON.parse(JSON.stringify(audio)));
  bad.clips.push(Object.assign(JSON.parse(JSON.stringify(c)), { id: 'midi-on-audio', trackId: audio.id }));
  const fixed = core.parseProject(bad);
  assert.deepEqual(fixed.tracks[0].inst, { type: 'synth', preset: '', p: { ok: 3 } });
  assert.equal(fixed.clips.length, 1);
  assert.deepEqual(fixed.clips[0].notes.map((n) => [n.p, n.t, n.d, n.v]), [
    [60, 0, 0.5, 90], [60, 0.1, core.MIN_NOTE, 127], [64, 0.52, 0.5, 100], [67, 1, 1.5, 127]
  ]);
  assert.equal(fixed.tracks[1].type, undefined);
});

test('MIDI export lists notes in quarter notes, drums on channel 10', () => {
  const { p } = midiSong();
  const d = core.addTrack(p, { name: 'Drums', type: 'midi', inst: { type: 'drums' } });
  core.addMidiClip(p, { trackId: d.id, start: 0, notes: [{ p: 36, t: 0.5, d: 0.1, v: 110 }] });
  const out = core.midiExport(p);
  assert.equal(out.bpm, 120);
  assert.deepEqual(out.tracks.map((t) => [t.name, t.channel]), [['Keys', 0], ['Drums', 9]]);
  assert.deepEqual(out.tracks[0].notes[0], { pitch: 60, start: 8, duration: 1, velocity: 90 });
  close(out.tracks[1].notes[0].start, 1);
});
