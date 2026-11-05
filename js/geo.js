// Location, address lookup and weather. No API keys needed:
// - Addresses: OpenStreetMap Nominatim (free, light use only)
// - Weather:   Open-Meteo (free, no key)

const NOMINATIM = 'https://nominatim.openstreetmap.org';

export function getPosition({ timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => reject(new Error(err.code === 1 ? 'Location permission was denied. Allow it in your browser settings.' : 'Could not get your location. Try again outside.')),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
    );
  });
}

function formatAddress(a = {}) {
  const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
  const region = [a.state ? abbrevState(a.state) : '', a.postcode].filter(Boolean).join(' ');
  return [street, city, region].filter(Boolean).join(', ');
}

export async function reverseGeocode(lat, lon) {
  const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lon}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Address lookup failed');
  const j = await r.json();
  return formatAddress(j.address) || j.display_name || '';
}

export async function geocode(query) {
  const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Address lookup failed');
  const [hit] = await r.json();
  if (!hit) throw new Error('Address not found');
  return { lat: +hit.lat, lon: +hit.lon, label: hit.display_name };
}

// Straight-line distance × typical road factor, in miles.
export function roadMiles(a, b) {
  if (!a || !b) return 0;
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.25 * 10) / 10;
}

// 7-day forecast: snowfall (inches), wind gusts (mph), rain (inches).
const fcCache = new Map();
export async function forecast(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = fcCache.get(key);
  if (hit && Date.now() - hit.at < 36e5) return hit.days;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&daily=snowfall_sum,wind_gusts_10m_max,precipitation_sum,temperature_2m_min&timezone=auto&forecast_days=7' +
    '&precipitation_unit=inch&wind_speed_unit=mph&temperature_unit=fahrenheit';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Forecast unavailable');
  const d = (await r.json()).daily;
  // Open-Meteo reports snowfall in cm unless precipitation_unit=inch, which also converts snowfall.
  const days = d.time.map((t, i) => ({
    date: t,
    snowIn: Math.round((d.snowfall_sum[i] || 0) * 10) / 10,
    gustMph: Math.round(d.wind_gusts_10m_max[i] || 0),
    rainIn: Math.round((d.precipitation_sum[i] || 0) * 10) / 10,
    lowF: Math.round(d.temperature_2m_min[i] ?? 0),
  }));
  fcCache.set(key, { at: Date.now(), days });
  return days;
}

export function stormAlerts(days) {
  const out = [];
  const snow = days.filter((d) => d.snowIn >= 1);
  const total = Math.round(snow.reduce((s, d) => s + d.snowIn, 0) * 10) / 10;
  if (snow.length) {
    const big = snow.reduce((a, b) => (b.snowIn > a.snowIn ? b : a));
    out.push({ kind: 'snow', level: big.snowIn >= 6 ? 'high' : 'med', date: big.date, text: `${total}" of snow expected this week (most on ${dayName(big.date)}: ${big.snowIn}")` });
  }
  const ice = days.find((d) => d.rainIn >= 0.1 && d.lowF <= 32 && d.snowIn < 1);
  if (ice) out.push({ kind: 'ice', level: 'med', date: ice.date, text: `Freezing rain / ice risk ${dayName(ice.date)}: salting calls likely` });
  const wind = days.filter((d) => d.gustMph >= 40);
  if (wind.length) {
    const w = wind.reduce((a, b) => (b.gustMph > a.gustMph ? b : a));
    out.push({ kind: 'wind', level: w.gustMph >= 55 ? 'high' : 'med', date: w.date, text: `High winds ${dayName(w.date)} (gusts ${w.gustMph} mph): expect storm-damage tree calls` });
  }
  return out;
}

export const dayName = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });

const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };
function abbrevState(s) { return STATES[s.toLowerCase()] || s; }
