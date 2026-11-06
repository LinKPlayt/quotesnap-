// Auto pricing: works out costs from what the company owns and today's fuel prices.
// No DOM, no network: the app passes in the data (see refreshFuel in app.js). Pure, so it's tested.
//
// Two kinds of changes come out of suggestPricing():
//   auto: true   fuel-driven costs (machine fuel per hour, rental fuel, cost per mile). Safe to apply
//                every day by themselves, because they only follow the pump price.
//   auto: false  bigger decisions (overhead %, smallest job, machine ownership cost, default pay).
//                Shown as suggestions; nothing changes until the owner taps Apply.
// Anything the owner typed in by hand is never overwritten by the daily update.

import { EQUIPMENT_TYPES, fleet, activeWorkers } from './company.js';

// ---------- where to read the fuel price ----------

// EIA reports by region (PADD), some states and some cities. State -> [sub-region, region].
const PADD = {
  CT: '1A', ME: '1A', MA: '1A', NH: '1A', RI: '1A', VT: '1A',
  DE: '1B', DC: '1B', MD: '1B', NJ: '1B', NY: '1B', PA: '1B',
  FL: '1C', GA: '1C', NC: '1C', SC: '1C', VA: '1C', WV: '1C',
  IL: '2', IN: '2', IA: '2', KS: '2', KY: '2', MI: '2', MN: '2', MO: '2', NE: '2', ND: '2', SD: '2', OH: '2', OK: '2', TN: '2', WI: '2',
  AL: '3', AR: '3', LA: '3', MS: '3', NM: '3', TX: '3',
  CO: '4', ID: '4', MT: '4', UT: '4', WY: '4',
  AK: '5', AZ: '5', CA: '5', HI: '5', NV: '5', OR: '5', WA: '5',
};
const CITIES = {
  'city:boston': [42.36, -71.06], 'city:chicago': [41.88, -87.63], 'city:cleveland': [41.5, -81.69],
  'city:denver': [39.74, -104.99], 'city:houston': [29.76, -95.37], 'city:losangeles': [34.05, -118.24],
  'city:miami': [25.76, -80.19], 'city:nyc': [40.71, -74.01], 'city:sanfrancisco': [37.77, -122.42], 'city:seattle': [47.61, -122.33],
};
export const AREA_LABELS = {
  US: 'U.S. average', PADD1: 'East Coast', PADD1A: 'New England', PADD1B: 'Central Atlantic', PADD1C: 'Lower Atlantic',
  PADD2: 'Midwest', PADD3: 'Gulf Coast', PADD4: 'Rocky Mountain', PADD5: 'West Coast', PADD5XCA: 'West Coast (not CA)',
  CA: 'California', CO: 'Colorado', FL: 'Florida', MA: 'Massachusetts', MN: 'Minnesota', NY: 'New York', OH: 'Ohio', TX: 'Texas', WA: 'Washington',
  'city:boston': 'Boston area', 'city:chicago': 'Chicago area', 'city:cleveland': 'Cleveland area', 'city:denver': 'Denver area',
  'city:houston': 'Houston area', 'city:losangeles': 'Los Angeles area', 'city:miami': 'Miami area', 'city:nyc': 'New York City area',
  'city:sanfrancisco': 'San Francisco area', 'city:seattle': 'Seattle area',
};
const STATE_NAMES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };

// "12 Main St, Newton, MA 02458" / "..., Massachusetts, 02458, United States" -> "MA"
export function stateFrom(text = '') {
  const t = String(text);
  const abbr = t.match(/(?:^|,)\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:USA|United States(?: of America)?))?\s*$/);
  if (abbr && PADD[abbr[1]]) return abbr[1];
  const low = t.toLowerCase();
  // longest names first so "west virginia" wins over "virginia"
  for (const name of Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`(^|[,\\s])${name}([,\\s]|$)`).test(low)) return STATE_NAMES[name];
  }
  return null;
}

const miles = (a, b) => {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Most local first: a nearby city, the state, the sub-region, the region, then the U.S. average.
export function fuelAreas(loc = {}) {
  const out = [];
  if (Number.isFinite(+loc.lat) && Number.isFinite(+loc.lon) && loc.lat !== null) {
    const near = Object.entries(CITIES).map(([k, c]) => [k, miles([+loc.lat, +loc.lon], c)]).sort((a, b) => a[1] - b[1])[0];
    if (near && near[1] <= 40) out.push(near[0]);
  }
  const st = loc.state && PADD[loc.state] ? loc.state : null;
  if (st) {
    out.push(st);
    const p = PADD[st];
    if (p === '5' && st !== 'CA') out.push('PADD5XCA');
    out.push('PADD' + p);
    if (p.length > 1) out.push('PADD' + p[0]);
  }
  out.push('US');
  return [...new Set(out)];
}

// -> { gas: { price, area, label, manual }, diesel: {...}, week, source } or null when there is nothing to go on
export function pickFuel(data, loc, manual = {}) {
  const areas = fuelAreas(loc);
  const one = (product) => {
    if (+manual[product] > 0) return { price: +manual[product], area: 'manual', label: 'your price', manual: true };
    const table = data?.[product] || {};
    const area = areas.find((a) => +table[a] > 0);
    return area ? { price: +table[area], area, label: AREA_LABELS[area] || area, manual: false } : null;
  };
  const gas = one('gas');
  const diesel = one('diesel');
  if (!gas && !diesel) return null;
  return { gas: gas || diesel, diesel: diesel || gas, week: data?.week || null, source: data?.source || '', fetched: data?.fetched || null };
}

// ---------- what each machine burns ----------

// Typical fuel use while working, gallons per hour, and the fuel. Rough figures for average-size
// machines; every unit can be given its own number in My Resources.
export const FUEL_USE = {
  bucket_truck: [3, 'diesel'], chipper: [2, 'diesel'], chainsaw: [0.25, 'gas'], stump_grinder: [1.8, 'diesel'],
  skid_steer: [2.2, 'diesel'], mini_excavator: [1.5, 'diesel'], excavator: [4, 'diesel'], grapple: [3.5, 'diesel'],
  dump_truck: [3.5, 'diesel'], log_trailer: [0, 'diesel'], brush_trailer: [0, 'diesel'], wood_splitter: [0.5, 'gas'],
  pole_saw: [0.12, 'gas'], climbing_gear: [0, 'gas'], crane: [7, 'diesel'], spider_lift: [1, 'diesel'],
  pickup: [2.5, 'gas'], loader: [4.5, 'diesel'], compact_loader: [2.2, 'diesel'], snow_blower: [1.2, 'diesel'],
  walk_blower: [0.3, 'gas'], salt_spreader: [0.25, 'gas'], utv: [0.9, 'gas'], atv: [0.6, 'gas'],
  sidewalk_machine: [1.5, 'diesel'], other: [0, 'diesel'],
};
// Years of use and working hours per year, for the cost of owning a machine.
const OWNERSHIP = {
  default: [8, 600], chainsaw: [3, 400], pole_saw: [4, 200], climbing_gear: [4, 500], pickup: [8, 900], dump_truck: [10, 800],
  bucket_truck: [12, 800], crane: [15, 700], chipper: [10, 600], stump_grinder: [10, 400], loader: [12, 500],
  walk_blower: [6, 120], salt_spreader: [8, 150], snow_blower: [10, 200], sidewalk_machine: [10, 300], utv: [8, 300], atv: [8, 300],
};

export const fuelUse = (eq) => {
  const [gph, kind] = FUEL_USE[eq.type] || FUEL_USE.other;
  const own = eq.gph === '' || eq.gph === undefined || eq.gph === null ? NaN : +eq.gph;
  return { gph: Number.isFinite(own) && own >= 0 ? Math.min(own, 50) : gph, kind: eq.fuelType === 'gas' || eq.fuelType === 'diesel' ? eq.fuelType : kind };
};

export const DEFAULT_PROFILE = {
  daily: true,            // update fuel-based costs every day by themselves
  overheadYear: 0,        // yearly costs that aren't on any one job: insurance, shop, office, phones, software
  hoursWeek: 40,          // paid hours per worker per week
  weeksYear: 46,          // working weeks a year
  truckMpg: 12,           // crew trucks, miles per gallon
  truckFuel: 'diesel',
  wearPerMile: 0.35,      // tires, repairs and wear per mile, per vehicle
  vehicles: 2,            // vehicles that drive to a tree job (snow jobs count half)
};
// an empty or zero box means "use the normal value" (except where 0 is a real answer)
export const profileOf = (pb) => {
  const out = { ...DEFAULT_PROFILE };
  for (const [k, v] of Object.entries(pb?.auto || {})) {
    if (!(k in DEFAULT_PROFILE) || v === undefined || v === null || v === '') continue;
    if (typeof DEFAULT_PROFILE[k] === 'number' && !(+v > 0) && !['overheadYear', 'wearPerMile'].includes(k)) continue;
    out[k] = typeof DEFAULT_PROFILE[k] === 'number' ? Math.max(0, +v || 0) : v;
  }
  return out;
};

const r2 = (n) => Math.round(n * 100) / 100;
const up = (n, step) => Math.ceil(n / step) * step;
const money = (n) => `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

// ---------- the suggestions ----------

export function suggestPricing(company, pb, fuel, profile = profileOf(pb)) {
  const out = [];
  const manual = pb?.auto?.manual || {};
  const add = (c) => { if (c.to !== c.from && Number.isFinite(c.to)) out.push(c); };
  const P = profile;
  const price = (kind) => fuel?.[kind]?.price || 0;
  const where = (kind) => (fuel?.[kind]?.manual ? 'your price' : `${fuel?.[kind]?.label || ''}${fuel?.week ? `, week of ${fuel.week}` : ''}`);

  // 1. fuel per hour for each machine (auto)
  if (fuel) {
    for (const e of company?.equipment || []) {
      if (e.fuelManual) continue;
      const { gph, kind } = fuelUse(e);
      if (!(gph > 0) || !(price(kind) > 0)) continue;
      const to = r2(gph * price(kind));
      if (Math.abs(to - (+e.fuel || 0)) < 0.05) continue;
      add({ id: `fuel:${e.id}`, group: 'fuel', auto: true, target: 'equip', eqId: e.id, field: 'fuel', label: `${e.name}: fuel per hour`, from: +e.fuel || 0, to, unit: '$/hr',
        why: `${gph} gal/hr × ${money(price(kind))} ${kind} (${where(kind)})` });
    }
    // fuel for rented machines
    if (!manual['equipmentDefaults.fuel'] && price('diesel') > 0) {
      const to = r2(2 * price('diesel'));
      if (Math.abs(to - (+pb.equipmentDefaults?.fuel || 0)) >= 0.05) add({ id: 'pb:equipmentDefaults.fuel', group: 'fuel', auto: true, target: 'pb', path: 'equipmentDefaults.fuel', label: 'Rental machines: fuel per hour', from: +pb.equipmentDefaults?.fuel || 0, to, unit: '$/hr', why: `about 2 gal/hr × ${money(price('diesel'))} diesel` });
    }
    // 2. cost per mile beyond the free radius (auto)
    const tf = P.truckFuel === 'gas' ? 'gas' : 'diesel';
    if (!manual['travel.perMile'] && price(tf) > 0 && +P.truckMpg > 0) {
      const v = Math.max(1, Math.min(6, +P.vehicles || 1));
      const per = price(tf) / Math.max(3, +P.truckMpg) + Math.max(0, +P.wearPerMile || 0);
      const to = r2(v * per);
      if (Math.abs(to - (+pb.travel?.perMile || 0)) >= 0.02) add({ id: 'pb:travel.perMile', group: 'travel', auto: true, target: 'pb', path: 'travel.perMile', label: 'Travel: cost per mile', from: +pb.travel?.perMile || 0, to, unit: '$/mile',
        why: `${v} vehicle${v > 1 ? 's' : ''} × (${money(price(tf))} ${tf} ÷ ${P.truckMpg} mpg + ${money(+P.wearPerMile || 0)} wear)` });
    }
  }

  const workers = activeWorkers(company);
  const burden = 1 + Math.max(0, +pb.labor?.burdenPct || 0) / 100;
  const avgRate = workers.length ? workers.reduce((s, w) => s + Math.min(500, Math.max(0, +w.rate || 0)), 0) / workers.length : +pb.labor?.wage || 0;

  // 3. default pay used when a quote has no workers to plan with (suggestion)
  if (workers.length && Math.abs(avgRate - (+pb.labor?.wage || 0)) >= 1) {
    add({ id: 'pb:labor.wage', group: 'labor', auto: false, target: 'pb', path: 'labor.wage', label: 'Standard hourly labor cost', from: +pb.labor.wage || 0, to: r2(avgRate), unit: '$/hr', why: `average pay of your ${workers.length} active worker${workers.length > 1 ? 's' : ''}` });
    const ot = workers.reduce((s, w) => s + Math.min(500, Math.max(0, +w.otRate > 0 ? +w.otRate : Math.max(0, +w.rate || 0) * 1.5)), 0) / workers.length;
    if (Math.abs(ot - (+pb.labor?.overtime || 0)) >= 1) add({ id: 'pb:labor.overtime', group: 'labor', auto: false, target: 'pb', path: 'labor.overtime', label: 'Overtime labor cost', from: +pb.labor.overtime || 0, to: r2(ot), unit: '$/hr', why: 'average overtime pay of your active workers' });
  }

  // 4. overhead % from the yearly costs that aren't on any one job (suggestion)
  const overheadYear = Math.max(0, +P.overheadYear || 0);
  if (overheadYear > 0 && workers.length) {
    const laborYear = workers.reduce((s, w) => s + Math.min(500, Math.max(0, +w.rate || 0)), 0) * burden * Math.max(1, +P.hoursWeek || 40) * Math.max(1, Math.min(52, +P.weeksYear || 46));
    // labor is usually about two thirds of a job's direct cost; the rest is machines, fuel, dump fees
    const direct = laborYear * 1.5;
    const to = Math.round(Math.min(60, Math.max(3, (overheadYear / direct) * 100)));
    if (Math.abs(to - (+pb.overheadPct || 0)) >= 1) add({ id: 'pb:overheadPct', group: 'overhead', auto: false, target: 'pb', path: 'overheadPct', label: 'Overhead', from: +pb.overheadPct || 0, to, unit: '%',
      why: `${money(overheadYear)} a year ÷ about ${money(Math.round(direct))} of yearly job costs (${workers.length} workers, ${P.hoursWeek} h/week, ${P.weeksYear} weeks)` });
  }

  // 5. machine ownership cost from what it cost to buy (suggestion). Only ever raises the number:
  // the owner's own figure may include costs this rough rule can't see (loan, registration, storage).
  for (const e of company?.equipment || []) {
    const buy = +e.purchaseCost || 0;
    if (!(buy > 0)) continue;
    const [life, hours] = OWNERSHIP[e.type] || OWNERSHIP.default;
    // loses ~80% of its value over its life, plus ~10% a year for interest, insurance and storage
    const to = r2((buy * (0.8 / life + 0.1)) / hours);
    const from = +e.hourly || 0;
    if (from > 0 && to < from * 1.15) continue;
    add({ id: `own:${e.id}`, group: 'equipment', auto: false, target: 'equip', eqId: e.id, field: 'hourly', label: `${e.name}: cost to own per hour`, from, to, unit: '$/hr',
      why: `${money(buy)} to buy, used about ${life} years × ${hours} hours a year, plus interest, insurance and storage. Your number looks low, so jobs with it may lose money.` });
  }

  // 6. smallest job must at least cover a short visit (suggestion, only ever raises it)
  const margin = Math.min(0.9, Math.max(0, (+pb.targetMarginPct || 0) / 100));
  const overhead = 1 + Math.max(0, +pb.overheadPct || 0) / 100;
  const units = fleet(company);
  const unitCost = (type, h) => { const u = units.find((x) => x.type === type); return u ? (u.hourly + u.maintenance + u.fuel) * h : 0; };
  const floor = (cost, step) => up((cost * overhead) / (1 - margin), step);
  const treeCrew = Math.min(2, Math.max(1, workers.length || 2));
  const treeVisit = avgRate * burden * treeCrew * 2.5 + unitCost(units.some((u) => u.type === 'dump_truck') ? 'dump_truck' : 'pickup', 2.5) + unitCost('chipper', 1) + unitCost('chainsaw', 1.5);
  const treeMin = floor(treeVisit, 25);
  if (treeMin > (+pb.minJobTree || 0)) add({ id: 'pb:minJobTree', group: 'minimum', auto: false, target: 'pb', path: 'minJobTree', label: 'Smallest tree job', from: +pb.minJobTree || 0, to: treeMin, unit: '$',
    why: `a short visit (${treeCrew} people, about 2½ hours with travel, truck and chipper) costs you about ${money(Math.round(treeVisit * overhead))} with overhead, so ${money(treeMin)} keeps your ${Math.round(margin * 100)}% margin` });
  const snowVisit = avgRate * burden * 0.75 + unitCost('pickup', 0.75);
  const snowMin = floor(snowVisit, 5);
  if (snowMin > (+pb.minJobSnow || 0)) add({ id: 'pb:minJobSnow', group: 'minimum', auto: false, target: 'pb', path: 'minJobSnow', label: 'Smallest snow visit', from: +pb.minJobSnow || 0, to: snowMin, unit: '$',
    why: `one person and a plow truck for about 45 minutes costs you about ${money(Math.round(snowVisit * overhead))} with overhead, so ${money(snowMin)} keeps your ${Math.round(margin * 100)}% margin` });

  return out;
}

const setPath = (o, path, v) => { const k = path.split('.'); const last = k.pop(); let t = o; for (const x of k) t = t[x] ||= {}; t[last] = v; };

// Apply the chosen changes. Returns the ones that were applied (for the change log).
export function applyChanges(company, pb, changes) {
  const done = [];
  for (const c of changes) {
    if (c.target === 'pb') setPath(pb, c.path, c.to);
    else if (c.target === 'equip') {
      const e = company.equipment.find((x) => x.id === c.eqId);
      if (!e) continue;
      e[c.field] = c.to;
    } else continue;
    done.push(c);
  }
  return done;
}

export const typeLabel = (t) => EQUIPMENT_TYPES[t]?.label || t;
