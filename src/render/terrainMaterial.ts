// ─────────────────────────────────────────────────────────────────────────────
// Terrain material — the ONE shared CDLOD material for every leaf (render side).
//
// Previously the quadtree manager cloned the base material and rebuilt the TSL
// node graph PER LEAF (one NodeBuilder graph-build, bind group, and material
// object per leaf — GC churn + lost batching across hundreds of churning leaves).
// The CDLOD morph graph is identical for every leaf except two PER-LEAF CONSTANTS
// — the leaf's tangential bound radius and its parent's — so we move those into a
// per-vertex `aLevel` vec2 attribute (constant within a leaf) and build the graph
// ONCE here. The manager then renders every leaf with this single material and
// only fills `aLevel` per leaf; debug-tint modes still clone (diagnostic, rare).
//
// The morph itself is unchanged from the proven per-leaf version: each vertex
// lerps full detail → its one-octave-coarser parent surface as a smooth function
// of CAMERA DISTANCE (CDLOD), reaching the parent exactly at the split distance,
// with the normal morphed by the same factor so shading stays in lockstep.
// ─────────────────────────────────────────────────────────────────────────────

import { DoubleSide } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uniform,
  float,
  mix,
  attribute,
  positionLocal,
  positionWorld,
  cameraPosition,
  smoothstep,
} from 'three/tsl';

/**
 * CDLOD morph region: a leaf shows full detail until the camera recedes to this fraction of the
 * way from its split distance to its merge (parent) distance, then morphs to the parent surface by
 * the merge distance — so detail fades continuously with distance and matches the coarser neighbour
 * exactly at the shared LOD boundary. Used identically in this TSL graph (per-vertex) and in the
 * manager's CPU mirror (`distanceMorph`, for ?lodmorphdebug/?morphcolor). Lower = wider fade band
 * (gentler "always sharpening"); 0.30 ramps each octave over most of a level's distance range.
 */
export const MORPH_START_FRAC = 0.3;

export interface TerrainMaterialOpts {
  wireframe?: boolean;
}

export interface TerrainMaterialHandle {
  /** The single shared material — render every terrain leaf with this. */
  material: MeshStandardNodeMaterial;
  /**
   * Per-frame projected-size constant uniform (set `.value` once per frame):
   * `kDist = (viewportHeight/(2·tan(fovY/2)))/splitPx` — the SAME constant `selectCut` uses, so the
   * distance-morph band reaches the parent surface exactly at the split distance (no seams).
   */
  kDist: { value: number };
}

/**
 * Build the one shared terrain material with the per-vertex CDLOD geomorph wired once.
 * Per-leaf data rides in the `aLevel` vec2 attribute: `.x` = this leaf's tangential bound radius
 * `lodBoundRadius(depth)`, `.y` = its parent's `lodBoundRadius(depth-1)`. Geometry must also carry
 * `morphTarget`/`morphTargetNormal` (the parent-surface position/normal) — the mesher already emits
 * both.
 */
export function createTerrainMaterial(opts: TerrainMaterialOpts = {}): TerrainMaterialHandle {
  const kDist = uniform(0);
  const mat = new MeshStandardNodeMaterial({
    color: 0x9a8c7a,
    roughness: 0.92,
    metalness: 0.0,
    side: DoubleSide,
  });
  mat.wireframe = !!opts.wireframe;

  // Per-leaf bound radii (constant within a leaf), as two scalar attributes. dChild/dParent are the
  // split/merge distances — 2·radius·kDist, matching selectCut's projected-size test exactly. (Two
  // scalar attributes rather than one vec2 so the math uses functional TSL operators — no swizzle.)
  const lodR = float(attribute<'float'>('aLodR', 'float'));
  const parentR = float(attribute<'float'>('aParentR', 'float'));
  const dChild = lodR.mul(2).mul(kDist);
  const dParent = parentR.mul(2).mul(kDist);
  const e0 = mix(dChild, dParent, MORPH_START_FRAC);
  // Per-vertex camera distance (render space → small floats; the floating-origin offset cancels).
  const dist = positionWorld.distance(cameraPosition);
  const mFinal = smoothstep(e0, dParent, dist); // 0 near (full detail) → 1 far (parent surface)

  // Geometry geomorph: lerp full detail → the one-octave-coarser parent surface by distance.
  mat.positionNode = mix(positionLocal, attribute('morphTarget', 'vec3'), mFinal);
  // Shade in lockstep: morph the normal by the SAME factor so a leaf collapsed to its parent
  // surface also shades like the parent (no bright "textured square" at the boundary).
  mat.normalNode = mix(
    attribute('normal', 'vec3'),
    attribute('morphTargetNormal', 'vec3'),
    mFinal,
  ).normalize();
  // Bias the finer leaf toward the camera so it wins the depth test over a coarser ancestor still
  // retained for the brief moment until purge (surfaces match there, so nothing fights).
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;

  return { material: mat, kDist: kDist as unknown as { value: number } };
}
