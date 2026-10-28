// Unit tests for the master limiter and the effect settings in the song model.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LimiterCore, workletSource } = require('../js/studio/dsp/limiter.js');
const { analyze } = require('../js/audio-analysis.js');
const core = require('../js/studio/core.js');

const SR = 48000;

function run(lim, channels, block = 128) {
  const n = channels[0].length, out = channels.map(() => new Float32Array(n));
  for (let s = 0; s < n; s += block) {
    const m = Math.min(block, n - s);
    lim.process(channels.map((c) => c.subarray(s, s + m)), out.map((c) => c.subarray(s, s + m)), m);
  }
  return out;
}

function sine(freq, amp, seconds, phase = 0) {
  const n = Math.round(seconds * SR), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR + phase);
  return x;
}

function noise(amp, seconds, seed = 1) {
  const n = Math.round(seconds * SR), x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; x[i] = amp * (s / 0x3fffffff - 1); }
  return x;
}

test('quiet audio passes through untouched, only delayed', () => {
  const lim = new LimiterCore(SR, 2), lat = lim.latency();
  const l = sine(440, 0.1, 0.5), r = sine(660, 0.1, 0.5);
  const [ol, or] = run(lim, [l, r]);
  for (let i = 0; i + lat < l.length; i++) {
    assert.ok(Math.abs(ol[i + lat] - l[i]) < 1e-6 && Math.abs(or[i + lat] - r[i]) < 1e-6, `sample ${i}`);
  }
  assert.equal(lim.takeMinGain(), 1);
});

test('loud material stays under the ceiling, also between samples', () => {
  const cases = {
    'sine +6 dBFS': [sine(997, 2, 2), sine(997, 2, 2)],
    'noise x3': [noise(3, 2, 7), noise(3, 2, 11)],
    'inter-sample peaks near fs/4': [sine(SR / 4 - 3, 1.6, 2, Math.PI / 4), sine(SR / 4 - 5, 1.6, 2, Math.PI / 3)],
    'drums-like bursts': [noise(1, 2, 3).map((v, i) => v * 4 * Math.exp(-(i % 12000) / 900)), noise(1, 2, 5).map((v, i) => v * 4 * Math.exp(-(i % 12000) / 900))]
  };
  for (const [name, input] of Object.entries(cases)) {
    const lim = new LimiterCore(SR, 2);
    lim.set({ ceilingDb: -1, driveDb: 0, releaseMs: 100 });
    const out = run(lim, input);
    const ceiling = Math.pow(10, -1 / 20);
    let peak = 0;
    for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak <= ceiling + 1e-7, `${name}: sample peak ${20 * Math.log10(peak)} dBFS`);
    const tp = analyze(out, SR).truePeakDb;
    assert.ok(tp <= -1 + 0.05, `${name}: true peak ${tp.toFixed(3)} dBTP`);
    assert.equal(lim.clipped, 0, `${name}: the safety clipper had to act`);
    assert.ok(lim.takeMinGain() < 1, `${name}: no limiting happened`);
  }
});

test('drive raises the level and gain recovers after a peak', () => {
  const lim = new LimiterCore(SR, 1), lat = lim.latency();
  lim.set({ driveDb: 6, ceilingDb: -1, releaseMs: 50 });
  const quiet = sine(500, 0.05, 0.2);
  const out = run(lim, [quiet])[0];
  const k = Math.pow(10, 6 / 20);
  for (let i = 1000; i + lat < quiet.length; i++) assert.ok(Math.abs(out[i + lat] - quiet[i] * k) < 1e-6);

  const lim2 = new LimiterCore(SR, 1);
  lim2.set({ ceilingDb: -1, releaseMs: 50 });
  const burst = new Float32Array(SR);
  for (let i = 0; i < SR; i++) burst[i] = i < 2400 ? 3 * Math.sin(i / 7) : 0.2 * Math.sin(2 * Math.PI * 300 * i / SR);
  const o2 = run(lim2, [burst])[0];
  let tail = 0;
  for (let i = SR - 4800; i < SR; i++) tail = Math.max(tail, Math.abs(o2[i]));
  assert.ok(Math.abs(tail - 0.2) < 0.005, `gain did not recover: tail peak ${tail}`);
});

test('bypassed limiter only delays', () => {
  const lim = new LimiterCore(SR, 1), lat = lim.latency();
  lim.set({ on: false, driveDb: 12 });
  const x = sine(220, 1.5, 0.2);
  const out = run(lim, [x])[0];
  for (let i = 0; i + lat < x.length; i++) assert.ok(Math.abs(out[i + lat] - x[i]) < 1e-6);
});

test('the worklet source embeds the limiter and registers the processor', () => {
  const factory = require('node:fs').readFileSync(require.resolve('../js/studio/dsp/limiter.js'), 'utf8');
  const src = workletSource('function () { return { LimiterCore: function () {} }; }');
  assert.match(src, /registerProcessor\("s2s-limiter"/);
  assert.match(src, /class S2SLimiter extends AudioWorkletProcessor/);
  assert.ok(factory.length > 0);
});

test('effects and limiter settings are created with defaults and repaired on load', () => {
  const p = core.createProject();
  assert.deepEqual(p.master.limiter, { on: true, driveDb: 0, ceilingDb: -1, releaseMs: 120 });
  const t = core.addTrack(p);
  const eq = core.addFx(t.fx, 'eq');
  assert.equal(eq.p.lpHz, 20000);
  core.setFxParam(eq, 'lowDb', 99);
  assert.equal(eq.p.lowDb, 18);
  const d = core.addFx(t.fx, 'delay', 0);
  assert.equal(t.fx[0], d);
  core.setFxParam(d, 'sync', 'bogus');
  assert.equal(d.p.sync, '1/8');
  assert.equal(core.findFx(p, eq.id).fx, eq);
  assert.throws(() => core.addFx(t.fx, 'flanger'), /Unknown effect/);

  const raw = JSON.parse(core.serialize(p));
  raw.tracks[0].fx.push({ type: 'flanger' }, { id: d.id, type: 'comp', p: { ratio: 500 } });
  raw.master.limiter = { on: false, ceilingDb: 3 };
  const back = core.parseProject(raw);
  assert.equal(back.tracks[0].fx.length, 3, 'unknown effect dropped');
  assert.notEqual(back.tracks[0].fx[2].id, d.id, 'duplicate effect id replaced');
  assert.equal(back.tracks[0].fx[2].p.ratio, 20);
  assert.deepEqual(back.master.limiter, { on: false, driveDb: 0, ceilingDb: 0, releaseMs: 120 });
});
