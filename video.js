/* NeoJutsu Video Studio: generate 8-bit footage from a seed, or bring your own
   clip, then score it with a track made in the Audio Studio. Runs on device. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SETTINGS_KEY = 'neojutsu.video.v1';
  const SAVED_KEY = 'neojutsu.saved';
  const DRAFT_KEY = 'neojutsu.draft.v1';

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

  const rgb = hex => [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
  const paletteRGB = key => (PALETTES[key] || PALETTES.gameboy).colors.map(rgb);
  const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;
  const two = n => String(Math.floor(n)).padStart(2, '0');
  const clock = s => `${two(s / 60)} : ${two(s % 60)}`;

  // ---------- state ----------
  const video = document.createElement('video');
  video.playsInline = true; video.muted = true; video.crossOrigin = 'anonymous';
  const display = $('v-canvas'), dctx = display.getContext('2d');
  const low = document.createElement('canvas'), lctx = low.getContext('2d', { willReadFrequently: true });
  let clipReady = false, objectURL = '', playing = false, lastFrame = 0;
  let audio = null, gain = null, analyser = null, trackNode = null, elementNode = null, recorderDest = null;
  let buffer = null, savedTracks = [], freqData = null, waveData = null;
  let scene = null, sceneKey = '', sceneSig = '', genTime = 0;

  const look = () => ({
    mode: $('v-mode').value,
    chip: $('v-chip').value,
    res: $('v-res').value,
    pix: +$('v-pix').value,
    dither: $('v-dither').value,
    dithAmt: +$('v-dith').value / 100,
    bright: +$('v-bright').value,
    contrast: +$('v-contrast').value,
    scanlines: $('v-scanlines').checked,
    loop: $('v-loop').checked,
    scene: $('v-scene').value,
    seed: $('v-seed').value.trim(),
    speed: +$('v-speed').value / 100,
    density: +$('v-density').value / 100,
    react: +$('v-react').value / 100,
    len: +$('v-len').value,
    audioSrc: $('v-audio-src').value,
    vol: +$('v-vol').value / 100,
    fps: +$('v-fps').value,
    scale: +$('v-scale').value,
    title: $('v-title').value,
  });

  const baseSize = cfg => cfg.res !== 'auto'
    ? cfg.res.split('x').map(Number)
    : (PALETTES[cfg.chip] || PALETTES.gameboy).size;

  const ready = cfg => cfg.mode === 'generate' || clipReady;
  const duration = cfg => cfg.mode === 'import'
    ? (video.duration || 0)
    : (buffer ? buffer.duration : cfg.len);

  // ---------- audio envelope ----------
  // One shape for every scene: overall level plus three bands, all 0..1 and
  // already scaled by the reactivity control.
  const EMPTY = { level: 0, bass: 0, mid: 0, treble: 0, freq: [], wave: [] };
  function envelope(cfg) {
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
    return { level: rms * k, bass: band(0, .08) * k, mid: band(.08, .32) * k, treble: band(.32, .8) * k,
             freq: freqData, wave: waveData };
  }

  // ---------- scene ----------
  function ensureScene(cfg, w, h) {
    const sig = [cfg.scene, cfg.seed, cfg.density.toFixed(2), w, h].join('|');
    if (sig === sceneSig && scene) return;
    const def = window.NeoScene.SCENES[cfg.scene] || Object.values(window.NeoScene.SCENES)[0];
    scene = def.init(window.NeoScene.rng(cfg.seed || 'neojutsu'), w, h, cfg.density);
    sceneKey = cfg.scene; sceneSig = sig;
  }

  // ---------- the 8-bit pipeline ----------
  // Source (clip frame or generated scene) -> brightness/contrast -> dither ->
  // snap to the hardware palette. Both modes share every step after the source.
  function processFrame(cfg, step) {
    const [bw, bh] = baseSize(cfg);
    const rw = Math.max(1, Math.round(bw / cfg.pix)), rh = Math.max(1, Math.round(bh / cfg.pix));
    if (low.width !== rw || low.height !== rh) { low.width = rw; low.height = rh; sceneSig = ''; }
    if (display.width !== bw || display.height !== bh) { display.width = bw; display.height = bh; }

    const env = envelope(cfg);
    if (cfg.mode === 'generate') {
      ensureScene(cfg, rw, rh);
      const def = window.NeoScene.SCENES[sceneKey];
      lctx.save();
      def.draw(lctx, rw, rh, genTime, env, scene, { speed: cfg.speed, density: cfg.density, step });
      lctx.restore();
    } else {
      if (!clipReady) return;
      lctx.imageSmoothingEnabled = true;
      lctx.drawImage(video, 0, 0, rw, rh);
    }

    const frame = lctx.getImageData(0, 0, rw, rh), data = frame.data;
    const pal = paletteRGB(cfg.chip), levels = pal.length;
    const contrast = (259 * (cfg.contrast + 255)) / (255 * (259 - cfg.contrast));
    const bay = BAYER[cfg.dither];
    const spread = bay ? (255 / levels) * cfg.dithAmt : 0;

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = (y * rw + x) * 4;
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
    lctx.putImageData(frame, 0, 0);

    dctx.imageSmoothingEnabled = false;
    dctx.drawImage(low, 0, 0, bw, bh);
    if (cfg.scanlines) {
      dctx.fillStyle = 'rgba(0,0,0,.22)';
      for (let y = 0; y < bh; y += 2) dctx.fillRect(0, y, bw, 1);
    }
  }

  function frameLoop(now) {
    requestAnimationFrame(frameLoop);
    const dt = Math.min(0.1, (now - lastFrame) / 1000 || 0); lastFrame = now;
    const cfg = look();
    if (cfg.mode === 'generate' && playing) {
      genTime += dt;
      const d = duration(cfg);
      if (genTime >= d) { cfg.loop ? (genTime = 0) : stop(); }
    }
    if (!ready(cfg)) { display.classList.add('idle'); return; }
    display.classList.remove('idle');
    processFrame(cfg, playing ? dt : 0);

    const d = duration(cfg), at = cfg.mode === 'import' ? video.currentTime : genTime;
    if (d) { $('v-scrub').value = Math.round((at / d) * 1000); $('v-position').textContent = clock(at); }
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

  async function loadSoundtrack(cfg) {
    stopTrack(); buffer = null;
    video.muted = cfg.audioSrc !== 'original';
    if (cfg.audioSrc === 'none' || cfg.audioSrc === 'original') { syncLen(); return; }
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
      if (!elementNode) { elementNode = ac.createMediaElementSource(video); elementNode.connect(gain); }
      if (recorderDest) elementNode.connect(recorderDest);
      return;
    }
    if (!buffer) return;
    stopTrack();
    trackNode = ac.createBufferSource();
    trackNode.buffer = buffer; trackNode.loop = cfg.loop;
    trackNode.connect(gain);
    if (recorderDest) trackNode.connect(recorderDest);
    const at = cfg.mode === 'import' ? video.currentTime : genTime;
    trackNode.start(0, at % buffer.duration);
  }

  // ---------- tracks from the Audio Studio ----------
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
    sel.innerHTML = '<option value="none">Silent</option><option value="original">The video\'s own audio</option>';
    for (const t of savedTracks) {
      const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; sel.append(o);
    }
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'none';
    $('v-audio-note').textContent = savedTracks.length
      ? `${savedTracks.length} track${savedTracks.length > 1 ? 's' : ''} found in this browser.`
      : 'No tracks yet. Make one in the Audio Studio and it will appear here.';
    window.NeoSelect?.refreshAll?.();
  }

  // ---------- import ----------
  function openFile(file) {
    if (!file || !file.type.startsWith('video/')) { status('That file is not a video.'); return; }
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(file);
    video.src = objectURL;
    video.onloadedmetadata = () => {
      clipReady = true;
      $('v-empty').hidden = true;
      $('v-scrub').disabled = false;
      $('v-meta').textContent = `${video.videoWidth}×${video.videoHeight} · ${clock(video.duration)}`;
      $('v-source-note').textContent = `${file.name} · stays on your device`;
      video.currentTime = 0; save();
    };
    video.onerror = () => status('That video could not be decoded by this browser.');
  }

  // ---------- transport ----------
  function setPlaying(on) {
    playing = on;
    $('v-play').setAttribute('aria-pressed', String(on));
    $('v-play-icon').textContent = on ? '■' : '▶';
    $('v-play-label').textContent = on ? 'Stop' : 'Play';
  }
  async function play() {
    const cfg = look();
    if (!ready(cfg)) { status('Load a video first, or switch Footage to Generate.'); return; }
    ctx();
    if (!buffer && cfg.audioSrc !== 'none' && cfg.audioSrc !== 'original') await loadSoundtrack(cfg);
    if (cfg.mode === 'import') { video.loop = cfg.loop; await video.play(); }
    setPlaying(true);
    startAudio(cfg);
  }
  function stop() { video.pause(); stopTrack(); setPlaying(false); }
  const toggle = () => (playing ? stop() : play());

  // ---------- export ----------
  async function exportVideo() {
    const cfg = look();
    if (!ready(cfg)) { status('Nothing to export yet.'); return; }
    if (typeof MediaRecorder === 'undefined') { status('This browser cannot record video.'); return; }
    const [bw, bh] = baseSize(cfg);
    const out = document.createElement('canvas');
    out.width = bw * cfg.scale; out.height = bh * cfg.scale;
    const octx = out.getContext('2d'); octx.imageSmoothingEnabled = false;

    stop();
    const ac = ctx();
    recorderDest = ac.createMediaStreamDestination();
    if (cfg.mode === 'import') video.currentTime = 0; else genTime = 0;
    await loadSoundtrack(cfg);

    const stream = out.captureStream(cfg.fps);
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6e6 } : undefined);
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const stopped = new Promise(res => { rec.onstop = res; });

    const paint = () => { octx.drawImage(display, 0, 0, out.width, out.height); if (rec.state === 'recording') requestAnimationFrame(paint); };

    const total = duration(cfg) || cfg.len;
    rec.start(250); paint();
    if (cfg.mode === 'import') { video.loop = false; await video.play(); }
    setPlaying(true); startAudio(cfg);
    status(`Recording ${Math.round(total)}s… this runs in real time.`);

    if (cfg.mode === 'import') await new Promise(res => { video.onended = res; });
    else await new Promise(res => setTimeout(res, total * 1000));

    rec.stop(); stop(); await stopped;
    const blob = new Blob(chunks, { type: type || 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(cfg.title || 'neojutsu-video').replace(/[^\w.-]+/g, '-')}.webm`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status(`Exported ${a.download} · ${(blob.size / 1048576).toFixed(1)} MB`);
    recorderDest = null;
  }

  // ---------- settings & labels ----------
  const status = msg => { $('v-status').textContent = msg; };
  const FIELDS = ['v-chip','v-res','v-pix','v-dither','v-dith','v-bright','v-contrast','v-fps','v-scale','v-vol','v-title','v-scene','v-seed','v-speed','v-density','v-react','v-len'];

  function save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ look: look() })); $('v-autosave').textContent = 'Autosaved on this browser'; }
    catch { $('v-autosave').textContent = 'Autosave unavailable'; }
  }
  function restore() {
    try {
      const d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); const l = d && d.look; if (!l) return;
      const set = (id, v) => { if (v !== undefined && v !== null) $(id).value = v; };
      set('v-mode', l.mode); set('v-chip', l.chip); set('v-res', l.res); set('v-pix', l.pix);
      set('v-dither', l.dither); set('v-dith', l.dithAmt != null ? Math.round(l.dithAmt * 100) : null);
      set('v-bright', l.bright); set('v-contrast', l.contrast); set('v-fps', l.fps); set('v-scale', l.scale);
      set('v-vol', l.vol != null ? Math.round(l.vol * 100) : null);
      set('v-scene', l.scene); set('v-seed', l.seed);
      set('v-speed', l.speed != null ? Math.round(l.speed * 100) : null);
      set('v-density', l.density != null ? Math.round(l.density * 100) : null);
      set('v-react', l.react != null ? Math.round(l.react * 100) : null);
      set('v-len', l.len); set('v-title', l.title);
      $('v-scanlines').checked = !!l.scanlines; $('v-loop').checked = l.loop !== false;
    } catch {}
  }
  function syncLen() {
    const cfg = look();
    const locked = !!buffer;
    $('v-len').disabled = locked;
    $('v-len-v').textContent = Math.round(duration(cfg)) || cfg.len;
    $('v-len-note').textContent = locked
      ? 'Length follows the soundtrack.'
      : 'A soundtrack sets the length automatically.';
  }
  function syncLabels() {
    const l = look();
    $('v-pix-v').textContent = l.pix; $('v-dith-v').textContent = Math.round(l.dithAmt * 100);
    $('v-bright-v').textContent = l.bright; $('v-contrast-v').textContent = l.contrast;
    $('v-scale-v').textContent = l.scale; $('v-vol-v').textContent = Math.round(l.vol * 100);
    $('v-speed-v').textContent = Math.round(l.speed * 100); $('v-density-v').textContent = Math.round(l.density * 100);
    $('v-react-v').textContent = Math.round(l.react * 100);
    $('v-badge').textContent = `out: 型 ${(PALETTES[l.chip] || PALETTES.gameboy).label.split(' · ')[0]}`;
    const [bw, bh] = baseSize(l);
    if (!ready(l)) { display.width = bw; display.height = bh; }
    $('v-import-block').hidden = l.mode !== 'import';
    $('v-gen-block').hidden = l.mode !== 'generate';
    $('v-empty').hidden = ready(l);
    $('v-scrub').disabled = !ready(l);
    $('v-meta').textContent = l.mode === 'generate'
      ? `${bw}×${bh} · ${(window.NeoScene.SCENES[l.scene] || {}).label || ''}`
      : (clipReady ? `${video.videoWidth}×${video.videoHeight} · ${clock(video.duration)}` : '—');
    if (gain) gain.gain.value = l.vol;
    syncLen();
  }

  // ---------- wiring ----------
  function init() {
    const sel = $('v-scene');
    for (const [key, def] of Object.entries(window.NeoScene.SCENES)) {
      const o = document.createElement('option'); o.value = key; o.textContent = def.label; sel.append(o);
    }
    $('v-seed').value = window.NeoScene.randomSeed();
    restore(); fillTracks(); syncLabels();
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
    $('v-dice').addEventListener('click', () => { $('v-seed').value = window.NeoScene.randomSeed(); sceneSig = ''; save(); });
    $('v-mutate').addEventListener('click', () => {
      const cur = $('v-seed').value.trim() || window.NeoScene.randomSeed();
      $('v-seed').value = cur.slice(0, 5) + Math.random().toString(36).slice(2, 3);
      sceneSig = ''; save();
    });
    $('v-mode').addEventListener('change', () => { stop(); genTime = 0; syncLabels(); save(); });
    $('v-toggle-inspector').addEventListener('click', () => {
      const open = $('v-inspector').hasAttribute('hidden');
      open ? $('v-inspector').removeAttribute('hidden') : $('v-inspector').setAttribute('hidden', '');
      $('v-toggle-inspector').setAttribute('aria-expanded', String(open));
    });

    $('v-scrub').addEventListener('input', e => {
      const cfg = look(), d = duration(cfg); if (!d) return;
      const at = (e.target.value / 1000) * d;
      if (cfg.mode === 'import') video.currentTime = at; else genTime = at;
    });
    $('v-audio-src').addEventListener('change', async () => {
      stopTrack(); await loadSoundtrack(look()); if (playing) startAudio(look()); save();
    });
    for (const id of FIELDS) $(id).addEventListener('input', () => { syncLabels(); save(); });
    for (const id of ['v-scanlines','v-loop']) $(id).addEventListener('change', () => { video.loop = look().loop; save(); });
    video.addEventListener('ended', () => { if (!look().loop) stop(); });

    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) { e.preventDefault(); toggle(); }
    });
    window.addEventListener('storage', e => { if (e.key === SAVED_KEY) fillTracks(); });

    requestAnimationFrame(frameLoop);
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
