// AIModelManager: the page-side half of the on-device AI.
// Owns one Web Worker (js/localai/worker.js), loads the model once and reuses it,
// prepares photos (resize, center-crop, normalize), and reports status to the UI.
// Images never leave the device: pixels go to the worker, scores come back.

const WASM_SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const MAX_INPUT_PIXELS = 40e6; // refuse absurd images before decoding them into memory

function moduleWorkerSupported() {
  let ok = false;
  try {
    const opts = { get type() { ok = true; return 'module'; } };
    new Worker('data:text/javascript,', opts).terminate();
  } catch { /* ignore */ }
  return ok;
}

export function detectSupport() {
  const wasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  let simd = false;
  try { simd = wasm && WebAssembly.validate(WASM_SIMD_TEST); } catch { /* ignore */ }
  const worker = typeof Worker === 'function' && moduleWorkerSupported();
  const webgpu = typeof navigator !== 'undefined' && !!navigator.gpu;
  const storage = typeof caches !== 'undefined';
  let reason = '';
  if (!wasm) reason = 'This browser cannot run WebAssembly, which the on-device AI needs.';
  else if (!simd) reason = 'This browser is too old for the on-device AI (needs WebAssembly SIMD: iOS 16.4+, Chrome 91+, Safari 16.4+). Update the browser.';
  else if (!worker) reason = 'This browser cannot run background workers, which the on-device AI needs. Update the browser.';
  return { ok: !reason, wasm, simd, worker, webgpu, storage, reason };
}

class AIModelManager {
  constructor() {
    this.support = detectSupport();
    this.state = { phase: this.support.ok ? 'idle' : 'unsupported', message: this.support.reason };
    this.listeners = new Set();
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.prep = null; // { size, mean, std }
    this.processor = 'auto';
    this.queue = Promise.resolve(); // analyses run one after another
  }

  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) { try { fn(this.state); } catch { /* UI errors must not break the AI */ } }
  }

  setProcessor(p) {
    if (p === this.processor) return;
    this.processor = p;
    this.reset(); // reload with the new backend next time
  }

  reset() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const { reject } of this.pending.values()) reject(Object.assign(new Error('AI restarted'), { code: 'restart' }));
    this.pending.clear();
    if (this.support.ok) this.emit({ phase: 'idle', progress: 0, backend: null, message: '' });
  }

  ensureWorker() {
    if (!this.support.ok) throw Object.assign(new Error(this.support.reason), { code: 'unsupported' });
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') {
        if (m.phase === 'loading') this.emit({ phase: 'loading', progress: m.progress, step: m.step, mb: m.mb ?? this.state.mb, message: '' });
        else if (m.phase === 'ready') this.emit({ phase: 'ready', backend: m.backend, progress: 100, message: '' });
        else if (m.phase === 'downloaded') this.emit({ phase: this.state.phase === 'ready' ? 'ready' : 'downloaded', backend: m.backend, progress: 100 });
        else if (m.phase === 'warning') this.emit({ warning: m.message });
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      const err = Object.assign(new Error('The on-device AI stopped unexpectedly. Tap Analyze to try again.'), { code: 'crash' });
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
      this.emit({ phase: 'error', message: err.message });
    };
    this.worker = w;
    return w;
  }

  call(type, data = {}, transfer = []) {
    const w = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, type, processor: this.processor, ...data }, transfer);
    });
  }

  // Load the model into memory (downloads it the first time). Safe to call repeatedly.
  async load() {
    if (this.state.phase === 'ready' && this.prep) return this.prep;
    if (this.state.phase !== 'loading') this.emit({ phase: 'loading', progress: 0, message: '' });
    try {
      const r = await this.call('load');
      this.prep = { size: r.size, mean: r.mean, std: r.std };
      this.emit({ phase: 'ready', backend: r.backend });
      return this.prep;
    } catch (err) {
      this.emit({ phase: 'error', message: err.message, code: err.code });
      throw err;
    }
  }

  // Download and store the files for offline use without loading them into memory.
  async prefetch() {
    if (!this.support.ok || this.state.phase === 'ready' || this.state.phase === 'loading') return;
    this.emit({ phase: 'loading', progress: 0, message: '' });
    try {
      await this.call('prefetch');
      if (this.state.phase !== 'ready') this.emit({ phase: 'downloaded', progress: 100 });
    } catch (err) {
      this.emit({ phase: 'error', message: err.message, code: err.code });
    }
  }

  async isCached() {
    if (!this.support.ok || !this.support.storage) return false;
    try {
      const { cached } = await this.call('isCached');
      if (cached && this.state.phase === 'idle') this.emit({ phase: 'downloaded', progress: 100 });
      return cached;
    } catch { return false; }
  }

  async clear() {
    try { await this.call('clear'); } finally { this.prep = null; this.reset(); }
  }

  // Analyze photos (data URLs or Blobs). Returns one result per photo: { probs, ms, backend } or { error }.
  // Calls are queued: a second quote's photos wait for the first to finish.
  analyze(images, opts) {
    const job = this.queue.then(() => this.runAnalyze(images, opts));
    this.queue = job.catch(() => {});
    return job;
  }

  async runAnalyze(images, { onProgress } = {}) {
    const prep = await this.load();
    const out = [];
    for (let i = 0; i < images.length; i++) {
      this.emit({ phase: 'analyzing', index: i + 1, total: images.length });
      onProgress?.(i + 1, images.length);
      try {
        const pixels = await toPixels(images[i], prep);
        const r = await this.call('analyze', { pixels, n: 2 }, [pixels.buffer]);
        out.push(r);
      } catch (err) {
        if (err.code === 'memory' || err.code === 'crash' || err.code === 'unsupported') { this.emit({ phase: 'error', message: err.message }); throw err; }
        out.push({ error: err.message || 'Could not read this photo.' });
      }
    }
    this.emit({ phase: 'ready', index: 0, total: 0 });
    return out;
  }
}

// ---------- preprocessing (main thread: cheap, works on every browser) ----------

function dataUrlToBlob(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error('That file is not an image.');
  if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type: m[1] || 'image/jpeg' });
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || 'image/jpeg' });
}

async function decode(src) {
  if (!src) throw new Error('That file is not an image.');
  const blob = typeof src === 'string' ? dataUrlToBlob(src) : src;
  if (!blob || !/^image\//.test(blob.type || 'image/')) throw new Error('That file is not an image.');
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* fall through to <img> (older Safari) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('This photo could not be read. Try a JPG or PNG.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Resize the shortest side to `size`, center-crop to size×size, scale to 0..1, normalize with the
// model's mean/std, lay out as CHW. Returns the original plus a mirrored copy (batch of 2), which
// the worker averages for a steadier result.
export async function toPixels(src, { size, mean, std }) {
  const img = await decode(src);
  const w = img.width || img.naturalWidth;
  const h = img.height || img.naturalHeight;
  try {
    if (!w || !h) throw new Error('This photo is empty or damaged.');
    if (w * h > MAX_INPUT_PIXELS) throw new Error('This photo is too large to analyze.');
    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;
    // two-step downscale avoids the aliasing of one big jump
    let source = img;
    let sw = side;
    let ox = sx;
    let oy = sy;
    let mid = null;
    if (side > size * 3) {
      mid = document.createElement('canvas');
      mid.width = mid.height = size * 2;
      const m = mid.getContext('2d');
      m.imageSmoothingQuality = 'high';
      m.drawImage(img, sx, sy, side, side, 0, 0, size * 2, size * 2);
      source = mid; sw = size * 2; ox = 0; oy = 0;
    }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, ox, oy, sw, sw, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const plane = size * size;
    const out = new Float32Array(2 * 3 * plane);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const p = (y * size + x) * 4;
        const q = y * size + x;
        const qm = y * size + (size - 1 - x); // mirrored position
        for (let ch = 0; ch < 3; ch++) {
          const v = (rgba[p + ch] / 255 - mean[ch]) / std[ch];
          out[ch * plane + q] = v;
          out[3 * plane + ch * plane + qm] = v;
        }
      }
    }
    c.width = c.height = 0; // release canvas memory right away (iOS keeps it otherwise)
    if (mid) mid.width = mid.height = 0;
    return out;
  } finally {
    img.close?.();
  }
}

export const localAI = new AIModelManager();
