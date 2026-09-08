/* Local audio encoding. The bundled LGPL encoder is loaded only for MP3 export. */
(() => {
  'use strict';
  let encoderReady;
  function loadEncoder() {
    if (window.lamejs) return Promise.resolve();
    return encoderReady ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/lame-1.2.1.min.js';
      script.onload = () => window.lamejs ? resolve() : reject(new Error('MP3 encoder unavailable.'));
      script.onerror = () => { encoderReady = null; script.remove(); reject(new Error('Could not load the MP3 encoder. Please retry.')); };
      document.head.append(script);
    });
  }
  const pcm = value => Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
  async function mp3(buffer, quality, progress = () => {}) {
    await loadEncoder();
    const encoder = new lamejs.Mp3Encoder(2, buffer.sampleRate, quality);
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1), chunks = [];
    const block = 1152;
    for (let offset = 0; offset < buffer.length; offset += block) {
      const size = Math.min(block, buffer.length - offset), l = new Int16Array(size), r = new Int16Array(size);
      for (let i = 0; i < size; i++) { l[i] = pcm(left[offset + i]); r[i] = pcm(right[offset + i]); }
      const data = encoder.encodeBuffer(l, r);
      if (data.length) chunks.push(new Uint8Array(data));
      if (offset % (block * 32) === 0) { progress(offset / buffer.length); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    const end = encoder.flush(); if (end.length) chunks.push(new Uint8Array(end));
    progress(1);
    return new Blob(chunks, { type: 'audio/mpeg' });
  }
  function wav(buffer) {
    const bytes = new ArrayBuffer(44 + buffer.length * 4), view = new DataView(bytes);
    const text = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 4, true);
    view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, buffer.length * 4, true);
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    for (let i = 0; i < buffer.length; i++) { view.setInt16(44 + i * 4, pcm(left[i]), true); view.setInt16(46 + i * 4, pcm(right[i]), true); }
    return new Blob([bytes], { type: 'audio/wav' });
  }
  window.NeoExport = { mp3, wav };
})();
