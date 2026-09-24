/** Running counters aggregated per year (observational; never read by systems). */
import { CAUSE_NAMES } from '../state/agents';

export interface DayCounters {
  births: number;
  deaths: number[];
  kills: number;
  given: number;
  stored: number;
  taken: number;
  pairs: number;
  infections: number;
  miscarriages: number;
  encounters: number;
  crossClanEncounters: number;
  clanChanges: number;
  freeRiding: number;
  partyHunts: number;
  threats: number;
  attacks: number;
  contests: number;
  killings: number;
  thefts: number;
  gossip: number;
  normJudgements: number;
}

export interface YearStats {
  year: number;
  population: number;
  births: number;
  deaths: Record<string, number>;
  kills: number;
  foodGiven: number;
  foodStored: number;
  foodTaken: number;
  pairs: number;
  infections: number;
  miscarriages: number;
  meanEnergy: number;
  drought: number;
  encounters: number;
  crossClanEncounters: number;
  clanChanges: number;
  freeRiding: number;
  partyHunts: number;
  threats: number;
  attacks: number;
  killings: number;
  thefts: number;
  leaders: number;
  gossip: number;
  normJudgements: number;
  cultureFst: number;
  markerDivergence: number;
  clans: { id: number; size: number }[];
  loners: number;
}

function freshDay(): DayCounters {
  return { births: 0, deaths: CAUSE_NAMES.map(() => 0), kills: 0, given: 0, stored: 0, taken: 0, pairs: 0, infections: 0, miscarriages: 0, encounters: 0, crossClanEncounters: 0, clanChanges: 0, freeRiding: 0, partyHunts: 0, threats: 0, attacks: 0, contests: 0, killings: 0, thefts: 0, gossip: 0, normJudgements: 0 };
}

export class Stats {
  /** Accumulates over the current year (named `day` because systems add per event). */
  day: DayCounters = freshDay();
  years: YearStats[] = [];

  closeYear(y: Omit<YearStats, 'births' | 'deaths' | 'kills' | 'foodGiven' | 'foodStored' | 'foodTaken' | 'pairs' | 'infections' | 'miscarriages' | 'encounters' | 'crossClanEncounters' | 'clanChanges' | 'freeRiding' | 'partyHunts' | 'threats' | 'attacks' | 'killings' | 'thefts' | 'gossip' | 'normJudgements'>): void {
    const d = this.day;
    const deaths: Record<string, number> = {};
    d.deaths.forEach((n, i) => {
      if (n > 0) deaths[CAUSE_NAMES[i]] = n;
    });
    this.years.push({
      ...y, births: d.births, deaths, kills: d.kills, foodGiven: Math.round(d.given), foodStored: Math.round(d.stored), foodTaken: Math.round(d.taken), pairs: d.pairs,
      infections: d.infections, miscarriages: d.miscarriages, encounters: d.encounters,
      crossClanEncounters: d.crossClanEncounters, clanChanges: d.clanChanges, freeRiding: d.freeRiding, partyHunts: d.partyHunts,
      threats: d.threats, attacks: d.attacks, killings: d.killings, thefts: d.thefts,
      gossip: d.gossip, normJudgements: d.normJudgements,
    });
    this.day = freshDay();
  }
}
