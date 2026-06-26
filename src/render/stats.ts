// On-screen frame-time / FPS overlay. Present from the FIRST commit (CLAUDE.md §6):
// "60fps = 16.67 ms/frame is checked at every step. Keep a frame-time readout on
// screen from Step 0." Green when within budget, red when over.
//
// CRITICAL: the average/smoothed frame-time HIDES stutter — a single 40 ms stall among
// 8 ms frames barely moves an EMA, so the overlay can read "120 fps" while the experience
// feels laggy. So we ALSO report the WORST frame in each window + a "jank" count (frames
// that blew the budget). That worst-case line is the honest signal for "smooth or not."

const FRAME_BUDGET_MS = 1000 / 60; // 16.67
// Turn the readout red only when genuinely below ~55 fps, so a 60 Hz vsync cap
// (a normal ~16.7 ms frame) isn't a false alarm.
const RED_THRESHOLD_MS = 1000 / 55; // ~18.2
// A "jank" is a frame that took clearly longer than a vsync interval — a real hitch the
// player feels. 2× budget (~33 ms = a dropped frame to 30 fps) is unambiguous stutter.
const JANK_MS = FRAME_BUDGET_MS * 2; // ~33.3

export class Stats {
  private readonly el: HTMLDivElement;
  private last: number;
  private acc = 0;
  private frames = 0;
  private smoothedMs = FRAME_BUDGET_MS;
  // Worst-case tracking within the current readout window (reset every ~250 ms).
  private windowMaxMs = 0;
  private jankCount = 0;
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
    if (dt > this.windowMaxMs) this.windowMaxMs = dt;
    if (dt > JANK_MS) this.jankCount++;
    this.acc += dt;
    this.frames++;
    if (this.acc >= 250) {
      const fps = (this.frames * 1000) / this.acc;
      // Red when the SMOOTHED frame is over OR there was a real hitch this window — so a
      // spike the average swallowed still flips the readout (this is the "feels laggy at
      // high fps" case made visible).
      const janky = this.windowMaxMs > JANK_MS || this.smoothedMs > RED_THRESHOLD_MS;
      this.el.style.color = janky ? '#ff6b6b' : '#7cfc8a';
      const jankStr = this.jankCount > 0 ? `   ⚠ ${this.jankCount} jank` : '';
      this.el.textContent =
        `${fps.toFixed(0)} fps   ${this.smoothedMs.toFixed(2)} ms   ` +
        `worst ${this.windowMaxMs.toFixed(1)} ms${jankStr}` +
        `\nbudget ${FRAME_BUDGET_MS.toFixed(2)} ms (60 fps)` +
        (this.info ? `\n${this.info}` : '');
      this.acc = 0;
      this.frames = 0;
      this.windowMaxMs = 0;
      this.jankCount = 0;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
