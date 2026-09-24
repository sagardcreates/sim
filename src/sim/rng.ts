/**
 * Seeded PRNG (sfc32). One independent stream per system, derived from
 * (seed, streamName), so adding draws in one system never perturbs another.
 * This is the ONLY source of randomness allowed in src/sim.
 */

/** 32-bit string hash (cyrb53-style mix, truncated) used to derive stream seeds. */
export function hashString(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

let softmaxScratch = new Float64Array(64);

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number, stream = '') {
    this.a = hashString(stream, seed ^ 0x9e3779b9);
    this.b = hashString(stream, seed ^ 0x243f6a88);
    this.c = hashString(stream, seed ^ 0xb7e15162);
    this.d = 1;
    // Warm up to decorrelate nearby seeds.
    for (let i = 0; i < 15; i++) this.nextUint32();
  }

  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box-Muller (no caching, keeps state trivially serializable). */
  normal(mean = 0, sd = 1): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(arr: T[] | Int32Array | Uint32Array): typeof arr {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /**
   * Softmax sample over scores at the given temperature. Never argmax (§0.5).
   * Returns the chosen index.
   */
  softmax(scores: ArrayLike<number>, temperature: number): number {
    const n = scores.length;
    if (n === 0) return -1;
    const t = Math.max(temperature, 1e-6);
    let max = -Infinity;
    for (let i = 0; i < n; i++) if (scores[i] > max) max = scores[i];
    let sum = 0;
    if (softmaxScratch.length < n) softmaxScratch = new Float64Array(Math.max(n, 2 * softmaxScratch.length));
    const w = softmaxScratch;
    for (let i = 0; i < n; i++) {
      w[i] = Math.exp((scores[i] - max) / t);
      sum += w[i];
    }
    let r = this.next() * sum;
    for (let i = 0; i < n; i++) {
      r -= w[i];
      if (r < 0) return i;
    }
    return n - 1;
  }

  getState(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  setState(s: RngState): void {
    this.a = s.a;
    this.b = s.b;
    this.c = s.c;
    this.d = s.d;
  }
}

/** Named streams, one per system. Created lazily; creation order does not matter. */
export class RngStreams {
  private streams = new Map<string, Rng>();
  constructor(readonly seed: number) {}

  get(name: string): Rng {
    let r = this.streams.get(name);
    if (!r) {
      r = new Rng(this.seed, name);
      this.streams.set(name, r);
    }
    return r;
  }

  getState(): Record<string, RngState> {
    const out: Record<string, RngState> = {};
    for (const name of [...this.streams.keys()].sort()) out[name] = this.streams.get(name)!.getState();
    return out;
  }

  setState(s: Record<string, RngState>): void {
    for (const name of Object.keys(s)) this.get(name).setState(s[name]);
  }
}
