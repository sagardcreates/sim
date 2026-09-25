import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/sim/config';
import { chronicle, describe as narrate, giniOf, howGainedPower, whoFounded, whyDissolved, whyQuery } from '../src/sim/history/historian';
import { Simulation } from '../src/sim/sim';
import { CAUSE_VIOLENCE } from '../src/sim/state/agents';
import { killAgent } from '../src/sim/systems/mortality';

describe('historian helpers', () => {
  it('gini is 0 for equality and near 1 for concentration', () => {
    expect(giniOf([1, 1, 1, 1])).toBeCloseTo(0);
    expect(giniOf([0, 0, 0, 10])).toBeGreaterThan(0.7);
  });
});

describe('historian on a real run (M6 acceptance)', () => {
  // Small world run for 60 years; seed chosen to include fission and leadership.
  const sim = Simulation.create(2, makeConfig());
  sim.run(60 * 365);

  it('whyQuery walks causes backwards to their roots', () => {
    const leaderEv = [...sim.events.macro.values()].find((e) => e.type === 'leader.changed' && e.causes.length > 0);
    expect(leaderEv).toBeDefined();
    const chain = whyQuery(sim, leaderEv!.id);
    expect(chain[0].event.id).toBe(leaderEv!.id);
    expect(chain.length).toBeGreaterThan(1);
    for (const step of chain.slice(1)) expect(step.depth).toBeGreaterThan(0);
  });

  it('answers who founded each daughter clan via the fission that caused it', () => {
    const daughters = [...sim.clans.clans.values()].filter((c) => c.founding.parentClanId > 0);
    for (const d of daughters) {
      const chain = whoFounded(sim, d.id);
      expect(chain[0].event.type).toBe('clan.founded');
      expect(chain[0].event.agents?.[0]).toBe(d.founding.founderId);
      expect(chain.some((s) => s.event.type === 'clan.fission')).toBe(true);
    }
  });

  it('answers why a clan dissolved with the departures/deaths that emptied it', () => {
    for (const c of [...sim.clans.clans.values()].filter((x) => x.dissolvedTick >= 0)) {
      const chain = whyDissolved(sim, c.id);
      expect(chain[0].event.type).toBe('clan.dissolved');
      expect(chain.length).toBeGreaterThan(1);
    }
  });

  it('explains how a leader gained power', () => {
    const t = sim.leaderTenures().sort((a, b) => b.years - a.years)[0];
    expect(t).toBeDefined();
    const chain = howGainedPower(sim, t.leader);
    expect(chain[0].event.type).toBe('leader.changed');
    expect(chain[0].text).toContain('became leader');
  });

  it('writes chronicle lines in the spec format', () => {
    const lines = chronicle(sim, { limit: 50 });
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l).toMatch(/^Year \d+: /);
    // A leader's death reads like "Year 17: Clan 3's leader Oru died at age 64 (...)".
    const sim2 = Simulation.fromSnapshot(JSON.parse(JSON.stringify(sim.snapshot())));
    const [clanId, L] = [...sim2.leaders.entries()][0] ?? [];
    if (L !== undefined) {
      const ev = killAgent(sim2, L, CAUSE_VIOLENCE, [], []);
      const text = narrate(sim2, sim2.events.macro.get(ev)!);
      expect(text).toMatch(new RegExp(`^Year \\d+: Clan ${clanId} · \\w+'s leader \\w+ died at age \\d+ \\(violence`));
    }
  });
});
