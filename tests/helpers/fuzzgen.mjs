// Random input generators for the fuzz tests (seeded, reproducible).
import assert from 'node:assert/strict';
import { newJob } from '../../js/engine.js';
import { defaultCompany, newWorker, newEquipment, EQUIPMENT_TYPES, ATTACHMENT_TYPES } from '../../js/company.js';
import { mergePricebook } from '../../js/pricebook.js';

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const R = {
    f: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
    // numbers people (or bugs) might type: normal, zero, negative, huge, blank, text
    num: (lo, hi) => R.pick([R.int(lo, hi), R.int(lo, hi), R.int(lo, hi), 0, -R.int(1, 50), R.int(hi, hi * 20), '', undefined, 'abc', String(R.int(lo, hi)), 1e9, 0.5]),
  };
  return R;
}

export const finite = (v, what) => assert.ok(Number.isFinite(v), `${what} is not a finite number: ${v}`);
export const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

const SPECIES = ['oak', 'maple', 'red oak', 'pine', 'palm', 'spruce', '', 'unknown tree', 'Silver Maple', '🌳', undefined];
const WORDS = ['remove', 'trim', 'stump', 'cable', 'tree', 'oak', 'maple', '45 ft', '60-foot', '20 inch', 'backyard', 'front yard', 'power lines', 'over the house',
  'dead', 'leaning', 'fence', 'crane', 'bucket truck', 'haul', 'leave the wood', 'firewood', 'grind the stump', 'snow', 'plow', 'salt', 'driveway', '2-car', 'parking lot',
  '40,000 sq ft', '6 inch', 'sidewalk', 'roof', 'commercial', 'seasonal', 'priority', 'emergency', 'storm', 'permit', '12 miles', 'customer is Dana Lee', '555-014-2299',
  'dana@example.com', '18 Orchard Ln', '3 trees', 'two oaks', '<img src=x onerror=alert(1)>', '"; DROP TABLE', '\u0000', '∞', 'NaN', '-5 ft', '9999 ft', '0 inch', '\n\n'];

export function randomText(R) {
  const n = R.int(0, 14);
  let s = Array.from({ length: n }, () => R.pick(WORDS)).join(R.pick([' ', ', ', '. ', '  ']));
  if (R.bool(0.05)) s = s.repeat(R.int(20, 200)); // very long dictation
  return s;
}

export function randomJob(R) {
  const j = newJob(R.pick(['tree', 'snow', 'tree']));
  j.description = randomText(R);
  j.emergency = R.bool(0.2); j.storm = R.bool(0.1); j.weekend = R.bool(0.1); j.holiday = R.bool(0.05);
  j.permit = R.bool(0.1);
  j.miles = R.num(0, 60);
  j.property = R.pick(['residential', 'commercial', 'bogus']);
  j.difficulty = R.pick(['easy', 'normal', 'moderate', 'difficult', 'very', 'extreme', 'nope', undefined]);
  j.conditions = Object.fromEntries(['steepSlope', 'limitedAccess', 'narrowGate', 'longDrag', 'heavyCleanup', 'denseBrush', 'wet', 'frozen', 'heavySnow', 'ice', 'tightAreas', 'snowPiles', 'longTravel', 'nearRoad', 'vehicles', 'largeLogs', 'madeUp'].filter(() => R.bool(0.15)).map((k) => [k, true]));
  const t = j.tree;
  t.trees = Array.from({ length: R.int(0, 5) }, () => ({ work: R.pick(['remove', 'trim', 'stump', 'cable', 'remove', 'weird']), species: R.pick(SPECIES), heightFt: R.num(5, 120), dbhIn: R.num(0, 60), qty: R.num(1, 6) }));
  if (!t.trees.length && R.bool(0.7)) t.trees = [{ work: 'remove', species: 'oak', heightFt: 40, dbhIn: 0, qty: 1 }];
  t.access = R.pick(['open', 'driveway', 'backyard', 'tight', 'moon']);
  t.method = R.pick(['auto', 'auto', 'bucket', 'crane', 'lift', 'climb', 'jetpack']);
  t.debris = R.pick(['haul', 'chipLeaveLogs', 'leave', 'burn']);
  t.trimLevel = R.pick(['light', 'standard', 'heavy', 'medium']);
  t.stumps = R.bool(); t.restore = R.bool(0.3); t.firewood = R.bool(0.2);
  t.hazards = Object.fromEntries(['powerLines', 'overHouse', 'nearStructure', 'dead', 'leaning', 'fenceGarden'].filter(() => R.bool(0.25)).map((k) => [k, true]));
  const s = j.snow;
  s.property = R.pick(['residential', 'commercial']);
  s.areaSqft = R.num(0, 200000); s.walkLf = R.num(0, 800); s.roofSqft = R.pick([0, 0, R.int(0, 5000), -3, '']);
  s.depthIn = R.num(1, 30); s.method = R.pick(['auto', 'plow', 'skid', 'loader', 'blower', 'shovel', 'hovercraft']);
  s.salt = R.bool(); s.obstacles = R.pick(['low', 'med', 'high', 'x']); s.priority = R.bool(0.2);
  s.contract = R.pick(['perPush', 'seasonal']); s.events = R.num(0, 40); s.haul = R.bool(0.2);
  return j;
}

export function randomCompany(R) {
  const c = defaultCompany();
  if (R.bool(0.15)) return c; // sample company
  c.sample = false;
  c.workers = Array.from({ length: R.int(0, 9) }, (_, i) => newWorker({
    name: R.pick([`W${i}`, '', '<b>x</b>', 'José 🌲']), skill: R.pick(['beginner', 'intermediate', 'experienced', 'expert', 'wizard']),
    rate: R.num(10, 60), otRate: R.num(15, 90), active: R.bool(0.8),
    can: { heavy: R.bool(), truck: R.bool(), loader: R.bool(), bucket: R.bool(), chipper: R.bool(), chainsaw: R.bool(0.8) },
  }));
  const types = [...Object.keys(EQUIPMENT_TYPES), 'flux_capacitor'];
  c.equipment = Array.from({ length: R.int(0, 14) }, () => {
    const q = R.num(1, 5);
    return newEquipment(R.pick(types), {
      quantity: q, available: R.pick([q, R.num(0, 6), undefined, '']), availability: R.pick(['available', 'available', 'repair', 'season', 'lost']),
      hourly: R.num(0, 80), fuel: R.num(0, 20), maintenance: R.num(0, 15), operator: R.bool(0.8),
      attachments: Array.from({ length: R.int(0, 2) }, () => ({ type: R.pick(Object.keys(ATTACHMENT_TYPES)), name: '' })),
    });
  });
  // people can type anything into Production Rates, including 0
  for (const r of c.rates) {
    if (R.bool(0.1)) r.rate = R.pick([0, -1, 1e-6, r.rate * 10, '', '2']);
    if (R.bool(0.05)) r.baseTime = R.pick([0, -1, 5, '']);
    if (R.bool(0.05)) r.recCrew = R.pick([0, 1, 12, '']);
  }
  for (const m of Object.values(c.multipliers.conditions)) if (R.bool(0.05)) m.value = R.pick([0, 0.5, 3, '']);
  return c;
}

export function randomPricebook(R) {
  const pb = mergePricebook({});
  if (R.bool(0.3)) return pb;
  pb.targetMarginPct = R.pick([0, 10, 35, 60, 90, 99, 100, -10, '']);
  pb.overheadPct = R.pick([0, 15, 40, -5]);
  pb.profit.minProfit = R.pick([0, 75, 500, -20]);
  pb.profit.weekendPct = R.pick([0, 15, 200, -50]);
  pb.taxPct = R.pick([0, 7.5, 13]);
  pb.travel.speedMph = R.pick([35, 0, -10, '']);
  pb.disposal.loadYards = R.pick([12, 0, 1, '']);
  pb.labor.wage = R.pick([26, 0, '', 500]);
  return pb;
}

