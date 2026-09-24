/** Messages between the UI thread and the sim worker. The UI never touches sim state. */
import type { DeepPartial, SimConfig } from '../sim/config';

export type ToWorker =
  | { type: 'init'; seed: number; config?: DeepPartial<SimConfig> }
  /** Sim days per wall-clock second; 0 = paused, Infinity = as fast as possible. */
  | { type: 'speed'; daysPerSecond: number }
  | { type: 'inspect'; id: number }
  | { type: 'inspectClan'; id: number }
  /** Run (synchronously) to a tick and report the state hash (tests / verification). */
  | { type: 'runTo'; tick: number }
  /** Jump to the yearly snapshot at or before `year` (timeline scrubbing). */
  | { type: 'scrub'; year: number };

export interface WorldMsg {
  type: 'world';
  width: number;
  height: number;
  biome: Uint8Array;
  river: Uint8Array;
  elevation: Float64Array;
  plantCapacity: Float64Array;
  camps: { id: number; label: string; x: number; y: number }[];
  seed: number;
}

/** Per-agent attributes (stride ATTR_STRIDE), in the same order as `ids`. */
export const A_CLAN = 0;
export const A_SEX = 1;
export const A_AGE = 2;
export const A_GOAL = 3;
export const A_ENERGY = 4;
export const A_HEALTH = 5;
export const A_REP = 6;
export const A_MARKER = 7;
export const A_INJURY = 8;
export const A_SKIN = 9;
export const A_HAIR = 10;
export const A_HEIGHT = 11;
export const A_BUILD = 12;
export const A_STATUS = 13;
export const A_LEADER = 14;
/** id of the agent this one moves with (mother for carried infants), or -1. */
export const A_FOLLOW = 15;
export const A_PHASE = 16;
export const A_FEAR = 17;
export const ATTR_STRIDE = 18;

export interface DayEvent {
  type: string;
  agents: number[];
  x?: number;
  y?: number;
  text?: string;
}

export interface ClanView {
  id: number;
  label: string;
  x: number;
  y: number;
  size: number;
  store: number;
  leader: number;
  leaderName: string;
  leaderShare: number;
  parent: number;
  marker: number;
}

/**
 * One simulated day as seen by observers: every living agent's position at
 * each movement sub-step, for interpolation. Layout:
 *   ids[n], attrs[n*ATTR_STRIDE], frames[subSteps * n * 2] = (x, y) per sub-step per agent.
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
  population: number;
  clans: ClanView[];
  climate: { season: number; drought: number; droughtActive: boolean; epidemicActive: boolean; droughtMult: number };
  ticker: string[];
  events: DayEvent[];
  /** Graves added since the previous message: (x, y) pairs. */
  newGraves: Float32Array;
  /** Camp sites abandoned since the previous message (fire rings). */
  oldCamps: { x: number; y: number; clan: number }[];
  /** Mean member affinity between clans, "a>b" -> value (yearly). */
  relations: [string, number][];
  stateHash?: string;
  /** Years for which a snapshot is available (timeline scrubbing). */
  snapshotYears: number[];
  yearly: { year: number; population: number; clans: { id: number; size: number }[]; killings: number; births: number }[];
}

export interface InspectMsg {
  type: 'inspect';
  id: number;
  lines: string[];
  name: string;
  alive: boolean;
  family: { role: string; id: number; name: string; alive: boolean }[];
  relations: { id: number; name: string; label: string; aff: number; def: number; grudge: number; clan: number }[];
  why: { label: string; value: number }[];
  goal: string;
  memories: string[];
}

export interface ClanInspectMsg {
  type: 'clanInspect';
  id: number;
  lines: string[];
  culture: { name: string; value: number }[];
  markers: [number, number][];
  history: string[];
}

export interface HashMsg {
  type: 'hash';
  tick: number;
  hash: string;
}

export type FromWorker = WorldMsg | DayMsg | InspectMsg | ClanInspectMsg | HashMsg;
