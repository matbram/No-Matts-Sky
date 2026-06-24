// Entry point. Wires the WebGPU render shell to the canvas and starts the loop.
//
// Uses renderer.setAnimationLoop (NOT requestAnimationFrame) so async GPU/compute
// work synchronizes correctly (CLAUDE.md §2).

import { createScene } from './render/scene.ts';
import { Stats } from './render/stats.ts';

async function main(): Promise<void> {
  const canvas = document.getElementById('app') as HTMLCanvasElement | null;
  const unsupported = document.getElementById('unsupported');
  if (!canvas) throw new Error('#app canvas not found');

  // WebGPU is required for the generation/render pipeline; the WebGL2 fallback is
  // not a slice target (master plan Part 0). Gate cleanly if it's missing.
  if (!('gpu' in navigator)) {
    if (unsupported) unsupported.style.display = 'flex';
    canvas.style.display = 'none';
    return;
  }

  const scene = await createScene(canvas);
  const stats = new Stats();

  const resize = (): void => scene.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  resize();

  scene.renderer.setAnimationLoop(() => {
    scene.render();
    stats.setInfo(scene.streamInfo());
    stats.frame();
  });
}

main().catch((err: unknown) => {
  console.error('No Matt’s Sky failed to start:', err);
  const unsupported = document.getElementById('unsupported');
  if (unsupported) {
    unsupported.style.display = 'flex';
    unsupported.innerHTML =
      '<div><h1>Failed to start</h1><p>See the browser console for details.</p></div>';
  }
});
