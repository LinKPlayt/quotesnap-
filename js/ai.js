// Optional AI job analysis with Claude. The contractor's own API key is stored on-device only.
// Claude reads the photos + notes and fills in the job fields; the deterministic engine
// still does all the pricing, so quotes stay consistent and explainable.

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@1.5.0';
export const DEFAULT_MODEL = 'claude-opus-5-5';

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const en = (...v) => ({ type: 'string', enum: v });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const SCHEMA = obj({
  division: en('tree', 'snow'),
  emergency: bool,
  tree: obj({
    trees: {
      type: 'array',
      items: obj({ work: en('remove', 'trim', 'stump', 'cable'), species: str, heightFt: num, dbhIn: num, qty: num }),
    },
    access: en('open', 'driveway', 'backyard', 'tight'),
    method: en('auto', 'bucket', 'crane', 'lift', 'climb'),
    debris: en('haul', 'chipLeaveLogs', 'leave'),
    stumps: bool,
    trimLevel: en('light', 'standard', 'heavy'),
    hazards: obj({ powerLines: bool, overHouse: bool, nearStructure: bool, dead: bool, leaning: bool, fenceGarden: bool }),
  }),
  snow: obj({
    property: en('residential', 'commercial'),
    areaSqft: num,
    walkLf: num,
    roofSqft: num,
    depthIn: num,
    salt: bool,
    obstacles: en('low', 'med', 'high'),
  }),
  observations: { type: 'array', items: str },
  customerSummary: str,
});

const SYSTEM = `You are an expert ISA-certified arborist and snow-management estimator helping a small contractor build a quote.
From the contractor's notes and job-site photos, extract the job parameters. Rules:
- Trust explicit numbers and equipment in the notes over what you infer from photos.
- Estimate tree height (ft) and trunk diameter at chest height (in) from photos when not given; use 0 for dbhIn if you truly cannot tell.
- Flag hazards you can actually see (power lines, structures under the canopy, dead wood, lean, fences/gardens).
- method "auto" unless the notes name equipment.
- For snow jobs estimate paved area in sq ft and sidewalk linear feet; fill tree fields with neutral defaults. For tree jobs fill snow fields with neutral defaults.
- observations: 2-6 short, specific notes the estimator should double-check on site (e.g. "Included bark visible at main union – possible weak attachment").
- customerSummary: 1-2 friendly, professional sentences describing the work for the customer. No prices.`;

export async function analyzeJob({ apiKey, model, notes, photos, division }) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings to use AI analysis.');
  const { default: Anthropic } = await import(/* @vite-ignore */ SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content = [];
  for (const p of (photos || []).slice(0, 6)) {
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(p);
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: `Division hint: ${division || 'unknown'}\nContractor notes:\n${notes || '(none)'}` });

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
    response = await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err?.status === 400 && /fallback/i.test(err?.message || '')) response = await client.messages.create(base);
    else throw friendly(err);
  }

  if (response.stop_reason === 'refusal') throw new Error('The AI declined to analyze this request. Fill in the fields manually.');
  if (response.stop_reason === 'max_tokens') throw new Error('AI response was cut off. Try fewer photos.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('AI returned an unreadable answer. Try again.');
  }
}

function friendly(err) {
  const s = err?.status;
  if (s === 401) return new Error('Invalid API key. Check it in Settings.');
  if (s === 429) return new Error('Rate limited by the API. Wait a moment and retry.');
  if (s >= 500) return new Error('AI service is temporarily unavailable. Try again shortly.');
  if (!s) return new Error('Could not reach the AI service. Check your connection.');
  return new Error(err.message || 'AI request failed.');
}

// Convert the AI answer into the shape produced by engine.parseDescription().
export function aiToParsed(a) {
  const hz = Object.fromEntries(Object.entries(a.tree?.hazards || {}).filter(([, v]) => v));
  const trees = (a.tree?.trees || []).map((t) => ({ ...t, species: t.species || '', dbhIn: t.dbhIn || 0, qty: t.qty || 1, heightFt: Math.round(t.heightFt || 0) }));
  return {
    division: a.division,
    flags: { emergency: a.emergency },
    tree: a.division === 'tree' ? { ...a.tree, trees: trees.length ? trees : undefined, hazards: hz } : {},
    snow: a.division === 'snow' ? a.snow : {},
  };
}
