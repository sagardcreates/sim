import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/sim';
import { applyPlayerAction, inviteOdds, raidCheck, replay, type PlayerAction } from '../src/sim/play/player';
import { animalsOnTile, ANIMALS } from '../src/sim/play/animals';
import { ageYears } from '../src/sim/systems/common';

function newGame(seed: number, years = 2): Simulation {
  const sim = Simulation.create(seed);
  sim.run(years * sim.cfg.time.daysPerYear);
  applyPlayerAction(sim, { kind: 'spawn', name: 'Ada', female: true });
  return sim;
}

/** Nearest living adults of other clans to the player (for scripted interactions). */
function nearestOthers(sim: Simulation, n: number): number[] {
  const c = sim.agents.cols;
  const p = sim.player!;
  return sim.agents.living
    .filter((id) => id !== p.id && c.clanId[id] !== p.clanId && c.clanId[id] >= 0 && ageYears(sim, id) >= 18)
    .sort((a, b) => Math.hypot(c.x[a] - c.x[p.id], c.y[a] - c.y[p.id]) - Math.hypot(c.x[b] - c.x[p.id], c.y[b] - c.y[p.id]) || a - b)
    .slice(0, n);
}

describe('play mode', () => {
  it('spawns a lone player who leads a new clan', () => {
    const sim = newGame(3);
    const p = sim.player!;
    expect(sim.agents.cols.alive[p.id]).toBe(1);
    expect(sim.clanMembers.get(p.clanId)).toEqual([p.id]);
    expect(sim.leaders.get(p.clanId)).toBe(p.id);
    sim.run(60);
    // The player neither starves nor ages out, and never leaves their clan.
    expect(sim.agents.cols.alive[p.id]).toBe(1);
    expect(sim.agents.cols.clanId[p.id]).toBe(p.clanId);
    expect(sim.leaders.get(p.clanId)).toBe(p.id);
  });

  it('helping raises the target\'s regard for the player; witnesses raise suspicion', () => {
    const sim = newGame(4);
    const p = sim.player!;
    const c = sim.agents.cols;
    const [t, w1, w2] = nearestOthers(sim, 3);
    const before = sim.rel.affinity(c.slot[t], p.id, sim.tick);
    applyPlayerAction(sim, { kind: 'help', verb: 'talk', target: t, witnesses: [] });
    applyPlayerAction(sim, { kind: 'help', verb: 'give', target: t, witnesses: [] });
    expect(sim.rel.affinity(c.slot[t], p.id, sim.tick)).toBeGreaterThan(before);
    const clan = c.clanId[t];
    const sameClan = [w1, w2].filter((w) => c.clanId[w] === clan);
    const r = applyPlayerAction(sim, { kind: 'help', verb: 'talk', target: t, witnesses: sameClan });
    if (sameClan.length) expect((p.suspicion[clan] ?? 0)).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });

  it('a clan that catches the player kills up to five of their people', () => {
    const sim = newGame(5);
    const p = sim.player!;
    const c = sim.agents.cols;
    // Force-recruit a handful (bypassing odds) through the same membership move everyone uses.
    const recruits = nearestOthers(sim, 8);
    for (const r of recruits) {
      c.clanId[r] = p.clanId;
    }
    sim.rebuildDerived();
    const members = () => (sim.clanMembers.get(p.clanId) ?? []).length;
    const n0 = members();
    expect(n0).toBeGreaterThan(5);
    const angry = sim.clans.extant().find((cl) => cl.id !== p.clanId)!.id;
    p.suspicion[angry] = 1.2;
    let caughtEv = 0;
    sim.events.subscribe((e) => {
      if (e.type === 'player.caught') caughtEv++;
    });
    sim.step();
    expect(caughtEv).toBe(1);
    expect(p.caught).toBe(1);
    expect(n0 - members()).toBeGreaterThanOrEqual(5);
    expect(p.suspicion[angry]).toBeLessThan(1);
  });

  it('raids need fighters', () => {
    const sim = newGame(6);
    const other = sim.clans.extant().find((cl) => cl.id !== sim.player!.clanId)!.id;
    expect(raidCheck(sim, other).ok).toBe(false);
    const odds = inviteOdds(sim, nearestOthers(sim, 1)[0]);
    expect(odds.p).toBeGreaterThanOrEqual(0);
    expect(odds.p).toBeLessThanOrEqual(1);
  });

  it('a recorded game replays exactly from (seed, config, action log)', () => {
    const sim = newGame(7, 1);
    const c = sim.agents.cols;
    const p = sim.player!;
    const script: ((s: Simulation) => PlayerAction)[] = [
      () => ({ kind: 'gather' }),
      (s) => ({ kind: 'pos', x: s.agents.cols.x[p.id] + 1.5, y: s.agents.cols.y[p.id] }),
      (s) => ({ kind: 'help', verb: 'give', target: nearestOthers(s, 1)[0], witnesses: nearestOthers(s, 4).slice(1) }),
      (s) => ({ kind: 'help', verb: 'talk', target: nearestOthers(s, 2)[1], witnesses: [] }),
      (s) => ({ kind: 'invite', target: nearestOthers(s, 1)[0], witnesses: nearestOthers(s, 3).slice(1) }),
    ];
    for (let d = 0; d < 40; d++) {
      applyPlayerAction(sim, script[d % script.length](sim));
      sim.step();
    }
    const end = sim.tick;
    const log = p.log.map((e) => ({ tick: e.tick, sub: e.sub, a: e.a }));
    void c;
    // Replay: same seed, run to the spawn tick, then apply the log.
    const re = Simulation.create(7);
    re.run(log[0].tick);
    replay(re, log, end);
    expect(re.tick).toBe(end);
    expect(re.stateHash()).toBe(sim.stateHash());
  });

  it('snapshot/restore keeps the player', () => {
    const sim = newGame(8, 1);
    sim.run(20);
    const re = Simulation.fromSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    expect(re.player?.id).toBe(sim.player!.id);
    re.run(10);
    sim.run(10);
    expect(re.stateHash()).toBe(sim.stateHash());
  });

  it('drifters roam: clanless adults who move their fireside every few days', () => {
    const sim = newGame(9, 1);
    const c = sim.agents.cols;
    const drifters = sim.agents.living.filter((id) => c.clanId[id] === -1);
    expect(drifters.length).toBeGreaterThanOrEqual(6);
    const home0 = drifters.map((d) => `${c.ownHomeX[d]},${c.ownHomeY[d]}`);
    sim.run(12);
    const moved = drifters.filter((d, k) => c.alive[d] && `${c.ownHomeX[d]},${c.ownHomeY[d]}` !== home0[k]).length;
    expect(moved).toBeGreaterThan(0);
  });

  it('someone the player calls out to stops and waits', () => {
    const sim = newGame(10, 1);
    const c = sim.agents.cols;
    sim.beginDay();
    sim.subStep(0);
    sim.subStep(1);
    // Anyone out walking.
    const walker = sim.agents.living.find((id) => c.phase[id] === 1 /* out */ && c.followId[id] === -1)!;
    expect(walker).toBeDefined();
    const r = applyPlayerAction(sim, { kind: 'hail', target: walker });
    expect(r.ok).toBe(true);
    const x = c.x[walker];
    const y = c.y[walker];
    sim.subStep(2);
    sim.subStep(3);
    expect([c.x[walker], c.y[walker]]).toEqual([x, y]);
    for (let s = 4; s < 8; s++) sim.subStep(s);
    sim.endDay();
  });

  it('hunting yields food and grows skill; big game needs skill', () => {
    const sim = newGame(11, 1);
    const p = sim.player!;
    const w = sim.world;
    const rate = sim.cfg.play.animalTileRate;
    const tiles: number[] = [];
    for (let t = 0; t < w.width * w.height; t++) if (animalsOnTile(t, w.biome[t], w.gameDensity[t], rate).length) tiles.push(t);
    expect(tiles.length).toBeGreaterThan(50);
    const hare = tiles.find((t) => animalsOnTile(t, w.biome[t], w.gameDensity[t], rate)[0] === 0)!;
    const s0 = p.skills.hunt;
    let got = 0;
    for (let d = 0; d < 6; d++) {
      for (let k = 0; k < 4; k++) {
        const before = sim.agents.cols.carriedFood[p.id];
        applyPlayerAction(sim, { kind: 'hunt', tile: hare, k: 0 });
        got += sim.agents.cols.carriedFood[p.id] - before;
        sim.agents.cols.carriedFood[p.id] = 0;
      }
      sim.step();
    }
    expect(got).toBeGreaterThan(0);
    expect(p.skills.hunt).toBeGreaterThan(s0);
    expect(ANIMALS[3].req).toBeGreaterThan(p.skills.hunt); // aurochs still out of reach
  });

  it('actions taken mid-day replay exactly', () => {
    const sim = newGame(12, 1);
    const c = sim.agents.cols;
    const p = sim.player!;
    for (let d = 0; d < 6; d++) {
      sim.beginDay();
      for (let s = 0; s < 8; s++) {
        if (s === 2) {
          const t = sim.agents.living.find((id) => id !== p.id && c.phase[id] === 1)!;
          applyPlayerAction(sim, { kind: 'hail', target: t });
          applyPlayerAction(sim, { kind: 'pos', x: c.x[p.id] + 0.3, y: c.y[p.id] });
        }
        if (s === 5) applyPlayerAction(sim, { kind: 'gather' });
        sim.subStep(s);
      }
      sim.endDay();
    }
    const re = Simulation.create(12);
    re.run(p.log[0].tick);
    replay(re, p.log.map((e) => ({ ...e })), sim.tick);
    expect(re.stateHash()).toBe(sim.stateHash());
  });
});
