// Water: standing pools and the tidal channel on the flats, the river and its falls,
// and the open sea (used when the tide returns). One shader family with depth-based
// absorption, refraction from the scene copy, screen-space reflections with sky
// fallback, flow-mapped normals, shore foam and rain ripples.
import * as THREE from 'three';
import type { TerrainData } from './TerrainGen';
import { U, LAYER } from '../render/Globals';
import { GLSL_FOG_FN, GLSL_FOG_UNIFORMS, GLSL_NOISE } from '../render/Chunks';
import { clamp, lerp, smoothstep } from '../core/math';

export const WATER_VERT = /* glsl */ `
attribute vec3 aFlow; // xy = flow dir * speed, z = foam/turbulence
varying vec3 vWorld;
varying vec3 vFlow;
varying vec4 vClip;
uniform float uWaveAmp;
uniform float uTime;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  if (uWaveAmp > 0.0) {
    // gentle Gerstner swell for open water
    vec2 d1 = normalize(vec2(0.3, 1.0)), d2 = normalize(vec2(-0.6, 0.8)), d3 = normalize(vec2(0.9, 0.4));
    float k1 = 6.2832 / 38.0, k2 = 6.2832 / 17.0, k3 = 6.2832 / 9.0;
    float p1 = k1 * dot(d1, wp.xz) - uTime * sqrt(9.8 * k1);
    float p2 = k2 * dot(d2, wp.xz) - uTime * sqrt(9.8 * k2);
    float p3 = k3 * dot(d3, wp.xz) - uTime * sqrt(9.8 * k3);
    wp.y += uWaveAmp * (sin(p1) * 0.55 + sin(p2) * 0.3 + sin(p3) * 0.15);
    wp.xz += uWaveAmp * 0.4 * (d1 * cos(p1) * 0.55 + d2 * cos(p2) * 0.3);
  }
  vWorld = wp.xyz;
  vFlow = aFlow;
  vec4 clip = projectionMatrix * viewMatrix * wp;
  vClip = clip;
  gl_Position = clip;
}
`;

export const WATER_FRAG = /* glsl */ `
${GLSL_NOISE}
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform sampler2D tScene;      // rgb = scene colour, a = linear depth
uniform sampler2D tNormal;     // tileable ripple normals
uniform vec2 uNearFar;
uniform mat4 uProj;
uniform mat4 uView;
uniform float uTime;
uniform vec3 uSunColor;
uniform vec3 uAbsorb;          // per-metre absorption
uniform vec3 uScatter;         // in-scatter colour (multiplied by ambient)
uniform vec3 uAmbient;
uniform float uRough;
uniform float uRain;
uniform float uSSR;
uniform float uFoamK;
uniform float uNormalScale;
uniform float uSkyExposure2;
uniform float uFlashOn;
uniform vec3 uFlashPos;
uniform vec3 uFlashDir;
varying vec3 vWorld;
varying vec3 vFlow;
varying vec4 vClip;

float linDepthAt(vec2 uv) { return texture2D(tScene, uv).a; }

vec3 rippleN(vec2 p, float t) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 acc = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 h = bwHash22(cell + g);
    vec2 o = g + h - f;
    float ph = fract(t * (0.8 + h.x * 0.5) + h.y);
    float r = ph * 0.8;
    float d = length(o);
    float ring = sin((d - r) * 38.0) * smoothstep(0.1, 0.0, abs(d - r)) * (1.0 - ph);
    acc += (o / max(d, 1e-3)) * ring;
  }
  return vec3(acc, 0.0);
}

vec3 sampleNormal(vec2 p, vec2 flow, float t) {
  // flow-mapped double sampling to avoid stretching
  float ph0 = fract(t * 0.35);
  float ph1 = fract(t * 0.35 + 0.5);
  float w = abs(ph0 - 0.5) * 2.0;
  vec2 f = flow * 1.8;
  vec2 a = texture2D(tNormal, p * 0.11 - f * ph0 + vec2(t * 0.011, t * 0.007)).xy * 2.0 - 1.0;
  vec2 b = texture2D(tNormal, p * 0.11 - f * ph1 + vec2(t * 0.011, t * 0.007) + 0.5).xy * 2.0 - 1.0;
  vec2 c = texture2D(tNormal, p * 0.037 + vec2(-t * 0.004, t * 0.006)).xy * 2.0 - 1.0;
  vec2 n = mix(a, b, w) * 0.65 + c * 0.55;
  return vec3(n.x, 1.0, n.y);
}

void main() {
  vec3 V = cameraPosition - vWorld;
  float dist = length(V);
  V /= dist;
  vec2 suv = (vClip.xy / vClip.w) * 0.5 + 0.5;
  float fragDepth = vClip.w;
  float speed = length(vFlow.xy);
  // Normal
  vec3 N = sampleNormal(vWorld.xz, vFlow.xy, uTime);
  N.xz *= uNormalScale * mix(1.0, 0.35, smoothstep(30.0, 250.0, dist));
  if (uRain > 0.01) N.xz += rippleN(vWorld.xz * 1.7, uTime * 1.2).xy * 0.5 * uRain;
  N = normalize(N);

  // Depth under the surface (along view ray) for absorption
  float sceneD = linDepthAt(suv);
  float thick = max(sceneD - fragDepth, 0.0);
  // Refraction offset scales with thickness
  vec2 ruv = suv + N.xz * 0.035 * clamp(thick * 0.6, 0.0, 1.0) / max(1.0, dist * 0.08);
  float rD = linDepthAt(ruv);
  if (rD < fragDepth) { ruv = suv; rD = sceneD; }
  float thickR = max(rD - fragDepth, 0.0);
  vec3 under = texture2D(tScene, ruv).rgb;
  // Convert view-ray thickness to an approximate vertical depth for absorption
  float depthV = thickR * clamp(V.y, 0.15, 1.0);
  vec3 T = exp(-uAbsorb * (thickR * 0.6 + depthV * 0.4));
  vec3 inscat = uScatter * uAmbient * (1.0 - T);
  vec3 refr = under * T + inscat;

  // Reflection
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 env = textureLod(uSkyCube, R, uRough * 6.0).rgb * uSkyExposure;
  vec3 refl = env;
  float ssrHit = 0.0;
  if (uSSR > 0.5 && dist < 600.0) {
    vec3 vp = (uView * vec4(vWorld, 1.0)).xyz;
    vec3 vr = normalize((uView * vec4(R, 0.0)).xyz);
    float stepLen = 0.4 + dist * 0.02;
    vec3 p = vp;
    float jitter = bwIGN(gl_FragCoord.xy);
    p += vr * stepLen * jitter;
    for (int i = 0; i < 28; i++) {
      p += vr * stepLen;
      stepLen *= 1.12;
      vec4 pc = uProj * vec4(p, 1.0);
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      if (puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0 || pc.w < 0.0) break;
      float sd = linDepthAt(puv);
      float rayD = -p.z;
      if (rayD > sd + 0.05 && rayD - sd < stepLen * 2.5 + 1.0) {
        // refine
        vec3 a = p - vr * stepLen, b = p;
        for (int k = 0; k < 4; k++) {
          vec3 m = (a + b) * 0.5;
          vec4 mc = uProj * vec4(m, 1.0);
          vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
          if (-m.z > linDepthAt(muv)) b = m; else a = m;
        }
        vec4 bc = uProj * vec4(b, 1.0);
        vec2 buv = bc.xy / bc.w * 0.5 + 0.5;
        vec2 edge = smoothstep(0.0, 0.08, buv) * smoothstep(1.0, 0.92, buv);
        ssrHit = edge.x * edge.y * smoothstep(1.0, 0.6, float(i) / 28.0);
        refl = mix(env, texture2D(tScene, buv).rgb, ssrHit);
        break;
      }
    }
  }
  // Fresnel
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  F = mix(F, 0.02, 0.0);
  vec3 col = mix(refr, refl, F);
  // Sun specular (GGX)
  vec3 H = normalize(uSunDir + V);
  float NdH = max(dot(N, H), 0.0);
  float a2 = max(uRough * uRough, 0.0006);
  a2 *= a2;
  float dG = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dG * dG);
  float NdL = max(dot(N, uSunDir), 0.0);
  col += uSunColor * D * F * NdL * 0.25 * bwTerrainShadowAt(vWorld);
  // Flashlight glint
  if (uFlashOn > 0.5) {
    vec3 Lf = uFlashPos - vWorld;
    float lf = length(Lf);
    Lf /= lf;
    float cone = smoothstep(0.86, 0.95, dot(-Lf, uFlashDir));
    vec3 Hf = normalize(Lf + V);
    float nh = max(dot(N, Hf), 0.0);
    col += vec3(1.0, 0.92, 0.8) * pow(nh, 260.0) * cone * 30.0 / (1.0 + lf * lf * 0.02) * uSkyExposure2;
  }
  // Shore / turbulence foam
  float foamEdge = smoothstep(0.35, 0.0, thick) * (0.5 + 0.5 * bwFbm(vWorld.xz * 1.3 + uTime * 0.2));
  float foamT = vFlow.z * smoothstep(0.35, 0.8, bwFbm(vWorld.xz * 0.9 - vFlow.xy * uTime * 1.5));
  float foam = clamp(foamEdge * uFoamK + foamT, 0.0, 1.0);
  col = mix(col, (uAmbient * 0.9 + uSunColor * max(uSunDir.y, 0.0) * 0.25) * 0.85, foam * 0.85);
  col = bwApplyFog(col, vWorld);
  // soft shoreline alpha
  float alpha = clamp(thick * 6.0, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

export type WaterMaterialOpts = {
  absorb?: THREE.Color;
  scatter?: THREE.Color;
  rough?: number;
  waveAmp?: number;
  foam?: number;
  normalScale?: number;
};

export function makeWaterMaterial(normalTex: THREE.Texture, sceneTex: () => THREE.Texture | null, ssr: boolean, o: WaterMaterialOpts = {}) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      tScene: { value: null },
      tNormal: { value: normalTex },
      uNearFar: { value: new THREE.Vector2(0.1, 1000) },
      uProj: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uTime: U.uTime,
      uSunDir: U.uSunDir,
      uSunColor: U.uSunColor,
      uAbsorb: { value: o.absorb ?? new THREE.Color(0.45, 0.18, 0.12) },
      uScatter: { value: o.scatter ?? new THREE.Color(0.1, 0.16, 0.13) },
      uAmbient: U.uAmbient,
      uRough: { value: o.rough ?? 0.06 },
      uRain: U.uRain,
      uSSR: { value: ssr ? 1 : 0 },
      uFoamK: { value: o.foam ?? 0.6 },
      uNormalScale: { value: o.normalScale ?? 0.35 },
      uWaveAmp: { value: o.waveAmp ?? 0 },
      uSkyExposure2: U.uSkyExposure,
      uFlashOn: U.uFlashOn,
      uFlashPos: U.uFlashPos,
      uFlashDir: U.uFlashDir,
      // fog + sky
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
    transparent: true,
    depthWrite: true,
    depthTest: true,
    fog: false,
  });
  mat.onBeforeRender = (renderer, scene, camera) => {
    const u = mat.uniforms;
    u.tScene.value = sceneTex();
    u.uProj.value.copy(camera.projectionMatrix);
    u.uView.value.copy(camera.matrixWorldInverse);
    const pc = camera as THREE.PerspectiveCamera;
    u.uNearFar.value.set(pc.near, pc.far);
  };
  return mat;
}

/** Build the standing-water mesh (channel + pools) from the terrain's water table. */
export function buildFlatsWater(t: TerrainData): THREE.BufferGeometry {
  const { res, cell, minX, minZ, height, water } = t;
  // Level each isolated pool: flood-fill components, set level = min rim.
  const comp = new Int32Array(res * res).fill(-1);
  const levels: number[] = [];
  const isChannel = (idx: number) => {
    const x = minX + (idx % res) * cell,
      z = minZ + Math.floor(idx / res) * cell;
    // close to the river/channel centreline?
    for (let k = 0; k < t.riverSamples.length; k += 3) {
      const s = t.riverSamples[k];
      if (s.z < 205) continue;
      if (Math.abs(s.x - x) < 45 && Math.abs(s.z - z) < 45) return true;
    }
    return false;
  };
  const stack: number[] = [];
  for (let i = 0; i < res * res; i++) {
    if (water[i] < -999 || comp[i] >= 0) continue;
    const id = levels.length;
    let minRim = Infinity;
    let channel = false;
    stack.push(i);
    comp[i] = id;
    const members: number[] = [];
    while (stack.length) {
      const c = stack.pop()!;
      members.push(c);
      if (water[c] < minRim) minRim = water[c];
      const cx = c % res,
        cz = (c / res) | 0;
      const nb = [cx > 0 ? c - 1 : -1, cx < res - 1 ? c + 1 : -1, cz > 0 ? c - res : -1, cz < res - 1 ? c + res : -1];
      for (const n of nb) {
        if (n >= 0 && comp[n] < 0 && water[n] > -999) {
          comp[n] = id;
          stack.push(n);
        }
      }
    }
    if (members.length > 40 && isChannel(members[members.length >> 1])) channel = true;
    levels.push(channel ? NaN : minRim);
    if (!channel) {
      for (const m of members) {
        if (height[m] >= minRim - 0.01) {
          water[m] = -1000;
          comp[m] = -2;
        } else water[m] = minRim;
      }
    }
  }
  // Emit quads for cells with any wet corner; extend slightly past the shore.
  const pos: number[] = [];
  const flow: number[] = [];
  const idx: number[] = [];
  const vmap = new Int32Array(res * res).fill(-1);
  const levelAt = (i: number, j: number): number => {
    const id = j * res + i;
    if (water[id] > -999) return water[id];
    // borrow from a wet neighbour
    let best = -1000;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i + di,
          jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
        const w = water[jj * res + ii];
        if (w > best) best = w;
      }
    return best;
  };
  const vert = (i: number, j: number) => {
    const id = j * res + i;
    if (vmap[id] >= 0) return vmap[id];
    const lv = levelAt(i, j);
    const x = minX + i * cell,
      z = minZ + j * cell;
    pos.push(x, lv, z);
    // flow along the channel (toward the sea, roughly +z)
    const ch = comp[id] >= 0 && Number.isNaN(levels[comp[id]]);
    flow.push(ch ? -0.05 : 0, ch ? 0.22 : 0, 0);
    vmap[id] = pos.length / 3 - 1;
    return vmap[id];
  };
  for (let j = 0; j < res - 1; j++)
    for (let i = 0; i < res - 1; i++) {
      const a = j * res + i;
      const wet = water[a] > -999 || water[a + 1] > -999 || water[a + res] > -999 || water[a + res + 1] > -999;
      if (!wet) continue;
      const va = vert(i, j),
        vb = vert(i + 1, j),
        vc = vert(i, j + 1),
        vd = vert(i + 1, j + 1);
      idx.push(va, vc, vb, vb, vc, vd);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** River ribbon (land part) following the carved channel. */
export function buildRiver(t: TerrainData, heightAt: (x: number, z: number) => number): THREE.BufferGeometry {
  const s = t.riverSamples.filter((p) => p.z < 216);
  const pos: number[] = [];
  const flow: number[] = [];
  const idx: number[] = [];
  const W = 6;
  let prevY = Infinity;
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    const q = s[Math.min(s.length - 1, i + 1)];
    const o = s[Math.max(0, i - 1)];
    let dx = q.x - o.x,
      dz = q.z - o.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const nx = -dz,
      nz = dx;
    const z = p.z;
    const halfW = z < -380 ? 5 + (z + 830) * 0.004 : z < -300 ? 7 : 9 + (z + 300) * 0.01;
    const slope = Math.abs(q.y - o.y) / Math.max(1, Math.hypot(q.x - o.x, q.z - o.z));
    // water surface: bed + depth, never rising downstream
    let y = p.y + 0.75;
    if (y > prevY) y = prevY;
    prevY = y;
    const turb = clamp(slope * 6, 0, 1);
    const spd = 0.25 + slope * 6;
    for (let k = 0; k <= W; k++) {
      const u = k / W - 0.5;
      const w = halfW * 1.15;
      pos.push(p.x + nx * u * 2 * w, y, p.z + nz * u * 2 * w);
      flow.push(dx * spd, dz * spd, turb * (0.4 + 0.6 * Math.abs(u) * 2));
    }
    if (i < s.length - 1) {
      const b = i * (W + 1);
      for (let k = 0; k < W; k++) idx.push(b + k, b + k + W + 1, b + k + 1, b + k + 1, b + k + W + 1, b + k + W + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Big sea plane (the returning tide). */
export function buildSea(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(30000, 30000, 160, 160);
  g.rotateX(-Math.PI / 2);
  const n = g.attributes.position.count;
  g.setAttribute('aFlow', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
  return g;
}

export const WATER_NORMAL_GLSL = /* glsl */ `
void m_waterN(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float a = pfbm(uv, vec2(6.0), 5, 0.52);
  float b = pfbm(uv + 0.3, vec2(14.0, 10.0), 4, 0.5);
  float w = sin((uv.x * 3.0 + uv.y * 7.0 + a * 2.0) * 6.2832) * 0.5 + 0.5;
  h = a * 0.55 + b * 0.3 + w * 0.15;
  alb = vec3(0.5);
  rough = 0.1;
  ao = 1.0;
}`;

export { lerp, smoothstep };
