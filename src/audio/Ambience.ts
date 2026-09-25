// Environmental soundscape driven by weather, time of day, location and story state.
import * as THREE from 'three';
import { audio, type AudioEngine } from './AudioEngine';
import { clamp, smoothstep } from '../core/math';

type Loop = { src: AudioBufferSourceNode; gain: GainNode; filter?: BiquadFilterNode; panner?: PannerNode };

export type AmbienceState = {
  wind: number;
  gust: number;
  rain: number;
  inside: number; // 0..1
  forest: number; // tree density around listener
  night: number; // 0 day .. 1 night
  dusk: number; // golden/blue hour
  nearWater: number;
  seaReturn: number; // finale: roar of the returning sea
  hum: number; // the low note from the sea
  indoorRoom: number; // small room reverb amount
  underwater: number;
};

export class Ambience {
  a: AudioEngine = audio;
  private loops: Record<string, Loop> = {};
  private started = false;
  private birdT = 2;
  private gullT = 5;
  private crowT = 20;
  private owlT = 30;
  private riverPts: THREE.Vector3[] = [];
  private riverPanner: PannerNode | null = null;
  private fallPanner: PannerNode | null = null;
  private humOsc: OscillatorNode[] = [];
  private humGain: GainNode | null = null;
  private seaPanner: PannerNode | null = null;
  state: AmbienceState = { wind: 0.3, gust: 0, rain: 0, inside: 0, forest: 0, night: 0, dusk: 0, nearWater: 0, seaReturn: 0, hum: 0, indoorRoom: 0, underwater: 0 };
  hums: { panner: PannerNode; gain: GainNode; pos: THREE.Vector3; level: number }[] = [];
  birdSpots: () => THREE.Vector3 | null = () => null;
  gullSpots: () => THREE.Vector3 | null = () => null;
  waterfall = new THREE.Vector3();

  setRiver(pts: THREE.Vector3[], waterfall: THREE.Vector3) {
    this.riverPts = pts;
    this.waterfall.copy(waterfall);
  }

  start() {
    const a = this.a;
    if (!a.ctx || this.started) return;
    this.started = true;
    const ctx = a.ctx;
    const mkLoop = (buf: AudioBuffer, bus: AudioNode, filter?: BiquadFilterNode, panner?: PannerNode): Loop => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      let n: AudioNode = src;
      if (filter) {
        n.connect(filter);
        n = filter;
      }
      if (panner) {
        n.connect(panner);
        n = panner;
      }
      n.connect(gain).connect(bus);
      src.start(0, Math.random() * 2);
      return { src, gain, filter, panner };
    };
    // wind: low roar + gusty band + leaf rustle
    this.loops.windLow = mkLoop(a.brown, a.amb, a.filter('lowpass', 380, 0.5));
    this.loops.windBand = mkLoop(a.pink, a.amb, a.filter('bandpass', 700, 0.9));
    this.loops.rustle = mkLoop(a.white, a.amb, a.filter('highpass', 2200, 0.5));
    this.loops.whistle = mkLoop(a.white, a.amb, a.filter('bandpass', 1650, 18));
    // rain
    this.loops.rain = mkLoop(a.buffers.get('rain')!, a.amb, a.filter('highpass', 350, 0.5));
    this.loops.rainHiss = mkLoop(a.pink, a.amb, a.filter('highpass', 1200, 0.4));
    this.loops.roof = mkLoop(a.buffers.get('roofRain')!, a.sfx, a.filter('lowpass', 2500, 0.5));
    // crickets
    this.loops.crickets = mkLoop(a.buffers.get('crickets')!, a.amb);
    // river & waterfall (positional)
    this.riverPanner = a.panner(new THREE.Vector3(), 12, 1.2);
    this.loops.river = mkLoop(a.buffers.get('river')!, a.amb, a.filter('lowpass', 5000, 0.5), this.riverPanner);
    this.loops.riverHiss = mkLoop(a.pink, a.amb, a.filter('bandpass', 900, 0.6), (() => {
      const p = a.panner(new THREE.Vector3(), 12, 1.2);
      return p;
    })());
    this.fallPanner = a.panner(this.waterfall, 25, 1.0);
    this.loops.falls = mkLoop(a.brown, a.amb, a.filter('lowpass', 1400, 0.5), this.fallPanner);
    this.loops.fallsHiss = mkLoop(a.pink, a.amb, a.filter('bandpass', 2200, 0.5), a.panner(this.waterfall, 25, 1.0));
    // the returning sea / surf (positional from the south)
    this.seaPanner = a.panner(new THREE.Vector3(0, 0, 1200), 200, 0.5);
    this.loops.sea = mkLoop(a.brown, a.amb, a.filter('lowpass', 700, 0.5), this.seaPanner);
    this.loops.seaHiss = mkLoop(a.pink, a.amb, a.filter('bandpass', 1400, 0.5), a.panner(new THREE.Vector3(0, 0, 1200), 200, 0.5));
    // the hum: beating low partials
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    const humPan = a.panner(new THREE.Vector3(-190, 20, 1400), 400, 0.3);
    humPan.connect(this.humGain).connect(a.amb);
    for (const [f, g] of [
      [41.2, 0.5],
      [41.6, 0.4],
      [82.4, 0.25],
      [123.9, 0.1],
      [164.6, 0.05],
    ] as [number, number][]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(humPan);
      o.start();
      this.humOsc.push(o);
    }
  }

  /** Positional electrical hum (transformer, fluorescent tubes...). */
  addHum(pos: THREE.Vector3, freq = 60, ref = 4): number {
    const a = this.a;
    if (!a.ctx) return -1;
    const ctx = a.ctx;
    const p = a.panner(pos, ref, 1.4);
    const g = ctx.createGain();
    g.gain.value = 0;
    p.connect(g).connect(a.sfx);
    for (const [m, amp] of [
      [1, 0.4],
      [2, 0.3],
      [3, 0.12],
      [5, 0.05],
    ] as [number, number][]) {
      const o = ctx.createOscillator();
      o.frequency.value = freq * m;
      o.type = m === 5 ? 'square' : 'sine';
      const og = ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(p);
      o.start();
    }
    this.hums.push({ panner: p, gain: g, pos: pos.clone(), level: 0 });
    return this.hums.length - 1;
  }

  setHum(i: number, level: number) {
    if (i >= 0 && this.hums[i]) this.hums[i].level = level;
  }

  update(dt: number, listener: THREE.Vector3) {
    const a = this.a;
    if (!a.ctx || !this.started) return;
    const t = a.now;
    const s = this.state;
    const L = this.loops;
    const set = (l: Loop | undefined, v: number, tc = 0.3) => l && l.gain.gain.setTargetAtTime(v, t, tc);
    const out = 1 - s.inside * 0.85;
    // wind
    const w = s.wind * (0.6 + 0.4 * s.gust);
    set(L.windLow, (0.1 + w * 0.55) * (1 - s.inside * 0.6));
    L.windLow.filter!.frequency.setTargetAtTime(220 + w * 520, t, 0.5);
    set(L.windBand, w * w * 0.16 * out);
    L.windBand.filter!.frequency.setTargetAtTime(450 + s.gust * 900, t, 0.8);
    set(L.rustle, (0.012 + w * 0.07) * (0.2 + s.forest) * out);
    set(L.whistle, smoothstep(0.7, 1, w) * 0.025 * (0.3 + s.inside));
    // rain
    set(L.rain, s.rain * 0.55 * out, 0.8);
    set(L.rainHiss, s.rain * s.rain * 0.05 * out, 0.8);
    set(L.roof, s.rain * s.inside * 0.7, 0.5);
    // crickets: dusk and dry nights
    set(L.crickets, smoothstep(0.2, 0.8, s.dusk + s.night) * (1 - s.rain) * 0.35 * out * (1 - s.seaReturn), 2);
    // river: position on the nearest river point
    if (this.riverPts.length && this.riverPanner) {
      let best = this.riverPts[0],
        bd = Infinity;
      for (const p of this.riverPts) {
        const d = p.distanceToSquared(listener);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      a.setPos(this.riverPanner, best);
      const near = 1 - smoothstep(20, 160, Math.sqrt(bd));
      set(L.river, near * 0.55);
      set(L.riverHiss, near * 0.25);
      if (L.riverHiss.panner) a.setPos(L.riverHiss.panner, best);
    }
    const df = listener.distanceTo(this.waterfall);
    set(L.falls, (1 - smoothstep(30, 380, df)) * 0.9);
    set(L.fallsHiss, (1 - smoothstep(20, 250, df)) * 0.35);
    // returning sea
    set(L.sea, s.seaReturn * 1.2, 0.8);
    set(L.seaHiss, s.seaReturn * 0.5, 0.8);
    if (this.seaPanner) a.setPos(this.seaPanner, new THREE.Vector3(listener.x, 0, Math.max(listener.z + 120, 900)));
    if (L.seaHiss?.panner) a.setPos(L.seaHiss.panner, new THREE.Vector3(listener.x, 0, Math.max(listener.z + 120, 900)));
    // hum
    if (this.humGain) this.humGain.gain.setTargetAtTime(s.hum * 0.9, t, 1.5);
    // electrical hums
    for (const h of this.hums) {
      const d = h.pos.distanceTo(listener);
      h.gain.gain.setTargetAtTime(d < 60 ? h.level * 0.15 : 0, t, 0.4);
    }
    // indoor muffling + reverb
    a.ambFilter.frequency.setTargetAtTime(20000 - s.inside * 19100, t, 0.25);
    a.sendSmall.gain.setTargetAtTime(s.indoorRoom * 0.35, t, 0.3);
    a.sendLarge.gain.setTargetAtTime(0.22 * (1 - s.inside), t, 0.3);

    // creatures ------------------------------------------------------------
    const day = 1 - s.night;
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 1.5 + Math.random() * 5;
      if (s.rain < 0.1 && day > 0.4 && s.seaReturn < 0.1) {
        const p = this.birdSpots();
        if (p) a.birdPhrase(p, 0.06 + 0.06 * Math.random() * s.dusk + 0.04);
      }
    }
    this.gullT -= dt;
    if (this.gullT <= 0) {
      this.gullT = 4 + Math.random() * 10;
      if (s.rain < 0.3 && day > 0.5) {
        const p = this.gullSpots();
        if (p) a.gull(p, 0.2);
      }
    }
    this.crowT -= dt;
    if (this.crowT <= 0) {
      this.crowT = 25 + Math.random() * 40;
      if (day > 0.5 && s.rain < 0.2) {
        const p = listener.clone().add(new THREE.Vector3((Math.random() - 0.5) * 120, 15, (Math.random() - 0.5) * 120));
        a.crow(p);
      }
    }
    this.owlT -= dt;
    if (this.owlT <= 0) {
      this.owlT = 30 + Math.random() * 50;
      if (s.night > 0.7 && s.rain < 0.1) {
        const p = listener.clone().add(new THREE.Vector3((Math.random() - 0.5) * 200, 20, -60 - Math.random() * 100));
        a.owl(p);
      }
    }
    void clamp;
  }
}

export const ambience = new Ambience();
