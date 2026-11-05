// Controlled learning from completed jobs. Nothing retrains itself:
//   1. When a quote is accepted, the original estimate is frozen (snapshotEstimate).
//   2. After the job, the crew enters what actually happened (actual).
//   3. compareJob() shows estimated vs actual.
//   4. rateSuggestions() looks across completed jobs and SUGGESTS production-rate changes
//      once enough jobs agree. A person reviews and applies each one; every change is logged.

const r2 = (n) => Math.round(n * 100) / 100;

// The task whose rate best explains a job's duration.
export function mainRateId(est) {
  const order = ['tree_removal', 'tree_trim', 'cabling', 'stump_grinding', 'plow_loader', 'plow_skid', 'plow_truck', 'snow_blower', 'shoveling', 'sidewalks', 'roof_snow'];
  const ids = (est.tasks || []).map((t) => t.id);
  return order.find((id) => ids.includes(id)) || null;
}

export function snapshotEstimate(x, optionName) {
  return {
    at: new Date().toISOString(),
    option: optionName,
    division: x.division,
    rateId: mainRateId(x),
    crew: x.crew,
    siteHours: x.siteHours,
    travelHours: x.travelHours,
    elapsedHours: x.elapsedHours,
    laborHours: x.personHours,
    equipmentHours: r2((x.equipment || []).reduce((s, e) => s + (+e.hours || 0), 0)),
    equipment: (x.equipment || []).map((e) => ({ label: e.label, hours: e.hours })),
    laborCost: x.laborCost,
    equipmentCost: x.equipmentCost,
    fuelCost: x.fuelCost,
    disposalCost: x.disposalCost,
    travelCost: x.travel,
    materialCost: x.otherCost,
    totalCost: x.fullCost,
    price: x.price,
    profit: x.profit,
    tasks: (x.tasks || []).map((t) => ({ id: t.id, label: t.label, hours: t.hours })),
  };
}

export function newActual(orig = {}) {
  return {
    workers: orig.crew || '', workerNames: '', equipment: '', start: '', finish: '',
    laborHours: '', equipmentHours: '', fuel: '', disposal: '', travelHours: '', materials: '',
    totalCost: '', price: '', problems: '', weather: '', difficulty: 'as expected', notes: '',
  };
}

// Actual time on site: from start/finish if given, else labor-hours ÷ workers.
export function actualSiteHours(a) {
  if (a.start && a.finish) {
    const h = (new Date(a.finish) - new Date(a.start)) / 36e5;
    if (h > 0) return r2(Math.max(0, h - (+a.travelHours || 0)));
  }
  if (+a.laborHours && +a.workers) return r2(+a.laborHours / +a.workers - (+a.travelHours || 0));
  return null;
}

export function actualTotalCost(a) {
  if (+a.totalCost) return +a.totalCost;
  return null;
}

export function compareJob(orig, a) {
  if (!orig || !a) return [];
  const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(+v) ? null : +v);
  const site = actualSiteHours(a);
  const rows = [
    ['Crew size', orig.crew, num(a.workers), ''],
    ['Time on site', orig.siteHours, site, 'h'],
    ['Travel time', orig.travelHours, num(a.travelHours), 'h'],
    ['Labor-hours', orig.laborHours, num(a.laborHours), 'h'],
    ['Equipment hours', orig.equipmentHours, num(a.equipmentHours), 'h'],
    ['Fuel', orig.fuelCost, num(a.fuel), '$'],
    ['Disposal', orig.disposalCost, num(a.disposal), '$'],
    ['Materials', orig.materialCost, num(a.materials), '$'],
    ['Total cost', orig.totalCost, actualTotalCost(a), '$'],
    ['Selling price', orig.price, num(a.price), '$'],
  ];
  const price = num(a.price) ?? orig.price;
  const cost = actualTotalCost(a);
  if (cost !== null) rows.push(['Profit', orig.profit, r2(price - cost), '$']);
  return rows.map(([label, est, act, unit]) => {
    const diff = act === null || est === null || est === undefined ? null : r2(act - est);
    const pct = diff === null || !est ? null : Math.round((diff / est) * 100);
    return { label, est, act, unit, diff, pct };
  });
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Suggest rate changes from completed jobs. Needs at least `minJobs` jobs for a task, and a
// typical miss of 10% or more. Suggested rate = current rate ÷ (actual ÷ estimated time).
export function rateSuggestions(estimates, company, { minJobs = 3, threshold = 0.1 } = {}) {
  const by = {};
  for (const e of estimates) {
    const o = e.original;
    const site = e.actual && actualSiteHours(e.actual);
    if (!o?.rateId || !site || !o.siteHours) continue;
    (by[o.rateId] ||= []).push({ id: e.id, number: e.number, ratio: site / o.siteHours, at: e.completedAt || e.updatedAt });
  }
  const out = [];
  for (const [rateId, jobs] of Object.entries(by)) {
    const rate = company.rates.find((r) => r.id === rateId);
    if (!rate || !rate.rate) continue;
    const ratio = median(jobs.map((j) => j.ratio));
    const enough = jobs.length >= minJobs;
    const off = Math.abs(ratio - 1) >= threshold;
    const suggested = r2(rate.rate / ratio);
    out.push({
      rateId, task: rate.task, unit: rate.unit, jobs: jobs.length, ratio: r2(ratio), current: rate.rate, suggested,
      ready: enough && off,
      why: !enough
        ? `${jobs.length} of ${minJobs} completed jobs needed before suggesting a change.`
        : !off
          ? `Estimates are within ${Math.round(threshold * 100)}% of actual: no change needed.`
          : `Jobs took ${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio > 1 ? 'longer' : 'less time'} than estimated (median of ${jobs.length}).`,
      jobRefs: jobs.map((j) => j.number),
    });
  }
  return out.sort((a, b) => Number(b.ready) - Number(a.ready) || b.jobs - a.jobs);
}

// Apply one approved suggestion; returns a log entry.
export function applySuggestion(company, s, who = 'estimator') {
  const rate = company.rates.find((r) => r.id === s.rateId);
  if (!rate) return null;
  const entry = { at: new Date().toISOString(), rateId: s.rateId, task: rate.task, from: rate.rate, to: s.suggested, reason: s.why, jobs: s.jobRefs, by: who };
  rate.rate = s.suggested;
  (company.rateLog ||= []).unshift(entry);
  return entry;
}
