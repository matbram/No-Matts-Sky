# `/src/workers`

Worker entry points that import from `/src/core` to run the generation core **off
the main thread** (master plan Part 8, slice spec §7).

**Step 1 (implemented):** `mesher.worker.ts` receives a `MeshJob` (chunk request
+ terrain recipe + radius), runs the density field + Surface Nets mesher from
`/core` (`meshChunk`), and returns the plain mesh buffers (`positions`,
`normals`, `indices`) to the main thread **by transfer, not copy**. Vite bundles
it as its own chunk, so generation never touches the render frame.

A worker pool + per-frame upload scheduling (many chunks, capped per frame) is
**Step 3**; for now a single chunk is requested once at startup.

Rule: workers may import from `/core` and `/render` plumbing, but `/core` itself
must never import a worker or Three.js — keep the boundary clean.
