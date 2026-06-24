# A No Man's Sky–Class Universe: The Master Plan

This is the single source of truth for the project. It began as a corrected layer on top of an external research report, and has grown to hold the full design: the mental model of what we're actually building, the content strategy that beats sameness, the corrected engineering architecture and math, the persistence and discovery systems that make this a *shared* universe, the five "frontier" systems that make it feel alive, an honest performance budget, and a build order.

> **Authority note (read first).** This plan now sits *beneath* **The Universe Constitution**, which is the top-level document and the final authority on what the universe fundamentally is. Where this plan and the Constitution differ, the Constitution wins. The Constitution **extends** this plan in four ways you should keep in mind while reading: (1) a coordinate yields not just a *world* but a **history read at a moment in time** — every significant thing has a lifecycle (Part 1 and Frontier 4 here are the seed of that, now generalized); (2) the archetype library that defeats sameness (Part 2 here) is **one layer** of a larger possibility space that also includes place-varying laws, substances, and life-kinds, on a rarity spectrum reaching the mythic; (3) fact derivation runs not only top-down but **backward and forward across causal chains** (an effect's causes, a cause's effects, all derivable and consistent); (4) there is **no permanent mystery — only the unexcavated** — and everything leans toward a single origin it never contains. None of this contradicts the engineering below; it widens what the engineering serves.

It's written in plain language on purpose. You'll build from it, but it should still read clearly months from now with no gaps and no unanswered questions. Where a technical term is unavoidable (Transvoxel, body-fixed frame), it's explained once in plain words. The goal stated up front and assumed throughout: a true multi-galaxy procedural universe, planets that genuinely rotate and orbit, gorgeous fidelity, 60fps minimum, shared by many players.

**How the document is organised:**
- **Part 0** — the two decisions that gate everything else.
- **Part 1** — the nature of this universe (the mental model). Read this first; everything rests on it.
- **Part 2** — solving sameness (the make-or-break content problem).
- **Part 3** — corrections to the source research report.
- **Part 4** — the coordinate / orbit / streaming architecture (the engineering core).
- **Part 5** — the math that actually matters.
- **Part 6** — persistence, discovery, and the shared universe.
- **Part 7** — the five frontiers: the systems that make it alive (the part we most want to get right).
- **Part 8** — hitting 60fps honestly.
- **Part 9** — the critical path / build order.
- **Part 10** — recommended tech stack.
- **Quick-reference** — every load-bearing rule on one screen.

---

## PART 0 — The two decisions that gate everything

Make these *before* writing code. Everything downstream depends on them.

### Decision 1: Web or Native — DECIDED: web first, then a native version

**The decision (made):** build the **web version first**, then a **native version after.** The comparison and reasoning below are kept as the *why* — and because the native build inherits most of these same tradeoffs when its turn comes.

This was never "Option A *or* Option B forever" — it's a **sequence**. Web-first puts a playable, instantly-shareable universe into people's hands on the timeline and toolset that match the team's background; the native version follows later to lift the fidelity ceiling for players who want the higher-end experience. The two only become a costly fork if you let the web version's rendering code bleed into the universe's logic. Architect for the sequence from day one (see "Architecting now so the native port is cheap," at the end of this section) and the native version is a bounded follow-on, not a rebuild.

| | **Web (Three.js + WebGPU + TSL)** | **Native (Godot 4 / custom C++ / Bevy)** |
|---|---|---|
| Reach | Instant play in a browser, no install | Download required |
| Fidelity ceiling | High, but bounded by WebGPU's feature set and whatever GPU the user happens to have | Higher — full access to the GPU, hardware ray tracing, mesh shaders, no browser overhead |
| Compute | First-class compute shaders (WebGPU) — enough for your generation pipeline | Full, with fewer limits |
| Memory | Browser-imposed limits; large readbacks are painful | Effectively system memory |
| Threading | One JS main thread + Web Workers (data passed by copy/transfer) | Real multithreading |
| Your stated background | Matches (Three.js/Babylon) | Learning curve |

**Honest fidelity reality:** the achievable web target is "looks beautiful and holds 60fps on a mid-to-high-end *desktop* GPU in Chrome." It is **not** "rivals a current native AAA engine." If matching Unreal 5 (Nanite/Lumen-class virtualized geometry and global illumination) is non-negotiable, go native now. If "stunning on the web, playable instantly" is the dream, the web is finally viable in 2026 and is the recommended path given your background.

**Why the web is viable now (and wasn't 2 years ago) — verified June 2026:** WebGPU now ships **by default in all major browsers** — the last holdout fell when Apple shipped it in **Safari 26 (Sept 2025)** across macOS/iOS/iPadOS/visionOS — putting global support around **90–95%** (the remaining gaps are Linux Firefox and pre-A12 iPhones; the WebGL 2 fallback covers them). It has the **compute shaders** your generator needs (real-world: ~1,000,000-particle systems vs. ~50,000 on WebGL). **Three.js's WebGPU renderer has been production-ready since r171 (Sept 2025)** — `import … from 'three/webgpu'`, zero-config, automatic WebGL 2 fallback — with **TSL** as a shader layer compiling to both WGSL and GLSL; use a **current release (r184+, which removed per-frame allocations that were stressing the garbage collector** — directly relevant to holding 60fps). One honest caveat: the official Three.js manual still labels the renderer "experimental but greatly matured," so **profile your specific scene** rather than assuming parity everywhere — which is exactly what the vertical slice is for.

**The catch nobody mentions:** WebGPU is *not* a blanket speedup. It wins specifically for compute-heavy, high-draw-call, and instanced workloads — and can be *slower* than WebGL for naive many-separate-mesh scenes. This is fine for you, because your engine is entirely compute + instancing. But it means the "automatic WebGL2 fallback" is a degraded-visuals safety net, **not** a second working target: your generation pipeline (compute shaders) does not run on the fallback at all. Plan for: full experience on WebGPU, a stripped static-mesh experience or a "your browser isn't supported" gate on the fallback.

**Architecting now so the native port is cheap (don't skip this).** Because native is a committed follow-on, build the web version as two cleanly separated halves so the eventual port is mostly a *rendering* rewrite, not a *universe* rewrite:

- **The portable "brain" — reused wholesale.** The universe's *logic* — the recipe, the hashing, the math, the fact generation, the orbital/time functions (Parts 1, 4, 5, 6, 7) — plus the server-side Memory layer and the deterministic lore generator (Part 6) are all platform-independent. Define this logic in an engine-agnostic way (keep it out of web-only constructs) and the native version reuses it as-is.
- **The web-specific shell — expected to be rewritten.** The renderer, the WebGPU compute-shader *implementations* (TSL/WGSL), the Web-Worker orchestration, and browser I/O don't carry over; a native engine (Godot/Bevy/custom) reimplements them. That's fine and bounded — it's a rewrite of the shell, not the brain.
- **A now-mandatory requirement, because the two versions share one universe (decided below):** generation must produce **bit-identical** results on web *and* native *and* the server. This is exactly why canonical generation is integer math (Part 3.6 / Part 10), and why you keep a single engine-agnostic *reference implementation* of every generation function that all three reproduce. Get this wrong and a planet looks different on web vs native, and the shared universe breaks. The full demands of this are spelled out in the next subsection — it is the single hardest constraint in the project.

Practical test for the web build: treat the generation core as a self-contained module with **no rendering dependencies**, talking to the renderer only through plain data (heightfields, density values, fact records). If you can run the entire generation core *headless* — with no Three.js loaded at all — you've separated it correctly, and the native port starts from a working brain.

### Decision 1a — DECIDED: one shared universe across web and native (and what it demands)

**The decision (made):** web and native players live in **one shared universe** — same planets at the same coordinates, shared discoveries and names, one set of servers, one player account that follows you across both clients. This is the most demanding option, and it is now a fixed requirement, not a "maybe."

**The reassuring half first:** a shared universe is *cheap to operate*, precisely because of the store-nothing model (Part 1). The server never streams planets to anyone — both clients **compute the universe locally** from the recipe, and the server only syncs the tiny Memory layer (player positions, discoveries, deltas — Part 1.4 / 6.3). So "shared across two client types" costs almost nothing in bandwidth or server load. The entire price of this decision is paid in **one place**: making generation reproducible across different hardware. Pay it once, correctly, and everything else follows.

**The hard half — the root problem.** For two clients to agree on a planet, the generation must be **bit-for-bit identical** on a web browser, a native app, and the server, even though they run on different CPUs, different GPUs, and different shader compilers. The enemy is **floating-point math**, which is *not* guaranteed identical across machines:
- Transcendental functions (`sin`, `cos`, `exp`, `pow`) are *not* specified to the last bit — different math libraries and GPUs return slightly different values.
- Fused multiply-add (FMA) vs separate multiply-then-add differ in the last bit; compilers and GPUs apply it inconsistently.
- Compilers reorder/re-associate float operations (`(a+b)+c` vs `a+(b+c)`), changing results — `fast-math`-style flags do this aggressively.
- GPU shader codegen across WebGPU (WGSL) vs a native API (HLSL/SPIR-V) is essentially impossible to guarantee identical for float-heavy code.

Tiny differences are fatal here because the terrain functions are chaotic (domain warping amplifies a `1e-7` input difference into visibly different geology), and because a float comparison near a threshold ("temperature > 0.2 → forest") can flip one client to forest and the other to desert. This is the same wall that lockstep multiplayer games (Factorio, classic RTS) fight, and they solve it the same way we must.

**What must be identical vs. what may drift** (focus the expensive work where it actually matters):
- **Must be bit-identical (canonical):** the body-fixed terrain *occupancy* at voxel/edit resolution (where bases sit, craters land, tunnels are dug — if "is there rock here" disagrees, a tunnel open on one client is blocked on another); the **facts** (biome/faction/landmark *decisions*, including their threshold comparisons); and the **orbital elements** (which are integer-derived anyway).
- **May drift harmlessly (platform-local):** the exact orbital *position* by a few meters (invisible in space; irrelevant on a surface, because surface play happens in the body-fixed frame where the planet's absolute system position cancels out — and player-to-player positions are synced in the active local frame anyway, per Part 4, so nobody sees misalignment); cosmetic sub-voxel detail; particles; the precise look of the atmosphere/shaders.

**The directive:** the **canonical generation pipeline uses integer / fixed-point arithmetic** (or, where it runs only on CPU/WASM, tightly-controlled software-float — no FMA, no fast-math, one shared software implementation of every transcendental, fixed operation order) so it is bit-identical on every CPU, GPU, and shader compiler. **Cosmetic-only detail may use ordinary floats.** Canonical *decisions* (the threshold comparisons that pick a biome or a fact) must be made on integer-derived quantities, never on raw floats near a boundary.

**Two coherent architectures (pick by measurement, not guess):**
- **Architecture A (start here):** one canonical core, written once in a portable language with controlled determinism (Rust is the natural choice — it compiles cleanly to **WASM for the web client, native for the native client, and native for the server**), running on CPU/WASM. It produces the facts, the orbital elements, and the canonical voxel-resolution occupancy of any chunk a player can reach or edit. The **GPU's job is rendering plus cosmetic sub-voxel detail only** — it is *not* the source of truth. Simplest to validate, one codebase everywhere.
- **Architecture B (escalate only if A can't keep up):** if profiling shows CPU/WASM can't generate canonical voxel terrain fast enough for 60fps streaming, move the hot density generation into **fixed-point integer math inside the compute shader** (integer ops *are* deterministic across shader compilers, unlike floats), so canonical generation can run on the GPU on both platforms. More work and slightly lower fidelity/perf — the main tax this decision imposes — so only reach for it where measurement proves you must, and keep cosmetic sub-detail in float.

**The safeguards that keep determinism from silently rotting (don't skip these):**
- **One reference implementation, run in three places** (web via WASM, native, server). This is a strong reason to write the canonical core in Rust and share it as a single library. The server runs it as the authoritative arbiter (it's already what powers anti-cheat by recompute — Part 6.3).
- **A conformance ("golden") test suite in CI:** a fixed set of coordinates with known-correct generation outputs (hashed), run against the web (WASM), native, and server builds on every change. If any platform's output diverges by a single bit, the build fails. This is the wire that prevents a future compiler update or refactor from quietly splitting the universe in two.
- **Recipe versions move in lockstep across web + native + server.** Because both clients must generate the *same* universe, you cannot ship a recipe change to one client without the others — the server gates the canonical version, and the **frozen-recipe one-way door (Part 1.3) now spans all three at once.** This makes the freeze even more rigid: after going live, the recipe changes for everyone together, or not at all.
- **One shared backend and shared player identity** across both clients (your account, discoveries, and bases follow you from web to native).

### Decision 2: Accept that scale is the cheap part

Procedural generation makes an infinite, multi-galaxy universe nearly free to *represent* — it's just hashing coordinates. The universe being enormous is the *easy* part and should be built *late*.

The expensive parts, in order of difficulty:

1. **Streaming throughput** — generating and meshing terrain fast enough that flying from orbit to surface never stutters.
2. **Per-planet quality** — making any given planet beautiful and not feel like noise-mush or a reskin of the last one (this is the "sameness" problem; see Part 2).
3. **The frame handoffs for real orbits** (Part 4).

NMS's actual engineering problem was never "how do we have 18 quintillion planets." It was sameness and streaming. Spend your hard effort on *one* planet first.

---

## PART 1 — The nature of this universe (the mental model)

This part is conceptual, not technical, and it's the foundation the entire project rests on. If the team shares this mental model, every later decision gets easier. If they don't, you'll keep re-litigating the same arguments. Read it first.

### 1.1 The universe is a formula, and everything in it already exists

Forget space for a moment. Think about multiplication.

What is 8,234 × 5,917? You don't have it memorised. Nobody told you. There is no piece of paper anywhere with that answer on it. And yet — is the answer already a specific number? Obviously: it's 48,720,578. It was that number a thousand years ago and will be long after we're gone. The math doesn't *store* the answer anywhere; the answer simply *is what it is*, sitting inside the rules of multiplication, waiting for anyone who bothers to work it out. Calculating it doesn't *create* the answer — it *reveals* a number that was always true. The millionth digit of pi is a specific number right now, even if nobody on Earth has ever calculated it.

A formula doesn't have to spit out one boring number. You can write a formula that takes in a *location* and spits out a *whole planet*: same machine, fancier output. Feed it a coordinate ("galaxy 5, sector 12, star 3, planet 2") and it runs that number through a long chain of steps and hands back everything about that planet — every mountain's height, where the oceans sit, the sky colour, where each rock and creature goes. (The steps that do this are the engineering parts in Parts 4–5: the noise that makes terrain, the rules that pick a biome, and so on.)

The one property that matters above all others: **the formula gives the same answer every time for the same input.** Just like 8,234 × 5,917 is *always* 48,720,578 on every calculator on Earth, feeding the same coordinate into the recipe *always* produces the same planet, down to the last pebble — your machine, mine, today, next year. No randomness at runtime. A fixed calculation with a fixed answer.

Three consequences fall straight out, and they are the spine of the whole project:

- **An unvisited planet already fully exists**, in complete detail — it's just unread, the way 8,234 × 5,917 was a real number before you read it here. Nobody has to *build* a planet for it to exist, any more than someone has to multiply two numbers for their product to exist. **The universe is already finished the instant you write the formula.** Exploring is people working out answers nobody happened to calculate yet.
- **Nothing needs to be stored.** Your computer never saves a planet, because it can re-derive it from scratch any time by running the coordinate through the recipe again — the way you don't keep a warehouse of multiplication answers, you just redo the multiplication when needed. This is how 18 quintillion planets fit in nearly no storage: you store **one recipe that can reveal any of them**, not the planets.
- **Two players in different places see the same planet automatically.** When two players fly to the same coordinate from opposite ends of the galaxy and see the same purple mountains under the same green sky, it's *not* because their machines synced or downloaded the planet from a server. They both ran the same recipe with the same input, and math doesn't lie — like two strangers on different continents both computing 8,234 × 5,917 and both getting 48,720,578. No coordination needed; the answer was never up for grabs.

### 1.2 You reveal, you don't create

A tempting mistake (it will come up again and again): thinking the first player to reach a planet "creates" it. They don't — they **reveal** it. Every machine that ever visits that coordinate runs the same recipe and gets the byte-for-byte identical planet. There is nothing the first machine authored that the second wouldn't produce on its own. The planet wasn't waiting to be made; it already *was* that exact planet.

This is also why determinism is the *realest* possible version of a universe, not a cheap shortcut. A real planet doesn't wait for an observer to decide what it's like — it already is what it is, the same for everyone, whether or not a single soul ever sees it. That's exactly what the formula gives you: a reality that exists independent of any observer, identical for every explorer, there whether watched or not. (The alternative — "whatever the first computer renders becomes official" — is secretly the *less* real version, where the universe only becomes real in the spots someone's GPU has already touched, and what's true depends on who rendered it first. We reject that; see the traps in Part 7.7.)

So the real act of creation here is **not** authoring 18 quintillion planets. It's authoring the **law** that makes them exist. You're not the painter of the worlds — you're the physics they're born from, and they fall out of your rules whether anyone visits or not.

### 1.3 The recipe is your universe's constitution

When people ask "are we using a formula that already exists, or inventing a new one?", the answer is *both*, and the split is important.

- **The ingredients are all off-the-shelf.** Noise functions, hashing, the centuries-old equations of orbits, the algorithms that turn a density field into a mesh, plant-growing grammars (L-systems), the physics of light scattering — every individual piece is public, often decades old, and free. You invent none of them. Nobody builds a universe by inventing new math from scratch, the same way nobody writes a song by inventing new musical notes.
- **The assembly and tuning are new, and yours.** There is no downloadable "universe formula." NMS's exact recipe is theirs and secret. What *you* create is the arrangement: which tool feeds into which, in what order, and — the big one — the exact setting of every dial (how jagged mountains get, how wildly orbits stretch, where "desert" ends and "forest" begins), plus the coordinate scheme and the archetype library (Part 2). That whole assembled, tuned contraption exists nowhere else and is the thing that makes the universe *yours*.

Cooking analogy: flour, eggs, heat, the chemistry of browning all already exist and belong to everyone — you don't invent eggs. But *your signature dish* is your particular recipe: your arrangement, your proportions, your steps. Same public ingredients as everyone, arranged your way, producing a meal that exists nowhere else.

**The critical consequence — write this on the wall:** because the universe literally *is* the recipe, the recipe is the universe's constitution, not ordinary code you casually rewrite. The day this becomes a live, shared, persistent universe, **changing the core recipe does not *update* the universe — it *replaces* it.** Tweak a dial and every planet everyone has ever discovered can shift: mountains move, skies change colour, the world your friend named last month becomes a different place. No Man's Sky actually lived this — some big updates regenerated worlds and players found their discovered planets changed underneath them, which upset a lot of people.

So the rule is: **once you go live and persistent, you freeze the core recipe.** New content after that point is added through the memory layer (Part 1.4 and Part 6) — stamped *on top* — never by rewriting the base. The encouraging flip side: **right now, before anything is live, you can rip the recipe apart and re-tune it as wildly as you want**, because there's no history to break yet. This is a major reason "nail one planet first" is the correct order (Part 9): the early stage is exactly when you tune the law of your universe while it's still cheap and harmless to change, *before* it hardens into something permanent that everyone shares.

### 1.4 The two layers, and the one storage rule

The whole system is two layers, and keeping them separate prevents almost every architectural mistake:

- **The Generation layer** — pure, computed, identical everywhere, stores nothing. This is the planet, the star, the orbit, the factory-fresh world. It's a function of coordinates (and, for slow things, of time — see Part 7.4). You can throw it away the instant the player leaves and lose nothing, because the formula re-produces it identically on return.
- **The Memory layer** — the small set of things that are **not** in the math, because they came from outside it (a player's free choices). What someone changed, what they named, what they built. This is the **change-list** (detailed in Part 6.3). It is stored, forever, and shared via a server. It is the only thing you actually keep.

**The one rule that settles every "do we store this or compute it?" question:**

> **Store what you can't recompute. Recompute what you can.**

Run any new idea through it. Examples:

| Thing | Layer | Why |
|---|---|---|
| A planet's terrain, sky, base creatures | Generation (recompute) | Pure function of coordinates; free and identical |
| A planet's position in its orbit right now | Generation (recompute) | Pure function of game-time (Part 4–5) |
| A star's age / whether it's died | Generation (recompute) | Pure function of game-time (Part 7.4) |
| Who discovered a planet first, and its name | Memory (store) | Not derivable from coordinates |
| A base someone built, a tunnel someone dug | Memory (store) | A free human choice; not in the math |
| The AI's written description of a place | Memory (cache) | The exact words can't be reproduced bit-for-bit (Part 6.4) |

### 1.5 Worked example: the blown-up mountain, fully wired

This is the example that makes people stumble, because two opposite questions get tangled: *"how does the mountain already exist?"* (Generation — math) and *"how is a blown-up mountain still blown up a month later?"* (Memory — stored difference). They are not the same question.

The formula only knows the planet in its **factory-fresh** state. It knows what the mountain looked like the moment the universe was born. It has no idea anyone ever touched it. So the instant a player blows that mountain up, that's new information from *outside* the math — and the recipe can't account for it. Run the coordinate again and it cheerfully rebuilds the pristine, un-blown mountain, because that's the only mountain it knows how to make.

So the crater survives not through the formula but through **memory** — and you don't store the mountain, or the planet. You store a tiny note recording only the *difference*:

> "At planet (galaxy 5, sector 12, star 3, planet 2), at this exact spot, the rock is gone."

That note is tiny — a few coordinates and "removed" — because it doesn't describe anything the formula already handles. It goes to the shared server. Now watch a second player arrive a month later, with the first player long gone:

1. Their machine feeds the coordinate into the formula and rebuilds the whole planet from scratch — including, for a split second, the pristine, un-blown mountain, because that's all the formula knows.
2. Before showing anything, their machine asks the server: "any notes for this planet?" The server returns: "rock gone, right here."
3. Their machine applies the note: it removes that rock from the freshly-built planet.
4. *Then* it shows the player — with the crater, exactly where the first player left it.

The crater isn't preserved like a stored photograph. It is **re-created fresh, every single visit** — the formula rebuilds the mountain and the note immediately re-destroys it the same way the first player did. Every visitor, forever, gets "the original planet, then the list of changes stamped on top." It *looks* like one persistent world; under the hood it's *recipe plus a list of changes*, reassembled live each time anyone looks.

Chalkboard analogy: the formula is a stencil — press it and you always get the same drawing, no memory. Someone wipes a chunk off; the stencil can't remember that. So you keep a little list on the side: "wipe this corner." Every time you re-stamp the drawing, you also re-do the wipes from the list. The drawing is free and re-creatable; the list of wipes is the only thing you keep.

### 1.6 A coordinate yields a *history*, not just a world (the time dimension)

Everything above describes a coordinate yielding *a world*. The Constitution (Principle 2) sharpens this: a coordinate yields a **history read at a moment in time.** The atom of the universe isn't an object, it's a *timeline* — a place forming, thriving, aging, dying, becoming a remnant — and the player intersects that arc at the current cosmic-time. The same coordinate is a lush world early in its story and an asteroid belt late in it; you find whichever chapter you arrive for.

This does **not** break anything above: the world is still a pure function of coordinates, just with **time as one more input** — `world = f(coordinates, game_time)` instead of `f(coordinates)`. It's still computed on demand, still stored nothing, still identical for everyone (game-time is shared). It's the same stencil, now pressed differently depending on *when* you look. (The full treatment — lifecycles for every significant thing, and the causal web that links them across time — is the Constitution, especially Principles 1–2 and Frontier 4 / Part 7.5 here.)

---

## PART 2 — Solving sameness (the make-or-break content problem)

Scale is cheap (Part 0). Sameness is the problem that actually decides whether your universe is worth visiting. A universe can be technically endless yet *feel* tiny because it keeps repeating itself — and that is precisely what NMS got hammered for at launch. This part is the content strategy that fixes it.

### 2.1 Why "add more randomness" makes it worse (the trap)

The instinct is: "planets feel samey because there isn't enough randomness; add more dials and more random variation." This instinct is a trap, and it makes the problem *worse*.

Here's why. When a planet's overall feel comes from rolling many random dials that are each centred on some average, the *combination* almost always lands near the middle — the same reason rolling two hundred dice almost always totals near the average, and extreme totals are vanishingly rare. So pure randomness gives you a mountain of "medium-hilly, medium-wet, medium-warm, medium-creatures" planets and only a handful of weird ones. Each planet really is randomly different in its *details*, but they're all statistically the same in the parts the brain actually notices. That bell-curve clustering is the real reason NMS felt repetitive: technically infinite, but everything hovered around the average.

### 2.2 Root cause: the variety is in the wrong layer

The surface *details* vary; the world's *identity* doesn't. Sameness is therefore a **content problem, not a formula problem.** A cleverer mixer won't fix it, because the mixer can only ever recombine the ingredients you hand it. Hand it bland ingredients and no amount of stirring produces an interesting meal. The cure is the quality and variety of the *ingredients*, not a smarter blender.

### 2.3 The deeper fix: hand-build the rules, not the output

A key realisation: **you can never *not* hand-build something.** Even a world that "invents itself" has to start from primitives somebody defined — what materials exist, what forces act, what a creature is even made of. So the real choice was never "hand-built vs free." It's *which layer* you hand-build:

- Hand-build the **finished pieces** and shuffle them → samey (this is the failure mode).
- Hand-build the **rules and raw ingredients**, and let the finished things grow out of them → rich, unique, with built-in reasons for being the way they are.

Build-from-rules techniques (all real, all already in your toolbox):

- **L-systems for plants:** you don't draw the tree, you write *how it grows*; the tree grows itself, differently every time, with a built-in reason — it grew that way.
- **Evolution-by-pressure for creatures:** define body-rules plus the pressures of a planet, and let creatures adapt to it. A cold world's animals end up furry and round not because you *placed* fur, but because the rules pushed them there.
- **Erosion-as-process for terrain:** run erosion over the rock and you get valleys that were *carved*, with a cause baked in.

The uniqueness and the "reason for being" are real here, because the thing formed itself.

### 2.4 The two catches (vetted honestly — this is where it gets hard)

Letting worlds form themselves is not free. Two walls:

- **Catch 1 — deep simulation does not fit an on-demand universe.** A simulation is a *process* that has to *run*, step by step, where the order of events matters and the ending depends on the whole path taken. You cannot leap straight to "the result of four billion years at planet X" from a quick calculation — you'd have to live through it. Dwarf Fortress, the gold standard of "everything has a history," does exactly this: it simulates *one* world *once* and then saves it forever. That is the exact *reverse* of your model (18 quintillion worlds, none saved, each rebuilt fresh the moment someone looks). So full open-ended history simulation, for every planet, on demand, simply doesn't fit the thing that makes your universe possible. This is a wall, not a snag.
- **Catch 2 — realism is mostly boring.** Most real geology is flat plains. Most of evolution is unremarkable beige animals. If you let a pure simulation decide everything, the dull-average problem from 2.1 walks right back in wearing a new coat, because reality itself is mostly average. Letting a world form its own story does not free you from curation; it just moves where you do the curating.

### 2.5 The resolution (the actual content design)

Three moves, together:

1. **Hand-build deep.** Author the *rules, materials, pressures, grammar, and archetypes* — not the finished worlds. Worlds grow themselves out of that, which is where the uniqueness and the built-in reasons come from.
2. **Simulate live, but only small, local, cheap things in front of the player** — the ecosystem on the planet you're standing on, the weather, a creature's legs finding footing on the actual ground. This is affordable, and the player can *feel* it happening.
3. **Generate (don't simulate) the deep past.** For "why is this ruin here, why did this species die out," don't run history — *generate a coherent backstory as a fact attached to the place*, derived from the seed. The freeing insight: **the player never experiences the simulation; they experience coherence and consequence.** They can't tell whether a backstory was lived out over four billion simulated years or written in two milliseconds, as long as it's consistent and the world around it agrees with it. So you spend effort on *coherence*, not on literally running history.

### 2.6 The content library that makes it work (the practical core)

This is the part you actually build, and it's where most of the "make one planet great" effort goes:

- **A library of bold, distinct, hand-designed world-kinds.** A frozen ammonia ocean with crystal spires is a fundamentally *different thing* from a volcanic ash desert with metal canyons — not a colder version of it. The system picks and *combines* a few of these strong building blocks per planet, rather than sliding one continuous dial.
- **It's still effectively infinite.** The variety comes from the *combinations* of strong pieces, plus smaller variation *within* each piece — the way a deck of 52 cards makes an astronomical number of distinct hands. Huge variety, every individual piece memorable.
- **Load the dice toward the interesting.** Deliberately bias the system to over-produce the strange and beautiful and under-produce the forgettable-average, instead of letting the bell curve bury the good stuff.
- **Enforce coherence.** Make the parts agree so each planet reads as one designed place rather than a random salad: a cold world's ice, creatures, colours, and plants should all reinforce the same story. A tropical creature wandering a frozen rock is exactly the mismatch that makes a whole world feel like noise.
- **Scatter rare, striking landmarks.** A giant arch you can fly through, a glowing red lake, an alien ruin. People remember *places*, not statistics. One unforgettable feature does more for a planet than a thousand subtly-different hills. "The one with the giant arch" is what sticks.

All of this stays **reproducible**: which archetypes a planet uses, the dice-loading, and where a landmark sits are *all derived from the seed*, so the stateless, store-nothing model (Part 1) is untouched.

**This is why "one planet first" is the right order.** When you pour effort into one planet, what you're actually building is this library of strong pieces plus the rules that combine them coherently. Once those are great, every one of your 18 quintillion planets inherits them for free. The hard, valuable engineering work and the "make it not samey" work turn out to be the *same* work.

---

## PART 3 — Corrections to the source research report

The external report you started with is ~80% sound. These are the parts that are wrong or risky, kept here so nobody re-introduces them.

### 3.1 Floating-point precision (the report's math is wrong by ~9 orders of magnitude)

The report claims 64-bit doubles give "sub-nanometer precision out to 1 trillion km." False. The spacing between representable doubles near a magnitude `x` is approximately `x · 2⁻⁵²` ≈ `x · 2.22e-16`.

Corrected thresholds (the numbers to actually design around):

| Distance from origin | Double (64-bit) spacing | Float (32-bit) spacing |
|---|---|---|
| 4,500 km | ~1 nanometer | ~0.5 m |
| 1 AU (1.5e11 m) | ~33 µm | ~18 km |
| 1 light-year (9.46e15 m) | ~2.1 m | ~1.1 billion m (useless) |
| 1 trillion km (1e15 m) | ~22 cm | useless |

**What this means concretely:**
- **Floats are unusable for world position past a few km.** At 1 AU a float can't resolve finer than ~18 km. This is the real reason you never store world position in floats.
- **Doubles are great inside a single star system** (sub-millimeter out to ~1 AU) but **fail at interstellar scale** (~2 m jitter at 1 light-year). So doubles alone are not enough for a galaxy; you need the hierarchical frame approach (Part 4).
- The report's "two-tier" idea (store in double, render relative to camera in float) is correct *within a system*. It is just not sufficient across systems/galaxies, which the report half-acknowledges but then under-specifies.

### 3.2 "The entire game is stateless" — misleading

Determinism applies to **static generated content** (terrain, biomes, creatures, orbital elements). It does **not** apply to the runtime simulation: game-time, player position/velocity, dynamic objects, AI, and player-made changes are all genuine mutable state. This is the Generation vs Memory split from Part 1.4. Conflating them (as the report's framing invites) leads to bad decisions like trying to make the simulation reproducible, which is unnecessary and expensive.

### 3.3 Marching Cubes is bad at sharp features

The report recommends Marching Cubes + Transvoxel. Marching Cubes produces *rounded* surfaces and cannot represent sharp edges (crystal faces, crisp cliffs, hard geometric alien structures) — it smears them. For "disgustingly amazing fidelity" you have a real choice:

| Algorithm | Sharp features | Complexity | Mesh quality | Notes |
|---|---|---|---|---|
| Marching Cubes | Poor (rounds everything) | Low | OK | Best-documented; what the report assumes |
| Naive Surface Nets | Poor-to-medium | Low | Smoother, fewer triangles | Good default; simple and fast |
| Dual Contouring | **Good** (preserves sharp edges) | Medium-High | Excellent | Needs the density field's *gradient* (normals at the surface); can produce non-manifold geometry you must guard against |
| Manifold Dual Contouring | Good + manifold-safe | High | Excellent | The "correct" version; most code |

**Recommendation:** start with **Surface Nets** for the vertical slice (simple, fast, smooth), and move to **Dual Contouring** only once you specifically need sharp geological features and have the gradient of your density function available (you'll have it anyway if you compute analytic normals — see 5.2). Transvoxel-style LOD stitching (seamless joins between chunks at different detail levels) is a property you bolt onto whichever extractor you pick; it's orthogonal.

### 3.4 The superformula caution is correct — keep it

The report says Murray "later clarified the final game doesn't directly use the patented version." This is accurate: after a patent-infringement scare, Sean Murray publicly stated the Gielis superformula was **not** used in the shipped game, despite many secondhand sources claiming otherwise. So the superformula is a legitimate *tool you may choose* for procedural cross-sections (limbs, shells, leaves, crystals), but don't treat "NMS uses the superformula" as fact, and be aware the formula itself is patented (verify current status for your jurisdiction before shipping commercially).

### 3.5 The 12-glyph coordinate encoding is UI trivia, not architecture

The report presents NMS's 12-glyph hex address as foundational. It's a *sharing/UI feature* (so players can type a coordinate to visit a friend's planet). Your real coordinate architecture is the frame hierarchy in Part 4. Build a human-readable address *scheme* if you want shareable coordinates, but don't let it shape your engine.

### 3.6 The hash advice is right; one clarification

Using a **hash function** (coordinate → pseudorandom value, order-independent) rather than a **seeded PRNG** (a stateful sequence) is correct and important — it's what lets any worker thread generate any chunk independently. The report's `sin`-based GLSL hash is correctly flagged as having precision issues on some GPUs — use it only for throwaway shader lookups, never for anything that must be identical across machines. **Do all canonical generation hashing with integer ops, not floats**, so results are bit-identical across every GPU/CPU. Float hashing drifts between vendors and will desync both multiplayer *and* the "seamless meaning" system (Part 7.3), which depends on two machines computing the same fact.

Because we've committed to **one shared universe across web and native** (Part 0, Decision 1a), this discipline extends past hashing to the *entire canonical generation pipeline*: the noise, fBm, domain warp, density field, and the biome/fact threshold decisions must all be deterministic across web, native, and server, which in practice means **integer/fixed-point math (or tightly-controlled software-float on CPU/WASM only)**. See Part 0, Decision 1a for the full requirement, the must-match-vs-may-drift split, the two architectures, and the conformance test suite that guards it.

### 3.7 Where the report is genuinely good (keep these)

- The seed-chain derivation (each level hashes its full hierarchical address). Correct and clean.
- 3D noise on the sphere surface to avoid pole/seam artifacts. Correct — never use 2D lat/long noise.
- fBm + domain warping as the terrain core. Correct; domain warping is the highest-leverage technique.
- The async chunk-streaming architecture (generation off the main thread). Correct and mandatory.
- Whittaker temperature/moisture biome model, triplanar texturing, Rayleigh/Mie atmosphere. All correct and standard.
- The session-overlay multiplayer model (store only player positions + deltas + discoveries; everyone recomputes the universe). Correct, and it's the same Memory layer from Part 1.4.

---

## PART 4 — The coordinate / orbit / streaming architecture

This is the engineering core, and the part the source report omitted: real orbits, the coordinate system, and chunk streaming are **one** problem, not three. Read this section twice.

### 4.1 The core realisation: real orbits do NOT break determinism

NMS fakes orbits (the sun is an animated skybox; planets don't move) to avoid the plumbing below — **not** because moving planets break the stateless model. Here's why they don't:

- Terrain is generated in the planet's **body-fixed frame** — a coordinate system glued to the planet, rotating and orbiting *with* it. In that frame a given surface point never moves, so `terrain(position_bodyfixed, seed)` stays a pure, reproducible function. Unchanged.
- The planet's **placement** in the system (its orbit position + spin orientation) is a transform that is a pure function of one number: **game-time `t`**. `placement(t)` is deterministic (the orbital elements are themselves derived from the seed).
- Therefore the only state you ever persist is **game-time `t`**, **player state**, and **player-made changes** (the Memory layer, Part 1.4). Everything visible is `generation(coords)` combined with `placement(t)`.

This is the whole trick. Internalise it and the rest is bookkeeping.

### 4.2 The reference-frame hierarchy

You never compute astronomically large absolute coordinates. You nest local frames and *swap which one you're in* as you travel. Each level has its own unit and its own numeric type chosen to keep precision adequate (see Part 3.1 for why each type):

```
INTERGALACTIC frame        unit = 1 Mly       int64 galaxy-grid coords
  └─ GALAXY frame          unit = 1 ly        int32 sector coords + float local offset
       └─ SYSTEM frame     unit = 1 km        double, inertial, star fixed at origin
            └─ [ORBIT transform = f(game_time)]   ← planet's position in the system right now
                 └─ PLANET BODY-FIXED frame   unit = 1 m   double, rotates with the planet
                      └─ [SPIN transform = f(game_time)]  ← which way the surface faces right now
                           └─ FLOATING-ORIGIN frame   unit = 1 m   float, re-centered on the player
                                └─ RENDER + PHYSICS happen here, in float, near (0,0,0)
```

- **Generation** reads from the BODY-FIXED frame (double / meters). Reproducible, time-independent.
- **Placement** (orbit + spin) are the two `f(game_time)` transforms. Deterministic, cheap.
- **Rendering/physics** happen in the FLOATING-ORIGIN frame: a float-precision frame continuously re-centred so the player is always near the origin and floats stay precise. This is "origin shifting," but here it's *attached to the moving planet frame* — the detail the report missed.

### 4.3 The frame handoffs (the plumbing)

A "handoff" is when you change which frame is active. Each is a discrete event with specific bookkeeping.

**Surface ↔ Orbit (leaving/landing on a planet):**
- While landed, your active frame is the planet's BODY-FIXED frame. You "ride" the planet — you move with its spin and orbit automatically because you're expressed in its frame.
- On launch, switch your active frame to the SYSTEM frame. At that instant you must **inherit the planet's velocity** (orbital velocity + the tangential velocity from spin at your latitude), or the planet appears to rocket away. (Design choice: realistic inheritance, or a gentle "fly free" cheat. Realistic feels better and costs one velocity addition.)

**System ↔ System (interstellar jump / FTL):**
- Unload the current SYSTEM frame. Load the destination SYSTEM frame at its own local origin (star at 0,0,0). You're now expressed relative to the new star. The galaxy-level position is tracked in the GALAXY frame as `int32 sector + float offset`; the jump updates that integer address and rebuilds the SYSTEM frame fresh.

**Galaxy ↔ Galaxy (galactic-core warp):**
- Update the INTERGALACTIC `int64` galaxy index. Rebuild the GALAXY frame for the new galaxy. Galaxy "type" (its biome/star-distribution presets) is hashed from the new galaxy index.

### 4.4 Riding a rotating planet: where physics actually runs

A planet's surface point can be moving at tens of km/s in system-inertial space (orbital velocity) plus hundreds of m/s from spin. If you ran the player's physics in SYSTEM coordinates, every frame's floats would be dominated by that huge velocity → jitter and tunneling.

**Solution:** while on the surface, run all physics in the planet's BODY-FIXED frame, then apply the SPIN and ORBIT transforms only at render time to place everything in view. The player, terrain, creatures, and dropped objects all live in body-fixed meters. The planet's motion through the system is "invisible" to surface physics — exactly as standing on Earth feels still despite Earth's 30 km/s orbit.

**Cost to be aware of:** if you want *physically correct* rotation effects (Coriolis, centrifugal — e.g. weather patterns, or noticeable spin on a small fast-rotating moon), add them as explicit pseudo-forces in the body-fixed frame. For most gameplay you can ignore them; budget them only where a planet spins fast enough to matter.

### 4.5 Time compression (or nothing visibly moves)

Real orbital periods are months to years; real days are ~24h. With real time scales the player never *sees* a planet move. You must compress time, and that introduces a precision trap.

- Pick a compression so a "day" is minutes and a "year" is hours (tune for feel). A single multiplier on game-time.
- **The trap:** `game_time` grows without bound. Feeding a huge `t` into `sin`/`cos` for orbital angles in float collapses precision and orbits stutter. **Fix:** compute the orbital/spin *angle* in double, then reduce it modulo 2π *before* converting to float for the GPU. Angles stay bounded and smooth forever.
- Moons orbiting planets orbiting stars = nested `placement(t)` transforms; compose them (matrix multiply, parent-to-child). Real moon-on-planet shadows then fall out of the lighting system *if* your shadow system accounts for these world positions — a real but bounded rendering cost (one extra shadow caster).

### 4.6 What you persist (the entire save state)

To make Part 1.4 concrete, the complete authoritative state for the whole universe is:

- `game_time` (one monotonically increasing double).
- Per player: current frame address (galaxy/system/planet), local position, velocity, inventory, and personal journal/log (Part 6.4).
- Player-made deltas: terrain edits (sparse voxel changes layered over generation), placed structures, discovery names, and — later — the digested "usage facts" that feed players-as-weather (Part 7.6).

Nothing else. Every planet, creature, star, and orbit is recomputed from coordinates + `game_time`. This is what lets the universe be effectively infinite while the database stays tiny.

---

## PART 5 — The math that actually matters

Only the load-bearing formulas, each with the gotcha that bites people. The source report has the rest.

### 5.1 The hash (foundation of everything)

Use an **integer** hash for all canonical generation (bit-identical across machines → multiplayer- and seamless-meaning-safe). A PCG-style or wang-hash variant is fine. Rules: hash the *full hierarchical address* (galaxy, sector, system, planet, plus a per-purpose salt like "terrain"/"biome"/"fauna"/"history") so every property is independent and reproducible; never use float hashing for canonical values; reserve `sin`-based float hashes for disposable shader noise only. **(Now pinned: the canonical hash is PCG — Jarzynski & Olano's `pcg`/`pcg2d`/`pcg3d`/`pcg4d` — with exact WGSL+TypeScript code and the seed-chain in `canonical-generation-pipeline.md`. Use that; "wang" is no longer the choice, as it's dominated by PCG on both speed and quality.)**

### 5.2 Terrain: fBm + domain warp

- **fBm** (sum of noise octaves): correct as the report states. Normalise by the sum of amplitudes so output stays in a known range.
- **Domain warp** — `f(p + α·g(p))` where `g` is itself a vector of noise — is your single highest-leverage tool for overhangs, arches, cave mouths, and non-repetitive geology. Use 1–2 warp iterations; more gets expensive and mushy.
- **Trap — normals:** computing normals by finite differences (sampling density at p±ε) triples your noise evaluations. Prefer **analytic derivatives** (derivative-aware noise that returns value *and* gradient in one pass). This speeds you up *and* gives you the gradient Dual Contouring needs (3.3).

### 5.3 Seamless noise on a sphere

Sample **3D noise at the 3D Cartesian point on the unit sphere**, never 2D lat/long (which seams at the date line and pinches at the poles). Rotate the sample point by a per-planet seed so each planet's terrain is unique. The #1 beginner mistake; restated.

### 5.4 The density field (the heart of a volumetric planet)

A volumetric, mineable planet is a single scalar field `D(p)` over 3D space: `D > 0` is solid, `D < 0` is air, the surface is `D = 0`.

```
D(p) = planetRadius - length(p) + fBm(normalize(p) · noiseScale) · terrainHeight
       - caves(p)            // subtract a second noise field to carve tunnels
       + ridges(p)           // add ridged noise for mountain spines
```

Everything — terrain, caves, overhangs, seabed, the planet's basic sphericity — is encoded here. Your mesh extractor (Surface Nets / Dual Contouring) turns `D` into triangles. Player edits become a *sparse additive layer* on top of `D` (stored as deltas, per Part 4.6). Evaluating `D` is your hottest loop (millions of voxels) → it belongs in a **WebGPU compute shader**, never on the main thread.

### 5.5 Cube-sphere + quadtree LOD

Project 6 cube faces onto the sphere; each face is a quadtree; split a node when its on-screen size exceeds a threshold. This gives seamless detail from "one low-poly sphere in orbit" to "millions of triangles underfoot." **Trap:** the real cost is not triangle count, it's **mesh-generation throughput** (chunks built per second as you descend). LOD that's too aggressive thrashes the generator and causes stutter. Budget by *chunks generated per frame* with a hard cap, and hide latency by generating ahead along your velocity vector.

### 5.6 Orbital mechanics (Kepler)

Per planet, derive orbital elements (semi-major axis `a`, eccentricity `e`, inclination `i`, etc.) from the planet seed. Position from time requires solving **Kepler's equation** `M = E − e·sin(E)` for the eccentric anomaly `E`. Newton–Raphson converges fast.
- **Trap 1:** Newton–Raphson can converge slowly or fail for **high eccentricity** (`e > ~0.8`). Cap generated eccentricities below that (recommended — keeps orbits stable and good-looking), or use a more robust solver for the rare high-`e` case.
- **Trap 2 (the big one):** feed a **bounded** mean anomaly. Compute `M = M₀ + n·t` in double, then take `M mod 2π` before solving. Otherwise large `game_time` destroys precision (Part 4.5).
- Compose moon→planet→star transforms by matrix multiplication, parent first.

### 5.7 Atmosphere (Rayleigh + Mie scattering)

Physically-based sky colour from light scattering. The report's coefficients and phase functions are correct. **Trap:** real-time multi-scattering is expensive. For 60fps on the web, **precompute scattering into lookup textures (LUTs)** per atmosphere type and sample them in the sky shader rather than ray-marching the full integral every frame. Parameterise a handful of atmosphere presets by seed (sky colour = vary the Rayleigh RGB ratio; haze = vary Mie density). Don't generate a unique LUT per planet at runtime; bucket planets into a few atmosphere classes.

### 5.8 Triplanar texturing

A cube-sphere has no clean UVs, so texture from world position by blending three axis-aligned projections, weighted by the surface normal. Combine with slope/altitude-based material selection for natural zone transitions.

---

## PART 6 — Persistence, discovery, and the shared universe

This part specifies the Memory layer (Part 1.4) in full, plus the discovery system and the lore generator. It's what turns "a deterministic universe" into "a *shared* universe with a living history."

### 6.1 The discovery system (real space exploration)

- **Stars are cheap from far away.** You only need the top of the recipe to know a star's position, colour, and brightness, so you can paint a real, explorable star map without generating any planets.
- **A star's planets are built only when you go there or scan it.** Same "cheap far, detailed near" rule as terrain streaming (Part 5.5).
- **Discovery is the trigger for generating ahead.** The systems next to ones you've found — especially in your direction of travel — are the ones worth generating ahead of you. This is smart streaming pointed at lore instead of terrain. Caveat: generating ahead is a *guess* (the player might turn around), so keep each unit of work cheap and throwaway. ("Start generating on your journey" means *generate facts and prose ahead of you*, not spin up a running history simulation, which doesn't fit the on-demand model — Part 2.4.)

### 6.2 First-come-first-served: what it actually means

The misunderstanding to avoid (Part 1.2): the first computer to reach a planet does **not** create it — it **reveals** it. Every visitor recomputes the identical planet.

First-come-first-served *is* the correct design — for the things that genuinely aren't in the math: who discovered a planet first, what they named it, the "discovered by you" tag, the base someone built, the tunnel someone dug. None of that is derivable from coordinates, so it really is created by whoever got there first, it really does persist because of them, and the universe really does accumulate a living history of who-did-what-first. That history is real — it just lives in the thin **Memory layer** (the change-list), on top of the planet, rather than in the planet's rocks.

### 6.3 The change-list in depth (the Memory layer fully specified)

- **What it stores:** only *differences* from what the math says — and stored as the **cause (an operation), never the result.** Tiny notes: `{explosion, here, this radius, this force, at this game-time, edit-seed}`; `{structure placed, here, this blueprint}`; `{discovered, named "X", by player Y, at game-time T}`. A blast that shatters 50,000 voxels is one note, not 50,000 — re-running the operation regenerates all of it. **The stored data scales with the number of *actions*, not the amount of terrain they affected.** It never stores the planet or the terrain.
- **It's an ordered log, not an unordered pile.** Each edit carries its moment in time, and to render a region you **replay the operations touching it in sequence order** on top of the recomputed base terrain. Order matters (dig a pit, then fill it ≠ fill, then dig). The canonical order is the one the real-time presence layer's referee decides (Part 6.6) — and *that* order is what's stored, so replay always reproduces the same final state.
- **How it's applied:** recompute the pristine world from coordinates → fetch the operations for those coordinates → replay them in order → render. Every visit, fresh (Part 1.5).
- **Reconstruction fidelity: detail is recomputed, not stored — so rich detail is free.** The crater's irregular (non-round) shape, scorch pattern, radial cracks, and settled rubble are all generated *deterministically* from the stored operation's parameters + edit-seed, *and* from the deterministic terrain it hit (a blast on a slope craters differently than on flat ground, reproducibly). So a rebuilt edit can be arbitrarily detailed and looks **exactly** as it settled — limited only by how good the edit-effect generator is, not by storage. **Discipline that makes this work:** every edit *effect* must be a deterministic function of (operation parameters + seed + the terrain), never of live physics randomness. The edit-effect generator is therefore part of the **canonical, frozen recipe** (Part 1.3) — change it later and old craters rebuild differently.
- **What's reproduced is the settled *result*, not the live *moment*.** The next visitor sees the settled crater, not a replay of the explosion (just like walking past a real crater — you see the hole, not the blast). The transient spectacle (flying debris, dust) was cosmetic and is gone (Part 6.6).
- **Canonical vs. transient — the dial that controls storage.** Most "millions of little things" (footprints, gunfire scorch, bent grass, bouncing debris, dust) are **cosmetic and transient**: they live for the moment, are never stored, and the next visitor never sees them → zero storage. Only the *meaningful, durable* subset persists (deliberate mining/building, structures, large craters, depleted resources, bases). The vast majority of every planet is never touched → pure recompute → zero storage. The change-list is sparse; empty space is free. *What would* blow up storage is the naive "save every changed voxel" — which we never do.
- **Verification is free (anti-cheat).** Because the true world is recomputable, anyone — including the server — can recompute any planet from its coordinates and instantly check a claim against the math. A hacked client can't mint a planet stuffed with rare loot, because there's an independent "correct" planet to check against. (This is a major reason to reject "first render becomes canon," which throws this away — Part 7.7.)
- **Keep the log minimal, and digest the heavy stuff.** Storing operations keeps single actions tiny. For genuinely heavy freeform reshaping (thousands of hand-dug strokes), **digest the strokes into the high-level shape they represent** — "a tunnel runs A→B," "a 50 m clearing here" — one compact fact that regenerates the shape on demand. This is Frontier 0 (Part 7.1), and it's what keeps even a heavily-terraformed planet's footprint bounded.
- **One shared backend serves both clients (Part 0, Decision 1a).** Web and native players hit the *same* Memory layer and the *same* authoritative generation core (which the server runs to validate claims). Keep the wire protocol platform-neutral so the native client speaks it too — don't make it browser-specific. A player's account, discoveries, and bases follow them across both clients.

### 6.4 Facts vs Flavor — and how the prose is actually generated

This is how you get rich lore for an infinite universe without breaking the store-nothing model. Split the world into **facts** and **flavor**, and generate the flavor from the facts:

- **Facts** are generated by the math from coordinates, and — crucially — they can look at the *neighbors'* coordinates too, because neighbors are also just math. ("This system sits in a war-torn region held by faction X." "This planet is a dead world after a cataclysm." "These two stars are old trade partners.") This is how worlds *relate to each other* and have reasons, with **zero dependence on player history.** (The math of making neighbors agree is Frontier 2, Part 7.3.)
- **Flavor** is the readable prose generated *from* those facts. Whatever generates it is a **travel writer, not a novelist:** it describes the fixed facts in varied, evocative ways, but it never invents the world. A travel writer describes the same mountain a hundred lovely ways, but the mountain stays exactly where it is, so everyone's account agrees. A novelist invents the mountain, and then no two players' versions match and you must store every version forever.

**The recommended tool: deterministic template/grammar generation (not a runtime AI).** Fill-in-the-blanks sentence skeletons drawing from large, fact-gated vocabulary bags — the proven approach behind the beloved procedural lore in Dwarf Fortress, Caves of Qud, and RimWorld. We picked this over a live AI text model for one decisive reason: **template prose is *recomputable*.** It's a pure function of the same facts + seed, so it costs nothing to store, lives in the Generation layer (not Memory), is identical for everyone for free, and appears instantly. A live AI was the *one* feature that broke the plan's "store what you can't recompute, recompute what you can" rule — it forced caching precisely because an AI can't reproduce its own exact words. Templates make that whole problem vanish. (The full content pack — the actual vocabulary and templates — is a separate deliverable; this section just fixes the architecture.)

**Rules for the template generator:**
- It's part of the **canonical generation core** (Part 0, Decision 1a): deterministic, integer-hash-selected (`pick = hash(seed, slot_id) mod options`), so the same place reads identically on web, native, and server. No caching, no storage, no server round-trip — it runs locally the instant a place is described.
- **Coherence is enforced by fact-gating the vocabulary** (Part 2): a "frozen" world only ever draws from cold-appropriate words, so you never get a frozen jungle. Higher-detail descriptions (planet history) are refinements of lower-detail ones (a star-map blurb), all driven by the same facts, so zoom stays consistent for free (ties to Frontier 3, Part 7.4).
- **The soul of a place is in its *facts*, not its prose.** Rich, surprising facts (which the five frontiers exist to produce) read well even in plain template prose; boring facts read flat no matter how fancy the prose. So the investment goes into the fact systems; the prose layer is secondary and cheap.

**Where AI actually belongs here: as an *offline authoring tool*, not a runtime service.** Use an AI at *development* time to help write a larger, richer set of templates and vocabulary than you'd produce by hand — then ship those and run them deterministically with **no AI anywhere in the live game.** This captures most of an AI's quality benefit with none of its runtime costs (money, latency, ops, tone-drift, hallucinated contradictions).

**The live runtime AI writer is an optional, much-later enhancement — not the default and not a priority.** Only consider it if, in playtesting, the template system genuinely starts to feel thin *and* you have the resources to run and scale a model-serving layer *and* it's worth it against everything else competing for your time. If you ever do add it, it must stay a "travel writer" anchored to the facts, run **off the render GPU** (on a server or in true idle moments), and have its output **cached by coordinate** (since AI prose isn't recomputable) — i.e. it would re-introduce a small Memory-layer cost that the template path avoids entirely. That trade is why it's optional, not standard.

- **The personal, path-dependent stuff has its own home.** Your journal, your ship's log, the names *you* give things — that's allowed to depend on your journey, because it's already in the "save the player's own stuff" bucket (Part 4.6). You get a record shaped by your path; it just lives on your character, not baked into the shared planet.

### 6.5 Which game you're building (the fork to stay on the right side of)

The lore question forced a real decision, and it's worth stating so nobody drifts across the line later:

- **Path A — the shared, effectively-infinite, save-nothing universe** (what we're building). The prose generator is a *describer* anchored to deterministic facts. Everyone who visits a coordinate sees the same world and reads the same plaque.
- **Path B — a personal, AI-authored world** where an AI invents freely from your path. That's a real and cool game too (closer to an AI-driven Dwarf Fortress), but it's *yours alone* — no one can visit your version — and because you now save everything, the scale shrinks dramatically.

Both are legitimate; they're different products, and almost everything downstream depends on which one you pick. We are building **Path A.** Keep every feature on Path A's side of this line: anything that makes the canonical world depend on a specific player's path belongs in the personal/journal bucket, not in the shared world.

### 6.6 The two layers: persistence vs. real-time presence (the "during")

Everything above (the change-list) is the *after* — a durable record of what's true here now, re-applied when someone visits later. It does **not** answer "what happens while two players are on the same planet at the same moment, and one is actively blowing up a mountain right in front of the other?" That's a **separate system with separate rules.** Conflating the two is a common confusion; keep them distinct.

| | **Persistence (the change-list, 6.1–6.3)** | **Real-time presence (this section)** |
|---|---|---|
| Job | What's *durably true* here ("the mountain ended up destroyed") | What's *happening right now* between co-present players ("I'm watching you destroy it") |
| Lifetime | Forever, eventual | This moment only |
| Analogy | The security-camera *recording* | The live phone *call* |
| Infra | Durable store (Supabase-style) | Low-latency relay + referee |
| Who sees it | Every future visitor | Only players present together now |

**The honest physics that bounds it.** The other player is out in the world, and information takes time to reach you (tens to ~200 ms round trip). So you *cannot* see their action at the exact instant they do it — there is no trick around the speed of the connection. "Perfectly simultaneous" is off the table. What's achievable — and what every multiplayer game actually is — is "the same thing, with a small delay, with tricks to hide the delay." It feels live and shared; it isn't frame-for-frame identical.

**The live model — what gets synced and how:**
- **Seeing the other player:** their client constantly sends "where I am, facing, moving" (many times a second); your client draws their avatar and smoothly animates between updates. You see them as they were a fraction of a second ago — smooth, slightly in the past. It's symmetric (they see you in the past too); neither view is "wrong."
- **Seeing them edit the world (the elegant part — it's Frontier 0 again, live):** when they set off a blast, their client does **not** send you the resulting crater. It sends the *cause* — "explosion, here, this big, now" — and your client plays it out. Because both clients already hold the *identical* deterministic terrain and apply the *identical* operation, you both arrive at the *identical* crater. **Send the spark; both screens grow the same fire.** This is the same send-the-cause/compute-the-aftermath principle as storage, applied to a live moment.
- **Canonical vs. cosmetic, live:** the *crater* is gameplay-relevant, so it matches on both screens (identical operation). The individual chunks of flying debris are *cosmetic* — no two players compare where a specific rock bounced — so those may differ slightly per machine. Same split as web-vs-native (Part 0, Decision 1a): the thing that matters is identical; the decorative spray is free to vary. You never have to network every tumbling pebble — only the final hole.
- **The referee = server authority.** A server decides the canonical *order* of events ("their blast landed at this moment, your dig at that one"); both clients fall in line, and a client that guessed wrong while waiting on the network quietly corrects. **This is the bridge between the two layers:** that server-decided order is exactly what gets written into the change-list (6.3). The "during" and the "after" are the *same events* at two stages — live propagation while it happens, then the durable ordered record once the referee settles it.

**So, the precise answers:** Do you see them? Yes (slightly delayed). Do you see them destroy the mountain, live? Yes (you receive the cause and play it out). Are you seeing the same thing? The static world and the final crater: identical. The timing *during* the ~1-second event: slightly out of phase, converging perfectly at the end.

**Two honest notes on scope:**
- This is a **substantial, separate body of work** — real-time game networking (smoothing remote players, predicting your own actions so they feel instant, correcting mismatches, conflict resolution) — distinct from the persistence database, and it needs its own **low-latency infrastructure** (a fast relay/referee for players who are *near each other*), separate from the durable store that holds the change-list.
- In a universe this size, **two players being on the same planet at the same instant is rare** — players are spread impossibly thin. So this serves an uncommon-but-magical case, not the everyday loop. That affects priority (it's a later ring) and makes it *technically easier* than a crowded arena (you rarely have many people in one spot). It is, notably, exactly the co-presence NMS lacked at launch (two players at the same spot saw nothing of each other) — so building it is what closes the gap NMS itself fell into.

**Already wired:** co-present players both operate in the planet's **body-fixed frame** (Part 4) and sync positions in that frame, so they line up with each other regardless of where the planet is in its orbit.

---

## PART 7 — The five frontiers: the systems that make it alive

This is the part we most want to get right. These five systems are what take the universe from "technically infinite and correct" to "feels alive and reactive." Each is described as a problem, a plain-language picture, **our concrete solution (the design we'll build)**, the genuinely hard core and how we handle it pragmatically, and how it wires into the rest.

A note on honesty, because the rule of this document is "no hand-waving": a couple of these have an open research edge at their *fully general* extreme. We do **not** need the fully general version for v1. For each, the design below is a real, buildable solution that gets our universe what it needs, and the remaining hard edge is flagged and bounded so it never blocks us.

### 7.0 The shape every frontier shares + the one-question filter

Every real frontier here is the same question in different costumes: **how do you get the *feeling* of a living, deeply-simulated, hand-authored world while keeping the cheapness, the shared-ness, and the store-nothing purity of pure computation?** That tension never goes away.

The walls are always one of two shapes:
- You **can't compute the genuinely unpredictable** (the free choices of people who haven't chosen yet — proven in 7.1).
- You **can't store the infinite.**

The open ground is always one of three shapes:
- Compute the **rule-governed consequences** of things, rather than the things themselves.
- Make independently-generated pieces **agree** cheaply.
- Resolve a thing **only to the level of detail someone is actually observing.**

**The one-question filter — use it on every future idea (it sorts in ~3 seconds):**

> **Does this require computing something a human hasn't decided yet?**
> - **Yes** → it's a wall, no matter how clever the wrapping. Don't build it.
> - **No** (it only needs the *consequences* of decisions already made, the *equilibrium* of known rules, or *consistency* between independent pieces) → it's a real frontier. Build it.

### 7.1 Frontier 0 — Store the seed, compute the aftermath; digest history into meaning

This one underpins the others and directly upgrades the Memory layer (Part 6.3). It's "Frontier 0" because everything else leans on it.

**The problem.** A dumb change-list (frozen "rock gone, rock gone, rock gone") makes a *dead diorama*, and it grows without bound as players keep editing.

**The wall we accept first.** You *cannot* make the change-list vanish — i.e. you can't invent a formula that computes which mountains players blew up so you store nothing. This is provably impossible, not an engineering gap: a player's choice is genuine new information that exists nowhere in the math (it came from a human brain), and a settled result in information theory says you cannot compress truly unpredictable information into something smaller than itself — you can't fit a gallon of water into a thimble. Worse, such a formula would be *predicting human decisions before the humans made them*, and a human can always do the opposite to spite it. So the **seed of human intent must be stored.** That part is fixed and final.

**Our solution, part 1 — store only the seed, compute the aftermath.** Save four numbers: `{explosion, here, this big, at this time}`. From that seed, the *rule-governed consequences* unfold by formula: debris tumbling downhill, water pooling in the crater, plants creeping back over the scar across years, erosion rounding the sharp edges. You compute everything the choice *causes*, not the choice. The thimble of water (the human choice) you must store; the flood it sets off is free.

**Our solution, part 2 — digest edits into meaning over time.** The real world doesn't remember every raindrop; it remembers the *river* the raindrops carved. So digest a player's thousand little edits into a few high-level facts — not "these 4,000 blocks were removed" but "a road runs from here to here" — one cheap, compact fact that the math can re-draw on demand, the way it re-draws mountains. The world learns the *shape* of what people did and folds the busy details back into rules, keeping only the meaning.

**The hard core, handled.** There is no clean *general* algorithm for "digest an arbitrary pile of edits into the high-level fact it represents" — that sits at the edge of procedural generation, compression, and simulation. We do **not** attempt the universal digester. Our pragmatic approach: ship seed-and-aftermath first (very buildable), then add digestion **incrementally, per recognizable edit-type** — a dug tunnel, a cleared forest, a worn path, a row of structures along a line all become a single named fact. Each pattern is a small, contained recognizer, not a universal one.

**The payoff.** A living universe — your crater erodes, fills with water, grows a forest, and becomes a lake another player stumbles on years later — instead of a frozen one. We were chasing "store nothing"; the better prize is "store the seed, and let the universe grow the rest."

**Wiring.** Upgrades Part 6.3. Natural change (erosion, regrowth) is computed; only the human seed is stored. Feeds Frontier 5 (players-as-weather), which digests *aggregate* behavior the same way.

### 7.2 Frontier 1 — Compute the equilibrium, don't run the process

**The problem.** The systems that make a world feel alive — climate, ecosystems, populations, erosion — are normally *processes* you run forward in time until they settle. But a process has to *run*, step by step, and that doesn't fit a store-nothing universe (Part 2.4).

**Our solution.** Jump *straight to the settled answer* with a formula, skipping the running entirely. Compute where the canyon *ends up* without simulating ten thousand years of rain. Compute the *balanced* food web — who eats whom, how many of each, where the herds migrate — directly from the planet's traits. It's identical for everyone and free to recompute, yet it *feels* emergent because it obeys the same rules a real ecosystem would.

**Plain-language picture.** Instead of dropping a ball in a bowl and watching it roll around, you *calculate* the spot at the bottom where it will come to rest.

**The hard core, handled.** Two honest caveats. First, finding the resting spot sometimes still needs a little *iterating* (run a calculation until it settles) rather than one clean shot. We handle that by capping the iterations and **caching the settled result per coordinate** — it's deterministic, so even an iterative settle is paid once and is re-derivable, never a per-frame cost. Second, some systems have *several* stable resting spots (a planet could settle into more than one valid climate). We handle that by **using the seed to pick which equilibrium this planet got** — deterministic, and it adds variety rather than ambiguity.

**The payoff.** A general way to do this makes climate, ecology, geology, *and* populations all affordable in one stroke.

**Wiring.** Feeds biome/creature/terrain generation; the "settled" outputs become *facts* in the Facts-vs-Flavor model (Part 6.4). Pairs naturally with the "simulate live, small and local" rule (Part 2.5): the equilibrium is the cheap global truth; the live local simulation is the detail you feel up close.

### 7.3 Frontier 2 — Seamless *meaning* (the deepest one)

**The problem.** Your geometry already solves seamlessness in *space*: a mountain flows smoothly into the next chunk even though the two chunks were generated independently and never compared notes. Now apply that same idea to *meaning*. If this system is "held by the Empire, at war with the neighbor," the neighbor — generated separately, on a different player's machine, with no communication — must *agree*: it should think it's the Rebels, that the war is real, that the border runs where this system thinks it does. A river leaving a region must *arrive* in the next one. A trade route must connect two cities that both believe they're connected.

**Plain-language picture.** Two strangers at opposite ends of a table, each drawing one half of a single map, having never spoken — and the roads, rivers, and borders all meet *perfectly* in the middle.

**Our solution.** The trick that makes *spatial* seams work is that each chunk computes its shared edge purely from shared coordinates, so both sides independently arrive at the same edge. Apply the identical principle to facts: a *relationship* between two systems is computed from **both their coordinates by a symmetric rule** — feed both coordinates into one function that returns the same answer regardless of order. So System A asking "what's my relationship to B?" and System B asking "what's my relationship to A?" run the same function on the same pair and get the *identical* answer. A border is computed from the pair of regions it divides. A river's exit point is computed from the shared edge, so the neighbor computes the same entry point. No coordination, no stored data — both sides *derive* the agreement from the same math.

**The hard core, handled (this is the genuinely open one).** Chains of relationships can conflict — A vs B and B vs C are easy, but what's A vs C? (transitivity). And long-range consistency (a river crossing many regions, a trade network spanning a whole sector) needs each piece to derive the same *global* structure from local-only information. We do **not** solve the fully general transitive version. Our approach: design relationships to be computable from a **small, fixed neighborhood** — your immediate neighbors plus a shared higher-level "region fact" that both of you can compute from the *region's* coordinate. Global structure is then *anchored by a cheaply-shared parent fact* rather than negotiated pairwise across the whole galaxy. This bounds the problem to something buildable; the fully general version stays a research edge we don't need for v1.

**Wiring.** The facts this produces are exactly the "facts" the lore generator describes (Part 6.4). Rivers tie to terrain generation; borders and factions tie to the economy/faction game-ring (Part 9). This is the connective tissue under civilizations, history, and "everything has a reason" — point invention energy here first.

### 7.4 Frontier 3 — Detail-on-demand for *simulation* (not just polygons)

**The problem.** This is the affordability key that makes "deep everywhere" survivable. You already do level-of-detail for *visuals* (coarse and cheap far away, sharp and expensive up close). Do the same for *depth of reality.*

**Our solution.** From orbit, a civilization is a single number — "spacefaring, roughly medium-tech." Fly closer and it sharpens into specific cities. Closer still, into specific people. Closer still, into one person's specific grievance against their neighbor. You only ever compute down to the level someone is actually observing — so it's cheap.

**Plain-language picture.** A photo that stays *honest* as you zoom: the fuzzy blob you saw from a distance turns out to be consistent with the crisp detail underneath, the way a coastline's big shape genuinely predicts its small wiggles rather than betraying them.

**The hard core, handled — and this one is solvable by discipline.** The guarantee is that the sharp detail you find up close must *never* contradict the blurry glimpse from far away. We get this *by construction*: make each finer level a deterministic **refinement** of the coarser one — the coarse value is computed first and is fed in as a *constraint* on the fine value. Fine detail is born *inside the box the coarse value drew*, exactly the way fBm adds fine octaves on top of coarse ones without moving the mountains. "Medium-tech, population ~2 million" constrains the city generator, which constrains the person generator. The strict rule: **always generate coarse → fine, with the coarse value as an input to the fine one. Never generate fine first and hope it matches.** Follow that discipline and consistency is automatic. The remaining *labor* (not a wall) is authoring rich, interesting content at every zoom level.

**Wiring.** This is the general mechanism behind everything affordable: it's *how* the Facts model (Part 6.4) and Seamless Meaning (7.3) stay cheap. Detail-on-demand + seamless meaning together (consistent refinement is *how* you make seamless meaning affordable) is the single richest vein in the whole project.

### 7.5 Frontier 4 — The universe as a function of *time*

**The problem/opportunity.** The universe is a formula of *where* you are; orbits added a formula of *when* (game-time) for positions. Push it further: let the *slow* state of everything be a function of time too.

**Our solution.** Stars age, swell into red giants, and die. Young hot systems versus ancient cooling ones. The same star system, visited at game-year 100 versus game-year 100,000, is genuinely *different* — and identical for everyone (shared game-time, pure formula), with *nothing stored*, because the past and the future are both *computable*.

**Plain-language picture.** A clock you can spin forward or back and simply *read off* what the sky looked like at any moment, without anyone having recorded a single tick.

**The hard core, handled.** This one barely has a wall — it's mostly a matter of composing it well, plus the time-precision trap already covered in Part 5.6 (compute the time-angle in double, take it modulo, then convert to float). It's just rare; almost nothing does it, and it makes a universe feel ancient and ongoing.

**Wiring.** Extends the orbit/time math (Part 5.6). It's the natural home for Frontier 0's split: *natural* change (stellar aging) is **computed** from time, while *player-caused* change is the only thing in the change-list — the split stays clean. A dying star changes its habitable zone, which deterministically changes its planets' biomes (ties to Frontier 1's equilibria).

### 7.6 Frontier 5 — Players as weather

**The problem/opportunity.** Across thousands of players, the change-list (Part 6.3) quietly becomes a *real history nobody authored.* Feed that *aggregate* back *into* generation as a force the formula reads.

**Our solution.** Trade lanes that physically emerge along the routes people actually fly. Frontier settlements that crystallize where players naturally cluster. The crowd's footprints literally becoming geography.

**Plain-language picture.** The dirt path worn across a grass lawn — nobody designed it; it emerged from thousands of small individual choices about where to walk, and now it's a genuine, visible feature that newcomers follow.

**The hard core, handled.** This one reads *aggregate stored player data* back into generation, so by definition it is **not** a pure function of coordinates — it depends on the Memory layer. That's fine and legitimate (the change-list is already a stored input), but it must live clearly on the **Memory side**, not the pure Generation side, or you'll confuse yourself about what's reproducible. Our approach: periodically **digest** aggregate traffic and clustering into a few high-level "usage facts" per region (this *is* Frontier 0's digestion applied to crowds), then let generation **read** those usage facts as one more cheap, bounded, shared input.

**Wiring.** Consumes the change-list aggregate (Part 6.3); uses Frontier 0's digestion (7.1); outputs facts the lore generator can describe (Part 6.4 — "a busy trade hub on the old Rebel border"). It turns players into one more force of nature inside the formula.

### 7.7 The three traps (permanent yardsticks — what NOT to build)

These look like frontiers but are dead ends. Keep them as a checklist.

1. **"Let the first computer's version become the official one."** It *looks* like it saves work every time you think of it, but it quietly reintroduces save-everything (you must store that version forever, for every visited planet) *and* makes cheating unverifiable (if the first render is truth, a hacked client can mint a loot-stuffed planet and there's no independent correct answer to check against). The tell: any idea that makes the canonical world depend on a specific machine or a specific player's path.
2. **"Just simulate everything for real."** Three fatal problems together: a running simulation doesn't fit a store-nothing, summon-on-demand universe; real simulation gives you *realism*, which is mostly boring (most of reality is flat plains and beige animals); and the cost is ruinous at your scale. You don't need the simulation — you need its *fingerprints* (equilibria + consequences, Frontiers 1 and 0), which are far cheaper.
3. **The granddaddy — "make the change-list computable so we store nothing at all."** The proven wall (7.1): it would mean computing the free choices of people who haven't chosen yet. Any idea that, traced down, requires the formula to *predict the unpredictable* is wearing this mask.

When in doubt, run the one-question filter (7.0).

### 7.8 How the frontiers fit together + the seams-early rule

- The **richest vein** is 7.4 + 7.3 — consistent detail-on-demand is *how* seamless meaning becomes affordable. Build that pair with the most care.
- **Frontier 0** (seed + aftermath + digestion) underpins **Frontier 5** (players-as-weather) and upgrades the whole Memory layer.
- **Frontier 1** (equilibrium) and **Frontier 4** (time) both *produce facts*; **Frontier 3** keeps facts affordable; **Frontier 2** makes facts *agree*; the **lore generator** (Part 6.4) *describes* the facts. They form one pipeline: compute facts → keep them cheap → make them consistent → write them up.
- **All five are LATE features** — none belong in the vertical slice (Part 9). **But the seams go in EARLY:** from day one, generate structured facts deterministically and consistency-aware (coarse→fine, symmetric-from-coordinates), leave clean slots for prose and for reading usage facts, and key every cache by coordinate. Do that and these systems *click in* later instead of forcing a teardown.

---

## PART 8 — Hitting 60fps honestly

60fps = **16.67 ms per frame**. "Disgustingly amazing fidelity" and that budget are in tension; here's how to fit, including where the new "alive" systems put their cost.

### 8.1 A realistic desktop frame budget

| Work | Budget (ms) | Where it runs |
|---|---|---|
| Render pass (geometry, lighting, atmosphere LUT, post) | 6–8 | GPU |
| Player + dynamic physics | 1–2 | CPU (worker or main) |
| Chunk mesh upload to GPU (completed chunks only) | 1–2 | Main thread (must be tiny per frame) |
| Per-frame orbital/spin transform updates | <0.5 | CPU |
| Foliage/rock instancing setup | 1–2 | GPU compute |
| Headroom / spikes | 2–3 | — |

Chunk *generation* (the density field + mesh extraction) is **not** in this budget — it runs asynchronously in WebGPU compute and/or Web Workers and only the *finished* result is uploaded, spread across frames. If generation ever blocks the frame, you've lost.

### 8.2 Streaming is a solved problem — but the catch is the handoffs

Streaming (loading the world just-in-time as you move) is a *known* mountain with a known path: coarse far / sharp near, generate on background workers + GPU, generate slightly ahead of motion, cap work per frame, discard distant chunks. It counts as "solved" because the work splits cleanly and you can throw more compute at it.

**The honest catch:** the slow part is usually *not* the math that builds the terrain — it's **moving the finished terrain onto the GPU** and **handing data between workers and the main thread.** On the web specifically: never *copy* that data between worker and main thread (it chokes) — *transfer ownership* of it; and feed the GPU in *small slices across many frames*, never one big dump. Get those handoffs right and streaming is genuinely a non-issue.

### 8.3 The non-negotiables for the web target

- **Heavy generation off the main thread — on GPU compute, or WASM workers.** Meshing, cosmetic detail, and foliage belong on GPU compute (a core reason to use WebGPU). The *canonical* voxel occupancy and facts, however, must be deterministic across web/native/server (Part 0, Decision 1a): run that on the portable WASM core (Architecture A) and reserve the GPU for visuals — or, only if profiling proves CPU/WASM can't keep up with streaming, move canonical density to **fixed-point** GPU compute (Architecture B). Either way, never on the JS main thread.
- **Nothing heavy on the JS main thread.** Main thread does: orchestrate, update transforms, upload finished buffers, draw. That's it.
- **Instancing for all foliage/rocks/debris** — thousands of objects in one draw call. Aim for well under ~100–200 draw calls per frame; draw calls are the silent 60fps killer on the web.
- **GPU-persistent buffers** — generate terrain/particles into buffers that stay on the GPU and feed straight into rendering (no round-trip to CPU). WebGPU makes this "zero-copy" path possible; use it.
- **Aggressive, throughput-aware LOD** (5.5) — cap chunks-per-frame, generate ahead of motion.

### 8.4 Where the "alive" systems (Part 7) put their cost

The governing principle: **every alive system must be either (a) a cheap one-shot function, (b) computed off the main thread / off the render GPU, or (c) digested periodically and read as a cheap fact. Nothing alive is allowed to run a heavy process inside the frame.**

- **Lore generation (Part 6.4):** deterministic template/grammar in the canonical core — runs locally and instantly when a place is described, no model and no server round-trip, so it's a non-issue for the frame budget. (An *optional later* AI writer would instead run off the render GPU / server-side and be cached.)
- **Equilibrium solves (Frontier 1):** deterministic, computed once per coordinate and cached/re-derivable; run on the generation workers/compute, never per-frame.
- **Detail-on-demand (Frontier 3):** this is a performance *strategy*, not a cost — it exists precisely to keep simulation cheap by only computing the observed level.
- **Time-evolution (Frontier 4):** a few cheap functions of game-time per visible object; negligible, but mind the precision trap (5.6).
- **Players-as-weather (Frontier 5):** digestion runs periodically and server-side; generation just reads a small usage fact.

### 8.5 Memory

Voxel data is heavy. Keep only chunks near the player resident; discard distant ones (you can always regenerate them — they're pure functions). Store player edits as sparse deltas, not full voxel volumes. Watch mobile especially — WebGPU on phones has stricter memory and workgroup limits; treat mobile as a separate, reduced tier or out of scope for v1.

### 8.6 The fidelity ceiling, stated plainly

On the web in 2026 you do **not** get: hardware ray-traced global illumination at scale, Nanite-class virtualized micro-geometry, or unlimited memory. You *do* get: gorgeous PBR materials, real-time scattering atmospheres via LUTs, dense instanced foliage, volumetric planets, and 60fps on good desktop GPUs. Design your art direction to *play to that* (strong stylization, smart use of fog/atmosphere/lighting to sell scale) rather than chasing photoreal detail you can't afford. Stylized-but-cohesive beats photoreal-but-stuttering every time — and it's exactly how NMS itself reads so well.

---

## PART 9 — The critical path / build order

Build around a **vertical slice** — the thinnest end-to-end experience that proves the engine — then expand in concentric rings, each building on a working core. The frontier systems (Part 7) are deliberately late, but their *seams* go into the slice from day one.

### Milestone 0 — THE VERTICAL SLICE (everything hinges on this)

**Definition of done:** You spawn in orbit above a single procedurally-generated planet. You fly down through the atmosphere to the surface with no loading screen and no stutter. You walk on the surface. The planet **visibly rotates** (day/night from real spin) while it **orbits a sun** you can see move. The whole thing holds a **locked 60fps** on a target desktop GPU.

This single milestone exercises: the integer hash/generation layer, the density field, GPU-compute meshing, cube-sphere + quadtree LOD, async streaming with correct worker/GPU handoffs (8.2), the floating-origin frame, the body-fixed frame, the surface↔orbit handoff with velocity inheritance, real orbit + spin transforms, time compression, the atmosphere LUT, triplanar materials, and the frame budget. If this works at 60fps, you have a real engine. If it doesn't, no amount of galaxies or creatures will save the project.

**Acceptance criteria (be strict):**
- Orbit-to-surface descent: zero hitches, frame time stays under 16.67 ms throughout.
- Day/night comes from the planet's actual rotation, not a faked light.
- The sun's position changes over an orbit; a moon (if added) casts a real shadow.
- Launch from the surface inherits planet velocity correctly (planet doesn't rocket away).
- Regenerating the same planet (relog) produces *bit-identical* terrain.

**Seams to bake in even now (cheap, prevents teardowns later):**
- Generate the planet's basic **facts deterministically** from its coordinate (even just a handful), and design every fact coarse→fine and symmetric-from-coordinates (Part 7.3/7.4 discipline), so the Facts layer has a home.
- Key any persistence **by coordinate**, and store **only deltas** (Part 1.4 / 6.3) — even if there's nothing to store yet.
- Leave an empty slot for cached prose and for usage facts.

### Then expand in concentric rings

> **The gameplay grows onto these rings (see the Gameplay & Progression doc).** The rings below are the *world-generation* spine; the *game* — the verbs, the tech tree, ships, survival, civilizations — grows onto them along the loop **explore → understand/reverse-engineer → improve tech → reach further** (tech gates reach). Specifically: **Milestone 0 is now the crash prologue at real scale** (crash → one ship → real-scale Earth→Moon); **ring 1** adds scan/harvest/craft, survival basics, and the **real-data layer** (Constitution II.15 — load real Earth/Moon/Mars, generate detail); the galaxy ring's "FTL between systems" becomes the **earned jump drive**; **civilizations, diplomacy, combat, and theft** attach at the late rings (alongside Life, Living-world, and Game); and **audio** (procedural music + per-archetype soundscapes — a core system, Gameplay doc §10) threads from ring 1 (basic soundscapes) to rich (generative score) throughout. The world-gen rings stay as written; the gameplay is layered on, never instead of.

1. **Planet quality ring (the heart).** Biomes (Whittaker), water, domain-warped caves/overhangs, slope-based materials, weather, landmarks — and crucially the **archetype library + combination rules from Part 2** (this is where you defeat sameness). Basic **equilibrium-computed ecology/climate** (Frontier 1) and **live-small simulation** (creature IK on real terrain, weather) start here. The **real-data layer** and basic **scan/harvest/craft + survival** also start here. This ring is where "one planet, but *great* and not samey" happens, and it builds the library every other planet inherits for free.
2. **Memory ring.** The **change-list** fully built (edit terrain / place structures → store deltas keyed by coordinate → re-apply on revisit). Single-player first. Add **Frontier 0 basics**: seed-and-aftermath for at least one edit type (an explosion that leaves debris that settles). Proves the Memory layer and the living-edits idea cheaply.
3. **System ring.** Multiple planets + moons, nested orbits, basic **time-evolution of the star** (Frontier 4 — the star *has* an age that affects its planets). Basic **facts-with-neighbors** (Frontier 2 — a planet's facts can read its sibling planets' and its star's facts).
4. **Galaxy ring.** Lazy sector-based star generation, spiral arms, FTL between systems (the system↔system handoff), the **discovery system + star map** (Part 6.1). **Seamless meaning across systems** (Frontier 2: relationships computed symmetrically from coordinate pairs) and **detail-on-demand** (Frontier 3) become essential here — a galaxy of systems, each resolved only to the observed depth.
5. **Universe ring.** Multiple galaxies, galaxy types, galactic-core warp. Cheap once the galaxy ring works — the "free scale" payoff.
6. **Lore ring.** Deterministic **template/grammar lore generation** (Part 6.4): facts → readable prose, generated inside the canonical core with no storage and no server call. Built from the lore content pack (vocabulary + templates). Personal journal/log. (*Optional, much later:* a runtime AI writer, only if templates feel thin in playtesting.)
7. **Life ring.** Full creature blueprints + procedural IK, L-system flora, deeper ecosystems (extending Frontier 1).
8. **Multiplayer ring (two distinct systems — Part 6.6).** (a) *Persistence/sharing:* session-overlay, shared discoveries, the Memory ring goes multi-player (shared change-list as an ordered operation log), base persistence, verification/anti-cheat via recompute (Part 6.3). (b) *Real-time presence (the "during"):* a separate low-latency relay + referee that lets co-present players see each other and each other's live edits (send-the-cause/compute-the-aftermath; canonical-vs-cosmetic split; the referee's event order feeds the change-list). Build (a) first; (b) is its own body of work and, because co-presence is rare in a universe this size, can follow.
9. **Living-world ring.** **Players-as-weather** (Frontier 5), full history **digestion** (Frontier 0), the universe reshaping around player behavior.
10. **Game ring (the full suite — Gameplay & Progression doc).** The tech tree (reach + survivability gated by tech), crafting and reverse-engineering, resources and economy, and **civilizations: first contact, diplomacy, combat, theft** (faction facts from Frontier 2 made interactive). This is where the salvaged-alien-tech spine pays off and the universe becomes fully playable.

### The one-way door: freezing the recipe

Schedule, as an explicit milestone between the single-player rings and going live, the moment you **freeze the core recipe** (Part 1.3). Before this point, tune the law of your universe as wildly as you like. After it, the universe is shared and persistent, and *all* new content is added through the Memory layer (stamped on top), never by rewriting the base — or you'll regenerate worlds out from under your players the way NMS did. This is a one-way door; walk through it deliberately, only once the recipe is genuinely good.

### The native version (the committed follow-on track)

The native build (Part 0, Decision 1) is a **later track, not a parallel one** — start it only after the web **vertical slice** has proven the generation core (anything earlier is effort spent on an unproven engine; ideally start after web v1 is real). It **reuses the portable brain wholesale** (the generation logic, the Memory layer, and the deterministic lore generator) and **reimplements only the web-specific shell** (renderer, compute shaders, orchestration) in a native engine — a bounded rewrite, precisely because you separated the two halves from day one (Part 0). Because web and native share **one universe** (Part 0, Decision 1a), three constraints are hard, not optional: (1) the native build must reproduce generation **bit-identically** with web and server — run it against the same **conformance/golden test suite** before it ever touches the live universe; (2) **recipe versions move in lockstep** across web, native, and server — the server gates the canonical version; (3) the **frozen-recipe** one-way door above applies across *all three* at once, the moment any one of them is live.

### What to cut or defer ruthlessly

- **Creatures, multiplayer, economy, factions, and all five frontiers' *full* versions come LATE.** They're where scope-creep kills small teams. None prove the engine; all are large. Don't let the frontiers tempt you into building them before the slice and the planet-quality ring exist.
- **The genuinely-hard research cores are NOT needed for v1** — the universal history digester (7.1), the fully-general transitive seamless-meaning (7.3). Build the *bounded* versions described in Part 7 and move on.
- **Mobile** — separate reduced tier or out of scope for v1.
- **Photoreal fidelity** — replaced by cohesive stylization (8.6).
- **The full superformula/L-system creature pipeline** — a blueprint + bone-scaling system gets ~80% of the creature variety for ~20% of the effort; do that first, add fancy shape math only if needed.

---

## PART 10 — Recommended tech stack (web path, verified 2026 tooling)

| Layer | Choice | Why |
|---|---|---|
| Renderer | Three.js `WebGPURenderer` (r171+) | Production-ready WebGPU, automatic WebGL2 fallback, huge ecosystem, matches your background |
| Shaders | **TSL** (Three Shading Language) | Write once, compiles to WGSL + GLSL; better debugging (JS stack traces, not opaque shader errors) |
| Canonical generation core | One **Rust** library → compiled to **WASM (web client)**, **native (native client)**, **native (server)** | The single source of truth for the shared universe (Part 0, Decision 1a). Integer/fixed-point or controlled software-float; produces facts, orbital elements, and canonical voxel occupancy. Validated by the conformance suite. |
| Visual generation | WebGPU **compute shaders** (via TSL/WGSL) | Meshing, cosmetic sub-voxel detail, foliage, equilibrium *visualization* — the GPU as a renderer/detail accelerator, **not** the canonical source of truth (Part 0, Decision 1a). If profiling forces canonical density onto the GPU, it must be **fixed-point** (Architecture B). |
| Off-thread orchestration | **Web Workers** | Keep the main thread free; pass buffers by *transfer*, not copy (8.2). The canonical core (WASM) runs here too. |
| Physics | Rapier (Rust/WASM) | Fast; run player + dynamic physics in the body-fixed frame |
| Facts layer | Same generation pipeline (workers/compute), integer-hashed | Facts are *computed* deterministically; must be bit-identical across machines for seamless meaning + multiplayer |
| Memory layer + prose cache | Supabase (your existing stack) | Stores `game_time`, player state, change-list deltas (keyed by coordinate), cached prose, and usage facts — tiny by design |
| Lore generation | Deterministic **template/grammar** inside the canonical core | Facts → prose, integer-hash-selected, no storage, identical everywhere, instant. *Optional later:* a server-side AI writer (cached by coordinate, off the render GPU). |
| Networking (later) | Two tiers: durable store (Supabase, above) for the change-list + a **low-latency relay/referee** for real-time presence | The "after" and the "during" are different infra (Part 6.6): the store holds the ordered operation log; the relay smooths co-present players and propagates live edits as *causes*, deciding canonical event order. |
| Language | TypeScript | Strong typing matters a lot in a system this large |

**Integer-hash discipline (restated, because it's load-bearing):** keep *all* canonical generation — hashing, noise, density, and the fact/biome threshold decisions, for terrain *and* facts — in integer/fixed-point math so results are bit-identical across every GPU, CPU, and shader compiler. This is what makes multiplayer determinism, the **shared web+native universe (Part 0, Decision 1a)**, *and* seamless meaning (Part 7.3) actually hold. Guard it with the conformance/golden test suite in CI.

The **native version is the committed follow-on** (Part 0, Decision 1; Part 9), not an alternative — it reuses this same canonical core and shares one universe with the web client. Likely native engines are Godot 4 (double-precision world coordinates, Zylann's Voxel Tools as a starting voxel pipeline) or a custom Rust/Bevy engine; whichever you pick, it consumes the same Rust canonical core and must pass the same conformance suite before joining the live universe.

---

## Quick-reference: every load-bearing rule on one screen

**The mental model (Part 1):**
1. The universe is a *formula*; everything in it *already exists* and is *revealed*, not created — like a multiplication answer that was always true.
2. **The one storage rule:** store what you can't recompute; recompute what you can.
3. Two layers: **Generation** (pure, computed, stored nothing) and **Memory** (the change-list — only what players changed, stored forever).
4. The recipe is the universe's **constitution**: tune it freely *now*; once live and shared, **freeze it** and add only through the Memory layer.

**Engineering core (Parts 3–5):**
5. Doubles give ~nanometer precision only to ~4,500 km, ~2 m at 1 light-year — *not* "sub-nanometer to 1 trillion km." Floats are unusable for world position past a few km.
6. **Real orbits don't break determinism** — generate in the body-fixed frame, treat orbit+spin as `f(game_time)`, persist only game-time + player deltas.
7. **Physics on a planet runs in the body-fixed frame**; inherit planet velocity on launch.
8. All generation runs on **GPU compute**, off the main thread (why WebGPU is mandatory). Streaming's real catch is the *handoffs*: transfer don't copy; feed the GPU in slices.
9. Marching Cubes rounds sharp features — Surface Nets (v1) → Dual Contouring (sharp edges). Integer hashing only for canonical values.

**Content (Part 2):**
10. Sameness is a *content* problem; more randomness makes it *worse* (everything clusters at the average). Hand-build the **rules and a library of bold archetypes**, not finished worlds; load the dice toward the interesting; enforce coherence; scatter memorable landmarks.

**Shared universe (Part 6):**
11. First-come-first-served applies to *names, bases, discoveries* (Memory), not to the planet (which is revealed). Verification (anti-cheat) is free because the true world is recomputable.
12. Lore is generated by **deterministic template/grammar** from the facts — recomputable, no storage, identical everywhere, instant. It *describes* facts, never invents them ("travel writer, not novelist"). Use AI only as an **offline authoring tool** to write the templates; a runtime AI writer is an optional, much-later add-on, not the default.
12a. **Store the cause, not the result; detail is recomputed, not stored.** A note saves the *operation* ("blast here, this big"), not the 50,000 broken voxels — so storage scales with *actions*, not affected terrain, and a rebuilt crater can be arbitrarily detailed and irregular *for free*. Edits are an *ordered log* replayed in order. Edit-effect generation is part of the frozen recipe. Most ephemera (footprints, scorch, dust) are *cosmetic* and stored not at all; heavy reshaping is *digested* into high-level shapes (Frontier 0).
12b. **Persistence ≠ presence (Part 6.6).** The change-list is the durable "after" (security-camera recording); real-time presence is the live "during" (phone call) — a *separate* low-latency system. You can't see a co-present player's action at the exact instant (network latency), but you receive its *cause* and both screens compute the same result; the server referee decides event order, which then feeds the change-list.

**The frontiers (Part 7):**
13. **The one-question filter:** does this need computing something a human hasn't decided yet? Yes → wall. No → frontier.
14. Frontier 0 — store the *seed* of intent, *compute the aftermath*; digest edits into meaning.
15. Frontier 1 — compute the *equilibrium*, don't run the process (cache per coordinate; seed-select among multiple stable states).
16. Frontier 2 — *seamless meaning*: relationships computed *symmetrically from coordinate pairs*, anchored to a shared parent fact (the deepest one).
17. Frontier 3 — *detail-on-demand for simulation*: always generate coarse → fine with coarse as a constraint, so zoom stays honest (solvable by discipline).
18. Frontier 4 — the universe as a function of *time*: stars age and die, all computed, nothing stored.
19. Frontier 5 — *players as weather*: digest aggregate behavior into usage facts that generation reads (lives on the Memory side).
20. The three traps to never build: "first render becomes canon," "just simulate everything," "compute the change-list away."

**Order (Part 9):**
21. Build the **vertical slice** first (one beautiful, rotating, orbiting 60fps planet). Bake in the *seams* (deterministic coordinate-keyed facts, delta-only storage) from day one. Everything else — galaxies, the universe, life, multiplayer, and the full frontiers — is a later ring on a proven core.
22. **Platform: web first, native after — and ONE shared universe across both** (Part 0, Decisions 1 + 1a). Architect the web build as a portable, **headless generation core** + a swappable **rendering shell**, so the native version reuses the brain and only rewrites the shell.
23. **Shared universe ⇒ bit-identical generation** across web, native, and server (Part 0, Decision 1a). It's cheap to operate (nothing is streamed; only the tiny Memory layer syncs) but demands deterministic generation: **integer/fixed-point math** for everything canonical (floats differ across CPUs/GPUs/shader compilers), only cosmetic detail in float, one **Rust core** compiled to WASM + native + server, a **conformance/golden test** in CI, and recipe versions in **lockstep** across all three.
