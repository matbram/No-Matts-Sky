# HANDOFF — No Matt's Sky (current build state)

> Read **`CLAUDE.md`** first (it's the build spec + guardrails). This file is the companion: **what is
> actually built right now, how to run/verify it, and what's next.** For the live commit/branch run
> `git rev-parse --short HEAD` / `git branch --show-current` (don't trust a hard-coded hash here — it goes stale the next commit).
>
> **Authority:** the law lives in **`/design`** (7 docs). When they disagree, the order is
> **Constitution → master plan → slice spec** (`CLAUDE.md` §1). This handoff describes the *build state*;
> it never overrides those docs.

## 1. TL;DR — where we are
A real-scale (Earth = 6,371 km) procedurally-generated planet you can fly from orbit to the surface and
**walk on**, at a locked **60 fps**, with **seamless, pop-free CDLOD terrain** that "gets clearer" as you
descend (no popping/flicker). The vertical-slice core (CLAUDE.md Steps 0–4) is done, plus an extensive
LOD-quality pass (continuous distance-morph, speed/altitude-aware prefetch, always-resident coarse base,
analytic morph normals). **Steps 0–6 are now implemented** (Step 5 re-architected to the real reference-frame
system — a genuinely spinning planet under a real far Sun + Moon you can fly to; Step 6 = atmosphere sky +
aerial-perspective haze + elevation palette). **All visual + 60 fps acceptance is a real-GPU gate** (headless
software-WebGL confirms correctness/render only). Remaining: real-GPU confirmation pass + the deferred
refinements (velocity inheritance on launch, analytic eclipse, Moon as a landable body — see §6).

## 2. First 5 minutes (new session)
```bash
cd No-Matts-Sky
git pull   # a fresh clone is already on the task's feature branch — don't hard-code a branch name (it changes per task)
npm install
npm test          # 11 suites (golden/determinism): hash, noise, cubesphere, density, chunk, quadtree,
                  #   seedchain, facts, surfacenets, core-boundary, digest
npm run build     # tsc --noEmit && vite build (the same gates CI runs — .github/workflows/ci.yml)
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
- Branch: the task's feature branch (run `git branch --show-current`; `git rev-parse --short HEAD` for the commit). The
  determinism/CI-hardening pass (seedchain/facts/production-seed/core-boundary/surfacenets/quadtree-cut/digest goldens +
  `.github/workflows/ci.yml`) landed on `claude/app-audit-next-steps-0urxct`.
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
  (wider fade band), `RECUT_MAX_MS` 400→300 (leaves trickle, not batch), `PREFETCH_S` kept at 0.7 (a 1.0
  experiment was reverted — the live values are `RECUT_MAX_MS=300`, `PREFETCH_S=0.7`, see §7); (2) **one shared
  material** (`terrainMaterial.ts`) — the per-leaf morph node-graph clone is
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

- **Determinism + CI hardening pass (branch `claude/app-audit-next-steps-0urxct`, from the deep-audit next-steps
  plan):** closed the guardrail-§6 gap the audit found — the `[S]` seed chain, the facts stub, and the
  *production* seed path were on the live runtime path but unguarded by any frozen golden. Added **5 new test
  suites + extensions** (91→**119 tests**), all render-output-unchanged (no golden re-bless): `seedchain.test.ts`
  (freezes `MASTER_SEED`, the `SALT` map, `planetSeed`/`childSeed` incl. the production
  `childSeed(sliceFacts().seed,0,SALT.terrain)`), `facts.test.ts` (the coordinate-keyed `sliceFacts` seam),
  `chunk.test.ts` +production-seed golden (the real address→seed→recipe→mesh wire), `core-boundary.test.ts`
  (asserts `/core` imports no three.js — guardrail §1 now self-policing, via `import.meta.glob('?raw')`),
  `surfacenets.test.ts` (standalone manifold/watertight + frozen digest on a sphere SDF), `quadtree.test.ts`
  +frozen orbit/mid/surface cut snapshots and a `packRegion`/`unpackPath` injectivity sweep (both now exported),
  `digest.test.ts` (FNV-1a known-answer vectors). Plus **`.github/workflows/ci.yml`** (typecheck+test+build on
  push/PR — the enforcement substrate behind every "frozen"/"convention-only" guard). Doc drift repaired
  (HANDOFF/PERFORMANCE/CLAUDE: stale branch/commit, the failing checkout line, the `RECUT_MAX_MS`/`PREFETCH_S`
  contradiction, the §6 dials, `aLevel`→`aLodR`/`aParentR`, seven→eight docs) and the `salt=0` structural-descent
  convention documented + frozen. typecheck + 119 tests + build green.

- **Step 5 — real spin + orbit (render integration; same branch).** `core/orbits.ts` (Kepler/NR e≤0.8,
  `orbitalPosition`/`orbitalVelocity`, `spinAngle`, real Earth/Moon elements + frozen golden) is wired into
  `scene.ts`: a game clock (`TIME_COMPRESSION`, `?timescale=N`, `?notime`) drives **day/night from REAL spin**
  — each frame the heliocentric planet→sun direction is rotated into the body frame by the inverse spin about
  the tilted axis (23.44°) and set as the `DirectionalLight` direction (NOT a moved light), so the terminator
  sweeps as the planet rotates and drifts as it orbits. The **render frame stays planet-centered** (no AU-scale
  double to the GPU; the surface→orbit **launch can't rocket the planet away** — gate satisfied by construction;
  full inertial flight model deferred). A **Sol disc** (unlit billboard, real angular size, behind terrain) and
  a **Moon proxy** (along its true direction) are rendered; the Moon's **cast shadow** is wired
  (`renderer.shadowMap` + `sun.castShadow` + terrain `receiveShadow` via the new `ManagerOpts.receiveShadow`)
  behind **`?noshadow`**. HUD shows game-day / time-of-day / orbit %. **Headless-confirmed:** `?webgl` renders the
  day/night terminator cleanly (shadows on AND off), typecheck + 129 tests (render-only, no golden change) +
  build green. ⚠ **Real-GPU confirm:** terminator ADVANCES over time; sun drifts over an orbit; the moon's cast
  shadow lands during an eclipse (`?noshadow` to A/B — the terrain material overrides `positionNode` + is
  `DoubleSide`, so the shadow-depth pass must reproduce the morphed surface; analytic sun-occlusion is the
  fallback); 60 fps holds. (commits `dbd2d51`, `500175b`, + this Step-5 render commit.)

- **Step 5R — real reference-frame free flight (re-architecture; same branch).** The first Step 5 above took a
  single-planet shortcut (planet pinned at the origin, Sun/Moon as ~5 km proxies, day/night faked by rotating the
  light). That passes the literal checklist near one planet but blocks the actual goal — flying freely from surface
  to Moon to Sun, every body a real object. So the render frame was rebuilt to the master-plan Part-4 hierarchy
  (the orbit math, double precision, floating origin, and streaming all carry over unchanged):
  - **R1** (`baa8c21`): the planet is a REAL spinning body. Terrain + backdrop live under a `planetGroup` whose
    quaternion = the real spin `qSpin(t)`; players co-rotate (surface walkers turn WITH the planet — ground static,
    sun moves); orbital viewers see it turn. Day/night = the real Sun direction on the genuinely-spinning surface.
  - **R2** (`2050e7e`): real far Sun + Moon at TRUE distances (1 AU / 384,000 km, real radii), placed at
    `bodySystemPos − spunOrigin` in scene space. The floating origin rides the camera, so flying out makes a body
    GROW from a dot — no proxies. Log-depth far-plane held the terrain crisp. (Eclipse shadow now dormant — moon is
    real-far, outside the shadow frustum; needs the analytic approach.)
  - **R3a** (`8864890`): spaceship flight speed (user-chosen auto-scale + manual throttle). Cruise =
    `clamp(altitude × 0.7, 20 m/s, 0.3c)` × throttle; `[`/`]` throttle, Shift boost. The Moon is reachable in
    seconds, the Sun in ~minutes (the old ~40 km/s ladder made the Moon ~2.7 h away — that's why "fly to it" felt
    broken). HUD shows cruise speed + distance-to-Moon/Sun.
  - **FF (free-flight overhaul) — Phase 1 DONE** (`player.ts` + `scene.ts`): user feedback "stuck on an axis /
    invisible guideline." Free-fly now has a **free orientation quaternion** (`_flyQuat`): mouse looks anywhere
    (no pitch clamp, no forced planet-up), **Q/E roll/bank**, **R re-level**; movement is fully **camera-relative
    6DOF** (W=look, A/D=camera right, Space/Ctrl=camera up). **Speed is player-controlled** (replaced altitude
    auto-scaling): an absolute **throttle ladder** (`[`/`]` + mouse wheel), the velocity **eases** toward the
    throttle target (critically-damped, no overshoot), **Shift** boosts, **X** full-stops. **Free-fly is the
    default camera on load** (aimed at the planet); orbit-drag + **1/2/3** presets and **F** walk remain; **G**
    toggles. **T** cycles the game-time rate (1×/60×/360×/pause) so things run at real speed; HUD shows it. Walk
    mode unchanged. Headless-confirmed: presets + walk still render, typecheck + 129 tests + build green. ⚠
    Real-GPU: the 6DOF feel. **Phase 2 (deferred):** altitude-aware frame — inertial in space (planet rotates
    beneath), body-fixed + gravity in the atmosphere — with a smooth blend (gravity feel to be confirmed).
- **Step 6 (S1) — atmosphere sky + sun glow** (`src/render/atmosphere.ts`, this commit). A planet-centered shell
  at `R·1.025` (BackSide, additive, depth-tested but not depth-writing) with an analytic single-scatter colour
  (Rayleigh blue + limb/horizon brightening + a Mie forward-glow sun halo), fed the SAME real `_sunDir` as the
  terrain. One mesh serves both views: from orbit a **glowing blue limb** wraps the planet (brighter on the sunlit
  crescent, dark on the night side); from the surface **blue sky** overhead, brightening toward the horizon. The
  camera `far` is now extended in EVERY mode (incl. walk) to reach the shell + the real Sun/Moon, so the sky is
  consistent surface↔space (log depth keeps the surface crisp; ⚠ real-GPU: re-confirm no walk-surface z-fight).
  `?noatmo` hides it for A/B. **Headless-confirmed** (`?webgl`): orbit limb + ground sky both render; typecheck +
  129 tests (render-only) + build green; walk stays grounded (eye height 1.7 m) with the extended far plane.

Measured-good on WebGPU (build the user ran): orbit→surface descent holds 60 fps / ~16.8 ms,
`cov=96/96 holes=0` throughout, `fresh=0 refine=N` (sharpen-in-place, no pop), `bornM≈1.0`, largest cut ~466
leaves (no spike), no rAF `[Violation]` stalls.

> **Gate honesty:** the determinism half (golden tests, typecheck, build) is verified headless in CI; the
> *visual* gates — seamless sphere, no-jitter walk far from spawn, locked 60 fps, reload→identical planet —
> are confirmed in a real **WebGPU** browser, not headless (software WebGPU/WebGL2 only checks correctness).
> The ✅ above means "implemented + confirmed in this build's session"; re-confirm the visual gates on a real
> GPU after any change.

## 6. What's NEXT (pick up here)
0. **FLAGGED (latent, not yet fixed): Surface Nets pass-2 upper-axis OOB.** Each tangential branch in
   `surfacenets.ts` pass-2 guards the lower bounds (`j>=1,k>=1`) but not the upper (`j<ny,k<nz`), so a boundary
   sign-change can index `cellVert` past its `nx·ny·nz` extent (the read wraps to a neighbouring cell or returns
   undefined). Adding the upper guards is **NOT a no-op** — it changes the frozen mesh digests (~68 fewer tris on
   the standard leaf), i.e. those boundary reads currently DO emit apron-boundary triangles. Latent today (the
   outer radial shell is air + the recipe is smooth, so no visible defect), so the determinism-hardening pass left
   it in place (it must not re-bless) and documented it in code. Fixing it is a deliberate change needing a golden
   re-bless + a real-GPU seam/coverage check. (Audit finding, confirmed.)
1. **(Audit: likely a NON-issue) cube-face-corner `maxNbrΔ=2` transient.** With gated incremental refinement + the 2:1 `balanceCut`
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
2. **Step 5 — real spin/orbit: IMPLEMENTED (render integration in `scene.ts` + `core/orbits.ts`); REMAINING =
   real-GPU confirmation + the moon-shadow visual.** Done: day/night from real spin (headless-confirmed
   terminator), sun drifts over the orbit, Sol disc + Moon proxy, planet-locked launch (no rocket-away),
   double→mod 2π→float, Kepler/NR e≤0.8, frozen orbits golden. **To pick up:** (a) on a real WebGPU GPU confirm
   the terminator ADVANCES, the sun drifts over a (time-compressed) orbit, and **the moon's cast shadow lands
   during an eclipse** (`?noshadow` to A/B; the terrain material overrides `positionNode` + is `DoubleSide`, so
   verify the shadow-depth pass reproduces the morphed surface — else switch to the analytic sun-occlusion
   fallback or a `?moonscale` demonstrative size); (b) optional: the full inertial flight model (currently the
   planet-locked frame satisfies the no-rocket-away gate). Tunables: `TIME_COMPRESSION` (constants.ts),
   `?timescale=N`/`?notime`/`?noshadow`, `SUN_PROXY_DIST`/`MOON_PROXY_DIST` (scene.ts).
3. **Step 6 — "make it beautiful" (in committed, screenshot-verifiable increments).**
   - **S1 — atmosphere sky + sun glow: DONE** (`src/render/atmosphere.ts`; headless-confirmed orbit limb + ground
     sky). ⚠ Real-GPU: confirm the limb/sky look + that the walk-mode far-plane extension doesn't z-fight the
     surface (log depth should hold it; if not, split the far bodies into a layered pass — plan §4).
   - **S2 — aerial perspective: DONE** (`terrainMaterial.ts` + manager `setAtmosphere` + scene wiring). The lit
     surface is dimmed by transmittance and the sky's blue is added as **emissive** (unlit) inscatter, scaled by
     view `dist` × air density; density = `exp(−alt/30 km)` (scene.ts), so haze is full at the surface, ~0.39 at
     28 km, and ≈0 by orbit (planet reads crisp from space — only the shell's limb). Reuses the morph `dist` +
     slope `up`, fed the same `_sunDir` as the shell (ground haze ↔ sky agree at the horizon). `?nohaze` A/B.
     **Headless-confirmed:** orbit stays crisp (no wash); a t=0 A/B at the surface preset shows the haze adds
     +9 blue-shift (B−R) to distant terrain — the aerial-perspective signature. ⚠ Real-GPU: the full daylit look
     is best judged flying the **day-side equator** (the fixed headless spawn spot sits near the spin pole, so
     it's perpetually grazing-lit/dim — not a bug, just the test view).
   - **S3 — elevation palette band + slope-preset lock: DONE** (`terrainMaterial.ts`). A 3rd material tier on
     top of the slope rock/sand — pale dusty **highlands** up high, darker **lowland** regolith down low — keyed
     to the fragment's normalized height `(|p|−R)/heightAmp` (cheap: one length + two smoothsteps, no noise,
     always on → reads as large-scale highland/lowland tinting from orbit and grounds the surface). Slope preset
     locked to **2** (low-contrast — mutes preset 0's harsh black/tan salt-and-pepper; `?slopeband=N` overrides).
     **Deliberately NOT literal 3-axis triplanar:** the detail is isotropic 3D gradient noise (`mx_noise_vec3` of
     the world position) with no single-axis projection to stretch, so triplanar would only triple the dominant
     per-fragment noise cost (the cost S4 must bound) for no visible gain — documented in code. **Headless-
     confirmed:** orbit renders with softer mottle + warmer palette, no artifacts; typecheck + 129 tests + build
     green. ⚠ Real-GPU: judge the elevation tiers up close in daylight.
   - **ATMOSPHERE OVERHAUL (user feedback "hard edge"; chose LUT + Earth-like + clouds + ocean).** The S1
     shell read as a hard-edged ring (a thin mesh + Fresnel term = a geometric silhouette). Replaced with a
     ray-marched soft-limb sky; full plan (LUT atmosphere + ocean + clouds) in the approved plan file.
     - **Stage A DONE** (`src/render/atmosphere.ts` rewrite): a BackSide shell at R+100km whose colour is an
       analytic single-scatter ray-march (Rayleigh+Mie+ozone, exp density) → the limb fades SMOOTHLY into
       space (no silhouette) and the surface gets a real graded blue sky (deep zenith → pale horizon).
       Precision-safe near the surface: the CPU feeds the camera's radial `up` + altitude (`atmosphere.planetUp`
       /`atmosphere.camAlt`); per-sample altitude uses the difference-of-squares form (no |oc|²−R² cancellation).
       New `?daylit` dev toggle lights the camera-facing hemisphere for tuning (preset/spawn spots sit near the
       dim pole/terminator). **Headless-confirmed (`?webgl`):** soft limb (no hard edge); `?daylit` ground view
       = graded blue sky + horizon desaturation; typecheck + 129 tests + build green. Thin limb at high orbit is
       realistic (dramatic at low orbit); brightness/richness come in Stages B (transmittance+sky-view LUT), C
       (multiscatter), E (preset lock). Then Phase O (ocean) + Phase C (clouds).
   - **Phase O — ocean: DONE** (`src/render/ocean.ts`). An opaque, depth-tested sphere at sea level
     (R+4 km, clamped below the walk spawn so it spawns on land) — land/sea falls out of depth sorting
     (terrain above sea level = land, below = ocean; coastline where it crosses). Unlit water node: Fresnel
     deep-blue→reflected-sky, a tight sun glint toward `_sunDir`, scrolling wave-normal sparkle, day/night
     by radial-up·sun. Smooth without tessellation via a per-fragment analytic radial normal (coarse 64
     cube-sphere). Lives on `scene` at the planet centre (−_spunOrigin), concentric with the terrain.
     **Headless-confirmed (`?webgl&daylit`):** a blue ocean world with landmasses + sun glint + soft limb.
     `?noocean` A/B. Deferred: depth-based shallow/teal colour (needs the scene depth texture), buoyancy/
     swimming (visual-first), sky-view-LUT reflection (uses an analytic sky gradient for now).
   - **Stage B (transmittance LUT) + Stage C (multiscatter proxy): DONE** (`src/render/atmosphereLUT.ts` +
     `atmosphere.ts`). The §5.7 LUT path is proven: a transmittance LUT (256×64 RGBA16F) is rendered ONCE to a
     RenderTarget via a fullscreen `QuadMesh` pass (portable — no compute/storage textures) and the sky march
     samples it for the sun term (physically-correct extinction + sunset reddening) instead of the airmass
     approximation. **DEFAULT ON** (verified to render under `?webgl`); `?atmonolut` forces the analytic path,
     and a try/catch around the one-time build falls back to analytic if a backend can't do HalfFloat RTs.
     Stage C is a CHEAP multiscatter proxy (an isotropic skylight term gated by the sun's elevation) that lifts
     the day sky and keeps twilight blue instead of black — not the full Hillaire multi-direction LUT.
     **Headless-confirmed (`?webgl`):** ground sky graded blue via the LUT; default night-orbit shows a soft
     sunrise limb (no hard edge); typecheck + 129 tests + build green; no LUT build errors. **Deferred (real-GPU
     gated):** the per-frame SKY-VIEW LUT (a perf optimization — the analytic march + LUT tap is fine for now)
     and the aerial-perspective LUT (Stage D — terrain still uses the old `HAZE_*`); Stage E preset tuning ongoing.
   - **Phase C — clouds: DONE** (`src/render/clouds.ts`). A semi-transparent, sun-lit cloud deck at R+9 km:
     two-octave fBm coverage of the SURFACE DIRECTION (stable on the globe, drifts only by a wind clock),
     soft puffy alpha, lit white (day) / dark (night) / warm (terminator) by `_sunDir`; alpha-blended,
     depth-tested (ground occludes it), drawn before the sky (renderOrder 5). **Headless-confirmed
     (`?webgl&daylit`):** white drifting clouds over the blue ocean with gaps to the sea — the full
     Earth-like look (atmosphere + ocean + clouds). `?noclouds` A/B. Volumetric clouds deferred (`?volclouds`).
   - **S4 — perf hygiene done; 60fps lock is the real-GPU gate.** Micro-opt: the terrain shader now reuses one
     radial length for both the slope `up` and the elevation band (one sqrt/fragment, not two — hottest path).
     Headless `?perf` (orbit→mid→surface) confirms S1–S3 added **no unbounded main-thread work**: recut ≈14–20 ms
     (one-off on a preset switch), upload ≈0.4–1.7 ms, tick ≈0.1–0.3 ms; live ≈72–104 draws (bounded), churn 1–2/s
     (no thrash); the huge `gpu/other` is purely software-WebGL (SwiftShader CPU) fragment cost that a real GPU
     eliminates. ⚠ **Real-GPU gate (unchanged):** `?perf` worstDt < 16.67 ms across surface→orbit→Moon→Sun; the
     levers if it's tight are `?dpr=1`, `?nodetail`, `?noatmo`/`?nohaze`, lowering `MAX_DEPTH`.
     - **Per-leaf attr → per-mesh uniform: deliberately DEFERRED (not the bottleneck; morph-risk).** The audit's
       suggestion to move `aLodR`/`aParentR`/`aBirthMs` off per-vertex attributes was NOT done: (1) the measured
       descent bottleneck is meshing throughput, not attribute upload (HANDOFF "Measured-good"); (2) per-mesh
       uniforms don't bind cleanly to a SHARED Three-WebGPU node material (the per-vertex constant IS the standard
       workaround — the alternative is a per-leaf material clone, which is what the shared material exists to
       avoid); (3) `aParentR` can't be derived from `aLodR` in-shader (BOUND_FACTOR's parent/child ratio runs
       1.52→2 by depth, not constant). Risking the load-bearing CDLOD morph for a one-time-per-leaf upload trim
       that isn't the bottleneck violates the prime directive. Revisit only if a real-GPU `?perf` shows upload as
       the spike, or when a 2D-textured archetype makes true triplanar (and per-mesh data) worthwhile.
   - Deferred refinements: velocity inheritance on launch; unify orbit presets into one seamless free-flight;
     nearest-body speed scaling; un-swim surface detail under spin; analytic eclipse; Moon as a real landable body.

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
`npm test` → `src/test/{hash,noise,cubesphere,density,chunk,quadtree,seedchain,facts,surfacenets,core-boundary,digest}.test.ts`
(119 tests, 11 suites). Golden/determinism via
`toMatchInlineSnapshot` + FNV-1a digest (`src/test/digest.ts`). These are **frozen** — if a golden value
changes, the generation pipeline drifted (and the future Rust port would diverge); only re-bless
deliberately (e.g. the planned `edgeMask` change will legitimately regenerate mesher digests).
