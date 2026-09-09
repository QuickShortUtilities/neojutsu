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
  /* The colours a game arrived with, when they are not one of the four above.
     Without somewhere to keep them, build() replaced every generated and
     every authored sky with whichever preset the dropdown happened to be
     showing - so a falling-block game meant to sit on a flat dark ground was
     handed a dusk gradient and its well disappeared into it. */
  let ownSky = null;

  // Every tile and piece the engine knows, in the order they are most used.
  const PIECES = [0, 1, 2, 3, 7, 15, 4, 14, 6, 5, 8, 9, 10, 11, 12, 13, 18, 16, 17];
  /* Dots and pellets earn their place here: a maze game is built out of them
     the way a platformer is built out of coins, and leaving them out of the
     palette meant the one genre you could not draw by hand was the one the
     generator had just learned to make. */
  const PLACEABLE = ['coin', 'gem', 'heart', 'key', 'goal', 'dot', 'pellet',
                     'walker', 'flyer', 'chaser', 'jumper', 'turret', 'hunter', 'ghost', 'invader', 'rival', 'spike', 'mover'];

  let game = null, spec = null, brush = { kind: 'tile', id: 1 }, painting = false;
  // Decor colour. Scenery is tinted at draw time rather than baked, so the
  // same drawing can be a green tree or a dead one.
  const TINTS = ['#6f6890', '#3fbf4a', '#c08a4a', '#2ef2ff', '#ffd23f', '#ff2e88', '#c060ff', '#ece8f5'];
  let decorTint = TINTS[0], decorCat = 'handy', decorOpen = false;
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
    doubleJump: $('g-double').checked,
    wallJump: $('g-wall').checked,
    dash: $('g-dash').checked,
    attack: $('g-attack').checked,
    aimLock: $('g-aimlock').checked,
    coop: $('g-coop').checked,
    intro: { scene: $('g-intro').value, secs: +$('g-intro-secs').value, text: $('g-intro-text').value.trim() },
    outro: { scene: $('g-outro').value, secs: +$('g-outro-secs').value, text: $('g-outro-text').value.trim() },
    dir: +$('g-dir').value,
    sfx: $('g-sfx').checked,
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
    // One shape for every game, whichever palette is on: a handheld frame,
    // never a phone crop or a widescreen one. The chip picks colours only.
    const [w, h] = window.NeoPalette.GAME_FRAME;
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
    spec.player.doubleJump = c.doubleJump;
    spec.player.wallJump = c.wallJump;
    spec.player.dash = c.dash;
    spec.player.attack = c.attack;
    spec.coop = c.coop;
    if (spec.script === undefined) spec.script = '';
    /* A game whose ending is not a pickup count keeps the rules it came
       with: the dropdown is showing that ending, not choosing one. */
    if (String($('g-goal').value) !== 'own') {
      spec.rules = { ...(spec.rules || {}), collect: c.goal || 0 };
    }
    [spec.sky0, spec.sky1] = (c.sky === 'own' && ownSky) ? ownSky : (SKIES[c.sky] || SKIES.day);
    sizeCanvas();
    game = window.NeoGame.create(low, spec, {
      onFrame: () => { present(); readout(); pumpScriptLog(); },
      onEvent: name => { if (cfg().sfx && window.NeoSfx) window.NeoSfx.play(name); },
    });
    if ($('g-script')) { $('g-script').value = spec.script || ''; showScriptState({ errors: [] }); }
    buildStory(); drawHero();
    present(); readout(); meta(); showTags();
  }

  function readout() {
    if (!game) return;
    const s = game.state;
    $('g-readout').textContent = s === 'won' ? 'CLEAR'
      : s === 'over' ? 'GAME OVER'
      : `${game.score}/${spec.rules.collect || '—'}  ♥${game.lives}`;
  }
  /* What is named in this level, so somebody writing a script knows what
     they can say. Without this the actor half of the language is a list of
     words in the reference with nothing in the game to point them at. */
  function showTags() {
    const el = $('g-tags');
    if (!el || !game) return;
    const seen = new Map();
    for (const e of game.entities) if (e.tag) seen.set(e.tag, (seen.get(e.tag) || 0) + 1);
    el.textContent = seen.size
      ? 'Named: ' + [...seen].map(([t, n]) => n > 1 ? `"${t}" ×${n}` : `"${t}"`).join(' · ')
      : 'Nothing is named yet.';
  }

  function meta() {
    if (!game) return;
    const l = game.level;
    const v = game.view;
    const at = game.freeCam ? ` · at ${Math.round(v.x / T)},${Math.round(v.y / T)}` : '';
    $('g-meta').textContent = `${l.w}×${l.h} tiles · ${game.entities.length} pieces · ${spec.mode}${at}`;
    /* Say what the keys actually do in this game. A top-down shooter whose
       help line only mentions moving leaves the gun undiscovered. */
    const p = spec.player || {};
    /* The keys, for the game in front of you. A falling-block game and a
       battle screen have nothing to do with jumping, and saying so is the
       difference between a player who can play and one who cannot. */
    if (spec.mode === 'blocks') {
      $('g-help').textContent = 'Left and right to move · Z to turn · Down to drop';
      return;
    }
    if (spec.mode === 'rider') {
      $('g-help').textContent = 'The throttle is always on · Z to jump · '
        + 'up and down to level the bike before you land';
      return;
    }
    if (spec.mode === 'scramble') {
      $('g-help').textContent = 'The cave comes to you · arrows or WASD to fly · '
        + 'X to shoot · do not touch the rock';
      return;
    }
    /* A run of rooms keeps its rules on the room, not on the game, so a
       generated quest was told to walk and jump and never told there were
       fights in it. */
    const stages = Array.isArray(spec.levels) && spec.levels.length ? spec.levels : null;
    const here = stages ? (stages[game.stage] || stages[0]) : spec;
    const r = here.rules || spec.rules || {};
    if (r.beat) {
      $('g-help').textContent = 'Arrows or WASD to move · walk into a rival · '
        + 'up and down to choose, Z to strike';
      return;
    }
    const bits = [spec.mode === 'invaders' ? 'Left and right to move'
                                            : 'Arrows or WASD to move'];
    if (spec.mode === 'platform') bits.push('Z / Space to jump');
    if (p.attack) bits.push('X to shoot');
    else if (p.dash) bits.push('X to dash');
    if (p.aimLock && spec.mode === 'topdown') bits.push('hold Z to hold your aim');
    $('g-help').textContent = bits.join(' · ');
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
    game.freeCam = false;
    game.start(); setPlaying(true); startMusic();
    display.focus();
  }
  function pause() { if (game) game.stop(); setPlaying(false); stopMusic(); present(); }
  const toggle = () => ($('g-play').getAttribute('aria-pressed') === 'true' ? pause() : play());

  // ---------- input ----------
  /* One player gets both sets of keys, because there is no reason to make
     someone alone choose. Two players split them: arrows and Z/X on the
     right, WASD and F/G on the left, so two people can sit at one keyboard
     without reaching across each other. */
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    Space: 'a', KeyZ: 'a', KeyJ: 'a', KeyX: 'b', KeyK: 'b',
  };
  const KEYMAP_P1 = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Space: 'a', KeyZ: 'a', KeyX: 'b',
  };
  const KEYMAP_P2 = {
    KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down',
    KeyF: 'a', KeyG: 'b', ShiftLeft: 'a',
  };
  // Which pad a key belongs to depends on whether anyone else is playing.
  function routeKey(code) {
    if (!game || !game.coop) { const k = KEYMAP[code]; return k ? [game && game.input, k] : null; }
    if (KEYMAP_P1[code]) return [game.input, KEYMAP_P1[code]];
    if (KEYMAP_P2[code]) return [game.input2, KEYMAP_P2[code]];
    return null;
  }
  function wireInput() {
    addEventListener('keydown', e => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      const hit = routeKey(e.code);
      if (hit && hit[0]) { e.preventDefault(); hit[0][hit[1]] = true; }
      if (e.code === 'Space' && !hit) { e.preventDefault(); toggle(); }
      if (e.code === 'KeyR' && !(game && game.coop)) { if (game) { game.reset(); present(); readout(); } }
    });
    addEventListener('keyup', e => { const hit = routeKey(e.code); if (hit && hit[0]) hit[0][hit[1]] = false; });
    for (const btn of $('g-pad').querySelectorAll('button')) {
      const k = btn.dataset.key;
      const set = on => { if (game) game.input[k] = on; btn.classList.toggle('on', on); };
      btn.addEventListener('pointerdown', e => { e.preventDefault(); set(true); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => set(false));
    }
  }

  // ---------- panning ----------
  // Levels are wider than the screen, so building means being able to look
  // around. Right-drag pans, arrows nudge, and the bar says where you are.
  let panning = false, panFrom = null;
  function setFreeCam(on) {
    if (!game) return;
    game.freeCam = on;
    display.classList.toggle('panning', on && panning);
    meta();
  }
  function panKeys(e) {
    if (!game || !cfg().edit || $('g-play').getAttribute('aria-pressed') === 'true') return false;
    const step = e.shiftKey ? 64 : 16;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.code];
    if (!d) return false;
    game.freeCam = true; game.panBy(d[0], d[1]); present(); meta();
    return true;
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
    else if (brush.kind === 'prop') {
      // Decor stands on the tile it was dropped on, centred, so scenery lines
      // up with the ground instead of floating at a corner.
      if (erase) game.removePropAt(p.x, p.y);
      else if (!game.removePropAt(p.x, p.y))
        game.addProp({ i: brush.id, x: p.tx * T + T / 2, y: p.ty * T + T, t: decorTint, b: $('g-decor-back').checked });
    }
    else if (erase) game.removeEntityAt(p.x, p.y);
    else if (!game.removeEntityAt(p.x, p.y)) {
      // A name is what a script has to say to reach this piece. Placing
      // several with the same one is allowed: "guard" can be three of them.
      const tag = ($('g-tag').value || '').trim().slice(0, 20);
      game.addEntity({ type: brush.id, x: p.tx * T, y: p.ty * T, dir: cfg().dir,
                       ...(tag ? { tag } : {}) });
    }
    present(); meta(); showTags(); save();
  }
  function wireBuild() {
    display.addEventListener('pointerdown', e => {
      if (!cfg().edit) return;
      e.preventDefault(); display.setPointerCapture(e.pointerId);
      if (e.button === 2 || e.button === 1) {          // right or middle drags the view
        panning = true; panFrom = { x: e.clientX, y: e.clientY };
        game.freeCam = true; display.classList.add('panning');
        return;
      }
      painting = true; mark(); paint(e, brush.id === 0);
    });
    display.addEventListener('pointermove', e => {
      if (panning && panFrom) {
        const z = cfg().zoom;
        game.panBy(-(e.clientX - panFrom.x) / z, -(e.clientY - panFrom.y) / z);
        panFrom = { x: e.clientX, y: e.clientY };
        present(); meta(); return;
      }
      if (painting) paint(e, brush.id === 0);
    });
    for (const ev of ['pointerup', 'pointercancel']) display.addEventListener(ev, () => {
      painting = false; panning = false; panFrom = null; display.classList.remove('panning');
    });
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
    for (const id of PIECES) {
      const info = window.NeoGame.TILES[id] || {};
      const label = id === 0 ? 'Erase' : (info.name || String(id));
      const btn = pieceButton(label, x => {
        if (id === 0) { x.strokeStyle = '#4b4368'; x.beginPath(); x.moveTo(4,4); x.lineTo(16,12); x.moveTo(16,4); x.lineTo(4,12); x.stroke(); return; }
        if (info.fill) { x.fillStyle = info.fill; x.fillRect(2, 4, 16, 10); }
        if (info.top) { x.fillStyle = info.top; x.fillRect(2, 4, 16, info.decor ? 10 : 3); }
      }, () => { brush = { kind: 'tile', id }; markCurrent(); });
      btn.dataset.piece = `tile:${id}`;
      tiles.append(btn);
    }
    const ents = $('g-entities'); ents.innerHTML = '';
    for (const type of PLACEABLE) {
      const def = window.NeoGame.ENTITY[type];
      const tint = def.goal ? '#3fbf4a' : def.enemy ? '#ff5a3c' : def.key ? '#2ef2ff' : def.heal ? '#ff2e88' : '#ffd23f';
      const btn = pieceButton(type, x => {
        const S = window.NeoSprites;
        const idx = S && S.loaded ? S.forEntity(type, (spec && spec.cat) || '', 0) : null;
        if (idx != null && S.drawFit(x, idx, 0, 0, 20, 16, tint)) return;
        x.fillStyle = tint;
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

  // ---------- generating ----------
  // Text in, playable game out. The backend is rules today and could be a model
  // tomorrow; nothing else here would change, because the contract is only ever
  // that a spec comes back and the validator accepts it.
  const SURPRISES = [
    'a hard ice cave with slippery ledges and a double jump',
    'a short factory level with conveyor belts and a robot who can shoot',
    'a tall tower to climb at sunset, 10 coins',
    'an easy underwater temple with a locked door and a key',
    'a volcano arena with a boss fight and 3 lives',
    'a top-down dungeon maze with chasers and a key',
    'a long sky level on floating islands with a dash',
    'a timed run through ruins against the clock',
    'a cave with breakable bricks and bouncy springs',
  ];

  // Make the panel show what the game actually is.
  function syncControlsFrom(spec) {
    const p = spec.player || {};
    /* Only the abilities this kind of game has. A falling-block game has
       nobody to give a double jump to, and offering one is not a harmless
       extra control - it is a promise the game cannot keep. */
    const WHO_CAN = {
      platform: ['g-double', 'g-wall', 'g-dash', 'g-attack', 'g-coop'],
      topdown:  ['g-dash', 'g-attack', 'g-aimlock', 'g-coop'],
      racer:    ['g-dash'],
      shmup:    ['g-attack'],
      scramble: ['g-attack'],
      invaders: ['g-attack'],
      rider:    [],
      blocks:   [],
    };
    const allowed = WHO_CAN[spec.mode] || WHO_CAN.platform;
    for (const id of ['g-double', 'g-wall', 'g-dash', 'g-attack', 'g-aimlock', 'g-coop']) {
      const row = $(id) && $(id).closest('label');
      if (row) row.hidden = !allowed.includes(id);
    }
    /* A stacking game draws no body at all - there is nothing for the hero
       sprite, the tint or the character to be about - and its entities are
       never stepped, so a coin placed in the well is a coin that can never
       be picked up. Neither panel is offered rather than offered and ignored. */
    const bodied = spec.mode !== 'blocks';
    window.NeoWindows?.offer?.('abilities', allowed.length > 0);
    window.NeoWindows?.offer?.('hero', bodied);
    if ($('g-entities')) $('g-entities').hidden = !bodied;
    // Facing is a property of a placed entity; with none to place it says nothing.
    const facing = $('g-dir') && $('g-dir').closest('label');
    if (facing) facing.hidden = !bodied;

    // Which sky this game came with: one of the presets, or its own.
    if (spec.sky0 && spec.sky1) {
      const named = Object.keys(SKIES)
        .find(k => SKIES[k][0] === spec.sky0 && SKIES[k][1] === spec.sky1);
      ownSky = named ? null : [spec.sky0, spec.sky1];
      $('g-sky').value = named || 'own';
    }
    if (p.char) $('g-char').value = p.char;
    const lives = String(spec.lives ?? 3);
    if (![...$('g-lives').options].some(o => o.value === lives)) {
      const o = document.createElement('option'); o.value = lives; o.textContent = lives; $('g-lives').append(o);
    }
    $('g-lives').value = lives;
    /* What finishes this game. Five of the seven kinds do not end at a flag,
       and the control said "Just the flag" for every one of them - a label
       that is not merely unhelpful but wrong. Where the ending is not a
       pickup count, the control says what it is and leaves it alone. */
    const stages = Array.isArray(spec.levels) && spec.levels.length ? spec.levels : null;
    const rules = ((stages ? stages[0] : spec).rules) || spec.rules || {};
    const ending = rules.clearAll ? 'Clear the board'
                 : rules.clearFoes ? 'Clear the room'
                 : rules.lines ? `${rules.lines} lines`
                 : rules.beat ? `Beat ${rules.beat}`
                 : null;
    const sel = $('g-goal');
    let own = [...sel.options].find(o => o.value === 'own');
    if (ending) {
      if (!own) { own = document.createElement('option'); own.value = 'own'; sel.append(own); }
      own.textContent = ending;
      sel.value = 'own';
    } else if (own) {
      own.remove();
    }
    /* The ending is not chosen here, only reported - so stop before the
       pickup-count options, but not before everything else this function
       does. Returning outright once skipped the abilities above. */
    if (ending) { window.NeoSelect?.refreshAll?.(); return; }
    /* What the end of the level is called. All four of these end on an exit
       tile, but only two of them end on a flag: a bike course ends at a
       finish line and a scrolling shooter ends by getting there alive, and
       calling either one a flag describes a thing that is not on the screen. */
    const ARRIVAL = { racer: 'Reach the finish', rider: 'Reach the finish',
                      shmup: 'Survive the run', scramble: 'Reach the finish' };
    const arrival = ARRIVAL[spec.mode] || 'Just the flag';
    const zero = [...sel.options].find(o => o.value === '0');
    if (zero) zero.textContent = arrival;
    // From the room, not the game: a run keeps its rules on each room, so a
    // three-stage quest that asks for a pickup read as "just the flag".
    const need = String(rules.collect || 0);
    if (![...$('g-goal').options].some(o => o.value === need)) {
      const o = document.createElement('option'); o.value = need;
      o.textContent = need === '0' ? arrival : `Collect ${need}`;
      $('g-goal').append(o);
    }
    $('g-goal').value = need;
    for (const [id, key] of [['g-double','doubleJump'],['g-wall','wallJump'],['g-dash','dash'],['g-attack','attack'],['g-aimlock','aimLock']])
      $(id).checked = !!p[key];
    $('g-coop').checked = !!(spec.coop || spec.players === 2);
    if ($('g-coop-hint')) $('g-coop-hint').hidden = !$('g-coop').checked;
    window.NeoSelect?.refreshAll?.();
  }

  /* Read back in the words a person would use. These are the spec's own
     keys, and printing them raw told the player their game had "aimLock" and
     called a racing game a platformer. */
  const SAID = {
    doubleJump: 'double jump', wallJump: 'wall jump', dash: 'dash',
    attack: 'a gun', aimLock: 'a turret',
  };
  const MODE_SAID = { topdown: 'top-down', platform: 'platformer',
                      racer: 'racing', shmup: 'a shooter', invaders: 'a fixed shooter',
                      blocks: 'falling blocks', rider: 'a rider' };

  function describeUnderstanding(u) {
    const bits = [];
    if (u.theme) bits.push(`<b>${u.theme}</b>`);
    if (u.mode) bits.push(`<b>${MODE_SAID[u.mode] || u.mode}</b>`);
    // The two overhead games that are their own genre rather than a dungeon.
    if (u.fights) bits.push('<b>turn-based battles</b>');
    if (u.chase) bits.push('<b>a maze chase</b>');
    if (u.mech) bits.push(`<b>${u.mech}</b>`);
    if (u.abilities && u.abilities.length) bits.push(u.abilities.map(a => `<b>${SAID[a] || a}</b>`).join(' + '));
    if (u.difficulty !== undefined) bits.push(`<b>${['easy','normal','hard'][u.difficulty]}</b>`);
    if (u.size) bits.push(`<b>${u.size}</b>`);
    if (u.collect !== undefined) bits.push(`<b>${u.collect} to collect</b>`);
    if (u.timed) bits.push('<b>timed</b>');
    if (u.boss) bits.push('<b>boss</b>');
    if (u.char) bits.push(`<b>${u.char}</b>`);
    return bits;
  }

  const RUN_STAGES = 3;                 // what "a game" means when nobody says

  function runGenerate(prompt) {
    // A single room ends the moment you touch the flag, which is not a game.
    // Unless the words ask for a particular number, build a short run.
    const asked = window.NeoGameGen.stageCount(prompt);
    const out = window.NeoGameGen.generateValid(prompt, 8, asked || RUN_STAGES);
    const el = $('g-understood');
    if (!out || !out.validation.ok) {
      el.innerHTML = `<span class="warn">Could not build that one — ${(out && out.validation.errors[0]) || 'unknown problem'}. Try different words.</span>`;
      return;
    }
    const bits = describeUnderstanding(out.understood);
    el.innerHTML = bits.length
      ? `Read as ${bits.join(' · ')}. The rest was chosen for you.`
      : 'Nothing recognised in that, so all of it was chosen for you.';
    cloudId = null;
    // build() applies the studio's own controls over the spec, so the controls
    // have to be told what was generated first - otherwise the dropdowns
    // silently overwrite the hero, the lives and the pickup target.
    syncControlsFrom(out.spec);
    build(out.spec);
    $('g-title').value = out.spec.name;
    $('g-edit').checked = false;
    display.classList.remove('building');
    save();
    play();
  }

  // ---------- the game picker ----------
  // A grid of games that are actually running, rather than a dropdown of names.
  const TILE_W = 116;
  let pickerOpen = false, tiles = [], pRaf = 0, pLast = 0, pickerCat = 'all';

  function buildPickerCats() {
    const host = $('g-picker-cats'); host.innerHTML = '';
    const counts = {};
    for (const t of Object.values(window.NeoGameTemplates)) counts[t.cat || 'other'] = (counts[t.cat || 'other'] || 0) + 1;
    const cats = window.NeoGameCats || {};
    const entries = [['all', ['All', '全']]].concat(
      Object.entries(cats).map(([k, v]) => [k, v]));
    for (const [key, [label, kanji]] of entries) {
      const n = key === 'all' ? Object.keys(window.NeoGameTemplates).length : (counts[key] || 0);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'picker-cat' + (key === pickerCat ? ' current' : '') + (n ? '' : ' empty');
      b.dataset.cat = key;
      b.innerHTML = `<span class="pc-k">${kanji}</span>${label}<i>${n || 'soon'}</i>`;
      if (n) b.addEventListener('click', () => { pickerCat = key; buildPickerCats(); buildPickerGrid(); });
      else b.disabled = true;
      host.append(b);
    }
  }

  function buildPickerGrid() {
    const grid = $('g-picker-grid'); grid.innerHTML = ''; tiles = [];
    const c = cfg();
    const [bw, bh] = window.NeoPalette.GAME_FRAME;
    const th = Math.max(30, Math.round(TILE_W * bh / bw));
    let shown = 0;
    for (const [key, t] of Object.entries(window.NeoGameTemplates)) {
      if (pickerCat !== 'all' && (t.cat || 'other') !== pickerCat) continue;
      shown++;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'picker-tile' + (key === $('g-template').value ? ' current' : '');
      tile.dataset.game = key;
      const cv = document.createElement('canvas'); cv.width = TILE_W; cv.height = th;
      const label = document.createElement('span');
      label.textContent = `${t.kanji || ''} ${t.name}`.trim();
      tile.append(cv, label);
      tile.addEventListener('click', () => {
        $('g-template').value = key;
        $('g-pick-name').textContent = t.name;
        closePicker();
        build(JSON.parse(JSON.stringify(t)));
        save();
      });
      grid.append(tile);
      try {
        const ctx2 = cv.getContext('2d', { willReadFrequently: true });
        const game = window.NeoGame.create(cv, JSON.parse(JSON.stringify(t)), { hud: false });
        tile._preview = game;              // reachable for debugging and for tests
        tiles.push({ ctx: ctx2, game, w: TILE_W, h: th });
      } catch {}
    }
    $('g-picker-count').textContent = `${shown} of ${Object.keys(window.NeoGameTemplates).length}`;
    requestAnimationFrame(syncPickerScroll);
  }

  function syncPickerScroll() {
    const grid = $('g-picker-grid'), body = grid.parentElement;
    const more = grid.scrollHeight - grid.clientHeight - grid.scrollTop > 4;
    body.classList.toggle('more', more);
    $('g-picker-more').hidden = !more;
  }

  /* A preview that only holds right walks into the first hazard, dies three
     times and sits on GAME OVER for as long as the picker is open - which
     turned the whole grid into a wall of dead games. These play instead:
     enough of a bot to get past a wall, a gap or a spike, and a restart when
     one of them finally does lose. */
  function previewInfo(g, tx, ty) { return window.NeoGame.TILES[g.level.at(tx, ty)] || {}; }

  function previewDrive(t, dt) {
    const g = t.game;
    /* A fight is not the game being over, it is the game happening somewhere
       else. Treating it as a stop restarted the preview every second it was
       in one, which is exactly when there is something worth watching. */
    if (g.state === 'fight') {
      t.tap = !t.tap;
      g.input.a = t.tap;
      g.tick(dt);
      return;
    }
    if (g.state !== 'play') {
      // let the loss read for a moment, then go again
      t.over = (t.over || 0) + dt;
      if (t.over > 1.1) { g.reset(); t.over = 0; }
      g.tick(dt);
      return;
    }
    t.over = 0;
    const p = g.player, T = 8;
    const solid = (tx, ty) => previewInfo(g, tx, ty).solid === true;
    const harmful = (tx, ty) => !!previewInfo(g, tx, ty).hazard;

    /* A well and a bike have nobody to steer, or nobody who steers the way
       everything else does. Without these the two newest games sat perfectly
       still in the picker, which is a poor advertisement for them. */
    if (g.mode === 'blocks') {
      const pc = g.piece;
      if (pc) {
        let bestX = null, bestD = -1;
        for (let x = 1; x < g.level.w - 1; x++) {
          if (solid(x, 1)) continue;
          let d = g.level.h;
          for (let y = 0; y < g.level.h; y++) if (g.level.at(x, y)) { d = y; break; }
          if (d > bestD) { bestD = d; bestX = x; }
        }
        g.input.left = bestX !== null && pc.x > bestX;
        g.input.right = bestX !== null && pc.x < bestX;
        g.input.down = bestX !== null && pc.x === bestX;
        t.turn = ((t.turn || 0) + dt) % 1.7;
        g.input.a = t.turn < dt * 2;
      }
      g.tick(dt);
      return;
    }

    if (g.mode === 'rider') {
      g.input.up = p.pitch > 0.06;
      g.input.down = p.pitch < -0.06;
      t.turn = ((t.turn || 0) + dt) % 0.8;
      g.input.a = p.grounded && t.turn < dt * 2;
      g.tick(dt);
      return;
    }

    if (g.mode === 'invaders') {
      const rank = g.entities.filter(e => e.alive && e.def.march);
      if (rank.length) {
        const low = rank.reduce((a, b) => (b.y > a.y ? b : a));
        const want = low.x + low.w / 2, me = p.x + p.w / 2;
        g.input.left = want < me - 2;
        g.input.right = want > me + 2;
        g.input.b = Math.abs(want - me) < 6;
      }
      g.tick(dt);
      return;
    }

    if (g.mode === 'scramble') {
      /* Down the middle of the corridor, read a little ahead of the nose
         rather than under it - by the time rock is beside you it is too late
         to be anywhere else. The trigger is simply held: in a cave everything
         worth shooting is in front of you. */
      const col = Math.min(g.level.w - 1, Math.floor((p.x + p.w + 10) / T));
      const here = Math.floor((p.y + p.h / 2) / T);
      let up = here, down = here;
      while (up > 0 && !solid(col, up - 1) && here - up < 12) up--;
      while (down < g.level.h - 1 && !solid(col, down + 1) && down - here < 12) down++;
      const want = ((up + down) / 2) * T + T / 2;
      g.input.up = want < p.y + p.h / 2 - 3;
      g.input.down = want > p.y + p.h / 2 + 3;
      g.input.b = true;
      g.tick(dt);
      return;
    }

    if (g.mode === 'racer' || g.mode === 'shmup') {
      // Steer for the middle of whatever road is open on this row.
      const row = Math.floor((p.y + p.h / 2) / T);
      const here = Math.floor((p.x + p.w / 2) / T);
      let left = here, right = here;
      while (left > 0 && !solid(left - 1, row) && here - left < 12) left--;
      while (right < g.level.w - 1 && !solid(right + 1, row) && right - here < 12) right++;
      const want = ((left + right) / 2) * T + T / 2;
      g.input.left = want < p.x + p.w / 2 - 3;
      g.input.right = want > p.x + p.w / 2 + 3;
      g.tick(dt);
      return;
    }

    const ahead = Math.floor((p.x + p.w + 2) / T);
    const mid = Math.floor((p.y + p.h / 2) / T);
    const foot = Math.floor((p.y + p.h + 2) / T);
    const blocked = solid(ahead, mid);

    if (g.mode === 'topdown') {
      // Nothing to jump with here, so a wall means going around it. Hold a
      // side for a beat rather than jittering against the corner.
      t.turn = ((t.turn || 0) + dt) % 1.4;
      const up = t.turn < 0.7;
      g.input.right = !blocked;
      g.input.up = blocked && up;
      g.input.down = blocked && !up;
      g.tick(dt);
      return;
    }

    const gap = !solid(ahead, foot) && !harmful(ahead, foot);
    const spike = harmful(ahead, foot) || harmful(ahead, mid);
    g.input.right = true;
    g.input.a = blocked || gap || spike;
    g.tick(dt);
    g.input.a = false;                    // released, so the next jump has an edge
  }

  function pickerLoop(now) {
    if (!pickerOpen) return;
    pRaf = requestAnimationFrame(pickerLoop);
    const dt = Math.min(.06, (now - pLast) / 1000 || 0); pLast = now;
    const c = cfg();
    for (const t of tiles) {
      previewDrive(t, dt);
      window.NeoPalette.snap(t.ctx, t.w, t.h, { chip: c.chip, dither: c.dither, dithAmt: .6 });
    }
  }
  // ---------- the hero ----------
  /* A hero is a sprite and a colour, or the studio's own drawn character if
     no sprite is chosen. Both live on the spec, so a hero travels with the
     game the way the level does. */
  function heroSprite() {
    const sp = game ? game.snapshot() : spec;
    return sp && sp.player && typeof sp.player.sprite === 'number' ? sp.player.sprite : null;
  }
  function setHero(patch) {
    if (!game) return;
    mark();
    const sp = game.snapshot();
    sp.player = { ...(sp.player || {}), ...patch };
    build(sp); save(); drawHero();
  }
  function drawHero() {
    const cv = $('g-hero-view'); if (!cv) return;
    const x = cv.getContext('2d');
    x.clearRect(0, 0, 32, 32);
    x.fillStyle = '#0b0913'; x.fillRect(0, 0, 32, 32);
    const sp = game ? game.snapshot() : spec;
    const tint = (sp && sp.player && sp.player.tint) || '#2ef2ff';
    const idx = heroSprite();
    const auto = window.NeoSprites && sp
      ? window.NeoSprites.playerFor(sp.mode, sp.cat) : null;
    const show = idx ?? auto;
    if (show != null && window.NeoSprites && window.NeoSprites.loaded) {
      window.NeoSprites.drawFit(x, show, 0, 0, 32, 32, tint);
    } else {
      const chars = window.NeoScene && window.NeoScene.CHARS;
      const key = sp && sp.player && sp.player.char;
      if (chars && chars[key]) window.NeoScene.drawChar(x, chars[key], 16, 28, 1.6, 0, 1);
    }
    const drawnBtn = $('g-hero-drawn');
    if (drawnBtn) drawnBtn.disabled = idx === null;
  }
  function buildHeroTints() {
    const host = $('g-hero-tints'); if (!host) return;
    host.innerHTML = '';
    const sp = game ? game.snapshot() : spec;
    const cur = (sp && sp.player && sp.player.tint) || '#2ef2ff';
    for (const t of ['#2ef2ff', '#ff2e88', '#ffd23f', '#3fbf4a', '#c060ff', '#ff5a3c', '#ece8f5', '#7a7a8a']) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tint' + (t === cur ? ' current' : '');
      b.style.background = t; b.title = t;
      b.setAttribute('aria-label', `Hero colour ${t}`);
      b.addEventListener('click', () => { setHero({ tint: t }); buildHeroTints(); });
      host.append(b);
    }
  }

  // ---------- story ----------
  /* Beats are kept on the spec, not in the DOM: the list you see is drawn
     from the game, and every edit goes back through build() so a beat is
     undoable, packageable and shareable like a tile is. */
  const CUES = [
    ['at', 'At time', 's', 0, 120, 0.5],
    ['score', 'At score', '', 0, 99, 1],
    ['keys', 'With keys', '', 0, 9, 1],
    ['reach', 'Reaching x', ' tiles', 0, 200, 1],
    ['on', 'On event', '', null, null, null],
  ];
  const STORY_MAX_T = 60;                       // the timeline's span, in seconds

  function storyBeats() {
    return (game ? (game.story || []) : (spec && spec.story) || []).slice();
  }
  /* Written straight to the running stage rather than through build(), which
     would rebuild the game and drop you back into stage one every time you
     edited a line in stage three. */
  function writeStory(beats) {
    if (!game) return;
    mark();
    game.setStory(beats);
    save(); buildStory();
  }
  // Every stage's story, for the lanes.
  function allStageStories() {
    if (!game) return [];
    const sp = game.snapshot();
    if (Array.isArray(sp.levels)) {
      return sp.levels.map((st, i) => ({ name: st.name || `Stage ${i + 1}`, beats: st.story || [] }));
    }
    return [{ name: sp.name || 'Stage 1', beats: sp.story || [] }];
  }
  function cueOf(beat) {
    for (const [key] of CUES) if (beat[key] !== undefined) return key;
    return 'at';
  }

  function buildStory() {
    const rows = $('g-story-rows'); if (!rows) return;
    const beats = storyBeats();
    rows.innerHTML = '';
    beats.forEach((beat, i) => {
      const row = document.createElement('div');
      row.className = 'story-row';
      const cue = cueOf(beat);

      const sel = document.createElement('select');
      sel.className = 'mini-select';
      for (const [key, label] of CUES) {
        const o = document.createElement('option'); o.value = key; o.textContent = label;
        if (key === cue) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => {
        const next = { text: beat.text, who: beat.who };
        next[sel.value] = sel.value === 'on' ? 'collect' : (sel.value === 'at' ? 2 : 1);
        const all = storyBeats(); all[i] = next; writeStory(all);
      });

      let valueEl;
      if (cue === 'on') {
        valueEl = document.createElement('select');
        valueEl.className = 'mini-select';
        for (const ev of window.NeoScript.EVENTS) {
          const o = document.createElement('option'); o.value = ev; o.textContent = ev;
          if (ev === beat.on) o.selected = true;
          valueEl.append(o);
        }
        valueEl.addEventListener('change', () => {
          const all = storyBeats(); all[i] = { ...all[i], on: valueEl.value }; writeStory(all);
        });
      } else {
        const def = CUES.find(c => c[0] === cue);
        valueEl = document.createElement('input');
        valueEl.type = 'number'; valueEl.className = 'story-num';
        valueEl.min = def[3]; valueEl.max = def[4]; valueEl.step = def[5];
        valueEl.value = beat[cue] ?? 0;
        valueEl.addEventListener('change', () => {
          const all = storyBeats();
          const v = Math.max(def[3], Math.min(def[4], +valueEl.value || 0));
          all[i] = { ...all[i], [cue]: v }; writeStory(all);
        });
      }

      const who = document.createElement('select');
      who.className = 'mini-select';
      for (const [v, label] of [['player', 'P1'], ['p2', 'P2']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = label;
        if ((beat.who || 'player') === v) o.selected = true;
        who.append(o);
      }
      who.addEventListener('change', () => {
        const all = storyBeats(); all[i] = { ...all[i], who: who.value }; writeStory(all);
      });

      const text = document.createElement('input');
      text.type = 'text'; text.className = 'story-text'; text.maxLength = 120;
      text.value = beat.text || '';
      text.placeholder = 'What they say';
      text.addEventListener('change', () => {
        const all = storyBeats(); all[i] = { ...all[i], text: text.value }; writeStory(all);
      });

      const del = document.createElement('button');
      del.type = 'button'; del.className = 'mini'; del.textContent = '×';
      del.title = 'Remove this beat';
      del.addEventListener('click', () => {
        const all = storyBeats(); all.splice(i, 1); writeStory(all);
      });

      row.append(sel, valueEl, who, text, del);
      rows.append(row);
    });
    $('g-story-count').textContent = beats.length
      ? `${beats.length} beat${beats.length === 1 ? '' : 's'}`
      : 'No story yet';
    buildStoryLine();
  }

  /* One lane per stage, so a run reads as a run. A lane only shows the beats
     cued by a clock - a beat cued by a score or an event has no place on a
     timeline, and drawing it at an invented time would be a lie - so those
     are counted beside the lane instead. Clicking a lane goes to that stage,
     because editing what you cannot see is how edits get lost. */
  function buildStoryLine() {
    const host = $('g-story-track'); if (!host) return;
    host.innerHTML = '';
    $('g-story-ticks').innerHTML = '';
    for (let sec = 0; sec <= STORY_MAX_T; sec += 10) {
      const tick = document.createElement('span');
      tick.className = 'tl-tick';
      tick.style.left = `${(sec / STORY_MAX_T) * 100}%`;
      tick.textContent = `${sec}s`;
      $('g-story-ticks').append(tick);
    }

    const lanes = allStageStories();
    const here = game ? game.stage : 0;
    lanes.forEach((lane, i) => {
      const row = document.createElement('div');
      row.className = 'tl-lane' + (i === here ? ' current' : '');

      const label = document.createElement('button');
      label.type = 'button'; label.className = 'tl-name';
      const timed = lane.beats.filter(b => b.at !== undefined).length;
      const cued = lane.beats.length - timed;
      label.innerHTML = `<span>${lane.name}</span><i>${lane.beats.length || '·'}${cued ? ` (${cued} cued)` : ''}</i>`;
      label.title = i === here ? 'The stage you are editing' : `Go to ${lane.name}`;
      if (i !== here) label.addEventListener('click', () => {
        game.goToStage(i); present(); readout(); meta(); showTags(); buildStory();
      });

      const track = document.createElement('div');
      track.className = 'tl-track';

      lane.beats.forEach((beat, n) => {
        if (beat.at === undefined) return;
        const pin = document.createElement('button');
        pin.type = 'button'; pin.className = 'tl-pin';
        pin.style.left = `${Math.max(0, Math.min(100, (beat.at / STORY_MAX_T) * 100))}%`;
        pin.title = `${beat.at}s · ${beat.text || ''}`;
        pin.textContent = String(n + 1);
        if (i !== here) { pin.disabled = true; track.append(pin); return; }
        const drag = e => {
          const r = track.getBoundingClientRect();
          const t = Math.max(0, Math.min(STORY_MAX_T, ((e.clientX - r.left) / r.width) * STORY_MAX_T));
          pin.style.left = `${(t / STORY_MAX_T) * 100}%`;
          pin.dataset.t = t.toFixed(1);
        };
        pin.addEventListener('pointerdown', e => {
          e.preventDefault(); pin.setPointerCapture(e.pointerId); pin.dataset.dragging = '1'; drag(e);
        });
        pin.addEventListener('pointermove', e => { if (pin.dataset.dragging) drag(e); });
        for (const ev of ['pointerup', 'pointercancel']) pin.addEventListener(ev, () => {
          if (!pin.dataset.dragging) return;
          delete pin.dataset.dragging;
          const all = storyBeats();
          all[n] = { ...all[n], at: +(+pin.dataset.t || 0).toFixed(1) };
          writeStory(all);
        });
        track.append(pin);
      });

      row.append(label, track);
      host.append(row);
    });
  }

  function addBeat() {
    const all = storyBeats();
    if (all.length >= 60) return;
    const last = all.filter(b => b.at !== undefined).map(b => b.at).sort((a, b) => a - b).pop();
    all.push({ at: last === undefined ? 1 : Math.min(STORY_MAX_T, +(last + 4).toFixed(1)),
               who: 'player', text: '' });
    writeStory(all);
  }

  // ---------- decor ----------
  function decorButton(idx, host) {
    const S = window.NeoSprites;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tilebtn'; b.title = `Sprite ${idx}`;
    const c = document.createElement('canvas'); c.width = 20; c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = '#0b0913'; x.fillRect(0, 0, 20, 16);
    S.drawFit(x, idx, 0, 0, 20, 16, decorTint);
    b.append(c);
    b.dataset.piece = `prop:${idx}`;
    b.addEventListener('click', () => { brush = { kind: 'prop', id: idx }; markCurrent(); });
    host.append(b);
    return b;
  }

  // The strip is a shortlist. Everything else is behind "All decor".
  function buildDecorStrip() {
    const host = $('g-props'); if (!host) return;
    host.innerHTML = '';
    const S = window.NeoSprites;
    if (!S || !S.loaded) { host.textContent = ''; return; }
    for (const idx of S.HANDY.slice(0, 18)) decorButton(idx, host);
    markCurrent();
  }

  function buildTints() {
    const host = $('g-decor-tints'); if (!host) return;
    host.innerHTML = '';
    for (const t of TINTS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tint' + (t === decorTint ? ' current' : '');
      b.style.background = t; b.title = t;
      b.setAttribute('aria-label', `Decor colour ${t}`);
      b.addEventListener('click', () => {
        decorTint = t; buildTints(); buildDecorStrip();
        if (decorOpen) buildDecorGrid();
      });
      host.append(b);
    }
  }

  function buildDecorCats() {
    const host = $('g-decor-cats'); if (!host) return;
    host.innerHTML = '';
    const S = window.NeoSprites;
    for (const [key, label, kanji] of S.BANDS) {
      const n = S.group(key).length;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'picker-cat' + (key === decorCat ? ' current' : '') + (n ? '' : ' empty');
      b.innerHTML = `<span class="pc-k">${kanji}</span>${label}<i>${n || '0'}</i>`;
      if (n) b.addEventListener('click', () => { decorCat = key; buildDecorCats(); buildDecorGrid(); });
      else b.disabled = true;
      host.append(b);
    }
  }

  function buildDecorGrid() {
    const grid = $('g-decor-grid'); if (!grid) return;
    grid.innerHTML = '';
    const S = window.NeoSprites;
    const list = S.group(decorCat);
    for (const idx of list) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'decor-tile'; b.title = `Sprite ${idx}`;
      const c = document.createElement('canvas'); c.width = 32; c.height = 32;
      const x = c.getContext('2d');
      S.drawFit(x, idx, 0, 0, 32, 32, decorTint);
      b.append(c);
      b.addEventListener('click', () => {
        if (decorPick) { const fn = decorPick; closeDecor(); fn(idx); return; }
        brush = { kind: 'prop', id: idx };
        if (!$('g-props').querySelector(`[data-piece="prop:${idx}"]`)) {
          const host = $('g-props');
          decorButton(idx, host);
          while (host.children.length > 24) host.removeChild(host.firstChild);
        }
        markCurrent(); closeDecor();
      });
      grid.append(b);
    }
    $('g-decor-count').textContent = `${list.length} sprite${list.length === 1 ? '' : 's'}`;
  }

  // Dressing a level you built by hand, with the same rules the generator
  // uses. It adds to what is there rather than replacing it, and goes
  // through mark() so one press is one undo.
  function dressLevel() {
    if (!game || !window.NeoGameGen) return;
    mark();
    const sp = game.snapshot(), lvl = game.level;
    const rows = [];
    for (let y = 0; y < lvl.h; y++) {
      const row = [];
      for (let x = 0; x < lvl.w; x++) row.push(lvl.at(x, y).toString(36));
      rows.push(row);
    }
    const theme = $('g-decor-theme').value;
    const had = (sp.props || []).length;
    const r = window.NeoGameGen.rng(`${theme}:${sp.seed || 'neojutsu'}:${had}`);
    const fresh = window.NeoGameGen.dress(r, { w: lvl.w, h: lvl.h, theme, difficulty: 1 },
                                          { g: rows, ents: sp.entities, start: sp.start });
    sp.props = (sp.props || []).concat(fresh);
    build(sp); save(); meta();
    cloudStatus(fresh.length ? `Added ${fresh.length} pieces of ${theme} decor.`
                            : 'No ledges to stand anything on.');
  }
  function clearDecor() {
    if (!game) return;
    mark();
    const sp = game.snapshot(); sp.props = [];
    build(sp); save(); meta();
  }

  // The same grid serves two jobs: choosing decor to paint, and choosing what
  // the hero looks like. Whoever opened it says where the choice goes.
  let decorPick = null;
  function openDecor(onPick, cat) {
    if (!window.NeoSprites || !window.NeoSprites.loaded) return;
    decorPick = typeof onPick === 'function' ? onPick : null;
    if (cat) decorCat = cat;
    decorOpen = true; $('g-decor').hidden = false;
    $('g-decor').querySelector('.eyebrow').textContent = decorPick ? 'CHOOSE A HERO' : 'CHOOSE DECOR';
    buildDecorCats(); buildDecorGrid();
  }
  function closeDecor() { decorOpen = false; decorPick = null; $('g-decor').hidden = true; }

  function openPicker() {
    pickerOpen = true; pLast = 0;
    $('g-picker').hidden = false;
    buildPickerCats(); buildPickerGrid();
    cancelAnimationFrame(pRaf); pRaf = requestAnimationFrame(pickerLoop);
  }
  function closePicker() {
    pickerOpen = false; cancelAnimationFrame(pRaf);
    $('g-picker').hidden = true;
    for (const t of tiles) { try { t.game.stop(); } catch {} }
    tiles = []; $('g-picker-grid').innerHTML = '';
  }

  // ---------- recipes and the rule builder ----------
  function addScript(code) {
    const box = $('g-script');
    const current = box.value.trim();
    // Merge rather than append: two rules that both use `on tick` have to end
    // up in one event, or the second silently replaces the first.
    box.value = current ? window.NeoRecipes.merge([current, code]) : code;
    applyScript();
    box.scrollTop = box.scrollHeight;
  }

  function buildRecipes() {
    const host = $('g-recipes');
    if (!host || !window.NeoRecipes) return;
    host.innerHTML = '';
    for (const r of window.NeoRecipes.list) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'recipe'; b.title = r.blurb;
      b.innerHTML = `<span class="rk">${r.kanji}</span>${r.name}`;
      b.addEventListener('click', () => { addScript(r.code); cloudStatus?.(''); });
      host.append(b);
    }
  }

  // Turn the menus into a rule. The point is that nobody has to remember the
  // shape of an if-block to get started.
  function builderCode() {
    const ev = $('b-event').value, what = $('b-what').value;
    const op = $('b-op').value, val = $('b-val').value || '0';
    const act = $('b-do').value, arg = $('b-arg').value.trim();
    let doLine;
    switch (act) {
      case 'message': doLine = `message "${(arg || 'NICE').replace(/"/g, '').slice(0, 24).toUpperCase()}"`; break;
      case 'spawn':   doLine = `spawn "${/^[a-z]+$/.test(arg) ? arg : 'walker'}" 20 10`; break;
      case 'open': case 'win': case 'lose': doLine = act; break;
      default:        doLine = `${act} ${parseFloat(arg) || (act === 'speed' ? 120 : act === 'gravity' ? 400 : 1)}`;
    }
    const inner = what ? `  if ${what} ${op} ${val}
    ${doLine}
  end` : `  ${doLine}`;
    // "while playing" fires every frame, so a bare action there needs a pace.
    const body = (ev === 'tick' && !what) ? `  every 2
  ${doLine}
  end` : inner;
    return `on ${ev}
${body}
end`;
  }

  function syncBuilderArg() {
    const act = $('b-do').value, arg = $('b-arg');
    const numeric = ['give', 'heal', 'shake', 'speed', 'gravity'];
    if (act === 'message') { arg.type = 'text'; arg.placeholder = 'NICE'; if (!arg.value) arg.value = 'NICE'; }
    else if (act === 'spawn') { arg.type = 'text'; arg.placeholder = 'walker'; arg.value = 'walker'; }
    else if (numeric.includes(act)) { arg.type = 'number'; arg.value = act === 'speed' ? 120 : act === 'gravity' ? 400 : 1; }
    arg.disabled = ['open', 'win', 'lose'].includes(act);
    const hasCond = !!$('b-what').value;
    $('b-op').disabled = !hasCond; $('b-val').disabled = !hasCond;
  }

  // ---------- undo ----------
  // The level and its pieces are small, so history is whole snapshots rather
  // than a diff - simpler, and impossible to get subtly wrong.
  const past = [], future = [];
  /* Any edit to a level has to land on the stage you are looking at. A run
     keeps its rooms in `levels`, and the engine ignores the top-level copy
     entirely - so writing there is writing to nothing, which is how resizing
     a three room game silently did not resize it. */
  function withStage(sp, patch) {
    const i = game ? game.stage : 0;
    if (Array.isArray(sp.levels) && sp.levels.length) {
      sp.levels = sp.levels.map((st, n) => (n === i ? { ...st, ...patch } : st));
      // No second copy to go stale behind the one that counts.
      delete sp.level; delete sp.entities; delete sp.props; delete sp.story;
    } else {
      Object.assign(sp, patch);
    }
    return sp;
  }

  // Rebuilding starts a run at its first room; this puts you back.
  function buildAtStage(sp) {
    const i = game ? game.stage : 0;
    build(sp);
    if (i > 0 && game && game.stages > i) game.goToStage(i);
    present(); readout(); meta();
  }

  function snapState() {
    const sp = game.snapshot();
    return JSON.stringify({ tiles: Array.from(game.level.tiles), entities: sp.entities, props: sp.props, story: game.story });
  }
  function mark() {
    if (!game) return;
    past.push(snapState());
    if (past.length > 60) past.shift();
    future.length = 0;
    syncHistory();
  }
  function restoreState(str) {
    const st = JSON.parse(str);
    const lvl = game.level;
    for (let i = 0; i < lvl.tiles.length; i++) lvl.tiles[i] = st.tiles[i] || 0;
    const sp = withStage(game.snapshot(), {
      entities: st.entities,
      props: st.props || [],
      story: st.story || [],
      level: { w: lvl.w, h: lvl.h, tiles: Array.from(lvl.tiles) },
    });
    buildAtStage(sp);
  }
  function undo() {
    if (!past.length) return;
    future.push(snapState());
    restoreState(past.pop()); syncHistory(); save();
  }
  function redo() {
    if (!future.length) return;
    past.push(snapState());
    restoreState(future.pop()); syncHistory(); save();
  }
  function syncHistory() {
    if ($('g-undo')) $('g-undo').disabled = !past.length;
    if ($('g-redo')) $('g-redo').disabled = !future.length;
  }

  // ---------- resize ----------
  // Growing keeps what is there; shrinking keeps the top-left, which is what
  // people expect from a map editor.
  function resize(w, h) {
    if (!game) return;
    mark();
    const lvl = game.level;
    const out = new Array(w * h).fill(0);
    for (let y = 0; y < Math.min(h, lvl.h); y++)
      for (let x = 0; x < Math.min(w, lvl.w); x++) out[y * w + x] = lvl.at(x, y);
    const sp = game.snapshot();
    withStage(sp, {
      level: { w, h, tiles: out },
      entities: (sp.entities || []).filter(e => e.x < w * T && e.y < h * T),
      props: (sp.props || []).filter(pr => pr.x < w * T && pr.y < h * T),
    });
    buildAtStage(sp); save();
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

  // ---------- script ----------
  function showScriptState(res) {
    const msg = $('g-script-msg');
    if (res && res.errors && res.errors.length) {
      msg.className = 'script-msg bad';
      msg.textContent = `${res.errors.length} problem${res.errors.length > 1 ? 's' : ''}: ${res.errors.slice(0, 3).join('; ')}`;
    } else if ($('g-script').value.trim()) {
      msg.className = 'script-msg good'; msg.textContent = 'Script running.';
    } else { msg.className = 'script-msg'; msg.textContent = ''; }
  }
  function applyScript() {
    if (!game) return;
    const res = game.setScript($('g-script').value);
    showScriptState(res);
    present(); readout(); save();
  }
  function pumpScriptLog() {
    if (!game) return;
    const log = $('g-script-log');
    const lines = game.scriptLog || [];
    const fault = game.scriptFault;
    const text = (fault ? `! ${fault}\n` : '') + lines.join('\n');
    log.hidden = !text;
    if (text !== log.textContent) { log.textContent = text; log.scrollTop = log.scrollHeight; }
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
      if (d.look.intro) { set('g-intro', d.look.intro.scene); set('g-intro-secs', d.look.intro.secs); set('g-intro-text', d.look.intro.text); }
      if (d.look.outro) { set('g-outro', d.look.outro.scene); set('g-outro-secs', d.look.outro.secs); set('g-outro-text', d.look.outro.text); }
      for (const [id, k] of [['g-double','doubleJump'],['g-wall','wallJump'],['g-dash','dash'],['g-attack','attack'],['g-aimlock','aimLock'],['g-coop','coop']])
        if ($(id)) $(id).checked = !!d.look[k];
      if ($('g-coop-hint')) $('g-coop-hint').hidden = !$('g-coop').checked;
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

  // ---------- send it to a friend ----------
  // The package is one HTML file with the engine, the level and the track's
  // pattern inlined. Because everything here is seed-based rather than
  // rendered, the whole game - music included - is text.
  /* The other way out: a GB Studio project, which their compiler turns into
     a real ROM. Packaging makes something anyone can open; this makes
     something a Game Boy can run. */
  async function exportGBStudio() {
    const btn = $('g-gbs');
    btn.disabled = true; const was = btn.textContent; btn.textContent = 'Writing…';
    try {
      if (!window.NeoGBS) throw new Error('the exporter did not load');
      const title = cfg().title || 'neojutsu-game';
      const made = await window.NeoGBS.project(game.snapshot(), title);
      if (!made) throw new Error('there is no level to export');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(made.blob);
      a.download = `${title.replace(/[^\w.-]+/g, '-')}-gbstudio.zip`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      cloudStatus(`${a.download} · ${made.rooms} room${made.rooms === 1 ? '' : 's'}, ` +
                  `${made.sprites} sprite${made.sprites === 1 ? '' : 's'} · ` +
                  `unzip it, open the folder in GB Studio, press Build`);
    } catch (e) {
      cloudStatus(`Could not export: ${e.message}`);
    } finally { btn.disabled = false; btn.textContent = was; }
  }

  async function packageGame() {
    const c = cfg();
    const btn = $('g-package');
    btn.disabled = true; const was = btn.textContent; btn.textContent = 'Packing…';
    try {
      const files = ['neo-palette.js', 'chip.js', 'video-gen.js', 'game-sprites.js', 'game-sfx.js', 'game-script.js', 'game-engine.js'];
      const src = [];
      for (const f of files) {
        const r = await fetch(f);
        if (!r.ok) throw new Error(`could not read ${f}`);
        src.push(`/* ${f} */\n` + await r.text());
      }
      const track = savedTracks.find(t => t.id === c.audioSrc);
      const payload = {
        spec: game.snapshot(),
        title: c.title || 'neojutsu-game',
        chip: c.chip, dither: c.dither, zoom: c.zoom,
        pattern: track ? track.pattern : null,
        intro: c.intro.secs > 0 ? c.intro : null,
        outro: c.outro.secs > 0 ? c.outro : null,
      };
      const html = PACKAGE_HTML
        .replace('/*__ENGINE__*/', src.join('\n'))
        .replace('/*__PAYLOAD__*/', JSON.stringify(payload).replace(/</g, '\\u003c'));
      const blob = new Blob([html], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(c.title || 'neojutsu-game').replace(/[^\w.-]+/g, '-')}.html`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      cloudStatus(`Packaged ${a.download} · ${(blob.size / 1024).toFixed(0)} KB · send it to anyone`);
    } catch (e) {
      cloudStatus(`Could not package: ${e.message}. Packaging needs the site to be served, not opened from a file.`);
    } finally { btn.disabled = false; btn.textContent = was; }
  }

  const PACKAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEO術 game</title>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
 html,body{margin:0;height:100%;background:#07060c;color:#ece8f5;font-family:'Press Start 2P',monospace;
   display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
 h1{font-size:11px;letter-spacing:1px;color:#2ef2ff;margin:0}
 canvas{image-rendering:pixelated;box-shadow:0 0 0 2px #2a2340,0 20px 60px #000a;border-radius:4px;touch-action:none}
 p{font-size:7px;color:#9a92b3;margin:0;text-align:center;line-height:1.9}
 button{font-family:inherit;font-size:9px;background:#14111f;color:#ece8f5;border:1px solid #2a2340;
   border-radius:8px;padding:12px 14px;min-width:48px;touch-action:none;user-select:none}
 button:active{border-color:#ff2e88;color:#ff2e88}
 #pad{display:none;gap:26px;align-items:center}
 #dpad{display:grid;grid-template-columns:repeat(3,46px);grid-template-rows:repeat(2,40px);gap:4px}
 #dpad button:nth-child(1){grid-area:1/1/3/2}#dpad button:nth-child(2){grid-area:1/2}
 #dpad button:nth-child(3){grid-area:2/2}#dpad button:nth-child(4){grid-area:1/3/3/4}
 #ab{display:flex;gap:10px}#ab button{width:54px;height:54px;border-radius:50%}
 @media(hover:none),(max-width:760px){#pad{display:flex}}
</style></head><body>
<h1 id="t">NEO術</h1>
<canvas id="c"></canvas>
<div id="pad"><div id="dpad">
 <button data-k="left">◀</button><button data-k="up">▲</button><button data-k="down">▼</button><button data-k="right">▶</button>
</div><div id="ab"><button data-k="b">B</button><button data-k="a">A</button></div></div>
<p id="h">ARROWS MOVE · Z / SPACE JUMP · X ACTION<br>MADE WITH NEOJUTSU</p>
<script>/*__ENGINE__*/<\/script>
<script>
const D = /*__PAYLOAD__*/;
document.getElementById('t').textContent = D.title;
const FRAME = window.NeoPalette.GAME_FRAME;
const low = document.createElement('canvas'); low.width = FRAME[0]; low.height = FRAME[1];
const lctx = low.getContext('2d', {willReadFrequently:true});
const c = document.getElementById('c'); c.width = FRAME[0]*D.zoom; c.height = FRAME[1]*D.zoom;
const dctx = c.getContext('2d'); dctx.imageSmoothingEnabled = false;
const present = () => { window.NeoPalette.snap(lctx, low.width, low.height, {chip:D.chip, dither:D.dither, dithAmt:.6});
  dctx.drawImage(low,0,0,c.width,c.height); };
let g = null, phase = 'idle', tShow = 0, sceneState = null, sceneKey = null, raf = 0, last = 0;
const EMPTY = {level:0,bass:0,mid:0,treble:0,freq:[],wave:[]};

function caption(text, y) {
  if (!text) return;
  lctx.save();
  lctx.textAlign = 'center'; lctx.textBaseline = 'middle';
  const lines = String(text).split('|').map(s => s.trim()).slice(0, 3);
  // Shrink until the longest line fits the frame. A caption clipped at both
  // edges is worse than a small one, and the frame is only 160px wide.
  const room = low.width - 8;
  let size = Math.max(5, Math.round(low.height * 0.075));
  while (size > 4) {
    lctx.font = size + 'px "Press Start 2P", monospace';
    if (Math.max(...lines.map(l => lctx.measureText(l).width)) <= room) break;
    size--;
  }
  lctx.font = size + 'px "Press Start 2P", monospace';
  lines.forEach((line, i) => {
    const ly = y + (i - (lines.length - 1) / 2) * size * 1.7;
    lctx.fillStyle = '#000'; lctx.fillText(line, low.width / 2 + 1, ly + 1);
    lctx.fillStyle = '#ffffff'; lctx.fillText(line, low.width / 2, ly);
  });
  lctx.restore();
}

// A card is a Video Studio scene run at hardware resolution, so an intro costs
// a seed and a scene name rather than a video file.
function card(def, dt) {
  const S = window.NeoScene.SCENES[def.scene] || Object.values(window.NeoScene.SCENES)[0];
  if (sceneKey !== def.scene || !sceneState) {
    sceneState = S.init(window.NeoScene.rng(D.spec.seed || 'neojutsu'), low.width, low.height, .5);
    sceneKey = def.scene;
  }
  lctx.save();
  S.draw(lctx, low.width, low.height, tShow, EMPTY, sceneState, {speed:1, density:.5, step:dt, bg:true});
  lctx.restore();
  caption(def.text || D.title, low.height * 0.5);
  present();
}

function startGame() {
  phase = 'play';
  if (!g) {
    g = window.NeoGame.create(low, D.spec, {onFrame: present,
      onEvent: n => { if (window.NeoSfx) window.NeoSfx.play(n); }});
  } else g.reset();
  g.start();
}

function loop(now) {
  raf = requestAnimationFrame(loop);
  const dt = Math.min(.1, (now - last) / 1000 || 0); last = now;
  if (phase === 'intro' || phase === 'outro') {
    tShow += dt;
    const def = phase === 'intro' ? D.intro : D.outro;
    card(def, dt);
    if (tShow >= def.secs) {
      sceneState = null; sceneKey = null;
      if (phase === 'intro') startGame();
      else { phase = 'idle'; tShow = 0; begin(); }
    }
  } else if (phase === 'play' && g && g.state === 'won' && D.outro && D.outro.secs > 0) {
    g.stop(); phase = 'outro'; tShow = 0;
  }
}

function skip() {
  if (phase === 'intro') { sceneState = null; sceneKey = null; startGame(); }
}

let started = false;
function begin(){
  if (started && phase !== 'idle') return;
  started = true;
  if (window.NeoSfx) window.NeoSfx.ensure();
  if (D.pattern && window.NeoChip && !window.__music){
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    window.NeoChip.render(D.pattern,{tail:false}).then(buf=>{
      const src=ac.createBufferSource(), gn=ac.createGain();
      gn.gain.value=.6; src.buffer=buf; src.loop=true;
      src.connect(gn).connect(ac.destination); src.start(); window.__music=src;
    }).catch(()=>{});
  }
  last = performance.now();
  if (D.intro && D.intro.secs > 0) { phase = 'intro'; tShow = 0; }
  else startGame();
  cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
}

const KEY={ArrowLeft:'left',KeyA:'left',ArrowRight:'right',KeyD:'right',ArrowUp:'up',KeyW:'up',
  ArrowDown:'down',KeyS:'down',Space:'a',KeyZ:'a',KeyX:'b',KeyK:'b'};
// Alone you get both halves of the keyboard; together you get one each.
const K1={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down',Space:'a',KeyZ:'a',KeyX:'b'};
const K2={KeyA:'left',KeyD:'right',KeyW:'up',KeyS:'down',KeyF:'a',KeyG:'b',ShiftLeft:'a'};
function route(code){
  if(!g) return null;
  if(!g.coop){ const k=KEY[code]; return k?[g.input,k]:null; }
  if(K1[code]) return [g.input,K1[code]];
  if(K2[code]) return [g.input2,K2[code]];
  return null;
}
addEventListener('keydown',e=>{
  if(!started){ begin(); return; }
  skip();
  const h=route(e.code); if(h){e.preventDefault(); h[0][h[1]]=true;}
  if(e.code==='KeyR' && g && !g.coop){ g.reset(); present(); }
});
addEventListener('keyup',e=>{const h=route(e.code); if(h) h[0][h[1]]=false;});
for(const b of document.querySelectorAll('#pad button')){const k=b.dataset.k;
  const set=on=>{ if(!started){begin();return;} skip(); if(g) g.input[k]=on; };
  b.addEventListener('pointerdown',e=>{e.preventDefault();set(true);});
  ['pointerup','pointerleave','pointercancel'].forEach(ev=>b.addEventListener(ev,()=>{ if(g) g.input[k]=false; }));}
c.addEventListener('pointerdown',()=>{ if(!started){begin();} else skip(); });

// something on screen before the first key
lctx.fillStyle='#05040a'; lctx.fillRect(0,0,low.width,low.height);
caption(D.title, low.height*0.42); caption('PRESS ANY KEY', low.height*0.62);
present();
<\/script></body></html>`;

  // ---------- wiring ----------
  function init() {
    const tsel = $('g-template');
    for (const [key, t] of Object.entries(window.NeoGameTemplates)) {
      const o = document.createElement('option'); o.value = key; o.textContent = `${t.kanji} ${t.name}`; tsel.append(o);
    }
    if ($('g-pick-name')) $('g-pick-name').textContent = (window.NeoGameTemplates[tsel.value] || {}).name || 'Platformer';
    for (const id of ['g-intro', 'g-outro']) {
      const sel = $(id);
      for (const [key, def] of Object.entries(window.NeoScene.SCENES)) {
        const o = document.createElement('option'); o.value = key; o.textContent = def.label; sel.append(o);
      }
      sel.value = id === 'g-intro' ? 'skyline' : 'grid';
    }
    const csel = $('g-char');
    for (const key of Object.keys(window.NeoScene.CHARS)) {
      const o = document.createElement('option'); o.value = key; o.textContent = key[0].toUpperCase() + key.slice(1); csel.append(o);
    }

    const saved = restore();
    fillTracks();
    const opening = saved || window.NeoGameTemplates[tsel.value];
    if (opening) syncControlsFrom(opening);
    build(opening);
    buildPalette(); wireInput(); wireBuild();
    buildStory(); drawHero();
    buildTints();
    // The atlas decodes an inlined image, so the decor strip and the entity
    // previews are filled in when it is ready rather than assumed present.
    window.NeoSprites?.ready(() => { buildDecorStrip(); buildPalette(); });
    window.NeoSelect?.refreshAll?.();

    $('g-play').addEventListener('click', toggle);
    $('g-reset').addEventListener('click', () => { game.reset(); present(); readout(); });
    $('g-pick-open').addEventListener('click', () => pickerOpen ? closePicker() : openPicker());
    $('g-picker-close').addEventListener('click', closePicker);
    $('g-decor-open').addEventListener('click', () => decorOpen ? closeDecor() : openDecor());
    const themeSel = $('g-decor-theme');
    for (const key of Object.keys(window.NeoGameGen.DECOR)) {
      const o = document.createElement('option');
      o.value = key; o.textContent = key[0].toUpperCase() + key.slice(1);
      themeSel.append(o);
    }
    $('g-hero-open').addEventListener('click', () => openDecor(idx => setHero({ sprite: idx }), 'people'));
    $('g-hero-drawn').addEventListener('click', () => setHero({ sprite: undefined }));
    buildHeroTints();
    $('g-story-add').addEventListener('click', addBeat);
    $('g-story-clear').addEventListener('click', () => writeStory([]));
    $('g-decor-fill').addEventListener('click', dressLevel);
    $('g-decor-clear').addEventListener('click', clearDecor);
    $('g-decor-close').addEventListener('click', closeDecor);
    $('g-picker-grid').addEventListener('scroll', syncPickerScroll);
    $('g-picker-more').addEventListener('click', () => {
      const g = $('g-picker-grid'); g.scrollBy({ top: g.clientHeight * .8, behavior: 'smooth' });
    });
    addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (pickerOpen) closePicker();
      if (decorOpen) closeDecor();
    });
    $('g-template').addEventListener('change', () => {
      const t = window.NeoGameTemplates[$('g-template').value];
      // Same order as generating: build() lays the panel's controls over the
      // spec, so the panel has to be told what this game is first. Without it,
      // picking a game with a gun handed you the same game with the gun taken
      // off, and the Abilities window said so while the game did not.
      if (t) {
        syncControlsFrom(t); build(t); save();
        // and the label has to say which one you picked
        if ($('g-pick-name')) $('g-pick-name').textContent = t.name || 'Platformer';
      }
    });
    for (const id of ['g-chip', 'g-dither', 'g-zoom']) $(id).addEventListener('input', () => {
      $('g-zoom-v').textContent = $('g-zoom').value;
      sizeCanvas(); present(); save();
    });
    // Sky colours live in the spec, so changing them means rebuilding it.
    $('g-sky').addEventListener('input', () => { build(game ? game.snapshot() : spec); save(); });
    for (const id of ['g-char', 'g-lives', 'g-goal', 'g-double', 'g-wall', 'g-dash', 'g-attack', 'g-aimlock', 'g-coop']) $(id).addEventListener('change', () => {
      if ($('g-coop-hint')) $('g-coop-hint').hidden = !$('g-coop').checked;
      build(game ? game.snapshot() : spec); save();
    });
    for (const id of ['g-edit', 'g-grid']) $(id).addEventListener('change', () => {
      display.classList.toggle('building', cfg().edit);
      present(); save();
    });
    for (const id of ['g-intro','g-outro','g-intro-text','g-outro-text','g-intro-secs','g-outro-secs'])
      $(id).addEventListener('input', () => {
        $('g-intro-secs-v').textContent = $('g-intro-secs').value;
        $('g-outro-secs-v').textContent = $('g-outro-secs').value;
        save();
      });
    $('g-title').addEventListener('input', save);
    buildRecipes(); syncBuilderArg();
    $('b-do').addEventListener('change', syncBuilderArg);
    $('b-what').addEventListener('change', syncBuilderArg);
    $('b-add').addEventListener('click', () => addScript(builderCode()));
    $('g-generate').addEventListener('click', () => runGenerate($('g-prompt').value));
    $('g-surprise').addEventListener('click', () => {
      const p = SURPRISES[Math.floor(Math.random() * SURPRISES.length)];
      $('g-prompt').value = p; runGenerate(p);
    });
    $('g-prompt').addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'Enter') { e.preventDefault(); runGenerate($('g-prompt').value); }
    });
    $('g-undo').addEventListener('click', undo);
    $('g-redo').addEventListener('click', redo);
    $('g-clear').addEventListener('click', () => {
      if (!confirm('Clear the whole level? Undo can bring it back.')) return;
      mark();
      const lvl = game.level;
      for (let i = 0; i < lvl.tiles.length; i++) lvl.tiles[i] = 0;
      const sp = game.snapshot(); sp.entities = []; build(sp); save();
    });
    $('g-size').addEventListener('change', () => {
      const v = $('g-size').value; if (!v) return;
      const [w, h] = v.split('x').map(Number); resize(w, h);
      $('g-size').value = ''; window.NeoSelect?.refreshAll?.();
    });
    $('g-sfx').addEventListener('change', () => { if (window.NeoSfx) window.NeoSfx.muted = !cfg().sfx; save(); });
    addEventListener('keydown', e => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (panKeys(e)) e.preventDefault();
      else if (e.code === 'Home' && game) { game.freeCam = false; present(); meta(); }
    });
    $('g-script-apply').addEventListener('click', applyScript);
    $('g-script-clear').addEventListener('click', () => { $('g-script').value = ''; applyScript(); });
    $('g-vol').addEventListener('input', () => { $('g-vol-v').textContent = $('g-vol').value; if (gain) gain.gain.value = cfg().vol; save(); });
    $('g-audio-src').addEventListener('change', async () => { await loadMusic(); save(); });
    $('g-audio-refresh').addEventListener('click', fillTracks);
    $('g-toggle-inspector').addEventListener('click', () => {
      const open = $('g-inspector').hasAttribute('hidden');
      open ? $('g-inspector').removeAttribute('hidden') : $('g-inspector').setAttribute('hidden', '');
      $('g-toggle-inspector').setAttribute('aria-expanded', String(open));
    });
    $('g-open-share').addEventListener('click', packageGame);
    $('g-package').addEventListener('click', packageGame);
    $('g-gbs').addEventListener('click', exportGBStudio);
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
    $('g-intro-secs-v').textContent = $('g-intro-secs').value;
    $('g-outro-secs-v').textContent = $('g-outro-secs').value;
    syncHistory();
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
