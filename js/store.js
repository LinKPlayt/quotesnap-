// Tiny IndexedDB key-value store. Photos are large, so everything lives in IndexedDB
// (not localStorage, which caps out around 5 MB).

const DB = 'quotesnap';
const STORE = 'kv';
let dbp;

let memory = null; // fallback when IndexedDB is blocked (private mode, in-app browsers)

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => reject(new Error('storage timed out')), 4000);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error('storage blocked')); };
  });
}

function db() {
  if (!dbp) {
    dbp = (typeof indexedDB === 'undefined' ? Promise.reject(new Error('no IndexedDB')) : openDb()).catch((err) => {
      console.warn('IndexedDB unavailable, using memory only:', err);
      memory = new Map();
      return null;
    });
  }
  return dbp;
}

const mem = {
  get: (k) => memory.get(k),
  set: (k, v) => void memory.set(k, v),
  del: (k) => void memory.delete(k),
  keys: () => [...memory.keys()],
  clear: () => memory.clear(),
};

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const use = (name, idb) => async (...a) => ((await db()) ? idb(...a) : mem[name](...a));

export const kv = {
  get: use('get', (k) => tx('readonly', (s) => s.get(k))),
  set: use('set', (k, v) => tx('readwrite', (s) => s.put(v, k))),
  del: use('del', (k) => tx('readwrite', (s) => s.delete(k))),
  keys: use('keys', () => tx('readonly', (s) => s.getAllKeys())),
  clear: use('clear', () => tx('readwrite', (s) => s.clear())),
  persistent: async () => !!(await db()),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Resize a camera photo to keep storage and AI uploads small.
export function compressImage(file, max = 1280, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}
