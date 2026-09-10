let D = null;
let g = null;
let phase = 'idle';
let tShow = 0;
let sceneState = null;
let sceneKey = null;
let raf = 0;
let last = 0;
let low, lctx, c, dctx, FRAME;
const EMPTY = {level:0,bass:0,mid:0,treble:0,freq:[],wave:[]};

const keys = {};
window.addEventListener('keydown', e => { keys[e.key] = true; if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault(); });
window.addEventListener('keyup', e => { keys[e.key] = false; });

const p = document.getElementById('console');
for (const b of p.querySelectorAll('button')) {
  b.addEventListener('pointerdown', e => { keys[b.dataset.k] = true; e.preventDefault(); });
  b.addEventListener('pointerup', e => { keys[b.dataset.k] = false; e.preventDefault(); });
  b.addEventListener('pointerleave', e => { keys[b.dataset.k] = false; });
}

const present = () => {
  window.NeoPalette.snap(lctx, low.width, low.height, {chip:D.chip, dither:D.dither, dithAmt:.6});
  dctx.drawImage(low, 0, 0, c.width, c.height);
};

function caption(text, y) {
  lctx.save();
  const size = low.height < 100 ? 5 : 8;
  lctx.font = size + 'px "Press Start 2P", monospace';
  lctx.textAlign = 'center'; lctx.textBaseline = 'middle';
  lctx.fillStyle = '#07060c';
  for (const [dx, dy] of [[-1,-1],[-1,1],[1,-1],[1,1],[0,-2],[0,2],[-2,0],[2,0]])
    lctx.fillText(text, Math.round(low.width / 2) + dx, y + dy);
  lctx.fillStyle = '#ff2e88';
  lctx.fillText(text, Math.round(low.width / 2), y);
  lctx.restore();
}

function card(def, dt) {
  const S = window.NeoScene.SCENES[def.scene] || Object.values(window.NeoScene.SCENES)[0];
  if (sceneKey !== def.scene || !sceneState) {
    sceneState = S.init(window.NeoScene.rng(D.spec.seed || 'neojutsu'), low.width, low.height, .5);
    sceneKey = def.scene;
  }
  lctx.save();
  S.draw(lctx, low.width, low.height, tShow, EMPTY, sceneState, {speed:1, density:.5, step:dt, bg:true});
  lctx.restore();
  if (def.text) {
    const lines = def.text.split('|').map(s => s.trim());
    lctx.save();
    const size = low.height < 100 ? 5 : 8;
    lctx.font = size + 'px "Press Start 2P", monospace';
    lctx.textAlign = 'center'; lctx.textBaseline = 'middle';
    const y = low.height * 0.8;
    lines.forEach((line, i) => {
      const ly = Math.round(y - (lines.length - 1) * (size * 0.7) + i * (size * 1.4));
      lctx.fillStyle = '#07060c';
      for (const [dx, dy] of [[-1,-1],[-1,1],[1,-1],[1,1],[0,-2],[0,2],[-2,0],[2,0]])
        lctx.fillText(line, Math.round(low.width / 2) + dx, ly + dy);
      lctx.fillStyle = '#ece8f5'; lctx.fillText(line, Math.round(low.width / 2), ly);
    });
    lctx.restore();
  }
}

function frame(t) {
  raf = requestAnimationFrame(frame);
  if (!last) last = t;
  const dt = Math.min((t - last) / 1000, 0.1); last = t;
  const IN = {
    left:  keys.ArrowLeft || keys.a || keys.left,
    right: keys.ArrowRight || keys.d || keys.right,
    up:    keys.ArrowUp || keys.w || keys.up,
    down:  keys.ArrowDown || keys.s || keys.down,
    a:     keys.z || keys[" "] || keys.Enter || keys.a || keys.start || keys.select,
    b:     keys.x || keys.Shift || keys.b
  };

  if (phase === 'intro') {
    card(D.intro, dt);
    tShow -= dt;
    if (tShow <= 0 || Object.values(IN).some(v => v)) { phase = 'idle'; tShow = 0; sceneKey = null; }
    present(); return;
  } else if (phase === 'outro') {
    card(D.outro, dt);
    tShow -= dt;
    if (tShow <= 0 || Object.values(IN).some(v => v)) { phase = 'idle'; tShow = 0; sceneKey = null; }
    present(); return;
  }

  if (phase === 'game') {
    g.step(IN, dt, EMPTY);
    if (g.isOver) { phase = 'over'; tShow = 3; }
    else if (g.isWin) {
      if (D.outro) { phase = 'outro'; tShow = D.outro.secs; sceneState = null; }
      else { phase = 'win'; tShow = 4; }
    }
  } else if (phase === 'idle') {
    if (Object.values(IN).some(v => v)) { phase = 'game'; g.reset(sceneState); }
  } else {
    tShow -= dt;
    if (tShow <= 0 && Object.values(IN).some(v => v)) { phase = 'game'; g.reset(sceneState); }
  }

  g.draw(lctx, window.NeoPalette.GAME_COLORS);
  if (phase === 'idle') caption(sceneKey ? 'PLAY AGAIN' : 'PRESS START', low.height * 0.45);
  else if (phase === 'over') caption('GAME OVER', low.height * 0.45);
  else if (phase === 'win') caption('CLEAR', low.height * 0.45);
  present();
}

async function initPlayer() {
  const uid = new URLSearchParams(location.search).get('p');
  if (!uid) {
    document.getElementById('loading-msg').textContent = 'No game ID provided.';
    return;
  }

  try {
    const p = await window.NeoCloud.load(uid);
    if (!p || !p.data || !p.data.spec) throw new Error('Game not found or invalid.');
    
    // Construct D equivalent
    D = p.data;
    if (!D.chip) D.chip = 'gameboy';
    if (!D.zoom) D.zoom = 3;

    document.getElementById('t').textContent = p.title || 'NEO術 Game';
    document.getElementById('loading-msg').style.display = 'none';

    FRAME = window.NeoPalette.GAME_FRAME;
    low = document.createElement('canvas'); low.width = FRAME[0]; low.height = FRAME[1];
    lctx = low.getContext('2d', {willReadFrequently:true});
    c = document.getElementById('c'); c.width = FRAME[0]*D.zoom; c.height = FRAME[1]*D.zoom;
    dctx = c.getContext('2d'); dctx.imageSmoothingEnabled = false;

    if (D.pattern && window.NeoChip && !window.__music){
      const ac = new (window.AudioContext||window.webkitAudioContext)();
      window.NeoChip.render(D.pattern,{tail:false}).then(buf=>{
        const src=ac.createBufferSource(), gn=ac.createGain();
        gn.gain.value=.6; src.buffer=buf; src.loop=true;
        src.connect(gn).connect(ac.destination); src.start(); window.__music=src;
      }).catch(()=>{});
    }

    g = window.NeoGame.create(low, D.spec, {onFrame: present,
      onEvent: n => { if (window.NeoSfx) window.NeoSfx.play(n); }});
    
    if (D.intro) g.setScript('intro', D.intro);
    if (D.outro) g.setScript('outro', D.outro);
    
    sceneState = g.snapshot();
    
    if (D.intro && D.intro.secs > 0) {
      phase = 'intro'; tShow = D.intro.secs;
    } else {
      phase = 'idle';
    }

    raf = requestAnimationFrame(frame);

  } catch (e) {
    document.getElementById('loading-msg').textContent = 'Error: ' + e.message;
  }
}

window.addEventListener('load', () => {
  window.NeoSprites?.ready(() => {
    initPlayer();
  });
});
