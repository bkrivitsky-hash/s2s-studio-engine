/*
 * Stem to Stream Studio: a small ZIP writer and reader.
 *
 * Writes "stored" (uncompressed) entries: audio barely compresses, and this
 * keeps exports fast. Each added file is handed to a Blob straight away, so a
 * stems export doesn't hold every WAV in memory at once.
 * Reads stored entries, and deflated ones where the browser has
 * DecompressionStream, so a song file re-zipped by another tool still opens.
 * No ZIP64: one archive must stay under 4 GB.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.S2S = root.S2S || {};
    root.S2S.studio = root.S2S.studio || {};
    root.S2S.studio.zip = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function toBytes(data) {
    if (typeof data === 'string') return utf8(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('Unsupported zip entry data.');
  }

  function dosDateTime(date) {
    var d = date || new Date();
    var year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function ZipWriter() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  /** Adds one file. `data` is a string, ArrayBuffer or typed array. */
  ZipWriter.prototype.add = function (name, data, date) {
    var bytes = toBytes(data), nameBytes = utf8(name), dt = dosDateTime(date);
    if (this.offset + 30 + nameBytes.length + bytes.length > 0xFFFFFFFF) {
      throw new Error('The archive would be larger than 4 GB. Export fewer tracks at a time.');
    }
    var head = new Uint8Array(30 + nameBytes.length), v = new DataView(head.buffer), crc = crc32(bytes);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);       // version needed
    v.setUint16(6, 0x0800, true);   // UTF-8 names
    v.setUint16(8, 0, true);        // stored
    v.setUint16(10, dt.time, true);
    v.setUint16(12, dt.date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, bytes.length, true);
    v.setUint32(22, bytes.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    head.set(nameBytes, 30);
    this.parts.push(head, typeof Blob !== 'undefined' ? new Blob([bytes]) : bytes);
    this.entries.push({ name: nameBytes, crc: crc, size: bytes.length, offset: this.offset, dt: dt });
    this.offset += head.length + bytes.length;
  };

  /** Finishes the archive and returns it as a Blob. */
  ZipWriter.prototype.finish = function () {
    var cdStart = this.offset, cdSize = 0, self = this;
    this.entries.forEach(function (e) {
      var rec = new Uint8Array(46 + e.name.length), v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);     // version made by
      v.setUint16(6, 20, true);     // version needed
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.dt.time, true);
      v.setUint16(14, e.dt.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      self.parts.push(rec);
      cdSize += rec.length;
    });
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.entries.length, true);
    ev.setUint16(10, this.entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    this.parts.push(end);
    return new Blob(this.parts, { type: 'application/zip' });
  };

  function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('This song file is compressed in a way this browser cannot open. Open it in a current Chrome, Edge, Firefox or Safari.'));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  /** Reads a ZIP archive. Resolves [{name, data: Uint8Array}]. */
  function readZip(buffer) {
    return Promise.resolve().then(function () {
      var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      var v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), eocd = -1;
      for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
        if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('This file is not a ZIP archive.');
      var count = v.getUint16(eocd + 10, true), cd = v.getUint32(eocd + 16, true);
      if (cd === 0xFFFFFFFF || count === 0xFFFF) throw new Error('Archives larger than 4 GB are not supported.');
      var decoder = new TextDecoder(), jobs = [], p = cd;
      for (var n = 0; n < count; n++) {
        if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('The ZIP archive is damaged.');
        var method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true);
        var compSize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
        var nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
        var local = v.getUint32(p + 42, true);
        var name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (name.slice(-1) === '/') continue; // folder entry
        if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new Error('The ZIP archive is damaged.');
        var dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        var raw = bytes.subarray(dataStart, dataStart + compSize);
        if (raw.length !== compSize) throw new Error('The ZIP archive is cut short.');
        jobs.push(readEntry(name, method, raw, size, crc));
      }
      return Promise.all(jobs);
    });
  }

  function readEntry(name, method, raw, size, crc) {
    var data;
    if (method === 0) data = Promise.resolve(raw);
    else if (method === 8) data = inflateRaw(raw);
    else return Promise.reject(new Error('"' + name + '" uses a ZIP compression method this app does not read.'));
    return data.then(function (out) {
      if (out.length !== size || crc32(out) !== crc) throw new Error('"' + name + '" in the archive is damaged.');
      return { name: name, data: out };
    });
  }

  return { crc32: crc32, ZipWriter: ZipWriter, readZip: readZip };
});
