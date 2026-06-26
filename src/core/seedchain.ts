// ─────────────────────────────────────────────────────────────────────────────
// The seed chain (canonical-generation-pipeline.md §2) — [S] STRUCTURAL.
//
// The universe is addressed hierarchically; each level derives its seed from its
// parent + a local index + a per-purpose salt. Any worker can compute any node
// independently and identically because it's all pure hashing (no shared state).
//
// The slice doesn't derive facts yet (they're hand-set, see facts.ts), but the
// seam is established now so the real fact system slots in with zero rework
// (CLAUDE.md §4 "Derive the planet's seed from a coordinate"; master plan Part 9
// "bake in the seams even now").
// ─────────────────────────────────────────────────────────────────────────────

import { pcg3d } from './hash.ts';

/** The universe's identity. Pick once, freeze. (pipeline §2) [S] */
export const MASTER_SEED = 0x9e3779b1;

/** Per-purpose salts. The SET is [S] frozen; add new purposes, never renumber. */
export const SALT = {
  laws: 1,
  star: 2,
  planet: 3,
  terrain: 4,
  biome: 5,
  atmosphere: 6,
  life: 7,
  hazard: 8,
  resource: 9,
  landmark: 10,
  history: 11,
  faction: 12,
} as const;

export type Salt = (typeof SALT)[keyof typeof SALT];

/** Derive a child seed from a parent seed + a local index + a purpose salt. */
export const childSeed = (parent: number, index: number, salt: number): number =>
  pcg3d(parent >>> 0, index >>> 0, salt >>> 0)[0];

/**
 * A canonical universe address. For the slice we only ever instantiate one
 * planet, but everything is keyed by this so persistence/facts have a "home"
 * from the first commit (slice spec §4).
 */
export interface PlanetAddress {
  galaxy: number;
  system: number;
  planet: number;
}

/**
 * Fold a hierarchical address into a single planet seed by chaining childSeed
 * through galaxy → system → planet. Pure and reproducible.
 *
 * SALT CONVENTION ([S] — frozen by seedchain.test.ts): the ADDRESS-descent steps
 * (galaxy, system) use salt `0` deliberately — it is the reserved "structural
 * address-fold" salt, distinct from the per-PURPOSE salts in `SALT` (which start at
 * 1). Only the final, purpose-bearing step (planet facts) uses a named salt
 * (`SALT.planet`). The canonical `region` level (pipeline §2: galaxy→region→system)
 * is deliberately DEFERRED for the slice (one planet at {0,0,0}); when region facts
 * arrive the chain will gain a region step and re-bless this golden. Do not change
 * the salt values or fold order without re-blessing seedchain.test.ts — it would
 * silently regenerate every planet.
 */
export function planetSeed(addr: PlanetAddress): number {
  let s = MASTER_SEED;
  s = childSeed(s, addr.galaxy, 0); // structural address-fold salt (0), not a purpose salt
  s = childSeed(s, addr.system, 0);
  s = childSeed(s, addr.planet, SALT.planet);
  return s >>> 0;
}
