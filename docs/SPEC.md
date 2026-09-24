# Build Prompt: "Terrarium" Artificial Civilization Simulation

You are building an agent-based artificial civilization simulation: a small world of simple animated humans organized into clans, where social structure, leadership, conflict and culture EMERGE from individual rules rather than being scripted. It must be both a reproducible research instrument and genuinely fun to watch.

Before writing code, save this entire prompt to `docs/SPEC.md` in the repo. It is the source of truth. Log every design decision or deviation you make in `docs/DECISIONS.md` (date, decision, reason).

---

## 0. Non-negotiable principles

1. **Primitives, not plots.** Agents perform primitive verbs. Named stories (assassination, coup, alliance, feud, founding) are labels applied afterwards by the historian. Never implement them as actions.
2. **Individuals are real; clans are derived.** Clan leader, territory, culture and inter-clan relations are computed from individual state. A clan only stores: id, name, founding record, camp position, food store, history.
3. **No circular causation.** Never write an experiment's outcome variable as a direct function of its input (e.g. never `violenceProb = f(hunger)`). Effects must flow through mechanisms (hunger leads to contested food, contests can escalate).
4. **Everything costs something**: energy, time, risk or reputation.
5. **Stochastic but reproducible.** Seeded PRNG only (no `Math.random`, no `Date.now` in the sim). Same `(seed, config, codeVersion)` must produce identical history. Softmax choice, never argmax. Shuffle agent processing order every tick.
6. **Local knowledge.** Agents act only on what they perceived or were told.
7. **Headless first.** The sim core has zero dependency on rendering, DOM or LLMs. The renderer is just an observer.
8. **Calibrate before interpreting.** Demography must be stable before any emergent result counts.
9. **Everything significant is logged with its causes** (causal event graph).
10. **Legibility.** Any agent must be able to explain "what am I doing and why" (top utility terms).

**Priority rule when research rigor and watchability conflict:** rigor wins inside the sim core. The renderer may do anything visual (interpolation, choreography, effects) as long as it never mutates or influences sim state.

**Do NOT use an LLM anywhere in the simulation loop.**

---

## 1. Tech stack

- TypeScript (strict), Vite, vanilla Three.js (no React, minimal dependencies, prefer custom-built UI).
- Sim core runs in a Web Worker in the browser AND in Node (via `tsx`) for headless batch runs. Same code.
- Vitest for tests.
- Output: JSONL event log + yearly JSON snapshots, analyzable from Python/notebooks later.
- npm scripts:
  - `npm run dev` : browser app (renderer + UI)
  - `npm run sim -- --seed 1 --years 300 --config configs/default.json --out runs/` : headless run
  - `npm run batch -- --seeds 1..50 --years 300` : parallel headless runs (worker_threads)
  - `npm run calibrate` : demography calibration report
  - `npm test`

## 2. Repo structure

```
docs/            SPEC.md, DECISIONS.md, CALIBRATION.md
configs/         default.json (ALL tunable parameters live here, versioned)
src/sim/         pure deterministic core (no DOM imports, lint-enforced)
  rng.ts         seeded PRNG (e.g. sfc32/xoshiro), one stream per system
  state/         struct-of-arrays agent store (typed arrays), sparse relationship maps, pedigree
  world/         terrain generation, resources, climate
  systems/       one file per system (see §5 order)
  history/       event bus, event log, analyzers, snapshots
  names.ts       procedural syllable name generator (per-clan syllable sets)
src/worker/      web worker wrapper, render-buffer transfer
src/render/      Three.js scene, instanced humans, terrain, camera, LOD
src/ui/          custom panels: inspector, clan panel, timeline, event ticker, time controls
src/cli/         headless run, batch, calibrate
tests/
```

---

## 3. World model

- Terrain grid ~96x96. Biomes: grassland, forest, hills, dry scrub, water (rivers + lakes), generated from seeded noise. Tile fields: movementCost, plantFood, plantCapacity, regrowthRate, gameDensity, waterAccess.
- **Plants:** low variance, low yield, logistic seasonal regrowth.
- **Game:** high variance, large yield, success improves with group hunting, small injury risk, slow depletion/recovery. (This variance is the engine of cooperation; do not flatten it.)
- **Water:** agents must reach water within a few tiles daily; camps sit near water.
- **Camps:** one per clan, communal food store that spoils (~5%/day). Clan relocates camp when local depletion is high.
- **Graves:** marker at each death location.
- **Climate:** annual seasonal sinusoid + slow multi-year drought process (AR(1)) + random epidemics (spread scales with camp density).
- **Time:** 1 tick = 1 day, 365 days = 1 year. Each day has 8 movement sub-steps.

## 4. Agent model

**Identity:** id, name, sex, birthTick, motherId, fatherId, clanId, alive.

**Body:** energy 0..1, health 0..1, injury 0..1, strength (derived: age curve x build x health), female reproductive state (cycling | pregnant(dueTick) | lactating(untilTick)), carriedFood.

**Genome (heritable, continuous 0..1):** build, robustness, fertility, boldness, sociability, temper. Plus cosmetic genes (skin tone, height, hair color) with ZERO behavioral effect. No intelligence trait. Phenotype = gene + developmental noise; childhood famine permanently lowers health.

**Skill:** foragingSkill 0..1, grows with practice and teaching by elders.

**Culture (learned, per agent):**
| Trait | Governs |
|---|---|
| sharingNorm | fraction of surplus given; anger at observed non-sharers |
| violenceTolerance | escalation threshold |
| legitimacyWeights {strength, generosity, lineage, age} (sum 1) | how this agent grants deference |
| residenceRule | after pairing: who changes clan (male / female / either) |
| revengeScope | killer only / killer's kin / killer's clan |
| outgroupTrust | treatment of strangers and join requests |
| kinWeight | baseline affinity boost for kin |
| ancestorNaming | probability of naming a child after an ancestor |
| marker | NEUTRAL discrete body-paint pattern id; no fitness effect; drifts |

**Moods (fast decay):** fear, anger (+ targetId), grief.

**Memory:** relationship map (cap 60), known places (cap ~30, last-seen quality + timestamp), salient event ring buffer (20).

**Goal:** current goal + commitment timer. Status is derived (deference received), never stored.

## 5. Systems and decision logic

**Daily system order:** Climate, Resources, Metabolism, Perception, Decision, [x8 sub-steps: Movement, Encounters, Interaction resolution], Reproduction, Mortality, Social/Gossip (staggered across agents), Culture (staggered), Clan (loyalty daily-lazy, fission yearly), Leadership (derive), Historian.

**Primitive actions (the complete V1 set):**
Forage, Hunt (solo or join group), Eat, Rest, Give (person or camp store), Take (store or person; it counts as theft when onlookers' norms judge it so), Socialize, Court, Mate, CareForChild, Threaten, Attack, Flee, ChangeClan (leave / request join / split per §7). Move is implicit.

**Decision (utility AI):**
```
score = needUrgency (non-linear curves) x personality weight x cultural modifier
        x expectedSuccess (from memory) - energyCost - risk x (1 - boldness) + moodBias
choice = softmax(scores / temperature_i)
```
- Multi-day goals (migrate, court, avenge, join hunt) persist with hysteresis unless an emergency threshold is crossed.
- Decide simultaneously, resolve in shuffled order.
- Encounters: pairwise within perception radius (~4 tiles) per sub-step. Contested food uses hawk-dove style payoffs so aggression's value is frequency-dependent.
- Store the top 3 utility terms per agent for the inspector ("why").

## 6. Reproduction and inheritance

- Fertile windows: females ~16-45, males ~16-60.
- Courtship requires mutual affinity above threshold; attraction weights health, received deference, cultural similarity, noise.
- Incest avoidance: no pairing with known kin r >= 0.125, or anyone co-reared in childhood (Westermarck).
- Daily conception prob = fertility x energy factor (famine suppresses) x not lactating. Gestation 270 days. Maternal birth risk rises with low health. Lactation suppresses fertility ~2-3 years.
- Child cost: 0-3 nursed/carried (follows mother, energy cost to her); 4-12 needs provisioning from any caregiver, weighted by relatedness x affinity; 13-15 partially self-sufficient, learns skill with adults.
- **Genes:** midparent + segregation noise + small mutation.
- **Culture:** copied from caregivers ~age 5 with noise, then updated through life (see §10).
- **Social inheritance:** at maturity, children inherit a fraction of parents' strongest affinities and grudges.
- **Clan:** the clan of the camp the child lives in (governed by parents' residenceRule).
- **Names:** from clan syllable set; ancestorNaming may reuse an ancestor's name.

## 7. Relationships and clans

**Relationship entry:** affinity -1..1, deference 0..1, grudge 0..1, familiarity 0..1, lastSeen. Kinship is NEVER stored; compute relatedness from the pedigree on demand. Labels (friend, rival, enemy, ally, partner) are display-only derivations. Decay is lazy (computed from lastSeen on access). Evict lowest familiarity when over cap.

**Update rules:** socialize (+affinity, +familiarity); received food (+affinity, more if hungry; +deference to generous givers); stolen from / attacked (-affinity, +grudge, +fear); witnessed violence against kin (+grudge toward attacker, scaled by r x affinity to victim); lost contest (+deference to winner, weaker for witnesses); gossip (shift toward speaker's view x trust).

**Clan-to-clan relation:** derived yearly (mean member-to-member affinity, influence-weighted), cached for historian and visuals.

**Clan identity:** monotonically increasing numeric id, never reused, plus procedural name. Display as `Clan 6 · Veshari`. Initial world: 4 clans x ~50 agents with a realistic age pyramid, spatially separated camps, NON-identical but randomly seeded cultures.

**Territory:** derived from members' foraging heatmap over last 180 days. Overlay only.

**Loyalty (derived):** sum of affinity to members + kin in clan x kinWeight + deference to leadership + food satisfaction - internal grudges.

**Leave/join:** leave when loyalty < best alternative (clan with partner/kin/friends). Host accepts with probability from members' affinity to applicant, host food per capita, applicant reputation (gossip-based), host outgroupTrust.

**Expulsion:** member's mean clan affinity strongly negative AND top deference holders hostile. Expelled agents become loners.

**Fission (only way new clans are born):** yearly, per clan. Trigger: size high relative to local carrying capacity AND strong community structure in the internal affinity graph (label propagation, modularity above threshold). Condition: subgroup has >= 6 adults incl. >= 2 fertile females and >= 2 males, and a focal member with substantial in-subgroup deference. Subgroup picks a new camp from known good places away from parent. Gets next clan id; parent/child clan link recorded.

**Dissolution:** no merge mechanic. Members leave individually; at zero members the historian records dissolution and where members went.

## 8. Leadership

Leadership = concentrated deference. Deference is granted by each observer according to THEIR legitimacyWeights: contest wins (strength), generosity, kinship to previously deferred-to people (lineage), age/skill.

- Derived leader: member with largest share of clan deference if share > ~25%; otherwise leaderless/distributed (decisions by deference-weighted vote of top members).
- Leadership effects: (1) deference-weighted vote on camp moves/migration; (2) members side with those they defer to in disputes; (3) leader's opinions spread via gossip with extra weight; (4) prestige bias in cultural copying; (5) soft priority on camp store.
- Challenges: bold agent with low deference to leader and allied support may Threaten the leader; witnesses join by affinity; outcome shifts witness deference.
- Succession: leader's incoming deference redistributes per each member's weights (lineage-heavy cultures pass to kin, strength-heavy to contest winners, age-heavy to elders).
- Regime type is a historian LABEL computed from metrics (deference Gini, tenure, kin-succession share). Never a stored enum.

## 9. Conflict

Escalation ladder with exit at every step: ignore, Threaten, Attack (injury likely, death rare), lethal intent (death likely); Flee/back down anytime. Escalation prob from anger, temper, strength asymmetry, nearby allies, violenceTolerance, stakes. Ambush (target alone + grudge) raises lethality.

Clan-level escalation without warfare: killing creates grudges in victim's kin (r x affinity) and in clanmates who witness/hear; revengeScope sets targets; feud cycles emerge; exits via death, distance, cross-feud marriage, and gifts reducing grudge. Allies nearby may join ongoing fights. No planned raids, no armies.

## 10. Culture transmission

Vertical (caregivers), oblique (move toward higher-prestige partners during Socialize), conformity (toward local majority), success bias (toward well-fed, many-offspring agents), innovation (small mutation). Migrants and marry-ins carry culture. Norm enforcement: high-sharingNorm agents who observe non-sharing get angry (threat, -affinity, gossip). Clan culture = mean of members; divergence tracked yearly.

Religion/superstition: NOT in V1. But tag every event with location and nearby markers now, for a V1.5 association-learning module.

## 11. Information and gossip

Agents know: kin (up to cousins), their relationship map, visited places (fading, stale), witnessed events, heard events, camps of encountered clans. During Socialize, speaker shares 1-2 most salient memories (killing > theft > generosity > other); listener updates weighted by trust; fidelity drops per hop; hop limit 3; small attribution-noise chance of naming a similar wrong person (false accusations emerge; no lie action). Reputation is local, never global.

## 12. Death and history

- Mortality: Gompertz-Makeham baseline x robustness, plus starvation (via health), injury, epidemic, childbirth, hunting accidents, violence.
- Death record: who, when, where, age, cause, killer, contributing factors, surviving kin, clan, status. Grave placed.
- **Event log:** append-only, typed, each event has `causes: eventId[]`. Micro events in rolling buffer + yearly aggregates; macro events permanent. Full pedigree of everyone ever. Full-state snapshot yearly (supports scrubbing and resuming).
- **Analyzers (yearly):** alliance (mutual clan affinity above threshold 2+ years + intermarriage), feud, famine, regime type, fission, dissolution, population overtakes, "firsts". Significance = rarity x affected count x status.
- Provide a `whyQuery(eventId)` that walks the causal graph backwards and returns a chain. (The LLM narrator is V1.5 and out of scope now.)
- Chronicle lines format: `Year 17: Clan 3's leader Oru died at age 64 (starvation during drought).`

## 13. Visualization

- Tilted orthographic "terrarium" camera; low-poly vertex-colored terrain; stylized animated water; trees; camps with fires/tents.
- Humans: procedural segmented humanoids (head, torso, 4 limb capsules), GPU-instanced, sine-driven gait/gesture animation in vertex shader. No skeletal rigs.
- Encoding: clan = clothing color + camp banner; cultural marker = face/body paint pattern (culture spread must be visible); sex = silhouette (shoulder/hip ratio, build); age = scale, elders hunched with grey hair; leader = headdress sized by deference share; pregnant belly, injured limp, starving pallor, infants carried; optional mood icons.
- Choreography: morning departures, foraging/hunting parties, evening return, night gathering around fires. Interactions face each other with gestures (offer, lunge, run).
- Terrain memory: worn footpaths from traffic heatmap, accumulating graves, abandoned fire rings, seasonal tint, drought yellowing.
- Camera: click agent to follow + thought bubble (goal + top reasons); clan view (territory tint, relation lines); world view (LOD billboards, migration streams).
- Time controls: pause, 1x (1 day ~15s), 10x, 100x, max. Above ~50x switch to chronicle mode (crowd flow, population stream graph, event ticker).
- UI panels (custom-built): person inspector (bio, family tree, relationship web), clan panel, scrubbable timeline, event ticker.
- Renderer interpolates between sub-step positions; it must never write to sim state.

## 14. Performance

Target 200-2,000 living agents. Spatial hash grid; decisions daily; cached flow fields to camps/water instead of per-agent A*; staggered gossip/culture; lazy relationship decay; yearly community detection; instancing (one draw call per body part), LOD, no off-screen animation. Do NOT create a separate cheaper "abstract" sim mode. Profile and report sim-years/second headless at 200, 1,000 and 2,000 agents.

---

## 15. Milestones (strictly in order; do not start the next until acceptance passes)

**M0: Skeleton.** Repo, config system, seeded RNG, SoA state, event bus, headless CLI, a minimal 2D canvas debug view (top-down dots on terrain). Accept: determinism test (same seed = identical state hash at day 3650, run twice) passes.

**M1: Demography.** World + resources + climate, metabolism, forage/eat/rest, reproduction, child cost, mortality, pedigree. Build `npm run calibrate` that runs 20 seeds x 300 years and reports vs targets:
- population neither extinct nor > 4x start in >= 80% of seeds
- total fertility ~4-6 births per woman
- ~40-60% of births survive to 15
- modal adult age at death ~60-75
- mean interbirth interval ~3-4 years
Tune `configs/default.json` to hit targets; document in `docs/CALIBRATION.md`.
**STOP after M1 and report results to me before continuing.**

**M2: Social fabric.** Relationships, Socialize, Give/Take, hunting groups, camp store with spoilage, kinship queries, clans, loyalty, leave/join, expulsion, fission, dissolution, clan naming. Accept: across 20 seeds x 300 years at least one fission occurs in most runs, clan count neither collapses to 1 nor exceeds ~15 in most runs.

**M3: Power and conflict.** Deference, derived leadership, challenges, succession, escalation ladder, grudges, revenge scope, feuds. Accept: violence is neither zero nor runaway (report violent deaths as % of all deaths per seed); leader tenure distribution is non-degenerate.

**M4: Culture and information.** Cultural traits + transmission + norm enforcement, gossip with fidelity loss and attribution noise, place memory. Accept: measurable between-clan divergence in marker and functional traits over 300 years; knockout switch (cultural learning off) runs and produces a comparison report.

**M5: The terrarium.** Three.js renderer, instanced humans, visual encodings, choreography, terrain memory, camera modes, time controls, inspector/clan/timeline/ticker panels. Accept: 1,000 agents at 60fps on a laptop at world zoom; follow-cam works; switching speeds never changes sim results (verify state hash with and without renderer).
**STOP after M5 and show me (screenshots/GIF) before continuing.**

**M6: Historian.** Analyzers, significance scoring, chronicle generation, `whyQuery`, yearly snapshots with timeline scrubbing, JSONL export. Accept: for a 300-year run, the chronicle answers "who founded Clan N", "why did Clan N dissolve", "how did leader X gain power" via causal chains.

**M7: Experiment harness.** `npm run batch` with parameter sweeps and a summary report (CSV) for these experiments:
1. Scarcity vs violence (carrying capacity, drought frequency)
2. Food variance vs sharing norm (plant/game mix at constant mean)
3. Regime emergence from random legitimacy weights (+ lineage knockout)
4. Isolation vs cultural divergence (mountain barrier vs open map)
5. Residence rule vs cross-clan affinity and killings
6. Revenge scope vs feud length and extinctions
7. Emergent group-size attractors and fission rhythm
8. Kin vs clan loyalty when they conflict
9. Marker innovation survival vs originator prestige
10. Contingency: 200 seeds, same config; which outcomes are robust

---

## 16. Out of scope (do not build, even if tempting)

LLMs in the sim loop; warfare/raids/armies/planned group action; tools, crafting, fire, agriculture, buildings; trade, currency, possessions; language evolution; religion/superstition; deliberate lying; diplomacy UI or alliance objects; detailed disease; intelligence trait; god powers/player intervention (exogenous shocks only via config schedules); skeletal rigs; weather sim; big maps; multiplayer; save-game UI; mobile.

## 17. Working rules

- Keep the sim core pure and lint-enforced against DOM/renderer imports.
- Every parameter goes in config, never magic numbers in systems.
- Write tests for each system's invariants (no negative food, pedigree consistency, relatedness math, determinism).
- If the spec is ambiguous or a mechanic produces degenerate behavior, choose the simplest option consistent with §0, log it in DECISIONS.md, and flag it in your milestone report. Never "fix" degeneracy by scripting outcomes.
- Commit at the end of each milestone with a summary of what was built, what was tuned, and open issues.

**First action:** save this prompt to `docs/SPEC.md`, propose your M0 file plan in a few lines, then build M0.
