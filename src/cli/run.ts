/**
 * Headless run:
 *   npm run sim -- --seed 1 --years 300 --config configs/default.json --out runs/
 * Writes <out>/seed<seed>-<configHash>/{events.jsonl, snapshots/year-NNNN.json, summary.json}.
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configHash, makeConfig } from '../sim/config';
import { CODE_VERSION, Simulation } from '../sim/sim';
import { parseArgs } from './args';

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 1);
const years = Number(args.years ?? 10);
const configPath = typeof args.config === 'string' ? args.config : 'configs/default.json';
const outRoot = typeof args.out === 'string' ? args.out : 'runs/';
const snapshotEvery = Number(args['snapshot-every'] ?? 1);
const writeFiles = !args['no-output'];

const cfg = makeConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const cHash = configHash(cfg);
const sim = Simulation.create(seed, cfg);
const dir = join(outRoot, `seed${seed}-${cHash}`);

let events: ReturnType<typeof createWriteStream> | undefined;
if (writeFiles) {
  mkdirSync(join(dir, 'snapshots'), { recursive: true });
  events = createWriteStream(join(dir, 'events.jsonl'));
  // Events emitted during create() are already in the macro log; flush them first.
  for (const e of [...sim.events.macro.values()].sort((a, b) => a.id - b.id)) events.write(JSON.stringify(e) + '\n');
  sim.events.subscribe((e) => events!.write(JSON.stringify(e) + '\n'));
}

const t0 = performance.now();
const dpy = cfg.time.daysPerYear;
for (let y = 0; y < years; y++) {
  sim.run(dpy);
  if (writeFiles && snapshotEvery > 0 && (y + 1) % snapshotEvery === 0) {
    writeFileSync(join(dir, 'snapshots', `year-${String(y + 1).padStart(4, '0')}.json`), JSON.stringify(sim.snapshot()));
  }
}
const secs = (performance.now() - t0) / 1000;

const summary = {
  seed,
  years,
  codeVersion: CODE_VERSION,
  configHash: cHash,
  finalTick: sim.tick,
  population: sim.agents.living.length,
  everLived: sim.agents.count,
  stateHash: sim.stateHash(),
  wallSeconds: Number(secs.toFixed(3)),
  simYearsPerSecond: Number((years / secs).toFixed(2)),
};
if (writeFiles) {
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  events!.end();
}
console.log(JSON.stringify(summary, null, 2));
