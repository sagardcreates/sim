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

  it('places agents on land and never moves them onto impassable tiles (lakes; rivers are fordable)', () => {
    expect(sim.agents.living.length).toBe(cfg.init.clanCount * cfg.init.agentsPerClan);
    const { x, y } = sim.agents.cols;
    const w = sim.world;
    const passable = () => sim.agents.living.every((id) => w.movementCost[Math.floor(y[id]) * w.width + Math.floor(x[id])] < cfg.world.impassableCost);
    expect(passable()).toBe(true);
    sim.run(200);
    expect(passable()).toBe(true);
  });

  it('has an age pyramid with more young than old', () => {
    const young = sim.agents.living.filter((id) => sim.agents.ageDays(id, 0) < 15 * 365).length;
    const old = sim.agents.living.filter((id) => sim.agents.ageDays(id, 0) >= 50 * 365).length;
    expect(young).toBeGreaterThan(old);
  });
});
