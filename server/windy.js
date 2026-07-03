// Windy Point Forecast API client. The API key stays server-side.
// POST https://api.windy.com/api/point-forecast/v2
// Two requests per site: model gfsWave (waves/swell1/swell2) + model gfs (wind/precip),
// merged on their ts arrays by server/merge.js.

import { SERVER } from '../lib/config.js';
import { mergeWindy } from './merge.js';

const WINDY_URL = 'https://api.windy.com/api/point-forecast/v2';

async function post(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVER.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(WINDY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Windy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and merge Windy wave + met forecasts for a point.
 * @returns {Promise<Array>} hourly records { ts, swell1, swell2, wind, rain }
 */
export async function fetchWindyHours(lat, lon, key) {
  if (!key) throw new Error('WINDY_API_KEY not set');
  const [wave, met] = await Promise.all([
    post({ lat, lon, model: 'gfsWave', parameters: ['waves', 'swell1', 'swell2', 'windWaves'], levels: ['surface'], key }),
    post({ lat, lon, model: 'gfs', parameters: ['wind', 'precip'], levels: ['surface'], key }),
  ]);
  return mergeWindy(wave, met);
}
