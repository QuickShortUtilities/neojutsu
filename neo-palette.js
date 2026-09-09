/* The hardware look, shared by every studio.
 *
 * One definition of the palettes and one implementation of the snap, so a game
 * frame, a video frame and a picker thumbnail cannot disagree about what a
 * Game Boy looks like.
 */
(() => {
  'use strict';

  const PALETTES = {
    gameboy: { label: 'Game Boy · DMG', size: [160, 144], colors: ['#0f380f','#306230','#8bac0f','#9bbc0f'] },
    nes:     { label: 'NES · 2A03', size: [256, 240], colors: ['#000000','#fcfcfc','#bcbcbc','#7c7c7c','#0000fc','#0078f8','#3cbcfc','#a4e4fc','#00b800','#b8f818','#e40058','#f87858','#f8b800','#fcfcb0','#6844fc','#d800cc'] },
    genesis: { label: 'Genesis · YM2612', size: [320, 224], colors: ['#000000','#242424','#484848','#6d6d6d','#919191','#b6b6b6','#dadada','#ffffff','#002480','#0048ff','#00b6ff','#00ff91','#248000','#ffb600','#ff2400','#b6006d'] },
    c64:     { label: 'C64 · SID', size: [320, 200], colors: ['#000000','#ffffff','#880000','#aaffee','#cc44cc','#00cc55','#0000aa','#eeee77','#dd8855','#664400','#ff7777','#333333','#777777','#aaff66','#0088ff','#bbbbbb'] },
    mono:    { label: '1-bit · Macintosh', size: [512, 342], colors: ['#000000','#ffffff'] },
  };

  /* Games are always this shape. A palette changes the colours and nothing
     else: a generated game lands in a handheld frame whichever chip is
     picked, never a phone crop or a widescreen one. The Video Studio still
     takes its size from the chip, because a video is not a handheld.
     160x144 is the Game Boy and the Game Gear both. */
  const GAME_FRAME = [160, 144];

  const BAYER = {
    bayer4: { n: 4, m: [0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5] },
    bayer2: { n: 2, m: [0,2, 3,1] },
    none: null,
  };

  const rgb = hex => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
  const paletteRGB = key => (PALETTES[key] || PALETTES.gameboy).colors.map(rgb);
  const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;

  // Brightness and contrast, then dither, then the nearest hardware colour.
  function snap(ctx, w, h, cfg = {}) {
    const chip = cfg.chip || 'gameboy';
    const bright = cfg.bright || 0;
    const contrastAmt = cfg.contrast || 0;
    const bay = BAYER[cfg.dither === undefined ? 'bayer4' : cfg.dither];
    const dithAmt = cfg.dithAmt === undefined ? 0.6 : cfg.dithAmt;

    const frame = ctx.getImageData(0, 0, w, h), data = frame.data;
    const pal = paletteRGB(chip), levels = pal.length;
    const contrast = (259 * (contrastAmt + 255)) / (255 * (259 - contrastAmt));
    const spread = bay ? (255 / levels) * dithAmt : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let r = data[i], g = data[i + 1], b = data[i + 2];
        r = contrast * (r - 128) + 128 + bright;
        g = contrast * (g - 128) + 128 + bright;
        b = contrast * (b - 128) + 128 + bright;
        if (bay) {
          const t = (bay.m[(y % bay.n) * bay.n + (x % bay.n)] / (bay.n * bay.n)) - 0.5;
          r += t * spread; g += t * spread; b += t * spread;
        }
        r = clamp255(r); g = clamp255(g); b = clamp255(b);
        let best = 0, bestD = Infinity;
        for (let p = 0; p < levels; p++) {
          const c = pal[p], dr = r - c[0], dg = g - c[1], db = b - c[2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = p; }
        }
        const c = pal[best];
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
      }
    }
    ctx.putImageData(frame, 0, 0);
  }

  window.NeoPalette = { PALETTES, BAYER, GAME_FRAME, paletteRGB, snap };
})();
