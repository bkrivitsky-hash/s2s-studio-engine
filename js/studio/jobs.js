/*
 * Stem to Stream Studio: runs the vocal tools off the main thread.
 *
 * The worker is built from the same module factories the page loaded
 * (fft, pitch, rhythm, cleanup, melody, vocal), so it needs no extra files. Where a
 * browser won't start the worker, the job runs on the page instead (slower
 * to respond while it works, same result).
 *
 *   S2S.studio.jobs.run('clean', { channels, sampleRate }, opts, onProgress)
 *     -> Promise of the tool's result (see dsp/vocal.js)
 */
(function () {
  'use strict';

  var S2S = window.S2S, S = S2S.studio;
  var MODULES = ['fft', 'pitch', 'rhythm', 'cleanup', 'melody', 'vocal'];
  var worker = null, broken = false, seq = 0, pending = {};

  var DISPATCH = [
    'self.onmessage = function (e) {',
    '  var d = e.data, V = self.S2S.studio.vocal, last = 0;',
    '  try {',
    '    var opts = d.opts || {};',
    '    opts.onProgress = function (f) {',
    '      var now = Date.now();',
    '      if (now - last > 100) { last = now; self.postMessage({ id: d.id, progress: f }); }',
    '    };',
    '    var res = V[d.op](d.input, opts), transfer = [];',
    '    if (res && res.channels) res.channels.forEach(function (c) { if (transfer.indexOf(c.buffer) < 0) transfer.push(c.buffer); });',
    '    self.postMessage({ id: d.id, result: res }, transfer);',
    '  } catch (err) {',
    '    self.postMessage({ id: d.id, error: err && err.message ? err.message : String(err) });',
    '  }',
    '};'
  ].join('\n');

  function workerSource() {
    var parts = ['self.S2S = { studio: { factories: {} } };'];
    MODULES.forEach(function (m) {
      parts.push('self.S2S.studio.' + m + ' = (' + S.factories[m].toString() + ')();');
    });
    parts.push(DISPATCH);
    return parts.join('\n');
  }

  function plainOpts(opts) {
    var out = {};
    Object.keys(opts || {}).forEach(function (k) { if (typeof opts[k] !== 'function') out[k] = opts[k]; });
    return out;
  }

  /** Runs on the page: same result, but the page waits while it works. */
  function runHere(op, input, opts, onProgress) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var o = plainOpts(opts);
          o.onProgress = onProgress || function () {};
          resolve(S.vocal[op](input, o));
        } catch (e) {
          reject(e);
        }
      }, 30);
    });
  }

  function failAll(message) {
    broken = true;
    if (worker) { try { worker.terminate(); } catch (e) { /* gone */ } }
    worker = null;
    var jobs = pending;
    pending = {};
    // Jobs that never got an answer run again on the page.
    Object.keys(jobs).forEach(function (id) {
      var j = jobs[id];
      runHere(j.op, j.input, j.opts, j.onProgress).then(j.resolve, j.reject);
    });
    if (message && window.console) console.warn('Vocal tools are running on the page: ' + message);
  }

  function startWorker() {
    if (worker || broken) return worker;
    try {
      var url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = function (e) {
        var d = e.data, j = pending[d.id];
        if (!j) return;
        if (d.progress != null) { if (j.onProgress) j.onProgress(d.progress); return; }
        delete pending[d.id];
        if (d.error) j.reject(new Error(d.error));
        else j.resolve(d.result);
      };
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        failAll(e && e.message);
      };
    } catch (e) {
      failAll(e && e.message);
    }
    return worker;
  }

  /**
   * Runs a vocal tool. The worker gets copies of input.channels (and
   * input.ref); the caller's audio is never handed away or changed.
   */
  function run(op, input, opts, onProgress) {
    if (!startWorker()) return runHere(op, input, opts, onProgress);
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      // The original input is kept (not copied) in case the job must rerun on the page.
      pending[id] = { op: op, input: input, opts: opts, onProgress: onProgress, resolve: resolve, reject: reject };
      try {
        var sent = { sampleRate: input.sampleRate }, moved = [];
        ['channels', 'ref'].forEach(function (k) {
          if (!input[k]) return;
          sent[k] = input[k].map(function (c) { var x = new Float32Array(c); moved.push(x.buffer); return x; });
        });
        worker.postMessage({ id: id, op: op, input: sent, opts: plainOpts(opts) }, moved);
      } catch (e) {
        failAll(e && e.message);
      }
    });
  }

  S.jobs = { run: run, workerSource: workerSource };
})();
