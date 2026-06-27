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
  Fn,
  If,
} from 'three/tsl';

/**
 * CDLOD morph region: a leaf shows full detail until the camera recedes to this fraction of the way
 * from its split distance to its merge (parent) distance, then morphs to the parent surface by the
 * merge distance. Used identically in this TSL graph (per-vertex) and the manager's CPU mirror
 * (`distanceMorph`, for ?lodmorphdebug/?morphcolor). Lower = wider fade band (gentler "always
 * sharpening").
 */
export const MORPH_START_FRAC = 0.3;

/**
 * Birth-ease (ms): a newly-live leaf's morph is floored at 1 (the parent surface it replaces) and decays
 * to its true distance-morph over this long, so the one extra octave a child carries over its parent FADES
 * UP instead of switching on the instant the mesh arrives. With gated incremental refinement
 * (clampCutToReachableFrontier) every leaf now replaces its DIRECT parent (a one-level, single-octave step,
 * never a multi-level jump), so this ease is the final smoothing pass: as the detail front descends one
 * level per generation, each level's octave dissolves in over BIRTH_MS, reading as continuous "getting
 * clearer" rather than discrete arrivals. Lengthened from the old 150 ms now that a cohort is a single
 * level over a SMALL region (so a longer ease is gentle, not the synchronized full-screen "wave" the short
 * value was guarding against), and consecutive generations' eases overlap into one continuous sharpening.
 * Mirrored on the CPU in the manager's centerMorph (same constant, so they stay in lockstep).
 */
export const BIRTH_MS = 500;

// Detail-phase modulus (m): renderOrigin is reduced mod this (in double) so the detail coordinate
// stays small enough for float precision (~1 cm at L=100 km) while tracking the absolute world
// position continuously through every floating-origin recenter. Large enough that a wrap (the only
// time detail could visibly reshuffle) happens at most every L of cumulative origin travel — never
// in a normal fly descent (the origin is fixed per preset), rare in a long walk.
const DETAIL_PHASE_MOD_M = 100_000;

// Procedural detail (ONE octave — the 6 m fine-grain octave was dropped for fill-rate; see the material
// body). Coarse 40 m mottle fades in from ~50 km. Its distance gate (smoothstep far→near) is also its
// anti-alias guard: it reaches 0 before the feature projects below ~1 px, so detail never shimmers. [T] tune.
const DETAIL_A_SCALE_M = 40; // coarse mottle (~40 m features)
export const DETAIL_A_NEAR_M = 1_000;
export const DETAIL_A_FAR_M = 50_000;
// Retained for the manager's [NMS step] gB diagnostic only (the 6 m octave they gated is no longer shaded).
export const DETAIL_B_NEAR_M = 200;
export const DETAIL_B_FAR_M = 6_000;

// ── Aerial perspective (S2) ──────────────────────────────────────────────────
// Haze the surface into the sky with distance: out-scatter DIMS the lit surface (× transmittance),
// in-scatter ADDS the sky's blue as unlit emission. Both scale with the air density along the view ray,
// approximated by the density at the camera (uHazeDensity, ~1 at the surface → 0 at orbit), so the haze
// vanishes from space and the planet reads crisp (only the atmosphere shell's limb remains). The blue
// matches the atmosphere shell so the surface fades into the same colour it sits under.
const HAZE_RAYLEIGH = [0.30, 0.55, 1.0] as const; // same tint as atmosphere.ts
const HAZE_LUMA = 0.5; // inscatter brightness
const HAZE_RATE = 1 / 30_000; // 1/scale (m): at density 1, ~63% hazed by 30 km of view distance
const HAZE_TWILIGHT = 0.1; // day floor so the terminator hazes softly instead of cutting to black

// One archetype's palette (barren): flatter ground reads as light regolith (SAND), steeper faces as
// darker rock. The slope-band smoothstep(lo,hi) maps surface tilt → albedo; a NARROW band + HIGH contrast
// (preset 0) turns tiny normal variation into a high-contrast salt-and-pepper mottle, so these presets let
// us A/B "looks" live via ?slopeband=N and pick one. Cosmetic floats (render-only — NOT canonical, no
// determinism constraint; master plan §5.8), so changing/adding presets has no core/golden impact.
export interface SlopePreset {
  lo: number; // smoothstep start (slope below → full ROCK)
  hi: number; // smoothstep end   (slope above → full SAND)
  rock: readonly [number, number, number];
  sand: readonly [number, number, number];
}
// ── Elevation palette (S3) ───────────────────────────────────────────────────
// A 3rd material tier on top of the slope rock/sand: pale dusty highlands up high, darker regolith down
// low, so the barren palette varies by elevation. Cheap — no noise: a smoothstep on the fragment's radius
// above the mean (reusing the slope `up` vector's magnitude). Always on, so it reads as large-scale
// highland/lowland tinting from orbit AND grounds the surface. Cosmetic (render-only; no determinism).
// NB on "triplanar": the surface detail is isotropic 3D gradient noise (mx_noise_vec3 of the world
// position) — it has no single-axis projection to stretch, so literal 3-axis triplanar would only triple
// the dominant per-fragment noise cost (the very cost S4 must bound) for no visible gain. The elevation
// band is the S3 palette win instead; triplanar is the right tool only if a future 2D-textured archetype
// is added.
const PEAK_COLOR = [0.66, 0.62, 0.55] as const; // pale dusty highlands
const LOW_COLOR = [0.33, 0.27, 0.23] as const; // darker lowland regolith
const PEAK_LO = 0.20; // elevation (× height amplitude) where highlands start to fade in
const PEAK_HI = 0.85; // …and reach full highland colour
const LOW_HI = -0.10; // lowland tint starts fading in as elevation drops below this
const LOW_LO = -0.70; // …and reaches full lowland colour

export const SLOPE_PRESETS: readonly SlopePreset[] = [
  { lo: 0.55, hi: 0.82, rock: [0.40, 0.36, 0.33], sand: [0.62, 0.55, 0.45] }, // 0 current — hard mottle (A/B ref)
  { lo: 0.25, hi: 0.98, rock: [0.40, 0.36, 0.33], sand: [0.62, 0.55, 0.45] }, // 1 wide band — flip → gradient, same colours
  { lo: 0.55, hi: 0.82, rock: [0.47, 0.43, 0.39], sand: [0.57, 0.51, 0.44] }, // 2 low contrast — keeps definition, mutes black/tan
  { lo: 0.30, hi: 0.95, rock: [0.47, 0.43, 0.39], sand: [0.57, 0.51, 0.44] }, // 3 soft — wide + low contrast (gentlest)
];

export interface TerrainMaterialOpts {
  wireframe?: boolean;
  /** ?slopeband=N: index into SLOPE_PRESETS for the slope-band look (default 0 = current). */
  slopePreset?: number;
  /** ?nodetail: build WITHOUT the two per-pixel mx_noise_vec3 (+ mottle + normal perturbation) — a GPU
   *  fill-rate probe / cheap fallback. Geometry morph + slope-band albedo are kept. */
  noDetail?: boolean;
  /** Mean planet radius (m) + terrain height amplitude (m) — shader constants for the S3 elevation
   *  palette band (`(|p|−radius)/heightAmp` ≈ normalized elevation). Constant for the slice's one planet. */
  radius?: number;
  heightAmp?: number;
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
  /** Manager clock (ms). Set `.value` every frame; drives the per-leaf birth-ease floor. */
  now: { value: number };
  /** Inertial planet→sun direction (same `_sunDir` the atmosphere uses). Set `.value` each frame —
   *  gives the aerial-perspective haze a day/night factor that matches the sky. */
  sunDir: { value: Vector3 };
  /** Air density at the camera altitude (0 at orbit → 1 at the surface). Set `.value` each frame;
   *  scales the aerial-perspective haze so it fades to nothing from space. */
  hazeDensity: { value: number };
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
  const uNow = uniform(0); // manager clock (ms), for the per-leaf birth-ease floor
  const uSunDir = uniform(new Vector3(1, 0, 0)); // inertial planet→sun dir (aerial-perspective day factor)
  const uHazeDensity = uniform(0); // air density at the camera altitude (0 orbit → 1 surface); 0 = no haze
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
  const mFactor = smoothstep(e0, dParent, dist); // 0 near (full detail) → 1 far (parent surface)
  // Birth-ease FLOOR: a freshly-live leaf starts at 1 (= the parent it replaced → invisible) and
  // decays to its distance-morph over BIRTH_MS, so a late arrival (mFactor already ≈0) fades up
  // instead of snapping. aBirthMs is constant per leaf (set at upload = the go-live clock).
  const birthMs = float(attribute<'float'>('aBirthMs', 'float'));
  const birthFloor = uNow.sub(birthMs).div(BIRTH_MS).clamp(0, 1).oneMinus();
  const mFinal = mFactor.max(birthFloor); // 0 near (full) → 1 far (parent), floored while fresh

  // Geometry: lerp full detail → the one-octave-coarser parent surface by distance.
  mat.positionNode = mix(positionLocal, attribute('morphTarget', 'vec3'), mFinal);
  // The morph-blended surface normal (shade in lockstep so a leaf collapsed to its parent also
  // shades like the parent — no bright "textured square"). Reused below as the base for detail.
  const nGeom = mix(
    attribute('normal', 'vec3'),
    attribute('morphTargetNormal', 'vec3'),
    mFinal,
  ).normalize();

  // Slope material bands (always). r = the fragment's inertial position (precision-robust as a direction);
  // reused for both the radial `up` and the elevation band below. slope=1 where the surface faces straight
  // up (flat) → sand; lower → rock.
  const r = positionWorld.add(uRenderOrigin);
  const up = r.normalize();
  const slope = nGeom.dot(up).clamp(0, 1);
  const sb = SLOPE_PRESETS[Math.min(Math.max((opts.slopePreset ?? 0) | 0, 0), SLOPE_PRESETS.length - 1)]!;
  const band = smoothstep(sb.lo, sb.hi, slope);
  const slopeAlbedo = mix(vec3(...sb.rock), vec3(...sb.sand), band);

  // Elevation palette band (S3): blend the slope albedo toward darker lowland / paler highland by the
  // fragment's normalized height above the mean radius. Cheap (one length + two smoothsteps); always on.
  const radius = opts.radius ?? 0;
  const heightAmp = opts.heightAmp ?? 1;
  const elev = r.length().sub(radius).div(heightAmp); // ≈ [-1, 1] (surface = R + fBm·height)
  const lowW = smoothstep(LOW_HI, LOW_LO, elev); // 1 in deep valleys → 0 above LOW_HI
  const peakW = smoothstep(PEAK_LO, PEAK_HI, elev); // 0 below PEAK_LO → 1 high up
  const albedo = mix(mix(slopeAlbedo, vec3(...LOW_COLOR), lowW), vec3(...PEAK_COLOR), peakW);

  if (opts.noDetail) {
    // GPU fill-rate probe / cheap fallback: no procedural detail at all (the two mx_noise_vec3, the mottle,
    // and the normal perturbation are NOT in the compiled shader). Just the morph normal + slope-band albedo.
    mat.colorNode = albedo;
    mat.roughnessNode = float(0.92);
    mat.normalNode = nGeom;
  } else {
    // ── Surface detail (fades in with proximity, on the morph's schedule) ───────
    // ONE octave only (the fine 6 m octave was dropped — it only shows within ~6 km, rarely on screen).
    // Stable, float-precise absolute coordinate (see header): render-space position + renderOrigin mod L.
    const pDetail = positionWorld.add(uDetailPhase);
    // Weight: tie to the geometry morph (off where geometry collapses to its parent, so the two never fight)
    // AND a distance gate (anti-alias: 0 before the feature drops below a pixel).
    const morphW = mFinal.oneMinus(); // 1 near (full geometry detail) → 0 far (parent)
    const wA = morphW.mul(smoothstep(DETAIL_A_FAR_M, DETAIL_A_NEAR_M, dist));
    // One gradient-noise vec3 (≈[-1,1]³), reused for albedo mottle + normal perturbation — but the
    // mx_noise_vec3 is the dominant per-fragment fill-rate cost (?nodetail was buttery) and at orbit/altitude
    // its weight wA is 0, so evaluating it there is pure wasted fill. Gate it behind a per-fragment branch:
    // a Fn establishes the build stack If() needs (calling If during top-level material construction has no
    // stack → the earlier "Cannot read properties of null (reading 'If')"), and the compiler emits a REAL
    // WGSL `if`, so the noise is genuinely SKIPPED where wA≈0 — not hoisted. The branch is coherent per-leaf
    // (wA is a distance/morph function, ~constant across a leaf), so GPU divergence is negligible. Returns 0
    // when skipped, matching the ×wA≈0 contribution it would otherwise have produced.
    const ndA = Fn(() => {
      const out = vec3(0).toVar();
      If(wA.greaterThan(0.001), () => {
        out.assign(mx_noise_vec3(pDetail.mul(1 / DETAIL_A_SCALE_M)));
      });
      return out;
    })();

    // Albedo mottle: ±detail near, fading to the flat band colour with distance.
    const mottle = ndA.x.mul(wA).mul(0.22);
    mat.colorNode = albedo.mul(mottle.add(1));
    // Gentle roughness break-up so the surface doesn't read as one uniform sheen up close.
    mat.roughnessNode = float(0.92).sub(ndA.y.mul(wA).mul(0.06)).clamp(0.4, 1);

    // Normal perturbation: tilt the morph normal by the TANGENTIAL part of the detail noise (remove the
    // along-normal component so it tilts, not inflates), weighted so it vanishes where geometry morphs to
    // the parent. Gives fine relief shading up close, smoothing out with distance.
    const pert = ndA.mul(wA);
    const pertTang = pert.sub(nGeom.mul(pert.dot(nGeom)));
    mat.normalNode = nGeom.add(pertTang.mul(0.3)).normalize();
  }

  // ── Aerial perspective (S2): haze the surface into the atmosphere ────────────
  // Composite over whatever colour the branch above produced: out-scatter dims the lit surface (×
  // transmittance = 1−hazeFrac), in-scatter ADDS the sky blue as EMISSIVE (unlit — so the haze doesn't
  // pick up the surface normal/shadow, it just sits in front like air). hazeFrac grows with view distance
  // × air density; uHazeDensity → 0 at orbit makes the whole effect vanish from space (crisp planet, only
  // the shell's limb). Reuses the morph `dist` + slope `up` (no extra noise tap). dayFactor matches the
  // shell's day term so ground haze and sky agree at the horizon.
  const surfaceColor = mat.colorNode!; // the lit albedo set by the noDetail/detail branch above
  const hazeFrac = dist.mul(uHazeDensity).mul(HAZE_RATE).negate().exp().oneMinus().clamp(0, 1);
  const dayFactor = up.dot(uSunDir).max(0).mul(1 - HAZE_TWILIGHT).add(HAZE_TWILIGHT);
  mat.colorNode = surfaceColor.mul(hazeFrac.oneMinus());
  mat.emissiveNode = vec3(...HAZE_RAYLEIGH).mul(HAZE_LUMA).mul(dayFactor).mul(hazeFrac);

  // Bias the finer leaf toward the camera so it wins the depth test over a coarser ancestor still
  // retained for the brief moment until purge (surfaces match there, so nothing fights). NOT in wireframe:
  // WebGPU rejects a non-zero depthBias on LineList topology (the ?wire pipeline errors out otherwise).
  if (!opts.wireframe) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;
  }

  return {
    material: mat,
    kDist: kDist as unknown as { value: number },
    renderOrigin: uRenderOrigin as unknown as { value: Vector3 },
    detailPhase: uDetailPhase as unknown as { value: Vector3 },
    now: uNow as unknown as { value: number },
    sunDir: uSunDir as unknown as { value: Vector3 },
    hazeDensity: uHazeDensity as unknown as { value: number },
  };
}

/** Reduce a world coordinate into [0, DETAIL_PHASE_MOD_M) per axis IN DOUBLE (the float shader can't),
 *  so positionWorld + phase stays small + precise yet continuous through floating-origin recenters. */
export function detailPhaseOf(x: number, y: number, z: number, out: Vector3): void {
  const L = DETAIL_PHASE_MOD_M;
  out.set(x - Math.floor(x / L) * L, y - Math.floor(y / L) * L, z - Math.floor(z / L) * L);
}
