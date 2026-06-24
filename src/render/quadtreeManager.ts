// ─────────────────────────────────────────────────────────────────────────────
// Quadtree LOD manager (render side) — Step 2.
//
// Drives the visible leaf cut: each update it asks the pure core for the cut
// (selectCut), requests any MISSING leaves from the mesher worker, and drops
// leaves no longer in the cut. Finished meshes are cached by chunk key, so
// re-entering a region is instant. A worker POOL + per-frame upload budgeting is
// Step 3; here a single worker meshes leaves as requests arrive.
//
// Render placement uses a `renderOrigin` (recentered on the camera target) so the
// GPU only sees small floats at any altitude — a minimal preview of the floating
// origin; the full per-frame, body-fixed version is Step 4.
// ─────────────────────────────────────────────────────────────────────────────

import { Scene, Mesh, BufferGeometry, BufferAttribute, type Material } from 'three';
import { selectCut, type CameraView, type QuadNode } from '../core/quadtree.ts';
import { chunkKey, type ChunkMesh, type MeshJob } from '../core/chunk.ts';
import type { TerrainRecipe } from '../core/density.ts';

interface Entry {
  mesh: Mesh | null;
  origin: [number, number, number];
}
interface MeshResult {
  id: number;
  mesh: ChunkMesh;
}

export interface ManagerOpts {
  splitPx: number;
  maxDepth: number;
}

export class QuadtreeManager {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<number, string>();
  private readonly worker: Worker;
  private readonly heightMargin: number;
  private nextId = 1;
  private renderOrigin: [number, number, number] = [0, 0, 0];

  constructor(
    private readonly scene: Scene,
    private readonly material: Material,
    private readonly recipe: TerrainRecipe,
    private readonly radius: number,
    private readonly opts: ManagerOpts,
  ) {
    this.heightMargin = recipe.height * 1.6;
    this.worker = new Worker(new URL('../workers/mesher.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<MeshResult>): void => this.onMesh(e.data);
  }

  /** Re-center the render frame; reposition all live meshes relative to it. */
  setRenderOrigin(o: [number, number, number]): void {
    this.renderOrigin = o;
    for (const e of this.entries.values()) {
      if (e.mesh) e.mesh.position.set(e.origin[0] - o[0], e.origin[1] - o[1], e.origin[2] - o[2]);
    }
  }

  /** Recompute the cut for the given world-space camera and reconcile the leaf set. */
  update(camera: CameraView): void {
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
        this.entries.set(key, { mesh: null, origin: [0, 0, 0] });
        this.request(node, key);
      }
    }
    for (const [key, e] of this.entries) {
      if (!wanted.has(key)) {
        if (e.mesh) {
          this.scene.remove(e.mesh);
          e.mesh.geometry.dispose();
        }
        this.entries.delete(key);
      }
    }
  }

  get leafCount(): number {
    return this.entries.size;
  }

  dispose(): void {
    this.worker.terminate();
    for (const e of this.entries.values()) {
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
      }
    }
    this.entries.clear();
  }

  private request(node: QuadNode, key: string): void {
    const id = this.nextId++;
    this.pending.set(id, key);
    // Skirt depth scales with leaf size (coarse leaves bridge bigger LOD gaps),
    // clamped so it always covers terrain relief but never becomes a giant wall.
    const leafTangential = ((this.radius * Math.PI) / 2) / 2 ** node.path.length;
    const skirtDepth = Math.max(
      this.recipe.height * 0.25,
      Math.min(this.recipe.height * 2, leafTangential * 0.04),
    );
    const job: MeshJob & { id: number } = {
      id,
      req: { face: node.face, path: node.path, lod: node.path.length },
      recipe: this.recipe,
      radius: this.radius,
      skirtDepth,
    };
    this.worker.postMessage(job);
  }

  private onMesh(res: MeshResult): void {
    const key = this.pending.get(res.id);
    this.pending.delete(res.id);
    if (key === undefined) return;
    const entry = this.entries.get(key);
    if (!entry) return; // dropped from the cut while in flight — discard

    const m = res.mesh;
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
    entry.mesh = mesh;
    entry.origin = m.origin;
    this.scene.add(mesh);
  }
}
