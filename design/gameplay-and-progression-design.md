# Gameplay & Progression Design

This is the document that fills the experience layer the coverage map flagged as missing. The master plan and Constitution define the *universe*; this defines the *game you play inside it*. It sits beneath the Constitution (the authority on what the universe is) and alongside the master plan (how it's built).

It resolves the experience fork from the gap analysis with the most ambitious option: **all of the above, grounded in reality.**

---

## 0. What this game is (the experience, resolved)

**"If we had the technology for space travel and decided to take off and explore today."** A real-scale, real-physics space exploration game that starts on the real Earth, in our real solar system, and goes outward — mapping the universe in first and third person, surviving, crafting, building new technology from what you discover, meeting (or fighting, or robbing) other civilizations, and pushing ever further into the unknown.

The defining commitments:
- **Real scale** — real-size planets you can genuinely cross, a real-size solar system, real distances.
- **Real local physics** — day/night because the planet *actually rotates*; the solar system running on real orbital mechanics; Newtonian flight in-system.
- **Real data where it exists** — you begin at the single most real point in the universe: actual Earth.
- **First and third person**, on foot and in-ship.
- **The full gameplay suite** — survival, crafting, tech progression, reverse-engineering, diplomacy, combat, theft.
- **Exactly one fictional concession: faster-than-light travel** — and even that is *earned in-fiction*, not handed to you (§1).

Everything below organizes that suite around a single spine, so it's one coherent game rather than a pile of features.

---

## 1. The opening: the alien crash (onboarding + the engine of everything)

The game opens with an **alien craft crashing to Earth.** You recover its technology, reverse-engineer it, and from it build humanity's first ship capable of crossing interstellar space quickly. That single event does four jobs at once:

- **It's the onboarding** — the "first ten minutes" the coverage map flagged as blank. The crash, the recovery, the first reverse-engineering, the first flight: that's your tutorial, diegetically.
- **It earns the one concession.** FTL is the only un-real thing in the universe (§5). The crash makes it *something humanity worked for by studying alien tech*, not a physics cheat. The genre's universal move (keep everything real, make one acknowledged FTL concession — The Expanse's gates, etc.), made **diegetic**: earned in the story, not just assumed.
- **It seeds the core loop.** Reverse-engineering found technology to extend your reach is the engine of the whole game (§2).
- **It sets the arc.** You start as a newly-spacefaring species with one salvaged ship, and grow from there.

**Architectural note:** the crash and the prologue are **authored content — identical for every player** — and live in the *authored layer*, not the generation layer. The universe you then explore stays procedurally generated. (Per the Constitution: your *tech* is personal — Memory layer; your *discoveries* are shareable; the prologue is fixed for everyone.) Nothing about the crash breaks the deterministic, store-nothing model — it's a hand-built front porch on a generated house.

---

## 2. The core loop (the spine that ties the suite together)

> **explore → discover → understand & reverse-engineer → improve tech → reach further → encounter stranger things → repeat.**

The keystone is that **technology gates reach** — how far you can travel, how fast, and which worlds you can survive. So:

- Exploration isn't sightseeing; it *fuels capability* (you find materials, knowledge, and alien tech).
- Capability unlocks *more* exploration (further jumps, harsher worlds).
- The loop compounds: each lap takes you further out, and further out is stranger.

This produces the most elegant property of the whole design (§12): **your progression *is* the journey from the familiar to the unknown.** You begin on Earth (the most grounded point that exists) and your growing tech carries you outward into the increasingly procedural, the increasingly exotic, and eventually the mythic and ancient. Progression and the Constitution's grounded→exotic→mythic spectrum are the *same axis*.

---

## 3. The verbs (what you do, moment to moment)

The coverage map's biggest blank. Here is what the player actually does:

- **Fly** — Newtonian flight in-system (real thrust, gravity, orbits; time-compressible but real in feel), and the **FTL jump** between stars/galaxies (§5).
- **Land, launch, walk** — the surface↔orbit handoff (master plan Part 4), on foot in first or third person.
- **Scan / observe / measure** — perceive a world and begin to understand it (the start of §11's "understand").
- **Understand / excavate** — infer a world's laws and history by observation and experiment, bank that knowledge, and use it (this is how the Constitution's Principle 4 is *played* — §11).
- **Harvest / mine** — extract materials from what you discover.
- **Craft** — turn materials + knowledge into tools, gear, and technology.
- **Build** — place structures and bases (via the Memory layer / change-list).
- **Reverse-engineer** — turn recovered alien tech into new human tech (the spine's engine).
- **Negotiate** — meet civilizations; trade, gift, ally (§6).
- **Fight** — survive hostile life, environments, and enemies (§6, §8).
- **Steal** — take technology from hostiles (§6).

---

## 4. Technology & progression (the tech tree)

Growth is measured in **capability**, above all **reach** (how far/fast you travel) and **survivability** (which worlds you can endure). The tech tree gates: travel range and speed, hazard protection (→ which worlds you can visit), tools (scanning, harvesting, building), and ships.

**Four sources of technology** (this is also why every gameplay system matters — they're all *tech sources*):
1. **Your own R&D from discovery** — study a world's materials, chemistry, and laws → new knowledge → new tech. (Understanding is required: you can't exploit what you haven't understood — ties to Constitution II.13.)
2. **Reverse-engineering alien tech** — recovered wrecks (starting with the crash), derelicts, abandoned sites.
3. **Diplomacy** — trade, gifts, and alliances with friendly civilizations (§6).
4. **Theft** — taking tech from hostiles (§6).

**Knowledge-as-progression:** understanding itself is advancement. A world's laws, a species' biology, an alien device's principles — each understood thing both unlocks tech *and* is its own reward (Principle 4's comprehension loop). The deepest progression isn't a bigger gun; it's understanding more of the universe.

---

## 5. Ships & the travel experience (player-facing)

The master plan (Part 4) has the *frame math*; this is the *experience*.

- **In-system:** real Newtonian flight — thrust, momentum, gravity wells, orbits — time-compressible so a trip to Mars is playable, but real in scale and feel. (You can also fly down to a surface and walk; the handoff is Part 4.)
- **Interstellar — the FTL jump (the one concession):** a jump drive with **fuel, charge-up, and range limits**, so crossing to another star is a real *activity* with a real sense of distance crossed — never a menu teleport. **Range is tech-gated:** early drives make short hops to the nearest real stars; later drives reach far, and eventually across galaxies. This is the only un-real thing in the universe, and it's earned (§1).
- **Ships & upgrades** come from the tech tree (§4): better drives (range/speed), better life support (survivability), better tools.

This keeps travel *substantial and real-feeling* — Newtonian everywhere, one earned exception for the interstellar leap that the entire game would be impossible without.

---

## 6. Civilizations: diplomacy, combat, theft

Alien civilizations are the **fact layer's factions and life-kinds, made interactive.** A civilization's nature (friendly/hostile, its character, its tech level) is derived from the same generation that builds everything else (Constitution II.5–II.7, II.13).

- **First contact** — meeting a civilization; reading whether they're friendly or hostile (from faction facts/relations).
- **Friendly** → trade, gifts, alliances → technology, knowledge, safe passage, shared maps.
- **Hostile** → combat and threat → survival stakes, and the option to **steal** their technology.

**Sequencing honesty:** per the Constitution and the build order, the *political/relational* layer (factions as live actors, diplomacy, territory) is among the **last** things built — the grounded floor and the solo exploration loop come first. This section defines where it fits in the spine; it is deliberately a late ring (§13).

---

## 7. The real-Earth start & the real-data anchor (player-facing)

You begin on **real-geography Earth**, in our **real solar system**, and travel outward.

- **Real skeleton, procedural flesh** (Constitution II.15): real data is *loaded* where it exists (Earth/Moon/Mars elevation; real building footprints and roads; real orbital elements; ~1.8 billion real stars from Gaia); detail *below* the data's resolution is *generated*; and the far universe we have no data for is *generated to match the statistics we do know*. This mirrors real astronomy: the near is known precisely, the far is inferred.
- **Cities** are loaded as **real geometry** (footprints → raised and textured procedurally), left as *places*; **population and politics are deferred** to a later time (simulating 8 billion real people and real geopolitics is a separate, enormous thing you don't need now).
- This makes Earth the **most grounded point in the universe** — the anchor of the strangeness spectrum, the place every journey starts and against which all the later weirdness lands.

---

## 8. Survival & crafting

- **Survival** — life support, temperature, hazard protection. What you can *endure* is tech-gated, which is what makes a hostile world genuinely dangerous and the "fear of the unknown" real: the next world might kill you, and you need the right tech to set foot on it.
- **Crafting** — turn discovered materials + understood knowledge into gear, tools, and technology (§4). Crafting recipes come from understanding (§11), not from a fixed list handed to you.

Survival is the *stakes* layer; without it, exploration has no danger and the cosmic fear is only scenery.

---

## 9. First & third person

A camera-and-character-rig decision with **no architectural difficulty** — it doesn't touch the generation, frames, or determinism. It adds **animation and rig work** (a visible avatar, third-person camera collision, on-foot and in-ship views). Noted as in-scope; it's an art/animation cost, not an engineering risk.

---

## 10. Audio (a core system — finally on the plan)

The coverage map's clean omission. For an infinite, real-scale universe, audio is a real generation system, not an afterthought:
- **Procedural music** — a generative, mood-driven score (in the spirit of NMS's generative soundtrack) that responds to situation: wonder, dread, calm, discovery, danger.
- **Per-archetype / per-biome soundscapes** — the ambient sound of a place, derived from its facts (a howling frozen waste vs. a teeming jungle vs. the dead silence of an airless rock — note: real vacuum is silent, which is its own powerful tool).
- **Spatial audio** — positional sound for ships, creatures, weather, machinery.

Determinism note: soundscape *selection* can derive from facts (so a place sounds consistent); the *performance* is cosmetic and need not be bit-identical across clients (same canonical-vs-cosmetic split as visuals — Constitution II.3 / master plan Part 0).

---

## 11. The creation model, as played ("derive what the laws would produce")

Confirmed model (Constitution II.15): the things you find — creatures, materials, formations, devices — are **what the universe's laws *would produce*, derived on demand with a real reason** — not hand-placed, and not literally evolved-forward-in-time. Three cases, as the player meets them:

- **Things already there that we don't know** — fully real and derivable; you discover and understand them (the floating head and its extinct makers — Constitution Principle 8 + II.12). *Fully delivered.*
- **Things the laws would *form*** (non-living: geology, chemistry, structures) — real science in the rules means the laws genuinely *create* things no one specifically designed, and the space is vast enough to surprise even us. *Delivered.*
- **Things that would *evolve*** (life) — a creature is *derived to be what evolution under this world's gravity, chemistry, and climate would plausibly arrive at*, so every trait has a derivable reason (cold → insulation; thick air → flight; this chemistry → this body material). *Delivered.* **The honest ceiling:** literal open-ended evolution — a process *run forward* that keeps inventing genuinely new *kinds* of complexity the rules never anticipated — is both the "simulation that must run from the beginning" wall and a famous unsolved research problem (see Constitution Part III). We deliver the achievable version (derive the *outcome*, don't *run the process*) and make the generative space deep enough that it *feels* limitless — because to any human who plays, it is.

For the player, this is what makes **understanding and reverse-engineering possible at all**: everything has derivable rules, so everything can, in principle, be figured out (Principle 4).

---

## 12. How progression couples to the strangeness spectrum (the elegant core)

The tech spine (§2) and the Constitution's rarity spectrum are one axis. Roughly:

| Tech stage | Reach | What you encounter |
|---|---|---|
| Prologue | Earth + the crash | Real Earth — the most grounded point |
| Early | The rest of Sol (Moon, Mars…) | Real, grounded solar-system bodies |
| Mid | Nearby real stars (Gaia) | Real-anchored, mostly grounded systems |
| Late | The procedural frontier | Exotic worlds, place-varying laws, first alien civilizations |
| Endgame | The far / old / deep | The mythic, the ancient, the strongest origin-trace |

So **getting better at the game = traveling from the known into the unknown.** The fear and wonder *grow* as you progress, because your reach takes you somewhere stranger each time. That coupling is the soul of the experience, and it falls straight out of "tech gates reach."

---

## 13. Build order for the gameplay (sequencing the suite)

The gameplay grows onto the world-generation core in the master plan's rings. In order:

1. **The prologue = the vertical slice (with a story frame).** Crash → recover tech → build one ship → fly from real-scale Earth to the real-scale Moon, at 60fps, with one craftable thing. This is FIRST, and it already contains the whole vision in miniature.
2. **In-system real flight + real Sol** (Moon, Mars on real orbits) + **basic scan / harvest / craft** + survival basics.
3. **FTL + the nearest real stars + the start of the procedural frontier** (the strangeness begins).
4. **Tech-tree depth, survival depth, building/bases.**
5. **(Late) Civilizations: first contact, diplomacy, combat, theft** (the political/relational ring).
6. **(Latest) The exotic/mythic far, the deep causal web, the origin-trace.**
7. **Audio** threads through from early (soundscapes in the slice) to rich (generative score) as you go.

This is the same sequence as the master plan's build order; the only change is that the slice is now framed as the prologue and uses real scale.

---

## 14. The honest scope note (stated once, then retired)

This is, candidly, among the most ambitious games anyone has conceived — a real solar system *plus* a procedural universe *plus* survival, crafting, tech, diplomacy, and combat. The reason that's not delusional: **capability isn't the constraint — sequence is**, and the crash hands you a perfectly-scoped first version for free. Your slice *is* the prologue. Everything else is a ring grown onto a proven core. Build the smallest real version first; grow outward. (This is the same discipline that's been at the center of the plan all along — it just matters more the bigger the vision gets.)

---

## 15. How this connects to the other documents

- **Coverage map:** this resolves the experience fork and fills sections E–F (the verbs, threat/combat, progression, UI-via-the-excavation-experience, ships/travel, onboarding) and adds **audio**.
- **Master plan Part 4:** §5 (ships/travel) is the player-facing layer of the frame math; the FTL jump is the system↔system handoff made into an earned mechanic.
- **Fact Generation Design:** §6 (civilizations) is the faction/life-kind facts made interactive; §11 (creation) is the derive-don't-enact model.
- **Constitution:** the FTL concession, the real-data anchor, the crash-as-authored-prologue, the two origins (your Earth start vs. the cosmic beginning), and the creation model with its evolution-ceiling all live in the Constitution (II.15, Principle 5, Part III) as the authority; this doc is how they're *played*.
- **Vertical Slice Build Spec:** the slice is now the prologue at real scale (Earth/Moon/Mars).
