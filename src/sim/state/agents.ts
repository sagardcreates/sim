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
  deathCause: 'u8',
  killerId: 'i32',
  motherId: 'i32',
  fatherId: 'i32',
  /** Social father at birth (mother's partner); used for co-rearing (Westermarck). */
  rearerId: 'i32',
  clanId: 'i32',
  birthClanId: 'i32',
  /** Home site for loners (clan members use their camp). */
  ownHomeX: 'f64',
  ownHomeY: 'f64',
  // position (tile units, continuous)
  x: 'f64',
  y: 'f64',
  // body
  energy: 'f64',
  health: 'f64',
  /** Permanent ceiling on health (lowered by childhood famine). */
  healthCap: 'f64',
  injury: 'f64',
  /** Slow body condition: EMA of energy (drives fecundity, like energy balance in real women). */
  condition: 'f64',
  carriedFood: 'f64',
  repState: 'u8',
  repUntilTick: 'i32',
  pregnancyFatherId: 'i32',
  partnerId: 'i32',
  infectedUntil: 'i32',
  immuneUntil: 'i32',
  lastWaterTick: 'i32',
  // genome (heritable, 0..1)
  gBuild: 'f64',
  gRobustness: 'f64',
  gFertility: 'f64',
  gBoldness: 'f64',
  gSociability: 'f64',
  gTemper: 'f64',
  // phenotype = gene + developmental noise (behavior reads these)
  build: 'f64',
  robustness: 'f64',
  fertility: 'f64',
  boldness: 'f64',
  sociability: 'f64',
  temper: 'f64',
  // cosmetic genes: ZERO behavioral effect (renderer only)
  gSkin: 'f64',
  gHeight: 'f64',
  gHair: 'f64',
  // skill + experience (the "memory" behind expectedSuccess)
  foragingSkill: 'f64',
  forageYieldEma: 'f64',
  huntSuccessEma: 'f64',
  recentYield: 'f64',
  // culture (learned; transmission arrives in M4)
  cSharing: 'f64',
  cViolence: 'f64',
  cLegStrength: 'f64',
  cLegGenerosity: 'f64',
  cLegLineage: 'f64',
  cLegAge: 'f64',
  cResidence: 'u8',
  cRevenge: 'u8',
  cOutgroupTrust: 'f64',
  cKinWeight: 'f64',
  cAncestorNaming: 'f64',
  cMarker: 'i32',
  // moods (fast decay)
  fear: 'f64',
  anger: 'f64',
  angerTarget: 'i32',
  grief: 'f64',
  // goal / daily plan
  goal: 'u8',
  goalUntilTick: 'i32',
  phase: 'u8',
  targetTile: 'i32',
  followId: 'i32',
  moveBudget: 'f64',
  /** Food acquired today (for yield memory). */
  todayYield: 'f64',
  /** Unfunded need today (food units) -> starvation. */
  deficit: 'f64',
  injuryCause: 'u8',
  /** Who inflicted the current injury (violence), for death records. */
  injuredBy: 'i32',
  /** Event id of the pairing that produced the current partnership. */
  pairEventId: 'i32',
  /** Event id of the injury currently affecting this agent. */
  injuryEventId: 'i32',
  /** EMA of food given to others / the store, and taken from the store (units/day). */
  givenEma: 'f64',
  takenEma: 'f64',
  /** Tick of this agent's last confrontation (one per day). */
  lastConflictTick: 'i32',
  /** Event id of the last contest this agent won (for causal chains of power). */
  lastWinEvent: 'i32',
  /** Contests won (strength legitimacy; succession by "contest winners"). */
  contestWins: 'f64',
  /** Hunting party leader this agent joined today (-1 = none / is a leader). */
  partyLeader: 'i32',
  /** Home tile for today (set at decision time; derived from clan camp / own home). */
  homeTileToday: 'i32',
  /** Play mode: stopped (called out to by the player) until this absolute sub-step (tick*subSteps+s). */
  heldUntil: 'i32',
  /** Index into the MindStore pool while alive; -1 when dead. */
  slot: 'i32',
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
  /** Display ordinals for repeated names (derived from `names`; not state). */
  private ordinals: number[] = [];
  private nameCounts = new Map<string, number>();
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
    c.birthClanId[id] = NO_ID;
    c.deathTick[id] = NO_ID;
    c.killerId[id] = NO_ID;
    c.rearerId[id] = NO_ID;
    c.pregnancyFatherId[id] = NO_ID;
    c.partnerId[id] = NO_ID;
    c.angerTarget[id] = NO_ID;
    c.followId[id] = NO_ID;
    c.targetTile[id] = NO_ID;
    c.slot[id] = NO_ID;
    c.pairEventId[id] = NO_ID;
    c.partyLeader[id] = NO_ID;
    c.lastConflictTick[id] = NO_ID;
    c.injuredBy[id] = NO_ID;
    c.lastWinEvent[id] = NO_ID;
    c.injuryEventId[id] = NO_ID;
    c.healthCap[id] = 1;
    c.alive[id] = 1;
    this.names[id] = name;
    this.living.push(id); // ids are monotonic, so push keeps ascending order
    return id;
  }

  /**
   * The name with a regnal-style ordinal when it was used before
   * ("Zaan", later "Zaan II"): names recur via ancestor naming, and
   * histories must still tell people apart. Derived lazily from `names`.
   */
  displayName(id: number): string {
    if (id < 0 || id >= this.count) return 'someone';
    for (let i = this.ordinals.length; i < this.count; i++) {
      const k = (this.nameCounts.get(this.names[i]) ?? 0) + 1;
      this.nameCounts.set(this.names[i], k);
      this.ordinals.push(k);
    }
    const k = this.ordinals[id];
    return k > 1 ? `${this.names[id]} ${roman(k)}` : this.names[id];
  }

  /** Replace all names (snapshot restore); drops the derived ordinals. */
  setNames(names: string[]): void {
    this.names = [...names];
    this.ordinals = [];
    this.nameCounts.clear();
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

/** Daily activity / goal ids. */
export const GOAL_REST = 0;
export const GOAL_FORAGE = 1;
export const GOAL_HUNT = 2;
export const GOAL_CARE = 3;
export const GOAL_FOLLOW = 4;
export const GOAL_CARRIED = 5;
export const GOAL_SOCIALIZE = 6;
export const GOAL_AVENGE = 7;
export const GOAL_NAMES = ['rest', 'forage', 'hunt', 'care for children', 'follow caregiver', 'carried', 'socialize', 'seek revenge'];

/** Movement phase within a day. */
export const PHASE_HOME = 0;
export const PHASE_OUT = 1;
export const PHASE_WORK = 2;
export const PHASE_RETURN = 3;

export const CAUSE_NONE = 0;
export const CAUSE_AGING = 1;
export const CAUSE_STARVATION = 2;
export const CAUSE_INJURY = 3;
export const CAUSE_EPIDEMIC = 4;
export const CAUSE_CHILDBIRTH = 5;
export const CAUSE_HUNTING = 6;
export const CAUSE_VIOLENCE = 7;
export const CAUSE_NEGLECT = 8;
export const CAUSE_INFANT = 9;
export const CAUSE_NAMES = [
  'unknown', 'old age and illness', 'starvation', 'injury', 'epidemic', 'childbirth',
  'hunting accident', 'violence', 'accident while unattended', 'infant illness',
];

function roman(n: number): string {
  const t: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, r] of t) while (n >= v) { out += r; n -= v; }
  return out;
}
