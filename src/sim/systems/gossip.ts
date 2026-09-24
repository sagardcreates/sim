/**
 * Information and gossip (§11). Agents remember salient events they witness
 * or hear (ring buffer of 20). During contacts, a speaker shares its 1-2 most
 * salient memories (killing > attack > theft > non-sharing > generosity);
 * the listener updates its view of the subject weighted by trust in the
 * speaker (and the speaker's standing, for leaders), fidelity drops per hop,
 * hops are limited to 3, and a small attribution-noise chance names a similar
 * wrong person (false accusations emerge; there is no lie action). Reputation
 * is therefore local. Speakers also pass on a good foraging place.
 */
import type { Simulation } from '../sim';
import type { Rng } from '../rng';
import { MEM_CAP } from '../state/mind';
import { NO_ID } from '../state/agents';

export const MEM_KILLING = 1;
export const MEM_ATTACK = 2;
export const MEM_THEFT = 3;
export const MEM_NONSHARING = 4;
export const MEM_GENEROSITY = 5;
export const MEM_NAMES = ['', 'killing', 'attack', 'theft', 'refusing to share', 'generosity'];
/** Salience by type (index = type) and valence (effect on opinion of the subject). */
const SALIENCE = [0, 4, 3, 2.5, 1.8, 1.5];
const VALENCE = [0, -1, -0.6, -0.5, -0.3, 0.4];

function salience(sim: Simulation, i: number): number {
  const m = sim.mind;
  const age = sim.tick - m.memTick[i];
  return SALIENCE[m.memType[i]] * m.memFid[i] * Math.exp(-age / sim.cfg.gossip.memoryHalfLifeDays);
}

/** Stores a memory for `id`; replaces the least salient when full. Returns false if already known. */
export function remember(
  sim: Simulation, id: number, type: number, subject: number, object: number, event: number, tick: number, hops: number, fid: number,
): boolean {
  const m = sim.mind;
  const slot = sim.agents.cols.slot[id];
  if (slot < 0) return false;
  const base = slot * MEM_CAP;
  const n = m.memCount[slot];
  for (let k = 0; k < n; k++) if (m.memEvent[base + k] === event && event > 0) return false;
  let i = base + n;
  if (n >= MEM_CAP) {
    let worst = Infinity;
    for (let k = 0; k < n; k++) {
      const s = salience(sim, base + k);
      if (s < worst) {
        worst = s;
        i = base + k;
      }
    }
  } else {
    m.memCount[slot] = n + 1;
  }
  m.memType[i] = type;
  m.memSubject[i] = subject;
  m.memObject[i] = object;
  m.memEvent[i] = event;
  m.memTick[i] = tick;
  m.memHops[i] = hops;
  m.memFid[i] = fid;
  return true;
}

/** Everyone listed witnessed an event first-hand. */
export function witness(sim: Simulation, witnesses: readonly number[], type: number, subject: number, object: number, event: number): void {
  const c = sim.agents.cols;
  for (const w of witnesses) {
    if (w === subject || !c.alive[w]) continue;
    remember(sim, w, type, subject, object, event, sim.tick, 0, 1);
  }
}

/** Speaker a shares its most salient memories with listener b. */
export function gossip(sim: Simulation, a: number, b: number, rng: Rng): void {
  const gc = sim.cfg.gossip;
  const c = sim.agents.cols;
  const m = sim.mind;
  if (!gc.enabled || !rng.chance(gc.shareProb)) return;
  const slot = c.slot[a];
  const base = slot * MEM_CAP;
  const n = m.memCount[slot];
  // Pick the top memories by salience (only those still within the hop limit).
  const top: number[] = [];
  for (let pass = 0; pass < gc.memoriesPerTalk; pass++) {
    let best = -1;
    let bestS = 0;
    for (let k = 0; k < n; k++) {
      const i = base + k;
      if (top.includes(i) || m.memHops[i] >= gc.hopLimit || m.memSubject[i] === b) continue;
      const s = salience(sim, i);
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    }
    if (best < 0) break;
    top.push(best);
  }
  // Trust in the speaker: affinity, plus the speaker's standing (leaders' word carries further).
  const trust = Math.max(0, Math.min(1.5, 0.5 + sim.rel.affinity(c.slot[b], a, sim.tick) + gc.leaderWeight * sim.statusOf(a)));
  for (const i of top) {
    let subject = m.memSubject[i];
    // Attribution noise: a similar person gets named instead.
    if (rng.chance(gc.attributionNoise)) {
      const alt = similarPerson(sim, b, subject, rng);
      if (alt !== NO_ID) subject = alt;
    }
    if (!c.alive[subject]) continue;
    const fid = m.memFid[i] * gc.fidelityDecay;
    const learned = remember(sim, b, m.memType[i], subject, m.memObject[i], m.memEvent[i], m.memTick[i], m.memHops[i] + 1, fid);
    if (!learned) continue;
    sim.stats.day.gossip++;
    const type = m.memType[i];
    const weight = gc.influence * fid * trust;
    let dGrudge = 0;
    // Hearing that someone killed one's kin (or clanmate) creates a grudge (§9: "witness/hear").
    if (type === MEM_KILLING && m.memObject[i] !== NO_ID) {
      const victim = m.memObject[i];
      const r = sim.relatedness(b, victim);
      const sameClan = c.clanId[victim] === c.clanId[b] && c.clanId[b] !== NO_ID;
      dGrudge = weight * (sim.cfg.conflict.killGrudge * r + (sameClan ? sim.cfg.conflict.witnessGrudge * 0.5 : 0));
    }
    sim.rel.update(c.slot[b], subject, sim.tick, VALENCE[type] * weight * 0.3, 0, dGrudge, 0.01);
  }
  // Place knowledge travels too (with loss).
  if (rng.chance(gc.placeShareProb)) sharePlace(sim, a, b);
}

/** A person the listener knows of the same sex and clan as `subject` (a plausible confusion). */
function similarPerson(sim: Simulation, listener: number, subject: number, rng: Rng): number {
  const c = sim.agents.cols;
  const cands: number[] = [];
  sim.rel.forEach(c.slot[listener], sim.tick, (o) => {
    if (o !== subject && c.alive[o] && c.sex[o] === c.sex[subject] && c.clanId[o] === c.clanId[subject]) cands.push(o);
  });
  return cands.length ? cands[rng.int(cands.length)] : NO_ID;
}

function sharePlace(sim: Simulation, a: number, b: number): void {
  const c = sim.agents.cols;
  const m = sim.mind;
  const pc = m.placeCap;
  const sa = c.slot[a];
  let best = -1;
  let bestQ = 0;
  for (let k = 0; k < m.placeCount[sa]; k++) {
    const q = m.placePlant[sa * pc + k] + 3 * m.placeGame[sa * pc + k];
    if (q > bestQ) {
      bestQ = q;
      best = sa * pc + k;
    }
  }
  if (best < 0) return;
  const f = sim.cfg.gossip.fidelityDecay;
  m.observePlace(c.slot[b], m.placeTile[best], m.placePlant[best] * f, m.placeGame[best] * f, m.placeTick[best]);
}
