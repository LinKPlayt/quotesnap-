import { kv, uid, compressImage } from './store.js';
import { DEFAULT_PRICEBOOK, mergePricebook } from './pricebook.js';
import {
  newJob, newTree, parseDescription, applyParsed, describeChanges, buildOptions, snowDepthTiers, totals, money, SPECIES,
} from './engine.js';
import { analyzeJob, aiToParsed, testKey, DEFAULT_MODEL } from './ai.js';
import { getPosition, reverseGeocode, geocode, roadMiles, drivingMiles, forecast, stormAlerts, dayName } from './geo.js';
import { pickFuel, suggestPricing, applyChanges, profileOf, stateFrom, fuelUse } from './autoprice.js';
import { photoLocation } from './exif.js';
import { makePdf } from './pdf.js';
import { localAI } from './localai/manager.js';
import { interpret } from './localai/interpret.js';
import { mergeCompany, DEFAULT_MULTIPLIERS } from './company.js';
import { fellBlocked } from './planner.js';
import { snapshotEstimate, compareJob, newActual, actualSiteHours } from './learning.js';
import { viewResources, viewRates, viewPricing } from './views-company.js';
import { ask, choose, coach, speak, listen, canListen, sayMoney, questionStep } from './guide.js';
import { jobQuestions, openQuestions, currentAnswer, applyAnswer, questionSummary } from './questions.js';
import { runOnboarding } from './onboarding.js';
import { parseCustomer } from './engine.js';

// ---------------------------------------------------------------- state

const S = {
  settings: null,
  pricebook: null,
  estimates: [],
  photos: new Map(), // id -> dataURL cache
};
const AI = { busy: new Set(), timers: new Map() }; // AI runs in flight / scheduled, by estimate id
const pendingSnap = new Set(); // estimates just created from the camera: auto-analyze + locate on open

const DEFAULT_SETTINGS = {
  business: { name: 'Your Tree & Snow Co.', owner: '', phone: '', email: '', address: '', website: '', license: '', insurance: '', logo: '', color: '#1f5f3f', payLink: '', reviewLink: '' },
  ai: { engine: 'local', processor: 'auto', apiKey: '', model: DEFAULT_MODEL, auto: true }, // engine: 'local' (on-device, default) | 'cloud' (Claude, opt-in)
  geo: { autoLocate: true, shop: null, home: null },
  sendVia: 'share',
  prefix: 'Q',
  nextNumber: 1001,
  showItemized: true,
  followUpDays: 3,
  onboarded: false,   // first-run setup finished or skipped
  seenTips: {},       // one-time tips already shown
  simple: true,       // simple screens: extras folded away
  textSize: 'normal', // normal | large | xlarge
  voice: { speak: false }, // read prices out loud
  askQuestions: true, // after photos, ask the questions the price depends on
  work: 'both',
};

const STATUSES = ['draft', 'sent', 'accepted', 'scheduled', 'completed', 'paid', 'declined'];
const WON = ['accepted', 'scheduled', 'completed', 'paid'];
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const daysAgo = (d) => Math.floor((Date.now() - new Date(d)) / 864e5);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const today = () => new Date().toISOString().slice(0, 10);
const canSharePdf = () => !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, path, v) {
  const ks = path.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks.at(-1)] = v;
}

async function load() {
  const saved = (await kv.get('settings')) || {};
  S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...saved };
  for (const k of ['business', 'ai', 'geo', 'voice']) S.settings[k] = { ...DEFAULT_SETTINGS[k], ...(saved[k] || {}) };
  S.settings.seenTips ||= {};
  // people who used the app before this update already know their way around

  S.pricebook = mergePricebook(await kv.get('pricebook'));
  S.estimates = (await kv.get('estimates')) || [];
  if (saved.onboarded === undefined && S.estimates.length) S.settings.onboarded = true;
  S.company = mergeCompany(await kv.get('company'));
  // prices each sent quote was made with (see lockPrices)
  S.snaps = new Map();
  S.snapCache = new Map();
  for (const k of (await kv.keys()) || []) if (String(k).startsWith('snap:')) S.snaps.set(String(k).slice(5), await kv.get(k));
  const unlocked = S.estimates.filter((e) => e.status !== 'draft' && !e.pricedRef);
  if (unlocked.length) { await Promise.all(unlocked.map((e) => lockPrices(e))); await saveEstimates(); }
  const used = new Set(S.estimates.map((e) => e.pricedRef).filter(Boolean));
  for (const h of [...S.snaps.keys()]) if (!used.has(h)) { S.snaps.delete(h); kv.del('snap:' + h); }
}
const saveSettings = () => kv.set('settings', S.settings);
const saveCompany = () => kv.set('company', S.company);
const savePricebook = () => kv.set('pricebook', S.pricebook);
const saveEstimates = () => kv.set('estimates', S.estimates);

async function getPhoto(id) {
  if (!S.photos.has(id)) S.photos.set(id, await kv.get('photo:' + id));
  return S.photos.get(id);
}
async function addPhotos(est, files) {
  let n = 0;
  for (const f of files) {
    if (f.type && !f.type.startsWith('image/')) { toast(`${f.name || 'That file'} is not a photo`); continue; }
    if (f.size > 60e6) { toast(`${f.name || 'That photo'} is too large (over 60 MB)`); continue; }
    try {
      // where the photo was taken (if the phone saved it): used for the job address and distance
      if (!est.photoGeo) { const g = await photoLocation(f); if (g) est.photoGeo = { lat: g.lat, lon: g.lon, takenAt: g.takenAt || null }; }
      const data = await compressImage(f);
      const pid = uid();
      await kv.set('photo:' + pid, data);
      S.photos.set(pid, data);
      est.photos.push(pid);
      n++;
    } catch { toast('Could not read one of the photos. Try a JPG or PNG.'); }
  }
  return n;
}

// ---------------------------------------------------------------- estimate helpers

function newEstimate(division = 'tree', customer) {
  return {
    id: uid(),
    number: `${S.settings.prefix}-${S.settings.nextNumber++}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    customer: { name: '', phone: '', email: '', address: '', ...(customer || {}) },
    job: newJob(division),
    photos: [],
    marginPct: null,
    discount: 0,
    adjustments: [],
    selectedOption: null,
    notes: '',
    ai: null,
    locks: {},
    aiFields: [],
    history: [{ at: new Date().toISOString(), text: 'Quote created' }],
  };
}

// The planner tries every safe way to do a job and keeps the cheapest, so one screen refresh asks
// for the same price several times: the last few answers are kept, keyed by everything they use.
const COMPUTED = new Map();
function compute(est, { today = false } = {}) {
  const P = today ? { pb: S.pricebook, company: S.company } : pricingFor(est);
  const pb = P.pb;
  const margin = est.marginPct ?? pb.targetMarginPct;
  const key = JSON.stringify([est.job, margin, est.selectedOption, est.discount, est.adjustments, pb, P.company]);
  if (COMPUTED.has(key)) return COMPUTED.get(key);
  const options = buildOptions(est.job, pb, margin, P.company);
  const sel = options.find((o) => o.id === est.selectedOption) || options.find((o) => o.recommended) || options[0];
  const t = totals(sel.est.price, { discount: est.discount, adjustments: est.adjustments, taxPct: pb.taxPct, depositPct: pb.depositPct });
  const tiers = est.job.division === 'snow' ? snowDepthTiers(est.job, pb, margin, P.company) : null;
  const out = { options, sel, t, tiers, margin, pb };
  COMPUTED.set(key, out);
  if (COMPUTED.size > 8) COMPUTED.delete(COMPUTED.keys().next().value);
  return out;
}

// ---------------------------------------------------------------- locked prices
// Costs now change by themselves (fuel is updated daily), so a quote that has left Draft keeps the
// prices it was made with: the customer's number never moves. Snapshots are shared between quotes
// made on the same day, so they take little space.
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36) + str.length.toString(36);
}
function lockPrices(est) {
  const pb = structuredClone(S.pricebook);
  delete pb.autoLog;
  const data = { pb, company: structuredClone(S.company) };
  const h = hashStr(JSON.stringify(data));
  est.pricedRef = h;
  est.pricedAt = new Date().toISOString();
  if (S.snaps.has(h)) return Promise.resolve();
  S.snaps.set(h, data);
  return kv.set('snap:' + h, data);
}
function pricingFor(est) {
  const ref = est?.pricedRef;
  const snap = ref && S.snaps?.get(ref);
  if (!snap) return { pb: S.pricebook, company: S.company, locked: false };
  if (!S.snapCache.has(ref)) S.snapCache.set(ref, { pb: mergePricebook(snap.pb), company: mergeCompany(snap.company), locked: true });
  return S.snapCache.get(ref);
}

function jobTitle(job) {
  if (job.division === 'snow') {
    const s = job.snow;
    const parts = [];
    if (s.areaSqft) parts.push(`${s.property === 'commercial' ? 'Lot' : 'Driveway'} ${(+s.areaSqft).toLocaleString()} sq ft`);
    if (s.walkLf) parts.push('walks');
    if (s.salt) parts.push('salt');
    if (s.roofSqft) parts.push('roof');
    return 'Snow: ' + (parts.join(', ') || 'service');
  }
  const verbs = { remove: 'Remove', trim: 'Trim', stump: 'Grind stump', cable: 'Cable' };
  return job.tree.trees
    .map((t) => `${verbs[t.work]} ${t.qty > 1 ? t.qty + '× ' : ''}${t.heightFt && t.work !== 'stump' ? t.heightFt + ' ft ' : ''}${t.species || (t.work === 'stump' ? '' : 'tree')}`.trim())
    .join(' + ');
}

function persist(est) {
  est.updatedAt = new Date().toISOString();
  const c = compute(est);
  est.summary = { title: jobTitle(est.job), total: c.t.total, option: c.sel.name, profit: c.sel.est.profit - (est.discount || 0), margin: c.sel.est.marginPct, unit: c.sel.unit || '' };
  const i = S.estimates.findIndex((e) => e.id === est.id);
  if (i >= 0) S.estimates[i] = est;
  else S.estimates.unshift(est);
  return saveEstimates();
}

function logHistory(est, text) {
  est.history = est.history || [];
  est.history.push({ at: new Date().toISOString(), text });
}

function setStatus(est, status) {
  if (est.status === status) return;
  const wasDraft = est.status === 'draft';
  est.status = status;
  est[status + 'At'] = new Date().toISOString();
  logHistory(est, `Status → ${status}`);
  if (status === 'draft') { if (est.pricedRef) { delete est.pricedRef; delete est.pricedAt; logHistory(est, "Back to draft: today's prices are used again"); } }
  else if (wasDraft || !est.pricedRef) lockPrices(est);
  // freeze the original estimate when the customer says yes (used to learn from actual results)
  if (WON.includes(status) && !est.original) {
    const { sel } = compute(est);
    est.original = snapshotEstimate(sel.est, sel.name);
  }
}

function isEmptyDraft(e) {
  return e && e.status === 'draft' && !e.customer.name && !e.job.description && !e.photos.length && !e.customer.phone;
}

// ---------------------------------------------------------------- easy-to-use helpers

function applyTextSize() {
  document.documentElement.dataset.text = S.settings.textSize || 'normal';
}

const TIPS = {
  dashboard: [
    { el: '.snap-btn', title: 'Start here', text: 'Tap this and take 2 or 3 photos of the job. The app fills in the work and the price for you.' },
    { el: '.hero-alt', text: 'No photos? Start a tree or snow quote by hand here.' },
    { el: '#aichip', text: 'This line tells you if the photo AI is ready. Once it has downloaded, it works without internet.' },
    { el: '#helpbtn', text: 'Stuck? Tap the ? button on any screen for help.' },
  ],
  editor: [
    { el: '#stepbar', title: 'Your steps', text: 'Every quote has these steps. A ✓ means that step is done. Tap a step to jump to it.' },
    { el: '#card-photos', text: 'Your photos are here. Tap Camera to add more. The app reads them by itself.' },
    { el: '#qcall', title: 'Quick questions', text: 'The app asks the few things a photo can\'t show, one at a time, so the price is right. Tap Answer to go through them.' },
    { el: '#card-customer', text: 'Who the quote is for. The 📍 button fills in the address from where you are standing.' },
    { el: '.price-hero', text: 'This is the price. It updates by itself when you change anything.' },
    { el: '#sendbar', title: 'Send it', text: 'When it looks right, tap Send. The customer gets a PDF quote by text or email.' },
  ],
  resources: [
    { el: '#addw', text: 'Add each person on your crew. Tap a name to change their pay and which machines they can run.' },
    { el: '#adde', text: 'Add your trucks and machines here. Pick the type first, then tap Add.' },
  ],
  rates: [{ el: '#resetrates', text: 'These are how fast your crew works. You can leave them alone; the app improves them over time from finished jobs (you approve every change).' }],
  pricebook: [{ el: '.basics', text: 'These are the prices most people change. Set them once. Everything else can stay as it is.' }],
};

function runTips(name, force = false) {
  const steps = TIPS[name];
  if (!steps || !S.settings.onboarded) return;
  setTimeout(() => coach(name, steps, S.settings.seenTips, saveSettings, { force }), force ? 0 : 500);
}

async function openHelp() {
  const name = (location.hash.slice(2).split(/[/?]/)[0]) || 'dashboard';
  const screen = name === 'e' ? 'editor' : name;
  const pick = await choose('How can we help?', [
    ...(TIPS[screen] ? [{ id: 'tips', icon: '💡', label: 'Show me how this screen works', sub: 'Short tips that point at the buttons' }] : []),
    { id: 'how', icon: '📸', label: 'How to make a quote', sub: 'The 3 steps' },
    { id: 'setup', icon: '⚙', label: 'Run the setup again', sub: 'Business, crew, equipment, shop' },
  ], { cancel: 'Close' });
  if (pick === 'tips') runTips(screen, true);
  if (pick === 'how') await ask('1. Tap 📸 Snap a job and take 2 or 3 photos.\n\n2. Check the boxes with a purple outline: the app filled those in. Tap any of them to change it.\n\n3. Tap the big Send button at the bottom. The customer gets a PDF quote.', { title: 'How to make a quote', ok: 'Got it', cancel: '' });
  if (pick === 'setup') await startOnboarding();
}

async function startOnboarding() {
  const goal = await runOnboarding({ S, saveSettings, saveCompany, getPosition, reverseGeocode, geocode, applyTextSize, speak });
  if (goal === 'sample') {
    if (!S.estimates.some((e) => e.customer.name === 'Dana Whitfield')) await loadDemo();
    const demo = S.estimates.find((e) => e.customer.name === 'Dana Whitfield');
    location.hash = demo ? '#/e/' + demo.id : '#/';
  } else if (goal === 'snap' && location.hash && location.hash !== '#/') {
    location.hash = '#/';
  } else {
    route(); // stay on the screen they opened, just refresh it (and show its tips)
  }
}

// Guess "Dana Whitfield" from "dana whitfield 555 014 2299" when no "customer is…" phrase was used.
function guessName(text) {
  const before = text.split(/\d|@/)[0].replace(/\b(customer|client|name|is|for|the|phone|number|call|at)\b/gi, ' ').replace(/[^a-zA-Z' -]/g, ' ').trim();
  const words = before.split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ') : '';
}

function fillCustomer(e, c) {
  const got = [];
  for (const k of ['name', 'phone', 'email', 'address']) {
    if (!c[k]) continue;
    e.customer[k] = c[k];
    e.locks[`customer.${k}`] = true;
    const inp = $(`[data-k="customer.${k}"]`);
    if (inp) inp.value = c[k];
    got.push(c[k]);
  }
  renderCustomerExtras();
  changed();
  return got;
}

// "Who is this quote for?" with big choices: say it, pick a contact, type it, or skip.
async function askCustomer(e) {
  if (!ED || ED.est !== e) return;
  const contacts = 'contacts' in navigator && 'ContactsManager' in window;
  const pick = await choose('Who is this quote for?', [
    ...(canListen() ? [{ id: 'say', icon: '🎤', label: 'Say their name and phone', sub: 'Example: “Dana Whitfield, 555 014 2299”' }] : []),
    ...(contacts ? [{ id: 'contacts', icon: '📇', label: 'Pick from my contacts' }] : []),
    { id: 'type', icon: '⌨', label: 'Type it in' },
  ], { message: 'The photos are being checked while you do this.', cancel: 'Skip for now' });
  if (pick === 'say') {
    const text = await listen({ prompt: "Say the customer's name and phone number", hint: 'Tap Done when you have finished.' });
    if (!text) { toast("Didn't catch that. Tap the name box to type it."); return; }
    const c = parseCustomer(text);
    if (!c.name) c.name = guessName(text);
    const got = fillCustomer(e, c);
    toast(got.length ? `Got it: ${got.join(', ')}` : "Didn't catch a name or number. Tap the name box to type it.", 4000);
  } else if (pick === 'contacts') {
    $('#pickc')?.click();
  } else if (pick === 'type') {
    const inp = $('[data-k="customer.name"]');
    inp?.scrollIntoView({ block: 'center' });
    inp?.focus();
  }
  return pick;
}

// ---------------------------------------------------------------- pricing questions
// One question per screen for everything the price depends on that the photos and notes
// haven't settled: how many trees, height, access, hazards, cleanup, stumps, timing, distance;
// or area, sidewalks, depth, ice, salt, obstacles, contract. Answers lock their fields.

function qctx(e) {
  const P = pricingFor(e);
  return { company: P.company, pricebook: P.pb, canFindMiles: !!(S.settings.geo.shop && e.customer.address), simple: S.settings.simple !== false };
}

let asking = false;
async function askQuestions(e, { auto = false } = {}) {
  if (asking || !ED || ED.est !== e) return;
  asking = true;
  const asked = []; // ids already shown this round, for Back
  const skipped = new Set();
  let total = 0;
  let back = null; // question reopened with Back
  try {
    for (;;) {
      if (!ED || ED.est !== e) return;
      const open = openQuestions(e, qctx(e)).filter((q) => !skipped.has(q.id) && !asked.includes(q.id));
      total = Math.max(total, asked.length + open.length + (back ? 1 : 0));
      const q = back ? jobQuestions(e, qctx(e)).find((x) => x.id === back) || open[0] : open[0];
      back = null;
      if (!q) break;
      // only show a starting answer the AI, the notes or the estimator actually gave, never a blank default
      const fromAi = q.paths.some((p) => (e.aiFields || []).includes(p));
      const cur = q.kind === 'many' || fromAi || e.answered?.[q.id] ? currentAnswer(e, q) : null;
      const guessed = q.kind !== 'many' && cur != null && fromAi;
      const r = await questionStep(q, {
        step: asked.length + 1, total, selected: cur, guessed,
        price: money(compute(e).t.total), canBack: asked.length > 0,
      });
      if (!ED || ED.est !== e) return;
      if (r.action === 'done') break;
      if (r.action === 'skip') { skipped.add(q.id); continue; }
      if (r.action === 'back') {
        back = asked.pop() || null;
        continue;
      }
      if (q.id === 'job.miles' && r.value === 'auto') {
        await milesFromAddress(e);
        if (!(+e.job.miles > 0)) { toast("Couldn't find that address. Pick the closest distance instead."); continue; }
        e.locks['job.miles'] = true;
        (e.answered ||= {})[q.id] = true;
      } else {
        applyAnswer(e, q, r.value);
      }
      if (!asked.includes(q.id)) asked.push(q.id);
      e.selectedOption = null;
      refreshEditorAfterFill();
    }
  } finally {
    asking = false;
  }
  if (!ED || ED.est !== e) return;
  refreshEditorAfterFill();
  const left = questionSummary(e, qctx(e)).openRequired;
  if (!left) {
    const c = compute(e);
    toast(`✓ All set: ${money(c.t.total)}. Check it over and tap Send.`, 4000);
    if (S.settings.voice?.speak) speak(`All questions answered. The price is ${sayMoney(c.t.total)}.`);
  } else if (!auto) toast(`${left} question${left === 1 ? '' : 's'} still open. Tap Answer on the Details card any time.`, 4000);
}

function renderQuestionCall() {
  const el = $('#qcall');
  if (!el || !ED) return;
  const e = ED.est;
  const q = questionSummary(e, qctx(e));
  if (!q.open) { el.innerHTML = `<div class="callout ok small q-callout">✓ <span>All ${q.total} pricing questions answered.</span></div>`; return; }
  const req = q.openRequired;
  el.innerHTML = `<div class="callout ${req ? '' : 'ok'} q-callout">
      <span>❓ <b>${req ? `${req} question${req === 1 ? '' : 's'} to price this right` : `${q.open} optional question${q.open === 1 ? '' : 's'} left`}</b><br>
      <span class="tiny muted">${q.done} of ${q.total} answered. Things a photo can't show, one tap each.</span></span>
      <span class="spacer"></span><button class="btn ${req ? 'primary' : ''}" id="qgo">Answer</button></div>`;
  $('#qgo').onclick = () => askQuestions(e);
}

// Next weekday from tomorrow that has no job booked yet.
function nextFreeDay() {
  const booked = new Set(S.estimates.filter((x) => x.scheduledFor && !['declined', 'paid', 'completed'].includes(x.status)).map((x) => x.scheduledFor));
  const d = new Date();
  for (let i = 1; i < 60; i++) {
    d.setDate(d.getDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (d.getDay() !== 0 && d.getDay() !== 6 && !booked.has(iso)) return iso;
  }
  return null;
}

async function offerSchedule(e) {
  if (e.scheduledFor) return;
  const day = nextFreeDay();
  if (!day) return;
  const nice = new Date(day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const yes = await ask(`Your next open day is ${nice}. Book this job then?`, { title: 'Schedule the job', icon: '📅', ok: 'Yes, book it', cancel: 'Not now' });
  if (!yes || !ED || ED.est !== e) return;
  e.scheduledFor = day;
  if (e.status === 'accepted') setStatus(e, 'scheduled');
  const st = $('#status');
  if (st) st.value = e.status;
  logHistory(e, `Scheduled for ${fmtDate(day)}`);
  renderSchedule();
  renderHistory();
  changed();
  toast(`📅 Booked for ${nice}. Tap “Add to calendar” to put it in your phone.`, 4500);
}

const normAddr = (a) => (a || '').toLowerCase().split(',')[0].replace(/\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------- AI photo analysis

const aiKey = (est) => est.photos.join(',') + '|' + (est.job.description || '').trim();
const isLocal = () => S.settings.ai.engine !== 'cloud';
const aiOn = () => (isLocal() ? localAI.support.ok : !!S.settings.ai.apiKey); // is photo analysis available?

function scheduleAi(est, delay = 1500) {
  if (!aiOn() || !S.settings.ai.auto) return;
  if (!est.photos.length && !(est.job.description || '').trim()) return;
  clearTimeout(AI.timers.get(est.id));
  AI.timers.set(est.id, setTimeout(() => runAi(est.id, { auto: true }).finally(() => renderAiStatus()), delay));
}

async function runAi(id, { auto = false } = {}) {
  const live = () => (ED && ED.est.id === id ? ED.est : S.estimates.find((e) => e.id === id));
  const est = live();
  if (!est) return;
  if (!aiOn()) { if (!auto) toast(isLocal() ? localAI.support.reason : 'Add your Anthropic API key in Settings → AI, or switch to the on-device AI', 5000); return; }
  if (!est.photos.length && (isLocal() || !est.job.description.trim())) { if (!auto) toast(isLocal() ? 'Add a photo first: the on-device AI reads photos' : 'Snap a photo or add a note first'); return; }
  if (auto && est.ai?.inputKey === aiKey(est)) return; // nothing new to look at
  if (AI.busy.has(id)) return;
  AI.busy.add(id);
  renderAiStatus();
  try {
    const photos = await Promise.all(est.photos.map(getPhoto));
    // on-device: photos are analyzed in this browser and never uploaded. cloud (opt-in): sent to Anthropic.
    const a = isLocal()
      ? interpret(await localAI.analyze(photos), { notes: est.job.description, division: est.job.division })
      : await analyzeJob({ apiKey: S.settings.ai.apiKey, model: S.settings.ai.model, notes: est.job.description, photos, division: est.job.division });
    const target = live();
    if (!target) return;
    const n = applyAiResult(target, a);
    if (ED && ED.est.id === id) {
      refreshEditorAfterFill();
      toast(n ? `✨ Analysis complete: filled in ${n} thing${n === 1 ? '' : 's'}. Review and send.` : '✨ Analysis complete. Nothing new to change.');
      if (S.settings.voice?.speak) {
        const c = compute(target);
        speak(`Quote ready. ${sayMoney(c.t.total)} to ${jobTitle(target.job).replace(/ ft /g, ' foot ').replace('Snow:', 'clear snow,')}. Tap send when you're ready.`);
      }
    } else {
      await persist(target);
    }
  } catch (err) {
    if (ED && ED.est.id === id) toast(err.message, 4500);
  } finally {
    AI.busy.delete(id);
    renderAiStatus();
  }
}

// The cloud analyzer gives single numbers; show them as estimates with its overall confidence.
function cloudAnalysis(a) {
  const c = { high: 0.8, medium: 0.6, low: 0.4 }[a.confidence] ?? 0.5;
  const t = a.tree?.trees?.[0];
  const rows = [];
  if (a.division === 'tree' && t) {
    rows.push({ key: 'count', label: 'Number of trees', value: String((a.tree.trees || []).reduce((n, x) => n + (x.qty || 1), 0)), confidence: c });
    if (t.species) rows.push({ key: 'species', label: 'Species', value: t.species, confidence: c });
    if (t.heightFt) rows.push({ key: 'height', label: 'Tree height', value: `About ${Math.round(t.heightFt * 0.9)}–${Math.round(t.heightFt * 1.1)} ft`, confidence: c });
    if (t.dbhIn) rows.push({ key: 'dbh', label: 'Trunk diameter', value: `About ${Math.round(t.dbhIn * 0.85)}–${Math.round(t.dbhIn * 1.15)} in`, confidence: c * 0.8 });
    if (t.condition) rows.push({ key: 'condition', label: 'Condition', value: t.condition, confidence: c });
    rows.push({ key: 'lean', label: 'Lean direction', value: 'Check on site', confidence: null });
  } else if (a.division === 'snow') {
    if (a.snow?.areaSqft) rows.push({ key: 'area', label: 'Paved area', value: `About ${Math.round(a.snow.areaSqft * 0.8).toLocaleString()}–${Math.round(a.snow.areaSqft * 1.2).toLocaleString()} sq ft`, confidence: c });
    if (a.snow?.depthIn) rows.push({ key: 'depth', label: 'Snow depth', value: `About ${a.snow.depthIn} in`, confidence: c });
    rows.push({ key: 'entrances', label: 'Entrances', value: 'Count on site', confidence: null });
  }
  return rows;
}

function applyAiResult(est, a) {
  const parsed = aiToParsed(a);
  const before = { job: structuredClone(est.job), customer: { ...est.customer } };
  est.locks ||= {};
  est.job = applyParsed(est.job, parsed, est.locks);
  const custChanges = [];
  for (const k of ['name', 'phone', 'email', 'address']) {
    const v = (parsed.customer?.[k] || '').trim();
    if (v && !est.customer[k] && !est.locks['customer.' + k]) {
      est.customer[k] = v;
      custChanges.push({ path: 'customer.' + k, label: k === 'address' ? 'Address' : cap(k), from: '—', to: v });
    }
  }
  const changes = [...custChanges, ...describeChanges(before.job, est.job)];
  const prev = est.ai;
  const keepPrev = !changes.length && prev?.changes?.length;
  if (!keepPrev) est.aiFields = changes.map((c) => c.path);
  else est.aiFields = (est.aiFields || []).filter((p) => !est.locks[p]);
  if (changes.length) est.selectedOption = null;
  est.ai = {
    engine: a.engine || 'cloud',
    at: new Date().toISOString(),
    inputKey: aiKey(est),
    confidence: a.confidence,
    customerSummary: a.customerSummary,
    observations: a.observations || [],
    missing: a.missing || [],
    photoCaptions: a.photoCaptions || [],
    upsells: (a.upsells || []).map((u) => ({ ...u, added: false })),
    conditions: (a.tree?.trees || []).map((t) => t.condition).filter(Boolean),
    analysis: a.analysis || cloudAnalysis(a),
    changes: keepPrev ? prev.changes : changes,
    undo: keepPrev ? prev.undo : before,
  };
  logHistory(est, changes.length ? `AI filled ${changes.length} field(s) from ${est.photos.length} photo(s)` : 'AI re-checked photos: no changes');
  return changes.length;
}

function aiStatusText(st = localAI.state) {
  if (!isLocal()) return S.settings.ai.apiKey ? '✨ Claude cloud AI is on (photos are sent to Anthropic)' : '';
  if (!localAI.support.ok) return '⚠ ' + localAI.support.reason;
  const where = st.backend === 'webgpu' ? 'GPU' : st.backend === 'wasm' ? 'CPU' : '';
  switch (st.phase) {
    case 'loading': return `Loading AI… ${st.progress || 0}%${st.mb && st.progress < 100 ? ` of ${st.mb} MB (one time only)` : ''}`;
    case 'downloaded': return '✓ On-device AI ready, works offline';
    case 'ready': return `✓ AI ready, works offline${where ? ` (${where})` : ''}`;
    case 'analyzing': return `Analyzing image ${st.index} of ${st.total}…`;
    case 'error': return '⚠ ' + st.message;
    default: return 'On-device AI: downloads the first time you analyze a photo';
  }
}
function renderAiChip() {
  const el = $('#aichip');
  if (el) el.textContent = aiStatusText();
}
localAI.onStatus(() => {
  renderAiChip();
  const el = $('#aistat');
  if (el) el.textContent = aiStatusText();
  if (ED && AI.busy.has(ED.est.id)) renderAiStatus();
});

// ---------------------------------------------------------------- fuel prices & auto pricing
// data/fuel.json is refreshed every day by .github/workflows/fuel.yml from the U.S. Energy
// Information Administration (free, no key). The raw GitHub copy is a backup while the site rebuilds.
const FUEL_URLS = ['data/fuel.json', 'https://raw.githubusercontent.com/LinKPlayt/quotesnap-/main/data/fuel.json'];
const FUEL = { data: null, fuel: null, loc: null, error: '', loading: null };
const usd2 = (n) => `$${(+n || 0).toFixed(2)}`;

function shopLoc() {
  const g = S.settings.geo.shop;
  const state = g?.state || stateFrom(g?.label) || stateFrom(S.settings.business.address) || null;
  return { lat: g?.lat ?? null, lon: g?.lon ?? null, state, hasShop: !!g };
}
function pickNow() {
  FUEL.loc = shopLoc();
  FUEL.fuel = pickFuel(FUEL.data, FUEL.loc, S.pricebook.auto?.pumpPrice || {});
  return FUEL.fuel;
}
function logAuto(done, why) {
  if (!done.length) return;
  const log = (S.pricebook.autoLog ||= []);
  log.unshift({ at: new Date().toISOString(), why, week: FUEL.fuel?.week || null, items: done.map((c) => ({ label: c.label, from: c.from, to: c.to, unit: c.unit })) });
  log.length = Math.min(log.length, 30);
}
// Apply chosen suggestions. Applying one also turns its daily auto-update back on.
async function applyPricing(changes, why = 'Auto pricing') {
  const done = applyChanges(S.company, S.pricebook, changes);
  const manual = S.pricebook.auto?.manual || {};
  for (const c of done) {
    if (c.target === 'pb') delete manual[c.path];
    else if (c.field === 'fuel') { const eq = S.company.equipment.find((x) => x.id === c.eqId); if (eq) eq.fuelManual = false; }
  }
  if (done.some((c) => c.target === 'equip')) S.company.sample = false;
  logAuto(done, why);
  await saveCompany();
  await savePricebook();
  return done;
}
function suggestNow() { return suggestPricing(S.company, S.pricebook, pickNow(), profileOf(S.pricebook)); }

async function refreshFuel({ force = false, quiet = false } = {}) {
  if (FUEL.loading) return FUEL.loading;
  FUEL.loading = (async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cache = S.settings.fuelCache;
    let data = cache?.data || null;
    FUEL.error = '';
    if (force || cache?.checked !== today || !data) {
      let got = false;
      for (const u of FUEL_URLS) {
        try {
          const r = await fetch(u, { cache: 'no-cache' });
          const d = r.ok ? await r.json() : null;
          if (d?.gas?.US) { got = true; if (!data || String(d.week || '') >= String(data.week || '')) data = d; }
        } catch { /* offline: try the next one, then keep the last prices we had */ }
      }
      if (got) { S.settings.fuelCache = { checked: today, data }; await saveSettings(); }
      else FUEL.error = data ? `Couldn't check for new fuel prices (offline?). Using the week of ${data.week}.` : "Couldn't load fuel prices (offline?).";
    }
    // the shop's state picks local prices: look it up once from the shop's position
    const g = S.settings.geo.shop;
    if (g && !g.state && Number.isFinite(+g.lat) && !stateFrom(g.label)) {
      const st = stateFrom(await reverseGeocode(g.lat, g.lon).catch(() => ''));
      if (st) { g.state = st; await saveSettings(); }
    }
    FUEL.data = data;
    pickNow();
    const P = profileOf(S.pricebook);
    if (FUEL.fuel && P.daily && (force || S.pricebook.auto?.lastDaily !== today)) {
      const done = await applyPricing(suggestNow().filter((c) => c.auto), 'Daily fuel update');
      (S.pricebook.auto ||= {}).lastDaily = today;
      await savePricebook();
      if (done.length && !quiet) toast(`⛽ Fuel costs updated for today: diesel ${usd2(FUEL.fuel.diesel.price)}, gas ${usd2(FUEL.fuel.gas.price)} a gallon (${FUEL.fuel.diesel.label})`, 5000);
      if (done.length && ED) renderResults();
    }
    return FUEL;
  })().finally(() => { FUEL.loading = null; });
  return FUEL.loading;
}

// ---------------------------------------------------------------- location

async function locateInto(est, { auto = false } = {}) {
  try {
    // automatic: where the photo was taken beats where the phone is now (gallery photos, back at the shop)
    const fromPhoto = auto && est.photoGeo;
    const pos = fromPhoto ? est.photoGeo : await getPosition();
    est.geo = { lat: pos.lat, lon: pos.lon, from: fromPhoto ? 'photo' : 'here' };
    let filled = false;
    if (!est.customer.address && !est.locks?.['customer.address']) {
      const addr = await reverseGeocode(pos.lat, pos.lon).catch(() => '');
      if (addr) { est.customer.address = addr; filled = true; (est.aiFields ||= []).push('customer.address'); }
      const known = addr && !est.customer.name && S.estimates.find((x) => x.id !== est.id && x.customer.name && normAddr(x.customer.address) === normAddr(addr));
      if (known) {
        for (const k of ['name', 'phone', 'email']) if (known.customer[k]) { est.customer[k] = known.customer[k]; est.aiFields.push('customer.' + k); }
        toast(`👋 Returning customer: ${known.customer.name}`, 4000);
        for (const k of ['name', 'phone', 'email']) { const inp = $(`[data-k="customer.${k}"]`); if (inp) inp.value = est.customer[k] || ''; }
      }
    }
    const shop = S.settings.geo.shop;
    if (shop && !est.locks?.['job.miles'] && !est.job.miles) {
      const d = await drivingMiles(shop, est.geo);
      if (d.miles <= 200) { est.job.miles = d.miles; est.milesInfo = { how: d.how, minutes: d.minutes || null, from: est.geo.from }; }
      else toast(`That spot is ${Math.round(d.miles).toLocaleString()} miles from your shop, so the distance was not filled in. Check the address.`, 5000);
    }
    if (ED && ED.est === est) {
      const inp = $('[data-k="customer.address"]');
      if (inp) inp.value = est.customer.address;
      const mi = $('[data-k="job.miles"]');
      if (mi) mi.value = est.job.miles || 0;
      markAi();
      changed();
      renderForecast();
    }
    if (filled || !auto) toast(filled ? `📍 Address filled in${fromPhoto ? " from the photo's location" : ''}: ${est.customer.address}` : '📍 Location saved for this job');
  } catch (err) {
    if (!auto) toast(err.message, 4000);
  }
}

async function milesFromAddress(est) {
  const shop = S.settings.geo.shop;
  if (!shop || !est.customer.address || est.locks?.['job.miles']) return;
  try {
    const g = await geocode(est.customer.address);
    est.geo = { lat: g.lat, lon: g.lon, from: 'address' };
    const d = await drivingMiles(shop, est.geo);
    if (d.miles > 200) { toast(`That address looks ${Math.round(d.miles).toLocaleString()} miles away, so the distance was not filled in. Check it.`, 5000); return; }
    est.job.miles = d.miles;
    est.milesInfo = { how: d.how, minutes: d.minutes || null, from: 'address' };
    const mi = $('[data-k="job.miles"]');
    if (mi) mi.value = est.job.miles;
    changed();
    renderForecast();
  } catch { /* address not found: leave miles alone */ }
}

// ---------------------------------------------------------------- router

let leaving = null;
// Screens change one at a time, and only the latest tap counts: fast taps or Back presses must never
// let a slow, older screen finish on top of the newer one (that left blank pages and lost drafts).
let routeSeq = 0;
let routeChain = Promise.resolve();
function route() {
  const my = ++routeSeq;
  const run = () => (my === routeSeq ? routeNow(my) : null);
  // a screen that hangs must not freeze navigation: move on after 8 s
  routeChain = routeChain.then(() => Promise.race([run(), new Promise((r) => setTimeout(r, 8000))])).catch((err) => console.error(err));
  return routeChain;
}
async function routeNow(my) {
  if (leaving) { const l = leaving; leaving = null; await l(); }
  if (my !== routeSeq) return;
  // a send / sign window left open must not act on a screen that is gone
  const md = $('#modal'); if (md?.open) md.close();
  const [path, query] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  const q = new URLSearchParams(query || '');
  const name = parts[0] || 'dashboard';
  $$('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name || (name === 'e' && a.dataset.route === 'estimates')));
  window.scrollTo(0, 0);
  if (name === 'dashboard') return viewDashboard();
  if (name === 'new') {
    const e = newEstimate(q.get('d') || 'tree', q.get('c') ? JSON.parse(q.get('c')) : null);
    await saveSettings();
    await persist(e);
    // they already went to another screen: drop this blank draft instead of yanking them back to it
    if (my !== routeSeq && !location.hash.startsWith('#/new')) { S.estimates = S.estimates.filter((x) => x.id !== e.id); return saveEstimates(); }
    return location.replace('#/e/' + e.id);
  }
  if (name === 'e') return viewEditor(parts[1]);
  if (name === 'doc') return viewDoc(parts[1], q.get('t') || 'quote');
  if (name === 'estimates') return viewList(q.get('s') || 'all');
  if (name === 'customers') return viewCustomers();
  if (name === 'pricebook') { if (!S.settings.seen?.pricebook) { (S.settings.seen ||= {}).pricebook = true; saveSettings(); } viewPricing(pageCtx()); return runTips('pricebook'); }
  if (name === 'resources') { viewResources(pageCtx()); return runTips('resources'); }
  if (name === 'rates') { viewRates(pageCtx()); return runTips('rates'); }
  if (name === 'settings') return viewSettings();
  app.innerHTML = '<div class="empty">Not found. <a href="#/">Go home</a></div>';
}

// Create a quote straight from camera photos, then open it and let the AI fill it in.
async function createFromPhotos(files) {
  if (!files.length) return;
  toast('📸 Saving photos…');
  const e = newEstimate('tree');
  await addPhotos(e, files);
  logHistory(e, `Snapped ${e.photos.length} photo(s)`);
  await saveSettings();
  await persist(e);
  pendingSnap.add(e.id);
  location.hash = '#/e/' + e.id;
}

// ---------------------------------------------------------------- dashboard

function stats() {
  const E = S.estimates.filter((e) => !isEmptyDraft(e));
  const won = E.filter((e) => WON.includes(e.status));
  const decided = won.length + E.filter((e) => e.status === 'declined').length;
  const month = new Date().toISOString().slice(0, 7);
  const sent = E.filter((e) => e.status === 'sent');
  const t = today();
  const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  return {
    E, won, sent,
    pipeline: sent.reduce((s, e) => s + (e.summary?.total || 0), 0),
    wonMonth: won.filter((e) => (e.acceptedAt || e.updatedAt).startsWith(month)).reduce((s, e) => s + (e.summary?.total || 0), 0),
    profitMonth: won.filter((e) => (e.acceptedAt || e.updatedAt).startsWith(month)).reduce((s, e) => s + (e.summary?.profit || 0), 0),
    winRate: decided ? Math.round((won.length / decided) * 100) : null,
    avgMargin: won.length ? Math.round(won.reduce((s, e) => s + (e.summary?.margin || 0), 0) / won.length) : null,
    profitWon: won.reduce((s, e) => s + (e.summary?.profit || 0), 0),
    followUps: sent.filter((e) => daysAgo(e.sentAt || e.updatedAt) >= S.settings.followUpDays),
    upcoming: E.filter((e) => e.scheduledFor && e.scheduledFor >= t && e.scheduledFor <= in14 && !['completed', 'paid', 'declined'].includes(e.status)).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)),
    snowClients: won.filter((e) => e.job.division === 'snow' && e.status !== 'paid'),
  };
}

// One short checklist instead of several reminders. It disappears once everything is done.
function setupCard() {
  const biz = S.settings.business;
  const steps = [
    { done: biz.name !== DEFAULT_SETTINGS.business.name && !!biz.phone, href: '#/settings', t: 'Add your business name and phone', d: 'Shown at the top of every quote' },
    { done: !S.company.sample, href: '#/resources', t: 'Add your crew and machines', d: 'Quotes use a sample crew until you do' },
    { done: !!S.settings.seen?.pricebook, href: '#/pricebook', t: 'Check your prices', d: 'Profit margin, tax and smallest job' },
    { done: S.estimates.some((e) => e.status !== 'draft'), href: '#/new?d=tree', t: 'Send your first quote', d: 'Snap a photo, check the price, tap Send' },
  ];
  const left = steps.filter((x) => !x.done).length;
  if (!left) return '';
  return `<div class="card setup"><h2>🚀 Finish setting up <span class="muted small">${steps.length - left} of ${steps.length} done</span></h2>
    <div class="progress"><i style="width:${((steps.length - left) / steps.length) * 100}%"></i></div>
    ${steps.map((x) => `<a class="setup-step ${x.done ? 'done' : ''}" href="${x.href}"><span class="tick">${x.done ? '✓' : ''}</span><span><b>${x.t}</b><span class="tiny muted">${x.d}</span></span><span class="go">›</span></a>`).join('')}
  </div>`;
}

function itemRow(e, extra = '') {
  const icon = e.job.division === 'snow' ? '❄' : '🌳';
  const busy = AI.busy.has(e.id) ? ' <span class="badge ai">✨ analyzing</span>' : '';
  return `<a class="item" href="#/e/${e.id}">
    <div class="thumb" data-photo="${e.photos[0] || ''}">${icon}</div>
    <div class="main">
      <div class="title">${esc(e.customer.name || e.customer.address || 'New job')} <span class="muted small">· ${esc(e.number)}</span>${busy}</div>
      <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${extra || esc(e.summary?.title || '')}</div>
    </div>
    <div class="right"><div class="amt">${money(e.summary?.total || 0)}</div><span class="badge ${e.status}">${e.status}</span></div>
  </a>`;
}

async function hydrateThumbs(root = app) {
  for (const el of $$('[data-photo]', root)) {
    const id = el.dataset.photo;
    if (!id) continue;
    const src = await getPhoto(id);
    if (src) el.innerHTML = `<img class="thumb" src="${src}" alt="">`;
  }
}

function viewDashboard() {
  const st = stats();
  const biz = S.settings.business.name;
  const h = new Date().getHours();
  app.innerHTML = `
    <div class="row" style="margin-bottom:.75rem">
      <div><h1>Good ${h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'}</h1><div class="muted">${esc(biz)}</div></div>
    </div>

    <div class="hero card">
      <label class="snap-btn">
        <input type="file" accept="image/*" capture="environment" multiple hidden id="snapcam">
        <span class="snap-icon">📸</span>
        <span><b>Snap a job</b><br><span class="small">${aiOn() ? 'Take photos and AI fills in the quote' : 'Take photos to start a quote'}</span></span>
      </label>
      <div class="hero-alt">
        <label class="btn"><input type="file" accept="image/*" multiple hidden id="snapgal">🖼 From photos</label>
        <a class="btn" href="#/new?d=tree">🌳 Tree quote</a>
        <a class="btn snowbtn" href="#/new?d=snow">❄ Snow quote</a>
      </div>
      <div class="tiny muted" id="aichip" style="margin-top:.6rem"></div>
      ${aiOn() ? '' : isLocal()
        ? `<div class="callout small" style="margin-top:.75rem">⚠ ${esc(localAI.support.reason)}</div>`
        : `<div class="callout ai small" style="margin-top:.75rem">✨ <b>Turn on automatic photo analysis.</b> Add an Anthropic API key in <a href="#/settings">Settings</a>, or switch to the free on-device AI.</div>`}
    </div>

    ${setupCard()}
    <div id="wx"></div>

    <div class="kpis">
      <div class="kpi"><div class="l">Open pipeline</div><div class="v">${money(st.pipeline)}</div><div class="muted small">${st.sent.length} quotes awaiting reply</div></div>
      <div class="kpi"><div class="l">Profit this month</div><div class="v">${money(st.profitMonth)}</div><div class="muted small">${money(st.wonMonth)} in accepted quotes · ${money(st.profitWon)} all-time</div></div>
      <div class="kpi"><div class="l">Win rate</div><div class="v">${st.winRate == null ? '—' : st.winRate + '%'}</div><div class="muted small">accepted vs declined</div></div>
      <div class="kpi"><div class="l">Avg margin won</div><div class="v">${st.avgMargin == null ? '—' : st.avgMargin + '%'}</div><div class="muted small">target ${S.pricebook.targetMarginPct}%</div></div>
    </div>
    ${st.upcoming.length ? `<div class="card"><h2>📅 Coming up</h2><div class="list">${st.upcoming.slice(0, 8).map((e) => itemRow(e, `<b>${esc(fmtDate(e.scheduledFor))}</b> · ${esc(e.summary?.title || '')}`)).join('')}</div></div>` : ''}
    ${st.followUps.length ? `<div class="card"><h2>⏰ Follow up today <span class="badge sent">${st.followUps.length}</span></h2>
      <p class="muted small">Sent ${S.settings.followUpDays}+ days ago with no answer. A quick follow-up wins a lot of jobs.</p>
      <div class="list">${st.followUps.slice(0, 6).map((e) => itemRow(e)).join('')}</div></div>` : ''}
    <div class="card"><h2>Recent quotes</h2>
      ${st.E.length ? `<div class="list">${st.E.slice(0, 8).map((e) => itemRow(e)).join('')}</div>` : `
      <div class="empty">
        <div style="font-size:2.5rem">📸</div>
        <h2>Snap your first job</h2>
        <p>Tap <b>Snap a job</b>, take a few photos of the tree or the driveway, and QuoteSnap builds the scope, labor, equipment, materials, price and a PDF quote.</p>
      </div>`}
    </div>
  `;
  for (const id of ['snapcam', 'snapgal']) $('#' + id).onchange = (ev) => createFromPhotos([...ev.target.files]);
  renderAiChip();
  runTips('dashboard');
  hydrateThumbs();
  renderWeather(st);
}

async function renderWeather(st) {
  const box = $('#wx');
  if (!box) return;
  const loc = S.settings.geo.shop || S.settings.geo.home;
  if (!loc) {
    box.innerHTML = `<div class="card row"><div class="main" style="flex:1"><b>🌨 Storm & snow alerts</b><div class="muted small">See snow totals and high-wind days for the week, so you can line up plow routes and storm crews.</div></div><button class="btn" id="wxon">Turn on</button></div>`;
    $('#wxon').onclick = async () => {
      try {
        const p = await getPosition();
        S.settings.geo.home = { lat: p.lat, lon: p.lon };
        await saveSettings();
        renderWeather(st);
      } catch (err) { toast(err.message, 4000); }
    };
    return;
  }
  box.innerHTML = '<div class="card muted small">Loading forecast…</div>';
  try {
    const days = await forecast(loc.lat, loc.lon);
    if (!$('#wx')) return;
    const alerts = stormAlerts(days);
    const snowAlert = alerts.find((a) => a.kind === 'snow');
    box.innerHTML = `<div class="card">
      <div class="row"><h2 style="margin:0">🌨 This week</h2><div class="spacer"></div><span class="muted small">${esc(S.settings.geo.shop?.label?.split(',')[0] || 'Your area')}</span></div>
      <div class="fc">${days.map((d) => `<div class="fd ${d.snowIn >= 1 ? 'snowy' : ''} ${d.gustMph >= 40 ? 'windy' : ''}"><div class="small muted">${dayName(d.date)}</div>
        <div class="fi">${d.snowIn >= 1 ? '❄' : d.gustMph >= 40 ? '🌬' : d.rainIn >= 0.2 ? '🌧' : '☀'}</div>
        <div class="small"><b>${d.snowIn ? d.snowIn + '"' : '–'}</b></div><div class="tiny muted">${d.gustMph} mph</div></div>`).join('')}</div>
      ${alerts.map((a) => `<div class="callout ${a.level === 'high' ? '' : 'ai'} small">${a.kind === 'snow' ? '❄' : a.kind === 'wind' ? '🌬' : '🧊'} ${esc(a.text)}${a.kind === 'snow' && st.snowClients.length ? `: ${st.snowClients.length} snow customer${st.snowClients.length > 1 ? 's' : ''} on your list` : ''}</div>`).join('')}
      ${snowAlert ? '<a class="btn sm" href="#/new?d=snow">❄ Quote snow work before the storm</a>' : ''}
    </div>`;
  } catch {
    box.innerHTML = '';
  }
}

// ---------------------------------------------------------------- list

function viewList(filter) {
  const draw = () => {
    const qv = ($('#q')?.value || '').toLowerCase();
    const rows = S.estimates
      .filter((e) => !isEmptyDraft(e))
      .filter((e) => filter === 'all' || e.status === filter || (filter === 'won' && WON.includes(e.status)))
      .filter((e) => !qv || [e.customer.name, e.customer.address, e.number, e.summary?.title, e.customer.phone].join(' ').toLowerCase().includes(qv));
    $('#rows').innerHTML = rows.length ? rows.map((e) => itemRow(e)).join('') : S.estimates.length ? '<div class="empty">No quotes match. <a href="#/estimates">Show all</a></div>' : '<div class="empty"><div style="font-size:2.2rem">📋</div><b>No quotes yet</b><div class="small" style="margin:.3rem 0 .8rem">Snap a photo of the job and the quote fills itself in.</div><a class="btn primary big" href="#/new?d=tree">🌳 New tree quote</a> <a class="btn big" href="#/new?d=snow">❄ New snow quote</a></div>';
    hydrateThumbs($('#rows'));
  };
  app.innerHTML = `
    <div class="row" style="margin-bottom:.75rem"><h1>Quotes</h1><div class="spacer"></div>
      <button class="btn sm" id="csv">Export CSV</button></div>
    <input id="q" placeholder="Search name, address, quote #…" style="margin-bottom:.6rem">
    <div class="chips filters" style="margin-bottom:.75rem" role="tablist" aria-label="Filter quotes by stage">
      ${['all', ...STATUSES].map((s) => { const n = s === 'all' ? S.estimates.length : S.estimates.filter((x) => x.status === s).length; return `<a class="chip ${s === filter ? 'on' : ''}" role="tab" aria-selected="${s === filter}" href="#/estimates?s=${s}">${cap(s)}${n ? ` <span class="cnt">${n}</span>` : ''}</a>`; }).join('')}
    </div>
    <div class="card"><div class="list" id="rows"></div></div>`;
  $('#q').addEventListener('input', draw);
  $('#csv').onclick = exportCsv;
  draw();
}

function exportCsv() {
  const head = ['Quote', 'Created', 'Status', 'Division', 'Customer', 'Phone', 'Email', 'Address', 'Job', 'Option', 'Total', 'Est. profit', 'Margin %', 'Scheduled'];
  const rows = S.estimates.filter((e) => !isEmptyDraft(e)).map((e) => [
    e.number, e.createdAt.slice(0, 10), e.status, e.job.division, e.customer.name, e.customer.phone, e.customer.email, e.customer.address,
    e.summary?.title, e.summary?.option, e.summary?.total, Math.round(e.summary?.profit || 0), e.summary?.margin, e.scheduledFor || '',
  ]);
  const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  download(new Blob([csv], { type: 'text/csv' }), `quotesnap-${today()}.csv`);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------------------------------------------------------- customers

function viewCustomers() {
  const map = new Map();
  for (const e of S.estimates.filter((x) => !isEmptyDraft(x) && x.customer.name)) {
    const k = (e.customer.name + '|' + (e.customer.phone || '')).toLowerCase();
    const c = map.get(k) || { ...e.customer, quotes: [], won: 0 };
    c.quotes.push(e);
    if (WON.includes(e.status)) c.won += e.summary?.total || 0;
    if (!c.address && e.customer.address) c.address = e.customer.address;
    map.set(k, c);
  }
  const list = [...map.values()].sort((a, b) => b.won - a.won);
  app.innerHTML = `<h1>Customers</h1><p class="muted">Built automatically from your quotes.</p>
    <div class="card">${list.length ? `<div class="list">${list.map((c, i) => `
      <div class="item">
        <div class="thumb">${esc(c.name[0] || '?')}</div>
        <div class="main"><div class="title">${esc(c.name)}</div>
          <div class="muted small">${esc([c.phone, c.email, c.address].filter(Boolean).join(' · '))}</div>
          <div class="small">${c.quotes.map((q) => `<a href="#/e/${q.id}">${esc(q.number)}</a> <span class="badge ${q.status}">${q.status}</span>`).join(' ')}</div>
        </div>
        <div class="right"><div class="amt">${money(c.won)}</div><div class="muted small">lifetime won</div>
          <div class="row" style="justify-content:flex-end;margin-top:.3rem">
            ${c.phone ? `<a class="btn sm" href="tel:${esc(c.phone)}">Call</a>` : ''}
            <button class="btn sm" data-newfor="${i}">+ Quote</button></div></div>
      </div>`).join('')}</div>` : '<div class="empty">No customers yet. They appear here once you save a quote with a name.</div>'}</div>`;
  $$('[data-newfor]').forEach((b) => (b.onclick = () => {
    const c = list[+b.dataset.newfor];
    const d = c.quotes[0].job.division;
    location.hash = `#/new?d=${d}&c=${encodeURIComponent(JSON.stringify({ name: c.name, phone: c.phone, email: c.email, address: c.address }))}`;
  }));
}

// ---------------------------------------------------------------- editor

let ED = null; // { est, tab }

// "3 people · about 22 hours (3 days)" instead of "3 crew × 22.06 h + 3.79 h grinding"
function plainTime(x) {
  const h = (+x.siteHours || 0) + (+x.grindHours || 0);
  const hours = h < 1 ? `about ${Math.max(5, Math.round((h * 60) / 5) * 5)} min` : `about ${h < 10 ? Math.round(h * 2) / 2 : Math.round(h)} hours`;
  const days = x.days > 1 ? ` (${x.days} days)` : '';
  return `${x.labor.crew} ${x.labor.crew === 1 ? 'person' : 'people'} · ${hours}${days}`;
}
function opt(value, label, cur) { return `<option value="${value}" ${String(cur) === String(value) ? 'selected' : ''}>${label}</option>`; }
function field(label, k, val, attrs = '') { return `<label class="f">${label}<input data-k="${k}" value="${esc(val ?? '')}" ${attrs}></label>`; }
function numField(label, k, val, attrs = '') { return field(label, k, val, `type="number" inputmode="decimal" data-type="num" ${attrs}`); }
const COMMON_CONDITIONS = {
  tree: ['largeLogs', 'steepSlope', 'limitedAccess', 'narrowGate', 'heavyCleanup'],
  snow: ['heavySnow', 'ice', 'steepSlope', 'tightAreas', 'snowPiles'],
};
function check(label, k, val) { return `<label class="chip"><input type="checkbox" data-k="${k}" data-type="bool" ${val ? 'checked' : ''}>${label}</label>`; }

const HEIGHTS = [15, 25, 35, 45, 60, 75, 90];
const QUICK_SPECIES = ['oak', 'maple', 'pine', 'ash', 'spruce', 'elm', 'birch', 'willow'];
const AREAS = [['1-car', 500], ['2-car', 1000], ['3-car', 1500], ['Long drive', 2500], ['Small lot', 10000], ['1 acre', 43560]];

async function viewEditor(id) {
  const est = S.estimates.find((e) => e.id === id);
  if (!est) { app.innerHTML = '<div class="empty">Quote not found. <a href="#/estimates">Back to quotes</a></div>'; return; }
  ED = { est: structuredClone(est), tab: 'plan' };
  const e = ED.est;
  e.locks ||= {};
  e.aiFields ||= [];
  leaving = async () => {
    document.body.classList.remove('has-sendbar');
    await flushSave();
    const cur = S.estimates.find((x) => x.id === id);
    // an untouched draft is thrown away, unless the screen is just refreshing or opening its own quote / job sheet
    if (isEmptyDraft(cur) && !location.hash.includes(id)) { S.estimates = S.estimates.filter((x) => x.id !== id); await saveEstimates(); }
  };
  const customers = [...new Map(S.estimates.filter((x) => x.customer.name).map((x) => [x.customer.name, x.customer])).values()];
  const contacts = 'contacts' in navigator && 'ContactsManager' in window;
  app.innerHTML = `
    <div class="row no-print" style="margin-bottom:.5rem">
      <a class="btn sm" href="#/estimates" aria-label="Back to quotes">← Quotes</a>
      <h1 style="margin:0">${esc(e.number)}</h1>
      <label class="stage">Stage <select id="status" style="width:auto">${STATUSES.map((s) => opt(s, cap(s), e.status)).join('')}</select></label>
      <div class="spacer"></div><span class="muted small" id="saved">Saved</span>
    </div>
    <div class="stepbar no-print" id="stepbar"></div>
    <div class="editor">
      <div>
        <div class="card" id="card-photos">
          <h2>📸 Photos</h2>
          <div class="photos" id="photos"></div>
          <div class="muted tiny" style="margin-top:.4rem">Best results: 1 photo of the whole tree with the house or a person for scale · 1 trunk close-up · 1 of the access path. For snow: the whole driveway or lot.</div>
          <div id="aistatus"></div>
          <div id="aiout"></div>
          <h3>Notes <span class="muted small">(optional: AI and the estimator read these)</span></h3>
          <textarea data-k="job.description" id="desc" placeholder="Talk or type anything extra: “Customer wants it gone before June, haul everything, Dana 555-0142”">${esc(e.job.description)}</textarea>
          <div class="muted tiny" id="noteshint"></div>
          <div class="row" style="margin-top:.5rem">
            <button class="btn" id="mic">🎤 Talk</button>
            <button class="btn ai-btn" id="aibtn">✨ ${e.ai ? 'Re-analyze' : 'Analyze photos'}</button>
          </div>
        </div>

        <div class="card" id="card-customer">
          <div class="row" style="margin-bottom:.6rem"><h2 style="margin:0">👤 Customer</h2><div class="spacer"></div>
            ${contacts ? '<button class="btn sm" id="pickc">📇 From contacts</button>' : ''}</div>
          <div class="grid g2 stack">
            <label class="f">Name<input data-k="customer.name" list="custlist" value="${esc(e.customer.name)}" autocomplete="off"></label>
            ${field('Phone', 'customer.phone', e.customer.phone, 'type="tel" inputmode="tel"')}
            ${field('Email', 'customer.email', e.customer.email, 'type="email"')}
            <label class="f">Job site address<div class="row" style="flex-wrap:nowrap"><input data-k="customer.address" value="${esc(e.customer.address)}"><button class="btn sm" id="here" title="Use my location">📍</button></div></label>
          </div>
          <datalist id="custlist">${customers.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
          <div id="maplink" style="margin-top:.5rem"></div>
        </div>

        <div class="card" id="card-details">
          <div class="row" style="margin-bottom:.75rem"><h2 style="margin:0">🧾 Job details</h2><div class="spacer"></div>
            <div class="seg ${e.job.division === 'snow' ? 'snow' : ''}" id="div">
              <button data-d="tree" class="${e.job.division === 'tree' ? 'on' : ''}">🌳 Tree</button>
              <button data-d="snow" class="${e.job.division === 'snow' ? 'on' : ''}">❄ Snow</button>
            </div></div>
          <div id="qcall"></div>
          <div id="details"></div>
          <details class="fold" ${S.settings.simple ? '' : 'open'}><summary>📍 Distance, ${S.settings.simple ? '' : 'difficulty, '}rush or weekend work</summary>
          <div class="grid g3 siteflags" style="margin-top:.5rem">
            ${numField('Distance (miles)', 'job.miles', e.job.miles)}
            <div class="tiny muted" id="milesnote" style="grid-column:1/-1;margin-top:-.2rem"></div>
            <div id="siteflags" style="display:contents"></div>
          </div></details>
        </div>

        <details class="card fold" ${S.settings.simple ? '' : 'open'}>
          <summary><b>➕ Extra charges, discount, private notes</b></summary>
          <div id="adjs"></div>
          <div class="row" style="margin-top:.5rem">
            <button class="btn sm" id="addadj">+ Custom line item</button>
            <div class="spacer"></div>
            <label class="f" style="width:140px">Discount ($)<input data-k="discount" type="number" inputmode="decimal" data-type="num" value="${e.discount || ''}"></label>
          </div>
          <h3>Internal notes (not on quote)</h3>
          <textarea data-k="notes" placeholder="Gate code, dog in yard, wants work before June…">${esc(e.notes)}</textarea>
        </details>
      </div>

      <div class="results">
        <div class="card" id="card-price">
          <div id="res-top"></div>
          <details class="fold" ${S.settings.simple ? '' : 'open'}><summary>🔍 How this price was worked out</summary>
          <label class="f" style="margin-top:.5rem">Target margin: <b id="mval"></b>
            <input type="range" min="10" max="60" step="1" id="margin" value="${e.marginPct ?? pricingFor(e).pb.targetMarginPct}"></label>
          <div id="res"></div></details>
        </div>
        <div class="card" id="card-send">
          <h2>📤 Send & finish</h2>
          <button class="btn accent block big" id="send">✉ Send quote to customer</button>
          <div class="actions" style="margin-top:.5rem">
            <a class="btn" href="#/doc/${e.id}?t=quote">📄 View quote</a>
            <button class="btn" id="sign">✍ Customer signs</button>
            <a class="btn" href="#/doc/${e.id}?t=jobsheet">👷 Crew job sheet</a>
            <a class="btn" href="#/doc/${e.id}?t=invoice">💵 Invoice</a>
          </div>
          <div id="sched"></div>
          <div id="actual"></div>
          <div class="row" style="margin-top:.75rem"><button class="btn sm" id="dup">⧉ Duplicate</button><div class="spacer"></div><button class="btn sm danger" id="del">Delete quote</button></div>
          <h3>History</h3>
          <div class="small muted" id="hist"></div>
        </div>
      </div>
    </div>
    <div class="sendbar no-print" id="sendbar"></div>`;
  document.body.classList.add('has-sendbar');

  renderPhotos();
  renderCustomerExtras();
  renderDetails();
  renderAdjustments();
  renderAiStatus();
  renderAiOut();
  renderResults();
  renderSchedule();
  renderHistory();
  wireEditor();

  if (pendingSnap.has(id)) {
    pendingSnap.delete(id);
    const located = S.settings.geo.autoLocate ? locateInto(e, { auto: true }) : Promise.resolve();
    if (aiOn() && S.settings.ai.auto) runAi(id, { auto: true });
    // ask who it's for while the photos are checked (after location, which may recognize a returning customer)
    located.finally(() => setTimeout(async () => {
      if (!ED || ED.est !== e) return;
      const pick = !e.customer.name && !e.customer.phone ? await askCustomer(e) : null;
      if (pick === 'type' || !S.settings.askQuestions) return; // they're typing: don't cover the keyboard
      // wait for the photo check (up to 30 s) so the questions start from what the AI saw
      for (let i = 0; i < 60 && AI.busy.has(e.id); i++) await new Promise((r) => setTimeout(r, 500));
      if (ED && ED.est === e && questionSummary(e, qctx(e)).openRequired) askQuestions(e, { auto: true });
    }, 300));
  } else {
    if (aiOn() && S.settings.ai.auto && e.photos.length && !e.ai) scheduleAi(e, 300);
    runTips('editor');
  }
}

// Step bar + bottom Send bar: always show what's done and what to do next.
function renderSteps() {
  const e = ED?.est;
  const bar = $('#stepbar');
  if (!e || !bar) return;
  const st = {
    photos: e.photos.length > 0 || !!e.job.description,
    customer: !!(e.customer.name && (e.customer.phone || e.customer.email)),
    details: questionSummary(e, qctx(e)).openRequired === 0,
    send: e.status !== 'draft',
  };
  st.price = st.photos && st.details;
  const items = [['photos', '📸', 'Photos', 'card-photos'], ['customer', '👤', 'Customer', 'card-customer'], ['details', '🧾', 'Details', 'card-details'], ['price', '💲', 'Price', 'card-price'], ['send', '📤', 'Send', 'card-send']];
  const current = items.find(([k]) => !st[k])?.[0];
  bar.innerHTML = items.map(([k, icon, label, target], i) => `<button class="step ${st[k] ? 'done' : ''} ${k === current ? 'now' : ''}" data-go="${target}" data-step="${k}"><span class="step-n">${st[k] ? '✓' : i + 1}</span><span class="step-l">${label}</span></button>`).join('');
  bar.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => {
    if (b.dataset.step === 'customer' && !st.customer) { askCustomer(e); return; }
    if (b.dataset.step === 'details' && !st.details) { askQuestions(e); return; }
    if (b.dataset.step === 'send') { $('#send')?.click(); return; }
    document.getElementById(b.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  renderQuestionCall();
  const { t } = compute(e);
  const sb = $('#sendbar');
  if (!sb) return;
  const openReq = questionSummary(e, qctx(e)).openRequired;
  const hint = !st.photos ? 'Next: add a photo' : !st.customer ? 'Next: who is it for?' : openReq && e.status === 'draft' ? `Next: ${openReq} quick question${openReq === 1 ? '' : 's'}` : e.status === 'draft' ? 'Ready to send' : `${e.pricedRef ? '🔒 Price locked · ' : ''}Stage: ${cap(e.status)}`;
  sb.innerHTML = `<div class="sb-price"><div class="sb-total">${money(t.total)}</div><div class="tiny muted">${esc(hint)}</div></div>
    ${!st.customer ? '<button class="btn big" id="sb-cust">👤 Customer</button>' : openReq && e.status === 'draft' ? '<button class="btn big" id="sb-q">❓ Questions</button>' : ''}
    <button class="btn accent big" id="sb-send">✉ Send</button>`;
  $('#sb-send').onclick = async () => {
    if (!st.customer && !(await ask("You haven't added the customer's phone or email yet. Send anyway?", { ok: 'Send anyway', cancel: 'Add customer' }))) { askCustomer(e); return; }
    if (ED?.est !== e) return;
    const left = e.status === 'draft' ? questionSummary(e, qctx(e)).openRequired : 0;
    if (left && !(await ask(`${left} question${left === 1 ? '' : 's'} the price depends on ${left === 1 ? "hasn't" : "haven't"} been answered, so the price may be off. Send anyway?`, { ok: 'Send anyway', cancel: 'Answer them' }))) { askQuestions(e); return; }
    if (ED?.est !== e) return; $('#send')?.click();
  };
  const sq = $('#sb-q');
  if (sq) sq.onclick = () => askQuestions(e);
  const sc = $('#sb-cust');
  if (sc) sc.onclick = () => askCustomer(e);
}

// ---- photos + AI panels

async function renderPhotos() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  const box = $('#photos');
  const imgs = await Promise.all(e.photos.map(getPhoto));
  if (!ED || ED.est !== e) return;
  const caps = e.ai?.photoCaptions || [];
  box.innerHTML = e.photos.map((id, i) => `<figure class="photo"><img src="${imgs[i] || ''}" alt="Job photo ${i + 1}">
      <button data-rm="${id}" aria-label="Remove photo">×</button>${caps[i] ? `<figcaption>${esc(caps[i])}</figcaption>` : ''}</figure>`).join('') +
    `<label class="photo add"><input type="file" accept="image/*" capture="environment" multiple id="file">📷<br>Camera</label>
     <label class="photo add"><input type="file" accept="image/*" multiple id="file2">🖼<br>Photos</label>`;
  const onFiles = async (ev) => {
    const files = [...ev.target.files];
    const hadSpot = !!e.photoGeo;
    const n = await addPhotos(e, files);
    if (!n) return;
    // first photo with a location and no address yet: fill in the address and distance from it
    if (!hadSpot && e.photoGeo && !e.customer.address && S.settings.geo.autoLocate) locateInto(e, { auto: true });
    changed();
    renderPhotos();
    scheduleAi(e);
    if (aiOn() && S.settings.ai.auto) renderAiStatus(true);
  };
  $('#file').onchange = onFiles;
  $('#file2').onchange = onFiles;
  $$('[data-rm]', box).forEach((b) => (b.onclick = async () => {
    const idx = e.photos.indexOf(b.dataset.rm);
    e.photos = e.photos.filter((p) => p !== b.dataset.rm);
    if (e.ai?.photoCaptions && idx >= 0) e.ai.photoCaptions.splice(idx, 1);
    await kv.del('photo:' + b.dataset.rm);
    changed();
    renderPhotos();
  }));
}

function renderAiStatus(queued = false) {
  const el = $('#aistatus');
  if (!el || !ED) return;
  const e = ED.est;
  if (AI.busy.has(e.id) || queued) {
    let text = `✨ Looking at ${e.photos.length} photo${e.photos.length === 1 ? '' : 's'}… measuring, spotting hazards, filling in the quote (usually 10–40 s). You can keep working.`;
    if (isLocal()) {
      const st = localAI.state;
      text = st.phase === 'loading'
        ? `Loading AI… ${st.progress || 0}%${st.mb && st.progress < 100 ? ` (one-time ${st.mb} MB download, then it works offline)` : ''}`
        : st.phase === 'analyzing' ? `Analyzing image ${st.index} of ${st.total} on this device…` : 'Analyzing image on this device…';
    }
    el.innerHTML = `<div class="ai-status"><span class="spin"></span> ${text}</div>`;
  } else if (isLocal() && localAI.state.phase === 'error' && ED.est.photos.length) {
    el.innerHTML = `<div class="callout small">⚠ ${esc(localAI.state.message)} <button class="btn sm" id="airetry">Try again</button></div>`;
    $('#airetry').onclick = () => runAi(e.id, { auto: false });
  } else el.innerHTML = '';
  const btn = $('#aibtn');
  if (btn) { btn.disabled = AI.busy.has(e.id); btn.textContent = AI.busy.has(e.id) ? '✨ Analyzing…' : e.ai ? '✨ Re-analyze' : '✨ Analyze photos'; }
}

function renderAiOut() {
  const el = $('#aiout');
  if (!el || !ED) return;
  const e = ED.est;
  const a = e.ai;
  if (!a) {
    el.innerHTML = aiOn()
      ? (e.photos.length ? '' : `<div class="callout ai small">📸 Add photos and AI fills in the job by itself. No typing needed.${isLocal() ? ' Runs on this device: free, private, works offline.' : ''}</div>`)
      : isLocal()
        ? `<div class="callout small">⚠ ${esc(localAI.support.reason)}</div>`
        : '<div class="callout ai small">✨ <b>Want this filled in automatically?</b> Add an Anthropic API key in <a href="#/settings">Settings → AI</a>, or switch to the free on-device AI.</div>';
    return;
  }
  const conf = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence: double-check' }[a.confidence] || '';
  el.innerHTML = `<div class="ai-card">
    <div class="row"><b>✨ ${a.engine === 'local' ? 'On-device AI' : 'AI'} filled in ${a.changes.length} thing${a.changes.length === 1 ? '' : 's'}</b>${conf ? `<span class="badge conf-${a.confidence}">${conf}</span>` : ''}<div class="spacer"></div>
      ${a.undo ? '<button class="btn sm" id="aiundo">Undo</button>' : ''}</div>
    ${a.changes.length ? `<div class="chips" style="margin:.5rem 0">${a.changes.slice(0, 18).map((c) => `<span class="ai-chip"><span class="muted">${esc(c.label)}</span> ${esc(c.to)}</span>`).join('')}</div>` : ''}
    ${a.customerSummary ? `<div class="small" style="margin:.35rem 0">${esc(a.customerSummary)}</div>` : ''}
    ${a.missing?.length ? `<div class="callout small">Please confirm: ${a.missing.map(esc).join(' · ')}</div>` : ''}
    ${a.upsells?.length ? `<div class="upsells"><div class="tiny muted" style="margin:.4rem 0 .2rem">EXTRA WORK TO OFFER</div>${a.upsells.map((u, i) => `
      <div class="upsell"><div style="flex:1"><b>${esc(u.label)}</b><div class="tiny muted">${esc(u.reason)}</div></div>
      <button class="btn sm" data-up="${i}" ${u.added ? 'disabled' : ''}>${u.added ? '✓ Added' : '+ Add'}</button></div>`).join('')}</div>` : ''}
    ${analysisTable(e)}
    ${a.observations?.length ? `<details style="margin-top:.4rem"><summary class="small"><b>Check on site (${a.observations.length})</b></summary><ul class="scope small">${a.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></details>` : ''}
    <div class="tiny muted" style="margin-top:.4rem">Fields AI filled are outlined in purple. Change anything and it stays your way. Prices always come from your Price Book.</div>
  </div>`;
  const u = $('#aiundo');
  if (u) u.onclick = () => {
    e.job = a.undo.job;
    e.customer = a.undo.customer;
    e.aiFields = [];
    e.ai = { ...a, undo: null, changes: [] };
    logHistory(e, 'AI changes undone');
    refreshEditorAfterFill();
    toast('Undone');
  };
  $$('[data-up]', el).forEach((b) => (b.onclick = () => addUpsell(+b.dataset.up)));
}

function analysisTable(e) {
  const rows = e.ai?.analysis || [];
  if (!rows.length) return '';
  const x = compute(e).sel.est;
  const need = (x.required || []).filter((r) => r.label !== 'Workers').map((r) => `${r.used} ${r.label.toLowerCase()}${r.rental ? ' (rental)' : ''}`).join(', ');
  const all = [...rows,
    { label: 'Required equipment', value: need || 'Hand tools', confidence: null, note: 'From your production rates and My Resources.' },
    { label: 'Estimated crew size', value: `${x.crew} worker${x.crew === 1 ? '' : 's'} · ${x.elapsedHours} h elapsed · ${x.personHours} labor-hours`, confidence: null, note: 'From your production rates and My Resources.' }];
  const bar = (c) => (c === null || c === undefined ? '<span class="muted">—</span>' : `<span class="conf"><i style="width:${Math.round(c * 100)}%"></i></span> ${Math.round(c * 100)}%`);
  return `<details style="margin-top:.4rem" open><summary class="small"><b>Job analysis (${rows.length} items)</b></summary>
    <table class="t small" style="margin-top:.3rem"><tr><th>Item</th><th>Estimate</th><th class="n">Confidence</th></tr>
    ${all.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.value)}${r.note ? `<div class="tiny muted">${esc(r.note)}</div>` : ''}</td><td class="n">${bar(r.confidence)}</td></tr>`).join('')}</table>
    <div class="tiny muted">Ranges are estimates from photos, not measurements. "—" means it can't be judged from a photo.</div></details>`;
}

function addUpsell(i) {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  const u = e.ai.upsells[i];
  const j = e.job;
  switch (u.action) {
    case 'addTree': j.division = 'tree'; j.tree.trees.push({ ...newTree(), work: u.work || 'remove', species: u.species || '', heightFt: Math.round(u.heightFt) || 30, dbhIn: Math.round(u.dbhIn) || 0 }); e.locks[`job.tree.trees.${j.tree.trees.length - 1}.work`] = true; break;
    case 'stumps': j.tree.stumps = true; break;
    case 'restore': j.tree.restore = true; break;
    case 'firewood': j.tree.firewood = true; break;
    case 'salt': j.snow.salt = true; break;
    case 'walks': j.snow.walkLf = Math.max(60, +j.snow.walkLf || 0); break;
    case 'roof': j.snow.roofSqft = +j.snow.roofSqft || 1200; break;
    case 'priority': j.snow.priority = true; break;
    case 'seasonal': j.snow.contract = 'seasonal'; break;
    default: e.adjustments.push({ label: u.label, amount: 0 }); renderAdjustments(); toast('Added as a line item. Enter a price.');
  }
  u.added = true;
  e.selectedOption = null;
  logHistory(e, `Added upsell: ${u.label}`);
  renderDetails();
  renderAiOut();
  changed();
}

function refreshEditorAfterFill() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  for (const k of ['name', 'phone', 'email', 'address']) { const inp = $(`[data-k="customer.${k}"]`); if (inp) inp.value = e.customer[k] || ''; }
  $$('#div button').forEach((x) => x.classList.toggle('on', x.dataset.d === e.job.division));
  $('#div').classList.toggle('snow', e.job.division === 'snow');
  const mi = $('[data-k="job.miles"]');
  if (mi) mi.value = e.job.miles || 0;
  renderPhotos();
  renderDetails();
  renderCustomerExtras();
  renderAiOut();
  renderAiStatus();
  renderHistory();
  changed();
}

// Purple outline on fields the AI (or location) filled in.
function markAi() {
  if (!ED) return;
  $$('.ai-filled').forEach((el) => el.classList.remove('ai-filled'));
  for (const p of ED.est.aiFields || []) {
    const el = $(`[data-k="${p}"]`);
    if (!el) continue;
    (el.type === 'checkbox' ? el.closest('.chip') : el).classList.add('ai-filled');
  }
}

function renderCustomerExtras() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  const ml = $('#maplink');
  if (ml) ml.innerHTML = [
    e.customer.address ? `<a class="small" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(e.customer.address)}">📍 Open in Maps</a>` : '',
    e.customer.phone ? `<a class="small" href="tel:${esc(e.customer.phone)}">📞 Call</a>` : '',
  ].filter(Boolean).join(' &nbsp; ');
  markAi();
}

// ---- job details

function renderDetails() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  const j = e.job;
  const el = $('#details');
  const M = S.company.multipliers;
  const simple = S.settings.simple;
  // simple screens: rush / weekend / property only; the overall difficulty slider is for detailed mode
  $('#siteflags').innerHTML = `
      ${!simple || (j.difficulty && j.difficulty !== 'normal') ? `<label class="f">Overall difficulty<select data-k="job.difficulty">${Object.entries(M.difficulty).map(([k, m]) => opt(k, `${m.label} (${m.value}×)`, j.difficulty || 'normal')).join('')}</select></label>` : ''}
      ${j.division === 'tree' ? `<label class="f">Home or business<select data-k="job.property">${opt('residential', 'Home', j.property || 'residential')}${opt('commercial', 'Business', j.property)}</select></label>` : ''}
    <div class="chips" style="grid-column:1/-1">${check('🚨 Emergency / urgent', 'job.emergency', j.emergency)}${j.division === 'tree' ? check('🌪 Storm response', 'job.storm', j.storm) : ''}${check('Weekend', 'job.weekend', j.weekend)}${check('Holiday', 'job.holiday', j.holiday)}${j.division === 'tree' ? check('Permit needed', 'job.permit', j.permit) : ''}</div>`;
  const conds = Object.entries(M.conditions)
    .filter(([k, c]) => (c.division === 'both' || c.division === j.division) && !(j.division === 'tree' && ['powerLines', 'overHouse', 'nearStructure', 'dead', 'leaning', 'fenceGarden'].includes(k)));
  const condChip = ([k, c]) => check(`${c.label}${simple ? '' : ` <span class="tiny muted">${c.value}×</span>`}`, `job.conditions.${k}`, j.conditions?.[k]);
  // detailed: the common ones stay in view; simple: they all live under "More options"
  const common = simple ? [] : COMMON_CONDITIONS[j.division] || [];
  const shown = conds.filter(([k]) => common.includes(k) || (!simple && j.conditions?.[k]));
  const more = conds.filter((x) => !shown.includes(x));
  const condBlock = `${shown.length ? `<h3>Anything making it harder?</h3><div class="chips">${shown.map(condChip).join('')}</div>` : ''}
    ${more.length && !simple ? `<details class="fold more-conds"><summary>More (${more.length})</summary><div class="chips" style="margin-top:.4rem">${more.map(condChip).join('')}</div></details>` : ''}
    ${simple ? '' : '<div class="tiny muted" style="margin-top:.3rem">Multipliers are set in <a href="#/rates">Production Rates</a>.</div>'}`;
  const condsSet = conds.filter(([k]) => j.conditions?.[k]).length;
  // a dropdown keeps its current value even when simple screens hide that choice
  const choices = (k, cur, list, hidden = []) => list.filter(([v]) => !simple || !hidden.includes(v) || v === cur).map(([v, l]) => opt(v, l, cur)).join('');
  const moreFold = (inner, count) => `<details class="fold more-opts" ${count ? 'open' : ''}><summary>More options${count ? ` (${count} set)` : ''}</summary><div style="margin-top:.4rem">${inner}</div></details>`;

  if (j.division === 'tree') {
    const t = j.tree;
    const last = t.trees.length - 1;
    const removals = t.trees.some((x) => x.work === 'remove');
    const fellWhy = t.method === 'fell' ? fellBlocked(t, j) : '';
    const hz = (k, label) => check(label, `job.tree.hazards.${k}`, t.hazards[k]);
    const simpleHz = ['powerLines', 'overHouse', 'fenceGarden', 'dead'];
    const otherHz = [['nearStructure', 'House, shed or garage close by'], ['leaning', '🌪 Leaning or split']].filter(([k]) => !simple || !t.hazards[k]);
    const extras = `${check('Fix the lawn (soil + seed)', 'job.tree.restore', t.restore)}${check('Cut firewood', 'job.tree.firewood', t.firewood)}`;
    const moreCount = [t.restore, t.firewood, ...otherHz.map(([k]) => t.hazards[k])].filter(Boolean).length + condsSet;
    el.innerHTML = `
      <datalist id="species">${Object.keys(SPECIES).map((s) => `<option value="${s}">`).join('')}</datalist>
      <div id="trees">${t.trees.map((tr, i) => `
        <div class="tree-row ${simple ? 'simple' : ''}">
          <label class="f">What<select data-k="job.tree.trees.${i}.work">${opt('remove', 'Remove', tr.work)}${opt('trim', 'Trim', tr.work)}${opt('stump', 'Stump only', tr.work)}${opt('cable', 'Cable', tr.work)}</select></label>
          ${simple ? '' : `<label class="f">Species<input list="species" data-k="job.tree.trees.${i}.species" value="${esc(tr.species)}" placeholder="oak"></label>`}
          ${tr.work === 'stump' ? numField('Stump width (in)', `job.tree.trees.${i}.dbhIn`, tr.dbhIn || '', 'placeholder="18"') : numField('Height (ft)', `job.tree.trees.${i}.heightFt`, tr.heightFt)}
          ${simple || tr.work === 'stump' ? '' : numField('Trunk width (in)', `job.tree.trees.${i}.dbhIn`, tr.dbhIn || '', 'placeholder="auto"')}
          ${numField('How many', `job.tree.trees.${i}.qty`, tr.qty, 'min="1"')}
          <button class="btn sm x" data-rmtree="${i}" ${t.trees.length < 2 ? 'disabled' : ''} aria-label="Remove tree">✕</button>
        </div>`).join('')}</div>
      ${t.trees[last].work === 'stump' ? '' : `<div class="quick"><span class="tiny muted">${t.trees.length > 1 ? `Tree ${last + 1}:` : 'Quick:'}</span>
        ${HEIGHTS.map((h) => `<button class="qchip ${+t.trees[last].heightFt === h ? 'on' : ''}" data-qh="${h}">${h} ft</button>`).join('')}</div>`}
      ${simple ? '' : `<div class="quick">${QUICK_SPECIES.map((s) => `<button class="qchip ${t.trees[last].species === s ? 'on' : ''}" data-qs="${s}">${cap(s)}</button>`).join('')}</div>`}
      <button class="btn sm" id="addtree" style="margin:.5rem 0 .25rem">+ Add another tree</button>
      <div class="grid g2 stack" style="margin-top:.5rem">
        <label class="f">Can a truck get to it?<select data-k="job.tree.access">${choices('access', t.access, [['open', 'Yes, right up to it'], ['driveway', simple ? 'Yes' : 'From the driveway or street'], ['backyard', 'Only through a gate'], ['tight', 'No, nothing gets in']], ['open'])}</select></label>
        ${removals || !simple ? `<label class="f">How it comes down<select data-k="job.tree.method">${choices('method', t.method, [['auto', simple ? 'In sections (app picks the cheapest safe way)' : 'Best for the job (auto)'], ['fell', 'In one piece, from the ground'], ['climb', 'Climb & rig'], ['bucket', 'Bucket truck'], ['lift', 'Spider lift'], ['crane', 'Crane']], ['climb', 'bucket', 'lift', 'crane'])}</select>
          ${t.method === 'fell' ? `<span class="tiny ${fellWhy ? 'warn-text' : 'muted'}">${fellWhy ? `⚠ Can't drop it whole: ${esc(fellWhy)}. It will be priced in sections.` : 'Needs a clear space as long as the tree is tall. No climbing or bucket truck.'}</span>` : ''}</label>` : ''}
        <label class="f">${removals ? 'When it\'s down' : 'Branches'}<select data-k="job.tree.debris">${removals ? choices('debris', t.debris, [['haul', 'Haul it all away'], ['chipLeaveLogs', 'Haul branches, leave the logs'], ['leave', 'Leave everything']]) : choices('debris', t.debris, [['haul', 'Haul them away'], ['chipLeaveLogs', 'Haul branches, leave wood'], ['leave', 'Leave them']], ['chipLeaveLogs'])}</select></label>
        ${t.trees.some((x) => x.work === 'trim') ? `<label class="f">How much trimming<select data-k="job.tree.trimLevel">${opt('light', 'A little', t.trimLevel)}${opt('standard', 'A normal trim', t.trimLevel)}${opt('heavy', 'A lot', t.trimLevel)}</select></label>` : ''}
      </div>
      <div class="chips" style="margin-top:.5rem">${removals ? check('⚙ Grind the stump', 'job.tree.stumps', t.stumps) : ''}${simple ? '' : extras}</div>
      <h3>⚠ Anything risky?</h3>
      <div class="chips">
        ${hz('powerLines', '⚡ Power lines')}
        ${hz('overHouse', simple ? '🏠 Over or next to a building' : '🏠 Over a building')}
        ${hz('fenceGarden', '🌷 Fence or garden below')}
        ${hz('dead', simple ? '☠ Dead or storm damaged' : '☠ Dead / decayed')}
        ${simple ? ['nearStructure', 'leaning'].filter((k) => t.hazards[k]).map((k) => hz(k, HAZARD_LABELS[k])).join('') : otherHz.map(([k, l]) => hz(k, l)).join('')}
      </div>
      ${simple ? moreFold(`<div class="chips">${extras}${otherHz.map(([k, l]) => hz(k, l)).join('')}</div><h3>Anything making it harder?</h3><div class="chips">${more.map(condChip).join('')}</div>`, moreCount) : condBlock}
      ${e.ai?.conditions?.length ? `<div class="muted tiny" style="margin-top:.5rem">AI condition notes: ${e.ai.conditions.map(esc).join(' · ')}</div>` : ''}`;
    $('#addtree').onclick = () => { t.trees.push(newTree()); e.locks[`job.tree.trees.${t.trees.length - 1}.work`] = true; renderDetails(); changed(); };
    $$('[data-rmtree]').forEach((b) => (b.onclick = () => {
      t.trees.splice(+b.dataset.rmtree, 1);
      for (const k of Object.keys(e.locks)) if (k.startsWith('job.tree.trees.')) delete e.locks[k];
      renderDetails();
      changed();
    }));
    $$('[data-qh]').forEach((b) => (b.onclick = () => { t.trees[last].heightFt = +b.dataset.qh; e.locks[`job.tree.trees.${last}.heightFt`] = true; renderDetails(); changed(); }));
    $$('[data-qs]').forEach((b) => (b.onclick = () => { t.trees[last].species = b.dataset.qs; e.locks[`job.tree.trees.${last}.species`] = true; renderDetails(); changed(); }));
  } else {
    const s = j.snow;
    const equipment = `<label class="f">Equipment<select data-k="job.snow.method">${opt('auto', simple ? 'App picks the cheapest' : 'Auto-recommend', s.method)}${opt('plow', 'Plow truck', s.method)}${opt('skid', 'Skid steer / pusher', s.method)}${opt('loader', 'Wheel loader / pusher', s.method)}${opt('blower', 'Snow blower', s.method)}${opt('shovel', 'Shovels', s.method)}</select></label>`;
    const depth = numField('Snow depth (inches)', 'job.snow.depthIn', s.depthIn);
    const roof = numField('Roof to clear (sq ft)', 'job.snow.roofSqft', s.roofSqft);
    const obstacles = `<label class="f">How open is it?<select data-k="job.snow.obstacles">${opt('low', 'Wide open', s.obstacles)}${opt('med', 'Some cars or curbs', s.obstacles)}${opt('high', 'Tight: islands, many cars', s.obstacles)}</select></label>`;
    const events = numField('Storms per season', 'job.snow.events', s.events || '', `placeholder="${S.pricebook.snow.eventsPerSeason}"`);
    const extraChips = `${check('⭐ Priority (before 7 AM)', 'job.snow.priority', s.priority)}${check('🚚 Haul snow off site', 'job.snow.haul', s.haul)}`;
    const moreCount = [s.method !== 'auto', +s.roofSqft > 0, s.obstacles !== 'low', +s.events > 0, s.priority, s.haul].filter(Boolean).length + condsSet;
    el.innerHTML = `
      <div class="quick"><span class="tiny muted">Size:</span>${AREAS.map(([l, v]) => `<button class="qchip ${+s.areaSqft === v ? 'on' : ''}" data-qa="${v}">${l}</button>`).join('')}</div>
      <div class="grid g2">
        <label class="f">Home or business<select data-k="job.snow.property">${opt('residential', 'Home', s.property)}${opt('commercial', 'Business', s.property)}</select></label>
        ${numField('Area to clear (sq ft)', 'job.snow.areaSqft', s.areaSqft)}
        ${numField('Sidewalks (ft)', 'job.snow.walkLf', s.walkLf)}
        <label class="f">How they pay<select data-k="job.snow.contract">${opt('perPush', 'Each snowfall', s.contract)}${opt('seasonal', 'Whole winter', s.contract)}</select></label>
        ${simple ? '' : `${equipment}${depth}${roof}${obstacles}${events}`}
      </div>
      <div id="sitefc"></div>
      <div class="chips" style="margin-top:.5rem">${check('🧂 Salt it', 'job.snow.salt', s.salt)}${simple ? '' : extraChips}</div>
      ${simple ? `<div class="tiny muted" style="margin-top:.3rem">Priced at ${esc(s.depthIn)}" of snow. The quote also lists a price for each snow depth.</div>
        ${moreFold(`<div class="grid g2">${depth}${equipment}${roof}${obstacles}${s.contract === 'seasonal' ? events : ''}</div><div class="chips" style="margin-top:.5rem">${extraChips}</div><h3>Anything making it harder?</h3><div class="chips">${more.map(condChip).join('')}</div>`, moreCount)}` : condBlock}`;
    $$('[data-qa]').forEach((b) => (b.onclick = () => {
      s.areaSqft = +b.dataset.qa;
      if (s.areaSqft >= 10000) s.property = 'commercial';
      e.locks['job.snow.areaSqft'] = true;
      renderDetails();
      changed();
    }));
    renderForecast();
  }
  markAi();
}

const HAZARD_LABELS = { nearStructure: 'House, shed or garage close by', leaning: '🌪 Leaning or split' };

async function renderForecast() {
  if (!ED || ED.est.job.division !== 'snow') return;
  const e = ED.est;
  const box = $('#sitefc');
  const loc = e.geo || S.settings.geo.shop || S.settings.geo.home;
  if (!box || !loc) return;
  try {
    const days = await forecast(loc.lat, loc.lon);
    if (!$('#sitefc')) return;
    const snowy = days.filter((d) => d.snowIn >= 1);
    if (!snowy.length) { box.innerHTML = '<div class="muted tiny" style="margin-top:.4rem">🌤 No snow in the 7-day forecast here.</div>'; return; }
    const max = snowy.reduce((a, b) => (b.snowIn > a.snowIn ? b : a));
    const depth = Math.max(2, Math.round(max.snowIn));
    box.innerHTML = `<div class="callout ai small" style="margin-top:.5rem">❄ Forecast here: ${snowy.map((d) => `${dayName(d.date)} ${d.snowIn}"`).join(', ')}
      ${+e.job.snow.depthIn !== depth ? `<button class="btn sm" id="usefc" style="margin-left:.4rem">Quote at ${depth}"</button>` : ''}</div>`;
    const u = $('#usefc');
    if (u) u.onclick = () => { e.job.snow.depthIn = depth; e.locks['job.snow.depthIn'] = true; renderDetails(); changed(); };
  } catch { /* offline: skip */ }
}

function renderAdjustments() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  $('#adjs').innerHTML = e.adjustments.length
    ? e.adjustments.map((a, i) => `<div class="row" style="margin-bottom:.4rem">
        <input data-k="adjustments.${i}.label" value="${esc(a.label)}" placeholder="Description" style="flex:2">
        <input data-k="adjustments.${i}.amount" data-type="num" type="number" inputmode="decimal" value="${a.amount || ''}" placeholder="$" style="flex:1">
        <button class="btn sm" data-rmadj="${i}" aria-label="Remove">✕</button></div>`).join('')
    : '<div class="muted small">Add-ons like “Remove 2 extra limbs over shed: $150”, or a negative amount for credits.</div>';
  $$('[data-rmadj]').forEach((b) => (b.onclick = () => { e.adjustments.splice(+b.dataset.rmadj, 1); renderAdjustments(); changed(); }));
}

function renderHistory() {
  const h = $('#hist');
  if (h) h.innerHTML = (ED.est.history || []).slice().reverse().map((x) => `<div>${fmtDate(x.at)}: ${esc(x.text)}</div>`).join('');
}

function renderActual() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  const box = $('#actual');
  if (!box) return;
  if (!['completed', 'paid'].includes(e.status)) { box.innerHTML = WON.includes(e.status) ? '<div class="tiny muted" style="margin-top:.6rem">After the job, set the status to <b>Completed</b> to record what actually happened.</div>' : ''; return; }
  if (!e.original) { const { sel } = compute(e); e.original = snapshotEstimate(sel.est, sel.name); }
  if (!e.actual) {
    e.actual = newActual(e.original);
    e.actual.price = compute(e).t.total;
    e.actual.workerNames = (compute(e).sel.est.crewMembers || []).map((w) => w.name).join(', ');
  }
  const a = e.actual;
  const f = (label, k, type = 'number', ph = '') => `<label class="f">${label}<input type="${type}" ${type === 'number' ? 'step="any" inputmode="decimal"' : ''} data-act="${k}" value="${esc(a[k] ?? '')}" placeholder="${esc(ph)}"></label>`;
  const rows = compareJob(e.original, a);
  box.innerHTML = `<h3>📋 Actual job</h3>
    <div class="tiny muted">The original estimate was saved on ${fmtDate(e.original.at)}. Enter what really happened; the comparison and the rate suggestions in <a href="#/rates">Production Rates</a> update.</div>
    <div class="grid g2" style="margin-top:.5rem">
      ${f('Actual workers', 'workers')}${f('Who worked', 'workerNames', 'text', 'Names')}
      ${f('Start', 'start', 'datetime-local')}${f('Finish', 'finish', 'datetime-local')}
      ${f('Labor-hours', 'laborHours')}${f('Equipment hours', 'equipmentHours')}
      ${f('Equipment used', 'equipment', 'text', 'Bucket truck, chipper…')}${f('Travel time (h)', 'travelHours')}
      ${f('Fuel ($)', 'fuel')}${f('Disposal ($)', 'disposal')}
      ${f('Materials ($)', 'materials')}${f('Total cost ($)', 'totalCost')}
      ${f('Selling price ($)', 'price')}
      <label class="f">Difficulty<select data-act="difficulty">${['easier than expected', 'as expected', 'harder than expected', 'much harder'].map((d) => opt(d, cap(d), a.difficulty)).join('')}</select></label>
      ${f('Weather', 'weather', 'text', 'Dry, rain, frozen ground…')}${f('Problems encountered', 'problems', 'text', 'Hidden rot, blocked access…')}
    </div>
    <label class="f" style="margin-top:.5rem">Notes<textarea data-act="notes" style="min-height:60px">${esc(a.notes || '')}</textarea></label>
    <h3>Estimated vs actual</h3>
    <table class="t"><tr><th>Item</th><th class="n">Estimated</th><th class="n">Actual</th><th class="n">Diff</th></tr>
    ${rows.map((r) => { const fm = (v) => (v === null || v === undefined ? '—' : r.unit === '$' ? money(v) : `${v}${r.unit ? ' ' + r.unit : ''}`); return `<tr><td>${esc(r.label)}</td><td class="n">${fm(r.est)}</td><td class="n">${fm(r.act)}</td><td class="n ${r.pct !== null && Math.abs(r.pct) > 10 ? 'bad' : ''}">${r.diff === null ? '' : `${r.diff > 0 ? '+' : ''}${r.unit === '$' ? money(r.diff) : r.diff}${r.pct !== null ? ` (${r.pct > 0 ? '+' : ''}${r.pct}%)` : ''}`}</td></tr>`; }).join('')}</table>`;
  const onAct = (ev) => {
    const k = ev.target.dataset.act;
    if (!k) return;
    a[k] = ev.target.value;
    clearTimeout(onAct.t);
    onAct.t = setTimeout(() => { changed(); const active = document.activeElement?.dataset?.act; renderActual(); if (active) { const el = $(`[data-act="${active}"]`); if (el) { el.focus(); if (el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); } } }, 900);
  };
  box.oninput = onAct;
  box.onchange = onAct;
}

function renderSchedule() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  renderActual();
  const box = $('#sched');
  if (!box) return;
  if (!WON.includes(e.status)) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="row" style="margin-top:.75rem;align-items:end">
      <label class="f" style="flex:1">📅 Job date<input type="date" id="jobdate" value="${esc(e.scheduledFor || '')}"></label>
      ${e.scheduledFor ? '<button class="btn" id="ics">Add to calendar</button>' : ''}</div>`;
  $('#jobdate').onchange = (ev) => {
    e.scheduledFor = ev.target.value;
    if (e.scheduledFor && e.status === 'accepted') { setStatus(e, 'scheduled'); const st = $('#status'); if (st) st.value = e.status; }
    logHistory(e, e.scheduledFor ? `Scheduled for ${fmtDate(e.scheduledFor)}` : 'Schedule cleared');
    renderSchedule();
    renderHistory();
    changed();
  };
  const ics = $('#ics');
  if (ics) ics.onclick = () => downloadIcs(e);
}

function downloadIcs(e) {
  const next = new Date(e.scheduledFor + 'T12:00:00');
  if (Number.isNaN(next.getTime())) return toast('Pick a job date first.');
  const d = e.scheduledFor.replace(/-/g, '');
  next.setDate(next.getDate() + Math.min(365, Math.max(1, Math.ceil(+compute(e).sel.est.days || 1))));
  const end = next.toISOString().slice(0, 10).replace(/-/g, '');
  const icsEsc = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const { sel } = compute(e);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//QuoteSnap//EN', 'BEGIN:VEVENT',
    `UID:${e.id}@quotesnap`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${icsEsc(`${jobTitle(e.job)}: ${e.customer.name || e.number}`)}`,
    `LOCATION:${icsEsc(e.customer.address)}`,
    `DESCRIPTION:${icsEsc([`${e.number} · ${sel.name} · ${money(compute(e).t.total)}`, e.customer.phone, ...sel.scope].filter(Boolean).join('\n'))}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  download(new Blob([lines.join('\r\n')], { type: 'text/calendar' }), `${e.number}.ics`);
}

// ---- results

function renderMilesNote(e) {
  const el = $('#milesnote');
  if (!el) return;
  const i = e.milesInfo;
  const from = { photo: "the photo's location", here: 'where you were standing', address: 'the job address' };
  if (e.locks?.['job.miles']) el.textContent = 'Typed in by you.';
  else if (i && +e.job.miles) el.textContent = `${e.job.miles} miles ${i.how === 'road' ? 'by road' : '(estimate, offline)'} from your shop${i.minutes ? `, about ${i.minutes} min` : ''}, using ${from[i.from] || 'the job location'}.`;
  else if (!S.settings.geo.shop) el.innerHTML = 'Set your shop in <a href="#/settings">Settings → Location</a> and this fills itself in.';
  else el.textContent = '';
}

function renderResults() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  const { options, sel, t, tiers, margin } = compute(e);
  const x = sel.est;
  renderMilesNote(e);
  $('#mval').textContent = margin + '%';
  renderSteps();
  const lockBar = (() => {
    if (!e.pricedRef) return '';
    const now = compute(e, { today: true }).t.total;
    const diff = Math.round(now - t.total);
    return `<div class="lockbar">🔒 Prices locked on ${fmtDate(e.pricedAt)}, when this quote left Draft, so the customer's price doesn't change.
      ${Math.abs(diff) >= 1 ? `With today's costs it would be <b>${money(now)}</b> (${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}).` : "Today's costs give the same price."}
      ${Math.abs(diff) >= 1 ? '<button class="btn sm" id="reprice">Use today\'s prices</button>' : ''}</div>`;
  })();
  $('#res-top').innerHTML = `${lockBar}
    <div class="muted small">${esc(jobTitle(e.job))}</div>
    <div class="price-hero"><div class="big">${money(t.total)}</div><div class="muted">${sel.unit ? esc(sel.unit) : 'customer price'}${t.tax ? ' incl. tax' : ''}</div></div>
    <div class="row small"><span>Profit <b style="color:var(--ok)">${money(x.profit + t.adj - (e.discount || 0))}</b></span>
      <span>· Margin <b>${Math.round(((x.profit + t.adj - (e.discount || 0)) / Math.max(1, t.subtotal)) * 100)}%</b></span>
      <span>· Cost ${money(x.fullCost)}</span>
      ${x.seasonal ? '' : `<span>· ${plainTime(x)}</span>`}</div>
    ${options.length > 1 ? `<h3>Customer options</h3><div class="tiny muted" style="margin:-.2rem 0 .4rem">Tap one to choose what goes on the quote. All of them are shown to the customer.</div><div class="options">${options.map((o) => `
      <button class="opt ${o.id === sel.id ? 'on' : ''}" data-opt="${o.id}">
        ${o.recommended ? '<div class="rec">★ Matches what you entered</div>' : ''}
        <div class="n">${esc(o.name)}</div><div class="p">${money(o.est.price)}</div><div class="b">${esc(o.blurb || '')}</div>
      </button>`).join('')}</div>` : ''}`;
  $$('[data-opt]').forEach((b) => (b.onclick = () => { e.selectedOption = b.dataset.opt; renderResults(); changed(false); }));
  const rp = $('#reprice');
  if (rp) rp.onclick = async () => {
    if (!(await ask("Re-price this quote with today's costs? If the customer already has it, send them the new quote.", { title: "Use today's prices?", ok: 'Re-price' }))) return;
    if (!ED || ED.est !== e) return;
    await lockPrices(e);
    logHistory(e, "Re-priced with today's costs");
    renderResults();
    renderHistory();
    changed();
  };

  const tabs = { plan: `Breakdown${x.notes?.length ? ` <span class="badge sent">${x.notes.length}</span>` : ''}`, scope: 'Scope', labor: 'Labor', equip: 'Equipment', mat: 'Disposal & materials', profit: 'Profit', safety: 'Safety' };
  let body = '';
  if (ED.tab === 'plan') {
    body = `<div class="grid g3">
        <div class="kpi"><div class="l">Elapsed job time</div><div class="v">${x.elapsedHours} h</div><div class="muted tiny">${x.siteHours} h on site + ${x.travelHours} h travel${x.days > 1 ? ` · ${x.days} days` : ''}</div></div>
        <div class="kpi"><div class="l">Crew</div><div class="v">${x.crew}</div><div class="muted tiny">${x.recCrew && x.recCrew !== x.crew ? `${x.recCrew} recommended` : 'workers'}</div></div>
        <div class="kpi"><div class="l">Labor-hours</div><div class="v">${x.personHours} h</div><div class="muted tiny">${x.crew} × ${x.elapsedHours} h</div></div>
      </div>
      ${(x.notes || []).map((n) => `<div class="callout small">⚠ ${esc(n)}</div>`).join('')}
      ${x.conditions?.length ? `<div class="chips" style="margin:.5rem 0"><span class="tiny muted">Conditions:</span>${x.conditions.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
      <h3>Work breakdown${x.seasonal ? ' (per visit)' : ''}</h3>
      <table class="t"><tr><th>Task</th><th class="n">Workers</th><th class="n">Hours</th></tr>
      ${x.tasks.map((k) => `<tr><td>${esc(k.label)}${k.equipment?.length ? `<div class="tiny muted">${esc(k.equipment.join(', '))}</div>` : ''}${k.parallel ? '<div class="tiny muted">runs alongside the other processing task</div>' : ''}${k.overlaps ? '<div class="tiny muted">runs while the crew keeps working</div>' : ''}</td><td class="n">${k.workers ?? ''}</td><td class="n">${k.hours} h</td></tr>`).join('')}
      <tfoot><tr><td>Elapsed time (some tasks overlap)</td><td class="n">${x.crew}</td><td class="n">${x.elapsedHours} h</td></tr></tfoot></table>
      <h3>Resources</h3>
      <table class="t"><tr><th>Resource</th><th class="n">Used</th><th class="n">Available</th></tr>
      ${(x.required || []).map((r) => `<tr><td>${esc(r.label)}${r.rental ? ' <span class="badge sent">rental</span>' : ''}${r.recommended && r.recommended > r.used ? ` <span class="tiny muted">${r.recommended} recommended</span>` : ''}</td><td class="n">${r.used}</td><td class="n">${r.available}</td></tr>`).join('')}</table>
      <div class="tiny muted" style="margin-top:.4rem">Planned with your <a href="#/resources">workers and equipment</a> and <a href="#/rates">production rates</a>.</div>`;
  } else if (ED.tab === 'scope') {
    body = `<ul class="scope">${sel.scope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      ${tiers ? `<h3>Price by snowfall</h3><table class="t"><tr>${tiers.map((r) => `<th class="n">${r.label}</th>`).join('')}</tr><tr>${tiers.map((r) => `<td class="n">${money(r.price)}</td>`).join('')}</tr></table>` : ''}`;
  } else if (ED.tab === 'labor') {
    body = `<table class="t"><tr><th>Item</th><th class="n">Value</th></tr>
      <tr><td>Crew size</td><td class="n">${x.labor.crew}</td></tr>
      ${(x.crewMembers || []).length ? `<tr><td colspan="2" class="small muted">${x.crewMembers.map((w) => `${esc(w.name)} (${esc(w.skill)})`).join(', ')}</td></tr>` : ''}
      <tr><td>Time on site (elapsed)</td><td class="n">${x.siteHours} h</td></tr>
      <tr><td>Travel time</td><td class="n">${x.travelHours} h</td></tr>
      ${x.grindHours ? `<tr><td>Stump grinding (1 operator)</td><td class="n">${x.grindHours} h</td></tr>` : ''}
      <tr><td>Labor-hours (crew × elapsed)</td><td class="n">${x.labor.personHours} h</td></tr>
      <tr><td>Average loaded rate${x.labor.overtime ? ' (overtime)' : ''}</td><td class="n">$${x.labor.wage}/h</td></tr>
      <tr><td>Schedule</td><td class="n">${x.days} day${x.days > 1 ? 's' : ''}</td></tr>
      ${x.seasonal ? `<tr><td>Season events</td><td class="n">${x.events}</td></tr>` : ''}
      <tfoot><tr><td>Labor cost${x.seasonal ? ' / visit' : ''}</td><td class="n">${money(x.labor.cost)}</td></tr></tfoot></table>`;
  } else if (ED.tab === 'equip') {
    body = `${x.reasons.map((r) => `<div class="callout ai small">💡 ${esc(r)}</div>`).join('')}
      <table class="t"><tr><th>Equipment</th><th class="n">Hours</th><th class="n">$/hr</th><th class="n">Cost</th><th class="n">Fuel</th></tr>
      ${x.equipment.map((q) => `<tr><td>${esc(q.label)}${q.task ? `<div class="tiny muted">${esc(q.task)}</div>` : ''}</td><td class="n">${q.hours}</td><td class="n">$${q.rate}</td><td class="n">${money(q.cost)}</td><td class="n">${money(q.fuel || 0)}</td></tr>`).join('')}
      <tfoot><tr><td colspan="3">Equipment + fuel${x.seasonal ? ' / visit' : ''}</td><td class="n">${money(x.equipmentCost)}</td><td class="n">${money(x.fuelCost || 0)}</td></tr></tfoot></table>
      <div class="tiny muted" style="margin-top:.3rem">Owned equipment costs come from <a href="#/resources">My Resources</a> (operating + maintenance); rentals from <a href="#/pricebook">Pricing</a>.</div>`;
  } else if (ED.tab === 'mat') {
    body = `<table class="t"><tr><th>Material</th><th class="n">Qty</th><th class="n">Cost</th></tr>
      ${x.materials.map((m) => `<tr><td>${esc(m.label)}</td><td class="n">${m.qty} ${esc(m.unit)}</td><td class="n">${money(m.cost)}</td></tr>`).join('')}
      ${x.travel ? `<tr><td>Travel</td><td class="n">${e.job.miles} mi</td><td class="n">${money(x.travel)}</td></tr>` : ''}
      <tfoot><tr><td colspan="2">Disposal, materials & travel${x.seasonal ? ' / visit' : ''}</td><td class="n">${money(x.materialCost + x.travel)}</td></tr></tfoot></table>
      ${x.volumeYd ? `<div class="muted small" style="margin-top:.4rem">≈ ${Math.round(x.volumeYd)} yd³ of wood & brush, ${x.loads} load(s) hauled.</div>` : ''}
      ${x.saltLbs ? `<div class="muted small" style="margin-top:.4rem">${x.saltLbs} lb salt per application.</div>` : ''}`;
  } else if (ED.tab === 'profit') {
    const per = x.seasonal ? ' (season)' : '';
    const pvLabel = x.seasonal ? ' / visit' : '';
    const pv = x.seasonal ? x.price / x.events : x.price;
    const sg = (v, c) => `<span style="width:${Math.max(0, (v / pv) * 100)}%;background:${c}"></span>`;
    body = `${x.seasonal ? `<div class="muted small">Per visit: ${money(pv)} price vs ${money(x.fullCost / x.events)} cost · Season profit ${money(x.profit)}</div>` : ''}
      <div class="profit-bar">${sg(x.laborCost, '#3f8f63')}${sg(x.equipmentCost + (x.fuelCost || 0), '#c8781e')}${sg(x.materialCost + x.travel, '#8b6bd1')}${sg(x.overhead, '#8d9a91')}${sg(pv - x.laborCost - x.equipmentCost - (x.fuelCost || 0) - x.materialCost - x.travel - x.overhead, '#1f5d8f')}</div>
      <div class="legend"><span><i style="background:#3f8f63"></i>Labor</span><span><i style="background:#c8781e"></i>Equipment + fuel</span><span><i style="background:#8b6bd1"></i>Disposal, materials, travel</span><span><i style="background:#8d9a91"></i>Overhead</span><span><i style="background:#1f5d8f"></i>Profit</span></div>
      <table class="t" style="margin-top:.6rem">
        <tr><td>Labor cost${pvLabel}</td><td class="n">${money(x.laborCost)}</td></tr>
        <tr><td>Equipment cost${pvLabel}</td><td class="n">${money(x.equipmentCost)}</td></tr>
        <tr><td>Fuel cost${pvLabel}</td><td class="n">${money(x.fuelCost || 0)}</td></tr>
        <tr><td>Disposal cost${pvLabel}</td><td class="n">${money(x.disposalCost || 0)}</td></tr>
        <tr><td>Travel cost${pvLabel}</td><td class="n">${money(x.travel)}</td></tr>
        <tr><td>Other costs (materials, mobilization)${pvLabel}</td><td class="n">${money(x.otherCost ?? 0)}</td></tr>
        <tr><td>Overhead (${pricingFor(ED.est).pb.overheadPct}%)${pvLabel}</td><td class="n">${money(x.overhead)}</td></tr>
        <tr><td><b>Total job cost${per}</b></td><td class="n"><b>${money(x.fullCost)}</b></td></tr>
        ${!x.seasonal && x.basePrice ? `<tr><td>At ${margin}% target margin</td><td class="n">${money(x.basePrice)}</td></tr>` : ''}
        ${!x.seasonal ? (x.markups || []).map((m) => `<tr><td>+ ${esc(m.label)} markup</td><td class="n">${m.pct}%</td></tr>`).join('') : ''}
        ${!x.seasonal ? (x.priceNotes || []).map((n) => `<tr><td colspan="2" class="tiny muted">${esc(n)}</td></tr>`).join('') : ''}
        <tr><td><b>Recommended selling price${per}</b></td><td class="n"><b>${money(x.price)}</b></td></tr>
        ${t.adj ? `<tr><td>Adjustments</td><td class="n">${money(t.adj)}</td></tr>` : ''}
        ${e.discount ? `<tr><td>Discount</td><td class="n">-${money(e.discount)}</td></tr>` : ''}
        <tfoot><tr><td>Gross profit</td><td class="n" style="color:var(--ok)">${money(x.profit + t.adj - (e.discount || 0))}</td></tr></tfoot>
      </table>
      <div class="grid g2" style="margin-top:.6rem">
        <div class="kpi"><div class="l">Profit / crew hour</div><div class="v">${money(x.profitPerCrewHour)}</div></div>
        <div class="kpi"><div class="l">Break-even price</div><div class="v">${money(x.fullCost)}</div></div>
      </div>
      ${x.marginPct < 20 ? '<div class="callout">⚠ Margin is under 20%. Check the minimum job charge or raise the price.</div>' : ''}`;
  } else if (ED.tab === 'safety') {
    body = x.safety.length ? x.safety.map((s) => `<div class="callout small">⚠ ${esc(s)}</div>`).join('') : '<div class="muted">No special hazards flagged. Standard PPE, cones and drop-zone control.</div>';
  }
  $('#res').innerHTML = `<div class="tabs" style="margin-top:.75rem">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${ED.tab === k ? 'on' : ''}">${v}</button>`).join('')}</div>${body}`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => { ED.tab = b.dataset.tab; renderResults(); }));
}

let saveTimer = null;
function changed(resetOption = false) {
  if (!ED) return;
  if (resetOption) ED.est.selectedOption = null;
  const s = $('#saved');
  if (s) s.textContent = 'Saving…';
  renderResults();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  if (!ED) return;
  clearTimeout(saveTimer);
  await persist(structuredClone(ED.est));
  const s = $('#saved');
  if (s) s.textContent = 'Saved ✓';
}

let notesTimer = null;
function readNotes() {
  if (!ED) return; // the editor was closed while this was pending
  const e = ED.est;
  const p = parseDescription(e.job.description);
  const before = { job: structuredClone(e.job), customer: { ...e.customer } };
  if (p.division || p.tree.trees) e.job = applyParsed(e.job, p, e.locks);
  const got = [];
  for (const k of ['name', 'phone', 'email', 'address']) {
    if (p.customer[k] && !e.customer[k] && !e.locks['customer.' + k]) {
      e.customer[k] = p.customer[k];
      got.push(k === 'address' ? 'address' : k);
      const inp = $(`[data-k="customer.${k}"]`);
      if (inp) inp.value = p.customer[k];
    }
  }
  const changes = describeChanges(before.job, e.job);
  if (!changes.length && !got.length) return;
  if (before.job.division !== e.job.division) {
    $$('#div button').forEach((x) => x.classList.toggle('on', x.dataset.d === e.job.division));
    $('#div').classList.toggle('snow', e.job.division === 'snow');
  }
  if (changes.some((c) => /stumps|restore|debris|salt|contract/.test(c.path))) e.selectedOption = null;
  $('#noteshint').textContent = '⚡ Read from notes: ' + [...got, ...changes.map((c) => `${c.label.toLowerCase()} ${c.to}`)].join(', ');
  renderDetails();
  renderCustomerExtras();
  changed();
  if (got.includes('address')) milesFromAddress(e);
}

function wireEditor() {
  const e = ED.est;
  app.addEventListener('input', onInput);
  app.addEventListener('change', onInput);
  const prevLeave = leaving;
  leaving = async () => {
    app.removeEventListener('input', onInput);
    app.removeEventListener('change', onInput);
    clearTimeout(notesTimer);
    await prevLeave();
    ED = null;
  };

  function onInput(ev) {
    const el = ev.target;
    const k = el.dataset?.k;
    if (!k) return;
    const isToggle = el.tagName === 'SELECT' || el.type === 'checkbox';
    if (ev.type === 'input' && isToggle) return;
    if (ev.type === 'change' && !isToggle) {
      if (k === 'customer.address') milesFromAddress(e);
      return;
    }
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'num') v = v === '' ? 0 : +v;
    setPath(e, k, v);
    // the estimator's own edits always win over AI / notes
    if (/^(job|customer)\./.test(k) && k !== 'job.description') {
      e.locks[k] = true;
      if (e.aiFields.includes(k)) { e.aiFields = e.aiFields.filter((p) => p !== k); (el.type === 'checkbox' ? el.closest('.chip') : el).classList.remove('ai-filled'); }
    }
    if (k === 'customer.name') {
      const match = S.estimates.find((x) => x.id !== e.id && x.customer.name === v);
      if (match && !e.customer.phone && !e.customer.address) {
        e.customer = { ...match.customer };
        for (const f of ['phone', 'email', 'address']) { const inp = $(`[data-k="customer.${f}"]`); if (inp) inp.value = e.customer[f] || ''; }
        toast('Filled in returning customer');
      }
    }
    if (k === 'job.description') {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(readNotes, 700);
    }
    if (k.startsWith('customer.')) renderCustomerExtras();
    // trim / stump choices follow the work; the "in one piece" warning follows hazards and access
    if (/^job\.tree\.(trees\.\d+\.work|method|access|hazards\.)|^job\.conditions\.|^job\.snow\.contract/.test(k)) { renderDetails(); }
    changed(/^job\.tree\.(debris|stumps|restore)|^job\.snow\.(salt|contract)/.test(k));
  }

  $('#margin').oninput = (ev) => { e.marginPct = +ev.target.value; changed(); };
  $('#status').onchange = (ev) => {
    setStatus(e, ev.target.value);
    renderHistory(); renderSchedule(); changed();
    if (['completed', 'paid'].includes(e.status) && S.settings.business.reviewLink) toast('Tip: tap Send → Review to ask for a review', 4000);
    if (e.status === 'accepted') offerSchedule(e);
  };

  $$('#div button').forEach((b) => (b.onclick = () => {
    if (e.job.division === b.dataset.d) return;
    e.job.division = b.dataset.d;
    e.locks['job.division'] = true;
    e.selectedOption = null;
    $$('#div button').forEach((x) => x.classList.toggle('on', x === b));
    $('#div').classList.toggle('snow', b.dataset.d === 'snow');
    renderDetails();
    changed();
  }));

  $('#addadj').onclick = () => { e.adjustments.push({ label: '', amount: 0 }); renderAdjustments(); };
  $('#aibtn').onclick = () => runAi(e.id, { auto: false });
  $('#here').onclick = () => locateInto(e);
  const pick = $('#pickc');
  if (pick) pick.onclick = async () => {
    try {
      const [c] = await navigator.contacts.select(['name', 'tel', 'email', 'address'], { multiple: false });
      if (!c) return;
      const a = c.address?.[0];
      const vals = {
        name: c.name?.[0], phone: c.tel?.[0], email: c.email?.[0],
        address: a ? [a.addressLine?.join(' '), a.city, [a.region, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '',
      };
      for (const [k, v] of Object.entries(vals)) if (v) { e.customer[k] = v; e.locks['customer.' + k] = true; const inp = $(`[data-k="customer.${k}"]`); if (inp) inp.value = v; }
      renderCustomerExtras();
      changed();
      if (vals.address) milesFromAddress(e);
    } catch { /* cancelled */ }
  };

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $('#mic').classList.add('hidden');
  else {
    let rec = null;
    let wantSend = false;
    $('#mic').onclick = () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = false;
      rec.continuous = true;
      $('#mic').textContent = '🔴 Listening… tap to stop';
      rec.onresult = (r) => {
        let text = [...r.results].slice(r.resultIndex).map((x) => x[0].transcript).join(' ');
        // spoken commands: "send it", "send the quote", "text it", "email it"
        if (/\b(send (it|the quote|quote)|text it|email it)\b/i.test(text)) {
          text = text.replace(/\b(send (it|the quote|quote)|text it|email it)\b/gi, '').trim();
          wantSend = true;
          rec.stop();
        }
        e.job.description = (e.job.description ? e.job.description.trim() + ' ' : '') + text.trim();
        $('#desc').value = e.job.description;
        readNotes();
        changed();
      };
      rec.onerror = (ev) => { if (ev.error === 'not-allowed') toast('Microphone permission was denied.'); };
      rec.onend = () => {
        rec = null;
        const mic = $('#mic');
        if (mic) mic.textContent = '🎤 Talk';
        if (ED?.est !== e) return; // the quote was closed while listening
        scheduleAi(e, 400);
        if (wantSend) { wantSend = false; setTimeout(() => $('#send')?.click(), 300); }
      };
      rec.start();
    };
  }

  $('#send').onclick = () => openSend(e, refresh);
  $('#sign').onclick = () => openSign(e, refresh);
  function refresh() { if (ED?.est !== e) { persist(structuredClone(e)); return; } const st = $('#status'); if (st) st.value = e.status; renderHistory(); renderSchedule(); changed(); }
  $('#dup').onclick = async () => {
    await flushSave();
    const copy = { ...structuredClone(e), id: uid(), number: `${S.settings.prefix}-${S.settings.nextNumber++}`, status: 'draft', createdAt: new Date().toISOString(), signature: null, signedName: null, scheduledFor: '', history: [{ at: new Date().toISOString(), text: `Duplicated from ${e.number}` }] };
    for (const k of ['sentAt', 'acceptedAt', 'declinedAt', 'scheduledAt', 'completedAt', 'paidAt', 'signedAt']) delete copy[k];
    copy.photos = [];
    delete copy.pricedRef; delete copy.pricedAt;
    for (const pid of e.photos) { const n = uid(); await kv.set('photo:' + n, await getPhoto(pid)); copy.photos.push(n); }
    await saveSettings();
    await persist(copy);
    location.hash = '#/e/' + copy.id;
    toast('Duplicated');
  };
  $('#del').onclick = async () => {
    if (!(await ask(`Delete quote ${e.number}? This can't be undone.`, { title: 'Delete quote?', ok: 'Delete', danger: true, icon: '🗑' }))) return;
    clearTimeout(saveTimer);
    ED = null;
    S.estimates = S.estimates.filter((x) => x.id !== e.id);
    for (const p of e.photos) await kv.del('photo:' + p);
    await saveEstimates();
    leaving = null;
    location.hash = '#/estimates';
    toast('Quote deleted');
  };
}

// ---------------------------------------------------------------- send & sign

function quoteMessage(e) {
  const { options, sel, t, pb } = compute(e);
  const b = S.settings.business;
  const first = (e.customer.name || '').split(' ')[0] || 'there';
  const lines = [
    `Hi ${first},`,
    '',
    `Thanks for having ${b.name} out${e.customer.address ? ' to ' + e.customer.address : ''}. Here is your quote ${e.number}:`,
    '',
    jobTitle(e.job),
  ];
  if (options.length > 1) {
    lines.push('');
    for (const o of options) lines.push(`• ${o.name}: ${money(o.est.price)}${o.unit ? ' ' + o.unit : ''}${o.id === sel.id ? ' (recommended)' : ''}${o.blurb ? ': ' + o.blurb : ''}`);
  } else lines.push(`Total: ${money(t.total)}`);
  lines.push('', `Quote valid for ${pb.validDays} days.${pb.depositPct ? ` ${pb.depositPct}% deposit (${money(t.deposit)}) to schedule.` : ''}`);
  if (b.payLink) lines.push(`Pay the deposit online: ${b.payLink}`);
  lines.push('Reply with the option you would like and we will get you on the schedule.', '', b.owner || b.name, [b.phone, b.website].filter(Boolean).join(' · '));
  return lines.join('\n');
}

function followUpMessage(e) {
  const first = (e.customer.name || '').split(' ')[0] || 'there';
  const b = S.settings.business;
  return `Hi ${first}, just checking in on quote ${e.number} for ${jobTitle(e.job).toLowerCase()}. Any questions I can answer? We have openings coming up and would be glad to get you on the schedule.${b.payLink ? `\n\nYou can lock in your spot with the deposit here: ${b.payLink}` : ''}\n\n${b.owner || b.name} ${b.phone || ''}`;
}

function invoiceMessage(e) {
  const { t } = compute(e);
  const b = S.settings.business;
  const first = (e.customer.name || '').split(' ')[0] || 'there';
  return `Hi ${first}, thanks for choosing ${b.name}! Your invoice for ${e.number} is attached. Total ${money(t.total)}.${b.payLink ? `\nPay online: ${b.payLink}` : ''}\n\n${b.owner || b.name} ${b.phone || ''}`;
}

function reviewMessage(e) {
  const first = (e.customer.name || '').split(' ')[0] || 'there';
  const b = S.settings.business;
  return `Hi ${first}, thanks again for choosing ${b.name}. If you were happy with the work, would you leave us a quick review? It really helps a small business like ours.\n${b.reviewLink || '[add your review link in Settings]'}\n\nThank you!\n${b.owner || b.name}`;
}

async function buildPdfFile(e, type) {
  const html = await renderDocInner(e, type);
  const blob = await makePdf(html, { brand: S.settings.business.color });
  const name = `${type === 'invoice' ? 'Invoice' : type === 'jobsheet' ? 'JobSheet' : 'Quote'}-${e.number}${e.customer.name ? '-' + e.customer.name.replace(/[^\w]+/g, '-') : ''}.pdf`;
  return new File([blob], name, { type: 'application/pdf' });
}

function openSend(e, onUpdate) {
  const m = $('#modal');
  const done = ['completed', 'paid'].includes(e.status);
  const kinds = [['quote', 'Quote'], ['follow', 'Follow-up'], ['invoice', 'Invoice'], ['review', 'Review']];
  let kind = done ? 'invoice' : e.status === 'sent' ? 'follow' : 'quote';
  const msgFor = (k) => ({ quote: quoteMessage, follow: followUpMessage, invoice: invoiceMessage, review: reviewMessage }[k](e));
  const docFor = (k) => (k === 'invoice' ? 'invoice' : k === 'review' ? null : 'quote');
  const shareFiles = canSharePdf();
  let pdf = null;
  let pdfFor = null;
  const prep = (k) => {
    const type = docFor(k);
    if (!type || pdfFor === type) return;
    pdfFor = type;
    pdf = buildPdfFile(e, type);
    pdf.catch(() => {});
    const b = $('[data-via="pdfshare"]', m);
    if (b) { b.disabled = true; b.textContent = 'Preparing PDF…'; pdf.then(() => { b.disabled = false; b.textContent = shareFiles ? '📎 Send PDF + message' : '⬇ Download PDF'; }, () => { b.textContent = 'PDF failed: tap to retry'; b.disabled = false; pdfFor = null; }); }
  };
  m.innerHTML = `<div class="mb">
    <h2>Send to ${esc(e.customer.name || 'customer')}</h2>
    <div class="seg" style="margin-bottom:.6rem;flex-wrap:wrap">${kinds.map(([k, l]) => `<button class="${k === kind ? 'on' : ''}" data-msg="${k}">${l}</button>`).join('')}</div>
    <textarea id="msg" style="min-height:200px">${esc(msgFor(kind))}</textarea>
    <div class="actions" style="margin-top:.6rem">
      <button class="btn primary" data-via="pdfshare" style="grid-column:1/-1">Preparing PDF…</button>
      <button class="btn" data-via="sms">💬 Text</button>
      <button class="btn" data-via="email">✉ Email</button>
      <button class="btn" data-via="copy">⧉ Copy message</button>
      ${shareFiles ? '<button class="btn" data-via="download">⬇ Download PDF</button>' : ''}
    </div>
    <div class="muted tiny" style="margin-top:.5rem">${shareFiles ? '“Send PDF + message” opens your share sheet (Messages, Mail, WhatsApp…) with the PDF already attached.' : 'Text and Email send the message. Download the PDF to attach it.'}</div>
    <div class="row" style="margin-top:.75rem"><div class="spacer"></div><button class="btn" data-close>Close</button></div></div>`;
  m.showModal();
  prep(kind);
  $$('[data-msg]', m).forEach((b) => (b.onclick = () => {
    kind = b.dataset.msg;
    $$('[data-msg]', m).forEach((x) => x.classList.toggle('on', x === b));
    $('#msg').value = msgFor(kind);
    const ps = $('[data-via="pdfshare"]', m);
    ps.classList.toggle('hidden', !docFor(kind));
    prep(kind);
  }));
  $('[data-close]', m).onclick = () => m.close();
  $$('[data-via]', m).forEach((b) => (b.onclick = async () => {
    const body = $('#msg').value;
    const subject = `${kind === 'invoice' ? 'Invoice' : kind === 'review' ? 'Thank you' : 'Your quote'} ${e.number} from ${S.settings.business.name}`;
    const via = b.dataset.via;
    try {
      if (via === 'pdfshare' || via === 'download') {
        if (!pdf) prep(kind);
        const file = await pdf;
        if (via === 'pdfshare' && shareFiles) await navigator.share({ files: [file], title: subject, text: body });
        else download(file, file.name);
      }
      if (via === 'email') location.href = `mailto:${encodeURIComponent(e.customer.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      if (via === 'sms') location.href = `sms:${(e.customer.phone || '').replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(body)}`;
      if (via === 'copy') { await navigator.clipboard.writeText(body); toast('Copied'); }
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (err?.name === 'NotAllowedError' && via === 'pdfshare') { toast('Tap “Send PDF + message” once more'); return; }
      toast(err.message || 'Could not send');
      return;
    }
    if (kind === 'quote' && e.status === 'draft') setStatus(e, 'sent');
    if (e.status === 'sent' && !e.sentAt) e.sentAt = new Date().toISOString();
    logHistory(e, `${cap(kind)} sent via ${via === 'pdfshare' ? 'share (PDF)' : via}`);
    onUpdate();
  }));
}

function openSign(e, onUpdate) {
  const { options, sel } = compute(e);
  const m = $('#modal');
  m.innerHTML = `<div class="mb">
    <h2>Customer acceptance</h2>
    <p class="muted small">Hand the phone to the customer. They pick an option and sign to approve the work.</p>
    ${options.map((o) => `<label class="opt" style="display:flex;gap:.6rem;align-items:center;margin-bottom:.4rem"><input type="radio" name="o" value="${o.id}" ${o.id === sel.id ? 'checked' : ''}>
      <span style="flex:1"><b>${esc(o.name)}</b><br><span class="small muted">${esc(o.blurb || jobTitle(e.job))}</span></span><b>${money(o.est.price)}</b></label>`).join('')}
    <label class="f" style="margin:.5rem 0">Printed name<input id="sname" value="${esc(e.customer.name)}"></label>
    <div class="row small muted"><span>Sign below</span><div class="spacer"></div><button class="btn sm" id="clr">Clear</button></div>
    <canvas class="sig" id="sig"></canvas>
    <p class="small muted">By signing, I accept this quote and the terms: ${esc(S.pricebook.terms)}</p>
    <div class="row"><button class="btn danger" id="decline">Customer declined</button><div class="spacer"></div><button class="btn" data-close>Cancel</button><button class="btn primary" id="accept">Accept & sign</button></div></div>`;
  m.showModal();
  const c = $('#sig');
  const ratio = window.devicePixelRatio || 1;
  c.width = c.clientWidth * ratio;
  c.height = c.clientHeight * ratio;
  const ctx = c.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111';
  let drawing = false;
  let inked = false;
  const pos = (ev) => { const r = c.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  c.onpointerdown = (ev) => { drawing = true; c.setPointerCapture(ev.pointerId); ctx.beginPath(); ctx.moveTo(...pos(ev)); };
  c.onpointermove = (ev) => { if (!drawing) return; ctx.lineTo(...pos(ev)); ctx.stroke(); inked = true; };
  c.onpointerup = () => (drawing = false);
  $('#clr').onclick = () => { ctx.clearRect(0, 0, c.width, c.height); inked = false; };
  $('[data-close]', m).onclick = () => m.close();
  $('#decline').onclick = () => { setStatus(e, 'declined'); onUpdate(); m.close(); toast('Marked declined'); };
  $('#accept').onclick = () => {
    if (!inked) { toast('Please sign first'); return; }
    e.selectedOption = $('input[name=o]:checked', m).value;
    e.signature = c.toDataURL('image/png');
    e.signedName = $('#sname').value;
    e.signedAt = new Date().toISOString();
    setStatus(e, 'accepted');
    logHistory(e, `Signed by ${e.signedName}`);
    onUpdate();
    m.close();
    toast('Accepted! 🎉');
    setTimeout(() => offerSchedule(e), 600);
  };
}

// ---------------------------------------------------------------- printable documents

async function renderDocInner(e, type) {
  const b = S.settings.business;
  const { options, sel, t, tiers, pb } = compute(e);
  const x = sel.est;
  const photos = (await Promise.all(e.photos.slice(0, 6).map(getPhoto)));
  const caps = e.ai?.photoCaptions || [];
  const valid = new Date(new Date(e.sentAt || e.createdAt).getTime() + pb.validDays * 864e5);
  const title = { quote: 'Quote', invoice: 'Invoice', jobsheet: 'Job Sheet' }[type];
  const depositPaid = type === 'invoice' && WON.includes(e.status) ? t.deposit : 0;

  let breakdown = [];
  if (!x.seasonal && S.settings.showItemized) {
    const base = x.directCost || 1;
    const share = (v) => Math.round((v / base) * x.price);
    const rows = [
      [`Labor: crew of ${x.labor.crew}, approx. ${Math.round(x.siteHours + (x.grindHours || 0))} hrs`, share(x.laborCost)],
      [`Equipment: ${x.equipment.map((q) => q.label).join(', ')}`, share(x.equipmentCost)],
      [`Disposal, materials${x.travel ? ' & travel' : ''}`, share(x.materialCost + x.travel)],
    ].filter((r) => r[1] > 0);
    const diff = x.price - rows.reduce((s, r) => s + r[1], 0);
    if (rows.length) rows[0][1] += diff;
    breakdown = rows;
  }

  const header = `
    <div class="dh">
      <div>${b.logo ? `<img class="logo" src="${b.logo}" alt=""><br>` : ''}<div class="bizname">${esc(b.name)}</div>
        <div class="small">${esc(b.address)}<br>${esc([b.phone, b.email].filter(Boolean).join(' · '))}${b.website ? '<br>' + esc(b.website) : ''}</div></div>
      <div class="dt"><div class="ttl">${title.toUpperCase()}</div>
        <div><b>#${esc(e.number)}</b></div><div>Date: ${fmtDate(type === 'invoice' ? new Date().toISOString() : e.createdAt)}</div>
        ${type === 'quote' ? `<div>Valid until: ${fmtDate(valid.toISOString())}</div>` : ''}
        ${type === 'invoice' ? '<div>Due on receipt</div>' : ''}
        ${type === 'jobsheet' && e.scheduledFor ? `<div>Job date: <b>${fmtDate(e.scheduledFor)}</b></div>` : ''}
        ${e.status === 'paid' && type === 'invoice' ? '<div style="margin-top:6px"><span class="stamp">PAID</span></div>' : ''}
        ${e.signature && type === 'quote' ? '<div style="margin-top:6px"><span class="stamp">ACCEPTED</span></div>' : ''}</div>
    </div>
    <div class="meta">
      <div><div class="lbl">${type === 'jobsheet' ? 'Customer' : 'Prepared for'}</div><b>${esc(e.customer.name || '—')}</b><br>${esc(e.customer.phone)}${e.customer.email ? '<br>' + esc(e.customer.email) : ''}</div>
      <div><div class="lbl">Job site</div>${esc(e.customer.address || '—')}</div>
    </div>`;

  const shown = photos.map((p, i) => [p, caps[i]]).filter(([p]) => p);
  const photoBlock = shown.length ? `<div class="avoid"><div class="sec">Site photos</div><div class="pgrid">${shown.map(([p, c]) => `<figure><img src="${p}" alt="">${c ? `<figcaption>${esc(c)}</figcaption>` : ''}</figure>`).join('')}</div></div>` : '';
  const scopeBlock = `<div class="sec">Scope of work${options.length > 1 && type !== 'jobsheet' ? `: ${esc(sel.name)}` : ''}</div>
    ${e.ai?.customerSummary && type !== 'jobsheet' ? `<p>${esc(e.ai.customerSummary)}</p>` : ''}
    <ul>${sel.scope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;

  let body = '';
  if (type === 'jobsheet') {
    body = `${scopeBlock}
      <div class="sec">Crew & schedule</div>
      <table><tr><td>Crew</td><td class="n">${x.labor.crew} people${(x.crewMembers || []).length ? `: ${esc(x.crewMembers.map((w) => w.name).join(', '))}` : ''}</td></tr>
      <tr><td>Estimated time on site</td><td class="n">${x.siteHours} h (+ ${x.travelHours} h travel)</td></tr>
      <tr><td>Labor-hours</td><td class="n">${x.personHours} h</td></tr>
      <tr><td>Days</td><td class="n">${x.days}</td></tr>
      ${x.volumeYd ? `<tr><td>Debris</td><td class="n">≈ ${Math.round(x.volumeYd)} yd³, ${x.loads} load(s)</td></tr>` : ''}
      ${x.saltLbs ? `<tr><td>Salt per visit</td><td class="n">${x.saltLbs} lb</td></tr>` : ''}</table>
      <div class="sec">Work plan</div>
      <table><tr><th>Task</th><th class="n">Workers</th><th class="n">Hours</th></tr>${x.tasks.map((k) => `<tr><td>${esc(k.label)}${k.equipment?.length ? `<br><span class="small">${esc(k.equipment.join(', '))}</span>` : ''}</td><td class="n">${k.workers ?? ''}</td><td class="n">${k.hours}</td></tr>`).join('')}</table>
      ${(x.notes || []).length ? `<ul>${x.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="sec">Equipment to bring</div>
      <table><tr><th>Equipment</th><th class="n">Est. hours</th></tr>${x.equipment.map((q) => `<tr><td>☐ ${esc(q.label)}</td><td class="n">${q.hours}</td></tr>`).join('')}</table>
      <div class="sec">Materials</div><table>${x.materials.map((mm) => `<tr><td>☐ ${esc(mm.label)}</td><td class="n">${mm.qty} ${esc(mm.unit)}</td></tr>`).join('')}</table>
      <div class="sec">Safety briefing</div>${x.safety.length ? `<ul>${x.safety.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p>Standard PPE, cones and drop-zone control.</p>'}
      ${e.ai?.observations?.length ? `<div class="sec">Check on site</div><ul>${e.ai.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
      ${e.notes ? `<div class="sec">Notes</div><p>${esc(e.notes).replace(/\n/g, '<br>')}</p>` : ''}
      ${photoBlock}
      <div class="sign"><div><div class="line"></div><div class="small">Crew lead sign-off: work complete, site clean</div></div><div><div class="line"></div><div class="small">Date / time</div></div></div>`;
  } else {
    const optTable = options.length > 1 && type === 'quote' ? `<div class="sec">Your options</div>
      <table><tr><th>Option</th><th>Includes</th><th class="n">Price</th></tr>
      ${options.map((o) => `<tr class="opt-row ${o.id === sel.id ? 'sel' : ''}"><td>${o.id === sel.id ? '☑' : '☐'} ${esc(o.name)}</td><td>${esc(o.blurb || '')}</td><td class="n">${money(o.est.price)}${o.unit ? `<br><span class="small">${esc(o.unit)}</span>` : ''}</td></tr>`).join('')}</table>` : '';
    const lines = [
      ...(breakdown.length ? breakdown : [[`${sel.name}${sel.unit ? ' (' + sel.unit + ')' : ''}: ${jobTitle(e.job)}`, x.price]]),
      ...e.adjustments.filter((a) => a.label || a.amount).map((a) => [a.label || 'Additional work', +a.amount || 0]),
    ];
    body = `${scopeBlock}${optTable}
      <div class="sec">${type === 'invoice' ? 'Charges' : `Pricing: ${esc(sel.name)}`}</div>
      <table><tr><th>Description</th><th class="n">Amount</th></tr>${lines.map((l) => `<tr><td>${esc(l[0])}</td><td class="n">${money(l[1])}</td></tr>`).join('')}</table>
      <table class="tot">
        ${e.discount ? `<tr><td>Discount</td><td class="n">-${money(e.discount)}</td></tr>` : ''}
        <tr><td>Subtotal</td><td class="n">${money(t.subtotal)}</td></tr>
        ${pb.taxPct ? `<tr><td>Tax (${pb.taxPct}%)</td><td class="n">${money(t.tax)}</td></tr>` : ''}
        <tr class="grand"><td>Total</td><td class="n">${money(t.total)}</td></tr>
        ${type === 'quote' && t.deposit ? `<tr><td>Deposit to schedule (${pb.depositPct}%)</td><td class="n">${money(t.deposit)}</td></tr>` : ''}
        ${depositPaid ? `<tr><td>Deposit received</td><td class="n">-${money(depositPaid)}</td></tr><tr class="grand"><td>Balance due</td><td class="n">${money(e.status === 'paid' ? 0 : t.total - depositPaid)}</td></tr>` : ''}
      </table>
      ${b.payLink && e.status !== 'paid' ? `<p class="paylink"><b>Pay online:</b> ${esc(b.payLink)}</p>` : ''}
      ${x.seasonal ? `<p class="small"><b>Payment plan:</b> ${pb.snow.seasonMonths} monthly payments of ${money(x.monthly)}. Covers approximately ${x.events} snow events.</p>` : ''}
      ${tiers && type === 'quote' && !x.seasonal ? `<div class="sec">Per-visit price by snowfall</div><table><tr>${tiers.map((r) => `<th class="n">${r.label}</th>`).join('')}</tr><tr>${tiers.map((r) => `<td class="n">${money(r.price)}</td>`).join('')}</tr></table>` : ''}
      ${photoBlock}
      <div class="sec">Terms</div><div class="terms">${esc(pb.terms)}</div>
      ${type === 'quote' ? `<div class="sign avoid">
        <div><div class="line">${e.signature ? `<img src="${e.signature}" alt="Signature">` : ''}</div><div class="small">Customer signature${e.signedName ? ': ' + esc(e.signedName) : ''}</div></div>
        <div><div class="line">${e.signedAt ? fmtDate(e.signedAt) : ''}</div><div class="small">Date</div></div></div>` : '<p style="margin-top:18px"><b>Thank you for your business!</b></p>'}`;
  }
  return `${header}${body}
    <div class="foot"><span>${esc([b.license && 'License ' + b.license, b.insurance && 'Insured: ' + b.insurance].filter(Boolean).join(' · '))}</span><span>${esc(b.name)} · ${esc(e.number)}</span></div>`;
}

async function viewDoc(id, type) {
  const e = S.estimates.find((x) => x.id === id);
  if (!e) { app.innerHTML = '<div class="empty">Not found</div>'; return; }
  const b = S.settings.business;
  const title = { quote: 'Quote', invoice: 'Invoice', jobsheet: 'Job Sheet' }[type];
  const inner = await renderDocInner(e, type);
  app.innerHTML = `
    <div class="doc-toolbar">
      <a class="btn" href="#/e/${e.id}">← Back</a>
      <button class="btn primary" id="dlpdf">⬇ PDF</button>
      <button class="btn" id="print">🖨 Print</button>
      ${type !== 'jobsheet' ? '<button class="btn accent" id="dsend">✉ Send</button>' : ''}
      <div class="spacer"></div>
      <div class="seg">${['quote', 'invoice', 'jobsheet'].map((k) => `<button class="${k === type ? 'on' : ''}" data-t="${k}">${{ quote: 'Quote', invoice: 'Invoice', jobsheet: 'Job sheet' }[k]}</button>`).join('')}</div>
    </div>
    <article class="doc" style="--brand:${esc(b.color || '#1f5f3f')}">${inner}</article>`;
  $('#print').onclick = () => {
    const prev = document.title;
    document.title = `${title} ${e.number} – ${e.customer.name || ''}`.trim();
    window.print();
    setTimeout(() => (document.title = prev), 500);
  };
  $('#dlpdf').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Making PDF…';
    try {
      const f = await buildPdfFile(e, type);
      if (canSharePdf()) { try { await navigator.share({ files: [f], title: f.name }); } catch (err) { if (err.name !== 'AbortError') download(f, f.name); } } else download(f, f.name);
    } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = '⬇ PDF'; }
  };
  $$('[data-t]').forEach((bt) => (bt.onclick = () => (location.hash = `#/doc/${e.id}?t=${bt.dataset.t}`)));
  const ds = $('#dsend');
  if (ds) ds.onclick = () => openSend(e, () => persist(e));
}

// ---------------------------------------------------------------- business setup pages

function pageCtx() {
  return { app, S, $, $$, esc, toast, money, setPath, getPath, saveCompany, savePricebook, ask, setLeaving: (fn) => { leaving = fn; },
    fuel: () => FUEL, refreshFuel, pickFuel: pickNow, suggest: suggestNow, applyPricing, fuelUse };
}

// ---------------------------------------------------------------- price book (legacy view, replaced by Pricing Settings)

function viewPricebook() {
  const pb = S.pricebook;
  const n = (label, path, suffix = '') => `<label class="f">${label}${suffix ? ` <span class="muted">(${suffix})</span>` : ''}<input type="number" inputmode="decimal" step="any" data-pb="${path}" value="${getPath(pb, path)}"></label>`;
  app.innerHTML = `
    <div class="row"><h1>Price Book</h1><div class="spacer"></div><button class="btn sm danger" id="reset">Reset to defaults</button></div>
    <p class="muted">Your costs. QuoteSnap adds overhead and your target margin to get the customer price. Changes apply to all quotes instantly.</p>
    <div class="grid g2 cols" style="align-items:start">
      <div class="card"><h2>Labor & pricing</h2><div class="grid g2">
        ${n('Crew wage', 'labor.wage', '$/hr')}${n('Labor burden', 'labor.burdenPct', '%')}
        ${n('Emergency multiplier', 'labor.emergencyMult', '×')}${n('Tree crew size', 'crew.tree')}
        ${n('Snow crew size', 'crew.snow')}${n('Overhead', 'overheadPct', '%')}
        ${n('Target margin', 'targetMarginPct', '%')}${n('Sales tax', 'taxPct', '%')}
        ${n('Min tree job', 'minJobTree', '$')}${n('Min snow visit', 'minJobSnow', '$')}
        ${n('Deposit', 'depositPct', '%')}${n('Quote valid', 'validDays', 'days')}
        ${n('Travel', 'travel.perMile', '$/mile')}${n('Free travel radius', 'travel.freeMiles', 'miles')}
        ${n('Round tree prices to', 'roundTo', '$')}
      </div></div>
      <div class="card"><h2>Equipment</h2>
        <table class="t"><tr><th>Equipment</th><th class="n">$/hr</th><th class="n">Min hrs</th></tr>
        ${Object.entries(pb.equipment).map(([k, q]) => `<tr><td>${esc(q.label)}</td><td><input type="number" step="any" data-pb="equipment.${k}.rate" value="${q.rate}"></td><td><input type="number" step="any" data-pb="equipment.${k}.min" value="${q.min}"></td></tr>`).join('')}</table></div>
      <div class="card"><h2>Materials & disposal</h2><div class="grid g2">
        ${n('Fuel & wear', 'materials.fuelPerEquipHour', '$/equip hr')}${n('Dump fee', 'materials.dumpFeePerLoad', '$/load')}
        ${n('Load size', 'materials.loadYards', 'yd³')}${n('Cabling kit', 'materials.cablingKit', '$')}
        ${n('Lawn restore', 'materials.restoreKit', '$/stump')}${n('Permit fee', 'materials.permitFee', '$')}
        ${n('Salt cost', 'materials.saltPerLb', '$/lb')}${n('Salt rate', 'materials.saltLbPer1000', 'lb/1000 sq ft')}
      </div></div>
      <div class="card"><h2>Snow contracts</h2><div class="grid g2">
        ${n('Events per season', 'snow.eventsPerSeason')}${n('Seasonal discount', 'snow.seasonalDiscountPct', '%')}
        ${n('Payment months', 'snow.seasonMonths')}${n('Priority surcharge', 'snow.priorityPct', '%')}
      </div></div>
      <div class="card" style="grid-column:1/-1"><h2>Terms & conditions</h2><textarea id="terms" style="min-height:110px">${esc(pb.terms)}</textarea></div>
    </div>`;
  app.oninput = async (ev) => {
    const p = ev.target.dataset.pb;
    if (p) { setPath(pb, p, +ev.target.value || 0); await savePricebook(); }
    if (ev.target.id === 'terms') { pb.terms = ev.target.value; await savePricebook(); }
  };
  leaving = async () => { app.oninput = null; };
  $('#reset').onclick = async () => {
    if (!(await ask('Reset all prices to defaults?', { ok: 'Reset', danger: true }))) return;
    S.pricebook = structuredClone(DEFAULT_PRICEBOOK);
    await savePricebook();
    viewPricebook();
    toast('Price book reset');
  };
}

// ---------------------------------------------------------------- settings

function viewSettings() {
  const st = S.settings;
  const b = st.business;
  const f = (label, k, type = 'text', ph = '') => `<label class="f">${label}<input type="${type}" data-s="${k}" value="${esc(getPath(st, k))}" ${ph ? `placeholder="${esc(ph)}"` : ''}></label>`;
  const tog = (label, k) => `<label class="chip"><input type="checkbox" data-s="${k}" ${getPath(st, k) ? 'checked' : ''}>${label}</label>`;
  app.innerHTML = `
    <h1>Settings</h1>
    <div class="grid g2 cols" style="align-items:start;margin-top:.75rem">
      <div>
        <div class="card"><h2>🏢 Your business</h2><p class="muted small" style="margin-top:-.4rem">This goes at the top of every quote and invoice.</p><div class="grid g2 stack">
          ${f('Business name', 'business.name')}${f('Your name', 'business.owner')}
          ${f('Phone', 'business.phone', 'tel')}${f('Email', 'business.email', 'email')}
          ${f('Address', 'business.address')}${f('Website', 'business.website')}
          ${f('License #', 'business.license')}${f('Insurance', 'business.insurance')}
          <label class="f">Brand color<input type="color" data-s="business.color" value="${esc(b.color)}" style="height:42px"></label>
          <div class="f lab">Logo<label class="btn" style="justify-content:center">🖼 ${b.logo ? 'Change logo' : 'Add your logo'}<input type="file" accept="image/*" id="logo" hidden></label></div>
        </div>${b.logo ? `<div class="row" style="margin-top:.6rem"><img src="${b.logo}" style="max-height:56px" alt="Logo"><button class="btn sm" id="rmlogo">Remove logo</button></div>` : ''}</div>
        <div class="card setup-links"><h2>🧰 How you price jobs</h2>
      <div class="actions">
        <a class="btn" href="#/resources">👷 My Resources<br><span class="tiny muted">Workers & equipment</span></a>
        <a class="btn" href="#/rates">⏱ Production Rates<br><span class="tiny muted">How fast your crew works</span></a>
        <a class="btn" href="#/pricebook">💲 Pricing<br><span class="tiny muted">Margin, tax, minimums</span></a>
      </div></div>
    <div class="card"><h2>👍 Easy to use</h2>
          <div class="grid g2">
            <label class="f">Text size<select data-s="textSize">${opt('normal', 'Normal', st.textSize)}${opt('large', 'Large', st.textSize)}${opt('xlarge', 'Extra large', st.textSize)}</select></label>
            <div class="chips" style="align-items:end">${tog('Simple screens: fewer questions and fields', 'simple')}${tog('🔊 Read prices out loud', 'voice.speak')}${tog('❓ Ask pricing questions after photos', 'askQuestions')}</div>
          </div>
          <div class="row" style="margin-top:.6rem"><button class="btn" id="rerun">🎓 Show the setup & tutorial again</button><button class="btn" id="retips">💡 Show tips again</button></div>
        </div>
      </div>
      <div>
        <div class="card"><h2>✉ Quotes &amp; sending</h2><div class="grid g2">
          ${f('Quote # prefix', 'prefix')}${f('Next quote #', 'nextNumber', 'number')}
          ${f('Remind me to follow up after (days)', 'followUpDays', 'number')}
          ${f('Payment link (Square, PayPal…)', 'business.payLink', 'url', 'https://square.link/…')}
          ${f('Google review link', 'business.reviewLink', 'url', 'https://g.page/r/…')}
          <label class="chip" style="align-self:end"><input type="checkbox" data-s="showItemized" ${st.showItemized ? 'checked' : ''}>Show labor &amp; equipment costs on quotes</label>
        </div></div>
        <div class="card"><h2>✨ Photo AI</h2>
          <label class="engine"><input type="radio" name="engine" data-s="ai.engine" value="local" ${st.ai.engine !== 'cloud' ? 'checked' : ''}>
            <span><b>On-device AI</b> <span class="badge conf-high">Free</span><br><span class="small muted">Free and private: photos never leave the phone. Works offline after a one-time download (about 25–40 MB). Fills in the job type, species, dead trees, stumps, power lines, nearby houses, rough height and snow surface.</span></span></label>
          <label class="engine"><input type="radio" name="engine" data-s="ai.engine" value="cloud" ${st.ai.engine === 'cloud' ? 'checked' : ''}>
            <span><b>Claude cloud AI</b> <span class="badge">Optional</span><br><span class="small muted">More detail (trunk size, captions, summaries). Needs your own Anthropic API key. Photos are sent to Anthropic and cost a few cents each.</span></span></label>
          <div id="localbox" class="${st.ai.engine === 'cloud' ? 'hidden' : ''}" style="margin-top:.6rem">
            <div class="small" id="aistat">${esc(aiStatusText())}</div>
            <div class="row" style="margin-top:.5rem"><button class="btn" id="aidl">⬇ Download AI now</button></div>
            <details class="fold" style="margin-top:.5rem"><summary class="small">Technical details</summary>
            <div class="row" style="margin-top:.5rem">
              <label class="f" style="width:auto">Processor<select data-s="ai.processor">${opt('auto', 'Auto (GPU when available)', st.ai.processor)}${opt('cpu', 'CPU only', st.ai.processor)}</select></label>
              <button class="btn sm danger" id="aiclear">Remove downloaded AI</button>
            </div>
            <div class="tiny muted" style="margin-top:.4rem">Model: TinyCLIP ViT-8M/16 (Microsoft, MIT license), 8-bit, running on ONNX Runtime Web. Uses WebGPU when the device has it, otherwise WebAssembly.</div>
            </details>
          </div>
          <div id="cloudbox" class="${st.ai.engine === 'cloud' ? '' : 'hidden'}" style="margin-top:.6rem">
            <div class="grid">${f('Anthropic API key', 'ai.apiKey', 'password', 'sk-ant-…')}
            <label class="f">Model<select data-s="ai.model">${[['claude-opus-5-5', 'Claude Opus 5.5 (most accurate)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, cheaper)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest, cheapest)']].map(([m, l]) => opt(m, l, st.ai.model)).join('')}</select></label></div>
            <div class="row" style="margin-top:.6rem"><button class="btn" id="testkey">Test key</button><a class="small" href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Get an API key →</a></div>
          </div>
          <div class="chips" style="margin-top:.6rem">${tog('Analyze photos automatically', 'ai.auto')}</div>
        </div>
        <div class="card"><h2>📍 Location</h2>
          <p class="muted small">Fills in the job address from where you're standing, and the drive distance from your shop.</p>
          <div class="chips">${tog('Fill in address automatically when I snap a job', 'geo.autoLocate')}</div>
          <div class="row" style="margin-top:.6rem"><button class="btn" id="shopaddr">Set shop from business address</button><button class="btn" id="shophere">Shop is here</button></div>
          <div class="muted small" style="margin-top:.4rem" id="shoplbl">${st.geo.shop ? `Shop: ${esc(st.geo.shop.label || `${st.geo.shop.lat.toFixed(4)}, ${st.geo.shop.lon.toFixed(4)}`)}` : 'Shop location not set: distance can\'t be filled in automatically.'}</div>
        </div>
        <div class="card"><h2>Data</h2>
          <p class="muted small">Everything is stored on this device. Back up regularly, or move your data to a new phone. Backups leave out your API key.</p>
          <div class="row"><button class="btn" id="export">⬇ Backup</button><label class="btn">⬆ Restore<input type="file" accept="application/json" id="import" hidden></label>
          <button class="btn" id="demo">Load sample quotes</button><button class="btn danger" id="wipe">Erase all</button></div>
        </div>
      </div>
    </div>`;
  const onS = async (ev) => {
    const k = ev.target.dataset.s;
    if (!k) return;
    let v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    if (ev.target.type === 'number') v = +v;
    if (ev.target.type === 'radio' && !ev.target.checked) return;
    if (k === 'ai.apiKey') v = v.trim();
    setPath(st, k, v);
    await saveSettings();
    if (k === 'ai.engine') {
      $('#localbox')?.classList.toggle('hidden', v === 'cloud');
      $('#cloudbox')?.classList.toggle('hidden', v !== 'cloud');
    }
    if (k === 'ai.processor') localAI.setProcessor(v);
    if (k === 'textSize') applyTextSize();
    if (k === 'voice.speak' && v) speak('Prices will be read out loud.');
    const stEl = $('#aistat');
    if (stEl) stEl.textContent = aiStatusText();
  };
  app.oninput = onS;
  app.onchange = onS;
  leaving = async () => { app.oninput = null; app.onchange = null; };
  $('#rerun').onclick = () => startOnboarding();
  $('#retips').onclick = async () => { S.settings.seenTips = {}; await saveSettings(); toast('Tips will show again on each screen'); };
  $('#aidl').onclick = async () => {
    if (!localAI.support.ok) { toast(localAI.support.reason, 5000); return; }
    await localAI.load().then(() => toast('✓ AI ready. Photo analysis now works offline.')).catch((err) => toast(err.message, 5000));
  };
  $('#aiclear').onclick = async () => {
    if (!(await ask('Remove the downloaded AI from this phone? It downloads again the next time you analyze a photo.', { ok: 'Remove', danger: true }))) return;
    await localAI.clear().catch(() => {});
    const stEl = $('#aistat');
    if (stEl) stEl.textContent = aiStatusText();
    toast('Downloaded AI removed');
  };
  $('#testkey').onclick = async (ev) => {
    const btn = ev.currentTarget;
    if (!st.ai.apiKey) { toast('Paste your API key first'); return; }
    btn.disabled = true;
    btn.textContent = 'Testing…';
    try { await testKey(st.ai.apiKey, st.ai.model); toast('✅ Key works. Photo analysis is on.'); } catch (err) { toast('❌ ' + err.message, 5000); } finally { btn.disabled = false; btn.textContent = 'Test key'; }
  };
  const setShop = async (getter) => {
    try {
      st.geo.shop = await getter();
      st.geo.shop.state = stateFrom(st.geo.shop.label) || null;
      await saveSettings();
      refreshFuel({ quiet: true }).catch(() => {});
      $('#shoplbl').textContent = 'Shop: ' + (st.geo.shop.label || `${st.geo.shop.lat.toFixed(4)}, ${st.geo.shop.lon.toFixed(4)}`);
      toast('📍 Shop location saved');
    } catch (err) { toast(err.message, 4000); }
  };
  $('#shopaddr').onclick = () => (b.address ? setShop(() => geocode(b.address)) : toast('Enter your business address first'));
  $('#shophere').onclick = () => setShop(async () => {
    const p = await getPosition();
    const label = await reverseGeocode(p.lat, p.lon).catch(() => '');
    return { lat: p.lat, lon: p.lon, label };
  });
  $('#logo').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    b.logo = await compressImage(file, 400, 0.9);
    await saveSettings();
    viewSettings();
  };
  const rm = $('#rmlogo');
  if (rm) rm.onclick = async () => { b.logo = ''; await saveSettings(); viewSettings(); };
  $('#export').onclick = async () => {
    const keys = await kv.keys();
    const data = {};
    for (const k of keys) data[k] = await kv.get(k);
    const safe = structuredClone(data);
    if (safe.settings?.ai) safe.settings.ai.apiKey = '';
    download(new Blob([JSON.stringify({ app: 'quotesnap', v: 2, at: new Date().toISOString(), data: safe })], { type: 'application/json' }), `quotesnap-backup-${today()}.json`);
  };
  $('#import').onchange = async (ev) => {
    try {
      const j = JSON.parse(await ev.target.files[0].text());
      if (j.app !== 'quotesnap') throw new Error();
      if (!(await ask('Restore this backup? It replaces everything on this phone.', { title: 'Restore backup?', ok: 'Restore', danger: true }))) return;
      const key = S.settings.ai.apiKey;
      await kv.clear();
      for (const [k, v] of Object.entries(j.data)) await kv.set(k, v);
      S.photos.clear();
      await load();
      if (!S.settings.ai.apiKey) { S.settings.ai.apiKey = key; await saveSettings(); }
      toast('Backup restored');
      location.hash = '#/';
    } catch { toast('That file is not a QuoteSnap backup'); }
  };
  $('#demo').onclick = async () => { await loadDemo(); toast('Sample quotes added'); location.hash = '#/'; };
  $('#wipe').onclick = async () => {
    if (!(await ask("Erase ALL quotes, photos and settings on this phone? This can't be undone.", { title: 'Erase everything?', ok: 'Erase everything', danger: true, icon: '⚠' }))) return;
    await kv.clear();
    S.photos.clear();
    await load();
    toast('All data erased');
    location.hash = '#/';
  };
}

async function loadDemo() {
  const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const samples = [
    ['Dana Whitfield', '555-0142', 'dana@example.com', '18 Orchard Ln', 'tree', 'Tree removal. 45-foot oak. Backyard access. Requires bucket truck. Haul everything away.', 'sent', 5],
    ['Marcus Lee', '555-0178', '', '402 Ridge Rd', 'tree', 'Trim two 60 ft silver maples over the house near power lines, haul debris', 'scheduled', 9],
    ['Hilltop Plaza LLC', '555-0190', 'pm@hilltop.example', '900 Commerce Dr', 'snow', 'Commercial parking lot 40,000 sq ft, 150 ft sidewalks, salt, priority before 7am, seasonal contract', 'sent', 1],
    ['Priya Natarajan', '555-0111', '', '7 Birch Ct', 'snow', 'Plow 2-car driveway and shovel front walk, salt. 6 inch storm.', 'draft', 0],
    ['Tom Becker', '555-0155', '', '55 Mill St', 'tree', 'Grind 3 stumps about 20 inch, front yard', 'declined', 14],
  ];
  for (const [name, phone, email, address, d, desc, status, ago] of samples) {
    const e = newEstimate(d, { name, phone, email, address });
    e.job.description = desc;
    e.job = applyParsed(e.job, parseDescription(desc));
    const at = new Date(Date.now() - ago * 864e5).toISOString();
    e.createdAt = at;
    e.status = status;
    if (status !== 'draft') e.sentAt = at;
    if (status === 'scheduled') { e.acceptedAt = new Date().toISOString(); e.scheduledFor = inDays(3); }
    await persist(e);
  }
  await saveSettings();
}

// ---------------------------------------------------------------- boot

async function boot() {
  await load();
  applyTextSize();
  const hb = $('#helpbtn');
  if (hb) hb.onclick = openHelp;
  window.addEventListener('hashchange', route);
  await route();
  window.__qsStarted = true;
  setTimeout(() => refreshFuel().catch(() => {}), 1500);
  if (!S.settings.onboarded) setTimeout(startOnboarding, 300);
  if (!(await kv.persistent())) {
    const bar = document.createElement('div');
    bar.className = 'callout no-print';
    bar.style.margin = '0 auto';
    bar.textContent = '⚠ This browser is blocking storage, so quotes will be lost when you close it. Open the link in Safari or Chrome and turn off Private browsing.';
    document.body.insertBefore(bar, app);
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  localAI.setProcessor(S.settings.ai.processor);
  // First visit: fetch the on-device AI in the background so it is ready (and offline) before the
  // first photo. Skipped on data-saver connections; it then downloads on first use instead.
  const conn = navigator.connection;
  if (isLocal() && localAI.support.ok && S.settings.ai.auto && !conn?.saveData && !/2g/.test(conn?.effectiveType || '')) {
    setTimeout(async () => { if (!(await localAI.isCached())) localAI.prefetch(); else renderAiChip(); }, 2500);
  }
}

boot().catch((err) => {
  console.error(err);
  window.__qsFail?.(err?.message || err);
});
