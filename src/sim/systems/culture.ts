/**
 * Culture transmission (§10). Each agent carries learned traits (sharingNorm,
 * violenceTolerance, legitimacy weights, residence rule, revenge scope,
 * outgroupTrust, kinWeight, ancestorNaming, marker). Transmission:
 *  - vertical: at ~age 5, copied from caregivers (mother, father/rearer) with noise
 *  - oblique: during Socialize, move toward higher-prestige partners
 *  - conformity: toward the local (clan) majority / mean
 *  - success bias: toward well-fed, many-offspring clanmates
 *  - innovation: small mutation; markers occasionally drift to a new pattern
 * Migrants and marry-ins carry their culture with them (nothing to do here).
 * The knockout switch (`culture.learning = false`) freezes culture at birth.
 * The marker is NEUTRAL: nothing reads it except attraction's cultural
 * similarity (as spec'd) and the renderer.
 */
import type { Simulation } from '../sim';
import type { Rng } from '../rng';
import { NO_ID } from '../state/agents';
import { ageYears, clamp01, isAlive } from './common';

/** Continuous culture columns (legitimacy weights handled together, renormalized). */
const CONT = ['cSharing', 'cViolence', 'cOutgroupTrust', 'cKinWeight', 'cAncestorNaming'] as const;
const LEG = ['cLegStrength', 'cLegGenerosity', 'cLegLineage', 'cLegAge'] as const;
const CAT = ['cResidence', 'cRevenge', 'cMarker'] as const;

type Cols = Simulation['agents']['cols'];

/** Moves learner's continuous traits toward model's by rate r; categorical adopted with prob pCat. */
function copyToward(c: Cols, learner: number, model: number, r: number, pCat: number, rng: Rng): void {
  for (const f of CONT) c[f][learner] += r * (c[f][model] - c[f][learner]);
  for (const f of LEG) c[f][learner] += r * (c[f][model] - c[f][learner]);
  normalizeLeg(c, learner);
  for (const f of CAT) if (c[f][learner] !== c[f][model] && rng.chance(pCat)) c[f][learner] = c[f][model];
}

let lineageKnockout = false;
function normalizeLeg(c: Cols, id: number): void {
  let s = 0;
  for (const f of LEG) {
    c[f][id] = Math.max(0.01, c[f][id]);
    s += c[f][id];
  }
  for (const f of LEG) c[f][id] /= s;
  if (lineageKnockout) {
    // Experiment 3 knockout: lineage never counts as legitimacy.
    const l = c.cLegLineage[id];
    c.cLegLineage[id] = 0;
    const rest = 1 - l;
    for (const f of LEG) if (f !== 'cLegLineage') c[f][id] /= rest > 0 ? rest : 1;
  }
}

function mutate(sim: Simulation, id: number, rng: Rng): void {
  const cc = sim.cfg.culture;
  const c = sim.agents.cols;
  for (const f of CONT) c[f][id] = clamp01(c[f][id] + rng.normal(0, cc.innovationSd));
  for (const f of LEG) c[f][id] += rng.normal(0, cc.innovationSd);
  normalizeLeg(c, id);
  if (rng.chance(cc.markerInnovation)) {
    c.cMarker[id] = rng.int(cc.markerPatterns);
    sim.events.emit(sim.tick, {
      type: 'culture.marker_innovation', causes: [], agents: [id], clans: [c.clanId[id]], x: c.x[id], y: c.y[id],
      data: { marker: c.cMarker[id], status: Math.round(sim.statusOf(id) * 1000) / 1000, age: Math.floor(ageYears(sim, id)) },
    });
  }
  if (rng.chance(cc.categoricalInnovation)) c.cResidence[id] = rng.int(3);
  if (rng.chance(cc.categoricalInnovation)) c.cRevenge[id] = rng.int(3);
}

/** Vertical transmission at the enculturation age: weighted blend of caregivers. */
function enculturate(sim: Simulation, id: number, rng: Rng): void {
  const c = sim.agents.cols;
  const cc = sim.cfg.culture;
  const models: [number, number][] = [];
  const m = c.motherId[id];
  if (isAlive(sim, m)) models.push([m, cc.motherWeight]);
  const f = c.rearerId[id] !== NO_ID ? c.rearerId[id] : c.fatherId[id];
  if (isAlive(sim, f)) models.push([f, 1 - cc.motherWeight]);
  if (models.length === 0) return; // orphans keep what they had (a copy of the mother at birth)
  const tw = models.reduce((a, [, w]) => a + w, 0);
  for (const fld of [...CONT, ...LEG]) {
    let v = 0;
    for (const [mm, w] of models) v += (w / tw) * c[fld][mm];
    c[fld][id] = fld.startsWith('cLeg') ? v : clamp01(v + rng.normal(0, cc.verticalNoiseSd));
  }
  normalizeLeg(c, id);
  for (const fld of CAT) {
    let r = rng.next() * tw;
    for (const [mm, w] of models) {
      r -= w;
      if (r < 0) {
        c[fld][id] = c[fld][mm];
        break;
      }
    }
  }
}

/** Prestige of a model as perceived: status share (deference) plus a little age. */
function prestige(sim: Simulation, id: number): number {
  return sim.statusOf(id) + 0.01 * Math.min(60, ageYears(sim, id));
}

/** Oblique learning during a Socialize contact: learner a moves toward higher-prestige b. */
export function obliqueLearning(sim: Simulation, a: number, b: number, rng: Rng): void {
  const cc = sim.cfg.culture;
  if (!cc.learning || ageYears(sim, a) < cc.enculturationAgeYears) return;
  const gap = prestige(sim, b) - prestige(sim, a);
  if (gap <= 0) return;
  copyToward(sim.agents.cols, a, b, cc.obliqueRate * Math.min(1, gap * cc.prestigeScale), cc.obliqueCategorical * Math.min(1, gap * cc.prestigeScale), rng);
}

/** Monthly, staggered: enculturation, conformity, success bias, innovation. */
export function cultureSystem(sim: Simulation): void {
  const cc = sim.cfg.culture;
  lineageKnockout = sim.cfg.init.cultureOverrides.lineageWeight === 0;
  const c = sim.agents.cols;
  const rng = sim.rng.get('culture');
  const dpy = sim.cfg.time.daysPerYear;
  const encDay = Math.round(cc.enculturationAgeYears * dpy);
  for (const id of sim.agents.living) {
    // Enculturation happens once, at the enculturation age.
    if (sim.tick - c.birthTick[id] === encDay) {
      if (cc.learning) enculturate(sim, id, rng);
      continue;
    }
    if (!cc.learning || (id + sim.tick) % cc.periodDays !== 0) continue;
    if (ageYears(sim, id) < cc.enculturationAgeYears) continue;
    const clan = c.clanId[id];
    const members = clan === NO_ID ? [] : (sim.clanMembers.get(clan) ?? []);
    if (members.length > 2) {
      conformity(sim, id, members, rng);
      successBias(sim, id, members, rng);
    }
    mutate(sim, id, rng);
  }
}

/** Conformity: continuous traits toward the clan mean; categorical toward the majority (conformist). */
function conformity(sim: Simulation, id: number, members: readonly number[], rng: Rng): void {
  const cc = sim.cfg.culture;
  const c = sim.agents.cols;
  // Sample a handful of clanmates (local majority as the agent perceives it).
  const k = Math.min(cc.conformitySample, members.length - 1);
  const sample: number[] = [];
  for (let t = 0; t < k * 3 && sample.length < k; t++) {
    const m = members[rng.int(members.length)];
    if (m !== id && !sample.includes(m)) sample.push(m);
  }
  if (sample.length === 0) return;
  for (const f of [...CONT, ...LEG]) {
    let mean = 0;
    for (const m of sample) mean += c[f][m];
    mean /= sample.length;
    c[f][id] += cc.conformityRate * (mean - c[f][id]);
  }
  normalizeLeg(c, id);
  for (const f of CAT) {
    const counts = new Map<number, number>();
    for (const m of sample) counts.set(c[f][m], (counts.get(c[f][m]) ?? 0) + 1);
    // Conformist bias: adopt variant v with prob proportional to freq^alpha.
    let tot = 0;
    const ws: [number, number][] = [];
    for (const [v, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
      const w = Math.pow(n / sample.length, cc.conformityAlpha);
      ws.push([v, w]);
      tot += w;
    }
    if (!rng.chance(cc.conformityCategorical)) continue;
    let r = rng.next() * tot;
    for (const [v, w] of ws) {
      r -= w;
      if (r < 0) {
        c[f][id] = v;
        break;
      }
    }
  }
}

/** Success bias: copy a clanmate chosen by condition x surviving offspring. */
function successBias(sim: Simulation, id: number, members: readonly number[], rng: Rng): void {
  const cc = sim.cfg.culture;
  const c = sim.agents.cols;
  let best = NO_ID;
  let bestScore = -Infinity;
  for (let t = 0; t < cc.successSample; t++) {
    const m = members[rng.int(members.length)];
    if (m === id || ageYears(sim, m) < sim.cfg.life.adultAgeYears) continue;
    const kids = sim.pedigree.childrenOf(m).filter((k) => c.alive[k]).length;
    const score = c.condition[m] + cc.offspringWeight * kids;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (best === NO_ID) return;
  const mine = c.condition[id] + cc.offspringWeight * sim.pedigree.childrenOf(id).filter((k) => c.alive[k]).length;
  if (bestScore > mine) copyToward(c, id, best, cc.successRate, cc.successCategorical, rng);
}

/**
 * Between-clan cultural divergence (yearly metric): for functional traits, the
 * share of trait variance that lies between clans (an F_ST analogue, averaged
 * over traits); for markers, 1 - mean pairwise overlap of clan marker
 * distributions.
 */
export function cultureDivergence(sim: Simulation): { functional: number; marker: number } {
  const c = sim.agents.cols;
  const clans = [...sim.clanMembers.entries()].filter(([k, m]) => k >= 0 && m.length >= 5);
  if (clans.length < 2) return { functional: 0, marker: 0 };
  let fst = 0;
  for (const f of [...CONT, ...LEG]) {
    let n = 0;
    let sum = 0;
    for (const [, ms] of clans) for (const m of ms) {
      sum += c[f][m];
      n++;
    }
    const grand = sum / n;
    let total = 0;
    let between = 0;
    for (const [, ms] of clans) {
      let cm = 0;
      for (const m of ms) cm += c[f][m];
      cm /= ms.length;
      between += ms.length * (cm - grand) ** 2;
      for (const m of ms) total += (c[f][m] - grand) ** 2;
    }
    fst += total > 0 ? between / total : 0;
  }
  fst /= CONT.length + LEG.length;
  const dists = clans.map(([, ms]) => {
    const d = new Map<number, number>();
    for (const m of ms) d.set(c.cMarker[m], (d.get(c.cMarker[m]) ?? 0) + 1 / ms.length);
    return d;
  });
  let overlap = 0;
  let pairs = 0;
  for (let a = 0; a < dists.length; a++) {
    for (let b = a + 1; b < dists.length; b++) {
      let o = 0;
      for (const [v, p] of dists[a]) o += Math.min(p, dists[b].get(v) ?? 0);
      overlap += o;
      pairs++;
    }
  }
  return { functional: fst, marker: 1 - overlap / pairs };
}
