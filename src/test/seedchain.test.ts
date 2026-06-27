import { describe, it, expect } from 'vitest';
import {
  MASTER_SEED,
  SALT,
  childSeed,
  planetSeed,
  type PlanetAddress,
} from '../core/seedchain.ts';
import { sliceFacts } from '../core/facts.ts';

// Golden / determinism test for the seed chain — the [S] STRUCTURAL root of the
// whole universe's identity (canonical-generation-pipeline.md §2). The pinned PCG
// (hash.test.ts) freezes the wire; THIS freezes the COMPOSITION layer on top of it:
// MASTER_SEED, the SALT set, the childSeed fold, and planetSeed. A change to any of
// those would silently regenerate a different planet at runtime (scene.ts derives
// terrain via childSeed(sliceFacts().seed, 0, SALT.terrain)) while every existing
// test — which pins the PCG primitives or an unrelated literal seed — still passed.
// These recorded values are FROZEN: re-bless only on a deliberate, documented change.

const U32_MAX = 0xffffffff;
const isU32 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= U32_MAX;

describe('seed chain — structural constants (FROZEN)', () => {
  it('MASTER_SEED is the pinned universe identity', () => {
    expect(MASTER_SEED).toBe(0x9e3779b1);
  });

  it('the SALT set is the exact frozen map (add purposes, never renumber)', () => {
    expect(SALT).toEqual({
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
    });
  });
});

describe('childSeed — u32 discipline + determinism', () => {
  it('returns a u32 across a sweep and is a pure function', () => {
    for (let i = 0; i < 1000; i++) {
      const s = childSeed(MASTER_SEED, i, SALT.terrain);
      expect(isU32(s)).toBe(true);
      expect(childSeed(MASTER_SEED, i, SALT.terrain)).toBe(s); // pure
    }
  });

  it('distinct (parent,index,salt) avalanche to distinct seeds', () => {
    expect(childSeed(MASTER_SEED, 0, SALT.terrain)).not.toBe(
      childSeed(MASTER_SEED, 0, SALT.biome),
    );
    expect(childSeed(MASTER_SEED, 0, SALT.terrain)).not.toBe(
      childSeed(MASTER_SEED, 1, SALT.terrain),
    );
  });
});

describe('seed chain — recorded golden values (FROZEN)', () => {
  it('childSeed of fixed triples (incl. the production terrain seed)', () => {
    expect({
      master_terrain: childSeed(MASTER_SEED, 0, SALT.terrain),
      master_planet1: childSeed(MASTER_SEED, 1, SALT.planet),
      // The EXACT derivation the running game uses for the slice planet's terrain
      // (scene.ts:248). Anchors the live planet's identity, not just the primitives.
      slice_terrain: childSeed(sliceFacts().seed, 0, SALT.terrain),
      arbitrary: childSeed(12345, 7, SALT.faction),
    }).toMatchInlineSnapshot(`
      {
        "arbitrary": 3467829530,
        "master_planet1": 4288536149,
        "master_terrain": 2077825834,
        "slice_terrain": 3495948690,
      }
    `);
  });

  it('planetSeed over an address matrix', () => {
    const addrs: PlanetAddress[] = [
      { galaxy: 0, system: 0, planet: 0 },
      { galaxy: 1, system: 0, planet: 0 },
      { galaxy: 0, system: 1, planet: 0 },
      { galaxy: 0, system: 0, planet: 1 },
      { galaxy: 3, system: 7, planet: 11 },
    ];
    expect(addrs.map(planetSeed)).toMatchInlineSnapshot(`
      [
        2482220677,
        828623488,
        3158190921,
        3805405524,
        3525043058,
      ]
    `);
  });
});
