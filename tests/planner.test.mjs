import test from 'node:test';
import assert from 'node:assert/strict';
import { calc, newJob, applyParsed, parseDescription } from '../js/engine.js';
import { defaultCompany, newWorker, newEquipment, fleet } from '../js/company.js';
import { DEFAULT_PRICEBOOK as PB } from '../js/pricebook.js';

const job = (text) => applyParsed(newJob(), parseDescription(text));
const co = (fn) => { const c = defaultCompany(); fn?.(c); return c; };
const removeType = (c, type) => { c.equipment = c.equipment.filter((e) => e.type !== type); };

test('labor-hours = crew × elapsed time, kept separate', () => {
  const e = calc(job('Remove 60 ft oak in the front yard, haul everything'), PB, { company: co() });
  assert.ok(e.crew >= 3);
  assert.ok(Math.abs(e.personHours - e.crew * e.elapsedHours) < 0.05);
  assert.ok(e.elapsedHours > e.siteHours, 'travel is part of elapsed time');
  assert.ok(e.tasks.some((t) => t.id === 'tree_removal') && e.tasks.some((t) => t.id === 'brush_chipping') && e.tasks.some((t) => t.id === 'hauling'));
});

test('never assumes unlimited workers: fewer people → longer job, explained', () => {
  const full = calc(job('Remove 60 ft oak, front yard'), PB, { company: co() });
  const small = calc(job('Remove 60 ft oak, front yard'), PB, { company: co((c) => { c.workers = c.workers.slice(0, 2); }) });
  assert.equal(small.crew, 2);
  assert.ok(small.siteHours > full.siteHours * 1.15);
  assert.ok(small.notes.some((n) => /only 2 workers are available/.test(n)));
});

test('inactive workers are not scheduled', () => {
  const c = co((x) => { x.workers.forEach((w, i) => { if (i > 0) w.active = false; }); });
  const e = calc(job('Remove 40 ft maple, front yard'), PB, { company: c });
  assert.equal(e.crew, 1);
  assert.ok(e.notes.some((n) => /minimum safe crew/.test(n)));
});

test('bucket truck needs a qualified operator; otherwise plans climbing', () => {
  const c = co((x) => { x.workers.forEach((w) => { w.can.bucket = false; }); });
  const e = calc(job('Remove 50 ft oak in the front yard'), PB, { company: c });
  assert.equal(e.method, 'climb');
  assert.ok(e.notes.some((n) => /no active worker can operate the bucket truck/.test(n)));
});

test('no chipper → brush handled by hand, more loads, explained', () => {
  const withC = calc(job('Remove 50 ft oak, haul everything'), PB, { company: co() });
  const noC = calc(job('Remove 50 ft oak, haul everything'), PB, { company: co((c) => removeType(c, 'chipper')) });
  assert.ok(noC.tasks.some((t) => t.id === 'brush_hand'));
  assert.ok(noC.loads >= withC.loads);
  assert.ok(noC.notes.some((n) => /No chipper/.test(n)));
});

test('missing equipment is a rental line, never an imaginary owned machine', () => {
  const e = calc(job('Remove 90 ft oak, front yard'), PB, { company: co() });
  assert.equal(e.method, 'crane');
  const crane = e.equipment.find((q) => q.key === 'crane');
  assert.equal(crane.owned, false);
  assert.ok(e.notes.some((n) => /Crane priced as a rental/.test(n)));
});

test('one loader on a big removal is a named bottleneck', () => {
  const e = calc(job('Remove three 70 ft oaks, front yard, haul everything'), PB, { company: co() });
  assert.ok(e.notes.some((n) => /Log loading takes .* only \d loaders? (is|are) available/.test(n)), e.notes.join(' | '));
});

test('dump truck bottleneck on a big haul', () => {
  const big = 'Remove three 70 ft oaks, front yard, haul everything';
  const fastLoading = (c) => { c.rates.find((r) => r.id === 'log_loading').rate = 60; c.rates.find((r) => r.id === 'brush_chipping').rate = 60; };
  const two = calc(job(big), PB, { company: co(fastLoading) });
  const one = calc(job(big), PB, { company: co((c) => { fastLoading(c); c.equipment.find((e) => e.type === 'dump_truck').available = 1; }) });
  const haul = (e) => e.tasks.find((t) => t.id === 'hauling').hours;
  assert.ok(haul(one) > haul(two));
  assert.ok(one.notes.some((n) => /only 1 dump truck is available/.test(n)));
});

test('snow: loader bottleneck when hauling snow', () => {
  const j = job('Commercial parking lot 80,000 sq ft, 10 inch');
  j.snow.haul = true;
  const c = co((x) => {
    x.equipment = x.equipment.filter((e) => e.type !== 'skid_steer'); // one loader-type machine
    x.equipment.push(newEquipment('dump_truck', { name: 'Dump truck B', quantity: 2, available: 2 }));
    x.workers.push(newWorker({ name: 'Driver 1', can: { truck: true } }), newWorker({ name: 'Driver 2', can: { truck: true } }));
    x.rates.find((r) => r.id === 'snow_loading').rate = 4;
  });
  const e = calc(j, PB, { company: c });
  assert.ok(e.tasks.some((t) => t.id === 'snow_hauling'));
  assert.ok(e.notes.some((n) => /only 1 loader is available/.test(n)), e.notes.join(' | '));
  assert.ok(e.disposalCost > 0);
});

test('snow: more plow units shorten a big lot; fewer is explained', () => {
  const j = job('Commercial parking lot 200,000 sq ft');
  const rich = calc(j, PB, { company: co((c) => { c.equipment.push(newEquipment('loader', { name: 'Loader #2', attachments: [{ type: 'snow_pusher', name: 'pusher' }] })); }) });
  const poor = calc(j, PB, { company: co() });
  const plowH = (e) => e.tasks.find((t) => /^plow_/.test(t.id)).hours;
  assert.ok(plowH(rich) < plowH(poor));
});

test('editing a production rate changes the estimate', () => {
  const base = calc(job('Remove 50 ft oak'), PB, { company: co() });
  const faster = calc(job('Remove 50 ft oak'), PB, { company: co((c) => { c.rates.find((r) => r.id === 'tree_removal').rate *= 2; }) });
  assert.ok(faster.siteHours < base.siteHours);
});

test('condition multipliers apply and can be edited', () => {
  const j = job('Remove 50 ft oak');
  const plain = calc(j, PB, { company: co() });
  const slope = { ...j, conditions: { steepSlope: true } };
  const s1 = calc(slope, PB, { company: co() });
  const s2 = calc(slope, PB, { company: co((c) => { c.multipliers.conditions.steepSlope.value = 2; }) });
  assert.ok(s1.siteHours > plain.siteHours && s2.siteHours > s1.siteHours);
  assert.ok(s1.conditions.some((x) => /Steep slope/.test(x)));
});

test('markups, minimum profit and cost breakdown', () => {
  const j = job('Remove 40 ft maple');
  const a = calc(j, PB, { company: co() });
  const wk = calc({ ...j, weekend: true }, PB, { company: co() });
  assert.ok(wk.price > a.price && wk.laborCost > a.laborCost, 'weekend: markup + overtime');
  const sum = a.laborCost + a.equipmentCost + a.fuelCost + a.disposalCost + a.travel + a.otherCost + a.overhead;
  assert.ok(Math.abs(sum - a.fullCost) < 0.05);
  const pb = structuredClone(PB);
  pb.profit.minProfit = 5000;
  const m = calc(j, pb, { company: co() });
  assert.ok(m.profit >= 5000 && m.priceNotes.some((n) => /minimum profit/.test(n)));
});

test('fleet respects quantity, availability and repair status', () => {
  const c = co();
  const trucks = () => fleet(c).filter((u) => u.type === 'dump_truck').length;
  assert.equal(trucks(), 2);
  c.equipment.find((e) => e.type === 'dump_truck').available = 1;
  assert.equal(trucks(), 1);
  c.equipment.find((e) => e.type === 'dump_truck').availability = 'repair';
  assert.equal(trucks(), 0);
});
