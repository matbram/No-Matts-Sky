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
// STEP 5 (now live in the render shell): real spin/orbit is implemented in scene.ts —
// it advances a game clock, computes the spin angle via `core/orbits.spinAngle`
// (`(spinRate·t) mod 2π`, double→float at the GPU), and produces day/night by rotating
// the SUN DIRECTION into the body frame (no body→world mesh rotation needed). Everything
// here stays SPIN-INVARIANT (the spin axis passes through the center, so radial up /
// gravity / collision are unchanged), and the render frame is kept planet-centered, so a
// surface→orbit launch can't make the planet "rocket away". The local `spinAngle()` below
// therefore stays identity — kept only as the seam for any FUTURE surface-fixed object that
// must rotate with the planet. This file is DOM-free + Three.js-only (no /core import except
// the pure `surfaceAt`).
// ─────────────────────────────────────────────────────────────────────────────

import { Vector3, Quaternion, Matrix4 } from 'three';
import { surfaceAt, type TerrainRecipe } from '../core/density.ts';

export interface WalkInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean; // walk: jump · fly: ascend along camera-up (Space)
  sprint: boolean; // walk: run · fly: boost (Shift)
  down: boolean; // fly: descend along camera-down (Ctrl); ignored in walk
  rollLeft: boolean; // fly: bank/roll left (Q); ignored in walk
  rollRight: boolean; // fly: bank/roll right (E); ignored in walk
  level: boolean; // fly: ease orientation back upright to the planet (R); ignored in walk
  brake: boolean; // fly: instant full-stop (X); ignored in walk
}

const NO_INPUT: WalkInput = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  down: false,
  rollLeft: false,
  rollRight: false,
  level: false,
  brake: false,
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

// Creative-flight [T]: PLAYER-CONTROLLED throttle (you only go faster when you choose to — no altitude
// auto-scaling). The throttle is an ABSOLUTE target-speed ladder; `[`/`]` + mouse-wheel step it, Shift
// boosts, and the craft eases (critically-damped, no overshoot) toward the target so holding a direction
// ramps up smoothly and releasing eases to a stop. X stops dead.
const FLY_CAP = 0.3 * 299_792_458; // ≈ 8.99e7 m/s (0.3c) hard cap on the throttle target
const FLY_THROTTLE_SPEEDS = [
  5, 20, 75, 300, 1_200, 5_000, 20_000, 80_000, 350_000, 1.5e6, 7e6, 3e7, FLY_CAP,
] as const; // ~5 m/s … 0.3c, log-spaced
const FLY_THROTTLE_DEFAULT = 6; // index → 20 km/s (perceptible from the orbit spawn; wheel down near the deck)
const FLY_BOOST = 4; // Shift multiplier on the throttle target
const ACCEL_RATE = 3; // velocity ease rate (1/s): ~95% of target in ~1 s, no overshoot
const ROLL_SPEED = 1.6; // rad/s free local roll rate (Q/E) in fly
const LEVEL_RATE = 6; // 1/s slerp rate for the smooth "level out" (R) — horizon flattens over ~0.4 s
const LEVEL_SNAP = 0.0175; // rad (~1°) — within this of level, snap + clear the level-out
const FLY_CLEARANCE = 2; // m — keep the fly camera this far above the SOLID surface (near-plane safety)

// Camera local axes (shared immutables; never mutated) for fly-mode incremental rotations:
// X = screen-right (pitch axis), Y = screen-up (yaw axis), Z = −look (roll axis).
const AX_X = new Vector3(1, 0, 0);
const AX_Y = new Vector3(0, 1, 0);
const AX_Z = new Vector3(0, 0, 1);
// Octave counts the clip-debug probe samples alongside the collision count, to
// quantify how far the surface moves per LOD level (the geomorph/streaming transient).
const DEBUG_OCTAVES = [14, 12, 10, 4] as const;

/**
 * Spin angle of the planet at the player's position. Identity (0) by design: the body-fixed
 * player is spin-invariant, and Step 5's day/night is produced in the render shell (scene.ts)
 * by rotating the sun direction — see `core/orbits.spinAngle`. Kept as the seam for a future
 * surface-fixed object that must rotate with the planet (then it returns spinAngle(rate, t)).
 */
function spinAngle(): number {
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
  // Fly state: a free 6DOF orientation quaternion (`_flyQuat`, body-fixed frame) plus a persistent velocity
  // eased toward the throttle target. The LOOK is fully untethered — mouse yaw/pitch and Q/E roll all act in
  // the camera's LOCAL frame, so you can point/fly any direction (incl. inverted) and hold any bank; the
  // horizon can drift (the user's chosen tradeoff) and R smoothly re-levels it (`_leveling`). Fly only; walk
  // ignores `_flyQuat` and stays radial-up via orient().
  private _leveling = false; // R-triggered smooth level-out in progress (slerp `_flyQuat` → leveled)
  private readonly _flyQuat = new Quaternion(); // free 6DOF look orientation (fly only)
  private readonly _vel = new Vector3();
  private readonly _upCam = new Vector3();
  private readonly _dqA = new Quaternion(); // scratch for incremental local rotations
  private readonly _dqB = new Quaternion(); // scratch for incremental local rotations
  private readonly _qLevel = new Quaternion(); // scratch: the leveled target orientation for R
  private readonly _surf = new Float64Array(7);
  private readonly _probe = new Float64Array(7); // footprint sample scratch
  private readonly _moveDir = new Vector3(); // unit tangential move dir (0 when idle)
  private _centerSurfR = 0; // surface radius directly under the eye (for altitude())
  private _fpMaxR = 0; // max surface radius over the footprint (the collision floor)
  private _minGap = Infinity; // min radial eye→surface gap over the footprint (near clamp)
  private flyMode = false; // creative free-fly (no gravity/collision)
  private flyThrottleIdx = FLY_THROTTLE_DEFAULT; // index into FLY_THROTTLES (manual cruise multiplier)
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
    this._vel.set(0, 0, 0); // fly velocity reset on every (re)spawn / teleport
    this._leveling = false;
    // Populate _surf/_centerSurfR + camera quaternion. Walk snaps to ground; fly seeds an upright free look.
    if (this.flyMode) {
      this.orient(); // leveled radial-up orientation for the current yaw/pitch
      this._flyQuat.copy(this._quat); // seed the free look upright, facing the spawn heading
      this.updateFly(0, NO_INPUT);
    } else {
      this.update(0, NO_INPUT);
    }
  }

  /** Enter/leave creative free-fly (no gravity, no terrain collision). */
  setFly(on: boolean): void {
    this.flyMode = on;
  }
  /** Step the throttle target speed (`[`/`]`/wheel, dir +1/−1) along the absolute ladder. No-op walking. */
  cycleSpeed(dir: number): void {
    this.flyThrottleIdx = Math.max(0, Math.min(FLY_THROTTLE_SPEEDS.length - 1, this.flyThrottleIdx + Math.sign(dir)));
  }

  /** Player-set throttle TARGET speed (m/s): the absolute ladder value at the current throttle index — no
   *  altitude scaling, so you only go faster when you raise the throttle. The craft eases toward this. */
  private throttleSpeed(): number {
    return FLY_THROTTLE_SPEEDS[this.flyThrottleIdx]!;
  }
  isFlying(): boolean {
    return this.flyMode;
  }

  /**
   * Accumulate mouse-look (pointer-lock movementX/Y, pixels).
   * Fly: incremental LOCAL yaw (about camera up) + pitch (about camera right) on the free `_flyQuat` — no
   * clamp, no planet-up tether (full 6DOF; the horizon may drift, R re-levels). Any look cancels an
   * in-progress level-out so R never fights the player. Walk: stable yaw/pitch around the radial up (the
   * horizon stays level on its own; banking N/A).
   */
  addMouse(dx: number, dy: number): void {
    if (this.flyMode) {
      // Post-multiply = rotate in the camera's LOCAL frame → camera-relative look, no external up reference.
      this._flyQuat
        .multiply(this._dqA.setFromAxisAngle(AX_Y, -dx * MOUSE_SENS)) // yaw about local up
        .multiply(this._dqB.setFromAxisAngle(AX_X, -dy * MOUSE_SENS)) // pitch about local right
        .normalize();
      this._leveling = false; // moving the look cancels an in-progress R level-out
      return;
    }
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
   * its own up and reintroduces roll); xAxis ⟂ up pins the horizon level. Used by WALK
   * (every frame) and by fly only to SEED the upright `_flyQuat` at spawn (reset()).
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
   * Creative free-fly update — FULL 6DOF, untethered (Superman in a spaceship). The look is a free
   * orientation quaternion (`_flyQuat`): mouse yaw/pitch and Q/E roll all act in the camera's LOCAL frame, so
   * you can point/fly any direction (incl. straight up/over the top and inverted) and hold any bank. Movement
   * is fully camera-relative (W/S along look, A/D along camera right, Space/Ctrl along CAMERA up), so you fly
   * exactly where you look. The horizon may drift from circling the look (the user's chosen tradeoff) — R
   * smoothly re-levels it (slerp toward level, cancels on any look input). Speed is PLAYER-CONTROLLED: the
   * velocity eases (critically-damped, no overshoot) toward `throttleSpeed × boost` along the thrust dir —
   * hold to ramp up, release to ease to a stop; X stops dead. Gravity is OFF, but you CANNOT fly through the
   * SOLID planet (`collideFly` — under water is fine; the seabed/ground is a floor).
   */
  updateFly(dtRaw: number, input: WalkInput): void {
    const dt = Math.min(Math.max(dtRaw, 0), MAX_DT);

    // 1. Orientation — free 6DOF. Q/E roll about the look's OWN forward axis (local Z); the roll persists
    //    (untethered — no auto-level). Any roll cancels an in-progress R level-out.
    if (input.rollLeft) { this._flyQuat.multiply(this._dqA.setFromAxisAngle(AX_Z, ROLL_SPEED * dt)); this._leveling = false; }
    if (input.rollRight) { this._flyQuat.multiply(this._dqA.setFromAxisAngle(AX_Z, -ROLL_SPEED * dt)); this._leveling = false; }
    if (input.level) this._leveling = true;
    if (this._leveling) this.levelStep(dt); // smooth slerp toward a leveled horizon (same look dir)
    this._flyQuat.normalize();

    // Camera-relative axes from the free orientation (move exactly where you look).
    this._fwd.set(0, 0, -1).applyQuaternion(this._flyQuat);
    this._right.set(1, 0, 0).applyQuaternion(this._flyQuat);
    this._upCam.set(0, 1, 0).applyQuaternion(this._flyQuat);

    // 2. Desired velocity = combined thrust direction × throttle target (× Shift boost), capped.
    this._move.set(0, 0, 0);
    if (input.forward) this._move.add(this._fwd);
    if (input.back) this._move.sub(this._fwd);
    if (input.right) this._move.add(this._right);
    if (input.left) this._move.sub(this._right);
    if (input.jump) this._move.add(this._upCam); // ascend along camera up
    if (input.down) this._move.sub(this._upCam); // descend along camera down
    const target = Math.min(FLY_CAP, this.throttleSpeed() * (input.sprint ? FLY_BOOST : 1));
    if (this._move.lengthSq() > 0) this._move.normalize().multiplyScalar(target);
    // else `_move` stays 0 → ease to a stop (no free coasting; predictable).

    // 3. Critically-damped ease toward the desired velocity (no overshoot), then integrate.
    this._vel.lerp(this._move, 1 - Math.exp(-ACCEL_RATE * dt));
    if (input.brake) this._vel.set(0, 0, 0); // instant full-stop (X)
    this.worldPos.addScaledVector(this._vel, dt);

    // 4. Solid-planet collision: clamp above the terrain surface and slide (no penetration; water is not a
    //    floor). Also refreshes the altitude()/near-plane HUD fields.
    this.collideFly();

    this.speedEst = this._vel.length();
    this.radialVel = 0; // no gravity in fly; reset so re-entering walk doesn't inherit a fall
    this._quat.copy(this._flyQuat); // camera orientation = the free look
    this._look.copy(this._fwd); // getForward() = the look direction
    void spinAngle(); // Step 5 seam (identity now)
  }

  /**
   * One smooth step of the R "level out": slerp `_flyQuat` toward a LEVELED orientation that keeps the
   * current look direction but removes any bank (camera up pulled toward the radial up). Snaps + clears
   * `_leveling` within LEVEL_SNAP. Near-vertical look (along the radial) → any tangent serves as the level
   * right axis. Zero allocation (scratch members only).
   */
  private levelStep(dt: number): void {
    this._fwd.set(0, 0, -1).applyQuaternion(this._flyQuat); // current look dir
    this._zAxis.copy(this._fwd).multiplyScalar(-1); // target camera −Z = same look dir
    this._up.copy(this.worldPos).normalize(); // radial up
    // right = up × (−look) ⟂ radial up → level horizon. Degenerate when the look is along the radial.
    this._xAxis.crossVectors(this._up, this._zAxis);
    if (this._xAxis.lengthSq() < 1e-8) {
      if (Math.abs(this._up.y) < 0.99) this._ref.set(0, 1, 0);
      else this._ref.set(1, 0, 0);
      this._xAxis.crossVectors(this._ref, this._zAxis);
    }
    this._xAxis.normalize();
    this._yAxis.crossVectors(this._zAxis, this._xAxis).normalize();
    this._m.makeBasis(this._xAxis, this._yAxis, this._zAxis);
    this._qLevel.setFromRotationMatrix(this._m);
    this._flyQuat.slerp(this._qLevel, 1 - Math.exp(-LEVEL_RATE * dt));
    if (this._flyQuat.angleTo(this._qLevel) < LEVEL_SNAP) {
      this._flyQuat.copy(this._qLevel); // snap the last sliver so it truly settles
      this._leveling = false;
    }
  }

  /**
   * Fly-mode collision floor: clamp the position so the camera never drops below the SOLID terrain surface
   * (the seabed under oceans, the land surface elsewhere). Water is NOT a floor — the probe is the terrain
   * radius (analytic, lifted to the rendered mesh when that sits higher), never sea level — so you may
   * descend below sea level into the water and only stop at the ground beneath it. On contact the INWARD
   * radial velocity is removed (slide, not stop); tangential speed is preserved (X still stops everything).
   * No gravity, no EYE offset (a small FLY_CLEARANCE keeps the near plane off the rock). Reuses walk's
   * footprint machinery (probeFootprint → `_fpMaxR`, `groundProbe`) and refreshes altitude()/near-plane
   * fields. Zero per-frame allocation. NOTE: a per-frame radial clamp — robust against radial tunnelling
   * (you snap to the surface however fast you dove), but a single huge lateral step at relativistic throttle
   * skimming the deck could cross features (out of slice scope; wheel the throttle down near the surface).
   */
  private collideFly(): void {
    const px = this.worldPos.x, py = this.worldPos.y, pz = this.worldPos.z;
    const r = Math.sqrt(px * px + py * py + pz * pz);
    if (r < 1e-6) return; // at the exact centre (degenerate)
    // Radial up + a stable tangent basis (least-parallel reference), like basis(), built locally.
    this._up.set(px / r, py / r, pz / r);
    if (Math.abs(this._up.y) < 0.99) this._ref.set(0, 1, 0);
    else this._ref.set(1, 0, 0);
    this._east.crossVectors(this._ref, this._up).normalize();
    this._north.crossVectors(this._up, this._east).normalize();

    // Center analytic surface (also the altitude() reference), then the footprint ring.
    surfaceAt(this.recipe, this.planetRadius, px, py, pz, this._surf, this.groundOctaves);
    this._centerSurfR = this._surf[0]!;
    this._fpMaxR = this._centerSurfR;
    this._minGap = r - this._centerSurfR;
    const e = this._east, nn = this._north;
    this.probeFootprint(px, py, pz, BODY_R * e.x, BODY_R * e.y, BODY_R * e.z, r);
    this.probeFootprint(px, py, pz, -BODY_R * e.x, -BODY_R * e.y, -BODY_R * e.z, r);
    this.probeFootprint(px, py, pz, BODY_R * nn.x, BODY_R * nn.y, BODY_R * nn.z, r);
    this.probeFootprint(px, py, pz, -BODY_R * nn.x, -BODY_R * nn.y, -BODY_R * nn.z, r);
    // Step-ahead along the HORIZONTAL (tangential) velocity → lift the nose over a rise flown into.
    const vr = this._vel.dot(this._up);
    this._moveDir.copy(this._vel).addScaledVector(this._up, -vr); // strip the radial component
    if (this._moveDir.lengthSq() > 1e-6) {
      this._moveDir.normalize();
      const m = this._moveDir;
      this.probeFootprint(px, py, pz, STEP_AHEAD * m.x, STEP_AHEAD * m.y, STEP_AHEAD * m.z, r);
    }
    // Floor to the ACTUAL RENDERED terrain when it sits above the analytic surface (LOD churn).
    const renderedR = this.groundProbe ? this.groundProbe(px, py, pz) : 0;
    if (renderedR > this._fpMaxR) this._fpMaxR = renderedR;

    const floorR = this._fpMaxR + FLY_CLEARANCE;
    if (r < floorR) {
      this.worldPos.copy(this._up).multiplyScalar(floorR); // lift back onto the floor along up
      const vrad = this._vel.dot(this._up);
      if (vrad < 0) this._vel.addScaledVector(this._up, -vrad); // cancel ONLY the inward part → slide
      this.grounded = true;
    } else {
      this.grounded = false;
    }
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

  /** Aim the free-fly look toward the planet centre (initial spawn so you see the planet, not empty tangent
   *  space): camera −Z = −radial (toward centre), leveled. Sets `_flyQuat` directly. Fly mode only. */
  aimAtPlanet(): void {
    const r = this.worldPos.length();
    if (r < 1e-6) {
      this._flyQuat.identity();
    } else {
      this._zAxis.copy(this.worldPos).multiplyScalar(1 / r); // camera +Z = radial out ⇒ −Z = toward centre
      if (Math.abs(this._zAxis.y) < 0.99) this._ref.set(0, 1, 0);
      else this._ref.set(1, 0, 0);
      this._xAxis.crossVectors(this._ref, this._zAxis).normalize();
      this._yAxis.crossVectors(this._zAxis, this._xAxis).normalize();
      this._m.makeBasis(this._xAxis, this._yAxis, this._zAxis);
      this._flyQuat.setFromRotationMatrix(this._m);
    }
    this._leveling = false;
    this._quat.copy(this._flyQuat);
    this._fwd.set(0, 0, -1).applyQuaternion(this._flyQuat);
    this._look.copy(this._fwd);
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
  /** Current throttle TARGET speed (m/s), before Shift boost — for the HUD (the current speed is `speed()`). */
  flySpeed(): number {
    return this.throttleSpeed();
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
