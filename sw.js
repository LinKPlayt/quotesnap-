// Offline-first app shell. Bump VERSION when app files change.
const VERSION = 'quotesnap-v8';
// On-device AI files (model, labels, runtime). Kept across app updates: their URLs are
// versioned (model ?v=<sha>, runtime folder name), so a new version gets a new entry and the
// AI worker deletes old ones. Shared with js/localai/worker.js.
const AI_CACHE = 'quotesnap-ai-v1';
const ORT = 'js/vendor/ort-1.30.0/';
const SHELL = ['./', 'index.html', 'css/styles.css', 'js/app.js', 'js/engine.js', 'js/pricebook.js', 'js/store.js', 'js/ai.js', 'js/geo.js', 'js/pdf.js', 'js/company.js', 'js/planner.js', 'js/learning.js', 'js/views-company.js', 'js/guide.js', 'js/onboarding.js',
  'js/localai/manager.js', 'js/localai/worker.js', 'js/localai/interpret.js',
  ORT + 'ort.webgpu.min.mjs', ORT + 'ort-wasm-simd-threaded.asyncify.mjs', ORT + 'ort.wasm.min.mjs', ORT + 'ort-wasm-simd-threaded.mjs',
  'js/vendor/jspdf.umd.min.js', 'js/vendor/html2canvas.min.js', 'icons/icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('quotesnap-v') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isAiAsset = (url) => (url.pathname.includes('/models/') && url.searchParams.has('v')) || (url.pathname.includes('/' + ORT) && url.pathname.endsWith('.wasm'));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // other sites (maps, weather, optional cloud AI) go to the network
  if (isAiAsset(url)) {
    // big, immutable AI files: cache first, never re-download
    e.respondWith(caches.open(AI_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone()).catch(() => {});
      return r;
    }));
    return;
  }
  // network first so updates show up, cache fallback for job sites with no signal
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
