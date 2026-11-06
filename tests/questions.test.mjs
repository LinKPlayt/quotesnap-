// Pricing questions: the app must ask everything the price depends on, and every answer must
// reach the planner as the same fields the Details card edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newJob, newTree, calc } from '../js/engine.js';
import { defaultCompany } from '../js/company.js';
import { mergePricebook } from '../js/pricebook.js';
import { jobQuestions, openQuestions, applyAnswer, currentAnswer, isAnswered, questionSummary } from '../js/questions.js';

const PB = mergePricebook({});
const company = defaultCompany();
const ctx = { company, pricebook: PB, canFindMiles: false };
const est = (division = 'tree', fn) => { const e = { job: newJob(division), locks: {}, aiFields: [], customer: {} }; fn?.(e); return e; };
const ids = (qs) => qs.map((q) => q.id);
const q = (e, id) => jobQuestions(e, ctx).find((x) => x.id === id);
const price = (e) => calc(e.job, PB, { company }).price;

test('a fresh tree quote asks every key question', () => {
  const got = ids(openQuestions(est('tree'), ctx));
  for (const id of ['job.division', 'tree.count', 'tree.0.work', 'tree.0.height', 'tree.access', 'tree.hazards', 'tree.conditions', 'tree.debris', 'tree.stumps', 'tree.property', 'job.timing', 'job.miles']) {
    assert.ok(got.includes(id), `missing ${id}`);
  }
});

test('a fresh snow quote asks every key question', () => {
  const e = est('snow', (x) => { x.locks['job.division'] = true; });
  const got = ids(openQuestions(e, ctx));
  for (const id of ['snow.property', 'snow.area', 'snow.walks', 'snow.depth', 'snow.surface', 'snow.salt', 'snow.obstacles', 'snow.contract', 'job.timing', 'job.miles']) {
    assert.ok(got.includes(id), `missing ${id}`);
  }
  assert.ok(!got.includes('job.division'));
  assert.ok(!got.includes('snow.events'), 'storms per season only for seasonal contracts');
});

test('questions follow the answers', () => {
  const e = est('tree');
  assert.ok(!q(e, 'tree.trimLevel'));
  applyAnswer(e, q(e, 'tree.0.work'), 'trim');
  assert.ok(q(e, 'tree.trimLevel'), 'trim work asks how much trimming');
  assert.ok(!q(e, 'tree.stumps'), 'no stump question without a removal');
  applyAnswer(e, q(e, 'tree.0.work'), 'stump');
  assert.ok(q(e, 'tree.0.stumpsize') && !q(e, 'tree.0.height'), 'stump-only asks stump size, not height');
  assert.ok(q(e, 'tree.restore'));
  applyAnswer(e, q(e, 'tree.debris'), 'haul');
  assert.ok(!q(e, 'tree.firewood'));
  applyAnswer(e, q(e, 'tree.debris'), 'chipLeaveLogs');
  assert.ok(q(e, 'tree.firewood'));

  const s = est('snow');
  applyAnswer(s, q(s, 'snow.contract'), 'seasonal');
  assert.ok(q(s, 'snow.events'));
  applyAnswer(s, q(s, 'snow.property'), 'commercial');
  assert.ok(q(s, 'snow.area').options.some((o) => /lot/i.test(o.label)), 'commercial sizes are lots');
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
  const paths = applyAnswer(e, h, '80');
  assert.deepEqual(paths, ['job.tree.trees.0.heightFt']);
  assert.equal(e.job.tree.trees[0].heightFt, 80);
  assert.ok(e.locks['job.tree.trees.0.heightFt']);
  assert.ok(isAnswered(e, h));
  assert.ok(!ids(openQuestions(e, ctx)).includes('tree.0.height'));
});

test('tick-all questions: none clears every box, a pick sets only those', () => {
  const e = est('tree', (x) => { x.job.tree.hazards = { dead: true }; x.aiFields = ['job.tree.hazards.dead']; });
  const hz = q(e, 'tree.hazards');
  assert.deepEqual(currentAnswer(e, hz), ['dead'], 'AI guess shown as the starting answer');
  assert.ok(!isAnswered(e, hz), 'AI guesses are still asked');
  applyAnswer(e, hz, ['powerLines', 'overHouse']);
  assert.deepEqual(e.job.tree.hazards, { powerLines: true, overHouse: true, nearStructure: false, dead: false, leaning: false, fenceGarden: false });
  assert.deepEqual(e.aiFields, []);
  applyAnswer(e, hz, []);
  assert.ok(Object.values(e.job.tree.hazards).every((v) => v === false));
});

test('a field changed by hand on the Details card counts as answered', () => {
  const e = est('tree', (x) => { x.locks['job.tree.access'] = true; x.locks['job.conditions.wet'] = true; });
  const got = ids(openQuestions(e, ctx));
  assert.ok(!got.includes('tree.access') && !got.includes('tree.conditions'));
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

test('every answer to every question changes the job the way the planner reads it', () => {
  // walk each question with each choice on a fresh quote and price it: nothing may throw or go NaN
  for (const division of ['tree', 'snow']) {
    const base = est(division);
    for (const qq of jobQuestions(base, ctx)) {
      const choices = qq.kind === 'many' ? [[], qq.options.map((o) => o.id)] : qq.options.map((o) => o.id);
      for (const v of choices) {
        const e = structuredClone(base);
        const live = jobQuestions(e, ctx).find((x) => x.id === qq.id);
        applyAnswer(e, live, v);
        const p = price(e);
        assert.ok(Number.isFinite(p) && p > 0, `${qq.id}=${v} gave ${p}`);
      }
    }
  }
});

test('answers that should cost more do cost more', () => {
  const answer = (division, pairs) => {
    const e = est(division);
    for (const [id, v] of pairs) applyAnswer(e, jobQuestions(e, ctx).find((x) => x.id === id), v);
    return price(e);
  };
  const t = (pairs) => answer('tree', [['tree.0.height', '40'], ['job.miles', '8'], ...pairs]);
  assert.ok(t([['tree.0.height', '80']]) > t([]), 'taller tree');
  assert.ok(t([['tree.count', '3']]) > t([]), 'more trees');
  assert.ok(t([['tree.access', 'tight']]) > t([['tree.access', 'open']]), 'no equipment access');
  assert.ok(t([['tree.hazards', ['powerLines', 'overHouse']]]) > t([['tree.hazards', []]]), 'hazards');
  assert.ok(t([['tree.stumps', 'yes']]) > t([['tree.stumps', 'no']]), 'stump grinding');
  assert.ok(t([['tree.debris', 'haul']]) > t([['tree.debris', 'leave']]), 'hauling');
  assert.ok(t([['job.timing', ['emergency']]]) > t([['job.timing', []]]), 'emergency');
  assert.ok(t([['job.miles', '65']]) > t([['job.miles', '2']]), 'distance');
  const s = (pairs) => answer('snow', [['snow.area', '1000'], ['job.miles', '8'], ...pairs]);
  assert.ok(s([['snow.area', '2500']]) >= s([['snow.area', '1000']]) && s([['snow.area', '4000']]) > s([['snow.area', '500']]), 'bigger driveway');
  assert.ok(s([['snow.salt', 'yes']]) > s([['snow.salt', 'no']]), 'salt');
  assert.ok(s([['snow.walks', '150']]) > s([['snow.walks', '0']]), 'sidewalks');
  assert.ok(s([['snow.depth', '12']]) > s([['snow.depth', '2']]), 'deeper snow');
});

test('summary counts what is left', () => {
  const e = est('tree');
  const before = questionSummary(e, ctx);
  assert.equal(before.done + before.open, before.total);
  for (const qq of openQuestions(e, ctx, { requiredOnly: true })) applyAnswer(e, qq, qq.kind === 'many' ? [] : qq.options[0].id);
  // answering can reveal follow-up questions; answer until none are left
  for (let i = 0; i < 5; i++) for (const qq of openQuestions(e, ctx, { requiredOnly: true })) applyAnswer(e, qq, qq.kind === 'many' ? [] : qq.options[0].id);
  assert.equal(questionSummary(e, ctx).openRequired, 0);
});
