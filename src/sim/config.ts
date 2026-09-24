/**
 * Config types. ALL tunable parameters live in configs/*.json; systems read
 * from SimConfig and never hard-code tunables (§17).
 */
import defaultConfigJson from '../../configs/default.json';
import { hashString } from './rng';
import { deepClone } from './util';

export type BiomeName = 'grassland' | 'forest' | 'hills' | 'scrub' | 'water';

export interface BiomeParams {
  movementCost: number;
  plantCapacity: number;
  regrowthRate: number;
  gameDensity: number;
}

export interface SimConfig {
  configVersion: number;
  time: { daysPerYear: number; subStepsPerDay: number };
  world: {
    width: number;
    height: number;
    elevationScale: number;
    elevationOctaves: number;
    moistureScale: number;
    moistureOctaves: number;
    riverCount: number;
    riverMinSourceElevation: number;
    lakeLevel: number;
    hillLevel: number;
    forestMoisture: number;
    scrubMoisture: number;
    biomes: Record<BiomeName, BiomeParams>;
    waterAccessRadius: number;
  };
  init: {
    clanCount: number;
    agentsPerClan: number;
    campMinSeparation: number;
    campMaxWaterDistance: number;
    agePyramidDecay: number;
    maxInitialAge: number;
    startSpreadRadius: number;
  };
  movement: { wanderStepTiles: number; homeRadius: number; homePull: number };
  history: { microBufferSize: number };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export const DEFAULT_CONFIG: SimConfig = defaultConfigJson as SimConfig;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const k of Object.keys(over)) {
    out[k] = isPlainObject(out[k]) ? deepMerge(out[k], over[k]) : over[k];
  }
  return out as T;
}

/** Overrides are merged onto the defaults, so experiment configs can be sparse. */
export function makeConfig(overrides: DeepPartial<SimConfig> | unknown = {}): SimConfig {
  return deepMerge(deepClone(DEFAULT_CONFIG), overrides);
}

/** Stable JSON (sorted keys) so the config hash doesn't depend on key order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isPlainObject(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function configHash(cfg: SimConfig): string {
  return hashString(stableStringify(cfg)).toString(16).padStart(8, '0');
}
