// Pricing sense: bigger, harder or more work is never cheaper; equipment and crew are sized the way a
// contractor would; and typical jobs land in realistic price ranges.
// Replays: SENSE_SEED=7 SENSE_N=20000 node --test tests/pricing-sense.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { newJob, newTree, calc, buildOptions, snowDepthTiers } from '../js/engine.js';
import { defaultCompany, mergeCompany } from '../js/company.js';
import { mergePricebook } from '../js/pricebook.js';

const PB = mergePricebook({});
const sample = defaultCompany();
const minimal = (() => { const c = defaultCompany(); c.equipment = c.equipment.filter((e) => ['chainsaw', 'pickup', 'walk_blower', 'dump_truck'].includes(e.type)); c.workers = c.workers.slice(0, 2); return c; })();
const empty = mergeCompany({ workers: [], equipment: [] });
const big = (() => { const c = defaultCompany(); c.equipment.push(...defaultCompany().equipment.map((e) => ({ ...e, id: e.id + 'b', name: e.name + ' B' }))); c.workers.push(...defaultCompany().workers.map((w) => ({ ...w, id: w.id + 'b', name: w.name + ' B' }))); return c; })();
const COMPANIES = { sample, minimal, empty, big };

const T = (tree = {}, trees = [{}], job = {}) => { const j = newJob('tree'); j.miles = 10; Object.assign(j, job); Object.assign(j.tree, tree); j.tree.trees = trees.map((t) => ({ ...newTree(), heightFt: 40, species: 'oak', ...t })); return j; };
const S = (snow = {}, job = {}) => { const j = newJob('snow'); j.miles = 5; Object.assign(j, job); Object.assign(j.snow, snow); return j; };
const price = (j, company = sample) => calc(j, PB, { company }).price;

// each list goes from less to more work: the price may stay the same, never drop
function rising(label, jobs, company, cname) {
  let prev = null;
  for (const [name, j] of jobs) {
    const p = price(j, company);
    assert.ok(Number.isFinite(p), `${cname} ${label} ${name}: price ${p}`);
    if (prev) assert.ok(p >= prev.p, `${cname}: ${label}: ${prev.name} $${prev.p} → ${name} $${p}`);
    prev = { name, p };
  }
}

for (const [cname, co] of Object.entries(COMPANIES)) {
  test(`${cname} company: tree jobs never get cheaper with more work`, () => {
    for (const work of ['remove', 'trim', 'cable']) {
      for (const access of ['open', 'driveway', 'backyard', 'tight']) {
        for (const hazards of [{}, { powerLines: true }, { overHouse: true, dead: true }]) {
          const tag = `${work}/${access}/${Object.keys(hazards).join('+') || 'none'}`;
          rising(`${tag} height`, [...Array(20)].map((_, i) => [`${10 + i * 5} ft`, T({ access, hazards }, [{ work, heightFt: 10 + i * 5 }])]), co, cname);
          rising(`${tag} trunk`, [...Array(12)].map((_, i) => [`${6 + i * 4} in`, T({ access, hazards }, [{ work, heightFt: 50, dbhIn: 6 + i * 4 }])]), co, cname);
          rising(`${tag} count`, [...Array(6)].map((_, i) => [`×${i + 1}`, T({ access, hazards }, [{ work, qty: i + 1 }])]), co, cname);
        }
      }
      rising(`${work} access`, ['open', 'driveway', 'backyard', 'tight'].map((a) => [a, T({ access: a }, [{ work, heightFt: 50 }])]), co, cname);
      rising(`${work} distance`, [0, 5, 15, 30, 60, 100].map((m) => [`${m} mi`, T({}, [{ work }], { miles: m })]), co, cname);
    }
    rising('stump size', [...Array(12)].map((_, i) => [`${6 + i * 4} in`, T({}, [{ work: 'stump', dbhIn: 6 + i * 4 }])]), co, cname);
    for (const h of [20, 40, 70]) {
      rising(`debris ${h} ft`, ['leave', 'chipLeaveLogs', 'haul'].map((d) => [d, T({ debris: d }, [{ heightFt: h }])]), co, cname);
      rising(`trim level ${h} ft`, ['light', 'standard', 'heavy'].map((l) => [l, T({ trimLevel: l }, [{ work: 'trim', heightFt: h }])]), co, cname);
      rising(`extras ${h} ft`, [['none', T({}, [{ heightFt: h }])], ['stump', T({ stumps: true }, [{ heightFt: h }])], ['+lawn', T({ stumps: true, restore: true }, [{ heightFt: h }])]], co, cname);
      rising(`second tree ${h} ft`, [['one', T({}, [{ heightFt: h }])], ['two', T({}, [{ heightFt: h }, { heightFt: 15, species: 'pine' }])]], co, cname);
      for (const k of ['powerLines', 'overHouse', 'nearStructure', 'dead', 'leaning', 'fenceGarden']) rising(`${k} ${h} ft`, [['no', T({}, [{ heightFt: h }])], ['yes', T({ hazards: { [k]: true } }, [{ heightFt: h }])]], co, cname);
      for (const k of Object.keys(co.multipliers.conditions)) rising(`${k} ${h} ft`, [['no', T({}, [{ heightFt: h }])], ['yes', T({}, [{ heightFt: h }], { conditions: { [k]: true } })]], co, cname);
      for (const k of ['emergency', 'storm', 'weekend', 'holiday', 'permit']) rising(`${k} ${h} ft`, [['no', T({}, [{ heightFt: h }])], ['yes', T({}, [{ heightFt: h }], { [k]: true })]], co, cname);
      const o = Object.fromEntries(buildOptions(T({}, [{ heightFt: h }]), PB, undefined, co).map((x) => [x.id, x.est.price]));
      assert.ok(o.basic <= o.standard && o.standard <= o.complete, `${cname} ${h} ft options ${JSON.stringify(o)}`);
    }
  });

  test(`${cname} company: snow visits never get cheaper with more work`, () => {
    const areas = [0, 250, 500, 1000, 1499, 1500, 2500, 5000, 14999, 15000, 30000, 43560, 65340, 65341, 100000];
    for (const property of ['residential', 'commercial']) {
      for (const method of ['auto', 'plow', 'skid', 'loader', 'blower', 'shovel']) {
        for (const depthIn of [2, 8]) rising(`${property}/${method}/${depthIn} in area`, areas.map((a) => [`${a} sq ft`, S({ property, method, depthIn, areaSqft: a })]), co, cname);
      }
      rising(`${property} depth`, [1, 2, 3, 4, 6, 8, 10, 12, 18, 24].map((d) => [`${d} in`, S({ property, depthIn: d, areaSqft: property === 'commercial' ? 20000 : 1000 })]), co, cname);
      for (const a of [1000, 20000]) {
        rising(`${property} walks @${a}`, [0, 30, 60, 150, 300, 301, 600, 601, 1200, 2000].map((w) => [`${w} ft`, S({ property, areaSqft: a, walkLf: w })]), co, cname);
        rising(`${property} roof @${a}`, [0, 800, 1500, 3000].map((r) => [`${r} sq ft`, S({ property, areaSqft: a, roofSqft: r })]), co, cname);
        rising(`${property} obstacles @${a}`, ['low', 'med', 'high'].map((x) => [x, S({ property, areaSqft: a, obstacles: x })]), co, cname);
        for (const k of ['salt', 'haul', 'priority']) rising(`${property} ${k} @${a}`, [['no', S({ property, areaSqft: a })], ['yes', S({ property, areaSqft: a, [k]: true })]], co, cname);
        for (const k of Object.keys(co.multipliers.conditions)) rising(`${property} ${k} @${a}`, [['no', S({ property, areaSqft: a })], ['yes', S({ property, areaSqft: a }, { conditions: { [k]: true } })]], co, cname);
        const j = S({ property, areaSqft: a });
        const tiers = snowDepthTiers(j, PB, undefined, co).map((t) => t.price);
        assert.ok(tiers.every((p, i) => !i || p >= tiers[i - 1]), `${cname} ${property} ${a} depth tiers ${tiers}`);
        const o = Object.fromEntries(buildOptions(j, PB, undefined, co).map((x) => [x.id, x.est.price]));
        assert.ok(o.salt >= o.push && o.seasonal >= o.push, `${cname} ${property} ${a} options ${JSON.stringify(o)}`);
      }
      rising('home vs business', [['home', S({ areaSqft: 5000 })], ['business', S({ areaSqft: 5000, property: 'commercial' })]], co, cname);
    }
  });
}

// ---------- random pairs: one "more / bigger / harder" change never lowers the price ----------

test('random jobs: one more-work change never lowers the price', () => {
  let seed = +(process.env.SENSE_SEED || 20261106);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const up = (arr, v) => arr[Math.min(arr.length - 1, arr.indexOf(v) + 1)];
  const HZ = ['powerLines', 'overHouse', 'nearStructure', 'dead', 'leaning', 'fenceGarden'];
  const TC = ['steepSlope', 'nearRoad', 'vehicles', 'narrowGate', 'longDrag', 'largeLogs', 'denseBrush', 'heavyCleanup', 'wet', 'frozen', 'limitedAccess', 'longTravel'];
  const SC = ['steepSlope', 'wet', 'frozen', 'heavySnow', 'ice', 'tightAreas', 'snowPiles', 'limitedAccess', 'longTravel'];
  const ACC = ['open', 'driveway', 'backyard', 'tight'];
  const DEB = ['leave', 'chipLeaveLogs', 'haul'];
  const randTree = () => {
    const j = T({ access: pick(ACC), debris: pick(DEB), trimLevel: pick(['light', 'standard', 'heavy']), stumps: rnd() < 0.4, restore: rnd() < 0.2, firewood: rnd() < 0.2, hazards: Object.fromEntries(HZ.filter(() => rnd() < 0.15).map((k) => [k, true])) },
      Array.from({ length: rnd() < 0.7 ? 1 : int(2, 3) }, () => ({ work: pick(['remove', 'remove', 'trim', 'stump', 'cable']), species: pick(['oak', 'maple', 'pine', 'birch', '']), heightFt: int(8, 110), dbhIn: rnd() < 0.5 ? 0 : int(4, 50), qty: int(1, 4) })),
      { miles: int(0, 60), conditions: Object.fromEntries(TC.filter(() => rnd() < 0.1).map((k) => [k, true])), property: rnd() < 0.2 ? 'commercial' : 'residential' });
    for (const k of ['emergency', 'storm', 'weekend', 'holiday', 'permit']) j[k] = rnd() < 0.1;
    return j;
  };
  const randSnow = () => {
    const j = S({ property: rnd() < 0.5 ? 'commercial' : 'residential', areaSqft: pick([0, int(100, 3000), int(3000, 20000), int(20000, 120000)]), walkLf: rnd() < 0.5 ? 0 : int(5, 1500), roofSqft: rnd() < 0.15 ? int(200, 4000) : 0, depthIn: int(1, 20), salt: rnd() < 0.5, haul: rnd() < 0.15, priority: rnd() < 0.2, obstacles: pick(['low', 'med', 'high']), method: rnd() < 0.7 ? 'auto' : pick(['plow', 'skid', 'loader', 'blower', 'shovel']) },
      { miles: int(0, 40), conditions: Object.fromEntries(SC.filter(() => rnd() < 0.1).map((k) => [k, true])) });
    for (const k of ['emergency', 'weekend', 'holiday']) j[k] = rnd() < 0.1;
    return j;
  };
  const TREE = {
    taller: (j, i) => { j.tree.trees[i].heightFt += int(1, 20); },
    thicker: (j, i) => { if (!j.tree.trees[i].dbhIn) return false; j.tree.trees[i].dbhIn += int(1, 8); },
    more: (j, i) => { j.tree.trees[i].qty += 1; },
    addTree: (j) => { j.tree.trees.push({ ...newTree(), heightFt: int(10, 40), species: 'pine', work: pick(['remove', 'trim', 'stump']) }); },
    access: (j) => { if (j.tree.access === 'tight') return false; j.tree.access = up(ACC, j.tree.access); },
    debris: (j) => { if (j.tree.debris === 'haul') return false; j.tree.debris = up(DEB, j.tree.debris); },
    hazard: (j) => { const k = pick(HZ); if (j.tree.hazards[k]) return false; j.tree.hazards[k] = true; },
    condition: (j) => { const k = pick(TC); if (j.conditions[k]) return false; j.conditions[k] = true; },
    extra: (j) => { const k = pick(['stumps', 'restore', 'firewood']); if (j.tree[k]) return false; j.tree[k] = true; },
    timing: (j) => { const k = pick(['emergency', 'storm', 'weekend', 'holiday', 'permit']); if (j[k]) return false; j[k] = true; },
    miles: (j) => { j.miles += int(1, 30); },
  };
  const SNOW = {
    area: (j) => { j.snow.areaSqft += int(1, 20000); },
    walk: (j) => { j.snow.walkLf += int(1, 400); },
    roof: (j) => { j.snow.roofSqft += int(1, 1500); },
    depth: (j) => { j.snow.depthIn += int(1, 6); },
    extra: (j) => { const k = pick(['salt', 'haul', 'priority']); if (j.snow[k]) return false; j.snow[k] = true; },
    obstacles: (j) => { if (j.snow.obstacles === 'high') return false; j.snow.obstacles = up(['low', 'med', 'high'], j.snow.obstacles); },
    condition: (j) => { const k = pick(SC); if (j.conditions[k]) return false; j.conditions[k] = true; },
    commercial: (j) => { if (j.snow.property === 'commercial') return false; j.snow.property = 'commercial'; },
    miles: (j) => { j.miles += int(1, 30); },
  };
  const cos = Object.values(COMPANIES);
  const N = +(process.env.SENSE_N || 2500);
  for (let n = 0; n < N; n++) {
    const co = pick(cos);
    const isTree = rnd() < 0.55;
    const a = isTree ? randTree() : randSnow();
    const moves = isTree ? TREE : SNOW;
    const name = pick(Object.keys(moves));
    const b = structuredClone(a);
    if (moves[name](b, int(0, b.tree.trees.length - 1)) === false) continue;
    const pa = price(a, co);
    const pb = price(b, co);
    assert.ok(pb >= pa, `pair ${n} (${isTree ? 'tree' : 'snow'} ${name}, company ${cos.indexOf(co)}): $${pa} → $${pb}\n${JSON.stringify({ a: isTree ? a.tree : a.snow, b: isTree ? b.tree : b.snow })}`);
  }
});

// ---------- equipment and crew the way a contractor would do it ----------

const est = (j, company = sample) => calc(j, PB, { company });
const has = (e, type) => e.equipment.some((q) => q.key === type);

test('auto equipment is never dearer than any safe way the estimator could pick', () => {
  for (const [j, ways] of [
    [T({}, [{ heightFt: 20, species: 'maple' }]), ['climb', 'bucket', 'lift', 'crane']],
    [T({}, [{ heightFt: 50 }]), ['bucket', 'lift', 'crane']],
    [T({ access: 'backyard' }, [{ heightFt: 50 }]), ['climb', 'lift', 'crane']],
    [T({ access: 'tight' }, [{ heightFt: 50 }]), ['climb', 'crane']],
  ]) {
    const auto = est(j);
    for (const m of ways) { const k = structuredClone(j); k.tree.method = m; assert.ok(auto.price <= est(k).price, `auto $${auto.price} > ${m} $${est(k).price}`); }
  }
  for (const a of [500, 1000, 2500, 20000, 87120]) {
    const auto = est(S({ areaSqft: a, property: a > 5000 ? 'commercial' : 'residential' }));
    for (const m of ['plow', 'skid', 'loader', 'blower', 'shovel']) assert.ok(auto.price <= est(S({ areaSqft: a, property: a > 5000 ? 'commercial' : 'residential', method: m })).price, `snow ${a} sq ft: auto dearer than ${m}`);
  }
});

test('safety comes before price: big trees get a crane, dead wood is not climbed', () => {
  assert.equal(est(T({}, [{ heightFt: 90 }])).method, 'crane');
  assert.equal(est(T({ access: 'tight' }, [{ heightFt: 90 }])).method, 'crane');
  for (const access of ['driveway', 'backyard', 'tight']) assert.notEqual(est(T({ access, hazards: { dead: true } }, [{ heightFt: 40 }])).method, 'climb', access);
  // ...but a small dead tree over a house is not a crane job
  assert.notEqual(est(T({ hazards: { overHouse: true, dead: true } }, [{ heightFt: 20 }])).method, 'crane');
});

test('no machine is billed for time it is not used', () => {
  for (const j of [T({}, [{ work: 'cable' }]), T({ access: 'backyard' }, [{ work: 'cable' }]), T({}, [{ heightFt: 15 }]), T({ hazards: { overHouse: true, dead: true } }, [{ heightFt: 20 }]), S({ areaSqft: 0, roofSqft: 1500 })]) {
    const e = est(j);
    for (const q of e.equipment) assert.ok(q.hours > 0, `${q.label} billed for ${q.hours} h`);
  }
  // cabling is a 2-person climbing job
  const c = est(T({}, [{ work: 'cable' }]));
  assert.equal(c.method, 'climb');
  assert.equal(c.crew, 2);
});

test('small trees: 2-person crew, one truck load, no one waits for the dump run', () => {
  const e = est(T({}, [{ heightFt: 20, species: 'maple' }]));
  assert.equal(e.crew, 2);
  assert.equal(e.loads, 1);
  assert.ok(e.materials.some((m) => /one load/.test(m.label)));
  assert.ok(!e.notes.some((n) => /waits|recommended for/.test(n)), e.notes.join(' | '));
  assert.ok(e.tasks.filter((t) => t.id === 'hauling').every((t) => t.workers === 1));
});

test('backyard gates: no wheel loader or grapple truck goes through them', () => {
  const e = est(T({ access: 'backyard' }, [{ heightFt: 85 }]));
  assert.ok(!e.equipment.some((q) => ['loader', 'grapple'].includes(q.key)), e.equipment.map((q) => q.label).join(', '));
});

test('snow: short home walks are done by the operator; long walks get a crew that shares the work', () => {
  const home = est(S({ areaSqft: 1000, walkLf: 60 }));
  assert.equal(home.crew, 1);
  const lot = est(S({ areaSqft: 43560, property: 'commercial', walkLf: 1200 }));
  assert.ok(lot.crew >= 2);
  assert.ok(!lot.notes.some((n) => /No extra worker/.test(n)));
});

test('snow: no idle dump trucks are billed while a loader is the bottleneck', () => {
  const e = est(S({ areaSqft: 60000, property: 'commercial', depthIn: 10, haul: true }));
  const haul = e.tasks.find((t) => t.id === 'snow_hauling');
  const trucks = e.equipment.filter((q) => q.key === 'dump_truck');
  assert.ok(haul && trucks.length >= 1);
  for (const q of trucks) assert.ok(q.hours <= haul.hours + 0.01);
});

test('seasonal contracts include salt only when the customer wants salt', () => {
  const noSalt = buildOptions(S({ areaSqft: 1000, contract: 'seasonal' }), PB, undefined, sample).find((o) => o.id === 'seasonal');
  const salt = buildOptions(S({ areaSqft: 1000, contract: 'seasonal', salt: true }), PB, undefined, sample).find((o) => o.id === 'seasonal');
  assert.ok(salt.est.price > noSalt.est.price);
  assert.ok(!noSalt.scope.some((l) => /salt/i.test(l)));
  assert.ok(salt.scope.some((l) => /salt/i.test(l)));
});

// rough 2024–25 US price ranges for an insured company (consumer guides and contractor rate sheets),
// with the sample crew, fleet and default price book. Wide on purpose: they catch nonsense, not cents.
test('typical jobs land in realistic price ranges', () => {
  const rows = [
    ['remove 15 ft ornamental', T({}, [{ heightFt: 15, species: 'dogwood' }]), 200, 900],
    ['remove 20 ft maple', T({}, [{ heightFt: 20, species: 'maple' }]), 300, 1100],
    ['remove 40 ft oak', T({}, [{ heightFt: 40 }]), 800, 2600],
    ['remove 60 ft oak', T({}, [{ heightFt: 60 }]), 1500, 4500],
    ['remove 80 ft oak', T({}, [{ heightFt: 80 }]), 3000, 9000],
    ['trim 40 ft maple', T({}, [{ work: 'trim', heightFt: 40, species: 'maple' }]), 400, 1500],
    ['cable 40 ft oak', T({}, [{ work: 'cable', heightFt: 40 }]), 300, 1100],
    ['grind 1 stump 24 in', T({}, [{ work: 'stump', dbhIn: 24 }]), 150, 500],
    ['plow 2-car driveway', S({ areaSqft: 1000 }), 30, 100],
    ['plow 1 acre lot', S({ areaSqft: 43560, property: 'commercial' }), 150, 500],
    ['roof 1500 sq ft', S({ areaSqft: 0, roofSqft: 1500 }), 250, 750],
  ];
  for (const [name, j, lo, hi] of rows) { const p = price(j); assert.ok(p >= lo && p <= hi, `${name}: $${p} (expected $${lo}–$${hi})`); }
});

// ---------- cut down from the ground, in one piece ----------

test('cut down from the ground: cheapest way when there is room, and it still rises with size', () => {
  for (const [cname, co] of Object.entries(COMPANIES)) {
    const F = (tree = {}, trees = [{}], job = {}) => T({ method: 'fell', ...tree }, trees, job);
    rising('fell height', [...Array(20)].map((_, i) => [`${10 + i * 5} ft`, F({}, [{ heightFt: 10 + i * 5 }])]), co, cname);
    rising('fell trunk', [...Array(12)].map((_, i) => [`${6 + i * 4} in`, F({}, [{ heightFt: 50, dbhIn: 6 + i * 4 }])]), co, cname);
    rising('fell count', [...Array(6)].map((_, i) => [`×${i + 1}`, F({}, [{ qty: i + 1 }])]), co, cname);
    rising('fell access', ['open', 'driveway', 'backyard', 'tight'].map((a) => [a, F({ access: a }, [{ heightFt: 50 }])]), co, cname);
    rising('fell debris', ['leave', 'chipLeaveLogs', 'haul'].map((d) => [d, F({ debris: d })]), co, cname);
    // anything that rules out dropping it whole can only raise the price
    for (const k of ['powerLines', 'overHouse', 'nearStructure', 'fenceGarden', 'dead', 'leaning']) rising(`fell + ${k}`, [['clear', F()], [k, F({ hazards: { [k]: true } })]], co, cname);
    for (const k of ['vehicles', 'nearRoad', 'steepSlope']) rising(`fell + ${k}`, [['clear', F()], [k, F({}, [{}], { conditions: { [k]: true } })]], co, cname);
  }
  for (const h of [20, 40, 60]) {
    const fell = est(T({ method: 'fell' }, [{ heightFt: h }]));
    const auto = est(T({}, [{ heightFt: h }]));
    assert.equal(fell.method, 'fell');
    assert.ok(fell.price < auto.price, `${h} ft: in one piece $${fell.price} should beat in sections $${auto.price}`);
    assert.ok(!fell.equipment.some((q) => ['bucket_truck', 'crane', 'spider_lift', 'climbing_gear'].includes(q.key)), fell.equipment.map((q) => q.label).join(', '));
    assert.ok(fell.safety.some((s) => /drop zone/.test(s)));
  }
  const blocked = est(T({ method: 'fell', hazards: { powerLines: true } }));
  assert.notEqual(blocked.method, 'fell');
  assert.ok(blocked.notes.some((n) => /Can't cut it down in one piece because power lines/.test(n)));
});
