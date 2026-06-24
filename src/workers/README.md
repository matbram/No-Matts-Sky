# `/src/workers`

Worker entry points that import from `/src/core` to run the generation core **off
the main thread** (master plan Part 8, slice spec §7).

Empty at Step 0 (the static cube-sphere is built once on the main thread). The
first real worker arrives at **Step 1**: it imports the density field + Surface
Nets mesher from `/core` and returns plain mesh buffers (`positions`, `normals`,
`indices`) to the main thread **by transfer, not copy**.

Rule: workers may import from `/core` and `/render` plumbing, but `/core` itself
must never import a worker or Three.js — keep the boundary clean.
