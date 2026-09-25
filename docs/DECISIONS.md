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

- **2026-09-24 · M1 calibration closes with 4/5 targets.** The interbirth interval (4.05 years) is marginally above target, for the trade-off documented in CALIBRATION.md. Per §17 I did not force it by scripting outcomes. Demography is recalibrated after M2/M3, which change food flow and mortality.
- **2026-09-24 · Calibration pools modal age and interbirth interval across seeds.** A per-seed mode is fragile (bimodal famine seeds), and the pooled statistic is what a demographer would compute from the combined sample. Per-seed values stay in the report.

## M2 — Social fabric

- **2026-09-24 · Relationship maps are pooled typed arrays per living-agent slot** (cap 60): affinity, deference, grudge, familiarity, lastSeen. Values are stored as of lastSeen, and decay is applied on read from the elapsed days, using exact precomputed `(1−rate)^dt` tables. The entry with the lowest familiarity is evicted when full. Kinship is never stored: "felt affinity" = stored affinity + `kinAffinityBoost × kinWeight × r`, computed on read.
- **2026-09-24 · Where ties come from:** (a) nightly contacts at the camp fire, mostly with people one already likes or knows well (softmax over own relationship map; 20% random); (b) the Socialize daily goal, with more and warmer contacts, including courtship bias for singles; (c) field encounters between people working near each other, of any clan, which is how cross-clan ties form; (d) gifts; (e) shared hunting success. Affinity gains shrink as a tie approaches its maximum.
- **2026-09-24 · Found in testing: without preferential contact, everyone came to like everyone.** Affinity saturated, clans had no community structure, and fission never fired. Choosing contacts by existing affinity is the standard homophily/"rich get richer" mechanism, and it produced family/friendship clusters. Fission community detection runs on each person's *relative* preferences (felt affinity minus their average tie).
- **2026-09-24 · Hunting parties.** Hunters see who else is setting out to hunt and may join a clanmate's party by softmax over expected share: group success with synergy, somewhat bigger game, split n ways, plus liking of the leader. Joiners walk with the leader, who rolls once for the group. Kills are shared equally, and success bonds the party. Synergy is kept modest (0.1 per member, +15% carcass size per member): initial values made group hunting so productive the population exploded, while the ethnographic benefit is mostly variance reduction.
- **2026-09-24 · Give / Take.** Holders give to kin, partner and up to 8 closest friends (affinity > 0.2), with friends weighted by the holder's sharing norm. Recipients warm to givers (more if hungry) and defer to generosity by their own generosity weight. Store deposits are seen by a few onlookers. Taking from the store is judged: an able adult whose taking greatly exceeds their giving angers onlookers in proportion to the onlooker's sharing norm, which is logged as `food.freeriding`. This is "theft when onlookers' norms judge it so".
- **2026-09-24 · Clan membership (ChangeClan).** Each adult checks monthly on their own staggered day, comparing loyalty (affinity to members + kin × kinWeight + partner + deference to leadership + food satisfaction − grudges) with the best alternative clan they know people in. If clearly better, they ask to join. The host accepts with a probability from members' own view of the applicant (affinity and grudges, i.e. local reputation), host outgroupTrust and host food per capita. A partner in the same clan must also prefer the move, and then comes along. Very low loyalty means leaving to live alone (loner). Dependent children move with their mother (or father if the mother is gone).
- **2026-09-24 · Residence rule** on a cross-clan pairing: if both partners' rules agree (or one says "either"), that rule decides who moves. If they disagree, or both say "either", the partner with lower loyalty moves.
- **2026-09-24 · Expulsion** (yearly): members' mean affinity minus grudge toward someone is below −0.3 (with at least 3 opinions), *and* each of the top-3 status holders is hostile. Before deference exists (M3), the eldest adults stand in for the top-status holders.
- **2026-09-24 · Fission** (yearly per clan): requires size ≥ 30 and ≥ 0.9 × local capacity (sustainable plant yield within day-trip range ÷ need), label-propagation modularity ≥ 0.25, and a community not containing the top-status member with ≥ 6 adults, ≥ 2 fertile women, ≥ 2 men, and a focal member holding ≥ 15% of in-group regard. The group settles at the best place near water its members remember, ≥ 12 tiles away and reachable. Partners come along. The store splits by headcount. The daughter clan keeps 6 of the parent's name syllables.
- **2026-09-24 · Clan-to-clan relation** is derived yearly (influence-weighted mean member affinity) into `sim.clanRelations`, a cache for the historian and visuals that isn't part of state.

- **2026-09-25 · A clan's value counts one's closest ties, not every tie** (`clans.valueTopTies` = 6). Summing affinity over all members made a big parent clan worth more simply for being big. In the 300-year seed-2 history, 7 of 14 fission offshoots dissolved back into the parent within a year, and the parent then re-split: an artifact loop. Now only the strongest 6 positive ties in a clan count, the close circle one actually lives among. Every negative tie and grudge still counts, and kin are summed as before. After the change, no offshoot dissolved within 3 years across 4 seeds × 150 years. The loop's extra fissions also disappear: seed 2 has 3 fissions in 150 years instead of 14.

## M3 — Power and conflict

- **2026-09-24 · Deference sources**, each weighted by the *observer's* legitimacy weights: contests (loser and witnesses, strength), gifts and seen deposits (generosity), lineage (monthly, deference flows to adult children of those one defers to), age/skill (monthly, toward older, more skilled acquaintances).
- **2026-09-24 · Deference is attention, a limited budget.** Monthly, each person's total deference is capped at 1 and sharpened toward whoever they already defer to most (`def^2`, renormalized). Adults also shift 30% of their budget toward whom their five closest clanmate friends defer to (social proof). *Reason:* without these, many small sources spread deference thinly (top share 2–11%) and leaders never emerged. With them, some clans develop clear leaders and others stay egalitarian, depending on culture. This models how prestige concentrates; it does not script who leads.
- **2026-09-24 · Only adults' deference counts toward clan leadership shares.** Children's deference to the parents who feed them made every parent a minor leader.
- **2026-09-24 · The derived leader has a stability rule.** An incumbent keeps the label while holding > 0.8 × the threshold share, unless someone else exceeds them by 20%. Status and leaders are derived weekly, not daily (performance; the label changes slowly anyway). The status cache is therefore part of the snapshot, so restore stays exact.
- **2026-09-24 · The leader is never stored.** It lives in a derived map rebuilt from `leader.changed` records in clan histories on restore. Tenures are computed from those records.
- **2026-09-24 · Escalation ladder.** One `confront(a, b, context)` function covers contested food, resisting theft, revenge on sight, leadership challenges and norm enforcement. At each level (threaten, attack, lethal intent) each side escalates with a logistic probability of temper, hostility, violenceTolerance, stakes, log power ratio (strength × (1 + allies)), boldness and fear, minus a level cost. Either side can back down. Allies within 3 tiles join by affinity + deference − grudge + kinWeight × r. An ambush (revenge with no allies near the target) raises power and lethality.
- **2026-09-24 · Bugs found in testing: runaway feuds inside one clan.** (1) The "killer's clan" and "killer's kin" revenge scopes could point back at the avenger's own clan and kin; expanded scopes now exclude them. (2) Merely losing a stand-off created grudges; only attacks, thefts and killings do now. (3) There was no cooldown; now one confrontation per person per day. (4) Vengeance taken halves the avenger's grudge. After these fixes, violence is sporadic, with occasional clusters.
- **2026-09-24 · Feud exits:** death, distance (no encounters), gifts reduce the recipient's grudge, and friendly contact slowly eases grudges. Cross-feud marriage works through courtship raising affinity.
- **2026-09-24 · Seek revenge (multi-day goal).** Someone with a strong grudge and a target outside their clan within day-trip range may spend the day lurking a few tiles from the target's camp. Revenge on sight then happens through field encounters. There are no raids or groups: it's one person's goal.
- **2026-09-24 · Succession.** When anyone with deference dies, each member's deference to them (× 0.8) is redistributed by *that member's* weights: lineage to the deceased's adult kin (∝ r), strength to the top contest winners and the strongest, age to elders, generosity to the most generous.
- **2026-09-24 · Leadership effects implemented:** deference-weighted voice in camp moves (influence = 1 + 4 × status share); allies side with those they defer to; leaders' gossip carries extra trust (M4); prestige bias in cultural copying (M4); a soft priority at the camp store.

## M4 — Culture and information

- **2026-09-24 · Transmission.** Vertical: at age 5, a blend of mother (0.6) and social father, with noise. Oblique: during Socialize, toward higher-prestige partners (status share + a little age). Conformity: monthly, toward a sample of clanmates, with conformist bias (∝ frequency²) on categorical traits. Success bias: toward a sampled clanmate with better condition and more surviving children. Innovation: small noise, and rare new marker patterns (64 possible). The knockout (`culture.learning = false`) freezes culture at birth, a copy of the mother's.
- **2026-09-24 · Norm enforcement.** When a holder gives the store less than an onlooker's own sharing norm minus 0.2, that onlooker's affinity toward them drops, anger rises, and they remember and gossip it as refusing to share. Sometimes the onlooker threatens them (context `norm`).
- **2026-09-24 · Gossip.** Each agent has a 20-entry salient-event memory holding type, subject, object, source event, tick, hops and fidelity. Witnessed first-hand: attacks, killings, thefts, big gifts when hungry, non-sharing. Speakers share their 1–2 most salient memories (killing > attack > theft > non-sharing > generosity, discounted by fidelity and a 1-year half-life) during night contacts and Socialize. Listeners weight by trust (affinity to the speaker, plus the speaker's status share for leaders). Fidelity × 0.7 per hop, at most 3 hops. With 5% probability a similar person (same sex and clan, known to the listener) is named instead, so false accusations emerge without any lie action. Hearing that someone killed one's kin creates a grudge. Speakers also pass on their best foraging place, degraded. Older second-hand place knowledge never overwrites fresher first-hand knowledge.
- **2026-09-24 · Divergence metrics (yearly).** Functional: the share of trait variance lying between clans, averaged over 9 continuous traits (an F_ST analogue). Marker: 1 − mean pairwise overlap of clan marker distributions.
- **2026-09-24 · Events carry the markers of the agents involved** (`markers`), for the V1.5 association-learning module (§10). "Nearby markers" is approximated by participants' markers; scanning the area around every event would be expensive.

- **2026-09-25 · Caveat on the M4 divergence result.** Clans start with distinct cultures (`init.cultureClanSd` 0.18), so between-clan functional F_ST is high from year 0 (about 0.9 to 0.97). The acceptance criterion ("measurable divergence at year 300": 19/20 PASS) mostly shows that differences are maintained, not created. Learning keeps them higher than the knockout: end F_ST is 0.934 with learning and 0.825 without. Marker divergence ends at 0.757 versus 0.694. The effect is modest. To test whether divergence *emerges*, start with `cultureClanSd: 0` (experiment 04 supports this override).

## M5 — The terrarium

- **2026-09-25 · Architecture.** The sim runs in a Web Worker (with a main-thread fallback if workers are blocked). Each simulated day the worker posts every living agent's position at all 8 sub-steps, per-agent render attributes, the day's notable events, new graves, abandoned camps, clan views and yearly stats. Buffers are transferred, not copied. The UI only sends requests (speed, inspect, scrub).
- **2026-09-25 · Humans are GPU-instanced segmented bodies:** legs, torso, arms, head, plus a leader headdress, one draw call per part. Gait and gestures are sine-driven in the vertex shader; there are no rigs. Encodings: clan = tunic and leggings color and camp banner; marker = body-paint pattern on chest, arms and face (64 styles × colors cycle over the marker id); sex = shoulder/hip silhouette; age = scale, hunch and greying hair; pregnancy = belly; injury = limp; starvation = pallor; leader = golden headdress sized by deference share; infants ride on their mother's back.
- **2026-09-25 · Choreography is renderer-only:** interpolation between sub-steps, headings from motion (or facing the fire at camp), sitting at the fire at dusk at slow speeds, lunges and flinches for threats and attacks, offering gestures for pairings and shared kills.
- **2026-09-25 · Terrain memory is accumulated by the renderer from what it observes:** worn footpaths (traffic heat), territory (per-clan presence heat, about 180-day memory), graves, abandoned fire rings. Also season tint and drought yellowing. The spec defines territory as an overlay only, so it lives in the observer, not in sim state.
- **2026-09-25 · Level of detail:** below camera zoom 1.6, or in chronicle mode (above about 50×), people become point sprites in one draw call. Clan view shows a territory tint and camp-to-camp relation lines (derived clan affinity).
- **2026-09-25 · Timeline scrubbing.** The worker keeps a snapshot every 10 years (yearly would cost gigabytes in the browser) and scrubs by restoring the nearest earlier snapshot and fast-forwarding deterministically. A test verifies that scrub-and-replay reproduces the same state hash.
- **2026-09-25 · Renderer invariance** is verified by test: a run driven through the worker host, with render buffers, event capture, inspector queries and snapshots, gives the same state hash as a headless run. Speed only changes how many whole days are stepped per wall-clock second, never what a day computes.
- **2026-09-25 · Performance measurement caveat.** This container only has a software rasterizer (SwiftShader), so GPU frame rates can't be measured here. Measured: main-thread JavaScript per frame at 1,000 agents is about 2–3 ms, under a 16.7 ms frame budget, on a loaded 4-core CPU. At world zoom, people are one point-sprite draw call.

- **2026-09-25 · Migration streams.** The worker forwards `camp_moved` and `joined_clan` day events with from/to positions. The view draws a brief arc between them that fades over 8 s of wall time, so relocations and clan switches read as flows. This is purely observational: the renderer receives copies and never writes sim state.

## M6 — Historian

- **2026-09-25 · Named stories are labels over primitive events,** emitted yearly as `history.*` events whose causes point at the justifying primitives: alliance (mutual clan affinity > 0.05 for 2+ years plus an intermarriage), feud (≥3 killings between two clans in 10 years with killings in both directions; "blood feud" if within one clan), famine, regime type, overtake, and "firsts". Fission and dissolution are primitive events.
- **2026-09-25 · Regime type is a label from metrics:** deference Gini, whether there is a derived leader, and kin-succession share. It has hysteresis: a new label must hold 3 consecutive years before it's recorded.
- **2026-09-25 · Causal links added for questions the historian must answer.** `leader.changed` cites the last challenge in the clan, the predecessor's death, and the new leader's most recent won contest, and records the "basis": what the leader's supporters mostly value, as a deference-weighted mean of their legitimacy weights. `clan.dissolved` cites the last departures and deaths of its members and records where members went. `clan.founded` cites the fission.
- **2026-09-25 · Significance** = rarity (per event type) × log₂(2 + people affected) × status (for deaths: 1 + 10 × status share, ×3 if violent). The chronicle shows the most significant events in time order.
- **2026-09-25 · A leader who leaves a clan stops being its leader immediately** (logged). Found by the historian test: the derived label lagged membership by up to a week.
- **2026-09-25 · Leader tenures merge reigns split by a leaderless gap of ≤ 1 year.** The derived label can still wobble around the threshold in small clans.

- **2026-09-25 · People are told apart by name ordinals.** Children are often named after ancestors, so names recur. A history read "Zaan died (killed by Zaan)" and one "Thaalsenkra" died four times. `Agents.displayName` adds a regnal-style ordinal (Zaan, Zaan II, ...) in id order. It is derived from `names`, so it is not state and does not enter the hash. All user-facing text uses it: historian, inspector, CLI.
- **2026-09-25 · Chronicle wording.** A "first" names its event, e.g. "the first killing: Laas died at age 61 (violence, killed by Gin)". A dissolution says how many members died in the clan's last 20 years besides where members went. Articles agree ("an egalitarian band").

## M7 — Experiment harness

- **2026-09-25 · Experiments are JSON files** (`configs/experiments/*.json`): question, default seeds and years, metrics, and variants as sparse config overrides. `npm run batch` runs variants × seeds on the worker pool and writes `runs.csv` (one row per run, including config hash) and `summary.md` (mean ± 95% CI per variant). The contingency experiment adds a robustness table: coefficient of variation across seeds.
- **2026-09-25 · Experimental manipulations are config-only.** Initial culture overrides (residence rule, revenge scope, lineage weight = 0 for the knockout, which also blocks lineage from re-entering through learning and turns off lineage deference drift), barrier terrain, resource and climate parameters, cultural-learning parameters. No experiment is implemented as special-case code.
- **2026-09-25 · Outcome metrics are computed after the fact** from the event log, stats and pedigree (`Simulation.acceptanceMetrics`), never read by systems. That keeps §0.3: no outcome variable feeds back into its own inputs.
- **2026-09-25 · Marker patterns expanded to 1,024 ids** so innovations are traceable: few collisions, so "survived" means the pattern itself persisted.
- **2026-09-25 · Pilot sizes.** Full experiments (50 seeds × 300 years × variants; 200 seeds for contingency) take many CPU-hours at the current ~2 s per sim-year for ~250 agents. The harness supports them. The reports committed here come from pilot runs with fewer seeds and years, and say so.

## Performance (§14)

- **2026-09-25 · `npm run perf` holds density constant.** Packing 1,000 or 2,000 people onto the 96² map crashed the populations to 661 and 277 within the warmup year, so the timed windows measured famines. The benchmark now scales the map side with √(target/200) and the clan count linearly, keeping 50 people per clan. Result: about 29 µs per agent-day, linear from 200 to 2,000 agents (docs/PERFORMANCE.md).
- **2026-09-25 · No further micro-optimisation for now.** The CPU profile is flat: GC takes 8% and no function takes more than about 5% of self time. There is no single hotspot to remove, and batch throughput comes from the per-seed worker pool instead.

## Play mode (after M7, at the user's request)

- **2026-09-25 · The player is an ordinary agent** with a clan of their own (`src/sim/play/player.ts`). They act only through existing primitives:
  - gifts (`onGift`) and relationship updates;
  - the clan-membership move (`moveClan`) and the shared clan valuation (`clanValue`);
  - killings (`killAgent` + `onKilling`).

  The world therefore reacts with its own mechanisms: grudges from a raid feed real feuds, and a recruit's partner weighs following them with the usual rule.
- **2026-09-25 · Determinism is kept by logging resolved actions.** The UI moves the avatar client-side (responsive) and sends positions and actions. The host resolves each action against the frame the player was looking at (proximity, witnesses) and applies it between days. The resolved action, witnesses included, is logged with its tick, so `(seed, config, action log)` replays exactly (`replay()`, tested). The same log is the unit a multiplayer version would exchange.
- **2026-09-25 · Exemptions for the player agent:** decisions, metabolism, mortality, pairing, clan switching, expulsion, fission of their clan, derived leadership (the player leads their clan) and direct fights. These are game-design choices kept explicit in the code with guards. Research runs have no player, so their behaviour is unchanged, though CODE_VERSION was bumped to m8.0.
- **2026-09-25 · Getting caught (user's rule: "lose five clan members").** Courting a clan's people raises that clan's suspicion by verb weight × witnesses:
  - the leader counts ×3; friends of the player count ×0.3;
  - witness weight saturates, so a camp full of eyes is dangerous but not instant doom;
  - a loyal refuser may report an invite, and every defection is noticed.

  At the threshold the clan strikes at night. Its leader kills up to 5 of the player's people, adults first; with no people to take, they beat the player instead. These are real killings with grudges. Suspicion fades about 2% per day.
- **2026-09-25 · Invite odds use the everyone-uses clan valuation plus the target's regard for the player** (affinity ×6, deference ×4, grudge −2). In the world, own-clan loyalty runs 6–14 (kin ties dominate), so without the regard term no one would ever leave. With it, per the balance check, befriending the least-attached person takes about 10 days to reach 70%, and a median person 30–40 days. Recruiting whole families cascades naturally: kin already with you pull the rest.
- **2026-09-25 · Raids** (5+ grown fighters, 20-day cooldown) resolve at night. Win probability is A²/(A²+D²) with a 1.25 home bonus. A win takes 60% of the target's store. Both sides lose people (real killings), and the target clan turns openly hostile.
- **2026-09-25 · Play mode streams the day** (after player feedback that people rush home before you can reach them). `Simulation.step()` is now `beginDay()` + 8 × `subStep(s)` + `endDay()`; research runs are unchanged, since the same RNG streams are drawn in the same order. In play mode the host advances one slot at a time: 8 sub-steps, then the night. A day lasts 30 s at 1×. The player acts in the present, and actions are logged with (tick, sub-step), so replay stays exact (tested).
- **2026-09-25 · Calling out.** A person the player calls within earshot (8 tiles) stops moving for 3 sub-steps (4 if they like you), unless they hate the player. This is a real sim state (`heldUntil`) that movement respects. Talking or helping keeps them one more sub-step. Being held has a cost to them: they may miss the evening's sharing at camp.
- **2026-09-25 · Drifters.** 8 clanless adults (a couple among them) are added when the player arrives. In play mode loners are nomadic: every 4 days they move their fireside 6–14 tiles, away from camps (`nomadSystem`, off in research runs). They are the people you meet in the open, and with no clan ties they are the natural first recruits.
- **2026-09-25 · Animals are game density made visible** (`sim/play/animals.ts`, pure and shared by sim and renderer).
  - A tile holds a herd with probability ∝ its current density.
  - The kind (hare, deer, boar, aurochs) comes from the biome and a tile hash.
  - Killing one depletes that tile's density, so what you see is what you can hunt, and it thins where you hunt.
  - Hunting uses a player skill. Success is logistic in (skill − the kind's requirement). Harder game teaches more; boar and aurochs can wound you.
  - Early on only hares are realistic (enough to feed yourself); aurochs (28 food) are for sharing.
- **2026-09-25 · The player gets hungry** (eats 1 unit each night from hand, or from the camp store if home; hunger slows walking and hunting). Gathering and woodcutting also grow skills. Wood carried home builds shelters (10 each, max 6); each adds +0.5 to invite odds ("shelters at your camp").
