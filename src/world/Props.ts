// Prop generators: vehicles, boats, poles & wires, streetlights, fences, piers, street furniture.
// Static props are baked into a MeshBatcher (per-material batches, vertex-coloured).
import * as THREE from 'three';
import type { MeshBatcher } from './Batcher';
import { RNG } from '../core/math';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ vehicles
export type CarModel = 'sedan' | 'wagon' | 'pickup' | 'van';
type CarParts = { paint: THREE.BufferGeometry; glass: THREE.BufferGeometry; chrome: THREE.BufferGeometry; rubber: THREE.BufferGeometry; lights: THREE.BufferGeometry; tail: THREE.BufferGeometry; interior: THREE.BufferGeometry; length: number; width: number };

function extrudeProfile(pts: [number, number][], width: number, bevel = 0.05, arches?: { x: number; r: number }[]) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  if (arches) {
    // wheel arch cut-outs as holes (half-discs just touching the bottom edge are simpler as separate trims)
    void arches;
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 6 });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.computeVertexNormals();
  return g;
}

function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // minimal merge (position/normal/uv, indexed or not)
  let count = 0;
  const idx: number[] = [];
  const pos: number[] = [],
    nrm: number[] = [],
    uv: number[] = [];
  for (const g0 of geos) {
    const g = g0.index ? g0 : g0;
    const p = g.getAttribute('position'),
      n = g.getAttribute('normal'),
      u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
      uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(count + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(count + i);
    count += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

const carCache = new Map<CarModel, CarParts>();

export function carParts(model: CarModel): CarParts {
  const cached = carCache.get(model);
  if (cached) return cached;
  const W = model === 'van' ? 2.0 : 1.9;
  let lower: [number, number][];
  let upper: [number, number][];
  let L = 5.2;
  if (model === 'sedan') {
    lower = [
      [-2.6, 0.34], [-2.62, 0.62], [-2.5, 0.92], [-1.35, 0.97], [1.25, 0.97], [2.5, 0.9], [2.62, 0.72], [2.6, 0.34],
    ];
    upper = [[-1.4, 0.96], [-0.95, 1.4], [0.5, 1.41], [1.22, 0.97]];
  } else if (model === 'wagon') {
    lower = [[-2.62, 0.34], [-2.64, 0.95], [-2.5, 0.98], [1.25, 0.98], [2.5, 0.91], [2.62, 0.72], [2.6, 0.34]];
    upper = [[-2.5, 0.97], [-2.42, 1.42], [0.5, 1.43], [1.22, 0.98]];
  } else if (model === 'pickup') {
    L = 5.3;
    lower = [[-2.65, 0.4], [-2.65, 1.02], [-0.55, 1.02], [-0.55, 1.05], [1.05, 1.05], [2.45, 1.0], [2.62, 0.8], [2.6, 0.4]];
    upper = [[-0.5, 1.04], [-0.42, 1.62], [0.45, 1.63], [1.02, 1.05]];
  } else {
    L = 4.8;
    lower = [[-2.4, 0.36], [-2.42, 1.05], [1.3, 1.05], [2.3, 0.95], [2.42, 0.7], [2.4, 0.36]];
    upper = [[-2.4, 1.04], [-2.36, 1.9], [1.0, 1.9], [1.45, 1.06]];
  }
  const body = extrudeProfile(lower, W, 0.07);
  const green = extrudeProfile(upper, W - 0.22, 0.05);
  // roof & pillars in paint: a thin cap over the greenhouse
  const roofPts = upper.slice(1, 3);
  const roof = new THREE.BoxGeometry(roofPts[1][0] - roofPts[0][0] + 0.1, 0.05, W - 0.16);
  roof.translate((roofPts[0][0] + roofPts[1][0]) / 2, roofPts[0][1] + 0.02, 0);
  const pillars: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const z = side * (W / 2 - 0.13);
    // A pillar along the windshield edge, C pillar at the rear
    const a0 = upper[upper.length - 1],
      a1 = upper[2];
    const pa = new THREE.BoxGeometry(0.08, 0.08, 0.06);
    const len = Math.hypot(a0[0] - a1[0], a0[1] - a1[1]);
    const ap = new THREE.BoxGeometry(len, 0.07, 0.07);
    ap.rotateZ(Math.atan2(a1[1] - a0[1], a1[0] - a0[0]));
    ap.translate((a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2, z);
    pillars.push(ap);
    const c0 = upper[0],
      c1 = upper[1];
    const len2 = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
    const cp = new THREE.BoxGeometry(len2, 0.1, 0.07);
    cp.rotateZ(Math.atan2(c1[1] - c0[1], c1[0] - c0[0]));
    cp.translate((c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, z);
    pillars.push(cp);
    const bp = new THREE.BoxGeometry(0.1, (upper[1][1] - upper[0][1]) * 0.95, 0.07);
    bp.translate((upper[1][0] + upper[2][0]) * 0.5 - 0.1, (upper[0][1] + upper[1][1]) / 2, z);
    pillars.push(bp);
    void pa;
  }
  const paint = merge([body, roof, ...pillars]);
  // bumpers, trim
  const chromeParts: THREE.BufferGeometry[] = [];
  const bf = new THREE.BoxGeometry(0.14, 0.16, W + 0.04);
  bf.translate(lower[lower.length - 1][0] + 0.04, 0.46, 0);
  const br = new THREE.BoxGeometry(0.14, 0.16, W + 0.04);
  br.translate(lower[0][0] - 0.03, 0.46, 0);
  chromeParts.push(bf, br);
  const grille = new THREE.BoxGeometry(0.04, 0.22, W * 0.62);
  grille.translate(lower[lower.length - 1][0] + 0.02, 0.68, 0);
  chromeParts.push(grille);
  for (const side of [-1, 1]) {
    const trim = new THREE.BoxGeometry(L * 0.8, 0.03, 0.02);
    trim.translate(0.1, 0.62, side * (W / 2 + 0.005));
    chromeParts.push(trim);
    const mirror = new THREE.BoxGeometry(0.06, 0.1, 0.14);
    mirror.translate(upper[upper.length - 1][0] - 0.1, upper[upper.length - 1][1] + 0.05, side * (W / 2 + 0.07));
    chromeParts.push(mirror);
  }
  const chrome = merge(chromeParts);
  // wheels (tyres) + hubcaps
  const rubberParts: THREE.BufferGeometry[] = [];
  const hubs: THREE.BufferGeometry[] = [];
  const wx = model === 'van' ? 1.55 : 1.6;
  for (const x of [-wx, wx])
    for (const side of [-1, 1]) {
      const t = new THREE.CylinderGeometry(0.36, 0.36, 0.22, 16);
      t.rotateX(Math.PI / 2);
      t.translate(x, 0.36, side * (W / 2 - 0.1));
      rubberParts.push(t);
      const h = new THREE.CylinderGeometry(0.2, 0.22, 0.03, 14);
      h.rotateX(Math.PI / 2);
      h.translate(x, 0.36, side * (W / 2 + 0.02));
      hubs.push(h);
      // dark wheel-well
      const well = new THREE.CylinderGeometry(0.44, 0.44, 0.02, 14, 1, false, 0, Math.PI);
      well.rotateX(Math.PI / 2);
      well.rotateZ(Math.PI / 2);
      well.translate(x, 0.36, side * (W / 2 - 0.02));
      rubberParts.push(well);
    }
  chromeParts.push(...hubs);
  const rubber = merge(rubberParts);
  // lights
  const hl: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const h = new THREE.CylinderGeometry(0.1, 0.1, 0.04, 12);
    h.rotateZ(Math.PI / 2);
    h.translate(lower[lower.length - 1][0] + 0.02, 0.72, side * (W / 2 - 0.26));
    hl.push(h);
  }
  const tl: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const t = new THREE.BoxGeometry(0.04, 0.14, 0.3);
    t.translate(lower[0][0] - 0.02, 0.72, side * (W / 2 - 0.2));
    tl.push(t);
  }
  // interior: dashboard, seats
  const inter: THREE.BufferGeometry[] = [];
  const dash = new THREE.BoxGeometry(0.4, 0.2, W - 0.3);
  dash.translate(upper[upper.length - 1][0] - 0.25, upper[0][1] + 0.05, 0);
  inter.push(dash);
  const seat = new THREE.BoxGeometry(0.55, 0.5, W - 0.4);
  seat.translate((upper[1][0] + upper[2][0]) * 0.5 - 0.1, upper[0][1] - 0.1, 0);
  inter.push(seat);
  const parts: CarParts = {
    paint,
    glass: green,
    chrome: merge(chromeParts),
    rubber,
    lights: merge(hl),
    tail: merge(tl),
    interior: merge(inter),
    length: L,
    width: W,
  };
  carCache.set(model, parts);
  return parts;
}

export const CAR_COLORS = [0xc9a24a, 0x6b7a3a, 0xa0522d, 0xe8dcc0, 0x5e1f24, 0x7fa3bf, 0x5a4636, 0xe6e4dc, 0x9a3a2e, 0x2f4a3a, 0x8c8f88];

/** Bake a static car into the batcher. Returns its footprint for collision. */
export function bakeCar(b: MeshBatcher, model: CarModel, x: number, y: number, z: number, yaw: number, color: number, opts: { dirt?: number; doorOpen?: boolean } = {}) {
  const p = carParts(model);
  b.pushTRS(x, y, z, yaw);
  const c = new THREE.Color(color);
  b.color.copy(c).multiplyScalar(1 - (opts.dirt ?? 0.15));
  b.geometry('carPaint', p.paint);
  b.color.setRGB(1, 1, 1);
  b.geometry('carGlass', p.glass);
  b.geometry('chrome', p.chrome);
  b.color.setRGB(0.12, 0.12, 0.12);
  b.geometry('rubber', p.rubber);
  b.color.setRGB(0.9, 0.9, 0.85);
  b.geometry('carLight', p.lights);
  b.color.setRGB(0.6, 0.05, 0.03);
  b.geometry('carLight', p.tail);
  b.color.setRGB(0.25, 0.2, 0.17);
  b.geometry('rubber', p.interior);
  if (opts.doorOpen) {
    // driver's door swung open (left side, local +z is left? use -z side)
    const door = new THREE.BoxGeometry(1.05, 0.62, 0.07);
    const m = new THREE.Matrix4().compose(V(0.35, 0.66, p.width / 2 + 0.45), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), -1.0), V(1, 1, 1));
    b.color.copy(c).multiplyScalar(0.85);
    b.geometry('carPaint', door, m);
    const win = new THREE.BoxGeometry(0.9, 0.36, 0.02);
    const m2 = new THREE.Matrix4().compose(V(0.35, 1.15, p.width / 2 + 0.45), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), -1.0), V(1, 1, 1));
    b.color.setRGB(1, 1, 1);
    b.geometry('carGlass', win, m2);
  }
  b.pop();
  return { length: p.length, width: p.width };
}

// ------------------------------------------------------------------ boats
/** A west-coast troller/gillnetter lofted hull with cabin, mast and outriggers. */
export function bakeBoat(b: MeshBatcher, x: number, y: number, z: number, yaw: number, roll: number, pitch: number, hullColor: number, cabinColor: number, L = 11, name?: string) {
  const m = new THREE.Matrix4().compose(
    V(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')),
    V(1, 1, 1),
  );
  b.push(m);
  const B = L * 0.3; // beam
  const D = L * 0.16; // depth to sheer
  const stations = 16;
  const ring = 12;
  const pts: THREE.Vector3[][] = [];
  for (let i = 0; i <= stations; i++) {
    const t = i / stations; // 0 stern .. 1 bow
    const xs = (t - 0.5) * L;
    const half = (B / 2) * Math.pow(Math.sin(Math.min(1, t * 0.9 + 0.12) * Math.PI), 0.6) * (t > 0.85 ? 1 - (t - 0.85) * 3.5 : 1);
    const sheer = D * (1 + 0.25 * Math.pow(t, 2.5) + 0.08 * (1 - t));
    const keel = -0.05 * (1 - t);
    const row: THREE.Vector3[] = [];
    for (let k = 0; k <= ring; k++) {
      const a = (k / ring) * Math.PI; // 0 port sheer -> pi starboard sheer
      const s = Math.cos(a);
      const dep = Math.sin(a);
      const hw = Math.max(0.02, half) * s;
      const yy = sheer - (sheer - keel) * Math.pow(dep, 0.7);
      row.push(V(xs, yy, hw * (0.6 + 0.4 * Math.pow(1 - dep, 0.3))));
    }
    pts.push(row);
  }
  const bt = b.batch('hull');
  const hc = new THREE.Color(hullColor),
    bottom = new THREE.Color(0x5a1c14);
  const base = bt.pos.length / 3;
  const mm = b.m;
  const nm = new THREE.Matrix3().getNormalMatrix(mm);
  for (let i = 0; i <= stations; i++)
    for (let k = 0; k <= ring; k++) {
      const p = pts[i][k].clone();
      const pn = pts[Math.min(stations, i + 1)][k].clone().sub(pts[Math.max(0, i - 1)][k]);
      const pk = pts[i][Math.min(ring, k + 1)].clone().sub(pts[i][Math.max(0, k - 1)]);
      const n = new THREE.Vector3().crossVectors(pn, pk).normalize();
      const wl = p.y < D * 0.35;
      const c = wl ? bottom : hc;
      const streak = Math.random() < 0.3 ? 0.85 : 1;
      p.applyMatrix4(mm);
      n.applyMatrix3(nm).normalize();
      bt.pos.push(p.x, p.y, p.z);
      bt.nrm.push(n.x, n.y, n.z);
      bt.uv.push(i / stations, k / ring);
      bt.col.push(c.r * streak, c.g * streak, c.b * streak);
    }
  for (let i = 0; i < stations; i++)
    for (let k = 0; k < ring; k++) {
      const a = base + i * (ring + 1) + k;
      const c = a + ring + 1;
      bt.idx.push(a, c, a + 1, a + 1, c, c + 1);
      bt.idx.push(a, a + 1, c, a + 1, c + 1, c); // double-sided
    }
  // deck
  b.color.setRGB(0.55, 0.5, 0.42);
  const deckY = D * 0.97;
  b.box('planks', 0, deckY, 0, L * 0.9, 0.06, B * 0.86, 0.5);
  // bulwark cap
  b.color.copy(hc).multiplyScalar(0.9);
  // cabin
  b.color.set(cabinColor);
  const cabL = L * 0.26,
    cabX = L * 0.12;
  b.box('boatCabin', cabX, deckY + 1.0, 0, cabL, 2.0, B * 0.62, 0.5);
  b.color.setRGB(0.2, 0.22, 0.24);
  b.box('carGlass', cabX + cabL / 2 + 0.01, deckY + 1.45, 0, 0.02, 0.5, B * 0.5);
  b.color.setRGB(0.85, 0.84, 0.8);
  b.box('boatCabin', cabX, deckY + 2.05, 0, cabL + 0.2, 0.12, B * 0.68, 0.5);
  // mast & outrigger poles
  b.color.setRGB(0.6, 0.58, 0.54);
  b.cylinder('metal', V(cabX - cabL * 0.3, deckY + 2.1, 0), V(cabX - cabL * 0.3, deckY + 7.5, 0), 0.07, 0.05, 6);
  b.cylinder('metal', V(cabX - cabL * 0.3, deckY + 4.5, 0), V(cabX - cabL * 0.3 - 1.0, deckY + 9.5, B * 1.4), 0.04, 0.03, 5);
  b.cylinder('metal', V(cabX - cabL * 0.3, deckY + 4.5, 0), V(cabX - cabL * 0.3 - 1.0, deckY + 9.5, -B * 1.4), 0.04, 0.03, 5);
  // stern gear: net drum
  b.color.setRGB(0.3, 0.32, 0.3);
  b.cylinder('metal', V(-L * 0.38, deckY + 0.7, -B * 0.3), V(-L * 0.38, deckY + 0.7, B * 0.3), 0.55, 0.55, 12);
  b.pop();
  void name;
}

// ------------------------------------------------------------------ poles, wires, lights
export type PoleInfo = { base: THREE.Vector3; top: THREE.Vector3; arms: THREE.Vector3[] };

export function bakeUtilityPole(b: MeshBatcher, x: number, y: number, z: number, yaw: number, h = 10, lean = 0): PoleInfo {
  const rng = new RNG(Math.floor(x * 7 + z * 13));
  const lx = Math.sin(yaw) * lean,
    lz = Math.cos(yaw) * lean;
  const base = V(x, y - 0.3, z);
  const top = V(x + lx, y + h, z + lz);
  b.color.setRGB(0.36 * rng.range(0.9, 1.1), 0.29, 0.22);
  b.cylinder('pole', base, top, 0.16, 0.12, 8, true);
  // crossarm
  const ax = Math.cos(yaw),
    az = -Math.sin(yaw);
  const armY = y + h - 0.5;
  const c = V(top.x, armY, top.z);
  b.color.setRGB(0.4, 0.33, 0.26);
  b.beam('pole', c.clone().add(V(-ax * 1.2, 0, -az * 1.2)), c.clone().add(V(ax * 1.2, 0, az * 1.2)), 0.1, 0.12);
  const arms: THREE.Vector3[] = [];
  for (const o of [-1.05, 0, 1.05]) {
    const p = c.clone().add(V(ax * o, 0.2, az * o));
    b.color.setRGB(0.55, 0.62, 0.6);
    b.cylinder('insulator', p.clone().add(V(0, -0.12, 0)), p, 0.05, 0.035, 6);
    arms.push(p);
  }
  // secondary / telephone line lower on the pole
  arms.push(V(x + lx * 0.6, y + h * 0.62, z + lz * 0.6));
  // transformer on some poles
  if (rng.chance(0.25)) {
    b.color.setRGB(0.45, 0.47, 0.46);
    const tp = V(x + lx * 0.8 - az * 0.35, y + h - 2.2, z + lz * 0.8 + ax * 0.35);
    b.cylinder('metal', tp.clone().add(V(0, -0.5, 0)), tp.clone().add(V(0, 0.4, 0)), 0.3, 0.3, 10);
  }
  return { base, top, arms };
}

/** Sagging wire (catenary-ish parabola) as a thin tube. */
export function bakeWire(b: MeshBatcher, a: THREE.Vector3, c: THREE.Vector3, sag = 0.6, r = 0.012) {
  const seg = 12;
  let prev = a.clone();
  const len = a.distanceTo(c);
  const s = sag * (len / 40);
  for (let i = 1; i <= seg; i++) {
    const t = i / seg;
    const p = a.clone().lerp(c, t);
    p.y -= 4 * s * t * (1 - t);
    b.color.setRGB(0.08, 0.08, 0.08);
    b.cylinder('wire', prev, p, r, r, 3, false);
    prev = p;
  }
}

export function bakeStreetlight(b: MeshBatcher, x: number, y: number, z: number, yaw: number, h = 8.5): THREE.Vector3 {
  const pole = bakeUtilityPole(b, x, y, z, yaw, h + 1.5);
  // curved arm toward the road (local -z of yaw = toward road)
  const fx = -Math.sin(yaw),
    fz = -Math.cos(yaw);
  const armStart = V(x, y + h, z);
  const armEnd = V(x + fx * 2.4, y + h + 0.35, z + fz * 2.4);
  b.color.setRGB(0.5, 0.52, 0.5);
  b.beam('metal', armStart, armEnd, 0.07, 0.07);
  b.beam('metal', V(x, y + h - 0.7, z), armStart.clone().lerp(armEnd, 0.4), 0.05, 0.05);
  // cobra head
  const head = V(armEnd.x + fx * 0.35, armEnd.y - 0.05, armEnd.z + fz * 0.35);
  b.pushTRS(head.x, head.y, head.z, yaw);
  b.color.setRGB(0.55, 0.57, 0.55);
  b.box('metal', 0, 0, 0, 0.42, 0.2, 0.8);
  b.color.setRGB(0.95, 0.85, 0.7);
  b.box('lampLens', 0, -0.11, -0.05, 0.34, 0.04, 0.6);
  b.pop();
  void pole;
  return V(head.x, head.y - 0.18, head.z);
}

export function bakePicketFence(b: MeshBatcher, pts: THREE.Vector3[], color = 0xe8e4da, gapAt?: number) {
  b.color.set(color);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i],
      c = pts[i + 1];
    const len = a.distanceTo(c);
    const n = Math.floor(len / 0.14);
    const dir = c.clone().sub(a).normalize();
    for (let k = 0; k < n; k++) {
      if (gapAt !== undefined && i === gapAt && k > n * 0.4 && k < n * 0.6) continue;
      const p = a.clone().addScaledVector(dir, (k + 0.5) * (len / n));
      const hh = 0.95 + Math.sin(k * 1.7) * 0.02;
      const lean = (Math.sin(k * 3.1 + i) * 0.5 + 0.5) * 0.04;
      b.beam('trim', p.clone().setY(p.y - 0.1), p.clone().setY(p.y + hh).add(V(lean, 0, 0)), 0.075, 0.018);
    }
    b.beam('trim', a.clone().setY(a.y + 0.3), c.clone().setY(c.y + 0.3), 0.04, 0.08);
    b.beam('trim', a.clone().setY(a.y + 0.75), c.clone().setY(c.y + 0.75), 0.04, 0.08);
    b.box('trim', a.x, a.y + 0.5, a.z, 0.1, 1.2, 0.1);
  }
}

export function bakeGuardrail(b: MeshBatcher, pts: THREE.Vector3[]) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i],
      c = pts[i + 1];
    b.color.setRGB(0.62, 0.64, 0.62);
    b.beam('metal', a.clone().setY(a.y + 0.62), c.clone().setY(c.y + 0.62), 0.05, 0.32);
    b.color.setRGB(0.4, 0.33, 0.25);
    b.box('pole', a.x, a.y + 0.35, a.z, 0.15, 0.95, 0.2);
  }
  const l = pts[pts.length - 1];
  b.color.setRGB(0.4, 0.33, 0.25);
  b.box('pole', l.x, l.y + 0.35, l.z, 0.15, 0.95, 0.2);
}

export function bakePier(b: MeshBatcher, a: THREE.Vector3, c: THREE.Vector3, width: number, deckY: number, groundAt: (x: number, z: number) => number, broken?: [number, number]) {
  const dir = c.clone().sub(a).setY(0);
  const len = dir.length();
  dir.normalize();
  const side = V(-dir.z, 0, dir.x);
  const yaw = Math.atan2(dir.x, dir.z);
  // deck boards across
  const n = Math.floor(len / 0.3);
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n;
    if (broken && t > broken[0] && t < broken[1]) continue;
    const p = a.clone().lerp(c, t).setY(deckY);
    const shade = 0.75 + ((k * 7919) % 13) / 60;
    b.color.setRGB(0.55 * shade, 0.5 * shade, 0.42 * shade);
    const miss = (k * 31) % 29 === 0;
    if (miss) continue;
    b.pushTRS(p.x, p.y, p.z, yaw);
    b.box('planks', 0, 0, 0, width + ((k * 17) % 5) * 0.03, 0.07, 0.27, 0.5);
    b.pop();
  }
  // stringers & pilings
  for (let t = 0; t <= len; t += 3.2) {
    const p = a.clone().addScaledVector(dir, t);
    for (const s of [-1, 1]) {
      const q = p.clone().addScaledVector(side, (s * width) / 2);
      const g = groundAt(q.x, q.z);
      b.color.setRGB(0.28, 0.24, 0.2);
      b.cylinder('piling', V(q.x, g - 1, q.z), V(q.x, deckY + (s > 0 ? 1.1 : 0.9), q.z), 0.16, 0.14, 7);
      // barnacle band below old high water
      b.color.setRGB(0.55, 0.55, 0.5);
      if (g < 1.4) b.cylinder('piling', V(q.x, g, q.z), V(q.x, Math.min(1.4, deckY - 0.3), q.z), 0.175, 0.17, 7, false);
    }
    // cross bracing
    const q0 = p.clone().addScaledVector(side, -width / 2),
      q1 = p.clone().addScaledVector(side, width / 2);
    b.color.setRGB(0.3, 0.26, 0.21);
    b.beam('piling', q0.clone().setY(deckY - 0.25), q1.clone().setY(deckY - 0.25), 0.1, 0.22);
  }
  for (const s of [-1, 1]) {
    const q0 = a.clone().addScaledVector(side, (s * (width / 2 - 0.1))),
      q1 = c.clone().addScaledVector(side, (s * (width / 2 - 0.1)));
    b.color.setRGB(0.32, 0.27, 0.22);
    b.beam('piling', q0.clone().setY(deckY - 0.12), q1.clone().setY(deckY - 0.12), 0.12, 0.2);
    // rail
    b.color.setRGB(0.5, 0.46, 0.4);
    b.beam('planks', q0.clone().setY(deckY + 0.95), q1.clone().setY(deckY + 0.95), 0.1, 0.08, 0.5);
  }
}

// ------------------------------------------------------------------ small props
export function bakeHydrant(b: MeshBatcher, x: number, y: number, z: number) {
  b.color.setRGB(0.72, 0.62, 0.14);
  b.cylinder('metal', V(x, y, z), V(x, y + 0.6, z), 0.12, 0.11, 10);
  b.cylinder('metal', V(x, y + 0.6, z), V(x, y + 0.75, z), 0.1, 0.05, 10);
  b.cylinder('metal', V(x - 0.18, y + 0.42, z), V(x + 0.18, y + 0.42, z), 0.05, 0.05, 8);
}

export function bakeMailbox(b: MeshBatcher, x: number, y: number, z: number, yaw: number, flagUp = false) {
  b.color.setRGB(0.36, 0.3, 0.24);
  b.box('pole', x, y + 0.5, z, 0.09, 1.1, 0.09);
  b.pushTRS(x, y + 1.1, z, yaw);
  b.color.setRGB(0.55, 0.57, 0.56);
  b.box('metal', 0, 0, 0, 0.22, 0.24, 0.5);
  b.color.setRGB(0.7, 0.1, 0.08);
  if (flagUp) b.box('metal', 0.12, 0.2, 0.1, 0.01, 0.2, 0.06);
  else b.box('metal', 0.12, 0.02, 0.1, 0.01, 0.06, 0.2);
  b.pop();
}

export function bakeBench(b: MeshBatcher, x: number, y: number, z: number, yaw: number) {
  b.pushTRS(x, y, z, yaw);
  b.color.setRGB(0.5, 0.42, 0.33);
  for (const zz of [-0.12, 0, 0.12]) b.box('planks', 0, 0.45, zz, 1.6, 0.04, 0.1);
  for (const yy of [0.62, 0.78]) b.box('planks', 0, yy, 0.22, 1.6, 0.1, 0.03);
  b.color.setRGB(0.2, 0.2, 0.2);
  for (const xx of [-0.7, 0.7]) b.box('metal', xx, 0.22, 0.05, 0.05, 0.44, 0.45);
  b.pop();
}

export function bakeBarrel(b: MeshBatcher, x: number, y: number, z: number, color: number, tipped = false) {
  b.color.set(color);
  if (tipped) b.cylinder('metal', V(x - 0.45, y + 0.3, z), V(x + 0.45, y + 0.3, z), 0.3, 0.3, 12);
  else b.cylinder('metal', V(x, y, z), V(x, y + 0.9, z), 0.3, 0.3, 12);
}

export function bakeCrabPot(b: MeshBatcher, x: number, y: number, z: number, yaw: number) {
  b.pushTRS(x, y, z, yaw);
  b.color.setRGB(0.25, 0.27, 0.26);
  b.box('crabPot', 0, 0.2, 0, 0.9, 0.4, 0.9, 1);
  b.pop();
}

export function bakeBuoy(b: MeshBatcher, x: number, y: number, z: number, color: number) {
  b.color.set(color);
  b.cylinder('metal', V(x, y, z), V(x, y + 0.35, z), 0.14, 0.14, 10);
  b.cylinder('metal', V(x, y + 0.35, z), V(x, y + 0.45, z), 0.1, 0.03, 8);
}

export function signTexture(lines: string[], opts: { bg: string; fg: string; w?: number; h?: number; font?: string; border?: string; arrow?: 'left' | 'right' | null }) {
  const W = opts.w ?? 512,
    H = opts.h ?? 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = opts.bg;
  g.fillRect(0, 0, W, H);
  if (opts.border) {
    g.strokeStyle = opts.border;
    g.lineWidth = Math.max(4, W * 0.015);
    g.strokeRect(W * 0.03, H * 0.05, W * 0.94, H * 0.9);
  }
  g.fillStyle = opts.fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lh = H / (lines.length + 0.6);
  lines.forEach((l, i) => {
    let size = lh * 0.72;
    g.font = `700 ${size}px ${opts.font ?? "'Arial Narrow', Arial, sans-serif"}`;
    while (g.measureText(l).width > W * 0.88 && size > 8) {
      size -= 2;
      g.font = `700 ${size}px ${opts.font ?? "'Arial Narrow', Arial, sans-serif"}`;
    }
    g.fillText(l, W / 2, lh * (i + 0.8));
  });
  // weathering
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.6 ? '60,50,40' : '255,255,255'},${Math.random() * 0.08})`;
    g.fillRect(Math.random() * W, Math.random() * H, Math.random() * 20, Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A sign panel on a post (separate mesh because it carries its own texture). */
export function makeSign(tex: THREE.Texture, w: number, h: number, postH: number, doublePost = false) {
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.1 }));
  face.position.y = postH + h / 2;
  face.position.z = 0.03;
  g.add(face);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: 0x6b6d6a, roughness: 0.6, metalness: 0.4 }));
  back.rotation.y = Math.PI;
  back.position.copy(face.position);
  back.position.z = 0.02;
  g.add(back);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x5a5c58, roughness: 0.5, metalness: 0.6 });
  const posts = doublePost ? [-w * 0.35, w * 0.35] : [0];
  for (const px of posts) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, postH + h, 6), postMat);
    p.position.set(px, (postH + h) / 2, 0);
    g.add(p);
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}
