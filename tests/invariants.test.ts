import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/sim/config';
import { Simulation } from '../src/sim/sim';
import { NO_ID, REP_PREGNANT, SEX_FEMALE } from '../src/sim/state/agents';

describe('simulation invariants over 3 years', () => {
  const sim = Simulation.create(7, makeConfig());
  const c = sim.agents.cols;
  const violations: string[] = [];
  const check = () => {
    for (const v of sim.world.plantFood) if (v < -1e-9) violations.push('negative plant food');
    for (const v of sim.world.gameDensity) if (v < -1e-9) violations.push('negative game');
    for (const cl of sim.clans.clans.values()) if (cl.foodStore < -1e-9) violations.push('negative store');
    for (const id of sim.agents.living) {
      if (c.carriedFood[id] < -1e-9) violations.push('negative carried food');
      if (c.energy[id] < 0 || c.energy[id] > 1) violations.push(`energy out of range ${c.energy[id]}`);
      if (c.health[id] < 0 || c.health[id] > c.healthCap[id] + 1e-9) violations.push('health out of range');
      if (c.alive[id] !== 1 || c.slot[id] < 0) violations.push('living agent not alive/slotted');
      const p = c.partnerId[id];
      if (p !== NO_ID && c.alive[p] && c.partnerId[p] !== id) violations.push('asymmetric partnership');
      if (c.repState[id] === REP_PREGNANT && c.sex[id] !== SEX_FEMALE) violations.push('pregnant male');
    }
  };
  for (let d = 0; d < 3 * 365; d++) {
    sim.step();
    if (d % 30 === 0) check();
  }

  it('never violates resource/body/partnership invariants', () => {
    expect([...new Set(violations)]).toEqual([]);
  });

  it('keeps a consistent pedigree', () => {
    for (let id = 0; id < sim.agents.count; id++) {
      const m = c.motherId[id];
      const f = c.fatherId[id];
      if (m !== NO_ID) {
        expect(m).toBeLessThan(id);
        expect(c.sex[m]).toBe(SEX_FEMALE);
        expect(c.birthTick[m]).toBeLessThan(c.birthTick[id]);
        expect(sim.pedigree.childrenOf(m)).toContain(id);
      }
      if (f !== NO_ID) expect(f).toBeLessThan(id);
      if (!c.alive[id]) expect(c.deathTick[id]).toBeGreaterThanOrEqual(c.birthTick[id]);
    }
  });

  it('has births, deaths and a death record for each death', () => {
    const born = [...sim.events.macro.values()].filter((e) => e.type === 'agent.born').length;
    const died = [...sim.events.macro.values()].filter((e) => e.type === 'agent.died').length;
    expect(born).toBeGreaterThan(0);
    expect(died).toBe(sim.agents.count - sim.agents.living.length);
    expect(sim.graves.length).toBe(died);
  });

  it('stores a "why" for every living independent agent', () => {
    const withWhy = sim.agents.living.filter((id) => sim.mind.whyTerm[c.slot[id] * 3] > 0).length;
    expect(withWhy / sim.agents.living.length).toBeGreaterThan(0.9);
  });
});
