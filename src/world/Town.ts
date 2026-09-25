// Assembles the town: buildings (batched per material), signs, and material setup.
import * as THREE from 'three';
import { MeshBatcher } from './Batcher';
import { BuildingGen, type BuildingInfo } from './BuildingGen';
import { BUILDINGS } from './TownPlan';
import type { CollisionWorld } from './Collision';
import type { TexGen } from '../render/TexGen';
import { LAYER } from '../render/Globals';
import { injectGlobals } from '../render/Chunks';
import { makeClearGlassMaterial, makeWindowMaterial } from '../render/WindowShader';

export type TexSet = { map: THREE.Texture; normal: THREE.Texture };

/** Standard material whose roughness comes from the albedo alpha channel, with wetness. */
export function stdMat(tex: TexSet | null, opts: { color?: number; rough?: number; metal?: number; vertexColors?: boolean; wet?: boolean; normalScale?: number; envScale?: number } = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: tex?.map ?? null,
    normalMap: tex?.normal ?? null,
    color: opts.color ?? 0xffffff,
    roughness: opts.rough ?? 1,
    metalness: opts.metal ?? 0,
    vertexColors: opts.vertexColors ?? true,
  });
  if (tex) m.normalScale.setScalar(opts.normalScale ?? 1);
  const wet = opts.wet ?? true;
  m.onBeforeCompile = (shader) => {
    injectGlobals(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWetness;')
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
        #ifdef USE_MAP
          roughnessFactor *= texture2D(map, vMapUv).a;
        #endif
        ${
          wet
            ? `
        #ifdef USE_FOG
        {
          // rain wetness on exposed, up-facing surfaces (roofs/porches keep interiors dry)
          vec3 wn = inverseTransformDirection(normalize(vNormal), viewMatrix);
          float exposure = clamp(wn.y * 0.7 + 0.45, 0.0, 1.0);
          float wetK = uWetness * exposure;
          diffuseColor.rgb *= mix(1.0, 0.62, wetK);
          roughnessFactor = mix(roughnessFactor, 0.18, wetK * clamp(wn.y, 0.0, 1.0));
          roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.6, wetK);
        }
        #endif`
            : ''
        }`,
      );
  };
  m.customProgramCacheKey = () => 'bw-std-' + (wet ? 'w' : 'd');
  return m;
}

export type TownResult = {
  group: THREE.Group;
  buildings: BuildingInfo[];
  byId: Map<string, BuildingInfo>;
  materials: Record<string, THREE.Material>;
  batcher: MeshBatcher;
};

export function buildTown(texgen: TexGen, collision: CollisionWorld, groundAt: (x: number, z: number) => number, texSize: number): TownResult {
  const batcher = new MeshBatcher();
  const gen = new BuildingGen(batcher, collision);
  const buildings: BuildingInfo[] = [];
  const byId = new Map<string, BuildingInfo>();
  for (const plan of BUILDINGS) {
    const floorY = plan.pad.y + (plan.floorLift ?? 0);
    const info = gen.build({ ...plan, floorY, groundAt });
    buildings.push(info);
    byId.set(plan.id, info);
  }
  const ts = Math.min(texSize, 1024);
  const clap = texgen.bake('clapboard', ts, 5);
  const shingles = texgen.bake('shingles', ts, 6);
  const planks = texgen.bake('planks', ts, 5);
  const brick = texgen.bake('brick', 512, 6);
  const concrete = texgen.bake('concrete', 512, 3);
  const corr = texgen.bake('corrugated', 512, 8);
  const roofMetal = texgen.bake('roofMetal', 512, 6);
  const stucco = texgen.bake('stucco', 512, 3);

  const materials: Record<string, THREE.Material> = {
    siding: stdMat(clap, { rough: 1 }),
    shingleWall: stdMat(shingles, { rough: 1, color: 0xb59a7e }),
    corrugated: stdMat(corr, { rough: 1, metal: 0.35 }),
    stucco: stdMat(stucco, { rough: 1 }),
    brick: stdMat(brick, { rough: 1 }),
    boardWall: stdMat(planks, { rough: 1 }),
    plaster: stdMat(stucco, { rough: 1, wet: false }),
    trim: stdMat(null, { rough: 0.62 }),
    concrete: stdMat(concrete, { rough: 1 }),
    planks: stdMat(planks, { rough: 1 }),
    shingles: stdMat(shingles, { rough: 1 }),
    roofMetal: stdMat(roofMetal, { rough: 1, metal: 0.4 }),
    metal: stdMat(null, { rough: 0.45, metal: 0.7 }),
    door: stdMat(planks, { rough: 1 }),
    piling: stdMat(planks, { rough: 1, color: 0x6a5a4a }),
    glass: makeWindowMaterial(),
    glassClear: makeClearGlassMaterial(),
  };
  const group = new THREE.Group();
  group.name = 'town';
  for (const key of batcher.batches.keys()) {
    const g = batcher.buildGeometry(key);
    if (!g) continue;
    const mat = materials[key] ?? materials.trim;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'town-' + key;
    mesh.castShadow = key !== 'glass' && key !== 'glassClear';
    mesh.receiveShadow = true;
    if (key === 'glassClear') mesh.layers.set(LAYER.TRANSPARENT);
    else mesh.layers.set(LAYER.OPAQUE);
    group.add(mesh);
  }
  for (const b of buildings) for (const s of b.signs) group.add(s.userData.worldHolder as THREE.Object3D);
  return { group, buildings, byId, materials, batcher };
}
