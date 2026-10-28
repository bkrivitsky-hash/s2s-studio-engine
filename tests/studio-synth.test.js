// Unit tests for the parts of the built-in instruments that don't need an
// audio context: pitch and velocity maths, envelope breakpoints, the
// parameter schema, presets, parameter checking and release tails.
// The sound itself is tested in Chromium by tests/synth.browser.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const synth = require('../js/studio/synth.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('midiHz: A4 is 440 Hz, octaves double, other tunings and bends', () => {
  assert.equal(synth.midiHz(69), 440);
  assert.equal(synth.midiHz(81), 880);
  assert.equal(synth.midiHz(57), 220);
  near(synth.midiHz(60), 261.6255653, 1e-6, 'middle C');
  near(synth.midiHz(21), 27.5, 1e-9, 'A0');
  assert.equal(synth.midiHz(69, 432), 432);
  near(synth.midiHz(69.5), 440 * Math.pow(2, 1 / 24), 1e-9, 'quarter tone');
  assert.equal(synth.midiHz(69, -5), 440);
  assert.equal(synth.midiHz(69, 'x'), 440);
  assert.equal(synth.midiHz(NaN), 440);
});

test('noteName: middle C is C4, sharps, both ends of the MIDI range', () => {
  assert.equal(synth.noteName(60), 'C4');
  assert.equal(synth.noteName(69), 'A4');
  assert.equal(synth.noteName(61), 'C#4');
  assert.equal(synth.noteName(59), 'B3');
  assert.equal(synth.noteName(0), 'C-1');
  assert.equal(synth.noteName(127), 'G9');
  assert.equal(synth.noteName(60.4), 'C4');
  assert.equal(synth.noteName('60'), '');
  assert.equal(synth.noteName(NaN), '');
});

test('velocityGain: 127 is full level, amount sets the curve, bad input is safe', () => {
  for (const a of [0, 0.3, 0.5, 1]) assert.equal(synth.velocityGain(127, a), 1);
  for (const v of [1, 30, 64, 100]) assert.equal(synth.velocityGain(v, 0), 1);
  near(synth.velocityGain(64, 1), Math.pow(64 / 127, 2), 1e-12, 'GM curve');
  near(synth.velocityGain(64, 0.5), 64 / 127, 1e-12, 'linear');
  let prev = 0;
  for (let v = 1; v <= 127; v++) {
    const g = synth.velocityGain(v, 0.7);
    assert.ok(g > prev && g <= 1, `velocity ${v}`);
    prev = g;
  }
  assert.equal(synth.velocityGain(0, 1), synth.velocityGain(1, 1));
  assert.equal(synth.velocityGain(500, 1), 1);
  assert.ok(Number.isFinite(synth.velocityGain('loud', 'very')));
});

function checkShape(pts) {
  assert.deepEqual(pts[0], { t: 0, v: 0 });
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].t >= pts[i - 1].t, `time goes back at point ${i}`);
    assert.ok(pts[i].v >= 0 && pts[i].v <= 1 && Number.isFinite(pts[i].v), `value ${pts[i].v} at point ${i}`);
  }
}

test('adsrPoints: attack, decay to sustain, release from the note end down to 0', () => {
  const adsr = { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 };
  const pts = synth.adsrPoints(adsr, 1);
  checkShape(pts);
  assert.deepEqual(pts[1], { t: 0.01, v: 1 });
  assert.equal(synth.envelopeAt(pts, 0.005), 0.5);
  near(synth.envelopeAt(pts, 0.21), 0.5, 1e-12, 'sustain after the decay');
  near(synth.envelopeAt(pts, 0.7), 0.5, 1e-12, 'sustain holds');
  near(synth.envelopeAt(pts, 1), 0.5, 1e-12, 'release starts from the sustain level');
  const last = pts[pts.length - 1];
  near(last.t, 1.3, 1e-12, 'release ends at duration + release');
  assert.equal(last.v, 0);
  // Decays and releases fall evenly in dB: half way, 30 dB down (to within 0.1%).
  near(synth.envelopeAt(pts, 0.01 + 0.1) - 0.5, 0.5 * (Math.pow(1000, -0.5) - 0.001) / 0.999, 1e-3, 'decay half way');
  near(synth.envelopeAt(pts, 1 + 0.15), 0.5 * (Math.pow(1000, -0.5) - 0.001) / 0.999, 1e-3, 'release half way');
  for (let t = 1; t < 1.3; t += 0.01) assert.ok(synth.envelopeAt(pts, t + 0.01) <= synth.envelopeAt(pts, t) + 1e-12, 'release falls');
});

test('adsrPoints: a note shorter than its attack releases from where it got to', () => {
  const pts = synth.adsrPoints({ attack: 0.1, decay: 0.2, sustain: 0.8, release: 0.05 }, 0.04);
  checkShape(pts);
  near(synth.envelopeAt(pts, 0.04), 0.4, 1e-12, 'level at the note end');
  assert.ok(pts.every((p) => p.v <= 0.4 + 1e-12), 'never louder than where the attack stopped');
  near(pts[pts.length - 1].t, 0.09, 1e-12, 'release length');
  // A note cut during the decay continues smoothly.
  const mid = synth.adsrPoints({ attack: 0.01, decay: 0.5, sustain: 0.2, release: 0.1 }, 0.1);
  const held = synth.adsrPoints({ attack: 0.01, decay: 0.5, sustain: 0.2, release: 0.1 }, null);
  for (let t = 0; t <= 0.1; t += 0.005) near(synth.envelopeAt(mid, t), synth.envelopeAt(held, t), 1e-12, `t=${t}`);
});

test('adsrPoints: held notes, sustain 0, zero attack and junk', () => {
  const held = synth.adsrPoints({ attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.5 }, Infinity);
  checkShape(held);
  assert.equal(held[held.length - 1].v, 0.6);
  assert.deepEqual(synth.adsrPoints({ attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.5 }, null), held);
  const pluck = synth.adsrPoints({ attack: 0.001, decay: 0.3, sustain: 0, release: 1 }, 5);
  checkShape(pluck);
  const end = pluck[pluck.length - 1];
  assert.equal(end.v, 0);
  near(end.t, 0.301, 1e-12, 'a sustain-0 note is over when its decay is');
  const instant = synth.adsrPoints({ attack: 0, decay: 0, sustain: 1, release: 0 }, 0.5);
  checkShape(instant);
  assert.ok(instant[1].t >= 0.001, 'attack is at least 1 ms');
  assert.ok(instant[instant.length - 1].t > 0.5, 'release takes time');
  assert.equal(instant[instant.length - 1].v, 0);
  for (const junk of [null, {}, { attack: 'x', sustain: 9, release: -1 }]) checkShape(synth.adsrPoints(junk, 0.2));
  assert.deepEqual(synth.adsrPoints({ attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 }, 0).slice(-1)[0], { t: 0, v: 0 });
});

const REQUIRED = {
  synth: ['osc1Wave', 'osc2Wave', 'osc2Detune', 'osc2Semi', 'oscMix', 'subLevel', 'cutoffHz', 'resonance', 'filterEnv', 'keyTrack',
    'ampAttackMs', 'ampDecayMs', 'ampSustain', 'ampReleaseMs', 'filtAttackMs', 'filtDecayMs', 'filtSustain', 'filtReleaseMs',
    'glideMs', 'poly', 'unison', 'spreadCents', 'vibRateHz', 'vibDepth', 'velFilter', 'velAmp', 'levelDb'],
  fm: ['ratio', 'index', 'indexDecayMs', 'attackMs', 'decayMs', 'sustain', 'releaseMs', 'brightVel', 'tremDepth', 'levelDb'],
  organ: ['draw16', 'draw8', 'draw4', 'draw2', 'perc', 'rotary', 'levelDb'],
  drums: ['kickTune', 'kickDecayMs', 'snareTone', 'snareSnappy', 'hatDecayMs', 'hatTone', 'tomTune', 'levelDb']
};

test('schema: every parameter has a label, a range and a default inside it', () => {
  assert.deepEqual(Object.keys(synth.INSTRUMENTS).sort(), ['drums', 'fm', 'organ', 'synth']);
  for (const [type, inst] of Object.entries(synth.INSTRUMENTS)) {
    assert.ok(typeof inst.name === 'string' && inst.name, `${type} name`);
    assert.equal(inst.kind, type === 'drums' ? 'drums' : 'synth');
    for (const k of REQUIRED[type]) assert.ok(inst.params[k], `${type} lacks ${k}`);
    for (const [k, s] of Object.entries(inst.params)) {
      const where = `${type}.${k}`;
      assert.ok(typeof s.label === 'string' && s.label.length > 1, `${where} label`);
      if (s.options) {
        assert.ok(Array.isArray(s.options) && s.options.length > 1, `${where} options`);
        assert.ok(s.options.includes(s.def), `${where} default is not an option`);
        continue;
      }
      assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max) && s.min < s.max, `${where} range`);
      assert.ok(s.step > 0 && s.step <= s.max - s.min, `${where} step`);
      assert.equal(typeof s.unit, 'string', `${where} unit`);
      assert.ok(Number.isFinite(s.def) && s.def >= s.min && s.def <= s.max, `${where} default ${s.def} outside ${s.min}..${s.max}`);
      if (s.log) assert.ok(s.min > 0, `${where} is log but starts at ${s.min}`);
      assert.deepEqual(Object.keys(s).filter((x) => !['label', 'min', 'max', 'step', 'unit', 'def', 'log', 'offAt'].includes(x)), [], `${where} extra fields`);
    }
  }
  const p = synth.INSTRUMENTS.synth.params;
  assert.deepEqual(p.osc1Wave.options, ['sine', 'triangle', 'sawtooth', 'square']);
  assert.deepEqual(p.poly.options, ['poly', 'mono']);
  assert.deepEqual([p.osc2Detune.min, p.osc2Detune.max, p.osc2Semi.min, p.osc2Semi.max], [-50, 50, -24, 24]);
  assert.deepEqual([p.cutoffHz.min, p.cutoffHz.max, p.cutoffHz.log], [40, 18000, true]);
  assert.deepEqual([p.resonance.min, p.resonance.max, p.filterEnv.min, p.filterEnv.max], [0, 20, 0, 6]);
  assert.deepEqual([p.unison.min, p.unison.max], [1, 4]);
  assert.ok(p.ampAttackMs.log && p.ampDecayMs.log && p.ampReleaseMs.log && p.ampSustain.max === 1);
  assert.equal(synth.MAX_VOICES, 24);
});

test('defaults, presets and presetById', () => {
  for (const type of Object.keys(synth.INSTRUMENTS)) {
    const d = synth.defaults(type), specs = synth.INSTRUMENTS[type].params;
    assert.deepEqual(Object.keys(d), Object.keys(specs));
    for (const k of Object.keys(d)) assert.equal(d[k], specs[k].def);
    d.levelDb = 3;
    assert.equal(synth.defaults(type).levelDb, specs.levelDb.def, 'defaults() returns a fresh object');
  }
  const want = { 'Analog lead': 'synth', 'Soft pad': 'synth', 'Sub bass': 'synth', 'Acid bass': 'synth', Pluck: 'synth', 'Brass stab': 'synth',
    Strings: 'synth', 'E-piano': 'fm', Bell: 'fm', Organ: 'organ', 'Drum kit': 'drums', '808 kit': 'drums' };
  for (const [name, type] of Object.entries(want)) {
    const pr = synth.PRESETS.find((x) => x.name === name);
    assert.ok(pr, `missing preset ${name}`);
    assert.equal(pr.type, type, name);
  }
  const ids = synth.PRESETS.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'preset ids are unique');
  for (const pr of synth.PRESETS) {
    assert.ok(/^[a-z0-9-]+$/.test(pr.id), pr.id);
    assert.deepEqual(synth.clampParams(pr.type, pr.p), pr.p, `${pr.name} changes when checked`);
    const copy = synth.presetById(pr.id);
    assert.deepEqual(copy, pr);
    copy.p.levelDb = -20;
    assert.notEqual(pr.p.levelDb, -20, 'presetById returns a copy');
  }
  assert.equal(synth.presetById('nope'), null);
  assert.equal(synth.presetById(undefined), null);
  const pad = synth.presetById('soft-pad').p;
  assert.ok(pad.ampAttackMs >= 300 && pad.unison >= 3 && pad.spreadCents >= 10, 'the pad has a slow attack and a wide detune');
  const acid = synth.presetById('acid-bass').p;
  assert.ok(acid.resonance >= 10 && acid.filterEnv >= 2 && acid.poly === 'mono', 'the acid bass has resonance and a filter sweep');
});

test('clampParams: junk in, a complete valid parameter set out', () => {
  for (const junk of [null, undefined, 3, 'x', [], [1, 2], true]) assert.deepEqual(synth.clampParams('synth', junk), synth.defaults('synth'));
  const p = synth.clampParams('synth', {
    cutoffHz: 1e9, resonance: -4, oscMix: NaN, subLevel: Infinity, osc1Wave: 'noise', osc2Wave: 'square',
    poly: 'MONO', unison: 2.6, osc2Semi: -7.4, glideMs: '100', levelDb: null, vibDepth: { a: 1 }, junk: 1, constructor: 'x'
  });
  assert.equal(p.cutoffHz, 18000);
  assert.equal(p.resonance, 0);
  assert.equal(p.oscMix, 0.5);
  assert.equal(p.subLevel, 0);
  assert.equal(p.osc1Wave, 'sawtooth');
  assert.equal(p.osc2Wave, 'square');
  assert.equal(p.poly, 'poly');
  assert.equal(p.unison, 3);
  assert.equal(p.osc2Semi, -7);
  assert.equal(p.glideMs, 0);
  assert.equal(p.levelDb, 0);
  assert.equal(p.vibDepth, 0);
  assert.deepEqual(Object.keys(p), Object.keys(synth.INSTRUMENTS.synth.params), 'exactly the schema keys');
  // Unknown types fall back to the synth; a song file can't reach the prototype.
  assert.deepEqual(synth.clampParams('theremin', {}), synth.defaults('synth'));
  assert.deepEqual(synth.clampParams('toString', {}), synth.defaults('synth'));
  const evil = synth.clampParams('fm', JSON.parse('{"__proto__": {"polluted": 1, "ratio": 99}, "ratio": 2}'));
  assert.equal(evil.ratio, 2);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(evil), Object.prototype);
  const inherited = synth.clampParams('organ', Object.create({ draw16: 0 }));
  assert.equal(inherited.draw16, synth.INSTRUMENTS.organ.params.draw16.def, 'only own keys count');
  // Every type survives random junk with values in range.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const values = [0, -1, 1e12, -1e12, 0.5, NaN, Infinity, '', 'sine', null, [], {}, true, 3.7];
  for (const type of Object.keys(synth.INSTRUMENTS)) {
    const specs = synth.INSTRUMENTS[type].params;
    for (let n = 0; n < 200; n++) {
      const raw = {};
      for (const k of Object.keys(specs)) if (rnd() < 0.8) raw[k] = values[Math.floor(rnd() * values.length)];
      const out = synth.clampParams(type, raw);
      for (const [k, s] of Object.entries(specs)) {
        if (s.options) assert.ok(s.options.includes(out[k]), `${type}.${k} = ${out[k]}`);
        else assert.ok(Number.isFinite(out[k]) && out[k] >= s.min && out[k] <= s.max, `${type}.${k} = ${out[k]}`);
      }
      assert.deepEqual(synth.clampParams(type, out), out, 'checking twice changes nothing');
    }
  }
});

test('releaseOf: seconds of tail after a note, without an audio context', () => {
  const s = synth.defaults('synth');
  near(synth.releaseOf({ type: 'synth', p: s }), s.ampReleaseMs / 1000, 0.02, 'synth');
  near(synth.releaseOf({ type: 'synth', p: Object.assign({}, s, { ampReleaseMs: 4000 }) }), 4, 0.02, 'long release');
  near(synth.releaseOf({ type: 'fm', p: synth.presetById('bell').p }), synth.presetById('bell').p.releaseMs / 1000, 0.02, 'bell');
  const organ = synth.releaseOf({ type: 'organ', p: synth.defaults('organ') });
  assert.ok(organ > 0.05 && organ < 0.2, `organ ${organ}`);
  const kit = synth.releaseOf({ type: 'drums', p: synth.defaults('drums') });
  assert.ok(kit >= 2 && kit < 4, `drum kit ${kit}`);
  const boom = synth.releaseOf({ type: 'drums', p: Object.assign(synth.defaults('drums'), { kickDecayMs: 2000 }) });
  assert.ok(boom >= kit && boom >= 2, 'a long kick lengthens the tail');
  // The engine passes {type, preset, p}; with no p the preset's settings count.
  assert.equal(synth.releaseOf({ type: 'fm', preset: 'bell' }), synth.releaseOf(synth.presetById('bell')));
  for (const junk of [null, undefined, {}, { type: 'x', p: 'y' }, { type: 'synth', p: { ampReleaseMs: 'long' } }]) {
    const r = synth.releaseOf(junk);
    assert.ok(Number.isFinite(r) && r > 0, `releaseOf(${JSON.stringify(junk)}) = ${r}`);
  }
});

test('the module is ES5 (the app has no build step)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../js/studio/synth.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  assert.ok(!/=>/.test(code), 'arrow function');
  assert.ok(!/\b(let|const|class)\s/.test(code), 'let, const or class');
  assert.ok(!/`/.test(code), 'template string');
  assert.ok(!/\.\.\.[A-Za-z_$[]/.test(code), 'spread');
  assert.equal(typeof synth.createInstrument, 'function');
});
