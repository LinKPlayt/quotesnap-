// The questions a contractor answers to price a job right. Pure functions, no DOM.
//
// People told us there were too many things to set, so there are two sets:
//   simple (the default, Settings → Simple screens): only what really moves the price, in plain
//     words. Trees: what, how many, how tall, can you drive up, anything risky, how it comes down,
//     what happens after (wood and stump in one), distance. Snow: home or business, size, walks,
//     salt, how to pay, distance. Everything else uses the price book's normal values.
//   detailed: adds trunk, kind of tree, extra conditions, firewood, lawn, permit, timing, snow depth,
//     ice, obstacles, roof, hauling, priority and storms per season.
//
// jobQuestions(est) lists the questions that matter for this job (they follow the answers: trim work
// asks how much trimming, a removal asks how it comes down). openQuestions(est) is the part still
// unanswered. A question counts as answered once it was picked here, or any of its fields was changed
// by hand on the Details card. Photo AI guesses are shown as the starting choice, but still asked.
//
// Every question writes plain job fields (the same ones the Details card edits), so the planner and
// price book price the answers exactly as if they were typed in.

import { fellBlocked } from './planner.js';

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
const yesNo = (path, yes, no, icon) => [opt('yes', yes, { [path]: true }, { icon }), opt('no', no, { [path]: false })];

function treeQuestions(j, company, simple) {
  const t = j.tree;
  const M = company?.multipliers?.conditions || {};
  const lbl = (k, d) => M[k]?.label || d;
  const qs = [];
  const many = t.trees.length > 1;
  const removals = t.trees.some((x) => x.work === 'remove');
  const cutting = t.trees.some((x) => x.work !== 'stump');

  qs.push({
    id: 'tree.count', kind: 'one', required: true,
    title: 'How many trees?', sub: 'Trees of different sizes go on the Details card, one row each.',
    why: 'Each tree adds cutting, chipping and hauling time.',
    paths: ['job.tree.trees.0.qty'], hide: many,
    options: [1, 2, 3, 4, 6, 10].map((n) => opt(String(n), n === 1 ? '1 tree' : n === 10 ? '10 or more' : `${n} trees`, { 'job.tree.trees.0.qty': n })),
  });

  t.trees.forEach((tr, i) => {
    const pre = many ? `Tree ${i + 1} of ${t.trees.length}: ` : '';
    const p = (k) => `job.tree.trees.${i}.${k}`;
    qs.push({
      id: `tree.${i}.work`, kind: 'one', required: true, title: `${pre}What needs doing?`,
      why: 'Taking down, trimming and stump grinding each take different crews and machines.',
      paths: [p('work')],
      options: [
        opt('remove', 'Take it down', { [p('work')]: 'remove' }, { icon: '🪓' }),
        opt('trim', 'Trim it', { [p('work')]: 'trim' }, { icon: '✂' }),
        opt('stump', 'Grind a stump', { [p('work')]: 'stump' }, { icon: '⚙' }),
        opt('cable', 'Cable a weak tree', { [p('work')]: 'cable' }, { icon: '🔗' }),
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
    const heights = [[15, 'Small', 'Under 20 ft, below the roof'], [28, 'Up to the roof', '20–35 ft'], [45, 'Above the house', '35–55 ft'], [65, 'Tall', '55–75 ft'], [90, 'Very tall', 'Over 75 ft']]
      .map(([v, l, s]) => opt(String(v), l, { [p('heightFt')]: v }, { sub: s, value: v }));
    qs.push({
      id: `tree.${i}.height`, kind: 'one', required: true, title: `${pre}How tall is it?`,
      sub: 'A 2-story house is about 25 ft.', why: 'Height decides the crew, the equipment and how much wood there is.',
      paths: [p('heightFt')], options: heights, guess: nearest(heights, tr.heightFt),
      now: tr.heightFt ? `${tr.heightFt} ft` : '',
    });
    const trunks = [[0, 'Not sure', 'Work it out from the height'], [8, 'Thin', 'Under 10 in, a hand can wrap it'], [16, 'Medium', '10–20 in'], [26, 'Thick', '20–30 in, a hug'], [38, 'Very thick', 'Over 30 in']]
      .map(([v, l, s]) => opt(String(v), l, { [p('dbhIn')]: v }, { sub: s, value: v }));
    qs.push({
      id: `tree.${i}.trunk`, kind: 'one', detail: true, title: `${pre}How thick is the trunk?`,
      sub: 'Measured about chest high.', why: 'Thick trunks mean heavy logs and more hauling.',
      paths: [p('dbhIn')], options: trunks, guess: tr.dbhIn ? nearest(trunks.slice(1), tr.dbhIn) : null,
      now: tr.dbhIn ? `${tr.dbhIn} in` : '',
    });
    const species = [['oak', 'Oak'], ['maple', 'Maple'], ['pine', 'Pine'], ['spruce', 'Spruce'], ['ash', 'Ash'], ['elm', 'Elm'], ['birch', 'Birch'], ['willow', 'Willow'], ['', 'Not sure']]
      .map(([v, l]) => opt(v || 'unknown', l, { [p('species')]: v }));
    qs.push({
      id: `tree.${i}.species`, kind: 'one', detail: true, title: `${pre}What kind of tree?`,
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
        opt('light', 'A little', { 'job.tree.trimLevel': 'light' }, { sub: 'Dead branches and a few limbs' }),
        opt('standard', 'A normal trim', { 'job.tree.trimLevel': 'standard' }, { sub: 'Clean it up, thin it, lift it' }),
        opt('heavy', 'A lot', { 'job.tree.trimLevel': 'heavy' }, { sub: 'Make it smaller, big limbs' }),
      ],
    });
  }

  {
    qs.push({
      id: 'tree.access', kind: 'one', required: true, title: 'Can a truck get to the tree?',
      why: "If machines can't reach it, everything is carried out by hand and takes longer.",
      paths: ['job.tree.access'],
      options: [
        ...(simple ? [] : [opt('open', 'Yes, right up to it', { 'job.tree.access': 'open' }, { icon: '🚚', sub: 'Open yard or field' })]),
        opt('driveway', simple ? 'Yes' : 'From the driveway or street', { 'job.tree.access': 'driveway' }, { icon: '🚚', sub: simple ? 'From the driveway, street or yard' : '' }),
        opt('backyard', 'Only through a gate', { 'job.tree.access': 'backyard' }, { icon: '🚪', sub: 'Backyard' }),
        opt('tight', 'No, nothing gets in', { 'job.tree.access': 'tight' }, { icon: '🚫', sub: 'Between houses, up steps' }),
      ],
    });
  }
  if (cutting) {
    const hz = simple
      ? [['powerLines', 'Power lines nearby', '⚡'], ['overHouse', 'Over or right next to a building', '🏠'], ['fenceGarden', 'Fence, garden or patio underneath', '🌷'], ['dead', 'Dead, rotten or storm damaged', '☠']]
      : [['powerLines', 'Power lines nearby', '⚡'], ['overHouse', 'Hangs over a building', '🏠'], ['nearStructure', 'House, shed or garage close by', '🏚'], ['fenceGarden', 'Fence, garden or patio underneath', '🌷'], ['dead', 'Dead or rotten', '☠'], ['leaning', 'Leaning, split or storm damaged', '🌪']];
    qs.push({
      id: 'tree.hazards', kind: 'many', required: true, title: 'Anything risky about it?', sub: 'Tick all that apply.',
      why: 'Power lines, buildings and fences mean slow, careful work and sometimes a bigger crew.',
      paths: hz.map(([k]) => `job.tree.hazards.${k}`), noneLabel: 'No, nothing risky',
      options: hz.map(([k, l, icon]) => opt(k, l, null, { icon, path: `job.tree.hazards.${k}` })),
    });
  }

  // the cheapest way, when there's room: drop it whole from the ground, no climbing or bucket truck
  if (removals && !fellBlocked(t, j)) {
    qs.push({
      id: 'tree.down', kind: 'one', required: true, title: 'How will it come down?',
      why: 'Dropping it in one piece is much faster than taking it down in sections.',
      paths: ['job.tree.method'],
      options: [
        opt('fell', 'In one piece', { 'job.tree.method': 'fell' }, { icon: '🌲', sub: "There's room for it to fall. Cut from the ground: no climbing or bucket truck." }),
        opt('auto', 'In sections', { 'job.tree.method': 'auto' }, { icon: '🪜', sub: 'Climbing, bucket truck or crane: the app picks the cheapest safe way.' }),
      ],
    });
  }

  if (removals) {
    const D = 'job.tree.debris';
    const ST = 'job.tree.stumps';
    qs.push({
      id: 'tree.after', kind: 'one', required: true, title: "When it's down, what happens to the wood?",
      why: 'Hauling it away adds truck loads and dump fees. Grinding the stump is its own machine.',
      paths: [D, ST],
      options: [
        opt('haul', 'Haul it all away', { [D]: 'haul', [ST]: false }, { icon: '🚛', sub: 'Stump stays' }),
        opt('haulStump', 'Haul it all away and grind the stump', { [D]: 'haul', [ST]: true }, { icon: '⚙' }),
        opt('leaveWood', 'Haul the branches, leave the logs', { [D]: 'chipLeaveLogs', [ST]: false }, { icon: '🪵', sub: 'Customer keeps the wood' }),
        opt('leaveAll', 'Leave everything', { [D]: 'leave', [ST]: false }, { icon: '🌲' }),
      ],
    });
  } else if (cutting) {
    qs.push({
      id: 'tree.after', kind: 'one', required: true, title: 'What happens to the branches?',
      why: 'Hauling them away adds truck time and dump fees.', paths: ['job.tree.debris'],
      options: [opt('haul', 'Haul them away', { 'job.tree.debris': 'haul' }, { icon: '🚛' }), opt('leave', 'Leave them on site', { 'job.tree.debris': 'leave' }, { icon: '🌿' })],
    });
  }

  // ---- detailed mode only
  if (cutting) {
    qs.push({
      id: 'tree.conditions', kind: 'many', detail: true, title: 'Anything else making it harder?', sub: 'Tick all that apply.',
      why: 'Each of these slows the crew down, so it is added to the time and price.',
      paths: TREE_CONDS.map((k) => `job.conditions.${k}`),
      options: TREE_CONDS.map((k) => opt(k, lbl(k, k), null, { icon: COND_ICONS[k], path: `job.conditions.${k}` })),
    });
  }
  if (removals && t.debris !== 'haul') {
    qs.push({ id: 'tree.firewood', kind: 'yesno', detail: true, title: 'Cut the wood into firewood lengths?', why: 'Cutting logs into rounds is extra saw time.', paths: ['job.tree.firewood'], options: yesNo('job.tree.firewood', 'Yes, cut to firewood', 'No, leave long logs', '🔥') });
  }
  if (t.stumps || t.trees.some((x) => x.work === 'stump')) {
    qs.push({ id: 'tree.restore', kind: 'yesno', detail: true, title: 'Fill the hole with soil and seed?', why: 'Topsoil, seed and the time to spread it.', paths: ['job.tree.restore'], options: yesNo('job.tree.restore', 'Yes, fix the lawn', 'No, grindings only', '🌱') });
  }
  qs.push({
    id: 'tree.property', kind: 'one', detail: true, title: 'Home or business?',
    why: 'Your price book can charge more for commercial work.', paths: ['job.property'],
    options: [opt('residential', 'Home', { 'job.property': 'residential' }, { icon: '🏡' }), opt('commercial', 'Business, HOA or city', { 'job.property': 'commercial' }, { icon: '🏢' })],
  });
  qs.push({ id: 'tree.permit', kind: 'yesno', detail: true, title: 'Does the town need a permit?', why: 'The permit fee is added to the quote.', paths: ['job.permit'], options: yesNo('job.permit', 'Yes, permit needed', 'No permit', '📝') });
  return qs;
}

function snowQuestions(j, company, pb) {
  const s = j.snow;
  const M = company?.multipliers?.conditions || {};
  const lbl = (k, d) => M[k]?.label || d;
  const qs = [];
  qs.push({
    id: 'snow.property', kind: 'one', required: true, title: 'Home or business?',
    why: 'Business lots need earlier service and your price book can charge more.', paths: ['job.snow.property'],
    options: [opt('residential', 'Home driveway', { 'job.snow.property': 'residential' }, { icon: '🏡' }), opt('commercial', 'Business lot, HOA or church', { 'job.snow.property': 'commercial' }, { icon: '🏢' })],
  });
  const res = s.property !== 'commercial';
  const areas = (res
    ? [[500, '1-car driveway'], [1000, '2-car driveway'], [1500, '3-car or long'], [2500, 'Long or shared drive'], [4000, 'Very long drive']]
    : [[5000, 'Small lot', 'About 15 spaces'], [10000, 'Medium lot', 'About 30 spaces'], [20000, 'Large lot', 'About 60 spaces'], [43560, '1 acre', 'About 130 spaces'], [87120, '2 acres or more']])
    .map(([v, l, sub]) => opt(String(v), l, { 'job.snow.areaSqft': v }, { sub: sub || `About ${v.toLocaleString('en-US')} sq ft`, value: v }));
  qs.push({
    id: 'snow.area', kind: 'one', required: true, title: 'How big is it?',
    why: 'Size is the biggest part of plow time.', paths: ['job.snow.areaSqft'], options: areas,
    guess: nearest(areas, s.areaSqft), now: s.areaSqft ? `${(+s.areaSqft).toLocaleString('en-US')} sq ft` : '',
  });
  const walks = [[0, 'None'], [30, 'Steps and a short path'], [60, 'A walk to the door'], [150, 'Sidewalk along the street'], [400, 'Lots of sidewalk']]
    .map(([v, l]) => opt(String(v), l, { 'job.snow.walkLf': v }, { value: v, sub: v ? `About ${v} ft` : '' }));
  qs.push({
    id: 'snow.walks', kind: 'one', required: true, title: 'Any sidewalks or steps to clear?',
    why: 'Walks are cleared by hand or blower: extra time.', paths: ['job.snow.walkLf'], options: walks,
    guess: s.walkLf ? nearest(walks, s.walkLf) : null, now: s.walkLf ? `${s.walkLf} ft` : '',
  });
  qs.push({ id: 'snow.salt', kind: 'yesno', required: true, title: 'Salt it after clearing?', why: 'Salt is priced by the pound plus spreading time.', paths: ['job.snow.salt'], options: yesNo('job.snow.salt', 'Yes, salt it', 'No salt', '🧂') });
  qs.push({
    id: 'snow.contract', kind: 'one', required: true, title: 'How do they want to pay?',
    why: 'A season price is worked out from the number of storms you expect.', paths: ['job.snow.contract'],
    options: [
      opt('perPush', 'Each time it snows', { 'job.snow.contract': 'perPush' }, { icon: '🧾', sub: 'The quote shows a price for each snow depth' }),
      opt('seasonal', 'One price for the winter', { 'job.snow.contract': 'seasonal' }, { icon: '📅', sub: `Based on ${+pb?.snow?.eventsPerSeason || 12} storms` }),
    ],
  });

  // ---- detailed mode only
  if (s.contract === 'seasonal') {
    const avg = +pb?.snow?.eventsPerSeason || 0;
    const events = [8, 12, 15, 20, 25, 30].map((v) => opt(String(v), `${v} storms`, { 'job.snow.events': v }, { value: v, sub: v === avg ? 'Your usual' : '' }));
    qs.push({ id: 'snow.events', kind: 'one', detail: true, title: 'How many storms in a season?', why: 'The season price covers this many visits.', paths: ['job.snow.events'], options: events, guess: nearest(events, s.events || avg) });
  }
  const depths = [2, 4, 6, 8, 12, 18].map((v) => opt(String(v), v === 18 ? '18 in or more' : `${v} in`, { 'job.snow.depthIn': v }, { value: v }));
  qs.push({ id: 'snow.depth', kind: 'one', detail: true, title: 'How much snow are you pricing for?', sub: 'Use the forecast or what is on the ground.', why: 'Deeper snow takes more passes.', paths: ['job.snow.depthIn'], options: depths, guess: nearest(depths, s.depthIn), now: s.depthIn ? `${s.depthIn} in` : '' });
  qs.push({ id: 'snow.surface', kind: 'many', detail: true, title: 'What is the snow like?', sub: 'Tick all that apply.', why: 'Heavy, wet snow and ice are much slower to move.', paths: SNOW_SURFACE.map((k) => `job.conditions.${k}`), options: SNOW_SURFACE.map((k) => opt(k, lbl(k, k), null, { icon: COND_ICONS[k], path: `job.conditions.${k}` })) });
  qs.push({
    id: 'snow.obstacles', kind: 'one', detail: true, title: 'How open is it?', why: 'Plowing around cars, curbs and islands is slower.', paths: ['job.snow.obstacles'],
    options: [opt('low', 'Wide open', { 'job.snow.obstacles': 'low' }, { icon: '⬜' }), opt('med', 'Some cars or curbs', { 'job.snow.obstacles': 'med' }, { icon: '🚗' }), opt('high', 'Tight: islands, many cars', { 'job.snow.obstacles': 'high' }, { icon: '🚧' })],
  });
  qs.push({ id: 'snow.conditions', kind: 'many', detail: true, title: 'Anything else making it harder?', sub: 'Tick all that apply.', why: 'Each of these slows the work down.', paths: SNOW_CONDS.map((k) => `job.conditions.${k}`), options: SNOW_CONDS.map((k) => opt(k, lbl(k, k), null, { icon: COND_ICONS[k], path: `job.conditions.${k}` })) });
  const roofs = [[0, 'No roof'], [800, 'Small roof or porch', 'About 800 sq ft'], [1500, 'House roof', 'About 1,500 sq ft'], [3000, 'Large or flat roof', 'About 3,000 sq ft']]
    .map(([v, l, sub]) => opt(String(v), l, { 'job.snow.roofSqft': v }, { sub, value: v }));
  qs.push({ id: 'snow.roof', kind: 'one', detail: true, title: 'Clear snow off a roof?', why: 'Roof work is slow, by hand and needs safety gear.', paths: ['job.snow.roofSqft'], options: roofs, guess: s.roofSqft ? nearest(roofs, s.roofSqft) : null });
  qs.push({ id: 'snow.haul', kind: 'yesno', detail: true, title: 'Haul the snow off site?', why: 'Loading and trucking snow away is billed by the load.', paths: ['job.snow.haul'], options: yesNo('job.snow.haul', 'Yes, no room to pile it', 'No, pile it on site', '🚚') });
  qs.push({ id: 'snow.priority', kind: 'yesno', detail: true, title: 'Must it be cleared first, before 7 AM?', why: 'Priority service is first on the route and costs more.', paths: ['job.snow.priority'], options: yesNo('job.snow.priority', 'Yes, priority', 'No, normal route', '⭐') });
  return qs;
}

function sharedQuestions(est, ctx) {
  const j = est.job;
  const qs = [];
  const tree = j.division === 'tree';
  const timing = tree ? [['emergency', 'Emergency / urgent', '🚨'], ['storm', 'Storm response', '🌪'], ['weekend', 'Weekend', '📅'], ['holiday', 'Holiday', '🎉']]
    : [['emergency', 'Emergency / urgent', '🚨'], ['weekend', 'Weekend', '📅'], ['holiday', 'Holiday', '🎉']];
  qs.push({
    id: 'job.timing', kind: 'many', detail: true, title: 'When does the work happen?', sub: 'Leave all off for normal weekday work.',
    why: 'Rush, storm, weekend and holiday work pay the crew overtime and add your markup.',
    paths: timing.map(([k]) => `job.${k}`), noneLabel: 'Normal weekday work',
    options: timing.map(([k, l, icon]) => opt(k, l, null, { icon, path: `job.${k}` })),
  });
  const hasMiles = +j.miles > 0;
  const miles = [[2, 'Under 5 miles'], [8, '5–10 miles'], [15, '10–20 miles'], [25, '20–30 miles'], [40, '30–50 miles'], [65, 'Over 50 miles']]
    .map(([v, l]) => opt(String(v), l, { 'job.miles': v }, { value: v }));
  qs.push({
    id: 'job.miles', kind: 'one', required: true, title: 'How far is it from your shop?',
    sub: ctx.canFindMiles ? 'Or let the app work it out from the address.' : '', why: 'Drive time, fuel and truck wear are added for every trip.',
    paths: ['job.miles'], options: miles, auto: ctx.canFindMiles ? { id: 'auto', label: 'Work it out from the address', icon: '📍' } : null,
    guess: hasMiles ? nearest(miles, j.miles) : null, now: hasMiles ? `${j.miles} miles` : '',
    // a distance filled in from GPS or the address is measured, not guessed
    known: hasMiles && !(est.aiFields || []).includes('job.miles'),
  });
  return qs;
}

// The questions that matter for this job, in the order they are asked.
// ctx: { company, pricebook, canFindMiles, simple } (simple is on unless ctx.simple === false)
export function jobQuestions(est, ctx = {}) {
  const j = est.job;
  const simple = ctx.simple !== false;
  const qs = [];
  const locks = est.locks || {};
  qs.push({
    id: 'job.division', kind: 'one', required: true, title: 'What kind of job is it?',
    why: 'Tree and snow work are planned and priced completely differently.', paths: ['job.division'],
    known: !!(est.ai || (j.description || '').trim() || locks['job.division']),
    options: [opt('tree', 'Tree work', { 'job.division': 'tree' }, { icon: '🌳' }), opt('snow', 'Snow removal', { 'job.division': 'snow' }, { icon: '❄' })],
  });
  qs.push(...(j.division === 'snow' ? snowQuestions(j, ctx.company, ctx.pricebook) : treeQuestions(j, ctx.company, simple)));
  qs.push(...sharedQuestions(est, ctx));
  return qs.filter((q) => !q.hide && !(simple && q.detail));
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
