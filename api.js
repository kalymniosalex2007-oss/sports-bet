// API-Football (api-sports.io) v3
const BASE = process.env.API_BASE || 'https://v3.football.api-sports.io';
let remaining = null, day = '', last = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function api(endpoint, params = {}) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('Λείπει το API_FOOTBALL_KEY στο .env');
  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; remaining = null; }
  if (remaining !== null && remaining <= 5) throw new Error('QUOTA: τέλος ημερήσιου ορίου κλήσεων API');
  const wait = last + Number(process.env.API_DELAY_MS ?? 6500) - Date.now();
  if (wait > 0) await sleep(wait);
  const url = new URL(BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': key } });
  last = Date.now();
  const rem = res.headers.get('x-ratelimit-requests-remaining');
  if (rem !== null) remaining = Number(rem);
  if (!res.ok) throw new Error(`API ${res.status} ${endpoint}`);
  const j = await res.json();
  const e = j.errors;
  if (e && (Array.isArray(e) ? e.length : Object.keys(e).length)) throw new Error('API: ' + JSON.stringify(e));
  return j.response || [];
}
