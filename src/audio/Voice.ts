// Formant-synthesised "radio voices": a glottal pulse train through vowel formants,
// shaped by the syllable rhythm of the actual line so it matches the subtitle.
import { audio } from './AudioEngine';

export type VoiceProfile = { pitch: number; formant: number; breathy: number; rate: number; gain: number; radio: boolean };

export const VOICES: Record<string, VoiceProfile> = {
  ruth: { pitch: 196, formant: 1.12, breathy: 0.15, rate: 1.05, gain: 0.55, radio: true },
  wren: { pitch: 172, formant: 1.07, breathy: 0.3, rate: 0.9, gain: 0.5, radio: true },
  wrenTape: { pitch: 168, formant: 1.06, breathy: 0.25, rate: 0.88, gain: 0.45, radio: true },
  man: { pitch: 112, formant: 1.0, breathy: 0.2, rate: 1.0, gain: 0.55, radio: true },
};

const FORMANTS: Record<string, [number, number, number]> = {
  a: [800, 1200, 2500],
  e: [450, 1900, 2600],
  i: [300, 2300, 3000],
  o: [480, 850, 2500],
  u: [330, 900, 2300],
  y: [320, 2100, 2800],
  r: [420, 1300, 1700],
};

type Syl = { vowel: string; onset: 'fric' | 'plos' | 'nasal' | 'none'; dur: number; pause: number; stress: number };

function syllabify(text: string, rate: number): Syl[] {
  const out: Syl[] = [];
  const words = text.replace(/[—–]/g, ',').split(/\s+/);
  for (const raw of words) {
    const w = raw.toLowerCase();
    const letters = w.replace(/[^a-z']/g, '');
    const groups = letters.match(/[aeiouy]+/g) ?? (letters.length ? ['a'] : []);
    const cons = letters.split(/[aeiouy]+/);
    groups.forEach((g, i) => {
      const c = cons[i] ?? '';
      const first = c[0] ?? '';
      const onset: Syl['onset'] = /[sfzhxv]|th|sh|ch/.test(c) ? 'fric' : /[ptkbdgcq]/.test(first) ? 'plos' : /[mnl]/.test(first) ? 'nasal' : 'none';
      const v = g[0] === 'y' && g.length > 1 ? g[1] : g[0];
      out.push({ vowel: v, onset, dur: (0.1 + Math.random() * 0.07 + (g.length > 1 ? 0.04 : 0)) / rate, pause: 0, stress: i === 0 ? 1 : 0.75 });
    });
    if (out.length) {
      const last = out[out.length - 1];
      last.pause = 0.03 / rate;
      if (/[,;:]$/.test(raw)) last.pause = 0.22 / rate;
      if (/[.!?…]$/.test(raw)) last.pause = 0.42 / rate;
      if (/\.\.\.$|…$/.test(raw)) last.pause = 0.7 / rate;
    }
  }
  return out;
}

/** Speak a line; returns its duration in seconds. */
export function speak(text: string, voiceName: keyof typeof VOICES | VoiceProfile, when = 0): number {
  const a = audio;
  const v = typeof voiceName === 'string' ? VOICES[voiceName] : voiceName;
  const syl = syllabify(text, v.rate);
  let total = 0;
  for (const s of syl) total += s.dur + s.pause;
  if (!a.ctx) return total + 0.3;
  const ctx = a.ctx;
  const t0 = a.now + 0.05 + when;
  // source
  const src = ctx.createOscillator();
  src.type = 'sawtooth';
  const breath = a.noise('pink', true);
  const breathG = ctx.createGain();
  breathG.gain.value = v.breathy * 0.3;
  const srcG = ctx.createGain();
  srcG.gain.value = 0;
  const f1 = ctx.createBiquadFilter(),
    f2 = ctx.createBiquadFilter(),
    f3 = ctx.createBiquadFilter();
  for (const f of [f1, f2, f3]) {
    f.type = 'bandpass';
    f.Q.value = 9;
  }
  const g1 = a.gain(1.0),
    g2 = a.gain(0.55),
    g3 = a.gain(0.28);
  const mix = ctx.createGain();
  src.connect(srcG);
  breath.connect(breathG).connect(srcG);
  srcG.connect(f1).connect(g1).connect(mix);
  srcG.connect(f2).connect(g2).connect(mix);
  srcG.connect(f3).connect(g3).connect(mix);
  // consonants
  const fric = a.noise('white', true);
  const fricF = a.filter('highpass', 3500, 0.7);
  const fricG = ctx.createGain();
  fricG.gain.value = 0;
  fric.connect(fricF).connect(fricG).connect(mix);
  // radio chain
  let chainOut: AudioNode = mix;
  if (v.radio) {
    const hp = a.filter('highpass', 380, 0.7);
    const lp = a.filter('lowpass', 2900, 0.9);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      const x = (i / 511) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    mix.connect(hp).connect(lp).connect(shaper);
    chainOut = shaper;
  }
  const outG = a.gain(v.gain);
  chainOut.connect(outG).connect(a.radio);
  // intonation + syllables
  let t = t0;
  const words = syl.length;
  syl.forEach((s, i) => {
    const phrasePos = i / Math.max(1, words - 1);
    const p = v.pitch * (1.08 - 0.16 * phrasePos) * (0.95 + 0.1 * Math.random()) * (s.stress > 0.9 ? 1.06 : 1);
    src.frequency.setTargetAtTime(p, t, 0.03);
    const F = FORMANTS[s.vowel] ?? FORMANTS.a;
    f1.frequency.setTargetAtTime(F[0] * v.formant, t, 0.02);
    f2.frequency.setTargetAtTime(F[1] * v.formant, t, 0.02);
    f3.frequency.setTargetAtTime(F[2] * v.formant, t, 0.02);
    const on = s.onset;
    if (on === 'fric') {
      fricG.gain.setValueAtTime(0, t);
      fricG.gain.linearRampToValueAtTime(0.25, t + 0.02);
      fricG.gain.linearRampToValueAtTime(0, t + 0.07);
    } else if (on === 'plos') {
      fricG.gain.setValueAtTime(0.4, t);
      fricG.gain.linearRampToValueAtTime(0, t + 0.015);
    }
    const vs = t + (on === 'fric' ? 0.05 : on === 'plos' ? 0.02 : 0);
    srcG.gain.setValueAtTime(0.0001, vs);
    srcG.gain.linearRampToValueAtTime(0.6 * s.stress, vs + 0.025);
    srcG.gain.setValueAtTime(0.55 * s.stress, vs + s.dur * 0.7);
    srcG.gain.linearRampToValueAtTime(0.0001, t + s.dur);
    t += s.dur + s.pause;
  });
  src.start(t0);
  breath.start(t0);
  fric.start(t0);
  src.stop(t + 0.1);
  breath.stop(t + 0.1);
  fric.stop(t + 0.1);
  return total + 0.1;
}

/** Radio static / squelch burst. */
export function squelch(dur = 0.25, gain = 0.25) {
  const a = audio;
  if (!a.ctx) return;
  a.burst({ type: 'white', f: 1800, q: 0.4, attack: 0.005, decay: dur, gain, bus: a.radio });
  a.burst({ type: 'white', f: 3200, q: 2, attack: 0.001, decay: 0.03, gain: gain * 1.5, bus: a.radio, when: a.now + dur });
}

/** Continuous radio static bed; returns a setter for its level. */
export function staticBed() {
  const a = audio;
  if (!a.ctx) return (_v: number) => {};
  const n = a.noise('white', true);
  const f = a.filter('bandpass', 1600, 0.6);
  const g = a.gain(0);
  n.connect(f).connect(g).connect(a.radio);
  n.start();
  // crackles
  let level = 0;
  const crackle = () => {
    if (level > 0.01) a.burst({ type: 'white', f: 2500 + Math.random() * 3000, q: 3, decay: 0.01, gain: level * (0.3 + Math.random()), bus: a.radio });
    setTimeout(crackle, 30 + Math.random() * 220);
  };
  crackle();
  return (v: number) => {
    level = v;
    g.gain.setTargetAtTime(v * 0.08, a.now, 0.1);
  };
}
