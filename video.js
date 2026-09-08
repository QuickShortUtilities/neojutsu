/* NeoJutsu Video Studio: turn imported footage into 8-bit video and score it
   with a track made in the Audio Studio. Everything runs on the device. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SETTINGS_KEY = 'neojutsu.video.v1';
  const SAVED_KEY = 'neojutsu.saved';
  const DRAFT_KEY = 'neojutsu.draft.v1';

  // Output palettes keyed to the same hardware names the Audio Studio uses, so a
  // track and the picture it scores can share one machine.
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
    none:   null,
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
  let sourceReady = false, raf = 0, objectURL = '';
  let audio = null, gain = null, trackNode = null, elementNode = null, recorderDest = null;
  let buffer = null, audioStartedAt = 0, savedTracks = [];

  const look = () => ({
    chip: $('v-chip').value,
    res: $('v-res').value,
    pix: +$('v-pix').value,
    dither: $('v-dither').value,
    dithAmt: +$('v-dith').value / 100,
    bright: +$('v-bright').value,
    contrast: +$('v-contrast').value,
    scanlines: $('v-scanlines').checked,
    loop: $('v-loop').checked,
    audioSrc: $('v-audio-src').value,
    vol: +$('v-vol').value / 100,
    fps: +$('v-fps').value,
    scale: +$('v-scale').value,
    title: $('v-title').value,
  });

  function baseSize(cfg) {
    if (cfg.res !== 'auto') { const [w, h] = cfg.res.split('x').map(Number); return [w, h]; }
    return (PALETTES[cfg.chip] || PALETTES.gameboy).size;
  }

  // ---------- the 8-bit pipeline ----------
  // Downscale, push through brightness/contrast, dither, then snap every pixel to
  // the hardware palette. Small buffers keep this comfortably real-time.
  function processFrame(cfg) {
    const [bw, bh] = baseSize(cfg);
    const rw = Math.max(1, Math.round(bw / cfg.pix)), rh = Math.max(1, Math.round(bh / cfg.pix));
    if (low.width !== rw || low.height !== rh) { low.width = rw; low.height = rh; }
    if (display.width !== bw || display.height !== bh) { display.width = bw; display.height = bh; }

    lctx.imageSmoothingEnabled = true;
    lctx.drawImage(video, 0, 0, rw, rh);

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
    dctx.clearRect(0, 0, bw, bh);
    dctx.drawImage(low, 0, 0, bw, bh);
    if (cfg.scanlines) {
      dctx.fillStyle = 'rgba(0,0,0,.22)';
      for (let y = 0; y < bh; y += 2) dctx.fillRect(0, y, bw, 1);
    }
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!sourceReady) return;
    processFrame(look());
    const d = video.duration || 0;
    if (d) {
      $('v-scrub').value = Math.round((video.currentTime / d) * 1000);
      $('v-position').textContent = clock(video.currentTime);
    }
  }

  // ---------- audio ----------
  function ctx() {
    if (!audio) {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      gain = audio.createGain(); gain.connect(audio.destination);
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  function stopTrack() {
    if (trackNode) { try { trackNode.stop(); } catch {} trackNode.disconnect(); trackNode = null; }
  }

  async function loadSoundtrack(cfg) {
    stopTrack(); buffer = null;
    video.muted = cfg.audioSrc !== 'original';
    if (cfg.audioSrc === 'none' || cfg.audioSrc === 'original') return;
    const track = savedTracks.find(t => t.id === cfg.audioSrc);
    if (!track) return;
    status('Rendering the soundtrack…');
    try {
      buffer = await window.NeoChip.render(track.pattern, { tail: true });
      status(`Soundtrack: ${track.name}`);
    } catch (e) { status('That track could not be rendered.'); }
  }

  function startAudio(cfg) {
    const ac = ctx();
    gain.gain.value = cfg.vol;
    if (cfg.audioSrc === 'original') {
      if (!elementNode) { elementNode = ac.createMediaElementSource(video); elementNode.connect(gain); }
      return;
    }
    if (!buffer) return;
    stopTrack();
    trackNode = ac.createBufferSource();
    trackNode.buffer = buffer; trackNode.loop = true;
    trackNode.connect(gain);
    if (recorderDest) trackNode.connect(recorderDest);
    trackNode.start(0, video.currentTime % buffer.duration);
    audioStartedAt = ac.currentTime;
  }

  // ---------- saved tracks from the Audio Studio ----------
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

  // ---------- source ----------
  function openFile(file) {
    if (!file || !file.type.startsWith('video/')) { status('That file is not a video.'); return; }
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(file);
    video.src = objectURL;
    video.onloadedmetadata = () => {
      sourceReady = true;
      display.classList.remove('idle');
      $('v-empty').hidden = true;
      $('v-scrub').disabled = false;
      $('v-meta').textContent = `${video.videoWidth}×${video.videoHeight} · ${clock(video.duration)}`;
      $('v-source-note').textContent = `${file.name} · stays on your device`;
      video.currentTime = 0;
      processFrame(look());
      save();
    };
    video.onerror = () => status('That video could not be decoded by this browser.');
  }

  // ---------- transport ----------
  function setPlaying(on) {
    $('v-play').setAttribute('aria-pressed', String(on));
    $('v-play-icon').textContent = on ? '■' : '▶';
    $('v-play-label').textContent = on ? 'Stop' : 'Play';
  }
  async function play() {
    if (!sourceReady) { status('Load a video first.'); return; }
    const cfg = look();
    ctx();
    if (!buffer && cfg.audioSrc !== 'none' && cfg.audioSrc !== 'original') await loadSoundtrack(cfg);
    video.loop = cfg.loop;
    await video.play();
    startAudio(cfg);
    setPlaying(true);
  }
  function stop() { video.pause(); stopTrack(); setPlaying(false); }
  const toggle = () => (video.paused ? play() : stop());

  // ---------- export ----------
  async function exportVideo() {
    if (!sourceReady) { status('Load a video first.'); return; }
    if (typeof MediaRecorder === 'undefined') { status('This browser cannot record video.'); return; }
    const cfg = look(), [bw, bh] = baseSize(cfg);
    const out = document.createElement('canvas');
    out.width = bw * cfg.scale; out.height = bh * cfg.scale;
    const octx = out.getContext('2d'); octx.imageSmoothingEnabled = false;

    const ac = ctx();
    recorderDest = ac.createMediaStreamDestination();
    if (cfg.audioSrc === 'original' && elementNode) elementNode.connect(recorderDest);

    const stream = out.captureStream(cfg.fps);
    stop(); video.currentTime = 0;
    await loadSoundtrack(cfg);
    startAudio(cfg);
    if (recorderDest.stream.getAudioTracks().length) stream.addTrack(recorderDest.stream.getAudioTracks()[0]);

    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6e6 } : undefined);
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);

    const paint = () => {
      octx.drawImage(display, 0, 0, out.width, out.height);
      if (rec.state === 'recording') requestAnimationFrame(paint);
    };
    const done = new Promise(res => { rec.onstop = res; });

    video.loop = false;
    rec.start(250); paint();
    await video.play(); setPlaying(true);
    status('Recording… this runs in real time.');
    await new Promise(res => { video.onended = res; });
    rec.stop(); stop(); await done;

    const blob = new Blob(chunks, { type: type || 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(cfg.title || 'neojutsu-video').replace(/[^\w.-]+/g, '-')}.webm`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status(`Exported ${a.download} · ${(blob.size / 1048576).toFixed(1)} MB`);
    recorderDest = null;
  }

  // ---------- settings ----------
  const status = msg => { $('v-status').textContent = msg; };
  const FIELDS = ['v-chip','v-res','v-pix','v-dither','v-dith','v-bright','v-contrast','v-fps','v-scale','v-vol','v-title','v-audio-src'];
  function save() {
    const data = { look: look() };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); $('v-autosave').textContent = 'Autosaved on this browser'; }
    catch { $('v-autosave').textContent = 'Autosave unavailable'; }
  }
  function restore() {
    try {
      const d = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); if (!d || !d.look) return;
      const l = d.look;
      $('v-chip').value = l.chip ?? 'gameboy'; $('v-res').value = l.res ?? 'auto';
      $('v-pix').value = l.pix ?? 1; $('v-dither').value = l.dither ?? 'bayer4';
      $('v-dith').value = Math.round((l.dithAmt ?? .6) * 100); $('v-bright').value = l.bright ?? 0;
      $('v-contrast').value = l.contrast ?? 15; $('v-scanlines').checked = !!l.scanlines;
      $('v-loop').checked = l.loop !== false; $('v-fps').value = l.fps ?? 30;
      $('v-scale').value = l.scale ?? 4; $('v-vol').value = Math.round((l.vol ?? .8) * 100);
      if (l.title) $('v-title').value = l.title;
    } catch {}
  }
  function syncLabels() {
    const l = look();
    $('v-pix-v').textContent = l.pix; $('v-dith-v').textContent = Math.round(l.dithAmt * 100);
    $('v-bright-v').textContent = l.bright; $('v-contrast-v').textContent = l.contrast;
    $('v-scale-v').textContent = l.scale; $('v-vol-v').textContent = Math.round(l.vol * 100);
    $('v-badge').textContent = `out: 型 ${(PALETTES[l.chip] || PALETTES.gameboy).label.split(' · ')[0]}`;
    const [bw, bh] = baseSize(l);
    if (!sourceReady) { display.width = bw; display.height = bh; display.classList.add('idle'); }
    if (gain) gain.gain.value = l.vol;
  }

  // ---------- wiring ----------
  function init() {
    restore(); fillTracks(); syncLabels();

    $('v-pick').addEventListener('click', () => $('v-file').click());
    $('v-file').addEventListener('change', e => openFile(e.target.files[0]));
    const drop = $('v-drop');
    ['dragenter','dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave','drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => openFile(e.dataTransfer.files[0]));

    $('v-play').addEventListener('click', toggle);
    $('v-open-export').addEventListener('click', exportVideo);
    $('v-audio-refresh').addEventListener('click', fillTracks);
    $('v-toggle-inspector').addEventListener('click', () => {
      const open = $('v-inspector').hasAttribute('hidden');
      open ? $('v-inspector').removeAttribute('hidden') : $('v-inspector').setAttribute('hidden', '');
      $('v-toggle-inspector').setAttribute('aria-expanded', String(open));
    });

    $('v-scrub').addEventListener('input', e => {
      if (!sourceReady || !video.duration) return;
      video.currentTime = (e.target.value / 1000) * video.duration;
    });
    $('v-audio-src').addEventListener('change', async () => { stopTrack(); await loadSoundtrack(look()); if (!video.paused) startAudio(look()); save(); });
    for (const id of FIELDS) $(id).addEventListener('input', () => { syncLabels(); save(); });
    for (const id of ['v-scanlines','v-loop']) $(id).addEventListener('change', () => { video.loop = look().loop; save(); });
    video.addEventListener('ended', () => { if (!look().loop) stop(); });

    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) { e.preventDefault(); toggle(); }
    });
    window.addEventListener('storage', e => { if (e.key === SAVED_KEY) fillTracks(); });

    loop();
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
