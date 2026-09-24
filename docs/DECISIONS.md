# Design decisions

Format: date · decision · reason. Deviations from SPEC.md are marked **[deviation]**.

## M0 — Skeleton

- **2026-09-24 · PRNG is sfc32 with one stream per system, seeded by hash(seed, streamName).**
  sfc32 is fast, has 128-bit state that serializes to four ints, and passes PractRand. Named streams mean adding draws in one system never perturbs another, so later milestones don't reshuffle every earlier result by accident. Streams are created lazily and keyed by name, so creation order does not matter.

- **2026-09-24 · Agent ids are indices into the SoA columns and are never reused; the store keeps every agent who ever lived.**
  §12 requires the full pedigree of everyone ever. A few hundred thousand rows of typed arrays is small. `living` is a separate ascending id list. Systems shuffle a copy each sub-step (§0.5).

- **2026-09-24 · SoA uses Float64Array for all continuous fields.**
  Float32 would halve memory, but it adds rounding on every store, which makes the code harder to reason about. Memory is not a constraint at our scale. Can revisit if profiling says so.

- **2026-09-24 · Column schema is a single declarative table (`AGENT_SCHEMA`).**
  Growing, hashing and snapshotting all iterate it, so adding a field can't silently break determinism checks or snapshots.

- **2026-09-24 · Sim purity is enforced three ways:** ESLint rules on `src/sim/**` (no `Math.random`, `Date.now`, `new Date`, DOM/host globals, or imports of three/Node/outer layers), a separate `tsconfig.sim.json` that typechecks `src/sim` with `lib: ES2022` and no DOM/Node types, and a Vitest source scan. The typecheck already caught `structuredClone` (a host API), which is now replaced by a JSON deep clone.

- **2026-09-24 · Determinism scope is "same engine family".**
  `Math.exp/log/cos` are not bit-specified by ECMAScript. Node and Chromium share V8, so results match between headless runs and the browser worker. Firefox or Safari could differ in the last bits. To guarantee cross-engine identity we'd need our own transcendental functions; not worth it now.

- **2026-09-24 · Static terrain is regenerated from (seed, config) on restore, not snapshotted.** Only dynamic fields (plantFood, gameDensity) go into snapshots. Terrain draws from its own `terrain` stream, so it depends only on seed + world config.

- **2026-09-24 · The run identity is (seed, configHash, CODE_VERSION).** `CODE_VERSION` in `src/sim/sim.ts` is bumped manually whenever output changes. The config hash is over key-sorted JSON. Snapshots refuse to load under a different code version.

- **2026-09-24 · Configs are sparse overrides deep-merged onto `configs/default.json`.** Experiment configs only list what they change.

- **2026-09-24 · Observers attach via `events.subscribe` and `sim.onSubStep`.** They are called synchronously and must only read. A test verifies that attaching observers leaves the state hash unchanged.

- **2026-09-24 · Worker sends one message per simulated day, containing all 8 sub-step positions.** The UI interpolates within the day at slow speeds and shows the last frame at fast speeds. Buffers are transferred, not copied.

- **2026-09-24 · Rivers: steepest-descent walks from random high tiles until they reach water or the map edge. Lakes: elevation below `lakeLevel`.** Simplest approach that produces connected water.

- **2026-09-24 · The initial age pyramid is a truncated exponential, `p(age) ∝ exp(-k·age)`.** It's a placeholder. In M1 the pyramid should be replaced by (or checked against) the stable age distribution implied by the calibrated mortality/fertility, otherwise the first decades show a demographic transient.

- **2026-09-24 · M0 movement is a placeholder:** uniform random jitter plus pull toward camp beyond `homeRadius`, with step scaled by 1/movementCost and water blocking. Uniform jitter replaced Gaussian after profiling: Box-Muller was ~45% of runtime. Goal-directed movement with flow fields replaces this in M1.

- **2026-09-24 · The `batch` and `calibrate` scripts exist but exit with a "not implemented" message** until M1 (calibrate) and M7 (batch).

### M0 performance baseline (movement only, headless, this container)

| living agents | sim-years/s |
|---|---|
| 200 | 10.9 |
| 1,000 | 2.2 |
| 2,000 | 1.1 |

Movement alone costs ~190 ns per agent-substep, with 8 substeps per day. Once real systems exist, more work goes into each day, so this has to be watched in M1. The likely levers are fewer RNG draws per move and avoiding per-move Map lookups (cache camp positions per clan).

## M1 — Demography

- **2026-09-24 · The config type is derived from `configs/default.json` (`typeof json`).** Code and config can't drift apart, and every tunable has exactly one home.

- **2026-09-24 · Day structure.** Each morning every independent agent picks one daily activity by utility and softmax (Forage, Hunt, Rest, CareForChild). The 8 sub-steps then carry out that plan: walk the flow-field path out, work, and turn back when the remaining sub-steps only just cover the trip home. In the evening at camp, food is eaten and given (Eat / Give / Take). *Reason:* the spec asks for daily decisions and 8 movement sub-steps. Treating travel time as a cost is what makes camp-area depletion bite. Trip range is capped so that a trip always fits in a day; see the bug note below.

- **2026-09-24 · Dependents.** Infants below weaning age are carried by their mother (she pays a per-step carrying cost, and her hunting success and risk suffer). Children from weaning to 8 stay at camp. Children 8–12 follow a kin adult who is heading out, learn skill from them and forage at 60% efficiency. From 13 they decide as adults but are still provisioned as dependents until 15. *Reason:* §6 child-cost bands. Older children follow a caregiver "seen setting out", so their choice comes after adults decide. That is a perception of the morning's departures, not a scripted plan.

- **2026-09-24 · Evening food allocation is a marginal-value mechanism, not a decision.** Each holder hands out small chunks (0.2 units) to the recipient with the highest `weight × (1 − energy)² × digestibility`. Weights come from the holder's own view: self 1, known kin dependents `childWeight · r · (1 + kinWeight)`, adult kin `adultKinWeight · r · (1 + kinWeight)`, partner `partnerWeight`. This is Hamilton-style allocation with diminishing returns. It uses argmax because it is an allocation rule, not an action choice; §0.5's softmax rule applies to action selection.

- **2026-09-24 · [deviation] Camp store and sharing norm moved from M2 into M1.** After kin allocation, holders give `sharingNorm × (carried − 1 day reserve)` to the camp store. Hungry members present then take from it in shuffled order. The store spoils at 5% a day, as does carried food. *Reason:* without communal sharing, foragers starve next to spoiling surpluses (verified in traces), so forager demography isn't meaningful. The remaining M2 social machinery (Give to a specific person, theft judged by onlookers, relationships) still arrives in M2.

- **2026-09-24 · [deviation] Pair bonds are stored as individual state (`partnerId`).** The spec says labels like "partner" are derivations. But a bond has mechanical effects (mating, provisioning, residence) and is a real state of an individual, like pregnancy. The relationship map (M2) will carry the affinity. The *label* shown in the UI remains derived.

- **2026-09-24 · Pairing in M1 happens within a camp.** An unpaired woman evaluates the unpaired men at her camp: attraction weights health, similar age, cultural similarity and noise, and he must accept her too. Kin with r ≥ 0.125 and co-reared individuals are excluded. Cross-clan courtship needs encounters, which arrive in M2.

- **2026-09-24 · Co-rearing (Westermarck) = shared mother, or shared social father (the mother's partner at birth, `rearerId`).** It's a household-level approximation. Using "same camp during childhood" would forbid almost all within-clan pairing.

- **2026-09-24 · Relatedness is a pure, depth-limited recursion (4 generational steps, i.e. up to first cousins), with no memo.** An earlier version memoized sub-results whose values depended on recursion depth, which would have made results depend on query history and broken snapshot/restore determinism. `exactRelatedness` (full pedigree, per-call memo) exists for tests and analysis.

- **2026-09-24 · Known-kin index.** Each agent has an id-sorted list of relatives with r ≥ 0.1 (up to first cousins), built from pedigree candidates (descendants over 2 generations of self, parents and grandparents). It's updated incrementally at each birth and rebuilt on restore. Lists stay sorted, so the rebuild produces identical iteration order. *Reason:* performance (O(#kin) lookups), and it's also the §11 "kin up to cousins" knowledge set.

- **2026-09-24 · Body condition drives fecundity.** `condition` is a 90-day moving average of energy, and daily conception probability scales with `smoothstep(low, high, condition)`. *Reason:* with daily energy alone, fecundity got no graded signal. People were either fed to their eating target or starving, so population grew until famine. Real forager ovarian function tracks longer-term energy balance (Ellison), and this gives density-dependent fertility through a mechanism.

- **2026-09-24 · People eat to near-full reserves (0.97) when food allows.** With a lower eating target (0.85), condition saturated at the same value for everyone and hid the difference between abundance and scarcity.

- **2026-09-24 · Mortality = Siler model** (Gompertz-Makeham plus the infant term `a1·e^(−b1·age)`, standing in for infant disease) × `exp(robustnessEffect·(0.5 − robustness))`, plus separate hazards from poor health, injury², epidemic infection (age-dependent vulnerability) and being left unattended as a small child. The cause of death is *sampled* in proportion to the competing hazards. Poor-health deaths are labelled starvation, because health only falls through hunger and thirst in this model. *Reason:* the spec names Gompertz-Makeham; the infant term is needed because infant disease isn't otherwise modelled. The Makeham term is set below published all-cause forager fits because starvation, epidemics and accidents are modelled separately on top of it.

- **2026-09-24 · Starvation.** Energy reserves are sized in food-days (adult: 20 days of need) scaled by body size. Unfunded need becomes health loss, faster for small bodies (÷√size). Starvation in childhood permanently lowers `healthCap` (§4). Health recovers only above a minimum energy.

- **2026-09-24 · Epidemics.** An outbreak starts with probability `annualProb/365` per day on a random susceptible agent. Each night, infected agents expose those within `contactRadius` (spatial hash), so spread scales with camp density with no density term in the equation. Recovery gives temporary immunity.

- **2026-09-24 · Drought** is an AR(1) index with a 3-year time constant, multiplying plant regrowth by `exp(−effect·index)`, and game recovery by its square root. Drought begin and end events are logged and cited as causes of starvation deaths during droughts.

- **2026-09-24 · Camp relocation.** Every 30 days each clan compares members' recent yields (influence-weighted; equal weights until M3) to a threshold. If yields are low, it scores candidate sites near water using members' own remembered places (local knowledge) and moves by softmax if a site beats the current one by a margin. Reachability is checked on the current camp's field.

- **2026-09-24 · Bug found in tuning: unreachable destinations.** The turn-back check was stricter than the trip planner, so agents repeatedly set out for remembered patches they could never reach. They never updated those memories and starved at camp. Fixed by using the same rule for planning and turning back, and by having walkers observe the tiles they pass.

- **2026-09-24 · Decision bug found in tuning: rest trap.** Low health raised the "rest" score, so starving agents rested and starved faster. Illness and injury now pull toward rest in proportion to (1 − hunger).

- **2026-09-24 · Utility terms are commensurate.** Expected success for Forage and Hunt is the expected *net* food of the trip (yield minus its energy cost) relative to daily need. A small explicit effort term remains, per the spec formula.
