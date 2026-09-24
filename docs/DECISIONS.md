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
