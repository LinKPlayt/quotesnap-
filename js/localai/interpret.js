// Turns the on-device model's per-photo scores into quote fields.
// Pure functions (no DOM), unit-tested in tests/localai.test.mjs.
//
// Input: one entry per photo, { probs: { questionId: { classId: probability } } }
// (see tools/local-ai-questions.json for the questions). Output: the same shape the cloud
// analyzer returns, so the existing review card, field outlines and undo all work unchanged.
// Only things the photos actually show are filled in; anything unsure is left alone and
// listed under "Please confirm". Notes typed or spoken by the estimator always win.

import { parseDescription, estimateDbh } from '../engine.js';

// Probabilities needed before a field is filled in (tuned on hand-labeled test photos).
export const T = {
  stump: 0.55, hedge: 0.6, fallen: 0.55, deadTop: 0.4, deadSum: 0.65, species: 0.4, speciesSure: 0.6,
  powerLines: 0.65, powerLinesMaybe: 0.45, overHouse: 0.35, nearStructure: 0.6, leaning: 0.72, fence: 0.55, access: 0.4,
  lot: 0.45, roof: 0.5, sidewalk: 0.45, walks: 0.65, depth: 0.45, ice: 0.65, cars: 0.65, other: 0.6,
  road: 0.8, vehicles: 0.6, slope: 0.7, denseBrush: 0.8, few: 0.65, heavySnow: 0.5, piles: 0.6, tight: 0.8,
};

// Measurement ranges for each answer of the size-type questions (what a bucket really means).
const HEIGHT_RANGE = { 15: [10, 20], 30: [20, 40], 50: [40, 60], 75: [60, 90] };
const AREA_RANGE = { 500: [300, 700], 1000: [700, 1500], 2500: [1500, 4000], 10000: [5000, 20000], 40000: [20000, 80000] };
const DEPTH_RANGE = { 1: [0, 2], 4: [2, 6], 10: [6, 12], 18: [12, 24] };

// Range from a bucket distribution: the top bucket, widened to a neighbor that is nearly as likely.
// Confidence = probability that the true value is inside the range.
function rangeOf(dist, ranges) {
  const keys = Object.keys(ranges).map(Number).sort((a, b) => a - b);
  const ps = keys.map((k) => dist[k] || 0);
  const i = ps.indexOf(Math.max(...ps));
  let lo = i;
  let hi = i;
  const n = ps[i - 1] || 0;
  const m = ps[i + 1] || 0;
  if (Math.max(n, m) >= ps[i] * 0.5) { if (m >= n) hi = i + 1; else lo = i - 1; }
  let conf = 0;
  for (let k = lo; k <= hi; k++) conf += ps[k];
  return { low: ranges[keys[lo]][0], high: ranges[keys[hi]][1], conf };
}
const fmtRange = (lo, hi, unit) => `${Math.round(lo).toLocaleString()}–${Math.round(hi).toLocaleString()}${unit}`;
const item = (key, label, value, confidence = null, note = '') => ({ key, label, value, confidence: confidence === null ? null : Math.round(confidence * 100) / 100, note });
const yesNo = (p, yes, no) => (p >= 0.5 ? yes : no);

const SPECIES_WORD = { oak: 'oak', maple: 'maple', pine: 'pine', spruce: 'spruce', birch: 'birch', willow: 'willow', palm: 'palm', ash: 'ash', elm: 'elm' };

const top = (p) => Object.entries(p || {}).reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0]);

// Weighted average of the class probabilities across photos.
function mix(photos, q, weight) {
  const acc = {};
  let wsum = 0;
  photos.forEach((ph, i) => {
    const p = ph.probs[q];
    const w = weight(ph, i);
    if (!p || w <= 0) return;
    wsum += w;
    for (const [k, v] of Object.entries(p)) acc[k] = (acc[k] || 0) + v * w;
  });
  if (!wsum) return null;
  for (const k of Object.keys(acc)) acc[k] /= wsum;
  return acc;
}

// Several photos of the same tree: multiply the evidence (sum of log-probabilities), so two
// photos that both lean "maple" give a surer answer than either alone.
function agree(photos, q, weight) {
  const logs = {};
  let used = 0;
  for (const ph of photos) {
    const p = ph.probs[q];
    const w = weight(ph);
    if (!p || w <= 0) continue;
    used++;
    for (const [k, v] of Object.entries(p)) logs[k] = (logs[k] || 0) + w * Math.log(Math.max(v, 1e-6));
  }
  if (!used) return null;
  const max = Math.max(...Object.values(logs));
  const ex = Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, Math.exp(v - max)]));
  const sum = Object.values(ex).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(ex)) ex[k] /= sum;
  return ex;
}

// Highest probability of one class across photos (a hazard seen in any photo counts).
function peak(photos, q, cls, weight = () => 1) {
  let best = 0;
  let at = -1;
  photos.forEach((ph) => {
    const v = (ph.probs[q]?.[cls] || 0) * Math.min(1, weight(ph) * 1.25);
    if (v > best) { best = v; at = ph.i; }
  });
  return { p: best, at };
}

const pct = (p) => `${Math.round(p * 100)}%`;
const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const drop = (list, item) => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1); };

export function interpret(results, { notes = '', division: current = 'tree' } = {}) {
  const photos = results.map((r, i) => ({ ...r, i })).filter((r) => r.probs); // keep each photo's position
  if (!photos.length) throw new Error(results.find((r) => r?.error)?.error || 'None of the photos could be analyzed.');

  const scene = mix(photos, 'scene', () => 1);
  const parsed = parseDescription(notes || '');
  const observations = [];
  const missing = [];
  const upsells = [];

  photos.forEach((ph) => {
    const [k, v] = top(ph.probs.scene);
    if (k === 'other' && v >= T.other) observations.push(`Photo ${ph.i + 1} doesn't look like a tree or snow job. It was mostly ignored.`);
  });
  const jobPhotos = photos.filter((ph) => (ph.probs.scene?.other || 0) < T.other);
  const use = jobPhotos.length ? jobPhotos : photos;

  let division = (scene.snow || 0) > (scene.tree || 0) ? 'snow' : 'tree';
  if ((scene.other || 0) >= T.other && !jobPhotos.length) division = current;
  if (parsed.division) division = parsed.division;

  const out = {
    engine: 'local',
    division,
    customer: { name: '', phone: '', email: '', address: '' },
    tree: { trees: [], hazards: {} },
    snow: {},
    photoCaptions: [],
    observations,
    upsells,
    missing,
  };
  const confs = [Math.max(scene.tree || 0, scene.snow || 0)];

  if (division === 'tree') {
    const isTree = (ph) => ph.probs.scene?.tree || 0;
    const spatial = (ph) => isTree(ph) * (1 - (ph.probs.form?.closeup || 0)); // close-ups say nothing about size or position
    const form = mix(use, 'form', spatial) || mix(use, 'form', isTree) || {};
    const cond = mix(use, 'condition', isTree) || {};
    const species = agree(use, 'species', isTree) || {};
    const size = mix(use, 'size', spatial) || {};
    const access = mix(use, 'access', spatial) || {};

    let work = 'remove';
    if ((form.stump || 0) >= T.stump) work = 'stump';
    else if ((form.hedge || 0) >= T.hedge) work = 'trim';
    const fallen = (form.fallen || 0) >= T.fallen;

    const [sp, spP] = top(species);
    const sp2 = Object.entries(species).sort((a, b) => b[1] - a[1])[1];
    const speciesName = spP >= T.species ? SPECIES_WORD[sp] : '';
    if (speciesName && spP < T.speciesSure) observations.push(`Species looks like ${speciesName}${sp2 ? ` (or ${SPECIES_WORD[sp2[0]]})` : ''}: ${pct(spP)} sure. Confirm from bark and leaves.`);
    if (!speciesName) missing.push('species');
    confs.push(spP);

    // height: probability-weighted average of the size buckets, rounded to 5 ft
    let heightFt;
    if (work !== 'stump') {
      const ev = Object.entries(size).reduce((s, [k, v]) => s + +k * v, 0);
      if (ev) heightFt = Math.min(100, Math.max(10, Math.round(ev / 5) * 5));
      missing.push('tree height (rough guess from the photo)');
      confs.push(top(size)[1]);
    }
    missing.push('trunk diameter');

    const hz = {};
    // dead: fallen, or "dead"/"storm damage" is the single top answer, or the two together clearly win
    const [ck, cp] = top(cond);
    const deadSum = (cond.dead || 0) + (cond.storm || 0);
    if (fallen || ((ck === 'dead' || ck === 'storm') && cp >= T.deadTop) || deadSum >= T.deadSum) hz.dead = true;
    if (fallen || (cond.storm || 0) >= 0.4) hz.leaning = true;
    const lean = peak(use, 'leaning', 'yes', spatial);
    if (lean.p >= T.leaning) hz.leaning = true;
    const wires = peak(use, 'powerLines', 'yes', spatial);
    if (wires.p >= T.powerLines) hz.powerLines = true;
    else if (wires.p >= T.powerLinesMaybe) observations.push(`Possible power lines in photo ${wires.at + 1}: check clearance before quoting.`);
    const over = peak(use, 'proximity', 'overHouse', spatial);
    const near = peak(use, 'proximity', 'nearStructure', spatial);
    if (over.p >= T.overHouse) hz.overHouse = true;
    else if (near.p >= T.nearStructure) hz.nearStructure = true;
    const fence = peak(use, 'fence', 'yes', spatial);
    if (fence.p >= T.fence) hz.fenceGarden = true;
    confs.push(top(cond)[1]);

    // roads, vehicles, slope, brush: added as job conditions only when clear in the photos
    const cnt = mix(use, 'count', spatial) || {};
    const road = peak(use, 'road', 'yes', spatial);
    const cars = peak(use, 'vehicles', 'yes', spatial);
    const slope = mix(use, 'slope', spatial) || {};
    const brushQ = peak(use, 'brush', 'dense', spatial);
    const cnd = {};
    if (road.p >= T.road) cnd.nearRoad = true;
    if (cars.p >= T.vehicles) cnd.vehicles = true;
    if ((slope.steep || 0) >= T.slope) cnd.steepSlope = true;
    if (brushQ.p >= T.denseBrush) cnd.denseBrush = true;

    const [acc, accP] = top(access);
    const [cntK, cntP] = top(cnt);
    const tree = { work, species: speciesName, heightFt, dbhIn: 0, qty: cntK === 'few' && cntP >= T.few ? 2 : 1 };
    if (cntK !== 'one') observations.push(cntK === 'few' ? 'Looks like 2–3 trees: set the number of trees to quote.' : 'Several trees in view: add a row for each tree you are quoting.');

    // the estimator's notes always win over what the photos suggest
    const nt = parsed.tree?.trees?.[0] || {};
    for (const k of ['work', 'species', 'heightFt', 'dbhIn', 'qty']) if (nt[k] !== undefined && nt[k] !== '') tree[k] = nt[k];
    if (nt.heightFt) drop(missing, 'tree height (rough guess from the photo)');
    if (nt.dbhIn) drop(missing, 'trunk diameter');
    if (nt.species) drop(missing, 'species');
    out.tree = {
      trees: [tree],
      access: parsed.tree?.access || (accP >= T.access ? acc : undefined),
      method: parsed.tree?.method,
      debris: parsed.tree?.debris,
      trimLevel: parsed.tree?.trimLevel,
      stumps: parsed.tree?.stumps || undefined,
      restore: parsed.tree?.restore || undefined,
      firewood: parsed.tree?.firewood || undefined,
      hazards: { ...hz, ...(parsed.tree?.hazards || {}) },
    };
    for (const k of Object.keys(out.tree)) if (out.tree[k] === undefined) delete out.tree[k];
    out.conditions = cnd;

    // structured measurements with honest confidence
    const H = work === 'stump' ? null : nt.heightFt ? { low: nt.heightFt, high: nt.heightFt, conf: 1 } : rangeOf(size, HEIGHT_RANGE);
    const sp0 = tree.species;
    const dLo = nt.dbhIn || (H ? Math.round(estimateDbh(H.low, sp0) * 0.8) : 0);
    const dHi = nt.dbhIn || (H ? Math.round(estimateDbh(H.high, sp0) * 1.2) : 0);
    const dConf = nt.dbhIn ? 1 : H ? H.conf * 0.6 : null;
    const q = tree.qty;
    const vol = (h, d) => ((h * d) / 60) * q;
    const A = [];
    A.push(item('count', 'Number of trees', { one: '1', few: '2–3', many: '4 or more' }[cntK] || '1', cntP, cntK === 'many' ? 'Only the trees you are quoting count.' : ''));
    A.push(item('species', 'Species', tree.species ? cap(tree.species) : 'Not identifiable', tree.species ? (nt.species ? 1 : spP) : spP, sp2 && !nt.species ? `Next most likely: ${SPECIES_WORD[sp2[0]]}` : ''));
    if (H) A.push(item('height', 'Tree height', H.low === H.high ? `${H.low} ft` : `About ${fmtRange(H.low, H.high, ' ft')}`, H.conf, nt.heightFt ? 'From your notes.' : 'Estimated against the house, cars or people in view.'));
    if (H) A.push(item('dbh', 'Trunk diameter', dLo === dHi ? `${dLo} in` : `About ${fmtRange(dLo, dHi, ' in')}`, dConf, nt.dbhIn ? 'From your notes.' : 'Worked out from height and species. Measure at chest height.'));
    if (H) A.push(item('branch', 'Largest branches', `About ${fmtRange(dLo * 0.3, dHi * 0.5, ' in')}`, dConf === null ? null : dConf * 0.8, 'Rough rule: 30–50% of the trunk.'));
    A.push(item('condition', 'Condition', fallen ? 'Fallen / storm damaged' : { healthy: 'Healthy', dead: 'Dead or dying', bare: 'No leaves (season or dead: check)', storm: 'Storm damaged' }[ck] || 'Unknown', fallen ? form.fallen : cp));
    A.push(item('lean', 'Lean direction', hz.leaning ? 'Leaning: direction can\'t be judged from a photo' : 'Can\'t be judged from a photo', null, 'Check on site which way it leans and what is in its path.'));
    A.push(item('buildings', 'Near buildings', hz.overHouse ? 'Over the house' : yesNo(Math.max(over.p, near.p), 'Yes', 'No'), Math.max(over.p, near.p) >= 0.5 ? Math.max(over.p, near.p) : 1 - Math.max(over.p, near.p)));
    A.push(item('powerLines', 'Near power lines', yesNo(wires.p, 'Yes', 'Not seen'), wires.p >= 0.5 ? wires.p : 1 - wires.p, wires.p >= T.powerLinesMaybe && wires.p < T.powerLines ? 'Possible: check on site.' : ''));
    A.push(item('road', 'Next to a road', yesNo(road.p, 'Yes', 'No'), road.p >= 0.5 ? road.p : 1 - road.p));
    A.push(item('vehicles', 'Vehicles nearby', yesNo(cars.p, 'Yes', 'No'), cars.p >= 0.5 ? cars.p : 1 - cars.p));
    const yard = { backyard: 'Backyard', driveway: 'Front yard / driveway', open: 'Open area', tight: 'Tight space between buildings' }[acc] || 'Unknown';
    A.push(item('yard', 'Where', yard, accP));
    const hard = (acc === 'tight' ? 2 : acc === 'backyard' ? 1 : 0) + (cnd.steepSlope ? 1 : 0) + (cnd.vehicles ? 0.5 : 0);
    A.push(item('access', 'Access difficulty', hard >= 2 ? 'Difficult' : hard >= 1 ? 'Moderate' : 'Easy', accP * 0.8));
    A.push(item('gate', 'Gate width', 'Can\'t be measured from a photo', null, acc === 'backyard' ? 'Measure it: spider lifts need about 36 in.' : ''));
    A.push(item('slope', 'Terrain / slope', (slope.steep || 0) >= 0.5 ? 'Sloped' : 'Flat', Math.max(slope.steep || 0, slope.flat || 0)));
    if (H && work !== 'trim') {
      A.push(item('brushVol', 'Brush', `About ${fmtRange(vol(H.low, dLo) * 0.4, vol(H.high, dHi) * 0.4, ' yd³')}`, dConf * 0.8, cnd.denseBrush ? 'Dense brush in view.' : ''));
      A.push(item('logVol', 'Logs / wood', `About ${fmtRange(vol(H.low, dLo) * 0.6, vol(H.high, dHi) * 0.6, ' yd³')}`, dConf * 0.8));
      A.push(item('debris', 'Total debris', `About ${fmtRange(vol(H.low, dLo), vol(H.high, dHi), ' yd³')}`, dConf * 0.8));
    }
    if (work === 'remove' || work === 'stump') A.push(item('stump', 'Stump size', dLo ? `About ${fmtRange(dLo * 1.15, dHi * 1.3, ' in')} across` : 'Measure on site', dLo ? dConf * 0.8 : null, 'Stumps flare wider than the trunk.'));
    out.analysis = A;

    if (fallen) observations.push('Looks like a fallen or storm-damaged tree. Turn on Emergency if this is an urgent call.');
    if (hz.dead && !fallen) observations.push('Tree looks dead or dying. Inspect before climbing; an aerial lift or crane may be safer.');
    if (tree.work === 'remove' && !out.tree.stumps) upsells.push({ label: 'Stump grinding', reason: 'A removal leaves a stump in the yard.', action: 'stumps', work: 'remove', species: '', heightFt: 0, dbhIn: 0 });
    observations.push('On-device AI gives rough estimates. Check height and trunk size on site.');

    // per-photo captions
    out.photoCaptions = results.map((ph) => {
      if (!ph?.probs) return 'Could not read this photo';
      const p = ph.probs;
      if ((p.scene?.other || 0) >= T.other) return 'Not a job photo?';
      const [f] = top(p.form);
      const [s, sP] = top(p.species);
      const name = sP >= T.species ? SPECIES_WORD[s] : 'tree';
      if (f === 'stump') return 'Tree stump';
      if (f === 'closeup') return `Close-up${sP >= T.species ? `: looks like ${name}` : ''}`;
      const [sz] = top(p.size);
      const sizeWord = { 15: 'Small', 30: 'Medium', 50: 'Tall', 75: 'Very tall' }[sz] || '';
      const [c] = top(p.condition);
      const condWord = f === 'fallen' ? 'fallen' : { dead: 'looks dead', storm: 'storm damage', bare: 'no leaves', healthy: 'looks healthy' }[c];
      const [px, pxP] = top(p.proximity);
      const where = pxP >= 0.5 ? { overHouse: 'over the house', nearStructure: 'next to a building' }[px] : '';
      return [`${sizeWord} ${name}`.trim(), condWord, where].filter(Boolean).join(', ');
    });

    const verb = { remove: 'safely remove', trim: 'prune and shape', stump: 'grind the stump of', cable: 'install support cabling in' }[tree.work];
    const careful = [hz.overHouse || hz.nearStructure ? 'working carefully around the house' : '', hz.powerLines ? 'keeping clear of the power lines' : ''].filter(Boolean).join(' and ');
    out.customerSummary = `We will ${verb} the ${tree.species ? tree.species + ' ' : ''}tree${careful ? `, ${careful}` : ''}, and clean up the work area.`;
  } else {
    const isSnow = (ph) => ph.probs.scene?.snow || 0;
    const surface = mix(use, 'surface', isSnow) || {};
    const area = mix(use, 'area', isSnow) || {};
    const depth = mix(use, 'depth', isSnow) || {};
    const ice = peak(use, 'ice', 'yes', isSnow);
    const walks = peak(use, 'walks', 'yes', isSnow);
    const cars = mix(use, 'cars', isSnow) || {};
    const sType = mix(use, 'snowType', isSnow) || {};
    const piles = peak(use, 'piles', 'yes', isSnow);
    const tight = peak(use, 'tight', 'yes', isSnow);

    const lotP = (area['10000'] || 0) + (area['40000'] || 0);
    const commercial = (surface.lot || 0) >= T.lot || lotP >= 0.6;
    const s = { property: commercial ? 'commercial' : 'residential' };
    const pick = (keys) => keys.reduce((a, k) => ((area[k] || 0) > (area[a] || 0) ? k : a), keys[0]);
    s.areaSqft = +(commercial ? pick(['10000', '40000']) : pick(['500', '1000', '2500']));
    if (!commercial || top(area)[1] < 0.5) missing.push(commercial ? 'lot size' : 'driveway size');
    if ((surface.roof || 0) >= T.roof) s.roofSqft = 1200;
    if (walks.p >= T.walks || (surface.sidewalk || 0) >= T.sidewalk) s.walkLf = commercial ? 150 : 60;
    const [d, dP] = top(depth);
    if (dP >= T.depth) s.depthIn = +d;
    else missing.push('snow depth');
    if (ice.p >= T.ice) { s.salt = true; observations.push(`Ice visible in photo ${ice.at + 1}: salt included.`); }
    if (commercial && (cars.many || 0) >= T.cars) s.obstacles = 'high';
    confs.push(top(surface)[1]);

    const cnd = {};
    const [stK, stP] = top(sType);
    if ((sType.wet || 0) >= T.heavySnow) cnd.heavySnow = true;
    if (ice.p >= T.ice) cnd.ice = true;
    if (piles.p >= T.piles) cnd.snowPiles = true;
    if (tight.p >= T.tight) cnd.tightAreas = true;
    out.conditions = cnd;

    // notes win
    Object.assign(s, parsed.snow || {});
    if (parsed.snow?.areaSqft) { drop(missing, 'lot size'); drop(missing, 'driveway size'); }
    if (parsed.snow?.depthIn) drop(missing, 'snow depth');
    out.snow = s;

    const AR = parsed.snow?.areaSqft ? { low: s.areaSqft, high: s.areaSqft, conf: 1 } : rangeOf(Object.fromEntries(Object.entries(area).filter(([k]) => (commercial ? +k >= 10000 : +k < 10000))), Object.fromEntries(Object.entries(AREA_RANGE).filter(([k]) => (commercial ? +k >= 10000 : +k < 10000))));
    if (!parsed.snow?.areaSqft) AR.conf *= commercial ? lotP : 1 - lotP;
    const DR = parsed.snow?.depthIn ? { low: s.depthIn, high: s.depthIn, conf: 1 } : rangeOf(depth, DEPTH_RANGE);
    const wl = s.walkLf ? (commercial ? [100, 250] : [40, 80]) : null;
    const A = [];
    A.push(item('area', 'Paved area', AR.low === AR.high ? `${AR.low.toLocaleString()} sq ft` : `About ${fmtRange(AR.low, AR.high, ' sq ft')}`, AR.conf, parsed.snow?.areaSqft ? 'From your notes.' : 'Hard to judge from photos: measure or use a map.'));
    A.push(item(commercial ? 'lot' : 'driveway', commercial ? 'Parking lot size' : 'Driveway size', commercial ? (AR.high > 20000 ? 'Large lot' : 'Small lot') : { 500: 'Single car', 1000: 'Two car', 2500: 'Long driveway' }[pick(['500', '1000', '2500'])], commercial ? lotP : 1 - lotP));
    if (commercial) A.push(item('spaces', 'Parking spaces', `About ${fmtRange(AR.low / 320, AR.high / 320, '')}`, AR.conf, 'Paved area ÷ 320 sq ft per space incl. drive lanes.'));
    A.push(item('walks', 'Sidewalk length', wl ? `About ${fmtRange(wl[0], wl[1], ' ft')}` : 'None seen', wl ? Math.max(walks.p, surface.sidewalk || 0) : 1 - walks.p, 'Pace it out on site.'));
    A.push(item('depth', 'Snow depth', DR.low === DR.high ? `${DR.low} in` : `About ${fmtRange(DR.low, DR.high, ' in')}`, DR.conf, parsed.snow?.depthIn ? 'From your notes.' : 'Use a ruler or the forecast.'));
    A.push(item('snowType', 'Snow type', { powder: 'Light / powder', wet: 'Heavy / wet', packed: 'Packed / icy' }[stK] || 'Unknown', stP));
    A.push(item('ice', 'Ice', yesNo(ice.p, 'Ice visible', 'No ice seen'), ice.p >= 0.5 ? ice.p : 1 - ice.p));
    A.push(item('piles', 'Existing snow piles', yesNo(piles.p, 'Yes', 'No'), piles.p >= 0.5 ? piles.p : 1 - piles.p));
    const diff = (cnd.tightAreas ? 1 : 0) + (cnd.snowPiles ? 0.5 : 0) + ((cars.many || 0) >= T.cars ? 1 : 0) + (cnd.heavySnow ? 0.5 : 0);
    A.push(item('difficulty', 'Plowing difficulty', diff >= 1.5 ? 'Difficult' : diff >= 0.5 ? 'Moderate' : 'Easy', 0.5));
    A.push(item('entrances', 'Entrances', 'Can\'t be counted from a photo', null, 'Count driveway and lot entrances on site.'));
    A.push(item('obstacles', 'Obstacles (parked cars)', commercial ? yesNo(cars.many || 0, 'Many cars', 'Few cars') : 'Driveway', commercial ? Math.max(cars.many || 0, cars.few || 0) : null));
    A.push(item('tight', 'Tight areas', yesNo(tight.p, 'Yes', 'No'), tight.p >= 0.5 ? tight.p : 1 - tight.p));
    out.analysis = A;
    if (!s.salt) upsells.push({ label: 'Salt / de-ice every visit', reason: 'Prevents slip-and-falls after plowing.', action: 'salt', work: 'remove', species: '', heightFt: 0, dbhIn: 0 });
    if (s.property === 'commercial') upsells.push({ label: 'Seasonal contract', reason: 'Commercial lots usually need service all winter.', action: 'seasonal', work: 'remove', species: '', heightFt: 0, dbhIn: 0 });
    observations.push('On-device AI gives rough estimates. Check the paved area on site.');

    out.photoCaptions = results.map((ph) => {
      if (!ph?.probs) return 'Could not read this photo';
      const p = ph.probs;
      if ((p.scene?.other || 0) >= T.other) return 'Not a job photo?';
      const [sf] = top(p.surface);
      const [dd, ddP] = top(p.depth);
      const what = { driveway: 'Snowy driveway', lot: 'Snowy parking lot', sidewalk: 'Snowy sidewalk', roof: 'Snow on the roof', street: 'Snowy street' }[sf] || 'Snow';
      const deep = ddP >= T.depth ? { 1: 'light dusting', 4: 'a few inches', 10: 'deep snow', 18: 'very deep drifts' }[dd] : '';
      return [what, deep, (p.ice?.yes || 0) >= T.ice ? 'icy' : ''].filter(Boolean).join(', ');
    });
    out.customerSummary = `We will clear your ${s.property === 'commercial' ? 'parking lot' : 'driveway'}${s.walkLf ? ' and walkways' : ''}${s.roofSqft ? ', remove snow from the roof' : ''}${s.salt ? ' and treat icy areas with salt' : ''}.`;
  }

  const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
  out.confidence = avg >= 0.7 ? 'high' : avg >= 0.5 ? 'medium' : 'low';
  const failed = results.filter((r) => r?.error).length;
  if (failed) observations.unshift(`${failed} photo${failed > 1 ? 's' : ''} could not be read and ${failed > 1 ? 'were' : 'was'} skipped.`);
  return out;
}
