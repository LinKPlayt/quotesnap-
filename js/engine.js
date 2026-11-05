// QuoteSnap estimating engine. Pure functions, no DOM: safe to unit test with node.
// Turns a job description + a few fields into labor, equipment, materials, price,
// profit, scope of work and good/better/best customer options.

import { DEFAULT_PRICEBOOK } from './pricebook.js';

// ---------- reference data ----------

export const SPECIES = {
  oak: 1.2, 'white oak': 1.25, 'red oak': 1.2, hickory: 1.25, walnut: 1.2, locust: 1.3, 'honey locust': 1.3,
  beech: 1.2, maple: 1.1, 'sugar maple': 1.15, 'silver maple': 1.05, ash: 1.1, elm: 1.15, sycamore: 1.15,
  cherry: 1.05, birch: 1.0, 'sweet gum': 1.05, gum: 1.05, 'tulip poplar': 1.0, poplar: 0.95, cottonwood: 1.0,
  willow: 1.05, linden: 1.0, basswood: 0.95, mulberry: 1.15, 'black locust': 1.3, catalpa: 1.0, pecan: 1.2,
  pine: 0.95, 'white pine': 0.95, spruce: 0.9, fir: 0.9, hemlock: 0.95, cedar: 0.95, arborvitae: 0.8,
  cypress: 1.0, palm: 0.8, magnolia: 1.0, dogwood: 0.9, 'crab apple': 0.95, apple: 0.95, 'bradford pear': 1.0, pear: 1.0,
};

const NUMBER_WORDS = { one: 1, a: 1, an: 1, single: 1, two: 2, pair: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const ACCESS = {
  open:     { f: 1.0,  label: 'Open access – equipment can drive to the tree' },
  driveway: { f: 1.05, label: 'Driveway / street access' },
  backyard: { f: 1.3,  label: 'Backyard access through gate' },
  tight:    { f: 1.6,  label: 'Tight / no equipment access – all hand-carry' },
};

const HAZARDS = {
  powerLines:    { f: 0.35, label: 'Near power lines', safety: 'Power lines present: maintain minimum approach distance; utility drop/coordination may be required. Only qualified line-clearance workers within 10 ft.' },
  overHouse:     { f: 0.30, label: 'Over house / roof', safety: 'Canopy over structure: all limbs to be roped and lowered (rigging). No free-falling over roof.' },
  nearStructure: { f: 0.20, label: 'Near structure', safety: 'Structure in drop zone: sectional removal with controlled rigging.' },
  dead:          { f: 0.15, label: 'Dead / decayed', safety: 'Dead or decayed wood: inspect before climbing; aerial device or crane preferred over climbing.' },
  leaning:       { f: 0.15, label: 'Leaning / storm damaged', safety: 'Leaning or storm-loaded tree: assess tension/compression; establish exclusion zone.' },
  fenceGarden:   { f: 0.10, label: 'Fence / landscaping in drop zone', safety: 'Protect fence, beds and lawn with ground mats and plywood.' },
};

const METHOD = {
  crane: { f: 0.6,  label: 'Crane-assisted removal' },
  bucket:{ f: 0.75, label: 'Bucket truck' },
  lift:  { f: 0.85, label: 'Tracked spider lift' },
  climb: { f: 1.0,  label: 'Climbing & rigging' },
};

const DEBRIS = {
  haul:          { f: 0.30, label: 'Chip brush and haul away all wood and debris' },
  chipLeaveLogs: { f: 0.18, label: 'Chip and haul brush; cut wood left on site' },
  leave:         { f: 0.06, label: 'Leave all wood and brush on site' },
};

const TRIM = { light: 0.35, standard: 0.5, heavy: 0.7 };

const SNOW_PROD = { plow: 40000, skid: 30000, blower: 4000, shovel: 800 }; // sq ft per hour at 2"
const OBSTACLES = { low: 1.0, med: 1.2, high: 1.45 };

// ---------- helpers ----------

const r2 = (n) => Math.round(n * 100) / 100;
const roundUp = (n, step) => (step > 0 ? Math.ceil(n / step) * step : Math.round(n));
export const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

  const snowWords = /\b(snow|plow|plowing|shovel|shoveling|salt|salting|de-?ice|ice melt|blizzard|roof rake)\b/;
  const treeWords = /\b(tree|oak|maple|pine|stump|limb|branch|trim|prune|removal|remove|arborist|canopy|spruce|ash|elm|cable)\b/;
  out.division = snowWords.test(t) && !treeWords.test(t) ? 'snow' : treeWords.test(t) ? 'tree' : snowWords.test(t) ? 'snow' : null;

  if (/\b(emergency|storm|after hours|asap|urgent|fell on|fallen on)\b/.test(t)) out.flags.emergency = true;
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
  } else {
    for (const k of Object.keys(after.snow)) if (FIELD_LABELS[`job.snow.${k}`]) add(`job.snow.${k}`, FIELD_LABELS[`job.snow.${k}`], before.snow[k], after.snow[k]);
  }
  return out;
}

export const newTree = () => ({ work: 'remove', species: '', heightFt: 40, dbhIn: 0, qty: 1 });

export function newJob(division = 'tree') {
  return {
    division,
    description: '',
    emergency: false,
    permit: false,
    miles: 0,
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
    },
  };
}

// ---------- equipment recommendation ----------

export function recommendMethod(tree) {
  const reasons = [];
  if (tree.method && tree.method !== 'auto') {
    reasons.push(`${METHOD[tree.method].label} selected by estimator.`);
    return { method: tree.method, reasons };
  }
  const tallest = Math.max(0, ...tree.trees.filter((t) => t.work !== 'stump').map((t) => +t.heightFt || 0));
  const hz = tree.hazards || {};
  if (tallest === 0) return { method: 'climb', reasons };
  if (tallest > 75 || (hz.overHouse && hz.dead) || (tree.access === 'tight' && hz.overHouse && tallest > 50)) {
    reasons.push(tallest > 75 ? `Tree over 75 ft: crane is fastest and safest.` : 'Dead tree over a structure: crane avoids climbing compromised wood.');
    return { method: 'crane', reasons };
  }
  if (tree.access === 'tight') {
    reasons.push('No equipment access: climbing and rigging, debris hand-carried.');
    return { method: 'climb', reasons };
  }
  if (tree.access === 'backyard') {
    reasons.push('Backyard gate access: tracked spider lift fits through a 36" gate and protects the lawn.');
    return { method: tallest > 25 ? 'lift' : 'climb', reasons };
  }
  if (tallest >= 25) {
    reasons.push('Truck can reach the tree: bucket truck is faster and safer than climbing.');
    return { method: 'bucket', reasons };
  }
  reasons.push('Small tree: ground work and climbing only.');
  return { method: 'climb', reasons };
}

// ---------- pricing core ----------

function finish(division, pb, parts, opts = {}) {
  const { laborCost, equipment, materials, travel, emergency } = parts;
  const equipmentCost = equipment.reduce((s, e) => s + e.cost, 0);
  const materialCost = materials.reduce((s, m) => s + m.cost, 0);
  const directCost = laborCost + equipmentCost + materialCost + travel;
  const overhead = directCost * (pb.overheadPct / 100);
  const fullCost = directCost + overhead;
  const margin = (opts.marginPct ?? pb.targetMarginPct) / 100;
  let price = fullCost / Math.max(0.05, 1 - margin);
  if (opts.priorityPct) price *= 1 + opts.priorityPct / 100;
  const min = division === 'tree' ? pb.minJobTree : pb.minJobSnow;
  price = Math.max(min, roundUp(price, division === 'snow' ? 5 : pb.roundTo));
  const profit = price - fullCost;
  return {
    laborCost: r2(laborCost),
    equipmentCost: r2(equipmentCost),
    materialCost: r2(materialCost),
    travel: r2(travel),
    directCost: r2(directCost),
    overhead: r2(overhead),
    fullCost: r2(fullCost),
    price,
    profit: r2(profit),
    marginPct: r2((profit / price) * 100),
    emergency: !!emergency,
  };
}

function equipLine(pb, key, hours) {
  const e = pb.equipment[key];
  const h = Math.max(e.min || 0, hours);
  return { key, label: e.label, hours: r2(h), rate: e.rate, cost: r2(h * e.rate) };
}

function travelCost(pb, miles) {
  return Math.max(0, (+miles || 0) - pb.travel.freeMiles) * pb.travel.perMile;
}

// Tree job estimate for one configuration.
export function calcTree(job, pb = DEFAULT_PRICEBOOK, opts = {}) {
  const tree = { ...job.tree, ...(opts.override || {}) };
  const hz = tree.hazards || {};
  const { method, reasons } = recommendMethod(tree);
  const accessF = ACCESS[tree.access]?.f ?? 1;
  const hazardF = 1 + Object.keys(HAZARDS).reduce((s, k) => s + (hz[k] && !(k === 'nearStructure' && hz.overHouse) ? HAZARDS[k].f : 0), 0);
  const methodF = METHOD[method].f;

  let workHours = 0;   // crew hours aloft/ground cutting
  let grindHours = 0;
  let volumeYd = 0;
  let cableKits = 0;
  let stumpCount = 0;
  const treeLines = [];

  for (const t of tree.trees) {
    const qty = Math.max(1, +t.qty || 1);
    const h = Math.max(0, +t.heightFt || 0);
    const d = +t.dbhIn > 0 ? +t.dbhIn : estimateDbh(h || 20, t.species);
    const sf = speciesFactor(t.species);
    const base = 0.25 + h / 22 + d / 16; // crew hours for a clean, open removal
    let hrs = 0;
    if (t.work === 'remove') {
      hrs = base * sf * accessF * hazardF * methodF;
      volumeYd += (h * d) / 60;
      if (tree.stumps) { grindHours += (0.3 + d * 0.035) * (tree.access === 'tight' ? 1.3 : 1); stumpCount++; }
    } else if (t.work === 'trim') {
      hrs = base * (TRIM[tree.trimLevel] ?? 0.5) * sf * accessF * hazardF * Math.max(0.8, methodF);
      volumeYd += ((h * d) / 60) * (TRIM[tree.trimLevel] ?? 0.5) * 0.5 * qty;
    } else if (t.work === 'cable') {
      hrs = (1.5 + h / 40) * hazardF;
      cableKits += 1;
    } else if (t.work === 'stump') {
      grindHours += (0.3 + d * 0.035) * (tree.access === 'tight' ? 1.3 : 1);
      stumpCount++;
    }
    treeLines.push({ ...t, dbhIn: d, hours: r2(hrs * qty), qty });
    workHours += hrs * qty;
    if (t.work === 'remove' || t.work === 'stump') {
      // stump count scales with quantity
      if (qty > 1 && (tree.stumps || t.work === 'stump')) {
        grindHours += (0.3 + d * 0.035) * (qty - 1);
        stumpCount += qty - 1;
      }
    }
    volumeYd += t.work === 'remove' ? ((h * d) / 60) * (qty - 1) : 0;
  }

  const debrisF = DEBRIS[tree.debris]?.f ?? 0.3;
  let cleanupHours = workHours * debrisF;
  if (tree.firewood) cleanupHours += workHours * 0.15;
  if (tree.access === 'tight') cleanupHours *= 1.4;
  const siteHours = workHours + cleanupHours + (workHours > 0 ? 0.5 : 0); // setup/teardown

  let crew = pb.crew.tree;
  if (method === 'crane' || hz.powerLines || hz.overHouse) crew += 1;
  if (workHours === 0) crew = 1; // stump-only job

  const laborMult = job.emergency ? pb.labor.emergencyMult : 1;
  const wage = pb.labor.wage * (1 + pb.labor.burdenPct / 100) * laborMult;
  const personHours = siteHours * crew + grindHours; // one operator on the grinder
  const laborCost = personHours * wage;

  const equipment = [];
  if (workHours > 0) {
    equipment.push(equipLine(pb, method, method === 'crane' ? workHours * 0.7 : workHours));
    if (method !== 'climb') equipment.push(equipLine(pb, 'climb', workHours * 0.3));
    if (tree.debris !== 'leave') equipment.push(equipLine(pb, 'chipper', (workHours + cleanupHours) * 0.5));
    if (tree.debris === 'haul' || tree.access === 'backyard') equipment.push(equipLine(pb, 'loader', cleanupHours));
    if (tree.debris !== 'leave') equipment.push(equipLine(pb, 'dump', siteHours));
  }
  if (grindHours > 0) equipment.push(equipLine(pb, 'grinder', grindHours));

  const equipHours = equipment.reduce((s, e) => s + (pb.equipment[e.key].rate > 20 ? e.hours : 0), 0);
  const materials = [];
  materials.push({ label: 'Fuel, bar oil & chain wear', qty: r2(equipHours), unit: 'equip hr', cost: r2(equipHours * pb.materials.fuelPerEquipHour) });
  const haulYd = tree.debris === 'haul' ? volumeYd : tree.debris === 'chipLeaveLogs' ? volumeYd * 0.4 : 0;
  const loads = haulYd > 0 ? Math.ceil(haulYd / pb.materials.loadYards) : 0;
  if (loads) materials.push({ label: 'Dump / green-waste fees', qty: loads, unit: 'load', cost: loads * pb.materials.dumpFeePerLoad });
  if (cableKits) materials.push({ label: 'Cabling & bracing hardware', qty: cableKits, unit: 'kit', cost: cableKits * pb.materials.cablingKit });
  if (tree.restore && stumpCount) materials.push({ label: 'Topsoil, seed & straw', qty: stumpCount, unit: 'stump', cost: stumpCount * pb.materials.restoreKit });
  if (job.permit) materials.push({ label: 'Permit / municipal fee', qty: 1, unit: 'ea', cost: pb.materials.permitFee });

  const fin = finish('tree', pb, { laborCost, equipment, materials, travel: travelCost(pb, job.miles), emergency: job.emergency }, opts);

  const safety = Object.keys(HAZARDS).filter((k) => hz[k]).map((k) => HAZARDS[k].safety);
  if (job.emergency) safety.unshift('Emergency/storm response: site hazard assessment before any cuts.');

  return {
    division: 'tree',
    method,
    methodLabel: METHOD[method].label,
    reasons,
    crew,
    siteHours: r2(siteHours),
    grindHours: r2(grindHours),
    personHours: r2(personHours),
    days: Math.max(1, Math.ceil((siteHours + grindHours) / 8)),
    labor: { crew, siteHours: r2(siteHours), personHours: r2(personHours), wage: r2(wage), cost: r2(laborCost) },
    equipment,
    materials,
    volumeYd: r2(volumeYd),
    loads,
    stumpCount,
    treeLines,
    safety,
    ...fin,
    profitPerCrewHour: personHours ? r2(fin.profit / (siteHours + grindHours || 1)) : 0,
    config: tree,
  };
}

// Snow job estimate (per visit / per event).
export function calcSnow(job, pb = DEFAULT_PRICEBOOK, opts = {}) {
  const s = { ...job.snow, ...(opts.override || {}) };
  const area = Math.max(0, +s.areaSqft || 0);
  const walk = Math.max(0, +s.walkLf || 0);
  const roof = Math.max(0, +s.roofSqft || 0);
  const depth = Math.max(1, +s.depthIn || 2);
  const reasons = [];

  let method = s.method;
  if (!method || method === 'auto') {
    if (area >= 15000) { method = 'skid'; reasons.push('Large lot: skid steer with pusher box stacks snow fastest.'); }
    else if (area >= 1500) { method = 'plow'; reasons.push('Driveway/small lot: plow truck.'); }
    else if (area > 0) { method = 'blower'; reasons.push('Small area: walk-behind snow blower.'); }
    else method = 'shovel';
  } else reasons.push(`${pb.equipment[method]?.label || method} selected by estimator.`);

  const depthF = 1 + Math.max(0, depth - 2) / 6;
  const obsF = OBSTACLES[s.obstacles] ?? 1;
  const areaHours = area > 0 && s.plowOff !== true ? (area / SNOW_PROD[method]) * depthF * obsF : 0;
  const walkHours = walk > 0 ? ((walk * 4) / (s.property === 'commercial' ? 1500 : 1200)) * depthF : 0;
  const saltArea = s.salt ? area + walk * 4 : 0;
  const saltHours = s.salt ? 0.1 + saltArea / 40000 : 0;
  const roofHours = roof > 0 ? (roof / 350) * depthF : 0;
  const setup = 0.15;
  const siteHours = areaHours + walkHours + saltHours + roofHours + setup;

  let crew = pb.crew.snow;
  if (walk > 0 && s.property === 'commercial') crew += 1;
  if (roof > 0) crew = Math.max(crew, 2);

  const laborMult = job.emergency ? pb.labor.emergencyMult : 1;
  const wage = pb.labor.wage * (1 + pb.labor.burdenPct / 100) * laborMult;
  const personHours = siteHours * crew;
  const laborCost = personHours * wage;

  const equipment = [];
  if (areaHours > 0) equipment.push(equipLine(pb, method, areaHours + setup));
  if (walkHours > 0) equipment.push(equipLine(pb, 'blower', walkHours));
  if (s.salt) equipment.push(equipLine(pb, 'spreader', saltHours));
  if (roofHours > 0) equipment.push(equipLine(pb, 'shovel', roofHours));

  const saltLbs = s.salt ? Math.ceil((saltArea / 1000) * pb.materials.saltLbPer1000) : 0;
  const equipHours = equipment.reduce((sum, e) => sum + e.hours, 0);
  const materials = [{ label: 'Fuel', qty: r2(equipHours), unit: 'equip hr', cost: r2(equipHours * pb.materials.fuelPerEquipHour * 0.6) }];
  if (saltLbs) materials.push({ label: 'Rock salt / ice melt', qty: saltLbs, unit: 'lb', cost: r2(saltLbs * pb.materials.saltPerLb) });

  const fin = finish('snow', pb, { laborCost, equipment, materials, travel: travelCost(pb, job.miles) / 2, emergency: job.emergency }, {
    ...opts,
    priorityPct: s.priority ? pb.snow.priorityPct : 0,
  });

  const safety = [];
  if (roof > 0) safety.push('Roof work: fall protection required; keep drop zone below roped off.');
  if (s.salt) safety.push('Keep salt off landscaping and fresh concrete (<1 yr old).');
  if (s.property === 'commercial') safety.push('Commercial site: log every visit with time, depth and salt applied (slip-and-fall protection).');

  return {
    division: 'snow',
    method,
    methodLabel: pb.equipment[method]?.label || method,
    reasons,
    crew,
    siteHours: r2(siteHours),
    personHours: r2(personHours),
    days: 1,
    labor: { crew, siteHours: r2(siteHours), personHours: r2(personHours), wage: r2(wage), cost: r2(laborCost) },
    equipment,
    materials,
    saltLbs,
    safety,
    ...fin,
    profitPerCrewHour: siteHours ? r2(fin.profit / siteHours) : 0,
    config: s,
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

export function buildOptions(job, pb = DEFAULT_PRICEBOOK, marginPct) {
  const opts = { marginPct };
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
export function snowDepthTiers(job, pb = DEFAULT_PRICEBOOK, marginPct) {
  return [
    { label: '2–4"', depth: 3 },
    { label: '4–8"', depth: 6 },
    { label: '8–12"', depth: 10 },
    { label: '12"+', depth: 15 },
  ].map((t) => ({ ...t, price: calcSnow(job, pb, { marginPct, override: { depthIn: t.depth } }).price }));
}

// Totals for a chosen option with tax, discount and custom adjustments.
export function totals(price, { discount = 0, adjustments = [], taxPct = 0, depositPct = 0 } = {}) {
  const adj = adjustments.reduce((s, a) => s + (+a.amount || 0), 0);
  const subtotal = Math.max(0, price + adj - (+discount || 0));
  const tax = r2(subtotal * (taxPct / 100));
  const total = r2(subtotal + tax);
  return { adj, subtotal, tax, total, deposit: roundUp(total * (depositPct / 100), 1) };
}
