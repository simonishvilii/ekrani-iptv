/*
 * Sound, all synthesised with Web Audio (no sound files): an engine per human car (two oscillators
 * through a low-pass filter, pitch from fake gears), tyre squeal (filtered noise), hits, beeps, boost.
 */
var Sfx = (function () {
  'use strict';

  var ctx = null, master = null, noise = null, engines = [];

  function init() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { return false; }
    master = ctx.createGain();
    master.gain.value = 0.5;
    var comp = ctx.createDynamicsCompressor();
    master.connect(comp); comp.connect(ctx.destination);
    var len = ctx.sampleRate, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noise = buf;
    return true;
  }

  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

  function Engine() {
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator(); this.o2.type = 'square';
    this.f = ctx.createBiquadFilter(); this.f.type = 'lowpass'; this.f.Q.value = 2;
    this.g = ctx.createGain(); this.g.gain.value = 0;
    var g2 = ctx.createGain(); g2.gain.value = 0.35;
    this.o1.connect(this.f); this.o2.connect(g2); g2.connect(this.f); this.f.connect(this.g); this.g.connect(master);
    this.o1.start(); this.o2.start();
    // tyres
    this.n = ctx.createBufferSource(); this.n.buffer = noise; this.n.loop = true;
    this.nf = ctx.createBiquadFilter(); this.nf.type = 'bandpass'; this.nf.frequency.value = 1700; this.nf.Q.value = 3;
    this.ng = ctx.createGain(); this.ng.gain.value = 0;
    this.n.connect(this.nf); this.nf.connect(this.ng); this.ng.connect(master);
    this.n.start();
  }
  Engine.prototype.set = function (car, vol, on) {
    var t = ctx.currentTime, sp = Math.abs(car.s);
    // fake gearbox: rpm climbs in each gear, drops at the shift
    var gears = [0, 12, 22, 32, 42, 99], g = 1;
    while (g < gears.length - 1 && sp > gears[g]) g++;
    var lo = gears[g - 1], hi = Math.min(gears[g], 60);
    var rpm = 0.25 + 0.75 * Math.min(1, (sp - lo) / (hi - lo));
    var thr = (car.input & 4) || car.aiGas || car.drift ? 1 : 0.5;
    var hot = car.boost > 0 || car.nitro > 0;
    var f = 38 + rpm * 70 + g * 8 + (hot ? 10 : 0);
    this.o1.frequency.setTargetAtTime(f, t, 0.05);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.f.frequency.setTargetAtTime(500 + rpm * 1500 * thr + (hot ? 600 : 0), t, 0.05);
    this.g.gain.setTargetAtTime(on ? vol * (0.1 + 0.08 * thr) : 0, t, 0.08);
    var sq = on && sp > 6 && (car.drift || car.hand || car.slip > 0.22) ? Math.min(1, car.slip * 1.5 + (car.drift ? 0.3 : 0)) : 0;
    this.ng.gain.setTargetAtTime(sq * vol * 0.12, t, 0.05);
    this.nf.frequency.setTargetAtTime(1500 + sp * 10, t, 0.1);
  };

  function engine(i) {
    if (!ctx) return null;
    while (engines.length <= i) engines.push(new Engine());
    return engines[i];
  }

  function silence() { for (var i = 0; i < engines.length; i++) { engines[i].g.gain.setTargetAtTime(0, ctx.currentTime, 0.05); engines[i].ng.gain.setTargetAtTime(0, ctx.currentTime, 0.05); } }

  function beep(freq, dur, vol) {
    if (!ctx) return;
    var t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol || 0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }

  function burst(freq, dur, vol, type) {
    if (!ctx) return;
    var t = ctx.currentTime, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise; f.type = type || 'lowpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
  }

  return {
    init: init, resume: resume, engine: engine, silence: silence,
    beep: beep,
    hit: function (k) { burst(300, 0.25, Math.min(0.6, 0.1 + k * 0.03)); },
    boost: function () { burst(900, 0.6, 0.35, 'bandpass'); },
    state: function () { return ctx ? ctx.state : 'none'; }
  };
})();
