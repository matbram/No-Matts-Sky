# Canonical Generation Pipeline — The Formula, End to End

This is the single authoritative reference for **"the formula"**: the exact, ordered sequence of operations that turns a coordinate (plus cosmic-time) into a world, with the hash function **pinned exactly** and every standard formula collected in one place. It consolidates what was scattered across the master plan (Part 5, the math), the fact-generation design (the "why"), and the Constitution (II.8 terrain, II.14 determinism). It is the implementation target for the first build and for the eventual Rust/WASM port.

There is **no single master-equation** — the "formula" is a *pipeline* of standard, well-understood functions composed in a fixed order. Most are textbook (PCG hash, fBm, Surface Nets, Kepler); the intellectual work is the *composition and the discipline* that make it deterministic, seamless, and store-nothing. Pieces marked **[S]** are frozen (canonical — must be bit-identical everywhere, forever once live); **[T]** are tunable values discovered by building.

---

## 1. The pinned hash — PCG (the foundation of determinism)

**Decision: the canonical hash is PCG**, specifically the variants from Jarzynski & Olano, *Hash Functions for GPU Rendering* (JCGT vol. 9 no. 3, 2020) — the 1D RXS-M-XS form and the multidimensional `pcg2d` / `pcg3d` / `pcg4d`. This replaces the earlier "PCG-style or wang-hash" placeholder in Constitution II.14, which is now **pinned**. **[S]**

**Why this one (researched, not guessed):**
- It sits on the **Pareto frontier** for quality-vs-speed on the GPU in the reference study of exactly this use case (procedural generation), and is widely considered the best-balanced default. The older "Wang hash" did *not* make the frontier and is dominated by PCG on both speed and quality.
- `pcg3d` / `pcg4d` were purpose-built for **multidimensional input/output** — i.e. turning a coordinate `(x,y,z)` or `(address, salt, time)` directly into well-distributed values, which is precisely what we do.
- **32-bit unsigned-integer ops only** (multiply, add, xor, shift) → **bit-identical across JS, WGSL, Rust, every CPU and GPU vendor.** This is the property the shared universe lives or dies on (Constitution II.14 / master plan Part 0).
- Real-world proof of cross-platform identity: Blender's Cycles uses `pcg3d` compiled to **both CPU and GPU** (CUDA/Metal/HIP/oneAPI) and gets matching results.
- Reference implementation by the author: `github.com/markjarzynski/PCG3D`. Paper: `jcgt.org/published/0009/03/02/`.

### 1.1 The exact functions (GPU — WGSL), pinned constants
```wgsl
fn pcg(n: u32) -> u32 {
    var h = n * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    return (h >> 22u) ^ h;
}
fn pcg2d(p: vec2u) -> vec2u {
    var v = p * 1664525u + 1013904223u;
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= v >> vec2u(16u);
    v.x += v.y * 1664525u; v.y += v.x * 1664525u;
    v ^= v >> vec2u(16u);
    return v;
}
fn pcg3d(p: vec3u) -> vec3u {
    var v = p * 1664525u + 1013904223u;
    v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
    v ^= v >> vec3u(16u);
    v.x += v.y*v.z; v.y += v.z*v.x; v.z += v.x*v.y;
    return v;
}
fn pcg4d(p: vec4u) -> vec4u {
    var v = p * 1664525u + 1013904223u;
    v.x += v.y*v.w; v.y += v.z*v.x; v.z += v.x*v.y; v.w += v.y*v.z;
    v ^= v >> vec4u(16u);
    v.x += v.y*v.w; v.y += v.z*v.x; v.z += v.x*v.y; v.w += v.y*v.z;
    return v;
}
```

### 1.2 The exact functions (CPU — TypeScript), bit-identical to the above
**The critical rule:** JavaScript numbers are float64 and `*` loses precision above 2³², so **every 32-bit multiply must use `Math.imul`, and every result must be coerced to u32 with `>>> 0`.** Shifts use `>>>` (unsigned). Done this way, the TS core is **bit-identical** to the WGSL above — this is what makes the eventual Rust port verifiable against a golden test. This single detail is the most common source of cross-platform desync; honor it everywhere in `/core`.

```ts
export function pcg(n: number): number {
  let h = (Math.imul(n >>> 0, 747796405) + 2891336453) >>> 0;
  h = (Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737)) >>> 0;
  return ((h >>> 22) ^ h) >>> 0;
}
export function pcg2d(x: number, y: number): [number, number] {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; y = (y ^ (y >>> 16)) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; y = (y ^ (y >>> 16)) >>> 0;
  return [x >>> 0, y >>> 0];
}
export function pcg3d(x: number, y: number, z: number): [number, number, number] {
  x = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; y = (y ^ (y >>> 16)) >>> 0; z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0;
  y = (y + Math.imul(z, x)) >>> 0;
  z = (z + Math.imul(x, y)) >>> 0;
  return [x >>> 0, y >>> 0, z >>> 0];
}
// pcg4d follows the WGSL form identically (w added; cross-terms y*w, z*x, x*y, y*z).
```

### 1.3 Helpers (also canonical)
```ts
// u32 -> float in [0,1).  Canonical, exact (division by 2^32).
export const toUnit = (u: number) => (u >>> 0) / 4294967296;
// u32 -> integer in [0,n).  Use integer modulo (slight bias, acceptable & deterministic).
export const toInt = (u: number, n: number) => (u >>> 0) % n;
```
**Threshold rule (Constitution II.14):** make canonical *decisions* by comparing **integer** quantities, never floats near a boundary. To pick a biome at "warmer than X," compare `hashU32 < thresholdU32`, not `floatTemp > 0.2` — float compares can flip between machines.

### 1.4 Documented alternatives (considered, not chosen — for the record)
`lowbias32` (Wellons) has marginally lower bias but is 1D-only (no native multidimensional form); `triple32` is higher-quality but slower (offline use). `xxhash32` is a fine multidimensional alternative the paper also endorses. PCG wins for us on the combination of *multidimensional + GPU-friendly + cross-platform-integer + well-proven*. If a future measurement ever demands a change, it's a one-time re-freeze, gated by the golden test.

---

## 2. The seed chain (coordinate/address → seeds) **[S] structure**

The universe is addressed hierarchically; each level derives its seed from its parent plus a local index plus a **per-purpose salt** (a small integer constant). Any worker can compute any node independently and identically because it's all pure hashing.

```ts
const MASTER_SEED = 0x9E3779B1;            // the universe's identity — pick once, freeze. [S]
const SALT = { laws:1, star:2, planet:3, terrain:4, biome:5, atmosphere:6,
               life:7, hazard:8, resource:9, landmark:10, history:11, faction:12 }; // [S] set
// derive a child seed from a parent seed + a local index + a purpose salt:
const childSeed = (parent:number, index:number, salt:number) => pcg3d(parent, index, salt)[0];
```
Descend: `universe → galaxy → region → system → planet → …`, each `childSeed(parentSeed, localIndex, salt)`. For multi-component addresses (e.g. a 3D galaxy-grid cell), fold the components in with `pcg3d`/`pcg4d`. (Per master plan Part 4: hash the *full* hierarchical address so every property is independent and reproducible.)

---

## 3. The derivation pipeline (the ordered sequence — the actual formula)

Given an address and cosmic-time `T`, produce the world by running these in order. Each step names the concrete formula and where its detail lives.

**A. Address → seeds.** Seed chain (§2). → per-purpose seeds for this place. **[S]**

**B. Effective laws** (Constitution II.1–II.3). From `laws` seed + rarity tables: gravity ×, time-rate ×, world-shape, substance, life-kind — each a weighted pick (normal-centred, wide range, rare tail). These constrain everything below. *Values* **[T]**; *that they're rolled first* **[S]**.

**C. Galaxy / region / system facts** (fact-gen §2–§3). Star **class** = weighted pick over the real census (M ~73%, K ~12%, G ~7.6%, …) from the `star` seed; star **age**; planet **count**. **[T]** weights.

**D. Star physics** (Constitution II.6). Luminosity `L ≈ M^3.5` (solar masses). Habitable zone `d_inner = √(L/1.1)`, `d_outer = √(L/0.36)` AU. **[S]** (physics).

**E. Planet facts** (fact-gen §3, Constitution II.7). **Temperature** from the planet's orbital distance vs `L` → class (frozen…scorching). **Atmosphere** from size → gravity → gas retention. **Archetype** = climate + substance + atmosphere gate, then a weight-loaded pick from the eligible set (the library that beats sameness). **Terrain class** from archetype. Hazard/life/resource/landmark gated picks. **[S]** the physical derivations; **[T]** the weights/thresholds.

**F. Lifecycle (time)** (Constitution Principle 2, II.7). Evaluate the above as a **function of `T`**: the star ages (main-sequence → giant → remnant by mass+age); the planet ages (forming → mature → dying → remnant). Same coordinate, different chapter by `T`. **[S]** structure.

**G. Terrain density field** (master plan Part 5.3–5.4, Constitution II.8). The planet is the scalar field
`D(p) = planetRadius − length(p) + fBm(normalize(p) · noiseScale) · terrainHeight`, plus one domain-warp pass for character. `D>0` solid, `D<0` air, surface at `D=0`.
- **fBm** = sum of octaves of a base gradient/value noise: start amplitude 1, frequency 1; each octave ×`lacunarity` (≈ **2.0**) frequency, ×`gain` (≈ **0.5**) amplitude; **6–8** octaves; normalize by the amplitude sum. **[T]** params.
- **Base noise** hashes integer lattice cells with `pcg3d(cellX, cellY, cellZ)` → gradients. **[S]** (uses the pinned hash).
- **Domain warp:** offset the sample position by a vector of noise before sampling again (`p' = p + warpStrength · noiseVec(p)`). **[T]** strength.
- **Analytic normals:** compute value + gradient in one pass (don't sample three times). **[S]** discipline.
- **Per-archetype recipe:** each archetype overrides `noiseScale, terrainHeight, octaves, warpStrength, noise-style mix (fBm/ridged/billow), ocean level`. This is the bulk of ring-1 tuning. **[T]**

**H. Orbits & motion** (master plan Part 5.6, Constitution II.9). Position via **Kepler's equation**, solved with **Newton–Raphson**; eccentricity capped at **0.8** (solver stability). Spin/orbit **angle computed in double, taken modulo 2π, then cast to float** (precision). **[S]**.

**I. Mesh** (master plan Part 3.3, 5.4; slice spec). **Cube-sphere** (6 faces) → **quadtree** per face → leaves meshed with **Surface Nets** at `D=0` (Dual Contouring only later for sharp features). Hide LOD-boundary cracks with **skirts** first (Transvoxel later). **[S]** approach; **[T]** chunk size, LOD threshold.

**J. Render-only (NOT canonical — may use ordinary floats).** Atmosphere via precomputed **Rayleigh/Mie LUT** (master plan Part 5.7); **triplanar** materials (Part 5.8); the **floating origin** that re-centres render coordinates each frame (Part 5.1). These never feed back into canonical generation, so they're free to differ cosmetically between machines.

---

## 4. The determinism guardrails (what keeps the formula reproducible)

(Restated from Constitution II.14 / master plan Part 0 — these are the rules that make §1–§3 give the same world everywhere, forever.)
1. **Integer hashing for every canonical value** — the pinned PCG only; no `Math.random()`, no `sin`-based float hashes for anything canonical (those are fine for throwaway shader sparkle only).
2. **`Math.imul` + `>>> 0`** for all 32-bit math in the TS core (§1.2) — the cross-platform bit-identity rule.
3. **Canonical decisions on integers**, not floats near a boundary (§1.3).
4. **Coarse → fine:** finer facts derived *constrained by* coarser ones (consistency for free).
5. **Store nothing you can recompute** — only the Memory layer (player changes/knowledge) is stored.
6. **A golden test in CI** from day one: fixed inputs → recorded output hashes; the build fails if any platform's output changes a single bit. This is what will later prove the Rust port matches the TS core.

---

## 5. What's pinned now vs. tuned later

- **Pinned [S] (decide/freeze):** the PCG hash + its exact constants (§1); the seed-chain structure, master seed, and salt set (§2); the stellar physics and habitable-zone formulas (D); the density-field *form* and fBm/domain-warp *structure* (G); the Kepler/precision rules (H); the cube-sphere + Surface Nets approach (I); the determinism guardrails (§4).
- **Tuned [T] (discover by building, slice → ring 1):** per-archetype noise recipes (the values that make a frozen ocean *look* like one); archetype/hazard/life/resource weights; temperature/atmosphere thresholds; chunk size and LOD thresholds; the effective-law ranges and rarity weights.

No secret equation is missing — the structure and the standard components are fully specified here; implementation is of known algorithms; the rest is empirical tuning that can only be done by looking at results.

---

## 6. The slice subset (what the vertical slice actually needs)

For the vertical slice you implement only: `pcg3d` (§1) → a base gradient/value noise → `fBm` → the **density field** (G, one hand-set archetype) → **cube-sphere + Surface Nets** (I) → **Kepler** for the Earth/Moon orbits (H) → the **floating origin** (J). Facts are hand-set (no fact derivation B–F yet). **Step 0 needs none of this** — it's the bare cube-sphere (I) with no noise. Add `pcg3d` + noise at Step 1.

---

## 7. Connections & supersession

- **Constitution II.14** ("one named integer hash … pin exactly") → **now pinned** to PCG here; II.14's `[S]` is satisfied.
- **Master plan Part 5** (the math) → this is its consolidated, implementable form with the hash filled in.
- **Fact Generation Design** → the "why" behind steps B–F; this is the "how/in-what-order."
- **CLAUDE.md** → points here for the hash and the pipeline; the slice uses the §6 subset.

References: Jarzynski & Olano, *Hash Functions for GPU Rendering*, JCGT 9(3), 2020 (`jcgt.org/published/0009/03/02/`); reference impl `github.com/markjarzynski/PCG3D`; Nathan Reed, "Hash Functions for GPU Rendering" (`reedbeta.com`).
