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
  /** Domain-warp strength (1st iteration). 0 disables the warp. */
  warpStrength: number;
  /** 2nd domain-warp iteration strength (master plan §5.2 allows 1–2). 0 skips it (cheaper). [T] */
  warpStrength2: number;
  /** Ridged mountains: feature count of the ridge field across the sphere (mid-frequency → ranges, not
   *  peaks). 0 disables ridges. [T] */
  ridgeScale: number;
  /** Ridge amplitude in tv-units (× height m). One-sided (ridges only ADD relief). [T] */
  ridgeAmp: number;
  /** Ridge fBm octave count. [T] */
  ridgeOct: number;
  /** Ridge land-mask knees (in the continental value ∈ [-1,1]): ridges fade in from maskLo→maskHi so
   *  mountain ranges rise on continents, not on the ocean floor. [T] */
  maskLo: number;
  maskHi: number;
  /** Continental mask: feature count of the low-frequency landmass field across the sphere
   *  (≪ noiseScale → a few big continents, not islands). 0 disables continents. [T] */
  contScale: number;
  /** Continental elevation bias amplitude, in tv-units (× height m). Sets continent-vs-ocean relief. [T] */
  contAmp: number;
  /** Continental fBm octave count (low — continents are smooth, LOD-independent). [T] */
  contOct: number;
  /** Continental spline knees (in the continental fBm's ~[-1,1] value range): below contLo → ocean
   *  basin, above contHi → continental shelf, the narrow band between is the coastline. [T] */
  contLo: number;
  contHi: number;
  /** The planet's terrain seed (seedchain: childSeed(planet, 0, SALT.terrain)). */
  seed: number;
}

/**
 * Max fBm octaves at the finest LOD. Bounds per-leaf cost (fBm is O(octaves)) and
 * caps detail once finer octaves fall below the cell size, where they'd only alias.
 *
 * Sized to the DEEPEST mesh resolution: at MAX_DEPTH=15 the cells are ~9.5 m, so the
 * finest octave that the mesh can actually resolve (cell ≤ ½·wavelength) is octave ~10
 * (~44 m wavelength → resolved by ~19 m / depth-14 cells, with a level of margin). Octaves
 * beyond that have wavelengths BELOW the cell size: the mesh can never represent them, so
 * they don't add visible relief — they only make the surface SHIMMER/SHIFT as you move (each
 * step re-samples the sub-cell field at a slightly different point) and float the walk
 * collision above the drawn ground (the analytic probe sees bumps the mesh smooths away).
 * 11 octaves (0..10) keeps every octave the deepest mesh can show and drops only the
 * unresolvable ones, so the ground reads CALMER and stays stable underfoot. The material's
 * render-space detail (terrainMaterial octave A ~40 m) still supplies finer visual texture by
 * shading, so the surface isn't bland. [T] tunable — pair any MAX_DEPTH change with this
 * (finest resolvable octave ≈ recipe.octaves + (MAX_DEPTH−1)).
 */
export const OCT_MAX = 11;

/**
 * LOD→octave OFFSET. octaves(lod) = clamp(lod − LOD_OCT_OFFSET, 1, OCT_MAX). The slope is 1 octave per
 * level (lacunarity 2 → cell halves each level → one new resolvable octave per level), but the OFFSET is
 * what aligns the finest octave to the cell size. The old schedule (`recipe.octaves + lod`, offset −4)
 * put the finest octave ~55× BELOW the cell at every LOD, so the top ~7 octaves aliased into spiky
 * "blades" at any coarse view. With offset +4 the finest octave is ≈4.7 cells wide (cell ÷ wavelength
 * ≈ 0.21) — comfortably above Nyquist, no aliasing. Derived from noiseScale (45.5 km oct-0 wavelength)
 * vs cell(lod) ≈ 9.5 m · 2^(15−lod); RECOMPUTE if noiseScale changes. Lower to 3 for ~2.3-cell (sharper)
 * detail if the result reads too smooth.
 */
export const LOD_OCT_OFFSET = 4;

/**
 * Octave count for a leaf at quadtree depth `lod`: clamp(lod − LOD_OCT_OFFSET, 1, OCT_MAX) — one finer
 * octave per level (so the finest octave's wavelength stays a fixed ~4.7× the cell size, which halves
 * each level → detail matched to resolution, never sub-cell/aliased), floored at 1 and capped at OCT_MAX.
 * The geomorph relies on adjacent levels differing by AT MOST one octave: a fine leaf's morph target (its
 * value minus the finest octave) is then its coarse parent's detail level → crack-free LOD transitions.
 *
 * The floor of 1 (not 0) is deliberate: it keeps the coarsest leaves at one shared octave count (like the
 * OCT_MAX cap does at the deep end) so the morph stays crack-free there, and it avoids fbm3's octaves=0
 * divide-by-zero (norm=0 → NaN). Coarse/orbit leaves carry only the few low-frequency octaves the mesh can
 * resolve (smooth); finer detail fades in matched to the cell on descent.
 */
export function lodOctaves(_recipe: TerrainRecipe, lod: number): number {
  return Math.max(1, Math.min(OCT_MAX, lod - LOD_OCT_OFFSET));
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
    // 2nd domain-warp iteration OFF: stacked on the 1st (0.7) it over-warped the terrain into a mushy,
    // spiky mess (master plan §5.2: "more gets mushy"). The single warp already gives plenty of character.
    warpStrength2: 0,
    // Ridged mountains → coherent ranges visible from low orbit ("balanced" relief). ridgeOct 2 (was 4)
    // keeps the ranges BROAD so their finest octave (~63 km) is resolvable from low orbit instead of
    // aliasing into spikes (the old ridgeOct 4 reached ~16 km features that shattered on 300 km+ orbit
    // cells). ridgeScale 30 (was 50) = fewer, larger ranges; ridgeAmp 0.3 (was 0.2) makes them read as
    // real elevated mountains. Folded (1−|m|)² crests, on continents only. [T] tune on screenshots.
    ridgeScale: 30,
    ridgeAmp: 0.3,
    ridgeOct: 2,
    maskLo: -0.2,
    maskHi: 0.5,
    // Continental mask: ~8 big landmasses across the sphere, biasing the surface ±contAmp·height so
    // land/sea reads as coherent continents instead of uniform island-noise. The spline knees are WIDE
    // (±0.35, not ±0.15) so continental margins are gradual SLOPES, not the sharp shelves/cliffs that
    // produced spiky cross-LOD triangles when streaming; lower amplitude (0.45) keeps the relief modest.
    // contOct 2 (was 3) so even the finest continental octave (~398 km) is resolvable at the coarsest LOD
    // (no continent-edge aliasing from orbit).
    contScale: 8,
    contAmp: 0.45,
    contOct: 2,
    contLo: -0.35,
    contHi: 0.35,
    seed: terrainSeed >>> 0,
  };
}

/** smoothstep(lo,hi,x): C¹ ramp 0→1; with smoothstepDeriv its analytic d/dx (0 outside the band). */
function smoothstep(lo: number, hi: number, x: number): number {
  let t = (x - lo) / (hi - lo);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}
function smoothstepDeriv(lo: number, hi: number, x: number): number {
  const inv = 1 / (hi - lo);
  const t = (x - lo) * inv;
  if (t <= 0 || t >= 1) return 0;
  return 6 * t * (1 - t) * inv;
}

// Scratch buffers (single-threaded; the call chain densityAt→terrain→fbm3 never
// reuses a buffer that an inner call also writes).
const _wx = new Float64Array(4);
const _wy = new Float64Array(4);
const _wz = new Float64Array(4);
const _wx2 = new Float64Array(4); // 2nd domain-warp channels (evaluated at the once-warped point q₁)
const _wy2 = new Float64Array(4);
const _wz2 = new Float64Array(4);
const _n = new Float64Array(4);
const _nLo = new Float64Array(4); // coarser (one-octave-dropped) main fBm value+gradient
const _c = new Float64Array(4); // continental mask value+gradient (low-frequency landmass field)
const _m = new Float64Array(4); // ridge fBm value+gradient (mountain field)
const _ja = new Float64Array(3); // scratch: Jᵀ-transformed gradient (out)
const _jb = new Float64Array(3); // scratch: Jᵀ-transformed gradient (outLo)
const _t = new Float64Array(4);

/** Apply one warp Jacobian transpose to a gradient: (Jᵀg)_i = g_i + A·Σⱼ wⱼ.d[i]·gⱼ, where `wx/wy/wz`
 *  hold the three warp channels' value+gradient (`w*[1..3]` = ∂channel/∂axis). Writes the 3-vector into
 *  `dst`. This is the chain-rule step for `f(p + A·w(p))`; composing two of them gives the 2-iteration
 *  domain-warp gradient `J₁ᵀ·J₂ᵀ·∇f`. */
function jacT(
  A: number,
  wx: Float64Array,
  wy: Float64Array,
  wz: Float64Array,
  gx: number,
  gy: number,
  gz: number,
  dst: Float64Array,
): void {
  dst[0] = gx + A * (wx[1]! * gx + wy[1]! * gy + wz[1]! * gz);
  dst[1] = gy + A * (wx[2]! * gx + wy[2]! * gy + wz[2]! * gz);
  dst[2] = gz + A * (wx[3]! * gx + wy[3]! * gy + wz[3]! * gz);
}

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
 * Optional `outLo` (length ≥ 4) receives the terrain VALUE AND GRADIENT one octave
 * smoother (the main fBm's "parent-resolution" surface under the SAME domain warp)
 * — the LOD geomorph target. The gradient runs through the SAME warp Jacobian as
 * `out`, so the mesher can build the morph target's ANALYTIC normal (matching the
 * base normal); a fully-morphed leaf then shades exactly like its coarse neighbour.
 * `out` is unaffected, and `outLo[0]` is bit-identical to before.
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
  const A2 = recipe.warpStrength2;
  const s = recipe.seed;
  const o = recipe.octaves;
  const oMain = octaveCount ?? o;
  const lac = recipe.lacunarity;
  const g = recipe.gain;

  // ── Domain warp (1–2 iterations) ───────────────────────────────────────────
  // Three decorrelated warp channels per iteration (distinct seeds + offsets). Warp octaves stay fixed at
  // the recipe's count so the warped sample point q(p) is identical for every leaf regardless of LOD →
  // adjacent leaves agree, the geomorph only has to hide the MAIN fBm's finest octave. q₁ = p + A₁·w₁(p);
  // q₂ = q₁ + A₂·w₂(q₁) (skipped when A₂=0). All fields below are sampled at q₂, and their gradient is
  // mapped back to p with the composed Jacobian J₁ᵀ·J₂ᵀ (jacT applied twice).
  fbm3((s ^ 0x1111_1111) >>> 0, px + 11.5, py + 5.2, pz + 19.3, o, lac, g, _wx);
  fbm3((s ^ 0x2222_2222) >>> 0, px + 7.7, py + 13.1, pz + 3.9, o, lac, g, _wy);
  fbm3((s ^ 0x3333_3333) >>> 0, px + 2.4, py + 9.8, pz + 27.1, o, lac, g, _wz);
  const q1x = px + A * _wx[0]!;
  const q1y = py + A * _wy[0]!;
  const q1z = pz + A * _wz[0]!;
  let qx = q1x, qy = q1y, qz = q1z;
  if (A2 !== 0) {
    fbm3((s ^ 0x6666_6666) >>> 0, q1x + 4.3, q1y + 22.7, q1z + 8.1, o, lac, g, _wx2);
    fbm3((s ^ 0x7777_7777) >>> 0, q1x + 19.6, q1y + 1.4, q1z + 12.8, o, lac, g, _wy2);
    fbm3((s ^ 0x8888_8888) >>> 0, q1x + 9.2, q1y + 15.5, q1z + 3.6, o, lac, g, _wz2);
    qx = q1x + A2 * _wx2[0]!;
    qy = q1y + A2 * _wy2[0]!;
    qz = q1z + A2 * _wz2[0]!;
  }

  // Main fBm at the twice-warped point. fbm3 writes the coarser value+gradient into _nLo (the geomorph
  // target — same warp/continents/ridges, only the finest detail octave dropped).
  fbm3(s, qx, qy, qz, oMain, lac, g, _n, outLo ? _nLo : undefined);

  // ── Continental mask ───────────────────────────────────────────────────────
  // A low-frequency landmass field of the warped point (sampled at q·kc, kc=contScale/noiseScale, so it
  // shares the domain warp → curved coastlines), remapped through a smooth spline into a terrain bias:
  // below contLo → ocean basin, above contHi → continental shelf. This is what makes land/sea read as
  // coherent continents instead of island-noise. `cont` (∈[-1,1]) and its q-space gradient `dcont*` are
  // also reused as the ridge land-mask below. LOD-INDEPENDENT (identical in out/outLo → never morphs).
  let cont = 0, dcontx = 0, dconty = 0, dcontz = 0;
  if (recipe.contAmp !== 0) {
    const kc = recipe.contScale / recipe.noiseScale;
    fbm3((s ^ 0x5555_5555) >>> 0, qx * kc, qy * kc, qz * kc, recipe.contOct, lac, g, _c);
    cont = 2 * smoothstep(recipe.contLo, recipe.contHi, _c[0]!) - 1;
    // ∂cont/∂q = 2·S'(c)·kc·∇c  (chain: spline ∘ rescale-by-kc ∘ fbm)
    const cs = 2 * smoothstepDeriv(recipe.contLo, recipe.contHi, _c[0]!) * kc;
    dcontx = cs * _c[1]!;
    dconty = cs * _c[2]!;
    dcontz = cs * _c[3]!;
  }
  const contV = recipe.contAmp * cont;
  let cgx = recipe.contAmp * dcontx, cgy = recipe.contAmp * dconty, cgz = recipe.contAmp * dcontz;

  // ── Ridged mountains ───────────────────────────────────────────────────────
  // A mid-frequency ridge field folded `(1−|m|)²` (sharp crests, C¹ amplitude → continuous normals),
  // multiplied by a continental land-mask so ranges rise on land, not the ocean floor. One-sided (adds
  // relief only). LOD-INDEPENDENT (macro relief never morphs). Its q-space gradient adds into cg*.
  let ridgeV = 0;
  if (recipe.ridgeAmp !== 0) {
    const kr = recipe.ridgeScale / recipe.noiseScale;
    fbm3((s ^ 0x9999_9999) >>> 0, qx * kr, qy * kr, qz * kr, recipe.ridgeOct, lac, g, _m);
    const mv = _m[0]!;
    const absm = mv >= 0 ? mv : -mv;
    const sgn = mv >= 0 ? 1 : -1;
    const oneMinus = 1 - absm;
    const ridge = oneMinus * oneMinus;
    const mask = smoothstep(recipe.maskLo, recipe.maskHi, cont);
    const maskD = smoothstepDeriv(recipe.maskLo, recipe.maskHi, cont);
    ridgeV = recipe.ridgeAmp * ridge * mask;
    // ∂(ridge·mask)/∂q = mask·∂ridge/∂q + ridge·∂mask/∂q
    //   ∂ridge/∂q = 2(1−|m|)·(−sgn)·kr·∇m ;  ∂mask/∂q = maskD·∂cont/∂q
    const rd = 2 * oneMinus * -sgn * kr;
    cgx += recipe.ridgeAmp * (mask * rd * _m[1]! + ridge * maskD * dcontx);
    cgy += recipe.ridgeAmp * (mask * rd * _m[2]! + ridge * maskD * dconty);
    cgz += recipe.ridgeAmp * (mask * rd * _m[3]! + ridge * maskD * dcontz);
  }

  const macroV = contV + ridgeV; // continents + ridges — identical for out and outLo (never morphs)

  // out: q-space gradient of (main fBm + macro terms) → p-space via J₁ᵀ·J₂ᵀ.
  let gx = _n[1]! + cgx, gy = _n[2]! + cgy, gz = _n[3]! + cgz;
  if (A2 !== 0) { jacT(A2, _wx2, _wy2, _wz2, gx, gy, gz, _ja); gx = _ja[0]!; gy = _ja[1]!; gz = _ja[2]!; }
  jacT(A, _wx, _wy, _wz, gx, gy, gz, _ja);
  out[0] = _n[0]! + macroV;
  out[1] = _ja[0]!;
  out[2] = _ja[1]!;
  out[3] = _ja[2]!;
  if (outLo) {
    // Same composed warp + same macro terms applied to the coarser main gradient → the morph target's
    // analytic gradient (a fully-morphed leaf keeps the same continents/mountains; only the finest detail
    // octave fades).
    let lx = _nLo[1]! + cgx, ly = _nLo[2]! + cgy, lz = _nLo[3]! + cgz;
    if (A2 !== 0) { jacT(A2, _wx2, _wy2, _wz2, lx, ly, lz, _jb); lx = _jb[0]!; ly = _jb[1]!; lz = _jb[2]!; }
    jacT(A, _wx, _wy, _wz, lx, ly, lz, _jb);
    outLo[0] = _nLo[0]! + macroV;
    outLo[1] = _jb[0]!;
    outLo[2] = _jb[1]!;
    outLo[3] = _jb[2]!;
  }
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
