/**
 * Leadership = concentrated deference (§8). Deference is granted by each
 * observer according to THEIR legitimacy weights:
 *  - strength: losing/witnessing contests (conflict.ts)
 *  - generosity: receiving food / seeing deposits (social.ts onGift)
 *  - lineage: flows to kin of people one already defers to (monthly here)
 *  - age/skill: grows toward older, more skilled acquaintances (monthly here)
 * Status is derived daily (incoming deference); the leader is derived (largest
 * share of clan deference above a threshold) and never stored. Challenges,
 * succession and leader-change records live here; regime type is a historian label.
 */
import type { Simulation } from '../sim';
import { NO_ID } from '../state/agents';
import { ageYears, isAlive, strength } from './common';
import { confront } from './conflict';

/** Status (incoming deference, all and from adult clanmates). Pure recomputation from state. */
export function computeStatus(sim: Simulation): void {
  const c = sim.agents.cols;
  const n = sim.agents.count;
  if (sim.status.length < n) {
    sim.status = new Float64Array(n * 2);
    sim.clanDeference = new Float64Array(n * 2);
  }
  const status = sim.status;
  const clanDef = sim.clanDeference;
  // Zero everything (dead agents included) so the arrays depend only on current state.
  status.fill(0, 0, n);
  clanDef.fill(0, 0, n);
  const adultDays = sim.cfg.life.adultAgeYears * sim.cfg.time.daysPerYear;
  const rel = sim.rel;
  for (const i of sim.agents.living) {
    // Only adults' deference makes a leader (children's regard for their parents does not).
    const adult = sim.tick - c.birthTick[i] >= adultDays;
    const base = c.slot[i] * rel.cap;
    const end = base + rel.count[c.slot[i]];
    const ci = c.clanId[i];
    for (let e = base; e < end; e++) {
      if (rel.def[e] <= 0) continue;
      const o = rel.other[e];
      if (!c.alive[o]) continue;
      const d = rel.defAt(e, sim.tick);
      status[o] += d;
      if (adult && c.clanId[o] === ci) clanDef[o] += d;
    }
  }
  sim.clanDefTotal.clear();
  for (const clan of sim.clans.extant()) {
    let total = 0;
    for (const m of sim.clanMembers.get(clan.id) ?? []) total += clanDef[m];
    sim.clanDefTotal.set(clan.id, total);
  }
}

/**
 * What a leader's supporters mostly value: deference-weighted mean of their
 * legitimacy weights, reported as the dominant criterion (for the historian).
 */
function supportBasis(sim: Simulation, leader: number): string {
  const c = sim.agents.cols;
  const w = [0, 0, 0, 0];
  let tot = 0;
  for (const m of sim.clanMembers.get(c.clanId[leader]) ?? []) {
    const d = sim.rel.get(c.slot[m], leader, sim.tick)?.def ?? 0;
    if (d <= 0) continue;
    w[0] += d * c.cLegStrength[m];
    w[1] += d * c.cLegGenerosity[m];
    w[2] += d * c.cLegLineage[m];
    w[3] += d * c.cLegAge[m];
    tot += d;
  }
  if (tot <= 0) return '';
  const names = ['strength', 'generosity', 'lineage', 'age and skill'];
  const k = w.indexOf(Math.max(...w));
  return `${names[k]} (${Math.round((100 * w[k]) / tot)}%)`;
}

/** Periodic: recompute status and derived leaders; log leader changes with their causes. */
export function leadershipSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const lc = sim.cfg.leadership;
  computeStatus(sim);
  const clanDef = sim.clanDeference;
  for (const clan of sim.clans.extant()) {
    const members = sim.clanMembers.get(clan.id) ?? [];
    let total = 0;
    let best = NO_ID;
    let bestV = 0;
    for (const m of members) {
      total += clanDef[m];
      if (clanDef[m] > bestV) {
        bestV = clanDef[m];
        best = m;
      }
    }
    void total;
    const share = total > 0 ? bestV / total : 0;
    let leader = share > lc.leaderShare && total >= lc.minTotalDeference ? best : NO_ID;
    // Stability rule for the derived label: an incumbent keeps it while still holding a clear share,
    // unless someone else clearly overtakes them (avoids flicker from day-to-day noise).
    const inc = sim.leaders.get(clan.id);
    if (inc !== undefined && c.alive[inc] && c.clanId[inc] === clan.id && total > 0) {
      const incShare = clanDef[inc] / total;
      if (incShare > lc.leaderShare * lc.keepFraction && (leader === NO_ID || bestV < clanDef[inc] * lc.overtakeRatio)) leader = inc;
    }
    const prev = sim.leaders.get(clan.id) ?? NO_ID;
    if (leader !== prev) {
      const causes: number[] = [];
      const lastChallenge = sim.lastChallenge.get(clan.id);
      if (lastChallenge !== undefined) causes.push(lastChallenge);
      if (prev !== NO_ID && !c.alive[prev] && sim.deathEvent.has(prev)) causes.push(sim.deathEvent.get(prev)!);
      if (leader !== NO_ID && c.lastWinEvent[leader] > 0) causes.push(c.lastWinEvent[leader]);
      const basis = leader !== NO_ID ? supportBasis(sim, leader) : '';
      const ev = sim.events.emit(sim.tick, {
        type: 'leader.changed', causes, agents: leader === NO_ID ? (prev === NO_ID ? [] : [prev]) : [leader, ...(prev === NO_ID ? [] : [prev])],
        clans: [clan.id], x: clan.campX, y: clan.campY,
        data: { leader, previous: prev, share: Math.round(share * 1000) / 1000, members: members.length, basis },
      });
      clan.history.push(ev);
      if (leader === NO_ID) sim.leaders.delete(clan.id);
      else sim.leaders.set(clan.id, leader);
    }
  }
}

/** Monthly, staggered: deference flows by lineage and by age/skill, per each agent's own weights. */
export function deferenceDriftSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const lc = sim.cfg.leadership;
  const t = sim.tick;
  for (const i of sim.agents.living) {
    if ((i + t) % lc.driftPeriodDays !== 0) continue;
    if (ageYears(sim, i) < sim.cfg.life.independentAgeYears) continue;
    const slot = c.slot[i];
    const ai = ageYears(sim, i);
    const lineage: [number, number][] = [];
    const ageSkill: [number, number][] = [];
    sim.rel.forEach(slot, t, (o, v) => {
      if (!c.alive[o]) return;
      // Lineage: kin of those I defer to inherit some of it.
      if (v.def > lc.lineageMinDeference) {
        for (const k of sim.pedigree.childrenOf(o)) {
          if (!c.alive[k] || k === i || ageYears(sim, k) < sim.cfg.life.adultAgeYears) continue;
          lineage.push([k, v.def * 0.5]);
        }
      }
      // Age/skill: respect for older, more skilled people one knows.
      const ao = ageYears(sim, o);
      if (ao > ai + 5 && v.fam > 0.2) {
        const gap = Math.min(1, (ao - ai) / 30) + Math.max(0, c.foragingSkill[o] - c.foragingSkill[i]);
        ageSkill.push([o, gap]);
      }
    });
    for (const [k, d] of lineage) sim.rel.update(slot, k, t, 0, lc.lineageRate * c.cLegLineage[i] * 4 * d, 0, 0);
    for (const [o, g] of ageSkill) sim.rel.update(slot, o, t, 0, lc.ageRate * c.cLegAge[i] * 4 * g, 0, 0);
    if (ageYears(sim, i) >= sim.cfg.life.adultAgeYears) conformDeference(sim, i);
    concentrate(sim, i);
  }
}

/**
 * Social proof: adults shift a little deference toward whoever their closest
 * clanmate friends defer to (prestige is partly copied).
 */
function conformDeference(sim: Simulation, i: number): void {
  const c = sim.agents.cols;
  const lc = sim.cfg.leadership;
  const t = sim.tick;
  const friends: [number, number][] = [];
  sim.rel.forEach(c.slot[i], t, (o, v) => {
    if (v.aff > 0.2 && c.alive[o] && c.clanId[o] === c.clanId[i]) friends.push([o, v.aff]);
  });
  friends.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const target = new Map<number, number>();
  let tot = 0;
  for (const [f, aff] of friends.slice(0, lc.conformFriends)) {
    sim.rel.forEach(c.slot[f], t, (o, v) => {
      if (v.def <= 0 || o === i || !c.alive[o] || c.clanId[o] !== c.clanId[i]) return;
      target.set(o, (target.get(o) ?? 0) + aff * v.def);
      tot += aff * v.def;
    });
  }
  if (tot <= 0) return;
  for (const [o, w] of [...target.entries()].sort((a, b) => a[0] - b[0])) {
    sim.rel.update(c.slot[i], o, t, 0, lc.conformRate * lc.deferenceBudget * (w / tot), 0, 0);
  }
}

/**
 * Deference is attention, a limited budget: each person's total deference is
 * capped, and it sharpens toward whoever they already defer to most
 * (def^gamma, renormalized). Without this, many small sources spread deference
 * thinly and no one ever stands out.
 */
function concentrate(sim: Simulation, i: number): void {
  const c = sim.agents.cols;
  const lc = sim.cfg.leadership;
  const slot = c.slot[i];
  const ids: number[] = [];
  const defs: number[] = [];
  let sum = 0;
  sim.rel.forEach(slot, sim.tick, (o, v) => {
    if (v.def <= 1e-4 || !c.alive[o]) return;
    ids.push(o);
    defs.push(v.def);
    sum += v.def;
  });
  if (sum <= 0) return;
  let sharpSum = 0;
  const sharp = defs.map((d) => {
    const x = Math.pow(d, lc.deferenceSharpening);
    sharpSum += x;
    return x;
  });
  const total = Math.min(sum, lc.deferenceBudget);
  ids.forEach((o, k) => {
    const target = (total * sharp[k]) / sharpSum;
    sim.rel.update(slot, o, sim.tick, 0, target - defs[k], 0, 0);
  });
}

/**
 * Monthly per clan: a bold member who defers little to the leader and has
 * allied support may Threaten the leader (a challenge). Witnesses join by
 * affinity; the outcome shifts witness deference (conflict.ts).
 */
export function challengeSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const lc = sim.cfg.leadership;
  if (sim.tick % lc.challengePeriodDays !== 0) return;
  const rng = sim.rng.get('challenge');
  for (const clan of sim.clans.extant()) {
    const L = sim.leaders.get(clan.id);
    if (L === undefined || !isAlive(sim, L)) continue;
    const members = sim.clanMembers.get(clan.id) ?? [];
    const cands: number[] = [];
    const vals: number[] = [0]; // index 0 = nobody challenges
    const strL = strength(sim, L);
    const supportL = support(sim, members, L);
    for (const m of members) {
      if (m === L || ageYears(sim, m) < lc.challengerMinAge || ageYears(sim, m) > lc.challengerMaxAge) continue;
      const defToL = sim.rel.get(c.slot[m], L, sim.tick)?.def ?? 0;
      const allies = support(sim, members, m) / Math.max(0.1, supportL);
      if (allies < lc.challengeMinSupportRatio) continue; // no one challenges without backing
      const drive = lc.challengeBoldness * c.boldness[m] + lc.challengeAllies * Math.min(2, allies)
        + lc.challengeStrength * (strength(sim, m) - strL) - lc.challengeDeference * defToL * 4 - lc.challengeBase;
      cands.push(m);
      vals.push(drive);
    }
    if (cands.length === 0) continue;
    const k = rng.softmax(vals, lc.challengeTemperature);
    if (k === 0) continue;
    const ch = cands[k - 1];
    const ev = sim.events.emit(sim.tick, {
      type: 'leader.challenged', causes: [], agents: [ch, L], clans: [clan.id], x: c.x[ch], y: c.y[ch],
      data: { challenger: ch, leader: L },
    });
    sim.lastChallenge.set(clan.id, ev);
    confront(sim, ch, L, 'challenge', 1, [ev]);
  }
}

/** Sum of positive regard (affinity + deference) that clan members hold for x. */
function support(sim: Simulation, members: readonly number[], x: number): number {
  const c = sim.agents.cols;
  let s = 0;
  for (const m of members) {
    if (m === x) continue;
    const v = sim.rel.get(c.slot[m], x, sim.tick);
    if (v) s += Math.max(0, v.aff + v.def);
  }
  return s;
}

/**
 * Succession (§8): when someone with deference dies, each member's deference
 * to them is redistributed according to that member's own legitimacy weights:
 * lineage -> the deceased's adult kin, strength -> contest winners / the
 * strong, age -> elders, generosity -> the generous.
 */
export function redistributeDeference(sim: Simulation, dead: number): void {
  const c = sim.agents.cols;
  const lc = sim.cfg.leadership;
  const clanId = c.clanId[dead];
  const members = (sim.clanMembers.get(clanId) ?? []).filter((m) => m !== dead && c.alive[m] && ageYears(sim, m) >= sim.cfg.life.adultAgeYears);
  if (members.length === 0) return;
  const kin = sim.kin.kinOf(dead).filter((k) => c.alive[k] && c.clanId[k] === clanId && ageYears(sim, k) >= sim.cfg.life.adultAgeYears);
  const kinR = kin.map((k) => sim.relatedness(dead, k));
  const top = (score: (m: number) => number) => [...members].sort((a, b) => score(b) - score(a) || a - b).slice(0, 2);
  const strong = top((m) => c.contestWins[m] + strength(sim, m));
  const elders = top((m) => ageYears(sim, m) + 20 * c.foragingSkill[m]);
  const generous = top((m) => c.givenEma[m]);
  for (const i of members) {
    const d = sim.rel.get(c.slot[i], dead, sim.tick)?.def ?? 0;
    if (d <= 0) continue;
    const pool = d * lc.successionTransfer;
    const give = (targets: number[], weights: number[], amount: number) => {
      const tw = weights.reduce((a, b) => a + b, 0);
      if (tw <= 0) return;
      targets.forEach((t, k) => {
        if (t !== i) sim.rel.update(c.slot[i], t, sim.tick, 0, amount * weights[k] / tw, 0, 0);
      });
    };
    give(kin, kinR, pool * c.cLegLineage[i]);
    give(strong, [1, 1], pool * c.cLegStrength[i]);
    give(elders, [1, 1], pool * c.cLegAge[i]);
    give(generous, [1, 1], pool * c.cLegGenerosity[i]);
  }
}
