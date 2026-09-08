/* ============================================================
   NEO術 — shared four-voice chip synth (Web Audio)
   Used by the landing demo and the Studio.
   Emulates the character of four classic chips well enough to
   hear the difference. Not cycle-accurate. That's the model's job.
   ============================================================ */
(() => {
  'use strict';

  // duty: pulse duty cycle; fm: carrier/modulator; saw+cutoff: SID-ish filtered saw
  const CHIPS = {
    nes:     { label: 'NES · 2A03',          p1: { type: 'pulse', duty: .125, gain: .16 }, p2: { type: 'pulse', duty: .5, gain: .11 }, tr: { type: 'tri', gain: .30 }, noise: 'lofi' },
    gameboy: { label: 'Game Boy · LR35902',  p1: { type: 'pulse', duty: .25,  gain: .15 }, p2: { type: 'pulse', duty: .5, gain: .11 }, tr: { type: 'wave', gain: .22 }, noise: 'lofi' },
    genesis: { label: 'Genesis · YM2612',    p1: { type: 'fm', ratio: 2, index: 3.2, gain: .17 }, p2: { type: 'fm', ratio: 3, index: 1.6, gain: .11 }, tr: { type: 'fm', ratio: 1, index: .9, gain: .26 }, noise: 'hifi' },
    c64:     { label: 'C64 · SID',           p1: { type: 'saw', cutoff: 1400, gain: .14 }, p2: { type: 'pulse', duty: .3, gain: .10 }, tr: { type: 'tri', gain: .26 }, noise: 'lofi' },
  };

  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function create() {
    let ctx = null, master = null, analyser = null, noiseBuf = null;
    const waveCache = {};

    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.9;
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) { const x = (i / 127.5) - 1; curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6); }
      shaper.curve = curve;
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      master.connect(shaper).connect(analyser).connect(ctx.destination);
      const len = ctx.sampleRate;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }

    function pulseWave(duty) {
      const n = 32, real = new Float32Array(n), imag = new Float32Array(n);
      for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }
    const getPulse = (duty) => (waveCache[duty] ||= pulseWave(duty));

    function note(chipName, ch, midi, t, dur) {
      if (midi == null) return;
      const cfg = CHIPS[chipName][ch];
      const hz = midiToHz(midi);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(cfg.gain, t + 0.004);
      g.gain.setTargetAtTime(cfg.gain * 0.7, t + 0.03, 0.05);
      g.gain.setTargetAtTime(0, t + dur - 0.02, 0.012);
      g.connect(master);

      if (cfg.type === 'fm') {
        const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
        car.frequency.value = hz; mod.frequency.value = hz * cfg.ratio;
        mg.gain.setValueAtTime(hz * cfg.index, t);
        mg.gain.exponentialRampToValueAtTime(hz * cfg.index * 0.25, t + dur);
        mod.connect(mg).connect(car.frequency);
        car.connect(g);
        car.start(t); mod.start(t); car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
        return;
      }
      const osc = ctx.createOscillator();
      if (cfg.type === 'pulse') osc.setPeriodicWave(getPulse(cfg.duty));
      else if (cfg.type === 'tri' || cfg.type === 'wave') osc.type = 'triangle';
      else if (cfg.type === 'saw') osc.type = 'sawtooth';
      osc.frequency.value = hz;
      let node = osc;
      if (cfg.type === 'saw') {
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
        f.frequency.setValueAtTime(cfg.cutoff * 2.2, t);
        f.frequency.exponentialRampToValueAtTime(cfg.cutoff * 0.6, t + dur);
        osc.connect(f); node = f;
      }
      if (cfg.type === 'wave') {
        const q = ctx.createWaveShaper(); const c = new Float32Array(64);
        for (let i = 0; i < 64; i++) c[i] = Math.round(((i / 31.5) - 1) * 7) / 7;
        q.curve = c; osc.connect(q); node = q;
      }
      node.connect(g);
      osc.start(t); osc.stop(t + dur + 0.05);
    }

    function drum(chipName, kind, t) {
      if (!kind) return;
      const hi = CHIPS[chipName].noise === 'hifi';
      const src = ctx.createBufferSource(); src.buffer = noiseBuf;
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      if (kind === 'k') {
        const o = ctx.createOscillator(); const og = ctx.createGain();
        o.frequency.setValueAtTime(hi ? 160 : 120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
        og.gain.setValueAtTime(.5, t); og.gain.exponentialRampToValueAtTime(.001, t + 0.14);
        o.connect(og).connect(master); o.start(t); o.stop(t + 0.16);
        f.type = 'lowpass'; f.frequency.value = 800;
        g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.05);
      } else if (kind === 's') {
        f.type = hi ? 'bandpass' : 'highpass'; f.frequency.value = hi ? 1800 : 1200; f.Q.value = hi ? .8 : .3;
        g.gain.setValueAtTime(.32, t); g.gain.exponentialRampToValueAtTime(.001, t + (hi ? 0.16 : 0.11));
      } else {
        f.type = 'highpass'; f.frequency.value = 6000;
        g.gain.setValueAtTime(.12, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.035);
      }
      src.connect(f).connect(g).connect(master);
      src.start(t); src.stop(t + 0.3);
    }

    return {
      ensure, note, drum, midiToHz,
      get ctx() { return ctx; },
      get analyser() { return analyser; },
      get now() { return ctx ? ctx.currentTime : 0; },
    };
  }

  /* ---------- Sequencer: plays a pattern object through an engine ----------
     pattern = { steps, bpm, chip, p1:[], p2:[], tr:[], no:[] }
     melodic arrays hold MIDI numbers or null; no holds 'k'|'s'|'h'|null */
  function sequencer(engine, getPattern, onStep) {
    let playing = false, step = 0, nextTime = 0, timer = null;
    const lookahead = 0.12, interval = 25;
    function schedule() {
      const p = getPattern();
      const spb = 60 / p.bpm / 4;
      while (nextTime < engine.now + lookahead) {
        const i = step;
        engine.note(p.chip, 'p1', p.p1[i], nextTime, spb * 0.9);
        engine.note(p.chip, 'p2', p.p2[i], nextTime, spb * 0.55);
        engine.note(p.chip, 'tr', p.tr[i], nextTime, spb * 0.8);
        engine.drum(p.chip, p.no[i], nextTime);
        if (onStep) onStep(i, nextTime);
        nextTime += spb;
        step = (step + 1) % p.steps;
      }
    }
    return {
      start() { engine.ensure(); playing = true; step = 0; nextTime = engine.now + 0.05; timer = setInterval(schedule, interval); },
      stop() { playing = false; clearInterval(timer); },
      get playing() { return playing; },
      get step() { return step; },
      get nextTime() { return nextTime; },
    };
  }

  window.NeoChip = { CHIPS, create, sequencer, midiToHz };
})();
