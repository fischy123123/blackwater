// World light sources. A small pool of real point lights is assigned to the nearest
// active sources each frame; every source also gets an emissive "glow" billboard.
import * as THREE from 'three';
import { LAYER, U } from '../render/Globals';
import { GLSL_FOG_FN, GLSL_FOG_UNIFORMS } from '../render/Chunks';
import { fogUniforms } from '../render/WindowShader';

export type LightKind = 'sodium' | 'incandescent' | 'fluorescent' | 'fire' | 'neon' | 'mercury' | 'red';

export type LightSource = {
  id: string;
  group: string;
  pos: THREE.Vector3;
  color: THREE.Color;
  power: number; // physical intensity (scene units ~ cd * 1e-3)
  range: number;
  kind: LightKind;
  on: number; // current 0..1
  target: number;
  delay: number; // seconds before switching toward target
  warm: number; // sodium warm-up progress
  flicker: number; // 0 = steady
  glowSize: number;
  glowIndex: number;
  castLight: boolean;
};

const KIND_COLOR: Record<LightKind, [number, number, number]> = {
  sodium: [1.0, 0.56, 0.2],
  incandescent: [1.0, 0.72, 0.42],
  fluorescent: [0.86, 0.95, 1.0],
  fire: [1.0, 0.5, 0.18],
  neon: [1.0, 0.25, 0.2],
  mercury: [0.78, 0.92, 1.0],
  red: [1.0, 0.08, 0.05],
};

const GLOW_VERT = /* glsl */ `
attribute vec4 aGlow; // xyz position, w size
attribute vec4 aColor; // rgb colour * intensity, a = on
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorld;
void main() {
  vUv = position.xy;
  vColor = aColor;
  vec3 c = aGlow.xyz;
  vec3 toCam = normalize(cameraPosition - c);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = cross(toCam, right);
  float d = distance(cameraPosition, c);
  // keep a minimum apparent size so distant lamps still read as points of light
  float size = max(aGlow.w, d * 0.004);
  vec3 wp = c + (right * position.x + up * position.y) * size + toCam * 0.3;
  vWorld = c;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (aColor.a < 0.002) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}
`;
const GLOW_FRAG = /* glsl */ `
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform float uGlowScale;
uniform sampler2D tDepth;
uniform vec2 uRes;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vWorld;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float core = exp(-r * r * 60.0);
  float halo = exp(-r * r * 6.0) * 0.18 + exp(-r * 3.0) * 0.05;
  // soft occlusion test against the scene depth at the lamp centre (4 taps)
  vec3 col = vColor.rgb * vColor.a * (core * 4.0 + halo) * uGlowScale;
  vec4 f = bwFogSegment(cameraPosition, vWorld);
  gl_FragColor = vec4(col * f.a, 1.0);
}
`;

export class LightManager {
  sources: LightSource[] = [];
  pool: THREE.PointLight[] = [];
  glowMesh: THREE.Mesh;
  private glowPos: Float32Array;
  private glowCol: Float32Array;
  private maxGlow = 512;
  private geo: THREE.InstancedBufferGeometry;
  private time = 0;
  preExposure = 1;
  onFlickerSound: ((s: LightSource) => void) | null = null;

  constructor(scene: THREE.Scene, poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 2);
      l.castShadow = false;
      l.layers.enableAll();
      scene.add(l);
      this.pool.push(l);
    }
    this.geo = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(2, 2);
    this.geo.index = q.index;
    this.geo.setAttribute('position', q.getAttribute('position'));
    this.glowPos = new Float32Array(this.maxGlow * 4);
    this.glowCol = new Float32Array(this.maxGlow * 4);
    this.geo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(this.glowPos, 4));
    this.geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.glowCol, 4));
    (this.geo.getAttribute('aColor') as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: { ...fogUniforms(), uGlowScale: { value: 1 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.glowMesh = new THREE.Mesh(this.geo, mat);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.layers.set(LAYER.TRANSPARENT);
    this.glowMesh.renderOrder = 10;
    scene.add(this.glowMesh);
  }

  add(o: Partial<LightSource> & { id: string; pos: THREE.Vector3; kind: LightKind; power: number }) {
    const c = KIND_COLOR[o.kind];
    const s: LightSource = {
      group: 'misc',
      color: new THREE.Color(c[0], c[1], c[2]),
      range: 25,
      on: 0,
      target: 0,
      delay: 0,
      warm: 0,
      flicker: 0,
      glowSize: 0.35,
      glowIndex: -1,
      castLight: true,
      ...o,
    };
    if (this.sources.length < this.maxGlow) {
      s.glowIndex = this.sources.length;
      this.glowPos.set([s.pos.x, s.pos.y, s.pos.z, s.glowSize], s.glowIndex * 4);
      this.geo.instanceCount = this.sources.length + 1;
      (this.geo.getAttribute('aGlow') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
    this.sources.push(s);
    return s;
  }

  /** Switch a group on/off, optionally staggered along a direction (e.g. streetlights down the hill). */
  setGroup(group: string, on: boolean, stagger = 0, origin?: THREE.Vector3) {
    for (const s of this.sources) {
      if (s.group !== group) continue;
      s.target = on ? 1 : 0;
      s.delay = stagger > 0 && origin ? s.pos.distanceTo(origin) * stagger + Math.random() * 0.3 : Math.random() * 0.15;
      if (!on) s.warm = 0;
    }
  }

  get(id: string) {
    return this.sources.find((s) => s.id === id);
  }

  update(dt: number, cam: THREE.Vector3, pe: number) {
    this.time += dt;
    this.preExposure = pe;
    const colAttr = this.geo.getAttribute('aColor') as THREE.InstancedBufferAttribute;
    const cand: { s: LightSource; score: number }[] = [];
    for (const s of this.sources) {
      if (s.delay > 0) s.delay -= dt;
      else {
        const rate = s.kind === 'sodium' ? 0.35 : s.kind === 'fluorescent' ? 3 : 6;
        if (s.target > s.on) s.on = Math.min(s.target, s.on + dt * rate);
        else s.on = Math.max(s.target, s.on - dt * 8);
      }
      let level = s.on;
      // fluorescent tubes flicker as they strike
      if (s.kind === 'fluorescent' && s.on > 0 && s.on < 0.99) level = Math.random() < 0.5 ? 0.05 : s.on;
      if (s.kind === 'fire') level *= 0.75 + 0.25 * Math.sin(this.time * 9 + s.pos.x) * Math.sin(this.time * 13.7 + s.pos.z) + 0.1 * Math.random();
      if (s.flicker > 0) {
        const f = Math.sin(this.time * 31 + s.pos.x * 3) * Math.sin(this.time * 7.3 + s.pos.z);
        if (f > 1 - s.flicker * 0.3) level *= Math.random() < 0.5 ? 0.1 : 1;
      }
      // sodium lamps start deep red-orange and warm into their amber
      const col = s.color;
      let r = col.r,
        g = col.g,
        b = col.b;
      if (s.kind === 'sodium') {
        const w = s.on;
        g *= 0.35 + 0.65 * w * w;
        b *= 0.3 + 0.7 * w;
        level *= 0.25 + 0.75 * w;
      }
      const k = level * s.power;
      if (s.glowIndex >= 0) {
        const vis = s.power * 4 * pe;
        colAttr.array[s.glowIndex * 4] = r * vis;
        colAttr.array[s.glowIndex * 4 + 1] = g * vis;
        colAttr.array[s.glowIndex * 4 + 2] = b * vis;
        colAttr.array[s.glowIndex * 4 + 3] = level;
      }
      if (k > 0 && s.castLight) {
        const d = s.pos.distanceTo(cam);
        if (d < s.range * 3.5) cand.push({ s, score: (k / Math.max(1, d * d)) * (d < s.range ? 4 : 1) });
      }
      (s as LightSource & { _level?: number })._level = level;
    }
    colAttr.needsUpdate = true;
    cand.sort((a, b) => b.score - a.score);
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i];
      const c = cand[i];
      if (!c) {
        l.intensity = 0;
        l.visible = false;
        continue;
      }
      const s = c.s;
      const level = (s as LightSource & { _level?: number })._level ?? 0;
      l.visible = true;
      l.position.copy(s.pos);
      l.color.copy(s.color);
      if (s.kind === 'sodium') l.color.setRGB(s.color.r, s.color.g * (0.35 + 0.65 * s.on * s.on), s.color.b * (0.3 + 0.7 * s.on));
      l.distance = s.range;
      // fade by distance so pool switching isn't visible
      const d = s.pos.distanceTo(cam);
      const fade = 1 - THREE.MathUtils.smoothstep(d, s.range * 2.2, s.range * 3.4);
      l.intensity = s.power * level * pe * fade;
    }
    U.uTime.value = U.uTime.value; // keep
  }
}
