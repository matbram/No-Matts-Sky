# HANDOFF — No Matt's Sky (current build state)

> Read **`CLAUDE.md`** first (it's the build spec + guardrails). This file is the companion: **what is
> actually built right now, how to run/verify it, and what's next.** Last updated at commit `2227974`.
>
> **Authority:** the law lives in **`/design`** (7 docs). When they disagree, the order is
> **Constitution → master plan → slice spec** (`CLAUDE.md` §1). This handoff describes the *build state*;
> it never overrides those docs.

## 1. TL;DR — where we are
A real-scale (Earth = 6,371 km) procedurally-generated planet you can fly from orbit to the surface and
**walk on**, at a locked **60 fps**, with **seamless, pop-free CDLOD terrain** that "gets clearer" as you
descend (no popping/flicker). The vertical-slice core (CLAUDE.md Steps 0–4) is done, plus an extensive
LOD-quality pass (continuous distance-morph, speed/altitude-aware prefetch, always-resident coarse base,
analytic morph normals). **Remaining slice work: Step 5 (real spin/orbit — day/night, moving sun, moon
shadow, velocity-inheriting launch) and Step 6 (atmosphere LUT + triplanar materials + final 60fps lock).**

## 2. First 5 minutes (new session)
```bash
cd No-Matts-Sky
git checkout claude/eloquent-tesla-98njmv && git pull
npm install
npm test          # 6 suites: hash, noise, cubesphere, density, chunk, quadtree (golden/determinism)
npm run typecheck # tsc --noEmit
npm run dev       # open the printed localhost URL in a WebGPU browser (Chrome/Edge)
```
- Camera presets: **1** = orbit, **2** = mid, **3** = surface. **F** = walk, **G** = creative fly. Drag =
  orbit, scroll = zoom.
- To judge LOD behavior, open with **`?lodaudit`** and watch the console `[NMS audit]` lines (see §7).
- Headless screenshots + console (no human/GPU): `npm run shoot` → writes to `.shots/`
  (`QUERY='?lodaudit' npm run shoot mytag`). Uses Playwright + software WebGPU (SwiftShader).

## 3. Stack & repo facts
- **TypeScript** + **Three.js WebGPU** (`three@^0.184`, `import { WebGPURenderer } from 'three/webgpu'`,
  TSL shaders) + **Vite 7** + **Vitest 3** + **Playwright** (headless harness only). **Node ≥ 20.19**.
- Branch: **`claude/eloquent-tesla-98njmv`** (latest commit `2227974`, clean tree).
- Scripts: `dev`, `build` (`tsc --noEmit && vite build`), `preview`, `typecheck`, `test`, `test:watch`,
  `shoot` (`node scripts/shoot.mjs [tag]`).
- WebGPU init is **async** (`await renderer.init()`) and the loop uses `renderer.setAnimationLoop(fn)`.

## 4. Architecture — the load-bearing split
**`/src/core` is pure TypeScript with NO Three.js import** (unit-testable + future Rust/WASM port). All
canonical values use the pinned **PCG hash** with `Math.imul` + `>>> 0` (no `Math.random`, no float hashing).

| `/src/core` (pure) | role |
|---|---|
| `hash.ts` | PCG `pcg/pcg2d/pcg3d/pcg4d`, bit-identical determinism |
| `seedchain.ts` | coordinate → seed chain (MASTER_SEED + per-purpose salts) |
| `noise.ts` | gradient noise + fBm with **analytic derivatives** → `[value, dx, dy, dz]` |
| `density.ts` | `D(p) = R − |p| + fBm(dir·scale)·height` (+1 domain-warp); returns D **and** ∇D in one pass |
| `cubesphere.ts` | cube→sphere projection (6 faces), `wrapFaceUV` cross-face neighbour math |
| `quadtree.ts` | **`selectCut`** — LOD decision: split-by-projected-px, horizon/cone cull, `baseDepth` pin, prefetch, backfill |
| `surfacenets.ts` | Surface Nets mesher: 1 vertex/sign-changed cell, analytic normals, **morph targets + morph normals** |
| `chunk.ts` | `meshChunk`: 2-pass column-cache; per-corner density + `cornerNormal` + `cornerMorphNormal`; apron + conditioned skirts |
| `constants.ts` | real radii (Earth 6.371e6, Moon 1.737e6, Mars 3.39e6 m) |
| `facts.ts` | `PlaceFacts` schema + the slice's single barren planet (coordinate-seeded) |

| `/src/render` (Three.js) | role |
|---|---|
| `scene.ts` | render shell: WebGPU renderer, camera presets, floating-origin recentre, recut logic, prefetch/telemetry, all `?`-flags |
| `quadtreeManager.ts` | streaming state machine (pending→inflight→ready→live→purged), worker pool, per-frame GPU upload budget, TSL `positionNode`/`normalNode` morph wiring, all `[NMS …]` logging |
| `player.ts` | character controller: walk/fly, ground collision via analytic `surfaceAt` probe |
| `stats.ts` | FPS / frame-time overlay (turns red < 55 fps) |
| `main.ts` | entry: WebGPU gate + animation loop |
| `/src/workers/mesher.worker.ts` | off-thread meshing; returns mesh via **buffer transfer** (not copy) |

## 5. What's DONE (slice steps + polish)
- **Step 0** static cube-sphere @ real Earth scale, orbit camera, FPS overlay, golden test. ✅
- **Step 1** density field + Surface Nets on a worker, analytic normals. ✅
- **Step 2** quadtree LOD across the whole sphere, apron kills same-LOD cracks. ✅
- **Step 3** async streaming: worker pool + per-frame GPU upload budget + generate-ahead. ✅
- **Step 4** floating origin + walking: character controller, ground collision, creative fly. ✅
- **LOD-quality pass (post-Step-4 polish — NOT slice Steps 5/6):** CDLOD per-vertex **distance morph** (replaces time morph); **birth-ease**
  so late-arriving leaves fade up from the parent; **speed-aware + altitude-relative prefetch** so detail
  leads its band at any height; **always-resident coarse base** (depth-2, 96 leaves, never culled) so nothing
  pops over the backdrop; **analytic morph-target normals** so a fully-morphed leaf shades like its coarse
  neighbour (killed the bright "square"); **time-based recut floor** so slow descents track continuously;
  **`?lodaudit`** diagnostics. ✅ (commits `8116239`, `2e0205a`, `b9d5dec`, `257c825`, `b7d8e02`, `d231820`,
  `e13cdf7`, `2227974`.)

Measured-good on WebGPU (build the user ran): orbit→surface descent holds 60 fps / ~16.8 ms,
`cov=96/96 holes=0` throughout, `fresh=0 refine=N` (sharpen-in-place, no pop), `bornM≈1.0`, largest cut ~466
leaves (no spike), no rAF `[Violation]` stalls.

> **Gate honesty:** the determinism half (golden tests, typecheck, build) is verified headless in CI; the
> *visual* gates — seamless sphere, no-jitter walk far from spawn, locked 60 fps, reload→identical planet —
> are confirmed in a real **WebGPU** browser, not headless (software WebGPU/WebGL2 only checks correctness).
> The ✅ above means "implemented + confirmed in this build's session"; re-confirm the visual gates on a real
> GPU after any change.

## 6. What's NEXT (pick up here)
1. **GATED: residual cross-LOD seam.** A one-level (`maxNbrΔ=1`) T-junction where the always-resident depth-2
   base meets a depth-3 cell shows `seam[gap≈21 m @f4d2·d3]` — sub-pixel from altitude, so it's **gated on
   actually seeing a thin line on WebGPU**. If visible, the planned watertight fix (NOT yet implemented):
   - **`balanceCut`** in `core/quadtree.ts`: force-split any leaf whose edge-neighbour (incl. cross-face via
     `wrapFaceUV`) is >1 level coarser, to a fixpoint → every cross-LOD edge is exactly one level.
   - **per-vertex `edgeMask`** in `surfacenets.ts`/`chunk.ts`: flag which boundary rows a vertex lies on
     (account for the apron). *(Golden mesher digests will regenerate — expected; re-run determinism guards.)*
   - **edge-locked morph** uniform in `quadtreeManager.ts`: force `effMorph=0` on those edge verts so they sit
     on the coarse neighbour's edge line (watertight under 2:1 balance), updatable without re-meshing.
   - Cheap fallback: flip conditioned skirts on by default (currently behind `?skirt`).
   - Hooks already present: `maxNeighborDelta()` measures imbalance; a code comment notes "CDLOD will need
     balanceCut".
2. **Step 5 — real spin/orbit** (CLAUDE.md §5/§7): planet rotates (day/night from real spin), orbits a visible
   Sol (sun moves over the orbit), Moon casts a **real shadow**, and surface→orbit launch **inherits the
   planet's velocity** (it doesn't rocket away). Compute spin/orbit angles in **double, mod 2π, then cast to
   float**; Kepler via Newton–Raphson, eccentricity capped 0.8. See master plan Parts 4 & 5.
3. **Step 6 — atmosphere LUT + triplanar materials + lock 60fps** end-to-end (all of CLAUDE.md §7 at once).

## 7. Reading the diagnostics (`?lodaudit`) — how to judge LOD health
- `[NMS] cut: leaves=N lod={depth:count} maxNbrΔ=k` — the live cut. **`maxNbrΔ>1`** = a >1-level edge step →
  `balanceCut` territory.
- `[NMS morph] live= midDist= m[min/avg/max]= bornM[avg/min]= approach= prefetch= fresh= refine= reqLat= near[…]`
  — **`bornM≈1`** = leaves born at the parent surface (no pop); **`fresh`** = visible pops the morph couldn't
  hide (want ~0 on gradual descent); **`refine`** = hidden ancestor↔descendant swaps (good); `approach` =
  m/s toward center; `prefetch` = lead distance (km).
- `[NMS audit] seam[Δeff max/avg gap=…m @fFdA·dB] cov=N/96 holes= histM[…] cut[Δt +N] stream[p i r L busy/T] pf/band=`
  — **`seam gap`** = rendered cross-LOD gap in metres (≈0 = watertight); **`cov/holes`** = backdrop showing
  through (want `96/0`); **`histM`** = morph distribution buckets `[<.1/.1–.3/.3–.7/.7–.9/>.9]` (smooth spread
  = graded, bimodal = boundary steps); **`stream`** = pending/inflight/ready/live + worker busy + ms/leaf;
  **`pf/band`** = prefetch ÷ morph-band width (want >0.1 at altitude).
- `[NMS pop] fresh=N depth=a..b` — fires when leaves appear over the backdrop (the residual pop).

Key tunables in `scene.ts`: `BASE_DEPTH=2`, `PREFETCH_MAX_FRAC=0.35`, `PREFETCH_FLOOR_M=3000`,
`PREFETCH_CEIL_M=200000`, `PREFETCH_S=0.7`, `RECUT_MAX_MS=400`, `RECUT_MIN_MOVE_M=1`, `MORPH_START_FRAC=0.55`,
`maxDepth=15` (~9.5 m cells). Debug flags (URL query): `?lodaudit ?lodmorphdebug ?morphcolor ?wire ?lodcolor
?skirt ?skirtcolor ?noback ?dark ?webgl ?clipdebug ?nolog ?revz`.

## 8. Guardrails (from CLAUDE.md §4 — do not break)
- `/core` never imports Three.js. Core is **deterministic** (pinned PCG; `Math.imul`/`>>>0`; no `Math.random`).
- World/body positions in **double**, render positions in **float** via a **floating origin** recentred each
  frame. Never feed large doubles to the GPU. Time-driven angles: double → mod 2π → float.
- Meshing stays **off the main thread**; pass buffers by **transfer**; cap chunks/frame; generate ahead.
- **60 fps is a continuous gate**, checked every step (FPS overlay on screen since Step 0).
- Add/extend a **golden test** whenever you add a core generation function.

## 9. Tests
`npm test` → `src/test/{hash,noise,cubesphere,density,chunk,quadtree}.test.ts`. Golden/determinism via
`toMatchInlineSnapshot` + FNV-1a digest (`src/test/digest.ts`). These are **frozen** — if a golden value
changes, the generation pipeline drifted (and the future Rust port would diverge); only re-bless
deliberately (e.g. the planned `edgeMask` change will legitimately regenerate mesher digests).
