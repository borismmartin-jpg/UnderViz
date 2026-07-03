// UnderViz — physics model.
// Pure functions, shared by the browser client and the Node test suite.
// Pipeline per site, stepped hourly:
//   waves -> bed orbital velocity (Airy theory)
//   sediment mass balance (explicit Euler ODE)
//   rain -> runoff turbidity (exponential decay)
//   optics -> visibility (Secchi-type)

import { PHYS } from './config.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Solve the linear dispersion relation omega^2 = g*k*tanh(k*d) for wavenumber k.
 * Newton iteration; initial guess k = omega^2/g (deep water); converges to
 * |dk| < NEWTON_TOL; guards non-finite / negative iterates by restarting from
 * the shallow-water estimate k = omega/sqrt(g*d).
 * @param {number} T wave period [s]
 * @param {number} d water depth [m]
 * @returns {number} wavenumber k [rad m^-1], or NaN for invalid input
 */
export function solveWavenumber(T, d) {
  if (!isFinite(T) || !isFinite(d) || T <= 0 || d <= 0) return NaN;
  const omega = (2 * Math.PI) / T;                 // angular frequency [rad s^-1]
  const target = (omega * omega) / PHYS.G;         // k*tanh(k*d) must equal this
  let k = target;                                  // deep-water initial guess
  for (let i = 0; i < PHYS.NEWTON_MAX_ITER; i++) {
    const kd = Math.min(k * d, PHYS.KD_MAX);
    const th = Math.tanh(kd);
    const f = k * th - target;
    const dfdk = th + k * d * (1 - th * th);       // d/dk [k*tanh(kd)]
    if (!isFinite(dfdk) || dfdk === 0) break;
    const dk = f / dfdk;
    k -= dk;
    if (!isFinite(k) || k <= 0) {
      k = omega / Math.sqrt(PHYS.G * d);           // shallow-water restart
      continue;
    }
    if (Math.abs(dk) < PHYS.NEWTON_TOL) break;
  }
  return k;
}

/**
 * Wave-induced bed orbital velocity amplitude from Airy theory:
 *   u_b = pi*H / (T*sinh(k*d))
 * k*d is capped (KD_MAX) to avoid overflow; deep water correctly yields u_b -> 0.
 * @param {number} H wave height [m]
 * @param {number} T wave period [s]
 * @param {number} d water depth [m]
 * @returns {number} u_b [m s^-1] (0 for degenerate input)
 */
export function bedOrbitalVelocity(H, T, d) {
  if (!(H > 0) || !(T > 0) || !(d > 0)) return 0;
  const k = solveWavenumber(T, d);
  if (!isFinite(k) || k <= 0) return 0;
  const kd = Math.min(k * d, PHYS.KD_MAX);
  const s = Math.sinh(kd);
  if (!isFinite(s) || s <= 0) return 0;
  return (Math.PI * H) / (T * s);
}

/**
 * Fetch-limited wind sea from 10 m wind speed and directional fetch,
 * capped at the fully developed (Pierson–Moskowitz) sea state.
 * @param {number} U 10 m wind speed [m s^-1]
 * @param {number} fetchM fetch in the upwind direction [m]
 * @returns {{H:number, T:number}} significant height [m] and period [s]
 */
export function windSea(U, fetchM) {
  if (!(U >= PHYS.WIND_MIN_MS) || !(fetchM >= PHYS.FETCH_MIN_M)) return { H: 0, T: 0 };
  const g = PHYS.G;
  const chi = (g * fetchM) / (U * U); // dimensionless fetch [-]
  let H = PHYS.HWS_COEFF * ((U * U) / g) * Math.sqrt(chi);
  let T = PHYS.TWS_COEFF * (U / g) * Math.cbrt(chi);
  H = Math.min(H, (PHYS.PM_HEIGHT_COEFF * U * U) / g);
  T = Math.min(T, (PHYS.PM_PERIOD_COEFF * U) / g);
  return { H, T };
}

const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Look up the site fetch [km] for the sector the wind blows FROM.
 * @param {object} fetchTable {N,NE,E,SE,S,SW,W,NW} in km
 * @param {number} dirFromDeg meteorological wind direction [deg from]
 */
export function fetchForDirection(fetchTable, dirFromDeg) {
  if (!fetchTable || !isFinite(dirFromDeg)) return 0;
  const idx = Math.round((((dirFromDeg % 360) + 360) % 360) / 45) % 8;
  return fetchTable[SECTORS[idx]] ?? 0;
}

/**
 * One explicit-Euler step of the sediment mass balance:
 *   dC/dt = E * max(u_b - u_crit, 0)^1.5 - (w_s/d) * C
 * Internally substeps when the decay term would make a plain Euler step
 * unstable (decay*dt > EULER_MAX_STEP) — still explicit Euler, just finer.
 * @param {number} C  current sediment index [-]
 * @param {number} ub total bed orbital velocity [m s^-1]
 * @param {{E:number,u_crit:number,w_s:number}} site
 * @param {number} d  water depth [m]
 * @param {number} dtH time step [h]
 * @returns {number} next C [-]
 */
export function stepSediment(C, ub, site, d, dtH) {
  const excess = Math.max(ub - site.u_crit, 0);          // [m s^-1]
  const erosion = site.E * Math.pow(excess, 1.5);        // [index h^-1]
  const decay = (site.w_s / d) * PHYS.SECONDS_PER_HOUR;  // [h^-1]
  const n = Math.max(1, Math.ceil((decay * dtH) / PHYS.EULER_MAX_STEP));
  const h = dtH / n;
  let c = C;
  for (let i = 0; i < n; i++) c = Math.max(0, c + h * (erosion - decay * c));
  return c;
}

/**
 * One explicit-Euler step of runoff turbidity:
 *   dC_r/dt = r_site * rain(t) - C_r / T_FLUSH
 * @param {number} Cr current runoff index [-]
 * @param {number} rainMmH rain rate [mm h^-1]
 * @param {{runoff_r:number}} site
 * @param {number} dtH time step [h]
 */
export function stepRunoff(Cr, rainMmH, site, dtH) {
  const src = (site.runoff_r ?? 0) * Math.max(rainMmH, 0); // [index h^-1]
  return Math.max(0, Cr + dtH * (src - Cr / PHYS.T_FLUSH_HOURS));
}

/**
 * Optics: total beam attenuation and Secchi-type visibility.
 * @returns {{c:number, cSed:number, cRun:number, vis:number}}
 */
export function visibilityFrom(C, Cr, c0) {
  const cSed = PHYS.K_SED * C;   // [m^-1]
  const cRun = PHYS.K_RUN * Cr;  // [m^-1]
  const c = c0 + cSed + cRun;    // [m^-1]
  const vis = clamp(PHYS.SECCHI_COEFF / c, PHYS.VIS_MIN_M, PHYS.VIS_MAX_M);
  return { c, cSed, cRun, vis };
}

/**
 * Run the full pipeline over an hourly series.
 * @param {Array} hours sorted records: { ts [ms epoch],
 *   swell1:{height,period,direction}, swell2:{height,period,direction},
 *   wind:{speed [m/s], dir [deg from]}, rain [mm/h] }
 * @param {object} site site parameters (see lib/sites.js)
 * @param {number} [depth] water depth override [m]; defaults to site.depth_default
 * @returns {Array} per-hour results with auditable intermediates
 */
export function runPipeline(hours, site, depth) {
  const d = Math.max(0.5, depth ?? site.depth_default);
  let C = 0;   // suspended sediment index [-]
  let Cr = 0;  // runoff turbidity index [-]
  let prevTs = null;
  const out = [];
  for (const hr of hours) {
    const dtH = prevTs == null
      ? 1
      : clamp((hr.ts - prevTs) / 3.6e6, PHYS.DT_MIN_H, PHYS.DT_MAX_H);
    prevTs = hr.ts;

    // Wave components: two swell trains + locally generated wind sea.
    const comps = [];
    for (const [label, sw] of [['swell1', hr.swell1], ['swell2', hr.swell2]]) {
      const H = sw?.height ?? 0;
      const T = sw?.period ?? 0;
      comps.push({ label, H, T, dir: sw?.direction ?? null, ub: bedOrbitalVelocity(H, T, d) });
    }
    const U = hr.wind?.speed ?? 0;
    const wdir = hr.wind?.dir ?? 0;
    const fetchKm = fetchForDirection(site.fetch, wdir);
    const ws = windSea(U, fetchKm * 1000);
    comps.push({ label: 'windsea', H: ws.H, T: ws.T, dir: wdir, ub: bedOrbitalVelocity(ws.H, ws.T, d) });

    // Combine components in quadrature.
    const ubTotal = Math.sqrt(comps.reduce((s, c) => s + c.ub * c.ub, 0));

    C = stepSediment(C, ubTotal, site, d, dtH);
    const rain = hr.rain ?? 0;
    Cr = stepRunoff(Cr, rain, site, dtH);

    const { c, cSed, cRun, vis } = visibilityFrom(C, Cr, site.c0);
    out.push({
      ts: hr.ts,
      comps, ubTotal, uCrit: site.u_crit,
      C, Cr,
      c0: site.c0, cSed, cRun, attenuation: c,
      vis,
      wind: { speed: U, dir: wdir }, rain,
      swell1: hr.swell1, swell2: hr.swell2,
      depth: d, fetchKm,
    });
  }
  return out;
}
