/**
 * Simulation root. Pure and deterministic: identical (seed, config, code) =>
 * identical history. Observers (renderer, CLI writers) attach via
 * `events.subscribe` and `onSubStep`, and must never write to sim state.
 */
import { configHash, makeConfig, stableStringify, type SimConfig } from './config';
import { StateHasher } from './hash';
import { EventLog, type SimEvent } from './history/events';
import { Stats, type DayCounters, type YearStats } from './history/stats';
import type { SyllableSet } from './names';
import { RngStreams, type Rng, type RngState } from './rng';
import { AGENT_FIELDS, AgentStore, NO_ID } from './state/agents';
import { ClanRegistry, type Clan } from './state/clans';
import { MindStore, type MindSnapshot } from './state/mind';
import { KinIndex, Pedigree } from './state/pedigree';
import { RelationStore, type RelationSnapshot } from './state/relations';
import { clanMembershipSystem, yearlyClanSystem } from './systems/clans';
import { fieldEncounters, nightSocialSystem } from './systems/social';
import { challengeSystem, deferenceDriftSystem, leadershipSystem } from './systems/leadership';
import { cultureDivergence, cultureSystem } from './systems/culture';
import { homeTile } from './systems/common';
import { campSystem } from './systems/camps';
import { climateSystem, initialClimate, type ClimateState } from './systems/climate';
import { decisionSystem } from './systems/decision';
import { populate } from './systems/init';
import { metabolismSystem } from './systems/metabolism';
import { epidemicSystem, mortalitySystem } from './systems/mortality';
import { drinkAtNight, movementSubStep } from './systems/movement';
import { provisionSystem } from './systems/provision';
import { reproductionSystem } from './systems/reproduction';
import { resourcesSystem } from './systems/resources';
import { deepClone } from './util';
import { FlowFields } from './world/flowfield';
import { SpatialHash } from './world/spatial';
import { generateWorld, type World } from './world/terrain';

/** Bump whenever a change alters simulation output. Part of the run identity. */
export const CODE_VERSION = 'm4.1';

export interface Grave {
  id: number;
  x: number;
  y: number;
  tick: number;
}

export class Simulation {
  tick = 0;
  readonly rng: RngStreams;
  world: World;
  agents = new AgentStore();
  mind: MindStore;
  /** Relationship maps (per living agent). */
  rel: RelationStore;
  pedigree: Pedigree;
  /** Known kin (derived from the pedigree). */
  kin: KinIndex;
  clans = new ClanRegistry();
  events: EventLog;
  stats = new Stats();
  climate: ClimateState = initialClimate();
  syllables = new Map<number, SyllableSet>();
  graves: Grave[] = [];
  // --- caches / derived (not state; rebuilt deterministically) ---
  fields: FlowFields;
  spatial: SpatialHash;
  /** clanId -> living member ids (ascending), rebuilt each day. */
  clanMembers = new Map<number, number[]>();
  /** Today's hunting parties: leader -> joined members (derived daily). */
  parties = new Map<number, number[]>();
  /** Derived daily: incoming deference per agent (all) and from clanmates. */
  status: Float64Array = new Float64Array(0);
  clanDeference: Float64Array = new Float64Array(0);
  clanDefTotal = new Map<number, number>();
  /** Derived leader per clan (rebuilt from clan histories on restore). */
  leaders = new Map<number, number>();
  /** Last challenge event per clan (cause for leader changes); derived bookkeeping. */
  lastChallenge = new Map<number, number>();
  /** Death event id per agent who held deference (cause for leader changes). */
  deathEvent = new Map<number, number>();
  /** Separate spatial index for conflicts (may run inside encounter queries). */
  spatialConflict: SpatialHash;
  /** Yearly derived clan-to-clan relation (mean member affinity), for historian/visuals. */
  clanRelations = new Map<string, number>();
  /** Read-only hook fired after every movement sub-step (render interpolation). */
  onSubStep?: (sim: Simulation, subStep: number) => void;

  private constructor(readonly seed: number, readonly cfg: SimConfig) {
    this.rng = new RngStreams(seed);
    // Terrain uses its own stream so it's identical for any population/behavior config.
    this.world = generateWorld(cfg, this.rng.get('terrain'));
    this.events = new EventLog(cfg.history.microBufferSize);
    // Tag events with the body-paint markers of those involved (§10, for V1.5).
    this.events.annotate = (e) => {
      if (!e.agents || e.agents.length === 0) return;
      const c = this.agents.cols;
      e.markers = [...new Set(e.agents.filter((a) => a >= 0 && a < this.agents.count).map((a) => c.cMarker[a]))];
    };
    this.mind = new MindStore(cfg.memory.placeCap, cfg.movement.maxPathLength);
    this.rel = new RelationStore(cfg.relations.cap, cfg.relations.decay);
    this.pedigree = new Pedigree(this.agents);
    this.kin = new KinIndex(this.agents, this.pedigree);
    this.fields = new FlowFields(this.world, cfg.world.impassableCost, cfg.movement.fieldRadiusCost, cfg.movement.fieldCacheSize);
    this.spatial = new SpatialHash(this.world.width, this.world.height, 4);
    this.spatialConflict = new SpatialHash(this.world.width, this.world.height, 4);
  }

  static create(seed: number, cfg: SimConfig = makeConfig()): Simulation {
    const sim = new Simulation(seed, cfg);
    const start = sim.events.emit(0, {
      type: 'sim.start', causes: [],
      data: { seed, codeVersion: CODE_VERSION, configHash: configHash(cfg) },
    });
    populate(sim, start);
    sim.kin.rebuildAll();
    sim.rebuildDerived();
    return sim;
  }

  get year(): number {
    return Math.floor(this.tick / this.cfg.time.daysPerYear);
  }

  get dayOfYear(): number {
    return this.tick % this.cfg.time.daysPerYear;
  }

  /** Called for every new agent (founders and births). */
  onCreated(id: number): void {
    const slot = this.mind.alloc();
    this.agents.cols.slot[id] = slot;
    this.rel.clearSlot(slot);
  }

  /** Called after an agent is marked dead. */
  onDied(id: number): void {
    const c = this.agents.cols;
    this.mind.release(c.slot[id]);
    c.slot[id] = NO_ID;
  }

  /** Shuffled copy of the living ids (§0.5: processing order shuffled every tick). */
  shuffledLiving(rng: Rng): number[] {
    return rng.shuffle([...this.agents.living]) as number[];
  }

  /** Relatedness as agents know it (kin up to first cousins; 0 otherwise). */
  relatedness(a: number, b: number): number {
    return this.kin.r(a, b);
  }

  /** Status = share of the clan's deference this agent receives (derived daily). */
  statusOf(id: number): number {
    const c = this.agents.cols;
    const total = this.clanDefTotal.get(c.clanId[id]) ?? 0;
    return total > 0 && id < this.clanDeference.length ? this.clanDeference[id] / total : 0;
  }

  /** Weight of an agent's voice in collective choices: 1 + influenceWeight x status share. */
  influence(id: number): number {
    return 1 + this.cfg.leadership.influenceWeight * this.statusOf(id);
  }

  /** How much agent i defers to clan k's (derived) leader. */
  deferenceToLeadership(i: number, k: number): number {
    const L = this.leaders.get(k);
    if (L === undefined || L === i) return 0;
    return this.rel.get(this.agents.cols.slot[i], L, this.tick)?.def ?? 0;
  }

  /** How highly y regards x: deference if any (M3), else affinity. */
  regard(y: number, x: number): number {
    const v = this.rel.get(this.agents.cols.slot[y], x, this.tick);
    if (!v) return 0;
    return v.def > 0 ? v.def : v.aff;
  }

  /** Top-n members of a clan by status; before deference exists, eldest adults stand in. */
  topStatus(clanId: number, n: number): number[] {
    const c = this.agents.cols;
    const members = (this.clanMembers.get(clanId) ?? []).filter((id) => this.tick - c.birthTick[id] >= this.cfg.life.adultAgeYears * this.cfg.time.daysPerYear);
    return members
      .map((id) => ({ id, s: this.statusOf(id), age: this.tick - c.birthTick[id] }))
      .sort((a, b) => b.s - a.s || b.age - a.age || a.id - b.id)
      .slice(0, n)
      .map((x) => x.id);
  }

  /** Upper bound on any of `id`'s grudges (stored values only grow stale downward). */
  maxStoredGrudge(id: number): number {
    const rel = this.rel;
    const slot = this.agents.cols.slot[id];
    const base = slot * rel.cap;
    const end = base + rel.count[slot];
    let m = 0;
    for (let e = base; e < end; e++) if (rel.grudge[e] > m) m = rel.grudge[e];
    return m;
  }

  homeTileOf(id: number): number {
    return homeTile(this, id);
  }

  rebuildDerived(): void {
    this.clanMembers.clear();
    const c = this.agents.cols;
    for (const id of this.agents.living) {
      const k = c.clanId[id];
      let arr = this.clanMembers.get(k);
      if (!arr) this.clanMembers.set(k, (arr = []));
      arr.push(id);
    }
  }

  /** Advance one day, running systems in §5 order. */
  step(): void {
    this.rebuildDerived();
    climateSystem(this);
    resourcesSystem(this);
    metabolismSystem(this);
    // Perception happens where agents work (movement sub-steps) and from memory.
    this.rebuildDerived();
    if (this.tick % this.cfg.leadership.derivePeriodDays === 0) leadershipSystem(this);
    decisionSystem(this);
    const orderRng = this.rng.get('order');
    const moveRng = this.rng.get('movement');
    for (let s = 0; s < this.cfg.time.subStepsPerDay; s++) {
      const order = this.shuffledLiving(orderRng);
      movementSubStep(this, order, s, moveRng);
      fieldEncounters(this, this.rng.get('encounters'));
      this.onSubStep?.(this, s);
    }
    drinkAtNight(this);
    provisionSystem(this);
    nightSocialSystem(this);
    reproductionSystem(this);
    epidemicSystem(this);
    this.rebuildDerived();
    mortalitySystem(this);
    this.rebuildDerived();
    campSystem(this);
    clanMembershipSystem(this);
    deferenceDriftSystem(this);
    challengeSystem(this);
    cultureSystem(this);
    this.checkDissolution();
    this.tick++;
    if (this.dayOfYear === 0) {
      this.rebuildDerived();
      yearlyClanSystem(this);
      this.rebuildDerived();
      this.checkDissolution();
      this.computeClanRelations();
      this.closeYear();
    }
  }

  /** Mean member-to-member affinity between clans (derived yearly; cached for historian/visuals). */
  private computeClanRelations(): void {
    this.clanRelations.clear();
    const c = this.agents.cols;
    const sums = new Map<string, [number, number]>();
    for (const id of this.agents.living) {
      const a = c.clanId[id];
      if (a < 0) continue;
      const w = this.influence(id);
      this.rel.forEach(c.slot[id], this.tick, (o, v) => {
        if (!c.alive[o]) return;
        const b = c.clanId[o];
        if (b < 0 || b === a) return;
        const key = `${a}>${b}`;
        const e = sums.get(key) ?? [0, 0];
        e[0] += w * v.aff;
        e[1] += w;
        sums.set(key, e);
      });
    }
    for (const [k, [s, n]] of [...sums.entries()].sort()) this.clanRelations.set(k, s / n);
  }

  private checkDissolution(): void {
    for (const clan of this.clans.extant()) {
      if ((this.clanMembers.get(clan.id)?.length ?? 0) > 0) continue;
      clan.dissolvedTick = this.tick;
      const ev = this.events.emit(this.tick, { type: 'clan.dissolved', causes: [], clans: [clan.id], x: clan.campX, y: clan.campY, data: { name: clan.name } });
      clan.history.push(ev);
    }
  }

  private closeYear(): void {
    const year = this.year - 1;
    const c = this.agents.cols;
    let e = 0;
    for (const id of this.agents.living) e += c.energy[id];
    this.stats.closeYear({
      year,
      population: this.agents.living.length,
      meanEnergy: this.agents.living.length ? Math.round((e / this.agents.living.length) * 1000) / 1000 : 0,
      drought: Math.round(this.climate.drought * 1000) / 1000,
      clans: this.clans.extant().map((cl) => ({ id: cl.id, size: this.clanMembers.get(cl.id)?.length ?? 0 })),
      loners: this.clanMembers.get(-1)?.length ?? 0,
      leaders: this.leaders.size,
      ...(() => {
        const dv = cultureDivergence(this);
        return { cultureFst: Math.round(dv.functional * 10000) / 10000, markerDivergence: Math.round(dv.marker * 10000) / 10000 };
      })(),
    });
    this.events.emit(this.tick, { type: 'year.end', causes: [], data: { year, population: this.agents.living.length } });
    this.events.closeYear(year);
  }

  /** Extra per-run metrics used by acceptance reports (grows with milestones). */
  acceptanceMetrics(): Record<string, number> {
    const tenures = this.leaderTenures();
    const years = tenures.map((t) => t.years).sort((a, b) => a - b);
    const mean = years.length ? years.reduce((a, b) => a + b, 0) / years.length : 0;
    const sd = years.length ? Math.sqrt(years.reduce((a, b) => a + (b - mean) ** 2, 0) / years.length) : 0;
    return {
      tenures: years.length,
      tenureMean: mean,
      tenureMedian: years.length ? years[Math.floor(years.length / 2)] : 0,
      tenureMax: years.length ? years[years.length - 1] : 0,
      tenureCV: mean > 0 ? sd / mean : 0,
      leaderYearsShare: this.stats.years.length
        ? this.stats.years.reduce((a, y) => a + y.leaders / Math.max(1, y.clans.filter((c) => c.size > 0).length), 0) / this.stats.years.length : 0,
      cultureFstStart: this.stats.years[0]?.cultureFst ?? 0,
      cultureFstEnd: this.stats.years[this.stats.years.length - 1]?.cultureFst ?? 0,
      markerDivStart: this.stats.years[0]?.markerDivergence ?? 0,
      markerDivEnd: this.stats.years[this.stats.years.length - 1]?.markerDivergence ?? 0,
      cultureFstMean: this.stats.years.length ? this.stats.years.reduce((a, y) => a + y.cultureFst, 0) / this.stats.years.length : 0,
      markerDivMean: this.stats.years.length ? this.stats.years.reduce((a, y) => a + y.markerDivergence, 0) / this.stats.years.length : 0,
      threats: this.stats.years.reduce((a, y) => a + y.threats, 0),
      attacks: this.stats.years.reduce((a, y) => a + y.attacks, 0),
      killings: this.stats.years.reduce((a, y) => a + y.killings, 0),
    };
  }

  /** Leader tenures (years) from leader.changed records; tenures still running at the end are included. */
  leaderTenures(): { clan: number; leader: number; start: number; end: number; years: number }[] {
    const out: { clan: number; leader: number; start: number; end: number; years: number }[] = [];
    const dpy = this.cfg.time.daysPerYear;
    for (const clan of this.clans.clans.values()) {
      let cur = -1;
      let since = 0;
      const close = (end: number) => {
        if (cur >= 0) out.push({ clan: clan.id, leader: cur, start: since, end, years: (end - since) / dpy });
      };
      for (const id of clan.history) {
        const e = this.events.macro.get(id);
        if (e?.type !== 'leader.changed') continue;
        close(e.tick);
        cur = (e.data as { leader: number }).leader;
        since = e.tick;
      }
      close(clan.dissolvedTick >= 0 ? clan.dissolvedTick : this.tick);
    }
    return out;
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
    for (const a of this.mind.hashArrays()) h.typed(a);
    for (const a of this.rel.hashArrays(this.mind.highWater)) h.typed(a);
    h.string(stableStringify([...this.clans.clans.values()]));
    h.typed(this.world.plantFood).typed(this.world.gameDensity);
    h.string(stableStringify(this.climate));
    // Exactly one status entry per agent (arrays may be over-allocated differently after a restore).
    const st = new Float64Array(this.agents.count);
    st.set(this.status.subarray(0, Math.min(this.status.length, this.agents.count)));
    h.typed(st);
    h.string(stableStringify(this.graves));
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
      mind: this.mind.snapshot(),
      rel: this.rel.snapshot(this.mind.highWater),
      clans: { nextId: this.clans.nextId, list: [...this.clans.clans.values()].map((c) => deepClone(c)) },
      syllables: [...this.syllables.entries()].map(([id, s]) => [id, [...s.syllables]]),
      world: { plantFood: Array.from(this.world.plantFood), gameDensity: Array.from(this.world.gameDensity) },
      climate: deepClone(this.climate),
      graves: deepClone(this.graves),
      rng: this.rng.getState(),
      stats: { day: deepClone(this.stats.day), years: deepClone(this.stats.years) },
      statusCache: {
        status: Array.from(this.status.subarray(0, this.agents.count)),
        clanDeference: Array.from(this.clanDeference.subarray(0, this.agents.count)),
        clanDefTotal: [...this.clanDefTotal.entries()],
      },
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
    sim.mind.restore(snap.mind);
    sim.rel.restore(snap.rel, snap.mind.highWater);
    sim.pedigree.rebuild();
    sim.kin.rebuildAll();
    sim.clans.nextId = snap.clans.nextId;
    for (const c of snap.clans.list) sim.clans.clans.set(c.id, deepClone(c));
    for (const [id, syl] of snap.syllables) sim.syllables.set(id, { syllables: [...syl] });
    sim.world.plantFood.set(snap.world.plantFood);
    sim.world.gameDensity.set(snap.world.gameDensity);
    sim.climate = deepClone(snap.climate);
    sim.graves = deepClone(snap.graves);
    sim.rng.setState(snap.rng);
    sim.stats.day = deepClone(snap.stats.day);
    sim.stats.years = deepClone(snap.stats.years);
    sim.events.nextId = snap.events.nextId;
    for (const e of snap.events.macro) sim.events.macro.set(e.id, e);
    for (const [k, v] of Object.entries(snap.events.yearCounts)) sim.events.yearCounts.set(k, v);
    sim.events.yearlyAggregates = deepClone(snap.events.yearlyAggregates);
    sim.rebuildDerived();
    // Derived leaders: the last leader.changed record in each clan's history.
    for (const clan of sim.clans.clans.values()) {
      for (let k = clan.history.length - 1; k >= 0; k--) {
        const e = sim.events.macro.get(clan.history[k]);
        if (e?.type !== 'leader.changed') continue;
        const L = (e.data as { leader: number }).leader;
        if (L >= 0) sim.leaders.set(clan.id, L);
        break;
      }
    }
    for (const e of sim.events.macro.values()) {
      if (e.type === 'leader.challenged') sim.lastChallenge.set(e.clans![0], e.id);
      if (e.type === 'agent.died') sim.deathEvent.set(e.agents![0], e.id);
    }
    // Status is derived periodically (not every day), so its cached values are part of the snapshot.
    sim.status = Float64Array.from(snap.statusCache.status);
    sim.clanDeference = Float64Array.from(snap.statusCache.clanDeference);
    for (const [k, v] of snap.statusCache.clanDefTotal) sim.clanDefTotal.set(k, v);
    return sim;
  }
}

export interface SimSnapshot {
  codeVersion: string;
  seed: number;
  config: SimConfig;
  tick: number;
  agents: { count: number; names: string[]; living: number[]; cols: Record<string, number[]> };
  mind: MindSnapshot;
  rel: RelationSnapshot;
  clans: { nextId: number; list: Clan[] };
  syllables: [number, string[]][];
  world: { plantFood: number[]; gameDensity: number[] };
  climate: ClimateState;
  graves: Grave[];
  rng: Record<string, RngState>;
  stats: { day: DayCounters; years: YearStats[] };
  statusCache: { status: number[]; clanDeference: number[]; clanDefTotal: [number, number][] };
  events: {
    nextId: number;
    macro: SimEvent[];
    yearCounts: Record<string, number>;
    yearlyAggregates: { year: number; counts: Record<string, number> }[];
  };
}
