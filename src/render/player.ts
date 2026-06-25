// ─────────────────────────────────────────────────────────────────────────────
// PlayerController — Step 4 (frame system + walking).
//
// Walk the real-scale planet with stable collision and NO jitter. The player's
// canonical position `worldPos` is a planet-centered DOUBLE (body-fixed frame); the
// render shell keeps a floating origin near it so the GPU only ever sees small
// floats (CLAUDE.md §4). Gravity points to the planet center; "up" is radial.
//
// Collision is an analytic radial probe against the SAME field the mesher builds
// (core `surfaceAt`), so you stand on the true surface even before fine leaves
// stream in — no physics engine, no tunneling (slice spec §6, Step 4).
//
// STEP 5 SEAM: the planet is static here. `spinAngle()` is identity (0); Step 5
// makes it `(spinRate·t) mod 2π` (double→float) and inserts a body→world rotation
// in the render shell. Everything below is spin-invariant (the spin axis passes
// through the center, so radial up / gravity / collision are unchanged), so only
// that one function and the shell's body→world step change. This file is DOM-free
// and Three.js-only (no /core import except the pure `surfaceAt`).
// ─────────────────────────────────────────────────────────────────────────────

import { Vector3, Quaternion, Matrix4 } from 'three';
import { surfaceAt, type TerrainRecipe } from '../core/density.ts';

export interface WalkInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean; // walk: jump · fly: ascend (Space)
  sprint: boolean; // walk: run · fly: boost (Shift)
  down: boolean; // fly: descend (Ctrl); ignored in walk
}

const NO_INPUT: WalkInput = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  down: false,
};

// Tunables [T].
const G = 9.81; // gravity m/s²
const WALK = 5; // m/s
const SPRINT = 14; // m/s (Shift)
const EYE = 1.7; // eye height above terrain, m
const JUMP_V = 5; // m/s initial jump speed
const PITCH_LIMIT = Math.PI / 2 - 0.01; // avoid the exact vertical (basis degenerate)
const MOUSE_SENS = 0.0022; // rad/px
const GROUND_FOLLOW = 12; // 1/s exp-ease rate for LOD-pop ground smoothing
const GROUND_BAND = 2; // m — only ease gaps smaller than this; bigger = real fall
const MAX_DT = 0.05; // clamp dt (s) so an alt-tab hitch can't fling/tunnel
// Footprint collision [T]: the ground probe takes the MAX analytic surface over a
// small body footprint + a step-ahead point, so the eye rides OVER a slope it walks
// into instead of the single radial probe punching the camera through the uphill face.
const BODY_R = 0.4; // m — footprint half-width (player body radius)
const STEP_AHEAD = 0.5; // m — forward look-ahead probe along the move direction

// Creative-flight [T]: free-fly, no gravity/collision. A speed LADDER (m/s) cycled by
// keys so flight scales from terrain detail up to crossing the planet; Shift boosts.
const FLY_SPEEDS = [30, 100, 500, 2000, 10_000] as const;
const FLY_SPEED_DEFAULT = 1; // index into FLY_SPEEDS (→ 100 m/s)
const FLY_BOOST = 4; // Shift multiplier in fly
// Octave counts the clip-debug probe samples alongside the collision count, to
// quantify how far the surface moves per LOD level (the geomorph/streaming transient).
const DEBUG_OCTAVES = [14, 12, 10, 4] as const;

/** Spin angle of the planet at the current time. Step 4: identity. Step 5 seam. */
function spinAngle(): number {
  // Step 5: return ((planet.spinRate * gameTimeSeconds) % (2*Math.PI)) computed in
  // double, then cast to float at the GPU boundary (CLAUDE.md §4). Identity for now.
  return 0;
}

export class PlayerController {
  /** Body-fixed (planet-centered) position, meters, DOUBLE. */
  readonly worldPos = new Vector3();
  private yaw = 0; // radians around local up
  private pitch = 0; // radians, clamped
  private radialVel = 0; // m/s along up (gravity/jump axis)
  private grounded = true;
  private speedEst = 0; // m/s horizontal (for HUD)

  // Preallocated temporaries — zero per-frame allocation.
  private readonly _up = new Vector3();
  private readonly _ref = new Vector3();
  private readonly _east = new Vector3();
  private readonly _north = new Vector3();
  private readonly _fwd = new Vector3();
  private readonly _right = new Vector3();
  private readonly _look = new Vector3();
  private readonly _move = new Vector3();
  private readonly _xAxis = new Vector3();
  private readonly _yAxis = new Vector3();
  private readonly _zAxis = new Vector3();
  private readonly _m = new Matrix4();
  private readonly _quat = new Quaternion();
  private readonly _surf = new Float64Array(7);
  private readonly _probe = new Float64Array(7); // footprint sample scratch
  private readonly _moveDir = new Vector3(); // unit tangential move dir (0 when idle)
  private _centerSurfR = 0; // surface radius directly under the eye (for altitude())
  private _fpMaxR = 0; // max surface radius over the footprint (the collision floor)
  private _minGap = Infinity; // min radial eye→surface gap over the footprint (near clamp)
  private flyMode = false; // creative free-fly (no gravity/collision)
  private flySpeedIdx = FLY_SPEED_DEFAULT; // index into FLY_SPEEDS
  private readonly _dbg = new Float64Array(7); // clip-debug probe scratch (debug-only)

  constructor(
    private readonly recipe: TerrainRecipe,
    private readonly planetRadius: number,
    /**
     * Octave count for the collision probe — must match the FINEST visible mesh
     * (lodOctaves(recipe, maxDepth)), or the player hovers above / clips through
     * the fine terrain bumps. Defaults to the recipe's octaves (the old behavior).
     */
    private readonly groundOctaves?: number,
    /**
     * Optional probe of the ACTUAL RENDERED terrain height (a downward raycast against
     * the live leaf meshes, supplied by the render shell). Returns the surface radius
     * from the planet center under (x,y,z), or 0 if nothing is drawn there. During LOD
     * churn a coarser leaf can be retained/rendered metres ABOVE the fine surface the
     * analytic probe sees, so the eye sank below the visible ground; flooring to the
     * higher of analytic and rendered makes you stand on what's actually drawn.
     */
    private readonly groundProbe?: (x: number, y: number, z: number) => number,
  ) {}

  /** Place the player at a body-fixed position and settle onto the ground. */
  reset(worldPos: Vector3, yaw = 0, pitch = 0): void {
    this.worldPos.copy(worldPos);
    this.yaw = yaw;
    this.pitch = pitch;
    this.radialVel = 0;
    this.grounded = true;
    this.speedEst = 0;
    // Populate _surf/_centerSurfR + camera quaternion. Walk snaps to ground; fly stays put.
    if (this.flyMode) this.updateFly(0, NO_INPUT);
    else this.update(0, NO_INPUT);
  }

  /** Enter/leave creative free-fly (no gravity, no terrain collision). */
  setFly(on: boolean): void {
    this.flyMode = on;
  }
  /** Cycle the fly speed ladder (dir +1/−1). No-op while walking. */
  cycleSpeed(dir: number): void {
    this.flySpeedIdx = Math.max(0, Math.min(FLY_SPEEDS.length - 1, this.flySpeedIdx + Math.sign(dir)));
  }
  isFlying(): boolean {
    return this.flyMode;
  }

  /** Accumulate mouse-look (pointer-lock movementX/Y, pixels). */
  addMouse(dx: number, dy: number): void {
    this.yaw += dx * MOUSE_SENS; // mouse-right turns right
    this.pitch -= dy * MOUSE_SENS; // mouse-up looks up
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    else if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
  }

  /** Build the radial-up tangent basis (_up,_east,_north) + heading (_fwd,_right). */
  private basis(): void {
    this._up.copy(this.worldPos).normalize();
    // Least-parallel world reference axis → stable tangent frame off the poles.
    if (Math.abs(this._up.y) < 0.99) this._ref.set(0, 1, 0);
    else this._ref.set(1, 0, 0);
    this._east.crossVectors(this._ref, this._up).normalize();
    this._north.crossVectors(this._up, this._east).normalize();
    this._fwd
      .copy(this._north)
      .multiplyScalar(Math.cos(this.yaw))
      .addScaledVector(this._east, Math.sin(this.yaw))
      .normalize();
    this._right.crossVectors(this._fwd, this._up).normalize();
  }

  update(dtRaw: number, input: WalkInput): void {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_DT);
    this.basis();

    // 1. Tangential move (position-based → collision stays a pure 1-D radial problem).
    const speed = input.sprint ? SPRINT : WALK;
    this._move.set(0, 0, 0);
    if (input.forward) this._move.add(this._fwd);
    if (input.back) this._move.sub(this._fwd);
    if (input.right) this._move.add(this._right);
    if (input.left) this._move.sub(this._right);
    if (this._move.lengthSq() > 0) {
      this._move.normalize();
      this._moveDir.copy(this._move); // unit move dir for the step-ahead probe
      this._move.multiplyScalar(speed * dt);
      this.worldPos.add(this._move);
      this.speedEst = speed;
    } else {
      this._moveDir.set(0, 0, 0);
      this.speedEst = 0;
    }

    // 2. Gravity on the radial axis; re-derive up/radius after the tangential step.
    this.radialVel -= G * dt;
    const r = this.worldPos.length();
    this._up.copy(this.worldPos).multiplyScalar(1 / r);

    // 3. Footprint ground probe — conservative MAX analytic surface over a small body
    //    footprint + a step-ahead sample. A single radial probe gave only radial
    //    clearance, so on a slope the eye/near-plane punched through the uphill face
    //    (and, with DoubleSide terrain, you saw its backfaces + the inward skirts).
    //    Taking the max lifts the eye OVER an approaching rise; it never blocks descent
    //    (the footprint is ≤0.5 m and translates with you). Analytic only — never the
    //    rendered mesh — and zero per-frame allocation.
    const px = this.worldPos.x;
    const py = this.worldPos.y;
    const pz = this.worldPos.z;
    // Center sample stays in _surf — the surface directly under the eye (altitude()).
    surfaceAt(this.recipe, this.planetRadius, px, py, pz, this._surf, this.groundOctaves);
    this._centerSurfR = this._surf[0]!;
    this._fpMaxR = this._centerSurfR;
    this._minGap = r - this._centerSurfR;
    // 4-ring at body radius along ±east/±north (reuse the tangent basis), then a
    // step-ahead sample along the move dir (the key one: lifts you over a rise you're
    // walking into before the eye reaches it). surfaceAt normalizes its input, so a
    // `meters · tangentUnit` offset ≈ that arc length on the sphere.
    const e = this._east;
    const nn = this._north;
    this.probeFootprint(px, py, pz, BODY_R * e.x, BODY_R * e.y, BODY_R * e.z, r);
    this.probeFootprint(px, py, pz, -BODY_R * e.x, -BODY_R * e.y, -BODY_R * e.z, r);
    this.probeFootprint(px, py, pz, BODY_R * nn.x, BODY_R * nn.y, BODY_R * nn.z, r);
    this.probeFootprint(px, py, pz, -BODY_R * nn.x, -BODY_R * nn.y, -BODY_R * nn.z, r);
    if (this._moveDir.lengthSq() > 0) {
      const m = this._moveDir;
      this.probeFootprint(px, py, pz, STEP_AHEAD * m.x, STEP_AHEAD * m.y, STEP_AHEAD * m.z, r);
    }
    // Floor to the ACTUAL RENDERED surface when it sits above the analytic one. During
    // LOD churn a coarser leaf retained over the fine one renders metres higher; the
    // analytic footprint can't see it, so the eye sank below the visible ground. The
    // render shell's raycast returns that drawn height — take the higher of the two so
    // the eye is never below what's on screen. 0 = nothing drawn there (use analytic).
    const renderedR = this.groundProbe ? this.groundProbe(px, py, pz) : 0;
    if (renderedR > this._fpMaxR) this._fpMaxR = renderedR;
    const groundR = this._fpMaxR + EYE;

    // 4. Integrate radius; hard floor at the ground (never penetrate).
    let newR = r + this.radialVel * dt;
    if (newR <= groundR) {
      newR = groundR;
      this.radialVel = Math.max(0, this.radialVel); // keep upward (jump) vel, kill fall
      this.grounded = true;
    } else {
      this.grounded = false;
    }
    // 5. Ground-follow: ease small positive gaps so LOD detail popping under you
    //    doesn't stair-step the eye (the hard floor above still prevents sinking).
    if (this.grounded && newR > groundR && newR - groundR < GROUND_BAND) {
      newR += (groundR - newR) * (1 - Math.exp(-GROUND_FOLLOW * dt));
    }
    // 6. Jump.
    if (input.jump && this.grounded) {
      this.radialVel = JUMP_V;
      this.grounded = false;
    }
    // 7. Write the radius back along up.
    this.worldPos.copy(this._up).multiplyScalar(newR);

    // 8. Camera orientation at the final position.
    this.orient();
    void spinAngle(); // Step 5 seam (identity now) — keep referenced for clarity.
  }

  /**
   * Rebuild the basis at the current position and set _look + the camera quaternion
   * from yaw/pitch. An EXPLICIT basis → quaternion (NOT camera.lookAt, which recomputes
   * its own up and reintroduces roll); xAxis ⟂ up pins the horizon level. Shared by
   * the walk and fly update paths.
   */
  private orient(): void {
    this.basis();
    this._look
      .copy(this._fwd)
      .multiplyScalar(Math.cos(this.pitch))
      .addScaledVector(this._up, Math.sin(this.pitch))
      .normalize();
    this._zAxis.copy(this._look).multiplyScalar(-1); // camera looks down −Z
    this._xAxis.crossVectors(this._up, this._zAxis).normalize(); // screen-right, ⟂ up → level
    this._yAxis.crossVectors(this._zAxis, this._xAxis).normalize();
    this._m.makeBasis(this._xAxis, this._yAxis, this._zAxis);
    this._quat.setFromRotationMatrix(this._m);
  }

  /**
   * Creative free-fly update: move in the LOOK direction (W/S) + right (A/D) + radial
   * (Space up, Ctrl down), at the current speed ladder × Shift boost. NO gravity, NO
   * surfaceAt floor, NO collision — you pass through terrain (that's the point). We
   * still sample the surface once for the altitude() HUD readout. Zero per-frame alloc.
   */
  updateFly(dtRaw: number, input: WalkInput): void {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_DT);
    this.basis();
    // Look direction (yaw heading tilted by pitch) — fly moves along the full 3-D look.
    this._look
      .copy(this._fwd)
      .multiplyScalar(Math.cos(this.pitch))
      .addScaledVector(this._up, Math.sin(this.pitch))
      .normalize();
    const speed = FLY_SPEEDS[this.flySpeedIdx]! * (input.sprint ? FLY_BOOST : 1);
    this._move.set(0, 0, 0);
    if (input.forward) this._move.add(this._look);
    if (input.back) this._move.sub(this._look);
    if (input.right) this._move.add(this._right);
    if (input.left) this._move.sub(this._right);
    if (input.jump) this._move.add(this._up); // ascend
    if (input.down) this._move.sub(this._up); // descend
    if (this._move.lengthSq() > 0) {
      this._move.normalize().multiplyScalar(speed * dt);
      this.worldPos.add(this._move);
      this.speedEst = speed;
    } else {
      this.speedEst = 0;
    }
    this.radialVel = 0; // no gravity in fly; reset so re-entering walk doesn't inherit a fall
    this.grounded = false;
    // Surface under the eye, for the altitude() HUD only (does not affect movement).
    surfaceAt(
      this.recipe, this.planetRadius,
      this.worldPos.x, this.worldPos.y, this.worldPos.z,
      this._surf, this.groundOctaves,
    );
    this._centerSurfR = this._surf[0]!;
    this._fpMaxR = this._centerSurfR; // so altitude() (eye above surface) works in fly too
    this.orient();
    void spinAngle(); // Step 5 seam (identity now)
  }

  /**
   * Sample the analytic surface at (p + offset) and fold it into the footprint
   * maximum (`_fpMaxR`, the collision floor) and the minimum radial eye→surface gap
   * (`_minGap`, the near clamp). Zero per-call allocation (writes shared `_probe`).
   */
  private probeFootprint(
    px: number,
    py: number,
    pz: number,
    ox: number,
    oy: number,
    oz: number,
    r: number,
  ): void {
    surfaceAt(
      this.recipe,
      this.planetRadius,
      px + ox,
      py + oy,
      pz + oz,
      this._probe,
      this.groundOctaves,
    );
    const sr = this._probe[0]!;
    if (sr > this._fpMaxR) this._fpMaxR = sr;
    const gap = r - sr;
    if (gap < this._minGap) this._minGap = gap;
  }

  getWorldPos(out: Vector3): void {
    out.copy(this.worldPos);
  }
  getQuaternion(out: Quaternion): void {
    out.copy(this._quat);
  }
  getForward(out: Vector3): void {
    out.copy(this._look);
  }
  /** Eye height above the local terrain surface (≈ EYE when grounded), meters. */
  altitude(): number {
    return this.worldPos.length() - this._fpMaxR; // eye above the floor we stand on (≈ EYE)
  }
  /** Eye height above the mean radius (datum), meters. */
  altitudeAboveDatum(): number {
    return this.worldPos.length() - this.planetRadius;
  }
  speed(): number {
    return this.speedEst;
  }
  isGrounded(): boolean {
    return this.grounded;
  }
  /** Smallest radial eye→surface gap across the footprint this frame, meters. */
  nearestSurfaceGap(): number {
    return this._minGap;
  }
  /** Current fly speed (m/s), before Shift boost — for the HUD. */
  flySpeed(): number {
    return FLY_SPEEDS[this.flySpeedIdx]!;
  }
  /**
   * Clip-debug snapshot for the `?clipdebug` console line (debug path only). Writes,
   * into `out` (length ≥ 11):
   *   0 eyeR · 1 surfR@collisionOct · 2..5 surfR@[14,12,10,4] · 6 fpMaxR ·
   *   7 groundR(=fpMax+EYE) · 8 grounded · 9 radialVel · 10 minGap
   * The 2..5 spread vs. 1 quantifies how far the surface moves per LOD level (the
   * geomorph/streaming transient the collision floor doesn't track). Uses _dbg scratch.
   */
  debugSample(out: Float64Array): void {
    const x = this.worldPos.x, y = this.worldPos.y, z = this.worldPos.z;
    out[0] = Math.sqrt(x * x + y * y + z * z);
    out[1] = this._centerSurfR;
    for (let i = 0; i < DEBUG_OCTAVES.length; i++) {
      surfaceAt(this.recipe, this.planetRadius, x, y, z, this._dbg, DEBUG_OCTAVES[i]!);
      out[2 + i] = this._dbg[0]!;
    }
    out[6] = this._fpMaxR;
    out[7] = this._fpMaxR + EYE;
    out[8] = this.grounded ? 1 : 0;
    out[9] = this.radialVel;
    out[10] = this._minGap;
  }
}
