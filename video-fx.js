/* Post effects for the Video Studio. Everything here runs on the low-res buffer
   BEFORE the palette snap, so a glow or a glitch gets dithered into the
   hardware palette like any other picture rather than floating on top of it. */
(() => {
  'use strict';
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;

  // Cheap deterministic hash so glitch slices repeat for a given time slot
  // instead of flickering at random every frame.
  const hash = n => { let x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

  function bloom(d, w, h, amount, threshold) {
    const n = w * h, bright = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const lum = (d[p] * .299 + d[p + 1] * .587 + d[p + 2] * .114) / 255;
      bright[i] = lum > threshold ? (lum - threshold) / (1 - threshold) : 0;
    }
    const blur = new Float32Array(n), tmp = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      const src = pass ? blur : bright;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        tmp[i] = (src[i] + src[x > 0 ? i - 1 : i] + src[x < w - 1 ? i + 1 : i]) / 3;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        blur[i] = (tmp[i] + tmp[y > 0 ? i - w : i] + tmp[y < h - 1 ? i + w : i]) / 3;
      }
    }
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const b = blur[i] * amount * 255;
      d[p] = clamp(d[p] + b); d[p + 1] = clamp(d[p + 1] + b * .9); d[p + 2] = clamp(d[p + 2] + b * .8);
    }
  }

  function chroma(d, w, h, px) {
    if (px < 1) return;
    const copy = d.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const lx = Math.max(0, x - px), rx = Math.min(w - 1, x + px);
      d[p] = copy[(y * w + lx) * 4];
      d[p + 2] = copy[(y * w + rx) * 4 + 2];
    }
  }

  function glitch(d, w, h, amount, t) {
    const slot = Math.floor(t * 8);
    const slices = Math.round(amount * 10);
    for (let s = 0; s < slices; s++) {
      const r1 = hash(slot * 13 + s), r2 = hash(slot * 29 + s * 7), r3 = hash(slot * 71 + s * 3);
      if (r3 > .55 + (1 - amount) * .4) continue;
      const y0 = Math.floor(r1 * h), hh = 1 + Math.floor(r2 * h * .12);
      const shift = Math.round((r3 - .5) * w * .35 * amount);
      if (!shift) continue;
      for (let y = y0; y < Math.min(h, y0 + hh); y++) {
        const row = d.slice(y * w * 4, (y + 1) * w * 4);
        for (let x = 0; x < w; x++) {
          const sx = (x - shift + w) % w, p = (y * w + x) * 4, q = sx * 4;
          d[p] = row[q]; d[p + 1] = row[q + 1]; d[p + 2] = row[q + 2];
        }
      }
    }
  }

  function vignette(d, w, h, amount) {
    const cx = w / 2, cy = h / 2, max = Math.hypot(cx, cy);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const f = 1 - amount * (Math.hypot(x - cx, y - cy) / max) ** 2;
      const p = (y * w + x) * 4;
      d[p] *= f; d[p + 1] *= f; d[p + 2] *= f;
    }
  }

  // Barrel warp: resample the frame outward from the centre so straight lines
  // bow like a tube. Done by sampling, so it stays chunky rather than smeared.
  function curve(d, w, h, amount) {
    const copy = d.slice(), cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = (x - cx) / cx, ny = (y - cy) / cy, r2 = nx * nx + ny * ny;
      const k = 1 + amount * r2 * .35;
      const sx = Math.round(cx + nx * cx / k), sy = Math.round(cy + ny * cy / k);
      const p = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) { d[p] = d[p + 1] = d[p + 2] = 0; continue; }
      const q = (sy * w + sx) * 4;
      d[p] = copy[q]; d[p + 1] = copy[q + 1]; d[p + 2] = copy[q + 2];
    }
  }

  function apply(ctx, w, h, fx, env, t) {
    const react = env.level || 0;
    const on = fx.bloom > 0 || fx.chroma > 0 || fx.glitch > 0 || fx.vignette > 0 || fx.curve > 0;
    if (!on) return;
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    if (fx.bloom > 0) bloom(d, w, h, fx.bloom * 1.6, 0.62);
    if (fx.chroma > 0) chroma(d, w, h, Math.round(fx.chroma * 3));
    if (fx.glitch > 0) glitch(d, w, h, Math.min(1, fx.glitch * (0.35 + react * 1.3)), t);
    if (fx.vignette > 0) vignette(d, w, h, fx.vignette * 0.9);
    if (fx.curve > 0) curve(d, w, h, fx.curve);
    ctx.putImageData(img, 0, 0);
  }

  // Text is drawn after the effects so a title stays legible instead of being
  // bloomed or torn, but still before the palette snap so it pixelates properly.
  function drawText(ctx, w, h, o) {
    if (!o.text) return;
    const size = Math.max(4, Math.round(h * o.size));
    ctx.save();
    ctx.font = `${size}px "Press Start 2P", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = o.pos === 'top' ? 'top' : o.pos === 'bottom' ? 'bottom' : 'middle';
    const x = w / 2;
    const y = o.pos === 'top' ? Math.round(h * .08) : o.pos === 'bottom' ? Math.round(h * .92) : Math.round(h / 2);
    const lines = String(o.text).split('|').map(s => s.trim()).slice(0, 3);
    const step = size * 1.5;
    const startY = y - (lines.length - 1) * step / (o.pos === 'middle' ? 2 : 1) * (o.pos === 'bottom' ? 1 : o.pos === 'top' ? 0 : 1);
    lines.forEach((line, i) => {
      const ly = startY + i * step;
      if (o.shadow) { ctx.fillStyle = '#000'; ctx.fillText(line, x + 1, ly + 1); }
      ctx.fillStyle = o.color || '#ffffff';
      ctx.fillText(line, x, ly);
    });
    ctx.restore();
  }

  window.NeoFX = { apply, drawText };
})();
