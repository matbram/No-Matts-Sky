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
  jump: boolean;
  sprint: boolean;
}

const NO_INPUT: WalkInput = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
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

  constructor(
    private readonly recipe: TerrainRecipe,
    private readonly planetRadius: number,
  ) {}

  /** Place the player at a body-fixed position and settle onto the ground. */
  reset(worldPos: Vector3, yaw = 0, pitch = 0): void {
    this.worldPos.copy(worldPos);
    this.yaw = yaw;
    this.pitch = pitch;
    this.radialVel = 0;
    this.grounded = true;
    this.speedEst = 0;
    this.update(0, NO_INPUT); // populate _surf + camera quaternion, snap to ground
  }

  /** Accumulate mouse-look (pointer-lock movementX/Y, pixels). */
  addMouse(dx: number, dy: number): void {
    this.yaw -= dx * MOUSE_SENS;
    this.pitch -= dy * MOUSE_SENS;
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
      this._move.normalize().multiplyScalar(speed * dt);
      this.worldPos.add(this._move);
      this.speedEst = speed;
    } else {
      this.speedEst = 0;
    }

    // 2. Gravity on the radial axis; re-derive up/radius after the tangential step.
    this.radialVel -= G * dt;
    const r = this.worldPos.length();
    this._up.copy(this.worldPos).multiplyScalar(1 / r);

    // 3. Ground probe along the new direction (analytic → matches the mesh exactly).
    surfaceAt(this.recipe, this.planetRadius, this.worldPos.x, this.worldPos.y, this.worldPos.z, this._surf);
    const groundR = this._surf[0]! + EYE;

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

    // 8. Camera orientation at the final position. Rebuild the basis (up moved), add
    //    pitch to the heading, then an EXPLICIT basis → quaternion. Not camera.lookAt
    //    (it recomputes its own up and reintroduces roll); xAxis ⟂ up pins the horizon.
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

    void spinAngle(); // Step 5 seam (identity now) — keep referenced for clarity.
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
    return this.worldPos.length() - this._surf[0]!;
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
}
