/* ============================================================
   NEO術 — master effects rack
   Eight units in one chain, each with real parameters, its own
   arcade screen, and optional motion (a tempo-synced LFO on any
   dial marked automatable).

   Chain: in → EQ → Comp → Phaser → Flanger → Crush → Reverb → Width → out
   Echo is a send bus owned by the synth and feeds the chain input.

   Every automatable parameter is a real AudioParam, so motion behaves
   identically in live playback and in the offline export render.
   ============================================================ */
(() => {
  'use strict';

  // P(label, min, max, default, unit, automatable, curve)
  // curve 'log' means the dial travels in octaves, which is how ears hear frequency.
  const P = (label, min, max, def, unit = '', auto = true, curve = 'lin') =>
    ({ label, min, max, def, unit, auto, curve });
  const F = (label, min, max, def) => P(label, min, max, def, 'Hz', true, 'log');

  const SPEC = {
    eq: {
      label: 'Equaliser', kanji: '音', theme: 'eq', screen: 'eq',
      blurb: 'Two shelves, two bells. Drag the numbered handles on the screen.',
      bands: [
        { n: 1, kind: 'lowshelf',  name: 'Low' },
        { n: 2, kind: 'peaking',   name: 'Low mid' },
        { n: 3, kind: 'peaking',   name: 'High mid' },
        { n: 4, kind: 'highshelf', name: 'High' },
      ],
      params: {
        f1: F('Low Hz', 30, 500, 110),      g1: P('Low dB', -18, 18, 0, 'dB'),   q1: P('Low Q', 0.3, 3, 0.7, '', false),
        f2: F('L·mid Hz', 80, 2000, 420),   g2: P('L·mid dB', -18, 18, 0, 'dB'), q2: P('L·mid Q', 0.2, 8, 1),
        f3: F('H·mid Hz', 500, 8000, 2400), g3: P('H·mid dB', -18, 18, 0, 'dB'), q3: P('H·mid Q', 0.2, 8, 1),
        f4: F('High Hz', 2000, 16000, 7000), g4: P('High dB', -18, 18, 0, 'dB'), q4: P('High Q', 0.3, 3, 0.7, '', false),
      },
    },
    comp: {
      label: 'Compressor', kanji: '圧', theme: 'comp', screen: 'comp',
      blurb: 'The curve is what it does to a level. The meter is what it is doing now.',
      params: {
        threshold: P('Threshold', -60, 0, -22, 'dB'),
        ratio:     P('Ratio', 1, 20, 4, ':1'),
        knee:      P('Knee', 0, 40, 12, 'dB'),
        attack:    P('Attack', 0, 200, 6, 'ms'),
        release:   P('Release', 20, 800, 180, 'ms'),
        makeup:    P('Makeup', 0, 12, 2, 'dB'),
      },
    },
    phaser: {
      label: 'Phaser', kanji: '相', theme: 'phaser', screen: 'phaser',
      blurb: 'Four sweeping notches. The sound of a warp tunnel.',
      params: {
        rate:     P('Rate', 0.05, 8, 0.5, 'Hz'),
        depth:    P('Depth', 0, 100, 60, '%'),
        centre:   F('Centre', 200, 3000, 900),
        feedback: P('Feedback', 0, 90, 40, '%'),
        mix:      P('Mix', 0, 100, 0, '%'),
      },
    },
    flanger: {
      label: 'Flanger', kanji: '翼', theme: 'flanger', screen: 'flanger',
      blurb: 'A jet sweep. A short delay chasing itself.',
      params: {
        rate:     P('Rate', 0.05, 5, 0.25, 'Hz'),
        depth:    P('Depth', 0, 100, 50, '%'),
        delay:    P('Delay', 0.5, 12, 4, 'ms'),
        feedback: P('Feedback', 0, 90, 45, '%'),
        mix:      P('Mix', 0, 100, 0, '%'),
      },
    },
    crush: {
      label: 'Bitcrush', kanji: '砕', theme: 'crush', screen: 'crush',
      blurb: 'Fewer bits, darker tone. The sound of running out of memory.',
      params: {
        bits: P('Bits', 2, 16, 16, '', false),
        tone: F('Tone', 800, 18000, 18000),
        mix:  P('Mix', 0, 100, 100, '%'),
      },
    },
    reverb: {
      label: 'Reverb', kanji: '響', theme: 'reverb', screen: 'reverb',
      blurb: 'The room around the chip. Bigger than any console ever had.',
      params: {
        size: P('Size', 0.2, 4, 1.6, 's', false),
        damp: F('Damping', 500, 12000, 4000),
        mix:  P('Mix', 0, 100, 0, '%'),
      },
    },
    echo: {
      label: 'Echo', kanji: '谺', theme: 'echo', screen: 'echo',
      blurb: 'Tempo-locked repeats, fed from each voice’s echo send.',
      params: {
        feedback: P('Feedback', 0, 80, 35, '%'),
        mix:      P('Mix', 0, 100, 60, '%'),
        tone:     F('Tone', 800, 12000, 3200),
      },
      divisions: { '16': '1/16', '8': '1/8', '8d': '1/8 dotted', '4': '1/4' },
    },
    width: {
      label: 'Stereo', kanji: '広', theme: 'width', screen: 'width',
      blurb: 'Mid/side width. Past 100% the sides outweigh the centre.',
      params: { width: P('Width', 0, 200, 100, '%') },
    },
  };

  const ORDER = ['eq', 'comp', 'phaser', 'flanger', 'crush', 'reverb', 'width', 'echo'];
  const CHAIN = ['eq', 'comp', 'phaser', 'flanger', 'crush', 'reverb', 'width'];
  const SHAPES = { sine: 'Sine', triangle: 'Tri', square: 'Square', sawtooth: 'Saw' };
  const RATES = { '0.25': '1/4 bar', '0.5': '1/2 bar', '1': '1 bar', '2': '2 bars', '4': '4 bars', '8': '8 bars' };

  function defaults() {
    const state = {};
    for (const id of ORDER) {
      const fx = { on: false, motion: {} };
      for (const [k, p] of Object.entries(SPEC[id].params)) fx[k] = p.def;
      if (SPEC[id].divisions) fx.div = '8d';
      state[id] = fx;
    }
    state.echo.on = true;                 // the per-voice echo sends already existed
    return state;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function normalize(state) {
    const out = defaults();
    if (!state || typeof state !== 'object') return out;
    for (const id of ORDER) {
      const src = state[id]; if (!src || typeof src !== 'object') continue;
      out[id].on = !!src.on;
      for (const [k, p] of Object.entries(SPEC[id].params)) {
        const v = Number(src[k]);
        out[id][k] = Number.isFinite(v) ? clamp(v, p.min, p.max) : p.def;
      }
      if (SPEC[id].divisions && SPEC[id].divisions[src.div]) out[id].div = src.div;
      const motion = src.motion && typeof src.motion === 'object' ? src.motion : {};
      for (const [k, m] of Object.entries(motion)) {
        const p = SPEC[id].params[k];
        if (!p || !p.auto || !m || typeof m !== 'object') continue;
        const depth = Number(m.depth), bars = Number(m.bars);
        out[id].motion[k] = {
          shape: SHAPES[m.shape] ? m.shape : 'sine',
          bars: RATES[String(bars)] ? bars : 1,
          depth: Number.isFinite(depth) ? clamp(depth, 0, 1) : 0.5,
        };
      }
    }
    // Racks saved with the old three-band EQ carry their settings across.
    const oldEq = state.eq;
    if (oldEq && oldEq.g1 === undefined && (oldEq.low !== undefined || oldEq.mid !== undefined || oldEq.high !== undefined)) {
      const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
      out.eq.g1 = clamp(num(oldEq.low, 0), -18, 18);
      out.eq.g2 = clamp(num(oldEq.mid, 0), -18, 18);
      out.eq.f2 = clamp(num(oldEq.midHz, 420), 80, 2000);
      out.eq.g4 = clamp(num(oldEq.high, 0), -18, 18);
      out.eq.motion = {};                  // old motion keys no longer exist
    }
    return out;
  }

  const dbToGain = (db) => Math.pow(10, db / 20);

  function impulse(ctx, seconds, dampHz) {
    const rate = ctx.sampleRate, len = Math.max(1, Math.floor(seconds * rate));
    const buf = ctx.createBuffer(2, len, rate);
    const k = Math.exp(-2 * Math.PI * dampHz / rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = white * (1 - k) + last * k;                 // one-pole lowpass = damping
        d[i] = last * Math.pow(1 - i / len, 2.6);          // decay
      }
    }
    return buf;
  }

  function create(ctx, opts = {}) {
    const meter = opts.meter !== false;                    // offline renders skip the analysers
    const input = ctx.createGain(), output = ctx.createGain();
    const nodes = {}, wet = {}, dry = {}, params = {}, motionNodes = {};
    let bpm = 150, state = defaults();

    const mixer = (id, make) => {
      const inNode = ctx.createGain(), outNode = ctx.createGain();
      const w = ctx.createGain(), d = ctx.createGain();
      make(inNode).connect(w); w.connect(outNode);
      inNode.connect(d); d.connect(outNode);
      wet[id] = w; dry[id] = d;
      nodes[id] = { in: inNode, out: outNode };
    };

    // ---- EQ: four biquads in series
    const eqBands = SPEC.eq.bands.map((b) => {
      const f = ctx.createBiquadFilter(); f.type = b.kind; return f;
    });
    eqBands.reduce((a, b) => (a.connect(b), b));
    nodes.eq = { in: eqBands[0], out: eqBands[3] };
    params.eq = {};
    SPEC.eq.bands.forEach((b, i) => {
      params.eq['f' + b.n] = eqBands[i].frequency;
      params.eq['g' + b.n] = eqBands[i].gain;
      params.eq['q' + b.n] = eqBands[i].Q;
    });

    // ---- Compressor
    const comp = ctx.createDynamicsCompressor(), makeup = ctx.createGain();
    comp.connect(makeup);
    nodes.comp = { in: comp, out: makeup };
    params.comp = { threshold: comp.threshold, ratio: comp.ratio, knee: comp.knee, attack: comp.attack, release: comp.release, makeup: makeup.gain };

    // ---- Phaser
    let phaserStages = [];
    mixer('phaser', (src) => {
      phaserStages = [0, 1, 2, 3].map(() => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.Q.value = 0.7; return f; });
      phaserStages.reduce((a, b) => (a.connect(b), b));
      src.connect(phaserStages[0]);
      const fb = ctx.createGain(); phaserStages[3].connect(fb); fb.connect(phaserStages[0]);
      const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
      lfo.type = 'sine'; lfo.connect(lfoGain);
      phaserStages.forEach((f) => lfoGain.connect(f.frequency));
      lfo.start();
      params.phaser = { rate: lfo.frequency, depth: lfoGain.gain, feedback: fb.gain, centre: phaserStages[0].frequency, mix: null };
      params.phaser._stages = phaserStages;
      return phaserStages[3];
    });

    // ---- Flanger
    mixer('flanger', (src) => {
      const dl = ctx.createDelay(0.05), fb = ctx.createGain();
      const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
      lfo.type = 'sine'; lfo.connect(lfoGain).connect(dl.delayTime); lfo.start();
      src.connect(dl); dl.connect(fb); fb.connect(dl);
      params.flanger = { rate: lfo.frequency, depth: lfoGain.gain, delay: dl.delayTime, feedback: fb.gain, mix: null };
      return dl;
    });

    // ---- Bitcrush
    const crushShaper = ctx.createWaveShaper();
    mixer('crush', (src) => {
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      src.connect(crushShaper).connect(tone);
      params.crush = { bits: null, tone: tone.frequency, mix: null };
      return tone;
    });

    // ---- Reverb
    const convolver = ctx.createConvolver();
    mixer('reverb', (src) => { src.connect(convolver); params.reverb = { size: null, damp: null, mix: null }; return convolver; });

    // ---- Stereo width (mid/side). L = M + S, R = M - S.
    {
      const inNode = ctx.createGain(), outNode = ctx.createGain();
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const midG = ctx.createGain(), sideG = ctx.createGain(), negR = ctx.createGain();
      const sideOut = ctx.createGain(), sideNeg = ctx.createGain();
      const sumL = ctx.createGain(), sumR = ctx.createGain();
      midG.gain.value = 0.5; sideG.gain.value = 0.5; negR.gain.value = -1;
      sideOut.gain.value = 1; sideNeg.gain.value = -1;
      inNode.connect(split);
      split.connect(midG, 0); split.connect(midG, 1);
      split.connect(sideG, 0); split.connect(negR, 1); negR.connect(sideG);
      sideG.connect(sideOut); sideG.connect(sideNeg);
      midG.connect(sumL); sideOut.connect(sumL);
      midG.connect(sumR); sideNeg.connect(sumR);
      sumL.connect(merge, 0, 0); sumR.connect(merge, 0, 1);
      merge.connect(outNode);
      nodes.width = { in: inNode, out: outNode };
      params.width = { width: sideOut.gain, _mirror: sideNeg.gain };
    }

    // ---- chain
    let cursor = input;
    for (const id of CHAIN) { cursor.connect(nodes[id].in); cursor = nodes[id].out; }
    cursor.connect(output);

    // ---- metering for the screens (live playback only)
    let spectrum = null, scopeL = null, scopeR = null;
    if (meter) {
      spectrum = ctx.createAnalyser(); spectrum.fftSize = 2048; spectrum.smoothingTimeConstant = 0.72;
      input.connect(spectrum);
      const sp = ctx.createChannelSplitter(2);
      scopeL = ctx.createAnalyser(); scopeR = ctx.createAnalyser();
      scopeL.fftSize = scopeR.fftSize = 512;
      output.connect(sp); sp.connect(scopeL, 0); sp.connect(scopeR, 1);
    }

    // ---- parameter application
    function setParam(id, key, value, immediate) {
      const p = params[id] && params[id][key];
      const now = ctx.currentTime, ramp = 0.02;
      const apply = (t, v) => { if (!t) return; immediate ? t.setValueAtTime(v, now) : t.setTargetAtTime(v, now, ramp); };
      const path = `${id}.${key}`;
      if (id === 'eq') { apply(p, value); return; }
      switch (path) {
        case 'comp.threshold': case 'comp.ratio': case 'comp.knee': apply(p, value); return;
        case 'comp.attack': case 'comp.release': apply(p, value / 1000); return;
        case 'comp.makeup': apply(p, dbToGain(value)); return;
        case 'phaser.rate': case 'flanger.rate': apply(p, value); return;
        case 'phaser.depth': apply(p, value / 100 * 1200); return;
        case 'phaser.centre': params.phaser._stages.forEach((f) => apply(f.frequency, value)); return;
        case 'phaser.feedback': case 'flanger.feedback': apply(p, value / 100 * 0.9); return;
        case 'flanger.depth': apply(p, value / 100 * 0.003); return;
        case 'flanger.delay': apply(p, value / 1000); return;
        case 'crush.tone': apply(p, value); return;
        case 'width.width': apply(p, value / 100); apply(params.width._mirror, -(value / 100)); return;
        default: return;
      }
    }

    function crushCurve(bits) {
      const n = 1024, c = new Float32Array(n), levels = Math.pow(2, bits);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = bits >= 16 ? x : Math.round(x * levels / 2) / (levels / 2);
      }
      return c;
    }
    let lastBits = null, lastRoom = null;

    // ---- motion
    function clearMotion(id, key) {
      const m = motionNodes[`${id}.${key}`]; if (!m) return;
      try { m.osc.stop(); } catch {}
      m.osc.disconnect(); m.gain.disconnect();
      delete motionNodes[`${id}.${key}`];
    }
    function scaleFor(id, key, span) {
      switch (`${id}.${key}`) {
        case 'comp.attack': case 'comp.release': return span / 1000;
        case 'comp.makeup': return dbToGain(span) - 1;
        case 'phaser.depth': return span / 100 * 1200;
        case 'phaser.feedback': case 'flanger.feedback': return span / 100 * 0.9;
        case 'flanger.depth': return span / 100 * 0.003;
        case 'flanger.delay': return span / 1000;
        case 'width.width': return span / 100;
        default: return span;
      }
    }
    function setMotion(id, key, cfg, startAt) {
      clearMotion(id, key);
      const spec = SPEC[id].params[key];
      const targets = (id === 'phaser' && key === 'centre') ? params.phaser._stages.map((f) => f.frequency)
        : [params[id] && params[id][key]];
      if (!cfg || !targets[0] || typeof targets[0].setValueAtTime !== 'function') return;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = cfg.shape;
      osc.frequency.value = 1 / (cfg.bars * (60 / bpm * 4));
      gain.gain.value = scaleFor(id, key, (spec.max - spec.min) / 2 * cfg.depth);
      osc.connect(gain);
      targets.forEach((t) => gain.connect(t));
      osc.start(startAt || 0);
      motionNodes[`${id}.${key}`] = { osc, gain };
    }

    function setState(next, opts2 = {}) {
      const immediate = !!opts2.immediate;
      if (opts2.bpm) bpm = opts2.bpm;
      state = normalize(next);
      const now = ctx.currentTime, ramp = 0.02;
      const set = (node, v) => { if (!node) return; immediate ? node.setValueAtTime(v, now) : node.setTargetAtTime(v, now, ramp); };

      for (const id of CHAIN) {
        const fx = state[id];
        for (const key of Object.keys(SPEC[id].params)) setParam(id, key, fx[key], immediate);
        if (wet[id]) {
          const mix = fx.on ? (fx.mix ?? 100) / 100 : 0;
          set(wet[id].gain, mix); set(dry[id].gain, 1 - mix);
        }
      }
      // units without a Mix dial bypass by going flat
      if (!state.eq.on) for (const b of SPEC.eq.bands) set(params.eq['g' + b.n], 0);
      if (!state.comp.on) { set(params.comp.threshold, 0); set(params.comp.ratio, 1); set(params.comp.knee, 0); set(params.comp.makeup, 1); }
      if (!state.width.on) { set(params.width.width, 1); set(params.width._mirror, -1); }

      const bits = state.crush.on ? state.crush.bits : 16;
      if (bits !== lastBits) { crushShaper.curve = crushCurve(bits); lastBits = bits; }
      const room = `${state.reverb.size}:${state.reverb.damp}`;
      if (state.reverb.on && room !== lastRoom) { convolver.buffer = impulse(ctx, state.reverb.size, state.reverb.damp); lastRoom = room; }

      for (const id of CHAIN) {
        for (const key of Object.keys(SPEC[id].params)) {
          const m = state[id].on ? state[id].motion[key] : null;
          const want = m ? `${m.shape}:${m.bars}:${m.depth}:${bpm}` : null;
          const live = motionNodes[`${id}.${key}`];
          if (!want) { clearMotion(id, key); continue; }
          if (!live || live.key !== want) {
            setMotion(id, key, m, opts2.startAt || 0);
            const n = motionNodes[`${id}.${key}`]; if (n) n.key = want;
          }
        }
      }
    }

    // ---- what the screens read
    const probe = {
      // combined magnitude of all four EQ bands, in dB
      eqResponse(freqs) {
        const mag = new Float32Array(freqs.length), phase = new Float32Array(freqs.length);
        const total = new Float32Array(freqs.length).fill(1);
        for (const f of eqBands) {
          f.getFrequencyResponse(freqs, mag, phase);
          for (let i = 0; i < freqs.length; i++) total[i] *= mag[i];
        }
        for (let i = 0; i < freqs.length; i++) total[i] = 20 * Math.log10(Math.max(1e-6, total[i]));
        return total;
      },
      spectrum(into) { if (!spectrum) return null; spectrum.getByteFrequencyData(into); return into; },
      get spectrumSize() { return spectrum ? spectrum.frequencyBinCount : 0; },
      get sampleRate() { return ctx.sampleRate; },
      // gain reduction in dB, negative when the compressor is working
      reduction() {
        const r = comp.reduction;
        return typeof r === 'number' ? r : (r && typeof r.value === 'number' ? r.value : 0);
      },
      stereo(l, r) { if (!scopeL) return false; scopeL.getByteTimeDomainData(l); scopeR.getByteTimeDomainData(r); return true; },
      get scopeSize() { return scopeL ? scopeL.fftSize : 0; },
    };

    return { input, output, setState, probe, get echo() { return state.echo; }, get state() { return state; } };
  }

  window.NeoRack = { SPEC, ORDER, CHAIN, SHAPES, RATES, defaults, normalize, create };
})();
