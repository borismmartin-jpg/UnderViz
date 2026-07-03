// Forecast orchestrator: cache -> Windy (-> Open-Meteo fallback) -> history
// accumulation -> hindcast fill -> last-good stale fallback.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, SERVER } from '../lib/config.js';
import { fetchWindyHours } from './windy.js';
import { fetchOpenMeteoHours } from './openmeteo.js';
import { HistoryStore, LastGoodStore } from './store.js';
import { mergeHours } from './merge.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const history = new HistoryStore(path.join(dataDir, 'history'));
const lastGood = new LastGoodStore(path.join(dataDir, 'lastgood'));

// In-memory response cache, 15 min TTL (stay inside Windy's rate limits).
const cache = new Map(); // key -> { at, payload }

const keyFor = (lat, lon) =>
  `${lat.toFixed(SERVER.COORD_PRECISION)},${lon.toFixed(SERVER.COORD_PRECISION)}`;

/**
 * Build the full hourly series for a point: ~7 days of hindcast (accumulated
 * history, gaps filled from Open-Meteo) followed by the forecast.
 * @returns {Promise<{source:string, stale:boolean, generatedAt:number, hours:Array, warnings:Array<string>}>}
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
      forecastHours = await fetchOpenMeteoHours(lat, lon, {
        pastDays: MODEL.HINDCAST_DAYS,
        forecastDays: MODEL.FORECAST_DAYS,
      });
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

  // 3. Persist to the on-disk history so hindcast accumulates while running.
  try {
    history.upsert(key, forecastHours);
  } catch (err) {
    warnings.push(`history store write failed (${err.message})`);
  }

  // 4. Hindcast: accumulated history first; fill gaps from Open-Meteo.
  let past = history.range(key, histFrom, now);
  const expected = MODEL.HINDCAST_DAYS * 24;
  if (past.length < expected * 0.8 && source === 'windy') {
    try {
      const om = await fetchOpenMeteoHours(lat, lon, {
        pastDays: MODEL.HINDCAST_DAYS,
        forecastDays: 1,
      });
      const omPast = om.filter((h) => h.ts >= histFrom && h.ts < now);
      // History (real accumulated forecasts) wins over Open-Meteo hindcast.
      past = mergeHours(omPast, past);
      history.upsert(key, omPast);
    } catch (err) {
      // Cold start with no hindcast: the model simply spins up from the
      // earliest forecast hour — degraded but functional.
      warnings.push(`Open-Meteo hindcast failed (${err.message}); sediment state spins up from forecast start`);
    }
  }

  const hours = mergeHours(past, forecastHours);
  const payload = { source, stale: false, generatedAt: now, hours, warnings };
  cache.set(key, { at: now, payload });
  try {
    lastGood.save(key, payload);
  } catch (err) {
    warnings.push(`last-good store write failed (${err.message})`);
  }
  return payload;
}
