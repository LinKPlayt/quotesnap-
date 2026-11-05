// On-device image AI, running in a Web Worker so the app never freezes.
// - Loads ONNX Runtime Web (vendored) and the TinyCLIP image encoder once, then reuses it.
// - Tries WebGPU first, falls back to WebAssembly (CPU).
// - Model, runtime and label files are stored with the Cache API, so after the first
//   download everything works offline. Nothing is ever sent anywhere: photos arrive here
//   as pixel arrays from the page and only scores go back.

const BASE = new URL('../../', import.meta.url); // site root
const MODEL_DIR = new URL('models/tinyclip-vit-8m-16/', BASE);
const ORT_DIR = new URL('../vendor/ort-1.30.0/', import.meta.url);
const CACHE = 'quotesnap-ai-v1';
const RUNTIMES = {
  webgpu: { bundle: 'ort.webgpu.min.mjs', wasm: 'ort-wasm-simd-threaded.asyncify.wasm', bytes: 26781914 },
  wasm: { bundle: 'ort.wasm.min.mjs', wasm: 'ort-wasm-simd-threaded.wasm', bytes: 14239897 },
};
RUNTIMES['webgpu-cpu'] = RUNTIMES.webgpu; // fallback: WebGPU runtime (already downloaded), CPU execution

let state = null; // { ort, session, backend, config, questions, matrix, scale }
let loading = null;
let running = Promise.resolve(); // one session.run at a time
const exclusive = (fn) => { const r = running.then(fn); running = r.catch(() => {}); return r; };

const post = (msg) => self.postMessage(msg);
const status = (phase, extra = {}) => post({ type: 'status', phase, ...extra });

class AIError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ---------- storage ----------

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; } // private mode / storage blocked: still works, just not offline
}

async function sha256(buf) {
  if (!self.crypto?.subtle) return null;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Fetch a file once and keep it. Reports download progress. Verifies size / checksum.
async function cachedFetch(url, { label, bytes, sha, onProgress }) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return { buf: await hit.arrayBuffer(), fromCache: true };
  }
  if (self.navigator && navigator.onLine === false) throw new AIError('offline', 'Connect to the internet once to download the on-device AI. After that it works offline.');
  let res;
  try { res = await fetch(url); } catch { throw new AIError('network', `Could not download ${label}. Check your connection and try again.`); }
  if (!res.ok) throw new AIError('network', `Could not download ${label} (HTTP ${res.status}).`);
  // stream with progress only when the real size is known (content-length is the compressed size)
  const total = bytes || 0;
  let buf;
  if (res.body && total) {
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) throw new AIError('corrupt', `${label} is larger than expected. Try again.`);
      out.set(value, got);
      got += value.length;
      onProgress?.(got, total);
    }
    buf = got === total ? out.buffer : out.slice(0, got).buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  if (bytes && buf.byteLength !== bytes) throw new AIError('corrupt', `${label} download was incomplete. Try again.`);
  if (sha) {
    const got = await sha256(buf);
    if (got && got !== sha) throw new AIError('corrupt', `${label} failed its integrity check. Try again.`);
  }
  if (cache) {
    try {
      await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength) } }));
    } catch {
      status('warning', { message: 'Not enough storage to keep the AI for offline use. It will download again next time.' });
    }
  }
  return { buf, fromCache: false };
}

async function loadJson(url, { sha, label } = {}) {
  const { buf } = await cachedFetch(url, { label, sha });
  return JSON.parse(new TextDecoder().decode(buf));
}

// config.json is small and tells us which model/label versions are current: always try the
// network first (so updates arrive), fall back to the stored copy when offline.
async function loadConfig() {
  const url = new URL('config.json', MODEL_DIR).href;
  const cache = await openCache();
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error();
    const text = await res.text();
    const cfg = JSON.parse(text);
    if (cache) cache.put(url, new Response(text, { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
    return cfg;
  } catch {
    const hit = cache && (await cache.match(url));
    if (hit) return hit.json();
    throw new AIError('offline', 'Connect to the internet once to download the on-device AI. After that it works offline.');
  }
}

function urls(cfg, backend) {
  const rt = RUNTIMES[backend];
  return {
    model: new URL(`${cfg.file}?v=${cfg.sha256.slice(0, 12)}`, MODEL_DIR).href,
    labels: new URL(`${cfg.labels}?v=${cfg.labelsSha256.slice(0, 12)}`, MODEL_DIR).href,
    wasm: new URL(rt.wasm, ORT_DIR).href,
    bundle: new URL(rt.bundle, ORT_DIR).href,
  };
}

// Remove model/label versions that are no longer current.
async function pruneCache(keep) {
  const cache = await openCache();
  if (!cache) return;
  for (const req of await cache.keys()) {
    const u = req.url;
    const isVersioned = u.includes('/models/') && /[?&]v=/.test(u);
    if (isVersioned && !keep.includes(u)) await cache.delete(req);
  }
}

// ---------- backend selection ----------

async function pickBackend(processor) {
  if (processor === 'cpu') return 'wasm';
  try {
    if (self.navigator?.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch { /* no usable GPU */ }
  return 'wasm';
}

// ---------- load ----------

async function download(processor) {
  status('loading', { step: 'config', progress: 0 });
  const cfg = await loadConfig();
  const backend = await pickBackend(processor);
  const u = urls(cfg, backend);
  const rt = RUNTIMES[backend];
  const totalBytes = cfg.bytes + rt.bytes;
  let modelGot = 0;
  let wasmGot = 0;
  const report = () => status('loading', { step: 'download', progress: Math.round(((modelGot + wasmGot) / totalBytes) * 100), mb: Math.round(totalBytes / 1e6) });
  const [labels, model, wasm] = await Promise.all([
    loadJson(u.labels, { sha: cfg.labelsSha256, label: 'AI labels' }),
    cachedFetch(u.model, { label: 'the AI model', bytes: cfg.bytes, sha: cfg.sha256, onProgress: (g) => { modelGot = g; report(); } }),
    cachedFetch(u.wasm, { label: 'the AI runtime', bytes: rt.bytes, onProgress: (g) => { wasmGot = g; report(); } }),
  ]);
  pruneCache([u.model, u.labels]).catch(() => {});
  return { cfg, backend, u, labels, model: model.buf, wasm: wasm.buf, downloaded: !model.fromCache || !wasm.fromCache };
}

async function createSession(files, backend) {
  const ort = await import(new URL(RUNTIMES[backend].bundle, ORT_DIR).href);
  ort.env.wasm.wasmPaths = ORT_DIR.href;
  ort.env.wasm.wasmBinary = files.wasm;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  const session = await ort.InferenceSession.create(new Uint8Array(files.model), {
    executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { ort, session };
}

async function load(processor) {
  if (state) return state;
  if (loading) return loading;
  loading = (async () => {
    let files;
    try {
      files = await download(processor);
    } catch (err) {
      if (err.code === 'corrupt') await clearCache();
      throw err;
    }
    status('loading', { step: 'init', progress: 100 });
    let ort;
    let session;
    let backend = files.backend;
    try {
      ({ ort, session } = await createSession(files, backend));
    } catch (err) {
      if (backend === 'webgpu') {
        // GPU path failed (driver, missing feature, out of GPU memory): same runtime, CPU backend
        backend = 'wasm';
        try { ({ ort, session } = await createSession(files, 'webgpu-cpu')); } catch (e2) { throw toAIError(e2, true); }
      } else {
        throw toAIError(err, true);
      }
    }
    // decode label embeddings: float32 rows, one per class, in question order
    const bin = atob(files.labels.embeddings);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const matrix = new Float32Array(bytes.buffer);
    let row = 0;
    const questions = files.labels.questions.map((q) => {
      const ids = q.classes.map((c) => c.id);
      const start = row;
      row += ids.length;
      return { id: q.id, ids, start };
    });
    state = { ort, session, backend: backend === 'webgpu-cpu' ? 'wasm' : backend, config: files.cfg, questions, matrix, dim: files.labels.dim, scale: files.labels.logitScale };
    // warm-up run: compiles GPU shaders / JIT so the first real photo is fast
    try { await embed(new Float32Array(2 * 3 * files.cfg.size * files.cfg.size), 2); } catch { /* ignore */ }
    status('ready', { backend: state.backend, downloaded: files.downloaded });
    return state;
  })();
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

function toAIError(err, loadingModel = false) {
  if (err instanceof AIError) return err;
  const msg = String(err?.message || err);
  if (/memory|allocation|out of range|RangeError/i.test(msg) || err instanceof RangeError) {
    return new AIError('memory', 'This device ran out of memory for the AI. Close other apps or tabs and try again.');
  }
  if (loadingModel) return new AIError('corrupt', 'The AI model could not be started. It will be downloaded again on the next try.');
  return new AIError('inference', 'The AI could not analyze this photo. Try another photo.');
}

// ---------- inference ----------

async function embed(pixels, n) {
  const { ort, session, config } = state;
  const s = config.size;
  const input = new ort.Tensor('float32', pixels, [n, 3, s, s]);
  let out;
  try {
    out = await session.run({ [config.input]: input });
    const t = out[config.output];
    const data = t.location === 'gpu-buffer' ? await t.getData(true) : t.data;
    const dim = data.length / n;
    const v = new Float32Array(dim);
    for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) v[d] += data[i * dim + d];
    let norm = 0;
    for (let d = 0; d < dim; d++) norm += v[d] * v[d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) v[d] /= norm;
    return v;
  } finally {
    input.dispose?.();
    if (out) for (const t of Object.values(out)) t.dispose?.();
  }
}

// Score one image embedding against every question: softmax over each question's classes.
function score(v) {
  const { questions, matrix, dim, scale } = state;
  const probs = {};
  for (const q of questions) {
    const logits = q.ids.map((_, k) => {
      const off = (q.start + k) * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += matrix[off + d] * v[d];
      return dot * scale;
    });
    const max = Math.max(...logits);
    const ex = logits.map((z) => Math.exp(z - max));
    const sum = ex.reduce((a, b) => a + b, 0);
    probs[q.id] = Object.fromEntries(q.ids.map((id, k) => [id, ex[k] / sum]));
  }
  return probs;
}

async function clearCache() {
  try { await caches.delete(CACHE); } catch { /* ignore */ }
}

// ---------- messages ----------

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'load') {
      const s = await load(e.data.processor);
      post({ id, ok: true, result: { backend: s.backend, size: s.config.size, mean: s.config.mean, std: s.config.std, model: s.config.name } });
    } else if (type === 'prefetch') {
      if (state) { post({ id, ok: true, result: { cached: true } }); return; }
      const f = await download(e.data.processor);
      status('downloaded', { backend: f.backend });
      post({ id, ok: true, result: { cached: true, backend: f.backend } });
    } else if (type === 'config') {
      const cfg = await loadConfig();
      post({ id, ok: true, result: { size: cfg.size, mean: cfg.mean, std: cfg.std } });
    } else if (type === 'analyze') {
      await load(e.data.processor);
      const t0 = performance.now();
      const v = await exclusive(() => embed(e.data.pixels, e.data.n));
      post({ id, ok: true, result: { probs: score(v), ms: Math.round(performance.now() - t0), backend: state.backend } });
    } else if (type === 'isCached') {
      const cache = await openCache();
      let cached = false;
      if (cache) {
        const cfgRes = await cache.match(new URL('config.json', MODEL_DIR).href);
        if (cfgRes) {
          const cfg = await cfgRes.json();
          const backend = await pickBackend(e.data.processor);
          const u = urls(cfg, backend);
          cached = !!((await cache.match(u.model)) && (await cache.match(u.wasm)) && (await cache.match(u.labels)));
        }
      }
      post({ id, ok: true, result: { cached } });
    } else if (type === 'clear') {
      if (state) await state.session.release().catch(() => {});
      state = null;
      loading = null;
      await clearCache();
      post({ id, ok: true, result: true });
    }
  } catch (err) {
    const ae = toAIError(err, type === 'load' || type === 'prefetch');
    if (ae.code === 'corrupt') await clearCache();
    post({ id, ok: false, error: { code: ae.code, message: ae.message } });
  }
};
