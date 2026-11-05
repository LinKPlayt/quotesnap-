import { kv, uid, compressImage } from './store.js';
import { DEFAULT_PRICEBOOK, mergePricebook } from './pricebook.js';
import {
  newJob, newTree, parseDescription, applyParsed, buildOptions, snowDepthTiers, totals, money, SPECIES,
} from './engine.js';
import { analyzeJob, aiToParsed, DEFAULT_MODEL } from './ai.js';

// ---------------------------------------------------------------- state

const S = {
  settings: null,
  pricebook: null,
  estimates: [],
  photos: new Map(), // id -> dataURL cache
};

const DEFAULT_SETTINGS = {
  business: { name: 'Your Tree & Snow Co.', owner: '', phone: '', email: '', address: '', website: '', license: '', insurance: '', logo: '', color: '#1f5f3f' },
  ai: { apiKey: '', model: DEFAULT_MODEL },
  prefix: 'Q',
  nextNumber: 1001,
  showItemized: true,
  followUpDays: 3,
};

const STATUSES = ['draft', 'sent', 'accepted', 'scheduled', 'completed', 'paid', 'declined'];
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const daysAgo = (d) => Math.floor((Date.now() - new Date(d)) / 864e5);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, path, v) {
  const ks = path.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks.at(-1)] = v;
}

async function load() {
  S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...((await kv.get('settings')) || {}) };
  S.settings.business = { ...DEFAULT_SETTINGS.business, ...S.settings.business };
  S.settings.ai = { ...DEFAULT_SETTINGS.ai, ...S.settings.ai };
  S.pricebook = mergePricebook(await kv.get('pricebook'));
  S.estimates = (await kv.get('estimates')) || [];
}
const saveSettings = () => kv.set('settings', S.settings);
const savePricebook = () => kv.set('pricebook', S.pricebook);
const saveEstimates = () => kv.set('estimates', S.estimates);

async function getPhoto(id) {
  if (!S.photos.has(id)) S.photos.set(id, await kv.get('photo:' + id));
  return S.photos.get(id);
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
    history: [{ at: new Date().toISOString(), text: 'Quote created' }],
  };
}

function compute(est) {
  const pb = S.pricebook;
  const margin = est.marginPct ?? pb.targetMarginPct;
  const options = buildOptions(est.job, pb, margin);
  const sel = options.find((o) => o.id === est.selectedOption) || options.find((o) => o.recommended) || options[0];
  const t = totals(sel.est.price, { discount: est.discount, adjustments: est.adjustments, taxPct: pb.taxPct, depositPct: pb.depositPct });
  const tiers = est.job.division === 'snow' ? snowDepthTiers(est.job, pb, margin) : null;
  return { options, sel, t, tiers, margin };
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
  est.status = status;
  est[status + 'At'] = new Date().toISOString();
  logHistory(est, `Status → ${status}`);
}

function isEmptyDraft(e) {
  return e && e.status === 'draft' && !e.customer.name && !e.job.description && !e.photos.length && !e.customer.phone;
}

// ---------------------------------------------------------------- router

let leaving = null;
async function route() {
  if (leaving) { await leaving(); leaving = null; }
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
    return location.replace('#/e/' + e.id);
  }
  if (name === 'e') return viewEditor(parts[1]);
  if (name === 'doc') return viewDoc(parts[1], q.get('t') || 'quote');
  if (name === 'estimates') return viewList(q.get('s') || 'all');
  if (name === 'customers') return viewCustomers();
  if (name === 'pricebook') return viewPricebook();
  if (name === 'settings') return viewSettings();
  app.innerHTML = '<div class="empty">Not found. <a href="#/">Go home</a></div>';
}

// ---------------------------------------------------------------- dashboard

function stats() {
  const E = S.estimates.filter((e) => !isEmptyDraft(e));
  const won = E.filter((e) => ['accepted', 'scheduled', 'completed', 'paid'].includes(e.status));
  const decided = won.length + E.filter((e) => e.status === 'declined').length;
  const month = new Date().toISOString().slice(0, 7);
  const sent = E.filter((e) => e.status === 'sent');
  return {
    E, won, sent,
    pipeline: sent.reduce((s, e) => s + (e.summary?.total || 0), 0),
    wonMonth: won.filter((e) => (e.acceptedAt || e.updatedAt).startsWith(month)).reduce((s, e) => s + (e.summary?.total || 0), 0),
    winRate: decided ? Math.round((won.length / decided) * 100) : null,
    avgMargin: won.length ? Math.round(won.reduce((s, e) => s + (e.summary?.margin || 0), 0) / won.length) : null,
    profitWon: won.reduce((s, e) => s + (e.summary?.profit || 0), 0),
    followUps: sent.filter((e) => daysAgo(e.sentAt || e.updatedAt) >= S.settings.followUpDays),
  };
}

function itemRow(e) {
  const icon = e.job.division === 'snow' ? '❄' : '🌳';
  return `<a class="item" href="#/e/${e.id}">
    <div class="thumb" data-photo="${e.photos[0] || ''}">${icon}</div>
    <div class="main">
      <div class="title">${esc(e.customer.name || 'Unnamed customer')} <span class="muted small">· ${esc(e.number)}</span></div>
      <div class="muted small" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.summary?.title || '')}</div>
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
  app.innerHTML = `
    <div class="row" style="margin-bottom:1rem">
      <div><h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}</h1><div class="muted">${esc(biz)}</div></div>
      <div class="spacer"></div>
      <a class="btn primary" href="#/new?d=tree">🌳 Tree quote</a>
      <a class="btn" style="border-color:var(--snow);color:var(--snow)" href="#/new?d=snow">❄ Snow quote</a>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="l">Open pipeline</div><div class="v">${money(st.pipeline)}</div><div class="muted small">${st.sent.length} quotes awaiting reply</div></div>
      <div class="kpi"><div class="l">Won this month</div><div class="v">${money(st.wonMonth)}</div><div class="muted small">${money(st.profitWon)} est. profit all-time</div></div>
      <div class="kpi"><div class="l">Win rate</div><div class="v">${st.winRate == null ? '—' : st.winRate + '%'}</div><div class="muted small">accepted vs declined</div></div>
      <div class="kpi"><div class="l">Avg margin won</div><div class="v">${st.avgMargin == null ? '—' : st.avgMargin + '%'}</div><div class="muted small">target ${S.pricebook.targetMarginPct}%</div></div>
    </div>
    ${st.followUps.length ? `<div class="card"><h2>⏰ Follow up today <span class="badge sent">${st.followUps.length}</span></h2>
      <p class="muted small">Sent ${S.settings.followUpDays}+ days ago with no answer. A quick follow-up wins a lot of jobs.</p>
      <div class="list">${st.followUps.slice(0, 6).map(itemRow).join('')}</div></div>` : ''}
    <div class="card"><h2>Recent quotes</h2>
      ${st.E.length ? `<div class="list">${st.E.slice(0, 8).map(itemRow).join('')}</div>` : `
      <div class="empty">
        <div style="font-size:2.5rem">📸</div>
        <h2>Snap your first quote</h2>
        <p>Take photos, type or say what the job is — “Tree removal. 45-foot oak. Backyard access. Requires bucket truck.” —<br>and QuoteSnap builds the scope, labor, equipment, materials, price and a PDF quote.</p>
        <a class="btn primary" href="#/new?d=tree">Start a tree quote</a> <a class="btn" href="#/new?d=snow">Start a snow quote</a>
      </div>`}
    </div>
    ${S.settings.business.name === DEFAULT_SETTINGS.business.name ? `<div class="callout">Set your business name, logo and phone in <a href="#/settings">Settings</a>, and your wages and equipment rates in the <a href="#/pricebook">Price Book</a>, so quotes match your numbers.</div>` : ''}
  `;
  hydrateThumbs();
}

// ---------------------------------------------------------------- list

function viewList(filter) {
  const draw = () => {
    const qv = ($('#q')?.value || '').toLowerCase();
    const rows = S.estimates
      .filter((e) => !isEmptyDraft(e))
      .filter((e) => filter === 'all' || e.status === filter || (filter === 'won' && ['accepted', 'scheduled', 'completed', 'paid'].includes(e.status)))
      .filter((e) => !qv || [e.customer.name, e.customer.address, e.number, e.summary?.title, e.customer.phone].join(' ').toLowerCase().includes(qv));
    $('#rows').innerHTML = rows.length ? rows.map(itemRow).join('') : '<div class="empty">No quotes match.</div>';
    hydrateThumbs($('#rows'));
  };
  app.innerHTML = `
    <div class="row" style="margin-bottom:.75rem"><h1>Quotes</h1><div class="spacer"></div>
      <button class="btn sm" id="csv">Export CSV</button></div>
    <input id="q" placeholder="Search name, address, quote #…" style="margin-bottom:.6rem">
    <div class="chips" style="margin-bottom:.75rem">
      ${['all', ...STATUSES].map((s) => `<a class="chip" style="${s === filter ? 'background:var(--primary-soft);border-color:var(--primary);color:var(--primary)' : ''}" href="#/estimates?s=${s}">${cap(s)}</a>`).join('')}
    </div>
    <div class="card"><div class="list" id="rows"></div></div>`;
  $('#q').addEventListener('input', draw);
  $('#csv').onclick = exportCsv;
  draw();
}

function exportCsv() {
  const head = ['Quote', 'Created', 'Status', 'Division', 'Customer', 'Phone', 'Email', 'Address', 'Job', 'Option', 'Total', 'Est. profit', 'Margin %'];
  const rows = S.estimates.filter((e) => !isEmptyDraft(e)).map((e) => [
    e.number, e.createdAt.slice(0, 10), e.status, e.job.division, e.customer.name, e.customer.phone, e.customer.email, e.customer.address,
    e.summary?.title, e.summary?.option, e.summary?.total, Math.round(e.summary?.profit || 0), e.summary?.margin,
  ]);
  const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  download(new Blob([csv], { type: 'text/csv' }), `quotesnap-${new Date().toISOString().slice(0, 10)}.csv`);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- customers

function viewCustomers() {
  const map = new Map();
  for (const e of S.estimates.filter((x) => !isEmptyDraft(x) && x.customer.name)) {
    const k = (e.customer.name + '|' + (e.customer.phone || '')).toLowerCase();
    const c = map.get(k) || { ...e.customer, quotes: [], won: 0 };
    c.quotes.push(e);
    if (['accepted', 'scheduled', 'completed', 'paid'].includes(e.status)) c.won += e.summary?.total || 0;
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

function opt(value, label, cur) { return `<option value="${value}" ${String(cur) === String(value) ? 'selected' : ''}>${label}</option>`; }
function field(label, k, val, attrs = '') { return `<label class="f">${label}<input data-k="${k}" value="${esc(val ?? '')}" ${attrs}></label>`; }
function numField(label, k, val, attrs = '') { return field(label, k, val, `type="number" inputmode="decimal" data-type="num" ${attrs}`); }
function check(label, k, val) { return `<label class="chip"><input type="checkbox" data-k="${k}" data-type="bool" ${val ? 'checked' : ''}>${label}</label>`; }

async function viewEditor(id) {
  const est = S.estimates.find((e) => e.id === id);
  if (!est) { app.innerHTML = '<div class="empty">Quote not found. <a href="#/estimates">Back to quotes</a></div>'; return; }
  ED = { est: structuredClone(est), tab: 'scope' };
  leaving = async () => {
    await flushSave();
    const cur = S.estimates.find((e) => e.id === id);
    if (isEmptyDraft(cur)) { S.estimates = S.estimates.filter((e) => e.id !== id); await saveEstimates(); }
  };
  const e = ED.est;
  const customers = [...new Map(S.estimates.filter((x) => x.customer.name).map((x) => [x.customer.name, x.customer])).values()];
  app.innerHTML = `
    <div class="row no-print" style="margin-bottom:.75rem">
      <a class="btn sm" href="#/estimates">←</a>
      <h1 style="margin:0">${esc(e.number)}</h1>
      <select id="status" style="width:auto">${STATUSES.map((s) => opt(s, cap(s), e.status)).join('')}</select>
      <div class="spacer"></div><span class="muted small" id="saved">Saved</span>
    </div>
    <div class="editor">
      <div>
        <div class="card">
          <h2>👤 Customer</h2>
          <div class="grid g2 stack">
            <label class="f">Name<input data-k="customer.name" list="custlist" value="${esc(e.customer.name)}" autocomplete="off"></label>
            ${field('Phone', 'customer.phone', e.customer.phone, 'type="tel" inputmode="tel"')}
            ${field('Email', 'customer.email', e.customer.email, 'type="email"')}
            ${field('Job site address', 'customer.address', e.customer.address)}
          </div>
          <datalist id="custlist">${customers.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
          ${e.customer.address ? `<div style="margin-top:.5rem"><a class="small" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(e.customer.address)}">📍 Open in Maps</a></div>` : ''}
        </div>

        <div class="card">
          <h2>📸 Photos & job notes</h2>
          <div class="photos" id="photos"></div>
          <h3>Describe the job</h3>
          <textarea data-k="job.description" id="desc" placeholder="e.g. Tree removal. 45-foot oak. Backyard access. Requires bucket truck. Over the garage, haul everything, grind the stump.">${esc(e.job.description)}</textarea>
          <div class="row" style="margin-top:.5rem">
            <button class="btn primary" id="autofill">⚡ Auto-fill from notes</button>
            <button class="btn ai-btn" id="aibtn">✨ AI analyze photos</button>
            <button class="btn" id="mic" title="Dictate">🎤 Dictate</button>
          </div>
          <div id="aiout">${aiPanel(e)}</div>
        </div>

        <div class="card">
          <div class="row" style="margin-bottom:.75rem"><h2 style="margin:0">🧾 Job details</h2><div class="spacer"></div>
            <div class="seg ${e.job.division === 'snow' ? 'snow' : ''}" id="div">
              <button data-d="tree" class="${e.job.division === 'tree' ? 'on' : ''}">🌳 Tree</button>
              <button data-d="snow" class="${e.job.division === 'snow' ? 'on' : ''}">❄ Snow</button>
            </div></div>
          <div id="details"></div>
          <h3>Site</h3>
          <div class="grid g3">
            ${numField('Distance (miles)', 'job.miles', e.job.miles)}
            <div class="chips" style="align-items:end">${check('🚨 Emergency / storm', 'job.emergency', e.job.emergency)}${e.job.division === 'tree' ? check('Permit needed', 'job.permit', e.job.permit) : ''}</div>
          </div>
        </div>

        <div class="card">
          <h2>➕ Adjustments</h2>
          <div id="adjs"></div>
          <div class="row" style="margin-top:.5rem">
            <button class="btn sm" id="addadj">+ Custom line item</button>
            <div class="spacer"></div>
            <label class="f" style="width:140px">Discount ($)<input data-k="discount" type="number" inputmode="decimal" data-type="num" value="${e.discount || ''}"></label>
          </div>
          <h3>Internal notes (not on quote)</h3>
          <textarea data-k="notes" placeholder="Gate code, dog in yard, wants work before June…">${esc(e.notes)}</textarea>
        </div>
      </div>

      <div class="results">
        <div class="card">
          <div id="res-top"></div>
          <label class="f" style="margin-top:.5rem">Target margin: <b id="mval"></b>
            <input type="range" min="10" max="60" step="1" id="margin" value="${e.marginPct ?? S.pricebook.targetMarginPct}"></label>
          <div id="res"></div>
        </div>
        <div class="card">
          <h2>📤 Send & finish</h2>
          <div class="actions">
            <a class="btn primary" href="#/doc/${e.id}?t=quote">📄 Quote PDF</a>
            <button class="btn accent" id="send">✉ Send to customer</button>
            <button class="btn" id="sign">✍ Customer signs</button>
            <a class="btn" href="#/doc/${e.id}?t=jobsheet">👷 Crew job sheet</a>
            <a class="btn" href="#/doc/${e.id}?t=invoice">💵 Invoice</a>
            <button class="btn" id="dup">⧉ Duplicate</button>
          </div>
          <div class="row" style="margin-top:.75rem"><div class="spacer"></div><button class="btn sm danger" id="del">Delete quote</button></div>
          <h3>History</h3>
          <div class="small muted" id="hist"></div>
        </div>
      </div>
    </div>`;

  renderPhotos();
  renderDetails();
  renderAdjustments();
  renderResults();
  renderHistory();
  wireEditor();
}

function aiPanel(e) {
  if (!e.ai) return '';
  return `<div class="callout ai"><b>✨ AI site notes</b>${e.ai.customerSummary ? `<div style="margin:.3rem 0">${esc(e.ai.customerSummary)}</div>` : ''}
    ${e.ai.observations?.length ? `<ul class="scope small">${e.ai.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
    <div class="muted small">Check these on site. AI fills in the job fields; the price book still sets the price.</div></div>`;
}

async function renderPhotos() {
  const e = ED.est;
  const box = $('#photos');
  const imgs = await Promise.all(e.photos.map(getPhoto));
  box.innerHTML = e.photos.map((id, i) => `<div class="photo"><img src="${imgs[i] || ''}" alt="Job photo ${i + 1}"><button data-rm="${id}" aria-label="Remove photo">×</button></div>`).join('') +
    `<label class="photo add"><input type="file" accept="image/*" capture="environment" multiple id="file">📷<br>Add photo</label>`;
  $('#file').onchange = async (ev) => {
    const files = [...ev.target.files];
    for (const f of files) {
      try {
        const data = await compressImage(f);
        const pid = uid();
        await kv.set('photo:' + pid, data);
        S.photos.set(pid, data);
        e.photos.push(pid);
      } catch { toast('Could not read that photo'); }
    }
    changed();
    renderPhotos();
  };
  $$('[data-rm]', box).forEach((b) => (b.onclick = async () => {
    e.photos = e.photos.filter((p) => p !== b.dataset.rm);
    await kv.del('photo:' + b.dataset.rm);
    changed();
    renderPhotos();
  }));
}

function renderDetails() {
  const j = ED.est.job;
  const el = $('#details');
  if (j.division === 'tree') {
    const t = j.tree;
    el.innerHTML = `
      <datalist id="species">${Object.keys(SPECIES).map((s) => `<option value="${s}">`).join('')}</datalist>
      <div id="trees">${t.trees.map((tr, i) => `
        <div class="tree-row">
          <label class="f">Work<select data-k="job.tree.trees.${i}.work">${opt('remove', 'Remove', tr.work)}${opt('trim', 'Trim / prune', tr.work)}${opt('stump', 'Stump only', tr.work)}${opt('cable', 'Cable & brace', tr.work)}</select></label>
          <label class="f">Species<input list="species" data-k="job.tree.trees.${i}.species" value="${esc(tr.species)}" placeholder="oak"></label>
          ${numField('Height ft', `job.tree.trees.${i}.heightFt`, tr.heightFt)}
          ${numField('Trunk in', `job.tree.trees.${i}.dbhIn`, tr.dbhIn || '', 'placeholder="auto"')}
          ${numField('Qty', `job.tree.trees.${i}.qty`, tr.qty, 'min="1"')}
          <button class="btn sm x" data-rmtree="${i}" ${t.trees.length < 2 ? 'disabled' : ''} aria-label="Remove tree">✕</button>
        </div>`).join('')}</div>
      <button class="btn sm" id="addtree" style="margin:.5rem 0 .25rem">+ Add another tree</button>
      <div class="grid g2" style="margin-top:.5rem">
        <label class="f">Access<select data-k="job.tree.access">${opt('open', 'Open – drive right up', t.access)}${opt('driveway', 'Driveway / street', t.access)}${opt('backyard', 'Backyard through gate', t.access)}${opt('tight', 'Tight – no equipment', t.access)}</select></label>
        <label class="f">Method / equipment<select data-k="job.tree.method">${opt('auto', 'Auto-recommend', t.method)}${opt('bucket', 'Bucket truck', t.method)}${opt('crane', 'Crane', t.method)}${opt('lift', 'Spider lift', t.method)}${opt('climb', 'Climb & rig', t.method)}</select></label>
        <label class="f">Debris<select data-k="job.tree.debris">${opt('haul', 'Haul away everything', t.debris)}${opt('chipLeaveLogs', 'Haul brush, leave wood', t.debris)}${opt('leave', 'Leave all on site', t.debris)}</select></label>
        <label class="f">Trim level<select data-k="job.tree.trimLevel">${opt('light', 'Light / deadwood', t.trimLevel)}${opt('standard', 'Standard', t.trimLevel)}${opt('heavy', 'Heavy / reduction', t.trimLevel)}</select></label>
      </div>
      <h3>Hazards</h3>
      <div class="chips">
        ${check('⚡ Power lines', 'job.tree.hazards.powerLines', t.hazards.powerLines)}
        ${check('🏠 Over house', 'job.tree.hazards.overHouse', t.hazards.overHouse)}
        ${check('Near structure', 'job.tree.hazards.nearStructure', t.hazards.nearStructure)}
        ${check('☠ Dead / decayed', 'job.tree.hazards.dead', t.hazards.dead)}
        ${check('Leaning / storm', 'job.tree.hazards.leaning', t.hazards.leaning)}
        ${check('Fence / garden', 'job.tree.hazards.fenceGarden', t.hazards.fenceGarden)}
      </div>
      <h3>Extras</h3>
      <div class="chips">
        ${check('Stump grinding', 'job.tree.stumps', t.stumps)}
        ${check('Restore lawn (soil + seed)', 'job.tree.restore', t.restore)}
        ${check('Cut firewood', 'job.tree.firewood', t.firewood)}
      </div>`;
    $('#addtree').onclick = () => { t.trees.push(newTree()); renderDetails(); changed(); };
    $$('[data-rmtree]').forEach((b) => (b.onclick = () => { t.trees.splice(+b.dataset.rmtree, 1); renderDetails(); changed(); }));
  } else {
    const s = j.snow;
    el.innerHTML = `
      <div class="grid g2">
        <label class="f">Property<select data-k="job.snow.property">${opt('residential', 'Residential', s.property)}${opt('commercial', 'Commercial', s.property)}</select></label>
        <label class="f">Equipment<select data-k="job.snow.method">${opt('auto', 'Auto-recommend', s.method)}${opt('plow', 'Plow truck', s.method)}${opt('skid', 'Skid steer / pusher', s.method)}${opt('blower', 'Snow blower', s.method)}${opt('shovel', 'Shovel crew', s.method)}</select></label>
        ${numField('Paved area (sq ft)', 'job.snow.areaSqft', s.areaSqft)}
        ${numField('Sidewalks (linear ft)', 'job.snow.walkLf', s.walkLf)}
        ${numField('Design snow depth (in)', 'job.snow.depthIn', s.depthIn)}
        ${numField('Roof snow removal (sq ft)', 'job.snow.roofSqft', s.roofSqft)}
        <label class="f">Obstacles<select data-k="job.snow.obstacles">${opt('low', 'Few – open', s.obstacles)}${opt('med', 'Some – cars, curbs', s.obstacles)}${opt('high', 'Many – islands, tight', s.obstacles)}</select></label>
        ${numField('Expected events / season', 'job.snow.events', s.events || '', `placeholder="${S.pricebook.snow.eventsPerSeason}"`)}
      </div>
      <div class="muted small" style="margin:.4rem 0">Area helper: 1-car driveway ≈ 500 sq ft · 2-car ≈ 1,000 · parking space ≈ 320 · 1 acre = 43,560</div>
      <h3>Service</h3>
      <div class="chips">
        ${check('🧂 Salt / de-ice', 'job.snow.salt', s.salt)}
        ${check('⭐ Priority (before 7 AM)', 'job.snow.priority', s.priority)}
      </div>
      <h3>Quote as</h3>
      <label class="f"><select data-k="job.snow.contract">${opt('perPush', 'Per push (pay per visit)', s.contract)}${opt('seasonal', 'Seasonal contract', s.contract)}</select></label>`;
  }
}

function renderAdjustments() {
  const e = ED.est;
  $('#adjs').innerHTML = e.adjustments.length
    ? e.adjustments.map((a, i) => `<div class="row" style="margin-bottom:.4rem">
        <input data-k="adjustments.${i}.label" value="${esc(a.label)}" placeholder="Description" style="flex:2">
        <input data-k="adjustments.${i}.amount" data-type="num" type="number" inputmode="decimal" value="${a.amount ?? ''}" placeholder="$" style="flex:1">
        <button class="btn sm" data-rmadj="${i}" aria-label="Remove">✕</button></div>`).join('')
    : '<div class="muted small">Add-ons like “Remove 2 extra limbs over shed – $150”, or a negative amount for credits.</div>';
  $$('[data-rmadj]').forEach((b) => (b.onclick = () => { e.adjustments.splice(+b.dataset.rmadj, 1); renderAdjustments(); changed(); }));
}

function renderHistory() {
  $('#hist').innerHTML = (ED.est.history || []).slice().reverse().map((h) => `<div>${fmtDate(h.at)} — ${esc(h.text)}</div>`).join('');
}

function renderResults() {
  const e = ED.est;
  const { options, sel, t, tiers, margin } = compute(e);
  const x = sel.est;
  $('#mval').textContent = margin + '%';
  $('#res-top').innerHTML = `
    <div class="muted small">${esc(jobTitle(e.job))}</div>
    <div class="price-hero"><div class="big">${money(t.total)}</div><div class="muted">${sel.unit ? esc(sel.unit) : 'customer price'}${t.tax ? ' incl. tax' : ''}</div></div>
    <div class="row small"><span>Profit <b style="color:var(--ok)">${money(x.profit - (e.discount || 0))}</b></span>
      <span>· Margin <b>${Math.round(((x.profit - (e.discount || 0)) / Math.max(1, t.subtotal)) * 100)}%</b></span>
      <span>· Cost ${money(x.fullCost)}</span>
      ${x.seasonal ? '' : `<span>· ${x.labor.crew} crew × ${x.siteHours} h${x.grindHours ? ` + ${x.grindHours} h grinding` : ''}</span>`}</div>
    ${options.length > 1 ? `<h3>Customer options</h3><div class="options">${options.map((o) => `
      <button class="opt ${o.id === sel.id ? 'on' : ''}" data-opt="${o.id}">
        ${o.recommended ? '<div class="rec">★ As specified</div>' : '<div class="rec" aria-hidden="true" style="visibility:hidden">&nbsp;</div>'}
        <div class="n">${esc(o.name)}</div><div class="p">${money(o.est.price)}</div><div class="b">${esc(o.blurb || '')}</div>
      </button>`).join('')}</div>` : ''}`;
  $$('[data-opt]').forEach((b) => (b.onclick = () => { e.selectedOption = b.dataset.opt; renderResults(); changed(false); }));

  const tabs = { scope: 'Scope', labor: 'Labor', equip: 'Equipment', mat: 'Materials', profit: 'Profit', safety: 'Safety' };
  let body = '';
  if (ED.tab === 'scope') {
    body = `<ul class="scope">${sel.scope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      ${tiers ? `<h3>Price by snowfall</h3><table class="t"><tr>${tiers.map((r) => `<th class="n">${r.label}</th>`).join('')}</tr><tr>${tiers.map((r) => `<td class="n">${money(r.price)}</td>`).join('')}</tr></table>` : ''}`;
  } else if (ED.tab === 'labor') {
    body = `<table class="t"><tr><th>Item</th><th class="n">Value</th></tr>
      <tr><td>Crew size</td><td class="n">${x.labor.crew}</td></tr>
      <tr><td>On-site hours</td><td class="n">${x.labor.siteHours} h</td></tr>
      ${x.grindHours ? `<tr><td>Stump grinding (1 operator)</td><td class="n">${x.grindHours} h</td></tr>` : ''}
      <tr><td>Total person-hours</td><td class="n">${x.labor.personHours} h</td></tr>
      <tr><td>Loaded wage${e.job.emergency ? ' (emergency rate)' : ''}</td><td class="n">$${x.labor.wage}/h</td></tr>
      <tr><td>Schedule</td><td class="n">${x.days} day${x.days > 1 ? 's' : ''}</td></tr>
      ${x.seasonal ? `<tr><td>Season events</td><td class="n">${x.events}</td></tr>` : ''}
      <tfoot><tr><td>Labor cost${x.seasonal ? ' / visit' : ''}</td><td class="n">${money(x.labor.cost)}</td></tr></tfoot></table>`;
  } else if (ED.tab === 'equip') {
    body = `${x.reasons.map((r) => `<div class="callout ai small">💡 ${esc(r)}</div>`).join('')}
      <table class="t"><tr><th>Equipment</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Cost</th></tr>
      ${x.equipment.map((q) => `<tr><td>${esc(q.label)}</td><td class="n">${q.hours}</td><td class="n">$${q.rate}</td><td class="n">${money(q.cost)}</td></tr>`).join('')}
      <tfoot><tr><td colspan="3">Equipment cost${x.seasonal ? ' / visit' : ''}</td><td class="n">${money(x.equipmentCost)}</td></tr></tfoot></table>`;
  } else if (ED.tab === 'mat') {
    body = `<table class="t"><tr><th>Material</th><th class="n">Qty</th><th class="n">Cost</th></tr>
      ${x.materials.map((m) => `<tr><td>${esc(m.label)}</td><td class="n">${m.qty} ${esc(m.unit)}</td><td class="n">${money(m.cost)}</td></tr>`).join('')}
      ${x.travel ? `<tr><td>Travel</td><td class="n">${e.job.miles} mi</td><td class="n">${money(x.travel)}</td></tr>` : ''}
      <tfoot><tr><td colspan="2">Materials & travel${x.seasonal ? ' / visit' : ''}</td><td class="n">${money(x.materialCost + x.travel)}</td></tr></tfoot></table>
      ${x.volumeYd ? `<div class="muted small" style="margin-top:.4rem">≈ ${Math.round(x.volumeYd)} yd³ of wood & brush, ${x.loads} load(s) hauled.</div>` : ''}
      ${x.saltLbs ? `<div class="muted small" style="margin-top:.4rem">${x.saltLbs} lb salt per application.</div>` : ''}`;
  } else if (ED.tab === 'profit') {
    const per = x.seasonal ? ' (season)' : '';
    const pvLabel = x.seasonal ? ' / visit' : '';
    const pv = x.seasonal ? x.price / x.events : x.price; // per-visit view for seasonal contracts
    const sg = (v, c) => `<span style="width:${Math.max(0, (v / pv) * 100)}%;background:${c}"></span>`;
    body = `${x.seasonal ? `<div class="muted small">Per visit: ${money(pv)} price vs ${money(x.fullCost / x.events)} cost · Season profit ${money(x.profit)}</div>` : ''}
      <div class="profit-bar">${sg(x.laborCost, '#3f8f63')}${sg(x.equipmentCost, '#c8781e')}${sg(x.materialCost + x.travel, '#8b6bd1')}${sg(x.overhead, '#8d9a91')}${sg(pv - x.laborCost - x.equipmentCost - x.materialCost - x.travel - x.overhead, '#1f5d8f')}</div>
      <div class="legend"><span><i style="background:#3f8f63"></i>Labor</span><span><i style="background:#c8781e"></i>Equipment</span><span><i style="background:#8b6bd1"></i>Materials</span><span><i style="background:#8d9a91"></i>Overhead</span><span><i style="background:#1f5d8f"></i>Profit</span></div>
      <table class="t" style="margin-top:.6rem">
        <tr><td>Labor${pvLabel}</td><td class="n">${money(x.laborCost)}</td></tr>
        <tr><td>Equipment${pvLabel}</td><td class="n">${money(x.equipmentCost)}</td></tr>
        <tr><td>Materials & travel${pvLabel}</td><td class="n">${money(x.materialCost + x.travel)}</td></tr>
        <tr><td>Overhead (${S.pricebook.overheadPct}%)${pvLabel}</td><td class="n">${money(x.overhead)}</td></tr>
        <tr><td><b>Total cost${per}</b></td><td class="n"><b>${money(x.fullCost)}</b></td></tr>
        <tr><td>Price${per}</td><td class="n">${money(x.price)}</td></tr>
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
  if (resetOption) ED.est.selectedOption = null;
  $('#saved').textContent = 'Saving…';
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

function wireEditor() {
  const e = ED.est;
  app.addEventListener('input', onInput);
  app.addEventListener('change', onInput);
  const prevLeave = leaving;
  leaving = async () => {
    app.removeEventListener('input', onInput);
    app.removeEventListener('change', onInput);
    await prevLeave();
    ED = null;
  };

  function onInput(ev) {
    const el = ev.target;
    const k = el.dataset?.k;
    if (!k) return;
    if (ev.type === 'input' && (el.tagName === 'SELECT' || el.type === 'checkbox')) return;
    if (ev.type === 'change' && el.tagName !== 'SELECT' && el.type !== 'checkbox') return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'num') v = v === '' ? 0 : +v;
    setPath(e, k, v);
    if (k === 'customer.name') {
      const match = S.estimates.find((x) => x.id !== e.id && x.customer.name === v);
      if (match && !e.customer.phone && !e.customer.address) {
        e.customer = { ...match.customer };
        for (const f of ['phone', 'email', 'address']) { const inp = $(`[data-k="customer.${f}"]`); if (inp) inp.value = e.customer[f] || ''; }
        toast('Filled in returning customer');
      }
    }
    changed(/^job\.tree\.(debris|stumps|restore)|^job\.snow\.(salt|contract)/.test(k));
  }

  $('#margin').oninput = (ev) => { e.marginPct = +ev.target.value; changed(); };
  $('#status').onchange = (ev) => { setStatus(e, ev.target.value); renderHistory(); changed(); };

  $$('#div button').forEach((b) => (b.onclick = () => {
    if (e.job.division === b.dataset.d) return;
    e.job.division = b.dataset.d;
    e.selectedOption = null;
    $$('#div button').forEach((x) => x.classList.toggle('on', x === b));
    $('#div').classList.toggle('snow', b.dataset.d === 'snow');
    renderDetails();
    changed();
  }));

  $('#autofill').onclick = () => {
    const p = parseDescription(e.job.description);
    if (!p.division && !p.tree.trees) { toast('Add a few details first, e.g. “45 ft oak, backyard”'); return; }
    applyInto(p);
    toast('Filled in from your notes. Review the details below.');
  };

  $('#addadj').onclick = () => { e.adjustments.push({ label: '', amount: 0 }); renderAdjustments(); };

  $('#aibtn').onclick = async (ev) => {
    const btn = ev.currentTarget;
    if (!S.settings.ai.apiKey) { toast('Add your Anthropic API key in Settings → AI'); return; }
    if (!e.photos.length && !e.job.description.trim()) { toast('Add photos or notes first'); return; }
    btn.disabled = true;
    btn.textContent = '✨ Analyzing…';
    try {
      const photos = await Promise.all(e.photos.map(getPhoto));
      const a = await analyzeJob({ apiKey: S.settings.ai.apiKey, model: S.settings.ai.model, notes: e.job.description, photos, division: e.job.division });
      e.ai = { observations: a.observations, customerSummary: a.customerSummary, at: new Date().toISOString() };
      applyInto(aiToParsed(a));
      $('#aiout').innerHTML = aiPanel(e);
      logHistory(e, 'AI analysis applied');
      renderHistory();
      toast('AI filled in the job details');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ AI analyze photos';
    }
  };

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $('#mic').classList.add('hidden');
  else $('#mic').onclick = () => {
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    $('#mic').textContent = '🔴 Listening…';
    rec.onresult = (r) => {
      const text = [...r.results].map((x) => x[0].transcript).join(' ');
      e.job.description = (e.job.description ? e.job.description.trim() + ' ' : '') + text;
      $('#desc').value = e.job.description;
      const p = parseDescription(e.job.description);
      if (p.division || p.tree.trees) applyInto(p);
      changed();
    };
    rec.onend = () => ($('#mic').textContent = '🎤 Dictate');
    rec.start();
  };

  const refresh = () => { $('#status').value = e.status; renderHistory(); changed(); };
  $('#send').onclick = () => openSend(e, refresh);
  $('#sign').onclick = () => openSign(e, refresh);
  $('#dup').onclick = async () => {
    await flushSave();
    const copy = { ...structuredClone(e), id: uid(), number: `${S.settings.prefix}-${S.settings.nextNumber++}`, status: 'draft', createdAt: new Date().toISOString(), signature: null, signedName: null, history: [{ at: new Date().toISOString(), text: `Duplicated from ${e.number}` }] };
    for (const k of ['sentAt', 'acceptedAt', 'declinedAt', 'scheduledAt', 'completedAt', 'paidAt']) delete copy[k];
    // photos are shared by id; copy them so deleting one quote's photo doesn't affect the other
    copy.photos = [];
    for (const pid of e.photos) { const n = uid(); await kv.set('photo:' + n, await getPhoto(pid)); copy.photos.push(n); }
    await saveSettings();
    await persist(copy);
    location.hash = '#/e/' + copy.id;
    toast('Duplicated');
  };
  $('#del').onclick = async () => {
    if (!confirm(`Delete ${e.number}? This cannot be undone.`)) return;
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

function applyInto(parsed) {
  const e = ED.est;
  const before = e.job.division;
  e.job = applyParsed(e.job, parsed);
  e.selectedOption = null;
  if (before !== e.job.division) {
    $$('#div button').forEach((x) => x.classList.toggle('on', x.dataset.d === e.job.division));
    $('#div').classList.toggle('snow', e.job.division === 'snow');
  }
  renderDetails();
  changed();
}

// ---------------------------------------------------------------- send & sign

function quoteMessage(e) {
  const { options, sel, t } = compute(e);
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
    for (const o of options) lines.push(`• ${o.name}: ${money(o.est.price)}${o.unit ? ' ' + o.unit : ''}${o.id === sel.id ? ' (recommended)' : ''}${o.blurb ? ' – ' + o.blurb : ''}`);
  } else lines.push(`Total: ${money(t.total)}`);
  lines.push('', `Quote valid for ${S.pricebook.validDays} days.${S.pricebook.depositPct ? ` ${S.pricebook.depositPct}% deposit to schedule.` : ''}`);
  lines.push('Reply to this message with the option you would like and we will get you on the schedule.', '', b.owner || b.name, [b.phone, b.website].filter(Boolean).join(' · '));
  return lines.join('\n');
}

function followUpMessage(e) {
  const first = (e.customer.name || '').split(' ')[0] || 'there';
  return `Hi ${first}, just checking in on quote ${e.number} for ${jobTitle(e.job).toLowerCase()}. Any questions I can answer? We have openings coming up and would be glad to get you on the schedule.\n\n${S.settings.business.owner || S.settings.business.name} ${S.settings.business.phone || ''}`;
}

function openSend(e, onUpdate) {
  const m = $('#modal');
  const follow = e.status === 'sent';
  m.innerHTML = `<div class="mb">
    <h2>${follow ? 'Follow up with' : 'Send quote to'} ${esc(e.customer.name || 'customer')}</h2>
    <div class="seg" style="margin-bottom:.6rem"><button class="${follow ? '' : 'on'}" data-msg="quote">Quote</button><button class="${follow ? 'on' : ''}" data-msg="follow">Follow-up</button></div>
    <textarea id="msg" style="min-height:220px">${esc(follow ? followUpMessage(e) : quoteMessage(e))}</textarea>
    <div class="callout small">Attach the PDF: tap <b>Quote PDF</b> → <b>Save as PDF</b>, then attach it to your email or text.</div>
    <div class="actions" style="margin-top:.6rem">
      <button class="btn primary" data-via="email" ${e.customer.email ? '' : 'title="No email on file"'}>✉ Email</button>
      <button class="btn primary" data-via="sms">💬 Text</button>
      ${navigator.share ? '<button class="btn" data-via="share">↗ Share…</button>' : ''}
      <button class="btn" data-via="copy">⧉ Copy</button>
    </div>
    <div class="row" style="margin-top:.75rem"><div class="spacer"></div><button class="btn" data-close>Close</button></div></div>`;
  m.showModal();
  $$('[data-msg]', m).forEach((b) => (b.onclick = () => {
    $$('[data-msg]', m).forEach((x) => x.classList.toggle('on', x === b));
    $('#msg').value = b.dataset.msg === 'quote' ? quoteMessage(e) : followUpMessage(e);
  }));
  $('[data-close]', m).onclick = () => m.close();
  $$('[data-via]', m).forEach((b) => (b.onclick = async () => {
    const body = $('#msg').value;
    const subject = `Your quote ${e.number} from ${S.settings.business.name}`;
    const via = b.dataset.via;
    if (via === 'email') location.href = `mailto:${encodeURIComponent(e.customer.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (via === 'sms') location.href = `sms:${(e.customer.phone || '').replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(body)}`;
    if (via === 'share') { try { await navigator.share({ title: subject, text: body }); } catch { return; } }
    if (via === 'copy') { await navigator.clipboard.writeText(body); toast('Copied'); }
    if (e.status === 'draft') setStatus(e, 'sent');
    else if (e.status === 'sent') logHistory(e, 'Follow-up sent');
    if (e.status === 'sent' && !e.sentAt) e.sentAt = new Date().toISOString();
    logHistory(e, `Sent via ${via}`);
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
  let drawing = false, inked = false;
  const pos = (ev) => { const r = c.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  c.onpointerdown = (ev) => { drawing = true; c.setPointerCapture(ev.pointerId); ctx.beginPath(); ctx.moveTo(...pos(ev)); };
  c.onpointermove = (ev) => { if (!drawing) return; ctx.lineTo(...pos(ev)); ctx.stroke(); inked = true; };
  c.onpointerup = () => (drawing = false);
  $('#clr').onclick = () => { ctx.clearRect(0, 0, c.width, c.height); inked = false; };
  $('[data-close]', m).onclick = () => m.close();
  $('#decline').onclick = () => {
    setStatus(e, 'declined');
    onUpdate(); m.close(); toast('Marked declined');
  };
  $('#accept').onclick = () => {
    if (!inked) { toast('Please sign first'); return; }
    e.selectedOption = $('input[name=o]:checked', m).value;
    e.signature = c.toDataURL('image/png');
    e.signedName = $('#sname').value;
    e.signedAt = new Date().toISOString();
    setStatus(e, 'accepted');
    logHistory(e, `Signed by ${e.signedName}`);
    onUpdate(); m.close();
    toast('Accepted! 🎉 Quote signed.');
  };
}

// ---------------------------------------------------------------- printable documents

async function viewDoc(id, type) {
  const e = S.estimates.find((x) => x.id === id);
  if (!e) { app.innerHTML = '<div class="empty">Not found</div>'; return; }
  const b = S.settings.business;
  const pb = S.pricebook;
  const { options, sel, t, tiers } = compute(e);
  const x = sel.est;
  const photos = (await Promise.all(e.photos.slice(0, 6).map(getPhoto))).filter(Boolean);
  const valid = new Date(new Date(e.sentAt || e.createdAt).getTime() + pb.validDays * 864e5);
  const title = { quote: 'Quote', invoice: 'Invoice', jobsheet: 'Job Sheet' }[type];
  const depositPaid = type === 'invoice' && ['accepted', 'scheduled', 'completed', 'paid'].includes(e.status) ? t.deposit : 0;

  // customer-facing breakdown: allocate the price across cost buckets
  let breakdown = [];
  if (!x.seasonal && S.settings.showItemized) {
    const base = x.directCost || 1;
    const share = (v) => Math.round((v / base) * x.price);
    const rows = [
      [`Labor – crew of ${x.labor.crew}, approx. ${Math.round(x.siteHours + (x.grindHours || 0))} hrs`, share(x.laborCost)],
      [`Equipment – ${x.equipment.map((q) => q.label).join(', ')}`, share(x.equipmentCost)],
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
        <div><b>#${esc(e.number)}</b></div><div>Date: ${fmtDate(type === 'invoice' ? new Date() : e.createdAt)}</div>
        ${type === 'quote' ? `<div>Valid until: ${fmtDate(valid)}</div>` : ''}
        ${type === 'invoice' ? '<div>Due on receipt</div>' : ''}
        ${e.status === 'paid' && type === 'invoice' ? '<div style="margin-top:6px"><span class="stamp">PAID</span></div>' : ''}
        ${e.signature && type === 'quote' ? '<div style="margin-top:6px"><span class="stamp">ACCEPTED</span></div>' : ''}</div>
    </div>
    <div class="meta">
      <div><div class="lbl">${type === 'jobsheet' ? 'Customer' : 'Prepared for'}</div><b>${esc(e.customer.name || '—')}</b><br>${esc(e.customer.phone)}${e.customer.email ? '<br>' + esc(e.customer.email) : ''}</div>
      <div><div class="lbl">Job site</div>${esc(e.customer.address || '—')}${type === 'jobsheet' && e.customer.address ? `<br><span class="small">maps: ${esc(e.customer.address)}</span>` : ''}</div>
    </div>`;

  const photoBlock = photos.length ? `<div class="avoid"><div class="sec">Site photos</div><div class="pgrid">${photos.map((p) => `<img src="${p}" alt="">`).join('')}</div></div>` : '';
  const scopeBlock = `<div class="sec">Scope of work${options.length > 1 && type !== 'jobsheet' ? ` – ${esc(sel.name)}` : ''}</div>
    ${e.ai?.customerSummary && type !== 'jobsheet' ? `<p>${esc(e.ai.customerSummary)}</p>` : ''}
    <ul>${sel.scope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;

  let body = '';
  if (type === 'jobsheet') {
    body = `${scopeBlock}
      <div class="sec">Crew & schedule</div>
      <table><tr><td>Crew</td><td class="n">${x.labor.crew} people</td></tr><tr><td>Estimated on-site time</td><td class="n">${x.siteHours} h${x.grindHours ? ` + ${x.grindHours} h grinding` : ''}</td></tr>
      <tr><td>Days</td><td class="n">${x.days}</td></tr>${e.scheduledAt ? `<tr><td>Scheduled</td><td class="n">${fmtDate(e.scheduledAt)}</td></tr>` : ''}
      ${x.volumeYd ? `<tr><td>Debris</td><td class="n">≈ ${Math.round(x.volumeYd)} yd³, ${x.loads} load(s)</td></tr>` : ''}
      ${x.saltLbs ? `<tr><td>Salt per visit</td><td class="n">${x.saltLbs} lb</td></tr>` : ''}</table>
      <div class="sec">Equipment to bring</div>
      <table><tr><th>Equipment</th><th class="n">Est. hours</th></tr>${x.equipment.map((q) => `<tr><td>☐ ${esc(q.label)}</td><td class="n">${q.hours}</td></tr>`).join('')}</table>
      <div class="sec">Materials</div><table>${x.materials.map((m) => `<tr><td>☐ ${esc(m.label)}</td><td class="n">${m.qty} ${esc(m.unit)}</td></tr>`).join('')}</table>
      <div class="sec">Safety briefing</div>${x.safety.length ? `<ul>${x.safety.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p>Standard PPE, cones and drop-zone control.</p>'}
      ${e.ai?.observations?.length ? `<div class="sec">Check on site</div><ul>${e.ai.observations.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}
      ${e.notes ? `<div class="sec">Notes</div><p>${esc(e.notes).replace(/\n/g, '<br>')}</p>` : ''}
      ${photoBlock}
      <div class="sign"><div><div class="line"></div><div class="small">Crew lead sign-off – work complete, site clean</div></div><div><div class="line"></div><div class="small">Date / time</div></div></div>`;
  } else {
    const optTable = options.length > 1 && type === 'quote' ? `<div class="sec">Your options</div>
      <table><tr><th>Option</th><th>Includes</th><th class="n">Price</th></tr>
      ${options.map((o) => `<tr class="opt-row ${o.id === sel.id ? 'sel' : ''}"><td>${o.id === sel.id ? '☑' : '☐'} ${esc(o.name)}</td><td>${esc(o.blurb || '')}</td><td class="n">${money(o.est.price)}${o.unit ? `<br><span class="small">${esc(o.unit)}</span>` : ''}</td></tr>`).join('')}</table>` : '';
    const lines = [
      ...(breakdown.length ? breakdown : [[`${sel.name}${sel.unit ? ' (' + sel.unit + ')' : ''} – ${jobTitle(e.job)}`, x.price]]),
      ...e.adjustments.filter((a) => a.label || a.amount).map((a) => [a.label || 'Additional work', +a.amount || 0]),
    ];
    body = `${scopeBlock}${optTable}
      <div class="sec">${type === 'invoice' ? 'Charges' : `Pricing – ${esc(sel.name)}`}</div>
      <table><tr><th>Description</th><th class="n">Amount</th></tr>${lines.map((l) => `<tr><td>${esc(l[0])}</td><td class="n">${money(l[1])}</td></tr>`).join('')}</table>
      <table class="tot">
        ${e.discount ? `<tr><td>Discount</td><td class="n">-${money(e.discount)}</td></tr>` : ''}
        <tr><td>Subtotal</td><td class="n">${money(t.subtotal)}</td></tr>
        ${pb.taxPct ? `<tr><td>Tax (${pb.taxPct}%)</td><td class="n">${money(t.tax)}</td></tr>` : ''}
        <tr class="grand"><td>${type === 'invoice' ? 'Total' : 'Total'}</td><td class="n">${money(t.total)}</td></tr>
        ${type === 'quote' && t.deposit ? `<tr><td>Deposit to schedule (${pb.depositPct}%)</td><td class="n">${money(t.deposit)}</td></tr>` : ''}
        ${depositPaid ? `<tr><td>Deposit received</td><td class="n">-${money(depositPaid)}</td></tr><tr class="grand"><td>Balance due</td><td class="n">${money(e.status === 'paid' ? 0 : t.total - depositPaid)}</td></tr>` : ''}
      </table>
      ${x.seasonal ? `<p class="small"><b>Payment plan:</b> ${pb.snow.seasonMonths} monthly payments of ${money(x.monthly)}. Covers approximately ${x.events} snow events.</p>` : ''}
      ${tiers && type === 'quote' && !x.seasonal ? `<div class="sec">Per-visit price by snowfall</div><table><tr>${tiers.map((r) => `<th class="n">${r.label}</th>`).join('')}</tr><tr>${tiers.map((r) => `<td class="n">${money(r.price)}</td>`).join('')}</tr></table>` : ''}
      ${photoBlock}
      <div class="sec">Terms</div><div class="terms">${esc(pb.terms)}</div>
      ${type === 'quote' ? `<div class="sign avoid">
        <div><div class="line">${e.signature ? `<img src="${e.signature}" alt="Signature">` : ''}</div><div class="small">Customer signature${e.signedName ? ' – ' + esc(e.signedName) : ''}</div></div>
        <div><div class="line">${e.signedAt ? fmtDate(e.signedAt) : ''}</div><div class="small">Date</div></div></div>` : '<p style="margin-top:18px"><b>Thank you for your business!</b></p>'}`;
  }

  app.innerHTML = `
    <div class="doc-toolbar">
      <a class="btn" href="#/e/${e.id}">← Back to quote</a>
      <button class="btn primary" id="print">⬇ Save PDF / Print</button>
      ${type !== 'jobsheet' ? '<button class="btn accent" id="dsend">✉ Send</button>' : ''}
      <div class="spacer"></div>
      <div class="seg">${['quote', 'invoice', 'jobsheet'].map((k) => `<button class="${k === type ? 'on' : ''}" data-t="${k}">${{ quote: 'Quote', invoice: 'Invoice', jobsheet: 'Job sheet' }[k]}</button>`).join('')}</div>
    </div>
    <article class="doc" style="--brand:${esc(b.color || '#1f5f3f')}">
      ${header}${body}
      <div class="foot"><span>${esc([b.license && 'License ' + b.license, b.insurance && 'Insured: ' + b.insurance].filter(Boolean).join(' · '))}</span><span>${esc(b.name)} · ${esc(e.number)}</span></div>
    </article>`;
  $('#print').onclick = () => {
    const prev = document.title;
    document.title = `${title} ${e.number} – ${e.customer.name || ''}`.trim();
    window.print();
    setTimeout(() => (document.title = prev), 500);
  };
  $$('[data-t]').forEach((bt) => (bt.onclick = () => (location.hash = `#/doc/${e.id}?t=${bt.dataset.t}`)));
  const ds = $('#dsend');
  if (ds) ds.onclick = () => openSend(e, () => persist(e));
}

// ---------------------------------------------------------------- price book

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
    if (!confirm('Reset all prices to defaults?')) return;
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
  const f = (label, k, type = 'text') => `<label class="f">${label}<input type="${type}" data-s="${k}" value="${esc(getPath(st, k))}"></label>`;
  app.innerHTML = `
    <h1>Settings</h1>
    <div class="grid g2 cols" style="align-items:start;margin-top:.75rem">
      <div class="card"><h2>Business (shown on quotes)</h2><div class="grid g2 stack">
        ${f('Business name', 'business.name')}${f('Your name', 'business.owner')}
        ${f('Phone', 'business.phone', 'tel')}${f('Email', 'business.email', 'email')}
        ${f('Address', 'business.address')}${f('Website', 'business.website')}
        ${f('License #', 'business.license')}${f('Insurance', 'business.insurance')}
        <label class="f">Brand color<input type="color" data-s="business.color" value="${esc(b.color)}" style="height:42px"></label>
        <label class="f">Logo<input type="file" accept="image/*" id="logo"></label>
      </div>${b.logo ? `<div class="row" style="margin-top:.6rem"><img src="${b.logo}" style="max-height:56px" alt="Logo"><button class="btn sm" id="rmlogo">Remove logo</button></div>` : ''}</div>
      <div>
        <div class="card"><h2>✨ AI photo analysis</h2>
          <p class="muted small">Optional. Claude looks at your job photos and notes, then fills in species, height, trunk size, hazards and access. It also gives you site notes to double-check. Pricing always comes from your price book. Your key is stored only on this device and sent only to Anthropic.</p>
          <div class="grid">${f('Anthropic API key', 'ai.apiKey', 'password')}
          <label class="f">Model<select data-s="ai.model">${['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((m) => opt(m, m, st.ai.model)).join('')}</select></label></div>
          <p class="small"><a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Get an API key →</a></p>
        </div>
        <div class="card"><h2>Quotes</h2><div class="grid g2">
          ${f('Quote # prefix', 'prefix')}${f('Next quote #', 'nextNumber', 'number')}
          ${f('Follow-up after (days)', 'followUpDays', 'number')}
          <label class="chip" style="align-self:end"><input type="checkbox" data-s="showItemized" ${st.showItemized ? 'checked' : ''}>Itemize labor / equipment on quotes</label>
        </div></div>
        <div class="card"><h2>Data</h2>
          <p class="muted small">Everything is stored on this device. Back up regularly, or move your data to a new phone.</p>
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
    setPath(st, k, v);
    await saveSettings();
  };
  app.oninput = onS;
  app.onchange = onS;
  leaving = async () => { app.oninput = null; app.onchange = null; };
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
    download(new Blob([JSON.stringify({ app: 'quotesnap', v: 1, at: new Date().toISOString(), data: safe })], { type: 'application/json' }), `quotesnap-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };
  $('#import').onchange = async (ev) => {
    try {
      const j = JSON.parse(await ev.target.files[0].text());
      if (j.app !== 'quotesnap') throw new Error();
      if (!confirm('Restore this backup? It replaces the data on this device.')) return;
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
    if (!confirm('Erase ALL quotes, photos and settings on this device?')) return;
    await kv.clear();
    S.photos.clear();
    await load();
    toast('All data erased');
    location.hash = '#/';
  };
}

async function loadDemo() {
  const samples = [
    ['Dana Whitfield', '555-0142', 'dana@example.com', '18 Orchard Ln', 'tree', 'Tree removal. 45-foot oak. Backyard access. Requires bucket truck. Haul everything away.', 'sent', 5],
    ['Marcus Lee', '555-0178', '', '402 Ridge Rd', 'tree', 'Trim two 60 ft silver maples over the house near power lines, haul debris', 'accepted', 9],
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
    if (status === 'accepted') e.acceptedAt = new Date().toISOString();
    await persist(e);
  }
  await saveSettings();
}

// ---------------------------------------------------------------- boot

async function boot() {
  await load();
  window.addEventListener('hashchange', route);
  await route();
  window.__qsStarted = true;
  if (!(await kv.persistent())) {
    const bar = document.createElement('div');
    bar.className = 'callout no-print';
    bar.style.margin = '0 auto';
    bar.textContent = '⚠ This browser is blocking storage, so quotes will be lost when you close it. Open the link in Safari or Chrome and turn off Private browsing.';
    document.body.insertBefore(bar, app);
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch((err) => {
  console.error(err);
  window.__qsFail?.(err?.message || err);
});
