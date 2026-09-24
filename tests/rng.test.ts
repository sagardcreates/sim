import { describe, expect, it } from 'vitest';
import { Rng, RngStreams } from '../src/sim/rng';

describe('Rng', () => {
  it('is reproducible for the same seed and stream', () => {
    const a = new Rng(42, 'x');
    const b = new Rng(42, 'x');
    for (let i = 0; i < 1000; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('gives independent sequences for different streams and seeds', () => {
    const a = new Rng(42, 'x');
    const b = new Rng(42, 'y');
    const c = new Rng(43, 'x');
    const sa = Array.from({ length: 8 }, () => a.nextUint32());
    const sb = Array.from({ length: 8 }, () => b.nextUint32());
    const sc = Array.from({ length: 8 }, () => c.nextUint32());
    expect(sa).not.toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('produces roughly uniform floats in [0,1)', () => {
    const r = new Rng(7);
    let sum = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
  });

  it('softmax samples proportionally and never collapses to argmax', () => {
    const r = new Rng(3);
    const counts = [0, 0, 0];
    const scores = [0, Math.log(2), Math.log(4)]; // weights 1:2:4 at T=1
    for (let i = 0; i < 70000; i++) counts[r.softmax(scores, 1)]++;
    expect(counts[0] / 70000).toBeCloseTo(1 / 7, 1);
    expect(counts[1] / 70000).toBeCloseTo(2 / 7, 1);
    expect(counts[2] / 70000).toBeCloseTo(4 / 7, 1);
  });

  it('shuffle is a permutation', () => {
    const r = new Rng(9);
    const arr = Array.from({ length: 100 }, (_, i) => i);
    r.shuffle(arr);
    expect([...arr].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('stream state round-trips', () => {
    const s = new RngStreams(5);
    s.get('a').next();
    s.get('b').next();
    const saved = s.getState();
    const expected = [s.get('a').next(), s.get('b').next()];
    const t = new RngStreams(5);
    t.setState(saved);
    expect([t.get('a').next(), t.get('b').next()]).toEqual(expected);
  });
});
