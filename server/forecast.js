// Forecast orchestrator: cache -> Windy (-> Open-Meteo fallback) ->
// Open-Meteo companion enrichment (hindcast fill, windsea backfill, sea level
// for tides) -> buoy observation -> history accumulation -> last-good stale
// fallback.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, SERVER } from '../lib/config.js';
import { fetchWindyHours } from './windy.js';
import { fetchOpenMeteoHours } from './openmeteo.js';
import { buoyObsForSite } from './buoy.js';
import { HistoryStore, LastGoodStore } from './store.js';
import { mergeHours } from './merge.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const history = new HistoryStore(path.join(dataDir, 'history'));
const lastGood = new LastGoodStore(path.join(dataDir, 'lastgood'));

// In-memory response cache, 15 min TTL (stay inside Windy's rate limits).
const cache = new Map(); // key -> { at, payload }

const keyFor = (lat, lon) =>
  `${lat.toFixed(SERVER.COORD_PRECISION)},${lon.toFixed(SERVER.COORD_PRECISION)}`;

/** Copy fields the base record lacks (windsea, seaLevel) from a donor record. */
function enrich(h, donor) {
  if (!donor) return h;
  if (h.windsea != null && h.seaLevel != null) return h;
  const m = { ...h };
  if (m.windsea == null) m.windsea = donor.windsea;
  if (m.seaLevel == null) m.seaLevel = donor.seaLevel ?? null;
  return m;
}

/**
 * Build the full hourly series for a point: ~7 days of hindcast (accumulated
 * history, gaps filled from Open-Meteo) followed by the forecast, plus the
 * nearest wave-buoy observation for nudging.
 * @returns {Promise<{source:string, stale:boolean, generatedAt:number,
 *   hours:Array, buoy:object|null, warnings:Array<string>}>}
 */
export async function getForecast(lat, lon) {
  const key = keyFor(lat, lon);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < SERVER.CACHE_TTL_MS) return hit.payload;

  const now = Date.now();
  const histFrom = now - MODEL.HINDCAST_DAYS * 86400e3;
  const warnings = [];

  // 1. Forecast: Windy first, Open-Meteo on failure.
  let forecastHours = null;
  let source = null;
  if (process.env.WINDY_API_KEY) {
    try {
      forecastHours = await fetchWindyHours(lat, lon, process.env.WINDY_API_KEY);
      source = 'windy';
    } catch (err) {
      warnings.push(`Windy failed (${err.message}); using Open-Meteo`);
    }
  } else {
    warnings.push('WINDY_API_KEY not set; using Open-Meteo');
  }
  if (!forecastHours) {
    try {
      const om = await fetchOpenMeteoHours(lat, lon, {
        pastDays: MODEL.HINDCAST_DAYS,
        forecastDays: MODEL.FORECAST_DAYS,
      });
      forecastHours = om.hours;
      warnings.push(...om.warnings);
      source = 'open-meteo';
    } catch (err) {
      warnings.push(`Open-Meteo failed (${err.message})`);
    }
  }

  // 2. Both failed -> serve last-good from disk with a staleness flag.
  if (!forecastHours) {
    const saved = lastGood.load(key);
    if (saved) {
      const payload = { ...saved.payload, stale: true, staleSince: saved.savedAt, warnings };
      cache.set(key, { at: Date.now(), payload });
      return payload;
    }
    const err = new Error('All forecast sources failed and no cached data exists');
    err.status = 502;
    err.warnings = warnings;
    throw err;
  }

  // 3. Open-Meteo companion fetch on the Windy path. Windy has no hindcast
  //    and no sea level, so this supplies: hindcast gap fill, windsea backfill
  //    for pre-existing history, and sea level (tides) for every hour.
  let past = history.range(key, histFrom, now);
  if (source === 'windy') {
    try {
      const om = await fetchOpenMeteoHours(lat, lon, {
        pastDays: MODEL.HINDCAST_DAYS,
        forecastDays: MODEL.FORECAST_DAYS,
      });
      warnings.push(...om.warnings);
      const omByTs = new Map(om.hours.map((h) => [h.ts, h]));
      forecastHours = forecastHours.map((h) => enrich(h, omByTs.get(h.ts)));
      // History (real accumulated forecasts) wins over Open-Meteo hindcast,
      // but keep Open-Meteo fields a stored hour lacks.
      past = past.map((h) => enrich(h, omByTs.get(h.ts)));
      const omPast = om.hours.filter((h) => h.ts >= histFrom && h.ts < now);
      past = mergeHours(omPast, past);
    } catch (err) {
      // Cold start with no hindcast: the model simply spins up from the
      // earliest forecast hour — degraded but functional.
      warnings.push(`Open-Meteo companion fetch failed (${err.message}); no tide data, hindcast may be thin`);
    }
  }

  // 4. Persist to the on-disk history so hindcast accumulates while running.
  //    (Merged past has history-wins already applied; safe to write back.)
  try {
    history.upsert(key, past);
    history.upsert(key, forecastHours);
  } catch (err) {
    warnings.push(`history store write failed (${err.message})`);
  }

  // 5. Nearest wave-buoy observation (null when out of range or feed down).
  let buoy = null;
  try {
    buoy = await buoyObsForSite(lat, lon);
  } catch {
    buoy = null;
  }

  const hours = mergeHours(past, forecastHours);
  const payload = { source, stale: false, generatedAt: now, hours, buoy, warnings };
  cache.set(key, { at: now, payload });
  try {
    lastGood.save(key, payload);
  } catch (err) {
    warnings.push(`last-good store write failed (${err.message})`);
  }
  return payload;
}
