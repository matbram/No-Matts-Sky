import { describe, it, expect } from 'vitest';
import { surfaceNets, type SampledField } from '../core/surfacenets.ts';
import { fnv1a } from './digest.ts';

// Standalone correctness for the Surface Nets mesher (master plan §3.3 / §5.4). The
// chunk tests exercise it through meshChunk on the cube-sphere field; this drives it
// directly on a KNOWN field (a sphere SDF fully inside the grid) so we can assert the
// properties the cube-sphere can't isolate: a CLOSED, MANIFOLD, watertight surface
// (every edge shared by exactly two triangles), outward winding, vertices on the
// surface, plus a frozen digest. This is the standalone guard the meshing core lacked.

const RADIUS = 1.3;
// Center is OFFSET off the lattice so no corner lands exactly on it (degenerate normal)
// and the surface samples asymmetrically.
const CX = 0.1, CY = 0.05, CZ = 0.07;
const N = 16; // cells per axis
const SPAN = 2; // grid spans [-SPAN, SPAN]; sphere (r=1.3) sits well inside (≈2.8 cells margin)
const CELL = (2 * SPAN) / N;

/** Sphere SDF on a regular (N+1)³ corner grid: D = r − |p − c| (D>0 inside → solid). */
function sphereField(): SampledField {
  const cnx = N + 1, cny = N + 1, cnz = N + 1;
  const cc = cnx * cny * cnz;
  const density = new Float64Array(cc);
  const cornerPos = new Float64Array(cc * 3);
  const cornerNormal = new Float64Array(cc * 3);
  for (let k = 0; k <= N; k++) {
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const p = i + cnx * (j + cny * k);
        const x = -SPAN + (2 * SPAN * i) / N;
        const y = -SPAN + (2 * SPAN * j) / N;
        const z = -SPAN + (2 * SPAN * k) / N;
        const ex = x - CX, ey = y - CY, ez = z - CZ;
        const r = Math.sqrt(ex * ex + ey * ey + ez * ez);
        density[p] = RADIUS - r; // D = r_surface − |p−c|
        cornerPos[p * 3] = x;
        cornerPos[p * 3 + 1] = y;
        cornerPos[p * 3 + 2] = z;
        // Outward normal = normalize(−∇D) = normalize(p−c). Epsilon guards |p−c|≈0.
        const inv = 1 / Math.sqrt(ex * ex + ey * ey + ez * ez + 1e-30);
        cornerNormal[p * 3] = ex * inv;
        cornerNormal[p * 3 + 1] = ey * inv;
        cornerNormal[p * 3 + 2] = ez * inv;
      }
    }
  }
  return { nx: N, ny: N, nz: N, density, cornerPos, cornerNormal };
}

describe('surfaceNets — sphere SDF (closed manifold)', () => {
  const mesh = surfaceNets(sphereField(), [0, 0, 0]);

  it('extracts a non-empty surface with well-formed buffers', () => {
    expect(mesh.vertexCount).toBeGreaterThan(0);
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
    expect(mesh.normals.length).toBe(mesh.vertexCount * 3);
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
    for (const i of mesh.indices) expect(i).toBeLessThan(mesh.vertexCount);
  });

  it('is watertight & manifold: every edge is shared by exactly two triangles', () => {
    // Surface Nets shares one vertex per cell BY INDEX already, so no welding is
    // needed — build the edge-use map straight from the index buffer. A closed
    // surface fully inside the grid has NO boundary edge (every edge used twice).
    const edgeUse = new Map<string, number>();
    const add = (a: number, b: number): void => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    };
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!, b = mesh.indices[t + 1]!, c = mesh.indices[t + 2]!;
      add(a, b);
      add(b, c);
      add(c, a);
    }
    let nonManifold = 0;
    for (const count of edgeUse.values()) if (count !== 2) nonManifold++;
    expect(nonManifold).toBe(0);
  });

  it('every triangle winds outward (geometric normal points away from the center)', () => {
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]! * 3, b = mesh.indices[t + 1]! * 3, c = mesh.indices[t + 2]! * 3;
      const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
      const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
      const gnx = e1y * e2z - e1z * e2y, gny = e1z * e2x - e1x * e2z, gnz = e1x * e2y - e1y * e2x;
      // Centroid relative to the sphere center.
      const cx = (p[a]! + p[b]! + p[c]!) / 3 - CX;
      const cy = (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3 - CY;
      const cz = (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3 - CZ;
      expect(gnx * cx + gny * cy + gnz * cz).toBeGreaterThan(0);
    }
  });

  it('every vertex sits on the sphere surface (within one cell of r)', () => {
    for (let v = 0; v < mesh.vertexCount; v++) {
      const dx = mesh.positions[v * 3]! - CX;
      const dy = mesh.positions[v * 3 + 1]! - CY;
      const dz = mesh.positions[v * 3 + 2]! - CZ;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      expect(Math.abs(r - RADIUS)).toBeLessThan(CELL); // dual vertex lies in its sign-changed cell
    }
  });

  it('vertex normals are unit length', () => {
    for (let v = 0; v < mesh.vertexCount; v++) {
      const len = Math.hypot(
        mesh.normals[v * 3]!,
        mesh.normals[v * 3 + 1]!,
        mesh.normals[v * 3 + 2]!,
      );
      expect(Math.abs(len - 1)).toBeLessThan(1e-6);
    }
  });

  it('is deterministic and matches a recorded digest (FROZEN)', () => {
    const again = surfaceNets(sphereField(), [0, 0, 0]);
    expect(fnv1a(mesh.positions)).toBe(fnv1a(again.positions));
    expect(fnv1a(mesh.indices)).toBe(fnv1a(again.indices));
    expect({
      positions: fnv1a(mesh.positions),
      normals: fnv1a(mesh.normals),
      indices: fnv1a(mesh.indices),
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
    }).toMatchInlineSnapshot(`
      {
        "indices": "f9db861d",
        "normals": "a7d5ba61",
        "positions": "74fc407f",
        "triangleCount": 1004,
        "vertexCount": 504,
      }
    `);
  });
});
