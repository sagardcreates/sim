/**
 * Legible motives for play mode: what a person wants right now, in plain
 * words, read straight from their state (energy, wounds, grudges, ties,
 * clan loyalty, their last decision's "why" terms). Read-only.
 */
import type { Simulation } from '../sim';
import {
  GOAL_AVENGE, GOAL_CARE, GOAL_CARRIED, GOAL_FOLLOW, GOAL_FORAGE, GOAL_HUNT, GOAL_REST, GOAL_SOCIALIZE, NO_ID,
  PHASE_HOME, PHASE_RETURN, REP_LACTATING, REP_PREGNANT,
} from '../state/agents';
import { ageYears, isAlive } from '../systems/common';
import { loyalty, LONER } from '../systems/clans';
import { WHY_LABELS } from '../systems/decision';
import { isPlayer, needsTending, topGrudge, type HelpVerb } from './player';

import {
  M_AMBITION, M_DRIFTER, M_HUNGRY, M_HURT, M_KIDS_HUNGRY, M_LEADER, M_LONELY, M_NONE, M_PARTNER, M_REVENGE, M_SICK, M_UNHAPPY,
} from './motive-codes';

export * from './motive-codes';

export interface Motive {
  code: number;
  text: string;
  /** The help that answers it, if any. */
  verb?: HelpVerb;
}

function hungryKids(sim: Simulation, id: number): boolean {
  const c = sim.agents.cols;
  for (const k of sim.pedigree.childrenOf(id)) {
    if (c.alive[k] && ageYears(sim, k) < sim.cfg.life.independentAgeYears && c.energy[k] < 0.45) return true;
  }
  return false;
}

function tieCount(sim: Simulation, id: number): number {
  const c = sim.agents.cols;
  let n = 0;
  sim.rel.forEach(c.slot[id], sim.tick, (o, v) => {
    if (v.aff > 0.25 && c.alive[o]) n++;
  });
  return n;
}

/** Everything that currently moves this person, most pressing first. */
export function motivesOf(sim: Simulation, id: number): Motive[] {
  const c = sim.agents.cols;
  const out: Motive[] = [];
  if (!isAlive(sim, id) || isPlayer(sim, id)) return out;
  const age = ageYears(sim, id);
  const clan = c.clanId[id];
  if (clan >= 0 && sim.leaders.get(clan) === id) out.push({ code: M_LEADER, text: `leads ${sim.clans.get(clan)?.name ?? 'their clan'}; guards their people` });
  if (c.energy[id] < 0.45) out.push({ code: M_HUNGRY, text: c.energy[id] < 0.2 ? 'is starving' : 'is hungry', verb: 'give' });
  if (age >= 16 && hungryKids(sim, id)) out.push({ code: M_KIDS_HUNGRY, text: 'their children are going hungry', verb: 'give' });
  if (c.injury[id] > 0.05) out.push({ code: M_HURT, text: 'is nursing a wound', verb: 'tend' });
  else if (needsTending(sim, id)) out.push({ code: M_SICK, text: c.infectedUntil[id] > sim.tick ? 'is sick with fever' : 'is weak and unwell', verb: 'tend' });
  const g = topGrudge(sim, id);
  if (g.other !== NO_ID) out.push({ code: M_REVENGE, text: `wants revenge on ${sim.agents.displayName(g.other)}`, verb: 'back' });
  if (age >= 16) {
    if (clan === LONER) out.push({ code: M_DRIFTER, text: 'wanders alone, without a clan' });
    else if (loyalty(sim, id) < sim.cfg.play.unhappyLoyalty) out.push({ code: M_UNHAPPY, text: `has few ties in ${sim.clans.get(clan)?.name ?? 'their clan'}` });
    if (tieCount(sim, id) < 2) out.push({ code: M_LONELY, text: 'has few friends', verb: 'talk' });
    if (!isAlive(sim, c.partnerId[id]) && age >= sim.cfg.life.pairMinAgeYears && age < 45) out.push({ code: M_PARTNER, text: 'is looking for a partner' });
    if (clan >= 0 && sim.leaders.get(clan) !== id && c.boldness[id] > 0.65 && sim.statusOf(id) > 0.08) out.push({ code: M_AMBITION, text: 'has a following of their own' });
  }
  return out;
}

/** Primary motive code (for the floating icon), preferring the ones the player can help with. */
export function primaryMotive(sim: Simulation, id: number): number {
  const ms = motivesOf(sim, id);
  const helpable = ms.find((m) => m.verb);
  return (helpable ?? ms[0])?.code ?? M_NONE;
}

/** What they are doing, in words. */
export function doingText(sim: Simulation, id: number): string {
  const c = sim.agents.cols;
  const home = c.phase[id] === PHASE_HOME;
  const back = c.phase[id] === PHASE_RETURN;
  switch (c.goal[id]) {
    case GOAL_FORAGE: return back ? 'heading home with gathered food' : home ? 'resting after gathering' : 'out gathering plants';
    case GOAL_HUNT: return c.partyLeader[id] !== NO_ID ? 'hunting with a party' : back ? 'returning from the hunt' : 'hunting';
    case GOAL_CARE: return 'looking after the children at camp';
    case GOAL_FOLLOW: return 'following a parent to learn';
    case GOAL_CARRIED: return 'being carried';
    case GOAL_SOCIALIZE: return 'visiting friends';
    case GOAL_AVENGE: return 'stalking someone they hate';
    case GOAL_REST:
    default:
      if (c.repState[id] === REP_PREGNANT) return 'resting (pregnant)';
      if (c.repState[id] === REP_LACTATING) return 'resting with a baby';
      return 'resting at camp';
  }
}

/** Their reasons for today's choice (top decision terms), in words. */
export function whyText(sim: Simulation, id: number): string[] {
  const c = sim.agents.cols;
  const slot = c.slot[id];
  if (slot < 0) return [];
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const t = sim.mind.whyTerm[slot * 3 + k];
    if (t) out.push(WHY_LABELS[t]);
  }
  return out;
}

/** How they feel about the player, in words. */
export function feelingText(sim: Simulation, id: number, player: number): { text: string; aff: number; def: number; grudge: number } {
  const c = sim.agents.cols;
  const v = sim.rel.get(c.slot[id], player, sim.tick);
  const aff = v?.aff ?? 0;
  const def = v?.def ?? 0;
  const grudge = v?.grudge ?? 0;
  let text: string;
  if (!v) text = 'has never met you';
  else if (grudge > 0.35 || aff < -0.35) text = 'hates you';
  else if (aff < -0.1) text = 'distrusts you';
  else if (aff > 0.7) text = 'counts you a close friend';
  else if (aff > 0.35) text = 'likes you';
  else if (aff > 0.1) text = 'is warming to you';
  else text = 'barely knows you';
  if (def > 0.3 && grudge < 0.2) text += ', and looks up to you';
  return { text, aff, def, grudge };
}
