// Resampling & merging of upstream forecast responses onto a common hourly grid.
// Windy returns parallel arrays keyed like "swell1_height-surface" with a shared
// ts array (ms epoch, typically 3-hourly for GFS); we linearly interpolate scalar
// series, interpolate directions via unit vectors, and spread accumulated
// precipitation into hourly rates.

const HOUR_MS = 3.6e6;

/** Strip null/non-finite points; returns {xs, ys} parallel arrays. */
function cleanSeries(ts, vals) {
  const xs = [], ys = [];
  if (!Array.isArray(ts) || !Array.isArray(vals)) return { xs, ys };
  for (let i = 0; i < ts.length; i++) {
    const v = vals[i];
    if (v != null && isFinite(v)) { xs.push(ts[i]); ys.push(v); }
  }
  return { xs, ys };
}

/** Linear interpolation on a cleaned series; null outside its range. */
function interpAt({ xs, ys }, t) {
  const n = xs.length;
  if (n === 0 || t < xs[0] || t > xs[n - 1]) return null;
  let i = 1;
  while (i < n && xs[i] < t) i++;
  if (i >= n) return ys[n - 1];
  const x0 = xs[i - 1], x1 = xs[i];
  if (x1 === x0) return ys[i];
  const f = (t - x0) / (x1 - x0);
  return ys[i - 1] + f * (ys[i] - ys[i - 1]);
}

/** Angular (degrees) interpolation via unit vectors. */
function interpAngleAt(ts, vals, t) {
  const rad = Math.PI / 180;
  const sin = cleanSeries(ts, vals.map((v) => (v == null ? null : Math.sin(v * rad))));
  const cos = cleanSeries(ts, vals.map((v) => (v == null ? null : Math.cos(v * rad))));
  const s = interpAt(sin, t), c = interpAt(cos, t);
  if (s == null || c == null) return null;
  return ((Math.atan2(s, c) / rad) + 360) % 360;
}

/** Hourly grid [startMs, endMs] aligned to whole hours. */
export function hourlyGrid(startMs, endMs) {
  const grid = [];
  for (let t = Math.ceil(startMs / HOUR_MS) * HOUR_MS; t <= endMs; t += HOUR_MS) grid.push(t);
  return grid;
}

/**
 * Merge Windy gfsWave (waves/swell1/swell2) and gfs (wind/precip) responses
 * into hourly records on the overlap of both time ranges.
 * @returns {Array<{ts, swell1, swell2, wind, rain}>}
 */
export function mergeWindy(wave, met) {
  const wts = wave?.ts, mts = met?.ts;
  if (!Array.isArray(wts) || !wts.length || !Array.isArray(mts) || !mts.length) {
    throw new Error('Windy response missing ts arrays');
  }
  const grid = hourlyGrid(
    Math.max(wts[0], mts[0]),
    Math.min(wts[wts.length - 1], mts[mts.length - 1]),
  );

  const wS = (k) => cleanSeries(wts, wave[k] ?? []);
  const s1h = wS('swell1_height-surface'), s1p = wS('swell1_period-surface');
  const s2h = wS('swell2_height-surface'), s2p = wS('swell2_period-surface');
  const wvh = wS('waves_height-surface'), wvp = wS('waves_period-surface');
  const u = cleanSeries(mts, met['wind_u-surface'] ?? []);
  const v = cleanSeries(mts, met['wind_v-surface'] ?? []);
  const precipVals = met['past3hprecip-surface'] ?? met['precip-surface'] ?? [];

  // If swell decomposition is entirely missing, fall back to total sea as swell1.
  const haveSwell = s1h.ys.some((y) => y > 0) || s2h.ys.some((y) => y > 0);

  return grid.map((t) => {
    let swell1 = {
      height: interpAt(s1h, t) ?? 0,
      period: interpAt(s1p, t) ?? 0,
      direction: interpAngleAt(wts, wave['swell1_direction-surface'] ?? [], t),
    };
    const swell2 = {
      height: interpAt(s2h, t) ?? 0,
      period: interpAt(s2p, t) ?? 0,
      direction: interpAngleAt(wts, wave['swell2_direction-surface'] ?? [], t),
    };
    if (!haveSwell) {
      swell1 = {
        height: interpAt(wvh, t) ?? 0,
        period: interpAt(wvp, t) ?? 0,
        direction: interpAngleAt(wts, wave['waves_direction-surface'] ?? [], t),
      };
    }
    const uu = interpAt(u, t) ?? 0, vv = interpAt(v, t) ?? 0;
    const speed = Math.hypot(uu, vv); // [m/s]
    const dir = ((270 - (Math.atan2(vv, uu) * 180) / Math.PI) % 360 + 360) % 360; // meteorological "from"
    return { ts: t, swell1, swell2, wind: { speed, dir }, rain: precipRateAt(mts, precipVals, t) };
  });
}

/** Convert accumulated precip (mm per model step, timestamped at step end) to mm/h at t. */
function precipRateAt(ts, vals, t) {
  for (let i = 1; i < ts.length; i++) {
    if (t > ts[i - 1] && t <= ts[i]) {
      const mm = vals[i];
      if (mm == null || !isFinite(mm)) return 0;
      const hours = (ts[i] - ts[i - 1]) / HOUR_MS;
      return hours > 0 ? Math.max(0, mm) / hours : 0;
    }
  }
  return 0;
}

/**
 * Merge hindcast + forecast hour arrays, deduping by ts (later array wins),
 * sorted ascending.
 */
export function mergeHours(...arrays) {
  const byTs = new Map();
  for (const arr of arrays) for (const h of arr ?? []) byTs.set(h.ts, h);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
