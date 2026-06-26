import { describe, it, expect } from 'vitest';
import {
  densityAt,
  terrainAt,
  assembleDensity,
  sliceTerrainRecipe,
  lodOctaves,
  surfaceAt,
  type TerrainRecipe,
} from '../core/density.ts';
import { meshChunk, uvRectFromPath, chunkKey, swapDelta, type ChunkRequest } from '../core/chunk.ts';
import { surfaceNets, type SampledField } from '../core/surfacenets.ts';
import { faceDirection } from '../core/cubesphere.ts';
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

describe('column-cache equivalence (the optimization is exact)', () => {
  it('per-column terrainAt + assembleDensity matches densityAt up to float roundoff', () => {
    const scale = RECIPE.noiseScale;
    const height = RECIPE.height;
    const _t = new Float64Array(4);
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    for (let s = 1; s <= 30; s++) {
      const th = (s * 2.399963) % (Math.PI * 2);
      const ph = Math.acos(1 - (2 * (s - 0.5)) / 30);
      const dx = Math.sin(ph) * Math.cos(th);
      const dy = Math.sin(ph) * Math.sin(th);
      const dz = Math.cos(ph);
      const r = R + ((s % 9) - 4) * 2000;
      // Canonical per-point path:
      densityAt(RECIPE, R, dx * r, dy * r, dz * r, a);
      // Column-cache path (one terrainAt per direction, cheap assemble per radius):
      terrainAt(RECIPE, dx * scale, dy * scale, dz * scale, _t);
      assembleDensity(R, r, dx, dy, dz, _t[0]!, _t[1]!, _t[2]!, _t[3]!, height, scale, b);
      expect(Math.abs(a[0]! - b[0]!)).toBeLessThan(1e-2); // D within ~cm
      expect(Math.abs(a[1]! - b[1]!)).toBeLessThan(1e-5); // gradient components
      expect(Math.abs(a[2]! - b[2]!)).toBeLessThan(1e-5);
      expect(Math.abs(a[3]! - b[3]!)).toBeLessThan(1e-5);
    }
  });
});

describe('uvRectFromPath', () => {
  it('halves the face per quadrant', () => {
    expect(uvRectFromPath([])).toEqual({ u0: -1, u1: 1, v0: -1, v1: 1 });
    expect(uvRectFromPath([3])).toEqual({ u0: 0, u1: 1, v0: 0, v1: 1 }); // +u,+v
    expect(uvRectFromPath([0])).toEqual({ u0: -1, u1: 0, v0: -1, v1: 0 }); // -u,-v
  });
});

describe('chunk apron (seamless same-LOD neighbors)', () => {
  it('adjacent same-LOD leaves sample the shared edge at coincident points', () => {
    // Leaf [0] (u[-1,0]) and leaf [1] (u[0,1]) share the u=0 edge over v[-1,0].
    // With the 1-cell apron, [0]'s edge column and [1]'s edge column must land on
    // the same sphere directions — otherwise their surfaces gap.
    const face = 2;
    const tan = 8;
    const A = uvRectFromPath([0]);
    const B = uvRectFromPath([1]);
    const duA = (A.u1 - A.u0) / tan, dvA = (A.v1 - A.v0) / tan;
    const duB = (B.u1 - B.u0) / tan, dvB = (B.v1 - B.v0) / tan;
    const u0A = A.u0 - duA, v0A = A.v0 - dvA;
    const u0B = B.u0 - duB, v0B = B.v0 - dvB;
    for (let j = 0; j <= tan + 2; j++) {
      const a = faceDirection(face, u0A + duA * (tan + 1), v0A + dvA * j); // [0] edge col
      const b = faceDirection(face, u0B + duB * 1, v0B + dvB * j); // [1] edge col
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-9);
    }
  });
});

describe('cross-LOD apron gap (the crack adaptive octaves reopened)', () => {
  // Same-LOD neighbours coincide at a shared edge (the apron test above). But a leaf
  // and its COARSER neighbour now sample that edge with DIFFERENT octave counts
  // (lodOctaves grows one octave per level), so their surfaces land at DIFFERENT
  // radii there — the crack that exposes the inset backdrop at grazing walk angles.
  // This pins the magnitude (≈ the dropped octave's amplitude) and proves a skirt
  // sized to it covers the gap. Mirrors the regime fixed by shallow conditioned skirts.
  const scale = RECIPE.noiseScale;
  // Local mirror of the manager's skirt safety factor (render-side; not importable
  // here without pulling in three.js). Kept in sync with quadtreeManager SKIRT_SAFETY.
  const SKIRT_SAFETY = 4;

  it('different LODs place the shared edge at different radii, and a skirt covers it', () => {
    const coarseLod = 1;
    const fineLod = 2;
    const octC = lodOctaves(RECIPE, coarseLod); // 5
    const octF = lodOctaves(RECIPE, fineLod); // 6
    expect(octF).toBe(octC + 1); // adjacent levels differ by exactly one octave

    // Sample the shared u=0 edge of face 2 over the finer leaf's overlap v∈[-1,-0.5];
    // measure the radial gap between the coarse (octC) and fine (octF) surfaces.
    const tC = new Float64Array(4);
    const tF = new Float64Array(4);
    let maxGap = 0;
    for (let s = 0; s <= 32; s++) {
      const v = -1 + (0.5 * s) / 32;
      const d = faceDirection(2, 0, v);
      terrainAt(RECIPE, d[0] * scale, d[1] * scale, d[2] * scale, tC, undefined, octC);
      terrainAt(RECIPE, d[0] * scale, d[1] * scale, d[2] * scale, tF, undefined, octF);
      maxGap = Math.max(maxGap, Math.abs(RECIPE.height * (tF[0]! - tC[0]!)));
    }

    // The bug: the surfaces are metres apart at the shared edge — NOT coincident like
    // same-LOD neighbours (which agree to < 1e-9 in direction → sub-mm at Earth scale).
    expect(maxGap).toBeGreaterThan(1);
    // …but bounded by the dropped octave's amplitude → it IS the octave mismatch, not
    // a structural hole. (height·gain^(octC-1) is a generous per-octave upper bound.)
    expect(maxGap).toBeLessThan(RECIPE.height * RECIPE.gain ** (octC - 1) * 2);

    // The skirt the manager hangs on the (finer) leaf is the SMALLER of the two sides'
    // curtains; even it exceeds the gap, so the crack is bridged from at least one side.
    const skirtFine = SKIRT_SAFETY * RECIPE.height * RECIPE.gain ** (octF - 1);
    expect(skirtFine).toBeGreaterThan(maxGap);
  });

  it('the gap shrinks geometrically with depth (deepest leaves are crack-free)', () => {
    // Each level deeper halves the finest-octave amplitude (gain 0.5), so the gap is
    // largest at coarse transitions and negligible near the player; lod 11–15 clamp to
    // OCT_MAX and share an octave count → zero gap (mutually watertight, no skirts).
    const gapAt = (coarseLod: number): number => {
      const octC = lodOctaves(RECIPE, coarseLod);
      const octF = lodOctaves(RECIPE, coarseLod + 1);
      const tC = new Float64Array(4);
      const tF = new Float64Array(4);
      let g = 0;
      for (let s = 0; s <= 16; s++) {
        const v = -1 + (0.5 * s) / 16;
        const d = faceDirection(2, 0, v);
        terrainAt(RECIPE, d[0] * scale, d[1] * scale, d[2] * scale, tC, undefined, octC);
        terrainAt(RECIPE, d[0] * scale, d[1] * scale, d[2] * scale, tF, undefined, octF);
        g = Math.max(g, Math.abs(RECIPE.height * (tF[0]! - tC[0]!)));
      }
      return g;
    };
    expect(gapAt(2)).toBeLessThan(gapAt(1)); // deeper → smaller crack
    // At/above OCT_MAX both leaves share the same octave count → no surface mismatch.
    expect(gapAt(14)).toBe(0); // lodOctaves(14)==lodOctaves(15)==OCT_MAX
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
    // positions/normals/indices/counts stay UNCHANGED — the parent-grid morph fix touches ONLY the
    // morph target (the base surface is untouched). morphTargetNormals is RE-BLESSED (the morph normal
    // is now the parent-GRID bilinear, not the child-grid analytic) — this digest is the regression
    // guard that the mesher still bakes the parent-grid morph normal.
    expect({
      positions: fnv1a(m.positions),
      normals: fnv1a(m.normals),
      morphTargetNormals: fnv1a(m.morphTargetNormals),
      indices: fnv1a(m.indices),
      vertexCount: m.vertexCount,
      triangleCount: m.triangleCount,
    }).toMatchInlineSnapshot(`
      {
        "indices": "506acfe2",
        "morphTargetNormals": "4757522c",
        "normals": "00144975",
        "positions": "4b7b7717",
        "triangleCount": 1258,
        "vertexCount": 618,
      }
    `);
  });

  it('skirts add boundary geometry and stay deterministic', () => {
    const bare = meshChunk(req, RECIPE, R, 16, 10, 0);
    const skirted = meshChunk(req, RECIPE, R, 16, 10, 5000);
    // Skirts add vertices + triangles around the patch boundary.
    expect(skirted.vertexCount).toBeGreaterThan(bare.vertexCount);
    expect(skirted.triangleCount).toBeGreaterThan(bare.triangleCount);
    // Determinism holds with skirts on.
    const again = meshChunk(req, RECIPE, R, 16, 10, 5000);
    expect(fnv1a(skirted.positions)).toBe(fnv1a(again.positions));
    expect(fnv1a(skirted.indices)).toBe(fnv1a(again.indices));
    // Normals (including reused skirt normals) stay unit length.
    for (let v = 0; v < skirted.vertexCount; v++) {
      const nx = skirted.normals[v * 3]!;
      const ny = skirted.normals[v * 3 + 1]!;
      const nz = skirted.normals[v * 3 + 2]!;
      expect(Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1)).toBeLessThan(1e-4);
    }
  });

  it('skirts hang radially inward (lower the mesh min radius)', () => {
    const minRadius = (m: { positions: Float32Array; vertexCount: number; origin: number[] }): number => {
      let r = Infinity;
      for (let v = 0; v < m.vertexCount; v++) {
        const wx = m.positions[v * 3]! + m.origin[0]!;
        const wy = m.positions[v * 3 + 1]! + m.origin[1]!;
        const wz = m.positions[v * 3 + 2]! + m.origin[2]!;
        r = Math.min(r, Math.hypot(wx, wy, wz));
      }
      return r;
    };
    // skirtDepth > 2·height guarantees the lowest skirt drops below any surface vertex.
    const bare = meshChunk(req, RECIPE, R, 16, 10, 0);
    const skirted = meshChunk(req, RECIPE, R, 16, 10, RECIPE.height * 3);
    expect(minRadius(skirted)).toBeLessThan(minRadius(bare));
  });
});

describe('terrainAt low-octave morph value (geomorph source)', () => {
  it('is a pure function of direction, smoother than the full value, and side-effect free', () => {
    const s = RECIPE.noiseScale;
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    const lo1 = new Float64Array(1);
    const lo2 = new Float64Array(1);
    // Same direction twice → identical low value (so neighbours agree exactly at a
    // shared edge → the geomorph opens no seam mid-transition).
    terrainAt(RECIPE, 0.3 * s, 0.5 * s, 0.81 * s, a, lo1);
    terrainAt(RECIPE, 0.3 * s, 0.5 * s, 0.81 * s, b, lo2);
    expect(lo1[0]).toBe(lo2[0]);
    // The morph value drops the finest octave, so it differs from the full value.
    expect(lo1[0]).not.toBe(a[0]);
    // Requesting the low value must NOT perturb the full value/gradient (frozen path).
    const c = new Float64Array(4);
    terrainAt(RECIPE, 0.3 * s, 0.5 * s, 0.81 * s, c);
    expect(c[0]).toBe(a[0]);
    expect(c[1]).toBe(a[1]);
    expect(c[2]).toBe(a[2]);
    expect(c[3]).toBe(a[3]);
  });
});

describe('meshChunk morph targets (LOD geomorph)', () => {
  const req: ChunkRequest = { face: 2, path: [2, 1], lod: 2 };

  it('emits one morph target per vertex, deterministically', () => {
    const a = meshChunk(req, RECIPE, R, 16, 10);
    const b = meshChunk(req, RECIPE, R, 16, 10);
    expect(a.morphTargets.length).toBe(a.vertexCount * 3);
    expect(fnv1a(a.morphTargets)).toBe(fnv1a(b.morphTargets));
  });

  it('matches a recorded digest (FROZEN)', () => {
    const m = meshChunk(req, RECIPE, R, 16, 10);
    // RE-BLESSED for the parent-grid morph fix: the morph target is now the parent LEAF's grid surface
    // (so morph=1 is a true no-op swap), not the coarser field on this leaf's finer grid.
    expect(fnv1a(m.morphTargets)).toMatchInlineSnapshot(`"4a61ebd8"`);
  });

  it('emits one UNIT morph-target NORMAL per vertex (geomorph shading source)', () => {
    const a = meshChunk(req, RECIPE, R, 16, 10);
    const b = meshChunk(req, RECIPE, R, 16, 10);
    expect(a.morphTargetNormals.length).toBe(a.vertexCount * 3);
    expect(fnv1a(a.morphTargetNormals)).toBe(fnv1a(b.morphTargetNormals)); // deterministic
    // Every parent-surface normal is unit length (the shader mixes + re-normalizes, but a
    // degenerate/zero normal here would still wash out shading) — the basic correctness gate.
    for (let v = 0; v < a.vertexCount; v++) {
      const len = Math.hypot(
        a.morphTargetNormals[v * 3]!,
        a.morphTargetNormals[v * 3 + 1]!,
        a.morphTargetNormals[v * 3 + 2]!,
      );
      expect(len).toBeGreaterThan(0.999);
      expect(len).toBeLessThan(1.001);
    }
  });

  it('parent normals point outward (same hemisphere as the fine normals)', () => {
    // The parent surface is a smoothed version of the fine surface, so its normals should
    // broadly agree (outward) with the fine analytic normals — a sign error would invert
    // shading across the morph zone. Average dot over all vertices must be strongly positive.
    const m = meshChunk(req, RECIPE, R, 16, 10);
    let dotSum = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      dotSum +=
        m.normals[v * 3]! * m.morphTargetNormals[v * 3]! +
        m.normals[v * 3 + 1]! * m.morphTargetNormals[v * 3 + 1]! +
        m.normals[v * 3 + 2]! * m.morphTargetNormals[v * 3 + 2]!;
    }
    expect(dotSum / m.vertexCount).toBeGreaterThan(0.9);
  });

  it('morph normal tracks the coarser (parent) surface, not the fine normal', () => {
    // morphTargetNormals comes from normalize(−∇D) of the one-octave-coarser field, now sampled on the
    // PARENT grid and bilinearly interpolated to each vertex (so a fully-morphed leaf shades like its
    // parent LEAF). It therefore tracks the coarser surface — but as a parent-grid BILINEAR, it's a
    // smoothed version of the per-point analytic coarser normal (so the dot is high, not ~1). The
    // decisive invariant: it matches the coarser normal MUCH better than the fine (base) normal does.
    const m = meshChunk(req, RECIPE, R, 16, 10);
    const morphOct = lodOctaves(RECIPE, req.lod) - 1; // mesher drops the finest octave for the target
    const s = new Float64Array(7);
    let dotMorph = 0;
    for (let v = 0; v < m.vertexCount; v++) {
      const wx = m.positions[v * 3]! + m.origin[0]!;
      const wy = m.positions[v * 3 + 1]! + m.origin[1]!;
      const wz = m.positions[v * 3 + 2]! + m.origin[2]!;
      surfaceAt(RECIPE, R, wx, wy, wz, s, morphOct); // analytic coarser normal in s[1..3]
      dotMorph +=
        m.morphTargetNormals[v * 3]! * s[1]! +
        m.morphTargetNormals[v * 3 + 1]! * s[2]! +
        m.morphTargetNormals[v * 3 + 2]! * s[3]!;
    }
    const n = m.vertexCount;
    // The morph normal broadly tracks the coarser surface (it's the parent-grid bilinear of the coarser
    // analytic normal — a smoothed version, so the dot is high but not ~1)…
    expect(dotMorph / n).toBeGreaterThan(0.9);
    // …and it is genuinely the coarser/parent normal, not a copy of the fine (base) normal — so the
    // geomorph actually changes shading across the morph. (The FROZEN morphTargetNormals digest above
    // pins the exact parent-grid values; this just asserts the two normal sets are distinct.)
    expect(fnv1a(m.morphTargetNormals)).not.toBe(fnv1a(m.normals));
  });

  it('differs from the base surface (the morph is actually active)', () => {
    const m = meshChunk(req, RECIPE, R, 16, 10);
    expect(fnv1a(m.morphTargets)).not.toBe(fnv1a(m.positions));
  });

  it('is smoother than the base surface (morph drops only a fine-detail layer)', () => {
    // The morph target is the base surface with its FINEST octave removed. With
    // LOD-adaptive octaves the dropped octave is small relative to the leaf's macro
    // relief, so comparing TOTAL radius variance is too noisy to be reliable (the
    // identical low-frequency features swamp the signal). Instead measure the thing
    // the morph actually changes — the per-vertex radial detail it removes — and
    // confirm it's a genuine but SUB-dominant layer: nonzero (morph active) yet
    // smaller than the morph surface's own variation (so the morph is the smoother,
    // coarser base, not a rougher one). Robust at any octave count.
    const m = meshChunk(req, RECIPE, R, 16, 10);
    const n = m.vertexCount;
    const radiusOf = (buf: Float32Array, v: number): number =>
      Math.hypot(
        buf[v * 3]! + m.origin[0]!,
        buf[v * 3 + 1]! + m.origin[1]!,
        buf[v * 3 + 2]! + m.origin[2]!,
      );
    const morphR = new Float64Array(n);
    let morphMean = 0;
    for (let v = 0; v < n; v++) {
      morphR[v] = radiusOf(m.morphTargets, v);
      morphMean += morphR[v]!;
    }
    morphMean /= n;
    let removedSq = 0; // RMS² of the finest-octave detail the morph removes
    let morphVarSum = 0; // variance of the morph surface itself
    for (let v = 0; v < n; v++) {
      const removed = radiusOf(m.positions, v) - morphR[v]!; // base − morph at this vertex
      removedSq += removed * removed;
      const md = morphR[v]! - morphMean;
      morphVarSum += md * md;
    }
    const removedRms = Math.sqrt(removedSq / n);
    const morphStd = Math.sqrt(morphVarSum / n);
    expect(removedRms).toBeGreaterThan(0); // the geomorph is active
    expect(removedRms).toBeLessThan(morphStd); // it's a detail on top of a smoother base
  });

  it('is the identity (morphTargets == positions) when the field carries no cornerMorphPos', () => {
    // Tiny planar field with a z sign-change so Surface Nets emits vertices.
    const nx = 2, ny = 2, nz = 2;
    const cnx = nx + 1, cny = ny + 1, cnz = nz + 1;
    const cc = cnx * cny * cnz;
    const density = new Float64Array(cc);
    const cornerPos = new Float64Array(cc * 3);
    const cornerNormal = new Float64Array(cc * 3);
    for (let k = 0; k < cnz; k++)
      for (let j = 0; j < cny; j++)
        for (let i = 0; i < cnx; i++) {
          const p = i + cnx * (j + cny * k);
          cornerPos[p * 3] = i;
          cornerPos[p * 3 + 1] = j;
          cornerPos[p * 3 + 2] = k;
          cornerNormal[p * 3 + 2] = 1; // +z
          density[p] = 1 - k; // solid at k=0, air at k=2
        }
    const field: SampledField = { nx, ny, nz, density, cornerPos, cornerNormal };
    const m = surfaceNets(field, [0, 0, 0]);
    expect(m.vertexCount).toBeGreaterThan(0);
    expect(fnv1a(m.morphTargets)).toBe(fnv1a(m.positions));
    // An identical cornerMorphPos copy is still the identity.
    field.cornerMorphPos = cornerPos.slice();
    const m2 = surfaceNets(field, [0, 0, 0]);
    expect(fnv1a(m2.morphTargets)).toBe(fnv1a(m2.positions));
  });
});

describe('swapDelta (residual morph=1 vs parent leaf — diagnostic)', () => {
  // With the parent-grid morph fix, a child born at morph=1 reproduces the parent leaf's GRID surface,
  // so the dominant ~17° grid-discretization pop is gone. swapDelta now measures the only residual the
  // grid alignment can't remove: the field-level difference between the mesher's morph-target source
  // (the oct-normalized one-octave-coarser `_tLo`) and the actual parent leaf's base field. Because
  // `_tLo` shares the child's larger amplitude denominator, that is a smooth ~1.6% scaling of the
  // parent value → a tiny radial offset + ≲ a couple degrees of normal tilt. SMALL ⇒ morph=1 ≈ parent
  // (pop-free swap). This is the EQUIVALENCE check that the fix landed.
  const child: ChunkRequest = { face: 2, path: [2, 1], lod: 2 };

  it('is deterministic: same request → identical deltas', () => {
    expect(swapDelta(child, RECIPE, R)).toEqual(swapDelta(child, RECIPE, R));
  });

  it('the morph target reproduces the parent leaf (residual is small)', () => {
    const d = swapDelta(child, RECIPE, R, 4);
    expect(d.samples).toBe(16); // perAxis² = 4×4
    expect(d.dPosAvg).toBeLessThanOrEqual(d.dPosMax);
    expect(d.dNrmAvgDeg).toBeLessThanOrEqual(d.dNrmMaxDeg);
    // The decisive assertion: the swap is now effectively pop-free — only the pre-existing `_tLo`
    // normalization residual remains (a smooth ~1.6% radial scaling), NOT the ~17°/~km grid pop the
    // child-grid morph target showed. (Before the fix this read dNrm≈32°, dPos≈7 km here.)
    expect(d.dNrmMaxDeg).toBeLessThan(5);
    expect(d.dPosMax).toBeLessThan(RECIPE.height * 0.05); // ≲ 700 m vs the old ~7 km
    expect(d.dPosMax).toBeGreaterThan(0); // the residual is real (nonzero), just tiny
  });

  it('is the zero delta at the root (no parent to swap from)', () => {
    const root: ChunkRequest = { face: 0, path: [], lod: 0 };
    expect(swapDelta(root, RECIPE, R)).toEqual({
      dPosMax: 0,
      dPosAvg: 0,
      dNrmMaxDeg: 0,
      dNrmAvgDeg: 0,
      samples: 0,
    });
  });

  it('matches recorded deltas (FROZEN) — re-bless only on a deliberate change', () => {
    // Rounded so the snapshot is readable and robust to last-ULP float drift; the
    // determinism test above pins the exact (unrounded) reproducibility.
    const d = swapDelta(child, RECIPE, R, 4);
    const r2 = (x: number): number => Math.round(x * 100) / 100;
    expect({
      dPosMax: r2(d.dPosMax),
      dPosAvg: r2(d.dPosAvg),
      dNrmMaxDeg: r2(d.dNrmMaxDeg),
      dNrmAvgDeg: r2(d.dNrmAvgDeg),
      samples: d.samples,
    }).toMatchInlineSnapshot(`
      {
        "dNrmAvgDeg": 0.2,
        "dNrmMaxDeg": 0.35,
        "dPosAvg": 23.07,
        "dPosMax": 56.98,
        "samples": 16,
      }
    `);
  });
});

describe('cross-face apron (watertight cube-face edges)', () => {
  // Leaf A on +X (path [1]: u∈[0,1], v∈[-1,0]) and leaf B on +Y (path [2]: u∈[-1,0],
  // v∈[0,1]) share the +X/+Y cube edge over z∈[-1,0]. Without cross-face wrapping
  // their surfaces are kilometres apart; the wrap makes A's apron sample B's first
  // interior row, so the boundary vertices coincide like same-LOD within-face leaves.
  const A: ChunkRequest = { face: 0, path: [1], lod: 1 };
  const B: ChunkRequest = { face: 2, path: [2], lod: 1 };
  const world = (m: ReturnType<typeof meshChunk>): number[][] => {
    const out: number[][] = [];
    for (let i = 0; i < m.vertexCount; i++)
      out.push([
        m.positions[i * 3]! + m.origin[0],
        m.positions[i * 3 + 1]! + m.origin[1],
        m.positions[i * 3 + 2]! + m.origin[2],
      ]);
    return out;
  };
  // For each A vertex, distance to the nearest B vertex.
  const nearest = (av: number[][], bv: number[][]): { coincident: number; minGap: number } => {
    let coincident = 0;
    let minGap = Infinity;
    for (const a of av) {
      let best = Infinity;
      for (const b of bv) {
        const d = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
        if (d < best) best = d;
      }
      if (best < 1) coincident++;
      if (best < minGap) minGap = best;
    }
    return { coincident, minGap };
  };

  it('adjacent leaves on different cube faces share coincident boundary vertices', () => {
    const a = world(meshChunk(A, RECIPE, R, 16, 10, 0));
    const b = world(meshChunk(B, RECIPE, R, 16, 10, 0));
    const { coincident, minGap } = nearest(a, b);
    // Was kilometres + zero coincident before the wrap; now a shared overlap row.
    expect(minGap).toBeLessThan(1); // metres, not kilometres
    expect(coincident).toBeGreaterThan(0);
  });

  it('is deterministic across runs', () => {
    const a1 = meshChunk(A, RECIPE, R, 16, 10, 0);
    const a2 = meshChunk(A, RECIPE, R, 16, 10, 0);
    expect(fnv1a(a1.positions)).toBe(fnv1a(a2.positions));
  });
});
