// Unit tests for the studio's WAV writer and ZIP reader/writer.
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { encodeWav, peak } = require('../js/studio/wav.js');
const { crc32, ZipWriter, readZip } = require('../js/studio/zip.js');
const { parseWav } = require('../js/audio-analysis.js');

function sine(frames, freq, sr, amp) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
  return out;
}

test('24-bit and 16-bit WAVs read back within dither noise', () => {
  const sr = 48000, l = sine(4800, 1000, sr, 0.5), r = sine(4800, 500, sr, -0.25);
  for (const [bits, tol] of [[24, 3 / 8388608], [16, 3 / 32768]]) {
    const wav = parseWav(encodeWav([l, r], sr, { bits }));
    assert.equal(wav.sampleRate, sr);
    assert.equal(wav.channels, 2);
    assert.equal(wav.frames, 4800);
    assert.equal(wav.bitsPerSample, bits);
    assert.equal(wav.encoding, 'pcm');
    let worst = 0;
    for (let i = 0; i < 4800; i++) {
      worst = Math.max(worst, Math.abs(wav.channelData[0][i] - l[i]), Math.abs(wav.channelData[1][i] - r[i]));
    }
    assert.ok(worst <= tol, `${bits}-bit error ${worst} exceeds ${tol}`);
  }
});

test('32-bit float WAV is bit exact, keeps overs and has a fact chunk', () => {
  const sr = 44100, x = sine(1000, 440, sr, 1.5);
  const buf = encodeWav([x], sr, { bits: 32 });
  const head = Buffer.from(buf.slice(0, 58)).toString('latin1');
  assert.ok(head.includes('fact'));
  const wav = parseWav(buf);
  assert.equal(wav.encoding, 'float');
  assert.equal(wav.channels, 1);
  for (let i = 0; i < 1000; i++) assert.equal(wav.channelData[0][i], x[i]);
});

test('PCM clips at full scale and dither is the same every time', () => {
  const x = new Float32Array([2, -2, 0, 0.000001]);
  const a = new Uint8Array(encodeWav([x], 48000, { bits: 16 }));
  const b = new Uint8Array(encodeWav([x], 48000, { bits: 16 }));
  assert.deepEqual(a, b);
  const wav = parseWav(a.buffer);
  assert.equal(wav.channelData[0][0], 32767 / 32768);
  assert.equal(wav.channelData[0][1], -1);
  assert.equal(peak([x, new Float32Array([-3])]), 3);
  assert.throws(() => encodeWav([x], 48000, { bits: 20 }), /Unsupported bit depth/);
});

test('CRC-32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('a written ZIP reads back, including UTF-8 names', async () => {
  const z = new ZipWriter();
  z.add('song.json', '{"a":1}');
  z.add('audio/Vocals – take 2.wav', new Uint8Array([1, 2, 3, 4, 5]));
  z.add('empty.txt', '');
  const blob = z.finish();
  const files = await readZip(await blob.arrayBuffer());
  assert.deepEqual(files.map((f) => f.name), ['song.json', 'audio/Vocals – take 2.wav', 'empty.txt']);
  assert.equal(new TextDecoder().decode(files[0].data), '{"a":1}');
  assert.deepEqual([...files[1].data], [1, 2, 3, 4, 5]);
  assert.equal(files[2].data.length, 0);
});

test('a deflated entry from another zip tool still opens', async () => {
  const content = Buffer.from('hello hello hello hello hello'.repeat(20));
  const deflated = zlib.deflateRawSync(content);
  const name = Buffer.from('song.json');
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + deflated.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(cdOffset, 16);
  const zipBytes = Buffer.concat([local, name, deflated, central, name, end]);
  const files = await readZip(new Uint8Array(zipBytes));
  assert.equal(Buffer.from(files[0].data).toString(), content.toString());
});

test('damaged archives are refused with a clear message', async () => {
  await assert.rejects(readZip(new Uint8Array(40)), /not a ZIP archive/);
  const z = new ZipWriter();
  z.add('a.txt', 'abc');
  const bytes = new Uint8Array(await z.finish().arrayBuffer());
  bytes[30 + 5] ^= 0xff; // corrupt the stored data
  await assert.rejects(readZip(bytes), /damaged/);
});
