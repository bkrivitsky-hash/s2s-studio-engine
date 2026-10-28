/*
 * Stem to Stream: the synthesized demo loop (96 BPM, 4 bars, A minor).
 * Five mono stems rendered offline: drums, hats, bass, keys and a lead line.
 * Used by the course's Mixer Trainer and demo master, and by the studio's
 * demo song. Each stem is normalized to peak at -6 dBFS.
 */
(function () {
  'use strict';

  var S2S = (window.S2S = window.S2S || {});

  var LOOP = { bpm: 96, bars: 4, key: 'A minor' };
  LOOP.beat = 60 / LOOP.bpm;
  LOOP.seconds = LOOP.bars * 4 * LOOP.beat;

  var TRACKS = [
    { id: 'drums', name: 'Drums', color: 3 },
    { id: 'hats', name: 'Hats', color: 2 },
    { id: 'bass', name: 'Bass', color: 4 },
    { id: 'keys', name: 'Keys', color: 1 },
    { id: 'lead', name: 'Lead vocal*', color: 7 }
  ];

  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  var loopCache = {};
  function renderLoop(sr) {
    if (loopCache[sr]) return loopCache[sr];
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error('Web Audio is not available.'));
    var frames = Math.ceil(LOOP.seconds * sr);
    var beat = LOOP.beat;
    var chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]; // Am F C G
    var bassRoots = [33, 29, 36, 31];
    var mudRoots = [45, 41, 48, 43];
    var melody = [
      [76, 0, 1], [74, 1, 0.5], [72, 1.5, 0.5], [69, 2, 2],
      [72, 4, 1], [69, 5, 1], [65, 6, 0.5], [69, 6.5, 0.5], [72, 7, 1],
      [67, 8, 1], [64, 9, 0.5], [67, 9.5, 0.5], [72, 10, 2],
      [71, 12, 1], [69, 13, 0.5], [67, 13.5, 0.5], [74, 14, 1.5]
    ];

    function make() {
      var ctx = new Offline(1, frames, sr);
      return ctx;
    }
    function noiseBuffer(ctx) {
      var b = ctx.createBuffer(1, sr, sr), d = b.getChannelData(0), s = 24681;
      for (var i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
      return b;
    }
    function env(ctx, t, peak, attack, hold, release) {
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, t + attack + hold);
      g.gain.linearRampToValueAtTime(0, t + attack + hold + release);
      return g;
    }
    function tone(ctx, dest, type, freq, t, peak, attack, hold, release, detune) {
      var o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (detune) o.detune.setValueAtTime(detune, t);
      var g = env(ctx, t, peak, attack, hold, release);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + attack + hold + release + 0.02);
      return o;
    }

    function drums() {
      var ctx = make(), nb = noiseBuffer(ctx);
      for (var b = 0; b < LOOP.bars; b++) {
        [0, 2, 2.5].forEach(function (pos) {
          var t = (b * 4 + pos) * beat;
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.setValueAtTime(140, t);
          o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(1, t + 0.004);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
          o.connect(g); g.connect(ctx.destination);
          o.start(t); o.stop(t + 0.4);
        });
        [1, 3].forEach(function (pos) {
          var t = (b * 4 + pos) * beat;
          var src = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
          src.buffer = nb;
          hp.type = 'highpass'; hp.frequency.value = 1200;
          g.gain.setValueAtTime(0.75, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
          src.connect(hp); hp.connect(g); g.connect(ctx.destination);
          src.start(t, (b * 0.13 + pos * 0.07) % 0.6); src.stop(t + 0.22);
          tone(ctx, ctx.destination, 'triangle', 190, t, 0.45, 0.002, 0.01, 0.1);
        });
      }
      return ctx.startRendering();
    }

    function hats() {
      var ctx = make(), nb = noiseBuffer(ctx);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7000;
      hp.connect(ctx.destination);
      for (var i = 0; i < LOOP.bars * 8; i++) {
        var t = i * beat / 2, g = ctx.createGain(), src = ctx.createBufferSource();
        src.buffer = nb;
        g.gain.setValueAtTime(i % 2 ? 0.5 : 0.3, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
        src.connect(g); g.connect(hp);
        src.start(t, (i * 0.031) % 0.8); src.stop(t + 0.06);
      }
      return ctx.startRendering();
    }

    function bass() {
      var ctx = make(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 750; lp.Q.value = 3;
      lp.connect(ctx.destination);
      for (var b = 0; b < LOOP.bars; b++) {
        for (var e = 0; e < 8; e++) {
          var note = bassRoots[b] + (e === 3 || e === 7 ? 12 : 0);
          tone(ctx, lp, 'sawtooth', midiHz(note), (b * 4 + e / 2) * beat, 0.6, 0.005, beat / 2 - 0.06, 0.04);
        }
      }
      return ctx.startRendering();
    }

    function keys() {
      var ctx = make(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2400;
      lp.connect(ctx.destination);
      for (var b = 0; b < LOOP.bars; b++) {
        var t = b * 4 * beat, hold = 4 * beat - 0.25;
        chords[b].forEach(function (n) {
          tone(ctx, lp, 'sawtooth', midiHz(n), t, 0.16, 0.06, hold, 0.15, -6);
          tone(ctx, lp, 'sawtooth', midiHz(n), t, 0.16, 0.06, hold, 0.15, 6);
        });
        // Low-mid build-up that the "clean up the low end" exercise removes.
        tone(ctx, lp, 'sine', midiHz(mudRoots[b]), t, 0.55, 0.06, hold, 0.15);
        tone(ctx, lp, 'sawtooth', midiHz(mudRoots[b] - 12), t, 0.22, 0.06, hold, 0.15);
      }
      return ctx.startRendering();
    }

    function lead() {
      var ctx = make(), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 3600;
      lp.connect(ctx.destination);
      melody.forEach(function (n) {
        var t = n[1] * beat, dur = n[2] * beat, f = midiHz(n[0]);
        var o = tone(ctx, lp, 'triangle', f, t, 0.7, 0.03, Math.max(0.05, dur - 0.12), 0.08);
        tone(ctx, lp, 'sine', f * 2, t, 0.12, 0.03, Math.max(0.05, dur - 0.12), 0.08);
        var lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(f * 0.007, t + Math.min(0.3, dur));
        lfo.connect(depth); depth.connect(o.frequency);
        lfo.start(t); lfo.stop(t + dur + 0.1);
      });
      return ctx.startRendering();
    }

    loopCache[sr] = Promise.all([drums(), hats(), bass(), keys(), lead()]).then(function (buffers) {
      return {
        frames: frames,
        sampleRate: sr,
        tracks: TRACKS.map(function (t, i) {
          var data = buffers[i].getChannelData(0), peak = 0;
          for (var k = 0; k < data.length; k++) { var a = Math.abs(data[k]); if (a > peak) peak = a; }
          var norm = peak > 0 ? 0.5 / peak : 1; // every stem peaks at -6 dBFS
          var out = new Float32Array(data.length);
          for (k = 0; k < data.length; k++) out[k] = data[k] * norm;
          return { id: t.id, buffer: out };
        })
      };
    });
    loopCache[sr].catch(function () { delete loopCache[sr]; });
    return loopCache[sr];
  }

  S2S.demoLoop = { LOOP: LOOP, TRACKS: TRACKS, render: renderLoop, midiHz: midiHz };
})();
