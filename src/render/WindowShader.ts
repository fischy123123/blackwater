// Interior-mapped windows: a procedural room behind every pane (wallpaper, floor,
// furniture silhouettes, curtains, a lamp) lit per building, plus glass reflections.
import * as THREE from 'three';
import { U } from './Globals';
import { GLSL_FOG_FN, GLSL_FOG_UNIFORMS, GLSL_NOISE } from './Chunks';

const VERT = /* glsl */ `
attribute vec4 aExtra;
attribute vec3 color;
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vSize;
varying vec4 vExtra;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vSize = color;
  vExtra = aExtra;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${GLSL_NOISE}
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform float uLights[64];
uniform vec3 uInterior;     // lit interior radiance (already exposed)
uniform vec3 uAmbientIn;    // unlit interior radiance from outside light (exposed)
uniform float uTime;
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vSize;
varying vec4 vExtra;

vec3 palette(float h) {
  vec3 a = vec3(0.62, 0.58, 0.48); // cream
  vec3 b = vec3(0.42, 0.50, 0.44); // sage
  vec3 c = vec3(0.45, 0.50, 0.58); // dusty blue
  vec3 d = vec3(0.60, 0.46, 0.44); // faded rose
  vec3 e = vec3(0.40, 0.32, 0.24); // wood panel
  if (h < 0.2) return a; if (h < 0.4) return b; if (h < 0.6) return c; if (h < 0.8) return d; return e;
}

void main() {
  vec3 n = normalize(vN);
  vec3 V = normalize(vWorld - cameraPosition);
  vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 rd = vec3(dot(V, t), V.y, dot(V, -n));
  float W = vSize.x, Hh = vSize.y, sill = vSize.z;
  float seed = vExtra.y;
  float roomD = vExtra.x;
  float roomH = 2.75;
  float roomW = max(W * 2.4, 3.2);
  float xoff = (fract(seed * 7.13) - 0.5) * roomW * 0.35;
  vec3 ro = vec3((vUv.x - 0.5) * W, sill + vUv.y * Hh, 0.0);
  // ray-box exit
  float tx = ((rd.x > 0.0 ? roomW * 0.5 + xoff : -roomW * 0.5 + xoff) - ro.x) / (abs(rd.x) > 1e-4 ? rd.x : 1e-4);
  float ty = ((rd.y > 0.0 ? roomH : 0.0) - ro.y) / (abs(rd.y) > 1e-4 ? rd.y : 1e-4);
  float tz = (roomD - ro.z) / max(rd.z, 1e-4);
  float th = min(min(tx, ty), tz);
  vec3 hp = ro + rd * th;
  vec3 wall = palette(fract(seed * 13.7));
  vec3 col;
  float face; // 0 back, 1 side, 2 floor, 3 ceiling
  if (th == tz) {
    face = 0.0;
    col = wall;
    // wallpaper stripes / pattern
    col *= 0.9 + 0.1 * step(0.5, fract(hp.x * 3.0 + seed * 3.0)) * step(0.5, fract(seed * 5.1));
    // picture frame
    vec2 pf = vec2(hp.x - (fract(seed * 3.3) - 0.5) * roomW * 0.5, hp.y - 1.6);
    float frame = step(abs(pf.x), 0.35) * step(abs(pf.y), 0.25);
    col = mix(col, vec3(0.25, 0.2, 0.15), frame * step(0.3, fract(seed * 9.1)));
    // doorway into a darker room
    float door = step(abs(hp.x - (fract(seed * 5.7) - 0.5) * roomW * 0.7), 0.45) * step(hp.y, 2.05) * step(0.55, fract(seed * 2.9));
    col = mix(col, col * 0.15, door);
  } else if (th == ty) {
    face = rd.y > 0.0 ? 3.0 : 2.0;
    if (rd.y > 0.0) col = vec3(0.72, 0.7, 0.66);
    else {
      float board = step(0.5, fract(hp.x * 4.0 + floor(hp.z * 1.0) * 0.37));
      col = mix(vec3(0.30, 0.22, 0.14), vec3(0.36, 0.26, 0.16), board);
      float rug = step(abs(hp.x - xoff), roomW * 0.28) * step(abs(hp.z - roomD * 0.55), roomD * 0.25) * step(0.4, fract(seed * 4.3));
      col = mix(col, vec3(0.35, 0.12, 0.1), rug * 0.8);
    }
  } else {
    face = 1.0;
    col = wall * 0.85;
  }
  // furniture silhouettes on a plane at mid depth
  float fz = roomD * (0.45 + 0.3 * fract(seed * 17.3));
  if (rd.z > 0.0) {
    float tf = (fz - ro.z) / rd.z;
    if (tf < th && tf > 0.0) {
      vec3 fp = ro + rd * tf;
      float kind = fract(seed * 23.1);
      float cx = (fract(seed * 31.7) - 0.5) * roomW * 0.6;
      float fw = 0.8 + fract(seed * 41.3) * 1.2;
      float fh = kind < 0.35 ? 0.85 : kind < 0.7 ? 1.7 : 0.75;
      float inShape = step(abs(fp.x - cx), fw * 0.5) * step(fp.y, fh);
      if (kind < 0.35) inShape = max(inShape, step(abs(fp.x - cx), fw * 0.5) * step(fp.y, 1.0) * step(abs(abs(fp.x - cx) - fw * 0.45), 0.08)); // sofa arms
      if (inShape > 0.5) {
        col = kind < 0.35 ? vec3(0.28, 0.22, 0.2) : kind < 0.7 ? vec3(0.22, 0.15, 0.1) : vec3(0.3, 0.24, 0.18);
        th = tf;
        face = 4.0;
        hp = fp;
      }
    }
  }
  // lighting
  float light = uLights[int(vExtra.z + 0.5)];
  float lit = step(fract(seed * 91.7) * 0.9 + 0.05, light);
  vec3 lampPos = vec3(xoff + (fract(seed * 5.3) - 0.5) * roomW * 0.4, 1.5, roomD * 0.6);
  float dl = length(hp - lampPos);
  float fall = 1.0 / (1.0 + dl * dl * 0.35);
  vec3 radiance = col * (uInterior * lit * (0.25 + 1.4 * fall) + uAmbientIn * (0.25 + 0.75 * exp(-hp.z * 0.6)));
  // visible lamp shade
  if (lit > 0.5) {
    vec3 lp = lampPos + vec3(0.0, 0.0, -0.01);
    float tl = (lp.z - ro.z) / max(rd.z, 1e-4);
    if (tl > 0.0 && tl < th) {
      vec3 q = ro + rd * tl;
      float shade = step(abs(q.x - lp.x), 0.22 - (q.y - lp.y) * 0.3) * step(abs(q.y - lp.y - 0.05), 0.16);
      radiance = mix(radiance, uInterior * vec3(2.2, 1.7, 1.1), shade);
    }
  }
  // curtains just behind the glass
  float cL = 0.12 + 0.3 * fract(seed * 61.1);
  float cR = 0.12 + 0.3 * fract(seed * 71.9);
  float closed = step(0.82, fract(seed * 83.3));
  float u = vUv.x + rd.x * 0.05 / max(W, 0.3);
  float curtain = max(step(u, cL), step(1.0 - cR, u));
  curtain = max(curtain, closed);
  if (curtain > 0.5 && fract(seed * 53.7) > 0.25) {
    float folds = 0.75 + 0.25 * sin(u * 60.0 + seed * 10.0);
    vec3 cc = mix(vec3(0.75, 0.7, 0.58), vec3(0.55, 0.3, 0.25), step(0.5, fract(seed * 29.3)));
    radiance = cc * folds * (uInterior * lit * 0.9 + uAmbientIn * 0.4);
  }
  // blinds
  if (fract(seed * 37.1) < 0.15) {
    float slat = step(0.4, fract(vUv.y * Hh * 12.0));
    float down = step(0.55 + fract(seed * 7.7) * 0.4, vUv.y);
    radiance = mix(radiance, vec3(0.7, 0.68, 0.62) * (uInterior * lit * 0.5 + uAmbientIn * 0.5), slat * down);
  }
  // glass: reflection + grime
  float ndv = clamp(dot(-V, n), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(V, n);
  vec3 env = textureLod(uSkyCube, R, 1.5).rgb * uSkyExposure;
  float grime = bwFbm(vUv * vec2(W, Hh) * 3.0 + seed * 10.0);
  vec3 outc = radiance * (1.0 - F) * (0.82 + 0.1 * grime) + env * (F * 0.9 + 0.03);
  outc = bwApplyFog(outc, vWorld);
  gl_FragColor = vec4(outc, 1.0);
}
`;

const CLEAR_FRAG = /* glsl */ `
${GLSL_NOISE}
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vSize;
varying vec4 vExtra;
void main() {
  vec3 n = normalize(vN);
  vec3 V = normalize(vWorld - cameraPosition);
  if (dot(V, n) > 0.0) n = -n;
  float ndv = clamp(dot(-V, n), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  vec3 env = textureLod(uSkyCube, reflect(V, n), 1.0).rgb * uSkyExposure;
  float grime = bwFbm(vUv * vec2(vSize.x, vSize.y) * 4.0 + vExtra.y * 10.0);
  float a = clamp(F * 0.9 + 0.05 + grime * 0.08, 0.0, 1.0);
  vec3 c = env * F + vec3(0.5, 0.52, 0.5) * grime * 0.02;
  c = bwApplyFog(c, vWorld);
  gl_FragColor = vec4(c, a);
}
`;

export function fogUniforms() {
  return {
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
  };
}

export const BuildingLights = {
  values: new Array(64).fill(0) as number[],
  interior: { value: new THREE.Color() },
  ambientIn: { value: new THREE.Color() },
};

export function makeWindowMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      ...fogUniforms(),
      uLights: { value: BuildingLights.values },
      uInterior: BuildingLights.interior,
      uAmbientIn: BuildingLights.ambientIn,
      uTime: U.uTime,
    },
    fog: false,
  });
}

export function makeClearGlassMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: CLEAR_FRAG,
    uniforms: { ...fogUniforms() },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}
