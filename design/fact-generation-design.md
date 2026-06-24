# Fact Generation Design — Why a Coordinate Is What It Is

This specifies the layer that decides **why** a given coordinate is a frozen ammonia ocean held by a remnant faction after some old silence — and not something else. It produces the `PlaceFacts` record that feeds *both* the terrain (the density field) *and* the lore pack (the prose generator). It is, in a real sense, the heart of the universe: it's the "law" that gives every world a reason for being what it is.

It connects to the rest of the plan as follows: it is part of the **canonical generation core** (master plan Part 0 Decision 1a — deterministic, integer-based, identical on web/native/server); it *is* the concrete implementation of several frontiers (Part 7 — equilibrium, seamless meaning, detail-on-demand, time); it outputs the schema the **lore content pack** consumes; and it shares inputs with the **density field** so terrain and description always agree. It is also the answer to the earlier "everything should have a story/reason" thread — achieved by *computation from physical and political logic*, not by running a simulation.

> **Authority note (read first).** This document sits beneath **The Universe Constitution**, which is the final authority. The Constitution extends this design in three ways now woven in below: (1) an **effective-laws layer** (gravity, time-rate, world-shape, substance, life-kind — Constitution II.1–II.3) sits *above* climate/archetype and is rolled before them, so "what laws hold here" is the first thing decided; (2) facts are **timelines, not snapshots** — every significant thing is derived at a cosmic-time `T` and has a lifecycle (Constitution Principle 2); (3) derivation runs not only top-down but **backward and forward across causal chains** — an effect's causes and a cause's effects are derivable and must agree across space *and* time (Constitution Principle 1 + II.12). Sections 1–9 below are the top-down spine; §10 (added) covers the effective-laws layer, the time dimension, and backward/forward derivation.

---

## 1. The core principle: facts are a deterministic derivation — top-down, and across the causal web

Facts are not rolled independently and hoped to fit together. The backbone is an **ordered top-down chain, each level constraining the next** — and (per the Constitution) it also reaches **backward and forward across causes**, and is read **at a moment in time** (see §10):

```
EFFECTIVE LAWS → what physics holds here (gravity, time-rate, shape, substance, life-kind)  [§10]
 GALAXY      → sets the tone (type, overall character)
  REGION    → sets politics & character (the SHARED parent fact neighbors agree on)
    SYSTEM  → the star (class, age, LIFECYCLE) + how many planets
      PLANET→ archetype, climate, atmosphere, terrain — constrained by laws + star + orbit
        HISTORY → what happened here, constrained by the planet + region
        RELATIONS → ties to neighbors AND to causes/effects elsewhere (§10)
        LIFECYCLE → the planet's arc over cosmic-time: forming → … → remnant  [§10]
```

Three properties fall out of this structure, and they're exactly the frontiers from the master plan:

- **Consistency for free (Frontier 3 / detail-on-demand).** Each finer level is a *refinement* of the coarser one — the coarse value is computed first and fed in as a *constraint* on the finer value. So a planet's specifics can never contradict the system's, which can never contradict the region's, which can never contradict the laws that hold there. This is the same coarse→fine discipline as fBm octaves: detail is *added inside the box the coarse value drew*, never allowed to move it.
- **Cheap (detail-on-demand again).** You only ever derive down to the level you're observing. From the galaxy map you compute galaxy + region tone; you don't compute a specific person's grievance until someone flies down to meet them.
- **Deterministic & seamless.** Every level derives its facts by **integer-hashing its address** (master plan Part 3.6), so it's bit-identical everywhere. Neighbors agree because they share a parent fact and use symmetric rules (§5) — and *causes* agree with *effects* the same way (§10).

---

## 2. The derivation pipeline (the spine)

Each step takes the parent's facts + the level's coordinate-seed and produces this level's facts.

1. **Galaxy facts** ← `hash(galaxy_index)`. Galaxy *type* (balanced / harsh / lush / ancient / etc.) shifts the probability tables used everywhere below.
2. **Region facts** ← `hash(region_coord)`, constrained by galaxy type. **This is the keystone for seamless meaning:** a region carries a *controlling power*, a *character* (frontier / industrial / sacred / war-torn / abandoned), and a *high-level history*. Neighbors share this because they can both compute it from the region's coordinate (§5).
3. **System facts** ← `hash(system_addr)`, constrained by region. Star *class* (weighted by realistic stellar census), star *age*, planet *count*.
4. **Planet facts** ← `hash(planet_addr)`, constrained by the **star + the planet's orbital distance** (this is where physics enters — §3). Produces archetype, temperature, atmosphere, terrain, hazard, life, resource, landmark.
5. **History facts** ← `hash(planet_addr, "history")`, constrained by the region's history + the planet's habitability. Produces the event + former state.
6. **Relationship facts** ← symmetric functions of *coordinate pairs* + the shared region/sector fact (§5). Faction relations, river continuity, trade routes.
7. **Social/memory facts** ← the **Memory layer**, not pure generation (traffic level from aggregated player behavior — master plan Frontier 5). Read as one more input; lives on the stored side.

---

## 3. The actual rules, per fact category (the meat)

Concrete derivations, not hand-waving. Each is deterministic (integer-hash based) and *gives the world a reason*.

### 3.1 Star class & age
- **Class:** weighted pick by real stellar abundance (red dwarfs ~70%, down to blue/giant ~0.1%), drawn from `hash(system_addr,"star")`, with weights shifted by galaxy type. Luminosity follows roughly `L ≈ M^3.5`.
- **Age:** `hash(system_addr,"starage")` → young / mature / ancient / dying / dead. Ties to **Frontier 4 (time):** age can also advance with game-time, so an old star may have *become* a red giant or died — computed, not stored.

### 3.2 Temperature — the first real "why"
The planet's base temperature comes from **orbital distance vs. star luminosity** — actual habitable-zone physics (master plan Part 5.6): close to a bright star → hot; far from a dim one → frozen. Map the resulting energy flux to a `temperature` class (frozen / cold / temperate / hot / scorching). *This is why a planet is frozen — because it's far from a faint sun — and the reason is physically real, not arbitrary.* (Atmosphere thickness, §3.4, then nudges it: a dense atmosphere warms; none leaves extremes.)

### 3.3 Archetype — the strongest identity lever
The world-kind (master plan Part 2's library: frozen_ocean, volcanic, irradiated, lush, desert, fungal, crystalline, oceanic, barren, toxic, gas_shrouded, exotic). Derived from **temperature + water-presence + atmosphere + a hash**, with two rules from Part 2:
- **Coherence gate:** only archetypes valid for the climate are eligible (a frozen archetype only in cold zones; lush only where it's temperate *and* wet *and* breathable). This is the primary guard against incoherent worlds.
- **Load the dice toward the interesting:** weight the eligible set so striking archetypes (crystalline, exotic, fungal) appear more than the bell curve would give, and bland "barren rock" less — so the universe over-produces memorable worlds (master plan Part 2.6).

### 3.4 Atmosphere — another physical "why"
From **planet size → gravity → ability to retain gas**, plus temperature and a hash. Small/hot worlds tend to none/thin; large/cold worlds can hold dense atmospheres; toxic/corrosive are rarer rolls gated by archetype (volcanic→toxic plausible; barren→none). *Why the air is thin: the world is too small and too warm to hold more.*

### 3.5 Terrain character — and the terrain/description link
`hash(planet_addr,"terrain")` constrained by archetype → terrain class (plateaus, dunes, fjords, spires, etc.). **Critical wiring:** these same facts feed the **density field's parameters** (master plan Part 5.4) — so the geometry you walk on *matches* the description the lore pack writes. The facts and the terrain are computed from shared inputs; they cannot disagree.

### 3.6 Hazard, life, resource, landmark
- **Hazard** ← gated by archetype + atmosphere + star (irradiated/neutron-star→radiation; toxic→toxic_air; volcanic→searing_heat or quakes; calm worlds→none).
- **Life** ← gated by archetype + temperature + atmosphere (teeming only where habitable; barren on dead/airless worlds). Ties to **Frontier 1 (equilibrium):** the *balanced* ecology (who eats whom, populations) is computed directly from these traits, not simulated forward.
- **Resource** ← weighted by archetype (crystalline→crystal; gas_shrouded→exotic_gas; irradiated→isotopes), mostly "none."
- **Landmark** ← **rare** weighted roll (mostly "none"); when present, gated for coherence (bone_fields on a once-living world; derelict_megastructure where there's history).

### 3.7 Faction — derived at the region level (this is the seamless-meaning key)
A **region** has a controlling power and character (`hash(region_coord)`, shifted by galaxy type), and **systems inherit it.** This is *why neighbors agree on politics*: both compute the same region fact from the same region coordinate. Faction *type* (empire/republic/syndicate/collective/cult/remnant/none) comes from the region hash; a system near a region border may be *contested* (§5).

### 3.8 History / cataclysm — constrained, so it explains the present
`hash(planet_addr,"history")` → event (plague/war/stellar_disaster/exodus/the_silence/ascension/untouched) + former_state, **constrained so it's coherent:** a dead world's history tends to *explain* its deadness (a stellar_disaster around a now-dying star; the_silence on a once-inhabited world); an untouched world has no ruins. Constrained by the region's high-level history too, so a war-torn region's planets share echoes of the same war.

---

## 4. Coherence — how the facts agree with each other

The master plan's "parts must agree" rule (Part 2) is enforced two ways, both already visible above:

1. **Constraint chaining.** Because each fact is derived *taking prior facts as inputs* (temperature constrains archetype constrains terrain/hazard/life), contradictions are structurally impossible — a fact literally cannot be chosen outside what its parents allow.
2. **The archetype as a coherence anchor.** Once the archetype is chosen, it gates the eligible hazards, life, resources, landmarks — *and* the lore pack's vocabulary (master plan Part 6.4). One anchor keeps the geometry, the systems, and the prose all telling the same story.

And coherence extends to the **terrain itself:** the facts that say "frozen + fjords" are the same inputs that drive the density field, so the world you see matches the world you read about (§3.5).

---

## 5. Seamlessness — making independently-generated neighbors agree (Frontier 2, concrete)

The problem (master plan Part 7.3): System A and System B are generated on different machines with no communication, yet must agree — if A thinks "at war with B," B must think "at war with A"; a river leaving A must arrive in B. The mechanism:

- **Symmetric pair functions.** A relationship between two places is computed from **both their coordinates by an order-independent rule**: `relation(A,B) == relation(B,A)`. Feed both coordinates into one function (e.g. hash of the sorted pair). Then A asking "my relation to B?" and B asking "my relation to A?" run the *same* function on the *same* pair → identical answer, with zero coordination and nothing stored.
- **Shared parent facts for the long range.** Pairwise rules alone can produce contradictions across chains (A vs B, B vs C, but what's A vs C?). Bound this by anchoring relationships to a **higher-level fact both parties can compute** — the *sector's* politics, derived from the sector coordinate, which every region inside it shares. Global structure is then anchored by a cheaply-shared parent, not negotiated pairwise across the galaxy. (The fully-general transitive case stays a research edge we don't need for v1 — master plan Part 7.3.)
- **Geographic continuity** works the same way: a river's exit point is computed from the **shared edge** between two regions, so the neighbor computes the same entry point; a trade route is computed from the pair of systems it links.

Worked example: A and B both compute `relation(sortedPair(A,B))` → "trade_partners," and both compute the border line from the same shared edge. A's lore says "trades with the system coreward"; B's lore says "trades with the system rimward"; they describe the *same* relationship from two sides, and never disagree.

---

## 6. Determinism — the non-negotiable discipline

Because this all lives in the canonical core of a shared universe (master plan Part 0 Decision 1a):
- **All fact derivation is integer-hash based.** No float hashing for canonical values (Part 3.6).
- **Threshold decisions are made on integer-derived quantities, never raw floats.** A biome that flips on "temperature > 0.2" can diverge between machines if temperature is a float computed slightly differently; compute the *decision* from integer-derived values so it's bit-identical. (This is the classic determinism bug; see Part 0 Decision 1a.)
- **Facts feed the conformance/golden test** alongside terrain — the test that fails the build if web, native, or server ever disagree.

---

## 7. The "why" payoff (and the tie back to "everything has a reason")

Notice that nothing here is arbitrary flavor: a planet is frozen *because* it's far from a faint star (§3.2); it's a barren rock *because* it's too small and warm to hold air and too far for liquid water (§3.3–3.4); its history explains its present state (§3.8); its politics match its neighbors *because* they share a region (§3.7, §5). Every world has a **chain of causes** behind what it is — which is exactly the "everything and everyone has a story or reason for being" you wanted earlier in our design conversation. We achieved it the affordable way: by **computing from physical and political logic**, not by simulating four billion years (master plan Part 2.4–2.5). The player experiences *coherence and consequence*; the cause-chain is real, and it cost a few hashes.

---

## 8. What's early vs. late (so you build it in the right order)

This whole design is written now, but it is **not** all built now. Map it onto the master plan's rings:

- **Built early — the *physical* layer (ring 1, right after the vertical slice):** star class/age → temperature (habitable-zone physics) → archetype (+ the library) → atmosphere → terrain → hazard/life/resource/landmark. This is what turns the slice's *hand-set* fact stub into real, varied, coherent planet identities, and it's what defeats sameness (master plan Part 2). **This is the priority part.**
- **Built mid (system & galaxy rings):** the full derivation chain (galaxy type → region → system), star aging over time (Frontier 4), basic facts-read-neighbors.
- **Built late — the *political/historical/relational* layer (frontier + game rings):** region politics, factions, history/cataclysm, and seamless-meaning relationships (§5, §3.7–3.8). These are the connective tissue under civilizations and lore, and they're among the *last* things you build (master plan Part 9). The lore pack can run on the physical facts alone at first, and gets richer as these come online.

**The seam that makes this safe:** the `PlaceFacts` schema is fixed *now* (it matches the lore pack and the slice's stub), and every fact is derived coarse→fine and symmetric-from-coordinates from day one. So each layer — physical, then system/galaxy, then political — slots into the same schema as it's built, and nothing already shipped has to be torn up.

---

## 9. How it connects to the other documents

- **Vertical Slice Build Spec:** the slice hand-sets one planet's facts in this exact schema; ring 1 replaces the stub with §3's physical derivation.
- **Lore Content Pack:** consumes this `PlaceFacts` record (its §1 schema is this doc's output); the archetype here anchors the lore vocabulary.
- **Master plan:** this is the concrete build of the "facts" half of Part 6.4 and the implementation of Frontiers 1–4 (Part 7); it runs inside the canonical core (Part 0 Decision 1a) and shares inputs with the density field (Part 5.4).

---

## 10. The Constitution extensions: effective-laws, time, and backward/forward derivation

The sections above are the original top-down spine. The Universe Constitution adds three things that change *what* gets derived and *in what order*. They slot into the same deterministic, integer-hash, coarse→fine machinery — they just widen it.

### 10.1 The effective-laws layer (rolled *first*, above climate)
Before climate or archetype, derive **what physics holds here** (Constitution II.1–II.3), because everything downstream is constrained by it:
- **Gravity multiplier, time-rate multiplier, world-shape** — rolled at region/system/planet level (tinted by galaxy type), each with a normal center, a wide range, and a rare-extreme tail (e.g. extreme time-rate near a collapsed object).
- **Substance** (what matter is made of) and **life-kind** (what life is based on) — drawn from the rarity-weighted tables (Constitution II.1–II.2), grounded-common with an exotic tail.
These become inputs to archetype, terrain, atmosphere, and life (§3): a world's substance and gravity constrain which archetypes are even possible, and its life-kind gates the creatures and the lore vocabulary. **Coherence still rules (Principle 6):** every combination must hang together, enforced by constraint-chaining and the coherence floor. This is how the wonder spectrum (toenail-matter, half-gravity, doubled-time) enters — as the rare tail of these rolls, not as special cases.

### 10.2 The time dimension (facts are timelines, not snapshots)
Every fact is derived at a **cosmic-time `T`** (Constitution Principle 2). The star has a lifecycle (main-sequence → giant → remnant by mass and age); the planet has a lifecycle (forming → mature → aging → dead/destroyed → remnant). So `facts = derive(coordinates, T)`, and the same coordinate reads as a different chapter at a different `T`. This is still pure, on-demand, stored-nothing — `T` is just one more input, shared by everyone. Practically: each significant fact is defined as a **function of `T`** (a small arc), not a fixed value, and you evaluate it at the current cosmic-time when looked at. (Precision discipline as ever: compute time-driven angles/values in double, reduce, then to float — master plan Part 5.6.)

### 10.3 Backward and forward derivation (the causal web)
Derivation no longer runs only top-down. Per Constitution Principle 1 + II.12, it also runs **outward along cause-and-effect:**
- **Backward (effect → cause):** a floating head derives its cause (a species), which derives *its* cause (a homeworld at a real coordinate + the conditions that produced it), to a bounded depth. Each link is a deterministic fact computed on demand.
- **Forward / cross-checking (cause → effect):** the homeworld the head's story points to must compute the *same* history from its own coordinate — thriving, or extinct-with-the-same-cataclysm leaving the *same* asteroid belt — whichever its lifecycle (10.2) says for the current `T`.
- **Agreement mechanism:** the same tools as seamless meaning (§5) — symmetric functions of coordinate-pairs + a shared higher-level fact — but applied across **causal chains through time**, not just neighboring space. Both ends derive the same shared cause, with no coordination and nothing stored.

**Honest hard-edge (carried from the Constitution, Part III):** the fully-general version — every cause derivable backward, every effect forward, all mutually consistent across all of space and time, on demand — is the hardest thing in the project, a genuine research edge. **We build the bounded version:** derive causal chains to a fixed depth, anchor agreement to shared parent facts and symmetric pair-functions, and guarantee consistency for the links a player can actually reach — not for the entire infinite web. Flagged, not blocked.

### 10.4 Build order for these extensions
Per the Constitution Part IV and §8 above: the **physical** effective-laws (gravity/time-rate/shape/substance grounded-common) come **early** with ring 1, since they constrain terrain and archetype. The **exotic tail** of laws/substances/life, the **lifecycles**, and the **backward/forward causal web** are **late** (frontier rings) — the grounded floor first, the strangeness and the deep causality layered on as the engine proves out.
