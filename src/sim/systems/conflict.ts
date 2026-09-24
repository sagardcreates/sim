/**
 * Conflict (§9): an escalation ladder with an exit at every step.
 *   ignore -> Threaten -> Attack (injury likely, death rare) -> lethal intent (death likely)
 * The other party may back down (Flee/submit) at each step. Escalation
 * probability comes from anger, temper, strength asymmetry, nearby allies,
 * violenceTolerance and stakes. Allies within reach may join, choosing sides
 * by affinity, kinship and deference. Nothing here is a scripted "feud" or
 * "coup": those are historian labels over these primitive events.
 *
 * Contexts: 'food' (contested patch), 'theft' (resisting a Take), 'grudge'
 * (revenge on sight; ambush if the target is alone), 'challenge' (leadership).
 */
import type { Simulation } from '../sim';
import type { Rng } from '../rng';
import { CAUSE_VIOLENCE, NO_ID } from '../state/agents';
import { ageYears, isAlive, strength } from './common';
import { killAgent } from './mortality';
import { MEM_ATTACK, MEM_KILLING, witness } from './gossip';

export type ConflictContext = 'food' | 'theft' | 'grudge' | 'challenge' | 'norm';

export interface ConflictOutcome {
  level: number; // 0 ignored, 1 threat, 2 attack, 3 lethal
  winner: number;
  loser: number;
  killed: number;
  eventId: number;
}

/** Anger/grudge a feels toward b (grudge is persistent, anger is a fast mood with a target). */
function hostility(sim: Simulation, a: number, b: number): number {
  const c = sim.agents.cols;
  const g = sim.rel.get(c.slot[a], b, sim.tick)?.grudge ?? 0;
  const anger = c.angerTarget[a] === b ? c.anger[a] : 0;
  return g + anger;
}

/** Probability that `x` escalates to `level` against `y`. */
function escalateProb(sim: Simulation, x: number, y: number, level: number, stakes: number, alliesX: number, alliesY: number, ctx: ConflictContext): number {
  const c = sim.agents.cols;
  const k = sim.cfg.conflict;
  const powX = strength(sim, x) * (1 + alliesX);
  const powY = strength(sim, y) * (1 + alliesY);
  const z = k.wTemper * c.temper[x] + k.wAnger * hostility(sim, x, y) + k.wViolenceTolerance * c.cViolence[x]
    + k.wStakes * stakes + k.wPower * Math.log(powX / Math.max(1e-6, powY)) + k.wBold * c.boldness[x]
    - k.wFear * c.fear[x] - k.levelCost[level] + (ctx === 'challenge' ? k.challengeBonus : 0);
  return 1 / (1 + Math.exp(-z / k.temperature));
}

/** Allies within reach who join a side (affinity, kin, deference); returns combined helper strength per side. */
function gatherAllies(sim: Simulation, a: number, b: number, rng: Rng): { a: number[]; b: number[] } {
  const c = sim.agents.cols;
  const k = sim.cfg.conflict;
  const out = { a: [] as number[], b: [] as number[] };
  sim.spatialConflict.build(sim.agents.living, c.x, c.y);
  sim.spatialConflict.query(c.x[a], c.y[a], k.allyRadius, c.x, c.y, (w) => {
    if (w === a || w === b || !c.alive[w] || ageYears(sim, w) < sim.cfg.life.independentAgeYears) return;
    const side = (x: number) => {
      const v = sim.rel.get(c.slot[w], x, sim.tick);
      return (v ? v.aff + v.def - v.grudge : 0) + sim.relatedness(w, x) * c.cKinWeight[w];
    };
    const sa = side(a);
    const sb = side(b);
    const pref = Math.max(sa, sb);
    if (pref < k.allyThreshold || !rng.chance(Math.min(0.9, (pref - k.allyThreshold) * k.allyJoinRate * (1 - c.fear[w])))) return;
    (sa >= sb ? out.a : out.b).push(w);
  });
  return out;
}

/**
 * Runs a confrontation initiated by `a` against `b`. Returns what happened.
 * All effects are applied here: deference, fear, grudges, injuries, deaths, events.
 */
export function confront(sim: Simulation, a: number, b: number, ctx: ConflictContext, stakes: number, causes: number[]): ConflictOutcome {
  const c = sim.agents.cols;
  const k = sim.cfg.conflict;
  const rng = sim.rng.get('conflict');
  const none: ConflictOutcome = { level: 0, winner: NO_ID, loser: NO_ID, killed: NO_ID, eventId: -1 };
  if (!isAlive(sim, a) || !isAlive(sim, b) || a === b) return none;
  // One confrontation per person per day.
  if (c.lastConflictTick[a] === sim.tick || c.lastConflictTick[b] === sim.tick) return none;
  c.lastConflictTick[a] = sim.tick;
  c.lastConflictTick[b] = sim.tick;
  const allies = gatherAllies(sim, a, b, rng);
  const alliesA = allies.a.reduce((s, w) => s + strength(sim, w), 0);
  const alliesB = allies.b.reduce((s, w) => s + strength(sim, w), 0);
  const ambush = ctx === 'grudge' && allies.b.length === 0;

  // Level 1: Threaten (or ignore).
  if (!rng.chance(escalateProb(sim, a, b, 1, stakes, alliesA, alliesB, ctx))) return none;
  const threatEv = sim.events.emit(sim.tick, {
    type: 'conflict.threat', causes, agents: [a, b, ...allies.a, ...allies.b], clans: [c.clanId[a], c.clanId[b]],
    x: c.x[a], y: c.y[a], data: { context: ctx, alliesA: allies.a.length, alliesB: allies.b.length },
  });
  sim.stats.day.threats++;
  // b stands firm or backs down.
  if (!rng.chance(escalateProb(sim, b, a, 1, stakes, alliesB, alliesA, ctx))) {
    return settle(sim, a, b, 1, threatEv, allies, ctx, NO_ID);
  }
  // Level 2: Attack (either may still back off; initiator decides first).
  if (!rng.chance(escalateProb(sim, a, b, 2, stakes, alliesA, alliesB, ctx))) {
    // a backs down: b wins the standoff.
    return settle(sim, b, a, 1, threatEv, { a: allies.b, b: allies.a }, ctx, NO_ID);
  }
  const powA = strength(sim, a) * (1 + alliesA) * (ambush ? k.ambushPowerBonus : 1);
  const powB = strength(sim, b) * (1 + alliesB);
  const aWins = rng.chance(powA / (powA + powB));
  const winner = aWins ? a : b;
  const loser = aWins ? b : a;
  const ratio = (aWins ? powA / powB : powB / powA);
  const sev = Math.min(1, k.attackInjury * (0.5 + rng.next()) * Math.sqrt(ratio));
  c.injury[loser] = Math.min(1, c.injury[loser] + sev);
  c.injuryCause[loser] = CAUSE_VIOLENCE;
  c.injuredBy[loser] = winner;
  c.injury[winner] = Math.min(1, c.injury[winner] + sev * k.winnerInjuryFraction * rng.next());
  const attackEv = sim.events.emit(sim.tick, {
    type: 'conflict.attack', causes: [threatEv], agents: [a, b], clans: [c.clanId[a], c.clanId[b]], x: c.x[a], y: c.y[a],
    data: { context: ctx, winner, severity: Math.round(sev * 100) / 100, ambush },
  });
  c.injuryEventId[loser] = attackEv;
  sim.stats.day.attacks++;
  witness(sim, [loser, ...allies.a, ...allies.b, ...nearby(sim, a)], MEM_ATTACK, winner, loser, attackEv);
  // Level 3: lethal intent by the winner (death likely), else the loser flees.
  let killed = NO_ID;
  const lethal = escalateProb(sim, winner, loser, 3, stakes, aWins ? alliesA : alliesB, aWins ? alliesB : alliesA, ctx);
  if (rng.chance(lethal)) {
    const pDeath = Math.min(0.95, k.lethalDeath + (ambush ? k.ambushLethalBonus : 0));
    if (rng.chance(pDeath)) killed = loser;
  } else if (sev > k.deathFromAttackSeverity && rng.chance(k.deathFromAttack)) {
    killed = loser;
  }
  return settle(sim, winner, loser, killed !== NO_ID ? 3 : 2, attackEv, aWins ? allies : { a: allies.b, b: allies.a }, ctx, killed);
}

/** Applies consequences of a settled contest (winner/loser, witnesses, grudges, death). */
function settle(
  sim: Simulation, winner: number, loser: number, level: number, eventId: number,
  allies: { a: number[]; b: number[] }, ctx: ConflictContext, killed: number,
): ConflictOutcome {
  const c = sim.agents.cols;
  const k = sim.cfg.conflict;
  const t = sim.tick;
  // Loser defers to the winner (by the loser's own weight on strength) and fears them;
  // being attacked (not merely out-faced) also leaves a grudge.
  const grudge = level >= 2 ? k.loserGrudge * level : 0;
  sim.rel.update(c.slot[loser], winner, t, -k.loserAffinityLoss * level, k.loserDeference * c.cLegStrength[loser] * 4, grudge, 0.05);
  // Revenge taken eases the avenger's grudge.
  if (ctx === 'grudge') sim.rel.update(c.slot[winner], loser, t, 0, 0, -0.5 * (sim.rel.get(c.slot[winner], loser, t)?.grudge ?? 0), 0);
  c.fear[loser] = Math.min(1, c.fear[loser] + k.fearGain * level);
  c.contestWins[winner] += 1;
  // Witnesses nearby shift deference toward the winner (weaker than the loser's).
  sim.spatialConflict.query(c.x[winner], c.y[winner], k.witnessRadius, c.x, c.y, (w) => {
    if (w === winner || w === loser || !c.alive[w]) return;
    sim.rel.update(c.slot[w], winner, t, 0, k.witnessDeference * c.cLegStrength[w] * 4, 0, 0.02);
  });
  if (level >= 2) for (const al of allies.b) sim.rel.update(c.slot[al], winner, t, -k.loserAffinityLoss, 0, k.loserGrudge * 0.5, 0);
  if (level >= 2) sim.stats.day.contests++;
  if (killed !== NO_ID) {
    const deathEv = killAgent(sim, killed, CAUSE_VIOLENCE, [eventId], [ctx === 'challenge' ? 'leadership challenge' : ctx === 'grudge' ? 'revenge' : ctx === 'theft' ? 'theft' : ctx === 'norm' ? 'norm enforcement' : 'contested food'], winner);
    onKilling(sim, winner, killed, deathEv);
    witness(sim, [...allies.a, ...allies.b, ...nearby(sim, winner)], MEM_KILLING, winner, killed, deathEv);
    return { level, winner, loser, killed, eventId: deathEv };
  }
  return { level, winner, loser, killed: NO_ID, eventId };
}

/** People within witnessing distance of x (uses the conflict spatial index). */
function nearby(sim: Simulation, x: number): number[] {
  const c = sim.agents.cols;
  const out: number[] = [];
  sim.spatialConflict.query(c.x[x], c.y[x], sim.cfg.conflict.witnessRadius, c.x, c.y, (w) => {
    if (w !== x && c.alive[w]) out.push(w);
  });
  return out;
}

/**
 * A killing creates grudges (§9): in the victim's known kin (scaled by r x
 * affinity to the victim) and in clanmates who witness it. Anger targets the
 * killer. Grief in kin.
 */
export function onKilling(sim: Simulation, killer: number, victim: number, deathEv: number): void {
  const c = sim.agents.cols;
  const k = sim.cfg.conflict;
  const t = sim.tick;
  const kin = sim.kin.kinOf(victim);
  const rs = sim.kin.rOf(victim);
  for (let x = 0; x < kin.length; x++) {
    const j = kin[x];
    if (!c.alive[j] || j === killer) continue;
    const affToVictim = Math.max(0, sim.rel.affinity(c.slot[j], victim, t));
    const g = k.killGrudge * rs[x] * (1 + affToVictim);
    sim.rel.update(c.slot[j], killer, t, -g, 0, g, 0.05);
    c.anger[j] = Math.min(1, c.anger[j] + g);
    c.angerTarget[j] = killer;
    c.grief[j] = Math.min(1, c.grief[j] + rs[x]);
  }
  // Witnesses from the victim's clan.
  sim.spatialConflict.query(c.x[killer], c.y[killer], k.witnessRadius, c.x, c.y, (w) => {
    if (w === killer || !c.alive[w] || c.clanId[w] !== c.clanId[victim]) return;
    sim.rel.update(c.slot[w], killer, t, -k.witnessGrudge, 0, k.witnessGrudge, 0.05);
  });
  sim.stats.day.killings++;
  void deathEv;
}

/**
 * Is `b` a legitimate revenge target for `a`, under a's revengeScope?
 * 0: the wrongdoer only; 1: also the wrongdoer's kin; 2: also their clan.
 * Returns the grudge that motivates it (0 if none).
 */
export function revengeMotive(sim: Simulation, a: number, b: number): number {
  const c = sim.agents.cols;
  const thr = sim.cfg.conflict.revengeGrudge;
  const direct = sim.rel.get(c.slot[a], b, sim.tick)?.grudge ?? 0;
  if (sim.maxStoredGrudge(a) < thr) return 0;
  if (direct >= thr) return direct;
  const scope = c.cRevenge[a];
  if (scope === 0) return 0;
  // Expanded scopes never turn one's own clan or kin into targets.
  if (c.clanId[b] !== NO_ID && c.clanId[b] === c.clanId[a]) return 0;
  if (sim.relatedness(a, b) >= 0.125) return 0;
  let best = 0;
  const rel = sim.rel;
  const base = c.slot[a] * rel.cap;
  const end = base + rel.count[c.slot[a]];
  for (let e = base; e < end; e++) {
    if (rel.grudge[e] < thr) continue; // stored value bounds the decayed one
    const o = rel.other[e];
    const g = rel.grudgeAt(e, sim.tick);
    if (g < thr || o === b) continue;
    if (scope >= 1 && sim.relatedness(o, b) >= 0.25) best = Math.max(best, g * 0.6);
    else if (scope >= 2 && c.clanId[o] !== NO_ID && c.clanId[o] === c.clanId[b]) best = Math.max(best, g * 0.4);
  }
  return best;
}
