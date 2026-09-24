/**
 * Cached cost-distance fields to home sites (§14: flow fields instead of
 * per-agent A*). A field depends only on static terrain, so the cache is a
 * pure memo: it never affects results and is not part of sim state.
 */
import type { World } from './terrain';

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DIRS: readonly [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class FlowFields {
  private cache = new Map<number, Float64Array>();
  private heapIdx: Int32Array;
  private heapKey: Float64Array;

  constructor(private world: World, private impassable: number, private radius: number, private cacheSize: number) {
    this.heapIdx = new Int32Array(world.width * world.height * 8);
    this.heapKey = new Float64Array(world.width * world.height * 8);
  }

  /** Cost distance from every tile to `home` (Infinity if unreachable within radius). */
  get(home: number): Float64Array {
    let f = this.cache.get(home);
    if (f) return f;
    f = this.compute(home);
    this.cache.set(home, f);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    return f;
  }

  private compute(home: number): Float64Array {
    const w = this.world;
    const W = w.width;
    const H = w.height;
    const dist = new Float64Array(W * H).fill(Infinity);
    const idx = this.heapIdx;
    const key = this.heapKey;
    let size = 0;
    const push = (i: number, k: number) => {
      let p = size++;
      while (p > 0) {
        const parent = (p - 1) >> 1;
        if (key[parent] <= k) break;
        idx[p] = idx[parent];
        key[p] = key[parent];
        p = parent;
      }
      idx[p] = i;
      key[p] = k;
    };
    const pop = (): number => {
      const top = idx[0];
      size--;
      const li = idx[size];
      const lk = key[size];
      let p = 0;
      for (;;) {
        let ch = 2 * p + 1;
        if (ch >= size) break;
        if (ch + 1 < size && key[ch + 1] < key[ch]) ch++;
        if (key[ch] >= lk) break;
        idx[p] = idx[ch];
        key[p] = key[ch];
        p = ch;
      }
      idx[p] = li;
      key[p] = lk;
      return top;
    };
    dist[home] = 0;
    push(home, 0);
    while (size > 0) {
      const d0 = key[0];
      const i = pop();
      if (d0 > dist[i]) continue;
      if (d0 > this.radius) break;
      const x = i % W;
      const y = (i / W) | 0;
      for (const [dx, dy, m] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        const cost = w.movementCost[j];
        if (cost >= this.impassable) continue;
        const nd = d0 + cost * m;
        if (nd < dist[j]) {
          dist[j] = nd;
          push(j, nd);
        }
      }
    }
    return dist;
  }

  /** Next tile one step closer to home (or -1 if at home / unreachable). */
  static stepToward(field: Float64Array, world: World, from: number): number {
    const W = world.width;
    const x = from % W;
    const y = (from / W) | 0;
    let best = -1;
    let bestD = field[from];
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= world.height) continue;
      const j = ny * W + nx;
      if (field[j] < bestD) {
        bestD = field[j];
        best = j;
      }
    }
    return best;
  }

  static isDiagonal(a: number, b: number, W: number): boolean {
    return a % W !== b % W && ((a / W) | 0) !== ((b / W) | 0);
  }
}
