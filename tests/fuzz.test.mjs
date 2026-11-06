// Fuzz tests: thousands of random, broken and extreme inputs, checked against invariants.
// Seeded, so a failure can be replayed: FUZZ_SEED=123 FUZZ_N=5000 npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calc, buildOptions, snowDepthTiers, scopeOfWork, parseDescription, parseCustomer, applyParsed, describeChanges, newJob, totals, money } from '../js/engine.js';
import { defaultCompany, newWorker, newEquipment, fleet, activeWorkers, EQUIPMENT_TYPES, ATTACHMENT_TYPES, mergeCompany } from '../js/company.js';
import { DEFAULT_PRICEBOOK, mergePricebook } from '../js/pricebook.js';
import { interpret } from '../js/localai/interpret.js';
import { compareJob, rateSuggestions, actualSiteHours, snapshotEstimate } from '../js/learning.js';
import { rng, randomText, randomJob, randomCompany, randomPricebook, finite, near } from './helpers/fuzzgen.mjs';

const N = +process.env.FUZZ_N || 600;
const SEED = +process.env.FUZZ_SEED || 20261105;

function checkEstimate(e, job, pb, company, label) {
  for (const k of ['price', 'fullCost', 'profit', 'laborCost', 'equipmentCost', 'fuelCost', 'disposalCost', 'travel', 'otherCost', 'overhead', 'siteHours', 'elapsedHours', 'personHours', 'crew', 'marginPct']) finite(e[k], `${label}.${k}`);
  assert.ok(e.price >= 0, `${label}: negative price ${e.price}`);
  assert.ok(e.fullCost >= 0, `${label}: negative cost ${e.fullCost}`);
  assert.ok(e.siteHours >= 0 && e.elapsedHours >= e.siteHours - 0.01, `${label}: hours ${e.siteHours}/${e.elapsedHours}`);
  near(e.profit, e.price - e.fullCost, 0.02, `${label}: profit = price − cost`);
  near(e.fullCost, e.laborCost + e.equipmentCost + e.fuelCost + e.disposalCost + e.travel + e.otherCost + e.overhead, 0.05, `${label}: cost breakdown adds up`);
  near(e.personHours, e.crew * e.elapsedHours, 0.05 + e.crew * 0.01, `${label}: labor-hours = crew × elapsed`);
  const minProfit = Math.max(0, +(e.division === 'snow' ? pb.profit.minProfitSnow ?? pb.profit.minProfit : pb.profit.minProfit) || 0);
  assert.ok(e.price >= e.fullCost + minProfit - 0.05, `${label}: price ${e.price} below cost ${e.fullCost} + min profit ${minProfit}`);
  assert.ok(e.price >= (e.division === 'tree' ? pb.minJobTree : pb.minJobSnow), `${label}: below minimum job`);
  const active = activeWorkers(company).length;
  if (active) assert.ok(e.crew <= active, `${label}: crew ${e.crew} > active workers ${active}`);
  for (const t of e.tasks) { finite(t.hours, `${label} task ${t.id}`); assert.ok(t.hours >= 0, `${label}: negative task ${t.id}`); }
  for (const q of e.equipment) { finite(q.cost, `${label} eq ${q.label}`); finite(q.hours, `${label} eq hours`); assert.ok(q.hours >= 0 && q.cost >= -0.001, `${label}: negative equipment line ${q.label}`); }
  // never more owned units of a type than are available
  const units = fleet(company);
  const owned = {};
  for (const q of e.equipment.filter((x) => x.owned)) (owned[q.key] ||= new Set()).add(q.label);
  for (const [type, names] of Object.entries(owned)) assert.ok(names.size <= units.filter((u) => u.type === type).length, `${label}: uses ${names.size} ${type}, only ${units.filter((u) => u.type === type).length} available`);
  const text = JSON.stringify([e.tasks.map((t) => t.label), e.notes, scopeOfWork(job, e)]);
  assert.ok(!/NaN|Infinity|undefined/.test(text), `${label}: bad text ${text.match(/.{30}(NaN|Infinity|undefined).{30}/)?.[0]}`);
}

test(`fuzz: ${N} random jobs × companies × price books never break the planner`, () => {
  const R = rng(SEED);
  for (let i = 0; i < N; i++) {
    const job = randomJob(R);
    const company = randomCompany(R);
    const pb = randomPricebook(R);
    const label = `case ${i} (seed ${SEED})`;
    let e;
    try { e = calc(job, pb, { company }); } catch (err) { throw new Error(`${label}: calc threw ${err.stack}`); }
    checkEstimate(e, job, pb, company, label);
    const opts = buildOptions(job, pb, undefined, company);
    assert.ok(opts.length >= 1, `${label}: no options`);
    assert.ok(opts.some((o) => o.recommended), `${label}: no recommended option`);
    for (const o of opts) finite(o.est.price, `${label} option ${o.id}`);
    if (job.division === 'tree') for (let k = 1; k < opts.length; k++) assert.ok(opts[k].est.price >= opts[k - 1].est.price, `${label}: options not sorted`);
    if (job.division === 'snow') {
      const tiers = snowDepthTiers(job, pb, undefined, company);
      for (const t of tiers) finite(t.price, `${label} tier`);
    }
    assert.ok(!/NaN/.test(money(e.price)), `${label}: money(NaN)`);
  }
});

test('fuzz: metamorphic rules (more margin → higher price, more trees → more cost, more crew → not slower)', () => {
  const R = rng(SEED + 1);
  for (let i = 0; i < Math.ceil(N / 3); i++) {
    const job = randomJob(R);
    job.division = 'tree';
    const company = randomCompany(R);
    const pb = mergePricebook({});
    const label = `meta ${i}`;
    const lo = calc(job, pb, { company, marginPct: 20 });
    const hi = calc(job, pb, { company, marginPct: 50 });
    assert.ok(hi.price >= lo.price, `${label}: margin 50% price ${hi.price} < margin 20% price ${lo.price}`);
    const more = structuredClone(job);
    more.tree.trees.push({ work: 'remove', species: 'oak', heightFt: 50, dbhIn: 0, qty: 1 });
    const e1 = calc(job, pb, { company });
    const e2 = calc(more, pb, { company });
    // with the same crew (same blended pay) more work is never cheaper, and with the same method too it is never fewer hours.
    // (the extra tree can bring in a better crew member or machine that speeds up the rest, which is allowed)
    const sameCrew = Math.abs(e2.labor.wage - e1.labor.wage) < 0.01;
    if (sameCrew) assert.ok(e2.fullCost >= e1.fullCost - 0.01, `${label}: adding a tree lowered cost`);
    if (sameCrew && e2.method === e1.method) assert.ok(e2.labor.personHours >= e1.labor.personHours - 0.01, `${label}: adding a tree lowered crew hours`);
    const bigger = structuredClone(company);
    for (let k = 0; k < 4; k++) bigger.workers.push(newWorker({ name: `Extra ${k}`, skill: 'expert', can: { heavy: true, truck: true, loader: true, bucket: true, chipper: true, chainsaw: true } }));
    const small = calc(job, pb, { company });
    // (a broken production rate, already flagged on the quote, can make a tool the new crew unlocks slower than hand work)
    if (!small.notes.some((n) => /production rate/.test(n))) assert.ok(calc(job, pb, { company: bigger }).siteHours <= small.siteHours + 0.01, `${label}: more skilled workers made the job slower`);
    const broken = structuredClone(company);
    broken.equipment.forEach((x) => { x.availability = 'repair'; });
    const b = calc(job, pb, { company: broken });
    assert.ok(!b.equipment.some((q) => q.owned), `${label}: used equipment that is in the shop`);
  }
});

test('fuzz: notes parser and merge never throw and stay well-formed', () => {
  const R = rng(SEED + 2);
  for (let i = 0; i < N * 2; i++) {
    const text = randomText(R);
    const p = parseDescription(text);
    assert.ok([null, 'tree', 'snow'].includes(p.division));
    for (const t of p.tree.trees || []) for (const k of ['heightFt', 'dbhIn', 'qty']) if (t[k] !== undefined) finite(t[k], `parse ${k} of "${text.slice(0, 60)}"`);
    for (const [k, v] of Object.entries(p.snow)) if (typeof v === 'number') finite(v, `parse snow.${k}`);
    const c = parseCustomer(text);
    if (c.phone) assert.match(c.phone, /^\d{3}-\d{3}-\d{4}$/);
    const before = newJob();
    const after = applyParsed(before, p, R.bool(0.3) ? { 'job.tree.trees.0.heightFt': true } : {});
    describeChanges(before, after);
    const e = calc(after, DEFAULT_PRICEBOOK, {});
    finite(e.price, `price after parsing "${text.slice(0, 60)}"`);
  }
});

const labels = JSON.parse(readFileSync(new URL('../models/tinyclip-vit-8m-16/labels.json', import.meta.url)));
function randomProbs(R) {
  const probs = {};
  for (const q of labels.questions) {
    const raw = q.classes.map(() => (R.bool(0.1) ? 0 : R.f() ** R.pick([1, 3, 8])));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    probs[q.id] = Object.fromEntries(q.classes.map((c, k) => [c.id, raw[k] / sum]));
    if (R.bool(0.03)) delete probs[q.id]; // missing question (older label file)
  }
  return probs;
}

test('fuzz: on-device AI interpreter handles any scores', () => {
  const R = rng(SEED + 3);
  for (let i = 0; i < N; i++) {
    const photos = Array.from({ length: R.int(1, 6) }, () => (R.bool(0.1) ? { error: 'unreadable' } : { probs: randomProbs(R) }));
    const notes = R.bool(0.4) ? randomText(R) : '';
    if (photos.every((p) => p.error)) { assert.throws(() => interpret(photos, { notes })); continue; }
    const r = interpret(photos, { notes, division: R.pick(['tree', 'snow']) });
    assert.ok(['tree', 'snow'].includes(r.division));
    assert.equal(r.photoCaptions.length, photos.length);
    assert.ok(['high', 'medium', 'low'].includes(r.confidence));
    for (const a of r.analysis || []) {
      assert.ok(a.confidence === null || (a.confidence >= 0 && a.confidence <= 1), `confidence ${a.confidence} for ${a.key}`);
      assert.ok(!/NaN|undefined|Infinity/.test(String(a.value)), `analysis ${a.key}: ${a.value}`);
    }
    for (const t of r.tree.trees || []) {
      if (t.heightFt !== undefined) assert.ok(t.heightFt >= 5 && t.heightFt <= 999, `height ${t.heightFt}`);
      assert.ok(t.qty >= 1);
    }
    for (const v of Object.values(r.conditions || {})) assert.equal(v, true);
  }
});

test('fuzz: learning from messy actuals', () => {
  const R = rng(SEED + 4);
  const company = defaultCompany();
  const ests = [];
  for (let i = 0; i < Math.ceil(N / 4); i++) {
    const job = randomJob(R);
    const e = calc(job, DEFAULT_PRICEBOOK, { company });
    const orig = snapshotEstimate(e, 'x');
    const start = R.pick(['', '2026-11-01T08:00', 'garbage', '2026-11-01T18:00']);
    const actual = { workers: R.num(1, 6), start, finish: R.pick(['', '2026-11-01T16:00', '2026-11-01T07:00', 'nope']), laborHours: R.num(1, 80), travelHours: R.num(0, 3), totalCost: R.num(100, 20000), price: R.num(100, 20000), fuel: R.pick(['', '12.5', 'x']) };
    const rows = compareJob(orig, actual);
    for (const row of rows) for (const k of ['est', 'act', 'diff', 'pct']) if (row[k] !== null && row[k] !== undefined) finite(+row[k], `compare ${row.label}.${k}`);
    const h = actualSiteHours(actual);
    assert.ok(h === null || (Number.isFinite(h) && h >= 0), `site hours ${h}`);
    ests.push({ id: 'e' + i, number: 'Q' + i, original: orig, actual });
  }
  for (const s of rateSuggestions(ests, company)) { finite(s.suggested, 'suggested rate'); assert.ok(s.suggested > 0, `suggested rate ${s.suggested}`); }
});

test('fuzz: saved data from older versions or corrupted storage still loads', () => {
  const R = rng(SEED + 5);
  for (let i = 0; i < 200; i++) {
    const saved = R.pick([null, {}, { workers: [{}], equipment: [{ type: 'nope' }] }, { rates: [{ id: 'tree_removal', rate: 'x' }, { id: 'custom', task: 'Mine', rate: 2 }] }, { multipliers: { conditions: { powerLines: { value: 2 } }, bogus: {} } }, randomCompany(R)]);
    const c = mergeCompany(saved);
    assert.ok(Array.isArray(c.workers) && Array.isArray(c.equipment) && c.rates.length >= 25);
    const e = calc(randomJob(R), DEFAULT_PRICEBOOK, { company: c });
    finite(e.price, 'price with merged company');
  }
});

test('fuzz: totals', () => {
  const R = rng(SEED + 6);
  for (let i = 0; i < N; i++) {
    const t = totals(R.num(0, 20000) || 0, { discount: R.num(0, 30000), adjustments: Array.from({ length: R.int(0, 4) }, () => ({ amount: R.num(-500, 2000) })), taxPct: R.pick([0, 6, 13]), depositPct: R.pick([0, 25, 50]) });
    for (const k of ['subtotal', 'tax', 'total', 'deposit']) { finite(t[k], `totals.${k}`); assert.ok(t[k] >= 0, `totals.${k} negative: ${t[k]}`); }
  }
});
