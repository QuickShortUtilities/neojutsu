/* ============================================================
   NEO術 — voice presets
   Characteristic voicings from the chip era, grouped by hardware family.

   These are built from the documented behaviour of the sound hardware and
   the habits of the trackers that drove it: pulse duty cycles, the 60 Hz
   arpeggio trick that faked chords on a one-note channel, FM operator
   ratios, filter sweeps, delayed vibrato. They are our own settings for
   our own synth, not copies of anyone's sound driver, and the codenames
   are ours too.

   A preset sets the voice's instrument and effects. It does not touch the
   chip, the mixer or the pattern, so any preset works on any hardware.
   ============================================================ */
(() => {
  'use strict';

  // fx: inst, env, vib, trem, slide, arp, echo   (echo/vib/trem are 0..1)
  const V = (name, blurb, fx) => ({ name, blurb, fx });

  const GROUPS = [
    {
      id: 'n3s', label: 'N3S · pulse & triangle',
      note: 'Two pulse channels and a triangle bass, the classic 8-bit voice.',
      presets: {
        'n3s-01': V('N3S-01 Thin Lead', 'The narrow 12.5% pulse that cuts through everything.',
          { inst: 'pulse12', env: 'hold', vib: 0.18, trem: 0, slide: false, arp: null, echo: 0 }),
        'n3s-02': V('N3S-02 Square Lead', 'Full 50% square. Rounder, sits under a thin lead.',
          { inst: 'pulse50', env: 'hold', vib: 0.12, trem: 0, slide: false, arp: null, echo: 0 }),
        'n3s-03': V('N3S-03 Arp Chord', 'One channel faking a chord by cycling intervals every frame.',
          { inst: 'pulse25', env: 'pluck', vib: 0, trem: 0, slide: false, arp: 'min', echo: 0.1 }),
        'n3s-04': V('N3S-04 Triangle Bass', 'The unshaped triangle that carried every bass line.',
          { inst: 'tri', env: 'hold', vib: 0, trem: 0, slide: false, arp: null, echo: 0 }),
        'n3s-05': V('N3S-05 Echo Lead', 'Thin pulse thrown into the delay for depth the chip never had.',
          { inst: 'pulse12', env: 'hold', vib: 0.3, trem: 0, slide: false, arp: null, echo: 0.45 }),
        'n3s-06': V('N3S-06 Stab', 'Very short 25% pulse. Percussive, good on off-beats.',
          { inst: 'pulse25', env: 'stab', vib: 0, trem: 0, slide: false, arp: null, echo: 0.15 }),
      },
    },
    {
      id: 'gb', label: 'GB01 · handheld',
      note: 'Two pulses plus a four-bit wavetable, quieter and grainier.',
      presets: {
        'gb-01': V('GB01-01 Wave Bass', 'The four-bit wave channel: coarse, woody, unmistakable.',
          { inst: 'wave', env: 'hold', vib: 0, trem: 0, slide: false, arp: null, echo: 0 }),
        'gb-02': V('GB01-02 Duty Lead', 'A 25% pulse with a glide, the handheld lead sound.',
          { inst: 'pulse25', env: 'hold', vib: 0.35, trem: 0, slide: true, arp: null, echo: 0.12 }),
        'gb-03': V('GB01-03 Wave Pad', 'Wavetable held long with a slow tremble.',
          { inst: 'wave', env: 'pad', vib: 0, trem: 0.4, slide: false, arp: null, echo: 0.3 }),
        'gb-04': V('GB01-04 Blip Arp', 'Tiny 12.5% blips running an octave arpeggio.',
          { inst: 'pulse12', env: 'stab', vib: 0, trem: 0, slide: false, arp: 'oct', echo: 0.2 }),
      },
    },
    {
      id: 'supa', label: 'SUPA · 16-bit',
      note: 'Softer, sampled-sounding voices with more body.',
      presets: {
        'supa-01': V('SUPA-01 Soft Bell', 'A bell that decays into the room.',
          { inst: 'fmbell', env: 'pluck', vib: 0.1, trem: 0, slide: false, arp: null, echo: 0.35 }),
        'supa-02': V('SUPA-02 Warm Pad', 'Organ-ish sustain that fills the space behind the lead.',
          { inst: 'fmorgan', env: 'pad', vib: 0.15, trem: 0.25, slide: false, arp: null, echo: 0.25 }),
        'supa-03': V('SUPA-03 Slap Bass', 'Round FM bass with a hint of room behind it.',
          { inst: 'fmbass', env: 'pluck', vib: 0.08, trem: 0, slide: false, arp: null, echo: 0.12 }),
        'supa-04': V('SUPA-04 Glass Lead', 'Bright and clean, with a wide vibrato on long notes.',
          { inst: 'fmbell', env: 'hold', vib: 0.45, trem: 0, slide: false, arp: null, echo: 0.2 }),
      },
    },
    {
      id: 'saga', label: 'SAGA · FM',
      note: 'Frequency modulation: metallic, punchy, the arcade end of the era.',
      presets: {
        'saga-01': V('SAGA-01 FM Lead', 'Sliding, vibrato-heavy lead. The signature FM voice.',
          { inst: 'fmlead', env: 'hold', vib: 0.5, trem: 0, slide: true, arp: null, echo: 0.3 }),
        'saga-02': V('SAGA-02 FM Bass', 'Bone dry and tight, gliding between notes.',
          { inst: 'fmbass', env: 'pluck', vib: 0, trem: 0, slide: true, arp: null, echo: 0 }),
        'saga-03': V('SAGA-03 Brass Stab', 'Short, hard, brassy. Good for hits on the beat.',
          { inst: 'fmlead', env: 'stab', vib: 0, trem: 0, slide: false, arp: null, echo: 0.18 }),
        'saga-04': V('SAGA-04 Church Organ', 'Held organ with a slow beat in the level.',
          { inst: 'fmorgan', env: 'hold', vib: 0, trem: 0.35, slide: false, arp: null, echo: 0.15 }),
        'saga-05': V('SAGA-05 Power Arp', 'Fifths cycling at frame rate over an FM lead.',
          { inst: 'fmlead', env: 'pluck', vib: 0, trem: 0, slide: false, arp: 'pow', echo: 0.25 }),
      },
    },
    {
      id: 'sidx', label: 'SIDX · filtered',
      note: 'Sawtooth through a resonant filter, plus the fast arpeggios it was known for.',
      presets: {
        'sidx-01': V('SIDX-01 Saw Lead', 'Filtered saw with a sweep on every note.',
          { inst: 'saw', env: 'hold', vib: 0.28, trem: 0, slide: false, arp: null, echo: 0.2 }),
        'sidx-02': V('SIDX-02 Pulse Bass', 'Narrow pulse, plucked, sitting low.',
          { inst: 'pulse25', env: 'pluck', vib: 0, trem: 0, slide: false, arp: null, echo: 0 }),
        'sidx-03': V('SIDX-03 Arp Machine', 'Minor arpeggio at frame rate, short and relentless.',
          { inst: 'pulse12', env: 'stab', vib: 0, trem: 0, slide: false, arp: 'min', echo: 0.3 }),
        'sidx-04': V('SIDX-04 Wide Saw', 'Saw held long with a deep tremble.',
          { inst: 'saw', env: 'pad', vib: 0.2, trem: 0.3, slide: false, arp: null, echo: 0.35 }),
      },
    },
  ];

  const ALL = {};
  for (const g of GROUPS) for (const [id, p] of Object.entries(g.presets)) ALL[id] = { ...p, group: g.id };

  const KEYS = ['inst', 'env', 'vib', 'trem', 'slide', 'arp', 'echo'];

  // Write a preset onto a voice's fx object. Anything not part of a voicing
  // (duty, which only applies without an instrument) is cleared.
  function apply(fx, id) {
    const p = ALL[id]; if (!p) return false;
    Object.assign(fx, p.fx);
    fx.duty = null;
    return true;
  }

  // Which preset, if any, the current settings match. Used to show "Custom".
  function match(fx) {
    if (!fx) return '';
    const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.005;
    for (const [id, p] of Object.entries(ALL)) {
      const ok = KEYS.every((k) => (k === 'vib' || k === 'trem' || k === 'echo')
        ? near(fx[k], p.fx[k])
        : (fx[k] || null) === (p.fx[k] || null));
      if (ok) return id;
    }
    return '';
  }

  window.NeoPresets = { GROUPS, ALL, apply, match, count: Object.keys(ALL).length };
})();
