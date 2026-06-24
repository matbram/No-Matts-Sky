# Procedural Lore Content Pack (v1)

This is the actual vocabulary and templates that turn a place's **facts** into readable, evocative prose — the "travel writer" from Part 6.4 of the master plan, built the right way: **deterministic template/grammar generation, no AI at runtime.**

Because it's a pure function of facts + seed, it lives in the **canonical generation core** (master plan, Part 0 Decision 1a): it runs locally and instantly, produces the *same* text on web, native, and server, and costs nothing to store. Coherence ("never a frozen jungle") is enforced by **fact-gating the vocabulary**. Detail tiers (a one-line star-map blurb vs. a full planet history) are all driven by the same facts, so they never contradict each other (ties to Frontier 3).

It's written to convert directly to a Tracery-style grammar (or any fill-in-the-blanks engine) — see §7. This is v1: each bag has enough entries to read varied today, and §8 covers scaling them up (where the offline-AI-authoring trick earns its keep).

---

## 1. The fact record this consumes (input schema)

The generator never invents anything — it reads a fact record produced by the generation/frontier systems and the Markov name generator. Every field is a fixed, small set of values (an enum) *except* the names, which arrive as strings.

```
PlaceFacts {
  // identity (from the name generator; strings, not generated here)
  planet_name, system_name, region_name, faction_name, discoverer_name

  // planet
  archetype:        frozen_ocean | volcanic | irradiated | lush | desert |
                    fungal | crystalline | oceanic | barren | toxic |
                    gas_shrouded | exotic
  temperature:      frozen | cold | temperate | hot | scorching
  atmosphere:       none | thin | breathable | toxic | corrosive | dense
  terrain:          plateaus | dunes | caverns | fjords | flats | spires |
                    archipelago | canyons | floating_isles | basins
  hazard:           none | radiation | acid_rain | extreme_cold |
                    searing_heat | storms | quakes | toxic_air
  life:             barren | sparse | hardy | teeming | hostile
  landmark:         none | great_arch | glowing_lake | crater_sea |
                    derelict_megastructure | bone_fields | singing_stones |
                    sky_river        // rare; usually 'none'
  resource:         none | rare_metal | exotic_gas | crystal | biomatter | isotopes

  // system / star
  star_class:       red_dwarf | orange | yellow | white | blue |
                    red_giant | white_dwarf | neutron | dead
  star_age:         young | mature | ancient | dying | dead
  planet_count:     integer

  // political (from seamless-meaning, Frontier 2)
  faction_type:     none | empire | republic | syndicate | collective |
                    cult | remnant
  faction_relation: unclaimed | at_war | allied | trade_partners |
                    cold_standoff | contested | isolated

  // history (generated facts, Part 2.5)
  history_event:    untouched | plague | war | stellar_disaster |
                    exodus | the_silence | ascension
  former_state:     uninhabited | colony | outpost | capital | shrine |
                    mining_hub | research_station

  // social / memory layer (players-as-weather + discovery; optional)
  traffic:          untouched | remote | traveled | busy_hub
  discovery_year:   integer | null    // null until first charted
}
```

---

## 2. The deterministic picker (the one rule that makes this reproducible)

To choose one entry from a bag of `n` options, use the integer hash from the canonical core — never a random number:

```
pick(bag, seed, slot_id):
    i = hash_u32(seed, slot_id) mod length(bag)
    return bag[i]
```

- `seed` = the place's canonical seed (its coordinate-derived hash).
- `slot_id` = a stable integer/string unique to that slot in that template (e.g. `"t2.opening"`, `"t2.terrain"`). Stable slot IDs keep each choice independent and identical across runs and platforms.
- This is the same integer-hash discipline the rest of generation uses, so lore is bit-identical on web/native/server for free.

**Weighting (optional):** to make some entries rarer, repeat them in the bag, or store `[entry, weight]` and pick by cumulative weight against `hash_u32(seed, slot_id) mod totalWeight`. Used below to keep `landmark` and dramatic closers rare.

---

## 3. How coherence works (fact-gating)

Templates reference **generic symbols** like `#temp_adj#` or `#sky#`. Before expanding a template, the engine **binds** each generic symbol to the specific bag chosen by the facts. So a template never has to know the world type — it just says `#world_phrase#`, and the binding step points that at the `frozen_ocean` bag when `archetype == frozen_ocean`.

```
bind(facts):
    #world_phrase#  = WORLD_PHRASE[facts.archetype]
    #world_adj#     = WORLD_ADJ[facts.archetype]
    #temp_adj#      = TEMP_ADJ[facts.temperature]
    #terrain#       = TERRAIN[facts.terrain]
    #atmo#          = ATMO[facts.atmosphere]
    #sky#           = SKY[facts.star_class][facts.star_age]   // 2-key lookup
    #hazard#        = HAZARD[facts.hazard]
    #life#          = LIFE[facts.archetype][facts.life]       // archetype-aware for coherence
    #faction#       = FACTION[facts.faction_type][facts.faction_relation]
    #history#       = HISTORY[facts.history_event][facts.former_state]
    #landmark#      = LANDMARK[facts.landmark]
    #resource#      = RESOURCE[facts.resource]
    #traffic#       = TRAFFIC[facts.traffic]
    #closer#        = CLOSER[mood_of(facts)]                  // mood derived below
```

`mood_of(facts)` collapses the facts into a tone for the closing line: `desolate` (dead/abandoned/barren), `hostile` (hazardous/hostile life), `serene` (calm/temperate/lush), `eerie` (the_silence/exotic/derelict), `vital` (teeming/busy_hub), `grand` (capital/ascension/landmark). Pick the first that matches in that priority order.

Because every tier reads the same bound symbols, the star-map blurb and the full planet entry can never disagree.

---

## 4. Vocabulary bags

Notation: each bag is a list; pick one with the rule in §2. `{name}` inside an entry means "drop the name string in here." Entries are written to slot into the templates in §5. v1 gives ~6–10 per bag; scale per §8.

### 4.1 WORLD_PHRASE — the noun phrase for the world type
```
frozen_ocean: ["frozen ammonia ocean", "world of black sea-ice", "frostbound ocean world",
               "drowned world locked in ice", "glacier-sea", "world of cracked ice-plains"]
volcanic:     ["volcanic waste", "world of ash and fire", "smoldering basalt world",
               "lava-veined world", "world of cinder and flame", "restless volcanic world"]
irradiated:   ["irradiated waste", "poisoned world", "world bathed in hard light",
               "radioactive barrens", "scoured world", "world that glows in the dark"]
lush:         ["verdant world", "world of deep jungle", "overgrown world",
               "world choked with green", "fertile world", "riotous living world"]
desert:       ["desert world", "world of endless dunes", "sunbaked world",
               "arid world", "world of red sand", "parched world"]
fungal:       ["fungal world", "world of spores and stalks", "world beneath a canopy of caps",
               "mycelial world", "world of soft rot", "spore-drowned world"]
crystalline:  ["crystalline barrens", "world of glass and facet", "world of growing crystal",
               "shard-world", "world that rings when struck", "prismatic waste"]
oceanic:      ["ocean world", "world of one endless sea", "waterworld",
               "world without shores", "deep-water world", "world of drowned horizons"]
barren:       ["barren rock", "dead world", "airless waste", "world of dust and silence",
               "lifeless world", "world the universe forgot"]
toxic:        ["toxic marsh-world", "world of caustic fog", "poisoned swamp-world",
               "world of acid pools", "bilious world", "world that corrodes"]
gas_shrouded: ["storm-shrouded world", "world wrapped in perpetual cloud", "world of endless tempest",
               "veiled world", "world no one has truly seen", "world beneath a roof of storms"]
exotic:       ["anomalous world", "world that should not be", "glassed and impossible world",
               "world of wrong geometry", "world the instruments distrust", "uncanny world"]
```

### 4.2 WORLD_ADJ — a one-word descriptor for the world type (for compact templates)
```
frozen_ocean:["frozen","ice-locked","frostbound"]   volcanic:["volcanic","ashen","smoldering"]
irradiated:["irradiated","poisoned","scoured"]       lush:["verdant","overgrown","fertile"]
desert:["arid","sunbaked","parched"]                 fungal:["fungal","spore-laden","mycelial"]
crystalline:["crystalline","glassine","faceted"]     oceanic:["oceanic","drowned","tide-locked"]
barren:["barren","dead","lifeless"]                  toxic:["toxic","caustic","bilious"]
gas_shrouded:["storm-wracked","veiled","clouded"]    exotic:["anomalous","uncanny","impossible"]
```

### 4.3 TEMP_ADJ — temperature flavor
```
frozen:    ["bitterly cold","frozen solid","brutally frigid","colder than vacuum seems fair"]
cold:      ["cold","raw and chill","bone-cold","perpetually wintry"]
temperate: ["mild","temperate","gentle in temper","kind by the galaxy's standards"]
hot:       ["hot","sweltering","heavy with heat","oppressively warm"]
scorching: ["scorching","blistering","hot enough to kill","furnace-hot"]
```

### 4.4 TERRAIN — a clause describing the lay of the land
```
plateaus:      ["shattered plateaus step away to every horizon",
                "broken tablelands climb in slow tiers",
                "fractured highlands stand over deep rifts"]
dunes:         ["dunes roll on without end",
                "wind-carved ridges march to the skyline",
                "the sand lies in long combed waves"]
caverns:       ["the surface is pocked with mouths into deep caverns",
                "much of the world is hollow, threaded with caves",
                "sinkholes open onto galleries that go down for kilometers"]
fjords:        ["deep fjords cut inland from frozen coasts",
                "narrow inlets knife between sheer walls",
                "drowned valleys run far into the interior"]
flats:         ["glassy flats stretch level and featureless",
                "the ground lies flat to the curve of the world",
                "a single unbroken plain runs in every direction"]
spires:        ["spires stand in crowded forests of stone",
                "needles of rock rise in their thousands",
                "thin pillars lean at impossible angles"]
archipelago:   ["countless islands freckle a shallow sea",
                "the land is scattered to ten thousand isles",
                "an endless archipelago breaks the water"]
canyons:       ["canyons gash the crust to enormous depth",
                "the land is cut by gorges too wide to bridge",
                "a maze of ravines splits the surface"]
floating_isles:["islands of rock hang unsupported in the air",
                "broken land drifts at altitude, untethered",
                "fragments of the surface float, slowly turning"]
basins:        ["wide basins hold the lowlands",
                "shallow bowls dish out across the surface",
                "the land sinks into great ringed depressions"]
```

### 4.5 ATMO — a clause about the air
```
none:       ["there is no air at all; only hard vacuum and silence",
             "the world holds no atmosphere, and the stars do not twinkle here",
             "nothing breathes here — there is nothing to breathe"]
thin:       ["the air is thin and starved",
             "a meager atmosphere clings close to the ground",
             "the air would not fill a lung"]
breathable: ["the air, against all odds, can be breathed",
             "a thin but breathable atmosphere holds",
             "the air is rare but kind enough to survive"]
toxic:      ["the air is poison, thick with things that should not be inhaled",
             "every breath of the atmosphere is toxic",
             "the air will kill the unsealed in minutes"]
corrosive:  ["the atmosphere eats at metal and flesh alike",
             "corrosive vapors hang in the air, etching everything they touch",
             "the very air corrodes whatever it settles on"]
dense:      ["the atmosphere lies dense and crushing",
             "the air is heavy enough to lean on",
             "a thick, pressing atmosphere swallows sound"]
```

### 4.6 SKY — sun/sky appearance, keyed by [star_class][star_age]
Bind by both keys. v1 gives a representative spread; fill the grid as you extend.
```
red_dwarf / mature:  ["beneath a small, sullen red sun",
                      "under a dim ember of a star",
                      "lit by a red dwarf that gives more color than warmth"]
red_dwarf / dying:   ["under a red dwarf guttering toward its end",
                      "beneath a failing red sun",
                      "lit by a star running out of fire"]
yellow / mature:     ["under a familiar yellow sun",
                      "beneath a warm, steady star",
                      "lit by a sun that could almost be home"]
blue / young:        ["under a fierce blue-white sun",
                      "beneath a young star too bright to face",
                      "scoured by the light of a blue giant"]
red_giant / dying:   ["beneath a swollen red sun that fills half the sky",
                      "under a dying giant, bloated and slow",
                      "lit by a star in its final, enormous age"]
white_dwarf / dead:  ["under the cold pinprick of a dead star's cinder",
                      "beneath a white dwarf, all its warmth long spent",
                      "lit only by the faint ghost of a sun that died"]
neutron / dead:      ["under the knife-thin light of a neutron star",
                      "beneath a dead star that still spins and screams in radio",
                      "lit by something that was a sun, once, and is now a wound in space"]
dead / dead:         ["under no sun at all — only the dark and the far stars",
                      "in the permanent night of a starless system",
                      "beneath a sky the sun abandoned"]
// default for any unfilled [class][age]:
default:             ["under an indifferent sun","beneath a distant star","lit by a pale sun"]
```

### 4.7 HAZARD — a clause about what will hurt you (or that nothing will)
```
none:         ["nothing here seems eager to kill you, which is its own kind of strange",
               "the world is, remarkably, calm",
               "no great hazard stalks the surface"]
radiation:    ["radiation storms sweep the surface without warning",
               "the ground itself is hot with radiation",
               "hard light pours down and lingers in the dust"]
acid_rain:    ["acid rain falls in slow, certain ruin",
               "caustic rain streaks down whenever the clouds gather",
               "the rain here dissolves what it lands on"]
extreme_cold: ["the cold alone will kill in the open",
               "exposure means death in minutes",
               "the temperature drops past anything flesh can bear"]
searing_heat: ["the heat sears anything left in the sun",
               "the surface burns hot enough to ignite the unwary",
               "by day the ground itself can kill"]
storms:       ["storms of terrifying scale wander the world",
               "the wind comes hard enough to flatten standing things",
               "tempests cross the surface like slow, vast animals"]
quakes:       ["the ground shudders and splits without warning",
               "quakes rearrange the land on a whim",
               "nothing built here stays standing for long"]
toxic_air:    ["the air is the hazard — a slow, certain poison",
               "to breathe unsealed is to die unhurried",
               "the atmosphere itself is the thing that kills"]
```

### 4.7b LANDMARK — a clause for a rare signature feature (usually skipped)
```
none:                  [""]   // most worlds; template omits the slot when empty
great_arch:            ["A single stone arch spans the horizon, wide enough to fly a ship through.",
                        "One vast natural arch stands over the landscape, older than anything around it."]
glowing_lake:          ["A lake of slow, luminous liquid glows from within, painting the clouds above.",
                        "One shining lake burns a soft impossible color, day and night."]
crater_sea:            ["A single crater so wide it holds a sea marks where something terrible once struck.",
                        "An impact basin large enough to drown a country dominates one hemisphere."]
derelict_megastructure:["The bones of an enormous derelict structure ring the world, silent and unexplained.",
                        "Something vast and artificial girdles the planet, abandoned long ago."]
bone_fields:           ["Fields of titanic pale bones lie half-buried across the plains.",
                        "The skeletons of impossibly large creatures litter one whole region."]
singing_stones:        ["Standing stones across the surface ring faintly in the wind, in something like a chord.",
                        "Whole fields of stone hum when the wind crosses them, almost musically."]
sky_river:             ["A river of glowing dust arcs across the daytime sky, never falling.",
                        "A ribbon of light crosses the heavens here, source unknown."]
```

### 4.8 LIFE — a clause about flora/fauna, keyed by [archetype][life] (archetype-aware for coherence)
v1 gives the common combinations; default covers the rest.
```
lush / teeming:      ["life riots in every direction — canopy, undergrowth, and the things that move between",
                      "the world is thick with life, loud and green and endless"]
lush / hostile:      ["the jungle is alive in the worst sense; much of it would prefer you dead",
                      "the green here hunts"]
frozen_ocean / sparse:["a few hardy things cling on beneath the ice",
                      "life is scarce here, and what survives does so quietly"]
desert / hardy:      ["only the stubborn survive — deep-rooted, water-hoarding, patient",
                      "life here is lean, armored, and rare"]
barren / barren:     ["nothing lives here, and likely nothing ever has",
                      "the world is sterile, top to bottom"]
fungal / teeming:    ["fungal life covers everything, soft and pale and everywhere",
                      "the world is one slow living mat of spore and stalk"]
toxic / hostile:     ["what lives in the marsh is as poisonous as the marsh itself",
                      "the life here has made a weapon of the world's poison"]
volcanic / sparse:   ["a little life endures at the cooler margins",
                      "almost nothing survives the heat, but almost is not nothing"]
// default:
default:             ["life here is unremarkable but present","what lives here keeps to itself",
                      "the world holds life, of a modest kind"]
// 'barren' life value for any archetype:
barren_any:          ["nothing stirs but dust","the world is empty of life","silence and stone, and nothing more"]
```

### 4.9 FACTION — a clause about who holds the place, keyed by [faction_type][faction_relation]
`{f}` = faction_name. Bind by both keys; default covers gaps.
```
none / unclaimed:        ["No power claims this place.","It belongs to no one.","Beyond every border, claimed by nothing."]
empire / at_war:         ["Held by the {f}, and bled for — this is a front line of their war.",
                          "The {f} rule here at gunpoint; the war is close."]
empire / allied:         ["Firmly within the {f}, and quiet behind their alliances.",
                          "The {f} hold this place, secure among friends."]
empire / contested:      ["The {f} claim it, but their grip slips; others claim it too.",
                          "Nominally the {f}'s — though the claim is disputed and thin."]
republic / trade_partners:["Governed by the {f}, grown fat on open trade routes.",
                          "The {f} keep this place, and keep it prosperous on commerce."]
republic / cold_standoff: ["The {f} hold it under an uneasy peace with a rival they do not trust.",
                          "A {f} world, watched warily across a border that does not shoot — yet."]
syndicate / isolated:    ["The {f} run it, far from anyone who might object.",
                          "This is {f} ground, and the {f} answer to no one out here."]
cult / contested:        ["The {f} have taken root here, to the alarm of their neighbors.",
                          "The {f} hold this place, and others would dearly like to take it back."]
remnant / unclaimed:     ["Only scattered remnants of the {f} remain, holding nothing in particular.",
                          "What's left of the {f} lingers here, a claim no one enforces."]
collective / allied:     ["The {f} share this world among themselves, openly and without lords.",
                          "Held in common by the {f}, and defended in common."]
// default:
default:                 ["Claimed, loosely, by the {f}.","Within the reach of the {f}.","The {f} call it theirs."]
```

### 4.10 HISTORY — a clause about the world's past, keyed by [history_event][former_state]
Used mainly in the Tier-3 history paragraph. `{p}` = planet_name. Bind by both keys; default covers gaps.
```
untouched / uninhabited: ["Nothing has ever happened here. No one has ever come. {p} has only ever been itself.",
                          "{p} carries no history at all — no ruins, no graves, no record of any hand."]
plague / colony:         ["{p} was a colony once, until a sickness moved through it faster than help could.",
                          "A colony grew here and then died, all at once, of something the records only call 'the fever.'"]
war / capital:           ["{p} was the seat of something — a capital, proud and central — until a war unmade it.",
                          "This was a capital world, once. The war that ended it also ended whoever started it."]
stellar_disaster / mining_hub:["{p} was a mining hub until its star turned on it; what the flare didn't kill, it scattered.",
                          "They came here to dig, and stayed until the sun nearly killed them and the rest fled."]
exodus / outpost:        ["An outpost stood here and then simply left — packed up and gone, reasons unrecorded.",
                          "Whoever manned this outpost chose, at some point, to leave and never return."]
the_silence / research_station:["A research station operated here until, one day, it stopped answering. No wreck, no bodies — only silence.",
                          "Something was being studied here. Then every signal ceased at once, and nothing has explained it since."]
the_silence / capital:   ["{p} was a thriving capital, until everyone on it went quiet in a single season, and stayed quiet.",
                          "A whole capital fell silent here — not destroyed, simply emptied, with no sign of how or why."]
ascension / shrine:      ["{p} held a shrine, and those who tended it believed they left this world for a better state of being. The shrine stands empty, by their own design.",
                          "A faith rose here and then, they claim, transcended — leaving the shrine deliberately, joyfully abandoned."]
ascension / capital:     ["Legend says the people of {p} did not die but *ascended*, leaving their great cities intact and unattended.",
                          "{p}'s cities stand whole and empty; their builders, the story goes, simply moved beyond needing them."]
// default:
default:                 ["{p} has a past, though only fragments of it survive.",
                          "Something happened on {p}, long ago, and was not written down."]
```

### 4.11 RESOURCE — a clause about what's worth taking
```
none:       [""]   // omit slot
rare_metal: ["Veins of rare metal run close to the surface — reason enough for some to risk it.",
             "The crust is rich in rare metals, if you can survive long enough to take them."]
exotic_gas: ["The atmosphere holds exotic gases worth more than the world that makes them.",
             "Rare gases can be drawn from the air here, for those equipped to do it."]
crystal:    ["The ground grows crystals of unusual value.",
             "Harvestable crystal is everywhere, for the patient."]
biomatter:  ["The living matter here has uses far from home.",
             "Its biomatter is prized off-world, for medicine and worse."]
isotopes:   ["Rare isotopes lace the soil — valuable, and as dangerous as they sound.",
             "The world is salted with valuable isotopes, and the radiation that comes with them."]
```

### 4.12 TRAFFIC — a clause about how visited the place is (memory layer)
```
untouched: ["No one has set foot here before you.","You are, as far as anyone knows, the first.","Yours are the first eyes to see it."]
remote:    ["Few ever come this far out.","Visitors are rare and far between.","It sees almost no traffic."]
traveled:  ["Ships pass through often enough.","It lies on a route others know.","You are far from the first to chart it."]
busy_hub:  ["This is a crossroads — ships come and go constantly.","Traffic is heavy; it's a hub for the whole region.","The place is busy, by the standards of empty space."]
```

### 4.13 CLOSER — a final line, keyed by mood (see §3)
```
desolate: ["It is a quiet place, and an empty one.","There is a stillness here that outlasts everyone who comes.","Nothing waits here but the world itself."]
hostile:  ["It would not mourn you.","Come prepared, or do not come.","The world has no patience for the careless."]
serene:   ["It is, against the odds, a gentle place.","One could almost stay.","There are worse places to be lost."]
eerie:    ["Something about it does not sit right.","It feels watched, though nothing watches.","The quiet here has a texture to it."]
vital:    ["The place hums with motion and intent.","It is alive, in every sense.","There is always something happening here."]
grand:    ["Whatever it was, it was not small.","It carries the weight of its own history.","You feel, standing here, that it mattered once."]
```

---

## 5. Templates by tier

Each tier is a list of skeletons; pick one with §2 (`slot_id = "tN.template"`), then fill its `#symbols#` (each its own `slot_id`). `[opt: #x#]` means "include only if that fact isn't the empty/none value." Higher tiers reuse the same bound symbols as lower tiers, so they stay consistent.

### Tier 0 — star-map blurb (one line; shown from far away)
```
T0:
  "A #world_adj# world #sky#."
  "#world_phrase#, #temp_adj#, [opt-faction: #faction_short#]."
  "A #temp_adj# #world_phrase#."
  "#world_phrase# — [opt-traffic: #traffic_short#]."
```
`#faction_short#` / `#traffic_short#` are one-clause reductions (e.g. "on a contested border", "barely charted"). For v1 you can derive these from the first clause of the full FACTION/TRAFFIC bags.

### Tier 1 — system summary (1–2 sentences; on approach / scan)
```
T1:
  "The #region_name# system: #planet_count_phrase# #sky#. #faction#"
  "#system_name#, #sky#, holds #planet_count_phrase#. #faction#"
  "A #star_phrase# and #planet_count_phrase#. #faction#"
```
`#planet_count_phrase#` = small helper: 0→"no worlds", 1→"a single world", 2–3→"a handful of worlds", 4+→"#planet_count# worlds". `#star_phrase#` = `#sky#` reworded as a noun ("a sullen red dwarf"); for v1 reuse SKY.

### Tier 2 — planet entry (a short paragraph; on arrival / scan)
```
T2:
  "#planet_name# is a #temp_adj# #world_phrase#, #sky#. #terrain#, and #atmo#. #hazard#. [opt: #landmark#] #life#. #faction# [opt: #resource#] #closer#"

  "#sky_capitalized#, #planet_name# is a #world_phrase#. #terrain_capitalized#. The world is #temp_adj#, and #atmo#. #hazard#. #life#. [opt: #landmark#] #faction# #closer#"

  "#planet_name#: a #world_phrase# where #terrain#. #atmo_capitalized#, and #hazard#. #life#. #faction# [opt: #resource#] [opt: #traffic#] #closer#"
```
(Capitalize the first word of a clause when it starts a sentence — a trivial post-step.)

### Tier 3 — planet history / lore (a paragraph; on deeper discovery)
```
T3:
  "#history# #history_consequence# #closer#"

  "#planet_name# was not always as you find it. #history# #history_consequence#"

  "#history# #faction_now# #closer#"
```
- `#history#` ← HISTORY bag (§4.10).
- `#history_consequence#` = a short follow-on bag keyed loosely by `history_event`, e.g.
  ```
  plague:           ["What the sickness left, the world has since reclaimed.","Their settlements stand, emptied and orderly, as if everyone simply stepped out."]
  the_silence:      ["No transmission has come from here since, and no explanation with it.","Whatever happened left no wreckage to question — only the absence."]
  stellar_disaster: ["The scars of that day are still written across the surface.","The land has not healed, and perhaps cannot."]
  ascension:        ["Pilgrims still come, now and then, hoping to follow.","What they became, if anything, no one living can say."]
  war:              ["The ruins are picked over now; the war's cause is long forgotten.","Only the craters remember which side held which ground."]
  exodus:           ["Where they went, no record says.","They left in good order — which only deepens the mystery of why."]
  untouched:        ["It waits, exactly as it has always waited.","Its whole history is still ahead of it."]
  ```
- `#faction_now#` = a present-day political line; reuse FACTION (§4.9).

### Discovery stamp (memory-layer overlay; appended once the place is charted)
Not generated from the recipe — these are filled from the **Memory layer** (the change-list), so they're the one lore element that's *stored*, not recomputed. Kept template-style for tone consistency.
```
DISCOVERY:
  "First charted by {discoverer_name} in the year {discovery_year}."
  "Discovery logged to {discoverer_name}, {discovery_year}."
  "{discoverer_name} was here first — {discovery_year} — and left a name behind."
```

---

## 6. Worked examples

Each shows a fact record and one deterministic output. (Different seeds pick different bag entries; the facts stay fixed, so the *meaning* is stable while the *wording* varies.)

### Example A — a dead, abandoned ocean world on a contested border
Facts: `archetype=frozen_ocean, temperature=frozen, atmosphere=thin, terrain=fjords, hazard=extreme_cold, life=sparse, landmark=derelict_megastructure, resource=isotopes, star_class=red_dwarf, star_age=dying, planet_count=3, faction_type=remnant, faction_relation=contested, history_event=the_silence, former_state=research_station, traffic=remote, planet_name="Kethrin Vos"`

**Tier 0:** "A frostbound world under a red dwarf guttering toward its end."

**Tier 2:** "Kethrin Vos is a bitterly cold frozen ammonia ocean, under a red dwarf guttering toward its end. Deep fjords cut inland from frozen coasts, and the air is thin and starved. The cold alone will kill in the open. Something vast and artificial girdles the planet, abandoned long ago. A few hardy things cling on beneath the ice. What's left of the Verge lingers here, a claim no one enforces. Rare isotopes lace the soil — valuable, and as dangerous as they sound. It is a quiet place, and an empty one."

**Tier 3:** "A research station operated here until, one day, it stopped answering. No wreck, no bodies — only silence. No transmission has come from here since, and no explanation with it. Something about it does not sit right."

### Example B — a thriving jungle world, capital of an empire at war
Facts: `archetype=lush, temperature=temperate, atmosphere=breathable, terrain=basins, hazard=storms, life=teeming, landmark=none, resource=biomatter, star_class=yellow, star_age=mature, planet_count=6, faction_type=empire, faction_relation=at_war, history_event=war, former_state=capital, traffic=busy_hub, planet_name="Aurelia Prime"`

**Tier 0:** "A verdant world under a familiar yellow sun."

**Tier 2:** "Under a familiar yellow sun, Aurelia Prime is a verdant world. Wide basins hold the lowlands. The world is mild, and the air, against all odds, can be breathed. Storms of terrifying scale wander the world. Life riots in every direction — canopy, undergrowth, and the things that move between. Held by the Solar Concord, and bled for — this is a front line of their war. The place hums with motion and intent."

**Tier 3:** "Aurelia Prime was the seat of something — a capital, proud and central — until a war unmade it. Only the craters remember which side held which ground."

### Example C — a barren rock no one has ever visited
Facts: `archetype=barren, temperature=cold, atmosphere=none, terrain=flats, hazard=none, life=barren, landmark=none, resource=rare_metal, star_class=white_dwarf, star_age=dead, planet_count=1, faction_type=none, faction_relation=unclaimed, history_event=untouched, former_state=uninhabited, traffic=untouched, planet_name="UDC-7741"`

**Tier 0:** "A dead world under a white dwarf, all its warmth long spent."

**Tier 2:** "UDC-7741 is a cold barren rock, beneath a white dwarf, all its warmth long spent. Glassy flats stretch level and featureless, and there is no air at all; only hard vacuum and silence. The world is, remarkably, calm. Nothing stirs but dust. No power claims this place. Veins of rare metal run close to the surface — reason enough for some to risk it. There is a stillness here that outlasts everyone who comes."

**Tier 3:** "UDC-7741 carries no history at all — no ruins, no graves, no record of any hand. It waits, exactly as it has always waited."

**Discovery stamp** (after you chart it): "First charted by you in the year 2247."

These read as written by a person, vary widely by seed, never contradict the facts, and never produce an incoherent world — and every word of it is recomputable from the facts, so none of it is stored.

---

## 7. How to encode it (drops into the canonical core)

It maps one-to-one onto a **Tracery-style grammar** with two changes: (1) swap Tracery's random picker for the deterministic `pick()` in §2, and (2) run the §3 binding step to set fact-gated symbols before expansion. A bag and template look like this as data:

```json
{
  "WORLD_PHRASE": {
    "frozen_ocean": ["frozen ammonia ocean", "world of black sea-ice", "frostbound ocean world"],
    "volcanic":     ["volcanic waste", "world of ash and fire", "smoldering basalt world"]
  },
  "TEMP_ADJ": {
    "frozen": ["bitterly cold", "frozen solid", "brutally frigid"],
    "hot":    ["hot", "sweltering", "heavy with heat"]
  },
  "templates": {
    "T2": [
      "#planet_name# is a #temp_adj# #world_phrase#, #sky#. #terrain#, and #atmo#. #hazard#. #life#. #faction# #closer#"
    ]
  }
}
```

Generation flow, per place:
1. Compute `PlaceFacts` (the generation/frontier systems already do this).
2. `bind(facts)` → point each generic symbol at its fact-gated bag (§3).
3. Pick a template for the tier: `pick(templates[tier], seed, "tier.template")`.
4. Expand it, resolving each `#symbol#` with `pick(boundBag, seed, slotId)`; drop `[opt: …]` slots whose fact is the empty/none value.
5. Capitalize sentence starts; join. Append the Discovery stamp from the Memory layer if charted.

Because steps 1–4 are pure integer math over the facts + seed, the text is **identical on web, native, and server**, satisfies Part 0 Decision 1a for free, and never needs storing.

---

## 8. Scaling this up (and where offline-AI authoring helps)

v1 is deliberately lean. To make it read fresh over hundreds of hours:

- **Grow each bag to ~20–40 entries.** Variety is multiplicative: a Tier-2 paragraph with ~8 filled slots and 20 options each already yields astronomically many distinct readings. This is exactly the "deck of cards" point from Part 2 — strong, distinct pieces recombined.
- **Fill the two-key grids** (SKY `[class][age]`, LIFE `[archetype][life]`, FACTION `[type][relation]`, HISTORY `[event][former_state]`) — v1 ships representative cells plus a `default`; completeness raises coherence.
- **Add archetypes** as you add world-kinds to the generator (Part 2's library); each new archetype needs its own WORLD_PHRASE / WORLD_ADJ / LIFE cells and any archetype-flavored hazards.
- **Use AI as an offline authoring tool** (master plan, Part 6.4): have an AI draft large additional batches of vocabulary and templates *at development time*, you curate them for tone and coherence, and you ship the result to run **deterministically with no AI in the live game.** That captures most of an AI's variety benefit with none of the runtime cost — and it's the right job for an AI here.
- **Keep coherence guarded:** every new entry must be safe for *every* fact combination its bag is bound to. When in doubt, gate it more narrowly (give it its own fact key) rather than letting a wrong-tone line leak into the wrong world.
- **Tone consistency:** decide a house voice (these samples lean "terse, slightly melancholy explorer's log") and write to it, so the bags blend regardless of which entries the seed picks.
