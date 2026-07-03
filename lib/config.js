// UnderViz — central configuration.
// Every physical constant used by the model lives here, named and commented with units.
// This module is shared between the Node server, the browser client and the tests.

export const PHYS = {
  G: 9.81, // gravitational acceleration [m s^-2]

  // --- Linear-wave dispersion solver:  omega^2 = g * k * tanh(k*d)  ---
  NEWTON_TOL: 1e-6,     // convergence tolerance on |dk| [rad m^-1]
  NEWTON_MAX_ITER: 40,  // Newton iteration cap [-]
  KD_MAX: 50,           // cap on k*d fed to sinh/tanh to avoid overflow [-]

  // --- Fetch-limited wind sea (SMB-type growth) ---
  // H_ws = 0.0016 * (U^2/g) * sqrt(g*F/U^2)
  // T_ws = 0.286  * (U/g)   * (g*F/U^2)^(1/3)
  WIND_MIN_MS: 1.0,    // below this 10 m wind speed, no wind sea [m s^-1]
  FETCH_MIN_M: 100,    // below this fetch, no wind sea [m]
  HWS_COEFF: 0.0016,   // wind-sea height growth coefficient [-]
  TWS_COEFF: 0.286,    // wind-sea period growth coefficient [-]
  // Fully-developed (Pierson–Moskowitz) caps, so long fetches cannot grow
  // the fetch-limited formulas past a physically developed sea:
  PM_HEIGHT_COEFF: 0.21, // H_ws <= 0.21 * U^2 / g [-]
  PM_PERIOD_COEFF: 7.16, // T_ws <= 7.16 * U / g   [-]

  // --- Sediment mass balance (explicit Euler, hourly) ---
  // dC/dt = E * max(u_b - u_crit, 0)^1.5 - (w_s/d) * C
  // C is a dimensionless suspended-sediment index.
  // Per-site: E [index h^-1 (m/s)^-1.5], u_crit [m s^-1], w_s [m s^-1].
  SECONDS_PER_HOUR: 3600, // [s h^-1] (converts w_s/d [s^-1] to [h^-1])
  EULER_MAX_STEP: 0.5,    // substep so that (decay-rate * dt) <= this, for stability [-]
  DT_MIN_H: 0.25,         // clamp on integration step [h]
  DT_MAX_H: 3,            // clamp on integration step [h]

  // --- Rain-runoff turbidity ---
  // dC_r/dt = r_site * rain(t) - C_r / T_FLUSH
  // rain in [mm h^-1]; r_site per-site [index h^-1 per mm h^-1].
  T_FLUSH_HOURS: 60, // runoff flushing e-folding time ~ 2.5 days [h]

  // --- Directional exposure & depth-limited breaking ---
  // Per-site exposure table (0-1 per 8 sectors, direction swell comes FROM)
  // scales each swell component's height; missing table/sector => fully
  // exposed (1). Breaking then caps the height a given depth can carry:
  GAMMA_BREAK: 0.78, // breaker index: H <= GAMMA_BREAK * d [-] (McCowan)

  // --- Tide-modulated runoff (river-mouth sites) ---
  // Ebb tide (falling sea level) pushes the turbid river plume over the site;
  // flood suppresses it. Source term is scaled by
  //   1 + TIDE_EBB_GAIN * clamp(-d(eta)/dt / TIDE_RATE_REF, -1, +1)
  // using Open-Meteo's sea_level_height_msl. Only applied when runoff_r > 0.
  TIDE_EBB_GAIN: 0.75, // max +-75% modulation of the runoff source [-]
  TIDE_RATE_REF: 0.08, // sea-level rate that saturates the effect [m h^-1]

  // --- Wave-buoy nudging ---
  // Observed Hs / modelled Hs at the observation time, clamped, applied as a
  // height scale to all hours up to the observation and tapered to 1 over
  // NUDGE_TAPER_H hours of forecast.
  NUDGE_RATIO_MIN: 0.5,  // clamp on the correction ratio [-]
  NUDGE_RATIO_MAX: 1.8,  // clamp on the correction ratio [-]
  NUDGE_TAPER_H: 18,     // forecast hours over which the correction fades [h]

  // --- Wave energy flux (display/audit; deep-water approximation) ---
  // P = rho * g^2 * H^2 * T / (64*pi)  [W per m of wave crest]
  RHO_SEAWATER: 1025, // sea water density [kg m^-3]

  // --- Optics ---
  // Total beam attenuation c = c0_site + K_SED*C + K_RUN*C_r  [m^-1]
  // Visibility vis = SECCHI_COEFF / c  [m], clamped.
  SECCHI_COEFF: 4.8, // Secchi-type constant [-] (vis[m] * c[m^-1] ~ 4.8)
  K_SED: 0.15,       // attenuation per unit sediment index [m^-1 per index]
  K_RUN: 0.08,       // attenuation per unit runoff index [m^-1 per index]
  VIS_MIN_M: 0.5,    // visibility clamp floor [m]
  VIS_MAX_M: 40,     // visibility clamp ceiling [m]
};

export const MODEL = {
  HINDCAST_DAYS: 7,     // spin-up history required by the sediment state [days]
  DISPLAY_PAST_DAYS: 2, // how much hindcast the timeline shows, greyed [days]
  FORECAST_DAYS: 7,     // forecast horizon requested/displayed [days]
  // Bottom-type uncertainty band: the pipeline is re-run with the sediment
  // parameters (E, w_s, u_crit) blended this far toward the rocky-reef preset
  // (clearer bound) and the silt/mud preset (murkier bound).
  BAND_BLEND: 0.5,      // 0 = no band, 1 = full preset swap [-]
  DAYLIGHT_START_H: 6,  // "best window" search: earliest local hour
  DAYLIGHT_END_H: 18,   // "best window" search: latest local hour (exclusive)
};

export const SERVER = {
  DEFAULT_PORT: 3000,
  CACHE_TTL_MS: 15 * 60 * 1000,  // in-memory forecast cache TTL (Windy rate limits)
  COORD_PRECISION: 3,            // cache/history key rounding [decimal degrees]
  HISTORY_RETENTION_DAYS: 14,    // prune stored hours older than this
  FETCH_TIMEOUT_MS: 20000,       // upstream API timeout
};
