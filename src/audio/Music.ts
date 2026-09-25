// Sparse score: slow pads, a detuned piano, a wordless choir and a low pulse.
// Used for a handful of story moments; most of the game is carried by ambience.
import { audio } from './AudioEngine';

const NOTE = (n: string) => {
  const m = /^([A-G])(#|b)?(\d)$/.exec(n)!;
  const base: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  let s = base[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * Math.pow(2, s / 12);
};

export class Music {
  private active: { stop: (t: number) => void }[] = [];

  private get a() {
    return audio;
  }

  pad(notes: string[], dur: number, gain = 0.1, attack = 3, release = 5, cutoff = 900) {
    const a = this.a;
    if (!a.ctx) return;
    const ctx = a.ctx;
    const t = a.now;
    const lp = a.filter('lowpass', cutoff, 0.6);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = a.gain(cutoff * 0.4);
    lfo.connect(lfoG).connect(lp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + Math.max(attack, dur - release));
    g.gain.linearRampToValueAtTime(0, t + dur);
    lp.connect(g);
    a.out(g, { bus: a.music, wetLarge: 0.8 });
    const oscs: OscillatorNode[] = [lfo];
    for (const n of notes) {
      const f = NOTE(n);
      for (const det of [-6, 5]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const og = a.gain(0.18 / notes.length);
        o.connect(og).connect(lp);
        oscs.push(o);
      }
      const sub = ctx.createOscillator();
      sub.frequency.value = f / 2;
      const sg = a.gain(0.12 / notes.length);
      sub.connect(sg).connect(lp);
      oscs.push(sub);
    }
    for (const o of oscs) {
      o.start(t);
      o.stop(t + dur + 0.1);
    }
    const h = {
      stop: (tt: number) => {
        g.gain.cancelScheduledValues(tt);
        g.gain.setTargetAtTime(0, tt, 1.2);
        for (const o of oscs) o.stop(tt + 5);
      },
    };
    this.active.push(h);
  }

  piano(n: string, when = 0, gain = 0.12) {
    const a = this.a;
    if (!a.ctx) return;
    const f = NOTE(n);
    const t = a.now + when;
    const partials: [number, number, number][] = [
      [1, 1, 3.2],
      [2.003, 0.45, 2.2],
      [3.01, 0.22, 1.4],
      [4.03, 0.12, 1.0],
      [5.05, 0.06, 0.7],
    ];
    for (const [r, amp, dec] of partials) a.tone({ f: f * r, decay: dec, gain: gain * amp, when: t, attack: 0.004, bus: a.music, wetLarge: 0.9 });
    // hammer thump
    a.burst({ type: 'pink', f: f * 2, q: 1, decay: 0.05, gain: gain * 0.2, when: t, bus: a.music });
  }

  /** Wordless "aah" choir: saws through fixed vowel formants. */
  choir(notes: string[], dur: number, gain = 0.08) {
    const a = this.a;
    if (!a.ctx) return;
    const ctx = a.ctx;
    const t = a.now;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(gain, t + 5);
    out.gain.setValueAtTime(gain, t + dur - 6);
    out.gain.linearRampToValueAtTime(0, t + dur);
    a.out(out, { bus: a.music, wetLarge: 1.0 });
    const forms = [
      [700, 1.0],
      [1150, 0.5],
      [2600, 0.18],
    ];
    const bank = forms.map(([f, amp]) => {
      const bp = a.filter('bandpass', f, 7);
      const g = a.gain(amp);
      bp.connect(g).connect(out);
      return bp;
    });
    const oscs: OscillatorNode[] = [];
    for (const n of notes)
      for (let v = 0; v < 3; v++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = NOTE(n);
        o.detune.value = (v - 1) * 9 + Math.random() * 4;
        const vib = ctx.createOscillator();
        vib.frequency.value = 4.5 + Math.random();
        const vg = a.gain(3);
        vib.connect(vg).connect(o.detune);
        const g = a.gain(0.15 / notes.length);
        o.connect(g);
        for (const b of bank) g.connect(b);
        oscs.push(o, vib);
      }
    for (const o of oscs) {
      o.start(t);
      o.stop(t + dur + 0.2);
    }
  }

  /** Low heartbeat-like pulse for danger. */
  pulse(bpm: number, beats: number, gain = 0.5) {
    const a = this.a;
    if (!a.ctx) return;
    const period = 60 / bpm;
    for (let i = 0; i < beats; i++) {
      const t = i * period;
      a.tone({ f: 58, fEnd: 38, decay: 0.25, gain, when: a.now + t, bus: a.music });
      a.tone({ f: 52, fEnd: 36, decay: 0.2, gain: gain * 0.6, when: a.now + t + 0.22, bus: a.music });
    }
  }

  stopAll(fade = 3) {
    const t = this.a.now;
    for (const h of this.active) h.stop(t + 0.01);
    this.active = [];
    void fade;
  }

  cue(name: string) {
    switch (name) {
      case 'arrival':
        this.pad(['D3', 'A3', 'E4', 'F4'], 26, 0.07, 6, 8, 700);
        ['A4', 'F5', 'E5', 'D5', 'A4', 'C5'].forEach((n, i) => this.piano(n, 4 + i * 2.6 + (i > 2 ? 1.3 : 0), 0.07));
        break;
      case 'unease':
        this.pad(['D2', 'Ab2', 'D3'], 30, 0.06, 8, 10, 400);
        break;
      case 'power':
        this.pad(['F2', 'C3', 'G3', 'A3'], 24, 0.08, 4, 10, 1100);
        ['C5', 'A4', 'G4', 'F4'].forEach((n, i) => this.piano(n, 6 + i * 2.2, 0.06));
        break;
      case 'storm':
        this.pad(['C2', 'G2', 'Db3'], 40, 0.05, 10, 12, 500);
        break;
      case 'lighthouse':
        this.pad(['F3', 'C4', 'E4', 'A4'], 34, 0.07, 6, 10, 900);
        ['E5', 'C5', 'A4', 'G4', 'E5', 'F5'].forEach((n, i) => this.piano(n, 3 + i * 2.8, 0.06));
        break;
      case 'dawn':
        this.pad(['C3', 'G3', 'D4', 'E4'], 40, 0.07, 10, 12, 1300);
        break;
      case 'wall':
        this.choir(['D3', 'A3', 'F4', 'C5'], 48, 0.1);
        this.pad(['D1', 'D2', 'A2'], 48, 0.1, 8, 12, 300);
        break;
      case 'escape':
        this.pulse(96, 60, 0.45);
        this.pad(['D2', 'Eb2', 'A2'], 38, 0.08, 1, 6, 600);
        break;
      case 'ending':
        this.pad(['F3', 'C4', 'G4', 'A4'], 60, 0.08, 8, 16, 1000);
        ['A4', 'C5', 'G4', 'F4', 'A4', 'E5', 'D5', 'C5'].forEach((n, i) => this.piano(n, 4 + i * 3.1, 0.07));
        break;
    }
  }
}

export const music = new Music();
