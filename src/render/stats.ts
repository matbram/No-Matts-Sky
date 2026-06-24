// On-screen frame-time / FPS overlay. Present from the FIRST commit (CLAUDE.md §6):
// "60fps = 16.67 ms/frame is checked at every step. Keep a frame-time readout on
// screen from Step 0." Green when within budget, red when over.

const FRAME_BUDGET_MS = 1000 / 60; // 16.67

export class Stats {
  private readonly el: HTMLDivElement;
  private last: number;
  private acc = 0;
  private frames = 0;
  private smoothedMs = FRAME_BUDGET_MS;
  private info = '';

  constructor() {
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      padding: '6px 10px',
      background: 'rgba(0,0,0,0.55)',
      color: '#7cfc8a',
      font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      whiteSpace: 'pre',
      zIndex: '10',
      pointerEvents: 'none',
      borderRadius: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.el);
    this.last = performance.now();
  }

  /** Set an extra status line (e.g. streaming health). Shown at the readout cadence. */
  setInfo(text: string): void {
    this.info = text;
  }

  /** Call once per rendered frame. */
  frame(): void {
    const now = performance.now();
    const dt = now - this.last;
    this.last = now;
    this.smoothedMs = this.smoothedMs * 0.9 + dt * 0.1;
    this.acc += dt;
    this.frames++;
    if (this.acc >= 250) {
      const fps = (this.frames * 1000) / this.acc;
      const overBudget = this.smoothedMs > FRAME_BUDGET_MS;
      this.el.style.color = overBudget ? '#ff6b6b' : '#7cfc8a';
      this.el.textContent =
        `${fps.toFixed(0)} fps   ${this.smoothedMs.toFixed(2)} ms` +
        `\nbudget ${FRAME_BUDGET_MS.toFixed(2)} ms (60 fps)` +
        (this.info ? `\n${this.info}` : '');
      this.acc = 0;
      this.frames = 0;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
