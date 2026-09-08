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
  const TILES = {
    0: { name: 'sky',      solid: false, draw: null },
    1: { name: 'ground',   solid: true,  fill: '#241a0e', top: '#7bbf4a' },
    2: { name: 'stone',    solid: true,  fill: '#26262f', top: '#9a9aab' },
    3: { name: 'platform', solid: 'top', fill: '#3a2410', top: '#c08a4a' },
    4: { name: 'hazard',   solid: false, hazard: true, fill: '#2a0808', top: '#ff5a3c' },
    5: { name: 'ladder',   solid: false, ladder: true, fill: '#6a4a20' },
    6: { name: 'water',    solid: false, hazard: true, fill: '#0e2a52', top: '#3f8fd0' },
    7: { name: 'brick',    solid: true,  fill: '#2e1410', top: '#a85a3a' },
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
  const solidAt = (lvl, tx, ty) => {
    const t = tileInfo(lvl.at(tx, ty));
    return t.solid === true;
  };
  const oneWayAt = (lvl, tx, ty) => tileInfo(lvl.at(tx, ty)).solid === 'top';

  // ---------- entities ----------
  const ENTITY = {
    coin:  { w: 6, h: 6, collect: true, score: 1 },
    heart: { w: 7, h: 6, collect: true, heal: 1 },
    key:   { w: 6, h: 7, collect: true, key: true },
    goal:  { w: 8, h: 12, goal: true },
    walker:{ w: 8, h: 10, enemy: true, speed: 22, turns: true },
    flyer: { w: 8, h: 8,  enemy: true, speed: 26, floats: true },
    spike: { w: 8, h: 4,  enemy: true, speed: 0 },
  };

  function makeEntity(e) {
    const def = ENTITY[e.type] || ENTITY.coin;
    return { type: e.type, x: e.x, y: e.y, w: def.w, h: def.h, def,
             vx: (def.speed || 0) * (e.dir === -1 ? -1 : 1), vy: 0,
             home: { x: e.x, y: e.y }, alive: true, t: Math.random() * 6.28 };
  }

  // ---------- collision ----------
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // Move on one axis at a time and resolve against the grid. Doing the axes
  // separately is what stops a body catching on the seam between two tiles.
  function moveAxis(body, lvl, dx, dy, wasFalling) {
    if (dx) {
      body.x += dx;
      const y0 = Math.floor(body.y / TILE), y1 = Math.floor((body.y + body.h - 1) / TILE);
      const edge = dx > 0 ? Math.floor((body.x + body.w - 1) / TILE) : Math.floor(body.x / TILE);
      for (let ty = y0; ty <= y1; ty++) {
        if (!solidAt(lvl, edge, ty)) continue;
        body.x = dx > 0 ? edge * TILE - body.w : (edge + 1) * TILE;
        body.vx = 0; break;
      }
    }
    if (dy) {
      body.y += dy;
      const x0 = Math.floor(body.x / TILE), x1 = Math.floor((body.x + body.w - 1) / TILE);
      const edge = dy > 0 ? Math.floor((body.y + body.h - 1) / TILE) : Math.floor(body.y / TILE);
      for (let tx = x0; tx <= x1; tx++) {
        const solid = solidAt(lvl, tx, edge);
        // One-way tiles only catch a body that is falling onto them from above.
        const oneWay = dy > 0 && oneWayAt(lvl, tx, edge) &&
                       wasFalling && (body.y + body.h - dy) <= edge * TILE + 1;
        if (!solid && !oneWay) continue;
        if (dy > 0) { body.y = edge * TILE - body.h; body.grounded = true; }
        else body.y = (edge + 1) * TILE;
        body.vy = 0; break;
      }
    }
  }

  // ---------- the game ----------
  function create(canvas, spec, opts = {}) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const mode = spec.mode === 'topdown' ? 'topdown' : 'platform';
    const lvl = makeLevel(spec.level || { w: 20, h: 18, tiles: '' });
    const rand = rng(spec.seed || 'neojutsu');
    const view = { w: canvas.width, h: canvas.height, x: 0, y: 0 };

    const P = Object.assign({ speed: 82, accel: 700, friction: 820, jump: 205, gravity: 560,
                              maxFall: 240, char: 'hero' }, spec.player || {});
    let player, entities, state, score, keys, lives, message, elapsed, won;

    function reset() {
      const start = spec.start || { x: TILE, y: TILE };
      player = { x: start.x, y: start.y, w: 6, h: 12, vx: 0, vy: 0, grounded: false,
                 face: 1, coyote: 0, buffer: 0, walk: 0, hurt: 0 };
      entities = (spec.entities || []).map(makeEntity);
      score = 0; keys = 0; lives = spec.lives ?? 3; elapsed = 0; won = false;
      state = 'play'; message = '';
    }
    reset();

    const input = { left: false, right: false, up: false, down: false, a: false, b: false };
    let aWasDown = false;

    function die() {
      lives--; player.hurt = 1;
      if (lives <= 0) { state = 'over'; message = 'GAME OVER'; }
      else { const s = spec.start || { x: TILE, y: TILE }; player.x = s.x; player.y = s.y; player.vx = player.vy = 0; }
    }

    function step(dt) {
      if (state !== 'play') return;
      elapsed += dt;
      const wasFalling = player.vy > 0;

      // horizontal: accelerate toward the held direction, brake when nothing is held
      const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      if (dir) { player.vx += dir * P.accel * dt; player.face = dir; }
      else player.vx -= Math.sign(player.vx) * Math.min(Math.abs(player.vx), P.friction * dt);
      player.vx = Math.max(-P.speed, Math.min(P.speed, player.vx));

      if (mode === 'platform') {
        // Coyote time and a jump buffer: both are what make a jump feel fair
        // rather than technically correct.
        player.coyote = player.grounded ? 0.09 : Math.max(0, player.coyote - dt);
        const jumpHeld = input.a || input.up;
        if (jumpHeld && !aWasDown) player.buffer = 0.12;
        else player.buffer = Math.max(0, player.buffer - dt);
        if (player.buffer > 0 && player.coyote > 0) {
          player.vy = -P.jump; player.grounded = false; player.coyote = 0; player.buffer = 0;
        }
        // releasing early cuts the jump short
        if (!jumpHeld && player.vy < -40) player.vy *= 0.55;
        aWasDown = jumpHeld;
        player.vy = Math.min(P.maxFall, player.vy + P.gravity * dt);
      } else {
        const vdir = (input.down ? 1 : 0) - (input.up ? 1 : 0);
        player.vy = vdir * P.speed;
      }

      player.grounded = false;
      moveAxis(player, lvl, player.vx * dt, 0, wasFalling);
      moveAxis(player, lvl, 0, player.vy * dt, wasFalling);
      player.walk += Math.abs(player.vx) * dt * 0.35;
      if (player.hurt > 0) player.hurt = Math.max(0, player.hurt - dt);

      // hazard tiles and falling out of the world
      const cx = Math.floor((player.x + player.w / 2) / TILE);
      const cy = Math.floor((player.y + player.h / 2) / TILE);
      if (tileInfo(lvl.at(cx, cy)).hazard || player.y > lvl.h * TILE + 40) die();

      for (const e of entities) {
        if (!e.alive) continue;
        if (e.def.enemy && e.def.speed) {
          if (e.def.floats) {
            e.t += dt; e.y = e.home.y + Math.sin(e.t * 2) * 10;
            e.x += e.vx * dt;
            if (solidAt(lvl, Math.floor((e.x + (e.vx > 0 ? e.w : 0)) / TILE), Math.floor(e.y / TILE))) e.vx *= -1;
          } else {
            e.x += e.vx * dt;
            const ahead = Math.floor((e.x + (e.vx > 0 ? e.w + 1 : -1)) / TILE);
            const foot = Math.floor((e.y + e.h + 1) / TILE);
            const mid = Math.floor((e.y + e.h / 2) / TILE);
            // turn at a wall, and at the edge of the ground it is standing on
            if (solidAt(lvl, ahead, mid) || (e.def.turns && !solidAt(lvl, ahead, foot))) {
              e.vx *= -1; e.x += e.vx * dt;
            }
          }
        }
        if (!overlaps(player, e)) continue;
        if (e.def.collect) {
          e.alive = false;
          if (e.def.key) keys++; else if (e.def.heal) lives = Math.min(9, lives + 1); else score += e.def.score || 1;
        } else if (e.def.goal) {
          const need = spec.rules && spec.rules.collect;
          if (!need || score >= need) { state = 'won'; won = true; message = 'CLEAR'; }
          else message = `${need - score} TO GO`;
        } else if (e.def.enemy && player.hurt <= 0) {
          // landing on an enemy from above kills it, as it should
          if (mode === 'platform' && player.vy > 40 && player.y + player.h - player.vy * dt <= e.y + 4) {
            e.alive = false; player.vy = -P.jump * 0.7; score += 1;
          } else die();
        }
      }
    }

    // ---------- drawing ----------
    function camera() {
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
      const ox = Math.round(view.x), oy = Math.round(view.y);
      const sky = ctx.createLinearGradient(0, 0, 0, view.h);
      sky.addColorStop(0, spec.sky0 || '#1b2a5c'); sky.addColorStop(1, spec.sky1 || '#7fc4e8');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, view.w, view.h);

      const x0 = Math.floor(ox / TILE), x1 = Math.ceil((ox + view.w) / TILE);
      const y0 = Math.floor(oy / TILE), y1 = Math.ceil((oy + view.h) / TILE);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const info = tileInfo(lvl.at(tx, ty));
          if (!info.fill) continue;
          const sx = tx * TILE - ox, sy = ty * TILE - oy;
          ctx.fillStyle = info.fill; ctx.fillRect(sx, sy, TILE, TILE);
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
        } else {
          ctx.fillStyle = '#0a0714'; ctx.fillRect(sx - 1, sy - 1, e.w + 2, e.h + 2);
          ctx.fillStyle = e.def.floats ? '#c060ff' : '#ff5a3c';
          ctx.fillRect(sx, sy, e.w, e.h);
          ctx.fillStyle = '#fff';
          ctx.fillRect(sx + (e.vx > 0 ? e.w - 3 : 1), sy + 2, 2, 2);
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

      if (opts.hud !== false) {
        ctx.fillStyle = 'rgba(5,4,10,.55)'; ctx.fillRect(0, 0, view.w, 9);
        ctx.font = '6px "Press Start 2P", monospace'; ctx.textBaseline = 'top';
        ctx.fillStyle = '#ffd23f'; ctx.fillText(`${score}`, 12, 2);
        ctx.fillRect(3, 2, 5, 5);
        ctx.fillStyle = '#ff2e88';
        for (let i = 0; i < lives; i++) ctx.fillRect(view.w - 6 - i * 7, 2, 5, 5);
        if (keys) { ctx.fillStyle = '#2ef2ff'; ctx.fillText(`${keys}`, 40, 2); }
      }
      if (state !== 'play' || message) {
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        const text = state === 'won' ? 'CLEAR' : state === 'over' ? 'GAME OVER' : message;
        if (text) {
          ctx.fillStyle = '#000'; ctx.fillText(text, view.w / 2 + 1, view.h / 2 + 1);
          ctx.fillStyle = state === 'won' ? '#3fbf4a' : '#ffffff';
          ctx.fillText(text, view.w / 2, view.h / 2);
        }
        ctx.textAlign = 'left';
      }
    }

    // ---------- loop ----------
    let raf = 0, last = 0, acc = 0, running = false;
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

  window.NeoGame = { TILE, TILES, ENTITY, create, makeLevel, rng };
})();
