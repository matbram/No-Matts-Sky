// ─────────────────────────────────────────────────────────────────────────────
// Chunk meshing — PURE TS, no Three.js. Step 1.
//
// The core's public interface (slice spec §4): a ChunkRequest (which cube-sphere
// patch) in, a ChunkMesh (plain transferable buffers) out. Step 1 meshes ONE
// quadtree leaf; the quadtree LOD that drives MANY of them is Step 2, streaming
// is Step 3.
//
// For a leaf we sample the density field over a thin (u, v, radial) voxel shell
// bracketing the surface, projecting each grid point onto the sphere via the
// shared `faceDirection`, then run Surface Nets. Vertices come back RELATIVE to
// the chunk's world `origin` (a double), so the GPU only ever sees small floats —
// the floating-origin seam (Step 4) without the per-frame machinery yet.
// ─────────────────────────────────────────────────────────────────────────────

import { faceDirection } from './cubesphere.ts';
import { densityAt, type TerrainRecipe } from './density.ts';
import { surfaceNets, type AABB, type SampledField } from './surfacenets.ts';

/** A chunk address: a cube face + a quadtree path of quadrants (0..3). */
export interface ChunkRequest {
  face: number; // 0..5, the cube-sphere face (cubesphere.ts CUBE_FACES order)
  path: number[]; // quadtree path; quadrant q: bit0 = +u half, bit1 = +v half
  lod: number; // detail level (= path.length by convention)
}

/** A meshed chunk — plain data, buffers transferred (not copied) to the main thread. */
export interface ChunkMesh {
  positions: Float32Array; // x,y,z per vertex, RELATIVE to `origin`
  normals: Float32Array;
  indices: Uint32Array;
  origin: [number, number, number]; // double world offset to add back at render
  bounds: AABB; // local space (same frame as positions)
  vertexCount: number;
  triangleCount: number;
  lod: number;
  key: string;
}

/** A self-contained meshing job (what crosses to the worker). */
export interface MeshJob {
  req: ChunkRequest;
  recipe: TerrainRecipe;
  radius: number;
}

/** Default grid resolution: fine tangentially, modest radially (a thin shell). [T] */
export const CHUNK_GRID_TANGENTIAL = 48;
export const CHUNK_GRID_RADIAL = 16;

/** Stable string key for a chunk (cache key, slice spec §4 "key by coordinate"). */
export function chunkKey(req: ChunkRequest): string {
  return `f${req.face}/${req.path.join('')}/l${req.lod}`;
}

/** The face-(u,v) rectangle a quadtree path selects, starting from the full [-1,1]² face. */
export function uvRectFromPath(path: number[]): { u0: number; u1: number; v0: number; v1: number } {
  let u0 = -1, u1 = 1, v0 = -1, v1 = 1;
  for (const q of path) {
    const um = (u0 + u1) / 2;
    const vm = (v0 + v1) / 2;
    if (q & 1) u0 = um;
    else u1 = um;
    if (q & 2) v0 = vm;
    else v1 = vm;
  }
  return { u0, u1, v0, v1 };
}

/**
 * Mesh one chunk: sample D over its (u,v,radial) voxel shell and extract the
 * surface with Surface Nets. `tan`/`rad` override the grid resolution (tests use
 * small grids; the worker uses the defaults).
 */
export function meshChunk(
  req: ChunkRequest,
  recipe: TerrainRecipe,
  radius: number,
  tan: number = CHUNK_GRID_TANGENTIAL,
  rad: number = CHUNK_GRID_RADIAL,
): ChunkMesh {
  const rect = uvRectFromPath(req.path);
  const uc = (rect.u0 + rect.u1) / 2;
  const vc = (rect.v0 + rect.v1) / 2;
  const cdir = faceDirection(req.face, uc, vc);
  const origin: [number, number, number] = [cdir[0] * radius, cdir[1] * radius, cdir[2] * radius];

  // Radial range straddles the surface (r ≈ radius + height·noise, noise ∈ ~[-1,1]).
  const margin = recipe.height * 1.6;
  const rMin = radius - margin;
  const rMax = radius + margin;

  const nx = tan, ny = tan, nz = rad;
  const cnx = nx + 1, cny = ny + 1, cnz = nz + 1;
  const density = new Float64Array(cnx * cny * cnz);
  const cornerPos = new Float64Array(cnx * cny * cnz * 3);
  const _d = new Float64Array(4);

  let p = 0;
  for (let k = 0; k < cnz; k++) {
    const radial = rMin + (rMax - rMin) * (k / nz);
    for (let j = 0; j < cny; j++) {
      const v = rect.v0 + (rect.v1 - rect.v0) * (j / ny);
      for (let i = 0; i < cnx; i++) {
        const u = rect.u0 + (rect.u1 - rect.u0) * (i / nx);
        const dir = faceDirection(req.face, u, v);
        const wx = dir[0] * radial;
        const wy = dir[1] * radial;
        const wz = dir[2] * radial;
        densityAt(recipe, radius, wx, wy, wz, _d);
        density[p] = _d[0]!;
        cornerPos[p * 3] = wx;
        cornerPos[p * 3 + 1] = wy;
        cornerPos[p * 3 + 2] = wz;
        p++;
      }
    }
  }

  const _g = new Float64Array(4);
  const normalAt = (x: number, y: number, z: number, out: Float64Array): void => {
    densityAt(recipe, radius, x, y, z, _g);
    // Outward normal points toward AIR (decreasing D): n = normalize(-∇D).
    const gx = -_g[1]!, gy = -_g[2]!, gz = -_g[3]!;
    const inv = 1 / Math.sqrt(gx * gx + gy * gy + gz * gz + 1e-30);
    out[0] = gx * inv;
    out[1] = gy * inv;
    out[2] = gz * inv;
  };

  const field: SampledField = { nx, ny, nz, density, cornerPos };
  const m = surfaceNets(field, origin, normalAt);

  return {
    positions: m.positions,
    normals: m.normals,
    indices: m.indices,
    origin,
    bounds: m.bounds,
    vertexCount: m.vertexCount,
    triangleCount: m.triangleCount,
    lod: req.lod,
    key: chunkKey(req),
  };
}
