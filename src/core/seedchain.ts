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
 */
export function planetSeed(addr: PlanetAddress): number {
  let s = MASTER_SEED;
  s = childSeed(s, addr.galaxy, 0);
  s = childSeed(s, addr.system, 0);
  s = childSeed(s, addr.planet, SALT.planet);
  return s >>> 0;
}
