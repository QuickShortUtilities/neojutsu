/* Game Studio.
 *
 * The engine runs the game; this file is the desk around it - pick a starter,
 * draw on the level, choose a hero and hardware, score it from the Audio
 * Studio, and keep it. Built games are JSON, so a whole game travels in a link.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const KEY = 'neojutsu.game.v1';
  const SAVED_KEY = 'neojutsu.saved';
  const DRAFT_KEY = 'neojutsu.draft.v1';
  const T = window.NeoGame.TILE;

  const SKIES = {
    day:   ['#1b2a5c', '#7fc4e8'],
    dusk:  ['#241844', '#c9598a'],
    night: ['#05040f', '#1b2a5c'],
    cave:  ['#0d0a16', '#241a30'],
  };

  const PIECES = [
    { id: 0, name: 'Erase' }, { id: 1, name: 'Ground' }, { id: 2, name: 'Stone' },
    { id: 3, name: 'Ledge' }, { id: 7, name: 'Brick' }, { id: 4, name: 'Spikes' },
    { id: 6, name: 'Water' }, { id: 5, name: 'Ladder' },
  ];
  const PLACEABLE = ['coin', 'heart', 'key', 'walker', 'flyer', 'goal'];

  let game = null, spec = null, brush = { kind: 'tile', id: 1 }, painting = false;
  let audio = null, gain = null, music = null, buffer = null, savedTracks = [];

  const low = document.createElement('canvas');
  const lctx = low.getContext('2d', { willReadFrequently: true });
  const display = $('g-canvas'), dctx = display.getContext('2d');

  const cfg = () => ({
    chip: $('g-chip').value,
    dither: $('g-dither').value,
    dithAmt: 0.6,
    zoom: +$('g-zoom').value,
    sky: $('g-sky').value,
    char: $('g-char').value,
    lives: +$('g-lives').value,
    goal: +$('g-goal').value,
    audioSrc: $('g-audio-src').value,
    vol: +$('g-vol').value / 100,
    title: $('g-title').value,
    edit: $('g-edit').checked,
    grid: $('g-grid').checked,
  });

  // ---------- presentation ----------
  // The engine draws at hardware resolution; the palette snap and the blow-up
  // happen here, so a game frame goes through the same pipe as a video frame.
  function present() {
    const c = cfg();
    if (c.grid && c.edit && game) drawGrid();
    window.NeoPalette.snap(lctx, low.width, low.height, { chip: c.chip, dither: c.dither, dithAmt: c.dithAmt });
    dctx.imageSmoothingEnabled = false;
    dctx.drawImage(low, 0, 0, display.width, display.height);
  }

  function drawGrid() {
    const v = game.view;
    lctx.strokeStyle = 'rgba(255,255,255,.10)';
    lctx.lineWidth = 1;
    const ox = Math.round(v.x) % T, oy = Math.round(v.y) % T;
    for (let x = -ox; x < low.width; x += T) { lctx.beginPath(); lctx.moveTo(x + .5, 0); lctx.lineTo(x + .5, low.height); lctx.stroke(); }
    for (let y = -oy; y < low.height; y += T) { lctx.beginPath(); lctx.moveTo(0, y + .5); lctx.lineTo(low.width, y + .5); lctx.stroke(); }
  }

  function sizeCanvas() {
    const c = cfg();
    const [w, h] = window.NeoPalette.PALETTES[c.chip].size;
    low.width = w; low.height = h;
    display.width = w * c.zoom; display.height = h * c.zoom;
    display.style.width = `${w * c.zoom}px`;
    $('g-badge').textContent = `out: 型 ${window.NeoPalette.PALETTES[c.chip].label.split(' · ')[0]}`;
  }

  // ---------- the game ----------
  function build(from) {
    const c = cfg();
    if (game) game.stop();
    spec = JSON.parse(JSON.stringify(from));
    spec.player = { ...(spec.player || {}), char: c.char };
    spec.lives = c.lives;
    spec.rules = { ...(spec.rules || {}), collect: c.goal || 0 };
    [spec.sky0, spec.sky1] = SKIES[c.sky] || SKIES.day;
    sizeCanvas();
    game = window.NeoGame.create(low, spec, { onFrame: () => { present(); readout(); } });
    present(); readout(); meta();
  }

  function readout() {
    if (!game) return;
    const s = game.state;
    $('g-readout').textContent = s === 'won' ? 'CLEAR'
      : s === 'over' ? 'GAME OVER'
      : `${game.score}/${spec.rules.collect || '—'}  ♥${game.lives}`;
  }
  function meta() {
    if (!game) return;
    const l = game.level;
    $('g-meta').textContent = `${l.w}×${l.h} tiles · ${game.entities.length} pieces · ${spec.mode}`;
    $('g-help').textContent = spec.mode === 'platform'
      ? 'Arrows or WASD to move · Z / Space to jump'
      : 'Arrows or WASD to move in any direction';
  }

  function setPlaying(on) {
    $('g-play').setAttribute('aria-pressed', String(on));
    $('g-play-icon').textContent = on ? '❚❚' : '▶';
    $('g-play-label').textContent = on ? 'Pause' : 'Play';
    display.classList.toggle('building', !on && cfg().edit);
  }
  function play() {
    if (!game) return;
    if (game.state !== 'play') game.reset();
    game.start(); setPlaying(true); startMusic();
    display.focus();
  }
  function pause() { if (game) game.stop(); setPlaying(false); stopMusic(); present(); }
  const toggle = () => ($('g-play').getAttribute('aria-pressed') === 'true' ? pause() : play());

  // ---------- input ----------
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    Space: 'a', KeyZ: 'a', KeyJ: 'a', KeyX: 'b', KeyK: 'b',
  };
  function wireInput() {
    addEventListener('keydown', e => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      const k = KEYMAP[e.code];
      if (k) { e.preventDefault(); if (game) game.input[k] = true; }
      if (e.code === 'Space' && !k) { e.preventDefault(); toggle(); }
      if (e.code === 'KeyR') { if (game) { game.reset(); present(); readout(); } }
    });
    addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k && game) game.input[k] = false; });
    for (const btn of $('g-pad').querySelectorAll('button')) {
      const k = btn.dataset.key;
      const set = on => { if (game) game.input[k] = on; btn.classList.toggle('on', on); };
      btn.addEventListener('pointerdown', e => { e.preventDefault(); set(true); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => set(false));
    }
  }

  // ---------- building ----------
  function tileAtEvent(e) {
    const r = display.getBoundingClientRect();
    const c = cfg();
    const x = (e.clientX - r.left) * (display.width / r.width) / c.zoom + game.view.x;
    const y = (e.clientY - r.top) * (display.height / r.height) / c.zoom + game.view.y;
    return { x, y, tx: Math.floor(x / T), ty: Math.floor(y / T) };
  }
  function paint(e, erase) {
    if (!game || !cfg().edit) return;
    const p = tileAtEvent(e);
    if (brush.kind === 'tile') game.setTile(p.tx, p.ty, erase ? 0 : brush.id);
    else if (erase) game.removeEntityAt(p.x, p.y);
    else if (!game.removeEntityAt(p.x, p.y)) game.addEntity({ type: brush.id, x: p.tx * T, y: p.ty * T, dir: 1 });
    present(); meta(); save();
  }
  function wireBuild() {
    display.addEventListener('pointerdown', e => {
      if (!cfg().edit) return;
      e.preventDefault(); painting = true; display.setPointerCapture(e.pointerId);
      paint(e, e.button === 2 || brush.id === 0);
    });
    display.addEventListener('pointermove', e => { if (painting) paint(e, e.buttons === 2 || brush.id === 0); });
    for (const ev of ['pointerup', 'pointercancel']) display.addEventListener(ev, () => { painting = false; });
    display.addEventListener('contextmenu', e => { if (cfg().edit) e.preventDefault(); });
  }

  // A piece button previews the actual tile or entity, drawn by the engine's
  // own colours rather than a guessed swatch.
  function pieceButton(label, paintFn, on) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tilebtn'; b.title = label;
    const c = document.createElement('canvas'); c.width = 20; c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = '#0b0913'; x.fillRect(0, 0, 20, 16);
    paintFn(x);
    const s = document.createElement('span'); s.textContent = label;
    b.append(c, s);
    b.addEventListener('click', on);
    return b;
  }
  function buildPalette() {
    const tiles = $('g-tiles'); tiles.innerHTML = '';
    for (const p of PIECES) {
      const info = window.NeoGame.TILES[p.id] || {};
      const btn = pieceButton(p.name, x => {
        if (!info.fill) { x.strokeStyle = '#4b4368'; x.beginPath(); x.moveTo(4,4); x.lineTo(16,12); x.moveTo(16,4); x.lineTo(4,12); x.stroke(); return; }
        x.fillStyle = info.fill; x.fillRect(2, 4, 16, 10);
        if (info.top) { x.fillStyle = info.top; x.fillRect(2, 4, 16, 3); }
      }, () => { brush = { kind: 'tile', id: p.id }; markCurrent(); });
      btn.dataset.piece = `tile:${p.id}`;
      tiles.append(btn);
    }
    const ents = $('g-entities'); ents.innerHTML = '';
    for (const type of PLACEABLE) {
      const def = window.NeoGame.ENTITY[type];
      const btn = pieceButton(type, x => {
        x.fillStyle = def.goal ? '#3fbf4a' : def.enemy ? '#ff5a3c' : def.key ? '#2ef2ff' : def.heal ? '#ff2e88' : '#ffd23f';
        x.fillRect(6, 4, Math.min(10, def.w), Math.min(10, def.h));
      }, () => { brush = { kind: 'entity', id: type }; markCurrent(); });
      btn.dataset.piece = `entity:${type}`;
      ents.append(btn);
    }
    markCurrent();
  }
  function markCurrent() {
    const want = `${brush.kind}:${brush.id}`;
    for (const b of document.querySelectorAll('.tilebtn')) b.classList.toggle('current', b.dataset.piece === want);
  }

  // ---------- audio ----------
  function actx() {
    if (!audio) {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      gain = audio.createGain(); gain.connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  function stopMusic() { if (music) { try { music.stop(); } catch {} music.disconnect(); music = null; } }
  async function loadMusic() {
    stopMusic(); buffer = null;
    const c = cfg();
    if (c.audioSrc === 'none') return;
    const track = savedTracks.find(t => t.id === c.audioSrc);
    if (!track) return;
    try { buffer = await window.NeoChip.render(track.pattern, { tail: false }); } catch {}
  }
  function startMusic() {
    const c = cfg();
    if (!buffer) return;
    const ac = actx(); gain.gain.value = c.vol;
    stopMusic();
    music = ac.createBufferSource();
    music.buffer = buffer; music.loop = true; music.connect(gain); music.start();
  }
  function readTracks() {
    const out = [];
    try {
      const list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
      if (Array.isArray(list)) list.forEach((t, i) => {
        if (t && t.pattern && typeof t.name === 'string') out.push({ id: `saved:${i}`, name: t.name, pattern: t.pattern });
      });
    } catch {}
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (d && d.pattern) out.push({ id: 'draft', name: `${d.title || 'Current draft'} · unsaved`, pattern: d.pattern });
    } catch {}
    return out;
  }
  function fillTracks() {
    savedTracks = readTracks();
    const sel = $('g-audio-src'), keep = sel.value;
    sel.innerHTML = '<option value="none">Silent</option>';
    for (const t of savedTracks) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.append(o); }
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'none';
    $('g-audio-note').textContent = savedTracks.length
      ? `${savedTracks.length} track${savedTracks.length > 1 ? 's' : ''} found in this browser.`
      : 'No tracks yet. Make one in the Audio Studio and it will appear here.';
    window.NeoSelect?.refreshAll?.();
  }

  // ---------- saving ----------
  function projectData() {
    return { spec: game ? game.snapshot() : spec, look: cfg() };
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(projectData()));
      $('g-autosave').textContent = 'Autosaved on this browser';
    } catch { $('g-autosave').textContent = 'Autosave unavailable'; }
  }
  function restore() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    if (d && d.look) {
      const set = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = v; };
      set('g-chip', d.look.chip); set('g-dither', d.look.dither); set('g-zoom', d.look.zoom);
      set('g-sky', d.look.sky); set('g-char', d.look.char); set('g-lives', d.look.lives);
      set('g-goal', d.look.goal); set('g-vol', Math.round((d.look.vol ?? .7) * 100));
      set('g-title', d.look.title);
      if ($('g-edit')) $('g-edit').checked = d.look.edit !== false;
      if ($('g-grid')) $('g-grid').checked = d.look.grid !== false;
    }
    return d && d.spec ? d.spec : null;
  }

  // ---------- cloud ----------
  let cloudId = null;
  function cloudStatus(m) { const el = $('g-cloud-status'); if (el) el.textContent = m; }
  async function refreshCloud() {
    if (!window.NeoCloud || !window.NeoCloud.user) return;
    const host = $('g-cloud-list'); host.innerHTML = '';
    let items = [];
    try { items = await window.NeoCloud.list('game'); } catch { cloudStatus('Could not reach your games.'); return; }
    cloudStatus(items.length ? `${items.length} game${items.length === 1 ? '' : 's'} in your account.` : 'No saved games yet.');
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'cloud-item' + (it.id === cloudId ? ' current' : '');
      row.innerHTML = `<span class="name"></span><span class="when"></span>`;
      row.querySelector('.name').textContent = it.title;
      row.querySelector('.when').textContent = new Date(it.updated_at).toLocaleDateString();
      row.addEventListener('click', async () => {
        try {
          const p = await window.NeoCloud.load(it.id);
          cloudId = p.id;
          if (p.data && p.data.spec) { build(p.data.spec); save(); refreshCloud(); }
        } catch { cloudStatus('Could not open that game.'); }
      });
      host.append(row);
    }
  }
  async function cloudSave(asNew) {
    if (!window.NeoCloud || !window.NeoCloud.user) return;
    cloudStatus('Saving…');
    try {
      const r = await window.NeoCloud.save({ id: asNew ? undefined : cloudId || undefined, kind: 'game',
        title: $('g-title').value.trim() || 'Untitled game', data: projectData() });
      cloudId = r.id; cloudStatus(`Saved "${r.title}".`); refreshCloud();
    } catch (e) { cloudStatus(e && e.message ? e.message : 'Could not save.'); }
  }
  async function cloudShare() {
    if (!cloudId) { cloudStatus('Save the game first.'); return; }
    try {
      const r = await window.NeoCloud.setPublic(cloudId, true);
      const link = `${location.origin}/game.html?p=${cloudId}`;
      try { await navigator.clipboard.writeText(link); cloudStatus(`Link copied — ${link}`); }
      catch { cloudStatus(`Playable at ${link}`); }
      return r;
    } catch { cloudStatus('Could not share that game.'); }
  }

  // ---------- wiring ----------
  function init() {
    const tsel = $('g-template');
    for (const [key, t] of Object.entries(window.NeoGameTemplates)) {
      const o = document.createElement('option'); o.value = key; o.textContent = `${t.kanji} ${t.name}`; tsel.append(o);
    }
    const csel = $('g-char');
    for (const key of Object.keys(window.NeoScene.CHARS)) {
      const o = document.createElement('option'); o.value = key; o.textContent = key[0].toUpperCase() + key.slice(1); csel.append(o);
    }

    const saved = restore();
    fillTracks();
    build(saved || window.NeoGameTemplates[tsel.value]);
    buildPalette(); wireInput(); wireBuild();
    window.NeoSelect?.refreshAll?.();

    $('g-play').addEventListener('click', toggle);
    $('g-reset').addEventListener('click', () => { game.reset(); present(); readout(); });
    $('g-template').addEventListener('change', () => {
      const t = window.NeoGameTemplates[$('g-template').value];
      if (t) { build(t); save(); }
    });
    for (const id of ['g-chip', 'g-dither', 'g-zoom', 'g-sky']) $(id).addEventListener('input', () => {
      $('g-zoom-v').textContent = $('g-zoom').value;
      sizeCanvas(); present(); save();
    });
    for (const id of ['g-char', 'g-lives', 'g-goal']) $(id).addEventListener('change', () => {
      build(game ? game.snapshot() : spec); save();
    });
    for (const id of ['g-edit', 'g-grid']) $(id).addEventListener('change', () => {
      display.classList.toggle('building', cfg().edit);
      present(); save();
    });
    $('g-title').addEventListener('input', save);
    $('g-vol').addEventListener('input', () => { $('g-vol-v').textContent = $('g-vol').value; if (gain) gain.gain.value = cfg().vol; save(); });
    $('g-audio-src').addEventListener('change', async () => { await loadMusic(); save(); });
    $('g-audio-refresh').addEventListener('click', fillTracks);
    $('g-toggle-inspector').addEventListener('click', () => {
      const open = $('g-inspector').hasAttribute('hidden');
      open ? $('g-inspector').removeAttribute('hidden') : $('g-inspector').setAttribute('hidden', '');
      $('g-toggle-inspector').setAttribute('aria-expanded', String(open));
    });
    $('g-open-share').addEventListener('click', cloudShare);
    $('g-cloud-save').addEventListener('click', () => cloudSave(false));
    $('g-cloud-new').addEventListener('click', () => cloudSave(true));
    $('g-cloud-share').addEventListener('click', cloudShare);

    if (window.NeoCloud) {
      window.NeoCloud.onChange((u, ok) => {
        $('g-cloud').hidden = !(ok && u);
        if (ok && u) { cloudStatus('Signed in. Your games follow you between browsers.'); refreshCloud(); }
        else if (ok) cloudStatus('Sign in to keep your games and share them by link.');
        else cloudStatus('Saved on this browser only.');
      });
      const shared = new URLSearchParams(location.search).get('p');
      if (shared) window.NeoCloud.load(shared).then(p => {
        if (p.data && p.data.spec) { cloudId = p.id; build(p.data.spec); $('g-edit').checked = false; play(); }
      }).catch(() => {});
    }
    display.tabIndex = 0;
    display.classList.toggle('building', cfg().edit);
    $('g-zoom-v').textContent = $('g-zoom').value;
  }
  // A handle on the running game, so it can be driven by tests and, later, by
  // the Automation Studio.
  window.NeoGameStudio = {
    get game() { return game; },
    get spec() { return spec; },
    present, build, play, pause,
    set brush(b) { brush = b; markCurrent(); },
    get brush() { return brush; },
  };

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
