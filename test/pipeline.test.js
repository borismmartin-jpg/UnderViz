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

test('regression: shallow exposed metro site bottoms out at ~1-3 m in the event', () => {
  const out = runPipeline(cannedScenario(), mettams, 3);
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
  const out = runPipeline(cannedScenario(), mettams, 3);
  // Pinned from the initial validated run; update deliberately if the model changes.
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
  close(snapshot.day4, 2.048, 0.05, 'day4 vis');
  close(snapshot.day6, 5.727, 0.05, 'day6 vis');
});

test('pipeline: offshore wind produces (near-)zero wind sea', () => {
  // Easterly over Mettams' 1 km land-side fetch: a few-cm ripple whose short
  // period cannot reach the bed — u_b must be negligible.
  const out = runPipeline(cannedScenario(), mettams, 3);
  const ws = out[10].comps.find((c) => c.label === 'windsea');
  assert.ok(ws.H < 0.15, `offshore wind sea H=${ws.H} too large`);
  assert.ok(ws.ub < 1e-3, `offshore wind-sea u_b=${ws.ub} must be negligible`);
});
