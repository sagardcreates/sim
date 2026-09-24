/**
 * Demographic measures computed from the pedigree (every agent who ever
 * lived). Pure analysis: used by `npm run calibrate`, reports and the UI.
 */
import type { Simulation } from '../sim';
import { CAUSE_NAMES, CAUSE_VIOLENCE, SEX_FEMALE } from '../state/agents';

export interface Demography {
  seed: number;
  years: number;
  initialPopulation: number;
  finalPopulation: number;
  peakPopulation: number;
  minPopulation: number;
  ratio: number;
  extinct: boolean;
  births: number;
  deaths: number;
  /** Mean live births of women born during the run who reached 45. */
  completedFertility: number;
  completedFertilityN: number;
  /** Fraction of births (old enough to be judged) surviving to 15. */
  survivalTo15: number;
  survivalTo15N: number;
  /** Mode of age at death (>= 15), 5-year smoothing. */
  modalAdultAgeAtDeath: number;
  meanAdultAgeAtDeath: number;
  /** Mean years between successive births of the same mother. */
  meanInterbirthYears: number;
  interbirthN: number;
  deathsByCause: Record<string, number>;
  violentDeathShare: number;
  lifeExpectancyAtBirth: number;
  /** Deaths by age band and cause: band -> cause -> count. */
  deathsByAgeBand: Record<string, Record<string, number>>;
  /** Raw histogram of adult (>= 15) ages at death, 1-year bins (for pooling across seeds). */
  adultDeathAgeHist: number[];
  interbirthSum: number;
}

/** Mode of a 1-year histogram with 5-year smoothing, over ages >= 15. */
export function smoothedMode(hist: number[]): number {
  let mode = NaN;
  let best = 0;
  for (let a = 15; a <= 118; a++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += hist[a + k] ?? 0;
    if (s > best) {
      best = s;
      mode = a;
    }
  }
  return mode;
}

export const AGE_BANDS: [string, number][] = [['0-1', 1], ['1-5', 5], ['5-15', 15], ['15-30', 30], ['30-50', 50], ['50-70', 70], ['70+', 999]];

export function measureDemography(sim: Simulation, initialPopulation: number): Demography {
  const c = sim.agents.cols;
  const dpy = sim.cfg.time.daysPerYear;
  const end = sim.tick;
  const n = sim.agents.count;
  let births = 0;
  let deaths = 0;
  let cfSum = 0;
  let cfN = 0;
  let s15 = 0;
  let s15N = 0;
  const ageHist = new Array(121).fill(0);
  let adultAgeSum = 0;
  let adultN = 0;
  const byCause: Record<string, number> = {};
  let violent = 0;
  let e0Sum = 0;
  let e0N = 0;
  const ibis: number[] = [];
  const bands: Record<string, Record<string, number>> = {};

  for (let id = 0; id < n; id++) {
    const born = c.birthTick[id];
    const dead = c.alive[id] === 0;
    const lifespanDays = (dead ? c.deathTick[id] : end) - born;
    if (born >= 0) births++;
    if (dead) {
      deaths++;
      const cause = CAUSE_NAMES[c.deathCause[id]];
      byCause[cause] = (byCause[cause] ?? 0) + 1;
      if (c.deathCause[id] === CAUSE_VIOLENCE) violent++;
      const age = lifespanDays / dpy;
      const band = AGE_BANDS.find(([, hi]) => age < hi)![0];
      bands[band] ??= {};
      bands[band][cause] = (bands[band][cause] ?? 0) + 1;
      if (age >= 15) {
        ageHist[Math.min(120, Math.floor(age))]++;
        adultAgeSum += age;
        adultN++;
      }
    }
    // Survival to 15 among births that are either dead or at least 15 years before the end.
    if (born >= 0 && born <= end - 15 * dpy) {
      s15N++;
      if (lifespanDays >= 15 * dpy) s15++;
    }
    // Life expectancy at birth from completed lives of those born early enough.
    if (born >= 0 && born <= end - 100 * dpy) {
      e0Sum += lifespanDays / dpy;
      e0N++;
    }
    // Completed fertility.
    if (c.sex[id] === SEX_FEMALE && born >= 0 && lifespanDays >= 45 * dpy) {
      const kids = sim.pedigree.childrenOf(id).filter((k) => c.motherId[k] === id);
      cfSum += kids.length;
      cfN++;
    }
    // Interbirth intervals (all mothers, all successive births).
    const kids = sim.pedigree.childrenOf(id);
    if (c.sex[id] === SEX_FEMALE && kids.length > 1) {
      const ticks = kids.filter((k) => c.motherId[k] === id).map((k) => c.birthTick[k]).filter((t) => t >= 0).sort((a, b) => a - b);
      for (let k = 1; k < ticks.length; k++) ibis.push((ticks[k] - ticks[k - 1]) / dpy);
    }
  }
  const mode = smoothedMode(ageHist);
  const pops = sim.stats.years.map((y) => y.population);
  const finalPopulation = sim.agents.living.length;
  return {
    seed: sim.seed,
    years: Math.floor(end / dpy),
    initialPopulation,
    finalPopulation,
    peakPopulation: Math.max(initialPopulation, ...pops),
    minPopulation: Math.min(initialPopulation, ...pops),
    ratio: finalPopulation / initialPopulation,
    extinct: finalPopulation === 0,
    births,
    deaths,
    completedFertility: cfN ? cfSum / cfN : NaN,
    completedFertilityN: cfN,
    survivalTo15: s15N ? s15 / s15N : NaN,
    survivalTo15N: s15N,
    modalAdultAgeAtDeath: mode,
    meanAdultAgeAtDeath: adultN ? adultAgeSum / adultN : NaN,
    meanInterbirthYears: ibis.length ? ibis.reduce((a, b) => a + b, 0) / ibis.length : NaN,
    interbirthN: ibis.length,
    deathsByCause: byCause,
    violentDeathShare: deaths ? violent / deaths : 0,
    lifeExpectancyAtBirth: e0N ? e0Sum / e0N : NaN,
    deathsByAgeBand: bands,
    adultDeathAgeHist: ageHist,
    interbirthSum: ibis.reduce((a, b) => a + b, 0),
  };
}

