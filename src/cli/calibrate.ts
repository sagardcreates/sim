/**
 * Demography calibration (§15 M1): runs N seeds x Y years and reports against
 * the targets. Usage: npm run calibrate -- [--seeds 1..20] [--years 300]
 *   [--config configs/default.json] [--set '{"mortality":{"makeham":0.01}}'] [--out runs/calibration]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configHash, makeConfig } from '../sim/config';
import { CODE_VERSION } from '../sim/sim';
import { parseArgs, parseSeeds } from './args';
import type { RunResult } from './jobs';
import { smoothedMode } from '../sim/history/demography';
import { runPool } from './pool';

const args = parseArgs(process.argv.slice(2));
const seeds = parseSeeds(typeof args.seeds === 'string' ? args.seeds : '1..20');
const years = Number(args.years ?? 300);
const base = JSON.parse(readFileSync(typeof args.config === 'string' ? args.config : 'configs/default.json', 'utf8'));
const overrides = typeof args.set === 'string' ? JSON.parse(args.set) : {};
const cfg = makeConfig(deepMergePlain(base, overrides));
const out = typeof args.out === 'string' ? args.out : 'runs/calibration';

function deepMergePlain(a: unknown, b: unknown): unknown {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b === undefined ? a : b;
  const o: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) o[k] = deepMergePlain(o[k], v);
  return o;
}

const t0 = performance.now();
const results = await runPool(seeds.map((seed) => ({ seed, years, config: cfg })), {
  onDone: (r, done) => process.stderr.write(`  seed ${r.job.seed} done (${done}/${seeds.length}) pop ${r.demography.finalPopulation}\n`),
});
const wall = (performance.now() - t0) / 1000;

const report = buildReport(results);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.md'), report);
writeFileSync(join(out, 'results.json'), JSON.stringify(results.map((r) => ({ ...r.demography, extra: r.extra })), null, 2));
console.log(report);
console.log(`wall ${wall.toFixed(1)}s`);

function buildReport(rs: RunResult[]): string {
  const d = rs.map((r) => r.demography);
  const mean = (xs: number[]) => {
    const v = xs.filter((x) => Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  };
  const f = (x: number, k = 2) => (Number.isFinite(x) ? x.toFixed(k) : '–');
  const stable = d.filter((x) => !x.extinct && x.ratio <= 4).length;
  const rows = d.map((x, i) => `| ${x.seed} | ${x.initialPopulation}→${x.finalPopulation} | ${x.minPopulation}–${x.peakPopulation} | ${f(x.completedFertility)} (${x.completedFertilityN}) | ${f(x.survivalTo15)} | ${f(x.modalAdultAgeAtDeath, 0)} | ${f(x.meanInterbirthYears)} | ${f(x.lifeExpectancyAtBirth, 1)} | ${rs[i].extra.campMoves} |`);
  const cfM = mean(d.map((x) => x.completedFertility));
  const s15M = mean(d.map((x) => x.survivalTo15));
  // Pool all seeds' deaths / intervals (robust to single bimodal seeds); per-seed values are in the table.
  const pooled = new Array(121).fill(0);
  for (const x of d) x.adultDeathAgeHist.forEach((v, a) => (pooled[a] += v));
  const modeM = smoothedMode(pooled);
  const ibiN = d.reduce((a, x) => a + x.interbirthN, 0);
  const ibiM = d.reduce((a, x) => a + x.interbirthSum, 0) / Math.max(1, ibiN);
  const modeMedian = [...d.map((x) => x.modalAdultAgeAtDeath)].sort((a, b) => a - b)[Math.floor(d.length / 2)];
  const causes: Record<string, number> = {};
  for (const x of d) for (const [k, v] of Object.entries(x.deathsByCause)) causes[k] = (causes[k] ?? 0) + v;
  const totalDeaths = Object.values(causes).reduce((a, b) => a + b, 0);
  const check = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
  return [
    `# Calibration report`,
    ``,
    `code ${CODE_VERSION} · config ${configHash(cfg)} · ${rs.length} seeds × ${years} years`,
    ``,
    `| target | value | status |`,
    `|---|---|---|`,
    `| population neither extinct nor > 4× start in ≥ 80% of seeds | ${stable}/${rs.length} | ${check(stable >= 0.8 * rs.length)} |`,
    `| total fertility 4–6 births per woman | ${f(cfM)} | ${check(cfM >= 4 && cfM <= 6)} |`,
    `| 40–60% of births survive to 15 | ${f(s15M * 100, 1)}% | ${check(s15M >= 0.4 && s15M <= 0.6)} |`,
    `| modal adult age at death 60–75 (pooled deaths; median of seeds ${f(modeMedian, 0)}) | ${f(modeM, 0)} | ${check(modeM >= 60 && modeM <= 75)} |`,
    `| mean interbirth interval 3–4 years (pooled, n=${ibiN}) | ${f(ibiM)} | ${check(ibiM >= 3 && ibiM <= 4)} |`,
    ``,
    `## Per seed`,
    ``,
    `| seed | pop start→end | pop range | completed fertility (n) | survival to 15 | modal adult age at death | interbirth (y) | e0 | camp moves |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `## Deaths by cause (all seeds)`,
    ``,
    ...Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v} (${((100 * v) / totalDeaths).toFixed(1)}%)`),
    ``,
  ].join('\n');
}
