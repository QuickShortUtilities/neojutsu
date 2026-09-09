/* Turn a description into a playable game.
 *
 * The interface is the point: `generate(prompt, seed)` returns a spec that
 * NeoGame.validate accepts and the engine can play. Today the backend is rules -
 * it reads a prompt for what it recognises and builds from that. A model can
 * take the same slot later without anything around it changing, because the
 * contract is only ever "text in, valid spec out".
 */
(() => {
  'use strict';

  const T = 8;

  const THEMES = {
    cave:    { sky: ['#0d0a16', '#241a30'], char: 'beast',    words: ['cave', 'cavern', 'underground', 'tunnel', 'mine'] },
    ice:     { sky: ['#0a1830', '#4a7fa8'], char: 'ninja',    words: ['ice', 'icy', 'frozen', 'snow', 'glacier', 'cold', 'winter'] },
    sky:     { sky: ['#1b2a5c', '#bfe9ff'], char: 'hero',     words: ['sky', 'cloud', 'island', 'air', 'high', 'floating'] },
    sunset:  { sky: ['#241844', '#c9598a'], char: 'princess', words: ['sunset', 'dusk', 'evening', 'pink', 'romantic'] },
    factory: { sky: ['#0d0a16', '#3a2a4a'], char: 'robot',    words: ['factory', 'machine', 'robot', 'industrial', 'belt', 'steel', 'assembly'] },
    ruins:   { sky: ['#12002a', '#7a1236'], char: 'knight',   words: ['ruin', 'castle', 'fortress', 'keep', 'knight', 'medieval'] },
    volcano: { sky: ['#2a0410', '#8c2350'], char: 'rogue',    words: ['volcano', 'lava', 'fire', 'burning', 'hell', 'magma'] },
    temple:  { sky: ['#0a1424', '#2a5a7a'], char: 'mage',     words: ['temple', 'shrine', 'sanctuary', 'magic', 'mage', 'ancient'] },
  };
  const MECHANICS = {
    springs:    ['spring', 'bounce', 'bouncy', 'trampoline', 'jump pad'],
    belts:      ['belt', 'conveyor', 'factory', 'assembly'],
    ice:        ['ice', 'icy', 'slip', 'slippery', 'frozen', 'skid'],
    doors:      ['door', 'key', 'locked', 'unlock'],
    breakables: ['break', 'brick', 'smash', 'destroy', 'crate'],
    water:      ['water', 'swim', 'underwater', 'sea', 'ocean', 'flood'],
    moving:     ['moving platform', 'lift', 'elevator', 'platform that moves'],
  };
  const ABILITIES = {
    doubleJump: ['double jump', 'double-jump', 'two jumps', 'air jump'],
    wallJump:   ['wall jump', 'wall-jump', 'climb walls', 'wall climb'],
    dash:       ['dash', 'sprint', 'boost', 'rush'],
    attack:     ['shoot', 'shooting', 'gun', 'attack', 'fight', 'blast', 'weapon'],
    aimLock:    ['tank', 'tanks', 'turret', 'artillery', 'armour', 'armor'],
  };
  const CHARS = ['hero', 'knight', 'mage', 'ninja', 'rogue', 'robot', 'beast', 'princess'];

  const rng = seed => window.NeoGame.rng(seed);
  // n items taken evenly across a list, so a handful of things are spread out
  // rather than heaped in whatever corner the list happens to start in.
  const spread = (items, n) => {
    if (!items.length || n <= 0) return [];
    const step = Math.max(1, Math.floor(items.length / n));
    const out = [];
    for (let i = 0; i < items.length && out.length < n; i += step) out.push(items[i]);
    return out;
  };
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const hit = (text, words) => words.some(w => text.includes(w));

  // ---------- reading the prompt ----------
  function read(prompt) {
    const raw = ' ' + String(prompt || '').toLowerCase() + ' ';
    const want = {};

    /* Genre names are not places. "bullet hell" carries the word hell, which
       scored as the volcano theme and quietly turned every bullet-hell
       request into a lava level; "dogfight" is not a dog. Blank the genre
       phrases before looking for a setting, but keep the original for the
       mode test below, which is what those phrases are actually for. */
    const t = raw
      .replace(/bullet hell/g, ' shmup ')
      .replace(/shoot.?.?em.?up/g, ' shmup ')
      .replace(/dogfight/g, ' shmup ')
      .replace(/hell ?scape/g, ' volcano ');

    // Score rather than take the first match: "ice cave" is an ice level, and
    // whichever word the writer put first is the one they led with.
    const best = (table, get) => {
      let win = null, winScore = -1, winAt = 1e9;
      for (const [k, v] of Object.entries(table)) {
        const words = get(v);
        let n = 0, at = 1e9;
        for (const w of words) {
          const i = t.indexOf(w);
          if (i >= 0) { n++; at = Math.min(at, i); }
        }
        if (n === 0) continue;
        if (n > winScore || (n === winScore && at < winAt)) { win = k; winScore = n; winAt = at; }
      }
      return win;
    };
    const theme = best(THEMES, v => v.words); if (theme) want.theme = theme;
    const mech = best(MECHANICS, v => v); if (mech) want.mech = mech;
    want.abilities = Object.entries(ABILITIES).filter(([, v]) => hit(t, v)).map(([k]) => k);

    /* A maze you are chased round, eating as you go, is a different game from
       a dungeon with a flag in it - so it is asked first, before "maze" on its
       own settles for the dungeon. */
    if (/space invaders|invaders|galaga|galaxian|fixed shooter|wave of aliens/.test(raw)) {
      want.mode = 'invaders';
    }
    else if (/pac.?man|maze chase|chase.*maze|eat the dots|dot.?muncher|ghosts?\b/.test(raw)) {
      want.mode = 'topdown'; want.chase = true;
    }
    else if (/\brac(e|ing)|driv(e|ing)|car\b|speedway|highway|kart|rally\b/.test(raw)) want.mode = 'racer';
    else if (/shoot.?.?em.?up|shmup|space shooter|starfighter|dogfight|bullet hell/.test(raw)) want.mode = 'shmup';
    else if (/top.?down|overhead|dungeon|maze|room|zelda|tank/.test(raw)) want.mode = 'topdown';
    if (/platform|jump|side.?scroll|mario|climb|ledge/.test(raw)) want.mode = want.mode || 'platform';
    // Some mechanics and every shape only make sense side-on, so asking for one
    // implies the mode rather than leaving it to chance.
    if (!want.mode && ['springs', 'belts', 'breakables', 'moving', 'ice'].includes(want.mech))
      want.mode = 'platform';
    // A shape word usually means a side-on level, but not when the request
    // already said overhead - "a tank battle in a cavern" is still a tank.
    if (want.shape && !['racer', 'shmup', 'topdown'].includes(want.mode)) want.mode = 'platform';

    /* Two on one keyboard. The engine has always taken it and nothing could
       ask for it in words, so no described game was ever a two-player one. */
    if (/two[- ]player|2[- ]player|co.?op\b|for two\b/.test(raw)) want.coop = true;
    if (/\b(hard|difficult|brutal|tough|punishing)\b/.test(t)) want.difficulty = 2;
    else if (/\b(easy|gentle|simple|relaxed|calm)\b/.test(t)) want.difficulty = 0;

    if (/\b(long|big|huge|large|sprawling)\b/.test(t)) want.size = 'wide';
    else if (/\b(tall|climb|tower|vertical|up)\b/.test(t)) want.size = 'tall';
    else if (/\b(short|small|quick|tiny|little)\b/.test(t)) want.size = 'small';

    if (/\btime|timer|countdown|against the clock|race\b/.test(t)) want.timed = true;
    const n = t.match(/\b(\d{1,2})\s*(coins?|things?|pickups?|gems?|items?)\b/);
    if (n) want.collect = Math.min(30, parseInt(n[1], 10));
    const lives = t.match(/\b(\d)\s*(lives|life|hearts?)\b/);
    if (lives) want.lives = Math.max(1, Math.min(9, parseInt(lives[1], 10)));
    if (/\bisland|floating|archipelago\b/.test(t)) want.shape = 'islands';
    else if (/\bcavern|tunnel|underground|cave\b/.test(t)) want.shape = 'cavern';
    else if (/\btower|climb|vertical|ascend\b/.test(t)) want.shape = 'tower';
    else if (/\bcorridor|hallway|factory|assembly\b/.test(t)) want.shape = 'corridor';
    else if (/\bstair|steps|pyramid|ziggurat\b/.test(t)) want.shape = 'stairs';
    for (const c of CHARS) if (t.includes(c)) { want.char = c; break; }
    if (/\bboss|arena|horde|swarm|survive\b/.test(t)) want.boss = true;
    return want;
  }

  // ---------- level shapes ----------
  // Colour alone made every generated level feel the same, so the architecture
  // changes too: islands float, caverns have a ceiling, towers go up.
  const blank = (w, h, fill) => Array.from({ length: h }, () => Array(w).fill(fill || '0'));
  const put = (g, x, y, ch) => { if (g[y] && g[y][x] !== undefined) g[y][x] = ch; };
  const fillRect = (g, x0, y0, x1, y1, ch) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(g, x, y, ch);
  };

  function coinsOn(ents, spots, r, n) {
    for (let i = 0; i < n && spots.length; i++) {
      const [x, y] = spots.splice(Math.floor(r() * spots.length), 1)[0];
      ents.push({ type: 'coin', x: x * T + 1, y: y * T + 1 });
    }
  }

  // Floating chunks with real gaps between them.
  function islands(r, o) {
    const { w, h } = o, g = blank(w, h), ents = [], spots = [];
    let x = 0, firstTop = h - 6;
    while (x < w) {
      const span = 4 + Math.floor(r() * 5);
      const top = Math.max(4, Math.min(h - 4, (h - 6) + Math.floor((r() - .5) * 6)));
      if (x === 0) firstTop = top;
      fillRect(g, x, top, Math.min(x + span, w), Math.min(top + 2 + Math.floor(r() * 2), h), '1');
      /* The island is clamped to the level; the places to put a coin on it
         were not, so the last island in a wide level put its pickups past the
         right-hand edge where nobody could reach them. */
      for (let i = 1; i < span - 1; i += 2) if (x + i < w - 1) spots.push([x + i, top - 1]);
      if (r() < .45) {
        const ly = top - 3 - Math.floor(r() * 2);
        fillRect(g, x + 1, ly, Math.min(x + span - 1, w), ly + 1, '3');
        if (x + 2 < w - 1) spots.push([x + 2, ly - 1]);
      }
      x += span + 2 + Math.floor(r() * 3);
    }
    return { g, ents, spots, start: { x: T, y: (firstTop - 2) * T }, ground: null };
  }

  // Enclosed: floor, ceiling and teeth.
  function cavern(r, o) {
    const { w, h, theme } = o, g = blank(w, h, '2'), ents = [], spots = [];
    let floorY = h - 4;
    for (let x = 0; x < w; x++) {
      if (r() < .18) floorY = Math.max(h - 7, Math.min(h - 3, floorY + (r() < .5 ? -1 : 1)));
      const ceil = 2 + Math.floor(r() * 2);
      fillRect(g, x, ceil, x + 1, floorY, '0');
      if (r() < .12) put(g, x, ceil, '4');
      if (r() < .1) put(g, x, floorY - 1, theme === 'volcano' ? 'e' : '4');
      else if (r() < .3) spots.push([x, floorY - 2]);
    }
    for (let i = 0; i < 4; i++) {
      const lx = 4 + Math.floor(r() * (w - 10)), ly = h - 7 - Math.floor(r() * 3);
      fillRect(g, lx, ly, lx + 3 + Math.floor(r() * 2), ly + 1, '3');
      spots.push([lx + 1, ly - 1]);
    }
    return { g, ents, spots, start: { x: 2 * T, y: (h - 7) * T }, ground: h - 4 };
  }

  // Up rather than along: alternating ledges with a floor at the bottom.
  function tower(r, o) {
    const { w, h } = o, g = blank(w, h), ents = [], spots = [];
    fillRect(g, 0, h - 2, w, h, '1');
    fillRect(g, 0, 0, 1, h, '2'); fillRect(g, w - 1, 0, w, h, '2');
    let y = h - 5, side = 0;
    while (y > 3) {
      const span = Math.max(4, Math.floor(w * .45));
      const x0 = side ? 1 : w - 1 - span;
      fillRect(g, x0, y, x0 + span, y + 1, r() < .25 ? '8' : '3');
      spots.push([x0 + 1 + Math.floor(r() * (span - 2)), y - 1]);
      if (r() < .2) put(g, x0 + span - 1, y - 1, 'b');
      side ^= 1; y -= 3;
    }
    return { g, ents, spots, start: { x: 2 * T, y: (h - 4) * T }, ground: h - 2 };
  }

  // A low, busy corridor of belts and crates.
  function corridor(r, o) {
    const { w, h, mech } = o, g = blank(w, h), ents = [], spots = [];
    const floorY = h - 4, ceilY = 3;
    fillRect(g, 0, floorY, w, h, '1');
    fillRect(g, 0, 0, w, ceilY, '2');
    let x = 2;
    while (x < w - 3) {
      const span = 3 + Math.floor(r() * 5);
      const pick = r();
      if (pick < .35) fillRect(g, x, floorY, Math.min(x + span, w), floorY + 1, r() < .5 ? '9' : 'a');
      else if (pick < .5) { fillRect(g, x, floorY - 1, Math.min(x + span, w - 1), floorY, 'f'); spots.push([x, floorY - 3]); }
      else if (pick < .62) { for (let i = 0; i < span; i++) put(g, x + i, floorY, '4'); }
      else spots.push([x + 1, floorY - 2]);
      if (r() < .4) {
        const ly = floorY - 4 - Math.floor(r() * 2);
        fillRect(g, x, ly, Math.min(x + span, w - 1), ly + 1, '3');
        spots.push([x + 1, ly - 1]);
      }
      x += span + 1 + Math.floor(r() * 2);
    }
    return { g, ents, spots, start: { x: T, y: (floorY - 2) * T }, ground: floorY };
  }

  // A climb in steps, which reads as built rather than grown.
  function stairs(r, o) {
    const { w, h } = o, g = blank(w, h), ents = [], spots = [];
    let y = h - 3, x = 0;
    fillRect(g, 0, y, 4, h, '1');
    x = 4;
    while (x < w - 2) {
      const run = 2 + Math.floor(r() * 3);
      const rise = r() < .7 ? 1 : 2;
      y = Math.max(4, y - rise);
      fillRect(g, x, y, Math.min(x + run, w), h, r() < .2 ? '7' : '1');
      spots.push([x, y - 1]);
      if (r() < .2) put(g, x + run - 1, y - 1, '4');
      x += run + (r() < .3 ? 1 + Math.floor(r() * 2) : 0);
    }
    return { g, ents, spots, start: { x: T, y: (h - 5) * T }, ground: null };
  }

  // A road that comes at you: walls either side, obstacles in the lanes.
  function roadway(r, o) {
    const { w, h, theme } = o, g = blank(w, h), ents = [], spots = [];
    let left = 2, right = w - 3;
    const lane = [];
    for (let y = h - 1; y >= 0; y--) {
      if (r() < .3) { left += r() < .5 ? -1 : 1; right += r() < .5 ? -1 : 1; }
      left = Math.max(1, Math.min(left, Math.floor(w / 2) - 3));
      right = Math.min(w - 2, Math.max(right, Math.floor(w / 2) + 3));
      for (let x = 0; x <= left; x++) put(g, x, y, '2');
      for (let x = right; x < w; x++) put(g, x, y, '2');
      // A surface and a centre line, so it reads as a road rather than a gap
      // between two walls.
      for (let x = left + 1; x < right; x++) put(g, x, y, 'j');
      if (y % 4 < 2) put(g, Math.round((left + right) / 2), y, 'k');
      lane[y] = [left, right];
      // something to swerve around
      if (y < h - 8 && r() < .16) {
        const bx = left + 1 + Math.floor(r() * Math.max(1, right - left - 2));
        put(g, bx, y, theme === 'volcano' ? 'e' : '7');
        if (r() < .4) put(g, Math.min(right - 1, bx + 1), y, '7');
      } else if (y < h - 8 && r() < .16) {
        spots.push([left + 1 + Math.floor(r() * Math.max(1, right - left - 2)), y]);
      }
    }
    for (let x = 1; x < w - 1; x++) put(g, x, 0, 'i');       // the finish line
    // Start on the road, with clear tarmac ahead - the lane wanders, so the
    // middle of the level is not necessarily the middle of the road.
    const sy = h - 4, [l0, r0] = lane[sy] || [2, w - 3];
    const sx = Math.round((l0 + r0) / 2);
    for (let y = sy - 3; y <= Math.min(h - 1, sy + 2); y++) {
      const [ll, rr] = lane[y] || [l0, r0];
      for (let x = Math.max(ll + 1, sx - 2); x <= Math.min(rr - 1, sx + 2); x++) put(g, x, y, 'j');
    }
    return { g, ents, spots, start: { x: sx * T, y: sy * T }, ground: null };
  }

  // Open space with drifting cover: a lane to fly up, shooting.
  function starlane(r, o) {
    const { w, h } = o, g = blank(w, h), ents = [], spots = [];
    for (let y = 0; y < h; y++) { put(g, 0, y, '2'); put(g, w - 1, y, '2'); }
    const sx = Math.floor(w / 2), sy = h - 4;
    for (let y = h - 10; y > 4; y -= 3 + Math.floor(r() * 3)) {
      if (r() < .45) {
        const bx = 2 + Math.floor(r() * (w - 6));
        const span = 2 + Math.floor(r() * 3);
        for (let i = 0; i < span; i++) put(g, bx + i, y, '7');
      }
      if (r() < .5) spots.push([2 + Math.floor(r() * (w - 4)), y - 1]);
    }
    for (let x = 1; x < w - 1; x++) put(g, x, 0, 'i');
    for (let y = sy - 3; y <= Math.min(h - 1, sy + 2); y++)
      for (let x = sx - 2; x <= sx + 2; x++) put(g, x, y, '0');
    return { g, ents, spots, start: { x: sx * T, y: sy * T }, ground: null };
  }

  const SHAPES = { islands, cavern, tower, corridor, stairs, roadway, starlane };

  function chooseShape(want, theme, mech, size, r) {
    if (want.shape) return want.shape;
    if (size === 'tall') return 'tower';
    if (theme === 'sky') return 'islands';
    if (theme === 'cave' || theme === 'volcano') return 'cavern';
    if (theme === 'factory' || mech === 'belts') return 'corridor';
    if (theme === 'ruins' || theme === 'temple') return 'stairs';
    return r() < .45 ? pick(r, ['islands', 'cavern', 'stairs']) : 'flat';
  }

  // ---------- building ----------
  function platform(r, o) {
    const { w, h, mech, theme, difficulty } = o;
    const g = Array.from({ length: h }, () => Array(w).fill('0'));
    const ground = h - 3;
    for (let y = ground; y < h; y++) for (let x = 0; x < w; x++) g[y][x] = '1';

    const pitChar = theme === 'volcano' ? 'e' : (mech === 'water' ? '6' : '4');
    let x = 6;
    while (x < w - 8) {
      if (r() < 0.26 + difficulty * 0.1) {
        const span = 2 + Math.floor(r() * (2 + difficulty));
        for (let px = x; px < Math.min(x + span, w - 4); px++) {
          for (let y = ground; y < h; y++) g[y][px] = '0';
          g[h - 1][px] = pitChar;
        }
        x += span + 4 + Math.floor(r() * 4);
      } else x += 3 + Math.floor(r() * 4);
    }

    const ledges = [];
    x = 4;
    while (x < w - 6) {
      if (r() < 0.55) {
        const span = 3 + Math.floor(r() * 3);
        const y = ground - (3 + Math.floor(r() * 3));
        const ch = mech === 'ice' ? '8' : mech === 'belts' ? (r() < .5 ? '9' : 'a') : '3';
        for (let lx = x; lx < Math.min(x + span, w - 2); lx++) g[y][lx] = ch;
        ledges.push([x, y, span]);
        x += span + 3 + Math.floor(r() * 4);
      } else x += 4 + Math.floor(r() * 5);
    }
    if (mech === 'springs') for (let i = 0; i < 2; i++) g[ground - 1][3 + Math.floor(r() * (w - 6))] = 'b';
    if (mech === 'breakables') for (let i = 0; i < 4; i++) g[ground - 4 - Math.floor(r() * 2)][3 + Math.floor(r() * (w - 6))] = '7';

    const ents = [];
    for (const [lx, ly, span] of ledges) {
      for (let i = 0; i < Math.min(2, span); i++) ents.push({ type: 'coin', x: (lx + i) * T + 1, y: (ly - 1) * T + 1 });
    }
    for (let i = 0; i < 3 + Math.floor(r() * 3); i++)
      ents.push({ type: 'coin', x: (2 + Math.floor(r() * (w - 4))) * T, y: (ground - 1) * T });
    if (r() < .5) ents.push({ type: 'gem', x: (2 + Math.floor(r() * (w - 4))) * T, y: (ground - 2) * T });

    const foes = ['walker', 'flyer', 'chaser', 'jumper', 'turret'];
    const count = (o.boss ? 4 : 1) + difficulty + Math.floor(r() * 2);
    for (let i = 0; i < count; i++)
      ents.push({ type: pick(r, foes.slice(0, 3 + difficulty)), x: (6 + Math.floor(r() * (w - 9))) * T,
                  y: (ground - 2) * T, dir: r() < .5 ? 1 : -1 });
    if (difficulty < 2 || r() < .4) ents.push({ type: 'heart', x: (3 + Math.floor(r() * (w - 5))) * T, y: (ground - 2) * T });

    let keys = 0;
    if (mech === 'doors') {
      const dx = Math.floor(w * 0.62);
      g[ground - 1][dx] = 'c'; g[ground - 2][dx] = 'c';
      ents.push({ type: 'key', x: (3 + Math.floor(r() * (dx - 5))) * T, y: (ground - 2) * T });
      keys = 1;
    }
    if (mech === 'moving') ents.push({ type: 'mover', x: Math.floor(w * .5) * T, y: (ground - 4) * T });
    ents.push({ type: 'goal', x: (w - 3) * T, y: (ground - 2) * T });
    return { g, ents, start: { x: 2 * T, y: (ground - 2) * T } };
  }

  /* ---- overhead layouts ----
     One layout made every overhead game the same game: four corner rooms and
     a crossroads, whether you asked for a dungeon, a farm or a tank battle.
     A dungeon is a grid of rooms joined by doorways; an arena is open ground
     with cover you can lose; the crossroads is still here, as one of three. */

  // A grid of walled rooms, joined into one connected map. Zelda's shape: you
  // always know which room you are in, and the doorway you came through.
  function tdRooms(r, o) {
    const { w, h, difficulty } = o;
    const g = Array.from({ length: h }, () => Array(w).fill('1'));
    const cols = w >= 30 ? 3 : 2, rowsN = h >= 22 ? 3 : 2;

    /* Where the walls fall. An even grid made every small dungeon the same
       dungeon: four identical rooms, doorways at the midpoints, and the only
       thing that ever changed was which walls got a hole. So the dividing
       lines wander, within enough of a margin that no room collapses. */
    const cuts = (span, n) => {
      const at = [0];
      const step = span / n;
      for (let k = 1; k < n; k++) {
        const drift = Math.round((r() - 0.5) * step * 0.5);
        at.push(Math.max(at[k - 1] + 6, Math.min(Math.round(k * step) + drift, span - 6 * (n - k))));
      }
      at.push(span - 1);
      return at;
    };
    const xs = cuts(w, cols), ys = cuts(h, rowsN);
    const room = (i, j) => ({ x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1] });

    const floors = [];
    for (let j = 0; j < rowsN; j++) for (let i = 0; i < cols; i++) {
      const R = room(i, j);
      for (let y = R.y0 + 1; y < R.y1; y++) for (let x = R.x0 + 1; x < R.x1; x++) g[y][x] = '0';
      floors.push({ i, j, R });
    }

    /* Join the rooms with a spanning tree, so every room is reachable without
       a single wall having to be guessed at, then open a couple of extra
       doorways so the map has loops rather than one forced route. */
    const seen = new Set(['0,0']);
    const edges = [];
    const frontier = [[0, 0]];
    while (frontier.length) {
      const [i, j] = frontier.splice(Math.floor(r() * frontier.length), 1)[0];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj, k = `${ni},${nj}`;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rowsN || seen.has(k)) continue;
        seen.add(k); edges.push([i, j, ni, nj]); frontier.push([ni, nj]);
      }
    }
    for (let extra = 0; extra < 2; extra++) {
      const i = Math.floor(r() * cols), j = Math.floor(r() * rowsN);
      const [di, dj] = pick(r, [[1, 0], [0, 1]]);
      if (i + di < cols && j + dj < rowsN) edges.push([i, j, i + di, j + dj]);
    }

    // A doorway sits somewhere along the shared wall, keeping clear of both
    // corners so it never opens into the wall running the other way.
    const along = (a, b) => a + 2 + Math.floor(r() * Math.max(1, b - a - 4));

    const last = floors[floors.length - 1];
    const doors = [];
    for (const [i, j, ni, nj] of edges) {
      const A = room(i, j), B = room(ni, nj);
      // A doorway on the goal room's wall is one you will have to unlock.
      const guards = (i === last.i && j === last.j) || (ni === last.i && nj === last.j);
      /* Two rooms are separated by two walls, not one - each keeps its own -
         so a doorway has to go through both or it connects nothing. And it is
         cut two cells wide, because the body walking through is taller than a
         tile and will not thread a single-cell hole. */
      const cells = [];
      if (ni !== i) {
        const x = (ni > i ? A.x1 : B.x1);                     // left wall of the pair
        // Anywhere along the wall, not always the middle of it.
        const y = along(A.y0, A.y1);
        for (const yy of [y, y + 1]) for (const xx of [x, x + 1]) cells.push([xx, yy]);
      } else {
        const y = (nj > j ? A.y1 : B.y1);                     // upper wall of the pair
        const x = along(A.x0, A.x1);
        for (const yy of [y, y + 1]) for (const xx of [x, x + 1]) cells.push([xx, yy]);
      }
      for (const [x, y] of cells) if (g[y] && g[y][x] !== undefined) g[y][x] = '0';
      doors.push({ cells, guards });
    }

    /* Something in the rooms. An empty box is a box whatever size it is, and
       a dungeon of them is one room drawn nine times - a pillar to walk round
       or a block to hide behind is what makes one room a different room from
       the next. Kept off the middle, which is where the doors lead and where
       the coins and the way out go. */
    const blocked = [].concat(...doors.map(d => d.cells));
    for (const f of floors) {
      const R = f.R;
      const iw = R.x1 - R.x0 - 1, ih = R.y1 - R.y0 - 1;
      if (iw < 6 || ih < 6) continue;
      for (let k = 0, want = 1 + Math.floor(r() * 3); k < want; k++) {
        const bw = 1 + Math.floor(r() * Math.min(3, iw - 4));
        const bh = 1 + Math.floor(r() * Math.min(3, ih - 4));
        const bx = R.x0 + 2 + Math.floor(r() * Math.max(1, iw - bw - 2));
        const by = R.y0 + 2 + Math.floor(r() * Math.max(1, ih - bh - 2));
        const cx = Math.floor((R.x0 + R.x1) / 2), cy = Math.floor((R.y0 + R.y1) / 2);
        // never on the spot the goal, the key or a coin is about to take
        if (bx <= cx + 1 && cx <= bx + bw && by <= cy + 1 && cy <= by + bh) continue;
        /* And never in a doorway or its approach. The doors are cut before
           this runs, so a block dropped on one seals the room it was meant to
           furnish - which is how a dungeon that was always solvable stopped
           being. A tile of clearance, because a body is wider than a cell. */
        if (blocked.some(([dx, dy]) => dx >= bx - 1 && dx <= bx + bw &&
                                       dy >= by - 1 && dy <= by + bh)) continue;
        const ch = r() < .3 ? '2' : '1';
        for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) g[y][x] = ch;
      }
    }

    const mid = f => ({ x: Math.floor((f.R.x0 + f.R.x1) / 2), y: Math.floor((f.R.y0 + f.R.y1) / 2) });
    const first = floors[0];
    const ents = [];
    for (const f of floors.slice(1, -1)) {
      const c = mid(f);
      ents.push({ type: 'coin', x: c.x * T, y: c.y * T });
      if (r() < .7) ents.push({ type: pick(r, ['walker', 'chaser', 'turret']),
                                x: (c.x + 1) * T, y: (c.y + 1) * T, dir: 1 });
    }
    for (let i = 0; i < difficulty; i++) {
      const f = pick(r, floors.slice(1));
      const c = mid(f);
      ents.push({ type: 'chaser', x: (c.x - 1) * T, y: c.y * T, dir: -1 });
    }

    /* Lock every way into the goal room and put the key in some other room.
       That is the shape of a dungeon - the way on is shut until you have been
       elsewhere - and locking all of them, rather than one door chosen at
       random, is what makes it certainly solvable rather than usually. */
    let keys = 0;
    const guarding = doors.filter(d => d.guards);
    const elsewhere = floors.slice(1, -1);
    if (guarding.length && elsewhere.length) {
      for (const d of guarding) for (const [x, y] of d.cells) g[y][x] = 'c';
      const kf = mid(pick(r, elsewhere));
      ents.push({ type: 'key', x: kf.x * T, y: kf.y * T });
      keys = 1;
    }
    const goalAt = mid(last);
    ents.push({ type: 'goal', x: goalAt.x * T, y: goalAt.y * T });
    const s = mid(first);
    return { g, ents, start: { x: s.x * T, y: s.y * T }, keys };
  }

  // Open ground with cover. Battle City's shape: nowhere to hide for long,
  // because brick is something your own gun takes away.
  function tdArena(r, o) {
    const { w, h, difficulty, armed } = o;
    const g = Array.from({ length: h }, () => Array(w).fill('0'));
    for (let x = 0; x < w; x++) { g[0][x] = '2'; g[h - 1][x] = '2'; }
    for (let y = 0; y < h; y++) { g[y][0] = '2'; g[y][w - 1] = '2'; }

    // Blocks of cover, mostly brick you can shoot away, some steel you cannot.
    const blocks = 6 + difficulty * 3;
    for (let i = 0; i < blocks; i++) {
      const bw = 2 + Math.floor(r() * 4), bh = 2 + Math.floor(r() * 3);
      const bx = 3 + Math.floor(r() * (w - bw - 6));
      const by = 3 + Math.floor(r() * (h - bh - 6));
      const ch = r() < .78 ? '7' : '2';
      for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) g[y][x] = ch;
    }
    // Keep the corner you start in clear, so you are not spawned inside cover.
    for (let y = 1; y < 5; y++) for (let x = 1; x < 6; x++) g[y][x] = '0';

    const ents = [];
    const far = () => {
      for (let tries = 0; tries < 40; tries++) {
        const x = 6 + Math.floor(r() * (w - 12)), y = 5 + Math.floor(r() * (h - 10));
        if (g[y][x] === '0' && (x > 10 || y > 8)) return { x, y };
      }
      return { x: w - 4, y: h - 4 };
    };
    /* Who you are fighting. Enemy tanks belong in a tank battle; an arena
       that is not one gets things that come at you rather than shoot at you,
       or a quiet village ends up defended by armour. */
    const foes = armed ? ['hunter', 'hunter', 'turret'] : ['chaser', 'walker', 'turret'];
    for (let i = 0; i < 3 + difficulty * 2; i++) {
      const p = far();
      ents.push({ type: pick(r, foes), x: p.x * T, y: p.y * T, dir: 1 });
    }
    for (let i = 0; i < 3; i++) { const p = far(); ents.push({ type: 'coin', x: p.x * T, y: p.y * T }); }
    const gp = far();
    ents.push({ type: 'goal', x: gp.x * T, y: gp.y * T });
    return { g, ents, start: { x: 2 * T, y: 2 * T }, keys: 0 };
  }

  /* A maze to be chased round. Not a level with a flag at the end: the board
     is the level, every dot has to go, and the four things hunting you can be
     hunted back for a few seconds at a time. Built symmetrically, because a
     maze you can read at a glance is the whole appeal - you are meant to know
     where the corner goes before you turn it. */
  function tdMaze(r, o) {
    const { w, h, difficulty } = o;
    const g = Array.from({ length: h }, () => Array(w).fill('2'));
    const half = Math.floor(w / 2);

    // Carve the left half on a two-tile grid, then mirror it.
    const cut = (x, y, cw, ch) => {
      for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
        if (g[y + j] && g[y + j][x + i] !== undefined) g[y + j][x + i] = '0';
      }
    };
    /* Corridors two wide with real wall between them. Spacing them three
       apart left one-tile walls, which reads as specks in an open room rather
       than as a maze - the wall has to be thick enough to be somewhere you
       cannot go. */
    const rows = [], cols = [];
    for (let y = 2; y < h - 3; y += 5) { cut(2, y, half - 3, 2); rows.push(y); }
    for (let x = 2; x < half - 3; x += 6) { cut(x, 2, 2, h - 4); cols.push(x); }
    // A few crossings closed off, so it is a maze and not a grid of streets.
    for (let i = 0; i < 1 + difficulty; i++) {
      const y = rows[1 + Math.floor(r() * Math.max(1, rows.length - 1))];
      const x = cols[Math.floor(r() * cols.length)];
      if (y === undefined || x === undefined) continue;
      for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
        if (g[y + j]) g[y + j][x + k] = '2';
      }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < half; x++) g[y][w - 1 - x] = g[y][x];

    // A corridor straight through the middle, so the two halves are one maze.
    const mid = Math.floor(h / 2);
    for (let x = 1; x < w - 1; x++) { g[mid][x] = '0'; if (g[mid + 1]) g[mid + 1][x] = '0'; }

    const open = [];
    for (let y = 1; y < h - 2; y++) for (let x = 1; x < w - 1; x++) {
      if (g[y][x] === '0' && g[y + 1][x] === '0') open.push([x, y]);
    }
    if (open.length < 24) return tdArena(r, o);          // too tight to chase in

    /* You start low and they start high, the way this game has always been
       laid out. Dropping everybody in the middle together put a ghost seven
       tiles away at the whistle. */
    const low = open.filter(([, y]) => y > h * 0.6);
    const start = (low[Math.floor(low.length / 2)] || open[Math.floor(open.length / 2)]);
    const far = open.filter(([x, y]) => Math.hypot(x - start[0], y - start[1]) > Math.min(w, h) / 2)
                    .sort((a, bb) => Math.hypot(bb[0] - start[0], bb[1] - start[1])
                                   - Math.hypot(a[0] - start[0], a[1] - start[1]));
    const ents = [];

    /* A dot on everything you can walk on, minus where the cast stands. This
       is what makes it a board to clear rather than a level to cross. */
    const busy = new Set([`${start[0]},${start[1]}`]);
    const corners = [open[0], open[open.length - 1],
                     far[0] || open[1], far[far.length - 1] || open[2]];
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      if (!c) continue;
      busy.add(`${c[0]},${c[1]}`);
      ents.push({ type: 'pellet', x: c[0] * T, y: c[1] * T });
    }
    /* Let out one at a time, a couple of seconds apart. All four at the
       whistle is not a chase, it is a pincer - and it made two mazes in five
       cost a life before anybody had touched a key. */
    const hunters = spread(far.length >= 4 ? far : open, 3 + difficulty);
    hunters.forEach(([x, y], i) => {
      busy.add(`${x},${y}`);
      ents.push({ type: 'ghost', x: x * T, y: y * T, dir: r() < .5 ? -1 : 1,
                  wake: +(1.5 + i * 2.5).toFixed(1) });
    });
    for (const [x, y] of open) {
      if (busy.has(`${x},${y}`)) continue;
      if ((x + y) % 2) continue;                          // every other cell, not a carpet
      ents.push({ type: 'dot', x: x * T + 2, y: y * T + 2 });
    }
    // Long enough to see where they are before they are on you.
    return { g, ents, start: { x: start[0] * T, y: start[1] * T },
             keys: 0, clearAll: true, grace: 2.6 };
  }

  /* A fixed screen with a wall of them coming down at you. The level is
     almost nothing - a floor, a roof and four shields - because the level is
     not the point: the formation is, and it arrives whatever the level says. */
  function invaders(r, o) {
    const { w, h, difficulty } = o;
    const g = Array.from({ length: h }, () => Array(w).fill('0'));
    for (let x = 0; x < w; x++) { g[0][x] = '2'; g[h - 1][x] = '2'; }
    for (let y = 0; y < h; y++) { g[y][0] = '2'; g[y][w - 1] = '2'; }

    /* Shields you shoot away by hiding behind them. Brick, because our own
       shots break brick - so cover is something you spend, and by the end of
       a game there is none of it left, which is the shape of the whole thing. */
    const bays = 4;
    for (let i = 0; i < bays; i++) {
      const cx = Math.round((i + 0.5) * w / bays);
      for (let dy = 0; dy < 2; dy++) for (let dx = -1; dx <= 1; dx++) {
        const y = h - 6 + dy, x = cx + dx;
        if (g[y] && g[y][x] !== undefined) g[y][x] = '7';
      }
    }

    const ents = [];
    /* The formation has to be narrower than the room it marches in. Filling
       the width meant it hit a wall on the first frame and dropped a row
       every frame after, so it reached the floor before anybody had shot
       twice - all the tension of this game is in the room it has left. */
    const cols = 5;
    const rows = 2 + difficulty;
    const left = Math.round((w - cols * 2) / 2);
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        ents.push({ type: 'invader', x: (left + rx * 2) * T, y: (2 + ry * 2) * T });
      }
    }
    return { g, ents, start: { x: Math.floor(w / 2) * T, y: (h - 3) * T },
             keys: 0, clearFoes: true, grace: 1.6 };
  }

  const TOPDOWN_SHAPES = { rooms: tdRooms, arena: tdArena, cross: topdown, maze: tdMaze };

  /* Which overhead layout the words asked for. A tank battle wants open
     ground and cover; a dungeon wants rooms and a locked door; anything else
     gets whichever fits, so two runs of "a forest" are not the same map. */
  /* Which cast of creatures a game gets. Left unset, every generated game
     drew the same handful of monsters whatever you asked for - which is a
     large part of why they all felt like the same game with a new palette. */
  function chooseCat(want, mode, theme, shape) {
    if (mode === 'racer') return 'racing';
    if (mode === 'shmup') return 'shooter';
    if ((want.abilities || []).includes('aimLock')) return 'shooter';
    /* Overhead is settled by the layout before the palette gets a say. A
       dungeon of rooms is a dungeon whatever colour the sky happens to be. */
    if (mode === 'topdown') return shape === 'rooms' ? 'dungeon'
                                 : (theme === 'ruins' || theme === 'temple') ? 'adventure'
                                 : theme === 'factory' ? 'scifi' : 'rpg';
    if (theme === 'factory' || theme === 'sky') return 'scifi';
    if ((want.abilities || []).includes('attack')) return 'shooter';
    if (theme === 'ruins' || theme === 'temple') return 'adventure';
    return 'platformer';
  }

  function chooseTopdown(want, r) {
    if (want.shape && TOPDOWN_SHAPES[want.shape]) return want.shape;
    /* Asking for doors and locked rooms is asking for a shape, and it beats
       the tank: a tank in a dungeon is a tank in a dungeon, but a request for
       locked rooms answered with an open field is the wrong game. */
    if (want.chase) return 'maze';
    if (want.mech === 'doors') return 'rooms';
    if (want.abilities && want.abilities.includes('aimLock')) return 'arena';
    if (want.boss) return 'arena';
    return pick(r, ['rooms', 'arena', 'cross']);
  }

  function topdown(r, o) {
    const { w, h, mech, difficulty } = o;
    const g = Array.from({ length: h }, () => Array(w).fill('1'));
    const rw = Math.floor(w * .38), rh = Math.floor(h * .38);
    const corners = [[2, 2], [w - rw - 2, 2], [2, h - rh - 2], [w - rw - 2, h - rh - 2]];
    for (const [rx, ry] of corners)
      for (let y = ry; y < Math.min(ry + rh, h - 1); y++)
        for (let x = rx; x < Math.min(rx + rw, w - 1); x++) g[y][x] = '0';
    const mx = Math.floor(w / 2), my = Math.floor(h / 2);
    for (let x = 2; x < w - 2; x++) { g[my][x] = '0'; g[my - 1][x] = '0'; }
    for (let y = 2; y < h - 2; y++) { g[y][mx] = '0'; g[y][mx - 1] = '0'; }
    const hazard = mech === 'water' ? '6' : '4';
    for (let i = 0; i < 2 + difficulty * 2; i++) g[3 + Math.floor(r() * (h - 6))][3 + Math.floor(r() * (w - 6))] = hazard;

    const ents = [];
    for (const [rx, ry] of corners)
      for (let i = 0; i < 2; i++)
        ents.push({ type: 'coin', x: (rx + 1 + Math.floor(r() * (rw - 2))) * T,
                    y: (ry + 1 + Math.floor(r() * (rh - 2))) * T });
    for (let i = 0; i < 1 + difficulty; i++)
      ents.push({ type: r() < .5 ? 'walker' : 'chaser', x: (3 + Math.floor(r() * (w - 6))) * T,
                  y: (3 + Math.floor(r() * (h - 6))) * T, dir: 1 });
    let keys = 0;
    if (mech === 'doors' || r() < .4) {
      /* The lock goes across the crossroads, which cuts the map into a left
         half and a right half. The start is in the top-left corner and the
         goal in the bottom-right, so the key has to be in one of the two
         rooms on the left - it was in the top-right one, behind the very door
         it opens, every single time a door was placed. */
      for (let x = mx - 1; x <= mx; x++) g[my][x] = 'c';
      ents.push({ type: 'key', x: (corners[2][0] + 2) * T, y: (corners[2][1] + 2) * T });
      keys = 1;
    }
    ents.push({ type: 'goal', x: (corners[3][0] + 2) * T, y: (corners[3][1] + 2) * T });
    return { g, ents, start: { x: 3 * T, y: 3 * T }, keys };
  }

  // Shapes lay out the ground and mark where a pickup would sit; this puts the
  // pieces on them, so every shape gets enemies, a goal and a way to finish.
  function populate(r, o, built, scrollMode) {
    if (scrollMode) {
      const { w, h, difficulty } = o;
      const ents = built.ents, spots = built.spots || [];
      coinsOn(ents, spots, r, 6 + Math.floor(r() * 4));
      const foes = scrollMode === 'shmup' ? ['flyer', 'turret', 'chaser'] : ['flyer', 'walker'];
      for (let i = 0; i < 4 + difficulty * 3; i++) {
        const ex = 2 + Math.floor(r() * (w - 5)), ey = 6 + Math.floor(r() * (h - 14));
        ents.push({ type: pick(r, foes), x: ex * T, y: ey * T, dir: r() < .5 ? 1 : -1 });
      }
      if (r() < .6) ents.push({ type: 'heart', x: Math.floor(w / 2) * T, y: Math.floor(h * .4) * T });
      const safeY = (h - 4) * T;
      built.ents = ents.filter(e => !ENEMY_TYPES.has(e.type) || Math.abs(e.y - safeY) > 10 * T);
      return;                       // the finish is the exit strip at the top
    }

    const { w, h, difficulty, mech } = o;
    const ents = built.ents, spots = built.spots || [];
    coinsOn(ents, spots, r, 5 + Math.floor(r() * 4));
    if (r() < .5 && spots.length) {
      const [gx, gy] = spots.splice(Math.floor(r() * spots.length), 1)[0];
      ents.push({ type: 'gem', x: gx * T, y: gy * T });
    }
    const solidUnder = (tx, ty) => {
      for (let y = ty; y < h; y++) if (built.g[y] && built.g[y][tx] !== '0') return y;
      return null;
    };
    const foes = ['walker', 'flyer', 'chaser', 'jumper', 'turret'];
    const count = (o.boss ? 4 : 1) + difficulty + Math.floor(r() * 2);
    for (let i = 0; i < count; i++) {
      const tx = 4 + Math.floor(r() * (w - 8));
      const fy = solidUnder(tx, 3);
      if (fy === null) continue;
      ents.push({ type: pick(r, foes.slice(0, 3 + difficulty)), x: tx * T, y: (fy - 2) * T, dir: r() < .5 ? 1 : -1 });
    }
    if (difficulty < 2 || r() < .4) {
      const tx = 3 + Math.floor(r() * (w - 6));
      const fy = solidUnder(tx, 3);
      if (fy !== null) ents.push({ type: 'heart', x: tx * T, y: (fy - 2) * T });
    }
    if (mech === 'moving') {
      const tx = Math.floor(w * .5), fy = solidUnder(tx, 3);
      if (fy !== null) ents.push({ type: 'mover', x: tx * T, y: (fy - 5) * T });
    }
    // the flag goes on the last solid thing, so it is always reachable-looking
    let gx = w - 3, gy = null;
    for (let tx = w - 3; tx >= 2 && gy === null; tx--) { gy = solidUnder(tx, 3); gx = tx; }
    ents.push({ type: 'goal', x: gx * T, y: ((gy ?? h - 4) - 2) * T });
  }

  // Scripts are assembled from the recipe library, so a generated game gets the
  // same rules a person would pick rather than a thinner hand-written subset.
  function script(r, o, need) {
    const lib = window.NeoRecipes;
    const parts = [`on start\n  message "${pick(r, ['GO', 'GOOD LUCK', 'BEGIN', 'MOVE'])}"\nend`];
    const chosen = [];
    /* A recipe that does not suit this game is worse than no recipe: low
       gravity in an overhead game says nothing, and "FIND THE KEY" in a level
       with no key sends the player looking for something that is not there. */
    const take = id => {
      const rec = lib && lib.byId(id);
      if (!rec || chosen.includes(id)) return;
      if (lib.fitsMode && !lib.fitsMode(rec, o.mode)) return;
      if (lib.fitsWin && !lib.fitsWin(rec, o.win)) return;
      chosen.push(id); parts.push(rec.code);
    };

    if (o.timed) take('timer');
    if (o.boss) take('bossgate');
    if (o.keys > 0) take('jailbreak');
    if (o.theme === 'volcano' && r() < .5) take('rising');
    if (o.difficulty === 2 && r() < .35) take('sudden');
    if (o.shape === 'tower' && r() < .5) take('nudge');

    // then one or two for flavour, so no two generated games read alike
    const flavour = ['speedup', 'moon', 'waves', 'halfway', 'panic', 'combo', 'guide', 'blink', 'sweep'];
    const extra = 1 + Math.floor(r() * 2);
    /* Ask again when a pick does not fit. Counting attempts rather than
       recipes left overhead games with nothing but "GO" whenever the dice
       landed on two side-on ideas in a row. */
    for (let got = 0, guard = 0; got < extra && guard < 24; guard++) {
      const before = chosen.length;
      take(pick(r, flavour));
      if (chosen.length > before) got++;
    }

    return lib ? lib.merge(parts) : parts.join('\n');
  }

  // Nobody should die before they have moved. Clears anything harmful around
  // the spawn, makes sure there is something to stand on, and pushes enemies
  // out of arm's reach.
  /* A generated game had no voice at all - correct, playable and silent. A
     few beats give it one. They are cued the way a person would cue them: a
     line on arriving, a word at the halfway mark, something when it goes
     wrong. */
  const ARRIVE = {
    cave:    ['It is darker than the map promised.', 'Something lives down here.',
              'The air tastes of old water.', 'Whatever dug this did not use hands.',
              'Sound goes a long way in here.', 'The last torch is behind us.'],
    ice:     ['The floor will not hold a stop.', 'Cold enough to slow a step.',
              'Everything here is going somewhere, slowly.', 'Nothing sticks.',
              'The cracks are older than the ice.', 'Walk like you mean to fall.'],
    sky:     ['A long way down from here.', 'The wind does half the work.',
              'Nothing under this but weather.', 'The next one is further than it looks.',
              'Up here, a mistake takes a while to arrive.', 'Do not look for a floor.'],
    sunset:  ['We are losing the light.', 'One more before dark.',
              'The shadows have got long and confident.', 'An hour of this left, at most.',
              'Everything looks further at this hour.', 'The day is going without us.'],
    factory: ['Nothing here was built for people.', 'Mind the belts.',
              'It has been running with nobody to run it.', 'Something is still on down here.',
              'The machines kept their shift.', 'Do not put a hand where it moves.'],
    ruins:   ['Someone left in a hurry.', 'The walls remember more than we do.',
              'This was a room once.', 'Half of it is still standing, which is the half to use.',
              'They took the doors with them.', 'Old stone, newer damage.'],
    volcano: ['The floor is warm through the boot.', 'It is waking up.',
              'The rock here is younger than this morning.', 'Breathe shallow.',
              'Nothing grows on the fast route.', 'It has been patient long enough.'],
    temple:  ['We are not the first ones in.', 'Quiet. Too quiet for a temple.',
              'Someone swept this recently.', 'The steps are worn in the middle.',
              'It was built to be walked slowly.', 'Whatever this was for, it still is.'],
  };
  const HALFWAY = ['Halfway.', 'Nearly through.', 'Keep going.', 'That is most of it.',
                   'Further than I thought.', 'The back half is the short half.',
                   'Past the worst of it.', 'Do not stop to admire it.',
                   'Good. Again.', 'That is the middle behind us.',
                   'Still standing.', 'It gets easier or it does not.',
                   'Halfway is not most of the way.', 'On, then.'];
  const HIT = ['That hurt.', 'Careless.', 'Not again.', 'It is faster than it looks.',
               'That one was mine.', 'Do that less.', 'Noted.',
               'It has the measure of us.', 'Slower next time. Or quicker.',
               'That was avoidable.', 'Fine. Fine.', 'It only has to be lucky once.',
               'Less of that.', 'I felt that one.'];
  // Beats for the things a run actually does, rather than only for the clock.
  const KEYED = ['That opens something.', 'Now we can go on.',
                 'Somebody wanted this kept.', 'One door fewer.',
                 'Heavier than it looks.', 'It was not hidden well.',
                 'Good. The way through, then.', 'That is the hard part done.',
                 'A key with nothing written on it.', 'Whatever it opens is worth the walk.'];
  const KILLED = ['One down.', 'It will not be the last.',
                  'That was quick.', 'They will have heard that.',
                  'Fewer of them now.', 'Not built to take a hit.',
                  'Good. Move before the next one.', 'That is how it goes, then.',
                  'It came to us.', 'Cleaner than expected.'];
  const NEARLY = ['The end of this is close.', 'Almost out.',
                  'That is the far wall.', 'One more stretch.',
                  'The way out is ahead somewhere.', 'Nearly done with this place.',
                  'Do not hurry it now.', 'Close enough to smell the air.',
                  'The last of it.', 'Finish it.'];

  /* The engine takes five kinds of cue - a time, a score, a key count, a
     distance along the level, or an event - and the generator only ever used
     three of them. A story that can say something when you find the key or
     when you reach the far end is a story about the game being played rather
     than about the clock. */
  function story(r, o, need) {
    const beats = [{ at: +(0.6 + r() * 0.5).toFixed(1),
                     text: pick(r, ARRIVE[o.theme] || ['Here we go.']) }];
    if (need >= 4 && r() < 0.75) {
      beats.push({ score: Math.max(1, Math.round(need / 2)), text: pick(r, HALFWAY) });
    }
    if (o.keys > 0 && r() < 0.8) beats.push({ keys: 1, text: pick(r, KEYED) });
    if (r() < 0.45) beats.push({ on: 'kill', text: pick(r, KILLED) });
    /* Three quarters of the way across. Only where crossing the level is
       what you do: a racer and a shooter scroll past you and hold you in the
       frame, so a beat waiting on your x would fire at the start or never. */
    if (o.w >= 24 && o.mode !== 'racer' && o.mode !== 'shmup' && r() < 0.5) {
      beats.push({ reach: Math.round(o.w * 0.75), text: pick(r, NEARLY) });
    }
    if (r() < 0.55) beats.push({ on: 'hurt', text: pick(r, HIT) });
    return beats;
  }

  function makeStartSafe(built, o) {
    const { w, h } = o;
    const g = built.g;
    const sx = Math.floor(built.start.x / T), sy = Math.floor(built.start.y / T);
    const harmful = new Set(['4', '6', 'e', 'c']);
    for (let y = sy - 1; y <= sy + 2; y++)
      for (let x = sx - 1; x <= sx + 2; x++)
        if (g[y] && harmful.has(g[y][x])) g[y][x] = '0';
    // something solid under the feet, and headroom above them
    const foot = sy + 2;
    let landed = false;
    for (let y = foot; y < h; y++) if (g[y] && g[y][sx] !== '0' && !harmful.has(g[y][sx])) { landed = true; break; }
    if (!landed && g[Math.min(h - 1, foot)]) {
      for (let x = Math.max(0, sx - 1); x <= Math.min(w - 1, sx + 1); x++) g[Math.min(h - 1, foot)][x] = '1';
    }
    for (let y = sy - 1; y <= sy + 1; y++)
      for (let x = sx; x <= sx + 1; x++)
        if (g[y] && g[y][x] === '1' || (g[y] && g[y][x] === '2')) g[y][x] = '0';
    built.ents = built.ents.filter(e => {
      if (!ENEMY_TYPES.has(e.type)) return true;
      return Math.hypot(e.x - built.start.x, e.y - built.start.y) > 5 * T;
    });
  }
  const ENEMY_TYPES = new Set(['walker', 'flyer', 'chaser', 'jumper', 'turret', 'hunter', 'ghost', 'spike']);

  /* ---- dressing the level ----
     A generated level used to arrive bare: correct, playable, and looking
     like a diagram. Decor is inert, so it can be scattered freely - the only
     rules are that it stands on a surface and never sits on top of something
     the player needs to see.

     Sprite numbers come from the atlas in game-sprites.js. */
  const DECOR = {
    cave:    { tint: '#6f6890', on: [105, 103, 620, 622], back: [106, 107, 108] },
    ice:     { tint: '#9fd8f0', on: [50, 51, 98],         back: [57, 58] },
    sky:     { tint: '#cfe6ff', on: [52, 53, 99],         back: [] },
    sunset:  { tint: '#d4789f', on: [54, 103, 99],        back: [147, 148] },
    factory: { tint: '#7a7a8a', on: [8, 9, 10, 829],      back: [106, 108, 109] },
    ruins:   { tint: '#8a7f6a', on: [147, 148, 196, 622], back: [106, 107, 110] },
    volcano: { tint: '#c04a3a', on: [620, 622, 567],      back: [106, 107] },
    temple:  { tint: '#7fa8c4', on: [12, 57, 61, 567],    back: [107, 108, 109] },
  };

  // Distance is depth: the same tint, darker, is what puts a thing behind
  // the thing in front of it.
  const dim = (hex, k = .5) => {
    const n = parseInt(hex.slice(1), 16);
    const c = i => Math.round(((n >> i) & 255) * k);
    return '#' + ((1 << 24) | (c(16) << 16) | (c(8) << 8) | c(0)).toString(16).slice(1);
  };

  function dress(r, o, built) {
    const D = DECOR[o.theme];
    if (!D) return [];
    /* Nothing in the play area of a fixed shooter. The whole screen is the
       fight, and a tree standing in it looks like a thing you are meant to
       shoot at. */
    if (o.mode === 'invaders') return [];
    const { w, h } = o, g = built.g, props = [];
    /* Solid means solid, not "not empty". Road, water, grass and a checkpoint
       are all tiles you walk through, and counting them as ground meant a
       racing level was one continuous surface with no edge anywhere in it -
       which is why not one of them ever got a single thing beside the track. */
    const TILES = (window.NeoGame && window.NeoGame.TILES) || {};
    const solid = (x, y) => {
      if (y < 0 || y >= h || x < 0 || x >= w) return false;
      const t = TILES[parseInt(g[y][x], 36) || 0];
      return !!(t && t.solid === true);
    };

    // Nothing may be dropped where the player starts or where a piece sits;
    // scenery that hides a coin is worse than no scenery.
    const taken = new Set();
    const claim = (x, y) => { for (let d = -1; d <= 1; d++) taken.add(`${x + d},${y}`); };
    if (built.start) claim(Math.floor(built.start.x / T), Math.floor(built.start.y / T));
    for (const e of built.ents) claim(Math.floor(e.x / T), Math.floor(e.y / T));

    /* Every ledge and floor, not just the first one going down. Stopping at
       the first surface put all of a level's decor on its ceiling, because
       in a room with a roof the topmost solid tile with clear air above it
       is the roof. The scan also starts below the top two rows, so a sprite
       never hangs half off the top of the level. */
    const spots = [];
    for (let x = 1; x < w - 1; x++) {
      for (let y = 3; y < h; y++) {
        if (solid(x, y) && !solid(x, y - 1) && !solid(x, y - 2)) spots.push([x, y]);
      }
    }

    /* A road has no ledges. Its verge is a solid column from the top of the
       level to the bottom, so nothing in it ever has clear air above, and
       every racing level came out with not one thing beside the track. Seen
       from above, scenery stands at the edge of the road rather than on top
       of something - so take the inside edge of the verge instead. */
    if (o.mode === 'racer' || o.mode === 'shmup') {
      for (let y = 3; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!solid(x, y)) continue;
          if (solid(x - 1, y) && solid(x + 1, y)) continue;   // buried in the verge
          spots.push([x, y]);
        }
      }
    }

    // Distant scenery stands on the same surfaces as the rest, and is simply
    // drawn behind the level. Scattering it at a random height instead left
    // wall fragments hanging in the sky, which reads as debris, not depth.
    if (D.back.length) {
      for (const [x, y] of spots) {
        if (r() > .10) continue;
        props.push({ i: pick(r, D.back), x: x * T + T / 2, y: y * T + 3, t: dim(D.tint), b: 1 });
      }
    }

    const density = [.22, .17, .13][o.difficulty] ?? .17;
    for (const [x, y] of spots) {
      if (props.length >= 48) break;
      if (r() > density) continue;
      if (taken.has(`${x},${y - 1}`)) continue;
      // On a ledge a sprite stands on top of the tile; on a verge it stands in
      // it, because the tile is the ground rather than the thing under it.
      const onVerge = (o.mode === 'racer' || o.mode === 'shmup') && solid(x, y - 1);
      props.push({ i: pick(r, D.on), x: x * T + T / 2, y: (y + (onVerge ? 1 : 0)) * T, t: D.tint });
      claim(x, y - 1);
    }
    return props;
  }

  function generate(prompt, seed, force) {
    const want = read(prompt);
    const f = force || {};
    const s = seed || Math.random().toString(36).slice(2, 8);
    const r = rng(s + ':' + String(prompt || ''));
    const theme = f.theme || want.theme || pick(r, Object.keys(THEMES));
    // A run that turns into a racing game halfway through is not a run, so a
    // later stage is told what the first one decided to be.
    const mode = f.mode || want.mode || (r() < .22 ? 'topdown' : 'platform');
    const mech = want.mech || pick(r, ['plain', 'springs', 'belts', 'ice', 'doors', 'breakables', 'water', 'moving']);
    const difficulty = want.difficulty ?? Math.floor(r() * 3);
    const size = want.size || pick(r, ['small', 'normal', 'wide']);

    /* How big. These were four, three and three fixed pairs, so every game
       ever generated was one of ten canvases - which is a thing a model
       would learn as a rule rather than as a habit. The shapes still mean
       what they meant; they just are not all identical to the tile. */
    const jog = (v, by, lo) => Math.max(lo, v + Math.round((r() - 0.5) * 2 * by));
    let w, h;
    // A fixed screen is the screen. Nothing about it scrolls, so nothing
    // about it may be bigger than what you can see.
    if (mode === 'invaders') [w, h] = [20, 18];
    else if (mode === 'racer' || mode === 'shmup') [w, h] = [jog(20, 2, 16), jog(pick(r, [70, 90, 120]), 12, 56)];
    else if (mode === 'topdown') {
      /* A chase has to fit the screen. Half the game is seeing where the
         things hunting you are, and a board that scrolls hides them. */
      if (want.chase) [w, h] = [20, 18];
      else {
        const [bw, bh] = pick(r, [[26, 20], [30, 22], [34, 24]]);
        [w, h] = [jog(bw, 4, 22), jog(bh, 3, 18)];
      }
    } else {
      const [bw, bh] = { small: [28, 16], normal: [40, 18], wide: [56, 18], tall: [22, 34] }[size];
      [w, h] = [jog(bw, 4, 20), jog(bh, 2, 14)];
    }

    const armed = !!(want.abilities || []).includes('aimLock');
    const o = { w, h, mech, theme, difficulty, timed: !!want.timed, boss: !!want.boss, armed };
    let built;
    if (mode === 'racer' || mode === 'shmup') {
      built = (mode === 'racer' ? roadway : starlane)(r, o);
      populate(r, o, built, mode);
    } else if (mode === 'invaders') {
      built = invaders(r, o);
    } else if (mode === 'topdown') {
      o.shape = chooseTopdown(want, r);
      built = TOPDOWN_SHAPES[o.shape](r, o);
    }
    else {
      const shape = chooseShape(want, theme, mech, size, r);
      o.shape = shape;
      if (shape === 'flat') built = platform(r, o);
      else {
        built = SHAPES[shape](r, o);
        populate(r, o, built);
      }
    }
    makeStartSafe(built, { w, h });
    /* Nothing outside the level. Shapes clamp the tiles they draw and have
       more than once forgotten to clamp the things they put on them, and a
       coin past the right-hand edge is a pickup target nobody can ever meet.
       One place to catch it, rather than trusting six. */
    built.ents = built.ents.filter(e => e.x >= 0 && e.x < w * T && e.y >= 0 && e.y < h * T);
    const keys = built.ents.filter(e => e.type === 'key').length;
    // The script and the story are written for the level that was actually
    // built, not for the one the words asked for.
    o.keys = keys; o.mode = mode;
    // Which kind of ending this game has, so the script written for it does
    // not send the player after a flag that is not in the level.
    o.win = built.clearAll ? 'clear' : 'goal';
    // If a number of pickups was asked for, make sure that many exist rather
    // than quietly settling for however many the level happened to get.
    let need = 0;
    if ((mode === 'racer' || mode === 'shmup') && want.collect === undefined) need = 0;
    else if (want.collect !== undefined) {
      need = want.collect;
      const ground = mode === 'topdown' ? null : h - 3;
      let guard = 0;
      while (built.ents.filter(e => e.type === 'coin' || e.type === 'gem').length < need && guard++ < 60) {
        const cx = 2 + Math.floor(r() * (w - 4));
        const cy = ground !== null ? ground - 1 - Math.floor(r() * 4) : 3 + Math.floor(r() * (h - 6));
        built.ents.push({ type: 'coin', x: cx * T + 1, y: cy * T + 1 });
      }
      need = Math.min(need, built.ents.filter(e => e.type === 'coin' || e.type === 'gem').length);
    }
    /* A board to clear has no target to hit and no flag to reach - clearing it
       is the ending. Say so in the rules, and do not also ask for a number. */
    const clearAll = !!built.clearAll;
    const clearFoes = !!built.clearFoes;
    const pickups = built.ents.filter(e => e.type === 'coin' || e.type === 'gem').length;
    if (want.collect === undefined && pickups && r() < .75) need = Math.max(1, Math.round(pickups * pick(r, [.5, .7, 1])));

    const t = THEMES[theme];
    const player = { char: want.char || t.char };
    if (mode === 'shmup' || mode === 'invaders') player.attack = true;
    if (mode === 'invaders') player.speed = 96;
    if (mode === 'racer' || mode === 'shmup') player.speed = 96;
    for (const a of (want.abilities || [])) player[a] = true;
    /* A tank is a vehicle with a gun. Asking for one and being handed an
       unarmed man on foot is not what anybody meant, so the turret brings the
       gun and the hull with it. */
    if (built.grace) player.grace = built.grace;
    if (player.aimLock && mode === 'topdown') {
      player.attack = true;
      player.speed = 64;
      const tanks = (window.NeoSprites && window.NeoSprites.TOPDOWN_VEHICLES) || [];
      if (tanks.length && player.sprite == null) player.sprite = pick(r, tanks);
    } else {
      delete player.aimLock;
    }
    if (size === 'tall' && !player.doubleJump && !want.abilities.length) player.doubleJump = true;

    const spec = {
      name: (String(prompt || '').trim().slice(0, 40) || `${theme} run`).replace(/\s+/g, ' '),
      mode, seed: s,
      cat: chooseCat(want, mode, theme, o.shape),
      // Two bodies share the lives; a scroller holds one in the frame and is
      // not the place for it.
      ...(want.coop && !['racer', 'shmup'].includes(mode) ? { coop: true } : {}),
      sky0: t.sky[0], sky1: t.sky[1],
      player,
      start: built.start,
      lives: want.lives ?? [4, 3, 2][difficulty],
      level: { w, h, tiles: built.g.map(row => row.join('')).join('\n') },
      entities: built.ents,
      props: dress(r, o, built),
      rules: clearAll ? { collect: 0, keys, clearAll: true }
           : clearFoes ? { collect: 0, keys, clearFoes: true }
           : { collect: need, keys },
      story: story(r, o, need),
      script: script(r, o, need),
    };
    return { spec, understood: want };
  }

  /* How many rooms were asked for. "three levels", "a five stage run", or
     nothing, in which case the caller decides. */
  function stageCount(prompt) {
    const t = ' ' + String(prompt || '').toLowerCase() + ' ';
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
    let m = t.match(/\b(\d{1,2})\s*(levels?|stages?|rooms?|screens?)\b/);
    if (m) return Math.max(1, Math.min(8, parseInt(m[1], 10)));
    m = t.match(/\b(one|two|three|four|five|six|seven|eight)[\s-]*(levels?|stages?|rooms?|screens?)\b/);
    if (m) return words[m[1]];
    return null;
  }

  const asStage = sp => ({
    name: sp.name, level: sp.level, entities: sp.entities, props: sp.props,
    story: sp.story, start: sp.start, rules: sp.rules,
  });

  /* A game of several rooms. Each stage is generated the same way one whole
     game used to be, then they are stitched into a run that shares a player,
     a palette and a pool of lives. */
  function generateRun(prompt, seed, n) {
    const s = seed || Math.random().toString(36).slice(2, 8);
    const first = generate(prompt, s);
    const force = { mode: first.spec.mode };
    const levels = [asStage(first.spec)];
    for (let i = 1; i < Math.max(1, Math.min(8, n)); i++) {
      levels.push(asStage(generate(prompt, `${s}:${i}`, force).spec));
    }
    /* Rooms need their own names. Every stage taking the prompt as its name
       made a run read as the same room three times over, in the picker and
       on the timeline both. */
    const ROOMS = ['Approach', 'Descent', 'Crossing', 'The deep', 'Ascent', 'Threshold', 'The last room'];
    levels.forEach((st, i) => {
      st.name = i ? (ROOMS[(i - 1) % ROOMS.length]) : 'Way in';
      st.cut = i ? `STAGE ${i + 1}|${st.name.toUpperCase()}` : undefined;
    });
    const spec = { ...first.spec, levels };
    for (const k of ['level', 'entities', 'props', 'story', 'start', 'rules']) delete spec[k];
    spec.name = (String(prompt || '').trim().slice(0, 40) || first.spec.name);
    return { spec, understood: first.understood };
  }

  /* Can you actually get there? A level can be legal, look right and kill
     nobody, and still be a room with the exit walled off - which is how "it
     generated fine" and "it is not a game" end up both being true. So walk
     it: flood out from the start over everything a body fits through, and
     insist the goal is on the far side, and that every key is reachable
     without already having gone through the door it opens. */
  function reachable(spec, level, start, ents) {
    const W = level.w, H = level.h;
    const rows = String(level.tiles).trim().split('\n');
    const id = (x, y) => (rows[y] && rows[y][x] !== undefined) ? (parseInt(rows[y][x], 36) || 0) : 1;
    const T_ = window.NeoGame.TILES;
    const solid = (x, y, doorsOpen) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return true;
      const t = T_[id(x, y)] || T_[0];
      if (t.door) return !doorsOpen;
      return t.solid === true;
    };
    /* The body is 6 wide and 12 tall against 8px tiles, so it always occupies
       two rows. A gap one tile tall is not a gap it can stand in. */
    const open = (x, y, d) => !solid(x, y, d) && !solid(x, y + 1, d);

    const flood = (doorsOpen) => {
      const sx = Math.floor(start.x / T), sy = Math.floor(start.y / T);
      const seen = new Set();
      let q = [[sx, sy]];
      // If the start itself is tight, step out to the nearest cell that fits.
      if (!open(sx, sy, doorsOpen)) {
        q = [];
        for (let y = 0; y < H && !q.length; y++) for (let x = 0; x < W; x++)
          if (open(x, y, doorsOpen)) { q = [[x, y]]; break; }
      }
      for (const [x, y] of q) seen.add(x + ',' + y);
      while (q.length) {
        const [x, y] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
          if (seen.has(k) || !open(nx, ny, doorsOpen)) continue;
          seen.add(k); q.push([nx, ny]);
        }
      }
      return seen;
    };

    const shut = flood(false), opened = flood(true);
    const at = e => {
      // An entity stands on a tile; accept either row it overlaps.
      const x = Math.floor((e.x + 2) / T), y = Math.floor(e.y / T);
      return [x + ',' + y, x + ',' + (y + 1), x + ',' + (y - 1)];
    };
    const any = (set, e) => at(e).some(k => set.has(k));

    for (const e of ents) {
      if (e.type === 'key' && !any(shut, e)) return 'a key is behind the door it opens';
      if (e.type === 'goal' && !any(opened, e)) return 'the goal cannot be reached';
    }
    return null;
  }

  // Valid is not the same as playable. A game that passes every structural check
  // and then kills you before you have touched a key is still a bad game, so the
  // candidate is played for a moment before it is accepted.
  function survives(spec) {
    try {
      const cv = document.createElement('canvas');
      cv.width = 160; cv.height = 144;
      const g = window.NeoGame.create(cv, JSON.parse(JSON.stringify(spec)), { hud: false });
      // Every room, not only the first. A run whose third stage drowns you on
      // arrival is a broken run, and nobody finds out until they get there.
      const stages = Array.isArray(spec.levels) && spec.levels.length ? spec.levels
                   : [{ level: spec.level, entities: spec.entities, start: spec.start }];
      for (let i = 0; i < g.stages; i++) {
        if (i) g.goToStage(i);
        g.tick(3.2);
        if (g.state !== 'play') return false;
        if (g.lives < (spec.lives ?? 3)) return false;    // hit before moving
        if (g.player.y > g.level.h * 8 + 40) return false;
        if (g.scriptFault) return false;
        // Only overhead levels are walked. A platformer's route runs through
        // jumps, and a flood fill has no idea how high anything can jump.
        if (spec.mode === 'topdown') {
          const st = stages[i] || stages[0];
          const why = reachable(spec, st.level || spec.level, st.start || spec.start,
                                st.entities || spec.entities || []);
          if (why) return false;
        }
      }
      return true;
    } catch { return false; }
  }

  function generateValid(prompt, tries = 8, stages) {
    const n = stages || stageCount(prompt) || 1;
    let last = null;
    for (let i = 0; i < tries; i++) {
      const seed = Math.random().toString(36).slice(2, 8);
      const out = n > 1 ? generateRun(prompt, seed, n) : generate(prompt, seed);
      const v = window.NeoGame.validate(out.spec);
      last = { ...out, validation: v };
      if (v.ok && survives(out.spec)) return last;
    }
    return last;
  }

  window.NeoGameGen = { generate, generateRun, generateValid, stageCount, read, dress, rng, DECOR, THEMES, MECHANICS, ABILITIES };
})();
