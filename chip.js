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
    nes: {
      label: 'NES · 2A03',
      p1: { type: 'pulse', duty: .125, gain: .16 }, p2: { type: 'pulse', duty: .5, gain: .11 },
      p3: { type: 'pulse', duty: .25, gain: .10 },  p4: { type: 'pulse', duty: .5, gain: .09 },
      tr: { type: 'tri', gain: .30 }, noise: 'lofi',
    },
    gameboy: {
      label: 'Game Boy · LR35902',
      p1: { type: 'pulse', duty: .25, gain: .15 },  p2: { type: 'pulse', duty: .5, gain: .11 },
      p3: { type: 'pulse', duty: .125, gain: .10 }, p4: { type: 'wave', gain: .10 },
      tr: { type: 'wave', gain: .22 }, noise: 'lofi',
    },
    genesis: {
      label: 'Genesis · YM2612',
      p1: { type: 'fm', ratio: 2, index: 3.2, gain: .17 }, p2: { type: 'fm', ratio: 3, index: 1.6, gain: .11 },
      p3: { type: 'fm', ratio: 3.5, index: 2.2, gain: .10 }, p4: { type: 'fm', ratio: 1, index: .35, gain: .09 },
      tr: { type: 'fm', ratio: 1, index: .9, gain: .26 }, noise: 'hifi',
    },
    c64: {
      label: 'C64 · SID',
      p1: { type: 'saw', cutoff: 1400, gain: .14 }, p2: { type: 'pulse', duty: .3, gain: .10 },
      p3: { type: 'pulse', duty: .125, gain: .10 }, p4: { type: 'saw', cutoff: 900, gain: .08 },
      tr: { type: 'tri', gain: .26 }, noise: 'lofi',
    },
  };

  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Chip arpeggios: intervals cycled one per video frame (60 Hz), the classic trick
  // for faking chords on a one-note voice.
  const ARPS = { maj: [0, 4, 7], min: [0, 3, 7], oct: [0, 12], pow: [0, 7, 12], sus: [0, 5, 7], dim: [0, 3, 6], maj7: [0, 4, 7, 11] };
  const ARP_FRAME = 1 / 60;

  // Voices: four pulse-style melodic voices, a triangle bass, a noise channel.
  const VOICES = ['p1', 'p2', 'p3', 'p4', 'tr', 'no'];
  const MELODIC = ['p1', 'p2', 'p3', 'p4', 'tr'];
  // Instrument overrides a voice can use on any chip
  const INSTRUMENTS = {
    pulse12: { label: 'Pulse 12.5%',  type: 'pulse', duty: .125 },
    pulse25: { label: 'Pulse 25%',    type: 'pulse', duty: .25 },
    pulse50: { label: 'Square 50%',   type: 'pulse', duty: .5 },
    tri:     { label: 'Triangle',     type: 'tri' },
    wave:    { label: 'GB wave 4-bit', type: 'wave' },
    saw:     { label: 'SID saw',      type: 'saw', cutoff: 1400 },
    fmlead:  { label: 'FM lead',      type: 'fm', ratio: 2, index: 3.2 },
    fmbass:  { label: 'FM bass',      type: 'fm', ratio: 1, index: .9 },
    fmbell:  { label: 'FM bell',      type: 'fm', ratio: 3.5, index: 2.2 },
    fmorgan: { label: 'FM organ',     type: 'fm', ratio: 1, index: .35 },
  };
  const ENVS = { hold: 'Hold', pluck: 'Pluck', pad: 'Pad', stab: 'Stab' };
  // Percussion the era actually produced: noise-channel drums plus the pitched
  // clicks and blips chips used for toms, cowbell and sound effects.
  const DRUM_KIT = {
    k: { label: 'Kick' },   s: { label: 'Snare' }, h: { label: 'Hat' },
    H: { label: 'Open hat' }, t: { label: 'Tom lo' }, T: { label: 'Tom hi' },
    c: { label: 'Crash' },  r: { label: 'Rim' },   b: { label: 'Cowbell' },
    z: { label: 'Zap' },
  };
  const DRUM_KEYS = Object.keys(DRUM_KIT);
  const voiceCfg = (chip, ch) => CHIPS[chip][ch] || CHIPS[chip].p2;

  function create(context = null) {
    let ctx = null, master = null, analyser = null, noiseBuf = null, shaper = null;
    let delay = null, fbGain = null, wetGain = null;
    const waveCache = {};
    const channels = {};
    const sources = new Set();
    function trackSource(source) { sources.add(source); source.addEventListener('ended', () => { sources.delete(source); source.disconnect(); }); return source; }
    function silence() { for (const source of sources) { try { source.stop(); } catch {} } sources.clear(); }
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
      if (ctx) { if (!context && ctx.state === 'suspended') ctx.resume(); return ctx; }
      ctx = context || new (window.AudioContext || window.webkitAudioContext)();
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
      for (const ch of VOICES) {
        const gain = ctx.createGain(), pan = ctx.createStereoPanner(), meter = ctx.createAnalyser(), send = ctx.createGain();
        meter.fftSize = 256; send.gain.value = 0;
        gain.connect(pan).connect(meter).connect(master);
        pan.connect(send).connect(delay);
        channels[ch] = { gain, pan, meter, send };
      }
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

    function output(g, ch) { g.connect(channels[ch].gain); }
    function setMix(p, immediate = false) {
      if (!ctx) return;
      const solo = Object.values(p.mix || {}).some(m => m.solo);
      const set = (param, value) => immediate ? param.setValueAtTime(value, ctx.currentTime) : param.setTargetAtTime(value, ctx.currentTime, 0.008);
      for (const ch of Object.keys(channels)) {
        const mix = p.mix?.[ch] || {}, bus = channels[ch];
        set(bus.gain.gain, mix.mute || (solo && !mix.solo) ? 0 : (mix.volume ?? 1));
        set(bus.pan.pan, mix.pan || 0);
        set(bus.send.gain, p.fx?.[ch]?.echo || 0);
      }
      set(master.gain, 0.9 * (p.master?.volume ?? 1));
    }

    // fx: { vib: 0..1, echo: 0..1, duty: number|null, slide: bool }, prevMidi: for slide
    function note(chipName, ch, midi, t, dur, fx = {}, prevMidi = null) {
      if (midi == null || midi < 0) return;
      const base = voiceCfg(chipName, ch);
      const cfg = fx.inst && INSTRUMENTS[fx.inst] ? { ...base, ...INSTRUMENTS[fx.inst], gain: base.gain } : base;
      const hz = midiToHz(midi);
      const g = ctx.createGain();
      const peak = cfg.gain;
      // envelope shapes, all short like chip envelopes
      const env = fx.env || 'hold';
      g.gain.setValueAtTime(0, t);
      if (env === 'pad') { g.gain.linearRampToValueAtTime(peak, t + Math.min(0.12, dur * 0.4)); }
      else { g.gain.linearRampToValueAtTime(peak, t + 0.004); }
      if (env === 'pluck') { g.gain.setTargetAtTime(peak * 0.25, t + 0.02, 0.06); }
      else if (env === 'stab') { g.gain.setTargetAtTime(0, t + 0.05, 0.03); }
      else { g.gain.setTargetAtTime(peak * 0.7, t + 0.03, 0.05); }
      g.gain.setTargetAtTime(0, t + dur - 0.02, 0.012);
      // tremolo: volume LFO
      if (fx.trem > 0) {
        const lfo = trackSource(ctx.createOscillator()), depth = ctx.createGain();
        lfo.frequency.value = 6; depth.gain.value = peak * 0.5 * fx.trem;
        lfo.connect(depth).connect(g.gain); lfo.start(t); lfo.stop(t + dur + 0.05);
      }
      output(g, ch);

      const stopAt = t + dur + 0.05;
      const pitchTargets = [];
      let lfo = null;

      if (cfg.type === 'fm') {
        const car = trackSource(ctx.createOscillator()), mod = trackSource(ctx.createOscillator()), mg = ctx.createGain();
        car.frequency.value = hz; mod.frequency.value = hz * cfg.ratio;
        mg.gain.setValueAtTime(hz * cfg.index, t);
        mg.gain.exponentialRampToValueAtTime(hz * cfg.index * 0.25, t + Math.max(0.05, dur));
        mod.connect(mg).connect(car.frequency);
        car.connect(g);
        pitchTargets.push(car.frequency, mod.frequency);
        car.start(t); mod.start(t); car.stop(stopAt); mod.stop(stopAt);
      } else {
        const osc = trackSource(ctx.createOscillator());
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

      // arpeggio: step the pitch through the interval set every frame for the note's length
      const arp = fx.arp && ARPS[fx.arp];
      if (arp) {
        const frames = Math.floor(dur / ARP_FRAME);
        pitchTargets.forEach((p, i) => {
          const mult = i === 1 ? cfg.ratio : 1;
          for (let f = 0; f <= frames; f++) p.setValueAtTime(midiToHz(midi + arp[f % arp.length]) * mult, t + f * ARP_FRAME);
        });
      }
      // slide: glide in from the previous note (portamento), classic FM lead trick
      if (!arp && fx.slide && prevMidi != null && prevMidi >= 0 && prevMidi !== midi) {
        const from = midiToHz(prevMidi);
        pitchTargets.forEach((p, i) => {
          const mult = i === 1 ? cfg.ratio : 1;          // FM modulator follows the carrier
          p.setValueAtTime(from * mult, t);
          p.exponentialRampToValueAtTime(hz * mult, t + Math.min(0.08, dur * 0.5));
        });
      }
      // vibrato: delayed LFO, depth in cents
      if (fx.vib > 0) {
        lfo = trackSource(ctx.createOscillator()); lfo.frequency.value = 5.5 + fx.vib * 1.5;
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
      if (!kind || !DRUM_KIT[kind]) return;
      const hi = CHIPS[chipName].noise === 'hifi';
      const g = ctx.createGain(), f = ctx.createBiquadFilter();
      let noiseLen = 0.3, useNoise = true;

      // pitched element, used by kick, toms, cowbell and zap
      const tone = (from, to, dur, type, level) => {
        const o = trackSource(ctx.createOscillator()), og = ctx.createGain();
        o.type = type || 'sine';
        o.frequency.setValueAtTime(from, t);
        if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
        og.gain.setValueAtTime(level, t);
        og.gain.exponentialRampToValueAtTime(.001, t + dur);
        o.connect(og); output(og, 'no'); o.start(t); o.stop(t + dur + .02);
      };

      switch (kind) {
        case 'k':                                            // kick: pitch drop + click
          tone(hi ? 160 : 120, 40, .13, 'sine', .5);
          f.type = 'lowpass'; f.frequency.value = 800;
          g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.001, t + .05);
          break;
        case 's':                                            // snare: filtered noise
          f.type = hi ? 'bandpass' : 'highpass'; f.frequency.value = hi ? 1800 : 1200; f.Q.value = hi ? .8 : .3;
          g.gain.setValueAtTime(.32, t); g.gain.exponentialRampToValueAtTime(.001, t + (hi ? .16 : .11));
          break;
        case 'h':                                            // closed hat
          f.type = 'highpass'; f.frequency.value = 6000;
          g.gain.setValueAtTime(.12, t); g.gain.exponentialRampToValueAtTime(.001, t + .035);
          break;
        case 'H':                                            // open hat: same colour, long tail
          f.type = 'highpass'; f.frequency.value = 5200;
          g.gain.setValueAtTime(.13, t); g.gain.exponentialRampToValueAtTime(.001, t + .34);
          noiseLen = .45;
          break;
        case 't': case 'T': {                                // toms: pitched with a noise skin
          const base = kind === 't' ? 150 : 260;
          tone(base, base * .55, .22, 'triangle', .42);
          f.type = 'lowpass'; f.frequency.value = kind === 't' ? 900 : 1500;
          g.gain.setValueAtTime(.10, t); g.gain.exponentialRampToValueAtTime(.001, t + .07);
          break;
        }
        case 'c':                                            // crash: bright, long
          f.type = 'highpass'; f.frequency.value = 4000;
          g.gain.setValueAtTime(.20, t); g.gain.exponentialRampToValueAtTime(.001, t + .9);
          noiseLen = 1.1;
          break;
        case 'r':                                            // rim / click
          f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 6;
          g.gain.setValueAtTime(.28, t); g.gain.exponentialRampToValueAtTime(.001, t + .022);
          noiseLen = .05;
          break;
        case 'b':                                            // cowbell: two squares, the classic
          tone(540, 540, .28, 'square', .13);
          tone(800, 800, .28, 'square', .11);
          useNoise = false;
          break;
        case 'z':                                            // zap: laser sweep, the chip sound effect
          tone(1400, 180, .18, 'square', .16);
          useNoise = false;
          break;
      }

      if (useNoise) {
        const src = trackSource(ctx.createBufferSource()); src.buffer = noiseBuf;
        src.connect(f).connect(g); output(g, 'no');
        src.start(t); src.stop(t + noiseLen);
      }
    }

    return {
      ensure, note, drum, midiToHz, setCrush, setEcho, setMix, silence,
      channelAnalyser(ch) { return channels[ch]?.meter; },
      get ctx() { return ctx; },
      get analyser() { return analyser; },
      get now() { return ctx ? ctx.currentTime : 0; },
    };
  }

  /* ---------- helpers for tied notes ---------- */
  function noteLength(arr, i) {           // steps a note at i is held for (1 + following ties)
    let len = 1; while (i + len < arr.length && arr[i + len] === TIE) len++; return len;
  }
  function noteInRange(arr, i, bounds) {
    let v = arr[i];
    if (v === TIE && i === bounds.start) {
      let head = i; while (head >= 0 && arr[head] === TIE) head--;
      v = head >= 0 ? arr[head] : null;
    }
    return { v, len: Math.min(noteLength(arr, i), bounds.end - i) };
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
    const prev = {};
    function applyMaster(p) {
      engine.setMix(p);
      const m = p.master || {};
      engine.setCrush(m.crush || 0);
      engine.setEcho(echoSeconds(p.bpm, m.echoDiv || '8d'), m.echoFb == null ? 0.35 : m.echoFb);
    }
    function schedule() {
      const p = getPattern();
      applyMaster(p);
      const bounds = loopBounds(p);
      if (step < bounds.start || step >= bounds.end) step = bounds.start;
      const spb = 60 / p.bpm / 4;
      const fx = p.fx || {};
      while (nextTime < engine.now + lookahead) {
        const i = step;
        const t = nextTime + swingOffset(p, i, spb);
        for (const ch of MELODIC) {
          if (!p[ch]) continue;
          const { v, len } = noteInRange(p[ch], i, bounds);
          if (v == null || v === TIE) continue;
          const dur = len > 1 ? len * spb * 0.97 : spb * (ch === 'p2' ? 0.55 : ch === 'tr' ? 0.8 : 0.9);
          engine.note(p.chip, ch, v, t, dur, fx[ch] || {}, prev[ch]);
          prev[ch] = v;
        }
        engine.drum(p.chip, p.no[i], t, fx.no || {});
        if (onStep) onStep(i, t);
        nextTime += spb;
        step = step + 1 >= bounds.end ? bounds.start : step + 1;
      }
    }
    return {
      start() { if (playing) return; engine.ensure(); playing = true; step = loopBounds(getPattern()).start; nextTime = engine.now + 0.05; for (const ch of MELODIC) prev[ch] = null; timer = setInterval(schedule, interval); },
      stop() { playing = false; clearInterval(timer); engine.silence(); },
      get playing() { return playing; },
      get step() { return step; },
      get nextTime() { return nextTime; },
    };
  }

  function loopBounds(p) {
    const loop = p.loop;
    return loop?.enabled ? { start: (loop.start - 1) * 16, end: loop.end * 16 } : { start: 0, end: p.steps };
  }
  // swing: delay every off-beat 16th by up to half a step (0 = straight, 1 = hard shuffle)
  function swingOffset(p, step, spb) {
    const swing = p.master?.swing || 0;
    return step % 2 ? swing * spb * 0.5 : 0;
  }

  // Use the same synth and note timing for listening and offline audio exports.
  async function render(p, { selection = false, tail = true } = {}) {
    const bounds = selection ? loopBounds(p) : { start: 0, end: p.steps };
    const stepTime = 60 / p.bpm / 4, duration = (bounds.end - bounds.start) * stepTime;
    const echo = echoSeconds(p.bpm, p.master?.echoDiv || '8d');
    const feedback = Math.min(.8, p.master?.echoFb ?? .35);
    const hasEcho = Object.values(p.fx || {}).some(f => f.echo > 0);
    const release = tail ? Math.max(.35, hasEcho ? echo * Math.ceil(Math.log(.001) / Math.log(Math.max(.01, feedback))) : 0) : 0;
    const offline = new OfflineAudioContext(2, Math.ceil((duration + release) * 44100), 44100);
    const synth = create(offline); synth.ensure(); synth.setMix(p, true);
    synth.setCrush(p.master?.crush || 0); synth.setEcho(echo, feedback);
    const prev = {};
    for (let i = bounds.start; i < bounds.end; i++) {
      const t = (i - bounds.start) * stepTime + swingOffset(p, i, stepTime);
      for (const ch of MELODIC) {
        if (!p[ch]) continue;
        const { v, len } = noteInRange(p[ch], i, bounds); if (v == null || v === TIE) continue;
        const dur = len > 1 ? len * stepTime * .97 : stepTime * (ch === 'p2' ? .55 : ch === 'tr' ? .8 : .9);
        synth.note(p.chip, ch, v, t, dur, p.fx?.[ch] || {}, prev[ch]); prev[ch] = v;
      }
      synth.drum(p.chip, p.no[i], t, p.fx?.no || {});
    }
    return offline.startRendering();
  }

  window.NeoChip = { CHIPS, TIE, ARPS, VOICES, MELODIC, INSTRUMENTS, ENVS, DRUM_KIT, DRUM_KEYS, voiceCfg, create, sequencer, midiToHz, noteLength, echoSeconds, loopBounds, swingOffset, render };
})();
