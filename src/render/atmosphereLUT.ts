// ─────────────────────────────────────────────────────────────────────────────
// Atmosphere LUTs — Phase L (Stage B+): precomputed scattering tables (design §5.7).
//
// The analytic sky (atmosphere.ts) ray-marches single-scatter per pixel — correct but it
// approximates the SUN transmittance with an airmass term and pays a full march on every sky
// pixel. The design's target is to precompute scattering into LUTs and sample them cheaply.
//
// This module owns the LUTs and renders them with fullscreen QuadMesh passes into HalfFloat
// RenderTargets (portable across the WebGPU and WebGL2 backends — no compute/storage textures,
// which the headless software renderer can't run). Stage B ships the TRANSMITTANCE LUT: T(altitude,
// sun-cos) = the fraction of sunlight reaching a point, RGB. The sky march samples it for the sun
// term instead of the airmass approximation → physically-correct extinction + sunset reddening.
//
// REAL-GPU GATE: HalfFloat render-target filtering may be unavailable under software WebGPU / WebGL2.
// The atmosphere keeps its analytic path (`?atmonolut`) as the fallback, so the look never depends on
// the LUT rendering; this module only has to not crash headless.
//
// Precision: the LUT is parameterised by altitude h (0..thickness) directly, so optical-depth math
// uses h (never |p|²−R²) — the same cancellation-free form as the sky march.
// ─────────────────────────────────────────────────────────────────────────────

import {
  RenderTarget,
  HalfFloatType,
  RGBAFormat,
  LinearFilter,
  ClampToEdgeWrapping,
} from 'three';
import { QuadMesh, MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import { Fn, float, vec3, vec4, screenUV, Loop, exp } from 'three/tsl';
import {
  ATM_THICKNESS_M,
  HR,
  HM,
  BETA_R,
  BETA_M_EXT,
  BETA_OZ,
  OZ_CENTER,
  OZ_WIDTH,
} from './atmosphere.ts';

const TRANS_W = 256;
const TRANS_H = 64;
const TRANS_STEPS = 40; // optical-depth march steps (one-time cost)

export interface AtmosphereLUT {
  /** Transmittance LUT render target — sample `.texture` with uv = (sunCos*0.5+0.5, sqrt(alt/thickness)). */
  readonly transmittance: RenderTarget;
  /** Render the static LUT(s). Call once after `renderer.init()` (and on any preset change). */
  build(renderer: WebGPURenderer): void;
  dispose(): void;
}

/** Build the atmosphere LUTs for a planet of mean radius `planetRadius` (m). */
export function createAtmosphereLUT(planetRadius: number): AtmosphereLUT {
  const trans = new RenderTarget(TRANS_W, TRANS_H, {
    type: HalfFloatType,
    format: RGBAFormat,
    depthBuffer: false,
  });
  trans.texture.minFilter = LinearFilter;
  trans.texture.magFilter = LinearFilter;
  trans.texture.wrapS = ClampToEdgeWrapping;
  trans.texture.wrapT = ClampToEdgeWrapping;

  const R = float(planetRadius);
  const T = float(ATM_THICKNESS_M);
  const betaR = vec3(BETA_R[0], BETA_R[1], BETA_R[2]);
  const betaMe = vec3(BETA_M_EXT, BETA_M_EXT, BETA_M_EXT);
  const betaOz = vec3(BETA_OZ[0], BETA_OZ[1], BETA_OZ[2]);
  const expVec = (v: { x: unknown; y: unknown; z: unknown }) =>
    vec3(exp(v.x as never), exp(v.y as never), exp(v.z as never));

  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const uv = screenUV;
    const h = uv.y.mul(uv.y).mul(T); // altitude (packed near the ground)
    const mu = uv.x.mul(2).sub(1); // cos(view/sun zenith), −1..1
    const r0 = h.add(R);
    const b = r0.mul(mu); // dot(up·r0, dir)
    const cP = h.mul(R.mul(2).add(h)); // r0²−R²
    const cA = h.sub(T).mul(R.mul(2).add(h).add(T)); // r0²−Rtop²
    const tTop = b.negate().add(b.mul(b).sub(cA).max(0).sqrt()); // exit at the atmosphere top
    const discP = b.mul(b).sub(cP);
    const tP = b.negate().sub(discP.max(0).sqrt()); // near planet root
    const hitsP = discP.greaterThan(0).and(tP.greaterThan(0));
    const tEnd = hitsP.select(tP, tTop).max(0);
    const stepLen = tEnd.div(TRANS_STEPS);

    const odR = float(0).toVar();
    const odM = float(0).toVar();
    const odO = float(0).toVar();
    Loop(TRANS_STEPS, ({ i }) => {
      const t = stepLen.mul(float(i).add(0.5));
      const num = cP.add(b.mul(2).mul(t)).add(t.mul(t));
      const rho = r0.mul(r0).add(b.mul(2).mul(t)).add(t.mul(t)).sqrt();
      const a = num.div(rho.add(R)).max(0);
      odR.addAssign(a.div(-HR).exp().mul(stepLen));
      odM.addAssign(a.div(-HM).exp().mul(stepLen));
      odO.addAssign(a.sub(OZ_CENTER).abs().div(OZ_WIDTH).oneMinus().max(0).mul(stepLen));
    });
    const tau = betaR.mul(odR).add(betaMe.mul(odM)).add(betaOz.mul(odO));
    // If the ray hits the planet, nothing gets through (transmittance 0).
    const Tr = hitsP.select(vec3(0, 0, 0), expVec(tau.negate()));
    return vec4(Tr, 1);
  })();

  const quad = new QuadMesh(mat);

  return {
    transmittance: trans,
    build(renderer: WebGPURenderer): void {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(trans);
      quad.render(renderer);
      renderer.setRenderTarget(prev);
    },
    dispose(): void {
      trans.dispose();
      mat.dispose();
    },
  };
}
