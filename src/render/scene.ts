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
  Quaternion,
  Group,
  Raycaster,
  DoubleSide,
  ACESFilmicToneMapping,
} from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  EARTH_RADIUS_M, MOON_RADIUS_M, SUN_RADIUS_M,
  EARTH_SIDEREAL_DAY_S, EARTH_AXIAL_TILT_RAD, TIME_COMPRESSION,
} from '../core/constants.ts';
import { sliceEarthOrbit, sliceMoonOrbit, orbitalPosition, spinAngle } from '../core/orbits.ts';
import { buildCubeSphere } from '../core/cubesphere.ts';
import { sliceTerrainRecipe, surfaceAt, lodOctaves } from '../core/density.ts';
import { sliceFacts } from '../core/facts.ts';
import { childSeed, SALT } from '../core/seedchain.ts';
import { QuadtreeManager } from './quadtreeManager.ts';
import { PlayerController, type WalkInput } from './player.ts';
import { createAtmosphere } from './atmosphere.ts';

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

// HUD distance formatter: m → km → AU, so the Moon/Sun readouts stay legible across scales.
const fmtDist = (m: number): string =>
  m >= 1e9 ? `${(m / 1.495978707e11).toFixed(3)} AU` : m >= 1000 ? `${Math.round(m / 1000)} km` : `${Math.round(m)} m`;

// Finest quadtree depth. At Earth radius: depth 15 ≈ 9.5 m cells underfoot (depth
// 14 ≈ 19 m, 16 ≈ 4.8 m) — enough near-field detail that walking shows parallax.
// Paired with LOD-adaptive octaves (density.lodOctaves) so the fine cells actually
// carry meter-scale content. [T] dial DOWN (15→14→…) if the surface drops below 60 fps.
const MAX_DEPTH = 15;
// Always-resident coarse base depth. The whole sphere is kept meshed at this depth (6·4^d
// leaves: depth 2 = 96, ~half always-resident on the far side) with NO horizon/cone cull,
// so every finer leaf morphs from a real parent — detail sharpens in, no "fresh over
// backdrop" pop when a region rotates/streams into view. Bounded + cheap; [T] dial down to
// 1 (24 leaves) for more headroom, up for a finer always-present base (more far-side mesh).
const BASE_DEPTH = 2;
// Walk-mode forward-cone half-angle multiplier over the frustum corners (a touch
// wider than fly's 1.2 so a turn has slack before the recut-on-rotation fires).
const WALK_CONE_MARGIN = 1.4;
// Walk-mode: re-cut the streaming cone when the view turns past this much, so the
// cone follows the look direction (translation alone would leave stale/blank tiles
// after a turn). Kept under the cone's slack so the frustum never outruns the cut.
const RECUT_ROT_COS = Math.cos((20 * Math.PI) / 180);
// Time-based recut floor: while the camera is MOVING, re-cut at least this often even if it
// hasn't crossed recutDist. At altitude recutDist is ~2% of distance (hundreds of km), so a
// SLOW descent could hold a stale cut for many seconds, then jump — a wave. A periodic recut
// keeps the leaf set tracking continuously (the per-vertex morph is already per-frame; this
// just keeps the SET fresh). Gated on actual movement so a still camera never recuts (and the
// headless settle check still settles). Fast motion crosses recutDist first → this is a no-op.
const RECUT_MAX_MS = 300;
const RECUT_MIN_MOVE_M = 1;
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
// down if a fast descent dips below 60 fps.
const PREFETCH_S = 0.7;
// ALTITUDE-RELATIVE prefetch cap. The CDLOD morph band scales with altitude (thousands of km at
// orbit, hundreds near the surface). Cap the lead at a FRACTION of altitude so it's a meaningful
// slice of the band, but bound it tightly: CEIL is 20 km (was 200 km — that, combined with the
// spurious millions-m/s approach from orbit zoom, ballooned the cut to ~500 leaves and was the main
// "laggy" churn). With `approach` now clamped to APPROACH_MAX_MPS the lead self-bounds anyway.
const PREFETCH_MAX_FRAC = 0.35;
const PREFETCH_FLOOR_M = 3000;
const PREFETCH_CEIL_M = 20_000;
// EMA smoothing for the approach-rate estimate (per-frame blend of the new sample), so a
// single jittery frame-time doesn't swing the prefetch distance. ~0.15 ≈ a few-frame lag.
const APPROACH_EMA = 0.15;
// Sanity bounds on the approach-rate estimate (the fix for the orbit-zoom millions-of-m/s spike).
// APPROACH_MAX_MPS caps the per-frame closing rate to a plausible DESCENT speed (5 km/s) so a fast
// scroll-zoom can't pin prefetch and balloon the cut; APPROACH_DT_MAX_MS ignores frames slower than
// ~10 fps (a stall/tab-switch) whose rate would be garbage.
const APPROACH_MAX_MPS = 5000;
const APPROACH_DT_MAX_MS = 100;

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
  // ?lodaudit: SUPERSET — also emits [NMS audit] (per-edge seam Δeff+gap, screen coverage/holes,
  //   morph histogram, recut cadence, stream/worker health, prefetch-vs-band, wiring sanity). The
  //   comprehensive pipeline view: confirms WHERE/WHY detail isn't gradual before we change anything.
  // ?morphcolor: tint leaves red→green by geomorph progress so LOD pop-in is visible to screenshot.
  const lodAudit = params.has('lodaudit');
  const lodMorphDebug = params.has('lodmorphdebug') || lodAudit; // audit implies the morph line too
  const morphColor = params.has('morphcolor');
  // ?perf: cheap per-frame cost breakdown — times update()/uploadReady()/tick() and logs any frame
  //   where one spikes, plus the raw approach/prefetch inputs. This is what reveals "high fps but
  //   laggy" (the overlay smooths spikes; this catches the spike + says which stage caused it).
  // ?seamscan: OPT-IN the O(live²) seam scan + O(96·live) coverage scan (they used to run under
  //   ?lodaudit and, at ~500 live leaves, were a periodic main-thread spike — i.e. the diagnostics
  //   themselves added lag). Off by default now so ?perf/?lodaudit measure WITHOUT perturbing.
  const perf = params.has('perf');
  const seamScan = params.has('seamscan');
  // Step 5 (real spin/orbit): ?timescale=N overrides the base game-time multiplier (how fast a
  // day/orbit passes while testing); ?notime freezes the clock for A/B; ?noshadow disables the
  // moon's cast shadow (so a shadow-path issue can't block the rest of Step 5).
  const timeScale = (() => {
    const v = parseFloat(params.get('timescale') ?? '');
    return Number.isFinite(v) && v >= 0 ? v : TIME_COMPRESSION;
  })();
  const noTime = params.has('notime');
  const noShadow = params.has('noshadow');
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: useWebGL,
    logarithmicDepthBuffer: useLog,
    reversedDepthBuffer: useRevz,
  });
  // Pixel ratio (fill-rate lever): on a HiDPI/Retina display devicePixelRatio is 2, so we shade 4× the
  // fragments — the dominant cost when the terrain shader fills the viewport. ?dpr=N overrides the cap so we
  // can measure/trade fragment cost vs sharpness. Default cap 1.5: on a Retina (devicePixelRatio 2) display
  // that's ~44% fewer fragments than 2.0 while staying sharp; 1× displays are unaffected (min(1,1.5)=1).
  // ?dpr=2 restores full sharpness, ?dpr=1 is max perf.
  const dprCap = (() => {
    const v = parseFloat(params.get('dpr') ?? '');
    return Number.isFinite(v) && v > 0 ? v : 1.5;
  })();
  const effPixelRatio = Math.min(window.devicePixelRatio, dprCap);
  renderer.setPixelRatio(effPixelRatio);
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
  console.log('[NMS] pixelRatio:', { devicePixelRatio: window.devicePixelRatio, cap: dprCap, effective: effPixelRatio });
  console.log('[NMS] debug toggles:', {
    noback: params.has('noback'),
    wire: params.has('wire'),
    lodcolor: params.has('lodcolor'),
    skirtcolor: params.has('skirtcolor'),
    skirt: params.has('skirt'), // skirts default OFF now; ?skirt re-enables for A/B
    clipdebug: clipDebug, // ?clipdebug: walk collision-vs-rendered-mesh logging
    lodmorphdebug: lodMorphDebug, // ?lodmorphdebug: geomorph staggering/imbalance logging
    lodaudit: lodAudit, // ?lodaudit: full pipeline diagnostics ([NMS audit] seam/coverage/cadence/…)
    morphcolor: morphColor, // ?morphcolor: tint leaves by geomorph progress (LOD pop-in visible)
    perf, // ?perf: per-frame cost breakdown + approach/prefetch/churn ([NMS perf])
    seamscan: seamScan, // ?seamscan: opt-in the O(live²) seam/coverage scans (off by default)
    dark: params.has('dark'),
    timeScale, // Step 5: game-time multiplier (?timescale=N; TIME_COMPRESSION default)
    noTime, // ?notime: freeze the spin/orbit clock
    noShadow, // ?noshadow: disable the moon's cast shadow
    noatmo: params.has('noatmo'), // ?noatmo: hide the Step 6 atmosphere shell (A/B)
  });

  const R = EARTH_RADIUS_M;

  const scene = new Scene();
  scene.background = new Color(0x05070d);

  // Step 5: the planet (terrain + backdrop) lives under this group, whose quaternion = the planet's
  // real spin each frame — so the planet is a REAL spinning body (visible turning from orbit), not a
  // faked moving light. The Sun/Moon stay on `scene` (inertial), so day/night = real geometry.
  const planetGroup = new Group();
  scene.add(planetGroup);

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
  // The terrain material is now owned by the manager (createTerrainMaterial): ONE shared, fully
  // OPAQUE, double-sided MeshStandardNodeMaterial whose per-vertex CDLOD morph lerps each vertex
  // morphTarget→position (and its normal) as a function of camera distance — so detail resolves in
  // with a single opaque surface, no dither, no two surfaces at once. Per-leaf data rides in the
  // `aLodR`/`aParentR` attributes, so there is no per-leaf material clone.
  // splitPx 300 (smaller, gentler LOD steps — affordable after the ~13× meshing
  // speedup); maxDepth = MAX_DEPTH gives meter-scale near-field cells for walking.
  const manager = new QuadtreeManager(planetGroup, recipe, R, {
    splitPx: FLY_SPLIT_PX,
    maxDepth: MAX_DEPTH,
    wireframe: params.has('wire'), // debug: see the tessellation / where lines fall
    // ?slopeband=N: pick a slope-band "look" preset (0=current/hard, 1=wide, 2=low-contrast, 3=soft).
    // Render-only cosmetic; default 0 leaves today's look unchanged.
    slopePreset: Number(params.get('slopeband')) || 0,
    // ?nodetail: GPU probe — build the terrain material WITHOUT the two per-pixel mx_noise_vec3 (+ mottle
    // + normal perturbation). If this collapses gpu/other, the procedural noise is the fill-rate cost.
    noDetail: params.has('nodetail'),
    // Always-resident coarse base: the whole sphere stays meshed at BASE_DEPTH so every
    // finer leaf morphs from a real parent (no fresh-over-backdrop pop). The static inset
    // backdrop stays as the ultimate below-everything filler (startup / frustum-edge gaps).
    baseDepth: BASE_DEPTH,
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
    debugAudit: lodAudit,
    debugSeamScan: seamScan, // the O(live²) seam + coverage scans only run when ?seamscan is set
    debugChurn: perf, // count meshes created/disposed per second for the [NMS perf] line
    receiveShadow: !noShadow, // Step 5: terrain leaves receive the moon's cast shadow (real-GPU confirm)
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
  planetGroup.add(backdrop); // co-rotates with the planet (centered at planet center)

  // ── Step 6 (S1): atmosphere shell ──────────────────────────────────────────
  // A planet-centered sky shell whose analytic scatter (Rayleigh blue + limb/horizon
  // brightening + sun halo) reads as a glowing limb from orbit and as blue sky from the
  // surface, both from the SAME real `_sunDir`. It lives on `scene` (NOT planetGroup) — an
  // unspun inertial shell positioned at the planet centre (= scene `−_spunOrigin`) each frame,
  // exactly like the Sun/Moon bodies. ?noatmo hides it for A/B. The black `scene.background`
  // stays: the additive shell only covers the planet+sky region, space elsewhere is black.
  const atmosphere = createAtmosphere(R);
  atmosphere.mesh.visible = !params.has('noatmo');
  scene.add(atmosphere.mesh);

  // ── Step 5: real spin + orbit (day/night, moving sun, moon, optional cast shadow) ──
  // The RENDER frame stays PLANET-CENTERED (terrain/player body-fixed, planet at the origin, NEVER
  // translated — so no AU-scale double reaches the GPU, and the planet can't "rocket away" on launch:
  // the launch handoff is satisfied by construction). Day/night + the sun's seasonal drift come from the
  // SUN DIRECTION only: heliocentric planet position → planet→sun direction in the inertial/ecliptic
  // frame, rotated into the body frame by the INVERSE spin about the tilted axis. As the spin angle
  // advances the sun sweeps the sky (real day/night, NOT a moved light); as the planet orbits over the
  // year that direction drifts (the sun "moves over the orbit"). The Sun/Moon are rendered as proxies
  // along their true body-frame directions (the real bodies are AU / 3.8e8 m away, beyond any far plane).
  const earthEl = sliceEarthOrbit();
  const moonEl = sliceMoonOrbit();
  const EARTH_SPIN_RATE = (2 * Math.PI) / EARTH_SIDEREAL_DAY_S; // rad/s (sidereal)
  // Spin axis in the inertial/ecliptic frame: the pole tilted by the obliquity (in the x–y plane).
  const spinAxis = new Vector3(Math.sin(EARTH_AXIAL_TILT_RAD), Math.cos(EARTH_AXIAL_TILT_RAD), 0).normalize();
  let gameTimeS = 0;
  // The DirectionalLight is parallel (only its DIRECTION matters); placed this far along the real Sun
  // direction so the optional shadow camera stays sane. The VISIBLE Sun/Moon are placed at their TRUE
  // planet-centered distances (R2) so you can fly to them — not at this proxy distance.
  const SUN_PROXY_DIST = 5000;
  const _planetPos = new Float64Array(3);
  const _moonPos = new Float64Array(3);
  const _sunDir = new Vector3(); // REAL inertial planet→sun direction (no spin applied — terrain spins instead)
  const _qSpin = new Quaternion(); // planet spin: body → inertial (+theta about the tilted axis)
  const _qSpinInv = new Quaternion(); // inertial → body (for the body-fixed cut camera in fly/orbit)
  const _skyV = new Vector3();
  const _spunOrigin = new Vector3(); // renderOrigin rotated by qSpin, for the slope-band `up` uniform
  let hudDistMoon = 0; // true camera→body distances (scene space), for the HUD readout
  let hudDistSun = 0;

  const skyGeo = (radius: number): BufferGeometry => {
    const s = buildCubeSphere(8, radius);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(s.positions, 3));
    g.setAttribute('normal', new BufferAttribute(s.normals, 3));
    g.setIndex(new BufferAttribute(s.indices, 1));
    return g;
  };
  // Sol disc — unlit emissive billboard, drawn behind terrain (depthTest off + renderOrder −2) so it
  // reads as a sky element and is occluded by the horizon; scaled per frame to the sun's real angular size.
  const sunDiscGeo = skyGeo(1);
  const sunDiscMat = new MeshBasicNodeMaterial({ color: 0xfff4e6 });
  sunDiscMat.depthTest = false;
  const sunDisc = new Mesh(sunDiscGeo, sunDiscMat);
  sunDisc.renderOrder = -2;
  sunDisc.frustumCulled = false;
  scene.add(sunDisc);
  // Moon — a lit sphere along the true Moon direction; castShadow so it can eclipse the terrain
  // (the Step 5 "real cast shadow" gate). Gated by !noShadow.
  const moonGeo = skyGeo(1);
  const moonMat = new MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 1, metalness: 0 });
  const moon = new Mesh(moonGeo, moonMat);
  moon.frustumCulled = false;
  moon.castShadow = !noShadow;
  scene.add(moon);

  // Cast-shadow setup (?noshadow disables). ⚠ NEEDS REAL-GPU CONFIRM: the terrain material overrides
  // positionNode (CDLOD morph) + is DoubleSide, so the shadow-depth pass may not match the rendered
  // surface; the analytic sun-occlusion fallback is plan B. The proxy distances put the moon (4 km)
  // between the sun light (5 km) and the terrain (origin), so an eclipse casts a real umbra near the player.
  if (!noShadow) {
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.near = 1;
    sc.far = SUN_PROXY_DIST * 2;
    sc.left = -8000;
    sc.right = 8000;
    sc.top = 8000;
    sc.bottom = -8000;
    sun.shadow.bias = -0.0005;
  }

  // Advance the clock + place the sun/moon each frame (driven from render()).
  function updateSky(dtMs: number): void {
    if (!noTime) gameTimeS += (dtMs / 1000) * timeScale;
    // Planet spin: body → inertial, +theta about the tilted axis. The render shell applies this to
    // planetGroup so the planet REALLY rotates (no light-rotation trick); day/night then falls out of
    // the real sun direction below sweeping across the spinning surface.
    _qSpin.setFromAxisAngle(spinAxis, spinAngle(EARTH_SPIN_RATE, gameTimeS));

    // Orbital state (planet-centered INERTIAL frame): the planet's heliocentric position (so the Sun is
    // at −_planetPos relative to the planet) and the Moon's geocentric position. The Sun/Moon MESHES are
    // placed at these true positions in render() (after the floating origin is known); here we just keep
    // the data + the REAL parallel-light direction (drives day/night on the spinning terrain).
    orbitalPosition(earthEl, gameTimeS, _planetPos);
    orbitalPosition(moonEl, gameTimeS, _moonPos);
    _skyV.set(-_planetPos[0]!, -_planetPos[1]!, -_planetPos[2]!);
    if (_skyV.lengthSq() < 1e-12) _skyV.set(1, 0, 0);
    _sunDir.copy(_skyV).normalize();
    sun.position.copy(_sunDir).multiplyScalar(SUN_PROXY_DIST); // DirectionalLight: direction only
  }

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
  let lastCutTime = 0; // performance.now() of the last recut (time-based recut floor)
  const lastCutForward = new Vector3(); // walk: look dir at the last cut (recut-on-rotation)
  const prevWorldCam = new Vector3();
  // Speed-aware prefetch: smoothed rate (m/s) at which the camera is closing on the planet
  // centre (positive = descending). prevDistCenter seeds the per-frame delta; both are reset
  // on every teleport (preset switch / enter walk/creative) so a jump isn't read as a descent.
  let approachRateEMA = 0;
  let prevDistCenter = -1;
  // ?perf state: per-window maxima of each main-thread stage's cost (ms) + the raw approach inputs,
  // logged as [NMS perf] every ~30 frames. The frame dt itself is on the HUD (Stats); this says
  // WHICH stage is heavy when a spike happens (recut vs upload vs tick vs GPU/other).
  let perfN = 0;
  let perfMaxUpd = 0, perfMaxUp = 0, perfMaxTick = 0, perfMaxDt = 0;
  let perfLastInst = 0, perfLastPrefetch = 0;

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
    approachRateEMA = 0;
    prevDistCenter = -1; // teleport is not a descent → don't prefetch a burst the next frame
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
    approachRateEMA = 0;
    prevDistCenter = -1; // spawn teleport is not a descent
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
    approachRateEMA = 0;
    prevDistCenter = -1; // spawn teleport is not a descent
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

      updateSky(dt); // Step 5: advance the clock + place the sun/moon (day/night from real spin)

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

      // Step 5: the terrain renders under planetGroup(qSpin) (a real spinning body). Derive the
      // BODY-FIXED camera position (worldCam) the cut/streaming use (terrain is body-fixed), place the
      // camera to match the spun frame, and feed the slope-band `up` the spun origin.
      const playerCam = (mode === 'walk' || mode === 'creative') && player !== null;
      _qSpinInv.copy(_qSpin).invert();
      if (playerCam) {
        // camera.position is still body-relative (playerWorld − renderOrigin); body-fixed cut pos = +origin.
        worldCam.copy(camera.position).add(renderOrigin);
        // Co-rotate the camera into the inertial frame so a surface walker turns WITH the planet (the
        // ground looks static, the sun moves) instead of the terrain sliding under a fixed camera.
        camera.position.applyQuaternion(_qSpin);
        camera.quaternion.premultiply(_qSpin);
      } else {
        // OrbitControls camera is an inertial observer of the spinning planet; un-spin to body-fixed.
        worldCam.copy(camera.position).applyQuaternion(_qSpinInv).add(renderOrigin);
      }
      planetGroup.quaternion.copy(_qSpin);
      _spunOrigin.copy(renderOrigin).applyQuaternion(_qSpin);
      manager.setSpunOrigin([_spunOrigin.x, _spunOrigin.y, _spunOrigin.z]);
      // S1: the atmosphere shell sits at the planet centre (scene `−_spunOrigin`, same frame as the
      // Sun/Moon bodies) and consumes the REAL inertial sun direction — so day/night + the sun halo
      // come from the same geometry as the lit terrain (no separate sky light).
      atmosphere.mesh.position.set(-_spunOrigin.x, -_spunOrigin.y, -_spunOrigin.z);
      atmosphere.sunDir.value.copy(_sunDir);
      // R2: place the Sun + Moon as REAL bodies at their true planet-centered inertial positions, in
      // scene space (= inertialPC − spunOrigin), at real radii. From the planet they're tiny discs at the
      // correct angular size + direction; in creative (G) the floating origin rides the camera, so flying
      // out toward one makes it GROW from a dot into a real body (no proxies). Doubles → small float.
      sunDisc.position.set(-_planetPos[0]! - _spunOrigin.x, -_planetPos[1]! - _spunOrigin.y, -_planetPos[2]! - _spunOrigin.z);
      sunDisc.scale.setScalar(SUN_RADIUS_M);
      moon.position.set(_moonPos[0]! - _spunOrigin.x, _moonPos[1]! - _spunOrigin.y, _moonPos[2]! - _spunOrigin.z);
      moon.scale.setScalar(MOON_RADIUS_M);
      // True camera→body distances (both in scene space) for the HUD — so flight progress is legible.
      hudDistMoon = camera.position.distanceTo(moon.position);
      hudDistSun = camera.position.distanceTo(sunDisc.position);
      vel.copy(worldCam).sub(prevWorldCam); // world units / frame (body-fixed)
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
      // (descent rate, m/s, EMA-smoothed). ~0 for lateral orbit/walk, large on a plunge — finer
      // leaves are requested early ONLY when actually approaching. CRITICAL FIX: the orbit camera's
      // drag/zoom moves the camera thousands of km in ONE frame, which read as MILLIONS of m/s
      // (logged approach up to ±41,000,000) and pinned prefetch to its ceiling → the cut ballooned
      // to ~500 leaves and thrashed (the "laggy" churn). So (a) ignore abnormal dt (a stall /
      // tab-switch makes the rate garbage), and (b) CLAMP the instantaneous rate to a sane descent
      // speed so a scroll-wheel zoom can't balloon the cut. Teleports already reset prevDistCenter.
      if (dt > 0 && dt < APPROACH_DT_MAX_MS && prevDistCenter >= 0) {
        let inst = (prevDistCenter - distCenter) / (dt / 1000);
        if (inst > APPROACH_MAX_MPS) inst = APPROACH_MAX_MPS;
        else if (inst < -APPROACH_MAX_MPS) inst = -APPROACH_MAX_MPS;
        approachRateEMA += (inst - approachRateEMA) * APPROACH_EMA;
        perfLastInst = inst; // raw (clamped) per-frame rate, for the [NMS perf] line
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
      // S1 + R2: push `far` out to reach the sky elements in EVERY mode — first the atmosphere shell,
      // then the real Sun/Moon (~1 AU) — so the sky (blue limb, sun halo, sun disc, moon) is consistent
      // whether walking, flying, or in orbit (seamless surface↔space, the project goal). Logarithmic depth
      // (default on) keeps the cm-scale surface crisp across the huge range; the previous build held WALK's
      // far short out of caution, but the overhead sky needs the reach and log depth makes it safe. ⚠
      // GPU-tune: if terrain z-fights at the big far-plane, split the far bodies into a layered pass (plan §4).
      const atmFar = camera.position.distanceTo(atmosphere.mesh.position) + atmosphere.radius;
      if (atmFar > camera.far) camera.far = atmFar;
      const sunFar = Math.hypot(
        sunDisc.position.x - camera.position.x,
        sunDisc.position.y - camera.position.y,
        sunDisc.position.z - camera.position.z,
      ) + SUN_RADIUS_M * 4;
      if (sunFar > camera.far) camera.far = sunFar;
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
      // Time-based recut floor: keep the leaf set tracking a slow descent continuously when
      // recutDist (huge at altitude) wouldn't trip for many seconds. Only while actually moving.
      const timeRecut = moved > RECUT_MIN_MOVE_M && now - lastCutTime > RECUT_MAX_MS;
      // Recut-while-refining: gated incremental refinement admits only ONE level deeper than what's live
      // per recut, so after a hard zoom (or zoom-then-STOP, where moved≈0 and timeRecut never trips) the
      // detail front would freeze one level in. Keep firing recuts every RECUT_MAX_MS while the manager
      // reports the front is still climbing; it stops on its own once the cut reaches its target depth.
      const refineRecut = manager.isRefining() && now - lastCutTime > RECUT_MAX_MS;
      if (forceCut || moved > recutDist || turned || timeRecut || refineRecut) {
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
        // Lead distance = descent speed × lead time, capped at a fraction of altitude so it's a
        // meaningful slice of the (altitude-scaled) morph band at ANY height — not the negligible
        // flat 6 km it used to be up high. 0 when not approaching (no wasted leaves at rest).
        const altitude = Math.max(1, distCenter - R);
        const prefetchCap = Math.min(PREFETCH_CEIL_M, Math.max(PREFETCH_FLOOR_M, PREFETCH_MAX_FRAC * altitude));
        const prefetchM = Math.min(prefetchCap, Math.max(0, approachRateEMA) * PREFETCH_S);
        perfLastPrefetch = prefetchM;
        const tU = perf ? performance.now() : 0;
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
        if (perf) perfMaxUpd = Math.max(perfMaxUpd, performance.now() - tU);
        lastCutPos.copy(worldCam);
        lastCutTime = now;
        forceCut = false;
      }
      // Drain finished meshes onto the GPU under the per-frame budget (the only
      // generation cost in-frame; generation itself ran on the worker pool). Burst the
      // budget until the view first reaches full coverage (incomplete screen → hitch
      // invisible), then settle to UPLOAD_PER_FRAME for hitch-free steady state.
      const tUp = perf ? performance.now() : 0;
      manager.uploadReady(firstFillDone ? UPLOAD_PER_FRAME : BURST_PER_FRAME);
      if (perf) perfMaxUp = Math.max(perfMaxUp, performance.now() - tUp);
      if (!firstFillDone) {
        const s = manager.stats();
        if (s.live > 0 && s.pending === 0 && s.inflight === 0 && s.ready === 0) firstFillDone = true;
      }
      const tT = perf ? performance.now() : 0;
      manager.tick(dt); // advance LOD geomorphs
      if (perf) perfMaxTick = Math.max(perfMaxTick, performance.now() - tT);

      // [NMS perf] — the breakdown that separates a real stutter's CAUSE. The HUD (Stats) shows the
      // worst frame dt; this says WHICH main-thread stage spiked (recut/upload/tick) vs GPU/other
      // (= dt minus the measured stages), plus the live leaf count (= draw calls) and the
      // approach/prefetch inputs that drive cut size. Throttled to ~every 30 frames.
      if (perf) {
        if (dt > perfMaxDt) perfMaxDt = dt;
        if (++perfN >= 30) {
          const s = manager.stats();
          const measured = perfMaxUpd + perfMaxUp + perfMaxTick;
          console.log(
            `[NMS perf] worstDt=${perfMaxDt.toFixed(1)}ms | recut=${perfMaxUpd.toFixed(1)} ` +
              `upload=${perfMaxUp.toFixed(1)} tick=${perfMaxTick.toFixed(1)} gpu/other≈${Math.max(0, perfMaxDt - measured).toFixed(1)}ms | ` +
              `live=${s.live}draws churn=${manager.churnPerSec()}/s | ` +
              `approach=${(approachRateEMA / 1000).toFixed(1)}km/s inst=${(perfLastInst / 1000).toFixed(1)}km/s ` +
              `prefetch=${(perfLastPrefetch / 1000).toFixed(1)}km`,
          );
          perfN = 0;
          perfMaxUpd = perfMaxUp = perfMaxTick = perfMaxDt = 0;
        }
      }

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
      // Step 5 time readout: elapsed game-days, time-of-day from the spin angle (h), orbit fraction (%).
      const days = gameTimeS / 86_400;
      const dayH = (spinAngle(EARTH_SPIN_RATE, gameTimeS) / (2 * Math.PI)) * 24;
      const yearPct = ((gameTimeS / earthEl.period) % 1) * 100;
      const sky = `sky  t ${days.toFixed(2)}d  spin ${dayH.toFixed(1)}h  orbit ${yearPct.toFixed(1)}%${noTime ? ' (frozen)' : ''}`;
      const base = `leaves ${s.live}  queue ${s.pending + s.ready}  busy ${s.inflight}  ${s.msPerLeaf.toFixed(0)} ms/leaf${morph}\n${sky}`;
      if (mode === 'walk' && player) {
        const dbg = clipDebug ? `  [${lastClip}]` : '';
        return `WALK  alt ${player.altitude().toFixed(1)} m  spd ${player.speed().toFixed(1)} m/s  (G: fly · click: look · 1/2/3: exit)${dbg}\n${base}`;
      }
      if (mode === 'creative' && player) {
        const spd = player.flySpeed();
        const spdStr = spd >= 1000 ? `${(spd / 1000).toFixed(0)} km/s` : `${spd.toFixed(0)} m/s`;
        return (
          `CREATIVE  alt ${fmtDist(player.altitudeAboveDatum())}  cruise ${spdStr}  ·  Moon ${fmtDist(hudDistMoon)}  Sun ${fmtDist(hudDistSun)}` +
          `  (WASD+Space/Ctrl · Shift boost · [ ] throttle · F walk · 1/2/3 exit)\n${base}`
        );
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
      manager.dispose(); // disposes the shared terrain material it owns
      controls.dispose();
      backdropGeo.dispose();
      backdropMaterial.dispose();
      sunDiscGeo.dispose();
      sunDiscMat.dispose();
      moonGeo.dispose();
      moonMat.dispose();
      atmosphere.dispose();
      renderer.dispose();
    },
  };
}
