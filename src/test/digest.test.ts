import { describe, it, expect } from 'vitest';
import { fnv1a } from './digest.ts';

// Known-answer test for the FNV-1a-32 digest helper. Every golden in the suite
// (cube-sphere, chunk, surfacenets, …) hashes its data through fnv1a, so if this
// function itself ever drifts, ALL those goldens move at once with no explanation.
// This pins fnv1a against the PUBLISHED FNV-1a-32 test vectors (independent of any
// project data), so a digest regression fails HERE first and says why.

const enc = new TextEncoder();

describe('fnv1a — published FNV-1a-32 known-answer vectors', () => {
  it('matches the canonical hashes for "", "a", "hello"', () => {
    // Standard FNV-1a-32 vectors (offset basis 0x811c9dc5, prime 0x01000193):
    expect(fnv1a(enc.encode(''))).toBe('811c9dc5'); // empty → the offset basis
    expect(fnv1a(enc.encode('a'))).toBe('e40c292c');
    expect(fnv1a(enc.encode('hello'))).toBe('4f9f2cab');
  });

  it('always returns an 8-char zero-padded lowercase hex string', () => {
    expect(fnv1a(enc.encode(''))).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a(enc.encode('No Matt’s Sky'))).toMatch(/^[0-9a-f]{8}$/);
  });

  it('hashes the raw bytes (typed-array view), and is order-sensitive', () => {
    expect(fnv1a(new Uint8Array([1, 2, 3]))).not.toBe(fnv1a(new Uint8Array([3, 2, 1])));
    // Reads the view's bytes regardless of element type.
    expect(fnv1a(new Float64Array([1]))).toMatch(/^[0-9a-f]{8}$/);
  });
});
