// Physically based sky: single-scattering atmosphere (Rayleigh + Mie + ozone),
// raymarched cloud layer, moon, stars. Rendered into a cubemap (for reflections, IBL
// and fog colour) and displayed through a dome that adds crisp sun/moon/stars.
import * as THREE from 'three';
import { FullScreenQuad, fsMaterial } from './FullScreen';
import { U } from './Globals';
import { GLSL_FOG_FN, GLSL_FOG_UNIFORMS, GLSL_NOISE } from './Chunks';
import { makeCloudNoise } from './NoiseTex';

export const SUN_E = 100; // sun illuminance at top of atmosphere, scene units (~klux)

const ATMOS_GLSL = /* glsl */ `
#define PI 3.141592653589793
const float Rg = 6360000.0;
const float Rt = 6420000.0;
const vec3 BR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float HR = 8000.0;
const vec3 BM = vec3(3.996e-6);
const vec3 BMext = vec3(4.44e-6);
const float HM = 1200.0;
const vec3 BO = vec3(0.650e-6, 1.881e-6, 0.085e-6);
uniform float uHaze; // extra mie (humid coastal air)

float ozoneD(float h) { return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0); }
vec2 raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}
vec3 transmittanceTo(vec3 p, vec3 L) {
  float tg = raySphere(p, L, Rg).x;
  vec2 ta = raySphere(p, L, Rt);
  float tMax = max(ta.y, 0.0);
  const int N = 6;
  float ds = tMax / float(N);
  vec3 od = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 q = p + L * (float(i) + 0.5) * ds;
    float h = max(length(q) - Rg, 0.0);
    od += (BR * exp(-h / HR) + BMext * (1.0 + uHaze) * exp(-h / HM) + BO * ozoneD(h)) * ds;
  }
  vec3 T = exp(-od);
  // soft terminator instead of a hard ground intersection
  float horizon = -sqrt(max(0.0, 1.0 - (Rg * Rg) / dot(p, p)));
  float cosL = dot(normalize(p), L);
  T *= smoothstep(horizon - 0.02, horizon + 0.01, cosL);
  return T;
}
vec3 atmosphere(vec3 rd, vec3 L, float camH) {
  vec3 ro = vec3(0.0, Rg + camH, 0.0);
  vec2 ta = raySphere(ro, rd, Rt);
  float tMax = ta.y;
  vec2 tg = raySphere(ro, rd, Rg);
  bool ground = tg.x > 0.0;
  if (ground) tMax = tg.x;
  const int N = 20;
  vec3 sumR = vec3(0.0), sumM = vec3(0.0), odView = vec3(0.0);
  vec3 msR = vec3(0.0), msM = vec3(0.0);
  float tPrev = 0.0;
  for (int i = 0; i < N; i++) {
    float f = (float(i) + 1.0) / float(N);
    float t1 = tMax * f * f;
    float ds = t1 - tPrev;
    float t = (tPrev + t1) * 0.5;
    tPrev = t1;
    vec3 p = ro + rd * t;
    float h = max(length(p) - Rg, 0.0);
    float dR = exp(-h / HR), dM = exp(-h / HM) * (1.0 + uHaze), dO = ozoneD(h);
    odView += (BR * dR + BMext * dM + BO * dO) * ds;
    vec3 Tv = exp(-odView);
    vec3 T = Tv * transmittanceTo(p, L);
    sumR += dR * T * ds;
    sumM += dM * T * ds;
    msR += dR * Tv * ds;
    msM += dM * Tv * ds;
  }
  float mu = dot(rd, L);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.78;
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 single = sumR * BR * pR + sumM * BM * pM;
  // Multiple scattering approximation: bluish skylight re-scattered along the view path.
  float sunUp = smoothstep(-0.12, 0.35, L.y);
  vec3 msSrc = vec3(0.30, 0.52, 1.0) * 0.012 * sunUp + vec3(0.9, 0.55, 0.35) * 0.004 * smoothstep(-0.12, 0.02, L.y) * (1.0 - smoothstep(0.02, 0.2, L.y));
  vec3 multi = (msR * BR + msM * BM) * msSrc / (4.0 * PI) * 4.0 * PI;
  vec3 Lr = (single + multi) * ${SUN_E.toFixed(1)};
  if (ground) Lr *= 0.6; // below horizon: dim (terrain/sea hides it anyway)
  return Lr;
}
`;

// Sky-view LUT: u = azimuth relative to sun (0..PI), v = elevation (non-linear)
const LUT_FRAG = /* glsl */ `
${ATMOS_GLSL}
uniform float uSunElev;
uniform float uCamH;
varying vec2 vUv;
void main() {
  float az = vUv.x * PI;
  float v = vUv.y * 2.0 - 1.0;
  float el = sign(v) * v * v * (PI * 0.5);
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 L = vec3(cos(uSunElev), sin(uSunElev), 0.0);
  vec3 c = atmosphere(rd, L, uCamH);
  gl_FragColor = vec4(c, 1.0);
}
`;

const SKY_COMMON = /* glsl */ `
${ATMOS_GLSL}
${GLSL_NOISE}
uniform sampler2D uLUT;
uniform vec3 uSunDirW;
uniform vec3 uMoonDirW;
uniform float uMoonLight;
uniform float uNight;
vec3 lutSky(vec3 rd) {
  // azimuth relative to sun around the vertical axis
  vec2 sh = normalize(uSunDirW.xz + vec2(1e-5));
  vec2 rh = rd.xz;
  float rl = length(rh);
  float az = rl > 1e-5 ? acos(clamp(dot(rh / rl, sh), -1.0, 1.0)) : 0.0;
  float el = asin(clamp(rd.y, -1.0, 1.0));
  float v = sign(el) * sqrt(abs(el) / (PI * 0.5));
  vec3 c = texture2D(uLUT, vec2(az / PI, v * 0.5 + 0.5)).rgb;
  // Night: faint airglow + moonlit blue
  float hz = 1.0 - clamp(rd.y, 0.0, 1.0);
  vec3 night = mix(vec3(0.0009, 0.0014, 0.0030), vec3(0.0022, 0.0028, 0.0042), hz * hz) * uNight;
  float mu = max(dot(rd, uMoonDirW), 0.0);
  night += vec3(0.6, 0.72, 1.0) * uMoonLight * (0.0016 * pow(mu, 12.0) + 0.004 * pow(mu, 200.0) + 0.0012);
  return c + night;
}
`;

const CUBE_FRAG = /* glsl */ `
${SKY_COMMON}
${GLSL_FOG_UNIFORMS.replace('uniform vec3 uSunDir;', '').replace('uniform samplerCube uSkyCube;', '').replace('uniform float uSkyExposure;', '')}
uniform vec3 uCamPos;
uniform vec3 uFogSunDir;
float bwPhaseHGf(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
float bankD(vec3 p) {
  float d = uBankDensity * smoothstep(uBankZ, uBankZ + 220.0, p.z);
  d *= 1.0 - uBankClear.w * smoothstep(uBankClear.y - 250.0, uBankClear.y - 110.0, p.z);
  d *= exp(-max(p.y + 18.0, 0.0) / 55.0);
  return d;
}
// Same aerial perspective as materials, evaluated in physical units (no exposure).
vec4 skyFog(vec3 ro, vec3 rd, float dist) {
  vec3 dv = rd * dist;
  float b = uFogFalloff;
  float k = b * dv.y;
  float od = uFogDensity * exp(-b * (ro.y - uFogBase)) * dist * ((abs(k) > 1e-3) ? (1.0 - exp(-k)) / k : 1.0);
  if (uMist > 0.0) {
    float bm = 1.0 / uMistHeight;
    float km = bm * dv.y;
    od += uMist * exp(-bm * max(ro.y, -10.0)) * dist * ((abs(km) > 1e-3) ? (1.0 - exp(-km)) / km : 1.0);
  }
  if (uBankDensity > 0.0) {
    float acc = 0.0;
    for (int i = 0; i < 8; i++) acc += bankD(ro + rd * dist * ((float(i) + 0.5) / 8.0));
    od += acc * dist / 8.0;
  }
  float T = exp(-od);
  vec3 hz = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.35 + 0.03, rd.z));
  vec3 skyCol = lutSky(hz);
  vec3 scat = mix(uFogColor, skyCol, 0.55) + uFogSun * bwPhaseHGf(dot(rd, uFogSunDir), 0.7) * 2.5;
  return vec4(scat * (1.0 - T), T);
}
precision highp sampler3D;
uniform sampler3D uNoise;
uniform float uCoverage;
uniform float uCloudDensity;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uStorm;
uniform vec2 uCloudOffset;
uniform float uCloudSteps;
uniform float uTimeC;
uniform float uJitterSeed;
uniform vec3 uSunColorC; // sun (or moon) radiance for cloud lighting
uniform mat4 uFaceInvViewProj;
varying vec2 vUv;

float cloudDensity(vec3 p, float hf, bool detail) {
  vec3 q = vec3(p.x + uCloudOffset.x, p.y, p.z + uCloudOffset.y) * 0.00012;
  vec4 n = texture(uNoise, q);
  float wfbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = clamp((n.r - (wfbm - 1.0)) / (2.0 - wfbm), 0.0, 1.0);
  // large-scale weather: patches of clear and cloudy
  float wx = texture(uNoise, vec3((p.xz + uCloudOffset * 0.6) * 0.000021, 0.37).xzy).r;
  float cov = clamp(0.22 + uCoverage * 0.8 + (wx - 0.5) * 0.6 * (1.0 - uStorm), 0.0, 1.0);
  // cumulus height profile; stratus-like when stormy
  float shape = smoothstep(0.0, 0.12 + uStorm * 0.1, hf) * smoothstep(1.0, 0.45 - uStorm * 0.3, hf);
  float d = clamp((base * shape - (1.0 - cov)) / max(cov, 0.05), 0.0, 1.0);
  if (detail && d > 0.0) {
    vec4 dn = texture(uNoise, q * 5.3 + vec3(uTimeC * 0.002));
    float df = dn.g * 0.5 + dn.b * 0.3 + dn.a * 0.2;
    d = clamp(d - (1.0 - df) * 0.28 * (1.0 - d), 0.0, 1.0);
  }
  return d * uCloudDensity;
}

vec4 clouds(vec3 rd, vec3 bg) {
  vec3 ro = vec3(0.0, Rg + 60.0, 0.0);
  if (rd.y < -0.05) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 tb = raySphere(ro, rd, Rg + uCloudBase);
  vec2 tt = raySphere(ro, rd, Rg + uCloudTop);
  float t0 = max(tb.y, 0.0);
  float t1 = tt.y;
  float maxLen = 42000.0;
  if (t0 > maxLen) return vec4(0.0, 0.0, 0.0, 1.0);
  t1 = min(t1, t0 + 16000.0);
  int steps = int(uCloudSteps);
  float ds = (t1 - t0) / uCloudSteps;
  float jitter = fract(bwIGN(gl_FragCoord.xy + uJitterSeed * vec2(5.588238, 3.1273)) + uJitterSeed * 0.618034);
  float T = 1.0;
  vec3 col = vec3(0.0);
  vec3 L = uSunDirW;
  float mu = dot(rd, L);
  float phase = mix(bwPhaseHGc(mu, 0.72), bwPhaseHGc(mu, -0.25), 0.3) * 12.566;
  vec3 skyTop = lutSky(vec3(0.0, 1.0, 0.0));
  vec3 skyHz = lutSky(normalize(vec3(rd.x, 0.05, rd.z)));
  vec3 ambBase = mix(skyHz, skyTop, 0.5);
  for (int i = 0; i < 48; i++) {
    if (i >= steps) break;
    float t = t0 + ds * (float(i) + jitter);
    vec3 p = ro + rd * t;
    float h = length(p) - Rg;
    float hf = clamp((h - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
    vec3 wp = vec3(p.x, h, p.z);
    float d = cloudDensity(wp, hf, true);
    if (d > 0.002) {
      // light march toward the sun
      float od = 0.0;
      float lt = 120.0;
      for (int k = 0; k < 3; k++) {
        vec3 lp = wp + L * lt;
        float lhf = clamp((lp.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
        od += cloudDensity(lp, lhf, false) * lt;
        lt *= 2.6;
      }
      float sigma = 0.045;
      float Tl = exp(-od * sigma * 0.55) ;
      float powder = 1.0 - exp(-d * ds * sigma * 2.0);
      vec3 sunL = uSunColorC * Tl * phase * mix(1.0, powder, 0.55);
      vec3 amb = ambBase * mix(0.35, 1.0, hf) * (1.0 - uStorm * 0.6) * 2.2;
      vec3 S = (sunL + amb) * (1.0 - uStorm * 0.75);
      float ext = d * sigma;
      float Ts = exp(-ext * ds);
      col += T * S * (1.0 - Ts);
      T *= Ts;
      if (T < 0.02) break;
    }
  }
  // aerial perspective toward the horizon
  float fade = exp(-t0 / 26000.0);
  col = mix(bg * (1.0 - T), col, fade);
  T = mix(1.0, T, fade * 0.97 + 0.03);
  return vec4(col, T);
}

void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 wd = uFaceInvViewProj * ndc;
  vec3 rd = normalize(wd.xyz / wd.w);
  vec3 bg = lutSky(rd);
  vec4 c = clouds(rd, bg);
  vec3 col = bg * c.a + c.rgb;
  vec4 fg = skyFog(uCamPos, rd, 6000.0);
  col = col * fg.a + fg.rgb;
  gl_FragColor = vec4(col, c.a * fg.a);
}
`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}
`;

const DOME_FRAG = /* glsl */ `
${GLSL_NOISE}
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform vec3 uMoonDirW;
uniform vec3 uSunRadiance;
uniform vec3 uMoonRadiance;
uniform float uStars;
uniform float uStarRot;
uniform vec3 uLightningDir;
uniform float uTimeD;
uniform float uSunSize;
varying vec3 vDir;

vec3 starField(vec3 d) {
  float ca = cos(uStarRot), sa = sin(uStarRot);
  d = vec3(ca * d.x - sa * d.z, d.y, sa * d.x + ca * d.z);
  vec3 p = d * 220.0;
  vec3 c = floor(p);
  vec3 f = fract(p);
  float h = bwHash13(c);
  if (h < 0.93) return vec3(0.0);
  vec3 sp = vec3(bwHash13(c + 1.3), bwHash13(c + 2.7), bwHash13(c + 5.1)) * 0.7 + 0.15;
  float dist = length(f - sp);
  float mag = pow((h - 0.93) / 0.07, 6.0);
  float tw = 0.7 + 0.3 * sin(uTimeD * (2.0 + h * 9.0) + h * 70.0);
  float s = smoothstep(0.09, 0.0, dist) * mag * tw;
  vec3 tint = mix(vec3(1.0, 0.8, 0.65), vec3(0.75, 0.85, 1.0), bwHash13(c + 9.1));
  // milky way band
  vec3 gn = normalize(vec3(0.35, 0.2, 0.9));
  float band = exp(-pow(dot(d, gn) * 5.0, 2.0));
  float mw = band * (0.3 + 0.7 * bwFbm(vec2(atan(d.z, d.x) * 6.0, d.y * 12.0))) ;
  return tint * s * 0.35 + vec3(0.55, 0.6, 0.75) * mw * 0.0028;
}

void main() {
  vec3 rd = normalize(vDir);
  vec4 sky = textureLod(uSkyCube, rd, 0.0);
  vec3 col = sky.rgb;
  float cloudT = sky.a;
  // Sun disk with limb darkening
  float cs = dot(rd, uSunDir);
  float r = acos(clamp(cs, -1.0, 1.0)) / uSunSize;
  if (r < 1.0 && uSunDir.y > -0.05) {
    float limb = pow(max(1.0 - r * r, 0.0), 0.35);
    col += uSunRadiance * limb * cloudT;
  }
  // Moon
  float cm = dot(rd, uMoonDirW);
  float mr = acos(clamp(cm, -1.0, 1.0)) / 0.0085;
  if (mr < 1.0) {
    vec3 up = abs(uMoonDirW.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 mx = normalize(cross(up, uMoonDirW));
    vec3 my = cross(uMoonDirW, mx);
    vec2 mp = vec2(dot(rd - uMoonDirW * cm, mx), dot(rd - uMoonDirW * cm, my)) / 0.0085;
    float z = sqrt(max(1.0 - dot(mp, mp), 0.0));
    vec3 mn = normalize(mx * mp.x + my * mp.y + uMoonDirW * z);
    float lit = clamp(dot(mn, normalize(uSunDir + uMoonDirW * 0.35)) * 1.2 + 0.25, 0.0, 1.0);
    float maria = 0.72 + 0.28 * smoothstep(0.35, 0.7, bwFbm(mp * 3.1 + 4.0));
    col += uMoonRadiance * maria * lit * smoothstep(1.0, 0.92, mr) * cloudT * cloudT;
  }
  // Stars
  if (uStars > 0.0 && rd.y > -0.02) col += starField(rd) * uStars * cloudT * smoothstep(-0.02, 0.15, rd.y);
  col *= uSkyExposure;
  // Lightning lights the cloud deck from within
  if (uLightning > 0.0) {
    float fl = pow(max(dot(rd, uLightningDir), 0.0), 3.0) * 0.8 + 0.25;
    col += vec3(0.62, 0.66, 0.85) * uLightning * fl * (1.0 - cloudT * 0.7) * 1.4;
  }
  gl_FragColor = vec4(min(col, vec3(30000.0)), 1.0);
}
`;

export type SkyParams = {
  coverage: number;
  density: number;
  base: number;
  top: number;
  storm: number;
  haze: number;
  stars: number;
  moonLight: number;
};

export class SkySystem {
  renderer: THREE.WebGLRenderer;
  lutRT: THREE.WebGLRenderTarget;
  cubeRT: THREE.WebGLCubeRenderTarget;
  cubeCam: THREE.CubeCamera;
  pmrem: THREE.PMREMGenerator;
  envRT: THREE.WebGLRenderTarget | null = null;
  dome: THREE.Mesh;
  private lutMat: THREE.ShaderMaterial;
  private cubeMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  private face = 0;
  private lastLutSun = -99;
  private envTimer = 0;
  private cycleDone = false;
  params: SkyParams = { coverage: 0.35, density: 1, base: 1500, top: 3600, storm: 0, haze: 0.4, stars: 0, moonLight: 0 };
  cloudOffset = new THREE.Vector2(0, 0);
  facesPerFrame: number;
  cubeSize: number;
  envInterval = 0.6;
  forceEnv = true;

  constructor(renderer: THREE.WebGLRenderer, opts: { cubeSize: number; steps: number; facesPerFrame: number }) {
    this.renderer = renderer;
    this.cubeSize = opts.cubeSize;
    this.facesPerFrame = opts.facesPerFrame;
    this.lutRT = new THREE.WebGLRenderTarget(192, 108, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: false,
    });
    this.lutMat = fsMaterial(LUT_FRAG, { uSunElev: { value: 0.3 }, uCamH: { value: 60 }, uHaze: { value: 0.4 } });

    this.cubeRT = new THREE.WebGLCubeRenderTarget(opts.cubeSize, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.cubeCam = new THREE.CubeCamera(1, 10, this.cubeRT);
    this.cubeCam.coordinateSystem = renderer.coordinateSystem;
    this.cubeCam.updateCoordinateSystem();
    this.cubeCam.updateMatrixWorld(true);

    const noise = makeCloudNoise(64);
    const common = {
      uLUT: { value: this.lutRT.texture },
      uSunDirW: { value: new THREE.Vector3() },
      uMoonDirW: { value: new THREE.Vector3() },
      uMoonLight: { value: 0 },
      uNight: { value: 0 },
      uHaze: { value: 0.4 },
    };
    this.cubeMat = fsMaterial(
      CUBE_FRAG,
      {
        ...common,
        uNoise: { value: noise },
        uCoverage: { value: 0.4 },
        uCloudDensity: { value: 1 },
        uCloudBase: { value: 1500 },
        uCloudTop: { value: 3600 },
        uStorm: { value: 0 },
        uCloudOffset: { value: this.cloudOffset },
        uCloudSteps: { value: opts.steps },
        uTimeC: { value: 0 },
        uJitterSeed: { value: 0 },
        uSunColorC: { value: new THREE.Color() },
        uFaceInvViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uFogSunDir: U.uSunDir,
        uFogDensity: U.uFogDensity,
        uFogFalloff: U.uFogFalloff,
        uFogBase: U.uFogBase,
        uFogColor: { value: new THREE.Color() },
        uFogSun: { value: new THREE.Color() },
        uMist: U.uMist,
        uMistHeight: U.uMistHeight,
        uBankZ: U.uBankZ,
        uBankDensity: U.uBankDensity,
        uBankClear: U.uBankClear,
        uLightning: U.uLightning,
        uTerrainShadow: U.uTerrainShadow,
        uTerrainInfo: U.uTerrainInfo,
      },
    );
    // Temporal accumulation: each face update blends into the previous result with a new
    // jitter, turning low-step raymarch noise into smooth clouds.
    this.cubeMat.blending = THREE.CustomBlending;
    this.cubeMat.blendEquation = THREE.AddEquation;
    this.cubeMat.blendSrc = THREE.ConstantAlphaFactor;
    this.cubeMat.blendDst = THREE.OneMinusConstantAlphaFactor;
    this.cubeMat.blendSrcAlpha = THREE.ConstantAlphaFactor;
    this.cubeMat.blendDstAlpha = THREE.OneMinusConstantAlphaFactor;
    this.cubeMat.blendAlpha = 1;
    // phase function helper used by clouds
    this.cubeMat.fragmentShader = this.cubeMat.fragmentShader.replace(
      'vec4 clouds(',
      `float bwPhaseHGc(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }\nvec4 clouds(`,
    );

    this.pmrem = new THREE.PMREMGenerator(renderer);

    // Dome
    const domeGeo = new THREE.SphereGeometry(1, 48, 24);
    const domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: {
        uSkyCube: U.uSkyCube,
        uSkyExposure: U.uSkyExposure,
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
        uMoonDirW: { value: new THREE.Vector3() },
        uSunRadiance: { value: new THREE.Color() },
        uMoonRadiance: { value: new THREE.Color() },
        uStars: { value: 0 },
        uStarRot: { value: 0 },
        uLightningDir: { value: new THREE.Vector3(0, 0.3, 1) },
        uTimeD: U.uTime,
        uSunSize: { value: 0.0075 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, domeMat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1000;
    this.dome.scale.setScalar(100);

    U.uSkyCube.value = this.cubeRT.texture;
  }

  get domeUniforms() {
    return (this.dome.material as THREE.ShaderMaterial).uniforms;
  }

  /** Render the whole cube at once (e.g. after a teleport or on load). */
  renderAll() {
    // converge the accumulation: a hard reset, then several jittered passes per face
    const passes = 6;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    for (let p = 0; p < passes; p++) {
      this.cubeMat.blendAlpha = p === 0 ? 1 : 1 / (p + 1);
      for (let i = 0; i < 6; i++) this.renderFace(i, p === passes - 1 && i === 5);
    }
    this.cubeMat.blendAlpha = this.accum;
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    this.updateEnv();
  }

  /** Blend weight of each new cube update (lower = smoother, more lag). */
  accum = 0.3;

  private renderFace(i: number, mips: boolean) {
    const r = this.renderer;
    const cam = this.cubeCam.children[i] as THREE.PerspectiveCamera;
    cam.updateMatrixWorld();
    const m = this.cubeMat.uniforms.uFaceInvViewProj.value as THREE.Matrix4;
    m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    this.cubeRT.texture.generateMipmaps = mips;
    const js = this.cubeMat.uniforms.uJitterSeed;
    js.value = (js.value + 1) % 64;
    this.quad.material = this.cubeMat;
    r.setRenderTarget(this.cubeRT, i);
    this.quad.render(r);
    this.cubeRT.texture.generateMipmaps = true;
  }

  updateEnv() {
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
  }

  get envTexture() {
    return this.envRT?.texture ?? null;
  }

  fogColorPhys = new THREE.Color();
  fogSunPhys = new THREE.Color();
  camPos = new THREE.Vector3();

  update(dt: number, sunDir: THREE.Vector3, moonDir: THREE.Vector3, sunColorAtClouds: THREE.Color, night: number) {
    const p = this.params;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    // LUT when the sun moved
    const elev = Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1));
    if (Math.abs(elev - this.lastLutSun) > 0.0006 || this.lutMat.uniforms.uHaze.value !== p.haze) {
      this.lastLutSun = elev;
      this.lutMat.uniforms.uSunElev.value = elev;
      this.lutMat.uniforms.uHaze.value = p.haze;
      this.quad.material = this.lutMat;
      r.setRenderTarget(this.lutRT);
      this.quad.render(r);
    }

    const cu = this.cubeMat.uniforms;
    cu.uSunDirW.value.copy(sunDir);
    cu.uMoonDirW.value.copy(moonDir);
    cu.uMoonLight.value = p.moonLight;
    cu.uNight.value = night;
    cu.uHaze.value = p.haze;
    cu.uCoverage.value = p.coverage;
    cu.uCloudDensity.value = p.density;
    cu.uCloudBase.value = p.base;
    cu.uCloudTop.value = p.top;
    cu.uStorm.value = p.storm;
    cu.uTimeC.value = U.uTime.value;
    cu.uCamPos.value.copy(this.camPos);
    cu.uFogColor.value.copy(this.fogColorPhys);
    cu.uFogSun.value.copy(this.fogSunPhys);
    // light the clouds with whichever sky light dominates
    (cu.uSunColorC.value as THREE.Color).copy(sunColorAtClouds);
    if (sunDir.y < -0.08) cu.uSunDirW.value.copy(sunDir); // keep for LUT consistency

    for (let k = 0; k < this.facesPerFrame; k++) {
      const last = this.face === 5;
      this.renderFace(this.face, last);
      this.face = (this.face + 1) % 6;
      if (last) this.cycleDone = true;
    }

    this.envTimer += dt;
    if ((this.envTimer > this.envInterval && this.cycleDone) || this.forceEnv) {
      this.envTimer = 0;
      this.cycleDone = false;
      this.forceEnv = false;
      this.updateEnv();
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }
}

// ---------------------------------------------------------------------------
// CPU side of the same atmosphere, for light colours.
// ---------------------------------------------------------------------------
const BR = [5.802e-6, 13.558e-6, 33.1e-6];
const BMext = 4.44e-6;
const BO = [0.65e-6, 1.881e-6, 0.085e-6];
const Rg = 6360000,
  Rt = 6420000;

/** Transmittance from a point at altitude h toward direction with elevation `elev` (radians). */
export function sunTransmittance(elev: number, h: number, haze: number, out: THREE.Color) {
  const ro = [0, Rg + h, 0];
  const rd = [Math.cos(elev), Math.sin(elev), 0];
  const b = ro[1] * rd[1];
  const c = ro[1] * ro[1] - Rt * Rt;
  const tMax = -b + Math.sqrt(Math.max(0, b * b - c));
  const N = 24;
  let odR = 0,
    odM = 0,
    odO = 0;
  for (let i = 0; i < N; i++) {
    const t = ((i + 0.5) / N) * tMax;
    const x = ro[0] + rd[0] * t,
      y = ro[1] + rd[1] * t;
    const hh = Math.max(Math.hypot(x, y) - Rg, 0);
    const ds = tMax / N;
    odR += Math.exp(-hh / 8000) * ds;
    odM += Math.exp(-hh / 1200) * (1 + haze) * ds;
    odO += Math.max(0, 1 - Math.abs(hh - 25000) / 15000) * ds;
  }
  const horizon = -Math.sqrt(Math.max(0, 1 - (Rg * Rg) / ((Rg + h) * (Rg + h))));
  const s = Math.sin(elev);
  const k = THREE.MathUtils.smoothstep(s, horizon - 0.02, horizon + 0.01);
  out.setRGB(
    Math.exp(-(BR[0] * odR + BMext * odM + BO[0] * odO)) * k,
    Math.exp(-(BR[1] * odR + BMext * odM + BO[1] * odO)) * k,
    Math.exp(-(BR[2] * odR + BMext * odM + BO[2] * odO)) * k,
  );
  return out;
}
