/** Messages between the UI thread and the sim worker. The UI never touches sim state. */
import type { DeepPartial, SimConfig } from '../sim/config';
import type { HelpVerb } from '../sim/play/player';
import type { Motive } from '../sim/play/motives';

/** A player action as the UI expresses it; the host resolves proximity and witnesses. */
export type UiAction =
  | { kind: 'gather' }
  | { kind: 'take'; amount: number }
  | { kind: 'help'; verb: HelpVerb; target: number }
  | { kind: 'invite'; target: number }
  | { kind: 'raid'; clan: number }
  | { kind: 'hail'; target: number }
  | { kind: 'hunt'; tile: number; k: number }
  | { kind: 'wood' }
  | { kind: 'deposit' }
  | { kind: 'build' }
  | { kind: 'walk'; target: number }
  | { kind: 'dismiss'; target: number }
  | { kind: 'court'; target: number }
  | { kind: 'propose'; target: number };

export type ToWorker =
  | { type: 'init'; seed: number; config?: DeepPartial<SimConfig> }
  /** Sim days per wall-clock second; 0 = paused, Infinity = as fast as possible. */
  | { type: 'speed'; daysPerSecond: number }
  | { type: 'inspect'; id: number }
  | { type: 'inspectClan'; id: number }
  /** Run (synchronously) to a tick and report the state hash (tests / verification). */
  | { type: 'runTo'; tick: number }
  /** Jump to the yearly snapshot at or before `year` (timeline scrubbing). */
  | { type: 'scrub'; year: number }
  /** Play mode: build a world, let it run `warmupYears`, then put the player in it. */
  | { type: 'play'; seed: number; name: string; female: boolean; warmupYears?: number }
  /** Player position (sent often; client-side movement). */
  | { type: 'pos'; x: number; y: number }
  /** A player action; `subStep` is the frame the player was looking at (for proximity and witnesses). */
  | { type: 'act'; action: UiAction; subStep: number }
  | { type: 'person'; id: number };

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
  /** For movements between places (camp moves, clan changes): where from and to. */
  from?: { x: number; y: number };
  to?: { x: number; y: number };
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
  /** Play mode only. */
  play?: PlayView;
  /** Play mode: primary motive code per agent (aligned with ids) and their affinity toward the player. */
  motives?: Uint8Array;
  friendly?: Float32Array;
  /** Play mode: game density per tile (animals are drawn from it). */
  gameDensity?: Float32Array;
  /** Play mode (streamed): seconds this frame spans, and the day fraction it goes from/to (lighting). */
  frameSeconds?: number;
  dayFraction?: [number, number];
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

export interface PlayView {
  playerId: number;
  name: string;
  clanId: number;
  clanLabel: string;
  x: number;
  y: number;
  campX: number;
  campY: number;
  carried: number;
  carryCapacity: number;
  store: number;
  members: number;
  adults: number;
  rank: number;
  clanCount: number;
  largest: { label: string; size: number };
  suspicion: { clan: number; label: string; value: number }[];
  raids: { clan: number; label: string; size: number; odds: number; ok: boolean; reason: string; x: number; y: number }[];
  raidPlanned: number;
  gathersLeft: number;
  caught: number;
  raidsWon: number;
  raidsLost: number;
  interactRadius: number;
  witnessRadius: number;
  skills: { hunt: number; gather: number; wood: number };
  hunger: number;
  health: number;
  wood: number;
  woodCarry: number;
  campWood: number;
  shelters: number;
  shelterWood: number;
  maxShelters: number;
  huntsLeft: number;
  woodLeft: number;
  hailRadius: number;
  huntRange: number;
  animalTileRate: number;
  night: boolean;
  renown: number;
  female: boolean;
  spouse: string;
  /** People walking with you right now. */
  companions: number[];
  /** Felled trees: [tile, count] (they regrow). */
  felled: [number, number][];
}

export interface LoadingMsg {
  type: 'loading';
  year: number;
  total: number;
  lines: string[];
}

export interface ActResultMsg {
  type: 'actResult';
  ok: boolean;
  text: string;
  seenBy: { clan: number; label: string; amount: number; witnesses: number }[];
}

export interface PlayStateMsg {
  type: 'playState';
  play: PlayView;
}

export interface PersonMsg {
  type: 'person';
  id: number;
  name: string;
  alive: boolean;
  clan: number;
  clanLabel: string;
  age: number;
  female: boolean;
  isLeader: boolean;
  doing: string;
  why: string[];
  motives: Motive[];
  feeling: { text: string; aff: number; def: number; grudge: number };
  help: HelpVerb[];
  invite: { p: number; parts: { label: string; value: number }[] } | null;
  inYourClan: boolean;
  partner: string;
  children: number;
  /** '' = not a match for you, 'yes' = you may court them, 'married' = your spouse. */
  courtable: string;
  courtship: number;
  proposeOdds: number;
  walkOdds: number;
  withYou: boolean;
}

export type FromWorker = WorldMsg | DayMsg | InspectMsg | ClanInspectMsg | HashMsg | LoadingMsg | ActResultMsg | PlayStateMsg | PersonMsg;
