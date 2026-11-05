import test from 'node:test';
import assert from 'node:assert/strict';
import { calc, newJob, applyParsed, parseDescription } from '../js/engine.js';
import { defaultCompany } from '../js/company.js';
import { DEFAULT_PRICEBOOK as PB } from '../js/pricebook.js';
import { snapshotEstimate, compareJob, rateSuggestions, applySuggestion, actualSiteHours } from '../js/learning.js';

const company = defaultCompany();
const est = calc(applyParsed(newJob(), parseDescription('Remove 50 ft oak, front yard')), PB, { company });

test('snapshot freezes the original estimate', () => {
  const o = snapshotEstimate(est, 'Standard');
  assert.equal(o.rateId, 'tree_removal');
  assert.equal(o.price, est.price);
  assert.equal(o.laborHours, est.personHours);
});

test('actual time on site from start/finish minus travel', () => {
  assert.equal(actualSiteHours({ start: '2026-11-01T08:00', finish: '2026-11-01T14:30', travelHours: 0.5 }), 6);
  assert.equal(actualSiteHours({ laborHours: 24, workers: 4 }), 6);
});

test('compare estimated vs actual', () => {
  const o = snapshotEstimate(est, 'Standard');
  const rows = compareJob(o, { workers: 4, start: '2026-11-01T08:00', finish: '2026-11-01T17:00', travelHours: 0.5, laborHours: 36, totalCost: o.totalCost * 1.2, price: o.price });
  const cost = rows.find((r) => r.label === 'Total cost');
  assert.equal(cost.pct, 20);
  assert.ok(rows.find((r) => r.label === 'Profit').act < o.profit);
});

test('suggestions need enough jobs and are never applied automatically', () => {
  const o = snapshotEstimate(est, 'Standard');
  const job = (i, factor) => ({ id: 'j' + i, number: 'Q-' + i, original: o, actual: { workers: o.crew, laborHours: o.crew * (o.siteHours * factor + o.travelHours), travelHours: o.travelHours } });
  const two = rateSuggestions([job(1, 1.3), job(2, 1.3)], company);
  assert.equal(two[0].ready, false);
  const before = company.rates.find((r) => r.id === 'tree_removal').rate;
  const s = rateSuggestions([job(1, 1.3), job(2, 1.25), job(3, 1.35)], company)[0];
  assert.equal(s.ready, true);
  assert.ok(s.suggested < before);
  assert.equal(company.rates.find((r) => r.id === 'tree_removal').rate, before, 'not changed until applied');
  const log = applySuggestion(company, s);
  assert.equal(company.rates.find((r) => r.id === 'tree_removal').rate, s.suggested);
  assert.equal(company.rateLog[0], log);
  const ok = rateSuggestions([job(1, 1.02), job(2, 0.98), job(3, 1.05)], company)[0];
  assert.equal(ok.ready, false);
});
