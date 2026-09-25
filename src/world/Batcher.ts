// Accumulates static geometry per material so a whole town renders in a few draw calls.
import * as THREE from 'three';

export class Batch {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  extra: number[] = []; // optional vec4 per vertex
  idx: number[] = [];
  hasExtra = false;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

export class MeshBatcher {
  batches = new Map<string, Batch>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  color = new THREE.Color(1, 1, 1);
  extra = new THREE.Vector4(0, 0, 0, 0);

  get m() {
    return this.stack[this.stack.length - 1];
  }

  push(m: THREE.Matrix4) {
    this.stack.push(this.m.clone().multiply(m));
  }
  pushTRS(x: number, y: number, z: number, yaw = 0, sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      new THREE.Vector3(sx, sy, sz),
    );
    this.push(m);
  }
  pop() {
    if (this.stack.length > 1) this.stack.pop();
  }

  batch(key: string) {
    let b = this.batches.get(key);
    if (!b) this.batches.set(key, (b = new Batch()));
    return b;
  }

  private vert(b: Batch, x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    _v.set(x, y, z).applyMatrix4(this.m);
    _n.set(nx, ny, nz).applyMatrix3(_m3.getNormalMatrix(this.m)).normalize();
    b.pos.push(_v.x, _v.y, _v.z);
    b.nrm.push(_n.x, _n.y, _n.z);
    b.uv.push(u, v);
    b.col.push(this.color.r, this.color.g, this.color.b);
    if (b.hasExtra) b.extra.push(this.extra.x, this.extra.y, this.extra.z, this.extra.w);
    return b.pos.length / 3 - 1;
  }

  /** Quad from 4 local points (counter-clockwise seen from the front). UVs in metres * uvScale. */
  quad(key: string, p: THREE.Vector3[], uvScale = 0.5, uvOverride?: number[]) {
    const b = this.batch(key);
    const e1 = new THREE.Vector3().subVectors(p[1], p[0]);
    const e2 = new THREE.Vector3().subVectors(p[3], p[0]);
    const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
    const lu = e1.length(),
      lv = e2.length();
    const uvs = uvOverride ?? [0, 0, lu * uvScale, 0, lu * uvScale, lv * uvScale, 0, lv * uvScale];
    const i0 = this.vert(b, p[0].x, p[0].y, p[0].z, n.x, n.y, n.z, uvs[0], uvs[1]);
    this.vert(b, p[1].x, p[1].y, p[1].z, n.x, n.y, n.z, uvs[2], uvs[3]);
    this.vert(b, p[2].x, p[2].y, p[2].z, n.x, n.y, n.z, uvs[4], uvs[5]);
    this.vert(b, p[3].x, p[3].y, p[3].z, n.x, n.y, n.z, uvs[6], uvs[7]);
    b.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }

  /** Axis-aligned (local) box centred at c with size s. faces: +x -x +y -y +z -z bitmask (default all). */
  box(key: string, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, uvScale = 0.5, faces = 0b111111) {
    const x0 = cx - sx / 2,
      x1 = cx + sx / 2,
      y0 = cy - sy / 2,
      y1 = cy + sy / 2,
      z0 = cz - sz / 2,
      z1 = cz + sz / 2;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    if (faces & 0b100000) this.quad(key, [V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1)], uvScale); // +x
    if (faces & 0b010000) this.quad(key, [V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0)], uvScale); // -x
    if (faces & 0b001000) this.quad(key, [V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0), V(x0, y1, z0)], uvScale); // +y
    if (faces & 0b000100) this.quad(key, [V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1)], uvScale); // -y
    if (faces & 0b000010) this.quad(key, [V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)], uvScale); // +z
    if (faces & 0b000001) this.quad(key, [V(x1, y0, z0), V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0)], uvScale); // -z
  }

  /** Box rotated around its own y axis. */
  boxR(key: string, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number, uvScale = 0.5) {
    this.pushTRS(cx, cy, cz, yaw);
    this.box(key, 0, 0, 0, sx, sy, sz, uvScale);
    this.pop();
  }

  /** Box between two points (for posts, beams, rails). */
  beam(key: string, a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, uvScale = 1) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().normalize());
    const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    this.push(m);
    this.box(key, 0, 0, 0, w, h, len, uvScale);
    this.pop();
  }

  /** Cylinder (e.g. poles, pilings). */
  cylinder(key: string, a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, seg = 8, caps = true) {
    const bt = this.batch(key);
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    const m = new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1));
    this.push(m);
    const base = bt.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const c = Math.cos(t),
        s = Math.sin(t);
      this.vert(bt, c * r0, 0, s * r0, c, 0, s, (i / seg) * 2 * Math.PI * r0, 0);
      this.vert(bt, c * r1, len, s * r1, c, 0, s, (i / seg) * 2 * Math.PI * r1, len);
    }
    for (let i = 0; i < seg; i++) {
      const a0 = base + i * 2;
      bt.idx.push(a0, a0 + 1, a0 + 2, a0 + 2, a0 + 1, a0 + 3);
    }
    if (caps) {
      const c0 = this.vert(bt, 0, len, 0, 0, 1, 0, 0, 0);
      for (let i = 0; i < seg; i++) {
        const t0 = (i / seg) * Math.PI * 2,
          t1 = ((i + 1) / seg) * Math.PI * 2;
        const v0 = this.vert(bt, Math.cos(t0) * r1, len, Math.sin(t0) * r1, 0, 1, 0, 0, 0);
        const v1 = this.vert(bt, Math.cos(t1) * r1, len, Math.sin(t1) * r1, 0, 1, 0, 0, 0);
        bt.idx.push(c0, v1, v0);
      }
    }
    this.pop();
  }

  /** Append an arbitrary geometry (non-indexed or indexed) with the current transform. */
  geometry(key: string, g: THREE.BufferGeometry, m?: THREE.Matrix4) {
    if (m) this.push(m);
    const bt = this.batch(key);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const base = bt.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      this.vert(bt, p.getX(i), p.getY(i), p.getZ(i), n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) bt.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) bt.idx.push(base + i);
    if (m) this.pop();
  }

  buildGeometry(key: string): THREE.BufferGeometry | null {
    const b = this.batches.get(key);
    if (!b || b.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    if (b.hasExtra) g.setAttribute('aExtra', new THREE.Float32BufferAttribute(b.extra, 4));
    const big = b.pos.length / 3 > 65535;
    g.setIndex(big ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  enableExtra(key: string) {
    this.batch(key).hasExtra = true;
  }
}
