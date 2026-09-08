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
    biome:    { label: 'Biomes', kanji: '地' },
  };

  // ---------- character sprites ----------
  // One anatomy, many outfits. Every character is the same stack of blocks with
  // a shared walk cycle, so a new one is a palette and a couple of flags rather
  // than a new drawing routine.
  const CHARS = {
    hero:    { skin: '#f0c9a0', cloth: '#2ef2ff', trim: '#1a6f8c', hair: '#241a3a' },
    knight:  { skin: '#f0c9a0', cloth: '#b8c2d0', trim: '#6f7a8c', hair: '#8a8f9c', helm: true, weapon: 'sword' },
    mage:    { skin: '#f0c9a0', cloth: '#8b5cf6', trim: '#4c2f8c', hair: '#e8e0f0', hat: true, weapon: 'staff' },
    ninja:   { skin: '#2a2438', cloth: '#1b1430', trim: '#ff2e88', hair: '#0d0a16', mask: true },
    rogue:   { skin: '#e8b98a', cloth: '#3fbf4a', trim: '#1f6b28', hair: '#5a3a1a', cape: true },
    robot:   { skin: '#8fa3b8', cloth: '#c0c8d8', trim: '#ffd23f', hair: '#5a6a7c', helm: true, robot: true },
    beast:   { skin: '#7a4a28', cloth: '#5c3520', trim: '#ff8c42', hair: '#3a2414', horns: true },
    princess:{ skin: '#f7d6b8', cloth: '#ff2e88', trim: '#ffd23f', hair: '#ffd23f', dress: true },
  };
  const CHAR_KEYS = Object.keys(CHARS);

  // walk: phase in radians. facing: 1 right, -1 left. act: 0..1 attack pose.
  function drawChar(g, c, cx, base, sc, walk, facing = 1, act = 0) {
    const sw = Math.sin(walk), bob = Math.abs(Math.cos(walk)) * 1.1;
    const P = (x, y, ww, hh, col) => {
      const X = cx + (facing > 0 ? x : -x - ww) * sc;
      g.fillStyle = '#0a0714';
      g.fillRect(X - 1, base - (y + hh) * sc - 1, ww * sc + 2, hh * sc + 2);
      g.fillStyle = col;
      g.fillRect(X, base - (y + hh) * sc, ww * sc, hh * sc);
    };
    // legs
    if (c.dress) { P(-3.5, 0 + bob, 7, 7, c.cloth); }
    else {
      P(-3, 0 + bob, 2.5, 5 + sw * 2, c.trim);
      P(0.5, 0 + bob, 2.5, 5 - sw * 2, c.cloth);
    }
    if (c.cape) P(-4.5, 4 + bob, 3, 9, c.trim);
    // torso
    P(-3, 5 + bob, 6, 6, c.cloth);
    P(-3, 5 + bob, 6, 2, c.trim);
    // arms - the front one swings, or thrusts when acting
    P(-5, 8 + bob, 2, 3 + sw, c.cloth);
    const reach = act > 0 ? 3.5 + act * 2 : 3;
    P(reach - 0.5, 8 + bob - act * 1.5, 2, 3 - sw, c.cloth);
    if (c.weapon === 'sword') {
      P(reach + 1, 9 + bob - act * 1.5, 1.2, 8 + act * 3, '#dfe6f0');
      P(reach + 0.4, 8.6 + bob - act * 1.5, 2.4, 1, c.trim);
    }
    if (c.weapon === 'staff') {
      P(reach + 1, 6 + bob, 1, 13, '#8a5a2a');
      P(reach + 0.2, 18 + bob, 2.6, 2.6, act > .3 ? '#ffffff' : c.trim);
    }
    // head
    P(-2.5, 11 + bob, 5, 4, c.mask ? c.cloth : c.skin);
    if (c.helm) P(-3, 13.5 + bob, 6, 2.5, c.trim);
    else if (c.hat) { P(-4, 14.5 + bob, 8, 1.5, c.cloth); P(-2, 16 + bob, 4, 3, c.cloth); }
    else if (c.dress) { P(-3.5, 14 + bob, 7, 2.5, c.hair); P(-4, 11 + bob, 1.5, 4, c.hair); P(2.5, 11 + bob, 1.5, 4, c.hair); }
    else P(-3, 14 + bob, 6, 2, c.hair);
    if (c.horns) { P(-3.5, 15.5 + bob, 1.2, 2.5, '#e8d9b0'); P(2.3, 15.5 + bob, 1.2, 2.5, '#e8d9b0'); }
    // eyes
    const ey = base - (12.5 + bob) * sc;
    g.fillStyle = c.robot ? '#ff2e88' : c.mask ? c.trim : '#0a0714';
    const e1 = cx + (facing > 0 ? -1.5 : 0.5) * sc, e2 = cx + (facing > 0 ? 0.5 : -1.5) * sc;
    g.fillRect(e1, ey, sc, sc); g.fillRect(e2, ey, sc, sc);
  }

  const SCENES = {
    starfield: {
      label: 'Starfield · warp', cat: 'scifi',
      init(r, w, h, density) {
        const n = Math.round(lerp(40, 400, density));
        return { r, stars: Array.from({ length: n }, () => ({ x: r() * 2 - 1, y: r() * 2 - 1, z: r(), c: r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        if (o.bg !== false) { g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h); }
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
      label: 'Skyline · parallax city', cat: 'cyber', solid: true,
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
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
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
        const sunR = h * 0.16 + env.bass * h * 0.05;
        if (o.bg !== false) {
          g.fillStyle = sky; g.fillRect(0, 0, w, h * 0.55);
          g.fillStyle = '#07030f'; g.fillRect(0, h * 0.55, w, h * 0.45);
          g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(w / 2, h * 0.5, sunR, 0, 7); g.fill();
          g.fillStyle = '#07030f';
          for (let i = 0; i < 6; i++) g.fillRect(0, h * 0.42 + i * (sunR / 3.4), w, Math.max(1, sunR / 12));
        }

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
        if (o.bg !== false) { g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h); }
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
      label: 'Plasma · field', cat: 'abstract', solid: true,
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
        if (o.bg !== false) { g.fillStyle = 'rgba(5,4,10,.35)'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h); }
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
      label: 'Fire · demoscene', cat: 'abstract', solid: true,
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
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
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
      label: 'Village · rooftops', cat: 'rpg', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(5, 16, density));
        return { r, off: 0,
          huts: Array.from({ length: n }, () => ({ w: 14 + r() * 20, h: .12 + r() * .14, lit: r(), roof: r() })),
          trees: Array.from({ length: n }, () => ({ x: r(), s: .5 + r() * .7 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#1a1040'); sky.addColorStop(.55, '#c94f7c'); sky.addColorStop(1, '#ffd23f');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
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
      label: 'Overworld · map', cat: 'rpg', solid: true,
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
        if (o.bg !== false) { g.fillStyle = '#070509'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) {
          g.fillStyle = sky; g.fillRect(0, 0, w, h * .5);
          g.fillStyle = '#1d3a1a'; g.fillRect(0, h * .5, w, h * .5);
        }
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
        if (o.bg !== false) { g.fillStyle = '#05040f'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#04060a'; g.fillRect(0, 0, w, h); }
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
      label: 'Kaiju · city stomp', cat: 'monster', solid: true,
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
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
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
        // The beast: a stepping silhouette with a swinging tail and arms, and a
        // breath weapon that fires on the low end.
        s.step += o.step * (1.6 + env.bass * 3) * o.speed;
        const sway = Math.sin(s.step) * 3, lift = Math.abs(Math.sin(s.step * .5)) * 3;
        const swing = Math.sin(s.step);
        const bx = w * .62 + sway, by = base - lift, bw = w * .17, bh2 = h * .52;

        s.breath = Math.max(0, (s.breath || 0) - o.step * 1.6);
        if (env.bass > .55 && s.breath <= 0) s.breath = 1;

        const beast = (grow, fill) => {
          g.fillStyle = fill;
          const R = (x, y, ww, hh) => g.fillRect(x - grow, y - grow, ww + grow * 2, hh + grow * 2);
          // tail, drawn as a tapering chain of blocks
          for (let i = 0; i < 7; i++) {
            const f = i / 6;
            const tx = bx - bw * .5 - f * bw * 1.5;
            const ty = by - bh2 * .18 + Math.sin(s.step * 1.2 - f * 2.2) * 7 * f + f * 6;
            R(tx, ty, bw * .30 * (1 - f * .7) + 2, bw * .26 * (1 - f * .7) + 2);
          }
          R(bx - bw / 2, by - bh2, bw, bh2 * .82);                       // torso
          R(bx - bw * .40, by - bh2 * .22, bw * .80, bh2 * .24);         // hips
          // arms swing opposite to the legs
          R(bx - bw * .92, by - bh2 * .74 + swing * 4, bw * .46, bh2 * .30);
          R(bx + bw * .46, by - bh2 * .70 - swing * 4, bw * .46, bh2 * .26);
          // legs
          R(bx - bw * .44, by - 2, bw * .36, lift + 4);
          R(bx + bw * .08, by - 2, bw * .36, 4 - lift * .4);
          // head on a short neck, jutting forward
          R(bx - bw * .10, by - bh2 - bw * .40, bw * .30, bw * .30);
          R(bx + bw * .12, by - bh2 - bw * .46, bw * .52, bw * .34);
          // dorsal spines
          for (let i = 0; i < 6; i++) {
            const f = i / 5;
            R(bx - bw * .48 - f * bw * .10, by - bh2 * .88 + f * (bh2 * .62), 4 + (1 - f) * 2, 5);
          }
        };
        beast(2, '#ffd9a0');
        beast(0, '#050208');

        const hx = bx + bw * .64, hy = by - bh2 - bw * .30;
        const eye = env.treble > .25 ? '#ffffff' : '#ff2e88';
        g.fillStyle = eye;
        g.fillRect(hx - bw * .16, hy, 3, 2);
        if (s.breath > 0) {
          const reach = (1 - s.breath) * w * .5 + 8;
          for (let i = 0; i < 16; i++) {
            const f = i / 15;
            const fx = hx + f * reach, fy = hy + 3 + Math.sin(f * 6 + s.step * 5) * f * 9;
            const r = 2 + f * 9 * s.breath;
            g.fillStyle = f < .35 ? `rgba(255,246,200,${s.breath})`
                        : f < .7 ? `rgba(255,180,50,${s.breath * .9})`
                                 : `rgba(255,90,30,${s.breath * .6})`;
            g.fillRect(fx - r / 2, fy - r / 2, r, r);
          }
        }
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
        if (o.bg !== false) { g.fillStyle = '#04030a'; g.fillRect(0, 0, w, h); }
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
      label: 'Hills · side-scroll', cat: 'platform', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(3, 10, density));
        return { r, off: 0,
          clouds: Array.from({ length: 6 }, () => ({ x: r(), y: .08 + r() * .3, s: .6 + r() * .9 })),
          plats: Array.from({ length: n }, () => ({ x: r() * 3, y: .3 + r() * .35, w: 16 + r() * 26 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#3aa6ff'); sky.addColorStop(1, '#bfe9ff');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#0d0a14'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#04030c'; g.fillRect(0, 0, w, h); }
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
      label: 'Alley · neon', cat: 'cyber', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(4, 14, density));
        return { r, z: 0,
          signs: Array.from({ length: n }, () => ({ side: r() > .5, d: r(), h: .1 + r() * .22, c: r(), blink: r() * 6 })),
          drops: Array.from({ length: 50 }, () => ({ x: r(), y: r(), v: .6 + r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        if (o.bg !== false) { g.fillStyle = '#06040d'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#03060a'; g.fillRect(0, 0, w, h); }
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
      label: 'Iso map · tactics', cat: 'strategy', solid: true,
      init(r, w, h, density) {
        const N = 14, tiles = new Float32Array(N * N);
        for (let i = 0; i < N * N; i++) tiles[i] = r();
        return { r, N, tiles, ox: 0, units: Array.from({ length: Math.round(lerp(2, 8, density)) },
          () => ({ i: Math.floor(r() * N), j: Math.floor(r() * N), p: r() * 6, c: r() > .5 })) };
      },
      draw(g, w, h, t, env, s, o) {
        if (o.bg !== false) { g.fillStyle = '#080b12'; g.fillRect(0, 0, w, h); }
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
        if (o.bg !== false) { g.fillStyle = '#07060e'; g.fillRect(0, 0, w, h); }
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
        const keys = CHAR_KEYS;
        return { r, off: 0, step: 0,
          who: keys[Math.floor(r() * keys.length)],
          hills: Array.from({ length: 5 }, () => ({ x: r(), s: .5 + r() })),
          extras: Array.from({ length: Math.round(lerp(0, 3, density)) },
            () => ({ who: keys[Math.floor(r() * keys.length)], gap: 14 + r() * 10, ph: r() * 6.28 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#241844'); sky.addColorStop(1, '#8a4a6a');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        s.off += o.speed * o.step * 24 * (1 + env.level * .6);
        if (o.bg !== false) {
          g.fillStyle = '#160f28';
          for (const hl of s.hills) {
            const x = ((hl.x * w - s.off * .3) % (w + 60) + w + 60) % (w + 60) - 30;
            g.beginPath(); g.arc(x, h * .82, 26 * hl.s, Math.PI, 0); g.fill();
          }
        }
        const base = h * .82;
        if (o.bg !== false) {
          g.fillStyle = '#0d0918'; g.fillRect(0, base, w, h - base);
          g.fillStyle = '#2a1f3d';
          for (let x = -(s.off % 12); x < w; x += 12) g.fillRect(x, base, 6, 2);
        }
        s.step += o.step * (7 + env.level * 6) * o.speed;
        const sc = Math.max(2, Math.round(h / 52));
        drawChar(g, CHARS[s.who], w * .30, base, sc, s.step, 1);
        let x = w * .38;
        for (const e of s.extras) {
          x += (e.gap + 6) * sc;
          drawChar(g, CHARS[e.who], x, base, Math.max(2, sc - 1), s.step + e.ph, 1);
        }
      },
    },

    crowd: {
      label: 'Crowd · procession', cat: 'people',
      init(r, w, h, density) {
        const n = Math.round(lerp(4, 16, density));
        return { r, step: 0,
          folk: Array.from({ length: n }, () => ({
            who: CHAR_KEYS[Math.floor(r() * CHAR_KEYS.length)],
            x: r() * 1.3, depth: .35 + r() * .65, ph: r() * 6.28, dir: r() > .35 ? 1 : -1 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#100b26'); sky.addColorStop(.55, '#42246b'); sky.addColorStop(1, '#c9598a');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        s.step += o.step * (6 + env.level * 8) * o.speed;
        // far figures first so nearer ones overlap them
        const sorted = [...s.folk].sort((a, b) => a.depth - b.depth);
        for (const f of sorted) {
          f.x += f.dir * o.speed * o.step * .06 * f.depth * (1 + env.level * .5);
          if (f.x > 1.35) f.x = -.35; if (f.x < -.35) f.x = 1.35;
          const base = h * (.58 + f.depth * .34);
          const sc = Math.max(1, Math.round((h / 100) * (.55 + f.depth * .95)));
          drawChar(g, CHARS[f.who], f.x * w, base, sc, s.step * f.depth + f.ph, f.dir);
        }
        if (o.bg !== false) { g.fillStyle = 'rgba(10,6,20,.55)'; g.fillRect(0, h * .93, w, h * .07); }
      },
    },

    duel: {
      label: 'Duel · standoff', cat: 'people',
      init(r, w, h, density) {
        const keys = CHAR_KEYS;
        const a = Math.floor(r() * keys.length);
        let b = Math.floor(r() * keys.length); if (b === a) b = (b + 3) % keys.length;
        return { r, a: keys[a], b: keys[b], step: 0, swing: 0, turn: 0, hit: 0 };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#1c0a2e'); sky.addColorStop(.6, '#8c2350'); sky.addColorStop(1, '#ffb347');
        if (o.bg !== false) {
          g.fillStyle = sky; g.fillRect(0, 0, w, h);
          g.fillStyle = '#fff2c0';
          g.beginPath(); g.arc(w / 2, h * .42, 18 + env.bass * 9, 0, 7); g.fill();
          g.fillStyle = '#1a1030'; g.fillRect(0, h * .78, w, h * .22);
        }
        const base = h * .8, sc = Math.max(2, Math.round(h / 64));
        // trade blows: whoever is attacking lunges, the other recoils
        s.swing += o.step * (1.6 + env.bass * 3.5) * o.speed;
        const cyc = (Math.sin(s.swing) + 1) / 2;
        const aAct = Math.max(0, Math.sin(s.swing)), bAct = Math.max(0, -Math.sin(s.swing));
        s.step += o.step * 2;
        const gap = w * (.24 - cyc * .045);
        drawChar(g, CHARS[s.a], w / 2 - gap, base, sc, s.step * .2, 1, aAct);
        drawChar(g, CHARS[s.b], w / 2 + gap, base, sc, s.step * .2, -1, bAct);
        // clash spark when the swings cross
        const clash = Math.abs(Math.sin(s.swing));
        if (clash > .93) {
          const cx = w / 2, cy = base - 11 * sc;
          g.fillStyle = `rgba(255,246,200,${(clash - .93) * 12})`;
          for (let i = 0; i < 8; i++) {
            const a = i * .785 + s.swing;
            g.fillRect(cx + Math.cos(a) * 7 * sc, cy + Math.sin(a) * 7 * sc, sc, sc);
          }
        }
      },
    },

    // ---------------- SPACESHIPS ----------------
    fleet: {
      label: 'Fleet · flyby', cat: 'scifi',
      init(r, w, h, density) {
        const n = Math.round(lerp(2, 8, density));
        return { r,
          stars: Array.from({ length: 70 }, () => ({ x: r(), y: r(), b: r() })),
          ships: Array.from({ length: n }, () => ({ x: r() * 1.6, y: .15 + r() * .7, s: .5 + r() * 1.1, v: .5 + r() * .9, k: r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        if (o.bg !== false) { g.fillStyle = '#04030c'; g.fillRect(0, 0, w, h); }
        for (const st of s.stars) {
          g.fillStyle = `rgba(210,230,255,${.2 + st.b * .6})`;
          g.fillRect((st.x * w) | 0, (st.y * h) | 0, 1, 1);
        }
        for (const sh of s.ships) {
          sh.x -= o.speed * o.step * sh.v * .16 * (1 + env.level);
          if (sh.x < -.4) { sh.x = 1.5; sh.y = .15 + s.r() * .7; sh.s = .5 + s.r() * 1.1; }
          const x = sh.x * w, y = sh.y * h, sc = sh.s;
          // hull
          g.fillStyle = '#c3ccdb';
          g.fillRect(x, y, 26 * sc, 5 * sc);
          g.fillRect(x + 6 * sc, y - 3 * sc, 13 * sc, 3 * sc);
          g.fillStyle = '#7e8persist'.slice(0, 0) || '#7e88a0';
          g.fillRect(x, y + 5 * sc, 26 * sc, 2 * sc);
          // fins
          g.fillStyle = '#98a3b8';
          g.fillRect(x + 2 * sc, y + 7 * sc, 6 * sc, 3 * sc);
          g.fillRect(x + 17 * sc, y + 7 * sc, 6 * sc, 3 * sc);
          // cockpit and engine glow
          g.fillStyle = '#2ef2ff';
          g.fillRect(x + 20 * sc, y + 1 * sc, 4 * sc, 2 * sc);
          const flame = 4 + env.level * 8 + Math.sin(t * 20 + sh.k * 9) * 2;
          g.fillStyle = 'rgba(255,140,40,.9)';
          g.fillRect(x - flame * sc, y + 1 * sc, flame * sc, 3 * sc);
          g.fillStyle = 'rgba(255,220,120,.7)';
          g.fillRect(x - flame * .5 * sc, y + 1.5 * sc, flame * .5 * sc, 2 * sc);
        }
      },
    },

    dogfight: {
      label: 'Dogfight · lasers', cat: 'shooter',
      init(r, w, h, density) {
        const n = Math.round(lerp(2, 7, density));
        return { r, shots: [], fire: 0,
          stars: Array.from({ length: 50 }, () => ({ x: r(), y: r() })),
          ships: Array.from({ length: n }, () => ({ p: r() * 6.28, sp: .4 + r() * .8, rad: .18 + r() * .3, foe: r() > .5 })) };
      },
      draw(g, w, h, t, env, s, o) {
        if (o.bg !== false) { g.fillStyle = '#05040e'; g.fillRect(0, 0, w, h); }
        g.fillStyle = 'rgba(200,220,255,.6)';
        for (const st of s.stars) g.fillRect((st.x * w) | 0, (st.y * h) | 0, 1, 1);
        const pos = sh => {
          const a = t * sh.sp * o.speed + sh.p;
          return [w / 2 + Math.cos(a) * w * sh.rad, h / 2 + Math.sin(a * 1.3) * h * sh.rad];
        };
        for (const sh of s.ships) {
          const [x, y] = pos(sh);
          const a = Math.atan2(Math.sin(t * sh.sp * o.speed + sh.p + .1) * 1.3, -Math.sin(t * sh.sp * o.speed + sh.p));
          g.save(); g.translate(x, y); g.rotate(a);
          g.fillStyle = sh.foe ? '#ff2e88' : '#2ef2ff';
          g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -4); g.lineTo(-2, 0); g.lineTo(-5, 4); g.closePath(); g.fill();
          g.fillStyle = 'rgba(255,200,80,.9)';
          g.fillRect(-7 - env.level * 4, -1, 3 + env.level * 4, 2);
          g.restore();
        }
        s.fire += o.step * (3 + env.bass * 12);
        if (s.fire > 1 && s.ships.length) {
          s.fire = 0;
          const sh = s.ships[Math.floor(s.r() * s.ships.length)];
          const [x, y] = pos(sh);
          s.shots.push({ x, y, vx: (s.r() - .5) * 260, vy: (s.r() - .5) * 260, c: sh.foe, life: 1 });
        }
        for (const b of s.shots) {
          b.x += b.vx * o.step; b.y += b.vy * o.step; b.life -= o.step * .7;
          g.strokeStyle = b.c ? 'rgba(255,46,136,.95)' : 'rgba(46,242,255,.95)';
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.x - b.vx * .02, b.y - b.vy * .02); g.stroke();
        }
        s.shots = s.shots.filter(b => b.life > 0);
      },
    },

    // ---------------- BIOMES ----------------
    desert: {
      label: 'Desert · dunes', cat: 'biome', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(3, 7, density));
        return { r, off: 0, dunes: Array.from({ length: n }, (_, i) => ({ k: .012 + r() * .02, a: .04 + r() * .07, p: r() * 6.28, y: .5 + i * .09 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#3d1f5c'); sky.addColorStop(.45, '#ff8c42'); sky.addColorStop(.72, '#ffd9a0');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        g.fillStyle = '#fff3c4';
        g.beginPath(); g.arc(w * .5, h * .52, 16 + env.bass * 8, 0, 7); g.fill();
        s.off += o.speed * o.step * 8 * (1 + env.level * .5);
        s.dunes.forEach((d, i) => {
          const shade = ['#d9a05b', '#c08248', '#9c6436', '#7a4a28', '#5c3520', '#432614', '#2e1a0e'][i] || '#2e1a0e';
          g.fillStyle = shade;
          g.beginPath(); g.moveTo(0, h);
          for (let x = 0; x <= w; x++) {
            const p = (x + s.off * (i + 1) * .35) * d.k + d.p;
            g.lineTo(x, h * d.y - (Math.sin(p) + Math.sin(p * .43 + 1.7) * .6) * h * d.a);
          }
          g.lineTo(w, h); g.closePath(); g.fill();
        });
      },
    },

    pyramids: {
      label: 'Pyramids · valley', cat: 'biome', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(2, 6, density));
        return { r, off: 0,
          pyr: Array.from({ length: n }, () => ({ x: r() * 1.4, s: .4 + r() * .9, d: .3 + r() * .7 })),
          stars: Array.from({ length: 40 }, () => ({ x: r(), y: r() * .45 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#0e0a2e'); sky.addColorStop(.4, '#5b2a6e');
        sky.addColorStop(.62, '#ff9351'); sky.addColorStop(1, '#e0b070');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        g.fillStyle = '#fff';
        for (const st of s.stars) g.fillRect((st.x * w) | 0, (st.y * h) | 0, 1, 1);
        g.fillStyle = '#fff0c0';
        g.beginPath(); g.arc(w * .3, h * .58, 12 + env.bass * 6, 0, 7); g.fill();
        s.off += o.speed * o.step * 5 * (1 + env.level * .4);
        const base = h * .82;
        const sorted = [...s.pyr].sort((a, b) => a.d - b.d);
        for (const py of sorted) {
          const x = (((py.x * w - s.off * py.d) % (w * 1.6)) + w * 1.6) % (w * 1.6) - w * .3;
          const ph = h * .3 * py.s * (.5 + py.d), pw = ph * 1.6;
          const lightC = py.d > .55 ? '#e8c07a' : '#b08a52';
          const darkC = py.d > .55 ? '#8a5f33' : '#5f4223';
          g.fillStyle = lightC;
          g.beginPath(); g.moveTo(x, base); g.lineTo(x + pw / 2, base - ph); g.lineTo(x + pw / 2, base); g.closePath(); g.fill();
          g.fillStyle = darkC;
          g.beginPath(); g.moveTo(x + pw / 2, base); g.lineTo(x + pw / 2, base - ph); g.lineTo(x + pw, base); g.closePath(); g.fill();
        }
        g.fillStyle = '#c99a5e'; g.fillRect(0, base, w, h - base);
      },
    },

    jungle: {
      label: 'Jungle · canopy', cat: 'biome', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(8, 26, density));
        return { r, off: 0,
          leaves: Array.from({ length: n }, () => ({ x: r() * 1.5, y: r(), s: .5 + r() * 1.2, d: .3 + r() * .8, rot: r() * 6.28 })),
          vines: Array.from({ length: Math.round(n / 3) }, () => ({ x: r() * 1.5, len: .2 + r() * .5, d: .3 + r() * .8 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#a7e06b'); sky.addColorStop(.5, '#3d8a3a'); sky.addColorStop(1, '#0e2b16');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        // shafts of light through the canopy
        g.fillStyle = 'rgba(230,255,170,.10)';
        for (let i = 0; i < 4; i++) {
          const x = w * (.15 + i * .23) + Math.sin(t * .3 + i) * 6;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 16, 0); g.lineTo(x + 34, h); g.lineTo(x + 8, h); g.closePath(); g.fill();
        }
        s.off += o.speed * o.step * 10 * (1 + env.level * .6);
        const shade = d => d > .75 ? '#0d2412' : d > .5 ? '#16401f' : '#1f5c2a';
        for (const v of s.vines) {
          const x = (((v.x * w - s.off * v.d) % (w * 1.5)) + w * 1.5) % (w * 1.5);
          if (x > w + 6) continue;
          g.strokeStyle = shade(v.d); g.lineWidth = 1 + v.d;
          g.beginPath(); g.moveTo(x, 0);
          for (let y = 0; y < v.len * h; y += 4) g.lineTo(x + Math.sin(y * .12 + t * .6) * 4, y);
          g.stroke();
        }
        for (const lf of s.leaves) {
          const x = (((lf.x * w - s.off * lf.d) % (w * 1.5)) + w * 1.5) % (w * 1.5);
          if (x > w + 20) continue;
          const y = lf.y * h * .8;
          const sway = Math.sin(t * 1.1 + lf.rot) * .18;
          g.save(); g.translate(x, y); g.rotate(lf.rot + sway);
          g.fillStyle = shade(lf.d);
          for (let i = 0; i < 5; i++) {
            g.save(); g.rotate(i * 1.25);
            g.beginPath(); g.ellipse(0, -7 * lf.s, 3 * lf.s, 8 * lf.s, 0, 0, 7); g.fill();
            g.restore();
          }
          g.restore();
        }
      },
    },

    tundra: {
      label: 'Tundra · aurora', cat: 'biome', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(30, 150, density));
        return { r,
          flakes: Array.from({ length: n }, () => ({ x: r(), y: r(), v: .2 + r() * .8, d: r() })),
          bands: Array.from({ length: 4 }, () => ({ p: r() * 6.28, y: .1 + r() * .25, a: .04 + r() * .07 })),
          peaks: Array.from({ length: 7 }, () => ({ x: r(), s: .4 + r() * .9 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#050a24'); sky.addColorStop(1, '#1b3a5c');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        s.bands.forEach((b, i) => {
          g.strokeStyle = `rgba(${i % 2 ? 46 : 140},${i % 2 ? 242 : 255},${i % 2 ? 200 : 150},${.28 + env.level * .5})`;
          g.lineWidth = 3 + env.mid * 5;
          g.beginPath();
          for (let x = 0; x <= w; x++) {
            const p = x * .03 + t * (.5 + i * .2) + b.p;
            g.lineTo(x, h * b.y + Math.sin(p) * h * b.a + Math.sin(p * .4) * h * b.a);
          }
          g.stroke();
        });
        const base = h * .74;
        g.fillStyle = '#243a56';
        for (const pk of s.peaks) {
          const x = pk.x * w, ph = h * .2 * pk.s;
          g.beginPath(); g.moveTo(x - ph, base); g.lineTo(x, base - ph); g.lineTo(x + ph, base); g.closePath(); g.fill();
          g.fillStyle = '#dfe9f5';
          g.beginPath(); g.moveTo(x - ph * .35, base - ph * .62); g.lineTo(x, base - ph); g.lineTo(x + ph * .35, base - ph * .62); g.closePath(); g.fill();
          g.fillStyle = '#243a56';
        }
        g.fillStyle = '#e8f1fa'; g.fillRect(0, base, w, h - base);
        for (const f of s.flakes) {
          f.y += f.v * o.speed * o.step * .22;
          f.x += Math.sin(t + f.d * 9) * .0007 * o.speed;
          if (f.y > 1) { f.y = 0; f.x = s.r(); }
          g.fillStyle = `rgba(255,255,255,${.4 + f.v * .5})`;
          g.fillRect((f.x * w) | 0, (f.y * h) | 0, 1, 1);
        }
      },
    },

    volcano: {
      label: 'Volcano · ash', cat: 'biome', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(14, 60, density));
        return { r, glow: 0,
          embers: Array.from({ length: n }, () => ({ x: r(), y: r(), v: .3 + r(), s: r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#1a0508'); sky.addColorStop(.55, '#5c1410'); sky.addColorStop(1, '#0d0406');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        const base = h * .8, cx = w * .5, ph = h * .46;
        s.glow += o.step * 2;
        const pulse = .6 + Math.sin(s.glow) * .2 + env.bass * .4;
        g.fillStyle = `rgba(255,110,30,${.16 * pulse})`;
        g.beginPath(); g.arc(cx, base - ph, ph * .9, 0, 7); g.fill();
        g.fillStyle = '#1b1013';
        g.beginPath(); g.moveTo(cx - ph * 1.25, base); g.lineTo(cx - ph * .2, base - ph);
        g.lineTo(cx + ph * .2, base - ph); g.lineTo(cx + ph * 1.25, base); g.closePath(); g.fill();
        g.fillStyle = `rgba(255,${Math.round(90 + pulse * 90)},20,.95)`;
        g.fillRect(cx - ph * .2, base - ph, ph * .4, 3);
        // lava runs
        for (let i = -2; i <= 2; i++) {
          g.strokeStyle = `rgba(255,${Math.round(70 + pulse * 80)},20,.85)`;
          g.lineWidth = Math.max(1, 2 - Math.abs(i) * .4);
          g.beginPath(); g.moveTo(cx + i * 3, base - ph + 2);
          for (let y = base - ph + 2; y < base; y += 5)
            g.lineTo(cx + i * (3 + (y - base + ph) * .28) + Math.sin(y * .3 + i) * 2, y);
          g.stroke();
        }
        g.fillStyle = '#0d0406'; g.fillRect(0, base, w, h - base);
        for (const e of s.embers) {
          e.y -= e.v * o.speed * o.step * .18 * (1 + env.level);
          e.x += Math.sin(t * 1.4 + e.s * 9) * .0012 * o.speed;
          if (e.y < -.05) { e.y = 1.02; e.x = s.r(); }
          g.fillStyle = `rgba(255,${Math.round(120 + e.s * 110)},40,${.35 + e.s * .6})`;
          g.fillRect((e.x * w) | 0, (e.y * h) | 0, 1, e.s > .8 ? 2 : 1);
        }
      },
    },

    ocean: {
      label: 'Ocean · horizon', cat: 'biome',
      init(r, w, h, density) {
        const n = Math.round(lerp(5, 16, density));
        return { r, rows: Array.from({ length: n }, (_, i) => ({ p: r() * 6.28, k: .05 + r() * .06 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h * .5);
        sky.addColorStop(0, '#20124a'); sky.addColorStop(.6, '#e0576b'); sky.addColorStop(1, '#ffb463');
        g.fillStyle = sky; g.fillRect(0, 0, w, h * .5);
        const hz = h * .5;
        if (o.bg !== false) {
          g.fillStyle = '#ffe9a8';
          g.beginPath(); g.arc(w * .5, hz - 4, 14 + env.bass * 7, 0, 7); g.fill();
        }
        const sea = g.createLinearGradient(0, hz, 0, h);
        sea.addColorStop(0, '#1b3f77'); sea.addColorStop(1, '#071a38');
        if (o.bg !== false) { g.fillStyle = sea; g.fillRect(0, hz, w, h - hz); }
        s.rows.forEach((row, i) => {
          const f = (i + 1) / s.rows.length;
          const y = hz + f * f * (h - hz);
          const amp = 1 + f * 4 * (1 + env.level);
          g.fillStyle = `rgba(255,220,150,${.5 - f * .3})`;
          for (let x = 0; x < w; x += 3) {
            const dy = Math.sin(x * row.k + t * (1 + f * 2) + row.p) * amp;
            const near = Math.abs(x - w / 2) < w * (.06 + f * .22);
            if (near || (x + i) % 9 === 0) g.fillRect(x, y + dy, 2 + f * 3, Math.max(1, f * 2));
          }
        });
      },
    },

    highway: {
      label: 'Highway · night drive', cat: 'racing',
      init(r, w, h, density) {
        const n = Math.round(lerp(6, 22, density));
        return { r, z: 0,
          lights: Array.from({ length: n }, () => ({ d: r(), side: r() > .5, c: r() })),
          city: Array.from({ length: 26 }, () => ({ w: 4 + r() * 12, h: .05 + r() * .16, lit: r() })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h * .52);
        sky.addColorStop(0, '#08061c'); sky.addColorStop(1, '#3b1050');
        const hz = h * .52;
        if (o.bg !== false) g.fillStyle = sky, g.fillRect(0, 0, w, hz);
        let cx0 = 0;
        for (const b of (o.bg !== false ? s.city : [])) {
          const bh = b.h * h;
          g.fillStyle = '#120a20'; g.fillRect(cx0, hz - bh, b.w, bh);
          if (b.lit > .5) {
            g.fillStyle = 'rgba(255,210,63,.75)';
            for (let wy = hz - bh + 2; wy < hz - 2; wy += 4) g.fillRect(cx0 + 1, wy, 1, 2);
          }
          cx0 += b.w + 2;
          if (cx0 > w) break;
        }
        if (o.bg !== false) { g.fillStyle = '#0a0812'; g.fillRect(0, hz, w, h - hz); }
        s.z += o.speed * o.step * (1.4 + env.level * 2);
        for (let y = hz; y < h; y++) {
          const f = (y - hz) / (h - hz);
          const wid = w * (.05 + f * .8), cx = w / 2;
          g.fillStyle = '#1a1a20'; g.fillRect(cx - wid / 2, y, wid, 1);
          if (((f * 8 + s.z) % 1) < .45) { g.fillStyle = '#e8e4d8'; g.fillRect(cx - Math.max(1, wid * .012), y, Math.max(1, wid * .025), 1); }
        }
        for (const L of s.lights) {
          const f = ((L.d + s.z * .25) % 1) ** 2;
          const y = hz + f * (h - hz), wid = w * (.05 + f * .8);
          const x = w / 2 + (L.side ? 1 : -1) * (wid / 2 + 4 + f * 10);
          const r = Math.max(1, f * 3);
          g.fillStyle = L.c > .5 ? 'rgba(255,210,63,.9)' : 'rgba(255,60,60,.9)';
          g.fillRect(x - r / 2, y - 8 - f * 14, r, r);
          g.fillStyle = L.c > .5 ? 'rgba(255,210,63,.18)' : 'rgba(255,60,60,.18)';
          g.fillRect(x - r * 2, y - 9 - f * 14, r * 4, r * 3);
        }
      },
    },

    oasis: {
      label: 'Oasis · palms', cat: 'biome', solid: true,
      init(r, w, h, density) {
        const n = Math.round(lerp(2, 7, density));
        return { r, off: 0, palms: Array.from({ length: n }, () => ({ x: r() * 1.4, s: .6 + r() * .8, lean: (r() - .5) * .5, d: .4 + r() * .6 })) };
      },
      draw(g, w, h, t, env, s, o) {
        const sky = g.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, '#1e3d8f'); sky.addColorStop(.5, '#7fc4e8'); sky.addColorStop(.72, '#ffe0a8');
        if (o.bg !== false) { g.fillStyle = sky; g.fillRect(0, 0, w, h); }
        g.fillStyle = '#fff8d0';
        g.beginPath(); g.arc(w * .72, h * .22, 11 + env.bass * 6, 0, 7); g.fill();
        const base = h * .74;
        g.fillStyle = '#d9b978'; g.fillRect(0, base, w, h - base);
        // water, with a shimmering reflection band
        g.fillStyle = '#2a7fa8'; g.fillRect(0, h * .84, w, h * .16);
        for (let i = 0; i < 7; i++) {
          const y = h * .85 + i * (h * .022);
          g.fillStyle = `rgba(190,235,255,${.5 - i * .05})`;
          for (let x = 0; x < w; x += 4)
            if ((x + i * 3 + Math.floor(Math.sin(x * .08 + t * 1.6 + i) * 3)) % 8 < 3) g.fillRect(x, y, 3, 1);
        }
        s.off += o.speed * o.step * 4;
        for (const pm of s.palms) {
          const x = (((pm.x * w - s.off * pm.d) % (w * 1.4)) + w * 1.4) % (w * 1.4);
          if (x > w + 24) continue;
          const th = h * .3 * pm.s, sway = Math.sin(t * 1.1 + pm.x * 8) * .1 + pm.lean;
          g.strokeStyle = '#6b4a26'; g.lineWidth = Math.max(1, 2 * pm.s);
          g.beginPath(); g.moveTo(x, base);
          for (let k = 0; k <= 8; k++) {
            const f = k / 8;
            g.lineTo(x + Math.sin(f * 1.2) * th * sway, base - f * th);
          }
          g.stroke();
          const tx = x + Math.sin(1.2) * th * sway, ty = base - th;
          g.fillStyle = '#2f7a3a';
          for (let k = 0; k < 6; k++) {
            const a = -Math.PI / 2 + (k - 2.5) * .52 + sway * .5;
            g.save(); g.translate(tx, ty); g.rotate(a);
            g.beginPath(); g.ellipse(0, -7 * pm.s, 2.5 * pm.s, 9 * pm.s, 0, 0, 7); g.fill();
            g.restore();
          }
        }
      },
    },
  };

  window.NeoScene = { SCENES, CATS, CHARS, drawChar, rng, randomSeed };
})();
