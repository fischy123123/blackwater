import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import { Input } from '../core/Input';
import type { World } from './WorldBuilder';
import { Player, type Surface } from './Player';

export class Game {
  engine: Engine;
  world: World;
  input: Input;
  player: Player;
  fly = false;
  private flyYaw = 0;
  private flyPitch = 0;
  onUpdate: ((dt: number) => void)[] = [];
  started = false;

  constructor(engine: Engine, world: World) {
    this.engine = engine;
    this.world = world;
    this.input = new Input(engine.canvas);
    const terrain = world.terrain;
    const surfaceAt = (x: number, z: number, y: number, box: import('../world/Collision').Box | null): Surface => {
      if (box) return (box.tag as Surface) ?? 'wood';
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
    engine.add({ update: (dt) => this.update(dt) });
  }

  setFly(on: boolean, yawDeg?: number, pitchDeg?: number) {
    this.fly = on;
    if (yawDeg !== undefined) this.flyYaw = THREE.MathUtils.degToRad(yawDeg);
    if (pitchDeg !== undefined) this.flyPitch = THREE.MathUtils.degToRad(pitchDeg);
  }

  update(dt: number) {
    const cam = this.engine.camera;
    this.input.update(dt);
    const env = this.world.env;
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
    } else {
      this.player.update(dt, env.preExposure);
    }
    for (const u of this.onUpdate) u(dt);
    env.update(dt, cam);
    for (const u of this.world.updaters) u(dt, cam);
    this.input.endFrame();
  }
}
