import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/rng';
import { RelationStore } from '../src/sim/state/relations';
import { labelPropagation, modularity } from '../src/sim/systems/clans';

describe('relationship store', () => {
  const decay = { affinity: 0.01, deference: 0.01, grudge: 0.01, familiarity: 0.01 };

  it('clamps values, decays lazily with elapsed time, and never stores kinship', () => {
    const r = new RelationStore(4, decay);
    r.clearSlot(0);
    r.update(0, 7, 0, 5, 5, 5, 5);
    expect(r.get(0, 7, 0)).toMatchObject({ aff: 1, def: 1, grudge: 1, fam: 1 });
    const later = r.get(0, 7, 100)!;
    expect(later.aff).toBeCloseTo(Math.pow(0.99, 100));
    // Reading does not mutate: the stored value is still as of tick 0.
    expect(r.get(0, 7, 0)!.aff).toBe(1);
    r.update(0, 8, 0, -5, 0, 0, 0);
    expect(r.get(0, 8, 0)!.aff).toBe(-1);
  });

  it('evicts the lowest-familiarity entry when full', () => {
    const r = new RelationStore(3, decay);
    r.clearSlot(0);
    r.update(0, 1, 0, 0, 0, 0, 0.9);
    r.update(0, 2, 0, 0, 0, 0, 0.1);
    r.update(0, 3, 0, 0, 0, 0, 0.5);
    r.update(0, 4, 0, 0, 0, 0, 0.3);
    expect(r.get(0, 2, 0)).toBeUndefined();
    expect(r.get(0, 1, 0)).toBeDefined();
    expect(r.get(0, 4, 0)).toBeDefined();
    expect(r.count[0]).toBe(3);
  });

  it('keeps slots independent', () => {
    const r = new RelationStore(4, decay);
    r.clearSlot(0);
    r.clearSlot(1);
    r.update(0, 5, 0, 0.5, 0, 0, 0);
    expect(r.get(1, 5, 0)).toBeUndefined();
  });
});

describe('community detection', () => {
  it('finds two dense groups joined by one weak edge', () => {
    const n = 10;
    const W = new Float64Array(n * n);
    const link = (a: number, b: number, w: number) => {
      W[a * n + b] = w;
      W[b * n + a] = w;
    };
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) link(a, b, 1);
    for (let a = 5; a < 10; a++) for (let b = a + 1; b < 10; b++) link(a, b, 1);
    link(4, 5, 0.1);
    const labels = labelPropagation(W, n, new Rng(3, 'lp'));
    expect(new Set(labels.slice(0, 5)).size).toBe(1);
    expect(new Set(labels.slice(5)).size).toBe(1);
    expect(labels[0]).not.toBe(labels[9]);
    expect(modularity(W, n, labels)).toBeGreaterThan(0.4);
    expect(modularity(W, n, new Array(n).fill(0))).toBeCloseTo(0);
  });
});
