/**
 * Evening at camp (§5 interaction resolution, §6 child cost): people who
 * carried food home Eat and Give it to kin dependents and partners.
 * Each holder allocates food in small chunks to whoever it values most at the
 * margin: weight(recipient) x hunger(recipient). Weights come from the
 * holder's own knowledge and culture: self = 1; kin dependents = 2r x
 * (1 + kinWeight); partner = partnerWeight. (Non-kin sharing arrives with the
 * camp store and sharing norms in M2.) Also updates yield memories.
 */
import type { Simulation } from '../sim';
import { NO_ID, PHASE_HOME } from '../state/agents';
import { ageYears, feed, reserveCapacity } from './common';

const CHUNK = 0.2;

export function provisionSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const l = sim.cfg.life;
  const mc = sim.cfg.metabolism;
  const rng = sim.rng.get('provision');
  const dc = sim.cfg.decision;

  // Yield memory: what today's trip brought (expected success for tomorrow).
  for (const id of sim.agents.living) {
    if (c.goal[id] === 1 /* forage */) c.forageYieldEma[id] += dc.yieldEmaRate * (c.todayYield[id] - c.forageYieldEma[id]);
    if (c.goal[id] === 2 /* hunt */ && c.todayYield[id] === 0) c.huntSuccessEma[id] *= 1 - dc.yieldEmaRate;
    if (c.goal[id] === 1 || c.goal[id] === 2) c.recentYield[id] += 0.05 * (c.todayYield[id] - c.recentYield[id]);
  }

  for (const [, members] of sim.clanMembers) {
    const present = members.filter((id) => c.phase[id] === PHASE_HOME && c.alive[id]);
    const holders = present.filter((id) => c.carriedFood[id] >= CHUNK);
    if (holders.length === 0) continue;
    rng.shuffle(holders);
    for (const h of holders) {
      // Recipient list with weights, from the holder's point of view.
      const rec: number[] = [h];
      const wts: number[] = [1];
      const kw = 1 + c.cKinWeight[h];
      const kin = sim.kin.kinOf(h);
      const rs = sim.kin.rOf(h);
      for (let k = 0; k < kin.length; k++) {
        const d = kin[k];
        if (!c.alive[d] || c.phase[d] !== PHASE_HOME || c.clanId[d] !== c.clanId[h]) continue;
        // Dependents are weighted highly; adult kin (grown children, siblings, old parents) less so.
        const dependent = ageYears(sim, d) < l.dependentUntilYears;
        rec.push(d);
        wts.push((dependent ? sim.cfg.provision.childWeight : sim.cfg.provision.adultKinWeight) * rs[k] * kw);
      }
      const p = c.partnerId[h];
      if (p !== NO_ID && c.alive[p] && c.phase[p] === PHASE_HOME && c.clanId[p] === c.clanId[h] && !rec.includes(p)) {
        rec.push(p);
        wts.push(sim.cfg.provision.partnerWeight);
      }
      allocate(sim, h, rec, wts);
    }
    campStore(sim, present, holders, rng);
  }
  void mc;
}

/**
 * Camp store (§3): holders Give a share of their surplus (beyond a day's
 * reserve) according to their own sharing norm; hungry members present then
 * Take what they need, in shuffled order, while it lasts.
 */
function campStore(sim: Simulation, present: number[], holders: number[], rng: import('../rng').Rng): void {
  const c = sim.agents.cols;
  const clan = sim.clans.get(c.clanId[present[0]]);
  if (!clan) return;
  const mc = sim.cfg.metabolism;
  for (const h of holders) {
    const surplus = c.carriedFood[h] - sim.cfg.provision.keepReserveDays * mc.adultNeed;
    if (surplus <= 0) continue;
    const give = surplus * c.cSharing[h];
    c.carriedFood[h] -= give;
    clan.foodStore += give;
    sim.stats.day.stored += give;
  }
  if (clan.foodStore < CHUNK) return;
  const takers = present.filter((id) => c.energy[id] < mc.eatTargetEnergy);
  rng.shuffle(takers);
  for (const id of takers) {
    if (clan.foodStore < CHUNK) break;
    const eff = efficiency(sim, id);
    const want = (mc.eatTargetEnergy - c.energy[id]) * reserveCapacity(sim, id) / eff;
    const used = feed(sim, id, Math.min(want, clan.foodStore), eff);
    clan.foodStore -= used;
    sim.stats.day.taken += used;
  }
}

/** Nursing infants digest adult food poorly; efficiency rises to 1 by weaning age. */
function efficiency(sim: Simulation, id: number): number {
  const a = ageYears(sim, id);
  const w = sim.cfg.life.weaningAgeYears;
  return a >= w ? 1 : Math.max(0.3, a / w);
}

function allocate(sim: Simulation, h: number, rec: number[], wts: number[]): void {
  const c = sim.agents.cols;
  const target = sim.cfg.metabolism.eatTargetEnergy;
  const n = rec.length;
  const caps = rec.map((id) => reserveCapacity(sim, id));
  const effs = rec.map((id) => efficiency(sim, id));
  while (c.carriedFood[h] >= CHUNK) {
    let best = -1;
    let bestV = 0;
    for (let k = 0; k < n; k++) {
      const e = c.energy[rec[k]];
      if (e >= target) continue;
      const v = wts[k] * (1 - e) * (1 - e) * effs[k];
      if (v > bestV) {
        bestV = v;
        best = k;
      }
    }
    if (best < 0) break;
    const id = rec[best];
    const used = feed(sim, id, CHUNK, effs[best]);
    if (used <= 0) break;
    c.carriedFood[h] -= used;
    if (id !== h) {
      sim.stats.day.given += used;
    }
    void caps;
  }
}
