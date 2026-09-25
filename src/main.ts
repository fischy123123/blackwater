import * as THREE from 'three';
import { Engine } from './core/Engine';
import { buildWorld } from './game/WorldBuilder';
import { Game } from './game/Game';
import { WEATHER_PRESETS } from './world/Environment';

declare global {
  interface Window {
    __bw: Record<string, unknown>;
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const app = document.getElementById('app')!;
  const engine = new Engine(app, params.get('q'));
  const loading = document.createElement('div');
  loading.style.cssText = 'position:fixed;left:0;right:0;bottom:12%;text-align:center;font:14px Spectral,serif;letter-spacing:.2em;color:#cfc8bb;opacity:.8';
  document.body.appendChild(loading);
  const t0 = performance.now();
  const world = await buildWorld(engine, (p, label) => {
    loading.textContent = `${label.toUpperCase()} · ${Math.round(p * 100)}%`;
  });
  loading.remove();
  console.log(`world built in ${(performance.now() - t0).toFixed(0)}ms, tier ${engine.quality.tier}, trees ${world.forest.trees.length}`);
  const game = new Game(engine, world);

  const time = Number(params.get('time') ?? 15.5);
  world.env.snap(time, (params.get('weather') ?? 'golden') as keyof typeof WEATHER_PRESETS);
  const cam = params.get('cam');
  if (cam) {
    const c = cam.split(',').map(Number);
    engine.camera.position.set(c[0], c[1], c[2]);
    game.setFly(true, Number(params.get('yaw') ?? 180), Number(params.get('pitch') ?? 0));
  } else {
    const at = (params.get('at') ?? '-176,-422').split(',').map(Number);
    game.player.teleport(at[0], null, at[1], Number(params.get('yaw') ?? 190), Number(params.get('pitch') ?? -4));
    game.input.wantsLock = true;
  }
  if (params.has('fly')) game.setFly(true);
  world.sky.camPos.copy(engine.camera.position);
  engine.pipeline.fade = 0;

  window.__bw = {
    engine,
    world,
    game,
    env: world.env,
    sky: world.sky,
    terrain: world.terrain,
    steps(n: number, dt = 1 / 30) {
      for (let i = 0; i < n; i++) engine.step(dt);
    },
    info() {
      return { ...engine.renderer.info.render, tier: engine.quality.tier, pos: engine.camera.position.toArray().map((v) => +v.toFixed(1)) };
    },
    THREE,
  };
  // Initialise lighting/sky uniforms once, then fill every cube face.
  engine.camera.updateMatrixWorld();
  world.env.update(1 / 60, engine.camera);
  world.sky.renderAll();
  world.terrain.updateShadow(engine.renderer, world.env.sunDir, true);
  if (params.has('manual')) {
    engine.fixedDt = 1 / 30;
    (window.__bw as { ready?: boolean }).ready = true;
  } else {
    engine.start();
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f88;padding:20px;white-space:pre-wrap">${String(e?.stack ?? e)}</pre>`;
});
