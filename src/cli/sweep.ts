/**
 * Quick exploratory sweep: population trajectory per seed for a config.
 * npm run sweep -- --seeds 1..8 --years 100 --set '{...}' [--every 10]
 */
import { readFileSync } from 'node:fs';
import { makeConfig } from '../sim/config';
import { parseArgs, parseSeeds } from './args';
import { runPool } from './pool';

const args = parseArgs(process.argv.slice(2));
const seeds = parseSeeds(typeof args.seeds === 'string' ? args.seeds : '1..8');
const years = Number(args.years ?? 100);
const every = Number(args.every ?? 10);
const base = JSON.parse(readFileSync(typeof args.config === 'string' ? args.config : 'configs/default.json', 'utf8'));
const set = typeof args.set === 'string' ? JSON.parse(args.set) : {};
const cfg = makeConfig(makeConfig(base) as unknown as Record<string, unknown>);
const merged = mergeDeep(cfg, set);

function mergeDeep(a: unknown, b: unknown): unknown {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b === undefined ? a : b;
  const o: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) o[k] = mergeDeep(o[k], v);
  return o;
}

const rs = await runPool(seeds.map((seed) => ({ seed, years, config: merged, yearly: true })));
for (const r of rs) {
  const d = r.demography;
  const traj = (r.yearly ?? []).filter((y) => y.year % every === 0).map((y) => y.population).join(' ');
  console.log(`seed ${d.seed}: ${traj} | TF ${d.completedFertility.toFixed(2)} s15 ${d.survivalTo15.toFixed(2)} mode ${d.modalAdultAgeAtDeath} ibi ${d.meanInterbirthYears.toFixed(2)} moves ${r.extra.campMoves} ${r.wallSeconds.toFixed(0)}s`);
  const causes = Object.entries(d.deathsByCause).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ');
  console.log(`   deaths ${causes}`);
  if (args.bands) {
    for (const [band, cs] of Object.entries(d.deathsByAgeBand)) {
      console.log(`     ${band.padEnd(6)} ${Object.entries(cs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    }
  }
}
