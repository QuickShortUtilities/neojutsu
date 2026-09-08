/* Video effects rack. Mirrors the Audio Studio's NeoRack shape: units declared
   in a SPEC, each with a kanji, an on/off and a few parameters - and, like the
   audio rack's motion, every parameter can be driven by an LFO or by the music
   itself instead of sitting at a fixed value. */
(() => {
  'use strict';

  const SHAPES = {
    off:    null,
    sine:   t => Math.sin(t * 6.283) * .5 + .5,
    tri:    t => 1 - Math.abs(((t % 1) * 2) - 1),
    square: t => ((t % 1) < .5 ? 1 : 0),
    ramp:   t => (t % 1),
    fall:   t => 1 - (t % 1),
    level:  null,   // follows overall loudness
    bass:   null,   // follows the low end
    treble: null,   // follows the high end
  };
  const SHAPE_LABELS = { off: 'Fixed', sine: 'Sine', tri: 'Triangle', square: 'Square',
                         ramp: 'Ramp up', fall: 'Ramp down', level: '♪ Level', bass: '♪ Bass', treble: '♪ Treble' };
  const RATES = [
    { id: '4', label: '4 bars', hz: 1 / 8 }, { id: '2', label: '2 bars', hz: 1 / 4 },
    { id: '1', label: '1 bar', hz: 1 / 2 }, { id: '1/2', label: '1/2', hz: 1 },
    { id: '1/4', label: '1/4', hz: 2 }, { id: '1/8', label: '1/8', hz: 4 },
  ];

  // amount is always 0..100 in the UI and 0..1 to the renderer.
  const SPEC = {
    glow:     { label: 'Glow', kanji: '光', out: 'bloom' },
    glitch:   { label: 'Glitch', kanji: '乱', out: 'glitch' },
    chroma:   { label: 'Colour split', kanji: '色', out: 'chroma' },
    vignette: { label: 'Vignette', kanji: '暗', out: 'vignette' },
    curve:    { label: 'Tube curve', kanji: '管', out: 'curve' },
    zoom:     { label: 'Zoom', kanji: '寄', out: 'zoom' },
    shake:    { label: 'Shake', kanji: '震', out: 'shake' },
  };
  const ORDER = Object.keys(SPEC);

  const unitDefaults = () => ({ on: false, amount: 40, shape: 'off', rate: '1', depth: 50 });
  const defaults = () => Object.fromEntries(ORDER.map(id => [id, unitDefaults()]));

  function normalize(state) {
    const out = defaults();
    if (state) for (const id of ORDER) if (state[id]) Object.assign(out[id], state[id]);
    return out;
  }

  // A unit's live value: its dial, then motion pushes it around. Music-driven
  // shapes read the same envelope the scenes get, so picture and sound move together.
  function value(unit, t, env) {
    const base = unit.amount / 100;
    if (unit.shape === 'off') return base;
    const depth = unit.depth / 100;
    let m;
    if (unit.shape === 'level') m = env.level;
    else if (unit.shape === 'bass') m = env.bass;
    else if (unit.shape === 'treble') m = env.treble;
    else {
      const hz = (RATES.find(r => r.id === unit.rate) || RATES[2]).hz;
      m = SHAPES[unit.shape](t * hz);
    }
    return Math.max(0, Math.min(1, base * (1 - depth) + m * depth));
  }

  // Flatten the rack into the plain object the renderer consumes.
  function evaluate(state, t, env) {
    const s = normalize(state);
    const fx = { bloom: 0, glitch: 0, chroma: 0, vignette: 0, curve: 0, zoom: 1, shakeX: 0, shakeY: 0 };
    for (const id of ORDER) {
      const u = s[id];
      if (!u.on) continue;
      const v = value(u, t, env);
      if (id === 'zoom') fx.zoom = 1 + v * 0.6;
      else if (id === 'shake') {
        const amp = v * 6;
        fx.shakeX = Math.round(Math.sin(t * 37.1) * amp);
        fx.shakeY = Math.round(Math.cos(t * 29.7) * amp);
      } else fx[SPEC[id].out] = v;
    }
    return fx;
  }

  // ---------- UI ----------
  function build(host, getState, onChange) {
    host.innerHTML = '';
    const state = normalize(getState());
    for (const id of ORDER) {
      const spec = SPEC[id], u = state[id];
      const card = document.createElement('div');
      card.className = 'vunit' + (u.on ? ' on' : '');

      const head = document.createElement('button');
      head.type = 'button'; head.className = 'vunit-head';
      head.innerHTML = `<span class="vunit-k">${spec.kanji}</span><span class="vunit-label">${spec.label}</span><span class="vunit-led"></span>`;
      head.addEventListener('click', () => { u.on = !u.on; onChange(state); build(host, () => state, onChange); });

      const body = document.createElement('div');
      body.className = 'vunit-body'; body.hidden = !u.on;

      const amount = document.createElement('label');
      amount.className = 'field range';
      amount.innerHTML = `<span>Amount <b>${u.amount}</b></span>`;
      const ar = document.createElement('input');
      ar.type = 'range'; ar.min = 0; ar.max = 100; ar.step = 1; ar.value = u.amount;
      ar.setAttribute('aria-label', `${spec.label} amount`);
      ar.addEventListener('input', () => { u.amount = +ar.value; amount.querySelector('b').textContent = ar.value; onChange(state); });
      amount.append(ar);

      const motion = document.createElement('label');
      motion.className = 'field';
      motion.innerHTML = '<span>Motion</span>';
      const ms = document.createElement('select');
      for (const [k, label] of Object.entries(SHAPE_LABELS)) {
        const o = document.createElement('option'); o.value = k; o.textContent = label; ms.append(o);
      }
      ms.value = u.shape;
      ms.addEventListener('change', () => { u.shape = ms.value; onChange(state); build(host, () => state, onChange); });
      motion.append(ms);

      body.append(amount, motion);

      if (u.shape !== 'off') {
        if (!['level','bass','treble'].includes(u.shape)) {
          const rate = document.createElement('label');
          rate.className = 'field'; rate.innerHTML = '<span>Rate</span>';
          const rs = document.createElement('select');
          for (const r of RATES) { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; rs.append(o); }
          rs.value = u.rate;
          rs.addEventListener('change', () => { u.rate = rs.value; onChange(state); });
          rate.append(rs); body.append(rate);
        }
        const depth = document.createElement('label');
        depth.className = 'field range';
        depth.innerHTML = `<span>Depth <b>${u.depth}</b></span>`;
        const ds = document.createElement('input');
        ds.type = 'range'; ds.min = 0; ds.max = 100; ds.step = 1; ds.value = u.depth;
        ds.setAttribute('aria-label', `${spec.label} motion depth`);
        ds.addEventListener('input', () => { u.depth = +ds.value; depth.querySelector('b').textContent = ds.value; onChange(state); });
        depth.append(ds); body.append(depth);
      }

      card.append(head, body); host.append(card);
    }
    window.NeoSelect?.refreshAll?.();
    return state;
  }

  window.NeoVRack = { SPEC, ORDER, SHAPES, SHAPE_LABELS, RATES, defaults, normalize, evaluate, value, build };
})();
