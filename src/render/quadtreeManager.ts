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

import { Scene, Mesh, BufferGeometry, BufferAttribute, Color, type Material } from 'three';
import { uniform, mix, attribute, positionLocal } from 'three/tsl';
import {
  selectCut,
  nodeBounds,
  retainedShouldRemove,
  type CameraView,
  type QuadNode,
} from '../core/quadtree.ts';
import { chunkKey, uvRectFromPath, type ChunkMesh, type MeshJob } from '../core/chunk.ts';
import { faceDirection, CUBE_FACES } from '../core/cubesphere.ts';
import { lodOctaves, type TerrainRecipe } from '../core/density.ts';

/** A TSL uniform node carrying a single float (the per-leaf morph factor). */
type MorphUniform = ReturnType<typeof uniform>;
/** Node materials expose positionNode; the base is typed as plain Material here. */
interface NodeMaterialLike {
  positionNode: unknown;
}

type Status = 'pending' | 'inflight' | 'ready' | 'live';
interface Entry {
  node: QuadNode;
  status: Status;
  center: [number, number, number];
  mesh: Mesh | null;
  mat: Material | null; // per-leaf material clone (carries the leaf's own morph uniform)
  morphUniform: MorphUniform | null; // 0 = coarse/parent-like, 1 = full detail
  ready: ChunkMesh | null;
  morph: number; // 0..1 geomorph-in progress (drives morphUniform)
  needsSkirt: boolean; // does any edge lack a same-LOD neighbour in the cut?
  liveAtMs: number; // manager clock when this leaf went live (for ?lodmorphdebug age)
}
interface MeshResult {
  id: number;
  mesh: ChunkMesh;
  ms: number;
}

/** LOD geomorph duration (ms): detail morphs in over this long instead of snapping. */
const MORPH_MS = 350;

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
   * Recompute the cut and reconcile. `lookahead` is the world point to prioritize
   * around (camera position biased along its velocity) so leaves ahead of motion
   * mesh first.
   */
  update(camera: CameraView, lookahead: [number, number, number], splitPx?: number): void {
    this.uploadedThisCut = 0; // count leaves streamed in for THIS cut (?lodmorphdebug)
    const cut = selectCut(camera, {
      radius: this.radius,
      heightMargin: this.heightMargin,
      splitPx: splitPx ?? this.opts.splitPx,
      maxDepth: this.opts.maxDepth,
    });

    const wanted = new Set<string>();
    for (const node of cut) {
      const key = chunkKey({ face: node.face, path: node.path, lod: node.path.length });
      wanted.add(key);
      if (!this.entries.has(key)) {
        const b = nodeBounds(node.face, node.path, this.radius, 0);
        this.entries.set(key, {
          node,
          status: 'pending',
          center: b.center,
          mesh: null,
          mat: null,
          morphUniform: null,
          ready: null,
          morph: 0,
          needsSkirt: true, // set below from the full cut, before dispatch
          liveAtMs: 0,
        });
      }
    }
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
      // A replacement only "covers" once it's live AND has finished morphing in.
      if (e) wantedArr.push({ node: e.node, live: e.status === 'live' && e.morph >= 1 });
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
   * Advance LOD geomorphs — call once per frame. Newly-live leaves morph in
   * (morph 0→1 over MORPH_MS); when one finishes, drop its polygon-offset bias and
   * purge any retained leaf it now fully covers.
   */
  tick(dtMs: number): void {
    if (this.entries.size === 0) return;
    this.clockMs += dtMs; // resume-safe clock (no Date.now) + the ?lodmorphdebug age base
    const step = dtMs / MORPH_MS;
    const dbg = !!this.opts.debugLodMorph;
    const tintMorph = this.opts.debugColor === 'morph';
    let anyCompleted = false;
    let live = 0, mid = 0, sum = 0, mn = 1, mx = 0, newestLive = -1, slowestMidAge = 0;
    for (const e of this.entries.values()) {
      if (e.status !== 'live') continue;
      live++;
      if (e.morph < 1 && e.morphUniform) {
        e.morph = Math.min(1, e.morph + step);
        e.morphUniform.value = e.morph;
        // ?morphcolor: red (just-appeared) → green (settled), so the pop is visible.
        if (tintMorph && e.mat) (e.mat as unknown as { color: Color }).color.setHSL(0.33 * e.morph, 0.85, 0.5);
        if (e.morph >= 1) {
          if (e.mat) e.mat.polygonOffset = false; // settle depth once fully resolved
          anyCompleted = true;
        }
      }
      if (dbg) {
        if (e.liveAtMs > newestLive) newestLive = e.liveAtMs;
        if (e.morph < 1) {
          mid++; sum += e.morph;
          if (e.morph < mn) mn = e.morph;
          if (e.morph > mx) mx = e.morph;
          const age = this.clockMs - e.liveAtMs;
          if (age > slowestMidAge) slowestMidAge = age;
        }
      }
    }
    if (anyCompleted) this.purgeRetained();
    if (dbg) {
      const avg = mid > 0 ? sum / mid : 0;
      const newestAge = newestLive >= 0 ? (this.clockMs - newestLive) | 0 : 0;
      this.morphSummary = `morph mid=${mid} avg=${avg.toFixed(2)} new=${newestAge}ms maxNbrΔ=${this.maxNbrDelta}`;
      if (++this.lodMorphLogN % 10 === 0) {
        console.log(
          `[NMS morph] live=${live} mid=${mid} morph[min=${mid ? mn.toFixed(2) : '-'} ` +
            `avg=${avg.toFixed(2)} max=${mid ? mx.toFixed(2) : '-'}] ` +
            `newest=${newestAge}ms slowestMid=${slowestMidAge | 0}ms ` +
            `uploads/cut=${this.uploadedThisCut} maxNbrΔ=${this.maxNbrDelta}`,
        );
      }
    }
  }

  /** Upload up to `budget` finished meshes to the GPU this frame; returns how many. */
  uploadReady(budget: number): number {
    let n = 0;
    while (n < budget && this.readyQueue.length > 0) {
      const key = this.readyQueue.shift()!;
      const e = this.entries.get(key);
      if (!e || e.status !== 'ready' || !e.ready) continue; // dropped meanwhile
      const m = e.ready;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(m.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(m.normals, 3));
      geometry.setAttribute('morphTarget', new BufferAttribute(m.morphTargets, 3));
      geometry.setIndex(new BufferAttribute(m.indices, 1));
      // Per-leaf material clone carrying its OWN morph uniform: the vertex position
      // lerps morphTarget→full as morph goes 0→1, so detail resolves in as a single
      // opaque surface. Biased toward the camera so it wins the depth test over the
      // retained leaf it's morphing in over (tick() settles the bias once done).
      const mat = this.material.clone();
      if (this.opts.debugColor) {
        const c = (mat as unknown as { color: Color }).color;
        if (this.opts.debugColor === 'lod') c.setHSL((e.node.path.length * 0.13) % 1, 0.75, 0.5);
        else if (this.opts.debugColor === 'morph') c.setHSL(0, 0.85, 0.5); // red at morph 0 (tick recolors)
        else c.copy(e.needsSkirt ? new Color(1, 0.15, 0.15) : new Color(0.16, 0.16, 0.2));
      }
      const mu = uniform(0);
      (mat as unknown as NodeMaterialLike).positionNode = mix(
        attribute('morphTarget', 'vec3'),
        positionLocal,
        mu,
      );
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -1;
      const mesh = new Mesh(geometry, mat);
      mesh.position.set(
        m.origin[0] - this.renderOrigin[0],
        m.origin[1] - this.renderOrigin[1],
        m.origin[2] - this.renderOrigin[2],
      );
      e.mesh = mesh;
      e.mat = mat;
      e.morphUniform = mu;
      e.center = m.origin;
      e.ready = null;
      e.status = 'live';
      e.morph = 0;
      e.liveAtMs = this.clockMs; // for ?lodmorphdebug age/staggering
      this.uploadedThisCut++;
      this.scene.add(mesh);
      n++;
    }
    return n; // purge happens in tick() when morphs complete, and in update()
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

  /** HUD line for ?lodmorphdebug (mid-morph count, avg progress, newest age, imbalance). */
  morphInfo(): string {
    return this.morphSummary;
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
