/** Shared helpers for systems. Pure functions of sim state. */
import type { Simulation } from '../sim';
import { NO_ID, SEX_FEMALE } from '../state/agents';
import { hashString } from '../rng';

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(lo: number, hi: number, v: number): number {
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
}

export function ageYears(sim: Simulation, id: number): number {
  return (sim.tick - sim.agents.cols.birthTick[id]) / sim.cfg.time.daysPerYear;
}

/** Body size relative to an adult: sets food need and reserve capacity. */
export function sizeFactor(sim: Simulation, age: number): number {
  const m = sim.cfg.metabolism.childMinSizeFraction;
  return m + (1 - m) * Math.min(1, age / sim.cfg.life.adultAgeYears);
}

/** Food units that fill energy from 0 to 1. */
export function reserveCapacity(sim: Simulation, id: number): number {
  const mc = sim.cfg.metabolism;
  return mc.reserveDays * mc.adultNeed * sizeFactor(sim, ageYears(sim, id));
}

/** Adds food energy; returns units actually absorbed (can't exceed full reserves). */
export function feed(sim: Simulation, id: number, units: number, efficiency = 1): number {
  const c = sim.agents.cols;
  const cap = reserveCapacity(sim, id);
  const room = (1 - c.energy[id]) * cap;
  const used = Math.min(units, room / Math.max(efficiency, 1e-6));
  c.energy[id] += (used * efficiency) / cap;
  if (c.energy[id] > 1) c.energy[id] = 1;
  return used;
}

/** Spends energy (food units); shortfall accumulates as today's deficit. */
export function spend(sim: Simulation, id: number, units: number): void {
  const c = sim.agents.cols;
  const cap = reserveCapacity(sim, id);
  c.energy[id] -= units / cap;
  if (c.energy[id] < 0) {
    c.deficit[id] += -c.energy[id] * cap;
    c.energy[id] = 0;
  }
}

/** Derived strength (§4): age curve x build x health x injury. Never stored. */
export function strength(sim: Simulation, id: number): number {
  const c = sim.agents.cols;
  const l = sim.cfg.life;
  const a = ageYears(sim, id);
  let curve: number;
  if (a < l.strengthPeakYears) curve = 0.15 + 0.85 * (a / l.strengthPeakYears);
  else if (a < l.strengthDeclineStartYears) curve = 1;
  else curve = Math.max(0.2, 1 - (a - l.strengthDeclineStartYears) / 50);
  return curve * (0.5 + c.build[id]) * c.health[id] * (1 - 0.5 * c.injury[id]);
}

export function isFemale(sim: Simulation, id: number): boolean {
  return sim.agents.cols.sex[id] === SEX_FEMALE;
}

/** Home site: the clan camp, or a loner's own site. */
export function homeX(sim: Simulation, id: number): number {
  const clan = sim.clans.get(sim.agents.cols.clanId[id]);
  return clan ? clan.campX : sim.agents.cols.ownHomeX[id];
}

export function homeY(sim: Simulation, id: number): number {
  const clan = sim.clans.get(sim.agents.cols.clanId[id]);
  return clan ? clan.campY : sim.agents.cols.ownHomeY[id];
}

export function homeTile(sim: Simulation, id: number): number {
  const w = sim.world;
  return Math.floor(homeY(sim, id)) * w.width + Math.floor(homeX(sim, id));
}

export function tileOf(sim: Simulation, id: number): number {
  const c = sim.agents.cols;
  return Math.floor(c.y[id]) * sim.world.width + Math.floor(c.x[id]);
}

/** Stable per-agent offset in [-0.5, 0.5) so agents don't stack (no RNG draw). */
export function agentOffset(id: number, axis: 0 | 1): number {
  return hashString(axis ? 'oy' : 'ox', id) / 4294967296 - 0.5;
}

/** Places the agent at tile t (center + personal offset). */
export function placeAtTile(sim: Simulation, id: number, t: number): void {
  const W = sim.world.width;
  const c = sim.agents.cols;
  c.x[id] = (t % W) + 0.5 + agentOffset(id, 0) * 0.7;
  c.y[id] = ((t / W) | 0) + 0.5 + agentOffset(id, 1) * 0.7;
}

/** Places the agent at its spot around the home fire. */
export function placeAtHome(sim: Simulation, id: number): void {
  const c = sim.agents.cols;
  const j = sim.cfg.movement.homeJitter;
  const w = sim.world;
  const hx = homeX(sim, id);
  const hy = homeY(sim, id);
  const x = clamp(hx + agentOffset(id, 0) * 2 * j, 0, w.width - 0.01);
  const y = clamp(hy + agentOffset(id, 1) * 2 * j, 0, w.height - 0.01);
  // Never sit in a lake: fall back to the fire itself.
  const blocked = w.movementCost[Math.floor(y) * w.width + Math.floor(x)] >= sim.cfg.world.impassableCost;
  c.x[id] = blocked ? hx : x;
  c.y[id] = blocked ? hy : y;
}

export function isAlive(sim: Simulation, id: number): boolean {
  return id !== NO_ID && sim.agents.cols.alive[id] === 1;
}
