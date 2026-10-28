// Unit tests for the effect helpers that don't need an audio context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../js/studio/fx.js');
const core = require('../js/studio/core.js');

const FREQS = [20, 30, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000];

test('a flat EQ measures flat, and each band moves where it should', () => {
  const p = core.fxDefaults('eq');
  const flat = fx.eqResponse(p, 48000, FREQS);
  flat.forEach((db, i) => { if (FREQS[i] >= 30) assert.ok(Math.abs(db) < 0.1, `${FREQS[i]} Hz: ${db}`); });

  const boosted = fx.eqResponse(Object.assign({}, p, { lowDb: 6, lowHz: 100 }), 48000, [30, 4000]);
  assert.ok(Math.abs(boosted[0] - 6) < 0.3 && Math.abs(boosted[1]) < 0.2, `low shelf: ${boosted}`);
  const mid = fx.eqResponse(Object.assign({}, p, { midHz: 1000, midDb: -9 }), 48000, [1000, 100, 10000]);
  assert.ok(Math.abs(mid[0] + 9) < 0.05 && Math.abs(mid[1]) < 0.5 && Math.abs(mid[2]) < 0.5, `peak: ${mid}`);
  const cut = fx.eqResponse(Object.assign({}, p, { hpHz: 100 }), 48000, [100, 25, 1000]);
  assert.ok(Math.abs(cut[0] + 3) < 0.1 && cut[1] < -20 && Math.abs(cut[2]) < 0.1, `low cut: ${cut}`);
  const top = fx.eqResponse(Object.assign({}, p, { lpHz: 5000 }), 48000, [5000, 15000]);
  assert.ok(Math.abs(top[0] + 3) < 0.15 && top[1] < -15, `high cut: ${top}`);
});

test('tempo-synced delay times', () => {
  assert.equal(fx.noteSec('1/4', 120), 0.5);
  assert.equal(fx.noteSec('1/8', 120), 0.25);
  assert.equal(fx.noteSec('1/8d', 120), 0.375);
  assert.ok(Math.abs(fx.noteSec('1/8t', 120) - 1 / 6) < 1e-12);
});

test('the drive curve is odd, bounded and steeper with more drive', () => {
  const soft = fx.driveCurve(0), hard = fx.driveCurve(100);
  assert.ok(Math.abs(soft[0] + 1) < 1e-6 && Math.abs(soft[2047] - 1) < 1e-6);
  for (let i = 0; i < 2048; i++) assert.ok(Math.abs(hard[i] + hard[2047 - i]) < 1e-6);
  assert.ok(hard[1300] > soft[1300]);
});
