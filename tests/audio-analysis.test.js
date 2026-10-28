// Tests for js/audio-analysis.js against the EBU loudness reference signals.
// Run with: node --test tests/*.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../js/audio-analysis.js');

function sine(freq, dbfs, seconds, sr, phase = 0) {
  const n = Math.round(seconds * sr);
  const amp = Math.pow(10, dbfs / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / sr + phase);
  return out;
}

function concat(...parts) {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const stereo = (x) => [x, Float32Array.from(x)];
const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ±${tol}, got ${actual}`);

test('K-weighting matches the BS.1770-4 coefficients at 48 kHz', () => {
  const k = A.kWeighting(48000);
  near(k.shelf.b0, 1.53512485958697, 1e-9, 'shelf b0');
  near(k.shelf.b1, -2.69169618940638, 1e-9, 'shelf b1');
  near(k.shelf.b2, 1.19839281085285, 1e-9, 'shelf b2');
  near(k.shelf.a1, -1.69065929318241, 1e-9, 'shelf a1');
  near(k.shelf.a2, 0.73248077421585, 1e-9, 'shelf a2');
  near(k.highpass.a1, -1.99004745483398, 1e-9, 'highpass a1');
  near(k.highpass.a2, 0.99007225036621, 1e-9, 'highpass a2');
});

// EBU Tech 3341, table 1 (stereo, 1 kHz sine), at both common sample rates.
for (const sr of [48000, 44100]) {
  test(`EBU 3341 case 1: -23 dBFS stereo sine reads -23 LUFS (${sr} Hz)`, () => {
    const m = A.analyze(stereo(sine(1000, -23, 20, sr)), sr);
    near(m.integrated, -23, 0.1, 'integrated');
    near(m.momentaryMax, -23, 0.1, 'momentary max');
    near(m.shortTermMax, -23, 0.1, 'short-term max');
  });

  test(`EBU 3341 case 2: -33 dBFS stereo sine reads -33 LUFS (${sr} Hz)`, () => {
    near(A.analyze(stereo(sine(1000, -33, 20, sr)), sr).integrated, -33, 0.1, 'integrated');
  });

  test(`EBU 3341 case 3: relative gate ignores the quiet -36 dBFS parts (${sr} Hz)`, () => {
    const x = concat(sine(1000, -36, 10, sr), sine(1000, -23, 60, sr), sine(1000, -36, 10, sr));
    near(A.analyze(stereo(x), sr).integrated, -23, 0.1, 'integrated');
  });

  test(`EBU 3341 case 4: absolute and relative gates together (${sr} Hz)`, () => {
    const x = concat(sine(1000, -72, 10, sr), sine(1000, -36, 10, sr), sine(1000, -23, 60, sr),
      sine(1000, -36, 10, sr), sine(1000, -72, 10, sr));
    near(A.analyze(stereo(x), sr).integrated, -23, 0.1, 'integrated');
  });

  test(`EBU 3341 case 5: -26/-20/-26 dBFS reads -23 LUFS (${sr} Hz)`, () => {
    const x = concat(sine(1000, -26, 20, sr), sine(1000, -20, 20.1, sr), sine(1000, -26, 20, sr));
    near(A.analyze(stereo(x), sr).integrated, -23, 0.1, 'integrated');
  });
}

test('A single-channel 997 Hz sine at 0 dBFS reads -3.01 LUFS', () => {
  near(A.analyze([sine(997, 0, 10, 48000)], 48000).integrated, -3.01, 0.05, 'integrated');
});

// EBU Tech 3342 loudness range test signals.
const lraCases = [
  { levels: [-20, -30], lra: 10 },
  { levels: [-20, -15], lra: 5 },
  { levels: [-40, -20], lra: 20 },
  { levels: [-50, -35, -20, -35, -50], lra: 15 }
];
for (const c of lraCases) {
  test(`EBU 3342: ${c.levels.join('/')} dBFS gives LRA ${c.lra} LU`, () => {
    const x = concat(...c.levels.map((db) => sine(1000, db, 20, 48000)));
    near(A.analyze(stereo(x), 48000).loudnessRange, c.lra, 1, 'loudness range');
  });
}

test('True peak finds the inter-sample peak of a quarter-rate sine', () => {
  for (const sr of [44100, 48000]) {
    // Sampled at 45 degrees, every sample sits at 0.707 while the wave peaks at 1.0.
    const m = A.analyze(stereo(sine(sr / 4, 0, 2, sr, Math.PI / 4)), sr);
    near(m.samplePeakDb, -3.01, 0.02, `sample peak @${sr}`);
    near(m.truePeakDb, 0, 0.2, `true peak @${sr}`);
  }
});

test('True peak of sines across the audio band is within 0.25 dB', () => {
  const sr = 44100;
  for (const f of [997, 3000, 7000, 10000, 13000, 16000, 18000]) {
    for (const phase of [0, 0.37, 1.1]) {
      // Fade in so the test measures the sine, not the ringing of a hard onset.
      const x = sine(f, -6.0206, 1, sr, phase);
      const fade = Math.round(0.02 * sr);
      for (let i = 0; i < fade; i++) x[i] *= Math.sin((Math.PI / 2) * (i / fade));
      const m = A.analyze([x], sr);
      near(m.truePeakDb, -6.0206, 0.25, `true peak ${f} Hz phase ${phase}`);
    }
  }
});

test('Skipping quiet blocks never changes the true-peak result', () => {
  const sr = 48000, n = sr * 3;
  const x = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const env = i > n / 2 && i < n / 2 + 2000 ? 0.9 : 0.2; // one loud burst mid-file
    x[i] = (seed / 0x7fffffff - 0.5) * 2 * env;
  }
  // Brute-force reference with the same filter.
  const phases = A.designInterpolator(4, 16, 8);
  let ref = 0;
  for (let i = 0; i < n; i++) {
    for (const ph of phases) {
      let s = 0;
      for (let j = 0; j < ph.length && i - j >= 0; j++) s += ph[j] * x[i - j];
      ref = Math.max(ref, Math.abs(s), Math.abs(x[i]));
    }
  }
  near(A.analyze([x], sr).truePeakDb, 20 * Math.log10(ref), 1e-9, 'true peak');
});

// ---- WAV parsing --------------------------------------------------------

function writeWav(channels, sr, { bits = 16, float = false, extensible = false } = {}) {
  const ch = channels.length, frames = channels[0].length, bytes = bits / 8;
  const fmtSize = extensible ? 40 : 16;
  const dataSize = frames * ch * bytes;
  const buf = new ArrayBuffer(12 + 8 + fmtSize + 8 + dataSize);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, fmtSize, true);
  const code = float ? 3 : 1;
  v.setUint16(20, extensible ? 0xFFFE : code, true);
  v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * bytes, true); v.setUint16(32, ch * bytes, true); v.setUint16(34, bits, true);
  if (extensible) {
    v.setUint16(36, 22, true); v.setUint16(38, bits, true); v.setUint32(40, 3, true);
    v.setUint16(44, code, true); // SubFormat GUID starts with the format code
  }
  const d = 20 + fmtSize;
  str(d, 'data'); v.setUint32(d + 4, dataSize, true);
  let o = d + 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++, o += bytes) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (float) v.setFloat32(o, s, true);
      else if (bits === 16) v.setInt16(o, Math.round(s * 32767), true);
      else if (bits === 24) {
        const n = Math.round(s * 8388607);
        v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255);
      }
    }
  }
  return buf;
}

for (const opts of [{ bits: 16 }, { bits: 24 }, { bits: 32, float: true }, { bits: 32, float: true, extensible: true }, { bits: 24, extensible: true }]) {
  test(`parseWav reads ${opts.bits}-bit ${opts.float ? 'float' : 'PCM'}${opts.extensible ? ' (extensible)' : ''}`, () => {
    const l = sine(440, -6, 0.5, 48000), r = sine(660, -12, 0.5, 48000);
    const wav = A.parseWav(writeWav([l, r], 48000, opts));
    assert.equal(wav.sampleRate, 48000);
    assert.equal(wav.channels, 2);
    assert.equal(wav.bitsPerSample, opts.bits);
    assert.equal(wav.encoding, opts.float ? 'float' : 'pcm');
    assert.equal(wav.frames, l.length);
    const tol = opts.float ? 1e-7 : 2 / Math.pow(2, opts.bits - 1);
    for (let i = 0; i < l.length; i += 97) {
      near(wav.channelData[0][i], l[i], tol, 'left sample');
      near(wav.channelData[1][i], r[i], tol, 'right sample');
    }
  });
}

test('parseWav rejects files that are not WAV', () => {
  assert.throws(() => A.parseWav(new TextEncoder().encode('ID3 this is an mp3 file').buffer), /not a WAV/);
});

// ---- release checks -------------------------------------------------------

test('Silence at the start and end is measured', () => {
  const sr = 44100;
  const x = concat(new Float32Array(sr), sine(1000, -10, 2, sr), new Float32Array(3 * sr));
  const m = A.analyze(stereo(x), sr);
  near(m.leadingSilence, 1, 0.01, 'leading silence');
  near(m.trailingSilence, 3, 0.01, 'trailing silence');
});

test('An abrupt ending is flagged and a faded ending is not', () => {
  const sr = 44100;
  const cut = A.analyze(stereo(sine(220, -8, 5, sr)), sr);
  assert.ok(A.assess(cut, { container: 'WAV', bitsPerSample: 24 }).some((f) => f.title === 'Ends abruptly'));

  const faded = sine(220, -8, 5, sr);
  const fadeLen = 2 * sr;
  for (let i = 0; i < fadeLen; i++) faded[faded.length - fadeLen + i] *= 1 - i / fadeLen;
  const m = A.analyze(stereo(faded), sr);
  assert.ok(!A.assess(m, { container: 'WAV', bitsPerSample: 24 }).some((f) => f.title === 'Ends abruptly'));
});

test('Clipping, true-peak overs and polarity problems are reported', () => {
  const sr = 44100;
  const hot = sine(100, 3, 4, sr).map((s) => Math.max(-1, Math.min(1, s)));
  const inverted = Float32Array.from(hot, (s) => -s);
  const m = A.analyze([hot, inverted], sr);
  assert.ok(m.clipEvents > 0, 'clip events');
  const titles = A.assess(m, { container: 'WAV', bitsPerSample: 24 }).map((f) => f.title);
  assert.ok(titles.some((t) => /clipping event/.test(t)), 'clipping finding');
  assert.ok(titles.some((t) => /Phase problem/.test(t)), 'phase finding');
});

test('A clean -14 LUFS master passes loudness and true-peak checks', () => {
  const sr = 44100;
  const x = sine(1000, -14, 40, sr);
  for (let i = 0; i < sr; i++) x[x.length - sr + i] *= 1 - i / sr; // fade out
  const findings = A.assess(A.analyze(stereo(x), sr), { container: 'WAV', bitsPerSample: 24 });
  const failing = findings.filter((f) => f.level === 'fail' || f.level === 'warn');
  assert.deepEqual(failing, []);
});

test('A 4-minute stereo file analyzes in reasonable time', () => {
  const sr = 44100, n = sr * 240;
  const l = new Float32Array(n), r = new Float32Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    l[i] = (seed / 0x7fffffff - 0.5) * 0.5;
    r[i] = l[i] * 0.8;
  }
  const t0 = Date.now();
  A.analyze([l, r], sr);
  const ms = Date.now() - t0;
  assert.ok(ms < 20000, `took ${ms} ms`);
  console.log(`# 4-minute stereo analysis: ${ms} ms`);
});
