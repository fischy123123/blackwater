// Tileable 3D noise volumes (Perlin-Worley) for clouds and volumetric mist.
import * as THREE from 'three';

function hash3(x: number, y: number, z: number, seed: number) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f) ^ Math.imul(seed, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Tileable Worley F1 (inverted: 1 at feature points). */
function worley(x: number, y: number, z: number, cells: number, seed: number) {
  const px = x * cells,
    py = y * cells,
    pz = z * cells;
  const ix = Math.floor(px),
    iy = Math.floor(py),
    iz = Math.floor(pz);
  let md = 10;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx,
          cy = iy + dy,
          cz = iz + dz;
        const wx = ((cx % cells) + cells) % cells,
          wy = ((cy % cells) + cells) % cells,
          wz = ((cz % cells) + cells) % cells;
        const fx = cx + hash3(wx, wy, wz, seed) - px;
        const fy = cy + hash3(wx, wy, wz, seed + 1) - py;
        const fz = cz + hash3(wx, wy, wz, seed + 2) - pz;
        const d = fx * fx + fy * fy + fz * fz;
        if (d < md) md = d;
      }
  return 1 - Math.min(1, Math.sqrt(md));
}

/** Tileable gradient noise (value-gradient hybrid, periodic). */
function perlin(x: number, y: number, z: number, period: number, seed: number) {
  const px = x * period,
    py = y * period,
    pz = z * period;
  const ix = Math.floor(px),
    iy = Math.floor(py),
    iz = Math.floor(pz);
  const fx = px - ix,
    fy = py - iy,
    fz = pz - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const g = (cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) => {
    const wx = ((cx % period) + period) % period,
      wy = ((cy % period) + period) % period,
      wz = ((cz % period) + period) % period;
    const a = hash3(wx, wy, wz, seed) * Math.PI * 2;
    const b = hash3(wx, wy, wz, seed + 7) * 2 - 1;
    const s = Math.sqrt(1 - b * b);
    return Math.cos(a) * s * dx + Math.sin(a) * s * dy + b * dz;
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const n000 = g(ix, iy, iz, fx, fy, fz);
  const n100 = g(ix + 1, iy, iz, fx - 1, fy, fz);
  const n010 = g(ix, iy + 1, iz, fx, fy - 1, fz);
  const n110 = g(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz);
  const n001 = g(ix, iy, iz + 1, fx, fy, fz - 1);
  const n101 = g(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1);
  const n011 = g(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1);
  const n111 = g(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1);
  return lerp(lerp(lerp(n000, n100, u), lerp(n010, n110, u), v), lerp(lerp(n001, n101, u), lerp(n011, n111, u), v), w);
}

export function makeCloudNoise(size = 64): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  let o = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / size,
          fy = y / size,
          fz = z / size;
        // Perlin fbm
        let p = 0,
          a = 1,
          n = 0;
        for (let k = 0; k < 4; k++) {
          p += perlin(fx, fy, fz, 4 << k, 11 + k) * a;
          n += a;
          a *= 0.5;
        }
        p = p / n; // ~[-0.7,0.7]
        p = p * 0.5 + 0.5;
        const w1 = worley(fx, fy, fz, 4, 101);
        const w2 = worley(fx, fy, fz, 8, 202);
        const w3 = worley(fx, fy, fz, 16, 303);
        const wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
        // Perlin-Worley: remap perlin with worley
        const pw = Math.max(0, Math.min(1, (p - (1 - wfbm)) / (1 - (1 - wfbm) + 1e-4) * 0.5 + p * 0.5));
        data[o++] = Math.round(pw * 255);
        data[o++] = Math.round(w1 * 255);
        data[o++] = Math.round(w2 * 255);
        data[o++] = Math.round(w3 * 255);
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
