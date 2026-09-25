// Places props around the world: streets, harbour, roads, overlook, roadblock, bridge.
import * as THREE from 'three';
import { MeshBatcher } from './Batcher';
import {
  bakeCar,
  bakeBoat,
  bakeUtilityPole,
  bakeWire,
  bakeStreetlight,
  bakePicketFence,
  bakeGuardrail,
  bakePier,
  bakeHydrant,
  bakeMailbox,
  bakeBench,
  bakeBarrel,
  bakeCrabPot,
  bakeBuoy,
  CAR_COLORS,
  signTexture,
  makeSign,
  type CarModel,
} from './Props';
import type { CollisionWorld } from './Collision';
import type { LightManager } from './Lights';
import type { Terrain } from './Terrain';
import type { TexGen } from '../render/TexGen';
import { stdMat } from './Town';
import { MAIN_STREET, HARBOR_ROAD, HILL_STREET, BAY_STREET, COAST_ROAD, P } from './Layout';
import { sampleCatmull, RNG } from '../core/math';
import { LAYER } from '../render/Globals';
import type { TreeVariant } from './TreeGen';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export type DressingResult = {
  group: THREE.Group;
  roadblockCars: THREE.Vector3[];
  payphone: THREE.Vector3;
  truckSpot: { pos: THREE.Vector3; yaw: number };
  viewer: THREE.Vector3;
  streetlightOrigin: THREE.Vector3;
  pierEnd: THREE.Vector3;
  slipway: THREE.Vector3;
};

function pathPoints(pts: { x: number; y: number; z: number }[], step: number) {
  return sampleCatmull(pts, step).map((p) => V(p.x, p.y, p.z));
}

/** Point + direction at arc length s along a sampled path. */
function along(path: THREE.Vector3[], s: number) {
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const l = path[i].distanceTo(path[i - 1]);
    if (acc + l >= s) {
      const t = (s - acc) / l;
      const p = path[i - 1].clone().lerp(path[i], t);
      const d = path[i].clone().sub(path[i - 1]).setY(0).normalize();
      return { p, d };
    }
    acc += l;
  }
  const n = path.length;
  return { p: path[n - 1].clone(), d: path[n - 1].clone().sub(path[n - 2]).setY(0).normalize() };
}

function pathLength(path: THREE.Vector3[]) {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += path[i].distanceTo(path[i - 1]);
  return l;
}

export function dressWorld(
  scene: THREE.Scene,
  texgen: TexGen,
  collision: CollisionWorld,
  lights: LightManager,
  terrain: Terrain,
  fallenTree: TreeVariant,
  fallenMats: { bark: THREE.Material; foliage: THREE.Material | null },
): DressingResult {
  const b = new MeshBatcher();
  const rng = new RNG(4321);
  const H = (x: number, z: number) => terrain.heightAt(x, z);
  const group = new THREE.Group();
  group.name = 'dressing';

  // ---------------------------------------------------------------- streetlights
  const main = pathPoints(MAIN_STREET, 2);
  const mainLen = pathLength(main);
  const streetlightOrigin = V(56, 26, -38);
  let side = 1;
  for (let s = 12; s < mainLen - 4; s += 34) {
    const { p, d } = along(main, s);
    const n = V(-d.z, 0, d.x).multiplyScalar(side);
    const pos = p.clone().addScaledVector(n, 6.4);
    const y = H(pos.x, pos.z);
    const yaw = Math.atan2(n.x, n.z); // arm reaches back toward road
    const head = bakeStreetlight(b, pos.x, y, pos.z, yaw);
    lights.add({ id: `sl-main-${s}`, group: 'streetlights', pos: head, kind: 'sodium', power: 1.4, range: 26, glowSize: 0.5 });
    collision.circle(pos.x, pos.z, 0.2, y - 1, y + 10, 'pole');
    side = -side;
  }
  const harbor = pathPoints(HARBOR_ROAD, 2);
  for (let s = 20; s < pathLength(harbor); s += 42) {
    const { p, d } = along(harbor, s);
    const n = V(-d.z, 0, d.x);
    const pos = p.clone().addScaledVector(n, 5.5);
    const y = H(pos.x, pos.z);
    const head = bakeStreetlight(b, pos.x, y, pos.z, Math.atan2(n.x, n.z));
    lights.add({ id: `sl-harbor-${s}`, group: 'streetlights', pos: head, kind: 'sodium', power: 1.3, range: 26, glowSize: 0.5 });
    collision.circle(pos.x, pos.z, 0.2, y - 1, y + 10, 'pole');
  }
  for (const path of [HILL_STREET, BAY_STREET]) {
    const pp = pathPoints(path, 2);
    for (let s = 18; s < pathLength(pp); s += 40) {
      const { p, d } = along(pp, s);
      const n = V(-d.z, 0, d.x);
      const pos = p.clone().addScaledVector(n, -5);
      const y = H(pos.x, pos.z);
      const head = bakeStreetlight(b, pos.x, y, pos.z, Math.atan2(-n.x, -n.z), 7.5);
      lights.add({ id: `sl-${path === HILL_STREET ? 'hill' : 'bay'}-${s}`, group: 'streetlights', pos: head, kind: 'sodium', power: 1.1, range: 24, glowSize: 0.45 });
      collision.circle(pos.x, pos.z, 0.2, y - 1, y + 10, 'pole');
    }
  }

  // ---------------------------------------------------------------- power line along the coast road
  const coast = pathPoints(COAST_ROAD, 2);
  const coastLen = pathLength(coast);
  let prevPole: ReturnType<typeof bakeUtilityPole> | null = null;
  for (let s = 30; s < coastLen; s += 46) {
    const { p, d } = along(coast, s);
    const n = V(-d.z, 0, d.x);
    const pos = p.clone().addScaledVector(n, -7.5);
    // skip the bridge span
    if (Math.abs(pos.x - P.bridge.x) < 30 && Math.abs(pos.z - P.bridge.z) < 20) continue;
    const y = H(pos.x, pos.z);
    const yaw = Math.atan2(d.x, d.z) + Math.PI / 2;
    const pole = bakeUtilityPole(b, pos.x, y, pos.z, yaw, 10.5, rng.range(-0.25, 0.25));
    collision.circle(pos.x, pos.z, 0.22, y - 1, y + 11, 'pole');
    if (prevPole) for (let k = 0; k < 4; k++) bakeWire(b, prevPole.arms[k], pole.arms[k], k === 3 ? 1.1 : 0.7);
    prevPole = pole;
  }

  // ---------------------------------------------------------------- parked cars
  const models: CarModel[] = ['sedan', 'wagon', 'pickup', 'sedan', 'van', 'sedan'];
  const carAt = (x: number, z: number, yaw: number, model: CarModel, color: number, opts: { doorOpen?: boolean; dirt?: number } = {}) => {
    const y = H(x, z) + (terrain.surfaceAt(x, z).road > 0.5 ? 0.3 : 0);
    const f = bakeCar(b, model, x, y, z, yaw, color, opts);
    collision.box(x, z, f.length, f.width, yaw + Math.PI / 2, y - 1, y + 1.5, false, 'car');
    return V(x, y, z);
  };
  // Main Street curbside
  for (const [s, sd] of [
    [40, 1],
    [70, -1],
    [96, 1],
    [128, -1],
    [150, 1],
    [175, -1],
    [196, 1],
  ] as [number, number][]) {
    const { p, d } = along(main, s);
    const n = V(-d.z, 0, d.x).multiplyScalar(sd);
    const pos = p.clone().addScaledVector(n, 3.2);
    carAt(pos.x, pos.z, Math.atan2(d.x, d.z) - Math.PI / 2 + (sd > 0 ? 0 : Math.PI), rng.pick(models), rng.pick(CAR_COLORS), { dirt: rng.range(0.05, 0.3) });
  }
  // diner lot, houses
  carAt(70, 42, 0.2, 'pickup', 0x6b7a3a);
  carAt(72, 50, 0.05, 'sedan', 0x7fa3bf);
  carAt(-44, 58, 1.4, 'wagon', 0xc9a24a, { doorOpen: true });
  carAt(-70, 64, 1.7, 'sedan', 0x5e1f24);
  carAt(80, 36, -1.6, 'van', 0xe8dcc0);

  // ---------------------------------------------------------------- gas station
  const fuel = V(EASTFUEL.x, H(EASTFUEL.x, EASTFUEL.z), EASTFUEL.z);
  {
    const cx = fuel.x - 9,
      cz = fuel.z;
    const y = H(cx, cz);
    b.color.setRGB(0.85, 0.84, 0.8);
    for (const [dx, dz] of [
      [-3.5, -4],
      [3.5, -4],
      [-3.5, 4],
      [3.5, 4],
    ])
      b.box('metal', cx + dx, y + 2.2, cz + dz, 0.25, 4.4, 0.25);
    b.color.setRGB(0.78, 0.2, 0.15);
    b.box('metal', cx, y + 4.6, cz, 9, 0.5, 10.5);
    b.color.setRGB(0.9, 0.9, 0.88);
    b.box('metal', cx, y + 4.3, cz, 8.6, 0.12, 10.1);
    lights.add({ id: 'fuel-canopy', group: 'fuel', pos: V(cx, y + 4.1, cz), kind: 'fluorescent', power: 0.9, range: 18, glowSize: 0.9 });
    for (const dz of [-2, 2]) {
      b.color.setRGB(0.8, 0.78, 0.72);
      b.box('concrete', cx, y + 0.1, cz + dz, 1.2, 0.2, 2.6);
      b.color.setRGB(0.72, 0.18, 0.14);
      b.box('metal', cx, y + 0.95, cz + dz, 0.55, 1.5, 0.8);
      b.color.setRGB(0.9, 0.9, 0.86);
      b.box('metal', cx, y + 1.35, cz + dz - 0.41, 0.4, 0.4, 0.02);
      collision.box(cx, cz + dz, 1.2, 2.6, 0, y - 1, y + 1.8, false, 'pump');
    }
    carAt(cx + 2.8, cz - 2.2, Math.PI / 2 + 0.1, 'sedan', 0xa0522d, { doorOpen: true });
    for (const c of [V(cx - 3.5, 0, cz - 4), V(cx + 3.5, 0, cz - 4), V(cx - 3.5, 0, cz + 4), V(cx + 3.5, 0, cz + 4)]) collision.circle(c.x, c.z, 0.2, y - 1, y + 5);
  }
  // payphone booth beside the station office
  const payphone = V(fuel.x + 1, H(fuel.x + 1, fuel.z - 6.5), fuel.z - 6.5);
  {
    const p = payphone;
    b.color.setRGB(0.55, 0.57, 0.6);
    b.box('metal', p.x, p.y + 1.05, p.z, 0.08, 2.1, 0.08);
    b.box('metal', p.x, p.y + 1.35, p.z - 0.08, 0.45, 0.7, 0.25);
    b.color.setRGB(0.12, 0.2, 0.45);
    b.box('metal', p.x, p.y + 1.85, p.z - 0.08, 0.5, 0.18, 0.3);
    collision.box(p.x, p.z, 0.5, 0.4, 0, p.y - 1, p.y + 2.2, false, 'payphone');
  }

  // ---------------------------------------------------------------- harbour: piers, boats, gear
  const groundAt = (x: number, z: number) => H(x, z);
  bakePier(b, V(8, 0, 197), V(8, 0, 302), 3.4, 3.35, groundAt, [0.72, 0.76]);
  bakePier(b, V(74, 0, 199), V(74, 0, 252), 2.6, 3.35, groundAt);
  bakePier(b, V(74, 0, 252), V(96, 0, 256), 2.6, 3.35, groundAt);
  // pier collision (walkable deck), with the broken gap left open
  const pierBox = (a: THREE.Vector3, c: THREE.Vector3, w: number, y: number) => {
    const mid = a.clone().add(c).multiplyScalar(0.5);
    const len = a.distanceTo(c);
    const yaw = Math.atan2(c.x - a.x, c.z - a.z);
    collision.box(mid.x, mid.z, w, len, yaw, y - 6, y, true, 'wood');
  };
  pierBox(V(8, 0, 197), V(8, 0, 272.5), 3.4, 3.4);
  pierBox(V(8, 0, 277), V(8, 0, 302), 3.4, 3.4);
  pierBox(V(74, 0, 199), V(74, 0, 252), 2.6, 3.4);
  pierBox(V(74, 0, 252), V(96, 0, 256), 2.6, 3.4);
  const pierEnd = V(8, 3.4, 300);
  lights.add({ id: 'pier-lamp', group: 'harbor', pos: V(9.6, 7.2, 300), kind: 'incandescent', power: 0.35, range: 16, glowSize: 0.3 });
  b.color.setRGB(0.32, 0.28, 0.24);
  b.cylinder('pole', V(9.6, 3.35, 300), V(9.6, 7.4, 300), 0.08, 0.07, 6);

  // boats on the mud
  const boats: [number, number, number, number, number, number, number][] = [
    [-22, 238, 0.4, 0.38, 0.03, 0xe8e4da, 0x9aa7a4],
    [26, 252, -0.9, -0.42, -0.04, 0x2f5a4a, 0xe6e2d8],
    [-6, 285, 1.9, 0.33, 0.06, 0x8b2e25, 0xd8d0c0],
    [52, 232, 2.6, -0.3, 0.02, 0x3a5a7a, 0xe0dcd0],
    [-128, 248, 0.9, 0.46, -0.05, 0xcdc6b2, 0x6d7d6a],
    [104, 270, -1.4, 0.4, 0.05, 0x7a2f23, 0xd8d4ca],
  ];
  for (const [x, z, yaw, roll, pitch, hull, cab] of boats) {
    const y = H(x, z) - 0.25;
    bakeBoat(b, x, y, z, yaw, roll, pitch, hull, cab, rng.range(9.5, 12.5));
    collision.box(x, z, 3.4, 11, yaw, y - 1, y + 3.5, false, 'boat');
  }
  // gear on the waterfront
  for (let i = 0; i < 14; i++) {
    const x = 18 + (i % 4) * 1.0,
      z = 191 + Math.floor(i / 4) * 1.0;
    bakeCrabPot(b, x, H(x, z) + Math.floor(i / 8) * 0.4, z, rng.range(-0.1, 0.1));
  }
  for (let i = 0; i < 10; i++) {
    const x = 60 + rng.range(-3, 3),
      z = 192 + rng.range(-1.5, 1.5);
    bakeBuoy(b, x, H(x, z), z, rng.pick([0xd8452f, 0xe6d23a, 0xe6e2d8, 0x3d6ea3]));
  }
  for (let i = 0; i < 5; i++) {
    const x = -40 + i * 1.3,
      z = 190 + (i % 2) * 0.8;
    bakeBarrel(b, x, H(x, z), z, rng.pick([0x2d4a6a, 0x7a2a1e, 0x4a5a3a]), i === 4);
  }
  // slipway where the footprints begin
  const slipway = V(-18, 0, 226);
  {
    const y0 = H(-18, 214);
    b.color.setRGB(0.6, 0.58, 0.54);
    const len = 22;
    b.pushTRS(-18, y0 - 1.0, 214 + len / 2, 0);
    const m = new THREE.Matrix4().makeRotationX(0.1);
    b.push(m);
    b.box('concrete', 0, 0, 0, 5, 0.4, len, 0.5);
    b.pop();
    b.pop();
  }

  // ---------------------------------------------------------------- street furniture
  for (const s of [30, 80, 140]) {
    const { p, d } = along(main, s);
    const n = V(-d.z, 0, d.x);
    const pos = p.clone().addScaledVector(n, -5.4);
    bakeHydrant(b, pos.x, H(pos.x, pos.z), pos.z);
  }
  bakeBench(b, 30, H(30, 186), 186, Math.PI);
  bakeBench(b, -8, H(-8, 186), 186, Math.PI);
  for (const [x, z, yaw] of [
    [-36, 64, 0],
    [-12, 66, 0],
    [-62, 71, 0.3],
    [-20, 67, 3.14],
    [70, 29, 3.14],
  ] as [number, number, number][])
    bakeMailbox(b, x, H(x, z), z, yaw, rng.chance(0.3));
  // picket fences for a few houses
  const fence = (pts: [number, number][], gap?: number) => bakePicketFence(b, pts.map(([x, z]) => V(x, H(x, z), z)), 0xe8e4da, gap);
  fence([[-42, 62], [-30, 62.5]], 0);
  fence([[-17, 62], [-6, 62.5]]);
  fence([[-68, 66], [-56, 67]], 0);

  // ---------------------------------------------------------------- overlook
  const truckSpot = { pos: V(-181.5, 0, -426.5), yaw: -2.2 };
  truckSpot.pos.y = H(truckSpot.pos.x, truckSpot.pos.z);
  const viewer = V(-172.5, 0, -419.5);
  viewer.y = H(viewer.x, viewer.z);
  {
    // guardrail along the lay-by edge
    const rail: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const x = -193 + t * 26,
        z = -418 + t * 10 - Math.sin(t * Math.PI) * 3;
      rail.push(V(x, H(x, z), z));
    }
    bakeGuardrail(b, rail);
    for (let i = 0; i < rail.length - 1; i++) {
      const a = rail[i],
        c = rail[i + 1];
      const mid = a.clone().add(c).multiplyScalar(0.5);
      collision.box(mid.x, mid.z, a.distanceTo(c), 0.3, Math.atan2(c.z - a.z, c.x - a.x) * -1, mid.y - 1, mid.y + 0.9, false, 'rail');
    }
    // tower viewer (coin binoculars)
    b.color.setRGB(0.2, 0.34, 0.3);
    b.cylinder('metal', V(viewer.x, viewer.y, viewer.z), V(viewer.x, viewer.y + 1.1, viewer.z), 0.08, 0.06, 8);
    b.pushTRS(viewer.x, viewer.y + 1.3, viewer.z, 0.3);
    b.box('metal', 0, 0, 0, 0.5, 0.32, 0.4);
    b.color.setRGB(0.1, 0.1, 0.1);
    b.box('metal', -0.1, 0.02, 0.23, 0.12, 0.12, 0.1);
    b.box('metal', 0.1, 0.02, 0.23, 0.12, 0.12, 0.1);
    b.pop();
    collision.circle(viewer.x, viewer.z, 0.3, viewer.y - 1, viewer.y + 1.6, 'viewer');
    // scenic sign
    const sign = makeSign(signTexture(['BLACKWATER BAY', 'SCENIC VIEWPOINT', 'ELEV. 330 FT'], { bg: '#5b3b24', fg: '#e9dcc0', border: '#e9dcc0', font: "'Cormorant Garamond', Georgia, serif" }), 2.2, 1.1, 1.0, true);
    const sp = V(-190, 0, -425);
    sign.position.set(sp.x, H(sp.x, sp.z), sp.z);
    sign.rotation.y = 0.9;
    group.add(sign);
  }

  // ---------------------------------------------------------------- guardrails on the coast road curves
  {
    const segs: [number, number][] = [
      [120, 260],
      [330, 520],
      [640, 760],
    ];
    for (const [s0, s1] of segs) {
      const pts: THREE.Vector3[] = [];
      for (let s = s0; s <= s1; s += 4) {
        const { p, d } = along(coast, s);
        const n = V(-d.z, 0, d.x);
        const q = p.clone().addScaledVector(n, 4.3);
        if (Math.abs(q.x - P.bridge.x) < 28 && Math.abs(q.z - P.bridge.z) < 16) continue;
        pts.push(V(q.x, H(q.x, q.z) + 0.1, q.z));
      }
      if (pts.length > 1) bakeGuardrail(b, pts);
    }
  }

  // ---------------------------------------------------------------- the bridge over the gorge
  {
    const a = V(-72, 88.8, -372),
      c = V(-6, 84.6, -366);
    const dir = c.clone().sub(a);
    const len = dir.length();
    const mid = a.clone().add(c).multiplyScalar(0.5);
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = Math.asin((c.y - a.y) / len);
    const m = new THREE.Matrix4().compose(mid, new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, 0, 'YXZ')), V(1, 1, 1));
    b.push(m);
    b.color.setRGB(0.62, 0.61, 0.58);
    b.box('concrete', 0, -0.55, 0, 9.2, 0.9, len, 0.5);
    for (const sx of [-4.4, 4.4]) {
      b.box('concrete', sx, 0.35, 0, 0.3, 0.9, len, 0.5);
      b.color.setRGB(0.55, 0.57, 0.55);
      b.box('metal', sx, 1.05, 0, 0.12, 0.1, len);
      b.color.setRGB(0.62, 0.61, 0.58);
    }
    b.pop();
    for (const t of [0.33, 0.66]) {
      const p = a.clone().lerp(c, t);
      const g = H(p.x, p.z);
      b.color.setRGB(0.58, 0.57, 0.54);
      b.box('concrete', p.x, (g + p.y - 1.0) / 2, p.z, 2.2, p.y - 1.0 - g, 5.5, 0.5);
    }
    collision.box(mid.x, mid.z, 9.2, len, yaw, mid.y - 3, mid.y, true, 'concrete');
    for (const sx of [-4.4, 4.4]) {
      const off = V(Math.cos(yaw) * sx, 0, -Math.sin(yaw) * sx);
      collision.box(mid.x + off.x, mid.z + off.z, 0.3, len, yaw, mid.y - 1, mid.y + 1.2, false, 'rail');
    }
  }

  // ---------------------------------------------------------------- roadblock: evacuation stalled at a fallen spruce
  const roadblockCars: THREE.Vector3[] = [];
  {
    const { p: tp, d: td } = alongPath(coast, P.roadblock.x, P.roadblock.z);
    // fallen tree across the road (reuse a real fir, lying down)
    const tree = new THREE.Group();
    tree.add(new THREE.Mesh(fallenTree.bark, fallenMats.bark));
    if (fallenTree.foliage && fallenMats.foliage) tree.add(new THREE.Mesh(fallenTree.foliage, fallenMats.foliage));
    const ty = H(tp.x, tp.z);
    const a = Math.atan2(td.x, td.z) + 0.25; // trunk direction T = (cos a, 0, -sin a), across the road
    const T = V(Math.cos(a), 0, -Math.sin(a));
    const baseOff = 11;
    tree.position.set(tp.x - T.x * baseOff, ty + 0.45, tp.z - T.z * baseOff);
    tree.rotation.set(0, a, 0);
    tree.rotateZ(-Math.PI / 2 + 0.03);
    tree.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    group.add(tree);
    const Ht = fallenTree.height;
    const cmid = tree.position.clone().addScaledVector(T, Ht / 2);
    collision.box(cmid.x, cmid.z, Ht, 1.7, a, ty - 2, ty + 1.9, false, 'tree');
    // root plate torn out of the bank
    b.color.setRGB(0.3, 0.24, 0.18);
    b.pushTRS(tree.position.x - T.x * 0.3, ty + 0.9, tree.position.z - T.z * 0.3, a);
    b.box('concrete', 0, 0, 0, 0.6, 2.6, 3.0, 0.5);
    b.pop();
    // cars queued uphill (facing north, away from town), doors open
    const colors = [0x6b7a3a, 0xe8dcc0, 0x7fa3bf, 0x5e1f24, 0x8c8f88, 0xc9a24a];
    const mdl: CarModel[] = ['pickup', 'sedan', 'wagon', 'sedan', 'van', 'sedan'];
    for (let i = 0; i < 6; i++) {
      const lane = i % 2 === 0 ? -1.8 : 1.9;
      const { p, d } = alongPath(coast, P.roadblock.x, P.roadblock.z, 8 + i * 6.5);
      const n = V(-d.z, 0, d.x);
      const pos = p.clone().addScaledVector(n, lane + rng.range(-0.4, 0.4));
      const yaw = Math.atan2(-d.x, -d.z) - Math.PI / 2 + rng.range(-0.12, 0.12);
      roadblockCars.push(carAt(pos.x, pos.z, yaw, mdl[i], colors[i], { doorOpen: i !== 2, dirt: 0.2 }));
    }
  }

  // ---------------------------------------------------------------- road signs
  const addSign = (lines: string[], x: number, z: number, yaw: number, w = 0.75, h = 0.9, style: 'white' | 'green' | 'yellow' | 'brown' = 'white') => {
    const st = {
      white: { bg: '#e9e7e0', fg: '#1b1b1b', border: '#1b1b1b' },
      green: { bg: '#1f5a3a', fg: '#eef0e8', border: '#eef0e8' },
      yellow: { bg: '#d8b43a', fg: '#1b1b1b', border: '#1b1b1b' },
      brown: { bg: '#5b3b24', fg: '#e9dcc0', border: '#e9dcc0' },
    }[style];
    const s = makeSign(signTexture(lines, { ...st, w: 256, h: Math.round((256 * h) / w) }), w, h, 1.6);
    s.position.set(x, H(x, z), z);
    s.rotation.y = yaw;
    group.add(s);
    collision.circle(x, z, 0.1, H(x, z) - 1, H(x, z) + 2.5);
  };
  addSign(['SPEED', 'LIMIT', '25'], 64, -60, 0.5 + Math.PI);
  addSign(['BLACKWATER', 'POP. 412'], 104, -118, Math.PI * 0.8, 1.6, 0.8, 'green');
  addSign(['LIGHTHOUSE RD', 'NO THRU TRAFFIC'], -214, -474, 2.4, 1.6, 0.7, 'brown');
  addSign(['HARBOR', '→'], 36, 180, Math.PI * 0.5, 0.9, 0.5, 'green');
  addSign(['⚠ TSUNAMI', 'HAZARD ZONE', 'IN CASE OF EARTHQUAKE', 'GO TO HIGH GROUND', 'OR INLAND'], 20, 176, Math.PI * 0.95, 1.0, 1.25, 'yellow');
  addSign(['EVACUATION', 'ROUTE', '↑'], 58, -30, Math.PI + 0.3, 0.8, 0.9, 'white');

  // ---------------------------------------------------------------- materials
  const carPaint = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.35 });
  const mats: Record<string, THREE.Material> = {
    carPaint,
    carGlass: new THREE.MeshStandardMaterial({ color: 0x1a1e22, roughness: 0.05, metalness: 0.2, vertexColors: true }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.2, metalness: 1.0 }),
    rubber: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true }),
    carLight: new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0.1, vertexColors: true }),
    hull: stdMat(null, { rough: 0.6 }),
    boatCabin: stdMat(null, { rough: 0.6 }),
    pole: stdMat(texgen.bake('planks', 256, 4), { rough: 1, color: 0x8a7a6a }),
    insulator: new THREE.MeshStandardMaterial({ color: 0x7a918c, roughness: 0.2, metalness: 0.1, vertexColors: true }),
    wire: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.5, metalness: 0.5 }),
    lampLens: new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.2, emissive: 0x000000, vertexColors: true }),
    crabPot: stdMat(null, { rough: 0.8 }),
  };
  for (const key of b.batches.keys()) {
    const g = b.buildGeometry(key);
    if (!g) continue;
    const mat = mats[key] ?? SHARED_MATS[key] ?? mats.hull;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'dress-' + key;
    mesh.castShadow = key !== 'wire';
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.OPAQUE);
    group.add(mesh);
  }
  scene.add(group);
  return { group, roadblockCars, payphone, truckSpot, viewer, streetlightOrigin, pierEnd, slipway };
}

/** Materials shared with the town batcher (planks, concrete, metal, trim...). */
export const SHARED_MATS: Record<string, THREE.Material> = {};

const EASTFUEL = { x: 70.5, z: -24 };

function alongPath(path: THREE.Vector3[], x: number, z: number, offset = 0) {
  let best = 0,
    bd = Infinity,
    acc = 0,
    bestS = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) acc += path[i].distanceTo(path[i - 1]);
    const d = (path[i].x - x) ** 2 + (path[i].z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
      bestS = acc;
    }
  }
  void best;
  return along(path, Math.max(0, bestS - offset));
}
