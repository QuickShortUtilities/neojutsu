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
             life: 0, cool: 0, tag: e.tag || '' };
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
    const scrollCfg = Object.assign({ speed: 46, accel: 2.6, max: 130 }, spec.scroll || {});
    let scroll = 0;
    const lvl = makeLevel(spec.level || { w: 20, h: 18, tiles: '' });
    const rand = rng(spec.seed || 'neojutsu');
    const view = { w: canvas.width, h: canvas.height, x: 0, y: 0 };

    const P = Object.assign({ speed: 82, accel: 700, friction: 820, jump: 205, gravity: 560,
                              maxFall: 240, char: 'hero',
                              doubleJump: false, wallJump: false, dash: false, attack: false },
                            spec.player || {});
    let player, entities, state, score, keys, lives, message, elapsed, won;
    let doorsOpen, respawn, fired, effects, messageAt, shake = 0;

    function reset() {
      scroll = scrollCfg.speed;
      if (scrolling) {
        view.y = Math.max(0, lvl.h * TILE - view.h);
        view.x = Math.max(0, Math.min(view.x, lvl.w * TILE - view.w));
      }
      const start = spec.start || { x: TILE, y: TILE };
      respawn = { x: start.x, y: start.y };
      player = { x: start.x, y: start.y, w: 6, h: 12, vx: 0, vy: 0, grounded: false,
                 face: 1, coyote: 0, buffer: 0, walk: 0, hurt: 0,
                 wall: 0, dash: 0, dashLeft: P.dash ? 1 : 0, doubleLeft: P.doubleJump ? 1 : 0,
                 shotCool: 0, shotHeld: false, bWasDown: false };
      entities = (spec.entities || []).map(makeEntity);
      score = 0; keys = 0; lives = spec.lives ?? 3; elapsed = 0; won = false;
      state = 'play'; message = ''; messageAt = 0;
      doorsOpen = false; fired = []; effects = []; shake = 0;
      if (scriptEnv) { scriptEnv.vars = {}; scriptFault = ''; scriptLog = []; }
      if (program) fire('start');
    }
    // The script sees numbers and may call actions. It never sees the engine,
    // the page, or anything it could use to reach either.
    let program = null, scriptLog = [], scriptFault = '';
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
          case 'print': if (scriptLog.length < 50) scriptLog.push(String(args[0]).slice(0, 80)); break;
        }
      },
      fault(msg) { if (!scriptFault) scriptFault = msg; },
    };
    const say = name => { if (opts.onEvent) opts.onEvent(name); };
    const fire = name => { say(name); if (program) window.NeoScript.run(program, name, scriptEnv); };

    // Only now, because reset fires the script's start event.
    reset();

    const input = { left: false, right: false, up: false, down: false, a: false, b: false };
    let aWasDown = false;

    function die() {
      if (player.hurt > 0) return;
      lives--; player.hurt = 1.1; fire('hurt');
      effects.push({ kind: 'pop', x: player.x, y: player.y, t: 0 });
      if (lives <= 0) { state = 'over'; message = 'GAME OVER'; say('lose'); }
      else {
        player.x = respawn.x; player.y = respawn.y;
        player.vx = player.vy = 0; player.dash = 0;
      }
    }

    function step(dt) {
      if (state !== 'play') return;
      elapsed += dt;
      const ctx2 = { doorsOpen };
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
        scroll = Math.min(scrollCfg.max, scroll + scrollCfg.accel * dt);
        view.y -= scroll * dt;
        const dirY = (input.down ? 1 : 0) - (input.up ? 1 : 0);
        player.vx = dir * P.speed * 1.15;
        player.vy = dirY * P.speed * (mode === 'racer' ? 1.15 : 0.85);
        // carried along by the scroll, so standing still still means moving
        player.y -= scroll * dt;
      } else if (mode === 'platform') {
        player.coyote = player.grounded ? 0.09 : Math.max(0, player.coyote - dt);
        const jumpHeld = input.a || input.up;
        if (jumpHeld && !aWasDown) player.buffer = 0.12;
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
        aWasDown = jumpHeld;

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
          if (t.info.hazard || (mode === 'racer' && t.info.solid === true)) { die(); break; }
          if (mode === 'shmup' && t.info.solid === true) {
            // walls stop you rather than kill you
            player.x -= player.vx * dt; player.y -= player.vy * dt;
            break;
          }
        }
        if (view.y <= 0) { view.y = 0; finish(); }
        if (P.attack && mode === 'shmup' && input.a && player.shotCool <= 0) {
          const shot = makeEntity({ type: 'shot', x: player.x + 1, y: player.y - 4 });
          shot.vx = 0; shot.vy = -ENTITY.shot.speed * 1.4;
          entities.push(shot); player.shotCool = 0.22; say('shoot');
        }
        player.shotCool = Math.max(0, player.shotCool - dt);
        player.walk += Math.abs(player.vx) * dt * 0.35;
        if (player.hurt > 0) player.hurt = Math.max(0, player.hurt - dt);
        updateEntities(dt, ctx2);
        runTriggers();
        fire('tick');
        if (shake > 0) shake = Math.max(0, shake - dt * 12);
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
        if (t.info.hazard) { die(); break; }
        if (t.info.checkpoint && (respawn.x !== t.tx * TILE || respawn.y !== t.ty * TILE)) {
          respawn = { x: t.tx * TILE, y: t.ty * TILE };
          message = 'CHECKPOINT'; messageAt = elapsed; say('checkpoint');
        }
        if (t.info.exit) finish();
      }
      if (player.y > lvl.h * TILE + 40) die();

      // player shots
      if (P.attack && input.b && !player.shotHeld && player.shotCool <= 0 && player.dash <= 0) {
        entities.push(makeEntity({ type: 'shot', x: player.x + (player.face > 0 ? player.w : -3), y: player.y + 4 }));
        entities[entities.length - 1].vx = player.face * ENTITY.shot.speed;
        player.shotCool = 0.28; say('shoot');
      }
      player.shotHeld = input.b;
      player.shotCool = Math.max(0, player.shotCool - dt);

      updateEntities(dt, ctx2);
      runTriggers();
      fire('tick');
      if (shake > 0) shake = Math.max(0, shake - dt * 12);
    }

    function breakTile(tx, ty) {
      lvl.tiles[ty * lvl.w + tx] = 0;
      effects.push({ kind: 'break', x: tx * TILE, y: ty * TILE, t: 0 });
    }

    function finish() {
      const need = (spec.rules && spec.rules.collect) || 0;
      if (score >= need) { state = 'won'; won = true; message = 'CLEAR'; say('win'); }
      else { message = `${need - score} TO GO`; messageAt = elapsed; }
    }

    function updateEntities(dt, ctx2) {
      for (const e of entities) {
        if (!e.alive) continue;
        const d = e.def;

        if (d.bullet) {
          e.x += e.vx * dt; e.y += e.vy * dt; e.life += dt;
          if (e.life > 2.2 || solidAt(lvl, Math.floor(e.x / TILE), Math.floor(e.y / TILE), ctx2)) { e.alive = false; continue; }
        } else if (d.platform) {
          // A moving platform carries whatever is riding it.
          e.t += dt;
          const nx = e.home.x + Math.sin(e.t * (e.def.speed / d.span) * 2) * d.span;
          const carry = player.grounded && player.y + player.h <= e.y + 3 &&
                        player.x + player.w > e.x && player.x < e.x + e.w;
          const dxp = nx - e.x; e.x = nx;
          if (carry) { player.x += dxp; player.y = e.y - player.h; }
        } else if (d.enemy && !d.still) {
          if (d.chases) {
            const dx = (player.x + player.w / 2) - (e.x + e.w / 2);
            const dy = (player.y + player.h / 2) - (e.y + e.h / 2);
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
            const dx = (player.x + player.w / 2) - (e.x + e.w / 2);
            const dy = (player.y + player.h / 2) - (e.y + e.h / 2);
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

        if (!overlaps(player, e)) continue;
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
        } else if ((d.enemy || (d.bullet && e.foe)) && player.hurt <= 0) {
          if (d.bullet) { e.alive = false; die(); }
          else if (mode === 'platform' && player.vy > 40 && player.y + player.h - player.vy * dt <= e.y + 4 && !d.still) {
            e.hp -= 1;
            player.vy = -P.jump * 0.7;
            if (e.hp <= 0) { e.alive = false; score += 1; effects.push({ kind: 'pop', x: e.x, y: e.y, t: 0 }); fire('kill'); }
          } else die();
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
      const px = player.x + player.w / 2;
      if (px - view.x < dead) view.x = px - dead;
      if (px - view.x > view.w - dead) view.x = px - (view.w - dead);
      const py = player.y + player.h / 2;
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
      const sky = ctx.createLinearGradient(0, 0, 0, view.h);
      sky.addColorStop(0, spec.sky0 || '#1b2a5c'); sky.addColorStop(1, spec.sky1 || '#7fc4e8');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, view.w, view.h);

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

      for (const e of entities) {
        if (!e.alive) continue;
        const sx = Math.round(e.x - ox), sy = Math.round(e.y - oy);
        if (sx < -16 || sx > view.w + 16) continue;
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

      // the player, drawn with the studio's own character sprites
      const psx = Math.round(player.x + player.w / 2 - ox), psy = Math.round(player.y + player.h - oy);
      const blink = player.hurt > 0 && Math.floor(player.hurt * 20) % 2;
      if (!blink) {
        const chars = window.NeoScene && window.NeoScene.CHARS;
        if (chars && chars[P.char]) window.NeoScene.drawChar(ctx, chars[P.char], psx, psy, 1, player.walk, player.face);
        else { ctx.fillStyle = '#2ef2ff'; ctx.fillRect(psx - 3, psy - 12, 6, 12); }
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
      get level() { return lvl; },
      get view() { return view; },
      get freeCam() { return freeCam; },
      set freeCam(v) { freeCam = !!v; if (!v) camera(); draw(); },
      panBy(dx, dy) { view.x += dx; view.y += dy; camera(); draw(); },
      panTo(x, y) { view.x = x; view.y = y; camera(); draw(); },
      get scriptLog() { return scriptLog; },
      get scriptFault() { return scriptFault; },
      setScript(src) { spec.script = src; const r = compileScript(); reset(); draw(); return r; },
      get entities() { return entities; },
      get elapsed() { return elapsed; },
      input,
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
      snapshot() {
        return { ...spec, level: { w: lvl.w, h: lvl.h, tiles: Array.from(lvl.tiles) },
                 entities: entities.map(e => ({ type: e.type, x: Math.round(e.home.x), y: Math.round(e.home.y),
                                                dir: e.vx < 0 ? -1 : 1 })) };
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

    // A game nobody can finish is a broken game, so the goal is checked too.
    const need = (spec.rules && spec.rules.collect) || 0;
    const pickups = ents.filter(e => e && ENTITY[e.type] && ENTITY[e.type].collect && !ENTITY[e.type].key).length;
    if (need > pickups) bad(`rules.collect is ${need} but only ${pickups} pickups exist`);
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
