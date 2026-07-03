// Regression test: full pipeline over a canned 7-day scenario.
// Scenario: 2 calm days -> 3-day 2.5 m / 14 s SW groundswell (with a rain
// burst mid-event) -> 2-day decay back to 1 m.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../lib/physics.js';
import { SEED_SITES } from '../lib/sites.js';

const HOUR = 3.6e6;
const T0 = Date.UTC(2026, 0, 5); // fixed epoch => fully deterministic

/** Build the canned 7-day hourly scenario. */
function cannedScenario() {
  const hours = [];
  for (let h = 0; h < 7 * 24; h++) {
    const day = h / 24;
    let height, period;
    if (day < 2) { height = 0.8; period = 12; }         // calm
    else if (day < 5) { height = 2.5; period = 14; }    // groundswell event
    else { height = 1.0 + (5 + 2 - day) * 0; height = 1.0; period = 13; } // decayed
    const rain = day >= 3 && day < 3.25 ? 8 : 0;        // 6 h burst @ 8 mm/h on day 3
    hours.push({
      ts: T0 + h * HOUR,
      swell1: { height, period, direction: 225 },
      swell2: { height: 0.3, period: 8, direction: 200 },
      wind: { speed: 5, dir: 90 }, // offshore easterly -> near-zero fetch, no wind sea
      rain,
    });
  }
  return hours;
}

const mettams = SEED_SITES.find((s) => s.id === 'mettams');
const westEnd = SEED_SITES.find((s) => s.id === 'rotto-west-end');

// Calibration anchor from the spec: a fully exposed shallow metro sand site
// (no directional shelter), independent of any seed site's exposure table.
const EXPOSED_METRO = {
  id: 'test-exposed-metro', name: 'Exposed metro test site',
  lat: -31.9, lon: 115.75, depth_default: 3,
  c0: 0.35, u_crit: 0.10, E: 1.0, w_s: 0.0002,
  fetch: { N: 40, NE: 1, E: 1, SE: 1, S: 30, SW: 350, W: 500, NW: 300 },
  runoff_r: 0.02,
};

test('regression: shallow exposed metro site bottoms out at ~1-3 m in the event', () => {
  const out = runPipeline(cannedScenario(), EXPOSED_METRO, 3);
  const minVis = Math.min(...out.map((r) => r.vis));
  assert.ok(minVis >= 1 && minVis <= 3, `min vis ${minVis} m not in 1-3 m`);
});

test('regression: sediment lag — worst vis late in the event, ~1-2 day recovery', () => {
  // Fine-silt river-mouth site (slow settling): day 0 calm, days 1-4 event,
  // days 4-7 calm again. This is where the (w_s/d) decay term shows its lag.
  const northMole = SEED_SITES.find((s) => s.id === 'north-mole');
  const hours = [];
  for (let h = 0; h < 7 * 24; h++) {
    const day = h / 24;
    const event = day >= 1 && day < 4;
    hours.push({
      ts: T0 + h * HOUR,
      swell1: { height: event ? 2.5 : 0.3, period: event ? 14 : 10, direction: 225 },
      swell2: { height: 0, period: 0, direction: null },
      wind: { speed: 3, dir: 90 },
      rain: 0,
    });
  }
  const out = runPipeline(hours, northMole, 6);
  const worst = out.reduce((a, b) => (b.vis < a.vis ? b : a));
  const eventStart = T0 + 1 * 24 * HOUR;
  const eventEnd = T0 + 4 * 24 * HOUR;
  // C integrates: the minimum must lag the onset by >12 h (no instant response)
  assert.ok(worst.ts > eventStart + 12 * HOUR, 'vis minimum responded instantly to swell onset');
  // A full day after the swell drops, vis must still be well below calm
  const calmVis = out[20].vis; // pre-event visibility (~10.3 m)
  const after24h = out.find((r) => r.ts >= eventEnd + 24 * HOUR);
  assert.ok(after24h.vis < 0.5 * calmVis,
    `vis ${after24h.vis} recovered too fast (calm ${calmVis})`);
});

test('regression: rain burst raises runoff term at a river-mouth site, not offshore', () => {
  const northMole = SEED_SITES.find((s) => s.id === 'north-mole');
  const outNM = runPipeline(cannedScenario(), northMole, 6);
  const outWE = runPipeline(cannedScenario(), westEnd, 18);
  const peakNM = Math.max(...outNM.map((r) => r.Cr));
  const peakWE = Math.max(...outWE.map((r) => r.Cr));
  assert.ok(peakNM > 1, `North Mole runoff index ${peakNM} too small after 48 mm of rain`);
  assert.equal(peakWE, 0, 'oceanic site (runoff_r=0) must have zero runoff turbidity');
});

test('regression: fresh 1 m swell at deep oceanic site stays >12 m vis', () => {
  const hours = [];
  for (let h = 0; h < 7 * 24; h++) {
    hours.push({
      ts: T0 + h * HOUR,
      swell1: { height: 1.0, period: 12, direction: 225 },
      swell2: { height: 0, period: 0, direction: null },
      wind: { speed: 4, dir: 90 },
      rain: 0,
    });
  }
  const out = runPipeline(hours, westEnd, 18);
  const minVis = Math.min(...out.map((r) => r.vis));
  assert.ok(minVis > 12, `deep oceanic vis ${minVis} m should stay >12 m`);
});

test('regression: pinned snapshot values (guards against accidental model change)', () => {
  const out = runPipeline(cannedScenario(), EXPOSED_METRO, 3);
  // Pinned from the validated run after adding exposure/breaking/tide/nudge;
  // update deliberately if the model changes.
  const at = (day) => out[day * 24];
  const snapshot = {
    day1: at(1).vis,
    day4: at(4).vis,   // deep in the event
    day6: at(6).vis,   // recovering
  };
  // Values asserted with tolerance so FP noise doesn't flake the suite.
  const close = (a, b, tol, label) =>
    assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} != pinned ${b} ±${tol}`);
  close(snapshot.day1, 7.107, 0.05, 'day1 vis');
  close(snapshot.day4, 2.227, 0.05, 'day4 vis');
  close(snapshot.day6, 5.728, 0.05, 'day6 vis');
});

test('pipeline: directional exposure scales swell height at the site', () => {
  // Same swell, one site fully exposed vs one 50% sheltered from the SW.
  const sheltered = { ...EXPOSED_METRO, exposure: { SW: 0.5 } };
  const hours = cannedScenario().slice(0, 24);
  const open = runPipeline(hours, EXPOSED_METRO, 3);
  const shel = runPipeline(hours, sheltered, 3);
  const hOpen = open[10].comps.find((c) => c.label === 'swell1');
  const hShel = shel[10].comps.find((c) => c.label === 'swell1');
  assert.ok(Math.abs(hShel.H - hOpen.H * 0.5) < 1e-9, `expected halved height, got ${hShel.H} vs ${hOpen.H}`);
  assert.equal(hShel.expo, 0.5);
  assert.ok(shel[23].vis > open[23].vis, 'sheltered site must read better vis');
});

test('pipeline: depth-limited breaking caps wave height at 0.78·d', () => {
  const hours = [{
    ts: T0,
    swell1: { height: 4.0, period: 15, direction: 225 }, // huge swell on a 2 m bank
    swell2: { height: 0, period: 0, direction: null },
    wind: { speed: 2, dir: 90 },
    rain: 0,
  }];
  const out = runPipeline(hours, EXPOSED_METRO, 2);
  const s1 = out[0].comps.find((c) => c.label === 'swell1');
  assert.ok(s1.capped, 'component should be flagged as breaking-capped');
  assert.ok(Math.abs(s1.H - 0.78 * 2) < 1e-9, `H=${s1.H} should equal 0.78*d=1.56`);
});

test('pipeline: ebb tide boosts runoff turbidity at a river mouth, flood suppresses it', () => {
  const northMole = SEED_SITES.find((s) => s.id === 'north-mole');
  const mkHours = (rateSign) => {
    const hours = [];
    for (let h = 0; h < 48; h++) {
      hours.push({
        ts: T0 + h * HOUR,
        swell1: { height: 0.3, period: 10, direction: 225 },
        swell2: { height: 0, period: 0, direction: null },
        wind: { speed: 2, dir: 90 },
        rain: h < 12 ? 5 : 0,                       // steady rain half a day
        seaLevel: rateSign * 0.06 * h,              // monotonic ebb or flood
      });
    }
    return hours;
  };
  const ebb = runPipeline(mkHours(-1), northMole, 6);
  const flood = runPipeline(mkHours(+1), northMole, 6);
  const peakEbb = Math.max(...ebb.map((r) => r.Cr));
  const peakFlood = Math.max(...flood.map((r) => r.Cr));
  assert.ok(peakEbb > peakFlood * 1.5, `ebb Cr ${peakEbb} should clearly exceed flood Cr ${peakFlood}`);
  assert.ok(ebb[10].tide.factor > 1 && flood[10].tide.factor < 1);
});

test('pipeline: buoy nudge scales heights fully in hindcast, fading over the forecast', () => {
  const hours = [];
  for (let h = 0; h < 72; h++) {
    hours.push({
      ts: T0 + h * HOUR,
      swell1: { height: 1.0, period: 12, direction: 225 },
      swell2: { height: 0, period: 0, direction: null },
      wind: { speed: 2, dir: 90 },
      rain: 0,
    });
  }
  const obsTs = T0 + 36 * HOUR;
  const out = runPipeline(hours, EXPOSED_METRO, 3, { nudge: { ratio: 1.4, ts: obsTs } });
  const H = (i) => out[i].comps.find((c) => c.label === 'swell1').H;
  assert.ok(Math.abs(H(0) - 1.4) < 1e-9, `pre-obs hour should be fully scaled, got ${H(0)}`);
  assert.ok(Math.abs(H(36) - 1.4) < 1e-9, 'obs hour should be fully scaled');
  const mid = out[36 + 9].comps.find((c) => c.label === 'swell1').H; // half the 18 h taper
  assert.ok(Math.abs(mid - 1.2) < 0.01, `half-taper should be ~1.2, got ${mid}`);
  assert.ok(Math.abs(H(36 + 30) - 1.0) < 1e-9, 'beyond the taper the nudge must vanish');
});

test('pipeline: modelled wind sea is used when below the fetch limit', () => {
  // Onshore W wind with huge fetch, but the wave model reports a modest,
  // duration-limited wind sea -> the model value must win.
  const hours = [{
    ts: T0,
    swell1: { height: 0, period: 0, direction: null },
    swell2: { height: 0, period: 0, direction: null },
    windsea: { height: 0.6, period: 5, direction: 260 },
    wind: { speed: 12, dir: 270 }, // fetch-limited estimate would be far bigger
    rain: 0,
  }];
  const out = runPipeline(hours, mettams, 3);
  const ws = out[0].comps.find((c) => c.label === 'windsea');
  assert.equal(ws.src, 'model');
  assert.ok(Math.abs(ws.H - 0.6) < 1e-12 && Math.abs(ws.T - 5) < 1e-12);
});

test('pipeline: modelled wind sea is capped by site fetch (offshore wind)', () => {
  // The offshore grid point carries a 1.5 m wind sea, but the wind blows from
  // the land (E, ~1 km fetch) -> the site stays sheltered.
  const hours = [{
    ts: T0,
    swell1: { height: 0, period: 0, direction: null },
    swell2: { height: 0, period: 0, direction: null },
    windsea: { height: 1.5, period: 6, direction: 90 },
    wind: { speed: 12, dir: 90 },
    rain: 0,
  }];
  const out = runPipeline(hours, mettams, 3);
  const ws = out[0].comps.find((c) => c.label === 'windsea');
  assert.equal(ws.src, 'fetch-capped');
  assert.ok(ws.H < 0.25, `sheltered site wind sea H=${ws.H} should be tiny`);
});

test('pipeline: offshore wind produces (near-)zero wind sea', () => {
  // Easterly over Mettams' 1 km land-side fetch: a few-cm ripple whose short
  // period cannot reach the bed — u_b must be negligible.
  const out = runPipeline(cannedScenario(), mettams, 3);
  const ws = out[10].comps.find((c) => c.label === 'windsea');
  assert.ok(ws.H < 0.15, `offshore wind sea H=${ws.H} too large`);
  assert.ok(ws.ub < 1e-3, `offshore wind-sea u_b=${ws.ub} must be negligible`);
});
