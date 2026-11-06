// Logic tests: specific business rules with exact expected outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calc, buildOptions, snowDepthTiers, totals, newJob, newTree, parseDescription, applyParsed, money, estimateDbh } from '../js/engine.js';
import { defaultCompany, newEquipment, fleet } from '../js/company.js';
import { mergePricebook } from '../js/pricebook.js';
import { clampNum } from '../js/planner.js';

const PB = mergePricebook({});
const co = (fn) => { const c = defaultCompany(); fn?.(c); return c; };
const tree = (over = {}, trees = [{ ...newTree(), heightFt: 50 }]) => { const j = newJob('tree'); Object.assign(j.tree, over, { trees }); return j; };
const snow = (over = {}) => { const j = newJob('snow'); Object.assign(j.snow, over); return j; };
const task = (e, id) => e.tasks.find((t) => t.id === id);

test('totals: discount bigger than the price never goes negative; tax after discount; deposit on total', () => {
  assert.deepEqual(totals(500, { discount: 900, taxPct: 8, depositPct: 25 }), { adj: 0, subtotal: 0, tax: 0, total: 0, deposit: 0 });
  const t = totals(1000, { discount: 200, adjustments: [{ amount: 100 }, { amount: -50 }], taxPct: 10, depositPct: 30 });
  assert.equal(t.subtotal, 850);
  assert.equal(t.tax, 85);
  assert.equal(t.total, 935);
  assert.equal(t.deposit, 281); // rounded up to the dollar
  assert.equal(money(-1234.4), '-$1,234');
});

test('debris options: leave = no hauling or disposal; chip & leave logs = brush only; haul = both', () => {
  const leave = calc(tree({ debris: 'leave' }), PB, { company: co() });
  assert.equal(leave.disposalCost, 0);
  assert.ok(!task(leave, 'hauling') && !task(leave, 'brush_chipping'));
  const chip = calc(tree({ debris: 'chipLeaveLogs' }), PB, { company: co() });
  assert.ok(chip.materials.some((m) => /brush/i.test(m.label)) && !chip.materials.some((m) => /Log disposal/.test(m.label)));
  assert.ok(!task(chip, 'log_loading'));
  const haul = calc(tree({ debris: 'haul' }), PB, { company: co() });
  assert.ok(haul.materials.some((m) => /Log disposal/.test(m.label)) && task(haul, 'log_loading') && task(haul, 'hauling'));
  assert.ok(haul.price > chip.price && chip.price > leave.price);
});

test('stumps: ground only for removals and stump-only rows, sized by diameter', () => {
  const trim = calc(tree({ stumps: true }, [{ ...newTree(), work: 'trim', heightFt: 50 }]), PB, { company: co() });
  assert.equal(trim.stumpCount, 0);
  const only = calc(tree({}, [{ ...newTree(), work: 'stump', dbhIn: 20, qty: 3 }]), PB, { company: co() });
  assert.equal(only.stumpCount, 3);
  assert.deepEqual(only.stumpSizes, [20, 20, 20]);
  assert.ok(!task(only, 'tree_removal') && task(only, 'stump_grinding'));
  const small = calc(tree({}, [{ ...newTree(), work: 'stump', dbhIn: 10 }]), PB, { company: co() });
  const big = calc(tree({}, [{ ...newTree(), work: 'stump', dbhIn: 40 }]), PB, { company: co() });
  assert.ok(task(big, 'stump_grinding').hours > task(small, 'stump_grinding').hours);
});

test('travel: inside the free radius only crew time is charged; minimum travel charge applies', () => {
  const near = calc({ ...tree(), miles: 10 }, PB, { company: co() });
  const far = calc({ ...tree(), miles: 40 }, PB, { company: co() });
  assert.ok(far.travel > near.travel);
  const pb = mergePricebook({ travel: { minCharge: 150 } });
  assert.ok(calc({ ...tree(), miles: 0 }, pb, { company: co() }).travel >= 150);
});

test('minimum job charge and minimum profit are explained', () => {
  const tiny = calc(tree({ debris: 'leave' }, [{ ...newTree(), work: 'stump', dbhIn: 4 }]), PB, { company: co() });
  assert.equal(tiny.price, PB.minJobTree);
  assert.ok(tiny.priceNotes.some((n) => /Minimum job charge/.test(n)));
});

test('rental crane uses its minimum hours', () => {
  const e = calc(tree({}, [{ ...newTree(), heightFt: 90 }]), PB, { company: co() });
  const crane = e.equipment.find((q) => q.key === 'crane');
  assert.ok(crane && !crane.owned && crane.hours >= PB.equipment.crane.min);
});

test('markups: emergency and weekend add overtime + markup; commercial snow gets the commercial markup', () => {
  const base = calc(tree(), PB, { company: co() });
  const urgent = calc({ ...tree(), emergency: true }, PB, { company: co() });
  assert.ok(urgent.labor.overtime && urgent.markups.some((m) => /Emergency/.test(m.label)));
  assert.ok(urgent.price > base.price);
  const res = calc(snow({ areaSqft: 20000, property: 'residential' }), PB, { company: co() });
  const com = calc(snow({ areaSqft: 20000, property: 'commercial' }), PB, { company: co() });
  assert.ok(com.markups.some((m) => m.label === 'Commercial') && !res.markups.some((m) => m.label === 'Commercial'));
});

test('seasonal contract math', () => {
  const j = snow({ areaSqft: 1000, salt: true, events: 10 });
  const opts = buildOptions(j, PB, undefined, co());
  const salt = opts.find((o) => o.id === 'salt').est.price;
  const season = opts.find((o) => o.id === 'seasonal').est;
  assert.equal(season.price, Math.ceil((salt * 10 * (1 - PB.snow.seasonalDiscountPct / 100)) / 25) * 25);
  assert.equal(season.monthly, Math.ceil(season.price / PB.snow.seasonMonths));
  assert.equal(season.events, 10);
  const tiers = snowDepthTiers(j, PB, undefined, co());
  for (let i = 1; i < tiers.length; i++) assert.ok(tiers[i].price >= tiers[i - 1].price);
});

test('snow: walks-only job and a job with nothing to clear still price sensibly', () => {
  const walks = calc(snow({ areaSqft: 0, walkLf: 200 }), PB, { company: co() });
  assert.ok(task(walks, 'sidewalks') && walks.price >= PB.minJobSnow);
  const none = calc(snow({ areaSqft: 0, walkLf: 0 }), PB, { company: co() });
  assert.equal(none.price, PB.minJobSnow);
});

test('options: exactly one marked "as specified"; custom combination appears when it matches no preset', () => {
  const std = buildOptions(tree({ debris: 'haul', stumps: false }), PB, undefined, co());
  assert.equal(std.filter((o) => o.recommended).length, 1);
  assert.equal(std.find((o) => o.recommended).id, 'standard');
  const custom = buildOptions(tree({ debris: 'leave', stumps: true }), PB, undefined, co());
  assert.ok(custom.some((o) => o.id === 'custom' && o.recommended));
});

test('inactive workers and equipment in the shop are never scheduled', () => {
  const c = co((x) => { x.workers.forEach((w, i) => { w.active = i < 2; }); x.equipment.find((e) => e.type === 'bucket_truck').availability = 'repair'; });
  const e = calc(tree(), PB, { company: c });
  assert.ok(e.crew <= 2);
  assert.ok(!e.equipment.some((q) => q.key === 'bucket_truck' && q.owned));
  assert.notEqual(e.method, 'bucket');
});

test('available count lower than quantity limits the fleet', () => {
  const c = co((x) => { x.equipment.push(newEquipment('dump_truck', { name: 'Extra', quantity: 5, available: 2 })); });
  assert.equal(fleet(c).filter((u) => u.recordId === c.equipment.at(-1).id).length, 2);
});

test('safety limits: absurd quantities, sizes, pay and rates are capped and explained', () => {
  assert.equal(clampNum('1000000000', 'qty', 1), 100);
  assert.equal(clampNum('abc', 'heightFt', 0), 0);
  assert.equal(clampNum(-50, 'miles', 0), 0);
  const huge = calc(tree({}, [{ ...newTree(), heightFt: 50, qty: 1e9 }]), PB, { company: co() });
  assert.equal(huge.treeLines[0].qty, 100);
  assert.ok(huge.notes.some((n) => /limited to 100/.test(n)));
  const pay = calc(tree(), PB, { company: co((x) => { x.workers.forEach((w) => { w.rate = 1e9; }); }) });
  assert.ok(pay.notes.some((n) => /pay looks wrong/.test(n)) && pay.laborCost < 1e6);
  const rate = calc(tree(), PB, { company: co((x) => { x.rates.find((r) => r.id === 'tree_removal').rate = 0.000001; }) });
  assert.ok(rate.notes.some((n) => /production rate .* looks wrong/.test(n)) && rate.price < 1e7);
  const zero = calc(tree(), PB, { company: co((x) => { x.rates.find((r) => r.id === 'tree_removal').rate = 0; }) });
  assert.ok(Number.isFinite(zero.price), 'a rate of 0 falls back to the default');
});

test('unknown saved choices fall back to normal defaults', () => {
  const j = tree({ debris: 'burn', method: 'jetpack', access: 'moon', trimLevel: 'medium' }, [{ ...newTree(), work: 'weird', heightFt: 40 }]);
  const e = calc(j, PB, { company: co() });
  assert.equal(e.config.debris, 'haul');
  assert.equal(e.treeLines[0].work, 'remove');
  assert.ok(Number.isFinite(e.price));
});

test('notes parsing: numbers in many spoken forms', () => {
  const two = applyParsed(newJob(), parseDescription('take down two 60 ft oaks'));
  assert.equal(two.tree.trees[0].qty, 2);
  assert.equal(two.tree.trees[0].heightFt, 60);
  assert.equal(applyParsed(newJob(), parseDescription('plow a 3-car driveway')).snow.areaSqft, 1500);
  assert.equal(applyParsed(newJob(), parseDescription('parking lot 40k sq ft')).snow.areaSqft, 40000);
  assert.equal(applyParsed(newJob(), parseDescription('parking lot 12,500 sq ft')).snow.areaSqft, 12500);
});

test('trunk estimate scales with height and hardwoods are thicker', () => {
  assert.ok(estimateDbh(60, 'oak') > estimateDbh(30, 'oak'));
  assert.ok(estimateDbh(50, 'oak') > estimateDbh(50, 'spruce'));
  assert.ok(estimateDbh(1, 'oak') >= 4);
});

test('equipment with a typo cost per hour is capped and explained', () => {
  const e = calc(tree(), PB, { company: co((x) => { x.equipment.forEach((q) => { q.fuel = 1e9; }); }) });
  assert.ok(e.notes.some((n) => /cost per hour looks wrong/.test(n)));
  assert.ok(e.fuelCost < 1e6);
});

test('machine jobs with no climbing gear of their own rent it for the rigging', () => {
  const c = co((x) => { x.equipment = x.equipment.filter((q) => q.type !== 'climbing_gear'); });
  const e = calc(tree({ method: 'lift' }, [{ ...newTree(), heightFt: 60 }, { ...newTree(), heightFt: 15, qty: 6 }]), PB, { company: c });
  assert.ok(e.equipment.some((q) => q.key === 'climbing_gear' && !q.owned));
});

test('a chipper slower than hand work (bad rate) is skipped and the reason given', () => {
  const e = calc(tree({ debris: 'haul' }), PB, { company: co((x) => { x.rates.find((r) => r.id === 'brush_chipping').rate = 0.0001; }) });
  assert.ok(task(e, 'brush_hand') && !task(e, 'brush_chipping'));
  assert.ok(e.notes.some((n) => /chipping rate is slower than hand work/.test(n)));
});

test('notes: "storm" is an emergency for fallen trees, not for an ordinary snow plow job', () => {
  assert.equal(parseDescription('plow 3-car driveway and salt, 6 inch storm').flags.emergency, undefined);
  assert.equal(parseDescription('storm knocked an oak onto the garage').flags.emergency, true);
  assert.equal(parseDescription('urgent: plow the lot before 6am').flags.emergency, true);
});
