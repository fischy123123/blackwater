// Procedural audio: everything is synthesised at runtime with WebAudio.
import * as THREE from 'three';

export type SurfaceSound = 'grass' | 'forest' | 'gravel' | 'asphalt' | 'mud' | 'sand' | 'water' | 'wood' | 'concrete' | 'metal' | 'carpet' | 'rock';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  amb!: GainNode;
  music!: GainNode;
  radio!: GainNode;
  ui!: GainNode;
  ambFilter!: BiquadFilterNode; // occlusion for outdoor ambience when inside
  reverbSmall!: ConvolverNode;
  reverbLarge!: ConvolverNode;
  sendSmall!: GainNode;
  sendLarge!: GainNode;
  white!: AudioBuffer;
  pink!: AudioBuffer;
  brown!: AudioBuffer;
  buffers = new Map<string, AudioBuffer>();
  started = false;
  volume = 0.9;
  hrtf = true;
  private listenerPos = new THREE.Vector3();

  async start() {
    if (this.started) {
      await this.ctx?.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);
    const bus = () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.sfx = bus();
    this.music = bus();
    this.radio = bus();
    this.ui = bus();
    this.amb = ctx.createGain();
    this.ambFilter = ctx.createBiquadFilter();
    this.ambFilter.type = 'lowpass';
    this.ambFilter.frequency.value = 20000;
    this.amb.connect(this.ambFilter).connect(this.master);
    this.music.gain.value = 0.55;
    // reverbs
    this.reverbSmall = ctx.createConvolver();
    this.reverbSmall.buffer = this.impulse(0.7, 2.5, 0.3);
    this.reverbLarge = ctx.createConvolver();
    this.reverbLarge.buffer = this.impulse(3.2, 1.8, 0.12);
    this.sendSmall = ctx.createGain();
    this.sendLarge = ctx.createGain();
    this.sendSmall.gain.value = 0;
    this.sendLarge.gain.value = 0.25;
    this.sendSmall.connect(this.reverbSmall).connect(this.master);
    this.sendLarge.connect(this.reverbLarge).connect(this.master);
    // noise
    const len = ctx.sampleRate * 4;
    this.white = ctx.createBuffer(2, len, ctx.sampleRate);
    this.pink = ctx.createBuffer(2, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const w = this.white.getChannelData(ch),
        p = this.pink.getChannelData(ch),
        br = this.brown.getChannelData(ch);
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b3 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0,
        last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        w[i] = white;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
        last = (last + 0.02 * white) / 1.02;
        br[i] = last * 3.5;
      }
    }
    this.buildBuffers();
    this.started = true;
    await ctx.resume();
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.now, 0.1);
  }

  /** Exponential-decay stereo impulse response with early reflections. */
  impulse(seconds: number, decay: number, early: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (t < 0.002 ? 0 : 1);
      }
      // early reflections
      for (let k = 0; k < 8; k++) {
        const pos = Math.floor(rand(0.005, 0.08) * ctx.sampleRate);
        if (pos < len) d[pos] += (Math.random() < 0.5 ? -1 : 1) * early * rand(0.4, 1);
      }
    }
    return b;
  }

  /** Pre-rendered procedural textures (loops). */
  private buildBuffers() {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const mk = (sec: number, fill: (L: Float32Array, R: Float32Array, n: number) => void) => {
      const n = Math.floor(sr * sec);
      const b = ctx.createBuffer(2, n, sr);
      fill(b.getChannelData(0), b.getChannelData(1), n);
      return b;
    };
    // Rain patter: thousands of tiny droplets
    this.buffers.set(
      'rain',
      mk(6, (L, R, n) => {
        const drops = Math.floor(6 * 900);
        for (let k = 0; k < drops; k++) {
          const at = Math.floor(Math.random() * n);
          const f = rand(1500, 7000);
          const dec = rand(0.002, 0.012);
          const amp = rand(0.02, 0.12) * (Math.random() < 0.05 ? 3 : 1);
          const pan = Math.random();
          const len = Math.floor(dec * 6 * sr);
          for (let i = 0; i < len && at + i < n; i++) {
            const t = i / sr;
            const v = Math.sin(2 * Math.PI * f * t * (1 - t * 20)) * Math.exp(-t / dec) * amp + (Math.random() * 2 - 1) * Math.exp(-t / (dec * 0.3)) * amp * 0.5;
            L[at + i] += v * (1 - pan);
            R[at + i] += v * pan;
          }
        }
      }),
    );
    // Rain on a roof: heavier, lower thumps
    this.buffers.set(
      'roofRain',
      mk(5, (L, R, n) => {
        for (let k = 0; k < 5 * 500; k++) {
          const at = Math.floor(Math.random() * n);
          const f = rand(250, 1400);
          const dec = rand(0.006, 0.03);
          const amp = rand(0.03, 0.12);
          const pan = Math.random();
          const len = Math.floor(dec * 6 * sr);
          for (let i = 0; i < len && at + i < n; i++) {
            const t = i / sr;
            const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / dec) * amp;
            L[at + i] += v * (1 - pan);
            R[at + i] += v * pan;
          }
        }
      }),
    );
    // Crickets: pulsed high chirps from a few individuals
    this.buffers.set(
      'crickets',
      mk(8, (L, R, n) => {
        for (let c = 0; c < 6; c++) {
          const f = rand(3800, 5200);
          const rate = rand(1.2, 2.6);
          const pan = Math.random();
          const amp = rand(0.02, 0.06);
          const phase = Math.random();
          for (let i = 0; i < n; i++) {
            const t = i / sr;
            const chirp = (t * rate + phase) % 1;
            if (chirp > 0.25) continue;
            const pulse = Math.sin(2 * Math.PI * 30 * t) > 0 ? 1 : 0.2;
            const env = Math.sin((chirp / 0.25) * Math.PI);
            const v = Math.sin(2 * Math.PI * f * t) * env * pulse * amp;
            L[i] += v * (1 - pan);
            R[i] += v * pan;
          }
        }
      }),
    );
    // Brook: bubbling blips over noise
    this.buffers.set(
      'river',
      mk(6, (L, R, n) => {
        for (let k = 0; k < 6 * 180; k++) {
          const at = Math.floor(Math.random() * n);
          const f0 = rand(300, 1500);
          const dec = rand(0.01, 0.05);
          const amp = rand(0.04, 0.14);
          const pan = Math.random();
          const len = Math.floor(dec * 5 * sr);
          for (let i = 0; i < len && at + i < n; i++) {
            const t = i / sr;
            const v = Math.sin(2 * Math.PI * f0 * (1 + t * 12) * t) * Math.exp(-t / dec) * amp;
            L[at + i] += v * (1 - pan);
            R[at + i] += v * pan;
          }
        }
      }),
    );
  }

  // ------------------------------------------------------------------ helpers
  noise(kind: 'white' | 'pink' | 'brown' = 'white', loop = true) {
    const s = this.ctx!.createBufferSource();
    s.buffer = kind === 'white' ? this.white : kind === 'pink' ? this.pink : this.brown;
    s.loop = loop;
    s.loopStart = Math.random() * 3;
    return s;
  }

  filter(type: BiquadFilterType, freq: number, Q = 0.7) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = Q;
    return f;
  }

  gain(v = 1) {
    const g = this.ctx!.createGain();
    g.gain.value = v;
    return g;
  }

  panner(pos: THREE.Vector3, ref = 4, rolloff = 1, maxDist = 1000) {
    const p = this.ctx!.createPanner();
    p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = maxDist;
    this.setPos(p, pos);
    return p;
  }

  setPos(p: PannerNode, pos: THREE.Vector3) {
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else (p as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(pos.x, pos.y, pos.z);
  }

  updateListener(cam: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = cam.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    this.listenerPos.copy(p);
    const t = this.now;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02);
      l.forwardY.setTargetAtTime(f.y, t, 0.02);
      l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.setTargetAtTime(u.x, t, 0.02);
      l.upY.setTargetAtTime(u.y, t, 0.02);
      l.upZ.setTargetAtTime(u.z, t, 0.02);
    } else {
      const ll = l as unknown as { setPosition: (...a: number[]) => void; setOrientation: (...a: number[]) => void };
      ll.setPosition(p.x, p.y, p.z);
      ll.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  /** Route a node to a bus with optional reverb sends and optional 3D position. */
  out(node: AudioNode, opts: { bus?: GainNode; pos?: THREE.Vector3; ref?: number; rolloff?: number; wet?: number; wetLarge?: number } = {}): AudioNode {
    let last: AudioNode = node;
    if (opts.pos) {
      const p = this.panner(opts.pos, opts.ref ?? 4, opts.rolloff ?? 1);
      node.connect(p);
      last = p;
    }
    last.connect(opts.bus ?? this.sfx);
    if (opts.wet) {
      const s = this.gain(opts.wet);
      last.connect(s).connect(this.sendSmall);
    }
    if (opts.wetLarge) {
      const s = this.gain(opts.wetLarge);
      last.connect(s).connect(this.sendLarge);
    }
    return last;
  }

  /** Short filtered noise burst. */
  burst(opts: {
    type?: 'white' | 'pink' | 'brown';
    f: number;
    q?: number;
    ftype?: BiquadFilterType;
    attack?: number;
    decay: number;
    gain: number;
    when?: number;
    pos?: THREE.Vector3;
    fEnd?: number;
    bus?: GainNode;
    wet?: number;
    wetLarge?: number;
    rate?: number;
  }) {
    const ctx = this.ctx!;
    const t = opts.when ?? this.now;
    const src = this.noise(opts.type ?? 'white', false);
    src.playbackRate.value = opts.rate ?? 1;
    const f = this.filter(opts.ftype ?? 'bandpass', opts.f, opts.q ?? 1);
    if (opts.fEnd) f.frequency.exponentialRampToValueAtTime(opts.fEnd, t + opts.decay);
    const g = ctx.createGain();
    const a = opts.attack ?? 0.002;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + opts.decay);
    src.connect(f).connect(g);
    this.out(g, { bus: opts.bus, pos: opts.pos, wet: opts.wet, wetLarge: opts.wetLarge });
    src.start(t, Math.random() * 3);
    src.stop(t + a + opts.decay + 0.05);
  }

  tone(opts: { f: number; type?: OscillatorType; attack?: number; decay: number; gain: number; when?: number; fEnd?: number; pos?: THREE.Vector3; bus?: GainNode; wet?: number; wetLarge?: number; hold?: number }) {
    const ctx = this.ctx!;
    const t = opts.when ?? this.now;
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.f, t);
    if (opts.fEnd) o.frequency.exponentialRampToValueAtTime(opts.fEnd, t + (opts.hold ?? 0) + opts.decay);
    const g = ctx.createGain();
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.gain, t + a);
    if (opts.hold) g.gain.setValueAtTime(opts.gain, t + a + opts.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + (opts.hold ?? 0) + opts.decay);
    o.connect(g);
    this.out(g, { bus: opts.bus, pos: opts.pos, wet: opts.wet, wetLarge: opts.wetLarge });
    o.start(t);
    o.stop(t + a + (opts.hold ?? 0) + opts.decay + 0.05);
    return o;
  }

  // ------------------------------------------------------------------ one-shots
  footstep(s: SurfaceSound, k: number, pos?: THREE.Vector3, inside = 0) {
    if (!this.ctx) return;
    const t = this.now;
    const g = 0.5 * k + 0.12;
    const wet = inside * 0.5;
    const heel = () => this.tone({ f: rand(55, 80), decay: 0.06, gain: 0.25 * g, fEnd: 40, wet });
    switch (s) {
      case 'grass':
        this.burst({ type: 'pink', f: rand(2200, 3200), q: 0.6, ftype: 'highpass', decay: rand(0.09, 0.14), attack: 0.02, gain: 0.16 * g });
        this.burst({ type: 'white', f: rand(4000, 6000), q: 0.8, decay: 0.06, attack: 0.015, gain: 0.05 * g, when: t + 0.03 });
        heel();
        break;
      case 'forest':
        this.burst({ type: 'pink', f: rand(900, 1400), q: 0.8, decay: rand(0.08, 0.12), gain: 0.2 * g });
        for (let i = 0; i < 6; i++) this.burst({ type: 'white', f: rand(2500, 5000), q: 3, decay: 0.012, gain: 0.08 * g, when: t + rand(0, 0.07) });
        if (Math.random() < 0.08) this.burst({ type: 'white', f: rand(1800, 3000), q: 4, decay: 0.03, gain: 0.3 * g, when: t + 0.04 });
        heel();
        break;
      case 'gravel':
        for (let i = 0; i < 16; i++) this.burst({ type: 'white', f: rand(1800, 6000), q: 2.5, decay: rand(0.006, 0.02), gain: rand(0.06, 0.14) * g, when: t + rand(0, 0.09) });
        heel();
        break;
      case 'asphalt':
      case 'rock':
        this.burst({ type: 'pink', f: rand(1100, 1600), q: 1.2, decay: 0.05, gain: 0.18 * g });
        this.burst({ type: 'white', f: rand(3000, 4500), q: 1.5, decay: 0.03, gain: 0.05 * g, when: t + 0.05 });
        heel();
        break;
      case 'concrete':
        this.burst({ type: 'pink', f: rand(1300, 1900), q: 1.4, decay: 0.045, gain: 0.2 * g, wet: 0.6 });
        heel();
        break;
      case 'wood':
        this.burst({ type: 'pink', f: rand(160, 230), q: 3.5, decay: rand(0.12, 0.18), gain: 0.55 * g, wet: wet + 0.2 });
        this.burst({ type: 'white', f: rand(900, 1300), q: 1.5, decay: 0.04, gain: 0.08 * g, wet });
        if (Math.random() < 0.12) this.creak(0.12 * g, 0.35);
        break;
      case 'carpet':
        this.burst({ type: 'pink', f: 400, q: 0.7, ftype: 'lowpass', decay: 0.08, gain: 0.18 * g });
        break;
      case 'mud':
        this.burst({ type: 'brown', f: rand(350, 500), q: 3, decay: rand(0.12, 0.2), gain: 0.5 * g, fEnd: rand(160, 220) });
        this.burst({ type: 'white', f: rand(1500, 2400), q: 2, decay: 0.05, gain: 0.05 * g, when: t + 0.08 });
        break;
      case 'sand':
        this.burst({ type: 'pink', f: rand(1400, 2000), q: 0.5, ftype: 'highpass', decay: 0.12, attack: 0.02, gain: 0.12 * g });
        heel();
        break;
      case 'water':
        this.burst({ type: 'white', f: rand(1200, 2000), q: 0.7, decay: rand(0.15, 0.25), attack: 0.01, gain: 0.3 * g, fEnd: 700 });
        for (let i = 0; i < 4; i++) this.tone({ f: rand(600, 1400), decay: 0.04, gain: 0.03 * g, when: t + rand(0.05, 0.25), fEnd: rand(1500, 2500) });
        break;
      case 'metal':
        for (const f of [420, 1130, 1970]) this.tone({ f: f * rand(0.95, 1.05), decay: rand(0.2, 0.5), gain: 0.05 * g, wet: 0.3 });
        heel();
        break;
    }
  }

  creak(gain = 0.2, dur = 0.8, pos?: THREE.Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = rand(55, 90);
    o.frequency.setValueAtTime(base, t);
    // stick-slip jitter
    for (let i = 0; i < 12; i++) o.frequency.setValueAtTime(base * rand(0.7, 1.5), t + (i / 12) * dur);
    const f1 = this.filter('bandpass', rand(500, 800), 8);
    const f2 = this.filter('bandpass', rand(1300, 1900), 10);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.05);
    g.gain.setValueAtTime(gain, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    this.out(g, { pos, wet: 0.4 });
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  door(kind: 'open' | 'close' | 'locked', pos?: THREE.Vector3) {
    if (!this.ctx) return;
    const t = this.now;
    if (kind === 'locked') {
      for (let i = 0; i < 3; i++) this.burst({ type: 'white', f: 2400, q: 4, decay: 0.03, gain: 0.25, when: t + i * 0.09, pos, wet: 0.3 });
      this.burst({ type: 'pink', f: 180, q: 2, decay: 0.12, gain: 0.3, when: t + 0.05, pos });
      return;
    }
    this.burst({ type: 'white', f: 3000, q: 3, decay: 0.03, gain: 0.3, pos, wet: 0.3 }); // latch
    if (kind === 'open') this.creak(0.14, rand(0.7, 1.2), pos);
    else this.burst({ type: 'pink', f: 120, q: 1.5, decay: 0.25, gain: 0.6, when: t + 0.02, pos, wet: 0.5 });
  }

  clunk(pos?: THREE.Vector3, gain = 0.7) {
    if (!this.ctx) return;
    const t = this.now;
    this.tone({ f: 75, decay: 0.12, gain: gain * 0.6, fEnd: 45, pos, wet: 0.5 });
    this.burst({ type: 'white', f: 1800, q: 1.2, decay: 0.05, gain: gain * 0.4, pos, wet: 0.5 });
    this.burst({ type: 'white', f: 4200, q: 3, decay: 0.02, gain: gain * 0.2, when: t + 0.03, pos });
  }

  click(pos?: THREE.Vector3, gain = 0.25) {
    this.burst({ type: 'white', f: 3500, q: 2, decay: 0.015, gain, pos });
  }

  paper() {
    if (!this.ctx) return;
    const t = this.now;
    this.burst({ type: 'white', f: 3000, q: 0.5, decay: 0.25, attack: 0.05, gain: 0.08, bus: this.ui });
    for (let i = 0; i < 8; i++) this.burst({ type: 'white', f: rand(2000, 6000), q: 2, decay: 0.01, gain: 0.05, when: t + rand(0, 0.3), bus: this.ui });
  }

  spark(pos?: THREE.Vector3) {
    if (!this.ctx) return;
    const t = this.now;
    for (let i = 0; i < 10; i++) this.burst({ type: 'white', f: rand(2000, 8000), q: 1, decay: rand(0.005, 0.03), gain: rand(0.1, 0.4), when: t + rand(0, 0.4), pos });
  }

  thunder(delay: number, power: number, dist: number) {
    if (!this.ctx) return;
    const t = this.now + delay;
    const near = dist < 1500;
    if (near) {
      this.burst({ type: 'white', f: 2500, q: 0.5, ftype: 'highpass', decay: 0.4, attack: 0.005, gain: 0.8 * power, when: t, wetLarge: 0.6, bus: this.amb });
      this.burst({ type: 'brown', f: 300, q: 0.7, ftype: 'lowpass', decay: 1.2, attack: 0.01, gain: 1.4 * power, when: t, wetLarge: 0.5, bus: this.amb });
    }
    // rolling rumble made of several swells
    const n = 4 + Math.floor(Math.random() * 4);
    let tt = t + (near ? 0.2 : 0);
    for (let i = 0; i < n; i++) {
      const dur = rand(0.8, 2.4);
      this.burst({
        type: 'brown',
        f: rand(80, 220) * (near ? 1.4 : 1),
        q: 0.6,
        ftype: 'lowpass',
        attack: rand(0.1, 0.4),
        decay: dur,
        gain: rand(0.5, 1.1) * power * (near ? 1 : 0.6),
        when: tt,
        wetLarge: 0.7,
        bus: this.amb,
      });
      tt += rand(0.3, 1.2);
    }
  }

  /** Mechanical telephone bell (two gongs struck at 20 Hz). */
  phoneRing(pos: THREE.Vector3, dur = 1.8) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const g = ctx.createGain();
    g.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 20;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.5;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.35, t + 0.02);
    env.gain.setValueAtTime(0.35, t + dur);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.08);
    for (const f of [1760, 2310, 3470]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = f === 1760 ? 0.5 : 0.25;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    lfo.connect(lfoG).connect(g.gain);
    g.connect(env);
    this.out(env, { pos, ref: 3, wet: 0.2, wetLarge: 0.3 });
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
  }

  /** Church / buoy bell: inharmonic partials with long decay. */
  bell(pos: THREE.Vector3, gain = 0.5, base = 220) {
    if (!this.ctx) return;
    const partials = [
      [0.5, 1.0, 9],
      [1.0, 0.8, 6],
      [1.19, 0.6, 5],
      [1.5, 0.35, 4],
      [2.0, 0.5, 3.5],
      [2.52, 0.25, 2.5],
      [3.0, 0.15, 2],
      [4.07, 0.1, 1.5],
    ];
    for (const [r, a, d] of partials) this.tone({ f: base * r, decay: d, gain: gain * a * 0.3, pos, wetLarge: 0.6, attack: 0.003 });
  }

  /** Lighthouse diaphone: the long groan with the characteristic grunt at the end. */
  foghorn(pos: THREE.Vector3, gain = 0.8) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(146, t);
    o.frequency.setValueAtTime(146, t + 2.4);
    o.frequency.exponentialRampToValueAtTime(96, t + 2.7);
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.setValueAtTime(147.5, t);
    o2.frequency.setValueAtTime(147.5, t + 2.4);
    o2.frequency.exponentialRampToValueAtTime(97, t + 2.7);
    const f = this.filter('lowpass', 700, 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.25);
    g.gain.setValueAtTime(gain, t + 2.5);
    g.gain.linearRampToValueAtTime(gain * 1.2, t + 2.65);
    g.gain.linearRampToValueAtTime(0, t + 3.2);
    o.connect(f);
    o2.connect(f);
    f.connect(g);
    this.out(g, { pos, ref: 60, rolloff: 0.6, wetLarge: 0.9, bus: this.amb });
    o.start(t);
    o2.start(t);
    o.stop(t + 3.3);
    o2.stop(t + 3.3);
  }

  /** Songbird phrase: a few frequency-swept whistles. */
  birdPhrase(pos: THREE.Vector3, gain = 0.12) {
    if (!this.ctx) return;
    const t0 = this.now;
    const notes = 3 + Math.floor(Math.random() * 6);
    const base = rand(2400, 4200);
    let t = t0;
    const style = Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const d = style === 0 ? rand(0.05, 0.1) : style === 1 ? rand(0.12, 0.25) : rand(0.03, 0.06);
      const f0 = base * rand(0.85, 1.2);
      const f1 = f0 * (style === 1 ? rand(0.6, 0.8) : rand(1.1, 1.5));
      this.tone({ f: f0, fEnd: f1, decay: d, attack: 0.01, gain, when: t, pos, wetLarge: 0.35, bus: this.amb });
      t += d + rand(0.02, 0.12);
    }
  }

  gull(pos: THREE.Vector3, gain = 0.25) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = this.now;
    const calls = 1 + Math.floor(Math.random() * 3);
    for (let c = 0; c < calls; c++) {
      const t = t0 + c * rand(0.35, 0.55);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = rand(900, 1200);
      o.frequency.setValueAtTime(f0 * 0.9, t);
      o.frequency.linearRampToValueAtTime(f0 * 1.15, t + 0.06);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.34);
      const f1 = this.filter('bandpass', 1400, 3);
      const f2 = this.filter('bandpass', 2900, 5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      o.connect(f1).connect(g);
      o.connect(f2).connect(g);
      this.out(g, { pos, ref: 20, wetLarge: 0.5, bus: this.amb });
      o.start(t);
      o.stop(t + 0.42);
    }
  }

  owl(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const t = this.now;
    const hoot = (w: number, d: number, f: number) => this.tone({ f, fEnd: f * 0.93, attack: 0.04, decay: d, gain: 0.12, when: t + w, pos, wetLarge: 0.6, bus: this.amb });
    hoot(0, 0.3, 390);
    hoot(0.55, 0.18, 380);
    hoot(0.85, 0.5, 385);
  }

  crow(pos: THREE.Vector3) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = this.now;
    for (let c = 0; c < 2 + Math.floor(Math.random() * 2); c++) {
      const t = t0 + c * 0.45;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(rand(520, 640), t);
      o.frequency.linearRampToValueAtTime(rand(420, 500), t + 0.25);
      const n = this.noise('white', false);
      const nf = this.filter('bandpass', 1500, 1);
      const ng = this.gain(0.4);
      const f = this.filter('bandpass', 1100, 2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(f).connect(g);
      n.connect(nf).connect(ng).connect(g);
      this.out(g, { pos, ref: 12, wetLarge: 0.5, bus: this.amb });
      o.start(t);
      o.stop(t + 0.32);
      n.start(t);
      n.stop(t + 0.32);
    }
  }

  splash(pos: THREE.Vector3, gain = 0.5) {
    this.burst({ type: 'white', f: 1400, q: 0.6, decay: 0.5, attack: 0.01, gain, pos, fEnd: 500 });
  }
}

export const audio = new AudioEngine();
