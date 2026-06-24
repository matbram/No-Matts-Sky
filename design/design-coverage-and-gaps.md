# Design Coverage Map & Gap Analysis

An honest audit of the whole design set, hunting for what's *missing* — not just confirming what's there. The short version is encouraging and pointed at the same time: **the universe-generation foundation is remarkably complete; the game-and-experience layer that lives inside it is largely undesigned; and the single biggest missing ingredient isn't a system at all — it's a decision.**

Legend: **✓ designed** (specified well enough to build) · **◐ named/partial** (referenced or sketched, not designed in our own terms) · **✗ not touched**.

---

## 1. The headline finding

We have spent this entire effort designing **how the universe comes to be** — generation, determinism, the causal web, the world-systems. That's the hard, novel, architecturally load-bearing part, and it is genuinely strong and near-complete. What we have **not** designed is most of **what the player actually does, sees, and wants** moment to moment — the game-design layer. You could build everything in the five documents and have a gorgeous, consistent, explorable **universe simulator**. Whether that's a *game*, and what kind, is the thing we haven't decided.

That's not a failure — it's the natural consequence of building world-first. But it's the most important gap to name, because it's upstream of a lot of work, and (as below) it's a *decision*, not just a missing document.

---

## 2. Coverage map

### A. Universe generation & world-systems — **strong (mostly ✓)**
| Item | Status | Note |
|---|---|---|
| Coordinate/frame architecture (frames, floating origin, handoffs) | ✓ | master plan P4 |
| Determinism engine (hashing, seed chain, integer discipline, store-nothing) | ✓ | P0/P5, Constitution II.14 |
| Noise / fBm / domain warp / density field / sphere noise | ✓ | P5, Constitution II.8 |
| Voxel pipeline (cube-sphere, quadtree LOD, Surface Nets/DC, streaming) | ✓ | P3/P5, slice spec |
| Orbits (Kepler, time compression) | ✓ | P5, Constitution II.9 |
| Atmosphere (Rayleigh/Mie LUT) | ✓ | P5 |
| Biomes / 12 archetypes / triplanar | ✓ | P2/P5, Constitution II.7 |
| Fact generation (why-things-are, the derivation web) | ✓ | fact-gen doc, Constitution II |
| Effective-laws / substances / life-kinds / rarity spectrum / origin-trace / lifecycles | ✓ | Constitution |
| Lore prose generation (template grammar) | ✓ | lore pack |
| Persistence / change-list / store-cause-not-result | ✓ | P6, Constitution |
| Discovery / star map / first-come | ✓ | P6 |
| Multiplayer (persistence + real-time presence) | ✓ | P6.6 |
| Name generation (planets, species, systems) | ◐ | relies on the source report's Markov approach; not designed in our terms |
| Resource *spatial distribution* on a surface (where the ore actually is) | ◐ | "resource" is a planet fact; placement undesigned |

### B. Rendering & visual — **partial (◐)**
| Item | Status | Note |
|---|---|---|
| Frame budget / 60fps strategy | ✓ | P8 |
| Terrain LOD + streaming visuals | ✓ | P5, slice spec |
| Seamless scale transition (galaxy map → standing on the ground) | ◐ | terrain LOD covers part; the full continuous zoom isn't designed as one experience |
| Lighting / shadows at scale (multiple stars, eclipses, ring shadows, GI) | ◐ | slice has day/night + one moon shadow |
| Water / ocean rendering & fluids at planet scale | ◐ | oceanic archetype + ocean-level exist; the water system doesn't |
| The sky from the surface (other planets, moons, the galaxy band, the night sky) | ◐ | implied, not designed |
| Art direction / visual identity | ◐ | "stylized-but-cohesive" stated; no actual direction |

### C. Persistence / multiplayer / infra — **strong (✓), one gap**
| Item | Status | Note |
|---|---|---|
| Memory layer / change-list / ordered log / digestion | ✓ | P6, Constitution |
| Real-time presence (the "during") | ✓ | P6.6 |
| Anti-cheat via recompute | ✓ | P6.3 |
| Accounts / auth / save-sync / live-ops | ◐ | "Supabase + relay" named; not designed |

### D. Generation subsystems named but not designed — **(◐ / ✗)**
| Item | Status | Note |
|---|---|---|
| Creatures (morphology, generation, behavior, animation/IK) | ◐ | life-*kind* is in the Constitution; the actual creature *builder* is only referenced (blueprint+bone+IK from the source report) |
| Flora / plants (L-systems) | ◐ | named, not designed |
| Ecosystems (food webs, populations, behavior) | ◐ | Frontier 1 names the equilibrium approach; the actual ecology isn't designed |
| Weather / dynamic climate | ◐ | "live-small simulation" names it |
| Caves / underground as explorable *places* (not just geometry) | ◐ | density field supports caves; underground as content is undesigned |
| **Audio — procedural music & soundscapes & spatial audio** | ✗ | **entirely untouched, and not on any ring.** Iconic for an infinite universe (NMS's procedural music). A real generation system. |

### E. The experience / game layer — **the big gap (mostly ✗)**
| Item | Status | Note |
|---|---|---|
| **The core loop & verbs** — what the player *does* second to second | ✗ | mine? scan? build? fly? fight? trade? survive? We have *themes* (explore, excavate) but no verb design |
| Threat / combat / active danger | ✗ | hazards are *environmental*; active threat (hostile life, a sentinel-equivalent, enemy factions) is undesigned — and a genuine decision |
| Progression / motivation / goals — *why keep playing* | ◐ | Constitution II.13 hints at knowledge-as-progression; the overall drive isn't designed |
| Survival mechanics (life support, hazard protection) | ✗ | hazards imply it; undecided whether this is a survival game |
| Building / bases as a system | ✗ | change-list supports placed structures; base-building as a *system* isn't designed |
| Economy / crafting / trade | ✗ | on the build order's "game ring"; not designed |
| Factions as live gameplay (agents, territory, reactions to the player) | ✗ | faction *facts* exist; factions as *actors* don't |

### F. Player-facing systems — **(mostly ✗)**
| Item | Status | Note |
|---|---|---|
| Ship(s) & the travel experience (in-system flight, FTL/warp between stars & galaxies) | ◐ | the *frame math* is designed; the player-facing travel system, ships, fuel, etc. isn't |
| UI / HUD / how the player *perceives* all this (scanner, maps, inventory) | ✗ | nothing designed |
| The **excavation interface** — how Principle 4 ("learn the rules of a world") is actually surfaced to the player | ✗ | the principle is defined; the *experience* of doing it isn't |
| Onboarding / where & how a new player enters the universe | ✗ | undesigned |

### G. Production / meta — **(✗, lower priority)**
| Item | Status | Note |
|---|---|---|
| Content-authoring pipeline (building the archetype library, wonder set-pieces, substance/life tables) | ◐ | only the offline-AI-authoring trick for lore |
| Testing beyond the conformance/golden test | ◐ | conformance test is specified; broader QA isn't |
| Modding / extensibility | ✗ | likely out of scope for now |

---

## 3. The deepest finding: the missing ingredient was a *decision* — now made

Section E was blank because **we hadn't decided what kind of experience this is**, and you can't design the verbs, the threat model, the progression, or the UI until you do. This was the same shape as the other foundational forks (web-vs-native, the spine): a single upstream decision that determines what everything downstream needs to be.

**RESOLVED — it's all of the above, grounded in reality.** The decision: a **real-scale, real-physics, real-data** space exploration game that starts on the real Earth in our real solar system and goes outward, in first and third person, with the **full suite** — survival, crafting, a tech tree, reverse-engineering, diplomacy, combat, theft — all organized around one spine: **explore → understand/reverse-engineer → improve tech → reach further.** It opens with an **alien crash** (the onboarding, and the diegetic source of the one fictional concession, **FTL**). Progression couples to the strangeness spectrum: you start at the most grounded point (Earth) and your growing tech carries you into the increasingly exotic and ancient.

The original three options weren't a choice between — they're all *in*, sequenced: the contemplative-explorer loop (scan/understand/witness) is the early and ever-present core; survival/crafting is the stakes and growth layer; active conflict (combat/diplomacy/theft) attaches at the late rings. The full design is the **Gameplay & Progression doc**; the experience-layer blanks in section E–F (verbs, threat, progression, the excavation interface, ships/travel, onboarding) are filled there, and **audio** is added as a core system.

---

## 4. What to design next (prioritized)

**Decide first (it's upstream of everything in sections E–F):**
1. **The experience fork** (§3) — what kind of game lives in this universe, and the blend/weighting.

**Design soon, once the fork is decided:**
2. The **core loop & verbs** (what you do second to second).
3. **UI / perception** — especially the **excavation interface** (how Principle 4 is actually played; without it, the whole "learn the rules of a world" pillar has no surface).
4. The **player-facing travel & ship system** (the experience of flying and warping, not just the frame math).
5. **Onboarding** (the first ten minutes).
6. **Audio** — add it to the plan as a real system (procedural music + per-biome soundscapes + spatial audio); it's currently on *no* ring.

**Design at their ring (already on the build order, just not detailed yet):**
7. Creatures, flora, ecosystems (the "life ring").
8. Economy, crafting, factions-as-gameplay, building/bases (the "game ring").
9. Weather, water/fluids, caves-as-places, scale-transition visuals, lighting-at-scale (planet-quality & later rings).
10. Name generation and resource spatial distribution (small, fold into ring 1).

**Likely out of scope for now:** modding, detailed live-ops/infra beyond the Supabase + relay sketch.

---

## 5. What this does *not* change

The **vertical slice and ring 1 are unaffected** — they're pure world-generation and are fully specified; you can start building Step 0 today regardless of the experience fork. The fork mainly shapes how the player controller and UI grow *after* the slice (toward survival, or toward a scanner/observation focus, or toward combat). So this gap analysis is a reason to have one more design conversation — **not** a reason to delay building the engine.

---

## 6. Bottom line

**Ingredients for the *universe*: essentially all there.** The recipe is written, the laws are set, the kitchen is built, and it's a genuinely ambitious and coherent design.

**Ingredients for the *game* inside the universe: mostly still on the shelf** — because we haven't decided what meal we're cooking for the player. Plus one clear omission (audio) that belongs on the build plan, and a handful of generation subsystems (creatures, flora, ecosystems) that are named and waiting for their ring.

Nothing here is a crack in the foundation. It's the map of the territory still to design — and it says the next step isn't more architecture, it's a creative decision about what it *feels like* to actually play in the universe we've built.
