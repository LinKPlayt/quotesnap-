// Pricing questions: simple screens ask only what really moves the price; detailed mode asks the rest.
// Every answer must reach the planner as the same fields the Details card edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newJob, newTree, calc } from '../js/engine.js';
import { defaultCompany } from '../js/company.js';
import { mergePricebook } from '../js/pricebook.js';
import { jobQuestions, openQuestions, applyAnswer, currentAnswer, isAnswered, questionSummary } from '../js/questions.js';

const PB = mergePricebook({});
const company = defaultCompany();
const ctx = { company, pricebook: PB, canFindMiles: false }; // simple (the default)
const full = { ...ctx, simple: false };
const est = (division = 'tree', fn) => { const e = { job: newJob(division), locks: {}, aiFields: [], customer: {} }; fn?.(e); return e; };
const ids = (qs) => qs.map((q) => q.id);
const q = (e, id, c = ctx) => jobQuestions(e, c).find((x) => x.id === id);
const price = (e) => calc(e.job, PB, { company }).price;

test('simple screens: a tree quote asks only the few questions that move the price', () => {
  const got = ids(openQuestions(est('tree'), ctx));
  assert.deepEqual(got, ['job.division', 'tree.count', 'tree.0.work', 'tree.0.height', 'tree.access', 'tree.hazards', 'tree.down', 'tree.after', 'job.miles']);
  // after photos (job type) and GPS (distance) only 7 are left
  assert.equal(openQuestions(est('tree', (x) => { x.ai = {}; x.job.miles = 9; }), ctx).length, 7);
});

test('simple screens: a snow quote asks home or business, size, walks, salt, how to pay, distance', () => {
  const e = est('snow', (x) => { x.locks['job.division'] = true; });
  assert.deepEqual(ids(openQuestions(e, ctx)), ['snow.property', 'snow.area', 'snow.walks', 'snow.salt', 'snow.contract', 'job.miles']);
});

test('detailed mode asks the rest too', () => {
  const t = ids(openQuestions(est('tree'), full));
  for (const id of ['tree.0.trunk', 'tree.0.species', 'tree.conditions', 'tree.property', 'tree.permit', 'job.timing']) assert.ok(t.includes(id), `missing ${id}`);
  const s = ids(openQuestions(est('snow'), full));
  for (const id of ['snow.depth', 'snow.surface', 'snow.obstacles', 'snow.conditions', 'snow.roof', 'snow.haul', 'snow.priority', 'job.timing']) assert.ok(s.includes(id), `missing ${id}`);
  assert.ok(!s.includes('snow.events'), 'storms per season only for seasonal contracts');
});

test('choices are short and plain', () => {
  const e = est('tree');
  for (const qq of jobQuestions(e, ctx)) assert.ok(qq.options.length <= 6, `${qq.id} has ${qq.options.length} choices`);
  assert.equal(q(e, 'tree.access').options.length, 3);
  assert.equal(q(e, 'tree.hazards').options.length, 4);
  assert.equal(q(e, 'tree.access', full).options.length, 4);
  assert.equal(q(e, 'tree.hazards', full).options.length, 6);
});

test('how it comes down: in one piece is offered only when there is room for it to fall', () => {
  const e = est('tree');
  assert.deepEqual(q(e, 'tree.down').options.map((o) => o.id), ['fell', 'auto']);
  for (const block of [{ powerLines: true }, { overHouse: true }, { fenceGarden: true }]) assert.ok(!q(est('tree', (x) => { x.job.tree.hazards = block; }), 'tree.down'), JSON.stringify(block));
  assert.ok(!q(est('tree', (x) => { x.job.tree.access = 'tight'; }), 'tree.down'));
  assert.ok(!q(est('tree', (x) => { x.job.tree.trees[0].work = 'trim'; }), 'tree.down'), 'only for removals');
  applyAnswer(e, q(e, 'tree.down'), 'fell');
  assert.equal(e.job.tree.method, 'fell');
  assert.equal(calc(e.job, PB, { company }).method, 'fell');
});

test('what happens after: the wood and the stump in one question', () => {
  const e = est('tree');
  const a = q(e, 'tree.after');
  assert.deepEqual(a.paths, ['job.tree.debris', 'job.tree.stumps']);
  applyAnswer(e, a, 'haulStump');
  assert.equal(e.job.tree.debris, 'haul');
  assert.equal(e.job.tree.stumps, true);
  assert.equal(currentAnswer(e, a), 'haulStump');
  applyAnswer(e, a, 'leaveWood');
  assert.deepEqual([e.job.tree.debris, e.job.tree.stumps], ['chipLeaveLogs', false]);
  // a trim asks only about the branches
  const t = est('tree', (x) => { x.job.tree.trees[0].work = 'trim'; });
  assert.deepEqual(q(t, 'tree.after').paths, ['job.tree.debris']);
});

test('questions follow the answers', () => {
  const e = est('tree');
  assert.ok(!q(e, 'tree.trimLevel'));
  applyAnswer(e, q(e, 'tree.0.work'), 'trim');
  assert.ok(q(e, 'tree.trimLevel'), 'trim work asks how much trimming');
  applyAnswer(e, q(e, 'tree.0.work'), 'stump');
  assert.ok(q(e, 'tree.0.stumpsize') && !q(e, 'tree.0.height'), 'stump-only asks stump size, not height');
  assert.ok(q(e, 'tree.access') && !q(e, 'tree.hazards') && !q(e, 'tree.after'), 'a stump job skips hazards and wood');
  assert.ok(q(e, 'tree.restore', full));
  const d = est('tree', (x) => { x.job.tree.debris = 'chipLeaveLogs'; });
  assert.ok(q(d, 'tree.firewood', full));

  const s = est('snow');
  applyAnswer(s, q(s, 'snow.contract'), 'seasonal');
  assert.ok(q(s, 'snow.events', full) && !q(s, 'snow.events'), 'storms per season: detailed only, the price book has a default');
  applyAnswer(s, q(s, 'snow.property'), 'commercial');
  assert.ok(q(s, 'snow.area').options.some((o) => /lot/i.test(o.label)), 'business sizes are lots');
});

test('several trees: each one is asked about, and count is not', () => {
  const e = est('tree', (x) => { x.job.tree.trees = [newTree(), newTree(), newTree()]; });
  const got = ids(jobQuestions(e, ctx));
  for (const i of [0, 1, 2]) assert.ok(got.includes(`tree.${i}.height`) && got.includes(`tree.${i}.work`));
  assert.ok(!got.includes('tree.count'));
  assert.match(q(e, 'tree.2.height').title, /^Tree 3 of 3/);
});

test('answering writes the job fields, locks them and marks the question done', () => {
  const e = est('tree');
  const h = q(e, 'tree.0.height');
  const paths = applyAnswer(e, h, '90');
  assert.deepEqual(paths, ['job.tree.trees.0.heightFt']);
  assert.equal(e.job.tree.trees[0].heightFt, 90);
  assert.ok(e.locks['job.tree.trees.0.heightFt']);
  assert.ok(isAnswered(e, h));
  assert.ok(!ids(openQuestions(e, ctx)).includes('tree.0.height'));
});

test('tick-all questions: none clears every box, a pick sets only those', () => {
  const e = est('tree', (x) => { x.job.tree.hazards = { dead: true }; x.aiFields = ['job.tree.hazards.dead']; });
  const hz = q(e, 'tree.hazards', full);
  assert.deepEqual(currentAnswer(e, hz), ['dead'], 'AI guess shown as the starting answer');
  assert.ok(!isAnswered(e, hz), 'AI guesses are still asked');
  applyAnswer(e, hz, ['powerLines', 'overHouse']);
  assert.deepEqual(e.job.tree.hazards, { powerLines: true, overHouse: true, nearStructure: false, dead: false, leaning: false, fenceGarden: false });
  assert.deepEqual(e.aiFields, []);
  applyAnswer(e, hz, []);
  assert.ok(Object.values(e.job.tree.hazards).every((v) => v === false));
});

test('a field changed by hand on the Details card counts as answered', () => {
  const e = est('tree', (x) => { x.locks['job.tree.access'] = true; x.locks['job.conditions.wet'] = true; x.locks['job.tree.stumps'] = true; });
  const got = ids(openQuestions(e, full));
  assert.ok(!got.includes('tree.access') && !got.includes('tree.conditions') && !got.includes('tree.after'));
});

test('distance found by GPS or address is not asked; an AI or empty distance is', () => {
  assert.ok(ids(openQuestions(est('tree'), ctx)).includes('job.miles'));
  assert.ok(!ids(openQuestions(est('tree', (x) => { x.job.miles = 12; }), ctx)).includes('job.miles'));
  assert.ok(ids(openQuestions(est('tree', (x) => { x.job.miles = 12; x.aiFields = ['job.miles']; }), ctx)).includes('job.miles'));
  assert.ok(q(est('tree'), 'job.miles').auto === null);
  assert.ok(jobQuestions(est('tree'), { ...ctx, canFindMiles: true }).find((x) => x.id === 'job.miles').auto);
});

test('photos or notes settle the job type', () => {
  assert.ok(!ids(openQuestions(est('tree', (x) => { x.ai = {}; }), ctx)).includes('job.division'));
  assert.ok(!ids(openQuestions(est('tree', (x) => { x.job.description = 'oak removal'; }), ctx)).includes('job.division'));
});

test('every answer to every question (simple and detailed) prices cleanly', () => {
  for (const c of [ctx, full]) {
    for (const division of ['tree', 'snow']) {
      const base = est(division);
      for (const qq of jobQuestions(base, c)) {
        const choices = qq.kind === 'many' ? [[], qq.options.map((o) => o.id)] : qq.options.map((o) => o.id);
        for (const v of choices) {
          const e = structuredClone(base);
          applyAnswer(e, jobQuestions(e, c).find((x) => x.id === qq.id), v);
          const p = price(e);
          assert.ok(Number.isFinite(p) && p > 0, `${qq.id}=${v} gave ${p}`);
        }
      }
    }
  }
});

test('answers that should cost more do cost more', () => {
  const answer = (division, pairs, c = full) => {
    const e = est(division);
    for (const [id, v] of pairs) applyAnswer(e, jobQuestions(e, c).find((x) => x.id === id), v);
    return price(e);
  };
  const t = (pairs, c) => answer('tree', [['tree.0.height', '45'], ['job.miles', '8'], ...pairs], c);
  assert.ok(t([['tree.0.height', '90']]) > t([]), 'taller tree');
  assert.ok(t([['tree.count', '3']]) > t([]), 'more trees');
  assert.ok(t([['tree.access', 'tight']]) > t([['tree.access', 'open']]), 'no equipment access');
  assert.ok(t([['tree.hazards', ['powerLines', 'overHouse']]]) > t([['tree.hazards', []]]), 'hazards');
  assert.ok(t([['tree.after', 'haulStump']], ctx) > t([['tree.after', 'haul']], ctx), 'stump grinding');
  assert.ok(t([['tree.after', 'haul']], ctx) > t([['tree.after', 'leaveAll']], ctx), 'hauling');
  assert.ok(t([['tree.down', 'auto']], ctx) > t([['tree.down', 'fell']], ctx), 'in one piece is cheaper than in sections');
  assert.ok(t([['job.timing', ['emergency']]]) > t([['job.timing', []]]), 'emergency');
  assert.ok(t([['job.miles', '65']]) > t([['job.miles', '2']]), 'distance');
  const s = (pairs) => answer('snow', [['snow.area', '1000'], ['job.miles', '8'], ...pairs]);
  assert.ok(s([['snow.area', '2500']]) >= s([['snow.area', '1000']]) && s([['snow.area', '4000']]) > s([['snow.area', '500']]), 'bigger driveway');
  assert.ok(s([['snow.salt', 'yes']]) > s([['snow.salt', 'no']]), 'salt');
  assert.ok(s([['snow.walks', '150']]) > s([['snow.walks', '0']]), 'sidewalks');
  assert.ok(s([['snow.depth', '12']]) > s([['snow.depth', '2']]), 'deeper snow');
});

test('summary counts what is left', () => {
  for (const c of [ctx, full]) {
    const e = est('tree');
    const before = questionSummary(e, c);
    assert.equal(before.done + before.open, before.total);
    // answering can reveal follow-up questions; answer until none are left
    for (let i = 0; i < 6; i++) for (const qq of openQuestions(e, c, { requiredOnly: true })) applyAnswer(e, qq, qq.kind === 'many' ? [] : qq.options[0].id);
    assert.equal(questionSummary(e, c).openRequired, 0);
  }
});
