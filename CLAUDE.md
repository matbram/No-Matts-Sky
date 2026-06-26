# CLAUDE.md — Build Handoff

You are starting work on a real-scale, real-physics, procedurally-generated space exploration game. This file orients you and tells you exactly what to build first. **Read it fully before writing any code.**

There is a complete design corpus (seven documents, ~2,300 lines) in this repo's `/design` folder. **You do not need to build everything in it now — and you must not try.** The corpus describes the whole universe; your job right now is the **vertical slice** (one planet, real scale, fly from orbit to surface, walk, real rotation + orbit, 60fps). Everything else is a later ring grown onto that proven core.

> **For the *current* state of the build (what's already done, how to run/verify it, and what's next), read [`HANDOFF.md`](HANDOFF.md) first.** This file (CLAUDE.md) is the forward-looking spec; HANDOFF.md is the backward-looking status companion.

---

## 0. The prime directive: ruthless scope

Build the **vertical slice**, and build it in the **sub-steps defined in `design/vertical-slice-build-spec.md`, Step 0 first**, each gated before moving on. Do **not** add anything outside the slice's scope (no multiplayer, no terrain editing, no multiple biomes, no creatures, no lore, no galaxy, no tech tree, no aliens). Those are real and designed — but they are *not now*. If you find yourself reaching for them, stop: that's the project-killer.

The slice doubles as the game's **prologue** (an alien craft crashes to Earth → you build one ship → fly from real-scale Earth to the real-scale Moon), but the prologue *story* is not part of the slice's engineering goal. The engineering goal is the bulleted acceptance criteria in §7.

---

## 1. The design documents (read in this order, consult as needed)

Authority hierarchy: **the Constitution is the final authority on what the universe is; the master plan is how it's built; the slice spec is what you build now.** Where docs disagree, the Constitution wins.

| Doc | What it is | When to read |
|---|---|---|
| `design/vertical-slice-build-spec.md` | **What you build now**, step by step, with gates | **First, in full** |
| `design/canonical-generation-pipeline.md` | **The formula, end to end** — the pinned PCG hash (exact WGSL+TS code), the seed chain, the ordered generation sequence with every formula, and the determinism rules. Your implementation reference for `/core` | **With the slice spec; the §6 subset is all the slice needs** |
| `design/nms-class-universe-architecture-and-plan.md` | The master plan: architecture & math. Parts 0 (decisions), 4 (frames/orbits/streaming), 5 (the math), 8 (60fps budget) are directly relevant to the slice | **Parts 0/4/5/8 now**, rest as reference |
| `design/universe-constitution.md` | The foundational law. Read Part I (principles) and the **[S] structural** dials — these are the rules you must not break | **Skim now**, return for rules |
| `design/gameplay-and-progression-design.md` | What the game *is* to play (crash, tech spine, verbs, travel) | Context only; not built in the slice |
| `design/fact-generation-design.md` | How a coordinate becomes a specific world (the "why") | Ring 1, not the slice |
| `design/lore-content-pack.md` | Deterministic prose generation | Much later |
| `design/design-coverage-and-gaps.md` | What's designed vs. still to design (roadmap) | Orientation only |

---

## 2. Tech stack (web-first, decided — master plan Part 0 & 10)

- **Language:** TypeScript.
- **Renderer:** Three.js **WebGPU** renderer (`import { WebGPURenderer } from 'three/webgpu'`) with **TSL** (`three/tsl`) for shaders. Production-ready since r171 (Sept 2025); **use a current release (r184+** — it removed per-frame allocations that hurt GC/framerate). WebGL fallback is automatic and not a slice concern. **Two gotchas that waste hours:** (1) `WebGPURenderer` init is **async** — you must `await renderer.init()` before the first render, or you get a blank screen with *no error*; (2) use `renderer.setAnimationLoop(fn)`, not `requestAnimationFrame`, so async GPU/compute work synchronizes correctly.
- **Build/dev:** Vite.
- **Concurrency:** Web Workers run the generation core off the main thread.
- **Tests:** Vitest, for the golden/determinism test (see §4).
- **Node:** 20+.

**The generation core is TypeScript for now, deliberately.** The shared universe will eventually need a deterministic Rust core compiled to WASM + native + server (master plan Part 0, Decision 1a). For the slice (single-player, no shared universe yet), strict cross-platform bit-identity is **not** yet required — TS is correct for fast iteration. But keep the core small, pure, and tested (§4) so the eventual Rust port is mechanical, not a redesign.

---

## 3. Project structure (create this)

The single most important architectural rule: **separate the headless generation core from the Three.js render shell** (master plan Part 0). The core must run with *no* Three.js imported — that's the test that you've split it correctly, and it's what makes the core unit-testable and portable.

```
/design                <- the seven design docs (reference)
/src
  /core                <- GENERATION CORE. Pure TS. NO three.js import, ever.
                          hash, noise/fBm/domain-warp, density field,
                          cube-sphere projection + quadtree math,
                          Surface Nets mesher, PlaceFacts stub
  /render              <- THREE.JS SHELL. renderer, materials, atmosphere,
                          chunk manager, worker pool, frame system,
                          floating origin, player controller, game loop
  /workers             <- worker entry points that import from /core
  /test                <- golden tests over /core outputs
/index.html
/vite.config.ts
```

If anything in `/render` ends up imported by `/core`, that's a bug in the architecture — fix the boundary, don't paper over it.

---

## 4. Non-negotiable guardrails (distilled from the [S] structural decisions)

These are the rules the whole foundation rests on. Breaking one quietly breaks the project later. Do not violate them, and flag (don't guess) if a task seems to require it.

**Architecture**
- The `/core` ↔ `/render` separation above is absolute.
- The generation core is **deterministic**: same inputs → same outputs, always. Use the **pinned PCG hash** (`pcg`/`pcg2d`/`pcg3d`/`pcg4d`) for any canonical value — exact code, in both WGSL and TypeScript, is in `design/canonical-generation-pipeline.md` §1. In TS you **must** use `Math.imul` for every 32-bit multiply and `>>> 0` to stay in u32, or the core won't be bit-identical to the GPU/future-Rust versions. No `Math.random()` in the core. No `sin`-based/float hashing for canonical values.
- Write a **golden test from early** (`/test`): a fixed set of inputs → recorded outputs; fail the build if outputs change unexpectedly. This is what will later prove the Rust port matches.

**Precision & frames (master plan Part 4 & 5 — this is subtle and load-bearing)**
- World and body-fixed positions in **double precision**; **render** positions in **float**, via a **floating origin** re-centred on the player every frame. **Never feed large doubles to the GPU.**
- Real scale: Earth **6,371 km**, Moon **1,737 km**, Mars **3,390 km**; real orbital elements. Real scale costs nothing extra to render (you only build what's near the camera).
- Time-driven angles (spin/orbit): compute in **double, take modulo 2π, then cast to float** — or you get precision drift over a session.
- Kepler solver via Newton–Raphson; cap eccentricity at **0.8** (stability).

**Performance (master plan Part 8 — a continuous gate, not a final polish)**
- **60fps = 16.67 ms/frame** is checked at *every* step. Keep a frame-time readout on screen from Step 0.
- Mesh generation runs **off the main thread** (workers). **Chunk generation is NOT in the frame budget** — only the tiny per-frame upload of finished meshes is, and that's spread across frames.
- Pass mesh buffers to the main thread by **transfer, not copy**.
- **Cap chunks generated per frame** (start 2–4) and generate *ahead* along the camera's velocity vector.
- Keep draw calls low (instancing for repeated objects later).

**Meshing & terrain (master plan Part 3 & 5)**
- Planet = **cube-sphere** (6 faces) → **quadtree** per face → leaves meshed via **Surface Nets** (not Marching Cubes; Dual Contouring only later if sharp features need it).
- Hide LOD-boundary cracks with **skirts** first (cheap); only invest in Transvoxel stitching if seams remain visible.
- Density field (one archetype for the slice): `D(p) = planetRadius − |p| + fBm(normalize(p)·scale)·height`, plus 1 domain-warp iteration; compute **analytic normals** (value + gradient in one pass), don't triple-sample.

**Data model (even in the slice)**
- Derive the planet's seed from a **coordinate**, and key the (hand-set) `PlaceFacts` stub by it — match the field names in `fact-generation-design.md` / `lore-content-pack.md` exactly, so the real fact system slots in later with no rework.
- Store nothing you can recompute. (The slice has no persistence/Memory layer — that's a later ring.)

---

## 5. The build order inside the slice (Step 0 → 6, each gated)

Full detail with acceptance gates is in `design/vertical-slice-build-spec.md` §6. Summary:

0. **Static cube-sphere** at real Earth scale, camera orbits it (no noise). *Gate: seamless sphere, smooth orbit, 60fps.*
1. **Density field + Surface Nets** on one chunk, on a worker, correct normals. *Gate: correct lit terrain patch, meshed off-thread.*
2. **Quadtree LOD** across the whole sphere. *Gate: seamless orbit→surface detail, no cracks (skirts), correct LOD selection.*
3. **Async streaming** (the hardest, most important step): chunk manager + worker pool + per-frame GPU upload; fly orbit→surface continuously. *Gate: zero hitches, frame time never exceeds 16.67 ms.*
4. **Frame system + walking**: floating origin + body-fixed frame; character controller; collision; gravity to planet center. *Gate: walk far from spawn with no jitter.*
5. **Real orbit + spin**: planet rotates (day/night) and orbits visible Sol; Moon casts a real shadow; surface→orbit launch inherits velocity. *Gate: visible day/night from spin; sun moves; moon shadow; planet doesn't fly away on launch.*
6. **Atmosphere LUT + triplanar materials + lock 60fps** end-to-end. *Gate: all of §7 passes at once.*

---

## 6. Your first task (start here, now)

**Step 0.** Scaffold the project (Vite + TS + Three.js WebGPU), create the `/core` ↔ `/render` split from §3, and render a **static cube-sphere at real Earth scale (6,371 km)** that a free-fly (orbit) camera circles smoothly. Put a **frame-time / FPS readout** on screen from this very first commit. No noise, no LOD, no streaming yet — just prove the projection and the WebGPU render pipeline.

Concretely:
- `core/cubesphere.ts`: project a subdivided cube onto a sphere of a given radius; expose a function that returns vertex positions for a face at a given subdivision (pure, no Three.js).
- `render/scene.ts`: a WebGPU renderer, a camera with orbit controls, and a mesh built from the core's cube-sphere output, sized to Earth's radius (handle the scale via camera distance + near/far planes; this previews the floating-origin need but doesn't require it yet).
- `render/stats.ts`: a frame-time overlay.
- `test/cubesphere.test.ts`: a golden test — fixed subdivision → recorded vertex hash; fail on change.

**Gate for Step 0:** the sphere has no gaps at the cube-face seams, the camera orbits smoothly, the golden test passes, and it holds 60fps. When that's true, commit, then proceed to Step 1 per the slice spec.

---

## 7. Definition of done for the whole slice (all must hold at once)

- Orbit→surface descent: **zero hitches, frame time < 16.67 ms throughout**.
- **Day/night from real rotation**; the sun's position changes over an orbit; the Moon casts a real shadow.
- Launch from the surface **inherits the planet's velocity** (the planet doesn't rocket away).
- Walking far from spawn shows **no precision jitter**.
- Reloading **regenerates the identical planet** (determinism; pre-tests the golden test).
- All at a **locked 60fps** on a target desktop GPU.

---

## 8. How to work

- **Read the relevant design section before building each step**, not just this file — the slice spec and master plan Parts 4/5/8 contain the detail and the traps.
- **Commit per gated step.** Don't move to the next step until the current gate passes.
- **Profile Step 3 (streaming) obsessively** — it's where 60fps is won or lost; the usual culprit is the worker→main→GPU handoff, not the math.
- **Keep the core pure and tested.** Every time you add a generation function, add/extend its golden test.
- **When a task seems to require breaking a §4 guardrail, stop and flag it** with the specific rule and why — don't silently work around it. The guardrails encode decisions that are expensive to reverse later.
- **Don't reach outside the slice scope** (§0). The design corpus will tempt you; resist it.

The vision is enormous, but the path is incremental and proven-as-you-go. Get Step 0 holding 60fps, and you've started the real thing.
