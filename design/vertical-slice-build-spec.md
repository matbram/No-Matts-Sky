# Vertical Slice — Build Spec (Milestone 0)

This is the buildable, step-by-step spec for the vertical slice defined in the master plan (Part 9, Milestone 0). The plan says *what done looks like*; this says *exactly what to build, in what order, with what interfaces and decisions, and how to know each step works.*

**The slice, restated:** spawn in orbit above one procedurally-generated planet → fly down through the atmosphere to the surface with no loading screen and no stutter → walk on the surface → the planet visibly rotates (day/night from real spin) while orbiting a sun you can see move → all at a locked 60fps on a target desktop GPU.

> **The slice is now the prologue, at real scale.** Per the Gameplay & Progression doc, the slice doubles as the game's opening: the alien-crash prologue → recover tech → build one ship → fly from **real-scale Earth to the real-scale Moon**, with one craftable thing. So the slice's "one planet" is **real-size Earth** (real radius, real orbit), and the "sun you can see move" is our real Sol, with the Moon as the second body (its real cast shadow = the eclipse test). Real scale changes the *numbers*, not the architecture (doubles give nanometer precision at Earth's radius; the floating origin handles render precision — master plan Part 5). Real Earth *elevation data* (the real-data layer, Constitution II.15) can be loaded in the slice or dropped in immediately after — start with procedural-but-real-scale terrain to prove the engine, then load the real heightmap.

**Why it's the whole ballgame:** it exercises nearly every hard system at once (generation, meshing, streaming, the frame hierarchy, real orbits, the frame budget). If it holds 60fps, you have a real engine. If it doesn't, nothing downstream saves the project. Everything else in the universe is a later ring on top of this proven core.

Recommended starting values are marked **[tunable]** — they're sane defaults to start from, not commitments. The durable value of this doc is the **module split, the build order, and the acceptance gates.**

---

## 1. Scope — what's in, what's deliberately out

**In:**
- One planet (one archetype, hand-set facts), one star, optionally one moon (only to prove a real cast shadow).
- Cube-sphere terrain with quadtree LOD, a density field, mesh extraction, async streaming.
- The reference-frame hierarchy down to body-fixed + floating origin (master plan Part 4).
- A player controller: fly in space, descend, land, walk on the surface, launch back to orbit.
- Real planet spin + real orbit around the star, time-compressed so you can see them.
- Atmosphere (scattering LUT) and triplanar materials, tuned to lock 60fps.

**Deliberately out (these are later rings — do not build them in the slice):**
- Multiplayer, the change-list / terrain editing, real-time presence.
- Multiple biomes, the archetype *library* (one archetype only here), creatures, flora, lore/prose.
- The galaxy, multiple systems, multiple planets (one planet + one sun + maybe one moon, full stop).
- The deterministic Rust core / cross-platform bit-identical generation (see §3 — the slice can be TypeScript; determinism matters when you approach multiplayer, not now).

**The discipline:** if a feature isn't on the "in" list, it does not enter the slice — but the **data shapes must leave room** for it (§4, the seams).

---

## 2. The module breakdown

Build these as cleanly separated modules. The single most important architectural rule (master plan Part 0) is the split between the **generation core** (pure logic, no rendering) and the **rendering shell** (Three.js). Keep them talking only through plain data.

```
┌─ GENERATION CORE (headless, no Three.js) ────────────────────┐
│  • hash / noise / fBm / domain-warp                          │
│  • density field  D(p)  for the one archetype                 │
│  • cube-sphere projection + quadtree node math               │
│  • mesh extractor (Surface Nets)                             │
│  • fact stub (hand-set PlaceFacts for the one planet)        │
│  → INPUT: chunk request (face, quadtree path, LOD)           │
│  → OUTPUT: plain mesh data (positions, normals, indices)     │
└──────────────────────────────────────────────────────────────┘
        │ plain data only (transferable buffers)
        ▼
┌─ RENDERING SHELL (Three.js WebGPU + TSL) ────────────────────┐
│  • renderer, materials (triplanar), atmosphere LUT shader    │
│  • chunk manager (decides what to generate / show / drop)    │
│  • worker pool (runs the generation core off the main thread)│
│  • frame system (reference frames, floating origin)          │
│  • player controller (space flight, landing, walking)        │
│  • the game loop                                             │
└──────────────────────────────────────────────────────────────┘
```

**Test for correct separation:** the generation core must run **headless** — in a plain Node/worker context with no Three.js imported — and produce mesh data. If you can unit-test it with zero rendering, the split is right, and the eventual native port / Rust rewrite is cheap (master plan Part 0).

---

## 3. The one upfront language decision (made, with reasoning)

The shared universe (master plan, Part 0 Decision 1a) eventually needs the generation core in a deterministic, portable form (Rust → WASM + native + server). The question: write it in Rust now, or TypeScript now and port later?

**Decision for the slice: TypeScript now, port to Rust when you approach determinism/multiplayer.** Reasoning (vetted): the slice's entire purpose is *fast iteration* on rendering, streaming, and feel, and the core at slice-stage is small (noise + density + sphere math + Surface Nets — a few hundred lines of pure math). The expensive rework in any rewrite is re-deriving algorithms and re-tuning, not translating a small, well-specified math module. So:
- Write the core as a clean, isolated, **well-specified** module with **unit tests on its outputs** from day one.
- Keep it **free of floats-where-it-will-later-matter habits** you can cheaply honor now (e.g., integer hashing already — master plan Part 3.6).
- When you near multiplayer, port the (still small) core to Rust and verify it against the saved test outputs (the golden test). Mechanical, not a redesign.

This is a deliberate, reversible choice — it trades a later mechanical port for much faster iteration during the most experimental phase. (If you'd rather eat the friction now, Rust→WASM from day one is the alternative; just expect slower terrain iteration.)

---

## 4. Data contracts (the interfaces — and the seams)

Define these early; they're what keep modules decoupled and let later systems slot in.

**Chunk request → mesh response** (core's public interface):
```
ChunkRequest  { face: 0..5, path: quadtree path (e.g. [2,0,3]), lod: int }
ChunkMesh     { positions: Float32Array, normals: Float32Array,
                indices: Uint32Array, bounds: AABB, lod: int, key: string }
```
Pass `ChunkMesh` buffers back to the main thread by **transfer, not copy** (master plan Part 8.2).

**The fact stub** — match the lore pack's `PlaceFacts` schema *exactly*, even though the slice hand-sets it and uses only a few fields. This is the seam that lets the real fact-generation layer (see the Fact Generation Design doc) slot in later with zero rework:
```
// hand-set for the slice's single planet; same field names as the real schema
PlaceFacts = {
  planet_name: "Slice-1",
  archetype: "barren",          // pick ONE archetype for the slice
  temperature: "cold",
  atmosphere: "thin",
  terrain: "plateaus",
  // ...the rest present but unused/placeholder for now
  star_class: "yellow", star_age: "mature", planet_count: 1,
}
```
Even in the slice, **derive the planet's seed from a coordinate** and key everything (the stub facts, any future persistence) **by that coordinate** — so the universe has a "home" from the first commit.

---

## 5. Concrete technical decisions (the vague-in-the-plan stuff, made specific)

- **Planet shape:** cube-sphere (6 faces) → quadtree per face → each leaf node meshed from a small voxel grid via **Surface Nets** (master plan Part 3.3 — smooth, simple, fast; Dual Contouring only later if you need sharp features). Stitch LOD boundaries with **skirts** first (cheap, hides cracks) and upgrade to Transvoxel only if seams show.
- **Density field** `D(p)` for the one archetype (master plan Part 5.4): `D = planetRadius − |p| + fBm(normalize(p)·scale)·height`, plus 1 domain-warp iteration for character. Compute **analytic normals** (value + gradient in one pass) so you're not triple-sampling (Part 5.2).
- **Voxel grid per chunk:** **[tunable]** 32³ (or 33³ with a 1-voxel overlap for seamless normals). Big enough for detail, small enough to mesh fast on a worker.
- **LOD:** split a quadtree node when its projected on-screen size exceeds a threshold **[tunable: ~ node spans > 400 px]**; max depth set so the smallest leaf gives ~human-scale detail. Cap **chunks generated per frame [tunable: 2–4]** and generate ahead along the velocity vector (Part 5.5).
- **Numeric types (critical — master plan Part 5):** system & body-fixed positions in **double**; render positions in **float**, via a **floating origin** re-centred on the player each frame. Never feed raw large doubles to the GPU.
- **Planet radius:** **real scale** — Earth **6,371 km**, Moon **1,737 km**, Mars **3,390 km** (use real values, not a placeholder). Doubles give nanometer precision at these radii and sub-millimeter across the solar system; the floating origin handles render precision (master plan Part 5). Real scale costs nothing extra to render — streaming only ever builds what's near you — so 60fps is unaffected by planet size.
- **Time compression:** **[tunable]** for the slice, make rotation *visible while testing* — e.g. a full day in ~4 minutes, a full orbit in ~30–60 minutes. Compute the spin/orbit angle in **double, modulo 2π, then to float** (Part 4.5 / 5.6 — the precision trap).
- **Star + moon:** one directional/point light from the star's position; the moon is a second body purely to verify a real cast shadow on the planet.
- **Atmosphere:** precomputed Rayleigh+Mie **LUT** sampled in a sky shader (Part 5.7) — not per-frame ray marching.
- **Materials:** **triplanar** projection (Part 5.8), 2–3 material bands by slope/altitude. One archetype's palette.

---

## 6. The build order *within* the slice (sub-milestones, each with a gate)

Build in this order. Each step has a **gate** — don't proceed until it passes. The 60fps lock is a *continuous* gate, checked at every step, not bolted on at the end.

**Step 0 — Static sphere from cube-sphere projection.**
Render a low-poly sphere built by projecting 6 subdivided cube faces onto a sphere (no noise yet). Free-fly camera orbits it.
*Gate:* a seamless sphere (no gaps at face edges), camera orbits smoothly, 60fps. Proves the projection + render pipeline.

**Step 1 — Density field + Surface Nets on one chunk.**
Add `D(p)` and mesh a single quadtree leaf with Surface Nets, on a worker. Display that one patch with correct normals.
*Gate:* a correctly-shaped, correctly-lit terrain patch matching the density field; meshing runs off the main thread. Proves meshing + normals.

**Step 2 — Quadtree LOD across the whole sphere.**
Recursively split/merge quadtree nodes by screen-space size; mesh all visible leaves. Static camera positions at orbit / mid / surface altitude.
*Gate:* seamless detail from orbit (coarse) to surface (fine) with no visible cracks (skirts on); correct LOD selection as the camera moves. Proves LOD.

**Step 3 — Async streaming (the hardest, most important step).**
Drive generation from camera position: a chunk manager requests needed chunks, the worker pool generates them, finished meshes upload to the GPU **spread across frames** (transfer not copy), distant chunks are dropped. Fly continuously from orbit to the surface.
*Gate:* **the descent has zero hitches and frame time never exceeds 16.67 ms** — the headline acceptance criterion. Proves streaming + the worker/GPU handoffs (master plan Part 8.2). Budget here is everything; if this step stutters, fix it before moving on.

**Step 4 — Frame system + walking.**
Implement the reference-frame hierarchy: a **floating origin** re-centred on the player; a **body-fixed** planet frame. Add a character controller that walks on the surface with collision against the canonical terrain, and gravity toward planet center.
*Gate:* walk anywhere on the surface, far from the spawn point, with **no jitter** (proves floating origin) and stable collision. Proves the frames + surface play.

**Step 5 — Real orbit + spin (the headline feature).**
The planet rotates about its tilted axis (day/night from *real* spin, not a moving light) and orbits the visible star, both time-compressed. Add the moon for a real cast shadow. Implement the **surface↔orbit launch handoff with velocity inheritance** (Part 4.3–4.4).
*Gate:* visible day/night from rotation; the sun's position changes over an orbit; the moon casts a real shadow; launching from the surface does **not** make the planet rocket away. Proves "real orbits" — the thing NMS faked.

**Step 6 — Atmosphere + materials + lock 60fps.**
Add the scattering LUT sky and triplanar materials; profile and optimize until the whole experience holds a **locked 60fps** on the target GPU, end to end (orbit → descent → surface → launch).
*Gate:* all acceptance criteria from master plan Part 9 pass simultaneously, at 60fps. The slice is done.

**Final acceptance (all must hold at once):**
- Orbit→surface descent: zero hitches, frame time < 16.67 ms throughout.
- Day/night from real rotation; sun moves over an orbit; moon casts a real shadow.
- Launch inherits planet velocity (planet doesn't fly away).
- Walking far from spawn shows no precision jitter.
- **Regenerating the same planet (reload) produces bit-identical terrain** (proves determinism — and pre-tests the future golden test).

---

## 7. Performance gates (apply the budget from the start)

Hold the master plan's frame budget (Part 8.1) as a live constraint at every step:

| Work | Budget (ms) | Where |
|---|---|---|
| Render pass (geometry, atmosphere LUT, materials, post) | 6–8 | GPU |
| Player physics | 1–2 | CPU/worker |
| Finished-chunk GPU upload (per frame, tiny) | 1–2 | main thread |
| Orbit/spin transform update | <0.5 | CPU |
| Headroom | 2–3 | — |

**Non-negotiables (master plan Part 8.3):** meshing off the main thread; nothing heavy on the JS main thread; transfer (don't copy) buffers; cap chunks-per-frame; generate ahead of motion. **Chunk *generation* is not in the frame budget** — only finished-mesh upload is, spread across frames. If generation ever blocks a frame, that's the bug.

Measure from Step 0: keep a frame-time graph on screen. Treat any sustained spike as a stop-and-fix, not a "later."

---

## 8. Risk list (what's most likely to go wrong, and how to de-risk)

- **Descent stutter (the #1 risk).** Almost always the worker→main→GPU handoff, not the math. De-risk: transfer buffers (never copy); upload in small slices across frames; pre-generate ahead along velocity; profile Step 3 obsessively before adding anything else.
- **LOD cracks/seams between detail levels.** De-risk: ship skirts first (cheap, hides them); only invest in Transvoxel stitching if seams remain visible.
- **Precision jitter when far from origin.** De-risk: confirm the floating origin re-centres every frame and that *render* math is float-relative-to-camera while *world* math stays double (Part 5.1). Test by walking/flying a long way from spawn (Step 4 gate).
- **Time-angle precision drift over a long session.** De-risk: compute spin/orbit angle in double, modulo 2π, then float (Part 4.5).
- **WebGPU compute quirks / browser differences.** De-risk: keep meshing on workers (CPU) for the slice if GPU-compute meshing is fighting you — the slice's job is to prove the *experience*, and you can move meshing to GPU compute later for scale. (Determinism across GPUs isn't required yet — §1.)
- **Scope creep into later rings.** De-risk: the §1 "out" list is a hard line. The urge to add a second biome or terrain editing mid-slice is the project-killer; resist it.

---

## 9. What this unlocks (and the immediate next step)

Passing Milestone 0 means the engine is real. The very next ring (master plan Part 9, ring 1 — "Planet quality") is where the universe starts to become itself, and it's the first place the **Fact Generation Design** (companion doc) plugs in: replace the hand-set fact stub with the *physical* fact derivation (star + orbital distance → temperature → archetype), so planets get correct, varied identities — plus the archetype library that defeats sameness (master plan Part 2). The political/historical/relational facts come much later (frontier rings); the slice and ring 1 only need the physical layer.
