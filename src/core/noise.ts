// ─────────────────────────────────────────────────────────────────────────────
// Gradient (Perlin-style) noise + fBm — PURE TS, no Three.js. Step 1.
//
// The canonical recipe (canonical-generation-pipeline.md §3.G, master plan §5.2):
// terrain is fBm of a base gradient noise, with DOMAIN WARP for character. The
// load-bearing discipline is ANALYTIC derivatives: every function returns its
// value AND its gradient in one pass, so the density field's normals come free
// instead of triple-sampling (CLAUDE.md §4, master plan §5.2 "Trap — normals").
//
// Determinism: lattice gradients are hashed with the pinned PCG (`pcg4d`), so the
// noise is bit-identical everywhere (Constitution II.14). No Math.random, no
// sin-hashing. Base noise variant: gradient/Perlin (the slice's one open choice,
// README §"open implementation choice") — chosen for cheap analytic derivatives.
//
// Outputs are written into caller-provided Float64Array(4) `[value, dx, dy, dz]`
// to avoid per-sample allocation in the hot meshing loop.
// ─────────────────────────────────────────────────────────────────────────────

import { pcg4dInto, toUnit } from './hash.ts';

// Reused scratch for the 8 cube-corner gradients/values (single-threaded, and
// gradNoise3 is never reentrant: nothing it calls reads these back).
const _gx = new Float64Array(8);
const _gy = new Float64Array(8);
const _gz = new Float64Array(8);
const _vv = new Float64Array(8);
const _h4 = new Uint32Array(4); // scratch for the non-allocating corner hash

// Local corner offsets, indexed L = a | b<<1 | c<<2  (a,b,c ∈ {0,1} along x,y,z).
const COFF_A = [0, 1, 0, 1, 0, 1, 0, 1];
const COFF_B = [0, 0, 1, 1, 0, 0, 1, 1];
const COFF_C = [0, 0, 0, 0, 1, 1, 1, 1];

/**
 * 3D gradient noise with analytic derivative.
 * Writes `[value, ∂/∂x, ∂/∂y, ∂/∂z]` into `out`. Value is ~[-1, 1].
 *
 * Classic Perlin gradient noise with the quintic fade `6t⁵−15t⁴+10t³`; the
 * derivative uses the closed form (Inigo Quilez): interpolate the corner
 * gradients with the fade weights, plus the fade-derivative times the value
 * differences. No finite differences anywhere.
 */
export function gradNoise3(
  seed: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  // Quintic fade weights and their derivatives.
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const duz = 30 * fz * fz * (fz * (fz - 2) + 1);

  // 8 corner unit gradients (hashed) and corner dot-values.
  for (let L = 0; L < 8; L++) {
    const a = COFF_A[L]!;
    const b = COFF_B[L]!;
    const c = COFF_C[L]!;
    pcg4dInto(ix + a, iy + b, iz + c, seed, _h4);
    let gx = toUnit(_h4[0]!) * 2 - 1;
    let gy = toUnit(_h4[1]!) * 2 - 1;
    let gz = toUnit(_h4[2]!) * 2 - 1;
    const inv = 1 / Math.sqrt(gx * gx + gy * gy + gz * gz + 1e-30);
    gx *= inv;
    gy *= inv;
    gz *= inv;
    _gx[L] = gx;
    _gy[L] = gy;
    _gz[L] = gz;
    _vv[L] = gx * (fx - a) + gy * (fy - b) + gz * (fz - c);
  }

  const va = _vv[0]!,
    vb = _vv[1]!,
    vc = _vv[2]!,
    vd = _vv[3]!,
    ve = _vv[4]!,
    vf = _vv[5]!,
    vg = _vv[6]!,
    vh = _vv[7]!;

  // Trilinear-with-fade coefficients of the value.
  const k0 = va;
  const k1 = vb - va;
  const k2 = vc - va;
  const k3 = ve - va;
  const k4 = va - vb - vc + vd;
  const k5 = va - vc - ve + vg;
  const k6 = va - vb - ve + vf;
  const k7 = -va + vb + vc - vd + ve - vf - vg + vh;

  out[0] =
    k0 +
    k1 * ux +
    k2 * uy +
    k3 * uz +
    k4 * ux * uy +
    k5 * uy * uz +
    k6 * uz * ux +
    k7 * ux * uy * uz;

  // Gradient = (interpolated corner gradients) + (fade-derivative × value coeffs).
  out[1] = interp(_gx, ux, uy, uz) + dux * (k1 + k4 * uy + k6 * uz + k7 * uy * uz);
  out[2] = interp(_gy, ux, uy, uz) + duy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux);
  out[3] = interp(_gz, ux, uy, uz) + duz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy);
}

/** Interpolate one component of the 8 corner gradients with the fade weights. */
function interp(g: Float64Array, ux: number, uy: number, uz: number): number {
  const ga = g[0]!,
    gb = g[1]!,
    gc = g[2]!,
    gd = g[3]!,
    ge = g[4]!,
    gf = g[5]!,
    gg = g[6]!,
    gh = g[7]!;
  return (
    ga +
    ux * (gb - ga) +
    uy * (gc - ga) +
    uz * (ge - ga) +
    ux * uy * (ga - gb - gc + gd) +
    uy * uz * (ga - gc - ge + gg) +
    uz * ux * (ga - gb - ge + gf) +
    ux * uy * uz * (-ga + gb + gc - gd + ge - gf - gg + gh)
  );
}

// Scratch for the per-octave gradNoise3 result inside fbm3.
const _gn = new Float64Array(4);

/**
 * Fractal Brownian motion (sum of gradient-noise octaves) with analytic
 * derivative. Writes `[value, dx, dy, dz]` into `out`; value normalized to ~[-1, 1].
 *
 * Each octave: ×`lacunarity` frequency, ×`gain` amplitude. The derivative gets
 * the chain-rule frequency factor per octave. Octaves are decorrelated by a
 * deterministic per-octave seed offset.
 *
 * Optional `outLo` (length ≥ 4) receives the LOD geomorph target: the VALUE AND
 * GRADIENT of all but the FINEST octave, normalized over THOSE (octaves−1)
 * amplitudes — i.e. EXACTLY the surface a parent leaf with one fewer octave renders.
 * (Normalizing over the full `octaves` denominator instead would scale the parent's
 * value by normLo/norm — negligible at many octaves (~1.6% at 6→5) but a large 33%
 * at 2→1, so a morph to it would POP at shallow-LOD swaps. Normalizing over its own
 * amplitudes makes morph=1 reproduce the parent at ANY octave count.) Captured for
 * free here (no extra noise evals) and a pure function of position, so neighbouring
 * chunks agree exactly → no seams mid-morph; the gradient gives the morph target an
 * ANALYTIC normal matching the parent. `out[0..3]` is bit-identical with or without
 * `outLo`.
 */
export function fbm3(
  seed: number,
  x: number,
  y: number,
  z: number,
  octaves: number,
  lacunarity: number,
  gain: number,
  out: Float64Array,
  outLo?: Float64Array,
): void {
  let v = 0;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  let vLo = 0, dxLo = 0, dyLo = 0, dzLo = 0; // value + gradient captured before the finest octave
  let normLo = 0; // amplitude sum of all but the finest octave (the parent's own denominator)
  const loCount = octaves - 1;
  for (let o = 0; o < octaves; o++) {
    if (o === loCount) { vLo = v; dxLo = dx; dyLo = dy; dzLo = dz; normLo = norm; }
    const os = (seed + Math.imul(o, 0x9e3779b1)) >>> 0;
    gradNoise3(os, x * freq, y * freq, z * freq, _gn);
    v += amp * _gn[0]!;
    dx += amp * freq * _gn[1]!;
    dy += amp * freq * _gn[2]!;
    dz += amp * freq * _gn[3]!;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  const inv = 1 / norm;
  out[0] = v * inv;
  out[1] = dx * inv;
  out[2] = dy * inv;
  out[3] = dz * inv;
  // outLo = the (octaves−1)-octave surface normalized over ITS OWN amplitudes (1/normLo), so it equals
  // exactly what a parent leaf with one fewer octave renders → a morph to it is pop-free at any octave
  // count (see the header). Octaves<2: no finer octave to drop, so outLo == out.
  if (outLo) {
    if (octaves > 1) {
      const invLo = 1 / normLo;
      outLo[0] = vLo * invLo;
      outLo[1] = dxLo * invLo;
      outLo[2] = dyLo * invLo;
      outLo[3] = dzLo * invLo;
    } else {
      outLo[0] = out[0];
      outLo[1] = out[1];
      outLo[2] = out[2];
      outLo[3] = out[3];
    }
  }
}
