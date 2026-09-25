// Lightweight collision world for a walking character and a car:
// terrain heightfield + circles (trunks, posts) + oriented boxes (walls, furniture,
// vehicles, floors/steps). Boxes can be walked on if their top is within step height.
import * as THREE from 'three';

export type Circle = { kind: 'circle'; x: number; z: number; r: number; y0: number; y1: number; tag?: string };
export type Box = {
  kind: 'box';
  x: number;
  z: number;
  hw: number; // half width (local x)
  hd: number; // half depth (local z)
  rot: number; // yaw
  y0: number;
  y1: number;
  walkable: boolean;
  dynamic?: boolean;
  tag?: string;
  enabled?: boolean;
  // cached
  c?: number;
  s?: number;
};
export type Collider = Circle | Box;

export class CollisionWorld {
  private cell = 8;
  private grid = new Map<number, Collider[]>();
  dynamics: Box[] = [];
  heightAt: (x: number, z: number) => number;
  waterAt: ((x: number, z: number) => number) | null = null;

  constructor(heightAt: (x: number, z: number) => number) {
    this.heightAt = heightAt;
  }

  private key(ix: number, iz: number) {
    return (ix + 4096) * 8192 + (iz + 4096);
  }

  add(c: Collider) {
    if (c.kind === 'box') {
      c.c = Math.cos(c.rot);
      c.s = Math.sin(c.rot);
      if (c.enabled === undefined) c.enabled = true;
      if (c.dynamic) {
        this.dynamics.push(c);
        return c;
      }
    }
    const r = c.kind === 'circle' ? c.r : Math.hypot(c.hw, c.hd);
    const x0 = Math.floor((c.x - r) / this.cell),
      x1 = Math.floor((c.x + r) / this.cell);
    const z0 = Math.floor((c.z - r) / this.cell),
      z1 = Math.floor((c.z + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let a = this.grid.get(k);
        if (!a) this.grid.set(k, (a = []));
        a.push(c);
      }
    return c;
  }

  box(x: number, z: number, w: number, d: number, rot: number, y0: number, y1: number, walkable = false, tag?: string) {
    return this.add({ kind: 'box', x, z, hw: w / 2, hd: d / 2, rot, y0, y1, walkable, tag }) as Box;
  }

  circle(x: number, z: number, r: number, y0: number, y1: number, tag?: string) {
    return this.add({ kind: 'circle', x, z, r, y0, y1, tag }) as Circle;
  }

  updateBox(b: Box) {
    b.c = Math.cos(b.rot);
    b.s = Math.sin(b.rot);
  }

  private tmp: Collider[] = [];
  query(x: number, z: number, r: number): Collider[] {
    const out = this.tmp;
    out.length = 0;
    const x0 = Math.floor((x - r) / this.cell),
      x1 = Math.floor((x + r) / this.cell);
    const z0 = Math.floor((z - r) / this.cell),
      z1 = Math.floor((z + r) / this.cell);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const a = this.grid.get(this.key(ix, iz));
        if (!a) continue;
        for (const c of a) if (out.indexOf(c) < 0) out.push(c);
      }
    for (const d of this.dynamics) if (d.enabled !== false && Math.abs(d.x - x) < r + 20 && Math.abs(d.z - z) < r + 20) out.push(d);
    return out;
  }

  /** Ground height under a disc (terrain or walkable box tops no higher than maxY). */
  groundAt(x: number, z: number, r: number, maxY: number): { y: number; box: Box | null } {
    let y = this.heightAt(x, z);
    let hit: Box | null = null;
    for (const c of this.query(x, z, r + 0.5)) {
      if (c.kind !== 'box' || !c.walkable || c.enabled === false) continue;
      if (c.y1 > maxY) continue;
      const lx = (x - c.x) * c.c! + (z - c.z) * c.s!;
      const lz = -(x - c.x) * c.s! + (z - c.z) * c.c!;
      if (Math.abs(lx) <= c.hw + r * 0.3 && Math.abs(lz) <= c.hd + r * 0.3) {
        if (c.y1 > y) {
          y = c.y1;
          hit = c;
        }
      }
    }
    return { y, box: hit };
  }

  /** Lowest ceiling above y (boxes whose bottom is above the head), for headroom checks. */
  ceilingAt(x: number, z: number, y: number): number {
    let top = Infinity;
    for (const c of this.query(x, z, 0.5)) {
      if (c.kind !== 'box' || c.enabled === false) continue;
      if (c.y0 < y) continue;
      const lx = (x - c.x) * c.c! + (z - c.z) * c.s!;
      const lz = -(x - c.x) * c.s! + (z - c.z) * c.c!;
      if (Math.abs(lx) <= c.hw && Math.abs(lz) <= c.hd) top = Math.min(top, c.y0);
    }
    return top;
  }

  /**
   * Push a vertical capsule (disc radius r spanning [yFeet, yHead]) out of colliders.
   * Returns the corrected position (in place) and whether anything was hit.
   */
  resolve(p: THREE.Vector3, r: number, yFeet: number, yHead: number, stepH: number): boolean {
    let hitAny = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.query(p.x, p.z, r + 1)) {
        if (c.y1 <= yFeet + stepH || c.y0 >= yHead) continue;
        if (c.kind === 'circle') {
          const dx = p.x - c.x,
            dz = p.z - c.z;
          const d = Math.hypot(dx, dz);
          const min = r + c.r;
          if (d < min && d > 1e-5) {
            p.x = c.x + (dx / d) * min;
            p.z = c.z + (dz / d) * min;
            moved = hitAny = true;
          }
        } else {
          if (c.enabled === false) continue;
          const cx = c.c!,
            sx = c.s!;
          const lx = (p.x - c.x) * cx + (p.z - c.z) * sx;
          const lz = -(p.x - c.x) * sx + (p.z - c.z) * cx;
          const qx = Math.max(-c.hw, Math.min(c.hw, lx));
          const qz = Math.max(-c.hd, Math.min(c.hd, lz));
          let dx = lx - qx,
            dz = lz - qz;
          let d = Math.hypot(dx, dz);
          if (d < r) {
            if (d < 1e-5) {
              // centre inside the box: push out along the shallowest axis
              const px = c.hw - Math.abs(lx),
                pz = c.hd - Math.abs(lz);
              if (px < pz) {
                dx = Math.sign(lx) || 1;
                dz = 0;
                d = -px;
              } else {
                dx = 0;
                dz = Math.sign(lz) || 1;
                d = -pz;
              }
              const push = r - d;
              const nlx = lx + dx * push,
                nlz = lz + dz * push;
              p.x = c.x + nlx * cx - nlz * sx;
              p.z = c.z + nlx * sx + nlz * cx;
            } else {
              const push = r - d;
              const nlx = lx + (dx / d) * push,
                nlz = lz + (dz / d) * push;
              p.x = c.x + nlx * cx - nlz * sx;
              p.z = c.z + nlx * sx + nlz * cx;
            }
            moved = hitAny = true;
          }
        }
      }
      if (!moved) break;
    }
    return hitAny;
  }

  /** Ray march against boxes/circles in XZ + terrain for line-of-sight checks. */
  segmentBlocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const steps = Math.ceil(a.distanceTo(b) / 0.5);
    const p = new THREE.Vector3();
    for (let i = 1; i < steps; i++) {
      p.lerpVectors(a, b, i / steps);
      if (p.y < this.heightAt(p.x, p.z)) return true;
      for (const c of this.query(p.x, p.z, 0.2)) {
        if (p.y < c.y0 || p.y > c.y1) continue;
        if (c.kind === 'circle') {
          if (Math.hypot(p.x - c.x, p.z - c.z) < c.r) return true;
        } else if (c.enabled !== false) {
          const lx = (p.x - c.x) * c.c! + (p.z - c.z) * c.s!;
          const lz = -(p.x - c.x) * c.s! + (p.z - c.z) * c.c!;
          if (Math.abs(lx) < c.hw && Math.abs(lz) < c.hd) return true;
        }
      }
    }
    return false;
  }
}
