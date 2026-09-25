// Unified input: keyboard + mouse (pointer lock with drag fallback), gamepad, touch.
import * as THREE from 'three';

export type Action = 'interact' | 'flashlight' | 'pause' | 'journal' | 'jump' | 'back' | 'photo';

const KEYMAP: Record<string, Action> = {
  KeyE: 'interact',
  Enter: 'interact',
  KeyF: 'flashlight',
  Escape: 'pause',
  KeyP: 'photo',
  Tab: 'journal',
  KeyJ: 'journal',
  Space: 'jump',
  Backspace: 'back',
};

export class Input {
  move = new THREE.Vector2();
  look = new THREE.Vector2(); // radians this frame (yaw, pitch)
  sprint = false;
  crouch = false;
  sensitivity = 1;
  invertY = false;
  enabled = true;
  touchMode = false;
  pointerLocked = false;
  lockSupported = true;
  usingGamepad = false;
  private keys = new Set<string>();
  private pressedSet = new Set<Action>();
  private mouseDelta = new THREE.Vector2();
  private dragging = false;
  private el: HTMLElement;
  // touch
  stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0, active: false };
  lookTouch = { id: -1, lx: 0, ly: 0, startT: 0, moved: 0, sx: 0, sy: 0 };
  private touchLook = new THREE.Vector2();
  onTap: ((x: number, y: number) => void) | null = null;
  onStickChange: (() => void) | null = null;
  onFirstGesture: (() => void) | null = null;
  private gestured = false;
  wantsLock = false;

  constructor(el: HTMLElement) {
    this.el = el;
    this.touchMode = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Tab') e.preventDefault();
      if (!this.keys.has(e.code)) {
        const a = KEYMAP[e.code];
        if (a) this.pressedSet.add(a);
      }
      this.keys.add(e.code);
      this.touchMode = false;
      this.gesture();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    el.addEventListener('mousedown', (e) => {
      if (this.touchMode && (e as PointerEvent).pointerType === 'touch') return;
      this.gesture();
      if (!this.enabled) return;
      if (this.wantsLock && !this.pointerLocked && this.lockSupported) this.requestLock();
      if (!this.pointerLocked) this.dragging = true;
      if (e.button === 0 && this.pointerLocked) this.pressedSet.add('interact');
    });
    addEventListener('mouseup', () => (this.dragging = false));
    addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.pointerLocked || this.dragging) {
        // Clamp spikes some browsers produce when re-locking
        const mx = Math.max(-200, Math.min(200, e.movementX));
        const my = Math.max(-200, Math.min(200, e.movementY));
        this.mouseDelta.x += mx;
        this.mouseDelta.y += my;
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === el;
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockSupported = false;
    });

    // Touch
    el.addEventListener('touchstart', (e) => this.onTouch(e, 'start'), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouch(e, 'move'), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouch(e, 'end'), { passive: false });
    el.addEventListener('touchcancel', (e) => this.onTouch(e, 'end'), { passive: false });

    addEventListener('gamepadconnected', () => (this.usingGamepad = true));
  }

  private gesture() {
    if (!this.gestured) {
      this.gestured = true;
      this.onFirstGesture?.();
    }
  }

  requestLock() {
    try {
      const p = (this.el as HTMLElement & { requestPointerLock: (o?: unknown) => Promise<void> | void }).requestPointerLock({
        unadjustedMovement: false,
      });
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => (this.lockSupported = false));
    } catch {
      this.lockSupported = false;
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private onTouch(e: TouchEvent, phase: 'start' | 'move' | 'end') {
    e.preventDefault();
    this.touchMode = true;
    this.gesture();
    if (!this.enabled) {
      this.stick.active = false;
      this.stick.id = -1;
      this.lookTouch.id = -1;
      return;
    }
    const W = innerWidth;
    for (const t of Array.from(e.changedTouches)) {
      if (phase === 'start') {
        if (t.clientX < W * 0.45 && this.stick.id < 0) {
          this.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY, active: true };
          this.onStickChange?.();
        } else if (this.lookTouch.id < 0) {
          this.lookTouch = { id: t.identifier, lx: t.clientX, ly: t.clientY, startT: performance.now(), moved: 0, sx: t.clientX, sy: t.clientY };
        }
      } else if (phase === 'move') {
        if (t.identifier === this.stick.id) {
          this.stick.x = t.clientX;
          this.stick.y = t.clientY;
          // drag the base along if pulled far
          const dx = this.stick.x - this.stick.ox,
            dy = this.stick.y - this.stick.oy;
          const R = this.stickRadius();
          const d = Math.hypot(dx, dy);
          if (d > R * 1.4) {
            this.stick.ox = this.stick.x - (dx / d) * R * 1.4;
            this.stick.oy = this.stick.y - (dy / d) * R * 1.4;
          }
          this.onStickChange?.();
        } else if (t.identifier === this.lookTouch.id) {
          const dx = t.clientX - this.lookTouch.lx,
            dy = t.clientY - this.lookTouch.ly;
          this.touchLook.x += dx;
          this.touchLook.y += dy;
          this.lookTouch.moved += Math.abs(dx) + Math.abs(dy);
          this.lookTouch.lx = t.clientX;
          this.lookTouch.ly = t.clientY;
        }
      } else {
        if (t.identifier === this.stick.id) {
          this.stick.id = -1;
          this.stick.active = false;
          this.onStickChange?.();
        } else if (t.identifier === this.lookTouch.id) {
          const dt = performance.now() - this.lookTouch.startT;
          if (dt < 260 && this.lookTouch.moved < 14) this.onTap?.(t.clientX, t.clientY);
          this.lookTouch.id = -1;
        }
      }
    }
  }

  stickRadius() {
    return Math.max(44, Math.min(innerWidth, innerHeight) * 0.11);
  }

  press(a: Action) {
    this.pressedSet.add(a);
  }

  pressed(a: Action) {
    return this.pressedSet.has(a);
  }

  consume(a: Action) {
    const had = this.pressedSet.has(a);
    this.pressedSet.delete(a);
    return had;
  }

  key(code: string) {
    return this.keys.has(code);
  }

  update(dt: number) {
    const k = this.keys;
    let mx = 0,
      my = 0;
    if (this.enabled) {
      if (k.has('KeyW') || k.has('ArrowUp') || k.has('KeyZ')) my += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;
      if (k.has('KeyA') || k.has('ArrowLeft') || k.has('KeyQ')) mx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    }
    this.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    this.crouch = k.has('ControlLeft') || k.has('KeyC');
    // mouse
    const sens = 0.0022 * this.sensitivity;
    this.look.set(-this.mouseDelta.x * sens, -this.mouseDelta.y * sens * (this.invertY ? -1 : 1));
    this.mouseDelta.set(0, 0);
    // touch
    if (this.stick.active) {
      const R = this.stickRadius();
      const dx = (this.stick.x - this.stick.ox) / R,
        dy = (this.stick.y - this.stick.oy) / R;
      const l = Math.hypot(dx, dy);
      const dz = 0.12;
      const m = l < dz ? 0 : Math.min(1, (l - dz) / (1 - dz));
      if (l > 0) {
        mx += (dx / l) * m;
        my += (-dy / l) * m;
      }
      if (l > 1.15) this.sprint = true;
    }
    if (this.touchLook.lengthSq() > 0) {
      const ts = (2.6 / Math.max(360, Math.min(innerWidth, innerHeight))) * this.sensitivity;
      this.look.x += -this.touchLook.x * ts;
      this.look.y += -this.touchLook.y * ts * (this.invertY ? -1 : 1);
      this.touchLook.set(0, 0);
    }
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      const lx = ax(p.axes[0] ?? 0),
        ly = ax(p.axes[1] ?? 0);
      const rx = ax(p.axes[2] ?? 0),
        ry = ax(p.axes[3] ?? 0);
      if (lx || ly || rx || ry) this.usingGamepad = true;
      mx += lx;
      my += -ly;
      const curve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.6);
      this.look.x += -curve(rx) * 2.6 * dt * this.sensitivity;
      this.look.y += -curve(ry) * 1.9 * dt * this.sensitivity * (this.invertY ? -1 : 1);
      const btn = (i: number) => !!p.buttons[i]?.pressed;
      this.padEdge(0, btn(0), 'interact');
      this.padEdge(1, btn(1), 'back');
      this.padEdge(2, btn(2), 'flashlight');
      this.padEdge(3, btn(3), 'journal');
      this.padEdge(9, btn(9), 'pause');
      if (btn(10) || btn(4) || (p.buttons[6]?.value ?? 0) > 0.4) this.sprint = true;
      if (btn(11) || btn(5)) this.crouch = true;
    }
    const l = Math.hypot(mx, my);
    if (l > 1) {
      mx /= l;
      my /= l;
    }
    if (!this.enabled) {
      mx = 0;
      my = 0;
      this.look.set(0, 0);
    }
    this.move.set(mx, my);
    if (this.forceMove) {
      this.move.copy(this.forceMove);
      this.sprint = this.forceSprint;
    }
  }

  /** Scripted movement (automated tests / cutscenes). */
  forceMove: THREE.Vector2 | null = null;
  forceSprint = false;

  private padPrev: boolean[] = [];
  private padEdge(i: number, down: boolean, a: Action) {
    if (down && !this.padPrev[i]) this.pressedSet.add(a);
    this.padPrev[i] = down;
  }

  endFrame() {
    this.pressedSet.clear();
  }
}
