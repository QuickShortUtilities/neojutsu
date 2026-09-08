/* Plugin windows for the video rack. Reuses the Audio Studio's fx-window and
   dial markup and CSS, so the two racks are the same desk: drag by the title
   bar, power LED in the header, dials with a value readout, and a motion strip
   that can hand any parameter to an LFO or to the music. */
(() => {
  'use strict';
  const POS_KEY = 'neojutsu.vfxwindows.v1';
  const R = () => window.NeoVRack;
  const windows = new Map();
  let host = null, getState = null, onChange = null, dockEl = null, current = null;

  const positions = () => { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch { return {}; } };
  function savePosition(id, pos) {
    try { const all = positions(); all[id] = pos; localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch {}
  }

  function place(el, x, y) {
    const w = el.offsetWidth || 380, h = el.offsetHeight || 320;
    el.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, innerHeight - 60))}px`;
  }

  function buildWindow(id) {
    const spec = R().SPEC[id];
    const el = document.createElement('section');
    el.className = `fx-window theme-${spec.theme}`;
    el.dataset.vfx = id; el.hidden = true;
    el.innerHTML = `
      <header class="fx-title">
        <span class="fx-kanji">${spec.kanji}</span>
        <h3>${spec.label}</h3>
        <button class="fx-power" type="button" aria-pressed="false" aria-label="Turn ${spec.label} on"><span class="led"></span>ON</button>
        <button class="fx-close" type="button" aria-label="Close ${spec.label}">✕</button>
      </header>
      <p class="fx-blurb">${spec.blurb}</p>
      <div class="fx-dials"></div>
      <div class="vfx-motion">
        <label class="field"><span>Motion on</span><select class="m-param"></select></label>
        <label class="field"><span>Shape</span><select class="m-shape"></select></label>
        <label class="field m-rate-wrap"><span>Rate</span><select class="m-rate"></select></label>
        <label class="field range m-depth-wrap"><span>Depth <b>50</b></span><input type="range" class="m-depth" min="0" max="100" step="1" value="50"></label>
      </div>`;

    const state = () => R().normalize(getState())[id];
    const dials = el.querySelector('.fx-dials');
    const cells = {};
    for (const [key, p] of Object.entries(spec.params)) {
      const cell = document.createElement('div');
      cell.className = 'dial-cell';
      const dial = R().makeDial(p, () => getState()[id].params[key], v => {
        getState()[id].params[key] = v; onChange();
      });
      cell.append(dial); dials.append(cell);
      cells[key] = { cell, dial };
    }

    const mParam = el.querySelector('.m-param'), mShape = el.querySelector('.m-shape');
    const mRate = el.querySelector('.m-rate'), mDepth = el.querySelector('.m-depth');
    for (const [key, p] of Object.entries(spec.params)) {
      const o = document.createElement('option'); o.value = key; o.textContent = p.label; mParam.append(o);
    }
    for (const [k, label] of Object.entries(R().SHAPE_LABELS)) {
      const o = document.createElement('option'); o.value = k; o.textContent = label; mShape.append(o);
    }
    for (const r of R().RATES) { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; mRate.append(o); }

    function syncMotion() {
      const u = getState()[id], key = mParam.value;
      const m = u.motion[key] || { shape: 'off', rate: '1', depth: 50 };
      mShape.value = m.shape || 'off'; mRate.value = m.rate || '1'; mDepth.value = m.depth ?? 50;
      el.querySelector('.m-depth-wrap b').textContent = mDepth.value;
      const fixed = !m.shape || m.shape === 'off';
      const musical = ['level','bass','treble'].includes(m.shape);
      el.querySelector('.m-rate-wrap').hidden = fixed || musical;
      el.querySelector('.m-depth-wrap').hidden = fixed;
      for (const [k, c] of Object.entries(cells)) {
        const mk = u.motion[k];
        c.cell.classList.toggle('has-motion', !!(mk && mk.shape && mk.shape !== 'off'));
      }
      window.NeoSelect?.refreshAll?.();
    }
    function writeMotion() {
      const u = getState()[id], key = mParam.value;
      if (mShape.value === 'off') delete u.motion[key];
      else u.motion[key] = { shape: mShape.value, rate: mRate.value, depth: +mDepth.value };
      onChange(); syncMotion();
    }
    mParam.addEventListener('change', syncMotion);
    mShape.addEventListener('change', writeMotion);
    mRate.addEventListener('change', writeMotion);
    mDepth.addEventListener('input', () => { el.querySelector('.m-depth-wrap b').textContent = mDepth.value; writeMotion(); });

    const power = el.querySelector('.fx-power');
    power.addEventListener('click', () => {
      const u = getState()[id]; u.on = !u.on; onChange(); syncOne(id); buildDock();
    });
    el.querySelector('.fx-close').addEventListener('click', () => toggleWindow(id, false));

    // drag by the title bar
    const title = el.querySelector('.fx-title');
    let dragging = false, ox = 0, oy = 0;
    title.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true; el.classList.add('dragging');
      const r = el.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
      title.setPointerCapture(e.pointerId); e.preventDefault();
    });
    title.addEventListener('pointermove', e => { if (dragging) place(el, e.clientX - ox, e.clientY - oy); });
    const end = () => {
      if (!dragging) return;
      dragging = false; el.classList.remove('dragging');
      savePosition(id, { x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) });
    };
    title.addEventListener('pointerup', end); title.addEventListener('pointercancel', end);

    document.body.append(el);
    windows.set(id, { el, cells, syncMotion });
    syncMotion();
    return windows.get(id);
  }

  function syncOne(id) {
    const w = windows.get(id); if (!w) return;
    const u = R().normalize(getState())[id];
    const power = w.el.querySelector('.fx-power');
    power.classList.toggle('on', u.on);
    power.setAttribute('aria-pressed', String(u.on));
    w.el.classList.toggle('off', !u.on);
    for (const c of Object.values(w.cells)) c.dial.render();
  }

  function toggleWindow(id, show) {
    const w = windows.get(id) || buildWindow(id);
    if (show) {
      const saved = positions()[id];
      const n = [...windows.values()].filter(x => !x.el.hidden).length;
      w.el.hidden = false;
      place(w.el, saved ? saved.x : 120 + n * 26, saved ? saved.y : 110 + n * 26);
      current = id;
      syncOne(id);
    } else {
      w.el.hidden = true;
      if (current === id) current = null;
    }
    buildDock();
  }

  // The chip grid doubles as the dock: it shows what is on and opens the window.
  function buildDock() {
    if (!dockEl) return;
    const state = R().normalize(getState());
    dockEl.innerHTML = '';
    for (const id of R().ORDER) {
      const spec = R().SPEC[id], u = state[id];
      const open = windows.has(id) && !windows.get(id).el.hidden;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'vchip' + (u.on ? ' on' : '') + (open ? ' current' : '');
      chip.dataset.vfx = id;
      chip.title = `${spec.label} — ${spec.blurb}`;
      chip.innerHTML = `<span class="vchip-k">${spec.kanji}</span><span class="vchip-label">${spec.label}</span>`;
      chip.addEventListener('click', () => toggleWindow(id, !(windows.has(id) && !windows.get(id).el.hidden)));
      dockEl.append(chip);
    }
  }

  function init(dock, get, change) {
    dockEl = dock; getState = get; onChange = change;
    buildDock();
  }
  const closeAll = () => { for (const id of windows.keys()) toggleWindow(id, false); };

  window.NeoVRackUI = { init, toggleWindow, buildDock, syncOne, closeAll };
})();
