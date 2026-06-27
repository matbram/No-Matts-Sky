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

import { faceDirection, wrapFaceUV } from './cubesphere.ts';
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
 *
 * The "all descendants live" rule (a FULL one-level cohort, not just one child) is what makes a split
 * pop-free — but it only fires correctly when the wanted cut refines x by exactly ONE level (its 4 direct
 * children). The reachable-frontier clamp (`clampCutToReachableFrontier`) guarantees that: it never lets
 * the cut jump x straight to grandchildren, so the overlapping wanted leaves here are always x's own
 * children and this predicate holds x until the complete replacement cohort is on screen.
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

// ─────────────────────────────────────────────────────────────────────────────
// clampCutToReachableFrontier — gated incremental refinement (the zoom pop-in fix)
//
// The CDLOD vertex morph blends a leaf to its ONE-level-coarser baked parent surface; it can only hide
// a single-level transition, and only once the finer leaf is LIVE before the camera crosses its morph
// band. A plain screen-space cut, on a hard zoom, jumps a region from the resident base (depth 2) STRAIGHT
// to depth 6+ in one recut and requests all those deep leaves at once. The intermediate levels (3,4,5) are
// never built, so the deep leaf arrives over a 4-levels-coarser surface — an unmorphable jump = the pop.
//
// This clamp paces refinement to streaming: it caps the REQUESTED depth of every target leaf so the detail
// front descends ONE level per generation. A region may go no deeper than (its deepest live covering leaf's
// depth) + 1. Once that cohort goes live, the next recut admits the next level, and so on — so every
// transition shown is exactly one level (morphable) and its morph parent is always already live. Refinement
// self-paces (it cannot request level N+1 until N is live), so it never outruns the worker pool.
//
// Direction matters and is asymmetric:
//   • REFINING (target deeper than live coverage): gate to liveAncestorDepth + 1.
//   • MERGING UP / steady (the region ALREADY holds live detail at ≥ target depth): allow the target depth
//     directly — coarsening is made smooth by the morph + deferred removal (retainedShouldRemove), and
//     gating it would collapse detail to the base and re-climb (a zoom-out flicker). Near the camera the
//     coarse ancestors have been purged, so a deepest-live-ANCESTOR walk alone would miss this and wrongly
//     force the base; we detect "region contains live detail" via a live descendant-or-equal instead.
//   • COLD (no live coverage at all — first load, a region not yet streamed): request the base depth first,
//     so the always-resident base lands as the morph parent before anything finer (no fresh-over-backdrop).
//
// PURE + deterministic (a function of the target cut, the live leaf set, and baseDepth — no Three.js, no
// render state passed by value). selectCut/balanceCut are untouched, so their golden tests are unaffected;
// this gets its own test. Applied render-side AFTER balanceCut (truncation only coarsens, so it cannot
// create a >1-level neighbour step that balance didn't already tolerate).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Packed-integer region key — the recut-cost fix.
//
// The hot recut Sets (balanceCut's cut + per-probe coveringDepth lookups, clamp's liveLeaf/coverRegion)
// were keyed by freshly-concatenated STRINGS — at 400+ leaves that's ~10^5 string allocations per recut
// (the ~9–12 ms zoom spike). Pack a region (face 0–5, quadrant path of digits 0–3, depth = path length)
// into a single JS-safe integer instead, so the same Sets become Set<number> with zero per-probe
// allocation. The regions/cuts produced are byte-identical — only the internal key representation changes
// — so the quadtree golden tests must pass UNCHANGED.
//
// Layout (disjoint fields, key < 2^37 ≪ 2^53 so it's an exact JS integer):
//   pathBits  bits 0..29  — digits packed 2 bits each, MSB-first (pathBits < 4^depth ≤ 4^15 = 2^30)
//   depth     bits 30..33 — 0..15 (distinguishes [] vs [0] vs [0,0]; injective ⇒ no collisions)
//   face      bits 34..36 — 0..5
// MUST hold maxDepth ≤ MAX_REGION_DEPTH; assertMaxDepth guards it so a future MAX_DEPTH bump fails loudly
// instead of silently overflowing pathBits into the depth field.
const REGION_DEPTH_UNIT = 2 ** 30; // depth field multiplier (pathBits occupies the low 30 bits)
const REGION_FACE_UNIT = 2 ** 34; // face field multiplier (depth occupies bits 30..33)
const MAX_REGION_DEPTH = 15;

function assertRegionDepth(maxDepth: number): void {
  if (maxDepth > MAX_REGION_DEPTH) {
    throw new Error(
      `quadtree region key supports depth ≤ ${MAX_REGION_DEPTH}; got maxDepth=${maxDepth}. ` +
        `Widen the packed-key fields (and re-check the 2^53 budget) before raising MAX_DEPTH.`,
    );
  }
}

/** Packed integer key for region (face + the first `len` quadrant digits of `path`). Prefixes nest by
 *  encoding depth explicitly. Equal keys ⟺ same face, same depth, same digits (injective).
 *  EXPORTED for the injectivity golden (test/quadtree.test.ts); pure, no behaviour change. */
export function packRegion(face: number, path: number[], len: number): number {
  let pathBits = 0;
  for (let i = 0; i < len; i++) pathBits = pathBits * 4 + path[i]!;
  return face * REGION_FACE_UNIT + len * REGION_DEPTH_UNIT + pathBits;
}

/** Recover the quadrant digits from a packed key's pathBits + depth (inverse of packRegion's packing).
 *  EXPORTED alongside packRegion for the round-trip injectivity golden. */
export function unpackPath(pathBits: number, depth: number): number[] {
  const path: number[] = new Array(depth);
  for (let i = depth - 1; i >= 0; i--) {
    path[i] = pathBits % 4;
    pathBits = Math.floor(pathBits / 4);
  }
  return path;
}

/**
 * Clamp a desired cut so no leaf is requested more than one level deeper than the region's current live
 * coverage — the core of pop-free, streaming-paced LOD (see block comment above). `live` is the set of
 * currently-rendered (live) leaves. `baseDepth` is the always-resident coarse floor a cold region loads
 * first. Returns the clamped, de-duplicated cut (many deep targets collapse onto a shared shallow ancestor).
 */
export function clampCutToReachableFrontier(
  targets: ReadonlyArray<QuadNode>,
  live: ReadonlyArray<QuadNode>,
  baseDepth: number,
): QuadNode[] {
  // Two lookups built once from the live set (packed-integer keys — see packRegion):
  //  • liveLeaf: exact key of each live LEAF — to find the deepest live ANCESTOR of a target.
  //  • coverRegion: key of EVERY prefix (incl. self) of every live leaf — so coverRegion.has(P)
  //    ⟺ some live leaf has P as a prefix ⟺ region P contains live detail at depth ≥ |P| (a descendant).
  const liveLeaf = new Set<number>();
  const coverRegion = new Set<number>();
  for (const lf of live) {
    liveLeaf.add(packRegion(lf.face, lf.path, lf.path.length));
    for (let d = 0; d <= lf.path.length; d++) coverRegion.add(packRegion(lf.face, lf.path, d));
  }

  const out: QuadNode[] = [];
  const seen = new Set<number>();
  for (const t of targets) {
    const D = t.path.length;
    let allowed: number;
    if (coverRegion.has(packRegion(t.face, t.path, D))) {
      // Region already holds live detail at ≥ D (target itself live, or a live descendant → merge-up/steady).
      allowed = D;
    } else {
      // No detail at this depth yet → refining or cold. Find the deepest live LEAF ancestor (d < D).
      let La = -1;
      for (let d = D - 1; d >= baseDepth; d--) {
        if (liveLeaf.has(packRegion(t.face, t.path, d))) {
          La = d;
          break;
        }
      }
      allowed = La >= 0 ? La + 1 : Math.min(D, baseDepth); // refine one level past live, else load the base
    }
    const key = packRegion(t.face, t.path, allowed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ face: t.face, path: t.path.slice(0, allowed) });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// completeCoverage — the cull-edge coverage hole fix (the "random black pop-in").
//
// The cut is supposed to be a COMPLETE partition of the sphere: the always-resident base
// (depth `baseDepth`) keeps every region covered, so a finer leaf always has a parent and there
// is never a black gap. selectCut's backfill (end of selectCut) guarantees this ONLY for
// WHOLE-missing base cells — it keys coverage by the base-depth PREFIX, so a base cell that is
// only PARTIALLY tiled reads as "covered" and is skipped. That blind spot opens a hole at a CULL
// EDGE (the view-cone edge in fly mode = the planet's limb; same at the horizon edge): once a base
// cell `[a,b]` has refined to its children `P0..P3` (all live, the depth-2 leaf purged) and the
// cull edge sweeps across it, the out-of-cone children (e.g. `P2,P3`, depth > baseDepth) are CULLED
// from the cut — and neither the backfill (the cell's prefix is still "covered" by `P0,P1`) nor
// clamp/balance re-adds them. `retainedShouldRemove` then finds no wanted leaf overlapping the
// now-unwanted live `P2,P3` (`anyOverlap=false`) and deletes them the same frame → that sliver is
// covered by NOTHING → black space shows through, then re-covers as the camera moves on.
//
// completeCoverage closes it: it makes the cut a complete partition again by tiling the UNCOVERED
// sub-regions of every PARTIALLY-tiled base cell with the COARSEST leaves that fit (one leaf per
// maximal empty quadrant). Those fill leaves enter `wanted`, so `retainedShouldRemove` keeps the
// old leaves until the fill streams live, then removes them cleanly — no hole.
//
// Applied RENDER-SIDE in quadtreeManager.update(), on the CLAMPED cut and BEFORE the single
// balanceCut — so balance force-splits any >1-level step a coarse fill leaf introduces next to deep
// in-cone detail (preserving the "balanced regardless of input order" invariant), and the fill stays
// inside the shallow, paced regime the clamp established (so retainedShouldRemove's "exactly one
// level" assumption holds). PURE + deterministic (path/packed-key space only, no Three.js, no
// allocations beyond the result). `baseDepth=0` ⇒ identity (determinism guard, like selectCut). It
// only touches base cells that have ≥1 descendant leaf, so it's DISJOINT from selectCut's
// whole-missing-cell backfill (no double-add). selectCut/clamp/balanceCut are untouched, so their
// golden tests are unaffected; this gets its own test.
// ─────────────────────────────────────────────────────────────────────────────

/** Emit the coarsest leaves covering the EMPTY parts of region (face,path,depth): if no cut leaf
 *  has this region as a prefix it's wholly empty → one fill leaf here; if a leaf sits exactly here
 *  it's already tiled → stop; otherwise descend into the 4 children. */
function fillEmptyRegions(
  out: QuadNode[],
  coverRegion: Set<number>,
  leafExact: Set<number>,
  face: number,
  path: number[],
  depth: number,
): void {
  const key = packRegion(face, path, depth);
  if (!coverRegion.has(key)) {
    out.push({ face, path: path.slice() }); // maximal empty quadrant → single coarse fill leaf
    return;
  }
  if (leafExact.has(key)) return; // a cut leaf sits exactly here → already tiled, no descent
  for (let q = 0; q < 4; q++) {
    path.push(q);
    fillEmptyRegions(out, coverRegion, leafExact, face, path, depth + 1);
    path.pop();
  }
}

/**
 * Make `cut` a complete partition of the sphere by filling the uncovered sub-regions of any
 * PARTIALLY-tiled base cell with the coarsest leaves that fit (see block comment above). Pure +
 * deterministic; `baseDepth=0` ⇒ identity. Output is sorted by packed key so it's stable regardless
 * of Set iteration order (a clean golden). Originals are preserved (the result is a superset).
 */
export function completeCoverage(cut: ReadonlyArray<QuadNode>, baseDepth: number): QuadNode[] {
  if (baseDepth <= 0) return cut.slice(); // off ⇒ identity (determinism guard, like selectCut)

  // Index the cut by EVERY prefix at depths [baseDepth .. leaf.depth] (coverRegion), by exact leaf
  // region (leafExact), and by base-depth prefix of any touched cell (baseTouched). Packed-int keys
  // (packRegion) — no string allocation. coverRegion.has(P) ⟺ some leaf has region P as a prefix.
  const coverRegion = new Set<number>();
  const leafExact = new Set<number>();
  const baseTouched = new Set<number>();
  for (const lf of cut) {
    const D = lf.path.length;
    if (D < baseDepth) continue; // shallower-than-base can't happen post-clamp; skip defensively
    for (let d = baseDepth; d <= D; d++) coverRegion.add(packRegion(lf.face, lf.path, d));
    leafExact.add(packRegion(lf.face, lf.path, D));
    baseTouched.add(packRegion(lf.face, lf.path, baseDepth));
  }

  const out: QuadNode[] = cut.slice();
  // For each TOUCHED base cell that isn't already a single base leaf, fill its empty quadrants.
  // Whole-MISSING base cells (no descendant) aren't in baseTouched — selectCut's backfill owns those.
  for (const key of baseTouched) {
    if (leafExact.has(key)) continue; // the cell is exactly one base leaf → fully tiled already
    const face = Math.floor(key / REGION_FACE_UNIT);
    const pathBits = key - face * REGION_FACE_UNIT - baseDepth * REGION_DEPTH_UNIT;
    const basePath = unpackPath(pathBits, baseDepth);
    fillEmptyRegions(out, coverRegion, leafExact, face, basePath, baseDepth);
  }

  // Stable order (Set-iteration-independent) so the golden is deterministic.
  out.sort((a, b) => packRegion(a.face, a.path, a.path.length) - packRegion(b.face, b.path, b.path.length));
  return out;
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
    const covered = new Set<number>();
    for (const lf of leaves) covered.add(packRegion(lf.face, lf.path, baseDepth)); // prefix of length baseDepth
    for (let f = 0; f < 6; f++) {
      for (const path of baseCellPaths(baseDepth)) {
        if (!covered.has(packRegion(f, path, baseDepth))) leaves.push({ face: f, path: path.slice() });
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

// ─────────────────────────────────────────────────────────────────────────────
// balanceCut — 2:1 restricted quadtree (CDLOD's morph hides only a ONE-level step)
//
// CDLOD blends a leaf toward its PARENT at the shared edge, so a coarse leaf meeting a leaf exactly
// one level finer is seamless. A step of 2+ levels (e.g. a depth-2 base leaf abutting a depth-6 leaf
// with no 3/4/5 between — ?lodaudit logged exactly this: maxNbrΔ=4, lod={2,4,5,6}) is UNMORPHABLE
// and shows as a hard seam / pop. balanceCut force-splits any leaf whose edge-neighbour is >1 level
// finer, to a fixpoint, so every cross-LOD edge is exactly one level. Pure + deterministic (a
// function of the leaf set + maxDepth); applied AFTER selectCut, so selectCut's golden test is
// unchanged and this gets its own test.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Depth of the cut leaf covering face-(u,v): walk the quadtree from the root, return the depth of
 * the first prefix present in `cut` (the cut is a partition, so that's THE covering leaf). -1 if
 * uncovered (e.g. a culled far side when baseDepth=0) → caller treats as "no constraint". The
 * quadrant test matches uvRectFromPath exactly (bit0 = upper-u half, bit1 = upper-v half). Builds the
 * packed-integer region key incrementally as it descends — no per-level string/array allocation. This
 * is the hot probe (12× per leaf per balance pass), so its allocation-freeness is the recut-cost win.
 */
function coveringDepth(cut: Set<number>, face: number, u: number, v: number, maxDepth: number): number {
  const faceBits = face * REGION_FACE_UNIT;
  if (cut.has(faceBits)) return 0; // root: depth 0, pathBits 0
  let u0 = -1, u1 = 1, v0 = -1, v1 = 1;
  let pathBits = 0;
  for (let d = 1; d <= maxDepth; d++) {
    const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    let q = 0;
    if (u >= um) { q |= 1; u0 = um; } else u1 = um;
    if (v >= vm) { q |= 2; v0 = vm; } else v1 = vm;
    pathBits = pathBits * 4 + q;
    if (cut.has(faceBits + d * REGION_DEPTH_UNIT + pathBits)) return d; // == packRegion(face, path, d)
  }
  return -1;
}

/**
 * Max depth of any edge-neighbour of leaf (face,path) in the cut. Probes just past each of the 4
 * edges at several along-edge fractions (so a finer neighbour anywhere along the edge is caught);
 * `wrapFaceUV` maps an overshoot across a cube edge onto the neighbour face (the same watertight
 * convention the mesher's apron uses), so cross-face neighbours resolve correctly. Catching a
 * 2-levels-finer neighbour is enough — deeper ones are caught after the first split, by the fixpoint.
 */
function maxNeighborDepth(cut: Set<number>, face: number, path: number[], maxDepth: number): number {
  const r = uvRectFromPath(path);
  const eps = (r.u1 - r.u0) * 0.02; // just past the edge; r is square so u/v spans match
  const fr = [0.25, 0.5, 0.75];
  let maxNd = -1;
  const probe = (pu: number, pv: number): void => {
    const w = wrapFaceUV(face, pu, pv);
    const nd = coveringDepth(cut, w.face, w.u, w.v, maxDepth);
    if (nd > maxNd) maxNd = nd;
  };
  for (const t of fr) {
    const v = r.v0 + (r.v1 - r.v0) * t;
    probe(r.u1 + eps, v); // +u edge
    probe(r.u0 - eps, v); // −u edge
    const u = r.u0 + (r.u1 - r.u0) * t;
    probe(u, r.v1 + eps); // +v edge
    probe(u, r.v0 - eps); // −v edge
  }
  return maxNd;
}

/**
 * Force-split any leaf whose edge-neighbour is >1 level finer, to a fixpoint, so the returned cut is
 * 2:1 balanced (`maxNbrΔ ≤ 1`) and every cross-LOD step is morphable (no seam pop). Balancing only
 * adds the intermediate transition leaves (it never coarsens), so the count grows modestly when the
 * input cut is already near-balanced. `maxLeaves` is a defensive growth cap.
 */
export function balanceCut(leaves: QuadNode[], maxDepth: number, maxLeaves = 8192): QuadNode[] {
  assertRegionDepth(maxDepth);
  const cut = new Set<number>();
  for (const lf of leaves) cut.add(packRegion(lf.face, lf.path, lf.path.length));
  // Each pass only splits (deepens) leaves, bounded by maxDepth, so it converges in ≤ maxDepth
  // passes; the guard is a touch higher for safety.
  for (let pass = 0; pass <= maxDepth + 2; pass++) {
    let changed = false;
    for (const k of [...cut]) {
      if (!cut.has(k)) continue; // already split away earlier this pass
      const face = Math.floor(k / REGION_FACE_UNIT);
      const depth = Math.floor((k - face * REGION_FACE_UNIT) / REGION_DEPTH_UNIT);
      if (depth >= maxDepth) continue;
      const pathBits = k - face * REGION_FACE_UNIT - depth * REGION_DEPTH_UNIT;
      const path = unpackPath(pathBits, depth);
      if (maxNeighborDepth(cut, face, path, maxDepth) - depth >= 2) {
        cut.delete(k);
        for (let q = 0; q < 4; q++) cut.add(packRegion(face, [...path, q], depth + 1));
        changed = true;
        if (cut.size >= maxLeaves) break;
      }
    }
    if (!changed || cut.size >= maxLeaves) break;
  }
  const out: QuadNode[] = [];
  for (const k of cut) {
    const face = Math.floor(k / REGION_FACE_UNIT);
    const depth = Math.floor((k - face * REGION_FACE_UNIT) / REGION_DEPTH_UNIT);
    const pathBits = k - face * REGION_FACE_UNIT - depth * REGION_DEPTH_UNIT;
    out.push({ face, path: unpackPath(pathBits, depth) });
  }
  return out;
}

/**
 * Largest LOD-level difference across any leaf's EDGE (the true 2:1-balance metric; ≤1 means every
 * cross-LOD step is morphable). Uses the SAME fine edge probe as balanceCut — a small offset just
 * past the edge so it samples the IMMEDIATE neighbour. (The old render-side metric probed a quarter
 * of a cell past the edge, which for a coarse leaf overshoots several fine cells deep and reports a
 * NON-adjacent leaf's depth — that false inflation is what logged "maxNbrΔ=4" on cuts that were in
 * fact balanced, and its O(leaves²) scan was a recut spike.) Cheap: O(leaves · maxDepth). Debug-only.
 */
export function maxNeighborDelta(leaves: QuadNode[], maxDepth: number): number {
  assertRegionDepth(maxDepth);
  const cut = new Set<number>();
  for (const lf of leaves) cut.add(packRegion(lf.face, lf.path, lf.path.length));
  let maxD = 0;
  for (const lf of leaves) {
    const r = uvRectFromPath(lf.path);
    const eps = (r.u1 - r.u0) * 0.02;
    const d = lf.path.length;
    for (const t of [0.25, 0.5, 0.75]) {
      const v = r.v0 + (r.v1 - r.v0) * t;
      const u = r.u0 + (r.u1 - r.u0) * t;
      const probes: ReadonlyArray<readonly [number, number]> = [
        [r.u1 + eps, v], [r.u0 - eps, v], [u, r.v1 + eps], [u, r.v0 - eps],
      ];
      for (const [pu, pv] of probes) {
        const w = wrapFaceUV(lf.face, pu, pv);
        const nd = coveringDepth(cut, w.face, w.u, w.v, maxDepth);
        if (nd >= 0) { const diff = Math.abs(nd - d); if (diff > maxD) maxD = diff; }
      }
    }
  }
  return maxD;
}
