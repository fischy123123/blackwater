// GLSL building blocks + global patches to three.js' built-in shader chunks.
import * as THREE from 'three';
import { U } from './Globals';

export const GLSL_NOISE = /* glsl */ `
float bwHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 bwHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float bwHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float bwVNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = bwHash12(i);
  float b = bwHash12(i + vec2(1.0, 0.0));
  float c = bwHash12(i + vec2(0.0, 1.0));
  float d = bwHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float bwVNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = bwHash13(i);
  float n100 = bwHash13(i + vec3(1, 0, 0));
  float n010 = bwHash13(i + vec3(0, 1, 0));
  float n110 = bwHash13(i + vec3(1, 1, 0));
  float n001 = bwHash13(i + vec3(0, 0, 1));
  float n101 = bwHash13(i + vec3(1, 0, 1));
  float n011 = bwHash13(i + vec3(0, 1, 1));
  float n111 = bwHash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float bwFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * bwVNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// Interleaved gradient noise for dithering.
float bwIGN(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}
`;

export const GLSL_FOG_UNIFORMS = /* glsl */ `
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBase;
uniform vec3 uFogColor;
uniform vec3 uFogSun;
uniform vec3 uSunDir;
uniform float uMist;
uniform float uMistHeight;
uniform float uBankZ;
uniform float uBankDensity;
uniform vec4 uBankClear;
uniform float uLightning;
uniform samplerCube uSkyCube;
uniform float uSkyExposure;
uniform sampler2D uTerrainShadow;
uniform vec4 uTerrainInfo;
`;

export const GLSL_FOG_FN = /* glsl */ `
float bwFogHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float bwFogNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bwFogHash(i), bwFogHash(i + vec2(1.0, 0.0)), u.x), mix(bwFogHash(i + vec2(0.0, 1.0)), bwFogHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float bwPhaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float bwBankDensity(vec3 p) {
  float z = p.z;
  float d = uBankDensity * smoothstep(uBankZ, uBankZ + 220.0, z);
  // Clear pocket in front of the wall
  d *= 1.0 - uBankClear.w * smoothstep(uBankClear.y - 250.0, uBankClear.y - 110.0, z);
  // Bank is a low, thick layer over the sea, with slow wispy structure
  d *= exp(-max(p.y + 18.0, 0.0) / 55.0);
  d *= 0.45 + 1.1 * bwFogNoise(p.xz * 0.0035 + vec2(3.1, 1.7));
  return d;
}
// Returns transmittance in .a and in-scattered colour in .rgb for the segment camera->wpos.
vec4 bwFogSegment(vec3 ro, vec3 wpos) {
  vec3 dv = wpos - ro;
  float dist = length(dv);
  vec3 rd = dv / max(dist, 1e-4);
  float b = uFogFalloff;
  float h0 = ro.y - uFogBase;
  float k = b * dv.y;
  float od = uFogDensity * exp(-b * h0) * dist * ((abs(k) > 1e-3) ? (1.0 - exp(-k)) / k : 1.0);
  // Low ground mist (absolute height, hugging the bay and valley floor)
  if (uMist > 0.0) {
    float bm = 1.0 / uMistHeight;
    float km = bm * dv.y;
    od += uMist * exp(-bm * max(ro.y, -10.0)) * dist * ((abs(km) > 1e-3) ? (1.0 - exp(-km)) / km : 1.0);
  }
  // Sea-fog bank (numerical, only for rays that reach it)
  float zEnd = wpos.z;
  if (max(ro.z, zEnd) > uBankZ && uBankDensity > 0.0) {
    float t0 = 0.0;
    if (ro.z < uBankZ && rd.z > 1e-4) t0 = (uBankZ - ro.z) / rd.z;
    t0 = clamp(t0, 0.0, dist);
    float seg = (dist - t0) / 6.0;
    float acc = 0.0;
    for (int i = 0; i < 6; i++) {
      vec3 p = ro + rd * (t0 + seg * (float(i) + 0.5));
      acc += bwBankDensity(p);
    }
    od += acc * seg;
  }
  float T = exp(-od);
  vec3 hz = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.03, rd.z));
  vec3 skyCol = textureLod(uSkyCube, hz, 4.0).rgb * uSkyExposure;
  vec3 scat = mix(uFogColor, skyCol, 0.55);
  // the sea bank is a little darker and cooler than open haze
  float bankK = smoothstep(uBankZ - 100.0, uBankZ + 400.0, wpos.z) * step(0.0, uBankDensity - 1e-5);
  scat *= mix(1.0, 0.72, bankK);
  scat += uFogSun * bwPhaseHG(dot(rd, uSunDir), 0.7) * 2.5;
  scat += vec3(0.55, 0.6, 0.8) * uLightning * 0.6;
  return vec4(scat * (1.0 - T), T);
}
float bwTerrainShadowAt(vec3 wp) {
  vec2 uv = (wp.xz - uTerrainInfo.xy) / uTerrainInfo.z;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  return texture2D(uTerrainShadow, uv).r;
}
vec3 bwApplyFog(vec3 col, vec3 wpos) {
  vec4 f = bwFogSegment(cameraPosition, wpos);
  return col * f.a + f.rgb;
}
`;

let installed = false;

/** Replace three.js' fog chunks with Blackwater's aerial perspective. */
export function installGlobalChunks() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif
`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  {
    vec4 fogWP = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      fogWP = batchingMatrix * fogWP;
    #endif
    #ifdef USE_INSTANCING
      fogWP = instanceMatrix * fogWP;
    #endif
    fogWP = modelMatrix * fogWP;
    vFogWorldPos = fogWP.xyz;
  }
#endif
`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
  uniform vec3 fogColor;
  uniform float fogDensity;
  ${GLSL_FOG_UNIFORMS}
  ${GLSL_FOG_FN}
#endif
`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = bwApplyFog( gl_FragColor.rgb, vFogWorldPos );
#endif
`;

  // Large-scale terrain shadowing of the sun for every lit material.
  C.lights_fragment_begin = C.lights_fragment_begin.replace(
    'getSunLightInfo( sunLight, directLight );',
    `getSunLightInfo( sunLight, directLight );
    #ifdef USE_FOG
      directLight.color *= bwTerrainShadowAt( vFogWorldPos );
    #endif`,
  );

  // Foliage translucency: light passing through leaves when backlit (uses the shadowed sun colour).
  {
    const c = C.lights_fragment_begin;
    const si = c.indexOf('getSunLightInfo( sunLight, directLight );');
    const ri = c.indexOf('RE_Direct( directLight', si);
    const ei = c.indexOf(';', ri) + 1;
    C.lights_fragment_begin =
      c.slice(0, ei) +
      `
      #ifdef BW_TRANSLUCENT
        reflectedLight.directDiffuse += diffuseColor.rgb * directLight.color * bwTranslucency( directLight.direction, geometryViewDir, geometryNormal );
      #endif` +
      c.slice(ei);
  }

  // Every material gets the shared uniforms, even ones we never patch explicitly.
  const proto = THREE.Material.prototype as unknown as {
    onBeforeCompile: (s: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => void;
  };
  proto.onBeforeCompile = function (shader) {
    injectGlobals(shader);
  };
}

/** Adds references to all shared uniforms (same objects, so updates propagate). */
export function injectGlobals(shader: { uniforms: Record<string, THREE.IUniform> }) {
  for (const k in U) {
    if (!(k in shader.uniforms)) shader.uniforms[k] = (U as Record<string, THREE.IUniform>)[k];
  }
}
