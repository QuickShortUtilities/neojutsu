/* ============================================================
   NEO術 — landing page: stat counters + demo player + visualizer
   Synth lives in chip.js.
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

  // ---------- demo pattern: 32 steps, A minor ----------
  const N = null;
  const A3 = 57, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69, B4 = 71, C5 = 72, D5 = 74, E5 = 76, G5 = 79;
  const pattern = {
    steps: 32, bpm: 150, chip: 'nes',
    p1: [A4, N, C5, N, E5, N, D5, C5, B4, N, G4, N, A4, N, N, N,
         A4, N, C5, N, E5, N, G5, E5, D5, N, C5, N, B4, N, N, N],
    p2: [E4, A4, C5, A4, E4, A4, C5, A4, D4, G4, B4, G4, D4, G4, B4, G4,
         F4, A4, C5, A4, F4, A4, C5, A4, E4, G4, B4, G4, E4, G4, B4, G4],
    tr: [A3-12, N, A3-12, N, A3, N, A3-12, N, G4-24, N, G4-24, N, G4-12, N, G4-24, N,
         F4-24, N, F4-24, N, F4-12, N, F4-24, N, E4-24, N, E4-24, N, E4-12, N, E4-24, N],
    no: ['k','h','h','h','s','h','h','h','k','h','k','h','s','h','h','h',
         'k','h','h','h','s','h','h','h','k','h','k','h','s','h','s','s'],
  };

  const engine = NeoChip.create();
  const seq = NeoChip.sequencer(engine, () => pattern);

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
  const start = () => { seq.start(); setPlayUI(true); };
  const stop = () => { seq.stop(); setPlayUI(false); };

  playBtn.addEventListener('click', () => (seq.playing ? stop() : start()));
  heroBtn.addEventListener('click', () => {
    document.getElementById('listen').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!seq.playing) start();
  });
  bpmInput.addEventListener('input', () => { pattern.bpm = +bpmInput.value; bpmVal.textContent = pattern.bpm; });
  document.querySelectorAll('.chip').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('active'); b.setAttribute('aria-checked', 'true');
      pattern.chip = b.dataset.chip;
    });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && seq.playing) stop(); });

  // ---------- visualizer ----------
  const cv = document.getElementById('viz'), cx = cv.getContext('2d');
  const W = cv.width, H = cv.height, STEPS = pattern.steps;
  const colors = { p1: '#ff2e88', p2: '#2ef2ff', tr: '#8b5cf6', no: '#ffd23f' };
  const rollH = H - 70, minMidi = 33, maxMidi = 84;
  const yFor = (m) => rollH - ((m - minMidi) / (maxMidi - minMidi)) * (rollH - 14) - 6;
  let wave = null;

  function draw() {
    requestAnimationFrame(draw);
    cx.fillStyle = '#050409'; cx.fillRect(0, 0, W, H);
    cx.strokeStyle = 'rgba(139,92,246,.12)'; cx.lineWidth = 1;
    for (let i = 0; i <= STEPS; i++) { const x = (i / STEPS) * W; cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, rollH); cx.stroke(); }

    const cellW = W / STEPS;
    const curStep = seq.playing ? ((seq.step - 1 + STEPS) % STEPS) : -1;
    if (curStep >= 0) { cx.fillStyle = 'rgba(255,255,255,.07)'; cx.fillRect(curStep * cellW, 0, cellW, rollH); }

    const drawCh = (ch) => {
      for (let i = 0; i < STEPS; i++) {
        const m = pattern[ch][i]; if (m == null) continue;
        const active = i === curStep;
        cx.fillStyle = colors[ch]; cx.globalAlpha = active ? 1 : .28;
        const w = ch === 'p2' ? cellW * .5 : cellW * .85;
        cx.fillRect(i * cellW + 1, yFor(m) - 3, w, 6);
        if (active) { cx.shadowColor = colors[ch]; cx.shadowBlur = 14; cx.fillRect(i * cellW + 1, yFor(m) - 3, w, 6); cx.shadowBlur = 0; }
      }
      cx.globalAlpha = 1;
    };
    drawCh('tr'); drawCh('p2'); drawCh('p1');
    for (let i = 0; i < STEPS; i++) {
      const k = pattern.no[i]; if (!k) continue;
      cx.fillStyle = colors.no; cx.globalAlpha = i === curStep ? 1 : .25;
      const h = k === 'k' ? 10 : k === 's' ? 7 : 3;
      cx.fillRect(i * cellW + 1, rollH - 2 - h, cellW * .85, h);
    }
    cx.globalAlpha = 1;

    const y0 = rollH + 10, hh = H - y0 - 6;
    cx.fillStyle = '#0a0812'; cx.fillRect(0, y0, W, hh);
    const an = engine.analyser;
    if (an) {
      wave ||= new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(wave);
      cx.strokeStyle = '#2ef2ff'; cx.lineWidth = 2; cx.shadowColor = '#2ef2ff'; cx.shadowBlur = 8;
      cx.beginPath();
      const n = wave.length, stepX = W / n;
      for (let i = 0; i < n; i++) {
        const v = (wave[i] - 128) / 128, y = y0 + hh / 2 + v * (hh / 2 - 2);
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
})();
