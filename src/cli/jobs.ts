/**
 * Headless jobs runnable in worker threads. A job is plain data so it can be
 * posted to a worker; the result is plain data too.
 */
import { makeConfig } from '../sim/config';
import { measureDemography, type Demography } from '../sim/history/demography';
import type { YearStats } from '../sim/history/stats';
import { Simulation } from '../sim/sim';

export interface RunJob {
  seed: number;
  years: number;
  config: unknown;
  /** Include per-year stats in the result. */
  yearly?: boolean;
  label?: string;
}

export interface RunResult {
  job: RunJob;
  demography: Demography;
  stateHash: string;
  wallSeconds: number;
  yearly?: YearStats[];
  extra: Record<string, number>;
}

export function runJob(job: RunJob): RunResult {
  const t0 = performance.now();
  const sim = Simulation.create(job.seed, makeConfig(job.config));
  const initial = sim.agents.living.length;
  const dpy = sim.cfg.time.daysPerYear;
  for (let y = 0; y < job.years && sim.agents.living.length > 0; y++) sim.run(dpy);
  const count: Record<string, number> = {};
  for (const e of sim.events.macro.values()) count[e.type] = (count[e.type] ?? 0) + 1;
  const clanCounts = sim.stats.years.slice(1).map((y) => y.clans.filter((c) => c.size > 0).length);
  const campMoves = count['clan.camp_moved'] ?? 0;
  const droughts = count['climate.drought_began'] ?? 0;
  const epidemics = count['epidemic.outbreak'] ?? 0;
  return {
    job,
    demography: measureDemography(sim, initial),
    stateHash: sim.stateHash(),
    wallSeconds: (performance.now() - t0) / 1000,
    yearly: job.yearly ? sim.stats.years : undefined,
    extra: {
      campMoves, droughts, epidemics, clansExtant: sim.clans.extant().length,
      fissions: count['clan.fission'] ?? 0,
      dissolutions: count['clan.dissolved'] ?? 0,
      joins: count['agent.joined_clan'] ?? 0,
      expulsions: count['agent.expelled'] ?? 0,
      minClans: clanCounts.length ? Math.min(...clanCounts) : 0,
      maxClans: clanCounts.length ? Math.max(...clanCounts) : 0,
      finalClans: clanCounts.length ? clanCounts[clanCounts.length - 1] : 0,
      loners: sim.clanMembers.get(-1)?.length ?? 0,
      ...sim.acceptanceMetrics(),
    },
  };
}
