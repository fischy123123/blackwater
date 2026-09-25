// The player's county pickup: arcade driving on the heightfield, lights, cab interior, engine audio.
import * as THREE from 'three';
import { carParts } from '../world/Props';
import type { CollisionWorld } from '../world/Collision';
import type { Input } from '../core/Input';
import { audio } from '../audio/AudioEngine';
import { clamp, damp, lerp, wrapAngle } from '../core/math';

export class Truck {
  root = new THREE.Group();
  body = new THREE.Group();
  wheel: THREE.Mesh;
  headlights: THREE.SpotLight[] = [];
  lightsOn = false;
  pos = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  steer = 0;
  pitch = 0;
  roll = 0;
  y = 0;
  occupied = false;
  enabled = true;
  maxSpeed = 17;
  radioDial: THREE.Mesh;
  private engine: { osc: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode; noise: AudioBufferSourceNode; noiseGain: GainNode } | null = null;
  private tireGain: GainNode | null = null;
  lookYaw = 0;
  lookPitch = 0;
  onCrash: ((v: number) => void) | null = null;
  groundAt: (x: number, z: number) => number;
  surfaceRough: (x: number, z: number) => number;
  private crashCooldown = 0;
  private lampMat: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, groundAt: (x: number, z: number) => number, surfaceRough: (x: number, z: number) => number, shadowHeadlight: boolean) {
    this.groundAt = groundAt;
    this.surfaceRough = surfaceRough;
    const p = carParts('pickup');
    const paint = new THREE.MeshPhysicalMaterial({ color: 0xd8d6cc, roughness: 0.4, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.3 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fb0b6, roughness: 0.03, metalness: 0, transmission: 0, transparent: true, opacity: 0.22, depthWrite: false });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.18, metalness: 1 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6e0, roughness: 0.1, emissive: 0x000000 });
    const tail = new THREE.MeshStandardMaterial({ color: 0x8a120a, roughness: 0.2, emissive: 0x000000 });
    const interior = new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.85 });
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, shadow = true) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      this.body.add(mesh);
      return mesh;
    };
    mk(p.paint, paint);
    const gl = mk(p.glass, glass, false);
    gl.layers.set(1); // transparent pass
    mk(p.chrome, chrome);
    mk(p.rubber, rubber);
    mk(p.lights, this.lampMat, false);
    mk(p.tail, tail, false);
    mk(p.interior, interior);
    // bed walls and tailgate
    const bedMat = paint;
    const bed = [
      new THREE.BoxGeometry(2.0, 0.5, 0.06).translate(-1.6, 1.25, 0.88),
      new THREE.BoxGeometry(2.0, 0.5, 0.06).translate(-1.6, 1.25, -0.88),
      new THREE.BoxGeometry(0.06, 0.5, 1.76).translate(-2.62, 1.25, 0),
    ];
    for (const g of bed) mk(g, bedMat);
    // county door decal
    const decal = makeDecal();
    for (const side of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshStandardMaterial({ map: decal, transparent: true, roughness: 0.5 }));
      d.position.set(0.25, 0.78, side * 0.96);
      d.rotation.y = side > 0 ? 0 : Math.PI;
      this.body.add(d);
    }
    // cab interior: dash, steering wheel, radio with dial light
    const dash = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.25, 1.7), interior);
    dash.position.set(0.72, 1.12, 0);
    this.body.add(dash);
    this.wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 8, 28), new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.6 }));
    this.wheel.position.set(0.48, 1.24, -0.38);
    this.wheel.rotation.set(0, Math.PI / 2, 0);
    this.wheel.rotateX(0.55);
    this.body.add(this.wheel);
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.36, 0.03), new THREE.MeshStandardMaterial({ color: 0x1c1a18 }));
    this.wheel.add(spoke);
    this.radioDial = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.035), new THREE.MeshStandardMaterial({ color: 0x331a00, emissive: 0xffa040, emissiveIntensity: 0 }));
    this.radioDial.position.set(0.47, 1.18, -0.05);
    this.radioDial.rotation.y = -Math.PI / 2;
    this.body.add(this.radioDial);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 1.6), new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.9 }));
    seat.position.set(-0.25, 1.0, 0);
    this.body.add(seat);
    this.root.add(this.body);
    // headlights
    for (const side of [-1, 1]) {
      const l = new THREE.SpotLight(0xfff0d8, 0, 90, 0.42, 0.45, 1.6);
      l.position.set(2.6, 0.75, side * 0.62);
      l.target.position.set(12, 0.1, side * 0.9);
      l.castShadow = shadowHeadlight && side > 0;
      l.shadow.mapSize.set(512, 512);
      l.layers.enableAll();
      this.body.add(l);
      this.body.add(l.target);
      this.headlights.push(l);
    }
    scene.add(this.root);
  }

  place(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos);
    this.yaw = yaw;
    this.speed = 0;
    this.y = this.groundAt(pos.x, pos.z);
    this.syncTransform(1);
  }

  /** Local-space driver eye position in world space. */
  eyeWorld(out = new THREE.Vector3()) {
    return out.set(-0.05, 1.62, -0.38).applyMatrix4(this.body.matrixWorld);
  }

  exitPoint() {
    const side = new THREE.Vector3(0, 0, -2.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    return this.pos.clone().add(side);
  }

  doorPoint() {
    const side = new THREE.Vector3(0.2, 1.1, -1.05).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    return this.pos.clone().add(side);
  }

  setLights(on: boolean, pe: number) {
    this.lightsOn = on;
    for (const l of this.headlights) l.intensity = on ? 6.0 * pe : 0;
    this.lampMat.emissive.setRGB(on ? 1 : 0, on ? 0.95 : 0, on ? 0.85 : 0);
    this.lampMat.emissiveIntensity = on ? 40 * pe : 0;
  }

  startAudio() {
    const a = audio;
    if (!a.ctx || this.engine) return;
    const ctx = a.ctx;
    const gain = a.gain(0);
    const filter = a.filter('lowpass', 500, 1.2);
    const osc: OscillatorNode[] = [];
    for (const [type, mul, g] of [
      ['sawtooth', 1, 0.5],
      ['square', 0.5, 0.35],
      ['sine', 2, 0.2],
    ] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 30 * mul;
      o.detune.value = Math.random() * 10;
      const og = a.gain(g);
      o.connect(og).connect(filter);
      o.start();
      (o as OscillatorNode & { mul: number }).mul = mul;
      osc.push(o);
    }
    const noise = a.noise('brown', true);
    const noiseGain = a.gain(0);
    noise.connect(noiseGain).connect(filter);
    noise.start();
    filter.connect(gain);
    const pan = a.panner(this.pos, 3, 1);
    gain.connect(pan).connect(a.sfx);
    this.engine = { osc, gain, filter, noise, noiseGain };
    // tyres
    const tn = a.noise('pink', true);
    const tf = a.filter('bandpass', 400, 0.6);
    this.tireGain = a.gain(0);
    tn.connect(tf).connect(this.tireGain).connect(a.sfx);
    tn.start();
    (this.engine as unknown as { pan: PannerNode }).pan = pan;
  }

  update(dt: number, input: Input | null, world: CollisionWorld, pe: number) {
    this.crashCooldown -= dt;
    let throttle = 0,
      steerIn = 0;
    if (this.occupied && input && this.enabled) {
      throttle = input.move.y;
      steerIn = -input.move.x;
    }
    const rough = this.surfaceRough(this.pos.x, this.pos.z);
    // longitudinal
    const fwd = this.speed >= 0;
    if (throttle > 0.05) {
      if (this.speed < -0.2) this.speed += 9 * throttle * dt;
      else this.speed += (3.2 + 1.8 * (1 - this.speed / this.maxSpeed)) * throttle * dt;
    } else if (throttle < -0.05) {
      if (this.speed > 0.2) this.speed += 9 * throttle * dt;
      else this.speed += 2.5 * throttle * dt;
    }
    const drag = 0.35 + rough * 1.2 + (Math.abs(throttle) < 0.05 ? 0.9 : 0);
    this.speed -= this.speed * drag * 0.12 * dt + Math.sign(this.speed) * (Math.abs(throttle) < 0.05 ? 0.6 : 0) * dt;
    if (Math.abs(this.speed) < 0.05 && Math.abs(throttle) < 0.05) this.speed = 0;
    this.speed = clamp(this.speed, -5, this.maxSpeed * (1 - rough * 0.45));
    // steering
    const maxSteer = lerp(0.55, 0.18, clamp(Math.abs(this.speed) / this.maxSpeed, 0, 1));
    this.steer = damp(this.steer, steerIn * maxSteer, 5, dt);
    const wheelBase = 3.2;
    this.yaw += (this.speed * Math.tan(this.steer) * dt) / wheelBase;
    this.yaw = wrapAngle(this.yaw);
    const dir = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const next = this.pos.clone().addScaledVector(dir, this.speed * dt);
    // deep water stops the truck
    const w = world.waterAt ? world.waterAt(next.x, next.z) : -1000;
    if (w - this.groundAt(next.x, next.z) > 0.7) {
      next.copy(this.pos);
      this.speed *= 0.3;
    }
    // collision: two discs along the body
    for (const off of [1.5, 0, -1.5]) {
      const c = next.clone().addScaledVector(dir, off);
      const before = c.clone();
      world.resolve(c, 1.0, this.y + 0.3, this.y + 1.8, 0.5);
      const push = c.sub(before);
      if (push.lengthSq() > 1e-6) {
        next.add(push);
        const impact = Math.abs(this.speed);
        if (impact > 2 && this.crashCooldown <= 0) {
          this.crashCooldown = 0.8;
          this.onCrash?.(impact);
          audio.burst({ type: 'brown', f: 200, q: 0.8, decay: 0.4, gain: Math.min(1, impact / 10), pos: this.pos });
          audio.burst({ type: 'white', f: 2500, q: 1, decay: 0.2, gain: Math.min(0.6, impact / 14), pos: this.pos });
        }
        this.speed *= 0.5;
      }
    }
    this.pos.copy(next);
    this.syncTransform(dt);
    // steering wheel
    this.wheel.rotation.z = this.steer * 3;
    // lights / dial
    for (const l of this.headlights) if (this.lightsOn) l.intensity = 6.0 * pe;
    this.lampMat.emissiveIntensity = this.lightsOn ? 40 * pe : 0;
    (this.radioDial.material as THREE.MeshStandardMaterial).emissiveIntensity = this.occupied ? 2.5 * pe * 0.003 : 0;
    // audio
    if (this.engine && audio.ctx) {
      const t = audio.now;
      const spd = Math.abs(this.speed);
      const gearSpan = 5.5;
      const gearPos = (spd % gearSpan) / gearSpan;
      const rpm = 750 + (spd < 0.5 ? 0 : 900 + gearPos * 2400) + Math.max(0, throttle) * 400;
      const f = (rpm / 60) * 4;
      for (const o of this.engine.osc) o.frequency.setTargetAtTime((f * (o as OscillatorNode & { mul: number }).mul) / 4, t, 0.08);
      this.engine.filter.frequency.setTargetAtTime(300 + rpm * 0.35, t, 0.1);
      this.engine.gain.gain.setTargetAtTime(this.occupied || spd > 0.1 ? 0.22 + Math.abs(throttle) * 0.12 : 0.0, t, 0.2);
      this.engine.noiseGain.gain.setTargetAtTime(0.08 + Math.abs(throttle) * 0.15, t, 0.2);
      audio.setPos((this.engine as unknown as { pan: PannerNode }).pan, this.pos.clone().add(new THREE.Vector3(0, 1, 0)));
      this.tireGain?.gain.setTargetAtTime(Math.min(0.35, spd * 0.02) * (1 + rough), t, 0.2);
    }
  }

  private syncTransform(dt: number) {
    const dir = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const side = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const hF = this.groundAt(this.pos.x + dir.x * 1.6, this.pos.z + dir.z * 1.6);
    const hB = this.groundAt(this.pos.x - dir.x * 1.6, this.pos.z - dir.z * 1.6);
    const hL = this.groundAt(this.pos.x + side.x * 0.8, this.pos.z + side.z * 0.8);
    const hR = this.groundAt(this.pos.x - side.x * 0.8, this.pos.z - side.z * 0.8);
    const k = dt >= 1 ? 1 : 1 - Math.exp(-10 * dt);
    this.y = lerp(this.y, (hF + hB + hL + hR) / 4, k);
    this.pitch = lerp(this.pitch, Math.atan2(hF - hB, 3.2), k);
    this.roll = lerp(this.roll, Math.atan2(hL - hR, 1.6), k);
    this.root.position.set(this.pos.x, this.y, this.pos.z);
    this.root.rotation.set(0, this.yaw, 0);
    this.body.rotation.set(-this.roll * 0.9, 0, this.pitch * 0.9, 'YXZ');
    // subtle body roll from cornering
    this.body.rotation.x += -this.steer * Math.abs(this.speed) * 0.004;
    this.root.updateMatrixWorld(true);
  }
}

function makeDecal() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 128);
  g.strokeStyle = '#2d4a3a';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(64, 64, 44, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#2d4a3a';
  g.font = "700 22px 'Arial Narrow', Arial, sans-serif";
  g.textAlign = 'center';
  g.fillText('HC', 64, 72);
  g.textAlign = 'left';
  g.font = "700 18px 'Arial Narrow', Arial, sans-serif";
  g.fillText('HARROW CO.', 118, 56);
  g.fillText('COMMS', 118, 80);
  g.font = "700 16px 'Arial Narrow', Arial, sans-serif";
  g.fillText('UNIT 7', 118, 104);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
