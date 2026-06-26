import { describe, it, expect } from 'vitest';
import {
  childrenOf,
  nodeBounds,
  projectedSize,
  lodBoundRadius,
  selectCut,
  balanceCut,
  maxNeighborDelta,
  isPathPrefix,
  retainedShouldRemove,
  type CameraView,
  type SelectOpts,
  type QuadNode,
} from '../core/quadtree.ts';
import { chunkKey, uvRectFromPath } from '../core/chunk.ts';
import { wrapFaceUV } from '../core/cubesphere.ts';
import { EARTH_RADIUS_M } from '../core/constants.ts';

// Step 2 gate (slice spec §6): correct LOD selection, coarse far → fine near, far
// side culled. All verified headlessly; the seamless/no-cracks half is in-browser.

const R = EARTH_RADIUS_M;
const FOVY = (55 * Math.PI) / 180;
const VP = 1080;

const keyOf = (n: QuadNode): string => chunkKey({ face: n.face, path: n.path, lod: n.path.length });
const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: readonly number[], b: readonly number[]): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

describe('quadtree node math', () => {
  it('childrenOf appends quadrants 0..3 on the same face', () => {
    const kids = childrenOf({ face: 3, path: [1] });
    expect(kids.map((k) => k.path)).toEqual([[1, 0], [1, 1], [1, 2], [1, 3]]);
    expect(kids.every((k) => k.face === 3)).toBe(true);
  });

  it('nodeBounds center sits on the sphere and bounds shrink with depth', () => {
    const root = nodeBounds(0, [], R, 0);
    expect(Math.abs(Math.hypot(...root.center) - R)).toBeLessThan(1); // center at radius
    const deep = nodeBounds(0, [1, 1, 2, 0], R, 0);
    expect(deep.radius).toBeLessThan(root.radius); // finer node → smaller bounds
  });

  it('projectedSize grows as distance shrinks, and is Infinity inside the bounds', () => {
    expect(projectedSize(1000, 1e6, VP, FOVY)).toBeLessThan(projectedSize(1000, 1e5, VP, FOVY));
    expect(projectedSize(1000, 500, VP, FOVY)).toBe(Infinity);
  });

  it('lodBoundRadius shrinks ~half per level and matches selectCut/CDLOD usage', () => {
    const R = EARTH_RADIUS_M;
    // Deeper = smaller tangential bound; the parent (one level up) is ~2× the child, which
    // is what makes the CDLOD morph band [dChild, dParent] ≈ [d, 2d] (continuous across LODs).
    for (let d = 1; d <= 12; d++) {
      const child = lodBoundRadius(d, R);
      const parent = lodBoundRadius(d - 1, R);
      expect(child).toBeLessThan(parent);
      // ~2× per level away from the root; gentler near it (cube-face curvature → ~1.5× at d=1).
      expect(parent / child).toBeGreaterThan(1.4);
      expect(parent / child).toBeLessThan(2.3);
    }
    // Depth is clamped (no out-of-range table read) and scales linearly with radius.
    expect(lodBoundRadius(99, R)).toBeGreaterThan(0);
    expect(lodBoundRadius(5, 2 * R)).toBeCloseTo(2 * lodBoundRadius(5, R), 6);
  });
});

describe('isPathPrefix', () => {
  it('detects ancestor-or-equal paths', () => {
    expect(isPathPrefix([1], [1, 2, 3])).toBe(true);
    expect(isPathPrefix([], [0, 1])).toBe(true);
    expect(isPathPrefix([1, 2], [1, 3])).toBe(false);
    expect(isPathPrefix([1, 2, 3], [1, 2])).toBe(false); // longer can't be a prefix
  });
});

describe('retainedShouldRemove (deferred LOD removal)', () => {
  const n = (face: number, path: number[]): QuadNode => ({ face, path });
  const other = { node: n(1, [2]), live: true }; // unrelated leaf, must be ignored

  it('keeps a retained leaf until its merge ancestor is live', () => {
    const x = n(0, [0, 1, 2]);
    expect(retainedShouldRemove(x, [{ node: n(0, [0]), live: false }, other])).toBe(false);
    expect(retainedShouldRemove(x, [{ node: n(0, [0]), live: true }, other])).toBe(true);
  });

  it('keeps a retained leaf until all split children are live', () => {
    const x = n(0, [2]);
    const kids = (live: boolean[]): { node: QuadNode; live: boolean }[] =>
      [0, 1, 2, 3].map((q, i) => ({ node: n(0, [2, q]), live: live[i]! }));
    expect(retainedShouldRemove(x, [...kids([true, true, true, false]), other])).toBe(false);
    expect(retainedShouldRemove(x, [...kids([true, true, true, true]), other])).toBe(true);
  });

  it('removes a retained leaf whose region left the view entirely', () => {
    const x = n(0, [3]);
    expect(retainedShouldRemove(x, [{ node: n(0, [0]), live: true }, other])).toBe(true);
  });
});

describe('selectCut', () => {
  const opts: SelectOpts = { radius: R, heightMargin: 14_000 * 1.6, splitPx: 400, maxDepth: 12 };
  const surfaceDir = norm([0.2, 1, 0.15]);
  const lookDown: [number, number, number] = [-surfaceDir[0], -surfaceDir[1], -surfaceDir[2]];
  const near: CameraView = {
    position: [surfaceDir[0] * (R + 28_000), surfaceDir[1] * (R + 28_000), surfaceDir[2] * (R + 28_000)],
    viewportHeight: VP,
    fovY: FOVY,
    forward: lookDown,
    halfFov: 1.0,
  };
  const far: CameraView = {
    position: [surfaceDir[0] * R * 80, surfaceDir[1] * R * 80, surfaceDir[2] * R * 80],
    viewportHeight: VP,
    fovY: FOVY,
    forward: lookDown,
    halfFov: 1.0,
  };

  it('is deterministic', () => {
    const a = selectCut(near, opts).map(keyOf);
    const b = selectCut(near, opts).map(keyOf);
    expect(a).toEqual(b);
  });

  it('refines near the camera and stays coarse far away', () => {
    const nearCut = selectCut(near, opts);
    const farCut = selectCut(far, opts);
    expect(nearCut.length).toBeGreaterThan(farCut.length);
    const nearMaxDepth = Math.max(...nearCut.map((n) => n.path.length));
    const farMaxDepth = Math.max(...farCut.map((n) => n.path.length));
    expect(nearMaxDepth).toBeGreaterThan(farMaxDepth);
    expect(nearMaxDepth).toBeGreaterThanOrEqual(6); // genuinely fine underfoot
  });

  it('puts the deepest leaf under the camera', () => {
    const cut = selectCut(near, opts);
    const deepest = cut.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    const c = nodeBounds(deepest.face, deepest.path, R, 0).center;
    expect(dot(norm(c), surfaceDir)).toBeGreaterThan(0.9); // right under the camera
  });

  it('horizon-culls the far side (no leaf on the antipode)', () => {
    const cut = selectCut(near, opts);
    for (const n of cut) {
      const c = nodeBounds(n.face, n.path, R, 0).center;
      expect(dot(norm(c), surfaceDir)).toBeGreaterThan(-0.5);
    }
  });

  it('stays within the leaf cap and is non-empty', () => {
    const cut = selectCut(near, opts);
    expect(cut.length).toBeGreaterThan(6);
    expect(cut.length).toBeLessThanOrEqual(opts.maxLeaves ?? 4096);
  });

  it('always-resident base: baseDepth=0 unchanged; baseDepth>0 tiles the whole sphere', () => {
    const base = selectCut(near, opts);
    // baseDepth=0 ⇒ byte-identical to the plain cut (default/determinism guard).
    expect(selectCut(near, { ...opts, baseDepth: 0 }).map(keyOf)).toEqual(base.map(keyOf));
    const pinned = selectCut(near, { ...opts, baseDepth: 2 });
    // The far side is now COVERED (the plain cut horizon-culls it — see the test above), so a
    // region rotating/streaming in always has a real coarse parent to morph from (no pop).
    const hasFarSide = pinned.some((n) => {
      const c = nodeBounds(n.face, n.path, R, 0).center;
      return dot(norm(c), surfaceDir) < -0.5; // antipodal hemisphere
    });
    expect(hasFarSide).toBe(true);
    // The complete base tiling is present: every leaf is at least baseDepth deep, and all
    // 6·4² = 96 depth-2 cells are covered (resident base leaf on the far side OR refined near).
    expect(Math.min(...pinned.map((n) => n.path.length))).toBeGreaterThanOrEqual(2);
    const baseCells = new Set(pinned.map((n) => `${n.face}/${n.path.slice(0, 2).join('')}`));
    expect(baseCells.size).toBe(6 * 16);
    // The base doesn't suppress near-field refinement — the cut still goes deep under the camera.
    expect(Math.max(...pinned.map((n) => n.path.length))).toBeGreaterThanOrEqual(6);
    // Bounded: the pinned base adds only the far-side coverage, staying well under the cap.
    expect(pinned.length).toBeLessThanOrEqual(opts.maxLeaves ?? 4096);
  });

  it('speed-aware prefetch requests a finer/earlier cut; prefetchM=0 is unchanged', () => {
    const base = selectCut(near, opts);
    // prefetchM=0 ⇒ byte-identical to a plain screen-space-error cut (determinism guard:
    // the canonical generation core is untouched, and a stationary camera adds no leaves).
    expect(selectCut(near, { ...opts, prefetchM: 0 }).map(keyOf)).toEqual(base.map(keyOf));
    // A positive lead distance brings every level's split distance forward (split when
    // dist < dSplit + prefetchM), so more of the approach is refined early → never fewer
    // leaves, never coarser. This is what lets a fast descent's finer leaves stream in
    // before the camera reaches their CDLOD morph band (born at the parent surface, no pop).
    const pre = selectCut(near, { ...opts, prefetchM: 200_000 });
    expect(pre.length).toBeGreaterThan(base.length);
    const baseMaxDepth = Math.max(...base.map((n) => n.path.length));
    const preMaxDepth = Math.max(...pre.map((n) => n.path.length));
    expect(preMaxDepth).toBeGreaterThanOrEqual(baseMaxDepth);
  });
});

describe('balanceCut (2:1 restricted quadtree)', () => {
  const MAXD = 8;
  const bkey = (n: QuadNode): string => `${n.face}/${n.path.join('')}`;

  // Full-sphere depth-1 base: 6 faces × 4 quadrants = 24 leaves, perfectly balanced.
  const fullBase = (): QuadNode[] => {
    const out: QuadNode[] = [];
    for (let f = 0; f < 6; f++) for (let q = 0; q < 4; q++) out.push({ face: f, path: [q] });
    return out;
  };
  // Uniformly refine a node to `depth` (a balanced patch, but coarser/finer than its neighbours).
  const refineTo = (node: QuadNode, depth: number): QuadNode[] =>
    node.path.length >= depth ? [node] : childrenOf(node).flatMap((c) => refineTo(c, depth));

  // INDEPENDENT 2:1 check (denser than balanceCut's own probe, so a missed neighbour fails here):
  // probe each leaf edge at 15 points and report the largest |neighbourDepth − depth| across the cut.
  const coveringDepthT = (cut: Set<string>, face: number, u: number, v: number): number => {
    let u0 = -1, u1 = 1, v0 = -1, v1 = 1;
    const path: number[] = [];
    for (let d = 1; d <= MAXD; d++) {
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      let q = 0;
      if (u >= um) { q |= 1; u0 = um; } else u1 = um;
      if (v >= vm) { q |= 2; v0 = vm; } else v1 = vm;
      path.push(q);
      if (cut.has(`${face}/${path.join('')}`)) return d;
    }
    return -1;
  };
  const maxNbrDelta = (leaves: QuadNode[]): number => {
    const cut = new Set(leaves.map(bkey));
    let maxD = 0;
    for (const lf of leaves) {
      const r = uvRectFromPath(lf.path);
      const eps = (r.u1 - r.u0) * 0.02;
      const d = lf.path.length;
      for (let i = 1; i < 16; i++) {
        const t = i / 16;
        const v = r.v0 + (r.v1 - r.v0) * t;
        const u = r.u0 + (r.u1 - r.u0) * t;
        for (const [pu, pv] of [[r.u1 + eps, v], [r.u0 - eps, v], [u, r.v1 + eps], [u, r.v0 - eps]]) {
          const w = wrapFaceUV(lf.face, pu!, pv!);
          const nd = coveringDepthT(cut, w.face, w.u, w.v);
          if (nd >= 0) maxD = Math.max(maxD, Math.abs(nd - d));
        }
      }
    }
    return maxD;
  };

  it('is a no-op on an already-balanced uniform cut', () => {
    const base = fullBase();
    expect(maxNbrDelta(base)).toBeLessThanOrEqual(1);
    const balanced = balanceCut(base, MAXD);
    expect(balanced.length).toBe(base.length);
    expect(new Set(balanced.map(bkey))).toEqual(new Set(base.map(bkey)));
  });

  it('eliminates >1-level steps (2:1 balances an imbalanced cut)', () => {
    // A depth-4 patch dropped beside depth-1 neighbours = a 3-level step (the maxNbrΔ=4 the
    // ?lodaudit logs showed). Replace face-0 quadrant 0 with its depth-4 tiling; keep the rest at 1.
    const cut = fullBase().filter((l) => !(l.face === 0 && l.path[0] === 0));
    cut.push(...refineTo({ face: 0, path: [0] }, 4));
    expect(maxNbrDelta(cut)).toBeGreaterThan(1); // input is imbalanced

    const balanced = balanceCut(cut, MAXD);
    expect(maxNbrDelta(balanced)).toBeLessThanOrEqual(1); // output is 2:1 balanced → morphable
    expect(balanced.length).toBeGreaterThan(cut.length); // only ADDED transition leaves

    // The exported metric agrees with the independent dense checker: >1 before, ≤1 after. (This is
    // the ACCURATE fine-probe metric that replaced the render-side quarter-cell overshoot probe,
    // which falsely reported maxNbrΔ up to 4 on cuts that were in fact already edge-balanced.)
    expect(maxNeighborDelta(cut, MAXD)).toBeGreaterThan(1);
    expect(maxNeighborDelta(balanced, MAXD)).toBeLessThanOrEqual(1);
  });

  it('is deterministic and never coarsens (every input region stays at ≥ its depth)', () => {
    const cut = fullBase().filter((l) => !(l.face === 2 && l.path[0] === 1));
    cut.push(...refineTo({ face: 2, path: [1] }, 4));
    const a = balanceCut(cut, MAXD);
    const b = balanceCut(cut, MAXD);
    expect(new Set(a.map(bkey))).toEqual(new Set(b.map(bkey)));
    // Coverage preserved: at each input leaf's centre, the balanced cut covers it at ≥ its depth.
    const balSet = new Set(a.map(bkey));
    for (const lf of cut) {
      const r = uvRectFromPath(lf.path);
      const nd = coveringDepthT(balSet, lf.face, (r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2);
      expect(nd).toBeGreaterThanOrEqual(lf.path.length);
    }
  });
});
