/* MP4 export for the Video Studio.

   Two wins over recording the canvas live. It writes H.264/AAC in an MP4, which
   phones and social platforms actually accept, and it renders frame by frame
   instead of in real time, so a three minute video no longer takes three
   minutes to export.

   Rendering offline means there is no live audio to listen to, so the reactive
   envelope is measured up front straight from the rendered AudioBuffer. */
(() => {
  'use strict';

  const supported = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && !!window.Mp4Muxer;

  // ---------- small radix-2 FFT, enough for an on-screen spectrum ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  const N = 512, BINS = N / 2;
  const HANN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));

  // Per-frame envelope with the same shape the live AnalyserNode produces, so
  // scenes cannot tell whether they are being previewed or exported.
  function analyse(buffer, fps, total, react) {
    const count = Math.ceil(total * fps);
    const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const sr = buffer.sampleRate, out = [];
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let f = 0; f < count; f++) {
      const start = Math.floor((f / fps) % (buffer.duration || 1) * sr);
      const wave = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const s = start + i;
        wave[i] = s < L.length ? (L[s] + R[s]) / 2 : 0;
        re[i] = wave[i] * HANN[i]; im[i] = 0;
      }
      fft(re, im);
      const freq = new Uint8Array(BINS);
      for (let i = 0; i < BINS; i++) {
        const mag = Math.hypot(re[i], im[i]) / (N / 4);
        freq[i] = Math.max(0, Math.min(255, Math.round((20 * Math.log10(mag + 1e-6) + 90) * 2.8)));
      }
      const band = (a, b) => {
        let sum = 0; const lo = Math.floor(a * BINS), hi = Math.floor(b * BINS);
        for (let i = lo; i < hi; i++) sum += freq[i];
        return Math.min(1, sum / ((hi - lo) * 255) * 2.2);
      };
      let rms = 0;
      for (let i = 0; i < N; i++) rms += wave[i] * wave[i];
      rms = Math.min(1, Math.sqrt(rms / N) * 3.2);
      out.push({ level: rms * react, bass: band(0, .08) * react, mid: band(.08, .32) * react,
                 treble: band(.32, .8) * react, freq, wave });
    }
    return out;
  }

  // ---------- muxing ----------
  async function encode({ width, height, fps, total, buffer, quality = 6e6, onFrame, onProgress }) {
    const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
    const hasAudio = !!buffer;
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      fastStart: 'in-memory',
      video: { codec: 'avc', width, height },
      ...(hasAudio ? { audio: { codec: 'aac', sampleRate: buffer.sampleRate, numberOfChannels: 2 } } : {}),
    });

    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { throw e; },
    });
    // Level 4.0 High covers every frame size the studio can output.
    encoder.configure({ codec: 'avc1.640028', width, height, bitrate: quality, framerate: fps });

    const frames = Math.round(total * fps);
    for (let f = 0; f < frames; f++) {
      const canvas = await onFrame(f);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      if (f % 8 === 0) {
        onProgress && onProgress(f / frames);
        if (encoder.encodeQueueSize > 20) await new Promise(r => setTimeout(r, 0));
        else await new Promise(r => setTimeout(r, 0));
      }
    }
    await encoder.flush(); encoder.close();

    if (hasAudio) {
      const audioEnc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: e => { throw e; },
      });
      audioEnc.configure({ codec: 'mp4a.40.2', sampleRate: buffer.sampleRate, numberOfChannels: 2, bitrate: 160000 });
      const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
      const need = Math.min(buffer.length, Math.ceil(total * buffer.sampleRate));
      const CH = 4096;
      for (let off = 0; off < need; off += CH) {
        const size = Math.min(CH, need - off);
        const planar = new Float32Array(size * 2);
        planar.set(L.subarray(off, off + size), 0);
        planar.set(R.subarray(off, off + size), size);
        const data = new AudioData({
          format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfFrames: size,
          numberOfChannels: 2, timestamp: Math.round(off / buffer.sampleRate * 1e6), data: planar,
        });
        audioEnc.encode(data); data.close();
        if ((off / CH) % 16 === 0) await new Promise(r => setTimeout(r, 0));
      }
      await audioEnc.flush(); audioEnc.close();
    }

    muxer.finalize();
    onProgress && onProgress(1);
    return new Blob([target.buffer], { type: 'video/mp4' });
  }

  window.NeoVideoExport = { supported, analyse, encode };
})();
