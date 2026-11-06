// Auto pricing (fuel prices, company-based suggestions) and photo location tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stateFrom, fuelAreas, pickFuel, suggestPricing, applyChanges, profileOf, fuelUse, FUEL_USE } from '../js/autoprice.js';
import { readExif } from '../js/exif.js';
import { defaultCompany, newEquipment } from '../js/company.js';
import { mergePricebook } from '../js/pricebook.js';
import { calc, newJob, newTree } from '../js/engine.js';
import { rng, randomCompany, randomPricebook } from './helpers/fuzzgen.mjs';

const FUEL_DATA = JSON.parse(readFileSync(new URL('../data/fuel.json', import.meta.url)));
const fixture = (f) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const NEWTON = { lat: 42.337, lon: -71.209, state: 'MA' };

test('data/fuel.json is well formed (what the daily job writes)', () => {
  assert.match(FUEL_DATA.week, /^\d{4}-\d{2}-\d{2}$/);
  for (const k of ['gas', 'diesel']) {
    assert.ok(FUEL_DATA[k].US > 1 && FUEL_DATA[k].US < 15, `${k} U.S. average`);
    for (const [area, v] of Object.entries(FUEL_DATA[k])) assert.ok(v > 1 && v < 15, `${k} ${area} = ${v}`);
  }
});

test('state from an address, in the forms Nominatim and people write them', () => {
  assert.equal(stateFrom('12 Main St, Newton, MA 02458'), 'MA');
  assert.equal(stateFrom('Newton, Middlesex County, Massachusetts, 02458, United States'), 'MA');
  assert.equal(stateFrom('Charleston, West Virginia, USA'), 'WV');
  assert.equal(stateFrom('Richmond, Virginia'), 'VA');
  assert.equal(stateFrom('Somewhere with no state'), null);
  assert.equal(stateFrom(''), null);
});

test('fuel area: nearest city, then state, then region, then U.S.', () => {
  assert.deepEqual(fuelAreas(NEWTON), ['city:boston', 'MA', 'PADD1A', 'PADD1', 'US']);
  assert.deepEqual(fuelAreas({ state: 'OH' }), ['OH', 'PADD2', 'US']);
  assert.deepEqual(fuelAreas({ state: 'OR' }), ['OR', 'PADD5XCA', 'PADD5', 'US']);
  assert.deepEqual(fuelAreas({}), ['US']);
  assert.deepEqual(fuelAreas({ lat: 44.5, lon: -72.6, state: 'VT' }), ['VT', 'PADD1A', 'PADD1', 'US'], 'Vermont is not near any city EIA reports');
});

test('pick fuel: most local price for each product, own pump price wins', () => {
  const f = pickFuel(FUEL_DATA, NEWTON);
  assert.equal(f.gas.area, 'city:boston');
  assert.equal(f.gas.price, FUEL_DATA.gas['city:boston']);
  assert.equal(f.diesel.area, 'PADD1A', 'EIA has no Boston diesel price, so New England');
  assert.equal(f.week, FUEL_DATA.week);
  const own = pickFuel(FUEL_DATA, NEWTON, { diesel: 5.1 });
  assert.equal(own.diesel.price, 5.1);
  assert.ok(own.diesel.manual && !own.gas.manual);
  assert.equal(pickFuel(null, NEWTON), null);
  assert.equal(pickFuel({}, NEWTON, { gas: 4 }).diesel.price, 4, 'only a manual gas price: used for both');
});

test('fuel per hour follows the machine\'s fuel use × today\'s price', () => {
  const c = defaultCompany();
  const pb = mergePricebook({});
  const fuel = pickFuel(FUEL_DATA, NEWTON);
  for (const e of c.equipment) e.fuel = 0; // start from nothing so every machine gets a line
  const ch = suggestPricing(c, pb, fuel);
  const bucket = c.equipment.find((e) => e.type === 'bucket_truck');
  const line = ch.find((x) => x.eqId === bucket.id && x.field === 'fuel');
  assert.ok(line && line.auto);
  assert.equal(line.to, Math.round(FUEL_USE.bucket_truck[0] * fuel.diesel.price * 100) / 100);
  const saw = c.equipment.find((e) => e.type === 'chainsaw');
  const sawLine = ch.find((x) => x.eqId === saw.id && x.field === 'fuel');
  assert.equal(sawLine.to, Math.round(FUEL_USE.chainsaw[0] * fuel.gas.price * 100) / 100, 'chainsaws run on gas');
  // the owner's own number for one machine
  bucket.gph = 4.5;
  assert.equal(suggestPricing(c, pb, fuel).find((x) => x.eqId === bucket.id && x.field === 'fuel').to, Math.round(4.5 * fuel.diesel.price * 100) / 100);
  assert.deepEqual(fuelUse({ type: 'pickup', gph: '' }), { gph: 2.5, kind: 'gas' });
  assert.deepEqual(fuelUse({ type: 'pickup', fuelType: 'diesel', gph: 3 }), { gph: 3, kind: 'diesel' });
});

test('cost per mile = vehicles × (fuel ÷ mpg + wear)', () => {
  const pb = mergePricebook({ auto: { truckMpg: 10, vehicles: 2, wearPerMile: 0.4, truckFuel: 'gas' } });
  const fuel = pickFuel(FUEL_DATA, NEWTON);
  const m = suggestPricing(defaultCompany(), pb, fuel).find((x) => x.path === 'travel.perMile');
  assert.equal(m.to, Math.round(2 * (fuel.gas.price / 10 + 0.4) * 100) / 100);
  assert.ok(m.auto);
});

test('daily update is safe to repeat and never touches what the owner typed', () => {
  const c = defaultCompany();
  const pb = mergePricebook({});
  const fuel = pickFuel(FUEL_DATA, NEWTON);
  applyChanges(c, pb, suggestPricing(c, pb, fuel).filter((x) => x.auto));
  assert.equal(suggestPricing(c, pb, fuel).filter((x) => x.auto).length, 0, 'second run changes nothing');
  // owner typed their own fuel cost for one machine and their own cost per mile
  const chip = c.equipment.find((e) => e.type === 'chipper');
  chip.fuel = 99; chip.fuelManual = true;
  pb.travel.perMile = 7; pb.auto = { ...pb.auto, manual: { 'travel.perMile': true } };
  const higher = { ...fuel, diesel: { ...fuel.diesel, price: fuel.diesel.price + 1 }, gas: { ...fuel.gas, price: fuel.gas.price + 1 } };
  const ch = suggestPricing(c, pb, higher);
  assert.ok(!ch.some((x) => x.eqId === chip.id && x.field === 'fuel'), 'hand-typed machine fuel left alone');
  assert.ok(!ch.some((x) => x.path === 'travel.perMile'), 'hand-typed cost per mile left alone');
  assert.ok(ch.some((x) => x.auto), 'other machines still follow the price');
});

test('higher fuel prices make the same job cost more', () => {
  const job = newJob('tree');
  job.tree.trees = [{ ...newTree(), heightFt: 60 }];
  job.miles = 40;
  const at = (price) => {
    const c = defaultCompany();
    const pb = mergePricebook({});
    const f = pickFuel({ gas: { US: price }, diesel: { US: price + 1 } }, {});
    applyChanges(c, pb, suggestPricing(c, pb, f).filter((x) => x.auto));
    return calc(job, pb, { company: c });
  };
  const cheap = at(3);
  const dear = at(6);
  assert.ok(dear.fuelCost > cheap.fuelCost);
  assert.ok(dear.travel > cheap.travel);
  assert.ok(dear.fullCost > cheap.fullCost);
});

test('overhead comes from the yearly overhead, only when it is filled in', () => {
  const c = defaultCompany();
  const fuel = pickFuel(FUEL_DATA, NEWTON);
  assert.ok(!suggestPricing(c, mergePricebook({}), fuel).some((x) => x.path === 'overheadPct'));
  const pb = mergePricebook({ auto: { overheadYear: 60000, hoursWeek: 40, weeksYear: 46 } });
  const o = suggestPricing(c, pb, fuel).find((x) => x.path === 'overheadPct');
  assert.ok(o && !o.auto, 'a suggestion, not automatic');
  const active = c.workers.filter((w) => w.active !== false);
  const labor = active.reduce((s, w) => s + w.rate, 0) * (1 + pb.labor.burdenPct / 100) * 40 * 46;
  assert.equal(o.to, Math.round(Math.min(60, Math.max(3, (60000 / (labor * 1.5)) * 100))));
});

test('smallest job is only ever raised, to at least cover a short visit', () => {
  const c = defaultCompany();
  const fuel = pickFuel(FUEL_DATA, NEWTON);
  const low = suggestPricing(c, mergePricebook({ minJobTree: 50, minJobSnow: 10 }), fuel);
  const t = low.find((x) => x.path === 'minJobTree');
  const s = low.find((x) => x.path === 'minJobSnow');
  assert.ok(t && t.to > 50 && t.to % 25 === 0);
  assert.ok(s && s.to > 10 && s.to % 5 === 0);
  const high = suggestPricing(c, mergePricebook({ minJobTree: 5000, minJobSnow: 900 }), fuel);
  assert.ok(!high.some((x) => x.path === 'minJobTree' || x.path === 'minJobSnow'), 'never lowers a minimum');
});

test('cost to own a machine comes from its purchase price', () => {
  const c = defaultCompany();
  const e = newEquipment('stump_grinder', { name: 'Grinder', purchaseCost: 40000, hourly: 1 });
  c.equipment.push(e);
  const own = suggestPricing(c, mergePricebook({}), null).find((x) => x.id === `own:${e.id}`);
  assert.ok(own && !own.auto);
  assert.equal(own.to, Math.round(((40000 * (0.8 / 10 + 0.1)) / 400) * 100) / 100);
  e.hourly = 60; // the owner's number is higher than the rule: never lowered
  assert.ok(!suggestPricing(c, mergePricebook({}), null).some((x) => x.id === `own:${e.id}`));
});

test('profile: empty or zero boxes mean "use the normal value"', () => {
  const p = profileOf({ auto: { truckMpg: 0, hoursWeek: '', vehicles: -3, overheadYear: 0, daily: false, wearPerMile: 0 } });
  assert.equal(p.truckMpg, 12);
  assert.equal(p.hoursWeek, 40);
  assert.equal(p.vehicles, 2);
  assert.equal(p.overheadYear, 0);
  assert.equal(p.wearPerMile, 0, '0 wear is a real answer');
  assert.equal(p.daily, false);
});

test('fuzz: random companies, price books and fuel prices never give broken suggestions', () => {
  const R = rng(+process.env.FUZZ_SEED || 7);
  for (let i = 0; i < 400; i++) {
    const c = randomCompany(R);
    const pb = mergePricebook(randomPricebook(R));
    pb.auto = { overheadYear: R.pick([0, 50000, -5, 'abc', 1e9]), truckMpg: R.pick([0, 12, -1, 1e6]), vehicles: R.pick([0, 2, 99]), hoursWeek: R.pick(['', 40, 1e9]) };
    const price = R.pick([0, 3.5, -2, 1e6, NaN]);
    const fuel = pickFuel({ gas: { US: price }, diesel: { US: price } }, {}, R.bool() ? { diesel: R.pick([5, 0, 'x']) } : {});
    const ch = suggestPricing(c, pb, fuel);
    for (const x of ch) {
      assert.ok(Number.isFinite(x.to) && x.to >= 0, `case ${i}: ${x.label} → ${x.to}`);
      assert.ok(!/NaN|undefined|Infinity/.test(x.why + x.label), `case ${i}: bad text ${x.label}: ${x.why}`);
    }
    applyChanges(c, pb, ch);
  }
});

test('photo location: GPS and time from EXIF; missing or broken data is not an error', () => {
  const g = readExif(fixture('gps.jpg'));
  assert.equal(g.lat, 42.35785);
  assert.equal(g.lon, -71.061667);
  assert.equal(g.takenAt, '2026-11-05T14:03');
  assert.equal(readExif(fixture('nogps.jpg')), null);
  assert.equal(readExif(new Uint8Array([1, 2, 3, 4, 5])), null);
  const cut = fixture('gps.jpg').slice(0, 60); // truncated mid-EXIF
  assert.doesNotThrow(() => readExif(cut));
  const R = rng(3);
  for (let i = 0; i < 300; i++) {
    const b = fixture('gps.jpg');
    for (let k = 0; k < 6; k++) b[2 + R.int(0, b.length - 3)] = R.int(0, 255);
    assert.doesNotThrow(() => readExif(b));
    const x = readExif(b);
    if (x?.lat !== undefined) assert.ok(Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180);
  }
});
