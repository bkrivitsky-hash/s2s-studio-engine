// Unit tests for the studio's Standard MIDI File reader and writer.
// The test files are built byte by byte here, so they don't rely on the writer.
// Run: node --test tests/studio-midifile.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parse, write, tempoAt, beatsToSeconds, secondsToBeats, GM_PROGRAMS, GM_DRUMS
} = require('../js/studio/midifile.js');

// ---- Hand-built SMF helpers (plain byte arrays) ----
const str = (s) => Array.from(Buffer.from(s, 'utf8'));
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
function vlq(n) {
  const out = [n & 0x7f];
  while ((n = Math.floor(n / 128)) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const chunk = (id, body) => [...str(id), ...u32(body.length), ...body];
const header = (format, ntracks, division) => chunk('MThd', [...u16(format), ...u16(ntracks), ...u16(division)]);
// One MTrk from rows of [delta, ...event bytes], closed by End of Track.
function track(rows, eotDelta = 0) {
  const body = [];
  for (const [delta, ...ev] of rows) body.push(...vlq(delta), ...ev);
  body.push(...vlq(eotDelta), 0xff, 0x2f, 0x00);
  return chunk('MTrk', body);
}
const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];
const name = (s) => meta(0x03, str(s));
const tempo = (bpm) => {
  const us = Math.round(60e6 / bpm);
  return meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
};
const timeSig = (num, den) => meta(0x58, [num, Math.log2(den), 24, 8]);
const smf = (...parts) => Uint8Array.from(parts.flat());

function xorshift(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s & 0xff; };
}

const note = (pitch, start, duration, velocity, channel) => ({ pitch, start, duration, velocity, channel });

test('format 0: running status, channel split with drums, velocity-0 note-off, tempo change, 3/4', () => {
  const ppq = 96;
  const bytes = smf(header(0, 1, ppq), track([
    [0, ...name('Song')],
    [0, ...timeSig(3, 4)],
    [0, ...tempo(120)],
    [0, 0xc0, 5],             // program 5 on channel 1
    [0, 0x90, 60, 100],       // C4 on
    [0, 62, 80],              // running status: D4 on
    [0, 0x99, 36, 127],       // kick on channel 10
    [48, 36, 0],              // running status, velocity 0 = note-off (tick 48)
    [0, 42, 96],              // closed hat on
    [48, 42, 0],              // tick 96
    [48, 0x80, 60, 64],       // explicit note-off, tick 144 = beat 1.5
    [48, ...tempo(60)],       // tick 192 = beat 2
    [24, 0x80, 62, 64],       // tick 216 = beat 2.25
    [24, 0x99, 38, 112],      // snare at tick 240 = beat 2.5
    [12, 38, 0],              // tick 252
  ], 36));                    // End of Track at tick 288

  const song = parse(bytes);
  assert.equal(song.format, 0);
  assert.equal(song.ppq, 96);
  assert.deepEqual(song.tracks, [
    {
      name: 'Song (ch 1)', program: 5, channel: 0, isDrums: false,
      notes: [note(60, 0, 1.5, 100, 0), note(62, 0, 2.25, 80, 0)]
    },
    {
      name: 'Song (ch 10)', program: null, channel: 9, isDrums: true,
      notes: [note(36, 0, 0.5, 127, 9), note(42, 0.5, 0.5, 96, 9), note(38, 2.5, 0.125, 112, 9)]
    }
  ]);
  assert.deepEqual(song.tempos, [{ tick: 0, bpm: 120, beat: 0 }, { tick: 192, bpm: 60, beat: 2 }]);
  assert.deepEqual(song.timeSigs, [{ tick: 0, num: 3, den: 4, beat: 0 }]);
  assert.equal(song.duration, 2.625);
  assert.equal(beatsToSeconds(song.tempos, song.duration), 1 + 0.625);
  assert.deepEqual(parse(bytes.buffer), song, 'ArrayBuffer input reads the same');
});

test('format 1: conductor plus 2 named tracks, program change, sysex and long meta events', () => {
  const ppq = 480;
  const gmOn = [0xf0, ...vlq(5), 0x7e, 0x7f, 0x09, 0x01, 0xf7];
  const longSysex = [0xf0, ...vlq(200), ...new Array(199).fill(0x11), 0xf7]; // two-byte length
  const bytes = smf(
    header(1, 3, ppq),
    track([[0, ...name('My Song')], [0, ...tempo(100)], [0, ...timeSig(6, 8)]]),
    track([
      [0, ...name('Bass')],
      [0, ...gmOn],
      [0, 0xc1, 33],                       // Electric Bass (finger) on channel 2
      [0, 0x91, 40, 100],
      [240, ...longSysex],
      [720, 0x81, 40, 64],                 // tick 960 = beat 2
      [0, 0xf7, ...vlq(2), 0x01, 0x02],    // escaped packet
      [480, 0x91, 43, 90],                 // beat 3
      [480, 0x81, 43, 0],                  // beat 4
    ]),
    track([
      [0, ...meta(0x01, str('x'.repeat(300)))], // 300-byte text event
      [0, ...name('Lead')],
      [960, 0x92, 72, 110],
      [160, 0x82, 72, 0],                  // a third of a beat
    ])
  );
  const song = parse(bytes);
  assert.equal(song.format, 1);
  assert.equal(song.ppq, 480);
  assert.deepEqual(song.tracks, [
    { name: 'Bass', program: 33, channel: 1, isDrums: false, notes: [note(40, 0, 2, 100, 1), note(43, 3, 1, 90, 1)] },
    { name: 'Lead', program: null, channel: 2, isDrums: false, notes: [note(72, 2, 1 / 3, 110, 2)] }
  ]);
  assert.equal(GM_PROGRAMS[song.tracks[0].program], 'Electric Bass (finger)');
  assert.deepEqual(song.tempos, [{ tick: 0, bpm: 100, beat: 0 }]);
  assert.deepEqual(song.timeSigs, [{ tick: 0, num: 6, den: 8, beat: 0 }]);
  assert.equal(song.duration, 4);
});

test('overlapping same-pitch notes pair first on, first off; unreleased notes end at End of Track', () => {
  const bytes = smf(header(0, 1, 480), track([
    [0, 0x90, 60, 100],     // A
    [240, 0x90, 60, 50],    // B starts while A still sounds
    [240, 0x80, 60, 0],     // tick 480: the first off ends A
    [480, 0x80, 60, 0],     // tick 960: the second off ends B
    [0, 0x90, 64, 70],      // never released
    [240, 0x90, 67, 80],    // never released, right at End of Track (tick 1200)
  ]));
  const song = parse(bytes);
  assert.equal(song.tracks.length, 1);
  assert.equal(song.tracks[0].name, 'Track 1');
  assert.deepEqual(song.tracks[0].notes, [
    note(60, 0, 1, 100, 0),
    note(60, 0.5, 1.5, 50, 0),
    note(64, 2, 0.5, 70, 0),
    note(67, 2.5, 1 / 16, 80, 0)
  ]);
  assert.equal(song.duration, 2.5625);

  // Without an End of Track event the last event's tick ends the track.
  const noEot = smf(header(0, 1, 480), chunk('MTrk', [0, 0x90, 60, 100, ...vlq(960), 0x90, 62, 100]));
  assert.deepEqual(parse(noEot).tracks[0].notes, [note(60, 0, 2, 100, 0), note(62, 2, 1 / 16, 100, 0)]);
});

test('format 2 patterns each start at beat 0; SMPTE ticks become beats at the first tempo', () => {
  const f2 = parse(smf(
    header(2, 2, 96),
    track([[0, ...name('Verse')], [0, 0x90, 60, 100], [96, 0x80, 60, 0]]),
    track([[0, ...name('Chorus')], [0, 0x90, 64, 100], [192, 0x80, 64, 0]])
  ));
  assert.equal(f2.format, 2);
  assert.deepEqual(f2.tracks.map((t) => [t.name, t.notes[0].start, t.notes[0].duration]), [['Verse', 0, 1], ['Chorus', 0, 2]]);

  // 25 fps x 40 ticks per frame = 1000 ticks per second.
  const smpte = parse(smf(header(0, 1, ((256 - 25) << 8) | 40), track([
    [0, ...tempo(120)],
    [0, 0x90, 60, 100],
    [1000, 0x80, 60, 0],     // 1 s = 2 beats at 120 BPM
    [500, ...tempo(60)],     // ignored: SMPTE time doesn't follow tempo
    [500, 0x90, 62, 100],    // 2 s
    [500, 0x80, 62, 0],
  ])));
  assert.equal(smpte.ppq, 500);
  assert.deepEqual(smpte.tempos, [{ tick: 0, bpm: 120, beat: 0 }]);
  assert.deepEqual(smpte.tracks[0].notes, [note(60, 0, 2, 100, 0), note(62, 4, 1, 100, 0)]);
  assert.equal(beatsToSeconds(smpte.tempos, 4), 2);
});

test('write produces the expected bytes for a tiny song', () => {
  const bytes = write({
    bpm: 120, sig: [4, 4],
    tracks: [{ name: 'A', channel: 0, program: null, notes: [{ pitch: 60, start: 0, duration: 1, velocity: 100 }] }]
  }, { ppq: 96 });
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(bytes), Array.from(smf(
    header(1, 2, 96),
    track([[0, ...tempo(120)], [0, ...timeSig(4, 4)]]),
    track([[0, ...name('A')], [0, 0x90, 60, 100], [96, 0x80, 60, 64]])
  )));
});

test('write -> parse round trip keeps beats within one tick at 480 PPQ', () => {
  const song = {
    name: 'Round Trip', bpm: 128, sig: [7, 8],
    tracks: [
      {
        name: 'Keys ♪ café', channel: 0, program: 4, notes: [
          { pitch: 60, start: 0, duration: 1 / 3, velocity: 100 },
          { pitch: 64, start: 1 / 3, duration: 1 / 3, velocity: 90 },
          { pitch: 67, start: 2 / 3, duration: 1 / 3, velocity: 80 },
          { pitch: 72, start: 1.2345, duration: 0.777, velocity: 127 }
        ]
      },
      {
        name: 'Drums', channel: 9, program: null, notes: [
          { pitch: 36, start: 0, duration: 0.25, velocity: 120 },
          { pitch: 38, start: 1, duration: 0.25, velocity: 110 }
        ]
      }
    ]
  };
  const bytes = write(song, { ppq: 480 });
  assert.deepEqual(Array.from(bytes.subarray(0, 14)), header(1, 3, 480));
  const back = parse(bytes);
  assert.equal(back.format, 1);
  assert.equal(back.ppq, 480);
  assert.deepEqual(back.tempos, [{ tick: 0, bpm: 128, beat: 0 }]);
  assert.deepEqual(back.timeSigs, [{ tick: 0, num: 7, den: 8, beat: 0 }]);
  assert.equal(back.tracks.length, 2);
  back.tracks.forEach((t, i) => {
    const src = song.tracks[i];
    assert.equal(t.name, src.name);
    assert.equal(t.channel, src.channel);
    assert.equal(t.program, src.program);
    assert.equal(t.isDrums, src.channel === 9);
    assert.equal(t.notes.length, src.notes.length);
    t.notes.forEach((n, j) => {
      const s = src.notes[j];
      assert.equal(n.pitch, s.pitch);
      assert.equal(n.velocity, s.velocity);
      assert.equal(n.channel, src.channel);
      assert.ok(Math.abs(n.start - s.start) <= 1 / 480, `start ${n.start} vs ${s.start}`);
      assert.ok(Math.abs(n.duration - s.duration) <= 1 / 480, `duration ${n.duration} vs ${s.duration}`);
    });
  });
  // Triplets land exactly on 160-tick steps.
  assert.deepEqual(back.tracks[0].notes.slice(0, 3).map((n) => [n.start, n.duration]), [[0, 1 / 3], [1 / 3, 1 / 3], [2 / 3, 1 / 3]]);
});

test('write clamps pitch, velocity and program and keeps every note at least one tick long', () => {
  const back = parse(write({
    bpm: 90,
    tracks: [{
      channel: 3, program: 200, notes: [
        { pitch: 130, start: 0, duration: 0, velocity: 0 },
        { pitch: -5, start: 1, duration: 1, velocity: 300 }
      ]
    }]
  }));
  assert.deepEqual(back.tracks, [{
    name: 'Track 1', program: 127, channel: 3, isDrums: false,
    notes: [note(127, 0, 1 / 480, 1, 3), note(0, 1, 1, 127, 3)]
  }]);
  assert.deepEqual(back.timeSigs, [{ tick: 0, num: 4, den: 4, beat: 0 }]);
});

test('equal ticks put note-off before note-on, so back-to-back repeats keep their full length', () => {
  // Listed out of order on purpose: the writer must sort them.
  const notes = [2, 0, 1].map((b) => ({ pitch: 60, start: b, duration: 1, velocity: 100 }));
  const bytes = write({ bpm: 120, tracks: [{ name: 'Rep', channel: 0, program: null, notes }] }, { ppq: 480 });
  const expected = track([
    [0, ...name('Rep')],
    [0, 0x90, 60, 100],
    [480, 0x80, 60, 64], [0, 0x90, 60, 100],
    [480, 0x80, 60, 64], [0, 0x90, 60, 100],
    [480, 0x80, 60, 64],
  ]);
  assert.deepEqual(Array.from(bytes.subarray(bytes.length - expected.length)), expected);
  assert.deepEqual(parse(bytes).tracks[0].notes, [note(60, 0, 1, 100, 0), note(60, 1, 1, 100, 0), note(60, 2, 1, 100, 0)]);
});

test('beatsToSeconds, secondsToBeats and tempoAt follow a tempo change', () => {
  const tempos = [{ tick: 0, bpm: 120, beat: 0 }, { tick: 1920, bpm: 60, beat: 4 }];
  assert.equal(beatsToSeconds(tempos, 6), 4); // 4 beats at 120 = 2 s, then 2 beats at 60 = 2 s
  assert.equal(beatsToSeconds(tempos, 4), 2);
  assert.equal(beatsToSeconds(tempos, 1), 0.5);
  assert.equal(secondsToBeats(tempos, 4), 6);
  assert.equal(secondsToBeats(tempos, 2), 4);
  assert.equal(secondsToBeats(tempos, 1), 2);
  for (let b = 0; b <= 12; b += 0.37) {
    assert.ok(Math.abs(secondsToBeats(tempos, beatsToSeconds(tempos, b)) - b) < 1e-9, `beat ${b}`);
  }
  assert.equal(tempoAt(tempos, 0), 120);
  assert.equal(tempoAt(tempos, 3.999), 120);
  assert.equal(tempoAt(tempos, 4), 60);
  assert.equal(tempoAt(tempos, 100), 60);
  assert.equal(beatsToSeconds([], 2), 1, 'an empty map means 120 BPM');
});

test('bad input throws a plain message', () => {
  const rnd = xorshift(12345);
  const junk = Uint8Array.from({ length: 1000 }, rnd);
  junk[0] = 0;
  assert.throws(() => parse(junk), { message: 'This is not a MIDI file.' });
  assert.throws(() => parse(new Uint8Array(0)), { message: 'This is not a MIDI file.' });
  assert.throws(() => parse(new ArrayBuffer(0)), { message: 'This is not a MIDI file.' });
  assert.throws(() => parse(null), { message: 'This is not a MIDI file.' });

  // MTrk claims 100 bytes but holds 8.
  const cut = smf(header(0, 1, 480), str('MTrk'), u32(100), [0, 0x90, 60, 100, 0x60, 0x80, 60, 0]);
  assert.throws(() => parse(cut), { message: 'The MIDI file is cut short.' });
  // Header cut short; an event running past its chunk.
  assert.throws(() => parse(Uint8Array.from([...str('MThd'), ...u32(6), 0, 1])), { message: 'The MIDI file is cut short.' });
  assert.throws(() => parse(smf(header(0, 1, 480), chunk('MTrk', [0, 0x90, 60]))), { message: 'The MIDI file is cut short.' });
  // A data byte with no status before it.
  assert.throws(() => parse(smf(header(0, 1, 480), chunk('MTrk', [0, 60, 100]))), { message: 'The MIDI file is damaged.' });
});

test('a 200 KB garbage MTrk body finishes quickly, throwing or returning', () => {
  const size = 200 * 1024, rnd = xorshift(987654321);
  const withStatus = Uint8Array.from({ length: size }, rnd);
  withStatus.set([0x00, 0x90, 0x3c, 0x64]); // sets running status, so the garbage is read as events
  const bodies = [
    Uint8Array.from({ length: size }, rnd),
    withStatus,
    new Uint8Array(size).fill(0xff),        // endless VLQ continuation bytes
    new Uint8Array(7 * 29258).fill(0x80)    // 4-byte deltas + note-offs: reads to the end and returns
  ];
  for (const body of bodies) {
    const file = new Uint8Array(22 + body.length);
    file.set(header(1, 1, 480));
    file.set([...str('MTrk'), ...u32(body.length)], 14);
    file.set(body, 22);
    const t0 = performance.now();
    try {
      const song = parse(file);
      assert.ok(Array.isArray(song.tracks));
    } catch (e) {
      assert.match(e.message, /^The MIDI file is (cut short|damaged)\.$/);
    }
    assert.ok(performance.now() - t0 < 1000, 'parse took too long');
  }
});

test('General MIDI program and drum names', () => {
  assert.equal(GM_PROGRAMS.length, 128);
  assert.equal(GM_PROGRAMS[0], 'Acoustic Grand Piano');
  assert.equal(GM_PROGRAMS[24], 'Acoustic Guitar (nylon)');
  assert.equal(GM_PROGRAMS[40], 'Violin');
  assert.equal(GM_PROGRAMS[127], 'Gunshot');
  assert.equal(new Set(GM_PROGRAMS).size, 128);
  assert.deepEqual(Object.keys(GM_DRUMS).map(Number), Array.from({ length: 47 }, (_, i) => 35 + i));
  assert.equal(GM_DRUMS[36], 'Bass Drum 1');
  assert.equal(GM_DRUMS[38], 'Acoustic Snare');
  assert.equal(GM_DRUMS[42], 'Closed Hi-Hat');
  assert.equal(GM_DRUMS[46], 'Open Hi-Hat');
  assert.equal(GM_DRUMS[49], 'Crash Cymbal 1');
  assert.equal(GM_DRUMS[81], 'Open Triangle');
});
