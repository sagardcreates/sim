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
  let campMoves = 0;
  let droughts = 0;
  let epidemics = 0;
  for (const e of sim.events.macro.values()) {
    if (e.type === 'clan.camp_moved') campMoves++;
    if (e.type === 'climate.drought_began') droughts++;
    if (e.type === 'epidemic.outbreak') epidemics++;
  }
  return {
    job,
    demography: measureDemography(sim, initial),
    stateHash: sim.stateHash(),
    wallSeconds: (performance.now() - t0) / 1000,
    yearly: job.yearly ? sim.stats.years : undefined,
    extra: { campMoves, droughts, epidemics, clansExtant: sim.clans.extant().length },
  };
}
