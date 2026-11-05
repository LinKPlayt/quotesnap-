import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomer, parseDescription, applyParsed, describeChanges, newJob, newTree } from '../js/engine.js';
import { aiToParsed } from '../js/ai.js';

test('pulls customer details out of spoken notes', () => {
  const c = parseCustomer('New job for John Smith at 123 Maple Ave, Springfield, IL 62704. Call 555-867-5309 or john@smith.com');
  assert.equal(c.name, 'John Smith');
  assert.equal(c.phone, '555-867-5309');
  assert.equal(c.email, 'john@smith.com');
  assert.equal(c.address, '123 Maple Ave, Springfield, IL 62704');
  assert.deepEqual(parseCustomer('trim 2 trees near the drive, 40 ft pine'), {});
});

test('contact details do not leak into job numbers', () => {
  const p = parseDescription('Remove oak for Dana Lee, 402 Ridge Rd, phone 555 014 2299');
  assert.equal(p.tree.trees[0].heightFt, undefined);
  assert.equal(p.tree.trees[0].species, 'oak');
});

test('manual edits (locks) are never overwritten', () => {
  const job = newJob();
  job.tree.trees[0].heightFt = 70;
  const out = applyParsed(job, parseDescription('remove 45 ft maple in the backyard'), { 'job.tree.trees.0.heightFt': true, 'job.tree.access': true });
  assert.equal(out.tree.trees[0].heightFt, 70);
  assert.equal(out.tree.trees[0].species, 'maple');
  assert.equal(out.tree.access, 'driveway');
});

test('notes parsing only adds; AI results can switch things off', () => {
  const job = newJob();
  job.tree.hazards.powerLines = true;
  job.tree.trees.push({ ...newTree(), species: 'ash' });
  const notes = applyParsed(job, parseDescription('remove 50 ft oak'));
  assert.equal(notes.tree.hazards.powerLines, true);
  assert.equal(notes.tree.trees.length, 2, 'extra rows kept');
  const ai = aiToParsed({
    division: 'tree', emergency: false, customer: { name: '', phone: '', email: '', address: '' },
    tree: { trees: [{ work: 'remove', species: 'red oak', heightFt: 52, dbhIn: 26, qty: 1, condition: 'healthy' }], access: 'backyard', method: 'auto', debris: 'haul', stumps: true, restore: false, firewood: false, trimLevel: 'standard', hazards: { powerLines: false, overHouse: true, nearStructure: false, dead: false, leaning: false, fenceGarden: true } },
    snow: { property: 'residential', method: 'auto', areaSqft: 0, walkLf: 0, roofSqft: 0, depthIn: 0, salt: false, obstacles: 'low' },
  });
  const out = applyParsed(job, ai, { 'job.tree.hazards.fenceGarden': true });
  assert.equal(out.tree.hazards.powerLines, false);
  assert.equal(out.tree.hazards.overHouse, true);
  assert.equal(out.tree.hazards.fenceGarden, undefined, 'locked hazard untouched');
  assert.equal(out.tree.trees.length, 1);
  assert.deepEqual(out.tree.trees[0], { work: 'remove', species: 'red oak', heightFt: 52, dbhIn: 26, qty: 1 });
  assert.equal(out.tree.stumps, true);
});

test('AI snow results ignore unknown area/depth', () => {
  const job = newJob('snow');
  const ai = aiToParsed({ division: 'snow', emergency: false, customer: {}, tree: {}, snow: { property: 'commercial', method: 'auto', areaSqft: 0, walkLf: 120, roofSqft: 0, depthIn: 0, salt: true, obstacles: 'med' } });
  const out = applyParsed(job, ai);
  assert.equal(out.snow.areaSqft, 1000);
  assert.equal(out.snow.depthIn, 4);
  assert.equal(out.snow.walkLf, 120);
  assert.equal(out.snow.property, 'commercial');
});

test('describes changes in plain words', () => {
  const a = newJob();
  const b = applyParsed(a, parseDescription('Remove 45 ft oak, backyard, near power lines'));
  const ch = describeChanges(a, b);
  const byLabel = Object.fromEntries(ch.map((c) => [c.label, c.to]));
  assert.equal(byLabel['Tree height'], '45 ft');
  assert.equal(byLabel['Tree species'], 'Oak');
  assert.equal(byLabel.Access, 'Backyard gate');
  assert.equal(byLabel['Near power lines'], 'Yes');
});
