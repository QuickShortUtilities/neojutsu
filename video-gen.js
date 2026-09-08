/* Procedural footage for the Video Studio. Scenes draw in colour at hardware
   resolution; the studio's palette snap and dither run over the top, so a
   generated shot and imported footage come out of the same machine.
   Seeding matches the Audio Studio, so a seed is a seed everywhere. */
(() => {
  'use strict';

  function rng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const randomSeed = () => Math.random().toString(36).slice(2, 8);
  const lerp = (a, b, t) => a + (b - a) * t;

  // Every scene gets the same envelope: overall level plus three bands, each
  // 0..1, so reactivity reads the music rather than guessing at it.
  const SCENES = {
    starfield: {
      label: 'Starfield · warp',
      init(r, w, h, density) {
        const n = Math.round(lerp(40, 400, density));
        return { r, stars: Array.from({ length: n }, () => ({ x: r() * 2 - 1, y: r() * 2 - 1, z: r(), c: r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2, warp = o.speed * (0.35 + env.level * 1.8);
        for (const st of s.stars) {
          st.z -= warp * o.step * 0.5; if (st.z <= 0.02) { st.z = 1; st.x = s.r() * 2 - 1; st.y = s.r() * 2 - 1; }
          const k = 0.5 / st.z, x = cx + st.x * k * cx, y = cy + st.y * k * cy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const b = Math.min(1, (1 - st.z) * 1.4), sz = b > .8 ? 2 : 1;
          g.fillStyle = st.c > .75 ? `rgba(46,242,255,${b})` : st.c > .5 ? `rgba(255,46,136,${b})` : `rgba(255,255,255,${b})`;
          g.fillRect(x | 0, y | 0, sz, sz);
        }
      },
    },

    skyline: {
      label: 'Skyline · parallax city',
      init(r, w, h, density) {
        const layers = [];
        for (let l = 0; l < 3; l++) {
          const n = Math.round(lerp(8, 30, density)) + l * 4, blocks = [];
          for (let i = 0; i < n; i++) blocks.push({ w: 5 + r() * (10 + l * 8), h: 0.10 + r() * (0.16 + l * 0.10), lit: r() });
          layers.push({ blocks, off: r() * 200 });
        }
        return { layers, stars: Array.from({ length: 46 }, () => ({ x: r(), y: r() * 0.34 })) };
      },
      draw(g, w, h, t, env, s, o) {
        // The bright band sits where the rooflines are, so the silhouette still
        // reads after the palette snap. Dark-on-dark collapses to one tone.
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#0a0420'); sky.addColorStop(.32, '#5a1050');
        sky.addColorStop(.52, '#ff2e88'); sky.addColorStop(.70, '#ffd23f'); sky.addColorStop(1, '#ffd23f');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        g.fillStyle = '#ffffff';
        for (const st of s.stars) g.fillRect((st.x * w) | 0, (st.y * h) | 0, 1, 1);
        const moonR = 8 + env.bass * 9;
        g.fillStyle = '#fffbe6'; g.beginPath(); g.arc(w * 0.74, h * 0.2, moonR, 0, 7); g.fill();

        const bases = [0.66, 0.78, 0.9], shades = ['#2a1b45', '#150c28', '#04020c'];
        for (let l = 0; l < s.layers.length; l++) {
          const L = s.layers[l], near = l === s.layers.length - 1;
          L.off += o.speed * (0.2 + l * 0.35) * (1 + env.level) * o.step * 55;
          const base = h * bases[l], span = L.blocks.reduce((a, b) => a + b.w + 3, 0);
          let x = -(L.off % span);
          g.fillStyle = shades[l];
          for (let pass = 0; pass < 2 && x < w; pass++) {
            for (const b of L.blocks) {
              const bh = b.h * h * (1 + (near ? env.mid * 0.3 : 0));
              g.fillStyle = shades[l];
              g.fillRect(x | 0, (base - bh) | 0, Math.max(2, b.w | 0), (bh + h) | 0);
              if (near && b.lit > 0.45) {
                g.fillStyle = env.treble > 0.3 ? '#2ef2ff' : '#ffd23f';
                for (let wy = base - bh + 3; wy < h - 2; wy += 5)
                  for (let wx = x + 2; wx < x + b.w - 2; wx += 4)
                    if ((((wx | 0) + (wy | 0)) % 3)) g.fillRect(wx | 0, wy | 0, 1, 2);
              }
              x += b.w + 3;
              if (x > w) break;
            }
          }
        }
      },
    },

    grid: {
      label: 'Grid · outrun horizon',
      init(r, w, h) { return { z: 0, hue: r() }; },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h * 0.55);
        sky.addColorStop(0, '#12002a'); sky.addColorStop(1, '#ff2e88');
        g.fillStyle = sky; g.fillRect(0, 0, w, h * 0.55);
        g.fillStyle = '#07030f'; g.fillRect(0, h * 0.55, w, h * 0.45);
        const sunR = h * 0.16 + env.bass * h * 0.05;
        g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(w / 2, h * 0.5, sunR, 0, 7); g.fill();
        g.fillStyle = '#07030f';
        for (let i = 0; i < 6; i++) g.fillRect(0, h * 0.42 + i * (sunR / 3.4), w, Math.max(1, sunR / 12));

        s.z = (s.z + o.speed * (0.4 + env.level * 1.2) * o.step * 1.8) % 1;
        const hz = h * 0.55;
        g.strokeStyle = '#2ef2ff'; g.lineWidth = 1;
        for (let i = 0; i < 16; i++) {
          const f = ((i + s.z) / 16) ** 2.2, y = hz + f * (h - hz);
          g.globalAlpha = 0.25 + 0.75 * f;
          g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
        }
        for (let i = -10; i <= 10; i++) {
          g.globalAlpha = 0.5;
          g.beginPath(); g.moveTo(w / 2 + i * 3, hz); g.lineTo(w / 2 + i * (w / 6), h); g.stroke();
        }
        g.globalAlpha = 1;
      },
    },

    scope: {
      label: 'Scope · waveform',
      init(r, w, h) { return { phase: r() * 6.28 }; },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        g.strokeStyle = '#1b1430'; g.lineWidth = 1;
        for (let x = 0; x < w; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
        for (let y = 0; y < h; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
        const wave = env.wave, mid = h / 2, amp = h * 0.42;
        g.strokeStyle = '#2ef2ff'; g.lineWidth = 2; g.beginPath();
        for (let x = 0; x < w; x++) {
          const v = wave.length ? wave[Math.floor((x / w) * wave.length)] : Math.sin(x * 0.12 + t * 3 + s.phase) * 0.4;
          const y = mid + v * amp;
          x ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
        g.strokeStyle = 'rgba(255,46,136,.6)'; g.lineWidth = 1; g.beginPath();
        for (let x = 0; x < w; x++) {
          const v = wave.length ? wave[Math.floor((x / w) * wave.length)] : Math.sin(x * 0.12 + t * 3) * 0.4;
          const y = mid - v * amp * 0.6;
          x ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      },
    },

    bars: {
      label: 'Bars · spectrum',
      init(r, w, h, density) { return { n: Math.round(lerp(8, 40, density)) }; },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        const n = s.n, bw = w / n, f = env.freq;
        for (let i = 0; i < n; i++) {
          const v = f.length ? f[Math.floor((i / n) * f.length * 0.7)] / 255 : Math.abs(Math.sin(t * 2 + i));
          const bh = Math.max(1, v * h * 0.9);
          const grd = g.createLinearGradient(0, h - bh, 0, h);
          grd.addColorStop(0, '#2ef2ff'); grd.addColorStop(1, '#ff2e88');
          g.fillStyle = grd;
          g.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
          g.fillStyle = '#ffd23f';
          g.fillRect(i * bw + 1, h - bh - 2, Math.max(1, bw - 2), 2);
        }
      },
    },

    tunnel: {
      label: 'Tunnel · rings',
      init(r, w, h) { return { z: 0, spin: r() * 6.28 }; },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        s.z += o.speed * (0.4 + env.bass * 1.6) * o.step * 1.2;
        s.spin += o.speed * o.step * 0.24;
        const cx = w / 2 + Math.sin(t * 0.6) * w * 0.06, cy = h / 2 + Math.cos(t * 0.5) * h * 0.06;
        for (let i = 12; i >= 1; i--) {
          const f = ((i + (s.z % 1)) / 12) ** 2, r = f * Math.max(w, h) * 0.8;
          g.strokeStyle = i % 2 ? `rgba(46,242,255,${0.15 + 0.6 * (1 - f)})` : `rgba(255,46,136,${0.15 + 0.6 * (1 - f)})`;
          g.lineWidth = Math.max(1, 3 * (1 - f) + env.treble * 2);
          g.beginPath();
          for (let a = 0; a <= 6.29; a += 0.35) {
            const rr = r * (1 + Math.sin(a * 6 + s.spin) * 0.06);
            const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
            a ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.closePath(); g.stroke();
        }
      },
    },

    plasma: {
      label: 'Plasma · field',
      init(r, w, h) { return { a: r() * 10, b: r() * 10 }; },
      draw(g, w, h, t, env, s, o) {
        const img = g.getImageData(0, 0, w, h), d = img.data;
        const k = 0.06 + env.level * 0.05, tt = t * o.speed;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const v = Math.sin(x * k + tt + s.a) + Math.sin(y * k * 1.3 - tt * 0.8 + s.b)
                    + Math.sin((x + y) * k * 0.7 + tt * 1.2);
            const n = (v + 3) / 6, i = (y * w + x) * 4;
            d[i] = 40 + n * 215; d[i + 1] = 20 + (1 - n) * 180; d[i + 2] = 90 + Math.sin(n * 6.28) * 120; d[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
      },
    },

    rain: {
      label: 'Rain · code fall',
      init(r, w, h, density) {
        const n = Math.round(lerp(10, 70, density));
        return { r, drops: Array.from({ length: n }, () => ({ x: r(), y: r(), v: 0.3 + r() * 1.2, len: 3 + Math.floor(r() * 9) })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = 'rgba(5,4,10,.35)'; g.fillRect(0, 0, w, h);
        for (const d of s.drops) {
          d.y += d.v * o.speed * (0.4 + env.level * 1.4) * o.step * 0.6;
          if (d.y > 1.2) { d.y = -0.2; d.x = s.r(); }
          const x = (d.x * w) | 0, y = (d.y * h) | 0;
          for (let i = 0; i < d.len; i++) {
            const a = 1 - i / d.len;
            g.fillStyle = i === 0 ? '#eafff4' : `rgba(46,242,255,${a * 0.9})`;
            g.fillRect(x, y - i * 3, 1, 2);
          }
        }
      },
    },

    radial: {
      label: 'Radial · spokes',
      // Carried over from the Tranquilicy player, but driven by the real
      // spectrum instead of a rolling sine, and seeded so it reproduces.
      init(r, w, h, density) {
        const n = Math.round(lerp(24, 96, density));
        return { n, seeds: Array.from({ length: n }, () => r() * 6.28), spin: r() * 6.28 };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
        s.spin += o.speed * o.step * 0.35;
        const inner = R * 0.4, f = env.freq;
        for (let i = 0; i < s.n; i++) {
          const angle = (i / s.n) * 6.283 - 1.5708 + s.spin;
          const amp = f.length
            ? f[Math.floor((i / s.n) * f.length * 0.6)] / 255
            : (Math.sin(t * 1.4 + s.seeds[i]) * 0.4 + 0.5);
          const len = 3 + amp * R * 0.55;
          const x1 = cx + Math.cos(angle) * inner, y1 = cy + Math.sin(angle) * inner;
          const x2 = cx + Math.cos(angle) * (inner + len), y2 = cy + Math.sin(angle) * (inner + len);
          g.strokeStyle = amp > .66 ? '#ffd23f' : amp > .33 ? '#2ef2ff' : '#ff2e88';
          g.lineWidth = Math.max(1, w / s.n * 0.6);
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        }
        g.fillStyle = '#ff2e88';
        g.beginPath(); g.arc(cx, cy, inner * (0.5 + env.bass * 0.4), 0, 7); g.fill();
      },
    },

    motes: {
      label: 'Motes · drifting light',
      init(r, w, h, density) {
        const n = Math.round(lerp(24, 140, density));
        const make = init => ({
          x: r() * w, y: init ? r() * h : h + 4,
          vx: (r() - .5) * 6, vy: -(4 + r() * 14),
          rad: .5 + r() * 2, life: init ? r() : 0, span: 3 + r() * 5,
        });
        return { r, w, h, motes: Array.from({ length: n }, () => make(true)), make };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        const lift = 1 + env.level * 2.2;
        for (const m of s.motes) {
          m.x += m.vx * o.step * o.speed; m.y += m.vy * o.step * o.speed * lift;
          m.life += o.step / m.span;
          if (m.life >= 1 || m.y < -4) {
            m.life = 0; m.y = h + 4; m.x = s.r() * w;
            m.vx = (s.r() - .5) * 6; m.vy = -(4 + s.r() * 14);
          }
          const a = m.life < .2 ? m.life / .2 : m.life > .8 ? (1 - m.life) / .2 : 1;
          const rr = Math.max(1, m.rad * (1 + env.treble));
          g.fillStyle = `rgba(255,210,63,${a})`;
          g.fillRect((m.x - rr / 2) | 0, (m.y - rr / 2) | 0, rr | 0 || 1, rr | 0 || 1);
        }
      },
    },

    kaleido: {
      label: 'Kaleido · mirror',
      init(r, w, h, density) {
        const n = Math.round(lerp(3, 12, density));
        return { wedges: n < 3 ? 3 : n, spin: r() * 6.28,
                 shapes: Array.from({ length: 7 }, () => ({ d: .1 + r() * .8, a: r() * 1.2, s: .04 + r() * .14, c: r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        s.spin += o.speed * o.step * 0.5;
        const cx = w / 2, cy = h / 2, R = Math.max(w, h) * .7;
        const cols = ['#ff2e88', '#2ef2ff', '#ffd23f', '#8b5cf6'];
        for (let k = 0; k < s.wedges; k++) {
          g.save(); g.translate(cx, cy); g.rotate(s.spin + (k / s.wedges) * 6.283);
          if (k % 2) g.scale(1, -1);
          for (const sh of s.shapes) {
            const d = sh.d * R * (0.7 + env.level * 0.5);
            const x = Math.cos(sh.a + t * 0.4) * d, y = Math.sin(sh.a * 1.7 + t * 0.3) * d;
            const size = Math.max(1, sh.s * R * (0.6 + env.mid));
            g.fillStyle = cols[Math.floor(sh.c * cols.length) % cols.length];
            g.fillRect(x - size / 2, y - size / 2, size, size);
          }
          g.restore();
        }
      },
    },

    fire: {
      label: 'Fire · demoscene',
      // The classic heat-buffer fire: seed the bottom row, average upward.
      init(r, w, h) { return { r, heat: new Uint8Array(w * h), w, h, acc: 0 }; },
      draw(g, w, h, t, env, s, o) {
        if (s.w !== w || s.h !== h) { s.heat = new Uint8Array(w * h); s.w = w; s.h = h; }
        const heat = s.heat, bottom = (h - 1) * w;
        const hot = 150 + env.level * 105;
        for (let x = 0; x < w; x++) heat[bottom + x] = s.r() * hot + (env.bass * 100);
        for (let y = 0; y < h - 1; y++) {
          for (let x = 0; x < w; x++) {
            const below = (y + 1) * w + x;
            const v = (heat[below] + heat[below - 1 < 0 ? below : below - 1] + heat[below + 1] + heat[Math.min(heat.length - 1, below + w)]) / 4.015;
            heat[y * w + x] = v < 0 ? 0 : v;
          }
        }
        const img = g.getImageData(0, 0, w, h), d = img.data;
        for (let i = 0, p = 0; i < heat.length; i++, p += 4) {
          const v = heat[i];
          d[p] = Math.min(255, v * 2.2); d[p + 1] = Math.min(255, v * 1.1); d[p + 2] = v * 0.35; d[p + 3] = 255;
        }
        g.putImageData(img, 0, 0);
      },
    },

    waves: {
      label: 'Waves · ribbons',
      init(r, w, h, density) {
        const n = Math.round(lerp(3, 14, density));
        return { lines: Array.from({ length: n }, (_, i) => ({ off: r() * 6.28, k: .04 + r() * .09, amp: .05 + r() * .12 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#0a0420'); sky.addColorStop(1, '#2a0f3a');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        const cols = ['#ff2e88', '#2ef2ff', '#ffd23f', '#8b5cf6'];
        s.lines.forEach((L, i) => {
          const mid = h * (i + 1) / (s.lines.length + 1);
          const amp = L.amp * h * (1 + env.level * 1.6);
          g.strokeStyle = cols[i % cols.length]; g.lineWidth = Math.max(1, 2 + env.bass * 2);
          g.beginPath();
          for (let x = 0; x <= w; x++) {
            const y = mid + Math.sin(x * L.k + t * o.speed * 1.6 + L.off) * amp
                          + Math.sin(x * L.k * 0.37 - t * o.speed) * amp * 0.4;
            x ? g.lineTo(x, y) : g.moveTo(x, y);
          }
          g.stroke();
        });
      },
    },
  };

  window.NeoScene = { SCENES, rng, randomSeed };
})();
