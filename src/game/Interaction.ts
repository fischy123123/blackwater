// Focus + use system for world interactables, and hinged doors.
import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { UI } from '../ui/UI';
import type { CollisionWorld, Box } from '../world/Collision';
import { audio } from '../audio/AudioEngine';
import { damp } from '../core/math';

export type Interactable = {
  id: string;
  pos: THREE.Vector3;
  radius: number;
  label: string | (() => string);
  verb: string | (() => string);
  enabled?: () => boolean;
  onUse: () => void;
  cone?: number; // cos of max angle from view dir
  requireSight?: boolean;
};

export class Interaction {
  items: Interactable[] = [];
  focus: Interactable | null = null;
  enabled = true;
  private eye = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  constructor(
    public input: Input,
    public ui: UI,
    public collision: CollisionWorld,
    public camera: THREE.PerspectiveCamera,
  ) {
    input.onTap = (x, y) => this.tap(x, y);
  }

  add(i: Interactable) {
    this.items.push(i);
    return i;
  }

  remove(id: string) {
    this.items = this.items.filter((i) => i.id !== id);
  }

  get(id: string) {
    return this.items.find((i) => i.id === id);
  }

  private candidate(i: Interactable) {
    if (i.enabled && !i.enabled()) return -1;
    this.tmp.copy(i.pos).sub(this.eye);
    const d = this.tmp.length();
    if (d > i.radius) return -1;
    const c = this.tmp.dot(this.dir) / Math.max(d, 1e-3);
    const cone = i.cone ?? (d < 1.2 ? 0.55 : 0.86);
    if (c < cone) return -1;
    if (i.requireSight !== false && d > 1.2) {
      const from = this.eye.clone().addScaledVector(this.dir, 0.25);
      const to = i.pos.clone().addScaledVector(this.tmp.normalize(), -0.35);
      if (this.collision.segmentBlocked(from, to)) return -1;
    }
    return c * 2 - d * 0.05;
  }

  update() {
    if (!this.enabled) {
      if (this.focus) this.ui.setFocus(null);
      this.focus = null;
      return;
    }
    this.eye.copy(this.camera.position);
    this.dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let best: Interactable | null = null,
      bs = -1;
    for (const i of this.items) {
      const s = this.candidate(i);
      if (s > bs) {
        bs = s;
        best = i;
      }
    }
    if (best !== this.focus) {
      this.focus = best;
    }
    if (best) {
      const label = typeof best.label === 'function' ? best.label() : best.label;
      const verb = typeof best.verb === 'function' ? best.verb() : best.verb;
      this.ui.setFocus(label, verb);
    } else this.ui.setFocus(null);
    if (this.input.consume('interact') && best) {
      audio.click(undefined, 0.08);
      best.onUse();
    }
  }

  /** Touch: tap directly on something to use it. */
  tap(x: number, y: number) {
    if (!this.enabled) return;
    const ndc = new THREE.Vector3((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1, 0.5);
    let best: Interactable | null = null,
      bd = 0.14;
    this.eye.copy(this.camera.position);
    this.dir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    for (const i of this.items) {
      if (i.enabled && !i.enabled()) continue;
      const d = i.pos.distanceTo(this.eye);
      if (d > i.radius * 1.15) continue;
      const p = i.pos.clone().project(this.camera);
      if (p.z > 1) continue;
      const dd = Math.hypot((p.x - ndc.x) * (innerWidth / innerHeight), p.y - ndc.y);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    if (best) {
      audio.click(undefined, 0.08);
      best.onUse();
    }
  }
}

/** A hinged door: animated slab + dynamic collision box. */
export class Door {
  pivot = new THREE.Group();
  angle = 0;
  target = 0;
  open = false;
  locked = false;
  box: Box;
  width: number;
  interact: Interactable;
  private swing: number;
  private baseYaw: number;
  private col: CollisionWorld;
  constructor(
    scene: THREE.Scene,
    collision: CollisionWorld,
    interaction: Interaction,
    opts: { id: string; hinge: THREE.Vector3; yaw: number; w: number; h: number; mat: THREE.Material; swing?: number; label?: string; locked?: boolean; glass?: boolean; onOpen?: () => void; lockedText?: () => void },
  ) {
    this.width = opts.w;
    this.baseYaw = opts.yaw;
    this.col = collision;
    this.swing = opts.swing ?? 1.6;
    this.locked = !!opts.locked;
    this.pivot.position.copy(opts.hinge);
    this.pivot.rotation.y = opts.yaw;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(opts.w - 0.02, opts.h - 0.02, 0.045), opts.mat);
    slab.position.set(opts.w / 2, opts.h / 2, 0);
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.pivot.add(slab);
    // panels / knob
    const trimMat = opts.mat;
    for (const [py, ph] of [
      [opts.h * 0.72, opts.h * 0.3],
      [opts.h * 0.3, opts.h * 0.34],
    ] as [number, number][]) {
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(opts.w * 0.62, ph, 0.012), trimMat);
        p.position.set(opts.w / 2, py, side * 0.03);
        this.pivot.add(p);
      }
    }
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: 0xb09050, metalness: 1, roughness: 0.35 }));
    for (const side of [-1, 1]) {
      const k = knob.clone();
      k.position.set(opts.w - 0.09, 1.0, side * 0.055);
      this.pivot.add(k);
    }
    scene.add(this.pivot);
    this.box = collision.add({ kind: 'box', x: 0, z: 0, hw: opts.w / 2, hd: 0.06, rot: 0, y0: opts.hinge.y, y1: opts.hinge.y + opts.h, walkable: false, dynamic: true, tag: 'door' }) as Box;
    this.syncBox();
    const center = opts.hinge.clone().add(new THREE.Vector3(Math.cos(opts.yaw) * opts.w * 0.5, 1.1, -Math.sin(opts.yaw) * opts.w * 0.5));
    this.interact = interaction.add({
      id: opts.id,
      pos: center,
      radius: 2.4,
      label: opts.label ?? 'Door',
      verb: () => (this.open ? 'Close' : 'Open'),
      cone: 0.5,
      requireSight: false,
      onUse: () => {
        if (this.locked) {
          audio.door('locked', center);
          opts.lockedText?.();
          return;
        }
        this.setOpen(!this.open);
        if (this.open) opts.onOpen?.();
      },
    });
  }

  setOpen(o: boolean, silent = false) {
    this.open = o;
    this.target = o ? this.swing : 0;
    if (!silent) audio.door(o ? 'open' : 'close', this.pivot.position);
  }

  private syncBox() {
    const yaw = this.baseYaw + this.angle;
    const cx = this.pivot.position.x + Math.cos(yaw) * this.width * 0.5;
    const cz = this.pivot.position.z - Math.sin(yaw) * this.width * 0.5;
    this.box.x = cx;
    this.box.z = cz;
    this.box.rot = yaw;
    this.col.updateBox(this.box);
  }

  update(dt: number) {
    const prev = this.angle;
    this.angle = damp(this.angle, this.target, 3.2, dt);
    if (Math.abs(prev - this.angle) > 1e-4) {
      this.pivot.rotation.y = this.baseYaw + this.angle;
      this.syncBox();
      // an open door shouldn't block the player: only collide when mostly closed
      this.box.enabled = this.angle < 0.35;
    }
  }
}
