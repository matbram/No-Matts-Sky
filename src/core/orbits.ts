// ─────────────────────────────────────────────────────────────────────────────
// Orbital mechanics — PURE TS, no Three.js. Step 5.
//
// The math that makes "real orbits" real (master plan Part 5.6, canonical-generation-
// pipeline.md §3.H, Constitution II.9): Kepler's equation solved by Newton–Raphson,
// eccentricity hard-capped at 0.8 (solver stability), and every time-driven angle
// computed in DOUBLE, reduced mod 2π, THEN handed to the render shell to cast to
// float (CLAUDE.md §4 — the precision trap). This file is canonical-adjacent: the
// seed→element DERIVATION (deriveOrbit) uses the pinned hash, but the position/velocity
// GEOMETRY is ordinary float64 trig (pipeline marks H as "angle in double, mod 2π,
// then float" + Kepler/NR — NOT integer-hashed). NO three.js import, ever (guardrail 1).
//
// The render shell (Step 5, /render) consumes these doubles, applies the floating
// origin, and only ever feeds small floats / unit directions to the GPU.
// ─────────────────────────────────────────────────────────────────────────────

import { pcg3d, toUnit } from './hash.ts';
import {
  EARTH_ORBIT_A_M, EARTH_ORBIT_E, EARTH_ORBIT_PERIOD_S,
  MOON_ORBIT_A_M, MOON_ORBIT_E, MOON_ORBIT_I_RAD, MOON_ORBIT_PERIOD_S,
} from './constants.ts';

const TAU = 2 * Math.PI;

/** Maximum eccentricity the solver accepts (Constitution II.9 / pipeline H). */
export const MAX_ECCENTRICITY = 0.8;

/**
 * Reduce an angle to [0, 2π) in DOUBLE — the precision step guardrail 3 requires
 * before any time-driven angle is cast to float. Without it, `spinRate · gameTime`
 * grows without bound over a session and float-casts to a stuttering value.
 */
export function reduceAngle(theta: number): number {
  const r = theta - TAU * Math.floor(theta / TAU);
  // floor() can leave r === TAU at the negative-side boundary (rounding); clamp it in.
  return r < TAU ? r : 0;
}

/**
 * Solve Kepler's equation M = E − e·sin(E) for the eccentric anomaly E, via
 * Newton–Raphson. Eccentricity is HARD-CAPPED at 0.8 on entry (solver stability —
 * NR can diverge near e→1). Seeded with E₀ = M + e·sin(M) (a good first guess) and
 * iterated to |f| < 1e-12 or a fixed cap. Pure + deterministic.
 */
export function solveKepler(M: number, e: number): number {
  const ecc = e < 0 ? 0 : e > MAX_ECCENTRICITY ? MAX_ECCENTRICITY : e;
  const m = reduceAngle(M);
  let E = m + ecc * Math.sin(m); // initial guess
  for (let it = 0; it < 12; it++) {
    const f = E - ecc * Math.sin(E) - m;
    const fp = 1 - ecc * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/**
 * Classical Keplerian orbital elements. Angles in radians; `a` in metres; `period`
 * in seconds. The slice hand-sets these to REAL Earth/Moon values (sliceEarthOrbit /
 * sliceMoonOrbit); deriveOrbit(seed) is the ring-1 seam (not used by the slice).
 */
export interface OrbitalElements {
  a: number; // semi-major axis (m)
  e: number; // eccentricity (0..0.8)
  i: number; // inclination (rad)
  Omega: number; // longitude of the ascending node (rad)
  omega: number; // argument of periapsis (rad)
  M0: number; // mean anomaly at epoch t=0 (rad)
  period: number; // orbital period (s)
}

/** Mean anomaly at time `t` (s): M(t) = M0 + 2π·t/period, reduced to [0,2π) in double. */
export function meanAnomaly(el: OrbitalElements, t: number): number {
  return reduceAngle(el.M0 + (TAU * t) / el.period);
}

// Perifocal (PQW) basis vectors P, Q for the element set's i/Ω/ω — the columns of
// Rz(Ω)·Rx(i)·Rz(ω) that rotate perifocal coords into the orbit's reference frame.
// Written into `out` as [Px,Py,Pz, Qx,Qy,Qz]. Reused by position + velocity.
function perifocalBasis(el: OrbitalElements, out: Float64Array): void {
  const cO = Math.cos(el.Omega), sO = Math.sin(el.Omega);
  const cw = Math.cos(el.omega), sw = Math.sin(el.omega);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  out[0] = cO * cw - sO * sw * ci; // Px
  out[1] = sO * cw + cO * sw * ci; // Py
  out[2] = sw * si; // Pz
  out[3] = -cO * sw - sO * cw * ci; // Qx
  out[4] = -sO * sw + cO * cw * ci; // Qy
  out[5] = cw * si; // Qz
}

const _pq = new Float64Array(6);

/**
 * Position at time `t` (s), in the orbit's reference frame, METRES (double). Writes
 * [x,y,z] into `out`. Solves Kepler, builds the perifocal point r·(cosE−e, √(1−e²)sinE),
 * and rotates it by the element basis. The render shell adds the parent body's position
 * (compose Moon→Earth→Sol) and the floating origin before anything reaches the GPU.
 */
export function orbitalPosition(el: OrbitalElements, t: number, out: Float64Array): void {
  const E = solveKepler(meanAnomaly(el, t), el.e);
  const e = el.e > MAX_ECCENTRICITY ? MAX_ECCENTRICITY : el.e;
  const xp = el.a * (Math.cos(E) - e);
  const yp = el.a * Math.sqrt(1 - e * e) * Math.sin(E);
  perifocalBasis(el, _pq);
  out[0] = xp * _pq[0]! + yp * _pq[3]!;
  out[1] = xp * _pq[1]! + yp * _pq[4]!;
  out[2] = xp * _pq[2]! + yp * _pq[5]!;
}

/**
 * Velocity at time `t` (s), m/s (double) — the analytic derivative of orbitalPosition
 * (NOT a finite difference), so the surface→orbit launch inherits a clean planet
 * velocity (master plan Part 4.3). Writes [vx,vy,vz] into `out`. Uses Ė = n/(1−e·cosE),
 * n = 2π/period (from dM/dt = n and M = E − e·sinE).
 */
export function orbitalVelocity(el: OrbitalElements, t: number, out: Float64Array): void {
  const E = solveKepler(meanAnomaly(el, t), el.e);
  const e = el.e > MAX_ECCENTRICITY ? MAX_ECCENTRICITY : el.e;
  const n = TAU / el.period;
  const Edot = n / (1 - e * Math.cos(E));
  const vxp = -el.a * Math.sin(E) * Edot;
  const vyp = el.a * Math.sqrt(1 - e * e) * Math.cos(E) * Edot;
  perifocalBasis(el, _pq);
  out[0] = vxp * _pq[0]! + vyp * _pq[3]!;
  out[1] = vxp * _pq[1]! + vyp * _pq[4]!;
  out[2] = vxp * _pq[2]! + vyp * _pq[5]!;
}

/**
 * Spin angle of a body at time `t` (s): reduceAngle(spinRate·t). `spinRate` is rad/s
 * (= 2π/sidereal-period). This is the function player.ts:spinAngle() is a stub for;
 * the render shell rotates the sun DIRECTION by −this about the tilted axis to produce
 * day/night from REAL spin (not a moving light). Double → mod 2π → (shell) float.
 */
export function spinAngle(spinRate: number, t: number): number {
  return reduceAngle(spinRate * t);
}

// ── Slice elements (hand-set REAL values — the prologue: real Earth, real Moon) ──

/** Earth's heliocentric orbit (ecliptic frame: i≈0). Hand-set real values (constants.ts). */
export function sliceEarthOrbit(): OrbitalElements {
  return {
    a: EARTH_ORBIT_A_M,
    e: EARTH_ORBIT_E,
    i: 0,
    Omega: 0,
    omega: 1.7964, // ~102.9° longitude of perihelion (real-ish), packed into ω since Ω=0
    M0: 0,
    period: EARTH_ORBIT_PERIOD_S,
  };
}

/**
 * The Moon's geocentric orbit. Ω/ω/M0 are phased so the Moon starts near the
 * Earth–Sol line (so an eclipse is reachable within a time-compressed session — the
 * §6 "real cast shadow" gate). Real a/e/i/period (constants.ts).
 */
export function sliceMoonOrbit(): OrbitalElements {
  return {
    a: MOON_ORBIT_A_M,
    e: MOON_ORBIT_E,
    i: MOON_ORBIT_I_RAD,
    Omega: 0,
    omega: 0,
    M0: 0,
    period: MOON_ORBIT_PERIOD_S,
  };
}

/**
 * RING-1 SEAM (not used by the slice): derive plausible orbital elements from a seed,
 * via the pinned hash, within Constitution II.9 ranges (a 0.3–40 AU, e 0–0.6, i 0–30°,
 * Ω/ω/M0 0–2π). The slice hand-sets real Earth/Moon instead (sliceEarthOrbit / …Moon);
 * this exists so the fact system slots in later with no redesign. Deterministic.
 */
export function deriveOrbit(seed: number, index: number, periodS: number): OrbitalElements {
  const [h0, h1, h2] = pcg3d(seed >>> 0, index >>> 0, 0x07b1); // "orbit" salt A
  const [h3, h4, h5] = pcg3d(seed >>> 0, index >>> 0, 0x0a17); // "orbit" salt B
  const AU = 1.495_978_707e11;
  return {
    a: (0.3 + toUnit(h0) * 39.7) * AU,
    e: toUnit(h1) * 0.6,
    i: toUnit(h2) * ((30 * Math.PI) / 180),
    Omega: toUnit(h3) * TAU,
    omega: toUnit(h4) * TAU,
    M0: toUnit(h5) * TAU,
    period: periodS,
  };
}
