/**
 * Compare several config variants across seeds (parallel).
 *   npm run compare -- --seeds 1..4 --years 200 --variants '{"A":{...},"B":{...}}'
 * Prints the calibration metrics per variant (means over seeds).
 */
import { readFileSync } from 'node:fs';
import { makeConfig } from '../sim/config';
import { parseArgs, parseSeeds } from './args';
import type { RunJob } from './jobs';
import { runPool } from './pool';

const args = parseArgs(process.argv.slice(2));
const seeds = parseSeeds(typeof args.seeds === 'string' ? args.seeds : '1..4');
const years = Number(args.years ?? 200);
const base = JSON.parse(readFileSync(typeof args.config === 'string' ? args.config : 'configs/default.json', 'utf8'));
const variants: Record<string, unknown> = typeof args.variants === 'string' ? JSON.parse(args.variants) : { base: {} };

export function mergeDeep(a: unknown, b: unknown): unknown {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b === undefined ? a : b;
  const o: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) o[k] = mergeDeep(o[k], v);
  return o;
}

const jobs: RunJob[] = [];
for (const [label, v] of Object.entries(variants)) {
  const cfg = makeConfig(mergeDeep(base, v));
  for (const seed of seeds) jobs.push({ seed, years, config: cfg, label });
}
const rs = await runPool(jobs);
const mean = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
for (const label of Object.keys(variants)) {
  const d = rs.filter((r) => r.job.label === label).map((r) => r.demography);
  const stable = d.filter((x) => !x.extinct && x.ratio <= 4).length;
  const starv = mean(d.map((x) => (x.deathsByCause['starvation'] ?? 0) / Math.max(1, x.deaths)));
  console.log(
    `${label.padEnd(10)} stable ${stable}/${d.length} TF ${mean(d.map((x) => x.completedFertility)).toFixed(2)} ` +
    `s15 ${mean(d.map((x) => x.survivalTo15)).toFixed(2)} mode ${d.map((x) => x.modalAdultAgeAtDeath).join('/')} ` +
    `ibi ${mean(d.map((x) => x.meanInterbirthYears)).toFixed(2)} starv ${(100 * starv).toFixed(0)}% ` +
    `pop ${d.map((x) => `${x.minPopulation}-${x.peakPopulation}→${x.finalPopulation}`).join(' ')}`,
  );
}
