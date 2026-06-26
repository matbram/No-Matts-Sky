// ─────────────────────────────────────────────────────────────────────────────
// Terrain material — the ONE shared CDLOD material for every leaf (render side).
//
// Two jobs, both wired ONCE here (no per-leaf material):
//
// 1) CDLOD geomorph (Step 2). Each vertex lerps full detail → its one-octave-coarser
//    parent surface as a smooth function of CAMERA DISTANCE, reaching the parent
//    exactly at the split distance, with the normal morphed by the same factor so
//    shading stays in lockstep. Per-leaf data (the leaf's tangential bound radius and
//    its parent's) rides in the `aLodR`/`aParentR` vertex attributes, so one material
//    renders every leaf — no clone / node-graph rebuild per leaf.
//
// 2) Surface detail (Step 3). Triplanar-free procedural detail (gradient noise from a
//    recenter-stable world coordinate) + slope material bands, whose strength FADES IN
//    with proximity on the SAME schedule as the geometry morph (weighted by 1−mFinal)
//    plus a per-distance anti-alias gate. So the surface gets gradually CLEARER as you
//    descend — like a plane approaching Earth — with no discrete arrival (it's a pure
//    per-pixel function of distance, independent of chunk streaming) and no shimmer
//    (each octave fades out before its features drop below a pixel).
//
// Precision (master plan Part 4): the morph's distance uses render-space positionWorld
// (the floating-origin offset cancels). The detail COORDINATE needs an absolute, stable
// world position; render-space positionWorld would "swim" when the origin recenters, and
// the true absolute position is too large for float detail. So we add back a per-frame
// `detailPhase = renderOrigin mod L` (reduced in DOUBLE on the CPU): positionWorld+phase
// tracks the absolute position continuously through recenters yet stays small (< L) so
// metre-scale detail stays float-precise. The slope `up` uses the full renderOrigin
// (direction only — robust to the large magnitude).
// ─────────────────────────────────────────────────────────────────────────────

import { DoubleSide, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uniform,
  float,
  vec3,
  mix,
  attribute,
  positionLocal,
  positionWorld,
  cameraPosition,
  smoothstep,
  mx_noise_vec3,
} from 'three/tsl';

/**
 * CDLOD morph region: a leaf shows full detail until the camera recedes to this fraction of the way
 * from its split distance to its merge (parent) distance, then morphs to the parent surface by the
 * merge distance. Used identically in this TSL graph (per-vertex) and the manager's CPU mirror
 * (`distanceMorph`, for ?lodmorphdebug/?morphcolor). Lower = wider fade band (gentler "always
 * sharpening").
 */
export const MORPH_START_FRAC = 0.3;

// Detail-phase modulus (m): renderOrigin is reduced mod this (in double) so the detail coordinate
// stays small enough for float precision (~1 cm at L=100 km) while tracking the absolute world
// position continuously through every floating-origin recenter. Large enough that a wrap (the only
// time detail could visibly reshuffle) happens at most every L of cumulative origin travel — never
// in a normal fly descent (the origin is fixed per preset), rare in a long walk.
const DETAIL_PHASE_MOD_M = 100_000;

// Two procedural detail octaves: coarse features fade in from higher up, fine features only at close
// range — together a continuous onset of surface texture across the descent. Each octave's distance
// gate (smoothstep far→near) is also its anti-alias guard: it reaches 0 before the feature projects
// below ~1 px, so the finest detail never shimmers. [T] tune.
const DETAIL_A_SCALE_M = 40; // coarse mottle (~40 m features)
const DETAIL_A_NEAR_M = 1_000;
const DETAIL_A_FAR_M = 50_000;
const DETAIL_B_SCALE_M = 6; // fine grain (~6 m features)
const DETAIL_B_NEAR_M = 200;
const DETAIL_B_FAR_M = 6_000;

// One archetype's palette (barren): flatter ground reads as light regolith, steeper faces as darker
// rock. Cosmetic floats (render-only — NOT canonical, no determinism constraint; master plan §5.8).
const SAND = [0.62, 0.55, 0.45] as const;
const ROCK = [0.40, 0.36, 0.33] as const;

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
  /** Full render origin (m). Set `.value` whenever the floating origin recenters. Used (direction
   *  only) to reconstruct the per-pixel radial "up" for slope material bands. */
  renderOrigin: { value: Vector3 };
  /** renderOrigin reduced modulo DETAIL_PHASE_MOD_M IN DOUBLE (set with renderOrigin). Added back to
   *  render-space positionWorld to give a stable, float-precise absolute coordinate for the detail. */
  detailPhase: { value: Vector3 };
}

/**
 * Build the one shared terrain material with the geomorph + distance-faded surface detail wired once.
 * Geometry must carry `aLodR`/`aParentR` (per-leaf bound radii) plus `morphTarget`/`morphTargetNormal`
 * (the parent-surface position/normal) — the mesher + manager already emit all four.
 */
export function createTerrainMaterial(opts: TerrainMaterialOpts = {}): TerrainMaterialHandle {
  const kDist = uniform(0);
  const uRenderOrigin = uniform(new Vector3());
  const uDetailPhase = uniform(new Vector3());
  const mat = new MeshStandardNodeMaterial({
    color: 0x9a8c7a,
    roughness: 0.92,
    metalness: 0.0,
    side: DoubleSide,
  });
  mat.wireframe = !!opts.wireframe;

  // ── CDLOD geomorph ─────────────────────────────────────────────────────────
  // Per-leaf bound radii (constant within a leaf), as two scalar attributes. dChild/dParent are the
  // split/merge distances — 2·radius·kDist, matching selectCut's projected-size test exactly.
  const lodR = float(attribute<'float'>('aLodR', 'float'));
  const parentR = float(attribute<'float'>('aParentR', 'float'));
  const dChild = lodR.mul(2).mul(kDist);
  const dParent = parentR.mul(2).mul(kDist);
  const e0 = mix(dChild, dParent, MORPH_START_FRAC);
  const dist = positionWorld.distance(cameraPosition); // render space → small floats (origin cancels)
  const mFinal = smoothstep(e0, dParent, dist); // 0 near (full detail) → 1 far (parent surface)

  // Geometry: lerp full detail → the one-octave-coarser parent surface by distance.
  mat.positionNode = mix(positionLocal, attribute('morphTarget', 'vec3'), mFinal);
  // The morph-blended surface normal (shade in lockstep so a leaf collapsed to its parent also
  // shades like the parent — no bright "textured square"). Reused below as the base for detail.
  const nGeom = mix(
    attribute('normal', 'vec3'),
    attribute('morphTargetNormal', 'vec3'),
    mFinal,
  ).normalize();

  // ── Surface detail (fades in with proximity, on the morph's schedule) ───────
  // Stable, float-precise absolute coordinate (see header): render-space position + renderOrigin mod L.
  const pDetail = positionWorld.add(uDetailPhase);
  // Per-octave weight: tie to the geometry morph (off where geometry collapses to its parent, so the
  // two never fight) AND a distance gate (anti-alias: 0 before the feature drops below a pixel).
  const morphW = mFinal.oneMinus(); // 1 near (full geometry detail) → 0 far (parent)
  const wA = morphW.mul(smoothstep(DETAIL_A_FAR_M, DETAIL_A_NEAR_M, dist));
  const wB = morphW.mul(smoothstep(DETAIL_B_FAR_M, DETAIL_B_NEAR_M, dist));
  // One gradient-noise vec3 per octave (≈[-1,1]³), reused for albedo mottle + normal perturbation.
  const ndA = mx_noise_vec3(pDetail.mul(1 / DETAIL_A_SCALE_M));
  const ndB = mx_noise_vec3(pDetail.mul(1 / DETAIL_B_SCALE_M));

  // Slope material bands. up = per-pixel radial direction (precision-robust: direction of a huge
  // vector). slope=1 where the surface faces straight up (flat) → sand; lower → rock.
  const up = positionWorld.add(uRenderOrigin).normalize();
  const slope = nGeom.dot(up).clamp(0, 1);
  const band = smoothstep(0.55, 0.82, slope);
  const albedo = mix(vec3(...ROCK), vec3(...SAND), band);

  // Albedo mottle: ±detail near, fading to the flat band colour with distance (matches the coarse
  // look you saw from higher up → continuous, no pop).
  const mottle = ndA.x.mul(wA).mul(0.22).add(ndB.x.mul(wB).mul(0.28));
  mat.colorNode = albedo.mul(mottle.add(1));
  // Gentle roughness break-up so the surface doesn't read as one uniform sheen up close.
  mat.roughnessNode = float(0.92).sub(ndB.y.mul(wB).mul(0.08)).clamp(0.4, 1);

  // Normal perturbation: tilt the morph normal by the TANGENTIAL part of the detail noise (remove the
  // along-normal component so it tilts, not inflates), weighted so it vanishes exactly where geometry
  // morphs to the parent. Gives the surface fine relief shading up close, smoothing out with distance.
  const pert = ndA.mul(wA).add(ndB.mul(wB));
  const pertTang = pert.sub(nGeom.mul(pert.dot(nGeom)));
  mat.normalNode = nGeom.add(pertTang.mul(0.2)).normalize();

  // Bias the finer leaf toward the camera so it wins the depth test over a coarser ancestor still
  // retained for the brief moment until purge (surfaces match there, so nothing fights).
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;

  return {
    material: mat,
    kDist: kDist as unknown as { value: number },
    renderOrigin: uRenderOrigin as unknown as { value: Vector3 },
    detailPhase: uDetailPhase as unknown as { value: Vector3 },
  };
}

/** Reduce a world coordinate into [0, DETAIL_PHASE_MOD_M) per axis IN DOUBLE (the float shader can't),
 *  so positionWorld + phase stays small + precise yet continuous through floating-origin recenters. */
export function detailPhaseOf(x: number, y: number, z: number, out: Vector3): void {
  const L = DETAIL_PHASE_MOD_M;
  out.set(x - Math.floor(x / L) * L, y - Math.floor(y / L) * L, z - Math.floor(z / L) * L);
}
