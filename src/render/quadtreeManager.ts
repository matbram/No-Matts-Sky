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

import { Scene, Mesh, BufferGeometry, BufferAttribute, Color, Vector2, type Material } from 'three';
import {
  uniform,
  mix,
  attribute,
  positionLocal,
  positionWorld,
  cameraPosition,
  smoothstep,
} from 'three/tsl';
import {
  selectCut,
  nodeBounds,
  lodBoundRadius,
  retainedShouldRemove,
  isPathPrefix,
  type CameraView,
  type QuadNode,
} from '../core/quadtree.ts';
import { chunkKey, uvRectFromPath, type ChunkMesh, type MeshJob } from '../core/chunk.ts';
import { faceDirection, wrapFaceUV, CUBE_FACES } from '../core/cubesphere.ts';
import { lodOctaves, terrainAt, type TerrainRecipe } from '../core/density.ts';

/** Node materials expose positionNode/normalNode; the base is typed as plain Material here. */
interface NodeMaterialLike {
  positionNode: unknown;
  normalNode: unknown;
}

type Status = 'pending' | 'inflight' | 'ready' | 'live';
interface Entry {
  node: QuadNode;
  status: Status;
  center: [number, number, number];
  mesh: Mesh | null;
  mat: Material | null; // per-leaf material clone (carries the leaf's own CDLOD level uniform)
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

/**
 * CDLOD morph region: a leaf shows full detail until the camera recedes to this fraction of
 * the way from its split distance to its merge (parent) distance, then morphs to the parent
 * surface by the merge distance — so detail fades continuously with distance and a leaf
 * matches the coarser neighbour exactly at the shared LOD boundary. Used identically in the
 * TSL shader (per-vertex) and `centerMorph` (CPU, for ?lodmorphdebug/?morphcolor).
 */
const MORPH_START_FRAC = 0.55;

/**
 * Birth-ease (ms): a newly-live leaf starts at morph=1 (= the parent surface it replaces, so its
 * appearance is invisible) and eases to its true distance-morph over this long. Hides late-streaming
 * refinements (which would otherwise snap in already-detailed past their morph-start distance) by
 * fading them up from the parent. At normal speed distanceMorph≈1 at birth too, so it's a no-op.
 */
const BIRTH_MS = 300;

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
  workers?: number; // pool size (default: min(6, cores-1))
  skirts?: boolean; // enable LOD-transition skirts (default OFF — the apron already covers
  // holes at LOD transitions, and the skirts were the visible boundary grid; ?skirt re-enables)
  debugColor?: 'lod' | 'skirt' | 'morph'; // debug tint: LOD level / skirted leaves / morph progress
  debugLodMorph?: boolean; // ?lodmorphdebug: throttled [NMS morph] console line + balance metric
  debugAudit?: boolean; // ?lodaudit: SUPERSET — also [NMS audit] (seam/coverage/cadence/health)
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
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly heightMargin: number;
  private nextId = 1;
  private renderOrigin: [number, number, number] = [0, 0, 0];
  private avgMs = 0;
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
  // CDLOD geomorph: one shared uniform = (viewportHeight/(2·tan(fovY/2)))/splitPx — the
  // same projected-size constant selectCut uses, so the per-vertex distance morph band
  // aligns with the split distance (set per frame by the render shell). The camera world
  // position (render space) is mirrored on the CPU only to compute the leaf-CENTRE morph
  // for ?lodmorphdebug/?morphcolor; the actual morph is per-vertex in TSL via cameraPosition.
  private readonly kDistUniform = uniform(0);
  private readonly uNowUniform = uniform(0); // manager clock (ms) for the per-leaf birth-ease
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
    private readonly material: Material,
    private readonly recipe: TerrainRecipe,
    private readonly radius: number,
    private readonly opts: ManagerOpts,
  ) {
    this.heightMargin = recipe.height * 1.6;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(1, Math.min(opts.workers ?? 6, cores - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('../workers/mesher.worker.ts', import.meta.url), {
        type: 'module',
      });
      w.onmessage = (e: MessageEvent<MeshResult>): void => this.onMesh(e.data, w);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Re-center the render frame; reposition all live meshes relative to it. */
  setRenderOrigin(o: [number, number, number]): void {
    this.renderOrigin = o;
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
    this.prefetchM = prefetchM; // for ?lodmorphdebug readout
    if (this.opts.debugAudit) {
      // Recut cadence (the "detail arrives in waves" signal) + the view cone for the coverage/seam probes.
      const since = this.clockMs - this.dbgLastCutMs;
      this.dbgCutIntervalMs = this.dbgCutIntervalMs === 0 ? since : this.dbgCutIntervalMs * 0.8 + since * 0.2;
      this.dbgLastCutMs = this.clockMs;
      if (camera.halfFov !== undefined) this.dbgHalfFov = camera.halfFov;
    }
    let leavesAdded = 0;
    const cut = selectCut(camera, {
      radius: this.radius,
      heightMargin: this.heightMargin,
      splitPx: splitPx ?? this.opts.splitPx,
      maxDepth: this.opts.maxDepth,
      // Speed-aware prefetch: request finer leaves early so the CDLOD morph fades them
      // in continuously (no late snap). approachSpeed·leadTime is computed render-side.
      prefetchM,
    });

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
      // Cut imbalance: max LOD-level difference across any shared edge. >1 means a deep
      // block abuts a much coarser leaf (a hard step) → CDLOD will need balanceCut.
      this.maxNbrDelta = this.maxNeighborDelta();
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
    this.uNowUniform.value = this.clockMs; // drive the per-leaf birth-ease (always, even when debug off)
    const dbg = !!this.opts.debugLodMorph;
    const tintMorph = this.opts.debugColor === 'morph';
    if (!dbg && !tintMorph) return; // CDLOD morph is in-shader; nothing else to do
    let live = 0, mid = 0, sum = 0, mn = 1, mx = 0, newestLive = -1;
    // ?lodaudit morph histogram buckets: [m<.1, .1–.3, .3–.7, .7–.9, >.9]. Bimodal (full pile at
    // <.1 and >.9, few between) ⇒ steps at the transition ring; a smooth spread ⇒ graded morph.
    let h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0;
    for (const e of this.entries.values()) {
      if (e.status !== 'live') continue;
      live++;
      const m = this.centerMorph(e);
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
      }
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
          const seam = this.seamScan();
          const cov = this.coverageScan();
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
    return t * t * (3 - 2 * t); // smoothstep
  }

  /** CDLOD morph at a leaf's CENTRE with the birth-ease floor (the value actually drawn). */
  private centerMorph(e: Entry): number {
    const distanceM = this.distanceMorph(e);
    // Birth-ease floor (mirrors the shader): a fresh leaf reads m=1 (parent) then decays.
    let birth = 1 - (this.clockMs - e.liveAtMs) / BIRTH_MS;
    if (birth < 0) birth = 0;
    return distanceM > birth ? distanceM : birth;
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

  /** Rendered CDLOD morph (0..1, incl birth-ease) for leaf `e` at world point P — the SAME
   *  formula the TSL shader applies per-vertex, evaluated on the CPU at an arbitrary point. */
  private effMorphAt(e: Entry, px: number, py: number, pz: number): number {
    const dx = px - this.camX, dy = py - this.camY, dz = pz - this.camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const depth = e.node.path.length;
    const lodR = lodBoundRadius(depth, this.radius);
    const parentR = depth > 0 ? lodBoundRadius(depth - 1, this.radius) : lodR * 2;
    const dChild = 2 * lodR * this.kDist;
    const dParent = 2 * parentR * this.kDist;
    const e0 = dChild + (dParent - dChild) * MORPH_START_FRAC;
    let m = 0;
    if (dParent > e0) {
      let t = (dist - e0) / (dParent - e0);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      m = t * t * (3 - 2 * t);
    }
    let birth = 1 - (this.clockMs - e.liveAtMs) / BIRTH_MS;
    if (birth < 0) birth = 0;
    return m > birth ? m : birth;
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
      const mat = this.material.clone();
      if (this.opts.debugColor) {
        const c = (mat as unknown as { color: Color }).color;
        if (this.opts.debugColor === 'lod') c.setHSL((e.node.path.length * 0.13) % 1, 0.75, 0.5);
        else if (this.opts.debugColor === 'morph') c.setHSL(0.33, 0.85, 0.5); // green=full (tick recolors by distance)
        else c.copy(e.needsSkirt ? new Color(1, 0.15, 0.15) : new Color(0.16, 0.16, 0.2));
      }
      // CDLOD geomorph (per-vertex, in-shader): the vertex lerps full detail → the
      // one-octave-coarser parent surface as a smooth function of CAMERA DISTANCE, reaching
      // the parent exactly at this leaf's split distance (dParent). So detail fades in
      // continuously across the whole view as you approach — no per-leaf time wave — and the
      // edge stays matched to a coarser neighbour (which renders ITS full detail there). The
      // band uses the SAME projected-size constants as selectCut (lodBoundRadius · kDist).
      const depth = e.node.path.length;
      const lodR = lodBoundRadius(depth, this.radius);
      const parentR = depth > 0 ? lodBoundRadius(depth - 1, this.radius) : lodR * 2;
      const uLevel = uniform(new Vector2(lodR, parentR)); // .x = child bound, .y = parent bound
      const dChild = uLevel.x.mul(2).mul(this.kDistUniform);
      const dParent = uLevel.y.mul(2).mul(this.kDistUniform);
      const e0 = mix(dChild, dParent, MORPH_START_FRAC);
      const dist = positionWorld.distance(cameraPosition); // render space → small floats
      const mFactor = smoothstep(e0, dParent, dist); // 0 near (full) → 1 far (parent)
      // Birth-ease FLOOR: start at 1 (= the parent surface this leaf replaces → its appearance is
      // invisible) and decay to the distance-morph over BIRTH_MS, so a refinement that streamed in
      // LATE (camera already past its morph-start) fades up from the parent instead of snapping in
      // already-detailed. uBirth is per-leaf (set once here); uNow is one global clock uniform.
      const uBirth = uniform(this.clockMs);
      const birthEase = this.uNowUniform.sub(uBirth).div(BIRTH_MS).oneMinus().clamp(0, 1);
      const mFinal = mFactor.max(birthEase);
      (mat as unknown as NodeMaterialLike).positionNode = mix(
        positionLocal,
        attribute('morphTarget', 'vec3'),
        mFinal,
      );
      // Morph the NORMAL by the SAME factor — the other half of the geomorph. Without this,
      // a leaf whose GEOMETRY has morphed smooth toward its parent still SHADES with the
      // fine analytic normals, so the high-frequency detail stays lit across the morph zone
      // and stops abruptly at the LOD boundary (the "highly textured square"). Blending to
      // the parent-surface normal (morphTargetNormal) keeps shading in lockstep with the
      // morphed surface → the boundary becomes a smooth gradient. Re-normalize after the mix.
      (mat as unknown as NodeMaterialLike).normalNode = mix(
        attribute('normal', 'vec3'),
        attribute('morphTargetNormal', 'vec3'),
        mFinal,
      ).normalize();
      // Bias the finer leaf toward the camera so it wins the depth test over a coarser
      // ancestor still retained for the brief moment until purge (surfaces match there, so
      // no morph divergence to fight — unlike the old 350 ms time morph).
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -1;
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
        if (covered) this.refineThisCut++;
        else {
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
      e.mat = mat;
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
      }
      if (this.opts.debugAudit && !this.wiringLogged) {
        // One-time sanity: confirm the geomorph SHADING (Part 6) is actually wired on this build —
        // geometry carries morphTargetNormal AND the material overrides both position & normal nodes.
        this.wiringLogged = true;
        const ml = mat as unknown as NodeMaterialLike;
        console.log(
          `[NMS audit] wiring: morphTargetNormal=${!!geometry.getAttribute('morphTargetNormal')} ` +
            `positionNode=${!!ml.positionNode} normalNode=${!!ml.normalNode}`,
        );
      }
      this.uploadedThisCut++;
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

  /**
   * Max LOD-level difference across any shared edge of the WANTED cut (?lodmorphdebug).
   * For each wanted leaf, step a quarter-cell past each of its 4 edge midpoints and find
   * the wanted leaf covering that direction; the largest |depthΔ| is the worst step. 0/1
   * = balanced; >1 means CDLOD needs a balanceCut to avoid a visible boundary. Debug-only
   * (O(leaves²) containment scan, run only on a cut while the flag is on).
   */
  private maxNeighborDelta(): number {
    let maxD = 0;
    for (const key of this.wanted) {
      const e = this.entries.get(key)!;
      const r = uvRectFromPath(e.node.path);
      const um = (r.u0 + r.u1) / 2, vm = (r.v0 + r.v1) / 2;
      const hw = (r.u1 - r.u0) * 0.25, hh = (r.v1 - r.v0) * 0.25;
      const depth = e.node.path.length;
      const probes: [number, number][] = [
        [r.u1 + hw, vm], [r.u0 - hw, vm], [um, r.v1 + hh], [um, r.v0 - hh],
      ];
      for (const [pu, pv] of probes) {
        const d = faceDirection(e.node.face, pu, pv);
        const nd = this.depthUnderWanted(d[0], d[1], d[2]);
        if (nd >= 0) { const diff = Math.abs(depth - nd); if (diff > maxD) maxD = diff; }
      }
    }
    return maxD;
  }

  /** Depth of the wanted leaf covering a world direction (the cut tiles the sphere), or -1. */
  private depthUnderWanted(wx: number, wy: number, wz: number): number {
    const { face, u, v } = this.faceUVOf(wx, wy, wz);
    let best = -1;
    for (const key of this.wanted) {
      const e = this.entries.get(key)!;
      if (e.node.face !== face) continue;
      const r = uvRectFromPath(e.node.path);
      if (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1) continue;
      const d = e.node.path.length;
      if (d > best) best = d;
    }
    return best;
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

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const e of this.entries.values()) {
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
      }
      e.mat?.dispose();
    }
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
