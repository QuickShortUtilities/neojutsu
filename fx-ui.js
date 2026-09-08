/* ============================================================
   NEO術 — effects rack UI
   One draggable window per effect, each themed like a device from
   the era. Dials are drag-to-turn; any dial marked automatable can
   be given motion (a tempo-synced LFO) from its own little panel.

   Window positions live in localStorage (a per-browser preference).
   Effect values live in the pattern, so they save, share and export.
   ============================================================ */
(() => {
  'use strict';

  const POS_KEY = 'neojutsu.fxwindows.v1';
  const SPEC = () => window.NeoRack.SPEC;

  let hooks = { get: () => ({}), commit: () => {}, preview: () => {} };
  const windows = new Map();
  let zTop = 40;

  // ---------------------------------------------------------------- dials
  function makeDial(fxId, key, spec, getValue, onInput, onCommit) {
    const wrap = document.createElement('div');
    wrap.className = 'dial';
    wrap.innerHTML = `
      <svg viewBox="0 0 64 64" class="dial-face" role="slider" tabindex="0"
           aria-label="${spec.label}" aria-valuemin="${spec.min}" aria-valuemax="${spec.max}">
        <circle class="dial-track" cx="32" cy="32" r="24"></circle>
        <path class="dial-arc" d=""></path>
        <line class="dial-pointer" x1="32" y1="32" x2="32" y2="12"></line>
        <circle class="dial-cap" cx="32" cy="32" r="7"></circle>
      </svg>
      <span class="dial-label">${spec.label}</span>
      <span class="dial-value"></span>`;

    const svg = wrap.querySelector('svg');
    const arc = wrap.querySelector('.dial-arc');
    const pointer = wrap.querySelector('.dial-pointer');
    const readout = wrap.querySelector('.dial-value');
    const A0 = -135, A1 = 135;                            // sweep, degrees

    const fmt = (v) => {
      const step = (spec.max - spec.min) > 40 ? 0 : (spec.max - spec.min) > 4 ? 1 : 2;
      const n = v >= 1000 && spec.unit === 'Hz' ? (v / 1000).toFixed(1) + 'k' : v.toFixed(step);
      return `${n}${spec.unit && spec.unit !== 'Hz' ? ' ' + spec.unit : spec.unit === 'Hz' ? ' Hz' : ''}`;
    };
    function render() {
      const v = getValue();
      const t = (v - spec.min) / (spec.max - spec.min);
      const angle = A0 + t * (A1 - A0);
      const rad = (angle - 90) * Math.PI / 180;
      pointer.setAttribute('x2', 32 + Math.cos(rad) * 20);
      pointer.setAttribute('y2', 32 + Math.sin(rad) * 20);
      const a0 = (A0 - 90) * Math.PI / 180;
      const large = angle - A0 > 180 ? 1 : 0;
      arc.setAttribute('d', `M ${32 + Math.cos(a0) * 24} ${32 + Math.sin(a0) * 24} A 24 24 0 ${large} 1 ${32 + Math.cos(rad) * 24} ${32 + Math.sin(rad) * 24}`);
      readout.textContent = fmt(v);
      svg.setAttribute('aria-valuenow', v.toFixed(2));
      svg.setAttribute('aria-valuetext', fmt(v));
    }

    let dragging = false, startY = 0, startVal = 0;
    svg.addEventListener('pointerdown', (e) => {
      dragging = true; startY = e.clientY; startVal = getValue();
      svg.setPointerCapture(e.pointerId); wrap.classList.add('turning'); e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const span = spec.max - spec.min;
      const perPixel = span / (e.shiftKey ? 600 : 180);       // shift = fine
      const v = Math.max(spec.min, Math.min(spec.max, startVal + (startY - e.clientY) * perPixel));
      onInput(v); render();
    });
    const end = () => { if (!dragging) return; dragging = false; wrap.classList.remove('turning'); onCommit(); };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { onInput(spec.def); onCommit(); render(); });
    svg.addEventListener('keydown', (e) => {
      const span = spec.max - spec.min, stepSize = e.shiftKey ? span / 200 : span / 40;
      let v = getValue();
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v += stepSize;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v -= stepSize;
      else if (e.key === 'Home') v = spec.min; else if (e.key === 'End') v = spec.max;
      else return;
      e.preventDefault();
      onInput(Math.max(spec.min, Math.min(spec.max, v))); onCommit(); render();
    });

    wrap.render = render;
    render();
    return wrap;
  }

  // ---------------------------------------------------------------- motion
  function makeMotion(fxId, key, spec) {
    const box = document.createElement('div');
    box.className = 'motion';
    const R = window.NeoRack.RATES, S = window.NeoRack.SHAPES;
    box.innerHTML = `
      <button class="motion-toggle mini" type="button" aria-pressed="false" title="Motion: sweep this dial in time with the track">◠ Motion</button>
      <div class="motion-body" hidden>
        <label>Shape <select class="m-shape">${Object.entries(S).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>Every <select class="m-bars">${Object.entries(R).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>Depth <input class="m-depth" type="range" min="0" max="100" value="50"></label>
      </div>`;
    const toggle = box.querySelector('.motion-toggle');
    const body = box.querySelector('.motion-body');
    const shape = box.querySelector('.m-shape'), bars = box.querySelector('.m-bars'), depth = box.querySelector('.m-depth');

    const read = () => (hooks.get()[fxId]?.motion || {})[key] || null;
    function write(m) {
      const state = hooks.get();
      const fx = state[fxId]; fx.motion = fx.motion || {};
      if (m) fx.motion[key] = m; else delete fx.motion[key];
      hooks.commit();
      sync();
    }
    function sync() {
      const m = read();
      toggle.setAttribute('aria-pressed', !!m);
      toggle.classList.toggle('on', !!m);
      body.hidden = !m;
      if (m) { shape.value = m.shape; bars.value = String(m.bars); depth.value = Math.round(m.depth * 100); }
      box.closest('.dial-cell')?.classList.toggle('has-motion', !!m);
    }
    toggle.addEventListener('click', () => write(read() ? null : { shape: 'sine', bars: 1, depth: 0.5 }));
    for (const el of [shape, bars, depth]) el.addEventListener('input', () => {
      write({ shape: shape.value, bars: +bars.value, depth: +depth.value / 100 });
    });
    box.sync = sync;
    sync();
    return box;
  }

  // ---------------------------------------------------------------- windows
  function loadPositions() { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch { return {}; } }
  function savePosition(id, pos) {
    const all = loadPositions(); all[id] = pos;
    try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch {}
  }

  function buildWindow(id) {
    const spec = SPEC()[id];
    const el = document.createElement('section');
    el.className = `fx-window theme-${spec.theme}`;
    el.dataset.fx = id;
    el.hidden = true;
    el.innerHTML = `
      <header class="fx-title">
        <span class="fx-kanji">${spec.kanji}</span>
        <h3>${spec.label}</h3>
        <button class="fx-power" type="button" aria-pressed="false" aria-label="Turn ${spec.label} on"><span class="led"></span>ON</button>
        <button class="fx-close mini" type="button" aria-label="Close ${spec.label}">✕</button>
      </header>
      <p class="fx-blurb">${spec.blurb}</p>
      <div class="fx-dials"></div>`;

    const dials = el.querySelector('.fx-dials');
    const cells = [];
    if (spec.divisions) {
      const cell = document.createElement('div');
      cell.className = 'dial-cell wide';
      cell.innerHTML = `<label class="fx-select">Time
        <select class="fx-div">${Object.entries(spec.divisions).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`;
      const sel = cell.querySelector('.fx-div');
      sel.addEventListener('change', () => { hooks.get()[id].div = sel.value; hooks.commit(); });
      cell.sync = () => { sel.value = hooks.get()[id].div; };
      dials.append(cell); cells.push(cell);
    }
    for (const [key, p] of Object.entries(spec.params)) {
      const cell = document.createElement('div');
      cell.className = 'dial-cell';
      const dial = makeDial(id, key, p,
        () => hooks.get()[id][key],
        (v) => { hooks.get()[id][key] = v; hooks.preview(); },
        () => hooks.commit());
      cell.append(dial);
      let motion = null;
      if (p.auto) { motion = makeMotion(id, key, p); cell.append(motion); }
      cell.sync = () => { dial.render(); motion && motion.sync(); };
      dials.append(cell); cells.push(cell);
    }

    const power = el.querySelector('.fx-power');
    power.addEventListener('click', () => {
      const fx = hooks.get()[id]; fx.on = !fx.on; hooks.commit(); syncOne(id);
    });
    el.querySelector('.fx-close').addEventListener('click', () => toggleWindow(id, false));

    // drag by the title bar
    const header = el.querySelector('.fx-title');
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; focusWindow(el);
      const r = el.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      header.setPointerCapture(e.pointerId); el.classList.add('dragging');
    });
    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      place(el, e.clientX - dx, e.clientY - dy);
    });
    const drop = () => {
      if (!dragging) return; dragging = false; el.classList.remove('dragging');
      savePosition(id, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    };
    header.addEventListener('pointerup', drop);
    header.addEventListener('pointercancel', drop);
    el.addEventListener('pointerdown', () => focusWindow(el));

    document.body.append(el);
    windows.set(id, { el, cells });
    return windows.get(id);
  }

  function place(el, x, y) {
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, x)) + 'px';
    el.style.top = Math.max(56, Math.min(window.innerHeight - 46, y)) + 'px';
  }
  function focusWindow(el) { el.style.zIndex = ++zTop; }

  function toggleWindow(id, show) {
    const win = windows.get(id) || buildWindow(id);
    const open = show ?? win.el.hidden;
    win.el.hidden = !open;
    if (open) {
      const saved = loadPositions()[id];
      const n = [...windows.values()].filter((w) => !w.el.hidden).length;
      place(win.el, saved?.x ?? (120 + n * 26), saved?.y ?? (110 + n * 22));
      focusWindow(win.el);
      syncOne(id);
    }
    document.querySelector(`.rack-btn[data-fx="${id}"]`)?.setAttribute('aria-expanded', String(open));
  }

  function syncOne(id) {
    const win = windows.get(id); if (!win) return;
    const fx = hooks.get()[id]; if (!fx) return;
    const power = win.el.querySelector('.fx-power');
    power.setAttribute('aria-pressed', String(fx.on));
    power.classList.toggle('on', fx.on);
    win.el.classList.toggle('off', !fx.on);
    win.cells.forEach((c) => c.sync());
    const btn = document.querySelector(`.rack-btn[data-fx="${id}"]`);
    if (btn) btn.classList.toggle('lit', fx.on);
  }
  function syncAll() { for (const id of windows.keys()) syncOne(id); buildDock(); }

  // ---------------------------------------------------------------- dock
  let dockBuilt = false;
  function buildDock() {
    const dock = document.getElementById('fx-dock'); if (!dock) return;
    if (!dockBuilt) {
      dock.replaceChildren();
      for (const id of window.NeoRack.ORDER) {
        const spec = SPEC()[id];
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'rack-btn'; b.dataset.fx = id;
        b.setAttribute('aria-expanded', 'false');
        b.innerHTML = `<span class="rack-kanji">${spec.kanji}</span><span class="rack-name">${spec.label}</span><span class="rack-led"></span>`;
        b.addEventListener('click', () => toggleWindow(id));
        dock.append(b);
      }
      dockBuilt = true;
    }
    const state = hooks.get();
    for (const btn of dock.querySelectorAll('.rack-btn')) {
      btn.classList.toggle('lit', !!state[btn.dataset.fx]?.on);
    }
  }

  function init(options) {
    hooks = Object.assign(hooks, options);
    buildDock();
    window.addEventListener('resize', () => {
      for (const { el } of windows.values()) if (!el.hidden) place(el, parseFloat(el.style.left), parseFloat(el.style.top));
    });
  }

  window.NeoFxUI = { init, sync: syncAll, open: (id) => toggleWindow(id, true), closeAll: () => windows.forEach((w, id) => toggleWindow(id, false)) };
})();
