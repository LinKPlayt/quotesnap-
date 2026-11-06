// QuoteSnap estimating engine. Pure functions, no DOM: safe to unit test with node.
// Parses job descriptions, builds the scope of work and good/better/best customer options.
// The resource-aware time and cost planning lives in js/planner.js.

import { DEFAULT_PRICEBOOK } from './pricebook.js';
import { DEFAULT_MULTIPLIERS } from './company.js';
import { SPECIES, HAZARDS, DEBRIS, speciesFactor, estimateDbh, recommendMethod, calcTree, calcSnow } from './planner.js';

export { SPECIES, speciesFactor, estimateDbh, recommendMethod, calcTree, calcSnow };

const NUMBER_WORDS = { one: 1, a: 1, an: 1, single: 1, two: 2, pair: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// ---------- helpers ----------

const r2 = (n) => Math.round(n * 100) / 100;
const roundUp = (n, step) => (step > 0 ? Math.ceil(n / step) * step : Math.round(n));
export const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- natural language parsing ----------

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/;
const SUFFIX = 'St|Street|Rd|Road|Ave|Avenue|Ln|Lane|Dr|Drive|Ct|Court|Blvd|Boulevard|Way|Pl|Place|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Trl|Trail|Pike|Loop';
const STREET_RE = new RegExp(`\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z0-9][\\w']*\\s+){1,3}(?:${SUFFIX}|${SUFFIX.toLowerCase()})\\b\\.?(?:,\\s*[A-Z][a-z]+(?:\\s[A-Z][a-z]+)?)?(?:,?\\s*[A-Z]{2}\\b)?(?:\\s+\\d{5})?`);
const NAME_RES = [
  /\b(?:[Cc]ustomer|[Cc]lient|[Hh]omeowner|[Oo]wner|[Nn]ame)(?:'s name)?\s*(?:is|:|-)?\s*((?:Mr|Mrs|Ms|Dr)\.?\s+)?([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){0,2})/,
  /\b(?:[Ff]or|[Cc]all|[Mm]eet(?:ing)?(?: with)?)\s+((?:Mr|Mrs|Ms|Dr)\.?\s+)?([A-Z][a-z'’-]+\s+[A-Z][a-z'’-]+)/,
  /\b(Mr|Mrs|Ms|Dr)\.?\s+([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)?)/,
];
const NOT_NAMES = /^(Tree|Oak|Maple|Pine|Snow|Remove|Removal|Trim|Backyard|Front|Stump|The|This|That|Job|Quote|Power|Bucket|Crane)\b/;

// Pull customer contact details out of free text (voice notes, typed notes).
export function parseCustomer(text = '') {
  const c = {};
  const phone = text.match(PHONE_RE);
  if (phone) c.phone = `${phone[1]}-${phone[2]}-${phone[3]}`;
  const email = text.match(EMAIL_RE);
  if (email) c.email = email[0];
  const street = text.match(STREET_RE);
  if (street) c.address = street[0].replace(/\s+/g, ' ').replace(/[.,]$/, '').trim();
  for (const re of NAME_RES) {
    const m = text.match(re);
    if (m && m[2] && !NOT_NAMES.test(m[2])) { c.name = ((m[1] || '') + m[2]).trim(); break; }
  }
  return c;
}

export function parseDescription(text = '') {
  const customer = parseCustomer(text);
  // strip contact details so phone digits / house numbers don't read as heights or depths
  let clean = text;
  for (const re of [PHONE_RE, EMAIL_RE, STREET_RE]) clean = clean.replace(new RegExp(re.source, 'g'), ' ');
  const t = ' ' + clean.toLowerCase().replace(/[’']/g, "'") + ' ';
  const out = { division: null, tree: {}, snow: {}, flags: {}, customer };

  const snowWords = /\b(snow|plow|plowing|shovel|shoveling|salt|salting|de-?ice|ice melt|blizzard|roof rake|parking lot)\b/;
  const treeWords = /\b(tree|oak|maple|pine|stump|limb|branch|trim|prune|removal|remove|arborist|canopy|spruce|ash|elm|cable)\b/;
  out.division = snowWords.test(t) && !treeWords.test(t) ? 'snow' : treeWords.test(t) ? 'tree' : snowWords.test(t) ? 'snow' : null;

  // "storm" is an emergency for tree work (storm damage), but every snow job follows a storm
  const stormEmergency = out.division !== 'snow' && /\bstorm\b/.test(t);
  if (stormEmergency || /\b(emergency|after hours|asap|urgent|fell on|fallen on)\b/.test(t)) out.flags.emergency = true;
  if (/\bpermit\b/.test(t)) out.flags.permit = true;
  const miles = t.match(/(\d+(?:\.\d+)?)\s*(?:miles?|mi)\b/);
  if (miles) out.flags.miles = +miles[1];

  // ---- tree ----
  const height = t.match(/(\d{1,3})\s*(?:-|\s)?\s*(?:foot|feet|ft\b|')/);
  const dbh = t.match(/(\d{1,3})\s*(?:-|\s)?\s*(?:inch|inches|in\b|")\s*(?:dbh|diameter|trunk|wide|across)?/);
  const dbh2 = t.match(/(?:dbh|diameter|trunk)\s*(?:of|is|:)?\s*(\d{1,3})/);
  const speciesHit = Object.keys(SPECIES).sort((a, b) => b.length - a.length).find((k) => new RegExp('\\b' + k + 's?\\b').test(t));
  let qty = 1;
  const qtyM = t.match(/\b(\d+|one|a|an|single|two|pair|couple|three|four|five|six|seven|eight|nine|ten)\s+(?:of\s+)?(?:\d{1,3}\s*(?:-|\s)?\s*(?:foot|feet|ft|')\s+)?(?:[a-z]+\s+){0,2}(?:trees|oaks|maples|pines|spruces|ashes|elms|stumps|cedars|firs|birches|willows)\b/);
  if (qtyM) qty = +qtyM[1] || NUMBER_WORDS[qtyM[1]] || 1;

  let work = null;
  if (/\b(remov|take down|cut down|fell|drop the|takedown)/.test(t)) work = 'remove';
  else if (/\b(trim|prun|thin|raise|crown|deadwood|deadwooding|shape|clearance)/.test(t)) work = 'trim';
  else if (/\bcabl|brac/.test(t)) work = 'cable';
  else if (/\bstump/.test(t)) work = 'stump';

  if (out.division !== 'snow') {
    const tree = {};
    if (work) tree.work = work;
    if (height) tree.heightFt = +height[1];
    if (dbh2) tree.dbhIn = +dbh2[1];
    else if (dbh && (!height || dbh.index !== height.index)) tree.dbhIn = +dbh[1];
    if (speciesHit) tree.species = speciesHit;
    if (qtyM) tree.qty = qty;
    out.tree.trees = [tree];

    if (/\b(no access|tight access|no equipment|hand ?carry|narrow gate|between houses|landlocked)\b/.test(t)) out.tree.access = 'tight';
    else if (/\b(back ?yard|rear yard|behind the house|fenced|through (?:the )?gate)\b/.test(t)) out.tree.access = 'backyard';
    else if (/\b(front ?yard|street|curb|roadside|driveway)\b/.test(t)) out.tree.access = 'driveway';
    else if (/\b(open|field|lot|pasture)\b/.test(t)) out.tree.access = 'open';

    const hz = {};
    if (/\b(power ?lines?|utility lines?|service drop|primary lines?|wires?)\b/.test(t)) hz.powerLines = true;
    if (/\b(over (?:the )?(?:house|home|roof)|overhang\w* (?:the )?(?:house|roof)|on (?:the )?roof|fell on)\b/.test(t)) hz.overHouse = true;
    if (/\b(house|home|garage|shed|structure|building|deck|pool)\b/.test(t) && !hz.overHouse) hz.nearStructure = true;
    if (/\b(dead|decay\w*|rot\w*|hollow|ash borer|diseased|dying)\b/.test(t)) hz.dead = true;
    if (/\b(lean\w*|storm|split|cracked|hanger|hanging|uprooted)\b/.test(t)) hz.leaning = true;
    if (/\b(fence|garden|landscap\w*|flower beds?|patio)\b/.test(t)) hz.fenceGarden = true;
    out.tree.hazards = hz;

    if (/\bcrane\b/.test(t)) out.tree.method = 'crane';
    else if (/\bbucket\b|\baerial lift\b/.test(t)) out.tree.method = 'bucket';
    else if (/\b(spider lift|tracked lift|towable lift)\b/.test(t)) out.tree.method = 'lift';
    else if (/\bclimb/.test(t)) out.tree.method = 'climb';

    if (/\b(leave (?:the )?(?:wood|logs)|keep (?:the )?(?:wood|logs)|firewood)\b/.test(t)) out.tree.debris = 'chipLeaveLogs';
    if (/\b(leave (?:all|everything|debris)|no cleanup|no clean up)\b/.test(t)) out.tree.debris = 'leave';
    if (/\b(haul|remove all|clean ?up|take everything)\b/.test(t)) out.tree.debris = 'haul';
    if (/\bfirewood\b/.test(t)) out.tree.firewood = true;
    if (/\bstump\s*(?:grind|removal|ground)|grind\w*\s+(?:the\s+)?stump/.test(t) || work === 'stump') out.tree.stumps = true;
    if (/\b(seed|restore|topsoil|backfill)\b/.test(t)) out.tree.restore = true;
    if (/\b(light trim|light prune|deadwood)/.test(t)) out.tree.trimLevel = 'light';
    if (/\b(heavy|reduction|crown reduction|major)\b/.test(t) && work === 'trim') out.tree.trimLevel = 'heavy';
  }

  // ---- snow ----
  if (out.division === 'snow') {
    const s = {};
    const sq = t.match(/([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:sq\.?\s*ft|sqft|square feet|sf)\b/);
    if (sq) s.areaSqft = +sq[1].replace(/,/g, '') * (sq[2] ? 1000 : 1);
    const cars = t.match(/\b(\d|one|two|three|four)\s*-?\s*car\b/);
    if (!s.areaSqft && cars) s.areaSqft = (+cars[1] || NUMBER_WORDS[cars[1]] || 2) * 500;
    const spaces = t.match(/(\d+)\s*(?:parking )?(?:spaces|spots|stalls)/);
    if (!s.areaSqft && spaces) s.areaSqft = +spaces[1] * 320;
    const depth = t.match(/(\d{1,2})\s*(?:-|\s)?\s*(?:inch|inches|in\b|")/);
    if (depth) s.depthIn = +depth[1];
    const walks = t.match(/(\d+)\s*(?:linear\s*)?(?:ft|feet|')\s*(?:of\s*)?(?:side)?walks?/);
    if (walks) s.walkLf = +walks[1];
    else if (/\b(walk|walkway|sidewalk|steps|stairs|path)\b/.test(t)) s.walkLf = 60;
    const roof = t.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|square feet)\s*(?:of\s*)?roof/);
    if (/\broof\b/.test(t)) s.roofSqft = roof ? +roof[1].replace(/,/g, '') : 1200;
    if (/\b(parking lot|commercial|plaza|business|church|office|retail|hoa|apartment)\b/.test(t)) s.property = 'commercial';
    else if (/\b(driveway|residential|home|house)\b/.test(t)) s.property = 'residential';
    if (/\b(salt|de-?ice|ice melt|treat)/.test(t)) s.salt = true;
    if (/\bskid ?steer|pusher|loader\b/.test(t)) s.method = 'skid';
    else if (/\bplow/.test(t)) s.method = 'plow';
    else if (/\bblower\b/.test(t)) s.method = 'blower';
    else if (/\bshovel/.test(t) && !/\bplow/.test(t)) s.method = 'shovel';
    if (/\b(seasonal|season|contract|all winter|per season)\b/.test(t)) s.contract = 'seasonal';
    if (/\b(priority|24\/7|first|before 7|before opening)\b/.test(t)) s.priority = true;
    if (/\b(islands|curbs|cars parked|tight|obstacles|many cars)\b/.test(t)) s.obstacles = 'high';
    out.snow = s;
  }
  return out;
}

// Merge parsed fields into a job.
// - locks: { 'job.tree.access': true, ... } fields the estimator set by hand; never overwritten.
// - parsed.replace (AI results): booleans can be switched off and the tree list is replaced.
//   Without it (notes parsing) fields are only added, never removed.
export function applyParsed(job, parsed, locks = {}) {
  const j = structuredClone(job);
  const free = (path) => !locks[path];
  const rep = !!parsed.replace;
  const f = parsed.flags || {};
  if (parsed.division && free('job.division')) j.division = parsed.division;
  if (free('job.emergency') && (rep ? typeof f.emergency === 'boolean' : f.emergency)) j.emergency = !!f.emergency;
  if (free('job.permit') && f.permit) j.permit = true;
  if (free('job.miles') && f.miles) j.miles = f.miles;
  const division = parsed.division || j.division;

  const p = parsed.tree || {};
  if (division === 'tree') {
    if (p.trees && p.trees.length) {
      const old = j.tree.trees;
      const rows = p.trees.map((t, i) => {
        const row = { ...newTree(), ...(old[i] || {}) };
        for (const [k, v] of Object.entries(t)) if (v !== undefined && v !== null && v !== '' && free(`job.tree.trees.${i}.${k}`)) row[k] = v;
        return row;
      });
      // keep extra rows the estimator added (always for notes; for AI only if they edited them)
      old.slice(p.trees.length).forEach((row, k) => {
        const i = k + p.trees.length;
        if (!rep || Object.keys(locks).some((l) => l.startsWith(`job.tree.trees.${i}.`))) rows.push(row);
      });
      j.tree.trees = rows;
    }
    for (const k of ['access', 'method', 'debris', 'trimLevel']) if (p[k] && free(`job.tree.${k}`)) j.tree[k] = p[k];
    for (const k of ['firewood', 'stumps', 'restore']) {
      if (!free(`job.tree.${k}`)) continue;
      if (rep ? typeof p[k] === 'boolean' : p[k]) j.tree[k] = !!p[k];
    }
    for (const [k, v] of Object.entries(p.hazards || {})) {
      if (!free(`job.tree.hazards.${k}`)) continue;
      if (rep ? typeof v === 'boolean' : v) j.tree.hazards[k] = !!v;
    }
  }
  if (division === 'snow') {
    for (const [k, v] of Object.entries(parsed.snow || {})) if (v !== undefined && v !== null && free(`job.snow.${k}`)) j.snow[k] = v;
  }
  for (const [k, v] of Object.entries(parsed.conditions || {})) {
    if (!free(`job.conditions.${k}`)) continue;
    if (rep ? typeof v === 'boolean' : v) (j.conditions ||= {})[k] = !!v;
  }
  return j;
}

// Human-readable list of what changed between two jobs (for the "AI filled this in" review).
const FIELD_LABELS = {
  'job.division': 'Job type', 'job.emergency': 'Emergency', 'job.permit': 'Permit', 'job.miles': 'Distance',
  'job.tree.access': 'Access', 'job.tree.method': 'Equipment', 'job.tree.debris': 'Debris', 'job.tree.trimLevel': 'Trim level',
  'job.tree.stumps': 'Stump grinding', 'job.tree.restore': 'Lawn restore', 'job.tree.firewood': 'Firewood',
  'job.snow.property': 'Property', 'job.snow.areaSqft': 'Paved area', 'job.snow.walkLf': 'Sidewalks', 'job.snow.roofSqft': 'Roof snow',
  'job.snow.depthIn': 'Snow depth', 'job.snow.method': 'Equipment', 'job.snow.salt': 'Salt', 'job.snow.obstacles': 'Obstacles',
  'job.snow.priority': 'Priority', 'job.snow.contract': 'Quote as',
};
const TREE_KEYS = { work: 'work', species: 'species', heightFt: 'height', dbhIn: 'trunk', qty: 'qty' };
const VALUE_LABELS = {
  open: 'Open', driveway: 'Driveway / street', backyard: 'Backyard gate', tight: 'Tight – no equipment',
  auto: 'Auto', bucket: 'Bucket truck', crane: 'Crane', lift: 'Spider lift', climb: 'Climb & rig',
  haul: 'Haul everything', chipLeaveLogs: 'Haul brush, leave wood', leave: 'Leave on site',
  remove: 'Remove', trim: 'Trim', stump: 'Stump', cable: 'Cable', tree: 'Tree', snow: 'Snow',
  plow: 'Plow truck', skid: 'Skid steer', blower: 'Snow blower', shovel: 'Shovel crew',
  residential: 'Residential', commercial: 'Commercial', low: 'Few', med: 'Some', high: 'Many', perPush: 'Per push', seasonal: 'Seasonal',
  light: 'Light', standard: 'Standard', heavy: 'Heavy',
};
const UNITS = { heightFt: ' ft', dbhIn: '"', 'job.snow.areaSqft': ' sq ft', 'job.snow.walkLf': ' ft', 'job.snow.roofSqft': ' sq ft', 'job.snow.depthIn': '"', 'job.miles': ' mi' };

export function formatValue(v, unitKey) {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return v.toLocaleString() + (UNITS[unitKey] || '');
  return VALUE_LABELS[v] || (v ? cap(String(v)) : '—');
}

export function describeChanges(before, after) {
  const out = [];
  const add = (path, label, a, b, unitKey) => {
    if (a === b || (a == null && b === '') || (a === '' && b == null)) return;
    out.push({ path, label, from: formatValue(a, unitKey ?? path), to: formatValue(b, unitKey ?? path) });
  };
  for (const k of ['division', 'emergency', 'permit', 'miles']) add(`job.${k}`, FIELD_LABELS[`job.${k}`], before[k], after[k]);
  if (after.division === 'tree') {
    const n = Math.max(before.tree.trees.length, after.tree.trees.length);
    for (let i = 0; i < n; i++) {
      const a = before.tree.trees[i] || {};
      const b = after.tree.trees[i];
      if (!b) { out.push({ path: `job.tree.trees.${i}`, label: `Tree ${i + 1}`, from: 'listed', to: 'removed' }); continue; }
      for (const [k, word] of Object.entries(TREE_KEYS)) {
        if (k === 'dbhIn' && !b[k]) continue;
        add(`job.tree.trees.${i}.${k}`, `${n > 1 ? `Tree ${i + 1} ` : 'Tree '}${word}`, a[k], b[k], k);
      }
    }
    for (const k of ['access', 'method', 'debris', 'trimLevel', 'stumps', 'restore', 'firewood']) add(`job.tree.${k}`, FIELD_LABELS[`job.tree.${k}`], before.tree[k], after.tree[k]);
    for (const k of Object.keys(HAZARDS)) add(`job.tree.hazards.${k}`, HAZARDS[k].label, !!before.tree.hazards[k], !!after.tree.hazards[k]);
    for (const [k, c] of Object.entries(DEFAULT_MULTIPLIERS.conditions)) if (!HAZARDS[k] && c.division !== 'snow') add(`job.conditions.${k}`, c.label, !!before.conditions?.[k], !!after.conditions?.[k]);
  } else {
    for (const k of Object.keys(after.snow)) if (FIELD_LABELS[`job.snow.${k}`]) add(`job.snow.${k}`, FIELD_LABELS[`job.snow.${k}`], before.snow[k], after.snow[k]);
    for (const [k, c] of Object.entries(DEFAULT_MULTIPLIERS.conditions)) if (c.division !== 'tree') add(`job.conditions.${k}`, c.label, !!before.conditions?.[k], !!after.conditions?.[k]);
  }
  return out;
}

export const newTree = () => ({ work: 'remove', species: '', heightFt: 40, dbhIn: 0, qty: 1 });

export function newJob(division = 'tree') {
  return {
    division,
    description: '',
    emergency: false,
    storm: false,
    weekend: false,
    holiday: false,
    permit: false,
    miles: 0,
    property: 'residential', // tree jobs (snow jobs use snow.property)
    difficulty: 'normal',
    conditions: {},
    tree: {
      trees: [newTree()],
      access: 'driveway',
      hazards: {},
      method: 'auto',
      debris: 'haul',
      firewood: false,
      stumps: false,
      restore: false,
      trimLevel: 'standard',
    },
    snow: {
      property: 'residential',
      areaSqft: 1000,
      walkLf: 0,
      roofSqft: 0,
      depthIn: 4,
      method: 'auto',
      salt: false,
      obstacles: 'low',
      priority: false,
      contract: 'perPush',
      events: 0,
      haul: false,
    },
  };
}

export function calc(job, pb, opts) {
  return job.division === 'snow' ? calcSnow(job, pb, opts) : calcTree(job, pb, opts);
}

// ---------- scope of work ----------

export function scopeOfWork(job, est) {
  const lines = [];
  if (job.division === 'tree') {
    const c = est.config;
    for (const t of est.treeLines) {
      const desc = `${t.qty > 1 ? t.qty + ' × ' : ''}${t.heightFt ? t.heightFt + ' ft ' : ''}${t.species ? cap(t.species) : 'tree'}${t.dbhIn ? ` (~${t.dbhIn}" trunk)` : ''}`;
      if (t.work === 'remove') lines.push(`Remove ${desc} to as close to grade as practical using ${est.methodLabel.toLowerCase()}.`);
      if (t.work === 'trim') lines.push(`${cap(c.trimLevel)} pruning of ${desc}: remove dead, broken and crossing limbs; raise and clear canopy per ANSI A300 standards (no topping).`);
      if (t.work === 'cable') lines.push(`Install cabling & bracing system in ${desc} to reduce risk of limb/stem failure.`);
      if (t.work === 'stump') lines.push(`Grind ${t.qty > 1 ? t.qty + ' stumps' : 'stump'} (~${t.dbhIn}") 6–8" below grade.`);
    }
    if (c.hazards?.overHouse || c.hazards?.nearStructure) lines.push('Limbs and wood sections to be roped and lowered in a controlled manner to protect structures.');
    if (c.hazards?.powerLines) lines.push('Work near utility lines performed by qualified line-clearance personnel; utility coordination as required.');
    if (c.hazards?.fenceGarden) lines.push('Protect lawn, beds and fencing with ground mats and plywood.');
    if (est.treeLines.some((t) => t.work !== 'stump')) lines.push(DEBRIS[c.debris].label + '.');
    if (c.firewood) lines.push('Cut usable wood to firewood lengths (approx. 16").');
    if (c.stumps && est.treeLines.some((t) => t.work === 'remove')) lines.push(`Grind ${est.stumpCount > 1 ? est.stumpCount + ' stumps' : 'stump'} 6–8" below grade; utilities located before grinding.`);
    if (c.restore && est.stumpCount) lines.push('Backfill grindings area with topsoil, seed and straw.');
    lines.push('Rake and blow off all work areas; site left clean.');
  } else {
    const s = est.config;
    if (s.areaSqft > 0) lines.push(`Clear ${(+s.areaSqft).toLocaleString()} sq ft ${s.property === 'commercial' ? 'parking lot / drive lanes' : 'driveway'} using ${est.methodLabel.toLowerCase()}; snow stacked in designated areas.`);
    if (s.walkLf > 0) lines.push(`Clear ${s.walkLf} linear ft of sidewalks, steps and entrances.`);
    if (s.salt) lines.push(`Apply rock salt / ice melt to paved areas (approx. ${est.saltLbs} lb per application).`);
    if (s.roofSqft > 0) lines.push(`Remove snow load from ~${(+s.roofSqft).toLocaleString()} sq ft of roof; clear drop zone.`);
    lines.push(s.contract === 'seasonal'
      ? `Service triggered at 2" accumulation, unlimited pushes for the season${s.priority ? '; priority route (cleared before 7 AM)' : ''}.`
      : `Service triggered at 2" accumulation${s.priority ? '; priority route (cleared before 7 AM)' : ''}.`);
  }
  if (job.emergency) lines.unshift('Emergency / storm response service.');
  return lines;
}

// ---------- customer options (good / better / best) ----------

export function buildOptions(job, pb = DEFAULT_PRICEBOOK, marginPct, company) {
  const opts = { marginPct, company };
  if (job.division === 'tree') {
    const hasRemoval = job.tree.trees.some((t) => t.work === 'remove');
    if (!hasRemoval) {
      const e = calcTree(job, pb, opts);
      return [{ id: 'base', name: 'Recommended', est: e, scope: scopeOfWork(job, e), recommended: true }];
    }
    const variants = [
      { id: 'basic', name: 'Essential', blurb: 'Tree down, brush chipped, wood left for you.', override: { debris: 'chipLeaveLogs', stumps: false, restore: false, firewood: false } },
      { id: 'standard', name: 'Standard', blurb: 'Tree removed and everything hauled away.', override: { debris: 'haul', stumps: false, restore: false } },
      { id: 'complete', name: 'Complete', blurb: 'Removal, full haul-away, stump ground and lawn restored.', override: { debris: 'haul', stumps: true, restore: true } },
    ];
    const userKey = `${job.tree.debris}|${!!job.tree.stumps}|${!!job.tree.restore}`;
    const list = variants.map((v) => {
      const e = calcTree(job, pb, { ...opts, override: v.override });
      const key = `${e.config.debris}|${!!e.config.stumps}|${!!e.config.restore}`;
      return { ...v, est: e, scope: scopeOfWork(job, e), recommended: key === userKey, key };
    });
    if (!list.some((o) => o.recommended)) {
      const e = calcTree(job, pb, opts);
      list.push({ id: 'custom', name: 'As Specified', blurb: 'Exactly the work described.', est: e, scope: scopeOfWork(job, e), recommended: true });
    }
    return list.sort((a, b) => a.est.price - b.est.price);
  }
  const events = +job.snow.events || pb.snow.eventsPerSeason;
  const perPush = calcSnow(job, pb, { ...opts, override: { salt: false } });
  const withSalt = calcSnow(job, pb, { ...opts, override: { salt: true } });
  const seasonalTotal = roundUp(withSalt.price * events * (1 - pb.snow.seasonalDiscountPct / 100), 25);
  const seasonal = {
    ...withSalt,
    price: seasonalTotal,
    fullCost: r2(withSalt.fullCost * events),
    profit: r2(seasonalTotal - withSalt.fullCost * events),
    marginPct: r2(((seasonalTotal - withSalt.fullCost * events) / seasonalTotal) * 100),
    seasonal: true,
    events,
    monthly: roundUp(seasonalTotal / pb.snow.seasonMonths, 1),
  };
  const recommendedId = job.snow.contract === 'seasonal' ? 'seasonal' : job.snow.salt ? 'salt' : 'push';
  return [
    { id: 'push', name: 'Per Push', blurb: 'Pay only when it snows. Plow/clear per visit.', est: perPush, scope: scopeOfWork(job, perPush), unit: 'per visit', recommended: recommendedId === 'push' },
    { id: 'salt', name: 'Clear + Salt', blurb: 'Every visit cleared and treated for ice.', est: withSalt, scope: scopeOfWork(job, withSalt), unit: 'per visit', recommended: recommendedId === 'salt' },
    { id: 'seasonal', name: 'Seasonal Contract', blurb: `Unlimited service all winter (${events} events est.), ${pb.snow.seasonalDiscountPct}% off, ${money(seasonal.monthly)}/mo × ${pb.snow.seasonMonths}.`, est: seasonal, scope: scopeOfWork({ ...job, snow: { ...job.snow, contract: 'seasonal', salt: true } }, seasonal), unit: 'per season', recommended: recommendedId === 'seasonal' },
  ];
}

// Price per depth tier for snow quotes ("2–4 in: $X").
export function snowDepthTiers(job, pb = DEFAULT_PRICEBOOK, marginPct, company) {
  return [
    { label: '2–4"', depth: 3 },
    { label: '4–8"', depth: 6 },
    { label: '8–12"', depth: 10 },
    { label: '12"+', depth: 15 },
  ].map((t) => ({ ...t, price: calcSnow(job, pb, { marginPct, company, override: { depthIn: t.depth } }).price }));
}

// Totals for a chosen option with tax, discount and custom adjustments.
export function totals(price, { discount = 0, adjustments = [], taxPct = 0, depositPct = 0 } = {}) {
  const adj = (adjustments || []).reduce((s, a) => s + (+a?.amount || 0), 0);
  const subtotal = Math.max(0, (+price || 0) + adj - Math.max(0, +discount || 0));
  const tax = r2(subtotal * (Math.max(0, +taxPct || 0) / 100));
  const total = r2(subtotal + tax);
  return { adj, subtotal, tax, total, deposit: roundUp(total * (Math.min(100, Math.max(0, +depositPct || 0)) / 100), 1) };
}
