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
 * Warped fBm: `terrain(p) = fbm(p + A·w(p))` with `w` a 3-channel fBm vector.
 * Writes `[value, ∂/∂x, ∂/∂y, ∂/∂z]` (gradient w.r.t. the INPUT p) into `out`.
 *
 * Gradient: ∇ₚ fbm(q(p)) = Jᵀ ∇fbm(q), where the warp Jacobian J = I + A·Jw and
 * Jw's rows are the gradients of the three warp channels. (Jᵀg)_i =
 * g_i + A·Σⱼ wⱼ.d[i]·gⱼ.
 */
function terrain(recipe: TerrainRecipe, px: number, py: number, pz: number, out: Float64Array): void {
  const A = recipe.warpStrength;
  const s = recipe.seed;
  const o = recipe.octaves;
  const lac = recipe.lacunarity;
  const g = recipe.gain;

  // Three decorrelated warp channels (distinct seeds + offsets).
  fbm3((s ^ 0x1111_1111) >>> 0, px + 11.5, py + 5.2, pz + 19.3, o, lac, g, _wx);
  fbm3((s ^ 0x2222_2222) >>> 0, px + 7.7, py + 13.1, pz + 3.9, o, lac, g, _wy);
  fbm3((s ^ 0x3333_3333) >>> 0, px + 2.4, py + 9.8, pz + 27.1, o, lac, g, _wz);

  const qx = px + A * _wx[0]!;
  const qy = py + A * _wy[0]!;
  const qz = pz + A * _wz[0]!;
  fbm3(s, qx, qy, qz, o, lac, g, _n);

  const nx = _n[1]!;
  const ny = _n[2]!;
  const nz = _n[3]!;
  out[0] = _n[0]!;
  out[1] = nx + A * (_wx[1]! * nx + _wy[1]! * ny + _wz[1]! * nz);
  out[2] = ny + A * (_wx[2]! * nx + _wy[2]! * ny + _wz[2]! * nz);
  out[3] = nz + A * (_wx[3]! * nx + _wy[3]! * ny + _wz[3]! * nz);
}

/**
 * Evaluate the density field at world point (x,y,z).
 * Writes `[D, ∂D/∂x, ∂D/∂y, ∂D/∂z]` into `out` (length ≥ 4).
 *
 * D = radius − r + height·t(dir·scale), where dir = p/r. The gradient combines:
 *   ∇(radius − r) = −dir
 *   ∇ t(dir·scale) = (scale/r)·(t.d − dir·(t.d·dir))   [through normalize(p)]
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

  terrain(recipe, rx * scale, ry * scale, rz * scale, _t);
  const tv = _t[0]!;
  const tdx = _t[1]!;
  const tdy = _t[2]!;
  const tdz = _t[3]!;

  out[0] = radius - r + recipe.height * tv;

  const dot = tdx * rx + tdy * ry + tdz * rz;
  const k = scale * inv * recipe.height;
  out[1] = -rx + k * (tdx - rx * dot);
  out[2] = -ry + k * (tdy - ry * dot);
  out[3] = -rz + k * (tdz - rz * dot);
}
