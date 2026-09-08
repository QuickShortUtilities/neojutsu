/* ============================================================
   NEO術 — master effects rack
   Eight effects in a fixed chain, each with dials and optional
   motion (a tempo-synced LFO on any dial marked automatable).

   Chain: in → EQ → Comp → Phaser → Flanger → Crush → Reverb → Width → out
   Echo is a send bus owned by the synth and feeds the chain input.

   Every parameter is an AudioParam, so motion behaves identically in
   live playback and in the offline render used for MP3/WAV export.
   ============================================================ */
(() => {
  'use strict';

  // p: [label, min, max, default, unit, automatable]
  const P = (label, min, max, def, unit = '', auto = true) => ({ label, min, max, def, unit, auto });

  const SPEC = {
    eq: {
      label: 'Equaliser', kanji: '音', theme: 'eq',
      blurb: 'Three bands. Shape the mix before anything else.',
      params: {
        low:  P('Low', -18, 18, 0, 'dB'),
        mid:  P('Mid', -18, 18, 0, 'dB'),
        high: P('High', -18, 18, 0, 'dB'),
        midHz: P('Mid freq', 300, 4000, 1200, 'Hz'),
      },
    },
    comp: {
      label: 'Compressor', kanji: '圧', theme: 'comp',
      blurb: 'Evens out the hits. Push the threshold down for pump.',
      params: {
        threshold: P('Threshold', -60, 0, -22, 'dB'),
        ratio:     P('Ratio', 1, 20, 4, ':1'),
        attack:    P('Attack', 0, 200, 6, 'ms'),
        release:   P('Release', 20, 800, 180, 'ms'),
        makeup:    P('Makeup', 0, 12, 2, 'dB'),
      },
    },
    phaser: {
      label: 'Phaser', kanji: '相', theme: 'phaser',
      blurb: 'Four sweeping notches. The sound of a warp tunnel.',
      params: {
        rate:     P('Rate', 0.05, 8, 0.5, 'Hz'),
        depth:    P('Depth', 0, 100, 60, '%'),
        centre:   P('Centre', 200, 3000, 900, 'Hz'),
        feedback: P('Feedback', 0, 90, 40, '%'),
        mix:      P('Mix', 0, 100, 0, '%'),
      },
    },
    flanger: {
      label: 'Flanger', kanji: '翼', theme: 'flanger',
      blurb: 'A jet sweep. Short delay chasing itself.',
      params: {
        rate:     P('Rate', 0.05, 5, 0.25, 'Hz'),
        depth:    P('Depth', 0, 100, 50, '%'),
        delay:    P('Delay', 0.5, 12, 4, 'ms'),
        feedback: P('Feedback', 0, 90, 45, '%'),
        mix:      P('Mix', 0, 100, 0, '%'),
      },
    },
    crush: {
      label: 'Bitcrush', kanji: '砕', theme: 'crush',
      blurb: 'Fewer bits, darker tone. The sound of running out of memory.',
      params: {
        bits: P('Bits', 2, 16, 16, '', false),
        tone: P('Tone', 800, 18000, 18000, 'Hz'),
        mix:  P('Mix', 0, 100, 100, '%'),
      },
    },
    reverb: {
      label: 'Reverb', kanji: '響', theme: 'reverb',
      blurb: 'The room around the chip. Bigger than any console had.',
      params: {
        size: P('Size', 0.2, 4, 1.6, 's', false),
        damp: P('Damping', 500, 12000, 4000, 'Hz', false),
        mix:  P('Mix', 0, 100, 0, '%'),
      },
    },
    echo: {
      label: 'Echo', kanji: '谺', theme: 'echo',
      blurb: 'Tempo-locked repeats. Fed from each voice’s echo send.',
      params: {
        feedback: P('Feedback', 0, 80, 35, '%'),
        mix:      P('Mix', 0, 100, 60, '%'),
        tone:     P('Tone', 800, 12000, 3200, 'Hz'),
      },
      // echo time is chosen as a note division, not a dial
      divisions: { '16': '1/16', '8': '1/8', '8d': '1/8 dotted', '4': '1/4' },
    },
    width: {
      label: 'Stereo', kanji: '広', theme: 'width',
      blurb: 'Mid/side width. Past 100% the sides get louder than the centre.',
      params: {
        width: P('Width', 0, 200, 100, '%'),
      },
    },
  };

  const ORDER = ['eq', 'comp', 'phaser', 'flanger', 'crush', 'reverb', 'width', 'echo'];
  const CHAIN = ['eq', 'comp', 'phaser', 'flanger', 'crush', 'reverb', 'width'];
  const SHAPES = { sine: 'Sine', triangle: 'Triangle', square: 'Square', sawtooth: 'Saw' };
  const RATES = { '0.25': '1/4 bar', '0.5': '1/2 bar', '1': '1 bar', '2': '2 bars', '4': '4 bars', '8': '8 bars' };

  // A fresh rack state: every effect off, every dial at its default.
  function defaults() {
    const state = {};
    for (const id of ORDER) {
      const fx = { on: false, motion: {} };
      for (const [k, p] of Object.entries(SPEC[id].params)) fx[k] = p.def;
      if (SPEC[id].divisions) fx.div = '8d';
      state[id] = fx;
    }
    state.echo.on = true;               // echo sends already existed, keep them audible
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
    return out;
  }

  const dbToGain = (db) => Math.pow(10, db / 20);

  // Noise burst with an exponential tail, one-pole damped. Cheap, convincing room.
  function impulse(ctx, seconds, dampHz) {
    const rate = ctx.sampleRate, len = Math.max(1, Math.floor(seconds * rate));
    const buf = ctx.createBuffer(2, len, rate);
    const k = Math.exp(-2 * Math.PI * dampHz / rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = white * (1 - k) + last * k;                     // one-pole lowpass = damping
        d[i] = last * Math.pow(1 - i / len, 2.6);              // decay
      }
    }
    return buf;
  }

  function create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain();
    const nodes = {}, wet = {}, dry = {}, params = {}, motionNodes = {};
    let bpm = 150, state = defaults();

    // ---- build each effect as a wet/dry pair so Mix works and bypass is clean
    const mixer = (id, make) => {
      const inNode = ctx.createGain(), outNode = ctx.createGain();
      const w = ctx.createGain(), d = ctx.createGain();
      const guts = make(inNode);
      guts.connect(w); w.connect(outNode);
      inNode.connect(d); d.connect(outNode);
      wet[id] = w; dry[id] = d;
      nodes[id] = { in: inNode, out: outNode };
      return nodes[id];
    };

    // EQ: low shelf, mid peak, high shelf. Always fully wet.
    const eqLow = ctx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 220;
    const eqMid = ctx.createBiquadFilter(); eqMid.type = 'peaking'; eqMid.Q.value = 0.9;
    const eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 5200;
    eqLow.connect(eqMid).connect(eqHigh);
    nodes.eq = { in: eqLow, out: eqHigh };
    params.eq = { low: eqLow.gain, mid: eqMid.gain, high: eqHigh.gain, midHz: eqMid.frequency };

    // Compressor + makeup
    const comp = ctx.createDynamicsCompressor(), makeup = ctx.createGain();
    comp.knee.value = 12; comp.connect(makeup);
    nodes.comp = { in: comp, out: makeup };
    params.comp = { threshold: comp.threshold, ratio: comp.ratio, attack: comp.attack, release: comp.release, makeup: makeup.gain };

    // Phaser: four all-pass stages swept by an LFO, with feedback
    mixer('phaser', (src) => {
      const stages = [0, 1, 2, 3].map(() => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.Q.value = 0.7; return f; });
      stages.reduce((a, b) => (a.connect(b), b));
      src.connect(stages[0]);
      const fb = ctx.createGain(); stages[3].connect(fb); fb.connect(stages[0]);
      const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
      lfo.type = 'sine'; lfo.connect(lfoGain);
      stages.forEach((f) => lfoGain.connect(f.frequency));
      lfo.start();
      params.phaser = {
        rate: lfo.frequency, depth: lfoGain.gain, feedback: fb.gain,
        centre: { setTargetAtTime: (v, t, c) => stages.forEach((f) => f.frequency.setTargetAtTime(v, t, c)), value: 900 },
        mix: null,
      };
      return stages[3];
    });

    // Flanger: short modulated delay with feedback
    mixer('flanger', (src) => {
      const dl = ctx.createDelay(0.05), fb = ctx.createGain();
      const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
      lfo.type = 'sine'; lfo.connect(lfoGain).connect(dl.delayTime); lfo.start();
      src.connect(dl); dl.connect(fb); fb.connect(dl);
      params.flanger = { rate: lfo.frequency, depth: lfoGain.gain, delay: dl.delayTime, feedback: fb.gain, mix: null };
      return dl;
    });

    // Bitcrush: quantising waveshaper plus a tone control
    const crushShaper = ctx.createWaveShaper();
    mixer('crush', (src) => {
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      src.connect(crushShaper).connect(tone);
      params.crush = { bits: null, tone: tone.frequency, mix: null };
      return tone;
    });

    // Reverb: generated impulse
    const convolver = ctx.createConvolver();
    mixer('reverb', (src) => { src.connect(convolver); params.reverb = { size: null, damp: null, mix: null }; return convolver; });

    // Stereo width: mid/side
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const midG = ctx.createGain(), sideG = ctx.createGain();
    const negR = ctx.createGain(); negR.gain.value = -1;
    const sumL = ctx.createGain(), sumR = ctx.createGain();
    {
      const inNode = ctx.createGain(), outNode = ctx.createGain();
      inNode.connect(split);
      split.connect(midG, 0); split.connect(midG, 1);              // mid = L + R
      split.connect(sideG, 0); split.connect(negR, 1); negR.connect(sideG);   // side = L - R
      midG.gain.value = 0.5; sideG.gain.value = 0.5;
      const sideOut = ctx.createGain(), sideNeg = ctx.createGain();
      sideOut.gain.value = 1; sideNeg.gain.value = -1;   // unity = stereo passes through untouched
      sideG.connect(sideOut); sideG.connect(sideNeg);
      midG.connect(sumL); sideOut.connect(sumL);                   // L = M + S
      midG.connect(sumR); sideNeg.connect(sumR);                   // R = M - S
      sumL.connect(merge, 0, 0); sumR.connect(merge, 0, 1);
      merge.connect(outNode);
      nodes.width = { in: inNode, out: outNode };
      params.width = { width: sideOut.gain };
      params.width._mirror = sideNeg.gain;                          // keep the negative side in step
    }

    // ---- wire the chain
    let cursor = input;
    for (const id of CHAIN) { cursor.connect(nodes[id].in); cursor = nodes[id].out; }
    cursor.connect(output);

    // ---- parameter application
    function setParam(id, key, value, immediate) {
      const p = params[id] && params[id][key];
      const now = ctx.currentTime, ramp = 0.02;
      const apply = (target, v) => immediate ? target.setValueAtTime(v, now) : target.setTargetAtTime(v, now, ramp);
      switch (`${id}.${key}`) {
        case 'eq.low': case 'eq.mid': case 'eq.high': apply(p, value); return;
        case 'eq.midHz': apply(p, value); return;
        case 'comp.threshold': apply(p, value); return;
        case 'comp.ratio': apply(p, value); return;
        case 'comp.attack': apply(p, value / 1000); return;
        case 'comp.release': apply(p, value / 1000); return;
        case 'comp.makeup': apply(p, dbToGain(value)); return;
        case 'phaser.rate': case 'flanger.rate': apply(p, value); return;
        case 'phaser.depth': apply(p, value / 100 * 1200); return;                 // Hz swing
        case 'phaser.centre': p.setTargetAtTime(value, now, ramp); p.value = value; return;
        case 'phaser.feedback': case 'flanger.feedback': apply(p, value / 100 * 0.9); return;
        case 'flanger.depth': apply(p, value / 100 * 0.003); return;
        case 'flanger.delay': apply(p, value / 1000); return;
        case 'crush.tone': apply(p, value); return;
        case 'width.width': {
          apply(p, value / 100);
          apply(params.width._mirror, -(value / 100));
          return;
        }
        default: return;                                                            // handled elsewhere
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

    // ---- motion: an LFO summed onto the parameter
    function clearMotion(id, key) {
      const m = motionNodes[`${id}.${key}`]; if (!m) return;
      try { m.osc.stop(); } catch {}
      m.osc.disconnect(); m.gain.disconnect();
      delete motionNodes[`${id}.${key}`];
    }
    function setMotion(id, key, cfg, startAt = 0) {
      clearMotion(id, key);
      const target = params[id] && params[id][key];
      if (!cfg || !target || typeof target.setValueAtTime !== 'function') return;
      const spec = SPEC[id].params[key];
      const secondsPerBar = 60 / bpm * 4;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = cfg.shape;
      osc.frequency.value = 1 / (cfg.bars * secondsPerBar);
      // depth is a fraction of half the dial's travel, in the unit the param expects
      const span = (spec.max - spec.min) / 2 * cfg.depth;
      gain.gain.value = scaleFor(id, key, span);
      osc.connect(gain).connect(target);
      osc.start(startAt);
      motionNodes[`${id}.${key}`] = { osc, gain };
    }
    // convert a dial-unit span into the unit the AudioParam actually uses
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

    function setState(next, opts = {}) {
      const immediate = !!opts.immediate;
      if (opts.bpm) bpm = opts.bpm;
      state = normalize(next);
      const now = ctx.currentTime, ramp = 0.02;
      const set = (node, v) => immediate ? node.setValueAtTime(v, now) : node.setTargetAtTime(v, now, ramp);

      for (const id of CHAIN) {
        const fx = state[id], on = fx.on;
        for (const key of Object.keys(SPEC[id].params)) setParam(id, key, fx[key], immediate);

        // wet/dry for the effects that have a Mix dial
        if (wet[id]) {
          const mix = on ? (fx.mix ?? 100) / 100 : 0;
          set(wet[id].gain, mix);
          set(dry[id].gain, 1 - mix);
        }
      }
      // EQ, comp and width have no mix: bypass by flattening them
      if (!state.eq.on) { for (const k of ['low', 'mid', 'high']) set(params.eq[k], 0); }
      if (!state.comp.on) { set(params.comp.threshold, 0); set(params.comp.ratio, 1); set(params.comp.makeup, 1); }
      if (!state.width.on) { set(params.width.width, 1); set(params.width._mirror, -1); }

      // crush curve and reverb impulse are rebuilt only when they change
      const bits = state.crush.on ? state.crush.bits : 16;
      if (bits !== lastBits) { crushShaper.curve = crushCurve(bits); lastBits = bits; }
      const room = `${state.reverb.size}:${state.reverb.damp}`;
      if (state.reverb.on && room !== lastRoom) { convolver.buffer = impulse(ctx, state.reverb.size, state.reverb.damp); lastRoom = room; }

      // motion
      for (const id of CHAIN) {
        for (const key of Object.keys(SPEC[id].params)) {
          const m = state[id].on ? state[id].motion[key] : null;
          const live = motionNodes[`${id}.${key}`];
          const want = m ? `${m.shape}:${m.bars}:${m.depth}:${bpm}` : null;
          if (!want) { clearMotion(id, key); continue; }
          if (!live || live.key !== want) { setMotion(id, key, m, opts.startAt || 0); const n = motionNodes[`${id}.${key}`]; if (n) n.key = want; }
        }
      }
    }

    return {
      input, output, setState,
      get echo() { return state.echo; },
      get state() { return state; },
    };
  }

  window.NeoRack = { SPEC, ORDER, CHAIN, SHAPES, RATES, defaults, normalize, create };
})();
