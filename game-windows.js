/* Panels that get out of the way.

   The left column had grown to carry describing a game, choosing a hero,
   five abilities, every tile, every entity, decor, colours, level size and
   undo - one narrow strip, most of it needed rarely. The Video Studio
   already solved this: a floating window you open when you want it and shut
   when you are done.

   Nothing here rebuilds those controls. The existing markup is moved into a
   window frame, so every id, listener and piece of state carries on exactly
   as it was - the panel changes address, not identity. */
(() => {
  'use strict';
  const KEY = 'neojutsu.game.windows.v1';
  const made = new Map();

  const remembered = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
  };
  const remember = (id, patch) => {
    try {
      const all = remembered();
      all[id] = { ...(all[id] || {}), ...patch };
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {}
  };

  // Keep a window on screen even if the browser it was placed in was wider.
  function place(el, x, y) {
    const w = el.offsetWidth || 320, h = 44;
    const nx = Math.max(6, Math.min(x, innerWidth - w - 6));
    const ny = Math.max(6, Math.min(y, innerHeight - h - 6));
    el.style.left = `${Math.round(nx)}px`;
    el.style.top = `${Math.round(ny)}px`;
    return { x: nx, y: ny };
  }

  let top = 40;
  const focus = el => { el.style.zIndex = String(++top); };

  function build(block, i) {
    const id = block.dataset.window;
    const label = block.dataset.label || id;
    const kanji = block.dataset.kanji || '';

    const el = document.createElement('section');
    el.className = 'fx-window game-window';
    el.dataset.window = id;
    el.hidden = true;
    el.innerHTML =
      `<header class="fx-title">
         <span class="fx-kanji">${kanji}</span>
         <h3>${label}</h3>
         <span></span>
         <button class="fx-close" type="button" aria-label="Close ${label}">✕</button>
       </header>
       <div class="game-window-body"></div>`;
    el.querySelector('.game-window-body').append(block);
    document.body.append(el);

    /* Open down the right-hand edge. Something has to be covered on a laptop,
       and the two things that must stay visible are the level you are drawing
       on and the column you opened this from. */
    const saved = remembered()[id] || {};
    const w = el.offsetWidth || 340;
    place(el, saved.x ?? (innerWidth - w - 20 - i * 18), saved.y ?? (104 + i * 26));

    const head = el.querySelector('.fx-title');
    let dragging = false, dx = 0, dy = 0;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true; focus(el);
      const r = el.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      e.preventDefault();
    });
    head.addEventListener('pointermove', e => {
      if (dragging) place(el, e.clientX - dx, e.clientY - dy);
    });
    for (const ev of ['pointerup', 'pointercancel']) head.addEventListener(ev, () => {
      if (!dragging) return;
      dragging = false; el.classList.remove('dragging');
      const r = el.getBoundingClientRect();
      remember(id, { x: r.left, y: r.top });
    });

    el.querySelector('.fx-close').addEventListener('click', () => api.close(id));
    el.addEventListener('pointerdown', () => focus(el));

    made.set(id, { el, label, kanji, open: !!saved.open, offered: true, wanted: false });
    return made.get(id);
  }

  const api = {
    open(id) {
      const w = made.get(id); if (!w) return;
      w.el.hidden = false; w.open = true; focus(w.el);
      remember(id, { open: true });
      sync();
    },
    close(id) {
      const w = made.get(id); if (!w) return;
      w.el.hidden = true; w.open = false;
      remember(id, { open: false });
      sync();
    },
    toggle(id) { const w = made.get(id); if (w) (w.open ? api.close : api.open)(id); },
    isOpen(id) { const w = made.get(id); return !!(w && w.open); },
    /* Whether this game has any use for a panel at all. A falling-block game
       has no hero to dress and no abilities to grant, and a window of
       controls that do nothing is worse than a missing one: it reads as a
       promise. Hiding is not the same as closing - a panel put away because
       the current game cannot use it comes back by itself when a game that
       can is loaded, so switching modes does not quietly lose the layout
       somebody set up. */
    offer(id, can) {
      const w = made.get(id); if (!w) return;
      const ok = can !== false;
      if (w.offered === ok) return;
      w.offered = ok;
      if (!ok && w.open) { w.el.hidden = true; w.open = false; w.wanted = true; }
      else if (ok && w.wanted) { w.wanted = false; api.open(id); }
      sync();
    },
    ids() { return [...made.keys()]; },
  };

  let bar = null;
  function sync() {
    if (!bar) return;
    for (const b of bar.querySelectorAll('[data-open]')) {
      const w = made.get(b.dataset.open);
      b.hidden = !!(w && w.offered === false);
      b.classList.toggle('on', api.isOpen(b.dataset.open));
      b.setAttribute('aria-pressed', api.isOpen(b.dataset.open) ? 'true' : 'false');
    }
  }

  function start() {
    const blocks = [...document.querySelectorAll('[data-window]')];
    if (!blocks.length) return;
    blocks.forEach(build);

    bar = document.getElementById('g-window-bar');
    if (bar) {
      for (const [id, w] of made) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'window-open'; b.dataset.open = id;
        b.innerHTML = `<span class="wk">${w.kanji}</span>${w.label}`;
        b.title = `Open ${w.label}`;
        b.addEventListener('click', () => api.toggle(id));
        bar.append(b);
      }
    }
    for (const [id, w] of made) if (w.open) api.open(id);
    sync();

    addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const openOnes = api.ids().filter(api.isOpen);
      if (openOnes.length) api.close(openOnes[openOnes.length - 1]);
    });
    addEventListener('resize', () => {
      for (const { el } of made.values()) {
        if (el.hidden) continue;
        const r = el.getBoundingClientRect();
        place(el, r.left, r.top);
      }
    });
  }

  window.NeoWindows = api;
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start);
  else start();
})();
