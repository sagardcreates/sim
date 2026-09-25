/**
 * Headless performance report (§14): sim-years per second at ~200, ~1,000 and
 * ~2,000 living agents. Populations drift, so the mean living count during
 * the timed window is reported alongside.
 *   npm run perf -- [--years 5] [--warmup 2]
 */
import { makeConfig } from '../sim/config';
import { Simulation } from '../sim/sim';
import { parseArgs } from './args';

const args = parseArgs(process.argv.slice(2));
const years = Number(args.years ?? 5);
const warmup = Number(args.warmup ?? 2);
const rows: string[] = ['| target agents | map | mean living (timed) | sim-years/s | ms per sim-day | ms per agent-day |', '|---|---|---|---|---|---|'];
for (const target of [200, 1000, 2000]) {
  // Hold density at the calibrated default (4 clans x 50 on 96x96): scale the
  // map area and the clan count with the target so the timed window measures a
  // viable population, not a famine.
  const k = target / 200;
  const side = Math.round(96 * Math.sqrt(k));
  const cfg = makeConfig({ world: { width: side, height: side }, init: { clanCount: 4 * k, agentsPerClan: 50 } });
  const sim = Simulation.create(1, cfg);
  sim.run(warmup * cfg.time.daysPerYear);
  let living = 0;
  const t0 = performance.now();
  for (let d = 0; d < years * cfg.time.daysPerYear; d++) {
    sim.step();
    living += sim.agents.living.length;
  }
  const secs = (performance.now() - t0) / 1000;
  const days = years * cfg.time.daysPerYear;
  const meanLiving = living / days;
  rows.push(`| ${target} | ${side}² | ${meanLiving.toFixed(0)} | ${(years / secs).toFixed(2)} | ${((1000 * secs) / days).toFixed(2)} | ${((1e6 * secs) / (days * meanLiving)).toFixed(1)} µs |`);
  process.stderr.write(`  ${target}: done\n`);
}
console.log(rows.join('\n'));
