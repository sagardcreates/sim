/**
 * Terrain generation (§3). Static fields are regenerated deterministically from
 * (seed, config) and are never snapshotted; dynamic fields (plantFood, game) are.
 */
import type { BiomeName, SimConfig } from '../config';
import { Rng } from '../rng';
import { ValueNoise } from './noise';

export const BIOME_GRASSLAND = 0;
export const BIOME_FOREST = 1;
export const BIOME_HILLS = 2;
export const BIOME_SCRUB = 3;
export const BIOME_WATER = 4;
export const BIOME_NAMES: BiomeName[] = ['grassland', 'forest', 'hills', 'scrub', 'water'];

export interface World {
  width: number;
  height: number;
  // static
  biome: Uint8Array;
  /** 1 for river tiles (water, but fordable at riverMovementCost). */
  river: Uint8Array;
  elevation: Float64Array;
  moisture: Float64Array;
  movementCost: Float64Array;
  plantCapacity: Float64Array;
  regrowthRate: Float64Array;
  /** Game density the tile recovers toward. */
  gameCapacity: Float64Array;
  /** Chebyshev distance (tiles) to nearest water tile, capped at 255. */
  waterDistance: Uint8Array;
  /** 1 within waterAccessRadius, falling to 0 beyond it. */
  waterAccess: Float64Array;
  // dynamic
  plantFood: Float64Array;
  gameDensity: Float64Array;
}

export function tileIndex(w: World, x: number, y: number): number {
  const tx = Math.min(w.width - 1, Math.max(0, Math.floor(x)));
  const ty = Math.min(w.height - 1, Math.max(0, Math.floor(y)));
  return ty * w.width + tx;
}

export function isWater(w: World, x: number, y: number): boolean {
  return w.biome[tileIndex(w, x, y)] === BIOME_WATER;
}

export function isPassableTile(w: World, i: number, impassableCost: number): boolean {
  return w.movementCost[i] < impassableCost;
}

export function generateWorld(cfg: SimConfig, rng: Rng): World {
  const wc = cfg.world;
  const W = wc.width;
  const H = wc.height;
  const n = W * H;
  const elevNoise = new ValueNoise(rng);
  const moistNoise = new ValueNoise(rng);
  const ox = rng.range(0, 1000);
  const oy = rng.range(0, 1000);

  const elevation = new Float64Array(n);
  const moisture = new Float64Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      elevation[i] = elevNoise.fbm(ox + x / wc.elevationScale, oy + y / wc.elevationScale, wc.elevationOctaves);
      moisture[i] = moistNoise.fbm(ox + x / wc.moistureScale, oy + y / wc.moistureScale, wc.moistureOctaves);
    }
  }
  normalize(elevation);
  normalize(moisture);
  if (wc.island) {
    // An island: land sinks into the sea toward the rim (the coast wobbles with the moisture noise).
    const cx = (W - 1) / 2;
    const cy = (H - 1) / 2;
    const R = Math.min(W, H) / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const r = Math.hypot(x - cx, y - cy) / R + (moisture[i] - 0.5) * 0.12;
        const f = Math.min(1, Math.max(0, (r - wc.islandStart) / (0.97 - wc.islandStart)));
        const k = f * f * (3 - 2 * f);
        elevation[i] = elevation[i] * (1 - k) + (wc.lakeLevel - 0.2) * k;
      }
    }
  }

  const biome = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = elevation[i];
    const m = moisture[i];
    if (e < wc.lakeLevel) biome[i] = BIOME_WATER;
    else if (e > wc.hillLevel) biome[i] = BIOME_HILLS;
    else if (m > wc.forestMoisture) biome[i] = BIOME_FOREST;
    else if (m < wc.scrubMoisture) biome[i] = BIOME_SCRUB;
    else biome[i] = BIOME_GRASSLAND;
  }

  const river = new Uint8Array(n);
  carveRivers(W, H, elevation, biome, river, wc.riverCount, wc.riverMinSourceElevation, rng);
  if (wc.barrier.enabled) applyBarrier(W, H, biome, river, elevation, wc.barrier);

  const waterDistance = computeWaterDistance(W, H, biome);
  const waterAccess = new Float64Array(n);
  const movementCost = new Float64Array(n);
  const plantCapacity = new Float64Array(n);
  const regrowthRate = new Float64Array(n);
  const plantFood = new Float64Array(n);
  const gameDensity = new Float64Array(n);
  const gameCapacity = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = wc.biomes[BIOME_NAMES[biome[i]]];
    movementCost[i] = river[i] === 2 ? wc.impassableCost * 2 : river[i] ? wc.riverMovementCost : p.movementCost;
    const barrier = river[i] === 2;
    plantCapacity[i] = barrier ? 0 : p.plantCapacity * cfg.resources.plantUnitsPerCapacity;
    regrowthRate[i] = barrier ? 0 : p.regrowthRate;
    plantFood[i] = plantCapacity[i];
    gameCapacity[i] = barrier ? 0 : p.gameDensity;
    gameDensity[i] = gameCapacity[i];
    const d = waterDistance[i];
    waterAccess[i] = d <= wc.waterAccessRadius ? 1 : Math.max(0, 1 - (d - wc.waterAccessRadius) / wc.waterAccessRadius);
  }

  return {
    width: W,
    height: H,
    biome,
    river,
    elevation,
    moisture,
    movementCost,
    plantCapacity,
    regrowthRate,
    gameCapacity,
    waterDistance,
    waterAccess,
    plantFood,
    gameDensity,
  };
}

function normalize(a: Float64Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < lo) lo = a[i];
    if (a[i] > hi) hi = a[i];
  }
  const span = hi - lo || 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / span;
}

/** Rivers flow downhill from high sources until they hit water or the map edge. */
function carveRivers(
  W: number, H: number, elevation: Float64Array, biome: Uint8Array, river: Uint8Array,
  count: number, minSource: number, rng: Rng,
): void {
  const sources: number[] = [];
  for (let i = 0; i < W * H; i++) if (elevation[i] >= minSource && biome[i] !== BIOME_WATER) sources.push(i);
  if (sources.length === 0) return;
  for (let r = 0; r < count; r++) {
    let i = rng.pick(sources);
    const visited = new Set<number>();
    for (let steps = 0; steps < W * H; steps++) {
      if (biome[i] === BIOME_WATER && steps > 0) break;
      biome[i] = BIOME_WATER;
      river[i] = 1;
      visited.add(i);
      const x = i % W;
      const y = (i / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) break;
      // Steepest descent among 4-neighbors, allowing small uphill moves to escape pits.
      let best = -1;
      let bestE = Infinity;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const j = (y + dy) * W + (x + dx);
        if (visited.has(j)) continue;
        const e = elevation[j] + rng.next() * 0.02;
        if (e < bestE) {
          bestE = e;
          best = j;
        }
      }
      if (best < 0) break;
      i = best;
    }
  }
}

/**
 * Experiment 4 (isolation): an impassable mountain ridge across the map,
 * optionally with passes. Tiles become hills with river marker 2, which the
 * field setup turns into impassable, foodless tiles.
 */
function applyBarrier(
  W: number, H: number, biome: Uint8Array, river: Uint8Array, elevation: Float64Array,
  b: { orientation: string; position: number; width: number; gapCount: number },
): void {
  const vertical = b.orientation === 'vertical';
  const len = vertical ? H : W;
  const center = Math.floor((vertical ? W : H) * b.position);
  const gapEvery = b.gapCount > 0 ? Math.floor(len / (b.gapCount + 1)) : 0;
  for (let t = 0; t < len; t++) {
    if (gapEvery > 0 && t % gapEvery === 0 && t > 0) continue;
    for (let o = -Math.floor(b.width / 2); o <= Math.floor(b.width / 2); o++) {
      const x = vertical ? center + o : t;
      const y = vertical ? t : center + o;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      biome[i] = BIOME_HILLS;
      river[i] = 2; // marker: barrier (impassable)
      elevation[i] = 1;
    }
  }
}

/** Multi-source BFS (Chebyshev) distance to water. */
function computeWaterDistance(W: number, H: number, biome: Uint8Array): Uint8Array {
  const dist = new Uint8Array(W * H).fill(255);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < W * H; i++) {
    if (biome[i] === BIOME_WATER) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % W;
    const y = (i / W) | 0;
    const d = dist[i] + 1;
    if (d >= 255) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (dist[j] > d) {
          dist[j] = d;
          queue[tail++] = j;
        }
      }
    }
  }
  return dist;
}
