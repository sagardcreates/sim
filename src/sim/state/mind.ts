/**
 * Per-living-agent memory, pooled in typed arrays indexed by slot (slots are
 * recycled on death via a LIFO free list, which is deterministic). Holds
 * known places (§4 Memory), the current path, and the "why" terms of the last
 * decision (§0.10). Relationship maps live in state/relations.ts.
 */

export const WHY_TERMS = 3;

export class MindStore {
  capacity = 0;
  /** Highest slot index ever used + 1. */
  highWater = 0;
  free: number[] = [];

  // places: tile, plant quality seen (food units), game density seen, tick seen
  placeTile = new Int32Array(0);
  placePlant = new Float64Array(0);
  placeGame = new Float64Array(0);
  placeTick = new Int32Array(0);
  placeCount = new Int32Array(0);

  pathTiles = new Int32Array(0);
  pathLen = new Int32Array(0);
  pathPos = new Int32Array(0);

  whyGoal = new Uint8Array(0);
  whyTerm = new Uint8Array(0);
  whyVal = new Float64Array(0);

  constructor(readonly placeCap: number, readonly maxPath: number) {
    this.grow(256);
  }

  private grow(n: number): void {
    const pc = this.placeCap;
    const mp = this.maxPath;
    const g = <T extends Int32Array | Float64Array | Uint8Array>(a: T, per: number): T => {
      const b = new (a.constructor as new (len: number) => T)(n * per);
      b.set(a);
      return b;
    };
    this.placeTile = g(this.placeTile, pc);
    this.placePlant = g(this.placePlant, pc);
    this.placeGame = g(this.placeGame, pc);
    this.placeTick = g(this.placeTick, pc);
    this.placeCount = g(this.placeCount, 1);
    this.pathTiles = g(this.pathTiles, mp);
    this.pathLen = g(this.pathLen, 1);
    this.pathPos = g(this.pathPos, 1);
    this.whyGoal = g(this.whyGoal, 1);
    this.whyTerm = g(this.whyTerm, WHY_TERMS);
    this.whyVal = g(this.whyVal, WHY_TERMS);
    this.capacity = n;
  }

  alloc(): number {
    let s: number;
    if (this.free.length) s = this.free.pop()!;
    else {
      if (this.highWater >= this.capacity) this.grow(this.capacity * 2);
      s = this.highWater++;
    }
    this.placeCount[s] = 0;
    this.pathLen[s] = 0;
    this.pathPos[s] = 0;
    this.whyGoal[s] = 0;
    for (let k = 0; k < WHY_TERMS; k++) {
      this.whyTerm[s * WHY_TERMS + k] = 0;
      this.whyVal[s * WHY_TERMS + k] = 0;
    }
    return s;
  }

  release(slot: number): void {
    this.free.push(slot);
  }

  /** Records an observation of a tile; replaces the stalest/poorest entry when full. */
  observePlace(slot: number, tile: number, plant: number, game: number, tick: number): void {
    const pc = this.placeCap;
    const base = slot * pc;
    const n = this.placeCount[slot];
    for (let k = 0; k < n; k++) {
      if (this.placeTile[base + k] === tile) {
        this.placePlant[base + k] = plant;
        this.placeGame[base + k] = game;
        this.placeTick[base + k] = tick;
        return;
      }
    }
    let k = n;
    if (n >= pc) {
      // Evict the entry with the lowest value (quality discounted by age).
      let worst = Infinity;
      k = 0;
      for (let j = 0; j < pc; j++) {
        const v = (this.placePlant[base + j] + this.placeGame[base + j]) / (1 + (tick - this.placeTick[base + j]) / 60);
        if (v < worst) {
          worst = v;
          k = j;
        }
      }
    } else {
      this.placeCount[slot] = n + 1;
    }
    this.placeTile[base + k] = tile;
    this.placePlant[base + k] = plant;
    this.placeGame[base + k] = game;
    this.placeTick[base + k] = tick;
  }

  setWhy(slot: number, goal: number, terms: readonly number[], vals: readonly number[]): void {
    this.whyGoal[slot] = goal;
    for (let k = 0; k < WHY_TERMS; k++) {
      this.whyTerm[slot * WHY_TERMS + k] = terms[k] ?? 0;
      this.whyVal[slot * WHY_TERMS + k] = vals[k] ?? 0;
    }
  }

  snapshot(): MindSnapshot {
    const hw = this.highWater;
    const pc = this.placeCap;
    const mp = this.maxPath;
    return {
      highWater: hw,
      free: [...this.free],
      placeTile: Array.from(this.placeTile.subarray(0, hw * pc)),
      placePlant: Array.from(this.placePlant.subarray(0, hw * pc)),
      placeGame: Array.from(this.placeGame.subarray(0, hw * pc)),
      placeTick: Array.from(this.placeTick.subarray(0, hw * pc)),
      placeCount: Array.from(this.placeCount.subarray(0, hw)),
      pathTiles: Array.from(this.pathTiles.subarray(0, hw * mp)),
      pathLen: Array.from(this.pathLen.subarray(0, hw)),
      pathPos: Array.from(this.pathPos.subarray(0, hw)),
      whyGoal: Array.from(this.whyGoal.subarray(0, hw)),
      whyTerm: Array.from(this.whyTerm.subarray(0, hw * WHY_TERMS)),
      whyVal: Array.from(this.whyVal.subarray(0, hw * WHY_TERMS)),
    };
  }

  restore(s: MindSnapshot): void {
    while (this.capacity < s.highWater) this.grow(this.capacity * 2);
    this.highWater = s.highWater;
    this.free = [...s.free];
    this.placeTile.set(s.placeTile);
    this.placePlant.set(s.placePlant);
    this.placeGame.set(s.placeGame);
    this.placeTick.set(s.placeTick);
    this.placeCount.set(s.placeCount);
    this.pathTiles.set(s.pathTiles);
    this.pathLen.set(s.pathLen);
    this.pathPos.set(s.pathPos);
    this.whyGoal.set(s.whyGoal);
    this.whyTerm.set(s.whyTerm);
    this.whyVal.set(s.whyVal);
  }

  /** Arrays included in the state hash (up to highWater). */
  hashArrays(): (Int32Array | Float64Array | Uint8Array)[] {
    const hw = this.highWater;
    const pc = this.placeCap;
    const mp = this.maxPath;
    return [
      this.placeTile.subarray(0, hw * pc), this.placePlant.subarray(0, hw * pc), this.placeGame.subarray(0, hw * pc),
      this.placeTick.subarray(0, hw * pc), this.placeCount.subarray(0, hw), this.pathTiles.subarray(0, hw * mp),
      this.pathLen.subarray(0, hw), this.pathPos.subarray(0, hw), this.whyGoal.subarray(0, hw),
      this.whyTerm.subarray(0, hw * WHY_TERMS), this.whyVal.subarray(0, hw * WHY_TERMS), Int32Array.from(this.free),
    ];
  }
}

export interface MindSnapshot {
  highWater: number;
  free: number[];
  placeTile: number[];
  placePlant: number[];
  placeGame: number[];
  placeTick: number[];
  placeCount: number[];
  pathTiles: number[];
  pathLen: number[];
  pathPos: number[];
  whyGoal: number[];
  whyTerm: number[];
  whyVal: number[];
}
