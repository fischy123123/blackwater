// Frame pipeline:
//   1. opaque scene -> mainRT (HDR, MSAA)
//   2. copy colour + linear depth -> copyRT  (for water refraction / SSR / soft particles)
//   3. transparent layer (water, glass, rain, particles) -> mainRT
//   4. volumetric light (optional, half res)
//   5. bloom (dual filter)
//   6. composite: exposure, grade, AgX tonemap, vignette, grain -> screen
import * as THREE from 'three';
import { FullScreenQuad, fsMaterial } from './FullScreen';
import { LAYER, U } from './Globals';

export type GradeParams = {
  exposure: number;
  tint: THREE.Color; // multiplier before tonemap
  lift: THREE.Color; // shadow tint (added)
  saturation: number;
  contrast: number;
  vignette: number;
  grain: number;
  bloom: number;
  ca: number;
};

const COPY_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uNearFar;
varying vec2 vUv;
float linDepth(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNearFar.x * uNearFar.y) / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).r;
  gl_FragColor = vec4(c, d >= 1.0 ? 60000.0 : min(linDepth(d), 60000.0));
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uKaris;
varying vec2 vUv;
vec3 s(vec2 o) {
  vec3 c = texture2D(tSrc, vUv + o * uTexel).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  return clamp(c, vec3(0.0), vec3(60000.0));
}
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d));
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
void main() {
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col;
  if (uKaris > 0.5) {
    col = karis(j, k, l, m) * 0.5
        + karis(a, b, d, e) * 0.125 + karis(b, c, e, f) * 0.125
        + karis(d, e, g, h) * 0.125 + karis(e, f, h, i) * 0.125;
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 r = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + vec2(-r.x, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(r.x, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, -r.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(0.0, r.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(-r.x, -r.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(r.x, -r.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-r.x, r.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(r.x, r.y)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227027;
  c += texture2D(tSrc, vUv + uDir * 1.3846).rgb * 0.316216;
  c += texture2D(tSrc, vUv - uDir * 1.3846).rgb * 0.316216;
  c += texture2D(tSrc, vUv + uDir * 3.2308).rgb * 0.070270;
  c += texture2D(tSrc, vUv - uDir * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

const EXPOSURE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tPrev;
uniform float uBlend;
uniform float uKey;
uniform vec2 uRange; // min/max EV correction
varying vec2 vUv;
void main() {
  float acc = 0.0, wsum = 0.0;
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / 8.0;
    vec3 c = texture2D(tSrc, uv).rgb;
    float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
    vec2 d = uv - 0.5;
    float w = 1.0 - dot(d, d) * 1.6; // centre-weighted metering
    acc += log2(l) * w;
    wsum += w;
  }
  float avg = acc / wsum;
  float ev = clamp(log2(uKey) - avg, uRange.x, uRange.y);
  float prev = texture2D(tPrev, vec2(0.5)).r;
  float outEv = mix(prev, ev, uBlend);
  gl_FragColor = vec4(outEv, 0.0, 0.0, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tBlur;
uniform sampler2D tVol;
uniform sampler2D tExposure;
uniform float uHasVol;
uniform float uExposure;
uniform vec3 uTint;
uniform vec3 uLift;
uniform float uSaturation;
uniform float uContrast;
uniform float uVignette;
uniform float uGrain;
uniform float uBloom;
uniform float uCA;
uniform float uBlurAmt;
uniform float uFade;
uniform vec3 uFadeColor;
uniform float uTime;
uniform float uFlash;
uniform vec2 uRes;
varying vec2 vUv;

// AgX (Blender) — approximation by B. Wrensch (MIT)
vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 val) {
  const mat3 agx_mat = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                            0.0784335999999992, 0.878468636469772, 0.0784336,
                            0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float min_ev = -12.47393;
  const float max_ev = 4.026069;
  val = agx_mat * val;
  val = clamp(log2(max(val, 1e-10)), min_ev, max_ev);
  val = (val - min_ev) / (max_ev - min_ev);
  return agxDefaultContrastApprox(val);
}
vec3 agxEotf(vec3 val) {
  const mat3 agx_mat_inv = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                                -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                                -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  val = agx_mat_inv * val;
  return pow(max(val, 0.0), vec3(2.2));
}
vec3 agxLook(vec3 val, float sat, float contrast) {
  float luma = dot(val, vec3(0.2126, 0.7152, 0.0722));
  val = pow(max(val, 0.0), vec3(contrast));
  return luma + sat * (val - luma);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  vec2 dc = uv - 0.5;
  float r2 = dot(dc, dc);
  vec3 col;
  if (uCA > 0.0) {
    vec2 off = dc * r2 * uCA;
    col.r = texture2D(tScene, uv - off).r;
    col.g = texture2D(tScene, uv).g;
    col.b = texture2D(tScene, uv + off).b;
  } else {
    col = texture2D(tScene, uv).rgb;
  }
  if (any(isnan(col))) col = vec3(0.0);
  if (uHasVol > 0.5) col += texture2D(tVol, uv).rgb;
  if (uBlurAmt > 0.0) col = mix(col, texture2D(tBlur, uv).rgb, uBlurAmt);
  vec3 bloom = texture2D(tBloom, uv).rgb;
  col = mix(col, bloom, uBloom);
  float autoEv = texture2D(tExposure, vec2(0.5)).r;
  col *= uExposure * exp2(autoEv) * uTint;
  col += uFlash * vec3(0.8, 0.85, 1.0);
  col += uLift * 0.02;
  // Tone map (AgX) with look
  col = agx(col);
  col = agxLook(col, uSaturation, uContrast);
  col = agxEotf(col);
  // display-referred from here (linear, 0..1) -> encode to sRGB
  col = clamp(col, 0.0, 1.0);
  // Vignette (natural lens falloff)
  float vig = 1.0 - uVignette * smoothstep(0.1, 0.85, r2 * 1.8);
  col *= vig;
  // Fade to colour
  col = mix(col, uFadeColor, uFade);
  // sRGB OETF
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, col));
  // Film grain (luma-weighted, in display space) + dither
  float g = hash(uv * uRes + fract(uTime * 13.37) * 100.0) - 0.5;
  float lumaD = dot(col, vec3(0.299, 0.587, 0.114));
  col += g * uGrain * (1.0 - lumaD * 0.7);
  col += (hash(uv * uRes + 0.37) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Pipeline {
  renderer: THREE.WebGLRenderer;
  width = 1;
  height = 1;
  mainRT: THREE.WebGLRenderTarget;
  copyRT: THREE.WebGLRenderTarget;
  bloomMips: THREE.WebGLRenderTarget[] = [];
  blurRT: THREE.WebGLRenderTarget;
  blurRT2: THREE.WebGLRenderTarget;
  expRT: THREE.WebGLRenderTarget[];
  private expIdx = 0;
  private expMat: THREE.ShaderMaterial;
  exposureKey = 0.16;
  exposureRange = new THREE.Vector2(-2.5, 2.5);
  exposureSpeed = 1.6;
  private lastDt = 1 / 60;
  private firstExposure = true;
  private quad = new FullScreenQuad();
  private copyMat: THREE.ShaderMaterial;
  private downMat: THREE.ShaderMaterial;
  private upMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  compositeMat: THREE.ShaderMaterial;
  grade: GradeParams = {
    exposure: 1,
    tint: new THREE.Color(1, 1, 1),
    lift: new THREE.Color(0, 0, 0),
    saturation: 1.05,
    contrast: 1.05,
    vignette: 0.35,
    grain: 0.035,
    bloom: 0.045,
    ca: 0.012,
  };
  blurAmount = 0;
  fade = 1;
  fadeColor = new THREE.Color(0, 0, 0);
  flash = 0;
  volumeTexture: THREE.Texture | null = null;
  /** Hook for passes that run after the scene copy and before transparents (e.g. volumetrics). */
  onAfterOpaque: ((camera: THREE.PerspectiveCamera) => void) | null = null;
  onAfterTransparent: ((camera: THREE.PerspectiveCamera) => void) | null = null;
  msaa: number;
  bloomLevels = 6;

  constructor(renderer: THREE.WebGLRenderer, msaa: number) {
    this.renderer = renderer;
    this.msaa = msaa;
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.mainRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      samples: msaa,
      depthBuffer: true,
      depthTexture,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    this.copyRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    const mk = () =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
      });
    for (let i = 0; i < this.bloomLevels; i++) this.bloomMips.push(mk());
    this.blurRT = mk();
    this.blurRT2 = mk();
    const mkExp = () => {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
      return rt;
    };
    this.expRT = [mkExp(), mkExp()];
    this.expMat = fsMaterial(EXPOSURE_FRAG, {
      tSrc: { value: null },
      tPrev: { value: null },
      uBlend: { value: 1 },
      uKey: { value: 0.16 },
      uRange: { value: new THREE.Vector2(-2.5, 2.5) },
    });

    this.copyMat = fsMaterial(COPY_FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      uNearFar: { value: new THREE.Vector2(0.1, 1000) },
    });
    this.downMat = fsMaterial(DOWN_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uKaris: { value: 0 },
    });
    this.upMat = fsMaterial(UP_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1 },
    });
    this.upMat.blending = THREE.AdditiveBlending;
    this.upMat.transparent = true;
    this.blurMat = fsMaterial(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.compositeMat = fsMaterial(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      tBlur: { value: null },
      tVol: { value: null },
      tExposure: { value: null },
      uHasVol: { value: 0 },
      uExposure: { value: 1 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uLift: { value: new THREE.Color(0, 0, 0) },
      uSaturation: { value: 1 },
      uContrast: { value: 1 },
      uVignette: { value: 0.3 },
      uGrain: { value: 0.03 },
      uBloom: { value: 0.04 },
      uCA: { value: 0.0 },
      uBlurAmt: { value: 0 },
      uFade: { value: 0 },
      uFadeColor: { value: new THREE.Color(0, 0, 0) },
      uTime: { value: 0 },
      uFlash: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
    });
  }

  setSize(w: number, h: number) {
    w = Math.max(2, Math.floor(w));
    h = Math.max(2, Math.floor(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.mainRT.setSize(w, h);
    this.copyRT.setSize(w, h);
    let bw = Math.max(1, w >> 1),
      bh = Math.max(1, h >> 1);
    for (let i = 0; i < this.bloomLevels; i++) {
      this.bloomMips[i].setSize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    this.blurRT.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.blurRT2.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    U.uResolution.value.set(w, h);
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  resetExposure() {
    this.firstExposure = true;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, time: number, dt = 1 / 60) {
    const r = this.renderer;
    this.lastDt = dt;
    const prevAutoClear = r.autoClear;

    // 1. Opaque
    camera.layers.set(LAYER.OPAQUE);
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(this.mainRT);
    r.autoClear = true;
    r.render(scene, camera);

    // 2. Copy colour + linear depth
    this.copyMat.uniforms.tColor.value = this.mainRT.texture;
    this.copyMat.uniforms.tDepth.value = this.mainRT.depthTexture;
    this.copyMat.uniforms.uNearFar.value.set(camera.near, camera.far);
    this.pass(this.copyMat, this.copyRT);

    this.onAfterOpaque?.(camera);

    // 3. Transparent layer
    camera.layers.set(LAYER.TRANSPARENT);
    r.autoClear = false;
    const su = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.mainRT);
    r.render(scene, camera);
    r.shadowMap.autoUpdate = su;
    r.autoClear = prevAutoClear;
    camera.layers.set(LAYER.OPAQUE);

    this.onAfterTransparent?.(camera);
    r.autoClear = false;

    // 4. Bloom
    let src: THREE.Texture = this.mainRT.texture;
    let sw = this.width,
      sh = this.height;
    for (let i = 0; i < this.bloomLevels; i++) {
      this.downMat.uniforms.tSrc.value = src;
      this.downMat.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      this.downMat.uniforms.uKaris.value = i === 0 ? 1 : 0;
      this.pass(this.downMat, this.bloomMips[i]);
      src = this.bloomMips[i].texture;
      sw = this.bloomMips[i].width;
      sh = this.bloomMips[i].height;
    }
    // Auto exposure (GPU only, no readback)
    {
      const em = this.expMat.uniforms;
      const src = this.bloomMips[Math.min(4, this.bloomLevels - 1)];
      em.tSrc.value = src.texture;
      em.tPrev.value = this.expRT[this.expIdx].texture;
      em.uBlend.value = this.firstExposure ? 1 : 1 - Math.exp(-this.exposureSpeed * this.lastDt);
      em.uKey.value = this.exposureKey;
      em.uRange.value.copy(this.exposureRange);
      this.expIdx ^= 1;
      this.pass(this.expMat, this.expRT[this.expIdx]);
      this.firstExposure = false;
    }
    if (this.blurAmount > 0.001) {
      // Keep a clean blurred copy (for examine mode) before up-sampling pollutes the chain.
      this.blurMat.uniforms.tSrc.value = this.bloomMips[1].texture;
      this.blurMat.uniforms.uDir.value.set(1.5 / this.blurRT.width, 0);
      this.pass(this.blurMat, this.blurRT2);
      this.blurMat.uniforms.tSrc.value = this.blurRT2.texture;
      this.blurMat.uniforms.uDir.value.set(0, 1.5 / this.blurRT.height);
      this.pass(this.blurMat, this.blurRT);
    }
    for (let i = this.bloomLevels - 1; i > 0; i--) {
      this.upMat.uniforms.tSrc.value = this.bloomMips[i].texture;
      this.upMat.uniforms.uTexel.value.set(1 / this.bloomMips[i].width, 1 / this.bloomMips[i].height);
      this.upMat.uniforms.uRadius.value = 1.0;
      this.renderer.setRenderTarget(this.bloomMips[i - 1]);
      this.quad.material = this.upMat;
      this.quad.render(this.renderer);
    }

    // 5. Composite
    const u = this.compositeMat.uniforms;
    const g = this.grade;
    u.tScene.value = this.mainRT.texture;
    u.tBloom.value = this.bloomMips[0].texture;
    u.tBlur.value = this.blurRT.texture;
    u.tVol.value = this.volumeTexture;
    u.tExposure.value = this.expRT[this.expIdx].texture;
    u.uHasVol.value = this.volumeTexture ? 1 : 0;
    u.uExposure.value = g.exposure;
    u.uTint.value.copy(g.tint);
    u.uLift.value.copy(g.lift);
    u.uSaturation.value = g.saturation;
    u.uContrast.value = g.contrast;
    u.uVignette.value = g.vignette;
    u.uGrain.value = g.grain;
    u.uBloom.value = g.bloom / Math.max(1, this.bloomLevels * 0.5);
    u.uCA.value = g.ca;
    u.uBlurAmt.value = this.blurAmount;
    u.uFade.value = this.fade;
    u.uFadeColor.value.copy(this.fadeColor);
    u.uTime.value = time;
    u.uFlash.value = this.flash;
    u.uRes.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
    this.pass(this.compositeMat, null);
    r.autoClear = prevAutoClear;
  }
}
