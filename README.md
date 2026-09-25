# Terrarium

An agent-based artificial civilization. Small bands of simple humans forage, share, pair, raise children, quarrel, follow leaders, split into new clans, spread body paint and gossip. Social structure, leadership, conflict and culture **emerge from individual rules**: named stories like feuds, alliances and dynasties are labels the historian applies afterwards.

- Spec (source of truth): [`docs/SPEC.md`](docs/SPEC.md)
- Every design decision and deviation: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Demography calibration: [`docs/CALIBRATION.md`](docs/CALIBRATION.md)

It's deterministic: the same `(seed, config, code version)` always produces the same history, verified by state-hash tests including snapshot/restore and renderer invariance. There is no LLM anywhere in the simulation.

## Run it

```sh
npm install
npm run dev          # the 3D terrarium in the browser (index.html); debug.html is the 2D debug view
npm test             # 80+ tests: determinism, invariants, relatedness math, conflict, culture, historian...
```

Headless:

```sh
npm run sim -- --seed 1 --years 300 --config configs/default.json --out runs/
    # -> runs/seed1-<confighash>/{events.jsonl, snapshots/year-NNNN.json, summary.json, chronicle.md, yearly.json}
npm run calibrate -- --seeds 1..20 --years 300      # demography vs targets
npm run accept -- --milestone all --seeds 1..20      # M2-M4 acceptance (+ cultural-learning knockout)
npm run history -- --seed 2 --years 300              # chronicle + "who founded / why dissolved / how gained power"
npm run batch -- --experiment configs/experiments/06-revenge-scope.json --seeds 1..50
npm run batch -- --all --seeds 1..6 --years 100      # every experiment, pilot size
```

## Layout

| path | what |
|---|---|
| `src/sim/` | the pure deterministic core. Lint and a DOM-free typecheck forbid DOM, Node, `Math.random` and wall-clock time. |
| `src/sim/systems/` | one file per system: climate, resources, metabolism, decision, movement, provision, social, reproduction, mortality, camps, clans, leadership, conflict, culture, gossip |
| `src/sim/state/` | SoA agent columns, per-agent memory pool (places, paths, "why", gossip), relationship maps, pedigree + known-kin index, clans |
| `src/sim/history/` | event log (causal graph), stats, demography measures, historian (labels, chronicle, whyQuery) |
| `src/worker/` | Web Worker host: render buffers, inspectors, scrubbing |
| `src/render/` | Three.js terrarium: terrain, water, trees, camps, graves, instanced humans, overlays |
| `src/ui/` | custom panels: inspector, clan panel, timeline, chronicle, time controls |
| `src/cli/` | headless run, calibrate, accept, history, batch (worker_threads pool) |
| `configs/` | `default.json` (all tunables) and `experiments/*.json` |
