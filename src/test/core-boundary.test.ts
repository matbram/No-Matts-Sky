import { describe, it, expect } from 'vitest';

// Self-policing guard for the single most load-bearing architectural rule (CLAUDE.md
// §3/§4 guardrail 1): the generation core (src/core) must NEVER import three.js (or
// anything from src/render). That split is what keeps the core headless, unit-testable,
// and portable to the eventual Rust/WASM core. It was convention-only; this makes it
// fail the build the moment a three import (or a render import) lands in /core.
//
// Reads the core sources as raw text via Vite's import.meta.glob (`?raw`), so it needs
// no @types/node and runs in the standard vitest node env.

const sources = import.meta.glob('../core/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Matches `... from 'three'`, `from "three/webgpu"`, `from 'three/tsl'`, and the
// dynamic `import('three')` / `import("three/...")` forms.
const THREE_IMPORT = /(?:from|import)\s*\(?\s*['"]three(?:\/[^'"]*)?['"]/;
// Any import that reaches up into the render shell from inside /core.
const RENDER_IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*\/render\/[^'"]*['"]/;

describe('core boundary — /core stays pure (no three.js, no /render)', () => {
  it('finds the core source files (sanity: the glob resolved)', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
  });

  it('no src/core/*.ts imports three.js', () => {
    const offenders = Object.entries(sources)
      .filter(([, src]) => THREE_IMPORT.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('no src/core/*.ts imports from /render', () => {
    const offenders = Object.entries(sources)
      .filter(([, src]) => RENDER_IMPORT.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
