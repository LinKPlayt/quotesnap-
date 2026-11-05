// Turns the on-device model's per-photo scores into quote fields.
// Pure functions (no DOM), unit-tested in tests/localai.test.mjs.
//
// Input: one entry per photo, { probs: { questionId: { classId: probability } } }
// (see tools/local-ai-questions.json for the questions). Output: the same shape the cloud
// analyzer returns, so the existing review card, field outlines and undo all work unchanged.
// Only things the photos actually show are filled in; anything unsure is left alone and
// listed under "Please confirm". Notes typed or spoken by the estimator always win.

import { parseDescription } from '../engine.js';

// Probabilities needed before a field is filled in (tuned on hand-labeled test photos).
export const T = {
  stump: 0.55, hedge: 0.6, fallen: 0.55, deadTop: 0.4, deadSum: 0.65, species: 0.4, speciesSure: 0.6,
  powerLines: 0.65, powerLinesMaybe: 0.45, overHouse: 0.35, nearStructure: 0.6, leaning: 0.72, fence: 0.55, access: 0.4,
  lot: 0.45, roof: 0.5, sidewalk: 0.45, walks: 0.65, depth: 0.45, ice: 0.65, cars: 0.65, other: 0.6,
};

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

    const [acc, accP] = top(access);
    const tree = { work, species: speciesName, heightFt, dbhIn: 0, qty: 1 };

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

    // notes win
    Object.assign(s, parsed.snow || {});
    if (parsed.snow?.areaSqft) { drop(missing, 'lot size'); drop(missing, 'driveway size'); }
    if (parsed.snow?.depthIn) drop(missing, 'snow depth');
    out.snow = s;
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
