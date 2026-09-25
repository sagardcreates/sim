/**
 * Metabolism (§4, §6): basal need scaled by body size, pregnancy/lactation
 * costs, milk for nursing infants (which famine reduces), starvation turning
 * into health loss (and permanent health-cap loss in childhood), recovery,
 * injury healing, thirst, epidemic drain, and mood decay.
 */
import type { Simulation } from '../sim';
import { CAUSE_STARVATION, NO_ID, REP_LACTATING, REP_PREGNANT } from '../state/agents';
import { ageYears, isAlive, reserveCapacity, sizeFactor, smoothstep, spend } from './common';
import { killAgent } from './mortality';
import { playerId } from '../play/player';

export function metabolismSystem(sim: Simulation): void {
  const c = sim.agents.cols;
  const mc = sim.cfg.metabolism;
  const l = sim.cfg.life;
  const tick = sim.tick;
  // Iterate a copy: starvation deaths mutate `living`.
  const pid = playerId(sim);
  for (const id of [...sim.agents.living]) {
    if (id === pid) continue; // the player's hunger is kept by play/player.ts
    const age = ageYears(sim, id);
    const size = sizeFactor(sim, age);
    let need = mc.basalFraction * mc.adultNeed * size;
    if (c.repState[id] === REP_PREGNANT) need += mc.pregnancyCost;
    if (c.repState[id] === REP_LACTATING) need += mc.lactationCost * milkFactor(sim, id);
    if (c.infectedUntil[id] > tick) need += sim.cfg.epidemic.energyDrain * reserveCapacity(sim, id);
    spend(sim, id, need);

    // Nursing infants live on milk; famine in the mother reduces it.
    if (age < l.weaningAgeYears) {
      const m = c.motherId[id];
      if (isAlive(sim, m) && c.repState[m] === REP_LACTATING) {
        const milk = milkFactor(sim, m) * mc.basalFraction * mc.adultNeed * size * 1.25;
        const cap = reserveCapacity(sim, id);
        c.energy[id] = Math.min(1, c.energy[id] + milk / cap);
        if (c.deficit[id] > 0) c.deficit[id] = Math.max(0, c.deficit[id] - milk);
      }
    }
  }

  for (const id of [...sim.agents.living]) {
    if (id === pid) continue;
    const age = ageYears(sim, id);
    if (c.deficit[id] > 0 && c.energy[id] <= 0) {
      const size = sizeFactor(sim, age);
      const severity = 1 + c.deficit[id] / (mc.adultNeed * size);
      // Small bodies tolerate starvation worse.
      c.health[id] -= mc.starvationHealthLoss * severity / Math.sqrt(size);
      if (age < l.adultAgeYears) c.healthCap[id] = Math.max(0.3, c.healthCap[id] - mc.famineCapLoss);
    } else if (c.energy[id] > mc.healthRecoveryMinEnergy) {
      c.health[id] = Math.min(c.healthCap[id], c.health[id] + mc.healthRecovery * (1 - 0.5 * c.injury[id]));
    }
    c.deficit[id] = 0;
    c.condition[id] += (c.energy[id] - c.condition[id]) / mc.conditionTauDays;
    if (c.health[id] > c.healthCap[id]) c.health[id] = c.healthCap[id];
    c.injury[id] = Math.max(0, c.injury[id] - mc.injuryHeal);
    if (c.injury[id] === 0) {
      c.injuryEventId[id] = NO_ID;
      c.injuredBy[id] = NO_ID;
    }
    if (tick - c.lastWaterTick[id] > mc.thirstDays) c.health[id] -= mc.thirstHealthLoss;
    if (age > sim.cfg.skills.skillDecayAfterYears) c.foragingSkill[id] = Math.max(0, c.foragingSkill[id] - sim.cfg.skills.skillDecayRate);
    c.fear[id] *= 0.8;
    c.anger[id] *= 0.9;
    c.grief[id] *= 0.97;
    if (c.health[id] <= 0) {
      c.health[id] = 0;
      killAgent(sim, id, CAUSE_STARVATION, []);
    }
  }
}

/** Fraction of full milk supply a lactating mother can produce given her reserves. */
export function milkFactor(sim: Simulation, mother: number): number {
  const mc = sim.cfg.metabolism;
  return smoothstep(mc.milkMinMotherEnergy, mc.milkFullMotherEnergy, sim.agents.cols.energy[mother]);
}
