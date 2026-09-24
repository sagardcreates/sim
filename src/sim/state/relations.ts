/**
 * Relationship maps (§7), pooled per living agent slot (like MindStore).
 * Each entry: other id, affinity (-1..1), deference (0..1), grudge (0..1),
 * familiarity (0..1), lastSeen tick. Values are stored as of `lastSeen`;
 * decay is lazy (applied on read from the elapsed time). When full, the entry
 * with the lowest familiarity is evicted. Kinship is never stored here.
 */

const DECAY_TABLE = 4096;

export interface DecayRates {
  /** Fraction per day that affinity relaxes toward 0. */
  affinity: number;
  deference: number;
  grudge: number;
  familiarity: number;
}

export interface RelView {
  aff: number;
  def: number;
  grudge: number;
  fam: number;
}

export class RelationStore {
  capacity = 0;
  readonly cap: number;
  other = new Int32Array(0);
  aff = new Float64Array(0);
  def = new Float64Array(0);
  grudge = new Float64Array(0);
  fam = new Float64Array(0);
  seen = new Int32Array(0);
  count = new Int32Array(0);
  /** Reused result object for reads (callers copy what they need). */
  private view: RelView = { aff: 0, def: 0, grudge: 0, fam: 0 };

  /** Decay factor tables: (1 - rate)^dt for dt < TABLE (exactly what Math.pow gives). */
  private tAff: Float64Array;
  private tDef: Float64Array;
  private tGrudge: Float64Array;
  private tFam: Float64Array;

  constructor(cap: number, private decay: DecayRates) {
    this.cap = cap;
    this.grow(256);
    const table = (rate: number) => {
      const t = new Float64Array(DECAY_TABLE);
      for (let i = 0; i < DECAY_TABLE; i++) t[i] = Math.pow(1 - rate, i);
      return t;
    };
    this.tAff = table(decay.affinity);
    this.tDef = table(decay.deference);
    this.tGrudge = table(decay.grudge);
    this.tFam = table(decay.familiarity);
  }

  private factor(t: Float64Array, rate: number, dt: number): number {
    return dt < DECAY_TABLE ? t[dt] : Math.pow(1 - rate, dt);
  }

  ensureSlots(n: number): void {
    while (this.capacity < n) this.grow(this.capacity * 2);
  }

  private grow(n: number): void {
    const c = this.cap;
    const g = <T extends Int32Array | Float64Array>(a: T, per: number): T => {
      const b = new (a.constructor as new (len: number) => T)(n * per);
      b.set(a);
      return b;
    };
    this.other = g(this.other, c);
    this.aff = g(this.aff, c);
    this.def = g(this.def, c);
    this.grudge = g(this.grudge, c);
    this.fam = g(this.fam, c);
    this.seen = g(this.seen, c);
    this.count = g(this.count, 1);
    this.capacity = n;
  }

  clearSlot(slot: number): void {
    this.ensureSlots(slot + 1);
    this.count[slot] = 0;
  }

  private find(slot: number, other: number): number {
    const base = slot * this.cap;
    const n = this.count[slot];
    for (let k = 0; k < n; k++) if (this.other[base + k] === other) return base + k;
    return -1;
  }

  private decayed(i: number, tick: number): RelView {
    const dt = tick - this.seen[i];
    const v = this.view;
    if (dt <= 0) {
      v.aff = this.aff[i];
      v.def = this.def[i];
      v.grudge = this.grudge[i];
      v.fam = this.fam[i];
      return v;
    }
    const d = this.decay;
    v.aff = this.aff[i] * this.factor(this.tAff, d.affinity, dt);
    v.def = this.def[i] * this.factor(this.tDef, d.deference, dt);
    v.grudge = this.grudge[i] * this.factor(this.tGrudge, d.grudge, dt);
    v.fam = this.fam[i] * this.factor(this.tFam, d.familiarity, dt);
    return v;
  }

  /** Current (decayed) view of slot's relationship to `other`, or undefined if unknown. */
  get(slot: number, other: number, tick: number): RelView | undefined {
    const i = this.find(slot, other);
    return i < 0 ? undefined : this.decayed(i, tick);
  }

  affinity(slot: number, other: number, tick: number): number {
    const i = this.find(slot, other);
    if (i < 0) return 0;
    const dt = tick - this.seen[i];
    return dt <= 0 ? this.aff[i] : this.aff[i] * this.factor(this.tAff, this.decay.affinity, dt);
  }

  /**
   * Applies deltas (after bringing the entry up to date), creating it if needed.
   * Returns the entry index.
   */
  update(slot: number, other: number, tick: number, dAff: number, dDef: number, dGrudge: number, dFam: number): number {
    let i = this.find(slot, other);
    if (i < 0) {
      i = this.insert(slot, other, tick);
    } else {
      const v = this.decayed(i, tick);
      this.aff[i] = v.aff;
      this.def[i] = v.def;
      this.grudge[i] = v.grudge;
      this.fam[i] = v.fam;
    }
    this.aff[i] = clamp(this.aff[i] + dAff, -1, 1);
    this.def[i] = clamp(this.def[i] + dDef, 0, 1);
    this.grudge[i] = clamp(this.grudge[i] + dGrudge, 0, 1);
    this.fam[i] = clamp(this.fam[i] + dFam, 0, 1);
    this.seen[i] = tick;
    return i;
  }

  private insert(slot: number, other: number, tick: number): number {
    const base = slot * this.cap;
    const n = this.count[slot];
    let i: number;
    if (n < this.cap) {
      i = base + n;
      this.count[slot] = n + 1;
    } else {
      // Evict the lowest current familiarity (ties: oldest entry).
      let worst = Infinity;
      i = base;
      for (let k = 0; k < n; k++) {
        const f = this.decayed(base + k, tick).fam;
        if (f < worst) {
          worst = f;
          i = base + k;
        }
      }
    }
    this.other[i] = other;
    this.aff[i] = 0;
    this.def[i] = 0;
    this.grudge[i] = 0;
    this.fam[i] = 0;
    this.seen[i] = tick;
    return i;
  }

  /** Iterates entries (decayed) of a slot. */
  forEach(slot: number, tick: number, fn: (other: number, v: RelView) => void): void {
    const base = slot * this.cap;
    const n = this.count[slot];
    for (let k = 0; k < n; k++) fn(this.other[base + k], this.decayed(base + k, tick));
  }

  /** Removes entries pointing at `dead` lazily is fine; this drops them eagerly for one slot. */
  remove(slot: number, other: number): void {
    const i = this.find(slot, other);
    if (i < 0) return;
    const base = slot * this.cap;
    const last = base + this.count[slot] - 1;
    this.other[i] = this.other[last];
    this.aff[i] = this.aff[last];
    this.def[i] = this.def[last];
    this.grudge[i] = this.grudge[last];
    this.fam[i] = this.fam[last];
    this.seen[i] = this.seen[last];
    this.count[slot]--;
  }

  snapshot(highWater: number): RelationSnapshot {
    const c = this.cap;
    return {
      other: Array.from(this.other.subarray(0, highWater * c)),
      aff: Array.from(this.aff.subarray(0, highWater * c)),
      def: Array.from(this.def.subarray(0, highWater * c)),
      grudge: Array.from(this.grudge.subarray(0, highWater * c)),
      fam: Array.from(this.fam.subarray(0, highWater * c)),
      seen: Array.from(this.seen.subarray(0, highWater * c)),
      count: Array.from(this.count.subarray(0, highWater)),
    };
  }

  restore(s: RelationSnapshot, highWater: number): void {
    this.ensureSlots(highWater);
    this.other.set(s.other);
    this.aff.set(s.aff);
    this.def.set(s.def);
    this.grudge.set(s.grudge);
    this.fam.set(s.fam);
    this.seen.set(s.seen);
    this.count.set(s.count);
  }

  hashArrays(highWater: number): (Int32Array | Float64Array)[] {
    const c = this.cap;
    return [
      this.other.subarray(0, highWater * c), this.aff.subarray(0, highWater * c), this.def.subarray(0, highWater * c),
      this.grudge.subarray(0, highWater * c), this.fam.subarray(0, highWater * c), this.seen.subarray(0, highWater * c),
      this.count.subarray(0, highWater),
    ];
  }
}

export interface RelationSnapshot {
  other: number[];
  aff: number[];
  def: number[];
  grudge: number[];
  fam: number[];
  seen: number[];
  count: number[];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
