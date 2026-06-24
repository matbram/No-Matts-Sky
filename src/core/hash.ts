// ─────────────────────────────────────────────────────────────────────────────
// The pinned canonical hash — PCG (Jarzynski & Olano, JCGT 9(3), 2020).
//
// This is [S] STRUCTURAL and FROZEN (Constitution II.14, canonical-generation-
// pipeline.md §1). It is the foundation of determinism for the entire universe:
// the same coordinate must yield the same world on every machine, forever.
//
// The critical cross-platform rule (pipeline §1.2): JavaScript numbers are
// float64 and `*` loses precision above 2^32, so EVERY 32-bit multiply MUST use
// `Math.imul`, and EVERY result MUST be coerced to u32 with `>>> 0`. Shifts use
// `>>>` (unsigned). Done this way, this TS is bit-identical to the WGSL form in
// the pipeline doc — which is what will later let the Rust/WASM port be verified
// against the golden test. Do NOT "simplify" any of this with `*` or `|0`.
//
// NEVER use Math.random() or sin-based float hashing for any canonical value.
// ─────────────────────────────────────────────────────────────────────────────

/** 1D RXS-M-XS PCG. u32 -> u32. */
export function pcg(n: number): number {
  let h = (Math.imul(n >>> 0, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0;
  return ((h >>> 22) ^ h) >>> 0;
}

/** pcg2d. (u32,u32) -> [u32,u32]. */
export function pcg2d(x: number, y: number): [number, number] {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  return [x >>> 0, y >>> 0];
}

/** pcg3d. (u32,u32,u32) -> [u32,u32,u32]. The workhorse for 3D coordinates. */
export function pcg3d(x: number, y: number, z: number): [number, number, number] {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  return [x >>> 0, y >>> 0, z >>> 0];
}

/** pcg4d. (u32,u32,u32,u32) -> [u32,u32,u32,u32]. Cross-terms y*w, z*x, x*y, y*z. */
export function pcg4d(
  x: number,
  y: number,
  z: number,
  w: number,
): [number, number, number, number] {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  w = (Math.imul(w >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, w)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  w = (w + Math.imul(y, z)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  z = (z ^ (z >>> 16)) >>> 0;
  w = (w ^ (w >>> 16)) >>> 0;
  x = (x + Math.imul(y, w)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  w = (w + Math.imul(y, z)) >>> 0;
  return [x >>> 0, y >>> 0, z >>> 0, w >>> 0];
}

// ── Canonical helpers (pipeline §1.3) ────────────────────────────────────────

/** u32 -> float in [0,1). Exact division by 2^32. Cosmetic/sampling use. */
export const toUnit = (u: number): number => (u >>> 0) / 4294967296;

/**
 * u32 -> integer in [0,n). Integer modulo (slight bias, acceptable & deterministic).
 * THRESHOLD RULE (Constitution II.14): make canonical *decisions* by comparing
 * integer quantities like this — never floats near a boundary, which can flip
 * between machines.
 */
export const toInt = (u: number, n: number): number => (u >>> 0) % n;
