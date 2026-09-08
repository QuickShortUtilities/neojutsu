/* ============================================================
   NEO術 — Studio
   generate (procedural v0) → pattern → editor → chip synth → MIDI
   Swap generate() for the model API when NeoJutsu is trained.
   ============================================================ */
(() => {
  'use strict';

  // =============== state ===============
  const LANES = ['p1', 'p2', 'tr', 'no'];
  const COLORS = { p1: '#ff2e88', p2: '#2ef2ff', tr: '#8b5cf6', no: '#ffd23f' };
  const MIN_MIDI = 36, MAX_MIDI = 84;          // C2..C6
  const DRUMS = ['k', 's', 'h'];               // rows in the noise lane
  const DRUM_LABEL = { k: 'kick', s: 'snare', h: 'hat' };

  let pattern = blank(64, 150, 'nes');
  let lane = 'p1';
  let seedUsed = '—';
  const undo = [];

  function blank(steps, bpm, chip) {
    return { steps, bpm, chip, p1: Array(steps).fill(null), p2: Array(steps).fill(null), tr: Array(steps).fill(null), no: Array(steps).fill(null) };
  }
  function snapshot() { undo.push(JSON.stringify(pattern)); if (undo.length > 50) undo.shift(); }
  function restore() { const s = undo.pop(); if (s) { pattern = JSON.parse(s); syncUI(); } }

  // =============== procedural engine v0 ===============
  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], pent: [0, 3, 5, 7, 10],
  };
  const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // chord progressions as scale-degree indices (0-based) per bar
  const PROGS = {
    minor: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 5, 4], [0, 5, 3, 4]],
    major: [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 4], [0, 2, 3, 4]],
  };
  const MOODS = {
    stage: { density: .62, jump: 5, bassRate: 2, arp: true,  drums: 'drive', oct: 0 },
    boss:  { density: .78, jump: 7, bassRate: 1, arp: true,  drums: 'heavy', oct: 0 },
    title: { density: .45, jump: 4, bassRate: 4, arp: true,  drums: 'light', oct: 0 },
    chill: { density: .40, jump: 3, bassRate: 4, arp: false, drums: 'light', oct: 0 },
    dark:  { density: .35, jump: 6, bassRate: 2, arp: false, drums: 'sparse', oct: -1 },
  };

  function rng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

  function generate(opts) {
    const r = rng(opts.seed);
    const steps = opts.bars * 16;
    const p = blank(steps, opts.bpm, opts.chip);
    const scale = SCALES[opts.scale];
    const root = 48 + KEYS.indexOf(opts.key);           // C3-based root
    const mood = MOODS[opts.mood];
    const progFamily = (opts.scale === 'major') ? PROGS.major : PROGS.minor;
    const prog = pick(r, progFamily);
    const fold = (m) => { while (m > MAX_MIDI) m -= 12; while (m < MIN_MIDI) m += 12; return m; };   // keep inside the editor's range
    const degToMidi = (deg, oct = 0) => fold(root + scale[((deg % scale.length) + scale.length) % scale.length] + 12 * (Math.floor(deg / scale.length) + oct));

    // ---- bass (triangle): chord roots, octave bounce
    for (let s = 0; s < steps; s++) {
      const bar = Math.floor(s / 16), chord = prog[bar % prog.length];
      const rate = mood.bassRate;
      if (s % rate === 0) {
        const bounce = (s % 8 === 4 && r() < .6) ? 12 : 0;
        p.tr[s] = degToMidi(chord, -1 + mood.oct) + bounce;
      }
    }

    // ---- lead (pulse 1): motif A, repeat with variation: A A' B A''
    const motifLen = 16;
    const makeMotif = () => {
      const m = Array(motifLen).fill(null);
      let deg = 7 + Math.floor(r() * 5);                 // start around the octave
      for (let s = 0; s < motifLen; s++) {
        const onBeat = s % 4 === 0;
        if (r() < (onBeat ? mood.density + .25 : mood.density)) {
          const move = Math.round((r() - .5) * 2 * mood.jump);
          deg = Math.max(4, Math.min(16, deg + move));
          m[s] = deg;
        }
      }
      m[0] ??= deg;
      return m;
    };
    const A = makeMotif(), B = makeMotif();
    const vary = (m) => m.map((d, i) => (d != null && r() < .25) ? d + pick(r, [-2, -1, 1, 2]) : d);
    const form = [A, vary(A), B, vary(A), A, vary(B), B, vary(A)];
    for (let bar = 0; bar < opts.bars; bar++) {
      const chord = prog[bar % prog.length], m = form[bar % form.length];
      for (let s = 0; s < motifLen; s++) {
        if (m[s] == null) continue;
        // pull strong beats toward chord tones
        let deg = m[s];
        if (s % 4 === 0) { const tones = [chord, chord + 2, chord + 4]; deg = tones.reduce((a, b) => Math.abs(b + 7 - deg) < Math.abs(a + 7 - deg) ? b + 7 : a, tones[0] + 7); }
        p.p1[bar * 16 + s] = degToMidi(deg, mood.oct);
      }
    }

    // ---- harmony (pulse 2): arpeggio or sustained thirds
    for (let s = 0; s < steps; s++) {
      const bar = Math.floor(s / 16), chord = prog[bar % prog.length];
      if (mood.arp) {
        const cyc = [chord, chord + 2, chord + 4, chord + 2];
        if (s % 2 === 0 || r() < .3) p.p2[s] = degToMidi(cyc[(s >> 1) % 4], mood.oct);
      } else if (s % 8 === 0 || (s % 8 === 6 && r() < .5)) {
        p.p2[s] = degToMidi(chord + 2, mood.oct);
      }
    }

    // ---- drums (noise)
    const kits = {
      drive:  ['k','h','h','h','s','h','h','h','k','h','k','h','s','h','h','h'],
      heavy:  ['k','h','k','h','s','h','k','h','k','h','k','h','s','h','s','s'],
      light:  ['k',null,'h',null,'s',null,'h',null,'k',null,'h',null,'s',null,'h','h'],
      sparse: ['k',null,null,null,'s',null,null,null,'k',null,null,'k','s',null,null,null],
    };
    const kit = kits[mood.drums];
    for (let s = 0; s < steps; s++) {
      let d = kit[s % 16];
      if (s % 16 === 15 && r() < .5) d = 's';                       // fill
      if (s >= steps - 4 && r() < .6) d = pick(r, ['s', 's', 'k']);   // end fill
      p.no[s] = d;
    }
    return p;
  }

  // =============== audio ===============
  const engine = NeoChip.create();
  const seq = NeoChip.sequencer(engine, () => pattern);

  // =============== DOM ===============
  const $ = (id) => document.getElementById(id);
  const gChip = $('g-chip'), gMood = $('g-mood'), gKey = $('g-key'), gScale = $('g-scale'), gBars = $('g-bars'),
        gBpm = $('g-bpm'), gBpmVal = $('g-bpm-val'), gSeed = $('g-seed'), gDice = $('g-dice'), gGo = $('g-go');
  const playBtn = $('play'), playIcon = $('play-icon'), playLabel = $('play-label'), bpmIn = $('bpm'), bpmVal = $('bpm-val');
  const xTitle = $('x-title'), xChip = $('x-chip'), xLen = $('x-len'), xSeed = $('x-seed'), xStatus = $('x-status');

  const randomSeed = () => Math.random().toString(36).slice(2, 8);
  gDice.addEventListener('click', () => { gSeed.value = randomSeed(); });
  gBpm.addEventListener('input', () => { gBpmVal.textContent = gBpm.value; });

  gGo.addEventListener('click', () => {
    snapshot();
    const seed = gSeed.value.trim() || randomSeed();
    gSeed.value = seed; seedUsed = seed;
    pattern = generate({ seed, chip: gChip.value, mood: gMood.value, key: gKey.value, scale: gScale.value, bars: +gBars.value, bpm: +gBpm.value });
    syncUI();
    if (!seq.playing) start();
    flash(`generated · seed ${seed}`);
  });

  function setPlayUI(on) { playBtn.setAttribute('aria-pressed', on); playIcon.textContent = on ? '■' : '▶'; playLabel.textContent = on ? 'Stop' : 'Play'; }
  const start = () => { seq.start(); setPlayUI(true); };
  const stop = () => { seq.stop(); setPlayUI(false); };
  playBtn.addEventListener('click', () => (seq.playing ? stop() : start()));
  bpmIn.addEventListener('input', () => { pattern.bpm = +bpmIn.value; bpmVal.textContent = pattern.bpm; });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); seq.playing ? stop() : start(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); restore(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && seq.playing) stop(); });

  document.querySelectorAll('.lane').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.lane').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
    b.classList.add('active'); b.setAttribute('aria-selected', 'true'); lane = b.dataset.lane;
  }));
  $('t-clear').addEventListener('click', () => { snapshot(); pattern[lane].fill(null); });
  $('t-shift-up').addEventListener('click', () => shift(12));
  $('t-shift-dn').addEventListener('click', () => shift(-12));
  $('t-undo').addEventListener('click', restore);
  function shift(n) {
    if (lane === 'no') return; snapshot();
    pattern[lane] = pattern[lane].map((m) => m == null ? null : Math.max(MIN_MIDI, Math.min(MAX_MIDI, m + n)));
  }

  function syncUI() {
    bpmIn.value = pattern.bpm; bpmVal.textContent = pattern.bpm;
    xChip.textContent = NeoChip.CHIPS[pattern.chip].label;
    xLen.textContent = `${pattern.steps / 16} bars · ${pattern.steps} steps`;
    xSeed.textContent = seedUsed;
    gChip.value = pattern.chip;
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
  const rowForMidi = (m) => MAX_MIDI - m;                     // top row = highest note
  const midiForRow = (row) => MAX_MIDI - row;

  function cellAt(x, y) {
    const s = Math.floor((x - LABEL_W) / cellW()), row = Math.floor(y / rowH());
    if (s < 0 || s >= pattern.steps || row < 0 || row >= rows()) return null;
    return { s, row };
  }
  function valueForRow(row) { return lane === 'no' ? DRUMS[row] : midiForRow(row); }

  let painting = false, erasing = false;
  roll.addEventListener('contextmenu', (e) => e.preventDefault());
  roll.addEventListener('pointerdown', (e) => {
    const c = cellAt(e.offsetX, e.offsetY); if (!c) return;
    snapshot(); painting = true;
    erasing = e.button === 2 || e.shiftKey || pattern[lane][c.s] === valueForRow(c.row);
    apply(c); roll.setPointerCapture(e.pointerId);
    if (!erasing) audition(valueForRow(c.row));
  });
  roll.addEventListener('pointermove', (e) => { if (!painting) return; const c = cellAt(e.offsetX, e.offsetY); if (c) apply(c); });
  roll.addEventListener('pointerup', () => { painting = false; });
  function apply(c) { pattern[lane][c.s] = erasing ? null : valueForRow(c.row); }
  function audition(v) {
    if (seq.playing) return;
    engine.ensure();
    if (lane === 'no') engine.drum(pattern.chip, v, engine.now + 0.01);
    else engine.note(pattern.chip, lane, v, engine.now + 0.01, 0.18);
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  function drawRoll() {
    const rh = rowH(), cw = cellW(), n = rows();
    rc.fillStyle = '#050409'; rc.fillRect(0, 0, W, H);

    // row shading + labels
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
    // beat/bar lines
    for (let s = 0; s <= pattern.steps; s++) {
      const x = LABEL_W + s * cw;
      rc.fillStyle = s % 16 === 0 ? 'rgba(139,92,246,.45)' : s % 4 === 0 ? 'rgba(139,92,246,.2)' : 'rgba(139,92,246,.08)';
      rc.fillRect(x, 0, 1, H);
    }
    // playhead
    const cur = seq.playing ? ((seq.step - 1 + pattern.steps) % pattern.steps) : -1;
    if (cur >= 0) { rc.fillStyle = 'rgba(255,255,255,.07)'; rc.fillRect(LABEL_W + cur * cw, 0, cw, H); }

    // notes: other lanes dim (melodic only, on melodic view), active lane bright
    const drawLane = (ln, bright) => {
      const arr = pattern[ln];
      for (let s = 0; s < pattern.steps; s++) {
        const v = arr[s]; if (v == null) continue;
        let row;
        if (lane === 'no') { if (ln !== 'no') continue; row = DRUMS.indexOf(v); }
        else { if (ln === 'no') continue; row = rowForMidi(v); if (row < 0 || row >= n) continue; }
        const x = LABEL_W + s * cw + 1, y = row * rh + 1, w = cw - 2, h = rh - 2;
        rc.fillStyle = COLORS[ln];
        rc.globalAlpha = bright ? (s === cur ? 1 : .85) : .22;
        if (bright && s === cur) { rc.shadowColor = COLORS[ln]; rc.shadowBlur = 12; }
        rc.fillRect(x, y, w, Math.max(2, h));
        rc.shadowBlur = 0;
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
  const str = (s) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  function track(events) { // events: [{t, bytes}] absolute ticks
    events.sort((a, b) => a.t - b.t);
    const out = []; let last = 0;
    for (const e of events) { out.push(...vlq(e.t - last), ...e.bytes); last = e.t; }
    out.push(...vlq(0), 0xff, 0x2f, 0x00);
    return [...str('MTrk'), ...u32(out.length), ...out];
  }
  function laneTrack(arr, ch, program, name) {
    const ev = [{ t: 0, bytes: [0xff, 0x03, name.length, ...str(name)] }, { t: 0, bytes: [0xc0 | ch, program] }];
    for (let s = 0; s < arr.length; s++) {
      const m = arr[s]; if (m == null) continue;
      let len = 1; while (s + len < arr.length && arr[s + len] == null && len < 4) len++;   // sustain into rests, max a beat
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
    const tracks = [meta, laneTrack(p.p1, 0, 80, 'Pulse 1'), laneTrack(p.p2, 1, 80, 'Pulse 2'), laneTrack(p.tr, 2, 38, 'Triangle'), drumTrack(p.no)];
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
      row.innerHTML = `<span class="dot ${'p1'}"></span><span class="name" title="load">${item.name}</span><button class="del" title="delete">×</button>`;
      row.querySelector('.name').addEventListener('click', () => { snapshot(); pattern = item.pattern; seedUsed = item.seed || '—'; xTitle.value = item.name; syncUI(); flash(`loaded ${item.name}`); });
      row.querySelector('.del').addEventListener('click', () => { list.splice(i, 1); storeSaved(list); renderSaved(); });
      el.appendChild(row);
    });
  }
  $('x-save').addEventListener('click', () => {
    const list = loadSaved(); const name = xTitle.value.trim() || `track-${list.length + 1}`;
    const idx = list.findIndex((x) => x.name === name);
    const item = { name, seed: seedUsed, pattern: JSON.parse(JSON.stringify(pattern)), at: Date.now() };
    if (idx >= 0) list[idx] = item; else list.unshift(item);
    storeSaved(list.slice(0, 30)); renderSaved(); flash(`saved ${name}`);
  });

  // =============== boot ===============
  const shared = location.hash.startsWith('#p=') ? decode(location.hash.slice(3)) : null;
  if (shared && shared.steps && shared.p1) { pattern = shared; seedUsed = 'shared'; }
  else { gSeed.value = randomSeed(); seedUsed = gSeed.value; pattern = generate({ seed: seedUsed, chip: 'nes', mood: 'stage', key: 'A', scale: 'minor', bars: 4, bpm: 150 }); }
  renderSaved(); syncUI();
})();
