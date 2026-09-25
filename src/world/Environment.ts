// Time of day, weather and lighting. Owns the sky light (sun/moon, cascaded shadows),
// lightning, fog, exposure and colour grade. The story sets targets; values ease toward them.
import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { U } from '../render/Globals';
import { SkySystem, SUN_E, sunTransmittance } from '../render/Sky';
import type { Pipeline } from '../render/Pipeline';
import { clamp, DEG, lerp, smoothstep, damp, RNG } from '../core/math';
import { BuildingLights } from '../render/WindowShader';

export type Weather = {
  coverage: number;
  cloudDensity: number;
  cloudBase: number;
  cloudTop: number;
  storm: number; // 0..1 darkness/overcast
  rain: number; // 0..1
  wind: number; // 0..1
  haze: number;
  fog: number; // base fog density multiplier
  mist: number; // ground mist density
  mistHeight: number;
  bank: number; // sea fog bank density
  bankZ: number;
  lightning: number; // strikes per minute
};

export const WEATHER_PRESETS: Record<string, Weather> = {
  golden: { coverage: 0.42, cloudDensity: 0.9, cloudBase: 1500, cloudTop: 3400, storm: 0, rain: 0, wind: 0.28, haze: 0.45, fog: 1, mist: 0.0, mistHeight: 10, bank: 0.012, bankZ: 700, lightning: 0 },
  dusk: { coverage: 0.5, cloudDensity: 1, cloudBase: 1300, cloudTop: 3400, storm: 0.1, rain: 0, wind: 0.4, haze: 1.0, fog: 1.2, mist: 0.0015, mistHeight: 7, bank: 0.014, bankZ: 650, lightning: 0 },
  gathering: { coverage: 0.78, cloudDensity: 1.3, cloudBase: 1000, cloudTop: 3800, storm: 0.45, rain: 0.05, wind: 0.65, haze: 1.2, fog: 1.6, mist: 0.001, mistHeight: 8, bank: 0.016, bankZ: 560, lightning: 1.2 },
  storm: { coverage: 0.98, cloudDensity: 1.8, cloudBase: 700, cloudTop: 4200, storm: 1, rain: 1, wind: 1, haze: 1.6, fog: 3.0, mist: 0.0, mistHeight: 8, bank: 0.02, bankZ: 420, lightning: 6 },
  clearing: { coverage: 0.55, cloudDensity: 1.1, cloudBase: 1200, cloudTop: 3600, storm: 0.25, rain: 0, wind: 0.45, haze: 1.2, fog: 1.6, mist: 0.004, mistHeight: 9, bank: 0.018, bankZ: 600, lightning: 0.2 },
  dawn: { coverage: 0.4, cloudDensity: 1.0, cloudBase: 1400, cloudTop: 3300, storm: 0.05, rain: 0, wind: 0.2, haze: 1.1, fog: 1.3, mist: 0.006, mistHeight: 10, bank: 0.022, bankZ: 700, lightning: 0 },
  aftermath: { coverage: 0.45, cloudDensity: 1.0, cloudBase: 1300, cloudTop: 3400, storm: 0.1, rain: 0, wind: 0.35, haze: 0.9, fog: 1.0, mist: 0.002, mistHeight: 8, bank: 0.0, bankZ: 1400, lightning: 0 },
};

export type Grade = { tint: THREE.Color; lift: THREE.Color; sat: number; contrast: number; ev: number };

type Strike = { t: number; dur: number; dir: THREE.Vector3; dist: number; power: number; flickers: number[] };

export class Environment {
  time = 15.5; // solar hours
  targetTime = 15.5;
  timeRate = 0; // hours per second drift when not transitioning
  weather: Weather = { ...WEATHER_PRESETS.golden };
  target: Weather = { ...WEATHER_PRESETS.golden };
  weatherLambda = 0.05;
  timeLambda = 0.0;
  sunDir = new THREE.Vector3();
  moonDir = new THREE.Vector3();
  sun: SunLight;
  lightningLight: THREE.DirectionalLight;
  preExposure = 1;
  exposureBias = 0; // EV, story-controlled
  localKey = 0; // extra adaptation from local lights (interiors)
  wetness = 0;
  strikes: Strike[] = [];
  onThunder: ((delay: number, power: number, dist: number) => void) | null = null;
  onStrike: ((s: Strike) => void) | null = null;
  private rng = new RNG(99);
  private nextStrike = 8;
  private sunCol = new THREE.Color();
  private tmpC = new THREE.Color();
  private adaptedEV = 0;
  private sky: SkySystem;
  private pipeline: Pipeline;
  scene: THREE.Scene;
  lightningAmount = 0;
  forcedStrike = false;
  windDir = new THREE.Vector2(0.55, -0.83);
  gust = 0;
  private gustPhase = 0;

  constructor(scene: THREE.Scene, sky: SkySystem, pipeline: Pipeline, shadow: { size: number; far: number }) {
    this.scene = scene;
    this.sky = sky;
    this.pipeline = pipeline;
    this.sun = new SunLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadow.size, shadow.size);
    this.sun.shadow.camera.far = shadow.far;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 2;
    this.sun.layers.enableAll();
    scene.add(this.sun);
    this.lightningLight = new THREE.DirectionalLight(0xc8d4ff, 0);
    this.lightningLight.layers.enableAll();
    scene.add(this.lightningLight);
    scene.add(this.lightningLight.target);
  }

  /** Jump instantly (loading a checkpoint). */
  snap(time: number, preset: keyof typeof WEATHER_PRESETS) {
    this.time = this.targetTime = time;
    this.weather = { ...WEATHER_PRESETS[preset] };
    this.target = { ...WEATHER_PRESETS[preset] };
    this.wetness = this.weather.rain > 0.5 ? 0.9 : preset === 'clearing' || preset === 'dawn' ? 0.6 : 0;
  }

  setWeather(preset: keyof typeof WEATHER_PRESETS, seconds = 40) {
    this.target = { ...WEATHER_PRESETS[preset] };
    this.weatherLambda = 3 / Math.max(1, seconds);
  }

  setTime(t: number, seconds = 60) {
    this.targetTime = t;
    this.timeLambda = 3 / Math.max(1, seconds);
  }

  static solar(hours: number, out: THREE.Vector3) {
    const lat = 47 * DEG,
      dec = -21 * DEG;
    const H = (hours - 12) * 15 * DEG;
    const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
    const el = Math.asin(clamp(sinEl, -1, 1));
    const cosAz = (Math.sin(dec) - Math.sin(el) * Math.sin(lat)) / Math.max(1e-4, Math.cos(el) * Math.cos(lat));
    let az = Math.acos(clamp(cosAz, -1, 1));
    if (H > 0) az = Math.PI * 2 - az;
    out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    return out;
  }

  triggerStrike(dir?: THREE.Vector3, dist = 1500, power = 1) {
    const d = dir ?? new THREE.Vector3(this.rng.range(-0.8, 0.8), 0, this.rng.range(0.3, 1)).normalize();
    d.y = 0.35;
    d.normalize();
    const flickers: number[] = [];
    const n = this.rng.int(2, 4);
    for (let i = 0; i < n; i++) flickers.push(this.rng.range(0, 0.35));
    const s: Strike = { t: 0, dur: 0.6, dir: d, dist, power, flickers };
    this.strikes.push(s);
    this.onStrike?.(s);
    this.onThunder?.(dist / 343, power, dist);
  }

  update(dt: number, camera: THREE.Camera) {
    const w = this.weather,
      tg = this.target;
    // ease weather
    const k = 1 - Math.exp(-this.weatherLambda * dt);
    for (const key of Object.keys(w) as (keyof Weather)[]) {
      w[key] = lerp(w[key], tg[key], k);
    }
    // time
    if (this.timeLambda > 0) {
      this.time = damp(this.time, this.targetTime, this.timeLambda, dt);
      if (Math.abs(this.time - this.targetTime) < 0.001) this.timeLambda = 0;
    }
    this.time += this.timeRate * dt;

    Environment.solar(this.time, this.sunDir);
    // Moon: high in the south-south-east through the night
    const mt = (this.time - 17) / 12;
    const mAz = (150 + mt * 60) * DEG,
      mEl = (18 + Math.sin(clamp(mt, 0, 1) * Math.PI) * 16) * DEG;
    this.moonDir.set(Math.sin(mAz) * Math.cos(mEl), Math.sin(mEl), -Math.cos(mAz) * Math.cos(mEl));

    // wetness follows rain slowly; dries very slowly
    const wetTarget = w.rain > 0.05 ? Math.min(1, 0.4 + w.rain) : 0;
    this.wetness = wetTarget > this.wetness ? damp(this.wetness, wetTarget, 0.12, dt) : damp(this.wetness, wetTarget, 0.004, dt);

    // wind gusts
    this.gustPhase += dt * (0.25 + w.wind * 0.5);
    this.gust = clamp(0.5 + 0.5 * Math.sin(this.gustPhase) * Math.sin(this.gustPhase * 0.37 + 1.3) + (Math.sin(this.gustPhase * 2.9) * 0.15), 0, 1);

    // ---------------------------------------------------------- lighting
    const sunEl = Math.asin(this.sunDir.y) / DEG;
    const cloudDim = 1 - w.storm * 0.82 - Math.max(0, w.coverage - 0.5) * 0.35;
    sunTransmittance(Math.asin(this.sunDir.y), 20, w.haze, this.sunCol);
    const sunE = SUN_E * this.sunCol.r; // rough scalar
    // sky illuminance (fit)
    let skyE = sunEl > 0 ? 0.55 + 18 * (1 - Math.exp(-sunEl / 12)) : 0.55 * Math.exp(sunEl * 0.87);
    skyE = skyE * (0.35 + 0.65 * cloudDim) + 6e-6;
    const moonUp = smoothstep(-0.02, 0.1, this.moonDir.y);
    const moonE = 0.0003 * moonUp * (1 - w.storm * 0.9);
    // direct light (shadows fade with clouds)
    const sunVis = smoothstep(-0.5, 1.5, sunEl);
    const useMoon = sunEl < -3;
    const directDim = clamp(cloudDim * (1 - w.storm), 0, 1);
    if (!useMoon) {
      this.sun.position.copy(this.sunDir);
      this.tmpC.copy(this.sunCol).multiplyScalar(SUN_E * sunVis * directDim);
    } else {
      this.sun.position.copy(this.moonDir);
      this.tmpC.setRGB(0.62, 0.72, 1.0).multiplyScalar(moonE * smoothstep(-3, -6, sunEl) * 0.9 * (1 - w.storm));
    }
    // Exposure adaptation (EV compressed so night stays night)
    const Etotal = (useMoon ? moonE : sunE * sunVis * directDim) * 0.6 + skyE + this.localKey;
    const ev = Math.log2(Math.max(Etotal, 1e-7));
    const adapted = ev * 0.8 + this.exposureBias * 0.8;
    this.adaptedEV = this.adaptedEV === 0 ? adapted : damp(this.adaptedEV, adapted, 1.4, dt);
    this.preExposure = Math.PI * 0.5 * Math.pow(2, -this.adaptedEV - 1.2);

    const pe = this.preExposure;
    this.sun.color.copy(this.tmpC).multiplyScalar(pe);
    this.sun.intensity = 1;
    this.sun.castShadow = this.tmpC.r + this.tmpC.g > 1e-6;
    this.sun.shadow.intensity = clamp(directDim * 1.1, 0.25, 1);
    this.scene.environmentIntensity = pe * (useMoon ? 1.0 : 1.0);

    // lightning
    this.updateLightning(dt, pe, camera);

    // ---------------------------------------------------------- sky
    const sp = this.sky.params;
    sp.coverage = w.coverage;
    sp.density = w.cloudDensity;
    sp.base = w.cloudBase;
    sp.top = w.cloudTop;
    sp.storm = w.storm;
    sp.haze = w.haze;
    sp.stars = smoothstep(-4, -12, sunEl) * (1 - w.storm) * 0.9;
    sp.moonLight = moonUp * (1 - smoothstep(-2, 4, sunEl));
    const night = smoothstep(-2, -10, sunEl);
    // Cloud lighting colour: sun transmittance at cloud altitude (reddens at sunset)
    sunTransmittance(Math.asin(this.sunDir.y), 1500, w.haze, this.tmpC);
    const cloudSun = this.tmpC.multiplyScalar(SUN_E * smoothstep(-6, 0, sunEl) * 0.8);
    if (useMoon) cloudSun.setRGB(0.6, 0.7, 1).multiplyScalar(moonE * 1.2);
    this.sky.cloudOffset.x += this.windDir.x * (6 + w.wind * 30) * dt;
    this.sky.cloudOffset.y += this.windDir.y * (6 + w.wind * 30) * dt;
    this.sky.camPos.copy(camera.position);
    this.sky.fogColorPhys.setRGB(0.55, 0.62, 0.75).multiplyScalar(skyE * 0.06 + 1e-6);
    this.sky.fogSunPhys.copy(this.sunCol).multiplyScalar(SUN_E * sunVis * directDim * 0.05 + (useMoon ? moonE * 0.3 : 0));
    this.sky.update(dt, this.sunDir, this.moonDir, cloudSun, night);

    const du = this.sky.domeUniforms;
    du.uMoonDirW.value.copy(this.moonDir);
    const sunSolid = Math.PI * 0.0075 * 0.0075;
    du.uSunRadiance.value.copy(this.sunCol).multiplyScalar((SUN_E / sunSolid) * 0.05 * smoothstep(-1, 0.5, sunEl));
    du.uMoonRadiance.value.setRGB(1.0, 0.97, 0.9).multiplyScalar(0.012 * (1 - smoothstep(-4, 3, sunEl) * 0.7));
    du.uStars.value = sp.stars;
    du.uStarRot.value = this.time * 0.2618 * 0.3;
    U.uSkyExposure.value = pe;

    // ---------------------------------------------------------- globals
    U.uSunDir.value.copy(useMoon ? this.moonDir : this.sunDir);
    U.uMoonDir.value.copy(this.moonDir);
    U.uLightDir.value.copy(useMoon ? this.moonDir : this.sunDir);
    U.uLightColor.value.copy(this.sun.color);
    U.uSunColor.value.copy(this.sunCol).multiplyScalar(SUN_E * pe * sunVis);
    U.uAmbient.value.setRGB(0.55, 0.65, 0.85).multiplyScalar(skyE * pe * 0.2);
    // interior-mapped rooms: warm lamps vs daylight leaking in
    BuildingLights.interior.value.setRGB(1.0, 0.72, 0.42).multiplyScalar(0.0045 * pe);
    BuildingLights.ambientIn.value.setRGB(0.75, 0.8, 0.9).multiplyScalar(skyE * pe * 0.012 + moonE * pe * 0.05);
    // fog
    U.uFogDensity.value = 0.00016 * w.fog * (1 + w.rain * 2);
    U.uFogFalloff.value = 0.009;
    U.uFogBase.value = 0;
    U.uFogColor.value.setRGB(0.55, 0.62, 0.75).multiplyScalar(skyE * 0.06 + 1e-6);
    U.uFogSun.value.copy(this.sunCol).multiplyScalar(SUN_E * sunVis * directDim * 0.05 + (useMoon ? moonE * 0.3 : 0));
    U.uMist.value = w.mist;
    U.uMistHeight.value = w.mistHeight;
    U.uBankDensity.value = w.bank;
    U.uBankZ.value = w.bankZ;
    U.uRain.value = w.rain;
    U.uWetness.value = this.wetness;
    U.uWindStrength.value = w.wind;
    U.uGust.value = this.gust;
    U.uWind.value.set(this.windDir.x, 0, this.windDir.y);

    // ---------------------------------------------------------- grade
    const g = this.pipeline.grade;
    const golden = smoothstep(-2, 3, sunEl) * (1 - smoothstep(10, 22, sunEl));
    const blue = smoothstep(2, -3, sunEl) * (1 - smoothstep(-8, -14, sunEl));
    const nightK = smoothstep(-6, -14, sunEl);
    g.tint.setRGB(1, 1, 1);
    g.tint.lerp(this.tmpC.setRGB(1.06, 1.0, 0.9), golden * (1 - w.storm));
    g.tint.lerp(this.tmpC.setRGB(0.9, 0.97, 1.1), blue);
    g.tint.lerp(this.tmpC.setRGB(0.86, 0.96, 1.08), nightK);
    g.tint.lerp(this.tmpC.setRGB(0.88, 0.98, 1.02), w.storm * 0.7);
    g.lift.setRGB(0.05, 0.06, 0.12).multiplyScalar(0.3 + nightK * 0.6);
    g.saturation = lerp(1.08, 0.86, w.storm) * lerp(1, 0.9, nightK) + golden * 0.06;
    g.contrast = 1.04 + w.storm * 0.06 + golden * 0.03;
    g.exposure = 1;
  }

  private updateLightning(dt: number, pe: number, camera: THREE.Camera) {
    const w = this.weather;
    if (w.lightning > 0.05) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        this.nextStrike = (60 / w.lightning) * this.rng.range(0.4, 1.6);
        const dist = this.rng.range(700, 5000);
        this.triggerStrike(undefined, dist, this.rng.range(0.5, 1.2) * (dist < 1500 ? 1.4 : 1));
      }
    }
    let flash = 0;
    let dir: THREE.Vector3 | null = null;
    for (const s of this.strikes) {
      s.t += dt;
      for (const f of s.flickers) {
        const x = s.t - f;
        if (x > 0) flash = Math.max(flash, s.power * Math.exp(-x * 22) * (1 / (1 + s.dist / 2500)));
      }
      dir = s.dir;
    }
    this.strikes = this.strikes.filter((s) => s.t < s.dur);
    this.lightningAmount = flash;
    U.uLightning.value = flash * 0.25;
    if (dir) {
      this.lightningLight.position.copy(dir).multiplyScalar(100).add(camera.position);
      this.lightningLight.target.position.copy(camera.position);
      this.sky.domeUniforms.uLightningDir.value.copy(dir);
    }
    // lightning light in physical units: bright but brief
    this.lightningLight.intensity = flash * 0.004 * pe;
    this.pipeline.flash = flash * 0.02;
  }
}
