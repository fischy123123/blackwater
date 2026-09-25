// Coarse terrain ring that extends the world to the horizon (mountain ranges,
// continuing coastline, deep sea floor). Sits slightly below the detailed terrain
// where they overlap so the seam is hidden.
import * as THREE from 'three';
import { Noise, smoothstep, clamp } from '../core/math';
import { naturalHeight, coastSDF, TERRAIN_SEEDS } from './TerrainGen';
import { WORLD } from './Layout';
import { LAYER } from '../render/Globals';

export function buildFarTerrain(): THREE.Mesh {
  const n = new Noise(TERRAIN_SEEDS.a);
  const n2 = new Noise(TERRAIN_SEEDS.b);
  const nc = new Noise(5151);
  const EXT = 14000;
  // Non-uniform grid: fine near the map, coarse far away.
  const axis = (min: number, max: number) => {
    const v: number[] = [];
    for (let x = -EXT; x <= EXT + 1; ) {
      v.push(x);
      const d = x < min ? min - x : x > max ? x - max : 0;
      x += clamp(40 + d * 0.12, 40, 900);
    }
    return v;
  };
  const xs = axis(WORLD.minX, WORLD.minX + WORLD.size);
  const zs = axis(WORLD.minZ, WORLD.minZ + WORLD.size);
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const inner = (x: number, z: number) =>
    x > WORLD.minX + 30 && x < WORLD.minX + WORLD.size - 30 && z > WORLD.minZ + 30 && z < WORLD.minZ + WORLD.size - 30;
  const c = new THREE.Color();
  for (let j = 0; j < zs.length; j++) {
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i],
        z = zs[j];
      const sd = coastSDF(x, z);
      let h = naturalHeight(x, z, sd, n, n2);
      // tuck under the detailed terrain inside the map
      const insideMap = x >= WORLD.minX && x <= WORLD.minX + WORLD.size && z >= WORLD.minZ && z <= WORLD.minZ + WORLD.size;
      if (insideMap) h -= 3;
      pos.push(x, h, z);
      // vertex colour: sea floor, beach, forest, rock, snow-free alpine
      const forest = smoothstep(0.05, 0.45, nc.fbm2(x * 0.0012, z * 0.0012, 4) * 0.5 + 0.45) * smoothstep(8, 60, h) * (1 - smoothstep(520, 800, h));
      if (h < 0.5) c.setRGB(0.12, 0.11, 0.095);
      else if (h < 4) c.setRGB(0.28, 0.26, 0.22);
      else {
        c.setRGB(0.19, 0.2, 0.13);
        c.lerp(new THREE.Color(0.035, 0.055, 0.03), forest);
        const rock = smoothstep(450, 900, h);
        c.lerp(new THREE.Color(0.22, 0.22, 0.21), rock);
      }
      const v = 0.85 + 0.3 * nc.n2(x * 0.004, z * 0.004);
      col.push(c.r * v, c.g * v, c.b * v);
    }
  }
  const W = xs.length;
  for (let j = 0; j < zs.length - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      // skip quads entirely inside the detailed map
      if (inner(xs[i], zs[j]) && inner(xs[i + 1], zs[j + 1])) continue;
      const a = j * W + i,
        b = a + 1,
        cc = a + W,
        d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER.OPAQUE);
  mesh.name = 'far-terrain';
  return mesh;
}
