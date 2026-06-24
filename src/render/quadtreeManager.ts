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

import { Scene, Mesh, BufferGeometry, BufferAttribute, type Material } from 'three';
import {
  selectCut,
  nodeBounds,
  retainedShouldRemove,
  type CameraView,
  type QuadNode,
} from '../core/quadtree.ts';
import { chunkKey, type ChunkMesh, type MeshJob } from '../core/chunk.ts';
import type { TerrainRecipe } from '../core/density.ts';

type Status = 'pending' | 'inflight' | 'ready' | 'live';
interface Entry {
  node: QuadNode;
  status: Status;
  center: [number, number, number];
  mesh: Mesh | null;
  ready: ChunkMesh | null;
}
interface MeshResult {
  id: number;
  mesh: ChunkMesh;
  ms: number;
}

export interface ManagerOpts {
  splitPx: number;
  maxDepth: number;
  workers?: number; // pool size (default: min(6, cores-1))
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
  update(camera: CameraView, lookahead: [number, number, number]): void {
    const cut = selectCut(camera, {
      radius: this.radius,
      heightMargin: this.heightMargin,
      splitPx: this.opts.splitPx,
      maxDepth: this.opts.maxDepth,
    });

    const wanted = new Set<string>();
    for (const node of cut) {
      const key = chunkKey({ face: node.face, path: node.path, lod: node.path.length });
      wanted.add(key);
      if (!this.entries.has(key)) {
        const b = nodeBounds(node.face, node.path, this.radius, 0);
        this.entries.set(key, { node, status: 'pending', center: b.center, mesh: null, ready: null });
      }
    }
    this.wanted = wanted;
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

  /** Remove retained (live, no-longer-wanted) leaves whose replacement is ready. */
  private purgeRetained(): void {
    if (this.wanted.size === 0) return;
    const wantedArr: { node: QuadNode; live: boolean }[] = [];
    for (const key of this.wanted) {
      const e = this.entries.get(key);
      if (e) wantedArr.push({ node: e.node, live: e.status === 'live' });
    }
    for (const [key, e] of this.entries) {
      if (e.status !== 'live' || this.wanted.has(key)) continue;
      if (retainedShouldRemove(e.node, wantedArr)) {
        if (e.mesh) {
          this.scene.remove(e.mesh);
          e.mesh.geometry.dispose();
        }
        this.entries.delete(key);
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
      geometry.setIndex(new BufferAttribute(m.indices, 1));
      const mesh = new Mesh(geometry, this.material);
      mesh.position.set(
        m.origin[0] - this.renderOrigin[0],
        m.origin[1] - this.renderOrigin[1],
        m.origin[2] - this.renderOrigin[2],
      );
      e.mesh = mesh;
      e.center = m.origin;
      e.ready = null;
      e.status = 'live';
      this.scene.add(mesh);
      n++;
    }
    if (n > 0) this.purgeRetained(); // newly-live leaves may now cover retained ones
    return n;
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
      const leafTangential = ((this.radius * Math.PI) / 2) / 2 ** depth;
      const skirtDepth = Math.max(
        this.recipe.height * 0.25,
        Math.min(this.recipe.height * 2, leafTangential * 0.04),
      );
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
