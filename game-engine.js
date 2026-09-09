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
    /* A maze game is not a level with a flag at the end of it. Every dot has
       to go, and the one thing that turns the chase round is a pellet. */
    dot:    { w: 4, h: 4,  collect: true, score: 1 },
    pellet: { w: 7, h: 7,  collect: true, score: 5, scare: 7 },
    goal:   { w: 8, h: 12, goal: true },
    walker: { w: 8, h: 10, enemy: true, speed: 22, turns: true, hp: 1 },
    flyer:  { w: 8, h: 8,  enemy: true, speed: 26, floats: true, hp: 1 },
    chaser: { w: 8, h: 10, enemy: true, speed: 40, chases: true, sight: 90, hp: 2 },
    jumper: { w: 9, h: 9,  enemy: true, speed: 14, hops: true, hp: 1 },
    turret: { w: 8, h: 8,  enemy: true, speed: 0, fires: 1.4, hp: 3, still: true },
    // Hunts you and shoots back. A walker that fires is a soldier; a chaser
    // that fires is an enemy tank, and nothing else in the cast is both.
    hunter: { w: 8, h: 10, enemy: true, speed: 26, chases: true, sight: 110, fires: 1.7, hp: 2 },
    /* A ghost always knows where you are - that is the genre - so it is slow
       enough to be outrun instead. A chaser at its own speed catches a
       standing player in a second and a half, which makes a maze a coin flip
       rather than a chase. */
    ghost:  { w: 8, h: 10, enemy: true, speed: 30, chases: true, sight: 9999, hp: 1 },
    /* A formation moves as one thing, not as a crowd of things that happen to
       be next to each other: they step together, turn together at the wall,
       and drop a row when they turn. Taking one out speeds up the rest. */
    invader: { w: 8, h: 8, enemy: true, speed: 0, march: true, fires: 3.4, hp: 1 },
    spike:  { w: 8, h: 4,  enemy: true, speed: 0, still: true, hp: 99 },
    shot:   { w: 3, h: 3,  bullet: true, speed: 110 },
    mover:  { w: 16, h: 4, platform: true, speed: 26, span: 48 },
  };

  let entitySeq = 0;
  function makeEntity(e) {
    const def = ENTITY[e.type] || ENTITY.coin;
    return { id: ++entitySeq, type: e.type, x: e.x, y: e.y, w: def.w, h: def.h, def,
             vx: (def.speed || 0) * (e.dir === -1 ? -1 : 1), vy: 0, hp: def.hp || 1,
             /* Pace belongs to the thing, not to its kind. The def is shared
                by every walker in the level, so changing it changed all of
                them; this is the copy a script is allowed to touch. */
             speed: def.speed || 0,
             home: { x: e.x, y: e.y }, alive: true, t: (e.x * 7 + e.y * 13) % 628 / 100,
             life: 0, cool: 0, tag: e.tag || '',
             // What a script can change about an actor: where it is going,
             // whether it is on stage, and what it looks like.
             hidden: false, goal: null, sprite: (typeof e.sprite === 'number' ? e.sprite : null),
             /* When this thing starts moving. A maze game lets its hunters out
                one at a time rather than all four at the whistle, and a boss
                that waits for you to be in the room is the same idea. Until
                then it sits where it was put. */
             wake: e.wake || 0,
             to: e.to };
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
    /* `invaders` is a fixed screen: nothing scrolls, you hold the bottom of
       it and they come down to you. It is the one arcade shape this engine
       could not make - every other mode is a body travelling through a level,
       and this is a level travelling towards a body. */
    const MODES = ['platform', 'topdown', 'racer', 'shmup', 'invaders'];
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
    let stageIndex = 0, stageStory = [], scoreAtStage = 0, pendingStage = -1;
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
                              doubleJump: false, wallJump: false, dash: false, attack: false,
                              aimLock: false },
                            spec.player || {});
    const input = { left: false, right: false, up: false, down: false, a: false, b: false };
    const input2 = { left: false, right: false, up: false, down: false, a: false, b: false };
    let player, players, entities, state, score, keys, lives, message, elapsed, won;
    let doorsOpen, respawn, fired, effects, messageAt, shake = 0;
    // How long the things chasing you have left to be afraid of you.
    let scared = 0;
    /* Speech. A message is the game talking to the room; a bubble is a
       character talking, anchored to whoever said it and gone a few seconds
       later. Stories are made of these. */
    let bubbles = [], toldBeats, emotes = [], camHold = null;

    // Bodies are made wherever a stage says to start, so arriving in stage
    // three works the same way as arriving in stage one.
    function spawnBodies(start) {
      const auto = (window.NeoSprites && window.NeoSprites.playerFor(mode, spec.cat)) ?? null;
      const body = (n, inp, dx) => ({
        n, input: inp, tint: n === 2 ? (P.tint2 || '#ff2e88') : (P.tint || '#2ef2ff'),
        char: n === 2 ? (P.char2 || 'ninja') : P.char,
        sprite: (n === 2 ? P.sprite2 : P.sprite) ?? auto,
        x: start.x + dx, y: start.y, w: 6, h: 12, vx: 0, vy: 0, grounded: false,
        face: 1, aimX: 1, aimY: 0, coyote: 0, buffer: 0, walk: 0,
        wall: 0, dash: 0, dashLeft: P.dash ? 1 : 0, doubleLeft: P.doubleJump ? 1 : 0,
        shotCool: 0, shotHeld: false, bWasDown: false, aWasDown: false,
        // A script may command a body the same way it commands an actor.
        hidden: false, goal: null, def: { speed: P.speed },
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
      bubbles = []; emotes = []; camHold = null;
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
      doorsOpen = false; effects = []; shake = 0; scared = 0;
      message = ''; messageAt = 0;
      threads = [];
    }

    /* Which room is meant. A number counts from one, a name matches the
       stage's own - both because a script written by a person says "the
       cave" and a script written by a machine says 2. */
    function findStage(which) {
      if (typeof which === 'string') {
        const want = which.trim().toLowerCase();
        const byName = stageList.findIndex(st => String(st.name || '').trim().toLowerCase() === want);
        if (byName >= 0) return byName;
        const asNum = parseInt(want, 10);
        return Number.isFinite(asNum) ? asNum - 1 : -1;
      }
      const i = Math.round(Number(which) || 0) - 1;
      return Number.isFinite(i) ? i : -1;
    }

    // Leave for another room, with the card in between.
    function leaveFor(target, quiet) {
      if (!(target >= 0 && target < stageList.length) || target === stageIndex) return false;
      pendingStage = target;
      cutLines = cutTextFor(stageList[target], target);
      cutT = 0; state = 'cut';
      if (!quiet) say('checkpoint');
      return true;
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
      /* The same questions, asked about something other than you. A tag may
         name several things - "guard" could be three of them - and the first
         one is the answer, which is what `move "guard"` already assumes. */
      ask(name, args) {
        const who = tagged(args[0])[0];
        if (!who) return 0;
        switch (name) {
          case 'x': return who.x / TILE;
          case 'y': return who.y / TILE;
          /* Four ways, as one number: right 1, left -1, down 2, up -2.
             Only an overhead body has an aim worth reading; everything else
             faces the way it is travelling. */
          case 'dir':
            if (mode === 'topdown' && (who.aimX || who.aimY)) {
              return who.aimY ? (who.aimY > 0 ? 2 : -2) : who.aimX;
            }
            return who.face || (who.vx > 0 ? 1 : who.vx < 0 ? -1 : 1);
          // Standing on a tile, give or take: an actor mid-step is still there.
          case 'at': return (Math.abs(who.x / TILE - args[1]) < 0.75 &&
                             Math.abs(who.y / TILE - args[2]) < 0.75) ? 1 : 0;
          case 'near': {
            const to = tagged('player')[0] || player;
            return Math.hypot((who.x - to.x) / TILE, (who.y - to.y) / TILE) <= args[1] ? 1 : 0;
          }
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
          /* `speed 120` is how fast you are; `speed "guard" 40` is how fast
             something else is. A guard that charges and a boss that speeds up
             are the same word aimed at a different thing. */
          case 'speed':
            if (args.length > 1) {
              const v = Math.max(0, Math.min(400, n(args[1])));
              for (const e of tagged(args[0])) {
                if (e.n) { P.speed = Math.max(10, v); continue; }   // a body, not an actor
                // Keep it going the way it was going, only faster or slower.
                const was = Math.hypot(e.vx, e.vy);
                if (was > 0.01) { e.vx = e.vx / was * v; e.vy = e.vy / was * v; }
                else if (e.speed) { e.vx = Math.sign(e.vx || 1) * v; }
                e.speed = v;
              }
            } else P.speed = Math.max(10, Math.min(400, n(args[0])));
            break;
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
          // A door. `goto 2` or `goto "the cave"` - the thing 26 of the
          // sample project's events did and ours could not say at all.
          case 'goto': leaveFor(findStage(args[0])); break;
          // Move an actor by an amount rather than to a place.
          case 'nudge': {
            for (const e of tagged(args[0])) {
              e.goal = { x: Math.max(0, Math.min((lvl.w - 1) * TILE, e.x + n(args[1]) * TILE)),
                         y: Math.max(0, Math.min((lvl.h - 1) * TILE, e.y + n(args[2]) * TILE)) };
            }
            break;
          }
          // Put something somewhere, rather than walking it there.
          case 'place': {
            for (const e of tagged(args[0])) {
              e.x = Math.max(0, Math.min(lvl.w - 1, Math.round(n(args[1])))) * TILE;
              e.y = Math.max(0, Math.min(lvl.h - 1, Math.round(n(args[2])))) * TILE;
              e.goal = null; e.vx = 0; e.vy = 0;
            }
            break;
          }
          // A mark over someone's head: surprise, a question, an idea.
          case 'emote': {
            const marks = { '!': 672, '?': 674, 'note': 823, 'heart': 529, 'skull': 622 };
            const which = marks[String(args[1] ?? '!').toLowerCase()] ?? 672;
            for (const e of tagged(args[0])) emotes.push({ who: e, i: which, t: 0 });
            break;
          }
          /* Camera. `camera 10 6` holds on a tile; `camera follow` gives it
             back. A hundred of their commands move the camera, and a
             cutscene that cannot look somewhere is not a cutscene. */
          case 'camera': {
            const first = String(args[0] ?? '').toLowerCase();
            if (first === 'follow' || first === 'player') { camHold = null; break; }
            camHold = { x: n(args[0]) * TILE - view.w / 2, y: n(args[1]) * TILE - view.h / 2 };
            break;
          }
          case 'sound': say(String(args[0])); break;
          case 'print': if (scriptLog.length < 50) scriptLog.push(String(args[0]).slice(0, 80)); break;
        }
      },
      fault(msg) { if (!scriptFault) scriptFault = msg; },
    };
    // Every actor wearing a tag. Naming several the same is how a script
    // commands a group without knowing how many there are.
    function tagged(name) {
      const t = String(name);
      if (!t) return [];
      /* "player" and "p2" address the bodies. Their games aim a third of all
         actor commands at the player, and ours could not name it at all -
         every one of those lines was dropped on the way in. */
      if (t === 'player' || t === 'p1') return players.slice(0, 1);
      if (t === 'p2') return players.slice(1, 2);
      if (t === 'players') return players.slice();
      return entities.filter(e => e.alive && e.tag === t);
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
        if (cutT >= CUT_SECS) {
          loadStage(pendingStage >= 0 ? pendingStage : stageIndex + 1);
          pendingStage = -1; state = 'play'; cutT = 0;
        }
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
      if (mode === 'invaders') marchStep(dt);
      for (const b of players) stepBody(b, b.input, dt, ctx2);
      if (scrolling && view.y <= 0) { view.y = 0; finish(); }
      updateEntities(dt, ctx2);
      runTriggers();
      runStory();
      pumpThreads(dt);
      for (const b of bubbles) b.t += dt;
      bubbles = bubbles.filter(b => b.t < b.life);
      for (const em of emotes) em.t += dt;
      emotes = emotes.filter(em => em.t < 1.1 && em.who && em.who.alive !== false);
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

      /* A scripted walk. While a body has somewhere to be, the script steers
         and the keys do not - which is what a cutscene is made of. */
      let scripted = 0;
      if (player.goal) {
        const gx = player.goal.x - player.x;
        if (Math.abs(gx) <= P.speed * dt + 1) {
          player.x = player.goal.x;
          if (mode !== 'platform') player.y = player.goal.y;
          player.goal = null; player.vx = 0;
        } else scripted = gx > 0 ? 1 : -1;
      }

      // horizontal
      const dir = scripted || ((input.right ? 1 : 0) - (input.left ? 1 : 0));
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
      } else if (mode === 'invaders') {
        /* You hold the bottom of the screen and nothing else. One axis, no
           gravity, and the gun points up because there is only one place
           worth shooting. */
        player.vy = 0;
        player.y = (lvl.h - 3) * TILE;
        player.aimX = 0; player.aimY = -1;
        /* One shot on the screen at a time, the way this game has always
           worked: you fire again when the last one has landed or left, which
           is a rhythm rather than a cooldown. */
        const mine = entities.some(o => o.alive && o.def.bullet && !o.foe);
        if (P.attack && input.b && !mine) {
          const shot = makeEntity({ type: 'shot', x: player.x + player.w / 2 - 1.5, y: player.y - 4 });
          shot.vx = 0; shot.vy = -ENTITY.shot.speed * 1.3;
          entities.push(shot); say('shoot');
        }
        player.shotHeld = input.b;
      } else {
        const vdir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
        player.vy = vdir * P.speed;

        /* A tank turns its hull and its gun together. Holding A pins the gun
           where it is, so you can circle a target and keep shooting at it -
           there is no second stick on a Game Boy pad, and A is the button a
           top-down game leaves free. */
        const locked = !!(P.aimLock && input.a);

        /* Which way you point, in four directions rather than two. Walking
           sets it, so a shot goes where you are heading without a second key.
           Up and down win a diagonal: if right kept priority while you held
           up-and-right, nothing would ever aim up. */
        if (!locked) {
          if (vdir) { player.aimX = 0; player.aimY = vdir; }
          else if (dir) { player.aimX = dir; player.aimY = 0; }
        }

        /* Line up with the corridor you are in. A body twelve pixels tall in
           a sixteen-pixel corridor has four pixels of slack, and asking a
           player to find them by hand is what makes a maze unplayable - a bot
           that plays one for forty-five seconds ate three dots out of
           forty-five. Only ever on the axis you are not steering, so it never
           argues with a deliberate move, and through the velocity so the
           collision code still has the last word. */
        const pull = (at, to) => Math.max(-100, Math.min(100, (to - at) * 9));
        if (dir && !vdir) player.vy = pull(player.y, Math.round(player.y / TILE) * TILE);
        else if (vdir && !dir) player.vx = pull(player.x, Math.round(player.x / TILE) * TILE);
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
      // Invaders fires its own way, above, and must not fire again here.
      if (P.attack && mode !== 'invaders' && input.b && !player.shotHeld
          && player.shotCool <= 0 && player.dash <= 0) {
        // Sideways in a platformer; wherever you point in a top-down one.
        const ax = mode === 'topdown' ? player.aimX : player.face;
        const ay = mode === 'topdown' ? player.aimY : 0;
        const shot = makeEntity({
          type: 'shot',
          x: player.x + player.w / 2 - 1.5 + ax * (player.w / 2 + 2),
          y: player.y + player.h / 2 - 1.5 + ay * (player.h / 2 + 2),
        });
        shot.vx = ax * ENTITY.shot.speed;
        shot.vy = ay * ENTITY.shot.speed;
        entities.push(shot);
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

    function finish(to) {
      const need = stageRules().collect || 0;
      const got = score - scoreAtStage;
      if (got < need) { message = `${need - got} TO GO`; messageAt = elapsed; return; }
      // An exit may name where it goes, which is what makes a hub a hub
      // rather than a corridor.
      if (to !== undefined && to !== null && to !== '' && leaveFor(findStage(to))) return;
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

    /* The formation. Everything in it moves by the same amount at the same
       moment, turns at the wall together, and drops a row when it turns - a
       crowd of things each deciding for itself is not a formation, it is a
       swarm, and the whole tension of this game is that the wall is coming
       down one step at a time whatever you do.

       Fewer of them left means faster, which is the other half of it. */
    let marchDir = 1, marchStart = 0;
    function marchStep(dt) {
      const rank = entities.filter(e => e.alive && !e.hidden && e.def.march);
      if (!rank.length) return;
      if (!marchStart) marchStart = rank.length;

      const gone = 1 - rank.length / marchStart;
      const pace = 12 + gone * 46;
      let lo = Infinity, hi = -Infinity, low = -Infinity;
      for (const e of rank) {
        lo = Math.min(lo, e.x);
        hi = Math.max(hi, e.x + e.w);
        low = Math.max(low, e.y + e.h);
      }
      const edge = (marchDir > 0 && hi >= lvl.w * TILE - TILE)
                || (marchDir < 0 && lo <= TILE);
      if (edge) {
        marchDir *= -1;
        for (const e of rank) e.y += TILE;                 // down a row
        say('break');
      } else {
        for (const e of rank) e.x += marchDir * pace * dt;
      }
      // Reaching the floor is losing, however many lives are left.
      if (low >= (lvl.h - 2) * TILE) { lives = 0; state = 'over'; message = 'OVERRUN'; }
    }

    function updateEntities(dt, ctx2) {
      for (const e of entities) {
        if (!e.alive) continue;
        // Hidden is off stage: it does not move, and nothing can touch it.
        if (e.hidden) continue;
        const d = e.def;
        if (e.wake && elapsed < e.wake) continue;      // not out yet

        /* Sent somewhere by a script. A goal overrides whatever the thing
           would do on its own, which is what makes a guard walk to the gate
           in a cutscene instead of patrolling through it. */
        if (e.goal) {
          const gx = e.goal.x - e.x, gy = e.goal.y - e.y;
          const dist = Math.hypot(gx, gy);
          const sp = Math.max(14, e.speed || 30);
          if (dist <= sp * dt + 0.5) {
            e.x = e.goal.x; e.y = e.goal.y; e.goal = null; e.vx = 0; e.vy = 0;
          } else {
            e.vx = gx / dist * sp; e.vy = gy / dist * sp;
            e.x += e.vx * dt; e.y += e.vy * dt;
            if (e.vx) e.face = e.vx > 0 ? 1 : -1;
          }
        } else if (d.bullet) {
          e.x += e.vx * dt; e.y += e.vy * dt; e.life += dt;
          const bx = Math.floor(e.x / TILE), by = Math.floor(e.y / TILE);
          if (e.life > 2.2 || solidAt(lvl, bx, by, ctx2)) {
            /* A shot into a breakable wall takes the wall with it. That is
               what makes cover in a tank game something you spend rather than
               something you sit behind forever. Only your shots do it: an
               enemy demolishing its own arena is erosion, not a fight. */
            if (!e.foe && e.life <= 2.2 && tileInfo(lvl.at(bx, by)).breakable) {
              say('break'); breakTile(bx, by);
            }
            e.alive = false; continue;
          }
        } else if (d.platform) {
          // A moving platform carries whatever is riding it.
          e.t += dt;
          const nx = e.home.x + Math.sin(e.t * (e.speed / d.span) * 2) * d.span;
          const riders = players.filter(b => b.grounded && b.y + b.h <= e.y + 3 &&
                                              b.x + b.w > e.x && b.x < e.x + e.w);
          const dxp = nx - e.x; e.x = nx;
          for (const b of riders) { b.x += dxp; b.y = e.y - b.h; }
        } else if (d.enemy && !d.still && !d.march) {
          if (d.chases) {
            const target = nearest(e);
            const dx = (target.x + target.w / 2) - (e.x + e.w / 2);
            const dy = (target.y + target.h / 2) - (e.y + e.h / 2);
            /* Frightened, it goes the other way and goes slower, and it can
               see you from anywhere - a ghost that stopped fleeing because you
               were out of range would just wait for you round the corner. */
            const run = scared > 0 ? -1 : 1;
            const near = run < 0 || Math.hypot(dx, dy) < d.sight;
            const sp = e.speed * (run < 0 ? 0.6 : 1);
            e.vx = near ? Math.sign(dx) * sp * run : 0;
            if (mode === 'topdown') { e.vy = near ? Math.sign(dy) * sp * run : 0; e.y += e.vy * dt; }
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
            /* In a formation only the one at the bottom of its column shoots,
               and only a few bombs are in the air at once. Two dozen of them
               each firing on their own clock is seven bombs a second - a wall
               of fire that killed a standing player in under two, which is
               not a difficulty setting, it is a coin toss. */
            if (d.march) {
              const below = entities.some(o => o.alive && !o.hidden && o.def.march && o !== e
                && Math.abs(o.x - e.x) < e.w && o.y > e.y);
              if (below) continue;
              const inAir = entities.filter(o => o.alive && o.def.bullet && o.foe).length;
              if (inAir >= 3) continue;
            }
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
            /* The whole of a maze game in one line: for a few seconds the
               things chasing you are the things running away, and touching
               one is worth points rather than a life. */
            if (d.scare) { scared = d.scare; say('gem'); }
            effects.push({ kind: 'pop', x: e.x, y: e.y, t: 0 });
            fire('collect');
          } else if (d.goal) {
            finish(e.to);
          } else if (d.enemy && scared > 0 && !d.still) {
            // Caught while it was running: it goes, and it is worth taking.
            e.alive = false; score += 3;
            effects.push({ kind: 'pop', x: e.x, y: e.y, t: 0 });
            say('gem'); fire('kill');
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
      if (scared > 0) scared = Math.max(0, scared - dt);

      /* Two ways to finish that are not walking into a flag.

         `clearAll` is the maze game: every dot has to go, and there is no
         exit to reach because clearing the board is the exit. `clearFoes` is
         the arena: the room is the level and the last one standing wins.
         Without these, every game this engine can describe ends the same way,
         which is most of the reason they all felt like the same game. */
      const rules = stageRules();
      if (state === 'play' && (rules.clearAll || rules.clearFoes)) {
        const left = entities.filter(e => e.alive && !e.hidden &&
          (rules.clearAll ? e.def.collect && !e.def.key : e.def.enemy && e.def.hp < 99)).length;
        if (left === 0) finish();
      }

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
      if (camHold) {
        view.x = Math.max(0, Math.min(camHold.x, Math.max(0, lvl.w * TILE - view.w)));
        view.y = Math.max(0, Math.min(camHold.y, Math.max(0, lvl.h * TILE - view.h)));
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
          /* Side-on, a block is lit along the top because that is the face you
             can see. From overhead there is no top: a wall shows its edge on
             whichever sides have open floor beside them. Edging only the top
             is what made every overhead room read as a row of ledges. */
          if (mode === 'topdown' && info.top && !info.decor) {
            ctx.fillStyle = info.top;
            if (!tileInfo(lvl.at(tx, ty + 1)).fill) ctx.fillRect(sx, sy + TILE - 2, TILE, 2);
            if (!tileInfo(lvl.at(tx - 1, ty)).fill) ctx.fillRect(sx, sy, 2, TILE);
            if (!tileInfo(lvl.at(tx + 1, ty)).fill) ctx.fillRect(sx + TILE - 2, sy, 2, TILE);
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
        /* An enemy tank points where it is driving, for the same reason the
           player's does. Everything else keeps the mirror it always had. */
        const wheels = art.VEHICLES.has(idx) && mode === 'topdown';
        const ok = art.draw(ctx, idx, sx + e.w / 2, sy + e.h + bob,
                            { colour, outline: '#0a0714',
                              flip: !wheels && e.vx > 0,
                              turn: wheels ? art.turnFor(idx, e.vx, e.vy) : 0 });
        if (ok && e.def.enemy && e.hp > 1) {
          ctx.fillStyle = '#ffd23f';
          ctx.fillRect(sx, sy - 5, Math.min(e.w, e.hp * 3), 1);
        }
        return ok;
      }

      // the players, drawn with the studio's own character sprites
      const chars = window.NeoScene && window.NeoScene.CHARS;
      for (const b of players) {
        if (b.hidden) continue;                                       // taken off stage by a script
        if (b.hurt > 0 && Math.floor(b.hurt * 20) % 2) continue;      // blink while stunned
        const psx = Math.round(b.x + b.w / 2 - ox), psy = Math.round(b.y + b.h - oy);
        const pStep = b.grounded && Math.abs(b.vx) > 6 ? (Math.floor(elapsed * 10) % 2) * -1 : 0;
        // A vehicle steers, it does not turn around, so it is never mirrored.
        const vehicle = useArt && art.VEHICLES.has(b.sprite);
        /* Seen from above a vehicle points where it is pointing, so turn the
           art instead of mirroring it. A person is left alone: someone walking
           up the screen should not be lying on their side. The art is drawn
           facing right, so right is no turn and the rest follow clockwise. */
        const turn = (vehicle && mode === 'topdown') ? art.turnFor(b.sprite, b.aimX, b.aimY) : 0;
        const pArt = useArt && typeof b.sprite === 'number'
          && art.draw(ctx, b.sprite, psx, psy + pStep,
                      { colour: b.tint, outline: '#0a0714', turn,
                        flip: !vehicle && b.face < 0 });
        if (pArt) { /* drawn from the atlas */ }
        else if (chars && chars[b.char]) window.NeoScene.drawChar(ctx, chars[b.char], psx, psy, 1, b.walk, b.face);
        else { ctx.fillStyle = b.tint; ctx.fillRect(psx - 3, psy - 12, 6, 12); }
        // A marker over player two, so nobody has to ask which one they are.
        if (coop && b.n === 2) { ctx.fillStyle = b.tint; ctx.fillRect(psx - 1, psy - b.h - 5, 2, 2); }
      }

      /* Speech bubbles. Drawn after the cast so nothing stands in front of a
         line of dialogue, and clamped into the frame so a character speaking
         at the edge of the screen is still readable. */
      // A mark over someone's head, rising as it fades.
      if (useArt) for (const em of emotes) {
        const rise = Math.min(6, em.t * 26);
        art.draw(ctx, em.i, Math.round(em.who.x + em.who.w / 2 - ox),
                 Math.round(em.who.y - oy - 2 - rise),
                 { colour: '#ffd23f', outline: '#0a0714' });
      }

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
      get keys() { return keys; },
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
      // The story belongs to the stage you are standing in, not to the game,
      // so an editor reading spec.story on a run of three rooms saw nothing
      // and wrote to a key nobody reads.
      get story() { return stageStory; },
      setStory(list) {
        stageStory = Array.isArray(list) ? list.slice(0, 60) : [];
        toldBeats = new Set();
        return stageStory;
      },
      get stage() { return stageIndex; },
      get stages() { return stageList.length; },
      // Skip the card, for a studio that does not want to wait for it.
      skipCut() {
        if (state !== 'cut') return;
        loadStage(pendingStage >= 0 ? pendingStage : stageIndex + 1);
        pendingStage = -1; state = 'play'; cutT = 0;
      },
      goToStage(i) { loadStage(i); state = 'play'; cutT = 0; draw(); },
      snapshot() {
        const here = {
          level: { w: lvl.w, h: lvl.h, tiles: Array.from(lvl.tiles) },
          /* Everything the spec put on a piece comes back out again. A tag is
             how a script addresses it, `to` is where a door leads and `sprite`
             is what it was told to look like - all three were dropped here, so
             a game with a named guard in it lost the guard's name the first
             time anybody moved a tile. */
          entities: entities.map(e => ({ type: e.type, x: Math.round(e.home.x), y: Math.round(e.home.y),
                                         dir: e.vx < 0 ? -1 : 1,
                                         ...(e.tag ? { tag: e.tag } : {}),
                                         ...(e.wake ? { wake: e.wake } : {}),
                                         ...(e.to !== undefined ? { to: e.to } : {}),
                                         ...(typeof e.sprite === 'number' ? { sprite: e.sprite } : {}) })),
          props: props.map(pr => ({ i: pr.i, x: pr.x, y: pr.y, ...(pr.t ? { t: pr.t } : {}), ...(pr.b ? { b: 1 } : {}) })),
        };
        const out = { ...spec, ...here, story: stageStory };
        /* Editing stage three and saving must not write those edits into the
           top-level level while `levels` keeps the version you started from -
           the edits would vanish the next time the game was built. The stage
           you are standing in is written back into the run. */
        if (stageList.length > 1 || Array.isArray(spec.levels)) {
          out.levels = stageList.map((st, i) => (i === stageIndex
            ? { ...st, ...here, story: stageStory }
            : st));
          /* A run keeps its rooms on its stages. Leaving a top-level copy
             behind is a third of the file saying something nobody reads,
             and the first thing to go stale when a stage is edited. */
          delete out.story; delete out.level; delete out.entities; delete out.props;
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
    /* Clearing the board is an ending too. A maze game has no flag in it and
       an arena has no way out; saying they cannot be completed because there
       is no goal to walk into is the old assumption talking. */
    const r = spec.rules || {};
    if (r.clearAll && !scoring.length) bad('rules.clearAll but there is nothing to collect');
    if (r.clearFoes && !ents.some(e => e && ENTITY[e.type] && ENTITY[e.type].enemy
                                     && (ENTITY[e.type].hp || 1) < 99)) {
      bad('rules.clearFoes but there is nothing to clear');
    }
    if (!hasEnd && !scriptWins && !r.clearAll && !r.clearFoes) {
      warnings.push('no goal and no script that wins - the game cannot be completed');
    }

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
