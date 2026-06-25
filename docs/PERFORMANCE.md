# Performance notes & optimization backlog

A living reference so future optimization is a **lookup, not a re-discovery**. It
records where time goes, what's already optimized, and the backlog of deferred wins
with their expected payoff and tradeoffs. Update it whenever you profile or change
the hot path.

---

## 1. Frame budget (the target)

60 fps = **16.67 ms/frame** (master plan Part 8.1, slice spec §7). The hard rule:
**chunk generation is NOT in the frame budget** — it runs on the worker pool; only
the tiny per-frame mesh *upload* counts. If generation ever blocks a frame, that's
the bug.

| Work | Budget | Where |
|---|---|---|
| Render pass (geometry, lighting, post) | 6–8 ms | GPU |
| Finished-chunk GPU upload (per frame, capped) | 1–2 ms | main thread |
| Cut re-evaluation (`selectCut`) on movement | <1 ms | main thread |
| Player physics / transforms | 1–2 ms | CPU |
| Headroom | 2–3 ms | — |
| **Chunk generation (density + Surface Nets)** | **off-budget** | worker pool |

## 2. Where the time actually goes

The cost center is **meshing a leaf** (`core/chunk.ts` → `core/density.ts` +
`core/surfacenets.ts`), run on the worker pool. The HUD shows `ms/leaf`. Before the
first optimization pass it was ~31 ms/leaf; the dominant cost is the noise
(`fbm` × octaves × `gradNoise3`) sampled across the chunk grid.

**How to profile (in-browser HUD, top-left):**
- `ms/leaf` — average worker time to mesh one leaf. The number to watch.
- `queue` — leaves waiting to mesh/upload. Should drain to ~0 quickly after moving.
- `busy` — workers currently meshing.
- Frame time / fps line — turns **red** if a frame exceeds 16.67 ms.
Good state: `ms/leaf` low single digits, `queue` near 0 while moving, fps green.

## 3. Optimizations implemented

| # | Optimization | Where | Gain |
|---|---|---|---|
| 1 | **Per-column noise cache.** Terrain noise is direction-only, so evaluate `terrainAt` ONCE per (u,v) column and reuse it for all radial layers (was recomputed per 3D corner). | `core/chunk.ts` `meshChunk` (two-pass), `core/density.ts` (`terrainAt` + `assembleDensity`) | **~13×** meshing |
| 2 | **Corner normals.** Normals come from the per-corner analytic gradient (already computed), averaged to vertices — no per-vertex field re-evaluation. | `core/surfacenets.ts` (`cornerNormal` input) | removes per-vertex `densityAt` |
| 3 | **`selectCut` bounds table.** Per-depth conservative bounding-radius table → 1 `faceDirection`/node instead of 5. | `core/quadtree.ts` `BOUND_FACTOR`, `nodeBounds` | cheaper re-cut |
| 4 | **Cosine culling.** Horizon/cone culls compare cosines (camera-constant trig precomputed once per cut) instead of `acos`/`asin` per node. | `core/quadtree.ts` `overHorizonCos`/`outsideConeCos` | cheaper re-cut |
| 5 | **Reused mesh scratch.** `meshChunk` reuses per-worker intermediate buffers (≈1 MB/leaf) instead of allocating per call → less GC. | `core/chunk.ts` (`fit` + module scratch) | fewer GC hitches |
| 6 | **Non-allocating hash.** `pcg4dInto` writes into a scratch array (no 4-tuple per sample). | `core/hash.ts`, `core/noise.ts` | fewer allocs on hot path |
| 7 | **Worker pool + per-frame upload budget + nearest-first + generate-ahead.** | `render/quadtreeManager.ts`, `render/scene.ts` | parallel fill, no frame spikes |
| 8 | **Deferred LOD removal + inset backdrop.** Old leaves kept until replacements are live; a single inset backdrop sphere fills any residual gap → no black/holes. | `core/quadtree.ts` `retainedShouldRemove`, `render/*` | invisible pop-in |
| 9 | **Geometry LOD morph (single opaque surface).** New leaves are born at a one-octave-smoother surface and morph to full detail over ~0.35 s — a per-vertex `morphTarget` attribute lerped to `position` by a per-leaf TSL morph uniform 0→1. Unlike a dithered/alpha cross-fade, only ONE opaque surface is ever on screen, so there is no stipple/terracing and no skirt see-through (the earlier `alphaHash` fade drew seams by blending two different surfaces). The morph target is `fbm3`'s value minus its finest octave — captured free in the same pass and a pure function of direction, so neighbours agree exactly and the morph opens no seams mid-transition. Retained leaf kept until the replacement's morph *completes*; morphing leaf gets a camera-ward `polygonOffset` to win depth over it. | gradual detail, no snap, no seams |
| 10 | **Logarithmic depth buffer.** `WebGPURenderer({ logarithmicDepthBuffer: true })` (default on; `?nolog` to disable, `?revz` to try reversed-Z). At real scale the near:far ratio is ~1:30, so plain float32 depth resolves only ~1 m near the surface and the apron-overlap + skirt geometry z-fought into thin seam lines at every leaf/cube-face boundary — the classic real-scale-planet depth problem (Cesium/Outerra hit the same). Log depth redistributes precision across the whole range and clears the z-fighting in both backends; small per-fragment cost, 60fps-fine. (Reversed-Z is the cheaper variant of the same idea, but its Three r184 WebGPU path is buggy — it dithered the inset backdrop through the terrain in big patches — so it's opt-in only.) Diagnosed with `scripts/shoot.mjs` (headless screenshots): seams prominent under WebGPU, faint under WebGL2 — a depth-precision tell, not geometry. | no boundary seam z-fighting |

> Determinism note: #1 changes leaf positions only at the sub-micron (float
> roundoff) level — it uses the exact `faceDirection` rather than re-normalizing
> `dir·radius` — and #2 changes vertex normals (corner-averaged vs analytic-at-
> vertex). Both are visually identical; the recorded mesh digests were refreshed.
> The canonical PCG hash and the terrain *values* are unchanged.

## 4. Deferred backlog (ranked; each is a future lookup)

| Optimization | Expected gain | Tradeoff / why deferred | Where |
|---|---|---|---|
| **2-octave domain warp** (warp offset doesn't need 4 octaves) | ~1.6× meshing | **Changes terrain appearance** (re-tune) | `core/density.ts` `terrainAt` (3 warp `fbm3` calls) |
| **Gradient-table noise** (replace per-corner gradient `normalize` — 8 `sqrt`/call — with a ~16-entry table) | ~20–30% of `gradNoise3` | **Changes terrain appearance** + small risk of faint grid-aligned streaks (use the standard 12-gradient set); the current random-normalized gradients are marginally more isotropic | `core/noise.ts` `gradNoise3` (line ~74) |
| **LOD hysteresis** (split at `splitPx`, merge at ~`0.5·splitPx`) | avoids re-mesh thrash when the camera drifts near a threshold | low impact now (deferred removal hides any flash; only wastes CPU) | `core/quadtree.ts` `selectCut` (needs previous cut) |
| **Packed-integer node address** (face<<bits \| depth \| path-bits) | removes path-array copies + string Map keys in `selectCut`/`chunkKey` | moderate refactor across quadtree + manager | `core/quadtree.ts`, `core/chunk.ts` |
| **Surface Nets typed-array output** (preallocate to an upper bound, `subarray`) instead of `number[]` + `.from()` | marginal (small vs noise) | loose upper bound wastes memory; marginal after #1 | `core/surfacenets.ts` |
| **Worker recipe-cache** (send the recipe once, not per job) | marginal (recipe is tiny) | protocol churn for little gain | `render/quadtreeManager.ts`, `src/workers/mesher.worker.ts` |
| **fBm normalization constant** (closed form per recipe vs running sum) | marginal | risk of changing noise output (avoid) | `core/noise.ts` `fbm3` |
| **Draw-call reduction** (merge/instance leaves; currently ~hundreds of draws) | scales to denser detail / weaker GPUs | needs a batching/atlas scheme; per-leaf meshes are simple for streaming | `render/quadtreeManager.ts` |
| **GPU-compute meshing** — the real next tier: run the density field + Surface Nets in a WGSL compute shader (master plan §8.3) | large (orders of magnitude headroom) | big architectural change; spec says keep meshing on workers for the slice, move to GPU for scale. Canonical occupancy must stay deterministic (fixed-point) if it drives gameplay | `core/*` → `render/*` compute path |

## 5. Determinism constraint (what may/may not change)

Per the Constitution (II.14) and master plan Part 0: the **canonical** values must
stay bit-identical across machines once the universe is live —
- **Must not drift:** the PCG hash, terrain *values* / biome & fact *threshold
  decisions*, and (later) edit-resolution occupancy. Use integer/fixed-point for
  canonical decisions.
- **May drift (cosmetic):** exact vertex normals, sub-voxel/sub-micron positions,
  render-only LUTs, particles. The optimizations above only touch cosmetic outputs.

When changing the noise (deferred #2/#3), treat it as a recipe change: it alters
every planet's appearance, so it must land **before** the recipe is frozen for a
live shared universe (master plan Part 1.3).

## 6. The dials (quick reference)

| Dial | File | Current | Effect |
|---|---|---|---|
| Chunk grid (tangential / radial) | `core/chunk.ts` | 32 / 12 | detail vs mesh cost per leaf |
| `splitPx` | `render/scene.ts` | 300 | LOD aggressiveness (smaller = finer/earlier) |
| `maxDepth` | `render/scene.ts` | 10 | finest leaf / leaf-count cap |
| Cull margin | `render/scene.ts` | 1.2 | pre-mesh ring width (smaller = shallower queue) |
| LOD morph duration (`MORPH_MS`) | `render/quadtreeManager.ts` | 350 ms | how gradually detail resolves in |
| Worker pool size | `render/quadtreeManager.ts` | `min(6, cores−1)` | parallel meshing throughput |
| Upload budget / frame | `render/scene.ts` | 4 | meshes added to GPU per frame |
| Generate-ahead | `render/scene.ts` | velocity × 30 frames | pre-mesh along motion |
| Terrain recipe (scale/height/octaves/warp) | `core/density.ts` | 140 / 14 km / 4 / 0.7 | terrain look ([T] tunable) |
