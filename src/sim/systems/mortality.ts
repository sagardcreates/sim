/**
 * Mortality (§12): Gompertz-Makeham baseline (plus the Siler infant term)
 * scaled by robustness, plus hazards from poor health (starvation), injury,
 * epidemic infection and being left unattended as a small child. The cause is
 * sampled in proportion to the competing hazards. Also: epidemic transmission
 * (spread scales with local density), and death bookkeeping (death record,
 * grave, partner/clan updates).
 */
import type { Simulation } from '../sim';
import {
  CAUSE_AGING, CAUSE_EPIDEMIC, CAUSE_INFANT, CAUSE_INJURY, CAUSE_NAMES, CAUSE_NEGLECT, CAUSE_STARVATION,
  GOAL_CARE, GOAL_REST, GOAL_SOCIALIZE, NO_ID, PHASE_HOME,
} from '../state/agents';
import { ageYears, isAlive } from './common';

export function mortalitySystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const mc = sim.cfg.mortality;
  const ec = sim.cfg.epidemic;
  const l = sim.cfg.life;
  const rng = sim.rng.get('mortality');
  const dpy = sim.cfg.time.daysPerYear;
  const attended = attendedClans(sim);
  const order = sim.shuffledLiving(rng);
  for (const id of order) {
    if (!c.alive[id]) continue;
    const a = ageYears(sim, id);
    const robust = Math.exp(mc.robustnessEffect * (0.5 - c.robustness[id]));
    const infant = (mc.infantA * Math.exp(-mc.infantB * a)) / dpy;
    const senescent = ((mc.makeham + mc.gompertzA * Math.exp(mc.gompertzB * a)) * robust) / dpy;
    const hHealth = mc.healthHazard * (1 - c.health[id]) ** mc.healthHazardExponent;
    const hInjury = mc.injuryHazard * c.injury[id] ** 2;
    let hEpi = 0;
    if (c.infectedUntil[id] > sim.tick) {
      const vuln = a < 5 ? ec.childVulnerability : a > 55 ? ec.elderVulnerability : 1;
      hEpi = ec.dailyHazard * vuln;
    }
    const young = a >= l.weaningAgeYears && a < l.followCaregiverFromYears;
    const hNeglect = young && !attended.has(c.clanId[id]) ? mc.unattendedChildHazard : 0;
    const total = infant + senescent + hHealth + hInjury + hEpi + hNeglect;
    if (!rng.chance(total)) continue;
    // Sample which hazard struck.
    let r = rng.next() * total;
    let cause: number;
    const causes: number[] = [];
    if ((r -= infant) < 0) cause = CAUSE_INFANT;
    else if ((r -= senescent) < 0) cause = CAUSE_AGING;
    // Health only declines through hunger and thirst in this model, so poor-health deaths are starvation.
    else if ((r -= hHealth) < 0) cause = CAUSE_STARVATION;
    else if ((r -= hInjury) < 0) {
      cause = c.injuryCause[id] || CAUSE_INJURY;
      if (c.injuryEventId[id] !== NO_ID) causes.push(c.injuryEventId[id]);
    } else if ((r -= hEpi) < 0) cause = CAUSE_EPIDEMIC;
    else cause = CAUSE_NEGLECT;
    const factors: string[] = [];
    const share = (v: number) => v / total > 0.2;
    if (cause !== CAUSE_STARVATION && share(hHealth)) factors.push('poor health');
    if (cause !== CAUSE_INJURY && share(hInjury)) factors.push('injury');
    if (cause !== CAUSE_EPIDEMIC && share(hEpi)) factors.push('epidemic');
    killAgent(sim, id, cause, causes, factors);
  }
}

/** Clans where at least one older person stayed at camp today (children attended). */
function attendedClans(sim: Simulation): Set<number> {
  const c = sim.agents.cols;
  const out = new Set<number>();
  for (const [clan, members] of sim.clanMembers) {
    for (const id of members) {
      if ((c.goal[id] === GOAL_REST || c.goal[id] === GOAL_CARE || c.goal[id] === GOAL_SOCIALIZE) && c.phase[id] === PHASE_HOME
        && ageYears(sim, id) >= sim.cfg.life.independentAgeYears) {
        out.add(clan);
        break;
      }
    }
  }
  return out;
}

/** Epidemic spread at night: each infected person exposes those sleeping nearby. */
export function epidemicSystem(sim: Simulation): void {
  if (!sim.climate.epidemicActive) return;
  const c = sim.agents.cols;
  const ec = sim.cfg.epidemic;
  const rng = sim.rng.get('epidemic');
  const tick = sim.tick;
  const infected = sim.agents.living.filter((id) => c.infectedUntil[id] > tick);
  if (infected.length === 0) return;
  sim.spatial.build(sim.agents.living, c.x, c.y);
  const newly: number[] = [];
  for (const i of infected) {
    sim.spatial.query(c.x[i], c.y[i], ec.contactRadius, c.x, c.y, (j) => {
      if (c.infectedUntil[j] > tick || c.immuneUntil[j] > tick) return;
      if (rng.chance(ec.transmitProb)) newly.push(j);
    });
  }
  for (const j of newly) {
    if (c.infectedUntil[j] > tick) continue;
    c.infectedUntil[j] = tick + ec.durationDays;
    c.immuneUntil[j] = tick + ec.durationDays + Math.round(ec.immunityYears * sim.cfg.time.daysPerYear);
    sim.stats.day.infections++;
  }
}

/** Death bookkeeping: record, grave, event with causes and contributing factors. */
export function killAgent(sim: Simulation, id: number, cause: number, causes: number[], factors: string[] = [], killer = NO_ID): number {
  const c = sim.agents.cols;
  if (!c.alive[id]) return -1;
  const cl = sim.climate;
  const allCauses = [...causes];
  const allFactors = [...factors];
  if (cl.droughtActive && (cause === CAUSE_STARVATION || cause === CAUSE_NEGLECT)) {
    allCauses.push(cl.droughtEventId);
    allFactors.push('drought');
  }
  if (cause === CAUSE_EPIDEMIC && cl.epidemicEventId > 0) allCauses.push(cl.epidemicEventId);
  const age = ageYears(sim, id);
  const clanId = c.clanId[id];
  const status = sim.statusOf(id);
  const kin: number[] = [];
  const kids = sim.pedigree.childrenOf(id);
  for (const k of kids) if (c.alive[k]) kin.push(k);
  for (const p of [c.motherId[id], c.fatherId[id], c.partnerId[id]]) if (isAlive(sim, p)) kin.push(p);

  c.deathCause[id] = cause;
  c.killerId[id] = killer;
  const partner = c.partnerId[id];
  if (isAlive(sim, partner) && c.partnerId[partner] === id) c.partnerId[partner] = NO_ID;
  sim.agents.kill(id, sim.tick);
  sim.onDied(id);
  sim.graves.push({ id, x: c.x[id], y: c.y[id], tick: sim.tick });
  const ev = sim.events.emit(sim.tick, {
    type: 'agent.died', causes: allCauses.filter((e) => e > 0), x: c.x[id], y: c.y[id], agents: [id], clans: [clanId],
    data: {
      name: sim.agents.names[id], age: Math.floor(age), cause: CAUSE_NAMES[cause], killer: killer === NO_ID ? undefined : killer,
      factors: allFactors, survivingKin: kin.length, clan: clanId, status: Math.round(status * 1000) / 1000,
    },
  });
  sim.stats.day.deaths[cause]++;
  return ev;
}
