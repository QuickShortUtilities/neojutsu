/* NeoJutsu Video Studio: stack generated scenes and your own footage in layers,
   treat the result as one machine, and score it from the Audio Studio. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SETTINGS_KEY = 'neojutsu.video.v2';
  const SAVED_KEY = 'neojutsu.saved';
  const DRAFT_KEY = 'neojutsu.draft.v1';
  const MAX_LAYERS = 4;

  const PALETTES = {
    gameboy: { label: 'Game Boy · DMG', size: [160, 144], colors: ['#0f380f','#306230','#8bac0f','#9bbc0f'] },
    nes:     { label: 'NES · 2A03', size: [256, 240], colors: ['#000000','#fcfcfc','#bcbcbc','#7c7c7c','#0000fc','#0078f8','#3cbcfc','#a4e4fc','#00b800','#b8f818','#e40058','#f87858','#f8b800','#fcfcb0','#6844fc','#d800cc'] },
    genesis: { label: 'Genesis · YM2612', size: [320, 224], colors: ['#000000','#242424','#484848','#6d6d6d','#919191','#b6b6b6','#dadada','#ffffff','#002480','#0048ff','#00b6ff','#00ff91','#248000','#ffb600','#ff2400','#b6006d'] },
    c64:     { label: 'C64 · SID', size: [320, 200], colors: ['#000000','#ffffff','#880000','#aaffee','#cc44cc','#00cc55','#0000aa','#eeee77','#dd8855','#664400','#ff7777','#333333','#777777','#aaff66','#0088ff','#bbbbbb'] },
    mono:    { label: '1-bit · Macintosh', size: [512, 342], colors: ['#000000','#ffffff'] },
  };
  const BAYER = {
    bayer4: { n: 4, m: [0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5] },
    bayer2: { n: 2, m: [0,2, 3,1] },
    none: null,
  };
  const AR = { '16:9': 16/9, '1:1': 1, '9:16': 9/16, '4:3': 4/3 };

  const rgb = hex => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
  const paletteRGB = key => (PALETTES[key] || PALETTES.gameboy).colors.map(rgb);
  const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;
  const two = n => String(Math.floor(n)).padStart(2, '0');
  const clock = s => `${two(s / 60)} : ${two(s % 60)}`;

  // ---------- state ----------
  const display = $('v-canvas'), dctx = display.getContext('2d');
  const low = document.createElement('canvas'), lctx = low.getContext('2d', { willReadFrequently: true });
  const scratch = document.createElement('canvas'), sctx = scratch.getContext('2d');
  let playing = false, lastFrame = 0, genTime = 0, metaScene = '';
  let audio = null, gain = null, analyser = null, trackNode = null, recorderDest = null;
  let buffer = null, savedTracks = [], freqData = null, waveData = null;
  let layers = [], selected = 0, rack = null;
  let timeline = { on: false, shots: [] }, shotSel = 0;

  const newLayer = (over = {}) => Object.assign({
    on: true, mode: 'generate', scene: 'skyline', seed: window.NeoScene.randomSeed(),
    speed: 1, density: .5, cut: 0, blend: 'source-over', opacity: 1, clipName: '',
  }, over);

  // Runtime-only fields hang off the layer with a leading underscore and are
  // stripped before saving, so a project stays plain JSON.
  const persistable = L => Object.fromEntries(Object.entries(L).filter(([k]) => k[0] !== '_'));

  const look = () => ({
    chip: $('v-chip').value, res: $('v-res').value, format: $('v-format').value,
    pix: +$('v-pix').value, dither: $('v-dither').value, dithAmt: +$('v-dith').value / 100,
    bright: +$('v-bright').value, contrast: +$('v-contrast').value,
    scanlines: $('v-scanlines').checked, loop: $('v-loop').checked,
    react: +$('v-react').value / 100, len: +$('v-len').value,
    audioSrc: $('v-audio-src').value, vol: +$('v-vol').value / 100,
    fps: +$('v-fps').value, scale: +$('v-scale').value, title: $('v-title').value,
    container: $('v-container').value,
    text: {
      text: $('v-text').value.trim(), pos: $('v-text-pos').value, color: $('v-text-col').value,
      size: +$('v-text-size').value / 100, shadow: $('v-text-shadow').checked,
    },
  });

  function baseSize(cfg) {
    const [w, h] = cfg.res !== 'auto' ? cfg.res.split('x').map(Number)
                                      : (PALETTES[cfg.chip] || PALETTES.gameboy).size;
    const ar = AR[cfg.format];
    return ar ? [Math.max(2, Math.round(h * ar / 2) * 2), h] : [w, h];
  }

  const liveLayers = () => layers.filter(L => L.on && (L.mode === 'generate' || L._ready));
  const ready = () => liveLayers().length > 0;
  const clipDuration = () => Math.max(0, ...layers.filter(L => L._ready).map(L => L._video.duration || 0));
  const tlTotal = () => timeline.shots.reduce((a, s) => a + s.dur, 0);
  // Which shot is on screen, and how far into it we are.
  function shotAt(t) {
    let acc = 0;
    for (let i = 0; i < timeline.shots.length; i++) {
      acc += timeline.shots[i].dur;
      if (t < acc) return i;
    }
    return timeline.shots.length - 1;
  }
  function duration(cfg) {
    if (timeline.on && timeline.shots.length) return tlTotal();
    if (buffer) return buffer.duration;
    const c = clipDuration();
    return c || cfg.len;
  }

  // ---------- audio envelope ----------
  const EMPTY = { level: 0, bass: 0, mid: 0, treble: 0, freq: [], wave: [] };
  let offlineEnv = null;
  function envelope(cfg) {
    if (offlineEnv) return offlineEnv;
    if (!analyser || !playing || !cfg.react) return EMPTY;
    analyser.getByteFrequencyData(freqData);
    analyser.getFloatTimeDomainData(waveData);
    const band = (a, b) => {
      let sum = 0; const lo = Math.floor(a * freqData.length), hi = Math.floor(b * freqData.length);
      for (let i = lo; i < hi; i++) sum += freqData[i];
      return Math.min(1, sum / ((hi - lo) * 255) * 2.2);
    };
    let rms = 0;
    for (let i = 0; i < waveData.length; i++) rms += waveData[i] * waveData[i];
    rms = Math.min(1, Math.sqrt(rms / waveData.length) * 3.2);
    const k = cfg.react;
    return { level: rms * k, bass: band(0, .08) * k, mid: band(.08, .32) * k, treble: band(.32, .8) * k, freq: freqData, wave: waveData };
  }

  // ---------- scenes ----------
  function cutOrder(seed) {
    const keys = Object.keys(window.NeoScene.SCENES), r = window.NeoScene.rng(seed + ':order');
    for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
    return keys;
  }
  function activeScene(L) {
    if (!L.cut) return L.scene;
    const order = cutOrder(L.seed || 'neojutsu');
    return order[Math.floor(genTime / L.cut) % order.length];
  }
  function ensureScene(L, key, w, h) {
    const sig = [key, L.seed, L.density.toFixed(2), w, h].join('|');
    if (sig === L._sig && L._scene) return;
    const def = window.NeoScene.SCENES[key] || Object.values(window.NeoScene.SCENES)[0];
    L._scene = def.init(window.NeoScene.rng(L.seed || 'neojutsu'), w, h, L.density);
    L._key = key; L._sig = sig;
  }

  // ---------- the pipeline ----------
  // Layers composite in full colour first. The palette snap runs ONCE at the
  // end, on the finished frame - snapping per layer would blend already-reduced
  // colours and the hardware illusion falls apart.
  function processFrame(cfg, step) {
    const [bw, bh] = baseSize(cfg);
    const rw = Math.max(1, Math.round(bw / cfg.pix)), rh = Math.max(1, Math.round(bh / cfg.pix));
    if (low.width !== rw || low.height !== rh) {
      low.width = scratch.width = rw; low.height = scratch.height = rh;
      for (const L of layers) L._sig = '';
    }
    if (display.width !== bw || display.height !== bh) { display.width = bw; display.height = bh; }

    const env = envelope(cfg);
    lctx.globalCompositeOperation = 'source-over'; lctx.globalAlpha = 1;
    lctx.fillStyle = '#000000'; lctx.fillRect(0, 0, rw, rh);

    // A shot overrides the scene on the lowest generate layer only, so overlay
    // layers carry across the cut instead of restarting with it.
    const shot = timeline.on && timeline.shots.length ? timeline.shots[shotAt(genTime)] : null;
    let baseTaken = false;
    let drew = 0, topScene = '';
    for (const L of layers) {
      if (!L.on) continue;
      if (L.mode === 'generate') {
        let key = activeScene(L);
        if (shot && !baseTaken) { key = shot.scene; baseTaken = true; }
        ensureScene(L, key, rw, rh);
        topScene = key;
        sctx.save();
        window.NeoScene.SCENES[L._key].draw(sctx, rw, rh, genTime, env, L._scene, { speed: L.speed, density: L.density, step });
        sctx.restore();
      } else if (L._ready) {
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(L._video, 0, 0, rw, rh);
      } else continue;
      lctx.globalAlpha = L.opacity;
      lctx.globalCompositeOperation = drew ? L.blend : 'source-over';
      lctx.drawImage(scratch, 0, 0);
      drew++;
    }
    lctx.globalAlpha = 1; lctx.globalCompositeOperation = 'source-over';
    if (!drew) return;

    window.NeoFX.apply(lctx, rw, rh, window.NeoVRack.evaluate(rack, genTime, env), env, genTime);
    window.NeoFX.drawText(lctx, rw, rh, shot && shot.text ? { ...cfg.text, text: shot.text } : cfg.text);

    snap(lctx, rw, rh, cfg);
    dctx.imageSmoothingEnabled = false;
    dctx.drawImage(low, 0, 0, bw, bh);
    if (cfg.scanlines) {
      dctx.fillStyle = 'rgba(0,0,0,.22)';
      for (let y = 0; y < bh; y += 2) dctx.fillRect(0, y, bw, 1);
    }
    if (topScene && topScene !== metaScene) {
      metaScene = topScene;
      $('v-meta').textContent = `${bw}×${bh} · ${liveLayers().length} layer${liveLayers().length > 1 ? 's' : ''} · ${(window.NeoScene.SCENES[topScene] || {}).label || ''}`;
    }
  }

  function frameLoop(now) {
    requestAnimationFrame(frameLoop);
    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0); lastFrame = now;
    const cfg = look();
    if (playing) {
      genTime += dt;
      const d = duration(cfg);
      if (d && genTime >= d) { cfg.loop ? (genTime = 0, seekClips(0)) : stop(); }
    }
    if (!ready()) { display.classList.add('idle'); return; }
    display.classList.remove('idle');
    processFrame(cfg, playing ? dt : 0);
    const d = duration(cfg);
    if (d) { $('v-scrub').value = Math.round((genTime / d) * 1000); $('v-position').textContent = clock(genTime); }
    if (timeline.on && timeline.shots.length) {
      const ph = $('v-tl-playhead');
      if (ph) ph.style.left = `${Math.min(100, (genTime / (tlTotal() || 1)) * 100)}%`;
      const cur = shotAt(genTime);
      const shots = $('v-tl-track').children;
      for (let i = 0; i < shots.length; i++) shots[i].classList?.toggle('playing', i === cur);
    }
  }

  // ---------- audio ----------
  function ctx() {
    if (!audio) {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      gain = audio.createGain(); gain.connect(audio.destination);
      analyser = audio.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = .72;
      gain.connect(analyser);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      waveData = new Float32Array(analyser.fftSize);
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  const stopTrack = () => { if (trackNode) { try { trackNode.stop(); } catch {} trackNode.disconnect(); trackNode = null; } };

  const firstClip = () => layers.find(L => L.on && L._ready);
  async function loadSoundtrack(cfg) {
    stopTrack(); buffer = null;
    // "The clip's own audio" follows the lowest visible clip layer; every other
    // clip stays muted so stacked footage does not pile up sound.
    for (const L of layers) if (L._video) L._video.muted = true;
    if (cfg.audioSrc === 'original') { const c = firstClip(); if (c) c._video.muted = false; syncLen(); return; }
    if (cfg.audioSrc === 'none') { syncLen(); return; }
    const track = savedTracks.find(t => t.id === cfg.audioSrc);
    if (!track) { syncLen(); return; }
    status('Rendering the soundtrack…');
    try { buffer = await window.NeoChip.render(track.pattern, { tail: true }); status(`Soundtrack: ${track.name}`); }
    catch { status('That track could not be rendered.'); }
    syncLen();
  }
  function startAudio(cfg) {
    const ac = ctx();
    gain.gain.value = cfg.vol;
    if (cfg.audioSrc === 'original') {
      const c = firstClip(); if (!c) return;
      if (!c._node) { c._node = ac.createMediaElementSource(c._video); c._node.connect(gain); }
      if (recorderDest) c._node.connect(recorderDest);
      return;
    }
    if (!buffer) return;
    stopTrack();
    trackNode = ac.createBufferSource();
    trackNode.buffer = buffer; trackNode.loop = cfg.loop;
    trackNode.connect(gain);
    if (recorderDest) trackNode.connect(recorderDest);
    trackNode.start(0, genTime % buffer.duration);
  }

  // ---------- tracks ----------
  function readTracks() {
    const out = [];
    try {
      const list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
      if (Array.isArray(list)) list.forEach((t, i) => {
        if (t && t.pattern && typeof t.name === 'string') out.push({ id: `saved:${i}`, name: t.name, pattern: t.pattern });
      });
    } catch {}
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (draft && draft.pattern) out.push({ id: 'draft', name: `${draft.title || 'Current draft'} · unsaved`, pattern: draft.pattern });
    } catch {}
    return out;
  }
  function fillTracks() {
    savedTracks = readTracks();
    const sel = $('v-audio-src'), keep = sel.value;
    sel.innerHTML = '<option value="none">Silent</option><option value="original">The clip\'s own audio</option>';
    for (const t of savedTracks) {
      const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.append(o);
    }
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'none';
    $('v-audio-note').textContent = savedTracks.length
      ? `${savedTracks.length} track${savedTracks.length > 1 ? 's' : ''} found in this browser.`
      : 'No tracks yet. Make one in the Audio Studio and it will appear here.';
    window.NeoSelect?.refreshAll?.();
  }

  // ---------- clips ----------
  function openFile(file) {
    const L = layers[selected];
    if (!file || !file.type.startsWith('video/')) { status('That file is not a video.'); return; }
    if (L._url) URL.revokeObjectURL(L._url);
    const v = L._video || document.createElement('video');
    v.playsInline = true; v.muted = true; v.loop = true;
    L._url = URL.createObjectURL(file); v.src = L._url; L._video = v;
    v.onloadedmetadata = () => { L._ready = true; L.clipName = file.name; renderLayers(); syncLabels(); save(); };
    v.onerror = () => status('That video could not be decoded by this browser.');
  }
  const seekClips = t => { for (const L of layers) if (L._ready) { try { L._video.currentTime = t % (L._video.duration || 1); } catch {} } };

  // ---------- transport ----------
  function setPlaying(on) {
    playing = on;
    $('v-play').setAttribute('aria-pressed', String(on));
    $('v-play-icon').textContent = on ? '■' : '▶';
    $('v-play-label').textContent = on ? 'Stop' : 'Play';
  }
  async function play() {
    const cfg = look();
    if (!ready()) { status('Add a layer, or load a clip.'); return; }
    ctx();
    if (!buffer && cfg.audioSrc !== 'none') await loadSoundtrack(cfg);
    for (const L of layers) if (L._ready && L.on) { try { await L._video.play(); } catch {} }
    setPlaying(true); startAudio(cfg);
  }
  function stop() { for (const L of layers) if (L._video) L._video.pause(); stopTrack(); setPlaying(false); }
  const toggle = () => (playing ? stop() : play());

  // ---------- export ----------
  const safeName = t => (t || 'neojutsu-video').replace(/[^\w.-]+/g, '-');
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status(`Exported ${name} · ${(blob.size / 1048576).toFixed(1)} MB`);
  }
  const seekTo = (v, t) => new Promise(res => {
    if (Math.abs(v.currentTime - t) < 1e-3) return res();
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    try { v.currentTime = t; } catch { done(); }
  });

  async function exportVideo() {
    const cfg = look();
    if (!ready()) { status('Nothing to export yet.'); return; }
    stop(); genTime = 0;
    await loadSoundtrack(cfg);
    const total = duration(cfg) || cfg.len;
    const [bw, bh] = baseSize(cfg);
    const out = document.createElement('canvas');
    out.width = bw * cfg.scale; out.height = bh * cfg.scale;
    const octx = out.getContext('2d'); octx.imageSmoothingEnabled = false;

    if (cfg.container === 'mp4' && window.NeoVideoExport.supported()) {
      try { await exportMp4(cfg, out, octx, total, bw, bh); return; }
      catch (e) { status(`MP4 export failed (${e.message}). Falling back to WebM…`); }
    }
    await exportWebm(cfg, out, octx, total);
  }

  // Frame-by-frame: no real-time playback, so this finishes faster than the
  // video is long and the result is deterministic for a given seed.
  async function exportMp4(cfg, out, octx, total, bw, bh) {
    const fps = cfg.fps;
    const envs = buffer ? window.NeoVideoExport.analyse(buffer, fps, total, cfg.react) : null;
    const t0 = performance.now();
    // Flat palette art with hard edges is exactly what H.264 hates, so spend
    // bits generously - chroma subsampling smears the pixel grid otherwise.
    const bitrate = Math.min(40e6, Math.max(1.2e7, Math.round(out.width * out.height * fps * 0.9)));
    const blob = await window.NeoVideoExport.encode({
      width: out.width, height: out.height, fps, total, buffer, quality: bitrate,
      onProgress: p => status(`Rendering MP4 · ${Math.round(p * 100)}%`),
      onFrame: async f => {
        genTime = f / fps;
        offlineEnv = envs ? envs[Math.min(f, envs.length - 1)] : EMPTY;
        for (const L of layers) if (L.on && L._ready) await seekTo(L._video, genTime % (L._video.duration || 1));
        processFrame(cfg, 1 / fps);
        octx.drawImage(display, 0, 0, out.width, out.height);
        return out;
      },
    });
    offlineEnv = null;
    const secs = ((performance.now() - t0) / 1000);
    download(blob, `${safeName(cfg.title)}.mp4`);
    status(`Exported ${safeName(cfg.title)}.mp4 · ${(blob.size / 1048576).toFixed(1)} MB · ${secs.toFixed(1)}s for ${Math.round(total)}s of video`);
  }

  async function exportWebm(cfg, out, octx, total) {
    if (typeof MediaRecorder === 'undefined') { status('This browser cannot record video.'); return; }
    const ac = ctx();
    recorderDest = ac.createMediaStreamDestination();
    seekClips(0);
    const stream = out.captureStream(cfg.fps);
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6e6 } : undefined);
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const stopped = new Promise(res => { rec.onstop = res; });
    let running = true;
    const paint = () => { octx.drawImage(display, 0, 0, out.width, out.height); if (running) requestAnimationFrame(paint); };
    rec.start(250); paint();
    for (const L of layers) if (L._ready && L.on) { try { await L._video.play(); } catch {} }
    setPlaying(true); startAudio(cfg);
    status(`Recording ${Math.round(total)}s… this runs in real time.`);
    await new Promise(res => setTimeout(res, total * 1000));
    running = false; rec.stop(); stop(); await stopped;
    download(new Blob(chunks, { type: type || 'video/webm' }), `${safeName(cfg.title)}.webm`);
    recorderDest = null;
  }

  // ---------- layer UI ----------
  function renderLayers() {
    const host = $('v-layers'); host.innerHTML = '';
    layers.forEach((L, i) => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (i === selected ? ' current' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === selected));
      const eye = document.createElement('button');
      eye.type = 'button'; eye.className = 'layer-eye' + (L.on ? ' on' : '');
      eye.title = L.on ? 'Hide this layer' : 'Show this layer';
      eye.textContent = L.on ? '◉' : '◌';
      eye.addEventListener('click', e => { e.stopPropagation(); L.on = !L.on; renderLayers(); save(); });
      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = L.mode === 'generate'
        ? ((window.NeoScene.SCENES[L.scene] || {}).label || L.scene).split(' · ')[0]
        : (L.clipName || 'no clip');
      const meta = document.createElement('span');
      meta.className = 'layer-meta';
      meta.textContent = i === 0 ? 'base' : (L.blend === 'source-over' ? 'over' : L.blend);
      row.append(eye, name, meta);
      row.title = L.mode === 'generate' ? 'Double-click to choose a scene' : 'Double-click to load a clip';
      row.addEventListener('click', () => { selected = i; renderLayers(); pullLayer(); syncLabels(); });
      // Double-click goes straight to whatever that layer is made of: the scene
      // grid for a generated layer, the file dialog for a clip.
      row.addEventListener('dblclick', e => {
        if (e.target.closest('.layer-eye')) return;
        selected = i; renderLayers(); pullLayer(); syncLabels();
        if (layers[i].mode === 'generate') openPicker(); else $('v-file').click();
      });
      host.append(row);
    });
    $('v-layer-del').disabled = layers.length < 2;
    $('v-layer-add').disabled = layers.length >= MAX_LAYERS;
  }
  // The layer controls edit whichever row is selected, so they have to be
  // pushed and pulled rather than read straight from the DOM.
  function pullLayer() {
    const L = layers[selected];
    $('v-mode').value = L.mode; $('v-scene').value = L.scene; $('v-seed').value = L.seed;
    $('v-speed').value = Math.round(L.speed * 100); $('v-density').value = Math.round(L.density * 100);
    $('v-cut').value = L.cut; $('v-blend').value = L.blend; $('v-opacity').value = Math.round(L.opacity * 100);
    $('v-scene-name').textContent = ((window.NeoScene.SCENES[L.scene] || {}).label || L.scene).split(' · ')[0];
    $('v-source-note').textContent = L.clipName ? `${L.clipName} · stays on your device` : 'Stays on your device. Nothing is uploaded.';
    window.NeoSelect?.refreshAll?.();
  }
  function pushLayer() {
    const L = layers[selected];
    L.mode = $('v-mode').value; L.scene = $('v-scene').value; L.seed = $('v-seed').value.trim();
    L.speed = +$('v-speed').value / 100; L.density = +$('v-density').value / 100;
    L.cut = +$('v-cut').value; L.blend = $('v-blend').value; L.opacity = +$('v-opacity').value / 100;
    L._sig = '';
    renderLayers();
  }

  // Brightness/contrast, dither, then nearest hardware colour. Shared by the
  // main render and the picker thumbnails so a preview cannot lie about the look.
  function snap(ctx, w, h, cfg) {
    const frame = ctx.getImageData(0, 0, w, h), data = frame.data;
    const pal = paletteRGB(cfg.chip), levels = pal.length;
    const contrast = (259 * (cfg.contrast + 255)) / (255 * (259 - cfg.contrast));
    const bay = BAYER[cfg.dither];
    const spread = bay ? (255 / levels) * cfg.dithAmt : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let r = data[i], g = data[i + 1], b = data[i + 2];
        r = contrast * (r - 128) + 128 + cfg.bright;
        g = contrast * (g - 128) + 128 + cfg.bright;
        b = contrast * (b - 128) + 128 + cfg.bright;
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

  // ---------- scene picker ----------
  const TILE_W = 104;
  let pickerOpen = false, pickerTiles = [], pickerRaf = 0, pickerT = 0, pickerLast = 0;

  function buildPicker() {
    const grid = $('v-picker-grid'); grid.innerHTML = ''; pickerTiles = [];
    const cfg = look(), L = layers[selected];
    const [bw, bh] = baseSize(cfg);
    const th = Math.max(24, Math.round(TILE_W * bh / bw));
    const filter = $('v-picker-search').value.trim().toLowerCase();
    for (const [key, def] of Object.entries(window.NeoScene.SCENES)) {
      if (filter && !def.label.toLowerCase().includes(filter)) continue;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'picker-tile' + (key === L.scene ? ' current' : '');
      const c = document.createElement('canvas'); c.width = TILE_W; c.height = th;
      const label = document.createElement('span'); label.textContent = def.label;
      tile.append(c, label);
      tile.addEventListener('click', () => {
        $('v-scene').value = key; pushLayer(); pullLayer(); syncLabels(); save(); closePicker();
      });
      grid.append(tile);
      pickerTiles.push({ key, ctx: c.getContext('2d', { willReadFrequently: true }), w: TILE_W, h: th,
                         state: def.init(window.NeoScene.rng(L.seed || 'neojutsu'), TILE_W, th, L.density) });
    }
  }

  function pickerLoop(now) {
    if (!pickerOpen) return;
    pickerRaf = requestAnimationFrame(pickerLoop);
    const dt = Math.min(0.1, (now - pickerLast) / 1000 || 0); pickerLast = now;
    pickerT += dt;
    const cfg = look(), env = EMPTY;
    for (const t of pickerTiles) {
      const def = window.NeoScene.SCENES[t.key];
      t.ctx.save();
      def.draw(t.ctx, t.w, t.h, pickerT, env, t.state, { speed: 1, density: layers[selected].density, step: dt });
      t.ctx.restore();
      snap(t.ctx, t.w, t.h, cfg);
    }
  }
  function openPicker() {
    pickerOpen = true; pickerT = 0; pickerLast = 0;
    $('v-picker-title').textContent = `CHOOSE A SCENE · LAYER ${selected + 1}`;
    $('v-picker').hidden = false;
    buildPicker();
    cancelAnimationFrame(pickerRaf); pickerRaf = requestAnimationFrame(pickerLoop);
  }
  function closePicker() {
    pickerOpen = false; cancelAnimationFrame(pickerRaf);
    $('v-picker').hidden = true; pickerTiles = [];
  }

  // ---------- timeline ----------
  const newShot = () => ({ dur: 4, scene: Object.keys(window.NeoScene.SCENES)[0], text: '' });

  function renderTimeline() {
    $('v-timeline').hidden = !timeline.on;
    $('v-tl-toggle').setAttribute('aria-pressed', String(timeline.on));
    $('v-tl-toggle').classList.toggle('on', timeline.on);
    if (!timeline.on) return;
    const track = $('v-tl-track'); track.innerHTML = '';
    const total = tlTotal() || 1;
    timeline.shots.forEach((sh, i) => {
      const el = document.createElement('div');
      el.className = 'tl-shot' + (i === shotSel ? ' current' : '');
      // Explicit share of the track: a shot's width is its share of the running
      // time, so the strip reads as a duration rather than a list.
      el.style.flexBasis = `${(sh.dur / total) * 100}%`;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === shotSel));
      const label = (window.NeoScene.SCENES[sh.scene] || {}).label || sh.scene;
      el.innerHTML = `<span class="tl-name">${sh.text ? sh.text.split('|')[0].trim() : label.split(' · ')[0]}</span><span class="tl-dur">${sh.dur}s</span>`;
      el.addEventListener('click', () => { shotSel = i; renderTimeline(); pullShot(); });
      track.append(el);
    });
    const head = document.createElement('div');
    head.className = 'tl-playhead'; head.id = 'v-tl-playhead';
    head.style.left = `${Math.min(100, (genTime / total) * 100)}%`;
    track.append(head);
    $('v-tl-total').textContent = `${Math.round(tlTotal())}s`;
    $('v-tl-del').disabled = timeline.shots.length < 2;
  }
  function pullShot() {
    const sh = timeline.shots[shotSel]; if (!sh) return;
    $('v-tl-scene').value = sh.scene; $('v-tl-dur').value = sh.dur;
    $('v-tl-dur-v').textContent = sh.dur; $('v-tl-text').value = sh.text;
    window.NeoSelect?.refreshAll?.();
  }
  function pushShot() {
    const sh = timeline.shots[shotSel]; if (!sh) return;
    sh.scene = $('v-tl-scene').value; sh.dur = +$('v-tl-dur').value; sh.text = $('v-tl-text').value.trim();
    $('v-tl-dur-v').textContent = sh.dur;
    renderTimeline(); syncLen(); save();
  }

  // ---------- settings ----------
  const status = msg => { $('v-status').textContent = msg; };
  const GLOBAL_FIELDS = ['v-chip','v-res','v-format','v-pix','v-dither','v-dith','v-bright','v-contrast','v-react','v-len','v-fps','v-scale','v-vol','v-title','v-container','v-text','v-text-pos','v-text-col','v-text-size'];
  const LAYER_FIELDS = ['v-mode','v-scene','v-seed','v-speed','v-density','v-cut','v-blend','v-opacity'];

  function save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ look: look(), layers: layers.map(persistable), selected, rack, timeline }));
      $('v-autosave').textContent = 'Autosaved on this browser';
    } catch { $('v-autosave').textContent = 'Autosave unavailable'; }
  }
  function restore() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch {}
    rack = window.NeoVRack.normalize(d && d.rack);
    timeline = (d && d.timeline && Array.isArray(d.timeline.shots)) ? d.timeline : { on: false, shots: [] };
    layers = (d && Array.isArray(d.layers) && d.layers.length ? d.layers : [newLayer()]).slice(0, MAX_LAYERS).map(L => newLayer(L));
    selected = Math.min(d && d.selected || 0, layers.length - 1);
    const l = d && d.look; if (!l) return;
    const set = (id, v) => { if (v !== undefined && v !== null) $(id).value = v; };
    set('v-chip', l.chip); set('v-res', l.res); set('v-format', l.format); set('v-pix', l.pix);
    set('v-dither', l.dither); set('v-dith', l.dithAmt != null ? Math.round(l.dithAmt * 100) : null);
    set('v-bright', l.bright); set('v-contrast', l.contrast); set('v-fps', l.fps); set('v-scale', l.scale);
    set('v-vol', l.vol != null ? Math.round(l.vol * 100) : null);
    set('v-react', l.react != null ? Math.round(l.react * 100) : null);
    set('v-len', l.len); set('v-title', l.title); set('v-container', l.container);
    if (l.text) { set('v-text', l.text.text); set('v-text-pos', l.text.pos); set('v-text-col', l.text.color);
      set('v-text-size', Math.round(l.text.size*100)); $('v-text-shadow').checked = l.text.shadow !== false; }
    $('v-scanlines').checked = !!l.scanlines; $('v-loop').checked = l.loop !== false;
  }
  function syncLen() {
    const cfg = look(), locked = !!buffer || clipDuration() > 0;
    $('v-len').disabled = locked;
    $('v-len-v').textContent = Math.round(duration(cfg)) || cfg.len;
    $('v-len-note').textContent = buffer ? 'Length follows the soundtrack.'
      : clipDuration() ? 'Length follows the longest clip.' : 'A soundtrack sets the length automatically.';
  }
  function syncLabels() {
    const l = look();
    $('v-pix-v').textContent = l.pix; $('v-dith-v').textContent = Math.round(l.dithAmt * 100);
    $('v-bright-v').textContent = l.bright; $('v-contrast-v').textContent = l.contrast;
    $('v-scale-v').textContent = l.scale; $('v-vol-v').textContent = Math.round(l.vol * 100);
    $('v-react-v').textContent = Math.round(l.react * 100);
    $('v-speed-v').textContent = $('v-speed').value; $('v-density-v').textContent = $('v-density').value;
    $('v-opacity-v').textContent = $('v-opacity').value;
    $('v-text-size-v').textContent = Math.round(l.text.size * 100);
    $('v-badge').textContent = `out: 型 ${(PALETTES[l.chip] || PALETTES.gameboy).label.split(' · ')[0]}`;
    const [bw, bh] = baseSize(l);
    if (!ready()) { display.width = bw; display.height = bh; }
    const L = layers[selected];
    $('v-import-block').hidden = L.mode !== 'import';
    $('v-gen-block').hidden = L.mode !== 'generate';
    $('v-empty').hidden = ready();
    $('v-scrub').disabled = !ready();
    if (gain) gain.gain.value = l.vol;
    metaScene = '';
    syncLen();
  }

  // ---------- wiring ----------
  function init() {
    const sel = $('v-scene');
    for (const [key, def] of Object.entries(window.NeoScene.SCENES)) {
      const o = document.createElement('option'); o.value = key; o.textContent = def.label; sel.append(o);
    }
    restore(); fillTracks(); renderLayers(); pullLayer();
    for (const [key, def] of Object.entries(window.NeoScene.SCENES)) {
      const o = document.createElement('option'); o.value = key; o.textContent = def.label; $('v-tl-scene').append(o);
    }
    if (!timeline.shots.length) timeline.shots = [newShot(), { ...newShot(), scene: 'grid' }];
    renderTimeline(); pullShot();
    window.NeoVRackUI.init($('v-rack-grid'), () => rack, () => save());
    syncLabels();
    window.NeoSelect?.refreshAll?.();

    $('v-pick').addEventListener('click', () => $('v-file').click());
    $('v-file').addEventListener('change', e => openFile(e.target.files[0]));
    const drop = $('v-drop');
    ['dragenter','dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave','drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => openFile(e.dataTransfer.files[0]));

    $('v-play').addEventListener('click', toggle);
    $('v-open-export').addEventListener('click', exportVideo);
    $('v-audio-refresh').addEventListener('click', fillTracks);
    $('v-dice').addEventListener('click', () => { $('v-seed').value = window.NeoScene.randomSeed(); pushLayer(); save(); });
    $('v-mutate').addEventListener('click', () => {
      const cur = $('v-seed').value.trim() || window.NeoScene.randomSeed();
      $('v-seed').value = cur.slice(0, 5) + Math.random().toString(36).slice(2, 3);
      pushLayer(); save();
    });
    $('v-layer-add').addEventListener('click', () => {
      if (layers.length >= MAX_LAYERS) return;
      layers.splice(selected + 1, 0, newLayer({ scene: 'motes', blend: 'lighter', opacity: .8 }));
      selected++; renderLayers(); pullLayer(); syncLabels(); save();
    });
    $('v-layer-del').addEventListener('click', () => {
      if (layers.length < 2) return;
      const [gone] = layers.splice(selected, 1);
      if (gone._url) URL.revokeObjectURL(gone._url);
      selected = Math.max(0, selected - 1);
      renderLayers(); pullLayer(); syncLabels(); save();
    });
    const move = dir => {
      const j = selected + dir;
      if (j < 0 || j >= layers.length) return;
      [layers[selected], layers[j]] = [layers[j], layers[selected]];
      selected = j; renderLayers(); pullLayer(); save();
    };
    $('v-scene-open').addEventListener('click', () => pickerOpen ? closePicker() : openPicker());
    $('v-picker-close').addEventListener('click', closePicker);
    $('v-picker-search').addEventListener('input', buildPicker);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && pickerOpen) closePicker(); });
    $('v-tl-toggle').addEventListener('click', () => {
      timeline.on = !timeline.on; genTime = 0; renderTimeline(); pullShot(); syncLen(); save();
    });
    $('v-tl-add').addEventListener('click', () => {
      timeline.shots.splice(shotSel + 1, 0, newShot()); shotSel++;
      renderTimeline(); pullShot(); syncLen(); save();
    });
    $('v-tl-del').addEventListener('click', () => {
      if (timeline.shots.length < 2) return;
      timeline.shots.splice(shotSel, 1); shotSel = Math.max(0, shotSel - 1);
      renderTimeline(); pullShot(); syncLen(); save();
    });
    for (const id of ['v-tl-scene','v-tl-dur','v-tl-text']) $(id).addEventListener('input', pushShot);
    $('v-layer-up').addEventListener('click', () => move(-1));
    $('v-layer-down').addEventListener('click', () => move(1));

    $('v-toggle-inspector').addEventListener('click', () => {
      const open = $('v-inspector').hasAttribute('hidden');
      open ? $('v-inspector').removeAttribute('hidden') : $('v-inspector').setAttribute('hidden', '');
      $('v-toggle-inspector').setAttribute('aria-expanded', String(open));
    });
    $('v-scrub').addEventListener('input', e => {
      const d = duration(look()); if (!d) return;
      genTime = (e.target.value / 1000) * d; seekClips(genTime);
    });
    $('v-audio-src').addEventListener('change', async () => {
      stopTrack(); await loadSoundtrack(look()); if (playing) startAudio(look()); save();
    });
    for (const id of GLOBAL_FIELDS) $(id).addEventListener('input', () => { syncLabels(); save(); });
    for (const id of LAYER_FIELDS) $(id).addEventListener('input', () => { pushLayer(); syncLabels(); save(); });
    for (const id of ['v-scanlines','v-loop','v-text-shadow']) $(id).addEventListener('change', save);

    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) { e.preventDefault(); toggle(); }
    });
    window.addEventListener('storage', e => { if (e.key === SAVED_KEY) fillTracks(); });
    requestAnimationFrame(frameLoop);
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
