import * as THREE from 'three';
import { Engine } from './core/Engine';
import { buildWorld } from './game/WorldBuilder';
import { Game } from './game/Game';
import { Story, type Checkpoint } from './game/Story';
import { WEATHER_PRESETS } from './world/Environment';
import { UI } from './ui/UI';
import { audio } from './audio/AudioEngine';
import { damp } from './core/math';

declare global {
  interface Window {
    __bw: Record<string, unknown>;
  }
}

/** Slow establishing shots behind the title screen. */
const TITLE_SHOTS: { from: THREE.Vector3; to: THREE.Vector3; look0: THREE.Vector3; look1: THREE.Vector3; dur: number }[] = [
  { from: new THREE.Vector3(-150, 38, 470), to: new THREE.Vector3(-60, 32, 380), look0: new THREE.Vector3(30, 18, 80), look1: new THREE.Vector3(40, 16, 60), dur: 34 },
  { from: new THREE.Vector3(-420, 70, 380), to: new THREE.Vector3(-380, 62, 430), look0: new THREE.Vector3(-484, 50, 560), look1: new THREE.Vector3(-484, 52, 560), dur: 28 },
  { from: new THREE.Vector3(-250, 158, -540), to: new THREE.Vector3(-205, 150, -500), look0: new THREE.Vector3(-40, 10, 300), look1: new THREE.Vector3(-20, 10, 360), dur: 30 },
];

async function boot() {
  const params = new URLSearchParams(location.search);
  const ui = new UI();
  const app = document.getElementById('app')!;
  const q = params.get('q') ?? (ui.settings.quality !== 'auto' ? ui.settings.quality : null);
  const engine = new Engine(app, q);
  const t0 = performance.now();
  const world = await buildWorld(engine, (p, label) => ui.setProgress(p, label));
  console.log(`world built in ${(performance.now() - t0).toFixed(0)}ms, tier ${engine.quality.tier}, trees ${world.forest.trees.length}`);
  const game = new Game(engine, world, ui);
  const story = new Story(game);
  ui.setTouchUI(game.input.touchMode);

  // settings
  const applySettings = () => {
    game.input.sensitivity = ui.settings.sensitivity;
    game.input.invertY = ui.settings.invertY;
    audio.setVolume(ui.settings.volume);
  };
  ui.onSettings = applySettings;
  applySettings();

  window.__bw = {
    engine,
    world,
    game,
    story,
    ui,
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

  // ------------------------------------------------------------------ debug / screenshot path
  if (params.has('manual')) {
    const cp = params.get('cp') as Checkpoint | null;
    if (cp) {
      story.start(cp);
      ui.hideLoading();
      ui.hud.classList.remove('hidden');
    } else {
      const time = Number(params.get('time') ?? 15.5);
      world.env.snap(time, (params.get('weather') ?? 'golden') as keyof typeof WEATHER_PRESETS);
      game.mode = 'walk';
      ui.hideLoading();
    }
    const cam = params.get('cam');
    if (cam) {
      const c = cam.split(',').map(Number);
      engine.camera.position.set(c[0], c[1], c[2]);
      game.setFly(true, Number(params.get('yaw') ?? 180), Number(params.get('pitch') ?? 0));
    } else if (params.has('at')) {
      const at = params.get('at')!.split(',').map(Number);
      game.player.teleport(at[0], null, at[1], Number(params.get('yaw') ?? 190), Number(params.get('pitch') ?? -4));
    }
    if (params.has('fly')) game.setFly(true);
    world.sky.camPos.copy(engine.camera.position);
    engine.pipeline.fade = 0;
    ui.fade(0, 0);
    primeFrame();
    engine.fixedDt = 1 / 30;
    (window.__bw as { ready?: boolean }).ready = true;
    return;
  }

  function primeFrame() {
    engine.camera.updateMatrixWorld();
    world.env.update(1 / 60, engine.camera);
    world.sky.renderAll();
    world.terrain.updateShadow(engine.renderer, world.env.sunDir, true);
  }

  // ------------------------------------------------------------------ title
  let shot = 0,
    shotT = 0;
  const camLook = new THREE.Vector3();
  const titleCam = (dt: number) => {
    if (game.mode !== 'title') return;
    shotT += dt;
    const s = TITLE_SHOTS[shot];
    if (shotT > s.dur) {
      shotT = 0;
      shot = (shot + 1) % TITLE_SHOTS.length;
      engine.pipeline.fade = 1;
    }
    const k = Math.min(1, shotT / s.dur);
    const e = k * k * (3 - 2 * k);
    const cam = engine.camera;
    cam.position.lerpVectors(s.from, s.to, e);
    camLook.lerpVectors(s.look0, s.look1, e);
    cam.lookAt(camLook);
    cam.fov = 50;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // dip to black between shots
    const edge = Math.min(shotT, s.dur - shotT);
    engine.pipeline.fade = damp(engine.pipeline.fade, edge < 1.2 ? 1 : 0, 3, dt);
  };
  game.onUpdate.unshift(titleCam);
  world.env.snap(15.75, 'golden');
  game.mode = 'title';
  titleCam(0);
  primeFrame();
  engine.pipeline.fade = 1;
  engine.start();
  ui.hideLoading();
  const save = Story.loadSave();
  setTimeout(() => ui.showTitle(!!save), 400);

  let started = false;
  // keyboard / controller can start from the title too
  const titleKeys = (e: KeyboardEvent) => {
    if (game.mode === 'title' && !ui.paused && (e.code === 'Enter' || e.code === 'Space')) ui.onBegin?.(!!save);
  };
  addEventListener('keydown', titleKeys);
  game.onUpdate.push(() => {
    if (game.mode !== 'title' || ui.paused) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && (p.buttons[0]?.pressed || p.buttons[9]?.pressed)) ui.onBegin?.(!!save);
  });
  ui.onBegin = async (cont) => {
    if (started) return;
    started = true;
    // pointer lock must be requested synchronously inside the user gesture
    game.input.wantsLock = !game.input.touchMode;
    if (game.input.wantsLock) game.input.requestLock();
    await audio.start().catch(() => void 0);
    applySettings();
    game.startAudio();
    ui.hideTitle();
    ui.fade(1, 1.2);
    await new Promise((r) => setTimeout(r, 1300));
    engine.pipeline.fade = 0;
    engine.camera.fov = 66;
    engine.camera.updateProjectionMatrix();
    const cp: Checkpoint = cont && save ? save.cp : 'overlook';
    if (cont && save) story.restoreDocs(save.docs);
    else story.clearSave();
    story.start(cp);
    world.sky.renderAll();
    world.terrain.updateShadow(engine.renderer, world.env.sunDir, true);
    engine.pipeline.resetExposure();
    if (game.input.wantsLock && !game.input.pointerLocked) ui.showHint('Click to look around', 4);
  };

  // ------------------------------------------------------------------ pause / notebook / pointer lock
  let wasLocked = false;
  const pause = (on: boolean) => {
    if (on === game.paused) return;
    game.paused = on;
    ui.showPause(on);
    if (on) {
      game.input.exitLock();
      audio.ctx?.suspend().catch(() => void 0);
    } else {
      audio.ctx?.resume().catch(() => void 0);
      if (game.input.wantsLock) game.input.requestLock();
    }
  };
  ui.onResume = () => pause(false);
  ui.onRestart = () => {
    pause(false);
    const s = Story.loadSave();
    story.start(s ? s.cp : 'overlook');
  };
  game.onUpdate.push(() => {
    const inp = game.input;
    if (ui.touchUI !== inp.touchMode) ui.setTouchUI(inp.touchMode);
    if (game.mode === 'title') return;
    const inOverlay = ui.docOpen || ui.panelOpen || ui.notebookOpen;
    // losing pointer lock mid-game (Esc) pauses, unless we released it for a page/panel
    if (wasLocked && !inp.pointerLocked && !inOverlay && !game.paused) pause(true);
    wasLocked = inp.pointerLocked;
    if (inp.consume('pause')) {
      if (ui.docOpen) ui.closeDoc();
      else if (ui.notebookOpen) ui.toggleNotebook(false);
      else pause(!game.paused);
    }
    if (inp.consume('journal')) {
      if (ui.notebookOpen) ui.toggleNotebook(false);
      else if (!ui.docOpen) {
        story.openNotebook();
        inp.exitLock(); // pages in the notebook are clicked
      }
    }
  });
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f88;padding:20px;white-space:pre-wrap">${String(e?.stack ?? e)}</pre>`;
});
