// GPU procedural material baking. Each material is a GLSL function producing
// albedo (linear), roughness, height and AO for a tileable uv in [0,1).
// Results: albedo+roughness (sRGB RGBA8) and normal+height+ao (RGBA8) textures,
// either as standalone textures or as layers of a texture array.
import * as THREE from 'three';
import { FullScreenQuad } from './FullScreen';

export const TEX_NOISE = /* glsl */ `
float th21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 th22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
// periodic value noise; p in lattice units, P = period (per axis)
float pn(vec2 p, vec2 P) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = th21(mod(i, P));
  float b = th21(mod(i + vec2(1.0, 0.0), P));
  float c = th21(mod(i + vec2(0.0, 1.0), P));
  float d = th21(mod(i + vec2(1.0, 1.0), P));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 uv, vec2 P, int oct, float gain) {
  float s = 0.0, a = 0.5, n = 0.0;
  vec2 f = P;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * pn(uv * f + float(i) * 13.7, f);
    n += a; a *= gain; f *= 2.0;
  }
  return s / n;
}
float pfbm1(vec2 uv, float P, int oct) { return pfbm(uv, vec2(P), oct, 0.5); }
// periodic voronoi: x=F1, y=F2, z=cell id
vec3 pvor(vec2 uv, vec2 P, float jitter) {
  vec2 p = uv * P;
  vec2 i = floor(p); vec2 f = fract(p);
  float F1 = 8.0, F2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 c = mod(i + g, P);
    vec2 o = 0.5 + (th22(c) - 0.5) * jitter;
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < F1) { F2 = F1; F1 = d; id = th21(c + 7.31); }
    else if (d < F2) { F2 = d; }
  }
  return vec3(sqrt(F1), sqrt(F2), id);
}
// cell-local coordinates of nearest voronoi site (for stones/pebbles)
vec4 pvorCell(vec2 uv, vec2 P, float jitter) {
  vec2 p = uv * P;
  vec2 i = floor(p); vec2 f = fract(p);
  float F1 = 8.0; vec2 best = vec2(0.0); float id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 c = mod(i + g, P);
    vec2 o = 0.5 + (th22(c) - 0.5) * jitter;
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < F1) { F1 = d; best = r; id = th21(c + 3.17); }
  }
  return vec4(best, sqrt(F1), id);
}
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
// Random line segments ("needles", "twigs", "cracks") in a periodic grid
float pNeedles(vec2 uv, float P, float len, float width, float seed) {
  vec2 p = uv * P;
  vec2 i = floor(p);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = i + vec2(float(x), float(y));
    vec2 c = mod(g, vec2(P));
    for (int k = 0; k < 3; k++) {
      vec2 h = th22(c * 1.37 + float(k) * 17.1 + seed);
      vec2 o = g + h;
      float a = th21(c + float(k) * 3.3 + seed) * 6.2832;
      vec2 dir = vec2(cos(a), sin(a));
      vec2 rel = p - o;
      float t = clamp(dot(rel, dir), -len, len);
      float d = length(rel - dir * t);
      acc = max(acc, smoothstep(width, 0.0, d) * (0.6 + 0.4 * th21(c + float(k))));
    }
  }
  return acc;
}
`;

/** Library of material functions. Signature: void m_NAME(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) */
export const MATERIAL_LIB: Record<string, string> = {
  grass: /* glsl */ `
void m_grass(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm1(uv, 4.0, 5);
  float n2 = pfbm1(uv + 0.37, 16.0, 4);
  float streak = pfbm(uv, vec2(64.0, 12.0), 3, 0.55);
  float fine = pfbm(uv, vec2(160.0, 40.0), 2, 0.5);
  vec3 green = srgb(vec3(0.27, 0.36, 0.13));
  vec3 dry = srgb(vec3(0.50, 0.46, 0.25));
  vec3 dark = srgb(vec3(0.13, 0.19, 0.07));
  alb = mix(green, dry, smoothstep(0.5, 0.85, n1) * 0.7);
  alb = mix(alb, dark, smoothstep(0.5, 0.85, n2) * 0.6);
  float b = streak * 0.6 + fine * 0.4;
  alb *= 0.65 + 0.6 * b;
  // bits of soil
  float soil = smoothstep(0.62, 0.75, pfbm1(uv + 2.1, 24.0, 3)) * (1.0 - b);
  alb = mix(alb, srgb(vec3(0.24, 0.19, 0.13)), soil * 0.7);
  h = b * 0.7 + n2 * 0.3 - soil * 0.3;
  ao = 0.55 + 0.45 * b;
  rough = 0.93;
}`,
  forest: /* glsl */ `
void m_forest(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm1(uv, 4.0, 5);
  float n2 = pfbm1(uv + 5.3, 12.0, 4);
  vec3 soil = srgb(vec3(0.20, 0.14, 0.09));
  vec3 needle = srgb(vec3(0.45, 0.30, 0.17));
  vec3 needleDark = srgb(vec3(0.26, 0.17, 0.10));
  vec3 moss = srgb(vec3(0.24, 0.32, 0.10));
  float nd1 = pNeedles(uv, 36.0, 0.42, 0.045, 1.0);
  float nd2 = pNeedles(uv + 0.5, 28.0, 0.48, 0.05, 7.0);
  float needles = max(nd1, nd2 * 0.8);
  float twig = pNeedles(uv + 0.21, 6.0, 0.45, 0.02, 3.0);
  float mossM = smoothstep(0.52, 0.7, n1 + n2 * 0.25);
  alb = mix(soil, mix(needleDark, needle, n2), sat(needles * 1.2));
  alb = mix(alb, srgb(vec3(0.32, 0.23, 0.14)), twig * 0.8);
  alb = mix(alb, moss * (0.7 + 0.5 * n2), mossM);
  h = needles * 0.5 + twig * 0.6 + mossM * 0.5 + n2 * 0.3;
  ao = 0.5 + 0.5 * sat(needles + mossM);
  rough = mix(0.9, 0.8, mossM);
}`,
  rock: /* glsl */ `
void m_rock(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  vec3 v = pvor(uv, vec2(5.0), 0.9);
  vec3 v2 = pvor(uv + 0.3, vec2(13.0), 0.9);
  float n1 = pfbm1(uv, 6.0, 6);
  float n2 = pfbm1(uv + 1.7, 24.0, 4);
  float crack = smoothstep(0.06, 0.0, v.y - v.x) * 0.8 + smoothstep(0.05, 0.0, v2.y - v2.x) * 0.4;
  float strata = sin((uv.y + n1 * 0.12) * 6.2832 * 7.0) * 0.5 + 0.5;
  vec3 base = mix(srgb(vec3(0.30, 0.30, 0.29)), srgb(vec3(0.45, 0.44, 0.41)), n1);
  base *= 0.85 + 0.3 * v.z;
  base = mix(base, base * 0.8, strata * 0.25);
  // lichen
  float li = smoothstep(0.62, 0.72, pfbm1(uv + 3.3, 10.0, 5));
  float li2 = smoothstep(0.66, 0.74, pfbm1(uv + 8.1, 18.0, 4));
  alb = base;
  alb = mix(alb, srgb(vec3(0.62, 0.64, 0.52)), li * 0.75);
  alb = mix(alb, srgb(vec3(0.70, 0.45, 0.18)), li2 * 0.5);
  alb *= 1.0 - crack * 0.55;
  h = n1 * 0.7 + n2 * 0.2 + (1.0 - v.x) * 0.3 - crack * 0.6;
  ao = 1.0 - crack * 0.7;
  rough = 0.78 - li * 0.05;
}`,
  mud: /* glsl */ `
void m_mud(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm1(uv, 3.0, 6);
  float n2 = pfbm1(uv + 2.2, 20.0, 4);
  // wind/tide ripples
  float rip = sin((uv.x * 14.0 + uv.y * 3.0 + n1 * 2.5) * 6.2832) * 0.5 + 0.5;
  rip = pow(rip, 1.6);
  // worm casts / shells
  vec4 pc = pvorCell(uv, vec2(30.0), 1.0);
  float shell = smoothstep(0.16, 0.10, pc.z) * step(0.86, pc.w);
  float wcast = smoothstep(0.22, 0.05, pc.z) * step(0.7, pc.w) * (1.0 - step(0.86, pc.w));
  vec3 dark = srgb(vec3(0.19, 0.17, 0.15));
  vec3 light = srgb(vec3(0.33, 0.30, 0.26));
  alb = mix(dark, light, n1 * 0.7 + rip * 0.3);
  alb = mix(alb, srgb(vec3(0.16, 0.18, 0.13)), smoothstep(0.55, 0.8, n2) * 0.4); // green film
  alb = mix(alb, srgb(vec3(0.75, 0.72, 0.66)), shell * 0.8);
  alb = mix(alb, srgb(vec3(0.27, 0.24, 0.2)), wcast * 0.5);
  h = rip * 0.35 + n1 * 0.5 + n2 * 0.15 + shell * 0.3 + wcast * 0.4;
  ao = 0.8 + 0.2 * rip;
  rough = 0.42 + n2 * 0.2 - rip * 0.1;
}`,
  sand: /* glsl */ `
void m_sand(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm1(uv, 4.0, 6);
  float grain = pn(uv * 512.0, vec2(512.0));
  float rip = sin((uv.x * 9.0 + uv.y * 2.0 + n1 * 1.6) * 6.2832) * 0.5 + 0.5;
  vec4 pc = pvorCell(uv, vec2(18.0), 1.0);
  float peb = smoothstep(0.24, 0.14, pc.z) * step(0.8, pc.w);
  alb = mix(srgb(vec3(0.50, 0.46, 0.39)), srgb(vec3(0.66, 0.61, 0.52)), n1);
  alb *= 0.9 + 0.2 * grain;
  alb = mix(alb, srgb(vec3(0.30, 0.29, 0.28)) * (0.7 + 0.6 * pc.w), peb);
  h = rip * 0.35 + n1 * 0.4 + grain * 0.1 + peb * 0.5;
  ao = 0.85 + 0.15 * rip - peb * 0.1;
  rough = 0.85;
}`,
  gravel: /* glsl */ `
void m_gravel(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  vec4 a = pvorCell(uv, vec2(40.0), 1.0);
  vec4 b = pvorCell(uv + 0.5, vec2(70.0), 1.0);
  float n1 = pfbm1(uv, 5.0, 5);
  float sa = sat(1.0 - a.z * 2.1);
  float sb = sat(1.0 - b.z * 2.2);
  vec3 dirt = mix(srgb(vec3(0.30, 0.25, 0.19)), srgb(vec3(0.42, 0.37, 0.30)), n1);
  vec3 stone = mix(srgb(vec3(0.42, 0.41, 0.40)), srgb(vec3(0.58, 0.55, 0.50)), a.w);
  vec3 stone2 = mix(srgb(vec3(0.36, 0.34, 0.33)), srgb(vec3(0.52, 0.49, 0.45)), b.w);
  alb = dirt;
  alb = mix(alb, stone2, smoothstep(0.1, 0.35, sb));
  alb = mix(alb, stone, smoothstep(0.1, 0.35, sa));
  h = max(sqrt(sa) * 0.8, sqrt(sb) * 0.55) + n1 * 0.2;
  ao = 0.55 + 0.45 * max(sa, sb);
  rough = 0.82;
}`,
  algae: /* glsl */ `
void m_algae(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  vec3 r; float rr, rh, rao;
  m_rock(uv, r, rr, rh, rao);
  float n1 = pfbm1(uv + 9.1, 8.0, 5);
  float weed = smoothstep(0.35, 0.6, n1);
  vec4 bc = pvorCell(uv, vec2(48.0), 1.0);
  float barn = smoothstep(0.3, 0.2, bc.z) * step(0.45, bc.w) * (1.0 - weed);
  float barnHole = smoothstep(0.1, 0.05, bc.z);
  vec4 mc = pvorCell(uv + 0.13, vec2(22.0), 0.8);
  float mussel = smoothstep(0.45, 0.25, mc.z) * smoothstep(0.55, 0.75, pfbm1(uv + 4.4, 6.0, 3));
  alb = r * vec3(0.65, 0.7, 0.62);
  alb = mix(alb, srgb(vec3(0.20, 0.22, 0.10)) * (0.7 + 0.6 * pfbm1(uv, 40.0, 2)), weed);
  alb = mix(alb, srgb(vec3(0.62, 0.60, 0.55)), barn * (1.0 - barnHole * 0.7));
  alb = mix(alb, srgb(vec3(0.06, 0.07, 0.09)), mussel);
  h = rh * 0.6 + weed * 0.3 + barn * 0.5 - barnHole * barn * 0.4 + mussel * 0.6;
  ao = rao * (0.7 + 0.3 * weed);
  rough = mix(0.5, 0.3, weed) - mussel * 0.15;
}`,
  cobble: /* glsl */ `
void m_cobble(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  vec4 a = pvorCell(uv, vec2(12.0), 0.85);
  float n1 = pfbm1(uv, 8.0, 4);
  float d = a.z;
  float dome = sat(1.0 - d * 1.9);
  vec3 c = mix(srgb(vec3(0.34, 0.33, 0.32)), srgb(vec3(0.55, 0.52, 0.47)), a.w);
  c = mix(c, srgb(vec3(0.42, 0.36, 0.30)), step(0.8, fract(a.w * 7.0)) * 0.6);
  alb = mix(srgb(vec3(0.22, 0.2, 0.18)), c * (0.85 + 0.3 * n1), smoothstep(0.02, 0.2, dome));
  h = sqrt(dome) * 0.9 + n1 * 0.1;
  ao = 0.4 + 0.6 * smoothstep(0.0, 0.4, dome);
  rough = 0.7;
}`,
  barkFir: /* glsl */ `
void m_barkFir(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  // uv.x around the trunk, uv.y along it: deep vertical furrows and corky plates
  vec3 v = pvor(vec2(uv.x, uv.y), vec2(9.0, 3.0), 0.85);
  vec3 v2 = pvor(vec2(uv.x, uv.y) + 0.27, vec2(22.0, 7.0), 0.9);
  float n1 = pfbm(uv, vec2(8.0, 4.0), 5, 0.55);
  float furrow = smoothstep(0.02, 0.22, v.y - v.x);
  float plate = furrow * (0.75 + 0.25 * smoothstep(0.02, 0.15, v2.y - v2.x));
  vec3 cork = mix(srgb(vec3(0.36, 0.24, 0.17)), srgb(vec3(0.50, 0.36, 0.25)), n1);
  cork *= 0.85 + 0.3 * v.z;
  vec3 deep = srgb(vec3(0.10, 0.07, 0.05));
  alb = mix(deep, cork, plate);
  // grey weathering and moss on the plates
  float moss = smoothstep(0.62, 0.8, pfbm(uv + 3.1, vec2(4.0, 2.0), 4, 0.5));
  alb = mix(alb, srgb(vec3(0.42, 0.40, 0.36)), smoothstep(0.55, 0.9, n1) * 0.35);
  alb = mix(alb, srgb(vec3(0.20, 0.30, 0.10)), moss * plate * 0.8);
  h = plate * 0.8 + n1 * 0.2;
  ao = 0.35 + 0.65 * plate;
  rough = 0.88;
}`,
  barkAlder: /* glsl */ `
void m_barkAlder(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm(uv, vec2(6.0, 3.0), 5, 0.5);
  float n2 = pfbm(uv + 1.3, vec2(20.0, 10.0), 4, 0.5);
  vec4 lc = pvorCell(uv, vec2(18.0, 30.0), 0.8);
  float lenticel = smoothstep(0.18, 0.05, abs(lc.y) * 3.0 + abs(lc.x) * 0.6) * step(0.4, lc.w);
  float lichen = smoothstep(0.5, 0.75, pfbm(uv + 7.7, vec2(5.0, 3.0), 5, 0.55));
  vec3 grey = mix(srgb(vec3(0.42, 0.42, 0.40)), srgb(vec3(0.58, 0.57, 0.53)), n1);
  alb = grey * (0.9 + 0.2 * n2);
  alb = mix(alb, srgb(vec3(0.72, 0.74, 0.66)), lichen * 0.7);
  alb = mix(alb, srgb(vec3(0.25, 0.22, 0.2)), lenticel * 0.8);
  h = n1 * 0.4 + n2 * 0.2 - lenticel * 0.3 + lichen * 0.2;
  ao = 1.0 - lenticel * 0.3;
  rough = 0.8;
}`,
  asphalt: /* glsl */ `
void m_asphalt(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm1(uv, 4.0, 5);
  float n2 = pfbm1(uv + 3.3, 16.0, 4);
  float grain = pn(uv * 512.0, vec2(512.0));
  vec4 ag = pvorCell(uv, vec2(96.0), 1.0);
  float stone = smoothstep(0.35, 0.2, ag.z) * step(0.55, ag.w);
  vec3 v = pvor(uv, vec2(5.0, 3.0), 0.9);
  float crack = smoothstep(0.035, 0.0, v.y - v.x) * smoothstep(0.55, 0.75, pfbm1(uv + 9.0, 6.0, 3));
  float patchM = smoothstep(0.8, 0.84, pfbm1(uv + 1.1, 3.0, 2)) * 0.6;
  vec3 base = mix(srgb(vec3(0.20, 0.20, 0.20)), srgb(vec3(0.30, 0.30, 0.29)), n1);
  base = mix(base, srgb(vec3(0.13, 0.13, 0.135)), patchM * 0.9);
  base *= 0.9 + 0.2 * grain;
  base = mix(base, srgb(vec3(0.36, 0.35, 0.33)) * (0.85 + 0.3 * ag.w), stone * 0.35);
  alb = base * (1.0 - crack * 0.6);
  // oil / tyre darkening
  alb *= 1.0 - smoothstep(0.55, 0.9, n2) * 0.15;
  h = grain * 0.25 + stone * 0.15 + n1 * 0.05 - crack * 0.8 - patchM * 0.03;
  ao = 1.0 - crack * 0.6;
  rough = mix(0.86, 0.95, patchM) - stone * 0.1;
}`,
  clapboard: /* glsl */ `
void m_clapboard(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  // horizontal lap siding: 10 boards per repeat (tile = 2 m -> 20 cm boards)
  float b = uv.y * 10.0;
  float fb = fract(b);
  float board = floor(b);
  float lap = smoothstep(0.0, 0.08, fb) * (0.75 + 0.25 * fb);
  float grain = pfbm(vec2(uv.x * 1.0, uv.y * 10.0 + board * 0.37), vec2(8.0, 40.0), 4, 0.5);
  float wear = smoothstep(0.66, 0.86, pfbm(uv * vec2(1.0, 1.0) + board * 0.13, vec2(8.0, 20.0), 5, 0.6)) * 0.7;
  float dirt = pfbm(uv + 5.0, vec2(3.0), 4, 0.5) * 0.12;
  // butt joints
  float joint = step(0.985, fract(uv.x * 1.5 + th21(vec2(board, 3.0)) * 0.7));
  vec3 paint = vec3(0.86, 0.85, 0.82) * (0.92 + 0.08 * grain);
  vec3 wood = srgb(vec3(0.46, 0.42, 0.36)) * (0.8 + 0.4 * grain);
  alb = mix(paint, wood, wear * 0.85);
  alb *= 1.0 - dirt * 0.3;
  alb *= mix(0.42, 1.0, smoothstep(0.0, 0.12, fb));
  alb *= 1.0 - joint * 0.4;
  h = lap * 1.4 - wear * 0.05 - joint * 0.3;
  ao = mix(0.5, 1.0, smoothstep(0.0, 0.15, fb));
  rough = mix(0.62, 0.9, wear);
}`,
  shingles: /* glsl */ `
void m_shingles(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  // three-tab asphalt shingles, 8 courses per tile
  float row = floor(uv.y * 8.0);
  float fy = fract(uv.y * 8.0);
  float off = mod(row, 2.0) * 0.5;
  float fx = fract(uv.x * 3.0 + off + th21(vec2(row, 1.0)) * 0.2);
  float tab = floor(uv.x * 3.0 + off);
  float slot = smoothstep(0.015, 0.0, abs(fx - 0.5) - 0.0) * step(0.55, fy) + step(fx, 0.02);
  float granule = pn(uv * 400.0, vec2(400.0));
  float shade = th21(vec2(tab, row)) * 0.25;
  vec3 c = srgb(vec3(0.22, 0.21, 0.20)) * (0.85 + shade) * (0.85 + 0.3 * granule);
  float moss = smoothstep(0.62, 0.8, pfbm1(uv + 2.0, 4.0, 5)) * smoothstep(0.6, 0.0, fy);
  c = mix(c, srgb(vec3(0.22, 0.28, 0.10)), moss * 0.8);
  c *= mix(0.5, 1.0, smoothstep(0.0, 0.25, fy));
  alb = c * (1.0 - slot * 0.6);
  h = fy * 0.6 + granule * 0.15 - slot * 0.5;
  ao = mix(0.45, 1.0, smoothstep(0.0, 0.3, fy));
  rough = 0.9;
}`,
  planks: /* glsl */ `
void m_planks(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  // weathered boards running along u, 8 per tile
  float b = uv.y * 8.0;
  float board = floor(b);
  float fb = fract(b);
  float gap = smoothstep(0.04, 0.0, fb) + smoothstep(0.96, 1.0, fb);
  float seg = floor(uv.x * 2.0 + th21(vec2(board, 7.0)));
  float grain = pfbm(vec2(uv.x * 2.0, uv.y * 8.0 + board * 0.71), vec2(6.0, 64.0), 5, 0.55);
  float knot = smoothstep(0.08, 0.0, length((fract(vec2(uv.x * 4.0, b) + th22(vec2(board, seg)) ) - 0.5) * vec2(1.0, 3.0))) * step(0.7, th21(vec2(board, seg * 3.0)));
  vec3 base = mix(srgb(vec3(0.34, 0.30, 0.25)), srgb(vec3(0.52, 0.47, 0.40)), th21(vec2(board, seg)));
  alb = base * (0.75 + 0.45 * grain);
  alb = mix(alb, srgb(vec3(0.2, 0.15, 0.1)), knot * 0.7);
  alb *= 1.0 - gap * 0.75;
  h = 0.8 - gap * 0.8 + grain * 0.2;
  ao = 1.0 - gap * 0.6;
  rough = 0.82;
}`,
  brick: /* glsl */ `
void m_brick(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float row = floor(uv.y * 16.0);
  float fy = fract(uv.y * 16.0);
  float fx = fract(uv.x * 8.0 + mod(row, 2.0) * 0.5);
  float id = th21(vec2(floor(uv.x * 8.0 + mod(row, 2.0) * 0.5), row));
  float mortar = 1.0 - smoothstep(0.03, 0.08, min(min(fx, 1.0 - fx) * 2.0, min(fy, 1.0 - fy)));
  float n = pfbm1(uv, 32.0, 3);
  vec3 b = mix(srgb(vec3(0.42, 0.16, 0.10)), srgb(vec3(0.55, 0.26, 0.16)), id) * (0.8 + 0.3 * n);
  b = mix(b, srgb(vec3(0.2, 0.18, 0.16)), step(0.93, id) * 0.6);
  alb = mix(b, srgb(vec3(0.55, 0.53, 0.5)), mortar);
  h = (1.0 - mortar) * 0.8 + n * 0.2;
  ao = 1.0 - mortar * 0.5;
  rough = 0.88;
}`,
  concrete: /* glsl */ `
void m_concrete(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm1(uv, 4.0, 6);
  float n2 = pfbm1(uv + 7.0, 24.0, 4);
  float pores = smoothstep(0.7, 0.8, pn(uv * 160.0, vec2(160.0)));
  float stain = smoothstep(0.4, 0.9, pfbm(uv, vec2(2.0, 6.0), 5, 0.55));
  alb = mix(srgb(vec3(0.46, 0.45, 0.43)), srgb(vec3(0.60, 0.59, 0.56)), n1);
  alb *= 1.0 - stain * 0.25;
  alb *= 1.0 - pores * 0.3;
  h = n1 * 0.3 + n2 * 0.2 - pores * 0.3;
  ao = 1.0 - pores * 0.4;
  rough = 0.9;
}`,
  corrugated: /* glsl */ `
void m_corrugated(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float w = sin(uv.x * 6.2832 * 20.0) * 0.5 + 0.5;
  float rust = smoothstep(0.45, 0.8, pfbm(uv, vec2(3.0, 6.0), 6, 0.55));
  float streak = smoothstep(0.5, 0.9, pfbm(vec2(uv.x * 1.0, uv.y * 0.2), vec2(24.0, 2.0), 4, 0.5));
  float seam = step(0.98, fract(uv.y * 2.0));
  vec3 metal = srgb(vec3(0.52, 0.53, 0.52)) * (0.85 + 0.15 * w);
  vec3 rustC = mix(srgb(vec3(0.38, 0.17, 0.07)), srgb(vec3(0.55, 0.30, 0.12)), streak);
  alb = mix(metal, rustC, max(rust, streak * 0.6));
  alb *= 1.0 - seam * 0.5;
  h = w * 0.8;
  ao = 0.7 + 0.3 * w;
  rough = mix(0.45, 0.85, rust);
}`,
  roofMetal: /* glsl */ `
void m_roofMetal(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float fx = fract(uv.x * 4.0);
  float rib = smoothstep(0.04, 0.0, abs(fx - 0.5));
  float rust = smoothstep(0.5, 0.85, pfbm(uv, vec2(3.0, 8.0), 6, 0.55));
  vec3 c = srgb(vec3(0.36, 0.14, 0.10));
  c = mix(c, srgb(vec3(0.30, 0.20, 0.14)), rust);
  c *= 0.9 + 0.2 * pfbm(uv, vec2(8.0, 2.0), 3, 0.5);
  alb = c;
  h = rib;
  ao = 1.0;
  rough = mix(0.5, 0.9, rust);
}`,
  stucco: /* glsl */ `
void m_stucco(vec2 uv, out vec3 alb, out float rough, out float h, out float ao) {
  float n1 = pfbm1(uv, 8.0, 6);
  float n2 = pfbm1(uv + 2.0, 40.0, 3);
  alb = vec3(0.82, 0.8, 0.76) * (0.9 + 0.12 * n1) * (0.95 + 0.08 * n2);
  alb *= 1.0 - smoothstep(0.55, 0.9, pfbm(uv, vec2(2.0, 5.0), 5, 0.55)) * 0.2;
  h = n1 * 0.6 + n2 * 0.4;
  ao = 1.0;
  rough = 0.92;
}`,
};

const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function bakeFrag(name: string, lib: string, mode: 'albedo' | 'height') {
  return /* glsl */ `
${TEX_NOISE}
${lib}
varying vec2 vUv;
void main() {
  vec3 alb; float rough; float h; float ao;
  m_${name}(fract(vUv), alb, rough, h, ao);
  ${mode === 'albedo' ? 'gl_FragColor = vec4(clamp(alb, 0.0, 1.0), clamp(rough, 0.02, 1.0));' : 'gl_FragColor = vec4(h, ao, 0.0, 1.0);'}
}`;
}

const NORMAL_FRAG = /* glsl */ `
uniform sampler2D tH;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uFull;
varying vec2 vUv;
void main() {
  float l = texture2D(tH, fract(vUv - vec2(uTexel.x, 0.0))).r;
  float r = texture2D(tH, fract(vUv + vec2(uTexel.x, 0.0))).r;
  float d = texture2D(tH, fract(vUv - vec2(0.0, uTexel.y))).r;
  float u = texture2D(tH, fract(vUv + vec2(0.0, uTexel.y))).r;
  vec4 c = texture2D(tH, vUv);
  vec3 n = normalize(vec3((l - r) * uStrength, (d - u) * uStrength, 1.0));
  if (uFull > 0.5) gl_FragColor = vec4(n * 0.5 + 0.5, clamp(c.g, 0.0, 1.0));
  else gl_FragColor = vec4(n.xy * 0.5 + 0.5, clamp(c.r, 0.0, 1.0), clamp(c.g, 0.0, 1.0));
}
`;

// Resolve dependencies: some materials call others (algae -> rock)
function libFor(name: string) {
  const deps: Record<string, string[]> = { algae: ['rock'] };
  const names = [...(deps[name] ?? []), name];
  return names.map((n) => MATERIAL_LIB[n]).join('\n');
}

export class TexGen {
  renderer: THREE.WebGLRenderer;
  private quad = new FullScreenQuad();
  extraLib: Record<string, string> = {};
  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  register(name: string, glsl: string) {
    MATERIAL_LIB[name] = glsl;
  }

  private material(frag: string, uniforms: Record<string, THREE.IUniform> = {}) {
    return new THREE.ShaderMaterial({
      vertexShader: BAKE_VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
  }

  private heightRT(size: number) {
    return new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
  }

  /** Bake one material into two standalone textures. */
  bake(name: string, size: number, normalStrength = 6, deps: string[] = []): { map: THREE.Texture; normal: THREE.Texture } {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const lib = [...deps.map((d) => MATERIAL_LIB[d]), libFor(name)].join('\n');
    const albedoRT = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      colorSpace: THREE.SRGBColorSpace,
      anisotropy: 8,
    });
    const normalRT = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      anisotropy: 8,
    });
    const hRT = this.heightRT(size);
    const ma = this.material(bakeFrag(name, lib, 'albedo'));
    const mh = this.material(bakeFrag(name, lib, 'height'));
    const mn = this.material(NORMAL_FRAG, {
      tH: { value: hRT.texture },
      uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
      uStrength: { value: normalStrength },
      uFull: { value: 1 },
    });
    this.quad.material = ma;
    r.setRenderTarget(albedoRT);
    this.quad.render(r);
    this.quad.material = mh;
    r.setRenderTarget(hRT);
    this.quad.render(r);
    this.quad.material = mn;
    r.setRenderTarget(normalRT);
    this.quad.render(r);
    r.setRenderTarget(prev);
    ma.dispose();
    mh.dispose();
    mn.dispose();
    hRT.dispose();
    albedoRT.texture.wrapS = albedoRT.texture.wrapT = THREE.RepeatWrapping;
    normalRT.texture.wrapS = normalRT.texture.wrapT = THREE.RepeatWrapping;
    return { map: albedoRT.texture, normal: normalRT.texture };
  }

  /** Bake several materials into two texture arrays (albedo/rough, normal/height/ao). */
  bakeArray(names: string[], size: number, normalStrength = 6): { albedo: THREE.Texture; normal: THREE.Texture } {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const layers = names.length;
    const aRT = new THREE.WebGLArrayRenderTarget(size, size, layers, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
    });
    aRT.texture.colorSpace = THREE.SRGBColorSpace;
    const nRT = new THREE.WebGLArrayRenderTarget(size, size, layers, {
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
    });
    for (const t of [aRT.texture, nRT.texture]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = 8;
    }
    const hRT = this.heightRT(size);
    names.forEach((name, i) => {
      const lib = libFor(name);
      const ma = this.material(bakeFrag(name, lib, 'albedo'));
      const mh = this.material(bakeFrag(name, lib, 'height'));
      const mn = this.material(NORMAL_FRAG, {
        tH: { value: hRT.texture },
        uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
        uStrength: { value: normalStrength },
        uFull: { value: 0 },
      });
      const last = i === layers - 1;
      aRT.texture.generateMipmaps = last;
      nRT.texture.generateMipmaps = last;
      this.quad.material = ma;
      r.setRenderTarget(aRT, i);
      this.quad.render(r);
      this.quad.material = mh;
      r.setRenderTarget(hRT);
      this.quad.render(r);
      this.quad.material = mn;
      r.setRenderTarget(nRT, i);
      this.quad.render(r);
      ma.dispose();
      mh.dispose();
      mn.dispose();
    });
    r.setRenderTarget(prev);
    hRT.dispose();
    return { albedo: aRT.texture, normal: nRT.texture };
  }
}
