import { describe, it, expect } from 'vitest';
import { pcg, pcg2d, pcg3d, pcg4d, pcg4dInto, toUnit, toInt } from '../core/hash.ts';

// Golden test for the pinned PCG hash. This is the determinism wire (Constitution
// II.14, pipeline §4.6): the recorded outputs must never change. When the Rust/WASM
// port lands, it must reproduce these exact values bit-for-bit.

const U32_MAX = 0xffffffff;

function isU32(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= U32_MAX;
}

describe('pcg — u32 discipline', () => {
  it('all variants return u32 across a sweep of inputs', () => {
    for (let i = 0; i < 1000; i++) {
      expect(isU32(pcg(i))).toBe(true);
      const [a, b] = pcg2d(i, i * 7 + 1);
      expect(isU32(a) && isU32(b)).toBe(true);
      const [c, d, e] = pcg3d(i, i + 11, i * 3);
      expect(isU32(c) && isU32(d) && isU32(e)).toBe(true);
      const [f, g, h, k] = pcg4d(i, i + 5, i + 9, i + 13);
      expect(isU32(f) && isU32(g) && isU32(h) && isU32(k)).toBe(true);
    }
  });

  it('handles large u32 inputs without precision loss (the Math.imul rule)', () => {
    // 0xFFFFFFFF would overflow float64 mantissa with plain `*`; Math.imul must hold.
    expect(isU32(pcg(0xffffffff))).toBe(true);
    expect(pcg(0xffffffff)).toBe(pcg(0xffffffff));
  });
});

describe('pcg — determinism', () => {
  it('is a pure function (same input → same output)', () => {
    expect(pcg(12345)).toBe(pcg(12345));
    expect(pcg3d(1, 2, 3)).toEqual(pcg3d(1, 2, 3));
    expect(pcg4d(9, 8, 7, 6)).toEqual(pcg4d(9, 8, 7, 6));
  });

  it('distinct inputs avalanche to distinct outputs', () => {
    expect(pcg(0)).not.toBe(pcg(1));
    expect(pcg3d(0, 0, 0)).not.toEqual(pcg3d(0, 0, 1));
  });
});

describe('pcg — golden recorded values (FROZEN)', () => {
  it('pcg', () => {
    expect([pcg(0), pcg(1), pcg(42), pcg(0xdeadbeef)]).toMatchInlineSnapshot(`
      [
        129708002,
        2831084092,
        1223963391,
        1730779506,
      ]
    `);
  });
  it('pcg2d', () => {
    expect([pcg2d(0, 0), pcg2d(1, 2), pcg2d(1000, 2000)]).toMatchInlineSnapshot(`
      [
        [
          417608103,
          90043601,
        ],
        [
          45825804,
          214070181,
        ],
        [
          1912109347,
          831066463,
        ],
      ]
    `);
  });
  it('pcg3d', () => {
    expect([pcg3d(0, 0, 0), pcg3d(1, 2, 3), pcg3d(100, 200, 300)]).toMatchInlineSnapshot(`
      [
        [
          2611992518,
          2833812075,
          1058359340,
        ],
        [
          4204755366,
          1223881804,
          1500469937,
        ],
        [
          222828298,
          771223438,
          3286403554,
        ],
      ]
    `);
  });
  it('pcg4d', () => {
    expect([pcg4d(0, 0, 0, 0), pcg4d(1, 2, 3, 4)]).toMatchInlineSnapshot(`
      [
        [
          251852841,
          760645481,
          850445371,
          3542436074,
        ],
        [
          908250390,
          4044648920,
          3775961919,
          45698095,
        ],
      ]
    `);
  });
});

describe('pcg4dInto — non-allocating, bit-identical to pcg4d', () => {
  it('writes exactly the same 4 u32 as pcg4d across a sweep', () => {
    const out = new Uint32Array(4);
    for (let i = 0; i < 1000; i++) {
      const expected = pcg4d(i, i * 7 + 1, i + 13, 0xabcd ^ i);
      pcg4dInto(i, i * 7 + 1, i + 13, 0xabcd ^ i, out);
      expect([out[0], out[1], out[2], out[3]]).toEqual(expected);
    }
  });
});

describe('helpers', () => {
  it('toUnit is in [0, 1)', () => {
    for (let i = 0; i < 1000; i++) {
      const u = toUnit(pcg(i));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('toInt is in [0, n)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = toInt(pcg(i), 12);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(12);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
