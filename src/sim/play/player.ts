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
import { makeClanName, makeSyllableSet } from '../names';

export type HelpVerb = 'talk' | 'give' | 'tend' | 'back';

/** A player action, resolved by the host (witnesses included) and logged with its tick. */
export type PlayerAction =
  | { kind: 'spawn'; name: string; female: boolean }
  | { kind: 'pos'; x: number; y: number }
  | { kind: 'gather' }
  | { kind: 'take'; amount: number }
  | { kind: 'help'; verb: HelpVerb; target: number; witnesses: number[] }
  | { kind: 'invite'; target: number; witnesses: number[] }
  | { kind: 'raid'; clan: number };

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
  log: { tick: number; a: PlayerAction }[];
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
    sim.player!.log.push({ tick: sim.tick, a });
    return r;
  }
  const p = sim.player;
  if (!p) return { ok: false, text: 'no player' };
  const r = apply(sim, p, a);
  if (r.ok) {
    // Consecutive position updates within one tick collapse to the last (exact: only the final one matters).
    const last = p.log[p.log.length - 1];
    if (a.kind === 'pos' && last && last.tick === sim.tick && last.a.kind === 'pos') last.a = a;
    else p.log.push({ tick: sim.tick, a });
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
      if (p.gatherTick !== sim.tick) {
        p.gatherTick = sim.tick;
        p.gathersToday = 0;
      }
      if (p.gathersToday >= pc.gatherActionsPerDay) return { ok: false, text: 'You are too tired to gather more today.' };
      const t = Math.floor(c.y[me]) * sim.world.width + Math.floor(c.x[me]);
      const room = pc.carryCapacity - c.carriedFood[me];
      const got = Math.min(pc.gatherPerAction, sim.world.plantFood[t], room);
      if (room <= 0.01) return { ok: false, text: 'Your hands are full.' };
      if (got < 0.1) return { ok: false, text: 'Nothing left to gather here.' };
      sim.world.plantFood[t] -= got;
      c.carriedFood[me] += got;
      p.gathersToday++;
      return { ok: true, text: `Gathered ${got.toFixed(1)} food.` };
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
    refusedAt: {}, lastHelp: {}, caught: 0, raidsWon: 0, raidsLost: 0, log: [],
  };
  clan.founding.founderId = id;
  clan.founding.eventId = sim.events.emit(sim.tick, {
    type: 'clan.founded', causes: [], agents: [id], clans: [clan.id], x: site.x, y: site.y, data: { name: clan.name, player: true },
  });
  clan.history.push(clan.founding.eventId);
  sim.rebuildDerived();
  sim.leaders.set(clan.id, id);
  return { ok: true, text: `You arrive alone and make camp: ${sim.clans.label(clan.id)}.` };
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
  const z = regard + vYou + food - vOwn - cc.switchMargin;
  const p = 1 / (1 + Math.exp(-z / pc.inviteTemperature));
  return {
    p,
    parts: [
      { label: 'how they feel about you', value: regard },
      { label: 'ties to your people', value: vYou },
      { label: 'food in your camp', value: food },
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
export function replay(sim: Simulation, log: { tick: number; a: PlayerAction }[], untilTick: number): void {
  let k = 0;
  while (sim.tick < untilTick || k < log.length) {
    while (k < log.length && log[k].tick === sim.tick) applyPlayerAction(sim, log[k++].a);
    if (sim.tick >= untilTick) break;
    sim.step();
  }
}
