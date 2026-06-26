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

import { faceDirection, wrapFaceUV } from './cubesphere.ts';
import { terrainAt, assembleDensity, lodOctaves, type TerrainRecipe } from './density.ts';
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
  morphTargets: Float32Array; // low-detail position per vertex (LOD geomorph source)
  morphTargetNormals: Float32Array; // parent-surface normal per vertex (geomorph SHADING source)
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
let _sColDr: Float64Array = new Float64Array(0); // per-column radial morph offset (m)
let _sColMN: Float64Array = new Float64Array(0); // per-column morph-target (parent) NORMAL, unit (3 per col)
// Parent-GRID morph source: the one-octave-coarser field sampled on the PARENT's 2×-coarser grid (then
// bilinearly interpolated to each child column). This is what makes morph=1 reproduce the parent LEAF — the
// child's fine grid resolves detail the parent grid can't, so sampling the coarse field on the FINE grid
// (the old morph target) left a per-refinement normal pop; the parent grid removes it.
let _sPVal: Float64Array = new Float64Array(0); // parent-grid coarser value (oct-normalized _tLo[0])
let _sPNrm: Float64Array = new Float64Array(0); // parent-grid coarser analytic normal, unit (3 per pt)
let _sDensity: Float64Array = new Float64Array(0);
let _sCornerPos: Float64Array = new Float64Array(0);
let _sCornerNormal: Float64Array = new Float64Array(0);
let _sCornerMorphPos: Float64Array = new Float64Array(0);
let _sCornerMorphNormal: Float64Array = new Float64Array(0);
const _t = new Float64Array(4);
const _tLo = new Float64Array(4); // terrainAt's one-octave-smoother value+gradient (morph target + normal)
const _d = new Float64Array(4);
const _dLo = new Float64Array(4); // morph-target density gradient → analytic morph normal
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
  // LOD-adaptive detail: a deeper (finer) leaf adds one fBm octave per level, so
  // the finest feature stays matched to this leaf's (halving) cell size. lod 0 ==
  // recipe octaves, so coarse/orbit leaves are byte-identical to before.
  const oct = lodOctaves(recipe, req.lod);

  // Pass 1 — per COLUMN (i,j): the terrain noise depends only on direction, so
  // evaluate it ONCE per column and reuse for every radial layer. (Recomputing it
  // per 3D corner was ~13× redundant work across the radial axis — the bottleneck.)
  // Only the FULL detail value+gradient is per-column; the morph target comes from a
  // separate parent-GRID pass below (so morph=1 reproduces the parent LEAF, not the
  // coarse field on this leaf's finer grid — the per-refinement normal-pop fix).
  const colCount = cnx * cny;
  const colDir = (_sColDir = fit(_sColDir, colCount * 3));
  const colT = (_sColT = fit(_sColT, colCount * 4)); // [tv, tdx, tdy, tdz] per column
  const colDr = (_sColDr = fit(_sColDr, colCount)); // radial morph offset per column
  const colMN = (_sColMN = fit(_sColMN, colCount * 3)); // morph-target (parent) normal per column
  for (let j = 0; j < cny; j++) {
    const v = v0 + dv * j;
    for (let i = 0; i < cnx; i++) {
      const ci = j * cnx + i;
      // Apron columns that overshoot this face's [-1,1]² are wrapped onto the
      // neighbour cube face's first interior row, so face-edge leaves share their
      // edge with the adjacent face (watertight). Interior columns pass through
      // unchanged (identity), so interior meshes are bit-identical.
      const w = wrapFaceUV(req.face, u0 + du * i, v);
      const dir = faceDirection(w.face, w.u, w.v);
      colDir[ci * 3] = dir[0];
      colDir[ci * 3 + 1] = dir[1];
      colDir[ci * 3 + 2] = dir[2];
      // Full detail only (outLo skipped — the morph source is the parent-grid pass below).
      terrainAt(recipe, dir[0] * scale, dir[1] * scale, dir[2] * scale, _t, undefined, oct);
      colT[ci * 4] = _t[0]!;
      colT[ci * 4 + 1] = _t[1]!;
      colT[ci * 4 + 2] = _t[2]!;
      colT[ci * 4 + 3] = _t[3]!;
    }
  }

  // ── Morph target — the PARENT LEAF'S surface, reproduced (CDLOD parent-grid morph) ──
  // The geomorph's premise is that a child born at morph=1 is invisible — exactly the coarse parent leaf it
  // replaces. The parent renders the one-octave-coarser field on its 2×-coarser grid (piecewise-bilinear
  // between parent grid points); sampling that field on THIS leaf's finer grid (the old morph target)
  // resolved detail the parent can't, so every refinement swapped in a ~17° normal pop. Here we sample the
  // coarser field on the PARENT grid and bilinearly interpolate it to each child column, so morph=1 IS the
  // parent surface. The morph value stays the oct-normalized `_tLo` (terrainAt's outLo) — NOT a fresh
  // (oct-1)-octave fBm — because the shader does mix(full, target, m) and m=1 must equal the baked target.
  if (tan % 2 === 0) {
    // Parent grid: spacing 2× the child's, anchored so the child rect edges land on parent grid lines (the
    // child rect is one dyadic quadrant of the parent). One parent-cell apron each side guarantees every
    // child column — including the two child-apron columns — is bracketed by 4 parent points in range.
    const pdu = 2 * du, pdv = 2 * dv;
    const pu0 = rect.u0 - pdu, pv0 = rect.v0 - pdv;
    const pcnx = tan / 2 + 3, pcny = tan / 2 + 3;
    const pVal = (_sPVal = fit(_sPVal, pcnx * pcny));
    const pNrm = (_sPNrm = fit(_sPNrm, pcnx * pcny * 3));
    for (let pj = 0; pj < pcny; pj++) {
      const pv = pv0 + pdv * pj;
      for (let pi = 0; pi < pcnx; pi++) {
        const pp = pj * pcnx + pi;
        const w = wrapFaceUV(req.face, pu0 + pdu * pi, pv);
        const dir = faceDirection(w.face, w.u, w.v);
        terrainAt(recipe, dir[0] * scale, dir[1] * scale, dir[2] * scale, _t, _tLo, oct);
        pVal[pp] = _tLo[0]!;
        // Analytic morph normal at the parent surface radius (radius + height·tvLo), one octave dropped —
        // same source as the base normal, so a fully-morphed leaf shades exactly like its parent.
        const rmP = radius + height * _tLo[0]!;
        assembleDensity(radius, rmP, dir[0], dir[1], dir[2], _tLo[0]!, _tLo[1]!, _tLo[2]!, _tLo[3]!, height, scale, _dLo);
        const mgx = -_dLo[1]!, mgy = -_dLo[2]!, mgz = -_dLo[3]!;
        const mln = 1 / Math.sqrt(mgx * mgx + mgy * mgy + mgz * mgz + 1e-30);
        pNrm[pp * 3] = mgx * mln;
        pNrm[pp * 3 + 1] = mgy * mln;
        pNrm[pp * 3 + 2] = mgz * mln;
      }
    }
    // Bilinearly interpolate the parent grid to each child column. Child column index i sits at parent
    // fractional coord fu=(i+1)/2 (odd i → on a parent grid line, tu=0; even i → parent-cell midpoint,
    // tu=0.5), so the result is exactly the parent leaf's bilinear surface — a pure function of direction,
    // hence seam-consistent with same-LOD neighbours (incl. cross-face and children of different parents).
    for (let j = 0; j < cny; j++) {
      const fv = (j + 1) / 2;
      let pj0 = fv | 0;
      if (pj0 > pcny - 2) pj0 = pcny - 2;
      const tvv = fv - pj0;
      for (let i = 0; i < cnx; i++) {
        const ci = j * cnx + i;
        const fu = (i + 1) / 2;
        let pi0 = fu | 0;
        if (pi0 > pcnx - 2) pi0 = pcnx - 2;
        const tuu = fu - pi0;
        const a = pj0 * pcnx + pi0, b = a + 1, c = a + pcnx, e = c + 1;
        const w00 = (1 - tuu) * (1 - tvv), w10 = tuu * (1 - tvv), w01 = (1 - tuu) * tvv, w11 = tuu * tvv;
        const mLo = w00 * pVal[a]! + w10 * pVal[b]! + w01 * pVal[c]! + w11 * pVal[e]!;
        colDr[ci] = height * (mLo - colT[ci * 4]!);
        let nx2 = w00 * pNrm[a * 3]! + w10 * pNrm[b * 3]! + w01 * pNrm[c * 3]! + w11 * pNrm[e * 3]!;
        let ny2 = w00 * pNrm[a * 3 + 1]! + w10 * pNrm[b * 3 + 1]! + w01 * pNrm[c * 3 + 1]! + w11 * pNrm[e * 3 + 1]!;
        let nz2 = w00 * pNrm[a * 3 + 2]! + w10 * pNrm[b * 3 + 2]! + w01 * pNrm[c * 3 + 2]! + w11 * pNrm[e * 3 + 2]!;
        const nl = 1 / Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2 + 1e-30);
        colMN[ci * 3] = nx2 * nl;
        colMN[ci * 3 + 1] = ny2 * nl;
        colMN[ci * 3 + 2] = nz2 * nl;
      }
    }
  } else {
    // Odd `tan` (no caller does this; defensive): the parent grid can't align, so fall back to the coarser
    // field at this leaf's own grid — correct but with the small per-refinement pop the parent grid removes.
    for (let j = 0; j < cny; j++) {
      const v = v0 + dv * j;
      for (let i = 0; i < cnx; i++) {
        const ci = j * cnx + i;
        const w = wrapFaceUV(req.face, u0 + du * i, v);
        const dir = faceDirection(w.face, w.u, w.v);
        terrainAt(recipe, dir[0] * scale, dir[1] * scale, dir[2] * scale, _t, _tLo, oct);
        colDr[ci] = height * (_tLo[0]! - colT[ci * 4]!);
        const rmP = radius + height * _tLo[0]!;
        assembleDensity(radius, rmP, dir[0], dir[1], dir[2], _tLo[0]!, _tLo[1]!, _tLo[2]!, _tLo[3]!, height, scale, _dLo);
        const mgx = -_dLo[1]!, mgy = -_dLo[2]!, mgz = -_dLo[3]!;
        const mln = 1 / Math.sqrt(mgx * mgx + mgy * mgy + mgz * mgz + 1e-30);
        colMN[ci * 3] = mgx * mln;
        colMN[ci * 3 + 1] = mgy * mln;
        colMN[ci * 3 + 2] = mgz * mln;
      }
    }
  }

  // Pass 2 — per CORNER: cheap density + outward normal from the cached column,
  // no noise. Corner index matches surfacenets: i + cnx*(j + cny*k).
  const cc = cnx * cny * cnz;
  const density = (_sDensity = fit(_sDensity, cc));
  const cornerPos = (_sCornerPos = fit(_sCornerPos, cc * 3));
  const cornerNormal = (_sCornerNormal = fit(_sCornerNormal, cc * 3));
  const cornerMorphPos = (_sCornerMorphPos = fit(_sCornerMorphPos, cc * 3));
  const cornerMorphNormal = (_sCornerMorphNormal = fit(_sCornerMorphNormal, cc * 3));
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
      // Same corner displaced radially to the smoother surface (per-column offset,
      // constant over the radial axis). Surface Nets interpolates this with the
      // SAME zero-crossings, so each morph vertex is its base vertex, smoothed.
      const rm = r + colDr[ci]!;
      cornerMorphPos[p * 3] = dx * rm;
      cornerMorphPos[p * 3 + 1] = dy * rm;
      cornerMorphPos[p * 3 + 2] = dz * rm;
      const gx = -_d[1]!, gy = -_d[2]!, gz = -_d[3]!; // outward normal = normalize(−∇D)
      const ln = 1 / Math.sqrt(gx * gx + gy * gy + gz * gz + 1e-30);
      cornerNormal[p * 3] = gx * ln;
      cornerNormal[p * 3 + 1] = gy * ln;
      cornerNormal[p * 3 + 2] = gz * ln;
      // Morph-target normal = the parent-grid analytic normal for this column (computed in the parent-grid
      // pass, constant over the radial axis), so a fully-morphed leaf shades exactly like its parent leaf.
      cornerMorphNormal[p * 3] = colMN[ci * 3]!;
      cornerMorphNormal[p * 3 + 1] = colMN[ci * 3 + 1]!;
      cornerMorphNormal[p * 3 + 2] = colMN[ci * 3 + 2]!;
      p++;
    }
  }

  const field: SampledField = { nx, ny, nz, density, cornerPos, cornerNormal, cornerMorphPos, cornerMorphNormal };
  const m = surfaceNets(field, origin, skirtDepth);

  return {
    positions: m.positions,
    normals: m.normals,
    morphTargets: m.morphTargets,
    morphTargetNormals: m.morphTargetNormals,
    indices: m.indices,
    origin,
    bounds: m.bounds,
    vertexCount: m.vertexCount,
    triangleCount: m.triangleCount,
    lod: req.lod,
    key: chunkKey(req),
  };
}

/** Swap discontinuity at a one-level LOD refinement (metres + degrees). */
export interface SwapDelta {
  dPosMax: number; // worst surface-position gap (m) over the sampled points
  dPosAvg: number;
  dNrmMaxDeg: number; // worst normal-direction gap (deg) over the sampled points
  dNrmAvgDeg: number;
  samples: number;
}

/**
 * DIAGNOSTIC (not on the mesher hot path): the residual discontinuity when a child leaf swaps in at
 * morph=1, AFTER the parent-grid morph fix.
 *
 * The geomorph's premise is that a child born at morph=1 is invisible — exactly the coarse parent leaf it
 * replaces. `meshChunk` now reproduces the parent's GRID (it bilinearly samples the coarser field on the
 * parent's 2×-coarser grid), so the dominant ~17° grid-discretization pop the OLD child-grid morph showed is
 * gone. What this measures is the only mismatch the grid alignment can't remove: the field-level difference
 * between the mesher's morph-target source — the oct-normalized one-octave-coarser value `_tLo` (terrainAt's
 * outLo, octaves `oct = lodOctaves(recipe, lod)`) — and the ACTUAL parent leaf's base field (octaves
 * `octParent = oct-1`, normalized over its own `octParent` amplitudes). Because `_tLo` shares the child's
 * `oct`-amplitude denominator, it is a smooth ~1–2% scaling of the parent's value → a tiny radial offset
 * (≲ a few hundred m at peaks) and ≲ ~2° of normal tilt. So a SMALL reading here confirms the swap is
 * effectively pop-free; a LARGE reading would mean the morph target no longer matches the parent.
 *
 * Sampled at a perAxis×perAxis spread across the child's uv rect; both surfaces evaluated at the SAME
 * direction so the comparison isolates the field/normalization difference (grid is matched by the mesher).
 * Returns max/avg position gap (m) + normal gap (deg). Pure + deterministic.
 */
export function swapDelta(
  req: ChunkRequest,
  recipe: TerrainRecipe,
  radius: number,
  perAxis = 4,
): SwapDelta {
  // No parent → nothing swaps (root/base leaf). Report zero.
  if (req.path.length === 0) {
    return { dPosMax: 0, dPosAvg: 0, dNrmMaxDeg: 0, dNrmAvgDeg: 0, samples: 0 };
  }
  const child = uvRectFromPath(req.path);
  const oct = lodOctaves(recipe, req.lod); // child octaves → terrainAt's outLo is the morph-target value
  const octParent = lodOctaves(recipe, req.lod - 1); // the actual parent leaf's octave count
  const scale = recipe.noiseScale;
  const height = recipe.height;

  const t = new Float64Array(4);
  const tLo = new Float64Array(4);
  const d = new Float64Array(4);

  // Surface point + outward analytic normal at face-(u,v) for a given octave count, optionally reading the
  // one-octave-coarser `outLo` (the mesher's morph-target value) instead of the full value.
  const surf = (u: number, v: number, octaves: number, useLo: boolean, pos: Float64Array, nrm: Float64Array): void => {
    const dir = faceDirection(req.face, u, v);
    terrainAt(recipe, dir[0] * scale, dir[1] * scale, dir[2] * scale, t, useLo ? tLo : undefined, octaves);
    const s = useLo ? tLo : t;
    const r = radius + height * s[0]!;
    pos[0] = dir[0] * r;
    pos[1] = dir[1] * r;
    pos[2] = dir[2] * r;
    assembleDensity(radius, r, dir[0], dir[1], dir[2], s[0]!, s[1]!, s[2]!, s[3]!, height, scale, d);
    const gx = -d[1]!, gy = -d[2]!, gz = -d[3]!;
    const ln = 1 / Math.sqrt(gx * gx + gy * gy + gz * gz + 1e-30);
    nrm[0] = gx * ln;
    nrm[1] = gy * ln;
    nrm[2] = gz * ln;
  };

  const cPos = new Float64Array(3), cNrm = new Float64Array(3);
  const pPos = new Float64Array(3), pNrm = new Float64Array(3);

  let dPosMax = 0, dPosSum = 0, dNrmMax = 0, dNrmSum = 0, count = 0;

  for (let a = 0; a < perAxis; a++) {
    const su = child.u0 + (child.u1 - child.u0) * ((a + 0.5) / perAxis);
    for (let b = 0; b < perAxis; b++) {
      const sv = child.v0 + (child.v1 - child.v0) * ((b + 0.5) / perAxis);

      // Child morph=1 = the mesher's morph-target value (`_tLo`, oct-normalized one-octave-coarser).
      surf(su, sv, oct, true, cPos, cNrm);
      // Parent leaf = the real lod-(D-1) base field (octParent octaves, octParent-normalized).
      surf(su, sv, octParent, false, pPos, pNrm);

      const dPos = Math.hypot(cPos[0]! - pPos[0]!, cPos[1]! - pPos[1]!, cPos[2]! - pPos[2]!);
      let dot = cNrm[0]! * pNrm[0]! + cNrm[1]! * pNrm[1]! + cNrm[2]! * pNrm[2]!;
      if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
      const dNrm = (Math.acos(dot) * 180) / Math.PI;

      if (dPos > dPosMax) dPosMax = dPos;
      if (dNrm > dNrmMax) dNrmMax = dNrm;
      dPosSum += dPos;
      dNrmSum += dNrm;
      count++;
    }
  }

  return {
    dPosMax,
    dPosAvg: count ? dPosSum / count : 0,
    dNrmMaxDeg: dNrmMax,
    dNrmAvgDeg: count ? dNrmSum / count : 0,
    samples: count,
  };
}
