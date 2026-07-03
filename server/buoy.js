// Real wave-buoy observations from the AODN (IMOS) near-real-time WFS —
// aggregates WA DoT buoys, including Rottnest Island. Used to nudge the
// model: observed Hs vs modelled Hs at the observation time.
// Fails soft: any error just means "no buoy data" and the model runs unnudged.

import { SERVER } from '../lib/config.js';
import { fetchOpenMeteoHours } from './openmeteo.js';

const AODN_WFS = 'https://geoserver-123.aodn.org.au/geoserver/ows';

// Buoy registry: which observation applies to which stretch of coast.
// maxKm: sites farther than this from the buoy get no nudge.
export const BUOYS = [
  {
    id: 'rottnest',
    name: 'Rottnest Island (DoT via AODN)',
    lat: -32.1, lon: 115.4,
    cql: "site_name ILIKE '%rottnest%'",
    maxKm: 70,
  },
];

const MAX_OBS_AGE_H = 24; // older observations say little about "now"
const cache = new Map(); // buoy id -> { at, obs }
const BUOY_CACHE_TTL_MS = 30 * 60 * 1000;

/** Great-circle distance [km]. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, R = 6371;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchLatestObs(buoy) {
  const hit = cache.get(buoy.id);
  if (hit && Date.now() - hit.at < BUOY_CACHE_TTL_MS) return hit.obs;

  const params = new URLSearchParams({
    service: 'WFS', version: '2.0.0', request: 'GetFeature',
    typeNames: 'aodn:aodn_wave_nrt_v2_timeseries_data',
    outputFormat: 'application/json',
    count: '1',
    sortBy: 'TIME DESC',
    CQL_FILTER: buoy.cql,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVER.FETCH_TIMEOUT_MS);
  let obs = null;
  try {
    const res = await fetch(`${AODN_WFS}?${params}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`AODN HTTP ${res.status}`);
    const json = await res.json();
    const p = json?.features?.[0]?.properties;
    // WSSH = spectral significant height; WHTH = time-domain H1/3 fallback.
    const hs = p?.WSSH ?? p?.WHTH ?? null;
    const tp = p?.WPPE ?? p?.WPFM ?? null;
    const at = p?.TIME ? Date.parse(p.TIME) : NaN;
    if (hs > 0 && isFinite(at) && Date.now() - at < MAX_OBS_AGE_H * 3600e3) {
      obs = {
        id: buoy.id, name: buoy.name,
        hs, tp, dir: p?.WPDI ?? p?.SSWMD ?? null,
        at,
      };
      // Model Hs AT THE BUOY's location & time, so the observed/modelled
      // ratio compares like with like (an offshore buoy vs a nearshore site
      // grid point would bias the correction high).
      try {
        const om = await fetchOpenMeteoHours(buoy.lat, buoy.lon, { pastDays: 2, forecastDays: 1 });
        let rec = null;
        for (const h of om.hours) {
          if (!rec || Math.abs(h.ts - at) < Math.abs(rec.ts - at)) rec = h;
        }
        if (rec && Math.abs(rec.ts - at) <= 3 * 3600e3) {
          const hsModel = Math.hypot(rec.swell1?.height ?? 0, rec.windsea?.height ?? 0);
          if (hsModel > 0.2) obs.hsModel = hsModel;
        }
      } catch {
        // no model-at-buoy value; client will skip the nudge
      }
    }
  } catch {
    obs = null; // fail soft
  } finally {
    clearTimeout(timer);
  }
  // Negative results get a short TTL so a transient feed hiccup doesn't
  // suppress the nudge for a full cache period.
  const ttl = obs ? BUOY_CACHE_TTL_MS : 2 * 60 * 1000;
  cache.set(buoy.id, { at: Date.now() - (BUOY_CACHE_TTL_MS - ttl), obs });
  return obs;
}

/**
 * Latest usable observation from the nearest buoy covering (lat, lon),
 * or null when out of range / feed down / observation too old.
 */
export async function buoyObsForSite(lat, lon) {
  let best = null;
  for (const b of BUOYS) {
    const distKm = haversineKm(lat, lon, b.lat, b.lon);
    if (distKm > b.maxKm) continue;
    if (!best || distKm < best.distKm) best = { buoy: b, distKm };
  }
  if (!best) return null;
  const obs = await fetchLatestObs(best.buoy);
  return obs ? { ...obs, distKm: Math.round(best.distKm) } : null;
}
