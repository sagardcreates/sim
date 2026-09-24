/**
 * Social fabric (§7): relationship updates from contact.
 *  - Night at camp: everyone present has a few casual contacts around the fire.
 *  - Socialize (daily goal): more contacts, preferring people one already likes
 *    or finds attractive (courtship happens through this).
 *  - Field encounters: foragers working near each other (any clan) get to know
 *    each other; this is how cross-clan ties form.
 *  - Gifts: receiving food raises affinity (more if hungry) and deference to
 *    generous givers.
 * Kinship is never stored: effective affinity adds kinWeight x r on read.
 */
import type { Simulation } from '../sim';
import { Rng } from '../rng';
import { GOAL_AVENGE, GOAL_SOCIALIZE, NO_ID, PHASE_HOME, PHASE_RETURN, PHASE_WORK } from '../state/agents';
import { confront, revengeMotive } from './conflict';
import { obliqueLearning } from './culture';
import { gossip, MEM_GENEROSITY, MEM_THEFT, witness } from './gossip';
import { ageYears } from './common';

/** Mutual contact between a and b (both entries updated). */
export function contact(sim: Simulation, a: number, b: number, dAff: number, dFam: number): void {
  const c = sim.agents.cols;
  const t = sim.tick;
  // Warmth depends on each side's sociability and on existing grudges.
  const va = sim.rel.get(c.slot[a], b, t);
  const ga = va?.grudge ?? 0;
  const aa = va?.aff ?? 0;
  const vb = sim.rel.get(c.slot[b], a, t);
  const gb = vb?.grudge ?? 0;
  const ab = vb?.aff ?? 0;
  // Diminishing returns as a tie approaches its maximum.
  const room = (x: number) => (dAff > 0 ? 1 - Math.max(0, x) : 1);
  // Friendly time together slowly eases grudges (a feud exit).
  const ease = dAff > 0 ? -sim.cfg.conflict.contactGrudgeReduction * dAff : 0;
  sim.rel.update(c.slot[a], b, t, dAff * (0.5 + c.sociability[a]) * (1 - ga) * room(aa), 0, ease, dFam);
  sim.rel.update(c.slot[b], a, t, dAff * (0.5 + c.sociability[b]) * (1 - gb) * room(ab), 0, ease, dFam);
}

/**
 * Whom to spend time with tonight: mostly someone from one's own relationship
 * map who is here (liked / familiar), sometimes anyone present. The candidate
 * list is built once per person per night.
 */
function nightContactsFor(sim: Simulation, a: number, present: number[], rng: Rng, times: number): void {
  const sc = sim.cfg.social;
  const c = sim.agents.cols;
  const n = present.length;
  const clan = c.clanId[a];
  pickIds.length = 0;
  pickVals.length = 0;
  const rel = sim.rel;
  const base = c.slot[a] * rel.cap;
  const end = base + rel.count[c.slot[a]];
  for (let e = base; e < end; e++) {
    const o = rel.other[e];
    if (!c.alive[o] || c.clanId[o] !== clan || c.phase[o] !== PHASE_HOME) continue;
    pickIds.push(o);
    pickVals.push(rel.affAt(e, sim.tick) + 0.5 * rel.famAt(e, sim.tick));
  }
  const m = pickIds.length;
  if (m > 0) cumScratch = Rng.softmaxCumulative(pickVals, sc.nightTemperature, cumScratch);
  for (let k = 0; k < times; k++) {
    const b = m === 0 || rng.chance(sc.nightExplore) ? present[rng.int(n)] : pickIds[rng.sampleCumulative(cumScratch, m)];
    if (b === a || !c.alive[a] || !c.alive[b]) continue;
    const motive = revengeMotive(sim, a, b);
    if (motive > 0 && rng.chance(sim.cfg.conflict.grudgeEncounterRate * motive * 0.5 * sc.nightStaggerDays)) {
      confront(sim, a, b, 'grudge', motive, []);
      continue;
    }
    // Staggered: effects scaled so expected tie growth per day is unchanged.
    contact(sim, a, b, sc.nightAffinity * sc.nightStaggerDays, sc.nightFamiliarity * sc.nightStaggerDays);
    gossip(sim, a, b, rng);
    gossip(sim, b, a, rng);
  }
}
let cumScratch: Float64Array = new Float64Array(256);
const pickIds: number[] = [];
const pickVals: number[] = [];


/** Affinity of a toward b as a feels it: stored affinity + kin boost (kinship computed, never stored). */
export function feltAffinity(sim: Simulation, a: number, b: number): number {
  const c = sim.agents.cols;
  const base = sim.rel.affinity(c.slot[a], b, sim.tick);
  const r = sim.relatedness(a, b);
  return Math.max(-1, Math.min(1, base + sim.cfg.social.kinAffinityBoost * c.cKinWeight[a] * r));
}

/** Night at camp: casual contacts, plus Socialize-goal agents' deliberate ones. */
export function nightSocialSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const sc = sim.cfg.social;
  const rng = sim.rng.get('social');
  for (const [clanId, members] of sim.clanMembers) {
    if (clanId < 0) continue; // loners have no shared fire
    const present = members.filter((id) => c.alive[id] && c.phase[id] === PHASE_HOME && ageYears(sim, id) >= 3);
    const n = present.length;
    if (n < 2) continue;
    const stagger = sc.nightStaggerDays;
    for (const a of present) {
      if ((a + sim.tick) % stagger === 0) nightContactsFor(sim, a, present, rng, sc.nightContacts);
      if (c.goal[a] === GOAL_SOCIALIZE) socialize(sim, a, present, rng);
    }
  }
}

/**
 * Deliberate socializing: partners chosen by softmax over felt affinity among
 * people one knows who are here; single adults also consider eligible singles
 * present (courtship).
 */
function socialize(sim: Simulation, a: number, present: number[], rng: Rng): void {
  const c = sim.agents.cols;
  const sc = sim.cfg.social;
  const single = c.partnerId[a] === NO_ID && ageYears(sim, a) >= sim.cfg.life.pairMinAgeYears;
  const vals: number[] = [];
  const cands: number[] = [];
  const seen = new Set<number>();
  const rel = sim.rel;
  const base = c.slot[a] * rel.cap;
  const end = base + rel.count[c.slot[a]];
  const eligible = (b: number) => c.sex[b] !== c.sex[a] && c.partnerId[b] === NO_ID && ageYears(sim, b) >= sim.cfg.life.pairMinAgeYears;
  for (let e = base; e < end; e++) {
    const b = rel.other[e];
    if (!c.alive[b] || c.phase[b] !== PHASE_HOME || c.clanId[b] !== c.clanId[a]) continue;
    seen.add(b);
    cands.push(b);
    vals.push(rel.affAt(e, sim.tick) + sim.cfg.social.kinAffinityBoost * c.cKinWeight[a] * sim.relatedness(a, b) + (single && eligible(b) ? sc.courtBias : 0));
  }
  if (single) {
    for (const b of present) {
      if (b === a || seen.has(b) || !eligible(b)) continue;
      cands.push(b);
      vals.push(sc.courtBias);
    }
  }
  if (cands.length === 0) {
    if (present.length > 1) {
      const b = present[rng.int(present.length)];
      if (b !== a) contact(sim, a, b, sc.socializeAffinity, sc.socializeFamiliarity);
    }
    return;
  }
  cumScratch = Rng.softmaxCumulative(vals, sc.socializeTemperature, cumScratch);
  for (let k = 0; k < sc.socializeContacts; k++) {
    const b = cands[rng.sampleCumulative(cumScratch, cands.length)];
    contact(sim, a, b, sc.socializeAffinity, sc.socializeFamiliarity);
    gossip(sim, a, b, rng);
    gossip(sim, b, a, rng);
    obliqueLearning(sim, a, b, rng);
  }
}

/** Field encounters among agents working near each other (any clan). Called per sub-step. */
export function fieldEncounters(sim: Simulation, rng: Rng): void {
  const c = sim.agents.cols;
  const sc = sim.cfg.social;
  const working: number[] = [];
  for (const id of sim.agents.living) if (c.phase[id] === PHASE_WORK) working.push(id);
  if (working.length < 2) return;
  sim.spatial.build(working, c.x, c.y);
  rng.shuffle(working);
  const k = sim.cfg.conflict;
  const w = sim.world;
  for (const a of working) {
    let met = 0;
    sim.spatial.query(c.x[a], c.y[a], sc.fieldEncounterRadius, c.x, c.y, (b) => {
      if (b === a || met >= sc.fieldEncountersPerStep || !c.alive[a] || !c.alive[b]) return;
      met++;
      // Revenge on sight (an ambush if the target has no allies nearby).
      const motive = revengeMotive(sim, a, b);
      const seeking = c.goal[a] === GOAL_AVENGE ? 2 : 1;
      if (motive > 0 && rng.chance(Math.min(1, k.grudgeEncounterRate * motive * seeking))) {
        confront(sim, a, b, 'grudge', motive, []);
        return;
      }
      if (b <= a) return;
      const ta = Math.floor(c.y[a]) * w.width + Math.floor(c.x[a]);
      const tb = Math.floor(c.y[b]) * w.width + Math.floor(c.x[b]);
      const hungerA = 1 - c.energy[a];
      const related = sim.relatedness(a, b) >= 0.125;
      // Contested patch: scarce food on the same tile, hungry non-kin.
      if (!related && ta === tb && w.plantFood[ta] < k.foodContestScarcity * w.plantCapacity[ta] && hungerA > k.foodContestMinHunger
        && rng.chance(k.foodContestRate * hungerA)) {
        const res = confront(sim, a, b, 'food', hungerA, []);
        if (res.winner !== NO_ID) {
          // The loser leaves the patch today.
          c.phase[res.loser] = PHASE_RETURN;
        }
        return;
      }
      // Opportunistic Take from someone carrying food (theft when the victim sees it so).
      if (!related && c.carriedFood[b] > k.theftMinCarry && sim.rel.affinity(c.slot[a], b, sim.tick) < 0.1
        && rng.chance(k.theftRate * hungerA * c.boldness[a] * 2)) {
        const amount = c.carriedFood[b] * 0.5;
        const ev = sim.events.emit(sim.tick, { type: 'food.theft', causes: [], agents: [a, b], clans: [c.clanId[a], c.clanId[b]], x: c.x[a], y: c.y[a], data: { amount: Math.round(amount * 10) / 10 } });
        sim.stats.day.thefts++;
        witness(sim, [b], MEM_THEFT, a, b, ev);
        c.carriedFood[b] -= amount;
        c.carriedFood[a] += amount;
        sim.rel.update(c.slot[b], a, sim.tick, -0.15, 0, 0.2, 0.05);
        c.anger[b] = Math.min(1, c.anger[b] + 0.4);
        c.angerTarget[b] = a;
        c.fear[b] = Math.min(1, c.fear[b] + 0.1);
        const res = confront(sim, b, a, 'theft', amount / 5, [ev]);
        if (res.winner === b && c.alive[a]) {
          const back = Math.min(amount, c.carriedFood[a]);
          c.carriedFood[a] -= back;
          c.carriedFood[b] += back;
        }
        return;
      }
      contact(sim, a, b, sc.fieldEncounterAffinity, sc.fieldEncounterFamiliarity);
      sim.stats.day.encounters++;
      if (c.clanId[a] !== c.clanId[b]) sim.stats.day.crossClanEncounters++;
    });
  }
}

/** Receiving food: recipient warms to the giver (more when hungry) and defers a little to generosity. */
export function onGift(sim: Simulation, giver: number, recipient: number, units: number, recipientEnergyBefore: number): void {
  if (giver === recipient) return;
  const c = sim.agents.cols;
  const sc = sim.cfg.social;
  const need = sim.cfg.metabolism.adultNeed;
  const size = Math.min(1, units / need);
  const hungerBonus = 1 + sc.giftHungerBonus * (1 - recipientEnergyBefore) * 4;
  if (units >= sim.cfg.metabolism.adultNeed && recipientEnergyBefore < 0.5) {
    witness(sim, [recipient], MEM_GENEROSITY, giver, recipient, 0);
  }
  sim.rel.update(c.slot[recipient], giver, sim.tick,
    sc.giftAffinity * size * hungerBonus, sc.giftDeference * size * c.cLegGenerosity[recipient] * 4,
    -sim.cfg.conflict.giftGrudgeReduction * size, sc.giftFamiliarity * size);
}
