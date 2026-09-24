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
import { GOAL_SOCIALIZE, NO_ID, PHASE_HOME, PHASE_WORK } from '../state/agents';
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
  sim.rel.update(c.slot[a], b, t, dAff * (0.5 + c.sociability[a]) * (1 - ga) * room(aa), 0, 0, dFam);
  sim.rel.update(c.slot[b], a, t, dAff * (0.5 + c.sociability[b]) * (1 - gb) * room(ab), 0, 0, dFam);
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
  sim.rel.forEach(c.slot[a], sim.tick, (o, v) => {
    if (!c.alive[o] || c.clanId[o] !== clan || c.phase[o] !== PHASE_HOME) return;
    pickIds.push(o);
    pickVals.push(v.aff + 0.5 * v.fam);
  });
  const m = pickIds.length;
  if (m > 0) cumScratch = Rng.softmaxCumulative(pickVals, sc.nightTemperature, cumScratch);
  for (let k = 0; k < times; k++) {
    const b = m === 0 || rng.chance(sc.nightExplore) ? present[rng.int(n)] : pickIds[rng.sampleCumulative(cumScratch, m)];
    if (b !== a) contact(sim, a, b, sc.nightAffinity, sc.nightFamiliarity);
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
    for (const a of present) {
      nightContactsFor(sim, a, present, rng, sc.nightContacts);
      if (c.goal[a] === GOAL_SOCIALIZE) socialize(sim, a, present, rng);
    }
  }
}

/** Deliberate socializing: pick partners by softmax over (affinity + attraction for singles). */
function socialize(sim: Simulation, a: number, present: number[], rng: Rng): void {
  const c = sim.agents.cols;
  const sc = sim.cfg.social;
  const single = c.partnerId[a] === NO_ID && ageYears(sim, a) >= sim.cfg.life.pairMinAgeYears;
  const vals: number[] = [];
  const cands: number[] = [];
  for (const b of present) {
    if (b === a) continue;
    let v = feltAffinity(sim, a, b);
    if (single && c.sex[b] !== c.sex[a] && c.partnerId[b] === NO_ID && ageYears(sim, b) >= sim.cfg.life.pairMinAgeYears) v += sc.courtBias;
    cands.push(b);
    vals.push(v);
  }
  if (cands.length === 0) return;
  cumScratch = Rng.softmaxCumulative(vals, sc.socializeTemperature, cumScratch);
  for (let k = 0; k < sc.socializeContacts; k++) {
    const b = cands[rng.sampleCumulative(cumScratch, cands.length)];
    contact(sim, a, b, sc.socializeAffinity, sc.socializeFamiliarity);
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
  for (const a of working) {
    let met = 0;
    sim.spatial.query(c.x[a], c.y[a], sc.fieldEncounterRadius, c.x, c.y, (b) => {
      if (b <= a || met >= sc.fieldEncountersPerStep) return;
      met++;
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
  sim.rel.update(c.slot[recipient], giver, sim.tick,
    sc.giftAffinity * size * hungerBonus, sc.giftDeference * size * c.cLegGenerosity[recipient] * 4, 0, sc.giftFamiliarity * size);
}
