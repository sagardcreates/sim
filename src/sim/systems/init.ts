/**
 * Initial world population (§7): N clans with realistic age pyramids,
 * spatially separated camps near water, non-identical random cultures.
 * Founding children get founding parents so kin provisioning works from day 0.
 */
import type { SimConfig } from '../config';
import type { Rng } from '../rng';
import type { Simulation } from '../sim';
import { makeClanName, makePersonName, makeSyllableSet } from '../names';
import {
  NO_ID, PHASE_HOME, REP_CYCLING, REP_LACTATING, REP_NONE, REP_PREGNANT, SEX_FEMALE, SEX_MALE,
} from '../state/agents';
import { BIOME_WATER, type World } from '../world/terrain';
import { clamp01, placeAtHome } from './common';

/** Greedy separated camp placement; relaxes separation if the map can't fit the clans. */
export function chooseCampSites(world: World, cfg: SimConfig, rng: Rng, count: number): { x: number; y: number }[] {
  const candidates: number[] = [];
  const margin = 4;
  for (let y = margin; y < world.height - margin; y++) {
    for (let x = margin; x < world.width - margin; x++) {
      const i = y * world.width + x;
      if (world.biome[i] !== BIOME_WATER && world.movementCost[i] < cfg.world.impassableCost
        && world.waterDistance[i] > 0 && world.waterDistance[i] <= cfg.init.campMaxWaterDistance) {
        candidates.push(i);
      }
    }
  }
  rng.shuffle(candidates);
  let sep = cfg.init.campMinSeparation;
  while (sep > 0) {
    const chosen: number[] = [];
    for (const c of candidates) {
      const cx = c % world.width;
      const cy = (c / world.width) | 0;
      if (chosen.every((o) => Math.hypot((o % world.width) - cx, ((o / world.width) | 0) - cy) >= sep)) chosen.push(c);
      if (chosen.length === count) break;
    }
    if (chosen.length === count) {
      return chosen.map((c) => ({ x: (c % world.width) + 0.5, y: ((c / world.width) | 0) + 0.5 }));
    }
    sep = Math.floor(sep * 0.8);
  }
  throw new Error('No valid camp sites: map has no land near water.');
}

/** Age in years from a truncated exponential pyramid (many young, few old). */
function sampleInitialAgeYears(rng: Rng, cfg: SimConfig): number {
  const k = cfg.init.agePyramidDecay;
  const max = cfg.init.maxInitialAge;
  const u = rng.next();
  return -Math.log(1 - u * (1 - Math.exp(-k * max))) / k;
}

export interface ClanCulture {
  sharing: number;
  violence: number;
  leg: [number, number, number, number];
  residence: number;
  revenge: number;
  outgroupTrust: number;
  kinWeight: number;
  ancestorNaming: number;
  marker: number;
}

export function randomClanCulture(rng: Rng, sd: number, cfg?: SimConfig): ClanCulture {
  const t = () => clamp01(rng.normal(0.5, sd * 1.6));
  const leg: [number, number, number, number] = [rng.next(), rng.next(), rng.next(), rng.next()];
  const cc: ClanCulture = {
    sharing: t(), violence: t(), leg, residence: rng.int(3), revenge: rng.int(3),
    outgroupTrust: t(), kinWeight: t(), ancestorNaming: t(), marker: rng.int(cfg?.culture.markerPatterns ?? 64),
  };
  // Experiment overrides (-1 = no override).
  const ov = cfg?.init.cultureOverrides;
  if (ov) {
    if (ov.residence >= 0) cc.residence = ov.residence;
    if (ov.revenge >= 0) cc.revenge = ov.revenge;
    if (ov.lineageWeight >= 0) cc.leg[2] = ov.lineageWeight;
  }
  return cc;
}

/** Individual culture = clan mean + noise (§7: non-identical, randomly seeded). */
export function assignCulture(sim: Simulation, id: number, cc: ClanCulture, rng: Rng): void {
  const c = sim.agents.cols;
  const sd = sim.cfg.init.cultureIndividualSd;
  const n = (v: number) => clamp01(v + rng.normal(0, sd));
  c.cSharing[id] = n(cc.sharing);
  c.cViolence[id] = n(cc.violence);
  const w = cc.leg.map((v) => Math.max(0.01, v + rng.normal(0, sd)));
  if (sim.cfg.init.cultureOverrides.lineageWeight >= 0) w[2] = Math.max(1e-6, sim.cfg.init.cultureOverrides.lineageWeight);
  const sum = w[0] + w[1] + w[2] + w[3];
  c.cLegStrength[id] = w[0] / sum;
  c.cLegGenerosity[id] = w[1] / sum;
  c.cLegLineage[id] = w[2] / sum;
  c.cLegAge[id] = w[3] / sum;
  const ov = sim.cfg.init.cultureOverrides;
  c.cResidence[id] = ov.residence >= 0 ? ov.residence : rng.chance(0.9) ? cc.residence : rng.int(3);
  c.cRevenge[id] = ov.revenge >= 0 ? ov.revenge : rng.chance(0.9) ? cc.revenge : rng.int(3);
  c.cOutgroupTrust[id] = n(cc.outgroupTrust);
  c.cKinWeight[id] = n(cc.kinWeight);
  c.cAncestorNaming[id] = n(cc.ancestorNaming);
  c.cMarker[id] = cc.marker;
}

const GENES = ['Build', 'Robustness', 'Fertility', 'Boldness', 'Sociability', 'Temper'] as const;

export function populate(sim: Simulation, startEventId: number): void {
  const { world, cfg, agents, clans, events } = sim;
  const rng = sim.rng.get('init');
  const sites = chooseCampSites(world, cfg, rng, cfg.init.clanCount);
  const dpy = cfg.time.daysPerYear;
  const c = agents.cols;
  const l = cfg.life;
  for (const site of sites) {
    const set = makeSyllableSet(rng);
    const clan = clans.create(makeClanName(rng, set), site.x, site.y, { tick: 0, parentClanId: -1, founderId: -1, eventId: -1 });
    sim.syllables.set(clan.id, set);
    clan.founding.eventId = events.emit(0, {
      type: 'clan.founded', causes: [startEventId], x: site.x, y: site.y, clans: [clan.id],
      data: { name: clan.name, initial: true },
    });
    clan.history.push(clan.founding.eventId);
    const culture = randomClanCulture(rng, cfg.init.cultureClanSd, cfg);

    // Oldest first, so parents always get lower ids than their children.
    const ages = Array.from({ length: cfg.init.agentsPerClan }, () => sampleInitialAgeYears(rng, cfg)).sort((a, b) => b - a);
    const women: number[] = [];
    const men: number[] = [];
    for (const age of ages) {
      const id = agents.create(makePersonName(rng, set));
      sim.onCreated(id);
      c.birthTick[id] = -Math.floor(age * dpy);
      c.sex[id] = rng.chance(0.5) ? SEX_FEMALE : SEX_MALE;
      c.clanId[id] = clan.id;
      c.birthClanId[id] = clan.id;
      c.energy[id] = 0.8;
      c.condition[id] = 0.8;
      c.health[id] = 1;
      c.healthCap[id] = 1;
      c.lastWaterTick[id] = 0;
      c.phase[id] = PHASE_HOME;
      for (const g of GENES) {
        const gene = clamp01(rng.normal(0.5, 0.15));
        c[`g${g}`][id] = gene;
        c[(g.charAt(0).toLowerCase() + g.slice(1)) as Lowercase<typeof g>][id] = clamp01(gene + rng.normal(0, cfg.reproduction.developmentalNoiseSd));
      }
      for (const g of ['gSkin', 'gHeight', 'gHair'] as const) c[g][id] = clamp01(rng.normal(0.5, 0.18));
      c.foragingSkill[id] = clamp01(Math.min(1, age / l.adultAgeYears) * cfg.skills.initialAdultSkill + rng.normal(0, 0.08));
      c.forageYieldEma[id] = cfg.decision.expectedYieldPrior;
      c.huntSuccessEma[id] = cfg.decision.huntSuccessPrior;
      c.recentYield[id] = cfg.metabolism.adultNeed;
      assignCulture(sim, id, culture, rng);
      placeAtHome(sim, id);
      if (age >= l.adultAgeYears) (c.sex[id] === SEX_FEMALE ? women : men).push(id);
    }

    // Pair founding adults (similar ages), avoiding nothing: founders are unrelated.
    const unpairedMen = [...men];
    for (const w of women) {
      if (!rng.chance(cfg.init.initialPairFraction) || unpairedMen.length === 0) continue;
      const wa = -c.birthTick[w];
      let best = -1;
      let bestGap = Infinity;
      for (let k = 0; k < unpairedMen.length; k++) {
        const gap = Math.abs(-c.birthTick[unpairedMen[k]] - wa) / dpy + rng.next() * 3;
        if (gap < bestGap) {
          bestGap = gap;
          best = k;
        }
      }
      if (bestGap > cfg.reproduction.pairingMaxAgeGapYears) continue;
      const m = unpairedMen.splice(best, 1)[0];
      c.partnerId[w] = m;
      c.partnerId[m] = w;
    }

    // Link founding children to plausible founding mothers (and their partners).
    const kids: number[] = [];
    for (let id = agents.count - ages.length; id < agents.count; id++) if (-c.birthTick[id] / dpy < l.adultAgeYears) kids.push(id);
    const kidCount = new Map<number, number>();
    for (const k of kids) {
      const ka = -c.birthTick[k] / dpy;
      const moms = women.filter((w) => {
        const ma = -c.birthTick[w] / dpy - ka; // mother's age at child's birth
        return w < k && ma >= l.femaleFertileStartYears && ma <= l.femaleFertileEndYears && (kidCount.get(w) ?? 0) < 6;
      });
      if (moms.length === 0) continue;
      const mom = rng.pick(moms);
      kidCount.set(mom, (kidCount.get(mom) ?? 0) + 1);
      c.motherId[k] = mom;
      const dad = c.partnerId[mom];
      if (dad !== NO_ID && dad < k) {
        c.fatherId[k] = dad;
        c.rearerId[k] = dad;
      }
    }
    for (const id of kids) sim.pedigree.registerBirth(id);

    // Reproductive states consistent with the founding families.
    for (const w of women) {
      const age = -c.birthTick[w] / dpy;
      if (age > l.femaleFertileEndYears) {
        c.repState[w] = REP_NONE;
        continue;
      }
      const youngest = sim.pedigree.childrenOf(w).reduce((m, k) => Math.max(m, c.birthTick[k]), -Infinity);
      const youngestAge = -youngest / dpy;
      if (youngestAge < l.weaningAgeYears) {
        c.repState[w] = REP_LACTATING;
        c.repUntilTick[w] = Math.floor((l.weaningAgeYears - youngestAge) * dpy);
      } else if (c.partnerId[w] !== NO_ID && rng.chance(0.2)) {
        c.repState[w] = REP_PREGNANT;
        c.repUntilTick[w] = 1 + rng.int(cfg.reproduction.gestationDays);
        c.pregnancyFatherId[w] = c.partnerId[w];
      } else {
        c.repState[w] = REP_CYCLING;
      }
    }
  }
}
