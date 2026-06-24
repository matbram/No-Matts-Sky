// ─────────────────────────────────────────────────────────────────────────────
// Cube-sphere projection (Step 0) — PURE TS, no Three.js.
//
// A planet is a cube-sphere: 6 cube faces, each a grid, projected onto a sphere
// (master plan Part 3/5.5, slice spec §5). Step 0 renders the BARE sphere with
// no noise/LOD/streaming — its only jobs are to prove the projection is seamless
// and to drive the WebGPU render pipeline. The quadtree + Surface Nets come at
// Steps 1–2.
//
// Mapping: simple normalization (`sphere = normalize(cube) * radius`). It is
// exact and SEAMLESS — two adjacent faces compute identical 3D cube coordinates
// along their shared edge (same `-1 + 2k/S` arithmetic) and the same normalize,
// so the projected points coincide to the bit and there is no gap. (A lower-
// distortion mapping, e.g. Philip Nowell's, is an optional later refinement; it
// changes vertex distribution, not seamlessness.)
//
// Output uses Float32Array per the ChunkMesh contract (slice spec §4). At Earth
// radius, float32 quantizes positions to ~0.5 m — invisible from orbit and fine
// for Step 0; sub-meter surface precision arrives with the floating origin (Step 4).
// ─────────────────────────────────────────────────────────────────────────────

/** A unit 3-vector. */
type Vec3 = readonly [number, number, number];

/** Per-face basis: chosen so `cross(uDir, vDir) === normal` → consistent outward winding. */
interface CubeFace {
  readonly normal: Vec3;
  readonly uDir: Vec3;
  readonly vDir: Vec3;
}

/** The 6 faces, +X −X +Y −Y +Z −Z. Order is stable (it's part of the golden test). */
export const CUBE_FACES: readonly CubeFace[] = [
  { normal: [1, 0, 0], uDir: [0, 1, 0], vDir: [0, 0, 1] }, // +X
  { normal: [-1, 0, 0], uDir: [0, 0, 1], vDir: [0, 1, 0] }, // -X
  { normal: [0, 1, 0], uDir: [0, 0, 1], vDir: [1, 0, 0] }, // +Y
  { normal: [0, -1, 0], uDir: [1, 0, 0], vDir: [0, 0, 1] }, // -Y
  { normal: [0, 0, 1], uDir: [1, 0, 0], vDir: [0, 1, 0] }, // +Z
  { normal: [0, 0, -1], uDir: [0, 1, 0], vDir: [1, 0, 0] }, // -Z
];

/**
 * Project a face's (u,v) ∈ [-1,1]² onto the UNIT sphere — the single source of
 * truth for the cube→sphere mapping (used by `buildCubeSphere` and by the chunk
 * mesher). Simple normalization: exact and seamless, because adjacent faces
 * compute identical cube coordinates on a shared edge and normalize identically.
 * The arithmetic order is load-bearing — it's frozen by the Step 0 golden test.
 */
export function faceDirection(faceIndex: number, u: number, v: number): [number, number, number] {
  const f = CUBE_FACES[faceIndex]!;
  const cx = f.normal[0] + u * f.uDir[0] + v * f.vDir[0];
  const cy = f.normal[1] + u * f.uDir[1] + v * f.vDir[1];
  const cz = f.normal[2] + u * f.uDir[2] + v * f.vDir[2];
  const invLen = 1 / Math.sqrt(cx * cx + cy * cy + cz * cz);
  return [cx * invLen, cy * invLen, cz * invLen];
}

/** Plain mesh data — no Three.js types cross this boundary. */
export interface SphereMesh {
  positions: Float32Array; // x,y,z per vertex
  normals: Float32Array; // unit normal per vertex (= position / radius)
  indices: Uint32Array; // 3 per triangle
  vertexCount: number;
  triangleCount: number;
}

/**
 * Build a full cube-sphere of `radius` with `subdivisions` quads per face edge.
 * Faces are concatenated; edge vertices are duplicated between faces but their
 * positions are bit-identical, so the surface is visually seamless.
 */
export function buildCubeSphere(subdivisions: number, radius: number): SphereMesh {
  if (!Number.isInteger(subdivisions) || subdivisions < 1) {
    throw new Error(`subdivisions must be a positive integer, got ${subdivisions}`);
  }
  const s = subdivisions;
  const side = s + 1; // vertices per row
  const vertsPerFace = side * side;
  const trisPerFace = s * s * 2;
  const vertexCount = vertsPerFace * 6;
  const triangleCount = trisPerFace * 6;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);

  let vPtr = 0; // float cursor into positions/normals
  let iPtr = 0; // cursor into indices
  let baseVertex = 0; // first vertex index of the current face

  for (let fi = 0; fi < 6; fi++) {
    // Vertices: row-major in (i along uDir, j along vDir).
    for (let i = 0; i < side; i++) {
      const u = -1 + (2 * i) / s;
      for (let j = 0; j < side; j++) {
        const v = -1 + (2 * j) / s;
        const [dirx, diry, dirz] = faceDirection(fi, u, v);
        positions[vPtr] = dirx * radius;
        positions[vPtr + 1] = diry * radius;
        positions[vPtr + 2] = dirz * radius;
        normals[vPtr] = dirx;
        normals[vPtr + 1] = diry;
        normals[vPtr + 2] = dirz;
        vPtr += 3;
      }
    }

    // Indices: two CCW (outward) triangles per quad.
    for (let i = 0; i < s; i++) {
      for (let j = 0; j < s; j++) {
        const a = baseVertex + i * side + j;
        const b = baseVertex + (i + 1) * side + j;
        const c = baseVertex + (i + 1) * side + (j + 1);
        const d = baseVertex + i * side + (j + 1);
        indices[iPtr] = a;
        indices[iPtr + 1] = b;
        indices[iPtr + 2] = c;
        indices[iPtr + 3] = a;
        indices[iPtr + 4] = c;
        indices[iPtr + 5] = d;
        iPtr += 6;
      }
    }

    baseVertex += vertsPerFace;
  }

  return { positions, normals, indices, vertexCount, triangleCount };
}
