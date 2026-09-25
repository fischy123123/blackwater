// Story locations: utility yard (substation + relay mast), lighthouse, the trail across
// the flats (footprints, lanterns, range lights, wreck, whale bones, figures), the wall.
import * as THREE from 'three';
import { MeshBatcher } from './Batcher';
import type { CollisionWorld } from './Collision';
import type { LightManager } from './Lights';
import type { Terrain } from './Terrain';
import { P, TRAIL } from './Layout';
import { sampleCatmull, RNG, smoothstep } from '../core/math';
import { LAYER, U } from '../render/Globals';
import { GLSL_FOG_FN, GLSL_FOG_UNIFORMS, GLSL_NOISE } from '../render/Chunks';
import { fogUniforms } from '../render/WindowShader';
import { SHARED_MATS } from './Dressing';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export type PlacesResult = {
  group: THREE.Group;
  yard: { hut: THREE.Vector3; panel: THREE.Vector3; mastTop: THREE.Vector3; transformer: THREE.Vector3; gate: THREE.Vector3 };
  lighthouse: {
    base: THREE.Vector3;
    lampRoom: THREE.Vector3;
    lens: THREE.Group;
    beams: THREE.Mesh;
    door: THREE.Vector3;
    gallery: THREE.Vector3;
    lensMotor: THREE.Vector3;
    cliffTop: THREE.Vector3;
  };
  trail: { points: THREE.Vector3[]; lanterns: THREE.Vector3[]; rangeLights: THREE.Vector3[]; items: { id: string; pos: THREE.Vector3; label: string }[] };
  figures: THREE.Group;
  tower: { base: THREE.Vector3; top: THREE.Vector3; ladder: THREE.Vector3 };
  wall: THREE.Mesh;
  lhGate: { pos: THREE.Vector3; yaw: number; bar: THREE.Group };
  footprints: THREE.Mesh;
};

// --------------------------------------------------------------------------- beam shader
const BEAM_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BEAM_FRAG = /* glsl */ `
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform float uIntensity;
uniform float uLen;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  // local: x along the beam (0..len), y/z across
  float t = clamp(vLocal.x / uLen, 0.0, 1.0);
  float r = length(vLocal.yz) / (0.35 + t * uLen * 0.07);
  float core = exp(-r * r * 2.6);
  float along = (1.0 - t) * (1.0 - t) * smoothstep(0.0, 0.02, t);
  vec3 V = normalize(vWorld - cameraPosition);
  // brighter when looking down the beam
  float scatterDensity = uFogDensity * 400.0 + uMist * 60.0 + uBankDensity * 30.0 + 0.25;
  vec3 col = vec3(1.0, 0.93, 0.78) * core * along * uIntensity * scatterDensity;
  vec4 f = bwFogSegment(cameraPosition, vWorld);
  gl_FragColor = vec4(col * (0.4 + 0.6 * f.a), 1.0);
}`;

// --------------------------------------------------------------------------- the wall of water
const WALL_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;
uniform float uTime;
uniform vec4 uTouch; // xyz point, w time since touch
uniform float uCollapse; // 0 standing .. 1 fallen
void main() {
  vec3 p = position;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  float h = max(wp.y + 20.0, 0.0);
  // Collapse: the top comes down first and the mass surges toward the shore (-z) as it falls.
  float k = smoothstep(0.0, 1.0, uCollapse);
  float fall = clamp(k * 1.7 - (1.0 - h / 330.0) * 0.7, 0.0, 1.0);
  fall = fall * fall * (3.0 - 2.0 * fall);
  wp.y = -20.0 + h * (1.0 - fall * 0.96);
  wp.z -= fall * (30.0 + h * 0.45) + k * 50.0;
  wp.z -= sin(wp.x * 0.004 + 1.3) * 40.0 * fall;
  // slow internal slump
  wp.z += sin(wp.x * 0.01 + uTime * 0.2) * 0.4 * (1.0 - k);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const WALL_FRAG = /* glsl */ `
${GLSL_NOISE}
${GLSL_FOG_UNIFORMS}
${GLSL_FOG_FN}
uniform float uTime;
uniform vec4 uTouch;
uniform vec3 uSunColor2;
uniform vec3 uSunColorW;
uniform float uCollapse;
varying vec3 vWorld;
varying vec3 vN;
varying vec2 vUv;

// a slow whale: elongated body with a tail fluke, in wall-plane coordinates (metres)
float whale(vec2 p, vec2 c, float s) {
  vec2 q = (p - c) / s;
  float body = length(q * vec2(0.13, 0.55)) - 1.0;
  vec2 t = q - vec2(-9.0, 0.3 * sin(uTime * 0.6));
  float tail = length(t * vec2(0.9, 0.35)) - 1.0;
  float fin = length((q - vec2(2.0, -1.2)) * vec2(0.6, 1.2)) - 1.0;
  return min(min(body, tail), fin);
}

void main() {
  vec3 V = normalize(vWorld - cameraPosition);
  vec3 n = normalize(vN);
  if (dot(n, V) > 0.0) n = -n;
  float t = uTime;
  vec2 q = vWorld.xy;
  // slow, heavy undulation of the face + finer flowing texture
  float f1 = bwFbm(q * vec2(0.012, 0.004) + vec2(0.0, t * 0.03));
  float f2 = bwFbm(q * vec2(0.06, 0.02) + vec2(t * 0.02, t * 0.16));
  float f3 = bwFbm(q * vec2(0.3, 0.09) + vec2(0.0, t * 0.6));
  vec2 pert = vec2((f1 - 0.5) * 0.5 + (f2 - 0.5) * 0.25 + (f3 - 0.5) * 0.1, (f2 - 0.5) * 0.3 + (f1 - 0.5) * 0.2);
  if (uTouch.w > 0.0) {
    float d = distance(vWorld, uTouch.xyz);
    float front = uTouch.w * 9.0;
    float ring = sin(d * 1.6 - uTouch.w * 7.0) * exp(-d * 0.012) * smoothstep(front + 3.0, front - 25.0, d) * exp(-uTouch.w * 0.08);
    pert += normalize(vWorld.xy - uTouch.xy + 1e-3) * ring * 0.9;
  }
  n = normalize(n + vec3(pert.x, pert.y, 0.0));
  float ndv = clamp(dot(-V, n), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(V, n);
  vec3 refl = textureLod(uSkyCube, R, 1.5).rgb * uSkyExposure;

  // ---- inside the water
  float h01 = clamp((vWorld.y + 20.0) / 330.0, 0.0, 1.0);
  vec3 absorb = vec3(0.35, 0.065, 0.045);
  vec3 skyUp = textureLod(uSkyCube, vec3(0.0, 1.0, 0.0), 6.0).rgb * uSkyExposure;
  vec3 skyFar = textureLod(uSkyCube, normalize(vec3(V.x, 0.25, V.z)), 6.0).rgb * uSkyExposure;
  // light filtering down from the crest, and through from the open sea behind the wall
  vec3 down = skyUp * exp(-absorb * (1.0 - h01) * 330.0 * 0.08) * 0.8;
  vec3 through = skyFar * exp(-absorb * 9.0) * 1.6;
  float sunPh = pow(max(dot(V, uSunDir), 0.0), 5.0);
  vec3 sunIn = uSunColorW * exp(-absorb * (4.0 + (1.0 - h01) * 10.0)) * (0.02 + 0.35 * sunPh);
  // god rays slanting down through the body
  vec2 rq = vec2(vWorld.x * 0.012 + vWorld.y * 0.009 * (uSunDir.x > 0.0 ? 1.0 : -1.0), t * 0.025);
  float shafts = pow(bwVNoise(rq), 3.0) * 1.6 + pow(bwVNoise(rq * 2.7 + 5.0), 4.0);
  vec3 body = down + through + sunIn * (0.5 + shafts * 2.2);
  body *= mix(vec3(0.55, 1.0, 0.95), vec3(0.8, 1.0, 1.0), h01);
  body *= mix(0.3, 1.0, pow(h01, 0.6));
  // water sliding down the face in slow glassy ribbons
  float ribbon = pow(bwVNoise(vec2(vWorld.x * 0.35 + f1 * 3.0, vWorld.y * 0.015 + t * 0.35)), 5.0);
  body += (down * 0.3 + sunIn * 0.6) * ribbon;

  // parallax layers of drifting particles and fish, deeper = dimmer
  vec2 vp = V.xy / max(abs(V.z), 0.25);
  float specks = 0.0, fish = 0.0;
  for (int i = 0; i < 3; i++) {
    float depth = 6.0 + float(i) * 22.0;
    vec2 p = q + vp * depth;
    vec2 cell = floor(p * vec2(0.25, 0.25) + vec2(0.0, t * 0.02 * (1.0 + float(i))));
    specks += step(0.992, bwHash12(cell + float(i) * 17.0)) * (1.0 - float(i) * 0.3);
    // schools: dense bands of tiny dark shapes that drift sideways
    vec2 sp = p * vec2(0.9, 2.2) + vec2(t * (0.8 + float(i) * 0.3), 0.0);
    vec2 fc = fract(sp) - 0.5;
    float band = smoothstep(0.55, 0.8, bwVNoise(p * 0.01 + vec2(t * 0.01, float(i) * 3.0)));
    float isFish = step(0.9, bwHash12(floor(sp) + float(i) * 31.0));
    fish += isFish * smoothstep(0.32, 0.18, length(fc * vec2(1.0, 2.4))) * band * (1.0 - float(i) * 0.25);
  }
  body += vec3(0.5, 0.8, 0.8) * specks * (down + sunIn) * 0.35;
  body *= 1.0 - clamp(fish, 0.0, 1.0) * 0.55;
  // a whale, very large and very slow
  float wd = whale(q + vp * 45.0, vec2(-190.0 + mod(t * 1.3, 900.0) - 450.0, 150.0 + sin(t * 0.02) * 20.0), 5.5);
  body *= mix(0.35, 1.0, smoothstep(-0.3, 0.4, wd));

  vec3 col = mix(body, refl, F);
  // sun glints on the moving face
  vec3 Hs = normalize(uSunDir - V);
  col += uSunColorW * pow(max(dot(n, Hs), 0.0), 400.0) * 0.08;
  // crest high above catches the light; churn and spray at the foot
  float top = smoothstep(0.975, 1.0, vUv.y);
  float foot = smoothstep(0.06, 0.0, vUv.y) * (0.5 + 0.5 * bwFbm(vec2(vWorld.x * 0.08, t * 0.8)));
  col += (uSunColorW * 0.05 + skyUp * 0.6) * top;
  col = mix(col, (skyUp * 0.5 + uSunColorW * 0.04) * 0.9, clamp(foot * 0.8, 0.0, 1.0));
  // collapsing: churned white water and spray
  float churn = smoothstep(0.35, 0.75, bwFbm(vec2(vWorld.x * 0.02, vWorld.y * 0.03 - t * 0.6)));
  col = mix(col, (skyUp * 0.6 + uSunColorW * 0.05) * 0.9, clamp(uCollapse * 1.4, 0.0, 1.0) * (0.35 + 0.65 * churn));
  col = bwApplyFog(col, vWorld);
  float alpha = 0.985 * (1.0 - smoothstep(0.72, 1.0, uCollapse));
  gl_FragColor = vec4(col, alpha);
}`;

export function buildPlaces(scene: THREE.Scene, collision: CollisionWorld, lights: LightManager, terrain: Terrain): PlacesResult {
  const b = new MeshBatcher();
  const rng = new RNG(99);
  const H = (x: number, z: number) => terrain.heightAt(x, z);
  const group = new THREE.Group();
  group.name = 'places';

  // ======================================================================= utility yard
  const yc = V(160, 0, -18);
  yc.y = H(yc.x, yc.z);
  const yardYaw = 0.3;
  const toW = (lx: number, lz: number) => {
    const c = Math.cos(yardYaw),
      s = Math.sin(yardYaw);
    return V(yc.x + lx * c + lz * s, yc.y, yc.z - lx * s + lz * c);
  };
  // chain-link fence rectangle (gate on the west side)
  const fx = 17,
    fz = 13;
  const corners = [toW(-fx, -fz), toW(fx, -fz), toW(fx, fz), toW(-fx, fz), toW(-fx, -fz)];
  const gatePos = toW(-fx, 2);
  for (let i = 0; i < 4; i++) {
    const a = corners[i],
      c = corners[i + 1];
    const len = a.distanceTo(c);
    const n = Math.ceil(len / 3);
    for (let k = 0; k <= n; k++) {
      const p = a.clone().lerp(c, k / n);
      if (i === 3 && p.distanceTo(gatePos) < 2.2) continue;
      b.color.setRGB(0.55, 0.57, 0.56);
      b.cylinder('metal', V(p.x, H(p.x, p.z) - 0.2, p.z), V(p.x, H(p.x, p.z) + 2.4, p.z), 0.04, 0.04, 6);
    }
    b.beam('metal', a.clone().setY(H(a.x, a.z) + 2.35), c.clone().setY(H(c.x, c.z) + 2.35), 0.05, 0.05);
    // mesh panels
    const mid = a.clone().add(c).multiplyScalar(0.5);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 2.3), CHAINLINK());
    m.position.set(mid.x, H(mid.x, mid.z) + 1.15, mid.z);
    m.rotation.y = Math.atan2(c.z - a.z, c.x - a.x) * -1;
    m.castShadow = true;
    group.add(m);
    collision.box(mid.x, mid.z, len, 0.15, -Math.atan2(c.z - a.z, c.x - a.x), mid.y - 1, mid.y + 3, false, 'fence');
  }
  // gate gap: remove fence collision in the gap by adding nothing (fence boxes span the side; open the gap)
  // (we re-add the west side as two segments)
  // transformers
  const tr = [toW(-3, -4), toW(5, -4)];
  for (const t of tr) {
    b.color.setRGB(0.48, 0.52, 0.5);
    b.box('metal', t.x, t.y + 1.3, t.z, 2.4, 2.6, 1.8, 1);
    for (let k = -3; k <= 3; k++) b.box('metal', t.x + k * 0.3, t.y + 1.2, t.z + 1.05, 0.06, 2.0, 0.3, 1);
    for (let k = -1; k <= 1; k++) {
      b.color.setRGB(0.45, 0.35, 0.28);
      b.cylinder('insulator', V(t.x + k * 0.7, t.y + 2.6, t.z), V(t.x + k * 0.7, t.y + 3.6, t.z), 0.1, 0.06, 8);
    }
    collision.box(t.x, t.z, 2.6, 2.4, -yardYaw, t.y - 1, t.y + 3, false, 'transformer');
  }
  // bus structure
  for (const lx of [-8, 0, 8]) {
    const a = toW(lx, 6);
    b.color.setRGB(0.6, 0.62, 0.6);
    b.beam('metal', V(a.x, a.y, a.z), V(a.x, a.y + 7, a.z), 0.2, 0.2);
  }
  b.beam('metal', toW(-8, 6).setY(yc.y + 7), toW(8, 6).setY(yc.y + 7), 0.25, 0.25);
  for (const lx of [-6, -2, 2, 6]) {
    const a = toW(lx, 6);
    b.color.setRGB(0.5, 0.36, 0.28);
    b.cylinder('insulator', V(a.x, yc.y + 6.2, a.z), V(a.x, yc.y + 7, a.z), 0.09, 0.06, 8);
  }
  // relay mast (lattice)
  const mb = V(P.relayMast.x, H(P.relayMast.x, P.relayMast.z), P.relayMast.z);
  const MH = 36;
  const legs = [0, 1, 2].map((i) => (i / 3) * Math.PI * 2 + 0.3);
  const legAt = (i: number, h: number) => {
    const r = 1.9 * (1 - h / MH) + 0.35;
    return V(mb.x + Math.cos(legs[i]) * r, mb.y + h, mb.z + Math.sin(legs[i]) * r);
  };
  b.color.setRGB(0.62, 0.3, 0.22);
  for (let i = 0; i < 3; i++) b.beam('metal', legAt(i, -0.5), legAt(i, MH), 0.09, 0.09);
  for (let h = 0; h < MH; h += 2.4) {
    b.color.setRGB(h % 4.8 < 2.4 ? 0.62 : 0.85, h % 4.8 < 2.4 ? 0.3 : 0.84, h % 4.8 < 2.4 ? 0.22 : 0.8);
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      b.beam('metal', legAt(i, h), legAt(j, h), 0.04, 0.04);
      b.beam('metal', legAt(i, h), legAt(j, h + 2.4), 0.03, 0.03);
    }
  }
  // antennas
  b.color.setRGB(0.82, 0.82, 0.8);
  b.beam('metal', V(mb.x, mb.y + MH, mb.z), V(mb.x, mb.y + MH + 5, mb.z), 0.06, 0.06);
  for (const [h, a] of [
    [MH - 4, 0.4],
    [MH - 9, 2.4],
  ] as [number, number][]) {
    const c = V(mb.x + Math.cos(a) * 1.1, mb.y + h, mb.z + Math.sin(a) * 1.1);
    b.pushTRS(c.x, c.y, c.z, -a);
    b.cylinder('metal', V(0, 0, -0.1), V(0, 0, 0.3), 0.7, 0.8, 16);
    b.pop();
  }
  collision.circle(mb.x, mb.z, 2.2, mb.y - 1, mb.y + 40, 'mast');
  const mastTop = V(mb.x, mb.y + MH + 4.8, mb.z);
  for (const [h, id] of [
    [MH + 4.9, 'beacon-top'],
    [MH * 0.5, 'beacon-mid'],
  ] as [number, string][])
    lights.add({ id, group: 'relay', pos: V(mb.x, mb.y + h, mb.z), kind: 'red', power: 0.25, range: 30, glowSize: 0.5, castLight: false });
  const hutPos = V(162, H(162, -12), -12);
  const panel = hutPos.clone().add(V(0.8, 1.4, 3.5));

  // ======================================================================= lighthouse
  const lb = V(P.lighthouse.x, 41.0, P.lighthouse.z);
  const TH = 17;
  {
    // tapered white tower (lathe)
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      prof.push(new THREE.Vector2(3.3 - t * 0.9 + (i === 0 ? 0.35 : 0), t * TH));
    }
    const tower = new THREE.LatheGeometry(prof, 36);
    b.color.setRGB(0.92, 0.9, 0.86);
    b.geometry('stucco', tower, new THREE.Matrix4().makeTranslation(lb.x, lb.y - 0.4, lb.z));
    // black band + gallery
    b.color.setRGB(0.12, 0.13, 0.13);
    b.cylinder('metal', V(lb.x, lb.y + TH - 0.2, lb.z), V(lb.x, lb.y + TH + 0.35, lb.z), 3.4, 3.4, 36);
    // gallery railing
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const p = V(lb.x + Math.cos(a) * 3.2, lb.y + TH + 0.35, lb.z + Math.sin(a) * 3.2);
      b.cylinder('metal', p, p.clone().add(V(0, 1.05, 0)), 0.025, 0.025, 4, false);
    }
    for (const hh of [0.75, 1.4]) {
      for (let i = 0; i < 40; i++) {
        const a0 = (i / 40) * Math.PI * 2,
          a1 = ((i + 1) / 40) * Math.PI * 2;
        b.beam('metal', V(lb.x + Math.cos(a0) * 3.2, lb.y + TH + hh, lb.z + Math.sin(a0) * 3.2), V(lb.x + Math.cos(a1) * 3.2, lb.y + TH + hh, lb.z + Math.sin(a1) * 3.2), 0.04, 0.04);
      }
    }
    // lantern room frame (glass added separately)
    const LR = 1.7,
      LH = 2.8;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      b.color.setRGB(0.12, 0.13, 0.13);
      b.beam('metal', V(lb.x + Math.cos(a) * LR, lb.y + TH + 0.35, lb.z + Math.sin(a) * LR), V(lb.x + Math.cos(a) * LR, lb.y + TH + 0.35 + LH, lb.z + Math.sin(a) * LR), 0.07, 0.07);
    }
    b.cylinder('metal', V(lb.x, lb.y + TH + 0.35, lb.z), V(lb.x, lb.y + TH + 1.0, lb.z), LR + 0.05, LR + 0.05, 20);
    // dome roof
    const dome = new THREE.SphereGeometry(LR + 0.2, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    b.color.setRGB(0.55, 0.14, 0.1);
    b.geometry('roofMetal', dome, new THREE.Matrix4().makeTranslation(lb.x, lb.y + TH + 0.35 + LH, lb.z));
    b.cylinder('metal', V(lb.x, lb.y + TH + LH + 1.8, lb.z), V(lb.x, lb.y + TH + LH + 3.2, lb.z), 0.04, 0.02, 4);
    // door at the base facing the keeper's house (north)
    b.color.setRGB(0.2, 0.28, 0.24);
    b.box('door', lb.x, lb.y + 1.1, lb.z - 3.28, 1.1, 2.2, 0.1, 1);
    collision.circle(lb.x, lb.z, 3.5, lb.y - 2, lb.y + TH + 0.3, 'lighthouse');
    // gallery floor + lamp room floor walkable
    collision.box(lb.x, lb.z, 6.6, 6.6, 0, lb.y + TH - 3, lb.y + TH + 0.35, true, 'metal');
    // gallery rail as a ring of boxes
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      collision.box(lb.x + Math.cos(a) * 3.3, lb.z + Math.sin(a) * 3.3, 1.4, 0.2, -a + Math.PI / 2, lb.y + TH + 0.3, lb.y + TH + 1.6, false, 'rail');
    }
    // the lens pedestal inside the lamp room
    collision.circle(lb.x, lb.z, 0.75, lb.y + TH + 0.3, lb.y + TH + 3.2, 'lens');
  }
  const lampRoom = V(lb.x, lb.y + TH + 0.35, lb.z);
  // glass lantern
  const lanternGlass = new THREE.Mesh(
    new THREE.CylinderGeometry(1.68, 1.68, 1.9, 10, 1, true),
    new THREE.MeshPhysicalMaterial({ color: 0xcfe0e0, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  lanternGlass.position.set(lb.x, lb.y + TH + 1.0 + 0.95, lb.z);
  lanternGlass.layers.set(LAYER.TRANSPARENT);
  group.add(lanternGlass);
  // Fresnel lens: stacked prism rings around a lamp
  const lens = new THREE.Group();
  lens.position.set(lb.x, lb.y + TH + 1.1, lb.z);
  const prism = new THREE.MeshStandardMaterial({ color: 0xe6f2ef, roughness: 0.05, metalness: 0.6, emissive: 0x000000 });
  for (let i = 0; i < 9; i++) {
    const y = i * 0.17;
    const r = 0.55 + Math.sin((i / 8) * Math.PI) * 0.18;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.05, 6, 24), prism);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    lens.add(ring);
  }
  const bullseye = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff0c8, emissiveIntensity: 0, roughness: 0.1 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.CircleGeometry(0.34, 20), bullseye);
    e.position.set(s * 0.62, 0.7, 0);
    e.rotation.y = s * Math.PI / 2;
    lens.add(e);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), bullseye);
  lamp.position.y = 0.7;
  lens.add(lamp);
  lens.userData.bullseye = bullseye;
  group.add(lens);
  lights.add({ id: 'lighthouse-lamp', group: 'lighthouse', pos: V(lb.x, lb.y + TH + 1.8, lb.z), kind: 'incandescent', power: 3.0, range: 40, glowSize: 1.2 });
  // beams (two opposing cones)
  const beamGeo = new THREE.CylinderGeometry(0.4, 22, 500, 18, 12, true);
  beamGeo.rotateZ(-Math.PI / 2);
  beamGeo.translate(250, 0, 0);
  const beamMat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: { ...fogUniforms(), uIntensity: { value: 0 }, uLen: { value: 500 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const beams = new THREE.Mesh(beamGeo, beamMat);
  const beam2 = new THREE.Mesh(beamGeo, beamMat);
  beam2.rotation.y = Math.PI;
  beams.add(beam2);
  beams.position.set(lb.x, lb.y + TH + 1.8, lb.z);
  beams.layers.set(LAYER.TRANSPARENT);
  beam2.layers.set(LAYER.TRANSPARENT);
  beams.frustumCulled = false;
  beam2.frustumCulled = false;
  group.add(beams);

  // Lighthouse Road gate (pipe gate across the gravel road, near the overlook)
  const gatePos2 = V(P.lighthouseGate.x, 0, P.lighthouseGate.z);
  gatePos2.y = H(gatePos2.x, gatePos2.z);
  const gateYaw = 2.3;
  const gateBar = new THREE.Group();
  {
    const pipe = new THREE.MeshStandardMaterial({ color: 0xc9a23a, roughness: 0.6, metalness: 0.5 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 5.2, 8), pipe);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(2.6, 0.95, 0);
    const bar2 = bar.clone();
    bar2.position.y = 0.45;
    gateBar.add(bar, bar2);
    for (let i = 0; i < 4; i++) {
      const v = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 6), pipe);
      v.position.set(0.6 + i * 1.3, 0.7, 0);
      gateBar.add(v);
    }
    gateBar.position.copy(gatePos2);
    gateBar.rotation.y = gateYaw;
    gateBar.traverse((o) => (o.castShadow = true));
    group.add(gateBar);
    b.color.setRGB(0.3, 0.3, 0.3);
    b.cylinder('metal', gatePos2.clone().add(V(0, -0.3, 0)), gatePos2.clone().add(V(0, 1.2, 0)), 0.09, 0.09, 8);
    const far = gatePos2.clone().add(V(Math.cos(gateYaw) * 5.3, 0, -Math.sin(gateYaw) * 5.3));
    far.y = H(far.x, far.z);
    b.cylinder('metal', far.clone().add(V(0, -0.3, 0)), far.clone().add(V(0, 1.1, 0)), 0.08, 0.08, 8);
  }

  // cliff-path handrail posts
  {
    const path = sampleCatmull(
      [
        { x: -478, y: 41.2, z: 452 },
        { x: -462, y: 37.5, z: 446 },
        { x: -446, y: 30, z: 438 },
        { x: -430, y: 20, z: 430 },
        { x: -414, y: 10, z: 422 },
        { x: -400, y: 3.2, z: 415 },
      ],
      3,
    );
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i],
        c = path[i + 1];
      const d = V(c.x - a.x, 0, c.z - a.z).normalize();
      const n = V(-d.z, 0, d.x).multiplyScalar(1.3);
      const pa = V(a.x + n.x, H(a.x + n.x, a.z + n.z), a.z + n.z);
      const pc = V(c.x + n.x, H(c.x + n.x, c.z + n.z), c.z + n.z);
      b.color.setRGB(0.4, 0.34, 0.27);
      b.cylinder('pole', pa, pa.clone().add(V(0, 1.0, 0)), 0.05, 0.05, 5);
      b.beam('pole', pa.clone().add(V(0, 0.95, 0)), pc.clone().add(V(0, 0.95, 0)), 0.06, 0.06);
    }
  }

  // ======================================================================= the trail across the flats
  const trailPts = sampleCatmull(TRAIL, 3).map((p) => V(p.x, H(p.x, p.z), p.z));
  // footprints: many walkers in a loose band
  const fpTex = footprintTexture();
  const fpGeo = new THREE.PlaneGeometry(0.13, 0.3);
  fpGeo.rotateX(-Math.PI / 2);
  const fpMat = new THREE.MeshStandardMaterial({ map: fpTex, transparent: false, alphaTest: 0.4, roughness: 0.08, metalness: 0, color: 0x6a6258, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const count = 2600;
  const fp = new THREE.InstancedMesh(fpGeo, fpMat, count);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let placed = 0;
  let acc = 0;
  const walkers = 40;
  for (let w = 0; w < walkers && placed < count; w++) {
    const lane = (rng.next() - 0.5) * 7;
    const wobble = rng.range(0, 10);
    const stride = rng.range(0.62, 0.8);
    const startS = rng.range(0, 30);
    for (let i = 1; i < trailPts.length && placed < count; i++) {
      const a = trailPts[i - 1],
        c = trailPts[i];
      const seg = a.distanceTo(c);
      const d = V(c.x - a.x, 0, c.z - a.z).normalize();
      const n = V(-d.z, 0, d.x);
      for (let s = 0; s < seg && placed < count; s += stride) {
        acc += stride;
        if (acc < startS) continue;
        const fade = smoothstep(1100, 1000, a.z + d.z * s) ;
        if (rng.next() > 0.55 * (0.3 + 0.7 * fade)) continue; // sparse: not every step survives
        const left = Math.floor(acc / stride) % 2 === 0;
        const off = lane + Math.sin(acc * 0.05 + wobble) * 1.2 + (left ? -0.13 : 0.13);
        const x = a.x + d.x * s + n.x * off,
          z = a.z + d.z * s + n.z * off;
        const y = H(x, z) + 0.015;
        if (terrain.waterAt(x, z) > y + 0.05) continue;
        q.setFromAxisAngle(V(0, 1, 0), Math.atan2(d.x, d.z) + rng.range(-0.15, 0.15));
        m4.compose(V(x, y, z), q, V(left ? -1 : 1, 1, 1));
        fp.setMatrixAt(placed++, m4);
      }
    }
  }
  fp.count = placed;
  fp.receiveShadow = true;
  fp.layers.set(LAYER.OPAQUE);
  group.add(fp);
  // footprints on the town side too: from the roadblock down Main Street (fading)
  // lanterns and flashlights left along the way
  const lanterns: THREE.Vector3[] = [];
  for (let s = 60; s < 800; s += 42 + rng.range(-10, 20)) {
    const i = Math.min(trailPts.length - 1, Math.floor(s / 3));
    const p = trailPts[i].clone().add(V(rng.range(-3, 3), 0, rng.range(-2, 2)));
    p.y = H(p.x, p.z);
    lanterns.push(p);
    // lantern body
    b.color.setRGB(0.18, 0.2, 0.18);
    b.cylinder('metal', p.clone(), p.clone().add(V(0, 0.08, 0)), 0.1, 0.1, 8);
    b.color.setRGB(0.9, 0.85, 0.7);
    b.cylinder('lampLens', p.clone().add(V(0, 0.08, 0)), p.clone().add(V(0, 0.26, 0)), 0.08, 0.08, 8, false);
    b.color.setRGB(0.18, 0.2, 0.18);
    b.cylinder('metal', p.clone().add(V(0, 0.26, 0)), p.clone().add(V(0, 0.34, 0)), 0.1, 0.03, 8);
    lights.add({ id: `lantern-${lanterns.length}`, group: 'lanterns', pos: p.clone().add(V(0, 0.2, 0)), kind: 'fire', power: 0.018, range: 8, glowSize: 0.12 });
  }
  // channel range lights on old pilings leading into the fog
  const rangeLights: THREE.Vector3[] = [];
  for (let s = 180; s < trailPts.length * 3 - 40; s += 90) {
    const i = Math.min(trailPts.length - 1, Math.floor(s / 3));
    const p = trailPts[i].clone().add(V(9, 0, 0));
    p.y = H(p.x, p.z);
    b.color.setRGB(0.25, 0.22, 0.2);
    b.cylinder('piling', p.clone().add(V(0, -1, 0)), p.clone().add(V(0, 5.5, 0)), 0.2, 0.18, 7);
    b.color.setRGB(0.15, 0.4, 0.2);
    b.box('metal', p.x, p.y + 5.1, p.z - 0.2, 0.9, 1.2, 0.05, 1);
    const lp = p.clone().add(V(0, 5.8, 0));
    rangeLights.push(lp);
    lights.add({ id: `range-${rangeLights.length}`, group: 'range', pos: lp, kind: 'mercury', power: 0.5, range: 14, glowSize: 0.45, castLight: false });
    collision.circle(p.x, p.z, 0.3, p.y - 2, p.y + 6, 'piling');
  }
  // things people dropped
  const items: { id: string; pos: THREE.Vector3; label: string }[] = [];
  const dropped: [string, number, string][] = [
    ['shoe', 90, 'A child’s shoe'],
    ['hat', 260, 'Sheriff’s hat'],
    ['scarf', 560, 'A knitted scarf'],
    ['radio', 700, 'A transistor radio'],
  ];
  for (const [id, s, label] of dropped) {
    const i = Math.min(trailPts.length - 1, Math.floor(s / 3));
    const p = trailPts[i].clone().add(V(rng.range(-2, 2), 0, 0));
    p.y = H(p.x, p.z) + 0.05;
    items.push({ id, pos: p, label });
    b.color.setRGB(id === 'shoe' ? 0.6 : id === 'hat' ? 0.3 : id === 'scarf' ? 0.55 : 0.2, id === 'shoe' ? 0.15 : id === 'hat' ? 0.25 : id === 'scarf' ? 0.2 : 0.2, id === 'shoe' ? 0.15 : 0.18);
    if (id === 'hat') {
      b.cylinder('trim', p, p.clone().add(V(0, 0.04, 0)), 0.22, 0.22, 16);
      b.cylinder('trim', p.clone().add(V(0, 0.04, 0)), p.clone().add(V(0, 0.16, 0)), 0.12, 0.1, 12);
    } else if (id === 'scarf') {
      b.boxR('trim', p.x, p.y, p.z, 1.2, 0.03, 0.2, 0.7);
    } else if (id === 'radio') {
      b.boxR('metal', p.x, p.y + 0.06, p.z, 0.25, 0.14, 0.08, 0.3);
    } else b.boxR('trim', p.x, p.y + 0.04, p.z, 0.18, 0.08, 0.08, 1.2);
  }

  // shipwreck ribs
  {
    const wc = V(P.wreck.x, H(P.wreck.x, P.wreck.z), P.wreck.z);
    const yaw = 0.7;
    const d = V(Math.cos(yaw), 0, -Math.sin(yaw));
    const n = V(-d.z, 0, d.x);
    for (let i = -7; i <= 7; i++) {
      const base = wc.clone().addScaledVector(d, i * 1.6);
      const hgt = 3.2 * (1 - Math.abs(i) / 9) + rng.range(-0.8, 0.4);
      for (const s of [-1, 1]) {
        if (rng.chance(0.18)) continue;
        let prev = base.clone().add(V(0, -0.8, 0));
        for (let k = 1; k <= 5; k++) {
          const t = k / 5;
          const p = base.clone().addScaledVector(n, s * Math.sin(t * 1.4) * 3.0).add(V(0, t * hgt - 0.8, 0));
          b.color.setRGB(0.18, 0.15, 0.12);
          b.beam('piling', prev, p, 0.22, 0.26);
          prev = p;
        }
      }
    }
    b.color.setRGB(0.16, 0.14, 0.11);
    b.beam('piling', wc.clone().addScaledVector(d, -12).add(V(0, -0.3, 0)), wc.clone().addScaledVector(d, 12).add(V(0, 0.2, 0)), 0.5, 0.6);
    // stem post rising at the bow
    b.beam('piling', wc.clone().addScaledVector(d, 12), wc.clone().addScaledVector(d, 13.5).add(V(0, 4.5, 0)), 0.4, 0.4);
    collision.box(wc.x, wc.z, 26, 6, -yaw, wc.y - 2, wc.y + 4, false, 'wreck');
  }
  // whale bones
  {
    const wc = V(P.whale.x, H(P.whale.x, P.whale.z), P.whale.z);
    const yaw = -0.4;
    const d = V(Math.cos(yaw), 0, -Math.sin(yaw));
    const n = V(-d.z, 0, d.x);
    b.color.setRGB(0.78, 0.76, 0.68);
    // skull
    b.pushTRS(wc.x - d.x * 7, wc.y + 0.2, wc.z - d.z * 7, yaw);
    b.box('concrete', 0, 0, 0, 3.6, 0.7, 1.6, 0.5);
    b.box('concrete', 1.8, 0, 0, 1.4, 0.4, 0.8, 0.5);
    b.pop();
    for (let i = 0; i < 12; i++) {
      const c = wc.clone().addScaledVector(d, -4 + i * 0.9);
      b.cylinder('concrete', c.clone().add(V(0, 0, 0)), c.clone().add(V(0, 0.35, 0)), 0.22, 0.2, 8);
      if (i < 9)
        for (const s of [-1, 1]) {
          let prev = c.clone().add(V(0, 0.3, 0));
          for (let k = 1; k <= 4; k++) {
            const t = k / 4;
            const p = c.clone().addScaledVector(n, s * Math.sin(t * 1.6) * 2.2).add(V(0, 0.3 + Math.sin(t * Math.PI) * 1.6 - t * 0.4, 0));
            b.beam('concrete', prev, p, 0.12, 0.14);
            prev = p;
          }
        }
    }
    collision.box(wc.x, wc.z, 16, 4.5, -yaw, wc.y - 1, wc.y + 1.8, false, 'bones');
  }
  // rocks with weed on the flats
  for (let i = 0; i < 70; i++) {
    const x = rng.range(-420, 380),
      z = rng.range(240, 1050);
    const y = H(x, z);
    if (y > 0.5) continue;
    if (terrain.waterAt(x, z) > y + 0.3) continue;
    const r = rng.range(0.4, 1.8);
    const g = new THREE.IcosahedronGeometry(r, 1);
    const p = g.getAttribute('position');
    for (let k = 0; k < p.count; k++) {
      const vx = p.getX(k),
        vy = p.getY(k),
        vz = p.getZ(k);
      const s = 1 + (Math.sin(vx * 3.1 + i) * Math.sin(vz * 2.7 + i * 1.3)) * 0.25;
      p.setXYZ(k, vx * s * 1.3, vy * s * 0.55, vz * s);
    }
    g.computeVertexNormals();
    b.color.setRGB(0.32, 0.33, 0.28);
    b.geometry('rock', g, new THREE.Matrix4().compose(V(x, y + r * 0.1, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rng.range(0, 6), rng.range(-0.2, 0.2))), V(1, 1, 1)));
    if (r > 0.8) collision.circle(x, z, r * 1.1, y - 1, y + r * 0.6, 'rock');
  }

  // ======================================================================= escape tower (rear range light)
  const tb = V(P.escapeTower.x, H(P.escapeTower.x, P.escapeTower.z), P.escapeTower.z);
  const TT = 13;
  {
    const legs2 = [
      [-1.2, -1.2],
      [1.2, -1.2],
      [1.2, 1.2],
      [-1.2, 1.2],
    ];
    b.color.setRGB(0.3, 0.32, 0.3);
    b.box('concrete', tb.x, tb.y + 0.3, tb.z, 3.6, 1.2, 3.6, 0.5);
    for (const [lx, lz] of legs2) b.beam('metal', V(tb.x + lx * 1.2, tb.y, tb.z + lz * 1.2), V(tb.x + lx * 0.7, tb.y + TT, tb.z + lz * 0.7), 0.14, 0.14);
    for (let h = 1; h < TT; h += 2.2) {
      const k0 = 1.2 - (h / TT) * 0.5,
        k1 = 1.2 - ((h + 2.2) / TT) * 0.5;
      for (let i = 0; i < 4; i++) {
        const [ax, az] = legs2[i],
          [cx, cz] = legs2[(i + 1) % 4];
        b.beam('metal', V(tb.x + ax * k0, tb.y + h, tb.z + az * k0), V(tb.x + cx * k1, tb.y + Math.min(TT, h + 2.2), tb.z + cz * k1), 0.05, 0.05);
      }
    }
    // platform
    b.color.setRGB(0.35, 0.36, 0.34);
    b.box('metal', tb.x, tb.y + TT, tb.z, 2.6, 0.12, 2.6, 1);
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legs2[i],
        [cx, cz] = legs2[(i + 1) % 4];
      b.beam('metal', V(tb.x + ax * 1.05, tb.y + TT + 1.0, tb.z + az * 1.05), V(tb.x + cx * 1.05, tb.y + TT + 1.0, tb.z + cz * 1.05), 0.05, 0.05);
    }
    // daymark + light
    b.color.setRGB(0.15, 0.45, 0.22);
    b.box('metal', tb.x, tb.y + TT + 2.2, tb.z, 1.6, 2.0, 0.06, 1);
    lights.add({ id: 'escape-light', group: 'range', pos: V(tb.x, tb.y + TT + 3.5, tb.z), kind: 'mercury', power: 0.6, range: 20, glowSize: 0.6, castLight: false });
    // ladder on the north face
    const lz = tb.z - 1.25;
    for (const lx of [-0.25, 0.25]) b.beam('metal', V(tb.x + lx, tb.y, lz), V(tb.x + lx, tb.y + TT + 1, lz + 0.4), 0.04, 0.04);
    for (let h = 0.3; h < TT; h += 0.3) b.beam('metal', V(tb.x - 0.25, tb.y + h, lz + (h / TT) * 0.4), V(tb.x + 0.25, tb.y + h, lz + (h / TT) * 0.4), 0.025, 0.025);
    collision.box(tb.x, tb.z, 3.6, 3.6, 0, tb.y - 1, tb.y + 0.9, true, 'concrete');
    collision.box(tb.x, tb.z, 2.6, 2.6, 0, tb.y + TT - 1, tb.y + TT + 0.06, true, 'metal');
  }

  // ======================================================================= silent figures on the flats
  const figures = new THREE.Group();
  {
    const mat = new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.95 });
    const spots = [
      [-150, 560],
      [-190, 700],
      [-176, 760],
      [-210, 820],
      [-160, 880],
      [-230, 640],
    ];
    for (const [x, z] of spots) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.9, 4, 8), mat);
      body.position.y = 1.05;
      body.scale.set(1, 1, 0.7);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), mat);
      head.position.y = 1.72;
      const legsM = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.6, 4, 6), mat);
      legsM.position.set(0.1, 0.4, 0);
      const legs2 = legsM.clone();
      legs2.position.x = -0.1;
      g.add(body, head, legsM, legs2);
      g.position.set(x, H(x, z), z);
      g.rotation.y = Math.PI + rng.range(-0.3, 0.3); // facing out to sea (south)
      figures.add(g);
    }
    figures.visible = false;
  }
  group.add(figures);

  // ======================================================================= the wall
  const wallGeo = new THREE.PlaneGeometry(5200, 330, 260, 30);
  wallGeo.translate(0, 330 / 2 - 22, 0);
  // gentle curvature toward the shore at the ends
  const wp = wallGeo.getAttribute('position');
  for (let i = 0; i < wp.count; i++) {
    const x = wp.getX(i);
    wp.setZ(i, (x * x) * -0.00006);
  }
  wallGeo.computeVertexNormals();
  const wallMat = new THREE.ShaderMaterial({
    vertexShader: WALL_VERT,
    fragmentShader: WALL_FRAG,
    uniforms: {
      ...fogUniforms(),
      uTime: U.uTime,
      uTouch: { value: new THREE.Vector4(0, 0, 0, -1) },
      uSunColor2: { value: new THREE.Color(1, 1, 1) },
      uSunColorW: U.uSunColor,
      uCollapse: { value: 0 },
    },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true,
    fog: false,
  });
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.position.set(-190, 0, P.wallZ);
  wall.rotation.y = Math.PI; // face the shore
  wall.layers.set(LAYER.TRANSPARENT);
  wall.visible = false;
  wall.frustumCulled = false;
  group.add(wall);

  // ======================================================================= materials & meshes
  const mats: Record<string, THREE.Material> = {
    lampLens: new THREE.MeshStandardMaterial({ color: 0xfff2d8, roughness: 0.2, emissive: 0xffc880, emissiveIntensity: 0, vertexColors: true }),
    rock: SHARED_MATS.concrete,
  };
  for (const key of b.batches.keys()) {
    const g = b.buildGeometry(key);
    if (!g) continue;
    const mat = mats[key] ?? SHARED_MATS[key] ?? SHARED_MATS.metal;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'places-' + key;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.OPAQUE);
    group.add(mesh);
  }
  scene.add(group);
  return {
    group,
    yard: { hut: hutPos, panel, mastTop, transformer: tr[0].clone().add(V(0, 1.5, 0)), gate: gatePos },
    lighthouse: {
      base: lb,
      lampRoom,
      lens,
      beams,
      door: V(lb.x, lb.y + 1.1, lb.z - 3.5),
      gallery: V(lb.x, lb.y + TH + 0.36, lb.z - 2.6),
      lensMotor: V(lb.x + 0.9, lb.y + TH + 1.2, lb.z - 0.6),
      cliffTop: V(-470, 41.2, 451),
    },
    trail: { points: trailPts, lanterns, rangeLights, items },
    figures,
    tower: { base: tb, top: V(tb.x, tb.y + TT + 0.07, tb.z), ladder: V(tb.x, tb.y, tb.z - 1.6) },
    wall,
    lhGate: { pos: gatePos2, yaw: gateYaw, bar: gateBar },
    footprints: fp,
  };
}

let chainlinkMat: THREE.Material | null = null;
function CHAINLINK() {
  if (chainlinkMat) return chainlinkMat;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(160,165,160,1)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 32);
  g.lineTo(32, 0);
  g.lineTo(64, 32);
  g.lineTo(32, 64);
  g.closePath();
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(40, 12);
  t.anisotropy = 4;
  chainlinkMat = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.7, color: 0xb0b4b0 });
  return chainlinkMat;
}

function footprintTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 128);
  g.fillStyle = 'rgba(255,255,255,1)';
  // sole + heel of a boot print
  g.beginPath();
  g.ellipse(34, 40, 22, 34, 0.08, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(30, 102, 17, 20, 0, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  return t;
}
