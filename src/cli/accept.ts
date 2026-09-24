/**
 * Milestone acceptance reports (§15).
 *   npm run accept -- --milestone m2 [--seeds 1..20] [--years 300] [--set '{...}'] [--out runs/accept-m2]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configHash, makeConfig } from '../sim/config';
import { CODE_VERSION } from '../sim/sim';
import { parseArgs, parseSeeds } from './args';
import { mergeDeep } from './merge';
import type { RunResult } from './jobs';
import { runPool } from './pool';

const args = parseArgs(process.argv.slice(2));
const milestone = typeof args.milestone === 'string' ? args.milestone : 'm2';
const seeds = parseSeeds(typeof args.seeds === 'string' ? args.seeds : '1..20');
const years = Number(args.years ?? 300);
const base = JSON.parse(readFileSync(typeof args.config === 'string' ? args.config : 'configs/default.json', 'utf8'));
const cfg = makeConfig(mergeDeep(base, typeof args.set === 'string' ? JSON.parse(args.set) : {}));
const out = typeof args.out === 'string' ? args.out : `runs/accept-${milestone}`;

const t0 = performance.now();
const rs = await runPool(seeds.map((seed) => ({ seed, years, config: cfg, yearly: true })), {
  onDone: (r, done) => process.stderr.write(`  seed ${r.job.seed} done (${done}/${seeds.length})\n`),
});
const report = [
  `# Acceptance ${milestone.toUpperCase()}`,
  '',
  `code ${CODE_VERSION} · config ${configHash(cfg)} · ${rs.length} seeds × ${years} years · wall ${((performance.now() - t0) / 1000).toFixed(0)}s`,
  '',
  ...sections(milestone, rs),
].join('\n');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.md'), report);
writeFileSync(join(out, 'results.json'), JSON.stringify(rs.map((r) => ({ seed: r.job.seed, demography: r.demography, extra: r.extra })), null, 2));
console.log(report);

function sections(m: string, results: RunResult[]): string[] {
  const n = results.length;
  const most = Math.ceil(n / 2);
  const pass = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
  const lines: string[] = [];
  if (m === 'm2') {
    const withFission = results.filter((r) => r.extra.fissions >= 1).length;
    const neverCollapsed = results.filter((r) => r.extra.minClans > 1).length;
    const neverTooMany = results.filter((r) => r.extra.maxClans <= 15).length;
    lines.push(
      '| criterion | value | status |', '|---|---|---|',
      `| at least one fission in most runs | ${withFission}/${n} | ${pass(withFission >= most)} |`,
      `| clan count never collapses to 1 (most runs) | ${neverCollapsed}/${n} | ${pass(neverCollapsed >= most)} |`,
      `| clan count never exceeds ~15 (most runs) | ${neverTooMany}/${n} | ${pass(neverTooMany >= most)} |`,
      '', '| seed | pop end | fissions | dissolutions | clans min–max (final) | joins | expulsions | loners |', '|---|---|---|---|---|---|---|---|',
      ...results.map((r) => `| ${r.job.seed} | ${r.demography.finalPopulation} | ${r.extra.fissions} | ${r.extra.dissolutions} | ${r.extra.minClans}–${r.extra.maxClans} (${r.extra.finalClans}) | ${r.extra.joins} | ${r.extra.expulsions} | ${r.extra.loners} |`),
    );
  }
  lines.push('', '## Demography', '', '| seed | pop start→end | completed fertility | survival to 15 | modal adult age | interbirth |', '|---|---|---|---|---|---|');
  for (const r of results) {
    const d = r.demography;
    lines.push(`| ${d.seed} | ${d.initialPopulation}→${d.finalPopulation} | ${d.completedFertility.toFixed(2)} | ${d.survivalTo15.toFixed(2)} | ${d.modalAdultAgeAtDeath} | ${d.meanInterbirthYears.toFixed(2)} |`);
  }
  return lines;
}
