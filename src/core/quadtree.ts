// ─────────────────────────────────────────────────────────────────────────────
// Cube-sphere quadtree LOD — PURE TS, no Three.js. Step 2.
//
// Each cube face is the root of a quadtree (master plan §5.5, slice spec §6). A
// node covers a (u,v) sub-rectangle of its face; splitting into 4 children halves
// it in u and v. We render the "cut": the set of leaves where the node's on-screen
// size drops below a threshold (coarse far away, fine up close). The far side of
// the planet is horizon-culled so it's never meshed.
//
// This is the decision layer only — deterministic given the camera, and fully
// unit-testable headlessly. Meshing a leaf is chunk.ts; scheduling the work is
// the render-side manager.
// ─────────────────────────────────────────────────────────────────────────────

import { faceDirection } from './cubesphere.ts';
import { uvRectFromPath } from './chunk.ts';

/** A quadtree node: a cube face + a path of quadrants (lod = path.length). */
export interface QuadNode {
  face: number;
  path: number[];
}

/** World-space bounding sphere of a node (for LOD distance + horizon cull). */
export interface NodeBounds {
  center: [number, number, number];
  radius: number;
}

/** The camera state the cut depends on. */
export interface CameraView {
  position: [number, number, number]; // world (planet-centered) meters
  viewportHeight: number; // px
  fovY: number; // vertical field of view, radians
  forward?: [number, number, number]; // unit look direction (for frustum/cone cull)
  halfFov?: number; // cone half-angle (radians) covering the frustum corners
}

/** LOD tuning + planet parameters. */
export interface SelectOpts {
  radius: number; // planet radius (m)
  heightMargin: number; // terrain amplitude margin added to bounds (m)
  splitPx: number; // split when projected diameter exceeds this (≈400)
  maxDepth: number; // deepest leaf
  cullHorizon?: boolean; // drop nodes past the planet's horizon (default true)
  maxLeaves?: number; // safety cap on the cut size (default 4096)
  /**
   * Speed-aware PREFETCH lead distance (m). Brings every level's split distance
   * FORWARD by this many meters (split when `dist < dSplit(depth) + prefetchM`), so a
   * fast approach requests the finer leaves EARLY — they finish streaming before the
   * camera reaches their CDLOD morph band and are born at the parent surface (m≈1),
   * then resolve gradually with distance instead of snapping in late. The render shell
   * sets it to `approachSpeed · leadTime`; `0` (default) ⇒ byte-identical to a plain
   * screen-space-error cut. Applied to the SPLIT test only — culling uses the true
   * distance, so prefetch never un-culls the horizon/cone. selectCut stays a pure,
   * deterministic decision layer (the canonical generation core is untouched).
   */
  prefetchM?: number;
  /**
   * Always-resident coarse base depth. The coarsest `baseDepth` levels are NEVER culled,
   * so the WHOLE sphere is always tiled at (at least) this depth — every region keeps a
   * covering leaf even on the far side / off-cone. That leaf is the real CDLOD parent a
   * finer leaf morphs FROM when a region rotates or streams in, so detail only sharpens
   * (no "fresh over backdrop" pop the morph can't hide). Nodes shallower than baseDepth
   * force-split (build the full base tiling); a node AT baseDepth that culling would drop,
   * or that the screen-space error doesn't refine, becomes a resident base leaf. `0`
   * (default) ⇒ no pinned base ⇒ byte-identical to the plain cut (determinism guard). The
   * partition is preserved — a refined base node is replaced by its children and purged as
   * usual, so there's no permanent coarse/fine overlap (no poke-through). [T] tune cost.
   */
  baseDepth?: number;
}

/** The 4 children of a node (quadrant order 0..3 — see uvRectFromPath). */
export function childrenOf(node: QuadNode): QuadNode[] {
  return [0, 1, 2, 3].map((q) => ({ face: node.face, path: [...node.path, q] }));
}

/** True if path `a` is a prefix of path `b` (a is an ancestor-or-equal of b). */
export function isPathPrefix(a: number[], b: number[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Deferred-removal predicate: should a retained (live, no-longer-wanted) leaf `x`
 * be removed now? The wanted cut is a partition, so the wanted leaves overlapping
 * x's region are EITHER one ancestor (the camera merged up) OR a set of
 * descendants (it split down). Remove x when its replacement is fully on screen:
 *   • no wanted leaf overlaps x        → x left the view entirely;
 *   • the overlapping ancestor is live → the merge is ready;
 *   • all overlapping descendants live → the split is ready.
 * Otherwise keep x rendered so no hole (black flash) appears mid-transition.
 */
export function retainedShouldRemove(
  x: QuadNode,
  wanted: ReadonlyArray<{ node: QuadNode; live: boolean }>,
): boolean {
  let anyOverlap = false;
  let descCount = 0;
  let descLive = 0;
  for (const w of wanted) {
    if (w.node.face !== x.face) continue;
    const xPrefixOfW = isPathPrefix(x.path, w.node.path); // w is descendant-or-equal of x
    const wPrefixOfX = isPathPrefix(w.node.path, x.path); // w is ancestor-or-equal of x
    if (!xPrefixOfW && !wPrefixOfX) continue;
    anyOverlap = true;
    if (w.node.path.length < x.path.length) {
      if (w.live) return true; // a live ancestor covers x (merge done)
    } else if (w.node.path.length > x.path.length) {
      descCount++;
      if (w.live) descLive++;
    } else if (w.live) {
      return true; // x itself is wanted-and-live (defensive)
    }
  }
  if (!anyOverlap) return true; // x's region is gone from the cut → remove
  return descCount > 0 && descCount === descLive; // all split children live → remove
}

// Conservative bounding-radius factor per quadtree depth. A depth-d face quadrant
// is largest (least cube-sphere distortion) at the face CENTER, where a uv
// half-size h=1/2^d maps to a corner at distance |normalize(h,h,1) − (0,0,1)| from
// the center. Using this per-depth max for every node is conservative (LOD splits
// slightly early, never late) and lets nodeBounds skip the 4 corner faceDirection
// calls. Precomputed once.
const MAX_DEPTH_TABLE = 26;
const BOUND_FACTOR: Float64Array = (() => {
  const t = new Float64Array(MAX_DEPTH_TABLE + 1);
  for (let d = 0; d <= MAX_DEPTH_TABLE; d++) {
    const h = 1 / 2 ** d;
    const inv = 1 / Math.sqrt(h * h + h * h + 1);
    const nz = inv;
    const nxy = h * inv;
    t[d] = Math.sqrt(2 * nxy * nxy + (nz - 1) * (nz - 1));
  }
  return t;
})();

/**
 * Tangential bounding radius of a leaf at `depth` (the SAME metric `selectCut` uses for
 * its screen-space-error test). Shared with the render shell's CDLOD geomorph so the
 * distance-morph band aligns exactly with the split distance (no seams). Depth is clamped
 * to the precomputed table.
 */
export function lodBoundRadius(depth: number, radius: number): number {
  const d = depth <= MAX_DEPTH_TABLE ? (depth < 0 ? 0 : depth) : MAX_DEPTH_TABLE;
  return BOUND_FACTOR[d]! * radius;
}

/** World-space bounding sphere of a node: its surface patch ± the terrain margin. */
export function nodeBounds(
  face: number,
  path: number[],
  radius: number,
  heightMargin: number,
): NodeBounds {
  const r = uvRectFromPath(path);
  const c = faceDirection(face, (r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2);
  const d = path.length <= MAX_DEPTH_TABLE ? path.length : MAX_DEPTH_TABLE;
  return {
    center: [c[0] * radius, c[1] * radius, c[2] * radius],
    radius: BOUND_FACTOR[d]! * radius + heightMargin,
  };
}

/** Screen-space diameter (px) of a bounding sphere of `boundsRadius` at `distance`. */
export function projectedSize(
  boundsRadius: number,
  distance: number,
  viewportHeight: number,
  fovY: number,
): number {
  if (distance <= boundsRadius) return Infinity; // camera inside → always split
  return ((2 * boundsRadius) / distance) * (viewportHeight / (2 * Math.tan(fovY / 2)));
}

// Horizon cull via cosines (no acos/asin). Cull iff the angle from the camera
// direction to the node exceeds horizon + node angular radius, i.e.
// cosA < cos(θ_h + θ_node) = cosθh·cosθn − sinθh·sinθn. `cosThetaH`/`sinThetaH`
// are camera-constant (precomputed once per cut).
function overHorizonCos(
  b: NodeBounds,
  camPos: [number, number, number],
  pc: number,
  cosThetaH: number,
  sinThetaH: number,
): boolean {
  const cc = Math.hypot(b.center[0], b.center[1], b.center[2]);
  if (cc < 1e-6) return false;
  const cosA =
    (camPos[0] * b.center[0] + camPos[1] * b.center[1] + camPos[2] * b.center[2]) / (pc * cc);
  const sinNode = Math.min(1, b.radius / cc);
  const cosNode = Math.sqrt(Math.max(0, 1 - sinNode * sinNode));
  return cosA < cosThetaH * cosNode - sinThetaH * sinNode;
}

// View-cone cull via cosines. `cosHalf`/`sinHalf` are the cone half-angle's
// cosine/sine (precomputed once per cut).
function outsideConeCos(
  b: NodeBounds,
  camPos: [number, number, number],
  forward: [number, number, number],
  cosHalf: number,
  sinHalf: number,
): boolean {
  const vx = b.center[0] - camPos[0];
  const vy = b.center[1] - camPos[1];
  const vz = b.center[2] - camPos[2];
  const vlen = Math.hypot(vx, vy, vz);
  if (vlen < 1e-6 || vlen <= b.radius) return false; // on top of / inside the node
  const cosA = (vx * forward[0] + vy * forward[1] + vz * forward[2]) / vlen;
  const sinNode = Math.min(1, b.radius / vlen);
  const cosNode = Math.sqrt(Math.max(0, 1 - sinNode * sinNode));
  return cosA < cosHalf * cosNode - sinHalf * sinNode;
}

/**
 * Compute the visible leaf cut: recurse each face root, split while the node is
 * too big on screen (and shallower than maxDepth), horizon-cull the far side.
 * Deterministic for a given camera + opts.
 */
export function selectCut(camera: CameraView, opts: SelectOpts): QuadNode[] {
  const cull = opts.cullHorizon ?? true;
  const maxLeaves = opts.maxLeaves ?? 4096;
  const leaves: QuadNode[] = [];
  const stack: QuadNode[] = [];
  for (let f = 0; f < 6; f++) stack.push({ face: f, path: [] });

  const forward = camera.forward;
  const halfFov = camera.halfFov;

  // Camera-constant culling terms, computed once per cut (no per-node trig).
  const pc = Math.hypot(camera.position[0], camera.position[1], camera.position[2]);
  const cullH = cull && pc > opts.radius; // no horizon when at/below the surface
  const cosThetaH = cullH ? opts.radius / pc : 0;
  const sinThetaH = cullH ? Math.sqrt(Math.max(0, 1 - cosThetaH * cosThetaH)) : 0;
  const useCone = forward !== undefined && halfFov !== undefined;
  const cosHalf = useCone ? Math.cos(halfFov!) : 0;
  const sinHalf = useCone ? Math.sin(halfFov!) : 0;
  const prefetchM = opts.prefetchM ?? 0; // speed-aware lead distance for the split test
  const baseDepth = opts.baseDepth ?? 0; // always-resident coarse base (0 = off → unchanged)

  while (stack.length > 0) {
    const node = stack.pop()!;
    const depth = node.path.length;
    // Always-resident coarse base: the coarsest `baseDepth` levels are never culled, so the
    // whole sphere stays meshed at low detail and every finer leaf has a real parent to morph
    // from. Below baseDepth force-split to build the full base tiling (no SSE/cull gate).
    if (depth < baseDepth) {
      for (const child of childrenOf(node)) stack.push(child);
      continue;
    }
    const b = nodeBounds(node.face, node.path, opts.radius, opts.heightMargin);
    // A node at the base level that culling would drop becomes a RESIDENT base leaf (keeps
    // the far side / off-cone always covered); deeper culled nodes are dropped as before.
    // With baseDepth=0 this is the original behaviour exactly (culled depth-0 roots drop).
    if (
      (cullH && overHorizonCos(b, camera.position, pc, cosThetaH, sinThetaH)) ||
      (useCone && outsideConeCos(b, camera.position, forward!, cosHalf, sinHalf))
    ) {
      if (baseDepth > 0 && depth === baseDepth) leaves.push(node);
      continue;
    }

    const dx = camera.position[0] - b.center[0];
    const dy = camera.position[1] - b.center[1];
    const dz = camera.position[2] - b.center[2];
    const dist = Math.hypot(dx, dy, dz);
    // LOD/split test uses the node's TANGENTIAL patch size, NOT the height-inflated
    // cull radius. The ±heightMargin envelope is for culling tall peaks (above), but
    // folding it into the screen-size metric made every deep leaf project as ~14 km
    // regardless of its true tessellation size — so once a region was close enough to
    // want depth ~9 it wanted ALL the way to maxDepth, collapsing near/far LOD
    // discrimination and blowing the leaf count up to the cap. Tangential-only is the
    // standard screen-space-error metric and grades detail by distance (near = fine).
    // At orbit/fly distances BOUND_FACTOR·radius ≫ heightMargin, so those cuts are
    // unchanged; only the near/deep regime (the blow-up) is corrected.
    const lodRadius = lodBoundRadius(node.path.length, opts.radius);
    // Speed-aware prefetch: subtract the lead distance from the SPLIT distance only.
    // px(dist) > splitPx ⟺ dist < dSplit(depth); using dist−prefetchM extends every
    // level's split distance forward by prefetchM, so finer leaves are requested early
    // and stream in before the camera reaches their morph band (no late snap). The flat
    // meters lead is negligible at coarse levels (huge dSplit) and self-targets the
    // deepest levels (tiny dSplit) — exactly where the late-arrival pop happens.
    // projectedSize returns Infinity for distEff ≤ lodRadius (very close / overshoot) →
    // split, which is correct. prefetchM=0 ⇒ distEff===dist ⇒ unchanged.
    const distEff = prefetchM > 0 ? dist - prefetchM : dist;
    const px = projectedSize(lodRadius, distEff, camera.viewportHeight, camera.fovY);

    if (node.path.length < opts.maxDepth && px > opts.splitPx && leaves.length < maxLeaves) {
      for (const child of childrenOf(node)) stack.push(child);
    } else {
      leaves.push(node);
    }
  }

  // Always-resident base completeness. Force-splitting guarantees every leaf is ≥ baseDepth
  // deep, but a base cell that's PARTIALLY in-cone can split and then have ALL its children
  // culled (a frustum-edge sliver) → its region ends up with no leaf, which the backdrop
  // would show through = the very pop we're removing. Backfill any base cell not covered by
  // a leaf with a resident leaf, so the whole sphere is guaranteed tiled at baseDepth.
  if (baseDepth > 0) {
    const covered = new Set<string>();
    for (const lf of leaves) covered.add(`${lf.face}/${lf.path.slice(0, baseDepth).join(',')}`);
    for (let f = 0; f < 6; f++) {
      for (const path of baseCellPaths(baseDepth)) {
        if (!covered.has(`${f}/${path.join(',')}`)) leaves.push({ face: f, path: path.slice() });
      }
    }
  }
  return leaves;
}

// All quadrant paths of length `depth` (the complete depth-`depth` tiling of one face):
// 4^depth paths over {0,1,2,3}. Used to backfill any uncovered always-resident base cell.
function baseCellPaths(depth: number): number[][] {
  let paths: number[][] = [[]];
  for (let d = 0; d < depth; d++) {
    const next: number[][] = [];
    for (const p of paths) for (let q = 0; q < 4; q++) next.push([...p, q]);
    paths = next;
  }
  return paths;
}
