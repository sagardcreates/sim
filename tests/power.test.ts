import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/sim/config';
import { Simulation } from '../src/sim/sim';
import { CAUSE_VIOLENCE, NO_ID } from '../src/sim/state/agents';
import { computeStatus, leadershipSystem } from '../src/sim/systems/leadership';
import { killAgent } from '../src/sim/systems/mortality';

function adultsOf(sim: Simulation, clan: number): number[] {
  const c = sim.agents.cols;
  return (sim.clanMembers.get(clan) ?? []).filter((id) => sim.tick - c.birthTick[id] > 20 * 365);
}

describe('leadership (derived from deference)', () => {
  it('derives a leader from concentrated deference and records succession on death', () => {
    const sim = Simulation.create(5);
    sim.run(30);
    sim.rebuildDerived();
    const clan = sim.clans.extant()[0].id;
    const adults = adultsOf(sim, clan);
    const L = adults[0];
    const c = sim.agents.cols;
    for (const a of adults) if (a !== L) sim.rel.update(c.slot[a], L, sim.tick, 0, 1, 0, 0.5);
    leadershipSystem(sim);
    expect(sim.leaders.get(clan)).toBe(L);
    expect(sim.statusOf(L)).toBeGreaterThan(0.25);
    // A child of L (if any adult one) should gain deference by lineage-weighted succession.
    const deathEv = killAgent(sim, L, CAUSE_VIOLENCE, [], []);
    sim.rebuildDerived();
    leadershipSystem(sim);
    expect(sim.leaders.get(clan)).not.toBe(L);
    const change = [...sim.events.macro.values()].filter((e) => e.type === 'leader.changed' && e.clans![0] === clan).pop()!;
    expect(change.causes).toContain(deathEv);
  });

  it('status is a pure function of relationship state', () => {
    const sim = Simulation.create(6);
    sim.run(200);
    computeStatus(sim);
    const a = Array.from(sim.status.subarray(0, sim.agents.count));
    computeStatus(sim);
    expect(Array.from(sim.status.subarray(0, sim.agents.count))).toEqual(a);
  });
});

describe('violence', () => {
  it('records killings with killer and cause, and creates grudges in the victim\'s kin', () => {
    // A deliberately violent world: cheap escalation, frequent contests.
    const cfg = makeConfig({
      conflict: { levelCost: [0, 0.2, 0.6, 1.0], foodContestRate: 1, foodContestScarcity: 1, foodContestMinHunger: 0, theftRate: 0.3 },
    });
    const sim = Simulation.create(8, cfg);
    sim.run(3 * 365);
    const c = sim.agents.cols;
    const killed: number[] = [];
    for (let id = 0; id < sim.agents.count; id++) if (!c.alive[id] && c.deathCause[id] === CAUSE_VIOLENCE) killed.push(id);
    expect(killed.length).toBeGreaterThan(0);
    for (const v of killed) expect(c.killerId[v]).not.toBe(NO_ID);
    // Some living kin of some victim holds a grudge toward the killer.
    let found = false;
    for (const v of killed) {
      const killer = c.killerId[v];
      for (const k of sim.kin.kinOf(v)) {
        if (!c.alive[k] || !c.alive[killer]) continue;
        const g = sim.rel.get(c.slot[k], killer, sim.tick)?.grudge ?? 0;
        if (g > 0) found = true;
      }
    }
    expect(found).toBe(true);
  });
});
