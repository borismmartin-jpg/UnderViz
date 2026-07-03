// Unit tests for the numerics in lib/physics.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHYS } from '../lib/config.js';
import {
  solveWavenumber,
  bedOrbitalVelocity,
  windSea,
  fetchForDirection,
  stepSediment,
  stepRunoff,
  visibilityFrom,
} from '../lib/physics.js';

test('dispersion: T=12 s, d=10 m matches published intermediate-depth solution', () => {
  // omega^2 d / g = kd*tanh(kd) = 0.27944 -> kd ~= 0.5544 -> k ~= 0.0554 rad/m
  // (wavelength L = 2*pi/k ~= 113 m; cf. shallow limit 118.8 m, deep 224.6 m)
  const k = solveWavenumber(12, 10);
  assert.ok(Math.abs(k - 0.0554) < 0.001, `k=${k}`);
  // residual of the dispersion relation itself
  const omega = (2 * Math.PI) / 12;
  const res = PHYS.G * k * Math.tanh(k * 10) - omega * omega;
  assert.ok(Math.abs(res) < 1e-4, `residual=${res}`);
});

test('dispersion: deep-water limit k -> omega^2/g', () => {
  const T = 8, d = 500;
  const omega = (2 * Math.PI) / T;
  const kDeep = (omega * omega) / PHYS.G;
  const k = solveWavenumber(T, d);
  assert.ok(Math.abs(k - kDeep) / kDeep < 1e-6, `k=${k} vs deep ${kDeep}`);
});

test('dispersion: shallow-water limit k -> omega/sqrt(g d)', () => {
  const T = 20, d = 2;
  const omega = (2 * Math.PI) / T;
  const kShallow = omega / Math.sqrt(PHYS.G * d);
  const k = solveWavenumber(T, d);
  assert.ok(Math.abs(k - kShallow) / kShallow < 0.02, `k=${k} vs shallow ${kShallow}`);
});

test('dispersion: invalid input returns NaN', () => {
  assert.ok(Number.isNaN(solveWavenumber(0, 10)));
  assert.ok(Number.isNaN(solveWavenumber(10, -5)));
  assert.ok(Number.isNaN(solveWavenumber(NaN, 10)));
});

test('u_b: deep water yields ~0; shallow water is strong; degenerate input is 0', () => {
  assert.ok(bedOrbitalVelocity(2, 10, 500) < 1e-8);       // 2 m @ 10 s over 500 m: nothing at bed
  assert.ok(bedOrbitalVelocity(2, 14, 4) > 0.5);          // groundswell on a 4 m bank: violent
  assert.equal(bedOrbitalVelocity(0, 10, 10), 0);
  assert.equal(bedOrbitalVelocity(2, 0, 10), 0);
  assert.equal(bedOrbitalVelocity(2, 10, 0), 0);
});

test('u_b: monotonically decreasing with depth', () => {
  let prev = Infinity;
  for (const d of [2, 5, 10, 20, 50, 100]) {
    const ub = bedOrbitalVelocity(2, 12, d);
    assert.ok(ub < prev, `u_b(${d})=${ub} not < ${prev}`);
    prev = ub;
  }
});

test('wind sea: zero for offshore wind (no fetch) and calm', () => {
  assert.deepEqual(windSea(15, 0), { H: 0, T: 0 });
  assert.deepEqual(windSea(0.2, 500e3), { H: 0, T: 0 });
});

test('wind sea: grows with fetch, capped at fully developed (PM)', () => {
  const U = 10;
  const short = windSea(U, 5e3);
  const long_ = windSea(U, 200e3);
  assert.ok(long_.H > short.H && long_.T > short.T);
  const huge = windSea(U, 5e6);
  const pmH = (PHYS.PM_HEIGHT_COEFF * U * U) / PHYS.G;
  assert.ok(huge.H <= pmH + 1e-12, `H=${huge.H} exceeds PM cap ${pmH}`);
});

test('fetch lookup: W wind reads W sector; wraps at 360', () => {
  const table = { N: 1, NE: 2, E: 3, SE: 4, S: 5, SW: 6, W: 7, NW: 8 };
  assert.equal(fetchForDirection(table, 270), 7);
  assert.equal(fetchForDirection(table, 359), 1);
  assert.equal(fetchForDirection(table, 0), 1);
  assert.equal(fetchForDirection(table, 225), 6);
});

test('sediment ODE: converges to analytic steady state', () => {
  const site = { E: 1.0, u_crit: 0.1, w_s: 0.0002 };
  const d = 5, ub = 0.5;
  const excess = ub - site.u_crit;
  const decayPerH = (site.w_s / d) * 3600;
  const cAnalytic = (site.E * Math.pow(excess, 1.5)) / decayPerH;
  let C = 0;
  for (let i = 0; i < 3000; i++) C = stepSediment(C, ub, site, d, 1);
  assert.ok(Math.abs(C - cAnalytic) / cAnalytic < 0.01, `C=${C} vs analytic ${cAnalytic}`);
});

test('sediment ODE: no erosion below u_crit; decays toward zero', () => {
  const site = { E: 1.0, u_crit: 0.1, w_s: 0.0002 };
  let C = stepSediment(10, 0.05, site, 5, 1);
  assert.ok(C < 10);
  for (let i = 0; i < 500; i++) C = stepSediment(C, 0.05, site, 5, 1);
  assert.ok(C < 0.01, `C=${C} should have settled out`);
});

test('sediment ODE: stable (no negative/oscillating C) even for harsh decay', () => {
  const site = { E: 0.5, u_crit: 0.1, w_s: 0.0005 }; // decay = 1.8/h at d=1
  let C = 20;
  for (let i = 0; i < 50; i++) {
    C = stepSediment(C, 0, site, 1, 1);
    assert.ok(C >= 0, `C went negative: ${C}`);
  }
  assert.ok(C < 1e-6);
});

test('runoff ODE: e-folds on T_FLUSH; accumulates with rain', () => {
  const site = { runoff_r: 0.1 };
  let Cr = 1;
  for (let i = 0; i < PHYS.T_FLUSH_HOURS; i++) Cr = stepRunoff(Cr, 0, site, 1);
  // explicit Euler of exponential decay after one e-folding time: ~e^-1
  assert.ok(Math.abs(Cr - Math.exp(-1)) < 0.05, `Cr=${Cr}`);
  assert.ok(stepRunoff(0, 10, site, 1) > 0.9); // 0.1 * 10 mm/h ~= 1 per hour
});

test('optics: clamps to [VIS_MIN, VIS_MAX] and splits attenuation terms', () => {
  const clear = visibilityFrom(0, 0, 0.05);
  assert.equal(clear.vis, PHYS.VIS_MAX_M);
  const filthy = visibilityFrom(1000, 0, 0.3);
  assert.equal(filthy.vis, PHYS.VIS_MIN_M);
  const mid = visibilityFrom(2, 1, 0.2);
  assert.ok(Math.abs(mid.c - (0.2 + PHYS.K_SED * 2 + PHYS.K_RUN * 1)) < 1e-12);
  assert.ok(Math.abs(mid.vis - PHYS.SECCHI_COEFF / mid.c) < 1e-12);
});
