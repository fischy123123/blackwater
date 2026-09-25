// Procedural architecture: clapboard houses, false-front shops, sheds.
// Everything is appended to a MeshBatcher (per-material batches) plus collision boxes.
import * as THREE from 'three';
import { MeshBatcher } from './Batcher';
import type { CollisionWorld } from './Collision';

export type WindowSpec = { x: number; w: number; h: number; sill: number; type?: 'sash' | 'shop' | 'small' | 'round'; panes?: [number, number] };
export type DoorSpec = { x: number; w: number; h: number; id?: string; glass?: boolean; enterable?: boolean };
export type FacadeSpec = { windows?: WindowSpec[]; doors?: DoorSpec[] };
export type Side = 'front' | 'back' | 'left' | 'right';

export type BuildingSpec = {
  id: string;
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  floorY: number;
  stories: number;
  storyH?: number;
  roof: 'gable-x' | 'gable-z' | 'hip' | 'flat' | 'shed';
  pitch?: number;
  siding: 'clapboard' | 'shingleWall' | 'corrugated' | 'stucco' | 'brick' | 'board';
  color: number;
  trim?: number;
  roofMat?: 'shingles' | 'roofMetal' | 'corrugated';
  roofColor?: number;
  facades: Partial<Record<Side, FacadeSpec>>;
  porch?: { depth: number; w?: number; x?: number; steps?: boolean; roofH?: number };
  falseFront?: { h: number; sign?: string; signColor?: number; textColor?: string };
  chimney?: { x: number; z: number };
  enterable?: boolean;
  pilings?: boolean;
  light: number; // building light index
  groundAt?: (x: number, z: number) => number;
};

export type BuildingInfo = {
  spec: BuildingSpec;
  matrix: THREE.Matrix4; // local -> world
  doors: { id: string; world: THREE.Vector3; yaw: number; w: number; h: number; side: Side; local: THREE.Vector3 }[];
  signs: THREE.Mesh[];
  wallH: number;
  interiorBoxes: import('./Collision').Box[];
};

export function yawFacing(dx: number, dz: number) {
  return Math.atan2(-dx, -dz);
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Map facade coordinates (s along, t up, o outward offset) to building-local space. */
function facadePoint(side: Side, w: number, d: number, s: number, t: number, o = 0) {
  switch (side) {
    case 'front':
      return V(w / 2 - s, t, -o);
    case 'back':
      return V(-w / 2 + s, t, d + o);
    case 'left':
      return V(-w / 2 - o, t, s);
    case 'right':
      return V(w / 2 + o, t, d - s);
  }
}

function facadeLen(side: Side, w: number, d: number) {
  return side === 'front' || side === 'back' ? w : d;
}

function facadeNormal(side: Side) {
  return side === 'front' ? V(0, 0, -1) : side === 'back' ? V(0, 0, 1) : side === 'left' ? V(-1, 0, 0) : V(1, 0, 0);
}

type Opening = { s0: number; s1: number; t0: number; t1: number; kind: 'window' | 'door'; spec: WindowSpec | DoorSpec };

const WALL_KEY: Record<BuildingSpec['siding'], string> = {
  clapboard: 'siding',
  shingleWall: 'shingleWall',
  corrugated: 'corrugated',
  stucco: 'stucco',
  brick: 'brick',
  board: 'boardWall',
};

export class BuildingGen {
  b: MeshBatcher;
  col: CollisionWorld;
  signCanvasCache = new Map<string, THREE.Texture>();
  constructor(batcher: MeshBatcher, collision: CollisionWorld) {
    this.b = batcher;
    this.col = collision;
  }

  build(spec: BuildingSpec): BuildingInfo {
    const b = this.b;
    const storyH = spec.storyH ?? 3.0;
    const H = spec.stories * storyH;
    const { w, d } = spec;
    const trim = new THREE.Color(spec.trim ?? 0xe8e4da);
    const paint = new THREE.Color(spec.color);
    const matrix = new THREE.Matrix4().compose(
      V(spec.x, spec.floorY, spec.z),
      new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), spec.yaw),
      V(1, 1, 1),
    );
    b.push(matrix);
    const info: BuildingInfo = { spec, matrix, doors: [], signs: [], wallH: H, interiorBoxes: [] };
    const wallKey = WALL_KEY[spec.siding];

    // ------------------------------------------------ foundation
    const ground = spec.groundAt ?? (() => spec.floorY - 0.5);
    let minG = spec.floorY;
    for (const [lx, lz] of [
      [-w / 2, 0],
      [w / 2, 0],
      [-w / 2, d],
      [w / 2, d],
      [0, d / 2],
    ]) {
      const p = V(lx, 0, lz).applyMatrix4(matrix);
      minG = Math.min(minG, ground(p.x, p.z));
    }
    const fdn = spec.floorY - minG + 0.25;
    if (spec.pilings) {
      // timber deck on creosoted pilings
      b.color.setRGB(0.55, 0.5, 0.45);
      b.box('planks', 0, -0.2, d / 2, w + 0.3, 0.4, d + 0.3, 0.5);
      for (let px = -w / 2; px <= w / 2 + 0.01; px += w / Math.round(w / 3)) {
        for (let pz = 0; pz <= d + 0.01; pz += d / Math.round(d / 3)) {
          const wp = V(px, 0, pz).applyMatrix4(matrix);
          const g = ground(wp.x, wp.z);
          b.color.setRGB(0.3, 0.26, 0.22);
          b.cylinder('piling', V(px, g - 0.5 - spec.floorY, pz), V(px, -0.3, pz), 0.17, 0.15, 7, false);
        }
      }
    } else {
      b.color.setRGB(0.62, 0.6, 0.57);
      b.box('concrete', 0, -fdn / 2 + 0.05, d / 2, w + 0.12, fdn + 0.1, d + 0.12, 0.5, 0b110011);
    }

    // ------------------------------------------------ walls with openings
    const sides: Side[] = ['front', 'back', 'left', 'right'];
    for (const side of sides) {
      const L = facadeLen(side, w, d);
      const fs = spec.facades[side] ?? {};
      const ops: Opening[] = [];
      for (const win of fs.windows ?? []) {
        const s = L / 2 + win.x;
        ops.push({ s0: s - win.w / 2, s1: s + win.w / 2, t0: win.sill, t1: win.sill + win.h, kind: 'window', spec: win });
      }
      for (const door of fs.doors ?? []) {
        const s = L / 2 + door.x;
        ops.push({ s0: s - door.w / 2, s1: s + door.w / 2, t0: 0, t1: door.h, kind: 'door', spec: door });
      }
      // wall grid
      const sb = new Set<number>([0, L]);
      const tb = new Set<number>([0, H]);
      for (const o of ops) {
        sb.add(Math.max(0, Math.min(L, o.s0)));
        sb.add(Math.max(0, Math.min(L, o.s1)));
        tb.add(o.t0);
        tb.add(Math.min(H, o.t1));
      }
      const ss = [...sb].sort((a, c) => a - c);
      const ts = [...tb].sort((a, c) => a - c);
      b.color.copy(paint);
      for (let i = 0; i < ss.length - 1; i++)
        for (let j = 0; j < ts.length - 1; j++) {
          const s0 = ss[i],
            s1 = ss[i + 1],
            t0 = ts[j],
            t1 = ts[j + 1];
          if (s1 - s0 < 1e-3 || t1 - t0 < 1e-3) continue;
          const cs = (s0 + s1) / 2,
            ct = (t0 + t1) / 2;
          if (ops.some((o) => cs > o.s0 && cs < o.s1 && ct > o.t0 && ct < o.t1)) continue;
          b.color.copy(paint);
          this.wallQuad(wallKey, side, w, d, s0, s1, t0, t1, 0);
          if (spec.enterable) this.wallQuad('plaster', side, w, d, s1, s0, t0, t1, -0.18, true);
        }
      // openings: reveals, trim, windows, doors
      for (const o of ops) {
        this.reveal(side, w, d, o, spec.enterable ? 0.18 : 0.14);
        b.color.copy(trim);
        this.casing(side, w, d, o);
        if (o.kind === 'window') this.window(side, w, d, o, spec, trim);
        else {
          const ds = o.spec as DoorSpec;
          const center = facadePoint(side, w, d, (o.s0 + o.s1) / 2, 0, 0);
          const world = center.clone().applyMatrix4(matrix);
          const n = facadeNormal(side);
          const faceYaw = Math.atan2(n.x, n.z) + spec.yaw;
          info.doors.push({ id: ds.id ?? `${spec.id}-${side}`, world, yaw: faceYaw, w: ds.w, h: ds.h, side, local: center });
          if (!ds.enterable) this.fakeDoor(side, w, d, o, ds);
        }
      }
      // corner boards
      b.color.copy(trim);
      const c0 = facadePoint(side, w, d, 0.06, H / 2, 0.02);
      this.facadeBox(side, 0.14, H, 0.04, c0);
      // skirt board
      const sk = facadePoint(side, w, d, L / 2, 0.12, 0.02);
      this.facadeBox(side, L, 0.24, 0.04, sk);
      // frieze under eaves
      const fz = facadePoint(side, w, d, L / 2, H - 0.1, 0.02);
      this.facadeBox(side, L, 0.2, 0.04, fz);
      // storey band for 2-storey buildings
      if (spec.stories > 1) {
        const bd = facadePoint(side, w, d, L / 2, storyH, 0.02);
        this.facadeBox(side, L, 0.14, 0.04, bd);
      }
    }

    // ------------------------------------------------ roof
    const pitch = spec.pitch ?? 0.6;
    const oh = 0.35;
    const roofKey = spec.roofMat ?? 'shingles';
    const roofCol = new THREE.Color(spec.roofColor ?? 0xffffff);
    if (spec.roof === 'gable-x' || spec.roof === 'gable-z') {
      const alongX = spec.roof === 'gable-x';
      const span = alongX ? d : w; // across the ridge
      const len = alongX ? w : d; // along the ridge
      const rise = (span / 2) * pitch;
      const ridgeY = H + rise;
      // gable triangles
      b.color.copy(paint);
      const gsides: Side[] = alongX ? ['left', 'right'] : ['front', 'back'];
      for (const gs of gsides) {
        const L = facadeLen(gs, w, d);
        const p0 = facadePoint(gs, w, d, 0, H, 0),
          p1 = facadePoint(gs, w, d, L, H, 0),
          p2 = facadePoint(gs, w, d, L / 2, ridgeY, 0);
        this.tri(wallKey, p0, p1, p2);
        if (spec.enterable) this.tri('plaster', p1.clone().addScaledVector(facadeNormal(gs), -0.18), p0.clone().addScaledVector(facadeNormal(gs), -0.18), p2.clone().addScaledVector(facadeNormal(gs), -0.18));
        // small gable vent / window
        b.color.copy(trim);
        const vc = facadePoint(gs, w, d, L / 2, H + rise * 0.45, 0.03);
        this.facadeBox(gs, 0.5, 0.5, 0.05, vc);
      }
      // slopes
      b.color.copy(roofCol);
      const e = oh * pitch;
      if (alongX) {
        const x0 = -w / 2 - 0.25,
          x1 = w / 2 + 0.25;
        // front slope (toward -z)
        this.roofQuad(roofKey, V(x1, H - e, -oh), V(x0, H - e, -oh), V(x0, ridgeY, d / 2), V(x1, ridgeY, d / 2));
        this.roofQuad(roofKey, V(x0, H - e, d + oh), V(x1, H - e, d + oh), V(x1, ridgeY, d / 2), V(x0, ridgeY, d / 2));
        // fascia & rakes
        b.color.copy(trim);
        b.beam('trim', V(x0, H - e - 0.08, -oh), V(x1, H - e - 0.08, -oh), 0.04, 0.2);
        b.beam('trim', V(x0, H - e - 0.08, d + oh), V(x1, H - e - 0.08, d + oh), 0.04, 0.2);
        for (const x of [x0, x1]) {
          b.beam('trim', V(x, H - e - 0.05, -oh), V(x, ridgeY - 0.03, d / 2), 0.05, 0.2);
          b.beam('trim', V(x, H - e - 0.05, d + oh), V(x, ridgeY - 0.03, d / 2), 0.05, 0.2);
        }
        // soffits
        b.color.copy(trim);
        b.quad('trim', [V(x1, H - e, -oh), V(x1, H - 0.02, 0), V(x0, H - 0.02, 0), V(x0, H - e, -oh)]);
        b.quad('trim', [V(x0, H - e, d + oh), V(x0, H - 0.02, d), V(x1, H - 0.02, d), V(x1, H - e, d + oh)]);
        // gutters
        b.color.setRGB(0.5, 0.5, 0.48);
        b.beam('metal', V(x0, H - e - 0.12, -oh - 0.06), V(x1, H - e - 0.12, -oh - 0.06), 0.1, 0.1);
        b.beam('metal', V(x0, H - e - 0.12, d + oh + 0.06), V(x1, H - e - 0.12, d + oh + 0.06), 0.1, 0.1);
        b.beam('metal', V(x1 - 0.1, H - e - 0.12, -oh - 0.06), V(x1 - 0.1, 0.1, -oh - 0.06), 0.07, 0.07);
      } else {
        const z0 = -oh,
          z1 = d + oh;
        const xl = -w / 2 - oh,
          xr = w / 2 + oh;
        this.roofQuad(roofKey, V(xl, H - e, z0), V(xl, H - e, z1), V(0, ridgeY, z1), V(0, ridgeY, z0));
        this.roofQuad(roofKey, V(xr, H - e, z1), V(xr, H - e, z0), V(0, ridgeY, z0), V(0, ridgeY, z1));
        b.color.copy(trim);
        b.beam('trim', V(xl, H - e - 0.08, z0), V(xl, H - e - 0.08, z1), 0.04, 0.2);
        b.beam('trim', V(xr, H - e - 0.08, z0), V(xr, H - e - 0.08, z1), 0.04, 0.2);
        for (const z of [z0, z1]) {
          b.beam('trim', V(xl, H - e - 0.05, z), V(0, ridgeY - 0.03, z), 0.05, 0.2);
          b.beam('trim', V(xr, H - e - 0.05, z), V(0, ridgeY - 0.03, z), 0.05, 0.2);
        }
        b.quad('trim', [V(xl, H - e, z1), V(-w / 2, H - 0.02, z1), V(-w / 2, H - 0.02, z0), V(xl, H - e, z0)]);
        b.quad('trim', [V(xr, H - e, z0), V(w / 2, H - 0.02, z0), V(w / 2, H - 0.02, z1), V(xr, H - e, z1)]);
        b.color.setRGB(0.5, 0.5, 0.48);
        b.beam('metal', V(xl - 0.06, H - e - 0.12, z0), V(xl - 0.06, H - e - 0.12, z1), 0.1, 0.1);
        b.beam('metal', V(xr + 0.06, H - e - 0.12, z0), V(xr + 0.06, H - e - 0.12, z1), 0.1, 0.1);
      }
      // ridge cap
      b.color.copy(roofCol).multiplyScalar(0.8);
      if (alongX) b.beam(roofKey, V(-w / 2 - 0.27, ridgeY + 0.03, d / 2), V(w / 2 + 0.27, ridgeY + 0.03, d / 2), 0.28, 0.08);
      else b.beam(roofKey, V(0, ridgeY + 0.03, -oh - 0.02), V(0, ridgeY + 0.03, d + oh + 0.02), 0.28, 0.08);
      void len;
    } else if (spec.roof === 'hip') {
      const rise = Math.min(w, d) * 0.5 * pitch;
      const ridgeY = H + rise;
      const inset = Math.min(w, d) / 2;
      const e = oh * pitch;
      b.color.copy(roofCol);
      const a = V(-w / 2 - oh, H - e, -oh),
        bb = V(w / 2 + oh, H - e, -oh),
        c = V(w / 2 + oh, H - e, d + oh),
        dd = V(-w / 2 - oh, H - e, d + oh);
      const r0 = V(-w / 2 + inset, ridgeY, d / 2),
        r1 = V(w / 2 - inset, ridgeY, d / 2);
      this.roofQuad(roofKey, bb, a, r0, r1);
      this.roofQuad(roofKey, dd, c, r1, r0);
      this.tri(roofKey, a, dd, r0);
      this.tri(roofKey, c, bb, r1);
      b.color.copy(trim);
      b.quad('trim', [bb, V(w / 2, H, 0), V(-w / 2, H, 0), a]);
      b.quad('trim', [dd, V(-w / 2, H, d), V(w / 2, H, d), c]);
      b.quad('trim', [a, V(-w / 2, H, 0), V(-w / 2, H, d), dd]);
      b.quad('trim', [c, V(w / 2, H, d), V(w / 2, H, 0), bb]);
    } else if (spec.roof === 'shed' || spec.roof === 'flat') {
      const rise = spec.roof === 'shed' ? d * (spec.pitch ?? 0.15) : 0.15;
      b.color.copy(roofCol);
      this.roofQuad(roofKey, V(w / 2 + oh, H + rise, -oh), V(-w / 2 - oh, H + rise, -oh), V(-w / 2 - oh, H, d + oh), V(w / 2 + oh, H, d + oh));
      // side infill triangles
      b.color.copy(paint);
      this.tri(wallKey, V(-w / 2, H, 0), V(-w / 2, H, d), V(-w / 2, H + rise, 0));
      this.tri(wallKey, V(w / 2, H, d), V(w / 2, H, 0), V(w / 2, H + rise, 0));
      b.color.copy(trim);
      b.beam('trim', V(-w / 2 - oh, H + rise - 0.1, -oh), V(w / 2 + oh, H + rise - 0.1, -oh), 0.05, 0.22);
      b.beam('trim', V(-w / 2 - oh, H - 0.1, d + oh), V(w / 2 + oh, H - 0.1, d + oh), 0.05, 0.22);
    }

    // ------------------------------------------------ false front + sign
    if (spec.falseFront) {
      const ff = spec.falseFront;
      b.color.copy(paint);
      const top = H + ff.h;
      this.wallQuad(wallKey, 'front', w, d, 0, w, H, top, 0);
      this.wallQuad(wallKey, 'back', w, d, 0, w, H, top, -d + 0.2); // back of parapet
      b.color.copy(trim);
      b.box('trim', 0, top + 0.1, 0.05, w + 0.3, 0.2, 0.4);
      b.box('trim', 0, top - 0.12, -0.04, w + 0.12, 0.1, 0.1);
      // cornice brackets
      for (let i = 0; i <= 4; i++) b.box('trim', -w / 2 + (w * i) / 4, top - 0.25, -0.06, 0.1, 0.3, 0.12);
      if (ff.sign) {
        const sw = Math.min(w - 0.8, ff.sign.length * 0.42 + 0.8);
        const sh = Math.min(1.1, ff.h * 0.7);
        const tex = this.signTexture(ff.sign, ff.signColor ?? 0x2b2b28, ff.textColor ?? '#e8e0cf');
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(sw, sh),
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 }),
        );
        m.position.set(0, H + ff.h * 0.5, -0.06);
        m.rotation.y = Math.PI;
        m.position.applyMatrix4(new THREE.Matrix4()); // local
        const holder = new THREE.Object3D();
        holder.applyMatrix4(matrix);
        holder.add(m);
        m.userData.worldHolder = holder;
        info.signs.push(m);
        // sign frame
        b.color.copy(trim);
        b.box('trim', 0, H + ff.h * 0.5, -0.04, sw + 0.12, sh + 0.12, 0.04);
      }
    }

    // ------------------------------------------------ porch
    if (spec.porch) {
      const p = spec.porch;
      const pw = p.w ?? w;
      const px = p.x ?? 0;
      const ph = p.roofH ?? 2.7;
      b.color.setRGB(0.75, 0.72, 0.66);
      b.box('planks', px, -0.08, -p.depth / 2, pw, 0.16, p.depth, 0.5, 0b111111);
      // skirting lattice
      b.color.copy(trim);
      b.box('trim', px, -0.35, -p.depth + 0.02, pw, 0.4, 0.04);
      // posts
      const n = Math.max(2, Math.round(pw / 2.4) + 1);
      for (let i = 0; i < n; i++) {
        const x = px - pw / 2 + 0.12 + ((pw - 0.24) * i) / (n - 1);
        b.box('trim', x, ph / 2, -p.depth + 0.12, 0.14, ph, 0.14);
        this.col.boxYaw(...this.worldXZ(matrix, x, -p.depth + 0.12), 0.18, 0.18, spec.yaw, spec.floorY, spec.floorY + ph, false);
      }
      // railing (skip centre for steps)
      for (let i = 0; i < n - 1; i++) {
        const xa = px - pw / 2 + 0.12 + ((pw - 0.24) * i) / (n - 1);
        const xb = px - pw / 2 + 0.12 + ((pw - 0.24) * (i + 1)) / (n - 1);
        if (Math.abs((xa + xb) / 2 - px) < 1.0 && p.steps !== false) continue;
        b.beam('trim', V(xa, 0.9, -p.depth + 0.12), V(xb, 0.9, -p.depth + 0.12), 0.08, 0.06);
        b.beam('trim', V(xa, 0.12, -p.depth + 0.12), V(xb, 0.12, -p.depth + 0.12), 0.06, 0.06);
        for (let k = 1; k < 8; k++) {
          const x = xa + ((xb - xa) * k) / 8;
          b.box('trim', x, 0.5, -p.depth + 0.12, 0.035, 0.76, 0.035);
        }
      }
      // porch roof
      b.color.copy(roofCol);
      const e = 0.3;
      this.roofQuad(roofKey, V(px + pw / 2 + 0.2, ph, -p.depth - e), V(px - pw / 2 - 0.2, ph, -p.depth - e), V(px - pw / 2 - 0.2, ph + 0.5, 0), V(px + pw / 2 + 0.2, ph + 0.5, 0));
      b.color.copy(trim);
      b.beam('trim', V(px - pw / 2 - 0.2, ph - 0.1, -p.depth - e), V(px + pw / 2 + 0.2, ph - 0.1, -p.depth - e), 0.05, 0.22);
      b.quad('trim', [V(px - pw / 2, ph - 0.02, -p.depth - e + 0.05), V(px + pw / 2, ph - 0.02, -p.depth - e + 0.05), V(px + pw / 2, ph + 0.45, 0), V(px - pw / 2, ph + 0.45, 0)]);
      // collision: deck
      const dc = this.worldXZ(matrix, px, -p.depth / 2);
      this.col.boxYaw(dc[0], dc[1], pw, p.depth, spec.yaw, spec.floorY - 3, spec.floorY, true, 'wood');
      // steps down to the ground
      if (p.steps !== false) {
        const g = ground(...this.worldXZ(matrix, px, -p.depth - 0.8));
        const drop = spec.floorY - g;
        const nSteps = Math.max(1, Math.round(drop / 0.18));
        const rise = drop / nSteps;
        for (let k = 1; k <= nSteps; k++) {
          const y = -rise * k;
          const z = -p.depth - 0.15 - (k - 0.5) * 0.3;
          b.color.setRGB(0.7, 0.68, 0.62);
          b.box('planks', px, y + rise / 2 - 0.02, z, 1.6, rise, 0.32, 0.5);
          const sc = this.worldXZ(matrix, px, z);
          this.col.boxYaw(sc[0], sc[1], 1.6, 0.32, spec.yaw, spec.floorY - 3, spec.floorY + y + rise, true, 'wood');
        }
      }
    }

    // ------------------------------------------------ chimney
    if (spec.chimney) {
      const c = spec.chimney;
      const top = H + (Math.min(w, d) / 2) * pitch + 1.1;
      b.color.setRGB(1, 1, 1);
      b.box('brick', c.x, (top + H - 1) / 2, c.z, 0.7, top - H + 1, 0.7, 0.5);
      b.color.setRGB(0.5, 0.49, 0.46);
      b.box('concrete', c.x, top + 0.05, c.z, 0.85, 0.12, 0.85);
    }

    // ------------------------------------------------ collision
    if (!spec.enterable) {
      const c = this.worldXZ(matrix, 0, d / 2);
      this.col.boxYaw(c[0], c[1], w, d, spec.yaw, spec.floorY - 3, spec.floorY + H + 3, false, 'building');
    } else {
      // exterior walls as thin boxes with door gaps
      const t = 0.2;
      const sidesC: Side[] = ['front', 'back', 'left', 'right'];
      for (const side of sidesC) {
        const L = facadeLen(side, w, d);
        const doors = (spec.facades[side]?.doors ?? []).filter((dd) => dd.enterable);
        const cuts = doors.map((dd) => [L / 2 + dd.x - dd.w / 2, L / 2 + dd.x + dd.w / 2]).sort((a, c) => a[0] - c[0]);
        let s = 0;
        const segs: [number, number][] = [];
        for (const [a, c] of cuts) {
          if (a > s) segs.push([s, a]);
          s = c;
        }
        if (s < L) segs.push([s, L]);
        for (const [a, c] of segs) {
          const mid = facadePoint(side, w, d, (a + c) / 2, 0, -t / 2);
          const wc = this.worldXZ(matrix, mid.x, mid.z);
          const along = c - a;
          const isFB = side === 'front' || side === 'back';
          this.col.boxYaw(wc[0], wc[1], isFB ? along : t, isFB ? t : along, spec.yaw, spec.floorY - 3, spec.floorY + H + 2, false, 'wall');
        }
        // lintel above doors
        for (const dd of doors) {
          const mid = facadePoint(side, w, d, L / 2 + dd.x, 0, -t / 2);
          const wc = this.worldXZ(matrix, mid.x, mid.z);
          const isFB = side === 'front' || side === 'back';
          this.col.boxYaw(wc[0], wc[1], isFB ? dd.w : t, isFB ? t : dd.w, spec.yaw, spec.floorY + dd.h, spec.floorY + H + 2, false, 'wall');
        }
      }
      // floor
      const fc = this.worldXZ(matrix, 0, d / 2);
      info.interiorBoxes.push(this.col.boxYaw(fc[0], fc[1], w - 0.1, d - 0.1, spec.yaw, spec.floorY - 3, spec.floorY, true, 'wood'));
    }

    b.pop();
    return info;
  }

  worldXZ(m: THREE.Matrix4, lx: number, lz: number): [number, number] {
    const p = V(lx, 0, lz).applyMatrix4(m);
    return [p.x, p.z];
  }

  private wallQuad(key: string, side: Side, w: number, d: number, s0: number, s1: number, t0: number, t1: number, o: number, inner = false) {
    const p0 = facadePoint(side, w, d, s0, t0, o),
      p1 = facadePoint(side, w, d, s1, t0, o),
      p2 = facadePoint(side, w, d, s1, t1, o),
      p3 = facadePoint(side, w, d, s0, t1, o);
    const us = 0.5;
    const uv = [s0 * us, t0 * us, s1 * us, t0 * us, s1 * us, t1 * us, s0 * us, t1 * us];
    if (inner) this.b.color.setRGB(0.86, 0.84, 0.78);
    this.b.quad(key, [p0, p1, p2, p3], us, uv);
  }

  private tri(key: string, a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3) {
    // degenerate quad
    const m = c.clone();
    const L = a.distanceTo(bb);
    const H = c.y - a.y;
    this.b.quad(key, [a, bb, c, m], 0.5, [0, a.y * 0.5, L * 0.5, bb.y * 0.5, L * 0.25, (a.y + H) * 0.5, L * 0.25, (a.y + H) * 0.5]);
  }

  private roofQuad(key: string, a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, dd: THREE.Vector3) {
    // UV: u along the eave, v up the slope (so shingle courses run horizontally)
    const eave = a.distanceTo(bb);
    const slope = bb.distanceTo(c);
    const s = key === 'shingles' ? 0.33 : 0.5;
    this.b.quad(key, [a, bb, c, dd], s, [0, 0, eave * s, 0, eave * s, slope * s, 0, slope * s]);
    // underside
    this.b.color.multiplyScalar(0.5);
    this.b.quad(key, [bb, a, dd.clone().setY(dd.y - 0.06), c.clone().setY(c.y - 0.06)], s);
    this.b.color.multiplyScalar(2);
  }

  /** Thin box aligned with a facade at facade point c (size along facade, height, depth outward). */
  private facadeBox(side: Side, along: number, h: number, depth: number, c: THREE.Vector3) {
    const isFB = side === 'front' || side === 'back';
    this.b.box('trim', c.x, c.y, c.z, isFB ? along : depth, h, isFB ? depth : along, 1);
  }

  private reveal(side: Side, w: number, d: number, o: Opening, depth: number) {
    const b = this.b;
    b.color.setRGB(0.8, 0.78, 0.72);
    const P = (s: number, t: number, off: number) => facadePoint(side, w, d, s, t, off);
    // left, right, top, bottom inner faces
    b.quad('trim', [P(o.s0, o.t0, 0), P(o.s0, o.t0, -depth), P(o.s0, o.t1, -depth), P(o.s0, o.t1, 0)]);
    b.quad('trim', [P(o.s1, o.t0, -depth), P(o.s1, o.t0, 0), P(o.s1, o.t1, 0), P(o.s1, o.t1, -depth)]);
    b.quad('trim', [P(o.s0, o.t1, 0), P(o.s0, o.t1, -depth), P(o.s1, o.t1, -depth), P(o.s1, o.t1, 0)]);
    if (o.t0 > 0.01) b.quad('trim', [P(o.s1, o.t0, 0), P(o.s1, o.t0, -depth), P(o.s0, o.t0, -depth), P(o.s0, o.t0, 0)]);
  }

  private casing(side: Side, w: number, d: number, o: Opening) {
    const cw = 0.11,
      pr = 0.035;
    const P = (s: number, t: number) => facadePoint(side, w, d, s, t, pr / 2);
    const midS = (o.s0 + o.s1) / 2;
    const width = o.s1 - o.s0;
    this.facadeBox(side, cw, o.t1 - o.t0 + cw, pr, P(o.s0 - cw / 2, (o.t0 + o.t1 + cw) / 2));
    this.facadeBox(side, cw, o.t1 - o.t0 + cw, pr, P(o.s1 + cw / 2, (o.t0 + o.t1 + cw) / 2));
    // head with drip cap
    this.facadeBox(side, width + cw * 2 + 0.06, 0.16, pr + 0.02, P(midS, o.t1 + 0.08));
    if (o.kind === 'window') {
      // sill
      const sp = facadePoint(side, w, d, midS, o.t0 - 0.03, 0.05);
      this.facadeBox(side, width + cw * 2 + 0.1, 0.06, 0.1, sp);
    }
  }

  private window(side: Side, w: number, d: number, o: Opening, spec: BuildingSpec, trim: THREE.Color) {
    const b = this.b;
    const ws = o.spec as WindowSpec;
    const inset = 0.09;
    const n = facadeNormal(side);
    const P = (s: number, t: number, off = -inset) => facadePoint(side, w, d, s, t, off);
    // glass pane with room data: extra = (roomDepth, seed, buildingLight, windowWidth)
    const gkey = spec.enterable ? 'glassClear' : 'glass';
    b.enableExtra(gkey);
    const seed = Math.abs(Math.sin(o.s0 * 12.9898 + o.t0 * 78.233 + spec.x * 3.1 + spec.z * 1.7)) % 1;
    b.extra.set(3.5 + seed * 2.5, seed, spec.light, o.s1 - o.s0);
    b.color.setRGB(o.s1 - o.s0, o.t1 - o.t0, o.t0);
    b.quad(gkey, [P(o.s0, o.t0), P(o.s1, o.t0), P(o.s1, o.t1), P(o.s0, o.t1)], 1, [0, 0, 1, 0, 1, 1, 0, 1]);
    // frame & muntins
    b.color.copy(trim);
    const fw = 0.05;
    const midS = (o.s0 + o.s1) / 2;
    const midT = (o.t0 + o.t1) / 2;
    const width = o.s1 - o.s0,
      height = o.t1 - o.t0;
    const fb = (s: number, t: number, a: number, h: number) => this.facadeBox(side, a, h, 0.05, P(s, t, -inset + 0.03));
    fb(midS, o.t0 + fw / 2, width, fw);
    fb(midS, o.t1 - fw / 2, width, fw);
    fb(o.s0 + fw / 2, midT, fw, height);
    fb(o.s1 - fw / 2, midT, fw, height);
    const type = ws.type ?? 'sash';
    if (type === 'sash') {
      // meeting rail + muntins (2 over 2)
      fb(midS, midT, width, 0.06);
      const panes = ws.panes ?? [2, 2];
      for (let i = 1; i < panes[0]; i++) fb(o.s0 + (width * i) / panes[0], midT, 0.03, height);
      for (let j = 1; j < panes[1] / 2; j++) {
        fb(midS, o.t0 + (height / 2) * (j / (panes[1] / 2)), width, 0.03);
        fb(midS, midT + (height / 2) * (j / (panes[1] / 2)), width, 0.03);
      }
    } else if (type === 'shop') {
      fb(midS, o.t1 - height * 0.18, width, 0.05); // transom bar
      const nv = Math.max(1, Math.round(width / 1.3));
      for (let i = 1; i < nv; i++) fb(o.s0 + (width * i) / nv, midT, 0.05, height);
    } else if (type === 'small') {
      fb(midS, midT, 0.03, height);
    }
    void n;
  }

  private fakeDoor(side: Side, w: number, d: number, o: Opening, ds: DoorSpec) {
    const b = this.b;
    const P = (s: number, t: number, off: number) => facadePoint(side, w, d, s, t, off);
    b.color.setRGB(0.36, 0.3, 0.26);
    b.quad('door', [P(o.s0, 0, -0.1), P(o.s1, 0, -0.1), P(o.s1, o.t1, -0.1), P(o.s0, o.t1, -0.1)], 1, [0, 0, 1, 0, 1, 1, 0, 1]);
    // knob
    b.color.setRGB(0.6, 0.5, 0.3);
    const kc = P(o.s1 - 0.12, 1.0, -0.05);
    b.box('metal', kc.x, kc.y, kc.z, 0.06, 0.06, 0.06);
    void ds;
  }

  signTexture(text: string, bg: number, fg: string) {
    const key = text + bg + fg;
    const cached = this.signCanvasCache.get(key);
    if (cached) return cached;
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 256;
    const g = c.getContext('2d')!;
    const col = new THREE.Color(bg);
    g.fillStyle = `#${col.getHexString()}`;
    g.fillRect(0, 0, 1024, 256);
    // weathering
    for (let i = 0; i < 1600; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.05})`;
      g.fillRect(Math.random() * 1024, Math.random() * 256, Math.random() * 60, Math.random() * 3);
    }
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 150;
    g.font = `600 ${size}px 'Cormorant Garamond', Georgia, serif`;
    while (g.measureText(text).width > 940 && size > 40) {
      size -= 6;
      g.font = `600 ${size}px 'Cormorant Garamond', Georgia, serif`;
    }
    g.fillText(text, 512, 136);
    // chipped paint over letters
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${0.3 + Math.random() * 0.5})`;
      g.fillRect(Math.random() * 1024, Math.random() * 256, Math.random() * 10, Math.random() * 4);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.signCanvasCache.set(key, t);
    return t;
  }
}
