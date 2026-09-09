/* A game, written out as a GB Studio project.

   The point is a real Game Boy ROM. Writing a C backend means solving bank
   switching, VRAM budgets and the ten-sprites-per-scanline rule, all of which
   GB Studio's authors already solved - so the short road to a .gb file is to
   hand them a project and let their compiler do it:

       our spec  ->  .gbsproj  ->  GB Studio  ->  game.gb

   tools/export_gbsproj.py does the same job from the command line and reads
   its tile table out of this file, so the two cannot drift. This one runs in
   the browser, which is where the games are, and hands back a zip.

   What travels: the tilemap as a background picture, its solid tiles as the
   scene's collision layer, and every coin, key, enemy and goal as an actor
   drawn from the same atlas the browser draws from. What does not: tinted
   decor, per-prop colour and our scripts, none of which have a counterpart
   over there. A Game Boy also has hard limits on sprites per scanline that
   our levels do not respect - twenty coins in a row is fine here and will
   flicker there. */
(() => {
  'use strict';
  const T = 8;
  // The four greens, darkest first, as GB Studio indexes them.
  const DMG = [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]];
  // GB Studio keys sprite transparency on this exact green.
  const SPRITE_KEY = [101, 255, 0];

  /* Which of the four shades a tile of ours is drawn in, and whether it stops
     you. GB Studio collision bits: 1 top, 2 bottom, 4 left, 8 right, 16
     ladder. This table is the shared definition - the Python exporter reads
     it from here rather than keeping a second copy. */
  const TILE_LOOK = {
    0:  [3, 0x00],   // sky
    1:  [0, 0x0f],   // ground
    2:  [0, 0x0f],   // stone
    3:  [1, 0x01],   // ledge, stood on from above
    4:  [1, 0x00],   // spikes - hazards are not collision on their hardware
    5:  [2, 0x10],   // ladder
    6:  [2, 0x00],   // water
    7:  [1, 0x0f],   // brick
    8:  [2, 0x0f],   // ice
    9:  [1, 0x0f],   // belt right
    10: [1, 0x0f],   // belt left
    11: [1, 0x0f],   // spring
    12: [0, 0x0f],   // door
    13: [2, 0x00],   // checkpoint
    14: [1, 0x00],   // lava
    15: [1, 0x0f],   // crate
    16: [2, 0x00],   // grass
    17: [1, 0x00],   // backwall
    18: [2, 0x00],   // exit
    19: [2, 0x00],   // road
    20: [3, 0x00],   // road line
  };
  const look = id => TILE_LOOK[id] || TILE_LOOK[0];

  /* Which of their scene types each of ours becomes. Everything that was not
     a platformer used to go across as TOPDOWN, which turned a rider into a
     room seen from above and a falling-block well into one as well. `null`
     means there is no counterpart over there at all, and saying so is better
     than exporting a shape their engine cannot run. */
  const SCENE_TYPE = {
    platform: 'PLATFORM',
    rider:    'PLATFORM',      // side-on, with gravity
    topdown:  'TOPDOWN',
    invaders: 'TOPDOWN',       // a fixed screen; they have no name for one
    racer:    'TOPDOWN',
    shmup:    'SHMUP',         // this one they do have
    /* GB Studio's SHMUP scrolls up. A cave that travels sideways lands as a
       platform scene with no gravity to speak of - the corridor and the cast
       arrive intact, and the scrolling is the part that does not travel. */
    scramble: 'PLATFORM',
    blocks:   null,            // a well is not a scene
  };

  // ---------- a zip, stored rather than compressed ----------
  /* Nothing here is big enough for deflate to be worth writing, and a stored
     entry is a header, the bytes, and a checksum. */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const utf8 = s => new TextEncoder().encode(s);

  function zip(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const { name, bytes } of entries) {
      const nm = utf8(name), sum = crc32(bytes);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);        // version needed
      head.setUint16(6, 0, true);         // flags
      head.setUint16(8, 0, true);         // stored
      head.setUint16(10, 0, true);        // time
      head.setUint16(12, 0x21, true);     // date - 1 Jan 1980, the zero of this format
      head.setUint32(14, sum, true);
      head.setUint32(18, bytes.length, true);
      head.setUint32(22, bytes.length, true);
      head.setUint16(26, nm.length, true);
      head.setUint16(28, 0, true);
      parts.push(new Uint8Array(head.buffer), nm, bytes);

      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true); dir.setUint16(6, 20, true);
      dir.setUint16(8, 0, true); dir.setUint16(10, 0, true);
      dir.setUint16(12, 0, true); dir.setUint16(14, 0x21, true);
      dir.setUint32(16, sum, true);
      dir.setUint32(20, bytes.length, true);
      dir.setUint32(24, bytes.length, true);
      dir.setUint16(28, nm.length, true);
      dir.setUint16(30, 0, true); dir.setUint16(32, 0, true);
      dir.setUint16(34, 0, true); dir.setUint16(36, 0, true);
      dir.setUint32(38, 0, true);
      dir.setUint32(42, offset, true);
      central.push(new Uint8Array(dir.buffer), nm);
      offset += 30 + nm.length + bytes.length;
    }
    const dirBytes = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, dirBytes, true);
    end.setUint32(16, offset, true);
    end.setUint16(20, 0, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)],
                    { type: 'application/zip' });
  }

  // ---------- pictures ----------
  const png = canvas => new Promise(res =>
    canvas.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), 'image/png'));

  function backgroundCanvas(grid, w, h) {
    const cv = document.createElement('canvas');
    cv.width = w * T; cv.height = h * T;
    const ctx = cv.getContext('2d');
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const [shade, solid] = look(grid[ty][tx]);
        // A lit lip on the top edge of anything solid, so a floor reads as a
        // floor rather than a slab.
        const lip = solid && (ty === 0 || !look(grid[ty - 1][tx])[1]);
        ctx.fillStyle = `rgb(${DMG[shade].join(',')})`;
        ctx.fillRect(tx * T, ty * T, T, T);
        if (lip) {
          ctx.fillStyle = `rgb(${DMG[2].join(',')})`;
          ctx.fillRect(tx * T, ty * T, T, 2);
        }
      }
    }
    return cv;
  }

  function spriteCanvas(idx) {
    const art = window.NeoSprites;
    const cv = document.createElement('canvas');
    cv.width = 16; cv.height = 16;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = `rgb(${SPRITE_KEY.join(',')})`;
    ctx.fillRect(0, 0, 16, 16);
    if (!art || !art.loaded) return cv;
    // The atlas draws on a baseline; here the cell is wanted whole and square.
    const tmp = document.createElement('canvas');
    tmp.width = 16; tmp.height = 16;
    art.draw(tmp.getContext('2d'), idx, 8, 16, { colour: `rgb(${DMG[0].join(',')})` });
    ctx.drawImage(tmp, 0, 0);
    return cv;
  }

  // ---------- the project ----------
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 3 | 8)).toString(16);
      }));

  const slug = s => (String(s || 'scene').replace(/[^A-Za-z0-9]+/g, '_')
                     .replace(/^_+|_+$/g, '').toLowerCase() || 'scene').slice(0, 28);

  /* Their collision layer is run-length hex: a two-digit value then a hex
     count then '+', or a value then '!' for a single tile. The mirror of the
     importer's decoder. */
  function encodeRLE(cells) {
    const out = [];
    let i = 0;
    while (i < cells.length) {
      let j = i;
      while (j < cells.length && cells[j] === cells[i]) j++;
      const val = cells[i].toString(16).padStart(2, '0'), run = j - i;
      out.push(run === 1 ? `${val}!` : `${val}${run.toString(16)}+`);
      i = j;
    }
    return out.join('');
  }

  function readTiles(level) {
    const w = level.w | 0, h = level.h | 0;
    const grid = Array.from({ length: h }, () => new Array(w).fill(0));
    if (Array.isArray(level.tiles)) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y][x] = level.tiles[y * w + x] | 0;
    } else {
      const rows = String(level.tiles || '').trim().split('\n');
      for (let y = 0; y < Math.min(h, rows.length); y++)
        for (let x = 0; x < Math.min(w, rows[y].length); x++)
          grid[y][x] = parseInt(rows[y][x], 36) || 0;
    }
    return { grid, w, h };
  }

  const stagesOf = spec =>
    (Array.isArray(spec.levels) && spec.levels.length) ? spec.levels
      : [{ name: spec.name, level: spec.level, entities: spec.entities, start: spec.start }];

  function spriteFor(kind) {
    const art = window.NeoSprites;
    if (!art) return null;
    const item = art.ITEM && art.ITEM[kind];
    if (typeof item === 'number') return item;
    const base = art.BASE && art.BASE[kind];
    return Array.isArray(base) && base.length ? base[0] : null;
  }

  async function project(spec, title) {
    /* Some games have no counterpart on the hardware through this route. A
       falling-block game is rules, not a room: there is nothing in its level
       but the walls of the well, and handing that over as a scene would
       produce a project that opens and does nothing. */
    if (SCENE_TYPE[spec.mode] === null) {
      throw new Error(`a ${spec.mode} game has no GB Studio equivalent - `
                    + 'its rules are the game, and only rooms travel this way');
    }
    const name = title || spec.name || 'neojutsu-game';
    const files = [];
    const add = (path, obj) => files.push({ name: path, bytes: utf8(JSON.stringify(obj, null, 2)) });
    const stages = stagesOf(spec);

    // One sprite per kind of thing, because several rooms share a coin and the
    // hardware wants one sheet for all of them.
    const sprites = {};
    for (const st of stages) {
      for (const e of (st.entities || [])) {
        if (!e || sprites[e.type]) continue;
        const idx = spriteFor(e.type);
        if (idx == null) continue;
        const id = uuid(), nm = slug(e.type);
        files.push({ name: `assets/sprites/${nm}.png`, bytes: await png(spriteCanvas(idx)) });
        add(`project/sprites/${nm}.gbsres`, {
          _resourceType: 'sprite', id, name: e.type, symbol: `sprite_${nm}`,
          numFrames: 1, filename: `${nm}.png`, width: 16, height: 16,
          canvasWidth: 16, canvasHeight: 16,
          boundsX: 0, boundsY: 0, boundsWidth: 16, boundsHeight: 16,
          states: [{
            id: uuid(), name: '', animationType: 'fixed', flipLeft: false,
            animations: [{ id: uuid(), frames: [{
              id: uuid(),
              // Four hardware tiles make one 16x16 sprite.
              tiles: [[0, 0], [8, 0], [0, 8], [8, 8]].map(([x, y]) => ({
                id: uuid(), x, y, sliceX: x, sliceY: y, palette: 0,
                flipX: false, flipY: false, objPalette: 'OBP0',
                paletteIndex: 0, priority: false,
              })),
            }] }].concat(Array.from({ length: 7 }, () => ({ id: uuid(), frames: [] }))),
          }],
        });
        sprites[e.type] = id;
      }
    }

    let first = null;
    let n = 0;
    for (const st of stages) {
      const level = st.level || {};
      if (!level.w) continue;
      const { grid, w, h } = readTiles(level);
      const room = slug(st.name || `room ${n + 1}`);
      const sid = uuid(), bid = uuid();
      if (!first) first = { sid, start: st.start || { x: T, y: T } };

      files.push({ name: `assets/backgrounds/${room}.png`,
                   bytes: await png(backgroundCanvas(grid, w, h)) });
      add(`assets/backgrounds/${room}.png.gbsres`, {
        _resourceType: 'background', id: bid, name: room, symbol: `bg_${room}`,
        tileColors: '', filename: `${room}.png`, width: w, height: h,
        imageWidth: w * T, imageHeight: h * T, autoColor: false,
      });

      const cells = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push(look(grid[y][x])[1]);
      add(`project/scenes/${room}/scene.gbsres`, {
        _resourceType: 'scene', id: sid, _index: n,
        type: SCENE_TYPE[spec.mode] || 'TOPDOWN',
        name: st.name || `Room ${n + 1}`, symbol: `scene_${room}`,
        x: 40 + n * 240, y: 40, width: w, height: h,
        backgroundId: bid, tilesetId: '', colorModeOverride: 'none',
        paletteIds: [], spritePaletteIds: [], autoFadeSpeed: 1,
        collisions: encodeRLE(cells),
        script: [], playerHit1Script: [], playerHit2Script: [], playerHit3Script: [],
      });

      (st.entities || []).forEach((e, i) => {
        const sp = sprites[e && e.type];
        if (!sp) return;
        add(`project/scenes/${room}/actors/${slug(`${e.type}_${i}`)}.gbsres`, {
          _resourceType: 'actor', id: uuid(), name: `${e.type} ${i + 1}`,
          symbol: `actor_${room}_${i}`, spriteSheetId: sp, prefabId: '',
          frame: 0, animate: false, direction: 'down', moveSpeed: 1, animSpeed: 15,
          paletteId: '', isPinned: false, persistent: false, collisionGroup: '',
          prefabScriptOverrides: {},
          // Their positions are in tiles; ours are in pixels.
          x: Math.max(0, (e.x | 0) / T | 0), y: Math.max(0, (e.y | 0) / T | 0),
          _index: i,
          script: [], startScript: [], updateScript: [],
          hit1Script: [], hit2Script: [], hit3Script: [],
        });
      });
      n++;
    }
    if (!first) return null;

    add('project/settings.gbsres', {
      _resourceType: 'settings',
      startSceneId: first.sid,
      startX: Math.max(0, (first.start.x | 0) / T | 0),
      startY: Math.max(0, (first.start.y | 0) / T | 0),
      startDirection: 'right', startMoveSpeed: 1, startAnimSpeed: 15,
      showCollisions: true, showConnections: 'selected',
      defaultBackgroundPaletteIds: ['default-bg-1', 'default-bg-2', 'default-bg-3',
                                    'default-bg-4', 'default-bg-5', 'default-bg-6'],
      defaultSpritePaletteIds: Array.from({ length: 8 }, () => 'default-sprite'),
      defaultUIPaletteId: 'default-ui', musicDriver: 'huge', cartType: 'mbc5',
    });
    add('project/variables.gbsres', { _resourceType: 'variables', variables: [] });
    add(`${slug(name)}.gbsproj`, {
      _resourceType: 'project', name, author: 'NeoJutsu', notes: '',
      _version: '4.2.0', _release: '10',
    });

    return { blob: zip(files), rooms: n, sprites: Object.keys(sprites).length, files: files.length };
  }

  window.NeoGBS = { project, zip, crc32, encodeRLE, TILE_LOOK, SCENE_TYPE, DMG, SPRITE_KEY };
})();
