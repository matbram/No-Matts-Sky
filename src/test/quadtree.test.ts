import { describe, it, expect } from 'vitest';
import {
  childrenOf,
  nodeBounds,
  projectedSize,
  lodBoundRadius,
  selectCut,
  balanceCut,
  maxNeighborDelta,
  clampCutToReachableFrontier,
  completeCoverage,
  isPathPrefix,
  retainedShouldRemove,
  packRegion,
  unpackPath,
  type CameraView,
  type SelectOpts,
  type QuadNode,
} from '../core/quadtree.ts';
import { chunkKey, uvRectFromPath } from '../core/chunk.ts';
import { wrapFaceUV } from '../core/cubesphere.ts';
import { EARTH_RADIUS_M } from '../core/constants.ts';
import { fnv1a } from './digest.ts';

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

describe('clampCutToReachableFrontier (gated incremental refinement)', () => {
  const BASE = 2;
  const n = (face: number, path: number[]): QuadNode => ({ face, path });
  const depthOf = (cut: QuadNode[], face: number, path: number[]): number => {
    // depth at which `cut` covers the region (face,path): the clamped leaf is an ancestor-or-equal of it.
    for (const lf of cut) if (lf.face === face && isPathPrefix(lf.path, path)) return lf.path.length;
    return -1;
  };

  it('cold start (no live coverage) requests only the base depth', () => {
    const target = n(0, [0, 0, 0, 0, 0, 0]); // depth 6
    const out = clampCutToReachableFrontier([target], [], BASE);
    expect(out).toEqual([n(0, [0, 0])]); // clamped to baseDepth, nothing deeper
  });

  it('refines exactly one level past the deepest live ancestor', () => {
    const target = n(0, [0, 0, 0, 0, 0, 0]); // wants depth 6
    // Live coverage is the depth-2 base leaf only → admit depth 3, never the deep target.
    let out = clampCutToReachableFrontier([target], [n(0, [0, 0])], BASE);
    expect(out).toEqual([n(0, [0, 0, 0])]);
    // Once depth 3 is live, the next generation admits depth 4 — the front advances one level.
    out = clampCutToReachableFrontier([target], [n(0, [0, 0, 0])], BASE);
    expect(out).toEqual([n(0, [0, 0, 0, 0])]);
  });

  it('does NOT coarsen on merge-up: a region holding finer live detail keeps the target depth', () => {
    // Camera pulling back: wants depth 4, but the 4 depth-5 children are live (and the coarse ancestors
    // have been purged near the camera). The clamp must request depth 4 directly — gating here would
    // collapse to the base and re-climb (a zoom-out flicker). Retention/morph make the merge smooth.
    const target = n(0, [0, 0, 0, 0]); // depth 4
    const liveChildren = [0, 1, 2, 3].map((q) => n(0, [0, 0, 0, 0, q])); // depth-5 detail, no live ancestor
    const out = clampCutToReachableFrontier([target], liveChildren, BASE);
    expect(out).toEqual([n(0, [0, 0, 0, 0])]); // target depth preserved, NOT forced to baseDepth
  });

  it('is idempotent once the target itself is live (the settled state)', () => {
    const target = n(0, [0, 0, 0]);
    const out = clampCutToReachableFrontier([target], [n(0, [0, 0, 0])], BASE);
    expect(out).toEqual([target]);
  });

  it('de-duplicates many deep targets that collapse onto a shared shallow ancestor', () => {
    // Four depth-5 targets sharing the prefix [0,0,0]; only the depth-2 base is live, so each clamps to
    // its deepest-live-ancestor (depth 2) + 1 = depth 3 = [0,0,0]. All four collapse to one leaf.
    const deepTargets = [0, 1, 2, 3].map((q) => n(0, [0, 0, 0, q, 0])); // depth-5, common prefix [0,0,0]
    const out = clampCutToReachableFrontier(deepTargets, [n(0, [0, 0])], BASE);
    expect(out).toEqual([n(0, [0, 0, 0])]); // one deduped depth-3 leaf, not four
  });

  it('is deterministic (same inputs → identical output)', () => {
    const targets = [n(0, [0, 0, 0, 0]), n(1, [1, 1, 1]), n(3, [2, 0, 1, 3, 2])];
    const live = [n(0, [0, 0]), n(1, [1]), n(3, [2, 0, 1])];
    const a = clampCutToReachableFrontier(targets, live, BASE);
    const b = clampCutToReachableFrontier(targets, live, BASE);
    expect(a).toEqual(b);
  });

  it('every output is in [baseDepth, liveAncestorDepth+1] and never deeper than its target', () => {
    const targets: QuadNode[] = [];
    for (let f = 0; f < 6; f++)
      for (let q = 0; q < 4; q++) targets.push(...refineToDepth(n(f, [q]), 7));
    const live = [n(0, [0, 0]), n(0, [0, 1]), n(2, [3, 1, 0])]; // mixed live depths
    const out = clampCutToReachableFrontier(targets, live, BASE);
    for (const o of out) {
      expect(o.path.length).toBeGreaterThanOrEqual(BASE); // base floor honored
      expect(o.path.length).toBeLessThanOrEqual(7); // never deeper than the target
    }
    // The refined live regions advance exactly one level; the rest sit at the base floor.
    expect(depthOf(out, 0, [0, 0, 0])).toBe(3); // live depth-2 → admit depth 3
    expect(depthOf(out, 2, [3, 1, 0, 0])).toBe(4); // live depth-3 → admit depth 4
    expect(depthOf(out, 5, [0, 0])).toBe(BASE); // cold region → base floor
  });

  it('keeps the clamped cut 2:1-balanced (morphable) when live coverage is balanced', () => {
    // Backs the "clamp AFTER balanceCut" trap: clamping a uniform-deep target against a BALANCED live set
    // adds at most one level per region, so adjacent regions stay ≤1 level apart → the morph still hides
    // every seam. Build a balanced live set, request everything deep, clamp, and re-check the delta.
    const MAXD = 9;
    const bkey = (q: QuadNode): string => `${q.face}/${q.path.join('')}`;
    const imbalanced: QuadNode[] = [];
    for (let f = 0; f < 6; f++) for (let q = 0; q < 4; q++) imbalanced.push(n(f, [q]));
    imbalanced.splice(imbalanced.findIndex((l) => l.face === 0 && l.path[0] === 0), 1);
    imbalanced.push(...refineToDepth(n(0, [0]), 4)); // one deep patch
    const live = balanceCut(imbalanced, MAXD); // guaranteed ≤1-balanced
    expect(maxNeighborDelta(live, MAXD)).toBeLessThanOrEqual(1);

    const targets: QuadNode[] = [];
    for (let f = 0; f < 6; f++) for (let q = 0; q < 4; q++) targets.push(...refineToDepth(n(f, [q]), 7));
    const clamped = clampCutToReachableFrontier(targets, live, BASE);
    expect(new Set(clamped.map(bkey)).size).toBe(clamped.length); // a proper (deduped) cut
    expect(maxNeighborDelta(clamped, MAXD)).toBeLessThanOrEqual(1); // still morphable
  });
});

/** Uniformly refine a node down to `depth` (test helper, mirrors balanceCut's local refineTo). */
function refineToDepth(node: QuadNode, depth: number): QuadNode[] {
  return node.path.length >= depth ? [node] : childrenOf(node).flatMap((c) => refineToDepth(c, depth));
}

describe('completeCoverage (cull-edge coverage hole fix)', () => {
  const BASE = 2;
  const MAXD = 12;
  const n = (face: number, path: number[]): QuadNode => ({ face, path });
  const skey = (q: QuadNode): string => `${q.face}/${q.path.join('')}`;

  // Covering depth of surface dir (face,u,v) in a leaf set: walk root→down, return the first prefix
  // present (the cut is a partition, so that's THE covering leaf), or -1 if uncovered. Mirrors the
  // balanceCut block's coveringDepthT — but standalone so it's in scope here.
  const coverDepth = (set: Set<string>, face: number, u: number, v: number): number => {
    let u0 = -1, u1 = 1, v0 = -1, v1 = 1;
    const path: number[] = [];
    for (let d = 1; d <= MAXD; d++) {
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      let q = 0;
      if (u >= um) { q |= 1; u0 = um; } else u1 = um;
      if (v >= vm) { q |= 2; v0 = vm; } else v1 = vm;
      path.push(q);
      if (set.has(`${face}/${path.join('')}`)) return d;
    }
    return -1;
  };
  // A base cell [face, [a,b]] is a clean PARTITION of the cut iff every sampled (u,v) inside it is
  // covered at depth ≥ BASE (no gap) AND no two leaves in the cell are prefix-related (no overlap).
  const cellIsPartition = (cut: QuadNode[], face: number, base: number[]): boolean => {
    const set = new Set(cut.map(skey));
    const r = uvRectFromPath(base);
    for (let i = 1; i < 8; i++) {
      for (let j = 1; j < 8; j++) {
        const u = r.u0 + ((r.u1 - r.u0) * i) / 8;
        const v = r.v0 + ((r.v1 - r.v0) * j) / 8;
        if (coverDepth(set, face, u, v) < BASE) return false; // a gap → black hole
      }
    }
    const inCell = cut.filter((q) => q.face === face && isPathPrefix(base, q.path));
    for (const a of inCell)
      for (const b of inCell)
        if (a !== b && isPathPrefix(a.path, b.path)) return false; // overlap (ancestor + descendant)
    return true;
  };

  it('is identity when baseDepth=0 (determinism guard)', () => {
    const cut = [n(0, [0, 0, 0]), n(0, [0, 0, 1]), n(1, [2, 3])];
    expect(completeCoverage(cut, 0)).toEqual(cut);
  });

  it('THE BUG: a partially-tiled base cell is completed into a full partition', () => {
    // Base cell [0,[0,0]] refined to P0,P1 only — P2,P3 were culled at the cone edge (the limb).
    // Plus an unrelated, fully-tiled far cell that must be left exactly as-is.
    const cut = [n(0, [0, 0, 0]), n(0, [0, 0, 1]), ...refineToDepth(n(3, [2, 1]), 2)];
    expect(cellIsPartition(cut, 0, [0, 0])).toBe(false); // input has the hole
    const out = completeCoverage(cut, BASE);
    expect(cellIsPartition(out, 0, [0, 0])).toBe(true); // hole closed: [0,0] is now fully tiled
    // The missing quadrants are now covered (single coarse fill leaves at depth 3).
    const set = new Set(out.map(skey));
    expect(set.has('0/002')).toBe(true);
    expect(set.has('0/003')).toBe(true);
  });

  it('fills empty quadrants with ONE coarse leaf each (not subdivided deeper)', () => {
    // Only P0 present in [0,[0,0]] → fill must emit exactly [0,0,1],[0,0,2],[0,0,3] at depth 3.
    const cut = [n(0, [0, 0, 0])];
    const out = completeCoverage(cut, BASE);
    const set = new Set(out.map(skey));
    expect(set.has('0/001')).toBe(true);
    expect(set.has('0/002')).toBe(true);
    expect(set.has('0/003')).toBe(true);
    // No deeper fill leaf was emitted under those quadrants.
    expect(out.every((q) => q.path.length <= 3)).toBe(true);
    expect(cellIsPartition(out, 0, [0, 0])).toBe(true);
  });

  it('is a superset with no duplicate leaves', () => {
    const cut = [n(0, [0, 0, 0]), n(0, [0, 0, 1]), n(2, [1, 1, 1])];
    const out = completeCoverage(cut, BASE);
    const keys = out.map(skey);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
    for (const c of cut) expect(keys).toContain(skey(c)); // originals preserved
  });

  it('leaves an already-complete cut unchanged (set-equal)', () => {
    // A base cell fully tiled at depth 3 (all 4 children present) needs no fill.
    const cut = [...refineToDepth(n(0, [0, 0]), 3), n(1, [2, 2])];
    const out = completeCoverage(cut, BASE);
    expect(new Set(out.map(skey))).toEqual(new Set(cut.map(skey)));
  });

  it('is deterministic (same input → identical output)', () => {
    const cut = [n(0, [0, 0, 0]), n(0, [0, 0, 1]), n(4, [3, 0, 2]), n(2, [1])].filter(
      (q) => q.path.length >= BASE,
    );
    const a = completeCoverage(cut, BASE);
    const b = completeCoverage(cut, BASE);
    expect(a).toEqual(b);
  });

  it('composes to a balanced partition (completeCoverage → balanceCut)', () => {
    // A cell straddling the cull edge: P0 refined deep (depth 5) in-cone, P1 at depth 3, P2/P3 culled.
    // After completion+balance the whole cell tiles AND every cross-LOD step is ≤1 level (morphable).
    const cut = [...refineToDepth(n(0, [0, 0, 0]), 5), n(0, [0, 0, 1])];
    const completed = completeCoverage(cut, BASE);
    expect(cellIsPartition(completed, 0, [0, 0])).toBe(true);
    const balanced = balanceCut(completed, MAXD);
    expect(maxNeighborDelta(balanced, MAXD)).toBeLessThanOrEqual(1);
    expect(cellIsPartition(balanced, 0, [0, 0])).toBe(true);
  });
});

describe('production cut composition (FROZEN)', () => {
  // Freeze the LOD decision layer — the cut drives every meshed leaf, so silent drift here
  // changes what the player sees. We pin both stages of the production pipeline
  // (quadtreeManager.update): the pure selectCut SSE partition, and the settled
  // balanceCut(clampCutToReachableFrontier(selectCut, live, baseDepth)) cut. At steady state
  // `live` == the ideal cut, so the clamp is identity and the result is the balanced settled
  // cut the camera actually renders. A compact {count, maxDepth, digest} catches any change.
  const opts: SelectOpts = {
    radius: R,
    heightMargin: 14_000 * 1.6,
    splitPx: 300, // FLY_SPLIT_PX (scene.ts)
    maxDepth: 15, // MAX_DEPTH (scene.ts)
    baseDepth: 2, // BASE_DEPTH (scene.ts)
  };
  const dir = norm([0.2, 1, 0.15]);
  const lookDown: [number, number, number] = [-dir[0], -dir[1], -dir[2]];
  const camAt = (alt: number): CameraView => ({
    position: [dir[0] * (R + alt), dir[1] * (R + alt), dir[2] * (R + alt)],
    viewportHeight: VP,
    fovY: FOVY,
    forward: lookDown,
    halfFov: 1.0,
  });
  // orbit / mid / surface — the three preset altitudes (scene.ts presets).
  const cams = { orbit: camAt(R * 2), mid: camAt(R * 0.12), surface: camAt(28_000) };

  const enc = new TextEncoder();
  const cutDigest = (cut: QuadNode[]): string =>
    fnv1a(enc.encode(cut.map(keyOf).sort().join('|')));
  const maxDepthOf = (cut: QuadNode[]): number => Math.max(...cut.map((nd) => nd.path.length));

  const summarize = (cam: CameraView): Record<string, { count: number; maxDepth: number; digest: string }> => {
    const ideal = selectCut(cam, opts);
    // Steady state: everything in the ideal cut is already live → clamp is identity.
    const settled = balanceCut(clampCutToReachableFrontier(ideal, ideal, opts.baseDepth!), opts.maxDepth);
    return {
      selectCut: { count: ideal.length, maxDepth: maxDepthOf(ideal), digest: cutDigest(ideal) },
      settled: { count: settled.length, maxDepth: maxDepthOf(settled), digest: cutDigest(settled) },
    };
  };

  it('orbit / mid / surface cuts match recorded digests', () => {
    expect({
      orbit: summarize(cams.orbit),
      mid: summarize(cams.mid),
      surface: summarize(cams.surface),
    }).toMatchInlineSnapshot(`
      {
        "mid": {
          "selectCut": {
            "count": 561,
            "digest": "9e4ba87a",
            "maxDepth": 7,
          },
          "settled": {
            "count": 561,
            "digest": "9e4ba87a",
            "maxDepth": 7,
          },
        },
        "orbit": {
          "selectCut": {
            "count": 123,
            "digest": "c2f512e5",
            "maxDepth": 3,
          },
          "settled": {
            "count": 123,
            "digest": "c2f512e5",
            "maxDepth": 3,
          },
        },
        "surface": {
          "selectCut": {
            "count": 561,
            "digest": "f2b516a7",
            "maxDepth": 12,
          },
          "settled": {
            "count": 561,
            "digest": "f2b516a7",
            "maxDepth": 12,
          },
        },
      }
    `);
  });

  it('the settled cut is 2:1-balanced at every preset (morphable everywhere)', () => {
    for (const cam of Object.values(cams)) {
      const ideal = selectCut(cam, opts);
      const settled = balanceCut(clampCutToReachableFrontier(ideal, ideal, opts.baseDepth!), opts.maxDepth);
      expect(maxNeighborDelta(settled, opts.maxDepth)).toBeLessThanOrEqual(1);
    }
  });
});

describe('packRegion / unpackPath — injectivity (the recut-key correctness)', () => {
  // packRegion packs (face, path digits, depth) into one JS-safe integer so the hot cut
  // Sets are Set<number>. Correctness REQUIRES injectivity (distinct regions → distinct
  // keys; depth encoded so [], [0], [0,0] never collide) and an exact round-trip. The cut
  // goldens above exercise this implicitly; here it is proven directly over a wide sweep.
  it('round-trips and is collision-free across a deep sweep', () => {
    const keys = new Map<number, string>(); // key -> "face/path" (to report a collision)
    let count = 0;
    // Deterministic sweep: all faces, all paths up to depth 6, plus a few deep (≤15) paths.
    const walk = (face: number, path: number[]): void => {
      const key = packRegion(face, path, path.length);
      expect(Number.isSafeInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThan(2 ** 37); // layout budget: face<<34 | depth<<30 | pathBits
      expect(unpackPath(key - face * 2 ** 34 - path.length * 2 ** 30, path.length)).toEqual(path);
      const prev = keys.get(key);
      const id = `${face}/${path.join('')}`;
      if (prev !== undefined) expect(prev).toBe(id); // same key ⇒ must be the same region
      keys.set(key, id);
      count++;
      if (path.length < 6) for (let q = 0; q < 4; q++) walk(face, [...path, q]);
    };
    for (let f = 0; f < 6; f++) walk(f, []);
    // A handful of max-depth paths (depth 15) to exercise the high pathBits range.
    for (let f = 0; f < 6; f++) {
      const deep = Array.from({ length: 15 }, (_, i) => (i * 7 + f) % 4);
      const key = packRegion(f, deep, 15);
      expect(Number.isSafeInteger(key) && key < 2 ** 37).toBe(true);
      expect(unpackPath(key - f * 2 ** 34 - 15 * 2 ** 30, 15)).toEqual(deep);
      keys.set(key, `${f}/${deep.join('')}`);
    }
    // No two distinct regions shared a key.
    expect(keys.size).toBe(count + 6);
  });

  it('a prefix and its extension get DISTINCT keys (depth is encoded, not just digits)', () => {
    expect(packRegion(0, [], 0)).not.toBe(packRegion(0, [0], 1));
    expect(packRegion(0, [0], 1)).not.toBe(packRegion(0, [0, 0], 2));
    expect(packRegion(3, [1, 2], 2)).not.toBe(packRegion(3, [1, 2, 0], 3));
  });
});
