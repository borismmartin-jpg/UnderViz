// Open-Meteo client — free, keyless. Two roles:
//   1. Hindcast source (past_days=7) to initialise the sediment state, since
//      Windy Point Forecast returns forecast data only.
//   2. Full fallback data source when the Windy call fails.
// Marine API supplies swell; the standard forecast API supplies wind & rain.
// Wind sea is NOT taken from Open-Meteo — the model computes it from wind +
// per-site fetch, consistent with the Windy path.

import { SERVER } from '../lib/config.js';

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
 * @returns {Promise<Array>} hourly records { ts, swell1, swell2, wind, rain }
 */
export async function fetchOpenMeteoHours(lat, lon, { pastDays = 7, forecastDays = 7 } = {}) {
  const common = `latitude=${lat}&longitude=${lon}&past_days=${pastDays}&forecast_days=${forecastDays}&timeformat=unixtime&timezone=UTC`;
  const marineUrl = `https://marine-api.open-meteo.com/v1/marine?${common}` +
    '&hourly=swell_wave_height,swell_wave_period,swell_wave_direction';
  const wxUrl = `https://api.open-meteo.com/v1/forecast?${common}` +
    '&hourly=wind_speed_10m,wind_direction_10m,precipitation&wind_speed_unit=ms';

  const [marine, wx] = await Promise.all([getJson(marineUrl), getJson(wxUrl)]);
  const mh = marine?.hourly, wh = wx?.hourly;
  if (!mh?.time?.length) throw new Error('Open-Meteo marine returned no hours');

  // Index weather by unix time for merging onto the marine time base.
  const wxByTs = new Map();
  if (wh?.time?.length) {
    for (let i = 0; i < wh.time.length; i++) {
      wxByTs.set(wh.time[i], {
        speed: wh.wind_speed_10m?.[i] ?? 0,
        dir: wh.wind_direction_10m?.[i] ?? 0,
        rain: wh.precipitation?.[i] ?? 0, // hourly totals => already mm/h
      });
    }
  }

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
      wind: { speed: w.speed ?? 0, dir: w.dir ?? 0 },
      rain: w.rain ?? 0,
    });
  }
  return hours;
}
