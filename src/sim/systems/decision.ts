/**
 * Decision (§5): each morning every independent agent scores its options with
 *   score = urgency x personality x culture x expectedSuccess - cost - risk x (1-boldness) + mood
 * and samples one by softmax (never argmax). Expected success comes from the
 * agent's own memory (place memory, yield/hunt history). The top-3 terms of
 * the chosen option are stored for the inspector ("why").
 * Dependents: nursing infants are carried by their mother; young children
 * stay at camp; older children follow a caregiver (seen setting out).
 */
import type { Simulation } from '../sim';
import {
  GOAL_CARE, GOAL_CARRIED, GOAL_FOLLOW, GOAL_FORAGE, GOAL_HUNT, GOAL_REST, GOAL_SOCIALIZE, NO_ID,
  PHASE_HOME, PHASE_OUT, PHASE_RETURN, REP_LACTATING, REP_PREGNANT,
} from '../state/agents';
import { feltAffinity } from './social';
import { FlowFields } from '../world/flowfield';
import { ageYears, homeTile, isAlive, placeAtHome, tileOf } from './common';

/** Labels for "why" term ids (index = id). */
export const WHY_LABELS = [
  '', 'hungry', 'dependents need food', 'knows a good foraging spot', 'past hunting success',
  'risk of injury', 'unwell', 'injured', 'pregnant', 'young children at camp', 'well fed',
  'bold', 'sticking with plan', 'effort of the trip', 'learning from a caregiver', 'exploring',
  'carrying an infant', 'too young to forage', 'nursing', 'cautious',
  'sociable', 'looking for a partner', 'joining a hunting party', 'hunting together pays more',
];
const T_HUNGRY = 1, T_DEPS = 2, T_SPOT = 3, T_HUNTREC = 4, T_RISK = 5, T_UNWELL = 6, T_INJURED = 7,
  T_PREG = 8, T_KIDS = 9, T_FED = 10, T_BOLD = 11, T_PLAN = 12, T_EFFORT = 13, T_LEARN = 14, T_EXPLORE = 15,
  T_INFANT = 16, T_YOUNG = 17, T_NURSING = 18, T_CAUTIOUS = 19, T_SOCIABLE = 20, T_COURT = 21, T_PARTY = 22,
  T_SYNERGY = 23;

/** Scratch buffers for scoring (no per-decision allocation). */
const MAX_OPT = 8;
const MAX_TERM = 8;
const optGoal = new Int32Array(MAX_OPT);
const optTarget = new Int32Array(MAX_OPT);
const optScore = new Float64Array(MAX_OPT);
const optN = new Int32Array(MAX_OPT);
const optTerm = new Int32Array(MAX_OPT * MAX_TERM);
const optVal = new Float64Array(MAX_OPT * MAX_TERM);
let nOpt = 0;

function beginOption(goal: number, target: number): void {
  optGoal[nOpt] = goal;
  optTarget[nOpt] = target;
  optScore[nOpt] = 0;
  optN[nOpt] = 0;
  nOpt++;
}

/** Adds a utility term to the option being built (zero terms are skipped for "why"). */
function term(t: number, v: number): void {
  const o = nOpt - 1;
  optScore[o] += v;
  if (v === 0 || optN[o] >= MAX_TERM) return;
  const k = o * MAX_TERM + optN[o]++;
  optTerm[k] = t;
  optVal[k] = v;
}


export function decisionSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const l = sim.cfg.life;
  const rng = sim.rng.get('decision');
  const order = sim.shuffledLiving(rng);
  const adults: number[] = [];
  const followers: number[] = [];

  for (const id of order) {
    c.homeTileToday[id] = homeTile(sim, id);
    c.followId[id] = NO_ID;
    c.partyLeader[id] = NO_ID;
    c.todayYield[id] = 0;
    c.moveBudget[id] = 0;
    const age = ageYears(sim, id);
    if (age < l.weaningAgeYears) {
      carriedOrHome(sim, id);
      continue;
    }
    if (age < l.followCaregiverFromYears) {
      c.goal[id] = GOAL_REST;
      setHome(sim, id);
      sim.mind.setWhy(c.slot[id], GOAL_REST, [T_YOUNG], [1]);
      continue;
    }
    if (age < l.independentAgeYears) {
      followers.push(id);
      continue;
    }
    adults.push(id);
    decideAdult(sim, id, rng);
  }

  formParties(sim, adults, rng);
  // Older children see who is setting out and tag along with a caregiver.
  for (const id of followers) decideFollower(sim, id, rng);
  // Infants go wherever their mother goes.
  for (const id of order) {
    if (c.goal[id] !== GOAL_CARRIED) continue;
    const m = c.motherId[id];
    if (isAlive(sim, m) && c.goal[m] !== GOAL_REST && c.goal[m] !== GOAL_CARE && c.phase[m] !== PHASE_HOME) c.followId[id] = m;
    else c.followId[id] = NO_ID;
  }
}

function setHome(sim: Simulation, id: number): void {
  const c = sim.agents.cols;
  if (c.phase[id] === PHASE_HOME || tileOf(sim, id) === c.homeTileToday[id]) {
    c.phase[id] = PHASE_HOME;
    placeAtHome(sim, id);
  } else {
    c.phase[id] = PHASE_RETURN;
  }
}

function carriedOrHome(sim: Simulation, id: number): void {
  const c = sim.agents.cols;
  c.goal[id] = GOAL_CARRIED;
  setHome(sim, id);
  sim.mind.setWhy(c.slot[id], GOAL_CARRIED, [T_NURSING], [1]);
}

/** Hunger urgency: convex in the energy deficit. */
function hunger(sim: Simulation, energy: number): number {
  return Math.pow(1 - energy, sim.cfg.decision.hungerExponent);
}

/** Urgency from hungry dependents at camp, weighted by relatedness (kin the agent knows). */
function dependentsNeed(sim: Simulation, id: number): { need: number; youngKids: number; infant: boolean } {
  const c = sim.agents.cols;
  const l = sim.cfg.life;
  const clan = c.clanId[id];
  let need = 0;
  let youngKids = 0;
  let infant = false;
  const kw = 1 + c.cKinWeight[id];
  const kin = sim.kin.kinOf(id);
  const rs = sim.kin.rOf(id);
  for (let k = 0; k < kin.length; k++) {
    const d = kin[k];
    if (!c.alive[d] || c.clanId[d] !== clan) continue;
    const a = ageYears(sim, d);
    if (a >= l.dependentUntilYears) continue;
    const r = rs[k];
    need += sim.cfg.provision.childWeight * r * kw * hunger(sim, c.energy[d]);
    if (a >= l.weaningAgeYears && a < l.followCaregiverFromYears) youngKids += r;
    if (a < l.weaningAgeYears && c.motherId[d] === id) infant = true;
  }
  return { need: need * sim.cfg.decision.provisionWeight, youngKids, infant };
}

function decideAdult(sim: Simulation, id: number, rng: import('../rng').Rng): void {
  const c = sim.agents.cols;
  const dc = sim.cfg.decision;
  const tick = sim.tick;
  const slot = c.slot[id];

  // Away from home at dawn (e.g. benighted): head back first.
  const home = c.homeTileToday[id];
  if (c.phase[id] !== PHASE_HOME && tileOf(sim, id) !== home) {
    c.phase[id] = PHASE_RETURN;
    sim.mind.setWhy(slot, c.goal[id], [T_PLAN], [1]);
    return;
  }
  c.phase[id] = PHASE_HOME;

  const e = c.energy[id];
  const h = hunger(sim, e);
  const deps = dependentsNeed(sim, id);
  const field = sim.fields.get(home);
  const S = sim.cfg.time.subStepsPerDay;
  const speed = sim.cfg.movement.speedCostPerStep;
  const bold = c.boldness[id];
  const carrying = deps.infant; // a nursing mother carries her infant when she leaves camp
  nOpt = 0;
  const sc = sim.cfg.social;
  const need1 = sim.cfg.metabolism.adultNeed;
  const effortWeight = dc.effortWeight;
  // --- Forage (plants) ---
  // expectedSuccess = expected NET food of the trip (yield minus its energy cost), from memory.
  const places = choosePlaces(sim, id, field, rng);
  const fp = places.plant;
  const fTravel = Math.ceil(fp.dist / speed);
  const forageRate = sim.cfg.resources.forageRatePerStep * (0.5 + c.foragingSkill[id]) * (1 - 0.5 * c.injury[id]);
  const fWork = Math.max(0, S - 2 * fTravel - 1);
  const fExpected = Math.min(fp.expected, fWork * forageRate, sim.cfg.resources.carryCapacity);
  const fEffort = (sim.cfg.metabolism.walkCostPerStep * 2 * fTravel + sim.cfg.metabolism.workCostPerStep * fWork) * (carrying ? 1.3 : 1);
  const fSucc = Math.max(-0.5, Math.min(2, (fExpected - fEffort) / need1));
  beginOption(GOAL_FORAGE, fp.tile);
  term(T_HUNGRY, h * fSucc);
  term(T_DEPS, deps.need * fSucc);
  term(fp.explore ? T_EXPLORE : T_SPOT, 0.1 * fSucc);
  term(T_EFFORT, -effortWeight * fEffort);

  // --- Hunt ---
  const hp = places.game;
  const hTravel = Math.ceil(hp.dist / speed);
  const hWork = Math.max(0, S - 2 * hTravel - 1);
  const infantPenalty = carrying ? sim.cfg.resources.huntCarryingInfantFactor : 1;
  const pStep = sim.cfg.resources.huntSuccessPerStep * hp.expected * (0.5 + 0.6 * c.build[id]) * infantPenalty;
  // Physics the agent can see (game seen) blended with its own hunting record (memory).
  const pDay = 0.5 * (1 - Math.pow(1 - pStep, hWork)) + 0.5 * c.huntSuccessEma[id] * infantPenalty;
  const hEffort = sim.cfg.metabolism.walkCostPerStep * 2 * hTravel + sim.cfg.metabolism.workCostPerStep * hWork;
  const hSucc = Math.max(-0.5, Math.min(2, (pDay * sim.cfg.resources.huntYieldMean - hEffort) / need1));
  const injuryRisk = sim.cfg.resources.huntInjuryPerStep * hWork * 100 * (carrying ? 3 : 1);
  const persona = 1 + dc.huntBoldnessBias * (bold - 0.5) * 2;
  beginOption(GOAL_HUNT, hp.tile);
  term(T_HUNGRY, h * hSucc * persona);
  term(T_DEPS, deps.need * hSucc * persona);
  term(T_HUNTREC, 0.1 * hSucc);
  term(carrying ? T_INFANT : T_RISK, -injuryRisk * dc.huntRiskWeight * (1 - bold));
  term(T_EFFORT, -effortWeight * hEffort);
  term(T_BOLD, dc.huntBoldnessBias * (bold - 0.5) * 0.2);

  // --- Rest ---
  const late = c.repState[id] === REP_PREGNANT && c.repUntilTick[id] - tick < 60 ? 1 : 0;
  beginOption(GOAL_REST, NO_ID);
  term(T_FED, dc.restBase + (e > 0.85 ? 0.1 : 0));
  // Illness and injury call for rest, but hunger overrides them (a starving person still goes out).
  term(T_UNWELL, dc.restHealthWeight * (1 - c.health[id]) ** 2 * (1 - h));
  term(T_INJURED, dc.restInjuryWeight * c.injury[id] * (1 - h));
  term(T_PREG, dc.restPregnancyWeight * late);
  term(T_CAUTIOUS, 0.05 * c.fear[id]);

  // --- Care for children (stay at camp with young kin) ---
  if (deps.youngKids > 0) {
    beginOption(GOAL_CARE, NO_ID);
    term(T_KIDS, (dc.careBase + dc.careChildWeight * deps.youngKids) * (1 - h));
    term(T_NURSING, c.repState[id] === REP_LACTATING ? 0.05 : 0);
  }

  // --- Socialize (stay at camp and spend time with people) ---
  const single = c.partnerId[id] === NO_ID && ageYears(sim, id) >= sim.cfg.life.pairMinAgeYears;
  beginOption(GOAL_SOCIALIZE, NO_ID);
  term(T_SOCIABLE, (sc.socializeBase + sc.socializeSociability * c.sociability[id]) * (1 - h));
  term(T_COURT, single ? sc.courtWeight * (1 - h) : 0);

  // Hysteresis: stick with yesterday's plan unless in an emergency.
  if (e > dc.emergencyEnergy) {
    for (let k = 0; k < nOpt; k++) {
      if (optGoal[k] !== c.goal[id]) continue;
      const save = nOpt;
      nOpt = k + 1;
      term(T_PLAN, dc.commitmentBonus);
      nOpt = save;
    }
  }

  const pick = rng.softmax(optScore.subarray(0, nOpt), dc.temperature);
  const goal = optGoal[pick];
  c.goal[id] = goal;
  c.goalUntilTick[id] = tick + 1;
  storeWhy(sim, slot, pick);
  if (goal === GOAL_FORAGE || goal === GOAL_HUNT) startTrip(sim, id, optTarget[pick], field);
  else setHome(sim, id);
}

const whyT = [0, 0, 0];
const whyV = [0, 0, 0];

/** Stores the chosen option's 3 largest-magnitude terms (insertion top-3, no sort). */
function storeWhy(sim: Simulation, slot: number, o: number): void {
  whyT[0] = whyT[1] = whyT[2] = 0;
  whyV[0] = whyV[1] = whyV[2] = 0;
  for (let k = 0; k < optN[o]; k++) {
    const t = optTerm[o * MAX_TERM + k];
    const v = optVal[o * MAX_TERM + k];
    const a = Math.abs(v);
    let pos = 3;
    while (pos > 0 && a > Math.abs(whyV[pos - 1])) pos--;
    if (pos >= 3) continue;
    for (let j = 2; j > pos; j--) {
      whyT[j] = whyT[j - 1];
      whyV[j] = whyV[j - 1];
    }
    whyT[pos] = t;
    whyV[pos] = v;
  }
  sim.mind.setWhy(slot, optGoal[o], whyT, whyV);
}

interface PlaceChoice {
  tile: number;
  expected: number;
  dist: number;
  explore: boolean;
}

let freshTable = new Float64Array(0);
let freshStale = -1;
/** exp(-age/stale) by lookup (ages beyond the table are ~0). */
function freshness(ageDays: number, stale: number): number {
  if (stale !== freshStale) {
    freshStale = stale;
    freshTable = new Float64Array(Math.ceil(stale * 12));
    for (let i = 0; i < freshTable.length; i++) freshTable[i] = Math.exp(-i / stale);
  }
  return ageDays < freshTable.length ? freshTable[ageDays] : 0;
}

const pCand: number[] = [];
const pVal: number[] = [];
const pExp: number[] = [];
const gCand: number[] = [];
const gVal: number[] = [];
const gExp: number[] = [];

function choosePlaces(
  sim: Simulation, id: number, field: Float64Array, rng: import('../rng').Rng,
): { plant: PlaceChoice; game: PlaceChoice } {
  const c = sim.agents.cols;
  const m = sim.mind;
  const dc = sim.cfg.decision;
  const slot = c.slot[id];
  const pc = m.placeCap;
  const n = m.placeCount[slot];
  const base = slot * pc;
  const stale = sim.cfg.memory.placeStaleDays;
  const priorPlant = dc.expectedYieldPrior * 3;
  const priorGame = 0.3;
  const maxCost = maxTripCost(sim);
  pCand.length = pVal.length = pExp.length = gCand.length = gVal.length = gExp.length = 0;
  for (let k = 0; k < n; k++) {
    const t = m.placeTile[base + k];
    const d = field[t];
    if (!(d <= maxCost) || d === 0) continue;
    const fresh = freshness(sim.tick - m.placeTick[base + k], stale);
    const ep = fresh * m.placePlant[base + k] + (1 - fresh) * priorPlant;
    const eg = fresh * m.placeGame[base + k] + (1 - fresh) * priorGame;
    pCand.push(t);
    pExp.push(ep);
    pVal.push(ep / 3 - 0.02 * d);
    gCand.push(t);
    gExp.push(eg);
    gVal.push(eg - 0.02 * d);
  }
  const home = c.homeTileToday[id];
  const pick = (cand: number[], val: number[], exp: number[], prior: number): PlaceChoice => {
    if (cand.length === 0 || rng.chance(dc.exploreProb)) {
      const t = randomReachable(sim, field, home, rng, maxCost);
      if (t >= 0) return { tile: t, expected: prior, dist: field[t], explore: true };
      if (cand.length === 0) return { tile: NO_ID, expected: 0, dist: 0, explore: true };
    }
    const k = rng.softmax(val, dc.placeSoftmaxTemperature);
    return { tile: cand[k], expected: exp[k], dist: field[cand[k]], explore: false };
  };
  const plant = pick(pCand, pVal, pExp, priorPlant);
  const game = pick(gCand, gVal, gExp, priorGame);
  return { plant, game };
}

/** Farthest cost-distance that still leaves time to work and return within the day. */
export function maxTripCost(sim: Simulation): number {
  const S = sim.cfg.time.subStepsPerDay;
  const speed = sim.cfg.movement.speedCostPerStep;
  return Math.min(sim.cfg.decision.forageRadiusCost, speed * Math.floor((S - 2) / 2));
}

/** A random tile within the reachable disc around home (sampled in a square around it). */
function randomReachable(sim: Simulation, field: Float64Array, home: number, rng: import('../rng').Rng, R: number): number {
  const W = sim.world.width;
  const H = sim.world.height;
  const hx = home % W;
  const hy = (home / W) | 0;
  const r = Math.ceil(R);
  for (let tries = 0; tries < 12; tries++) {
    const x = hx + rng.int(2 * r + 1) - r;
    const y = hy + rng.int(2 * r + 1) - r;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const t = y * W + x;
    const d = field[t];
    if (d > 0 && d <= R && sim.world.plantCapacity[t] > 0) return t;
  }
  return -1;
}

/** Builds the outbound path home->target by descending the home field from the target. */
export function startTrip(sim: Simulation, id: number, target: number, field: Float64Array): void {
  const c = sim.agents.cols;
  const m = sim.mind;
  const slot = c.slot[id];
  if (target < 0) {
    c.goal[id] = GOAL_REST;
    setHome(sim, id);
    return;
  }
  const maxP = m.maxPath;
  const tmp: number[] = [];
  let t = target;
  while (t >= 0 && field[t] > 0 && tmp.length < maxP) {
    tmp.push(t);
    t = FlowFields.stepToward(field, sim.world, t);
  }
  // tmp runs target -> (just before) home; reverse into the path buffer.
  const len = tmp.length;
  for (let k = 0; k < len; k++) m.pathTiles[slot * maxP + k] = tmp[len - 1 - k];
  m.pathLen[slot] = len;
  m.pathPos[slot] = 0;
  c.targetTile[id] = len > 0 ? tmp[0] : NO_ID;
  c.phase[id] = len > 0 ? PHASE_OUT : PHASE_HOME;
}

/** Children 8-12 tag along with a kin adult who is heading out (to learn), else stay. */
function decideFollower(sim: Simulation, id: number, rng: import('../rng').Rng): void {
  const c = sim.agents.cols;
  const kin = sim.kin.kinOf(id);
  const rs = sim.kin.rOf(id);
  const cands: number[] = [];
  const vals: number[] = [];
  for (let k = 0; k < kin.length; k++) {
    const a = kin[k];
    if (!c.alive[a] || c.clanId[a] !== c.clanId[id]) continue;
    if ((c.goal[a] !== GOAL_FORAGE && c.goal[a] !== GOAL_HUNT) || c.phase[a] !== PHASE_OUT) continue;
    if (ageYears(sim, a) < sim.cfg.life.adultAgeYears) continue;
    cands.push(a);
    vals.push(rs[k] + 0.3 * c.foragingSkill[a] + (c.goal[a] === GOAL_FORAGE ? 0.2 : 0));
  }
  const hungerV = hunger(sim, c.energy[id]);
  if (cands.length === 0 || rng.chance(0.25 * (1 - hungerV))) {
    c.goal[id] = GOAL_REST;
    setHome(sim, id);
    sim.mind.setWhy(c.slot[id], GOAL_REST, [T_YOUNG], [1]);
    return;
  }
  const k = rng.softmax(vals, 0.2);
  c.goal[id] = GOAL_FOLLOW;
  c.followId[id] = cands[k];
  c.phase[id] = PHASE_OUT;
  sim.mind.setWhy(c.slot[id], GOAL_FOLLOW, [T_LEARN, T_HUNGRY], [vals[k], hungerV]);
}

/**
 * Hunting parties (§3, §5 "Hunt: solo or join group"). Hunters see who else is
 * heading out to hunt this morning and may join a clanmate's party when the
 * expected share (group success with synergy, bigger game, split n ways) plus
 * their liking of the leader beats hunting alone. Joiners walk with the leader.
 */
function formParties(sim: Simulation, adults: number[], rng: import('../rng').Rng): void {
  const c = sim.agents.cols;
  const hc = sim.cfg.hunting;
  const rc = sim.cfg.resources;
  sim.parties.clear();
  const leaders: number[] = [];
  for (const id of adults) {
    if (c.goal[id] !== GOAL_HUNT || c.phase[id] !== PHASE_OUT) continue;
    const pSolo = Math.max(0.02, c.huntSuccessEma[id]);
    const opts: number[] = [];
    const vals: number[] = [];
    // Option 0: go alone (and become a potential leader).
    opts.push(NO_ID);
    vals.push(pSolo * rc.huntYieldMean);
    for (const L of leaders) {
      if (c.clanId[L] !== c.clanId[id]) continue;
      const party = sim.parties.get(L)!;
      const n = party.length + 2;
      if (n > hc.maxParty) continue;
      let miss = 1 - Math.max(0.02, c.huntSuccessEma[L]) * (1 + hc.groupSynergy * (n - 1));
      for (const m of party) miss *= 1 - Math.max(0.02, c.huntSuccessEma[m]) * (1 + hc.groupSynergy * (n - 1));
      miss *= 1 - pSolo * (1 + hc.groupSynergy * (n - 1));
      const pGroup = 1 - Math.max(0, miss);
      const share = (pGroup * rc.huntYieldMean * (1 + hc.bigGamePerMember * (n - 1))) / n;
      opts.push(L);
      vals.push(share + hc.joinAffinityWeight * feltAffinity(sim, id, L));
    }
    const k = rng.softmax(vals, hc.joinTemperature);
    const L = opts[k];
    if (L === NO_ID) {
      leaders.push(id);
      sim.parties.set(id, []);
      continue;
    }
    sim.parties.get(L)!.push(id);
    c.partyLeader[id] = L;
    c.followId[id] = L;
    c.targetTile[id] = c.targetTile[L];
    sim.mind.setWhy(c.slot[id], GOAL_HUNT, [T_PARTY, T_SYNERGY], [vals[k], vals[k] - vals[0]]);
  }
}
