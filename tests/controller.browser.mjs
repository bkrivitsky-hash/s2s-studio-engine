// Browser test for the controller on the real engine: loads dist/studio-engine.js
// into a blank page served over HTTP, then drives the demo song through
// playback, meters, mix and stem export, loudness matching, the vocal tools
// (tempo, clean-up, timing, melody to MIDI), MIDI export, song files and
// browser storage. Prints what it measured; fails on any check or page error.
// Usage: node tests/controller.browser.mjs
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(join(root, 'dist', 'studio-engine.js'));
const html = '<!doctype html><meta charset="utf-8"><title>controller test</title><script src="/studio-engine.js"></script><body></body>';
const server = createServer((req, res) => {
  if (req.url === '/studio-engine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const errors = [];
function check(ok, message) { if (!ok) errors.push(message); console.log((ok ? 'ok   ' : 'FAIL ') + message); }

const browser = await playwright.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.setDefaultTimeout(120000);
await page.goto(url);

try {
  const boot = await page.evaluate(async () => {
    const studio = window.studio = S2S.studio.createController({ initialSong: 'demo' });
    window.events = [];
    studio.subscribe((e) => window.events.push(e.type + (e.kind ? ':' + e.kind : '')));
    await studio.init();
    return { tracks: studio.song.tracks.length, clips: studio.song.clips.length, storage: studio.storage, bpm: studio.song.bpm };
  });
  check(boot.tracks === 5 && boot.clips > 10, `demo song opens: ${boot.tracks} tracks, ${boot.clips} clips`);
  check(boot.storage === 'browser', `browser storage is used (${boot.storage})`);

  const play = await page.evaluate(async () => {
    studio.play();
    let peak = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      await new Promise((r) => requestAnimationFrame(r));
      const f = studio.frame();
      peak = Math.max(peak, f.levels.left, f.levels.right);
    }
    const pos = studio.frame().position;
    studio.pause();
    return { pos, peak, playing: studio.playing, limiter: studio.limiterMode, rate: studio.sampleRate };
  });
  check(play.pos > 0.8 && play.pos < 2.5, `playback moves the position (${play.pos.toFixed(2)} s after 1.5 s)`);
  check(play.peak > 0.01, `meters see audio (peak ${play.peak.toFixed(3)})`);
  check(play.playing === false, 'pause stops playback');
  check(play.limiter === true, `precise limiter loaded (${play.limiter})`);

  const mix = await page.evaluate(async () => {
    let last = 0;
    const r = await studio.exportMix({ range: 'loop', bits: 24, rate: 48000, save: false }, (f) => { last = f; });
    return { size: r.file.blob.size, name: r.file.name, lufs: r.analysis.integrated, tp: r.analysis.truePeakDb, limiter: r.limiter, checks: r.checks.map((c) => c.tone), last };
  });
  check(mix.size > 1000000 && /mix \(loop\)\.wav$/.test(mix.name), `mix export: ${mix.name}, ${mix.size} bytes`);
  check(Number.isFinite(mix.lufs) && mix.tp < 0.5, `mix analysed: ${mix.lufs.toFixed(1)} LUFS, ${mix.tp.toFixed(1)} dBTP, limiter ${mix.limiter}`);
  check(mix.last === 1 && mix.checks.length > 0, `progress reaches 1, ${mix.checks.length} check(s)`);

  const refused = await page.evaluate(() => studio.exportMidi().then(() => 'exported', (e) => e.message));
  check(refused === 'The instrument tracks have no notes yet.', `MIDI export refuses a song without notes: ${refused}`);

  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.evaluate(() => studio.exportStems({ range: 'loop', bits: 16, rate: 44100 }).then((r) => ({ count: r.count, how: r.how })))
  ]);
  check(dl[0].suggestedFilename().endsWith(' - stems (loop).zip') && dl[1].count === 5 && dl[1].how === 'started',
    `stems download: ${dl[0].suggestedFilename()}, ${dl[1].count} stems`);

  const grid = await page.evaluate(async () => {
    const r = await studio.detectGrid();
    return { bpm: r.bpm, bar: r.barOffset, text: r.text, busy: studio.busy, song: studio.song.bpm };
  });
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  check(near(grid.bpm, 96) || near(grid.bpm, 48) || near(grid.bpm, 192), `tempo detected: ${grid.bpm} BPM (demo is 96), bar 1 at ${grid.bar.toFixed(3)} s`);
  check(grid.song === grid.bpm && grid.busy === null, 'detected tempo is applied and the tool is done');
  await page.evaluate(() => { studio.undo(); });

  const tools = await page.evaluate(async () => {
    const S = S2S.studio, p = studio.song;
    const lead = p.clips.find((c) => S.core.getTrack(p, c.trackId).name === 'Lead synth');
    const keys = p.clips.find((c) => S.core.getTrack(p, c.trackId).name === 'Keys');
    const drums = p.clips.find((c) => S.core.getTrack(p, c.trackId).name === 'Drums');
    const mel = await studio.melodyToMidi(lead.id, 'pluck');
    const midiTrack = studio.song.tracks.find((t) => t.id === mel.trackId);
    const midiOut = await studio.exportMidi({ save: false });
    const clean = await studio.cleanUp(keys.id, { preset: 'mix' });
    const versions = studio.versionsOf(keys.id);
    studio.useVersion(keys.id, versions[0].id);
    const back = studio.versionsOf(keys.id).find((v) => v.current).label;
    const timing = await studio.checkTiming(drums.id, { subdivision: 16 });
    return {
      notes: mel.notes, midiType: midiTrack && midiTrack.type, midiNotes: midiOut.notes,
      cleanText: clean.text, versions: versions.map((v) => v.label), back,
      marks: (studio.marks[drums.id] || []).length, timing: timing.report.count
    };
  });
  check(tools.notes > 3 && tools.midiType === 'midi' && tools.midiNotes === tools.notes, `melody to MIDI: ${tools.notes} notes on an instrument track, all exported`);
  check(tools.versions.length === 2 && tools.versions[1] === 'cleaned' && tools.back === 'Original', `clean-up adds a version (${tools.versions.join(', ')}); switching back works`);
  check(tools.marks > 0 && tools.marks === tools.timing, `timing check marks ${tools.marks} hits on the drums`);

  const loud = await page.evaluate(async () => {
    const before = studio.song.master.limiter.driveDb;
    const r = await studio.matchLoudness(-14);
    const after = studio.song.master.limiter.driveDb;
    studio.undo();
    return { lufs: r.integrated, tp: r.truePeakDb, before, after, undone: studio.song.master.limiter.driveDb };
  });
  check(Math.abs(loud.lufs + 14) <= 1, `match loudness: ${loud.lufs.toFixed(1)} LUFS at drive ${loud.after} dB, true peak ${loud.tp.toFixed(1)} dBTP`);
  check(loud.undone === loud.before, 'undo restores the limiter drive');

  const files = await page.evaluate(async () => {
    const tracks = studio.song.tracks.length;
    const { file } = await studio.saveSongFile({ save: false });
    studio.newSong();
    const r = await studio.openSongFile(file.blob);
    const missing = studio.song.clips.filter((c) => !c.notes && !studio.buffers[c.sourceId]).length;
    await studio.saveNow();
    const list = await studio.listSongs();
    return { tracks, reopened: studio.song.tracks.length, missing: r.missing + missing, saved: list.some((s) => s.current), state: studio.saveState };
  });
  check(files.reopened === files.tracks && files.missing === 0, `song file round trip: ${files.reopened} tracks, no audio missing`);
  check(files.saved && files.state === 'saved', 'the reopened song is saved in the browser');

  const reload = await page.evaluate(async () => {
    const id = studio.song.id;
    const fresh = S2S.studio.createController();
    await fresh.init();
    return { same: fresh.song.id === id, tracks: fresh.song.tracks.length, audio: fresh.song.clips.filter((c) => !c.notes && fresh.buffers[c.sourceId]).length };
  });
  check(reload.same && reload.audio > 0, `a new controller reopens the last song with its audio (${reload.tracks} tracks)`);

  const counts = await page.evaluate(() => {
    const c = {};
    window.events.forEach((e) => { c[e] = (c[e] || 0) + 1; });
    return c;
  });
  check(counts['change:open'] >= 2 && counts['transport'] >= 2 && counts['busy'] >= 2, 'change, transport and busy events fire');
} catch (e) {
  errors.push(String(e && e.stack || e));
}

await browser.close();
server.close();
if (errors.length) {
  console.error('\n' + errors.length + ' problem(s):\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nController browser test passed.');
