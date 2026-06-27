import { describe, it, expect } from 'vitest';
import { surfaceAt, densityAt, sliceTerrainRecipe, type TerrainRecipe } from '../core/density.ts';
import { EARTH_RADIUS_M } from '../core/constants.ts';
import { fnv1a } from './digest.ts';

// Step 4: `surfaceAt` is the character controller's collision/orientation probe.
// It MUST return the same surface the mesher builds (the field's zero crossing) so
// the player stands on exactly the rendered terrain. These are the headless proofs:
// the returned radius lands on D≈0, the normal == normalize(−∇D) from densityAt, it
// tilts on slopes, it's deterministic, and a frozen digest catches any field change.

const RECIPE: TerrainRecipe = sliceTerrainRecipe(0x0bad_f00d);
const R = EARTH_RADIUS_M;
const N = 40;

// Deterministic golden-angle spiral of directions (no Math.random in tests).
function dir(s: number): [number, number, number] {
  const th = (s * 2.399963) % (Math.PI * 2);
  const ph = Math.acos(1 - (2 * (s - 0.5)) / N);
  return [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];
}

describe('surfaceAt — collision/orientation probe', () => {
  it('is deterministic (same direction → identical output)', () => {
    const a = new Float64Array(7);
    const b = new Float64Array(7);
    for (let s = 1; s <= N; s++) {
      const [dx, dy, dz] = dir(s);
      surfaceAt(RECIPE, R, dx, dy, dz, a);
      surfaceAt(RECIPE, R, dx, dy, dz, b);
      for (let i = 0; i < 7; i++) expect(b[i]).toBe(a[i]);
    }
  });

  it('returns a radius that lands on the field zero crossing (D≈0)', () => {
    const out = new Float64Array(7);
    const g = new Float64Array(4);
    for (let s = 1; s <= N; s++) {
      const [dx, dy, dz] = dir(s);
      surfaceAt(RECIPE, R, dx, dy, dz, out);
      const rr = out[0]!;
      // The surface point along this direction; densityAt there must be ≈ 0.
      densityAt(RECIPE, R, out[4]! * rr, out[5]! * rr, out[6]! * rr, g);
      expect(Math.abs(g[0]!)).toBeLessThan(1e-2); // meters
    }
  });

  it('normal matches normalize(−∇D) from densityAt at the surface point', () => {
    const out = new Float64Array(7);
    const g = new Float64Array(4);
    for (let s = 1; s <= N; s++) {
      const [dx, dy, dz] = dir(s);
      surfaceAt(RECIPE, R, dx, dy, dz, out);
      const rr = out[0]!;
      densityAt(RECIPE, R, out[4]! * rr, out[5]! * rr, out[6]! * rr, g);
      const gl = 1 / Math.sqrt(g[1]! * g[1]! + g[2]! * g[2]! + g[3]! * g[3]!);
      expect(out[1]!).toBeCloseTo(-g[1]! * gl, 6);
      expect(out[2]!).toBeCloseTo(-g[2]! * gl, 6);
      expect(out[3]!).toBeCloseTo(-g[3]! * gl, 6);
    }
  });

  it('normal is near-radial but tilts on slopes (unit length)', () => {
    const out = new Float64Array(7);
    let minDot = 1;
    for (let s = 1; s <= N; s++) {
      const [dx, dy, dz] = dir(s);
      surfaceAt(RECIPE, R, dx, dy, dz, out);
      const len = Math.hypot(out[1]!, out[2]!, out[3]!);
      expect(len).toBeCloseTo(1, 9); // unit normal
      const dot = out[1]! * out[4]! + out[2]! * out[5]! + out[3]! * out[6]!;
      // Mostly radial (gravity-aligned), but ridged mountains tilt the steepest faces to ~60° (dot≈0.5).
      // 0.4 (~66°) leaves headroom for that while still failing on pathological near-vertical spikes.
      expect(dot).toBeGreaterThan(0.4);
      expect(dot).toBeLessThanOrEqual(1.0000001);
      if (dot < minDot) minDot = dot;
    }
    expect(minDot).toBeLessThan(0.999); // proves the terrain actually tilts the normal
  });

  it('matches the recorded digest (FROZEN — catches any field/formula change)', () => {
    const packed = new Float64Array(N * 4);
    const out = new Float64Array(7);
    for (let s = 1; s <= N; s++) {
      const [dx, dy, dz] = dir(s);
      surfaceAt(RECIPE, R, dx, dy, dz, out);
      packed[(s - 1) * 4] = out[0]!;
      packed[(s - 1) * 4 + 1] = out[1]!;
      packed[(s - 1) * 4 + 2] = out[2]!;
      packed[(s - 1) * 4 + 3] = out[3]!;
    }
    expect(fnv1a(packed)).toMatchInlineSnapshot(`"1cdf809f"`);
  });
});
