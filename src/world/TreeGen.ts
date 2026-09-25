// Procedural Pacific-Northwest trees: Douglas fir, western hemlock, wind-shaped
// Sitka spruce, autumn red alder, and dead snags. Each variant is a bark geometry
// plus a foliage-card geometry; foliage textures are painted with Canvas2D.
import * as THREE from 'three';
import { RNG, clamp, lerp, TAU } from '../core/math';

export type TreeKind = 'fir' | 'hemlock' | 'spruce' | 'alder' | 'snag';

export type TreeVariant = {
  kind: TreeKind;
  bark: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry | null;
  height: number;
  radius: number; // crown radius (for impostor framing)
  trunkRadius: number;
};

class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  col: number[] = []; // r = sway weight (0 trunk base .. 1 tips), g = branch flutter, b = ao
  vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, sway: number, flutter: number, ao: number) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(sway, flutter, ao);
    return this.pos.length / 3 - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Tube along a spine with per-point radius. */
function tube(
  g: GeoBuilder,
  spine: THREE.Vector3[],
  radii: number[],
  radial: number,
  height: number,
  uRepeat: number,
  swayAt: (p: THREE.Vector3) => number,
  flare = 0,
) {
  const base = g.pos.length / 3;
  let vAcc = 0;
  for (let i = 0; i < spine.length; i++) {
    const p = spine[i];
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(spine.length - 1, i + 1)];
    _t.subVectors(next, prev).normalize();
    // frame
    const up = Math.abs(_t.y) > 0.95 ? _v.set(1, 0, 0) : _v.set(0, 1, 0);
    _b.crossVectors(_t, up).normalize();
    const nrm = new THREE.Vector3().crossVectors(_b, _t).normalize();
    if (i > 0) vAcc += spine[i].distanceTo(spine[i - 1]);
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * TAU;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      let r = radii[i];
      if (flare > 0 && i < 3) {
        // root buttresses
        const bump = Math.pow(Math.max(0, Math.cos(a * 5 + 0.7)), 3);
        r *= 1 + flare * bump * (1 - i / 3);
      }
      _n.copy(nrm).multiplyScalar(ca).addScaledVector(_b, sa);
      const vp = p.clone().addScaledVector(_n, r);
      g.vertex(vp, _n, (k / radial) * uRepeat, vAcc / 1.6, swayAt(vp), 0, 1);
    }
  }
  const ring = radial + 1;
  for (let i = 0; i < spine.length - 1; i++)
    for (let k = 0; k < radial; k++) {
      const a = base + i * ring + k;
      const b = a + ring;
      g.idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
}

/** A foliage ribbon along a curved spine; returns nothing. */
function ribbon(
  g: GeoBuilder,
  spine: THREE.Vector3[],
  side: THREE.Vector3,
  widths: number[],
  treeCenter: THREE.Vector3,
  height: number,
  flutter: number,
  vFlip = false,
) {
  const base = g.pos.length / 3;
  const cardN = new THREE.Vector3();
  for (let i = 0; i < spine.length; i++) {
    const p = spine[i];
    const tdir = _t.subVectors(spine[Math.min(spine.length - 1, i + 1)], spine[Math.max(0, i - 1)]).normalize();
    cardN.crossVectors(side, tdir).normalize();
    if (cardN.y < 0) cardN.negate();
    for (let s = 0; s < 2; s++) {
      const off = (s - 0.5) * widths[i];
      const vp = p.clone().addScaledVector(side, off);
      // volumetric normal: blend card normal with outward direction from the crown axis
      const out = _v.set(vp.x - treeCenter.x, (vp.y - treeCenter.y) * 0.35 + height * 0.08, vp.z - treeCenter.z).normalize();
      const n = cardN.clone().multiplyScalar(0.35).addScaledVector(out, 0.75).normalize();
      const sway = clamp(vp.y / height, 0, 1);
      const v = i / (spine.length - 1);
      g.vertex(vp, n, s, vFlip ? 1 - v : v, sway * sway, flutter * (0.3 + 0.7 * v), 0.55 + 0.45 * clamp((vp.y / height) * 1.2, 0, 1));
    }
  }
  for (let i = 0; i < spine.length - 1; i++) {
    const a = base + i * 2;
    g.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

function branchSpine(start: THREE.Vector3, dir: THREE.Vector3, len: number, droop: number, segs = 3) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(start.x + dir.x * len * t, start.y + dir.y * len * t - droop * len * t * t, start.z + dir.z * len * t));
  }
  return pts;
}

function trunkSpine(h: number, lean: THREE.Vector2, wobble: number, rng: RNG, segs: number) {
  const pts: THREE.Vector3[] = [];
  const ph = rng.range(0, TAU);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * h;
    pts.push(
      new THREE.Vector3(
        lean.x * t * t * h + Math.sin(t * 7 + ph) * wobble * t,
        y,
        lean.y * t * t * h + Math.cos(t * 5 + ph) * wobble * t,
      ),
    );
  }
  return pts;
}

function sampleSpine(spine: THREE.Vector3[], y: number) {
  for (let i = 1; i < spine.length; i++) {
    if (spine[i].y >= y) {
      const a = spine[i - 1],
        b = spine[i];
      const t = (y - a.y) / Math.max(1e-4, b.y - a.y);
      return a.clone().lerp(b, t);
    }
  }
  return spine[spine.length - 1].clone();
}

// ------------------------------------------------------------------ conifers
type ConiferParams = {
  height: number;
  baseRadius: number;
  crownBase: number; // fraction of height where live crown begins
  maxBranch: number; // longest branch length
  whorlStep: number;
  perWhorl: [number, number];
  upSlope: [number, number]; // bottom, top
  droop: [number, number];
  widthK: number;
  profilePow: number;
  flag?: THREE.Vector2; // windswept direction
  leaderDroop?: number;
  crossCards: boolean;
};

function buildConifer(kind: TreeKind, P: ConiferParams, seed: number): TreeVariant {
  const rng = new RNG(seed);
  const bark = new GeoBuilder();
  const fol = new GeoBuilder();
  const H = P.height;
  const lean = new THREE.Vector2(rng.range(-0.02, 0.02), rng.range(-0.02, 0.02));
  const spine = trunkSpine(H, lean, 0.12, rng, 14);
  const radii = spine.map((p, i) => {
    const t = p.y / H;
    return lerp(P.baseRadius, 0.025, Math.pow(t, 0.85)) * (i === 0 ? 1.25 : 1);
  });
  tube(bark, spine, radii, 9, H, 3, (p) => clamp(p.y / H, 0, 1) ** 2, 0.35);

  const center = new THREE.Vector3(0, H * 0.5, 0);
  let crownR = 0;
  // Dead lower stubs
  for (let y = 2.5; y < H * P.crownBase; y += rng.range(0.35, 0.8)) {
    const s = sampleSpine(spine, y);
    const a = rng.range(0, TAU);
    const d = new THREE.Vector3(Math.cos(a), rng.range(-0.3, 0.1), Math.sin(a)).normalize();
    const len = rng.range(0.3, 1.4) * (1 - y / H);
    const sp = branchSpine(s, d, len, 0.1, 1);
    tube(bark, sp, [0.03, 0.008], 3, H, 1, (p) => clamp(p.y / H, 0, 1) ** 2);
  }
  // Live crown whorls
  for (let y = H * P.crownBase; y < H - 0.3; y += P.whorlStep * rng.range(0.75, 1.25)) {
    const t = (y - H * P.crownBase) / (H * (1 - P.crownBase)); // 0 bottom of crown -> 1 top
    const prof = Math.pow(1 - t, P.profilePow) * (0.85 + 0.3 * rng.next());
    const n = rng.int(P.perWhorl[0], P.perWhorl[1]);
    const a0 = rng.range(0, TAU);
    const s = sampleSpine(spine, y);
    for (let k = 0; k < n; k++) {
      if (rng.chance(0.08)) continue; // gaps make it look natural
      const a = a0 + (k / n) * TAU + rng.range(-0.35, 0.35);
      let len = Math.max(0.35, P.maxBranch * prof + rng.range(-0.25, 0.25));
      if (P.flag) {
        const fd = Math.cos(a) * P.flag.x + Math.sin(a) * P.flag.y;
        len *= 0.55 + 0.6 * clamp(fd * 0.5 + 0.5, 0, 1);
      }
      const slope = lerp(P.upSlope[0], P.upSlope[1], t) + rng.range(-0.1, 0.1);
      const dir = new THREE.Vector3(Math.cos(a), slope, Math.sin(a)).normalize();
      const droop = lerp(P.droop[0], P.droop[1], t) * rng.range(0.7, 1.3);
      const sp = branchSpine(s, dir, len, droop, 3);
      crownR = Math.max(crownR, Math.hypot(sp[3].x, sp[3].z));
      const wBase = len * P.widthK;
      const widths = [wBase * 0.35, wBase * 0.95, wBase * 0.85, wBase * 0.35];
      const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      side.y = rng.range(-0.25, 0.25);
      side.normalize();
      ribbon(fol, sp, side, widths, center, H, 1);
      if (P.crossCards) {
        const side2 = new THREE.Vector3().crossVectors(dir, side).normalize();
        ribbon(fol, sp, side2, widths.map((w) => w * 0.7), center, H, 1, true);
      }
      // woody branch core near trunk
      if (len > 1.2) tube(bark, [sp[0], sp[1]], [0.05 * len * 0.5 + 0.02, 0.02], 3, H, 1, (p) => clamp(p.y / H, 0, 1) ** 2);
    }
  }
  // Leader / top tuft
  const top = spine[spine.length - 1];
  const leadDir = new THREE.Vector3(P.leaderDroop ?? 0, 1, 0).normalize();
  const lead = branchSpine(top.clone().add(new THREE.Vector3(0, -0.6, 0)), leadDir, 1.4, P.leaderDroop ? 0.6 : 0.05, 3);
  ribbon(fol, lead, new THREE.Vector3(1, 0, 0), [0.25, 0.5, 0.35, 0.12], center, H, 1);
  ribbon(fol, lead, new THREE.Vector3(0, 0, 1), [0.25, 0.5, 0.35, 0.12], center, H, 1);

  return { kind, bark: bark.build(), foliage: fol.build(), height: H + 1, radius: Math.max(crownR, 2), trunkRadius: P.baseRadius };
}

// ------------------------------------------------------------------ alder
function buildAlder(seed: number): TreeVariant {
  const rng = new RNG(seed);
  const bark = new GeoBuilder();
  const fol = new GeoBuilder();
  const H = 15;
  const spine = trunkSpine(H * 0.55, new THREE.Vector2(rng.range(-0.05, 0.05), rng.range(-0.05, 0.05)), 0.25, rng, 8);
  tube(bark, spine, spine.map((p) => lerp(0.26, 0.14, p.y / (H * 0.55))), 8, H, 2, (p) => clamp(p.y / H, 0, 1) ** 2, 0.2);
  const center = new THREE.Vector3(0, H * 0.62, 0);
  let crownR = 0;
  const addLeaves = (at: THREE.Vector3, size: number) => {
    for (let i = 0; i < 3; i++) {
      const a = rng.range(0, TAU);
      const side = new THREE.Vector3(Math.cos(a), rng.range(-0.4, 0.4), Math.sin(a)).normalize();
      const up = new THREE.Vector3(rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)).normalize();
      const sp = [at.clone().addScaledVector(up, -size * 0.5), at.clone(), at.clone().addScaledVector(up, size * 0.5)];
      ribbon(fol, sp, side, [size * 0.9, size, size * 0.9], center, H, 1.5);
      crownR = Math.max(crownR, Math.hypot(at.x, at.z) + size * 0.5);
    }
  };
  const grow = (start: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const end = start.clone().addScaledVector(dir, len);
    const mid = start.clone().lerp(end, 0.5).add(new THREE.Vector3(rng.range(-0.2, 0.2), rng.range(-0.1, 0.2), rng.range(-0.2, 0.2)));
    tube(bark, [start, mid, end], [r, r * 0.8, r * 0.6], depth > 1 ? 6 : 4, H, 1, (p) => clamp(p.y / H, 0, 1) ** 2);
    if (depth === 0) {
      addLeaves(end, rng.range(1.6, 2.4));
      return;
    }
    const kids = rng.int(2, 3);
    for (let i = 0; i < kids; i++) {
      const nd = dir
        .clone()
        .add(new THREE.Vector3(rng.range(-0.8, 0.8), rng.range(-0.05, 0.5), rng.range(-0.8, 0.8)))
        .normalize();
      grow(end, nd, len * rng.range(0.6, 0.78), r * 0.62, depth - 1);
    }
    if (depth <= 1) addLeaves(mid, rng.range(1.2, 1.8));
  };
  const top = spine[spine.length - 1];
  const limbs = rng.int(3, 4);
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * TAU + rng.range(-0.4, 0.4);
    const d = new THREE.Vector3(Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55).normalize();
    grow(top, d, rng.range(3, 4.2), 0.13, 3);
  }
  return { kind: 'alder', bark: bark.build(), foliage: fol.build(), height: H + 2, radius: Math.max(crownR, 3), trunkRadius: 0.26 };
}

function buildSnag(seed: number): TreeVariant {
  const rng = new RNG(seed);
  const bark = new GeoBuilder();
  const H = rng.range(10, 16);
  const spine = trunkSpine(H, new THREE.Vector2(rng.range(-0.06, 0.06), rng.range(-0.06, 0.06)), 0.2, rng, 10);
  tube(bark, spine, spine.map((p) => lerp(0.42, 0.12, Math.pow(p.y / H, 0.7))), 8, H, 2, (p) => clamp(p.y / H, 0, 1) ** 2, 0.3);
  for (let y = 3; y < H - 0.5; y += rng.range(0.6, 1.4)) {
    const s = sampleSpine(spine, y);
    const a = rng.range(0, TAU);
    const d = new THREE.Vector3(Math.cos(a), rng.range(-0.4, 0.2), Math.sin(a)).normalize();
    const sp = branchSpine(s, d, rng.range(0.4, 2.2) * (1 - y / H * 0.6), 0.2, 2);
    tube(bark, sp, [0.045, 0.03, 0.01], 3, H, 1, (p) => clamp(p.y / H, 0, 1) ** 2);
  }
  return { kind: 'snag', bark: bark.build(), foliage: null, height: H + 1, radius: 2.5, trunkRadius: 0.42 };
}

export function buildTreeVariants(): TreeVariant[] {
  const fir = (seed: number, h: number) =>
    buildConifer(
      'fir',
      {
        height: h,
        baseRadius: 0.42 * (h / 26),
        crownBase: 0.26,
        maxBranch: 4.4 * (h / 26),
        whorlStep: 0.5,
        perWhorl: [5, 7],
        upSlope: [-0.35, 0.35],
        droop: [0.32, 0.08],
        widthK: 0.8,
        profilePow: 0.8,
        crossCards: true,
      },
      seed,
    );
  const hemlock = (seed: number, h: number) =>
    buildConifer(
      'hemlock',
      {
        height: h,
        baseRadius: 0.36 * (h / 22),
        crownBase: 0.16,
        maxBranch: 3.9 * (h / 22),
        whorlStep: 0.42,
        perWhorl: [5, 7],
        upSlope: [-0.25, 0.2],
        droop: [0.45, 0.22],
        widthK: 0.85,
        profilePow: 0.9,
        leaderDroop: 0.7,
        crossCards: true,
      },
      seed,
    );
  const spruce = (seed: number, h: number) =>
    buildConifer(
      'spruce',
      {
        height: h,
        baseRadius: 0.4 * (h / 16),
        crownBase: 0.12,
        maxBranch: 3.4 * (h / 16),
        whorlStep: 0.4,
        perWhorl: [6, 8],
        upSlope: [-0.15, 0.45],
        droop: [0.18, 0.05],
        widthK: 0.6,
        profilePow: 0.75,
        flag: new THREE.Vector2(0.55, -0.83),
        crossCards: true,
      },
      seed,
    );
  return [fir(11, 27), fir(23, 21), hemlock(37, 22), spruce(41, 15), buildAlder(53), buildSnag(67)];
}

// ------------------------------------------------------------------ textures
function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Conifer spray: a stem with side twigs covered in needles. u across, v along (0 at trunk). */
export function paintNeedleTexture(kind: 'fir' | 'hemlock' | 'spruce', seed: number): THREE.Texture {
  const W = 256,
    H = 512;
  const c = canvas(W, H);
  const ctx = c.getContext('2d')!;
  const rng = new RNG(seed);
  ctx.clearRect(0, 0, W, H);
  const pal =
    kind === 'fir'
      ? ['#1c2e17', '#23381b', '#2c4520', '#3a5527', '#4d6a30']
      : kind === 'hemlock'
        ? ['#1a2d18', '#20391d', '#2a4723', '#35562b', '#46693a']
        : ['#1d2f22', '#233a29', '#2c4633', '#39573d', '#4a6a4a'];
  const needleLen = kind === 'hemlock' ? 7 : kind === 'spruce' ? 8 : 10;
  const drawTwig = (x0: number, y0: number, ang: number, len: number, depth: number) => {
    const x1 = x0 + Math.cos(ang) * len,
      y1 = y0 + Math.sin(ang) * len;
    ctx.strokeStyle = depth === 0 ? '#3b2a1c' : '#4a3a26';
    ctx.lineWidth = depth === 0 ? 3 : 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // needles along the twig
    const count = Math.floor(len / 2.2);
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const px = x0 + (x1 - x0) * t,
        py = y0 + (y1 - y0) * t;
      for (const side of [-1, 1]) {
        const na = ang + side * (0.9 + rng.range(-0.25, 0.25)) + (t - 0.5) * 0.2;
        const nl = needleLen * (0.7 + 0.5 * rng.next()) * (1 - t * 0.3);
        const shade = pal[Math.min(pal.length - 1, Math.floor(rng.next() * 3 + t * 2.4))];
        ctx.strokeStyle = shade;
        ctx.lineWidth = kind === 'hemlock' ? 1.6 : 1.9;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
        ctx.stroke();
      }
    }
    if (depth < 1) {
      const n = Math.floor(len / 26);
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        const px = x0 + (x1 - x0) * t,
          py = y0 + (y1 - y0) * t;
        const side = i % 2 ? 1 : -1;
        const sl = (1 - t) * W * 0.42 * rng.range(0.7, 1.1) + 18;
        drawTwig(px, py, ang + side * rng.range(0.55, 0.85), sl, depth + 1);
      }
    }
  };
  // several parallel sprays so the card reads as a dense branch
  for (let s = 0; s < 3; s++) {
    const x = W * (0.3 + s * 0.2) + rng.range(-8, 8);
    drawTwig(x, H * 0.02, Math.PI / 2 + rng.range(-0.08, 0.08), H * 0.95, 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Autumn leaf cluster for alders/maples. */
export function paintLeafTexture(seed: number): THREE.Texture {
  const W = 256,
    H = 256;
  const c = canvas(W, H);
  const ctx = c.getContext('2d')!;
  const rng = new RNG(seed);
  const cols = ['#8a6a1c', '#a8801f', '#c49a2a', '#b56d1e', '#7a7a2a', '#5f6d25', '#d0a13a', '#9c4f1a'];
  ctx.strokeStyle = '#4a3a28';
  ctx.lineWidth = 2;
  for (let i = 0; i < 70; i++) {
    const x = W / 2 + rng.gauss() * W * 0.2,
      y = H / 2 + rng.gauss() * H * 0.2;
    const r = rng.range(9, 18);
    const a = rng.range(0, TAU);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = cols[rng.int(0, cols.length - 1)];
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.quadraticCurveTo(r * 0.75, -r * 0.2, 0, r);
    ctx.quadraticCurveTo(-r * 0.75, -r * 0.2, 0, -r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,20,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(0, r);
    ctx.stroke();
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
