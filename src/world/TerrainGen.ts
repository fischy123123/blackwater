// Heightfield authoring for Blackwater Bay.
// Pure TypeScript (no DOM / three.js) so it can run anywhere.
//
// Produces:
//  - height: Float32Array res*res (metres)
//  - surface: Uint8Array res*res*4
//      R = forest density, G = road/dirt mask, B = meadow/lawn, A = wet (standing water depth*64)
//  - water: Float32Array res*res — standing water level (or -1000 if none)

import {
  Noise,
  RNG,
  clamp,
  lerp,
  saturate,
  smoothstep,
  sdPolygon,
  sampleCatmull,
  type V2,
  type V3,
} from '../core/math';
import { WORLD, COASTLINE, CLIFF_CENTERS, ROADS, RIVER, PADS, P, TRAIL } from './Layout';

export type TerrainData = {
  res: number;
  minX: number;
  minZ: number;
  size: number;
  cell: number;
  height: Float32Array;
  surface: Uint8Array;
  water: Float32Array;
  roadSamples: { id: string; pts: V3[]; width: number; shoulder: number; lines: boolean }[];
  riverSamples: V3[];
};

const LAND_POLY: V2[] = [...COASTLINE, { x: 14000, z: -14000 }, { x: -14000, z: -14000 }];

export function coastSDF(x: number, z: number) {
  // Positive at sea, negative inland.
  return sdPolygon(x, z, LAND_POLY);
}

/** Smooth cliff weight near the headlands. */
function cliffWeight(x: number, z: number, n: Noise) {
  let w = 0;
  let h = 0;
  for (const c of CLIFF_CENTERS) {
    const d = Math.hypot(x - c.x, z - c.z);
    const k = 1 - smoothstep(c.r * 0.55, c.r, d);
    if (k > w) {
      w = k;
      h = c.h;
    }
  }
  // Slightly irregular cliff edges.
  w *= 0.75 + 0.25 * smoothstep(-0.4, 0.3, n.fbm2(x * 0.01, z * 0.01, 3));
  return { w: saturate(w), h };
}

/** The unmodified landform (no roads, rivers or pads). Also used for the far-field ring. */
export function naturalHeight(x: number, z: number, sd: number, n: Noise, n2: Noise): number {
  const warp = n.fbm2(x * 0.0021, z * 0.0021, 4);
  let h: number;
  if (sd > 0) {
    // Seabed: gentle flats that fall away toward the open sea.
    const d = sd;
    h = -0.4 - d * 0.0115 - d * d * 0.0000075;
    if (d > 1400) h = Math.min(h, -40 - (d - 1400) * 0.02);
    h += n.fbm2(x * 0.004, z * 0.006, 4) * 1.1 * smoothstep(20, 160, d);
    h += n2.fbm2(x * 0.03, z * 0.05, 2) * 0.18;
    const cw = cliffWeight(x, z, n);
    const reef = smoothstep(0.35, 0.8, n.ridged2(x * 0.012, z * 0.012, 4)) * cw.w;
    h += reef * 3.2 * (1 - smoothstep(40, 220, d));
  } else {
    const s = -sd;
    let base = 1.4 + Math.min(s, 250) * 0.088;
    if (s > 250) base += (s - 250) * 0.19;
    const valleyCenter = -60 - (z + 200) * 0.18;
    const side = Math.abs(x - valleyCenter);
    base += smoothstep(260, 820, side) * 170 * smoothstep(-500, 200, -z + 400);
    base += smoothstep(380, 900, side) * 60;
    const mEnv = smoothstep(120, 700, s);
    const wx = x + warp * 180,
      wz = z - warp * 140;
    const ridge = n.ridged2(wx * 0.0014 + 3.1, wz * 0.0014 - 1.7, 5);
    const ridge2 = n2.ridged2(wx * 0.0032 - 5.3, wz * 0.0032 + 2.2, 4);
    base += (ridge * 175 + ridge2 * 38) * mEnv * smoothstep(120, 600, side + (s - 400) * 0.6);
    // Far ranges: big ridges beyond the valley
    const far = smoothstep(1400, 4000, Math.hypot(x, z + 400));
    base += far * (n.ridged2(x * 0.0007 + 9.1, z * 0.0007 + 4.4, 4) * 520 + 80) * smoothstep(40, 600, s);
    const townK = 1 - smoothstep(150, 270, Math.hypot((x - 20) * 0.9, (z - 60) * 1.1));
    base += warp * 26 * smoothstep(40, 300, s) * (1 - townK * 0.92);
    base += n.fbm2(x * 0.012, z * 0.012, 4) * 4.5 * smoothstep(10, 120, s) * (1 - townK * 0.75);
    base = lerp(0.6 + s * 0.06, base, smoothstep(0, 35, s));
    const cw = cliffWeight(x, z, n);
    if (cw.w > 0) {
      const plateau = cw.h + n.fbm2(x * 0.008, z * 0.008, 3) * 5 + s * 0.02;
      const edge = Math.pow(smoothstep(0, 22, s), 0.55);
      const cliffH = lerp(0.2, plateau, edge);
      base = lerp(base, Math.max(cliffH, base * 0.6 + cliffH * 0.4), cw.w);
    }
    h = base;
  }
  return h;
}

export const TERRAIN_SEEDS = { a: 20241017, b: 777 };

/** Droplet hydraulic erosion on a (lower-res) copy of the heightfield. */
function erode(h: Float32Array, res: number, cell: number, mask: Float32Array, droplets: number, seed: number) {
  const rng = new RNG(seed);
  const inertia = 0.05,
    capacityK = 4,
    minCap = 0.01,
    erodeK = 0.3,
    depositK = 0.3,
    evaporate = 0.02,
    gravity = 4,
    life = 34,
    radius = 2;
  // brush
  const bOff: number[] = [];
  const bW: number[] = [];
  let wsum = 0;
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= radius) {
        const w = 1 - d / radius;
        bOff.push(dy * res + dx);
        bW.push(w);
        wsum += w;
      }
    }
  for (let i = 0; i < bW.length; i++) bW[i] /= wsum;
  const hg = (px: number, pz: number) => {
    const ix = Math.floor(px),
      iz = Math.floor(pz);
    const u = px - ix,
      v = pz - iz;
    const i0 = iz * res + ix;
    const a = h[i0],
      b = h[i0 + 1],
      c = h[i0 + res],
      d = h[i0 + res + 1];
    return {
      h: a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v,
      gx: (b - a) * (1 - v) + (d - c) * v,
      gz: (c - a) * (1 - u) + (d - b) * u,
    };
  };
  for (let n = 0; n < droplets; n++) {
    let px = rng.range(2, res - 3),
      pz = rng.range(2, res - 3);
    if (mask[Math.floor(pz) * res + Math.floor(px)] < 0.05) continue;
    let dx = 0,
      dz = 0,
      speed = 1,
      water = 1,
      sed = 0;
    for (let step = 0; step < life; step++) {
      const ix = Math.floor(px),
        iz = Math.floor(pz);
      const node = iz * res + ix;
      const u = px - ix,
        v = pz - iz;
      const g = hg(px, pz);
      dx = dx * inertia - g.gx * (1 - inertia);
      dz = dz * inertia - g.gz * (1 - inertia);
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) break;
      dx /= len;
      dz /= len;
      px += dx;
      pz += dz;
      if (px < 2 || pz < 2 || px > res - 3 || pz > res - 3) break;
      const m = mask[node];
      const nh = hg(px, pz).h;
      const dh = nh - g.h;
      const cap = Math.max(-dh * speed * water * capacityK, minCap);
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depositK;
        sed -= amt;
        h[node] += amt * (1 - u) * (1 - v);
        h[node + 1] += amt * u * (1 - v);
        h[node + res] += amt * (1 - u) * v;
        h[node + res + 1] += amt * u * v;
      } else {
        const amt = Math.min((cap - sed) * erodeK, -dh) * m;
        for (let k = 0; k < bOff.length; k++) {
          const ni = node + bOff[k];
          const e = amt * bW[k];
          h[ni] -= e;
        }
        sed += amt;
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * gravity / cell));
      water *= 1 - evaporate;
    }
  }
}

/** Keep the overlook's line of sight to the bay open. */
function viewCorridor(x: number, z: number, h: number) {
  const ox = P.overlook.x,
    oz = P.overlook.z;
  const dx = x - ox,
    dz = z - oz;
  const d = Math.hypot(dx, dz);
  if (d < 8 || d > 900) return h;
  const dirX = 0.18,
    dirZ = 0.98; // toward the bay
  const cos = (dx * dirX + dz * dirZ) / d;
  const k = smoothstep(0.55, 0.8, cos) * smoothstep(8, 16, d);
  if (k <= 0) return h;
  const oy = P.overlook.y - 0.5;
  const cap = Math.max(oy - 2 - d * 0.35, oy - 14 - d * 0.1);
  return h > cap ? lerp(h, cap + (h - cap) * 0.15, k) : h;
}

export function generateTerrain(onProgress?: (p: number) => void): TerrainData {
  const { res, minX, minZ, size } = WORLD;
  const cell = size / (res - 1);
  const N = res * res;
  const height = new Float32Array(N);
  const surface = new Uint8Array(N * 4);
  const water = new Float32Array(N).fill(-1000);
  const n = new Noise(TERRAIN_SEEDS.a);
  const n2 = new Noise(TERRAIN_SEEDS.b);

  // Precompute coast distance on a coarse grid (it's the expensive bit) and bilinear upsample.
  const cr = 257;
  const coarse = new Float32Array(cr * cr);
  for (let j = 0; j < cr; j++) {
    for (let i = 0; i < cr; i++) {
      const x = minX + (i / (cr - 1)) * size;
      const z = minZ + (j / (cr - 1)) * size;
      coarse[j * cr + i] = coastSDF(x, z);
    }
  }
  const coastAt = (x: number, z: number) => {
    const fx = ((x - minX) / size) * (cr - 1);
    const fz = ((z - minZ) / size) * (cr - 1);
    const i0 = clamp(Math.floor(fx), 0, cr - 2);
    const j0 = clamp(Math.floor(fz), 0, cr - 2);
    const tx = fx - i0,
      tz = fz - j0;
    const a = coarse[j0 * cr + i0],
      b = coarse[j0 * cr + i0 + 1],
      c = coarse[(j0 + 1) * cr + i0],
      d = coarse[(j0 + 1) * cr + i0 + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  };

  // --- 1. Natural landform -------------------------------------------------
  for (let j = 0; j < res; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < res; i++) {
      const x = minX + i * cell;
      height[j * res + i] = naturalHeight(x, z, coastAt(x, z), n, n2);
    }
    if (onProgress && (j & 63) === 0) onProgress(0.35 * (j / res));
  }

  // Erosion at half resolution on the mountains, applied as a delta.
  {
    const er = (res >> 1) + 1;
    const lo = new Float32Array(er * er);
    const mask = new Float32Array(er * er);
    for (let j = 0; j < er; j++)
      for (let i = 0; i < er; i++) {
        const hh = height[Math.min(res - 1, j * 2) * res + Math.min(res - 1, i * 2)];
        lo[j * er + i] = hh;
        const x = minX + i * 2 * cell,
          z = minZ + j * 2 * cell;
        const town = 1 - smoothstep(180, 260, Math.hypot(x - 20, (z - 60) * 1.2));
        mask[j * er + i] = smoothstep(14, 45, hh) * (1 - town);
      }
    const before = lo.slice();
    erode(lo, er, cell * 2, mask, 60000, 4242);
    // apply delta with bilinear upsampling
    for (let j = 0; j < res; j++)
      for (let i = 0; i < res; i++) {
        const fx = i / 2,
          fz = j / 2;
        const i0 = Math.min(er - 2, Math.floor(fx)),
          j0 = Math.min(er - 2, Math.floor(fz));
        const u = fx - i0,
          v = fz - j0;
        const k = j0 * er + i0;
        const d =
          (lo[k] - before[k]) * (1 - u) * (1 - v) +
          (lo[k + 1] - before[k + 1]) * u * (1 - v) +
          (lo[k + er] - before[k + er]) * (1 - u) * v +
          (lo[k + er + 1] - before[k + er + 1]) * u * v;
        height[j * res + i] += d;
      }
  }
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) {
      const idx = j * res + i;
      height[idx] = viewCorridor(minX + i * cell, minZ + j * cell, height[idx]);
    }
  onProgress?.(0.38);

  // Seamless transition across the waterline: blur a narrow band.
  // (cheap separable blur restricted to |sd| < 30)
  {
    const tmp = new Float32Array(height);
    for (let j = 1; j < res - 1; j++) {
      for (let i = 1; i < res - 1; i++) {
        const x = minX + i * cell,
          z = minZ + j * cell;
        const sd = coastAt(x, z);
        if (Math.abs(sd) > 30) continue;
        const idx = j * res + i;
        const avg =
          (tmp[idx] * 4 + tmp[idx - 1] + tmp[idx + 1] + tmp[idx - res] + tmp[idx + res]) / 8;
        height[idx] = lerp(avg, tmp[idx], smoothstep(0, 30, Math.abs(sd)));
      }
    }
  }
  onProgress?.(0.4);

  // --- 2. River / tidal channel carving -----------------------------------
  const riverSamples = sampleCatmull(RIVER, 3);
  {
    const best = new Float32Array(N).fill(1e9);
    const bedY = new Float32Array(N);
    const halfW = (k: number) => {
      const z = riverSamples[k].z;
      if (z < -380) return 5 + (z + 830) * 0.004; // mountain stream
      if (z < -300) return 7;
      if (z < 210) return 9 + (z + 300) * 0.01;
      return 16 + Math.min(22, (z - 210) * 0.03); // tidal channel widens on the flats
    };
    for (let k = 0; k < riverSamples.length - 1; k++) {
      const a = riverSamples[k],
        b = riverSamples[k + 1];
      const w = halfW(k) * 3.5 + 20;
      const x0 = Math.min(a.x, b.x) - w,
        x1 = Math.max(a.x, b.x) + w;
      const z0 = Math.min(a.z, b.z) - w,
        z1 = Math.max(a.z, b.z) + w;
      const i0 = clamp(Math.floor((x0 - minX) / cell), 0, res - 1);
      const i1 = clamp(Math.ceil((x1 - minX) / cell), 0, res - 1);
      const j0 = clamp(Math.floor((z0 - minZ) / cell), 0, res - 1);
      const j1 = clamp(Math.ceil((z1 - minZ) / cell), 0, res - 1);
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = minX + i * cell,
            z = minZ + j * cell;
          let t = ((x - a.x) * dx + (z - a.z) * dz) / l2;
          t = saturate(t);
          const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
          const nd = d / halfW(k);
          const idx = j * res + i;
          if (nd < best[idx]) {
            best[idx] = nd;
            bedY[idx] = lerp(a.y, b.y, t);
          }
        }
      }
    }
    for (let idx = 0; idx < N; idx++) {
      const nd = best[idx];
      if (nd > 5) continue;
      const i = idx % res,
        j = (idx / res) | 0;
      const x = minX + i * cell,
        z = minZ + j * cell;
      const onFlats = z > 205;
      // Channel cross-section: flat-ish bed, steep banks, then blend to terrain.
      const bank = onFlats ? 1.35 : 1.0;
      const bed = bedY[idx] + (onFlats ? 0 : n.fbm2(x * 0.08, z * 0.08, 2) * 0.35);
      const prof = smoothstep(0.55, bank, nd); // 0 at centre -> 1 at bank top
      const carved = lerp(bed, height[idx], prof);
      // Gorge: in the steep section, force steep walls.
      const gorge = z > -430 && z < -330 ? 1 : 0;
      const outer = smoothstep(bank, gorge ? 1.8 : 4.5, nd);
      const target = Math.min(height[idx], lerp(carved, height[idx], outer));
      height[idx] = target;
      // Standing water on the flats channel; flowing water handled by the river mesh.
      if (onFlats && nd < 1.05) {
        const wl = bedY[idx] + 0.9;
        if (wl > height[idx]) water[idx] = Math.max(water[idx], wl);
      }
    }
  }
  onProgress?.(0.5);

  // --- 3. Tide pools and shallow pans on the flats -----------------------
  // Large shallow pans (sheets of water that mirror the sky) in broad low areas,
  // plus scattered pools near the rocky shore.
  for (let j = 0; j < res; j++) {
    const z = minZ + j * cell;
    if (z < 205) continue;
    for (let i = 0; i < res; i++) {
      const x = minX + i * cell;
      const idx = j * res + i;
      const sd = coastAt(x, z);
      if (sd < 6) continue;
      const shoreFade = smoothstep(6, 30, sd);
      // Broad pans
      const pan = n2.fbm2(x * 0.0045 + 3.3, z * 0.006 - 1.2, 4);
      let depth = smoothstep(0.18, 0.42, pan) * 0.42;
      // Scattered pools, clustered near the headlands and in the upper bay
      const cluster = smoothstep(0.0, 0.5, n.fbm2(x * 0.004 - 7, z * 0.004 + 2, 2));
      const pool = smoothstep(0.3, 0.52, n2.fbm2(x * 0.03 + 11, z * 0.03 - 4, 3)) * cluster;
      depth = Math.max(depth, pool * 0.5) * shoreFade;
      if (depth > 0.01) {
        const rim = height[idx];
        height[idx] -= depth;
        const level = rim - 0.04;
        if (level > height[idx] + 0.015) water[idx] = Math.max(water[idx], level);
      }
    }
  }

  // --- 4. Pads (building lots, yards, overlook) ----------------------------
  for (const p of PADS) {
    if (Number.isNaN(p.y)) {
      // balance cut and fill: mean height over the footprint
      const cr = Math.cos(p.rot),
        sr = Math.sin(p.rot);
      let sum = 0,
        n = 0;
      for (let a = -2; a <= 2; a++)
        for (let b = -2; b <= 2; b++) {
          const lx = (a / 2) * p.w * 0.5,
            lz = (b / 2) * p.d * 0.5;
          const wx = p.x + lx * cr - lz * sr,
            wz = p.z + lx * sr + lz * cr;
          const ci = clamp(Math.round((wx - minX) / cell), 0, res - 1);
          const cj = clamp(Math.round((wz - minZ) / cell), 0, res - 1);
          sum += height[cj * res + ci];
          n++;
        }
      p.y = sum / n + 0.35;
    }
    const c = Math.cos(p.rot),
      s = Math.sin(p.rot);
    const R = Math.hypot(p.w, p.d) * 0.5 + p.blend + 4;
    const i0 = clamp(Math.floor((p.x - R - minX) / cell), 0, res - 1);
    const i1 = clamp(Math.ceil((p.x + R - minX) / cell), 0, res - 1);
    const j0 = clamp(Math.floor((p.z - R - minZ) / cell), 0, res - 1);
    const j1 = clamp(Math.ceil((p.z + R - minZ) / cell), 0, res - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = minX + i * cell - p.x,
          z = minZ + j * cell - p.z;
        const lx = x * c + z * s,
          lz = -x * s + z * c;
        const qx = Math.max(Math.abs(lx) - p.w * 0.5, 0);
        const qz = Math.max(Math.abs(lz) - p.d * 0.5, 0);
        const d = Math.hypot(qx, qz);
        const k = 1 - smoothstep(0, p.blend, d);
        if (k <= 0) continue;
        const idx = j * res + i;
        height[idx] = lerp(height[idx], p.y, k);
        // Pads are lawn/dirt
        surface[idx * 4 + 2] = Math.max(surface[idx * 4 + 2], (k * 255) | 0);
      }
    }
  }
  onProgress?.(0.6);

  // --- 5. Roads: carve cut & fill, write road mask -------------------------
  const roadSamples: TerrainData['roadSamples'] = [];
  for (const r of ROADS) {
    const pts = sampleCatmull(r.pts, 2);
    roadSamples.push({ id: r.id, pts, width: r.width, shoulder: r.shoulder, lines: r.lines });
    const best = new Float32Array(N).fill(1e9);
    const ry = new Float32Array(N);
    const half = r.width * 0.5 + r.shoulder;
    const reach = half + 16;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k],
        b = pts[k + 1];
      const x0 = Math.min(a.x, b.x) - reach,
        x1 = Math.max(a.x, b.x) + reach;
      const z0 = Math.min(a.z, b.z) - reach,
        z1 = Math.max(a.z, b.z) + reach;
      const i0 = clamp(Math.floor((x0 - minX) / cell), 0, res - 1);
      const i1 = clamp(Math.ceil((x1 - minX) / cell), 0, res - 1);
      const j0 = clamp(Math.floor((z0 - minZ) / cell), 0, res - 1);
      const j1 = clamp(Math.ceil((z1 - minZ) / cell), 0, res - 1);
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const l2 = dx * dx + dz * dz || 1;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = minX + i * cell,
            z = minZ + j * cell;
          const t = saturate(((x - a.x) * dx + (z - a.z) * dz) / l2);
          const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
          const idx = j * res + i;
          if (d < best[idx]) {
            best[idx] = d;
            ry[idx] = lerp(a.y, b.y, t);
          }
        }
      }
    }
    const isBridgeZone = (x: number, z: number) =>
      r.id === 'coast' && Math.hypot(x - P.bridge.x, (z - P.bridge.z) * 1.4) < 30;
    for (let idx = 0; idx < N; idx++) {
      const d = best[idx];
      if (d > reach) continue;
      const i = idx % res,
        j = (idx / res) | 0;
      const x = minX + i * cell,
        z = minZ + j * cell;
      if (isBridgeZone(x, z)) continue; // the gorge stays open under the bridge
      const roadY = ry[idx] - 0.32; // terrain sits under the road mesh
      const core = 1 - smoothstep(half + 0.6, half + 2.2, d);
      // Embankment: slope ~ 1:1.6 outward
      const extra = Math.max(0, d - half);
      const hNat = height[idx];
      let h: number;
      if (hNat > roadY) {
        // Cut: limit terrain to road height + slope
        h = Math.min(hNat, roadY + extra * 0.9);
      } else {
        // Fill
        h = Math.max(hNat, roadY - extra * 0.62);
      }
      h = lerp(h, roadY, core);
      height[idx] = h;
      const mask = 1 - smoothstep(half, half + 2.5, d);
      surface[idx * 4 + 1] = Math.max(surface[idx * 4 + 1], (mask * 255) | 0);
      // No standing water on the road bed itself
      if (d < half) water[idx] = -1000;
    }
  }
  onProgress?.(0.7);

  // --- 6. Surface: forest density, meadows -------------------------------
  const nf = new Noise(4242);
  for (let j = 0; j < res; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < res; i++) {
      const x = minX + i * cell;
      const idx = j * res + i;
      const h = height[idx];
      const sd = coastAt(x, z);
      let forest = 0;
      if (sd < -12) {
        const f = nf.fbm2(x * 0.006, z * 0.006, 4) * 0.5 + 0.5;
        forest = smoothstep(0.34, 0.5, f);
        // Denser up the valley, thinner near the coast
        forest *= smoothstep(10, 90, -sd);
        // Town clearing
        const dt = Math.hypot((x - 20) * 0.9, (z - 70) * 1.1);
        forest *= smoothstep(150, 230, dt);
        // Headland is windswept: sparse, clumpy
        const hl = Math.hypot(x - P.lighthouse.x, z - P.lighthouse.z);
        forest *= lerp(0.0, 1, smoothstep(70, 200, hl));
        // Overlook view corridor
        forest *= smoothstep(12, 60, Math.hypot(x - P.overlook.x - 10, z - P.overlook.z - 30));
        // Utility yard clearing
        forest *= smoothstep(30, 55, Math.hypot(x - P.substation.x, z - P.substation.z));
        // High ridges are rocky
        forest *= 1 - smoothstep(210, 300, h);
        forest = Math.min(1, forest * 1.25 + (nf.n2(x * 0.05, z * 0.05) * 0.15));
      }
      forest = saturate(forest) * (1 - surface[idx * 4 + 1] / 255);
      surface[idx * 4 + 0] = (forest * 255) | 0;
      // Meadow: open land that isn't forest (town lawns, headland grass)
      let meadow = sd < -3 ? saturate(1 - forest * 1.3) : 0;
      meadow *= 1 - smoothstep(180, 260, h);
      surface[idx * 4 + 2] = Math.max(surface[idx * 4 + 2], (meadow * 255) | 0);
      const w = water[idx] > -999 ? clamp((water[idx] - h) * 64, 0, 255) : 0;
      surface[idx * 4 + 3] = w | 0;
    }
    if (onProgress && (j & 127) === 0) onProgress(0.7 + 0.3 * (j / res));
  }

  // The trail should be walkable: remove standing water directly on it (people walked
  // along the sandbar), but keep it wet.
  const trail = sampleCatmull(TRAIL, 4);
  for (const t of trail) {
    const i0 = Math.round((t.x - minX) / cell),
      j0 = Math.round((t.z - minZ) / cell);
    for (let dj = -3; dj <= 3; dj++)
      for (let di = -3; di <= 3; di++) {
        const i = i0 + di,
          j = j0 + dj;
        if (i < 0 || j < 0 || i >= res || j >= res) continue;
        const idx = j * res + i;
        if (Math.hypot(di, dj) <= 3) {
          if (water[idx] > -999 && water[idx] - height[idx] < 0.35) {
            height[idx] = Math.max(height[idx], water[idx] + 0.03);
            water[idx] = -1000;
            surface[idx * 4 + 3] = 0;
          }
        }
      }
  }

  onProgress?.(1);
  return { res, minX, minZ, size, cell, height, surface, water, roadSamples, riverSamples };
}

/** Bilinear height lookup on the generated field. */
export function sampleHeight(t: TerrainData, x: number, z: number): number {
  const fx = (x - t.minX) / t.cell;
  const fz = (z - t.minZ) / t.cell;
  const i0 = clamp(Math.floor(fx), 0, t.res - 2);
  const j0 = clamp(Math.floor(fz), 0, t.res - 2);
  const tx = clamp(fx - i0, 0, 1),
    tz = clamp(fz - j0, 0, 1);
  const r = t.res;
  const h = t.height;
  const a = h[j0 * r + i0],
    b = h[j0 * r + i0 + 1],
    c = h[(j0 + 1) * r + i0],
    d = h[(j0 + 1) * r + i0 + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}
