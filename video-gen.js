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
  const CATS = {
    abstract: { label: 'Abstract', kanji: '抽' },
    scifi:    { label: 'Sci-fi', kanji: '宙' },
    cyber:    { label: 'Cyberpunk', kanji: '電' },
    rpg:      { label: 'RPG', kanji: '冒' },
    racing:   { label: 'Racing', kanji: '走' },
    monster:  { label: 'Monster', kanji: '獣' },
    platform: { label: 'Platformer', kanji: '跳' },
    shooter:  { label: 'Shooter', kanji: '撃' },
    strategy: { label: 'Strategy', kanji: '陣' },
    puzzle:   { label: 'Puzzle', kanji: '謎' },
    people:   { label: 'Characters', kanji: '人' },
  };

  const SCENES = {
    starfield: {
      label: 'Starfield · warp', cat: 'scifi',
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
      label: 'Skyline · parallax city', cat: 'cyber',
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
      label: 'Grid · outrun horizon', cat: 'racing',
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
      label: 'Scope · waveform', cat: 'abstract',
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
      label: 'Bars · spectrum', cat: 'abstract',
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
      label: 'Tunnel · rings', cat: 'abstract',
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
      label: 'Plasma · field', cat: 'abstract',
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
      label: 'Rain · code fall', cat: 'cyber',
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
      label: 'Radial · spokes', cat: 'abstract',
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
      label: 'Motes · drifting light', cat: 'abstract',
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
      label: 'Kaleido · mirror', cat: 'abstract',
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
      label: 'Fire · demoscene', cat: 'abstract',
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
      label: 'Waves · ribbons', cat: 'abstract',
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

    // ---------------- RPG ----------------
    village: {
      label: 'Village · rooftops', cat: 'rpg',
      init(r, w, h, density) {
        const n = Math.round(lerp(5, 16, density));
        return { r, off: 0,
          huts: Array.from({ length: n }, () => ({ w: 14 + r() * 20, h: .12 + r() * .14, lit: r(), roof: r() })),
          trees: Array.from({ length: n }, () => ({ x: r(), s: .5 + r() * .7 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#1a1040'); sky.addColorStop(.55, '#c94f7c'); sky.addColorStop(1, '#ffd23f');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff6d8'; g.beginPath(); g.arc(w * .2, h * .3, 9 + env.bass * 6, 0, 7); g.fill();
        s.off += o.speed * o.step * 16 * (1 + env.level * .6);
        const base = h * .78;
        g.fillStyle = '#2c1f14';
        g.fillRect(0, base, w, h - base);
        const span = s.huts.reduce((a, b) => a + b.w + 8, 0);
        let x = -(s.off % span);
        for (let pass = 0; pass < 2 && x < w; pass++) {
          for (const hut of s.huts) {
            const hh = hut.h * h, y = base - hh;
            g.fillStyle = '#1b120c';
            g.fillRect(x | 0, y | 0, hut.w | 0, hh | 0);
            // thatched roof: a stepped triangle keeps it chunky at this size
            g.fillStyle = hut.roof > .5 ? '#8a4a2a' : '#6b3a20';
            const steps = 5, sw = hut.w / 2 / steps;
            for (let i = 0; i < steps; i++)
              g.fillRect((x + i * sw) | 0, (y - (steps - i) * 3) | 0, (hut.w - i * sw * 2) | 0, 4);
            if (hut.lit > .45) {
              g.fillStyle = env.treble > .3 ? '#fff2a8' : '#ffd23f';
              g.fillRect((x + hut.w * .35) | 0, (y + hh * .4) | 0, 3, 3);
            }
            x += hut.w + 8;
            if (x > w) break;
          }
        }
        for (const tr of s.trees) {
          const tx = ((tr.x * w - s.off * .5) % (w + 20) + w + 20) % (w + 20) - 10;
          const th = 14 * tr.s;
          g.fillStyle = '#150e08'; g.fillRect(tx | 0, (base - th) | 0, 2, th);
          g.fillStyle = '#22331a';
          g.beginPath(); g.arc(tx + 1, base - th, 6 * tr.s, 0, 7); g.fill();
        }
      },
    },

    overworld: {
      label: 'Overworld · map', cat: 'rpg',
      init(r, w, h, density) {
        const N = 48, tiles = new Uint8Array(N * N);
        // Seeded clumps rather than pure noise, so terrain reads as regions.
        for (let i = 0; i < N * N; i++) tiles[i] = r() < .3 ? 0 : r() < .5 ? 1 : 2;
        for (let pass = 0; pass < 2; pass++)
          for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
            const c = {}; let best = tiles[y * N + x], bn = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const v = tiles[(y + dy) * N + (x + dx)];
              c[v] = (c[v] || 0) + 1; if (c[v] > bn) { bn = c[v]; best = v; }
            }
            tiles[y * N + x] = best;
          }
        return { r, N, tiles, ox: 0, oy: 0, party: 0 };
      },
      draw(g, w, h, t, env, s, o) {
        const TS = 8, N = s.N;
        s.ox += o.speed * o.step * 9 * (1 + env.level);
        s.oy += o.speed * o.step * 5;
        const cols = ['#2b6cff', '#2e6b28', '#7aa63c'];
        for (let y = -1; y <= h / TS + 1; y++) {
          for (let x = -1; x <= w / TS + 1; x++) {
            const tx = ((x + Math.floor(s.ox / TS)) % N + N) % N;
            const ty = ((y + Math.floor(s.oy / TS)) % N + N) % N;
            const v = s.tiles[ty * N + tx];
            g.fillStyle = cols[v];
            g.fillRect(x * TS - (s.ox % TS), y * TS - (s.oy % TS), TS, TS);
            if (v === 1 && ((tx + ty) % 3 === 0)) {
              g.fillStyle = '#16401a';
              g.fillRect(x * TS - (s.ox % TS) + 2, y * TS - (s.oy % TS) + 1, 4, 6);
            }
          }
        }
        // the party marker, bobbing on the beat
        s.party += o.step * 6;
        const bob = Math.sin(s.party) > 0 ? 0 : 1;
        const px = (w / 2) | 0, py = (h / 2) | 0;
        g.fillStyle = '#000'; g.fillRect(px - 3, py - 4 + bob, 6, 8);
        g.fillStyle = '#ffd23f'; g.fillRect(px - 2, py - 3 + bob, 4, 3);
        g.fillStyle = '#ff2e88'; g.fillRect(px - 2, py + bob, 4, 4);
      },
    },

    dungeon: {
      label: 'Dungeon · corridor', cat: 'rpg',
      init(r, w, h) { return { r, z: 0, flick: 0 }; },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#070509'; g.fillRect(0, 0, w, h);
        s.z += o.speed * o.step * .45 * (1 + env.level);
        const cx = w / 2, cy = h / 2;
        for (let i = 9; i >= 1; i--) {
          const f = ((i + (s.z % 1)) / 9) ** 2.1;
          const aw = w * .16 + f * w * .9, ah = h * .16 + f * h * .9;
          const shade = Math.round(18 + (1 - f) * 90);
          g.strokeStyle = `rgb(${shade},${Math.round(shade * .86)},${Math.round(shade * .6)})`;
          g.lineWidth = Math.max(1, 3 * (1 - f));
          g.strokeRect(cx - aw / 2, cy - ah / 2, aw, ah);
          // bricks along the arch
          if (i % 2) {
            g.fillStyle = `rgba(${shade},${shade},${shade},.35)`;
            for (let bx = cx - aw / 2; bx < cx + aw / 2; bx += 9) g.fillRect(bx, cy - ah / 2, 4, 2);
          }
        }
        s.flick += o.step * (6 + env.treble * 20);
        const fl = .6 + Math.sin(s.flick) * .2 + Math.sin(s.flick * 2.7) * .2;
        for (const tx of [w * .2, w * .8]) {
          g.fillStyle = `rgba(255,170,40,${fl})`;
          g.beginPath(); g.arc(tx, h * .42, 3 + fl * 3 + env.bass * 3, 0, 7); g.fill();
          g.fillStyle = 'rgba(255,120,20,.25)';
          g.beginPath(); g.arc(tx, h * .42, 10 + fl * 8, 0, 7); g.fill();
        }
      },
    },

    // ---------------- RACING ----------------
    road: {
      label: 'Road · chase', cat: 'racing',
      init(r, w, h, density) {
        return { r, z: 0, curve: 0, phase: r() * 6.28,
                 posts: Math.round(lerp(6, 18, density)) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h * .5);
        sky.addColorStop(0, '#0d1b45'); sky.addColorStop(1, '#ff8c42');
        g.fillStyle = sky; g.fillRect(0, 0, w, h * .5);
        g.fillStyle = '#1d3a1a'; g.fillRect(0, h * .5, w, h * .5);
        s.z += o.speed * o.step * (1.6 + env.level * 2.2);
        s.curve = Math.sin(t * .35 + s.phase) * .5;
        const hz = h * .5, road = (y) => {
          const f = (y - hz) / (h - hz);
          const wid = w * (.06 + f * .78);
          const cx = w / 2 + s.curve * w * .4 * f * f;
          return { wid, cx, f };
        };
        for (let y = hz; y < h; y++) {
          const { wid, cx, f } = road(y);
          g.fillStyle = '#2a2a2e';
          g.fillRect(cx - wid / 2, y, wid, 1);
          const stripe = ((f * 9 + s.z) % 1) < .5;
          g.fillStyle = stripe ? '#e8e4d8' : '#2a2a2e';
          g.fillRect(cx - Math.max(1, wid * .015), y, Math.max(1, wid * .03), 1);
          g.fillStyle = (((f * 6 + s.z) % 1) < .5) ? '#ff2e88' : '#e8e4d8';
          g.fillRect(cx - wid / 2 - 2, y, 2, 1);
          g.fillRect(cx + wid / 2, y, 2, 1);
        }
        for (let i = 0; i < s.posts; i++) {
          const f = ((i / s.posts) + (s.z * .2 % 1)) % 1;
          const y = hz + f * f * (h - hz);
          const { wid, cx } = road(y);
          const ph = 3 + f * 16;
          g.fillStyle = '#0d0d10';
          g.fillRect(cx + wid / 2 + 3, y - ph, Math.max(1, f * 3), ph);
          g.fillRect(cx - wid / 2 - 3 - Math.max(1, f * 3), y - ph, Math.max(1, f * 3), ph);
        }
      },
    },

    // ---------------- SCI-FI ----------------
    planet: {
      label: 'Planet · rise', cat: 'scifi',
      init(r, w, h, density) {
        return { r, spin: 0,
          stars: Array.from({ length: Math.round(lerp(30, 140, density)) }, () => ({ x: r(), y: r(), b: r() })),
          bands: Array.from({ length: 7 }, () => ({ y: r(), t: .04 + r() * .12 })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#05040f'; g.fillRect(0, 0, w, h);
        for (const st of s.stars) {
          const tw = .5 + Math.sin(t * 2 + st.b * 9) * .5;
          g.fillStyle = `rgba(255,255,255,${.25 + tw * .75 * (env.treble + .5)})`;
          g.fillRect((st.x * w) | 0, (st.y * h * .8) | 0, 1, 1);
        }
        s.spin += o.speed * o.step * .12;
        const R = Math.min(w, h) * (.62 + env.bass * .06), cx = w / 2, cy = h * 1.05;
        g.save();
        g.beginPath(); g.arc(cx, cy, R, 0, 7); g.clip();
        g.fillStyle = '#2b4a8f'; g.fillRect(cx - R, cy - R, R * 2, R * 2);
        for (const b of s.bands) {
          const y = cy - R + (((b.y + s.spin) % 1) * R * 2);
          g.fillStyle = 'rgba(120,180,220,.35)';
          g.fillRect(cx - R, y, R * 2, b.t * R);
        }
        // terminator: the unlit limb
        const shade = g.createLinearGradient(cx - R, 0, cx + R, 0);
        shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(.55, 'rgba(0,0,0,.2)'); shade.addColorStop(1, 'rgba(0,0,0,.85)');
        g.fillStyle = shade; g.fillRect(cx - R, cy - R, R * 2, R * 2);
        g.restore();
        g.strokeStyle = 'rgba(180,220,255,.6)'; g.lineWidth = 1;
        g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
      },
    },

    corridor: {
      label: 'Corridor · ship', cat: 'scifi',
      init(r, w, h) { return { r, z: 0 }; },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#04060a'; g.fillRect(0, 0, w, h);
        s.z += o.speed * o.step * .55 * (1 + env.level * 1.4);
        const cx = w / 2, cy = h / 2;
        for (let i = 10; i >= 1; i--) {
          const f = ((i + (s.z % 1)) / 10) ** 2;
          const aw = w * .12 + f * w * .95, ah = h * .12 + f * h * .95;
          const lit = 20 + (1 - f) * 120;
          g.strokeStyle = `rgb(${Math.round(lit * .4)},${Math.round(lit * .8)},${Math.round(lit)})`;
          g.lineWidth = Math.max(1, 2.5 * (1 - f));
          g.strokeRect(cx - aw / 2, cy - ah / 2, aw, ah);
          if (i % 3 === 0) {
            g.fillStyle = `rgba(46,242,255,${.15 + (1 - f) * .5 + env.treble * .3})`;
            g.fillRect(cx - aw / 2, cy - ah / 2, aw, Math.max(1, 2 * (1 - f)));
          }
        }
        g.strokeStyle = 'rgba(90,140,180,.35)'; g.lineWidth = 1;
        for (const [dx, dy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
          g.beginPath(); g.moveTo(cx + dx * w * .06, cy + dy * h * .06);
          g.lineTo(cx + dx * w * .6, cy + dy * h * .6); g.stroke();
        }
      },
    },

    // ---------------- MONSTER ----------------
    kaiju: {
      label: 'Kaiju · city stomp', cat: 'monster',
      init(r, w, h, density) {
        const n = Math.round(lerp(8, 22, density));
        return { r, off: 0, step: 0,
          blocks: Array.from({ length: n }, () => ({ w: 8 + r() * 18, h: .12 + r() * .3, lit: r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        // Bright band sits behind the beast's torso; a dark shape on a dark sky
        // collapses to one tone once the palette snaps.
        sky.addColorStop(0, '#12021c'); sky.addColorStop(.3, '#a3204e');
        sky.addColorStop(.55, '#ff5b2e'); sky.addColorStop(1, '#ffd23f');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        s.off += o.speed * o.step * 10 * (1 + env.level);
        const base = h * .88;
        const span = s.blocks.reduce((a, b) => a + b.w + 4, 0);
        let x = -(s.off % span);
        for (let pass = 0; pass < 2 && x < w; pass++) {
          for (const b of s.blocks) {
            const bh = b.h * h;
            g.fillStyle = '#0a0410';
            g.fillRect(x | 0, (base - bh) | 0, b.w | 0, bh + 4);
            if (b.lit > .5) {
              g.fillStyle = '#ffd23f';
              for (let wy = base - bh + 3; wy < base - 2; wy += 5)
                for (let wx = x + 2; wx < x + b.w - 2; wx += 4)
                  if ((wx + wy) % 3) g.fillRect(wx | 0, wy | 0, 1, 2);
              g.fillStyle = '#0a0410';
            }
            x += b.w + 4;
            if (x > w) break;
          }
        }
        // the beast: a stepping silhouette, taller than anything behind it
        s.step += o.step * (1.6 + env.bass * 3);
        const sway = Math.sin(s.step) * 3, lift = Math.abs(Math.sin(s.step * .5)) * 3;
        const bx = w * .62 + sway, by = base - lift, bw = w * .17, bh2 = h * .52;
        // Drawn twice: a rim one pixel proud, then the body inside it, so the
        // silhouette still reads where it crosses a bright sky.
        const beast = (grow, fill) => {
          g.fillStyle = fill;
          g.fillRect(bx - bw / 2 - grow, by - bh2 - grow, bw + grow * 2, bh2 + grow * 2);
          g.fillRect(bx - bw * .9 - grow, by - bh2 * .78 - grow, bw * .45 + grow * 2, bh2 * .30 + grow * 2);
          g.fillRect(bx + bw * .45 - grow, by - bh2 * .72 - grow, bw * .45 + grow * 2, bh2 * .26 + grow * 2);
          g.fillRect(bx - bw * .42 - grow, by - 2, bw * .34 + grow * 2, lift + 3 + grow);
          g.fillRect(bx + bw * .08 - grow, by - 2, bw * .34 + grow * 2, 3 + grow);
          for (let i = 0; i < 5; i++)
            g.fillRect(bx - 1 - grow, by - bh2 - 3 - i * 5 - grow, 3 + grow * 2, 4 + grow * 2);
        };
        beast(2, '#ffd9a0');
        beast(0, '#050208');
        const eye = env.treble > .25 ? '#fff' : '#ff2e88';
        g.fillStyle = eye;
        g.fillRect(bx - bw * .28, by - bh2 * .96, 3, 2);
        g.fillRect(bx + bw * .12, by - bh2 * .96, 3, 2);
      },
    },

    eyes: {
      label: 'Eyes · in the dark', cat: 'monster',
      init(r, w, h, density) {
        const n = Math.round(lerp(3, 14, density));
        return { r, pairs: Array.from({ length: n }, () => ({
          x: r(), y: .2 + r() * .7, z: .3 + r() * .7, blink: r() * 6, gap: .5 + r() * .8 })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#04030a'; g.fillRect(0, 0, w, h);
        for (const p of s.pairs) {
          p.z += o.speed * o.step * .05 * (1 + env.level);
          if (p.z > 1.4) { p.z = .25; p.x = s.r(); p.y = .2 + s.r() * .7; }
          const open = Math.sin(t * 1.7 + p.blink) > -.75 ? 1 : 0;
          if (!open) continue;
          const sz = Math.max(1, p.z * 5), gap = p.z * 12 * p.gap;
          const x = p.x * w, y = p.y * h;
          const glow = .35 + p.z * .5 + env.bass * .3;
          g.fillStyle = `rgba(255,46,136,${glow * .25})`;
          g.beginPath(); g.arc(x - gap / 2, y, sz * 2.6, 0, 7); g.fill();
          g.beginPath(); g.arc(x + gap / 2, y, sz * 2.6, 0, 7); g.fill();
          g.fillStyle = `rgba(255,220,120,${Math.min(1, glow + .3)})`;
          g.fillRect((x - gap / 2 - sz / 2) | 0, (y - sz / 2) | 0, sz | 0 || 1, sz | 0 || 1);
          g.fillRect((x + gap / 2 - sz / 2) | 0, (y - sz / 2) | 0, sz | 0 || 1, sz | 0 || 1);
        }
      },
    },

    // ---------------- PLATFORMER ----------------
    hills: {
      label: 'Hills · side-scroll', cat: 'platform',
      init(r, w, h, density) {
        const n = Math.round(lerp(3, 10, density));
        return { r, off: 0,
          clouds: Array.from({ length: 6 }, () => ({ x: r(), y: .08 + r() * .3, s: .6 + r() * .9 })),
          plats: Array.from({ length: n }, () => ({ x: r() * 3, y: .3 + r() * .35, w: 16 + r() * 26 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#3aa6ff'); sky.addColorStop(1, '#bfe9ff');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        s.off += o.speed * o.step * 26 * (1 + env.level * .8);
        for (const c of s.clouds) {
          const cx = ((c.x * w - s.off * .12) % (w + 40) + w + 40) % (w + 40) - 20;
          g.fillStyle = '#ffffff';
          for (const [dx, dy, rr] of [[0,0,7],[7,2,5],[-7,2,5]])
            { g.beginPath(); g.arc(cx + dx * c.s, c.y * h + dy, rr * c.s, 0, 7); g.fill(); }
        }
        // two ranges of hills, the far one slower
        for (const [amp, spd, col, yb] of [[.10, .3, '#2f7a3a', .70], [.14, .7, '#1f5528', .80]]) {
          g.fillStyle = col; g.beginPath(); g.moveTo(0, h);
          for (let x = 0; x <= w; x++) {
            const p = (x + s.off * spd) * .03;
            g.lineTo(x, h * yb - (Math.sin(p) + Math.sin(p * .5 + 1)) * h * amp);
          }
          g.lineTo(w, h); g.closePath(); g.fill();
        }
        for (const pl of s.plats) {
          const px = ((pl.x * w - s.off) % (w * 3) + w * 3) % (w * 3);
          if (px > w + 40) continue;
          const py = pl.y * h + Math.sin(t * 1.3 + pl.x * 9) * 3;
          g.fillStyle = '#8a5a2a'; g.fillRect(px | 0, py | 0, pl.w | 0, 5);
          g.fillStyle = '#3fbf4a'; g.fillRect(px | 0, (py - 2) | 0, pl.w | 0, 2);
        }
        g.fillStyle = '#6b4423'; g.fillRect(0, h * .88, w, h * .12);
        g.fillStyle = '#3fbf4a'; g.fillRect(0, h * .88, w, 3);
      },
    },

    cave: {
      label: 'Cave · underground', cat: 'platform',
      init(r, w, h, density) {
        const n = Math.round(lerp(6, 22, density));
        return { r, off: 0,
          spikes: Array.from({ length: n }, () => ({ x: r() * 2, w: 4 + r() * 9, h: .1 + r() * .22, up: r() > .5 })),
          gems: Array.from({ length: Math.round(n / 2) }, () => ({ x: r() * 2, y: .3 + r() * .4, p: r() * 6 })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#0d0a14'; g.fillRect(0, 0, w, h);
        s.off += o.speed * o.step * 22 * (1 + env.level);
        g.fillStyle = '#1c1526';
        for (const sp of s.spikes) {
          const x = ((sp.x * w - s.off) % (w * 2) + w * 2) % (w * 2);
          if (x > w + 20) continue;
          const sh = sp.h * h;
          g.beginPath();
          if (sp.up) { g.moveTo(x, 0); g.lineTo(x + sp.w, 0); g.lineTo(x + sp.w / 2, sh); }
          else { g.moveTo(x, h); g.lineTo(x + sp.w, h); g.lineTo(x + sp.w / 2, h - sh); }
          g.closePath(); g.fill();
        }
        for (const gm of s.gems) {
          const x = ((gm.x * w - s.off * .8) % (w * 2) + w * 2) % (w * 2);
          if (x > w + 10) continue;
          const pulse = .5 + Math.sin(t * 3 + gm.p) * .5;
          g.fillStyle = `rgba(46,242,255,${.35 + pulse * .5 + env.treble * .2})`;
          const y = gm.y * h, r = 2 + pulse * 2;
          g.beginPath(); g.moveTo(x, y - r * 1.6); g.lineTo(x + r, y); g.lineTo(x, y + r * 1.6); g.lineTo(x - r, y);
          g.closePath(); g.fill();
        }
        g.fillStyle = '#241a30'; g.fillRect(0, h - 6, w, 6); g.fillRect(0, 0, w, 5);
      },
    },

    // ---------------- SHOOTER ----------------
    squadron: {
      label: 'Squadron · vertical', cat: 'shooter',
      init(r, w, h, density) {
        const rows = Math.round(lerp(2, 5, density));
        return { r, scroll: 0, fire: 0,
          stars: Array.from({ length: 60 }, () => ({ x: r(), y: r(), v: .3 + r() })),
          ships: Array.from({ length: rows * 5 }, (_, i) => ({ col: i % 5, row: (i / 5) | 0, p: r() * 6 })),
          shots: [] };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#04030c'; g.fillRect(0, 0, w, h);
        for (const st of s.stars) {
          st.y += st.v * o.speed * o.step * .6 * (1 + env.level);
          if (st.y > 1) { st.y = 0; st.x = s.r(); }
          g.fillStyle = `rgba(220,235,255,${.3 + st.v * .5})`;
          g.fillRect((st.x * w) | 0, (st.y * h) | 0, 1, st.v > .9 ? 2 : 1);
        }
        const sway = Math.sin(t * .9) * w * .12;
        for (const sh of s.ships) {
          const x = w * .18 + sh.col * w * .16 + sway;
          const y = h * .16 + sh.row * 16 + Math.sin(t * 1.6 + sh.p) * 3;
          g.fillStyle = '#c0c8d8';
          g.fillRect(x - 4, y, 9, 3); g.fillRect(x - 1, y - 3, 3, 3); g.fillRect(x - 6, y + 3, 3, 2); g.fillRect(x + 4, y + 3, 3, 2);
          g.fillStyle = env.treble > .3 ? '#ffd23f' : '#ff2e88';
          g.fillRect(x - 1, y + 3, 3, 2);
        }
        s.fire += o.step * (2 + env.bass * 10);
        if (s.fire > 1) {
          s.fire = 0;
          const sh = s.ships[Math.floor(s.r() * s.ships.length)];
          if (sh) s.shots.push({ x: w * .18 + sh.col * w * .16 + sway, y: h * .16 + sh.row * 16 });
        }
        g.fillStyle = '#ffd23f';
        for (const b of s.shots) { b.y += o.speed * o.step * 130; g.fillRect(b.x | 0, b.y | 0, 2, 5); }
        s.shots = s.shots.filter(b => b.y < h);
        // the player, holding the bottom
        const px = w / 2 + Math.sin(t * 1.4) * w * .22;
        g.fillStyle = '#2ef2ff';
        g.fillRect(px - 1, h - 22, 3, 8); g.fillRect(px - 6, h - 15, 13, 4); g.fillRect(px - 9, h - 12, 5, 3); g.fillRect(px + 5, h - 12, 5, 3);
      },
    },

    // ---------------- CYBERPUNK ----------------
    alley: {
      label: 'Alley · neon', cat: 'cyber',
      init(r, w, h, density) {
        const n = Math.round(lerp(4, 14, density));
        return { r, z: 0,
          signs: Array.from({ length: n }, () => ({ side: r() > .5, d: r(), h: .1 + r() * .22, c: r(), blink: r() * 6 })),
          drops: Array.from({ length: 50 }, () => ({ x: r(), y: r(), v: .6 + r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#06040d'; g.fillRect(0, 0, w, h);
        s.z += o.speed * o.step * .22 * (1 + env.level);
        const cx = w / 2, cy = h * .46;
        const cols = ['#ff2e88', '#2ef2ff', '#ffd23f', '#8b5cf6'];
        g.fillStyle = '#0d0a16';
        g.beginPath(); g.moveTo(0, 0); g.lineTo(cx - w * .1, cy); g.lineTo(cx - w * .1, h); g.lineTo(0, h); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(w, 0); g.lineTo(cx + w * .1, cy); g.lineTo(cx + w * .1, h); g.lineTo(w, h); g.closePath(); g.fill();
        g.fillStyle = '#15101f';
        g.beginPath(); g.moveTo(cx - w * .1, cy); g.lineTo(cx + w * .1, cy); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fill();
        for (const sg of s.signs) {
          const f = ((sg.d + s.z) % 1) ** 1.8;
          const depth = .08 + f * .92;
          const x = sg.side ? cx + w * .1 * depth + (w * .4) * f : cx - w * .1 * depth - (w * .4) * f;
          const y = cy - h * .2 * depth + h * .1 * f;
          const sw = Math.max(2, 3 + f * 16), sh = Math.max(2, sg.h * h * depth);
          const on = Math.sin(t * 4 + sg.blink) > -.5;
          const col = cols[Math.floor(sg.c * cols.length) % cols.length];
          g.fillStyle = on ? col : 'rgba(40,30,60,.7)';
          g.fillRect(x - sw / 2, y, sw, sh);
          if (on) {
            g.globalAlpha = .18 + env.treble * .3;
            g.fillRect(x - sw * 1.4, y - sh * .3, sw * 2.8, sh * 1.6);
            g.globalAlpha = 1;
          }
        }
        for (const d of s.drops) {
          d.y += d.v * o.speed * o.step * 1.4;
          if (d.y > 1) { d.y = 0; d.x = s.r(); }
          g.fillStyle = 'rgba(150,200,230,.45)';
          g.fillRect((d.x * w) | 0, (d.y * h) | 0, 1, 3);
        }
      },
    },

    hologram: {
      label: 'Hologram · wireframe', cat: 'cyber',
      init(r, w, h) { return { r, ry: r() * 6.28, rx: 0 }; },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#03060a'; g.fillRect(0, 0, w, h);
        s.ry += o.speed * o.step * .7; s.rx = Math.sin(t * .4) * .5;
        const R = Math.min(w, h) * .28 * (1 + env.bass * .18), cx = w / 2, cy = h * .46;
        const V = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
        const E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
        const proj = ([x, y, z]) => {
          const ca = Math.cos(s.ry), sa = Math.sin(s.ry);
          let X = x * ca - z * sa, Z = x * sa + z * ca;
          const cb = Math.cos(s.rx), sb = Math.sin(s.rx);
          const Y = y * cb - Z * sb; Z = y * sb + Z * cb;
          const p = 2.6 / (2.6 + Z);
          return [cx + X * R * p, cy + Y * R * p];
        };
        g.strokeStyle = `rgba(46,242,255,${.55 + env.level * .45})`; g.lineWidth = 1;
        for (const [a, b] of E) {
          const [x1, y1] = proj(V[a]), [x2, y2] = proj(V[b]);
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
        }
        g.fillStyle = 'rgba(46,242,255,.10)';
        for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
        const sweep = ((t * 40) % (h + 20)) - 10;
        g.fillStyle = 'rgba(46,242,255,.22)'; g.fillRect(0, sweep, w, 4);
        g.fillStyle = 'rgba(46,242,255,.35)';
        g.fillRect(cx - R * 1.2, cy + R * 1.15, R * 2.4, 2);
      },
    },

    // ---------------- STRATEGY ----------------
    isomap: {
      label: 'Iso map · tactics', cat: 'strategy',
      init(r, w, h, density) {
        const N = 14, tiles = new Float32Array(N * N);
        for (let i = 0; i < N * N; i++) tiles[i] = r();
        return { r, N, tiles, ox: 0, units: Array.from({ length: Math.round(lerp(2, 8, density)) },
          () => ({ i: Math.floor(r() * N), j: Math.floor(r() * N), p: r() * 6, c: r() > .5 })) };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#080b12'; g.fillRect(0, 0, w, h);
        s.ox += o.speed * o.step * 6 * (1 + env.level * .5);
        const TW = 16, TH = 8, N = s.N;
        const ox = w / 2 - s.ox % (TW * 2), oy = h * .28;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const v = s.tiles[j * N + i];
          const x = ox + (i - j) * TW / 2, y = oy + (i + j) * TH / 2 - v * 5;
          if (x < -TW || x > w + TW || y < -TH || y > h + TH) continue;
          const top = v > .72 ? '#6f8c3a' : v > .4 ? '#3f6b34' : '#26507a';
          g.fillStyle = top;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + TW / 2, y + TH / 2);
          g.lineTo(x, y + TH); g.lineTo(x - TW / 2, y + TH / 2); g.closePath(); g.fill();
          g.fillStyle = 'rgba(0,0,0,.35)';
          g.fillRect(x - TW / 2, y + TH / 2, TW / 2, Math.max(1, v * 5));
          g.fillStyle = 'rgba(0,0,0,.2)';
          g.fillRect(x, y + TH / 2, TW / 2, Math.max(1, v * 5));
        }
        for (const u of s.units) {
          const v = s.tiles[u.j * N + u.i];
          const x = ox + (u.i - u.j) * TW / 2, y = oy + (u.i + u.j) * TH / 2 - v * 5;
          const bob = Math.sin(t * 2.4 + u.p) > 0 ? 0 : 1;
          g.fillStyle = u.c ? '#ff2e88' : '#2ef2ff';
          g.fillRect(x - 2, y - 7 + bob, 4, 7);
          g.fillStyle = '#0b0a12'; g.fillRect(x - 2, y - 7 + bob, 4, 2);
        }
      },
    },

    // ---------------- PUZZLE ----------------
    blocks: {
      label: 'Blocks · falling', cat: 'puzzle',
      init(r, w, h, density) {
        const cols = Math.round(lerp(6, 12, density));
        return { r, cols, stack: new Array(cols).fill(0), y: -1, x: Math.floor(r() * cols), col: Math.floor(r() * 4), flash: 0 };
      },
      draw(g, w, h, t, env, s, o) {
        g.fillStyle = '#07060e'; g.fillRect(0, 0, w, h);
        const CW = w / s.cols, rows = Math.floor(h / CW);
        g.strokeStyle = 'rgba(255,255,255,.05)';
        for (let i = 0; i <= s.cols; i++) { g.beginPath(); g.moveTo(i * CW, 0); g.lineTo(i * CW, h); g.stroke(); }
        const cols4 = ['#ff2e88', '#2ef2ff', '#ffd23f', '#8b5cf6'];
        s.y += o.speed * o.step * (7 + env.level * 12);
        const landed = rows - s.stack[s.x];
        if (s.y >= landed - 1) {
          s.stack[s.x] = Math.min(rows - 1, s.stack[s.x] + 1);
          if (s.stack.every(v => v > 0)) { s.stack = s.stack.map(v => v - 1); s.flash = 1; }
          s.y = -1; s.x = Math.floor(s.r() * s.cols); s.col = Math.floor(s.r() * 4);
        }
        for (let c = 0; c < s.cols; c++) for (let k = 0; k < s.stack[c]; k++) {
          g.fillStyle = cols4[(c + k) % 4];
          g.fillRect(c * CW + 1, h - (k + 1) * CW + 1, CW - 2, CW - 2);
          g.fillStyle = 'rgba(255,255,255,.18)';
          g.fillRect(c * CW + 1, h - (k + 1) * CW + 1, CW - 2, 2);
        }
        g.fillStyle = cols4[s.col];
        g.fillRect(s.x * CW + 1, s.y * CW + 1, CW - 2, CW - 2);
        if (s.flash > 0) {
          g.fillStyle = `rgba(255,255,255,${s.flash * .5})`; g.fillRect(0, 0, w, h);
          s.flash = Math.max(0, s.flash - o.step * 3);
        }
      },
    },

    // ---------------- CHARACTERS ----------------
    walker: {
      label: 'Walker · character', cat: 'people',
      init(r, w, h, density) {
        return { r, off: 0, step: 0,
          hills: Array.from({ length: 5 }, () => ({ x: r(), s: .5 + r() })),
          extras: Math.round(lerp(0, 3, density)) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#241844'); sky.addColorStop(1, '#8a4a6a');
        g.fillStyle = sky; g.fillRect(0, 0, w, h);
        s.off += o.speed * o.step * 24 * (1 + env.level * .6);
        g.fillStyle = '#160f28';
        for (const hl of s.hills) {
          const x = ((hl.x * w - s.off * .3) % (w + 60) + w + 60) % (w + 60) - 30;
          g.beginPath(); g.arc(x, h * .82, 26 * hl.s, Math.PI, 0); g.fill();
        }
        const base = h * .82;
        g.fillStyle = '#0d0918'; g.fillRect(0, base, w, h - base);
        g.fillStyle = '#2a1f3d';
        for (let x = -(s.off % 12); x < w; x += 12) g.fillRect(x, base, 6, 2);

        // A little sprite drawn from blocks, legs driven by a walk cycle.
        s.step += o.step * (7 + env.level * 6) * o.speed;
        const draw1 = (cx, scale, hue) => {
          // Every block gets a dark outline drawn under it, otherwise a limb
          // against dark ground disappears at four colours.
          const P = (x, y, ww, hh, c) => {
            g.fillStyle = '#0a0714';
            g.fillRect(cx + x * scale - 1, base - (y + hh) * scale - 1, ww * scale + 2, hh * scale + 2);
            g.fillStyle = c;
            g.fillRect(cx + x * scale, base - (y + hh) * scale, ww * scale, hh * scale);
          };
          const swing = Math.sin(s.step), bob = Math.abs(Math.cos(s.step)) * 1.2;
          P(-3, 0 + bob, 2, 5 + swing * 2, '#8b5cf6');          // back leg
          P(1, 0 + bob, 2, 5 - swing * 2, '#b48bff');           // front leg
          P(-3, 5 + bob, 6, 6, hue);                            // torso
          P(-5, 8 + bob, 2, 3 + swing, hue);                    // arm
          P(3, 8 + bob, 2, 3 - swing, hue);                     // arm
          P(-2.5, 11 + bob, 5, 4, '#f0c9a0');                   // head
          P(-3, 14 + bob, 6, 2, '#241a3a');                     // hair
          g.fillStyle = '#0a0714';
          g.fillRect(cx - 1.5 * scale, base - (13 + bob) * scale, scale, scale);
          g.fillRect(cx + 0.5 * scale, base - (13 + bob) * scale, scale, scale);
        };
        const sc = Math.max(2, Math.round(h / 42));
        draw1(w * .38, sc, '#2ef2ff');
        for (let i = 0; i < s.extras; i++)
          draw1(w * .38 + (i + 1) * sc * 14, Math.max(2, sc - 1), ['#ff2e88', '#ffd23f', '#3fbf4a'][i % 3]);
      },
    },
  };

  window.NeoScene = { SCENES, CATS, rng, randomSeed };
})();
