// Builds the whole world in steps so the loading screen can breathe between them.
import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import { generateTerrain, type TerrainData } from '../world/TerrainGen';
import { Terrain, TERRAIN_LAYERS } from '../world/Terrain';
import { SkySystem } from '../render/Sky';
import { Environment } from '../world/Environment';
import { TexGen, MATERIAL_LIB } from '../render/TexGen';
import { buildFarTerrain } from '../world/FarTerrain';
import { buildFlatsWater, buildRiver, buildSea, makeWaterMaterial, WATER_NORMAL_GLSL } from '../world/Water';
import { LAYER } from '../render/Globals';
import { Forest, type Exclusion } from '../world/Forest';
import { P } from '../world/Layout';
import { buildRoads, type RoadMeshes } from '../world/Roads';
import { CollisionWorld } from '../world/Collision';
import '../world/TownPlan'; // registers building lots before terrain generation
import { buildTown, type TownResult } from '../world/Town';
import { LightManager } from '../world/Lights';
import { dressWorld, SHARED_MATS, type DressingResult } from '../world/Dressing';
import { buildPlaces, type PlacesResult } from '../world/Places';
import { furnishAll, type InteriorResult } from '../world/Interiors';
import { WeatherFX } from '../world/Weather';

export type World = {
  data: TerrainData;
  terrain: Terrain;
  sky: SkySystem;
  env: Environment;
  texgen: TexGen;
  forest: Forest;
  roads: RoadMeshes;
  collision: CollisionWorld;
  water: { flats: THREE.Mesh; river: THREE.Mesh; sea: THREE.Mesh; normal: THREE.Texture };
  town: TownResult;
  lights: LightManager;
  dressing: DressingResult;
  places: PlacesResult;
  interiors: InteriorResult;
  weather: WeatherFX;
  exclusions: Exclusion[];
  updaters: ((dt: number, camera: THREE.PerspectiveCamera) => void)[];
};

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export async function buildWorld(engine: Engine, progress: (p: number, label: string) => void): Promise<World> {
  const q = engine.quality;
  const scene = engine.scene;
  progress(0.02, 'Shaping the coastline');
  await frame();
  const data = generateTerrain((p) => void p);
  progress(0.3, 'Painting rock and tide');
  await frame();
  const texgen = new TexGen(engine.renderer);
  const layers = texgen.bakeArray(TERRAIN_LAYERS, q.texSize);
  const terrain = new Terrain(data, layers, { shadowRes: q.terrainShadowRes, detail: q.terrainDetail });
  scene.add(terrain.mesh);
  scene.add(buildFarTerrain());

  progress(0.4, 'Hanging the sky');
  await frame();
  const sky = new SkySystem(engine.renderer, { cubeSize: q.skyCube, steps: q.skySteps, facesPerFrame: q.skyFacesPerFrame });
  scene.add(sky.dome);
  const env = new Environment(scene, sky, engine.pipeline, { size: q.shadowMapSize, far: q.shadowFar });

  progress(0.48, 'Filling the tide pools');
  await frame();
  MATERIAL_LIB.waterN = /* keep in lib */ WATER_NORMAL_GLSL;
  const waterTex = texgen.bake('waterN', 512, 3.5);
  const sceneTex = () => engine.pipeline.copyRT.texture;
  const flats = new THREE.Mesh(
    buildFlatsWater(data),
    makeWaterMaterial(waterTex.normal, sceneTex, q.ssr, {
      absorb: new THREE.Color(0.55, 0.32, 0.26),
      scatter: new THREE.Color(0.12, 0.13, 0.1),
      rough: 0.04,
      foam: 0.25,
      normalScale: 0.18,
    }),
  );
  const river = new THREE.Mesh(
    buildRiver(data, (x, z) => terrain.heightAt(x, z)),
    makeWaterMaterial(waterTex.normal, sceneTex, q.ssr, {
      absorb: new THREE.Color(0.5, 0.24, 0.2),
      scatter: new THREE.Color(0.06, 0.1, 0.09),
      rough: 0.07,
      foam: 0.9,
      normalScale: 0.55,
    }),
  );
  const sea = new THREE.Mesh(
    buildSea(),
    makeWaterMaterial(waterTex.normal, sceneTex, q.ssr, {
      absorb: new THREE.Color(0.32, 0.09, 0.07),
      scatter: new THREE.Color(0.05, 0.12, 0.13),
      rough: 0.05,
      foam: 1.0,
      normalScale: 0.4,
      waveAmp: 0.35,
    }),
  );
  sea.position.y = -60;
  sea.visible = false;
  for (const m of [flats, river, sea]) {
    m.layers.set(LAYER.TRANSPARENT);
    m.frustumCulled = m !== sea;
    scene.add(m);
  }

  progress(0.56, 'Laying the roads');
  await frame();
  const asphalt = texgen.bake('asphalt', q.texSize, 4);
  const gravel = texgen.bake('gravel', 512, 5);
  const roads = buildRoads(data, { asphalt, gravel });
  scene.add(roads.group);

  const collision = new CollisionWorld((x, z) => terrain.heightAt(x, z));
  collision.waterAt = (x, z) => terrain.waterAt(x, z);

  progress(0.6, 'Raising the town');
  await frame();
  const town = buildTown(texgen, collision, (x, z) => terrain.heightAt(x, z), q.texSize);
  scene.add(town.group);

  progress(0.66, 'Growing the forest');
  await frame();
  const exclusions: Exclusion[] = [
    { x: P.overlook.x + 8, z: P.overlook.z + 10, r: 22 },
    { x0: -130, z0: -60, x1: 170, z1: 205 },
  ];
  const forest = new Forest(engine.renderer, texgen, terrain, {
    near: q.treeNear,
    far: q.treeFar,
    atlasSize: q.tier === 'low' ? 1024 : 2048,
    frames: 8,
    lowQ: q.tier === 'low',
    density: 1,
    exclusions,
  });
  forest.addTo(scene);
  for (const c of forest.colliders) collision.circle(c.x, c.z, c.r, -100, 1000, 'tree');

  progress(0.84, 'Stringing the power lines');
  await frame();
  const lights = new LightManager(scene, q.pointLights);
  Object.assign(SHARED_MATS, town.materials);
  const dressing = dressWorld(scene, texgen, collision, lights, terrain, forest.variants[1], forest.staticMaterials(1));
  progress(0.87, 'Lighting the lamp');
  await frame();
  const places = buildPlaces(scene, collision, lights, terrain);
  const interiors = furnishAll(town.byId, collision, lights, scene);
  const weather = new WeatherFX(engine.renderer, scene, q.rainCount, env, lights);
  for (const g of [town.group, places.group, dressing.group, roads.group]) weather.addOccluders(g);
  weather.forestAt = (x, z) => terrain.surfaceAt(x, z).forest;

  progress(0.9, 'Waiting for the tide');
  await frame();

  const updaters: World['updaters'] = [];
  updaters.push((dt, cam) => {
    terrain.updateShadow(engine.renderer, env.sunDir);
    terrain.update(cam);
    forest.update(cam);
    lights.update(dt, cam.position, env.preExposure);
    sky.dome.position.copy(cam.position);
    scene.environment = sky.envTexture;
  });

  return { data, terrain, sky, env, texgen, forest, roads, collision, water: { flats, river, sea, normal: waterTex.normal }, town, lights, dressing, places, interiors, weather, exclusions, updaters };
}
