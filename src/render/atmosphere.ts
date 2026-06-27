// ─────────────────────────────────────────────────────────────────────────────
// Atmosphere — Step 6 (S1): the planet's sky, in one shared shell (render side).
//
// A single planet-centered shell at `planetRadius · ATM_SCALE` whose TSL colour is a
// cheap analytic single-scatter approximation (Rayleigh blue + horizon/limb brightening
// + a Mie forward-glow halo around the sun). One mesh, additive, depth-tested but not
// depth-writing, drawn after the terrain — so it serves BOTH views with the same shader:
//
//   • From orbit  → a thin glowing blue limb wrapping the planet against black, brightest
//                   on the sunlit crescent (the near hemisphere over the disc adds a faint
//                   blue haze; the far hemisphere is occluded by the terrain depth).
//   • From the surface → blue sky overhead, brightening toward the horizon, with a warm
//                   halo around the sun; the part below the horizon is occluded by terrain.
//
// Why a planet-centered shell (not a camera dome): it is the real geometry, so the
// orbit limb falls out for free and it shrinks to a dot correctly as you fly away (no
// altitude-fade hack). The cost is that the shell is real-scale, so the shell's far
// extent must be inside `camera.far` in EVERY mode — the caller extends the far plane
// to reach it (log depth keeps the surface crisp across the range).
//
// Precision (master plan Part 4): the shell is placed at scene `−spunOrigin` (the planet
// centre in the floating-origin/scene frame, same as the Sun/Moon bodies). `positionWorld`
// and `cameraPosition` in the shader are scene-space floats (small near the camera), so the
// view direction is float-precise; `normalWorld` is the shell's outward radial direction in
// the inertial frame (the shell is not spun), matching `_sunDir` (also inertial) directly.
//
// Render-only / cosmetic (master plan §5.8): no canonical values, no determinism constraint.
// Analytic closed-form first; the precomputed Rayleigh+Mie LUT (design §5.7) is a later
// upgrade only if this isn't rich enough.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Mesh,
  BufferGeometry,
  BufferAttribute,
  Vector3,
  AdditiveBlending,
  BackSide,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  uniform,
  vec3,
  float,
  positionWorld,
  cameraPosition,
  normalWorld,
} from 'three/tsl';
import { buildCubeSphere } from '../core/cubesphere.ts';

// Shell radius as a fraction of the planet radius. 1.025 ≈ a 159 km rim at Earth scale —
// thicker than the real ~100 km Karman line so the limb reads clearly from orbit, still
// thin enough that the surface sky sits believably overhead. [T] cosmetic.
const ATM_SCALE = 1.025;
// Cube-sphere subdivision per face. The colour is a smooth view-direction gradient, so a
// coarse shell is plenty; 32 keeps the silhouette round at the limb without geometry cost.
const ATM_SUBDIV = 32;

// Rayleigh tint (sky blue) and a warm Mie/sun tint for the forward-glow halo.
const RAYLEIGH = [0.30, 0.55, 1.0] as const;
const SUN_TINT = [1.0, 0.94, 0.82] as const;
// Look knobs (all cosmetic, tuned by screenshot):
const LIMB_POWER = 2.0; // higher → tighter, brighter rim/horizon line
const BASE_SKY = 0.18; // ambient sky brightness across the lit hemisphere (keeps the zenith from going black)
const LIMB_GAIN = 1.0; // how much the limb/horizon adds over the base
const SKY_STRENGTH = 1.1; // overall Rayleigh sky brightness
const GLOW_POWER = 8.0; // Mie forward-scatter sharpness (higher → tighter sun halo)
const GLOW_STRENGTH = 0.7; // overall sun-halo brightness
const TWILIGHT = 0.15; // floor on the day term so the terminator softens instead of hard-cutting to night

export interface AtmosphereHandle {
  /** The single shared atmosphere mesh — add to the scene; position it at the planet centre each frame. */
  readonly mesh: Mesh;
  /** Inertial planet→sun direction (scene == inertial for the unspun shell). Set `.value` each frame. */
  readonly sunDir: { value: Vector3 };
  /** Scene-space radius of the shell's farthest point — the caller extends `camera.far` to at least this. */
  readonly radius: number;
  dispose(): void;
}

/** Build the planet's atmosphere shell. `planetRadius` is the terrain's mean radius (m). */
export function createAtmosphere(planetRadius: number): AtmosphereHandle {
  const radius = planetRadius * ATM_SCALE;
  const s = buildCubeSphere(ATM_SUBDIV, radius);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(s.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(s.normals, 3));
  geo.setIndex(new BufferAttribute(s.indices, 1));

  const uSun = uniform(new Vector3(1, 0, 0));

  // View ray from camera to this shell fragment (scene space → float-precise near the camera).
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const n = normalWorld; // shell outward radial (inertial frame), matches uSun directly

  // Limb / horizon: bright where the view grazes the shell (planet limb from orbit, horizon
  // from the surface), dim where you look straight through it. |v·n|→1 head-on, →0 at the limb.
  const limb = viewDir.dot(n).abs().oneMinus().pow(LIMB_POWER);
  // Day/night: only the sunlit hemisphere scatters; a twilight floor softens the terminator.
  const day = n.dot(uSun).max(0.0).mul(float(1).sub(TWILIGHT)).add(TWILIGHT);
  // Mie forward-glow halo around the sun (looking toward the sun through the air).
  const glow = viewDir.dot(uSun).max(0.0).pow(GLOW_POWER);

  // Base sky across the lit hemisphere + limb/horizon brightening, all gated by day.
  const skyI = float(BASE_SKY).add(limb.mul(LIMB_GAIN)).mul(day).mul(SKY_STRENGTH);
  const haloI = glow.mul(day).mul(GLOW_STRENGTH);

  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = vec3(...RAYLEIGH).mul(skyI).add(vec3(...SUN_TINT).mul(haloI));
  mat.transparent = true;
  mat.blending = AdditiveBlending;
  mat.depthWrite = false; // additive glow: never occlude other things via depth
  mat.depthTest = true; // BUT respect terrain depth → far hemisphere/below-horizon is occluded
  mat.side = BackSide; // render the inside of the shell: correct from both inside (surface) and outside (orbit, see-through near face)

  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 1; // after terrain, so the additive glow lays over the lit surface (subtle aerial preview)
  mesh.frustumCulled = false; // real-scale + recentered each frame; cheap to always draw

  return {
    mesh,
    sunDir: uSun as unknown as { value: Vector3 },
    radius,
    dispose(): void {
      geo.dispose();
      mat.dispose();
    },
  };
}
