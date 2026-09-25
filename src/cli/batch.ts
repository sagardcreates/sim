/**
 * Experiment harness (§15 M7): parallel headless runs (worker_threads) over
 * variants x seeds, with a per-run CSV and a markdown summary.
 *   npm run batch -- --experiment configs/experiments/01-scarcity-violence.json [--seeds 1..10] [--years 150] [--out runs/exp]
 *   npm run batch -- --seeds 1..50 --years 300            (baseline, no experiment)
 *   npm run batch -- --all [--seeds 1..6 --years 100]      (every experiment; pilot sizes)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { configHash, makeConfig } from '../sim/config';
import { CODE_VERSION } from '../sim/sim';
import { parseArgs, parseSeeds } from './args';
import type { RunJob, RunResult } from './jobs';
import { mergeDeep } from './merge';
import { runPool } from './pool';

interface Experiment {
  name: string;
  question: string;
  seeds: string;
  years: number;
  metrics: string[];
  variants: Record<string, unknown>;
  contingency?: boolean;
}

const args = parseArgs(process.argv.slice(2));
const base = JSON.parse(readFileSync(typeof args.config === 'string' ? args.config : 'configs/default.json', 'utf8'));
const outRoot = typeof args.out === 'string' ? args.out : 'runs/experiments';
const files = args.all
  ? readdirSync('configs/experiments').filter((f) => f.endsWith('.json')).sort().map((f) => join('configs/experiments', f))
  : typeof args.experiment === 'string' ? [args.experiment] : [];

const DEMO = ['finalPopulation', 'completedFertility', 'survivalTo15', 'violentDeathShare'];

async function runExperiment(file: string | null): Promise<string> {
  const exp: Experiment = file
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { name: 'Baseline batch', question: 'Baseline runs of the default config.', seeds: '1..50', years: 300, metrics: ['killingsPer1000PersonYears', 'meanClanSize', 'extinctions', 'leaderYearsShare'], variants: { baseline: {} } };
  const seeds = parseSeeds(typeof args.seeds === 'string' ? args.seeds : exp.seeds);
  const years = Number(args.years ?? exp.years);
  const jobs: RunJob[] = [];
  const hashes: Record<string, string> = {};
  for (const [label, v] of Object.entries(exp.variants)) {
    const cfg = makeConfig(mergeDeep(base, v));
    hashes[label] = configHash(cfg);
    for (const seed of seeds) jobs.push({ seed, years, config: cfg, label });
  }
  const t0 = performance.now();
  const rs = await runPool(jobs, {
    onDone: (r, done) => process.stderr.write(`  [${exp.name}] ${r.job.label} seed ${r.job.seed} (${done}/${jobs.length})\n`),
  });
  const wall = (performance.now() - t0) / 1000;
  const slug = file ? basename(file, '.json') : 'baseline';
  const dir = join(outRoot, slug);
  mkdirSync(dir, { recursive: true });
  const value = (r: RunResult, m: string): number => {
    if (m in r.extra) return r.extra[m];
    if (m === 'finalPopulation') return r.demography.finalPopulation;
    if (m === 'completedFertility') return r.demography.completedFertility;
    if (m === 'survivalTo15') return r.demography.survivalTo15;
    if (m === 'violentDeathShare') return r.demography.violentDeathShare;
    return NaN;
  };
  const cols = [...exp.metrics, ...DEMO];
  // Per-run CSV.
  const csv = [['variant', 'seed', 'config', ...cols].join(',')];
  for (const r of rs) csv.push([JSON.stringify(r.job.label), r.job.seed, hashes[r.job.label!], ...cols.map((m) => fmt(value(r, m)))].join(','));
  writeFileSync(join(dir, 'runs.csv'), csv.join('\n') + '\n');
  // Summary: mean and 95% CI per variant, per metric.
  const lines = [
    `# ${exp.name}`, '', exp.question, '',
    `code ${CODE_VERSION} · ${seeds.length} seeds × ${years} years per variant · wall ${wall.toFixed(0)}s`, '',
    `| metric | ${Object.keys(exp.variants).join(' | ')} |`,
    `|---|${Object.keys(exp.variants).map(() => '---').join('|')}|`,
  ];
  for (const m of cols) {
    const cells = Object.keys(exp.variants).map((label) => {
      const xs = rs.filter((r) => r.job.label === label).map((r) => value(r, m)).filter(Number.isFinite);
      const { mean, ci } = meanCI(xs);
      return `${fmt(mean)} ± ${fmt(ci)}`;
    });
    lines.push(`| ${m} | ${cells.join(' | ')} |`);
  }
  if (exp.contingency) {
    lines.push('', '## Robustness across seeds', '', 'Coefficient of variation across seeds: low = robust outcome, high = contingent on history.', '',
      '| metric | mean | sd | CV | min | max |', '|---|---|---|---|---|---|');
    for (const m of cols) {
      const xs = rs.map((r) => value(r, m)).filter(Number.isFinite);
      const { mean } = meanCI(xs);
      const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
      lines.push(`| ${m} | ${fmt(mean)} | ${fmt(sd)} | ${mean !== 0 ? fmt(sd / Math.abs(mean)) : '–'} | ${fmt(Math.min(...xs))} | ${fmt(Math.max(...xs))} |`);
    }
  }
  lines.push('', `Per-run data: \`${join(dir, 'runs.csv')}\`. Values are mean ± 95% CI over seeds.`);
  writeFileSync(join(dir, 'summary.md'), lines.join('\n') + '\n');
  return lines.join('\n');
}

function meanCI(xs: number[]): { mean: number; ci: number } {
  if (xs.length === 0) return { mean: NaN, ci: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean, ci: xs.length > 1 ? (1.96 * sd) / Math.sqrt(xs.length) : 0 };
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return '';
  const a = Math.abs(x);
  return a >= 100 ? x.toFixed(0) : a >= 10 ? x.toFixed(1) : x.toFixed(3);
}

const reports: string[] = [];
if (files.length === 0) reports.push(await runExperiment(null));
for (const f of files) reports.push(await runExperiment(f));
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, 'README.md'), reports.join('\n\n---\n\n') + '\n');
console.log(reports.join('\n\n---\n\n'));
