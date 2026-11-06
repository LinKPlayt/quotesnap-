// Resource-aware job planner and pricing core.
//
// A job is broken into tasks. Each task's time comes from the editable Production Rates
// (company.rates), adjusted by the job's conditions (company.multipliers) and the crew's skill.
// Work is assigned to the company's ACTIVE workers and AVAILABLE equipment only (My Resources):
// fewer machines or people than recommended makes the job take longer, and the planner says why.
// Labor-hours (people × time) and elapsed time (clock time on the job) are kept separate.

import { DEFAULT_PRICEBOOK } from './pricebook.js';
import { defaultCompany, fleet, activeWorkers, EQUIPMENT_TYPES } from './company.js';

// ---------- reference data ----------

export const SPECIES = {
  oak: 1.2, 'white oak': 1.25, 'red oak': 1.2, hickory: 1.25, walnut: 1.2, locust: 1.3, 'honey locust': 1.3,
  beech: 1.2, maple: 1.1, 'sugar maple': 1.15, 'silver maple': 1.05, ash: 1.1, elm: 1.15, sycamore: 1.15,
  cherry: 1.05, birch: 1.0, 'sweet gum': 1.05, gum: 1.05, 'tulip poplar': 1.0, poplar: 0.95, cottonwood: 1.0,
  willow: 1.05, linden: 1.0, basswood: 0.95, mulberry: 1.15, 'black locust': 1.3, catalpa: 1.0, pecan: 1.2,
  pine: 0.95, 'white pine': 0.95, spruce: 0.9, fir: 0.9, hemlock: 0.95, cedar: 0.95, arborvitae: 0.8,
  cypress: 1.0, palm: 0.8, magnolia: 1.0, dogwood: 0.9, 'crab apple': 0.95, apple: 0.95, 'bradford pear': 1.0, pear: 1.0,
};

export const HAZARDS = {
  powerLines:    { label: 'Near power lines', safety: 'Power lines present: maintain minimum approach distance; utility drop/coordination may be required. Only qualified line-clearance workers within 10 ft.' },
  overHouse:     { label: 'Over house / roof', safety: 'Canopy over structure: all limbs to be roped and lowered (rigging). No free-falling over roof.' },
  nearStructure: { label: 'Near structure', safety: 'Structure in drop zone: sectional removal with controlled rigging.' },
  dead:          { label: 'Dead / decayed', safety: 'Dead or decayed wood: inspect before climbing; aerial device or crane preferred over climbing.' },
  leaning:       { label: 'Leaning / storm damaged', safety: 'Leaning or storm-loaded tree: assess tension/compression; establish exclusion zone.' },
  fenceGarden:   { label: 'Fence / landscaping in drop zone', safety: 'Protect fence, beds and lawn with ground mats and plywood.' },
};
const EXTRA_SAFETY = {
  nearRoad: 'Next to a road: set up traffic control (cones, signs, flagger) before work starts.',
  vehicles: 'Vehicles in the drop zone: ask the owner to move them before work starts.',
  steepSlope: 'Steep slope: secure equipment and footing; consider winching logs uphill.',
};

export const METHOD_LABELS = { crane: 'Crane-assisted removal', bucket: 'Bucket truck', lift: 'Tracked spider lift', climb: 'Climbing & rigging' };

export const DEBRIS = {
  haul:          { label: 'Chip brush and haul away all wood and debris' },
  chipLeaveLogs: { label: 'Chip and haul brush; cut wood left on site' },
  leave:         { label: 'Leave all wood and brush on site' },
};

const REF_SIZE = 40 / 22 + 16 / 16; // size of the 40 ft / 16 in reference tree

// ---------- helpers ----------

export const r2 = (n) => Math.round(n * 100) / 100;
const roundUp = (n, step) => (step > 0 ? Math.ceil(n / step) * step : Math.round(n));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const hrs = (h) => `${r2(h)} h`;

export function speciesFactor(species) {
  if (!species) return 1.05;
  const s = species.toLowerCase().trim();
  if (SPECIES[s]) return SPECIES[s];
  const hit = Object.keys(SPECIES).sort((a, b) => b.length - a.length).find((k) => s.includes(k));
  return hit ? SPECIES[hit] : 1.05;
}

// Typical trunk diameter (inches at chest height) when the contractor didn't measure it.
export function estimateDbh(heightFt, species) {
  const f = speciesFactor(species);
  return Math.max(4, Math.round(heightFt * (f >= 1.1 ? 0.5 : f <= 0.9 ? 0.35 : 0.42)));
}

// Typed numbers can be blank, text, negative or absurd. Clamp them before planning so one typo
// (qty 1000000000) can't freeze the phone or produce a nonsense price.
const LIMITS = {
  qty: [1, 100], heightFt: [0, 400], dbhIn: [0, 200], miles: [0, 1000],
  areaSqft: [0, 5e6], walkLf: [0, 1e5], roofSqft: [0, 1e6], depthIn: [0, 120], events: [0, 200],
};
export function clampNum(v, key, fallback = 0) {
  const [lo, hi] = LIMITS[key];
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
function cleanTreeJob(job, tree, notes) {
  const trees = (tree.trees || []).map((t) => {
    const out = { ...t, work: oneOf(t.work, ['remove', 'trim', 'stump', 'cable'], 'remove'), species: typeof t.species === 'string' ? t.species : '', qty: Math.round(clampNum(t.qty, 'qty', 1)), heightFt: clampNum(t.heightFt, 'heightFt', 0), dbhIn: clampNum(t.dbhIn, 'dbhIn', 0) };
    if ((+t.qty || 0) > LIMITS.qty[1]) notes.push(`Number of trees limited to ${LIMITS.qty[1]} per row.`);
    if ((+t.heightFt || 0) > LIMITS.heightFt[1]) notes.push(`Tree height capped at ${LIMITS.heightFt[1]} ft: check the number.`);
    return out;
  });
  return {
    job: { ...job, miles: clampNum(job.miles, 'miles', 0) },
    tree: {
      ...tree, trees, hazards: tree.hazards || {},
      access: oneOf(tree.access, ['open', 'driveway', 'backyard', 'tight'], 'driveway'),
      method: oneOf(tree.method, ['auto', 'bucket', 'crane', 'lift', 'climb'], 'auto'),
      debris: oneOf(tree.debris, ['haul', 'chipLeaveLogs', 'leave'], 'haul'),
      trimLevel: oneOf(tree.trimLevel, ['light', 'standard', 'heavy'], 'standard'),
    },
  };
}
function cleanSnow(s) {
  return { ...s, method: oneOf(s.method, ['auto', 'plow', 'skid', 'loader', 'blower', 'shovel'], 'auto'), obstacles: oneOf(s.obstacles, ['low', 'med', 'high'], 'low'), property: oneOf(s.property, ['residential', 'commercial'], 'residential'), contract: oneOf(s.contract, ['perPush', 'seasonal'], 'perPush'), areaSqft: clampNum(s.areaSqft, 'areaSqft', 0), walkLf: clampNum(s.walkLf, 'walkLf', 0), roofSqft: clampNum(s.roofSqft, 'roofSqft', 0), depthIn: clampNum(s.depthIn, 'depthIn', 2), events: clampNum(s.events, 'events', 0) };
}
const nonNeg = (v) => Math.max(0, +v || 0);

let DEFAULT_CO = null;
const companyOr = (c) => c || (DEFAULT_CO ||= defaultCompany());

let DEFAULT_RATES_BY_ID = null;
const RATE_WARN = new Set(); // tasks whose typed rate was out of range on this estimate
const PAY_WARN = new Set(); // workers whose typed pay was out of range
const MAX_PAY = 500; // $/hr
function rateOf(company, id) {
  DEFAULT_RATES_BY_ID ||= Object.fromEntries(defaultCompany().rates.map((r) => [r.id, r]));
  const d = DEFAULT_RATES_BY_ID[id];
  const r = company.rates.find((x) => x.id === id) || d;
  // a typo like 0.000001 trees/hour would make a trillion-dollar quote: keep rates within
  // 10%–10× of the standard rate, and say so on the quote
  let rate = +r.rate;
  if (d.rate > 0) {
    const lo = d.rate * 0.1;
    const hi = d.rate * 10;
    if (!(rate > 0)) rate = d.rate;
    else if (rate < lo || rate > hi) { rate = Math.min(hi, Math.max(lo, rate)); RATE_WARN.add(r.task); }
  } else rate = 0;
  return {
    ...r,
    rate,
    baseTime: Math.max(0, +r.baseTime || 0),
    minCrew: Math.max(1, Math.round(+r.minCrew || d.minCrew)),
    recCrew: Math.max(1, Math.round(+r.recCrew || d.recCrew)),
    sens: { ...d.sens, ...Object.fromEntries(Object.entries(r.sens || {}).map(([k, v]) => [k, Math.max(0, +v || 0)])) },
  };
}

// Condition groups → one factor each: level × (1 + sum of extras). Returns factors + what applied.
export function conditionGroups(job, division, company) {
  const M = company.multipliers;
  const groups = { difficulty: M.difficulty[job.difficulty || 'normal']?.value ?? 1, access: 1, cleanup: 1, weather: 1, travel: 1 };
  if (division === 'tree') groups.access = M.access[job.tree?.access]?.value ?? 1;
  if (division === 'snow') groups.difficulty *= M.obstacles[job.snow?.obstacles]?.value ?? 1;
  const flags = { ...(division === 'tree' ? job.tree?.hazards || {} : {}), ...(job.conditions || {}) };
  const extra = { difficulty: 0, access: 0, cleanup: 0, weather: 0, travel: 0 };
  const applied = [];
  for (const [k, c] of Object.entries(M.conditions)) {
    if (!flags[k] || !(c.division === 'both' || c.division === division)) continue;
    if (k === 'nearStructure' && flags.overHouse) continue; // "over the house" already covers it
    extra[c.group] += Math.max(0, +c.value || 1) - 1;
    applied.push(`${c.label} ${c.value}×`);
  }
  if (job.difficulty && job.difficulty !== 'normal') applied.unshift(`${M.difficulty[job.difficulty]?.label} ${M.difficulty[job.difficulty]?.value}×`);
  for (const g of Object.keys(groups)) groups[g] = groups[g] * (1 + extra[g]);
  return { groups, applied };
}

// How much a task is slowed by conditions and crew skill, using the task's sensitivities.
function taskFactor(rate, groups, skillMult) {
  const s = rate.sens || {};
  let f = 1;
  for (const g of ['difficulty', 'access', 'cleanup', 'weather']) f *= 1 + ((groups[g] || 1) - 1) * (s[g] ?? 1);
  f *= 1 + (skillMult - 1) * (s.experience ?? 1);
  return f;
}

// Choose the crew: cover every needed capability first (best skill first), then fill up.
const SKILL_ORDER = { expert: 0, experienced: 1, intermediate: 2, beginner: 3 };
function pickCrew(workers, count, caps) {
  const pool = [...workers].sort((a, b) => (SKILL_ORDER[a.skill] ?? 2) - (SKILL_ORDER[b.skill] ?? 2));
  const crew = [];
  const missing = [];
  for (const cap of caps) {
    if (crew.some((w) => w.can?.[cap])) continue;
    const w = pool.find((x) => x.can?.[cap] && !crew.includes(x));
    if (w && crew.length < Math.max(count, caps.length)) crew.push(w);
    else if (!w) missing.push(cap);
  }
  for (const w of pool) if (crew.length < count && !crew.includes(w)) crew.push(w);
  return { crew, missing };
}

const canRun = (w, unit) => {
  const op = EQUIPMENT_TYPES[unit.type]?.op;
  if (!unit.operator || !op) return true;
  if (op === 'loader') return !!(w.can?.loader || w.can?.heavy);
  return !!w.can?.[op];
};

// Cost lines for a unit of owned equipment, or a rental when the company has none.
function ownedLine(unit, hours, task) {
  return { key: unit.type, label: unit.name, task, hours: r2(hours), rate: r2(unit.hourly + unit.maintenance), cost: r2(hours * (unit.hourly + unit.maintenance)), fuel: r2(hours * unit.fuel), owned: true };
}
function rentalLine(pb, rentalKey, type, hours, task) {
  const r = pb.equipment[rentalKey] || { label: EQUIPMENT_TYPES[type]?.label || type, rate: pb.equipmentDefaults.hourly, min: 0 };
  const h = Math.max(r.min || 0, hours);
  return { key: type, label: `${r.label} (rental)`, task, hours: r2(h), rate: r.rate, cost: r2(h * r.rate), fuel: r2(h * (pb.equipmentDefaults.fuel || 0)), owned: false };
}

function travelTime(job, pb, groups, oneWay = false) {
  const miles = +job.miles || 0;
  const t = pb.travel;
  const speed = +t.speedMph > 0 ? +t.speedMph : 35;
  const drive = miles > 0 ? ((oneWay ? 1 : 2) * miles) / speed : 0;
  return (drive + nonNeg(t.loadTime)) * Math.max(0, groups.travel || 1);
}

function laborRate(w, pb, overtime) {
  const cap = (v) => { if (v > MAX_PAY) PAY_WARN.add(w.name || 'A worker'); return Math.min(MAX_PAY, v); };
  const std = cap(nonNeg(+w.rate || pb.labor.wage));
  const base = overtime ? cap(nonNeg(+w.otRate || std * 1.5)) : std;
  return base * (1 + nonNeg(pb.labor.burdenPct) / 100);
}

// ---------- method choice (ideal, before checking what the company owns) ----------

export function recommendMethod(tree) {
  const reasons = [];
  if (tree.method && tree.method !== 'auto') {
    reasons.push(`${METHOD_LABELS[tree.method]} selected by estimator.`);
    return { method: tree.method, reasons };
  }
  // only removals and trims use a machine (cabling is installed by climbing)
  const tallest = Math.max(0, ...tree.trees.filter((t) => t.work === 'remove' || t.work === 'trim').map((t) => +t.heightFt || 0));
  const hz = tree.hazards || {};
  if (tallest === 0) {
    if (tree.trees.some((t) => t.work === 'cable')) reasons.push('Cabling is installed by climbing.');
    return { method: 'climb', reasons };
  }
  // a dead tree over a house needs a crane only when a bucket truck can't reach it and it's big
  const deadOverHouse = hz.overHouse && hz.dead && tallest >= 40 && (tree.access === 'backyard' || tree.access === 'tight');
  if (tallest > 75 || deadOverHouse || (tree.access === 'tight' && hz.overHouse && tallest > 50)) {
    reasons.push(tallest > 75 ? 'Tree over 75 ft: crane is fastest and safest.' : 'Dead tree over a structure: crane avoids climbing compromised wood.');
    return { method: 'crane', reasons };
  }
  if (tree.access === 'tight') {
    reasons.push('No equipment access: climbing and rigging, debris hand-carried.');
    return { method: 'climb', reasons };
  }
  if (tree.access === 'backyard') {
    if (tallest < 25) { reasons.push('Small tree: ground work and climbing only.'); return { method: 'climb', reasons }; }
    reasons.push('Backyard gate access: tracked spider lift fits through a 36" gate and protects the lawn.');
    return { method: 'lift', reasons };
  }
  if (tallest >= 25) {
    reasons.push(hz.dead ? 'Dead wood: a bucket truck is safer than climbing it.' : 'Truck can reach the tree: bucket truck is faster and safer than climbing.');
    return { method: 'bucket', reasons };
  }
  reasons.push('Small tree: ground work and climbing only.');
  return { method: 'climb', reasons };
}

// ---------- pricing ----------

function markupsFor(job, division, pb, extraPct = 0) {
  const P = pb.profit;
  const out = [];
  if (job.emergency) out.push({ label: 'Emergency / urgent', pct: P.urgentPct });
  if (job.storm) out.push({ label: 'Storm response', pct: P.stormPct });
  if (job.weekend) out.push({ label: 'Weekend', pct: P.weekendPct });
  if (job.holiday) out.push({ label: 'Holiday', pct: P.holidayPct });
  const prop = division === 'snow' ? job.snow?.property : job.property;
  if (prop === 'commercial') out.push({ label: 'Commercial', pct: P.commercialPct });
  else out.push({ label: 'Residential', pct: P.residentialPct });
  if (extraPct) out.push({ label: 'Priority service', pct: extraPct });
  return out.filter((m) => +m.pct);
}

function price(division, pb, costs, job, opts = {}, extraPct = 0) {
  const direct = costs.labor + costs.equipment + costs.fuel + costs.disposal + costs.travel + costs.materials;
  const overhead = direct * (nonNeg(pb.overheadPct) / 100);
  const fullCost = direct + overhead;
  const margin = Math.min(0.95, Math.max(0, (+(opts.marginPct ?? pb.targetMarginPct) || 0) / 100));
  const base = fullCost / (1 - margin);
  const markups = markupsFor(job, division, pb, extraPct);
  let p = base * Math.max(0, 1 + markups.reduce((s, m) => s + (+m.pct || 0), 0) / 100);
  const notes = [];
  const minProfit = nonNeg(division === 'snow' ? pb.profit.minProfitSnow ?? pb.profit.minProfit : pb.profit.minProfit);
  if (p < fullCost + minProfit) { p = fullCost + minProfit; notes.push(`Raised to keep the minimum profit of $${minProfit}.`); }
  const min = division === 'tree' ? pb.minJobTree : pb.minJobSnow;
  p = roundUp(p, division === 'snow' ? 5 : pb.roundTo);
  if (p < min) { p = min; notes.push(`Minimum job charge ($${min}) applies.`); }
  const profit = p - fullCost;
  return { directCost: r2(direct), overhead: r2(overhead), fullCost: r2(fullCost), price: p, profit: r2(profit), marginPct: r2((profit / p) * 100), markups, priceNotes: notes, basePrice: r2(base) };
}

// ---------- tree jobs ----------

// Auto equipment = the lowest-cost SAFE way to do the job, owned or rented. Safety rules only ever
// take options away as trees get bigger or more dangerous (and better access only adds options), so a
// bigger or harder job can never come out cheaper than a smaller, easier one.
const METHOD_WHY = {
  climb: 'Climbing and rigging: the lowest-cost safe way to do this job.',
  bucket: 'Bucket truck: faster than climbing and the lowest-cost safe way to do this job.',
  lift: 'Tracked spider lift: fits through a gate, protects the lawn, and is the lowest-cost safe way to do this job.',
  crane: 'Crane: saves enough crew time to be the lowest-cost safe way to do this job.',
};
export function calcTree(job, pb = DEFAULT_PRICEBOOK, opts = {}) {
  // the same cleaned-up job the planner sees (typos and broken numbers already fixed)
  const t = cleanTreeJob(job, { ...job.tree, ...(opts.override || {}) }, []).tree;
  if (t.method !== 'auto') return bestLoaders(job, pb, opts);
  const rule = recommendMethod(t);
  const hz = t.hazards || {};
  const machineWork = t.trees.filter((x) => x.work === 'remove' || x.work === 'trim');
  const tallest = Math.max(0, ...machineWork.map((x) => x.heightFt));
  let cands;
  if (!machineWork.length) cands = ['climb']; // stumps and cabling only
  else if (rule.method === 'crane') cands = ['crane']; // over 75 ft, or dead over a house: safety first
  else {
    // worse access only removes options: a bucket truck needs the driveway, a spider lift a gate
    cands = t.access === 'tight' ? ['climb', 'crane'] : t.access === 'backyard' ? ['climb', 'lift', 'crane'] : ['climb', 'bucket', 'lift', 'crane'];
    // dead wood 25 ft and up is never climbed: a machine, or a crane when nothing else gets in
    if (tallest >= 25 && hz.dead) cands = cands.filter((m) => m !== 'climb');
  }
  let best = null;
  const skipped = [];
  for (const m of cands) {
    const e = bestLoaders(job, pb, { ...opts, override: { ...(opts.override || {}), method: m }, autoPick: true });
    // that machine turned out unusable (no operator): say why, and use the other options
    if (e.method !== m) { skipped.push(...e.notes.filter((n) => /^Planned as climbing because/.test(n)).map((n) => n.replace('Planned as climbing because', `${METHOD_LABELS[m]} not used because`))); continue; }
    // cheapest wins; on a tie, the usual choice for this tree, else the faster one
    const better = !best || e.price < best.price || (e.price === best.price && best.method !== rule.method && (m === rule.method || e.elapsedHours < best.elapsedHours));
    if (better) best = e;
  }
  if (!best) best = bestLoaders(job, pb, opts);
  best.reasons = [best.method === rule.method && rule.reasons.length ? rule.reasons[0] : METHOD_WHY[best.method], ...best.reasons];
  best.config = { ...best.config, method: 'auto' };
  best.notes = [...new Set([...skipped, ...best.notes])];
  return best;
}

// One loader, or more when the time they save is worth the trip to bring them.
function bestLoaders(job, pb, opts) {
  let best = planTree(job, pb, opts);
  for (let k = 2; k <= (best.maxLoaders || 1); k++) {
    const e = planTree(job, pb, { ...opts, loaderCap: k });
    if (e.price < best.price) best = e;
  }
  return best;
}

function planTree(job, pb, opts) {
  const company = companyOr(opts.company);
  const cleanNotes = [];
  ({ job, tree: opts._tree } = cleanTreeJob(job, { ...job.tree, ...(opts.override || {}) }, cleanNotes));
  const tree = opts._tree;
  delete opts._tree;
  const M = company.multipliers;
  const hz = tree.hazards || {};
  const { groups, applied } = conditionGroups({ ...job, tree }, 'tree', company);
  const units = fleet(company);
  let workers = activeWorkers(company);
  RATE_WARN.clear();
  PAY_WARN.clear();
  const notes = [...new Set(cleanNotes)]; // resource limits / bottlenecks, in plain words
  const of = (type) => units.filter((u) => u.type === type);
  const anyone = (cap) => workers.some((w) => w.can?.[cap]);
  const overtime = !!(job.emergency || job.storm || job.weekend || job.holiday);

  // --- method: ideal, then what the company can actually do ---
  let { method, reasons } = recommendMethod(tree);
  const explicit = tree.method && tree.method !== 'auto';
  let methodRental = false;
  if (method === 'bucket' && !(of('bucket_truck').length && anyone('bucket'))) {
    const why = of('bucket_truck').length ? 'no active worker can operate the bucket truck' : 'no bucket truck is available in My Resources';
    if (explicit && !of('bucket_truck').length) { methodRental = true; notes.push(`Bucket truck priced as a rental: ${why}.`); }
    else { method = 'climb'; notes.push(`Planned as climbing because ${why}.`); }
  }
  if (method === 'lift' && !of('spider_lift').length) { methodRental = true; notes.push('Spider lift priced as a rental: none in My Resources.'); }
  if (opts.autoPick) reasons.splice(0, reasons.length);
  if (method === 'crane' && !of('crane').length) { methodRental = true; notes.push('Crane priced as a rental with operator: none in My Resources.'); }

  // --- quantities ---
  const R = (id) => rateOf(company, id);
  let cutHours = 0; // ideal crew time to cut/trim/cable, before crew-size effects
  let machineHours = 0; // part of it on trees tall enough for the bucket truck / lift / crane
  let brush = 0;
  let wood = 0;
  const stumps = [];
  let cableKits = 0;
  const treeLines = [];
  const methodF = M.method[method]?.value ?? 1;
  const trimF = M.trim[tree.trimLevel]?.value ?? 1;
  let removalCount = 0;
  for (const t of tree.trees) {
    const qty = t.qty;
    const h = t.heightFt;
    const d = +t.dbhIn > 0 ? +t.dbhIn : estimateDbh(h || 20, t.species);
    const sf = speciesFactor(t.species);
    const lin = (h / 22 + d / 16) / REF_SIZE;
    // small trees come down in a few pieces, so their cutting time drops faster than their size
    const size = lin < 1 ? Math.pow(lin, 1.5) : lin;
    const vol = (h * d) / 60; // cubic yards of wood + brush in a removed tree
    let each = 0;
    if (t.work === 'remove') {
      const r = R('tree_removal');
      // a bucket truck / lift / crane only speeds up trees tall enough to need one
      each = (r.baseTime + size / r.rate) * sf * methodF;
      brush += vol * 0.4 * qty;
      wood += vol * 0.6 * qty;
      removalCount += qty;
      if (tree.stumps) for (let i = 0; i < qty; i++) stumps.push(d);
    } else if (t.work === 'trim') {
      const r = R('tree_trim');
      each = (r.baseTime + size / r.rate) * sf * trimF * Math.max(0.8, methodF);
      brush += vol * 0.25 * trimF * qty;
    } else if (t.work === 'cable') {
      const r = R('cabling');
      each = (r.baseTime + 1 / r.rate) * (0.6 + 0.4 * (h / 40));
      cableKits += qty;
    } else if (t.work === 'stump') {
      for (let i = 0; i < qty; i++) stumps.push(d);
    }
    cutHours += each * qty;
    if (t.work === 'remove' || t.work === 'trim') machineHours += each * qty;
    treeLines.push({ ...t, dbhIn: d, qty, hours: r2(each * qty) });
  }
  const debris = tree.debris || 'haul';
  const cuttingWork = cutHours > 0;

  // --- crew ---
  const extraHand = cuttingWork && (method === 'crane' || hz.powerLines || hz.overHouse);
  // a small, simple job (about 2 hours of cutting or less) is done by the minimum safe crew
  const small = cuttingWork && !extraHand && cutHours <= 2;
  // the crew is the largest any task in the job needs (cabling alone is a 2-person job)
  const kinds = [removalCount && 'tree_removal', tree.trees.some((t) => t.work === 'trim') && 'tree_trim', tree.trees.some((t) => t.work === 'cable') && 'cabling'].filter(Boolean).map(R);
  const main = kinds[0] || R('tree_removal');
  const rec = Math.max(cuttingWork ? Math.max(...kinds.map((k) => (small ? k.minCrew : k.recCrew))) : 1, 0) + (extraHand ? 1 : 0);
  const minCrew = cuttingWork ? Math.max(...kinds.map((k) => k.minCrew)) : 1;
  const caps = [];
  if (cuttingWork) caps.push('chainsaw');
  if (method === 'bucket' && !methodRental) caps.push('bucket');
  const chipping = debris !== 'leave' && brush > 0;
  if (chipping && of('chipper').length) caps.push('chipper');
  // through a backyard gate only compact machines fit; with no access, nothing does
  const loaders = tree.access === 'tight' ? []
    : tree.access === 'backyard' ? [...of('skid_steer'), ...of('compact_loader')]
      : [...of('skid_steer'), ...of('compact_loader'), ...of('loader'), ...of('grapple')];
  const loadWood = debris === 'haul' && wood > 0;
  if (loadWood && loaders.length && tree.access !== 'tight') caps.push('loader');
  const hauling = debris !== 'leave' && (brush > 0 || wood > 0);
  if (hauling && of('dump_truck').length) caps.push('truck');

  let assumed = false;
  if (!workers.length) {
    assumed = true;
    workers = Array.from({ length: pb.crew.tree }, (_, i) => ({ name: `Worker ${i + 1}`, skill: 'experienced', rate: pb.labor.wage, otRate: pb.labor.overtime, can: { chainsaw: true, truck: true, chipper: true, bucket: true, loader: true, heavy: true } }));
    notes.push(`No active workers in My Resources: assuming a crew of ${pb.crew.tree} at the standard labor cost.`);
  }
  const { crew, missing } = pickCrew(workers, Math.min(rec, workers.length), caps);
  const crewSize = Math.max(1, crew.length);
  if (crewSize < rec) notes.push(`Estimated duration increased because only ${plural(crewSize, 'worker is', 'workers are')} available (${rec} recommended).`);
  if (cuttingWork && crewSize < minCrew) notes.push(`Below the minimum safe crew of ${minCrew} for tree work: add a worker before scheduling.`);
  const crewSlow = crewSize < rec ? Math.pow(rec / crewSize, 0.7) : 1;
  const skillMult = crew.reduce((s, w) => s + (M.skill[w.skill]?.value ?? 1), 0) / crewSize;
  const can = (cap) => crew.some((w) => w.can?.[cap]);

  const tasks = [];
  const equipment = [];
  const addTask = (t) => { tasks.push({ ...t, hours: r2(t.hours) }); return t.hours; };

  // setup
  const setup = cuttingWork || stumps.length ? R('tree_setup').baseTime * taskFactor(R('tree_setup'), groups, skillMult) : 0;
  if (setup) addTask({ id: 'tree_setup', label: R('tree_setup').task, qty: 1, unit: 'job', workers: crewSize, hours: setup, equipment: [] });

  // cutting / trimming / cabling
  let cut = 0;
  if (cuttingWork) {
    const rr = R(removalCount ? 'tree_removal' : 'tree_trim');
    cut = cutHours * taskFactor(rr, groups, skillMult) * crewSlow;
    const machineCut = method === 'climb' ? 0 : cut * (machineHours / cutHours);
    const label = treeLines.filter((t) => t.work !== 'stump').map((t) => `${t.qty} × ${t.heightFt ? t.heightFt + ' ft ' : ''}${t.species || 'tree'} (${t.work})`).join(', ');
    const eq = [];
    const saws = of('chainsaw').slice(0, Math.min(crew.filter((w) => w.can?.chainsaw).length || 1, 3));
    if (!of('chainsaw').length) notes.push('No chainsaws listed in My Resources: add them so their cost is counted.');
    saws.forEach((u) => { equipment.push(ownedLine(u, cut, 'Cutting')); eq.push(u.name); });
    if (method === 'bucket') {
      if (methodRental) { equipment.push(rentalLine(pb, 'bucket', 'bucket_truck', machineCut, 'Cutting')); eq.push('Bucket truck (rental)'); }
      else { const u = of('bucket_truck')[0]; equipment.push(ownedLine(u, machineCut, 'Cutting')); eq.push(u.name); }
    } else if (method === 'crane') {
      if (methodRental) { equipment.push(rentalLine(pb, 'crane', 'crane', machineCut * 0.7, 'Cutting')); eq.push('Crane (rental)'); }
      else { const u = of('crane')[0]; equipment.push(ownedLine(u, machineCut * 0.7, 'Cutting')); eq.push(u.name); }
    } else if (method === 'lift') {
      if (methodRental) { equipment.push(rentalLine(pb, 'lift', 'spider_lift', machineCut, 'Cutting')); eq.push('Spider lift (rental)'); }
      else { const u = of('spider_lift')[0]; equipment.push(ownedLine(u, machineCut, 'Cutting')); eq.push(u.name); }
    }
    const gear = of('climbing_gear')[0];
    // climbing gear: all of the small trees' time, plus some rigging on the machine trees
    const gearHours = method === 'climb' ? cut : cut - machineCut + machineCut * 0.3;
    if (gear) { equipment.push(ownedLine(gear, gearHours, 'Cutting')); eq.push(gear.name); }
    // no owned gear: rent it for climbing jobs, and for the small trees a machine job still climbs
    else if (gearHours > 0.5) { equipment.push(rentalLine(pb, 'climb', 'climbing_gear', gearHours, 'Cutting')); eq.push('Climbing gear'); }
    addTask({ id: main.id, label: `${removalCount ? 'Tree removal' : 'Tree work'}: ${label}`, qty: r2(cutHours), unit: 'reference-tree hours', workers: crewSize, hours: cut, equipment: eq, factor: r2(cut / Math.max(0.01, cutHours)) });
  }

  // processing: chipping brush and loading wood can run side by side with 3+ people
  let chipT = 0;
  let logT = 0;
  let maxLoaders = 1;
  let extraLoaders = 0;
  const chipper = of('chipper')[0];
  if (chipping) {
    const rc = R('brush_chipping');
    const rh = R('brush_hand');
    const chipTime = (brush / rc.rate) * taskFactor(rc, groups, skillMult) * crewSlow;
    const handTime = (brush / rh.rate) * taskFactor(rh, groups, skillMult) * crewSlow;
    // the chipper is only worth it when it is faster than hand work (it always is with normal rates)
    const chipperSlower = chipper && can('chipper') && chipTime > handTime;
    if (chipper && can('chipper') && !chipperSlower) {
      const r = rc;
      chipT = chipTime;
      equipment.push(ownedLine(chipper, chipT, 'Chipping'));
      addTask({ id: 'brush_chipping', label: 'Processing / chipping brush', qty: r2(brush), unit: 'yd³ brush', rate: r.rate, workers: Math.min(2, crewSize), hours: chipT, equipment: [chipper.name] });
    } else {
      const r = rh;
      chipT = handTime;
      notes.push(chipperSlower ? 'Brush handled by hand: your chipping rate is slower than hand work. Check it in Production Rates.' : chipper ? 'Brush handled without the chipper: no one on this crew can run it.' : 'No chipper available in My Resources: brush is hauled unchipped (slower, more loads).');
      addTask({ id: 'brush_hand', label: 'Brush handling (no chipper)', qty: r2(brush), unit: 'yd³ brush', rate: r.rate, workers: Math.min(2, crewSize), hours: chipT, equipment: [] });
    }
  }
  if (loadWood) {
    const usable = tree.access === 'tight' ? [] : loaders.filter((u) => crew.some((w) => canRun(w, u)));
    if (usable.length) {
      const r = R('log_loading');
      // aim to finish loading in about 4 hours; each extra machine needs its own operator and a
      // trailer trip to bring it, so calcTree only brings one when it costs less overall
      const recL = Math.min(3, Math.max(1, Math.ceil(wood / (r.rate * 4))));
      const ops = crew.filter((w) => w.can?.loader || w.can?.heavy).length;
      maxLoaders = Math.max(1, Math.min(3, ops, usable.length));
      const used = usable.slice(0, Math.max(1, Math.min(opts.loaderCap || 1, maxLoaders)));
      extraLoaders = used.length - 1;
      logT = (wood / (r.rate * used.length)) * taskFactor(r, groups, skillMult);
      used.forEach((u) => equipment.push(ownedLine(u, logT, 'Log loading')));
      if (maxLoaders < recL && used.length === maxLoaders) notes.push(`Log loading takes ${hrs(logT)} because only ${plural(used.length, 'loader is', 'loaders are')} available${usable.length > used.length ? ' with an operator' : ''} (${recL} recommended for ${Math.round(wood)} yd³ of wood).`);
      addTask({ id: 'log_loading', label: 'Loading logs', qty: r2(wood), unit: 'yd³ wood', rate: r.rate * used.length, workers: used.length, hours: logT, equipment: used.map((u) => u.name) });
    } else {
      const r = R('log_hand');
      logT = (wood / r.rate) * taskFactor(r, groups, skillMult) * crewSlow;
      notes.push(tree.access === 'tight' ? 'Logs carried out by hand: no equipment access.' : loaders.length ? 'Logs loaded by hand: no one on this crew can run the loader.' : 'No loader or skid steer available: logs loaded by hand.');
      addTask({ id: 'log_hand', label: 'Loading logs by hand', qty: r2(wood), unit: 'yd³ wood', rate: r.rate, workers: Math.min(3, crewSize), hours: logT, equipment: [] });
    }
  }
  const parallel = crewSize >= 3 && chipT && logT && tasks.some((t) => t.id === 'log_loading');
  const processing = parallel ? Math.max(chipT, logT) : chipT + logT;
  if (parallel) tasks.forEach((t) => { if (t.id === 'brush_chipping' || t.id === 'log_loading') t.parallel = true; });

  // firewood
  let fireT = 0;
  if (tree.firewood && wood > 0) {
    const r = R('firewood');
    fireT = (wood / r.rate) * taskFactor(r, groups, skillMult) * crewSlow;
    addTask({ id: 'firewood', label: 'Cutting firewood lengths', qty: r2(wood), unit: 'yd³ wood', rate: r.rate, workers: Math.min(2, crewSize), hours: fireT, equipment: [] });
  }

  // disposal loads + hauling
  const D = pb.disposal;
  const loadYd = Math.max(1, +D.loadYards || 12);
  const disposal = [];
  let loads = 0;
  if (hauling) {
    const chipped = tasks.some((t) => t.id === 'brush_chipping');
    const brushYd = brush > 0 ? brush * (chipped ? 0.3 : 0.6) : 0;
    const woodYd = debris === 'haul' && wood > 0 ? wood : 0;
    if (brushYd && woodYd && brushYd + woodYd <= loadYd) {
      // a small job: chips and logs go out in one truck, charged at the log rate
      disposal.push({ label: `${chipped ? 'Chips' : 'Brush'} & log disposal (one load)`, qty: 1, unit: 'load', rate: D.logs, cost: D.logs });
      loads = 1;
    } else {
      const brushLoads = brushYd ? Math.ceil(brushYd / loadYd) : 0;
      const logLoads = woodYd ? Math.ceil(woodYd / loadYd) : 0;
      if (brushLoads) disposal.push({ label: chipped ? 'Chips / brush disposal' : 'Brush disposal', qty: brushLoads, unit: 'load', rate: D.brush, cost: brushLoads * D.brush });
      if (logLoads) disposal.push({ label: 'Log disposal', qty: logLoads, unit: 'load', rate: D.logs, cost: logLoads * D.logs });
      loads = brushLoads + logLoads;
    }
  }
  // stump grinding (one operator; overlaps cleanup when there are 2+ people)
  let grindT = 0;
  if (stumps.length) {
    const r = R('stump_grinding');
    grindT = stumps.reduce((s, d) => s + r.baseTime + d / r.rate, 0) * taskFactor(r, groups, skillMult);
    const g = of('stump_grinder')[0];
    if (g) equipment.push(ownedLine(g, grindT, 'Stump grinding'));
    else { equipment.push(rentalLine(pb, 'grinder', 'stump_grinder', grindT, 'Stump grinding')); notes.push('Stump grinder priced as a rental: none in My Resources.'); }
    addTask({ id: 'stump_grinding', label: `Stump grinding (${plural(stumps.length, 'stump')}, ${stumps.map((d) => d + '"').join(', ')})`, qty: stumps.reduce((a, b) => a + b, 0), unit: 'in of diameter', rate: r.rate, workers: 1, hours: grindT, equipment: [g ? g.name : 'Stump grinder (rental)'] });
  }

  // cleanup
  let cleanT = 0;
  if (cuttingWork || stumps.length) {
    const r = R('tree_cleanup');
    const handled = debris === 'leave' ? 0 : brush + wood;
    cleanT = (r.baseTime + handled / r.rate) * taskFactor(r, groups, skillMult) * crewSlow;
    addTask({ id: 'tree_cleanup', label: 'Final cleanup', qty: r2(handled), unit: 'yd³ debris', rate: r.rate, workers: crewSize, hours: cleanT, equipment: [] });
  }

  let haulT = 0;
  let haulTrucks = []; // owned trucks hauling, with their drivers
  if (loads) {
    const r = R('hauling');
    // enough trucks to finish hauling while the crew is still processing and cleaning up
    const window = Math.max(0.5, processing + cleanT);
    // trips during the job = loads − trucks (each truck's last load leaves with the crew)
    const recTrucks = Math.min(3, Math.max(1, Math.ceil(loads / (1 + r.rate * window))));
    const drivers = crew.filter((w) => w.can?.truck).length;
    const canSend = Math.max(0, Math.min(recTrucks, drivers || 0, of('dump_truck').length));
    // another truck only when it costs less than the crew waiting for the last trips
    const hf = taskFactor(r, groups, skillMult);
    const lastRunT = 0.5 / Math.max(0.1, r.rate);
    const crewRate = crew.reduce((t, w) => t + laborRate(w, pb, overtime), 0);
    const driverRate = crewRate / Math.max(1, crew.length);
    let nT = Math.min(1, canSend);
    let bestCost = Infinity;
    for (let n = 1; n <= canSend; n++) {
      const h = (loads / (n * r.rate)) * hf;
      const wait = Math.max(0, h * (Math.max(0, loads - n) / loads) - window);
      const extra = of('dump_truck').slice(1, n).reduce((t, u) => t + (h + lastRunT) * (u.hourly + u.maintenance + u.fuel), 0);
      const cost = wait * crewRate + extra + n * lastRunT * driverRate;
      if (cost < bestCost - 0.01) { bestCost = cost; nT = n; }
    }
    const trucks = of('dump_truck').slice(0, nT);
    const eq = [];
    if (trucks.length) {
      haulT = (loads / (trucks.length * r.rate)) * hf;
      if (canSend < recTrucks && trucks.length === canSend) {
        const why = of('dump_truck').length < recTrucks ? `only ${plural(of('dump_truck').length, 'dump truck is', 'dump trucks are')} available` : `only ${plural(drivers, 'person on the crew can', 'people on the crew can')} drive a truck`;
        notes.push(`Hauling takes longer because ${why} (${recTrucks} recommended for ${plural(loads, 'load')}).`);
      }
      haulTrucks = trucks;
      const lastRun = 0.5 / Math.max(0.1, r.rate);
      trucks.forEach((u, i) => { eq.push(u.name); if (i > 0) equipment.push(ownedLine(u, haulT + lastRun, 'Hauling')); });
    } else {
      haulT = loads / r.rate;
      equipment.push(rentalLine(pb, 'dump', 'dump_truck', haulT, 'Hauling'));
      eq.push('Dump truck (rental)');
      notes.push(of('dump_truck').length ? 'No one on this crew can drive the dump truck: priced as a rental with driver.' : 'No dump truck available in My Resources: priced as a rental.');
    }
    addTask({ id: 'hauling', label: 'Hauling to dump site', qty: loads, unit: 'load', rate: r.rate, workers: Math.max(1, trucks.length), hours: haulT, equipment: eq, overlaps: true });
  }

  // elapsed time on site
  const grindSeq = crewSize >= 2 && cuttingWork ? Math.max(0, grindT - cleanT) : grindT;
  const onSiteNoHaul = setup + cut + processing + fireT + cleanT + grindSeq;
  const nTrucks = Math.max(1, tasks.find((t) => t.id === 'hauling')?.workers || 1);
  const tripsOnSite = Math.max(0, loads - nTrucks);
  const haulOnSite = loads ? haulT * (tripsOnSite / loads) : 0;
  const haulExtra = Math.max(0, haulOnSite - (processing + cleanT));
  // the final dump run: a detour on the way home for each loaded truck and its driver
  const dumpRun = loads ? (0.5 / Math.max(0.1, R('hauling').rate)) : 0;
  if (haulExtra > 0.05) notes.push(`Crew waits about ${hrs(haulExtra)} for the last loads to be hauled.`);
  const onSite = onSiteNoHaul + haulExtra;
  const days = Math.max(1, Math.ceil(onSite / 8));
  const travelT = travelTime(job, pb, groups) * days;
  addTask({ id: 'travel', label: `Travel / mobilization${days > 1 ? ` (${days} days)` : ''}`, qty: +job.miles || 0, unit: 'miles each way', workers: crewSize, hours: travelT, equipment: [] });

  // the first dump truck tows the chipper and stays with the crew all day
  const lead = of('dump_truck')[0];
  if (lead && (chipping || loads) && crew.some((w) => w.can?.truck)) equipment.push(ownedLine(lead, onSite + (haulTrucks.includes(lead) ? dumpRun : 0), 'Crew truck / chipper tow'));

  // --- costs ---
  const laborHours = crewSize * (onSite + travelT);
  const rates = crew.map((w) => laborRate(w, pb, overtime));
  const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
  // drivers' time for the final dump run on the way home
  let laborCost = rates.reduce((s, r) => s + r * onSite, 0) + avgRate * dumpRun * haulTrucks.length;
  if (laborCost < pb.labor.minCharge) laborCost = pb.labor.minCharge;
  const equipmentCost = equipment.reduce((s, e) => s + e.cost, 0);
  const fuelCost = equipment.reduce((s, e) => s + e.fuel, 0);
  const disposalCost = disposal.reduce((s, d) => s + d.cost, 0);
  const vehicle = Math.max(0, (+job.miles || 0) - pb.travel.freeMiles) * pb.travel.perMile;
  const travelLabor = rates.reduce((s, r) => s + r * travelT, 0);
  const travel = Math.max(pb.travel.minCharge || 0, vehicle + travelLabor);
  const materials = [];
  if (extraLoaders) materials.push({ label: `Bring ${plural(extraLoaders, 'extra loader')} (trailer trip)`, qty: extraLoaders, unit: 'trip', cost: r2(extraLoaders * travelTime(job, pb, groups) * (avgRate + (+pb.equipmentDefaults.hourly || 0))) });
  if (cableKits) materials.push({ label: 'Cabling & bracing hardware', qty: cableKits, unit: 'kit', cost: cableKits * pb.materials.cablingKit });
  if (tree.restore && stumps.length) materials.push({ label: 'Topsoil, seed & straw', qty: stumps.length, unit: 'stump', cost: stumps.length * pb.materials.restoreKit });
  if (job.permit) materials.push({ label: 'Permit / municipal fee', qty: 1, unit: 'ea', cost: pb.materials.permitFee });
  if (pb.equipmentDefaults.mobilization && (method !== 'climb' || stumps.length)) materials.push({ label: 'Mobilization', qty: 1, unit: 'job', cost: pb.equipmentDefaults.mobilization });
  const materialCost = materials.reduce((s, m) => s + m.cost, 0);

  const pr = price('tree', pb, { labor: laborCost, equipment: equipmentCost, fuel: fuelCost, disposal: disposalCost, travel, materials: materialCost }, job, opts);

  const safety = Object.keys(HAZARDS).filter((k) => hz[k]).map((k) => HAZARDS[k].safety);
  for (const [k, txt] of Object.entries(EXTRA_SAFETY)) if (job.conditions?.[k]) safety.push(txt);
  if (job.emergency || job.storm) safety.unshift('Emergency/storm response: site hazard assessment before any cuts.');

  for (const who of PAY_WARN) notes.push(`${who}'s pay looks wrong (over $${MAX_PAY}/hr), so $${MAX_PAY}/hr was used. Check it in My Resources.`);
  for (const name of new Set(units.filter((u) => u.costCapped).map((u) => u.name.replace(/ #\d+$/, '')))) notes.push(`${name}: a cost per hour looks wrong (over $1,500), so $1,500 was used. Check it in My Resources.`);
  if (onSite > 500) notes.push('This is a very large job (over 500 hours on site). Check the sizes and quantities.');
  for (const task of RATE_WARN) notes.push(`The production rate for "${task}" looks wrong, so a safe limit was used. Check it in Production Rates.`);
  const required = summarizeNeeds({ crew: { rec, used: crewSize, have: assumed ? 0 : activeWorkers(company).length }, equipment, units });
  return {
    division: 'tree',
    autoRental: methodRental && !explicit,
    maxLoaders,
    method,
    methodLabel: METHOD_LABELS[method] + (methodRental ? ' (rental)' : ''),
    reasons: [...reasons, ...missing.map((c) => `No active worker can operate: ${c}.`)],
    notes,
    conditions: applied,
    crew: crewSize,
    crewMembers: crew.map((w) => ({ name: w.name, skill: w.skill })),
    recCrew: rec,
    tasks,
    required,
    siteHours: r2(onSite),
    travelHours: r2(travelT),
    elapsedHours: r2(onSite + travelT),
    grindHours: r2(grindT),
    personHours: r2(laborHours),
    days,
    labor: { crew: crewSize, siteHours: r2(onSite), personHours: r2(laborHours), wage: r2(avgRate), cost: r2(laborCost), overtime },
    equipment,
    materials: [...disposal, ...materials],
    volumeYd: r2(brush + wood),
    brushYd: r2(brush),
    woodYd: r2(wood),
    loads,
    stumpCount: stumps.length,
    stumpSizes: stumps,
    treeLines,
    safety,
    laborCost: r2(laborCost),
    equipmentCost: r2(equipmentCost),
    fuelCost: r2(fuelCost),
    disposalCost: r2(disposalCost),
    materialCost: r2(materialCost + disposalCost),
    otherCost: r2(materialCost),
    travel: r2(travel),
    ...pr,
    emergency: !!job.emergency,
    profitPerCrewHour: r2(pr.profit / Math.max(0.1, onSite + travelT)),
    config: tree,
  };
}

// ---------- snow jobs (per visit) ----------

const PLOW_CARRIERS = ['pickup', 'dump_truck', 'utv', 'atv'];

// Auto equipment = the lowest-cost way this company can do the visit. Each way's price grows with
// the area, depth and walks, so the cheapest of them does too: a bigger lot is never cheaper.
const SNOW_LABELS = { plow: 'Plow truck', skid: 'Skid steer with pusher', loader: 'Loader with pusher', blower: 'Snow blower', shovel: 'Shovels' };
export function calcSnow(job, pb = DEFAULT_PRICEBOOK, opts = {}) {
  const s = cleanSnow({ ...job.snow, ...(opts.override || {}) });
  // hauling: try 1–4 trucks (as many as help); the cheapest plan wins
  const truckCaps = s.haul && +s.areaSqft > 0 ? [1, 2, 3, 4] : [undefined];
  // hand work: also try sending 1–2 extra helpers, kept only when the visit costs less with them
  const helperCounts = +s.walkLf > 0 || +s.roofSqft > 0 || ['auto', 'shovel'].includes(s.method) ? [0, 1, 2] : [0];
  const pushers = (c) => fleet(companyOr(c)).filter((u) => (PLOW_CARRIERS.includes(u.type) && u.attachments.includes('plow')) || ['skid_steer', 'compact_loader', 'loader'].includes(u.type)).length;
  const cheapest = (o) => {
    const m = cleanSnow({ ...job.snow, ...(o.override || {}) }).method;
    const extras = ['plow', 'skid', 'loader'].includes(m) && +s.areaSqft > 0 && pushers(o.company) > 1 ? [false, true] : [false];
    let best = null;
    for (const truckCap of truckCaps) {
      for (const helpers of helperCounts) {
        for (const extraUnit of extras) {
          const e = planSnow(job, pb, { ...o, truckCap, helpers, extraUnit });
          if (!best || e.price < best.price || (e.price === best.price && e.elapsedHours < best.elapsedHours)) best = e;
        }
      }
    }
    return best;
  };
  if (s.method !== 'auto' || !(+s.areaSqft > 0)) return cheapest({ ...opts, autoPick: s.method === 'auto' });
  const company = companyOr(opts.company);
  const units = fleet(company);
  const has = (pred) => units.some(pred);
  const owned = [
    has((u) => PLOW_CARRIERS.includes(u.type) && u.attachments.includes('plow')) && 'plow',
    has((u) => u.type === 'skid_steer' || u.type === 'compact_loader') && 'skid',
    has((u) => u.type === 'loader') && 'loader',
    has((u) => u.type === 'walk_blower' || u.type === 'snow_blower') && 'blower',
  ].filter(Boolean);
  // nothing that pushes snow: shovels, or a rented machine when that is cheaper
  const cands = owned.some((m) => m !== 'blower') ? [...owned, 'shovel'] : [...owned, 'shovel', 'plow', 'skid'];
  let best = null;
  for (const m of [...new Set(cands)]) {
    const e = cheapest({ ...opts, override: { ...(opts.override || {}), method: m }, autoPick: true });
    if (!best || e.price < best.price || (e.price === best.price && e.elapsedHours < best.elapsedHours)) best = e;
  }
  best.config = { ...best.config, method: 'auto' };
  return best;
}

function planSnow(job, pb, opts) {
  const company = companyOr(opts.company);
  const s = cleanSnow({ ...job.snow, ...(opts.override || {}) });
  job = { ...job, miles: clampNum(job.miles, 'miles', 0) };
  const M = company.multipliers;
  const { groups, applied } = conditionGroups({ ...job, snow: s }, 'snow', company);
  const units = fleet(company);
  let workers = activeWorkers(company);
  RATE_WARN.clear();
  PAY_WARN.clear();
  const notes = [];
  const reasons = [];
  const R = (id) => rateOf(company, id);
  const overtime = !!(job.emergency || job.storm || job.weekend || job.holiday);
  const area = Math.max(0, +s.areaSqft || 0);
  const acres = area / 43560;
  const walk = Math.max(0, +s.walkLf || 0);
  const roof = Math.max(0, +s.roofSqft || 0);
  const depth = Math.max(1, +s.depthIn || 2);
  const depthF = 1 + Math.max(0, depth - 2) * (M.snowDepth.perInch?.value ?? 0.167);

  let assumed = false;
  if (!workers.length) {
    assumed = true;
    workers = Array.from({ length: Math.max(1, pb.crew.snow) }, (_, i) => ({ name: `Worker ${i + 1}`, skill: 'experienced', rate: pb.labor.wage, otRate: pb.labor.overtime, can: { truck: true, loader: true, heavy: true } }));
    notes.push(`No active workers in My Resources: assuming ${plural(workers.length, 'worker')} at the standard labor cost.`);
  }
  const skillOf = (ws) => (ws.length ? ws.reduce((t, w) => t + (M.skill[w.skill]?.value ?? 1), 0) / ws.length : 1);

  // pushing units the company has
  const plowTrucks = units.filter((u) => PLOW_CARRIERS.includes(u.type) && u.attachments.includes('plow'));
  const skids = units.filter((u) => (u.type === 'skid_steer' || u.type === 'compact_loader') && (u.attachments.includes('snow_pusher') || u.attachments.includes('snow_bucket') || !u.attachments.length));
  const wheelLoaders = units.filter((u) => u.type === 'loader');
  const blowers = units.filter((u) => u.type === 'walk_blower' || u.type === 'snow_blower');
  const kinds = { plow: { units: plowTrucks, rate: 'plow_truck', label: 'Plow truck' }, skid: { units: skids, rate: 'plow_skid', label: 'Skid steer with pusher' }, loader: { units: wheelLoaders, rate: 'plow_loader', label: 'Loader with pusher' } };

  let method = s.method;
  if (area <= 0) method = 'shovel'; // nothing to plow: walks, steps or a roof only
  if (opts.autoPick) reasons.push(`${SNOW_LABELS[method] || method}: the lowest-cost way to clear this with your equipment.`);
  else reasons.push(`${SNOW_LABELS[method] || method} selected by estimator.`);

  const free = [...workers].sort((a, b) => (SKILL_ORDER[a.skill] ?? 2) - (SKILL_ORDER[b.skill] ?? 2));
  const take = (pred) => { const i = free.findIndex(pred); return i >= 0 ? free.splice(i, 1)[0] : null; };
  // hand work (shoveling, walks, roof) goes to the lowest-cost people first; machines get the most skilled
  const handCost = (w) => laborRate(w, pb, overtime) * (M.skill[w.skill]?.value ?? 1);
  const takeHand = () => {
    if (!free.length) return null;
    let i = 0;
    free.forEach((w, k) => { if (handCost(w) < handCost(free[i])) i = k; });
    return free.splice(i, 1)[0];
  };
  const crew = [];
  const tasks = [];
  const equipment = [];
  const addTask = (t) => { tasks.push({ ...t, hours: r2(t.hours) }); return t.hours; };

  const setup = R('snow_setup').baseTime;
  addTask({ id: 'snow_setup', label: R('snow_setup').task, qty: 1, unit: 'visit', workers: 1, hours: setup, equipment: [] });

  // plowing / pushing
  let plowT = 0;
  const plowOps = [];
  if (area > 0 && (method === 'plow' || method === 'skid' || method === 'loader')) {
    const recUnits = Math.max(1, Math.ceil(acres / 1.5)); // a home driveway is always one unit
    // at least one unit per 1.5 acres (so a lot is clear in time); one more when that costs less
    const wantUnits = recUnits + (opts.extraUnit ? 1 : 0);
    // fastest units first: chosen kind, then other kinds when more than one unit goes
    // an estimator's pick they don't own stays a rental at every size (no silent switch)
    const order = [method, ...(wantUnits > 1 && kinds[method].units.length ? Object.keys(kinds).filter((k) => k !== method) : [])];
    const used = [];
    for (const k of order) {
      for (const u of kinds[k].units) {
        if (used.length >= wantUnits) break;
        const w = take((x) => canRun(x, u));
        if (!w) continue;
        used.push({ u, k, w });
      }
    }
    if (!used.length) {
      // nothing usable: one rental unit, never an imaginary fleet
      const w = take(() => true) || workers[0];
      const rk = method === 'plow' ? 'plow' : 'skid';
      const r = R(kinds[method]?.rate || 'plow_skid');
      plowT = (r.baseTime + (acres / r.rate) * depthF) * taskFactor(r, groups, skillOf([w]));
      equipment.push(rentalLine(pb, rk, method === 'plow' ? 'pickup' : 'skid_steer', plowT, 'Plowing'));
      plowOps.push(w);
      notes.push(kinds[method]?.units.length ? `No one available can operate the ${kinds[method].label.toLowerCase()}: priced as a rental.` : `No ${kinds[method]?.label.toLowerCase() || 'plow'} available in My Resources: priced as a rental.`);
      addTask({ id: kinds[method]?.rate || 'plow_skid', label: `Plowing ${(+area).toLocaleString()} sq ft`, qty: r2(acres), unit: 'acre', rate: r.rate, workers: 1, hours: plowT, equipment: [`${pb.equipment[rk]?.label || 'Plow'} (rental)`] });
    } else {
      const totalRate = used.reduce((t, x) => t + R(kinds[x.k].rate).rate, 0);
      const f = taskFactor(R(kinds[used[0].k].rate), groups, skillOf(used.map((x) => x.w)));
      plowT = (R(kinds[used[0].k].rate).baseTime + (acres / totalRate) * depthF) * f;
      used.forEach((x) => { equipment.push(ownedLine(x.u, plowT, 'Plowing')); plowOps.push(x.w); });
      if (opts.extraUnit && used.length > recUnits) notes.push('One more plow unit than usual: the visit finishes sooner and costs less overall.');
      if (used.length < recUnits) {
        const have = Object.values(kinds).reduce((t, k) => t + k.units.length, 0);
        notes.push(have < recUnits
          ? `Estimated duration increased because only ${plural(have, 'plow unit is', 'plow units are')} available (${recUnits} recommended for ${r2(acres)} acres).`
          : `Estimated duration increased because only ${plural(used.length, 'operator is', 'operators are')} available for the ${plural(have, 'plow unit')}.`);
      }
      method = used[0].k;
      addTask({ id: kinds[method].rate, label: `Plowing ${(+area).toLocaleString()} sq ft${depth > 2 ? ` at ${depth}"` : ''}`, qty: r2(acres), unit: 'acre', rate: r2(totalRate), workers: used.length, hours: plowT, equipment: used.map((x) => x.u.name) });
    }
  } else if (area > 0) {
    const b = method === 'blower' ? blowers[0] : null;
    const r = R(b ? 'snow_blower' : 'shoveling');
    const w = takeHand() || workers[0];
    plowT = (r.baseTime + (area / r.rate) * depthF) * taskFactor(r, groups, skillOf([w]));
    if (b) equipment.push(ownedLine(b, plowT, 'Snow blowing'));
    else if (method === 'blower') { equipment.push(rentalLine(pb, 'blower', 'walk_blower', plowT, 'Snow blowing')); notes.push('No snow blower in My Resources: priced as a rental.'); }
    plowOps.push(w);
    addTask({ id: r.id, label: `${b || method === 'blower' ? 'Snow blowing' : 'Shoveling'} ${(+area).toLocaleString()} sq ft`, qty: area, unit: 'sq ft', rate: r.rate, workers: 1, hours: plowT, equipment: b ? [b.name] : [] });
  }
  crew.push(...plowOps);

  // Hand work (walks, roof, shoveling) is shared: whoever finishes their own part, a plow operator
  // included, helps with what's left, so nobody is paid to stand around. machineT: how long each
  // machine operator is busy; hand: person-hours of hand work; handCrew: people on hand work.
  // hand work is counted at standard skill; each person then works at their own speed
  const shovelArea = method === 'shovel' && area > 0;
  const machineT = shovelArea ? [] : plowOps.map((w) => [w, plowT]);
  let hand = shovelArea ? plowT / skillOf(plowOps) : 0;

  // sidewalks: a sidewalk crew, or the plow operator afterwards
  let walkT = 0;
  let walkSeq = false;
  if (walk > 0) {
    const machine = units.find((u) => u.type === 'sidewalk_machine' || ((u.type === 'utv' || u.type === 'atv') && u.attachments.includes('plow')));
    const recW = Math.max(1, Math.ceil(walk / 600));
    // short walks at a home: the operator does them after plowing, no second person needed
    const solo = s.property !== 'commercial' && walk <= 300 && area > 0;
    let ws = [];
    let mw = machine && !solo ? take((x) => canRun(x, machine)) : null;
    if (!mw && !solo) for (let i = 0; i < recW; i++) { const w = takeHand(); if (w) ws.push(w); }
    if (!mw && !ws.length) { walkSeq = true; ws = [plowOps[0] || workers[0]]; if (!solo) notes.push('No extra worker for sidewalks: the operator clears them after plowing, so the visit takes longer.'); }
    else if (!mw && ws.length < recW) notes.push(`Sidewalks take longer because only ${plural(ws.length, 'worker is', 'workers are')} free for them (${recW} recommended).`);
    if (mw) {
      const r = R('sidewalk_machine');
      walkT = (walk / r.rate) * depthF * taskFactor(r, groups, skillOf([mw]));
      equipment.push(ownedLine(machine, walkT, 'Sidewalks'));
      crew.push(mw);
      machineT.push([mw, walkT]);
      addTask({ id: 'sidewalk_machine', label: `Sidewalks ${walk} ft`, qty: walk, unit: 'linear ft', rate: r.rate, workers: 1, hours: walkT, equipment: [machine.name] });
    } else {
      const r = R('sidewalks');
      const work = (walk / r.rate) * depthF * taskFactor(r, groups, skillOf(ws));
      hand += work / skillOf(ws);
      walkT = work / ws.length;
      // the blowers do all the walk work between them (a walker without one swaps in)
      const bl = blowers.filter((u) => u.type === 'walk_blower').slice(0, ws.length);
      bl.forEach((u) => equipment.push(ownedLine(u, work / bl.length, 'Sidewalks')));
      if (!walkSeq) crew.push(...ws);
      addTask({ id: 'sidewalks', label: `Sidewalks ${walk} ft${walkSeq && plowT ? ' (after plowing)' : ''}`, qty: walk, unit: 'linear ft', rate: r.rate, workers: ws.length, hours: walkT, equipment: bl.map((u) => u.name) });
    }
  }

  // roof
  let roofT = 0;
  if (roof > 0) {
    const r = R('roof_snow');
    const ws = [];
    for (let i = 0; i < r.recCrew; i++) { const w = takeHand(); if (w) ws.push(w); }
    if (ws.length < r.minCrew) notes.push(`Roof work needs ${r.minCrew} people for safety; only ${ws.length} free.`);
    const n = Math.max(1, ws.length);
    const work = (roof / r.rate) * depthF * taskFactor(r, groups, skillOf(ws));
    hand += work / skillOf(ws);
    roofT = work / n;
    crew.push(...ws);
    addTask({ id: 'roof_snow', label: `Roof snow ${roof.toLocaleString()} sq ft`, qty: roof, unit: 'sq ft', rate: r.rate, workers: n, hours: roofT, equipment: [] });
  }

  // salt (after plowing)
  let saltT = 0;
  let saltLbs = 0;
  if (s.salt) {
    const saltAcres = (area + walk * 4) / 43560;
    const spreaders = units.filter((u) => (PLOW_CARRIERS.includes(u.type) && u.attachments.includes('salt_spreader')) || u.type === 'salt_spreader');
    const r = R(spreaders.length ? 'salting' : 'salting_hand');
    saltT = r.baseTime + (saltAcres / r.rate) * taskFactor(r, groups, 1);
    if (spreaders.length) equipment.push(ownedLine(spreaders[0], saltT, 'Salting'));
    else if (saltAcres > 0.25) notes.push('No salt spreader in My Resources: salting by hand takes much longer.');
    saltLbs = Math.ceil(((area + walk * 4) / 1000) * pb.materials.saltLbPer1000);
    addTask({ id: r.id, label: `Salting ${(area + walk * 4).toLocaleString()} sq ft`, qty: r2(saltAcres), unit: 'acre', rate: r.rate, workers: 1, hours: saltT, equipment: spreaders.length ? [spreaders[0].name] : ['Hand spreader'] });
  }

  // hauling snow off site
  let haulT = 0;
  const disposal = [];
  if (s.haul && area > 0) {
    const yd = ((area * depth) / 12 / 27) * 0.5; // plowed snow, settled
    const loads = Math.ceil(yd / Math.max(1, +pb.disposal.loadYards || 12));
    const tr = R('snow_hauling');
    const lr = R('snow_loading');
    const trucks = units.filter((u) => u.type === 'dump_truck');
    const loaderUnits = units.filter((u) => ['loader', 'skid_steer', 'compact_loader'].includes(u.type));
    const recTrucks = Math.max(1, Math.min(4, Math.ceil(loads / 4)));
    const recLoaders = Math.max(1, Math.ceil((recTrucks * tr.rate) / lr.rate));
    // operators: plow operators can switch to loading/hauling after plowing
    // hauling comes after the shared work, so anyone already on the visit can drive or load
    // (people already here first, then the lowest-cost people who can run the machine)
    const pool = [...new Set([...crew, ...[...free].sort((a, b) => handCost(a) - handCost(b))])];
    const truckLimit = opts.truckCap ?? recTrucks;
    const usedL = [];
    for (const u of loaderUnits) { if (usedL.length >= recLoaders) break; const i = pool.findIndex((w) => canRun(w, u)); if (i >= 0) usedL.push({ u, w: pool.splice(i, 1)[0] }); }
    const loadersFound = usedL.length;
    const usedT = [];
    for (const u of trucks) { if (usedT.length >= truckLimit) break; const i = pool.findIndex((w) => canRun(w, u)); if (i >= 0) usedT.push({ u, w: pool.splice(i, 1)[0] }); }
    // a missing truck or loader is one rental unit; no idle machines: only as many trucks as the
    // loaders can fill, and loaders as the trucks can take
    const nL = Math.max(1, usedL.length);
    const nTk = Math.max(1, usedT.length);
    if (usedT.length > Math.ceil((nL * lr.rate) / tr.rate)) usedT.length = Math.ceil((nL * lr.rate) / tr.rate);
    if (usedL.length > Math.ceil((nTk * tr.rate) / lr.rate)) usedL.length = Math.ceil((nTk * tr.rate) / lr.rate);
    const truckCap = Math.max(1, usedT.length) * tr.rate;
    const loaderCap = Math.max(1, usedL.length) * lr.rate;
    haulT = loads / Math.min(truckCap, loaderCap);
    if (!usedT.length || !usedL.length) {
      notes.push(`Snow hauling needs ${!usedT.length ? 'a dump truck and driver' : ''}${!usedT.length && !usedL.length ? ' and ' : ''}${!usedL.length ? 'a loader and operator' : ''}: priced as rentals.`);
      if (!usedT.length) equipment.push(rentalLine(pb, 'dump', 'dump_truck', haulT, 'Snow hauling'));
      if (!usedL.length) equipment.push(rentalLine(pb, 'skid', 'skid_steer', haulT, 'Snow hauling'));
    }
    if (loadersFound && loadersFound < recLoaders && loaderCap <= truckCap) notes.push(`Estimated duration increased because only ${plural(usedL.length, 'loader is', 'loaders are')} available (${recLoaders} recommended).`);
    if (usedT.length && usedT.length < truckLimit && truckCap <= loaderCap) notes.push(`Estimated duration increased because only ${plural(usedT.length, 'dump truck is', 'dump trucks are')} available (${recTrucks} recommended for ${plural(loads, 'load')}).`);
    usedL.forEach((x) => { equipment.push(ownedLine(x.u, haulT, 'Snow loading')); if (!crew.includes(x.w)) crew.push(x.w); });
    usedT.forEach((x) => { equipment.push(ownedLine(x.u, haulT, 'Snow hauling')); if (!crew.includes(x.w)) crew.push(x.w); });
    disposal.push({ label: 'Snow hauling / dump fee', qty: loads, unit: 'load', rate: pb.disposal.snow, cost: loads * pb.disposal.snow });
    addTask({ id: 'snow_hauling', label: `Hauling snow off site (${plural(loads, 'load')})`, qty: loads, unit: 'load', rate: r2(Math.min(truckCap || tr.rate, loaderCap || lr.rate)), workers: usedT.length + usedL.length, hours: haulT, equipment: [...usedL, ...usedT].map((x) => x.u.name) });
  }

  if (!crew.length) crew.push(takeHand() || workers[0]);
  let helpersSent = 0;
  for (const w of crew) { const i = free.indexOf(w); if (i >= 0) free.splice(i, 1); } // drivers and loaders are on the crew now
  if (hand > 0) for (let i = 0; i < (opts.helpers || 0); i++) { const w = takeHand(); if (!w) break; crew.push(w); helpersSent++; }
  if (helpersSent) notes.push(`${plural(helpersSent, 'extra helper is', 'extra helpers are')} sent: the visit finishes sooner and costs less overall.`);
  const crewSize = crew.length;
  // the shared phase ends when the machines are done and the hand work is split among the whole
  // crew (truck drivers and loader operators too, until hauling starts)
  // speed of each person on hand work (an expert does more per hour than a beginner)
  const speed = (w) => 1 / (M.skill[w.skill]?.value ?? 1);
  const busy = machineT.reduce((t, [w, h]) => t + speed(w) * h, 0);
  const allSpeed = crew.reduce((t, w) => t + speed(w), 0) || 1;
  const shared = Math.max(0, ...machineT.map(([, h]) => h), (hand + busy) / allSpeed);
  const people = crewSize;
  if (people > 1 && hand > 0 && shared < Math.max(walkT, roofT) - 0.05) notes.push('Everyone helps with the walks and roof once their own part is done.');
  const onSite = setup + shared + saltT + haulT;
  const travelT = travelTime(job, pb, groups, true);
  addTask({ id: 'travel', label: 'Travel (route)', qty: +job.miles || 0, unit: 'miles', workers: crewSize, hours: travelT, equipment: [] });

  const rates = crew.map((w) => laborRate(w, pb, overtime));
  let laborCost = rates.reduce((t, r) => t + r * onSite, 0);
  if (laborCost < pb.labor.minCharge) laborCost = pb.labor.minCharge;
  const equipmentCost = equipment.reduce((t, e) => t + e.cost, 0);
  const fuelCost = equipment.reduce((t, e) => t + e.fuel, 0);
  const disposalCost = disposal.reduce((t, d) => t + d.cost, 0);
  const vehicle = (Math.max(0, (+job.miles || 0) - pb.travel.freeMiles) * pb.travel.perMile) / 2;
  const travel = Math.max(pb.travel.minCharge || 0, vehicle + rates.reduce((t, r) => t + r * travelT, 0));
  const materials = [];
  if (saltLbs) materials.push({ label: 'Rock salt / ice melt', qty: saltLbs, unit: 'lb', cost: r2(saltLbs * pb.materials.saltPerLb) });
  const materialCost = materials.reduce((t, m) => t + m.cost, 0);

  const pr = price('snow', pb, { labor: laborCost, equipment: equipmentCost, fuel: fuelCost, disposal: disposalCost, travel, materials: materialCost }, { ...job, snow: s }, opts, s.priority ? pb.snow.priorityPct : 0);

  const safety = [];
  if (roof > 0) safety.push('Roof work: fall protection required; keep drop zone below roped off.');
  if (s.salt) safety.push('Keep salt off landscaping and fresh concrete (<1 yr old).');
  if (s.property === 'commercial') safety.push('Commercial site: log every visit with time, depth and salt applied (slip-and-fall protection).');

  for (const who of PAY_WARN) notes.push(`${who}'s pay looks wrong (over $${MAX_PAY}/hr), so $${MAX_PAY}/hr was used. Check it in My Resources.`);
  for (const name of new Set(units.filter((u) => u.costCapped).map((u) => u.name.replace(/ #\d+$/, '')))) notes.push(`${name}: a cost per hour looks wrong (over $1,500), so $1,500 was used. Check it in My Resources.`);
  if (onSite > 500) notes.push('This is a very large job (over 500 hours on site). Check the sizes and quantities.');
  for (const task of RATE_WARN) notes.push(`The production rate for "${task}" looks wrong, so a safe limit was used. Check it in Production Rates.`);
  const required = summarizeNeeds({ crew: { rec: crewSize, used: crewSize, have: assumed ? 0 : activeWorkers(company).length }, equipment, units });
  return {
    division: 'snow',
    method,
    methodLabel: kinds[method]?.label || (method === 'blower' ? 'Walk-behind snow blower' : 'Shovel crew'),
    reasons,
    notes,
    conditions: applied,
    crew: crewSize,
    crewMembers: crew.map((w) => ({ name: w.name, skill: w.skill })),
    recCrew: crewSize,
    tasks,
    required,
    siteHours: r2(onSite),
    travelHours: r2(travelT),
    elapsedHours: r2(onSite + travelT),
    personHours: r2(crewSize * (onSite + travelT)),
    days: 1,
    labor: { crew: crewSize, siteHours: r2(onSite), personHours: r2(crewSize * (onSite + travelT)), wage: r2(rates.reduce((a, b) => a + b, 0) / rates.length), cost: r2(laborCost), overtime },
    equipment,
    materials: [...disposal, ...materials],
    saltLbs,
    safety,
    laborCost: r2(laborCost),
    equipmentCost: r2(equipmentCost),
    fuelCost: r2(fuelCost),
    disposalCost: r2(disposalCost),
    materialCost: r2(materialCost + disposalCost),
    otherCost: r2(materialCost),
    travel: r2(travel),
    ...pr,
    emergency: !!job.emergency,
    profitPerCrewHour: r2(pr.profit / Math.max(0.1, onSite + travelT)),
    config: s,
  };
}

// "Bucket truck: 1 needed, 1 owned" style summary for the breakdown and the AI card.
function summarizeNeeds({ crew, equipment, units }) {
  const out = [{ label: 'Workers', used: crew.used, recommended: crew.rec, available: crew.have }];
  const byType = {};
  for (const e of equipment) {
    const k = e.key;
    byType[k] ||= { label: EQUIPMENT_TYPES[k]?.label || e.label, names: new Set(), rental: false };
    byType[k].names.add(e.label);
    if (!e.owned) byType[k].rental = true;
  }
  for (const [k, v] of Object.entries(byType)) {
    out.push({ label: v.label, used: v.names.size, available: units.filter((u) => u.type === k).length, rental: v.rental });
  }
  return out;
}
