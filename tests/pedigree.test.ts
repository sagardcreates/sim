import { describe, expect, it } from 'vitest';
import { AgentStore, SEX_FEMALE, SEX_MALE } from '../src/sim/state/agents';
import { KinIndex, Pedigree } from '../src/sim/state/pedigree';

/** Builds a pedigree from [mother, father] pairs (-1 = founder), in id order. */
function build(parents: [number, number][]) {
  const a = new AgentStore(16);
  const ped = new Pedigree(a);
  parents.forEach(([m, f], i) => {
    const id = a.create(`p${i}`);
    a.cols.sex[id] = i % 2 ? SEX_MALE : SEX_FEMALE;
    a.cols.motherId[id] = m;
    a.cols.fatherId[id] = f;
    ped.registerBirth(id);
  });
  return { a, ped };
}

describe('relatedness math', () => {
  // 0,1 founders; 2,3 full sibs; 4 = child of 0 with founder 5 (half-sib of 2,3)
  // 6 founder; 7 = child of 2 and 6; 8 founder; 9 = child of 3 and 8 -> 7,9 first cousins
  // 10 = child of 7 and founder 11 -> first cousin once removed of 9
  const { a, ped } = build([
    [-1, -1], [-1, -1], [0, 1], [0, 1], [0, 5], [-1, -1], [-1, -1], [2, 6], [-1, -1], [3, 8], [7, 11], [-1, -1],
  ]);
  void a;

  it('parent-child and full siblings = 0.5', () => {
    expect(ped.relatedness(0, 2)).toBeCloseTo(0.5);
    expect(ped.relatedness(2, 3)).toBeCloseTo(0.5);
  });
  it('half siblings = 0.25, grandparent = 0.25, aunt = 0.25', () => {
    expect(ped.relatedness(2, 4)).toBeCloseTo(0.25);
    expect(ped.relatedness(0, 7)).toBeCloseTo(0.25);
    expect(ped.relatedness(3, 7)).toBeCloseTo(0.25);
  });
  it('first cousins = 0.125 and unrelated = 0', () => {
    expect(ped.relatedness(7, 9)).toBeCloseTo(0.125);
    expect(ped.relatedness(6, 8)).toBe(0);
  });
  it('known relatedness matches exact relatedness for close kin, and is symmetric', () => {
    for (let x = 0; x < 12; x++) {
      for (let y = 0; y < 12; y++) {
        expect(ped.relatedness(x, y)).toBeCloseTo(ped.relatedness(y, x));
        const exact = ped.exactRelatedness(x, y);
        if (ped.relatedness(x, y) >= 0.125) expect(ped.relatedness(x, y)).toBeCloseTo(exact);
      }
    }
    // First cousin once removed (1/16) is beyond what agents know.
    expect(ped.exactRelatedness(9, 10)).toBeCloseTo(0.0625);
  });
  it('inbreeding raises relatedness above the outbred value', () => {
    // 12 = child of full sibs 2 and 3; relatedness to its mother > 0.5
    const { ped: p2 } = build([[-1, -1], [-1, -1], [0, 1], [0, 1], [2, 3]]);
    expect(p2.exactRelatedness(2, 4)).toBeGreaterThan(0.5);
  });
});

describe('kin index', () => {
  const { a, ped } = build([
    [-1, -1], [-1, -1], [0, 1], [0, 1], [0, 5], [-1, -1], [-1, -1], [2, 6], [-1, -1], [3, 8], [7, 11], [-1, -1],
  ]);
  const kin = new KinIndex(a, ped);
  kin.rebuildAll();

  it('is symmetric, id-sorted, and agrees with pedigree relatedness', () => {
    for (let x = 0; x < a.count; x++) {
      const ids = kin.kinOf(x);
      expect([...ids]).toEqual([...ids].sort((p, q) => p - q));
      for (const y of ids) {
        expect(kin.r(y, x)).toBeCloseTo(kin.r(x, y));
        expect(kin.r(x, y)).toBeCloseTo(ped.relatedness(x, y));
      }
    }
    expect(kin.r(7, 9)).toBeCloseTo(0.125);
    expect(kin.r(9, 10)).toBe(0);
  });

  it('incremental births give the same lists as a full rebuild', () => {
    const b = new AgentStore(16);
    const p = new Pedigree(b);
    const k = new KinIndex(b, p);
    const parents: [number, number][] = [[-1, -1], [-1, -1], [0, 1], [0, 1], [-1, -1], [2, 4], [3, -1], [5, 6]];
    parents.forEach(([m, f], i) => {
      const id = b.create(`q${i}`);
      b.cols.motherId[id] = m;
      b.cols.fatherId[id] = f;
      p.registerBirth(id);
      k.addBirth(id);
    });
    const incremental = parents.map((_, i) => [...k.kinOf(i)]);
    k.rebuildAll();
    expect(parents.map((_, i) => [...k.kinOf(i)])).toEqual(incremental);
  });
});
