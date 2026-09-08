/* Video effects rack. Same shape as the Audio Studio's NeoRack: units declared
   in a SPEC, opened as draggable plugin windows with dials, a power LED and a
   live screen - reusing the audio rack's markup and CSS so the two studios feel
   like one desk. Any parameter can be driven by an LFO or by the music. */
(() => {
  'use strict';
  const P = (label, min, max, def, unit = '') => ({ label, min, max, def, unit });

  const SPEC = {
    glow:     { label: 'Glow', kanji: '光', theme: 'reverb', screen: 'curve',
                blurb: 'Bright areas bleed. Threshold picks what counts as bright.',
                params: { amount: P('Amount', 0, 100, 40), threshold: P('Threshold', 0, 100, 62),
                          radius: P('Radius', 1, 6, 2), warmth: P('Warmth', -100, 100, 0) } },
    glitch:   { label: 'Glitch', kanji: '乱', theme: 'crush', screen: 'bars',
                blurb: 'Torn scanline slices. Hold sets how long a tear survives.',
                params: { amount: P('Amount', 0, 100, 40), height: P('Slice', 1, 40, 12, '%'),
                          shift: P('Shift', 0, 100, 35, '%'), hold: P('Hold', 1, 24, 8, '/s'),
                          tear: P('Colour tear', 0, 100, 0) } },
    chroma:   { label: 'Colour split', kanji: '色', theme: 'phaser', screen: 'curve',
                blurb: 'Red and blue pull apart along an angle.',
                params: { amount: P('Amount', 0, 100, 30), angle: P('Angle', 0, 360, 0, '°') } },
    vignette: { label: 'Vignette', kanji: '暗', theme: 'comp', screen: 'curve',
                blurb: 'Darkens toward the edge. Shape bends it from round to square.',
                params: { amount: P('Amount', 0, 100, 45), softness: P('Softness', 1, 100, 50),
                          shape: P('Shape', 0, 100, 0) } },
    curve:    { label: 'Tube curve', kanji: '管', theme: 'flanger', screen: 'curve',
                blurb: 'Bows the picture like a tube, and darkens the corners with it.',
                params: { amount: P('Curve', 0, 100, 35), edge: P('Corner', 0, 100, 40) } },
    zoom:     { label: 'Zoom', kanji: '寄', theme: 'echo', screen: 'bars',
                blurb: 'Pushes in about a point. Put it on motion for a breathing shot.',
                params: { amount: P('Amount', 0, 100, 20), cx: P('Centre X', -50, 50, 0, '%'),
                          cy: P('Centre Y', -50, 50, 0, '%') } },
    shake:    { label: 'Shake', kanji: '震', theme: 'crush', screen: 'bars',
                blurb: 'Camera knock. Put it on ♪ Bass to shake on the kick.',
                params: { amount: P('Amount', 0, 100, 30), speed: P('Speed', 1, 100, 40),
                          axis: P('Axis', 0, 2, 0) } },
    trails:   { label: 'Trails', kanji: '残', theme: 'echo', screen: 'curve',
                blurb: 'Each frame keeps a ghost of the last one.',
                params: { amount: P('Feedback', 0, 100, 50), decay: P('Decay', 0, 100, 40) } },
    mirror:   { label: 'Mirror', kanji: '鏡', theme: 'width', screen: 'curve',
                blurb: 'Folds the frame back on itself. Mode picks the axis.',
                params: { mode: P('Mode', 0, 3, 1), offset: P('Offset', -50, 50, 0, '%') } },
  };
  const ORDER = Object.keys(SPEC);

  const SHAPES = {
    sine: t => Math.sin(t * 6.283) * .5 + .5,
    tri: t => 1 - Math.abs(((t % 1) * 2) - 1),
    square: t => ((t % 1) < .5 ? 1 : 0),
    ramp: t => (t % 1),
    fall: t => 1 - (t % 1),
  };
  const SHAPE_LABELS = { off: 'Fixed', sine: 'Sine', tri: 'Triangle', square: 'Square',
                         ramp: 'Ramp up', fall: 'Ramp down', level: '♪ Level', bass: '♪ Bass', treble: '♪ Treble' };
  const RATES = [
    { id: '4', label: '4 bars', hz: 1 / 8 }, { id: '2', label: '2 bars', hz: 1 / 4 },
    { id: '1', label: '1 bar', hz: 1 / 2 }, { id: '1/2', label: '1/2', hz: 1 },
    { id: '1/4', label: '1/4', hz: 2 }, { id: '1/8', label: '1/8', hz: 4 },
  ];

  const unitDefaults = id => ({
    on: false,
    params: Object.fromEntries(Object.entries(SPEC[id].params).map(([k, p]) => [k, p.def])),
    motion: {},
  });
  const defaults = () => Object.fromEntries(ORDER.map(id => [id, unitDefaults(id)]));

  function normalize(state) {
    const out = defaults();
    if (!state) return out;
    for (const id of ORDER) {
      const src = state[id]; if (!src) continue;
      out[id].on = !!src.on;
      if (src.params) for (const k of Object.keys(SPEC[id].params)) {
        if (typeof src.params[k] === 'number') out[id].params[k] = src.params[k];
      }
      if (src.motion) out[id].motion = { ...src.motion };
    }
    return out;
  }

  // A parameter's live value: the dial, then motion moves it between its own
  // value and the far end of its range.
  function paramValue(id, key, unit, t, env) {
    const spec = SPEC[id].params[key], base = unit.params[key];
    const m = unit.motion && unit.motion[key];
    if (!m || !m.shape || m.shape === 'off') return base;
    let f;
    if (m.shape === 'level') f = env.level || 0;
    else if (m.shape === 'bass') f = env.bass || 0;
    else if (m.shape === 'treble') f = env.treble || 0;
    else f = (SHAPES[m.shape] || SHAPES.sine)(t * ((RATES.find(r => r.id === m.rate) || RATES[2]).hz));
    const depth = (m.depth ?? 50) / 100;
    return base + (spec.max - base) * f * depth;
  }

  function evaluate(state, t, env) {
    const s = normalize(state), e = env || {};
    const fx = { glow: null, glitch: null, chroma: null, vignette: null, curve: null,
                 zoom: null, shake: null, trails: null, mirror: null };
    for (const id of ORDER) {
      const u = s[id];
      if (!u.on) continue;
      const v = {};
      for (const key of Object.keys(SPEC[id].params)) v[key] = paramValue(id, key, u, t, e);
      fx[id] = v;
    }
    return fx;
  }

  // ---------- plugin windows ----------
  const SEGMENTS = 14;
  const norm = (p, v) => (v - p.min) / (p.max - p.min);
  const denorm = (p, t) => p.min + Math.max(0, Math.min(1, t)) * (p.max - p.min);
  const fmt = (p, v) => (p.max - p.min <= 4 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(0));

  function makeDial(p, getValue, onInput) {
    const wrap = document.createElement('div');
    wrap.className = 'dial';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64'); svg.setAttribute('class', 'dial-face');
    svg.setAttribute('role', 'slider'); svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', p.label);
    svg.setAttribute('aria-valuemin', p.min); svg.setAttribute('aria-valuemax', p.max);
    const A0 = -125, A1 = 125, segs = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const r = document.createElementNS(ns, 'rect');
      const a = A0 + (i / (SEGMENTS - 1)) * (A1 - A0);
      r.setAttribute('x', 30.5); r.setAttribute('y', 4);
      r.setAttribute('width', 3); r.setAttribute('height', 8);
      r.setAttribute('transform', `rotate(${a} 32 32)`);
      r.setAttribute('class', 'dial-seg');
      svg.append(r); segs.push(r);
    }
    const body = document.createElementNS(ns, 'rect');
    body.setAttribute('x', 18); body.setAttribute('y', 18);
    body.setAttribute('width', 28); body.setAttribute('height', 28); body.setAttribute('class', 'dial-body');
    const nib = document.createElementNS(ns, 'rect');
    nib.setAttribute('class', 'dial-nib');
    nib.setAttribute('x', 30); nib.setAttribute('y', 20); nib.setAttribute('width', 4); nib.setAttribute('height', 11);
    svg.append(body, nib);
    const label = document.createElement('span'); label.className = 'dial-label'; label.textContent = p.label;
    const readout = document.createElement('span'); readout.className = 'dial-value';
    wrap.append(svg, label, readout);

    function render() {
      const v = getValue(), t = norm(p, v), lit = Math.round(t * (SEGMENTS - 1));
      segs.forEach((r, i) => r.classList.toggle('on', i <= lit));
      nib.setAttribute('transform', `rotate(${A0 + t * (A1 - A0)} 32 32)`);
      readout.textContent = fmt(p, v) + (p.unit || '');
      svg.setAttribute('aria-valuenow', v.toFixed(2));
    }
    let dragging = false, startY = 0, startT = 0;
    svg.addEventListener('pointerdown', e => {
      dragging = true; startY = e.clientY; startT = norm(p, getValue());
      svg.setPointerCapture(e.pointerId); wrap.classList.add('turning'); e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (!dragging) return;
      const travel = e.shiftKey ? 600 : 170;
      onInput(denorm(p, startT + (startY - e.clientY) / travel)); render();
    });
    const end = () => { if (!dragging) return; dragging = false; wrap.classList.remove('turning'); };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { onInput(p.def); render(); });
    svg.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.005 : 0.04;
      let t = norm(p, getValue());
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') t += step;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') t -= step;
      else if (e.key === 'Home') t = 0; else if (e.key === 'End') t = 1;
      else return;
      e.preventDefault(); onInput(denorm(p, t)); render();
    });
    wrap.render = render; render();
    return wrap;
  }

  // Shared motion maths, so layer automation and plugin automation behave
  // identically instead of drifting apart.
  function motionValue(m, base, min, max, t, env) {
    if (!m || !m.shape || m.shape === 'off') return base;
    let f;
    if (m.shape === 'level') f = (env && env.level) || 0;
    else if (m.shape === 'bass') f = (env && env.bass) || 0;
    else if (m.shape === 'treble') f = (env && env.treble) || 0;
    else f = (SHAPES[m.shape] || SHAPES.sine)(t * ((RATES.find(r => r.id === m.rate) || RATES[2]).hz));
    const depth = (m.depth ?? 50) / 100;
    return base + (max - base) * f * depth;
  }

  window.NeoVRack = { SPEC, ORDER, SHAPES, SHAPE_LABELS, RATES, defaults, normalize, evaluate, makeDial, norm, denorm, motionValue };
})();
