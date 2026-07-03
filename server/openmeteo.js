// Open-Meteo client — free, keyless. Two roles:
//   1. Hindcast source (past_days=7) to initialise the sediment state, since
//      Windy Point Forecast returns forecast data only.
//   2. Full fallback data source when the Windy call fails.
// Marine API supplies swell/wind-waves/sea level; wind & rain come from
// server/weather.js, which layers three independent sources.

import { SERVER } from '../lib/config.js';
import { fetchWindRain } from './weather.js';

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVER.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch hourly records from Open-Meteo (marine + weather), past & forecast.
 * The marine call is required; the weather call degrades gracefully (waves
 * dominate the sediment model, so marine-only data is far better than none).
 * @returns {Promise<{hours:Array, warnings:Array<string>}>}
 */
export async function fetchOpenMeteoHours(lat, lon, { pastDays = 7, forecastDays = 7 } = {}) {
  const common = `latitude=${lat}&longitude=${lon}&past_days=${pastDays}&forecast_days=${forecastDays}&timeformat=unixtime&timezone=UTC`;
  const marineUrl = `https://marine-api.open-meteo.com/v1/marine?${common}` +
    '&hourly=swell_wave_height,swell_wave_period,swell_wave_direction,' +
    'wind_wave_height,wind_wave_period,wind_wave_direction,sea_level_height_msl';

  const warnings = [];
  const [marineRes, wxRes] = await Promise.allSettled([
    getJson(marineUrl),
    fetchWindRain(lat, lon, { pastDays, forecastDays }),
  ]);
  if (marineRes.status === 'rejected') throw marineRes.reason;
  const marine = marineRes.value;

  // Hourly wind/rain keyed by unix seconds, from the layered weather sources.
  let wxByTs = new Map();
  if (wxRes.status === 'fulfilled') {
    wxByTs = wxRes.value.byTs;
    warnings.push(...wxRes.value.warnings);
  } else {
    warnings.push(`weather fetch failed (${wxRes.reason?.message}); wind/rain unavailable for these hours`);
  }

  const mh = marine?.hourly;
  if (!mh?.time?.length) throw new Error('Open-Meteo marine returned no hours');

  const hours = [];
  for (let i = 0; i < mh.time.length; i++) {
    const tSec = mh.time[i];
    const w = wxByTs.get(tSec) ?? { speed: 0, dir: 0, rain: 0 };
    hours.push({
      ts: tSec * 1000,
      swell1: {
        height: mh.swell_wave_height?.[i] ?? 0,
        period: mh.swell_wave_period?.[i] ?? 0,
        direction: mh.swell_wave_direction?.[i] ?? null,
      },
      swell2: { height: 0, period: 0, direction: null },
      windsea: {
        height: mh.wind_wave_height?.[i] ?? 0,
        period: mh.wind_wave_period?.[i] ?? 0,
        direction: mh.wind_wave_direction?.[i] ?? null,
      },
      seaLevel: mh.sea_level_height_msl?.[i] ?? null, // tide+surge [m MSL]
      wind: { speed: w.speed ?? 0, dir: w.dir ?? 0 },
      rain: w.rain ?? 0,
    });
  }
  return { hours, warnings };
}
