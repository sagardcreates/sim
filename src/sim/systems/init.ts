/**
 * Initial world population (§7): N clans with realistic age pyramids,
 * spatially separated camps near water.
 */
import type { SimConfig } from '../config';
import type { Rng } from '../rng';
import { makeClanName, makePersonName, makeSyllableSet, type SyllableSet } from '../names';
import { AgentStore, REP_CYCLING, REP_NONE, SEX_FEMALE, SEX_MALE } from '../state/agents';
import { ClanRegistry } from '../state/clans';
import { EventLog } from '../history/events';
import { BIOME_WATER, isWater, type World } from '../world/terrain';

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Greedy separated camp placement; relaxes separation if the map can't fit the clans. */
export function chooseCampSites(world: World, cfg: SimConfig, rng: Rng, count: number): { x: number; y: number }[] {
  const candidates: number[] = [];
  const margin = 4;
  for (let y = margin; y < world.height - margin; y++) {
    for (let x = margin; x < world.width - margin; x++) {
      const i = y * world.width + x;
      if (world.biome[i] !== BIOME_WATER && world.waterDistance[i] > 0 && world.waterDistance[i] <= cfg.init.campMaxWaterDistance) {
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
  // Inverse CDF of exp(-k a) truncated to [0, max].
  const u = rng.next();
  return -Math.log(1 - u * (1 - Math.exp(-k * max))) / k;
}

export function populate(
  world: World, cfg: SimConfig, rng: Rng, agents: AgentStore, clans: ClanRegistry,
  events: EventLog, syllables: Map<number, SyllableSet>, startEventId: number,
): void {
  const sites = chooseCampSites(world, cfg, rng, cfg.init.clanCount);
  const dpy = cfg.time.daysPerYear;
  const c = agents.cols;
  for (const site of sites) {
    const set = makeSyllableSet(rng);
    const clan = clans.create(makeClanName(rng, set), site.x, site.y, { tick: 0, parentClanId: -1, founderId: -1, eventId: -1 });
    syllables.set(clan.id, set);
    clan.founding.eventId = events.emit(0, {
      type: 'clan.founded', causes: [startEventId], x: site.x, y: site.y, clans: [clan.id],
      data: { name: clan.name, initial: true },
    });
    clan.history.push(clan.founding.eventId);

    for (let k = 0; k < cfg.init.agentsPerClan; k++) {
      const id = agents.create(makePersonName(rng, set));
      const ageDays = Math.floor(sampleInitialAgeYears(rng, cfg) * dpy);
      c.birthTick[id] = -ageDays;
      c.sex[id] = rng.chance(0.5) ? SEX_FEMALE : SEX_MALE;
      c.clanId[id] = clan.id;
      c.repState[id] = c.sex[id] === SEX_FEMALE ? REP_CYCLING : REP_NONE;
      c.energy[id] = 0.8;
      c.health[id] = 1;
      for (const g of ['gBuild', 'gRobustness', 'gFertility', 'gBoldness', 'gSociability', 'gTemper', 'gSkin', 'gHeight', 'gHair'] as const) {
        c[g][id] = clamp01(rng.normal(0.5, 0.15));
      }
      // Scatter around camp on land.
      let x = site.x;
      let y = site.y;
      for (let tries = 0; tries < 20; tries++) {
        const tx = site.x + rng.normal(0, cfg.init.startSpreadRadius);
        const ty = site.y + rng.normal(0, cfg.init.startSpreadRadius);
        if (tx >= 0 && ty >= 0 && tx < world.width && ty < world.height && !isWater(world, tx, ty)) {
          x = tx;
          y = ty;
          break;
        }
      }
      c.x[id] = x;
      c.y[id] = y;
    }
  }
}
