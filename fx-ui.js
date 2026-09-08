/* ============================================================
   NEO術 — effects rack UI
   One draggable window per unit. Each has a screen showing what the
   effect is actually doing, drawn in a chunky 8-bit style, plus
   segmented dials and per-dial motion.

   Window positions live in localStorage (a per-browser preference).
   Effect values live in the pattern, so they save, share and export.
   ============================================================ */
(() => {
  'use strict';

  const POS_KEY = 'neojutsu.fxwindows.v1';
  const SEGMENTS = 14;                       // blocks around a dial
  const SPEC = () => window.NeoRack.SPEC;

  let hooks = { get: () => ({}), commit: () => {}, preview: () => {}, probe: () => null, bpm: () => 150 };
  const windows = new Map();
  let zTop = 40, rafOn = false;

  // ------------------------------------------------------------ value curves
  // Frequency dials travel in octaves, which is how ears hear them.
  const norm = (p, v) => p.curve === 'log'
    ? Math.log(Math.max(p.min, v) / p.min) / Math.log(p.max / p.min)
    : (v - p.min) / (p.max - p.min);
  const denorm = (p, t) => p.curve === 'log'
    ? p.min * Math.pow(p.max / p.min, Math.max(0, Math.min(1, t)))
    : p.min + Math.max(0, Math.min(1, t)) * (p.max - p.min);

  function format(p, v) {
    if (p.unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : Math.round(v) + '';
    const dp = (p.max - p.min) > 40 ? 0 : (p.max - p.min) > 4 ? 1 : 2;
    return v.toFixed(dp);
  }

  // ------------------------------------------------------------ dials
  function makeDial(spec, getValue, onInput, onCommit) {
    const wrap = document.createElement('div');
    wrap.className = 'dial';
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('class', 'dial-face');
    svg.setAttribute('role', 'slider');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', spec.label);
    svg.setAttribute('aria-valuemin', spec.min);
    svg.setAttribute('aria-valuemax', spec.max);

    const A0 = -125, A1 = 125;
    const segs = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const r = document.createElementNS(ns, 'rect');
      const a = A0 + (i / (SEGMENTS - 1)) * (A1 - A0);
      r.setAttribute('x', 30.5); r.setAttribute('y', 4);
      r.setAttribute('width', 3); r.setAttribute('height', 8);
      r.setAttribute('transform', `rotate(${a} 32 32)`);
      r.setAttribute('class', 'dial-seg');
      svg.append(r); segs.push(r);
    }
    const body = document.createElementNS(ns, 'rect');
    body.setAttribute('x', 18); body.setAttribute('y', 18);
    body.setAttribute('width', 28); body.setAttribute('height', 28);
    body.setAttribute('class', 'dial-body');
    const nib = document.createElementNS(ns, 'rect');
    nib.setAttribute('class', 'dial-nib');
    nib.setAttribute('x', 30); nib.setAttribute('y', 20);      // straight up; rotated about the centre
    nib.setAttribute('width', 4); nib.setAttribute('height', 11);
    svg.append(body, nib);

    const label = document.createElement('span'); label.className = 'dial-label'; label.textContent = spec.label;
    const readout = document.createElement('span'); readout.className = 'dial-value';
    wrap.append(svg, label, readout);

    function render() {
      const v = getValue(), t = norm(spec, v);
      const lit = Math.round(t * (SEGMENTS - 1));
      segs.forEach((r, i) => r.classList.toggle('on', i <= lit));
      nib.setAttribute('transform', `rotate(${A0 + t * (A1 - A0)} 32 32)`);
      readout.textContent = format(spec, v) + (spec.unit && spec.unit !== 'Hz' ? spec.unit : spec.unit === 'Hz' ? 'Hz' : '');
      svg.setAttribute('aria-valuenow', v.toFixed(2));
    }

    let dragging = false, startY = 0, startT = 0;
    svg.addEventListener('pointerdown', (e) => {
      dragging = true; startY = e.clientY; startT = norm(spec, getValue());
      svg.setPointerCapture(e.pointerId); wrap.classList.add('turning'); e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const travel = e.shiftKey ? 600 : 170;
      onInput(denorm(spec, startT + (startY - e.clientY) / travel)); render();
    });
    const end = () => { if (!dragging) return; dragging = false; wrap.classList.remove('turning'); onCommit(); };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', () => { onInput(spec.def); onCommit(); render(); });
    svg.addEventListener('keydown', (e) => {
      const stepT = e.shiftKey ? 0.005 : 0.04;
      let t = norm(spec, getValue());
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') t += stepT;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') t -= stepT;
      else if (e.key === 'Home') t = 0; else if (e.key === 'End') t = 1;
      else return;
      e.preventDefault(); onInput(denorm(spec, t)); onCommit(); render();
    });

    wrap.render = render; render();
    return wrap;
  }

  // ------------------------------------------------------------ motion
  function makeMotion(fxId, key) {
    const box = document.createElement('div');
    box.className = 'motion';
    const R = window.NeoRack.RATES, S = window.NeoRack.SHAPES;
    box.innerHTML = `
      <button class="motion-toggle" type="button" aria-pressed="false" title="Sweep this dial in time with the track">◠ MOTION</button>
      <div class="motion-body" hidden>
        <select class="m-shape" aria-label="Motion shape">${Object.entries(S).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <select class="m-bars" aria-label="Motion rate">${Object.entries(R).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input class="m-depth" type="range" min="0" max="100" value="50" aria-label="Motion depth">
      </div>`;
    const toggle = box.querySelector('.motion-toggle'), body = box.querySelector('.motion-body');
    const shape = box.querySelector('.m-shape'), bars = box.querySelector('.m-bars'), depth = box.querySelector('.m-depth');
    const read = () => (hooks.get()[fxId]?.motion || {})[key] || null;
    function write(m) {
      const fx = hooks.get()[fxId]; fx.motion = fx.motion || {};
      if (m) fx.motion[key] = m; else delete fx.motion[key];
      hooks.commit(); sync();
    }
    function sync() {
      const m = read();
      toggle.setAttribute('aria-pressed', String(!!m));
      toggle.classList.toggle('on', !!m);
      body.hidden = !m;
      if (m) { shape.value = m.shape; bars.value = String(m.bars); depth.value = Math.round(m.depth * 100); }
      box.closest('.dial-cell')?.classList.toggle('has-motion', !!m);
    }
    toggle.addEventListener('click', () => write(read() ? null : { shape: 'sine', bars: 1, depth: 0.5 }));
    for (const el of [shape, bars, depth]) el.addEventListener('input', () =>
      write({ shape: shape.value, bars: +bars.value, depth: +depth.value / 100 }));
    box.sync = sync; sync();
    return box;
  }

  // ------------------------------------------------------------ screens
  const PX = 2;                                    // logical pixel size, for the chunky look
  const SCREENS = {
    eq(g, w, h, fx, probe, id) {
      const fMin = 30, fMax = 18000, dbMax = 20;
      const xOf = (f) => Math.log(f / fMin) / Math.log(fMax / fMin) * w;
      const yOf = (db) => h / 2 - (db / dbMax) * (h / 2 - 6);
      // live spectrum behind the curve
      if (probe && probe.spectrumSize) {
        const bins = new Uint8Array(probe.spectrumSize);
        if (probe.spectrum(bins)) {
          const nyquist = probe.sampleRate / 2;
          g.fillStyle = 'rgba(46,242,255,.16)';
          for (let x = 0; x < w; x += PX) {
            const f = fMin * Math.pow(fMax / fMin, x / w);
            const bin = Math.min(bins.length - 1, Math.round(f / nyquist * bins.length));
            const v = bins[bin] / 255;
            const bh = Math.round(v * h * 0.8 / PX) * PX;
            g.fillRect(x, h - bh, PX, bh);
          }
        }
      }
      // grid
      g.fillStyle = 'rgba(139,92,246,.18)';
      for (const f of [100, 1000, 10000]) g.fillRect(Math.round(xOf(f)), 0, 1, h);
      g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(0, Math.round(h / 2), w, 1);
      // curve, drawn as blocks
      if (probe && probe.eqResponse) {
        const n = Math.floor(w / PX);
        const freqs = new Float32Array(n);
        for (let i = 0; i < n; i++) freqs[i] = fMin * Math.pow(fMax / fMin, (i * PX) / w);
        const db = probe.eqResponse(freqs);
        g.fillStyle = fx.on ? '#2ef2ff' : '#4b5563';
        for (let i = 0; i < n; i++) {
          const y = Math.round(yOf(db[i]) / PX) * PX;
          g.fillRect(i * PX, Math.max(0, Math.min(h - PX, y)), PX, PX * 2);
        }
      }
      // band handles
      window.NeoRack.SPEC.eq.bands.forEach((b) => {
        const x = Math.round(xOf(fx['f' + b.n])), y = Math.round(yOf(fx['g' + b.n]));
        g.fillStyle = fx.on ? '#ffd23f' : '#4b5563';
        g.fillRect(x - 5, y - 5, 10, 10);
        g.fillStyle = '#07060c';
        g.font = 'bold 9px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(b.n), x, y + 1);
      });
    },

    comp(g, w, h, fx, probe) {
      const lo = -60, hi = 0;
      const xOf = (db) => (db - lo) / (hi - lo) * (w - 46);
      const yOf = (db) => h - 8 - (db - lo) / (hi - lo) * (h - 16);
      g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, yOf(lo)); g.lineTo(xOf(hi), yOf(hi)); g.stroke();   // unity
      // transfer curve with soft knee
      g.fillStyle = fx.on ? '#ff9f43' : '#4b5563';
      for (let x = 0; x < w - 46; x += PX) {
        const inDb = lo + x / (w - 46) * (hi - lo);
        const over = inDb - fx.threshold;
        let outDb;
        if (over <= -fx.knee / 2) outDb = inDb;
        else if (over >= fx.knee / 2) outDb = fx.threshold + over / fx.ratio;
        else { const t = over + fx.knee / 2; outDb = inDb + ((1 / fx.ratio - 1) * t * t) / (2 * fx.knee); }
        outDb += fx.makeup;
        const y = Math.round(yOf(Math.min(hi, outDb)) / PX) * PX;
        g.fillRect(x, Math.max(0, Math.min(h - PX, y)), PX, PX);
      }
      // threshold marker
      g.fillStyle = 'rgba(255,210,63,.55)';
      g.fillRect(Math.round(xOf(fx.threshold)), 0, 1, h);
      // gain-reduction meter, segmented
      const gr = probe ? Math.abs(probe.reduction()) : 0;
      const segs = 14, lit = Math.min(segs, Math.round(gr / 24 * segs));
      const x0 = w - 34;
      g.font = '7px monospace'; g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillStyle = 'rgba(154,146,179,.9)'; g.fillText('GR', x0, 2);
      for (let i = 0; i < segs; i++) {
        const on = fx.on && i < lit;
        g.fillStyle = on ? (i > segs - 4 ? '#ff2e88' : i > segs - 8 ? '#ffd23f' : '#5eff8f') : 'rgba(255,255,255,.07)';
        g.fillRect(x0, 12 + i * ((h - 20) / segs), 22, (h - 20) / segs - 2);
      }
      g.fillStyle = 'rgba(236,232,245,.9)'; g.textAlign = 'right';
      g.fillText(gr.toFixed(1) + 'dB', w - 2, h - 9);
    },

    phaser(g, w, h, fx, probe, id, t) {
      const notches = 4;
      for (let i = 0; i < notches; i++) {
        const sweep = Math.sin(t * fx.rate * Math.PI * 2 + i * 0.5) * (fx.depth / 100);
        const x = Math.round((0.15 + 0.7 * ((i + 1) / (notches + 1) + sweep * 0.35)) * w / PX) * PX;
        g.fillStyle = fx.on ? 'rgba(139,92,246,.9)' : 'rgba(75,85,99,.6)';
        for (let y = 0; y < h; y += PX * 2) {
          const dip = Math.exp(-Math.pow((y - h / 2) / (h / 3), 2));
          g.globalAlpha = 0.25 + dip * 0.75;
          g.fillRect(x, y, PX * 3, PX);
        }
      }
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(255,255,255,.08)';
      for (let x = 0; x < w; x += PX * 6) g.fillRect(x, h - PX, PX * 3, PX);
    },

    flanger(g, w, h, fx, probe, id, t) {
      const sweep = (Math.sin(t * fx.rate * Math.PI * 2) * 0.5 + 0.5) * (fx.depth / 100);
      const teeth = 6 + Math.round(sweep * 14);
      for (let i = 0; i < teeth; i++) {
        const x = Math.round((i / teeth) * w / PX) * PX;
        const bh = Math.round((h * 0.75) * (1 - i / teeth) / PX) * PX;
        g.fillStyle = fx.on ? `rgba(94,255,143,${0.35 + 0.5 * (1 - i / teeth)})` : 'rgba(75,85,99,.5)';
        g.fillRect(x, h - bh - 4, Math.max(PX, w / teeth - PX * 2), bh);
      }
    },

    crush(g, w, h, fx) {
      const levels = Math.pow(2, fx.on ? fx.bits : 16);
      g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(0, Math.round(h / 2), w, 1);
      g.fillStyle = fx.on ? '#ffd23f' : '#4b5563';
      for (let x = 0; x < w; x += PX) {
        const s = Math.sin(x / w * Math.PI * 4);
        const q = fx.on ? Math.round(s * levels / 2) / (levels / 2) : s;
        const y = Math.round((h / 2 - q * (h / 2 - 6)) / PX) * PX;
        g.fillRect(x, y, PX, PX * 2);
      }
      g.font = '8px monospace'; g.textAlign = 'right'; g.textBaseline = 'bottom';
      g.fillStyle = 'rgba(236,232,245,.85)';
      g.fillText(`${fx.on ? Math.round(fx.bits) : 16} BIT`, w - 3, h - 3);
    },

    reverb(g, w, h, fx, probe, id, t) {
      const taps = Math.round(fx.size * 12);
      for (let i = 0; i < taps; i++) {
        const decay = Math.pow(1 - i / taps, 2);
        const x = Math.round((i / taps) * w / PX) * PX;
        const bh = Math.round(decay * (h - 12) / PX) * PX;
        g.fillStyle = fx.on ? `rgba(125,211,252,${0.25 + decay * 0.7})` : 'rgba(75,85,99,.4)';
        g.fillRect(x, h - 6 - bh, Math.max(PX, w / taps - PX), bh);
      }
      g.font = '8px monospace'; g.textAlign = 'left'; g.textBaseline = 'top';
      g.fillStyle = 'rgba(236,232,245,.8)'; g.fillText(`${fx.size.toFixed(1)}s`, 3, 3);
    },

    echo(g, w, h, fx, probe, id, t, bpm) {
      const beat = 60 / bpm;
      const secs = { '16': beat / 4, '8': beat / 2, '8d': beat * 0.75, '4': beat }[fx.div] || beat * 0.75;
      const span = 4;                                   // seconds shown
      let level = 1;
      for (let i = 0; i < 10; i++) {
        const at = i * secs; if (at > span) break;
        const x = Math.round(at / span * (w - 8) / PX) * PX + 2;
        const bh = Math.round(level * (h - 14) / PX) * PX;
        g.fillStyle = fx.on ? `rgba(255,46,136,${0.35 + level * 0.65})` : 'rgba(75,85,99,.4)';
        g.fillRect(x, h - 8 - bh, PX * 2, bh);
        level *= fx.feedback / 100;
        if (level < 0.02) break;
      }
      g.fillStyle = 'rgba(255,255,255,.10)'; g.fillRect(0, h - 6, w, 1);
      g.font = '8px monospace'; g.textAlign = 'right'; g.textBaseline = 'bottom';
      g.fillStyle = 'rgba(236,232,245,.8)';
      g.fillText(window.NeoRack.SPEC.echo.divisions[fx.div] || '', w - 3, h - 2);
    },

    width(g, w, h, fx, probe) {
      const size = probe ? probe.scopeSize : 0;
      const meterW = 26, corrH = 16;
      const gw = w - meterW - 6, gh = h - corrH - 4;
      const cx = gw / 2, cy = gh / 2, r = Math.min(gw, gh) / 2 - 8;

      // goniometer frame: mono is vertical, hard left and right are the diagonals
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx, cy + r); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.07)';
      g.beginPath();
      g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r);
      g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r);
      g.stroke();
      g.font = '7px monospace'; g.fillStyle = 'rgba(154,146,179,.85)';
      g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('L', 3, 3);
      g.textAlign = 'right'; g.fillText('R', gw - 3, 3);
      g.textAlign = 'center'; g.fillText('M', cx, 3);

      if (!size) return;
      const l = new Uint8Array(size), rr = new Uint8Array(size);
      if (!probe.stereo(l, rr)) return;

      // trace, plus running sums for correlation and peaks
      let sll = 0, srr = 0, slr = 0, peakL = 0, peakR = 0;
      g.fillStyle = fx.on ? '#f472b6' : '#6b7280';
      for (let i = 0; i < size; i++) {
        const a = (l[i] - 128) / 128, b = (rr[i] - 128) / 128;
        sll += a * a; srr += b * b; slr += a * b;
        if (Math.abs(a) > peakL) peakL = Math.abs(a);
        if (Math.abs(b) > peakR) peakR = Math.abs(b);
        if (i % 2) continue;
        const x = cx + (a - b) / 2 * r * 1.45;              // side
        const y = cy - (a + b) / 2 * r * 1.45;              // mid
        g.fillRect(Math.round(x / PX) * PX, Math.round(y / PX) * PX, PX, PX);
      }

      // L and R peak meters
      const bars = 12;
      [['L', peakL, 0], ['R', peakR, 1]].forEach(([name, peak, col]) => {
        const x = gw + 6 + col * (meterW / 2);
        const lit = Math.round(Math.min(1, peak) * bars);
        for (let i = 0; i < bars; i++) {
          const on = fx.on !== undefined && i < lit;
          g.fillStyle = on ? (i > bars - 3 ? '#ff2e88' : i > bars - 6 ? '#ffd23f' : '#5eff8f') : 'rgba(255,255,255,.07)';
          g.fillRect(x, 12 + (bars - 1 - i) * ((gh - 16) / bars), meterW / 2 - 3, (gh - 16) / bars - 2);
        }
        g.fillStyle = 'rgba(154,146,179,.9)'; g.font = '7px monospace';
        g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(name, x, 2);
      });

      // correlation: +1 mono-safe, 0 wide, -1 will cancel in mono
      const corr = (sll > 1e-9 && srr > 1e-9) ? slr / Math.sqrt(sll * srr) : 1;
      const y0 = h - corrH + 2, barW = w - 30;
      g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(0, y0, barW, 8);
      const mid = barW / 2;
      const px = Math.round(mid + corr * mid);
      g.fillStyle = corr < 0 ? '#ff2e88' : corr < 0.35 ? '#ffd23f' : '#5eff8f';
      g.fillRect(Math.min(px, mid), y0, Math.max(2, Math.abs(px - mid)), 8);
      g.fillStyle = 'rgba(255,255,255,.3)'; g.fillRect(Math.round(mid), y0 - 2, 1, 12);
      g.font = '7px monospace'; g.textBaseline = 'top';
      g.fillStyle = 'rgba(154,146,179,.9)'; g.textAlign = 'left'; g.fillText('-1', 0, y0 + 9);
      g.textAlign = 'right'; g.fillStyle = 'rgba(236,232,245,.95)';
      g.fillText('CORR ' + corr.toFixed(2), w - 2, y0 + 9);
    },
  };

  // ------------------------------------------------------------ windows
  const loadPositions = () => { try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch { return {}; } };
  function savePosition(id, pos) {
    const all = loadPositions(); all[id] = pos;
    try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch {}
  }

  function buildWindow(id) {
    const spec = SPEC()[id];
    const el = document.createElement('section');
    el.className = `fx-window theme-${spec.theme}`;
    el.dataset.fx = id; el.hidden = true;
    el.innerHTML = `
      <header class="fx-title">
        <span class="fx-kanji">${spec.kanji}</span>
        <h3>${spec.label}</h3>
        <button class="fx-power" type="button" aria-pressed="false" aria-label="Turn ${spec.label} on"><span class="led"></span>ON</button>
        <button class="fx-close" type="button" aria-label="Close ${spec.label}">✕</button>
      </header>
      <div class="fx-screen-wrap"><canvas class="fx-screen" width="384" height="${id === 'width' ? 150 : 128}" aria-label="${spec.label} display"></canvas></div>
      <p class="fx-blurb">${spec.blurb}</p>
      <div class="fx-dials"></div>`;

    const dials = el.querySelector('.fx-dials');
    const cells = [];
    if (spec.divisions) {
      const cell = document.createElement('div');
      cell.className = 'dial-cell wide';
      cell.innerHTML = `<label class="fx-select">TIME <select class="fx-div">${Object.entries(spec.divisions).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`;
      const sel = cell.querySelector('.fx-div');
      sel.addEventListener('change', () => { hooks.get()[id].div = sel.value; hooks.commit(); });
      cell.sync = () => { sel.value = hooks.get()[id].div; };
      dials.append(cell); cells.push(cell);
    }
    for (const [key, p] of Object.entries(spec.params)) {
      const cell = document.createElement('div');
      cell.className = 'dial-cell';
      const dial = makeDial(p,
        () => hooks.get()[id][key],
        (v) => { hooks.get()[id][key] = v; hooks.preview(); },
        () => hooks.commit());
      cell.append(dial);
      const motion = p.auto ? makeMotion(id, key) : null;
      if (motion) cell.append(motion);
      cell.sync = () => { dial.render(); motion && motion.sync(); };
      dials.append(cell); cells.push(cell);
    }

    el.querySelector('.fx-power').addEventListener('click', () => {
      const fx = hooks.get()[id]; fx.on = !fx.on; hooks.commit(); syncOne(id);
    });
    el.querySelector('.fx-close').addEventListener('click', () => toggleWindow(id, false));

    // drag the window by its title bar
    const header = el.querySelector('.fx-title');
    let dragging = false, dx = 0, dy = 0;
    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; focusWindow(el);
      const r = el.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top;
      header.setPointerCapture(e.pointerId); el.classList.add('dragging');
    });
    header.addEventListener('pointermove', (e) => { if (dragging) place(el, e.clientX - dx, e.clientY - dy); });
    const drop = () => {
      if (!dragging) return; dragging = false; el.classList.remove('dragging');
      savePosition(id, { x: parseFloat(el.style.left), y: parseFloat(el.style.top) });
    };
    header.addEventListener('pointerup', drop);
    header.addEventListener('pointercancel', drop);
    el.addEventListener('pointerdown', () => focusWindow(el));

    // EQ screen: drag the numbered handles
    const canvas = el.querySelector('.fx-screen');
    if (id === 'eq') attachEqDrag(canvas, cells);

    document.body.append(el);
    const rec = { el, cells, canvas, ctx: canvas.getContext('2d') };
    windows.set(id, rec);
    return rec;
  }

  function attachEqDrag(canvas, cells) {
    const fMin = 30, fMax = 18000, dbMax = 20;
    let band = 0;
    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width * canvas.width, y: (e.clientY - r.top) / r.height * canvas.height };
    };
    canvas.addEventListener('pointerdown', (e) => {
      const { x, y } = at(e), fx = hooks.get().eq;
      let best = 0, bestD = 1e9;
      window.NeoRack.SPEC.eq.bands.forEach((b) => {
        const bx = Math.log(fx['f' + b.n] / fMin) / Math.log(fMax / fMin) * canvas.width;
        const by = canvas.height / 2 - (fx['g' + b.n] / dbMax) * (canvas.height / 2 - 6);
        const d = Math.hypot(bx - x, by - y);
        if (d < bestD) { bestD = d; best = b.n; }
      });
      if (bestD > 60) return;
      band = best; canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing'); e.preventDefault();
      move(e);
    });
    function move(e) {
      if (!band) return;
      const { x, y } = at(e), fx = hooks.get().eq;
      const p = window.NeoRack.SPEC.eq.params;
      const f = fMin * Math.pow(fMax / fMin, Math.max(0, Math.min(1, x / canvas.width)));
      const gDb = (canvas.height / 2 - y) / (canvas.height / 2 - 6) * dbMax;
      fx['f' + band] = Math.max(p['f' + band].min, Math.min(p['f' + band].max, f));
      fx['g' + band] = Math.max(-18, Math.min(18, gDb));
      hooks.preview(); cells.forEach((c) => c.sync());
    }
    canvas.addEventListener('pointermove', (e) => { if (band) move(e); });
    const up = () => { if (!band) return; band = 0; canvas.classList.remove('grabbing'); hooks.commit(); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  function place(el, x, y) {
    const w = el.offsetWidth;
    el.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, x)) + 'px';
    el.style.top = Math.max(56, Math.min(window.innerHeight - 46, y)) + 'px';
  }
  const focusWindow = (el) => { el.style.zIndex = ++zTop; };

  function toggleWindow(id, show) {
    const win = windows.get(id) || buildWindow(id);
    const open = show ?? win.el.hidden;
    win.el.hidden = !open;
    if (open) {
      const saved = loadPositions()[id];
      const n = [...windows.values()].filter((w) => !w.el.hidden).length;
      place(win.el, saved?.x ?? (140 + n * 26), saved?.y ?? (100 + n * 22));
      focusWindow(win.el); syncOne(id); startLoop();
    }
    document.querySelector(`.rack-btn[data-fx="${id}"]`)?.setAttribute('aria-expanded', String(open));
  }

  function syncOne(id) {
    const win = windows.get(id); if (!win) return;
    const fx = hooks.get()[id]; if (!fx) return;
    const power = win.el.querySelector('.fx-power');
    power.setAttribute('aria-pressed', String(fx.on));
    power.classList.toggle('on', fx.on);
    win.el.classList.toggle('off', !fx.on);
    win.cells.forEach((c) => c.sync());
    document.querySelector(`.rack-btn[data-fx="${id}"]`)?.classList.toggle('lit', fx.on);
  }
  function syncAll() { for (const id of windows.keys()) syncOne(id); buildDock(); }

  // ------------------------------------------------------------ screen loop
  function startLoop() {
    if (rafOn) return; rafOn = true;
    const tick = () => {
      const open = [...windows.entries()].filter(([, w]) => !w.el.hidden);
      if (!open.length) { rafOn = false; return; }
      const probe = hooks.probe(), state = hooks.get(), t = performance.now() / 1000, bpm = hooks.bpm();
      for (const [id, win] of open) {
        const g = win.ctx, w = win.canvas.width, h = win.canvas.height;
        g.clearRect(0, 0, w, h);
        g.fillStyle = '#05040a'; g.fillRect(0, 0, w, h);
        const draw = SCREENS[SPEC()[id].screen];
        if (draw && state[id]) { g.save(); try { draw(g, w, h, state[id], probe, id, t, bpm); } catch {} g.restore(); }
        // scanlines over the top, like a CRT
        g.fillStyle = 'rgba(0,0,0,.22)';
        for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ dock
  let dockBuilt = false;
  function buildDock() {
    const dock = document.getElementById('fx-dock'); if (!dock) return;
    if (!dockBuilt) {
      dock.replaceChildren();
      for (const id of window.NeoRack.ORDER) {
        const spec = SPEC()[id];
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'rack-btn'; b.dataset.fx = id;
        b.setAttribute('aria-expanded', 'false');
        b.innerHTML = `<span class="rack-kanji">${spec.kanji}</span><span class="rack-name">${spec.label}</span><span class="rack-led"></span>`;
        b.addEventListener('click', () => toggleWindow(id));
        dock.append(b);
      }
      dockBuilt = true;
    }
    const state = hooks.get();
    for (const btn of dock.querySelectorAll('.rack-btn')) btn.classList.toggle('lit', !!state[btn.dataset.fx]?.on);
  }

  function init(options) {
    hooks = Object.assign(hooks, options);
    buildDock();
    window.addEventListener('resize', () => {
      for (const { el } of windows.values()) if (!el.hidden) place(el, parseFloat(el.style.left), parseFloat(el.style.top));
    });
  }

  window.NeoFxUI = {
    init, sync: syncAll,
    open: (id) => toggleWindow(id, true),
    closeAll: () => [...windows.keys()].forEach((id) => toggleWindow(id, false)),
  };
})();
