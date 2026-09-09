/* NeoJutsu game engine.
 *
 * A small, deterministic runtime for games that look and behave like the
 * hardware the rest of the studio imitates: an 8px tile grid, a fixed timestep,
 * seeded randomness, and the same palette snap the Video Studio uses, so a game
 * frame and a video frame come out of the same machine.
 *
 * A game is plain JSON - a tilemap, some entities and a rule - which keeps a
 * whole game a few KB, shareable by link, and editable by hand.
 */
(() => {
  'use strict';

  const TILE = 8;
  const STEP = 1 / 60;                 // physics runs fixed; rendering does not
  const MAX_CATCHUP = 5;               // never simulate more than this in one frame

  // Tile 0 is empty. Everything else is solid unless it says otherwise.
  // Solid ground is kept dark and its lip bright. The palette snap reduces the
  // frame to a handful of tones, so a mid-brown floor under a mid-blue sky
  // collapses into one colour and the level stops reading as a level.
  // Ids are base36 digits in the level string, so 0-9 then a-z.
  const TILES = {
    0:  { name: 'sky',       solid: false },
    1:  { name: 'ground',    solid: true,  fill: '#241a0e', top: '#7bbf4a' },
    2:  { name: 'stone',     solid: true,  fill: '#26262f', top: '#9a9aab' },
    3:  { name: 'ledge',     solid: 'top', fill: '#3a2410', top: '#c08a4a' },
    4:  { name: 'spikes',    solid: false, hazard: true, fill: '#2a0808', top: '#ff5a3c' },
    5:  { name: 'ladder',    solid: false, ladder: true, fill: '#6a4a20' },
    6:  { name: 'water',     solid: false, water: true,  fill: '#0e2a52', top: '#3f8fd0' },
    7:  { name: 'brick',     solid: true,  breakable: true, fill: '#2e1410', top: '#a85a3a' },
    8:  { name: 'ice',       solid: true,  ice: true,    fill: '#1b3550', top: '#9fe8ff' },
    9:  { name: 'belt →',    solid: true,  belt: 60,     fill: '#2a2438', top: '#c060ff' },
    10: { name: 'belt ←',    solid: true,  belt: -60,    fill: '#2a2438', top: '#c060ff' },
    11: { name: 'spring',    solid: true,  spring: 1.7,  fill: '#243018', top: '#3fbf4a' },
    12: { name: 'door',      solid: true,  door: true,   fill: '#3a2a10', top: '#ffd23f' },
    13: { name: 'checkpoint',solid: false, checkpoint: true, fill: '#101a2e', top: '#2ef2ff' },
    14: { name: 'lava',      solid: false, hazard: true, fill: '#3a0c04', top: '#ff8c1a' },
    15: { name: 'crate',     solid: true,  breakable: true, fill: '#3a2a14', top: '#b98a4a' },
    16: { name: 'grass',     solid: false, decor: true,  fill: '#1c3a18', top: '#3fbf4a' },
    17: { name: 'backwall',  solid: false, fill: '#1a1626' },
    18: { name: 'exit',      solid: false, exit: true,   fill: '#0d2a16', top: '#3fbf4a' },
    19: { name: 'road',      solid: false, road: true,   fill: '#4a4a57' },
    20: { name: 'line',      solid: false, decor: true,  fill: '#4a4a57', top: '#e8e4d8' },
  };

  const rng = seedStr => {
    let h = 1779033703 ^ String(seedStr).length;
    for (let i = 0; i < String(seedStr).length; i++) {
      h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  };

  // ---------- level ----------
  function makeLevel(spec) {
    const w = spec.w | 0, h = spec.h | 0;
    const tiles = new Uint8Array(w * h);
    if (Array.isArray(spec.tiles)) tiles.set(spec.tiles.slice(0, w * h));
    else if (typeof spec.tiles === 'string') {
      // Rows of digits, which is what makes a level readable in JSON.
      const rows = spec.tiles.trim().split('\n');
      for (let y = 0; y < Math.min(h, rows.length); y++)
        for (let x = 0; x < Math.min(w, rows[y].length); x++)
          tiles[y * w + x] = parseInt(rows[y][x], 36) || 0;
    }
    return { w, h, tiles, at(x, y) { return (x < 0 || y < 0 || x >= w || y >= h) ? 0 : tiles[y * w + x]; } };
  }

  const tileInfo = id => TILES[id] || TILES[0];
  // A door is solid until it is opened, which is the only tile whose solidity
  // depends on the state of the game rather than on the tile alone.
  const solidAt = (lvl, tx, ty, ctx) => {
    const t = tileInfo(lvl.at(tx, ty));
    if (t.door) return !(ctx && ctx.doorsOpen);
    return t.solid === true;
  };
  const oneWayAt = (lvl, tx, ty) => tileInfo(lvl.at(tx, ty)).solid === 'top';

  // Every tile the body currently overlaps, which is how ladders, water, belts
  // and checkpoints are detected without a separate trigger volume.
  function tilesUnder(lvl, b) {
    const out = [];
    const x0 = Math.floor(b.x / TILE), x1 = Math.floor((b.x + b.w - 1) / TILE);
    const y0 = Math.floor(b.y / TILE), y1 = Math.floor((b.y + b.h - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const id = lvl.at(tx, ty);
      if (id) out.push({ tx, ty, id, info: tileInfo(id) });
    }
    return out;
  }

  // ---------- entities ----------
  const ENTITY = {
    coin:   { w: 6, h: 6,  collect: true, score: 1 },
    gem:    { w: 7, h: 7,  collect: true, score: 5 },
    heart:  { w: 7, h: 6,  collect: true, heal: 1 },
    key:    { w: 6, h: 7,  collect: true, key: true },
    goal:   { w: 8, h: 12, goal: true },
    walker: { w: 8, h: 10, enemy: true, speed: 22, turns: true, hp: 1 },
    flyer:  { w: 8, h: 8,  enemy: true, speed: 26, floats: true, hp: 1 },
    chaser: { w: 8, h: 10, enemy: true, speed: 40, chases: true, sight: 90, hp: 2 },
    jumper: { w: 9, h: 9,  enemy: true, speed: 14, hops: true, hp: 1 },
    turret: { w: 8, h: 8,  enemy: true, speed: 0, fires: 1.4, hp: 3, still: true },
    spike:  { w: 8, h: 4,  enemy: true, speed: 0, still: true, hp: 99 },
    shot:   { w: 3, h: 3,  bullet: true, speed: 110 },
    mover:  { w: 16, h: 4, platform: true, speed: 26, span: 48 },
  };

  let entitySeq = 0;
  function makeEntity(e) {
    const def = ENTITY[e.type] || ENTITY.coin;
    return { id: ++entitySeq, type: e.type, x: e.x, y: e.y, w: def.w, h: def.h, def,
             vx: (def.speed || 0) * (e.dir === -1 ? -1 : 1), vy: 0, hp: def.hp || 1,
             home: { x: e.x, y: e.y }, alive: true, t: (e.x * 7 + e.y * 13) % 628 / 100,
             life: 0, cool: 0, tag: e.tag || '',
             // What a script can change about an actor: where it is going,
             // whether it is on stage, and what it looks like.
             hidden: false, goal: null, sprite: (typeof e.sprite === 'number' ? e.sprite : null) };
  }

  // ---------- collision ----------
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Move on one axis at a time and resolve against the grid. Doing the axes
  // separately is what stops a body catching on the seam between two tiles.
  function moveAxis(body, lvl, dx, dy, wasFalling, ctx) {
    const hit = { wall: 0, floor: null, ceil: null };
    if (dx) {
      body.x += dx;
      const y0 = Math.floor(body.y / TILE), y1 = Math.floor((body.y + body.h - 1) / TILE);
      const edge = dx > 0 ? Math.floor((body.x + body.w - 1) / TILE) : Math.floor(body.x / TILE);
      for (let ty = y0; ty <= y1; ty++) {
        if (!solidAt(lvl, edge, ty, ctx)) continue;
        body.x = dx > 0 ? edge * TILE - body.w : (edge + 1) * TILE;
        body.vx = 0; hit.wall = dx > 0 ? 1 : -1; break;
      }
    }
    if (dy) {
      body.y += dy;
      const x0 = Math.floor(body.x / TILE), x1 = Math.floor((body.x + body.w - 1) / TILE);
      const edge = dy > 0 ? Math.floor((body.y + body.h - 1) / TILE) : Math.floor(body.y / TILE);
      for (let tx = x0; tx <= x1; tx++) {
        const solid = solidAt(lvl, tx, edge, ctx);
        // One-way tiles only catch a body that is falling onto them from above.
        const oneWay = dy > 0 && oneWayAt(lvl, tx, edge) &&
                       wasFalling && (body.y + body.h - dy) <= edge * TILE + 1;
        if (!solid && !oneWay) continue;
        if (dy > 0) { body.y = edge * TILE - body.h; body.grounded = true; hit.floor = { tx, ty: edge }; }
        else { body.y = (edge + 1) * TILE; hit.ceil = { tx, ty: edge }; }
        body.vy = 0; break;
      }
    }
    return hit;
  }

  // ---------- the game ----------
  function create(canvas, spec, opts = {}) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const MODES = ['platform', 'topdown', 'racer', 'shmup'];
    const mode = MODES.includes(spec.mode) ? spec.mode : 'platform';
    // Racer and shmup scroll the world past you; you never walk, you steer.
    const scrolling = mode === 'racer' || mode === 'shmup';
    // Two on one screen. Netlink is a later problem; this is the sofa.
    const coop = !!(spec.coop || spec.players === 2);
    const scrollCfg = Object.assign({ speed: 46, accel: 2.6, max: 130 }, spec.scroll || {});
    let scroll = 0;
    /* A game is a run of stages, not one room. A spec may carry `levels` - a
       list of them - or the older single `level`, which becomes a run of one
       so nothing that already exists has to change. Score, lives and keys
       carry across; the level, its cast, its scenery and its story do not. */
    const stageList = (Array.isArray(spec.levels) && spec.levels.length
      ? spec.levels.slice(0, 24)
      : [{ name: spec.name, level: spec.level, entities: spec.entities,
           props: spec.props, story: spec.story, start: spec.start,
           rules: spec.rules, cut: spec.cut }]);
    let stageIndex = 0, stageStory = [], scoreAtStage = 0;
    let cutT = 0, cutLines = [];
    let lvl = makeLevel(stageList[0].level || { w: 20, h: 18, tiles: '' });

    /* Decor. Props are scenery drawn from the sprite atlas and nothing else:
       no collision, no rules, no script access. That is deliberate - it means
       a level can be dressed with any of the atlas's 1078 drawings without any
       of them being able to change how the game plays. */
    let props = [];
    const rand = rng(spec.seed || 'neojutsu');
    const view = { w: canvas.width, h: canvas.height, x: 0, y: 0 };

    const P = Object.assign({ speed: 82, accel: 700, friction: 820, jump: 205, gravity: 560,
                              maxFall: 240, char: 'hero',
                              doubleJump: false, wallJump: false, dash: false, attack: false },
                            spec.player || {});
    const input = { left: false, right: false, up: false, down: false, a: false, b: false };
    const input2 = { left: false, right: false, up: false, down: false, a: false, b: false };
    let player, players, entities, state, score, keys, lives, message, elapsed, won;
    let doorsOpen, respawn, fired, effects, messageAt, shake = 0;
    /* Speech. A message is the game talking to the room; a bubble is a
       character talking, anchored to whoever said it and gone a few seconds
       later. Stories are made of these. */
    let bubbles = [], toldBeats;

    // Bodies are made wherever a stage says to start, so arriving in stage
    // three works the same way as arriving in stage one.
    function spawnBodies(start) {
      const auto = (window.NeoSprites && window.NeoSprites.playerFor(mode, spec.cat)) ?? null;
      const body = (n, inp, dx) => ({
        n, input: inp, tint: n === 2 ? (P.tint2 || '#ff2e88') : (P.tint || '#2ef2ff'),
        char: n === 2 ? (P.char2 || 'ninja') : P.char,
        sprite: (n === 2 ? P.sprite2 : P.sprite) ?? auto,
        x: start.x + dx, y: start.y, w: 6, h: 12, vx: 0, vy: 0, grounded: false,
        face: 1, coyote: 0, buffer: 0, walk: 0,
        wall: 0, dash: 0, dashLeft: P.dash ? 1 : 0, doubleLeft: P.doubleJump ? 1 : 0,
        shotCool: 0, shotHeld: false, bWasDown: false, aWasDown: false,
        // A moment of grace on arriving, so a turret already aimed at
        // the spawn cannot land a hit before anyone has moved.
        hurt: P.grace ?? 1.1,
      });
      // Player two stands a little to the side so the pair do not begin
      // inside one another.
      players = coop ? [body(1, input, 0), body(2, input2, 10)] : [body(1, input, 0)];
      player = players[0];
    }

    // Everything a stage owns. What the player has earned is not here, which
    // is the whole point of stages: the room changes, the run continues.
    function loadStage(i) {
      stageIndex = Math.max(0, Math.min(stageList.length - 1, i | 0));
      const st = stageList[stageIndex] || {};
      lvl = makeLevel(st.level || { w: 20, h: 18, tiles: '' });
      props = (st.props || []).map(pr => ({
        i: pr.i | 0, x: Math.round(pr.x) || 0, y: Math.round(pr.y) || 0,
        t: typeof pr.t === 'string' ? pr.t.slice(0, 24) : '', b: !!pr.b,
      })).slice(0, 600);
      entities = (st.entities || []).map(makeEntity);
      stageStory = Array.isArray(st.story) ? st.story : [];
      toldBeats = new Set();
      bubbles = [];
      scoreAtStage = score;
      const start = st.start || { x: TILE, y: TILE };
      respawn = { x: start.x, y: start.y };
      spawnBodies(start);
      view.x = 0; view.y = 0;
      scroll = scrollCfg.speed;
      if (scrolling) {
        view.y = Math.max(0, lvl.h * TILE - view.h);
        view.x = Math.max(0, Math.min(view.x, lvl.w * TILE - view.w));
      }
      doorsOpen = false; effects = []; shake = 0;
      message = ''; messageAt = 0;
      threads = [];
    }

    function stageRules() {
      const st = stageList[stageIndex] || {};
      return st.rules || spec.rules || {};
    }

    function reset() {
      score = 0; keys = 0; lives = spec.lives ?? 3; elapsed = 0; won = false;
      state = 'play'; cutT = 0; cutLines = [];
      fired = [];
      if (scriptEnv) { scriptEnv.vars = {}; scriptFault = ''; scriptLog = []; }
      loadStage(0);
      if (program) fire('start');
    }
    // The script sees numbers and may call actions. It never sees the engine,
    // the page, or anything it could use to reach either.
    let program = null, scriptLog = [], scriptFault = '';
    /* A firing is a thread now, not an instant. Most of them run to the end
       in the frame they start - a script with no wait in it behaves exactly
       as it always did - but one that waits carries on across seconds. */
    let threads = [];
    const MAX_THREADS = 8;
    function compileScript() {
      scriptLog = []; scriptFault = '';
      if (!spec.script || !window.NeoScript) { program = null; return { errors: [] }; }
      const r = window.NeoScript.compile(spec.script);
      program = r.empty ? null : r;
      return r;
    }
    compileScript();

    const scriptEnv = {
      vars: {},
      random: () => rand(),
      read(name) {
        switch (name) {
          case 'score': return score; case 'keys': return keys; case 'lives': return lives;
          case 'time': return elapsed; case 'x': return player.x / TILE; case 'y': return player.y / TILE;
          case 'vx': return player.vx; case 'vy': return player.vy;
          case 'enemies': return entities.filter(e => e.alive && e.def.enemy).length;
          case 'coins': return entities.filter(e => e.alive && e.def.collect && !e.def.key).length;
          case 'deaths': return (spec.lives ?? 3) - lives;
          case 'grounded': return player.grounded ? 1 : 0;
          case 'facing': return player.face;
        }
        return 0;
      },
      act(name, args) {
        const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
        switch (name) {
          case 'message': message = String(args[0]).slice(0, 24).toUpperCase(); messageAt = elapsed; break;
          case 'win': state = 'won'; won = true; message = 'CLEAR'; break;
          case 'lose': state = 'over'; message = 'GAME OVER'; break;
          case 'open': doorsOpen = true; break;
          case 'give': score += Math.max(-99, Math.min(99, Math.round(n(args[0])))); break;
          case 'hurt': die(); break;
          case 'heal': lives = Math.max(0, Math.min(9, lives + Math.round(n(args[0])))); break;
          case 'spawn': {
            if (entities.length > 400) break;                       // a script cannot flood the level
            const type = String(args[0]);
            if (!Object.prototype.hasOwnProperty.call(ENTITY, type)) break;
            entities.push(makeEntity({ type, x: n(args[1]) * TILE, y: n(args[2]) * TILE }));
            break;
          }
          case 'tile': {
            const tx = Math.round(n(args[0])), ty = Math.round(n(args[1])), id = Math.round(n(args[2]));
            if (tx >= 0 && ty >= 0 && tx < lvl.w && ty < lvl.h && TILES[id]) lvl.tiles[ty * lvl.w + tx] = id;
            break;
          }
          case 'warp': player.x = n(args[0]) * TILE; player.y = n(args[1]) * TILE; player.vx = player.vy = 0; break;
          case 'push': player.vx += Math.max(-400, Math.min(400, n(args[0])));
                       player.vy += Math.max(-400, Math.min(400, n(args[1]))); break;
          case 'gravity': P.gravity = Math.max(0, Math.min(2000, n(args[0]))); break;
          case 'speed': P.speed = Math.max(10, Math.min(400, n(args[0]))); break;
          case 'shake': shake = Math.max(0, Math.min(8, n(args[0]))); break;
          // talk "hello"  -  the player speaks
          // talk "guard" "halt"  -  whoever carries that tag speaks
          case 'talk':
            if (args.length >= 2) speak(args[1], String(args[0]));
            else speak(args[0], 'player');
            break;
          /* Actors. Most of a real game's script is aimed at a named thing in
             the level rather than at the world in general, so these take a
             tag and act on everything wearing it. */
          case 'move': {
            for (const e of tagged(args[0])) {
              e.goal = { x: Math.max(0, Math.min(lvl.w - 1, Math.round(n(args[1])))) * TILE,
                         y: Math.max(0, Math.min(lvl.h - 1, Math.round(n(args[2])))) * TILE };
            }
            break;
          }
          case 'stop': for (const e of tagged(args[0])) { e.goal = null; e.vx = 0; e.vy = 0; } break;
          case 'hide': for (const e of tagged(args[0])) e.hidden = true; break;
          case 'show': for (const e of tagged(args[0])) e.hidden = false; break;
          case 'face': for (const e of tagged(args[0])) { const d = n(args[1]) < 0 ? -1 : 1; e.vx = Math.abs(e.vx) * d; e.face = d; } break;
          case 'setsprite': for (const e of tagged(args[0])) e.sprite = Math.max(0, Math.round(n(args[1]))); break;
          case 'remove': for (const e of tagged(args[0])) { e.alive = false; effects.push({ kind: 'pop', x: e.x, y: e.y, t: 0 }); } break;
          case 'shoot': {
            const deg = args.length > 1 ? n(args[1]) : 90;      // 90 is straight down
            const rad = deg * Math.PI / 180;
            for (const e of tagged(args[0])) {
              if (entities.length > 400) break;
              const shot = makeEntity({ type: 'shot', x: e.x + e.w / 2 - 1, y: e.y + e.h / 2 - 1 });
              shot.vx = Math.cos(rad) * ENTITY.shot.speed * 0.8;
              shot.vy = Math.sin(rad) * ENTITY.shot.speed * 0.8;
              shot.foe = true;
              entities.push(shot);
            }
            say('shoot');
            break;
          }
          case 'print': if (scriptLog.length < 50) scriptLog.push(String(args[0]).slice(0, 80)); break;
        }
      },
      fault(msg) { if (!scriptFault) scriptFault = msg; },
    };
    // Every actor wearing a tag. Naming several the same is how a script
    // commands a group without knowing how many there are.
    function tagged(name) {
      const t = String(name);
      return t ? entities.filter(e => e.alive && e.tag === t) : [];
    }

    // Who is talking: a body, an entity with a matching tag, or the player.
    function speaker(who) {
      if (!who || who === 'player' || who === 'p1') return players[0];
      if (who === 'p2') return players[1] || players[0];
      const tagged = entities.find(e => e.alive && e.tag === who);
      return tagged || players[0];
    }
    function speak(text, who, secs) {
      const t = String(text ?? '').slice(0, 120);
      if (!t) return;
      const from = speaker(who);
      // One voice at a time per speaker, so a chatty script cannot stack
      // bubbles into a wall of text.
      bubbles = bubbles.filter(b => b.from !== from);
      if (bubbles.length >= 4) bubbles.shift();
      bubbles.push({ from, text: t, t: 0, life: Math.max(1, Math.min(12, secs || 2.6)) });
      say('talk');
    }

    const say = name => { if (opts.onEvent) opts.onEvent(name); };
    function pumpThreads(dt) {
      if (!threads.length) return;
      for (const t of threads) {
        window.NeoScript.resume(t, dt);
        if (t.fault && !scriptFault) scriptFault = t.fault;
      }
      threads = threads.filter(t => !t.done);
    }

    const fire = name => {
      say(name);
      storyEvent(name);
      if (!program) return;
      // Per-frame logic runs one at a time; starting a new `on tick` while the
      // last one is still waiting would pile up a thread a frame forever.
      if (name === 'tick' && threads.some(t => t.event === 'tick')) return;
      if (threads.length >= MAX_THREADS) return;
      const t = window.NeoScript.makeThread(program, name, scriptEnv);
      if (!t) return;
      // Run it once immediately, so anything without a wait finishes now.
      window.NeoScript.resume(t, 0);
      if (t.fault && !scriptFault) scriptFault = t.fault;
      if (!t.done) threads.push(t);
    };

    // Only now, because reset fires the script's start event.
    reset();

    /* Lives are shared. Two people on one sofa losing separate life counts
       turns co-op into two solo games sitting next to each other; one pool
       makes the other player's mistake your problem, which is the point. */
    function die(p) {
      p = p || player;
      if (p.hurt > 0) return;
      lives--; p.hurt = Math.max(1.1, P.grace ?? 1.1); fire('hurt');
      effects.push({ kind: 'pop', x: p.x, y: p.y, t: 0 });
      if (lives <= 0) { state = 'over'; message = 'GAME OVER'; say('lose'); }
      else {
        p.x = respawn.x; p.y = respawn.y;
        p.vx = p.vy = 0; p.dash = 0;
      }
    }

    function step(dt) {
      // A card between stages: nothing moves, the clock still runs, and when
      // it is done the next stage is standing there ready.
      if (state === 'cut') {
        cutT += dt; elapsed += dt;
        for (const b of bubbles) b.t += dt;
        if (cutT >= CUT_SECS) { loadStage(stageIndex + 1); state = 'play'; cutT = 0; }
        return;
      }
      if (state !== 'play') return;
      elapsed += dt;
      const ctx2 = { doorsOpen };
      // The world scrolls once, not once per body.
      if (scrolling) {
        scroll = Math.min(scrollCfg.max, scroll + scrollCfg.accel * dt);
        view.y -= scroll * dt;
      }
      for (const b of players) stepBody(b, b.input, dt, ctx2);
      if (scrolling && view.y <= 0) { view.y = 0; finish(); }
      updateEntities(dt, ctx2);
      runTriggers();
      runStory();
      pumpThreads(dt);
      for (const b of bubbles) b.t += dt;
      bubbles = bubbles.filter(b => b.t < b.life);
      fire('tick');
      if (shake > 0) shake = Math.max(0, shake - dt * 12);
    }

    // One body's frame: steering, jumping, tiles underfoot, collision. It is
    // the same code for one player or two - the only difference is which
    // input map is handed in.
    function stepBody(player, input, dt, ctx2) {
      const wasFalling = player.vy > 0;
      const on = tilesUnder(lvl, player);
      const has = k => on.some(t => t.info[k]);
      const onLadder = has('ladder'), inWater = has('water');
      const beltTile = on.find(t => t.info.belt);
      let iceFloor = false;

      // horizontal
      const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      const groundInfo = player.grounded ? tileInfo(lvl.at(Math.floor((player.x + player.w / 2) / TILE),
                                                           Math.floor((player.y + player.h + 1) / TILE))) : null;
      iceFloor = !!(groundInfo && groundInfo.ice);
      // Ice keeps most of the steering but almost none of the braking, which is
      // what makes it feel slippery instead of merely slow.
      const grip = iceFloor ? 0.55 : 1;
      const brake = iceFloor ? 0.06 : 1;
      if (player.dash > 0) {
        player.dash -= dt;
        player.vx = player.face * P.speed * 2.4;
      } else {
        if (dir) { player.vx += dir * P.accel * grip * dt; player.face = dir; }
        else player.vx -= Math.sign(player.vx) * Math.min(Math.abs(player.vx), P.friction * brake * dt);
        const cap = inWater ? P.speed * 0.7 : P.speed;
        player.vx = Math.max(-cap, Math.min(cap, player.vx));
      }
      // a dash is a short burst on B, and only once per airtime
      if (P.dash && input.b && !player.bWasDown && player.dashLeft > 0 && player.dash <= 0) {
        player.dash = 0.16; player.dashLeft--; player.vy = 0;
      }
      player.bWasDown = input.b;

      if (scrolling) {
        // The world comes to you. Steering is direct in both axes, there is no
        // gravity, and the far edge of the level is the finish line.
        const dirY = (input.down ? 1 : 0) - (input.up ? 1 : 0);
        player.vx = dir * P.speed * 1.15;
        player.vy = dirY * P.speed * (mode === 'racer' ? 1.15 : 0.85);
        // carried along by the scroll, so standing still still means moving
        player.y -= scroll * dt;
      } else if (mode === 'platform') {
        player.coyote = player.grounded ? 0.09 : Math.max(0, player.coyote - dt);
        const jumpHeld = input.a || input.up;
        if (jumpHeld && !player.aWasDown) player.buffer = 0.12;
        else player.buffer = Math.max(0, player.buffer - dt);

        if (onLadder) {
          // On a ladder gravity stops and up/down is direct movement.
          player.vy = ((input.down ? 1 : 0) - (input.up ? 1 : 0)) * P.speed * 0.8;
          player.doubleLeft = P.doubleJump ? 1 : 0;
          player.dashLeft = P.dash ? 1 : 0;
          if (player.buffer > 0 && jumpHeld && input.left === input.right) { /* hold still on the ladder */ }
        } else if (player.buffer > 0 && player.coyote > 0) {
          player.vy = -P.jump; player.grounded = false; player.coyote = 0; player.buffer = 0; say('jump');
        } else if (player.buffer > 0 && P.wallJump && player.wall && !player.grounded) {
          // Kick away from the wall, which is what makes a wall jump readable.
          player.vy = -P.jump * 0.95; player.vx = -player.wall * P.speed * 1.1;
          player.face = -player.wall; player.buffer = 0; player.doubleLeft = P.doubleJump ? 1 : 0; say('doubleJump');
        } else if (player.buffer > 0 && player.doubleLeft > 0 && !player.grounded) {
          player.vy = -P.jump * 0.86; player.doubleLeft--; player.buffer = 0; say('doubleJump');
        }
        if (!jumpHeld && player.vy < -40) player.vy *= 0.55;
        player.aWasDown = jumpHeld;

        if (!onLadder) {
          const g = inWater ? P.gravity * 0.25 : P.gravity;
          const maxFall = inWater ? 60 : P.maxFall;
          player.vy = Math.min(maxFall, player.vy + g * dt);
          // swimming: A gives a steady paddle upward rather than a jump
          if (inWater && (input.a || input.up)) player.vy = -50;
          // sliding down a wall is slower than falling
          if (P.wallJump && player.wall && player.vy > 30 && !player.grounded) player.vy = 30;
        }
      } else {
        const vdir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
        player.vy = vdir * P.speed;
      }

      if (scrolling) {
        player.x += player.vx * dt;
        player.y += player.vy * dt;
        // Held inside the frame: there is nowhere to go but forward.
        player.x = Math.max(view.x + 1, Math.min(player.x, view.x + view.w - player.w - 1));
        player.y = Math.max(view.y + 1, Math.min(player.y, view.y + view.h - player.h - 1));
        for (const t of tilesUnder(lvl, player)) {
          if (t.info.hazard || (mode === 'racer' && t.info.solid === true)) { die(player); break; }
          if (mode === 'shmup' && t.info.solid === true) {
            // walls stop you rather than kill you
            player.x -= player.vx * dt; player.y -= player.vy * dt;
            break;
          }
        }
        if (P.attack && mode === 'shmup' && input.a && player.shotCool <= 0) {
          const shot = makeEntity({ type: 'shot', x: player.x + 1, y: player.y - 4 });
          shot.vx = 0; shot.vy = -ENTITY.shot.speed * 1.4;
          entities.push(shot); player.shotCool = 0.22; say('shoot');
        }
        player.shotCool = Math.max(0, player.shotCool - dt);
        player.walk += Math.abs(player.vx) * dt * 0.35;
        if (player.hurt > 0) player.hurt = Math.max(0, player.hurt - dt);
        return;
      }

      player.grounded = false;
      const hx = moveAxis(player, lvl, player.vx * dt, 0, wasFalling, ctx2);
      player.wall = (!player.grounded && hx.wall) ? hx.wall : 0;
      const hy = moveAxis(player, lvl, 0, player.vy * dt, wasFalling, ctx2);
      // Probe for ground rather than trusting the collision that just happened:
      // a body resting flush on a tile does not collide every frame.
      if (!player.grounded && player.vy >= 0) {
        const fy = Math.floor((player.y + player.h + 1) / TILE);
        for (let tx = Math.floor(player.x / TILE); tx <= Math.floor((player.x + player.w - 1) / TILE); tx++) {
          if (solidAt(lvl, tx, fy, ctx2) || oneWayAt(lvl, tx, fy)) {
            player.grounded = true;
            if (!hy.floor) hy.floor = { tx, ty: fy };
            break;
          }
        }
      }
      if (player.grounded) { player.doubleLeft = P.doubleJump ? 1 : 0; player.dashLeft = P.dash ? 1 : 0; }
      player.walk += Math.abs(player.vx) * dt * 0.35;
      if (player.hurt > 0) player.hurt = Math.max(0, player.hurt - dt);

      // conveyor belts carry a body that is standing on them
      if (player.grounded && hy.floor) {
        const f = tileInfo(lvl.at(hy.floor.tx, hy.floor.ty));
        if (f.belt) player.x += f.belt * dt;
        if (f.spring) { say('spring'); player.vy = -P.jump * f.spring; player.grounded = false; effects.push({ kind: 'pop', x: hy.floor.tx * TILE + 4, y: hy.floor.ty * TILE, t: 0 }); }
      }
      // headbutting a breakable tile destroys it
      if (hy.ceil) {
        const c = tileInfo(lvl.at(hy.ceil.tx, hy.ceil.ty));
        if (c.breakable) { say('break'); breakTile(hy.ceil.tx, hy.ceil.ty); }
      }
      if (beltTile && !player.grounded) { /* belts only act underfoot */ }

      // tile effects the body is standing inside
      for (const t of on) {
        if (t.info.hazard) { die(player); break; }
        if (t.info.checkpoint && (respawn.x !== t.tx * TILE || respawn.y !== t.ty * TILE)) {
          respawn = { x: t.tx * TILE, y: t.ty * TILE };
          message = 'CHECKPOINT'; messageAt = elapsed; say('checkpoint');
        }
        if (t.info.exit) finish();
      }
      if (player.y > lvl.h * TILE + 40) die(player);

      // player shots
      if (P.attack && input.b && !player.shotHeld && player.shotCool <= 0 && player.dash <= 0) {
        entities.push(makeEntity({ type: 'shot', x: player.x + (player.face > 0 ? player.w : -3), y: player.y + 4 }));
        entities[entities.length - 1].vx = player.face * ENTITY.shot.speed;
        player.shotCool = 0.28; say('shoot');
      }
      player.shotHeld = input.b;
      player.shotCool = Math.max(0, player.shotCool - dt);
    }

    function breakTile(tx, ty) {
      lvl.tiles[ty * lvl.w + tx] = 0;
      effects.push({ kind: 'break', x: tx * TILE, y: ty * TILE, t: 0 });
    }

    const CUT_SECS = 2.4;

    // What the card between two stages says. A stage may write its own line;
    // otherwise it is told where it is, which is the least a game owes you.
    function cutTextFor(st, n) {
      const own = st && st.cut;
      if (Array.isArray(own)) return own.slice(0, 3).map(t => String(t).slice(0, 28).toUpperCase());
      if (typeof own === 'string' && own.trim()) {
        return own.split('|').slice(0, 3).map(t => t.trim().slice(0, 28).toUpperCase());
      }
      const lines = [`STAGE ${n + 1}`];
      if (st && st.name) lines.push(String(st.name).slice(0, 28).toUpperCase());
      return lines;
    }

    function finish() {
      const need = stageRules().collect || 0;
      const got = score - scoreAtStage;
      if (got < need) { message = `${need - got} TO GO`; messageAt = elapsed; return; }
      if (stageIndex + 1 < stageList.length) {
        // Not won - moved on. Lives, score and keys come with you.
        cutLines = cutTextFor(stageList[stageIndex + 1], stageIndex + 1);
        cutT = 0; state = 'cut'; say('checkpoint');
      } else {
        state = 'won'; won = true; message = 'CLEAR'; say('win');
      }
    }

    // With two on screen an enemy has to choose. It chooses the nearer one,
    // which is also what a player expects when they step in front of a turret
    // to draw fire off the other.
    function nearest(e) {
      let best = players[0], bestD = Infinity;
      for (const b of players) {
        const d = Math.hypot((b.x + b.w / 2) - (e.x + e.w / 2), (b.y + b.h / 2) - (e.y + e.h / 2));
        if (d < bestD) { bestD = d; best = b; }
      }
      return best;
    }

    function updateEntities(dt, ctx2) {
      for (const e of entities) {
        if (!e.alive) continue;
        // Hidden is off stage: it does not move, and nothing can touch it.
        if (e.hidden) continue;
        const d = e.def;

        /* Sent somewhere by a script. A goal overrides whatever the thing
           would do on its own, which is what makes a guard walk to the gate
           in a cutscene instead of patrolling through it. */
        if (e.goal) {
          const gx = e.goal.x - e.x, gy = e.goal.y - e.y;
          const dist = Math.hypot(gx, gy);
          const sp = Math.max(14, d.speed || 30);
          if (dist <= sp * dt + 0.5) {
            e.x = e.goal.x; e.y = e.goal.y; e.goal = null; e.vx = 0; e.vy = 0;
          } else {
            e.vx = gx / dist * sp; e.vy = gy / dist * sp;
            e.x += e.vx * dt; e.y += e.vy * dt;
            if (e.vx) e.face = e.vx > 0 ? 1 : -1;
          }
        } else if (d.bullet) {
          e.x += e.vx * dt; e.y += e.vy * dt; e.life += dt;
          if (e.life > 2.2 || solidAt(lvl, Math.floor(e.x / TILE), Math.floor(e.y / TILE), ctx2)) { e.alive = false; continue; }
        } else if (d.platform) {
          // A moving platform carries whatever is riding it.
          e.t += dt;
          const nx = e.home.x + Math.sin(e.t * (e.def.speed / d.span) * 2) * d.span;
          const riders = players.filter(b => b.grounded && b.y + b.h <= e.y + 3 &&
                                              b.x + b.w > e.x && b.x < e.x + e.w);
          const dxp = nx - e.x; e.x = nx;
          for (const b of riders) { b.x += dxp; b.y = e.y - b.h; }
        } else if (d.enemy && !d.still) {
          if (d.chases) {
            const target = nearest(e);
            const dx = (target.x + target.w / 2) - (e.x + e.w / 2);
            const dy = (target.y + target.h / 2) - (e.y + e.h / 2);
            const near = Math.hypot(dx, dy) < d.sight;
            e.vx = near ? Math.sign(dx) * d.speed : 0;
            if (mode === 'topdown') { e.vy = near ? Math.sign(dy) * d.speed : 0; e.y += e.vy * dt; }
            e.x += e.vx * dt;
            if (solidAt(lvl, Math.floor((e.x + (e.vx > 0 ? e.w : 0)) / TILE), Math.floor((e.y + e.h / 2) / TILE), ctx2)) e.x -= e.vx * dt;
          } else if (d.floats) {
            e.t += dt; e.y = e.home.y + Math.sin(e.t * 2) * 10; e.x += e.vx * dt;
            if (solidAt(lvl, Math.floor((e.x + (e.vx > 0 ? e.w : 0)) / TILE), Math.floor(e.y / TILE), ctx2)) e.vx *= -1;
          } else if (d.hops) {
            e.vy = Math.min(P.maxFall, e.vy + P.gravity * dt);
            e.grounded = false;
            moveAxis(e, lvl, e.vx * dt, 0, e.vy > 0, ctx2);
            moveAxis(e, lvl, 0, e.vy * dt, e.vy > 0, ctx2);
            if (e.grounded) { e.cool -= dt; if (e.cool <= 0) { e.vy = -150; e.cool = 0.9 + (e.id % 5) * 0.12; } }
          } else {
            e.x += e.vx * dt;
            const ahead = Math.floor((e.x + (e.vx > 0 ? e.w + 1 : -1)) / TILE);
            const foot = Math.floor((e.y + e.h + 1) / TILE);
            const mid = Math.floor((e.y + e.h / 2) / TILE);
            if (solidAt(lvl, ahead, mid, ctx2) || (d.turns && !solidAt(lvl, ahead, foot, ctx2))) {
              e.vx *= -1; e.x += e.vx * dt;
            }
          }
        }
        if (d.fires) {
          e.cool -= dt;
          if (e.cool <= 0) {
            e.cool = d.fires;
            const target = nearest(e);
            const dx = (target.x + target.w / 2) - (e.x + e.w / 2);
            const dy = (target.y + target.h / 2) - (e.y + e.h / 2);
            const len = Math.hypot(dx, dy) || 1;
            if (len < 140) {
              const shot = makeEntity({ type: 'shot', x: e.x + 2, y: e.y + 2 });
              shot.vx = dx / len * ENTITY.shot.speed * 0.7;
              shot.vy = dy / len * ENTITY.shot.speed * 0.7;
              shot.foe = true; entities.push(shot);
            }
          }
        }

        // player shots hurt enemies
        if (d.bullet && !e.foe) {
          for (const other of entities) {
            if (!other.alive || !other.def.enemy || other.def.hp >= 99) continue;
            if (!overlaps(e, other)) continue;
            other.hp -= 1; e.alive = false;
            if (other.hp <= 0) { other.alive = false; score += 1; effects.push({ kind: 'pop', x: other.x, y: other.y, t: 0 }); fire('kill'); }
            break;
          }
          if (!e.alive) continue;
        }

        for (const b of players) {
          if (e.hidden || !overlaps(b, e)) continue;
          if (d.collect) {
            e.alive = false;
            say(d.key ? 'key' : d.score >= 5 ? 'gem' : 'coin');
            if (d.key) keys++;
            else if (d.heal) lives = Math.min(9, lives + 1);
            else score += d.score || 1;
            effects.push({ kind: 'pop', x: e.x, y: e.y, t: 0 });
            fire('collect');
          } else if (d.goal) {
            finish();
          } else if ((d.enemy || (d.bullet && e.foe)) && b.hurt <= 0) {
            if (d.bullet) { e.alive = false; die(b); }
            else if (mode === 'platform' && b.vy > 40 && b.y + b.h - b.vy * dt <= e.y + 4 && !d.still) {
              e.hp -= 1;
              b.vy = -P.jump * 0.7;
              if (e.hp <= 0) { e.alive = false; score += 1; effects.push({ kind: 'pop', x: e.x, y: e.y, t: 0 }); fire('kill'); }
            } else die(b);
          }
          if (!e.alive) break;
        }
      }
      entities = entities.filter(e => e.alive || !e.def.bullet);
      for (const fx of effects) fx.t += dt;
      effects = effects.filter(fx => fx.t < 0.35);
    }

    // ---------- triggers ----------
    // The scriptable layer: a handful of conditions and consequences, declared
    // in the game's own JSON. Small on purpose, so a person - or a model - can
    // write one without learning a language.
    /* A story is a list of beats, each with one condition and one line. It
       is data, not code: it packages, validates and travels like the level
       does, and a person writing one never has to learn the script. */
    function runStory() {
      const beats = stageStory;
      if (!Array.isArray(beats)) return;
      for (let i = 0; i < beats.length && i < 60; i++) {
        const s = beats[i];
        if (!s || toldBeats.has(i)) continue;
        let due = false;
        if (s.at !== undefined) due = elapsed >= s.at;
        else if (s.score !== undefined) due = score >= s.score;
        else if (s.keys !== undefined) due = keys >= s.keys;
        else if (s.reach !== undefined) due = players.some(b => b.x >= s.reach * TILE);
        else if (s.on !== undefined) due = false;                  // fired by event, below
        if (!due) continue;
        toldBeats.add(i);
        speak(s.text, s.who, s.secs);
      }
    }
    // Beats that wait for something to happen rather than for a number.
    function storyEvent(name) {
      const beats = stageStory;
      if (!Array.isArray(beats)) return;
      for (let i = 0; i < beats.length && i < 60; i++) {
        const s = beats[i];
        if (s && s.on === name && !toldBeats.has(i)) { toldBeats.add(i); speak(s.text, s.who, s.secs); }
      }
    }

    function runTriggers() {
      const list = spec.triggers || [];
      for (let i = 0; i < list.length; i++) {
        const tr = list[i];
        if (fired[i] && tr.once !== false) continue;
        const w = tr.when || {};
        let ok = false;
        if (w.score !== undefined) ok = score >= w.score;
        else if (w.keys !== undefined) ok = keys >= w.keys;
        else if (w.enemiesLeft !== undefined) ok = entities.filter(e => e.alive && e.def.enemy).length <= w.enemiesLeft;
        else if (w.reach) ok = player.x >= (w.reach.x ?? 0) * TILE && player.y >= (w.reach.y ?? -1e9) * TILE;
        else if (w.time !== undefined) ok = elapsed >= w.time;
        if (!ok) continue;
        fired[i] = true;
        act(tr.do || {});
      }
      // doors open on their own once every key is held, which is the rule people expect
      if (!doorsOpen && spec.rules && spec.rules.keys && keys >= spec.rules.keys) doorsOpen = true;
    }
    function act(a) {
      if (a.openDoors) doorsOpen = true;
      if (a.message) { message = String(a.message).slice(0, 24).toUpperCase(); messageAt = elapsed; }
      if (a.win) { state = 'won'; won = true; message = 'CLEAR'; }
      if (a.lose) { state = 'over'; message = 'GAME OVER'; }
      if (a.spawn) entities.push(makeEntity(a.spawn));
      if (a.setTile) lvl.tiles[a.setTile.y * lvl.w + a.setTile.x] = a.setTile.id;
      if (a.give) score += a.give;
    }

    // ---------- drawing ----------
    function camera() {
      if (scrolling) {
        view.x = Math.max(0, Math.min(view.x, Math.max(0, lvl.w * TILE - view.w)));
        view.y = Math.max(0, Math.min(view.y, Math.max(0, lvl.h * TILE - view.h)));
        return;
      }
      // While building, the camera is the builder's, not the player's.
      if (freeCam) {
        view.x = Math.max(0, Math.min(view.x, Math.max(0, lvl.w * TILE - view.w)));
        view.y = Math.max(0, Math.min(view.y, Math.max(0, lvl.h * TILE - view.h)));
        return;
      }
      const dead = view.w * 0.22;
      // With two players the camera follows the pair's midpoint, so neither
      // is the one who owns the screen.
      let px = 0, py = 0;
      for (const b of players) { px += b.x + b.w / 2; py += b.y + b.h / 2; }
      px /= players.length; py /= players.length;
      if (px - view.x < dead) view.x = px - dead;
      if (px - view.x > view.w - dead) view.x = px - (view.w - dead);
      const deadY = view.h * 0.3;
      if (py - view.y < deadY) view.y = py - deadY;
      if (py - view.y > view.h - deadY) view.y = py - (view.h - deadY);
      view.x = Math.max(0, Math.min(view.x, lvl.w * TILE - view.w));
      view.y = Math.max(0, Math.min(view.y, Math.max(0, lvl.h * TILE - view.h)));
    }

    function draw() {
      camera();
      const sx0 = shake ? (rand() - .5) * shake * 2 : 0, sy0 = shake ? (rand() - .5) * shake * 2 : 0;
      const ox = Math.round(view.x + sx0), oy = Math.round(view.y + sy0);

      // Sprite art if the atlas is up, the engine's own rectangles if not.
      // The fallback is not decorative: a packaged game opened somewhere the
      // image will not decode still has to be playable.
      const art = window.NeoSprites;
      const useArt = !!(art && art.loaded && spec.sprites !== false);
      const cat = spec.cat || '';

      function drawProps(back) {
        for (const pr of props) {
          if (!!pr.b !== back) continue;
          const px = Math.round(pr.x - ox), py = Math.round(pr.y - oy);
          if (px < -24 || px > view.w + 24 || py < -24 || py > view.h + 24) continue;
          art.draw(ctx, pr.i, px, py, { colour: pr.t || '#6f6890' });
        }
      }
      const sky = ctx.createLinearGradient(0, 0, 0, view.h);
      sky.addColorStop(0, spec.sky0 || '#1b2a5c'); sky.addColorStop(1, spec.sky1 || '#7fc4e8');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, view.w, view.h);

      if (useArt) drawProps(true);

      const x0 = Math.floor(ox / TILE), x1 = Math.ceil((ox + view.w) / TILE);
      const y0 = Math.floor(oy / TILE), y1 = Math.ceil((oy + view.h) / TILE);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const info = tileInfo(lvl.at(tx, ty));
          if (!info.fill && !info.top) continue;
          const sx = tx * TILE - ox, sy = ty * TILE - oy;
          if (info.fill) { ctx.fillStyle = info.fill; ctx.fillRect(sx, sy, TILE, TILE); }
          if (info.decor && info.top) { ctx.fillStyle = info.top; ctx.fillRect(sx + 2, sy + 1, TILE - 4, TILE - 2); }
          const open = !tileInfo(lvl.at(tx, ty - 1)).fill;
          if (info.top && open) {
            ctx.fillStyle = info.top; ctx.fillRect(sx, sy, TILE, 2);
            // a little texture on the exposed face, so a wide floor is not a slab
            ctx.fillStyle = 'rgba(255,255,255,.10)';
            ctx.fillRect(sx + ((tx * 3) % TILE), sy + 3, 2, 1);
          }
          if (info.hazard && open) {
            ctx.fillStyle = info.top;
            for (let i = 0; i < 2; i++) {
              const bx = sx + i * 4;
              ctx.beginPath(); ctx.moveTo(bx, sy + TILE); ctx.lineTo(bx + 2, sy + 1); ctx.lineTo(bx + 4, sy + TILE);
              ctx.closePath(); ctx.fill();
            }
          }
        }
      }

      if (useArt) drawProps(false);

      for (const e of entities) {
        if (!e.alive || e.hidden) continue;
        const sx = Math.round(e.x - ox), sy = Math.round(e.y - oy);
        if (sx < -16 || sx > view.w + 16) continue;
        if (useArt && drawEntityArt(e, sx, sy, cat)) continue;
        if (e.def.collect) {
          const bob = Math.sin(elapsed * 4 + e.t) * 1.5;
          ctx.fillStyle = e.def.key ? '#2ef2ff' : e.def.heal ? '#ff2e88' : '#ffd23f';
          ctx.fillRect(sx, sy + bob, e.w, e.h);
          ctx.fillStyle = '#fff8d0'; ctx.fillRect(sx + 1, sy + bob + 1, 2, 2);
        } else if (e.def.goal) {
          ctx.fillStyle = '#0d0a16'; ctx.fillRect(sx + 3, sy, 2, e.h);
          const wave = Math.sin(elapsed * 6) * 1.5;
          ctx.fillStyle = (spec.rules && spec.rules.collect && score < spec.rules.collect) ? '#7a7a8a' : '#3fbf4a';
          ctx.fillRect(sx + 5, sy + 1 + wave, 8, 6);
        } else if (e.def.bullet) {
          ctx.fillStyle = e.foe ? '#ff5a3c' : '#2ef2ff';
          ctx.fillRect(sx, sy, e.w, e.h);
        } else if (e.def.platform) {
          ctx.fillStyle = '#241a0e'; ctx.fillRect(sx, sy, e.w, e.h);
          ctx.fillStyle = '#c08a4a'; ctx.fillRect(sx, sy, e.w, 2);
        } else {
          ctx.fillStyle = '#0a0714'; ctx.fillRect(sx - 1, sy - 1, e.w + 2, e.h + 2);
          ctx.fillStyle = e.def.chases ? '#ff2e88' : e.def.fires ? '#c060ff'
                        : e.def.hops ? '#ffd23f' : e.def.floats ? '#c060ff' : '#ff5a3c';
          ctx.fillRect(sx, sy, e.w, e.h);
          if (e.def.fires) { ctx.fillStyle = '#0a0714'; ctx.fillRect(sx + 2, sy + 2, e.w - 4, e.h - 4); }
          ctx.fillStyle = '#fff';
          ctx.fillRect(sx + (e.vx > 0 ? e.w - 3 : 1), sy + 2, 2, 2);
          if (e.hp > 1) { ctx.fillStyle = '#ffd23f'; ctx.fillRect(sx, sy - 3, Math.min(e.w, e.hp * 3), 1); }
        }
      }

      // One sprite for one entity. The choice is pinned to the entity's home
      // tile rather than its runtime id, so a level looks the same after a
      // restart and on someone else's machine - the same promise the seeded
      // audio and video make.
      function drawEntityArt(e, sx, sy, cat) {
        const idx = typeof e.sprite === 'number' && e.sprite !== null
          ? e.sprite
          : art.forEntity(e.type, cat, e.home.x * 7 + e.home.y * 13);
        if (idx == null) return false;
        const locked = spec.rules && spec.rules.collect && score < spec.rules.collect;
        const colour = e.def.key ? '#2ef2ff'
                     : e.def.heal ? '#ff2e88'
                     : e.def.collect ? '#ffd23f'
                     : e.def.goal ? (locked ? '#7a7a8a' : '#3fbf4a')
                     : e.def.chases ? '#ff2e88'
                     : e.def.fires ? '#c060ff'
                     : e.def.hops ? '#ffd23f'
                     : e.def.floats ? '#c060ff' : '#ff5a3c';
        // Collectibles bob; walkers take a one-pixel step. The art has no
        // animation frames, so the motion has to come from the transform.
        const bob = e.def.collect || e.def.goal ? Math.sin(elapsed * 4 + e.t) * 1.5
                  : Math.abs(e.vx) > 2 ? (Math.floor(elapsed * 9 + e.t) % 2) * -1 : 0;
        const ok = art.draw(ctx, idx, sx + e.w / 2, sy + e.h + bob,
                            { colour, outline: '#0a0714', flip: e.vx > 0 });
        if (ok && e.def.enemy && e.hp > 1) {
          ctx.fillStyle = '#ffd23f';
          ctx.fillRect(sx, sy - 5, Math.min(e.w, e.hp * 3), 1);
        }
        return ok;
      }

      // the players, drawn with the studio's own character sprites
      const chars = window.NeoScene && window.NeoScene.CHARS;
      for (const b of players) {
        if (b.hurt > 0 && Math.floor(b.hurt * 20) % 2) continue;      // blink while stunned
        const psx = Math.round(b.x + b.w / 2 - ox), psy = Math.round(b.y + b.h - oy);
        const pStep = b.grounded && Math.abs(b.vx) > 6 ? (Math.floor(elapsed * 10) % 2) * -1 : 0;
        // A vehicle steers, it does not turn around, so it is never mirrored.
        const vehicle = useArt && art.VEHICLES.has(b.sprite);
        const pArt = useArt && typeof b.sprite === 'number'
          && art.draw(ctx, b.sprite, psx, psy + pStep,
                      { colour: b.tint, outline: '#0a0714', flip: !vehicle && b.face < 0 });
        if (pArt) { /* drawn from the atlas */ }
        else if (chars && chars[b.char]) window.NeoScene.drawChar(ctx, chars[b.char], psx, psy, 1, b.walk, b.face);
        else { ctx.fillStyle = b.tint; ctx.fillRect(psx - 3, psy - 12, 6, 12); }
        // A marker over player two, so nobody has to ask which one they are.
        if (coop && b.n === 2) { ctx.fillStyle = b.tint; ctx.fillRect(psx - 1, psy - b.h - 5, 2, 2); }
      }

      /* Speech bubbles. Drawn after the cast so nothing stands in front of a
         line of dialogue, and clamped into the frame so a character speaking
         at the edge of the screen is still readable. */
      const placed = [];
      for (const bub of bubbles) {
        const who = bub.from;
        if (!who) continue;
        ctx.font = '5px "Press Start 2P", monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        const maxW = Math.min(96, view.w - 8);
        const words = bub.text.split(/\s+/);
        const lines = [];
        let line = '';
        for (const w of words) {
          const next = line ? line + ' ' + w : w;
          if (ctx.measureText(next).width > maxW - 8 && line) { lines.push(line); line = w; }
          else line = next;
          if (lines.length >= 3) break;
        }
        if (line && lines.length < 3) lines.push(line);
        if (!lines.length) continue;
        const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width)) + 8);
        const bh = lines.length * 7 + 6;
        let bx = Math.round(who.x + who.w / 2 - ox - bw / 2);
        let by = Math.round(who.y - oy - bh - 6);
        bx = Math.max(2, Math.min(bx, view.w - bw - 2));
        by = Math.max(2, Math.min(by, view.h - bh - 2));
        // Two characters standing together would otherwise talk over each
        // other. Stack the later line above the earlier one.
        for (let guard = 0; guard < 4; guard++) {
          const clash = placed.find(q => bx < q.x + q.w + 2 && bx + bw + 2 > q.x
                                      && by < q.y + q.h + 2 && by + bh + 2 > q.y);
          if (!clash) break;
          by = clash.y - bh - 3;
          if (by < 2) { by = clash.y + clash.h + 3; break; }
        }
        placed.push({ x: bx, y: by, w: bw, h: bh });
        const fade = Math.min(1, (bub.life - bub.t) / 0.4);
        ctx.globalAlpha = Math.max(0, fade);
        ctx.fillStyle = '#0a0714';
        ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
        ctx.fillStyle = '#ece8f5';
        ctx.fillRect(bx, by, bw, bh);
        // a tail pointing back at whoever is speaking
        const tx = Math.max(bx + 2, Math.min(Math.round(who.x + who.w / 2 - ox) - 2, bx + bw - 6));
        ctx.fillRect(tx, by + bh, 4, 2);
        ctx.fillRect(tx + 1, by + bh + 2, 2, 2);
        ctx.fillStyle = '#14111f';
        for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], bx + 4, by + 4 + i * 7);
        ctx.globalAlpha = 1;
      }

      /* The card between stages. Drawn over the frame rather than instead of
         it, so you can see the place you just finished behind the words - the
         cheapest way to make a run feel like one journey rather than a series
         of unrelated rooms. */
      if (state === 'cut') {
        const fade = Math.min(1, cutT / 0.25) * Math.min(1, (CUT_SECS - cutT) / 0.35);
        ctx.fillStyle = `rgba(5,4,10,${0.72 * Math.max(0, fade)})`;
        ctx.fillRect(0, 0, view.w, view.h);
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const top = Math.round(view.h / 2 - (cutLines.length * 12) / 2);
        cutLines.forEach((line, i) => {
          ctx.fillStyle = '#000';
          ctx.fillText(line, view.w / 2 + 1, top + i * 12 + 1);
          ctx.fillStyle = i === 0 ? '#ffd23f' : '#ece8f5';
          ctx.fillText(line, view.w / 2, top + i * 12);
        });
        ctx.textAlign = 'left';
      }

      for (const fx of effects) {
        const a = 1 - fx.t / 0.35, r = 2 + fx.t * 22;
        ctx.fillStyle = fx.kind === 'break' ? `rgba(200,150,90,${a})` : `rgba(255,246,200,${a})`;
        for (let i = 0; i < 6; i++) {
          const ang = i * 1.047;
          ctx.fillRect(Math.round(fx.x - ox + Math.cos(ang) * r), Math.round(fx.y - oy + Math.sin(ang) * r), 2, 2);
        }
      }

      if (opts.hud !== false) {
        ctx.fillStyle = 'rgba(5,4,10,.55)'; ctx.fillRect(0, 0, view.w, 9);
        ctx.font = '6px "Press Start 2P", monospace'; ctx.textBaseline = 'top';
        ctx.fillStyle = '#ffd23f'; ctx.fillText(`${score}`, 12, 2);
        ctx.fillRect(3, 2, 5, 5);
        ctx.fillStyle = '#ff2e88';
        for (let i = 0; i < lives; i++) ctx.fillRect(view.w - 6 - i * 7, 2, 5, 5);
        if (scrolling) {
          const total = Math.max(1, lvl.h * TILE - view.h);
          const done = 1 - view.y / total;
          ctx.fillStyle = '#2a2340'; ctx.fillRect(0, 8, view.w, 1);
          ctx.fillStyle = '#2ef2ff'; ctx.fillRect(0, 8, Math.round(view.w * done), 1);
        }
        if (keys) { ctx.fillStyle = '#2ef2ff'; ctx.fillText(`${keys}`, 40, 2); }
        if (stageList.length > 1) {
          ctx.fillStyle = '#9a92b3';
          ctx.fillText(`${stageIndex + 1}/${stageList.length}`, view.w / 2 - 14, 2);
        }
      }
      if (state !== 'play' || message) {
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        const fresh = elapsed - messageAt < 1.6;
        const text = state === 'won' ? 'CLEAR' : state === 'over' ? 'GAME OVER' : (fresh ? message : '');
        if (text) {
          ctx.fillStyle = '#000'; ctx.fillText(text, view.w / 2 + 1, view.h / 2 + 1);
          ctx.fillStyle = state === 'won' ? '#3fbf4a' : '#ffffff';
          ctx.fillText(text, view.w / 2, view.h / 2);
        }
        ctx.textAlign = 'left';
      }
    }

    // ---------- loop ----------
    let raf = 0, last = 0, acc = 0, running = false, freeCam = false;
    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.25, (now - last) / 1000 || 0); last = now;
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < MAX_CATCHUP) { step(STEP); acc -= STEP; n++; }
      if (n === MAX_CATCHUP) acc = 0;
      draw();
      if (opts.onFrame) opts.onFrame(api);
    }

    const api = {
      get state() { return state; },
      get score() { return score; },
      get lives() { return lives; },
      get player() { return player; },
      get players() { return players; },
      get bubbles() { return bubbles; },
      speak(text, who, secs) { speak(text, who, secs); },
      get coop() { return coop; },
      get level() { return lvl; },
      get mode() { return mode; },
      get view() { return view; },
      get freeCam() { return freeCam; },
      set freeCam(v) { freeCam = !!v; if (!v) camera(); draw(); },
      panBy(dx, dy) { view.x += dx; view.y += dy; camera(); draw(); },
      panTo(x, y) { view.x = x; view.y = y; camera(); draw(); },
      get scriptLog() { return scriptLog; },
      // What the script has remembered, and how many sequences are running.
      scriptState() { return scriptEnv ? scriptEnv.vars : {}; },
      get scriptThreads() { return threads.length; },
      get scriptFault() { return scriptFault; },
      setScript(src) { spec.script = src; const r = compileScript(); reset(); draw(); return r; },
      get entities() { return entities; },
      get elapsed() { return elapsed; },
      input,
      input2,
      start() { if (running) return; running = true; last = performance.now(); acc = 0; raf = requestAnimationFrame(frame); },
      stop() { running = false; cancelAnimationFrame(raf); },
      reset() { reset(); view.x = view.y = 0; draw(); },
      // Stepping by hand is what makes the engine testable without a clock.
      tick(seconds) { const t = seconds ?? STEP; let left = t; while (left > 1e-6) { const s = Math.min(STEP, left); step(s); left -= s; } draw(); },
      draw,
      spec,
      setTile(tx, ty, id) {
        if (tx < 0 || ty < 0 || tx >= lvl.w || ty >= lvl.h) return false;
        lvl.tiles[ty * lvl.w + tx] = id; draw(); return true;
      },
      addEntity(e) { const made = makeEntity(e); entities.push(made); draw(); return made; },
      get entities() { return entities; },
      get props() { return props; },
      addProp(pr) {
        if (props.length >= 600) return null;
        const made = { i: pr.i | 0, x: Math.round(pr.x) || 0, y: Math.round(pr.y) || 0,
                       t: typeof pr.t === 'string' ? pr.t.slice(0, 24) : '', b: !!pr.b };
        props.push(made); draw(); return made;
      },
      // Topmost first, so clicking removes what you can actually see.
      removePropAt(x, y) {
        for (let i = props.length - 1; i >= 0; i--) {
          const pr = props[i];
          const box = window.NeoSprites && window.NeoSprites.box(pr.i);
          const w = box ? box.w : 8, h = box ? box.h : 8;
          if (x >= pr.x - w / 2 - 1 && x <= pr.x + w / 2 + 1 && y >= pr.y - h - 1 && y <= pr.y + 1) {
            props.splice(i, 1); draw(); return true;
          }
        }
        return false;
      },
      setProps(list) { props = (list || []).map(pr => ({ i: pr.i | 0, x: pr.x | 0, y: pr.y | 0, t: pr.t || '', b: !!pr.b })).slice(0, 600); draw(); },
      removeEntityAt(x, y) {
        for (let i = entities.length - 1; i >= 0; i--) {
          const e = entities[i];
          if (x >= e.x - 2 && x <= e.x + e.w + 2 && y >= e.y - 2 && y <= e.y + e.h + 2) {
            entities.splice(i, 1); draw(); return true;
          }
        }
        return false;
      },
      // What the studio saves: the live tilemap and entity placements.
      get stage() { return stageIndex; },
      get stages() { return stageList.length; },
      // Skip the card, for a studio that does not want to wait for it.
      skipCut() { if (state === 'cut') { loadStage(stageIndex + 1); state = 'play'; cutT = 0; } },
      goToStage(i) { loadStage(i); state = 'play'; cutT = 0; draw(); },
      snapshot() {
        const here = {
          level: { w: lvl.w, h: lvl.h, tiles: Array.from(lvl.tiles) },
          entities: entities.map(e => ({ type: e.type, x: Math.round(e.home.x), y: Math.round(e.home.y),
                                         dir: e.vx < 0 ? -1 : 1 })),
          props: props.map(pr => ({ i: pr.i, x: pr.x, y: pr.y, ...(pr.t ? { t: pr.t } : {}), ...(pr.b ? { b: 1 } : {}) })),
        };
        const out = { ...spec, ...here };
        /* Editing stage three and saving must not write those edits into the
           top-level level while `levels` keeps the version you started from -
           the edits would vanish the next time the game was built. The stage
           you are standing in is written back into the run. */
        if (stageList.length > 1 || Array.isArray(spec.levels)) {
          out.levels = stageList.map((st, i) => (i === stageIndex
            ? { ...st, ...here, story: stageStory }
            : st));
        }
        return out;
      },
    };
    draw();
    return api;
  }

  // ---------- validation ----------
  // A game may arrive from a shared link, a file, or one day a model. None of
  // those are trusted, so a spec is checked before it is played: not for style,
  // but for the things that make a game unplayable or unsafe to run.
  function validate(spec) {
    const errors = [], warnings = [];
    const bad = m => errors.push(m);
    if (!spec || typeof spec !== 'object') return { ok: false, errors: ['not an object'], warnings };

    /* A run of stages is checked stage by stage, each on the same terms a
       single-level game is held to. A run whose third room cannot be finished
       is as broken as one whose first cannot, and finding that out on arrival
       is too late. */
    if (Array.isArray(spec.levels)) {
      if (!spec.levels.length) bad('levels is empty');
      if (spec.levels.length > 24) bad(`too many stages (${spec.levels.length})`);
      spec.levels.forEach((st, i) => {
        if (!st || typeof st !== 'object') { bad(`stage ${i + 1} is not a stage`); return; }
        const one = { ...spec, ...st, levels: undefined,
                      rules: st.rules || spec.rules, lives: spec.lives };
        const r = validate(one);
        for (const e of r.errors) bad(`stage ${i + 1}: ${e}`);
        for (const w of r.warnings) warnings.push(`stage ${i + 1}: ${w}`);
        if (st.cut !== undefined && !(typeof st.cut === 'string' || Array.isArray(st.cut)))
          bad(`stage ${i + 1}: cut must be a line or a list of them`);
      });
      return { ok: !errors.length, errors, warnings };
    }

    const lvl = spec.level;
    if (!lvl || !(lvl.w > 0) || !(lvl.h > 0)) bad('level needs a positive w and h');
    else {
      if (lvl.w * lvl.h > 40000) bad(`level is too large (${lvl.w}x${lvl.h})`);
      const rows = typeof lvl.tiles === 'string' ? lvl.tiles.trim().split('\n') : null;
      if (rows) {
        if (rows.length < lvl.h) warnings.push(`only ${rows.length} rows for a height of ${lvl.h}`);
        const wrong = rows.findIndex(r => r.length !== lvl.w);
        if (wrong >= 0) warnings.push(`row ${wrong} is ${rows[wrong].length} wide, expected ${lvl.w}`);
        const unknown = new Set();
        for (const r of rows) for (const ch of r) { const id = parseInt(ch, 36); if (!TILES[id]) unknown.add(ch); }
        if (unknown.size) bad(`unknown tiles: ${[...unknown].slice(0, 6).join(', ')}`);
      } else if (!Array.isArray(lvl.tiles)) bad('level.tiles must be rows of digits or an array');
    }

    const ents = spec.entities || [];
    if (!Array.isArray(ents)) bad('entities must be a list');
    else {
      if (ents.length > 400) bad(`too many entities (${ents.length})`);
      const unknown = [...new Set(ents.filter(e => !ENTITY[e && e.type]).map(e => e && e.type))];
      if (unknown.length) bad(`unknown entity types: ${unknown.slice(0, 5).join(', ')}`);
      if (lvl && lvl.w) {
        const off = ents.filter(e => e && (e.x < 0 || e.y < 0 || e.x > lvl.w * TILE || e.y > lvl.h * TILE));
        if (off.length) warnings.push(`${off.length} piece(s) sit outside the level`);
      }
    }

    const story = spec.story;
    if (story !== undefined) {
      if (!Array.isArray(story)) bad('story must be a list');
      else {
        if (story.length > 60) bad(`too many story beats (${story.length})`);
        const KEYS = ['at', 'score', 'keys', 'reach', 'on'];
        story.forEach((beat, i) => {
          if (!beat || typeof beat !== 'object') { bad(`story beat ${i + 1} is not a beat`); return; }
          if (typeof beat.text !== 'string' || !beat.text.trim()) bad(`story beat ${i + 1} has no line to say`);
          else if (beat.text.length > 120) bad(`story beat ${i + 1} is too long`);
          const cues = KEYS.filter(k => beat[k] !== undefined);
          if (cues.length !== 1) bad(`story beat ${i + 1} needs exactly one cue, has ${cues.length}`);
          if (beat.on !== undefined && !window.NeoScript.EVENTS.includes(beat.on))
            bad(`story beat ${i + 1} waits for an event that never happens: ${beat.on}`);
        });
      }
    }

    const props = spec.props;
    if (props !== undefined) {
      if (!Array.isArray(props)) bad('props must be a list');
      else {
        if (props.length > 600) bad(`too much decor (${props.length} props)`);
        const wrong = props.filter(pr => !pr || typeof pr.i !== 'number'
                                      || !Number.isFinite(pr.x) || !Number.isFinite(pr.y));
        if (wrong.length) bad(`${wrong.length} prop(s) are missing a sprite or a position`);
        const tint = props.filter(pr => pr && pr.t !== undefined
                                     && !(typeof pr.t === 'string' && /^#[0-9a-f]{3,8}$/i.test(pr.t)));
        if (tint.length) bad(`${tint.length} prop(s) have a tint that is not a colour`);
      }
    }

    // A game nobody can finish is a broken game, so the goal is checked too.
    const need = (spec.rules && spec.rules.collect) || 0;
    /* Only what actually raises the score counts. A heart heals and a key
       unlocks; neither adds a point, so counting them here once passed a
       game that asked for fourteen when thirteen was all anyone could get.
       A gem is worth five, so the total is a sum and not a tally. */
    const scoring = ents.filter(e => e && ENTITY[e.type] && ENTITY[e.type].collect
                                  && !ENTITY[e.type].key && !ENTITY[e.type].heal);
    const reachable = scoring.reduce((n, e) => n + (ENTITY[e.type].score || 1), 0);
    if (need > reachable) bad(`rules.collect is ${need} but only ${reachable} point(s) can be collected`);
    const keysNeeded = (spec.rules && spec.rules.keys) || 0;
    const keys = ents.filter(e => e && e.type === 'key').length;
    if (keysNeeded > keys) bad(`rules.keys is ${keysNeeded} but only ${keys} key(s) exist`);
    const hasEnd = ents.some(e => e && ENTITY[e.type] && ENTITY[e.type].goal);
    const scriptWins = typeof spec.script === 'string' && /\bwin\b/.test(spec.script);
    if (!hasEnd && !scriptWins) warnings.push('no goal and no script that wins - the game cannot be completed');

    if (spec.script !== undefined) {
      if (typeof spec.script !== 'string') bad('script must be text');
      else if (spec.script.length > 20000) bad('script is too long');
      else if (window.NeoScript) {
        const r = window.NeoScript.compile(spec.script);
        for (const e of r.errors.slice(0, 6)) bad(`script: ${e}`);
      }
    }
    if (spec.start && (spec.start.x < 0 || spec.start.y < 0)) bad('start is outside the level');

    return { ok: !errors.length, errors, warnings };
  }

  window.NeoGame = { TILE, TILES, ENTITY, create, makeLevel, rng, validate };
})();
