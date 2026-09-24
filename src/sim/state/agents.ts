/**
 * Struct-of-arrays agent store. Agent ids are indices into these columns and
 * are NEVER reused: the store holds everyone who ever lived (full pedigree, §12).
 * `living` is the id list of currently-alive agents, kept in ascending id order
 * (systems shuffle a copy when order matters, §0.5).
 */

export const SEX_FEMALE = 0;
export const SEX_MALE = 1;

export const REP_NONE = 0; // male, or female outside fertile window
export const REP_CYCLING = 1;
export const REP_PREGNANT = 2;
export const REP_LACTATING = 3;

export const NO_ID = -1;

type ColumnKind = 'f64' | 'i32' | 'u8';

/** Column schema. Add a field here and it is automatically grown, hashed and snapshotted. */
export const AGENT_SCHEMA = {
  // identity
  sex: 'u8',
  alive: 'u8',
  birthTick: 'i32',
  deathTick: 'i32',
  motherId: 'i32',
  fatherId: 'i32',
  clanId: 'i32',
  // position (tile units, continuous)
  x: 'f64',
  y: 'f64',
  // body
  energy: 'f64',
  health: 'f64',
  injury: 'f64',
  carriedFood: 'f64',
  repState: 'u8',
  repUntilTick: 'i32',
  // genome (heritable, 0..1). Phenotype columns hold gene + developmental noise.
  gBuild: 'f64',
  gRobustness: 'f64',
  gFertility: 'f64',
  gBoldness: 'f64',
  gSociability: 'f64',
  gTemper: 'f64',
  // cosmetic genes: ZERO behavioral effect (renderer only)
  gSkin: 'f64',
  gHeight: 'f64',
  gHair: 'f64',
  // skill
  foragingSkill: 'f64',
  // goal
  goal: 'u8',
  goalUntilTick: 'i32',
} as const satisfies Record<string, ColumnKind>;

export type AgentField = keyof typeof AGENT_SCHEMA;
export const AGENT_FIELDS = Object.keys(AGENT_SCHEMA).sort() as AgentField[];

type ArrayFor<K extends ColumnKind> = K extends 'f64' ? Float64Array : K extends 'i32' ? Int32Array : Uint8Array;
type Columns = { [F in AgentField]: ArrayFor<(typeof AGENT_SCHEMA)[F]> };

function alloc(kind: ColumnKind, n: number): Float64Array | Int32Array | Uint8Array {
  if (kind === 'f64') return new Float64Array(n);
  if (kind === 'i32') return new Int32Array(n);
  return new Uint8Array(n);
}

export class AgentStore {
  /** Number of agents ever created (next id). */
  count = 0;
  capacity: number;
  /** Names are strings, so they live outside the typed columns. */
  names: string[] = [];
  /** Ascending ids of living agents. */
  living: number[] = [];
  cols: Columns;

  constructor(initialCapacity = 1024) {
    this.capacity = initialCapacity;
    const cols: Record<string, Float64Array | Int32Array | Uint8Array> = {};
    for (const f of AGENT_FIELDS) cols[f] = alloc(AGENT_SCHEMA[f], initialCapacity);
    this.cols = cols as Columns;
  }

  ensureCapacity(n: number): void {
    while (this.capacity < n) this.grow();
  }

  private grow(): void {
    const next = this.capacity * 2;
    const cols = this.cols as unknown as Record<string, Float64Array | Int32Array | Uint8Array>;
    for (const f of AGENT_FIELDS) {
      const arr = alloc(AGENT_SCHEMA[f], next);
      arr.set(cols[f]);
      cols[f] = arr;
    }
    this.capacity = next;
  }

  /** Allocates a new agent id with all columns zeroed and ids set to NO_ID. Caller fills fields. */
  create(name: string): number {
    if (this.count >= this.capacity) this.grow();
    const id = this.count++;
    const c = this.cols;
    c.motherId[id] = NO_ID;
    c.fatherId[id] = NO_ID;
    c.clanId[id] = NO_ID;
    c.deathTick[id] = NO_ID;
    c.alive[id] = 1;
    this.names[id] = name;
    this.living.push(id); // ids are monotonic, so push keeps ascending order
    return id;
  }

  kill(id: number, tick: number): void {
    this.cols.alive[id] = 0;
    this.cols.deathTick[id] = tick;
    const i = this.living.indexOf(id);
    if (i >= 0) this.living.splice(i, 1);
  }

  /** Age in whole days. */
  ageDays(id: number, tick: number): number {
    return tick - this.cols.birthTick[id];
  }
}
