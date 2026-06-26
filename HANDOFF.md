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
| `terrainMaterial.ts` | the **ONE shared** terrain material (`createTerrainMaterial`): per-vertex CDLOD geomorph (position+normal, from `aLodR`/`aParentR` attrs + shared `kDist`) **and** distance-faded surface detail (slope bands + procedural `mx_noise` detail, faded by `1−mFinal`); `detailPhaseOf` = renderOrigin mod L (double) for swim-free, precise detail coords |
| `quadtreeManager.ts` | streaming state machine (pending→inflight→ready→live→purged), worker pool, per-frame GPU upload budget; fills per-leaf `aLodR`/`aParentR` + renders every leaf with the shared material (clones only for debug tints), feeds the material's origin/detail-phase uniforms, all `[NMS …]` logging |
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
- **Gradual visual-transition pass ("plane approaching Earth" — this session, branch
  `claude/lod-visual-transition-audit-jeq2fz`):** (1) tuned for continuity — `MORPH_START_FRAC` 0.55→0.30
  (wider fade band), `RECUT_MAX_MS` 400→200 (leaves trickle, not batch), `PREFETCH_S` 0.7→1.0 (born at the
  parent surface); (2) **one shared material** (`terrainMaterial.ts`) — the per-leaf morph node-graph clone is
  gone (per-leaf data → `aLodR`/`aParentR` attrs), and the **time-based birth-ease was removed** (it faded a
  recut's batch in as a synchronized "wave"; the per-vertex distance morph alone carries leaves in now); (3)
  **distance-faded surface detail** — slope material bands + procedural `mx_noise` detail (coarse ~40 m, fine
  ~6 m) whose strength fades in with proximity on the morph's own schedule (`1−mFinal`) + per-octave
  anti-alias gates, so the surface gets *clearer* as you descend (no more flat grey) with no discrete
  arrival/shimmer. Detail coord = render-space pos + `renderOrigin mod 100 km` (double) → swim-free + precise.
  Render-only (no core/golden change); typecheck + 76 tests + build green; headless WebGL2 renders the planet
  seamlessly. ⚠️ **Visual tuning of detail strengths/colours/ranges is a real-GPU pass (headless is too dark to
  judge);** confirm the §7 visual gates on WebGPU. (commits `b05989d`, `86077dc`, `17c554d`.)
- **Root-cause pop fix — gated incremental refinement (same session/branch):** the residual zoom pop was
  architectural, not a tuning miss. The cut was computed atomically from the instantaneous camera distance and
  ALL deep leaves requested at once, so a hard zoom jumped a region depth-2→depth-6+ in one recut with the
  intermediate levels (3,4,5) never built — the deep leaf then arrived over a 4-levels-coarser surface, an
  unmorphable jump the per-vertex CDLOD morph (one-level only) can't hide = the pop. Fix:
  **`clampCutToReachableFrontier`** (pure, `core/quadtree.ts`) caps the *requested* cut so no region goes deeper
  than `(deepest live covering leaf)+1`; the detail front then descends ONE level per recut generation — every
  shown transition is a single morphable level whose parent is already live, and refinement self-paces to
  streaming (can't request N+1 until N is live). It gates only *refinement*; merge-up/coarsening is detected
  (a live descendant-or-equal exists) and passed through unclamped (else zoom-out flickers to base and
  re-climbs). Wired in `quadtreeManager.update()` as `balanceCut(clamp(balanceCut(selectCut(…))))` — the second
  balance fills the depth-3 staircase ring the clamp leaves beside the always-live base (one-past-base =
  in-frontier, appears over a live ancestor). A **recut-while-refining gate** (`manager.isRefining()` →
  `refineRecut` in `scene.ts`) keeps generations firing while the front climbs even when the camera is
  stationary (a hard-zoom-then-stop would otherwise freeze one level in), and stops once settled. `BIRTH_MS`
  150→**500** so each level's added octave fades up (continuous "getting clearer") instead of switching on.
  Headless `?lodaudit` on an instant orbit→surface jump: cut climbs `2→3→4→5→6→7` incrementally, **`fresh=0`**
  (no backdrop pops, was the symptom), `churn≈2/s`, draws bounded ~110. Pure-core clamp has its own golden/
  unit tests (8 cases); 87 tests + typecheck + build green. ⚠️ Real-GPU confirm: zoom in AND zoom-then-stop —
  detail should sharpen continuously with no pop or "generations." One known **transient `maxNbrΔ=2`** at a
  cube-face *corner* during the fastest climb (a `balanceCut` cross-face corner-probe limitation, pre-existing,
  not fixable by the re-balance; the 500 ms birth-ease masks it to ~1 level) — tiny/transient, not the pop.

- **Root-cause "generations" fix — parent-grid morph target (same session/branch):** after gated refinement
  killed the multi-level backdrop pop, a *steady* zoom still showed detail arriving in discrete steps "in both
  shape and texture." The `swapDelta` diagnostic (added to drive this, log-driven per the user) measured it on
  a real GPU: a child born at morph=1 differed from the parent leaf it replaces by **~17° normal / ~1 km, at
  EVERY refinement depth** (constant — fBm self-similarity). Cause: `meshChunk` baked the morph target as the
  one-octave-coarser field sampled on the CHILD's finer grid, while the parent leaf renders that field on its
  2×-coarser grid — so morph=1 resolved detail the parent can't, popping the normal each split (both lit shape
  and slope-band albedo are normal-derived ⇒ "both equally"). Fix: a **half-resolution parent-grid pass** in
  `meshChunk` samples the coarser field on the parent's grid (spacing 2×, anchored so the child's dyadic rect
  edges land on parent grid lines, +1 parent-cell apron) and bilinearly interpolates it to each child column →
  morph=1 IS the parent's bilinear surface (a true no-op swap). The morph value stays the oct-normalized
  `_tLo` (the shader does `mix(full, target, m)`, so m=1 must equal the baked target — NOT a fresh (oct-1)
  fBm). Morph normal becomes a per-column parent-grid bilinear (drops the per-corner `assembleDensity`).
  `surfacenets.ts` unchanged; base surface (positions/normals) **byte-frozen**; `morphTargets`/
  `morphTargetNormals` digests re-blessed. Seam-safe: morph target stays a pure function of direction, so the
  parent-grid bilinear collapses to the same shared 1D interp at any edge on a parent grid line (same-LOD,
  cross-face, and across-parent neighbours agree). `swapDelta` now reads `dNrm≈0.35° dPos≈57 m` (only the
  pre-existing ~1.6% `_tLo`-normalization residual) — pop removed. 91 tests + typecheck + build green.
  ⚠️ Real-GPU confirm: steady zoom — `[NMS step] swap[…]≈0` at all depths, detail "just gets clearer," no
  per-generation step. (A faint *static* sand/rock speckle, if any, is the separate slope-band threshold —
  deferred, optional shader softening; the user chose mesher-only first.) **Confirmed live** on the next
  build: `swap[dPos≈8–77m dNrm≈0.1–0.5°]` at every refinement depth, fresh=0, maxNbrΔ≤1.

- **Zoom-in throughput + slope-band looks (same session/branch):** the real-GPU `?lodaudit` log showed the
  parent-grid fix landed but the *descent itself* was laggy — `reqLat` climbing to ~700–870 ms with the
  worker pool pinned `busy6/6` and a 100–170 request backlog, i.e. **meshing throughput** at deep LOD (it
  settles instantly when motion stops). Fixes: (a) **recovered the parent-grid pass cost** in `meshChunk` —
  the interior parent points coincide *bitwise* with the odd child columns (verified `pu0+pdu·pi ==
  u0+du·(2pi−1)` at tan=16/32/64, depths 0–8), so reuse their already-computed `colTLo`/`colDir` and only
  evaluate the parent **perimeter** (~72 vs ~361 fBm/chunk, −18%); **bit-identical → all frozen goldens
  unchanged**, planet determinism preserved. (b) **Worker-pool default 6→10** (still clamped by cores−1) —
  `busy6/6` was the bottleneck. (c) **swapDelta audit made ~8× cheaper** (≤8 leaves × perAxis 2) so the
  `?lodaudit` diagnostic stops being the hitch it measures. Plus **`?slopeband=N`** (0 current / 1 wide /
  2 low-contrast / 3 soft) — render-only slope-band presets in `terrainMaterial.ts` to A/B the speckle look
  live and pick one. 91 tests + typecheck + build green.

- **Descent choppiness = GPU fill-rate, + zoom-out pop (same session/branch):** the close-up choppiness was
  *not* meshing throughput — a `?perf` vet (new `gpu/other` frame-budget breakdown) proved it: `gpu/other`
  was the whole frame, and **`?dpr=1`, `?nolog`, and `?nodetail` were each independently buttery** → the
  shader sits at the fragment/fill-rate cliff and any one reduction clears it. Two zero-quality-cost levers:
  (a) **terrain shader dropped to ONE procedural detail octave** — the two `mx_noise_vec3` evals (each per
  on-screen terrain pixel) were the bottleneck; the fine ~6 m octave only shows within ~6 km of the surface,
  so removing it halves the noise cost everywhere for a band rarely on screen (the ~40 m mottle stays). A
  per-fragment branch to skip noise at range needs TSL `Fn`/`If` (no build stack at material-construction
  time → "Cannot read properties of null (reading 'If')") — deferred; the unconditional halving is the robust
  win. (b) **default pixel-ratio cap 2→1.5** (`scene.ts`) — ~44% fewer fragments on a Retina display, sharp;
  1× displays unaffected; `?dpr=2` restores full sharpness, `?dpr=1` max perf. (commit `c04d178`.)
  Separately, **zoom-OUT was popping detail back in** instead of blurring out: a coarsening **merge target** (a
  leaf going live to replace finer live descendants) was getting the **birth-ease floor** like a fresh leaf,
  so it appeared at morph=1 — its own parent surface, one level *coarser* than the children it replaces —
  then re-sharpened over `BIRTH_MS`. Fix: detect a merge target (any live STRICT descendant on its face) and
  **backdate its birth clock past `BIRTH_MS`** so it shows at its true distance morph (≈0 = its own surface),
  seamlessly continuing the children at morph 1; refinement/cold loads keep the ease (the zoom-IN onset). The
  cut-level *symmetric coarsen gate* I'd planned was **dropped** — `clampCutToReachableFrontier` explicitly
  rejects gating coarsening (collapses to base + re-climbs = a worse flicker); coarsening stays morph +
  deferred-removal smoothed. Render-only, goldens unchanged. (commit `8f2b07c`.) ⚠️ **Real-GPU confirm:**
  `?perf` looking at / zooming the planet → `worstDt < 16.67 ms`, buttery (tune sharpness with `?dpr`); and
  zoom OUT → detail blurs out gradually with no "pops back in."

- **Locked-60 follow-up — noise-skip branch + clamp-before-balance (same session/branch):** the user's
  real-GPU `?perf` after the above showed a flat **~17.5 ms** (big improvement, but ~57 fps not locked 60)
  with two residual costs the log pinpointed. (a) **Idle fill-rate floor ~17.5 ms** at orbit: the one
  remaining `mx_noise_vec3` was still evaluated for every fragment even where its weight `wA=0`. The TSL
  `Fn`/`If` branch is now **unblocked** (an Explore of the r0.184 source confirmed `If` only needs an active
  `Fn` build stack — the earlier top-level failure was just the missing stack; the compiler emits a real WGSL
  `if`, so the noise is genuinely skipped). Gated the noise behind
  `Fn(() => { const out = vec3(0).toVar(); If(wA.greaterThan(0.001), () => out.assign(mx_noise_vec3(…))); return out; })()`
  — coherent per-leaf, negligible divergence; at orbit `wA≈0` everywhere → noise skipped → idle floor drops
  below budget. Render-only, goldens unchanged. (commit `9439567`.) (b) **Recut CPU spike ~10–17 ms during
  zoom** (the 19–20 ms frames while moving, at 360–427 leaves): the cut was
  `balanceCut(clamp(balanceCut(selectCut())))` — the FIRST `balanceCut` built the full ideal 2→11 staircase
  that the clamp then truncated to live+1, so we paid to balance discarded depth every recut. **Reordered to
  clamp-before-balance**: `clamped = clampCutToReachableFrontier(selectCut(), live); cut = balanceCut(clamped)`
  — the clamp truncates each region to live+1 independent of balance, and the single final `balanceCut`
  guarantees 2:1 balance regardless, so clamping first loses no balance and the single balance runs on a
  shallow (≤ live+1) cut. Pure core funcs unchanged (only the call order in `update()`); all 91 goldens
  unchanged. Headless `?lodaudit`: `maxNbrΔ=1` on every cut line, the front still climbs one level per
  generation `{2,3}→…→{2,3,4,5,6,7,8}`, `fresh=0` — gated incremental refinement fully preserved, just
  cheaper. (commit `8c3ef1f`.)

- **Locked-60 follow-up #2 — the idle floor IS the vsync cadence + numeric region keys (same session/branch):**
  the next real-GPU `?perf` reframed the problem. **The idle ~17.6 ms floor is the display/vsync cadence, NOT
  GPU cost** — proof: at idle (96 draws) `gpu/other≈17.6`, but at deep zoom (433 draws, *more* geometry)
  `gpu/other` *drops* to ~8 ms because the ~9 ms recut ate into it; GPU work can't fall as geometry rises, so
  most of the idle "17.6" is vsync idle-wait (the GPU has ~8 ms of work in a ~17.6 ms frame = large headroom).
  That's why **C1 didn't move the idle floor** (idle was never GPU-bound — C1 stays, it's correct and buys
  close-range headroom). **C2 helped the recut but didn't finish it** — still ~9–12 ms at 400–445 leaves
  (worst on zoom-OUT, where the clamp rebuilds `coverRegion` from all live leaves), the 18–21 ms worst-frames
  while zooming. Root cause: the hot cut Sets were keyed by freshly-concatenated **strings** (`coveringDepth`
  runs 12× per leaf per balance pass; clamp's `coverRegion` is O(live×maxDepth) prefixes rebuilt every recut)
  → ~10⁵ string allocations/recut = GC churn, not algorithmic work. Fix (**C3**): pack each region
  (face, path digits, depth) into a single JS-safe integer (`packRegion`, `< 2³⁷`, injective — depth encoded
  explicitly so `[]`/`[0]`/`[0,0]` never collide; `assertRegionDepth ≤ 15` guards a future `MAX_DEPTH` bump),
  Sets become `Set<number>`, and `coveringDepth` builds the key incrementally (no per-level alloc). Converted
  `balanceCut`/`coveringDepth`/`maxNeighborDepth`/`maxNeighborDelta`/`clampCutToReachableFrontier`/`selectCut`
  backfill in `src/core/quadtree.ts`. **Byte-identical cuts** — all 91 tests pass unchanged (the bit-identical
  gate); headless `?lodaudit` is identical to C2 (`maxNbrΔ=1`, same leaf counts per step, `fresh=0`). A/B
  micro-bench (clamp+balance on a 724-leaf deep-zoom cut): **string 28.4 ms → integer 3.4 ms (~8.3×)**,
  identical output. At the user's ~430-leaf zoom regime this drops the recut spike from ~9–12 ms to ~1–2 ms.
  (commit `0f8f3b7`.) ⚠️ **Real-GPU confirm:** `?perf` while zooming — `recut=` should stay single-digit and
  the 18–21 ms zoom worst-frames drop under the cadence; idle stays ~17.6 ms (that's the *display* cadence —
  not a regression; if the panel is ~57 Hz, 17.6 ms is already "locked to the display"). Deferred fallback if
  the recut still bites: move cut-selection to a worker (it's pure/worker-safe).

Measured-good on WebGPU (build the user ran): orbit→surface descent holds 60 fps / ~16.8 ms,
`cov=96/96 holes=0` throughout, `fresh=0 refine=N` (sharpen-in-place, no pop), `bornM≈1.0`, largest cut ~466
leaves (no spike), no rAF `[Violation]` stalls.

> **Gate honesty:** the determinism half (golden tests, typecheck, build) is verified headless in CI; the
> *visual* gates — seamless sphere, no-jitter walk far from spawn, locked 60 fps, reload→identical planet —
> are confirmed in a real **WebGPU** browser, not headless (software WebGPU/WebGL2 only checks correctness).
> The ✅ above means "implemented + confirmed in this build's session"; re-confirm the visual gates on a real
> GPU after any change.

## 6. What's NEXT (pick up here)
1. **GATED: cube-face-corner `maxNbrΔ=2` transient.** With gated incremental refinement + the 2:1 `balanceCut`
   (both now implemented), the cut is `maxNbrΔ≤1` in steady state and through almost every transition. The one
   exception is a **transient `maxNbrΔ=2` at a cube-face corner** during a fast climb: `balanceCut`'s
   cross-face neighbour probe (`maxNeighborDepth`/`coveringDepth` via `wrapFaceUV`) doesn't catch the
   3-faces-meet corner adjacency, so a lone depth-4 leaf can momentarily abut the depth-2 base there. It's
   tiny, lasts one generation, appears over a live ancestor (not the backdrop), and the 500 ms birth-ease
   renders the deep leaf as its parent surface initially (masking it to ~1 level). **Gated on actually seeing
   it on WebGPU.** If visible, the fix is to make `maxNeighborDepth` probe the face *corners* consistently
   (or add an explicit corner-neighbour pass), then it force-splits like any other edge. The watertight
   edge-lock fallback (per-vertex `edgeMask` + `effMorph=0` on boundary verts; conditioned skirts behind
   `?skirt`) remains available if a sub-pixel `gap` line shows at the one-level T-junctions.
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
- `[NMS perf] worstDt= recut= upload= tick= gpu/other= | live=Ndraws churn=/s | approach= inst= prefetch=`
  (`?perf`) — the spike breakdown the smoothed FPS overlay hides. `worstDt` = worst frame in the window;
  the four stage times say WHICH main-thread step spiked (`recut`=update/selectCut/balanceCut,
  `upload`=GPU upload, `tick`, `gpu/other`=dt minus measured = GPU/vsync). `live=Ndraws` = leaf count =
  draw calls (aim well under the cut ballooning); `churn` = meshes created+disposed/s (high = thrash).
- `[NMS step]` (under `?lodaudit`) — diagnoses WHICH mechanism makes detail appear in discrete
  steps/"generations" on a zoom: **A** `floorWins%(peak)/lift/snap(floor N)` = the birth-ease floor holding
  a batch at the parent against distance, fading together = a wave (peak is the windowed max so a snapshot
  can't miss it); **B** `bornHist[≥.9/.7/.3/<.3]` + `pfAdeq` = leaves arriving late (mass in `<.3`, lead <
  need) → snap in part-detailed; **C** `new[depth:count]` = a whole LOD level arriving in one recut burst;
  **D** `mNear/wMorph/gA/gB` = whether the surface texture steps independently of the geometry morph (gA/gB
  are smooth in distance, so if texture steps it's `wMorph` = the morph, i.e. the same root as A/B);
  **swap** `[dPos=Xm(avg) dNrm=Y°(avg) n=N]` = per refinement leaf going live, the residual between its
  morph=1 surface and the parent leaf it replaces (`swapDelta` in `/core`). This DROVE and now GUARDS the
  parent-grid morph fix: a real-GPU zoom measured `dNrm≈17° avg, dPos≈1 km` at every depth — proof the morph
  target did NOT reproduce the parent (it was the coarser field on the CHILD's finer grid, resolving detail
  the coarse parent grid couldn't), so every one-level split popped the normal ~17°. **Fixed** by baking the
  morph target as the parent's GRID surface (see below); `swap` now reads ≲ a couple ° / tens of m (only the
  pre-existing `_tLo`-normalization residual) ⇒ morph=1 ≈ parent ⇒ pop-free swap.
- **The HUD overlay** now also shows `worst <ms>` + a `⚠ N jank` count and goes RED on any hitch — the
  smoothed "fps" alone hid the stutter. **`maxNbrΔ`** is now the ACCURATE fine-probe metric (the old
  quarter-cell probe over-reported, e.g. `=4` on cuts that were already 2:1 balanced).

Key tunables in `scene.ts`: `BASE_DEPTH=2`, `PREFETCH_MAX_FRAC=0.35`, `PREFETCH_FLOOR_M=3000`,
`PREFETCH_CEIL_M=20000`, `PREFETCH_S=0.7`, `APPROACH_MAX_MPS=5000` (clamps the per-frame closing rate so
an orbit zoom can't pin prefetch), `APPROACH_DT_MAX_MS=100`, `RECUT_MAX_MS=300`, `RECUT_MIN_MOVE_M=1`,
`maxDepth=15` (~9.5 m cells). In `terrainMaterial.ts`: `MORPH_START_FRAC=0.30`, `BIRTH_MS=500` (per-level
octave fade-up — each one-level cohort dissolves in over this window, so detail sharpens continuously rather
than switching on), and the detail dials — `DETAIL_PHASE_MOD_M=100000`, `DETAIL_A_SCALE_M=40` (coarse mottle,
fades ~50 km→1 km), `DETAIL_B_SCALE_M=6` (fine grain, fades ~6 km→200 m), plus the `SAND`/`ROCK` band
palette. `core/quadtree.ts` adds `clampCutToReachableFrontier` (gated incremental refinement — caps the
requested cut at live+1 per region; pure, unit-tested), `balanceCut` (2:1 restrict) + `maxNeighborDelta`
(accurate metric); `quadtreeManager.isRefining()` + `scene.ts refineRecut` keep generations firing while the
front climbs (even stationary), then settle.
Debug flags (URL query): `?perf ?seamscan ?lodaudit ?lodmorphdebug ?morphcolor ?wire ?lodcolor
?skirt ?skirtcolor ?noback ?dark ?webgl ?clipdebug ?nolog ?revz`. **`?seamscan`** is now required for the
expensive O(live²) seam + O(96·live) coverage scans (off by default even under `?lodaudit`, since at
~500 leaves they were themselves a periodic main-thread spike).

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
