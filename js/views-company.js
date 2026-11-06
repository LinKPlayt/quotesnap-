// Business setup pages: My Resources (workers, equipment), Production Rates (+ multipliers and
// learning from completed jobs) and Pricing Settings. Uses the app's helpers via `ctx`.

import { SKILLS, CAPABILITIES, EQUIPMENT_TYPES, ATTACHMENT_TYPES, AVAILABILITY, newWorker, newEquipment, inventory, defaultCompany, DEFAULT_RATES, DEFAULT_MULTIPLIERS } from './company.js';
import { rateSuggestions, applySuggestion, compareJob } from './learning.js';
import { DEFAULT_PRICEBOOK } from './pricebook.js';

const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${label}</option>`;

// Generic binding: <input data-c="workers.0.rate" data-type="num|bool">
function bind(ctx, root, target, save, onChange) {
  const handler = (ev) => {
    const el = ev.target;
    const p = el.dataset?.c;
    if (!p) return;
    const toggle = el.tagName === 'SELECT' || el.type === 'checkbox';
    if ((ev.type === 'input' && toggle) || (ev.type === 'change' && !toggle)) return;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.type === 'num') v = v === '' ? 0 : +v;
    ctx.setPath(target(), p, v);
    clearTimeout(bind.t);
    bind.t = setTimeout(save, 300);
    onChange?.(p, v, el);
  };
  root.addEventListener('input', handler);
  root.addEventListener('change', handler);
  return () => { root.removeEventListener('input', handler); root.removeEventListener('change', handler); };
}

const num = (label, path, val, extra = '') => `<label class="f">${label}<input type="number" step="any" inputmode="decimal" data-c="${path}" data-type="num" value="${val ?? ''}" ${extra}></label>`;
const txt = (ctx, label, path, val, ph = '') => `<label class="f">${label}<input data-c="${path}" value="${ctx.esc(val ?? '')}" placeholder="${ctx.esc(ph)}"></label>`;
const chk = (label, path, val) => `<label class="chip"><input type="checkbox" data-c="${path}" data-type="bool" ${val ? 'checked' : ''}>${label}</label>`;

// ---------------------------------------------------------------- My Resources

export function viewResources(ctx) {
  const { app, S, esc, $, $$, money } = ctx;
  const C = S.company;
  let filter = viewResources.filter || 'all';
  const draw = () => {
    const inv = inventory(C);
    const typeCounts = Object.entries(inv.counts).map(([t, n]) => `<span class="chip on">${esc(EQUIPMENT_TYPES[t]?.label || t)} ${n}</span>`).join('');
    const attCounts = Object.entries(inv.attachments).map(([t, n]) => `<span class="chip">${esc(ATTACHMENT_TYPES[t] || t)} ${n}</span>`).join('');
    const eq = C.equipment.map((e, i) => ({ e, i })).filter(({ e }) => filter === 'all' || EQUIPMENT_TYPES[e.type]?.cat === filter || EQUIPMENT_TYPES[e.type]?.cat === 'both');
    app.innerHTML = `
      <div class="row"><h1>My Resources</h1><div class="spacer"></div><a class="btn sm" href="#/rates">Production rates →</a></div>
      <p class="muted">Your crew and machines. Every quote is planned with only what's here, and tells you when something is missing.</p>
      ${C.sample ? `<div class="callout">This is <b>sample data</b> so estimates work right away. Edit it to match your company, or <button class="btn sm" id="startempty">start empty</button>.</div>` : ''}
      <details class="card fold"><summary>✅ Available today: ${inv.workers} ${inv.workers === 1 ? 'worker' : 'workers'}, ${Object.values(inv.counts).reduce((a, b) => a + b, 0)} machines</summary>
        <div class="chips" style="margin-top:.4rem">${typeCounts || '<span class="muted small">No equipment yet</span>'}</div>
        ${attCounts ? `<div class="chips" style="margin-top:.4rem"><span class="tiny muted">Attachments:</span>${attCounts}</div>` : ''}
      </details>

      <div class="card"><div class="row" style="margin-bottom:.25rem"><h2 style="margin:0">👷 Workers</h2><div class="spacer"></div><button class="btn sm primary" id="addw">+ Add worker</button></div>
        <p class="tiny muted" style="margin:0 0 .5rem">Tap a name to change pay, skills or what they can run.</p>
        ${C.workers.length ? C.workers.map((w, i) => `
          <details class="res-item ${w.active === false ? 'inactive' : ''}" ${viewResources.open === w.id ? 'open' : ''} data-id="${w.id}">
            <summary><b>${esc(w.name || 'Unnamed worker')}</b> <span class="muted small">· ${esc(w.role || SKILLS[w.skill] || '')} · ${money(+w.rate || 0)}/hr${w.active === false ? ' · <b>Off</b>' : ''}${canList(w) ? ` · ${esc(canList(w))}` : ''}</span></summary>
            <div class="grid g3" style="margin-top:.6rem">
              ${txt(ctx, 'Name', `workers.${i}.name`, w.name, 'Name')}
              ${txt(ctx, 'Role', `workers.${i}.role`, w.role, 'Climber, groundworker…')}
              <label class="f">Skill level<select data-c="workers.${i}.skill">${Object.entries(SKILLS).map(([k, l]) => opt(k, l, w.skill)).join('')}</select></label>
              ${num('Hourly labor cost ($)', `workers.${i}.rate`, w.rate)}
              ${num('Overtime rate ($)', `workers.${i}.otRate`, w.otRate)}
              <label class="f">Working now?<select data-c="workers.${i}.active" data-type="boolsel">${opt('true', 'Yes, available', w.active !== false)}${opt('false', 'No (off, injured, left)', w.active !== false)}</select></label>
            </div>
            <div class="chips" style="margin-top:.5rem"><span class="tiny muted">Can operate:</span>${Object.entries(CAPABILITIES).map(([k, l]) => chk(l, `workers.${i}.can.${k}`, w.can?.[k])).join('')}
              <span class="spacer"></span><button class="btn sm danger" data-delw="${i}">Remove</button></div>
          </details>`).join('') : '<div class="empty">No workers yet. Add your crew so jobs are planned with real people.</div>'}
      </div>

      <div class="card"><div class="row" style="margin-bottom:.5rem"><h2 style="margin:0">🚜 Equipment</h2><div class="spacer"></div>
          <div class="seg">${['all', 'tree', 'snow'].map((k) => `<button data-f="${k}" class="${filter === k ? 'on' : ''}">${{ all: 'All', tree: 'Tree', snow: 'Snow' }[k]}</button>`).join('')}</div></div>
        <div class="row" style="margin-bottom:.6rem"><select id="newtype" style="flex:1">${['tree', 'snow', 'both'].map((cat) => `<optgroup label="${{ tree: 'Tree equipment', snow: 'Snow equipment', both: 'Tree & snow' }[cat]}">${Object.entries(EQUIPMENT_TYPES).filter(([, t]) => t.cat === cat).map(([k, t]) => opt(k, t.label, '')).join('')}</optgroup>`).join('')}</select>
          <button class="btn sm primary" id="adde">+ Add equipment</button></div>
        ${eq.length ? eq.map(({ e, i }) => `
          <details class="res-item ${e.availability !== 'available' ? 'inactive' : ''}" ${viewResources.open === e.id ? 'open' : ''} data-id="${e.id}">
            <summary><b>${esc(e.name)}</b> <span class="muted small">· ${esc(EQUIPMENT_TYPES[e.type]?.label || e.type)} · ${+e.available || 0} of ${+e.quantity || 0} available${e.availability !== 'available' ? ` · ${esc(AVAILABILITY[e.availability])}` : ''}${e.attachments?.length ? ` · ${e.attachments.map((a) => esc(a.name || ATTACHMENT_TYPES[a.type])).join(', ')}` : ''}</span></summary>
            <div class="grid g3" style="margin-top:.6rem">
              ${txt(ctx, 'Equipment name', `equipment.${i}.name`, e.name)}
              <label class="f">Type<select data-c="equipment.${i}.type">${Object.entries(EQUIPMENT_TYPES).map(([k, t]) => opt(k, t.label, e.type)).join('')}</select></label>
              <label class="f">Availability<select data-c="equipment.${i}.availability">${Object.entries(AVAILABILITY).map(([k, l]) => opt(k, l, e.availability)).join('')}</select></label>
              ${num('Quantity owned', `equipment.${i}.quantity`, e.quantity, 'min="0"')}
              ${num('Available for jobs', `equipment.${i}.available`, e.available, 'min="0"')}
              ${num('Purchase cost ($)', `equipment.${i}.purchaseCost`, e.purchaseCost)}
              ${num('Operating cost ($/hr)', `equipment.${i}.hourly`, e.hourly)}
              ${num('Fuel ($/hr)', `equipment.${i}.fuel`, e.fuel)}
              ${num('Maintenance ($/hr)', `equipment.${i}.maintenance`, e.maintenance)}
              ${txt(ctx, 'Production rate', `equipment.${i}.productionRate`, e.productionRate, 'e.g. 12 yd³/hr (for your records)')}
              ${txt(ctx, 'Notes', `equipment.${i}.notes`, e.notes)}
              <div class="chips" style="align-items:end">${chk('Operator required', `equipment.${i}.operator`, e.operator)}</div>
            </div>
            <h3>Attachments</h3>
            ${(e.attachments || []).map((a, j) => `<div class="row" style="margin-bottom:.35rem"><select data-c="equipment.${i}.attachments.${j}.type" style="width:auto">${Object.entries(ATTACHMENT_TYPES).map(([k, l]) => opt(k, l, a.type)).join('')}</select>
              <input data-c="equipment.${i}.attachments.${j}.name" value="${esc(a.name || '')}" placeholder="e.g. 9-foot plow" style="flex:1"><button class="btn sm" data-dela="${i}.${j}" aria-label="Remove attachment">✕</button></div>`).join('') || '<div class="muted small">None</div>'}
            <div class="row" style="margin-top:.5rem"><button class="btn sm" data-adda="${i}">+ Attachment</button><div class="spacer"></div><button class="btn sm danger" data-dele="${i}">Remove equipment</button></div>
          </details>`).join('') : '<div class="empty">No equipment in this group.</div>'}
        <p class="tiny muted">Equipment you don't own (for example a crane) is priced as a rental from <a href="#/pricebook">Pricing</a> and flagged on the quote.</p>
      </div>`;
    wire();
  };
  const save = () => ctx.saveCompany();
  const unbind = bind(ctx, app, () => C, save, (p, v, el) => {
    C.sample = false; // edited: it's the company's own data now
    if (el.dataset.type === 'boolsel') ctx.setPath(C, p, v === 'true');
    if (/^equipment\.\d+\.quantity$/.test(p)) { const i = +p.split('.')[1]; if (+C.equipment[i].available > v || C.equipment[i].available === undefined) C.equipment[i].available = v; }
    if (/^equipment\.\d+\.available$/.test(p)) { const i = +p.split('.')[1]; if (v > +C.equipment[i].quantity) { C.equipment[i].available = +C.equipment[i].quantity; el.value = C.equipment[i].available; ctx.toast('Available can\'t be more than the quantity owned'); } }
    if (/\.(type|active|availability)$/.test(p)) { remember(el); draw(); }
  });
  const remember = (el) => { viewResources.open = el.closest('details')?.dataset.id || viewResources.open; };
  ctx.setLeaving(async () => { unbind(); await save(); });
  function wire() {
    $$('[data-f]').forEach((b) => (b.onclick = () => { filter = viewResources.filter = b.dataset.f; draw(); }));
    $('#addw').onclick = () => { const w = newWorker({ name: `Worker ${C.workers.length + 1}` }); C.workers.push(w); viewResources.open = w.id; save(); draw(); $(`details[data-id="${w.id}"] input`)?.focus(); };
    $('#adde').onclick = () => { const e = newEquipment($('#newtype').value); C.equipment.push(e); viewResources.open = e.id; save(); draw(); };
    $$('[data-delw]').forEach((b) => (b.onclick = async () => { if (!(await ctx.ask(`Remove ${C.workers[+b.dataset.delw].name || 'this worker'}?`, { ok: 'Yes', danger: true }))) return; C.workers.splice(+b.dataset.delw, 1); save(); draw(); }));
    $$('[data-dele]').forEach((b) => (b.onclick = async () => { if (!(await ctx.ask(`Remove ${C.equipment[+b.dataset.dele].name}?`, { ok: 'Yes', danger: true }))) return; C.equipment.splice(+b.dataset.dele, 1); save(); draw(); }));
    $$('[data-adda]').forEach((b) => (b.onclick = () => { const e = C.equipment[+b.dataset.adda]; (e.attachments ||= []).push({ type: 'plow', name: '' }); viewResources.open = e.id; save(); draw(); }));
    $$('[data-dela]').forEach((b) => (b.onclick = () => { const [i, j] = b.dataset.dela.split('.').map(Number); C.equipment[i].attachments.splice(j, 1); viewResources.open = C.equipment[i].id; save(); draw(); }));
    $$('details.res-item').forEach((d) => d.addEventListener('toggle', () => { if (d.open) viewResources.open = d.dataset.id; }));
    const se = $('#startempty');
    if (se) se.onclick = async () => { if (!(await ctx.ask('Remove the sample workers and equipment?', { ok: 'Yes', danger: true }))) return; C.workers = []; C.equipment = []; C.sample = false; save(); draw(); };
  }
  draw();
}

// "about 2.8 h per tree" reads easier than "0.36 tree per hour"
const rateWords = (r) => {
  if (!r.rate) return `${r.baseTime} h per ${r.unit}`;
  const unit = String(r.unit).replace(/ reference\)/, ')');
  return r.rate < 1 ? `about ${Math.round((1 / r.rate) * 10) / 10} h per ${unit}` : `${r.rate} ${unit} per hour`;
};
const canList = (w) => Object.entries(CAPABILITIES).filter(([k]) => w.can?.[k]).map(([, l]) => l.toLowerCase()).join(', ');

// ---------------------------------------------------------------- Production rates + learning

export function viewRates(ctx) {
  const { app, S, esc, $, $$, money } = ctx;
  const C = S.company;
  const M = C.multipliers;
  const sensLabels = { difficulty: 'Difficulty', access: 'Access', cleanup: 'Cleanup', experience: 'Crew experience', weather: 'Weather' };
  const draw = () => {
    const sugg = rateSuggestions(S.estimates, C);
    const done = S.estimates.filter((e) => e.actual && e.original);
    const multTable = (group, title, cols = false) => `<h3>${title}</h3><table class="t">${Object.entries(M[group]).map(([k, m]) => `<tr><td>${esc(m.label)}${cols ? ` <span class="badge">${esc(m.group)}</span>${m.division !== 'both' ? ` <span class="badge ${m.division}">${m.division}</span>` : ''}` : ''}</td><td class="n" style="width:110px"><input type="number" step="0.01" data-c="multipliers.${group}.${k}.value" data-type="num" value="${m.value}"></td></tr>`).join('')}</table>`;
    const rateCard = (r, i) => `
      <details class="res-item" ${viewRates.open === r.id ? 'open' : ''} data-id="${r.id}">
        <summary><b>${esc(r.task)}</b> <span class="muted small">· ${esc(rateWords(r))} · ${r.minCrew === r.recCrew ? `${r.minCrew} ${r.minCrew === 1 ? 'person' : 'people'}` : `${r.minCrew}–${r.recCrew} people`}</span></summary>
        <div class="grid g3" style="margin-top:.6rem">
          ${txt(ctx, 'Job type', `rates.${i}.jobType`, r.jobType)}${txt(ctx, 'Task', `rates.${i}.task`, r.task)}${txt(ctx, 'Production unit', `rates.${i}.unit`, r.unit)}
          ${num('Production rate (units / hour)', `rates.${i}.rate`, r.rate)}${num('Base time (hours)', `rates.${i}.baseTime`, r.baseTime)}${txt(ctx, 'Equipment', `rates.${i}.equipment`, r.equipment)}
          ${num('Minimum crew', `rates.${i}.minCrew`, r.minCrew)}${num('Recommended crew', `rates.${i}.recCrew`, r.recCrew)}${txt(ctx, 'Notes', `rates.${i}.notes`, r.notes)}
        </div>
        <h3>How much this task is affected by…</h3>
        <div class="grid g3">${Object.entries(sensLabels).map(([k, l]) => num(`${l} multiplier`, `rates.${i}.sens.${k}`, r.sens?.[k] ?? 1, 'min="0" max="2"')).join('')}</div>
        <div class="tiny muted">1 = feels the full effect of that condition, 0.5 = half, 0 = not affected.</div>
      </details>`;
    app.innerHTML = `
      <div class="row"><h1>Production Rates</h1><div class="spacer"></div><a class="btn sm" href="#/resources">← My Resources</a></div>
      <p class="muted">How fast your crews work. Every estimate is built from these records and multipliers, not from fixed numbers inside the AI. Change them to match your company.</p>
      <div class="grid g2 cols" style="align-items:start">
        <div>
          <div class="card"><div class="row"><h2 style="margin:0">🌳 Tree work</h2><div class="spacer"></div><button class="btn sm" id="resetrates">Reset rates</button></div>
            ${C.rates.map((r, i) => (r.jobType === 'Tree' ? rateCard(r, i) : '')).join('')}</div>
          <div class="card"><h2>❄ Snow work</h2>${C.rates.map((r, i) => (r.jobType === 'Snow' ? rateCard(r, i) : '')).join('')}</div>
          <div class="card"><h2>🎓 Learn from completed jobs</h2>
            <p class="muted small">After a job, enter what really happened (open the quote, set it to Completed, fill in <b>Actual job</b>). Once at least 3 completed jobs point the same way, a suggested rate appears here. Nothing changes until you tap <b>Apply</b>.</p>
            <div class="small"><b>${done.length}</b> completed job${done.length === 1 ? '' : 's'} with actuals.</div>
            ${sugg.length ? `<table class="t wide" style="margin-top:.5rem"><tr><th>Task</th><th class="n">Jobs</th><th class="n">Actual ÷ est.</th><th class="n">Rate now</th><th class="n">Suggested</th><th></th></tr>
              ${sugg.map((s, i) => `<tr><td>${esc(s.task)}<div class="tiny muted">${esc(s.why)}</div></td><td class="n">${s.jobs}</td><td class="n">${s.ratio}×</td><td class="n">${s.current}</td><td class="n">${s.ready ? `<b>${s.suggested}</b>` : '—'}</td><td>${s.ready ? `<button class="btn sm primary" data-apply="${i}">Apply</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="muted small" style="margin-top:.4rem">No completed jobs with actuals yet.</div>'}
            ${done.length ? `<h3>Estimated vs actual</h3><table class="t wide"><tr><th>Quote</th><th class="n">Est. h</th><th class="n">Actual h</th><th class="n">Est. cost</th><th class="n">Actual cost</th></tr>
              ${done.slice(0, 12).map((e) => { const rows = compareJob(e.original, e.actual); const g = (l) => rows.find((r) => r.label === l) || {}; const h = g('Time on site'); const c = g('Total cost'); return `<tr><td><a href="#/e/${e.id}">${esc(e.number)}</a></td><td class="n">${h.est ?? '—'}</td><td class="n">${h.act ?? '—'}${h.pct != null ? ` <span class="tiny ${Math.abs(h.pct) > 10 ? 'bad' : 'muted'}">${h.pct > 0 ? '+' : ''}${h.pct}%</span>` : ''}</td><td class="n">${c.est != null ? money(c.est) : '—'}</td><td class="n">${c.act != null ? money(c.act) : '—'}${c.pct != null ? ` <span class="tiny ${Math.abs(c.pct) > 10 ? 'bad' : 'muted'}">${c.pct > 0 ? '+' : ''}${c.pct}%</span>` : ''}</td></tr>`; }).join('')}</table>` : ''}
            ${C.rateLog?.length ? `<h3>Change log</h3>${C.rateLog.slice(0, 10).map((l) => `<div class="tiny muted">${new Date(l.at).toLocaleDateString()}: ${esc(l.task)} ${l.from} → ${l.to} (${esc(l.reason)} Jobs: ${esc((l.jobs || []).join(', '))})</div>`).join('')}` : ''}
          </div>
        </div>
        <div class="card"><div class="row"><h2 style="margin:0">⚖ Difficulty multipliers</h2><div class="spacer"></div><button class="btn sm" id="resetmult">Reset multipliers</button></div>
          <p class="muted small">1.00× = no effect. Extra conditions in the same group add up (power lines 1.35 + buildings 1.20 = 1.55×).</p>
          ${multTable('difficulty', 'Overall difficulty')}
          ${multTable('access', 'Access (tree jobs)')}
          ${multTable('conditions', 'Job conditions', true)}
          ${multTable('method', 'Removal method (time multiplier)')}
          ${multTable('trim', 'Trim level')}
          ${multTable('skill', 'Crew experience')}
          ${multTable('obstacles', 'Snow: obstacles')}
          ${multTable('snowDepth', 'Snow: depth')}
        </div>
      </div>`;
    $('#resetrates').onclick = async () => { if (!(await ctx.ask('Reset all production rates to the defaults?', { ok: 'Yes', danger: true }))) return; C.rates = structuredClone(DEFAULT_RATES); ctx.saveCompany(); draw(); };
    $('#resetmult').onclick = async () => { if (!(await ctx.ask('Reset all multipliers to the defaults?', { ok: 'Yes', danger: true }))) return; C.multipliers = structuredClone(DEFAULT_MULTIPLIERS); ctx.saveCompany(); draw(); };
    $$('[data-apply]').forEach((b) => (b.onclick = async () => {
      const s = sugg[+b.dataset.apply];
      if (!(await ctx.ask(`Change "${s.task}" from ${s.current} to ${s.suggested} ${s.unit} per hour?\n\n${s.why}`, { title: 'Apply suggested rate?', ok: 'Apply' }))) return;
      applySuggestion(C, s);
      ctx.saveCompany();
      ctx.toast('Rate updated and logged');
      draw();
    }));
    $$('details.res-item').forEach((d) => d.addEventListener('toggle', () => { if (d.open) viewRates.open = d.dataset.id; }));
  };
  const unbind = bind(ctx, app, () => C, () => ctx.saveCompany());
  ctx.setLeaving(async () => { unbind(); await ctx.saveCompany(); });
  draw();
}

// ---------------------------------------------------------------- Pricing settings

export function viewPricing(ctx) {
  const { app, S, esc, $ } = ctx;
  const pb = S.pricebook;
  const n = (label, path, suffix = '') => `<label class="f">${label}${suffix ? ` <span class="muted">(${suffix})</span>` : ''}<input type="number" inputmode="decimal" step="any" data-c="${path}" data-type="num" value="${ctx.getPath(pb, path) ?? ''}"></label>`;
  // everything but the basics is folded: most people only ever change the first card
  const sec = (icon, title, hint, body, note = '') => `<details class="card fold pfold"><summary><span class="ps-t">${icon} ${title}</span><span class="tiny muted ps-h">${hint}</span></summary><div class="grid g2" style="margin-top:.6rem">${body}</div>${note}</details>`;
  app.innerHTML = `
    <div class="row"><h1>Pricing</h1><div class="spacer"></div><button class="btn sm danger" id="reset">Reset to defaults</button></div>
    <p class="muted">Your costs plus your profit margin make the price. Most people only change <b>The basics</b>. Worker pay and machine costs are in <a href="#/resources">My Resources</a>.</p>
    <div class="card basics"><h2>⭐ The basics</h2>
      <div class="grid g2">
        ${n('Profit margin', 'targetMarginPct', '%')}${n('Sales tax', 'taxPct', '%')}
        ${n('Smallest tree job', 'minJobTree', '$')}${n('Smallest snow visit', 'minJobSnow', '$')}
        ${n('Deposit to book', 'depositPct', '%')}${n('Travel cost per mile', 'travel.perMile', '$')}
      </div>
      <div class="example" id="pexample"></div>
    </div>
    <div class="grid g2 cols" style="align-items:start">
      ${sec('💰', 'Profit & markups', 'overhead, minimum profit, rush and weekend extra', `
        ${n('Overhead (other costs)', 'overheadPct', '% of cost')}${n('Round tree prices to', 'roundTo', '$')}
        ${n('Minimum profit: tree jobs', 'profit.minProfit', '$')}${n('Minimum profit: snow visits', 'profit.minProfitSnow', '$')}
        ${n('Emergency / urgent extra', 'profit.urgentPct', '%')}${n('Storm response extra', 'profit.stormPct', '%')}
        ${n('Weekend extra', 'profit.weekendPct', '%')}${n('Holiday extra', 'profit.holidayPct', '%')}
        ${n('Commercial extra', 'profit.commercialPct', '%')}${n('Residential extra', 'profit.residentialPct', '%')}
        ${n('Quote good for', 'validDays', 'days')}`)}
      ${sec('👷', 'Labor', 'default pay, payroll costs, crew size', `
        ${n('Standard hourly labor cost', 'labor.wage', '$/hr')}${n('Overtime labor cost', 'labor.overtime', '$/hr')}
        ${n('Payroll burden on all pay', 'labor.burdenPct', '%')}${n('Minimum labor charge', 'labor.minCharge', '$')}
        ${n('Default tree crew', 'crew.tree', 'if no workers listed')}${n('Default snow crew', 'crew.snow', 'if no workers listed')}`,
        '<p class="tiny muted">Overtime pay is used for emergency, storm, weekend and holiday jobs. Each worker\'s own pay is in My Resources.</p>')}
      ${sec('🚚', 'Travel', 'free miles, minimum charge, drive speed', `
        ${n('Free travel radius', 'travel.freeMiles', 'miles')}${n('Minimum travel charge', 'travel.minCharge', '$')}
        ${n('Average travel speed', 'travel.speedMph', 'mph')}${n('Load / unload time per trip', 'travel.loadTime', 'hours')}`,
        '<p class="tiny muted">Drive time is paid for every worker on the crew.</p>')}
      ${sec('🗑', 'Dump fees', 'what the dump charges per load', `
        ${n('Truck load size', 'disposal.loadYards', 'yd³')}${n('Brush', 'disposal.brush', '$/load')}
        ${n('Logs', 'disposal.logs', '$/load')}${n('Leaves', 'disposal.leaves', '$/load')}
        ${n('Stump grindings', 'disposal.stumps', '$/load')}${n('Snow hauling', 'disposal.snow', '$/load')}
        ${n('General debris', 'disposal.debris', '$/load')}`)}
      ${sec('🧂', 'Materials', 'salt, cabling kits, permits, lawn repair', `
        ${n('Salt cost', 'materials.saltPerLb', '$/lb')}${n('Salt used', 'materials.saltLbPer1000', 'lb per 1,000 sq ft')}
        ${n('Cabling kit', 'materials.cablingKit', '$')}${n('Lawn repair', 'materials.restoreKit', '$/stump')}
        ${n('Permit fee', 'materials.permitFee', '$')}`)}
      ${sec('❄', 'Snow contracts', 'season length, discount, monthly payments', `
        ${n('Storms per season', 'snow.eventsPerSeason')}${n('Seasonal discount', 'snow.seasonalDiscountPct', '%')}
        ${n('Monthly payments', 'snow.seasonMonths')}${n('Priority (before 7 AM) extra', 'snow.priorityPct', '%')}`)}
      <details class="card fold pfold"><summary><span class="ps-t">🚜 Rentals &amp; machine defaults</span><span class="tiny muted ps-h">for machines you don't own</span></summary>
        <div class="grid g2" style="margin-top:.6rem">
        ${n('Default machine cost', 'equipmentDefaults.hourly', '$/hr')}${n('Default fuel', 'equipmentDefaults.fuel', '$/hr')}
        ${n('Default maintenance', 'equipmentDefaults.maintenance', '$/hr')}${n('Mobilization charge', 'equipmentDefaults.mobilization', '$/job')}
        </div>
        <h3>Rental rates</h3>
        <table class="t"><tr><th>Equipment</th><th class="n">$/hr</th><th class="n">Min hrs</th></tr>
        ${Object.entries(pb.equipment).map(([k, q]) => `<tr><td>${esc(q.label)}</td><td><input type="number" step="any" data-c="equipment.${k}.rate" data-type="num" value="${q.rate}"></td><td><input type="number" step="any" data-c="equipment.${k}.min" data-type="num" value="${q.min}"></td></tr>`).join('')}</table></details>
      <details class="card fold pfold" style="grid-column:1/-1"><summary><span class="ps-t">📄 Terms on the quote</span><span class="tiny muted ps-h">the small print customers see</span></summary><textarea id="terms" style="min-height:110px;margin-top:.6rem">${esc(pb.terms)}</textarea></details>
    </div>`;
  // a worked example so "35% margin" means something
  const example = () => {
    const P = S.pricebook;
    const cost = 1000 * (1 + (Math.max(0, +P.overheadPct || 0) / 100));
    const m = Math.min(0.95, Math.max(0, (+P.targetMarginPct || 0) / 100));
    const price = cost / (1 - m);
    $('#pexample').innerHTML = `Example: a job with <b>$1,000</b> of labor and equipment is quoted at about <b>${ctx.money(price)}</b>, leaving <b>${ctx.money(price - cost)}</b> profit after overhead.`;
  };
  example();
  const unbind = bind(ctx, app, () => S.pricebook, () => ctx.savePricebook(), example);
  const onTerms = () => { S.pricebook.terms = $('#terms').value; ctx.savePricebook(); };
  $('#terms').addEventListener('input', onTerms);
  ctx.setLeaving(async () => { unbind(); await ctx.savePricebook(); });
  $('#reset').onclick = async () => {
    if (!(await ctx.ask('Reset all pricing settings to defaults?', { ok: 'Reset', danger: true }))) return;
    S.pricebook = structuredClone(DEFAULT_PRICEBOOK);
    await ctx.savePricebook();
    viewPricing(ctx);
    ctx.toast('Pricing reset');
  };
}

export { defaultCompany };
