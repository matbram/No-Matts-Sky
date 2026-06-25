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
  Mesh,
  BufferGeometry,
  BufferAttribute,
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
import { buildCubeSphere } from '../core/cubesphere.ts';
import { sliceTerrainRecipe, surfaceAt, lodOctaves } from '../core/density.ts';
import { sliceFacts } from '../core/facts.ts';
import { childSeed, SALT } from '../core/seedchain.ts';
import { QuadtreeManager } from './quadtreeManager.ts';
import { PlayerController, type WalkInput } from './player.ts';

// Injected by Vite at build time (git short hash + build time) — logged at startup
// so we can tell a stale deploy from the latest fix during remote diagnosis.
declare const __BUILD_ID__: string;

export interface SliceScene {
  readonly renderer: WebGPURenderer;
  render(): void;
  streamInfo(): string;
  resize(width: number, height: number): void;
  dispose(): void;
}

// A fixed surface look-at direction for the close presets (some arbitrary spot).
const SURFACE_DIR = new Vector3(0.2, 1, 0.15).normalize();

// Finest quadtree depth. At Earth radius: depth 15 ≈ 9.5 m cells underfoot (depth
// 14 ≈ 19 m, 16 ≈ 4.8 m) — enough near-field detail that walking shows parallax.
// Paired with LOD-adaptive octaves (density.lodOctaves) so the fine cells actually
// carry meter-scale content. [T] dial DOWN (15→14→…) if the surface drops below 60 fps.
const MAX_DEPTH = 15;
// Walk-mode forward-cone half-angle multiplier over the frustum corners (a touch
// wider than fly's 1.2 so a turn has slack before the recut-on-rotation fires).
const WALK_CONE_MARGIN = 1.4;
// Walk-mode: re-cut the streaming cone when the view turns past this much, so the
// cone follows the look direction (translation alone would leave stale/blank tiles
// after a turn). Kept under the cone's slack so the frustum never outruns the cut.
const RECUT_ROT_COS = Math.cos((20 * Math.PI) / 180);
// Walk-mode split threshold (px). Wider than fly's 300 so the now-graded LOD (which
// places ~150 leaves per level) stays within budget at the finer MAX_DEPTH: the
// nearest ground is still meshed to MAX_DEPTH (it projects far over this), only the
// mid-distance transition bands coarsen. Fly/orbit keep the manager's 300. [T] dial.
const WALK_SPLIT_PX = 420;

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
  // DEPTH PRECISION (logarithmic, default on): at real planet scale the near:far
  // ratio is ~1:30, so a plain float32 depth buffer resolves only ~1 m near the
  // surface and the per-leaf apron-overlap + skirt geometry z-fought into thin seam
  // lines at every boundary. Logarithmic depth distributes precision across the whole
  // range and clears the z-fighting in BOTH backends. (Reversed-Z is cheaper but its
  // Three r184 WebGPU path is buggy — it dithered the inset backdrop through the
  // terrain in big patches — so we don't use it by default.)
  // Debug/diagnostic URL toggles (no effect in normal use): ?nolog disables log depth
  // for A/B; ?revz tries reversed-Z instead; ?webgl forces the WebGL2 backend (stable
  // in headless CI, where software WebGPU drops its device).
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  // Make the canvas keyboard-focusable so walk-mode WASD reaches the page even with
  // DevTools open (pointer-lock routes the mouse to the page, but keyboard needs focus).
  canvas.tabIndex = 0;
  canvas.style.outline = 'none';
  const useLog = !params.has('nolog');
  const useRevz = params.has('revz');
  const useWebGL = params.has('webgl');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: useWebGL,
    logarithmicDepthBuffer: useLog,
    reversedDepthBuffer: useRevz,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // CRITICAL (CLAUDE.md §2): WebGPURenderer init is async — await before render.
  await renderer.init();

  // ── Verbose diagnostic logging (browser console) ───────────────────────────
  // Tells us, on the USER's machine: which build is live (stale-deploy check), the
  // ACTUAL graphics backend (real WebGPU vs WebGL2 fallback), and the depth mode.
  const be = (renderer as unknown as {
    backend?: { constructor?: { name?: string }; isWebGPUBackend?: boolean };
  }).backend;
  console.log(
    `%c[NMS] build ${__BUILD_ID__}`,
    'color:#7cfc8a;font-weight:bold',
  );
  console.log('[NMS] renderer backend:', be?.constructor?.name, '| isWebGPUBackend:', be?.isWebGPUBackend);
  console.log('[NMS] depth:', { logarithmicDepthBuffer: useLog, reversedDepthBuffer: useRevz, forceWebGL: useWebGL });
  console.log('[NMS] debug toggles:', {
    noback: params.has('noback'),
    wire: params.has('wire'),
    lodcolor: params.has('lodcolor'),
    skirtcolor: params.has('skirtcolor'),
    skirt: params.has('skirt'), // skirts are OFF by default now; ?skirt re-enables them
    dark: params.has('dark'),
  });

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
  // Octave count of the FINEST leaf — what the collision probe must sample so the
  // player stands on the same bumps the deepest mesh shows (not a smoother field).
  const groundOct = lodOctaves(recipe, MAX_DEPTH);
  // Double-sided so skirt curtains show regardless of winding. Fully OPAQUE: the
  // LOD transition is a GEOMETRY morph (the manager clones this per leaf and drives
  // a per-leaf morph uniform that lerps each vertex morphTarget→position), so detail
  // resolves in with a single opaque surface — no dither, no two surfaces at once.
  const material = new MeshStandardNodeMaterial({
    color: 0x9a8c7a,
    roughness: 0.92,
    metalness: 0.0,
    side: DoubleSide,
  });
  material.wireframe = params.has('wire'); // debug: see the tessellation / where lines fall
  // splitPx 300 (smaller, gentler LOD steps — affordable after the ~13× meshing
  // speedup); maxDepth = MAX_DEPTH gives meter-scale near-field cells for walking.
  const manager = new QuadtreeManager(scene, material, recipe, R, {
    splitPx: 300,
    maxDepth: MAX_DEPTH,
    // Skirts OFF by default — the apron covers LOD-transition holes and the skirts were
    // the visible boundary grid (?noskirt confirmed clean). ?skirt re-enables for A/B.
    skirts: params.has('skirt'),
    // debug tint: 'lod' colors leaves by LOD level, 'skirt' highlights skirted leaves
    debugColor: params.has('lodcolor') ? 'lod' : params.has('skirtcolor') ? 'skirt' : undefined,
  });

  // No-black backdrop: a single smooth sphere INSET below the deepest terrain
  // (radius − height·1.05), always present, so any not-yet-streamed gap shows
  // coarse terrain-colored shell instead of the black background. 1 draw call,
  // built once; repositioned with the render origin in applyPreset.
  const backdropGeo = (() => {
    const s = buildCubeSphere(48, R - recipe.height * 1.05);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(s.positions, 3));
    g.setAttribute('normal', new BufferAttribute(s.normals, 3));
    g.setIndex(new BufferAttribute(s.indices, 1));
    return g;
  })();
  // The backdrop is a plain opaque shell (no morph attribute — it never geomorphs).
  const backdropMaterial = new MeshStandardNodeMaterial({
    color: 0x9a8c7a,
    roughness: 0.92,
    metalness: 0.0,
    side: DoubleSide,
  });
  const backdrop = new Mesh(backdropGeo, backdropMaterial);
  backdrop.visible = !params.has('noback'); // debug: hide → do the lines become black gaps?
  scene.add(backdrop);

  // ── Camera presets (the gate's "static camera positions") ──────────────────
  const surf = SURFACE_DIR.clone().multiplyScalar(R);
  const tangent = new Vector3()
    .crossVectors(SURFACE_DIR, new Vector3(0, 0, 1))
    .normalize();
  const altMid = R * 0.12;
  const altSurf = 28_000;
  // Debug: ?dark places the orbit camera anti-sun so the harness can see the NIGHT
  // hemisphere (where the per-tile boundary grid is most visible).
  const orbitDir = params.has('dark')
    ? sun.position.clone().negate().normalize()
    : SURFACE_DIR.clone();
  const presets: Record<string, Preset> = {
    orbit: {
      target: new Vector3(0, 0, 0),
      cam: orbitDir.clone().multiplyScalar(R * 3),
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
  const lastCutForward = new Vector3(); // walk: look dir at the last cut (recut-on-rotation)
  const prevWorldCam = new Vector3();

  function applyPreset(p: Preset): void {
    renderOrigin = p.target.clone();
    targetWorld = p.target.clone();
    manager.setRenderOrigin([renderOrigin.x, renderOrigin.y, renderOrigin.z]);
    backdrop.position.set(-renderOrigin.x, -renderOrigin.y, -renderOrigin.z);
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

  let vpHeight = window.innerHeight;
  let aspect = 1;
  let lastFrame = performance.now();
  const worldCam = new Vector3();
  const forward = new Vector3();
  const vel = new Vector3();
  const lookahead = new Vector3();

  // ── Walking (Step 4): floating-origin + body-fixed player ────────────────────
  let mode: 'fly' | 'walk' = 'fly';
  let player: PlayerController | null = null;
  const held: WalkInput = { forward: false, back: false, left: false, right: false, jump: false, sprint: false };
  // Re-center the floating origin on the player past this drift, so GPU floats stay
  // ~0.06 mm-precise near the player (512·2⁻²³) → no jitter, while big planet-scale
  // doubles are differenced in JS and never reach the GPU (CLAUDE.md §4).
  const RECENTER_THRESHOLD = 512;
  const _spawn = new Vector3();
  const _surf7 = new Float64Array(7);
  const playerWorld = new Vector3();

  function enterWalk(): void {
    surfaceAt(recipe, R, SURFACE_DIR.x, SURFACE_DIR.y, SURFACE_DIR.z, _surf7, groundOct);
    _spawn.copy(SURFACE_DIR).multiplyScalar(_surf7[0]! + 1.7); // body-fixed spawn at eye height
    player = player ?? new PlayerController(recipe, R, groundOct);
    player.reset(_spawn, 0, 0);
    controls.enabled = false;
    renderOrigin.copy(_spawn);
    targetWorld.copy(_spawn);
    manager.setRenderOrigin([renderOrigin.x, renderOrigin.y, renderOrigin.z]);
    backdrop.position.set(-renderOrigin.x, -renderOrigin.y, -renderOrigin.z);
    camera.position.set(0, 0, 0);
    player.getQuaternion(camera.quaternion);
    mode = 'walk';
    forceCut = true;
    canvas.focus(); // keyboard focus → WASD works immediately (no click needed)
  }
  // Request pointer lock, swallowing the promise rejection browsers throw if it's
  // called too soon after an Esc-exit ("cannot be acquired immediately after exit").
  function lockPointer(): void {
    try {
      const p = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* older browsers: requestPointerLock returns void / may throw — ignore */
    }
  }
  function exitToPreset(p: Preset): void {
    if (mode === 'walk') {
      mode = 'fly';
      controls.enabled = true;
      held.forward = held.back = held.left = held.right = held.jump = held.sprint = false;
      document.exitPointerLock?.();
    }
    applyPreset(p);
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'KeyW': held.forward = true; break;
      case 'KeyS': held.back = true; break;
      case 'KeyA': held.left = true; break;
      case 'KeyD': held.right = true; break;
      case 'Space': held.jump = true; break;
      case 'ShiftLeft': case 'ShiftRight': held.sprint = true; break;
      case 'KeyF': if (mode === 'fly') enterWalk(); break;
      case 'Digit1': exitToPreset(presets.orbit!); break;
      case 'Digit2': exitToPreset(presets.mid!); break;
      case 'Digit3': exitToPreset(presets.surface!); break;
      // Esc is NOT handled: the browser auto-frees the mouse; we stay in walk mode
      // (click to re-lock). Exit walk via 1/2/3.
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'KeyW': held.forward = false; break;
      case 'KeyS': held.back = false; break;
      case 'KeyA': held.left = false; break;
      case 'KeyD': held.right = false; break;
      case 'Space': held.jump = false; break;
      case 'ShiftLeft': case 'ShiftRight': held.sprint = false; break;
    }
  };
  const onClick = (): void => {
    if (mode === 'walk') {
      canvas.focus();
      lockPointer();
    }
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (mode === 'walk' && player && document.pointerLockElement === canvas) {
      player.addMouse(e.movementX, e.movementY);
    }
  };
  // Capture phase: receive WASD before any bubble-phase handler (e.g. a browser
  // extension content-script) can stopPropagation() and starve us — the asymmetry
  // that earlier looked like "mouse works, keys don't." Harmless when no such
  // handler exists. Must remove with the SAME { capture: true } option.
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  canvas.addEventListener('click', onClick);
  window.addEventListener('mousemove', onMouseMove);

  // Headless/debug hook: live player state for the walk verification harness.
  (window as unknown as { __nms_player?: () => unknown }).__nms_player = () =>
    mode === 'walk' && player
      ? { alt: player.altitude(), spd: player.speed(), grounded: player.isGrounded(),
          x: playerWorld.x, y: playerWorld.y, z: playerWorld.z, near: camera.near }
      : null;

  return {
    renderer,
    render(): void {
      const now = performance.now();
      const dt = now - lastFrame;
      lastFrame = now;

      if (mode === 'walk' && player) {
        // Drive the camera from the player's body-fixed position; keep the floating
        // origin near the player so GPU floats stay tiny (no jitter).
        player.update(dt / 1000, held);
        player.getWorldPos(playerWorld);
        camera.position.copy(playerWorld).sub(renderOrigin);
        if (camera.position.lengthSq() > RECENTER_THRESHOLD * RECENTER_THRESHOLD) {
          renderOrigin.copy(playerWorld);
          manager.setRenderOrigin([renderOrigin.x, renderOrigin.y, renderOrigin.z]);
          backdrop.position.set(-renderOrigin.x, -renderOrigin.y, -renderOrigin.z);
          camera.position.set(0, 0, 0);
        }
        player.getQuaternion(camera.quaternion);
      } else {
        controls.update();
      }

      worldCam.copy(camera.position).add(renderOrigin);
      vel.copy(worldCam).sub(prevWorldCam); // world units / frame
      prevWorldCam.copy(worldCam);

      // Dynamic near/far from altitude + horizon distance, every frame.
      const distCenter = worldCam.length();
      const horizon = Math.sqrt(Math.max(0, distCenter * distCenter - R * R));
      if (mode === 'walk') {
        // Eye-height altitude above the mean radius is unreliable (mountains/basins),
        // so use a fixed 10 cm near for close terrain; the 0.1 m : ~hundreds-of-km
        // ratio is fine ONLY because logarithmic depth is on (?nolog z-fights here).
        camera.near = 0.1;
        camera.far = horizon + recipe.height * 8 + 5000;
      } else {
        const alt = Math.max(distCenter - R, 1);
        camera.near = Math.max(1, alt * 0.05);
        camera.far = horizon + recipe.height * 8 + alt * 0.1;
      }
      camera.updateProjectionMatrix();

      const distToTarget = worldCam.distanceTo(targetWorld);
      // Re-cut when the camera has moved enough (fixed small step while walking;
      // adaptive while flying) OR — in walk — when the view has TURNED enough that
      // the forward cone needs to swing to follow it. Translation alone would leave
      // tiles behind you live and tiles ahead unmeshed after a turn.
      const moved = worldCam.distanceTo(lastCutPos);
      const recutDist = mode === 'walk' ? 8 : Math.max(50, distToTarget * 0.02);
      let turned = false;
      if (mode === 'walk' && player) {
        player.getForward(forward); // look direction (Step 4: render space == world)
        turned = forward.dot(lastCutForward) < RECUT_ROT_COS;
      }
      if (forceCut || moved > recutDist || turned) {
        let halfFov: number;
        let splitPxOverride: number | undefined;
        if (mode === 'walk' && player) {
          // `forward` already set above. Use a forward cone (NOT the full hemisphere)
          // so the finer MAX_DEPTH near-field doesn't blow up the leaf count; the
          // recut-on-rotation above keeps it pointed where you look.
          halfFov = Math.atan(Math.tan(fovY / 2) * Math.sqrt(1 + aspect * aspect)) * WALK_CONE_MARGIN;
          splitPxOverride = WALK_SPLIT_PX; // leaner cut at the finer walk MAX_DEPTH
          lastCutForward.copy(forward);
        } else {
          forward.copy(targetWorld).sub(worldCam).normalize(); // orbit controls always look at target
          // Cone half-angle covering the frustum corners, with a small margin so
          // leaves just off-screen are pre-meshed before rotating in.
          halfFov = Math.atan(Math.tan(fovY / 2) * Math.sqrt(1 + aspect * aspect)) * 1.2;
        }
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
          splitPxOverride,
        );
        lastCutPos.copy(worldCam);
        forceCut = false;
      }
      // Drain finished meshes onto the GPU under the per-frame budget (the only
      // generation cost in-frame; generation itself ran on the worker pool).
      manager.uploadReady(UPLOAD_PER_FRAME);
      manager.tick(dt); // advance LOD geomorphs
      renderer.render(scene, camera);
    },
    streamInfo(): string {
      const s = manager.stats();
      const base = `leaves ${s.live}  queue ${s.pending + s.ready}  busy ${s.inflight}  ${s.msPerLeaf.toFixed(0)} ms/leaf`;
      if (mode === 'walk' && player) {
        return `WALK  alt ${player.altitude().toFixed(1)} m  spd ${player.speed().toFixed(1)} m/s  (click: look · 1/2/3: exit)\n${base}`;
      }
      return `FLY  (F: walk)\n${base}`;
    },
    resize(width: number, height: number): void {
      vpHeight = height;
      aspect = width / height;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('click', onClick);
      manager.dispose();
      controls.dispose();
      backdropGeo.dispose();
      backdropMaterial.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
