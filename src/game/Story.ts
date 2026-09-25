// The story: beats, interactables, triggers, puzzles, checkpoints.
//
//  overlook (golden hour) -> drive down, tide-station tape on the radio -> roadblock ->
//  the empty town at sunset -> relay hut breaker puzzle -> power returns (blue hour) ->
//  radio: Ruth, then Wren -> storm -> sheriff's key -> drive through the storm to the
//  lighthouse -> restart the lens -> rest -> dawn -> cliff path, the trail across the
//  flats, the fog bank -> the wall -> touch -> the sea lets go -> the tower -> home.
import * as THREE from 'three';
import type { Game } from './Game';
import type { Interactable } from './Interaction';
import { DOCS, drawKidPicture, drawTideChart } from './Documents';
import type { Line } from './Dialogue';
import { RUN_SPEED } from './Player';
import { audio } from '../audio/AudioEngine';
import { ambience } from '../audio/Ambience';
import { music } from '../audio/Music';
import { squelch } from '../audio/Voice';
import { U, LAYER } from '../render/Globals';
import { P, COAST_ROAD, TRAIL } from '../world/Layout';
import { BuildingLights } from '../render/WindowShader';
import { WEATHER_PRESETS } from '../world/Environment';
import { clamp, damp, smoothstep, lerp, DEG, sampleCatmull, RNG } from '../core/math';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export type Checkpoint = 'overlook' | 'town' | 'power' | 'key' | 'lighthouse' | 'dawn' | 'wall';
type Save = { v: 1; cp: Checkpoint; docs: string[] };
const SAVE_KEY = 'blackwater-save-v1';

type Breaker = { id: string; label: string; on: boolean; tag?: string };

export class Story {
  flags: Record<string, boolean> = {};
  docs: string[] = [];
  objective = '';
  cp: Checkpoint = 'overlook';
  onEnd: (() => void) | null = null;
  private timers: { t: number; fn: () => void }[] = [];
  private triggers: { test: () => boolean; fn: () => void }[] = [];
  private items: Interactable[] = [];
  private breakers: Breaker[] = [];
  private lensSpeed = 0;
  private lensAngle = 0;
  private beamLevel = 0;
  private radioBlink = 0;
  private wallT = -1;
  private touchT = -1;
  private collapse = 0;
  private front = { z: 1e6, active: false, speed: 0 };
  private seaLevel = -40;
  private hum = 0;
  private humTarget = 0;
  private seaReturn = 0;
  private bankClear = 0;
  private bankClearTarget = 0;
  private crowd: THREE.InstancedMesh | null = null;
  private crowdData: { x: number; z: number; yaw: number; turn: number; delay: number; s: number }[] = [];
  private crowdFade = 0;
  private spray: THREE.Mesh | null = null;
  private figureMats: THREE.MeshStandardMaterial[] = [];
  private gateCollider: import('../world/Collision').Box | null = null;
  private gateOpen = 0;
  private roadblockSpot = { pos: new THREE.Vector3(), yaw: 0 };
  private gameOverT = -1;
  private tape = 0;
  private phoneT = 0;
  private endT = -1;
  private feederOf = new Map<string, 'f1' | 'f2' | 'f3'>();
  private lastSave = 0;

  constructor(private game: Game) {
    this.computeRoadblockSpot();
    this.setupGate();
    this.setupCrowd();
    this.setupSpray();
    this.assignFeeders();
    this.buildInteractables();
    // figures on the flats fade individually as you approach
    game.world.places.figures.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = (m.material as THREE.MeshStandardMaterial).clone();
      mat.transparent = true;
      m.material = mat;
      this.figureMats.push(mat);
      m.layers.set(LAYER.TRANSPARENT);
    });
    game.canExitTruck = () => true;
    game.onEnterTruck = () => this.onEnterTruck();
    game.onExitTruck = () => this.onExitTruck();
    game.onUpdate.push((dt) => this.update(dt));
  }

  // ======================================================================= helpers
  private get w() {
    return this.game.world;
  }
  private get env() {
    return this.game.world.env;
  }
  private get ui() {
    return this.game.ui;
  }
  private get player() {
    return this.game.player;
  }
  after(t: number, fn: () => void) {
    this.timers.push({ t, fn });
  }
  when(test: () => boolean, fn: () => void) {
    this.triggers.push({ test, fn });
  }
  private say(lines: Line[] | string, done?: () => void) {
    if (typeof lines === 'string') this.game.dialogue.play([{ who: 'thought', text: lines }], done);
    else this.game.dialogue.play(lines, done);
  }
  setObjective(text: string, announce = true) {
    this.objective = text;
    if (announce) this.ui.showCard(`<span style="opacity:.6">—</span> ${text}`, 6);
  }
  private anchor(name: string, dy = 0) {
    const a = this.w.interiors.anchors.get(name);
    return a ? a.pos.clone().add(V(0, dy, 0)) : V(0, -1000, 0);
  }
  private add(i: Interactable) {
    this.items.push(i);
    this.game.interaction.add(i);
    return i;
  }
  private readDoc(id: string) {
    const d = DOCS[id];
    if (!d) return;
    audio.paper();
    this.ui.openDoc(d.html(), d.style);
    if (id === 'drawing') {
      const c = document.getElementById('kid-drawing') as HTMLCanvasElement | null;
      if (c) drawKidPicture(c);
    }
    if (id === 'tideChart') {
      const c = document.getElementById('tide-chart') as HTMLCanvasElement | null;
      if (c) drawTideChart(c);
    }
    this.game.input.enabled = false;
    this.ui.onDocClose = () => {
      this.game.input.enabled = true;
      audio.paper();
    };
    if (!this.docs.includes(id)) {
      this.docs.push(id);
      if (this.docs.length === 1) this.after(1.2, () => this.ui.showHint(this.ui.touchUI ? 'Your notebook (top left) keeps what you’ve read.' : '<b>Tab</b> — notebook. It keeps what you’ve read.', 6));
    }
  }

  notebookHTML() {
    const list = this.docs
      .map((id) => `<li><a href="#" data-doc="${id}">${DOCS[id]?.title ?? id}</a></li>`)
      .join('');
    return `<p style="font-size:14px;letter-spacing:.2em;text-transform:uppercase;opacity:.6;font-family:var(--text)">Now</p><p>${this.objective || '…'}</p>${
      list ? `<p style="font-size:14px;letter-spacing:.2em;text-transform:uppercase;opacity:.6;font-family:var(--text);margin-top:22px">Pages</p><ul class="nb-list">${list}</ul>` : ''
    }`;
  }

  openNotebook() {
    this.ui.toggleNotebook(true, this.notebookHTML());
    this.ui.notebook.querySelectorAll('a[data-doc]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.ui.toggleNotebook(false);
        this.readDoc((a as HTMLElement).dataset.doc!);
      }),
    );
  }

  // ======================================================================= setup
  private computeRoadblockSpot() {
    const pts = sampleCatmull(COAST_ROAD, 2).map((p) => V(p.x, p.y, p.z));
    let bi = 0,
      bd = Infinity;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - P.roadblock.x, p.z - P.roadblock.z);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const i = Math.max(1, bi - 11); // ~22 m uphill of the fallen tree
    const p = pts[i],
      q = pts[i + 1];
    this.roadblockSpot.pos.copy(p);
    // truck forward (+x local) along the road, downhill
    this.roadblockSpot.yaw = Math.atan2(-(q.z - p.z), q.x - p.x);
  }

  private setupGate() {
    const g = this.w.places.lhGate;
    const c = this.w.collision;
    const mid = g.pos.clone().add(V(Math.cos(g.yaw) * 2.65, 0, -Math.sin(g.yaw) * 2.65));
    // the bar itself plus the boulder lines either side: no driving round it
    this.gateCollider = c.add({ kind: 'box', x: mid.x, z: mid.z, hw: 2.7, hd: 0.15, rot: -g.yaw, y0: g.pos.y - 1, y1: g.pos.y + 1.3, walkable: false, dynamic: true, tag: 'gate' }) as import('../world/Collision').Box;
    const dir = V(Math.cos(g.yaw), 0, -Math.sin(g.yaw));
    for (const [s0, s1] of [
      [-12, -0.1],
      [5.4, 17.5],
    ]) {
      const cm = g.pos.clone().addScaledVector(dir, (s0 + s1) / 2);
      c.box(cm.x, cm.z, s1 - s0, 0.6, -g.yaw, g.pos.y - 4, g.pos.y + 1.2, false, 'rock');
    }
    c.updateBox(this.gateCollider);
  }

  private setupCrowd() {
    // the town, standing at the foot of the wall
    const merged = personGeometry();
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b0c0d, roughness: 0.95, transparent: true, opacity: 1 });
    const rng = new RNG(1017);
    const n = 64;
    this.crowd = new THREE.InstancedMesh(merged, mat, n);
    for (let i = 0; i < n; i++) {
      // two loose groups either side of the trail's end, thinning with distance
      const side = i % 2 ? 1 : -1;
      const x = -188 + side * rng.range(4, 70) + rng.range(-2, 2);
      const z = P.wallZ - rng.range(9, 40);
      this.crowdData.push({ x, z, yaw: rng.range(-0.25, 0.25), turn: 0, delay: rng.range(0, 3.5), s: rng.chance(0.18) ? rng.range(0.62, 0.8) : rng.range(0.92, 1.08) });
    }
    this.crowd.visible = false;
    this.crowd.layers.set(LAYER.TRANSPARENT);
    this.crowd.frustumCulled = false;
    this.game.engine.scene.add(this.crowd);
    this.updateCrowd(0);
  }

  /** A curtain of spray and mist riding the flood front. */
  private setupSpray() {
    const n = 160;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const off = new Float32Array(n * 4);
    const rng = new RNG(77);
    for (let i = 0; i < n; i++) off.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    g.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 aOff;
        uniform float uFrontZ;
        uniform float uCrest;
        uniform float uT;
        varying vec2 vUv;
        varying float vA;
        void main() {
          float ph = fract(uT * 0.12 + aOff.w);
          vec3 c = vec3(-720.0 + aOff.x * 1150.0, uCrest + aOff.z * 6.0 + ph * 16.0, uFrontZ + 4.0 + aOff.y * 26.0 + ph * 10.0);
          float size = 9.0 + aOff.z * 14.0 + ph * 12.0;
          vec3 toCam = normalize(cameraPosition - c);
          vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
          vec3 up = cross(toCam, right);
          vec3 wp = c + (right * position.x + up * position.y) * size;
          vUv = position.xy;
          vA = sin(ph * 3.14159);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uAmbient;
        uniform vec3 uSunColor;
        uniform float uAmount;
        varying vec2 vUv;
        varying float vA;
        void main() {
          float r = dot(vUv, vUv);
          float a = exp(-r * 3.2) * vA * uAmount * 0.32;
          if (a < 0.004) discard;
          vec3 col = uAmbient * 2.6 + uSunColor * 0.035;
          gl_FragColor = vec4(col, a);
        }`,
      uniforms: { uFrontZ: { value: 1e6 }, uCrest: { value: -10 }, uT: { value: 0 }, uAmount: { value: 0 }, uAmbient: U.uAmbient, uSunColor: U.uSunColor },
      transparent: true,
      depthWrite: false,
    });
    this.spray = new THREE.Mesh(g, mat);
    this.spray.frustumCulled = false;
    this.spray.layers.set(LAYER.TRANSPARENT);
    this.spray.renderOrder = 30;
    this.spray.visible = false;
    this.game.engine.scene.add(this.spray);
  }

  private updateCrowd(dt: number) {
    const c = this.crowd!;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const t = this.w.terrain;
    this.crowdData.forEach((d, i) => {
      if (this.touchT > 3 + d.delay) d.turn = Math.min(1, d.turn + dt * 0.35);
      const e = d.turn * d.turn * (3 - 2 * d.turn);
      q.setFromAxisAngle(V(0, 1, 0), d.yaw + e * Math.PI);
      m.compose(V(d.x, t.heightAt(d.x, d.z), d.z), q, V(d.s, d.s, d.s));
      c.setMatrixAt(i, m);
    });
    c.instanceMatrix.needsUpdate = true;
    (c.material as THREE.MeshStandardMaterial).opacity = 1 - this.crowdFade;
  }

  private assignFeeders() {
    // which breaker feeds which lamps / buildings
    for (const s of this.w.lights.sources) {
      if (s.id.startsWith('sl-harbor') || s.id === 'pier-lamp') this.feederOf.set(s.id, 'f3');
      else if (s.id.startsWith('sl-hill') || s.id.startsWith('sl-bay')) this.feederOf.set(s.id, 'f2');
      else if (s.id.startsWith('sl-main') || s.group === 'fuel') this.feederOf.set(s.id, 'f1');
    }
    for (const b of this.w.town.buildings) {
      const c = new THREE.Vector3().setFromMatrixPosition(b.matrix);
      const f = c.z > 165 ? 'f3' : c.x > 95 || c.x < -15 ? 'f2' : 'f1';
      if (b.spec.id === 'relayhut' || b.spec.id === 'keeper') continue;
      this.feederOf.set('bldg:' + b.spec.id, f);
    }
  }

  // ======================================================================= interactables
  private buildInteractables() {
    const g = this.game;
    const truck = g.truck;
    const pl = this.w.places;
    const walkOnly = () => g.mode === 'walk';

    // --- truck (the door handle doubles as the radio while dispatch is calling)
    const calling = () => !!this.flags.radioCalling && !this.flags.radioAnswered;
    this.add({
      id: 'truck',
      pos: truck.doorPoint(),
      radius: 3.0,
      label: () => (calling() ? 'Truck radio' : 'Truck'),
      verb: () => (calling() ? 'Answer' : 'Drive'),
      cone: 0.3,
      requireSight: false,
      enabled: () => walkOnly() && !this.flags.noTruck,
      onUse: () => (calling() ? this.answerDispatch() : g.enterTruck()),
    });
    this.add({
      id: 'workorder',
      pos: truck.doorPoint(),
      radius: 3.0,
      label: 'Work order',
      verb: 'Read',
      cone: 0.35,
      requireSight: false,
      enabled: () => walkOnly() && !!this.flags.radioAnswered && !this.docs.includes('workorder'),
      onUse: () => this.readDoc('workorder'),
    });
    this.add({
      id: 'flashlight',
      pos: V(0, 0, 0),
      radius: 3.0,
      label: 'Flashlight',
      verb: 'Take',
      cone: 0.5,
      requireSight: false,
      enabled: () => walkOnly() && !this.player.hasFlashlight,
      onUse: () => this.takeFlashlight(),
    });

    // --- overlook
    const viewer = this.w.dressing.viewer.clone().add(V(0, 1.25, 0));
    this.add({
      id: 'viewer',
      pos: viewer,
      radius: 2.9,
      label: 'Coin binoculars',
      verb: 'Look',
      onUse: () => {
        const yaw = Math.atan2(-(-60 - viewer.x), -(560 - viewer.z)) / DEG;
        g.startBinoculars(yaw, -5.5, () => {
          if (!this.flags.viewedFlats) {
            this.flags.viewedFlats = true;
            this.say([{ who: 'thought', text: 'Something’s standing out past the flats. Too straight for fog.' }]);
          }
        });
        if (!this.flags.viewed) {
          this.flags.viewed = true;
          this.say([
            { who: 'thought', text: 'The harbor’s empty. Not the boats — the water.', pause: 1.2 },
            { who: 'thought', text: 'The whole bay is mud, all the way to the horizon.' },
          ]);
        }
      },
    });
    const gp = pl.lhGate.pos.clone().add(V(Math.cos(pl.lhGate.yaw) * 1.2, 1.0, -Math.sin(pl.lhGate.yaw) * 1.2));
    this.add({
      id: 'lhgate',
      pos: gp,
      radius: 3.4,
      label: 'Lighthouse Road gate',
      verb: () => (this.flags.hasKey ? 'Unlock' : 'Try the gate'),
      enabled: () => walkOnly() && !this.flags.gateOpen,
      onUse: () => {
        if (!this.flags.hasKey) {
          audio.clunk(gp, 0.4);
          this.say(this.flags.wrenCall ? 'Padlocked. The key’s at the sheriff’s office.' : 'Padlocked. County road out to the lighthouse.');
          return;
        }
        this.openGate();
      },
    });

    // --- town
    const phone = this.w.dressing.payphone.clone().add(V(0, 1.5, 0));
    this.add({
      id: 'payphone',
      pos: phone,
      radius: 2,
      label: 'Payphone',
      verb: () => (this.flags.phoneRinging ? 'Answer' : 'Lift the receiver'),
      onUse: () => this.usePayphone(),
    });
    const doc = (id: string, anchor: string, label: string, verb = 'Read', r = 2.6) =>
      this.add({ id: 'doc-' + id, pos: this.anchor(anchor), radius: r, label, verb, enabled: walkOnly, onUse: () => this.readDoc(id) });
    doc('sheriffLog', 'sheriffLog', 'Deputy’s log');
    doc('dinerTicket', 'dinerTicket', 'Order ticket');
    doc('fridge', 'fridgeNote', 'Note on the fridge');
    doc('drawing', 'drawing', 'Child’s drawing', 'Look');
    doc('tideChart', 'tideChart', 'Tide chart', 'Look');
    doc('lineman', 'walt', 'Note taped to the panel');
    doc('journal1', 'journal1', 'Keeper’s journal');
    doc('journal2', 'journal2', 'Keeper’s journal');
    doc('wrenLetter', 'postcard', 'Postcard', 'Read');
    const church = this.w.town.byId.get('church');
    if (church && church.doors[0]) {
      const d = church.doors[0];
      const side = new THREE.Vector3(Math.cos(d.yaw), 0, -Math.sin(d.yaw));
      const n = new THREE.Vector3(Math.sin(d.yaw), 0, Math.cos(d.yaw));
      const hp = d.world.clone().addScaledVector(side, d.w * 0.5 + 0.9).addScaledVector(n, 0.25).add(V(0, 1.5, 0));
      this.add({ id: 'doc-church', pos: hp, radius: 2.4, label: 'Hymn board', verb: 'Read', onUse: () => this.readDoc('church') });
    }
    this.add({
      id: 'jukebox',
      pos: this.anchor('jukebox'),
      radius: 2.6,
      label: 'Jukebox',
      verb: () => (this.flags.power ? 'Play' : 'Press a button'),
      onUse: () => {
        if (!this.flags.power) return this.say('Dead. No power in the whole town.');
        this.playJukebox();
      },
    });
    this.add({
      id: 'tv',
      pos: this.anchor('tv'),
      radius: 2.6,
      label: 'Television',
      verb: 'Switch on',
      onUse: () => {
        if (!this.flags.power || this.feederOn('f2') === false) return this.say('Nothing. The power’s out.');
        audio.burst({ type: 'white', f: 3000, q: 0.3, decay: 3.5, gain: 0.25, pos: this.anchor('tv') });
        this.say('Snow on every channel.');
      },
    });
    this.add({
      id: 'teacup',
      pos: this.anchor('teacup'),
      radius: 2.3,
      label: 'Teacup',
      verb: 'Look',
      onUse: () => this.say('Half full. Cold. A skin on top.'),
    });

    // --- relay hut
    this.add({
      id: 'panel',
      pos: this.anchor('panel'),
      radius: 2.6,
      label: 'Breaker panel',
      verb: 'Open',
      onUse: () => this.openPanel(),
    });
    this.add({
      id: 'handheld',
      pos: this.anchor('handheld'),
      radius: 2.6,
      label: 'Handheld radio',
      verb: 'Take',
      enabled: () => walkOnly() && !this.flags.hasHandheld,
      onUse: () => {
        this.flags.hasHandheld = true;
        audio.click(undefined, 0.3);
        if (this.flags.power) this.powerCall();
        else this.say('A county handheld. Just hiss — nothing gets out of this valley without the relay.');
      },
    });
    this.add({
      id: 'baseRadio',
      pos: this.anchor('radio'),
      radius: 2.6,
      label: 'Base radio',
      verb: 'Listen',
      enabled: () => walkOnly() && !this.flags.wrenCall,
      onUse: () => {
        if (this.flags.power) {
          this.flags.hasHandheld = true;
          this.powerCall();
        } else this.say('Dead. It runs off the same supply as everything else.');
      },
    });
    this.add({
      id: 'gateKey',
      pos: this.anchor('gateKey'),
      radius: 2.6,
      label: 'Key cabinet',
      verb: 'Take the gate key',
      enabled: () => walkOnly() && !this.flags.hasKey,
      onUse: () => {
        this.flags.hasKey = true;
        audio.click(undefined, 0.4);
        audio.burst({ type: 'white', f: 5000, q: 2, decay: 0.08, gain: 0.2 });
        this.say([
          { who: 'thought', text: 'A red tag: LIGHTHOUSE RD. GATE.' },
          { who: 'thought', text: 'The gate’s up by the overlook. Back up the hill.' },
        ]);
        this.setObjective('Drive back up to the overlook and take Lighthouse Road.');
        this.checkpoint('key');
      },
    });

    // --- lighthouse
    const lh = pl.lighthouse;
    this.add({
      id: 'lhStairs',
      pos: lh.door.clone(),
      radius: 2.6,
      label: 'Lighthouse',
      verb: 'Climb the stairs',
      cone: 0.4,
      enabled: () => walkOnly() && !!this.flags.atLighthouse,
      onUse: () =>
        this.transition(
          'You climb. Ninety-one iron steps, round and round.',
          () => {
            this.player.teleport(lh.gallery.x, lh.gallery.y + 0.02, lh.gallery.z, 180, 0);
            this.flags.upTower = true;
            if (!this.flags.sawLens) {
              this.flags.sawLens = true;
              this.after(1.5, () =>
                this.say([
                  { who: 'thought', text: 'The lamp’s lit, but the lens isn’t turning.' },
                  { who: 'thought', text: 'One fixed beam, pointing out over the flats.' },
                ]),
              );
            }
          },
          'metal',
        ),
    });
    const downPos = lh.lampRoom.clone().add(V(-1.25, 0.25, 0.1));
    this.add({
      id: 'lhDown',
      pos: downPos,
      radius: 2.2,
      label: 'Stairs',
      verb: 'Go down',
      cone: 0.3,
      requireSight: false,
      enabled: () => walkOnly() && !!this.flags.upTower,
      onUse: () =>
        this.transition(
          '',
          () => {
            this.player.teleport(lh.door.x, lh.base.y + 0.05, lh.door.z - 1.6, 0, 0);
            this.flags.upTower = false;
          },
          'metal',
        ),
    });
    this.add({
      id: 'lensMotor',
      pos: lh.lensMotor.clone(),
      radius: 2.4,
      label: 'Lens clockwork',
      verb: () => (this.flags.lensFixed ? 'Listen' : this.flags.motorTried ? 'Push the lens' : 'Wind the clockwork'),
      requireSight: false,
      onUse: () => this.useLensMotor(),
    });
    this.add({
      id: 'doc-journal3',
      pos: lh.lampRoom.clone().add(V(-0.25, 0.95, 1.3)),
      radius: 2.4,
      label: 'Notebook on the ledge',
      verb: 'Read',
      requireSight: false,
      enabled: () => walkOnly() && !!this.flags.lensFixed,
      onUse: () => {
        this.readDoc('journal3');
        if (!this.flags.readLast) {
          this.flags.readLast = true;
          this.ui.onDocClose = () => {
            this.game.input.enabled = true;
            this.say([
              { who: 'thought', text: 'Bring them home.', pause: 1 },
              { who: 'thought', text: 'I need to sit down. Just for a minute.' },
            ]);
            this.setObjective('Rest in the keeper’s house.');
          };
        }
      },
    });
    this.add({
      id: 'recorder',
      pos: this.anchor('recorder'),
      radius: 2.6,
      label: 'Tape recorder',
      verb: 'Play',
      onUse: () => this.playRecorder(),
    });
    this.add({
      id: 'armchair',
      pos: this.anchor('armchair'),
      radius: 2.4,
      label: 'Armchair',
      verb: 'Rest',
      enabled: () => walkOnly() && !!this.flags.lensFixed && !this.flags.rested,
      onUse: () => this.rest(),
    });

    // --- the flats
    const thoughts: Record<string, string> = {
      shoe: 'A child’s shoe. Laces still tied.',
      hat: 'The deputy’s hat.',
      scarf: 'A scarf, frozen stiff into the mud.',
      radio: 'A transistor radio, still on. Nothing but that low note coming out of it.',
    };
    for (const it of pl.trail.items) {
      this.add({
        id: 'item-' + it.id,
        pos: it.pos.clone().add(V(0, 0.2, 0)),
        radius: 2.8,
        label: it.label,
        verb: 'Look',
        cone: 0.6,
        onUse: () => {
          this.say(thoughts[it.id] ?? '…');
          if (it.id === 'radio') this.humTarget = Math.max(this.humTarget, 0.8);
        },
      });
    }
    const ladder = pl.tower.ladder.clone().add(V(0, 1.2, 0));
    this.add({
      id: 'ladder',
      pos: ladder,
      radius: 2.4,
      label: 'Ladder',
      verb: 'Climb',
      cone: 0.3,
      requireSight: false,
      onUse: () => {
        const b = pl.tower.ladder;
        const top = pl.tower.top;
        const from = V(b.x, b.y + 0.05, b.z - 0.25);
        const to = V(b.x, top.y - 1.4, b.z + 0.1);
        this.game.startClimb(from, to, 180, () => {
          this.player.teleport(top.x, top.y + 0.02, top.z - 0.3, 180, 0);
          this.flags.onTower = true;
        });
      },
    });
    this.add({
      id: 'wall',
      pos: V(0, 0, 0),
      radius: 4.5,
      label: 'The wall of water',
      verb: 'Touch',
      cone: 0.2,
      requireSight: false,
      enabled: () => walkOnly() && !!this.flags.wallRevealed && !this.flags.touched,
      onUse: () => this.touchWall(),
    });
  }

  // ======================================================================= beats
  /** Begin (or resume) the game at a checkpoint. */
  start(cp: Checkpoint) {
    this.cp = cp;
    this.timers = [];
    this.triggers = [];
    this.game.dialogue.clear();
    music.stopAll();
    this.setupCheckpoint(cp);
    this.game.mode = 'walk';
    this.ui.fade(0, 3.5);
    switch (cp) {
      case 'overlook':
        this.beatOverlook();
        break;
      case 'town':
        this.beatTown();
        break;
      case 'power':
        this.beatAfterPower();
        break;
      case 'key':
        this.beatStormDrive();
        break;
      case 'lighthouse':
        this.beatLighthouse();
        break;
      case 'dawn':
        this.beatDawn();
        break;
      case 'wall':
        this.beatWall();
        break;
    }
  }

  private beatOverlook() {
    music.cue('arrival');
    this.after(2.5, () => {
      const t = this.ui.touchUI;
      this.ui.showHint(t ? 'Drag on the left to walk · drag on the right to look · tap things to use them' : '<b>WASD</b> walk · <b>mouse</b> look · <b>E</b> use · <b>Shift</b> run', 8);
    });
    this.after(4.5, () => this.say('Blackwater. Last town on the county line.'));
    this.after(10, () => {
      this.flags.radioCalling = true;
      squelch(0.3, 0.3);
      this.ui.showHint(this.ui.touchUI ? 'The truck radio is calling.' : 'The truck radio is calling. <b>E</b> to answer.', 5);
    });
    this.setObjective('Blackwater relay. The hut on Hill Street.', false);
    // the tape on the way down
    this.when(
      () => this.game.mode === 'drive' && (this.game.truck.pos.x > -95 || this.game.truck.pos.z > -330),
      () => this.playTideTape(),
    );
    this.when(
      () => this.game.mode === 'drive' && this.game.truck.pos.distanceTo(V(P.roadblock.x, this.game.truck.pos.y, P.roadblock.z)) < 60,
      () => this.say('Cars. All the doors are open.'),
    );
    this.when(
      () => this.game.truck.pos.distanceTo(V(P.roadblock.x, this.game.truck.pos.y, P.roadblock.z)) < 38 && Math.abs(this.game.truck.speed) < 1.5 && this.game.mode === 'drive',
      () => this.ui.showHint(this.ui.touchUI ? 'Tap <b>Get out</b> to leave the truck.' : '<b>E</b> — get out', 5),
    );
    this.when(
      () => this.game.mode === 'walk' && Math.hypot(this.player.pos.x - P.roadblock.x, this.player.pos.z - P.roadblock.z) < 34,
      () => {
        this.checkpoint('town');
        this.beatTown();
      },
    );
  }

  private beatTown() {
    this.flags.inTown = true;
    this.env.timeRate = 0.0012;
    this.after(2, () => {
      if (!this.flags.townThought) {
        this.flags.townThought = true;
        this.say([
          { who: 'thought', text: 'Nobody. Keys still in the ignitions.' },
          { who: 'thought', text: 'Hill Street’s off Main, on the left. The relay hut.' },
        ]);
      }
    });
    this.setObjective('Find the relay hut on Hill Street.', this.cp === 'town');
    music.cue('unease');
    // the relay hut
    this.when(
      () => this.game.insideId === 'relayhut',
      () => {
        if (!this.flags.power) this.say('Main breaker’s tripped. There’s a note on the panel.');
        if (this.env.targetTime < 16.5) this.env.setTime(16.55, 90);
      },
    );
  }

  private beatAfterPower() {
    // resuming at the 'power' checkpoint: the call has happened, the storm is coming
    this.setObjective('Get the gate key from the sheriff’s office.', true);
    music.cue('storm');
    this.stormArrives(true);
  }

  private beatStormDrive() {
    this.setObjective('Drive back up to the overlook and take Lighthouse Road.', true);
    const kh = V(P.keeperHouse.x, 0, P.keeperHouse.z);
    this.when(
      () => Math.hypot(this.player.pos.x - kh.x, this.player.pos.z - kh.z) < 110 || Math.hypot(this.game.truck.pos.x - kh.x, this.game.truck.pos.z - kh.z) < 110,
      () => this.arriveLighthouse(),
    );
  }

  private arriveLighthouse() {
    if (this.flags.atLighthouse) return;
    this.flags.atLighthouse = true;
    this.checkpoint('lighthouse');
    this.beatLighthouse();
  }

  private beatLighthouse() {
    this.flags.atLighthouse = true;
    this.setObjective('Find Wren. The lamp room is at the top of the tower.', true);
    music.cue('lighthouse');
    this.after(3, () => this.say('Her windows are lit.'));
    this.when(
      () => this.game.insideId === 'keeper',
      () =>
        this.say([
          { who: 'thought', text: 'Wren?', pause: 1.5 },
          { who: 'thought', text: 'Stove’s still going. Nobody home.' },
        ]),
    );
  }

  private beatDawn() {
    this.setObjective('Go down to the flats. The cliff path starts past the lighthouse.', false);
    music.cue('dawn');
    // the last of the storm breaks up while you step outside
    this.env.setWeather('dawn', 75);
    this.after(2, () =>
      this.say([
        { who: 'thought', text: 'Morning.', pause: 1.0 },
        { who: 'thought', text: 'The storm’s gone. Everything’s washed clean.' },
      ]),
    );
    this.after(9, () => this.setObjective('Go down to the flats. The cliff path starts past the lighthouse.', true));
    this.env.timeRate = 0.0009;
    this.w.lights.setGroup('lanterns', true);
    this.w.lights.setGroup('range', true);
    this.w.places.figures.visible = true;
    this.when(
      () => this.player.pos.y < 6 && this.player.pos.z > 380,
      () => {
        this.say('Footprints. Hundreds of them. All going the same way.');
        this.setObjective('Follow the footprints.', true);
        this.humTarget = 0.35;
      },
    );
    this.when(
      () => this.player.pos.z > 620,
      () => {
        this.humTarget = 0.6;
        this.w.places.wall.visible = true;
        this.say('That sound again. It’s coming from inside the fog.');
      },
    );
    this.when(
      () => this.player.pos.z > 880,
      () => this.revealWall(),
    );
  }

  private revealWall() {
    if (this.flags.wallRevealed) return;
    this.flags.wallRevealed = true;
    this.w.places.wall.visible = true;
    this.crowd!.visible = true;
    this.bankClearTarget = 1;
    this.humTarget = 1;
    this.env.setWeather('reveal', 14);
    music.stopAll();
    music.cue('wall');
    this.after(9, () => this.say('The sea.', () => this.after(2.5, () => this.say('It’s standing up.'))));
    this.after(20, () => {
      this.setObjective('Go to the wall.', true);
      this.checkpoint('wall');
    });
  }

  private beatWall() {
    this.flags.wallRevealed = true;
    this.w.places.wall.visible = true;
    this.w.places.figures.visible = true;
    this.crowd!.visible = true;
    this.bankClear = this.bankClearTarget = 1;
    this.humTarget = this.hum = 1;
    this.w.lights.setGroup('lanterns', true);
    this.w.lights.setGroup('range', true);
    music.cue('wall');
    this.setObjective('Go to the wall.', true);
  }

  // ======================================================================= actions
  private onEnterTruck() {
    this.flags.drove = true;
    if (this.flags.radioCalling && !this.flags.radioAnswered) this.answerDispatch();
    if (!this.flags.driveHint) {
      this.flags.driveHint = true;
      this.ui.showHint(this.ui.touchUI ? 'Left stick: throttle and steering · drag right side to look' : '<b>W/S</b> throttle · <b>A/D</b> steer · <b>F</b> headlights · <b>E</b> get out', 7);
    }
  }

  private onExitTruck() {
    // nothing yet
  }

  private answerDispatch() {
    if (this.flags.radioAnswered) return;
    this.flags.radioAnswered = true;
    this.flags.radioCalling = false;
    this.game.dialogue.setStatic(0.25);
    this.say(
      [
        { who: 'ruth', text: 'Unit 7, county dispatch. You there yet?' },
        { who: 'you', text: 'At the overlook, Ruth. Just coming down.' },
        { who: 'ruth', text: 'Blackwater’s been dark since Tuesday morning. Phones, power, the relay — all of it.' },
        { who: 'ruth', text: 'Get the relay back up and call me from the hut on Hill Street.' },
        { who: 'ruth', text: 'Oh — Coast Guard says their tide gauge down there is broken. Not our equipment. Leave it be.' },
        { who: 'ruth', text: 'Dispatch out.', pause: 1.2 },
      ],
      () => {
        this.game.dialogue.setStatic(0);
        this.say('The work order’s on the seat. And there’s a flashlight in the toolbox.');
      },
    );
  }

  private takeFlashlight() {
    this.player.hasFlashlight = true;
    audio.clunk(undefined, 0.3);
    this.ui.setFlashButton(true, false);
    this.ui.showHint(this.ui.touchUI ? 'Flashlight: the button top right.' : '<b>F</b> — flashlight', 5);
  }

  private playTideTape() {
    if (this.flags.tapeHeard) return;
    this.flags.tapeHeard = true;
    const d = this.game.dialogue;
    d.setStatic(0.6);
    const tape: Line[] = [
      { who: 'thought', text: 'The radio’s picked something up.', pause: 0.8 },
      { who: 'wrenTape', text: 'Blackwater Light, tide station.', noSquelch: true },
      { who: 'wrenTape', text: 'Tuesday, four-seventeen. Water level eleven feet below datum. And falling.', noSquelch: true, pause: 1.0 },
      { who: 'wrenTape', text: 'If anyone is receiving this: stay off the flats. Do not follow the lights.', noSquelch: true, pause: 1.6 },
      { who: 'wrenTape', text: 'Blackwater Light, tide station…', noSquelch: true, pause: 0.6 },
    ];
    this.say(tape, () => {
      d.setStatic(0);
      this.say('That’s not the Coast Guard.');
    });
  }

  private usePayphone() {
    const pos = this.w.dressing.payphone.clone().add(V(0, 1.5, 0));
    audio.clunk(pos, 0.25);
    if (this.flags.phoneRinging) {
      this.flags.phoneRinging = false;
      this.flags.phoneAnswered = true;
      this.humTarget = 0.5;
      this.say(
        [
          { who: 'thought', text: '…Hello?', pause: 2.5 },
          { who: 'thought', text: 'No one. Just a low note, a long way off. Like a foghorn from the wrong direction.', pause: 2.5 },
        ],
        () => {
          this.humTarget = 0;
          audio.clunk(pos, 0.2);
          this.say('The line’s dead.');
        },
      );
      return;
    }
    this.say(this.flags.power ? 'Dial tone. Who would I even call?' : 'Dead.');
  }

  private playJukebox() {
    const notes = ['A4', 'C5', 'E5', 'D5', 'C5', 'A4', 'G4', 'A4', 'E4', 'G4', 'A4', 'C5', 'B4', 'A4'];
    notes.forEach((n, i) => music.piano(n, i * 0.62 + (i % 4 === 3 ? 0.3 : 0), 0.05));
    this.say('It still plays.');
  }

  // --------------------------------------------------------------- the breaker panel
  private breakerState(): Breaker[] {
    if (!this.breakers.length) {
      this.breakers = [
        { id: 'main', label: 'MAIN', on: !!this.flags.power },
        { id: 'f1', label: 'F1 · MAIN ST', on: true },
        { id: 'f2', label: 'F2 · HILL / BAY', on: true },
        { id: 'f3', label: 'F3 · HARBOR / TIDE STN', on: !this.flags.power, tag: this.docs.includes('lineman') ? 'DO NOT CLOSE' : undefined },
      ];
    }
    return this.breakers;
  }

  private feederOn(id: 'f1' | 'f2' | 'f3') {
    const b = this.breakerState().find((x) => x.id === id);
    return !!this.flags.power && !!b?.on;
  }

  private openPanel() {
    const pos = this.anchor('panel');
    audio.clunk(pos, 0.3);
    this.game.input.enabled = false;
    this.game.input.exitLock();
    const refresh = () => {
      const st = this.breakerState();
      const f3 = st.find((b) => b.id === 'f3')!;
      if (this.docs.includes('lineman')) f3.tag = 'DO NOT CLOSE';
      this.ui.refreshPanel(st, !!this.flags.power);
    };
    this.ui.showPanel(this.breakerState(), !!this.flags.power, (id) => {
      const st = this.breakerState();
      const b = st.find((x) => x.id === id)!;
      b.on = !b.on;
      audio.clunk(pos, b.id === 'main' ? 0.9 : 0.5);
      audio.click(pos, 0.3);
      if (b.id === 'main' && b.on) {
        const f3 = st.find((x) => x.id === 'f3')!;
        if (f3.on) {
          // fault on the harbor feeder: arc, bang, trip
          this.after(0.35, () => {
            audio.spark(pos);
            audio.burst({ type: 'brown', f: 120, q: 0.7, decay: 0.6, gain: 0.9, pos });
            this.w.lights.setGroup('bldg:relayhut', true);
            this.after(0.18, () => this.w.lights.setGroup('bldg:relayhut', false));
            b.on = false;
            refresh();
            this.flags.tripped = true;
            this.say(this.flags.trippedOnce ? 'Tripped again.' : 'It trips straight back out. Something on the harbor line is shorting.');
            this.flags.trippedOnce = true;
          });
        } else {
          this.restorePower();
        }
      } else if (b.id === 'main' && !b.on && this.flags.power) {
        this.setPower(false);
      } else if (b.id === 'f3' && b.on && this.flags.power) {
        // closing onto the flooded harbor feeder trips the main again
        this.after(0.3, () => {
          audio.spark(pos);
          audio.burst({ type: 'brown', f: 120, q: 0.7, decay: 0.6, gain: 0.9, pos });
          const main = st.find((x) => x.id === 'main')!;
          main.on = false;
          this.setPower(false);
          refresh();
          this.say('The harbor line faults the whole board. Leave F3 open.');
        });
      } else if (this.flags.power) {
        this.applyFeeders();
      }
      refresh();
    }, () => {
      this.game.input.enabled = true;
      audio.clunk(pos, 0.2);
    });
  }

  private setPower(on: boolean) {
    const L = this.w.lights;
    if (!on) {
      this.flags.power = false;
      L.setGroup('relay', false);
      L.setGroup('bldg:relayhut', false);
      this.applyFeeders();
      this.game.setHum('transformer', 0);
      this.game.setHum('hut', 0);
      return;
    }
    this.flags.power = true;
    L.setGroup('relay', true, 0.03, this.w.places.yard.hut);
    L.setGroup('bldg:relayhut', true);
    this.game.setHum('transformer', 1);
    this.game.setHum('hut', 0.6);
    this.applyFeeders();
  }

  /** Lamps + windows for each closed feeder (staggered from the yard, down the hill). */
  private applyFeeders() {
    const L = this.w.lights;
    const origin = this.w.places.yard.hut;
    for (const s of L.sources) {
      const f = this.feederOf.get(s.id) ?? (s.group.startsWith('bldg:') ? this.feederOf.get(s.group) : undefined);
      if (!f) continue;
      const on = this.feederOn(f) && (!s.group.startsWith('bldg:') || this.bldgLit(s.group));
      const target = on ? 1 : 0;
      if (s.target !== target) {
        s.target = target;
        s.delay = on ? 0.6 + s.pos.distanceTo(origin) * 0.018 + Math.random() * 0.4 : Math.random() * 0.1;
        if (!on) s.warm = 0;
      }
    }
    // windows
    for (const b of this.w.town.buildings) {
      const f = this.feederOf.get('bldg:' + b.spec.id);
      if (!f) continue;
      const lit = this.feederOn(f) && this.bldgLit('bldg:' + b.spec.id);
      const idx = b.spec.light;
      const delay = 0.8 + new THREE.Vector3().setFromMatrixPosition(b.matrix).distanceTo(origin) * 0.018;
      const target = lit ? 1 : 0;
      if (target) this.after(delay, () => (BuildingLights.values[idx] = this.feederOn(f) ? 1 : 0));
      else BuildingLights.values[idx] = 0;
    }
  }

  /** Whether a building had lights left on when everyone left. */
  private bldgLit(group: string) {
    const id = group.slice(5);
    if (['sheriff', 'diner', 'pell', 'harbormaster'].includes(id)) return true;
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return h % 3 !== 0;
  }

  private restorePower() {
    if (this.flags.power) return;
    this.flags.tripped = false;
    const pos = this.anchor('panel');
    audio.burst({ type: 'brown', f: 90, q: 0.6, decay: 1.4, gain: 0.8, pos });
    this.setPower(true);
    if (this.flags.powerOnce) return; // re-energising after a trip: no second ceremony
    this.flags.powerOnce = true;
    this.checkpointLater('power', 16);
    music.stopAll();
    this.after(1.5, () => music.cue('power'));
    // dusk falls as the lamps warm up: sodium only reads a few degrees below the horizon
    if (this.env.targetTime < 16.95) this.env.setTime(16.95, 35);
    this.env.timeRate = 0;
    // the sheriff's door buzzes open
    const door = this.game.doors.get('sheriff-door');
    if (door) this.after(6, () => (door.locked = false));
    this.after(3, () => this.ui.closePanel());
    this.after(4.5, () => this.say([{ who: 'thought', text: 'There.', pause: 1.2 }]));
    this.after(9, () => {
      this.flags.phoneRinging = true;
      if (this.flags.hasHandheld) this.powerCall();
      else {
        squelch(0.3, 0.35);
        this.say('The radio on the desk.');
      }
    });
  }

  private powerCall() {
    if (this.flags.wrenCall || this.flags.powerCallStarted) return;
    this.flags.powerCallStarted = true;
    const d = this.game.dialogue;
    d.setStatic(0.3);
    this.say(
      [
        { who: 'ruth', text: 'Unit 7, dispatch. I’ve got carrier on the Blackwater relay. Nice work.' },
        { who: 'ruth', text: 'What’s it look like down there?' },
        { who: 'you', text: 'Empty, Ruth. The whole town. Cars on the road with the doors hanging open.' },
        { who: 'ruth', text: '…Okay. Stay put. I’m calling Harrow sheriff.', pause: 1.2, onStart: () => d.setStatic(0.55) },
        { who: 'wren', text: 'Is anyone on this channel? This is Wren Talley, at Blackwater Light.', noSquelch: true },
        { who: 'wren', text: 'Whoever turned the power on — please. The lamp motor’s failing. If the light goes out, they won’t find their way back.', noSquelch: true },
        { who: 'wren', text: 'The sheriff’s office has the key to the Lighthouse Road gate. Please. Come to the light.', noSquelch: true, pause: 1.0 },
        { who: 'ruth', text: 'Unit 7, who was that? I can’t — you’re breaking u—', onStart: () => d.setStatic(0.9) },
      ],
      () => {
        d.setStatic(0);
        this.flags.wrenCall = true;
        this.env.triggerStrike(new THREE.Vector3(0.3, 0, 1), 900, 1.4);
        this.after(2.5, () => {
          this.say('The lighthouse. Out on the headland.');
          this.setObjective('Get the gate key from the sheriff’s office.', true);
        });
        this.stormArrives(false);
        this.checkpoint('power');
      },
    );
  }

  private stormArrives(immediate: boolean) {
    const env = this.env;
    env.setWeather('gathering', immediate ? 5 : 25);
    env.setTime(17.35, immediate ? 5 : 150);
    this.after(immediate ? 10 : 60, () => env.setWeather('storm', 50));
    music.cue('storm');
  }

  private openGate() {
    this.flags.gateOpen = true;
    audio.clunk(this.w.places.lhGate.pos, 0.8);
    this.after(0.5, () => audio.creak(0.3, 1.5, this.w.places.lhGate.pos));
    if (this.gateCollider) this.gateCollider.enabled = false;
    this.say('Lighthouse Road. Down the west side of the ridge.');
    this.beatStormDrive();
  }

  // --------------------------------------------------------------- the lighthouse
  private useLensMotor() {
    const pos = this.w.places.lighthouse.lensMotor;
    if (this.flags.lensFixed) {
      this.say('Ticking over. It’ll run all night.');
      return;
    }
    if (!this.flags.motorTried) {
      this.flags.motorTried = true;
      for (let i = 0; i < 6; i++) this.after(i * 0.32, () => audio.click(pos, 0.5));
      this.after(2.2, () => audio.clunk(pos, 0.5));
      this.say([
        { who: 'thought', text: 'Wound tight. The escapement’s ticking but the lens won’t budge.', pause: 0.5 },
        { who: 'thought', text: 'It’s stuck. Needs a push.' },
      ]);
      return;
    }
    this.flags.lensFixed = true;
    audio.creak(0.5, 2.5, pos);
    audio.burst({ type: 'brown', f: 160, q: 1, decay: 1.2, gain: 0.5, pos });
    this.lensSpeed = 0.0001;
    music.cue('lighthouse');
    this.after(4, () => this.say('There it goes.'));
    this.after(9, () => this.say('There’s a notebook on the ledge.'));
  }

  private playRecorder() {
    const pos = this.anchor('recorder');
    audio.clunk(pos, 0.35);
    if (this.flags.recorderPlayed) {
      this.say('The same message, over and over.');
      return;
    }
    this.flags.recorderPlayed = true;
    this.say(
      [
        { who: 'wrenTape', text: 'Is anyone on this channel? This is Wren Talley, at Blackwater Light.' },
        { who: 'wrenTape', text: 'Whoever turned the power on — please…', pause: 1.2 },
        { who: 'thought', text: 'It’s a recording.', pause: 1 },
        { who: 'thought', text: 'The reel’s labelled in pen: “OCT 22 — PLAY WHEN RELAY RETURNS.”' },
      ],
      () => this.setObjective(this.flags.lensFixed ? 'Rest in the keeper’s house.' : 'The lamp room. At the top of the tower.', false),
    );
  }

  private rest() {
    this.flags.rested = true;
    this.game.mode = 'cutscene';
    this.ui.fade(1, 3);
    this.say('Just for a minute.');
    this.after(3.5, () => {
      this.ui.showCard('Morning', 5);
      this.after(4, () => {
        this.checkpoint('dawn');
        this.setupCheckpoint('dawn');
        this.game.mode = 'walk';
        this.ui.fade(0, 5);
        this.beatDawn();
      });
    });
  }

  // --------------------------------------------------------------- the wall and the sea
  private touchWall() {
    if (this.flags.touched) return;
    this.flags.touched = true;
    const p = this.player.pos.clone();
    const wallMat = this.w.places.wall.material as THREE.ShaderMaterial;
    wallMat.uniforms.uTouch.value.set(p.x, p.y + 1.3, P.wallZ - 1, 0.001);
    this.touchT = 0;
    this.humTarget = 0;
    this.hum = 0;
    music.stopAll();
    audio.burst({ type: 'pink', f: 900, q: 0.8, decay: 2.5, gain: 0.3, pos: p });
    this.after(5.5, () => this.say('They’re turning around.'));
    this.after(9, () => {
      this.crowdFadeOn = true;
      audio.burst({ type: 'brown', f: 60, q: 0.5, decay: 6, gain: 0.9 });
    });
    this.after(13, () => {
      this.collapseOn = true;
      this.env.setWeather('surge', 10);
      this.player.shake = 1;
      music.cue('escape');
      this.say('It’s letting go.');
      this.ui.showHint('<b>Run.</b> The tower — the light on the post.', 6);
      this.setObjective('Get up the tower.', false);
    });
    this.after(17, () => {
      this.front.active = true;
      this.front.z = P.wallZ - 4;
      this.front.speed = 2;
      this.seaLevel = this.w.terrain.heightAt(this.player.pos.x, P.wallZ - 20) - 1;
    });
  }
  private crowdFadeOn = false;
  private collapseOn = false;

  private gameOver() {
    if (this.gameOverT >= 0) return;
    this.gameOverT = 0;
    this.game.mode = 'cutscene';
    this.ui.fade(1, 0.6);
    audio.splash(this.player.pos, 1);
    this.after(3, () => {
      this.ui.showCard('The sea took you. Try again.', 4);
      this.after(1.5, () => {
        this.gameOverT = -1;
        this.start('wall');
      });
    });
  }

  private ending() {
    if (this.endT >= 0) return;
    this.endT = 0;
    const d = this.game.dialogue;
    this.after(8, () => {
      d.setStatic(0.35);
      this.say(
        [
          { who: 'ruth', text: 'Unit 7? Unit 7, come in.' },
          { who: 'ruth', text: 'Coast Guard says the Blackwater tide gauge just came back. Water’s normal. Like nothing happened.' },
          { who: 'ruth', text: 'And Harrow sheriff called. People are walking into town on the Coast Road. Dozens of them.' },
          { who: 'ruth', text: 'Soaking wet. Nobody can say where they’ve been.', pause: 1.4 },
          { who: 'ruth', text: '…Unit 7? Are you there?', pause: 1.6 },
          { who: 'you', text: 'I’m here, Ruth.', pause: 1.5 },
          { who: 'ruth', text: 'Come on home.', pause: 3 },
        ],
        () => {
          d.setStatic(0);
          music.cue('ending');
          this.clearSave();
          this.after(4, () => {
            this.ui.fade(0.55, 6);
            this.ui.showCredits(
              `<h1>BLACKWATER</h1><p>They went to see the water.<br>You brought them home.</p><p class="small">Everything you saw and heard was generated in your browser.</p><p class="small">Thank you for playing</p>`,
              () => location.reload(),
            );
            this.onEnd?.();
          });
        },
      );
    });
  }

  // ======================================================================= checkpoints
  private checkpointLater(cp: Checkpoint, delay: number) {
    this.after(delay, () => this.checkpoint(cp));
  }

  checkpoint(cp: Checkpoint) {
    this.cp = cp;
    const save: Save = { v: 1, cp, docs: this.docs };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(save));
      if (performance.now() - this.lastSave > 5000) this.ui.saved();
      this.lastSave = performance.now();
    } catch {
      /* storage unavailable (private mode) */
    }
  }

  static loadSave(): Save | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Save;
      return s && s.v === 1 ? s : null;
    } catch {
      return null;
    }
  }

  clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  restoreDocs(docs: string[]) {
    this.docs = [...docs];
  }

  /** Put the world into the state it has at a checkpoint. */
  setupCheckpoint(cp: Checkpoint) {
    const order: Checkpoint[] = ['overlook', 'town', 'power', 'key', 'lighthouse', 'dawn', 'wall'];
    const k = order.indexOf(cp);
    const at = (c: Checkpoint) => k >= order.indexOf(c);
    const F = this.flags;
    const env = this.env;
    const g = this.game;
    const truck = g.truck;
    const L = this.w.lights;
    const pl = this.w.places;
    // reset transient state
    this.front = { z: 1e6, active: false, speed: 0 };
    if (this.spray) this.spray.visible = false;
    this.touchT = -1;
    this.collapse = 0;
    this.collapseOn = false;
    this.crowdFade = 0;
    this.crowdFadeOn = false;
    this.crowdData.forEach((d) => (d.turn = 0));
    this.seaReturn = 0;
    this.seaLevel = -40;
    this.endT = -1;
    this.breakers = [];
    (pl.wall.material as THREE.ShaderMaterial).uniforms.uTouch.value.set(0, 0, 0, -1);
    for (const key of Object.keys(F)) delete F[key];
    this.player.hasFlashlight = at('town');
    this.ui.setFlashButton(this.player.hasFlashlight, false);
    if (!at('town')) this.player.setFlash(false);
    F.radioAnswered = at('town');
    F.tapeHeard = at('town');
    F.drove = at('town');
    F.viewed = at('town');
    F.inTown = at('town');
    F.townThought = at('power');
    F.power = at('power');
    F.powerOnce = at('power');
    F.hasHandheld = at('power');
    F.wrenCall = at('power');
    F.powerCallStarted = at('power');
    F.hasKey = at('key');
    F.gateOpen = at('lighthouse');
    F.atLighthouse = at('lighthouse');
    F.lensFixed = at('dawn');
    F.motorTried = at('dawn');
    F.rested = at('dawn');
    F.readLast = at('dawn');
    F.wallRevealed = at('wall');

    // time & weather
    const tw: Record<Checkpoint, [number, keyof typeof WEATHER_PRESETS]> = {
      overlook: [15.55, 'golden'],
      town: [15.95, 'golden'],
      power: [16.95, 'gathering'],
      key: [17.4, 'storm'],
      lighthouse: [17.9, 'storm'],
      dawn: [7.3, 'clearing'],
      wall: [7.75, 'reveal'],
    };
    env.snap(tw[cp][0], tw[cp][1]);
    env.timeRate = 0;
    this.w.weather.rainScale = 1;

    // lights
    for (const s of L.sources) {
      s.target = 0;
      s.on = 0;
      s.delay = 0;
    }
    BuildingLights.values.fill(0);
    const keeperLights = () => {
      L.setGroup('bldg:keeper', true);
      L.setGroup('lighthouse', true);
      const kb = this.w.town.byId.get('keeper');
      if (kb) BuildingLights.values[kb.spec.light] = 1;
    };
    keeperLights();
    if (F.power) {
      this.setPower(true);
      for (const s of L.sources) if (s.target > 0) s.delay = 0;
      for (const b of this.w.town.buildings) {
        const f = this.feederOf.get('bldg:' + b.spec.id);
        if (f && this.feederOn(f) && this.bldgLit('bldg:' + b.spec.id)) BuildingLights.values[b.spec.light] = 1;
      }
    } else {
      g.setHum('transformer', 0);
      g.setHum('hut', 0);
    }
    if (at('dawn')) {
      L.setGroup('lanterns', true);
      L.setGroup('range', true);
    }
    for (const s of L.sources) if (s.target > 0 && k > 0) s.on = 1;
    // doors
    const sd = g.doors.get('sheriff-door');
    if (sd) {
      sd.locked = !F.power;
      this.wrapLockedDoor(sd, 'Locked. There’s a keypad by the door — dead, like everything else.');
    }
    for (const d of g.doors.values()) d.setOpen(false, true);
    // the gate
    if (this.gateCollider) this.gateCollider.enabled = !F.gateOpen;
    this.gateOpen = F.gateOpen ? 1 : 0;
    // lens
    this.lensSpeed = F.lensFixed ? 0.9 : 0;
    this.beamLevel = 0.25 + 0.75 * smoothstep(4, -6, Math.asin(env.sunDir.y) / DEG);
    // wall, figures, crowd, sea
    pl.wall.visible = at('wall');
    pl.figures.visible = at('dawn');
    this.crowd!.visible = at('wall');
    this.updateCrowd(0);
    this.bankClear = this.bankClearTarget = at('wall') ? 1 : 0;
    this.hum = this.humTarget = at('wall') ? 1 : 0;
    const sea = this.w.water.sea;
    sea.visible = false;
    this.w.water.flats.visible = true;
    const sm = sea.material as THREE.ShaderMaterial;
    sm.uniforms.uFlood.value = 0;

    // positions
    g.mode = 'walk';
    g.truck.occupied = false;
    const place = (x: number, z: number, yawDeg: number, pitch = 0, y: number | null = null) => this.player.teleport(x, y, z, yawDeg, pitch);
    switch (cp) {
      case 'overlook':
        truck.place(this.w.dressing.truckSpot.pos, this.w.dressing.truckSpot.yaw);
        place(-176.5, -421.5, 196, -3);
        break;
      case 'town':
      case 'power':
      case 'key': {
        truck.place(this.roadblockSpot.pos, this.roadblockSpot.yaw);
        if (cp === 'town') {
          const e = truck.exitPoint();
          place(e.x, e.z, THREE.MathUtils.radToDeg(this.roadblockSpot.yaw - Math.PI / 2), -2);
        } else if (cp === 'power') {
          const h = this.anchor('radio');
          const hb = this.w.town.byId.get('relayhut')!;
          const c = new THREE.Vector3(0, 0, hb.spec.d * 0.45).applyMatrix4(hb.matrix);
          place(c.x, c.z, THREE.MathUtils.radToDeg(Math.atan2(-(h.x - c.x), -(h.z - c.z))), -8, hb.spec.floorY + 0.02);
        } else {
          const sb = this.w.town.byId.get('sheriff')!;
          const c = new THREE.Vector3(0, 0, sb.spec.d * 0.5).applyMatrix4(sb.matrix);
          const dd = sb.doors[0];
          place(c.x, c.z, THREE.MathUtils.radToDeg(Math.atan2(-(dd.world.x - c.x), -(dd.world.z - c.z))), 0, sb.spec.floorY + 0.02);
        }
        break;
      }
      case 'lighthouse': {
        const kb = this.w.town.byId.get('keeper')!;
        const front = kb.doors[0]?.world ?? pl.lighthouse.base;
        const out = new THREE.Vector3(Math.sin(kb.doors[0]?.yaw ?? 0), 0, Math.cos(kb.doors[0]?.yaw ?? 0));
        const tp = front.clone().addScaledVector(out, 14);
        truck.place(V(tp.x + 3, 0, tp.z), Math.atan2(-out.z, out.x) + Math.PI);
        const pp = front.clone().addScaledVector(out, 7);
        place(pp.x, pp.z, THREE.MathUtils.radToDeg(Math.atan2(out.x, out.z)), 2);
        break;
      }
      case 'dawn': {
        const kb = this.w.town.byId.get('keeper')!;
        const a = this.anchor('armchair');
        const toward = new THREE.Vector3(0, 0, 2.2).applyMatrix4(kb.matrix).sub(a).setY(0).normalize();
        const pp = a.clone().addScaledVector(toward, 0.9);
        const kbw = this.w.town.byId.get('keeper')!;
        place(pp.x, pp.z, THREE.MathUtils.radToDeg(Math.atan2(-toward.x, -toward.z)), -4, kbw.spec.floorY + 0.02);
        const front = kb.doors[0]?.world ?? pl.lighthouse.base;
        const out = new THREE.Vector3(Math.sin(kb.doors[0]?.yaw ?? 0), 0, Math.cos(kb.doors[0]?.yaw ?? 0));
        const tp = front.clone().addScaledVector(out, 14);
        truck.place(V(tp.x + 3, 0, tp.z), Math.atan2(-out.z, out.x) + Math.PI);
        break;
      }
      case 'wall': {
        place(-188, P.wallZ - 70, 180, 4);
        truck.place(V(P.keeperHouse.x + 10, 0, P.keeperHouse.z - 16), 0);
        break;
      }
    }
    truck.setLights(false, env.preExposure);
    this.w.weather.forceOcclusionUpdate(this.game.engine.camera.position);
  }

  private wrapLockedDoor(door: import('./Interaction').Door, text: string) {
    const it = door.interact as Interactable & { _wrapped?: boolean };
    if (it._wrapped) return;
    it._wrapped = true;
    const orig = it.onUse;
    it.onUse = () => {
      if (door.locked) {
        audio.door('locked', it.pos);
        this.say(text);
        return;
      }
      orig();
    };
  }

  /** Fade to black, run `mid`, fade back (with footsteps on stairs). */
  private transition(text: string, mid: () => void, steps: 'metal' | 'wood' = 'wood') {
    this.game.mode = 'cutscene';
    this.ui.fade(1, 0.8);
    if (text) this.after(0.6, () => this.say(text));
    for (let i = 0; i < 14; i++) this.after(0.9 + i * 0.28, () => audio.footstep(steps, 0.6, undefined, 1));
    this.after(4.9, () => {
      mid();
      this.game.mode = 'walk';
      this.ui.fade(0, 1.2);
    });
  }

  // ======================================================================= per-frame
  update(dt: number) {
    const g = this.game;
    const env = this.env;
    const pl = this.w.places;
    // timers & triggers
    if (this.timers.length) {
      const due: (() => void)[] = [];
      this.timers = this.timers.filter((t) => {
        t.t -= dt;
        if (t.t <= 0) {
          due.push(t.fn);
          return false;
        }
        return true;
      });
      due.forEach((f) => f());
    }
    if (this.triggers.length) {
      const fire: (() => void)[] = [];
      this.triggers = this.triggers.filter((t) => {
        if (t.test()) {
          fire.push(t.fn);
          return false;
        }
        return true;
      });
      fire.forEach((f) => f());
    }
    // follow-the-truck interactables (door handle, dash radio, seat, toolbox in the bed)
    const tb = g.truck.body;
    g.interaction.get('truck')?.pos.copy(tb.localToWorld(V(0.25, 1.15, -1.0)));
    g.interaction.get('workorder')?.pos.copy(tb.localToWorld(V(0.05, 1.15, 0.95)));
    g.interaction.get('flashlight')?.pos.copy(tb.localToWorld(V(-1.05, 1.3, 0.2)));
    // radio dial blinks while dispatch is calling
    this.radioBlink += dt;
    if (this.flags.radioCalling && !this.flags.radioAnswered) {
      const m = g.truck.radioDial.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = (Math.sin(this.radioBlink * 6) > 0 ? 3 : 0.3) * env.preExposure * 0.003;
      if (Math.floor(this.radioBlink / 7) !== Math.floor((this.radioBlink - dt) / 7)) squelch(0.25, 0.18);
    }
    // time of day in town: the sun goes down while you explore (until the power's back)
    if (this.flags.inTown && !this.flags.power && env.time > 16.5) env.timeRate = 0;
    // payphone rings after the power's back, when you're nearby
    if (this.flags.phoneRinging && !this.flags.phoneAnswered) {
      const pp = this.w.dressing.payphone;
      this.phoneT -= dt;
      if (this.phoneT <= 0 && this.player.pos.distanceTo(pp) < 60) {
        this.phoneT = 4;
        audio.phoneRing(pp.clone().add(V(0, 1.6, 0)), 1.8);
      }
    }
    // gate swing
    if (this.flags.gateOpen && this.gateOpen < 1) this.gateOpen = Math.min(1, this.gateOpen + dt * 0.4);
    pl.lhGate.bar.rotation.y = pl.lhGate.yaw + smoothstep(0, 1, this.gateOpen) * 1.75;
    // lighthouse: lamp, lens, beams
    const sunEl = Math.asin(env.sunDir.y) / DEG;
    const night = smoothstep(4, -6, sunEl);
    const lens = pl.lighthouse.lens;
    if (this.flags.lensFixed) this.lensSpeed = Math.min(0.9, this.lensSpeed + dt * 0.06);
    this.lensAngle += this.lensSpeed * dt;
    lens.rotation.y = this.lensAngle;
    pl.lighthouse.beams.rotation.y = this.lensAngle;
    const beamTarget = (0.25 + 0.75 * night) * (this.flags.touched ? 0.5 : 1);
    this.beamLevel = damp(this.beamLevel, beamTarget, 1, dt);
    const bu = (pl.lighthouse.beams.material as THREE.ShaderMaterial).uniforms;
    if (bu.uIntensity) bu.uIntensity.value = this.beamLevel * env.preExposure * 0.1;
    const bull = lens.userData.bullseye as THREE.MeshStandardMaterial;
    bull.emissiveIntensity = 60 * env.preExposure * (0.4 + night);
    // weather-driven audio accent: foghorn in the fog at dawn, bell buoy
    // the hum from the sea
    this.hum = damp(this.hum, this.humTarget, 0.4, dt);
    ambience.state.hum = this.hum;
    // fog bank curtain in front of the wall
    this.bankClear = damp(this.bankClear, this.bankClearTarget, 0.25, dt);
    U.uBankClear.value.set(-190, P.wallZ, 0, this.bankClear);
    // wall
    const wallMat = pl.wall.material as THREE.ShaderMaterial;
    wallMat.uniforms.uSunColor2.value.copy(U.uSunColor.value).multiplyScalar(0.012).add(new THREE.Color().copy(U.uAmbient.value).multiplyScalar(2.2));
    if (this.touchT >= 0) {
      this.touchT += dt;
      wallMat.uniforms.uTouch.value.w = this.touchT;
    }
    if (this.collapseOn) this.collapse = Math.min(1, this.collapse + dt / 30);
    wallMat.uniforms.uCollapse.value = this.collapse;
    if (this.collapse >= 1) pl.wall.visible = false;
    // crowd
    if (this.crowd!.visible) {
      if (this.crowdFadeOn) this.crowdFade = Math.min(1, this.crowdFade + dt / 5);
      this.updateCrowd(dt);
      if (this.crowdFade >= 1) this.crowd!.visible = false;
    }
    // figures on the flats: gone when you get close
    if (pl.figures.visible) {
      pl.figures.children.forEach((f, i) => {
        const d = f.position.distanceTo(this.player.pos);
        const mat = this.figureMats[i * 4];
        const o = smoothstep(22, 48, d) * (this.flags.touched ? 0 : 1);
        f.traverse((m) => {
          const mm = (m as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (mm) mm.opacity = o;
        });
        f.visible = o > 0.01;
        void mat;
      });
    }
    // wall interactable follows the player along the base
    const wi = g.interaction.get('wall');
    if (wi) wi.pos.set(this.player.pos.x, this.player.pos.y + 1.45, P.wallZ - 0.4);
    // the flood
    this.updateFlood(dt);
    // shelter from rain in the truck cab: the particle system handles roofs
    // mud & spray
    void lerp;
    void clamp;
    void TRAIL;
  }

  private updateFlood(dt: number) {
    const sea = this.w.water.sea;
    const sm = sea.material as THREE.ShaderMaterial;
    const pz = this.player.pos.z;
    if (this.collapseOn) this.seaReturn = Math.min(1, this.seaReturn + dt * 0.25);
    ambience.state.seaReturn = this.seaReturn * (this.endT >= 0 ? 0.4 : 1);
    if (!this.front.active) return;
    sea.visible = true;
    sea.position.y = 0;
    sm.uniforms.uFlood.value = 1;
    // rubber-band the front to the player so the escape is tense but fair
    const gap = pz - this.front.z; // negative: the water is behind (south of) the player
    const onTower = this.player.pos.y > this.w.places.tower.base.y + 9;
    // cruises a little under running pace: sprinting opens a gap of ~35 m, walking gets caught
    let speed = RUN_SPEED - 1.6 + clamp((this.front.z - pz - 22) * 0.12, -1.2, 5);
    if (onTower || this.front.z < this.w.places.tower.base.z - 30) speed = 12;
    this.front.speed = damp(this.front.speed, speed, 1.5, dt);
    this.front.z -= this.front.speed * dt;
    sm.uniforms.uFrontZ.value = this.front.z;
    sm.uniforms.uBoreH.value = this.front.z > 260 ? 14 : Math.max(0, (this.front.z - 150) / 110) * 14;
    this.seaLevel = Math.min(0.2, this.seaLevel + dt * 0.25);
    sm.uniforms.uSeaLevel.value = this.seaLevel;
    if (this.spray) {
      const su = (this.spray.material as THREE.ShaderMaterial).uniforms;
      const boreH = sm.uniforms.uBoreH.value as number;
      this.spray.visible = boreH > 0.5;
      su.uFrontZ.value = this.front.z;
      su.uCrest.value = this.w.terrain.heightAt(this.player.pos.x, this.front.z + 8) + boreH * 0.55;
      su.uT.value += dt;
      su.uAmount.value = Math.min(1, boreH / 8);
    }
    if (this.front.z < 700) this.w.water.flats.visible = false;
    // caught?
    if (!onTower && gap > -1.5 && this.gameOverT < 0 && this.player.pos.y < this.w.terrain.heightAt(this.player.pos.x, pz) + 3) this.gameOver();
    // the tower shakes as the bore passes
    const dTower = Math.abs(this.front.z - this.w.places.tower.base.z);
    if (onTower && dTower < 25) this.player.shake = Math.max(this.player.shake, 1 - dTower / 25);
    if (this.front.z < 450 && this.endT < 0 && onTower) this.ending();
    if (this.front.z < -300) this.front.active = false;
    void gap;
  }
}

/** A standing person, facing +z, feet at y=0 (about 1.75 m). */
export function personGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const cap = (r: number, len: number, x: number, y: number, z: number, rz = 0, sx = 1, sz = 1) => {
    const g = new THREE.CapsuleGeometry(r, len, 3, 8);
    g.scale(sx, 1, sz);
    g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g);
  };
  cap(0.075, 0.72, 0.1, 0.46, 0); // legs
  cap(0.075, 0.72, -0.1, 0.46, 0);
  cap(0.2, 0.42, 0, 1.18, 0, 0, 1.18, 0.62); // torso
  cap(0.13, 0.1, 0, 0.9, 0, 0, 1.25, 0.8); // hips
  cap(0.05, 0.58, 0.29, 1.08, 0.02, 0.08); // arms
  cap(0.05, 0.58, -0.29, 1.08, 0.02, -0.08);
  cap(0.045, 0.08, 0, 1.52, 0); // neck
  parts.push(new THREE.SphereGeometry(0.11, 12, 10).scale(0.9, 1.1, 1).translate(0, 1.66, 0.01));
  return mergeGeos(parts);
}

function mergeGeos(geos: THREE.BufferGeometry[]) {
  // minimal merge (position/normal/index) to avoid pulling in addons
  let vCount = 0,
    iCount = 0;
  const gs = geos.map((g) => (g.index ? g : g.toNonIndexed()));
  for (const g of gs) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3),
    nor = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0,
    io = 0;
  for (const g of gs) {
    pos.set(g.attributes.position.array as Float32Array, vo * 3);
    nor.set(g.attributes.normal.array as Float32Array, vo * 3);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) idx[io + i] = src[i] + vo;
      io += src.length;
    } else {
      for (let i = 0; i < g.attributes.position.count; i++) idx[io + i] = vo + i;
      io += g.attributes.position.count;
    }
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
