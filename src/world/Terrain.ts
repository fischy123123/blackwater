// Terrain rendering: instanced CDLOD quadtree with GPU vertex morphing,
// per-pixel normals, texture-array material splatting with anti-tiling,
// wetness/puddles, and a heightfield horizon-shadow map for large-scale sun shadows.
import * as THREE from 'three';
import type { TerrainData } from './TerrainGen';
import { U, LAYER } from '../render/Globals';
import { FullScreenQuad, fsMaterial } from '../render/FullScreen';
import { GLSL_NOISE, injectGlobals } from '../render/Chunks';
import { clamp, lerp } from '../core/math';

const PATCH_N = 32;
const LEVELS = 7; // 2048 -> 32 m leaves
const LEAF = 32;

export const TERRAIN_LAYERS = ['grass', 'forest', 'rock', 'mud', 'sand', 'gravel', 'algae', 'cobble'];

export const TERRAIN_HEIGHT_GLSL = /* glsl */ `
uniform highp sampler2D uHeightTex;
uniform vec4 uTerrainInfo; // minX, minZ, size, res
float bwHFetch(ivec2 c) {
  int r = int(uTerrainInfo.w) - 1;
  c = clamp(c, ivec2(0), ivec2(r));
  return texelFetch(uHeightTex, c, 0).r;
}
float bwTerrainHeight(vec2 wp) {
  float cell = uTerrainInfo.z / (uTerrainInfo.w - 1.0);
  vec2 f = (wp - uTerrainInfo.xy) / cell;
  vec2 i = floor(f);
  vec2 t = f - i;
  ivec2 c = ivec2(i);
  float a = bwHFetch(c), b = bwHFetch(c + ivec2(1, 0)), cc = bwHFetch(c + ivec2(0, 1)), d = bwHFetch(c + ivec2(1, 1));
  return mix(mix(a, b, t.x), mix(cc, d, t.x), t.y);
}
`;

export class Terrain {
  data: TerrainData;
  heightTex: THREE.DataTexture;
  normalTex: THREE.DataTexture;
  surfaceTex: THREE.DataTexture;
  shadowRT: THREE.WebGLRenderTarget;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private nodeAttr: THREE.InstancedBufferAttribute;
  private maxNodes = 900;
  private minMax: Float32Array[] = []; // per level: [min,max] per node
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private ranges: number[] = [];
  private morph: THREE.Vector2[] = [];
  private shadowMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  private lastShadowSun = new THREE.Vector3(0, -1, 0);
  shadowDirty = true;
  nodeCount = 0;

  constructor(data: TerrainData, layers: { albedo: THREE.Texture; normal: THREE.Texture }, quality: { shadowRes: number; detail: number }) {
    this.data = data;
    const { res } = data;

    this.heightTex = new THREE.DataTexture(data.height, res, res, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.needsUpdate = true;
    U.uHeightTex.value = this.heightTex;
    U.uTerrainInfo.value.set(data.minX, data.minZ, data.size, res);

    // Normals + AO (CPU)
    const nrm = new Uint8Array(res * res * 4);
    const h = data.height;
    const cell = data.cell;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const idx = j * res + i;
        const hl = h[j * res + Math.max(0, i - 1)];
        const hr = h[j * res + Math.min(res - 1, i + 1)];
        const hd = h[Math.max(0, j - 1) * res + i];
        const hu = h[Math.min(res - 1, j + 1) * res + i];
        let nx = (hl - hr) / (2 * cell),
          nz = (hd - hu) / (2 * cell),
          ny = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
        // Cheap AO: compare with the average height around at two radii
        let occ = 0;
        const h0 = h[idx];
        for (const rad of [3, 8]) {
          let s = 0;
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const ii = clamp(Math.round(i + Math.cos(a) * rad), 0, res - 1);
            const jj = clamp(Math.round(j + Math.sin(a) * rad), 0, res - 1);
            const dh = h[jj * res + ii] - h0;
            s += Math.max(0, Math.atan2(dh, rad * cell));
          }
          occ += s / 8;
        }
        const ao = clamp(1 - occ * 0.9, 0, 1);
        nrm[idx * 4] = Math.round((nx * 0.5 + 0.5) * 255);
        nrm[idx * 4 + 1] = Math.round((nz * 0.5 + 0.5) * 255);
        nrm[idx * 4 + 2] = Math.round(ao * 255);
        nrm[idx * 4 + 3] = 255;
      }
    }
    this.normalTex = new THREE.DataTexture(nrm, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.normalTex.minFilter = THREE.LinearFilter;
    this.normalTex.magFilter = THREE.LinearFilter;
    this.normalTex.needsUpdate = true;

    this.surfaceTex = new THREE.DataTexture(data.surface, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.surfaceTex.minFilter = THREE.LinearFilter;
    this.surfaceTex.magFilter = THREE.LinearFilter;
    this.surfaceTex.needsUpdate = true;

    // Horizon shadow map
    this.shadowRT = new THREE.WebGLRenderTarget(quality.shadowRes, quality.shadowRes, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    U.uTerrainShadow.value = this.shadowRT.texture;
    this.shadowMat = fsMaterial(
      /* glsl */ `
      ${TERRAIN_HEIGHT_GLSL}
      uniform vec3 uL;
      varying vec2 vUv;
      void main() {
        vec2 wp = uTerrainInfo.xy + vUv * uTerrainInfo.z;
        float h0 = bwTerrainHeight(wp) + 1.0;
        vec3 L = uL;
        if (L.y <= 0.0) { gl_FragColor = vec4(0.0); return; }
        vec2 dir = normalize(L.xz);
        float slope = L.y / length(L.xz);
        float t = 3.0;
        float sh = 1.0;
        for (int i = 0; i < 72; i++) {
          vec2 p = wp + dir * t;
          float ray = h0 + slope * t;
          float th = bwTerrainHeight(p);
          sh = min(sh, clamp((ray - th) / (t * 0.035) + 0.5, 0.0, 1.0));
          t *= 1.075;
          t += 1.0;
          if (sh <= 0.0 || t > 2500.0) break;
        }
        gl_FragColor = vec4(sh, sh, sh, 1.0);
      }`,
      { uHeightTex: U.uHeightTex, uTerrainInfo: U.uTerrainInfo, uL: { value: new THREE.Vector3() } },
    );

    // Min/max pyramid
    for (let lvl = 0; lvl < LEVELS; lvl++) {
      const size = LEAF << lvl;
      const count = Math.ceil(data.size / size);
      const arr = new Float32Array(count * count * 2);
      for (let nz = 0; nz < count; nz++)
        for (let nx = 0; nx < count; nx++) {
          let mn = Infinity,
            mx = -Infinity;
          const i0 = Math.floor((nx * size) / cell),
            i1 = Math.min(res - 1, Math.ceil(((nx + 1) * size) / cell));
          const j0 = Math.floor((nz * size) / cell),
            j1 = Math.min(res - 1, Math.ceil(((nz + 1) * size) / cell));
          const step = Math.max(1, (i1 - i0) >> 4);
          for (let j = j0; j <= j1; j += step)
            for (let i = i0; i <= i1; i += step) {
              const v = h[j * res + i];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
          arr[(nz * count + nx) * 2] = mn - 2;
          arr[(nz * count + nx) * 2 + 1] = mx + 2;
        }
      this.minMax.push(arr);
    }

    let r = 44 * quality.detail;
    for (let i = 0; i < LEVELS; i++) {
      this.ranges.push(r);
      r *= 2;
    }
    for (let i = 0; i < LEVELS; i++) {
      const end = this.ranges[i];
      const start = i === 0 ? end * 0.62 : Math.max(this.ranges[i - 1], end * 0.62);
      this.morph.push(new THREE.Vector2(start, end));
    }

    // Patch geometry
    const g = new THREE.InstancedBufferGeometry();
    const verts: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= PATCH_N; j++)
      for (let i = 0; i <= PATCH_N; i++) verts.push(i / PATCH_N, 0, j / PATCH_N);
    for (let j = 0; j < PATCH_N; j++)
      for (let i = 0; i < PATCH_N; i++) {
        const a = j * (PATCH_N + 1) + i;
        const b = a + 1,
          c = a + PATCH_N + 1,
          d = c + 1;
        // alternate diagonals for nicer shading
        if ((i + j) & 1) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    this.nodeAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxNodes * 4), 4);
    this.nodeAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aNode', this.nodeAttr);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7));
    this.geo = g;

    this.material = this.makeMaterial(layers);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.layers.set(LAYER.OPAQUE);
    this.mesh.layers.enable(LAYER.REFLECT);
  }

  private makeMaterial(layers: { albedo: THREE.Texture; normal: THREE.Texture }) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    const morphU = { value: this.morph };
    const uniforms = {
      uNormalTex: { value: this.normalTex },
      uSurfaceTex: { value: this.surfaceTex },
      uLayersA: { value: layers.albedo },
      uLayersN: { value: layers.normal },
      uMorph: morphU,
    };
    mat.onBeforeCompile = (shader) => {
      injectGlobals(shader);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          ${TERRAIN_HEIGHT_GLSL}
          attribute vec4 aNode;
          uniform vec2 uMorph[${LEVELS}];
          uniform sampler2D uNormalTex;
          varying vec3 vTWorld;
          varying float vTDist;`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `
          vec2 bwGrid = position.xz * ${PATCH_N.toFixed(1)};
          vec2 bwWp = aNode.xy + position.xz * aNode.z;
          float bwH = bwTerrainHeight(bwWp);
          float bwDist = distance(cameraPosition, vec3(bwWp.x, bwH, bwWp.y));
          vec2 bwM = uMorph[int(aNode.w + 0.5)];
          float bwK = clamp((bwDist - bwM.x) / max(bwM.y - bwM.x, 1.0), 0.0, 1.0);
          bwGrid -= fract(bwGrid * 0.5) * 2.0 * bwK;
          bwWp = aNode.xy + bwGrid / ${PATCH_N.toFixed(1)} * aNode.z;
          bwH = bwTerrainHeight(bwWp);
          vec2 bwTuv = (bwWp - uTerrainInfo.xy) / uTerrainInfo.z;
          vec4 bwNs = texture2D(uNormalTex, bwTuv);
          vec2 bwNxz = bwNs.xy * 2.0 - 1.0;
          vec3 objectNormal = vec3(bwNxz.x, sqrt(max(1.0 - dot(bwNxz, bwNxz), 0.0)), bwNxz.y);
          vTWorld = vec3(bwWp.x, bwH, bwWp.y);
          vTDist = bwDist;
          `,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = vTWorld;');

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          ${GLSL_NOISE}
          precision highp sampler2DArray;
          uniform sampler2D uNormalTex;
          uniform sampler2D uSurfaceTex;
          uniform sampler2DArray uLayersA;
          uniform sampler2DArray uLayersN;
          uniform float uWetness;
          uniform float uRain;
          uniform float uTime;
          varying vec3 vTWorld;
          varying float vTDist;

          vec2 bwDx, bwDy;
          // anti-tiling: two rotated/scaled samples blended by noise + height
          void bwLayer(vec2 uv, float layer, float blend, out vec4 a, out vec4 n) {
            vec4 a1 = textureGrad(uLayersA, vec3(uv, layer), bwDx, bwDy);
            vec4 n1 = textureGrad(uLayersN, vec3(uv, layer), bwDx, bwDy);
            mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
            vec2 uv2 = R * uv * 0.43 + 0.37;
            vec2 dx2 = R * bwDx * 0.43, dy2 = R * bwDy * 0.43;
            vec4 a2 = textureGrad(uLayersA, vec3(uv2, layer), dx2, dy2);
            vec4 n2 = textureGrad(uLayersN, vec3(uv2, layer), dx2, dy2);
            float hb = clamp((blend - 0.5) * 2.0 + (n2.z - n1.z) * 0.8 + 0.5, 0.0, 1.0);
            a = mix(a1, a2, hb);
            n = mix(n1, n2, hb);
            // un-rotate the second sample's tangent normal so lighting stays consistent
            vec2 t2 = transpose(R) * (n2.xy * 2.0 - 1.0);
            n.xy = mix(n1.xy * 2.0 - 1.0, t2, hb) * 0.5 + 0.5;
          }
          vec3 bwRipples(vec2 p, float t) {
            // expanding rain rings in a jittered grid
            vec2 cell = floor(p);
            vec2 f = fract(p);
            vec3 acc = vec3(0.0);
            for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
              vec2 g = vec2(float(x), float(y));
              vec2 h = bwHash22(cell + g);
              vec2 o = g + h - f;
              float ph = fract(t * (0.9 + h.x * 0.6) + h.y);
              float r = ph * 0.9;
              float d = length(o);
              float ring = sin((d - r) * 40.0) * smoothstep(0.12, 0.0, abs(d - r)) * (1.0 - ph);
              acc.xy += normalize(o + 1e-4) * ring;
            }
            return acc;
          }`,
        )
        .replace(
          '#include <map_fragment>',
          `
          vec3 bwW = vTWorld;
          vec2 bwTuv = (bwW.xz - uTerrainInfo.xy) / uTerrainInfo.z;
          vec4 bwNs = texture2D(uNormalTex, bwTuv);
          vec2 bwNxz = bwNs.xy * 2.0 - 1.0;
          vec3 bwN = normalize(vec3(bwNxz.x, sqrt(max(1.0 - dot(bwNxz, bwNxz), 0.0)), bwNxz.y));
          float bwAO = bwNs.z;
          vec4 bwS = texture2D(uSurfaceTex, bwTuv);
          float bwSlope = 1.0 - bwN.y;
          float bwNLow = bwFbm(bwW.xz * 0.018);
          float bwNMid = bwFbm(bwW.xz * 0.11 + 7.0);
          float bwHwl = 1.4 + (bwNLow - 0.5) * 1.2;                 // old high-water line
          float bwSea = smoothstep(bwHwl + 0.25, bwHwl - 0.35, bwW.y);
          float bwWater = bwS.a * 4.0;                               // standing water depth (m)

          // weights: 0 grass,1 forest,2 rock,3 mud,4 sand,5 gravel,6 algae,7 cobble
          float w[8];
          float land = 1.0 - bwSea;
          float rockK = smoothstep(0.33, 0.55, bwSlope + (bwNMid - 0.5) * 0.25);
          w[0] = land * (1.0 - rockK) * max(bwS.b, 0.15) * (1.0 - bwS.r);
          w[1] = land * (1.0 - rockK) * bwS.r * 1.2;
          w[5] = land * (1.0 - rockK) * bwS.g * 1.6;
          w[2] = land * rockK;
          float beach = smoothstep(-3.0, 0.6, bwW.y) * smoothstep(0.3, 0.9, bwNLow + 0.35);
          w[4] = bwSea * (1.0 - rockK) * beach;
          w[3] = bwSea * (1.0 - rockK) * (1.0 - beach);
          w[6] = bwSea * rockK;
          float cob = smoothstep(0.62, 0.72, bwNMid) * smoothstep(-1.5, 0.5, bwW.y) * bwSea;
          w[7] = cob * (1.0 - rockK) * 1.5;
          float wsum = 0.0;
          for (int i = 0; i < 8; i++) { w[i] = max(w[i], 0.0); wsum += w[i]; }
          vec4 bwA = vec4(0.0);
          vec3 bwPert = vec3(0.0);
          float bwHgt = 0.0;
          float bwAOm = 0.0;
          float bwBlend = bwFbm(bwW.xz * 0.045 + 3.0);
          float bwTile = 0.25; // 4 m texture repeat
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - bwN * bwN.x);
          vec3 B = normalize(cross(T, bwN));
          vec3 bwTw = pow(abs(bwN), vec3(4.0));
          bwTw /= (bwTw.x + bwTw.y + bwTw.z);
          vec2 uvx = bwW.zy * 0.12, uvy = bwW.xz * 0.12, uvz = bwW.xy * 0.12, uvp = bwW.xz * bwTile;
          vec2 dXx = dFdx(uvx), dXy = dFdy(uvx), dYx = dFdx(uvy), dYy = dFdy(uvy);
          vec2 dZx = dFdx(uvz), dZy = dFdy(uvz), dPx = dFdx(uvp), dPy = dFdy(uvp);
          for (int i = 0; i < 8; i++) {
            float wi = w[i] / max(wsum, 1e-4);
            if (wi < 0.02) continue;
            vec4 a; vec4 n;
            if (i == 2 || i == 6) {
              vec4 ax, nx, ay, ny, az, nz;
              bwDx = dXx; bwDy = dXy;
              bwLayer(uvx, float(i), bwBlend, ax, nx);
              bwDx = dYx; bwDy = dYy;
              bwLayer(uvy, float(i), bwBlend, ay, ny);
              bwDx = dZx; bwDy = dZy;
              bwLayer(uvz, float(i), bwBlend, az, nz);
              a = ax * bwTw.x + ay * bwTw.y + az * bwTw.z;
              vec2 px = nx.xy * 2.0 - 1.0, py = ny.xy * 2.0 - 1.0, pz = nz.xy * 2.0 - 1.0;
              vec3 p3 = vec3(0.0, px.y, px.x) * bwTw.x + vec3(py.x, 0.0, py.y) * bwTw.y + vec3(pz.x, pz.y, 0.0) * bwTw.z;
              bwPert += p3 * wi;
              bwHgt += (nx.z * bwTw.x + ny.z * bwTw.y + nz.z * bwTw.z) * wi;
              bwAOm += (nx.w * bwTw.x + ny.w * bwTw.y + nz.w * bwTw.z) * wi;
            } else {
              bwDx = dPx; bwDy = dPy;
              bwLayer(uvp, float(i), bwBlend, a, n);
              vec2 tn = n.xy * 2.0 - 1.0;
              bwPert += (T * tn.x + B * tn.y) * wi;
              bwHgt += n.z * wi;
              bwAOm += n.w * wi;
            }
            bwA += a * wi;
          }
          // macro variation
          bwA.rgb *= 0.8 + 0.4 * bwNLow;
          bwA.rgb *= mix(vec3(1.0), vec3(1.05, 1.0, 0.92), bwNMid);
          diffuseColor.rgb = bwA.rgb;
          float bwRough = bwA.a;
          float bwDetail = mix(1.0, 0.3, smoothstep(40.0, 200.0, vTDist));
          vec3 bwNW = normalize(bwN + bwPert * bwDetail);
          vec4 bwNrm = vec4(0.5, 0.5, bwHgt, bwAOm);

          // Wetness: seabed is always wet; rain adds global wetness and puddles
          float porous = 1.0;
          float wet = max(bwSea * (0.75 + 0.25 * smoothstep(bwHwl - 1.5, bwHwl - 3.0, bwW.y)), uWetness);
          float cavity = 1.0 - bwNrm.z;
          float puddle = 0.0;
          if (uWetness > 0.01) {
            float pn = bwFbm(bwW.xz * 0.35 + 11.0) + cavity * 0.25 + bwS.g * 0.2;
            puddle = smoothstep(0.78 - uWetness * 0.22, 0.86 - uWetness * 0.2, pn) * bwN.y * land;
          }
          puddle = max(puddle, bwSea * smoothstep(0.62, 0.75, bwFbm(bwW.xz * 0.2) + cavity * 0.4) * 0.8);
          puddle = max(puddle, smoothstep(0.0, 0.05, bwWater));
          diffuseColor.rgb *= mix(1.0, 0.52, wet * porous);
          bwRough = mix(bwRough, 0.22, wet * bwN.y);
          bwRough = mix(bwRough, 0.03, puddle);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, puddle);
          bwNW = normalize(mix(bwNW, bwN, puddle * 0.95));
          if (uRain > 0.01 && puddle > 0.1) {
            vec3 rp = bwRipples(bwW.xz * 2.2, uTime * 1.3) * uRain;
            bwNW = normalize(bwNW + vec3(rp.x, 0.0, rp.y) * 0.35 * puddle);
          }
          float bwAOf = mix(1.0, bwAO, 0.85) * mix(1.0, bwNrm.w, 0.6);
          `,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = bwRough;')
        .replace(
          '#include <normal_fragment_maps>',
          `normal = normalize((viewMatrix * vec4(bwNW, 0.0)).xyz);`,
        )
        .replace(
          '#include <aomap_fragment>',
          `
          reflectedLight.indirectDiffuse *= bwAOf;
          reflectedLight.indirectSpecular *= mix(bwAOf, 1.0, puddle);
          `,
        );
    };
    mat.customProgramCacheKey = () => 'bw-terrain';
    return mat;
  }

  /** Recompute the horizon shadow map if the sun moved enough. */
  updateShadow(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3, force = false) {
    if (!force && !this.shadowDirty && sunDir.angleTo(this.lastShadowSun) < 0.004) return;
    this.lastShadowSun.copy(sunDir);
    this.shadowDirty = false;
    const prev = renderer.getRenderTarget();
    this.shadowMat.uniforms.uL.value.copy(sunDir);
    this.quad.material = this.shadowMat;
    renderer.setRenderTarget(this.shadowRT);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  /** CDLOD node selection. */
  update(camera: THREE.PerspectiveCamera) {
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const cam = camera.position;
    const arr = this.nodeAttr.array as Float32Array;
    let n = 0;
    const box = new THREE.Box3();
    const minX = this.data.minX,
      minZ = this.data.minZ;
    const push = (x: number, z: number, size: number, lod: number) => {
      if (n >= this.maxNodes) return;
      arr[n * 4] = x;
      arr[n * 4 + 1] = z;
      arr[n * 4 + 2] = size;
      arr[n * 4 + 3] = lod;
      n++;
    };
    const aabbSphere = (lvl: number, nx: number, nz: number, r: number) => {
      const size = LEAF << lvl;
      const count = Math.ceil(this.data.size / size);
      const mm = this.minMax[lvl];
      const mn = mm[(nz * count + nx) * 2],
        mx = mm[(nz * count + nx) * 2 + 1];
      const x0 = minX + nx * size,
        z0 = minZ + nz * size;
      const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size));
      const dy = Math.max(mn - cam.y, 0, cam.y - mx);
      const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + size));
      return dx * dx + dy * dy + dz * dz <= r * r;
    };
    const visible = (lvl: number, nx: number, nz: number) => {
      const size = LEAF << lvl;
      const count = Math.ceil(this.data.size / size);
      const mm = this.minMax[lvl];
      const x0 = minX + nx * size,
        z0 = minZ + nz * size;
      box.min.set(x0, mm[(nz * count + nx) * 2], z0);
      box.max.set(x0 + size, mm[(nz * count + nx) * 2 + 1], z0 + size);
      return this.frustum.intersectsBox(box);
    };
    const select = (lvl: number, nx: number, nz: number): boolean => {
      if (!aabbSphere(lvl, nx, nz, this.ranges[lvl])) return false;
      if (!visible(lvl, nx, nz)) return true; // handled (culled)
      const size = LEAF << lvl;
      const x0 = minX + nx * size,
        z0 = minZ + nz * size;
      if (lvl === 0) {
        push(x0, z0, size, 0);
        return true;
      }
      if (!aabbSphere(lvl, nx, nz, this.ranges[lvl - 1])) {
        push(x0, z0, size, lvl);
        return true;
      }
      for (let cz = 0; cz < 2; cz++)
        for (let cx = 0; cx < 2; cx++) {
          const ccx = nx * 2 + cx,
            ccz = nz * 2 + cz;
          const csize = size >> 1;
          const ccount = Math.ceil(this.data.size / csize);
          if (ccx >= ccount || ccz >= ccount) continue;
          if (!select(lvl - 1, ccx, ccz)) {
            if (visible(lvl - 1, ccx, ccz)) push(minX + ccx * csize, minZ + ccz * csize, csize, lvl);
          }
        }
      return true;
    };
    const top = LEVELS - 1;
    const topCount = Math.ceil(this.data.size / (LEAF << top));
    for (let z = 0; z < topCount; z++)
      for (let x = 0; x < topCount; x++) {
        if (!select(top, x, z)) {
          if (visible(top, x, z)) push(minX + x * (LEAF << top), minZ + z * (LEAF << top), LEAF << top, top);
        }
      }
    this.geo.instanceCount = n;
    this.nodeAttr.needsUpdate = true;
    this.nodeAttr.addUpdateRange(0, n * 4);
    this.nodeCount = n;
  }

  // ------------------------------------------------------------ CPU queries
  heightAt(x: number, z: number): number {
    const t = this.data;
    const fx = clamp((x - t.minX) / t.cell, 0, t.res - 1.001);
    const fz = clamp((z - t.minZ) / t.cell, 0, t.res - 1.001);
    const i0 = Math.floor(fx),
      j0 = Math.floor(fz);
    const tx = fx - i0,
      tz = fz - j0;
    const r = t.res,
      h = t.height;
    const a = h[j0 * r + i0],
      b = h[j0 * r + i0 + 1],
      c = h[(j0 + 1) * r + i0],
      d = h[(j0 + 1) * r + i0 + 1];
    // Match the GPU triangulation closely enough by using bilinear
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  normalAt(x: number, z: number, out = new THREE.Vector3()) {
    const e = 1.0;
    const hl = this.heightAt(x - e, z),
      hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e),
      hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  surfaceAt(x: number, z: number) {
    const t = this.data;
    const i = clamp(Math.round((x - t.minX) / t.cell), 0, t.res - 1);
    const j = clamp(Math.round((z - t.minZ) / t.cell), 0, t.res - 1);
    const idx = (j * t.res + i) * 4;
    return {
      forest: t.surface[idx] / 255,
      road: t.surface[idx + 1] / 255,
      meadow: t.surface[idx + 2] / 255,
      water: t.surface[idx + 3] / 64,
    };
  }

  waterAt(x: number, z: number) {
    const t = this.data;
    const i = clamp(Math.round((x - t.minX) / t.cell), 0, t.res - 1);
    const j = clamp(Math.round((z - t.minZ) / t.cell), 0, t.res - 1);
    return t.water[j * t.res + i];
  }
}

