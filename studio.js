/* ============================================================
   NEO術 — Studio
   generate (型 kata engines) → pattern → editor → chip synth → MIDI
   Swap in the model API as another engine when NeoJutsu is trained.
   ============================================================ */
(() => {
  'use strict';

  // =============== state ===============
  const TIE = NeoChip.TIE;
  const LANES = ['p1', 'p2', 'tr', 'no'];
  const COLORS = { p1: '#ff2e88', p2: '#2ef2ff', tr: '#8b5cf6', no: '#ffd23f' };
  const MIN_MIDI = 36, MAX_MIDI = 84;          // C2..C6
  const DRUMS = ['k', 's', 'h'];
  const DRUM_LABEL = { k: 'kick', s: 'snare', h: 'hat' };
  const ENGINE_LABEL = { kataA: 'kata-A', kataB: 'kata-B' };

  const defaultFx = () => ({
    p1: { vib: 0, echo: 0, duty: null, slide: false },
    p2: { vib: 0, echo: 0, duty: null, slide: false },
    tr: { vib: 0, echo: 0, duty: null, slide: false },
    no: { echo: 0 },
  });
  const defaultMaster = () => ({ crush: 0, echoDiv: '8d', echoFb: 0.35 });
  // chip-appropriate starting FX, applied on generate
  const CHIP_FX = {
    nes:     { p1: { duty: 0.125 }, p2: { duty: 0.5 } },
    gameboy: { p1: { duty: 0.25 } },
    genesis: { p1: { vib: 0.4, slide: true, echo: 0.25 }, p2: { echo: 0.15 }, master: { echoDiv: '8d' } },
    c64:     { p1: { vib: 0.25, echo: 0.2 }, p2: { duty: 0.25 }, master: { crush: 0.1 } },
  };

  let pattern = normalize(blank(64, 150, 'nes'));
  let lane = 'p1';
  let seedUsed = '—', engineUsed = 'kataA';
  const undo = [];

  function blank(steps, bpm, chip) {
    return { steps, bpm, chip, p1: Array(steps).fill(null), p2: Array(steps).fill(null), tr: Array(steps).fill(null), no: Array(steps).fill(null) };
  }
  function normalize(p) {              // older saves / shared links may lack fx
    const d = defaultFx();
    p.fx = p.fx || {};
    for (const l of LANES) p.fx[l] = Object.assign(d[l], p.fx[l] || {});
    p.master = Object.assign(defaultMaster(), p.master || {});
    return p;
  }
  function snapshot() { undo.push(JSON.stringify(pattern)); if (undo.length > 50) undo.shift(); }
  function restore() { const s = undo.pop(); if (s) { pattern = normalize(JSON.parse(s)); syncUI(); } }

  // =============== music helpers ===============
  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], pent: [0, 3, 5, 7, 10],
  };
  const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const PROGS = {
    minor: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 5, 4], [0, 5, 3, 4]],
    major: [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 4], [0, 2, 3, 4]],
  };
  const MOODS = {
    stage: { density: .62, jump: 5, bassRate: 2, arp: true,  drums: 'drive',  oct: 0,  sustain: 0 },
    boss:  { density: .78, jump: 7, bassRate: 1, arp: true,  drums: 'heavy',  oct: 0,  sustain: 0 },
    title: { density: .45, jump: 4, bassRate: 4, arp: true,  drums: 'light',  oct: 0,  sustain: 1 },
    chill: { density: .40, jump: 3, bassRate: 4, arp: false, drums: 'light',  oct: 0,  sustain: 1 },
    dark:  { density: .35, jump: 6, bassRate: 2, arp: false, drums: 'sparse', oct: -1, sustain: 1 },
  };
  const KITS = {
    drive:  ['k','h','h','h','s','h','h','h','k','h','k','h','s','h','h','h'],
    heavy:  ['k','h','k','h','s','h','k','h','k','h','k','h','s','h','s','s'],
    light:  ['k',null,'h',null,'s',null,'h',null,'k',null,'h',null,'s',null,'h','h'],
    sparse: ['k',null,null,null,'s',null,null,null,'k',null,null,'k','s',null,null,null],
  };

  function rng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const fold = (m) => { while (m > MAX_MIDI) m -= 12; while (m < MIN_MIDI) m += 12; return m; };

  // fill ties after each note in a lane, up to `max` steps or until the next note
  function sustain(arr, max) {
    for (let s = 0; s < arr.length; s++) {
      if (arr[s] == null || arr[s] === TIE) continue;
      for (let k = 1; k < max && s + k < arr.length && arr[s + k] == null; k++) arr[s + k] = TIE;
    }
  }
  function drums(p, r, kit, steps) {
    for (let s = 0; s < steps; s++) {
      let d = kit[s % 16];
      if (s % 16 === 15 && r() < .5) d = 's';
      if (s >= steps - 4 && r() < .6) d = pick(r, ['s', 's', 'k']);
      p.no[s] = d;
    }
  }
  function setup(opts) {
    const r = rng(opts.engine + ':' + opts.seed);
    const steps = opts.bars * 16;
    const p = normalize(blank(steps, opts.bpm, opts.chip));
    const scale = SCALES[opts.scale];
    const root = 48 + KEYS.indexOf(opts.key);
    const mood = MOODS[opts.mood];
    const prog = pick(r, opts.scale === 'major' ? PROGS.major : PROGS.minor);
    const degToMidi = (deg, oct = 0) => fold(root + scale[((deg % scale.length) + scale.length) % scale.length] + 12 * (Math.floor(deg / scale.length) + oct));
    const cf = CHIP_FX[opts.chip] || {};
    for (const l of LANES) Object.assign(p.fx[l], cf[l] || {});
    Object.assign(p.master, cf.master || {});
    return { r, steps, p, scale, mood, prog, degToMidi };
  }

  // =============== 型 kata-A: motif & variation ===============
  function kataA(opts) {
    const { r, steps, p, mood, prog, degToMidi } = setup(opts);
    for (let s = 0; s < steps; s++) {                       // bass
      const chord = prog[Math.floor(s / 16) % prog.length];
      if (s % mood.bassRate === 0) p.tr[s] = degToMidi(chord, -1 + mood.oct) + ((s % 8 === 4 && r() < .6) ? 12 : 0);
    }
    const makeMotif = () => {
      const m = Array(16).fill(null); let deg = 7 + Math.floor(r() * 5);
      for (let s = 0; s < 16; s++) {
        if (r() < ((s % 4 === 0) ? mood.density + .25 : mood.density)) {
          deg = Math.max(4, Math.min(16, deg + Math.round((r() - .5) * 2 * mood.jump))); m[s] = deg;
        }
      }
      m[0] ??= deg; return m;
    };
    const A = makeMotif(), B = makeMotif();
    const vary = (m) => m.map((d) => (d != null && r() < .25) ? d + pick(r, [-2, -1, 1, 2]) : d);
    const form = [A, vary(A), B, vary(A), A, vary(B), B, vary(A)];
    for (let bar = 0; bar < opts.bars; bar++) {              // lead
      const chord = prog[bar % prog.length], m = form[bar % form.length];
      for (let s = 0; s < 16; s++) {
        if (m[s] == null) continue;
        let deg = m[s];
        if (s % 4 === 0) { const tones = [chord + 7, chord + 9, chord + 11]; deg = tones.reduce((a, b) => Math.abs(b - deg) < Math.abs(a - deg) ? b : a); }
        p.p1[bar * 16 + s] = degToMidi(deg, mood.oct);
      }
    }
    for (let s = 0; s < steps; s++) {                       // harmony
      const chord = prog[Math.floor(s / 16) % prog.length];
      if (mood.arp) { const cyc = [chord, chord + 2, chord + 4, chord + 2]; if (s % 2 === 0 || r() < .3) p.p2[s] = degToMidi(cyc[(s >> 1) % 4], mood.oct); }
      else if (s % 8 === 0 || (s % 8 === 6 && r() < .5)) p.p2[s] = degToMidi(chord + 2, mood.oct);
    }
    if (mood.sustain) { sustain(p.p1, 4); sustain(p.p2, mood.arp ? 1 : 8); sustain(p.tr, 2); }
    drums(p, r, KITS[mood.drums], steps);
    return p;
  }

  // =============== 型 kata-B: chords & sustain (FM-lead feel) ===============
  function kataB(opts) {
    const { r, steps, p, mood, prog, degToMidi } = setup(opts);
    for (let bar = 0; bar < opts.bars; bar++) {
      const chord = prog[bar % prog.length], b0 = bar * 16;
      // walking bass: root . fifth . octave . fifth, eighths
      const walk = [chord, chord + 4, chord + 7, chord + 4, chord, chord + 4, chord + 2, chord + 4];
      for (let e = 0; e < 8; e++) { if (mood.bassRate >= 4 && e % 2 === 1) continue; p.tr[b0 + e * 2] = degToMidi(walk[e], -1 + mood.oct); }
      // sustained lead: a chord tone held, then a short answer
      const tones = [chord + 7, chord + 9, chord + 11, chord + 14];
      let s = 0;
      while (s < 16) {
        const hold = pick(r, mood.sustain ? [4, 6, 8] : [2, 3, 4]);
        const tone = pick(r, tones) + (r() < .2 ? pick(r, [-1, 1]) : 0);
        p.p1[b0 + s] = degToMidi(tone, mood.oct);
        for (let k = 1; k < hold && s + k < 16; k++) p.p1[b0 + s + k] = TIE;
        s += hold;
        if (s < 16 && r() < mood.density) {
          const n = Math.min(16 - s, pick(r, [1, 2]));
          for (let k = 0; k < n; k++) p.p1[b0 + s + k] = degToMidi(tone + pick(r, [-2, -1, 1, 2]), mood.oct);
          s += n;
        }
      }
      // pads: third then fifth, each held half a bar in pulse 2
      p.p2[b0] = degToMidi(chord + 2, mood.oct); for (let k = 1; k < 8; k++) p.p2[b0 + k] = TIE;
      p.p2[b0 + 8] = degToMidi(chord + 4, mood.oct); for (let k = 9; k < 16; k++) p.p2[b0 + k] = TIE;
    }
    // ending: hold the last lead note to the end
    let last = -1; for (let i = steps - 1; i >= 0; i--) if (p.p1[i] != null && p.p1[i] !== TIE) { last = i; break; }
    for (let k = last + 1; k < steps; k++) p.p1[k] = TIE;
    // kata-B likes slide + vibrato on the lead whatever the chip
    Object.assign(p.fx.p1, { slide: true, vib: Math.max(p.fx.p1.vib, 0.3) });
    drums(p, r, KITS[mood.drums], steps);
    return p;
  }

  const ENGINES = { kataA, kataB };

  // =============== audio ===============
  const engine = NeoChip.create();
  const seq = NeoChip.sequencer(engine, () => pattern);

  // =============== DOM ===============
  const $ = (id) => document.getElementById(id);
  const gEngine = $('g-engine'), gChip = $('g-chip'), gMood = $('g-mood'), gKey = $('g-key'), gScale = $('g-scale'), gBars = $('g-bars'),
        gBpm = $('g-bpm'), gBpmVal = $('g-bpm-val'), gSeed = $('g-seed'), gDice = $('g-dice'), gMutate = $('g-mutate'), gGo = $('g-go');
  const playBtn = $('play'), playIcon = $('play-icon'), playLabel = $('play-label'), bpmIn = $('bpm'), bpmVal = $('bpm-val');
  const xTitle = $('x-title'), xChip = $('x-chip'), xLen = $('x-len'), xSeed = $('x-seed'), xEngine = $('x-engine'), xStatus = $('x-status');
  const engineBadge = $('engine-badge');

  const randomSeed = () => Math.random().toString(36).slice(2, 8);
  gDice.addEventListener('click', () => { gSeed.value = randomSeed(); });
  gBpm.addEventListener('input', () => { gBpmVal.textContent = gBpm.value; });
  gEngine.addEventListener('change', () => { engineBadge.textContent = `engine: 型 ${ENGINE_LABEL[gEngine.value]}`; });
  gMutate.addEventListener('click', () => {
    const cur = gSeed.value.trim() || randomSeed();
    const base = cur.replace(/~\d+$/, '');
    const m = cur.match(/~(\d+)$/); const n = m ? +m[1] + 1 : 1;
    gSeed.value = `${base}~${n}`; run();
  });

  function run() {
    snapshot();
    const seed = gSeed.value.trim() || randomSeed();
    gSeed.value = seed; seedUsed = seed; engineUsed = gEngine.value;
    pattern = ENGINES[engineUsed]({ seed, engine: engineUsed, chip: gChip.value, mood: gMood.value, key: gKey.value, scale: gScale.value, bars: +gBars.value, bpm: +gBpm.value });
    rememberSeed(seed); syncUI();
    if (!seq.playing) start();
    flash(`generated · ${ENGINE_LABEL[engineUsed]} · seed ${seed}`);
  }
  gGo.addEventListener('click', run);

  function setPlayUI(on) { playBtn.setAttribute('aria-pressed', on); playIcon.textContent = on ? '■' : '▶'; playLabel.textContent = on ? 'Stop' : 'Play'; }
  const start = () => { seq.start(); setPlayUI(true); };
  const stop = () => { seq.stop(); setPlayUI(false); };
  playBtn.addEventListener('click', () => (seq.playing ? stop() : start()));
  bpmIn.addEventListener('input', () => { pattern.bpm = +bpmIn.value; bpmVal.textContent = pattern.bpm; });
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); seq.playing ? stop() : start(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); restore(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && seq.playing) stop(); });

  document.querySelectorAll('.lane').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.lane').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
    b.classList.add('active'); b.setAttribute('aria-selected', 'true'); lane = b.dataset.lane; syncFx();
  }));
  $('t-clear').addEventListener('click', () => { snapshot(); pattern[lane].fill(null); });
  $('t-shift-up').addEventListener('click', () => shift(12));
  $('t-shift-dn').addEventListener('click', () => shift(-12));
  $('t-undo').addEventListener('click', restore);
  function shift(n) {
    if (lane === 'no') return; snapshot();
    pattern[lane] = pattern[lane].map((m) => (m == null || m === TIE) ? m : Math.max(MIN_MIDI, Math.min(MAX_MIDI, m + n)));
  }

  // ---- seed history
  const SEEDS_KEY = 'neojutsu.seeds';
  const loadSeeds = () => { try { return JSON.parse(localStorage.getItem(SEEDS_KEY) || '[]'); } catch { return []; } };
  function rememberSeed(seed) {
    const list = [seed, ...loadSeeds().filter((s) => s !== seed)].slice(0, 10);
    try { localStorage.setItem(SEEDS_KEY, JSON.stringify(list)); } catch {}
    renderSeeds();
  }
  function renderSeeds() {
    const el = $('seed-history'); el.innerHTML = '';
    loadSeeds().forEach((s) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'seed-chip' + (s === seedUsed ? ' current' : ''); b.textContent = s; b.title = 'regenerate with this seed';
      b.addEventListener('click', () => { gSeed.value = s; run(); });
      el.appendChild(b);
    });
  }

  // ---- fx panel
  const fxVib = $('fx-vib'), fxEcho = $('fx-echo'), fxDuty = $('fx-duty'), fxSlide = $('fx-slide');
  const fxCrush = $('fx-crush'), fxDiv = $('fx-echodiv'), fxFb = $('fx-echofb');
  const LANE_NAME = { p1: 'Pulse 1', p2: 'Pulse 2', tr: 'Triangle', no: 'Noise' };
  function syncFx() {
    const f = pattern.fx[lane], melodic = lane !== 'no';
    $('fx-lane-name').textContent = LANE_NAME[lane];
    fxVib.value = Math.round((f.vib || 0) * 100); $('fx-vib-v').textContent = fxVib.value;
    fxEcho.value = Math.round((f.echo || 0) * 100); $('fx-echo-v').textContent = fxEcho.value;
    fxDuty.value = f.duty ? String(f.duty) : ''; fxSlide.checked = !!f.slide;
    fxVib.closest('.fx-row').hidden = !melodic;
    $('fx-duty-row').hidden = !(melodic && NeoChip.CHIPS[pattern.chip][lane].type === 'pulse');
    $('fx-slide-row').hidden = !melodic;
    fxCrush.value = Math.round(pattern.master.crush * 100); $('fx-crush-v').textContent = fxCrush.value;
    fxDiv.value = pattern.master.echoDiv; fxFb.value = Math.round(pattern.master.echoFb * 100); $('fx-echofb-v').textContent = fxFb.value;
  }
  fxVib.addEventListener('input', () => { pattern.fx[lane].vib = fxVib.value / 100; $('fx-vib-v').textContent = fxVib.value; });
  fxEcho.addEventListener('input', () => { pattern.fx[lane].echo = fxEcho.value / 100; $('fx-echo-v').textContent = fxEcho.value; });
  fxDuty.addEventListener('change', () => { pattern.fx[lane].duty = fxDuty.value ? +fxDuty.value : null; });
  fxSlide.addEventListener('change', () => { pattern.fx[lane].slide = fxSlide.checked; });
  fxCrush.addEventListener('input', () => { pattern.master.crush = fxCrush.value / 100; $('fx-crush-v').textContent = fxCrush.value; });
  fxDiv.addEventListener('change', () => { pattern.master.echoDiv = fxDiv.value; });
  fxFb.addEventListener('input', () => { pattern.master.echoFb = fxFb.value / 100; $('fx-echofb-v').textContent = fxFb.value; });

  function syncUI() {
    bpmIn.value = pattern.bpm; bpmVal.textContent = pattern.bpm;
    xChip.textContent = NeoChip.CHIPS[pattern.chip].label;
    xLen.textContent = `${pattern.steps / 16} bars`;
    xSeed.textContent = seedUsed; xEngine.textContent = ENGINE_LABEL[engineUsed] || engineUsed;
    gChip.value = pattern.chip;
    syncFx(); renderSeeds();
  }
  gChip.addEventListener('change', () => { pattern.chip = gChip.value; syncUI(); });
  function flash(msg) { xStatus.textContent = msg; clearTimeout(flash.t); flash.t = setTimeout(() => (xStatus.textContent = ''), 3500); }

  // =============== piano roll editor ===============
  const roll = $('roll'), rc = roll.getContext('2d');
  const LABEL_W = 44;
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = roll.clientWidth; H = roll.clientHeight;
    roll.width = W * dpr; roll.height = H * dpr; rc.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize); resize();

  const rows = () => (lane === 'no' ? DRUMS.length : (MAX_MIDI - MIN_MIDI + 1));
  const rowH = () => H / rows();
  const cellW = () => (W - LABEL_W) / pattern.steps;
  const rowForMidi = (m) => MAX_MIDI - m;
  const midiForRow = (row) => MAX_MIDI - row;
  const valueForRow = (row) => (lane === 'no' ? DRUMS[row] : midiForRow(row));

  function cellAt(x, y) {
    const s = Math.floor((x - LABEL_W) / cellW()), row = Math.floor(y / rowH());
    if (s < 0 || s >= pattern.steps || row < 0 || row >= rows()) return null;
    return { s, row };
  }
  // index of the note that covers step s (itself or via ties), or -1
  function headOf(arr, s) { let i = s; while (i >= 0 && arr[i] === TIE) i--; return (i >= 0 && arr[i] != null) ? i : -1; }
  function eraseAt(arr, s) { const h = headOf(arr, s); if (h < 0) return; arr[h] = null; for (let i = h + 1; i < arr.length && arr[i] === TIE; i++) arr[i] = null; }

  let mode = null, anchor = null, moved = false;
  roll.addEventListener('contextmenu', (e) => e.preventDefault());
  roll.addEventListener('pointerdown', (e) => {
    const c = cellAt(e.offsetX, e.offsetY); if (!c) return;
    snapshot(); moved = false; anchor = c;
    const arr = pattern[lane], v = valueForRow(c.row);
    const erase = e.button === 2 || e.shiftKey;
    const head = lane === 'no' ? -1 : headOf(arr, c.s);
    const onNote = lane === 'no' ? arr[c.s] === v : (head >= 0 && arr[head] === v);
    if (erase) { mode = 'erase'; lane === 'no' ? (arr[c.s] = null) : eraseAt(arr, c.s); }
    else if (onNote && lane !== 'no') { mode = 'extend'; anchor = { s: head, row: c.row }; }
    else if (onNote) { mode = 'erase'; arr[c.s] = null; }
    else { mode = 'paint'; paint(c); audition(v); }
    roll.setPointerCapture(e.pointerId);
  });
  roll.addEventListener('pointermove', (e) => {
    if (!mode) return; const c = cellAt(e.offsetX, e.offsetY); if (!c) return;
    if (c.s !== anchor.s || c.row !== anchor.row) moved = true;
    const arr = pattern[lane];
    if (mode === 'paint') paint(c);
    else if (mode === 'erase') { lane === 'no' ? (arr[c.s] = null) : eraseAt(arr, c.s); }
    else if (mode === 'extend') {
      if (c.row !== anchor.row) { mode = 'paint'; paint(c); return; }
      // hold from the anchor note to c.s; release anything held beyond it
      for (let i = anchor.s + 1; i < arr.length; i++) {
        if (i <= c.s) { if (arr[i] != null && arr[i] !== TIE) break; arr[i] = TIE; }
        else if (arr[i] === TIE) arr[i] = null; else break;
      }
    }
  });
  roll.addEventListener('pointerup', () => {
    if (mode === 'extend' && !moved) eraseAt(pattern[lane], anchor.s);   // plain click on a note removes it
    mode = null;
  });
  function paint(c) {
    const arr = pattern[lane], v = valueForRow(c.row);
    if (lane !== 'no' && arr[c.s] === TIE) eraseAt(arr, c.s);
    arr[c.s] = v;
  }
  function audition(v) {
    if (seq.playing) return; engine.ensure();
    if (lane === 'no') engine.drum(pattern.chip, v, engine.now + 0.01, pattern.fx.no);
    else engine.note(pattern.chip, lane, v, engine.now + 0.01, 0.18, pattern.fx[lane]);
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  function drawRoll() {
    const rh = rowH(), cw = cellW(), n = rows();
    rc.fillStyle = '#050409'; rc.fillRect(0, 0, W, H);
    for (let row = 0; row < n; row++) {
      const y = row * rh;
      if (lane !== 'no') {
        const m = midiForRow(row), black = [1, 3, 6, 8, 10].includes(m % 12);
        rc.fillStyle = black ? 'rgba(255,255,255,.025)' : 'rgba(255,255,255,.05)';
        rc.fillRect(LABEL_W, y, W - LABEL_W, rh);
        if (m % 12 === 0) { rc.fillStyle = 'rgba(154,146,179,.9)'; rc.font = '10px "JetBrains Mono", monospace'; rc.fillText(noteName(m), 6, y + rh - 2); rc.fillStyle = 'rgba(139,92,246,.25)'; rc.fillRect(LABEL_W, y + rh - 1, W - LABEL_W, 1); }
      } else {
        rc.fillStyle = 'rgba(255,255,255,.04)'; rc.fillRect(LABEL_W, y, W - LABEL_W, rh);
        rc.fillStyle = 'rgba(154,146,179,.9)'; rc.font = '11px "JetBrains Mono", monospace'; rc.fillText(DRUM_LABEL[DRUMS[row]], 6, y + rh / 2 + 4);
      }
    }
    for (let s = 0; s <= pattern.steps; s++) {
      rc.fillStyle = s % 16 === 0 ? 'rgba(139,92,246,.45)' : s % 4 === 0 ? 'rgba(139,92,246,.2)' : 'rgba(139,92,246,.08)';
      rc.fillRect(LABEL_W + s * cw, 0, 1, H);
    }
    const cur = seq.playing ? ((seq.step - 1 + pattern.steps) % pattern.steps) : -1;
    if (cur >= 0) { rc.fillStyle = 'rgba(255,255,255,.07)'; rc.fillRect(LABEL_W + cur * cw, 0, cw, H); }

    const drawLane = (ln, bright) => {
      const arr = pattern[ln];
      for (let s = 0; s < pattern.steps; s++) {
        const v = arr[s]; if (v == null || v === TIE) continue;
        let row, len = 1;
        if (lane === 'no') { if (ln !== 'no') continue; row = DRUMS.indexOf(v); }
        else { if (ln === 'no') continue; row = rowForMidi(v); if (row < 0 || row >= n) continue; len = NeoChip.noteLength(arr, s); }
        const active = cur >= s && cur < s + len;
        const x = LABEL_W + s * cw + 1, y = row * rh + 1, w = cw * len - 2, h = Math.max(2, rh - 2);
        rc.fillStyle = COLORS[ln]; rc.globalAlpha = bright ? (active ? 1 : .85) : .22;
        if (bright && active) { rc.shadowColor = COLORS[ln]; rc.shadowBlur = 12; }
        rc.fillRect(x, y, w, h); rc.shadowBlur = 0;
        if (len > 1 && bright) { rc.fillStyle = 'rgba(0,0,0,.35)'; for (let k = 1; k < len; k++) rc.fillRect(LABEL_W + (s + k) * cw, y + 1, 1, h - 2); }
      }
      rc.globalAlpha = 1;
    };
    LANES.filter((l) => l !== lane).forEach((l) => drawLane(l, false));
    drawLane(lane, true);
  }

  // =============== scope ===============
  const scope = $('scope'), sc = scope.getContext('2d');
  let wave = null;
  function drawScope() {
    const w = scope.width, h = scope.height;
    sc.fillStyle = '#050409'; sc.fillRect(0, 0, w, h);
    const an = engine.analyser;
    if (!an) { sc.fillStyle = 'rgba(154,146,179,.6)'; sc.font = '12px "JetBrains Mono", monospace'; sc.fillText('oscilloscope', 12, 22); return; }
    wave ||= new Uint8Array(an.fftSize); an.getByteTimeDomainData(wave);
    sc.strokeStyle = '#2ef2ff'; sc.lineWidth = 2; sc.shadowColor = '#2ef2ff'; sc.shadowBlur = 8; sc.beginPath();
    for (let i = 0; i < wave.length; i++) { const y = h / 2 + ((wave[i] - 128) / 128) * (h / 2 - 3); i ? sc.lineTo(i * w / wave.length, y) : sc.moveTo(0, y); }
    sc.stroke(); sc.shadowBlur = 0;
  }
  (function loop() { requestAnimationFrame(loop); drawRoll(); drawScope(); })();

  // =============== MIDI export (SMF type 1) ===============
  const TPQ = 480, TICK16 = TPQ / 4;
  function vlq(n) { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; }
  const str = (s) => [...s].map((c) => c.charCodeAt(0) & 0x7f);
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  function track(events) {
    events.sort((a, b) => a.t - b.t);
    const out = []; let last = 0;
    for (const e of events) { out.push(...vlq(e.t - last), ...e.bytes); last = e.t; }
    out.push(...vlq(0), 0xff, 0x2f, 0x00);
    return [...str('MTrk'), ...u32(out.length), ...out];
  }
  function laneTrack(arr, ch, program, name, fx) {
    const ev = [{ t: 0, bytes: [0xff, 0x03, name.length, ...str(name)] }, { t: 0, bytes: [0xc0 | ch, program] }];
    if (fx.vib) ev.push({ t: 0, bytes: [0xb0 | ch, 1, Math.round(fx.vib * 127)] });            // CC1 mod wheel = vibrato
    if (fx.echo) ev.push({ t: 0, bytes: [0xb0 | ch, 91, Math.round(fx.echo * 127)] });         // CC91 effects depth = echo
    if (fx.slide) ev.push({ t: 0, bytes: [0xb0 | ch, 65, 127] }, { t: 0, bytes: [0xb0 | ch, 5, 20] }); // portamento on + time
    for (let s = 0; s < arr.length; s++) {
      const m = arr[s]; if (m == null || m === TIE) continue;
      const len = NeoChip.noteLength(arr, s);
      ev.push({ t: s * TICK16, bytes: [0x90 | ch, m, 100] });
      ev.push({ t: (s + len) * TICK16 - 2, bytes: [0x80 | ch, m, 0] });
    }
    return track(ev);
  }
  function drumTrack(arr) {
    const map = { k: 36, s: 38, h: 42 };
    const ev = [{ t: 0, bytes: [0xff, 0x03, 5, ...str('Noise')] }];
    for (let s = 0; s < arr.length; s++) {
      const d = arr[s]; if (!d) continue;
      ev.push({ t: s * TICK16, bytes: [0x99, map[d], d === 'h' ? 80 : 110] });
      ev.push({ t: s * TICK16 + TICK16 / 2, bytes: [0x89, map[d], 0] });
    }
    return track(ev);
  }
  function toMidi(p, title) {
    const mpq = Math.round(60000000 / p.bpm);
    const meta = track([
      { t: 0, bytes: [0xff, 0x03, title.length, ...str(title)] },
      { t: 0, bytes: [0xff, 0x51, 0x03, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255] },
      { t: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
    ]);
    const prog = { p1: 80, p2: 80, tr: 38 };
    if (p.chip === 'c64') prog.p1 = 81;
    if (p.chip === 'genesis') { prog.p1 = 87; prog.p2 = 88; prog.tr = 39; }
    const tracks = [meta, laneTrack(p.p1, 0, prog.p1, 'Pulse 1', p.fx.p1), laneTrack(p.p2, 1, prog.p2, 'Pulse 2', p.fx.p2), laneTrack(p.tr, 2, prog.tr, 'Triangle', p.fx.tr), drumTrack(p.no)];
    const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(TPQ)];
    return new Uint8Array([...header, ...tracks.flat()]);
  }
  $('x-midi').addEventListener('click', () => {
    const title = (xTitle.value.trim() || 'neojutsu-track').replace(/[^\w\- ]+/g, '');
    const blob = new Blob([toMidi(pattern, title)], { type: 'audio/midi' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${title}.mid`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('MIDI downloaded');
  });

  // =============== share link + saved ===============
  function encode(p) { return btoa(unescape(encodeURIComponent(JSON.stringify(p)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function decode(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); } catch { return null; } }
  $('x-link').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#p=${encode(pattern)}`;
    try { await navigator.clipboard.writeText(url); flash('link copied'); } catch { location.hash = `p=${encode(pattern)}`; flash('link in address bar'); }
  });

  const KEY = 'neojutsu.saved';
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const storeSaved = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} };
  function renderSaved() {
    const list = loadSaved(), el = $('saved-list'); el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<p class="side-note">Nothing saved yet.</p>'; return; }
    list.forEach((item, i) => {
      const row = document.createElement('div'); row.className = 'saved-item';
      row.innerHTML = `<span class="dot p1"></span><span class="name" title="load">${item.name}</span><button class="del" title="delete">×</button>`;
      row.querySelector('.name').addEventListener('click', () => { snapshot(); pattern = normalize(item.pattern); seedUsed = item.seed || '—'; engineUsed = item.engine || 'kataA'; xTitle.value = item.name; syncUI(); flash(`loaded ${item.name}`); });
      row.querySelector('.del').addEventListener('click', () => { list.splice(i, 1); storeSaved(list); renderSaved(); });
      el.appendChild(row);
    });
  }
  $('x-save').addEventListener('click', () => {
    const list = loadSaved(); const name = xTitle.value.trim() || `track-${list.length + 1}`;
    const idx = list.findIndex((x) => x.name === name);
    const item = { name, seed: seedUsed, engine: engineUsed, pattern: JSON.parse(JSON.stringify(pattern)), at: Date.now() };
    if (idx >= 0) list[idx] = item; else list.unshift(item);
    storeSaved(list.slice(0, 30)); renderSaved(); flash(`saved ${name}`);
  });

  // =============== boot ===============
  const shared = location.hash.startsWith('#p=') ? decode(location.hash.slice(3)) : null;
  if (shared && shared.steps && shared.p1) { pattern = normalize(shared); seedUsed = 'shared'; }
  else {
    gSeed.value = randomSeed(); seedUsed = gSeed.value;
    pattern = kataA({ seed: seedUsed, engine: 'kataA', chip: 'nes', mood: 'stage', key: 'A', scale: 'minor', bars: 4, bpm: 150 });
    rememberSeed(seedUsed);
  }
  renderSaved(); syncUI();
})();
