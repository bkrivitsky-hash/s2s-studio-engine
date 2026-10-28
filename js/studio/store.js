/*
 * Stem to Stream Studio: songs kept in this browser (IndexedDB).
 *
 *   songs  {id, name, updated, tracks, json}   one record per song
 *   audio  {key: songId/sourceId, songId, blob} the original imported files
 *
 * Browser storage can be missing (private windows, blocked site data,
 * previews) or cleared by the browser, so open() resolves null when it is
 * unavailable and the studio keeps working in memory. A song file (.zip)
 * is the copy that doesn't depend on the browser.
 */
(function () {
  'use strict';

  var S2S = window.S2S;
  var DB_NAME = 's2s-studio', VERSION = 1;

  function promisify(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('Browser storage failed.')); };
    });
  }

  function Store(db) { this.db = db; }

  Store.prototype.tx = function (names, mode, fn) {
    var db = this.db;
    return new Promise(function (resolve, reject) {
      var t = db.transaction(names, mode), result;
      t.oncomplete = function () { resolve(result); };
      t.onerror = t.onabort = function () { reject(t.error || new Error('Browser storage failed.')); };
      Promise.resolve(fn(t)).then(function (r) { result = r; }, function (e) { try { t.abort(); } catch (x) { /* done */ } reject(e); });
    });
  };

  Store.prototype.saveSong = function (p) {
    var rec = { id: p.id, name: p.name, updated: p.updated, tracks: p.tracks.length, json: JSON.stringify(p) };
    return this.tx(['songs'], 'readwrite', function (t) { return promisify(t.objectStore('songs').put(rec)); });
  };

  Store.prototype.loadSong = function (id) {
    return this.tx(['songs'], 'readonly', function (t) {
      return promisify(t.objectStore('songs').get(id)).then(function (rec) { return rec ? rec.json : null; });
    });
  };

  /** Summaries of every saved song, newest first. */
  Store.prototype.listSongs = function () {
    return this.tx(['songs'], 'readonly', function (t) {
      return promisify(t.objectStore('songs').getAll()).then(function (all) {
        return all.map(function (r) { return { id: r.id, name: r.name, updated: r.updated, tracks: r.tracks }; })
          .sort(function (a, b) { return b.updated - a.updated; });
      });
    });
  };

  Store.prototype.deleteSong = function (id) {
    return this.tx(['songs', 'audio'], 'readwrite', function (t) {
      t.objectStore('songs').delete(id);
      var audio = t.objectStore('audio');
      return promisify(audio.index('song').getAllKeys(id)).then(function (keys) {
        keys.forEach(function (k) { audio.delete(k); });
      });
    });
  };

  Store.prototype.saveAudio = function (songId, sourceId, blob) {
    var rec = { key: songId + '/' + sourceId, songId: songId, blob: blob };
    return this.tx(['audio'], 'readwrite', function (t) { return promisify(t.objectStore('audio').put(rec)); });
  };

  Store.prototype.loadAudio = function (songId, sourceId) {
    return this.tx(['audio'], 'readonly', function (t) {
      return promisify(t.objectStore('audio').get(songId + '/' + sourceId)).then(function (r) { return r ? r.blob : null; });
    });
  };

  /** Opens browser storage. Resolves a Store, or null when the browser won't keep data. */
  function open() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      setTimeout(function () { finish(null); }, 4000);
      var req;
      try {
        if (!window.indexedDB) return finish(null);
        req = window.indexedDB.open(DB_NAME, VERSION);
      } catch (e) {
        return finish(null);
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) {
          db.createObjectStore('audio', { keyPath: 'key' }).createIndex('song', 'songId');
        }
      };
      req.onsuccess = function () { finish(new Store(req.result)); };
      req.onerror = function () { finish(null); };
      req.onblocked = function () { finish(null); };
    });
  }

  S2S.studio.store = { open: open };
})();
