/* ============================================================
   NEO術 — MIDI import
   Parse a Standard MIDI File and squeeze it onto four chip voices:
   the three busiest melodic parts become Pulse 1 (highest), Pulse 2,
   Triangle (lowest); channel 10 becomes Noise. Quantised to 16ths,
   durations kept as ties, capped at 16 bars.
   ============================================================ */
(() => {
  'use strict';
  const TIE = -1, MIN_MIDI = 36, MAX_MIDI = 84, MAX_BARS = 16;

  function parse(bytes) {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    const u32 = () => { const v = d.getUint32(pos); pos += 4; return v; };
    const u16 = () => { const v = d.getUint16(pos); pos += 2; return v; };
    const u8 = () => bytes[pos++];
    const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
    if (String.fromCharCode(...bytes.slice(0, 4)) !== 'MThd') throw new Error('Not a MIDI file');
    pos = 4; const hlen = u32(); const fmt = u16(), ntracks = u16(), tpq = u16(); pos = 8 + hlen;
    if (tpq & 0x8000) throw new Error('SMPTE timing is not supported');
    const notes = [];            // { t, dur, pitch, vel, ch, track }
    let tempo = null;
    for (let tr = 0; tr < ntracks && pos < bytes.length; tr++) {
      if (String.fromCharCode(...bytes.slice(pos, pos + 4)) !== 'MTrk') break;
      pos += 4; const len = u32(); const end = pos + len;
      let tick = 0, status = 0; const open = {};
      while (pos < end) {
        tick += vlq();
        let b = u8();
        if (b === 0xff) { const type = u8(), l = vlq(); if (type === 0x51 && tempo == null) tempo = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2]; pos += l; continue; }
        if (b === 0xf0 || b === 0xf7) { pos += vlq(); continue; }
        if (b & 0x80) status = b; else pos--;
        const kind = status & 0xf0, ch = status & 0x0f;
        if (kind === 0x90 || kind === 0x80) {
          const pitch = u8(), vel = u8();
          const key = ch * 128 + pitch;
          if (kind === 0x90 && vel > 0) { if (open[key]) close(open[key], tick); open[key] = { t: tick, pitch, vel, ch, track: tr }; }
          else if (open[key]) { close(open[key], tick); delete open[key]; }
        } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) pos += 2;
        else if (kind === 0xc0 || kind === 0xd0) pos += 1;
      }
      for (const k in open) close(open[k], tick);
      pos = end;
    }
    function close(n, tick) { n.dur = Math.max(1, tick - n.t); notes.push(n); }
    return { fmt, tpq, notes, bpm: tempo ? Math.round(60000000 / tempo) : 120 };
  }

  const fold = (m) => { while (m > MAX_MIDI) m -= 12; while (m < MIN_MIDI) m += 12; return m; };

  // Turn parsed notes into a Studio pattern. opts: { chip, startBar }
  function toPattern(parsed, opts = {}) {
    const { tpq, notes } = parsed;
    const tick16 = tpq / 4;
    const startStep = (opts.startBar || 0) * 16;
    const q = (n) => ({ s: Math.round(n.t / tick16) - startStep, len: Math.max(1, Math.round(n.dur / tick16)), pitch: n.pitch, vel: n.vel, ch: n.ch, track: n.track });
    const all = notes.map(q).filter((n) => n.s >= 0);
    if (!all.length) throw new Error('No notes found');
    const drumsIn = all.filter((n) => n.ch === 9);
    const melodic = all.filter((n) => n.ch !== 9);
    // group by track+channel, rank by note count, keep the three busiest
    const groups = {};
    for (const n of melodic) (groups[`${n.track}:${n.ch}`] ||= []).push(n);
    const ranked = Object.values(groups).sort((a, b) => b.length - a.length).slice(0, 3);
    ranked.sort((a, b) => avg(b) - avg(a));      // highest part first
    const lastStep = Math.max(...all.map((n) => n.s + n.len));
    const bars = Math.max(1, Math.min(MAX_BARS, Math.ceil(lastStep / 16)));
    const steps = bars * 16;
    const lane = () => Array(steps).fill(null);
    const p = { steps, bpm: Math.max(80, Math.min(220, parsed.bpm)), chip: opts.chip || 'nes', p1: lane(), p2: lane(), tr: lane(), no: lane() };
    const names = ['p1', 'p2', 'tr'];
    // With fewer than three parts, put the lowest in the triangle anyway
    const slots = ranked.length === 1 ? ['p1'] : ranked.length === 2 ? ['p1', 'tr'] : names;
    ranked.forEach((g, i) => fill(p[slots[i]], g, slots[i] === 'tr' ? 'low' : 'high', steps));
    for (const n of drumsIn) { if (n.s >= steps) continue; const k = drumKind(n.pitch); if (k && (!p.no[n.s] || k === 'k')) p.no[n.s] = k; }
    return { pattern: p, parts: ranked.length, drums: drumsIn.length > 0, truncated: lastStep > steps };
  }
  function avg(g) { return g.reduce((a, n) => a + n.pitch, 0) / g.length; }
  // monophonic squeeze: one note per step, prefer the highest (lead) or lowest (bass); keep durations as ties
  function fill(arr, notes, prefer, steps) {
    const best = {};
    for (const n of notes) {
      if (n.s >= steps) continue;
      const cur = best[n.s];
      if (!cur || (prefer === 'high' ? n.pitch > cur.pitch : n.pitch < cur.pitch)) best[n.s] = n;
    }
    const starts = Object.keys(best).map(Number).sort((a, b) => a - b);
    starts.forEach((s, i) => {
      const n = best[s], next = starts[i + 1] ?? steps;
      arr[s] = fold(n.pitch);
      const len = Math.min(n.len, next - s, 16);
      for (let k = 1; k < len; k++) arr[s + k] = TIE;
    });
  }
  function drumKind(gm) {
    if ([35, 36, 41, 43, 45, 47].includes(gm)) return 'k';        // kicks and low toms
    if ([37, 38, 39, 40, 48, 49, 50, 52, 55, 57].includes(gm)) return 's'; // snares, claps, crashes
    if ([42, 44, 46, 51, 53, 54, 56, 59, 69, 70].includes(gm)) return 'h'; // hats, rides, shakers
    return null;
  }

  window.NeoMidi = { parse, toPattern };
})();
