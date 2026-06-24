// Real-scale body radii, in METERS (slice spec §5 / CLAUDE.md §4 — use REAL values).
// "Real scale costs nothing extra to render — streaming only ever builds what's
// near you" (slice spec §5). Doubles give sub-millimeter precision across the
// solar system; render precision is handled by the floating origin (Step 4).
export const EARTH_RADIUS_M = 6_371_000;
export const MOON_RADIUS_M = 1_737_000;
export const MARS_RADIUS_M = 3_390_000;
