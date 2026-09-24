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
// M4 also runs the knockout (cultural learning off) on the same seeds for comparison.
const variants: [string, unknown][] = milestone === 'm4' || milestone === 'all'
  ? [['learning', cfg], ['knockout', makeConfig(mergeDeep(cfg, { culture: { learning: false } }))]]
  : [['learning', cfg]];
const jobs = variants.flatMap(([label, config]) => seeds.map((seed) => ({ seed, years, config, yearly: true, label })));
const all = await runPool(jobs, {
  onDone: (r, done) => process.stderr.write(`  ${r.job.label} seed ${r.job.seed} done (${done}/${jobs.length})\n`),
});
const rs = all.filter((r) => r.job.label === 'learning');
const ko = all.filter((r) => r.job.label === 'knockout');
const report = [
  `# Acceptance ${milestone.toUpperCase()}`,
  '',
  `code ${CODE_VERSION} · config ${configHash(cfg)} · ${rs.length} seeds × ${years} years · wall ${((performance.now() - t0) / 1000).toFixed(0)}s`,
  '',
  ...sections(milestone, rs, ko),
].join('\n');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'report.md'), report);
writeFileSync(join(out, 'results.json'), JSON.stringify(rs.map((r) => ({ seed: r.job.seed, demography: r.demography, extra: r.extra })), null, 2));
console.log(report);

function sections(m: string, results: RunResult[], knockout: RunResult[] = []): string[] {
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
  if (m === 'all') {
    lines.push('## M2', '', ...sections('m2', results), '', '## M3', '', ...sections('m3', results), '', '## M4', '', ...sections('m4', results, knockout));
    return lines;
  }
  if (m === 'm4') {
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const on = { fst: mean(results.map((r) => r.extra.cultureFstMean)), mk: mean(results.map((r) => r.extra.markerDivMean)),
      fstEnd: mean(results.map((r) => r.extra.cultureFstEnd)), mkEnd: mean(results.map((r) => r.extra.markerDivEnd)) };
    const off = { fst: mean(knockout.map((r) => r.extra.cultureFstMean)), mk: mean(knockout.map((r) => r.extra.markerDivMean)),
      fstEnd: mean(knockout.map((r) => r.extra.cultureFstEnd)), mkEnd: mean(knockout.map((r) => r.extra.markerDivEnd)) };
    const measurable = results.filter((r) => r.extra.markerDivEnd > 0.2 && r.extra.cultureFstEnd > 0.02).length;
    lines.push(
      '| criterion | value | status |', '|---|---|---|',
      `| measurable between-clan divergence at year ${years} (marker > 0.2 and functional F_ST > 0.02) in most seeds | ${measurable}/${n} | ${pass(measurable >= most)} |`,
      `| knockout (cultural learning off) runs and is compared | ${knockout.length} runs | ${pass(knockout.length === n)} |`,
      '', '### Learning vs knockout (means over seeds)', '',
      '| variant | functional F_ST (mean over years) | functional F_ST (end) | marker divergence (mean) | marker divergence (end) | pop end |', '|---|---|---|---|---|---|',
      `| learning on | ${on.fst.toFixed(3)} | ${on.fstEnd.toFixed(3)} | ${on.mk.toFixed(3)} | ${on.mkEnd.toFixed(3)} | ${mean(results.map((r) => r.demography.finalPopulation)).toFixed(0)} |`,
      `| knockout | ${off.fst.toFixed(3)} | ${off.fstEnd.toFixed(3)} | ${off.mk.toFixed(3)} | ${off.mkEnd.toFixed(3)} | ${mean(knockout.map((r) => r.demography.finalPopulation)).toFixed(0)} |`,
      '', '| seed | F_ST start → end (learning) | F_ST start → end (knockout) | marker start → end (learning) | marker start → end (knockout) |', '|---|---|---|---|---|',
      ...results.map((r, k) => {
        const o = knockout[k];
        return `| ${r.job.seed} | ${r.extra.cultureFstStart.toFixed(3)} → ${r.extra.cultureFstEnd.toFixed(3)} | ${o ? `${o.extra.cultureFstStart.toFixed(3)} → ${o.extra.cultureFstEnd.toFixed(3)}` : '–'} | ${r.extra.markerDivStart.toFixed(2)} → ${r.extra.markerDivEnd.toFixed(2)} | ${o ? `${o.extra.markerDivStart.toFixed(2)} → ${o.extra.markerDivEnd.toFixed(2)}` : '–'} |`;
      }),
    );
    return lines;
  }
  if (m === 'm3' || m === 'm2m3') {
    if (m === 'm2m3') lines.push(...sections('m2', results), '');
    const shares = results.map((r) => r.demography.violentDeathShare);
    const okViolence = shares.filter((v) => v > 0 && v < 0.3).length;
    const pooled: number[] = [];
    // Tenure distribution: pooled tenures; non-degenerate = enough tenures with real spread.
    let nT = 0;
    for (const r of results) nT += r.extra.tenures;
    const cvs = results.filter((r) => r.extra.tenures >= 2).map((r) => r.extra.tenureCV);
    const meanCV = cvs.length ? cvs.reduce((a, b) => a + b, 0) / cvs.length : 0;
    void pooled;
    lines.push(
      '| criterion | value | status |', '|---|---|---|',
      `| violent deaths neither zero nor runaway (0 < share < 30%) in most seeds | ${okViolence}/${n} | ${pass(okViolence >= most)} |`,
      `| leader tenure distribution non-degenerate (≥ 20 tenures pooled, mean CV > 0.3) | ${nT} tenures, CV ${meanCV.toFixed(2)} | ${pass(nT >= 20 && meanCV > 0.3)} |`,
      '', '| seed | violent deaths % | threats | attacks | killings | tenures | tenure mean / median / max (y) | share of clan-years with a leader |', '|---|---|---|---|---|---|---|---|',
      ...results.map((r) => `| ${r.job.seed} | ${(100 * r.demography.violentDeathShare).toFixed(1)} | ${r.extra.threats} | ${r.extra.attacks} | ${r.extra.killings} | ${r.extra.tenures} | ${r.extra.tenureMean.toFixed(1)} / ${r.extra.tenureMedian.toFixed(1)} / ${r.extra.tenureMax.toFixed(1)} | ${(100 * r.extra.leaderYearsShare).toFixed(0)}% |`),
    );
  }
  if (m === 'm2' && results.length && results[0].job.label !== undefined) {
    // (demography appended below)
  }
  lines.push('', '## Demography', '', '| seed | pop start→end | completed fertility | survival to 15 | modal adult age | interbirth |', '|---|---|---|---|---|---|');
  for (const r of results) {
    const d = r.demography;
    lines.push(`| ${d.seed} | ${d.initialPopulation}→${d.finalPopulation} | ${d.completedFertility.toFixed(2)} | ${d.survivalTo15.toFixed(2)} | ${d.modalAdultAgeAtDeath} | ${d.meanInterbirthYears.toFixed(2)} |`);
  }
  return lines;
}
