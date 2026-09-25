/**
 * Movement + work sub-step (§5: 8 per day). Agents walk their path out
 * (flow-field path), work at the destination (forage/hunt), and turn back
 * when the remaining sub-steps only just cover the trip home. Eating from
 * carried food happens on the go when hungry (Eat). Followers (infants,
 * learning children) move with their leader. Perception of tiles happens
 * where the agent works.
 */
import type { Simulation } from '../sim';
import type { Rng } from '../rng';
import {
  CAUSE_HUNTING, GOAL_FOLLOW, GOAL_FORAGE, GOAL_HUNT, NO_ID, PHASE_HOME, PHASE_OUT, PHASE_RETURN, PHASE_WORK,
} from '../state/agents';
import { FlowFields } from '../world/flowfield';
import { contact } from './social';
import { movePlayerBound } from '../play/player';
import {
  ageYears, feed, isAlive, placeAtHome, placeAtTile, sizeFactor, spend, strength, tileOf,
} from './common';

export function movementSubStep(sim: Simulation, order: readonly number[], s: number, rng: Rng): void {
  const c = sim.agents.cols;
  const now = sim.tick * sim.cfg.time.subStepsPerDay + s;
  for (const id of order) {
    if (c.followId[id] !== NO_ID) continue; // followers move after their leaders
    if (c.heldUntil[id] > now) continue; // stopped to talk (play mode)
    if (sim.player && (c.escortUntil[id] > now || c.comeUntil[id] > now)) {
      movePlayerBound(sim, id, now);
      continue;
    }
    const ph = c.phase[id];
    if (ph === PHASE_HOME) continue;
    if (ph === PHASE_OUT) walkOut(sim, id, s);
    if (c.phase[id] === PHASE_WORK) work(sim, id, s, rng);
    if (c.phase[id] === PHASE_RETURN) walkHome(sim, id);
    eatOnTheGo(sim, id);
  }
  for (const id of order) {
    const lead = c.followId[id];
    if (lead === NO_ID) continue;
    if (!isAlive(sim, lead)) {
      c.followId[id] = NO_ID;
      c.partyLeader[id] = NO_ID;
      c.phase[id] = c.phase[id] === PHASE_HOME ? PHASE_HOME : PHASE_RETURN;
      continue;
    }
    const wasHome = c.phase[id] === PHASE_HOME;
    c.phase[id] = c.phase[lead];
    if (c.phase[lead] === PHASE_HOME) {
      if (!wasHome) placeAtHome(sim, id);
    } else {
      c.x[id] = c.x[lead] + 0.15;
      c.y[id] = c.y[lead] + 0.1;
    }
    // Party hunters walk and work with their leader; the leader rolls for the group.
    if (c.partyLeader[id] === lead) {
      if (c.phase[lead] === PHASE_OUT || c.phase[lead] === PHASE_RETURN) spend(sim, id, sim.cfg.metabolism.walkCostPerStep);
      if (c.phase[lead] === PHASE_WORK) {
        spend(sim, id, sim.cfg.metabolism.workCostPerStep);
        huntInjury(sim, id, rng);
      }
      eatOnTheGo(sim, id);
      continue;
    }
    // Mothers pay to carry infants; learning children work alongside.
    if (c.goal[id] === GOAL_FOLLOW) {
      if (c.phase[lead] === PHASE_WORK && c.goal[lead] === GOAL_FORAGE) forageAt(sim, id, tileOf(sim, lead), rng, true);
      if (c.phase[lead] === PHASE_WORK) learn(sim, id, lead);
      if (c.phase[lead] !== PHASE_HOME) spend(sim, id, sim.cfg.metabolism.walkCostPerStep * sizeFactor(sim, ageYears(sim, id)));
      eatOnTheGo(sim, id);
    } else if (c.phase[lead] !== PHASE_HOME) {
      spend(sim, lead, sim.cfg.metabolism.carryInfantCostPerStep);
    }
  }
}

function walkOut(sim: Simulation, id: number, s: number): void {
  const c = sim.agents.cols;
  const m = sim.mind;
  const slot = c.slot[id];
  const W = sim.world.width;
  const speed = sim.cfg.movement.speedCostPerStep;
  const field = sim.fields.get(c.homeTileToday[id]);
  c.moveBudget[id] = Math.min(c.moveBudget[id] + speed, 2 * speed);
  let cur = tileOf(sim, id);
  const base = slot * m.maxPath;
  let moved = false;
  while (m.pathPos[slot] < m.pathLen[slot]) {
    const next = m.pathTiles[base + m.pathPos[slot]];
    const cost = sim.world.movementCost[next] * (FlowFields.isDiagonal(cur, next, W) ? Math.SQRT2 : 1);
    if (c.moveBudget[id] < cost) break;
    c.moveBudget[id] -= cost;
    m.pathPos[slot]++;
    cur = next;
    moved = true;
  }
  if (moved) {
    placeAtTile(sim, id, cur);
    // Passing through: the walker sees the tile it is on.
    const w = sim.world;
    if (w.plantCapacity[cur] > 0) sim.mind.observePlace(slot, cur, w.plantFood[cur], w.gameDensity[cur], sim.tick);
  }
  spend(sim, id, sim.cfg.metabolism.walkCostPerStep);
  if (m.pathPos[slot] >= m.pathLen[slot]) {
    c.phase[id] = PHASE_WORK;
    return;
  }
  // Turn back if continuing would leave too little time to get home by nightfall.
  const stepsLeft = sim.cfg.time.subStepsPerDay - 1 - s;
  if (Math.ceil(field[cur] / speed) >= stepsLeft) c.phase[id] = PHASE_RETURN;
}

function walkHome(sim: Simulation, id: number): void {
  const c = sim.agents.cols;
  const W = sim.world.width;
  const home = c.homeTileToday[id];
  const field = sim.fields.get(home);
  c.moveBudget[id] = Math.min(c.moveBudget[id] + sim.cfg.movement.speedCostPerStep, 2 * sim.cfg.movement.speedCostPerStep);
  let cur = tileOf(sim, id);
  let moved = false;
  for (;;) {
    if (cur === home || field[cur] === 0) {
      c.phase[id] = PHASE_HOME;
      placeAtHome(sim, id);
      break;
    }
    const next = FlowFields.stepToward(field, sim.world, cur);
    if (next < 0) break; // unreachable (e.g. camp moved beyond range): stay put
    const cost = sim.world.movementCost[next] * (FlowFields.isDiagonal(cur, next, W) ? Math.SQRT2 : 1);
    if (c.moveBudget[id] < cost) break;
    c.moveBudget[id] -= cost;
    cur = next;
    moved = true;
  }
  if (moved && c.phase[id] !== PHASE_HOME) placeAtTile(sim, id, cur);
  spend(sim, id, sim.cfg.metabolism.walkCostPerStep);
}

function work(sim: Simulation, id: number, s: number, rng: Rng): void {
  const c = sim.agents.cols;
  const S = sim.cfg.time.subStepsPerDay;
  const t = tileOf(sim, id);
  const field = sim.fields.get(c.homeTileToday[id]);
  const stepsLeft = S - 1 - s;
  const stepsHome = Math.ceil(field[t] / sim.cfg.movement.speedCostPerStep);
  if (stepsHome >= stepsLeft || c.carriedFood[id] >= sim.cfg.resources.carryCapacity * 0.95) {
    c.phase[id] = PHASE_RETURN;
    return;
  }
  spend(sim, id, sim.cfg.metabolism.workCostPerStep);
  if (sim.world.waterAccess[t] >= 1) c.lastWaterTick[id] = sim.tick;
  observe(sim, id, t, rng);
  if (c.goal[id] === GOAL_FORAGE) {
    forageAt(sim, id, t, rng, false);
    // Patch exhausted: shift to the best adjacent tile (directly perceived).
    const w = sim.world;
    if (w.plantFood[t] < w.plantCapacity[t] * sim.cfg.resources.forageMinTileFraction) {
      const nb = bestNeighbor(sim, t);
      if (nb >= 0) placeAtTile(sim, id, nb);
    }
  } else if (c.goal[id] === GOAL_HUNT) {
    hunt(sim, id, t, rng);
  }
  // GOAL_AVENGE: lurk (perceive, wait); encounters are resolved in fieldEncounters.
}

export function forageAt(sim: Simulation, id: number, t: number, rng: Rng, learner: boolean): void {
  const c = sim.agents.cols;
  const w = sim.world;
  const rc = sim.cfg.resources;
  const floor = w.plantCapacity[t] * rc.forageMinTileFraction;
  const avail = w.plantFood[t] - floor;
  if (avail <= 0) return;
  const rate = rc.forageRatePerStep * (0.5 + c.foragingSkill[id]) * (1 - 0.5 * c.injury[id]) * (learner ? 0.6 : 1);
  const noisy = rate * (1 + rc.forageNoise * (2 * rng.next() - 1));
  const room = rc.carryCapacity - c.carriedFood[id];
  const h = Math.max(0, Math.min(avail, noisy, room));
  w.plantFood[t] -= h;
  c.carriedFood[id] += h;
  c.todayYield[id] += h;
  c.foragingSkill[id] = Math.min(1, c.foragingSkill[id] + sim.cfg.skills.practiceRate * (1 - c.foragingSkill[id]));
}

function hunt(sim: Simulation, id: number, t: number, rng: Rng): void {
  const c = sim.agents.cols;
  const w = sim.world;
  const rc = sim.cfg.resources;
  const hc = sim.cfg.hunting;
  const party = sim.parties.get(id) ?? [];
  const members = [id, ...party.filter((m) => c.alive[m] && c.partyLeader[m] === id)];
  const n = members.length;
  // Each hunter contributes; groups coordinate (synergy) and can take bigger game.
  let miss = 1;
  for (const m of members) {
    const carrying = carryingInfant(sim, m);
    const p = rc.huntSuccessPerStep * w.gameDensity[t] * (0.5 + strength(sim, m)) * (0.6 + 0.8 * c.foragingSkill[m])
      * (carrying ? rc.huntCarryingInfantFactor : 1) * (1 + hc.groupSynergy * (n - 1));
    miss *= 1 - Math.min(0.95, p);
  }
  if (rng.chance(1 - miss)) {
    const total = Math.max(1, rng.normal(rc.huntYieldMean, rc.huntYieldSd)) * (1 + hc.bigGamePerMember * (n - 1));
    const each = total / n;
    for (const m of members) {
      const got = Math.min(rc.carryCapacity - c.carriedFood[m], each);
      c.carriedFood[m] += got;
      c.todayYield[m] += got;
      c.huntSuccessEma[m] += sim.cfg.decision.yieldEmaRate * (1 - c.huntSuccessEma[m]);
    }
    w.gameDensity[t] *= 1 - rc.huntDepletion * Math.min(2, 1 + 0.25 * (n - 1));
    c.phase[id] = PHASE_RETURN;
    sim.stats.day.kills++;
    if (n > 1) {
      sim.stats.day.partyHunts++;
      // Shared success bonds the party.
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) contact(sim, members[a], members[b], sim.cfg.social.socializeAffinity, sim.cfg.social.socializeFamiliarity);
      sim.events.emit(sim.tick, { type: 'hunt.party_kill', causes: [], agents: members, clans: [c.clanId[id]], x: c.x[id], y: c.y[id], data: { units: Math.round(total) } });
    }
  }
  c.foragingSkill[id] = Math.min(1, c.foragingSkill[id] + sim.cfg.skills.practiceRate * 0.5 * (1 - c.foragingSkill[id]));
  huntInjury(sim, id, rng);
}

function huntInjury(sim: Simulation, id: number, rng: Rng): void {
  const c = sim.agents.cols;
  const rc = sim.cfg.resources;
  const str = strength(sim, id);
  if (!rng.chance(rc.huntInjuryPerStep * (1.5 - Math.min(1, str)) * (carryingInfant(sim, id) ? 3 : 1))) return;
  const sev = rc.huntInjurySeverity * (0.5 + rng.next());
  c.injury[id] = Math.min(1, c.injury[id] + sev);
  c.injuryCause[id] = CAUSE_HUNTING;
  c.injuryEventId[id] = sim.events.emit(sim.tick, {
    type: 'agent.injured', causes: [], x: c.x[id], y: c.y[id], agents: [id], clans: [c.clanId[id]],
    data: { how: 'hunting', severity: Math.round(sev * 100) / 100 },
  });
  const lead = c.partyLeader[id];
  if (lead === NO_ID) c.phase[id] = PHASE_RETURN;
}

function carryingInfant(sim: Simulation, id: number): boolean {
  // Infants set followId = mother when she leaves camp.
  const kids = sim.pedigree.childrenOf(id);
  const c = sim.agents.cols;
  for (let k = kids.length - 1; k >= 0 && k >= kids.length - 2; k--) {
    const kid = kids[k];
    if (c.alive[kid] && c.followId[kid] === id && c.goal[kid] !== GOAL_FOLLOW) return true;
  }
  return false;
}

function learn(sim: Simulation, kid: number, teacher: number): void {
  const c = sim.agents.cols;
  const gap = c.foragingSkill[teacher] - c.foragingSkill[kid];
  if (gap > 0) c.foragingSkill[kid] += sim.cfg.skills.teachRate * gap;
}

/** Perception while working: this tile plus a few random tiles within perception radius. */
function observe(sim: Simulation, id: number, t: number, rng: Rng): void {
  const c = sim.agents.cols;
  const w = sim.world;
  const slot = c.slot[id];
  sim.mind.observePlace(slot, t, w.plantFood[t], w.gameDensity[t], sim.tick);
  const r = sim.cfg.perception.radius;
  const W = w.width;
  const x0 = t % W;
  const y0 = (t / W) | 0;
  for (let k = 0; k < sim.cfg.perception.tilesObservedPerStep; k++) {
    const x = x0 + rng.int(2 * r + 1) - r;
    const y = y0 + rng.int(2 * r + 1) - r;
    if (x < 0 || y < 0 || x >= W || y >= w.height) continue;
    const j = y * W + x;
    if (w.plantCapacity[j] <= 0) continue;
    sim.mind.observePlace(slot, j, w.plantFood[j], w.gameDensity[j], sim.tick);
  }
}

function bestNeighbor(sim: Simulation, t: number): number {
  const w = sim.world;
  const W = w.width;
  const x0 = t % W;
  const y0 = (t / W) | 0;
  let best = -1;
  let bestV = w.plantFood[t];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 0 || y < 0 || x >= W || y >= w.height) continue;
      const j = y * W + x;
      if (w.movementCost[j] >= sim.cfg.world.impassableCost) continue;
      if (w.plantFood[j] > bestV) {
        bestV = w.plantFood[j];
        best = j;
      }
    }
  }
  return best;
}

function eatOnTheGo(sim: Simulation, id: number): void {
  const c = sim.agents.cols;
  const mc = sim.cfg.metabolism;
  if (c.carriedFood[id] <= 0 || c.energy[id] >= mc.eatOnTheGoThreshold) return;
  const want = (mc.eatOnTheGoThreshold - c.energy[id]) * mc.reserveDays * mc.adultNeed * sizeFactor(sim, ageYears(sim, id));
  const eaten = feed(sim, id, Math.min(want, c.carriedFood[id]));
  c.carriedFood[id] -= eaten;
}

/** Night: those at a home site near water drink (camps are sited by water). */
export function drinkAtNight(sim: Simulation): void {
  const c = sim.agents.cols;
  const wa = sim.world.waterAccess;
  for (const id of sim.agents.living) {
    const t = c.phase[id] === PHASE_HOME ? c.homeTileToday[id] : tileOf(sim, id);
    if (t >= 0 && wa[t] >= 1) c.lastWaterTick[id] = sim.tick;
  }
}
