// ─────────────────────────────────────────────────────────────────────────────
// Ocean — Phase O: a blue water world that turns the barren planet Earth-like.
//
// A single sphere at sea level (R + SEA_LEVEL_M). It's OPAQUE and depth-tested, so the
// land/sea split falls out of depth sorting for free: where the terrain rises above sea
// level the terrain (larger radius) wins and shows land; where it dips below, the water
// sphere wins and shows ocean. The coastline is exactly where the terrain crosses sea level.
//
// The water look (unlit MeshBasic, all shading done in the node so it isn't double-lit):
//   • Fresnel: deep water colour at steep angles → reflected sky at grazing angles (the classic
//     "dark below you, bright at the horizon" water look). The reflected sky is an analytic
//     gradient that matches the atmosphere palette (a sky-view-LUT tap replaces it later).
//   • Sun glint: a tight specular toward the real `_sunDir` (the bright streak in the photos).
//   • Wave normals: a little scrolling gradient noise breaks the radial normal so the glint
//     sparkles and the surface isn't a mirror.
//   • Day/night: the water darkens past the terminator (radial-up · sun).
//
// Smoothness without tessellation cost: the geometry is a COARSE cube-sphere, but shading uses
// the per-fragment ANALYTIC radial normal (normalize(positionWorld − planetCentre)), so over the
// few km visible near the player the ocean reads as a flat, smooth plane (planet curvature is
// negligible there) regardless of facet size.
//
// PRECISION: like the atmosphere, the planet centre is ~R away in scene space; we only ever take
// DIRECTIONS (normalize) of large vectors (robust) and never their squared magnitude. The wave
// noise uses scene-space positionWorld (it animates anyway, so a slow swim through recenters is
// invisible).
//
// Render-only / cosmetic (master plan §5.8). Sea level is a render const now; it graduates to a
// seed-derived fact (ocean coverage) in a later ring. Buoyancy/swimming is deferred — the spawn is
// kept on land (sea level is clamped below the spawn's terrain).
// ─────────────────────────────────────────────────────────────────────────────

import { Mesh, BufferGeometry, BufferAttribute, Vector3, FrontSide } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  uniform,
  positionWorld,
  cameraPosition,
  reflect,
  mix,
  pow,
  max,
  smoothstep,
  mx_noise_vec3,
} from 'three/tsl';
import { buildCubeSphere } from '../core/cubesphere.ts';

const OCEAN_SUBDIV = 64; // coarse — per-fragment analytic normal keeps it smooth near the player
// Water palette ([T] cosmetic). Deep = near-black blue-green; sky reflection = atmosphere-matching blue.
const DEEP = [0.012, 0.045, 0.075] as const;
const SKY_HORIZON = [0.52, 0.66, 0.82] as const; // pale horizon sky (reflected at grazing angles)
const SKY_ZENITH = [0.12, 0.30, 0.62] as const; // deeper overhead sky (reflected near vertical)
const SUN_GLINT = [1.0, 0.95, 0.82] as const;
const F0 = 0.02; // water reflectance at normal incidence
const GLINT_SHARP = 380; // specular exponent (tight, bright sun streak)
const WAVE_SCALE_M = 60; // wave feature size (m)
const WAVE_AMP = 0.06; // normal perturbation strength
const WAVE_SPEED = 0.04; // scroll speed

export interface OceanHandle {
  readonly mesh: Mesh;
  /** Inertial planet→sun direction. Set `.value` each frame. */
  readonly sunDir: { value: Vector3 };
  /** Scene-space planet centre (= `−_spunOrigin`). Set `.value` each frame (for the radial normal). */
  readonly planetCenter: { value: Vector3 };
  /** Wave clock (s, real time). Set `.value` each frame. */
  readonly time: { value: number };
  /** Sea-level radius (m) — concentric with the terrain; used by the caller for spawn-dry checks. */
  readonly seaLevelR: number;
  dispose(): void;
}

/** Build the ocean. `seaLevelR` is the sea-surface radius (m) — keep it below the spawn's terrain. */
export function createOcean(seaLevelR: number): OceanHandle {
  const s = buildCubeSphere(OCEAN_SUBDIV, seaLevelR);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(s.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(s.normals, 3));
  geo.setIndex(new BufferAttribute(s.indices, 1));

  const uSun = uniform(new Vector3(1, 0, 0));
  const uCenter = uniform(new Vector3());
  const uTime = uniform(0);

  const color = Fn(() => {
    const sun = vec3(uSun);
    // Analytic radial up at this fragment (smooth regardless of tessellation).
    const N0 = positionWorld.sub(uCenter).normalize();
    const view = cameraPosition.sub(positionWorld).normalize();

    // Wave normal: perturb the radial normal by the tangential part of a scrolling noise vector.
    const p = positionWorld.mul(1 / WAVE_SCALE_M).add(vec3(uTime.mul(WAVE_SPEED), 0, uTime.mul(WAVE_SPEED * 0.7)));
    const nz = mx_noise_vec3(p);
    const tang = nz.sub(N0.mul(nz.dot(N0))); // remove along-normal part → tilt, not inflate
    const N = N0.add(tang.mul(WAVE_AMP)).normalize();

    // Fresnel (Schlick): deep at steep angles, sky at grazing.
    const fres = float(F0).add(float(1 - F0).mul(pow(max(float(1).sub(max(view.dot(N), 0)), 0), 5)));

    // Reflected-sky colour: analytic gradient by the reflected ray's up-ness (matches the atmosphere
    // palette; a sky-view-LUT tap replaces this later). reflect(incident, N), incident = −view.
    const refl = reflect(view.negate(), N);
    const upness = max(refl.dot(N0), 0); // 0 toward horizon → 1 straight up
    const skyRefl = mix(vec3(...SKY_HORIZON), vec3(...SKY_ZENITH), upness);

    // Day/night + sun diffuse on the deep colour.
    const sunUp = N0.dot(sun);
    const day = smoothstep(-0.1, 0.25, sunUp);
    const deepLit = vec3(...DEEP).mul(day.mul(0.85).add(0.15));

    // Sun glint: tight specular of the reflected ray toward the sun (only on the lit side).
    const glint = pow(max(refl.dot(sun), 0), GLINT_SHARP).mul(day);

    return mix(deepLit, skyRefl.mul(day.mul(0.7).add(0.3)), fres)
      .add(vec3(...SUN_GLINT).mul(glint));
  });

  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = color();
  mat.side = FrontSide; // seen from above (on land / from orbit); underwater view is deferred

  const mesh = new Mesh(geo, mat);
  mesh.frustumCulled = false; // huge sphere, camera often inside its bounds

  return {
    mesh,
    sunDir: uSun as unknown as { value: Vector3 },
    planetCenter: uCenter as unknown as { value: Vector3 },
    time: uTime as unknown as { value: number },
    seaLevelR,
    dispose(): void {
      geo.dispose();
      mat.dispose();
    },
  };
}
