/*
 * Stem to Stream Studio: audio engine (Web Audio).
 *
 * Each clip piece is an AudioBufferSourceNode with its own gain node (fades
 * and clip gain), feeding its track: track effects -> track gain (volume x
 * mute/solo) -> stereo pan -> master sum -> master effects -> master fader
 * -> limiter -> speakers. Instrument (MIDI) tracks have a synth from
 * S2S.studio.synth feeding the same track chain; their notes are scheduled
 * a little ahead while playing. Analysers tap every track and the master's
 * left and right channels for the meters. Export renders the same graph in
 * an OfflineAudioContext.
 */
(function () {
  'use strict';

  var S2S = window.S2S;
  var core = S2S.studio.core, fxLib = S2S.studio.fx;

  var LEAD = 0.06;          // seconds between pressing Play and the first sample
  var AHEAD = 1.5;          // loop passes are scheduled this far ahead
  var CLICK_AHEAD = 0.15;   // metronome lookahead
  var MIDI_AHEAD = 0.3;     // MIDI notes are scheduled this far ahead
  var TICK_MS = 25;

  function synthLib() { return S2S.studio.synth || null; }

  /**
   * The instrument settings a synth gets: the track's own values over its
   * preset's (a song may store only the preset), checked against the synth's ranges.
   */
  function instOf(t) {
    var lib = synthLib(), inst = t.inst || { type: 'synth', p: {} };
    if (!lib) return inst;
    var pr = inst.preset && lib.presetById(inst.preset), p = {};
    if (pr && pr.type === inst.type) Object.keys(pr.p || {}).forEach(function (k) { p[k] = pr.p[k]; });
    Object.keys(inst.p || {}).forEach(function (k) { p[k] = inst.p[k]; });
    return { type: inst.type, preset: inst.preset, p: lib.clampParams(inst.type, p) };
  }

  function makeInstrument(ctx, t, output) {
    var lib = synthLib();
    if (!lib || !core.isMidiTrack(t)) return null;
    try {
      return lib.createInstrument(ctx, instOf(t), output);
    } catch (e) {
      if (window.console) console.error(e);
      return null;
    }
  }

  /** Schedules one clip piece; returns {src, gain} or null when nothing would sound. */
  function schedulePiece(ctx, dest, seg, buffer, when) {
    var offset = Math.min(seg.offset, buffer.duration);
    var duration = Math.min(seg.duration, buffer.duration - offset);
    if (duration <= 0) return null;
    var src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    var pts = core.gainPoints(seg.clip, seg.inClip, seg.inClip + duration);
    gain.gain.setValueAtTime(pts[0].g, when);
    for (var i = 1; i < pts.length; i++) {
      gain.gain.linearRampToValueAtTime(pts[i].g, when + (pts[i].t - seg.inClip));
    }
    src.connect(gain);
    gain.connect(dest);
    src.start(when, offset, duration);
    return { src: src, gain: gain };
  }

  function peakOf(analyser, scratch) {
    analyser.getFloatTimeDomainData(scratch);
    var m = 0;
    for (var i = 0; i < scratch.length; i++) {
      var a = scratch[i] < 0 ? -scratch[i] : scratch[i];
      if (a > m) m = a;
    }
    return m;
  }

  function Engine() {
    this.ctx = null;
    this.tracks = {};
    this.voices = [];
    this.playing = false;
    this.metronome = false;
    this.anchor = null;
    this.loop = null;
    this.onEnded = null;
    this.timer = 0;
    this.workletOk = null; // null until the limiter's worklet has loaded (or failed to)
  }

  /** Signature of the effects that are switched on; a change means the chain is rebuilt. */
  function chainSig(list) {
    return list.filter(function (f) { return f.on; }).map(function (f) { return f.id + ':' + f.type; }).join(',');
  }

  /** Builds units for the effects that are on and wires input -> units -> output. */
  function buildChain(ctx, list, env, input, output) {
    var units = [], prev = input;
    list.forEach(function (f) {
      if (!f.on) return;
      var u = fxLib.createUnit(ctx, f, env);
      prev.connect(u.input);
      prev = u.output;
      units.push(u);
    });
    prev.connect(output);
    return units;
  }

  /** Creates the audio context on first use. Throws if the browser has no Web Audio. */
  Engine.prototype.ensure = function () {
    if (this.ctx) return this.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser has no Web Audio support. Use a current Chrome, Edge, Firefox or Safari.');
    var ctx = (this.ctx = new AC({ latencyHint: 'interactive' })), self = this;
    // Tracks -> master sum -> master effects -> master fader -> limiter -> out.
    this.masterSum = ctx.createGain();
    this.masterFader = ctx.createGain();
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    var split = ctx.createChannelSplitter(2);
    this.out.connect(split);
    this.meterL = ctx.createAnalyser();
    this.meterR = ctx.createAnalyser();
    this.meterL.fftSize = this.meterR.fftSize = 2048;
    split.connect(this.meterL, 0);
    split.connect(this.meterR, 1);
    this.masterUnits = [];
    this.limiter = null;
    this.masterSig = null;
    this.clickBus = ctx.createGain();
    this.clickBus.gain.value = 0.45;
    this.clickBus.connect(ctx.destination);
    this.scratch = new Float32Array(2048);
    fxLib.ensureWorklet(ctx).then(function (ok) {
      self.workletOk = ok;
      if (self.project) self.sync(self.project);
    });
    return ctx;
  };

  /** Decodes compressed audio (MP3, M4A, FLAC, OGG...) at the device sample rate. */
  Engine.prototype.decode = function (arrayBuffer) {
    var ctx = this.ensure();
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(arrayBuffer, resolve, function () {
        reject(new Error('The browser could not decode this audio file.'));
      });
      if (p && p.catch) p.catch(function () {}); // the callbacks above report the result
    });
  };

  /** Matches the audio graph to the song: track nodes, effect chains, master chain. */
  Engine.prototype.sync = function (p) {
    var ctx = this.ensure(), self = this, keep = {}, env = { bpm: p.bpm };
    this.project = p;
    p.tracks.forEach(function (t) {
      keep[t.id] = true;
      var n = self.tracks[t.id];
      if (!n) {
        n = self.tracks[t.id] = {
          sum: ctx.createGain(), vol: ctx.createGain(), pan: ctx.createStereoPanner(),
          meter: ctx.createAnalyser(), units: [], sig: null
        };
        n.meter.fftSize = 1024;
        n.vol.connect(n.pan);
        n.pan.connect(self.masterSum);
        n.pan.connect(n.meter);
      }
      var sig = chainSig(t.fx);
      if (sig !== n.sig) {
        n.sum.disconnect();
        n.units.forEach(function (u) { u.dispose(); });
        n.units = buildChain(ctx, t.fx, env, n.sum, n.vol);
        n.sig = sig;
      }
      var itype = core.isMidiTrack(t) ? t.inst.type : null;
      if (itype !== n.itype) {
        if (n.inst) n.inst.dispose();
        n.inst = makeInstrument(ctx, t, n.sum);
        n.itype = itype;
      }
    });
    Object.keys(this.tracks).forEach(function (id) {
      if (keep[id]) return;
      var n = self.tracks[id];
      if (n.inst) n.inst.dispose();
      n.sum.disconnect();
      n.units.forEach(function (u) { u.dispose(); });
      n.vol.disconnect();
      n.pan.disconnect();
      delete self.tracks[id];
    });
    var msig = chainSig(p.master.fx) + '|' + this.workletOk;
    if (msig !== this.masterSig) {
      this.masterSum.disconnect();
      this.masterUnits.forEach(function (u) { u.dispose(); });
      this.masterFader.disconnect();
      if (this.limiter) this.limiter.dispose();
      this.masterUnits = buildChain(ctx, p.master.fx, env, this.masterSum, this.masterFader);
      // Until the worklet has answered, play without a limiter rather than wait.
      this.limiter = this.workletOk === null ? null : fxLib.limiterUnit(ctx, p.master.limiter, this.workletOk);
      if (this.limiter) { this.masterFader.connect(this.limiter.input); this.limiter.output.connect(this.out); }
      else this.masterFader.connect(this.out);
      this.masterSig = msig;
    }
    this.applyMix(p);
    this.applyFx(p);
  };

  /** Volume, pan, mute/solo and master level, smoothed to avoid clicks. */
  Engine.prototype.applyMix = function (p) {
    if (!this.ctx) return;
    var now = this.ctx.currentTime, self = this;
    p.tracks.forEach(function (t) {
      var n = self.tracks[t.id];
      if (!n) return;
      n.vol.gain.setTargetAtTime(core.trackGain(p, t), now, 0.012);
      n.pan.pan.setTargetAtTime(t.pan, now, 0.012);
    });
    this.masterFader.gain.setTargetAtTime(core.dbToGain(p.masterDb), now, 0.012);
  };

  /** Pushes effect and limiter settings into the running units. */
  Engine.prototype.applyFx = function (p) {
    if (!this.ctx) return;
    var self = this, env = { bpm: p.bpm };
    function update(units, list) {
      units.forEach(function (u) {
        for (var i = 0; i < list.length; i++) if (list[i].id === u.id) { u.set(list[i], env); return; }
      });
    }
    p.tracks.forEach(function (t) {
      var n = self.tracks[t.id];
      if (!n) return;
      update(n.units, t.fx);
      if (n.inst && core.isMidiTrack(t)) n.inst.set(instOf(t));
    });
    update(this.masterUnits, p.master.fx);
    if (this.limiter) this.limiter.set(p.master.limiter);
  };

  /** True when the precise (worklet) limiter is running; false for the basic one; null while loading. */
  Engine.prototype.limiterMode = function () { return this.workletOk; };

  /** Starts playback of song `p` at position `pos` (seconds). Call from a click or key press. */
  Engine.prototype.play = function (p, buffers, pos) {
    var ctx = this.ensure();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    this.stopVoices();
    clearInterval(this.timer);
    this.project = p;
    this.buffers = buffers;
    this.sync(p);
    var t0 = ctx.currentTime + LEAD;
    this.anchor = { ctxTime: t0, pos: pos };
    this.loop = { on: p.loop.on, start: p.loop.start, end: p.loop.end };
    this.end = core.songEnd(p);
    this.playing = true;
    this.clickFrom = t0;
    this.midiFrom = t0;
    this.midiChase = true;
    if (core.loopActive(this.loop, pos)) {
      this.scheduleRange(pos, this.loop.end, t0);
      this.nextPass = t0 + (this.loop.end - pos);
    } else {
      this.scheduleRange(pos, Math.max(pos, this.end), t0);
      this.nextPass = Infinity;
    }
    this.timer = setInterval(this.tick.bind(this), TICK_MS);
    this.tick();
  };

  Engine.prototype.scheduleRange = function (from, to, when) {
    var self = this;
    core.planSegments(this.project, from, to).forEach(function (seg) {
      var n = self.tracks[seg.clip.trackId], buffer = self.buffers[seg.clip.sourceId];
      if (!n || !buffer) return;
      var v = schedulePiece(self.ctx, n.sum, seg, buffer, when + (seg.at - from));
      if (!v) return;
      self.voices.push(v);
      v.src.onended = function () {
        var i = self.voices.indexOf(v);
        if (i >= 0) self.voices.splice(i, 1);
        v.gain.disconnect();
      };
    });
  };

  Engine.prototype.tick = function () {
    if (!this.playing) return;
    var now = this.ctx.currentTime, len = this.loop.end - this.loop.start;
    while (this.nextPass < now + AHEAD) {
      this.scheduleRange(this.loop.start, this.loop.end, this.nextPass);
      this.nextPass += len;
    }
    if (this.metronome) this.scheduleClicks(Math.max(this.clickFrom, now), now + CLICK_AHEAD);
    this.clickFrom = Math.max(this.clickFrom, now + CLICK_AHEAD);
    if (now + MIDI_AHEAD > this.midiFrom) {
      this.scheduleMidi(this.midiFrom, now + MIDI_AHEAD);
      this.midiFrom = now + MIDI_AHEAD;
    }
    if (this.nextPass === Infinity && core.positionAt(this.anchor, this.loop, now) > this.end + 0.2) {
      var start = this.anchor.pos;
      this.stop();
      if (this.onEnded) this.onEnded(start);
    }
  };

  Engine.prototype.scheduleClicks = function (a, b) {
    var p = this.project, beat = core.beatSec(p), perBar = p.sig[0], self = this;
    core.transportPieces(this.anchor, this.loop, a, b).forEach(function (piece) {
      var posEnd = piece.pos + (piece.ctxEnd - piece.ctxStart);
      for (var k = Math.ceil((piece.pos - p.gridOffset) / beat - 1e-9); ; k++) {
        var at = p.gridOffset + k * beat;
        if (at >= posEnd - 1e-9) break;
        self.click(piece.ctxStart + (at - piece.pos), ((k % perBar) + perBar) % perBar === 0);
      }
    });
  };

  /** Schedules the MIDI notes for audio-clock time [a, b), following loop jumps. */
  Engine.prototype.scheduleMidi = function (a, b) {
    var p = this.project, self = this;
    if (!p.tracks.some(core.isMidiTrack)) return;
    var limit = core.loopActive(this.loop, this.anchor.pos) ? this.loop.end : Infinity;
    core.transportPieces(this.anchor, this.loop, a, b).forEach(function (piece) {
      var from = piece.pos, to = piece.pos + (piece.ctxEnd - piece.ctxStart);
      core.midiEvents(p, from, to, { chase: self.midiChase, limit: limit }).forEach(function (ev) {
        var n = self.tracks[ev.trackId];
        if (n && n.inst) n.inst.play(ev.p, ev.v, piece.ctxStart + (ev.at - from), ev.d);
      });
      self.midiChase = false;
    });
  };

  /** Plays one note now on a MIDI track (note previews in the editor). */
  Engine.prototype.audition = function (p, trackId, pitch, velocity, duration) {
    var ctx = this.ensure();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    this.sync(p);
    var n = this.tracks[trackId];
    if (n && n.inst) n.inst.play(pitch, velocity || 100, ctx.currentTime + 0.01, duration || 0.3);
  };

  /** Live playing from a MIDI keyboard: note on (velocity > 0) or off. */
  Engine.prototype.liveNote = function (p, trackId, pitch, velocity) {
    var ctx = this.ensure();
    if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    if (!this.tracks[trackId]) this.sync(p);
    var n = this.tracks[trackId];
    if (!n || !n.inst) return;
    if (velocity > 0) n.inst.noteOn(pitch, velocity, ctx.currentTime);
    else n.inst.noteOff(pitch, ctx.currentTime);
  };

  Engine.prototype.click = function (when, accent) {
    var ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 1 : 0.55, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g);
    g.connect(this.clickBus);
    o.start(when);
    o.stop(when + 0.06);
  };

  Engine.prototype.setMetronome = function (on) {
    this.metronome = on;
    if (on && this.playing) this.clickFrom = this.ctx.currentTime + 0.02;
  };

  Engine.prototype.stopVoices = function () {
    if (!this.ctx) return;
    var now = this.ctx.currentTime, self = this;
    Object.keys(this.tracks).forEach(function (id) { if (self.tracks[id].inst) self.tracks[id].inst.stopAll(now); });
    this.voices.forEach(function (v) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, 0.004);
        v.src.stop(now + 0.03);
      } catch (e) { /* already stopped */ }
    });
    this.voices = [];
  };

  Engine.prototype.stop = function () {
    this.playing = false;
    clearInterval(this.timer);
    this.stopVoices();
  };

  /** Song position being heard now, or null when stopped. */
  Engine.prototype.position = function () {
    if (!this.playing) return null;
    var latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return core.positionAt(this.anchor, this.loop, this.ctx.currentTime - latency);
  };

  /**
   * Levels since the last call: peaks (linear) for the master and each
   * track, and gain reduction (dB) for the limiter and each compressor.
   */
  Engine.prototype.levels = function () {
    var out = { left: 0, right: 0, tracks: {}, limiterDb: 0, comps: {} };
    if (!this.ctx) return out;
    var self = this;
    function grab(units) {
      units.forEach(function (u) { if (u.reduction) out.comps[u.id] = u.reduction(); });
    }
    Object.keys(this.tracks).forEach(function (id) { grab(self.tracks[id].units); });
    grab(this.masterUnits);
    if (this.limiter) out.limiterDb = this.limiter.reduction();
    if (!this.playing) return out;
    var s = this.scratch, small = this.scratch.subarray(0, 1024);
    out.left = peakOf(this.meterL, s);
    out.right = peakOf(this.meterR, s);
    Object.keys(this.tracks).forEach(function (id) { out.tracks[id] = peakOf(self.tracks[id].meter, small); });
    return out;
  };

  /** Seconds of reverb, delay and instrument release tail after the last clip (0 when there are none). */
  Engine.tail = function (p) {
    var tail = 0, lib = synthLib();
    p.tracks.forEach(function (t) {
      if (core.isMidiTrack(t) && lib && lib.releaseOf) tail = Math.max(tail, lib.releaseOf(instOf(t)));
    });
    p.tracks.concat([{ fx: p.master.fx }]).forEach(function (t) {
      t.fx.forEach(function (f) {
        if (!f.on) return;
        if (f.type === 'reverb') tail = Math.max(tail, f.p.decayS + f.p.preDelayMs / 1000);
        if (f.type === 'delay' && f.p.feedback > 0) {
          var time = f.p.sync !== 'off' ? fxLib.noteSec(f.p.sync, p.bpm) : f.p.timeMs / 1000;
          tail = Math.max(tail, time * Math.ceil(Math.log(0.001) / Math.log(f.p.feedback / 100)));
        }
      });
    });
    return Math.min(10, tail);
  };

  /**
   * Renders song time [from, to) to stereo at `sampleRate`, through the same
   * effects, master chain and limiter as playback. opts.trackIds limits the
   * render to those tracks and opts.master = false skips the master effects
   * and limiter (stems). Resolves {getChannelData(c), length, sampleRate}.
   */
  Engine.render = function (p, buffers, opts) {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error('This browser cannot render audio offline.'));
    var sr = opts.sampleRate, from = opts.from, to = opts.to, useMaster = opts.master !== false;
    var length = Math.max(1, Math.ceil((to - from) * sr)), spare = Math.ceil(0.05 * sr);
    var ctx = new Offline(2, length + spare, sr), env = { bpm: p.bpm };
    return (useMaster ? fxLib.ensureWorklet(ctx) : Promise.resolve(false)).then(function (workletOk) {
      var masterIn = ctx.createGain(), fader = ctx.createGain(), latency = 0;
      fader.gain.value = core.dbToGain(p.masterDb);
      if (useMaster) {
        buildChain(ctx, p.master.fx, env, masterIn, fader);
        var lim = fxLib.limiterUnit(ctx, p.master.limiter, workletOk);
        fader.connect(lim.input);
        lim.output.connect(ctx.destination);
        latency = Math.round(lim.latency * sr);
      } else {
        masterIn.connect(fader);
        fader.connect(ctx.destination);
      }
      var inputs = {}, insts = {};
      p.tracks.forEach(function (t) {
        if (opts.trackIds && opts.trackIds.indexOf(t.id) < 0) return;
        var g = core.trackGain(p, t);
        if (!g) return;
        var sum = ctx.createGain(), vol = ctx.createGain(), pan = ctx.createStereoPanner();
        vol.gain.value = g;
        pan.pan.value = t.pan;
        buildChain(ctx, t.fx, env, sum, vol);
        vol.connect(pan);
        pan.connect(masterIn);
        inputs[t.id] = sum;
        if (core.isMidiTrack(t)) insts[t.id] = makeInstrument(ctx, t, sum);
      });
      core.planSegments(p, from, to).forEach(function (seg) {
        var dest = inputs[seg.clip.trackId], buffer = buffers[seg.clip.sourceId];
        if (dest && buffer) schedulePiece(ctx, dest, seg, buffer, seg.at - from);
      });
      core.midiEvents(p, from, to, { chase: true }).forEach(function (ev) {
        var inst = insts[ev.trackId];
        if (inst) inst.play(ev.p, ev.v, ev.at - from, ev.d);
      });
      if (opts.onProgress && ctx.suspend) {
        // Pause at whole render quanta (128 frames) to report progress.
        var total = (length + spare) / sr, used = {};
        for (var i = 1; i < 10; i++) {
          var q = Math.floor((length + spare) * i / 10 / 128) * 128;
          if (q <= 0 || q >= length + spare || used[q]) continue;
          used[q] = true;
          (function (t) {
            try {
              ctx.suspend(t).then(function () {
                opts.onProgress(t / total);
                ctx.resume();
              }, function () { /* progress is optional */ });
            } catch (e) { /* progress is optional */ }
          })(q / sr);
        }
      }
      return ctx.startRendering().then(function (buf) {
        // Skip the limiter's lookahead delay so the export lines up with the song.
        var off = Math.min(latency, spare);
        return {
          length: length,
          sampleRate: sr,
          numberOfChannels: 2,
          limiter: useMaster ? (workletOk ? 'precise' : 'basic') : 'none',
          getChannelData: function (c) { return buf.getChannelData(c).subarray(off, off + length); }
        };
      });
    });
  };

  S2S.studio.Engine = Engine;
})();
