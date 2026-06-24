// ─────────────────────────────────────────────────────────────────────────────
// The Three.js WebGPU render shell for Step 0.
//
// It consumes PLAIN mesh data from the pure core (`buildCubeSphere`) — no core
// module imports Three.js, and no Three.js type crosses back into the core. That
// boundary is the whole architecture (CLAUDE.md §3).
//
// Step 0 scope: a static real-scale Earth cube-sphere lit by one directional
// "sun", circled by an orbit camera, holding 60fps. No noise/LOD/streaming. Real
// day/night from spin, the floating origin, and surface descent are later steps —
// here, scale is handled purely via camera distance + near/far (CLAUDE.md §6).
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
  ACESFilmicToneMapping,
} from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildCubeSphere } from '../core/cubesphere.ts';
import { EARTH_RADIUS_M } from '../core/constants.ts';

// Whole-sphere subdivision for Step 0 (no LOD yet). ~99k vertices — trivial for
// the GPU; the round silhouette is what matters from orbit.
const SUBDIVISIONS = 128;

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
  // lights clip to white. ACES keeps the lit hemisphere readable.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // CRITICAL (CLAUDE.md §2): WebGPURenderer init is async. Forget the await and
  // you get a blank screen with NO error.
  await renderer.init();

  const R = EARTH_RADIUS_M;

  const scene = new Scene();
  scene.background = new Color(0x05070d);

  // Near/far chosen for an ORBIT view of a 6,371 km sphere with a small depth
  // ratio (good precision). Getting to the surface needs the floating origin
  // (Step 4); orbit distance is clamped below to stay in this safe envelope.
  const camera = new PerspectiveCamera(55, 1, R * 0.2, R * 8);
  camera.position.set(R * 2.2, R * 1.1, R * 2.2);

  // Geometry built by the pure core, handed over as plain typed arrays.
  const sphere = buildCubeSphere(SUBDIVISIONS, R);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(sphere.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(sphere.normals, 3));
  geometry.setIndex(new BufferAttribute(sphere.indices, 1));

  const material = new MeshStandardNodeMaterial({
    color: 0x6b7b8c,
    roughness: 0.95,
    metalness: 0.0,
  });
  const planet = new Mesh(geometry, material);
  scene.add(planet);

  // One directional "sun" + a faint hemisphere fill so the dark side and the
  // terminator still read. (Real day/night comes from planet spin at Step 5;
  // intensities tuned for ACES tone mapping above.)
  const sun = new DirectionalLight(0xfff4e6, 1.4);
  sun.position.set(1, 0.35, 0.6);
  scene.add(sun);
  scene.add(new HemisphereLight(0x88aacc, 0x141018, 0.25));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.4;
  controls.zoomSpeed = 0.6;
  controls.minDistance = R * 1.3;
  controls.maxDistance = R * 6;
  controls.target.set(0, 0, 0);

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
      controls.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
