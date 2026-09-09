/* Chip sound effects.
 *
 * The same four voices the Audio Studio imitates - pulse, triangle, noise -
 * driven by short envelopes. Sounds are generated, never loaded, so they cost
 * nothing to ship and travel inside a packaged game like everything else.
 */
(() => {
  'use strict';

  // Each effect is a tiny score: waveform, pitch path, length and level.
  const SFX = {
    jump:       { type: 'square', duty: .5,  from: 330, to: 620, time: .12, gain: .16, slide: 'up' },
    doubleJump: { type: 'square', duty: .25, from: 440, to: 780, time: .11, gain: .14, slide: 'up' },
    coin:       { type: 'square', duty: .5,  from: 988, to: 1319, time: .09, gain: .13, step: true },
    gem:        { type: 'square', duty: .25, from: 784, to: 1568, time: .16, gain: .14, step: true },
    key:        { type: 'triangle', from: 523, to: 1046, time: .2, gain: .2, step: true },
    hurt:       { type: 'square', duty: .5,  from: 320, to: 90, time: .28, gain: .18, slide: 'down' },
    kill:       { type: 'noise',  from: 1, to: 0, time: .16, gain: .22 },
    shoot:      { type: 'square', duty: .125, from: 720, to: 240, time: .07, gain: .10, slide: 'down' },
    spring:     { type: 'triangle', from: 220, to: 880, time: .18, gain: .2, slide: 'up' },
    checkpoint: { type: 'triangle', from: 660, to: 990, time: .22, gain: .18, step: true },
    win:        { type: 'square', duty: .5, chord: [523, 659, 784, 1046], time: .5, gain: .16 },
    lose:       { type: 'square', duty: .5, chord: [392, 330, 262, 196], time: .6, gain: .16 },
    land:       { type: 'noise', from: 1, to: 0, time: .05, gain: .08 },
    break:      { type: 'noise', from: 1, to: 0, time: .12, gain: .16 },
  };

  let ctx = null, master = null, noiseBuf = null, muted = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = .7; master.connect(ctx.destination);
      // one second of fixed noise, seeded so a game sounds the same everywhere
      const len = ctx.sampleRate;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let a = 0x2545f491;
      for (let i = 0; i < len; i++) {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        d[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
      }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function play(name, volume = 1) {
    if (muted) return;
    const s = SFX[name];
    if (!s || !ensure()) return;
    const now = ctx.currentTime, g = ctx.createGain();
    g.gain.setValueAtTime(s.gain * volume, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + s.time);
    g.connect(master);

    if (s.type === 'noise') {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass'; filt.frequency.setValueAtTime(1800, now);
      filt.frequency.exponentialRampToValueAtTime(300, now + s.time);
      src.connect(filt).connect(g); src.start(now); src.stop(now + s.time);
      return;
    }
    if (s.chord) {
      // an arpeggio rather than a chord, which is what a chip would do
      const step = s.time / s.chord.length;
      s.chord.forEach((f, i) => {
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = 'square'; o.frequency.setValueAtTime(f, now + i * step);
        og.gain.setValueAtTime(0, now);
        og.gain.setValueAtTime(s.gain * volume, now + i * step);
        og.gain.exponentialRampToValueAtTime(0.0001, now + i * step + step * .95);
        o.connect(og).connect(master);
        o.start(now + i * step); o.stop(now + i * step + step);
      });
      return;
    }
    const o = ctx.createOscillator();
    o.type = s.type === 'triangle' ? 'triangle' : 'square';
    o.frequency.setValueAtTime(s.from, now);
    if (s.step) {
      // stepped pitch reads as chip; a smooth glide reads as a modern synth
      o.frequency.setValueAtTime(s.from, now);
      o.frequency.setValueAtTime(s.to, now + s.time * .45);
    } else {
      o.frequency.exponentialRampToValueAtTime(Math.max(20, s.to), now + s.time);
    }
    o.connect(g); o.start(now); o.stop(now + s.time + .02);
  }

  window.NeoSfx = {
    play, ensure,
    get muted() { return muted; },
    set muted(v) { muted = !!v; },
    setVolume(v) { if (ensure()) master.gain.value = Math.max(0, Math.min(1, v)); },
    names: Object.keys(SFX),
  };
})();
