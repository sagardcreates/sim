/** Uniform-grid spatial hash over agent positions, rebuilt when needed. */
export class SpatialHash {
  private cols: number;
  private rows: number;
  private cellStart: Int32Array;
  private cellCount: Int32Array;
  private items: Int32Array = new Int32Array(0);

  constructor(width: number, height: number, readonly cellSize: number) {
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cellCount = new Int32Array(this.cols * this.rows);
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return cy * this.cols + cx;
  }

  /** Counting-sort build; items within a cell keep the order of `ids` (deterministic). */
  build(ids: readonly number[], xs: Float64Array, ys: Float64Array): void {
    const n = ids.length;
    if (this.items.length < n) this.items = new Int32Array(Math.max(n, this.items.length * 2));
    this.cellCount.fill(0);
    for (let k = 0; k < n; k++) this.cellCount[this.cellOf(xs[ids[k]], ys[ids[k]])]++;
    let acc = 0;
    for (let c = 0; c < this.cellCount.length; c++) {
      this.cellStart[c] = acc;
      acc += this.cellCount[c];
    }
    this.cellStart[this.cellCount.length] = acc;
    this.cellCount.fill(0);
    for (let k = 0; k < n; k++) {
      const id = ids[k];
      const c = this.cellOf(xs[id], ys[id]);
      this.items[this.cellStart[c] + this.cellCount[c]++] = id;
    }
  }

  /** Calls fn for every indexed id within radius r of (x,y), in deterministic order. */
  query(x: number, y: number, r: number, xs: Float64Array, ys: Float64Array, fn: (id: number) => void): void {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor((x - r) / this.cellSize));
    const x1 = Math.min(this.cols - 1, Math.floor((x + r) / this.cellSize));
    const y0 = Math.max(0, Math.floor((y - r) / this.cellSize));
    const y1 = Math.min(this.rows - 1, Math.floor((y + r) / this.cellSize));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cy * this.cols + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const id = this.items[k];
          const dx = xs[id] - x;
          const dy = ys[id] - y;
          if (dx * dx + dy * dy <= r2) fn(id);
        }
      }
    }
  }
}
