/**
 * Animals (play mode). The sim models game as a density per tile; animals are
 * that density made visible and huntable. Which tiles carry animals, how many
 * and of what kind is a pure function of (tile, biome, current density), so
 * the renderer and the sim always agree, and hunting (which depletes the
 * tile's density) thins or removes exactly the animals the player sees.
 * Dependency-free so the UI can use it too.
 */

export interface AnimalKind {
  name: string;
  icon: string;
  /** Food units a kill yields. */
  food: number;
  /** Hunting skill (0..1) at which the odds are good. */
  req: number;
  /** Chance per attempt of being hurt, for an unskilled hunter. */
  risk: number;
  /** Fraction of the tile's game density a kill removes. */
  depletion: number;
  /** Body scale (render) and body color. */
  size: number;
  color: string;
}

export const ANIMALS: AnimalKind[] = [
  { name: 'hare', icon: '🐇', food: 3, req: 0, risk: 0, depletion: 0.03, size: 0.32, color: '#b9a48a' },
  { name: 'deer', icon: '🦌', food: 9, req: 0.25, risk: 0.03, depletion: 0.08, size: 0.8, color: '#9a6a3f' },
  { name: 'boar', icon: '🐗', food: 13, req: 0.45, risk: 0.2, depletion: 0.1, size: 0.62, color: '#4a3b30' },
  { name: 'aurochs', icon: '🐂', food: 28, req: 0.7, risk: 0.3, depletion: 0.16, size: 1.15, color: '#2f2723' },
];
export const A_HARE = 0;
export const A_DEER = 1;
export const A_BOAR = 2;
export const A_AUROCHS = 3;

/** Relative odds of each kind by biome (grassland, forest, hills, scrub, water). */
const MIX: number[][] = [
  [0.4, 0.3, 0.05, 0.25],
  [0.15, 0.45, 0.4, 0],
  [0.55, 0.45, 0, 0],
  [0.8, 0, 0.2, 0],
  [0, 0, 0, 0],
];

/** Deterministic hash of (tile, salt) to [0, 1). */
export function tileHash(t: number, salt: number): number {
  let h = (t * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The animals on tile t right now (kinds), given its biome and game density.
 * `tileRate` is the share of fully stocked tiles that hold a herd.
 */
export function animalsOnTile(t: number, biome: number, density: number, tileRate: number): number[] {
  if (biome === 4 || density <= 0.02) return [];
  if (tileHash(t, 1) >= density * tileRate) return [];
  const mix = MIX[biome];
  let r = tileHash(t, 2) * (mix[0] + mix[1] + mix[2] + mix[3]);
  let kind = 0;
  while (kind < 3 && r >= mix[kind]) r -= mix[kind++];
  // Herd size: hares and boar come in ones and twos, deer and aurochs in small herds.
  const max = kind === A_DEER || kind === A_AUROCHS ? 3 : 2;
  let n = 1;
  for (let k = 1; k < max; k++) if (tileHash(t, 3 + k) < density * 0.9) n++;
  return new Array<number>(n).fill(kind);
}

/** Chance that a hunter of skill s brings down an animal of this kind. */
export function huntChance(kind: AnimalKind, skill: number): number {
  return 1 / (1 + Math.exp(-((skill - kind.req) * 8 + 0.8)));
}
