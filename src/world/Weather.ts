// Weather particles: rain streaks (occluded by roofs), splashes, lightning bolts,
// falling leaves, moths around lamps and dust motes that only show in the flashlight.
import * as THREE from 'three';
import { U, LAYER } from '../render/Globals';
import { TERRAIN_HEIGHT_GLSL } from './Terrain';
import { GLSL_NOISE, GLSL_FOG_FN, GLSL_FOG_UNIFORMS } from '../render/Chunks';
import { fogUniforms } from '../render/WindowShader';
import type { Environment } from './Environment';
import type { LightManager } from './Lights';
import { RNG, clamp, smoothstep, damp } from '../core/math';

const OCC_OFFSET = 64; // heights are stored +64 so a cleared (0) texel means "nothing here"

// ----------------------------------------------------------------------------- shared GLSL
const OCC_GLSL = /* glsl */ `
uniform sampler2D uOccTex;
uniform vec4 uOccInfo; // cx, cz, size, enabled
${TERRAIN_HEIGHT_GLSL}
float bwSurfaceAt(vec2 xz) {
  float g = bwTerrainHeight(xz);
  if (uOccInfo.w > 0.5) {
    vec2 ouv = vec2((xz.x - uOccInfo.x) / uOccInfo.z + 0.5, 0.5 - (xz.y - uOccInfo.y) / uOccInfo.z);
    if (ouv.x > 0.0 && ouv.y > 0.0 && ouv.x < 1.0 && ouv.y < 1.0) {
      float o = textureLod(uOccTex, ouv, 0.0).r;
      if (o > 0.5) g = max(g, o - ${OCC_OFFSET.toFixed(1)});
    }
  }
  return g;
}`;

const LIGHTS_GLSL = /* glsl */ `
uniform vec4 uPLPos[6];  // xyz, range
uniform vec3 uPLCol[6];  // colour * intensity (pre-exposed)
uniform vec3 uFlashPos;
uniform vec3 uFlashDir;
uniform float uFlashI;
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform float uHeadI;
vec3 bwLocalLight(vec3 p, vec3 viewDir, float fwd) {
  vec3 L = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    vec3 d = uPLPos[i].xyz - p;
    float dd = dot(d, d);
    float r = uPLPos[i].w;
    float win = clamp(1.0 - dd / (r * r), 0.0, 1.0);
    // droplets scatter strongly forward: bright when the lamp is behind them
    float ph = 1.0 + fwd * pow(max(dot(normalize(d), viewDir), 0.0), 8.0);
    L += uPLCol[i] / max(dd, 0.25) * win * win * ph;
  }
  if (uFlashI > 0.0) {
    vec3 d = p - uFlashPos;
    float l = length(d);
    float cone = smoothstep(0.84, 0.96, dot(d / max(l, 1e-3), uFlashDir));
    L += vec3(1.0, 0.94, 0.84) * uFlashI * cone / max(l * l, 0.3);
  }
  if (uHeadI > 0.0) {
    vec3 d = p - uHeadPos;
    float l = length(d);
    float cone = smoothstep(0.82, 0.95, dot(d / max(l, 1e-3), uHeadDir));
    L += vec3(1.0, 0.94, 0.86) * uHeadI * cone / max(l * l, 0.5);
  }
  return L;
}`;

// ----------------------------------------------------------------------------- rain
const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed; // xyz position in box, w activation threshold
attribute float aSpeed;
uniform vec3 uCam;
uniform vec3 uBox;
uniform float uT;
uniform float uFall;
uniform vec2 uWindV;
uniform float uAmount;
uniform float uStreak;
${OCC_GLSL}
varying float vAlpha;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  float speed = uFall * aSpeed;
  vec3 vel = vec3(uWindV.x, -speed, uWindV.y);
  vec3 base = aSeed.xyz * uBox + vel * uT;
  vec3 p = uCam + (fract((base - uCam) / uBox) - 0.5) * uBox;
  float isOn = step(aSeed.w, uAmount);
  float ground = bwSurfaceAt(p.xz);
  float vis = isOn * step(ground, p.y);
  vec3 tail = p - vel * uStreak;
  vec3 wp = mix(tail, p, position.y);
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 side = normalize(cross(normalize(vel), toCam / max(dist, 1e-3)));
  float width = 0.0025 + dist * 0.0011;
  wp += side * position.x * width;
  vAlpha = vis * smoothstep(0.35, 1.4, dist) * (1.0 - smoothstep(uBox.x * 0.3, uBox.x * 0.5, dist));
  vUv = position.xy;
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (vis < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const RAIN_FRAG = /* glsl */ `
uniform vec3 uAmbient;
uniform float uLightning;
uniform float uBright;
${LIGHTS_GLSL}
varying float vAlpha;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  float across = 1.0 - abs(vUv.x);
  float a = vAlpha * across * across * smoothstep(0.0, 0.35, vUv.y);
  if (a < 0.003) discard;
  vec3 V = normalize(vWorld - cameraPosition);
  vec3 L = uAmbient * 1.4 + vec3(0.55, 0.62, 0.85) * uLightning * 1.5 + bwLocalLight(vWorld, V, 4.0);
  gl_FragColor = vec4(L * uBright, a);
}`;

// ----------------------------------------------------------------------------- splashes
const SPLASH_VERT = /* glsl */ `
attribute vec3 aSeed;
uniform vec3 uCam;
uniform float uT;
uniform float uRadius;
uniform float uAmount;
${OCC_GLSL}
${GLSL_NOISE}
varying vec2 vUv;
varying float vPhase;
varying float vAlpha;
varying vec3 vWorld;
void main() {
  float rate = 3.0 + aSeed.z * 2.0;
  float cyc = uT * rate + aSeed.z * 17.0;
  float ci = floor(cyc);
  float ph = cyc - ci;
  vec2 h = bwHash22(aSeed.xy * 97.0 + ci * 1.37) - 0.5;
  vec2 xz = uCam.xz + h * uRadius * 2.0;
  float y = bwSurfaceAt(xz);
  float isOn = step(aSeed.x, uAmount) * step(length(h), 0.5);
  float s = 0.05 + ph * 0.1;
  vec3 toCam = normalize(cameraPosition - vec3(xz.x, y, xz.y));
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 wp = vec3(xz.x, y + 0.012, xz.y) + right * position.x * s + vec3(0.0, 1.0, 0.0) * (position.y * 0.5 + 0.5) * s * 1.2;
  vUv = position.xy;
  vPhase = ph;
  float d = distance(cameraPosition, wp);
  vAlpha = isOn * (1.0 - smoothstep(uRadius * 0.6, uRadius, d)) * step(abs(cameraPosition.y - y), 20.0);
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (vAlpha < 0.01) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const SPLASH_FRAG = /* glsl */ `
uniform vec3 uAmbient;
uniform float uLightning;
${LIGHTS_GLSL}
varying vec2 vUv;
varying float vPhase;
varying float vAlpha;
varying vec3 vWorld;
void main() {
  // a small crown: droplets thrown up and out, fading as they fall back
  vec2 p = vec2(vUv.x, vUv.y * 0.5 + 0.5);
  float ph = vPhase;
  float c = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float dx = (fi - 1.5) * 0.28 * ph * 2.2;
    float dy = (ph * 1.6 - ph * ph * 1.9) * (0.8 + 0.2 * mod(fi, 2.0));
    c += smoothstep(0.1, 0.0, length(p - vec2(dx, dy)));
  }
  float ring = smoothstep(0.08, 0.0, abs(length(vec2(vUv.x, p.y * 4.0)) - ph * 0.9)) * step(p.y, 0.12);
  float a = (c * (1.0 - ph) + ring * (1.0 - ph) * 0.6) * vAlpha;
  if (a < 0.01) discard;
  vec3 V = normalize(vWorld - cameraPosition);
  vec3 L = uAmbient * 1.3 + vec3(0.55, 0.62, 0.85) * uLightning + bwLocalLight(vWorld, V, 1.0);
  gl_FragColor = vec4(L * 0.9, a * 0.8);
}`;

// ----------------------------------------------------------------------------- bolts
const BOLT_VERT = /* glsl */ `
attribute vec3 aNext;
attribute float aSide;
attribute float aWidth;
attribute float aBright;
varying float vBright;
varying float vSide;
void main() {
  vec3 dir = normalize(aNext - position);
  vec3 toCam = normalize(cameraPosition - position);
  vec3 side = normalize(cross(dir, toCam));
  vec3 wp = position + side * aSide * aWidth;
  vBright = aBright;
  vSide = aSide;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const BOLT_FRAG = /* glsl */ `
uniform float uFlash;
varying float vBright;
varying float vSide;
void main() {
  float core = exp(-vSide * vSide * 6.0);
  gl_FragColor = vec4(vec3(0.82, 0.86, 1.0) * core * vBright * uFlash, 1.0);
}`;

// ----------------------------------------------------------------------------- leaves
const LEAF_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam;
uniform vec3 uBox;
uniform float uT;
uniform vec2 uWindV;
uniform float uAmount;
uniform float uGust;
${OCC_GLSL}
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vN;
varying float vAlpha;
varying vec3 vTint;
void main() {
  float fall = 0.55 + aSeed.w * 0.5;
  vec3 vel = vec3(uWindV.x * (0.8 + uGust), -fall, uWindV.y * (0.8 + uGust));
  vec3 base = aSeed.xyz * uBox + vel * uT;
  // flutter
  float t = uT * (1.5 + aSeed.w * 2.0) + aSeed.x * 40.0;
  base += vec3(sin(t) * 0.35, sin(t * 1.7) * 0.1, cos(t * 0.8) * 0.35);
  vec3 p = uCam + (fract((base - uCam) / uBox) - 0.5) * uBox;
  float ground = bwSurfaceAt(p.xz);
  float vis = step(aSeed.w, uAmount) * step(ground, p.y);
  // tumbling orientation
  float a1 = t * 1.3, a2 = t * 0.9;
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cos(a1), sin(a1), 0.0, -sin(a1), cos(a1));
  mat3 ry = mat3(cos(a2), 0.0, -sin(a2), 0.0, 1.0, 0.0, sin(a2), 0.0, cos(a2));
  vec3 lp = ry * rx * vec3(position.x * 0.045, position.y * 0.03, 0.0);
  vec3 wp = p + lp;
  vN = ry * rx * vec3(0.0, 0.0, 1.0);
  vUv = position.xy;
  vWorld = wp;
  float d = distance(cameraPosition, wp);
  vAlpha = vis * (1.0 - smoothstep(uBox.x * 0.3, uBox.x * 0.5, d));
  float h = fract(aSeed.x * 13.7 + aSeed.z * 7.1);
  vTint = mix(vec3(0.55, 0.28, 0.06), vec3(0.62, 0.48, 0.12), h);
  vTint = mix(vTint, vec3(0.35, 0.2, 0.1), step(0.7, fract(aSeed.y * 9.3)));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (vAlpha < 0.01) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const LEAF_FRAG = /* glsl */ `
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform vec3 uAmbient;
uniform vec3 uSunColor;
${LIGHTS_GLSL}
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vN;
varying float vAlpha;
varying vec3 vTint;
void main() {
  float r = length(vec2(vUv.x, vUv.y * 1.4));
  if (r > 1.0 || vAlpha < 0.5) discard;
  vec3 n = normalize(vN);
  vec3 V = normalize(vWorld - cameraPosition);
  float ndl = abs(dot(n, uSunDir));
  vec3 L = uAmbient * 1.2 + uSunColor * (ndl * 0.8 + 0.25) * bwTerrainShadowAt(vWorld) + bwLocalLight(vWorld, V, 0.0) * 0.5;
  vec3 col = vTint * L;
  col = bwApplyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}`;

// ----------------------------------------------------------------------------- moths & motes
const SPECK_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uT;
uniform vec4 uMothLights[8];
uniform vec3 uMothCols[8];
uniform int uMode; // 0 moths, 1 motes
uniform vec3 uCam;
uniform float uFlashI;
uniform vec3 uFlashPos;
uniform vec3 uFlashDir;
varying float vA;
varying vec3 vCol;
varying vec2 vUv;
void main() {
  vec3 p;
  vec3 col;
  float size;
  float a = 1.0;
  if (uMode == 0) {
    int li = int(aSeed.w * 8.0);
    vec4 L = uMothLights[li];
    float t = uT * (1.2 + aSeed.x * 1.5);
    float r = 0.35 + aSeed.y * 0.6;
    p = L.xyz + vec3(sin(t * 2.3 + aSeed.z * 20.0) * r, sin(t * 3.1 + aSeed.x * 11.0) * 0.35 - 0.25, cos(t * 1.9 + aSeed.y * 30.0) * r);
    p += vec3(sin(t * 17.0), sin(t * 23.0), cos(t * 19.0)) * 0.04;
    col = uMothCols[li];
    a = L.w;
    size = 0.012;
  } else {
    vec3 box = vec3(7.0, 4.0, 7.0);
    vec3 base = aSeed.xyz * box + vec3(sin(uT * 0.07 + aSeed.w * 6.0), sin(uT * 0.05 + aSeed.x * 5.0) * 0.5 - 0.1, cos(uT * 0.06 + aSeed.y * 7.0)) * 0.8;
    p = uCam + (fract((base - uCam) / box) - 0.5) * box;
    vec3 d = p - uFlashPos;
    float l = length(d);
    float cone = smoothstep(0.88, 0.97, dot(d / max(l, 1e-3), uFlashDir));
    col = vec3(1.0, 0.95, 0.85) * uFlashI * cone / max(l * l, 0.4) * 0.05;
    a = cone * step(0.3, l);
    size = 0.004;
  }
  vec3 toCam = normalize(cameraPosition - p);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = cross(toCam, right);
  float d = distance(cameraPosition, p);
  size = max(size, d * 0.0012);
  vec3 wp = p + (right * position.x + up * position.y) * size;
  vA = a;
  vCol = col;
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (a < 0.01) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;
const SPECK_FRAG = /* glsl */ `
varying float vA;
varying vec3 vCol;
varying vec2 vUv;
void main() {
  float f = exp(-dot(vUv, vUv) * 3.0);
  gl_FragColor = vec4(vCol * f * vA, 1.0);
}`;

// ----------------------------------------------------------------------------- occlusion map
const OCC_VERT = /* glsl */ `
varying float vY;
void main() {
  vec4 wp = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  vY = wp.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const OCC_FRAG = /* glsl */ `
varying float vY;
void main() { gl_FragColor = vec4(vY + ${OCC_OFFSET.toFixed(1)}, 0.0, 0.0, 1.0); }`;

function quadGeo(count: number, attrs: Record<string, [Float32Array, number]>, verts: number[] = [-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  for (const [k, [arr, n]] of Object.entries(attrs)) g.setAttribute(k, new THREE.InstancedBufferAttribute(arr, n));
  g.instanceCount = count;
  return g;
}

type Bolt = { mesh: THREE.Mesh; t: number; life: number; power: number };

export class WeatherFX {
  rain: THREE.Mesh;
  splash: THREE.Mesh;
  leaves: THREE.Mesh;
  moths: THREE.Mesh;
  motes: THREE.Mesh;
  bolts: Bolt[] = [];
  private boltMat: THREE.ShaderMaterial;
  private occRT: THREE.WebGLRenderTarget;
  private occCam: THREE.OrthographicCamera;
  private occMat: THREE.ShaderMaterial;
  private occSize = 96;
  private occCenter = new THREE.Vector3(1e9, 0, 1e9);
  private occTimer = 0;
  private time = 0;
  private lastCam = new THREE.Vector3();
  private rng = new RNG(4242);
  private lightUniforms: Record<string, THREE.IUniform>;
  private mothU: { uMothLights: THREE.IUniform<THREE.Vector4[]>; uMothCols: THREE.IUniform<THREE.Color[]> };
  leafAmount = 0;
  rainScale = 1; // story can suppress rain (e.g. under shelter cutscenes)
  headlight: { pos: THREE.Vector3; dir: THREE.Vector3; intensity: number } | null = null;
  flash: { pos: THREE.Vector3; dir: THREE.Vector3; intensity: number } = { pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), intensity: 0 };
  forestAt: (x: number, z: number) => number = () => 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    rainCount: number,
    private env: Environment,
    private lights: LightManager,
  ) {
    const rng = this.rng;
    // shared light uniforms (object identity shared across materials)
    this.lightUniforms = {
      uPLPos: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, -1e4, 0, 0.001)) },
      uPLCol: { value: Array.from({ length: 6 }, () => new THREE.Color(0, 0, 0)) },
      uFlashPos: { value: new THREE.Vector3() },
      uFlashDir: { value: new THREE.Vector3(0, 0, -1) },
      uFlashI: { value: 0 },
      uHeadPos: { value: new THREE.Vector3() },
      uHeadDir: { value: new THREE.Vector3(0, 0, -1) },
      uHeadI: { value: 0 },
    };
    // occlusion map
    const OCC_RES = 256;
    this.occRT = new THREE.WebGLRenderTarget(OCC_RES, OCC_RES, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.occCam = new THREE.OrthographicCamera(-this.occSize / 2, this.occSize / 2, this.occSize / 2, -this.occSize / 2, 1, 700);
    this.occCam.up.set(0, 0, -1);
    this.occCam.layers.set(LAYER.OCCLUDER);
    this.occMat = new THREE.ShaderMaterial({ vertexShader: OCC_VERT, fragmentShader: OCC_FRAG, side: THREE.DoubleSide });
    U.uOccTex.value = this.occRT.texture;
    const occU = { uOccTex: U.uOccTex, uOccInfo: U.uOccInfo, uHeightTex: U.uHeightTex, uTerrainInfo: U.uTerrainInfo };

    // rain
    {
      const n = rainCount;
      const seed = new Float32Array(n * 4);
      const speed = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        seed.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
        speed[i] = 0.85 + rng.next() * 0.3;
      }
      const g = quadGeo(n, { aSeed: [seed, 4], aSpeed: [speed, 1] });
      const mat = new THREE.ShaderMaterial({
        vertexShader: RAIN_VERT,
        fragmentShader: RAIN_FRAG,
        uniforms: {
          ...occU,
          ...this.lightUniforms,
          uCam: { value: new THREE.Vector3() },
          uBox: { value: new THREE.Vector3(34, 22, 34) },
          uT: { value: 0 },
          uFall: { value: 9.5 },
          uWindV: { value: new THREE.Vector2() },
          uAmount: { value: 0 },
          uStreak: { value: 0.034 },
          uAmbient: U.uAmbient,
          uLightning: U.uLightning,
          uBright: { value: 0.55 },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.rain = new THREE.Mesh(g, mat);
      this.rain.frustumCulled = false;
      this.rain.layers.set(LAYER.TRANSPARENT);
      this.rain.renderOrder = 20;
      scene.add(this.rain);
    }
    // splashes
    {
      const n = Math.round(Math.min(2400, rainCount / 6));
      const seed = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) seed.set([rng.next(), rng.next(), rng.next()], i * 3);
      const g = quadGeo(n, { aSeed: [seed, 3] }, [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
      const mat = new THREE.ShaderMaterial({
        vertexShader: SPLASH_VERT,
        fragmentShader: SPLASH_FRAG,
        uniforms: {
          ...occU,
          ...this.lightUniforms,
          uCam: { value: new THREE.Vector3() },
          uT: { value: 0 },
          uRadius: { value: 11 },
          uAmount: { value: 0 },
          uAmbient: U.uAmbient,
          uLightning: U.uLightning,
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.splash = new THREE.Mesh(g, mat);
      this.splash.frustumCulled = false;
      this.splash.layers.set(LAYER.TRANSPARENT);
      this.splash.renderOrder = 19;
      scene.add(this.splash);
    }
    // leaves
    {
      const n = 360;
      const seed = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) seed.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
      const g = quadGeo(n, { aSeed: [seed, 4] }, [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
      const mat = new THREE.ShaderMaterial({
        vertexShader: LEAF_VERT,
        fragmentShader: LEAF_FRAG,
        uniforms: {
          ...occU,
          ...fogUniforms(),
          ...this.lightUniforms,
          uCam: { value: new THREE.Vector3() },
          uBox: { value: new THREE.Vector3(40, 16, 40) },
          uT: { value: 0 },
          uWindV: { value: new THREE.Vector2() },
          uAmount: { value: 0 },
          uGust: U.uGust,
          uAmbient: U.uAmbient,
          uSunColor: U.uSunColor,
        },
        side: THREE.DoubleSide,
      });
      this.leaves = new THREE.Mesh(g, mat);
      this.leaves.frustumCulled = false;
      this.leaves.layers.set(LAYER.TRANSPARENT);
      scene.add(this.leaves);
    }
    // moths & motes share a shader
    this.mothU = {
      uMothLights: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -1e4, 0, 0)) },
      uMothCols: { value: Array.from({ length: 8 }, () => new THREE.Color()) },
    };
    const speck = (n: number, mode: number) => {
      const seed = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) seed.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
      const g = quadGeo(n, { aSeed: [seed, 4] }, [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
      const mat = new THREE.ShaderMaterial({
        vertexShader: SPECK_VERT,
        fragmentShader: SPECK_FRAG,
        uniforms: {
          ...this.mothU,
          ...this.lightUniforms,
          uT: { value: 0 },
          uMode: { value: mode },
          uCam: { value: new THREE.Vector3() },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.layers.set(LAYER.TRANSPARENT);
      m.renderOrder = 18;
      scene.add(m);
      return m;
    };
    this.moths = speck(64, 0);
    this.motes = speck(500, 1);

    this.boltMat = new THREE.ShaderMaterial({
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      uniforms: { uFlash: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    env.onStrike = (s) => this.spawnBolt(s.dir, s.dist, s.power);
  }

  /** Mark meshes as rain occluders (roofs, porches, cars, roads...). */
  addOccluders(root: THREE.Object3D) {
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.layers.isEnabled(LAYER.OPAQUE)) o.layers.enable(LAYER.OCCLUDER);
    });
  }

  private spawnBolt(dir: THREE.Vector3, dist: number, power: number) {
    if (dist > 6000) return;
    const cam = this.lastCam;
    const d = Math.min(dist, 3500);
    const h = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const ground = new THREE.Vector3(cam.x + h.x * d, 0, cam.z + h.z * d);
    const top = ground.clone().add(new THREE.Vector3(this.rng.range(-200, 200), this.rng.range(750, 1000), this.rng.range(-200, 200)));
    const rng = this.rng;
    const pos: number[] = [],
      next: number[] = [],
      side: number[] = [],
      width: number[] = [],
      bright: number[] = [];
    const idx: number[] = [];
    const addStroke = (pts: THREE.Vector3[], w: number, b: number) => {
      const base = pos.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[Math.min(i + 1, pts.length - 1)];
        const qq = i === pts.length - 1 ? p.clone().add(p.clone().sub(pts[i - 1])) : q;
        const taper = 1 - (i / pts.length) * 0.5;
        for (const s of [-1, 1]) {
          pos.push(p.x, p.y, p.z);
          next.push(qq.x, qq.y, qq.z);
          side.push(s);
          width.push(w * taper);
          bright.push(b);
        }
        if (i < pts.length - 1) {
          const a = base + i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    };
    const jag = (a: THREE.Vector3, b: THREE.Vector3, levels: number, disp: number): THREE.Vector3[] => {
      let pts = [a, b];
      let dd = disp;
      for (let l = 0; l < levels; l++) {
        const np: THREE.Vector3[] = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          const m = pts[i - 1].clone().add(pts[i]).multiplyScalar(0.5);
          m.x += rng.range(-dd, dd);
          m.z += rng.range(-dd, dd);
          m.y += rng.range(-dd, dd) * 0.3;
          np.push(m, pts[i]);
        }
        pts = np;
        dd *= 0.55;
      }
      return pts;
    };
    const main = jag(top, ground, 7, 180);
    const w = 2.2 + d * 0.0012;
    addStroke(main, w, 60);
    const nb = rng.int(2, 5);
    for (let i = 0; i < nb; i++) {
      const k = rng.int(4, Math.floor(main.length * 0.6));
      const s0 = main[k];
      const end = s0.clone().add(new THREE.Vector3(rng.range(-260, 260), -rng.range(120, 380), rng.range(-260, 260)));
      addStroke(jag(s0, end, 5, 70), w * 0.5, 22);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aNext', new THREE.Float32BufferAttribute(next, 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute('aWidth', new THREE.Float32BufferAttribute(width, 1));
    g.setAttribute('aBright', new THREE.Float32BufferAttribute(bright, 1));
    g.setIndex(idx);
    const mat = this.boltMat.clone();
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER.TRANSPARENT);
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this.bolts.push({ mesh, t: 0, life: 0.55, power });
  }

  private updateOcclusion(camPos: THREE.Vector3, force = false) {
    const texel = this.occSize / 256;
    const cx = Math.round(camPos.x / texel) * texel,
      cz = Math.round(camPos.z / texel) * texel;
    if (!force && Math.hypot(cx - this.occCenter.x, cz - this.occCenter.z) < 10 && this.occTimer < 2) return;
    this.occTimer = 0;
    this.occCenter.set(cx, camPos.y, cz);
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevOverride = this.scene.overrideMaterial;
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.autoClear;
    this.occCam.position.set(cx, camPos.y + 300, cz);
    this.occCam.lookAt(cx, camPos.y - 10, cz);
    this.occCam.updateMatrixWorld();
    this.scene.overrideMaterial = this.occMat;
    r.setRenderTarget(this.occRT);
    r.setClearColor(0x000000, 0);
    r.autoClear = true;
    r.clear(true, true, false);
    r.render(this.scene, this.occCam);
    r.setRenderTarget(prevRT);
    this.scene.overrideMaterial = prevOverride;
    r.setClearColor(prevClear, prevAlpha);
    r.autoClear = prevAuto;
    U.uOccInfo.value.set(cx, cz, this.occSize, 1);
  }

  update(dt: number, camera: THREE.Camera, sheltered: number) {
    this.time += dt;
    this.occTimer += dt;
    const env = this.env;
    const w = env.weather;
    const cam = camera.position;
    this.lastCam.copy(cam);
    const T = this.time % 600;
    const rainAmt = clamp(w.rain * this.rainScale, 0, 1);
    const rm = this.rain.material as THREE.ShaderMaterial;
    const sm = this.splash.material as THREE.ShaderMaterial;
    const wind = new THREE.Vector2(env.windDir.x, env.windDir.y).multiplyScalar((1.5 + w.wind * 7) * (0.7 + env.gust * 0.6));
    this.rain.visible = rainAmt > 0.01;
    this.splash.visible = rainAmt > 0.05;
    this.updateOcclusion(cam); // also used by ground cover
    if (this.rain.visible) {
      rm.uniforms.uCam.value.copy(cam);
      rm.uniforms.uT.value = T;
      rm.uniforms.uWindV.value.copy(wind);
      rm.uniforms.uAmount.value = rainAmt;
      sm.uniforms.uCam.value.copy(cam);
      sm.uniforms.uT.value = T;
      sm.uniforms.uAmount.value = rainAmt;
    }
    // local lights for particles: nearest pooled point lights
    const lu = this.lightUniforms;
    const pl = this.lights.pool;
    for (let i = 0; i < 6; i++) {
      const l = pl[i];
      const pv = (lu.uPLPos.value as THREE.Vector4[])[i];
      const pc = (lu.uPLCol.value as THREE.Color[])[i];
      if (l && l.visible && l.intensity > 0) {
        pv.set(l.position.x, l.position.y, l.position.z, l.distance || 20);
        pc.copy(l.color).multiplyScalar(l.intensity);
      } else {
        pv.set(0, -1e4, 0, 0.001);
        pc.setRGB(0, 0, 0);
      }
    }
    lu.uFlashPos.value.copy(this.flash.pos);
    lu.uFlashDir.value.copy(this.flash.dir);
    lu.uFlashI.value = this.flash.intensity;
    if (this.headlight) {
      lu.uHeadPos.value.copy(this.headlight.pos);
      lu.uHeadDir.value.copy(this.headlight.dir);
      lu.uHeadI.value = this.headlight.intensity;
    } else lu.uHeadI.value = 0;

    // leaves: near trees, more in wind
    const lm = this.leaves.material as THREE.ShaderMaterial;
    const forest = this.forestAt(cam.x, cam.z);
    const leafTarget = clamp(forest * (0.25 + w.wind * 0.6), 0, 0.9) * (1 - sheltered);
    this.leafAmount = damp(this.leafAmount, leafTarget, 0.5, dt);
    this.leaves.visible = this.leafAmount > 0.01;
    lm.uniforms.uCam.value.copy(cam);
    lm.uniforms.uT.value = T;
    lm.uniforms.uWindV.value.copy(wind).multiplyScalar(0.8);
    lm.uniforms.uAmount.value = this.leafAmount;

    // moths: around the nearest warm lamps at night, when it's not pouring
    const night = smoothstep(-2, -8, Math.asin(env.sunDir.y) * 57.3);
    const mm = this.moths.material as THREE.ShaderMaterial;
    mm.uniforms.uT.value = T;
    const ml = this.mothU.uMothLights.value,
      mc = this.mothU.uMothCols.value;
    const cand = this.lights.sources
      .filter((s) => (s.kind === 'sodium' || s.kind === 'incandescent' || s.kind === 'mercury') && s.on > 0.6 && s.pos.distanceToSquared(cam) < 45 * 45)
      .sort((a, b) => a.pos.distanceToSquared(cam) - b.pos.distanceToSquared(cam))
      .slice(0, 8);
    const pe = env.preExposure;
    for (let i = 0; i < 8; i++) {
      const s = cand[i % Math.max(1, cand.length)];
      if (s && night > 0.05 && w.rain < 0.3) {
        ml[i].set(s.pos.x, s.pos.y - 0.25, s.pos.z, night * (1 - w.rain * 3));
        mc[i].copy(s.color).multiplyScalar(s.power * pe * 0.6);
      } else ml[i].set(0, -1e4, 0, 0);
    }
    this.moths.visible = night > 0.05 && cand.length > 0;
    const mo = this.motes.material as THREE.ShaderMaterial;
    mo.uniforms.uT.value = T;
    mo.uniforms.uCam.value.copy(cam);
    this.motes.visible = this.flash.intensity > 0;

    // bolts
    for (const b of this.bolts) {
      b.t += dt;
      const flick = env.lightningAmount > 0.02 ? 1 : b.t < 0.08 ? 1 : 0;
      (b.mesh.material as THREE.ShaderMaterial).uniforms.uFlash.value = flick * b.power * env.preExposure * 400 * Math.max(0, 1 - b.t / b.life);
    }
    for (const b of this.bolts.filter((b) => b.t >= b.life)) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      (b.mesh.material as THREE.Material).dispose();
    }
    this.bolts = this.bolts.filter((b) => b.t < b.life);
  }

  forceOcclusionUpdate(cam: THREE.Vector3) {
    this.updateOcclusion(cam, true);
  }
}
