/* NeoJutsu generation in a Web Worker.
 *
 * Runs off the main thread on purpose. A 32-bar generation is 3,072 decode
 * steps; on the main thread that is a frozen page, a stalled audio context and
 * a browser offering to kill the tab. Here the UI keeps its 60fps and gets
 * progress messages.
 *
 * This mirrors model/sample.py step for step, including two things that look
 * like bugs and are not:
 *
 *   * voiceId() is `pos % 6` past the header, which does NOT line up with the
 *     six voice slots -- <BAR> tokens shift the phase by one each bar. It only
 *     has to match what training did, and training used this same formula, so
 *     "fixing" it here would silently break every generation.
 *   * the legal-token mask uses the loop's slot index, not `pos % 6`. Those are
 *     genuinely different quantities and both are deliberate.
 *
 * Constrained decoding means invalid patterns are unreachable rather than
 * unlikely: illegal logits go to -Infinity before the softmax, so the Studio
 * never has to coerce anything.
 */

// NOT named `ort`: ort.min.js declares its own top-level `ort` and
// importScripts shares this scope, so the two collide and the worker
// dies with "Identifier 'ort' has already been declared".
let ORT = null;
let session = null;
let vocab = null;
let cfg = null;
let precision = "fp16";

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 5.9604644775390625e-8 * f;      // subnormal
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

/* mulberry32: small, fast, and deterministic across engines, which is what
 * "the same seed gives the same track" actually requires. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Same seed -> int mapping as sample.py, so a seed named in one place means
 * the same thing in the other. (The sampled stream still differs between
 * PyTorch and JS; only the seed derivation is shared.) */
async function seedToInt(seed) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(seed)));
  const b = new Uint8Array(buf);
  return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
}

function voiceId(pos) {
  return pos < cfg.header_len ? 6 : pos % 6;
}

function emptyCache() {
  const dims = [cfg.n_layer, 1, cfg.n_head, 0, cfg.head_dim];
  const data = precision === "fp16" ? new Uint16Array(0) : new Float32Array(0);
  return new ORT.Tensor(precision === "fp16" ? "float16" : "float32", data, dims);
}

async function step(tokens, startPos, past) {
  const T = tokens.length;
  const vids = new BigInt64Array(T);
  for (let i = 0; i < T; i++) vids[i] = BigInt(voiceId(startPos + i));
  const out = await session.run({
    tokens: new ORT.Tensor("int64", BigInt64Array.from(tokens.map(BigInt)), [1, T]),
    voice_ids: new ORT.Tensor("int64", vids, [1, T]),
    past_k: past.k,
    past_v: past.v,
  });
  const raw = out.logits.data;
  const logits = new Float32Array(vocab.size);
  if (precision === "fp16") {
    for (let i = 0; i < vocab.size; i++) logits[i] = halfToFloat(raw[i]);
  } else {
    for (let i = 0; i < vocab.size; i++) logits[i] = raw[i];
  }
  return { logits, past: { k: out.present_k, v: out.present_v } };
}

/* top-p over the full masked distribution, matching sample.py: mask to
 * -Infinity, divide by temperature, softmax, then nucleus-truncate. */
function sampleToken(logits, allowed, temperature, topP, rand) {
  const n = logits.length;
  const z = new Float32Array(n).fill(-Infinity);
  for (const id of allowed) z[id] = logits[id] / Math.max(1e-6, temperature);

  let max = -Infinity;
  for (let i = 0; i < n; i++) if (z[i] > max) max = z[i];
  const p = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const e = z[i] === -Infinity ? 0 : Math.exp(z[i] - max);
    p[i] = e; sum += e;
  }
  for (let i = 0; i < n; i++) p[i] /= sum;

  const idx = Array.from(allowed).sort((a, b) => p[b] - p[a]);
  /* The nucleus EXCLUDES the token that crosses topP, which is what sample.py
   * does:
   *     cut = cum > tp        # zero everything whose inclusive cum exceeds tp
   *     cut[0] = False        # unless it is the top token
   * This used to keep that token (keep = i + 1), making the browser's nucleus
   * exactly one token wider than PyTorch's at every one of the ~770 sampling
   * steps in a generation. The logits were identical -- the parity fixture
   * proved that, and went on proving it while the two produced audibly
   * different music, because parity checks logits and never checks the sampler.
   * For a peaked distribution the extra token is systematically the next
   * unlikely option, and on the noise voice that is a drum hit: measured drum
   * density 0.68 in the browser against 0.49 in Python, and one generation in
   * four came out with a hit on all 128 steps. */
  let cum = 0, keep = idx.length;
  for (let i = 0; i < idx.length; i++) {
    cum += p[idx[i]];
    if (cum > topP) { keep = Math.max(1, i); break; }   // never drop the top one
  }
  let tot = 0;
  for (let i = 0; i < keep; i++) tot += p[idx[i]];
  let r = rand() * tot;
  for (let i = 0; i < keep; i++) {
    r -= p[idx[i]];
    if (r <= 0) return idx[i];
  }
  return idx[0];
}

function headerIds(o) {
  const S = vocab.stoi;
  const bpmBucket = (b) => {
    b = Math.max(80, Math.min(220, Math.round(b)));
    let best = vocab.choices.bpm_buckets[0];
    for (const x of vocab.choices.bpm_buckets) {
      if (Math.abs(x - b) < Math.abs(best - b)) best = x;
    }
    return best;
  };
  const need = (t) => {
    if (!(t in S)) throw new Error(`unknown conditioning token: ${t}`);
    return S[t];
  };
  const cond = (tok) => (tok === null ? vocab.special.uncond : need(tok));
  return [vocab.special.bos,
    need("<CHIP>"), need(`chip_${o.chip}`),
    need("<MOOD>"), need(`mood_${o.mood}`),
    need("<KEY>"), need(`key_${o.key}`),
    need("<SCALE>"), need(`scale_${o.scale}`),
    need("<BPM>"), need(`bpm_${bpmBucket(o.bpm)}`),
    need("<BARS>"), need(`bars_${o.bars}`),
    // null -> <UNCOND>: let the model pick, which reproduces the corpus mix
    need("<DRUMS>"), cond(o.drums ? `drums_${o.drums}` : null),
    // "unknown" is the absence of a scene, not a scene you can ask for --
    // same thing <UNCOND> already means
    need("<SCENE>"),
    cond(o.scene && o.scene !== "unknown" ? `scene_${o.scene}` : null)];
}

async function generate(opts) {
  const o = Object.assign({
    chip: "nes", mood: "unknown", key: "unknown", scale: "unknown",
    bpm: 150, bars: 8, seed: "neojutsu", temperature: 1.15, topP: 0.96,
    drumTemperature: 1.15, drumTopP: 0.92, drums: null, scene: null,
  }, opts || {});
  // The noise voice wants its own temperature. The corpus is bimodal -- 91% of
  // 8-bar chip patterns have no drums at all, and the 9% that do are dense --
  // and at one shared temperature the model splits the difference and puts
  // half-hearted percussion on everything, matching neither mode. REST_D is
  // strongly peaked, so the temperature that stops the melody playing safe is
  // enough to flatten it into a hit every few steps.
  const dTemp = o.drumTemperature == null ? o.temperature : o.drumTemperature;
  const dTopP = o.drumTopP == null ? o.topP : o.drumTopP;

  // Snap rather than throw. The UI should not offer a length the model cannot
  // do, but a hard failure here turns a wrong dropdown into a dead Generate
  // button, and the caller has no way to recover from it.
  if (!vocab.choices.bars.includes(o.bars)) {
    const legal = vocab.choices.bars.slice().sort((a, b) => a - b);
    o.bars = legal.reduce((best, b) => (b <= o.bars ? b : best), legal[0]);
  }
  const steps = o.bars * 16;
  const maxPos = 13 + vocab.voice_rows.length + o.bars + steps * 6 + 1;
  if (maxPos > cfg.context) {
    throw new Error(`${o.bars} bars needs ${maxPos} positions, past the ${cfg.context} the model was trained on`);
  }

  const rand = mulberry32(await seedToInt(o.seed));
  const ids = headerIds(o).concat(vocab.voice_rows);

  let past = { k: emptyCache(), v: emptyCache() };
  let pos = 0;
  let r = await step(ids, pos, past);
  pos += ids.length;
  past = r.past;
  let logits = r.logits;

  // The requested BPM, not the bucketed one the model was conditioned on.
  // sample.py returns the bucket because it round-trips through decode(); here
  // BPM is a playback parameter the user chose and the model never predicted,
  // so asking for 131 and being handed back 130 would be a needless surprise.
  const pattern = { steps, bpm: o.bpm, chip: o.chip };
  for (const v of vocab.voices) pattern[v] = [];
  const sounding = [false, false, false, false, false];
  let barHits = 0;                 // drum hits so far in the current bar
  const t0 = performance.now();

  for (let s = 0; s < steps; s++) {
    if (s % 16 === 0) {
      barHits = 0;
      r = await step([vocab.special.bar], pos, past);
      pos += 1; past = r.past; logits = r.logits;
    }
    for (let slot = 0; slot < 6; slot++) {
      /* DRUM_BAR_CAP, and sample.py holds the same number. The model puts a
         hit on essentially every 16th in about 10% of stage and boss
         generations, and it is not wrong to: 12% of DRUMMED corpus patterns do
         the same, because on real hardware that is a noise-channel roll.
         Through this synth at 150 bpm it is ten hits a second over everything
         and reads as garble. No temperature or top-p setting removes it --
         swept 15 combinations -- because it is a mode the corpus contains
         rather than a sampling error, so it is excluded here as a legality
         constraint, exactly like TIE. 14 of 16 leaves ordinary grooves alone:
         corpus drummed density is 0.598, and the densest thing this still
         permits is 0.88. */
      const allowed = slot === 5
        ? (barHits >= 14 ? [vocab.special.rest_d] : vocab.drum_ids)
        : (sounding[slot] ? vocab.melodic_ids : vocab.melodic_no_tie);
      const tok = sampleToken(logits, allowed,
        slot === 5 ? dTemp : o.temperature,
        slot === 5 ? dTopP : o.topP, rand);

      const name = vocab.vocab[tok];
      const v = vocab.voices[slot];
      if (slot === 5) {
        if (name !== "REST_D") barHits += 1;
        pattern[v].push(name === "REST_D" ? null : name.slice(2));
      } else if (name === "REST") {
        pattern[v].push(null); sounding[slot] = false;
      } else if (name === "TIE") {
        pattern[v].push(vocab.tie_value);
      } else {
        pattern[v].push(parseInt(name.slice(1), 10)); sounding[slot] = true;
      }

      r = await step([tok], pos, past);
      pos += 1; past = r.past; logits = r.logits;
    }
    if (s % 8 === 7 || s === steps - 1) {
      self.postMessage({ type: "progress", done: s + 1, total: steps });
    }
  }
  return { pattern, ms: Math.round(performance.now() - t0) };
}

/* Does this browser's runtime agree with PyTorch? Asked on load, not assumed.
 * A WebGPU driver that quietly gets attention wrong would otherwise show up as
 * "the model sounds worse in Chrome" and be nearly impossible to trace. */
async function parityCheck(parity) {
  let past = { k: emptyCache(), v: emptyCache() };
  let r = await step(parity.prefix, 0, past);
  let pos = parity.prefix.length;
  past = r.past;
  let worst = 0;
  for (let i = 0; i < parity.path.length; i++) {
    const ref = parity.logits[i];
    for (let j = 0; j < ref.length; j++) {
      worst = Math.max(worst, Math.abs(ref[j] - r.logits[j]));
    }
    r = await step([parity.path[i]], pos, past);
    pos += 1; past = r.past;
  }
  return worst;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      importScripts(msg.ortUrl);
      ORT = self.ort;
      if (msg.wasmPath) ORT.env.wasm.wasmPaths = msg.wasmPath;
      // Threads, when the page is cross-origin isolated. Defaulting to 1 was
      // costing most of the generation time: every one of the ~768 decode
      // steps ran on a single core. crossOriginIsolated is the browser's own
      // answer to 'is SharedArrayBuffer usable', so ask it rather than guess.
      // TWO, measured, not all of them. Benchmarked on 4 bars:
      //   1 thread  8190 ms    2 threads 7168 ms
      //   4 threads 7185 ms    8 threads 7832 ms
      // Decoding is one token at a time through small matrices, so past two
      // threads the synchronisation costs more than the parallelism returns.
      // An earlier 'use every core' default was slower than doing nothing.
      const cores = (self.navigator && navigator.hardwareConcurrency) || 2;
      ORT.env.wasm.numThreads = msg.threads
        || (self.crossOriginIsolated ? Math.min(2, Math.max(1, cores)) : 1);
      ORT.env.wasm.simd = true;

      const [vres, mres, pres] = await Promise.all([
        fetch(msg.vocabUrl).then((x) => x.json()),
        fetch(msg.metaUrl).then((x) => x.json()),
        msg.parityUrl ? fetch(msg.parityUrl).then((x) => x.json()) : null,
      ]);
      vocab = vres;
      vocab.stoi = {};
      vocab.vocab.forEach((t, i) => { vocab.stoi[t] = i; });
      cfg = mres;
      precision = msg.precision || "fp16";

      // WebGPU where it exists, wasm where it does not. Falling back rather
      // than failing matters: Safari and Firefox still ship WebGPU unevenly.
      const eps = msg.ep ? [msg.ep] : ["webgpu", "wasm"];
      let lastErr = null;
      for (const ep of eps) {
        try {
          // modelData when the caller fetched the weights itself (so it could
          // show download progress); modelUrl when it did not care.
          const opts = {executionProviders: [ep], graphOptimizationLevel: "all"};
          // Cloudflare caps static assets at 25 MiB, so the fp16 weights ship
          // as several files referenced by the graph. ORT needs each one's
          // `path` to match the location string recorded inside the graph.
          if (msg.externalData && msg.externalData.length) {
            opts.externalData = msg.externalData.map((e) => ({
              path: e.path, data: new Uint8Array(e.data),
            }));
          }
          session = await ORT.InferenceSession.create(
            msg.modelData ? new Uint8Array(msg.modelData) : msg.modelUrl, opts);
          self.postMessage({ type: "ready", ep, precision,
            threads: ORT.env.wasm.numThreads,
            isolated: !!self.crossOriginIsolated });
          lastErr = null;
          break;
        } catch (e) { lastErr = e; session = null; }
      }
      if (!session) throw lastErr || new Error("no execution provider available");

      if (pres) {
        const worst = await parityCheck(pres);
        self.postMessage({ type: "parity", worst, ok: worst < (msg.parityTol || 0.05) });
      }
    } else if (msg.type === "generate") {
      const out = await generate(msg.opts);
      self.postMessage({ type: "result", pattern: out.pattern, ms: out.ms, id: msg.id });
    }
  } catch (e) {
    self.postMessage({ type: "error", error: String(e && e.stack || e), id: msg.id });
  }
};
