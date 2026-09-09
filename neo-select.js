/* ============================================================
   NEO術 — pixel form controls
   The browser's native <select> menu is drawn by the operating
   system and ignores the theme. This replaces the visible part
   with our own listbox while keeping the real <select> in the
   DOM, so every existing script, form behaviour and test that
   reads .value, sets it, or rebuilds .options keeps working.

   Range inputs get a --fill custom property so the filled part of
   the track can be drawn, and any control added later is picked up
   automatically.
   ============================================================ */
(() => {
  'use strict';

  let openOne = null;

  function labelOf(select) {
    const o = select.selectedOptions[0];
    return o ? o.textContent.trim() : '';
  }

  function enhance(select) {
    if (select.dataset.neo) return;
    select.dataset.neo = '1';

    // the native control stays for scripts and forms, but is no longer the
    // thing a person sees or focuses, so keep it out of the tab order
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');

    const wrap = document.createElement('div');
    wrap.className = 'neo-select';
    select.parentNode.insertBefore(wrap, select);
    wrap.append(select);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'neo-select-btn';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const aria = select.getAttribute('aria-label');
    if (aria) button.setAttribute('aria-label', aria);
    button.innerHTML = '<span class="neo-select-value"></span>' +
      '<svg class="neo-select-caret" viewBox="0 0 12 8" aria-hidden="true">' +
      '<path d="M1 1h2v2H1zM3 3h2v2H3zM5 5h2v2H5zM7 3h2v2H7zM9 1h2v2H9z"/></svg>';
    wrap.append(button);

    const menu = document.createElement('div');
    menu.className = 'neo-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    // A modal <dialog> makes the rest of the page inert, so a menu for a select
    // inside one has to live in the dialog to stay clickable.
    (select.closest('dialog') || document.body).append(menu);

    const state = { select, button, menu, wrap, items: [] };
    select.neoSelect = state;

    // ---- keep the button label in step with the real select
    const refresh = () => {
      const label = labelOf(select);
      button.querySelector('.neo-select-value').textContent = label;
      // These sit in a 200px sidebar, so a long option is going to be cut.
      // The full text stays reachable rather than simply lost.
      button.title = label;
      button.disabled = select.disabled;
      wrap.classList.toggle('is-disabled', select.disabled);
      if (!menu.hidden) buildMenu();
    };
    state.refresh = refresh;
    select.addEventListener('change', refresh);
    new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    // ---- menu
    function buildMenu() {
      menu.replaceChildren();
      state.items = [];
      // state.items is indexed by option, matching select.options, while
      // optgroup headings are rendered between them as plain labels.
      const addOption = (opt) => {
        const i = [...select.options].indexOf(opt);
        const item = document.createElement('div');
        item.className = 'neo-option';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(i === select.selectedIndex));
        item.textContent = opt.textContent;
        if (opt.title) item.title = opt.title;
        if (opt.disabled) { item.classList.add('is-disabled'); item.setAttribute('aria-disabled', 'true'); }
        if (i === select.selectedIndex) item.classList.add('is-selected');
        item.addEventListener('click', () => { if (!opt.disabled) choose(i); });
        item.addEventListener('pointerenter', () => highlight(i));
        menu.append(item);
        state.items[i] = item;
      };
      for (const node of select.children) {
        if (node.tagName === 'OPTGROUP') {
          const head = document.createElement('div');
          head.className = 'neo-group';
          head.setAttribute('role', 'presentation');
          head.textContent = node.label;
          menu.append(head);
          [...node.children].forEach(addOption);
        } else if (node.tagName === 'OPTION') {
          addOption(node);
        }
      }
    }
    let active = -1;
    function highlight(i) {
      if (i < 0 || i >= state.items.length || !state.items[i]) return;
      state.items.forEach((el, n) => el && el.classList.toggle('is-active', n === i));
      active = i;
      state.items[i].scrollIntoView({ block: 'nearest' });
    }
    function choose(i) {
      if (select.options[i] && select.options[i].disabled) return;
      select.selectedIndex = i;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      close(); refresh(); button.focus();
    }

    function position() {
      const r = button.getBoundingClientRect();
      menu.style.minWidth = r.width + 'px';
      menu.style.left = Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r.left)) + 'px';
      const below = window.innerHeight - r.bottom;
      const h = menu.offsetHeight;
      if (below < h + 12 && r.top > below) { menu.style.top = Math.max(6, r.top - h - 4) + 'px'; }
      else { menu.style.top = (r.bottom + 4) + 'px'; }
    }
    function open() {
      if (select.disabled) return;
      if (openOne && openOne !== state) openOne.close();
      buildMenu();
      menu.hidden = false;
      menu.style.zIndex = 9000;
      position();
      button.setAttribute('aria-expanded', 'true');
      wrap.classList.add('is-open');
      highlight(select.selectedIndex);
      openOne = state;
    }
    function close() {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('is-open');
      if (openOne === state) openOne = null;
    }
    state.close = close;

    button.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
    button.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); }
    });
    menu.addEventListener('keydown', (e) => e.stopPropagation());
    document.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); button.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Home') { e.preventDefault(); highlight(0); }
      else if (e.key === 'End') { e.preventDefault(); highlight(state.items.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
      else if (e.key.length === 1) {
        const from = active + 1, n = select.options.length;
        for (let k = 0; k < n; k++) {
          const i = (from + k) % n;
          if (select.options[i].textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) { highlight(i); break; }
        }
      }
    });
    function step(d) {
      let i = active;
      for (let k = 0; k < state.items.length; k++) {
        i = (i + d + state.items.length) % state.items.length;
        if (!select.options[i].disabled) break;
      }
      highlight(i);
    }

    refresh();
  }

  // ------------------------------------------------------------ sliders
  // CSS cannot know a range's value, so the filled portion is drawn from
  // a custom property kept in step here.
  function paintRange(input) {
    const min = +input.min || 0, max = +input.max || 100;
    const t = max === min ? 0 : (+input.value - min) / (max - min);
    input.style.setProperty('--fill', (t * 100).toFixed(2) + '%');
  }
  function enhanceRange(input) {
    if (input.dataset.neo) return;
    input.dataset.neo = '1';
    input.classList.add('neo-range');
    const paint = () => paintRange(input);
    input.addEventListener('input', paint);
    input.addEventListener('change', paint);
    new MutationObserver(paint).observe(input, { attributes: true, attributeFilter: ['value', 'min', 'max'] });
    paint();
  }

  const enhanceAll = (root = document) => {
    root.querySelectorAll('select:not([data-neo])').forEach(enhance);
    root.querySelectorAll('input[type=range]:not([data-neo])').forEach(enhanceRange);
  };
  const refreshAll = (root = document) => {
    root.querySelectorAll('select[data-neo]').forEach((s) => s.neoSelect && s.neoSelect.refresh());
    root.querySelectorAll('input[type=range][data-neo]').forEach(paintRange);
  };

  // close on outside click, scroll or resize
  document.addEventListener('click', () => openOne && openOne.close());
  window.addEventListener('resize', () => openOne && openOne.close());
  window.addEventListener('scroll', () => openOne && openOne.close(), true);

  function start() {
    enhanceAll();
    // selects created later (rack windows, rebuilt loop bars) get picked up too
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('select:not([data-neo])')) enhance(node);
          if (node.matches?.('input[type=range]:not([data-neo])')) enhanceRange(node);
          node.querySelectorAll?.('select:not([data-neo])').forEach(enhance);
          node.querySelectorAll?.('input[type=range]:not([data-neo])').forEach(enhanceRange);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();

  window.NeoSelect = { enhance, enhanceRange, enhanceAll, refreshAll };
})();
