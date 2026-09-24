/**
 * Climate (§3): annual seasonal sinusoid + slow multi-year drought process
 * (AR(1)) + random epidemic outbreaks. Exogenous shocks come only from the
 * config schedule (`climate.shocks`, §16).
 */
import type { Simulation } from '../sim';
import { clamp } from './common';

export interface ClimateState {
  /** Plant growth multiplier from season (>= 0). */
  season: number;
  /** AR(1) drought index; positive = drier than normal. */
  drought: number;
  /** Combined resource multiplier from drought. */
  droughtMult: number;
  droughtActive: boolean;
  droughtEventId: number;
  epidemicActive: boolean;
  epidemicEventId: number;
  epidemicUntil: number;
}

export function initialClimate(): ClimateState {
  return {
    season: 1, drought: 0, droughtMult: 1, droughtActive: false, droughtEventId: -1,
    epidemicActive: false, epidemicEventId: -1, epidemicUntil: -1,
  };
}

interface Shock {
  year: number;
  type: 'drought' | 'epidemic';
  /** Drought index to force (drought shocks). */
  value?: number;
}

export function climateSystem(sim: Simulation): void {
  const cc = sim.cfg.climate;
  const cl = sim.climate;
  const rng = sim.rng.get('climate');
  const dpy = sim.cfg.time.daysPerYear;
  const day = sim.tick % dpy;

  cl.season = Math.max(0, 1 + cc.seasonAmplitude * Math.sin((2 * Math.PI * (day + cc.seasonPhaseDays)) / dpy));

  const phi = Math.exp(-1 / cc.droughtTauDays);
  const innovSd = cc.droughtSd * Math.sqrt(1 - phi * phi);
  cl.drought = phi * cl.drought + rng.normal(0, innovSd);

  if (day === 0) {
    for (const s of cc.shocks as unknown as Shock[]) {
      if (s.year !== sim.year) continue;
      if (s.type === 'drought') cl.drought = s.value ?? 2 * cc.droughtSd;
      if (s.type === 'epidemic') startEpidemic(sim, true);
    }
  }
  cl.droughtMult = clamp(Math.exp(-cc.droughtEffect * cl.drought), cc.droughtMinMultiplier, 1.5);

  const nowDry = cl.drought > cc.droughtThreshold;
  if (nowDry && !cl.droughtActive) {
    cl.droughtActive = true;
    cl.droughtEventId = sim.events.emit(sim.tick, { type: 'climate.drought_began', causes: [], data: { index: round(cl.drought) } });
  } else if (!nowDry && cl.droughtActive && cl.drought < cc.droughtThreshold * 0.5) {
    cl.droughtActive = false;
    sim.events.emit(sim.tick, { type: 'climate.drought_ended', causes: [cl.droughtEventId], data: {} });
  }

  if (cl.epidemicActive && sim.tick >= cl.epidemicUntil && !anyInfected(sim)) {
    cl.epidemicActive = false;
    sim.events.emit(sim.tick, { type: 'epidemic.ended', causes: [cl.epidemicEventId], data: {} });
  }
  if (!cl.epidemicActive && rng.chance(sim.cfg.epidemic.annualProb / dpy)) startEpidemic(sim, false);
}

function anyInfected(sim: Simulation): boolean {
  const c = sim.agents.cols;
  for (const id of sim.agents.living) if (c.infectedUntil[id] > sim.tick) return true;
  return false;
}

/** Infects one random susceptible agent (patient zero). */
function startEpidemic(sim: Simulation, scheduled: boolean): void {
  const rng = sim.rng.get('climate');
  const c = sim.agents.cols;
  const susceptible = sim.agents.living.filter((id) => c.immuneUntil[id] <= sim.tick && c.infectedUntil[id] <= sim.tick);
  if (susceptible.length === 0) return;
  const p0 = rng.pick(susceptible);
  c.infectedUntil[p0] = sim.tick + sim.cfg.epidemic.durationDays;
  const cl = sim.climate;
  cl.epidemicActive = true;
  cl.epidemicUntil = sim.tick + sim.cfg.epidemic.durationDays;
  cl.epidemicEventId = sim.events.emit(sim.tick, {
    type: 'epidemic.outbreak', causes: [], x: c.x[p0], y: c.y[p0], agents: [p0], clans: [c.clanId[p0]],
    data: { scheduled },
  });
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
