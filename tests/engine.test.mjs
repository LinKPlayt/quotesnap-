import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDescription, applyParsed, newJob, calc, buildOptions, scopeOfWork, snowDepthTiers, totals, recommendMethod } from '../js/engine.js';
import { DEFAULT_PRICEBOOK as PB } from '../js/pricebook.js';

const jobFrom = (text) => applyParsed(newJob(), parseDescription(text));

test('parses the headline example', () => {
  const p = parseDescription('Tree removal. 45-foot oak. Backyard access. Requires bucket truck.');
  assert.equal(p.division, 'tree');
  assert.deepEqual(p.tree.trees[0], { work: 'remove', heightFt: 45, species: 'oak' });
  assert.equal(p.tree.access, 'backyard');
  assert.equal(p.tree.method, 'bucket');
});

test('headline example produces a sane, profitable quote', () => {
  const j = jobFrom('Tree removal. 45-foot oak. Backyard access. Requires bucket truck.');
  const e = calc(j, PB);
  assert.equal(e.method, 'bucket');
  assert.ok(e.price > 1200 && e.price < 5000, `price ${e.price}`);
  assert.ok(Math.abs(e.marginPct - PB.targetMarginPct) < 2, `margin ${e.marginPct}`);
  assert.ok(e.equipment.some((q) => q.key === 'bucket'));
  assert.ok(e.equipment.some((q) => q.key === 'chipper'));
  assert.ok(scopeOfWork(j, e)[0].includes('45 ft Oak'));
});

test('good/better/best options increase in price', () => {
  const opts = buildOptions(jobFrom('Remove 50 ft maple near the garage'), PB);
  assert.deepEqual(opts.map((o) => o.id), ['basic', 'standard', 'complete']);
  assert.ok(opts[0].est.price < opts[1].est.price && opts[1].est.price < opts[2].est.price);
  assert.equal(opts.filter((o) => o.recommended).length, 1);
});

test('hazards raise price and add safety notes', () => {
  const plain = calc(jobFrom('Remove 50 ft oak in open field'), PB);
  const risky = calc(jobFrom('Remove 50 ft dead oak over the house near power lines'), PB);
  assert.ok(risky.price > plain.price * 1.3);
  assert.ok(risky.safety.length >= 2);
  assert.ok(risky.crew > plain.crew);
});

test('equipment recommendation', () => {
  const t = newJob().tree;
  assert.equal(recommendMethod({ ...t, trees: [{ work: 'remove', heightFt: 90 }] }).method, 'crane');
  assert.equal(recommendMethod({ ...t, access: 'tight', trees: [{ work: 'remove', heightFt: 40 }] }).method, 'climb');
  assert.equal(recommendMethod({ ...t, access: 'driveway', trees: [{ work: 'remove', heightFt: 40 }] }).method, 'bucket');
  assert.equal(recommendMethod({ ...t, access: 'backyard', trees: [{ work: 'remove', heightFt: 40 }] }).method, 'lift');
});

test('quantity and stump-only jobs', () => {
  const one = calc(jobFrom('Remove one 40 ft pine, front yard'), PB);
  const three = calc(jobFrom('Remove three 40 ft pines, front yard'), PB);
  assert.ok(three.price > one.price * 2);
  const stumps = calc(jobFrom('Grind 3 stumps about 20 inch'), PB);
  assert.equal(stumps.stumpCount, 3);
  assert.ok(stumps.price >= PB.minJobTree);
});

test('emergency multiplies labor', () => {
  const a = calc(jobFrom('Remove 40 ft maple'), PB);
  const b = calc(jobFrom('Emergency storm: remove 40 ft maple'), PB);
  assert.ok(b.laborCost > a.laborCost * 1.4);
});

test('snow parsing and pricing', () => {
  const j = jobFrom('Plow 2-car driveway and shovel front walk, salt. 6 inch storm.');
  assert.equal(j.division, 'snow');
  assert.equal(j.snow.areaSqft, 1000);
  assert.equal(j.snow.depthIn, 6);
  assert.ok(j.snow.salt && j.snow.walkLf > 0);
  const opts = buildOptions(j, PB);
  assert.deepEqual(opts.map((o) => o.id), ['push', 'salt', 'seasonal']);
  assert.ok(opts[0].est.price >= PB.minJobSnow && opts[0].est.price < 200);
  assert.ok(opts[2].est.monthly > 0);
  const tiers = snowDepthTiers(j, PB);
  assert.ok(tiers.every((t, i) => i === 0 || t.price >= tiers[i - 1].price));
});

test('commercial lot uses heavier equipment', () => {
  const j = jobFrom('Commercial parking lot 40,000 sq ft, salt');
  const e = calc(j, PB);
  assert.equal(e.method, 'skid');
  assert.ok(e.saltLbs > 400);
});

test('totals apply adjustments, discount, tax and deposit', () => {
  const t = totals(1000, { discount: 100, adjustments: [{ amount: 50 }], taxPct: 10, depositPct: 25 });
  assert.equal(t.subtotal, 950);
  assert.equal(t.tax, 95);
  assert.equal(t.total, 1045);
  assert.equal(t.deposit, 262);
});
