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
  Raycaster,
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
// Creative-flight split threshold (px) — coarser than walk: you fly fast and usually at
// altitude, so a leaner cut keeps the leaf count/budget sane while still detailed near you.
const CREATIVE_SPLIT_PX = 520;
// Fly/orbit split threshold (px) — the manager default; shared with the CDLOD morph so the
// distance-morph band matches the cut's split distance exactly.
const FLY_SPLIT_PX = 300;

// Finished meshes uploaded to the GPU per frame (slice spec §7 — the only
// generation cost allowed in the frame). The rest queue and drain over frames.
const UPLOAD_PER_FRAME = 4;
// While the view is still filling (first load / preset switch / entering walk), upload
// more per frame: the screen is incomplete so a brief hitch is invisible, and it cuts
// the "terrain develops over a few seconds" pop-in from ~3 s (639 leaves / 4) to
// <~0.5 s. Reverts to UPLOAD_PER_FRAME once first coverage is reached, so steady-state
// in-flight LOD changes never hitch.
const BURST_PER_FRAME = 24;
// How far ahead of the camera (in per-frame velocity units) to prioritize work.
const LOOKAHEAD_FRAMES = 30;
// Speed-aware PREFETCH lead TIME (s): finer leaves are requested when the camera is
// `approachSpeed · PREFETCH_S` meters from their natural split distance, so they finish
// streaming (~0.5–0.7 s observed) BEFORE the camera reaches their CDLOD morph band and
// resolve gradually from the parent surface instead of snapping in late. ~0 at rest /
// lateral motion (no wasted leaves); kicks in on a plunge. [T] dial up if pops persist,
// down if a fast descent dips below 60 fps. PREFETCH_MAX_M caps the lead so a hyper-plunge
// can't force the whole near-field to maxDepth and blow the leaf budget.
const PREFETCH_S = 0.7;
const PREFETCH_MAX_M = 6000;
// EMA smoothing for the approach-rate estimate (per-frame blend of the new sample), so a
// single jittery frame-time doesn't swing the prefetch distance. ~0.15 ≈ a few-frame lag.
const APPROACH_EMA = 0.15;

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
  // ?clipdebug: per-walk-frame console line (throttled) comparing the analytic collision
  // floor to the RENDERED mesh height under the player (downward raycast) + the leaf
  // depth/morph underfoot — so the user's console paste shows the clip mechanism.
  const clipDebug = params.has('clipdebug');
  // ?lodmorphdebug: throttled [NMS morph] console line (geomorph staggering + cut imbalance).
  // ?morphcolor: tint leaves red→green by geomorph progress so LOD pop-in is visible to screenshot.
  const lodMorphDebug = params.has('lodmorphdebug');
  const morphColor = params.has('morphcolor');
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
    skirt: params.has('skirt'), // skirts default OFF now; ?skirt re-enables for A/B
    clipdebug: clipDebug, // ?clipdebug: walk collision-vs-rendered-mesh logging
    lodmorphdebug: lodMorphDebug, // ?lodmorphdebug: geomorph staggering/imbalance logging
    morphcolor: morphColor, // ?morphcolor: tint leaves by geomorph progress (LOD pop-in visible)
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
    splitPx: FLY_SPLIT_PX,
    maxDepth: MAX_DEPTH,
    // Skirts OFF by default — they read as a boundary-line grid (the inward curtain is
    // mis-lit / visible at LOD transitions), which is what ?noskirt was working around.
    // The apron covers same-LOD edges; the residual cross-LOD cracks the adaptive octaves
    // reopen are to be fixed at the SOURCE (balanced cut + edge-locked morph), not hidden
    // behind a visible curtain. ?skirt re-enables the old conditioned skirts for A/B.
    skirts: params.has('skirt'),
    // debug tint: 'morph' = geomorph progress (red→green), 'lod' = LOD level, 'skirt' = skirted leaves
    debugColor: morphColor
      ? 'morph'
      : params.has('lodcolor')
        ? 'lod'
        : params.has('skirtcolor')
          ? 'skirt'
          : undefined,
    debugLodMorph: lodMorphDebug,
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
  // Burst the GPU upload until the view first reaches full coverage; reset on every
  // big re-cut (preset switch / entering walk) so each fills fast. See BURST_PER_FRAME.
  let firstFillDone = false;
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
    firstFillDone = false; // burst-fill the new view, then settle
  }
  applyPreset(presets.orbit!);

  let vpHeight = window.innerHeight;
  let aspect = 1;
  let lastFrame = performance.now();
  const worldCam = new Vector3();
  const forward = new Vector3();
  const vel = new Vector3();
  const lookahead = new Vector3();
  // Speed-aware prefetch: smoothed rate (m/s) at which the camera is closing on the
  // planet centre (positive = descending). prevDistCenter seeds the per-frame delta.
  let approachRateEMA = 0;
  let prevDistCenter = -1;

  // ── Walking (Step 4) + creative flight: floating-origin + body-fixed player ──
  let mode: 'fly' | 'walk' | 'creative' = 'fly';
  let player: PlayerController | null = null;
  const held: WalkInput = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, down: false };
  // Re-center the floating origin on the player past this drift, so GPU floats stay
  // ~0.06 mm-precise near the player (512·2⁻²³) → no jitter, while big planet-scale
  // doubles are differenced in JS and never reach the GPU (CLAUDE.md §4).
  const RECENTER_THRESHOLD = 512;
  const _spawn = new Vector3();
  const _surf7 = new Float64Array(7);
  const playerWorld = new Vector3();
  // ?clipdebug scratch (debug-only): a downward raycast measures the RENDERED mesh height
  // under the player so the console can compare it to the analytic collision floor.
  const _ray = new Raycaster();
  const _rayUp = new Vector3();
  const _rayOrigin = new Vector3();
  const _rayDir = new Vector3();
  const _hitWorld = new Vector3();
  const _clip = new Float64Array(11);
  let clipLogN = 0;
  let lastClip = ''; // last clip-debug summary, mirrored to the HUD

  // Collision raycast (every walk frame): the player floors the eye to the HIGHEST rendered
  // leaf under it, so it never sinks below the drawn terrain when a coarse leaf is retained
  // above the fine one during LOD churn (the ?clipdebug-confirmed cause). Pre-filtered to the
  // leaves under the player (manager.leavesUnder) and far-capped → a handful of triangle tests.
  const _probeRay = new Raycaster();
  _probeRay.far = 60;
  const _probeUp = new Vector3();
  const _probeOrigin = new Vector3();
  const _probeDir = new Vector3();
  const _probeHit = new Vector3();
  function renderedSurfaceR(x: number, y: number, z: number): number {
    const meshes = manager.leavesUnder(x, y, z);
    if (meshes.length === 0) return 0; // nothing drawn here → use the analytic floor
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    _probeUp.set(x * inv, y * inv, z * inv);
    // Render space (relative to renderOrigin); start 20 m above the eye, cast straight down.
    _probeOrigin
      .set(x - renderOrigin.x, y - renderOrigin.y, z - renderOrigin.z)
      .addScaledVector(_probeUp, 20);
    _probeDir.copy(_probeUp).multiplyScalar(-1);
    _probeRay.set(_probeOrigin, _probeDir);
    const hits = _probeRay.intersectObjects(meshes, false);
    if (hits.length === 0) return 0;
    _probeHit.copy(hits[0]!.point).add(renderOrigin); // render → world (double) → radius
    return _probeHit.length();
  }

  function enterWalk(): void {
    surfaceAt(recipe, R, SURFACE_DIR.x, SURFACE_DIR.y, SURFACE_DIR.z, _surf7, groundOct);
    _spawn.copy(SURFACE_DIR).multiplyScalar(_surf7[0]! + 1.7); // body-fixed spawn at eye height
    player = player ?? new PlayerController(recipe, R, groundOct, renderedSurfaceR);
    player.setFly(false); // walk: gravity + ground collision (reset() snaps to ground)
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
    firstFillDone = false; // burst-fill the spawn area, then settle to UPLOAD_PER_FRAME
    canvas.focus(); // keyboard focus → WASD works immediately (no click needed)
  }
  // Creative free-fly: spawn where the camera is now, no gravity/collision. Reuses the
  // PlayerController (setFly) so the sphere-stable look basis + floating origin are shared.
  function enterCreative(): void {
    _spawn.copy(camera.position).add(renderOrigin); // current camera world position
    player = player ?? new PlayerController(recipe, R, groundOct, renderedSurfaceR);
    player.setFly(true);
    player.reset(_spawn, 0, 0);
    controls.enabled = false;
    renderOrigin.copy(_spawn);
    targetWorld.copy(_spawn);
    manager.setRenderOrigin([renderOrigin.x, renderOrigin.y, renderOrigin.z]);
    backdrop.position.set(-renderOrigin.x, -renderOrigin.y, -renderOrigin.z);
    camera.position.set(0, 0, 0);
    player.getQuaternion(camera.quaternion);
    mode = 'creative';
    forceCut = true;
    firstFillDone = false;
    canvas.focus();
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
    if (mode === 'walk' || mode === 'creative') {
      mode = 'fly';
      controls.enabled = true;
      player?.setFly(false);
      held.forward = held.back = held.left = held.right = held.jump = held.sprint = held.down = false;
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
      case 'ControlLeft': case 'ControlRight': held.down = true; break; // creative: descend
      case 'KeyF': if (mode !== 'walk') enterWalk(); break;
      case 'KeyG': if (mode !== 'creative') enterCreative(); else exitToPreset(presets.orbit!); break;
      case 'BracketRight': player?.cycleSpeed(1); break; // creative: faster
      case 'BracketLeft': player?.cycleSpeed(-1); break; // creative: slower
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
      case 'ControlLeft': case 'ControlRight': held.down = false; break;
    }
  };
  const onClick = (): void => {
    if (mode === 'walk' || mode === 'creative') {
      canvas.focus();
      lockPointer();
    }
  };
  const onMouseMove = (e: MouseEvent): void => {
    if ((mode === 'walk' || mode === 'creative') && player && document.pointerLockElement === canvas) {
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
    (mode === 'walk' || mode === 'creative') && player
      ? { mode, fly: player.isFlying(), alt: player.altitude(), spd: player.speed(),
          grounded: player.isGrounded(),
          x: playerWorld.x, y: playerWorld.y, z: playerWorld.z, near: camera.near }
      : null;

  return {
    renderer,
    render(): void {
      const now = performance.now();
      const dt = now - lastFrame;
      lastFrame = now;

      if ((mode === 'walk' || mode === 'creative') && player) {
        // Drive the camera from the player's body-fixed position (walk = gravity+collision,
        // creative = free-fly); keep the floating origin near it so GPU floats stay tiny.
        if (mode === 'creative') player.updateFly(dt / 1000, held);
        else player.update(dt / 1000, held);
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

      // CDLOD: feed the per-vertex distance-morph the same projected-size constant the cut
      // uses (kDist = (vpH/(2·tan(fovY/2)))/splitPx for the current mode), so detail fades in
      // continuously with distance and reaches the parent surface exactly at the split distance.
      const curSplitPx = mode === 'walk' ? WALK_SPLIT_PX : mode === 'creative' ? CREATIVE_SPLIT_PX : FLY_SPLIT_PX;
      const kDist = vpHeight / (2 * Math.tan(fovY / 2)) / curSplitPx;
      manager.setMorphParams(kDist, worldCam.x, worldCam.y, worldCam.z, approachRateEMA);

      // Dynamic near/far from altitude + horizon distance, every frame.
      const distCenter = worldCam.length();
      const horizon = Math.sqrt(Math.max(0, distCenter * distCenter - R * R));

      // Speed-aware prefetch: track how fast the camera is closing on the planet centre
      // (descent rate, m/s, EMA-smoothed). ~0 for lateral orbit/walk, large on a plunge —
      // so finer leaves are requested early ONLY when actually approaching (no wasted
      // leaves at rest). Fed into the cut below as a lead distance (approachRate·PREFETCH_S).
      if (dt > 0) {
        const inst = prevDistCenter >= 0 ? (prevDistCenter - distCenter) / (dt / 1000) : 0;
        approachRateEMA += (inst - approachRateEMA) * APPROACH_EMA;
      }
      prevDistCenter = distCenter;
      if (mode === 'walk') {
        // Eye-height altitude above the mean radius is unreliable (mountains/basins),
        // so use a fixed 10 cm near for close terrain; the 0.1 m : ~hundreds-of-km
        // ratio is fine ONLY because logarithmic depth is on (?nolog z-fights here).
        // Defensive near clamp: drop below 0.1 m only when a footprint sample shows the
        // nearest surface is within ~0.2 m (hard contact with a near-vertical face), so a
        // wall can't poke through the near plane. Safe — logarithmic depth is on in walk.
        camera.near = player ? Math.min(0.1, Math.max(0.02, player.nearestSurfaceGap() * 0.5)) : 0.1;
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
      const ctrlMode = (mode === 'walk' || mode === 'creative') && player;
      const recutDist =
        mode === 'walk' ? 8 : mode === 'creative' ? 64 : Math.max(50, distToTarget * 0.02);
      let turned = false;
      if (ctrlMode) {
        player!.getForward(forward); // look direction (render space == world)
        turned = forward.dot(lastCutForward) < RECUT_ROT_COS;
      }
      if (forceCut || moved > recutDist || turned) {
        let halfFov: number;
        let splitPxOverride: number | undefined;
        if (ctrlMode) {
          // `forward` already set above. Forward cone (NOT the full hemisphere) so the
          // near-field doesn't blow up the leaf count; recut-on-rotation keeps it pointed
          // where you look. Creative flies fast/high → coarser cut (CREATIVE_SPLIT_PX).
          halfFov = Math.atan(Math.tan(fovY / 2) * Math.sqrt(1 + aspect * aspect)) * WALK_CONE_MARGIN;
          splitPxOverride = mode === 'creative' ? CREATIVE_SPLIT_PX : WALK_SPLIT_PX;
          lastCutForward.copy(forward);
        } else {
          forward.copy(targetWorld).sub(worldCam).normalize(); // orbit controls always look at target
          // Cone half-angle covering the frustum corners, with a small margin so
          // leaves just off-screen are pre-meshed before rotating in.
          halfFov = Math.atan(Math.tan(fovY / 2) * Math.sqrt(1 + aspect * aspect)) * 1.2;
        }
        lookahead.copy(worldCam).addScaledVector(vel, LOOKAHEAD_FRAMES); // generate ahead of motion
        // Lead distance = descent speed × lead time, capped. 0 when not approaching.
        const prefetchM = Math.min(PREFETCH_MAX_M, Math.max(0, approachRateEMA) * PREFETCH_S);
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
          prefetchM,
        );
        lastCutPos.copy(worldCam);
        forceCut = false;
      }
      // Drain finished meshes onto the GPU under the per-frame budget (the only
      // generation cost in-frame; generation itself ran on the worker pool). Burst the
      // budget until the view first reaches full coverage (incomplete screen → hitch
      // invisible), then settle to UPLOAD_PER_FRAME for hitch-free steady state.
      manager.uploadReady(firstFillDone ? UPLOAD_PER_FRAME : BURST_PER_FRAME);
      if (!firstFillDone) {
        const s = manager.stats();
        if (s.live > 0 && s.pending === 0 && s.inflight === 0 && s.ready === 0) firstFillDone = true;
      }
      manager.tick(dt); // advance LOD geomorphs

      // ?clipdebug (throttled): compare the analytic collision floor to the RENDERED mesh
      // height under the player (downward raycast against live leaf meshes) + log the leaf
      // depth/morph underfoot. The raycast reads the static `position` attribute (TSL morph
      // not applied), so eye-mesh<0 ⇒ eye below even the settled/retained geometry = a hard
      // clip; the surfΔ octave spread + leaf morph reveal the transient case the floor misses.
      if (clipDebug && mode === 'walk' && player && ++clipLogN % 20 === 0) {
        player.debugSample(_clip);
        const eyeR = _clip[0]!;
        const surf1 = _clip[1]!; // analytic surface at the collision octave count
        _rayUp.copy(playerWorld).normalize();
        _rayOrigin.copy(camera.position).addScaledVector(_rayUp, 10); // 10 m above the eye
        _rayDir.copy(_rayUp).multiplyScalar(-1);
        _ray.set(_rayOrigin, _rayDir);
        const hits = _ray.intersectObjects(manager.terrainMeshes(), false);
        let meshStr = 'none';
        let eyeMeshStr = 'none';
        if (hits.length > 0) {
          _hitWorld.copy(hits[0]!.point).add(renderOrigin);
          const hitR = _hitWorld.length();
          meshStr = (hitR - surf1).toFixed(2);
          eyeMeshStr = (eyeR - hitR).toFixed(2);
        }
        const leaf = manager.leafInfoUnder(playerWorld.x, playerWorld.y, playerWorld.z);
        const leafStr = leaf ? `d${leaf.depth} morph${leaf.morph.toFixed(2)}` : 'none';
        lastClip = `eye-mesh ${eyeMeshStr}m ${leafStr}`;
        console.log(
          `[NMS clip] spd=${player.speed().toFixed(1)} eyeAlt=${(eyeR - surf1).toFixed(2)} grnd=${_clip[8]} | ` +
            `surfΔ o14=${(_clip[2]! - surf1).toFixed(2)} o12=${(_clip[3]! - surf1).toFixed(2)} ` +
            `o10=${(_clip[4]! - surf1).toFixed(2)} o4=${(_clip[5]! - surf1).toFixed(2)} | ` +
            `fpMax=${(_clip[6]! - surf1).toFixed(2)} floorAlt=${(_clip[7]! - surf1).toFixed(2)} | ` +
            `meshHit=${meshStr} eye-mesh=${eyeMeshStr} | leaf ${leafStr}`,
        );
      }

      renderer.render(scene, camera);
    },
    streamInfo(): string {
      const s = manager.stats();
      const morph = lodMorphDebug ? `\n${manager.morphInfo()}` : ''; // ?lodmorphdebug HUD line (all modes)
      const base = `leaves ${s.live}  queue ${s.pending + s.ready}  busy ${s.inflight}  ${s.msPerLeaf.toFixed(0)} ms/leaf${morph}`;
      if (mode === 'walk' && player) {
        const dbg = clipDebug ? `  [${lastClip}]` : '';
        return `WALK  alt ${player.altitude().toFixed(1)} m  spd ${player.speed().toFixed(1)} m/s  (G: fly · click: look · 1/2/3: exit)${dbg}\n${base}`;
      }
      if (mode === 'creative' && player) {
        return `CREATIVE  alt ${player.altitude().toFixed(0)} m  spd ${player.flySpeed()} m/s  (WASD+Space/Ctrl · Shift boost · [ ]: speed · F walk · 1/2/3 exit)\n${base}`;
      }
      return `FLY  (F: walk · G: creative fly)\n${base}`;
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
