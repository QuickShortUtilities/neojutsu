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
    factory: { sky: ['#0d0a16', '#3a2a4a'], char: 'robot',    words: ['factory', 'machine', 'robot', 'industrial', 'belt', 'steel'] },
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
  };
  const CHARS = ['hero', 'knight', 'mage', 'ninja', 'rogue', 'robot', 'beast', 'princess'];

  const rng = seed => window.NeoGame.rng(seed);
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const hit = (text, words) => words.some(w => text.includes(w));

  // ---------- reading the prompt ----------
  function read(prompt) {
    const t = ' ' + String(prompt || '').toLowerCase() + ' ';
    const want = {};

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

    if (/top.?down|overhead|dungeon|maze|room|zelda/.test(t)) want.mode = 'topdown';
    if (/platform|jump|side.?scroll|mario|climb|ledge/.test(t)) want.mode = want.mode || 'platform';
    // Some mechanics only make sense side-on, so asking for one implies the mode.
    if (!want.mode && ['springs', 'belts', 'breakables', 'moving', 'ice'].includes(want.mech))
      want.mode = 'platform';

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
    for (const c of CHARS) if (t.includes(c)) { want.char = c; break; }
    if (/\bboss|arena|horde|swarm|survive\b/.test(t)) want.boss = true;
    return want;
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
      for (let x = mx - 1; x <= mx; x++) g[my][x] = 'c';
      ents.push({ type: 'key', x: (corners[1][0] + 2) * T, y: (corners[1][1] + 2) * T });
      keys = 1;
    }
    ents.push({ type: 'goal', x: (corners[3][0] + 2) * T, y: (corners[3][1] + 2) * T });
    return { g, ents, start: { x: 3 * T, y: 3 * T }, keys };
  }

  function script(r, o, need) {
    const parts = [`on start\n  message "${pick(r, ['GO', 'GOOD LUCK', 'BEGIN', 'MOVE'])}"\nend`];
    if (o.timed) {
      const secs = pick(r, [30, 45, 60, 90]);
      parts.push(`on start\n  set left ${secs}\nend`);
      parts.push('on tick\n  every 1\n    set left left - 1\n    if left == 10\n      message "10 LEFT"\n    end\n    if left <= 0\n      lose\n    end\n  end\nend');
    }
    if (o.boss) parts.push('on tick\n  if enemies == 0\n    open\n    message "THE WAY IS OPEN"\n  end\nend');
    if (o.mech === 'doors') parts.push('on collect\n  if keys >= 1\n    message "DOOR OPEN"\n  end\nend');
    if (r() < .4) parts.push('on hurt\n  shake 3\nend');
    return parts.join('\n');
  }

  function generate(prompt, seed) {
    const want = read(prompt);
    const s = seed || Math.random().toString(36).slice(2, 8);
    const r = rng(s + ':' + String(prompt || ''));
    const theme = want.theme || pick(r, Object.keys(THEMES));
    const mode = want.mode || (r() < .22 ? 'topdown' : 'platform');
    const mech = want.mech || pick(r, ['plain', 'springs', 'belts', 'ice', 'doors', 'breakables', 'water', 'moving']);
    const difficulty = want.difficulty ?? Math.floor(r() * 3);
    const size = want.size || pick(r, ['small', 'normal', 'wide']);

    let w, h;
    if (mode === 'topdown') [w, h] = pick(r, [[26, 20], [30, 22], [34, 24]]);
    else [w, h] = { small: [28, 16], normal: [40, 18], wide: [56, 18], tall: [22, 34] }[size];

    const o = { w, h, mech, theme, difficulty, timed: !!want.timed, boss: !!want.boss };
    const built = mode === 'topdown' ? topdown(r, o) : platform(r, o);
    const keys = built.ents.filter(e => e.type === 'key').length;
    // If a number of pickups was asked for, make sure that many exist rather
    // than quietly settling for however many the level happened to get.
    let need = 0;
    if (want.collect !== undefined) {
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
    const pickups = built.ents.filter(e => e.type === 'coin' || e.type === 'gem').length;
    if (want.collect === undefined && pickups && r() < .75) need = Math.max(1, Math.round(pickups * pick(r, [.5, .7, 1])));

    const t = THEMES[theme];
    const player = { char: want.char || t.char };
    for (const a of (want.abilities || [])) player[a] = true;
    if (size === 'tall' && !player.doubleJump && !want.abilities.length) player.doubleJump = true;

    const spec = {
      name: (String(prompt || '').trim().slice(0, 40) || `${theme} run`).replace(/\s+/g, ' '),
      mode, seed: s,
      sky0: t.sky[0], sky1: t.sky[1],
      player,
      start: built.start,
      lives: want.lives ?? [4, 3, 2][difficulty],
      level: { w, h, tiles: built.g.map(row => row.join('')).join('\n') },
      entities: built.ents,
      rules: { collect: need, keys },
      script: script(r, o, need),
    };
    return { spec, understood: want };
  }

  // Generate, check, and try again with a new seed if the result is not playable.
  function generateValid(prompt, tries = 6) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const out = generate(prompt, Math.random().toString(36).slice(2, 8));
      const v = window.NeoGame.validate(out.spec);
      last = { ...out, validation: v };
      if (v.ok) return last;
    }
    return last;
  }

  window.NeoGameGen = { generate, generateValid, read, THEMES, MECHANICS, ABILITIES };
})();
