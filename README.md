# Terrarium

An agent-based artificial civilization simulation where clans, leadership, conflict and culture emerge from individual rules. The source of truth is [`docs/SPEC.md`](docs/SPEC.md), and design decisions are logged in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Status

**M0 (skeleton)** is done: config system, seeded RNG streams, struct-of-arrays agent store, causal event log, terrain generation, headless CLI, Web Worker, and a 2D debug view.

## Usage

```sh
npm install
npm run dev                  # 2D debug view in the browser
npm run sim -- --seed 1 --years 10 --config configs/default.json --out runs/
npm test                     # includes the determinism acceptance test
npm run lint && npm run typecheck
```

`npm run sim` writes `runs/seed<seed>-<configHash>/` with `events.jsonl`, yearly `snapshots/`, and `summary.json` (including the state hash). Options: `--snapshot-every N` and `--no-output`.

## Layout

- `src/sim/`: pure deterministic core. Lint and typecheck forbid DOM, Node, `Math.random` and wall-clock time.
- `src/worker/`: Web Worker wrapper and message protocol.
- `src/debug/`: M0 2D canvas debug view. The Three.js renderer arrives in M5.
- `src/cli/`: headless tools.
- `configs/`: all tunable parameters.
- `tests/`: Vitest suites.
