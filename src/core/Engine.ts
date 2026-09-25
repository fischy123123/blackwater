import * as THREE from 'three';
import { Pipeline } from '../render/Pipeline';
import { installGlobalChunks } from '../render/Chunks';
import { U } from '../render/Globals';
import { detectQuality, DynamicResolution, type QualitySettings } from './Quality';

export interface System {
  update(dt: number, time: number): void;
}

export class Engine {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  pipeline: Pipeline;
  quality: QualitySettings;
  dynres: DynamicResolution;
  systems: System[] = [];
  lateSystems: System[] = [];
  time = 0;
  frame = 0;
  paused = false;
  timeScale = 1;
  private last = 0;
  private running = false;
  onBeforeRender: ((dt: number) => void) | null = null;
  fixedDt: number | null = null; // for deterministic screenshots
  fpsSmoothed = 60;

  constructor(container: HTMLElement, qualityOverride?: string | null) {
    installGlobalChunks();
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game';
    container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.quality = detectQuality(gl, qualityOverride);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = true;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.12, 22000);
    this.camera.layers.enable(0);
    this.scene.add(this.camera);
    this.scene.fog = new THREE.FogExp2(0x000000, 0.0001); // enables USE_FOG; colours come from Globals
    this.scene.matrixWorldAutoUpdate = true;

    this.pipeline = new Pipeline(this.renderer, this.quality.msaa);
    this.dynres = new DynamicResolution(this.quality);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const pr = this.quality.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const s = this.dynres.scale;
    this.pipeline.setSize(buf.x * s, buf.y * s);
    this.camera.aspect = w / h;
    // Wider vertical FOV in portrait so phones still see the world
    const portrait = h > w;
    this.camera.fov = portrait ? 80 : 66;
    this.camera.updateProjectionMatrix();
  }

  add(s: System) {
    this.systems.push(s);
    return s;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      let dt = (now - this.last) / 1000;
      this.last = now;
      if (this.fixedDt !== null) dt = this.fixedDt;
      dt = Math.min(dt, 0.1);
      this.step(dt);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  step(rawDt: number) {
    const dt = this.paused ? 0 : rawDt * this.timeScale;
    this.time += dt;
    this.frame++;
    this.fpsSmoothed = this.fpsSmoothed * 0.95 + (1 / Math.max(rawDt, 1e-3)) * 0.05;
    U.uTime.value = this.time;
    for (const s of this.systems) s.update(dt, this.time);
    this.onBeforeRender?.(dt);
    this.pipeline.render(this.scene, this.camera, this.time, Math.max(rawDt, 1e-3));
    for (const s of this.lateSystems) s.update(dt, this.time);
    if (this.fixedDt === null && this.dynres.sample(rawDt)) this.resize();
  }
}
