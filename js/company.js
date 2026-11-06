// Company resources and estimating data: workers, equipment, production rates, multipliers.
// Everything here is editable in the app (My Resources, Production Rates) and stored on-device.
// The planner (js/planner.js) uses only what is listed and available here: it never assumes
// unlimited workers or equipment.

export const SKILLS = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  experienced: 'Experienced',
  expert: 'Expert',
};

export const CAPABILITIES = {
  heavy: 'Heavy equipment',
  truck: 'Drive truck',
  loader: 'Loader',
  bucket: 'Bucket truck',
  chipper: 'Chipper',
  chainsaw: 'Chainsaw',
};

// Equipment types. `op`: capability an operator needs. `rental`: Pricing → rental rate used
// when the company does not own one. Costs are per hour: [operating, fuel, maintenance].
export const EQUIPMENT_TYPES = {
  bucket_truck:   { label: 'Bucket truck',            cat: 'tree', op: 'bucket',   rental: 'bucket',  cost: [45, 12, 10] },
  chipper:        { label: 'Chipper',                 cat: 'tree', op: 'chipper',  rental: 'chipper', cost: [15, 8, 6] },
  chainsaw:       { label: 'Chainsaw',                cat: 'tree', op: 'chainsaw',                    cost: [2, 1, 1] },
  stump_grinder:  { label: 'Stump grinder',           cat: 'tree', op: 'heavy',    rental: 'grinder', cost: [18, 7, 7] },
  skid_steer:     { label: 'Skid steer',              cat: 'both', op: 'loader',   rental: 'loader',  cost: [30, 9, 8] },
  mini_excavator: { label: 'Mini excavator',          cat: 'tree', op: 'heavy',                       cost: [30, 8, 8] },
  excavator:      { label: 'Excavator',               cat: 'tree', op: 'heavy',                       cost: [60, 15, 12] },
  grapple:        { label: 'Grapple truck / knuckle boom', cat: 'tree', op: 'heavy',                  cost: [40, 14, 10] },
  dump_truck:     { label: 'Dump truck',              cat: 'both', op: 'truck',    rental: 'dump',    cost: [22, 14, 8] },
  log_trailer:    { label: 'Log trailer',             cat: 'tree',                                    cost: [6, 0, 2] },
  brush_trailer:  { label: 'Brush trailer',           cat: 'tree',                                    cost: [5, 0, 2] },
  wood_splitter:  { label: 'Wood splitter',           cat: 'tree',                                    cost: [6, 2, 2] },
  pole_saw:       { label: 'Pole saw',                cat: 'tree',                                    cost: [2, 0.5, 0.5] },
  climbing_gear:  { label: 'Climbing & rigging gear', cat: 'tree',                     rental: 'climb',   cost: [5, 0, 2] },
  crane:          { label: 'Crane',                   cat: 'tree', op: 'heavy',    rental: 'crane',   cost: [180, 30, 25] },
  spider_lift:    { label: 'Spider lift',             cat: 'tree', op: 'heavy',    rental: 'lift',    cost: [55, 6, 10] },
  pickup:         { label: 'Pickup truck',            cat: 'snow', op: 'truck',                       cost: [15, 10, 5] },
  loader:         { label: 'Wheel loader',            cat: 'snow', op: 'loader',                      cost: [55, 18, 12] },
  compact_loader: { label: 'Compact loader',          cat: 'both', op: 'loader',                      cost: [30, 9, 8] },
  snow_blower:    { label: 'Snow blower (tractor)',   cat: 'snow', op: 'heavy',                       cost: [15, 5, 4] },
  walk_blower:    { label: 'Walk-behind snow blower', cat: 'snow',                     rental: 'blower',  cost: [5, 2, 2] },
  salt_spreader:  { label: 'Salt spreader (standalone)', cat: 'snow',                  rental: 'spreader', cost: [6, 1, 2] },
  utv:            { label: 'UTV',                     cat: 'snow', op: 'truck',                       cost: [10, 4, 3] },
  atv:            { label: 'ATV',                     cat: 'snow', op: 'truck',                       cost: [8, 3, 3] },
  sidewalk_machine: { label: 'Sidewalk machine',      cat: 'snow', op: 'heavy',                       cost: [25, 6, 6] },
  other:          { label: 'Other',                   cat: 'both',                                    cost: [0, 0, 0] },
};

export const ATTACHMENT_TYPES = {
  plow: 'Plow',
  salt_spreader: 'Salt spreader',
  snow_pusher: 'Snow pusher',
  snow_bucket: 'Snow bucket',
  grapple: 'Grapple',
  other: 'Other',
};

export const MAX_QTY = 50; // per equipment record

export const AVAILABILITY = { available: 'Available', repair: 'In the shop', season: 'Out of season / stored' };

let n = 0;
const id = (p) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export function newWorker(over = {}) {
  return { id: id('w'), name: '', role: '', skill: 'intermediate', rate: 22, otRate: 33, active: true, can: { heavy: false, truck: false, loader: false, bucket: false, chipper: false, chainsaw: true }, ...over };
}

export function newEquipment(type = 'other', over = {}) {
  const t = EQUIPMENT_TYPES[type] || EQUIPMENT_TYPES.other;
  return {
    id: id('e'), name: t.label, type, quantity: 1, available: 1, purchaseCost: 0,
    hourly: t.cost[0], fuel: t.cost[1], maintenance: t.cost[2], operator: !!t.op,
    productionRate: '', availability: 'available', notes: '', attachments: [], ...over,
  };
}

// A sample company so estimates work on day one. The app labels it "sample: edit to match".
export function sampleCompany() {
  const W = (name, role, skill, rate, can) => newWorker({ name, role, skill, rate, otRate: rate * 1.5, can: { heavy: false, truck: false, loader: false, bucket: false, chipper: false, chainsaw: false, ...can } });
  const E = (type, over) => newEquipment(type, over);
  return {
    sample: true,
    workers: [
      W('Crew lead', 'Foreman', 'expert', 32, { heavy: true, truck: true, loader: true, bucket: true, chipper: true, chainsaw: true }),
      W('Climber', 'Arborist / climber', 'experienced', 28, { truck: true, bucket: true, chipper: true, chainsaw: true }),
      W('Equipment operator', 'Operator', 'experienced', 27, { heavy: true, truck: true, loader: true, chainsaw: true }),
      W('Groundworker 1', 'Groundworker', 'intermediate', 22, { truck: true, chipper: true, chainsaw: true }),
      W('Groundworker 2', 'Groundworker', 'beginner', 18, { chipper: true, chainsaw: true }),
    ],
    equipment: [
      E('bucket_truck', { name: 'Bucket truck (60 ft)', purchaseCost: 120000 }),
      E('chipper', { name: '12" brush chipper', purchaseCost: 45000 }),
      E('stump_grinder', { name: 'Stump grinder', purchaseCost: 25000 }),
      E('chainsaw', { name: 'Chainsaw', quantity: 4, available: 4, purchaseCost: 700 }),
      E('climbing_gear', { name: 'Climbing kit', quantity: 2, available: 2, purchaseCost: 2500 }),
      E('skid_steer', { name: 'Skid steer', purchaseCost: 55000, attachments: [{ type: 'grapple', name: 'Grapple' }, { type: 'snow_pusher', name: '8 ft snow pusher' }] }),
      E('dump_truck', { name: 'Dump truck', quantity: 2, available: 2, purchaseCost: 65000 }),
      E('pickup', { name: 'Truck #1', purchaseCost: 50000, attachments: [{ type: 'plow', name: '9-foot plow' }, { type: 'salt_spreader', name: 'Salt spreader' }] }),
      E('pickup', { name: 'Truck #2', purchaseCost: 45000, attachments: [{ type: 'plow', name: '8-foot plow' }] }),
      E('loader', { name: 'Loader #1', purchaseCost: 90000, attachments: [{ type: 'snow_pusher', name: '12 ft snow pusher' }] }),
      E('walk_blower', { name: 'Snow blower', quantity: 2, available: 2, purchaseCost: 1500 }),
    ],
  };
}

// ---------- production rates ----------
// sens = how much each condition group affects the task (1 = fully, 0 = not at all).
const S = (difficulty, access, cleanup, experience, weather) => ({ difficulty, access, cleanup, experience, weather });

export const DEFAULT_RATES = [
  { id: 'tree_setup', jobType: 'Tree', task: 'Setup, safety briefing & teardown', minCrew: 1, recCrew: 3, equipment: 'Cones, signs', unit: 'job', rate: 0, baseTime: 0.5, sens: S(0, 0.5, 0, 0.5, 0), notes: 'Fixed time per job.' },
  { id: 'tree_removal', jobType: 'Tree', task: 'Tree removal (cut & lower)', minCrew: 2, recCrew: 3, equipment: 'Chainsaws + climbing gear, bucket truck, spider lift or crane', unit: 'tree (40 ft, 16 in reference)', rate: 0.36, baseTime: 0.25, sens: S(1, 1, 0, 1, 0.5), notes: 'Scaled by tree size (height and trunk), species hardness and removal method.' },
  { id: 'tree_trim', jobType: 'Tree', task: 'Pruning / trimming', minCrew: 2, recCrew: 3, equipment: 'Chainsaws, pole saw, climbing gear or bucket truck', unit: 'tree (40 ft, 16 in reference)', rate: 0.72, baseTime: 0.25, sens: S(1, 1, 0, 1, 0.5), notes: 'Scaled by tree size and trim level.' },
  { id: 'cabling', jobType: 'Tree', task: 'Cabling & bracing', minCrew: 2, recCrew: 2, equipment: 'Climbing gear or bucket truck', unit: 'tree', rate: 0.4, baseTime: 0, sens: S(1, 0.5, 0, 1, 0.5), notes: '' },
  { id: 'brush_chipping', jobType: 'Tree', task: 'Brush chipping', minCrew: 2, recCrew: 2, equipment: 'Chipper', unit: 'cubic yard of brush', rate: 10, baseTime: 0, sens: S(0.3, 0.7, 1, 1, 0.3), notes: 'About 40% of a removed tree\'s volume is brush.' },
  { id: 'brush_hand', jobType: 'Tree', task: 'Brush handling without chipper', minCrew: 2, recCrew: 2, equipment: 'Brush trailer or dump truck', unit: 'cubic yard of brush', rate: 5, baseTime: 0, sens: S(0.3, 1, 1, 1, 0.3), notes: 'Used when no chipper is available.' },
  { id: 'log_loading', jobType: 'Tree', task: 'Log loading with machine', minCrew: 1, recCrew: 1, equipment: 'Skid steer / loader / grapple', unit: 'cubic yard of wood', rate: 8, baseTime: 0, sens: S(0.5, 0.7, 1, 1, 0.3), notes: 'About 60% of a removed tree\'s volume is wood.' },
  { id: 'log_hand', jobType: 'Tree', task: 'Log loading by hand', minCrew: 2, recCrew: 3, equipment: 'Dollies, log tongs', unit: 'cubic yard of wood', rate: 3, baseTime: 0, sens: S(0.5, 1, 1, 1, 0.3), notes: 'Used when no loader is available.' },
  { id: 'firewood', jobType: 'Tree', task: 'Cut firewood lengths', minCrew: 1, recCrew: 2, equipment: 'Chainsaws', unit: 'cubic yard of wood', rate: 4, baseTime: 0, sens: S(0, 0, 1, 1, 0), notes: '' },
  { id: 'stump_grinding', jobType: 'Tree', task: 'Stump grinding', minCrew: 1, recCrew: 1, equipment: 'Stump grinder', unit: 'inch of stump diameter', rate: 28, baseTime: 0.3, sens: S(0.5, 1, 0, 1, 0.3), notes: 'Base time is per stump (setup, utility check).' },
  { id: 'hauling', jobType: 'Tree', task: 'Hauling to dump site', minCrew: 1, recCrew: 1, equipment: 'Dump truck', unit: 'load', rate: 1, baseTime: 0, sens: S(0, 0, 0, 0, 0.3), notes: 'Round trips per truck per hour. Runs while the crew keeps working.' },
  { id: 'tree_cleanup', jobType: 'Tree', task: 'Final cleanup (rake, blow)', minCrew: 1, recCrew: 3, equipment: 'Blowers, rakes', unit: 'cubic yard of debris', rate: 30, baseTime: 0.25, sens: S(0, 0.5, 1, 0.5, 0.5), notes: '' },
  { id: 'snow_setup', jobType: 'Snow', task: 'Arrival & setup', minCrew: 1, recCrew: 1, equipment: '', unit: 'visit', rate: 0, baseTime: 0.15, sens: S(0, 0, 0, 0, 0), notes: '' },
  { id: 'plow_truck', jobType: 'Snow', task: 'Plowing (truck plow)', minCrew: 1, recCrew: 1, equipment: 'Truck with plow', unit: 'acre', rate: 0.9, baseTime: 0.08, sens: S(1, 0.5, 0, 1, 1), notes: 'Per truck at 2 in of snow; deeper snow slows it (see multipliers). Base time per visit: positioning, back-dragging, the garage apron.' },
  { id: 'plow_skid', jobType: 'Snow', task: 'Pushing (skid steer / compact loader)', minCrew: 1, recCrew: 1, equipment: 'Skid steer or compact loader with pusher/bucket', unit: 'acre', rate: 0.7, baseTime: 0.1, sens: S(1, 0.5, 0, 1, 1), notes: 'Base time per visit: unloading and positioning.' },
  { id: 'plow_loader', jobType: 'Snow', task: 'Pushing (wheel loader)', minCrew: 1, recCrew: 1, equipment: 'Wheel loader with pusher/bucket', unit: 'acre', rate: 2, baseTime: 0.1, sens: S(1, 0.5, 0, 1, 1), notes: 'Base time per visit: positioning.' },
  { id: 'snow_blower', jobType: 'Snow', task: 'Snow blowing (small areas)', minCrew: 1, recCrew: 1, equipment: 'Walk-behind snow blower', unit: 'sq ft', rate: 4000, baseTime: 0.05, sens: S(0.5, 0, 0, 1, 1), notes: 'Base time per visit: unloading and starting the blower.' },
  { id: 'shoveling', jobType: 'Snow', task: 'Shoveling', minCrew: 1, recCrew: 1, equipment: 'Shovels', unit: 'sq ft', rate: 800, baseTime: 0, sens: S(0.5, 0, 0, 1, 1), notes: 'Per worker.' },
  { id: 'sidewalks', jobType: 'Snow', task: 'Sidewalk clearing', minCrew: 1, recCrew: 1, equipment: 'Snow blower or shovel', unit: 'linear ft', rate: 300, baseTime: 0, sens: S(0.5, 0, 0, 1, 1), notes: 'Per worker, 4 ft wide walks.' },
  { id: 'sidewalk_machine', jobType: 'Snow', task: 'Sidewalk machine', minCrew: 1, recCrew: 1, equipment: 'Sidewalk machine, UTV or ATV with plow', unit: 'linear ft', rate: 2000, baseTime: 0, sens: S(0.5, 0, 0, 1, 1), notes: '' },
  { id: 'salting', jobType: 'Snow', task: 'Salting (spreader)', minCrew: 1, recCrew: 1, equipment: 'Truck or standalone salt spreader', unit: 'acre', rate: 1, baseTime: 0.1, sens: S(0.3, 0, 0, 0.5, 0.5), notes: '' },
  { id: 'salting_hand', jobType: 'Snow', task: 'Salting (walk-behind / by hand)', minCrew: 1, recCrew: 1, equipment: 'Hand spreader', unit: 'acre', rate: 0.25, baseTime: 0.1, sens: S(0.3, 0, 0, 0.5, 0.5), notes: 'Used when no spreader is available.' },
  { id: 'roof_snow', jobType: 'Snow', task: 'Roof snow removal', minCrew: 2, recCrew: 2, equipment: 'Roof rakes, fall protection', unit: 'sq ft', rate: 350, baseTime: 0, sens: S(1, 0, 0, 1, 1), notes: 'Per worker.' },
  { id: 'snow_hauling', jobType: 'Snow', task: 'Snow hauling', minCrew: 1, recCrew: 1, equipment: 'Dump truck', unit: 'load', rate: 2, baseTime: 0, sens: S(0, 0, 0, 0, 0.5), notes: 'Round trips per truck per hour.' },
  { id: 'snow_loading', jobType: 'Snow', task: 'Loading snow into trucks', minCrew: 1, recCrew: 1, equipment: 'Loader or skid steer', unit: 'load', rate: 8, baseTime: 0, sens: S(0, 0, 0, 1, 0.3), notes: 'Loads per loader per hour.' },
];

// ---------- multipliers ----------
// Within a group, extra effects add up (power lines 1.35 + buildings 1.20 → 1.55). Each task then
// feels a group in proportion to its sensitivity (see production rates).
const C = (label, value, group, division) => ({ label, value, group, division });

export const DEFAULT_MULTIPLIERS = {
  difficulty: {
    easy: { label: 'Easy', value: 1.0 }, normal: { label: 'Normal', value: 1.0 }, moderate: { label: 'Moderately difficult', value: 1.2 },
    difficult: { label: 'Difficult', value: 1.4 }, very: { label: 'Very difficult', value: 1.75 }, extreme: { label: 'Extremely difficult', value: 2.0 },
  },
  access: {
    open: { label: 'Open: drive right up', value: 1.0 }, driveway: { label: 'Driveway / street', value: 1.05 },
    backyard: { label: 'Backyard through gate', value: 1.3 }, tight: { label: 'Tight: no equipment', value: 1.6 },
  },
  conditions: {
    powerLines: C('Power lines', 1.35, 'difficulty', 'tree'),
    overHouse: C('Over the house / roof', 1.3, 'difficulty', 'tree'),
    nearStructure: C('Buildings nearby', 1.2, 'difficulty', 'tree'),
    dead: C('Dead / decayed wood', 1.15, 'difficulty', 'tree'),
    leaning: C('Leaning / storm damaged', 1.15, 'difficulty', 'tree'),
    largeLogs: C('Large logs', 1.2, 'difficulty', 'tree'),
    steepSlope: C('Steep slope', 1.25, 'difficulty', 'both'),
    nearRoad: C('Next to a road (traffic control)', 1.15, 'difficulty', 'tree'),
    vehicles: C('Vehicles in the drop zone', 1.1, 'difficulty', 'tree'),
    limitedAccess: C('Limited access', 1.2, 'access', 'both'),
    narrowGate: C('Narrow gate', 1.15, 'access', 'tree'),
    longDrag: C('Long drag distance', 1.25, 'access', 'tree'),
    fenceGarden: C('Fence / garden in the drop zone', 1.1, 'cleanup', 'tree'),
    heavyCleanup: C('Heavy cleanup', 1.3, 'cleanup', 'tree'),
    denseBrush: C('Dense brush', 1.25, 'cleanup', 'tree'),
    wet: C('Wet conditions', 1.1, 'weather', 'both'),
    frozen: C('Frozen conditions', 1.15, 'weather', 'both'),
    heavySnow: C('Heavy / wet snow', 1.3, 'weather', 'snow'),
    ice: C('Ice', 1.2, 'weather', 'snow'),
    tightAreas: C('Tight areas', 1.2, 'difficulty', 'snow'),
    snowPiles: C('Existing snow piles', 1.15, 'difficulty', 'snow'),
    longTravel: C('Long travel distance', 1.5, 'travel', 'both'),
  },
  method: { bucket: { label: 'Bucket truck', value: 0.7 }, crane: { label: 'Crane', value: 0.6 }, lift: { label: 'Spider lift', value: 0.85 }, climb: { label: 'Climb & rig', value: 1.0 }, fell: { label: 'Cut down from the ground (room to fall)', value: 0.4 } },
  trim: { light: { label: 'Light / deadwood', value: 0.7 }, standard: { label: 'Standard', value: 1.0 }, heavy: { label: 'Heavy / reduction', value: 1.4 } },
  skill: { beginner: { label: 'Beginner', value: 1.3 }, intermediate: { label: 'Intermediate', value: 1.1 }, experienced: { label: 'Experienced', value: 1.0 }, expert: { label: 'Expert', value: 0.9 } },
  obstacles: { low: { label: 'Few obstacles', value: 1.0 }, med: { label: 'Some: cars, curbs', value: 1.2 }, high: { label: 'Many: islands, tight', value: 1.45 } },
  snowDepth: { perInch: { label: 'Extra time per inch of snow over 2 in', value: 0.167 } },
};

export function defaultCompany() {
  return { ...sampleCompany(), rates: structuredClone(DEFAULT_RATES), multipliers: structuredClone(DEFAULT_MULTIPLIERS), rateLog: [] };
}

// Fill in anything missing from older saved data without overwriting the company's edits.
export function mergeCompany(saved) {
  const base = defaultCompany();
  if (!saved) return base;
  const out = { ...base, ...saved };
  out.workers = (saved.workers || base.workers).map((w) => ({ ...newWorker(), ...w, can: { ...newWorker().can, ...(w.can || {}) } }));
  out.equipment = (saved.equipment || base.equipment).map((e) => ({ ...newEquipment(e.type), ...e, attachments: e.attachments || [] }));
  const rates = new Map((saved.rates || []).map((r) => [r.id, r]));
  out.rates = DEFAULT_RATES.map((d) => (rates.has(d.id) ? { ...structuredClone(d), ...rates.get(d.id), sens: { ...d.sens, ...(rates.get(d.id).sens || {}) } } : structuredClone(d)));
  for (const r of saved.rates || []) if (!DEFAULT_RATES.some((d) => d.id === r.id)) out.rates.push(r); // custom records
  out.multipliers = structuredClone(DEFAULT_MULTIPLIERS);
  for (const [g, items] of Object.entries(saved.multipliers || {})) {
    if (!out.multipliers[g]) continue;
    for (const [k, v] of Object.entries(items)) if (out.multipliers[g][k]) out.multipliers[g][k] = { ...out.multipliers[g][k], ...v };
  }
  out.rateLog = saved.rateLog || [];
  return out;
}

// ---------- fleet: what is actually available today ----------

// Expand equipment records into individual available units.
export const MAX_UNIT_COST = 1500; // $/hr for one cost line of one machine; a crane is about $400
const unitCost = (v) => Math.min(MAX_UNIT_COST, Math.max(0, +v || 0));

export function fleet(company) {
  const units = [];
  for (const e of company?.equipment || []) {
    if (e.availability && e.availability !== 'available') continue;
    // a typo like quantity 1000000000 must not create a billion machines
    const qty = Math.min(MAX_QTY, Math.max(0, Math.floor(+e.quantity || 0)));
    const avail = e.available === undefined || e.available === '' ? qty : Math.floor(+e.available || 0);
    const count = Math.max(0, Math.min(qty, avail));
    for (let i = 0; i < count; i++) {
      units.push({
        recordId: e.id,
        name: count > 1 || qty > 1 ? `${e.name || EQUIPMENT_TYPES[e.type]?.label || 'Equipment'} #${i + 1}` : e.name || EQUIPMENT_TYPES[e.type]?.label || 'Equipment',
        type: e.type,
        attachments: (e.attachments || []).map((a) => a.type),
        hourly: unitCost(e.hourly),
        fuel: unitCost(e.fuel),
        maintenance: unitCost(e.maintenance),
        costCapped: [e.hourly, e.fuel, e.maintenance].some((v) => +v > MAX_UNIT_COST),
        operator: e.operator !== false && !!EQUIPMENT_TYPES[e.type]?.op,
      });
    }
  }
  return units;
}

export const activeWorkers = (company) => (company?.workers || []).filter((w) => w.active !== false);

// "Workers 5 · Dump trucks 2 · Loaders 1 …" for the resources summary
export function inventory(company) {
  const counts = {};
  for (const u of fleet(company)) counts[u.type] = (counts[u.type] || 0) + 1;
  const att = {};
  for (const u of fleet(company)) for (const a of u.attachments) att[a] = (att[a] || 0) + 1;
  return { workers: activeWorkers(company).length, counts, attachments: att };
}
