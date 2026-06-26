// ─────────────────────────────────────────────────────────────────────────────
// Quadtree LOD streaming manager (render side) — Step 3.
//
// Each update it asks the pure core for the visible leaf cut, then streams the
// missing leaves in WITHOUT stalling the frame (master plan §8.2, slice spec §7):
//   • a POOL of mesher workers generates leaves in parallel (off the main thread);
//   • requests are prioritized nearest-first, biased AHEAD along camera motion;
//   • finished meshes queue and are uploaded to the GPU under a PER-FRAME BUDGET
//     (only the tiny upload is in the frame budget — generation never is);
//   • leaves that leave the cut are dropped, and queued-but-unstarted work for
//     them is cancelled.
//
// Render placement uses a recentered renderOrigin so GPU floats stay small at any
// altitude (full per-frame floating origin is Step 4).
// ─────────────────────────────────────────────────────────────────────────────

import { Scene, Mesh, BufferGeometry, BufferAttribute, Color, Vector3, type Material } from 'three';
import {
  selectCut,
  balanceCut,
  clampCutToReachableFrontier,
  maxNeighborDelta as maxNeighborDeltaCore,
  nodeBounds,
  lodBoundRadius,
  retainedShouldRemove,
  isPathPrefix,
  type CameraView,
  type QuadNode,
} from '../core/quadtree.ts';
import { chunkKey, uvRectFromPath, swapDelta, type ChunkMesh, type MeshJob } from '../core/chunk.ts';
import { faceDirection, wrapFaceUV, CUBE_FACES } from '../core/cubesphere.ts';
import { lodOctaves, terrainAt, type TerrainRecipe } from '../core/density.ts';
import {
  createTerrainMaterial,
  detailPhaseOf,
  MORPH_START_FRAC,
  BIRTH_MS,
  DETAIL_A_NEAR_M,
  DETAIL_A_FAR_M,
  DETAIL_B_NEAR_M,
  DETAIL_B_FAR_M,
} from './terrainMaterial.ts';

type Status = 'pending' | 'inflight' | 'ready' | 'live';
interface Entry {
  node: QuadNode;
  status: Status;
  center: [number, number, number];
  mesh: Mesh | null;
  mat: Material | null; // OWNED per-leaf material: null in normal mode (uses the shared material);
  // a clone only in debug-tint modes (?lodcolor/?skirtcolor/?morphcolor). Disposed iff non-null.
  ready: ChunkMesh | null;
  morph: number; // CDLOD morph at the leaf CENTER (0=full near .. 1=parent far) — debug/HUD only
  needsSkirt: boolean; // does any edge lack a same-LOD neighbour in the cut?
  liveAtMs: number; // manager clock when this leaf went live (for ?lodmorphdebug age)
  reqAtMs: number; // manager clock when this leaf was requested (pending) — for stream latency
}
interface MeshResult {
  id: number;
  mesh: ChunkMesh;
  ms: number;
}

// MORPH_START_FRAC (the CDLOD fade-band start) lives in terrainMaterial.ts so the TSL graph and
// this file's CPU mirror (`distanceMorph`, for ?lodmorphdebug/?morphcolor) stay in lockstep.
//
// The old time-based "birth-ease" (a newly-live leaf eased up from the parent over 300 ms) was
// REMOVED: with speed-aware prefetch keeping leaves born at the parent surface (bornM≈1), it was
// redundant, and because a recut's batch of new leaves all share a birth instant it faded them in
// as one synchronized front — a visible "wave." The per-vertex distance morph alone now carries
// every leaf in continuously, independent of when it streamed in.

// Skirt depth (m) at a LOD transition, sized to the cross-LOD SURFACE mismatch — NOT
// the old km-scale "cover everything" curtain that was the visible boundary grid.
// A coarser neighbour drops this leaf's finest octave, so the gap ≈ height·gain^(oct−1)
// (the dropped octave's amplitude); SKIRT_SAFETY bridges it, clamped so the curtain is
// never thinner than a sub-metre crack nor deep enough to reach the inset backdrop
// (which sits height·1.05 below the surface). lodOctaves matches the mesher exactly.
const SKIRT_SAFETY = 4;
const SKIRT_MIN_M = 2;
const SKIRT_MAX_M = 12_000;

/**
 * Quantized world directions of a leaf's 4 edge MIDPOINTS. Two same-LOD neighbours
 * (within a face OR across a cube edge) share an edge midpoint exactly (cube-sphere
 * watertightness), so the same key appears for both; a coarser/finer neighbour's
 * edge midpoint lands elsewhere. Used to detect which edges are interior (same-LOD).
 */
function edgeKeys(node: QuadNode): string[] {
  const r = uvRectFromPath(node.path);
  const um = (r.u0 + r.u1) / 2;
  const vm = (r.v0 + r.v1) / 2;
  const k = (u: number, v: number): string => {
    const d = faceDirection(node.face, u, v);
    return `${Math.round(d[0] * 1e6)},${Math.round(d[1] * 1e6)},${Math.round(d[2] * 1e6)}`;
  };
  return [k(r.u1, vm), k(r.u0, vm), k(um, r.v1), k(um, r.v0)];
}

export interface ManagerOpts {
  splitPx: number;
  maxDepth: number;
  // Always-resident coarse base: pin the coarsest `baseDepth` levels live across the WHOLE
  // sphere (no horizon/cone cull) so every finer leaf morphs from a real parent → no
  // fresh-over-backdrop pop when a region rotates/streams in. 0 = off. See SelectOpts.baseDepth.
  baseDepth?: number;
  workers?: number; // pool size (default: min(10, cores-1))
  wireframe?: boolean; // debug: render the shared terrain material as wireframe (?wire)
  slopePreset?: number; // ?slopeband=N: slope-band look preset (index into SLOPE_PRESETS; default 0 = current)
  skirts?: boolean; // enable LOD-transition skirts (default OFF — the apron already covers
  // holes at LOD transitions, and the skirts were the visible boundary grid; ?skirt re-enables)
  debugColor?: 'lod' | 'skirt' | 'morph'; // debug tint: LOD level / skirted leaves / morph progress
  debugLodMorph?: boolean; // ?lodmorphdebug: throttled [NMS morph] console line + balance metric
  debugAudit?: boolean; // ?lodaudit: SUPERSET — also [NMS audit] (seam/coverage/cadence/health)
  debugSeamScan?: boolean; // ?seamscan: run the EXPENSIVE O(live²) seam + O(96·live) coverage scans.
  // OFF by default even under ?lodaudit: at ~500 live leaves they cost ~250k fBm evals and were
  // themselves a periodic main-thread spike (the diagnostics adding the lag they were measuring).
  debugChurn?: boolean; // ?perf: count meshes created/disposed per second (churnPerSec)
}

export interface StreamStats {
  live: number;
  pending: number;
  inflight: number;
  ready: number;
  msPerLeaf: number;
}

export class QuadtreeManager {
  private readonly entries = new Map<string, Entry>();
  private readonly pendingQueue: string[] = []; // keys, nearest-first
  private readonly readyQueue: string[] = []; // meshed, awaiting GPU upload
  private readonly jobKey = new Map<number, string>();
  private wanted = new Set<string>();
  // True while the reachable-frontier clamp is still holding the cut shallower than the screen-space
  // target somewhere — i.e. the detail front has more levels to climb. Drives the recut-while-refining
  // gate in scene.ts so generations keep firing even when the camera is stationary (a hard-zoom-then-stop
  // would otherwise freeze one level in). False once every region has streamed to its target depth.
  private frontierActive = false;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly heightMargin: number;
  private nextId = 1;
  private renderOrigin: [number, number, number] = [0, 0, 0];
  private avgMs = 0;
  // ?perf churn: meshes created+disposed since the last churnPerSec() read, and the manager-clock
  // timestamp of that read — high churn (live count thrashing) is the streaming cost behind the lag.
  private churnAccum = 0;
  private churnClockMs = 0;
  private lastStatLog = ''; // throttles the per-cut diagnostic log
  // ?lodmorphdebug state: a resume-safe clock (accumulated dtMs, no Date.now), upload
  // counter per cut, log throttle, last-measured cut imbalance, and the HUD summary.
  private clockMs = 0;
  private uploadedThisCut = 0;
  private lodMorphLogN = 0;
  private maxNbrDelta = 0;
  private morphSummary = '';
  // Per-cut stream diagnostics (?lodmorphdebug): fresh = a leaf that appeared with NO covering
  // ancestor/descendant (over the backdrop → a visible pop CDLOD can't hide); refine = a swap a
  // retained coarser leaf morph-hid; reqLat = request→live latency (how late detail arrived).
  private freshThisCut = 0;
  private refineThisCut = 0;
  private reqLatSum = 0;
  private reqLatMax = 0;
  private reqLatN = 0;
  // Speed-aware prefetch lead distance (m) the last cut used, + the "born morph" of each
  // leaf at its go-live instant (the decisive ?lodmorphdebug metric: ~1.0 = born at the
  // parent surface and resolving by distance = no pop; ≪1 = born already-detailed = a snap).
  private prefetchM = 0;
  private approachRate = 0; // m/s the camera is closing on the planet centre (per-frame, debug)
  private bornMSum = 0;
  private bornMMin = 1;
  private bornMN = 0;
  // ?lodaudit "[NMS step]" diagnostics — isolate WHICH mechanism makes detail appear in steps/generations
  // on zoom-in. bornHist = born-morph buckets [≥.9/.7–.9/.3–.7/<.3] (B: late arrivals snap if mass is <.3).
  // newByDepth/liveAtByDepth = per-depth go-live counts + last go-live clock (C: levels arriving in bursts).
  // snapCount = live leaves whose DISPLAYED morph jumped >0.3 between frames; snapFloor = of those, how many
  // were inside the birth-ease window (A: the birth floor releasing late = the snap). Reset where noted.
  private readonly bornHist = [0, 0, 0, 0];
  private readonly newByDepth: number[] = [];
  private snapCount = 0;
  private snapFloor = 0;
  private floorWinsMaxWin = 0; // peak floorWins% across frames since the last [NMS step] log (A is a WAVE,
  // not a per-frame snap — a batch held at the floor fades together — so a single log-tick snapshot can
  // miss it; the window peak catches it).
  // [NMS step] swap-delta (the decisive measurement): per REFINEMENT leaf going live, how far its morph=1
  // surface departs from the parent leaf it replaces (swapDelta in /core). Accumulated max/avg over the
  // window, reset at each log. Large ⇒ the morph target doesn't reproduce the parent (mesher fix); ≈0 ⇒
  // the swap is clean and the visible step is the slope-band threshold (shader fix).
  private swapDPosMax = 0;
  private swapDNrmMax = 0;
  private swapDPosSum = 0;
  private swapDNrmSum = 0;
  private swapN = 0;
  // CDLOD geomorph: ONE shared material (createTerrainMaterial) carries the per-vertex distance
  // morph; its kDist uniform = (viewportHeight/(2·tan(fovY/2)))/splitPx — the same projected-size
  // constant selectCut uses, so the morph band aligns with the split distance (set per frame by the
  // render shell). The camera world position (render space) is mirrored on the CPU only to compute
  // the leaf-CENTRE morph for ?lodmorphdebug/?morphcolor; the actual morph is per-vertex in TSL.
  private readonly sharedMat: Material;
  private readonly kDistUniform: { value: number };
  // Material world-origin uniforms (set on every floating-origin recenter): the FULL render origin
  // (direction, for slope bands) and renderOrigin reduced mod L in double (the stable, float-precise
  // base for the surface-detail coordinate). See terrainMaterial.ts.
  private readonly matRenderOrigin: { value: Vector3 };
  private readonly matDetailPhase: { value: Vector3 };
  private readonly matNow: { value: number }; // manager clock → per-leaf birth-ease floor
  private kDist = 0;
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  // ?lodaudit state: the last cut's view-cone half-angle (caps the coverage probe), recut cadence,
  // a one-time wiring sanity check, the HUD mirror, and reused terrain-eval scratch (gap metric).
  private dbgHalfFov = Math.PI;
  private dbgLastCutMs = 0;
  private dbgCutIntervalMs = 0; // EMA of ms between recuts (the "wave" cadence)
  private dbgLeavesAdded = 0; // new leaves requested this cut
  private wiringLogged = false; // one-time morphTargetNormal/normalNode sanity
  private auditSummary = ''; // HUD mirror of the [NMS audit] line
  private readonly _tA = new Float64Array(4);
  private readonly _tB = new Float64Array(4);

  constructor(
    private readonly scene: Scene,
    private readonly recipe: TerrainRecipe,
    private readonly radius: number,
    private readonly opts: ManagerOpts,
  ) {
    this.heightMargin = recipe.height * 1.6;
    // The ONE shared terrain material (per-leaf data rides in the `aLevel` attribute); its kDist
    // uniform is updated each frame via setMorphParams.
    const handle = createTerrainMaterial({ wireframe: opts.wireframe, slopePreset: opts.slopePreset });
    this.sharedMat = handle.material;
    this.kDistUniform = handle.kDist;
    this.matRenderOrigin = handle.renderOrigin;
    this.matDetailPhase = handle.detailPhase;
    this.matNow = handle.now;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    // Pool size. The descent bottleneck is meshing THROUGHPUT (real-GPU ?lodaudit showed reqLat ~700–870ms
    // with busy6/6 saturated + a 100–170 request backlog on zoom-in), so default to 10 workers — still
    // clamped by cores-1, which leaves a core for the main thread and only adds parallelism on machines
    // that have the cores to spare (≤6-core machines are unaffected).
    const n = Math.max(1, Math.min(opts.workers ?? 10, cores - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('../workers/mesher.worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (e: MessageEvent<MeshResult>): void => this.onMesh(e.data, w);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Re-center the render frame; reposition all live meshes relative to it. Also feed the material's
   *  world-origin uniforms so the surface detail stays anchored to absolute world space (no swim) and
   *  precise (the detail phase is renderOrigin reduced mod L in double — the float shader can't). */
  setRenderOrigin(o: [number, number, number]): void {
    this.renderOrigin = o;
    this.matRenderOrigin.value.set(o[0], o[1], o[2]);
    detailPhaseOf(o[0], o[1], o[2], this.matDetailPhase.value);
    for (const e of this.entries.values()) {
      if (e.mesh) e.mesh.position.set(e.center[0] - o[0], e.center[1] - o[1], e.center[2] - o[2]);
    }
  }

  /**
   * CDLOD per-frame params (call once per frame from the render shell):
   *   kDist = (viewportHeight/(2·tan(fovY/2)))/splitPx — the projected-size constant
   *   selectCut uses, so the distance morph reaches `parent` exactly at the split distance.
   * camWorld is the camera position in WORLD space (for the CPU leaf-centre morph used by
   * ?lodmorphdebug/?morphcolor only; the GPU morph uses the TSL cameraPosition builtin).
   */
  setMorphParams(
    kDist: number,
    camX: number,
    camY: number,
    camZ: number,
    approachRate = 0,
  ): void {
    this.kDist = kDist;
    this.kDistUniform.value = kDist;
    this.approachRate = approachRate; // m/s toward planet centre (for ?lodmorphdebug)
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
  }

  /**
   * Recompute the cut and reconcile. `lookahead` is the world point to prioritize
   * around (camera position biased along its velocity) so leaves ahead of motion
   * mesh first.
   */
  update(
    camera: CameraView,
    lookahead: [number, number, number],
    splitPx?: number,
    prefetchM = 0,
  ): void {
    // Reset per-cut ?lodmorphdebug counters (accumulated as this cut's leaves stream in).
    this.uploadedThisCut = 0;
    this.freshThisCut = 0;
    this.refineThisCut = 0;
    this.reqLatSum = 0;
    this.reqLatMax = 0;
    this.reqLatN = 0;
    this.bornMSum = 0;
    this.bornMMin = 1;
    this.bornMN = 0;
    this.bornHist[0] = this.bornHist[1] = this.bornHist[2] = this.bornHist[3] = 0; // [NMS step] B window = since last recut
    this.prefetchM = prefetchM; // for ?lodmorphdebug readout
    if (this.opts.debugAudit) {
      // Recut cadence (the "detail arrives in waves" signal) + the view cone for the coverage/seam probes.
      const since = this.clockMs - this.dbgLastCutMs;
      this.dbgCutIntervalMs = this.dbgCutIntervalMs === 0 ? since : this.dbgCutIntervalMs * 0.8 + since * 0.2;
      this.dbgLastCutMs = this.clockMs;
      if (camera.halfFov !== undefined) this.dbgHalfFov = camera.halfFov;
    }
    let leavesAdded = 0;
    // 2:1 balance the screen-space cut: force-split any leaf whose edge-neighbour is >1 level finer
    // so every cross-LOD step is exactly one level → the CDLOD morph can hide it (no unmorphable
    // seam/pop, which ?lodaudit logged as maxNbrΔ up to 4). selectCut stays the pure SSE decision
    // (its golden test is unchanged); balanceCut is a separate pure pass applied on top.
    const baseDepth = this.opts.baseDepth ?? 0;
    const balanced = balanceCut(
      selectCut(camera, {
        radius: this.radius,
        heightMargin: this.heightMargin,
        splitPx: splitPx ?? this.opts.splitPx,
        maxDepth: this.opts.maxDepth,
        // Speed-aware prefetch: request finer leaves early so the CDLOD morph fades them
        // in continuously (no late snap). approachSpeed·leadTime is computed render-side.
        prefetchM,
        // Always-resident coarse base — keep the whole sphere meshed at low detail so every
        // refinement has a real parent to morph from (no backdrop pop). 0 = off.
        baseDepth,
      }),
      this.opts.maxDepth,
    );
    // GATED INCREMENTAL REFINEMENT — the zoom pop-in fix. Cap the requested cut so no region is ever
    // requested deeper than (its deepest live covering leaf's depth) + 1. The detail front then descends
    // ONE level per recut generation: each shown transition is a single morphable level whose parent is
    // ALREADY live, so a hard zoom no longer jumps a region depth-2→depth-6 over a 4-levels-coarser surface
    // the morph can't hide (the pop). Refinement self-paces to streaming — it can't request level N+1 until
    // N is live — so it never outruns the worker pool. Pure /core decision (clampCutToReachableFrontier);
    // render-side here only because the live set is render state. No-op once a region reaches its target
    // depth (target-live ⇒ clamp returns it unchanged), and it never gates merge-up/coarsening (smooth via
    // the morph + deferred removal). The recut-while-refining gate in scene.ts keeps generations firing.
    const liveNodes: QuadNode[] = [];
    for (const e of this.entries.values()) if (e.status === 'live') liveNodes.push(e.node);
    const clamped = clampCutToReachableFrontier(balanced, liveNodes, baseDepth);
    // Did the clamp hold anything back from its target depth? Truncation strictly reduces total path depth
    // (and may dedup siblings), so a shallower clamped sum ⇔ the front is still climbing. Equal ⇔ settled.
    // Measured on the raw clamp (pre re-balance) so it's a clean "more levels to reach" signal.
    let balDepth = 0;
    for (const b of balanced) balDepth += b.path.length;
    let clampedDepth = 0;
    for (const c of clamped) clampedDepth += c.path.length;
    this.frontierActive = clampedDepth < balDepth;
    // Re-balance the clamped cut: the clamp caps the deep centre at live+1 but leaves its lateral base
    // neighbours at their (shallow) target depth, so a fast-climbing centre can briefly abut the depth-2
    // base with the depth-3 staircase ring missing (?lodaudit logged maxNbrΔ=2 transients). Re-balancing
    // fills that ring — and the leaves it adds are one level past the ALWAYS-LIVE base (depth-2 → depth-3),
    // so they sit within the frontier and appear over a live ancestor (refine, never a backdrop pop). The
    // rings then climb in lockstep one generation behind the centre, so every cross-LOD step stays one level
    // (morphable) all the way down. Cheap (the cut is ~100–150 leaves).
    const cut = balanceCut(clamped, this.opts.maxDepth);

    const wanted = new Set<string>();
    for (const node of cut) {
      const key = chunkKey({ face: node.face, path: node.path, lod: node.path.length });
      wanted.add(key);
      if (!this.entries.has(key)) {
        leavesAdded++;
        const b = nodeBounds(node.face, node.path, this.radius, 0);
        this.entries.set(key, {
          node,
          status: 'pending',
          center: b.center,
          mesh: null,
          mat: null,
          ready: null,
          morph: 0,
          needsSkirt: true, // set below from the full cut, before dispatch
          liveAtMs: 0,
          reqAtMs: this.clockMs, // for ?lodmorphdebug request→live stream latency
        });
      }
    }
    this.dbgLeavesAdded = leavesAdded;
    this.wanted = wanted;

    // Per-leaf skirt conditioning — only when skirts are ENABLED (default OFF). The
    // apron (each tile meshed 1 cell past its rect) already prevents holes at LOD
    // transitions, and the skirts were the visible boundary grid, so skirts are off
    // by default. When on (?skirt), a leaf skirts only where an edge lacks a same-LOD
    // neighbour in the cut — detected by a shared edge-MIDPOINT key (handles within-
    // face AND cross-face), computed from the COMPLETE wanted cut so settled views
    // mesh with the correct mask.
    let skirted = 0;
    const lodHist: Record<number, number> = {};
    const edgeCount = new Map<string, number>();
    if (this.opts.skirts) {
      for (const key of wanted)
        for (const ek of edgeKeys(this.entries.get(key)!.node))
          edgeCount.set(ek, (edgeCount.get(ek) ?? 0) + 1);
    }
    for (const key of wanted) {
      const e = this.entries.get(key)!;
      e.needsSkirt = this.opts.skirts
        ? edgeKeys(e.node).some((ek) => (edgeCount.get(ek) ?? 0) < 2)
        : false;
      if (e.needsSkirt) skirted++;
      const lod = e.node.path.length;
      lodHist[lod] = (lodHist[lod] ?? 0) + 1;
    }
    // Verbose per-cut diagnostic (throttled to when the summary changes), so the
    // user's console shows the cut shape and how many leaves skirt — confirming the
    // state on their actual machine.
    let summary = `leaves=${wanted.size} skirted=${skirted} interior=${wanted.size - skirted} skirtsOpt=${!!this.opts.skirts} lod=${JSON.stringify(lodHist)}`;
    if (this.opts.debugLodMorph) {
      // Cut imbalance: max LOD-level difference across any leaf EDGE (accurate fine-probe metric in
      // core). With balanceCut applied above this should read ≤1; >1 would mean an unmorphable step.
      this.maxNbrDelta = maxNeighborDeltaCore(cut, this.opts.maxDepth);
      summary += ` maxNbrΔ=${this.maxNbrDelta}`;
    }
    if (summary !== this.lastStatLog) {
      this.lastStatLog = summary;
      console.log('[NMS] cut:', summary);
    }
    // Unwanted NON-LIVE entries are cancelled now (no point finishing work we no
    // longer want). Unwanted LIVE leaves are RETAINED — kept rendered until their
    // replacement is live (purgeRetained), so no hole/black-flash appears during
    // the LOD transition. (Cancelled pending: pump skips; inflight: onMesh
    // discards; ready: uploadReady skips — all keyed off the entry being gone.)
    for (const [key, e] of this.entries) {
      if (wanted.has(key) || e.status === 'live') continue;
      this.entries.delete(key);
    }

    // Rebuild the dispatch queue, nearest-to-lookahead first.
    this.pendingQueue.length = 0;
    for (const [key, e] of this.entries) if (e.status === 'pending') this.pendingQueue.push(key);
    this.pendingQueue.sort((a, b) => this.dist2(b, lookahead) - this.dist2(a, lookahead)); // far→near
    // (we pop from the end, so the array is sorted far→near and pop() gives nearest)
    this.pump();
    this.purgeRetained();
  }

  /**
   * Remove retained (live, no-longer-wanted) leaves whose replacement has fully
   * MORPHED IN — so the old leaf stays opaque behind the new one until the geomorph
   * completes, then disappears with nothing visible changing.
   */
  private purgeRetained(): void {
    if (this.wanted.size === 0) return;
    const wantedArr: { node: QuadNode; live: boolean }[] = [];
    for (const key of this.wanted) {
      const e = this.entries.get(key);
      // CDLOD: a replacement "covers" as soon as it's LIVE — it already renders at the
      // correct distance-morph (≈ the parent surface at the split distance), so there is no
      // 350 ms morph to wait for and nothing pops when the retained ancestor is removed.
      if (e) wantedArr.push({ node: e.node, live: e.status === 'live' });
    }
    for (const [key, e] of this.entries) {
      if (e.status !== 'live' || this.wanted.has(key)) continue;
      if (retainedShouldRemove(e.node, wantedArr)) {
        if (e.mesh) {
          this.churnAccum++; // ?perf: a mesh was disposed this frame
          this.scene.remove(e.mesh);
          e.mesh.geometry.dispose();
        }
        e.mat?.dispose();
        this.entries.delete(key);
      }
    }
  }

  /**
   * Per-frame hook. The CDLOD geomorph itself is now PER-VERTEX in the shader (a function
   * of camera distance — see uploadReady), so there is no CPU morph to advance. This only
   * keeps the resume-safe clock and, when ?lodmorphdebug/?morphcolor is on, recomputes each
   * leaf's CENTRE morph for the console line + the red→green tint.
   */
  tick(dtMs: number): void {
    if (this.entries.size === 0) return;
    this.clockMs += dtMs; // resume-safe clock (no Date.now) + the ?lodmorphdebug age base
    this.matNow.value = this.clockMs; // drive the per-leaf birth-ease floor (always, even when debug off)
    const dbg = !!this.opts.debugLodMorph;
    const tintMorph = this.opts.debugColor === 'morph';
    if (!dbg && !tintMorph) return; // CDLOD morph is in-shader; nothing else to do
    let live = 0, mid = 0, sum = 0, mn = 1, mx = 0, newestLive = -1;
    // ?lodaudit morph histogram buckets: [m<.1, .1–.3, .3–.7, .7–.9, >.9]. Bimodal (full pile at
    // <.1 and >.9, few between) ⇒ steps at the transition ring; a smooth spread ⇒ graded morph.
    let h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0;
    // [NMS step] Candidate A snapshot (THIS frame): how often the birth-ease floor is overriding the pure
    // distance morph (holding a leaf at its parent against distance = the delayed-snap "generation").
    let floorWins = 0, floorLiftSum = 0, floorAgeSum = 0;
    for (const e of this.entries.values()) {
      if (e.status !== 'live') continue;
      live++;
      // Split centerMorph into its parts so the [NMS step] line can see the floor vs the pure distance
      // morph (instead of only their max). m = displayed; dm = pure distance morph; bf = birth-ease floor.
      const dm = this.distanceMorph(e);
      let bf = 1 - (this.clockMs - e.liveAtMs) / BIRTH_MS;
      if (bf < 0) bf = 0;
      const m = dm > bf ? dm : bf;
      const prev = e.morph; // last frame's DISPLAYED morph (set below) — for the per-frame snap detector
      e.morph = m;
      // ?morphcolor: green = full detail (near, m=0) → red = parent (far, m=1). A correct
      // CDLOD render shows a smooth concentric gradient, NOT per-leaf colour blocks.
      if (tintMorph && e.mat) (e.mat as unknown as { color: Color }).color.setHSL(0.33 * (1 - m), 0.85, 0.5);
      if (dbg) {
        if (e.liveAtMs > newestLive) newestLive = e.liveAtMs;
        if (m > 0.01 && m < 0.99) {
          mid++; sum += m;
          if (m < mn) mn = m;
          if (m > mx) mx = m;
        }
        if (m < 0.1) h0++; else if (m < 0.3) h1++; else if (m < 0.7) h2++; else if (m < 0.9) h3++; else h4++;
        const ageMs = this.clockMs - e.liveAtMs;
        if (bf > dm + 0.02) { floorWins++; floorLiftSum += bf - dm; floorAgeSum += ageMs; } // A: floor active
        // Per-frame snap = a leaf whose DISPLAYED morph jumped >0.3 since last frame (a visible step).
        // Skip just-born leaves (no valid prev). snapFloor = those still within the birth window ⇒ the
        // birth-ease releasing is the step (A); snaps with no floor point at late geometry arrival (B).
        if (ageMs > dtMs * 1.5 && Math.abs(m - prev) > 0.3) {
          this.snapCount++;
          if (ageMs < BIRTH_MS + 100) this.snapFloor++;
        }
      }
    }
    if (dbg && live > 0) {
      const fwPct = (100 * floorWins) / live;
      if (fwPct > this.floorWinsMaxWin) this.floorWinsMaxWin = fwPct; // window peak (A), reset at log
    }
    if (dbg) {
      const avg = mid > 0 ? sum / mid : 0;
      const latAvg = this.reqLatN > 0 ? (this.reqLatSum / this.reqLatN) | 0 : 0;
      // Speed-aware prefetch readout: approach speed (m/s), the lead distance it bought
      // (km), and bornM — the morph leaves had at go-live (avg/min). The fix is working
      // when bornM stays near ~1.0 even as approach/reqLat rise (born at the parent surface,
      // resolving by distance = no pop) instead of dropping toward 0 (late = a snap).
      const bornAvg = this.bornMN > 0 ? this.bornMSum / this.bornMN : 1;
      const speed = `approach=${this.approachRate | 0}m/s prefetch=${(this.prefetchM / 1000).toFixed(1)}km`;
      const born = `bornM[avg=${bornAvg.toFixed(2)} min=${this.bornMN ? this.bornMMin.toFixed(2) : '-'}]`;
      this.morphSummary =
        `morph midDist=${mid} avg=${avg.toFixed(2)} ${born} ${speed} fresh=${this.freshThisCut} reqLat=${latAvg}ms maxNbrΔ=${this.maxNbrDelta}`;
      if (++this.lodMorphLogN % 10 === 0) {
        console.log(
          `[NMS morph] live=${live} midDist=${mid} m[min=${mid ? mn.toFixed(2) : '-'} ` +
            `avg=${avg.toFixed(2)} max=${mid ? mx.toFixed(2) : '-'}] ${born} ${speed} ` +
            `fresh=${this.freshThisCut} refine=${this.refineThisCut} ` +
            `reqLat[avg=${latAvg} max=${this.reqLatMax | 0}]ms ` +
            `uploads/cut=${this.uploadedThisCut} maxNbrΔ=${this.maxNbrDelta} ${this.nearLeafStr()}`,
        );
        // ?lodaudit: the comprehensive pipeline line (same 10-tick throttle). seam = the cross-LOD
        // boundary continuity (Δeff≈0 + gap≈0 = seamless = no squares); cov/holes = backdrop
        // show-through; histM = morph distribution; cut[Δt,+N] = recut wave cadence; stream/busy =
        // worker health; pf/band = whether prefetch is meaningful at this altitude.
        if (this.opts.debugAudit) {
          // The seam + coverage scans are O(live²)/O(96·live) — at ~500 live leaves a periodic
          // main-thread spike. Run them ONLY under ?seamscan so plain ?lodaudit/?perf measures
          // without the diagnostics perturbing the timing; otherwise show placeholder "off".
          const seam = this.opts.debugSeamScan
            ? this.seamScan()
            : { dEffMax: 0, dEffAvg: 0, gapMax: 0, worst: 'off' };
          const cov = this.opts.debugSeamScan
            ? this.coverageScan()
            : { covered: 0, total: 0, holes: 0 };
          const s = this.stats();
          const busy = this.workers.length - this.idle.length;
          const band = this.nearLeafBandKm();
          const pfKm = this.prefetchM / 1000;
          this.auditSummary =
            `seam[Δeff max=${seam.dEffMax.toFixed(2)} avg=${seam.dEffAvg.toFixed(2)} gap=${seam.gapMax.toFixed(1)}m @${seam.worst}] ` +
            `cov=${cov.covered}/${cov.total} holes=${cov.holes} ` +
            `histM[${h0}/${h1}/${h2}/${h3}/${h4}] ` +
            `cut[Δt=${this.dbgCutIntervalMs | 0}ms +${this.dbgLeavesAdded}] ` +
            `stream[p${s.pending} i${s.inflight} r${s.ready} L${s.live} busy${busy}/${this.workers.length} ${s.msPerLeaf.toFixed(0)}ms] ` +
            `pf=${pfKm.toFixed(1)}km band=${band.toFixed(1)}km pf/band=${band > 0 ? (pfKm / band).toFixed(3) : '-'}`;
          console.log('[NMS audit]', this.auditSummary);

          // ── [NMS step] — one decisive signal per candidate cause of "detail appears in steps" ──
          // A (birth-ease floor holding leaves at the parent against distance, then releasing = a snap):
          //   floorWins% high + floorLift large during a smooth zoom. snap = per-window count of >0.3
          //   displayed-morph jumps; snapFloor = of those, ones still inside the birth window (⇒ the floor
          //   release IS the step). B (late arrivals): bornHist piled in <.3 and/or pfAdeq<1 (lead < the
          //   distance the camera covers while a leaf streams). C (level bursts): newByDepth shows a whole
          //   depth arriving at once. D (texture steps on its own schedule): see nearDetailStr — gA/gB jump
          //   while mNear is smooth. E: histM (above) bimodal. One steady zoom-in run picks the culprit.
          const fw = live > 0 ? (100 * floorWins) / live : 0;
          const fl = floorWins > 0 ? floorLiftSum / floorWins : 0;
          const fa = floorWins > 0 ? (floorAgeSum / floorWins) | 0 : 0;
          const speedMS = Math.max(0, this.approachRate);
          const needM = (speedMS * latAvg) / 1000; // m the camera covers during one stream latency
          const pfAdeq = needM > 0 ? this.prefetchM / needM : Infinity;
          const nbd = this.newByDepth
            .map((c, d) => (c ? `${d}:${c}` : ''))
            .filter(Boolean)
            .join(',');
          // swap-delta (decisive): the morph=1 child-vs-parent discontinuity over the refinements this
          // window. dNrm large (≳ several °) and/or dPos large (≳ a few m) ⇒ the morph target doesn't
          // reproduce the parent leaf → mesher fix; ≈0 ⇒ a clean swap, so the visible step is the
          // slope-band shader threshold amplifying the per-leaf normal morph → shader fix.
          const swDPosAvg = this.swapN > 0 ? this.swapDPosSum / this.swapN : 0;
          const swDNrmAvg = this.swapN > 0 ? this.swapDNrmSum / this.swapN : 0;
          console.log(
            `[NMS step] A:floorWins=${fw.toFixed(0)}%(peak ${this.floorWinsMaxWin.toFixed(0)}%) lift=${fl.toFixed(2)} age=${fa}ms snap=${this.snapCount}(floor ${this.snapFloor}) | ` +
              `B:bornHist[≥.9=${this.bornHist[0]}/.7=${this.bornHist[1]}/.3=${this.bornHist[2]}/<.3=${this.bornHist[3]}] ` +
              `pf=${pfKm.toFixed(2)}km need=${(needM / 1000).toFixed(2)}km pfAdeq=${pfAdeq === Infinity ? '∞' : pfAdeq.toFixed(2)} | ` +
              `C:new[${nbd || 'none'}] | D:${this.nearDetailStr()} | ` +
              `swap[dPos=${this.swapDPosMax.toFixed(1)}m(avg ${swDPosAvg.toFixed(1)}) dNrm=${this.swapDNrmMax.toFixed(1)}°(avg ${swDNrmAvg.toFixed(1)}) n=${this.swapN}]`,
          );
          this.snapCount = 0;
          this.snapFloor = 0;
          this.floorWinsMaxWin = 0;
          this.newByDepth.length = 0;
          this.swapDPosMax = 0;
          this.swapDNrmMax = 0;
          this.swapDPosSum = 0;
          this.swapDNrmSum = 0;
          this.swapN = 0;
        }
      }
    }
  }

  /** CDLOD DISTANCE morph at a leaf's CENTRE (0=full near .. 1=parent far), BEFORE birth-ease —
   *  CPU mirror of the shader's `mFactor`. This is the "born morph" signal: ≈1 at the split
   *  distance (leaf born showing the parent surface = no pop), ≪1 if it arrived late. */
  private distanceMorph(e: Entry): number {
    if (this.kDist <= 0) return 0;
    const dx = e.center[0] - this.camX, dy = e.center[1] - this.camY, dz = e.center[2] - this.camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const depth = e.node.path.length;
    const lodR = lodBoundRadius(depth, this.radius);
    const parentR = depth > 0 ? lodBoundRadius(depth - 1, this.radius) : lodR * 2;
    const dChild = 2 * lodR * this.kDist;
    const dParent = 2 * parentR * this.kDist;
    const e0 = dChild + (dParent - dChild) * MORPH_START_FRAC;
    if (dParent <= e0) return 0;
    let t = (dist - e0) / (dParent - e0);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return t * t * (3 - 2 * t); // smoothstep — PURE distance morph (no birth; this is the bornM signal)
  }

  /** CDLOD morph at a leaf's CENTRE (0=full near .. 1=parent far) — CPU mirror of the DRAWN morph
   *  (distance morph, floored by the short birth-ease while the leaf is fresh). ?lodmorphdebug/?morphcolor. */
  private centerMorph(e: Entry): number {
    const m = this.distanceMorph(e);
    let birth = 1 - (this.clockMs - e.liveAtMs) / BIRTH_MS;
    if (birth < 0) birth = 0;
    return m > birth ? m : birth;
  }

  /** ?lodmorphdebug: the sub-camera leaf's depth, morph, distance, and fade band (km). */
  private nearLeafStr(): string {
    const { face, u, v } = this.faceUVOf(this.camX, this.camY, this.camZ);
    let best: Entry | null = null;
    for (const e of this.entries.values()) {
      if (e.status !== 'live' || e.node.face !== face) continue;
      const r = uvRectFromPath(e.node.path);
      if (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1) continue;
      if (!best || e.node.path.length > best.node.path.length) best = e;
    }
    if (!best) return 'near[none]';
    const depth = best.node.path.length;
    const dx = best.center[0] - this.camX, dy = best.center[1] - this.camY, dz = best.center[2] - this.camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dChild = 2 * lodBoundRadius(depth, this.radius) * this.kDist;
    const dParent = 2 * lodBoundRadius(depth > 0 ? depth - 1 : 0, this.radius) * (depth > 0 ? this.kDist : 2 * this.kDist);
    return `near[d=${depth} m=${this.centerMorph(best).toFixed(2)} dist=${(dist / 1000).toFixed(1)}km band=${(dChild / 1000).toFixed(1)}..${(dParent / 1000).toFixed(1)}km]`;
  }

  /** [NMS step] Candidate D: at the sub-camera leaf, the procedural-detail (texture) state — its geometry
   *  morph `mNear`, the detail weight `wMorph=1−mNear`, and the two distance gates `gA`/`gB` (CPU mirror of
   *  the shader smoothsteps). `gA`/`gB` are smooth functions of distance, so if the TEXTURE steps it must
   *  be `wMorph` (= the morph) stepping — i.e. the SAME root as A/B, not an independent detail schedule. */
  private nearDetailStr(): string {
    const { face, u, v } = this.faceUVOf(this.camX, this.camY, this.camZ);
    let best: Entry | null = null;
    for (const e of this.entries.values()) {
      if (e.status !== 'live' || e.node.face !== face) continue;
      const r = uvRectFromPath(e.node.path);
      if (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1) continue;
      if (!best || e.node.path.length > best.node.path.length) best = e;
    }
    if (!best) return 'mNear=- (none)';
    const dx = best.center[0] - this.camX, dy = best.center[1] - this.camY, dz = best.center[2] - this.camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const mNear = this.centerMorph(best);
    const wMorph = 1 - mNear;
    const ss = (e0: number, e1: number, x: number): number => {
      let t = (x - e0) / (e1 - e0);
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      return t * t * (3 - 2 * t);
    };
    const gA = ss(DETAIL_A_FAR_M, DETAIL_A_NEAR_M, dist);
    const gB = ss(DETAIL_B_FAR_M, DETAIL_B_NEAR_M, dist);
    return `mNear=${mNear.toFixed(2)} wMorph=${wMorph.toFixed(2)} gA=${gA.toFixed(2)} gB=${gB.toFixed(2)} texW≈${(wMorph * gA).toFixed(2)}/${(wMorph * gB).toFixed(2)}`;
  }

  // ───────────────────────── ?lodaudit helpers (debug-only, throttled) ─────────────────────────

  /** Width (km) of the sub-camera leaf's CDLOD morph band — to gauge prefetch significance. */
  private nearLeafBandKm(): number {
    const { face, u, v } = this.faceUVOf(this.camX, this.camY, this.camZ);
    let depth = -1;
    for (const e of this.entries.values()) {
      if (e.status !== 'live' || e.node.face !== face) continue;
      const r = uvRectFromPath(e.node.path);
      if (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1) continue;
      if (e.node.path.length > depth) depth = e.node.path.length;
    }
    if (depth < 0) return 0;
    const dChild = 2 * lodBoundRadius(depth, this.radius) * this.kDist;
    const dParent = 2 * lodBoundRadius(depth > 0 ? depth - 1 : 0, this.radius) * (depth > 0 ? this.kDist : 2 * this.kDist);
    return (dParent - dChild) / 1000;
  }

  /** Deepest LIVE leaf whose face-(u,v) rect contains a world direction, or null (= backdrop). */
  private liveLeafUnderDir(wx: number, wy: number, wz: number): Entry | null {
    const { face, u, v } = this.faceUVOf(wx, wy, wz);
    let best: Entry | null = null;
    for (const e of this.entries.values()) {
      if (e.status !== 'live' || e.node.face !== face) continue;
      const r = uvRectFromPath(e.node.path);
      if (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1) continue;
      if (!best || e.node.path.length > best.node.path.length) best = e;
    }
    return best;
  }

  /** Rendered CDLOD morph (0..1) for leaf `e` at world point P — the SAME formula the TSL shader
   *  applies per-vertex, evaluated on the CPU at an arbitrary point (distance morph; no birth-ease). */
  private effMorphAt(e: Entry, px: number, py: number, pz: number): number {
    const dx = px - this.camX, dy = py - this.camY, dz = pz - this.camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const depth = e.node.path.length;
    const lodR = lodBoundRadius(depth, this.radius);
    const parentR = depth > 0 ? lodBoundRadius(depth - 1, this.radius) : lodR * 2;
    const dChild = 2 * lodR * this.kDist;
    const dParent = 2 * parentR * this.kDist;
    const e0 = dChild + (dParent - dChild) * MORPH_START_FRAC;
    if (dParent <= e0) return 0;
    let t = (dist - e0) / (dParent - e0);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }

  /** Rendered radius (m) of leaf `e` at unit dir (dx,dy,dz): lerp(full surface, morph-target
   *  surface) by its morph `m` — what the geomorph actually draws there, for the cross-LOD gap
   *  metric. The parent term is terrainAt's `outLo` (sum of the first oct-1 octaves but normalized
   *  over ALL oct amplitudes) — BIT-IDENTICAL to the mesher's morphTarget (chunk.ts colDr), not a
   *  fresh (oct-1)-octave fBm (whose different normalization overstates the gap by ~oct's amplitude,
   *  maximal at m≈1 = exactly the boundary the seam scan probes). One eval returns both. */
  private renderedRadiusAt(e: Entry, dx: number, dy: number, dz: number, m: number): number {
    const octFull = lodOctaves(this.recipe, e.node.path.length);
    const scale = this.recipe.noiseScale;
    terrainAt(this.recipe, dx * scale, dy * scale, dz * scale, this._tA, this._tB, octFull);
    const tv = (1 - m) * this._tA[0]! + m * this._tB[0]!; // _tA = full detail, _tB = morph target (parent)
    return this.radius + this.recipe.height * tv;
  }

  /** Scan shared edges between live leaves; report the worst effective-LOD step (Δeff) and the
   *  rendered radial gap (m) there. Δeff≈0 & gap≈0 = truly seamless (no squares). O(live²·4),
   *  debug-only + throttled (same cost class as maxNeighborDelta). */
  private seamScan(): { dEffMax: number; dEffAvg: number; gapMax: number; worst: string } {
    let dEffMax = 0, dEffSum = 0, n = 0, gapMax = 0, worst = '-';
    let wA: Entry | null = null, wB: Entry | null = null, wx = 0, wy = 0, wz = 0;
    for (const e of this.entries.values()) {
      if (e.status !== 'live') continue;
      const r = uvRectFromPath(e.node.path);
      const um = (r.u0 + r.u1) / 2, vm = (r.v0 + r.v1) / 2;
      const hw = (r.u1 - r.u0) * 0.25, hh = (r.v1 - r.v0) * 0.25;
      const depthA = e.node.path.length;
      const probes: [number, number][] = [[r.u1 + hw, vm], [r.u0 - hw, vm], [um, r.v1 + hh], [um, r.v0 - hh]];
      for (const [pu, pv] of probes) {
        const w = wrapFaceUV(e.node.face, pu, pv);
        const d = faceDirection(w.face, w.u, w.v);
        const px = d[0] * this.radius, py = d[1] * this.radius, pz = d[2] * this.radius;
        const nb = this.liveLeafUnderDir(px, py, pz);
        if (!nb || nb === e) continue;
        const mA = this.effMorphAt(e, px, py, pz);
        const mB = this.effMorphAt(nb, px, py, pz);
        const dEff = Math.abs((depthA - mA) - (nb.node.path.length - mB));
        dEffSum += dEff; n++;
        if (dEff > dEffMax) {
          dEffMax = dEff; wA = e; wB = nb; wx = d[0]; wy = d[1]; wz = d[2];
          worst = `f${e.node.face}d${depthA}·d${nb.node.path.length}`;
        }
      }
    }
    if (wA && wB) {
      const px = wx * this.radius, py = wy * this.radius, pz = wz * this.radius;
      const mA = this.effMorphAt(wA, px, py, pz);
      const mB = this.effMorphAt(wB, px, py, pz);
      gapMax = Math.abs(this.renderedRadiusAt(wA, wx, wy, wz, mA) - this.renderedRadiusAt(wB, wx, wy, wz, mB));
    }
    return { dEffMax, dEffAvg: n > 0 ? dEffSum / n : 0, gapMax, worst };
  }

  /** Sample SURFACE directions over the visible cap (around the sub-camera point, out to the
   *  horizon, soft-capped by the view cone); count those covered by a LIVE leaf vs the backdrop
   *  (= "unloaded" holes). NB: directions are ORIGIN→surface (what faceUVOf/leaf rects use), NOT
   *  view rays. In walk/creative the forward-cone cut leaves the rest of the cap uncovered, so
   *  holes outside the look direction there are expected; the metric is decisive for orbit/fly. */
  private coverageScan(): { total: number; covered: number; holes: number } {
    const pc = Math.hypot(this.camX, this.camY, this.camZ) || 1;
    const cx = this.camX / pc, cy = this.camY / pc, cz = this.camZ / pc; // sub-camera surface dir
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(cy) > 0.99) { ax = 1; ay = 0; az = 0; }
    let rx = cy * az - cz * ay, ry = cz * ax - cx * az, rz = cx * ay - cy * ax;
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = cy * rz - cz * ry, uy = cz * rx - cx * rz, uz = cx * ry - cy * rx;
    const horizon = Math.acos(Math.min(1, this.radius / pc)); // angular radius of the visible cap
    const maxT = Math.min(horizon * 0.98, this.dbgHalfFov); // visible cap ∩ (approx) view cone
    const N = 96;
    let covered = 0;
    for (let i = 0; i < N; i++) {
      const theta = maxT * Math.sqrt((i + 0.5) / N); // area-uniform within the cap
      const phi = i * 2.399963; // golden-angle spiral
      const st = Math.sin(theta), ct = Math.cos(theta);
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const dx = ct * cx + st * (cp * rx + sp * ux);
      const dy = ct * cy + st * (cp * ry + sp * uy);
      const dz = ct * cz + st * (cp * rz + sp * uz);
      if (this.liveLeafUnderDir(dx, dy, dz)) covered++;
    }
    return { total: N, covered, holes: N - covered };
  }

  /** Upload up to `budget` finished meshes to the GPU this frame; returns how many. */
  uploadReady(budget: number): number {
    let n = 0;
    const dbg = !!this.opts.debugLodMorph;
    let freshThisFrame = 0; // fresh-over-backdrop appearances this frame (a visible pop)
    let freshDepthMin = 99, freshDepthMax = -1;
    while (n < budget && this.readyQueue.length > 0) {
      const key = this.readyQueue.shift()!;
      const e = this.entries.get(key);
      if (!e || e.status !== 'ready' || !e.ready) continue; // dropped meanwhile
      const m = e.ready;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(m.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(m.normals, 3));
      geometry.setAttribute('morphTarget', new BufferAttribute(m.morphTargets, 3));
      geometry.setAttribute('morphTargetNormal', new BufferAttribute(m.morphTargetNormals, 3));
      geometry.setIndex(new BufferAttribute(m.indices, 1));
      // Per-leaf CDLOD level (lodR, parentR) as a constant-per-leaf vertex attribute. The ONE shared
      // material's morph graph (terrainMaterial.ts) reads `aLevel` to build this leaf's split/merge
      // distances — so every leaf renders with the same material (no per-leaf clone / node-graph
      // rebuild). lodBoundRadius matches selectCut's metric, so the per-vertex distance-morph band
      // aligns with the cut's split distance exactly. dChild=2·lodR·kDist, dParent=2·parentR·kDist.
      const depth = e.node.path.length;
      const lodR = lodBoundRadius(depth, this.radius);
      const parentR = depth > 0 ? lodBoundRadius(depth - 1, this.radius) : lodR * 2;
      const vc = m.positions.length / 3;
      geometry.setAttribute('aLodR', new BufferAttribute(new Float32Array(vc).fill(lodR), 1));
      geometry.setAttribute('aParentR', new BufferAttribute(new Float32Array(vc).fill(parentR), 1));
      // Per-leaf go-live clock (ms) for the birth-ease floor: a leaf born late fades up from the
      // parent over BIRTH_MS instead of snapping in already-detailed (the bornM=0 pop).
      geometry.setAttribute('aBirthMs', new BufferAttribute(new Float32Array(vc).fill(this.clockMs), 1));
      // Render with the shared material. Debug-tint modes (?lodcolor/?skirtcolor/?morphcolor) clone
      // it and null its colorNode so a flat per-leaf colour shows (diagnostic + rare → clone cost is
      // fine, and the cloned graph still carries the morph nodes so the geomorph is unaffected).
      let mat = this.sharedMat;
      let ownMat: Material | null = null;
      if (this.opts.debugColor) {
        const clone = this.sharedMat.clone();
        (clone as unknown as { colorNode: unknown }).colorNode = null;
        const c = (clone as unknown as { color: Color }).color;
        if (this.opts.debugColor === 'lod') c.setHSL((depth * 0.13) % 1, 0.75, 0.5);
        else if (this.opts.debugColor === 'morph') c.setHSL(0.33, 0.85, 0.5); // green=full (tick recolors by distance)
        else c.copy(e.needsSkirt ? new Color(1, 0.15, 0.15) : new Color(0.16, 0.16, 0.2));
        mat = clone;
        ownMat = clone;
      }
      const mesh = new Mesh(geometry, mat);
      mesh.position.set(
        m.origin[0] - this.renderOrigin[0],
        m.origin[1] - this.renderOrigin[1],
        m.origin[2] - this.renderOrigin[2],
      );
      if (dbg) {
        // Classify the appearance: REFINE = a LIVE ancestor/descendant on this face already
        // covers the spot (the morph hides the swap); FRESH = nothing did → it appears over the
        // backdrop, the one pop CDLOD can't hide. Plus request→live stream latency. (self is
        // still 'ready' here, so it's excluded.)
        let covered = false;
        for (const o of this.entries.values()) {
          if (o.status !== 'live' || o.node.face !== e.node.face) continue;
          if (isPathPrefix(o.node.path, e.node.path) || isPathPrefix(e.node.path, o.node.path)) {
            covered = true;
            break;
          }
        }
        if (covered) {
          this.refineThisCut++;
          // [NMS step] swap-delta: only a REFINEMENT (live ancestor present) actually "swaps" a parent
          // for a child at morph=1; measure that discontinuity. Gated to ?lodaudit (the [NMS step] line).
          // It runs on the MAIN thread, so cap it: ≤8 leaves/window × perAxis 2 (4 samples) — enough for a
          // representative max/avg without becoming the hitch it measures during a zoom-in refine burst
          // (was up to 40 leaves × 16 samples per recut). Diagnostic only — no gameplay effect.
          if (this.opts.debugAudit && depth > 0 && this.swapN < 8) {
            const sd = swapDelta({ face: e.node.face, path: e.node.path, lod: depth }, this.recipe, this.radius, 2);
            if (sd.dPosMax > this.swapDPosMax) this.swapDPosMax = sd.dPosMax;
            if (sd.dNrmMaxDeg > this.swapDNrmMax) this.swapDNrmMax = sd.dNrmMaxDeg;
            this.swapDPosSum += sd.dPosAvg;
            this.swapDNrmSum += sd.dNrmAvgDeg;
            this.swapN++;
          }
        } else {
          this.freshThisCut++;
          freshThisFrame++;
          if (depth < freshDepthMin) freshDepthMin = depth;
          if (depth > freshDepthMax) freshDepthMax = depth;
        }
        const lat = this.clockMs - e.reqAtMs;
        this.reqLatSum += lat;
        this.reqLatN++;
        if (lat > this.reqLatMax) this.reqLatMax = lat;
      }
      e.mesh = mesh;
      e.mat = ownMat; // only a per-leaf debug clone is owned; the shared material is never disposed per-leaf
      e.center = m.origin;
      e.ready = null;
      e.status = 'live';
      e.morph = 0;
      e.liveAtMs = this.clockMs; // for ?lodmorphdebug age
      if (dbg) {
        // "Born morph": the DISTANCE morph this leaf has the instant it goes live (before
        // birth-ease). ≈1 ⇒ born at the parent surface and will resolve gradually as the
        // camera closes = no pop (what speed-aware prefetch buys); ≪1 ⇒ arrived late, the
        // camera is already past its morph band = a snap (what we're driving toward ~1).
        const bm = this.distanceMorph(e);
        this.bornMSum += bm;
        this.bornMN++;
        if (bm < this.bornMMin) this.bornMMin = bm;
        // [NMS step] B: born-morph distribution. Mass piling into the <.3 bucket ⇒ leaves arriving deep
        // inside their morph band (prefetch too short) → they appear part-detailed = a step.
        this.bornHist[bm >= 0.9 ? 0 : bm >= 0.7 ? 1 : bm >= 0.3 ? 2 : 3]++;
        // [NMS step] C: per-depth go-live cadence. A whole depth arriving as one batch (big newByDepth[d]
        // within one recut window, per the cut[Δt=…] interval) reads as a discrete "generation".
        this.newByDepth[depth] = (this.newByDepth[depth] ?? 0) + 1;
      }
      if (this.opts.debugAudit && !this.wiringLogged) {
        // One-time sanity: confirm the geomorph is wired on this build — geometry carries the
        // morph attributes (incl. the per-leaf aLevel + morphTargetNormal) AND the shared material
        // overrides both position & normal nodes.
        this.wiringLogged = true;
        const sm = this.sharedMat as unknown as { positionNode: unknown; normalNode: unknown };
        console.log(
          `[NMS audit] wiring: morphTargetNormal=${!!geometry.getAttribute('morphTargetNormal')} ` +
            `aLodR=${!!geometry.getAttribute('aLodR')} ` +
            `positionNode=${!!sm.positionNode} normalNode=${!!sm.normalNode}`,
        );
      }
      this.uploadedThisCut++;
      this.churnAccum++; // ?perf: a mesh was created+uploaded this frame
      this.scene.add(mesh);
      n++;
    }
    // A fresh leaf appears over the backdrop with nothing to morph from — the residual pop.
    // Log it the frame it happens so the user can correlate it with what they see.
    if (dbg && freshThisFrame > 0) {
      console.log(`[NMS pop] fresh=${freshThisFrame} depth=${freshDepthMin}..${freshDepthMax} (appeared over backdrop)`);
    }
    // A freshly-live leaf already renders at its correct CDLOD distance-morph (≈ parent at
    // the split distance), so any coarse ancestor it now covers can be dropped immediately.
    if (n > 0) this.purgeRetained();
    return n;
  }

  /** Live leaf meshes (for the ?clipdebug downward raycast). Debug-only. */
  terrainMeshes(): Mesh[] {
    const out: Mesh[] = [];
    for (const e of this.entries.values()) if (e.status === 'live' && e.mesh) out.push(e.mesh);
    return out;
  }

  /** Cube face + (u,v) of a world direction. face = argmax(dir·normal); cube = dir/(dir·normal). */
  private faceUVOf(wx: number, wy: number, wz: number): { face: number; u: number; v: number } {
    const inv = 1 / Math.sqrt(wx * wx + wy * wy + wz * wz);
    const dx = wx * inv, dy = wy * inv, dz = wz * inv;
    let face = 0, best = -Infinity;
    for (let f = 0; f < CUBE_FACES.length; f++) {
      const n = CUBE_FACES[f]!.normal;
      const d = dx * n[0] + dy * n[1] + dz * n[2];
      if (d > best) { best = d; face = f; }
    }
    const fb = CUBE_FACES[face]!;
    const nc = dx * fb.normal[0] + dy * fb.normal[1] + dz * fb.normal[2];
    const cx = dx / nc, cy = dy / nc, cz = dz / nc;
    return {
      face,
      u: cx * fb.uDir[0] + cy * fb.uDir[1] + cz * fb.uDir[2],
      v: cx * fb.vDir[0] + cy * fb.vDir[1] + cz * fb.vDir[2],
    };
  }

  /**
   * The deepest LIVE leaf whose face-(u,v) rect contains the world direction (wx,wy,wz),
   * with its quadtree depth + geomorph value — for ?clipdebug, to see whether the mesh
   * underfoot reached MAX_DEPTH and whether it's mid-morph. Debug-only (linear scan).
   */
  leafInfoUnder(wx: number, wy: number, wz: number): { depth: number; morph: number } | null {
    const { face, u, v } = this.faceUVOf(wx, wy, wz);
    let result: { depth: number; morph: number } | null = null;
    for (const e of this.entries.values()) {
      if (e.status !== 'live' || e.node.face !== face) continue;
      const r = uvRectFromPath(e.node.path);
      if (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1) continue;
      const depth = e.node.path.length;
      if (!result || depth > result.depth) result = { depth, morph: e.morph };
    }
    return result;
  }

  /**
   * All LIVE leaf meshes whose face-(u,v) rect contains the world direction — usually
   * 1, but several when coarse leaves are still retained over fine ones during LOD
   * churn. Pre-filters the player's collision raycast to these few meshes (not all ~380)
   * so it can floor the eye to whatever is actually DRAWN under it.
   */
  leavesUnder(wx: number, wy: number, wz: number): Mesh[] {
    const { face, u, v } = this.faceUVOf(wx, wy, wz);
    const out: Mesh[] = [];
    for (const e of this.entries.values()) {
      if (e.status !== 'live' || !e.mesh || e.node.face !== face) continue;
      const r = uvRectFromPath(e.node.path);
      if (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1) continue;
      out.push(e.mesh);
    }
    return out;
  }

  /** HUD line for ?lodmorphdebug (mid-morph count, avg progress, newest age, imbalance); under
   *  ?lodaudit also mirrors the [NMS audit] seam/coverage/cadence/health line. */
  morphInfo(): string {
    return this.opts.debugAudit && this.auditSummary
      ? `${this.morphSummary}\n${this.auditSummary}`
      : this.morphSummary;
  }

  stats(): StreamStats {
    let live = 0, pending = 0, inflight = 0;
    for (const e of this.entries.values()) {
      if (e.status === 'live') live++;
      else if (e.status === 'pending') pending++;
      else if (e.status === 'inflight') inflight++;
    }
    return { live, pending, inflight, ready: this.readyQueue.length, msPerLeaf: this.avgMs };
  }

  /** True while the detail front still has levels to climb toward the screen-space target (the clamp is
   *  holding the cut shallower than the target somewhere). The render loop recuts every ~RECUT_MAX_MS
   *  while this holds — even with the camera stationary — so a hard-zoom-then-stop keeps refining to full
   *  detail one level per generation, then settles (returns false) and the forced recuts stop. */
  isRefining(): boolean {
    return this.frontierActive;
  }

  /** ?perf: meshes created+disposed per second since the last call (resets the accumulator). High =
   *  the cut is thrashing (live count swinging) → GPU-buffer + geometry alloc/dispose churn = lag. */
  churnPerSec(): number {
    const dtS = (this.clockMs - this.churnClockMs) / 1000;
    const rate = dtS > 0 ? this.churnAccum / dtS : 0;
    this.churnAccum = 0;
    this.churnClockMs = this.clockMs;
    return Math.round(rate);
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const e of this.entries.values()) {
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
      }
      e.mat?.dispose(); // only per-leaf debug clones; the shared material is disposed once below
    }
    this.sharedMat.dispose();
    this.entries.clear();
  }

  private dist2(key: string, p: [number, number, number]): number {
    const c = this.entries.get(key)!.center;
    const dx = c[0] - p[0], dy = c[1] - p[1], dz = c[2] - p[2];
    return dx * dx + dy * dy + dz * dz;
  }

  /** Dispatch pending leaves to idle workers, nearest-first. */
  private pump(): void {
    while (this.idle.length > 0 && this.pendingQueue.length > 0) {
      const key = this.pendingQueue.pop()!; // nearest (array is far→near)
      const e = this.entries.get(key);
      if (!e || e.status !== 'pending') continue; // stale queue entry
      const w = this.idle.pop()!;
      e.status = 'inflight';
      const id = this.nextId++;
      this.jobKey.set(id, key);
      const depth = e.node.path.length;
      // needsSkirt is false unless skirts are enabled AND this edge lacks a same-LOD
      // neighbour, so non-transition leaves (incl. everything underfoot, where all
      // leaves clamp to OCT_MAX and are mutually watertight) get skirtDepth 0 — no grid.
      const oct = lodOctaves(this.recipe, depth);
      const skirtDepth = e.needsSkirt
        ? Math.min(
            SKIRT_MAX_M,
            Math.max(SKIRT_MIN_M, SKIRT_SAFETY * this.recipe.height * this.recipe.gain ** (oct - 1)),
          )
        : 0;
      const job: MeshJob & { id: number } = {
        id,
        req: { face: e.node.face, path: e.node.path, lod: depth },
        recipe: this.recipe,
        radius: this.radius,
        skirtDepth,
      };
      w.postMessage(job);
    }
  }

  private onMesh(res: MeshResult, w: Worker): void {
    this.idle.push(w);
    this.avgMs = this.avgMs === 0 ? res.ms : this.avgMs * 0.9 + res.ms * 0.1;
    const key = this.jobKey.get(res.id);
    this.jobKey.delete(res.id);
    if (key !== undefined) {
      const e = this.entries.get(key);
      if (e && e.status === 'inflight') {
        e.ready = res.mesh;
        e.status = 'ready';
        this.readyQueue.push(key);
      }
      // else: dropped from the cut while meshing — discard the result.
    }
    this.pump(); // feed the now-idle worker
  }
}
