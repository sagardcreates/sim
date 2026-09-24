/** Messages between the UI thread and the sim worker. */
import type { DeepPartial, SimConfig } from '../sim/config';

export type ToWorker =
  | { type: 'init'; seed: number; config?: DeepPartial<SimConfig> }
  /** Sim days per wall-clock second; 0 = paused, Infinity = as fast as possible. */
  | { type: 'speed'; daysPerSecond: number };

export interface WorldMsg {
  type: 'world';
  width: number;
  height: number;
  biome: Uint8Array;
  elevation: Float64Array;
  camps: { id: number; label: string; x: number; y: number }[];
}

/**
 * One simulated day as seen by observers: every living agent's position at
 * each movement sub-step, for interpolation. Layout:
 *   ids[n], attrs[n*ATTR_STRIDE] = (clanId, sex, ageYears),
 *   frames[subSteps * n * 2] = (x, y) per sub-step per agent.
 */
export interface DayMsg {
  type: 'day';
  tick: number;
  year: number;
  dayOfYear: number;
  subSteps: number;
  ids: Int32Array;
  attrs: Float32Array;
  frames: Float32Array;
  names: string[];
  stateHash?: string;
}

export const ATTR_STRIDE = 3;
export type FromWorker = WorldMsg | DayMsg;
