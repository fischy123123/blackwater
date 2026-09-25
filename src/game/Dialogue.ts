// Sequenced lines: radio voices (synthesised, with squelch) and the player's own words/thoughts.
import { speak, squelch, staticBed } from '../audio/Voice';
import type { UI } from '../ui/UI';

export type Speaker = 'ruth' | 'wren' | 'wrenTape' | 'you' | 'thought';
export type Line = { who: Speaker; text: string; pause?: number; noSquelch?: boolean; onStart?: () => void };

const NAMES: Record<string, string> = { ruth: 'Ruth · dispatch', wren: 'Wren', wrenTape: 'Recording', you: 'You' };

export class Dialogue {
  private queue: { line: Line; done?: () => void }[] = [];
  private timer = 0;
  private currentDone: (() => void) | undefined;
  private lastRadio = false;
  private staticLevel: ((v: number) => void) | null = null;
  private staticTarget = 0;
  private staticNow = 0;
  busy = false;

  constructor(private ui: UI) {}

  /** Queue lines; `done` fires after the last one has finished. */
  play(lines: Line[], done?: () => void) {
    if (!lines.length) {
      done?.();
      return;
    }
    lines.forEach((line, i) => this.queue.push({ line, done: i === lines.length - 1 ? done : undefined }));
  }

  say(text: string, pause = 0.4) {
    this.play([{ who: 'thought', text, pause }]);
  }

  clear() {
    this.queue = [];
    this.timer = 0;
    this.currentDone = undefined;
    this.busy = false;
    this.staticTarget = 0;
  }

  /** Background radio hiss while a transmission is up (0..1). */
  setStatic(v: number) {
    this.staticTarget = v;
  }

  update(dt: number) {
    if (!this.staticLevel && (this.staticTarget > 0 || this.staticNow > 0.001)) this.staticLevel = staticBed();
    this.staticNow += (this.staticTarget - this.staticNow) * Math.min(1, dt * 3);
    this.staticLevel?.(this.staticNow);
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer > 0) return;
      const cb = this.currentDone;
      this.currentDone = undefined;
      cb?.();
    }
    const next = this.queue.shift();
    if (!next) {
      if (this.busy && this.lastRadio) squelch(0.12, 0.15);
      this.busy = false;
      this.lastRadio = false;
      return;
    }
    this.busy = true;
    const l = next.line;
    l.onStart?.();
    let dur: number;
    if (l.who === 'thought' || l.who === 'you') {
      dur = Math.max(2.0, l.text.length * 0.058);
      if (l.text) this.ui.subtitle(l.who === 'you' ? 'You' : null, l.text, dur + 0.4, true);
      this.lastRadio = false;
    } else {
      if (!l.noSquelch && !this.lastRadio) squelch(0.2, 0.22);
      dur = speak(l.text, l.who, 0.12);
      this.ui.subtitle(NAMES[l.who], l.text, dur + 0.7);
      this.lastRadio = true;
    }
    this.timer = dur + (l.pause ?? 0.45);
    this.currentDone = next.done;
  }
}
