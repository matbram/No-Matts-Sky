// ─────────────────────────────────────────────────────────────────────────────
// PlaceFacts — the fact record (seam, NOT yet derived).
//
// This schema matches lore-content-pack.md §1 *exactly* (same field names, same
// enum values). The slice HAND-SETS one planet's facts and uses only a few
// fields; ring 1 replaces the stub with the physical derivation in
// fact-generation-design.md §3 — with ZERO rework, because the schema is fixed
// now (slice spec §4, fact-gen §8 "the seam that makes this safe").
//
// Even in the slice: derive the planet's seed from a COORDINATE and key the
// facts by it, so the universe has a "home" from the first commit.
// ─────────────────────────────────────────────────────────────────────────────

import { planetSeed, type PlanetAddress } from './seedchain.ts';

export type Archetype =
  | 'frozen_ocean'
  | 'volcanic'
  | 'irradiated'
  | 'lush'
  | 'desert'
  | 'fungal'
  | 'crystalline'
  | 'oceanic'
  | 'barren'
  | 'toxic'
  | 'gas_shrouded'
  | 'exotic';

export type Temperature = 'frozen' | 'cold' | 'temperate' | 'hot' | 'scorching';
export type AtmosphereKind = 'none' | 'thin' | 'breathable' | 'toxic' | 'corrosive' | 'dense';
export type Terrain =
  | 'plateaus'
  | 'dunes'
  | 'caverns'
  | 'fjords'
  | 'flats'
  | 'spires'
  | 'archipelago'
  | 'canyons'
  | 'floating_isles'
  | 'basins';
export type Hazard =
  | 'none'
  | 'radiation'
  | 'acid_rain'
  | 'extreme_cold'
  | 'searing_heat'
  | 'storms'
  | 'quakes'
  | 'toxic_air';
export type Life = 'barren' | 'sparse' | 'hardy' | 'teeming' | 'hostile';
export type Landmark =
  | 'none'
  | 'great_arch'
  | 'glowing_lake'
  | 'crater_sea'
  | 'derelict_megastructure'
  | 'bone_fields'
  | 'singing_stones'
  | 'sky_river';
export type Resource = 'none' | 'rare_metal' | 'exotic_gas' | 'crystal' | 'biomatter' | 'isotopes';
export type StarClass =
  | 'red_dwarf'
  | 'orange'
  | 'yellow'
  | 'white'
  | 'blue'
  | 'red_giant'
  | 'white_dwarf'
  | 'neutron'
  | 'dead';
export type StarAge = 'young' | 'mature' | 'ancient' | 'dying' | 'dead';
export type FactionType =
  | 'none'
  | 'empire'
  | 'republic'
  | 'syndicate'
  | 'collective'
  | 'cult'
  | 'remnant';
export type FactionRelation =
  | 'unclaimed'
  | 'at_war'
  | 'allied'
  | 'trade_partners'
  | 'cold_standoff'
  | 'contested'
  | 'isolated';
export type HistoryEvent =
  | 'untouched'
  | 'plague'
  | 'war'
  | 'stellar_disaster'
  | 'exodus'
  | 'the_silence'
  | 'ascension';
export type FormerState =
  | 'uninhabited'
  | 'colony'
  | 'outpost'
  | 'capital'
  | 'shrine'
  | 'mining_hub'
  | 'research_station';
export type Traffic = 'untouched' | 'remote' | 'traveled' | 'busy_hub';

/** The full fact record consumed by terrain (density field) AND the lore pack. */
export interface PlaceFacts {
  // identity (strings; from the name generator in the real system)
  planet_name: string;
  system_name: string;
  region_name: string;
  faction_name: string;
  discoverer_name: string;

  // planet
  archetype: Archetype;
  temperature: Temperature;
  atmosphere: AtmosphereKind;
  terrain: Terrain;
  hazard: Hazard;
  life: Life;
  landmark: Landmark;
  resource: Resource;

  // system / star
  star_class: StarClass;
  star_age: StarAge;
  planet_count: number;

  // political (seamless-meaning, Frontier 2)
  faction_type: FactionType;
  faction_relation: FactionRelation;

  // history (generated facts)
  history_event: HistoryEvent;
  former_state: FormerState;

  // social / memory layer (optional)
  traffic: Traffic;
  discovery_year: number | null;
}

/**
 * The slice's single planet, keyed by a canonical coordinate. Values follow the
 * hand-set stub in vertical-slice-build-spec.md §4 (one archetype: barren). The
 * physical fields (archetype/temperature/atmosphere/terrain) are the only ones
 * the slice will eventually read for terrain; the rest are present-but-placeholder
 * so the schema is complete now.
 */
export const SLICE_PLANET_ADDRESS: PlanetAddress = { galaxy: 0, system: 0, planet: 0 };

export function sliceFacts(): { address: PlanetAddress; seed: number; facts: PlaceFacts } {
  const facts: PlaceFacts = {
    planet_name: 'Slice-1',
    system_name: 'Sol',
    region_name: 'Local',
    faction_name: '',
    discoverer_name: '',

    archetype: 'barren',
    temperature: 'cold',
    atmosphere: 'thin',
    terrain: 'plateaus',
    hazard: 'none',
    life: 'barren',
    landmark: 'none',
    resource: 'none',

    star_class: 'yellow',
    star_age: 'mature',
    planet_count: 1,

    faction_type: 'none',
    faction_relation: 'unclaimed',

    history_event: 'untouched',
    former_state: 'uninhabited',

    traffic: 'untouched',
    discovery_year: null,
  };
  return {
    address: SLICE_PLANET_ADDRESS,
    seed: planetSeed(SLICE_PLANET_ADDRESS),
    facts,
  };
}
