// Furnishing for enterable buildings. Everything is placed in the building's local frame
// (origin at front-centre, +z into the building, facade facing -z).
import * as THREE from 'three';
import { MeshBatcher } from './Batcher';
import type { BuildingInfo } from './BuildingGen';
import type { CollisionWorld } from './Collision';
import type { LightManager } from './Lights';
import { RNG } from '../core/math';
import { LAYER } from '../render/Globals';
import { SHARED_MATS } from './Dressing';
import { stdMat } from './Town';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export type Anchor = { pos: THREE.Vector3; yaw?: number };
export type InteriorResult = { group: THREE.Group; anchors: Map<string, Anchor>; dynamic: Map<string, THREE.Object3D> };

class Furnisher {
  b: MeshBatcher;
  info: BuildingInfo;
  col: CollisionWorld;
  lights: LightManager;
  anchors: Map<string, Anchor>;
  rng: RNG;
  y0: number;
  constructor(b: MeshBatcher, info: BuildingInfo, col: CollisionWorld, lights: LightManager, anchors: Map<string, Anchor>) {
    this.b = b;
    this.info = info;
    this.col = col;
    this.lights = lights;
    this.anchors = anchors;
    this.rng = new RNG(info.spec.x * 13 + info.spec.z * 7);
    this.y0 = info.spec.floorY;
  }
  world(x: number, y: number, z: number) {
    return V(x, y, z).applyMatrix4(this.info.matrix);
  }
  /** collision box in local coords */
  solid(x: number, z: number, w: number, d: number, h: number, walkable = false, tag = 'furniture', yLocal = 0) {
    const c = this.world(x, 0, z);
    this.col.boxYaw(c.x, c.z, w, d, this.info.spec.yaw, this.y0 + yLocal - 0.1, this.y0 + yLocal + h, walkable, tag);
  }
  anchor(name: string, x: number, y: number, z: number, yaw = 0) {
    this.anchors.set(name, { pos: this.world(x, y, z), yaw: this.info.spec.yaw + yaw });
  }
  color(hex: number, k = 1) {
    this.b.color.set(hex).multiplyScalar(k);
  }
  floor(kind: 'wood' | 'lino' | 'carpet' | 'concrete', color = 0xffffff) {
    const { w, d } = this.info.spec;
    this.color(color);
    const key = kind === 'wood' ? 'planks' : kind === 'lino' ? 'lino' : kind === 'carpet' ? 'fabric' : 'concrete';
    this.b.box(key, 0, 0.01, d / 2, w - 0.36, 0.02, d - 0.36, kind === 'wood' ? 0.6 : 0.5, 0b001000);
    // ceiling
    const H = this.info.wallH;
    this.color(0xd8d4ca);
    this.b.box('plasterIn', 0, Math.min(H, (this.info.spec.storyH ?? 3) - 0.02), d / 2, w - 0.36, 0.04, d - 0.36, 0.5, 0b000100);
    // baseboards
    this.color(0x5a4636);
    this.b.box('woodPaint', 0, 0.06, 0.22, w - 0.4, 0.12, 0.03);
    this.b.box('woodPaint', 0, 0.06, d - 0.22, w - 0.4, 0.12, 0.03);
    this.b.box('woodPaint', -w / 2 + 0.2, 0.06, d / 2, 0.03, 0.12, d - 0.4);
    this.b.box('woodPaint', w / 2 - 0.2, 0.06, d / 2, 0.03, 0.12, d - 0.4);
  }
  ceilingLight(x: number, z: number, id: string, kind: 'incandescent' | 'fluorescent' = 'incandescent', power = 0.06) {
    const H = (this.info.spec.storyH ?? 3) - 0.05;
    this.color(0xe8e0d0);
    if (kind === 'fluorescent') {
      this.b.box('lampShade', x, H - 0.06, z, 1.2, 0.08, 0.25);
    } else {
      this.b.cylinder('metal', V(x, H, z), V(x, H - 0.3, z), 0.01, 0.01, 4);
      this.b.cylinder('lampShade', V(x, H - 0.3, z), V(x, H - 0.45, z), 0.1, 0.26, 12, false);
    }
    this.lights.add({ id, group: 'bldg:' + this.info.spec.id, pos: this.world(x, H - 0.5, z), kind, power, range: 9, glowSize: 0.15 });
  }
  table(x: number, z: number, w: number, d: number, h = 0.76, color = 0x6a4a32, yaw = 0) {
    const b = this.b;
    b.pushTRS(x, 0, z, yaw);
    this.color(color);
    b.box('wood', 0, h - 0.02, 0, w, 0.04, d, 1);
    for (const [lx, lz] of [
      [-w / 2 + 0.05, -d / 2 + 0.05],
      [w / 2 - 0.05, -d / 2 + 0.05],
      [-w / 2 + 0.05, d / 2 - 0.05],
      [w / 2 - 0.05, d / 2 - 0.05],
    ])
      b.box('wood', lx, (h - 0.04) / 2, lz, 0.05, h - 0.04, 0.05, 1);
    b.pop();
    this.solid(x, z, w, d, h);
  }
  chair(x: number, z: number, yaw: number, color = 0x5a3e2a, tipped = false) {
    const b = this.b;
    b.pushTRS(x, 0, z, yaw);
    if (tipped) b.push(new THREE.Matrix4().makeRotationX(-1.45).setPosition(0, 0.23, 0.35));
    this.color(color);
    b.box('wood', 0, 0.45, 0, 0.42, 0.04, 0.42, 1);
    for (const [lx, lz] of [
      [-0.18, -0.18],
      [0.18, -0.18],
      [-0.18, 0.18],
      [0.18, 0.18],
    ])
      b.box('wood', lx, 0.22, lz, 0.035, 0.45, 0.035, 1);
    b.box('wood', 0, 0.72, 0.19, 0.42, 0.5, 0.03, 1);
    if (tipped) b.pop();
    b.pop();
    if (!tipped) this.solid(x, z, 0.4, 0.4, 0.5);
  }
  shelf(x: number, z: number, w: number, h: number, yaw: number, books = true) {
    const b = this.b;
    b.pushTRS(x, 0, z, yaw);
    this.color(0x4a3526);
    b.box('wood', 0, h / 2, 0, w, h, 0.03, 1);
    b.box('wood', -w / 2, h / 2, 0.15, 0.03, h, 0.3, 1);
    b.box('wood', w / 2, h / 2, 0.15, 0.03, h, 0.3, 1);
    const n = Math.floor(h / 0.38);
    for (let i = 0; i <= n; i++) {
      this.color(0x4a3526);
      b.box('wood', 0, 0.05 + i * 0.38, 0.15, w, 0.025, 0.3, 1);
      if (books && i < n) {
        let bx = -w / 2 + 0.04;
        while (bx < w / 2 - 0.08) {
          const bw = this.rng.range(0.025, 0.06);
          const bh = this.rng.range(0.2, 0.3);
          if (this.rng.chance(0.08)) {
            bx += 0.1;
            continue;
          }
          const c = this.rng.pick([0x6a2a22, 0x2a3a5a, 0x3a4a2a, 0x7a6a4a, 0x2a2a2a, 0x8a7a5a, 0x5a2a4a]);
          this.color(c, this.rng.range(0.7, 1.1));
          const lean = this.rng.chance(0.1) ? 0.3 : 0;
          b.pushTRS(bx + bw / 2, 0.065 + i * 0.38 + bh / 2, 0.14, 0);
          if (lean) b.push(new THREE.Matrix4().makeRotationZ(lean));
          b.box('fabric', 0, 0, 0, bw, bh, this.rng.range(0.16, 0.22), 2);
          if (lean) b.pop();
          b.pop();
          bx += bw + 0.004;
        }
      }
    }
    b.pop();
    const c = this.world(x, 0, z);
    void c;
    this.solid(x, z, yaw === 0 || Math.abs(yaw - Math.PI) < 0.1 ? w : 0.35, yaw === 0 || Math.abs(yaw - Math.PI) < 0.1 ? 0.35 : w, h);
  }
  box(key: string, x: number, y: number, z: number, w: number, h: number, d: number, color: number, solid = true) {
    this.color(color);
    this.b.box(key, x, y + h / 2, z, w, h, d, 1);
    if (solid) this.solid(x, z, w, d, y + h);
  }
  cup(x: number, y: number, z: number, color = 0xe8e4da) {
    this.color(color);
    this.b.cylinder('ceramic', V(x, y, z), V(x, y + 0.09, z), 0.04, 0.045, 10);
  }
  plate(x: number, y: number, z: number, food = true) {
    this.color(0xe9e6de);
    this.b.cylinder('ceramic', V(x, y, z), V(x, y + 0.015, z), 0.12, 0.1, 14);
    if (food) {
      this.color(0x8a5a2a);
      this.b.cylinder('fabric', V(x + 0.02, y + 0.015, z), V(x + 0.02, y + 0.035, z + 0.01), 0.05, 0.045, 8);
      this.color(0xd8c040);
      this.b.cylinder('fabric', V(x - 0.04, y + 0.015, z - 0.02), V(x - 0.04, y + 0.03, z - 0.02), 0.035, 0.03, 8);
    }
  }
  bed(x: number, z: number, yaw: number) {
    const b = this.b;
    b.pushTRS(x, 0, z, yaw);
    this.color(0x5a4030);
    b.box('wood', 0, 0.2, 0, 1.45, 0.3, 2.0, 1);
    b.box('wood', 0, 0.55, -1.0, 1.5, 1.0, 0.06, 1);
    this.color(0xd8d2c4);
    b.box('fabric', 0, 0.42, 0.05, 1.4, 0.16, 1.9, 1);
    this.color(0x7a3a34);
    b.box('fabric', 0, 0.52, 0.35, 1.46, 0.06, 1.3, 1);
    this.color(0xe6e2d8);
    b.box('fabric', -0.35, 0.56, -0.75, 0.5, 0.12, 0.35, 1);
    b.box('fabric', 0.35, 0.56, -0.75, 0.5, 0.12, 0.35, 1);
    b.pop();
    this.solid(x, z, 1.5, 2.1, 0.6);
  }
  sofa(x: number, z: number, yaw: number, color = 0x6a5a3a) {
    const b = this.b;
    b.pushTRS(x, 0, z, yaw);
    this.color(color);
    b.box('fabric', 0, 0.22, 0, 2.0, 0.3, 0.85, 1);
    b.box('fabric', 0, 0.45, 0.02, 1.8, 0.14, 0.72, 1);
    b.box('fabric', 0, 0.7, 0.36, 2.0, 0.55, 0.16, 1);
    b.box('fabric', -0.93, 0.5, 0, 0.16, 0.36, 0.85, 1);
    b.box('fabric', 0.93, 0.5, 0, 0.16, 0.36, 0.85, 1);
    b.pop();
    this.solid(x, z, Math.abs(Math.sin(yaw)) > 0.5 ? 0.9 : 2.0, Math.abs(Math.sin(yaw)) > 0.5 ? 2.0 : 0.9, 0.9);
  }
  armchair(x: number, z: number, yaw: number, color = 0x6a3a2e) {
    const b = this.b;
    b.pushTRS(x, 0, z, yaw);
    this.color(color);
    b.box('fabric', 0, 0.22, 0, 0.85, 0.3, 0.85, 1);
    b.box('fabric', 0, 0.44, 0.02, 0.65, 0.14, 0.7, 1);
    b.box('fabric', 0, 0.8, 0.36, 0.85, 0.75, 0.16, 1);
    b.box('fabric', -0.36, 0.52, 0, 0.14, 0.4, 0.85, 1);
    b.box('fabric', 0.36, 0.52, 0, 0.14, 0.4, 0.85, 1);
    b.pop();
    this.solid(x, z, 0.85, 0.85, 1.0);
  }
  rug(x: number, z: number, w: number, d: number, color = 0x6a2a24) {
    this.color(color);
    this.b.box('rug', x, 0.03, z, w, 0.012, d, 0.6, 0b001000);
  }
  frame(x: number, y: number, z: number, w: number, h: number, yaw: number, color = 0x3a2a1a) {
    this.b.pushTRS(x, y, z, yaw);
    this.color(color);
    this.b.box('wood', 0, 0, 0, w, h, 0.03, 1);
    this.color(this.rng.pick([0x5a6a7a, 0x7a6a4a, 0x4a5a3a, 0x8a7a6a]));
    this.b.box('paper', 0, 0, -0.018, w * 0.8, h * 0.8, 0.005, 1);
    this.b.pop();
  }
  paper(x: number, y: number, z: number, w: number, h: number, yaw: number, rotX = -Math.PI / 2, color = 0xe8e0cc) {
    this.b.pushTRS(x, y, z, yaw);
    this.b.push(new THREE.Matrix4().makeRotationX(rotX));
    this.color(color);
    this.b.box('paper', 0, 0, 0, w, h, 0.003, 1);
    this.b.pop();
    this.b.pop();
  }
  fridge(x: number, z: number, yaw: number) {
    this.b.pushTRS(x, 0, z, yaw);
    this.color(0xd8d4c4);
    this.b.box('ceramic', 0, 0.85, 0, 0.75, 1.7, 0.7, 1);
    this.color(0x9a9a92);
    this.b.box('metal', 0.3, 1.2, -0.36, 0.03, 0.4, 0.04, 1);
    this.b.pop();
    this.solid(x, z, 0.75, 0.7, 1.7);
  }
  stove(x: number, z: number, yaw: number) {
    this.b.pushTRS(x, 0, z, yaw);
    this.color(0xe8e4d8);
    this.b.box('ceramic', 0, 0.45, 0, 0.76, 0.9, 0.65, 1);
    this.color(0x202020);
    for (const [bx, bz] of [
      [-0.18, -0.14],
      [0.18, -0.14],
      [-0.18, 0.14],
      [0.18, 0.14],
    ])
      this.b.cylinder('metal', V(bx, 0.9, bz), V(bx, 0.915, bz), 0.1, 0.1, 10);
    this.b.pop();
    this.solid(x, z, 0.76, 0.65, 0.9);
  }
  counter(x: number, z: number, w: number, d: number, yaw: number, top = 0xc8c0b0, base = 0x6a4a32) {
    this.b.pushTRS(x, 0, z, yaw);
    this.color(base);
    this.b.box('wood', 0, 0.44, 0, w, 0.88, d, 1);
    this.color(top);
    this.b.box('ceramic', 0, 0.9, 0, w + 0.04, 0.04, d + 0.04, 1);
    this.b.pop();
    this.solid(x, z, Math.abs(Math.sin(yaw)) > 0.5 ? d : w, Math.abs(Math.sin(yaw)) > 0.5 ? w : d, 0.92);
  }
  woodstove(x: number, z: number, id: string) {
    this.color(0x1c1c1c);
    this.b.box('metal', x, 0.45, z, 0.7, 0.75, 0.6, 1);
    this.b.cylinder('metal', V(x, 0.82, z + 0.1), V(x, (this.info.spec.storyH ?? 3), z + 0.1), 0.08, 0.08, 10);
    this.color(0xff7a2a);
    this.b.box('lampShade', x, 0.42, z - 0.305, 0.3, 0.2, 0.01, 1);
    this.solid(x, z, 0.8, 0.7, 1);
    this.lights.add({ id, group: 'bldg:' + this.info.spec.id, pos: this.world(x, 0.6, z - 0.6), kind: 'fire', power: 0.09, range: 8, glowSize: 0.1 });
  }
  tableLamp(x: number, y: number, z: number, id: string) {
    this.color(0x8a7a5a);
    this.b.cylinder('metal', V(x, y, z), V(x, y + 0.35, z), 0.06, 0.02, 8);
    this.color(0xf0e0c0);
    this.b.cylinder('lampShade', V(x, y + 0.3, z), V(x, y + 0.52, z), 0.17, 0.11, 12, false);
    this.lights.add({ id, group: 'bldg:' + this.info.spec.id, pos: this.world(x, y + 0.42, z), kind: 'incandescent', power: 0.035, range: 7, glowSize: 0.12 });
  }
  window() {
    /* windows come from the building shell */
  }
}

export function furnishAll(buildings: Map<string, BuildingInfo>, collision: CollisionWorld, lights: LightManager, scene: THREE.Scene): InteriorResult {
  const b = new MeshBatcher();
  const anchors = new Map<string, Anchor>();
  const dynamic = new Map<string, THREE.Object3D>();
  const group = new THREE.Group();
  group.name = 'interiors';
  const run = (id: string, fn: (f: Furnisher) => void) => {
    const info = buildings.get(id);
    if (!info) return;
    b.push(info.matrix);
    const f = new Furnisher(b, info, collision, lights, anchors);
    fn(f);
    b.pop();
  };

  // ------------------------------------------------ sheriff's substation
  run('sheriff', (f) => {
    const { w, d } = f.info.spec;
    f.floor('lino', 0x9a948a);
    f.ceilingLight(0, d * 0.35, 'sheriff-light-1', 'fluorescent', 0.07);
    f.ceilingLight(0, d * 0.75, 'sheriff-light-2', 'fluorescent', 0.07);
    // front counter
    f.counter(0.6, 2.2, w - 4.7, 0.6, 0, 0x7a6a5a, 0x5a4a3a);
    // desk with typewriter, radio, the log
    f.table(-2.4, 5.4, 1.5, 0.8, 0.76, 0x4a3a2a);
    f.box('metal', -2.7, 0.76, 5.4, 0.45, 0.14, 0.35, 0x3a3e3a, false); // typewriter
    f.box('metal', -2.0, 0.76, 5.6, 0.4, 0.2, 0.3, 0x2e2e2c, false); // radio set
    f.paper(-2.3, 0.775, 5.25, 0.3, 0.38, 0.2);
    f.anchor('sheriffLog', -2.3, 0.8, 5.25);
    f.chair(-2.4, 6.1, Math.PI, 0x3a3a3a, true);
    // key board on the wall
    f.box('wood', w / 2 - 0.25, 1.3, 4.2, 0.03, 0.6, 0.8, 0x6a5a40, false);
    for (let i = 0; i < 6; i++) f.box('metal', w / 2 - 0.28, 1.45 - (i % 2) * 0.25, 3.9 + Math.floor(i / 2) * 0.25, 0.02, 0.06, 0.02, 0xb0a070, false);
    f.anchor('gateKey', w / 2 - 0.35, 1.3, 4.2);
    // filing cabinets, map
    f.box('metal', w / 2 - 0.4, 0, 7.4, 0.6, 1.3, 0.6, 0x5a6258);
    f.box('metal', w / 2 - 0.4, 0, 6.7, 0.6, 1.3, 0.6, 0x5a6258);
    f.paper(-w / 2 + 0.22, 1.6, 3.5, 1.6, 1.0, Math.PI / 2, 0, 0xd8cca8);
    // holding cell bars at the back
    for (let i = 0; i < 12; i++) f.box('metal', 1.0 + i * 0.22, 0, d - 2.2, 0.03, 2.4, 0.03, 0x3a3a3a, false);
    f.solid(2.2, d - 2.2, 2.7, 0.1, 2.4);
    f.chair(-3.2, 2.9, 0.4, 0x5a3e2a);
  });

  // ------------------------------------------------ the diner
  run('diner', (f) => {
    const { w, d } = f.info.spec;
    f.floor('lino', 0xd8d0c0);
    f.ceilingLight(-3, 3, 'diner-light-1', 'incandescent', 0.05);
    f.ceilingLight(3, 3, 'diner-light-2', 'incandescent', 0.05);
    f.ceilingLight(0, 7.5, 'diner-light-3', 'fluorescent', 0.06);
    // booths along the front windows
    for (const bx of [-4.2, -2.0, 2.2, 4.4]) {
      f.table(bx, 1.2, 0.8, 0.9, 0.74, 0xb8b0a0);
      for (const s of [-1, 1]) {
        f.b.pushTRS(bx + s * 0.75, 0, 1.2, 0);
        f.color(0x8a2a24);
        f.b.box('fabric', 0, 0.23, 0, 0.5, 0.46, 1.0, 1);
        f.b.box('fabric', s * 0.2, 0.75, 0, 0.12, 0.6, 1.0, 1);
        f.b.pop();
        f.solid(bx + s * 0.75, 1.2, 0.5, 1.0, 0.5);
      }
      // abandoned breakfasts
      f.plate(bx - 0.18, 0.74, 1.0);
      f.plate(bx + 0.18, 0.74, 1.35, f.rng.chance(0.5));
      f.cup(bx + 0.28, 0.74, 0.95);
      f.cup(bx - 0.25, 0.74, 1.45);
    }
    f.anchor('dinerTicket', -2.0, 0.76, 1.1);
    // counter with stools
    f.counter(0.5, 5.2, 7.5, 0.7, 0, 0xd8d0c4, 0x3a5a58);
    for (let i = 0; i < 7; i++) {
      const sx = -2.6 + i * 1.05;
      f.color(0x8a2a24);
      f.b.cylinder('fabric', V(sx, 0.7, 4.5), V(sx, 0.78, 4.5), 0.19, 0.19, 12);
      f.color(0xb0b4b4);
      f.b.cylinder('metal', V(sx, 0, 4.5), V(sx, 0.7, 4.5), 0.04, 0.04, 6);
      f.solid(sx, 4.5, 0.35, 0.35, 0.8);
    }
    for (let i = 0; i < 5; i++) f.cup(-2.0 + i * 1.3, 0.92, 5.1);
    // back bar: coffee machine, pie case, grill
    f.counter(0, d - 0.8, w - 1.5, 0.7, 0, 0xb8b8b0, 0x6a6a64);
    f.box('metal', -3.8, 0.92, d - 0.8, 0.6, 0.55, 0.45, 0x8a8a84, false);
    f.box('glass', -1.5, 0.92, d - 0.8, 0.9, 0.5, 0.45, 0xffffff, false);
    f.box('metal', 2.4, 0.92, d - 0.8, 1.6, 0.08, 0.6, 0x1c1c1c, false);
    // jukebox (glows when powered)
    f.box('lampShade', w / 2 - 0.7, 0, 3.6, 0.9, 1.5, 0.6, 0xff9a50);
    f.solid(w / 2 - 0.7, 3.6, 0.9, 0.6, 1.5);
    f.anchor('jukebox', w / 2 - 0.7, 1.0, 3.3);
    lights.add({ id: 'jukebox', group: 'bldg:diner', pos: f.world(w / 2 - 0.7, 1.2, 3.2), kind: 'neon', power: 0.02, range: 5, glowSize: 0.25 });
    // neon sign in the window
    lights.add({ id: 'diner-neon', group: 'bldg:diner', pos: f.world(3.9, 2.4, 0.25), kind: 'neon', power: 0.04, range: 8, glowSize: 0.5 });
    f.chair(3.0, 7.0, 2.4, 0x3a3a3a, true);
  });

  // ------------------------------------------------ the Pell house
  run('pell', (f) => {
    const { w, d } = f.info.spec;
    f.floor('wood', 0x9a8a78);
    f.ceilingLight(-1.5, 3, 'pell-light-1');
    f.ceilingLight(1.8, 7.5, 'pell-light-2');
    f.rug(-1.4, 3.2, 2.6, 2.0, 0x5a3a44);
    f.sofa(-1.4, 4.6, Math.PI, 0x5a6a4a);
    f.table(-1.4, 3.2, 1.0, 0.55, 0.42, 0x5a3e2a);
    f.cup(-1.6, 0.42, 3.1, 0x3a5a8a);
    // TV on a stand
    f.box('wood', -1.4, 0, 1.0, 1.1, 0.55, 0.45, 0x4a3526);
    f.box('metal', -1.4, 0.55, 1.05, 0.62, 0.5, 0.45, 0x2a2826, false);
    f.anchor('tv', -1.4, 0.8, 0.8);
    f.shelf(-w / 2 + 0.4, 6.5, 1.8, 1.9, Math.PI / 2);
    f.armchair(-3.0, 2.2, Math.PI / 2 + 0.4, 0x7a4a34);
    f.tableLamp(-3.4, 0.6, 1.5, 'pell-lamp');
    f.box('wood', -3.4, 0, 1.5, 0.45, 0.6, 0.45, 0x5a3e2a);
    // kitchen at the back right
    f.counter(2.6, d - 0.7, 3.2, 0.62, 0, 0xd8d0c0, 0x7a8a7a);
    f.fridge(w / 2 - 0.6, d - 2.3, -Math.PI / 2);
    f.anchor('fridgeNote', w / 2 - 0.98, 1.3, d - 2.3);
    f.paper(w / 2 - 0.97, 1.35, d - 2.1, 0.2, 0.25, -Math.PI / 2, 0, 0xf2eee0);
    f.stove(1.3, d - 0.7, Math.PI);
    f.table(2.2, 6.2, 1.3, 0.85, 0.76, 0x7a5a3a);
    f.chair(1.6, 6.2, Math.PI / 2);
    f.chair(2.8, 6.2, -Math.PI / 2, 0x5a3e2a, true);
    f.plate(2.0, 0.76, 6.1, false);
    f.cup(2.4, 0.76, 6.3, 0xe8e4da);
    // the child's drawings taped by the door
    f.paper(w / 2 - 0.21, 1.2, 1.8, 0.4, 0.3, Math.PI / 2, 0, 0xf6f2e6);
    f.paper(w / 2 - 0.21, 1.25, 2.35, 0.35, 0.28, Math.PI / 2, 0, 0xf6f2e6);
    f.anchor('drawing', w / 2 - 0.3, 1.2, 2.0);
    // stairs up (blocked)
    for (let i = 0; i < 8; i++) f.box('wood', -w / 2 + 0.8, i * 0.2, d - 1.2 - i * 0.26, 1.0, 0.2, 0.26, 0x6a4a32, false);
    f.solid(-w / 2 + 0.8, d - 2.2, 1.0, 2.2, 2.2);
    f.frame(-0.5, 1.6, 0.25, 0.5, 0.4, Math.PI);
    f.frame(0.4, 1.7, 0.25, 0.35, 0.45, Math.PI);
  });

  // ------------------------------------------------ harbour master
  run('harbormaster', (f) => {
    const { w, d } = f.info.spec;
    f.floor('wood', 0x8a7a6a);
    f.ceilingLight(0, d / 2, 'harbor-light');
    f.table(0.6, d - 1.2, 1.8, 0.8, 0.8, 0x5a4a3a);
    f.box('metal', 0.9, 0.8, d - 1.1, 0.5, 0.35, 0.4, 0x4a5048, false); // chart recorder
    f.paper(0.2, 0.805, d - 1.3, 0.5, 0.3, 0.1, -Math.PI / 2, 0xf2ecd8);
    f.anchor('tideChart', 0.6, 0.9, d - 1.2);
    f.chair(0.6, d - 2.0, 0.3);
    f.paper(-w / 2 + 0.22, 1.5, d / 2, 1.8, 1.1, Math.PI / 2, 0, 0xcfd6c8);
    f.box('metal', w / 2 - 0.5, 0, 1.6, 0.5, 1.8, 0.5, 0x6a6a5a);
    // foul weather gear
    f.box('fabric', -w / 2 + 0.3, 1.0, 1.4, 0.25, 0.9, 0.5, 0xd8b030, false);
  });

  // ------------------------------------------------ relay hut: breaker panel + radio
  run('relayhut', (f) => {
    const { w, d } = f.info.spec;
    f.floor('concrete', 0x8a8884);
    f.ceilingLight(0, d / 2, 'relay-light', 'fluorescent', 0.05);
    // breaker panel on the back wall
    f.box('metal', 0.9, 0.9, d - 0.35, 1.7, 1.4, 0.25, 0x6a7068, false);
    f.solid(0.9, d - 0.35, 1.7, 0.3, 2.3);
    f.anchor('panel', 0.9, 1.6, d - 0.55);
    f.anchor('walt', 1.9, 1.7, d - 0.3);
    f.paper(1.95, 1.65, d - 0.23, 0.2, 0.26, Math.PI, 0, 0xf4efd8);
    // radio desk
    f.table(-1.7, d - 0.8, 1.6, 0.7, 0.78, 0x5a5a52);
    f.box('metal', -1.9, 0.78, d - 0.7, 0.7, 0.3, 0.4, 0x2e3230, false);
    f.box('metal', -1.25, 0.78, d - 0.9, 0.12, 0.25, 0.08, 0x1a1a1a, false); // handheld
    f.anchor('radio', -1.7, 1.0, d - 0.9);
    f.anchor('handheld', -1.25, 0.95, d - 0.9);
    f.chair(-1.7, d - 1.5, 0.2, 0x3a3a3a);
    // equipment racks
    f.box('metal', -w / 2 + 0.45, 0, 1.4, 0.6, 2.0, 0.6, 0x3a3c3a);
    f.box('metal', -w / 2 + 0.45, 0, 2.1, 0.6, 2.0, 0.6, 0x3a3c3a);
    for (let i = 0; i < 6; i++) lights.add({ id: `rack-led-${i}`, group: 'bldg:relayhut', pos: f.world(-w / 2 + 0.78, 0.6 + i * 0.22, 1.2 + (i % 2) * 0.7), kind: i % 3 === 0 ? 'red' : 'mercury', power: 0.0008, range: 1.5, glowSize: 0.015, castLight: false });
  });

  // ------------------------------------------------ keeper's house
  run('keeper', (f) => {
    const { w, d } = f.info.spec;
    f.floor('wood', 0xa08a70);
    f.rug(0.4, 4.2, 2.4, 1.8, 0x3a4a6a);
    f.woodstove(2.8, 6.8, 'keeper-stove');
    f.armchair(1.4, 5.4, -2.3, 0x6a4a3a);
    f.anchor('armchair', 1.4, 0.9, 5.4);
    f.table(-1.6, 3.4, 1.2, 0.8, 0.76, 0x6a4a32);
    f.cup(-1.4, 0.76, 3.3, 0xd8d0c0);
    f.anchor('teacup', -1.4, 0.86, 3.3);
    f.paper(-1.9, 0.765, 3.5, 0.22, 0.3, 0.3, -Math.PI / 2, 0xe8dcc0);
    f.anchor('journal1', -1.9, 0.8, 3.5);
    f.chair(-1.6, 4.1, Math.PI, 0x5a3e2a);
    f.chair(-2.4, 3.3, Math.PI / 2 + 1.2, 0x5a3e2a, true);
    // radio + reel-to-reel on a desk under the window
    f.table(-2.6, 1.0, 1.4, 0.6, 0.78, 0x5a4a38);
    f.box('metal', -2.9, 0.78, 1.0, 0.5, 0.3, 0.35, 0x3a3834, false);
    f.box('metal', -2.3, 0.78, 1.0, 0.45, 0.12, 0.35, 0x2a2826, false);
    f.anchor('recorder', -2.4, 1.0, 1.0);
    f.paper(-2.6, 0.79, 1.3, 0.14, 0.09, 0.4, -Math.PI / 2, 0xf2ead0); // reel label
    f.paper(-2.2, 0.62, d - 1.9, 0.22, 0.3, 0.5, -Math.PI / 2, 0xe8dcc0); // journal left on the bed
    f.anchor('journal2', -2.2, 0.66, d - 1.9);
    f.shelf(w / 2 - 0.35, 3.2, 1.6, 1.8, -Math.PI / 2);
    f.bed(-2.6, d - 1.4, 0);
    f.tableLamp(-1.2, 0.6, d - 0.6, 'keeper-lamp');
    f.box('wood', -1.2, 0, d - 0.6, 0.45, 0.6, 0.45, 0x5a3e2a);
    f.paper(-w / 2 + 0.21, 1.6, 4.8, 1.2, 0.8, Math.PI / 2, 0, 0xcad2c4);
    f.anchor('postcard', w / 2 - 0.4, 1.3, 3.2);
    f.ceilingLight(0, 3.6, 'keeper-light');
  });

  // materials
  const mats: Record<string, THREE.Material> = {
    wood: stdMat(null, { rough: 0.55 }),
    woodPaint: stdMat(null, { rough: 0.5 }),
    fabric: stdMat(null, { rough: 0.95, wet: false }),
    ceramic: stdMat(null, { rough: 0.22, wet: false }),
    lino: stdMat(null, { rough: 0.35, wet: false }),
    rug: stdMat(null, { rough: 1, wet: false }),
    paper: stdMat(null, { rough: 0.9, wet: false }),
    plasterIn: stdMat(null, { rough: 0.9, wet: false }),
    glass: new THREE.MeshStandardMaterial({ color: 0xc8d4d4, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.35 }),
    lampShade: new THREE.MeshStandardMaterial({ roughness: 0.8, vertexColors: true, emissive: 0xffc890, emissiveIntensity: 0 }),
  };
  for (const key of b.batches.keys()) {
    const g = b.buildGeometry(key);
    if (!g) continue;
    const mat = mats[key] ?? SHARED_MATS[key] ?? mats.wood;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'interior-' + key;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(key === 'glass' ? LAYER.TRANSPARENT : LAYER.OPAQUE);
    group.add(mesh);
  }
  scene.add(group);
  return { group, anchors, dynamic };
}
