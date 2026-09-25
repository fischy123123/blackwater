// Road surfaces: asphalt with painted lines, wear and puddled wheel ruts; gravel tracks.
import * as THREE from 'three';
import type { TerrainData } from './TerrainGen';
import { injectGlobals } from '../render/Chunks';
import { LAYER } from '../render/Globals';
import { P } from './Layout';

export type RoadMeshes = { group: THREE.Group; paths: Map<string, THREE.Vector3[]> };

export function buildRoads(t: TerrainData, tex: { asphalt: { map: THREE.Texture; normal: THREE.Texture }; gravel: { map: THREE.Texture; normal: THREE.Texture } }): RoadMeshes {
  const group = new THREE.Group();
  const paths = new Map<string, THREE.Vector3[]>();
  for (const r of t.roadSamples) {
    const pts = r.pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    paths.set(r.id, pts);
    const gravel = r.id === 'lighthouse' || r.id === 'cliffpath';
    const half = r.width * 0.5;
    const sh = r.shoulder;
    // cross-section offsets (m) and u coordinate (0..1 over total width)
    const offs = [-half - sh, -half, -half * 0.5, 0, half * 0.5, half, half + sh];
    const total = r.width + sh * 2;
    const pos: number[] = [];
    const uv: number[] = [];
    const road: number[] = [];
    const idx: number[] = [];
    let v = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)],
        b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b.x - a.x,
        dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      if (i > 0) v += p.distanceTo(pts[i - 1]);
      for (const o of offs) {
        const edge = Math.abs(o) > half - 0.01;
        const crown = gravel ? (Math.abs(o) < 0.6 ? 0.06 : 0) : 0.07 * (1 - Math.min(1, Math.abs(o) / half));
        const drop = edge && Math.abs(o) > half + 0.01 ? -0.06 : 0;
        const y = p.y + crown + drop;
        const wx = p.x - dz * o,
          wz = p.z + dx * o;
        pos.push(wx, y, wz);
        uv.push(wx * 0.22, wz * 0.22);
        road.push((o + total / 2) / total, v);
      }
    }
    const W = offs.length;
    for (let i = 0; i < pts.length - 1; i++)
      for (let k = 0; k < W - 1; k++) {
        const a = i * W + k,
          b = a + 1,
          c = a + W,
          d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(road, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const src = gravel ? tex.gravel : tex.asphalt;
    const mat = new THREE.MeshStandardMaterial({
      map: src.map,
      normalMap: src.normal,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    // asphalt aggregate is fine-grained: keep the bump subtle (gravel stays rough)
    mat.normalScale.setScalar(gravel ? 1.0 : 0.35);
    patchRoad(mat, { width: r.width, total, lines: r.lines, gravel, id: r.id });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.layers.set(LAYER.OPAQUE);
    m.name = 'road-' + r.id;
    group.add(m);
  }
  return { group, paths };
}

function patchRoad(mat: THREE.MeshStandardMaterial, o: { width: number; total: number; lines: boolean; gravel: boolean; id: string }) {
  const uniforms = {
    uRoadW: { value: o.width / o.total },
    uRoadTotal: { value: o.total },
    uLines: { value: o.lines ? 1 : 0 },
    uGravel: { value: o.gravel ? 1 : 0 },
    uDashed: { value: o.id === 'main' ? 0 : 1 },
    uOverlook: { value: new THREE.Vector2(P.overlook.x, P.overlook.z) },
  };
  mat.onBeforeCompile = (shader) => {
    injectGlobals(shader);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 aRoad;\nvarying vec2 vRoadUv;\nvarying vec3 vRoadW;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\nvRoadUv = aRoad;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvRoadW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vRoadUv;
        varying vec3 vRoadW;
        uniform float uRoadW;
        uniform float uRoadTotal;
        uniform float uLines;
        uniform float uGravel;
        uniform float uDashed;
        uniform float uWetness;
        uniform float uRain;
        uniform float uTime;
        float rHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float rNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(rHash(i), rHash(i + vec2(1.0, 0.0)), u.x), mix(rHash(i + vec2(0.0, 1.0)), rHash(i + vec2(1.0, 1.0)), u.x), u.y); }
        float rFbm(vec2 p) { return rNoise(p) * 0.5 + rNoise(p * 2.1 + 3.1) * 0.3 + rNoise(p * 4.3 + 7.7) * 0.2; }`,
      )
      .replace(
        '#include <map_fragment>',
        `
        vec4 texel = texture2D(map, vMapUv);
        diffuseColor *= texel;
        float across = (vRoadUv.x - 0.5) * uRoadTotal; // metres from centre
        float halfW = uRoadW * uRoadTotal * 0.5;
        float along = vRoadUv.y;
        float edgeN = rFbm(vec2(along * 0.6, across * 0.3) + 4.0);
        // crumbling asphalt edge into the gravel shoulder
        float shoulder = smoothstep(halfW - 0.25 - edgeN * 0.35, halfW + 0.1, abs(across));
        vec3 gravelC = vec3(0.24, 0.22, 0.19) * (0.7 + 0.6 * rNoise(vRoadW.xz * 6.0));
        float rutMask = 0.0;
        float roadRough = 0.0;
        if (uGravel > 0.5) {
          // two wheel tracks, grassy crown
          float t1 = smoothstep(0.45, 0.2, abs(abs(across) - 0.85));
          float crownGrass = smoothstep(0.35, 0.1, abs(across)) * smoothstep(0.3, 0.6, rFbm(vRoadW.xz * 0.8));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.75, t1 * 0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08, 0.1, 0.04), crownGrass * 0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.14, 0.06), smoothstep(halfW - 0.3, halfW + 0.4, abs(across)) * 0.7);
          rutMask = t1;
        } else {
          diffuseColor.rgb = mix(diffuseColor.rgb, gravelC, shoulder);
          // painted lines
          if (uLines > 0.5) {
            float wear = smoothstep(0.25, 0.75, rFbm(vec2(along * 0.35, across * 2.0)));
            // double yellow centre line (dashed on the coast road: passing zones)
            float cl = smoothstep(0.07, 0.05, abs(abs(across) - 0.11));
            float dash = uDashed > 0.5 ? step(0.45, fract(along / 9.0)) : 1.0;
            float yellow = cl * mix(1.0, dash, step(0.0, across)) * (0.35 + 0.65 * wear);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.46, 0.12), yellow * 0.85);
            // white fog lines
            float el = smoothstep(0.08, 0.055, abs(abs(across) - (halfW - 0.3)));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.62, 0.58), el * (0.3 + 0.7 * wear) * 0.8);
            roadRough -= (yellow + el) * 0.15;
          }
          // wheel ruts (polished, collect water)
          float lane = abs(abs(across) - halfW * 0.5);
          rutMask = smoothstep(0.55, 0.25, abs(lane - 0.75)) * (1.0 - shoulder);
          diffuseColor.rgb *= 1.0 - rutMask * 0.12;
          // tar snakes along cracks
          float snake = smoothstep(0.02, 0.0, abs(rNoise(vec2(along * 0.12, across * 0.4)) - 0.5) - 0.004) * (1.0 - shoulder);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03), snake * 0.8);
          roadRough -= snake * 0.3;
        }
        // leaves blown onto the road edges (autumn)
        float leaf = smoothstep(0.78, 0.9, rNoise(vRoadW.xz * 3.1)) * smoothstep(halfW - 1.6, halfW, abs(across));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.24, 0.07) * (0.6 + 0.8 * rNoise(vRoadW.xz * 9.0)), leaf * 0.85);
        // wetness + puddles in ruts
        float puddle = smoothstep(0.62, 0.8, rFbm(vRoadW.xz * 0.45) + rutMask * 0.35) * uWetness;
        diffuseColor.rgb *= mix(1.0, 0.55, uWetness);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = texel.a + roadRough;
        roughnessFactor = mix(roughnessFactor, 0.28, uWetness);
        roughnessFactor = mix(roughnessFactor, 0.02, puddle);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize(mix(normal, nonPerturbedNormal, puddle * 0.95));`,
      );
  };
  mat.customProgramCacheKey = () => 'bw-road-' + (o.gravel ? 'g' : 'a');
}
