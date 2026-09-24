/**
 * Causal event log (§12). Append-only, typed; every event lists the ids of the
 * events that caused it. Macro events are kept forever; micro events live in a
 * rolling buffer, with per-year counts kept as aggregates.
 */

export type EventType =
  | 'sim.start'
  | 'year.end'
  | 'clan.founded'
  | 'clan.dissolved'
  | 'clan.camp_moved'
  | 'agent.born'
  | 'agent.died'
  | 'agent.injured'
  | 'agent.miscarriage'
  | 'agent.stillbirth'
  | 'pair.formed'
  | 'climate.drought_began'
  | 'climate.drought_ended'
  | 'epidemic.outbreak'
  | 'epidemic.ended'
  | 'agent.left_clan'
  | 'agent.joined_clan'
  | 'agent.rejected'
  | 'agent.expelled'
  | 'clan.fission'
  | 'food.freeriding'
  | 'hunt.party_kill';

/** Event types retained permanently. Everything else is micro (rolling buffer + yearly counts). */
export const MACRO_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'sim.start', 'year.end', 'clan.founded', 'clan.dissolved', 'clan.camp_moved', 'agent.born', 'agent.died',
  'pair.formed', 'climate.drought_began', 'climate.drought_ended', 'epidemic.outbreak', 'epidemic.ended',
  'agent.left_clan', 'agent.joined_clan', 'agent.expelled', 'clan.fission',
]);

export interface SimEvent {
  id: number;
  tick: number;
  type: EventType;
  causes: number[];
  /** Location, for later association learning (§10). */
  x?: number;
  y?: number;
  agents?: number[];
  clans?: number[];
  data?: Record<string, unknown>;
}

export type EventInput = Omit<SimEvent, 'id' | 'tick'>;
type Listener = (e: SimEvent) => void;

export class EventLog {
  nextId = 1;
  /** Permanent macro events, by id. */
  macro = new Map<number, SimEvent>();
  /** Rolling micro buffer. */
  private micro: (SimEvent | undefined)[];
  private microHead = 0;
  /** type -> count for the current year; flushed into yearly aggregates. */
  yearCounts = new Map<string, number>();
  yearlyAggregates: { year: number; counts: Record<string, number> }[] = [];
  private listeners: Listener[] = [];

  constructor(microBufferSize: number) {
    this.micro = new Array(microBufferSize);
  }

  /** Observers (JSONL writer, renderer, UI) subscribe here. They must not mutate sim state. */
  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  emit(tick: number, input: EventInput): number {
    const e: SimEvent = { id: this.nextId++, tick, ...input };
    if (MACRO_EVENTS.has(e.type)) {
      this.macro.set(e.id, e);
    } else {
      this.micro[this.microHead] = e;
      this.microHead = (this.microHead + 1) % this.micro.length;
    }
    this.yearCounts.set(e.type, (this.yearCounts.get(e.type) ?? 0) + 1);
    for (const l of this.listeners) l(e);
    return e.id;
  }

  get(id: number): SimEvent | undefined {
    const m = this.macro.get(id);
    if (m) return m;
    for (const e of this.micro) if (e && e.id === id) return e;
    return undefined;
  }

  closeYear(year: number): void {
    const counts: Record<string, number> = {};
    for (const k of [...this.yearCounts.keys()].sort()) counts[k] = this.yearCounts.get(k)!;
    this.yearlyAggregates.push({ year, counts });
    this.yearCounts.clear();
  }

  /** Walks causes backwards (breadth-first) from an event. Full whyQuery lands in M6. */
  causalChain(id: number, maxDepth = 20): SimEvent[] {
    const out: SimEvent[] = [];
    const seen = new Set<number>();
    let frontier = [id];
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next: number[] = [];
      for (const fid of frontier) {
        if (seen.has(fid)) continue;
        seen.add(fid);
        const e = this.get(fid);
        if (!e) continue;
        out.push(e);
        next.push(...e.causes);
      }
      frontier = next;
    }
    return out;
  }
}
