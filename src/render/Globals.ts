// Shared uniforms: one object per uniform, referenced by every material that needs it,
// so updating `.value` once per frame updates the whole world.
import * as THREE from 'three';

export const U = {
  uTime: { value: 0 },
  // Dominant sky light (sun by day, moon by night) — direction *towards* the light.
  uSunDir: { value: new THREE.Vector3(0.3, 0.4, 0.8).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.9, 0.8) },
  uMoonDir: { value: new THREE.Vector3(-0.3, 0.5, -0.8).normalize() },
  uLightDir: { value: new THREE.Vector3(0.3, 0.4, 0.8).normalize() },
  uLightColor: { value: new THREE.Color(1, 0.9, 0.8) },
  uAmbient: { value: new THREE.Color(0.3, 0.35, 0.45) }, // average sky irradiance / PI
  uSkyCube: { value: null as THREE.Texture | null },
  uSkyExposure: { value: 1 },

  // Fog / aerial perspective
  uFogDensity: { value: 0.00035 },
  uFogFalloff: { value: 0.012 },
  uFogBase: { value: 0 },
  uFogColor: { value: new THREE.Color(0.5, 0.55, 0.6) },
  uFogSun: { value: new THREE.Color(1, 0.8, 0.6) },
  uMist: { value: 0 }, // extra low ground mist density
  uMistHeight: { value: 6 },
  uBankZ: { value: 720 }, // sea-fog bank starts here (z)
  uBankDensity: { value: 0.012 },
  uBankClear: { value: new THREE.Vector4(0, 1100, 0, 0) }, // (x, z, radius, amount) clear pocket

  // Weather
  uWetness: { value: 0 },
  uRain: { value: 0 },
  uWind: { value: new THREE.Vector3(1, 0, 0.3) }, // xz = direction, y unused
  uWindStrength: { value: 0.3 },
  uGust: { value: 0 },
  uLightning: { value: 0 },
  uLightningPos: { value: new THREE.Vector3(0, 800, 2000) },
  uSnowline: { value: 10000 },

  // Terrain data used by other shaders (e.g. wetness, grass placement)
  uHeightTex: { value: null as THREE.Texture | null },
  uTerrainInfo: { value: new THREE.Vector4(-1024, -800, 2048, 1025) }, // minX, minZ, size, res
  uTerrainShadow: { value: null as THREE.Texture | null }, // horizon shadow map (1 = lit)

  // Rain occlusion (top-down depth around the player)
  uOccTex: { value: null as THREE.Texture | null },
  uOccInfo: { value: new THREE.Vector4(0, 0, 128, 0) }, // centerX, centerZ, size, enabled
  uOccRange: { value: new THREE.Vector2(-50, 200) },

  // Interior lighting controls
  uInteriorAmbient: { value: new THREE.Color(0.02, 0.02, 0.025) },

  // Flashlight (for cheap effects like rain glints & particle lighting)
  uFlashPos: { value: new THREE.Vector3() },
  uFlashDir: { value: new THREE.Vector3(0, 0, -1) },
  uFlashOn: { value: 0 },

  // Screen
  uResolution: { value: new THREE.Vector2(1, 1) },
};

export type GlobalUniforms = typeof U;

/** Layers used by the multi-stage pipeline. */
export const LAYER = {
  OPAQUE: 0,
  TRANSPARENT: 1, // water, glass, particles: rendered after the scene copy
  OCCLUDER: 2, // rain occlusion (roofs etc.)
  REFLECT: 3, // included in cube captures
};
