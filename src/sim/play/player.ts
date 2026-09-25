/**
 * Play mode (sim core). A human player is an ordinary agent with a clan of
 * their own; they act through the same primitives as everyone else (gifts,
 * relationships, clan membership, killings), so the world responds with its
 * own mechanisms. The player's choices enter as a stream of *resolved*
 * actions applied between days. Each action carries everything it needs
 * (target, witnesses seen on screen), so (seed, config, action log) replays
 * exactly. That log is also the natural unit for multiplayer later.
 *
 * Pure: no DOM, no unseeded randomness, no clocks.
 */
import type { Simulation } from '../sim';
import {
  CAUSE_VIOLENCE, GOAL_REST, NO_ID, PHASE_HOME, SEX_FEMALE, SEX_MALE, AGENT_FIELDS,
} from '../state/agents';
import { ageYears, clamp01, feed, isAlive, strength } from '../systems/common';
import { clanValue, LONER, moveClan } from '../systems/clans';
import { onGift } from '../systems/social';
import { killAgent } from '../systems/mortality';
import { onKilling } from '../systems/conflict';
import { makeClanName, makePersonName, makeSyllableSet } from '../names';
import { animalsOnTile, ANIMALS, huntChance } from './animals';
import { nearestCampSite } from '../systems/camps';

export type HelpVerb = 'talk' | 'give' | 'tend' | 'back';

/** A player action, resolved by the host (witnesses included) and logged with its tick. */
export type PlayerAction =
  | { kind: 'spawn'; name: string; female: boolean }
  | { kind: 'pos'; x: number; y: number }
  | { kind: 'gather' }
  | { kind: 'take'; amount: number }
  | { kind: 'help'; verb: HelpVerb; target: number; witnesses: number[] }
  | { kind: 'invite'; target: number; witnesses: number[] }
  | { kind: 'raid'; clan: number }
  /** Call out to someone so they stop and wait (play mode's way to get a word in). */
  | { kind: 'hail'; target: number }
  /** Hunt the k-th animal on tile `tile` (animals are a pure function of the tile's game density). */
  | { kind: 'hunt'; tile: number; k: number }
  | { kind: 'wood' }
  /** Leave carried food and wood at your camp. */
  | { kind: 'deposit' }
  | { kind: 'build' };

export interface PlayerSkills {
  hunt: number;
  gather: number;
  wood: number;
}

export interface PlayerState {
  id: number;
  clanId: number;
  /** clanId -> suspicion in [0, ~1.5]; at caughtThreshold the clan comes for you (at night). */
  suspicion: Record<string, number>;
  /** Pending raid target (resolved at night), or -1. */
  raidTarget: number;
  lastRaidTick: number;
  gathersToday: number;
  gatherTick: number;
  /** target id -> tick of last refused invite (cooldown). */
  refusedAt: Record<string, number>;
  /** target id -> tick of last help per verb ("verb:id"). */
  lastHelp: Record<string, number>;
  caught: number;
  raidsWon: number;
  raidsLost: number;
  /** Skills grow with practice (0..1). */
  skills: PlayerSkills;
  /** 0 = fed, 1 = starving (slows you down). */
  hunger: number;
  /** Wood in hand, wood at camp, shelters built. */
  wood: number;
  campWood: number;
  shelters: number;
  huntsToday: number;
  woodToday: number;
  /** Tick the per-day counters belong to. */
  effortTick: number;
  /** Actions with the tick and sub-step (-1 = before the day began) they were applied at. */
  log: { tick: number; sub: number; a: PlayerAction }[];
}

/** What the UI gets back from an action. */
export interface ActionResult {
  ok: boolean;
  text: string;
  /** Clans whose suspicion rose, with the amount, so the UI can warn. */
  seenBy?: { clan: number; amount: number; witnesses: number }[];
}

export function playerId(sim: Simulation): number {
  return sim.player ? sim.player.id : NO_ID;
}

export function isPlayer(sim: Simulation, id: number): boolean {
  return sim.player !== null && sim.player.id === id;
}

export function isPlayerClan(sim: Simulation, clan: number): boolean {
  return sim.player !== null && sim.player.clanId === clan;
}

/** Applies (and logs) one action at the current tick. */
export function applyPlayerAction(sim: Simulation, a: PlayerAction): ActionResult {
  if (a.kind === 'spawn') {
    const r = spawnPlayer(sim, a.name, a.female);
    sim.player!.log.push({ tick: sim.tick, sub: sim.nextSubStep, a });
    return r;
  }
  const p = sim.player;
  if (!p) return { ok: false, text: 'no player' };
  const r = apply(sim, p, a);
  if (r.ok) {
    // Consecutive position updates within one tick collapse to the last (exact: only the final one matters).
    const last = p.log[p.log.length - 1];
    if (a.kind === 'pos' && last && last.tick === sim.tick && last.sub === sim.nextSubStep && last.a.kind === 'pos') last.a = a;
    else p.log.push({ tick: sim.tick, sub: sim.nextSubStep, a });
  }
  return r;
}

function apply(sim: Simulation, p: PlayerState, a: PlayerAction): ActionResult {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  const me = p.id;
  switch (a.kind) {
    case 'pos': {
      const W = sim.world.width;
      const H = sim.world.height;
      const x = Math.min(W - 0.01, Math.max(0, a.x));
      const y = Math.min(H - 0.01, Math.max(0, a.y));
      const t = Math.floor(y) * W + Math.floor(x);
      if (sim.world.movementCost[t] >= sim.cfg.world.impassableCost) return { ok: false, text: 'water' };
      c.x[me] = x;
      c.y[me] = y;
      return { ok: true, text: '' };
    }
    case 'gather': {
      resetEffort(sim, p);
      if (p.gathersToday >= pc.gatherActionsPerDay) return { ok: false, text: 'You are too tired to gather more today.' };
      const t = Math.floor(c.y[me]) * sim.world.width + Math.floor(c.x[me]);
      const room = pc.carryCapacity - c.carriedFood[me];
      const got = Math.min(pc.gatherPerAction * (0.6 + p.skills.gather), sim.world.plantFood[t], room);
      if (room <= 0.01) return { ok: false, text: 'Your hands are full.' };
      if (got < 0.1) return { ok: false, text: 'Nothing left to gather here.' };
      sim.world.plantFood[t] -= got;
      c.carriedFood[me] += got;
      p.gathersToday++;
      p.skills.gather = Math.min(1, p.skills.gather + pc.skillGain * 0.5 * (1 - p.skills.gather));
      return { ok: true, text: `Gathered ${got.toFixed(1)} food.` };
    }
    case 'hail':
      return hail(sim, p, a.target);
    case 'hunt':
      return huntAnimal(sim, p, a.tile, a.k);
    case 'wood': {
      resetEffort(sim, p);
      if (p.woodToday >= pc.woodActionsPerDay) return { ok: false, text: 'Your arms are spent. No more wood today.' };
      const t = Math.floor(c.y[me]) * sim.world.width + Math.floor(c.x[me]);
      if (sim.world.biome[t] !== 1) return { ok: false, text: 'There are no good trees here. Find a forest.' };
      if (p.wood >= pc.woodCarry) return { ok: false, text: 'You cannot carry more wood.' };
      const got = Math.min(pc.woodCarry - p.wood, pc.woodPerAction * (0.6 + p.skills.wood));
      p.wood += got;
      p.woodToday++;
      p.skills.wood = Math.min(1, p.skills.wood + pc.skillGain * 0.5 * (1 - p.skills.wood));
      return { ok: true, text: `You cut ${got.toFixed(1)} wood.` };
    }
    case 'deposit': {
      const clan = sim.clans.get(p.clanId)!;
      const food = c.carriedFood[me];
      clan.foodStore += food;
      c.carriedFood[me] = 0;
      p.campWood += p.wood;
      const w = p.wood;
      p.wood = 0;
      if (food < 0.1 && w < 0.1) return { ok: false, text: 'You have nothing to leave at camp.' };
      return { ok: true, text: `You leave ${[food >= 0.1 ? `${food.toFixed(0)} food` : '', w >= 0.1 ? `${w.toFixed(0)} wood` : ''].filter(Boolean).join(' and ')} at camp.` };
    }
    case 'build': {
      if (p.shelters >= pc.maxShelters) return { ok: false, text: 'Your camp has all the shelters it needs.' };
      if (p.campWood < pc.shelterWood) return { ok: false, text: `A shelter needs ${pc.shelterWood} wood at camp (you have ${p.campWood.toFixed(0)}).` };
      p.campWood -= pc.shelterWood;
      p.shelters++;
      return { ok: true, text: `You raise a shelter. Your camp has ${p.shelters}; people will think better of living here.` };
    }
    case 'take': {
      const clan = sim.clans.get(p.clanId)!;
      const room = pc.carryCapacity - c.carriedFood[me];
      const amt = Math.max(0, Math.min(a.amount, clan.foodStore, room));
      if (amt < 0.1) return { ok: false, text: clan.foodStore < 0.1 ? 'Your camp store is empty.' : 'Your hands are full.' };
      clan.foodStore -= amt;
      c.carriedFood[me] += amt;
      return { ok: true, text: `Took ${amt.toFixed(1)} food from your camp.` };
    }
    case 'help':
      return help(sim, p, a.verb, a.target, a.witnesses);
    case 'invite':
      return invite(sim, p, a.target, a.witnesses);
    case 'raid': {
      const chk = raidCheck(sim, a.clan);
      if (!chk.ok) return { ok: false, text: chk.reason };
      p.raidTarget = a.clan;
      return { ok: true, text: `Your people will raid ${sim.clans.label(a.clan)} tonight.` };
    }
  }
  return { ok: false, text: 'unknown action' };
}

// ---------------------------------------------------------------- spawn

function spawnPlayer(sim: Simulation, name: string, female: boolean): ActionResult {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  const rng = sim.rng.get('player');
  const site = chooseSite(sim);
  const set = makeSyllableSet(rng);
  const clan = sim.clans.create(makeClanName(rng, set), site.x, site.y, { tick: sim.tick, parentClanId: -1, founderId: -1, eventId: -1 });
  sim.syllables.set(clan.id, set);
  // A template adult provides a plausible body and culture; identity and ties are fresh.
  const adults = sim.agents.living.filter((id) => ageYears(sim, id) >= 20 && ageYears(sim, id) <= 40);
  const tpl = adults.length ? adults[rng.int(adults.length)] : sim.agents.living[0];
  const id = sim.agents.create(name);
  const cols = c as unknown as Record<string, { [i: number]: number }>;
  for (const f of AGENT_FIELDS) cols[f][id] = cols[f][tpl];
  sim.onCreated(id);
  for (const f of ['motherId', 'fatherId', 'rearerId', 'partnerId', 'pregnancyFatherId', 'killerId', 'angerTarget', 'followId',
    'targetTile', 'pairEventId', 'partyLeader', 'injuredBy', 'lastWinEvent', 'injuryEventId', 'deathTick', 'lastConflictTick'] as const) {
    c[f][id] = NO_ID;
  }
  c.alive[id] = 1;
  c.sex[id] = female ? SEX_FEMALE : SEX_MALE;
  c.repState[id] = 0;
  c.birthTick[id] = sim.tick - Math.floor(pc.startAgeYears * sim.cfg.time.daysPerYear);
  c.clanId[id] = clan.id;
  c.birthClanId[id] = clan.id;
  c.energy[id] = 1;
  c.condition[id] = 1;
  c.health[id] = 1;
  c.healthCap[id] = 1;
  c.injury[id] = 0;
  c.carriedFood[id] = 6;
  c.infectedUntil[id] = 0;
  c.anger[id] = 0;
  c.fear[id] = 0;
  c.grief[id] = 0;
  c.goal[id] = GOAL_REST;
  c.phase[id] = PHASE_HOME;
  c.x[id] = site.x;
  c.y[id] = site.y;
  sim.kin.addBirth(id);
  sim.player = {
    id, clanId: clan.id, suspicion: {}, raidTarget: -1, lastRaidTick: -1_000_000, gathersToday: 0, gatherTick: -1,
    refusedAt: {}, lastHelp: {}, caught: 0, raidsWon: 0, raidsLost: 0,
    skills: { hunt: pc.startSkill, gather: pc.startSkill, wood: pc.startSkill }, hunger: 0, wood: 0, campWood: 0, shelters: 0,
    huntsToday: 0, woodToday: 0, effortTick: -1, log: [],
  };
  clan.founding.founderId = id;
  clan.founding.eventId = sim.events.emit(sim.tick, {
    type: 'clan.founded', causes: [], agents: [id], clans: [clan.id], x: site.x, y: site.y, data: { name: clan.name, player: true },
  });
  clan.history.push(clan.founding.eventId);
  spawnDrifters(sim, pc.drifters);
  sim.rebuildDerived();
  sim.leaders.set(clan.id, id);
  return { ok: true, text: `You arrive alone and make camp: ${sim.clans.label(clan.id)}.` };
}

/**
 * Drifters: clanless people who roam the valley (loners who move their
 * fireside every few days; see nomadSystem). Built like any adult from a
 * template, with no ties. The player meets them away from the camps.
 */
function spawnDrifters(sim: Simulation, n: number): void {
  const c = sim.agents.cols;
  const rng = sim.rng.get('player');
  const W = sim.world.width;
  const adults = sim.agents.living.filter((id) => ageYears(sim, id) >= 18 && ageYears(sim, id) <= 45 && !isPlayer(sim, id));
  const sets = [...sim.syllables.values()];
  let prev = NO_ID;
  for (let k = 0; k < n && adults.length; k++) {
    const tpl = adults[rng.int(adults.length)];
    const id = sim.agents.create(makePersonName(rng, sets[rng.int(sets.length)]));
    const cols = c as unknown as Record<string, { [i: number]: number }>;
    for (const f of AGENT_FIELDS) cols[f][id] = cols[f][tpl];
    sim.onCreated(id);
    for (const f of ['motherId', 'fatherId', 'rearerId', 'partnerId', 'pregnancyFatherId', 'killerId', 'angerTarget', 'followId',
      'targetTile', 'pairEventId', 'partyLeader', 'injuredBy', 'lastWinEvent', 'injuryEventId', 'deathTick', 'lastConflictTick'] as const) {
      c[f][id] = NO_ID;
    }
    c.alive[id] = 1;
    const female = rng.chance(0.5);
    c.sex[id] = female ? SEX_FEMALE : SEX_MALE;
    c.repState[id] = 0;
    c.birthTick[id] = sim.tick - Math.floor((18 + rng.int(25)) * sim.cfg.time.daysPerYear);
    c.clanId[id] = LONER;
    c.birthClanId[id] = LONER;
    c.energy[id] = 0.8;
    c.condition[id] = 0.8;
    c.health[id] = 1;
    c.injury[id] = 0;
    c.carriedFood[id] = 0;
    c.infectedUntil[id] = 0;
    c.anger[id] = 0;
    c.grief[id] = 0;
    c.goal[id] = GOAL_REST;
    c.phase[id] = PHASE_HOME;
    c.heldUntil[id] = 0;
    // Somewhere away from the camps, by water.
    let site = -1;
    for (let tries = 0; tries < 60 && site < 0; tries++) {
      const t = nearestCampSite(sim, rng.int(sim.world.height) * W + rng.int(W));
      if (t < 0) continue;
      const x = (t % W) + 0.5;
      const y = Math.floor(t / W) + 0.5;
      if (sim.clans.extant().every((cl) => Math.hypot(cl.campX - x, cl.campY - y) > 9)) site = t;
    }
    // Every third drifter travels with the previous one as a couple.
    if (k % 3 === 2 && prev !== NO_ID && c.sex[prev] !== c.sex[id]) {
      c.partnerId[id] = prev;
      c.partnerId[prev] = id;
      site = Math.floor(c.ownHomeY[prev]) * W + Math.floor(c.ownHomeX[prev]);
    }
    if (site < 0) site = Math.floor(c.y[tpl]) * W + Math.floor(c.x[tpl]);
    c.ownHomeX[id] = (site % W) + 0.5;
    c.ownHomeY[id] = Math.floor(site / W) + 0.5;
    c.x[id] = c.ownHomeX[id];
    c.y[id] = c.ownHomeY[id];
    c.homeTileToday[id] = site;
    sim.kin.addBirth(id);
    sim.events.emit(sim.tick, { type: 'agent.drifter', causes: [], agents: [id], x: c.x[id], y: c.y[id], data: {} });
    prev = id;
  }
}

function resetEffort(sim: Simulation, p: PlayerState): void {
  if (p.effortTick === sim.tick) return;
  p.effortTick = sim.tick;
  p.huntsToday = 0;
  p.woodToday = 0;
  if (p.gatherTick !== sim.tick) {
    p.gatherTick = sim.tick;
    p.gathersToday = 0;
  }
}

/** Someone the player calls to stops and waits a while, unless they want nothing to do with them. */
function hail(sim: Simulation, p: PlayerState, t: number): ActionResult {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  if (!isAlive(sim, t) || t === p.id) return { ok: false, text: 'They are gone.' };
  const name = sim.agents.displayName(t);
  const S = sim.cfg.time.subStepsPerDay;
  if (sim.nextSubStep < 0 || sim.nextSubStep >= S) return { ok: false, text: 'It is night; people are by their fires.' };
  const v = sim.rel.get(c.slot[t], p.id, sim.tick);
  if ((v?.grudge ?? 0) > 0.3 || (v?.aff ?? 0) < -0.3) return { ok: false, text: `${name} glares at you and walks on.` };
  const friendly = (v?.aff ?? 0) > 0.3;
  const hold = friendly ? pc.hailHoldFriend : pc.hailHoldStranger;
  const now = sim.tick * S + sim.nextSubStep;
  c.heldUntil[t] = Math.max(c.heldUntil[t], now + hold);
  sim.rel.update(c.slot[t], p.id, sim.tick, 0, 0, 0, 0.03);
  return { ok: true, text: friendly ? `${name} smiles and waits for you.` : `${name} stops and eyes you, waiting.` };
}

/** Keeps someone you are dealing with from walking off mid-conversation. */
function engage(sim: Simulation, t: number): void {
  const S = sim.cfg.time.subStepsPerDay;
  if (sim.nextSubStep < 0 || sim.nextSubStep >= S) return;
  const c = sim.agents.cols;
  c.heldUntil[t] = Math.max(c.heldUntil[t], sim.tick * S + sim.nextSubStep + 1);
}

function huntAnimal(sim: Simulation, p: PlayerState, tile: number, k: number): ActionResult {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  const w = sim.world;
  resetEffort(sim, p);
  if (p.huntsToday >= pc.huntsPerDay) return { ok: false, text: 'You are too worn out to hunt again today.' };
  const kinds = animalsOnTile(tile, w.biome[tile], w.gameDensity[tile], pc.animalTileRate);
  if (k < 0 || k >= kinds.length) return { ok: false, text: 'The animal has slipped away.' };
  const kind = ANIMALS[kinds[k]];
  p.huntsToday++;
  const rng = sim.rng.get('player');
  const chance = huntChance(kind, p.skills.hunt) * (1 - 0.5 * p.hunger);
  let hurt = '';
  if (kind.risk > 0 && rng.chance(kind.risk * (1.2 - p.skills.hunt))) {
    c.health[p.id] = Math.max(0.3, c.health[p.id] - pc.huntWound);
    hurt = ` The ${kind.name} wounds you.`;
  }
  if (!rng.chance(chance)) {
    p.skills.hunt = Math.min(1, p.skills.hunt + pc.skillGain * 0.25 * (1 - p.skills.hunt));
    return { ok: true, text: `The ${kind.name} escapes.${hurt}` };
  }
  w.gameDensity[tile] *= 1 - kind.depletion;
  const room = pc.carryCapacity - c.carriedFood[p.id];
  const got = Math.min(kind.food, room);
  c.carriedFood[p.id] += got;
  // Harder game teaches more.
  p.skills.hunt = Math.min(1, p.skills.hunt + pc.skillGain * (0.6 + 2 * kind.req) * (1 - p.skills.hunt));
  sim.stats.day.kills++;
  const left = kind.food - got;
  return { ok: true, text: `You bring down a ${kind.name}: ${kind.food} food${left > 0.5 ? ` (you can only carry ${got.toFixed(0)})` : ''}.${hurt}` };
}

/** A watered, fertile spot as far as possible from existing camps. */
function chooseSite(sim: Simulation): { x: number; y: number } {
  const w = sim.world;
  const W = w.width;
  const camps = sim.clans.extant();
  const rng = sim.rng.get('player');
  let best = -1;
  let bestScore = -Infinity;
  const margin = 4;
  for (let y = margin; y < w.height - margin; y++) {
    for (let x = margin; x < W - margin; x++) {
      const t = y * W + x;
      if (w.waterAccess[t] < 1 || w.plantCapacity[t] < 0.5 || w.movementCost[t] > 2) continue;
      let dmin = Infinity;
      for (const cl of camps) dmin = Math.min(dmin, Math.hypot(cl.campX - x, cl.campY - y));
      // Far enough to be safe, close enough to reach people: prefer ~spawnMinCampDistance.
      const d = sim.cfg.play.spawnMinCampDistance;
      const score = -Math.abs(dmin - d * 1.2) + (dmin < d ? -50 : 0) + w.plantCapacity[t] * 2 + rng.next() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
  }
  if (best < 0) best = Math.floor(w.height / 2) * W + Math.floor(W / 2);
  return { x: (best % W) + 0.5, y: Math.floor(best / W) + 0.5 };
}

// ---------------------------------------------------------------- helping

/** The person i most wants revenge on (stored grudge above the revenge threshold), or none. */
export function topGrudge(sim: Simulation, i: number): { other: number; grudge: number } {
  const c = sim.agents.cols;
  let other = NO_ID;
  let g = 0;
  sim.rel.forEach(c.slot[i], sim.tick, (o, v) => {
    if (v.grudge > g && c.alive[o] && !isPlayer(sim, o)) {
      g = v.grudge;
      other = o;
    }
  });
  return g >= sim.cfg.conflict.revengeGrudge ? { other, grudge: g } : { other: NO_ID, grudge: 0 };
}

export function needsTending(sim: Simulation, i: number): boolean {
  const c = sim.agents.cols;
  return c.injury[i] > 0.05 || c.health[i] < 0.75 || c.infectedUntil[i] > sim.tick;
}

/** Which help verbs make sense for i right now (the UI greys out the rest). */
export function availableHelp(sim: Simulation, i: number): HelpVerb[] {
  const c = sim.agents.cols;
  const out: HelpVerb[] = ['talk'];
  if (c.carriedFood[playerId(sim)] >= 1) out.push('give');
  if (needsTending(sim, i)) out.push('tend');
  if (topGrudge(sim, i).other !== NO_ID) out.push('back');
  return out;
}

function help(sim: Simulation, p: PlayerState, verb: HelpVerb, t: number, witnesses: number[]): ActionResult {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  const me = p.id;
  if (!isAlive(sim, t) || t === me) return { ok: false, text: 'They are gone.' };
  const key = `${verb}:${t}`;
  const again = p.lastHelp[key] === sim.tick;
  const name = sim.agents.displayName(t);
  let text = '';
  if (verb === 'talk') {
    const k = again ? 0.2 : 1;
    const dAff = pc.talkAffinity * k * (0.5 + c.sociability[t]);
    sim.rel.update(c.slot[t], me, sim.tick, dAff, 0, 0, pc.talkFamiliarity * k);
    sim.rel.update(c.slot[me], t, sim.tick, dAff, 0, 0, pc.talkFamiliarity * k);
    text = again ? `You talk with ${name} again; they have heard enough for today.` : `You share a while with ${name}.`;
  } else if (verb === 'give') {
    const have = c.carriedFood[me];
    if (have < 1) return { ok: false, text: 'You have no food to give.' };
    const units = Math.min(have, pc.giveUnits);
    const before = c.energy[t];
    c.carriedFood[me] -= units;
    // They eat what they can and carry the rest home (kin sharing takes it from there).
    const ate = feed(sim, t, units);
    c.carriedFood[t] += units - ate;
    onGift(sim, me, t, units, before);
    text = before < 0.45 ? `${name} takes the food gratefully.` : `${name} accepts the food.`;
  } else if (verb === 'tend') {
    if (!needsTending(sim, t)) return { ok: false, text: `${name} does not need tending.` };
    if (again) return { ok: false, text: `You have already tended ${name} today.` };
    const need = Math.max(c.injury[t], 1 - c.health[t], c.infectedUntil[t] > sim.tick ? 0.4 : 0);
    c.injury[t] = Math.max(0, c.injury[t] - pc.tendInjuryHeal);
    c.health[t] = Math.min(c.healthCap[t], c.health[t] + pc.tendHealthHeal);
    sim.rel.update(c.slot[t], me, sim.tick, pc.tendAffinity * (0.5 + need), 0.05, 0, 0.1);
    text = `You tend ${name}.`;
  } else if (verb === 'back') {
    const g = topGrudge(sim, t);
    if (g.other === NO_ID) return { ok: false, text: `${name} has no quarrel to back.` };
    if (again) return { ok: false, text: `You have already promised ${name} your support.` };
    sim.rel.update(c.slot[t], me, sim.tick, pc.backAffinity, pc.backDeference, 0, 0.1);
    // Word travels: the one they hate now counts you among their enemies.
    if (isAlive(sim, g.other)) sim.rel.update(c.slot[g.other], me, sim.tick, -pc.backGrudge, 0, pc.backGrudge, 0.05);
    text = `You promise to stand with ${name} against ${sim.agents.displayName(g.other)}.`;
  }
  p.lastHelp[key] = sim.tick;
  engage(sim, t);
  const seenBy = observe(sim, p, t, verb, witnesses);
  return { ok: true, text, seenBy };
}

/**
 * Witnesses from the target's clan grow suspicious of the stranger courting
 * their people: a lot if the leader sees it, little if they like the player.
 */
function observe(sim: Simulation, p: PlayerState, target: number, verb: HelpVerb | 'invite', witnesses: number[]): ActionResult['seenBy'] {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  const clan = c.clanId[target];
  if (clan === LONER || clan === p.clanId) return [];
  const leader = sim.leaders.get(clan) ?? NO_ID;
  let seen = 0;
  let n = 0;
  for (const w of witnesses) {
    if (w === target || !isAlive(sim, w) || c.clanId[w] !== clan || ageYears(sim, w) < sim.cfg.life.independentAgeYears) continue;
    let f = w === leader ? pc.leaderWitnessFactor : 0.4 + 0.6 * clamp01(leader >= 0 ? (sim.rel.get(c.slot[w], leader, sim.tick)?.def ?? 0) : 0.3);
    if (sim.rel.affinity(c.slot[w], p.id, sim.tick) > 0.5) f *= pc.friendlyWitnessFactor;
    seen += f;
    n++;
  }
  // More eyes make it likelier to be reported, with diminishing returns.
  const amount = pc.suspicion[verb] * pc.witnessSaturation * (1 - Math.exp(-seen / pc.witnessSaturation));
  if (amount <= 0) return [];
  addSuspicion(sim, clan, amount);
  return [{ clan, amount, witnesses: n }];
}

export function addSuspicion(sim: Simulation, clan: number, amount: number): void {
  const p = sim.player;
  if (!p || clan === p.clanId || clan < 0) return;
  p.suspicion[clan] = (p.suspicion[clan] ?? 0) + amount;
}

// ---------------------------------------------------------------- recruiting

export interface InviteOdds {
  p: number;
  parts: { label: string; value: number }[];
}

/** Would `t` leave their clan for the player's? Uses the same clan valuation everyone uses. */
export function inviteOdds(sim: Simulation, t: number): InviteOdds {
  const c = sim.agents.cols;
  const pl = sim.player!;
  const cc = sim.cfg.clans;
  const pc = sim.cfg.play;
  const own = c.clanId[t];
  const vYou = clanValue(sim, t, pl.clanId);
  const vOwn = own === LONER ? cc.lonerValue : clanValue(sim, t, own);
  const members = sim.clanMembers.get(pl.clanId)?.length ?? 1;
  const store = sim.clans.get(pl.clanId)?.foodStore ?? 0;
  const food = pc.inviteFoodWeight * Math.min(1, store / members / 10);
  // How they feel about the stranger who has been good to them.
  const v = sim.rel.get(c.slot[t], pl.id, sim.tick);
  const regard = pc.inviteAffinityWeight * Math.max(0, v?.aff ?? 0) + pc.inviteDeferenceWeight * (v?.def ?? 0) - 2 * (v?.grudge ?? 0);
  const shelter = pc.shelterInviteBonus * pl.shelters;
  const z = regard + vYou + food + shelter - vOwn - cc.switchMargin;
  const p = 1 / (1 + Math.exp(-z / pc.inviteTemperature));
  return {
    p,
    parts: [
      { label: 'how they feel about you', value: regard },
      { label: 'ties to your people', value: vYou },
      { label: 'food in your camp', value: food },
      { label: 'shelters at your camp', value: shelter },
      { label: own === LONER ? 'life alone' : `ties to ${sim.clans.get(own)?.name ?? 'their clan'}`, value: -vOwn },
      { label: 'reluctance to move', value: -cc.switchMargin },
    ],
  };
}

function invite(sim: Simulation, p: PlayerState, t: number, witnesses: number[]): ActionResult {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  if (!isAlive(sim, t) || t === p.id) return { ok: false, text: 'They are gone.' };
  const name = sim.agents.displayName(t);
  if (c.clanId[t] === p.clanId) return { ok: false, text: `${name} is already with you.` };
  if (ageYears(sim, t) < sim.cfg.life.independentAgeYears) return { ok: false, text: `${name} is too young to choose.` };
  const refused = p.refusedAt[t];
  if (refused !== undefined && sim.tick - refused < pc.inviteCooldownDays) return { ok: false, text: `${name} refused you recently.` };
  const from = c.clanId[t];
  const odds = inviteOdds(sim, t);
  const seenBy = observe(sim, p, t, 'invite', witnesses) ?? [];
  const rng = sim.rng.get('player');
  if (!rng.chance(odds.p)) {
    p.refusedAt[t] = sim.tick;
    // A loyal refuser may report the approach.
    const loyal = 1 - clamp01(sim.rel.affinity(c.slot[t], p.id, sim.tick));
    if (from !== LONER && rng.chance(loyal)) {
      addSuspicion(sim, from, pc.suspicion.refusalReport);
      seenBy.push({ clan: from, amount: pc.suspicion.refusalReport, witnesses: 1 });
      return { ok: true, text: `${name} refuses, and looks toward their camp.`, seenBy };
    }
    return { ok: true, text: `${name} refuses, for now.`, seenBy };
  }
  const ev = moveClan(sim, t, p.clanId, 'joined the stranger', []);
  const partner = c.partnerId[t];
  let extra = '';
  if (isAlive(sim, partner) && c.clanId[partner] === from && from !== LONER) {
    // With their partner gone over, the partner weighs it again (partner loyalty now pulls toward you).
    if (clanValue(sim, partner, p.clanId) >= clanValue(sim, partner, from) - sim.cfg.clans.switchMargin) {
      moveClan(sim, partner, p.clanId, 'followed partner', [ev]);
      extra = ` ${sim.agents.displayName(partner)} comes too.`;
    }
  }
  sim.rebuildDerived();
  const n = sim.clanMembers.get(p.clanId)?.length ?? 1;
  return { ok: true, text: `${name} joins you!${extra} Your clan is ${n} strong.`, seenBy };
}

// ---------------------------------------------------------------- raids

export function raidPower(sim: Simulation, clan: number): { adults: number; power: number } {
  let power = 0;
  let adults = 0;
  for (const m of sim.clanMembers.get(clan) ?? []) {
    if (ageYears(sim, m) < sim.cfg.life.adultAgeYears) continue;
    adults++;
    power += strength(sim, m);
  }
  return { adults, power };
}

export function raidOdds(sim: Simulation, clan: number): number {
  const p = sim.player!;
  const a = raidPower(sim, p.clanId).power;
  const d = raidPower(sim, clan).power * sim.cfg.play.raidHomeBonus;
  return a * a / Math.max(1e-9, a * a + d * d);
}

export function raidCheck(sim: Simulation, clan: number): { ok: boolean; reason: string } {
  const p = sim.player!;
  const pc = sim.cfg.play;
  const target = sim.clans.get(clan);
  if (!target || target.dissolvedTick >= 0 || clan === p.clanId) return { ok: false, reason: 'No such clan.' };
  const adults = raidPower(sim, p.clanId).adults - 1; // not counting you
  if (adults < pc.raidMinAdults) return { ok: false, reason: `You need ${pc.raidMinAdults} grown fighters besides yourself (you have ${Math.max(0, adults)}).` };
  const wait = p.lastRaidTick + pc.raidCooldownDays - sim.tick;
  if (wait > 0) return { ok: false, reason: `Your people need ${wait} more days before another raid.` };
  if (p.raidTarget >= 0) return { ok: false, reason: 'A raid is already planned for tonight.' };
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------- nightly system

/** Called each night (after clan membership). Suspicion fades; furious clans strike; raids resolve. */
export function playerSystem(sim: Simulation): void {
  const p = sim.player;
  if (!p) return;
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  const rng = sim.rng.get('player');
  eatAndRest(sim, p);
  if (p.raidTarget >= 0) resolveRaid(sim, p, p.raidTarget, rng);
  for (const key of Object.keys(p.suspicion).sort((a, b) => Number(a) - Number(b))) {
    const clan = Number(key);
    const cl = sim.clans.get(clan);
    if (!cl || cl.dissolvedTick >= 0) {
      delete p.suspicion[key];
      continue;
    }
    if (p.suspicion[key] >= pc.caughtThreshold) caught(sim, p, clan, rng);
    p.suspicion[key] = Math.max(0, p.suspicion[key] * (1 - pc.suspicionDecayPerDay) - 0.002);
  }
  void c;
}

/** Each night the player eats from what they carry (or their camp store if home) and heals a little. */
function eatAndRest(sim: Simulation, p: PlayerState): void {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  let need = pc.playerNeed;
  const fromHand = Math.min(need, c.carriedFood[p.id]);
  c.carriedFood[p.id] -= fromHand;
  need -= fromHand;
  const camp = sim.clans.get(p.clanId);
  if (need > 0 && camp && Math.hypot(camp.campX - c.x[p.id], camp.campY - c.y[p.id]) < 4) {
    const fromStore = Math.min(need, camp.foodStore);
    camp.foodStore -= fromStore;
    need -= fromStore;
  }
  p.hunger = need > 0.01 ? Math.min(1, p.hunger + pc.hungerPerMissedDay * (need / pc.playerNeed)) : Math.max(0, p.hunger - 0.35);
  c.health[p.id] = Math.min(c.healthCap[p.id], c.health[p.id] + (p.hunger < 0.5 ? pc.playerHealPerNight : 0));
  c.energy[p.id] = 1 - 0.8 * p.hunger;
}

function caught(sim: Simulation, p: PlayerState, clan: number, rng: import('../rng').Rng): void {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  const avenger = sim.leaders.get(clan) ?? strongest(sim, clan);
  const victims = (sim.clanMembers.get(p.clanId) ?? []).filter((m) => m !== p.id);
  // Adults first (they were the ones seen), then anyone.
  const adults = rng.shuffle(victims.filter((m) => ageYears(sim, m) >= sim.cfg.life.independentAgeYears)) as number[];
  const kids = rng.shuffle(victims.filter((m) => ageYears(sim, m) < sim.cfg.life.independentAgeYears)) as number[];
  const doomed = [...adults, ...kids].slice(0, pc.caughtKills);
  const ev = sim.events.emit(sim.tick, {
    type: 'player.caught', causes: [], agents: [p.id, ...(avenger >= 0 ? [avenger] : [])], clans: [clan, p.clanId],
    x: c.x[p.id], y: c.y[p.id], data: { killed: doomed.length },
  });
  sim.clans.get(clan)?.history.push(ev);
  sim.clans.get(p.clanId)?.history.push(ev);
  for (const v of doomed) {
    const d = killAgent(sim, v, CAUSE_VIOLENCE, [ev], [], avenger >= 0 ? avenger : NO_ID);
    if (avenger >= 0) onKilling(sim, avenger, v, d);
  }
  if (doomed.length === 0) {
    // No one to take: they beat the stranger and take what they carry.
    c.health[p.id] = Math.max(0.2, c.health[p.id] - pc.caughtBeating);
    c.carriedFood[p.id] = 0;
  }
  // The clan now openly dislikes you.
  for (const m of sim.clanMembers.get(clan) ?? []) sim.rel.update(c.slot[m], p.id, sim.tick, -0.3, 0, 0.2, 0.05);
  p.suspicion[clan] = pc.caughtResetTo;
  p.caught++;
  sim.rebuildDerived();
}

function strongest(sim: Simulation, clan: number): number {
  let best = NO_ID;
  let bv = -1;
  for (const m of sim.clanMembers.get(clan) ?? []) {
    const s = strength(sim, m);
    if (s > bv) [bv, best] = [s, m];
  }
  return best;
}

function resolveRaid(sim: Simulation, p: PlayerState, clan: number, rng: import('../rng').Rng): void {
  const c = sim.agents.cols;
  const pc = sim.cfg.play;
  p.raidTarget = -1;
  const target = sim.clans.get(clan);
  if (!target || target.dissolvedTick >= 0) return;
  p.lastRaidTick = sim.tick;
  const odds = raidOdds(sim, clan);
  const won = rng.chance(odds);
  const adultsOf = (k: number) => (sim.clanMembers.get(k) ?? []).filter((m) => ageYears(sim, m) >= sim.cfg.life.adultAgeYears);
  const ours = adultsOf(p.clanId).filter((m) => m !== p.id);
  const theirs = adultsOf(clan);
  const loot = won ? target.foodStore * pc.raidLootShare : 0;
  const ev = sim.events.emit(sim.tick, {
    type: 'player.raid', causes: [], agents: [p.id], clans: [p.clanId, clan], x: target.campX, y: target.campY,
    data: { won, odds: Math.round(odds * 100) / 100, loot: Math.round(loot) },
  });
  target.history.push(ev);
  sim.clans.get(p.clanId)?.history.push(ev);
  const theirDead = won ? 1 + rng.int(3) : rng.int(2);
  const ourDead = won ? (rng.chance(0.3) ? 1 : 0) : 1 + rng.int(3);
  const kill = (victims: number[], killers: number[], n: number) => {
    const vs = rng.shuffle([...victims]) as number[];
    for (let k = 0; k < n && k < vs.length; k++) {
      const killer = killers.length ? killers[rng.int(killers.length)] : NO_ID;
      const d = killAgent(sim, vs[k], CAUSE_VIOLENCE, [ev], [], killer);
      if (killer >= 0) onKilling(sim, killer, vs[k], d);
    }
  };
  kill(theirs, [p.id, ...ours], theirDead);
  kill(ours, theirs, ourDead);
  if (won) {
    target.foodStore -= loot;
    sim.clans.get(p.clanId)!.foodStore += loot;
    p.raidsWon++;
  } else {
    p.raidsLost++;
  }
  // Open hostility: no more suspicion, just enmity.
  for (const m of sim.clanMembers.get(clan) ?? []) if (c.alive[m]) sim.rel.update(c.slot[m], p.id, sim.tick, -0.4, 0, 0.4, 0.05);
  p.suspicion[clan] = 0;
  sim.rebuildDerived();
}

// ---------------------------------------------------------------- snapshot

export function snapshotPlayer(p: PlayerState | null): PlayerState | null {
  return p ? JSON.parse(JSON.stringify(p)) : null;
}

/** Replays a recorded game: same seed and config, then the logged actions at their ticks. */
export function replay(sim: Simulation, log: { tick: number; sub: number; a: PlayerAction }[], untilTick: number): void {
  let k = 0;
  const S = sim.cfg.time.subStepsPerDay;
  const applyAt = (sub: number) => {
    while (k < log.length && log[k].tick === sim.tick && log[k].sub === sub) applyPlayerAction(sim, log[k++].a);
  };
  while (sim.tick < untilTick) {
    applyAt(-1);
    sim.beginDay();
    for (let s = 0; s < S; s++) {
      applyAt(s);
      sim.subStep(s);
    }
    applyAt(S);
    sim.endDay();
  }
  applyAt(-1);
}
