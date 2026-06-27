// ─────────────────────────────────────────────────────────────────────────────
// Atmosphere — Step 6 redux (Stage A): a REAL soft-limb sky, not a hard-edged shell.
//
// The previous version was a thin shell at R*1.025 with a grazing-angle (Fresnel) term:
// its contribution dropped to nothing at the triangle silhouette → a ring with a HARD
// EDGE. Real air has no geometric boundary: the limb is the in-scatter × transmittance
// integral along the actual view chord through exponentially-thinning density, so as the
// ray's closest approach rises the air column shrinks SMOOTHLY to zero and the glow fades
// into space. This module ray-marches that integral analytically (single scatter:
// Rayleigh + Mie + ozone), so the edge becomes a soft gradient set by the scale heights.
//
// Geometry: a BackSide sphere at the atmosphere TOP (R + ATM_THICKNESS). BackSide gives
// exactly one fragment per pixel from BOTH inside (surface → the dome around you) and
// outside (orbit → the far face on the limb ring beyond the planet silhouette); the march
// is fully analytic (ray-vs-sphere from camera), so it's correct regardless of which face
// generated the fragment. The glow fades to alpha 0 before the Rtop silhouette, so the
// shell's own edge is invisible — no hard edge.
//
// PRECISION (master plan Part 4): the planet centre sits ~R (6,371 km) away in scene space,
// so a naive ray-vs-sphere (b = dot(oc,d); c = |oc|²−r²) catastrophically cancels in float32.
// We avoid it: the CPU feeds the camera's true altitude `h` (double → uCamAlt) and radial
// `up` (uUp); per-sample altitude is computed as (ρ²−R²)/(ρ+R) with the numerator built from
// `h` directly (never |oc|²−R²), and the sphere `c` terms use h·(2R+h) — all cancellation-free.
// View direction is `normalize(positionWorld − cameraPosition)` (small scene-space floats).
//
// Render-only (master plan §5.8): cosmetic, no determinism constraint. This is the analytic
// path (always on for now / `?atmonolut`); the precomputed LUT (design §5.7) is the next stage
// and will slot in behind the same uniforms.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Mesh,
  BufferGeometry,
  BufferAttribute,
  Vector3,
  BackSide,
  NormalBlending,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  Loop,
  float,
  vec3,
  vec4,
  uniform,
  positionWorld,
  cameraPosition,
  smoothstep,
  exp,
} from 'three/tsl';
import { buildCubeSphere } from '../core/cubesphere.ts';

// ── "Breathable" (Earth-like) preset — Bruneton coefficients, per-metre, metres. ──
// Tuned for real blue sky + white horizon + sunset reddening. [T] cosmetic (Stage E locks these).
const ATM_THICKNESS_M = 100_000; // atmosphere top = R + 100 km (generous so the limb reads)
const HR = 8_000; // Rayleigh scale height (m)
const HM = 1_200; // Mie scale height (m)
const BETA_R: readonly [number, number, number] = [5.802e-6, 13.558e-6, 33.1e-6]; // Rayleigh scatter=extinction
const BETA_M_SCAT = 3.996e-6; // Mie scattering
const BETA_M_EXT = 4.4e-6; // Mie extinction (scatter + a little absorption)
const MIE_G = 0.8; // Mie anisotropy (forward sun glow)
const BETA_OZ: readonly [number, number, number] = [0.65e-6, 1.881e-6, 0.085e-6]; // ozone absorption
const OZ_CENTER = 25_000; // ozone tent centre (m)
const OZ_WIDTH = 15_000; // ozone tent half-width (m)
const SUN_INTENSITY = 40; // HDR sun illuminance (one brightness knob; ACESFilmic, exposure 1.0) [Stage E tunes]
const PRIMARY_STEPS = 16; // view-ray march samples (analytic sun transmittance → no nested loop)
const ATM_SUBDIV = 24; // shell tessellation (round silhouette; the colour is per-pixel ray math)

export interface AtmosphereHandle {
  /** The sky shell mesh — add to the scene; position at the planet centre (scene `−_spunOrigin`) each frame. */
  readonly mesh: Mesh;
  /** Inertial planet→sun direction (unit). Set `.value` each frame. */
  readonly sunDir: { value: Vector3 };
  /** Camera radial "up" (unit, scene space = normalize(cameraScenePos − planetCentre)). Set each frame. */
  readonly planetUp: { value: Vector3 };
  /** Camera altitude above the mean radius (m, double-precise from the CPU). Set each frame. */
  readonly camAlt: { value: number };
  /** Scene-space radius of the shell (atmosphere top) — the caller extends `camera.far` to reach it. */
  readonly radius: number;
  dispose(): void;
}

/** Build the soft-limb sky. `planetRadius` is the terrain's mean radius (m). */
export function createAtmosphere(planetRadius: number): AtmosphereHandle {
  const Rtop = planetRadius + ATM_THICKNESS_M;
  const s = buildCubeSphere(ATM_SUBDIV, Rtop);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(s.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(s.normals, 3));
  geo.setIndex(new BufferAttribute(s.indices, 1));

  const uSun = uniform(new Vector3(1, 0, 0));
  const uUp = uniform(new Vector3(0, 1, 0));
  const uCamAlt = uniform(0);

  // Shader constants (preset baked in for the analytic path).
  const R = float(planetRadius);
  const T = float(ATM_THICKNESS_M);
  const betaR = vec3(BETA_R[0], BETA_R[1], BETA_R[2]);
  const betaMe = vec3(BETA_M_EXT, BETA_M_EXT, BETA_M_EXT);
  const betaMs = vec3(BETA_M_SCAT, BETA_M_SCAT, BETA_M_SCAT);
  const betaOz = vec3(BETA_OZ[0], BETA_OZ[1], BETA_OZ[2]);

  // Per-channel exp for a vec3 optical depth → transmittance (TSL `exp` is typed float-only).
  const expVec = (v: { x: unknown; y: unknown; z: unknown }) =>
    vec3(exp(v.x as never), exp(v.y as never), exp(v.z as never));

  // The whole sky in one Fn → a vec4 (rgb in-scatter, a = 1−viewTransmittance). Called once;
  // colorNode/opacityNode reference its components so the march compiles ONCE.
  const sky = Fn(() => {
    const h = float(uCamAlt).max(0); // camera altitude (clamped ≥ sea level)
    const r0 = h.add(R); // camera distance from planet centre
    const d = positionWorld.sub(cameraPosition).normalize(); // per-pixel view ray (scene-space floats)
    const up = vec3(uUp);
    const sun = vec3(uSun);

    const b = up.dot(d).mul(r0); // = dot(oc, d), oc = up·r0 (cancellation-free)
    const c_p = h.mul(R.mul(2).add(h)); // planet sphere: r0²−R² = h(2R+h)
    const c_a = h.sub(T).mul(R.mul(2).add(h).add(T)); // atmosphere sphere: r0²−Rtop²

    // Entry/exit along the ray for the atmosphere sphere; clip to in-front and to the planet.
    const discA = b.mul(b).sub(c_a).max(0);
    const sA = discA.sqrt();
    const tStart = b.negate().sub(sA).max(0); // near atmosphere root, clamped ≥ 0
    const tExit = b.negate().add(sA); // far atmosphere root
    const discP = b.mul(b).sub(c_p);
    const sP = discP.max(0).sqrt();
    const tPlanet = b.negate().sub(sP); // near planet root (surface)
    const hitsPlanet = discP.greaterThan(0).and(tPlanet.greaterThan(tStart));
    const tEnd = hitsPlanet.select(tPlanet, tExit);
    const segLen = tEnd.sub(tStart).max(0);
    const stepLen = segLen.div(PRIMARY_STEPS);

    // Per-pixel phase functions (cosθ between view and sun).
    const cosT = d.dot(sun);
    const phaseR = float(0.0596831).mul(cosT.mul(cosT).add(1)); // 3/(16π)(1+cos²)
    const g = float(MIE_G);
    const g2 = g.mul(g);
    const denom = g2.add(1).sub(g.mul(2).mul(cosT)).max(1e-4).pow(1.5);
    const phaseM = float(0.0796).mul(g2.oneMinus()).div(denom); // 1/(4π)(1−g²)/(1+g²−2g cosθ)^1.5

    const odR = float(0).toVar(); // accumulated VIEW optical depths
    const odM = float(0).toVar();
    const odO = float(0).toVar();
    const inscat = vec3(0).toVar();
    const transView = vec3(1).toVar(); // running view transmittance (updated each step)

    Loop(PRIMARY_STEPS, ({ i }) => {
      const t = tStart.add(stepLen.mul(float(i).add(0.5)));
      // Altitude at the sample (cancellation-free): a = (h(2R+h) + 2tb + t²)/(ρ+R).
      const num = c_p.add(b.mul(2).mul(t)).add(t.mul(t));
      const rho = r0.mul(r0).add(b.mul(2).mul(t)).add(t.mul(t)).sqrt();
      const a = num.div(rho.add(R)).max(0);
      const dR = a.div(-HR).exp();
      const dM = a.div(-HM).exp();
      const dO = a.sub(OZ_CENTER).abs().div(OZ_WIDTH).oneMinus().max(0); // tent

      // VIEW transmittance to this sample (accumulate optical depth, then exp).
      odR.addAssign(dR.mul(stepLen));
      odM.addAssign(dM.mul(stepLen));
      odO.addAssign(dO.mul(stepLen));
      const tauV = betaR.mul(odR).add(betaMe.mul(odM)).add(betaOz.mul(odO));
      transView.assign(expVec(tauV.negate()));

      // SUN transmittance (analytic vertical column × airmass — no nested march). Column above
      // altitude a for scale height H is H·exp(−a/H); ozone column ≈ βO·dO·width. Airmass = 1/cosSun.
      const upS = up.mul(r0).add(d.mul(t)).normalize(); // radial up AT the sample
      const cosSun = upS.dot(sun);
      const airmass = float(1).div(cosSun.max(0.05));
      const colR = betaR.mul(HR).mul(dR);
      const colM = betaMe.mul(HM).mul(dM);
      const colO = betaOz.mul(dO).mul(OZ_WIDTH);
      const tauS = colR.add(colM).add(colO).mul(airmass);
      const sunVis = smoothstep(-0.1, 0.1, cosSun); // fade to 0 past the terminator (no light from below)
      const transSun = expVec(tauS.negate()).mul(sunVis);

      // In-scatter at the sample = viewT · sunT · (βR·dR·phaseR + βMs·dM·phaseM) · stepLen.
      const scat = betaR.mul(dR).mul(phaseR).add(betaMs.mul(dM).mul(phaseM));
      inscat.addAssign(transView.mul(transSun).mul(scat).mul(stepLen));
    });

    const color = inscat.mul(SUN_INTENSITY);
    // Alpha = how much the air occludes space behind it (1 at the bright horizon → 0 at the soft
    // top), so the limb fades into space and the sun disc shows through thin air. Use luminance.
    const alpha = transView.dot(vec3(0.2126, 0.7152, 0.0722)).oneMinus().clamp(0, 1);
    return vec4(color, alpha);
  });

  const mat = new MeshBasicNodeMaterial();
  const res = sky(); // build the march ONCE; reference its components below
  mat.colorNode = res.xyz;
  mat.opacityNode = res.w;
  mat.transparent = true;
  mat.blending = NormalBlending; // alpha-over: sky occludes space + the sun disc shows through thin air
  mat.depthWrite = false;
  mat.depthTest = true; // terrain/water/clouds in front occlude the sky
  mat.side = BackSide; // one fragment/pixel from inside (dome) and outside (limb ring)

  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 10; // after opaque terrain/water and the cloud layer
  mesh.frustumCulled = false;

  return {
    mesh,
    sunDir: uSun as unknown as { value: Vector3 },
    planetUp: uUp as unknown as { value: Vector3 },
    camAlt: uCamAlt as unknown as { value: number },
    radius: Rtop,
    dispose(): void {
      geo.dispose();
      mat.dispose();
    },
  };
}
