/**
 * Historian report (§15 M6 acceptance): runs a world and answers, from the
 * causal event graph, "who founded clan N", "why did clan N dissolve" and
 * "how did leader X gain power"; writes the chronicle too.
 *   npm run history -- --seed 1 --years 300 [--config ...] [--out runs/history]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '../sim/config';
import { chronicle, howGainedPower, whoFounded, whyDissolved, type WhyStep } from '../sim/history/historian';
import { Simulation } from '../sim/sim';
import { parseArgs } from './args';

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 1);
const years = Number(args.years ?? 300);
const cfg = makeConfig(JSON.parse(readFileSync(typeof args.config === 'string' ? args.config : 'configs/default.json', 'utf8')));
const out = typeof args.out === 'string' ? args.out : `runs/history-seed${seed}`;

const sim = Simulation.create(seed, cfg);
for (let y = 0; y < years && sim.agents.living.length > 0; y++) {
  sim.run(cfg.time.daysPerYear);
  if ((y + 1) % 50 === 0) process.stderr.write(`  year ${y + 1}: ${sim.agents.living.length} people, ${sim.clans.extant().length} clans\n`);
}

const chain = (steps: WhyStep[]) => steps.map((s) => `${'  '.repeat(s.depth)}- ${s.text} *(event ${s.event.id})*`).join('\n');
const lines: string[] = [`# History of seed ${seed} (${years} years)`, ''];

lines.push('## Who founded each clan?', '');
for (const clan of [...sim.clans.clans.values()].filter((c) => c.founding.parentClanId > 0)) {
  lines.push(`### ${sim.clans.label(clan.id)}`, '', chain(whoFounded(sim, clan.id)), '');
}

lines.push('## Why did clans dissolve?', '');
for (const clan of [...sim.clans.clans.values()].filter((c) => c.dissolvedTick >= 0)) {
  lines.push(`### ${sim.clans.label(clan.id)}`, '', chain(whyDissolved(sim, clan.id)), '');
}

lines.push('## How did leaders gain power?', '');
const tenures = sim.leaderTenures().sort((a, b) => b.years - a.years).slice(0, 6);
for (const t of tenures) {
  lines.push(`### ${sim.agents.names[t.leader]} of ${sim.clans.label(t.clan)} (${t.years.toFixed(1)} years)`, '', chain(howGainedPower(sim, t.leader)), '');
}

lines.push('## Chronicle', '', ...chronicle(sim, { limit: 150 }).map((l) => `- ${l}`), '');

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'history.md'), lines.join('\n'));
console.log(lines.slice(0, 80).join('\n'));
console.log(`\n(full report: ${join(out, 'history.md')})`);
