/* ============================================================
   NEO術 — shared four-voice chip synth (Web Audio)
   Used by the landing demo and the Studio.

   Voices:   p1, p2 (pulse / FM / saw), tr (triangle / wave / FM), no (noise)
   Per-lane FX (chip idiom): vibrato, pitch slide, duty override, echo send
   Master:   bit-crush, tempo-synced echo bus
   Ties:     a lane value of -1 means "hold the previous note this step"

   Emulates the character of four classic chips well enough to
   hear the difference. Not cycle-accurate. That's the model's job.
   ============================================================ */
(() => {
  'use strict';

  const TIE = -1;

  const CHIPS = {
    nes:     { label: 'NES · 2A03',          p1: { type: 'pulse', duty: .125, gain: .16 }, p2: { type: 'pulse', duty: .5, gain: .11 }, tr: { type: 'tri', gain: .30 }, noise: 'lofi' },
    gameboy: { label: 'Game Boy · LR35902',  p1: { type: 'pulse', duty: .25,  gain: .15 }, p2: { type: 'pulse', duty: .5, gain: .11 }, tr: { type: 'wave', gain: .22 }, noise: 'lofi' },
    genesis: { label: 'Genesis · YM2612',    p1: { type: 'fm', ratio: 2, index: 3.2, gain: .17 }, p2: { type: 'fm', ratio: 3, index: 1.6, gain: .11 }, tr: { type: 'fm', ratio: 1, index: .9, gain: .26 }, noise: 'hifi' },
    c64:     { label: 'C64 · SID',           p1: { type: 'saw', cutoff: 1400, gain: .14 }, p2: { type: 'pulse', duty: .3, gain: .10 }, tr: { type: 'tri', gain: .26 }, noise: 'lofi' },
  };

  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function create() {
    let ctx = null, master = null, analyser = null, noiseBuf = null, shaper = null;
    let delay = null, fbGain = null, wetGain = null;
    const waveCache = {};
    let crushBits = 16;

    function crushCurve(bits) {
      const n = 1024, c = new Float32Array(n), levels = Math.pow(2, bits);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        const soft = Math.tanh(x * 1.6) / Math.tanh(1.6);
        c[i] = bits >= 16 ? soft : Math.round(soft * levels / 2) / (levels / 2);
      }
      return c;
    }

    function ensure() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0.9;
      shaper = ctx.createWaveShaper(); shaper.curve = crushCurve(crushBits);
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
      master.connect(shaper).connect(analyser).connect(ctx.destination);
      // echo bus: send -> delay -> (feedback) -> wet -> master
      delay = ctx.createDelay(2.0); delay.delayTime.value = 0.2;
      fbGain = ctx.createGain(); fbGain.gain.value = 0.35;
      wetGain = ctx.createGain(); wetGain.gain.value = 0.6;
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 3200;
      delay.connect(tone).connect(fbGain).connect(delay);
      tone.connect(wetGain).connect(master);
      const len = ctx.sampleRate;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return ctx;
    }

    function setCrush(amount) {          // 0 = clean, 1 = 3-bit
      const bits = amount <= 0 ? 16 : Math.round(12 - amount * 9);
      if (bits === crushBits) return; crushBits = bits;
      if (shaper) shaper.curve = crushCurve(bits);
    }
    function setEcho(time, feedback) {
      if (!delay) return;
      delay.delayTime.setTargetAtTime(Math.min(1.9, time), ctx.currentTime, 0.02);
      fbGain.gain.setTargetAtTime(feedback, ctx.currentTime, 0.02);
    }

    function pulseWave(duty) {
      const n = 32, real = new Float32Array(n), imag = new Float32Array(n);
      for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }
    const getPulse = (duty) => (waveCache[duty] ||= pulseWave(duty));

    function output(g, echoAmt) {
      g.connect(master);
      if (echoAmt > 0) { const s = ctx.createGain(); s.gain.value = echoAmt; g.connect(s).connect(delay); }
    }

    // fx: { vib: 0..1, echo: 0..1, duty: number|null, slide: bool }, prevMidi: for slide
    function note(chipName, ch, midi, t, dur, fx = {}, prevMidi = null) {
      if (midi == null || midi < 0) return;
      const cfg = CHIPS[chipName][ch];
      const hz = midiToHz(midi);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(cfg.gain, t + 0.004);
      g.gain.setTargetAtTime(cfg.gain * 0.7, t + 0.03, 0.05);
      g.gain.setTargetAtTime(0, t + dur - 0.02, 0.012);
      output(g, fx.echo || 0);

      const stopAt = t + dur + 0.05;
      const pitchTargets = [];
      let lfo = null;

      if (cfg.type === 'fm') {
        const car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain();
        car.frequency.value = hz; mod.frequency.value = hz * cfg.ratio;
        mg.gain.setValueAtTime(hz * cfg.index, t);
        mg.gain.exponentialRampToValueAtTime(hz * cfg.index * 0.25, t + Math.max(0.05, dur));
        mod.connect(mg).connect(car.frequency);
        car.connect(g);
        pitchTargets.push(car.frequency, mod.frequency);
        car.start(t); mod.start(t); car.stop(stopAt); mod.stop(stopAt);
      } else {
        const osc = ctx.createOscillator();
        if (cfg.type === 'pulse') osc.setPeriodicWave(getPulse(fx.duty || cfg.duty));
        else if (cfg.type === 'tri' || cfg.type === 'wave') osc.type = 'triangle';
        else if (cfg.type === 'saw') osc.type = 'sawtooth';
        osc.frequency.value = hz;
        let node = osc;
        if (cfg.type === 'saw') {
          const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
          f.frequency.setValueAtTime(cfg.cutoff * 2.2, t);
          f.frequency.exponentialRampToValueAtTime(cfg.cutoff * 0.6, t + Math.max(0.05, dur));
          osc.connect(f); node = f;
        }
        if (cfg.type === 'wave') {
          const q = ctx.createWaveShaper(); const c = new Float32Array(64);
          for (let i = 0; i < 64; i++) c[i] = Math.round(((i / 31.5) - 1) * 7) / 7;
          q.curve = c; osc.connect(q); node = q;
        }
        node.connect(g);
        pitchTargets.push(osc.frequency);
        osc.start(t); osc.stop(stopAt);
      }

      // slide: glide in from the previous note (portamento), classic FM lead trick
      if (fx.slide && prevMidi != null && prevMidi >= 0 && prevMidi !== midi) {
        const from = midiToHz(prevMidi);
        pitchTargets.forEach((p, i) => {
          const mult = i === 1 ? cfg.ratio : 1;          // FM modulator follows the carrier
          p.setValueAtTime(from * mult, t);
          p.exponentialRampToValueAtTime(hz * mult, t + Math.min(0.08, dur * 0.5));
        });
      }
      // vibrato: delayed LFO, depth in cents
      if (fx.vib > 0) {
        lfo = ctx.createOscillator(); lfo.frequency.value = 5.5 + fx.vib * 1.5;
        const depth = ctx.createGain();
        const cents = 8 + fx.vib * 40;
        const amp = hz * (Math.pow(2, cents / 1200) - 1);
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(amp, t + 0.12);
        lfo.connect(depth);
        pitchTargets.forEach((p, i) => { if (i === 0) depth.connect(p); });
        lfo.start(t); lfo.stop(stopAt);
      }
    }

    function drum(chipName, kind, t, fx = {}) {
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
      src.connect(f).connect(g); output(g, kind === 's' ? (fx.echo || 0) : 0);
      src.start(t); src.stop(t + 0.3);
    }

    return {
      ensure, note, drum, midiToHz, setCrush, setEcho,
      get ctx() { return ctx; },
      get analyser() { return analyser; },
      get now() { return ctx ? ctx.currentTime : 0; },
    };
  }

  /* ---------- helpers for tied notes ---------- */
  function noteLength(arr, i) {           // steps a note at i is held for (1 + following ties)
    let len = 1; while (i + len < arr.length && arr[i + len] === TIE) len++; return len;
  }
  function echoSeconds(bpm, div) {        // tempo-synced echo time
    const beat = 60 / bpm;
    return { '8': beat / 2, '8d': beat * 0.75, '16': beat / 4, '4': beat }[div] || beat * 0.75;
  }

  /* ---------- Sequencer ----------
     pattern = { steps, bpm, chip, p1:[], p2:[], tr:[], no:[], fx?:{p1,p2,tr,no}, master?:{crush, echoDiv, echoFb} }
     melodic arrays hold MIDI numbers, TIE (-1) or null; no holds 'k'|'s'|'h'|null */
  function sequencer(engine, getPattern, onStep) {
    let playing = false, step = 0, nextTime = 0, timer = null;
    const lookahead = 0.12, interval = 25;
    const prev = { p1: null, p2: null, tr: null };
    function applyMaster(p) {
      const m = p.master || {};
      engine.setCrush(m.crush || 0);
      engine.setEcho(echoSeconds(p.bpm, m.echoDiv || '8d'), m.echoFb == null ? 0.35 : m.echoFb);
    }
    function schedule() {
      const p = getPattern();
      applyMaster(p);
      const spb = 60 / p.bpm / 4;
      const fx = p.fx || {};
      while (nextTime < engine.now + lookahead) {
        const i = step;
        for (const ch of ['p1', 'p2', 'tr']) {
          const v = p[ch][i];
          if (v == null || v === TIE) continue;
          const len = noteLength(p[ch], i);
          const dur = len > 1 ? len * spb * 0.97 : spb * (ch === 'p2' ? 0.55 : ch === 'tr' ? 0.8 : 0.9);
          engine.note(p.chip, ch, v, nextTime, dur, fx[ch] || {}, prev[ch]);
          prev[ch] = v;
        }
        engine.drum(p.chip, p.no[i], nextTime, fx.no || {});
        if (onStep) onStep(i, nextTime);
        nextTime += spb;
        step = (step + 1) % p.steps;
      }
    }
    return {
      start() { engine.ensure(); playing = true; step = 0; nextTime = engine.now + 0.05; prev.p1 = prev.p2 = prev.tr = null; timer = setInterval(schedule, interval); },
      stop() { playing = false; clearInterval(timer); },
      get playing() { return playing; },
      get step() { return step; },
      get nextTime() { return nextTime; },
    };
  }

  window.NeoChip = { CHIPS, TIE, create, sequencer, midiToHz, noteLength, echoSeconds };
})();
