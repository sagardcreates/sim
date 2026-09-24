import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/sim/config';
import { Simulation } from '../src/sim/sim';

describe('determinism (M0 acceptance)', () => {
  it('same seed => identical state hash at day 3650, run twice', () => {
    const a = Simulation.create(1, makeConfig());
    const b = Simulation.create(1, makeConfig());
    a.run(3650);
    b.run(3650);
    expect(a.tick).toBe(3650);
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('different seeds diverge', () => {
    const a = Simulation.create(1);
    const b = Simulation.create(2);
    a.run(10);
    b.run(10);
    expect(a.stateHash()).not.toBe(b.stateHash());
  });

  it('observers do not change results', () => {
    const plain = Simulation.create(3);
    const observed = Simulation.create(3);
    let frames = 0;
    observed.onSubStep = (s) => {
      frames += s.agents.living.length > 0 ? 1 : 0;
    };
    observed.events.subscribe(() => {});
    plain.run(400);
    observed.run(400);
    expect(frames).toBe(400 * 8);
    expect(observed.stateHash()).toBe(plain.stateHash());
  });

  it('snapshot -> JSON -> restore continues identically', () => {
    const uninterrupted = Simulation.create(4);
    uninterrupted.run(800);

    const first = Simulation.create(4);
    first.run(365);
    const restored = Simulation.fromSnapshot(JSON.parse(JSON.stringify(first.snapshot())));
    expect(restored.stateHash()).toBe(first.stateHash());
    restored.run(435);
    expect(restored.stateHash()).toBe(uninterrupted.stateHash());
  });
});
