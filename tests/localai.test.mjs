import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interpret } from '../js/localai/interpret.js';
import { aiToParsed } from '../js/ai.js';
import { applyParsed, newJob } from '../js/engine.js';

// Real outputs of the shipped on-device model for Creative Commons test photos.
const FX = JSON.parse(readFileSync(new URL('./fixtures/localai-probs.json', import.meta.url))).photos;
const photo = (name) => ({ probs: FX[name].probs });
const labels = JSON.parse(readFileSync(new URL('../models/tinyclip-vit-8m-16/labels.json', import.meta.url)));
const config = JSON.parse(readFileSync(new URL('../models/tinyclip-vit-8m-16/config.json', import.meta.url)));

test('model files are consistent', () => {
  assert.equal(labels.dim, config.embedDim);
  const floats = Buffer.from(labels.embeddings, 'base64').length / 4;
  assert.equal(floats, labels.count * labels.dim);
  assert.equal(labels.questions.reduce((s, q) => s + q.classes.length, 0), labels.count);
  assert.ok(config.sha256.length === 64 && config.bytes > 5e6 && config.bytes < 15e6);
});

test('oak photo: tree removal, species, no invented hazards', () => {
  const r = interpret([photo('oak_5')]);
  assert.equal(r.division, 'tree');
  assert.equal(r.tree.trees[0].species, 'oak');
  assert.equal(r.tree.trees[0].work, 'remove');
  assert.ok(r.tree.trees[0].heightFt >= 15 && r.tree.trees[0].heightFt <= 75);
  assert.ok(!r.tree.hazards.powerLines && !r.tree.hazards.dead);
  assert.ok(r.missing.some((m) => /height/.test(m)), 'height always asked to confirm');
  assert.equal(r.photoCaptions.length, 1);
});

test('fallen tree next to a house: dead + leaning + near structure, emergency hint', () => {
  const r = interpret([photo('onhouse_0')]);
  assert.equal(r.tree.hazards.dead, true);
  assert.equal(r.tree.hazards.leaning, true);
  assert.ok(r.tree.hazards.nearStructure || r.tree.hazards.overHouse);
  assert.ok(r.observations.some((o) => /Emergency/.test(o)));
});

test('stump photo becomes stump work', () => {
  assert.equal(interpret([photo('stump_1')]).tree.trees[0].work, 'stump');
});

test('snowy parking lot: commercial, lot size, seasonal upsell', () => {
  const r = interpret([photo('lot_snow_4')]);
  assert.equal(r.division, 'snow');
  assert.equal(r.snow.property, 'commercial');
  assert.ok(r.snow.areaSqft >= 10000);
  assert.ok(r.upsells.some((u) => u.action === 'seasonal'));
});

test('icy pavement turns on salt', () => {
  const r = interpret([photo('icy_walk_2')]);
  assert.equal(r.division, 'snow');
  assert.equal(r.snow.salt, true);
});

test('non-job photo is flagged and does not drive the result', () => {
  const r = interpret([photo('pine_1'), photo('maple_0')]);
  assert.equal(r.division, 'tree');
  assert.ok(r.observations.some((o) => /Photo 1 doesn't look like/.test(o)));
  assert.equal(r.photoCaptions[0], 'Not a job photo?');
});

test('close-up helps species but not size; multi-photo merge', () => {
  const r = interpret([photo('maple_0'), photo('maple_2')]);
  assert.equal(r.tree.trees[0].species, 'maple');
  assert.match(r.photoCaptions[1], /Close-up/);
});

test("estimator's notes beat the photo", () => {
  const r = interpret([photo('oak_5')], { notes: 'remove 70 ft maple in the backyard near power lines' });
  assert.equal(r.tree.trees[0].species, 'maple');
  assert.equal(r.tree.trees[0].heightFt, 70);
  assert.equal(r.tree.access, 'backyard');
  assert.equal(r.tree.hazards.powerLines, true);
  assert.ok(!r.missing.some((m) => /height/.test(m)));
});

test('unreadable photos are skipped, not fatal; all-unreadable is a clear error', () => {
  const r = interpret([{ error: 'bad' }, photo('palm_3')]);
  assert.equal(r.tree.trees[0].species, 'palm');
  assert.equal(r.photoCaptions[0], 'Could not read this photo');
  assert.ok(r.observations[0].includes('could not be read'));
  assert.throws(() => interpret([{ error: 'This photo could not be read.' }]), /could not be read/);
});

test('merges into a job like the cloud result: only adds hazards, keeps emergency', () => {
  const job = newJob();
  job.emergency = true;
  job.tree.hazards.powerLines = true; // e.g. from the notes
  const out = applyParsed(job, aiToParsed(interpret([photo('oak_5')])));
  assert.equal(out.tree.hazards.powerLines, true, 'photo did not see wires, but does not switch them off');
  assert.equal(out.emergency, true);
  assert.equal(out.tree.trees[0].species, 'oak');
});

test('structured analysis: ranges with confidence, and honest "can\'t tell"', () => {
  const r = interpret([photo('oak_5')]);
  const by = Object.fromEntries(r.analysis.map((a) => [a.key, a]));
  assert.match(by.height.value, /About \d+–\d+ ft/);
  assert.ok(by.height.confidence > 0 && by.height.confidence <= 1);
  assert.match(by.dbh.value, /in/);
  assert.ok(by.dbh.confidence < by.height.confidence, 'trunk is derived, so less sure');
  assert.equal(by.lean.confidence, null);
  assert.equal(by.gate.confidence, null);
  for (const k of ['count', 'species', 'condition', 'buildings', 'powerLines', 'road', 'vehicles', 'yard', 'access', 'slope', 'brushVol', 'logVol', 'stump']) assert.ok(by[k], k);
});

test('roads and dense brush become job conditions when clear', () => {
  assert.equal(interpret([photo('leaning_0')]).conditions.nearRoad, true);
  assert.equal(interpret([photo('spruce_4')]).conditions.denseBrush, true);
  assert.equal(interpret([photo('maple_0')]).conditions.nearRoad, undefined);
});

test('snow analysis: area, spaces, depth, snow type, entrances unknown', () => {
  const by = Object.fromEntries(interpret([photo('lot_snow_4')]).analysis.map((a) => [a.key, a]));
  assert.match(by.area.value, /sq ft/);
  assert.match(by.spaces.value, /About/);
  assert.ok(by.depth && by.snowType && by.piles && by.tight);
  assert.equal(by.entrances.confidence, null);
});
