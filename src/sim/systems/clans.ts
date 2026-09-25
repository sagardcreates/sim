/**
 * Clan dynamics (§7). Clans are derived from individuals: membership changes
 * only through individual primitives (ChangeClan: leave / request join /
 * split) and host acceptance, expulsion by hostile members, and fission.
 *  - loyalty(i): affinity to members + kin in clan x kinWeight + partner +
 *    deference to leadership + food satisfaction - internal grudges.
 *  - Staggered monthly: an adult compares loyalty with the best alternative
 *    clan it knows (people it knows there) and asks to join if clearly better.
 *  - Host accepts with probability from members' affinity to the applicant,
 *    host food per capita, applicant reputation and host outgroupTrust.
 *  - Yearly: expulsion; fission via community detection when a clan is large
 *    relative to local carrying capacity and internally split.
 */
import type { Simulation } from '../sim';
import type { Rng } from '../rng';
import { makeClanName, makeSyllableSet } from '../names';
import { NO_ID, PHASE_HOME, SEX_FEMALE, SEX_MALE } from '../state/agents';
import { ageYears, isAlive, placeAtHome } from './common';
import { feltAffinity } from './social';
import { maxTripCost } from './decision';
import { nearestCampSite } from './camps';

export const LONER = NO_ID;

/** Value of belonging to clan `k` for agent `i`, from i's own knowledge. */
export function clanValue(sim: Simulation, i: number, k: number): number {
  const c = sim.agents.cols;
  const cc = sim.cfg.clans;
  const members = sim.clanMembers.get(k) ?? [];
  let aff = 0;
  let grudge = 0;
  const slot = c.slot[i];
  sim.rel.forEach(slot, sim.tick, (other, v) => {
    if (!c.alive[other] || c.clanId[other] !== k || other === i) return;
    aff += v.aff;
    grudge += v.grudge;
  });
  let kin = 0;
  const kinIds = sim.kin.kinOf(i);
  const rs = sim.kin.rOf(i);
  for (let x = 0; x < kinIds.length; x++) {
    const j = kinIds[x];
    if (c.alive[j] && c.clanId[j] === k) kin += rs[x];
  }
  const p = c.partnerId[i];
  const partner = isAlive(sim, p) && c.clanId[p] === k ? cc.partnerLoyalty : 0;
  let value = cc.affinityWeight * aff + cc.kinWeight * c.cKinWeight[i] * kin + partner - cc.grudgeWeight * grudge;
  value += cc.leadershipWeight * sim.deferenceToLeadership(i, k);
  if (k === c.clanId[i]) value += cc.foodWeight * (c.condition[i] - 0.8) + cc.stayBias;
  void members;
  return value;
}

export function loyalty(sim: Simulation, i: number): number {
  const k = sim.agents.cols.clanId[i];
  return k === LONER ? 0 : clanValue(sim, i, k);
}

/** Clans where i knows someone (relationship map or kin). */
function knownClans(sim: Simulation, i: number): number[] {
  const c = sim.agents.cols;
  const set = new Set<number>();
  sim.rel.forEach(c.slot[i], sim.tick, (o) => {
    if (c.alive[o] && c.clanId[o] !== LONER) set.add(c.clanId[o]);
  });
  for (const j of sim.kin.kinOf(i)) if (c.alive[j] && c.clanId[j] !== LONER) set.add(c.clanId[j]);
  set.delete(c.clanId[i]);
  return [...set].sort((a, b) => a - b);
}

/** Probability that clan k accepts applicant i (host members' view; no global reputation). */
export function acceptProb(sim: Simulation, i: number, k: number): number {
  const c = sim.agents.cols;
  const cc = sim.cfg.clans;
  const members = sim.clanMembers.get(k) ?? [];
  if (members.length === 0) return 0;
  let affSum = 0;
  let affN = 0;
  let trust = 0;
  let cond = 0;
  let adults = 0;
  for (const j of members) {
    if (ageYears(sim, j) < sim.cfg.life.adultAgeYears) continue;
    adults++;
    trust += c.cOutgroupTrust[j];
    cond += c.condition[j];
    const v = sim.rel.get(c.slot[j], i, sim.tick);
    if (v) {
      affSum += v.aff + sim.cfg.social.kinAffinityBoost * c.cKinWeight[j] * sim.relatedness(j, i) - v.grudge;
      affN++;
    } else if (sim.relatedness(j, i) > 0) {
      affSum += sim.cfg.social.kinAffinityBoost * c.cKinWeight[j] * sim.relatedness(j, i);
      affN++;
    }
  }
  if (adults === 0) return 0;
  const clan = sim.clans.get(k)!;
  const foodPerCapita = clan.foodStore / members.length + (cond / adults - 0.8) * 5;
  const reputation = affN > 0 ? affSum / affN : 0;
  const z = cc.joinBase + cc.joinAffWeight * reputation + cc.joinTrustWeight * (trust / adults - 0.5)
    + cc.joinFoodWeight * foodPerCapita;
  return 1 / (1 + Math.exp(-z / cc.joinTemperature));
}

/**
 * Moves agent (and its dependent children living with it) to clan `to`
 * (LONER for none). Emits leave/join events and returns the join event id.
 */
export function moveClan(sim: Simulation, i: number, to: number, reason: string, causes: number[]): number {
  const c = sim.agents.cols;
  const from = c.clanId[i];
  if (from === to) return -1;
  const movers = [i, ...dependentsOf(sim, i)];
  // Kin (known, adults excluded from dependents) in origin vs destination, for experiment 8.
  let kinFrom = 0;
  let kinTo = 0;
  const kinIds = sim.kin.kinOf(i);
  for (const k of kinIds) {
    if (!c.alive[k] || movers.includes(k)) continue;
    if (from !== LONER && c.clanId[k] === from) kinFrom++;
    if (to !== LONER && c.clanId[k] === to) kinTo++;
  }
  let leaveEv = -1;
  // A leader who leaves stops being that clan's leader at once (derived label follows membership).
  if (from !== LONER && sim.leaders.get(from) === i) {
    sim.leaders.delete(from);
    const ev = sim.events.emit(sim.tick, {
      type: 'leader.changed', causes: [], agents: [i], clans: [from], data: { leader: NO_ID, previous: i, share: 0, reason: 'left the clan' },
    });
    sim.clans.get(from)?.history.push(ev);
  }
  if (from !== LONER) {
    leaveEv = sim.events.emit(sim.tick, {
      type: 'agent.left_clan', causes, agents: [i], clans: [from], x: c.x[i], y: c.y[i], data: { reason, to, with: movers.length - 1 },
    });
    sim.clans.get(from)?.history.push(leaveEv);
  }
  // A loner makes a home near water close to where they are (or stays put if none nearby).
  const W = sim.world.width;
  const site = to === LONER ? nearestCampSite(sim, Math.floor(c.y[i]) * W + Math.floor(c.x[i])) : -1;
  for (const m of movers) {
    c.clanId[m] = to;
    if (to === LONER) {
      c.ownHomeX[m] = site >= 0 ? (site % W) + 0.5 : c.x[i];
      c.ownHomeY[m] = site >= 0 ? ((site / W) | 0) + 0.5 : c.y[i];
    }
    c.homeTileToday[m] = sim.homeTileOf(m);
    if (c.phase[m] === PHASE_HOME) placeAtHome(sim, m);
  }
  let ev = leaveEv;
  if (to !== LONER) {
    ev = sim.events.emit(sim.tick, {
      type: 'agent.joined_clan', causes: leaveEv > 0 ? [leaveEv, ...causes] : causes, agents: [i], clans: [to],
      x: c.x[i], y: c.y[i], data: { reason, from, with: movers.length - 1, kinFrom, kinTo },
    });
    sim.clans.get(to)?.history.push(ev);
  }
  sim.rebuildDerived();
  sim.stats.day.clanChanges++;
  return ev;
}

/** Children below independence who live with i (i is their mother, or their father if the mother is gone/elsewhere). */
function dependentsOf(sim: Simulation, i: number): number[] {
  const c = sim.agents.cols;
  const out: number[] = [];
  for (const k of sim.pedigree.childrenOf(i)) {
    if (!c.alive[k] || c.clanId[k] !== c.clanId[i]) continue;
    if (ageYears(sim, k) >= sim.cfg.life.independentAgeYears) continue;
    const m = c.motherId[k];
    if (m === i || !isAlive(sim, m) || c.clanId[m] !== c.clanId[i]) out.push(k);
  }
  return out;
}

/** Staggered monthly ChangeClan decisions (each adult on its own day of the month). */
export function clanMembershipSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const cc = sim.cfg.clans;
  const rng = sim.rng.get('clans');
  const period = cc.loyaltyCheckDays;
  for (const i of sim.shuffledLiving(rng)) {
    if (!c.alive[i] || (i + sim.tick) % period !== 0) continue;
    if (ageYears(sim, i) < sim.cfg.life.independentAgeYears) continue;
    const own = c.clanId[i];
    const ownVal = own === LONER ? cc.lonerValue : clanValue(sim, i, own);
    let best = -1;
    let bestVal = -Infinity;
    for (const k of knownClans(sim, i)) {
      const clan = sim.clans.get(k);
      if (!clan || clan.dissolvedTick >= 0) continue;
      const v = clanValue(sim, i, k);
      if (v > bestVal) {
        bestVal = v;
        best = k;
      }
    }
    // A partner in the same clan must also prefer the move, or the pair stays.
    if (best >= 0 && bestVal - ownVal > cc.switchMargin) {
      const p = c.partnerId[i];
      if (isAlive(sim, p) && c.clanId[p] === own && own !== LONER) {
        if (clanValue(sim, p, best) < clanValue(sim, p, own) - cc.switchMargin) continue;
      }
      if (rng.chance(acceptProb(sim, i, best))) {
        const ev = moveClan(sim, i, best, 'sought a better clan', []);
        if (isAlive(sim, p) && c.clanId[p] === own && own !== LONER) moveClan(sim, p, best, 'followed partner', [ev]);
        continue;
      }
      sim.events.emit(sim.tick, { type: 'agent.rejected', causes: [], agents: [i], clans: [best], data: { from: own } });
    }
    if (own !== LONER && ownVal < cc.leaveThreshold) moveClan(sim, i, LONER, 'left to live alone', []);
  }
}

/** Residence rule after a cross-clan pairing (§6, §7): who changes clan. */
export function applyResidence(sim: Simulation, a: number, b: number, pairEvent: number): void {
  const c = sim.agents.cols;
  if (c.clanId[a] === c.clanId[b]) return;
  const f = c.sex[a] === SEX_FEMALE ? a : b;
  const m = f === a ? b : a;
  // 0: man moves to wife's clan, 1: woman moves to husband's, 2: either.
  const rf = c.cResidence[f];
  const rm = c.cResidence[m];
  let mover: number;
  if (rf === rm && rf !== 2) mover = rf === 0 ? m : f;
  else if (rf === 2 && rm !== 2) mover = rm === 0 ? m : f;
  else if (rm === 2 && rf !== 2) mover = rf === 0 ? m : f;
  else mover = loyalty(sim, f) < loyalty(sim, m) ? f : m; // disagreement or both "either"
  const host = mover === f ? c.clanId[m] : c.clanId[f];
  moveClan(sim, mover, host, 'married in', [pairEvent]);
}

/** Yearly: expulsion and fission. */
export function yearlyClanSystem(sim: Simulation): void {
  expulsion(sim);
  for (const clan of sim.clans.extant()) fission(sim, clan.id, sim.rng.get('fission'));
}

function expulsion(sim: Simulation): void {
  const c = sim.agents.cols;
  const cc = sim.cfg.clans;
  for (const clan of sim.clans.extant()) {
    const members = (sim.clanMembers.get(clan.id) ?? []).filter((id) => ageYears(sim, id) >= sim.cfg.life.adultAgeYears);
    if (members.length < 4) continue;
    const top = sim.topStatus(clan.id, 3);
    for (const i of members) {
      if (top.includes(i)) continue;
      let sum = 0;
      let n = 0;
      for (const j of members) {
        if (j === i) continue;
        const v = sim.rel.get(c.slot[j], i, sim.tick);
        if (!v) continue;
        sum += v.aff - v.grudge;
        n++;
      }
      if (n < 3 || sum / n > cc.expelAffinity) continue;
      if (!top.every((t) => feltAffinity(sim, t, i) - (sim.rel.get(c.slot[t], i, sim.tick)?.grudge ?? 0) < 0)) continue;
      const ev = sim.events.emit(sim.tick, { type: 'agent.expelled', causes: [], agents: [i, ...top], clans: [clan.id], x: c.x[i], y: c.y[i], data: { meanAffinity: sum / n } });
      moveClan(sim, i, LONER, 'expelled', [ev]);
    }
  }
}

/** Rough people-supportable estimate near the camp: sustainable plant regrowth within trip range. */
export function localCapacity(sim: Simulation, campX: number, campY: number): number {
  const w = sim.world;
  const field = sim.fields.get(Math.floor(campY) * w.width + Math.floor(campX));
  const R = maxTripCost(sim);
  const rc = sim.cfg.resources;
  let supply = 0;
  for (let t = 0; t < field.length; t++) {
    if (!(field[t] <= R)) continue;
    // Max sustainable yield of logistic regrowth + seeding, at mean season.
    supply += w.regrowthRate[t] * (rc.plantRegrowth * w.plantCapacity[t] / 4 + rc.plantSeedRate * w.plantCapacity[t]);
  }
  return supply / sim.cfg.metabolism.adultNeed;
}

/**
 * Fission (§7): only way new clans are born. Label propagation on the internal
 * affinity graph; if modularity is high and a community is viable (>= 6 adults,
 * >= 2 fertile women, >= 2 men) with a focal member it defers to, that
 * community founds a new camp at a good remembered place away from the parent.
 */
function fission(sim: Simulation, clanId: number, rng: Rng): void {
  const c = sim.agents.cols;
  const cc = sim.cfg.clans;
  const clan = sim.clans.get(clanId)!;
  const members = sim.clanMembers.get(clanId) ?? [];
  if (members.length < cc.fissionMinSize) return;
  const cap = localCapacity(sim, clan.campX, clan.campY);
  if (members.length < cc.fissionCapacityRatio * cap) return;
  const adults = members.filter((id) => ageYears(sim, id) >= sim.cfg.life.adultAgeYears);
  const n = adults.length;
  if (n < 2 * cc.fissionMinAdults) return;
  const index = new Map(adults.map((id, k) => [id, k]));
  // Symmetric weights from mutual felt affinity (kin boost included), relative to each
  // person's average tie: community structure is about whom people prefer.
  const F = new Float64Array(n * n);
  const rowMean = new Float64Array(n);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      F[a * n + b] = feltAffinity(sim, adults[a], adults[b]);
      rowMean[a] += F[a * n + b] / (n - 1);
    }
  }
  const W = new Float64Array(n * n);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const w = Math.max(0, (F[a * n + b] - rowMean[a] + F[b * n + a] - rowMean[b]) / 2);
      W[a * n + b] = w;
      W[b * n + a] = w;
    }
  }
  const labels = labelPropagation(W, n, rng);
  const q = modularity(W, n, labels);
  if (q < cc.fissionModularity) return;
  // Communities, largest first; the parent keeps the one holding the top-status member.
  const groups = new Map<number, number[]>();
  labels.forEach((l, k) => (groups.get(l) ?? groups.set(l, []).get(l)!).push(adults[k]));
  const top = sim.topStatus(clanId, 1)[0];
  const cands = [...groups.values()].filter((g) => !g.includes(top)).sort((a, b) => b.length - a.length || a[0] - b[0]);
  for (const g of cands) {
    const fertileF = g.filter((id) => c.sex[id] === SEX_FEMALE && ageYears(sim, id) < sim.cfg.life.femaleFertileEndYears).length;
    const males = g.filter((id) => c.sex[id] === SEX_MALE).length;
    if (g.length < cc.fissionMinAdults || fertileF < 2 || males < 2) continue;
    // Focal member: largest share of in-subgroup regard (deference, or affinity until M3).
    let focal = -1;
    let bestShare = 0;
    let total = 0;
    const received = g.map((x) => {
      let s = 0;
      for (const y of g) if (y !== x) s += Math.max(0, sim.regard(y, x));
      total += s;
      return s;
    });
    received.forEach((s, k) => {
      if (total > 0 && s / total > bestShare) {
        bestShare = s / total;
        focal = g[k];
      }
    });
    if (focal < 0 || bestShare < cc.fissionMinDeferenceShare) continue;
    const site = chooseNewCamp(sim, g, clan.campX, clan.campY);
    if (site < 0) continue;
    found(sim, clanId, g, focal, site, q);
    void index;
    return;
  }
}

function chooseNewCamp(sim: Simulation, group: number[], px: number, py: number): number {
  const c = sim.agents.cols;
  const m = sim.mind;
  const w = sim.world;
  const W = w.width;
  const pc = m.placeCap;
  const cc = sim.cfg.clans;
  const campField = sim.fields.get(Math.floor(py) * W + Math.floor(px));
  let best = -1;
  let bestScore = -Infinity;
  for (const id of group) {
    const slot = c.slot[id];
    for (let k = 0; k < m.placeCount[slot]; k++) {
      const t = m.placeTile[slot * pc + k];
      const x = t % W;
      const y = (t / W) | 0;
      if (Math.hypot(x + 0.5 - px, y + 0.5 - py) < cc.fissionMinDistance) continue;
      if (!Number.isFinite(campField[t])) continue;
      // Needs water nearby.
      if (w.waterDistance[t] === 0 || w.waterDistance[t] > sim.cfg.init.campMaxWaterDistance) continue;
      const score = m.placePlant[slot * pc + k] + 3 * m.placeGame[slot * pc + k];
      if (score > bestScore || (score === bestScore && t < best)) {
        bestScore = score;
        best = t;
      }
    }
  }
  return best;
}

function found(sim: Simulation, parentId: number, group: number[], focal: number, site: number, q: number): void {
  const c = sim.agents.cols;
  const parent = sim.clans.get(parentId)!;
  const rng = sim.rng.get('fission');
  const parentSyl = sim.syllables.get(parentId)!;
  // Daughter clans keep much of the parent's "accent".
  const fresh = makeSyllableSet(rng, 4).syllables;
  const syl = { syllables: [...parentSyl.syllables.slice(0, 6), ...fresh] };
  const W = sim.world.width;
  const fissionEv = sim.events.emit(sim.tick, {
    type: 'clan.fission', causes: [], agents: [focal, ...group], clans: [parentId], x: parent.campX, y: parent.campY,
    data: { modularity: Math.round(q * 1000) / 1000, size: group.length, parentSize: sim.clanMembers.get(parentId)?.length },
  });
  const clan = sim.clans.create(makeClanName(rng, syl), (site % W) + 0.5, ((site / W) | 0) + 0.5, {
    tick: sim.tick, parentClanId: parentId, founderId: focal, eventId: -1,
  });
  sim.syllables.set(clan.id, syl);
  clan.founding.eventId = sim.events.emit(sim.tick, {
    type: 'clan.founded', causes: [fissionEv], agents: [focal], clans: [clan.id, parentId], x: clan.campX, y: clan.campY,
    data: { name: clan.name, parent: parentId, founder: focal },
  });
  clan.history.push(clan.founding.eventId);
  parent.history.push(fissionEv);
  const before = sim.clanMembers.get(parentId)?.length ?? 1;
  const movers = new Set<number>();
  for (const id of group) {
    movers.add(id);
    const p = c.partnerId[id];
    if (isAlive(sim, p) && c.clanId[p] === parentId) movers.add(p);
  }
  for (const id of [...movers].sort((a, b) => a - b)) {
    if (c.clanId[id] !== parentId) continue;
    moveClan(sim, id, clan.id, 'founded a new clan', [clan.founding.eventId]);
  }
  // The store splits with the people.
  const share = (sim.clanMembers.get(clan.id)?.length ?? 0) / before;
  clan.foodStore = parent.foodStore * share;
  parent.foodStore -= clan.foodStore;
}

/** Deterministic label propagation (asynchronous, shuffled order, ties broken by lowest label). */
export function labelPropagation(W: Float64Array, n: number, rng: Rng, maxIter = 30): number[] {
  const labels = Array.from({ length: n }, (_, k) => k);
  const order = Array.from({ length: n }, (_, k) => k);
  const score = new Float64Array(n);
  for (let it = 0; it < maxIter; it++) {
    rng.shuffle(order);
    let changed = false;
    for (const a of order) {
      score.fill(0);
      for (let b = 0; b < n; b++) if (b !== a) score[labels[b]] += W[a * n + b];
      let best = labels[a];
      let bestV = score[best];
      for (let l = 0; l < n; l++) {
        if (score[l] > bestV + 1e-12 || (Math.abs(score[l] - bestV) <= 1e-12 && score[l] > 0 && l < best)) {
          bestV = score[l];
          best = l;
        }
      }
      if (best !== labels[a] && bestV > 0) {
        labels[a] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return labels;
}

/** Newman modularity Q of a partition of a weighted undirected graph. */
export function modularity(W: Float64Array, n: number, labels: number[]): number {
  const deg = new Float64Array(n);
  let m2 = 0;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) deg[a] += W[a * n + b];
    m2 += deg[a];
  }
  if (m2 <= 0) return 0;
  let q = 0;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (labels[a] !== labels[b]) continue;
      q += W[a * n + b] - (deg[a] * deg[b]) / m2;
    }
  }
  return q / m2;
}
