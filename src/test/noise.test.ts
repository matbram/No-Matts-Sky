import { describe, it, expect } from 'vitest';
import { gradNoise3, fbm3 } from '../core/noise.ts';
import { fnv1a } from './digest.ts';

// Step 1 noise: determinism + the load-bearing claim that the ANALYTIC gradient
// is correct (== finite differences). Both verified headlessly.

const SEED = 0x1234_abcd;

function central(
  f: (x: number, y: number, z: number, out: Float64Array) => void,
  x: number,
  y: number,
  z: number,
  eps: number,
): [number, number, number] {
  const a = new Float64Array(4);
  const b = new Float64Array(4);
  f(x + eps, y, z, a);
  f(x - eps, y, z, b);
  const dx = (a[0]! - b[0]!) / (2 * eps);
  f(x, y + eps, z, a);
  f(x, y - eps, z, b);
  const dy = (a[0]! - b[0]!) / (2 * eps);
  f(x, y, z + eps, a);
  f(x, y, z - eps, b);
  const dz = (a[0]! - b[0]!) / (2 * eps);
  return [dx, dy, dz];
}

describe('gradNoise3', () => {
  it('is deterministic', () => {
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    gradNoise3(SEED, 1.3, -2.7, 0.8, a);
    gradNoise3(SEED, 1.3, -2.7, 0.8, b);
    expect([...a]).toEqual([...b]);
  });

  it('value stays in a sane band', () => {
    const o = new Float64Array(4);
    for (let i = 0; i < 500; i++) {
      gradNoise3(SEED, i * 0.37, i * -0.21, i * 0.13, o);
      expect(Math.abs(o[0]!)).toBeLessThan(1.5);
    }
  });

  it('analytic gradient matches finite differences', () => {
    const o = new Float64Array(4);
    const pts: Array<[number, number, number]> = [
      [0.3, 0.7, 0.1],
      [1.25, -2.4, 3.9],
      [-5.1, 0.05, 2.2],
      [10.8, 4.4, -7.3],
    ];
    for (const [x, y, z] of pts) {
      gradNoise3(SEED, x, y, z, o);
      const [fx, fy, fz] = central(
        (a, b, c, out) => gradNoise3(SEED, a, b, c, out),
        x,
        y,
        z,
        1e-4,
      );
      expect(Math.abs(o[1]! - fx)).toBeLessThan(1e-3);
      expect(Math.abs(o[2]! - fy)).toBeLessThan(1e-3);
      expect(Math.abs(o[3]! - fz)).toBeLessThan(1e-3);
    }
  });
});

describe('fbm3', () => {
  it('analytic gradient matches finite differences', () => {
    const o = new Float64Array(4);
    const oct = 5;
    const fn = (a: number, b: number, c: number, out: Float64Array): void =>
      fbm3(SEED, a, b, c, oct, 2.0, 0.5, out);
    const pts: Array<[number, number, number]> = [
      [0.5, 1.5, 2.5],
      [-3.2, 4.1, 0.9],
      [7.7, -1.1, 5.3],
    ];
    for (const [x, y, z] of pts) {
      fn(x, y, z, o);
      const [fx, fy, fz] = central(fn, x, y, z, 1e-4);
      expect(Math.abs(o[1]! - fx)).toBeLessThan(2e-3);
      expect(Math.abs(o[2]! - fy)).toBeLessThan(2e-3);
      expect(Math.abs(o[3]! - fz)).toBeLessThan(2e-3);
    }
  });

  it('matches a recorded digest (FROZEN)', () => {
    const grid = new Float64Array(8 * 8 * 8);
    const o = new Float64Array(4);
    let p = 0;
    for (let k = 0; k < 8; k++)
      for (let j = 0; j < 8; j++)
        for (let i = 0; i < 8; i++) {
          fbm3(SEED, i * 0.5, j * 0.5, k * 0.5, 5, 2.0, 0.5, o);
          grid[p++] = o[0]!;
        }
    expect(fnv1a(grid)).toMatchInlineSnapshot(`"e52eee0a"`);
  });
});
