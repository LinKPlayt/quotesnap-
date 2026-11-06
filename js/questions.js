// The questions a contractor must answer to price a job right. Pure functions, no DOM.
//
// jobQuestions(est) lists every question that matters for this job (it follows the answers:
// trim work asks how much trimming, seasonal snow asks how many storms, and so on).
// openQuestions(est) is the part still unanswered. A question counts as answered once the
// estimator picked an answer here, or changed any of its fields by hand on the Details card.
// Photo AI guesses are shown as the starting choice, but still asked: they are rough.
//
// Every question writes plain job fields (the same ones the Details card edits), so the
// planner and price book price the answers exactly as if they were typed in.

const HAZARD_KEYS = ['powerLines', 'overHouse', 'nearStructure', 'dead', 'leaning', 'fenceGarden'];
const TREE_CONDS = ['steepSlope', 'nearRoad', 'vehicles', 'narrowGate', 'longDrag', 'largeLogs', 'denseBrush', 'heavyCleanup', 'wet', 'frozen'];
const SNOW_SURFACE = ['heavySnow', 'ice', 'snowPiles'];
const SNOW_CONDS = ['steepSlope', 'tightAreas', 'limitedAccess', 'frozen'];
const COND_ICONS = {
  steepSlope: '⛰', nearRoad: '🚧', vehicles: '🚗', narrowGate: '🚪', longDrag: '↔', largeLogs: '🪵', denseBrush: '🌿',
  heavyCleanup: '🧹', wet: '💧', frozen: '🧊', heavySnow: '🌨', ice: '🧊', snowPiles: '⛄', tightAreas: '📐', limitedAccess: '🚫',
};

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const nearest = (opts, v) => {
  if (!(+v > 0)) return null;
  let best = null;
  for (const o of opts) if (best == null || Math.abs(o.value - v) < Math.abs(best.value - v)) best = o;
  return best?.id ?? null;
};

// One choice: { id, label, icon, sub, set: { path: value } }
const opt = (id, label, set, extra = {}) => ({ id, label, set, ...extra });

function treeQuestions(j, company) {
  const t = j.tree;
  const M = company?.multipliers?.conditions || {};
  const lbl = (k, d) => M[k]?.label || d;
  const qs = [];
  const many = t.trees.length > 1;

  qs.push({
    id: 'tree.count', kind: 'one', required: true,
    title: 'How many trees?', sub: many ? 'Different sizes are listed one by one on the Details card.' : 'Count every tree of this size in the job.',
    why: 'Each tree adds cutting, chipping and hauling time.',
    paths: ['job.tree.trees.0.qty'], hide: many,
    options: [1, 2, 3, 4, 5, 6, 8, 10].map((n) => opt(String(n), n === 1 ? '1 tree' : `${n} trees`, { 'job.tree.trees.0.qty': n })),
  });

  t.trees.forEach((tr, i) => {
    const pre = many ? `Tree ${i + 1} of ${t.trees.length}: ` : '';
    const p = (k) => `job.tree.trees.${i}.${k}`;
    qs.push({
      id: `tree.${i}.work`, kind: 'one', required: true, title: `${pre}What work is needed?`,
      why: 'Removing, trimming, stump grinding and cabling each take different crews and machines.',
      paths: [p('work')],
      options: [
        opt('remove', 'Take it down', { [p('work')]: 'remove' }, { icon: '🪓' }),
        opt('trim', 'Trim / prune', { [p('work')]: 'trim' }, { icon: '✂' }),
        opt('stump', 'Stump only', { [p('work')]: 'stump' }, { icon: '⚙' }),
        opt('cable', 'Cable & brace', { [p('work')]: 'cable' }, { icon: '🔗' }),
      ],
    });
    if (tr.work === 'stump') {
      qs.push({
        id: `tree.${i}.stumpsize`, kind: 'one', required: true, title: `${pre}How wide is the stump?`,
        why: 'Wider stumps take longer to grind.',
        paths: [p('dbhIn')],
        options: [[8, 'Small', 'Under 10 in'], [14, 'Medium', '10–18 in'], [24, 'Large', '18–30 in'], [36, 'Very large', 'Over 30 in']]
          .map(([v, l, s]) => opt(String(v), l, { [p('dbhIn')]: v }, { sub: s, value: v })),
      });
      return;
    }
    const heights = [[15, 'Under 20 ft', 'About one story'], [25, '20–30 ft', 'Up to the roof line'], [40, '30–50 ft', 'Above a 2-story house'], [60, '50–70 ft'], [80, '70–90 ft'], [100, 'Over 90 ft']]
      .map(([v, l, s]) => opt(String(v), l, { [p('heightFt')]: v }, { sub: s, value: v }));
    qs.push({
      id: `tree.${i}.height`, kind: 'one', required: true, title: `${pre}How tall is it?`,
      sub: 'A 2-story house is about 25 ft.', why: 'Height decides the equipment, crew size and how much wood there is.',
      paths: [p('heightFt')], options: heights, guess: nearest(heights, tr.heightFt),
      now: tr.heightFt ? `${tr.heightFt} ft` : '',
    });
    const trunks = [[0, 'Not sure', 'Work it out from the height'], [8, 'Thin', 'Under 10 in, a hand can wrap it'], [16, 'Medium', '10–20 in'], [26, 'Thick', '20–30 in, a hug'], [38, 'Very thick', 'Over 30 in']]
      .map(([v, l, s]) => opt(String(v), l, { [p('dbhIn')]: v }, { sub: s, value: v }));
    qs.push({
      id: `tree.${i}.trunk`, kind: 'one', required: false, title: `${pre}How thick is the trunk?`,
      sub: 'Measured about chest high.', why: 'Thick trunks mean heavy logs, bigger rigging and more hauling.',
      paths: [p('dbhIn')], options: trunks, guess: tr.dbhIn ? nearest(trunks.slice(1), tr.dbhIn) : null,
      now: tr.dbhIn ? `${tr.dbhIn} in` : '',
    });
    const species = [['oak', 'Oak'], ['maple', 'Maple'], ['pine', 'Pine'], ['spruce', 'Spruce'], ['ash', 'Ash'], ['elm', 'Elm'], ['birch', 'Birch'], ['willow', 'Willow'], ['', 'Not sure']]
      .map(([v, l]) => opt(v || 'unknown', l, { [p('species')]: v }));
    qs.push({
      id: `tree.${i}.species`, kind: 'one', required: false, title: `${pre}What kind of tree?`,
      why: 'Hard wood like oak cuts slower than soft wood like pine.',
      paths: [p('species')], options: species,
      guess: tr.species ? (species.find((o) => o.set[p('species')] === tr.species)?.id ?? null) : null,
      now: tr.species || '',
    });
  });

  if (t.trees.some((x) => x.work === 'trim')) {
    qs.push({
      id: 'tree.trimLevel', kind: 'one', required: true, title: 'How much trimming?',
      why: 'A heavy reduction takes about twice as long as a light cleanup.',
      paths: ['job.tree.trimLevel'],
      options: [
        opt('light', 'Light', { 'job.tree.trimLevel': 'light' }, { sub: 'Dead wood and a few limbs' }),
        opt('standard', 'Standard', { 'job.tree.trimLevel': 'standard' }, { sub: 'Clean, thin and raise' }),
        opt('heavy', 'Heavy', { 'job.tree.trimLevel': 'heavy' }, { sub: 'Crown reduction, big limbs' }),
      ],
    });
  }

  qs.push({
    id: 'tree.access', kind: 'one', required: true, title: 'Can you drive up to the tree?',
    why: 'If machines can\'t reach it, everything is carried by hand and takes longer.',
    paths: ['job.tree.access'],
    options: [
      opt('open', 'Yes, drive right up', { 'job.tree.access': 'open' }, { icon: '🚚', sub: 'Open yard or field' }),
      opt('driveway', 'From the driveway or street', { 'job.tree.access': 'driveway' }, { icon: '🏠' }),
      opt('backyard', 'Backyard, through a gate', { 'job.tree.access': 'backyard' }, { icon: '🚪' }),
      opt('tight', 'No: no equipment can get in', { 'job.tree.access': 'tight' }, { icon: '🚫', sub: 'Between houses, steps, landlocked' }),
    ],
  });

  qs.push({
    id: 'tree.hazards', kind: 'many', required: true, title: 'Anything near the tree?', sub: 'Tick all that apply.',
    why: 'Power lines, roofs and fences mean slow, careful rigging and sometimes a bigger crew.',
    paths: HAZARD_KEYS.map((k) => `job.tree.hazards.${k}`),
    options: [
      opt('powerLines', 'Power lines', null, { icon: '⚡', path: 'job.tree.hazards.powerLines' }),
      opt('overHouse', 'Hangs over the house', null, { icon: '🏠', path: 'job.tree.hazards.overHouse' }),
      opt('nearStructure', 'House, shed or garage close by', null, { icon: '🏚', path: 'job.tree.hazards.nearStructure' }),
      opt('dead', 'Dead or rotten', null, { icon: '☠', path: 'job.tree.hazards.dead' }),
      opt('leaning', 'Leaning, split or storm damaged', null, { icon: '🌪', path: 'job.tree.hazards.leaning' }),
      opt('fenceGarden', 'Fence, garden or patio below', null, { icon: '🌷', path: 'job.tree.hazards.fenceGarden' }),
    ],
  });

  qs.push({
    id: 'tree.conditions', kind: 'many', required: true, title: 'Anything else making it harder?', sub: 'Tick all that apply.',
    why: 'Each of these slows the crew down, so it is added to the time and price.',
    paths: TREE_CONDS.map((k) => `job.conditions.${k}`),
    options: TREE_CONDS.map((k) => opt(k, lbl(k, k), null, { icon: COND_ICONS[k], path: `job.conditions.${k}` })),
  });

  qs.push({
    id: 'tree.debris', kind: 'one', required: true, title: 'What happens to the wood and brush?',
    why: 'Hauling it away adds loads, dump fees and truck time.',
    paths: ['job.tree.debris'],
    options: [
      opt('haul', 'Haul everything away', { 'job.tree.debris': 'haul' }, { icon: '🚛' }),
      opt('chipLeaveLogs', 'Haul brush, leave the wood', { 'job.tree.debris': 'chipLeaveLogs' }, { icon: '🪵', sub: 'Customer keeps logs or firewood' }),
      opt('leave', 'Leave everything on site', { 'job.tree.debris': 'leave' }, { icon: '🌲' }),
    ],
  });

  if (t.debris !== 'haul') {
    qs.push({
      id: 'tree.firewood', kind: 'yesno', required: false, title: 'Cut the wood into firewood lengths?',
      why: 'Bucking logs into rounds is extra saw time.', paths: ['job.tree.firewood'],
      options: [opt('yes', 'Yes, cut to firewood', { 'job.tree.firewood': true }, { icon: '🔥' }), opt('no', 'No, leave long logs', { 'job.tree.firewood': false })],
    });
  }

  if (t.trees.some((x) => x.work === 'remove')) {
    qs.push({
      id: 'tree.stumps', kind: 'yesno', required: true, title: 'Grind the stump too?',
      why: 'Stump grinding is its own machine and time.', paths: ['job.tree.stumps'],
      options: [opt('yes', 'Yes, grind the stump', { 'job.tree.stumps': true }, { icon: '⚙' }), opt('no', 'No, leave it', { 'job.tree.stumps': false })],
    });
  }
  if (t.stumps || t.trees.some((x) => x.work === 'stump')) {
    qs.push({
      id: 'tree.restore', kind: 'yesno', required: false, title: 'Fill the hole with soil and seed?',
      why: 'Topsoil, seed and the time to spread it.', paths: ['job.tree.restore'],
      options: [opt('yes', 'Yes, restore the lawn', { 'job.tree.restore': true }, { icon: '🌱' }), opt('no', 'No, grindings only', { 'job.tree.restore': false })],
    });
  }

  qs.push({
    id: 'tree.property', kind: 'one', required: true, title: 'Home or business?',
    why: 'Your price book can charge more for commercial work.', paths: ['job.property'],
    options: [opt('residential', 'Home', { 'job.property': 'residential' }, { icon: '🏡' }), opt('commercial', 'Business, HOA or city', { 'job.property': 'commercial' }, { icon: '🏢' })],
  });

  qs.push({
    id: 'tree.permit', kind: 'yesno', required: false, title: 'Does the town need a permit?',
    why: 'The permit fee is added to the quote.', paths: ['job.permit'],
    options: [opt('yes', 'Yes, permit needed', { 'job.permit': true }, { icon: '📝' }), opt('no', 'No permit', { 'job.permit': false })],
  });
  return qs;
}

function snowQuestions(j, company, pb) {
  const s = j.snow;
  const M = company?.multipliers?.conditions || {};
  const lbl = (k, d) => M[k]?.label || d;
  const qs = [];
  qs.push({
    id: 'snow.property', kind: 'one', required: true, title: 'Home or business?',
    why: 'Commercial lots need earlier service and your price book can charge more.', paths: ['job.snow.property'],
    options: [opt('residential', 'Home driveway', { 'job.snow.property': 'residential' }, { icon: '🏡' }), opt('commercial', 'Business lot, HOA or church', { 'job.snow.property': 'commercial' }, { icon: '🏢' })],
  });
  const res = s.property !== 'commercial';
  const areas = (res
    ? [[500, '1-car driveway'], [1000, '2-car driveway'], [1500, '3-car or long'], [2500, 'Long or shared drive'], [4000, 'Very long drive']]
    : [[5000, 'Small lot', 'About 15 spaces'], [10000, 'Medium lot', 'About 30 spaces'], [20000, 'Large lot', 'About 60 spaces'], [43560, '1 acre', 'About 130 spaces'], [87120, '2 acres or more']])
    .map(([v, l, sub]) => opt(String(v), l, { 'job.snow.areaSqft': v }, { sub: sub || `About ${v.toLocaleString('en-US')} sq ft`, value: v }));
  qs.push({
    id: 'snow.area', kind: 'one', required: true, title: 'How big is the area to clear?',
    why: 'Area is the biggest part of plow time.', paths: ['job.snow.areaSqft'], options: areas,
    guess: nearest(areas, s.areaSqft), now: s.areaSqft ? `${(+s.areaSqft).toLocaleString('en-US')} sq ft` : '',
  });
  const walks = [[0, 'None'], [30, 'Front steps and a short path', 'About 30 ft'], [60, 'Walk to the door', 'About 60 ft'], [150, 'Sidewalk along the street', 'About 150 ft'], [400, 'Lots of sidewalk', 'About 400 ft']]
    .map(([v, l, sub]) => opt(String(v), l, { 'job.snow.walkLf': v }, { sub, value: v }));
  qs.push({
    id: 'snow.walks', kind: 'one', required: true, title: 'Any sidewalks or steps to shovel?',
    why: 'Walks are shoveled or blown by hand, which is extra crew time.', paths: ['job.snow.walkLf'], options: walks,
    guess: s.walkLf ? nearest(walks, s.walkLf) : null, now: s.walkLf ? `${s.walkLf} ft` : '',
  });
  const depths = [2, 4, 6, 8, 12, 18].map((v) => opt(String(v), v === 18 ? '18 in or more' : `${v} in`, { 'job.snow.depthIn': v }, { value: v }));
  qs.push({
    id: 'snow.depth', kind: 'one', required: true, title: 'How much snow are you pricing for?',
    sub: 'Use the forecast or what is on the ground.', why: 'Deeper snow takes more passes.', paths: ['job.snow.depthIn'], options: depths,
    guess: nearest(depths, s.depthIn), now: s.depthIn ? `${s.depthIn} in` : '',
  });
  qs.push({
    id: 'snow.surface', kind: 'many', required: true, title: 'What is the snow like?', sub: 'Tick all that apply.',
    why: 'Heavy, wet snow and ice are much slower to move.', paths: SNOW_SURFACE.map((k) => `job.conditions.${k}`),
    options: SNOW_SURFACE.map((k) => opt(k, lbl(k, k), null, { icon: COND_ICONS[k], path: `job.conditions.${k}` })),
  });
  qs.push({
    id: 'snow.salt', kind: 'yesno', required: true, title: 'Salt or de-ice after clearing?',
    why: 'Salt is priced by the pound plus spreading time.', paths: ['job.snow.salt'],
    options: [opt('yes', 'Yes, salt it', { 'job.snow.salt': true }, { icon: '🧂' }), opt('no', 'No salt', { 'job.snow.salt': false })],
  });
  qs.push({
    id: 'snow.obstacles', kind: 'one', required: true, title: 'How open is it?',
    why: 'Plowing around cars, curbs and islands is slower.', paths: ['job.snow.obstacles'],
    options: [
      opt('low', 'Wide open', { 'job.snow.obstacles': 'low' }, { icon: '⬜' }),
      opt('med', 'Some cars or curbs', { 'job.snow.obstacles': 'med' }, { icon: '🚗' }),
      opt('high', 'Tight: islands, many cars', { 'job.snow.obstacles': 'high' }, { icon: '🚧' }),
    ],
  });
  qs.push({
    id: 'snow.conditions', kind: 'many', required: true, title: 'Anything else making it harder?', sub: 'Tick all that apply.',
    why: 'Each of these slows the work down, so it is added to the time and price.', paths: SNOW_CONDS.map((k) => `job.conditions.${k}`),
    options: SNOW_CONDS.map((k) => opt(k, lbl(k, k), null, { icon: COND_ICONS[k], path: `job.conditions.${k}` })),
  });
  const roofs = [[0, 'No roof'], [800, 'Small roof or porch', 'About 800 sq ft'], [1500, 'House roof', 'About 1,500 sq ft'], [3000, 'Large or flat roof', 'About 3,000 sq ft']]
    .map(([v, l, sub]) => opt(String(v), l, { 'job.snow.roofSqft': v }, { sub, value: v }));
  qs.push({
    id: 'snow.roof', kind: 'one', required: false, title: 'Clear snow off a roof?',
    why: 'Roof work is slow, by hand and needs safety gear.', paths: ['job.snow.roofSqft'], options: roofs,
    guess: s.roofSqft ? nearest(roofs, s.roofSqft) : null,
  });
  qs.push({
    id: 'snow.haul', kind: 'yesno', required: false, title: 'Haul the snow off site?',
    why: 'Loading and trucking snow away is billed by the load.', paths: ['job.snow.haul'],
    options: [opt('yes', 'Yes, no room to pile it', { 'job.snow.haul': true }, { icon: '🚚' }), opt('no', 'No, pile it on site', { 'job.snow.haul': false })],
  });
  qs.push({
    id: 'snow.priority', kind: 'yesno', required: false, title: 'Must it be cleared first, before 7 AM?',
    why: 'Priority service is first on the route and costs more.', paths: ['job.snow.priority'],
    options: [opt('yes', 'Yes, priority', { 'job.snow.priority': true }, { icon: '⭐' }), opt('no', 'No, normal route', { 'job.snow.priority': false })],
  });
  qs.push({
    id: 'snow.contract', kind: 'one', required: true, title: 'How do they want to pay?',
    why: 'A season contract is priced from the number of storms you expect.', paths: ['job.snow.contract'],
    options: [
      opt('perPush', 'Pay per visit', { 'job.snow.contract': 'perPush' }, { icon: '🧾' }),
      opt('seasonal', 'One price for the whole season', { 'job.snow.contract': 'seasonal' }, { icon: '📅' }),
    ],
  });
  if (s.contract === 'seasonal') {
    const avg = +pb?.snow?.eventsPerSeason || 0;
    const events = [8, 12, 15, 20, 25, 30].map((v) => opt(String(v), `${v} storms`, { 'job.snow.events': v }, { value: v, sub: v === avg ? 'Your usual' : '' }));
    qs.push({
      id: 'snow.events', kind: 'one', required: true, title: 'How many storms in a season?',
      why: 'The season price covers this many visits.', paths: ['job.snow.events'], options: events,
      guess: nearest(events, s.events || avg),
    });
  }
  return qs;
}

function sharedQuestions(est, ctx) {
  const j = est.job;
  const qs = [];
  const tree = j.division === 'tree';
  const timing = tree ? [['emergency', 'Emergency / urgent', '🚨'], ['storm', 'Storm response', '🌪'], ['weekend', 'Weekend', '📅'], ['holiday', 'Holiday', '🎉']]
    : [['emergency', 'Emergency / urgent', '🚨'], ['weekend', 'Weekend', '📅'], ['holiday', 'Holiday', '🎉']];
  qs.push({
    id: 'job.timing', kind: 'many', required: true, title: 'When does the work happen?', sub: 'Tick any that apply. Leave all off for normal weekday work.',
    why: 'Rush, storm, weekend and holiday work pay the crew overtime and add your markup.',
    paths: timing.map(([k]) => `job.${k}`), noneLabel: 'Normal weekday work',
    options: timing.map(([k, l, icon]) => opt(k, l, null, { icon, path: `job.${k}` })),
  });
  const hasMiles = +j.miles > 0;
  const miles = [[2, 'Under 5 miles'], [8, '5–10 miles'], [15, '10–20 miles'], [25, '20–30 miles'], [40, '30–50 miles'], [65, 'Over 50 miles']]
    .map(([v, l]) => opt(String(v), l, { 'job.miles': v }, { value: v, sub: `Priced as ${v} miles each way` }));
  qs.push({
    id: 'job.miles', kind: 'one', required: true, title: 'How far is the job from your shop?',
    sub: ctx.canFindMiles ? 'Or let the app work it out from the address.' : '', why: 'Drive time, fuel and truck wear are added for every trip.',
    paths: ['job.miles'], options: miles, auto: ctx.canFindMiles ? { id: 'auto', label: 'Work it out from the address', icon: '📍' } : null,
    guess: hasMiles ? nearest(miles, j.miles) : null, now: hasMiles ? `${j.miles} miles` : '',
    // a distance filled in from GPS or the address is measured, not guessed
    known: hasMiles && !(est.aiFields || []).includes('job.miles'),
  });
  return qs;
}

// Every question that matters for this job, in the order they should be asked.
// ctx: { company, pricebook, canFindMiles }
export function jobQuestions(est, ctx = {}) {
  const j = est.job;
  const qs = [];
  const locks = est.locks || {};
  qs.push({
    id: 'job.division', kind: 'one', required: true, title: 'What kind of job is it?',
    why: 'Tree and snow work are planned and priced completely differently.', paths: ['job.division'],
    known: !!(est.ai || (j.description || '').trim() || locks['job.division']),
    options: [opt('tree', 'Tree work', { 'job.division': 'tree' }, { icon: '🌳' }), opt('snow', 'Snow removal', { 'job.division': 'snow' }, { icon: '❄' })],
  });
  qs.push(...(j.division === 'snow' ? snowQuestions(j, ctx.company, ctx.pricebook) : treeQuestions(j, ctx.company)));
  qs.push(...sharedQuestions(est, ctx));
  return qs.filter((q) => !q.hide);
}

export function isAnswered(est, q) {
  if (q.known) return true;
  if (est.answered?.[q.id]) return true;
  const locks = est.locks || {};
  return q.paths.some((p) => locks[p]);
}

export function openQuestions(est, ctx = {}, { requiredOnly = false } = {}) {
  return jobQuestions(est, ctx).filter((q) => !isAnswered(est, q) && (!requiredOnly || q.required));
}

// What is ticked now (for "many") or which choice matches the job (for "one" / "yesno").
export function currentAnswer(est, q) {
  if (q.kind === 'many') return q.options.filter((o) => !!get(est, o.path)).map((o) => o.id);
  const hit = q.options.find((o) => Object.entries(o.set).every(([p, v]) => get(est, p) === v));
  return hit?.id ?? q.guess ?? null;
}

// Write an answer into the quote. value: option id (one / yesno) or array of ids (many).
// Locks the fields so photo AI and notes never overwrite them. Returns the changed paths.
export function applyAnswer(est, q, value) {
  est.locks ||= {};
  est.answered ||= {};
  const writes = {};
  if (q.kind === 'many') {
    const on = new Set(Array.isArray(value) ? value : []);
    for (const o of q.options) writes[o.path] = on.has(o.id);
  } else {
    const o = q.options.find((x) => x.id === value);
    if (!o) return [];
    Object.assign(writes, o.set);
  }
  for (const [path, v] of Object.entries(writes)) {
    setIn(est, path, v);
    est.locks[path] = true;
  }
  if (est.aiFields) est.aiFields = est.aiFields.filter((p) => !(p in writes));
  est.answered[q.id] = true;
  return Object.keys(writes);
}

function setIn(o, path, v) {
  const ks = path.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) cur = cur[k] ??= {};
  cur[ks.at(-1)] = v;
}

// Short status for the Details card and Send bar.
export function questionSummary(est, ctx = {}) {
  const all = jobQuestions(est, ctx);
  const open = all.filter((q) => !isAnswered(est, q));
  const openRequired = open.filter((q) => q.required);
  return { total: all.length, open: open.length, openRequired: openRequired.length, done: all.length - open.length };
}
