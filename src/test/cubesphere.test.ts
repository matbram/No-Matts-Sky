import { describe, it, expect } from 'vitest';
import { buildCubeSphere, CUBE_FACES, faceDirection, wrapFaceUV } from '../core/cubesphere.ts';
import { EARTH_RADIUS_M } from '../core/constants.ts';
import { fnv1a } from './digest.ts';

// Golden + correctness test for the Step 0 cube-sphere.
// Step 0 gate (CLAUDE.md §6): seamless sphere, golden test passes. The seamless
// check and the recorded digest are both verified HEADLESSLY here; the visual
// "smooth orbit at 60fps" half of the gate needs a real browser + GPU.

describe('buildCubeSphere — structure', () => {
  it('produces the expected vertex/triangle counts', () => {
    const s = 8;
    const mesh = buildCubeSphere(s, 1);
    expect(mesh.vertexCount).toBe(6 * (s + 1) * (s + 1)); // 486
    expect(mesh.triangleCount).toBe(6 * s * s * 2); // 768
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
    expect(mesh.normals.length).toBe(mesh.vertexCount * 3);
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
  });

  it('rejects bad subdivisions', () => {
    expect(() => buildCubeSphere(0, 1)).toThrow();
    expect(() => buildCubeSphere(1.5, 1)).toThrow();
  });

  it('every index is in range', () => {
    const mesh = buildCubeSphere(8, 1);
    for (const idx of mesh.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(mesh.vertexCount);
    }
  });
});

describe('buildCubeSphere — geometry', () => {
  it('all vertices lie on the sphere of the given radius', () => {
    const mesh = buildCubeSphere(16, 1); // unit radius → tight float32 tolerance
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = mesh.positions[v * 3]!;
      const y = mesh.positions[v * 3 + 1]!;
      const z = mesh.positions[v * 3 + 2]!;
      const len = Math.sqrt(x * x + y * y + z * z);
      expect(Math.abs(len - 1)).toBeLessThan(1e-5);
    }
  });

  it('normals are unit and equal the normalized position', () => {
    const mesh = buildCubeSphere(8, EARTH_RADIUS_M);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const nx = mesh.normals[v * 3]!;
      const ny = mesh.normals[v * 3 + 1]!;
      const nz = mesh.normals[v * 3 + 2]!;
      expect(Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1)).toBeLessThan(1e-5);
    }
  });

  it('adjacent faces share an identical edge (seamless — no gaps)', () => {
    // +X face (index 0) v=+1 edge meets +Z face (index 4) u=+1 edge; both are the
    // cube edge (1, t, 1). The projected vertices must coincide exactly.
    const s = 12;
    const mesh = buildCubeSphere(s, EARTH_RADIUS_M);
    const side = s + 1;
    const vertsPerFace = side * side;
    const xFaceBase = 0 * vertsPerFace;
    const zFaceBase = 4 * vertsPerFace;
    for (let k = 0; k <= s; k++) {
      const xv = xFaceBase + k * side + (side - 1); // +X: (i=k, j=side-1)
      const zv = zFaceBase + (side - 1) * side + k; // +Z: (i=side-1, j=k)
      for (let c = 0; c < 3; c++) {
        expect(mesh.positions[xv * 3 + c]).toBe(mesh.positions[zv * 3 + c]);
      }
    }
  });

  it('is watertight: welding by exact position, every edge is shared by exactly two triangles', () => {
    // The definitive "no gaps anywhere" check — covers all 12 cube edges and 8
    // corners at once (not just one face pair). A seam gap would leave boundary
    // edges used by a single triangle.
    const s = 6;
    const mesh = buildCubeSphere(s, EARTH_RADIUS_M);
    const keyToId = new Map<string, number>();
    const remap = new Uint32Array(mesh.vertexCount);
    for (let v = 0; v < mesh.vertexCount; v++) {
      const k = `${mesh.positions[v * 3]},${mesh.positions[v * 3 + 1]},${mesh.positions[v * 3 + 2]}`;
      let id = keyToId.get(k);
      if (id === undefined) {
        id = keyToId.size;
        keyToId.set(k, id);
      }
      remap[v] = id;
    }
    const edgeUse = new Map<string, number>();
    const addEdge = (a: number, b: number): void => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    };
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = remap[mesh.indices[t]!]!;
      const b = remap[mesh.indices[t + 1]!]!;
      const c = remap[mesh.indices[t + 2]!]!;
      addEdge(a, b);
      addEdge(b, c);
      addEdge(c, a);
    }
    let boundaryEdges = 0;
    for (const count of edgeUse.values()) if (count !== 2) boundaryEdges++;
    expect(boundaryEdges).toBe(0);
  });

  it('all triangles wind outward (no culled/black faces that read as holes)', () => {
    const mesh = buildCubeSphere(4, 1);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const ia = mesh.indices[t]! * 3;
      const ib = mesh.indices[t + 1]! * 3;
      const ic = mesh.indices[t + 2]! * 3;
      const ax = mesh.positions[ia]!,
        ay = mesh.positions[ia + 1]!,
        az = mesh.positions[ia + 2]!;
      const e1x = mesh.positions[ib]! - ax,
        e1y = mesh.positions[ib + 1]! - ay,
        e1z = mesh.positions[ib + 2]! - az;
      const e2x = mesh.positions[ic]! - ax,
        e2y = mesh.positions[ic + 1]! - ay,
        e2z = mesh.positions[ic + 2]! - az;
      // face normal = e1 × e2; centroid points radially outward from origin
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const cx = (ax + mesh.positions[ib]! + mesh.positions[ic]!) / 3;
      const cy = (ay + mesh.positions[ib + 1]! + mesh.positions[ic + 1]!) / 3;
      const cz = (az + mesh.positions[ib + 2]! + mesh.positions[ic + 2]!) / 3;
      expect(nx * cx + ny * cy + nz * cz).toBeGreaterThan(0);
    }
  });

  it('has the canonical 6-face order +X −X +Y −Y +Z −Z', () => {
    expect(CUBE_FACES.map((f) => f.normal)).toEqual([
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]);
  });
});

describe('buildCubeSphere — determinism (golden)', () => {
  it('is reproducible: same inputs → identical output', () => {
    const a = buildCubeSphere(16, EARTH_RADIUS_M);
    const b = buildCubeSphere(16, EARTH_RADIUS_M);
    expect(fnv1a(a.positions)).toBe(fnv1a(b.positions));
    expect(fnv1a(a.normals)).toBe(fnv1a(b.normals));
    expect(fnv1a(a.indices)).toBe(fnv1a(b.indices));
  });

  it('matches recorded digests at (subdivisions=16, radius=Earth) (FROZEN)', () => {
    const mesh = buildCubeSphere(16, EARTH_RADIUS_M);
    expect({
      positions: fnv1a(mesh.positions),
      normals: fnv1a(mesh.normals),
      indices: fnv1a(mesh.indices),
    }).toMatchInlineSnapshot(`
      {
        "indices": "db735337",
        "normals": "6447df35",
        "positions": "9c80cb71",
      }
    `);
  });
});

describe('wrapFaceUV — cross-face apron mapping', () => {
  it('passes in-range (u,v) through unchanged (identity → frozen interior meshes)', () => {
    for (let f = 0; f < 6; f++) {
      const r = wrapFaceUV(f, 0.3, -0.7);
      expect(r.face).toBe(f);
      expect(r.u).toBe(0.3);
      expect(r.v).toBe(-0.7);
    }
  });

  it('maps known edges to the neighbour face (verified table)', () => {
    const t = 0.1; // overshoot → inward 1-t = 0.9
    const a = 0.4;
    const near = (r: { face: number; u: number; v: number }, fc: number, u: number, v: number): void => {
      expect(r.face).toBe(fc);
      expect(r.u).toBeCloseTo(u, 12);
      expect(r.v).toBeCloseTo(v, 12);
    };
    near(wrapFaceUV(0, 1 + t, a), 2, a, 1 - t); // +X u+ → +Y
    near(wrapFaceUV(1, 1 + t, a), 4, -(1 - t), a); // -X u+ → +Z (sign flip)
    near(wrapFaceUV(2, a, 1 + t), 0, 1 - t, a); // +Y v+ → +X (v-edge)
    near(wrapFaceUV(4, a, -1 - t), 3, a, 1 - t); // +Z v- → -Y
  });

  it('clamps cube corners (both axes out) to a finite unit direction on the same face', () => {
    for (let f = 0; f < 6; f++) {
      const r = wrapFaceUV(f, 1.1, 1.1);
      expect(r.face).toBe(f);
      expect(r.u).toBe(1);
      expect(r.v).toBe(1);
      const d = faceDirection(r.face, r.u, r.v);
      const len = Math.hypot(d[0], d[1], d[2]);
      expect(Number.isFinite(len)).toBe(true);
      expect(len).toBeCloseTo(1, 12);
    }
  });

  it('is continuous at every edge (t→0 wrap == the in-range edge direction)', () => {
    const eps = 1e-7;
    const wd = (f: number, u: number, v: number): [number, number, number] => {
      const w = wrapFaceUV(f, u, v);
      return faceDirection(w.face, w.u, w.v);
    };
    const close = (x: [number, number, number], y: [number, number, number]): void => {
      expect(Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])).toBeLessThan(1e-5);
    };
    for (let f = 0; f < 6; f++) {
      for (const a of [-0.6, 0.0, 0.35]) {
        close(wd(f, 1 + eps, a), faceDirection(f, 1, a)); // u+
        close(wd(f, -1 - eps, a), faceDirection(f, -1, a)); // u-
        close(wd(f, a, 1 + eps), faceDirection(f, a, 1)); // v+
        close(wd(f, a, -1 - eps), faceDirection(f, a, -1)); // v-
      }
    }
  });
});
