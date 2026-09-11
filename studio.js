/* ============================================================
   NEO術 — Studio
   generate (型 kata engines) → pattern → editor → chip synth → MIDI
   Swap in the model API as another engine when NeoJutsu is trained.
   ============================================================ */
(() => {
  'use strict';

  // =============== state ===============
  const TIE = NeoChip.TIE;
  const LANES = NeoChip.VOICES;               // p1 p2 p3 p4 tr no
  const MELODIC = NeoChip.MELODIC;
  const COLORS = { p1: '#ff2e88', p2: '#2ef2ff', p3: '#5eff8f', p4: '#ff9f43', tr: '#8b5cf6', no: '#ffd23f' };
  const MIN_MIDI = 36, MAX_MIDI = 84;          // C2..C6
  const DRUMS = NeoChip.DRUM_KEYS;            // k s h H t T c r b z
  const DRUM_LABEL = Object.fromEntries(Object.entries(NeoChip.DRUM_KIT).map(([k, v]) => [k, v.label]));
  const ENGINE_LABEL = { kataA: 'kata-A', kataB: 'kata-B', kataC: 'kata-C', onjutsu: 'Onjutsu v1' };
  const LANE_NAME = { p1: 'Pulse 1', p2: 'Pulse 2', p3: 'Pulse 3', p4: 'Pulse 4', tr: 'Triangle', no: 'Noise' };

  const voiceFx = () => ({ vib: 0, trem: 0, echo: 0, duty: null, slide: false, arp: null, env: 'hold', inst: null });
  const defaultFx = () => Object.fromEntries(LANES.map((l) => [l, l === 'no' ? { echo: 0 } : voiceFx()]));
  const defaultMaster = () => ({ crush: 0, echoDiv: '8d', echoFb: 0.35, volume: 1, swing: 0, mono: false });
  // chip-appropriate starting FX, applied on generate
  const CHIP_FX = {
    nes:     { p1: { duty: 0.125 }, p2: { duty: 0.5 } },
    gameboy: { p1: { duty: 0.25 } },
    genesis: { p1: { vib: 0.4, slide: true, echo: 0.25 }, p2: { echo: 0.15 }, rack: { reverb: { on: true, size: 1.4, mix: 18 } } },
    c64:     { p1: { vib: 0.25, echo: 0.2 }, p2: { duty: 0.25 }, rack: { crush: { on: true, bits: 11, mix: 65 } } },
  };

  let pattern = normalize(blank(64, 150, 'nes'));
  let lane = 'p1';
  let seedUsed = '—', engineUsed = 'kataA', trackTitle = 'neojutsu-track';
  const undo = [], redo = [];
  const AUTOSAVE_KEY = 'neojutsu.draft.v1';
  let saveTimer, restoredDraft = false;

  function blank(steps, bpm, chip) {
    const p = { steps, bpm, chip };
    for (const l of LANES) p[l] = Array(steps).fill(null);
    return p;
  }
  function normalize(p) {
    if (!p || !Number.isInteger(p.steps) || p.steps < 16 || p.steps > 1024 || p.steps % 16 || !NeoChip.CHIPS[p.chip]) throw new Error('Invalid pattern');
    p = JSON.parse(JSON.stringify(p));
    const bounded = (v, min, max, fallback) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
    p.bpm = bounded(p.bpm, 80, 220, 150);
    const defaults = defaultFx(); p.fx ||= {}; p.mix ||= {};
    for (const l of LANES) {
      if (!Array.isArray(p[l]) || p[l].length !== p.steps) {
        if (l === 'p3' || l === 'p4') p[l] = Array(p.steps).fill(null);   // added in v0.5
        else throw new Error('Invalid voice');
      }
      p[l] = p[l].map(v => l === 'no' ? (DRUMS.includes(v) ? v : null) : (Number.isInteger(v) && v >= -1 && v <= 127 ? v : null));
      p.fx[l] = Object.assign(defaults[l], p.fx[l] || {});
      for (const k of ['vib', 'echo']) p.fx[l][k] = bounded(p.fx[l][k], 0, 1, 0);
      p.fx[l].duty = [.125, .25, .5].includes(p.fx[l].duty) ? p.fx[l].duty : null;
      p.fx[l].slide = !!p.fx[l].slide;
      p.fx[l].arp = NeoChip.ARPS[p.fx[l].arp] ? p.fx[l].arp : null;
      p.fx[l].trem = bounded(p.fx[l].trem, 0, 1, 0);
      p.fx[l].env = NeoChip.ENVS[p.fx[l].env] ? p.fx[l].env : 'hold';
      p.fx[l].inst = NeoChip.INSTRUMENTS[p.fx[l].inst] ? p.fx[l].inst : null;
      const m = p.mix[l] || {};
      p.mix[l] = { volume: bounded(m.volume, 0, 1, 1), pan: bounded(m.pan, -1, 1, 0), mute: !!m.mute, solo: !!m.solo };
    }
    p.master = Object.assign(defaultMaster(), p.master || {});
    p.master.crush = bounded(p.master.crush, 0, 1, 0); p.master.echoFb = bounded(p.master.echoFb, 0, .8, .35); p.master.volume = bounded(p.master.volume, 0, 1, 1);
    p.master.swing = bounded(p.master.swing, 0, 1, 0);
    p.master.mono = !!p.master.mono;
    // Effects rack. Patterns from before the rack carry their crush and echo
    // settings across, then hand ownership to the rack.
    const hadRack = !!p.rack;
    p.rack = NeoRack.normalize(p.rack);
    if (!hadRack) {
      if (p.master.crush > 0) { p.rack.crush.on = true; p.rack.crush.bits = Math.round(12 - p.master.crush * 9); }
      p.rack.echo.on = true;
      p.rack.echo.feedback = Math.round(p.master.echoFb * 100);
      p.rack.echo.div = p.master.echoDiv;
    }
    p.master.crush = 0;                       // the rack owns crush now
    if (!['16', '8', '8d', '4'].includes(p.master.echoDiv)) p.master.echoDiv = '8d';
    const bars = p.steps / 16, loop = p.loop || {};
    const start = Math.round(bounded(loop.start, 1, bars, 1));
    p.loop = { enabled: !!loop.enabled, start, end: Math.round(bounded(loop.end, start, bars, bars)) };
    return p;
  }
  function session() {
    return { pattern, seed: seedUsed, engine: engineUsed, title: trackTitle,
      generator: { mood: $('g-mood').value, key: $('g-key').value, scale: $('g-scale').value } };
  }
  function queueSave() {
    $('autosave-status').textContent = 'Saving…';
    clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 450);
  }
  function saveDraft() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(session())); $('autosave-status').textContent = 'Autosaved on this browser'; }
    catch { $('autosave-status').textContent = 'Autosave unavailable · export to keep your work'; }
  }
  function applySession(data) {
    const next = normalize(data.pattern); stop(); pattern = next;
    seedUsed = data.seed || '—'; engineUsed = isEngine(data.engine) ? data.engine : 'kataA';
    trackTitle = data.title || data.name || 'neojutsu-track'; $('x-title').value = trackTitle;
    if (data.generator) for (const key of ['mood', 'key', 'scale']) { const el = $('g-' + key); if ([...el.options].some(o => o.value === data.generator[key])) el.value = data.generator[key]; }
    syncUI(); queueSave();
  }
  function historyUI() { $('t-undo').disabled = !undo.length; $('t-redo').disabled = !redo.length; }
  function snapshot() { undo.push(JSON.stringify(session())); if (undo.length > 50) undo.shift(); redo.length = 0; historyUI(); queueSave(); }
  function restore(forward = false) {
    const from = forward ? redo : undo, to = forward ? undo : redo, value = from.pop();
    if (!value) return; to.push(JSON.stringify(session())); applySession(JSON.parse(value)); historyUI();
  }

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
    drive:  ['k','h','h','h','s','h','h','h','k','h','k','h','s','h','h','H'],
    heavy:  ['k','h','k','r','s','h','k','h','k','H','k','h','s','t','T','s'],
    light:  ['k',null,'h',null,'s',null,'h',null,'k',null,'h',null,'s',null,'h','H'],
    sparse: ['k',null,null,'r','s',null,null,null,'k',null,null,'k','s',null,null,'r'],
    arcade: ['k','h','b','h','s','h','b','h','k','h','k','b','s','h','T','t'],
  };
  const FILLS = [['t','t','T','T'], ['s','s','T','c'], ['T','t','s','c'], ['s',null,'s','c']];

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
    for (let s = 0; s < steps; s++) p.no[s] = kit[s % 16];
    p.no[0] = 'c';                                        // crash the downbeat
    // a fill in the last bar of every four, and again at the very end
    for (let bar = 3; bar < steps / 16; bar += 4) {
      const fill = pick(r, FILLS);
      for (let k = 0; k < 4; k++) p.no[bar * 16 + 12 + k] = fill[k];
    }
    const lastBar = Math.floor((steps - 1) / 16);
    if (lastBar % 4 !== 3) { const fill = pick(r, FILLS); for (let k = 0; k < 4; k++) p.no[steps - 4 + k] = fill[k]; }
  }
  // p3 = counter-melody under the lead, p4 = sustained pad or sub-octave bass.
  // Both stay sparse so six voices read as an arrangement, not mud.
  function layers(p, r, prog, degToMidi, mood, opts) {
    const steps = p.steps;
    for (let bar = 0; bar < steps / 16; bar++) {
      const chord = prog[bar % prog.length], b0 = bar * 16;
      // counter-melody: answers on the off-beats where the lead doesn't strike.
      // A held lead note (TIE) is fine to play under; only its attacks are avoided.
      const answers = [2, 6, 10, 14], tones = [chord + 4, chord + 2, chord + 7, chord + 4];
      const attacks = (i) => p.p1[i] != null && p.p1[i] !== TIE;
      answers.forEach((s, i) => {
        if (attacks(b0 + s)) return;
        if (r() > .75) return;                        // an occasional rest, so it breathes
        p.p3[b0 + s] = degToMidi(tones[i], mood.oct - 1);
        if (s + 1 < 16 && !attacks(b0 + s + 1)) p.p3[b0 + s + 1] = TIE;
      });
      // pad: root and fifth held across the bar, or a sub octave on sparse moods
      if (mood.sustain) {
        p.p4[b0] = degToMidi(chord, -1 + mood.oct);
        for (let k = 1; k < 16; k++) p.p4[b0 + k] = TIE;
      } else if (r() < .6) {
        p.p4[b0] = degToMidi(chord, -2 + mood.oct);
        for (let k = 1; k < 8; k++) p.p4[b0 + k] = TIE;
      }
    }
    // give the new voices their own colour
    p.fx.p3.inst = mood.sustain ? 'fmorgan' : 'pulse25';
    p.fx.p3.env = 'pluck'; p.fx.p3.echo = Math.max(p.fx.p3.echo, .15);
    p.fx.p4.inst = mood.sustain ? 'fmorgan' : 'fmbass';
    p.fx.p4.env = 'pad'; p.fx.p4.trem = mood.sustain ? .2 : 0;
    p.mix.p3.volume = .55; p.mix.p4.volume = .5;
    // Spread the voices across the image. Real chips were mono, but two pulses
    // pulled apart is what the trackers did the moment stereo was available.
    const SPREAD = { p1: -.38, p2: .38, p3: -.65, p4: .65, tr: 0, no: 0 };
    for (const [l, pan] of Object.entries(SPREAD)) p.mix[l].pan = pan;
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
    for (const [id, vals] of Object.entries(cf.rack || {})) Object.assign(p.rack[id], vals);
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
    layers(p, r, prog, degToMidi, mood, opts);
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
    layers(p, r, prog, degToMidi, mood, opts);
    drums(p, r, KITS[mood.drums], steps);
    return p;
  }

  // =============== 型 kata-C: arcade (arpeggio chords, driving riff) ===============
  function kataC(opts) {
    const { r, steps, p, scale, mood, prog, degToMidi } = setup(opts);
    const quality = (chord) => {                                   // major or minor triad on this degree?
      const third = (scale[(chord + 2) % scale.length] - scale[chord % scale.length] + 12) % 12;
      return third === 4 ? 'maj' : third === 3 ? 'min' : 'pow';
    };
    for (let bar = 0; bar < opts.bars; bar++) {
      const chord = prog[bar % prog.length], b0 = bar * 16;
      // pulse 2: arpeggiated chord stabs, root held with the 60 Hz arp doing the chord
      const stabs = mood.density > .6 ? [0, 3, 6, 8, 11, 14] : [0, 4, 8, 12];
      for (const s of stabs) { p.p2[b0 + s] = degToMidi(chord, mood.oct); const hold = mood.density > .6 ? 2 : 3; for (let k = 1; k < hold && s + k < 16; k++) p.p2[b0 + s + k] = TIE; }
      // bass: driving 8ths on the root, octave up on the "and" of 2 and 4
      for (let e = 0; e < 8; e++) p.tr[b0 + e * 2] = degToMidi(chord, -1 + mood.oct) + (e % 4 === 3 ? 12 : 0);
      // lead: syncopated riff built from a 4-note cell that climbs the chord
      const cell = [0, 2, 4, 7].map((d) => chord + 7 + d);
      const rhythm = r() < .5 ? [0, 3, 6, 10, 12, 14] : [0, 2, 4, 7, 9, 12, 14];
      rhythm.forEach((s, i) => { if (r() < mood.density + .2) p.p1[b0 + s] = degToMidi(cell[i % cell.length] + (r() < .15 ? pick(r, [-1, 1]) : 0), mood.oct); });
      if (bar % 4 === 3) for (let k = 12; k < 16; k++) p.p1[b0 + k] = degToMidi(cell[(3 - (k - 12)) % 4], mood.oct);   // turnaround run
    }
    const lastChord = prog[(opts.bars - 1) % prog.length];
    p.fx.p2.arp = quality(lastChord) === 'pow' ? 'pow' : quality(prog[0]);
    p.fx.p1.echo = Math.max(p.fx.p1.echo, 0.2);
    p.master.swing = mood.drums === 'light' ? 0.25 : 0;
    layers(p, r, prog, degToMidi, mood, opts);
    drums(p, r, KITS[mood.drums === 'sparse' ? 'light' : mood.drums === 'drive' ? 'arcade' : mood.drums], steps);
    return p;
  }

  const ENGINES = { kataA, kataB, kataC };

  // NeoJutsu is an engine like the kata are, but it runs a model in a worker
  // and returns a promise. It stays out of ENGINES -- whose members are called
  // synchronously -- and is recognised by isEngine() everywhere the question is
  // "did a generator make this?" rather than "call it right now".
  const AI_ENGINE = 'onjutsu';
  const isEngine = (name) => !!ENGINES[name] || name === AI_ENGINE;
  const engineBadgeText = (name) => isEngine(name)
    ? `engine: ${name === AI_ENGINE ? '音術' : '型'} ${ENGINE_LABEL[name]}`
    : 'source: imported MIDI';
  if (window.OnjutsuAI) OnjutsuAI.configure({ baseUrl: 'onjutsu/' });

  // =============== audio ===============
  const engine = NeoChip.create();
  let audibleStep = -1;
  const seq = NeoChip.sequencer(engine, () => pattern, (step, time) => { setTimeout(() => { if (seq.playing) audibleStep = step; }, Math.max(0, (time - engine.now) * 1000)); });

  // =============== DOM ===============
  const $ = (id) => document.getElementById(id);
  const gEngine = $('g-engine'), gChip = $('g-chip'), gMood = $('g-mood'), gKey = $('g-key'), gScale = $('g-scale'), gBars = $('g-bars'),
        gBpm = $('g-bpm'), gBpmVal = $('g-bpm-val'), gSeed = $('g-seed'), gDice = $('g-dice'), gMutate = $('g-mutate'), gGo = $('g-go');
  const playBtn = $('play'), playIcon = $('play-icon'), playLabel = $('play-label'), bpmIn = $('bpm'), bpmVal = $('bpm-val');
  const xTitle = $('x-title'), xChip = $('x-chip'), xLen = $('x-len'), xSeed = $('x-seed'), xEngine = $('x-engine'), xStatus = $('x-status');
  const engineBadge = $('engine-badge');
  xTitle.addEventListener('input', () => { trackTitle = xTitle.value; });

  const randomSeed = () => Math.random().toString(36).slice(2, 8);
  gDice.addEventListener('click', () => { gSeed.value = randomSeed(); });
  gBpm.addEventListener('input', () => { gBpmVal.textContent = gBpm.value; });
  const gDrums = $('g-drums'), gScene = $('g-scene'), gPrompt = $('g-prompt');
  // Scene, Drums and the prompt box are conditions only the model has.
  // The kata engines compose from rules, so showing them there would be
  // a lie about what the controls do.
  // No Scene select. The <SCENE> token measured inert -- prompts
  // separate slightly BETTER with it blanked -- so a dropdown for it
  // would imply control the model does not have. The prompt box still
  // reads scene words; it sets the fields that actually work.
  // Drums is the only control unique to the model -- the kata engines
  // write their percussion from rules. The prompt box is deliberately
  // NOT in here: it sets mood, key, scale, tempo and bars, which every
  // engine uses, so hiding it for the kata was a mistake.
  const AI_FIELDS = ['g-drums-field'];
  const syncAiFields = () => {
    const on = gEngine.value === AI_ENGINE;
    for (const id of AI_FIELDS) { const el = $(id); if (el) el.style.display = on ? '' : 'none'; }
  };

  // The prompt drives the VISIBLE controls. Typing 'final boss' moves
  // Mood, Scale, Tempo and Drums where you can see them, so a wrong
  // guess can be corrected by hand. It is a keyword parser, not a
  // language model, and it will sometimes guess wrong.
  function applyPrompt() {
    if (!gPrompt || !window.OnjutsuPrompt) return;
    const read = $('g-prompt-read');
    const text = gPrompt.value.trim();
    if (!text) { if (read) read.textContent = ''; return; }
    const p = OnjutsuPrompt.parse(text);
    // A change event, not just .value. The Studio wraps its selects in
    // a custom control that repaints on 'change'; assigning .value alone
    // updates the hidden element while the visible one keeps its old
    // label -- the readout would say chill while the box still showed
    // Stage theme, which is exactly the confusion it exists to prevent.
    const set = (el, v) => {
      if (!el || v == null) return;
      if (![...el.options].some(o => o.value === String(v))) return;
      el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(gScene, p.scene); set(gMood, p.mood); set(gKey, p.key);
    set(gScale, p.scale); set(gChip, p.chip); set(gBars, p.bars);
    set(gDrums, p.drums);
    if (p.bpm != null) {
      gBpm.value = String(p.bpm);
      gBpm.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (read) read.textContent = OnjutsuPrompt.describe(p);
  }
  if (gPrompt) {
    gPrompt.addEventListener('input', applyPrompt);
    gPrompt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyPrompt(); run(); } });
  }
  gEngine.addEventListener('change', () => { engineBadge.textContent = engineBadgeText(gEngine.value); syncAiFields(); });
  syncAiFields();
  gMutate.addEventListener('click', () => {
    const cur = gSeed.value.trim() || randomSeed();
    const base = cur.replace(/~\d+$/, '');
    const m = cur.match(/~(\d+)$/); const n = m ? +m[1] + 1 : 1;
    gSeed.value = `${base}~${n}`; run();
  });

  let generating = false;
  async function run() {
    if (generating) return;
    snapshot();
    const seed = gSeed.value.trim() || randomSeed();
    gSeed.value = seed; seedUsed = seed; engineUsed = gEngine.value;
    const opts = { seed, engine: engineUsed, chip: gChip.value, mood: gMood.value, key: gKey.value, scale: gScale.value, bars: +gBars.value, bpm: +gBpm.value };

    if (engineUsed === AI_ENGINE) {
      // Seconds, not a tick: the weights download once per session and every
      // step of the pattern is a forward pass. The button locks and the wait is
      // narrated, because a Studio that looks frozen is worse than one that
      // looks slow.
      generating = true; gGo.disabled = true; stop();
      try {
        opts.drums = (gDrums && gDrums.value) || null;
        opts.scene = (gScene && gScene.value) || null;
        const notes = await OnjutsuAI.generate(opts, (p) => {
          flash(p.stage === 'download' ? `downloading model · ${p.detail}`
            : p.stage === 'generate' ? `generating · ${Math.round((p.progress || 0) * 100)}%`
            : p.detail || 'preparing model');
        });
        // The same treatment the kata engines get: a normalised blank carrying
        // this chip's FX, with only the note lanes replaced. Going through
        // setup() means the model's output cannot arrive configured differently
        // from everything else the Studio makes.
        const { p } = setup(opts);
        for (const l of LANES) p[l] = notes[l];
        p.bpm = opts.bpm;
        pattern = normalize(p);
      } catch (e) {
        flash(`NeoJutsu failed · ${e.message}`);
        generating = false; gGo.disabled = false; return;
      }
      generating = false; gGo.disabled = false;
    } else {
      pattern = ENGINES[engineUsed](opts);
      stop();
    }
    rememberSeed(seed); syncUI(); start();
    flash(`generated · ${ENGINE_LABEL[engineUsed]} · seed ${seed}`);
  }
  gGo.addEventListener('click', run);

  const outStereo = $('out-stereo'), outMono = $('out-mono');
  function syncOutput() {
    const mono = !!pattern.master.mono;
    outMono.classList.toggle('is-on', mono); outMono.setAttribute('aria-pressed', String(mono));
    outStereo.classList.toggle('is-on', !mono); outStereo.setAttribute('aria-pressed', String(!mono));
    engine.setMono(mono);
  }
  function setOutput(mono) {
    if (!!pattern.master.mono === mono) return;
    snapshot(); pattern.master.mono = mono; syncOutput(); queueSave();
    flash(mono ? 'folded to mono' : 'stereo output');
  }
  outStereo.addEventListener('click', () => setOutput(false));
  outMono.addEventListener('click', () => setOutput(true));

  function setPlayUI(on) { playBtn.setAttribute('aria-pressed', on); playIcon.textContent = on ? '■' : '▶'; playLabel.textContent = on ? 'Stop' : 'Play'; }
  const start = () => { try { seq.start(); setPlayUI(true); } catch { flash('Audio could not start. Please try again.'); } };
  const stop = () => { seq.stop(); audibleStep = -1; setPlayUI(false); };
  playBtn.addEventListener('click', () => (seq.playing ? stop() : start()));
  bpmIn.addEventListener('input', () => { pattern.bpm = +bpmIn.value; bpmVal.textContent = pattern.bpm; gBpm.value = pattern.bpm; gBpmVal.textContent = pattern.bpm; syncLength(); });
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); if (!e.repeat) seq.playing ? stop() : start(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); restore(e.shiftKey); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); restore(true); }
    else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      if (['1','2','3','4','5','6'].includes(e.key)) document.querySelectorAll('.lane')[+e.key - 1]?.click();
      if (e.key.toLowerCase() === 'l') $('loop-toggle').click();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && seq.playing) stop(); });

  document.querySelectorAll('.lane').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.lane').forEach((x) => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
    b.classList.add('active'); b.setAttribute('aria-selected', 'true'); lane = b.dataset.lane; syncFx(); syncCopy();
  }));
  document.querySelector('.lane-tabs').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault();
    const tabs = [...document.querySelectorAll('.lane')], current = tabs.indexOf(document.activeElement);
    const n = tabs.length;
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (current + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    tabs[index].focus(); tabs[index].click();
  });
  $('t-clear').addEventListener('click', () => { snapshot(); pattern[lane].fill(null); });
  $('t-shift-up').addEventListener('click', () => shift(12));
  $('t-shift-dn').addEventListener('click', () => shift(-12));
  $('t-undo').addEventListener('click', () => restore());
  $('t-redo').addEventListener('click', () => restore(true));
  function shift(n) {
    if (lane === 'no') return; snapshot();
    pattern[lane] = pattern[lane].map((m) => (m == null || m === TIE) ? m : Math.max(MIN_MIDI, Math.min(MAX_MIDI, m + n)));
  }

  // ---- seed history
  const SEEDS_KEY = 'neojutsu.seeds';
  const loadSeeds = () => { try { const list = JSON.parse(localStorage.getItem(SEEDS_KEY) || '[]'); return Array.isArray(list) ? list.filter(s => typeof s === 'string').slice(0, 10) : []; } catch { return []; } };
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
  const fxVib = $('fx-vib'), fxTrem = $('fx-trem'), fxEcho = $('fx-echo'), fxDuty = $('fx-duty'), fxSlide = $('fx-slide'), fxArp = $('fx-arp');
  const fxInst = $('fx-inst'), fxEnv = $('fx-env'), fxPreset = $('fx-preset');
  // Presets are grouped by hardware family so the list stays readable.
  {
    fxPreset.add(new Option('— custom —', ''));
    for (const g of NeoPresets.GROUPS) {
      const grp = document.createElement('optgroup'); grp.label = g.label;
      for (const [id, p] of Object.entries(g.presets)) {
        const o = new Option(p.name, id); o.title = p.blurb; grp.append(o);
      }
      fxPreset.append(grp);
    }
  }
  fxPreset.addEventListener('change', () => {
    const id = fxPreset.value; if (!id) return;
    snapshot();
    NeoPresets.apply(pattern.fx[lane], id);
    syncFx(); queueSave();
    flash(`${NeoPresets.ALL[id].name} → ${LANE_NAME[lane]}`);
  });
  const fxSwing = $('fx-swing');
  for (const [id, label] of Object.entries(NeoChip.INSTRUMENTS)) fxInst.add(new Option(label.label, id));
  for (const [id, label] of Object.entries(NeoChip.ENVS)) fxEnv.add(new Option(label, id));

  function syncFx() {
    const f = pattern.fx[lane], melodic = lane !== 'no';
    $('fx-lane-name').textContent = LANE_NAME[lane];
    $('fx-lane-name').style.setProperty('--voice-tint', COLORS[lane]);
    fxVib.value = Math.round((f.vib || 0) * 100); $('fx-vib-v').textContent = fxVib.value;
    fxTrem.value = Math.round((f.trem || 0) * 100); $('fx-trem-v').textContent = fxTrem.value;
    fxInst.value = f.inst || ''; fxEnv.value = f.env || 'hold';
    $('fx-inst-row').hidden = $('fx-env-row').hidden = $('fx-trem-row').hidden = !melodic;
    $('fx-preset-row').hidden = !melodic;
    if (melodic) fxPreset.value = NeoPresets.match(f);      // empty selects "custom"
    if (window.NeoSelect) NeoSelect.refreshAll($('fx-voice'));
    fxEcho.value = Math.round((f.echo || 0) * 100); $('fx-echo-v').textContent = fxEcho.value;
    fxDuty.value = f.duty ? String(f.duty) : ''; fxSlide.checked = !!f.slide;
    fxVib.closest('.fx-row').hidden = !melodic;
    const effType = f.inst ? NeoChip.INSTRUMENTS[f.inst].type : NeoChip.voiceCfg(pattern.chip, lane).type;
    $('fx-duty-row').hidden = !(melodic && effType === 'pulse' && !f.inst);
    $('fx-slide-row').hidden = !melodic;
    $('fx-arp-row').hidden = !melodic; fxArp.value = f.arp || '';
    fxSwing.value = Math.round(pattern.master.swing * 100); $('fx-swing-v').textContent = fxSwing.value;
    if (window.NeoFxUI) NeoFxUI.sync();
  }
  fxArp.addEventListener('change', () => { pattern.fx[lane].arp = fxArp.value || null; });
  fxTrem.addEventListener('input', () => { pattern.fx[lane].trem = fxTrem.value / 100; $('fx-trem-v').textContent = fxTrem.value; });
  fxInst.addEventListener('change', () => { pattern.fx[lane].inst = fxInst.value || null; syncFx(); });
  fxEnv.addEventListener('change', () => { pattern.fx[lane].env = fxEnv.value; });
  fxSwing.addEventListener('input', () => { pattern.master.swing = fxSwing.value / 100; $('fx-swing-v').textContent = fxSwing.value; });
  fxVib.addEventListener('input', () => { pattern.fx[lane].vib = fxVib.value / 100; $('fx-vib-v').textContent = fxVib.value; });
  fxEcho.addEventListener('input', () => { pattern.fx[lane].echo = fxEcho.value / 100; $('fx-echo-v').textContent = fxEcho.value; engine.setMix(pattern); });
  fxDuty.addEventListener('change', () => { pattern.fx[lane].duty = fxDuty.value ? +fxDuty.value : null; });
  fxSlide.addEventListener('change', () => { pattern.fx[lane].slide = fxSlide.checked; });


  function syncUI() {
    bpmIn.value = pattern.bpm; bpmVal.textContent = pattern.bpm; gBpm.value = pattern.bpm; gBpmVal.textContent = pattern.bpm;
    xChip.textContent = NeoChip.CHIPS[pattern.chip].label;
    syncLength();
    xSeed.textContent = seedUsed; xEngine.textContent = ENGINE_LABEL[engineUsed] || engineUsed;
    gChip.value = pattern.chip;
    if (isEngine(engineUsed)) { gSeed.value = seedUsed; gEngine.value = engineUsed; }
    gBars.value = String(pattern.steps / 16); engineBadge.textContent = engineBadgeText(engineUsed);
    clampView(); syncFx(); syncMix(); syncLoop(); syncCopy(); renderSeeds(); historyUI(); resize();
  }
  gChip.addEventListener('change', () => { pattern.chip = gChip.value; syncUI(); });
  function flash(msg) { xStatus.textContent = msg; clearTimeout(flash.t); flash.t = setTimeout(() => (xStatus.textContent = ''), 3500); }

  // =============== piano roll editor ===============
  const roll = $('roll'), rc = roll.getContext('2d');
  const LABEL_W = 44;
  let W = 0, H = 0, dpr = 1;
  // The roll shows a window of the pattern: `view.bars` bars starting at `view.start`.
  // Long patterns page rather than scroll, so a 64-bar track stays readable.
  const view = { bars: 8, start: 0, follow: true };
  const totalBars = () => pattern.steps / 16;
  // Honour the chosen zoom on a roomy canvas; on a narrow one show fewer bars so
  // a 16th step stays big enough to hit with a finger.
  const minCell = () => (W < 700 ? 8 : 4);
  const fitBars = () => Math.max(1, Math.floor(Math.max(120, W - LABEL_W) / minCell() / 16) || 1);
  const viewBars = () => Math.min(view.bars, fitBars(), totalBars());
  const viewSteps = () => viewBars() * 16;
  const viewStart = () => view.start * 16;
  function clampView() {
    const maxStart = Math.max(0, totalBars() - viewBars());
    view.start = Math.max(0, Math.min(maxStart, Math.round(view.start)));
  }
  function resize() {
    dpr = window.devicePixelRatio || 1;
    roll.style.width = '100%';
    W = roll.clientWidth; H = roll.clientHeight;
    roll.width = W * dpr; roll.height = H * dpr; rc.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const onResize = () => { resize(); if (typeof syncView === 'function') syncView(); };
  window.addEventListener('resize', onResize); new ResizeObserver(onResize).observe(roll.parentElement); resize();

  function syncView() {
    clampView();
    const first = view.start + 1, last = view.start + viewBars();
    $('view-label').textContent = `bar ${first}–${last} of ${totalBars()}`;
    $('view-zoom').title = view.bars > fitBars() ? `Showing ${fitBars()} bars - the window is too narrow for ${view.bars}` : '';
    $('view-prev').disabled = view.start === 0;
    $('view-next').disabled = view.start >= totalBars() - viewBars();
    $('view-zoom').value = String(view.bars);
    // ruler shows only the visible bars
    const ruler = $('bar-ruler'); ruler.replaceChildren();
    for (let b = first; b <= last; b++) {
      const el = document.createElement('span'); el.textContent = String(b);
      el.className = pattern.loop.enabled && b >= pattern.loop.start && b <= pattern.loop.end ? 'selected' : '';
      ruler.append(el);
    }
  }
  function pageTo(bar) { view.start = bar; view.follow = false; syncView(); }
  $('view-prev').addEventListener('click', () => pageTo(view.start - viewBars()));
  $('view-next').addEventListener('click', () => pageTo(view.start + viewBars()));
  $('view-zoom').addEventListener('change', () => { view.bars = +$('view-zoom').value; syncView(); });
  $('view-follow').addEventListener('click', () => {
    view.follow = !view.follow; $('view-follow').setAttribute('aria-pressed', view.follow); syncView();
  });
  // keep the playhead on screen while playing
  function followPlayhead(step) {
    if (!view.follow || step < 0) return;
    const bar = Math.floor(step / 16);
    if (bar < view.start || bar >= view.start + viewBars()) { view.start = Math.floor(bar / viewBars()) * viewBars(); syncView(); }
  }

  const rows = () => (lane === 'no' ? DRUMS.length : (MAX_MIDI - MIN_MIDI + 1));
  const rowH = () => H / rows();
  const cellW = () => (W - LABEL_W) / viewSteps();
  const rowForMidi = (m) => MAX_MIDI - m;
  const midiForRow = (row) => MAX_MIDI - row;
  const valueForRow = (row) => (lane === 'no' ? DRUMS[row] : midiForRow(row));

  function cellAt(x, y) {
    const s = viewStart() + Math.floor((x - LABEL_W) / cellW()), row = Math.floor(y / rowH());
    if (x < LABEL_W || s < 0 || s >= pattern.steps || row < 0 || row >= rows()) return null;
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
    mode = null; queueSave();
  });
  roll.addEventListener('pointercancel', () => { mode = null; queueSave(); });
  function paint(c) {
    const arr = pattern[lane], v = valueForRow(c.row);
    if (lane !== 'no' && arr[c.s] === TIE) eraseAt(arr, c.s);
    arr[c.s] = v;
  }
  function audition(v) {
    if (seq.playing) return; engine.ensure(); engine.setMix(pattern);
    engine.setCrush(pattern.master.crush); engine.setEcho(NeoChip.echoSeconds(pattern.bpm, pattern.master.echoDiv), pattern.master.echoFb);
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
    const vs = viewStart(), vn = viewSteps();
    for (let i = 0; i <= vn; i++) {
      const s = vs + i;
      rc.fillStyle = s % 16 === 0 ? 'rgba(139,92,246,.45)' : s % 4 === 0 ? 'rgba(139,92,246,.2)' : 'rgba(139,92,246,.08)';
      rc.fillRect(LABEL_W + i * cw, 0, 1, H);
    }
    const cur = seq.playing ? audibleStep : -1;
    if (cur >= vs && cur < vs + vn) { rc.fillStyle = 'rgba(255,255,255,.07)'; rc.fillRect(LABEL_W + (cur - vs) * cw, 0, cw, H); }

    const drawLane = (ln, bright) => {
      const arr = pattern[ln];
      for (let s = 0; s < pattern.steps; s++) {
        const v = arr[s]; if (v == null || v === TIE) continue;
        let row, len = 1;
        if (lane === 'no') { if (ln !== 'no') continue; row = DRUMS.indexOf(v); if (row < 0) continue; }
        else { if (ln === 'no') continue; row = rowForMidi(v); if (row < 0 || row >= n) continue; len = NeoChip.noteLength(arr, s); }
        if (s + len <= vs || s >= vs + vn) continue;                 // outside the window
        const active = cur >= s && cur < s + len;
        const x = LABEL_W + (s - vs) * cw + 1, y = row * rh + 1, w = cw * len - 2, h = Math.max(2, rh - 2);
        rc.fillStyle = COLORS[ln]; rc.globalAlpha = bright ? (active ? 1 : .85) : .22;
        if (bright && active) { rc.shadowColor = COLORS[ln]; rc.shadowBlur = 12; }
        rc.fillRect(x, y, w, h); rc.shadowBlur = 0;
        if (len > 1 && bright) { rc.fillStyle = 'rgba(0,0,0,.35)'; for (let k = 1; k < len; k++) rc.fillRect(LABEL_W + (s + k - vs) * cw, y + 1, 1, h - 2); }
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
  function animate() { requestAnimationFrame(animate); if (seq.playing) followPlayhead(audibleStep); drawRoll(); drawScope(); drawMeters(); }

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
  function laneTrack(arr, ch, program, name, fx, mix) {
    const ev = [{ t: 0, bytes: [0xff, 0x03, name.length, ...str(name)] }, { t: 0, bytes: [0xc0 | ch, program] }];
    ev.push({ t: 0, bytes: [0xb0 | ch, 7, mix.volume] }, { t: 0, bytes: [0xb0 | ch, 10, mix.pan] });
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
  function drumTrack(arr, mix) {
    // General MIDI percussion numbers
    const map = { k: 36, s: 38, h: 42, H: 46, t: 45, T: 50, c: 49, r: 37, b: 56, z: 76 };
    const ev = [{ t: 0, bytes: [0xff, 0x03, 5, ...str('Noise')] }, { t: 0, bytes: [0xb9, 7, mix.volume] }, { t: 0, bytes: [0xb9, 10, mix.pan] }];
    for (let s = 0; s < arr.length; s++) {
      const d = arr[s]; if (!d) continue;
      ev.push({ t: s * TICK16, bytes: [0x99, map[d] ?? 38, d === 'h' || d === 'r' ? 80 : 110] });
      ev.push({ t: s * TICK16 + TICK16 / 2, bytes: [0x89, map[d], 0] });
    }
    return track(ev);
  }
  function toMidi(p, title) {
    const mpq = Math.round(60000000 / p.bpm);
    const meta = track([
      { t: 0, bytes: [0xff, 0x03, ...vlq(str(title).length), ...str(title)] },
      { t: 0, bytes: [0xff, 0x51, 0x03, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255] },
      { t: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] },
    ]);
    const prog = { p1: 80, p2: 80, p3: 80, p4: 80, tr: 38 };
    if (p.chip === 'c64') { prog.p1 = 81; prog.p4 = 81; }
    if (p.chip === 'genesis') { prog.p1 = 87; prog.p2 = 88; prog.p3 = 98; prog.p4 = 16; prog.tr = 39; }
    const anySolo = LANES.some(l => p.mix[l].solo);
    const midiMix = l => ({ volume: Math.round((p.mix[l].mute || (anySolo && !p.mix[l].solo) ? 0 : p.mix[l].volume * p.master.volume) * 127), pan: Math.round((p.mix[l].pan + 1) * 63.5) });
    // MIDI channel 9 is percussion, so melodic voices use 0-5 and skip it
    const chan = { p1: 0, p2: 1, p3: 2, p4: 3, tr: 4 };
    const tracks = [meta, ...MELODIC.map((l) => laneTrack(p[l], chan[l], prog[l], LANE_NAME[l], p.fx[l], midiMix(l))), drumTrack(p.no, midiMix('no'))];
    const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(TPQ)];
    return new Uint8Array([...header, ...tracks.flat()]);
  }
  function exportMidi() {
    const title = (xTitle.value.trim() || 'neojutsu-track').replace(/[^\w\- ]+/g, '') || 'neojutsu-track';
    const blob = new Blob([toMidi(pattern, title)], { type: 'audio/midi' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${title}.mid`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('MIDI downloaded');
  }
  $('x-midi').addEventListener('click', exportMidi);

  // =============== share link + saved ===============
  function encode(p) { return btoa(unescape(encodeURIComponent(JSON.stringify(p)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function decode(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))))); } catch { return null; } }
  $('x-link').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#p=${encode(pattern)}`;
    try { await navigator.clipboard.writeText(url); flash('link copied'); } catch { location.hash = `p=${encode(pattern)}`; flash('link in address bar'); }
  });

  const KEY = 'neojutsu.saved';
  const loadSaved = () => { try { const list = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(list) ? list.filter(item => { try { normalize(item.pattern); return typeof item.name === 'string'; } catch { return false; } }).slice(0,30) : []; } catch { return []; } };
  const storeSaved = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { flash('Browser storage is full or unavailable. Export your audio to keep it.'); return false; } };
  function renderSaved() {
    const list = loadSaved(), el = $('saved-list'); el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<p class="side-note">Nothing saved yet.</p>'; return; }
    list.forEach((item, i) => {
      const row = document.createElement('div'); row.className = 'saved-item';
      row.innerHTML = '<span class="dot p1"></span><button class="name" title="Load saved track"></button><button class="del" title="Delete saved track">×</button>';
      row.querySelector('.name').textContent = item.name;
      row.querySelector('.name').addEventListener('click', () => { snapshot(); applySession(item); flash(`loaded ${item.name}`); });
      row.querySelector('.del').addEventListener('click', () => { list.splice(i, 1); if (storeSaved(list)) renderSaved(); });
      el.appendChild(row);
    });
  }
  $('x-save').addEventListener('click', () => {
    const list = loadSaved(); const name = xTitle.value.trim() || `track-${list.length + 1}`;
    const idx = list.findIndex((x) => x.name === name);
    const item = { name, seed: seedUsed, engine: engineUsed, pattern: JSON.parse(JSON.stringify(pattern)), at: Date.now() };
    if (idx >= 0) list[idx] = item; else list.unshift(item);
    if (storeSaved(list.slice(0, 30))) { renderSaved(); flash(`saved ${name}`); }
  });

  // =============== workspace controls ===============
  function syncLength() { xLen.textContent = `${pattern.steps / 16} bars · ${(pattern.steps * 60 / pattern.bpm / 4).toFixed(1)}s`; }
  function syncCopy() {
    const target = $('copy-target');
    if (!target.options.length) for (const l of MELODIC) target.add(new Option('To ' + LANE_NAME[l], l));
    for (const option of target.options) option.disabled = option.value === lane;
    if (target.value === lane) target.value = [...target.options].find(o => !o.disabled).value;
    target.disabled = $('t-duplicate').disabled = lane === 'no';
    $('t-shift-up').disabled = $('t-shift-dn').disabled = lane === 'no';
    $('t-double').disabled = pattern.steps >= 1024;
  }
  $('t-duplicate').addEventListener('click', () => {
    const target = $('copy-target').value; if (lane === 'no' || target === lane) return;
    snapshot(); pattern[target] = [...pattern[lane]]; pattern.fx[target] = { ...pattern.fx[lane] }; syncUI();
    flash(`${LANE_NAME[lane]} copied to ${LANE_NAME[target]} · Undo to restore`);
  });
  $('t-double').addEventListener('click', () => {
    if (pattern.steps >= 1024) return; snapshot();
    for (const l of LANES) pattern[l] = [...pattern[l], ...pattern[l]];
    pattern.steps *= 2; pattern.loop.end = pattern.steps / 16; syncUI();
  });
  function syncLoop() {
    for (const side of ['start', 'end']) {
      const select = $('loop-' + side); select.replaceChildren();
      for (let bar = 1; bar <= pattern.steps / 16; bar++) { const option = new Option(String(bar), String(bar)); select.add(option); }
      select.value = pattern.loop[side];
    }
    $('loop-toggle').setAttribute('aria-pressed', pattern.loop.enabled);
    syncView();
  }
  $('loop-toggle').addEventListener('click', () => { snapshot(); pattern.loop.enabled = !pattern.loop.enabled; if (seq.playing) { stop(); start(); } syncLoop(); });
  for (const side of ['start', 'end']) $('loop-' + side).addEventListener('change', () => {
    snapshot(); pattern.loop[side] = +$('loop-' + side).value;
    if (pattern.loop.start > pattern.loop.end) pattern.loop[side === 'start' ? 'end' : 'start'] = pattern.loop[side];
    if (seq.playing) { stop(); start(); } syncLoop();
  });
  $('toggle-inspector').addEventListener('click', () => {
    const hidden = !$('inspector').hidden; $('inspector').hidden = hidden;
    document.querySelector('.studio').classList.toggle('inspector-hidden', hidden);
    $('toggle-inspector').setAttribute('aria-expanded', !hidden);
  });
  const meterData = new Uint8Array(256);
  for (const l of LANES) {
    const strip = document.createElement('div'); strip.className = 'mixer-strip'; strip.style.setProperty('--voice', COLORS[l]);
    strip.innerHTML = `<h3>${LANE_NAME[l]}</h3><div class="meter" role="meter" aria-label="${LANE_NAME[l]} level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="meter-${l}"></i></div>
      <label for="mix-${l}-volume">Volume <output id="value-${l}-volume">100%</output></label><input id="mix-${l}-volume" type="range" min="0" max="100" value="100" aria-label="${LANE_NAME[l]} volume">
      <label for="mix-${l}-pan">Pan <output id="value-${l}-pan">C</output></label><input id="mix-${l}-pan" type="range" min="-100" max="100" value="0" aria-label="${LANE_NAME[l]} pan">
      <div class="mix-buttons"><button class="mini" id="mix-${l}-mute" type="button" aria-pressed="false" aria-label="Mute ${LANE_NAME[l]}">Mute</button><button class="mini" id="mix-${l}-solo" type="button" aria-pressed="false" aria-label="Solo ${LANE_NAME[l]}">Solo</button></div>`;
    $('mixer-strips').append(strip);
    for (const property of ['volume', 'pan']) $('mix-' + l + '-' + property).addEventListener('input', e => { pattern.mix[l][property] = +e.target.value / 100; syncMix(); });
    for (const property of ['mute', 'solo']) $('mix-' + l + '-' + property).addEventListener('click', () => { snapshot(); pattern.mix[l][property] = !pattern.mix[l][property]; syncMix(); });
  }
  function syncMix() {
    for (const l of LANES) {
      const m = pattern.mix[l];
      for (const k of ['volume', 'pan']) $('mix-' + l + '-' + k).value = Math.round(m[k] * 100);
      $('value-' + l + '-volume').textContent = `${Math.round(m.volume * 100)}%`;
      $('value-' + l + '-pan').textContent = m.pan === 0 ? 'C' : `${m.pan < 0 ? 'L' : 'R'} ${Math.round(Math.abs(m.pan) * 100)}`;
      for (const k of ['mute', 'solo']) $('mix-' + l + '-' + k).setAttribute('aria-pressed', m[k]);
    }
    $('mix-master').value = Math.round(pattern.master.volume * 100); $('mix-master-value').textContent = `${$('mix-master').value}%`;
    engine.setMix(pattern);
  }
  $('mix-master').addEventListener('input', e => { pattern.master.volume = +e.target.value / 100; syncMix(); });
  function drawMeters() {
    for (const l of LANES) {
      const analyser = engine.channelAnalyser(l); let peak = 0;
      if (analyser) { analyser.getByteTimeDomainData(meterData); for (const value of meterData) peak = Math.max(peak, Math.abs(value - 128) / 128); }
      const level = Math.min(1, peak), el = $('meter-' + l);
      if (el) { el.style.transform = `scaleX(${level})`; el.parentElement.setAttribute('aria-valuenow', Math.round(level * 100)); }
    }
    const step = seq.playing && audibleStep >= 0 ? audibleStep : 0;
    $('position').textContent = `${String(Math.floor(step / 16) + 1).padStart(2, '0')} : ${String(Math.floor(step % 16 / 4) + 1).padStart(2, '0')}`;
  }
  // Capture an edit before input handlers mutate state; group slider drags into one undo.
  const editable = '#bpm, #x-title, #g-chip, #fx-voice input, #fx-voice select, .fx-master input, .fx-master select, .mixer input, .export-body select, .export-body input';
  let activeControl = null, lastControlTime = 0;
  for (const event of ['input', 'change']) document.addEventListener(event, e => {
    if (!e.target.matches(editable)) return;
    if (activeControl !== e.target || Date.now() - lastControlTime > 700) snapshot();
    activeControl = e.target; lastControlTime = Date.now(); queueSave();
  }, true);
  document.addEventListener('pointerup', () => { activeControl = null; });
  document.addEventListener('focusout', () => { activeControl = null; });
  window.addEventListener('pagehide', saveDraft);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraft(); });

  // =============== MIDI import ===============
  async function importMidi(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = NeoMidi.parse(bytes);
      const { pattern: p, parts, drums: hasDrums, truncated } = NeoMidi.toPattern(parsed, { chip: pattern.chip });
      snapshot(); stop();
      pattern = normalize(p); seedUsed = 'import'; engineUsed = 'import';
      trackTitle = file.name.replace(/\.midi?$/i, '').slice(0, 60); xTitle.value = trackTitle;
      syncUI(); start();
      flash(`imported ${parts} part${parts === 1 ? '' : 's'}${hasDrums ? ' + drums' : ''}${truncated ? ' · first 16 bars' : ''} · ${parsed.bpm} bpm`);
    } catch (error) { flash(`Import failed: ${error.message}`); }
  }
  $('t-import').addEventListener('click', () => $('midi-file').click());
  $('midi-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importMidi(f); e.target.value = ''; });
  const dropZone = document.querySelector('.roll-wrap');
  for (const ev of ['dragenter', 'dragover']) dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  for (const ev of ['dragleave', 'drop']) dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
  dropZone.addEventListener('drop', (e) => { const f = [...e.dataTransfer.files].find((x) => /\.midi?$/i.test(x.name)); if (f) importMidi(f); else flash('Drop a .mid file'); });

  // =============== effects rack ===============
  // Dial drags preview live; the commit at the end of a drag is what enters history.
  let rackDirty = false;
  NeoFxUI.init({
    get: () => pattern.rack,
    probe: () => engine.rackProbe,
    bpm: () => pattern.bpm,
    preview: () => { rackDirty = true; if (seq.playing) engine.setRack(pattern.rack, { bpm: pattern.bpm }); },
    commit: () => {
      if (!rackDirty) snapshot();                       // a toggle or select, not the end of a drag
      rackDirty = false;
      engine.ensure(); engine.setRack(pattern.rack, { bpm: pattern.bpm });
      if (!seq.playing) engine.setMix(pattern);
      queueSave(); syncUI();
    },
  });

  // =============== export dialog ===============
  const dialog = $('export-dialog'), xFormat = $('x-format'), xRepeat = $('x-repeat');
  function syncExport() {
    const fmt = xFormat.value, audio = fmt !== 'midi';
    $('x-quality-field').hidden = fmt !== 'mp3';
    $('x-tail-field').hidden = !audio;
    $('x-repeat-field').hidden = !audio;
    $('x-go-label').textContent = `Export ${fmt.toUpperCase()}`;
    const bars = $('x-range').value === 'loop' && pattern.loop.enabled
      ? pattern.loop.end - pattern.loop.start + 1 : pattern.steps / 16;
    const reps = audio ? +xRepeat.value : 1;
    const secs = bars * 16 * 60 / pattern.bpm / 4 * reps;
    $('export-summary').innerHTML =
      `<b>${trackTitle || 'neojutsu-track'}</b><span>${NeoChip.CHIPS[pattern.chip].label} · ${bars} bar${bars === 1 ? '' : 's'}` +
      `${reps > 1 ? ` ×${reps}` : ''} · ${pattern.bpm} BPM · ${secs.toFixed(1)}s</span>`;
    $('x-note').textContent = fmt === 'midi'
      ? 'Notes, tempo and controllers only. Arpeggios and crush are not in MIDI; the receiving instrument makes the sound.'
      : 'Rendered through the same chip synth you hear, effects included.';
  }
  $('open-export').addEventListener('click', () => { syncExport(); dialog.showModal(); });
  for (const id of ['x-format', 'x-range', 'x-repeat']) $(id).addEventListener('change', syncExport);
  $('x-go').addEventListener('click', () => (xFormat.value === 'midi' ? exportMidi() : exportAudio(xFormat.value)));
  dialog.addEventListener('close', () => { $('export-progress').hidden = true; });

  // =============== audio export ===============
  let exporting = false, downloadURL;
  async function exportAudio(format) {
    if (exporting) return; exporting = true;
    const p = JSON.parse(JSON.stringify(pattern));
    const title = xTitle.value.trim().replace(/[^\w\- ]+/g, '') || 'neojutsu-track';
    const quality = +$('x-quality').value;
    if ($('x-range').value === 'loop') p.loop.enabled = true;
    const options = { selection: $('x-range').value === 'loop', tail: $('x-tail').checked };
    const reps = Math.max(1, +($('x-repeat')?.value || 1));
    if (reps > 1) {                                    // tile the chosen range, then render it whole
      const b = NeoChip.loopBounds(options.selection ? p : { ...p, loop: { enabled: false } });
      for (const l of LANES) { const slice = p[l].slice(b.start, b.end); p[l] = Array.from({ length: reps }, () => slice).flat(); }
      p.steps = (b.end - b.start) * reps; p.loop = { enabled: false, start: 1, end: p.steps / 16 };
      options.selection = false;
    }
    $('x-go').disabled = $('x-mp3').disabled = $('x-wav').disabled = true;
    $('export-progress').hidden = false; $('x-progress').value = 5; $('export-label').textContent = 'Rendering chip audio…';
    $('x-go-label').textContent = 'Rendering…';
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      const buffer = await NeoChip.render(p, options);
      $('export-label').textContent = `Encoding ${format.toUpperCase()}…`;
      const progress = value => { $('x-progress').value = 20 + value * 80; $('x-go-label').textContent = `Exporting ${Math.round(20 + value * 80)}%`; };
      const blob = format === 'mp3' ? await NeoExport.mp3(buffer, quality, progress) : NeoExport.wav(buffer);
      if (downloadURL) URL.revokeObjectURL(downloadURL);
      downloadURL = URL.createObjectURL(blob);
      const link = $('x-download'); link.href = downloadURL; link.download = `${title}.${format}`; link.textContent = `↓ Download ${format.toUpperCase()} again`; link.hidden = false; link.click();
      $('x-progress').value = 100; $('export-label').textContent = `${format.toUpperCase()} ready · ${(blob.size / 1024).toFixed(0)} KB`;
      flash(`${format.toUpperCase()} exported · ${buffer.duration.toFixed(1)}s`);
    } catch (error) { $('export-label').textContent = 'Export failed. Please try again.'; flash(error.message || 'Audio export failed.'); }
    finally { exporting = false; $('x-go').disabled = $('x-mp3').disabled = $('x-wav').disabled = false; syncExport(); }
  }
  $('x-mp3').addEventListener('click', () => exportAudio('mp3'));
  $('x-wav').addEventListener('click', () => exportAudio('wav'));

  // =============== boot ===============
  const shared = location.hash.startsWith('#p=') ? decode(location.hash.slice(3)) : null;
  let loaded = false;
  if (shared) { try { pattern = normalize(shared); seedUsed = 'shared'; loaded = true; } catch { flash('This share link is invalid.'); } }
  if (!loaded) {
    try { const draft = JSON.parse(localStorage.getItem(AUTOSAVE_KEY)); if (draft) { applySession(draft); loaded = restoredDraft = true; } } catch {}
  }
  if (!loaded) {
    gSeed.value = randomSeed(); seedUsed = gSeed.value;
    pattern = kataA({ seed: seedUsed, engine: 'kataA', chip: 'nes', mood: 'stage', key: 'A', scale: 'minor', bars: 4, bpm: 150 });
    rememberSeed(seedUsed);
  }
  renderSaved(); syncUI(); saveDraft(); animate();
  if (!loaded) { gEngine.value = AI_ENGINE; gEngine.dispatchEvent(new Event('change')); }
  if (restoredDraft) $('autosave-status').textContent = 'Restored your last session';
})();
