/**
 * Reproduction (§6). Female reproductive state machine (cycling -> pregnant ->
 * lactating -> cycling), pairing (Court/Mate, mutual choice), conception,
 * miscarriage under famine, birth (maternal risk rises with low health),
 * inheritance (midparent + segregation noise + mutation; phenotype adds
 * developmental noise), and naming.
 */
import type { Simulation } from '../sim';
import type { Rng } from '../rng';
import { makePersonName } from '../names';
import {
  CAUSE_CHILDBIRTH, NO_ID, PHASE_HOME, REP_CYCLING, REP_LACTATING, REP_NONE, REP_PREGNANT, SEX_FEMALE, SEX_MALE,
} from '../state/agents';
import { ageYears, clamp01, isAlive, placeAtHome, smoothstep } from './common';
import { killAgent } from './mortality';

const GENES = ['Build', 'Robustness', 'Fertility', 'Boldness', 'Sociability', 'Temper'] as const;
const COSMETIC = ['gSkin', 'gHeight', 'gHair'] as const;

export function reproductionSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const l = sim.cfg.life;
  const rc = sim.cfg.reproduction;
  const rng = sim.rng.get('reproduction');
  const tick = sim.tick;
  const order = sim.shuffledLiving(rng);
  for (const id of order) {
    if (!c.alive[id] || c.sex[id] !== SEX_FEMALE) continue;
    const age = ageYears(sim, id);
    const st = c.repState[id];
    if (st === REP_NONE) {
      if (age >= l.femaleFertileStartYears && age < l.femaleFertileEndYears) c.repState[id] = REP_CYCLING;
      continue;
    }
    if (st === REP_CYCLING) {
      if (age >= l.femaleFertileEndYears) {
        c.repState[id] = REP_NONE;
        continue;
      }
      tryConceive(sim, id, age, rng);
    } else if (st === REP_PREGNANT) {
      if (c.energy[id] < rc.miscarriageLowEnergy && rng.chance(rc.miscarriageDailyProb)) {
        c.repState[id] = REP_CYCLING;
        sim.events.emit(tick, { type: 'agent.miscarriage', causes: [], agents: [id], x: c.x[id], y: c.y[id] });
        sim.stats.day.miscarriages++;
      } else if (tick >= c.repUntilTick[id]) {
        giveBirth(sim, id, rng);
      }
    } else if (st === REP_LACTATING) {
      const kids = sim.pedigree.childrenOf(id);
      const youngest = kids.length ? kids[kids.length - 1] : NO_ID;
      if (tick >= c.repUntilTick[id] || !isAlive(sim, youngest)) c.repState[id] = age < l.femaleFertileEndYears ? REP_CYCLING : REP_NONE;
    }
  }
  pairing(sim, rng);
}

function tryConceive(sim: Simulation, id: number, age: number, rng: Rng): void {
  const c = sim.agents.cols;
  const rc = sim.cfg.reproduction;
  const l = sim.cfg.life;
  const p = c.partnerId[id];
  if (!isAlive(sim, p)) return;
  // Mating requires being together at night.
  if (c.phase[id] !== PHASE_HOME || c.phase[p] !== PHASE_HOME || c.clanId[p] !== c.clanId[id]) return;
  const pa = ageYears(sim, p);
  if (pa < l.maleFertileStartYears || pa > l.maleFertileEndYears) return;
  const decline = age < rc.femaleFertilityDeclineStartYears ? 1
    : Math.max(0, 1 - (age - rc.femaleFertilityDeclineStartYears) / (l.femaleFertileEndYears - rc.femaleFertilityDeclineStartYears));
  const ramp = smoothstep(l.femaleFertileStartYears, l.femaleFertileStartYears + 4, age);
  const energyFactor = smoothstep(rc.conceptionEnergyLow, rc.conceptionEnergyHigh, c.condition[id]);
  const prob = rc.baseConception * 2 * c.fertility[id] * decline * ramp * energyFactor;
  if (rng.chance(prob)) {
    c.repState[id] = REP_PREGNANT;
    c.repUntilTick[id] = sim.tick + rc.gestationDays;
    c.pregnancyFatherId[id] = p;
  }
}

function giveBirth(sim: Simulation, mother: number, rng: Rng): void {
  const c = sim.agents.cols;
  const rc = sim.cfg.reproduction;
  const l = sim.cfg.life;
  const tick = sim.tick;
  const risk = rc.birthRiskBase + rc.birthRiskLowHealth * (1 - c.health[mother]) ** 2;
  const motherDies = rng.chance(risk);
  if (motherDies && !rng.chance(rc.newbornSurvivesMaternalDeath)) {
    const ev = sim.events.emit(tick, { type: 'agent.stillbirth', causes: [], agents: [mother], x: c.x[mother], y: c.y[mother] });
    killAgent(sim, mother, CAUSE_CHILDBIRTH, [ev]);
    return;
  }
  const father = c.pregnancyFatherId[mother];
  const clanId = c.clanId[mother];
  const syl = sim.syllables.get(clanId) ?? sim.syllables.get(c.birthClanId[mother]) ?? [...sim.syllables.values()][0];
  const name = ancestorName(sim, mother, father, rng) ?? makePersonName(rng, syl);
  const kid = sim.agents.create(name);
  sim.onCreated(kid);
  c.birthTick[kid] = tick;
  c.sex[kid] = rng.chance(0.5) ? SEX_FEMALE : SEX_MALE;
  c.motherId[kid] = mother;
  c.fatherId[kid] = father;
  c.rearerId[kid] = c.partnerId[mother];
  c.clanId[kid] = clanId;
  c.birthClanId[kid] = clanId;
  c.energy[kid] = 0.8;
  c.condition[kid] = 0.8;
  c.health[kid] = 1;
  c.healthCap[kid] = 1;
  c.lastWaterTick[kid] = tick;
  const hasF = father !== NO_ID;
  for (const g of GENES) {
    const gk = `g${g}` as const;
    const mid = hasF ? 0.5 * (c[gk][mother] + c[gk][father]) : c[gk][mother];
    const gene = clamp01(mid + rng.normal(0, rc.geneSegregationSd) + rng.normal(0, rc.geneMutationSd));
    c[gk][kid] = gene;
    c[(g.charAt(0).toLowerCase() + g.slice(1)) as Lowercase<typeof g>][kid] = clamp01(gene + rng.normal(0, rc.developmentalNoiseSd));
  }
  for (const g of COSMETIC) {
    const mid = hasF ? 0.5 * (c[g][mother] + c[g][father]) : c[g][mother];
    c[g][kid] = clamp01(mid + rng.normal(0, rc.geneSegregationSd) + rng.normal(0, rc.geneMutationSd));
  }
  // Culture: provisional copy of the mother until enculturation (M4).
  c.cSharing[kid] = c.cSharing[mother];
  c.cViolence[kid] = c.cViolence[mother];
  c.cLegStrength[kid] = c.cLegStrength[mother];
  c.cLegGenerosity[kid] = c.cLegGenerosity[mother];
  c.cLegLineage[kid] = c.cLegLineage[mother];
  c.cLegAge[kid] = c.cLegAge[mother];
  c.cResidence[kid] = c.cResidence[mother];
  c.cRevenge[kid] = c.cRevenge[mother];
  c.cOutgroupTrust[kid] = c.cOutgroupTrust[mother];
  c.cKinWeight[kid] = c.cKinWeight[mother];
  c.cAncestorNaming[kid] = c.cAncestorNaming[mother];
  c.cMarker[kid] = c.cMarker[mother];
  c.forageYieldEma[kid] = sim.cfg.decision.expectedYieldPrior;
  c.huntSuccessEma[kid] = sim.cfg.decision.huntSuccessPrior;
  c.phase[kid] = PHASE_HOME;
  c.x[kid] = c.x[mother];
  c.y[kid] = c.y[mother];
  if (c.phase[mother] === PHASE_HOME) placeAtHome(sim, kid);
  sim.pedigree.registerBirth(kid);
  sim.kin.addBirth(kid);

  c.repState[mother] = REP_LACTATING;
  c.repUntilTick[mother] = tick + Math.round(l.weaningAgeYears * sim.cfg.time.daysPerYear);
  const causes = [c.pairEventId[mother]].filter((e) => e > 0);
  const ev = sim.events.emit(tick, {
    type: 'agent.born', causes, x: c.x[kid], y: c.y[kid], agents: [kid, mother, father], clans: [clanId],
    data: { name, sex: c.sex[kid] === SEX_FEMALE ? 'F' : 'M' },
  });
  sim.stats.day.births++;
  if (motherDies) killAgent(sim, mother, CAUSE_CHILDBIRTH, [ev]);
}

/** With probability ancestorNaming (mother's culture), reuse a dead grandparent's name. */
function ancestorName(sim: Simulation, mother: number, father: number, rng: Rng): string | undefined {
  const c = sim.agents.cols;
  if (!rng.chance(c.cAncestorNaming[mother])) return undefined;
  const cands: number[] = [];
  for (const p of [mother, father]) {
    if (p === NO_ID) continue;
    for (const g of [c.motherId[p], c.fatherId[p]]) if (g !== NO_ID && !c.alive[g]) cands.push(g);
  }
  if (cands.length === 0) return undefined;
  return sim.agents.names[rng.pick(cands)];
}

/**
 * Court/Mate: an unpaired adult evaluates unpaired opposite-sex adults at the
 * same camp; attraction weights health, similar age, cultural similarity and
 * noise. The other must find them acceptable too (mutual choice). Kin with
 * r >= incestRelatedness and co-reared individuals are never considered.
 */
function pairing(sim: Simulation, rng: Rng): void {
  const c = sim.agents.cols;
  const rc = sim.cfg.reproduction;
  const l = sim.cfg.life;
  for (const [, members] of sim.clanMembers) {
    const single = members.filter((id) => c.alive[id] && !isAlive(sim, c.partnerId[id]) && ageYears(sim, id) >= l.pairMinAgeYears);
    if (single.length < 2) continue;
    for (const f of single) {
      if (c.sex[f] !== SEX_FEMALE || isAlive(sim, c.partnerId[f]) || !rng.chance(rc.pairingDailyProb)) continue;
      const cands: number[] = [];
      const vals: number[] = [];
      for (const m of single) {
        if (c.sex[m] !== SEX_MALE || isAlive(sim, c.partnerId[m])) continue;
        const v = attraction(sim, f, m, rng);
        if (v === -Infinity) continue;
        cands.push(m);
        vals.push(v);
      }
      if (cands.length === 0) continue;
      const k = rng.softmax(vals, rc.pairingTemperature);
      const m = cands[k];
      if (vals[k] < rc.pairingAcceptThreshold || attraction(sim, m, f, rng) < rc.pairingAcceptThreshold) continue;
      formPair(sim, f, m);
    }
  }
}

export function formPair(sim: Simulation, a: number, b: number): void {
  const c = sim.agents.cols;
  c.partnerId[a] = b;
  c.partnerId[b] = a;
  const ev = sim.events.emit(sim.tick, {
    type: 'pair.formed', causes: [], agents: [a, b], clans: [c.clanId[a], c.clanId[b]], x: c.x[a], y: c.y[a],
  });
  c.pairEventId[a] = ev;
  c.pairEventId[b] = ev;
  sim.stats.day.pairs++;
}

/** How attractive `b` is to `a`, or -Infinity if not eligible (kin, co-reared, age gap). */
export function attraction(sim: Simulation, a: number, b: number, rng: Rng): number {
  const c = sim.agents.cols;
  const rc = sim.cfg.reproduction;
  const gap = Math.abs(c.birthTick[a] - c.birthTick[b]) / sim.cfg.time.daysPerYear;
  if (gap > rc.pairingMaxAgeGapYears) return -Infinity;
  if (sim.relatedness(a, b) >= rc.incestRelatedness || sim.pedigree.coReared(a, b)) return -Infinity;
  const culturalSim = 1 - (Math.abs(c.cSharing[a] - c.cSharing[b]) + Math.abs(c.cViolence[a] - c.cViolence[b])
    + (c.cMarker[a] === c.cMarker[b] ? 0 : 1)) / 3;
  return 0.4 * c.health[b] + 0.3 * (1 - gap / rc.pairingMaxAgeGapYears) + 0.2 * culturalSim + 0.2 * rng.next();
}
