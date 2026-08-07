// Vehicle dynamics.
//
// A bicycle model with real slip angles, load transfer and a friction ellipse,
// stepped at a fixed 120 Hz. That combination is what gives a car that
// understeers when you carry too much speed in, rotates when you lift, and
// steps out predictably on the handbrake — rather than the "steering rotates
// the sprite" feel that arcade drivers usually settle for.
//
// Body frame: +x forward, +y to the right, yaw increasing = turning right.
// World frame: forward = (sin yaw, cos yaw), right = (cos yaw, -sin yaw).

import { resolveCollisions } from './collision.js';

const G = 9.81;

const SPEC = {
  mass: 1380,
  izz: 2560,
  wheelbase: 2.70,
  frontAxle: 1.25,          // CG to front axle
  rearAxle: 1.45,           // CG to rear axle
  cgHeight: 0.53,
  wheelRadius: 0.33,
  maxSteer: 0.60,           // rad, ~34°
  grip: 1.06,               // peak μ
  stiffnessPerN: 12,        // cornering stiffness = this × vertical load
  peakTorque: 215,          // Nm
  redline: 7000,
  idle: 850,
  gears: [4.20, 2.60, 1.85, 1.42, 1.14, 0.95],
  reverseGear: 3.9,
  finalDrive: 4.45,
  driveline: 0.90,
  brakeForce: 13500,        // N at full pedal, both axles
  brakeBias: 0.64,          // fraction on the front
  handbrakeForce: 5200,     // N, rear only
  handbrakeGripLoss: 0.42,
  dragK: 0.62,              // F_drag = dragK · v²
  rollingResistance: 200,   // N
  speedLimiter: 64,         // m/s, ≈230 km/h
};

/** Engine torque as a fraction of peak, by fraction of redline. */
function torqueCurve(x) {
  const t = 0.62 + 1.36 * x - 0.98 * x * x;
  return Math.max(0.15, t) / 1.092;
}

export class Vehicle {
  constructor(spec = {}) {
    this.spec = { ...SPEC, ...spec };
    this.reset(0, 0, 0);
  }

  reset(x, z, yaw) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.u = 0;              // forward velocity, m/s
    this.v = 0;              // lateral velocity (right positive), m/s
    this.yawRate = 0;
    this.gear = 1;
    this.rpm = this.spec.idle;
    this.shiftTimer = 0;
    this.reversing = false;
    this.steerAngle = 0;
    this.wheelSpin = 0;
    this.slipFront = 0;
    this.slipRear = 0;
    this.skid = 0;
    this.load = 0;
    this.lastImpact = 0;
    this.accelLong = 0;
    this.accelLat = 0;
    this.bodyRoll = 0;
    this.bodyPitch = 0;
    this.odometer = 0;
    this.airTime = 0;
  }

  get speed() { return Math.hypot(this.u, this.v); }
  get speedKmh() { return this.speed * 3.6; }
  get vx() { return Math.sin(this.yaw) * this.u + Math.cos(this.yaw) * this.v; }
  get vz() { return Math.cos(this.yaw) * this.u - Math.sin(this.yaw) * this.v; }

  /**
   * @param {number} dt fixed step, seconds
   * @param {{throttle,brake,steer,handbrake}} input
   * @param {Array} grids collision grids near the car
   */
  step(dt, input, grids) {
    const S = this.spec;
    const throttleIn = clamp01(input.throttle);
    const brakeIn = clamp01(input.brake);
    const handbrake = !!input.handbrake;

    // --- direction of travel and what the pedals mean right now -------------
    // Below walking pace the brake pedal engages reverse, which is what every
    // arcade driver expects and what avoids a separate reverse key.
    if (this.u < 0.6 && this.u > -0.2 && brakeIn > 0.5 && throttleIn < 0.05) this.reversing = true;
    if (this.u > 1.2 || (throttleIn > 0.05 && this.u > -0.2)) this.reversing = false;

    let drive = 0;
    let brakePedal = 0;
    if (this.reversing) {
      drive = -brakeIn;
      brakePedal = throttleIn;
    } else {
      drive = throttleIn;
      brakePedal = brakeIn;
    }

    // --- gearbox -----------------------------------------------------------
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    const ratio = this.reversing
      ? S.reverseGear
      : S.gears[Math.min(this.gear, S.gears.length) - 1];
    const totalRatio = ratio * S.finalDrive;

    const wheelRadPerSec = Math.abs(this.u) / S.wheelRadius;
    let rpm = (wheelRadPerSec * totalRatio * 60) / (2 * Math.PI);
    rpm = Math.max(S.idle, Math.min(S.redline + 200, rpm));
    this.rpm = rpm;

    if (!this.reversing && this.shiftTimer <= 0) {
      if (rpm > S.redline * 0.92 && this.gear < S.gears.length && drive > 0.1) {
        this.gear++; this.shiftTimer = 0.32;
      } else if (rpm < 2350 && this.gear > 1) {
        this.gear--; this.shiftTimer = 0.28;
      }
    }

    // Torque is cut during a shift, which is what makes gears audible.
    const shifting = this.shiftTimer > 0.18;
    const engineTorque = shifting ? 0 : S.peakTorque * torqueCurve(rpm / S.redline) * Math.abs(drive);
    let driveForce = (engineTorque * totalRatio * S.driveline) / S.wheelRadius;
    driveForce *= Math.sign(drive) || 0;
    if (Math.abs(this.u) > S.speedLimiter) driveForce = 0;

    // --- steering ----------------------------------------------------------
    const speed = Math.abs(this.u);
    const steerLimit = S.maxSteer * (0.32 + 0.68 / (1 + speed / 17));
    const targetSteer = clampAbs(input.steer, 1) * steerLimit;
    // Rate-limit the rack so flicks cannot teleport the slip angle.
    const maxRate = 5.2 * dt;
    this.steerAngle += clampAbs(targetSteer - this.steerAngle, maxRate);
    const delta = this.steerAngle;

    // --- vertical loads, with longitudinal transfer -------------------------
    const L = S.wheelbase;
    const staticFront = (S.mass * G * S.rearAxle) / L;
    const staticRear = (S.mass * G * S.frontAxle) / L;
    const transfer = clampAbs((S.mass * this.accelLong * S.cgHeight) / L, staticFront * 0.6);
    const FzF = Math.max(600, staticFront - transfer);
    const FzR = Math.max(600, staticRear + transfer);

    // --- slip angles --------------------------------------------------------
    // The denominator floor keeps atan2 sane at a standstill; without it the
    // slip angle snaps to ±90° and the car shakes itself apart.
    const denom = Math.max(speed, 1.4);
    const dirSign = this.u >= 0 ? 1 : -1;
    const alphaF = Math.atan2(this.v + S.frontAxle * this.yawRate, denom) - delta * dirSign;
    const alphaR = Math.atan2(this.v - S.rearAxle * this.yawRate, denom);
    this.slipFront = alphaF;
    this.slipRear = alphaR;

    const muF = S.grip;
    const muR = S.grip * (handbrake ? S.handbrakeGripLoss : 1);

    // --- longitudinal forces per axle ---------------------------------------
    const brakeForce = brakePedal * S.brakeForce;
    let FxF = -Math.sign(this.u) * brakeForce * S.brakeBias;
    let FxR = driveForce - Math.sign(this.u) * brakeForce * (1 - S.brakeBias);
    if (handbrake) FxR -= Math.sign(this.u) * S.handbrakeForce;

    // Clamp each axle to what its tyres can actually put down.
    const maxFxF = muF * FzF, maxFxR = muR * FzR;
    const spinF = Math.abs(FxF) / maxFxF;
    const spinR = Math.abs(FxR) / maxFxR;
    FxF = clampAbs(FxF, maxFxF);
    FxR = clampAbs(FxR, maxFxR);

    // --- lateral forces, limited by whatever grip is left --------------------
    const capF = Math.sqrt(Math.max(0, maxFxF * maxFxF - FxF * FxF));
    const capR = Math.sqrt(Math.max(0, maxFxR * maxFxR - FxR * FxR));
    let FyF = clampAbs(-S.stiffnessPerN * FzF * alphaF, capF);
    let FyR = clampAbs(-S.stiffnessPerN * FzR * alphaR, capR);

    // How far past the limit the tyres are — drives smoke, screech and the
    // little steering-wheel wobble.
    const demandF = Math.abs(S.stiffnessPerN * FzF * alphaF) / (capF + 1);
    const demandR = Math.abs(S.stiffnessPerN * FzR * alphaR) / (capR + 1);
    this.skid = Math.max(0, Math.min(1.6, Math.max(demandF, demandR, spinF, spinR) - 1));
    this.load = Math.max(spinF, spinR);

    // --- resistances ---------------------------------------------------------
    const dragForce = -S.dragK * this.u * Math.abs(this.u);
    const rolling = Math.abs(this.u) < 0.15 ? 0 : -Math.sign(this.u) * S.rollingResistance;

    // --- equations of motion --------------------------------------------------
    const cosD = Math.cos(delta), sinD = Math.sin(delta);
    const sumFx = FxR + FxF * cosD - FyF * sinD + dragForce + rolling;
    const sumFy = FyF * cosD + FyR;
    const sumMz = S.frontAxle * (FyF * cosD + FxF * sinD) - S.rearAxle * FyR;

    const du = sumFx / S.mass + this.v * this.yawRate;
    const dv = sumFy / S.mass - this.u * this.yawRate;
    const dr = sumMz / S.izz;

    this.u += du * dt;
    this.v += dv * dt;
    this.yawRate += dr * dt;

    // Yaw damping keeps the tail from oscillating forever at low speed.
    this.yawRate *= 1 - Math.min(0.5, 1.6 * dt);
    this.yawRate = clampAbs(this.yawRate, 4.0);

    // Creep to a genuine stop instead of drifting for ever.
    if (Math.abs(this.u) < 0.35 && drive === 0) {
      this.u *= 1 - Math.min(1, 7 * dt);
      this.v *= 1 - Math.min(1, 7 * dt);
      this.yawRate *= 1 - Math.min(1, 7 * dt);
      if (Math.abs(this.u) < 0.04) this.u = 0;
      if (Math.abs(this.v) < 0.04) this.v = 0;
    }

    this.accelLong = du;
    this.accelLat = dv;

    // --- integrate pose --------------------------------------------------------
    this.yaw += this.yawRate * dt;
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let vxWorld = sy * this.u + cy * this.v;
    let vzWorld = cy * this.u - sy * this.v;

    this.x += vxWorld * dt;
    this.z += vzWorld * dt;
    this.odometer += Math.abs(this.u) * dt;

    // --- collisions ------------------------------------------------------------
    if (grids && grids.length) {
      const packet = { x: this.x, z: this.z, vx: vxWorld, vz: vzWorld, yawRate: this.yawRate };
      const impact = resolveCollisions(packet, this.yaw, grids);
      this.x = packet.x;
      this.z = packet.z;
      this.yawRate = packet.yawRate;
      vxWorld = packet.vx;
      vzWorld = packet.vz;
      this.lastImpact = impact;
      // Back into the body frame.
      this.u = vxWorld * sy + vzWorld * cy;
      this.v = vxWorld * cy - vzWorld * sy;
    } else {
      this.lastImpact = 0;
    }

    // --- presentation ----------------------------------------------------------
    this.wheelSpin += (this.u / S.wheelRadius) * dt;
    const targetRoll = clampAbs(-this.accelLat / G, 1) * 0.075;
    const targetPitch = clampAbs(this.accelLong / G, 1) * 0.055;
    this.bodyRoll += (targetRoll - this.bodyRoll) * Math.min(1, 9 * dt);
    this.bodyPitch += (targetPitch - this.bodyPitch) * Math.min(1, 9 * dt);

    if (!Number.isFinite(this.x) || !Number.isFinite(this.z) || !Number.isFinite(this.yaw)) {
      // Should never happen; if it somehow does, fail safe rather than render NaN.
      console.warn('[vehicle] non-finite state, resetting');
      this.reset(0, 0, 0);
    }
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clampAbs(v, limit) { return v > limit ? limit : v < -limit ? -limit : v; }

export { SPEC as VEHICLE_SPEC };
