/**
 * Pedigree queries. Kinship is NEVER stored (§7): it is computed on demand
 * from motherId/fatherId. Ids are assigned in birth order, so an agent can
 * only descend from lower ids; this makes the classic kinship recursion
 * f(a,b) = ½[f(mother(a),b) + f(father(a),b)] (a the younger) well-founded.
 *
 * `relatedness` is what agents use: limited to KNOWN_DEPTH generational
 * steps, which covers kin up to first cousins (§11). It is a pure function of
 * the pedigree (no cache), so results never depend on query history.
 */
import { NO_ID, type AgentStore } from './agents';

/** Generational steps searched; 4 reaches first cousins via shared grandparents. */
export const KNOWN_DEPTH = 4;

export class Pedigree {
  /** children[id] = ids of children, in birth order. Rebuilt from parents on restore. */
  children: number[][] = [];

  constructor(private agents: AgentStore) {}

  registerBirth(child: number): void {
    const c = this.agents.cols;
    this.children[child] = [];
    const m = c.motherId[child];
    const f = c.fatherId[child];
    if (m !== NO_ID) (this.children[m] ??= []).push(child);
    if (f !== NO_ID) (this.children[f] ??= []).push(child);
  }

  rebuild(): void {
    this.children = [];
    for (let id = 0; id < this.agents.count; id++) this.registerBirth(id);
  }

  childrenOf(id: number): readonly number[] {
    return this.children[id] ?? [];
  }

  /** Relatedness as agents know it (kin up to first cousins). 1 for self. */
  relatedness(a: number, b: number): number {
    if (a === b) return 1;
    return 2 * this.kin(a, b, 0, KNOWN_DEPTH, undefined);
  }

  /** Exact relatedness over the full pedigree (analysis/tests), with a per-call memo. */
  exactRelatedness(a: number, b: number): number {
    if (a === b) return 1;
    return 2 * this.kin(a, b, 0, Infinity, new Map());
  }

  private kin(a: number, b: number, depth: number, maxDepth: number, memo: Map<number, number> | undefined): number {
    if (a === NO_ID || b === NO_ID || depth > maxDepth) return 0;
    const c = this.agents.cols;
    if (a === b) return 0.5 * (1 + this.kin(c.motherId[a], c.fatherId[a], depth + 1, maxDepth, memo));
    if (a < b) {
      const t = a;
      a = b;
      b = t;
    }
    const key = a * 4194304 + b;
    if (memo) {
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
    }
    const v = 0.5 * (this.kin(c.motherId[a], b, depth + 1, maxDepth, memo) + this.kin(c.fatherId[a], b, depth + 1, maxDepth, memo));
    memo?.set(key, v);
    return v;
  }

  /** Westermarck: shared a mother or a social father during childhood. */
  coReared(a: number, b: number): boolean {
    const c = this.agents.cols;
    const ma = c.motherId[a];
    if (ma !== NO_ID && ma === c.motherId[b]) return true;
    const ra = c.rearerId[a];
    const rb = c.rearerId[b];
    if (ra !== NO_ID && (ra === rb || ra === c.fatherId[b])) return true;
    return rb !== NO_ID && rb === c.fatherId[a];
  }
}

/** Minimum relatedness for someone to count as "known kin" (first cousins = 0.125). */
export const KNOWN_KIN_MIN_R = 0.1;

/**
 * Known-kin index: for each agent, relatives up to first cousins with their r,
 * sorted by id. Derived entirely from the pedigree (rebuilt on restore), and
 * maintained incrementally at each birth so lookups are O(#kin).
 */
export class KinIndex {
  ids: number[][] = [];
  rs: number[][] = [];

  constructor(private agents: AgentStore, private pedigree: Pedigree) {}

  /** Candidate relatives of x: descendants (2 generations) of x, its parents and grandparents. */
  private candidates(x: number): number[] {
    const c = this.agents.cols;
    const roots = [x];
    for (const p of [c.motherId[x], c.fatherId[x]]) {
      if (p === NO_ID) continue;
      roots.push(p);
      for (const g of [c.motherId[p], c.fatherId[p]]) if (g !== NO_ID) roots.push(g);
    }
    const out = new Set<number>();
    for (const r of roots) {
      out.add(r);
      for (const k of this.pedigree.childrenOf(r)) {
        out.add(k);
        for (const gk of this.pedigree.childrenOf(k)) out.add(gk);
      }
    }
    out.delete(x);
    return [...out].sort((a, b) => a - b);
  }

  compute(x: number): { ids: number[]; rs: number[] } {
    const ids: number[] = [];
    const rs: number[] = [];
    for (const k of this.candidates(x)) {
      const r = this.pedigree.relatedness(x, k);
      if (r >= KNOWN_KIN_MIN_R) {
        ids.push(k);
        rs.push(r);
      }
    }
    return { ids, rs };
  }

  /** Registers a newborn (highest id so far): its list, and itself appended to its kin's lists. */
  addBirth(x: number): void {
    const { ids, rs } = this.compute(x);
    this.ids[x] = ids;
    this.rs[x] = rs;
    for (let k = 0; k < ids.length; k++) {
      const other = ids[k];
      (this.ids[other] ??= []).push(x);
      (this.rs[other] ??= []).push(rs[k]);
    }
  }

  /** Full rebuild for everyone (after restore or founding). Lists stay id-sorted. */
  rebuildAll(): void {
    this.ids = [];
    this.rs = [];
    for (let x = 0; x < this.agents.count; x++) {
      const { ids, rs } = this.compute(x);
      this.ids[x] = ids;
      this.rs[x] = rs;
    }
  }

  kinOf(x: number): readonly number[] {
    return this.ids[x] ?? [];
  }

  rOf(x: number): readonly number[] {
    return this.rs[x] ?? [];
  }

  /** r between x and y if y is known kin of x, else 0. */
  r(x: number, y: number): number {
    if (x === y) return 1;
    const ids = this.ids[x];
    if (!ids) return 0;
    // Binary search (ids sorted).
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = ids[mid];
      if (v === y) return this.rs[x][mid];
      if (v < y) lo = mid + 1;
      else hi = mid - 1;
    }
    return 0;
  }
}
