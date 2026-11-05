// Default price book. Every number here is editable in the app (Price Book tab).
// Costs are what the job costs YOU; the engine adds overhead and your target margin.

export const DEFAULT_PRICEBOOK = {
  labor: {
    wage: 26,            // $/hr average crew wage
    burdenPct: 30,       // payroll tax, workers comp, insurance on top of wage
    emergencyMult: 1.5,  // overtime / storm-call multiplier on labor
  },
  crew: { tree: 3, snow: 1 },
  overheadPct: 15,       // shop, office, vehicles, admin
  targetMarginPct: 35,   // net profit target on the selling price
  taxPct: 0,
  minJobTree: 250,
  minJobSnow: 45,
  travel: { perMile: 2.5, freeMiles: 15 },
  depositPct: 25,
  validDays: 30,
  roundTo: 5,
  equipment: {
    bucket:   { label: 'Bucket truck',             rate: 75,  min: 2 },
    crane:    { label: 'Crane w/ operator',        rate: 275, min: 4 },
    lift:     { label: 'Tracked spider lift',      rate: 90,  min: 2 },
    climb:    { label: 'Climbing & rigging gear',  rate: 12,  min: 0 },
    chipper:  { label: 'Brush chipper',            rate: 35,  min: 1 },
    loader:   { label: 'Compact loader',           rate: 45,  min: 1 },
    dump:     { label: 'Dump truck / chip truck',  rate: 30,  min: 1 },
    grinder:  { label: 'Stump grinder',            rate: 45,  min: 1 },
    plow:     { label: 'Plow truck',               rate: 55,  min: 0.25 },
    skid:     { label: 'Skid steer w/ pusher',     rate: 65,  min: 0.5 },
    blower:   { label: 'Walk-behind snow blower',  rate: 12,  min: 0.25 },
    spreader: { label: 'Salt spreader',            rate: 15,  min: 0.25 },
    shovel:   { label: 'Hand shovel crew tools',   rate: 3,   min: 0 },
  },
  materials: {
    fuelPerEquipHour: 6,
    dumpFeePerLoad: 65,
    loadYards: 12,
    cablingKit: 85,
    restoreKit: 35,      // topsoil + seed + straw per stump
    saltPerLb: 0.14,
    saltLbPer1000: 12,
    permitFee: 75,
  },
  snow: {
    eventsPerSeason: 12,
    seasonalDiscountPct: 10,
    seasonMonths: 5,
    priorityPct: 20,
  },
  terms:
    'A deposit is due to schedule work; balance is due on completion. Price includes labor, equipment and cleanup described above. ' +
    'Underground utilities will be located before stump grinding. Additional work not listed requires a signed change order. ' +
    'We are fully insured. Quote is valid for the period shown.',
};

export function mergePricebook(saved) {
  const out = structuredClone(DEFAULT_PRICEBOOK);
  if (!saved) return out;
  const deep = (t, s) => {
    for (const k of Object.keys(s)) {
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') deep(t[k], s[k]);
      else if (s[k] !== undefined) t[k] = s[k];
    }
  };
  deep(out, saved);
  return out;
}
