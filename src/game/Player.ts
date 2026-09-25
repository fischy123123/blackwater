// First-person character: movement, head bob, footsteps, flashlight.
import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { CollisionWorld, Box } from '../world/Collision';
import { clamp, damp, lerp, smoothstep } from '../core/math';
import { U } from '../render/Globals';

export type Surface = 'grass' | 'forest' | 'gravel' | 'asphalt' | 'mud' | 'sand' | 'water' | 'wood' | 'concrete' | 'metal' | 'carpet' | 'rock';

export type PlayerMode = 'walk' | 'drive' | 'climb' | 'locked';

const FLASH_CD = 2.2; // scene units (~candela * 1e-3)

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  roll = 0;
  eye = 1.62;
  radius = 0.3;
  grounded = true;
  mode: PlayerMode = 'walk';
  camera: THREE.PerspectiveCamera;
  input: Input;
  world: CollisionWorld;
  surfaceAt: (x: number, z: number, y: number, box: Box | null) => Surface;
  onStep: ((s: Surface, intensity: number) => void) | null = null;
  onLand: ((s: Surface, v: number) => void) | null = null;
  flashlight: THREE.SpotLight;
  flashOn = false;
  hasFlashlight = false;
  flashFlicker = 0;
  private flashQ = new THREE.Quaternion();
  private bobPhase = 0;
  private bobAmp = 0;
  private lastStepSign = 1;
  private landDip = 0;
  private fovKick = 0;
  baseFov = 66;
  speedScale = 1;
  lookScale = 1;
  crouching = false;
  inside = 0; // 0..1, set by world probes (for audio/exposure)
  private breath = 0;
  lookLimits = { minPitch: -1.45, maxPitch: 1.45 };
  lockedYawCenter: number | null = null;
  lockedYawRange = 0;
  moveSpeed = 0;
  surface: Surface = 'grass';
  waterDepth = 0;
  bounds = { minX: -1000, maxX: 1000, minZ: -780, maxZ: 1200 };
  noClip = false;
  shake = 0;
  private shakeT = 0;
  cameraOffset = new THREE.Vector3(); // for cutscene nudges

  constructor(camera: THREE.PerspectiveCamera, input: Input, world: CollisionWorld, surfaceAt: Player['surfaceAt'], flashShadow: boolean) {
    this.camera = camera;
    this.input = input;
    this.world = world;
    this.surfaceAt = surfaceAt;
    this.flashlight = new THREE.SpotLight(0xfff1dc, 0, 70, 0.46, 0.55, 2);
    this.flashlight.castShadow = flashShadow;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 60;
    this.flashlight.shadow.bias = -0.0006;
    this.flashlight.shadow.normalBias = 0.02;
    this.flashlight.map = makeFlashCookie();
    this.flashlight.layers.enableAll();
    this.flashlight.target.layers.enableAll();
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.flashlight);
    scene.add(this.flashlight.target);
  }

  teleport(x: number, y: number | null, z: number, yawDeg?: number, pitchDeg = 0) {
    this.pos.set(x, y ?? this.world.groundAt(x, z, this.radius, 1e9).y, z);
    if (y === null) this.pos.y = this.world.groundAt(x, z, this.radius, this.world.heightAt(x, z) + 50).y;
    this.vel.set(0, 0, 0);
    if (yawDeg !== undefined) this.yaw = THREE.MathUtils.degToRad(yawDeg);
    this.pitch = THREE.MathUtils.degToRad(pitchDeg);
    this.flashQ.copy(this.camera.quaternion);
  }

  get forward() {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  lookDir(out = new THREE.Vector3()) {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
  }

  eyePos(out = new THREE.Vector3()) {
    return out.copy(this.camera.position);
  }

  update(dt: number, preExposure: number) {
    const inp = this.input;
    // ---------------------------------------------------------------- look
    if (this.mode !== 'locked' || this.lockedYawCenter !== null) {
      this.yaw += inp.look.x * this.lookScale;
      this.pitch = clamp(this.pitch + inp.look.y * this.lookScale, this.lookLimits.minPitch, this.lookLimits.maxPitch);
      if (this.lockedYawCenter !== null) {
        let d = this.yaw - this.lockedYawCenter;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        d = clamp(d, -this.lockedYawRange, this.lockedYawRange);
        this.yaw = this.lockedYawCenter + d;
      }
    }

    if (this.mode === 'walk') this.walk(dt);

    // ---------------------------------------------------------------- camera
    const bob = Math.sin(this.bobPhase);
    const bobSide = Math.cos(this.bobPhase * 0.5);
    const amp = this.bobAmp;
    this.landDip = damp(this.landDip, 0, 9, dt);
    this.breath += dt;
    const breathY = Math.sin(this.breath * 1.6) * 0.004;
    const eyeTarget = this.crouching ? 1.05 : 1.62;
    this.eye = damp(this.eye, eyeTarget, 10, dt);
    this.shakeT += dt;
    const sh = this.shake * this.shake;
    const shx = (Math.sin(this.shakeT * 37.1) + Math.sin(this.shakeT * 23.3)) * 0.02 * sh;
    const shy = (Math.sin(this.shakeT * 41.7) + Math.sin(this.shakeT * 19.9)) * 0.02 * sh;
    this.shake = damp(this.shake, 0, 1.5, dt);
    if (this.mode === 'walk' || this.mode === 'climb' || this.mode === 'locked') {
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.camera.position
        .copy(this.pos)
        .add(new THREE.Vector3(0, this.eye + Math.abs(bob) * -amp * 0.9 + amp * 0.45 - this.landDip + breathY, 0))
        .addScaledVector(right, bobSide * amp * 0.5)
        .add(this.cameraOffset);
      this.roll = damp(this.roll, -inp.move.x * 0.012 + bobSide * amp * 0.12, 6, dt);
    }
    this.camera.rotation.set(this.pitch + shy, this.yaw + shx, this.roll, 'YXZ');
    this.fovKick = damp(this.fovKick, this.moveSpeed > 3 ? 4 : 0, 3, dt);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();

    // ---------------------------------------------------------------- flashlight
    if (this.hasFlashlight && inp.consume('flashlight')) this.setFlash(!this.flashOn);
    const hand = new THREE.Vector3(0.22, -0.28, -0.1).applyQuaternion(this.camera.quaternion).add(this.camera.position);
    this.flashQ.slerp(this.camera.quaternion, 1 - Math.exp(-16 * dt));
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.flashQ);
    // small sway from walking
    dir.x += Math.sin(this.bobPhase * 0.5) * amp * 0.25;
    dir.y += Math.abs(bob) * amp * 0.2;
    dir.normalize();
    this.flashlight.position.copy(hand);
    this.flashlight.target.position.copy(hand).addScaledVector(dir, 10);
    this.flashlight.target.updateMatrixWorld();
    this.flashFlicker = Math.max(0, this.flashFlicker - dt);
    const flick = this.flashFlicker > 0 ? (Math.random() < 0.5 ? 0.15 : 1) : 1;
    this.flashlight.intensity = this.flashOn ? FLASH_CD * preExposure * flick : 0;
    this.flashlight.visible = this.flashOn;
    U.uFlashOn.value = this.flashOn ? 1 : 0;
    U.uFlashPos.value.copy(hand);
    U.uFlashDir.value.copy(dir);
  }

  setFlash(on: boolean) {
    this.flashOn = on;
    this.onFlash?.(on);
  }
  onFlash: ((on: boolean) => void) | null = null;

  private walk(dt: number) {
    const inp = this.input;
    this.crouching = inp.crouch || this.world.ceilingAt(this.pos.x, this.pos.z, this.pos.y + 1.0) < this.pos.y + 1.75;
    const run = inp.sprint && !this.crouching && inp.move.y > 0.2;
    let speed = (this.crouching ? 0.95 : run ? 4.3 : 1.65) * this.speedScale;
    // wading
    const wl = this.world.waterAt ? this.world.waterAt(this.pos.x, this.pos.z) : -1000;
    this.waterDepth = Math.max(0, wl - this.pos.y);
    speed *= lerp(1, 0.45, smoothstep(0.05, 0.8, this.waterDepth));
    const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const want = new THREE.Vector3().addScaledVector(f, inp.move.y).addScaledVector(r, inp.move.x);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(speed);
    // slope: slower uphill
    const g0 = this.world.heightAt(this.pos.x, this.pos.z);
    const ahead = this.world.heightAt(this.pos.x + want.x * 0.5, this.pos.z + want.z * 0.5);
    const slope = (ahead - g0) / Math.max(0.01, want.length() * 0.5);
    if (slope > 0.15 && this.grounded) want.multiplyScalar(clamp(1.15 - slope * 0.9, 0.25, 1));
    const accel = this.grounded ? (want.lengthSq() > this.vel.lengthSq() ? 9 : 11) : 1.5;
    this.vel.x = damp(this.vel.x, want.x, accel, dt);
    this.vel.z = damp(this.vel.z, want.z, accel, dt);
    // gravity / jump
    if (this.grounded && inp.consume('jump') && !this.crouching) {
      this.vel.y = 3.4;
      this.grounded = false;
    }
    this.vel.y -= 17 * dt;
    const next = this.pos.clone().addScaledVector(this.vel, dt);
    // deep water acts as a wall
    if (this.world.waterAt) {
      const nw = this.world.waterAt(next.x, next.z);
      const ng = this.world.heightAt(next.x, next.z);
      if (nw - ng > 1.15 && !this.noClip) {
        next.x = this.pos.x;
        next.z = this.pos.z;
        this.vel.x *= 0.2;
        this.vel.z *= 0.2;
      }
    }
    next.x = clamp(next.x, this.bounds.minX, this.bounds.maxX);
    next.z = clamp(next.z, this.bounds.minZ, this.bounds.maxZ);
    if (!this.noClip) this.world.resolve(next, this.radius, this.pos.y, this.pos.y + (this.crouching ? 1.15 : 1.8), 0.38);
    // ground
    const gr = this.world.groundAt(next.x, next.z, this.radius * 0.7, this.pos.y + 0.45);
    const wasGrounded = this.grounded;
    if (next.y <= gr.y + 0.02) {
      if (!wasGrounded && this.vel.y < -3) {
        this.landDip = Math.min(0.12, -this.vel.y * 0.012);
        this.onLand?.(this.surface, -this.vel.y);
      }
      // smooth step-up (stairs), snap down on slopes
      next.y = gr.y > next.y ? damp(next.y, gr.y, 22, dt) : gr.y;
      if (gr.y - next.y < 0.01) next.y = gr.y;
      this.vel.y = 0;
      this.grounded = true;
    } else if (next.y - gr.y < 0.3 && this.vel.y <= 0 && wasGrounded) {
      next.y = gr.y; // stick to ground going downhill/downstairs
      this.vel.y = 0;
      this.grounded = true;
    } else this.grounded = false;
    const moved = Math.hypot(next.x - this.pos.x, next.z - this.pos.z);
    this.pos.copy(next);
    this.moveSpeed = moved / Math.max(dt, 1e-4);

    // head bob + footsteps
    this.surface = this.waterDepth > 0.03 ? 'water' : this.surfaceAt(this.pos.x, this.pos.z, this.pos.y, gr.box);
    const stride = run ? 1.05 : this.crouching ? 0.55 : 0.74;
    if (this.grounded && this.moveSpeed > 0.15) {
      this.bobPhase += (this.moveSpeed * dt * Math.PI) / stride;
      this.bobAmp = damp(this.bobAmp, run ? 0.05 : this.crouching ? 0.018 : 0.028, 6, dt);
    } else {
      this.bobAmp = damp(this.bobAmp, 0, 5, dt);
      // settle phase to a rest position
      const target = Math.round(this.bobPhase / Math.PI) * Math.PI;
      this.bobPhase = damp(this.bobPhase, target, 4, dt);
    }
    const sgn = Math.sign(Math.sin(this.bobPhase));
    if (sgn !== this.lastStepSign && sgn !== 0) {
      this.lastStepSign = sgn;
      if (this.grounded && this.moveSpeed > 0.3) this.onStep?.(this.surface, clamp(this.moveSpeed / 4.3, 0.2, 1) * (this.crouching ? 0.5 : 1));
    }
  }
}

function makeFlashCookie(): THREE.Texture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const dx = (x + 0.5) / s - 0.5,
        dy = (y + 0.5) / s - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      // hot centre, reflector rings, soft spill
      let v = Math.exp(-r * r * 9) * 1.0 + Math.exp(-r * r * 2.2) * 0.35;
      v += 0.12 * Math.max(0, Math.cos(r * 38)) * Math.exp(-r * r * 3);
      v += r > 0.42 && r < 0.5 ? 0.12 : 0;
      v *= 1 - smoothstep(0.85, 1.0, r);
      const cw = Math.min(255, v * 255);
      const i = (y * s + x) * 4;
      img.data[i] = cw;
      img.data[i + 1] = Math.min(255, cw * 0.97);
      img.data[i + 2] = Math.min(255, cw * 0.9);
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
