// ─────────────────────────────────────────────────────────────────────────────
// The Three.js WebGPU render shell — Step 1.
//
// It still consumes only PLAIN data from the pure core, but now that data is a
// MESHED TERRAIN CHUNK produced OFF the main thread: a worker runs the density
// field + Surface Nets and transfers back position/normal/index buffers, which we
// drop straight into a BufferGeometry (no core module imports Three.js — that
// boundary is the architecture, CLAUDE.md §3).
//
// Step 1 scope (slice spec §6): show ONE quadtree leaf with correct analytic
// normals, meshed off-thread, lit by one sun. Vertices arrive RELATIVE to the
// chunk origin, so we render in that chunk-local frame and orbit the patch. LOD
// across the whole sphere is Step 2; continuous streaming + the floating origin
// are Steps 3–4.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Scene,
  PerspectiveCamera,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  DirectionalLight,
  HemisphereLight,
  Color,
  Vector3,
  ACESFilmicToneMapping,
} from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EARTH_RADIUS_M } from '../core/constants.ts';
import { sliceTerrainRecipe } from '../core/density.ts';
import { sliceFacts } from '../core/facts.ts';
import { childSeed, SALT } from '../core/seedchain.ts';
import type { ChunkMesh, MeshJob } from '../core/chunk.ts';

interface IncomingJob extends MeshJob {
  id: number;
}

// The one chunk Step 1 shows: a mid-depth leaf on the +Y face.
const DEMO_REQUEST = { face: 2, path: [2, 1, 2, 1], lod: 4 } as const;

export interface SliceScene {
  readonly renderer: WebGPURenderer;
  render(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export async function createScene(canvas: HTMLCanvasElement): Promise<SliceScene> {
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // r184 WebGPU uses physically-based lighting; without tone mapping, bright
  // lights clip to white. ACES keeps the lit surface readable.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // CRITICAL (CLAUDE.md §2): WebGPURenderer init is async. Forget the await and
  // you get a blank screen with NO error.
  await renderer.init();

  const R = EARTH_RADIUS_M;

  const scene = new Scene();
  scene.background = new Color(0x05070d);

  // Placeholder framing; set for real once the chunk's bounds arrive.
  const camera = new PerspectiveCamera(55, 1, 1000, R);
  camera.position.set(0, 0, 1);

  const sun = new DirectionalLight(0xfff4e6, 1.4);
  sun.position.set(1, 0.35, 0.6);
  scene.add(sun);
  scene.add(new HemisphereLight(0x88aacc, 0x141018, 0.25));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.7;

  const material = new MeshStandardNodeMaterial({ color: 0x9a8c7a, roughness: 0.92, metalness: 0.0 });
  let patch: Mesh | null = null;
  let geometry: BufferGeometry | null = null;

  // ── Kick off off-thread meshing ────────────────────────────────────────────
  const terrainSeed = childSeed(sliceFacts().seed, 0, SALT.terrain);
  const recipe = sliceTerrainRecipe(terrainSeed);
  const worker = new Worker(new URL('../workers/mesher.worker.ts', import.meta.url), {
    type: 'module',
  });
  const job: IncomingJob = { id: 1, req: { ...DEMO_REQUEST, path: [...DEMO_REQUEST.path] }, recipe, radius: R };
  worker.onmessage = (e: MessageEvent<{ id: number; mesh: ChunkMesh }>): void => {
    addPatch(e.data.mesh);
  };
  worker.postMessage(job);

  function addPatch(mesh: ChunkMesh): void {
    geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new BufferAttribute(mesh.indices, 1));
    patch = new Mesh(geometry, material);
    scene.add(patch);
    frameCamera(mesh);
  }

  function frameCamera(mesh: ChunkMesh): void {
    const { min, max } = mesh.bounds;
    const center = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const dist = size * 1.6;

    // The patch's outward direction (its origin points away from planet center).
    const out = new Vector3(...mesh.origin).normalize();
    const upHint = Math.abs(out.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const tangent = new Vector3().crossVectors(out, upHint).normalize();

    camera.position
      .copy(center)
      .addScaledVector(out, dist * 0.95)
      .addScaledVector(tangent, dist * 0.45);
    camera.near = dist * 0.15;
    camera.far = dist * 6;
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.minDistance = dist * 0.4;
    controls.maxDistance = dist * 3;
    controls.update();
  }

  return {
    renderer,
    render(): void {
      controls.update();
      renderer.render(scene, camera);
    },
    resize(width: number, height: number): void {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    dispose(): void {
      worker.terminate();
      controls.dispose();
      geometry?.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
