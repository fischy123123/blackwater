// Ground cover around the camera: grass clumps on open ground and ferns under the trees.
// Instances live on a camera-snapped grid (stable in world space); placement, masks,
// slope, roofs/roads (via the rain occlusion map) and wind are all evaluated on the GPU.
import * as THREE from 'three';
import { U } from '../render/Globals';
import { TERRAIN_HEIGHT_GLSL, type Terrain } from './Terrain';
import { GLSL_NOISE, injectGlobals } from '../render/Chunks';

const OCC_OFFSET = 64;

function bladeGeometry(kind: 'grass' | 'fern') {
  const pos: number[] = [];
  const nrm: number[] = [];
  const blade: number[] = []; // x: along (0 root .. 1 tip), y: across (-1..1)
  const idx: number[] = [];
  if (kind === 'grass') {
    // three crossed cards, each painted with dozens of blades
    for (let c = 0; c < 3; c++) {
      const a = (c / 3) * Math.PI + 0.3;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const W = 0.55,
        Hh = 1.0;
      const base = pos.length / 3;
      for (let s = 0; s <= 2; s++) {
        const t = s / 2;
        for (const side of [-1, 1]) {
          pos.push(ca * side * W, Hh * t, sa * side * W);
          nrm.push(0, 1, 0);
          blade.push(t, side);
        }
        if (s < 2) {
          const i0 = base + s * 2;
          idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
        }
      }
    }
  } else {
    const blades = 6;
    const segs = 5;
    for (let b = 0; b < blades; b++) {
      const a = (b / blades) * Math.PI * 2 + (b % 2) * 0.4;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const base = pos.length / 3;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        // frond: rises then arches outward and down
        const w = 0.09 * Math.sin(Math.min(1, t * 1.15) * Math.PI) * (1 - t * 0.3) + 0.004;
        const x = 0.02 + 0.85 * t;
        const y = 0.55 * Math.sin(t * Math.PI * 0.62) - t * t * 0.18;
        for (const side of [-1, 1]) {
          pos.push(x * ca - side * w * sa, y, x * sa + side * w * ca);
          nrm.push(ca * 0.5, 0.85, sa * 0.5);
          blade.push(t, side);
        }
        if (s < segs) {
          const i0 = base + s * 2;
          idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
        }
      }
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 2));
  g.setIndex(idx);
  return g;
}

/** A card full of grass blades: alpha = blade coverage, rgb = per-blade shade / straw tips. */
function grassTexture() {
  const W = 512,
    H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 150; i++) {
    const x0 = 6 + rnd() * (W - 12);
    const h = H * (0.35 + 0.62 * Math.pow(rnd(), 0.7));
    const lean = (rnd() - 0.5) * 70;
    const w0 = 3 + rnd() * 4.5;
    const shade = 150 + rnd() * 105;
    const straw = rnd();
    const steps = 14;
    g.beginPath();
    const left: [number, number][] = [],
      right: [number, number][] = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = x0 + lean * t * t;
      const y = H - t * h;
      const w = w0 * Math.pow(1 - t, 0.8) + 0.4;
      left.push([x - w, y]);
      right.push([x + w, y]);
    }
    g.moveTo(left[0][0], left[0][1]);
    for (const p of left) g.lineTo(p[0], p[1]);
    for (let k = right.length - 1; k >= 0; k--) g.lineTo(right[k][0], right[k][1]);
    g.closePath();
    const grad = g.createLinearGradient(0, H, 0, H - h);
    const s0 = Math.round(shade * 0.55);
    grad.addColorStop(0, `rgb(${s0},${s0},${s0})`);
    const tip = straw > 0.55 ? `rgb(${Math.round(shade * 1.0)},${Math.round(shade * 0.9)},${Math.round(shade * 0.62)})` : `rgb(${Math.round(shade)},${Math.round(shade)},${Math.round(shade * 0.9)})`;
    grad.addColorStop(1, tip);
    g.fillStyle = grad;
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

const VERT_PARS = /* glsl */ `
attribute vec2 aBlade;
uniform vec3 uGCenter;
uniform float uGSpacing;
uniform float uGN;
uniform float uGRadius;
uniform float uGKind;
uniform float uGDensity;
uniform sampler2D uSurfaceTex;
uniform sampler2D uNormalTex;
uniform sampler2D uOccTex;
uniform vec4 uOccInfo;
uniform float uTime;
uniform vec3 uWind;
uniform float uWindStrength;
uniform float uGust;
${TERRAIN_HEIGHT_GLSL}
${GLSL_NOISE}
varying float vGT;
varying float vGSide;
varying vec3 vGTint;
`;

const VERT_PLACE = /* glsl */ `
  float gKeep = 0.0;
  vec3 gRoot = vec3(0.0);
  float gScale = 0.0;
  mat2 gRot = mat2(1.0);
  vec3 gTint = vec3(1.0);
  {
    float fid = float(gl_InstanceID);
    vec2 ij = vec2(mod(fid, uGN), floor(fid / uGN));
    vec2 cell = floor(uGCenter.xz / uGSpacing) + ij - floor(uGN * 0.5);
    vec2 h = bwHash22(cell * 1.37 + uGKind * 17.0);
    float h2 = bwHash12(cell * 2.11 + 3.7 + uGKind);
    vec2 xz = (cell + h) * uGSpacing;
    float dist = length(xz - cameraPosition.xz);
    if (dist < uGRadius) {
      vec2 tuv = (xz - uTerrainInfo.xy) / uTerrainInfo.z;
      vec4 S = texture2D(uSurfaceTex, tuv);
      vec2 nxz = texture2D(uNormalTex, tuv).xy * 2.0 - 1.0;
      float ny = sqrt(max(1.0 - dot(nxz, nxz), 0.0));
      float slope = 1.0 - ny;
      float y = bwTerrainHeight(xz);
      float n1 = bwVNoise(xz * 0.018);
      float land = smoothstep(1.2, 2.6, y - (n1 - 0.5) * 1.2);
      float rockK = smoothstep(0.3, 0.5, slope);
      float grassW = max(S.b, 0.15) * (1.0 - S.r);
      float sum = grassW + S.r * 1.2 + S.g * 1.6 + 1e-3;
      float dens;
      if (uGKind < 0.5) {
        dens = land * (1.0 - rockK) * sqrt(grassW / sum);
        dens *= 0.6 + 0.8 * smoothstep(0.3, 0.7, bwVNoise(xz * 0.08 + 4.0)); // patchy
      } else {
        dens = land * (1.0 - rockK) * smoothstep(0.35, 0.8, S.r) * (0.4 + 0.8 * smoothstep(0.4, 0.7, bwVNoise(xz * 0.05 + 9.0)));
      }
      dens *= 1.0 - smoothstep(0.02, 0.2, S.g); // roads & shoulders
      dens *= 1.0 - step(0.01, S.a);            // standing water
      dens *= uGDensity;
      dens *= 1.0 - 0.65 * smoothstep(uGRadius * 0.35, uGRadius, dist);
      if (h2 < dens) {
        // roofs, porches, roads and decks from the occlusion map
        bool covered = false;
        if (uOccInfo.w > 0.5) {
          vec2 ouv = vec2((xz.x - uOccInfo.x) / uOccInfo.z + 0.5, 0.5 - (xz.y - uOccInfo.y) / uOccInfo.z);
          if (ouv.x > 0.0 && ouv.y > 0.0 && ouv.x < 1.0 && ouv.y < 1.0) {
            float o = textureLod(uOccTex, ouv, 0.0).r;
            covered = o > 0.5 && (o - ${OCC_OFFSET.toFixed(1)}) > y + 0.08;
          }
        }
        if (!covered) {
          gKeep = 1.0;
          gRoot = vec3(xz.x, y - 0.03, xz.y);
          float grow = 1.0 - smoothstep(uGRadius * 0.8, uGRadius, dist);
          gScale = (uGKind < 0.5 ? mix(0.34, 0.62, h.y) : mix(0.55, 0.95, h.y)) * grow * (1.0 + 0.35 * smoothstep(uGRadius * 0.4, uGRadius, dist));
          float a = h.x * 6.2832;
          gRot = mat2(cos(a), -sin(a), sin(a), cos(a));
          // late-October palette: green, straw, rust
          float v = bwVNoise(xz * 0.21 + 2.0);
          vec3 green = vec3(0.23, 0.33, 0.1);
          vec3 straw = vec3(0.52, 0.45, 0.24);
          vec3 rust = vec3(0.45, 0.25, 0.1);
          gTint = uGKind < 0.5 ? mix(mix(green, straw, smoothstep(0.35, 0.75, v)), rust, 0.25 * step(0.8, h2 * 5.0 - floor(h2 * 5.0))) : mix(vec3(0.16, 0.26, 0.07), vec3(0.42, 0.3, 0.12), smoothstep(0.55, 0.85, v));
          gTint *= 0.85 + 0.3 * h2;
        }
      }
    }
  }
  vec3 objectNormal = vec3(normal);
  objectNormal.xz = gRot * objectNormal.xz;
`;

const VERT_POS = /* glsl */ `
  vec3 transformed = vec3(position);
  {
    transformed.xz = gRot * transformed.xz;
    transformed *= gScale;
    float t = aBlade.x;
    // wind: coherent gusts rolling across the field + a faster flutter
    float wave = sin(uTime * 1.6 - dot(gRoot.xz, uWind.xz) * 0.35 + gRoot.x * 0.05) * 0.5 + 0.5;
    float sway = (0.25 + wave * 0.75) * (0.35 + uGust) * uWindStrength;
    float flutter = sin(uTime * 7.0 + gRoot.x * 3.1 + gRoot.z * 2.3 + t * 2.0) * 0.04 * uWindStrength;
    transformed.xz += uWind.xz * (sway * 0.5 + flutter) * t * t * gScale * 1.4;
    transformed.y -= sway * 0.12 * t * t * gScale;
    // push aside around the walker
    vec2 away = gRoot.xz + transformed.xz - cameraPosition.xz;
    float dd = length(away);
    float push = smoothstep(0.9, 0.1, dd) * step(abs(cameraPosition.y - 1.6 - gRoot.y), 1.5);
    transformed.xz += away / max(dd, 1e-3) * push * t * 0.28;
    transformed.y -= push * t * 0.12 * gScale;
    transformed += gRoot;
    if (gKeep < 0.5) transformed = vec3(0.0, -1.0e5, 0.0);
    vGT = t;
    vGSide = aBlade.y;
    vGTint = gTint;
  }
`;

export class GroundCover {
  meshes: THREE.Mesh[] = [];
  private uniforms: Record<string, THREE.IUniform>;
  private spacing: number[] = [];

  constructor(scene: THREE.Scene, terrain: Terrain, radius: number, density: number) {
    this.uniforms = {
      uGCenter: { value: new THREE.Vector3() },
      uSurfaceTex: { value: terrain.surfaceTex },
      uNormalTex: { value: terrain.normalTex },
    };
    const make = (kind: 'grass' | 'fern', spacing: number, R: number) => {
      const N = Math.ceil((2 * R) / spacing);
      const g = bladeGeometry(kind);
      g.instanceCount = N * N;
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
      if (kind === 'grass') {
        mat.map = grassTexture();
        mat.alphaToCoverage = true;
        mat.transparent = false;
      }
      const own = {
        uGSpacing: { value: spacing },
        uGN: { value: N },
        uGRadius: { value: R },
        uGKind: { value: kind === 'grass' ? 0 : 1 },
        uGDensity: { value: Math.min(2.2, density * (kind === 'grass' ? 2.4 : 1.2)) },
      };
      mat.onBeforeCompile = (shader) => {
        injectGlobals(shader);
        Object.assign(shader.uniforms, this.uniforms, own);
        shader.defines = shader.defines ?? {};
        shader.defines.BW_TRANSLUCENT = '';
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
          .replace('#include <beginnormal_vertex>', VERT_PLACE)
          .replace('#include <begin_vertex>', VERT_POS);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <map_fragment>', '')
          .replace(
            '#include <common>',
            `#include <common>
            varying float vGT;
            varying float vGSide;
            varying vec3 vGTint;
            float bwTranslucency(vec3 L, vec3 V, vec3 N) {
              return pow(max(dot(-V, L), 0.0), 3.0) * 0.9 + 0.12;
            }`,
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            ${
              kind === 'fern'
                ? `diffuseColor.rgb = vGTint * mix(0.42, 1.12, pow(vGT, 0.8));
            if (abs(fract(vGT * 14.0) - 0.5) > 0.5 - 0.18 * (1.0 - abs(vGSide)) && vGT > 0.1) discard;`
                : `{
              vec4 gTex = texture2D(map, vec2(vGSide * 0.5 + 0.5, vGT));
              // sharpen alpha so coverage survives mipmapping (alpha-to-coverage)
              float a = (gTex.a - 0.35) / max(fwidth(gTex.a), 1e-4) + 0.5;
              if (a < 0.02) discard;
              diffuseColor.a = clamp(a, 0.0, 1.0);
              diffuseColor.rgb = vGTint * gTex.rgb * 1.6;
            }`
            }`,
          )
          .replace(
            '#include <aomap_fragment>',
            `#include <aomap_fragment>
            reflectedLight.indirectDiffuse *= mix(0.35, 1.0, vGT);`,
          );
      };
      mat.customProgramCacheKey = () => 'bw-gc-' + kind;
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.uniforms = own;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = 'groundcover-' + kind;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.spacing.push(spacing);
    };
    const base = 0.5 / Math.sqrt(Math.max(0.2, density));
    make('grass', base, radius);
    make('fern', base * 2.4, Math.min(radius, 26));
    void U;
  }

  update(camera: THREE.Camera) {
    (this.uniforms.uGCenter.value as THREE.Vector3).copy(camera.position);
  }
}
