import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/sim/config';
import { Simulation } from '../src/sim/sim';
import { cultureDivergence } from '../src/sim/systems/culture';
import { MEM_THEFT, remember } from '../src/sim/systems/gossip';
import { MEM_CAP } from '../src/sim/state/mind';

describe('culture', () => {
  it('knockout freezes culture of existing agents', () => {
    const sim = Simulation.create(3, makeConfig({ culture: { learning: false } }));
    const c = sim.agents.cols;
    const before = sim.agents.living.map((id) => [c.cSharing[id], c.cMarker[id], c.cLegStrength[id]]);
    const ids = [...sim.agents.living];
    sim.run(2 * 365);
    ids.forEach((id, k) => {
      if (!c.alive[id]) return;
      expect([c.cSharing[id], c.cMarker[id], c.cLegStrength[id]]).toEqual(before[k]);
    });
  });

  it('keeps legitimacy weights normalized and divergence within [0,1] while learning', () => {
    const sim = Simulation.create(4);
    sim.run(2 * 365);
    const c = sim.agents.cols;
    for (const id of sim.agents.living) {
      const s = c.cLegStrength[id] + c.cLegGenerosity[id] + c.cLegLineage[id] + c.cLegAge[id];
      expect(s).toBeCloseTo(1, 6);
    }
    const d = cultureDivergence(sim);
    expect(d.functional).toBeGreaterThanOrEqual(0);
    expect(d.functional).toBeLessThanOrEqual(1);
    expect(d.marker).toBeGreaterThanOrEqual(0);
    expect(d.marker).toBeLessThanOrEqual(1);
    // Initial clans have distinct markers, so marker divergence is high at the start.
    expect(sim.stats.years[0].markerDivergence).toBeGreaterThan(0.5);
  });
});

describe('gossip memory', () => {
  it('deduplicates by source event and caps the ring', () => {
    const sim = Simulation.create(2);
    const a = sim.agents.living[10];
    expect(remember(sim, a, MEM_THEFT, 1, 2, 999, 0, 0, 1)).toBe(true);
    expect(remember(sim, a, MEM_THEFT, 1, 2, 999, 0, 1, 0.7)).toBe(false);
    for (let k = 0; k < 40; k++) remember(sim, a, MEM_THEFT, 1, 2, 1000 + k, 0, 0, 1);
    expect(sim.mind.memCount[sim.agents.cols.slot[a]]).toBe(MEM_CAP);
  });
});
