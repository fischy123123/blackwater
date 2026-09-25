// Forest: placement, instanced mesh trees near the player (wind, translucency,
// dithered LOD) and hemi-octahedral impostors for everything else.
import * as THREE from 'three';
import { buildTreeVariants, paintLeafTexture, paintNeedleTexture, type TreeVariant } from './TreeGen';
import type { Terrain } from './Terrain';
import { RNG, clamp, smoothstep, hash2 } from '../core/math';
import { U, LAYER } from '../render/Globals';
import { GLSL_FOG_FN, GLSL_FOG_UNIFORMS, GLSL_NOISE, injectGlobals } from '../render/Chunks';
import type { TexGen } from '../render/TexGen';
import { P, WORLD } from './Layout';

const MAX_VARIANTS = 8;

export type TreeInstance = { x: number; y: number; z: number; s: number; yaw: number; v: number };

/** Areas where no trees may grow (roads handled by the surface mask). */
export type Exclusion = { x: number; z: number; r: number } | { x0: number; z0: number; x1: number; z1: number };

const IMPOSTOR_VERT = /* glsl */ `
attribute vec4 aPos; // x y z scale
attribute vec2 aRot; // yaw, variant
uniform vec4 uInfo[${MAX_VARIANTS}]; // centerY, radius, height, 0
uniform float uFrames;
uniform float uNear;
uniform float uTime;
uniform vec3 uWind;
uniform float uWindStrength;
uniform float uGust;
varying vec2 vQuad;
varying vec2 vGrid;
varying float vLayer;
varying float vFade;
varying float vYaw;
varying vec3 vWorld;
varying vec3 vBase;
vec2 hemiOctEncode(vec3 v) {
  vec2 p = v.xz / (abs(v.x) + abs(v.y) + abs(v.z));
  return vec2(p.x + p.y, p.x - p.y);
}
void main() {
  int vi = int(aRot.y + 0.5);
  vec4 info = uInfo[vi];
  float sc = aPos.w;
  vec3 center = aPos.xyz + vec3(0.0, info.x * sc, 0.0);
  float R = info.y * sc;
  vec3 toCam = cameraPosition - center;
  float dist = length(toCam);
  vec3 dW = toCam / dist;
  float yaw = aRot.x;
  float c = cos(yaw), s = sin(yaw);
  // world -> tree local (inverse yaw)
  vec3 dL = vec3(c * dW.x - s * dW.z, dW.y, s * dW.x + c * dW.z);
  dL.y = max(dL.y, 0.02);
  dL = normalize(dL);
  vec3 fwd = normalize(vec3(dW.x, max(dW.y, 0.02), dW.z));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, right);
  vec2 q = position.xy;
  // wind sway (top of the card moves)
  float sway = (q.y * 0.5 + 0.5);
  sway *= sway;
  float ph = aPos.x * 0.07 + aPos.z * 0.05;
  vec3 wofs = uWind * (sin(uTime * 0.8 + ph) * 0.5 + uGust * 0.6) * uWindStrength * sway * 0.02 * info.z * sc;
  vec3 wp = center + (right * q.x + up * q.y) * R + wofs;
  // Pull the card toward the camera a little so it doesn't sink into slopes
  wp += fwd * R * 0.25;
  vec2 e = hemiOctEncode(dL) * 0.5 + 0.5;
  vGrid = e * uFrames - 0.5;
  vQuad = q * 0.5 + 0.5;
  vLayer = aRot.y;
  vYaw = yaw;
  vFade = smoothstep(uNear - 3.0, uNear + 3.0, dist);
  vWorld = wp;
  vBase = aPos.xyz;
  if (vFade <= 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const IMPOSTOR_FRAG = /* glsl */ `
precision highp sampler2DArray;
${GLSL_NOISE}
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tNormal;
uniform float uFrames;
uniform float uAtlasSize;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uLowQ;
varying vec2 vQuad;
varying vec2 vGrid;
varying float vLayer;
varying float vFade;
varying float vYaw;
varying vec3 vWorld;
varying vec3 vBase;
vec4 frameA(vec2 cell) {
  cell = clamp(cell, vec2(0.0), vec2(uFrames - 1.0));
  return texture(tAlbedo, vec3((cell + vQuad) / uFrames, vLayer));
}
vec4 frameN(vec2 cell) {
  cell = clamp(cell, vec2(0.0), vec2(uFrames - 1.0));
  return texture(tNormal, vec3((cell + vQuad) / uFrames, vLayer));
}
void main() {
  if (bwIGN(gl_FragCoord.xy) > vFade) discard;
  vec2 g0 = floor(vGrid);
  vec2 f = vGrid - g0;
  vec4 a; vec4 n;
  if (uLowQ > 0.5) {
    vec2 cell = g0 + step(vec2(0.5), f);
    a = frameA(cell);
    n = frameN(cell);
  } else {
    vec4 a00 = frameA(g0), a10 = frameA(g0 + vec2(1.0, 0.0)), a01 = frameA(g0 + vec2(0.0, 1.0)), a11 = frameA(g0 + vec2(1.0, 1.0));
    a = mix(mix(a00, a10, f.x), mix(a01, a11, f.x), f.y);
    vec4 n00 = frameN(g0), n10 = frameN(g0 + vec2(1.0, 0.0)), n01 = frameN(g0 + vec2(0.0, 1.0)), n11 = frameN(g0 + vec2(1.0, 1.0));
    n = mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y);
  }
  // Coverage-preserving alpha: boost with mip level, then sharpen for alpha-to-coverage.
  vec2 texel = vQuad / uFrames * uAtlasSize;
  float lod = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
  float alpha = a.a * (1.0 + lod * 0.3);
  float cov = (alpha - 0.5) / max(fwidth(alpha), 1e-4) + 0.5;
  if (cov < 0.02) discard;
  vec3 nl = normalize(n.xyz * 2.0 - 1.0);
  float c = cos(vYaw), s = sin(vYaw);
  vec3 N = normalize(vec3(c * nl.x + s * nl.z, nl.y, -s * nl.x + c * nl.z));
  vec3 V = normalize(cameraPosition - vWorld);
  float sh = bwTerrainShadowAt(vBase + vec3(0.0, 4.0, 0.0));
  float ndl = max(dot(N, uLightDir), 0.0);
  float trans = pow(max(dot(-V, uLightDir), 0.0), 4.0) * 0.55;
  float ao = n.a;
  vec3 amb = textureLod(uSkyCube, normalize(N + vec3(0.0, 0.6, 0.0)), 5.0).rgb * uSkyExposure * 0.9;
  vec3 col = a.rgb * (uLightColor * (ndl * 0.85 + trans) * sh + amb * (0.35 + 0.65 * ao));
  col = bwApplyFog(col, vWorld);
  gl_FragColor = vec4(col, clamp(cov, 0.0, 1.0));
}
`;

// Bake materials ------------------------------------------------------------
const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
varying vec3 vCol;
void main() {
  vUv = uv;
  vN = normal;
  vPos = position;
  vCol = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BAKE_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec2 uRepeat;
uniform float uMode; // 0 albedo, 1 normal+ao
uniform float uAlphaTest;
uniform vec3 uTint;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
varying vec3 vCol;
void main() {
  vec4 t = texture2D(map, vUv * uRepeat);
  if (t.a < uAlphaTest) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  if (uMode < 0.5) gl_FragColor = vec4(t.rgb * uTint * mix(0.55, 1.0, vCol.b), 1.0);
  else gl_FragColor = vec4(n * 0.5 + 0.5, vCol.b);
}
`;

export class Forest {
  variants: TreeVariant[];
  trees: TreeInstance[] = [];
  near: { bark: THREE.InstancedMesh; foliage: THREE.InstancedMesh | null; attr: THREE.InstancedBufferAttribute }[] = [];
  impostorGroup = new THREE.Group();
  impostorMat: THREE.ShaderMaterial;
  atlas: { albedo: THREE.Texture; normal: THREE.Texture };
  frames: number;
  nearRange: number;
  private grid = new Map<number, number[]>();
  private cellSize = 32;
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  barkMats: THREE.MeshStandardMaterial[] = [];
  foliageMats: THREE.MeshStandardMaterial[] = [];
  private maxNear = 1600;
  private infos: THREE.Vector4[] = [];
  colliders: { x: number; z: number; r: number }[] = [];

  constructor(
    renderer: THREE.WebGLRenderer,
    texgen: TexGen,
    terrain: Terrain,
    opts: { near: number; far: number; atlasSize: number; frames: number; lowQ: boolean; exclusions: Exclusion[]; density: number },
  ) {
    this.nearRange = opts.near;
    this.frames = opts.frames;
    this.variants = buildTreeVariants();

    // Materials
    const barkFir = texgen.bake('barkFir', 512, 5);
    const barkAlder = texgen.bake('barkAlder', 512, 4);
    const needles = {
      fir: paintNeedleTexture('fir', 1),
      hemlock: paintNeedleTexture('hemlock', 2),
      spruce: paintNeedleTexture('spruce', 3),
    };
    const leaves = paintLeafTexture(4);
    const tint = new THREE.Color();
    for (const v of this.variants) {
      const isAlder = v.kind === 'alder';
      const bark = new THREE.MeshStandardMaterial({
        map: isAlder ? barkAlder.map : barkFir.map,
        normalMap: isAlder ? barkAlder.normal : barkFir.normal,
        roughness: 0.9,
        metalness: 0,
        vertexColors: false,
      });
      bark.map!.wrapS = bark.map!.wrapT = THREE.RepeatWrapping;
      patchTreeMaterial(bark, false, opts.near);
      this.barkMats.push(bark);
      if (v.foliage) {
        const tex = isAlder ? leaves : v.kind === 'hemlock' ? needles.hemlock : v.kind === 'spruce' ? needles.spruce : needles.fir;
        const fol = new THREE.MeshStandardMaterial({
          map: tex,
          alphaTest: 0.45,
          alphaToCoverage: true,
          side: THREE.DoubleSide,
          roughness: 0.82,
          metalness: 0,
        });
        patchTreeMaterial(fol, true, opts.near);
        this.foliageMats.push(fol);
      } else this.foliageMats.push(null as unknown as THREE.MeshStandardMaterial);
      void tint;
    }

    // Impostor atlas
    this.atlas = this.bakeImpostors(renderer, opts.atlasSize, opts.frames);
    while (this.infos.length < MAX_VARIANTS) this.infos.push(new THREE.Vector4(10, 10, 20, 0));
    this.impostorMat = new THREE.ShaderMaterial({
      vertexShader: IMPOSTOR_VERT,
      fragmentShader: IMPOSTOR_FRAG,
      uniforms: {
        tAlbedo: { value: this.atlas.albedo },
        tNormal: { value: this.atlas.normal },
        uFrames: { value: opts.frames },
        uAtlasSize: { value: opts.atlasSize },
        uInfo: { value: this.infos },
        uNear: { value: opts.near },
        uLowQ: { value: opts.lowQ ? 1 : 0 },
        uTime: U.uTime,
        uWind: U.uWind,
        uWindStrength: U.uWindStrength,
        uGust: U.uGust,
        uLightDir: U.uLightDir,
        uLightColor: U.uLightColor,
        uSunDir: U.uSunDir,
        uFogDensity: U.uFogDensity,
        uFogFalloff: U.uFogFalloff,
        uFogBase: U.uFogBase,
        uFogColor: U.uFogColor,
        uFogSun: U.uFogSun,
        uMist: U.uMist,
        uMistHeight: U.uMistHeight,
        uBankZ: U.uBankZ,
        uBankDensity: U.uBankDensity,
        uBankClear: U.uBankClear,
        uLightning: U.uLightning,
        uSkyCube: U.uSkyCube,
        uSkyExposure: U.uSkyExposure,
        uTerrainShadow: U.uTerrainShadow,
        uTerrainInfo: U.uTerrainInfo,
      },
      side: THREE.DoubleSide,
      fog: false,
    });
    this.impostorMat.alphaToCoverage = true;

    this.place(terrain, opts.exclusions, opts.density);
    this.buildImpostorCells();
    this.buildNear();
  }

  private bakeImpostors(renderer: THREE.WebGLRenderer, size: number, N: number) {
    const layers = this.variants.length;
    const mk = (srgb: boolean) => {
      const rt = new THREE.WebGLArrayRenderTarget(size, size, layers, { depthBuffer: true, generateMipmaps: false });
      if (srgb) rt.texture.colorSpace = THREE.SRGBColorSpace;
      rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      return rt;
    };
    const albedoRT = mk(true);
    const normalRT = mk(false);
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    const fs = size / N;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    const mats = this.variants.map((v, i) => {
      const bm = this.barkMats[i];
      const fm = this.foliageMats[i];
      const mkMat = (map: THREE.Texture, repeat: THREE.Vector2, alphaTest: number) =>
        new THREE.ShaderMaterial({
          vertexShader: BAKE_VERT,
          fragmentShader: BAKE_FRAG,
          uniforms: {
            map: { value: map },
            uRepeat: { value: repeat },
            uMode: { value: 0 },
            uAlphaTest: { value: alphaTest },
            uTint: { value: new THREE.Color(1, 1, 1) },
          },
          vertexColors: true,
          side: THREE.DoubleSide,
        });
      return {
        bark: mkMat(bm.map!, new THREE.Vector2(1, 1), -1),
        foliage: fm ? mkMat(fm.map!, new THREE.Vector2(1, 1), 0.45) : null,
      };
    });
    this.variants.forEach((v, li) => {
      const R = Math.max(v.height * 0.5, v.radius) * 1.06;
      const center = new THREE.Vector3(0, v.height * 0.5, 0);
      this.infos.push(new THREE.Vector4(center.y, R, v.height, 0));
      scene.clear();
      const barkMesh = new THREE.Mesh(v.bark, mats[li].bark);
      scene.add(barkMesh);
      let folMesh: THREE.Mesh | null = null;
      if (v.foliage && mats[li].foliage) {
        folMesh = new THREE.Mesh(v.foliage, mats[li].foliage!);
        scene.add(folMesh);
      }
      cam.left = -R;
      cam.right = R;
      cam.top = R;
      cam.bottom = -R;
      cam.near = 0.1;
      cam.far = R * 4;
      cam.updateProjectionMatrix();
      for (const pass of [0, 1]) {
        mats[li].bark.uniforms.uMode.value = pass;
        if (mats[li].foliage) mats[li].foliage!.uniforms.uMode.value = pass;
        const rt = pass === 0 ? albedoRT : normalRT;
        rt.texture.generateMipmaps = false;
        renderer.setRenderTarget(rt, li);
        renderer.setScissorTest(false);
        rt.viewport.set(0, 0, size, size);
        renderer.setRenderTarget(rt, li);
        renderer.clear(true, true, true);
        for (let j = 0; j < N; j++)
          for (let i = 0; i < N; i++) {
            const ex = ((i + 0.5) / N) * 2 - 1,
              ey = ((j + 0.5) / N) * 2 - 1;
            const tx = (ex + ey) * 0.5,
              tz = (ex - ey) * 0.5;
            const dir = new THREE.Vector3(tx, 1 - Math.abs(tx) - Math.abs(tz), tz).normalize();
            dir.y = Math.max(dir.y, 0.02);
            dir.normalize();
            cam.position.copy(center).addScaledVector(dir, R * 2);
            cam.up.set(0, 1, 0);
            cam.lookAt(center);
            cam.updateMatrixWorld();
            rt.viewport.set(i * fs, j * fs, fs, fs);
            rt.scissor.set(i * fs, j * fs, fs, fs);
            rt.scissorTest = true;
            renderer.setRenderTarget(rt, li);
            renderer.render(scene, cam);
          }
        rt.scissorTest = false;
        rt.viewport.set(0, 0, size, size);
      }
    });
    // mipmaps
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    for (const rt of [albedoRT, normalRT]) {
      rt.texture.generateMipmaps = true;
      renderer.setRenderTarget(rt, 0);
      // rendering nothing still triggers mip generation at the end of a render call
      renderer.render(new THREE.Scene(), cam);
    }
    renderer.autoClear = ac;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    return { albedo: albedoRT.texture, normal: normalRT.texture };
  }

  private place(terrain: Terrain, exclusions: Exclusion[], density: number) {
    const rng = new RNG(8080);
    const spacing = 6.2 / Math.sqrt(density);
    const minX = WORLD.minX + 4,
      minZ = WORLD.minZ + 4,
      maxX = WORLD.minX + WORLD.size - 4,
      maxZ = WORLD.minZ + WORLD.size - 4;
    const excluded = (x: number, z: number) => {
      for (const e of exclusions) {
        if ('r' in e) {
          if ((x - e.x) ** 2 + (z - e.z) ** 2 < e.r * e.r) return true;
        } else if (x > e.x0 && x < e.x1 && z > e.z0 && z < e.z1) return true;
      }
      return false;
    };
    for (let z = minZ; z < maxZ; z += spacing) {
      for (let x = minX; x < maxX; x += spacing) {
        const jx = x + (rng.next() - 0.5) * spacing * 0.9;
        const jz = z + (rng.next() - 0.5) * spacing * 0.9;
        const s = terrain.surfaceAt(jx, jz);
        let p = s.forest;
        // lone trees in meadows
        p = Math.max(p, s.meadow * 0.012);
        if (s.road > 0.05 || s.water > 0.01) continue;
        if (rng.next() > p) continue;
        const h = terrain.heightAt(jx, jz);
        if (h < 2.5) continue;
        const n = terrain.normalAt(jx, jz);
        if (n.y < 0.72) continue;
        if (excluded(jx, jz)) continue;
        // Keep the overlook's view open (old clear-cut below the lay-by)
        {
          const dx = jx - P.overlook.x,
            dz = jz - P.overlook.z;
          const d = Math.hypot(dx, dz);
          const cos = (dx * 0.18 + dz * 0.98) / Math.max(d, 1);
          if (d < 330 && cos > 0.55 - (d < 40 ? 0.9 : 0)) {
            if (d < 60 || rng.next() > 0.03) continue;
          }
        }
        // species
        const coast = smoothstep(420, 140, Math.hypot(jx - 0, jz - 300) * 0.6 + Math.max(0, 220 - jz) * 0.8);
        const riverSide = this.nearRiver(terrain, jx, jz);
        const r = hash2(Math.floor(jx * 3), Math.floor(jz * 3), 17);
        let v: number;
        if (rng.chance(0.015)) v = 5; // snag
        else if (riverSide > 0.3 && r < 0.55) v = 4; // alder
        else if (coast > 0.4 && r < 0.75) v = 3; // spruce
        else if (r < 0.3) v = 2; // hemlock
        else v = r < 0.66 ? 0 : 1; // firs
        const scale = v === 4 ? rng.range(0.8, 1.15) : rng.range(0.72, 1.25);
        this.trees.push({ x: jx, y: h - 0.25, z: jz, s: scale, yaw: rng.range(0, Math.PI * 2), v });
      }
    }
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      const key = this.cellKey(t.x, t.z);
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, (arr = []));
      arr.push(i);
      const tr = this.variants[t.v].trunkRadius * t.s;
      this.colliders.push({ x: t.x, z: t.z, r: Math.max(0.2, tr * 0.9) });
    }
  }

  private riverPts: { x: number; z: number }[] | null = null;
  private nearRiver(terrain: Terrain, x: number, z: number) {
    if (!this.riverPts) this.riverPts = terrain.data.riverSamples.filter((p) => p.z < 210).map((p) => ({ x: p.x, z: p.z }));
    let d = 1e9;
    for (let i = 0; i < this.riverPts.length; i += 2) {
      const p = this.riverPts[i];
      const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (dd < d) d = dd;
    }
    const town = 1 - smoothstep(150, 260, Math.hypot(x - P.townCenter.x, z - P.townCenter.z));
    return Math.max(1 - smoothstep(15, 60, Math.sqrt(d)), town * 0.6);
  }

  private cellKey(x: number, z: number) {
    return Math.floor((x + 5000) / this.cellSize) * 100000 + Math.floor((z + 5000) / this.cellSize);
  }

  private buildImpostorCells() {
    const CELL = 256;
    const buckets = new Map<string, TreeInstance[]>();
    for (const t of this.trees) {
      const k = `${Math.floor(t.x / CELL)},${Math.floor(t.z / CELL)}`;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(t);
    }
    const quad = new THREE.PlaneGeometry(2, 2);
    for (const list of buckets.values()) {
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute('position', quad.getAttribute('position'));
      const pos = new Float32Array(list.length * 4);
      const rot = new Float32Array(list.length * 2);
      const box = new THREE.Box3();
      list.forEach((t, i) => {
        pos.set([t.x, t.y, t.z, t.s], i * 4);
        rot.set([t.yaw, t.v], i * 2);
        box.expandByPoint(new THREE.Vector3(t.x, t.y, t.z));
        box.expandByPoint(new THREE.Vector3(t.x, t.y + 35 * t.s, t.z));
      });
      box.expandByScalar(12);
      g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 4));
      g.setAttribute('aRot', new THREE.InstancedBufferAttribute(rot, 2));
      g.instanceCount = list.length;
      g.boundingBox = box;
      g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const m = new THREE.Mesh(g, this.impostorMat);
      m.layers.set(LAYER.OPAQUE);
      m.castShadow = false;
      m.receiveShadow = false;
      this.impostorGroup.add(m);
    }
  }

  private buildNear() {
    this.variants.forEach((v, i) => {
      const bark = new THREE.InstancedMesh(v.bark, this.barkMats[i], this.maxNear);
      bark.count = 0;
      bark.castShadow = true;
      bark.receiveShadow = true;
      bark.frustumCulled = false;
      let fol: THREE.InstancedMesh | null = null;
      if (v.foliage) {
        fol = new THREE.InstancedMesh(v.foliage, this.foliageMats[i], this.maxNear);
        fol.instanceMatrix = bark.instanceMatrix; // share instances
        fol.count = 0;
        fol.castShadow = true;
        fol.receiveShadow = true;
        fol.frustumCulled = false;
      }
      bark.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.near.push({ bark, foliage: fol, attr: bark.instanceMatrix });
    });
  }

  /** Plain (non-instanced) materials for one-off trees such as the fallen spruce. */
  staticMaterials(i: number) {
    const bm = this.barkMats[i],
      fm = this.foliageMats[i];
    const bark = new THREE.MeshStandardMaterial({ map: bm.map, normalMap: bm.normalMap, roughness: 0.9 });
    const foliage = fm
      ? new THREE.MeshStandardMaterial({ map: fm.map, alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.85, color: 0xb8a878 })
      : null;
    return { bark, foliage };
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.impostorGroup);
    for (const n of this.near) {
      scene.add(n.bark);
      if (n.foliage) scene.add(n.foliage);
    }
  }

  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private sv = new THREE.Vector3();
  private pv = new THREE.Vector3();
  private yAxis = new THREE.Vector3(0, 1, 0);

  update(camera: THREE.Camera) {
    const cp = camera.position;
    if (cp.distanceToSquared(this.lastCam) < 0.5) return;
    this.lastCam.copy(cp);
    const R = this.nearRange + 4;
    const counts = new Array(this.variants.length).fill(0);
    const c0x = Math.floor((cp.x - R + 5000) / this.cellSize),
      c1x = Math.floor((cp.x + R + 5000) / this.cellSize);
    const c0z = Math.floor((cp.z - R + 5000) / this.cellSize),
      c1z = Math.floor((cp.z + R + 5000) / this.cellSize);
    for (let cx = c0x; cx <= c1x; cx++)
      for (let cz = c0z; cz <= c1z; cz++) {
        const arr = this.grid.get(cx * 100000 + cz);
        if (!arr) continue;
        for (const ti of arr) {
          const t = this.trees[ti];
          const dx = t.x - cp.x,
            dz = t.z - cp.z,
            dy = t.y + 8 - cp.y;
          if (dx * dx + dz * dz + dy * dy > R * R) continue;
          const n = this.near[t.v];
          const k = counts[t.v]++;
          if (k >= this.maxNear) continue;
          this.q.setFromAxisAngle(this.yAxis, t.yaw);
          this.m4.compose(this.pv.set(t.x, t.y, t.z), this.q, this.sv.set(t.s, t.s, t.s));
          n.bark.setMatrixAt(k, this.m4);
        }
      }
    this.near.forEach((n, i) => {
      const c = Math.min(counts[i], this.maxNear);
      n.bark.count = c;
      if (n.foliage) n.foliage.count = c;
      n.attr.needsUpdate = true;
      n.attr.clearUpdateRanges();
      n.attr.addUpdateRange(0, c * 16);
    });
  }
}

/** Wind sway, translucency and distance fade for mesh trees. */
function patchTreeMaterial(mat: THREE.MeshStandardMaterial, foliage: boolean, near: number) {
  const uNear = { value: near };
  mat.onBeforeCompile = (shader) => {
    injectGlobals(shader);
    shader.uniforms.uTreeNear = uNear;
    shader.defines = shader.defines ?? {};
    if (foliage) shader.defines.BW_TRANSLUCENT = '';
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 color;
        uniform float uTime;
        uniform vec3 uWind;
        uniform float uWindStrength;
        uniform float uGust;
        uniform float uTreeNear;
        varying float vTreeFade;
        varying float vTreeAO;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = ip.x * 0.07 + ip.z * 0.05;
          float sw = color.r;
          float w = uWindStrength;
          // whole-tree sway (local space; instance rotation is yaw only)
          vec3 wl = vec3(uWind.x, 0.0, uWind.z);
          float c = instanceMatrix[0][0], s = instanceMatrix[2][0];
          float sc = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
          vec3 wLocal = vec3(c * wl.x - s * wl.z, 0.0, s * wl.x + c * wl.z) / max(sc * sc, 1e-4);
          float sway = (sin(uTime * 0.7 + ph) * 0.5 + 0.3 + uGust * 0.7) * w;
          transformed += wLocal * sway * sw * 0.9;
          // branch flutter
          float fl = color.g;
          transformed += normal * fl * sin(uTime * (3.0 + w * 3.0) + dot(position, vec3(1.3, 0.7, 1.1)) + ph) * 0.05 * (0.3 + w);
          vec3 wpos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          float d = distance(cameraPosition, ip);
          vTreeFade = 1.0 - smoothstep(uTreeNear - 3.0, uTreeNear + 3.0, d);
          vTreeAO = color.b;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vTreeFade;
        varying float vTreeAO;
        float bwIGN2(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
        float bwTranslucency(vec3 L, vec3 V, vec3 N) {
          return pow(max(dot(-V, L), 0.0), 4.0) * 0.6 + max(dot(-N, L), 0.0) * 0.15;
        }`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (bwIGN2(gl_FragCoord.xy) > vTreeFade) discard;`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= mix(0.45, 1.0, vTreeAO);
        reflectedLight.indirectSpecular *= mix(0.3, 1.0, vTreeAO);`,
      );
  };
  mat.customProgramCacheKey = () => (foliage ? 'bw-tree-fol' : 'bw-tree-bark');
}

export { clamp };
