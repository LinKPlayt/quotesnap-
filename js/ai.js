// AI job analysis with Claude. The contractor's own API key is stored on-device only.
// Claude looks at the photos (+ any notes) and fills in the job; the deterministic
// engine still does all the pricing, so quotes stay consistent and explainable.

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@1.5.0';
export const DEFAULT_MODEL = 'claude-opus-5-5';

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const en = (...v) => ({ type: 'string', enum: v });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });

const SCHEMA = obj({
  division: en('tree', 'snow'),
  confidence: en('low', 'medium', 'high'),
  emergency: bool,
  customer: obj({ name: str, phone: str, email: str, address: str }),
  tree: obj({
    trees: arr(obj({ work: en('remove', 'trim', 'stump', 'cable'), species: str, heightFt: num, dbhIn: num, qty: num, condition: str })),
    access: en('open', 'driveway', 'backyard', 'tight'),
    method: en('auto', 'bucket', 'crane', 'lift', 'climb'),
    debris: en('haul', 'chipLeaveLogs', 'leave'),
    stumps: bool,
    restore: bool,
    firewood: bool,
    trimLevel: en('light', 'standard', 'heavy'),
    hazards: obj({ powerLines: bool, overHouse: bool, nearStructure: bool, dead: bool, leaning: bool, fenceGarden: bool }),
  }),
  snow: obj({
    property: en('residential', 'commercial'),
    method: en('auto', 'plow', 'skid', 'blower', 'shovel'),
    areaSqft: num,
    walkLf: num,
    roofSqft: num,
    depthIn: num,
    salt: bool,
    obstacles: en('low', 'med', 'high'),
  }),
  photoCaptions: arr(str),
  observations: arr(str),
  upsells: arr(obj({
    label: str,
    reason: str,
    action: en('addTree', 'stumps', 'restore', 'firewood', 'salt', 'walks', 'roof', 'priority', 'seasonal', 'none'),
    work: en('remove', 'trim', 'stump', 'cable'),
    species: str,
    heightFt: num,
    dbhIn: num,
  })),
  customerSummary: str,
  missing: arr(str),
});

const SYSTEM = `You are an expert ISA-certified arborist and snow-management estimator. A small tree care & snow removal contractor snapped job-site photos and wants the quote filled in automatically, with as little typing as possible. Fill in every field you reasonably can from the photos.

How to read the photos:
- Decide division: tree work vs snow/ice service.
- Tree height: use reference objects (2-story house ≈ 25 ft to the roof peak, 1-story ≈ 15 ft, a person ≈ 5.8 ft, utility pole ≈ 35-40 ft, car ≈ 5 ft tall / 15 ft long). Round to the nearest 5 ft.
- Trunk diameter at chest height (dbhIn): estimate from close-ups against people, doors (36 in wide), fence posts, or bricks. 0 only if no trunk is visible.
- Species from bark, leaves, form, buds and fruit. Use common names ("red oak", "silver maple", "white pine"). Empty string if you truly cannot tell.
- One entry per distinct tree. Use qty for identical trees. Use "work": "remove" for dead, dying, hazardous or clearly unwanted trees, otherwise the work the notes or photos point to. Default to "remove" when the photo is just "this tree".
- condition: 3-8 words (e.g. "dead top, bark sloughing", "healthy, co-dominant stems").
- Hazards: only what you can see or what the notes say: power or service lines in or near the canopy, canopy over a roof, structures in the fall zone, dead or decayed wood, lean or storm damage, fences/gardens/patios in the drop zone.
- Access: "open" if a truck can drive to it, "driveway" if it's by a driveway or street, "backyard" if behind the house or through a gate, "tight" if no equipment can reach it.
- method: "auto" unless the notes name equipment.
- Debris: "haul" unless the notes say otherwise. stumps: true if removing and the notes or photos suggest grinding (lawn area). restore and firewood: false unless asked.
- Snow: property type; method "auto"; estimate the paved area in sq ft (1-car driveway ≈ 500, 2-car ≈ 1000, a parking space ≈ 320); sidewalk linear ft; roof sq ft only if roof snow removal is relevant; depthIn = visible or stated snow depth (0 if unknown); salt true if ice is visible, it's commercial, or the notes ask for it; obstacles from cars, islands and curbs.
- Fill the unused division's fields with neutral defaults (zeros, false, "auto", "low", "residential", "open", "haul", "standard", empty tree list).

Notes beat photos. Trust explicit numbers, names and equipment in the notes over what you infer. Customer name, phone, email and address come ONLY from the notes or visible signage/mailbox numbers. Never invent them; use "" if unknown.

Also return:
- photoCaptions: one short professional caption per photo, in order (e.g. "45 ft red oak: canopy over the garage roof").
- observations: 2-6 specific things the estimator should check on site.
- upsells: 0-3 real, visible extra-work opportunities (another dead tree, deadwood over the house, stump grinding, salt for an icy walk, seasonal contract). Use action "addTree" with the work/species/height/trunk for extra trees; otherwise set those fields to neutral values. Never pad the list.
- customerSummary: 1-2 friendly, professional sentences for the customer describing the work. No prices.
- missing: short list of what you could not determine and the estimator should confirm (e.g. "trunk diameter", "is the walkway included?").
- confidence: your overall confidence in the measurements.`;

async function client(apiKey) {
  const { default: Anthropic } = await import(/* @vite-ignore */ SDK_URL);
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

export async function analyzeJob({ apiKey, model, notes, photos, division }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to turn on photo analysis.');
  const c = await client(apiKey);

  const content = [];
  const list = (photos || []).filter(Boolean).slice(0, 8);
  list.forEach((p, i) => {
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(p);
    if (!m) return;
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  });
  content.push({
    type: 'text',
    text: `${list.length} photo(s) attached.\nCurrent job type in the app: ${division || 'unknown'} (change it if the photos say otherwise).\nEstimator notes:\n${notes?.trim() || '(none: work from the photos)'}`,
  });

  const base = {
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  };

  let response;
  try {
    // Server-side fallback: if a safety classifier declines, the API retries on a fallback model.
    response = await c.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err?.status === 400 && /fallback/i.test(err?.message || '')) {
      try { response = await c.messages.create(base); } catch (e2) { throw friendly(e2); }
    } else throw friendly(err);
  }

  if (response.stop_reason === 'refusal') throw new Error('The AI declined to analyze these photos. Fill in the fields manually.');
  if (response.stop_reason === 'max_tokens') throw new Error('The AI answer was cut off. Try fewer photos.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The AI returned an unreadable answer. Tap Re-analyze.');
  }
}

// Cheap request to confirm a key works (Settings → Test key).
export async function testKey(apiKey, model) {
  const c = await client(apiKey);
  try {
    await c.messages.create({ model: model || DEFAULT_MODEL, max_tokens: 16, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply OK.' }] });
    return true;
  } catch (err) {
    throw friendly(err);
  }
}

function friendly(err) {
  const s = err?.status;
  if (s === 401) return new Error('That API key was rejected. Check it in Settings.');
  if (s === 403) return new Error('This API key does not have access to that model.');
  if (s === 404) return new Error('Model not found. Pick another model in Settings.');
  if (s === 429) return new Error('Too many requests right now. Wait a moment and retry.');
  if (s === 529 || s >= 500) return new Error('The AI service is busy. Try again shortly.');
  if (!s) return new Error('Could not reach the AI service. Check your connection.');
  return new Error(err.message || 'AI request failed.');
}

// Convert the AI answer into the shape produced by engine.parseDescription(), flagged
// as a full replacement so the AI can also switch hazards/extras off.
export function aiToParsed(a) {
  const isTree = a.division === 'tree';
  const trees = (a.tree?.trees || [])
    .filter((t) => t && t.work)
    .map((t) => ({ work: t.work, species: t.species || '', heightFt: Math.round(t.heightFt || 0) || undefined, dbhIn: Math.round(t.dbhIn || 0), qty: Math.max(1, Math.round(t.qty || 1)) }));
  const snow = { ...(a.snow || {}) };
  if (!snow.areaSqft) delete snow.areaSqft;
  if (!snow.depthIn) delete snow.depthIn;
  return {
    replace: true,
    division: a.division,
    flags: { emergency: !!a.emergency },
    tree: isTree ? { ...a.tree, trees: trees.length ? trees : undefined } : {},
    snow: isTree ? {} : snow,
    customer: a.customer || {},
  };
}
