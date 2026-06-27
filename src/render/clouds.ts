// ─────────────────────────────────────────────────────────────────────────────
// Clouds — Phase C: the final Earth signature, a drifting cloud layer.
//
// A semi-transparent sphere at cloud altitude (R + CLOUD_ALT). Coverage is animated fBm of the
// SURFACE DIRECTION (not the swimming render-space position), so the clouds are stable on the globe
// and drift only by the wind term — white swirls over the blue ocean from orbit, a moving ceiling
// from the surface. Lit by the real `_sunDir`: bright white on the day side, dark blue-grey at night,
// warm near the terminator. Drawn after terrain/water and before the sky shell, alpha-blended,
// depth-tested (so terrain below the horizon and the ground occlude it) but not depth-writing.
//
// v1 is a lit cloud SHELL (cheap, reads great from orbit and altitude; flying up punches through the
// layer). Volumetric raymarched clouds are deferred (a 60fps minefield) — a later `?volclouds` upgrade.
//
// Smoothness/precision: a coarse cube-sphere shaded per-fragment with the analytic radial normal and a
// direction-based noise coordinate (normalize of a large vector — robust; the alpha pattern is stable
// through floating-origin recenters, drifting only with the wind clock).
//
// Render-only / cosmetic (master plan §5.8). Cloud params are render consts now; they graduate to
// seed-derived facts (cloudiness by atmosphere class) in a later ring.
// ─────────────────────────────────────────────────────────────────────────────

import { Mesh, BufferGeometry, BufferAttribute, Vector3, NormalBlending } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  vec3,
  vec4,
  uniform,
  positionWorld,
  smoothstep,
  mix,
  mx_noise_vec3,
} from 'three/tsl';
import { buildCubeSphere } from '../core/cubesphere.ts';

const CLOUD_ALT_M = 9_000; // cloud deck altitude (m)
const CLOUD_SUBDIV = 64; // coarse — the puffy pattern is per-fragment noise, not geometry
const COVER_LO = 0.06; // fBm value where cloud starts (lower → more cloud)
const COVER_HI = 0.5; // …and reaches full opacity (soft puffy edges between)
const CLOUD_OPACITY = 0.92; // max alpha of dense cloud
const FREQ_A = 2.6; // base coverage frequency (features across the globe)
const FREQ_B = 7.0; // detail octave
const WIND = 0.006; // drift speed (per second, in noise space)
const DAY_COLOR = [1.0, 1.0, 1.02] as const; // sunlit cloud tops (slightly cool white)
const NIGHT_COLOR = [0.05, 0.07, 0.11] as const; // night clouds (dark blue-grey)
const DUSK_COLOR = [1.0, 0.72, 0.45] as const; // warm tint near the terminator

export interface CloudsHandle {
  readonly mesh: Mesh;
  /** Inertial planet→sun direction. Set `.value` each frame. */
  readonly sunDir: { value: Vector3 };
  /** Scene-space planet centre (= `−_spunOrigin`). Set `.value` each frame. */
  readonly planetCenter: { value: Vector3 };
  /** Drift clock (s, real time). Set `.value` each frame. */
  readonly time: { value: number };
  readonly radius: number;
  dispose(): void;
}

/** Build the cloud layer. `planetRadius` is the terrain's mean radius (m). */
export function createClouds(planetRadius: number): CloudsHandle {
  const radius = planetRadius + CLOUD_ALT_M;
  const s = buildCubeSphere(CLOUD_SUBDIV, radius);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(s.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(s.normals, 3));
  geo.setIndex(new BufferAttribute(s.indices, 1));

  const uSun = uniform(new Vector3(1, 0, 0));
  const uCenter = uniform(new Vector3());
  const uTime = uniform(0);

  const out = Fn(() => {
    const sun = vec3(uSun);
    const dir = positionWorld.sub(uCenter).normalize(); // stable surface direction (drift via wind only)
    const drift = vec3(uTime.mul(WIND), 0, uTime.mul(WIND * 0.6));

    // Two-octave coverage field from the direction (stable on the globe).
    const fA = mx_noise_vec3(dir.mul(FREQ_A).add(drift)).x;
    const fB = mx_noise_vec3(dir.mul(FREQ_B).add(drift.mul(1.7))).x;
    const cover = fA.mul(0.65).add(fB.mul(0.35));
    const alpha = smoothstep(COVER_LO, COVER_HI, cover).mul(CLOUD_OPACITY);

    // Lighting from the real sun: day white, night dark, warm at the terminator.
    const sunUp = dir.dot(sun);
    const day = smoothstep(-0.15, 0.25, sunUp);
    const dusk = smoothstep(0.35, 0.0, sunUp).mul(smoothstep(-0.15, 0.05, sunUp)); // peak near terminator
    const lit = mix(vec3(...NIGHT_COLOR), vec3(...DAY_COLOR), day);
    const color = mix(lit, vec3(...DUSK_COLOR), dusk.mul(0.6));

    return vec4(color, alpha);
  });

  const mat = new MeshBasicNodeMaterial();
  const res = out();
  mat.colorNode = res.xyz;
  mat.opacityNode = res.w;
  mat.transparent = true;
  mat.blending = NormalBlending;
  mat.depthWrite = false;
  mat.depthTest = true; // ground/terrain below the horizon occludes the deck

  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 5; // after terrain/water (0), before the sky shell (10)
  mesh.frustumCulled = false;

  return {
    mesh,
    sunDir: uSun as unknown as { value: Vector3 },
    planetCenter: uCenter as unknown as { value: Vector3 },
    time: uTime as unknown as { value: number },
    radius,
    dispose(): void {
      geo.dispose();
      mat.dispose();
    },
  };
}
