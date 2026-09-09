/* game-sprites.js - the studio's sprite atlas.

   Art: Kenney "1-Bit Pack", CC0. One sheet, 49x22 cells of 16px. Every pixel
   in it is the same near-white ink on transparency, which is the whole reason
   it suits this project: a silhouette can be tinted to any hardware palette at
   draw time, so one drawing serves a Game Boy, a C64 and a Genesis without
   being redrawn per machine.

   The sheet is inlined as a data URI rather than fetched. Packaged games are a
   single HTML file sent to a friend, and a file:// page cannot fetch a
   sibling PNG - so the art has to travel as text, like everything else here. */
(() => {
  'use strict';

  const TS = 16, COLS = 49, ROWS = 22, COUNT = COLS * ROWS;
  const SHEET = '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';

  let loaded = false;
  let ink = null;                       // per-cell ink bounds, measured on load
  const tints = new Map();              // colour -> tinted copy of the sheet
  const TINT_MAX = 24;
  const waiters = [];
  const img = new Image();

  img.onload = () => {
    try { measure(); loaded = true; } catch { loaded = false; }
    while (waiters.length) { const f = waiters.pop(); try { f(); } catch {} }
  };
  img.onerror = () => { while (waiters.length) { const f = waiters.pop(); try { f(); } catch {} } };
  img.src = 'data:image/png;base64,' + SHEET;

  // Where the ink actually sits inside each 16px cell. Drawing from these
  // bounds instead of the cell is what keeps a coin coin-sized and a dragon
  // dragon-sized without a hand-written size table.
  function measure() {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const data = x.getImageData(0, 0, c.width, c.height).data;
    ink = new Int16Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      const cx = (i % COLS) * TS, cy = ((i / COLS) | 0) * TS;
      let x0 = TS, y0 = TS, x1 = -1, y1 = -1;
      for (let py = 0; py < TS; py++) {
        for (let px = 0; px < TS; px++) {
          if (data[((cy + py) * c.width + cx + px) * 4 + 3] > 8) {
            if (px < x0) x0 = px; if (px > x1) x1 = px;
            if (py < y0) y0 = py; if (py > y1) y1 = py;
          }
        }
      }
      const o = i * 4;
      if (x1 < 0) { ink[o] = 0; ink[o + 1] = 0; ink[o + 2] = 0; ink[o + 3] = 0; }
      else { ink[o] = x0; ink[o + 1] = y0; ink[o + 2] = x1 - x0 + 1; ink[o + 3] = y1 - y0 + 1; }
    }
  }

  function tinted(colour) {
    let c = tints.get(colour);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = colour;
    x.fillRect(0, 0, c.width, c.height);
    if (tints.size >= TINT_MAX) tints.delete(tints.keys().next().value);
    tints.set(colour, c);
    return c;
  }

  function box(idx) {
    if (!loaded || !ink) return null;
    const i = (idx | 0) % COUNT, o = i * 4;
    return ink[o + 2] ? { x: ink[o], y: ink[o + 1], w: ink[o + 2], h: ink[o + 3] } : null;
  }

  /* `turn` is in quarter turns, clockwise. Only quarters: a right angle maps
     every source pixel onto exactly one destination pixel, so the art stays as
     sharp as it was drawn. Anything else would resample and blur it. */
  function blit(ctx, sheet, b, idx, dx, dy, flip, turn) {
    const i = (idx | 0) % COUNT;
    const sx = (i % COLS) * TS + b.x, sy = ((i / COLS) | 0) * TS + b.y;
    const q = ((turn | 0) % 4 + 4) % 4;
    if (!flip && !q) { ctx.drawImage(sheet, sx, sy, b.w, b.h, dx, dy, b.w, b.h); return; }
    ctx.save();
    // Turn about the middle of the sprite, so it does not walk off its own feet.
    ctx.translate(dx + b.w / 2, dy + b.h / 2);
    if (q) ctx.rotate(q * Math.PI / 2);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(sheet, sx, sy, b.w, b.h, -b.w / 2, -b.h / 2, b.w, b.h);
    ctx.restore();
  }

  /* Draw a sprite standing on (cx, by): centred horizontally, feet on the
     baseline. Entities in the engine are boxes 6-16px wide; the art is
     usually a little larger, which reads as a generous hitbox rather than a
     cheap one. `outline` paints a dark halo first - this project keeps
     losing silhouettes to dark-on-dark palettes, and one pixel of contrast
     is what stops that happening again. */
  function draw(ctx, idx, cx, by, opt) {
    if (!loaded) return false;
    const b = box(idx);
    if (!b) return false;
    const o = opt || {};
    const dx = Math.round(cx - b.w / 2), dy = Math.round(by - b.h);
    if (o.outline) {
      const halo = tinted(o.outline === true ? '#0a0714' : o.outline);
      blit(ctx, halo, b, idx, dx - 1, dy, o.flip, o.turn);
      blit(ctx, halo, b, idx, dx + 1, dy, o.flip, o.turn);
      blit(ctx, halo, b, idx, dx, dy - 1, o.flip, o.turn);
      blit(ctx, halo, b, idx, dx, dy + 1, o.flip, o.turn);
    }
    blit(ctx, tinted(o.colour || '#f9fafb'), b, idx, dx, dy, o.flip, o.turn);
    return true;
  }

  // Draw fitted inside a box, for pickers and menus where a uniform cell
  // matters more than true pixel scale.
  function drawFit(ctx, idx, x, y, w, h, colour) {
    if (!loaded) return false;
    const b = box(idx);
    if (!b) return false;
    const s = Math.max(1, Math.floor(Math.min(w / b.w, h / b.h)));
    const i = (idx | 0) % COUNT;
    const sx = (i % COLS) * TS + b.x, sy = ((i / COLS) | 0) * TS + b.y;
    ctx.drawImage(tinted(colour || '#f9fafb'), sx, sy, b.w, b.h,
                  Math.round(x + (w - b.w * s) / 2), Math.round(y + (h - b.h * s) / 2),
                  b.w * s, b.h * s);
    return true;
  }

  // Deterministic pick. Everything in this studio is seed-driven; sprite
  // choice must be too, or the same game would look different on reload.
  function pick(list, n) {
    if (!list || !list.length) return null;
    return list[Math.abs(n | 0) % list.length];
  }

  /* ---- casts ----
     Each game category gets its own creatures, so a dungeon is not a sci-fi
     level wearing the same skin. Keys match the engine's entity types. */
  const BASE = {
    player: [25, 26, 74, 76],
    walker: [269, 270, 273, 421],
    flyer:  [418, 320, 322],
    chaser: [324, 323, 325],
    jumper: [372, 414, 365],
    turret: [577, 486],
    hunter: [273, 275],
    ghost:  [419, 417],
    invader:[365, 366, 414],
    rival:  [220, 26, 31],
  };
  const CAST = {
    platformer: BASE,
    dungeon: { player: [122, 171, 24], walker: [323, 276, 422], flyer: [320, 322, 416],
               chaser: [324, 325, 129], jumper: [414, 365, 372], turret: [577, 486], hunter: [417, 275], ghost: [419, 417], invader: [365, 414], rival: [220, 26, 31] },
    rpg:     { player: [24, 220, 26], walker: [421, 422, 370], flyer: [418, 369],
               chaser: [323, 276], jumper: [372, 373], turret: [577, 486], hunter: [374, 371], ghost: [419, 417], invader: [366, 365], rival: [220, 26, 31] },
    racing:  { player: [25, 74], walker: [269, 271], flyer: [418],
               chaser: [324], jumper: [414], turret: [486, 577], hunter: [989, 990], ghost: [419], invader: [319, 320], rival: [220, 26, 31] },
    shooter: { player: [76, 129], walker: [271, 269], flyer: [319, 320],
               chaser: [324, 325], jumper: [414], turret: [486, 577], hunter: [989, 990], ghost: [419], invader: [319, 320], rival: [220, 26, 31] },
    scifi:   { player: [129, 324, 325], walker: [271, 274], flyer: [319, 320],
               chaser: [324, 325], jumper: [414, 415], turret: [486, 577], hunter: [321, 322], ghost: [419], invader: [319, 320, 365], rival: [220, 26, 31] },
    adventure: { player: [26, 220, 31], walker: [421, 422], flyer: [418, 369],
                 chaser: [323, 276], jumper: [372, 373], turret: [577], hunter: [417, 419], ghost: [419, 417], invader: [365, 366], rival: [220, 26, 31] },
    strategy: { player: [30, 74], walker: [269, 273], flyer: [418],
                chaser: [324], jumper: [414], turret: [486, 577], hunter: [989, 990], ghost: [419], invader: [319, 320], rival: [220, 26, 31] },
    twoplayer: { player: [25, 76], walker: [269, 421], flyer: [418, 320],
                 chaser: [324], jumper: [372], turret: [577], hunter: [273, 417], ghost: [419], invader: [365, 319], rival: [220, 26, 31] },
    // A board game has no cast at all; it still needs a row here so nothing
    // asking for one falls through to a missing table.
    puzzle:    { player: [30, 74], walker: [269], flyer: [418], chaser: [324],
                 jumper: [414], turret: [486], hunter: [273], ghost: [419],
                 invader: [365], rival: [220] },
  };

  // Pickups and the goal read the same in every game - a heart is a heart.
  // Bullets and moving platforms stay as the engine's own rectangles: a 3px
  // shot has no room for a drawing, and a platform is a piece of level.
  const ITEM = { coin: 218, gem: 219, heart: 529, key: 572, goal: 824, shot: null, mover: null };

  /* ---- browsing the sheet ----
     The pack ships 1078 drawings under numbers, not names, so the groups
     below are bands of the sheet rather than a catalogue. "Everything" is
     listed first and is the honest one: any sprite not covered by a band is
     still reachable there. "Handy" is the short list that was checked by eye.  */
  const HANDY = [
    49, 50, 51, 52, 53, 54, 55, 56,          // trees, bushes, cactus
    98, 99, 100, 101, 102, 103, 104, 105,    // grass, saplings, mushroom
    147, 148, 149, 152, 153, 196, 197, 198,  // fences and gates
    8, 9, 10, 11, 12, 57, 58, 59, 60, 61,    // wall and building blocks
    106, 107, 108, 109, 110,
    218, 219, 529, 572, 824, 486, 567,       // coin, gem, heart, key, cup, bomb, flame
    620, 622, 578, 337, 338, 339, 340,       // bone, skull, flask, potions
    672, 674, 759, 766, 825, 826, 829,       // marks, cartridge, pad, house, save, gear
    24, 25, 26, 74, 76, 122, 171, 220,       // people
    269, 320, 323, 324, 372, 414, 418, 421,  // creatures
  ];

  const BANDS = [
    ['all',    'Everything', '全', null],
    ['handy',  'Handy',      '選', 'handy'],
    ['nature', 'Nature',     '森', { c: [0, 7] }],
    ['built',  'Structures', '館', { c: [8, 22] }],
    ['people', 'People',     '人', { c: [23, 31], r: [0, 4] }],
    ['beasts', 'Creatures',  '獣', { c: [23, 31], r: [5, 9] }],
    ['arms',   'Weapons',    '刀', { c: [32, 42], r: [2, 10] }],
    ['items',  'Items',      '宝', { c: [37, 45], r: [6, 13] }],
    ['marks',  'Symbols',    '符', { c: [37, 48], r: [13, 21] }],
  ];

  // Only cells that actually carry ink; the sheet has blanks.
  function group(key) {
    const band = BANDS.find(b => b[0] === key);
    const spanOf = band && band[3];
    if (spanOf === 'handy') return HANDY.filter(i => box(i));
    const out = [];
    for (let i = 0; i < COUNT; i++) {
      if (!box(i)) continue;
      if (spanOf) {
        const c = i % COLS, r = (i / COLS) | 0;
        if (c < spanOf.c[0] || c > spanOf.c[1]) continue;
        if (spanOf.r && (r < spanOf.r[0] || r > spanOf.r[1])) continue;
      }
      out.push(i);
    }
    return out;
  }

  /* ---- what the player is ----
     A racing game whose player is a walking man is not a racing game. The
     avatar follows the mode first - you are a car in a race and a ship in
     space whatever the level is called - and the category after. Anything
     not listed here keeps the studio's own drawn characters, which are
     better at being people than a 1-bit silhouette is. */
  // The mode owns the vehicles, because the mode is the vehicle: you are a
  // car in a race and a ship in space whatever the level is called.
  const PLAYER_BY_MODE = { racer: 990, shmup: 1041, invaders: 1041, rider: 992 };
  // A category may only ask for a body that walks. A shooter played as a
  // platformer is a person with a gun, not a rocket standing on a ledge.
  const PLAYER_BY_CAT = { scifi: 324, strategy: 1022 };
  function playerFor(mode, cat) {
    const byMode = PLAYER_BY_MODE[mode];
    if (byMode !== undefined) return byMode;
    const byCat = PLAYER_BY_CAT[cat];
    return byCat === undefined ? null : byCat;
  }

  // Sprites that are vehicles rather than bodies. A car does not turn around
  // to drive left, it steers.
  const VEHICLES = new Set([989, 990, 991, 992, 1036, 1037, 1038, 1039, 1040, 1041, 736, 942, 943]);

  /* Which way a sprite is drawn. A vehicle seen head-on points up the screen;
     one drawn in profile points right. Getting this wrong is very visible - a
     tank driving north while lying on its side - so the knowledge lives here
     with the art rather than being guessed at by whoever is drawing it. */
  const FACES_UP = new Set([989, 990, 991, 995, 1037, 1038, 1041, 1042]);

  // Quarter turns clockwise to aim sprite `idx` along (ax, ay).
  function turnFor(idx, ax, ay) {
    if (!ax && !ay) return 0;                                 // standing still: leave it as drawn
    const want = ay > 0 ? 2 : ay < 0 ? 0 : ax < 0 ? 3 : 1;    // 0 up, 1 right, 2 down, 3 left
    return (want - (FACES_UP.has(idx) ? 0 : 1) + 4) % 4;      // profile art already points right
  }

  // A top-down vehicle has to be one drawn head-on, or turning it looks wrong.
  const TOPDOWN_VEHICLES = [989, 990, 991, 1038];

  function castFor(cat) { return CAST[cat] || BASE; }

  // Sprite for one entity, chosen from its category cast and pinned by the
  // entity's own id so it does not flicker between frames or reloads.
  function forEntity(type, cat, n) {
    if (Object.prototype.hasOwnProperty.call(ITEM, type)) return ITEM[type];
    return pick(castFor(cat)[type], n);
  }

  window.NeoSprites = {
    TS, COLS, ROWS, COUNT,
    ready(fn) { if (loaded) fn(); else waiters.push(fn); },
    get loaded() { return loaded; },
    box, draw, drawFit, pick, castFor, forEntity, group, playerFor,
    PLAYER_BY_MODE, PLAYER_BY_CAT, VEHICLES, TOPDOWN_VEHICLES, turnFor,
    CAST, ITEM, BASE, BANDS, HANDY,
  };
})();
