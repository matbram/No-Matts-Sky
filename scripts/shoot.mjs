// Headless screenshot + console-capture harness for visual verification.
//
// Drives the live app in headless Chromium (software WebGPU via SwiftShader), waits
// for the planet to stream in, and saves screenshots at the orbit/mid/surface presets
// plus a console+backend log. Lets us SEE rendering artifacts and A/B fixes without a
// human in the loop. Not part of the app; a dev tool.
//
//   node scripts/shoot.mjs [tag]
//
// Output goes to $OUT (default ./.shots), files prefixed with [tag] (default "shot").

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 5190);
const OUT = process.env.OUT ?? resolve(ROOT, '.shots');
const TAG = process.argv[2] ?? 'shot';
const EXE =
  process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const W = 1366;
const H = 900;

const log = [];
const note = (s) => {
  console.log(s);
  log.push(s);
};

async function waitForServer(url, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) throw new Error(`server ${url} not up in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // 1) Dev server (picks up source edits each run — no build needed).
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  vite.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

  let browser;
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    note(`vite up on :${PORT}`);

    // 2) Headless Chromium with software WebGPU (SwiftShader Vulkan via Dawn).
    browser = await chromium.launch({
      executablePath: EXE,
      headless: false, // we pass --headless=new ourselves (full browser → WebGPU)
      args: [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--use-vulkan=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        `--window-size=${W},${H}`,
      ],
    });
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('console', (m) => note(`[console.${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => note(`[pageerror] ${e.message}`));

    const query = process.env.QUERY ?? ''; // e.g. "?webgl" or "?webgl&logdepth"
    await page.goto(`http://localhost:${PORT}/${query}`, { waitUntil: 'load' });
    note(`url query: "${query}"`);

    // 3) Report whether WebGPU is present. Do NOT call requestAdapter() ourselves —
    // under SwiftShader/Dawn a second adapter request drops the shared instance and
    // kills the renderer's device (observed: "WebGPU Device Lost").
    const gpu = await page.evaluate(() => ({ hasGpu: 'gpu' in navigator }));
    note(`navigator.gpu present: ${gpu.hasGpu}`);
    if (!gpu.hasGpu) {
      note('!! navigator.gpu MISSING — app shows the unsupported panel, no render.');
    }

    // 4) Wait for the planet to stream in + settle, then shoot each preset.
    // PRESETS env (e.g. "1:orbit" or "1:orbit,3:surface") limits which to shoot.
    const ALL = { '1': 'orbit', '2': 'mid', '3': 'surface' };
    const presets = (process.env.PRESETS ?? '1:orbit,2:mid,3:surface')
      .split(',')
      .map((p) => p.split(':'))
      .map(([k, n]) => [k, n ?? ALL[k]]);
    for (const [key, name] of presets) {
      await page.keyboard.press(key);
      // Wait until leaves > 0 and the queue has drained (settled scene).
      try {
        await page.waitForFunction(
          () => {
            const t = document.body.innerText;
            const m = /leaves\s+(\d+)\s+queue\s+(\d+)\s+busy\s+(\d+)/.exec(t);
            return m && Number(m[1]) > 0 && Number(m[2]) === 0 && Number(m[3]) === 0;
          },
          { timeout: 15000 },
        );
      } catch {
        note(`[warn] ${name}: scene didn't report settled within 15s (shooting anyway)`);
      }
      await new Promise((r) => setTimeout(r, 800)); // let morphs finish
      const file = resolve(OUT, `${TAG}-${name}.png`);
      await page.screenshot({ path: file });
      note(`shot ${name} -> ${file}`);
    }
  } finally {
    // Software WebGL can hang on close; don't let it wedge the run.
    if (browser)
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    vite.kill('SIGTERM');
    await writeFile(resolve(OUT, `${TAG}-log.txt`), log.join('\n') + '\n');
    note(`log -> ${resolve(OUT, `${TAG}-log.txt`)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
