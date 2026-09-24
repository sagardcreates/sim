import { Rng } from '../rng';

/** Seeded 2D value noise with smoothstep interpolation on a wrapping 256 lattice. */
export class ValueNoise {
  private lattice = new Float64Array(256 * 256);

  constructor(rng: Rng) {
    for (let i = 0; i < this.lattice.length; i++) this.lattice[i] = rng.next();
  }

  private at(ix: number, iy: number): number {
    return this.lattice[((iy & 255) << 8) | (ix & 255)];
  }

  sample(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = this.at(x0, y0);
    const b = this.at(x0 + 1, y0);
    const c = this.at(x0, y0 + 1);
    const d = this.at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }

  /** Fractal sum normalized to 0..1. */
  fbm(x: number, y: number, octaves: number): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x * freq, y * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
