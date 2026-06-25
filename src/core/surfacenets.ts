// ─────────────────────────────────────────────────────────────────────────────
// Naive Surface Nets — PURE TS, no Three.js. Step 1.
//
// Turns a sampled scalar field D into a smooth triangle mesh at the D=0 surface
// (master plan §3.3 / §5.4, slice spec §5). Chosen over Marching Cubes (smoother,
// fewer triangles); Dual Contouring is a later upgrade only if sharp features
// need it (master plan §3.3). One vertex per sign-changed cell, placed at the
// average of the cell's edge zero-crossings; quads connect cells across each
// sign-changed grid edge.
//
// Normals come from the field's ANALYTIC gradient via the `normalAt` callback
// (not face normals, not finite differences). Triangle winding is auto-oriented
// per-triangle against those normals, so faces always front outward regardless of
// march order (verified in test/chunk.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Axis-aligned bounding box. */
export interface AABB {
  min: [number, number, number];
  max: [number, number, number];
}

/** Plain extracted mesh — no Three.js types cross this boundary. */
export interface ExtractedMesh {
  positions: Float32Array; // x,y,z per vertex, RELATIVE to `origin`
  normals: Float32Array; // unit outward normal per vertex
  /**
   * Low-detail morph target per vertex (3 per vertex, same order/space as
   * positions). The render shader lerps morphTarget→positions for a seamless LOD
   * geomorph: a new leaf is born looking like its coarse parent and grows detail
   * in. Equals `positions` exactly when the field carries no `cornerMorphPos`.
   */
  morphTargets: Float32Array;
  /**
   * Unit normal of the morph-target (parent) surface per vertex, same order as
   * `normals`. The render shader lerps normals→morphTargetNormals with the SAME
   * geomorph factor as positions→morphTargets, so a leaf morphed toward its parent
   * also SHADES like the parent — without this, the fine-detail normals persist
   * across the morph zone and the LOD boundary stays visible as a textured patch.
   * Equals `normals` when the field carries no `cornerMorphPos`.
   */
  morphTargetNormals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  bounds: AABB; // in the same local space as positions
}

/** A sampled scalar field on a regular (nx+1)×(ny+1)×(nz+1) corner grid. */
export interface SampledField {
  nx: number; // CELLS along each axis (corners = n+1)
  ny: number;
  nz: number;
  /** Density per corner, D>0 solid. Index = i + (nx+1)*(j + (ny+1)*k). */
  density: Float64Array;
  /** Absolute world position (double) per corner; 3 floats per corner, same index. */
  cornerPos: Float64Array;
  /** Unit outward normal per corner (= normalize(−∇D)); 3 per corner, same index. */
  cornerNormal: Float64Array;
  /**
   * Optional low-detail corner position (3 per corner, same index as cornerPos).
   * When present, each emitted vertex also gets a morph target interpolated from
   * these with the SAME zero-crossings as the base vertex (so it's the same vertex
   * at a smoother radius) — the geomorph source. Absent → morph target == base.
   */
  cornerMorphPos?: Float64Array;
}

// The 12 cube edges as pairs of local corner indices (L = a | b<<1 | c<<2).
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x
  [0, 2], [1, 3], [4, 6], [5, 7], // y
  [0, 4], [1, 5], [2, 6], [3, 7], // z
];
const OFF_A = [0, 1, 0, 1, 0, 1, 0, 1];
const OFF_B = [0, 0, 1, 1, 0, 0, 1, 1];
const OFF_C = [0, 0, 0, 0, 1, 1, 1, 1];

/**
 * Extract the D=0 surface. `origin` is subtracted from every world vertex so the
 * GPU receives small floats (previews the floating origin, Step 4). Vertex normals
 * are the normalized average of the cell's 8 corner normals (`field.cornerNormal`,
 * the analytic outward normals computed during sampling) — no per-vertex field
 * re-evaluation.
 */
export function surfaceNets(
  field: SampledField,
  origin: readonly [number, number, number],
  skirtDepth = 0,
): ExtractedMesh {
  const { nx, ny, nz, density, cornerPos, cornerNormal } = field;
  // Morph target source. Absent → reuse cornerPos so morphTargets == positions
  // exactly (geomorph becomes a no-op).
  const mp = field.cornerMorphPos ?? cornerPos;
  const cnx = nx + 1;
  const cny = ny + 1;
  const cIdx = (i: number, j: number, k: number): number => i + cnx * (j + cny * k);
  const cellIdx = (i: number, j: number, k: number): number => i + nx * (j + ny * k);

  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const pos: number[] = []; // local x,y,z triples
  const mpos: number[] = []; // local morph-target triples, parallel to pos
  const nrm: number[] = [];
  const d = new Float64Array(8);

  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;

  // Pass 1 — one vertex per sign-changed cell.
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        let nax = 0, nay = 0, naz = 0; // accumulate the cell's corner normals
        for (let L = 0; L < 8; L++) {
          const cc = cIdx(i + OFF_A[L]!, j + OFF_B[L]!, k + OFF_C[L]!);
          const dv = density[cc]!;
          d[L] = dv;
          if (dv >= 0) mask |= 1 << L;
          nax += cornerNormal[cc * 3]!;
          nay += cornerNormal[cc * 3 + 1]!;
          naz += cornerNormal[cc * 3 + 2]!;
        }
        if (mask === 0 || mask === 0xff) continue;

        let sx = 0, sy = 0, sz = 0, cnt = 0;
        let smx = 0, smy = 0, smz = 0; // morph target: same crossings, same t
        for (const [a, b] of EDGES) {
          const da = d[a]!;
          const db = d[b]!;
          if (da >= 0 === (db >= 0)) continue;
          const t = da / (da - db); // ∈ (0,1)
          const ca = cIdx(i + OFF_A[a]!, j + OFF_B[a]!, k + OFF_C[a]!);
          const cb = cIdx(i + OFF_A[b]!, j + OFF_B[b]!, k + OFF_C[b]!);
          sx += cornerPos[ca * 3]! + t * (cornerPos[cb * 3]! - cornerPos[ca * 3]!);
          sy += cornerPos[ca * 3 + 1]! + t * (cornerPos[cb * 3 + 1]! - cornerPos[ca * 3 + 1]!);
          sz += cornerPos[ca * 3 + 2]! + t * (cornerPos[cb * 3 + 2]! - cornerPos[ca * 3 + 2]!);
          smx += mp[ca * 3]! + t * (mp[cb * 3]! - mp[ca * 3]!);
          smy += mp[ca * 3 + 1]! + t * (mp[cb * 3 + 1]! - mp[ca * 3 + 1]!);
          smz += mp[ca * 3 + 2]! + t * (mp[cb * 3 + 2]! - mp[ca * 3 + 2]!);
          cnt++;
        }
        const invc = 1 / cnt;
        const wx = sx * invc;
        const wy = sy * invc;
        const wz = sz * invc;
        const nl = 1 / Math.sqrt(nax * nax + nay * nay + naz * naz + 1e-30);

        const lx = wx - origin[0];
        const ly = wy - origin[1];
        const lz = wz - origin[2];
        const mlx = smx * invc - origin[0];
        const mly = smy * invc - origin[1];
        const mlz = smz * invc - origin[2];
        cellVert[cellIdx(i, j, k)] = pos.length / 3;
        pos.push(lx, ly, lz);
        mpos.push(mlx, mly, mlz);
        nrm.push(nax * nl, nay * nl, naz * nl);

        // Bounds must enclose the mesh at ANY morph value, so include both ends.
        if (lx < minx) minx = lx;
        if (ly < miny) miny = ly;
        if (lz < minz) minz = lz;
        if (lx > maxx) maxx = lx;
        if (ly > maxy) maxy = ly;
        if (lz > maxz) maxz = lz;
        if (mlx < minx) minx = mlx;
        if (mly < miny) miny = mly;
        if (mlz < minz) minz = mlz;
        if (mlx > maxx) maxx = mlx;
        if (mly > maxy) maxy = mly;
        if (mlz > maxz) maxz = mlz;
      }
    }
  }

  // Pass 2 — quads across each interior sign-changed grid edge.
  const idx: number[] = [];
  const quad = (c0: number, c1: number, c2: number, c3: number): void => {
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return;
    pushTri(idx, pos, nrm, c0, c1, c2);
    pushTri(idx, pos, nrm, c0, c2, c3);
  };

  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const here = density[cIdx(i, j, k)]! >= 0;
        if (i < nx && j >= 1 && k >= 1 && (density[cIdx(i + 1, j, k)]! >= 0) !== here) {
          quad(
            cellVert[cellIdx(i, j - 1, k - 1)]!,
            cellVert[cellIdx(i, j, k - 1)]!,
            cellVert[cellIdx(i, j, k)]!,
            cellVert[cellIdx(i, j - 1, k)]!,
          );
        }
        if (j < ny && i >= 1 && k >= 1 && (density[cIdx(i, j + 1, k)]! >= 0) !== here) {
          quad(
            cellVert[cellIdx(i - 1, j, k - 1)]!,
            cellVert[cellIdx(i, j, k - 1)]!,
            cellVert[cellIdx(i, j, k)]!,
            cellVert[cellIdx(i - 1, j, k)]!,
          );
        }
        if (k < nz && i >= 1 && j >= 1 && (density[cIdx(i, j, k + 1)]! >= 0) !== here) {
          quad(
            cellVert[cellIdx(i - 1, j - 1, k)]!,
            cellVert[cellIdx(i, j - 1, k)]!,
            cellVert[cellIdx(i, j, k)]!,
            cellVert[cellIdx(i - 1, j, k)]!,
          );
        }
      }
    }
  }

  const mainIdxLen = idx.length; // triangles 0..mainIdxLen are the main surface (pre-skirt)

  // Pass 3 — skirts. Extrude tangential-boundary vertices radially inward into
  // curtains; a neighbor patch at a different LOD drops its own overlapping
  // curtain, so the crack between them is hidden (slice spec §5). Rendered
  // double-sided, so skirt winding is irrelevant.
  if (skirtDepth > 0) {
    const skirtOf = new Map<number, number>();
    const makeSkirt = (v: number): number => {
      const cached = skirtOf.get(v);
      if (cached !== undefined) return cached;
      const lx = pos[v * 3]!, ly = pos[v * 3 + 1]!, lz = pos[v * 3 + 2]!;
      const wx = lx + origin[0], wy = ly + origin[1], wz = lz + origin[2];
      const iw = 1 / Math.sqrt(wx * wx + wy * wy + wz * wz + 1e-30);
      const sx = lx - wx * iw * skirtDepth;
      const sy = ly - wy * iw * skirtDepth;
      const sz = lz - wz * iw * skirtDepth;
      // Skirt's morph target: extrude the MORPH vertex inward the same way, so the
      // curtain stays attached to the surface at every morph value (else the LOD
      // crack reopens mid-morph).
      const mlx = mpos[v * 3]!, mly = mpos[v * 3 + 1]!, mlz = mpos[v * 3 + 2]!;
      const mwx = mlx + origin[0], mwy = mly + origin[1], mwz = mlz + origin[2];
      const miw = 1 / Math.sqrt(mwx * mwx + mwy * mwy + mwz * mwz + 1e-30);
      const msx = mlx - mwx * miw * skirtDepth;
      const msy = mly - mwy * miw * skirtDepth;
      const msz = mlz - mwz * miw * skirtDepth;
      const si = pos.length / 3;
      pos.push(sx, sy, sz);
      mpos.push(msx, msy, msz);
      nrm.push(nrm[v * 3]!, nrm[v * 3 + 1]!, nrm[v * 3 + 2]!);
      if (sx < minx) minx = sx;
      if (sy < miny) miny = sy;
      if (sz < minz) minz = sz;
      if (sx > maxx) maxx = sx;
      if (sy > maxy) maxy = sy;
      if (sz > maxz) maxz = sz;
      if (msx < minx) minx = msx;
      if (msy < miny) miny = msy;
      if (msz < minz) minz = msz;
      if (msx > maxx) maxx = msx;
      if (msy > maxy) maxy = msy;
      if (msz > maxz) maxz = msz;
      skirtOf.set(v, si);
      return si;
    };
    const skirtQuad = (a: number, b: number): void => {
      const a2 = makeSkirt(a);
      const b2 = makeSkirt(b);
      idx.push(a, b, b2, a, b2, a2);
    };
    // i-boundaries (patch edges in u): connect adjacent boundary cells in j and k.
    for (const iB of [0, nx - 1]) {
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          const v = cellVert[cellIdx(iB, j, k)]!;
          if (v < 0) continue;
          if (j + 1 < ny) {
            const vj = cellVert[cellIdx(iB, j + 1, k)]!;
            if (vj >= 0) skirtQuad(v, vj);
          }
          if (k + 1 < nz) {
            const vk = cellVert[cellIdx(iB, j, k + 1)]!;
            if (vk >= 0) skirtQuad(v, vk);
          }
        }
      }
    }
    // j-boundaries (patch edges in v): connect adjacent boundary cells in i and k.
    for (const jB of [0, ny - 1]) {
      for (let k = 0; k < nz; k++) {
        for (let i = 0; i < nx; i++) {
          const v = cellVert[cellIdx(i, jB, k)]!;
          if (v < 0) continue;
          if (i + 1 < nx) {
            const vi = cellVert[cellIdx(i + 1, jB, k)]!;
            if (vi >= 0) skirtQuad(v, vi);
          }
          if (k + 1 < nz) {
            const vk = cellVert[cellIdx(i, jB, k + 1)]!;
            if (vk >= 0) skirtQuad(v, vk);
          }
        }
      }
    }
  }

  const vertexCount = pos.length / 3;

  // Morph-target normals — the parent surface's per-vertex normals, so the shader can lerp
  // the NORMAL with the geomorph (not just the position). Accumulate face normals from the
  // MORPH positions over the MAIN surface triangles only (skirt curtains would corrupt base
  // verts); each face is oriented outward against the fine normals (mirrors pushTri). Any
  // vertex with no contribution (skirt verts / degenerate) falls back to its fine normal.
  const mAcc = new Float64Array(vertexCount * 3);
  for (let t = 0; t < mainIdxLen; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!;
    const ax = mpos[a * 3]!, ay = mpos[a * 3 + 1]!, az = mpos[a * 3 + 2]!;
    const e1x = mpos[b * 3]! - ax, e1y = mpos[b * 3 + 1]! - ay, e1z = mpos[b * 3 + 2]! - az;
    const e2x = mpos[c * 3]! - ax, e2y = mpos[c * 3 + 1]! - ay, e2z = mpos[c * 3 + 2]! - az;
    let fx = e1y * e2z - e1z * e2y;
    let fy = e1z * e2x - e1x * e2z;
    let fz = e1x * e2y - e1y * e2x;
    const anx = nrm[a * 3]! + nrm[b * 3]! + nrm[c * 3]!;
    const any = nrm[a * 3 + 1]! + nrm[b * 3 + 1]! + nrm[c * 3 + 1]!;
    const anz = nrm[a * 3 + 2]! + nrm[b * 3 + 2]! + nrm[c * 3 + 2]!;
    if (fx * anx + fy * any + fz * anz < 0) { fx = -fx; fy = -fy; fz = -fz; } // orient outward
    mAcc[a * 3] = mAcc[a * 3]! + fx; mAcc[a * 3 + 1] = mAcc[a * 3 + 1]! + fy; mAcc[a * 3 + 2] = mAcc[a * 3 + 2]! + fz;
    mAcc[b * 3] = mAcc[b * 3]! + fx; mAcc[b * 3 + 1] = mAcc[b * 3 + 1]! + fy; mAcc[b * 3 + 2] = mAcc[b * 3 + 2]! + fz;
    mAcc[c * 3] = mAcc[c * 3]! + fx; mAcc[c * 3 + 1] = mAcc[c * 3 + 1]! + fy; mAcc[c * 3 + 2] = mAcc[c * 3 + 2]! + fz;
  }
  const mnrm = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const x = mAcc[v * 3]!, y = mAcc[v * 3 + 1]!, z = mAcc[v * 3 + 2]!;
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-12) {
      const inv = 1 / len;
      mnrm[v * 3] = x * inv; mnrm[v * 3 + 1] = y * inv; mnrm[v * 3 + 2] = z * inv;
    } else {
      mnrm[v * 3] = nrm[v * 3]!; mnrm[v * 3 + 1] = nrm[v * 3 + 1]!; mnrm[v * 3 + 2] = nrm[v * 3 + 2]!;
    }
  }

  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    morphTargets: Float32Array.from(mpos),
    morphTargetNormals: mnrm,
    indices: Uint32Array.from(idx),
    vertexCount,
    triangleCount: idx.length / 3,
    bounds:
      vertexCount > 0
        ? { min: [minx, miny, minz], max: [maxx, maxy, maxz] }
        : { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

/** Push a triangle, auto-orienting its winding so it front-faces along the analytic normals. */
function pushTri(
  idx: number[],
  pos: number[],
  nrm: number[],
  a: number,
  b: number,
  c: number,
): void {
  const ax = pos[a * 3]!, ay = pos[a * 3 + 1]!, az = pos[a * 3 + 2]!;
  const e1x = pos[b * 3]! - ax, e1y = pos[b * 3 + 1]! - ay, e1z = pos[b * 3 + 2]! - az;
  const e2x = pos[c * 3]! - ax, e2y = pos[c * 3 + 1]! - ay, e2z = pos[c * 3 + 2]! - az;
  const gnx = e1y * e2z - e1z * e2y;
  const gny = e1z * e2x - e1x * e2z;
  const gnz = e1x * e2y - e1y * e2x;
  const anx = nrm[a * 3]! + nrm[b * 3]! + nrm[c * 3]!;
  const any = nrm[a * 3 + 1]! + nrm[b * 3 + 1]! + nrm[c * 3 + 1]!;
  const anz = nrm[a * 3 + 2]! + nrm[b * 3 + 2]! + nrm[c * 3 + 2]!;
  if (gnx * anx + gny * any + gnz * anz < 0) idx.push(a, c, b);
  else idx.push(a, b, c);
}
