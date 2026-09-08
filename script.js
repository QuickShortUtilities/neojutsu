/* ============================================================
   NEO術 — NeoJutsu
   Four-voice chip synth demo (Web Audio) + note visualizer.
   Emulates the character of four classic chips well enough to
   hear the difference. Not cycle-accurate. That's the model's job.
   ============================================================ */
(() => {
  'use strict';

  // ---------- stat counters ----------
  const counters = document.querySelectorAll('.stat-n[data-count]');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const el = e.target, target = +el.dataset.count, t0 = performance.now(), dur = 1100;
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur), eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      io.unobserve(el);
    });
  }, { threshold: 0.5 });
  counters.forEach((c) => io.observe(c));

  // ---------- sequence ----------
  // 32-step loop, A minor, classic stage-theme shape.
  // Notes are MIDI numbers; null = rest; 'x' in noise = hit.
  const N = null;
  const A3 = 57, C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69, B4 = 71, C5 = 72, D5 = 74, E5 = 76, G5 = 79;
  const seq = {
    p1: [ // lead
      A4, N, C5, N, E5, N, D5, C5, B4, N, G4, N, A4, N, N, N,
      A4, N, C5, N, E5, N, G5, E5, D5, N, C5, N, B4, N, N, N,
    ],
    p2: [ // harmony / arp
      E4, A4, C5, A4, E4, A4, C5, A4, D4, G4, B4, G4, D4, G4, B4, G4,
      F4, A4, C5, A4, F4, A4, C5, A4, E4, G4, B4, G4, E4, G4, B4, G4,
    ],
    tr: [ // bass (triangle, one octave lower)
      A3-12, N, A3-12, N, A3, N, A3-12, N, G4-24, N, G4-24, N, G4-12, N, G4-24, N,
      F4-24, N, F4-24, N, F4-12, N, F4-24, N, E4-24, N, E4-24, N, E4-12, N, E4-24, N,
    ],
    no: [ // drums: 'k' kick, 's' snare, 'h' hat
      'k','h','h','h','s','h','h','h','k','h','k','h','s','h','h','h',
      'k','h','h','h','s','h','h','h','k','h','k','h','s','h','s','s',
    ],
  };
  const STEPS = 32;

  // ---------- chip profiles ----------
  // duty: pulse duty cycle; fm: use FM carrier/modulator; sid: filtered saw
  const CHIPS = {
    nes:     { p1: { type: 'pulse', duty: .125, gain: .16 }, p2: { type: 'pulse', duty: .5, gain: .11 }, tr: { type: 'tri', gain: .30 }, noise: 'lofi' },
    gameboy: { p1: { type: 'pulse', duty: .25,  gain: .15 }, p2: { type: 'pulse', duty: .5, gain: .11 }, tr: { type: 'wave', gain: .22 }, noise: 'lofi' },
    genesis: { p1: { type: 'fm', ratio: 2, index: 3.2, gain: .17 }, p2: { type: 'fm', ratio: 3, index: 1.6, gain: .11 }, tr: { type: 'fm', ratio: 1, index: .9, gain: .26 }, noise: 'hifi' },
    c64:     { p1: { type: 'saw', cutoff: 1400, gain: .14 }, p2: { type: 'pulse', duty: .3, gain: .10 }, tr: { type: 'tri', gain: .26 }, noise: 'lofi' },
  };
  let chipName = 'nes';

  // ---------- audio ----------
  let ctx = null, master = null, analyser = null, noiseBuf = null;
  let playing = false, step = 0, nextTime = 0, timer = null, bpm = 150;
  const lookahead = 0.12, interval = 25;
  const lastHit = { p1: 0, p2: 0, tr: 0, no: 0 };
  const history = []; // for the piano roll

  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9;
    // gentle bit-crush feel via a soft waveshaper
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i / 127.5) - 1; curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6); }
    shaper.curve = curve;
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    master.connect(shaper).connect(analyser).connect(ctx.destination);
    // noise buffer
    const len = ctx.sampleRate * 1;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  function pulseWave(duty) {
    // Build a PeriodicWave for a pulse with the given duty cycle.
    const n = 32, real = new Float32Array(n), imag = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
      imag[k] = 0;
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }
  const waveCache = {};
  const getPulse = (duty) => (waveCache[duty] ||= pulseWave(duty));

  function voice(cfg, midi, t, dur) {
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
      mg.gain.exponentialRampToValueAtTime(hz * cfg.index * 0.25, t + dur); // FM decay = classic YM2612 pluck
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
      f.frequency.exponentialRampToValueAtTime(cfg.cutoff * 0.6, t + dur); // SID filter sweep
      osc.connect(f); node = f;
    }
    if (cfg.type === 'wave') {
      // Game Boy wave channel: crunchier triangle via 4-bit quantise
      const q = ctx.createWaveShaper(); const c = new Float32Array(64);
      for (let i = 0; i < 64; i++) c[i] = Math.round(((i / 31.5) - 1) * 7) / 7;
      q.curve = c; osc.connect(q); node = q;
    }
    node.connect(g);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  function drum(kind, t, mode) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf;
    const g = ctx.createGain(), f = ctx.createBiquadFilter();
    const hi = mode === 'hifi';
    if (kind === 'k') {
      // kick = short pitched drop + noise click
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

  function scheduleStep(i, t) {
    const chip = CHIPS[chipName];
    const spb = 60 / bpm / 4; // seconds per 16th
    const hit = (ch, midi, cfg, dur) => { if (midi == null) return; voice(cfg, midi, t, dur); lastHit[ch] = t; };
    hit('p1', seq.p1[i], chip.p1, spb * 0.9);
    hit('p2', seq.p2[i], chip.p2, spb * 0.55);
    hit('tr', seq.tr[i], chip.tr, spb * 0.8);
    if (seq.no[i]) { drum(seq.no[i], t, chip.noise); lastHit.no = t; }
    history.push({ i, t, p1: seq.p1[i], p2: seq.p2[i], tr: seq.tr[i], no: seq.no[i] });
    if (history.length > 64) history.shift();
  }

  function scheduler() {
    while (nextTime < ctx.currentTime + lookahead) {
      scheduleStep(step, nextTime);
      nextTime += 60 / bpm / 4;
      step = (step + 1) % STEPS;
    }
  }

  function start() {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    playing = true; step = 0; nextTime = ctx.currentTime + 0.05;
    timer = setInterval(scheduler, interval);
    setPlayUI(true);
  }
  function stop() {
    playing = false; clearInterval(timer);
    setPlayUI(false);
  }

  // ---------- UI ----------
  const playBtn = document.getElementById('play');
  const heroBtn = document.getElementById('hero-play');
  const playIcon = document.getElementById('play-icon');
  const playLabel = document.getElementById('play-label');
  const bpmInput = document.getElementById('bpm');
  const bpmVal = document.getElementById('bpm-val');

  function setPlayUI(on) {
    playBtn.setAttribute('aria-pressed', on);
    playIcon.textContent = on ? '■' : '▶';
    playLabel.textContent = on ? 'Stop' : 'Play';
  }
  playBtn.addEventListener('click', () => (playing ? stop() : start()));
  heroBtn.addEventListener('click', () => {
    document.getElementById('listen').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!playing) start();
  });
  bpmInput.addEventListener('input', () => { bpm = +bpmInput.value; bpmVal.textContent = bpm; });

  document.querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('active'); b.setAttribute('aria-checked', 'true');
      chipName = b.dataset.chip;
    });
  });

  // ---------- visualizer ----------
  const cv = document.getElementById('viz'), cx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const colors = { p1: '#ff2e88', p2: '#2ef2ff', tr: '#8b5cf6', no: '#ffd23f' };
  const rollH = H - 70, minMidi = 33, maxMidi = 84;
  const yFor = (m) => rollH - ((m - minMidi) / (maxMidi - minMidi)) * (rollH - 14) - 6;
  let freq = null;

  function draw() {
    requestAnimationFrame(draw);
    cx.fillStyle = '#050409'; cx.fillRect(0, 0, W, H);

    // grid
    cx.strokeStyle = 'rgba(139,92,246,.12)'; cx.lineWidth = 1;
    for (let i = 0; i <= STEPS; i++) { const x = (i / STEPS) * W; cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, rollH); cx.stroke(); }

    // piano roll (static pattern, lit when active)
    const now = ctx ? ctx.currentTime : 0;
    const cellW = W / STEPS;
    const curStep = playing ? ((step - 1 + STEPS) % STEPS) : -1;
    const drawCh = (ch) => {
      for (let i = 0; i < STEPS; i++) {
        const m = seq[ch][i]; if (m == null) continue;
        const active = playing && ((step - 1 - i + STEPS * 2) % STEPS) < 1 && Math.abs(i - ((step - 1 + STEPS) % STEPS)) < 1;
        cx.fillStyle = colors[ch];
        cx.globalAlpha = active ? 1 : .28;
        const w = ch === 'p2' ? cellW * .5 : cellW * .85;
        cx.fillRect(i * cellW + 1, yFor(m) - 3, w, 6);
        if (active) { cx.shadowColor = colors[ch]; cx.shadowBlur = 14; cx.fillRect(i * cellW + 1, yFor(m) - 3, w, 6); cx.shadowBlur = 0; }
      }
      cx.globalAlpha = 1;
    };
    drawCh('tr'); drawCh('p2'); drawCh('p1');
    // drum lane
    for (let i = 0; i < STEPS; i++) {
      const k = seq.no[i]; if (!k) continue;
      const active = playing && i === curStep;
      cx.fillStyle = colors.no; cx.globalAlpha = active ? 1 : .25;
      const h = k === 'k' ? 10 : k === 's' ? 7 : 3;
      cx.fillRect(i * cellW + 1, rollH - 12 - h + 10, cellW * .85, h);
    }
    cx.globalAlpha = 1;

    // playhead
    if (playing) {
      const x = ((curStep + ((now - (nextTime - 60 / bpm / 4)) / (60 / bpm / 4))) / STEPS) * W;
      cx.fillStyle = 'rgba(255,255,255,.08)'; cx.fillRect(curStep * cellW, 0, cellW, rollH);
    }

    // waveform strip
    const y0 = rollH + 10, hh = H - y0 - 6;
    cx.fillStyle = '#0a0812'; cx.fillRect(0, y0, W, hh);
    if (analyser) {
      freq ||= new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(freq);
      cx.strokeStyle = '#2ef2ff'; cx.lineWidth = 2; cx.shadowColor = '#2ef2ff'; cx.shadowBlur = 8;
      cx.beginPath();
      const n = freq.length, stepX = W / n;
      for (let i = 0; i < n; i++) {
        const v = (freq[i] - 128) / 128, y = y0 + hh / 2 + v * (hh / 2 - 2);
        i ? cx.lineTo(i * stepX, y) : cx.moveTo(0, y);
      }
      cx.stroke(); cx.shadowBlur = 0;
    } else {
      cx.strokeStyle = 'rgba(46,242,255,.35)'; cx.lineWidth = 2;
      cx.beginPath(); cx.moveTo(0, y0 + hh / 2); cx.lineTo(W, y0 + hh / 2); cx.stroke();
      cx.fillStyle = 'rgba(154,146,179,.8)'; cx.font = '12px "JetBrains Mono", monospace';
      cx.fillText('press play', 12, y0 + hh / 2 - 8);
    }
  }
  draw();

  // Stop audio when tab hidden to be polite.
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });
})();
