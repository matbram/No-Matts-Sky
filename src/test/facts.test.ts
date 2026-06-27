import { describe, it, expect } from 'vitest';
import { sliceFacts, SLICE_PLANET_ADDRESS, type PlaceFacts } from '../core/facts.ts';
import { planetSeed } from '../core/seedchain.ts';

// Determinism / schema test for the hand-set fact stub. facts.ts is the SEAM the
// design says must not move (slice-spec §4, fact-generation-design §8, lore-content-
// pack §1): the real fact-derivation layer slots in later with ZERO rework only if
// the schema field names/enums and the coordinate->seed key stay fixed. This freezes
// both: the coordinate-derived seed, the full record, and the four physical fields
// the terrain will eventually read. Re-bless only on a deliberate schema change.

describe('sliceFacts — the coordinate-keyed seam', () => {
  it('seed is derived from the planet COORDINATE (planetSeed of the slice address)', () => {
    expect(sliceFacts().seed).toBe(planetSeed(SLICE_PLANET_ADDRESS));
  });

  it('is keyed by the canonical slice address {0,0,0}', () => {
    expect(SLICE_PLANET_ADDRESS).toEqual({ galaxy: 0, system: 0, planet: 0 });
    expect(sliceFacts().address).toEqual(SLICE_PLANET_ADDRESS);
  });

  it('pins the slice-spec §4 hand-set physical fields (one barren planet)', () => {
    const f = sliceFacts().facts;
    expect(f.archetype).toBe('barren');
    expect(f.temperature).toBe('cold');
    expect(f.atmosphere).toBe('thin');
    expect(f.terrain).toBe('plateaus');
  });
});

describe('sliceFacts — frozen record (FROZEN)', () => {
  it('the full PlaceFacts stub + seed match the recorded golden', () => {
    const { seed, facts } = sliceFacts();
    // The whole record is frozen so any field rename / enum drift / value change in
    // the stub trips the build (it would otherwise silently break the lore-pack seam).
    const record: { seed: number; facts: PlaceFacts } = { seed, facts };
    expect(record).toMatchInlineSnapshot(`
      {
        "facts": {
          "archetype": "barren",
          "atmosphere": "thin",
          "discoverer_name": "",
          "discovery_year": null,
          "faction_name": "",
          "faction_relation": "unclaimed",
          "faction_type": "none",
          "former_state": "uninhabited",
          "hazard": "none",
          "history_event": "untouched",
          "landmark": "none",
          "life": "barren",
          "planet_count": 1,
          "planet_name": "Slice-1",
          "region_name": "Local",
          "resource": "none",
          "star_age": "mature",
          "star_class": "yellow",
          "system_name": "Sol",
          "temperature": "cold",
          "terrain": "plateaus",
          "traffic": "untouched",
        },
        "seed": 2482220677,
      }
    `);
  });
});
