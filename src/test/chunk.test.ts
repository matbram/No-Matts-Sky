import { describe, it, expect } from 'vitest';
import { densityAt, sliceTerrainRecipe, type TerrainRecipe } from '../core/density.ts';
import { meshChunk, uvRectFromPath, chunkKey, type ChunkRequest } from '../core/chunk.ts';
import { EARTH_RADIUS_M } from '../core/constants.ts';
import { fnv1a } from './digest.ts';

// Step 1 gate (slice spec §6): a correctly-shaped, correctly-LIT patch matching
// the density field, meshed off-thread. The off-thread part is a worker concern;
// here we verify the CORE the worker runs: the field's analytic normals are
// correct (== finite differences), the mesher is well-formed and outward-facing,
// and everything is deterministic.

const RECIPE: TerrainRecipe = sliceTerrainRecipe(0x0bad_f00d);
const R = EARTH_RADIUS_M;

describe('densityAt — analytic gradient (the normals)', () => {
  it('matches finite differences at points near the surface', () => {
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    const g = new Float64Array(4);
    // Deterministic pseudo-random directions (no Math.random in tests either).
    for (let s = 1; s <= 40; s++) {
      const th = (s * 2.399963) % (Math.PI * 2); // golden-angle spiral
      const ph = Math.acos(1 - (2 * (s - 0.5)) / 40);
      const dx = Math.sin(ph) * Math.cos(th);
      const dy = Math.sin(ph) * Math.sin(th);
      const dz = Math.cos(ph);
      const r = R + ((s % 7) - 3) * 1500;
      const x = dx * r, y = dy * r, z = dz * r;

      densityAt(RECIPE, R, x, y, z, g);
      const eps = 2;
      densityAt(RECIPE, R, x + eps, y, z, a);
      densityAt(RECIPE, R, x - eps, y, z, b);
      const fx = (a[0]! - b[0]!) / (2 * eps);
      densityAt(RECIPE, R, x, y + eps, z, a);
      densityAt(RECIPE, R, x, y - eps, z, b);
      const fy = (a[0]! - b[0]!) / (2 * eps);
      densityAt(RECIPE, R, x, y, z + eps, a);
      densityAt(RECIPE, R, x, y, z - eps, b);
      const fz = (a[0]! - b[0]!) / (2 * eps);

      expect(Math.abs(g[1]! - fx)).toBeLessThan(2e-3);
      expect(Math.abs(g[2]! - fy)).toBeLessThan(2e-3);
      expect(Math.abs(g[3]! - fz)).toBeLessThan(2e-3);
    }
  });

  it('is solid below the surface and air well above it', () => {
    const o = new Float64Array(4);
    densityAt(RECIPE, R, 0, R - 50_000, 0, o);
    expect(o[0]!).toBeGreaterThan(0); // deep inside → solid
    densityAt(RECIPE, R, 0, R + 50_000, 0, o);
    expect(o[0]!).toBeLessThan(0); // well above peaks → air
  });
});

describe('uvRectFromPath', () => {
  it('halves the face per quadrant', () => {
    expect(uvRectFromPath([])).toEqual({ u0: -1, u1: 1, v0: -1, v1: 1 });
    expect(uvRectFromPath([3])).toEqual({ u0: 0, u1: 1, v0: 0, v1: 1 }); // +u,+v
    expect(uvRectFromPath([0])).toEqual({ u0: -1, u1: 0, v0: -1, v1: 0 }); // -u,-v
  });
});

describe('meshChunk', () => {
  const req: ChunkRequest = { face: 2, path: [2, 1], lod: 2 };

  it('produces a well-formed, non-empty patch', () => {
    const m = meshChunk(req, RECIPE, R, 16, 10);
    expect(m.vertexCount).toBeGreaterThan(0);
    expect(m.triangleCount).toBeGreaterThan(0);
    expect(m.positions.length).toBe(m.vertexCount * 3);
    expect(m.normals.length).toBe(m.vertexCount * 3);
    expect(m.indices.length).toBe(m.triangleCount * 3);
    expect(m.key).toBe(chunkKey(req));
    for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
  });

  it('every normal is unit length', () => {
    const m = meshChunk(req, RECIPE, R, 16, 10);
    for (let v = 0; v < m.vertexCount; v++) {
      const nx = m.normals[v * 3]!;
      const ny = m.normals[v * 3 + 1]!;
      const nz = m.normals[v * 3 + 2]!;
      expect(Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1)).toBeLessThan(1e-4);
    }
  });

  it('every triangle winds outward (geometric normal agrees with analytic normals)', () => {
    const m = meshChunk(req, RECIPE, R, 16, 10);
    const p = m.positions;
    const n = m.normals;
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]!, b = m.indices[t + 1]!, c = m.indices[t + 2]!;
      const e1x = p[b * 3]! - p[a * 3]!, e1y = p[b * 3 + 1]! - p[a * 3 + 1]!, e1z = p[b * 3 + 2]! - p[a * 3 + 2]!;
      const e2x = p[c * 3]! - p[a * 3]!, e2y = p[c * 3 + 1]! - p[a * 3 + 1]!, e2z = p[c * 3 + 2]! - p[a * 3 + 2]!;
      const gnx = e1y * e2z - e1z * e2y, gny = e1z * e2x - e1x * e2z, gnz = e1x * e2y - e1y * e2x;
      const anx = n[a * 3]! + n[b * 3]! + n[c * 3]!;
      const any = n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!;
      const anz = n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!;
      expect(gnx * anx + gny * any + gnz * anz).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic: same request → identical buffers', () => {
    const a = meshChunk(req, RECIPE, R, 16, 10);
    const b = meshChunk(req, RECIPE, R, 16, 10);
    expect(fnv1a(a.positions)).toBe(fnv1a(b.positions));
    expect(fnv1a(a.normals)).toBe(fnv1a(b.normals));
    expect(fnv1a(a.indices)).toBe(fnv1a(b.indices));
  });

  it('matches recorded digests (FROZEN)', () => {
    const m = meshChunk(req, RECIPE, R, 16, 10);
    expect({
      positions: fnv1a(m.positions),
      normals: fnv1a(m.normals),
      indices: fnv1a(m.indices),
      vertexCount: m.vertexCount,
      triangleCount: m.triangleCount,
    }).toMatchInlineSnapshot(`
      {
        "indices": "602e89e0",
        "normals": "15c40a9a",
        "positions": "39fc27a5",
        "triangleCount": 968,
        "vertexCount": 483,
      }
    `);
  });
});
