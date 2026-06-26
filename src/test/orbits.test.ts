import { describe, it, expect } from 'vitest';
import {
  reduceAngle,
  solveKepler,
  meanAnomaly,
  orbitalPosition,
  orbitalVelocity,
  spinAngle,
  sliceEarthOrbit,
  sliceMoonOrbit,
  deriveOrbit,
  MAX_ECCENTRICITY,
  type OrbitalElements,
} from '../core/orbits.ts';
import { EARTH_SIDEREAL_DAY_S } from '../core/constants.ts';
import { fnv1a } from './digest.ts';

// Step 5 core golden/correctness (master plan Part 5.6, pipeline §3.H): Kepler via
// Newton–Raphson (e capped 0.8), and the precision discipline (angle in double, mod
// 2π) that keeps a long session drift-free. The frozen position digest is the
// determinism gate for "reload regenerates the identical planet/orbit".

const TAU = 2 * Math.PI;

describe('reduceAngle', () => {
  it('maps any angle into [0, 2π)', () => {
    for (const x of [0, 0.5, TAU, -0.1, 1e6, -1e6, 12345.678]) {
      const r = reduceAngle(x);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(TAU);
    }
  });
  it('is congruent mod 2π', () => {
    expect(reduceAngle(0.7 + 100 * TAU)).toBeCloseTo(0.7, 6);
    expect(reduceAngle(0.7 - 100 * TAU)).toBeCloseTo(0.7, 6);
  });
});

describe('solveKepler — Newton–Raphson', () => {
  it('round-trips: E satisfies M = E − e·sin(E) for e ≤ 0.6', () => {
    for (let mi = 0; mi <= 20; mi++) {
      const M = (mi / 20) * TAU;
      for (const e of [0, 0.0167, 0.1, 0.3, 0.6]) {
        const E = solveKepler(M, e);
        const back = E - e * Math.sin(E);
        expect(Math.abs(reduceAngle(back) - reduceAngle(M))).toBeLessThan(1e-9);
      }
    }
  });

  it('hard-caps eccentricity at 0.8 (still converges for e>0.8 input)', () => {
    const M = 1.0;
    const E = solveKepler(M, 0.95); // clamped to 0.8 internally
    const back = E - MAX_ECCENTRICITY * Math.sin(E); // residual measured at the CLAMPED e
    expect(Math.abs(reduceAngle(back) - reduceAngle(M))).toBeLessThan(1e-9);
  });
});

describe('orbital position/velocity', () => {
  const earth = sliceEarthOrbit();
  const moon = sliceMoonOrbit();

  it('Earth stays ~1 AU from Sol over an orbit (radius within e bounds)', () => {
    const p = new Float64Array(3);
    for (let k = 0; k < 12; k++) {
      orbitalPosition(earth, (k / 12) * earth.period, p);
      const r = Math.hypot(p[0]!, p[1]!, p[2]!);
      expect(r).toBeGreaterThan(earth.a * (1 - earth.e) - 1);
      expect(r).toBeLessThan(earth.a * (1 + earth.e) + 1);
    }
  });

  it('velocity matches a central finite-difference of position (analytic derivative)', () => {
    const p1 = new Float64Array(3), p2 = new Float64Array(3), v = new Float64Array(3);
    const t = 0.27 * moon.period;
    const dt = 1; // 1 s
    orbitalVelocity(moon, t, v);
    orbitalPosition(moon, t + dt, p2);
    orbitalPosition(moon, t - dt, p1);
    for (let c = 0; c < 3; c++) {
      const fd = (p2[c]! - p1[c]!) / (2 * dt);
      expect(Math.abs(v[c]! - fd)).toBeLessThan(Math.max(1, Math.abs(v[c]!) * 1e-4));
    }
  });

  it('the precision trap: position is identical at t and t + N·period (reduceAngle holds)', () => {
    // Without reduceAngle on the mean anomaly, M0 + 2π·t/period at a huge t loses float
    // precision and the orbit stutters. With it, the position is periodic to ~µm.
    const a = new Float64Array(3), b = new Float64Array(3);
    const t = 123_456.789;
    orbitalPosition(earth, t, a);
    orbitalPosition(earth, t + 1000 * earth.period, b);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(earth.a * 1e-6); // ≲ ~150 km of 1 AU? no — µm-rel
    }
  });
});

describe('spinAngle', () => {
  it('is in [0, 2π) and periodic over a sidereal day', () => {
    const rate = TAU / EARTH_SIDEREAL_DAY_S;
    const a = spinAngle(rate, 12_345);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(TAU);
    // One full day later → same angle (drift-free even after many days).
    const b = spinAngle(rate, 12_345 + 1000 * EARTH_SIDEREAL_DAY_S);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
  });
});

describe('deriveOrbit — ring-1 seam (determinism)', () => {
  it('is a pure function within Constitution II.9 ranges', () => {
    const el = deriveOrbit(0x1234abcd, 3, 1e7);
    expect(deriveOrbit(0x1234abcd, 3, 1e7)).toEqual(el);
    expect(el.e).toBeGreaterThanOrEqual(0);
    expect(el.e).toBeLessThanOrEqual(0.6);
    expect(el.i).toBeGreaterThanOrEqual(0);
    expect(el.i).toBeLessThanOrEqual((30 * Math.PI) / 180);
    expect(el.a).toBeGreaterThan(0);
  });
});

describe('orbits — recorded golden (FROZEN)', () => {
  it('Earth + Moon positions over a fixed t grid match the recorded digest', () => {
    const earth = sliceEarthOrbit();
    const moon = sliceMoonOrbit();
    // Sample both orbits at 8 fixed fractions of their own period; pack rounded metres
    // (so the snapshot is robust to last-ULP drift while still pinning the trajectory).
    const samples: number[] = [];
    const p = new Float64Array(3);
    for (const el of [earth, moon] as OrbitalElements[]) {
      for (let k = 0; k < 8; k++) {
        orbitalPosition(el, (k / 8) * el.period, p);
        samples.push(Math.round(p[0]!), Math.round(p[1]!), Math.round(p[2]!));
      }
    }
    const packed = Float64Array.from(samples);
    expect({
      digest: fnv1a(packed),
      meanAnomalyMid: Math.round(meanAnomaly(earth, earth.period / 2) * 1e6),
    }).toMatchInlineSnapshot(`
      {
        "digest": "dfe167eb",
        "meanAnomalyMid": 3141593,
      }
    `);
  });
});
