/**
 * Camp relocation (§3): when members' recent foraging returns fall, the clan
 * considers moving its camp to a site near water that members remember as
 * rich (local knowledge only: pooled place memories, fading with age).
 * Each member's opinion is weighted by the influence function (equal weights
 * until deference exists in M3). Sites are chosen by softmax.
 */
import type { Simulation } from '../sim';
import { ageYears } from './common';

export function campSystem(sim: Simulation): void {
  const cc = sim.cfg.camps;
  if (sim.tick % cc.relocationCheckDays !== 0) return;
  const rng = sim.rng.get('camps');
  const c = sim.agents.cols;
  const w = sim.world;
  const W = w.width;
  const m = sim.mind;
  const pc = m.placeCap;
  const stale = sim.cfg.memory.placeStaleDays;
  const need = sim.cfg.metabolism.adultNeed;
  for (const clan of sim.clans.extant()) {
    const members = (sim.clanMembers.get(clan.id) ?? []).filter((id) => ageYears(sim, id) >= sim.cfg.life.independentAgeYears);
    if (members.length === 0) continue;
    let yieldSum = 0;
    let wsum = 0;
    for (const id of members) {
      const wt = sim.influence(id);
      yieldSum += wt * c.recentYield[id];
      wsum += wt;
    }
    const meanYield = yieldSum / wsum;
    if (meanYield >= cc.relocationYieldFraction * need) continue;

    // Pool what members know: site -> summed remembered quality nearby.
    const R = cc.relocationSiteRadius;
    const siteScore = new Map<number, number>();
    const scoreAt = (sx: number, sy: number) => {
      let total = 0;
      for (const id of members) {
        const slot = c.slot[id];
        const base = slot * pc;
        const wt = sim.influence(id) / wsum;
        for (let k = 0; k < m.placeCount[slot]; k++) {
          const t = m.placeTile[base + k];
          const dx = (t % W) + 0.5 - sx;
          const dy = ((t / W) | 0) + 0.5 - sy;
          if (dx * dx + dy * dy > R * R) continue;
          const fresh = Math.exp(-(sim.tick - m.placeTick[base + k]) / stale);
          total += wt * fresh * (m.placePlant[base + k] + 3 * m.placeGame[base + k]);
        }
      }
      return total;
    };
    const current = scoreAt(clan.campX, clan.campY);
    const campField = sim.fields.get(Math.floor(clan.campY) * W + Math.floor(clan.campX));
    // Candidate sites near the best-remembered places (top 20 by remembered quality).
    const seen = new Map<number, number>();
    for (const id of members) {
      const slot = c.slot[id];
      for (let k = 0; k < m.placeCount[slot]; k++) {
        const j = slot * pc + k;
        const q = Math.exp(-(sim.tick - m.placeTick[j]) / stale) * (m.placePlant[j] + 3 * m.placeGame[j]);
        const t = m.placeTile[j];
        if (q > (seen.get(t) ?? -1)) seen.set(t, q);
      }
    }
    const top = [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 20);
    for (const [t] of top) {
      const site = nearestCampSite(sim, t);
      if (site < 0 || siteScore.has(site) || !Number.isFinite(campField[site])) continue;
      const sx = (site % W) + 0.5;
      const sy = ((site / W) | 0) + 0.5;
      if (Math.hypot(sx - clan.campX, sy - clan.campY) < cc.relocationMinDistance) continue;
      siteScore.set(site, scoreAt(sx, sy));
    }
    const sites = [...siteScore.keys()];
    if (sites.length === 0) continue;
    const best = Math.max(...siteScore.values());
    if (best <= current * (1 + cc.relocationMargin)) continue;
    const vals = sites.map((s) => siteScore.get(s)! / Math.max(best, 1e-9));
    const site = sites[rng.softmax(vals, cc.relocationTemperature)];
    if (siteScore.get(site)! <= current * (1 + cc.relocationMargin)) continue;
    const from = { x: clan.campX, y: clan.campY };
    clan.campX = (site % W) + 0.5;
    clan.campY = ((site / W) | 0) + 0.5;
    const ev = sim.events.emit(sim.tick, {
      type: 'clan.camp_moved', causes: sim.climate.droughtActive ? [sim.climate.droughtEventId] : [],
      x: clan.campX, y: clan.campY, clans: [clan.id],
      data: { from, to: { x: clan.campX, y: clan.campY }, meanYield: Math.round(meanYield * 100) / 100 },
    });
    clan.history.push(ev);
  }
}

/** Nearest land tile within 3 tiles of `t` that is close to water. */
function nearestCampSite(sim: Simulation, t: number): number {
  const w = sim.world;
  const W = w.width;
  const x0 = t % W;
  const y0 = (t / W) | 0;
  const maxW = sim.cfg.init.campMaxWaterDistance;
  let best = -1;
  let bestD = Infinity;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x < 1 || y < 1 || x >= W - 1 || y >= w.height - 1) continue;
      const j = y * W + x;
      const wd = w.waterDistance[j];
      if (wd === 0 || wd > maxW || w.movementCost[j] >= sim.cfg.world.impassableCost) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
  }
  return best;
}
