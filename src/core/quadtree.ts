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
}

/** The 4 children of a node (quadrant order 0..3 — see uvRectFromPath). */
export function childrenOf(node: QuadNode): QuadNode[] {
  return [0, 1, 2, 3].map((q) => ({ face: node.face, path: [...node.path, q] }));
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
  const cx = c[0] * radius;
  const cy = c[1] * radius;
  const cz = c[2] * radius;
  let maxd2 = 0;
  const corners: Array<[number, number]> = [
    [r.u0, r.v0],
    [r.u1, r.v0],
    [r.u0, r.v1],
    [r.u1, r.v1],
  ];
  for (const [u, v] of corners) {
    const d = faceDirection(face, u, v);
    const dx = d[0] * radius - cx;
    const dy = d[1] * radius - cy;
    const dz = d[2] * radius - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > maxd2) maxd2 = d2;
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(maxd2) + heightMargin };
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

/** True if the node sits past the planet's horizon from the camera (fully occluded). */
function overHorizon(b: NodeBounds, camPos: [number, number, number], radius: number): boolean {
  const pc = Math.hypot(camPos[0], camPos[1], camPos[2]);
  if (pc <= radius) return false; // camera at/below surface → cull nothing
  const cc = Math.hypot(b.center[0], b.center[1], b.center[2]);
  if (cc < 1e-6) return false;
  const thetaH = Math.acos(radius / pc); // camera→horizon half-angle
  const cosA =
    (camPos[0] * b.center[0] + camPos[1] * b.center[1] + camPos[2] * b.center[2]) / (pc * cc);
  const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const nodeAngular = Math.asin(Math.min(1, b.radius / cc));
  return angle - nodeAngular > thetaH;
}

/** True if the node lies outside the camera's view cone (approximate frustum cull). */
function outsideCone(
  b: NodeBounds,
  camPos: [number, number, number],
  forward: [number, number, number],
  halfFov: number,
): boolean {
  const vx = b.center[0] - camPos[0];
  const vy = b.center[1] - camPos[1];
  const vz = b.center[2] - camPos[2];
  const vlen = Math.hypot(vx, vy, vz);
  if (vlen < 1e-6 || vlen <= b.radius) return false; // on top of / inside the node
  const cosA = (vx * forward[0] + vy * forward[1] + vz * forward[2]) / vlen;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const nodeAngular = Math.asin(Math.min(1, b.radius / vlen));
  return angle - nodeAngular > halfFov;
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

  while (stack.length > 0) {
    const node = stack.pop()!;
    const b = nodeBounds(node.face, node.path, opts.radius, opts.heightMargin);
    if (cull && overHorizon(b, camera.position, opts.radius)) continue;
    if (forward && halfFov !== undefined && outsideCone(b, camera.position, forward, halfFov)) {
      continue;
    }

    const dx = camera.position[0] - b.center[0];
    const dy = camera.position[1] - b.center[1];
    const dz = camera.position[2] - b.center[2];
    const dist = Math.hypot(dx, dy, dz);
    const px = projectedSize(b.radius, dist, camera.viewportHeight, camera.fovY);

    if (node.path.length < opts.maxDepth && px > opts.splitPx && leaves.length < maxLeaves) {
      for (const child of childrenOf(node)) stack.push(child);
    } else {
      leaves.push(node);
    }
  }
  return leaves;
}
