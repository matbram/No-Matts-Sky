// ─────────────────────────────────────────────────────────────────────────────
// The density field D(p) — PURE TS, no Three.js. Step 1.
//
// A volumetric planet is a single scalar field (master plan §5.4):
//   D(p) = planetRadius − |p| + fBm(normalize(p)·scale)·height   (+1 domain warp)
// with D>0 solid, D<0 air, surface at D=0. Sampling 3D noise on the unit-sphere
// DIRECTION (not lat/long) is what keeps it seamless and pole-free (master plan
// §5.3). For the slice there is ONE archetype recipe (barren/plateaus, facts.ts).
//
// We return D AND its analytic gradient ∇D in one pass, so surface normals are
// `normalize(−∇D)` with no triple-sampling (CLAUDE.md §4). The chain rule carries
// the gradient through the domain warp's Jacobian and through normalize(p) — see
// the worked derivation in the comments below. The finite-difference test in
// test/chunk.test.ts is the headless proof these derivatives are correct.
// ─────────────────────────────────────────────────────────────────────────────

import { fbm3 } from './noise.ts';

/** One archetype's terrain recipe (Constitution II.8). Values are [T] tunable. */
export interface TerrainRecipe {
  /** Noise feature count across the unit sphere (higher = smaller features). */
  noiseScale: number;
  /** Terrain amplitude in meters (peak-to-mean displacement of the surface). */
  height: number;
  octaves: number;
  lacunarity: number;
  gain: number;
  /** Domain-warp strength (1 iteration). 0 disables the warp. */
  warpStrength: number;
  /** The planet's terrain seed (seedchain: childSeed(planet, 0, SALT.terrain)). */
  seed: number;
}

/**
 * Max fBm octaves at the finest LOD. Bounds per-leaf cost (fBm is O(octaves)) and
 * caps detail once finer octaves fall below the cell size, where they'd only
 * alias. [T] tunable — lower it for perf headroom on weaker GPUs.
 */
export const OCT_MAX = 15;

/**
 * Octave count for a leaf at quadtree depth `lod`: ONE finer octave per level.
 * With lacunarity 2 the finest octave's wavelength then stays a constant ratio to
 * the cell size (which halves each level) → detail is always "matched," never
 * aliased. Capped at OCT_MAX. The geomorph relies on adjacent levels differing by
 * exactly one octave: a fine leaf's morph target (its value minus the finest
 * octave) is then its coarse parent's detail level → crack-free LOD transitions.
 *
 * lod 0 → recipe.octaves (== today), so coarse/orbit leaves are unchanged.
 */
export function lodOctaves(recipe: TerrainRecipe, lod: number): number {
  return Math.min(OCT_MAX, recipe.octaves + lod);
}

/** The slice's single recipe, keyed off the planet's terrain seed. [T] tunable. */
export function sliceTerrainRecipe(terrainSeed: number): TerrainRecipe {
  return {
    // ~280 features across the sphere → several hills per leaf at slice depth
    // (at noiseScale 22 a leaf was smaller than one feature, so it read flat).
    noiseScale: 140,
    height: 14_000,
    octaves: 4,
    lacunarity: 2.0,
    gain: 0.5,
    warpStrength: 0.7,
    seed: terrainSeed >>> 0,
  };
}

// Scratch buffers (single-threaded; the call chain densityAt→terrain→fbm3 never
// reuses a buffer that an inner call also writes).
const _wx = new Float64Array(4);
const _wy = new Float64Array(4);
const _wz = new Float64Array(4);
const _n = new Float64Array(4);
const _t = new Float64Array(4);

/**
 * Warped fBm sampled at a point on the (scaled) unit sphere — the direction-only
 * terrain field. Writes `[value, ∂/∂x, ∂/∂y, ∂/∂z]` (gradient w.r.t. the INPUT p)
 * into `out`. EXPORTED so the chunk mesher can evaluate it ONCE per column (the
 * noise depends only on direction, so all radial layers share it).
 *
 * Gradient: ∇ₚ fbm(q(p)) = Jᵀ ∇fbm(q), where the warp Jacobian J = I + A·Jw and
 * Jw's rows are the gradients of the three warp channels. (Jᵀg)_i =
 * g_i + A·Σⱼ wⱼ.d[i]·gⱼ.
 *
 * Optional `outLo` receives the terrain VALUE one octave smoother (the main fBm's
 * "parent-resolution" value under the SAME domain warp) — the LOD geomorph target.
 * No gradient is produced for it (morph normals are snapped). `out` is unaffected.
 *
 * Optional `octaveCount` overrides the recipe's octave count for the MAIN terrain
 * fBm only (the LOD-adaptive detail — see `lodOctaves`). The domain warp keeps the
 * recipe's octaves so q(p) is identical across LODs; only the high-frequency detail
 * (and its geomorph target) scales, which is exactly what the morph is built to fade.
 */
export function terrainAt(
  recipe: TerrainRecipe,
  px: number,
  py: number,
  pz: number,
  out: Float64Array,
  outLo?: Float64Array,
  octaveCount?: number,
): void {
  const A = recipe.warpStrength;
  const s = recipe.seed;
  const o = recipe.octaves;
  const oMain = octaveCount ?? o;
  const lac = recipe.lacunarity;
  const g = recipe.gain;

  // Three decorrelated warp channels (distinct seeds + offsets). Warp octaves stay
  // fixed at the recipe's count so the warped sample point q(p) is identical for
  // every leaf regardless of LOD → adjacent leaves agree, the geomorph only has to
  // hide the MAIN fBm's finest octave.
  fbm3((s ^ 0x1111_1111) >>> 0, px + 11.5, py + 5.2, pz + 19.3, o, lac, g, _wx);
  fbm3((s ^ 0x2222_2222) >>> 0, px + 7.7, py + 13.1, pz + 3.9, o, lac, g, _wy);
  fbm3((s ^ 0x3333_3333) >>> 0, px + 2.4, py + 9.8, pz + 27.1, o, lac, g, _wz);

  const qx = px + A * _wx[0]!;
  const qy = py + A * _wy[0]!;
  const qz = pz + A * _wz[0]!;
  // Same warp for the morph target → its only difference from `out[0]` is the
  // dropped finest octave, i.e. a purely radial detail-smoothing displacement.
  fbm3(s, qx, qy, qz, oMain, lac, g, _n, outLo);

  const nx = _n[1]!;
  const ny = _n[2]!;
  const nz = _n[3]!;
  out[0] = _n[0]!;
  out[1] = nx + A * (_wx[1]! * nx + _wy[1]! * ny + _wz[1]! * nz);
  out[2] = ny + A * (_wx[2]! * nx + _wy[2]! * ny + _wz[2]! * nz);
  out[3] = nz + A * (_wx[3]! * nx + _wy[3]! * ny + _wz[3]! * nz);
}

/**
 * Assemble the density value + gradient from a precomputed terrain sample.
 * `dir` is the UNIT direction, `r` the radius, `tv`/`td*` the terrain value and
 * its gradient w.r.t. the scaled sample point (from `terrainAt`). Writes
 * `[D, ∂D/∂x, ∂D/∂y, ∂D/∂z]`. Shared by `densityAt` (per point) and the chunk
 * mesher (per corner, reusing one `terrainAt` per column).
 *
 *   D = radius − r + height·tv
 *   ∇(radius − r) = −dir;  ∇(height·tv) = (scale/r)·(td − dir·(td·dir))
 */
export function assembleDensity(
  radius: number,
  r: number,
  rx: number,
  ry: number,
  rz: number,
  tv: number,
  tdx: number,
  tdy: number,
  tdz: number,
  height: number,
  scale: number,
  out: Float64Array,
): void {
  out[0] = radius - r + height * tv;
  const dot = tdx * rx + tdy * ry + tdz * rz;
  const k = (scale * height) / r;
  out[1] = -rx + k * (tdx - rx * dot);
  out[2] = -ry + k * (tdy - ry * dot);
  out[3] = -rz + k * (tdz - rz * dot);
}

/**
 * Evaluate the density field at world point (x,y,z) — the canonical per-point
 * path (kept for the finite-difference correctness test and any direct use).
 * Writes `[D, ∂D/∂x, ∂D/∂y, ∂D/∂z]`.
 */
export function densityAt(
  recipe: TerrainRecipe,
  radius: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const r = Math.sqrt(x * x + y * y + z * z);
  const inv = 1 / r;
  const rx = x * inv;
  const ry = y * inv;
  const rz = z * inv;
  const scale = recipe.noiseScale;
  terrainAt(recipe, rx * scale, ry * scale, rz * scale, _t);
  assembleDensity(radius, r, rx, ry, rz, _t[0]!, _t[1]!, _t[2]!, _t[3]!, recipe.height, scale, out);
}

// surfaceAt scratch (separate from _t so the player's per-frame surface query on
// the main thread never aliases densityAt's buffer mid-read).
const _sT = new Float64Array(4);
const _sD = new Float64Array(4);

/**
 * Surface query along a direction — the character controller's collision &
 * orientation probe (Step 4). Returns the SAME surface the mesher builds: the
 * field's zero crossing D = radius − r + height·tv = 0 ⇒ r = radius + height·tv,
 * with the analytic outward normal `normalize(−∇D)` (identical to chunk.ts L188).
 * `(dx,dy,dz)` need NOT be unit (normalized inside). Pure, deterministic, no alloc.
 *
 * Writes into `out` (length ≥ 7):
 *   out[0]   = surfaceRadius  (meters from planet center)
 *   out[1..3]= outward unit surface normal
 *   out[4..6]= the unit radial direction (normalized input)
 */
export function surfaceAt(
  recipe: TerrainRecipe,
  planetRadius: number,
  dx: number,
  dy: number,
  dz: number,
  out: Float64Array,
  octaveCount?: number,
): void {
  const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
  const rx = dx * inv;
  const ry = dy * inv;
  const rz = dz * inv;
  const scale = recipe.noiseScale;
  terrainAt(recipe, rx * scale, ry * scale, rz * scale, _sT, undefined, octaveCount);
  const surfaceRadius = planetRadius + recipe.height * _sT[0]!;
  // ∇D at the surface point → outward normal = normalize(−∇D), matching the mesh.
  assembleDensity(
    planetRadius,
    surfaceRadius,
    rx,
    ry,
    rz,
    _sT[0]!,
    _sT[1]!,
    _sT[2]!,
    _sT[3]!,
    recipe.height,
    scale,
    _sD,
  );
  const gx = -_sD[1]!;
  const gy = -_sD[2]!;
  const gz = -_sD[3]!;
  const gl = 1 / Math.sqrt(gx * gx + gy * gy + gz * gz + 1e-30);
  out[0] = surfaceRadius;
  out[1] = gx * gl;
  out[2] = gy * gl;
  out[3] = gz * gl;
  out[4] = rx;
  out[5] = ry;
  out[6] = rz;
}
