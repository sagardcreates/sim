import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/sim/config';
import { Simulation } from '../src/sim/sim';
import { BIOME_WATER, isWater } from '../src/sim/world/terrain';

describe('world + initial population invariants', () => {
  const cfg = makeConfig();
  const sim = Simulation.create(11, cfg);

  it('has all biomes including water, and no negative food', () => {
    const seen = new Set(sim.world.biome);
    expect(seen.has(BIOME_WATER)).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const v of sim.world.plantFood) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('creates the configured clans with camps near water and separated', () => {
    const clans = sim.clans.extant();
    expect(clans.length).toBe(cfg.init.clanCount);
    expect(new Set(clans.map((c) => c.id)).size).toBe(clans.length);
    for (const c of clans) {
      const i = Math.floor(c.campY) * sim.world.width + Math.floor(c.campX);
      expect(sim.world.waterDistance[i]).toBeLessThanOrEqual(cfg.init.campMaxWaterDistance);
      expect(isWater(sim.world, c.campX, c.campY)).toBe(false);
    }
  });

  it('places agents on land and never moves them into water', () => {
    expect(sim.agents.living.length).toBe(cfg.init.clanCount * cfg.init.agentsPerClan);
    sim.run(200);
    const { x, y } = sim.agents.cols;
    for (const id of sim.agents.living) expect(isWater(sim.world, x[id], y[id])).toBe(false);
  });

  it('has an age pyramid with more young than old', () => {
    const young = sim.agents.living.filter((id) => sim.agents.ageDays(id, 0) < 15 * 365).length;
    const old = sim.agents.living.filter((id) => sim.agents.ageDays(id, 0) >= 50 * 365).length;
    expect(young).toBeGreaterThan(old);
  });
});
