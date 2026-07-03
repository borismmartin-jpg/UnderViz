// Layered wind/rain acquisition. The marine (swell) data has one good source,
// but wind/rain has three independent ones, tried in order:
//   1. api.open-meteo.com                    (primary: past_days + forecast)
//   2. historical-forecast-api.open-meteo.com (same model, separate host — past)
//      + api.met.no locationforecast          (Norwegian met service — forecast)
// Returns an hourly map ts[sec] -> { speed [m/s], dir [deg from], rain [mm/h] }.

import { SERVER } from '../lib/config.js';

// met.no requires an identifying User-Agent (their terms of service).
const METNO_UA = 'UnderViz/0.1 underwater-visibility-forecast';

async function getJson(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVER.FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Open-Meteo hourly arrays -> ts map. */
function mapFromOpenMeteo(hourly, target) {
  if (!hourly?.time?.length) return target;
  for (let i = 0; i < hourly.time.length; i++) {
    target.set(hourly.time[i], {
      speed: hourly.wind_speed_10m?.[i] ?? 0,
      dir: hourly.wind_direction_10m?.[i] ?? 0,
      rain: hourly.precipitation?.[i] ?? 0, // hourly totals => already mm/h
    });
  }
  return target;
}

/** met.no timeseries -> hourly ts map (forward-fills its 6-hourly tail). */
function mapFromMetNo(json, target) {
  const pts = json?.properties?.timeseries;
  if (!pts?.length) return target;
  for (let i = 0; i < pts.length; i++) {
    const t0 = Math.floor(Date.parse(pts[i].time) / 1000);
    const t1 = i + 1 < pts.length ? Math.floor(Date.parse(pts[i + 1].time) / 1000) : t0 + 3600;
    const inst = pts[i].data?.instant?.details ?? {};
    const stepH = Math.max(1, Math.round((t1 - t0) / 3600));
    // Normalise the accumulated precip of this step to a per-hour rate.
    const acc = pts[i].data?.next_1_hours?.details?.precipitation_amount
      ?? pts[i].data?.next_6_hours?.details?.precipitation_amount;
    const rain = acc != null ? acc / (pts[i].data?.next_1_hours ? 1 : Math.min(stepH, 6)) : 0;
    for (let t = t0; t < t1 && t < t0 + 6 * 3600; t += 3600) {
      target.set(t, {
        speed: inst.wind_speed ?? 0,
        dir: inst.wind_from_direction ?? 0,
        rain,
      });
    }
  }
  return target;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Fetch hourly wind/rain around now: pastDays back, forecastDays forward.
 * @returns {Promise<{byTs: Map<number, {speed:number, dir:number, rain:number}>,
 *   warnings: Array<string>}>} — byTs may be empty if every source failed.
 */
export async function fetchWindRain(lat, lon, { pastDays = 7, forecastDays = 7 } = {}) {
  const warnings = [];

  // 1. Primary: one call covers the whole window.
  try {
    const wx = await getJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&past_days=${pastDays}&forecast_days=${forecastDays}&timeformat=unixtime&timezone=UTC` +
      '&hourly=wind_speed_10m,wind_direction_10m,precipitation&wind_speed_unit=ms',
    );
    return { byTs: mapFromOpenMeteo(wx.hourly, new Map()), warnings };
  } catch (err) {
    warnings.push(`primary weather host down (${err.message.slice(0, 80)}); using fallbacks`);
  }

  // 2. Fallbacks in parallel: historical-forecast (past..today) + met.no (now..).
  const now = Date.now();
  const [hf, mn] = await Promise.allSettled([
    getJson(
      `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&start_date=${isoDate(now - pastDays * 86400e3)}&end_date=${isoDate(now)}` +
      '&timeformat=unixtime&timezone=UTC' +
      '&hourly=wind_speed_10m,wind_direction_10m,precipitation&wind_speed_unit=ms',
    ),
    getJson(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
      { 'User-Agent': METNO_UA },
    ),
  ]);

  const byTs = new Map();
  // met.no first, then historical-forecast overwrites the overlap (same model
  // family as the primary -> more consistent with the marine data).
  if (mn.status === 'fulfilled') mapFromMetNo(mn.value, byTs);
  else warnings.push(`met.no failed (${mn.reason?.message?.slice(0, 80)})`);
  if (hf.status === 'fulfilled') mapFromOpenMeteo(hf.value.hourly, byTs);
  else warnings.push(`historical-forecast failed (${hf.reason?.message?.slice(0, 80)})`);

  if (byTs.size === 0) warnings.push('all weather sources failed; wind/rain unavailable for these hours');
  else warnings.push('wind/rain from fallback sources (historical-forecast + met.no)');
  return { byTs, warnings };
}
