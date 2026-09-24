/**
 * Movement sub-step. M0 placeholder behavior: a biased random walk that keeps
 * agents near their camp. Goal-directed movement replaces this in M1.
 */
import type { SimConfig } from '../config';
import type { Rng } from '../rng';
import type { AgentStore } from '../state/agents';
import type { ClanRegistry } from '../state/clans';
import { isWater, tileIndex, type World } from '../world/terrain';

export function movementSubStep(
  order: readonly number[], agents: AgentStore, clans: ClanRegistry, world: World, cfg: SimConfig, rng: Rng,
): void {
  const c = agents.cols;
  const m = cfg.movement;
  for (const id of order) {
    const x = c.x[id];
    const y = c.y[id];
    const step = m.wanderStepTiles / world.movementCost[tileIndex(world, x, y)];
    let dx = rng.range(-step, step);
    let dy = rng.range(-step, step);
    const clan = clans.get(c.clanId[id]);
    if (clan) {
      const hx = clan.campX - x;
      const hy = clan.campY - y;
      const d = Math.hypot(hx, hy);
      if (d > m.homeRadius) {
        dx += (hx / d) * m.homePull;
        dy += (hy / d) * m.homePull;
      }
    }
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height || isWater(world, nx, ny)) continue;
    c.x[id] = nx;
    c.y[id] = ny;
  }
}
