# The Universe Constitution

This is the foundational document of the project. The master plan says *how to build*; this says *what the universe fundamentally is* — the law everything else serves. It sits at the top of the document set, above the plan.

It does two jobs. First, it states the **founding principles** — the small set of non-negotiable laws the whole universe is shaped to obey (Part I). Second, it is the **statute book** — every governing dial in one place, with a concrete starting value and range, each flagged *structural* (a real decision) or *tunable* (a starting point to dial in by building), so that for the first time there is a single sheet where the foundation actually lives, and a complete checklist of everything that needs a value before this universe exists (Part II).

A note on the origin layer: the founding principles include a single origin outside the system from which everything proceeds. This reflects the project's foundational stance — that the universe is *authored*, not accidental. The Constitution encodes the **design structure** that follows from it (a source outside the system, traced toward but never reached); it does not argue the metaphysics, it builds to it.

---

## PART I — The Founding Principles (the spine)

These are the articles of the constitution. They are all **structural** — everything in Part II exists to serve them. The whole of them is one sentence, stated first, then unpacked:

> **A coordinate yields a history, read at a moment in time. Every effect has a derivable cause; every cause is itself an effect somewhere else, with its own timeline. The whole web is knowable, to any depth, on demand — and the deeper and older you go, the more every thread leans toward a single origin that the universe everywhere bears the trace of but never contains.**

### Principle 1 — Everything is cause and effect (the causal web)
Nothing in the universe is arbitrary flavor. Every thing has an origin, a reason, and a history — whether or not the player (or initially even the system) has surfaced it. A floating colonized head is a being that lived, died, drifted, and was settled; toenail-life has a biochemistry and an evolution; a barren belt is the remains of *something*. The universe is a connected web of causes, and "it's just there for vibes" is forbidden.

### Principle 2 — A coordinate yields a *history*, read at a moment in time
The atom of the universe is not an object but a **timeline**. A coordinate does not hold "a planet"; it holds the entire arc of a place — forming, thriving, aging, dying, becoming a remnant — and the player intersects that arc at the current moment. The same world is lush, then dying, then an asteroid belt, depending on *when* you arrive. (This is Frontier 4 — time as a function — applied not just to stars but to every significant thing.)

### Principle 3 — Laws vary by place (the possibility space, not fixed physics)
The universe is **not** built on the fixed laws of our universe. Our observed physics is treated as the *familiar corner* of a far larger possibility space — the region that happens to resemble where we evolved, not a ceiling on what can be. The effective laws themselves (what matter is made of, how strong gravity is, how fast time runs, whether worlds are even round, what kind of life arises) are **generated facts that vary by place.** Known science is one well-lit neighborhood; the rest is open.

### Principle 4 — The whole web is knowable, to any depth, on demand
There is **no permanent mystery — only the unexcavated.** Every cause fully exists and is fully derivable; the player simply may not have dug it up yet. Understanding is the deepest reward loop: confusion → investigation → comprehension, with the caveat that the chain never bottoms out (causes have causes), so there is always one more layer — the **asymptote**: you can always learn more and never reach the end. Functional mastery (how a thing behaves, how to survive/use it) and deep origin (what/why it ultimately is) can be excavated to different depths, but nothing is flagged "unknowable in principle."

### Principle 5 — Everything leans toward one origin it never contains
The causal web has a **floor**: a single origin, a moment-zero, that every chain eventually points back toward. The origin is **outside the system** and is never a place in it — within the universe you find its **traces, not its face.** The deeper and older you go, the more every thread converges toward that source, which the player can approach forever and never reach. (Design role of "the source outside the system": the generative law itself — the recipe — and ultimately its author.)

**Two different "origins" — keep them distinct.** There is the **cosmic origin** above (the *beginning* — the most ancient point, never reached, traced toward by going deeper and older). And there is the **player's origin: real Earth, in our real solar system** — the *most familiar* point, fully real-data (II.15), where every journey *starts*. They sit at opposite ends of the experience: you begin at the most known thing that exists (Earth) and travel outward and backward toward the least known (the beginning). Progression *is* that journey from the familiar origin toward the cosmic one (see Gameplay & Progression doc §12).

### Principle 6 — Coherence is the floor (wonder vs. noise)
The line between **sublime wonder and a hollow glitch** is internal consistency plus a derivable cause. Every strange thing — toenail-life, time distortion, a non-round world — must obey *its own* consistent rules (even if not ours) and must have a real, derivable origin. "Unknown laws that hang together" is awe; "no laws" is noise. This principle is the guard that keeps Principle 3's freedom from collapsing into randomness, and it applies to *everything*, no exceptions.

### Principle 7 — The grounded majority makes the rare wonder land
Weird only lands against normal. Most of the universe must be **grounded and believable** (real-ish astrophysics and chemistry) so that the rare exotic and the vanishingly-rare mythic *hit*. This is a rarity **spectrum**, not a coin flip: a grounded floor, a rarer exotic tier, a mythic tail — and the deeper down the rarity tail, the stranger the laws are allowed to get. (Real science also supplies awe and fear for free and more believably than invention: black holes, neutron stars, time dilation, the void.)

### Principle 8 — Compute, don't store; derive, don't simulate
All of the above must be affordable, which is possible only because the universe is **generated on demand, deterministically, and stored not at all.** The full causal history is *real and complete and consistent* without ever being *run forward* (no simulation from the beginning) or *saved* (no database of worlds). Any link of the web — backward to a cause, forward to an effect, deep into an origin — is **computed the moment it's looked at**, identically every time, like reading a digit of pi that was always there. "The system knows the whole story" means **"the system can compute any part of it, to any depth, on demand"** — not that it ran it, and not that it stored it. (This is the engine from master plan Part 1 + Part 0 Decision 1a; it is what makes Principles 1–7 buildable rather than fantasy.)

---

## PART II — The Dials (the statute book)

Every governing constant, range, table, and rule, by layer. Each is flagged **[S] structural** (a real decision, change it and you change what the universe *is*) or **[T] tunable** (a sensible starting value to dial in by building — most of these are discovered during the vertical slice and ring 1, per master plan Part 1.3). Values are starting proposals unless noted. This is also the **no-gaps checklist**: nothing here may be left undefined before launch.

### II.0 — The Origin & Universe layer

| Dial | Starting value / range | Flag |
|---|---|---|
| Master universe seed | one fixed 64-bit constant (pick once; it *is* the universe's identity) | **[S]** |
| Galaxy layout | a 3D distribution expanding from an **origin region**, so each galaxy has a derivable "distance/age from origin" (echoes the real expanding universe + Principle 5) | **[S]** |
| Galaxy count | finite, large — start ~4,096 (expandable); a true universe with structure, not infinite uniform grid | **[T]** |
| Cosmic time | game-time advances in "cosmic years"; universe has a current age `T_now` | **[S]** |
| Time compression — visible motion | day/night + orbits sped so motion is visible — start: a day in ~4 min, an orbit in ~30–60 min | **[T]** |
| Time compression — deep history | lifecycle events (stars, worlds) keyed to cosmic-years, vast relative to play time | **[T]** |
| **Origin-trace through-line** | a real convergent signature (see II.11), strengthening with age/causal-depth | **[S]** |

### II.1 — The Substance system (what matter can be made of)
The grounded majority rolls common substances; a rare tail reaches the exotic (Principle 7). Each substance carries properties (density, hardness, color, thermal/optical behavior) that feed terrain, visuals, and gameplay.

| Tier | Substances (starting set) | Rarity weight (starting) |
|---|---|---|
| Common | silicate rock, iron/metal, water-ice, liquid water, basaltic/volcanic rock, carbon compounds, common gases (H/He/CO₂/N) | ~85% |
| Uncommon | metallic ores, sulfur compounds, ammonia ice, methane liquid, salt/mineral crusts, crystalline silicates | ~13% |
| Exotic (tail) | metallic hydrogen, exotic crystal, keratin-analogue ("toenail" matter), organic/bone matter, superdense/degenerate matter, unnamed anomalous substances | ~2% |

Flags: the substance *set* and tiers **[S]**; the specific properties and weights **[T]**.

### II.2 — The Life-kinds system (what life can be based on)
Same shape: carbon-water dominates (the familiar corner); exotic chemistries form the tail. Each life-kind gates morphology, behavior, and the lore vocabulary.

| Tier | Life-kind (starting set) | Rarity weight (starting) |
|---|---|---|
| Common | carbon-water | ~80% |
| Uncommon | silicon-based, ammonia-solvent, methane-based, lithotrophic (rock/chemical) | ~17% |
| Exotic (tail) | crystalline life, keratin-analogue life, plasma/energy-pattern life, single-vast-organism worlds, unclassifiable | ~3% |

Flags: the life-kind *set* **[S]**; weights and trait-gating **[T]**. (Coherence: a life-kind must be consistent with the world's substance, temperature, and chemistry — Principle 6.)

### II.3 — The Effective-Laws system (the per-place law dials — the heart of Principle 3)
The dials that **vary by place** (rolled at region/system/planet level, tinted by galaxy type). Each has a normal center, a wide range, and a rare-extreme tail.

| Law | Normal center | Range (most worlds) | Rare-extreme tail | Flag |
|---|---|---|---|---|
| Gravity multiplier | 1.0× | 0.3×–2.0× | 0.05×–4× | **[T]** |
| Time-rate multiplier | 1.0× | 0.8×–1.25× | 0.001×–1000× (near collapsed objects) | **[T]** |
| World shape | sphere | sphere (~98%) | ellipsoid, ring/torus, shattered, irregular set-pieces (~2%) | **[S]** set / **[T]** weights |
| Atmosphere presence/type | from size+temp (II.7) | none→dense | corrosive/exotic | **[T]** |

Flag: the *existence* of place-varying laws is **[S]** (it's Principle 3); the ranges and weights are **[T]**.

### II.4 — The Galaxy layer

| Dial | Starting value | Flag |
|---|---|---|
| Galaxy types | balanced, harsh, lush, ancient, young, exotic-leaning (each shifts all lower-layer weights) | **[S]** set / **[T]** weights |
| Spiral parameters | arm count 2–6; logarithmic tightness; density falloff core→rim | **[T]** |
| Galaxy age | derived from distance-from-origin (II.0) — older galaxies carry more origin-trace (II.11) | **[S]** linkage / **[T]** curve |
| Per-galaxy law-tinting | a galaxy nudges substance/life/effective-law weights (a "harsh" galaxy → more hostile worlds) | **[T]** |

### II.5 — The Region layer (the seamless-meaning keystone)

| Dial | Starting value | Flag |
|---|---|---|
| Region size | ~400 light-year cube (from source research; tune for density) | **[T]** |
| Region keystone fact | a controlling power + character (frontier/industrial/sacred/war-torn/abandoned) + high-level history — the **shared parent fact** neighbors agree on (master plan Frontier 2) | **[S]** |
| Region age | derived; feeds origin-trace and which events have had time to occur | **[S]** linkage |
| Region-scale law variation | a region may be a "weird-physics zone" (shifts II.3 ranges for everything inside) | **[T]** |

### II.6 — The System & Star layer

**Star class distribution** (realistic census, starting values):

| Class | Color | Abundance |
|---|---|---|
| M (red dwarf) | red | ~73% |
| K (orange) | orange | ~12% |
| G (yellow) | yellow | ~7.6% |
| F (yellow-white) | white | ~3% |
| A (white) | white | ~0.6% |
| B/O (blue) | blue | ~0.12% |
| Remnants | (end-states: white dwarf / neutron star / black hole) | by stellar death, see lifecycle |

Other system dials:

| Dial | Starting value | Flag |
|---|---|---|
| Luminosity | `L ≈ M^3.5` (M in solar masses) | **[S]** (physics) |
| Habitable zone | `d_inner = √(L/1.1)`, `d_outer = √(L/0.36)` AU | **[S]** (physics) |
| Planet count | 0–8 per system, weighted toward 1–4 | **[T]** |
| Star lifecycle | main-sequence → (by mass) red giant → white dwarf / neutron star / black hole, as a function of cosmic-time (Principle 2 + Frontier 4) | **[S]** |

### II.7 — The Planet layer

| Dial | Starting value / rule | Flag |
|---|---|---|
| Effective-laws roll | gravity, time-rate, world-shape from II.3 (tinted by region/galaxy) | **[S]** linkage |
| Temperature | from orbital distance vs `L` (II.6) → frozen/cold/temperate/hot/scorching | **[S]** (physics) |
| Atmosphere | from planet size → gravity → gas retention, + temperature | **[S]** (physics) / **[T]** thresholds |
| Archetype | the 12-world-kind library (frozen_ocean, volcanic, irradiated, lush, desert, fungal, crystalline, oceanic, barren, toxic, gas_shrouded, exotic), gated by climate+substance+atmosphere, **loaded toward the interesting** (master plan Part 2) | **[S]** library / **[T]** weights |
| Terrain character | plateaus/dunes/fjords/spires/etc., gated by archetype; feeds the density field | **[T]** |
| Hazard / Life / Resource / Landmark | gated by archetype/atmosphere/star; landmark **rare** (weighted) | **[T]** |
| **Planet lifecycle** | forms → matures → ages → dies (or is destroyed) → remnant (belt/void/derelict), as a function of cosmic-time (Principle 2) — the same coordinate reads differently by era | **[S]** |

### II.8 — The Terrain layer (per-archetype noise recipes)
Each archetype needs **its own** density-field recipe — this is what makes a frozen ocean *look* like a frozen ocean (master plan Part 5.4). Starting template (override per archetype):

| Parameter | Starting value | Flag |
|---|---|---|
| fBm octaves | 6–8 | **[T]** |
| Lacunarity / gain | 2.0 / 0.5 | **[T]** |
| Domain-warp iterations / strength | 1–2 / archetype-specific | **[T]** |
| Noise style mix | fBm / ridged / billow per archetype (ridged→mountains, billow→dunes) | **[T]** |
| Height scale, ocean level, roughness | archetype-specific | **[T]** |
| Mesh extractor | Surface Nets (Dual Contouring where sharp features needed) | **[T]** |

Flag: that each archetype has its *own* recipe **[S]**; the values **[T]** (the bulk of ring-1 tuning).

### II.9 — Orbits & motion

| Dial | Starting value / range | Flag |
|---|---|---|
| Semi-major axis | 0.3–40 AU | **[T]** |
| Eccentricity | 0.0–0.6 (hard cap 0.8 — Newton-Raphson stability, master plan Part 5.6) | **[T]** |
| Inclination | 0–30° | **[T]** |
| Other elements | argument of periapsis, ascending node, mean anomaly at epoch: 0–360° | **[T]** |
| Solver | Kepler via Newton-Raphson; angle in double, mod 2π, then float | **[S]** (precision) |

### II.10 — The Wonder / Rarity spectrum (the master dials of Principle 7)

| Dial | Starting value | Flag |
|---|---|---|
| Grounded fraction | ~92% of worlds/systems (real-ish science) | **[T]** |
| Exotic fraction | ~7.5% (one or more effective-laws/substances/life out on the tail) | **[T]** |
| Mythic fraction | ~0.5% (set-piece wonders — floating heads, etc.) | **[T]** |
| Mythic singularity | the rarest wonders may be **unrepeatable** (one of a kind in the whole universe) vs rare-recurring kinds — **decide per wonder** | **[S]** |
| "Load the dice" within eligible | over-produce striking, under-produce forgettable-average | **[T]** |
| Wonder-archetype library | the set of mythic set-pieces (planet-scale), placed deterministically like rare landmarks | **[S]** library / **[T]** weights |

### II.11 — The Origin-trace (making Principle 5 real, not vibes)
The trace must be a **genuine convergent signature**, or players read it as empty atmosphere. The mechanism:
- The master seed (II.0) seeds a low-frequency **global ancestry field** over the whole universe (cheap to compute — just hashing the master seed with coarse coordinates).
- Every thing derives partly from a **global-ancestry hash** chained from the master seed, and partly from local rolls. The **blend weight** between them is a function of **age / causal-depth**: the older and deeper a thing, the larger the fraction of its character that comes from the shared root.
- Result: ancient and deep things **rhyme** (dominated by the common ancestor); young/shallow things are dominated by local variation. The convergence is **real and derivable** — you could measure "how much of this comes from the universal root" and it rises toward the origin, giving a literal gradient that points toward a beginning you approach forever and never reach.

| Dial | Starting value | Flag |
|---|---|---|
| Global ancestry field | low-frequency, master-seed-derived | **[S]** |
| Age/depth → root-blend curve | more root the older/deeper (curve tunable) | **[S]** existence / **[T]** curve |

### II.12 — The Causal-history engine (how Principles 1, 2, 4 actually run)
The fact derivation must run **both** top-down (galaxy→…→planet) **and** backward/outward (effect→cause) and forward (cause→effects), with everything agreeing:
- **Backward derivation:** an effect (the floating head) derives its cause (the Vthal species), which derives *its* cause (a homeworld at a real coordinate), and so on — each a deterministic fact, computed on demand (Principle 8).
- **Cross-time/space agreement:** the cause you excavate must match what's actually at that coordinate *when you go there* — and that coordinate must compute the *same* history from its own side (a thriving world, or the *same* cataclysm leaving the *same* belt). This is seamless meaning (master plan Frontier 2) extended across **causal chains through time**, via symmetric functions of coordinate-pairs + shared parent facts.
- **Lifecycles:** every significant thing is a **timeline of states**, computed at cosmic-time `T` (II.7, II.6) — not a snapshot.

Flag: the engine is **[S]**. **Honest hard-edge:** the fully-general version (every cause derivable backward, every effect forward, all mutually consistent across all of space and time, on demand) is the hardest thing in the project — a research edge (Part III). We build a **bounded** version first.

### II.13 — The Knowledge / excavation layer (Principle 4 as played)
| Dial | Rule | Flag |
|---|---|---|
| Excavation depth | every fact has layers a player can progressively infer/reveal (drop a stone → infer gravity; analyze life → infer chemistry; trace history → reveal origin) | **[S]** |
| The asymptote | always one more layer; the deepest never fully resolves (Principle 4) | **[S]** |
| Knowledge storage | a player's understanding banks on their character (Memory layer); optionally **collective** (a growing galactic body of knowledge) | **[S]** choice |
| How vs why | functional mastery (survive/use) excavatable separately from deep origin (what/why) | **[T]** |

### II.14 — The Determinism engine (Principle 8, concrete — and the law that guards them all)
| Dial | Value | Flag |
|---|---|---|
| Hash function | **PCG** — Jarzynski & Olano (JCGT 2020): 1D RXS-M-XS + `pcg2d`/`pcg3d`/`pcg4d`, 32-bit integer ops, bit-identical across JS/WGSL/Rust. **Pinned** — exact code in the canonical-generation-pipeline doc §1 | **[S]** |
| Seed chain | each layer = `hash(parent_seed, address, salt)`; salts per purpose ("terrain","life","history",…) | **[S]** |
| Integer / fixed-point discipline | all canonical generation + all threshold *decisions* on integer-derived values (master plan Part 0 Decision 1a) | **[S]** |
| Coarse → fine | finer facts derived *constrained by* coarser ones (consistency for free; master plan Frontier 3) | **[S]** |
| On-demand + store-nothing | derive when looked at; store only the Memory layer (player changes/knowledge) | **[S]** |
| Conformance/golden test | identical output across web/native/server or the build fails | **[S]** |

### II.15 — The real-data anchor, the creation model, and the one concession
Three foundational decisions that ground the universe in reality and define how new things come to be. (Played out in the Gameplay & Progression doc.)

**The real-data anchor — real skeleton, procedural flesh.** The universe is anchored to reality at the start and grows procedural outward. A seed generates *plausible* things, not *factual* ones — so real Earth (a contingent fact, not derivable from math) is the one thing that must be **loaded as data**, not computed.

| Dial | Rule | Flag |
|---|---|---|
| Loaded (real) | real elevation (Earth/Moon/Mars), real building footprints + roads (cities as geometry), real orbital elements, ~1.8B real stars (Gaia) | **[S]** |
| Generated below resolution | detail finer than the real data (rocks, textures, exact building shapes between known points) | **[S]** |
| Generated beyond the frontier | the far universe we have no data for — seeded to *match the statistics* we do know | **[S]** |
| Cities | real footprints raised + textured procedurally; **population & politics deferred** | **[S]** scope |
| Player origin | real Earth / our Sol — the most familiar point (Principle 5) | **[S]** |

Same rule as everything else: **load what you can't recompute, compute what you can.**

**The creation model — derive what the laws would produce; don't run the process.** New things are *what the universe's laws would produce, derived on demand with a real cause* — not hand-placed, not literally run-forward. Three cases: things **already there** (latent in the math, fully derivable — Principle 8); things the laws would **form** (non-living — real science in the rules genuinely *creates*); things that would **evolve** (life *derived to be what evolution under this world's conditions would plausibly arrive at*, every trait reasoned). The honest ceiling is in Part III. The principle: **derive the outcome, never enact the process** — and make the generative space deep enough that the achievable version feels limitless.

**The one concession — FTL, earned.** The universe is real-physics with **exactly one acknowledged fiction: faster-than-light travel**, without which "explore the universe / meet other civilizations" is impossible at real scale (the nearest star is a 42-year trip at an impossible tenth of light-speed). It is **earned diegetically** via the **crash prologue** (an alien craft crashes to Earth; humanity reverse-engineers FTL from it). The prologue is **authored content, identical for everyone** (the authored layer, not the generation layer); everything past it stays generated. In-system travel stays real Newtonian; only the interstellar jump is the concession (Gameplay doc §1, §5).

---

## PART III — The Hard Edges (stated honestly)

Three things in here are genuinely hard. We build bounded versions; we do **not** pretend the fully-general versions are solved.

1. **Backward + cross-time causal agreement (II.12).** Making an effect's causes derivable backward, an cause's effects forward, and every link mutually consistent across space *and* time, cheaply and on demand, is the hardest thing on the board. **Bounded version:** derive causal chains to a fixed depth; anchor agreement to shared parent facts (region/sector) and symmetric pair-functions; guarantee consistency for the links the player can actually reach, rather than for the entire infinite web. The fully-general case is a research edge — flagged, not blocked.
2. **The origin-trace as a real through-line (II.11).** A genuine convergent signature (not fog) threaded through everything, denser toward the deep past. **Bounded version:** the global-ancestry-field + age/depth blend above is concrete and cheap; the risk is purely in tuning it so the convergence is *noticeable and rewarding* rather than subliminal. Real work, not a wall.
3. **Laws-vary-by-place without incoherence (II.3 + Principle 6).** Letting gravity/time/shape/substance/life all vary, while every combination still *hangs together*. **Bounded version:** constraint-chaining (each law constrains the next) + the coherence floor as a hard gate; start with a modest set of dials and widen as the coherence rules prove out.
4. **Open-ended evolution (II.15 creation model).** Literal evolution *run forward* that keeps inventing genuinely new *kinds* of complexity the rules never anticipated (the way nature invented eyes, then minds) is **both** the "simulation that must run from the beginning" wall **and** a famous unsolved research problem — no one has built rules that keep surprising themselves forever, even with unlimited compute. **Bounded version (which we ship):** *derive the outcome the laws would produce, never run the process* — creatures derived as "what evolution under these conditions would plausibly arrive at," with the generative space made deep and wide enough that the achievable version feels limitless to any human who plays. We do not promise the unbounded version; we make the bounded one rich enough that the difference doesn't show.

---

## PART IV — What to decide now vs. discover later

Per Principle 8's parent rule (master plan Part 1.3: tune freely now, freeze when live), most **[T]** values are *discovered by building*, in this order:

- **Decide now (the [S] articles + sets):** all of Part I; the master seed and galaxy layout (II.0); the substance/life/effective-law/archetype/wonder *sets* and *libraries*; the determinism engine (II.14); the causal-history engine's *shape* (II.12); the origin-trace mechanism (II.11). These define *what the universe is* and can't be deferred without deferring the identity of the universe.
- **Discover during the vertical slice:** the engineering [T]s — chunk size, LOD thresholds, planet radius, time-compression-for-motion (master plan slice spec).
- **Discover during ring 1 (planet quality):** the bulk of the [T]s — per-archetype terrain recipes (II.8), archetype/hazard/life/resource weights, atmosphere thresholds, the "load the dice" tuning, the grounded/exotic/mythic split (II.10).
- **Build late (frontier + game rings):** the political/historical/relational facts (II.5 keystone, II.12 causal chains), the deep origin-trace (II.11), the knowledge/excavation layer (II.13), and the exotic/mythic tail (II.1–II.3 tails, II.10 wonders). The grounded floor comes first; the strangeness is layered on as the engine proves out.
- **The one-way door:** when the universe goes live and shared, the **[S] dials freeze** across web/native/server simultaneously (master plan Part 1.3 + 0 Decision 1a). Tune the **[T]**s freely until then.

---

## PART V — What this changes in the existing documents (reconciliation)

The Constitution is the authority; these are the specific places it **extends or supersedes** earlier docs, so nothing contradicts. **Status: the propagation pass is done** — the edits below have been folded into the individual documents (the master plan and fact-gen design now carry an "authority note" pointing here, plus the in-section extensions).

- **Master plan Part 1** (the mental model — a coordinate yields *a world*) → **extended** by Principle 2: a coordinate yields a *history read at a moment in time* — `world = f(coordinates, game_time)`. *(Done: master plan §1.6 added.)* Note: the earlier draft of this list said "Part 1.1 ('a coordinate yields a world')," but that exact phrase wasn't in the plan — the change is to the model running through all of Part 1, now made explicit in §1.6.
- **The "permanent mystery" idea** (a thing flagged unknowable-in-principle) → **retracted** by Principle 4: there is no unknowable-in-principle, only the *unexcavated*; the floor is the origin (Principle 5), not a wall. Note: this idea was only ever raised in conversation and **never written into any document**, so there was nothing to edit — it is recorded here so it stays retracted.
- **Fact Generation Design** (top-down derivation only) → **extended** by II.12: derivation also runs backward/forward across causal chains and time; facts become *timelines* (II.7); the effective-laws layer (II.1–II.3) sits above climate/archetype. *(Done: fact-gen §10 added, plus the spine in §1 updated.)*
- **Master plan Part 2** (the archetype library that defeats sameness) → **subsumed** as one layer (II.7) of a larger possibility space that now includes place-varying laws, substances, life-kinds, and a rarity spectrum to the mythic (II.1–II.3, II.10). *(Done: noted in the master plan authority note.)*
- **Master plan Frontier 4** (time as a function — stars age) → **broadened** by Principle 2 to *every* significant thing having a lifecycle (II.6, II.7). *(Done: noted in the authority note and master plan §1.6.)*
- **All four docs' determinism rules** → **consolidated** unchanged into II.14 and Principle 8 (this is the one thing the Constitution restates rather than revises). *(No edit needed.)*

Everything else in the existing documents stands; the Constitution is the spine they now hang from.
