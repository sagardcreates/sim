/**
 * Simulation root. Pure and deterministic: identical (seed, config, code) =>
 * identical history. Observers (renderer, CLI writers) attach via
 * `events.subscribe` and `onSubStep`, and must never write to sim state.
 */
import { configHash, makeConfig, stableStringify, type SimConfig } from './config';
import { StateHasher } from './hash';
import { EventLog } from './history/events';
import type { SyllableSet } from './names';
import { RngStreams, type RngState } from './rng';
import { AGENT_FIELDS, AgentStore } from './state/agents';
import { ClanRegistry, type Clan } from './state/clans';
import { populate } from './systems/init';
import { movementSubStep } from './systems/movement';
import { generateWorld, type World } from './world/terrain';
import { deepClone } from './util';

/** Bump whenever a change alters simulation output. Part of the run identity. */
export const CODE_VERSION = 'm0.1';

export class Simulation {
  tick = 0;
  readonly rng: RngStreams;
  world: World;
  agents = new AgentStore();
  clans = new ClanRegistry();
  events: EventLog;
  syllables = new Map<number, SyllableSet>();
  /** Read-only hook fired after every movement sub-step (render interpolation). */
  onSubStep?: (sim: Simulation, subStep: number) => void;
  /** Reusable processing-order buffer. */
  private order: number[] = [];

  private constructor(readonly seed: number, readonly cfg: SimConfig) {
    this.rng = new RngStreams(seed);
    // Terrain uses its own stream so it's identical for any population/behavior config.
    this.world = generateWorld(cfg, this.rng.get('terrain'));
    this.events = new EventLog(cfg.history.microBufferSize);
  }

  static create(seed: number, cfg: SimConfig = makeConfig()): Simulation {
    const sim = new Simulation(seed, cfg);
    const start = sim.events.emit(0, {
      type: 'sim.start', causes: [],
      data: { seed, codeVersion: CODE_VERSION, configHash: configHash(cfg) },
    });
    populate(sim.world, cfg, sim.rng.get('init'), sim.agents, sim.clans, sim.events, sim.syllables, start);
    return sim;
  }

  get year(): number {
    return Math.floor(this.tick / this.cfg.time.daysPerYear);
  }

  get dayOfYear(): number {
    return this.tick % this.cfg.time.daysPerYear;
  }

  /** Advance one day, running systems in §5 order. Systems not yet built are listed as stubs. */
  step(): void {
    // Climate, Resources, Metabolism, Perception, Decision: M1+.
    const orderRng = this.rng.get('order');
    const moveRng = this.rng.get('movement');
    for (let s = 0; s < this.cfg.time.subStepsPerDay; s++) {
      this.order.length = 0;
      for (const id of this.agents.living) this.order.push(id);
      orderRng.shuffle(this.order);
      movementSubStep(this.order, this.agents, this.clans, this.world, this.cfg, moveRng);
      // Encounters, Interaction resolution: M2+.
      this.onSubStep?.(this, s);
    }
    // Reproduction, Mortality, Social, Culture, Clan, Leadership, Historian: M1+.
    this.tick++;
    if (this.dayOfYear === 0) {
      const year = this.year - 1;
      this.events.emit(this.tick, { type: 'year.end', causes: [], data: { year, population: this.agents.living.length } });
      this.events.closeYear(year);
    }
  }

  run(days: number): void {
    for (let d = 0; d < days; d++) this.step();
  }

  /** Hash of the full dynamic state. Equal hashes => equal simulations. */
  stateHash(): string {
    const h = new StateHasher();
    h.number(this.tick).number(this.agents.count).string(CODE_VERSION);
    const cols = this.agents.cols as unknown as Record<string, Float64Array | Int32Array | Uint8Array>;
    for (const f of AGENT_FIELDS) h.string(f).typed(cols[f], this.agents.count);
    h.string(this.agents.names.join('|'));
    h.typed(Int32Array.from(this.agents.living));
    h.string(stableStringify([...this.clans.clans.values()]));
    h.typed(this.world.plantFood).typed(this.world.gameDensity);
    h.string(stableStringify(this.rng.getState()));
    h.number(this.events.nextId);
    return h.digest();
  }

  /** Full-state snapshot (JSON-safe). Static terrain is regenerated from seed+config on restore. */
  snapshot(): SimSnapshot {
    const cols = this.agents.cols as unknown as Record<string, Float64Array | Int32Array | Uint8Array>;
    const agentCols: Record<string, number[]> = {};
    for (const f of AGENT_FIELDS) agentCols[f] = Array.from(cols[f].subarray(0, this.agents.count));
    return {
      codeVersion: CODE_VERSION,
      seed: this.seed,
      config: this.cfg,
      tick: this.tick,
      agents: { count: this.agents.count, names: [...this.agents.names], living: [...this.agents.living], cols: agentCols },
      clans: { nextId: this.clans.nextId, list: [...this.clans.clans.values()].map((c) => deepClone(c)) },
      syllables: [...this.syllables.entries()].map(([id, s]) => [id, [...s.syllables]]),
      world: { plantFood: Array.from(this.world.plantFood), gameDensity: Array.from(this.world.gameDensity) },
      rng: this.rng.getState(),
      events: {
        nextId: this.events.nextId,
        macro: [...this.events.macro.values()],
        yearCounts: Object.fromEntries(this.events.yearCounts),
        yearlyAggregates: this.events.yearlyAggregates,
      },
    };
  }

  static fromSnapshot(snap: SimSnapshot): Simulation {
    if (snap.codeVersion !== CODE_VERSION) {
      throw new Error(`Snapshot code version ${snap.codeVersion} != ${CODE_VERSION}`);
    }
    const sim = new Simulation(snap.seed, snap.config);
    sim.tick = snap.tick;
    const a = sim.agents;
    a.ensureCapacity(snap.agents.count);
    a.count = snap.agents.count;
    a.names = [...snap.agents.names];
    a.living = [...snap.agents.living];
    const cols = a.cols as unknown as Record<string, Float64Array | Int32Array | Uint8Array>;
    for (const f of AGENT_FIELDS) {
      cols[f].fill(0);
      cols[f].set(snap.agents.cols[f]);
    }
    sim.clans.nextId = snap.clans.nextId;
    for (const c of snap.clans.list) sim.clans.clans.set(c.id, deepClone(c));
    for (const [id, syl] of snap.syllables) sim.syllables.set(id, { syllables: [...syl] });
    sim.world.plantFood.set(snap.world.plantFood);
    sim.world.gameDensity.set(snap.world.gameDensity);
    sim.rng.setState(snap.rng);
    sim.events.nextId = snap.events.nextId;
    for (const e of snap.events.macro) sim.events.macro.set(e.id, e);
    for (const [k, v] of Object.entries(snap.events.yearCounts)) sim.events.yearCounts.set(k, v);
    sim.events.yearlyAggregates = deepClone(snap.events.yearlyAggregates);
    return sim;
  }
}

export interface SimSnapshot {
  codeVersion: string;
  seed: number;
  config: SimConfig;
  tick: number;
  agents: { count: number; names: string[]; living: number[]; cols: Record<string, number[]> };
  clans: { nextId: number; list: Clan[] };
  syllables: [number, string[]][];
  world: { plantFood: number[]; gameDensity: number[] };
  rng: Record<string, RngState>;
  events: {
    nextId: number;
    macro: import('./history/events').SimEvent[];
    yearCounts: Record<string, number>;
    yearlyAggregates: { year: number; counts: Record<string, number> }[];
  };
}
