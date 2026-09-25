// Minimal, diegetic-leaning interface. Everything lives in one overlay.
import type { Input } from '../core/Input';

export type Settings = { sensitivity: number; invertY: boolean; volume: number; quality: string; subtitles: boolean };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export class UI {
  root: HTMLElement;
  loading: HTMLElement;
  loadBar: HTMLElement;
  loadLabel: HTMLElement;
  title: HTMLElement;
  hud: HTMLElement;
  reticle: HTMLElement;
  prompt: HTMLElement;
  subs: HTMLElement;
  hint: HTMLElement;
  card: HTMLElement;
  doc: HTMLElement;
  docBody: HTMLElement;
  pause: HTMLElement;
  touch: HTMLElement;
  stickBase: HTMLElement;
  stickKnob: HTMLElement;
  actBtn: HTMLElement;
  flashBtn: HTMLElement;
  menuBtn: HTMLElement;
  notebookBtn: HTMLElement;
  notebook: HTMLElement;
  fadeEl: HTMLElement;
  panel: HTMLElement;
  binoc: HTMLElement;
  credits: HTMLElement;
  savedEl: HTMLElement;
  panelOpen = false;
  private panelItems: { id: string; label: string; on: boolean; tag?: string }[] = [];
  private panelFocus = 0;
  private onPanelToggle: ((id: string) => void) | null = null;
  private onPanelClose: (() => void) | null = null;
  private padPrev: boolean[] = [];
  settings: Settings;
  onBegin: ((cont: boolean) => void) | null = null;
  onSettings: ((s: Settings) => void) | null = null;
  onRestart: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onDocClose: (() => void) | null = null;
  docOpen = false;
  paused = false;
  private subTimer = 0;
  private hintTimer = 0;
  private cardTimer = 0;
  private input: Input | null = null;
  touchUI = false;

  constructor() {
    this.settings = this.loadSettings();
    this.root = el('div', 'ui');
    document.body.appendChild(this.root);

    // Loading
    this.loading = el('div', 'loading');
    this.loading.innerHTML = `<div class="load-title">BLACKWATER</div><div class="load-line"><div class="load-bar"></div></div><div class="load-label">&nbsp;</div>`;
    this.root.appendChild(this.loading);
    this.loadBar = this.loading.querySelector('.load-bar')!;
    this.loadLabel = this.loading.querySelector('.load-label')!;

    // Title
    this.title = el('div', 'title hidden');
    this.title.innerHTML = `
      <div class="title-inner">
        <h1 class="title-word">BLACKWATER</h1>
        <p class="title-tag">The tide went out on Tuesday. It hasn’t come back.</p>
        <div class="title-actions">
          <button class="btn primary" id="btn-begin">Begin</button>
          <button class="btn" id="btn-continue" hidden>Continue</button>
          <button class="btn ghost" id="btn-settings">Settings</button>
        </div>
        <p class="title-note"><span class="desk">Mouse &amp; keyboard or controller · WASD to walk · E to interact · F flashlight</span><span class="mob">Drag the left side to walk · drag the right side to look · tap things to use them</span></p>
        <p class="title-note small">Best with headphones<span class="rotate-hint"> · turn your phone sideways</span></p>
      </div>`;
    this.root.appendChild(this.title);

    // HUD
    this.hud = el('div', 'hud hidden');
    this.reticle = el('div', 'reticle');
    this.prompt = el('div', 'prompt');
    this.subs = el('div', 'subs');
    this.hint = el('div', 'hint');
    this.card = el('div', 'card');
    this.hud.append(this.reticle, this.prompt, this.subs, this.hint, this.card);
    this.root.appendChild(this.hud);

    // Document viewer
    this.doc = el('div', 'doc hidden');
    this.doc.innerHTML = `<div class="doc-paper"><div class="doc-body"></div></div><button class="doc-close" aria-label="Close">✕</button><div class="doc-hint"></div>`;
    this.docBody = this.doc.querySelector('.doc-body')!;
    this.root.appendChild(this.doc);
    this.doc.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.doc-paper') && !(e.target as HTMLElement).classList.contains('doc-close')) return;
      this.closeDoc();
    });
    this.doc.querySelector('.doc-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDoc();
    });
    addEventListener('keydown', (e) => {
      if (!this.docOpen) return;
      if (['KeyE', 'Escape', 'Enter', 'Space', 'Backspace'].includes(e.code)) {
        e.preventDefault();
        this.closeDoc();
      }
    });

    // Notebook (current thought / collected notes)
    this.notebook = el('div', 'notebook hidden');
    this.root.appendChild(this.notebook);
    this.notebook.addEventListener('click', () => this.toggleNotebook(false));

    // Pause
    this.pause = el('div', 'pause hidden');
    this.pause.innerHTML = `
      <div class="pause-inner">
        <div class="pause-title">Paused</div>
        <button class="btn primary" id="btn-resume">Resume</button>
        <div class="settings">
          <label for="set-sens">Look sensitivity <input id="set-sens" type="range" min="0.3" max="2.5" step="0.05"></label>
          <label for="set-vol">Volume <input id="set-vol" type="range" min="0" max="1" step="0.05"></label>
          <label class="check" for="set-inv"><input id="set-inv" type="checkbox"> Invert look</label>
          <label class="check" for="set-subs"><input id="set-subs" type="checkbox"> Subtitles</label>
          <label for="set-q">Quality <select id="set-q"><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option></select></label>
          <p class="small">Quality changes apply after a reload.</p>
        </div>
        <button class="btn ghost" id="btn-restart">Restart from last checkpoint</button>
      </div>`;
    this.root.appendChild(this.pause);

    // Touch controls
    this.touch = el('div', 'touch hidden');
    this.stickBase = el('div', 'stick-base');
    this.stickKnob = el('div', 'stick-knob');
    this.stickBase.appendChild(this.stickKnob);
    this.actBtn = el('button', 'tbtn act hidden', '');
    this.flashBtn = el('button', 'tbtn flash hidden', flashIcon());
    this.flashBtn.setAttribute('aria-label', 'Flashlight');
    this.menuBtn = el('button', 'tbtn menu', menuIcon());
    this.menuBtn.setAttribute('aria-label', 'Menu');
    this.notebookBtn = el('button', 'tbtn nb', bookIcon());
    this.notebookBtn.setAttribute('aria-label', 'Notebook');
    this.touch.append(this.stickBase, this.actBtn, this.flashBtn, this.menuBtn, this.notebookBtn);
    this.root.appendChild(this.touch);

    // Breaker panel close-up
    this.panel = el('div', 'panel hidden');
    this.panel.innerHTML = `<div class="panel-box"><div class="panel-plate">HARROW CO. COMMUNICATIONS · BLACKWATER RELAY<br><span>240 V DISTRIBUTION — FEEDERS</span></div><div class="panel-row"></div><div class="panel-meter"><span class="lamp"></span><span class="panel-status">NO SUPPLY</span></div></div><button class="doc-close" aria-label="Close">✕</button><div class="doc-hint"></div>`;
    this.root.appendChild(this.panel);
    this.panel.querySelector('.doc-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePanel();
    });
    this.panel.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.panel-box')) this.closePanel();
    });
    addEventListener('keydown', (e) => {
      if (!this.panelOpen) return;
      const n = Number(e.key);
      if (n >= 1 && n <= this.panelItems.length) this.onPanelToggle?.(this.panelItems[n - 1].id);
      else if (e.code === 'ArrowLeft') this.movePanelFocus(-1);
      else if (e.code === 'ArrowRight') this.movePanelFocus(1);
      else if (e.code === 'Space' || e.code === 'Enter') this.onPanelToggle?.(this.panelItems[this.panelFocus].id);
      else if (e.code === 'Escape' || e.code === 'KeyE' || e.code === 'Backspace') this.closePanel();
    });

    // Binocular mask
    this.binoc = el('div', 'binoc hidden');
    this.binoc.innerHTML = `<div class="binoc-hint"></div>`;
    this.root.appendChild(this.binoc);

    // Credits
    this.credits = el('div', 'credits hidden');
    this.root.appendChild(this.credits);

    this.savedEl = el('div', 'saved', 'Progress saved');
    this.root.appendChild(this.savedEl);

    this.fadeEl = el('div', 'fade');
    this.root.appendChild(this.fadeEl);

    this.bindSettings();
  }

  attachInput(input: Input) {
    this.input = input;
    const tap = (btn: HTMLElement, fn: () => void) => {
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    };
    tap(this.actBtn, () => input.press('interact'));
    tap(this.flashBtn, () => input.press('flashlight'));
    tap(this.menuBtn, () => input.press('pause'));
    tap(this.notebookBtn, () => input.press('journal'));
    input.onStickChange = () => {
      const s = input.stick;
      if (!s.active) {
        this.stickBase.classList.remove('on');
        return;
      }
      this.stickBase.classList.add('on');
      const R = input.stickRadius();
      this.stickBase.style.width = this.stickBase.style.height = `${R * 2}px`;
      this.stickBase.style.left = `${s.ox - R}px`;
      this.stickBase.style.top = `${s.oy - R}px`;
      let dx = s.x - s.ox,
        dy = s.y - s.oy;
      const d = Math.hypot(dx, dy);
      if (d > R) {
        dx = (dx / d) * R;
        dy = (dy / d) * R;
      }
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
  }

  setTouchUI(on: boolean) {
    this.touchUI = on;
    // on-screen controls only once play has begun
    this.touch.classList.toggle('hidden', !on || this.hud.classList.contains('hidden'));
    document.body.classList.toggle('is-touch', on);
  }

  // ---------------------------------------------------------------- loading / title
  setProgress(p: number, label: string) {
    this.loadBar.style.transform = `scaleX(${Math.max(0.02, p)})`;
    this.loadLabel.textContent = label;
  }

  hideLoading() {
    this.loading.classList.add('gone');
    setTimeout(() => this.loading.remove(), 1600);
  }

  showTitle(hasSave: boolean) {
    this.title.classList.remove('hidden');
    const cont = this.title.querySelector('#btn-continue') as HTMLButtonElement;
    cont.hidden = !hasSave;
    const begin = this.title.querySelector('#btn-begin') as HTMLButtonElement;
    begin.textContent = hasSave ? 'New game' : 'Begin';
    begin.onclick = () => this.onBegin?.(false);
    cont.onclick = () => this.onBegin?.(true);
    (this.title.querySelector('#btn-settings') as HTMLButtonElement).onclick = () => this.showPause(true);
    requestAnimationFrame(() => this.title.classList.add('in'));
  }

  hideTitle() {
    this.title.classList.remove('in');
    this.title.classList.add('out');
    setTimeout(() => this.title.classList.add('hidden'), 1500);
    this.hud.classList.remove('hidden');
    if (this.touchUI) this.touch.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- HUD
  setFocus(label: string | null, verb?: string) {
    if (!label) {
      this.reticle.classList.remove('focus');
      this.prompt.classList.remove('on');
      this.actBtn.classList.add('hidden');
      return;
    }
    this.reticle.classList.add('focus');
    const key = this.touchUI ? '' : `<span class="key">E</span>`;
    this.prompt.innerHTML = `${key}<span class="verb">${verb ?? 'Use'}</span><span class="obj">${label}</span>`;
    this.prompt.classList.add('on');
    if (this.touchUI) {
      this.actBtn.innerHTML = `<span>${verb ?? 'Use'}</span>`;
      this.actBtn.classList.remove('hidden');
    }
  }

  setReticleVisible(v: boolean) {
    this.reticle.style.opacity = v ? '' : '0';
  }

  subtitle(speaker: string | null, text: string, seconds: number, force = false) {
    if (!force && !this.settings.subtitles && speaker) return;
    this.subs.innerHTML = speaker ? `<span class="who">${speaker}</span><span class="line">${text}</span>` : `<span class="line thought">${text}</span>`;
    this.subs.classList.add('on');
    this.subTimer = seconds;
  }

  showHint(text: string, seconds = 5) {
    this.hint.innerHTML = text;
    this.hint.classList.add('on');
    this.hintTimer = seconds;
  }

  showCard(html: string, seconds = 6) {
    this.card.innerHTML = html;
    this.card.classList.add('on');
    this.cardTimer = seconds;
  }

  setFlashButton(visible: boolean, on: boolean) {
    this.flashBtn.classList.toggle('hidden', !visible || !this.touchUI);
    this.flashBtn.classList.toggle('lit', on);
  }

  fade(to: number, seconds: number) {
    this.fadeEl.style.transition = `opacity ${seconds}s ease`;
    this.fadeEl.style.opacity = String(to);
  }

  update(dt: number) {
    this.pollPad();
    if (this.subTimer > 0) {
      this.subTimer -= dt;
      if (this.subTimer <= 0) this.subs.classList.remove('on');
    }
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hint.classList.remove('on');
    }
    if (this.cardTimer > 0) {
      this.cardTimer -= dt;
      if (this.cardTimer <= 0) this.card.classList.remove('on');
    }
  }

  // ---------------------------------------------------------------- breaker panel
  showPanel(items: { id: string; label: string; on: boolean; tag?: string }[], powered: boolean, onToggle: (id: string) => void, onClose: () => void) {
    this.onPanelToggle = onToggle;
    this.onPanelClose = onClose;
    this.panelOpen = true;
    this.panelFocus = 0;
    this.refreshPanel(items, powered);
    this.panel.classList.remove('hidden');
    requestAnimationFrame(() => this.panel.classList.add('in'));
    (this.panel.querySelector('.doc-hint') as HTMLElement).textContent = this.touchUI ? 'Tap a breaker to flip it · tap outside to step back' : 'Click a breaker (or 1–4) to flip it · E / Esc to step back';
  }

  refreshPanel(items: { id: string; label: string; on: boolean; tag?: string }[], powered: boolean) {
    this.panelItems = items;
    const row = this.panel.querySelector('.panel-row') as HTMLElement;
    row.innerHTML = '';
    items.forEach((it, i) => {
      const b = el('button', `brk ${it.on ? 'on' : 'off'}${i === this.panelFocus ? ' focus' : ''}${it.id === 'main' ? ' main' : ''}`);
      b.innerHTML = `<span class="brk-num">${i + 1}</span><span class="brk-label">${it.label}</span><span class="brk-slot"><span class="brk-handle"></span></span><span class="brk-state">${it.on ? 'ON' : 'OFF'}</span>${it.tag ? `<span class="brk-tag">${it.tag}</span>` : ''}`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.panelFocus = i;
        this.onPanelToggle?.(it.id);
      });
      row.appendChild(b);
    });
    this.panel.querySelector('.lamp')!.classList.toggle('lit', powered);
    (this.panel.querySelector('.panel-status') as HTMLElement).textContent = powered ? 'SUPPLY OK' : 'NO SUPPLY';
  }

  private movePanelFocus(d: number) {
    this.panelFocus = (this.panelFocus + d + this.panelItems.length) % this.panelItems.length;
    this.panel.querySelectorAll('.brk').forEach((b, i) => b.classList.toggle('focus', i === this.panelFocus));
  }

  closePanel() {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.panel.classList.remove('in');
    setTimeout(() => this.panel.classList.add('hidden'), 300);
    const cb = this.onPanelClose;
    this.onPanelClose = null;
    cb?.();
  }

  // ---------------------------------------------------------------- binoculars, credits, saved
  setBinoculars(on: boolean) {
    this.binoc.classList.toggle('hidden', !on);
    (this.binoc.querySelector('.binoc-hint') as HTMLElement).textContent = on ? (this.touchUI ? 'Tap to lower the binoculars' : 'E to lower the binoculars') : '';
    this.hud.classList.toggle('dim', on);
  }

  showCredits(html: string, onAgain: () => void) {
    this.credits.innerHTML = `<div class="cr-inner">${html}<div class="cr-actions"><button class="btn" id="btn-again">Play again</button></div></div>`;
    this.credits.classList.remove('hidden');
    requestAnimationFrame(() => this.credits.classList.add('in'));
    (this.credits.querySelector('#btn-again') as HTMLButtonElement).onclick = () => onAgain();
    this.hud.classList.add('hidden');
    this.touch.classList.add('hidden');
  }

  saved() {
    this.savedEl.classList.add('on');
    setTimeout(() => this.savedEl.classList.remove('on'), 2200);
  }

  /** Gamepad control for overlays (documents, panel, notebook) while gameplay input is paused. */
  private pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = Array.from(pads).find((g) => g && g.connected);
    if (!p) return;
    const edge = (i: number) => {
      const down = !!p.buttons[i]?.pressed;
      const e = down && !this.padPrev[i];
      this.padPrev[i] = down;
      return e;
    };
    const a = edge(0),
      b = edge(1),
      l = edge(14),
      r = edge(15);
    if (this.panelOpen) {
      if (l) this.movePanelFocus(-1);
      if (r) this.movePanelFocus(1);
      if (a) this.onPanelToggle?.(this.panelItems[this.panelFocus].id);
      if (b) this.closePanel();
    } else if (this.docOpen) {
      if (a || b) this.closeDoc();
    }
  }

  // ---------------------------------------------------------------- documents
  openDoc(html: string, style: 'hand' | 'type' | 'print' | 'child' | 'log' = 'hand') {
    this.docBody.innerHTML = html;
    this.docBody.className = `doc-body ${style}`;
    this.doc.classList.remove('hidden');
    requestAnimationFrame(() => this.doc.classList.add('in'));
    (this.doc.querySelector('.doc-hint') as HTMLElement).textContent = this.touchUI ? 'Tap outside the page to put it down' : 'E / Esc to put it down';
    this.docOpen = true;
    this.docBody.scrollTop = 0;
  }

  closeDoc() {
    if (!this.docOpen) return;
    this.doc.classList.remove('in');
    setTimeout(() => this.doc.classList.add('hidden'), 350);
    this.docOpen = false;
    this.onDocClose?.();
  }

  toggleNotebook(open: boolean, html?: string) {
    if (open && html) {
      this.notebook.innerHTML = `<div class="nb-page">${html}<div class="nb-close">${this.touchUI ? 'Tap to close' : 'Tab to close'}</div></div>`;
      this.notebook.classList.remove('hidden');
      requestAnimationFrame(() => this.notebook.classList.add('in'));
    } else {
      this.notebook.classList.remove('in');
      setTimeout(() => this.notebook.classList.add('hidden'), 300);
    }
  }

  get notebookOpen() {
    return !this.notebook.classList.contains('hidden');
  }

  // ---------------------------------------------------------------- pause & settings
  showPause(on: boolean) {
    this.paused = on;
    this.pause.classList.toggle('hidden', !on);
    (this.pause.querySelector('#btn-resume') as HTMLElement).textContent = this.hud.classList.contains('hidden') ? 'Back' : 'Resume';
  }

  private bindSettings() {
    const s = this.settings;
    const q = (id: string) => this.pause.querySelector(id) as HTMLInputElement;
    q('#set-sens').value = String(s.sensitivity);
    q('#set-vol').value = String(s.volume);
    q('#set-inv').checked = s.invertY;
    q('#set-subs').checked = s.subtitles;
    (this.pause.querySelector('#set-q') as HTMLSelectElement).value = s.quality;
    const apply = () => {
      s.sensitivity = Number(q('#set-sens').value);
      s.volume = Number(q('#set-vol').value);
      s.invertY = q('#set-inv').checked;
      s.subtitles = q('#set-subs').checked;
      s.quality = (this.pause.querySelector('#set-q') as HTMLSelectElement).value;
      this.saveSettings();
      this.onSettings?.(s);
    };
    this.pause.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', apply));
    this.pause.querySelectorAll('input,select').forEach((e) => e.addEventListener('change', apply));
    (this.pause.querySelector('#btn-resume') as HTMLElement).onclick = () => {
      this.showPause(false);
      this.onResume?.();
    };
    (this.pause.querySelector('#btn-restart') as HTMLElement).onclick = () => {
      this.showPause(false);
      this.onRestart?.();
    };
  }

  private loadSettings(): Settings {
    const def: Settings = { sensitivity: 1, invertY: false, volume: 0.85, quality: 'auto', subtitles: true };
    try {
      const raw = localStorage.getItem('bw-settings');
      if (raw) return { ...def, ...JSON.parse(raw) };
    } catch {
      /* storage unavailable */
    }
    return def;
  }

  saveSettings() {
    try {
      localStorage.setItem('bw-settings', JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }
}

function flashIcon() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 2h8l-1 6H9L8 2zm1 7h6v2l-1 11h-4L9 11V9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
function menuIcon() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
function bookIcon() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 4h10a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2V4zm0 14a2 2 0 0 1 2-2h10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
