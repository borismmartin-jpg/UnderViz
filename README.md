# UnderViz — underwater visibility forecast

Physics-based estimate and 7-day forecast of underwater visibility (metres) for
dive / spearfishing sites, driven entirely by weather & marine forecast data —
no user reports. Ships with a Perth / Rottnest / WA site list.

> **Planning estimate, not a measurement.** Plankton blooms, tides and boat
> traffic are not modelled.

## Setup

```bash
cp .env.example .env      # put your Windy Point Forecast key in WINDY_API_KEY
npm install
npm start                 # http://localhost:3000
npm test                  # numerics unit tests + pipeline regression
```

Without a `WINDY_API_KEY` the server runs entirely on the free Open-Meteo APIs
(no key needed) — Windy simply improves the swell decomposition (two swell
trains instead of one).

## Architecture

```
public/    single-page client (vanilla JS, dark theme, mobile-first)
lib/       shared physics + config + site data (ESM, used by client AND tests)
server/    minimal Express app
  windy.js      Windy Point Forecast proxy (key stays server-side)
  openmeteo.js  hindcast source + full fallback
  merge.js      resample 3-hourly model output onto an hourly grid
  forecast.js   orchestrator: cache → Windy → Open-Meteo → last-good
  store.js      on-disk JSON stores (history accumulation, last-good)
  data/         created at runtime (gitignored)
```

- The client runs the physics pipeline in the browser, so the depth slider
  recomputes instantly without another API call.
- Responses are cached in memory for **15 min** (Windy rate limits).
- Windy returns **forecast only** — no hindcast. The server persists every
  fetched forecast to `server/data/history/` so history accumulates while the
  app runs; gaps in the past 7 days are filled from Open-Meteo Marine
  (`past_days=7`). On a cold start with no reachable hindcast, the sediment
  state simply spins up from the earliest forecast hour (degraded, flagged).
- If Windy fails → Open-Meteo. If both fail → last good forecast from disk
  with a `stale` flag, surfaced as a banner in the UI.

## The model

Stepped hourly from 7 days in the past to the end of the forecast horizon.
All constants live in [lib/config.js](lib/config.js), named and commented with units.

**1 · Wave forcing → bed orbital velocity** (linear/Airy theory, per component:
swell1, swell2 and the wind sea). Each component's height passes through three
stages before reaching the bed-orbital computation:

    H_site = min( H_offshore · nudge · exposure(dir),  0.78·d )

- *nudge*: wave-buoy correction (below);
- *exposure(dir)*: per-site 0–1 factor by 8 compass sectors for the direction
  the swell comes FROM (island/reef/land shadowing — Salmon Bay ignores a NW
  storm, cops a southerly);
- *0.78·d*: depth-limited breaking (McCowan) — a 3 m bank physically cannot
  carry a 2.5 m wave.

    ω² = g·k·tanh(k·d)                (Newton iteration for k, |Δk| < 1e-6)
    u_b = π·H / (T·sinh(k·d))          (k·d capped at 50; deep water → u_b → 0)
    u_b,total = √(Σ u_b,i²)

The wind sea prefers the wave model's own `windWaves` component (Windy
`gfsWave` / Open-Meteo `wind_wave_*` — captures duration effects and remotely
generated seas), **capped by the site's fetch-limited estimate** so local
sheltering still applies (offshore wind → flat water even when the offshore
grid point carries wind sea):

    H_ws = min(H_windWaves, 0.0016·(U²/g)·√(g·F/U²))
    T_ws = 0.286·(U/g)·(g·F/U²)^(1/3)  when the fetch cap governs
    (fetch-limited growth itself capped at the Pierson–Moskowitz sea)

The explainer panel also reports each component's deep-water wave energy flux
`P = ρ·g²·H²·T/(64π)` [kW/m] as an auditable "wave power" readout; resuspension
itself is driven by bed orbital velocity (which includes depth attenuation
that surface wave power lacks).

**2 · Sediment mass balance** (explicit Euler, hourly; the source of the
1–2 day lag/recovery after swell events — no ad-hoc "swell days" factor):

    dC/dt = E·max(u_b,total − u_crit, 0)^1.5 − (w_s/d)·C

**3 · Rain → runoff turbidity** (exponential decay, T_flush ≈ 2.5 days),
tide-modulated at river-mouth sites — an ebb tide pushes the turbid plume over
the site, a flood holds it back:

    dC_r/dt = tide(t)·r_site·rain(t) − C_r/T_flush
    tide(t) = 1 + 0.75·clamp(−dη/dt / 0.08 m·h⁻¹, −1, +1)

`η` is Open-Meteo Marine's `sea_level_height_msl` (tide + surge). Applied only
where `runoff_r > 0`.

**Wave-buoy nudging.** The latest observation from the nearest real wave buoy
(DoT Rottnest Island, via the AODN near-real-time WFS) is compared against the
model **at the buoy's own location** and the ratio (clamped 0.5–1.8) scales
all wave heights: fully for hours up to the observation, fading to 1 over the
next 18 forecast hours. Feed down / buoy too far / observation older than 24 h
→ no nudge, model runs raw.

**4 · Optics → visibility** (Secchi-type, clamped 0.5–40 m):

    c   = c₀,site + k_sed·C + k_run·C_r      [beam attenuation, m⁻¹]
    vis = 4.8 / c                            [m]

Calibration (`k_sed = 0.15`, `k_run = 0.08`) is pinned by the regression tests:
a 5-day 2.5 m SW groundswell at a shallow exposed metro site bottoms out at
~2 m vis; a fresh 1 m swell at Rottnest West End stays > 12 m.

The "why this number" panel in the UI shows every intermediate live: u_b per
component, C, C_r and each attenuation term's share.

## Adding a site

Append to `SEED_SITES` in [lib/sites.js](lib/sites.js):

```js
{
  id: 'my-reef', name: 'My Reef',
  lat: -31.9, lon: 115.7,
  depth_default: 8,      // m (user-adjustable via slider)
  c0: 0.25,              // baseline attenuation m⁻¹ (oceanic ~0.15, metro 0.3–0.5)
  u_crit: 0.10,          // critical resuspension velocity m/s (0.08–0.15)
  E: 1.0,                // erodibility (silt 1.2 > sand 1.0 > reef 0.3)
  w_s: 0.00025,          // settling velocity m/s (1e-4 fine silt … 5e-4 coarse)
  fetch: { N: 50, NE: 1, E: 1, SE: 1, S: 50, SW: 400, W: 500, NW: 300 }, // km
  runoff_r: 0.02,        // 0 offshore … 0.15 river mouth
  notes: 'Short description',
}
```

Custom sites can also be added in the UI (“＋ add”); they persist to the
browser's localStorage.

## Installing on a phone (PWA)

UnderViz is a Progressive Web App: `public/manifest.webmanifest` + `public/sw.js`
make it installable with offline support (app shell is cached; the last fetched
forecast per site keeps working offline, flagged with a "cached forecast" banner).

1. Host the server somewhere reachable by the phone — a free tier on Render /
   Fly.io / Railway works (`npm start`, set `WINDY_API_KEY` in the host's
   environment). PWA install requires **HTTPS** (or plain `localhost`).
2. Open the URL on the phone:
   - **Android (Chrome):** tap the "⤓ install" button in the top bar, or the
     browser's *Install app* menu entry.
   - **iOS (Safari):** Share → *Add to Home Screen* (iOS doesn't fire the
     install prompt, so the button won't appear there — this is normal).

Icons are generated, not hand-drawn — tweak `scripts/gen-icons.mjs` and re-run
`node scripts/gen-icons.mjs` to restyle them. Bump `VERSION` in `public/sw.js`
when shipping breaking front-end changes so clients drop the old cache.

For real App Store / Play Store distribution, wrap `public/` with
[Capacitor](https://capacitorjs.com) — the frontend needs no changes, but the
API base URL must point at your hosted server instead of `/`.

## Tests

`npm test` runs (Node's built-in runner, no extra deps):

- dispersion solver vs published solution (T=12 s, d=10 m → k ≈ 0.0554 rad/m)
  and its deep-/shallow-water limits,
- u_b limits (deep → 0, monotone in depth), wind-sea fetch/PM-cap behaviour,
- sediment ODE steady state vs the analytic solution, stability, settling,
- runoff ODE e-folding,
- full-pipeline regression on a canned 7-day swell + rain scenario with pinned
  snapshot values.
