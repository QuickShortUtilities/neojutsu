/* NeoJutsu model engine for the Studio.
 *
 * The Studio's three kata engines are synchronous: run() calls
 * ENGINES[name](opts) and gets a pattern back on the same tick. A neural model
 * cannot be, so this wraps the worker in a promise-shaped API and leaves the
 * async handling to one small change in run().
 *
 * Loading is lazy and reported. The weights are 39 MB, which on a slow
 * connection is long enough that a silent Studio looks broken, so the download
 * is fetched here with progress rather than handed to onnxruntime to fetch
 * quietly. It happens once per session and is then served from the HTTP cache.
 *
 *   OnjutsuAI.configure({ baseUrl: "/model/" })
 *   await OnjutsuAI.load(p => showProgress(p))       // optional; generate() does it
 *   const pattern = await OnjutsuAI.generate(opts, p => showProgress(p))
 *
 * `opts` takes the Studio's own generator fields -- seed, chip, mood, key,
 * scale, bars, bpm -- so the call site does not have to translate anything.
 */
(function (global) {
  "use strict";

  /* Three builds, and which is default was decided by measurement in a real
   * browser, not by file size.
   *
   *   half   37 MB   weights stored as fp16, every computation in fp32.
   *                  Logits within 2.8e-03 of the fp32 reference, and that
   *                  error cannot compound because nothing downstream is ever
   *                  in half precision.
   *   int8   19 MB   0.39 on the logits, and it generates at 1.8x the corpus
   *                  note density. Small and wrong-ish; the last resort.
   *   fp32   73 MB   the reference. Correct and heavy.
   *
   * A true fp16 build was tried and abandoned. It measured beautifully in
   * Python -- 5.8e-06 KL, top-1 agreement on every step -- and then generated
   * at 0.16 note density against a corpus 1.42 in an actual browser, because
   * onnxruntime's CPU provider emulates fp16 by widening to fp32 and the wasm
   * kernels do not. Half-precision error compounds over hundreds of
   * autoregressive steps with a half-precision KV cache behind it.
   *
   * Cloudflare caps static assets at 25 MiB, so the weights of the larger
   * builds are split across files and reassembled through ORT's externalData.
   */
  const BUILDS = {
    half: {
      model: "onjutsu_half_split.onnx",
      weights: ["onjutsu_half_split_w0.bin", "onjutsu_half_split_w1.bin",
                "onjutsu_half_split_w2.bin"],
      io: "fp32",
    },
    int8: {model: "onjutsu_int8.onnx", weights: [], io: "fp32"},
    fp32: {model: "onjutsu.onnx", weights: [], io: "fp32"},
  };

  const cfg = {
    baseUrl: "",
    precision: "half",
    fallback: "int8",
    ep: null,
    threads: null,        // null = decide from the hardware
    temperature: 1.15,
    topP: 0.96,
    drumTemperature: 0.9,
    drumTopP: 0.95,
    drums: null,
    scene: null,
  };

  let worker = null, loading = null, ready = false, active = null, backend = null;
  let onProgress = null, pendingGen = null;
  let nextId = 1;

  /* Absolute, always. Every URL here is handed to a Worker, and a Worker
     resolves relative URLs against its OWN location, not the page's. With the
     worker in onjutsu/ and baseUrl "onjutsu/", a relative
     "vendor/ort.min.js" would resolve to onjutsu/onjutsu/vendor/... --
     a 404 with no obvious cause. */
  const url = (f) => new URL(cfg.baseUrl.replace(/\/?$/, "/") + f,
                             global.location.href).href;

  function report(stage, frac, detail) {
    if (onProgress) onProgress({stage, progress: frac, detail});
  }

  /* Fetched here rather than inside onnxruntime so the download is visible.
     A response with no content-length still works; it just cannot show a bar. */
  async function fetchOne(file, onBytes) {
    const res = await fetch(url(file));
    if (!res.ok) throw new Error(`${file}: ${res.status}`);
    const total = +res.headers.get("content-length") || 0;
    if (!res.body) return {buf: await res.arrayBuffer(), total};
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      onBytes(value.length);
    }
    const buf = new Uint8Array(got);
    let at = 0;
    for (const c of parts) { buf.set(c, at); at += c.length; }
    return {buf: buf.buffer, total: got};
  }

  /* One progress bar across the graph and every weights file, because four
     bars in a row reads as four downloads rather than one model. */
  async function fetchBuild(build) {
    const files = [build.model, ...build.weights];
    let expected = 0;
    await Promise.all(files.map(async (f) => {
      try {
        const h = await fetch(url(f), {method: "HEAD"});
        expected += +h.headers.get("content-length") || 0;
      } catch (e) { /* no HEAD, no bar; the download still works */ }
    }));
    let got = 0;
    const bump = (n) => {
      got += n;
      report("download", expected ? got / expected : null,
        expected ? `${(got / 1e6).toFixed(1)} / ${(expected / 1e6).toFixed(0)} MB`
                 : `${(got / 1e6).toFixed(1)} MB`);
    };
    const model = await fetchOne(build.model, bump);
    const weights = [];
    for (const w of build.weights) {
      const r = await fetchOne(w, bump);
      weights.push({path: w, data: r.buf});
    }
    return {model: model.buf, weights};
  }

  function spawn(build, data) {
    return new Promise((resolve, reject) => {
      const w = new Worker(url("onjutsu.worker.js"));
      let settled = false;
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "ready") {
          settled = true;
          // {ep, threads, isolated} -- worth surfacing, because "slow" almost
          // always means wasm on one core rather than the model being heavy
          backend = m;
          resolve(w);
        } else if (m.type === "parity") {
          // Surfaced, not thrown: a browser whose numbers drift still makes
          // music, and refusing to generate would be the worse failure.
          if (!m.ok && global.console) {
            console.warn("NeoJutsu: this runtime disagrees with the reference by "
              + m.worst.toExponential(2) + "; output may differ.");
          }
        } else if (m.type === "progress") {
          if (pendingGen) report("generate", m.done / m.total, `step ${m.done}/${m.total}`);
        } else if (m.type === "result") {
          if (pendingGen && pendingGen.id === m.id) {
            const g = pendingGen; pendingGen = null;
            g.resolve({pattern: m.pattern, ms: m.ms});
          }
        } else if (m.type === "error") {
          if (pendingGen) { const g = pendingGen; pendingGen = null; g.reject(new Error(m.error)); }
          else if (!settled) { w.terminate(); reject(new Error(m.error)); }
          else if (global.console) console.error("NeoJutsu worker:", m.error);
        }
      };
      w.onerror = (e) => { if (!settled) { w.terminate(); reject(new Error(e.message || "worker failed")); } };

      const transfer = [data.model, ...data.weights.map((x) => x.data)];
      w.postMessage({
        type: "init",
        ortUrl: url("vendor/ort.min.js"),
        wasmPath: url("vendor/"),
        modelData: data.model,
        externalData: data.weights,
        vocabUrl: url("vocab.json"),
        metaUrl: url("model_meta.json"),
        parityUrl: url("parity.json"),
        precision: build.io,
        ep: cfg.ep,
        threads: cfg.threads,
      }, transfer);
    });
  }

  function load(progress) {
    if (ready) return Promise.resolve();
    if (loading) { if (progress) onProgress = progress; return loading; }
    if (progress) onProgress = progress;

    loading = (async () => {
      // fp16 first, int8 if anything about the split goes wrong. The fallback
      // costs a second download, but only in the case where the alternative
      // was no music at all.
      const order = [cfg.precision];
      if (cfg.fallback && cfg.fallback !== cfg.precision) order.push(cfg.fallback);
      let lastErr = null;
      for (const name of order) {
        const build = BUILDS[name];
        if (!build) continue;
        try {
          const data = await fetchBuild(build);
          report("compile", null, "preparing model");
          worker = await spawn(build, data);
          active = name;
          ready = true;
          report("ready", 1, `model ready · ${name} · `
        + `${backend && backend.ep}`
        + (backend && backend.threads > 1 ? ` · ${backend.threads} threads`
                                          : " · 1 thread"));
          return;
        } catch (e) {
          lastErr = e;
          if (global.console) console.warn(`NeoJutsu: ${name} build failed`, e);
          if (worker) { worker.terminate(); worker = null; }
        }
      }
      throw lastErr || new Error("no usable model build");
    })().catch((e) => { loading = null; ready = false; throw e; });

    return loading;
  }

  async function generate(opts, progress) {
    if (progress) onProgress = progress;
    await load(progress);
    if (pendingGen) throw new Error("a generation is already running");

    const id = nextId++;
    const p = new Promise((resolve, reject) => { pendingGen = {id, resolve, reject}; });
    worker.postMessage({
      type: "generate", id,
      opts: {
        chip: opts.chip || "nes",
        mood: opts.mood || "unknown",
        key: opts.key || "unknown",
        scale: opts.scale || "unknown",
        bars: +opts.bars || 8,
        bpm: +opts.bpm || 150,
        seed: String(opts.seed == null ? "neojutsu" : opts.seed),
        temperature: opts.temperature == null ? cfg.temperature : +opts.temperature,
        topP: opts.topP == null ? cfg.topP : +opts.topP,
        drumTemperature: opts.drumTemperature == null ? cfg.drumTemperature : +opts.drumTemperature,
        drumTopP: opts.drumTopP == null ? cfg.drumTopP : +opts.drumTopP,
        drums: opts.drums == null ? cfg.drums : opts.drums,
        scene: opts.scene == null ? cfg.scene : opts.scene,
      },
    });
    const out = await p;
    report("done", 1, `${out.ms} ms`);
    return out.pattern;
  }

  global.OnjutsuAI = {
    configure(o) { Object.assign(cfg, o || {}); },
    get ready() { return ready; },
    get build() { return active; },
    get backend() { return backend; },   // {ep, threads, isolated}
    get settings() { return Object.assign({}, cfg); },
    load,
    generate,
    dispose() {
      if (worker) worker.terminate();
      worker = null; loading = null; ready = false; active = null; pendingGen = null;
    },
  };
})(typeof self !== "undefined" ? self : this);
