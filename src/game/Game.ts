// The running game: player / truck / ladder / binocular modes, interaction, doors,
// audio wiring and the per-frame update order. Story logic lives in Story.ts.
import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import { Input } from '../core/Input';
import type { World } from './WorldBuilder';
import { Player, type Surface } from './Player';
import { Interaction, Door } from './Interaction';
import { Truck } from './Vehicle';
import { Dialogue } from './Dialogue';
import type { UI } from '../ui/UI';
import type { Box } from '../world/Collision';
import { audio, type SurfaceSound } from '../audio/AudioEngine';
import { ambience } from '../audio/Ambience';
import { stdMat } from '../world/Town';
import { clamp, damp, smoothstep, wrapAngle, DEG } from '../core/math';
import { P, RIVER } from '../world/Layout';

export type Mode = 'title' | 'walk' | 'drive' | 'climb' | 'binoc' | 'cutscene';

type Footprint = { inv: THREE.Matrix4; w: number; d: number; y0: number; y1: number; id: string };

export class Game {
  engine: Engine;
  world: World;
  input: Input;
  player: Player;
  ui: UI;
  interaction: Interaction;
  truck: Truck;
  dialogue: Dialogue;
  doors = new Map<string, Door>();
  mode: Mode = 'title';
  fly = false;
  paused = false;
  time = 0;
  inside = 0;
  insideId: string | null = null;
  onUpdate: ((dt: number) => void)[] = [];
  /** Story hooks */
  onEnterTruck: (() => void) | null = null;
  onExitTruck: (() => void) | null = null;
  canExitTruck: () => boolean = () => true;
  private flyYaw = 0;
  private flyPitch = 0;
  private footprints: Footprint[] = [];
  private climb: { from: THREE.Vector3; to: THREE.Vector3; t: number; len: number; yaw: number; done: () => void } | null = null;
  private binoc: { yaw: number; pitch: number; range: number; done?: () => void } | null = null;
  private forestSmooth = 0;
  private lookIdle = 0;
  private humIds: Record<string, number> = {};
  private truckWasDark = false;

  constructor(engine: Engine, world: World, ui: UI) {
    this.engine = engine;
    this.world = world;
    this.ui = ui;
    this.input = new Input(engine.canvas);
    ui.attachInput(this.input);
    const terrain = world.terrain;
    const surfaceAt = (x: number, z: number, _y: number, box: Box | null): Surface => {
      if (box) return ((box.tag as Surface) ?? 'wood') as Surface;
      const s = terrain.surfaceAt(x, z);
      const h = terrain.heightAt(x, z);
      if (s.road > 0.55) return x < -200 && z > -470 ? 'gravel' : 'asphalt';
      if (s.road > 0.2) return 'gravel';
      if (h < 1.3) return h > -1.2 && s.water <= 0 ? 'sand' : 'mud';
      if (s.forest > 0.45) return 'forest';
      const n = terrain.normalAt(x, z);
      if (n.y < 0.7) return 'rock';
      return 'grass';
    };
    this.player = new Player(engine.camera, this.input, world.collision, surfaceAt, engine.quality.flashShadow);
    this.player.addTo(engine.scene);
    // road surface sits slightly above the terrain
    const baseHeight = world.collision.heightAt;
    world.collision.heightAt = (x, z) => {
      const s = terrain.surfaceAt(x, z);
      return baseHeight(x, z) + (s.road > 0.5 ? 0.34 : s.road * 0.6);
    };
    this.interaction = new Interaction(this.input, ui, world.collision, engine.camera);
    this.interaction.enabled = false;
    // on touch screens a tap lowers the binoculars
    const tapUse = this.input.onTap;
    this.input.onTap = (x, y) => {
      if (this.mode === 'binoc') {
        this.endBinoculars();
        return;
      }
      tapUse?.(x, y);
    };
    this.dialogue = new Dialogue(ui);

    // the county pickup
    this.truck = new Truck(
      engine.scene,
      (x, z) => world.collision.heightAt(x, z),
      (x, z) => {
        const s = terrain.surfaceAt(x, z);
        return s.road > 0.5 ? 0 : s.road > 0.2 ? 0.25 : 0.75;
      },
      engine.quality.tier !== 'low',
    );
    this.truck.place(world.dressing.truckSpot.pos, world.dressing.truckSpot.yaw);
    this.addTruckCollider();

    // hinged doors for every enterable building
    const t0 = world.town.materials.door as THREE.MeshStandardMaterial;
    const doorMat = stdMat({ map: t0.map!, normal: t0.normalMap! }, { vertexColors: false, color: 0x8a6a4c, rough: 1 });
    const doorPaint: Record<string, number> = { sheriff: 0x3a4a44, diner: 0x7a3a2c, pell: 0xe8e2d4, harbormaster: 0x2f4a5a, relayhut: 0x6f726c, keeper: 0x2d3a34 };
    for (const b of world.town.buildings) {
      if (!b.spec.enterable) continue;
      const tint = doorPaint[b.spec.id];
      const mat = tint !== undefined ? doorMat.clone() : doorMat;
      if (tint !== undefined) (mat as THREE.MeshStandardMaterial).color.setHex(tint);
      for (const d of b.doors) {
        if (!(b.spec.facades?.[d.side]?.doors ?? []).some((ds) => ds.id === d.id && ds.enterable)) continue;
        const tangent = new THREE.Vector3(Math.cos(d.yaw), 0, -Math.sin(d.yaw));
        const hinge = d.world.clone().addScaledVector(tangent, -d.w / 2);
        const door = new Door(engine.scene, world.collision, this.interaction, { id: d.id, hinge, yaw: d.yaw, w: d.w, h: d.h, mat, label: 'Door' });
        this.doors.set(d.id, door);
      }
      const inv = b.matrix.clone().invert();
      this.footprints.push({ inv, w: b.spec.w, d: b.spec.d, y0: b.spec.floorY - 0.5, y1: b.spec.floorY + b.wallH + 0.5, id: b.spec.id });
    }

    // audio wiring
    const sound = (s: Surface): SurfaceSound => s as SurfaceSound;
    this.player.onStep = (s, k) => audio.footstep(sound(s), k, undefined, this.inside);
    this.player.onLand = (s, v) => audio.footstep(sound(s), Math.min(1, v / 5));
    this.player.onFlash = (on) => {
      audio.click(undefined, 0.3);
      this.ui.setFlashButton(this.player.hasFlashlight, on);
    };
    world.env.onThunder = (delay, power, dist) => audio.thunder(delay, power, dist);
    ambience.setRiver(
      RIVER.filter((p) => p.z < 250).map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      new THREE.Vector3(P.waterfall.x, 70, P.waterfall.z),
    );
    const cam = engine.camera;
    ambience.birdSpots = () => {
      const a = Math.random() * Math.PI * 2,
        r = 12 + Math.random() * 30;
      const x = cam.position.x + Math.cos(a) * r,
        z = cam.position.z + Math.sin(a) * r;
      const f = terrain.surfaceAt(x, z).forest;
      return f > 0.25 || Math.random() < 0.2 ? new THREE.Vector3(x, terrain.heightAt(x, z) + 6 + Math.random() * 10, z) : null;
    };
    ambience.gullSpots = () => {
      const p = cam.position;
      if (p.z < 120) return null;
      return new THREE.Vector3(p.x + (Math.random() - 0.5) * 160, 20 + Math.random() * 30, p.z + 30 + Math.random() * 150);
    };
    engine.add({ update: (dt) => this.update(dt) });
  }

  private truckBox: Box | null = null;
  private addTruckCollider() {
    this.truckBox = this.world.collision.add({ kind: 'box', x: 0, z: 0, hw: 2.6, hd: 1.0, rot: 0, y0: -1e3, y1: 1e3, walkable: false, dynamic: true, tag: 'truck' }) as Box;
    this.syncTruckCollider();
  }
  private syncTruckCollider() {
    const b = this.truckBox;
    if (!b) return;
    const t = this.truck;
    const dir = new THREE.Vector3(Math.cos(t.yaw), 0, -Math.sin(t.yaw));
    b.x = t.pos.x - dir.x * 0.1;
    b.z = t.pos.z - dir.z * 0.1;
    b.rot = -t.yaw;
    b.y0 = t.y - 0.2;
    b.y1 = t.y + 1.9;
    b.enabled = !t.occupied;
    this.world.collision.updateBox(b);
  }

  /** Start ambient hums etc. once audio is running. */
  startAudio() {
    ambience.start();
    this.truck.startAudio();
    const pl = this.world.places;
    this.humIds.transformer = ambience.addHum(pl.yard.transformer, 60, 5);
    this.humIds.hut = ambience.addHum(pl.yard.hut.clone().add(new THREE.Vector3(0, 2.5, 0)), 120, 2);
  }

  setHum(name: string, level: number) {
    if (this.humIds[name] !== undefined) ambience.setHum(this.humIds[name], level);
  }

  setFly(on: boolean, yawDeg?: number, pitchDeg?: number) {
    this.fly = on;
    if (yawDeg !== undefined) this.flyYaw = THREE.MathUtils.degToRad(yawDeg);
    if (pitchDeg !== undefined) this.flyPitch = THREE.MathUtils.degToRad(pitchDeg);
  }

  // ---------------------------------------------------------------- truck
  enterTruck() {
    const t = this.truck;
    t.occupied = true;
    this.mode = 'drive';
    this.player.setFlash(false);
    t.lookYaw = 0;
    t.lookPitch = -0.05;
    audio.door('open', t.doorPoint());
    setTimeout(() => audio.door('close', t.doorPoint()), 700);
    this.syncTruckCollider();
    this.onEnterTruck?.();
  }

  exitTruck() {
    const t = this.truck;
    if (Math.abs(t.speed) > 1.5) return;
    let p = t.exitPoint();
    // other side if the driver's side is blocked
    const probe = p.clone();
    probe.y = this.world.collision.heightAt(p.x, p.z);
    if (this.world.collision.resolve(probe.clone(), 0.35, probe.y + 0.3, probe.y + 1.7, 0.4)) {
      const side = new THREE.Vector3(0, 0, 2.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw);
      p = t.pos.clone().add(side);
    }
    t.occupied = false;
    t.speed = 0;
    this.syncTruckCollider();
    const camYaw = t.yaw - Math.PI / 2 + t.lookYaw;
    this.player.teleport(p.x, null, p.z, THREE.MathUtils.radToDeg(camYaw), -3);
    this.mode = 'walk';
    audio.door('open', t.doorPoint());
    setTimeout(() => audio.door('close', t.doorPoint()), 900);
    this.onExitTruck?.();
  }

  // ---------------------------------------------------------------- ladder / binoculars
  startClimb(from: THREE.Vector3, to: THREE.Vector3, faceYawDeg: number, done: () => void) {
    this.mode = 'climb';
    this.player.teleport(from.x, from.y, from.z, faceYawDeg, 20);
    this.climb = { from: from.clone(), to: to.clone(), t: 0, len: from.distanceTo(to), yaw: faceYawDeg * DEG, done };
    this.player.lockedYawCenter = faceYawDeg * DEG;
    this.player.lockedYawRange = 1.1;
    this.player.mode = 'locked';
  }

  startBinoculars(yawDeg: number, pitchDeg: number, done?: () => void) {
    this.mode = 'binoc';
    this.binoc = { yaw: yawDeg * DEG, pitch: pitchDeg * DEG, range: 0.7, done };
    this.player.lockedYawCenter = yawDeg * DEG;
    this.player.lockedYawRange = 0.7;
    this.player.yaw = yawDeg * DEG;
    this.player.pitch = pitchDeg * DEG;
    this.player.mode = 'locked';
    this.ui.setBinoculars(true);
    audio.click(undefined, 0.2);
  }

  endBinoculars() {
    if (!this.binoc) return;
    const done = this.binoc.done;
    this.binoc = null;
    this.mode = 'walk';
    this.player.mode = 'walk';
    this.player.lockedYawCenter = null;
    this.player.lookScale = 1;
    this.player.baseFov = 66;
    this.ui.setBinoculars(false);
    done?.();
  }

  // ---------------------------------------------------------------- helpers
  /** Vertical FOV that keeps a usable horizontal view on portrait screens. */
  naturalFov(base: number) {
    const aspect = this.engine.camera.aspect;
    return aspect < 1 ? base + (1 - aspect) * 34 : base;
  }

  private updateInside(dt: number) {
    const p = this.player.pos;
    let id: string | null = null;
    const v = new THREE.Vector3();
    for (const f of this.footprints) {
      if (p.y < f.y0 || p.y > f.y1) continue;
      v.copy(p).applyMatrix4(f.inv);
      if (Math.abs(v.x) < f.w / 2 - 0.1 && v.z > 0.1 && v.z < f.d - 0.1) {
        id = f.id;
        break;
      }
    }
    if (this.mode === 'drive') id = 'truck';
    this.insideId = id;
    this.inside = damp(this.inside, id ? 1 : 0, 4, dt);
    this.player.inside = this.inside;
  }

  private updateAudio(dt: number) {
    const cam = this.engine.camera;
    audio.updateListener(cam);
    const env = this.world.env;
    const w = env.weather;
    const s = ambience.state;
    const sunEl = Math.asin(env.sunDir.y) / DEG;
    s.wind = w.wind;
    s.gust = env.gust;
    s.rain = w.rain * this.world.weather.rainScale;
    s.inside = this.mode === 'drive' ? 0.7 : this.inside;
    s.indoorRoom = this.insideId && this.insideId !== 'truck' ? 1 : 0;
    this.forestSmooth = damp(this.forestSmooth, this.world.terrain.surfaceAt(cam.position.x, cam.position.z).forest, 0.5, dt);
    s.forest = this.forestSmooth;
    s.night = smoothstep(-2, -9, sunEl);
    s.dusk = smoothstep(-6, 0, sunEl) * (1 - smoothstep(4, 12, sunEl));
    ambience.update(dt, cam.position);
  }

  update(dt: number) {
    this.time += dt;
    const cam = this.engine.camera;
    const env = this.world.env;
    this.input.update(dt);
    if (this.paused) {
      this.input.endFrame();
      return;
    }
    if (this.fly) {
      const inp = this.input;
      this.flyYaw += inp.look.x;
      this.flyPitch = THREE.MathUtils.clamp(this.flyPitch + inp.look.y, -1.5, 1.5);
      const sp = inp.sprint ? 60 : 10;
      const f = new THREE.Vector3(-Math.sin(this.flyYaw) * Math.cos(this.flyPitch), Math.sin(this.flyPitch), -Math.cos(this.flyYaw) * Math.cos(this.flyPitch));
      const r = new THREE.Vector3(Math.cos(this.flyYaw), 0, -Math.sin(this.flyYaw));
      cam.position.addScaledVector(f, inp.move.y * sp * dt).addScaledVector(r, inp.move.x * sp * dt);
      cam.rotation.set(this.flyPitch, this.flyYaw, 0, 'YXZ');
      cam.updateMatrixWorld();
    } else if (this.mode === 'walk' || this.mode === 'cutscene') {
      this.player.baseFov = this.naturalFov(66);
      this.player.update(dt, env.preExposure);
    } else if (this.mode === 'drive') {
      this.updateDrive(dt);
    } else if (this.mode === 'climb') {
      this.updateClimb(dt);
    } else if (this.mode === 'binoc') {
      this.player.lookScale = 0.25;
      this.player.baseFov = damp(this.player.baseFov, 11, 6, dt);
      this.player.update(dt, env.preExposure);
      if (this.input.consume('interact') || this.input.consume('back') || this.input.consume('jump')) this.endBinoculars();
    }
    // truck physics runs even when parked (settling, audio); never collide with its own box
    if (this.mode !== 'drive') {
      if (this.truckBox) this.truckBox.enabled = false;
      this.truck.update(dt, null, this.world.collision, env.preExposure);
    }
    this.syncTruckCollider();
    const dark = Math.asin(env.sunDir.y) / DEG < 1.5 || env.weather.storm > 0.55;
    if (this.truck.occupied && dark !== this.truckWasDark) this.truck.setLights(dark, env.preExposure);
    if (this.truck.occupied) this.truckWasDark = dark;

    for (const d of this.doors.values()) d.update(dt);
    this.interaction.enabled = this.mode === 'walk' && !this.ui.docOpen && !this.ui.panelOpen;
    this.interaction.update();
    this.dialogue.update(dt);
    this.updateInside(dt);
    for (const u of this.onUpdate) u(dt);
    env.update(dt, cam);
    for (const u of this.world.updaters) u(dt, cam);
    // particles
    const wf = this.world.weather;
    const fl = this.player.flashlight;
    wf.flash.pos.copy(fl.position);
    wf.flash.dir.copy(fl.target.position).sub(fl.position).normalize();
    wf.flash.intensity = this.player.flashOn ? fl.intensity : 0;
    if (this.truck.lightsOn) {
      const hl = this.truck.headlights[0];
      const hp = new THREE.Vector3().setFromMatrixPosition(hl.matrixWorld);
      const ht = new THREE.Vector3().setFromMatrixPosition(hl.target.matrixWorld);
      wf.headlight = { pos: hp, dir: ht.sub(hp).normalize(), intensity: hl.intensity * 2 };
    } else wf.headlight = null;
    wf.update(dt, cam, this.inside);
    this.updateAudio(dt);
    this.ui.update(dt);
    this.input.endFrame();
  }

  private updateDrive(dt: number) {
    const t = this.truck;
    const inp = this.input;
    const env = this.world.env;
    // free look inside the cab, easing back to the road when driving
    t.lookYaw = clamp(t.lookYaw + inp.look.x, -2.3, 2.3);
    t.lookPitch = clamp(t.lookPitch + inp.look.y, -0.7, 0.5);
    if (Math.abs(inp.look.x) + Math.abs(inp.look.y) > 1e-4) this.lookIdle = 0;
    else this.lookIdle += dt;
    if (this.lookIdle > 1.6 && Math.abs(t.speed) > 3) {
      t.lookYaw = damp(t.lookYaw, 0, 1.5, dt);
      t.lookPitch = damp(t.lookPitch, -0.05, 1.5, dt);
    }
    if (this.truckBox) this.truckBox.enabled = false;
    t.update(dt, inp, this.world.collision, env.preExposure);
    const cam = this.engine.camera;
    const q = new THREE.Quaternion();
    t.body.getWorldQuaternion(q);
    const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(t.lookPitch, -Math.PI / 2 + t.lookYaw, 0, 'YXZ'));
    cam.quaternion.copy(q).multiply(look);
    t.eyeWorld(cam.position);
    // bumps
    const sp = Math.abs(t.speed);
    cam.position.y += Math.sin(this.time * 17) * 0.004 * Math.min(1, sp / 8) * (1 + t.surfaceRough(t.pos.x, t.pos.z) * 3);
    const cabFov = this.naturalFov(64);
    if (Math.abs(cam.fov - cabFov) > 0.01) {
      cam.fov = cabFov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    // keep the walking player with the truck
    this.player.pos.copy(t.pos);
    this.player.yaw = wrapAngle(t.yaw - Math.PI / 2);
    // exit
    const slow = Math.abs(t.speed) < 1.5;
    this.ui.setFocus(slow && this.canExitTruck() ? 'Truck' : null, 'Get out');
    if (inp.consume('interact') && slow && this.canExitTruck()) this.exitTruck();
    if (inp.consume('flashlight')) t.setLights(!t.lightsOn, env.preExposure);
  }

  private updateClimb(dt: number) {
    const c = this.climb!;
    const inp = this.input;
    const up = Math.max(inp.move.y, this.ui.touchUI ? 0.35 : 0) + (inp.sprint ? 0.2 : 0);
    const down = Math.min(inp.move.y, 0);
    const prev = c.t;
    c.t = clamp(c.t + (up * 1.8 + down * 2.0) * dt / c.len, 0, 1);
    const p = c.from.clone().lerp(c.to, c.t);
    this.player.pos.copy(p);
    // rung steps
    const rung = Math.floor((c.t * c.len) / 0.3);
    if (rung !== Math.floor((prev * c.len) / 0.3)) audio.footstep('metal', 0.5);
    this.player.update(dt, this.world.env.preExposure);
    if (c.t >= 1) {
      this.climb = null;
      this.player.lockedYawCenter = null;
      this.player.mode = 'walk';
      this.mode = 'walk';
      c.done();
    }
  }
}
