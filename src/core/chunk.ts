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
import { terrainAt, assembleDensity, type TerrainRecipe } from './density.ts';
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
  /** Radial skirt depth (m) to hide LOD cracks; 0 = no skirt. */
  skirtDepth?: number;
}

/** Default grid resolution: fine tangentially, modest radially (a thin shell). [T]
 *  Sized for streaming throughput (Step 3) — a leaf must mesh fast on a worker. */
export const CHUNK_GRID_TANGENTIAL = 32;
export const CHUNK_GRID_RADIAL = 12;

// Reused intermediate scratch. `meshChunk` is sequential and non-reentrant (one
// leaf at a time per worker — and each worker has its own module instance), so
// sharing these across leaves is safe and avoids ~1 MB of transient allocation per
// leaf (GC spikes show up as frame hitches). Output buffers are still fresh per
// call (surfaceNets allocates them) so they can be transferred and kept.
let _sColDir: Float64Array = new Float64Array(0);
let _sColT: Float64Array = new Float64Array(0);
let _sDensity: Float64Array = new Float64Array(0);
let _sCornerPos: Float64Array = new Float64Array(0);
let _sCornerNormal: Float64Array = new Float64Array(0);
const _t = new Float64Array(4);
const _d = new Float64Array(4);
const fit = (a: Float64Array, n: number): Float64Array => (a.length >= n ? a : new Float64Array(n));

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
  skirtDepth = 0,
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

  // 1-cell apron on the tangential axes: two adjacent SAME-LOD leaves then sample
  // the shared edge at the same (u,v) points, so their surfaces coincide/overlap
  // and there's no crack between them (slice spec §5 "1-voxel overlap"). The
  // radial axis is a closed shell and needs no apron.
  const du = (rect.u1 - rect.u0) / tan;
  const dv = (rect.v1 - rect.v0) / tan;
  const u0 = rect.u0 - du;
  const v0 = rect.v0 - dv;
  const nx = tan + 2, ny = tan + 2, nz = rad;
  const cnx = nx + 1, cny = ny + 1, cnz = nz + 1;
  const scale = recipe.noiseScale;
  const height = recipe.height;

  // Pass 1 — per COLUMN (i,j): the terrain noise depends only on direction, so
  // evaluate it ONCE per column and reuse for every radial layer. (Recomputing it
  // per 3D corner was ~13× redundant work across the radial axis — the bottleneck.)
  const colCount = cnx * cny;
  const colDir = (_sColDir = fit(_sColDir, colCount * 3));
  const colT = (_sColT = fit(_sColT, colCount * 4)); // [tv, tdx, tdy, tdz] per column
  for (let j = 0; j < cny; j++) {
    const v = v0 + dv * j;
    for (let i = 0; i < cnx; i++) {
      const ci = j * cnx + i;
      const dir = faceDirection(req.face, u0 + du * i, v);
      colDir[ci * 3] = dir[0];
      colDir[ci * 3 + 1] = dir[1];
      colDir[ci * 3 + 2] = dir[2];
      terrainAt(recipe, dir[0] * scale, dir[1] * scale, dir[2] * scale, _t);
      colT[ci * 4] = _t[0]!;
      colT[ci * 4 + 1] = _t[1]!;
      colT[ci * 4 + 2] = _t[2]!;
      colT[ci * 4 + 3] = _t[3]!;
    }
  }

  // Pass 2 — per CORNER: cheap density + outward normal from the cached column,
  // no noise. Corner index matches surfacenets: i + cnx*(j + cny*k).
  const cc = cnx * cny * cnz;
  const density = (_sDensity = fit(_sDensity, cc));
  const cornerPos = (_sCornerPos = fit(_sCornerPos, cc * 3));
  const cornerNormal = (_sCornerNormal = fit(_sCornerNormal, cc * 3));
  let p = 0;
  for (let k = 0; k < cnz; k++) {
    const r = rMin + (rMax - rMin) * (k / nz);
    for (let ci = 0; ci < colCount; ci++) {
      const dx = colDir[ci * 3]!, dy = colDir[ci * 3 + 1]!, dz = colDir[ci * 3 + 2]!;
      assembleDensity(
        radius, r, dx, dy, dz,
        colT[ci * 4]!, colT[ci * 4 + 1]!, colT[ci * 4 + 2]!, colT[ci * 4 + 3]!,
        height, scale, _d,
      );
      density[p] = _d[0]!;
      cornerPos[p * 3] = dx * r;
      cornerPos[p * 3 + 1] = dy * r;
      cornerPos[p * 3 + 2] = dz * r;
      const gx = -_d[1]!, gy = -_d[2]!, gz = -_d[3]!; // outward normal = normalize(−∇D)
      const ln = 1 / Math.sqrt(gx * gx + gy * gy + gz * gz + 1e-30);
      cornerNormal[p * 3] = gx * ln;
      cornerNormal[p * 3 + 1] = gy * ln;
      cornerNormal[p * 3 + 2] = gz * ln;
      p++;
    }
  }

  const field: SampledField = { nx, ny, nz, density, cornerPos, cornerNormal };
  const m = surfaceNets(field, origin, skirtDepth);

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
