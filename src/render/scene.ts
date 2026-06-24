// ─────────────────────────────────────────────────────────────────────────────
// The Three.js WebGPU render shell — Step 2.
//
// The whole planet is back, now built from a quadtree LOD: the QuadtreeManager
// asks the pure core for the visible leaf cut, the worker meshes leaves, and
// detail refines as the camera approaches — coarse from orbit, fine at the
// surface. Skirts (in the core mesher) hide the cracks between LOD levels.
//
// Step 2 scope (slice spec §6): seamless orbit→surface detail, no visible cracks,
// correct LOD selection. Camera presets 1/2/3 (orbit/mid/surface) exercise it;
// continuous async streaming with a worker pool is Step 3; the full floating
// origin + walking is Step 4. We render relative to a per-preset renderOrigin to
// keep GPU floats small.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Scene,
  PerspectiveCamera,
  DirectionalLight,
  HemisphereLight,
  Color,
  Vector3,
  DoubleSide,
  ACESFilmicToneMapping,
} from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EARTH_RADIUS_M } from '../core/constants.ts';
import { sliceTerrainRecipe } from '../core/density.ts';
import { sliceFacts } from '../core/facts.ts';
import { childSeed, SALT } from '../core/seedchain.ts';
import { QuadtreeManager } from './quadtreeManager.ts';

export interface SliceScene {
  readonly renderer: WebGPURenderer;
  render(): void;
  streamInfo(): string;
  resize(width: number, height: number): void;
  dispose(): void;
}

// A fixed surface look-at direction for the close presets (some arbitrary spot).
const SURFACE_DIR = new Vector3(0.2, 1, 0.15).normalize();

// Finished meshes uploaded to the GPU per frame (slice spec §7 — the only
// generation cost allowed in the frame). The rest queue and drain over frames.
const UPLOAD_PER_FRAME = 4;
// How far ahead of the camera (in per-frame velocity units) to prioritize work.
const LOOKAHEAD_FRAMES = 30;

interface Preset {
  target: Vector3; // world-space look-at
  cam: Vector3; // world-space camera position
  near: number;
  far: number;
  minD: number;
  maxD: number;
}

export async function createScene(canvas: HTMLCanvasElement): Promise<SliceScene> {
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // CRITICAL (CLAUDE.md §2): WebGPURenderer init is async — await before render.
  await renderer.init();

  const R = EARTH_RADIUS_M;

  const scene = new Scene();
  scene.background = new Color(0x05070d);

  const camera = new PerspectiveCamera(55, 1, R * 0.4, R * 8);
  const fovY = (camera.fov * Math.PI) / 180;

  const sun = new DirectionalLight(0xfff4e6, 1.4);
  sun.position.set(1, 0.35, 0.6);
  scene.add(sun);
  scene.add(new HemisphereLight(0x88aacc, 0x141018, 0.25));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.8;

  // Terrain recipe from the slice planet's coordinate-derived seed.
  const terrainSeed = childSeed(sliceFacts().seed, 0, SALT.terrain);
  const recipe = sliceTerrainRecipe(terrainSeed);
  // Double-sided so skirt curtains show regardless of winding.
  const material = new MeshStandardNodeMaterial({
    color: 0x9a8c7a,
    roughness: 0.92,
    metalness: 0.0,
    side: DoubleSide,
  });
  // maxDepth 10 caps the leaf count (~50 orbit / ~230 mid / ~185 surface with
  // frustum + horizon culling) for the single Step-1 worker; Step 3's worker pool
  // lifts the cap for walking-scale detail. splitPx 400 per slice spec §5.
  const manager = new QuadtreeManager(scene, material, recipe, R, { splitPx: 400, maxDepth: 10 });

  // ── Camera presets (the gate's "static camera positions") ──────────────────
  const surf = SURFACE_DIR.clone().multiplyScalar(R);
  const tangent = new Vector3()
    .crossVectors(SURFACE_DIR, new Vector3(0, 0, 1))
    .normalize();
  const altMid = R * 0.12;
  const altSurf = 28_000;
  const presets: Record<string, Preset> = {
    orbit: {
      target: new Vector3(0, 0, 0),
      cam: SURFACE_DIR.clone().multiplyScalar(R * 3),
      near: R * 0.4,
      far: R * 8,
      minD: R * 1.3,
      maxD: R * 6,
    },
    mid: {
      target: surf.clone(),
      cam: SURFACE_DIR.clone()
        .multiplyScalar(R + altMid)
        .addScaledVector(tangent, altMid * 0.5),
      near: altMid * 0.08,
      far: R * 2,
      minD: altMid * 0.2,
      maxD: R * 1.5,
    },
    surface: {
      target: surf.clone(),
      cam: SURFACE_DIR.clone()
        .multiplyScalar(R + altSurf)
        .addScaledVector(tangent, altSurf * 0.8),
      near: altSurf * 0.05,
      far: 800_000,
      minD: altSurf * 0.15,
      maxD: R * 0.3,
    },
  };

  let renderOrigin = new Vector3(0, 0, 0);
  let targetWorld = new Vector3(0, 0, 0);
  let forceCut = true;
  const lastCutPos = new Vector3();
  const prevWorldCam = new Vector3();

  function applyPreset(p: Preset): void {
    renderOrigin = p.target.clone();
    targetWorld = p.target.clone();
    manager.setRenderOrigin([renderOrigin.x, renderOrigin.y, renderOrigin.z]);
    camera.near = p.near;
    camera.far = p.far;
    camera.position.copy(p.cam).sub(renderOrigin);
    camera.updateProjectionMatrix();
    controls.target.copy(p.target).sub(renderOrigin); // == 0
    controls.minDistance = p.minD;
    controls.maxDistance = p.maxD;
    controls.update();
    prevWorldCam.copy(p.cam);
    forceCut = true;
  }
  applyPreset(presets.orbit!);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === '1') applyPreset(presets.orbit!);
    else if (e.key === '2') applyPreset(presets.mid!);
    else if (e.key === '3') applyPreset(presets.surface!);
  };
  window.addEventListener('keydown', onKey);

  let vpHeight = window.innerHeight;
  let aspect = 1;
  const worldCam = new Vector3();
  const forward = new Vector3();
  const vel = new Vector3();
  const lookahead = new Vector3();

  return {
    renderer,
    render(): void {
      controls.update();
      worldCam.copy(camera.position).add(renderOrigin);
      vel.copy(worldCam).sub(prevWorldCam); // world units / frame
      prevWorldCam.copy(worldCam);

      // Dynamic near/far from altitude + horizon distance, every frame. Fixed
      // per-preset planes blacked the planet out on zoom-out (far too small);
      // this always reaches the visible limb and keeps a sane depth ratio.
      const distCenter = worldCam.length();
      const alt = Math.max(distCenter - R, 1);
      const horizon = Math.sqrt(Math.max(0, distCenter * distCenter - R * R));
      camera.near = Math.max(1, alt * 0.05);
      camera.far = horizon + recipe.height * 8 + alt * 0.1;
      camera.updateProjectionMatrix();

      const distToTarget = worldCam.distanceTo(targetWorld);
      // Re-cut when the camera has moved enough (adaptive: tighter near surface).
      const moved = worldCam.distanceTo(lastCutPos);
      if (forceCut || moved > Math.max(50, distToTarget * 0.02)) {
        forward.copy(targetWorld).sub(worldCam).normalize(); // orbit controls always look at target
        // Cone half-angle covering the frustum corners, with margin so leaves just
        // off-screen are pre-meshed before they rotate into view (fewer reveals).
        const halfFov = Math.atan(Math.tan(fovY / 2) * Math.sqrt(1 + aspect * aspect)) * 1.35;
        lookahead.copy(worldCam).addScaledVector(vel, LOOKAHEAD_FRAMES); // generate ahead of motion
        manager.update(
          {
            position: [worldCam.x, worldCam.y, worldCam.z],
            viewportHeight: vpHeight,
            fovY,
            forward: [forward.x, forward.y, forward.z],
            halfFov,
          },
          [lookahead.x, lookahead.y, lookahead.z],
        );
        lastCutPos.copy(worldCam);
        forceCut = false;
      }
      // Drain finished meshes onto the GPU under the per-frame budget (the only
      // generation cost in-frame; generation itself ran on the worker pool).
      manager.uploadReady(UPLOAD_PER_FRAME);
      renderer.render(scene, camera);
    },
    streamInfo(): string {
      const s = manager.stats();
      return `leaves ${s.live}  queue ${s.pending + s.ready}  busy ${s.inflight}  ${s.msPerLeaf.toFixed(0)} ms/leaf`;
    },
    resize(width: number, height: number): void {
      vpHeight = height;
      aspect = width / height;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    dispose(): void {
      window.removeEventListener('keydown', onKey);
      manager.dispose();
      controls.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
