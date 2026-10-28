/*
 * Stem to Stream Studio: WAV writer.
 *
 *   encodeWav([left, right], 48000, { bits: 24 })  ->  ArrayBuffer
 *
 * bits 16 and 24 write PCM with TPDF dither (one LSB, from a fixed seed so
 * the same mix always gives the same file); bits 32 writes IEEE float.
 * Samples beyond full scale are clipped in PCM and kept in float.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.wav = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function encodeWav(channels, sampleRate, opts) {
    var bits = (opts && opts.bits) || 24;
    if ([16, 24, 32].indexOf(bits) < 0) throw new Error('Unsupported bit depth: ' + bits + '.');
    var nch = channels.length;
    if (!nch) throw new Error('Nothing to write: the audio has no channels.');
    var frames = channels[0].length, isFloat = bits === 32, bytes = bits / 8;
    var block = nch * bytes, dataSize = frames * block;
    // Float files carry the extended fmt chunk and a fact chunk, as the spec asks.
    var header = isFloat ? 58 : 44;
    if (header + dataSize > 0xFFFFFFFF) throw new Error('The export is longer than a WAV file can hold (4 GB).');

    var buf = new ArrayBuffer(header + dataSize), v = new DataView(buf);
    writeAscii(v, 0, 'RIFF');
    v.setUint32(4, header - 8 + dataSize, true);
    writeAscii(v, 8, 'WAVE');
    writeAscii(v, 12, 'fmt ');
    v.setUint32(16, isFloat ? 18 : 16, true);
    v.setUint16(20, isFloat ? 3 : 1, true);
    v.setUint16(22, nch, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * block, true);
    v.setUint16(32, block, true);
    v.setUint16(34, bits, true);
    var p = 36;
    if (isFloat) {
      v.setUint16(36, 0, true); // cbSize
      writeAscii(v, 38, 'fact');
      v.setUint32(42, 4, true);
      v.setUint32(46, frames, true);
      p = 50;
    }
    writeAscii(v, p, 'data');
    v.setUint32(p + 4, dataSize, true);

    var i, c, x, o = header;
    if (isFloat) {
      for (i = 0; i < frames; i++) {
        for (c = 0; c < nch; c++, o += 4) v.setFloat32(o, channels[c][i], true);
      }
      return buf;
    }

    var scale = bits === 16 ? 32768 : 8388608, hi = scale - 1, lo = -scale;
    var seed = 0x9e3779b9;
    function rand() { // xorshift32 in [0, 1)
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    }
    if (bits === 16) {
      var pcm16 = new Int16Array(buf, header, frames * nch);
      for (i = 0, o = 0; i < frames; i++) {
        for (c = 0; c < nch; c++) {
          x = Math.round(channels[c][i] * scale + rand() - rand());
          pcm16[o++] = x > hi ? hi : x < lo ? lo : x;
        }
      }
      return buf;
    }
    var u8 = new Uint8Array(buf, header);
    for (i = 0, o = 0; i < frames; i++) {
      for (c = 0; c < nch; c++) {
        x = Math.round(channels[c][i] * scale + rand() - rand());
        x = x > hi ? hi : x < lo ? lo : x;
        u8[o++] = x & 0xff;
        u8[o++] = (x >> 8) & 0xff;
        u8[o++] = (x >> 16) & 0xff;
      }
    }
    return buf;
  }

  /** Highest absolute sample value across channels. */
  function peak(channels) {
    var m = 0;
    for (var c = 0; c < channels.length; c++) {
      var d = channels[c];
      for (var i = 0; i < d.length; i++) {
        var a = d[i] < 0 ? -d[i] : d[i];
        if (a > m) m = a;
      }
    }
    return m;
  }

  return { encodeWav: encodeWav, peak: peak };
});
