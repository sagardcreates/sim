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
import { onGift } from './social';

const CHUNK = 0.2;
/** Per-agent stamp to test "already a recipient" in O(1). */
let stamp = new Int32Array(1024);
let stampNow = 0;
const friendIds: number[] = [];
const friendAff: number[] = [];

export function provisionSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const l = sim.cfg.life;
  const mc = sim.cfg.metabolism;
  const rng = sim.rng.get('provision');
  const dc = sim.cfg.decision;

  // Yield memory: what today's trip brought (expected success for tomorrow).
  const keep = 1 - 1 / sim.cfg.social.contributionEmaDays;
  for (const id of sim.agents.living) {
    c.givenEma[id] *= keep;
    c.takenEma[id] *= keep;
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
      if (stamp.length < sim.agents.count) stamp = new Int32Array(sim.agents.count * 2);
      stampNow++;
      const rec: number[] = [h];
      const wts: number[] = [1];
      stamp[h] = stampNow;
      const kw = 1 + c.cKinWeight[h];
      const kin = sim.kin.kinOf(h);
      const rs = sim.kin.rOf(h);
      for (let k = 0; k < kin.length; k++) {
        const d = kin[k];
        if (!c.alive[d] || c.phase[d] !== PHASE_HOME || c.clanId[d] !== c.clanId[h]) continue;
        // Dependents are weighted highly; adult kin (grown children, siblings, old parents) less so.
        const dependent = ageYears(sim, d) < l.dependentUntilYears;
        stamp[d] = stampNow;
        rec.push(d);
        wts.push((dependent ? sim.cfg.provision.childWeight : sim.cfg.provision.adultKinWeight) * rs[k] * kw);
      }
      const p = c.partnerId[h];
      if (p !== NO_ID && c.alive[p] && c.phase[p] === PHASE_HOME && c.clanId[p] === c.clanId[h] && stamp[p] !== stampNow) {
        stamp[p] = stampNow;
        rec.push(p);
        wts.push(sim.cfg.provision.partnerWeight);
      }
      // Closest friends here (affinity above a minimum), weighted by the holder's own sharing norm.
      if (c.clanId[h] >= 0) {
        const fw = sim.cfg.social.friendWeight * c.cSharing[h];
        friendIds.length = 0;
        friendAff.length = 0;
        sim.rel.forEach(c.slot[h], sim.tick, (o, v) => {
          if (v.aff <= sim.cfg.social.friendMinAffinity || !c.alive[o] || c.phase[o] !== PHASE_HOME || c.clanId[o] !== c.clanId[h] || stamp[o] === stampNow) return;
          friendIds.push(o);
          friendAff.push(v.aff);
        });
        const order = friendIds.map((_, k) => k).sort((a, b) => friendAff[b] - friendAff[a] || friendIds[a] - friendIds[b]);
        for (const k of order.slice(0, sim.cfg.social.maxFriendRecipients)) {
          stamp[friendIds[k]] = stampNow;
          rec.push(friendIds[k]);
          wts.push(fw * friendAff[k]);
        }
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
  const sc = sim.cfg.social;
  const ema = 1 / sc.contributionEmaDays;
  for (const h of holders) {
    const surplus = c.carriedFood[h] - sim.cfg.provision.keepReserveDays * mc.adultNeed;
    if (surplus <= 0) continue;
    const give = surplus * c.cSharing[h];
    c.carriedFood[h] -= give;
    clan.foodStore += give;
    c.givenEma[h] += ema * give;
    sim.stats.day.stored += give;
    // Onlookers notice generosity.
    for (let k = 0; k < sc.depositWitnesses; k++) {
      const wit = present[rng.int(present.length)];
      if (wit !== h) onGift(sim, h, wit, give * sc.depositAffinity / Math.max(sc.giftAffinity, 1e-9), c.energy[wit]);
    }
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
    c.takenEma[id] += ema * used;
    sim.stats.day.taken += used;
    judgeTaking(sim, id, present, rng);
  }
}

/**
 * Take from the store is judged by onlookers' own norms (§5: theft "when
 * onlookers' norms judge it so"): an able adult who takes far more than they
 * give angers onlookers in proportion to the onlooker's sharing norm.
 */
function judgeTaking(sim: Simulation, id: number, present: number[], rng: import('../rng').Rng): void {
  const c = sim.agents.cols;
  const sc = sim.cfg.social;
  const age = ageYears(sim, id);
  if (age < sim.cfg.life.adultAgeYears || age > 55 || c.health[id] < 0.6 || c.injury[id] > 0.2) return;
  if (c.takenEma[id] < sc.freeRideThreshold * (c.givenEma[id] + 0.05)) return;
  let judged = 0;
  for (let k = 0; k < sc.freeRideWitnesses; k++) {
    const wit = present[rng.int(present.length)];
    if (wit === id || c.cSharing[wit] < 0.5) continue;
    sim.rel.update(c.slot[wit], id, sim.tick, -sc.freeRideJudgement * c.cSharing[wit], 0, 0, 0.01);
    judged++;
  }
  if (judged > 0) {
    sim.stats.day.freeRiding++;
    sim.events.emit(sim.tick, { type: 'food.freeriding', causes: [], agents: [id], clans: [c.clanId[id]], data: { judges: judged } });
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
  const effs = rec.map((id) => efficiency(sim, id));
  const given = new Float64Array(n);
  const before = rec.map((id) => c.energy[id]);
  while (c.carriedFood[h] >= CHUNK) {
    // Bigger chunks when carrying a lot (<= ~20 rounds); same marginal rule.
    const chunk = Math.max(CHUNK, c.carriedFood[h] * 0.05);
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
    const used = feed(sim, id, Math.min(chunk, c.carriedFood[h]), effs[best]);
    if (used <= 0) break;
    c.carriedFood[h] -= used;
    given[best] += used;
  }
  // Give: each recipient registers the gift once (relationship update), children included.
  let total = 0;
  for (let k = 1; k < n; k++) {
    if (given[k] <= 0) continue;
    total += given[k];
    onGift(sim, h, rec[k], given[k], before[k]);
  }
  sim.stats.day.given += total;
  const ema = 1 / sim.cfg.social.contributionEmaDays;
  c.givenEma[h] += ema * total;
}
