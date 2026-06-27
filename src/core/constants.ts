// Real-scale body radii, in METERS (slice spec §5 / CLAUDE.md §4 — use REAL values).
// "Real scale costs nothing extra to render — streaming only ever builds what's
// near you" (slice spec §5). Doubles give sub-millimeter precision across the
// solar system; render precision is handled by the floating origin (Step 4).
export const EARTH_RADIUS_M = 6_371_000;
export const MOON_RADIUS_M = 1_737_000;
export const MARS_RADIUS_M = 3_390_000;

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — real orbital + spin constants (slice spec §5/§6, master plan Part 5.6).
// All REAL-scale (CLAUDE.md §4 "real orbital elements"). The slice is the prologue:
// real Earth orbits real Sol, real Moon orbits Earth. These are raw scalars; the
// OrbitalElements records are assembled in core/orbits.ts (sliceEarthOrbit / sliceMoonOrbit).
// ─────────────────────────────────────────────────────────────────────────────

/** Astronomical unit (m) and Sol's radius (m). */
export const AU_M = 1.495_978_707e11;
export const SUN_RADIUS_M = 6.957e8;

/** Standard gravitational parameters GM (m³/s²) — Sol and Earth (for the Moon's orbit). */
export const GM_SUN = 1.327_124_400_18e20;
export const GM_EARTH = 3.986_004_418e14;

/** Earth spin: sidereal rotation period (s) and axial tilt / obliquity (rad). */
export const EARTH_SIDEREAL_DAY_S = 86_164.0905;
export const EARTH_AXIAL_TILT_RAD = (23.439_281 * Math.PI) / 180;

/** Earth's heliocentric orbit (ecliptic frame → inclination ≈ 0). a in m, period in s. */
export const EARTH_ORBIT_A_M = AU_M;
export const EARTH_ORBIT_E = 0.016_708_6;
export const EARTH_ORBIT_PERIOD_S = 365.256_363 * 86_400; // sidereal year ≈ 3.1558e7 s

/** The Moon's geocentric orbit. Inclination is rel. to the ecliptic (~5.145°). */
export const MOON_ORBIT_A_M = 3.843_99e8;
export const MOON_ORBIT_E = 0.0549;
export const MOON_ORBIT_I_RAD = (5.145 * Math.PI) / 180;
export const MOON_ORBIT_PERIOD_S = 27.321_661 * 86_400; // sidereal month ≈ 2.3606e6 s

/**
 * Base time-compression [T] (slice spec §5: "a day in ~4 min, an orbit in ~30–60 min").
 * ONE physical multiplier on game-time so spin/orbit/eclipse stay consistent — a sidereal
 * day (86164 s) at ×360 is ~4 min; the year then auto-runs at the real period ratio.
 * The render shell can override it (e.g. a ?timescale flag). Render-only — not canonical.
 */
export const TIME_COMPRESSION = 360;
