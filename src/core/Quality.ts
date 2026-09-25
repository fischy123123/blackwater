// Device capability detection and quality tiers.

export type Tier = 'low' | 'medium' | 'high' | 'ultra';

export type QualitySettings = {
  tier: Tier;
  mobile: boolean;
  pixelRatio: number; // max device pixel ratio used
  renderScale: number; // dynamic resolution starting point
  minScale: number;
  msaa: number;
  shadowMapSize: number;
  shadowFar: number;
  skyCube: number;
  skySteps: number;
  skyFacesPerFrame: number;
  terrainDetail: number;
  terrainShadowRes: number;
  texSize: number;
  treeNear: number; // mesh trees within this range
  treeFar: number; // impostors up to this range
  grassRadius: number;
  grassDensity: number;
  volumetrics: boolean;
  volSteps: number;
  flashShadow: boolean;
  pointLights: number;
  rainCount: number;
  ssr: boolean;
  anisotropy: number;
};

export function detectQuality(gl: WebGL2RenderingContext, override?: string | null): QualitySettings {
  const ua = navigator.userAgent;
  const mobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)) ||
    (window.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900);
  let gpu = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    /* ignore */
  }
  const g = gpu.toLowerCase();
  let tier: Tier = 'high';
  if (mobile) {
    tier = /apple gpu|adreno \(tm\) 7[3-9]\d|adreno \(tm\) 8|mali-g7[1-9]|mali-g[89]|immortalis|xclipse/i.test(gpu) ? 'medium' : 'low';
    if (/apple/i.test(g) && !/apple gpu/i.test(g)) tier = 'medium';
  } else {
    if (/swiftshader|llvmpipe|software|microsoft basic/.test(g)) tier = 'low';
    else if (/intel|uhd|iris|mali|adreno|powervr/.test(g) && !/arc/.test(g)) tier = 'medium';
    else if (/rtx|radeon rx [67]|rx 7|rx 6[89]|arc a7|apple m[2-9] (pro|max|ultra)|m[3-9] max/.test(g)) tier = 'ultra';
    else if (/apple m/.test(g)) tier = 'high';
  }
  if (override === 'low' || override === 'medium' || override === 'high' || override === 'ultra') tier = override;
  return settingsFor(tier, mobile);
}

export function settingsFor(tier: Tier, mobile: boolean): QualitySettings {
  const dpr = window.devicePixelRatio || 1;
  const base: Record<Tier, Omit<QualitySettings, 'tier' | 'mobile'>> = {
    low: {
      pixelRatio: Math.min(dpr, mobile ? 1.5 : 1),
      renderScale: mobile ? 0.8 : 0.85,
      minScale: 0.5,
      msaa: 4,
      shadowMapSize: 1024,
      shadowFar: 70,
      skyCube: 160,
      skySteps: 10,
      skyFacesPerFrame: 1,
      terrainDetail: 0.8,
      terrainShadowRes: 512,
      texSize: 512,
      treeNear: 26,
      treeFar: 650,
      grassRadius: 18,
      grassDensity: 0.45,
      volumetrics: false,
      volSteps: 8,
      flashShadow: false,
      pointLights: 3,
      rainCount: 3500,
      ssr: false,
      anisotropy: 2,
    },
    medium: {
      pixelRatio: Math.min(dpr, mobile ? 2 : 1.25),
      renderScale: mobile ? 0.75 : 0.9,
      minScale: 0.5,
      msaa: 4,
      shadowMapSize: 1536,
      shadowFar: 100,
      skyCube: 192,
      skySteps: 14,
      skyFacesPerFrame: 1,
      terrainDetail: 1.0,
      terrainShadowRes: 768,
      texSize: 512,
      treeNear: 40,
      treeFar: 900,
      grassRadius: 26,
      grassDensity: 0.7,
      volumetrics: !mobile,
      volSteps: 12,
      flashShadow: !mobile,
      pointLights: 4,
      rainCount: 7000,
      ssr: true,
      anisotropy: 4,
    },
    high: {
      pixelRatio: Math.min(dpr, 1.5),
      renderScale: 1,
      minScale: 0.6,
      msaa: 4,
      shadowMapSize: 2048,
      shadowFar: 140,
      skyCube: 320,
      skySteps: 22,
      skyFacesPerFrame: 2,
      terrainDetail: 1.2,
      terrainShadowRes: 1024,
      texSize: 1024,
      treeNear: 60,
      treeFar: 1200,
      grassRadius: 36,
      grassDensity: 1,
      volumetrics: true,
      volSteps: 20,
      flashShadow: true,
      pointLights: 6,
      rainCount: 14000,
      ssr: true,
      anisotropy: 8,
    },
    ultra: {
      pixelRatio: Math.min(dpr, 2),
      renderScale: 1,
      minScale: 0.6,
      msaa: 4,
      shadowMapSize: 3072,
      shadowFar: 180,
      skyCube: 384,
      skySteps: 28,
      skyFacesPerFrame: 2,
      terrainDetail: 1.5,
      terrainShadowRes: 1024,
      texSize: 1024,
      treeNear: 80,
      treeFar: 1500,
      grassRadius: 44,
      grassDensity: 1.25,
      volumetrics: true,
      volSteps: 28,
      flashShadow: true,
      pointLights: 8,
      rainCount: 20000,
      ssr: true,
      anisotropy: 16,
    },
  };
  return { tier, mobile, ...base[tier] };
}

/** Adjusts render scale to hold a target frame time. */
export class DynamicResolution {
  scale: number;
  private acc = 0;
  private frames = 0;
  private cooldown = 2;
  private starved = 0;
  onStarved: ((avgFrame: number) => void) | null = null;
  constructor(public q: QualitySettings, public target = 1 / 55) {
    this.scale = q.renderScale;
    if (q.mobile) this.target = 1 / 45;
  }
  /** Returns true when the scale changed. */
  sample(dt: number): boolean {
    this.cooldown -= dt;
    if (dt > 0.25) return false; // hitch (tab switch etc.)
    this.acc += dt;
    this.frames++;
    if (this.frames < 45 || this.cooldown > 0) return false;
    const avg = this.acc / this.frames;
    this.acc = 0;
    this.frames = 0;
    let next = this.scale;
    if (avg > this.target * 1.12) next = Math.max(this.q.minScale, this.scale * 0.9);
    else if (avg < this.target * 0.78) next = Math.min(1, this.scale * 1.06);
    // already at the floor and still far too slow: ask the game to shed features
    if (this.scale <= this.q.minScale + 1e-3 && avg > this.target * 1.5) {
      this.starved++;
      if (this.starved >= 2) {
        this.starved = 0;
        this.onStarved?.(avg);
      }
    } else this.starved = 0;
    if (Math.abs(next - this.scale) > 0.01) {
      this.scale = next;
      this.cooldown = 2.5;
      return true;
    }
    return false;
  }
}
