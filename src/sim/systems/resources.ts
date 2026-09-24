/**
 * Resources (§3). Plants: low variance, logistic seasonal regrowth. Game:
 * slow recovery toward capacity (depleted by hunting). Carried food spoils.
 */
import type { Simulation } from '../sim';

export function resourcesSystem(sim: Simulation): void {
  const w = sim.world;
  const rc = sim.cfg.resources;
  const cl = sim.climate;
  const growth = rc.plantRegrowth * cl.season * cl.droughtMult;
  const seed = rc.plantSeedRate * cl.season * cl.droughtMult;
  const gameMult = Math.sqrt(cl.droughtMult);
  const P = w.plantFood;
  const K = w.plantCapacity;
  const R = w.regrowthRate;
  const G = w.gameDensity;
  const GK = w.gameCapacity;
  for (let i = 0; i < P.length; i++) {
    const k = K[i];
    if (k <= 0) continue;
    const p = P[i];
    let np = p + R[i] * (growth * p * (1 - p / k) + seed * k);
    if (np > k) np = k;
    P[i] = np;
    G[i] += rc.gameRecoveryRate * (GK[i] * gameMult - G[i]);
  }
  const c = sim.agents.cols;
  const keep = 1 - rc.carriedSpoilage;
  for (const id of sim.agents.living) c.carriedFood[id] *= keep;
  const storeKeep = 1 - rc.storeSpoilage;
  for (const clan of sim.clans.extant()) clan.foodStore *= storeKeep;
}
