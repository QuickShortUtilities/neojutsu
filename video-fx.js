/* Post effects for the Video Studio. Everything runs on the low-res buffer
   BEFORE the palette snap, so a glow or a tear gets dithered into the hardware
   palette like any other picture rather than floating on top of it.
   Parameters arrive already resolved by the rack, motion included. */
(() => {
  'use strict';
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  const hash = n => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
  const pct = v => Math.max(0, Math.min(1, v / 100));

  function glow(d, w, h, o) {
    const amount = pct(o.amount); if (!amount) return;
    const threshold = pct(o.threshold), radius = Math.max(1, Math.round(o.radius));
    const warm = o.warmth / 100;
    const n = w * h, bright = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const lum = (d[p] * .299 + d[p + 1] * .587 + d[p + 2] * .114) / 255;
      bright[i] = lum > threshold ? (lum - threshold) / (1 - threshold || 1) : 0;
    }
    const blur = new Float32Array(n), tmp = new Float32Array(n);
    blur.set(bright);
    for (let pass = 0; pass < radius; pass++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        tmp[i] = (blur[i] + blur[x > 0 ? i - 1 : i] + blur[x < w - 1 ? i + 1 : i]) / 3;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        blur[i] = (tmp[i] + tmp[y > 0 ? i - w : i] + tmp[y < h - 1 ? i + w : i]) / 3;
      }
    }
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const b = blur[i] * amount * 255 * 1.6;
      d[p] = clamp(d[p] + b * (1 + warm * .4));
      d[p + 1] = clamp(d[p + 1] + b * .9);
      d[p + 2] = clamp(d[p + 2] + b * (1 - warm * .4));
    }
  }

  function chroma(d, w, h, o) {
    const px = Math.round(pct(o.amount) * 4); if (px < 1) return;
    const a = (o.angle || 0) * Math.PI / 180;
    const ox = Math.round(Math.cos(a) * px), oy = Math.round(Math.sin(a) * px);
    const copy = d.slice();
    const at = (x, y, c) => {
      const cx = Math.max(0, Math.min(w - 1, x)), cy = Math.max(0, Math.min(h - 1, y));
      return copy[(cy * w + cx) * 4 + c];
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      d[p] = at(x - ox, y - oy, 0);
      d[p + 2] = at(x + ox, y + oy, 2);
    }
  }

  function glitch(d, w, h, o, t) {
    const amount = pct(o.amount); if (!amount) return;
    const slot = Math.floor(t * Math.max(1, o.hold));
    const slices = Math.max(1, Math.round(amount * 12));
    const maxH = Math.max(1, Math.round(h * pct(o.height)));
    const tear = pct(o.tear);
    for (let s = 0; s < slices; s++) {
      const r1 = hash(slot * 13 + s), r2 = hash(slot * 29 + s * 7), r3 = hash(slot * 71 + s * 3);
      if (r3 > .35 + amount * .6) continue;
      const y0 = Math.floor(r1 * h), hh = 1 + Math.floor(r2 * maxH);
      const shift = Math.round((r3 - .5) * w * pct(o.shift) * 2);
      if (!shift) continue;
      for (let y = y0; y < Math.min(h, y0 + hh); y++) {
        const row = d.slice(y * w * 4, (y + 1) * w * 4);
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          const sx = (x - shift + w) % w, q = sx * 4;
          // Colour tear drags the channels by different amounts.
          const sr = tear ? ((x - Math.round(shift * (1 + tear)) + w * 2) % w) * 4 : q;
          d[p] = row[sr]; d[p + 1] = row[q + 1]; d[p + 2] = row[q + 2];
        }
      }
    }
  }

  function vignette(d, w, h, o) {
    const amount = pct(o.amount); if (!amount) return;
    const soft = 0.4 + pct(o.softness) * 2.2, square = pct(o.shape);
    const cx = w / 2, cy = h / 2, max = Math.hypot(cx, cy);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = Math.abs(x - cx), ny = Math.abs(y - cy);
      // Blend a round falloff toward a boxy one as Shape rises.
      const round = Math.hypot(nx, ny) / max;
      const box = Math.max(nx / cx, ny / cy);
      const r = round * (1 - square) + box * square;
      const f = 1 - amount * Math.pow(r, soft);
      const p = (y * w + x) * 4;
      d[p] *= f; d[p + 1] *= f; d[p + 2] *= f;
    }
  }

  function curve(d, w, h, o) {
    const amount = pct(o.amount); if (!amount) return;
    const edge = pct(o.edge);
    const copy = d.slice(), cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = (x - cx) / cx, ny = (y - cy) / cy, r2 = nx * nx + ny * ny;
      const k = 1 + amount * r2 * .5;
      const sx = Math.round(cx + nx * cx / k), sy = Math.round(cy + ny * cy / k);
      const p = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) { d[p] = d[p+1] = d[p+2] = 0; continue; }
      const q = (sy * w + sx) * 4, f = 1 - edge * r2 * .6;
      d[p] = copy[q] * f; d[p+1] = copy[q+1] * f; d[p+2] = copy[q+2] * f;
    }
  }

  function move(d, w, h, zoomO, shakeO, t) {
    let zoom = 1, dx = 0, dy = 0, cx = w / 2, cy = h / 2;
    if (zoomO) {
      zoom = 1 + pct(zoomO.amount) * .8;
      cx = w / 2 + (zoomO.cx / 100) * w; cy = h / 2 + (zoomO.cy / 100) * h;
    }
    if (shakeO) {
      const amp = pct(shakeO.amount) * 8, sp = shakeO.speed * .6;
      const ax = Math.round(Math.sin(t * sp) * amp), ay = Math.round(Math.cos(t * sp * 1.31) * amp);
      const axis = Math.round(shakeO.axis);
      dx = axis === 2 ? 0 : ax; dy = axis === 1 ? 0 : ay;
    }
    if (Math.abs(zoom - 1) < .002 && !dx && !dy) return;
    const copy = d.slice(), k = 1 / zoom;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.round(cx + (x - cx) * k - dx), sy = Math.round(cy + (y - cy) * k - dy);
      const p = (y * w + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) { d[p] = d[p+1] = d[p+2] = 0; continue; }
      const q = (sy * w + sx) * 4;
      d[p] = copy[q]; d[p+1] = copy[q+1]; d[p+2] = copy[q+2];
    }
  }

  function mirror(d, w, h, o) {
    const mode = Math.round(o.mode); if (!mode) return;
    const off = Math.round((o.offset / 100) * w);
    const copy = d.slice();
    const get = (x, y, p) => {
      const cx = Math.max(0, Math.min(w - 1, x)), cy = Math.max(0, Math.min(h - 1, y));
      return copy[(cy * w + cx) * 4 + p];
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sx = x, sy = y;
      if (mode === 1 || mode === 3) { const axis = w / 2 + off; if (x > axis) sx = Math.round(2 * axis - x); }
      if (mode === 2 || mode === 3) { const axis = h / 2; if (y > axis) sy = Math.round(2 * axis - y); }
      const p = (y * w + x) * 4;
      d[p] = get(sx, sy, 0); d[p+1] = get(sx, sy, 1); d[p+2] = get(sx, sy, 2);
    }
  }

  // Frame feedback needs the previous frame, so the module keeps one.
  let prev = null, prevW = 0, prevH = 0;
  function trails(d, w, h, o) {
    const amount = pct(o.amount);
    if (prevW !== w || prevH !== h) { prev = null; prevW = w; prevH = h; }
    if (amount > 0 && prev) {
      const keep = amount * (1 - pct(o.decay) * .8);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.max(d[i], prev[i] * keep);
        d[i+1] = Math.max(d[i+1], prev[i+1] * keep);
        d[i+2] = Math.max(d[i+2], prev[i+2] * keep);
      }
    }
    prev = d.slice();
  }
  const resetTrails = () => { prev = null; };

  function apply(ctx, w, h, fx, env, t) {
    if (!fx) return;
    const any = Object.values(fx).some(Boolean);
    if (!any) { resetTrails(); return; }
    const img = ctx.getImageData(0, 0, w, h), d = img.data;
    if (fx.mirror) mirror(d, w, h, fx.mirror);
    if (fx.zoom || fx.shake) move(d, w, h, fx.zoom, fx.shake, t);
    if (fx.curve) curve(d, w, h, fx.curve);
    if (fx.trails) trails(d, w, h, fx.trails); else resetTrails();
    if (fx.glow) glow(d, w, h, fx.glow);
    if (fx.chroma) chroma(d, w, h, fx.chroma);
    if (fx.glitch) glitch(d, w, h, fx.glitch, t);
    if (fx.vignette) vignette(d, w, h, fx.vignette);
    ctx.putImageData(img, 0, 0);
  }

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

  window.NeoFX = { apply, drawText, resetTrails };
})();
