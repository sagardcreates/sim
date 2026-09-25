/**
 * The historian (§12): turns primitive events into named stories AFTER the
 * fact. Nothing here drives behavior; labels are new events whose causes
 * point at the primitive events that justify them.
 *
 * Yearly analyzers: alliance, feud, famine, regime type, population
 * overtakes, and "firsts". Fission and dissolution are primitive events
 * already; dissolution gets its causes (last departures/deaths) here.
 * Also: significance scoring, chronicle lines and whyQuery (causal chains).
 */
import type { Simulation } from '../sim';
import type { EventType, SimEvent } from './events';

export interface HistorianState {
  /** "a-b" -> consecutive years of mutual warmth (alliance candidate). */
  allianceYears: Record<string, number>;
  /** Pairs currently labelled allied (to label beginnings/endings once). */
  allied: string[];
  /** "a-b" -> killings in the recent window [{tick, id}] (feud detection). */
  feudKillings: Record<string, { tick: number; id: number; dir: number }[]>;
  feuding: string[];
  largestClan: number;
  firsts: string[];
  /** clan -> last regime label. */
  regimes: Record<string, string>;
  /** clan -> candidate label and consecutive years it has held (label hysteresis). */
  regimeCandidate: Record<string, { label: string; years: number }>;
}

export function initialHistorian(): HistorianState {
  return { allianceYears: {}, allied: [], feudKillings: {}, feuding: [], largestClan: -1, firsts: [], regimes: {}, regimeCandidate: {} };
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Called once per year (after the year's stats are closed). */
export function historianSystem(sim: Simulation): void {
  const hc = sim.cfg.historian;
  const h = sim.historian;
  const year = sim.year - 1;
  const t = sim.tick;
  const yearEvents = eventsInLastYear(sim);
  const clans = sim.clans.extant().filter((c) => (sim.clanMembers.get(c.id)?.length ?? 0) > 0);

  // --- Alliances: mutual affinity above threshold for N+ years AND intermarriage between them.
  const seen = new Set<string>();
  for (const a of clans) {
    for (const b of clans) {
      if (a.id >= b.id) continue;
      const k = pairKey(a.id, b.id);
      seen.add(k);
      const ab = sim.clanRelations.get(`${a.id}>${b.id}`) ?? 0;
      const ba = sim.clanRelations.get(`${b.id}>${a.id}`) ?? 0;
      const warm = Math.min(ab, ba) > hc.allianceAffinity;
      h.allianceYears[k] = warm ? (h.allianceYears[k] ?? 0) + 1 : 0;
      const marriages = intermarriages(sim, a.id, b.id, hc.allianceYearsNeeded);
      const isAllied = h.allied.includes(k);
      if (!isAllied && h.allianceYears[k] >= hc.allianceYearsNeeded && marriages.length > 0) {
        h.allied.push(k);
        label(sim, 'history.alliance', marriages.slice(-3), [a.id, b.id], { clans: [a.id, b.id], years: h.allianceYears[k], marriages: marriages.length });
      } else if (isAllied && h.allianceYears[k] === 0) {
        h.allied = h.allied.filter((x) => x !== k);
        label(sim, 'history.alliance_ended', [], [a.id, b.id], { clans: [a.id, b.id] });
      }
    }
  }
  for (const k of Object.keys(h.allianceYears)) if (!seen.has(k)) delete h.allianceYears[k];

  // --- Feuds: repeated killings between two clans (both directions, or several) within a span of years.
  for (const e of yearEvents) {
    if (e.type !== 'agent.died' || (e.data as { cause?: string }).cause !== 'violence') continue;
    const killer = (e.data as { killer?: number }).killer;
    if (killer === undefined) continue;
    const victimClan = e.clans![0];
    const killerClan = sim.agents.cols.clanId[killer];
    if (victimClan < 0 || killerClan < 0) continue;
    const k = pairKey(victimClan, killerClan);
    (h.feudKillings[k] ??= []).push({ tick: e.tick, id: e.id, dir: killerClan < victimClan ? 1 : -1 });
  }
  for (const k of Object.keys(h.feudKillings)) {
    const list = h.feudKillings[k].filter((x) => t - x.tick <= hc.feudWindowYears * sim.cfg.time.daysPerYear);
    h.feudKillings[k] = list;
    const both = list.some((x) => x.dir > 0) && list.some((x) => x.dir < 0);
    const isFeud = list.length >= hc.feudMinKillings && (both || list.length >= hc.feudMinKillings + 2);
    const [a, b] = k.split('-').map(Number);
    const internal = a === b;
    if (isFeud && !h.feuding.includes(k)) {
      h.feuding.push(k);
      label(sim, internal ? 'history.blood_feud' : 'history.feud', list.map((x) => x.id), internal ? [a] : [a, b], { killings: list.length });
    } else if (!isFeud && list.length === 0 && h.feuding.includes(k)) {
      h.feuding = h.feuding.filter((x) => x !== k);
      label(sim, 'history.feud_ended', [], internal ? [a] : [a, b], {});
    }
    if (list.length === 0) delete h.feudKillings[k];
  }

  // --- Famine: a year where starvation killed a notable share of the population.
  const ys = sim.stats.years[sim.stats.years.length - 1];
  const starved = ys?.deaths['starvation'] ?? 0;
  if (ys && starved >= hc.famineMinDeaths && starved / Math.max(1, ys.population) >= hc.famineShare) {
    const causes = yearEvents.filter((e) => e.type === 'climate.drought_began').map((e) => e.id);
    if (sim.climate.droughtActive && !causes.includes(sim.climate.droughtEventId)) causes.push(sim.climate.droughtEventId);
    label(sim, 'history.famine', causes, clans.map((c) => c.id), { starved, population: ys.population });
  }

  // --- Regime type (label from metrics, never a stored enum).
  for (const c of clans) {
    const r = regimeOf(sim, c.id);
    const cand = h.regimeCandidate[String(c.id)];
    h.regimeCandidate[String(c.id)] = cand && cand.label === r.label ? { label: r.label, years: cand.years + 1 } : { label: r.label, years: 1 };
    if (h.regimeCandidate[String(c.id)].years < hc.regimePersistYears) continue;
    if (h.regimes[String(c.id)] !== r.label) {
      const prev = h.regimes[String(c.id)];
      h.regimes[String(c.id)] = r.label;
      if (prev !== undefined || r.label !== 'egalitarian band') {
        label(sim, 'history.regime', r.causes, [c.id], { regime: r.label, previous: prev ?? null, gini: round(r.gini), kinSuccession: round(r.kinShare), tenure: round(r.meanTenure) });
      }
    }
  }

  // --- Population overtakes: a new largest clan.
  let largest = -1;
  let largestSize = 0;
  for (const c of clans) {
    const n = sim.clanMembers.get(c.id)?.length ?? 0;
    if (n > largestSize) [largest, largestSize] = [c.id, n];
  }
  if (largest >= 0 && h.largestClan >= 0 && largest !== h.largestClan) {
    label(sim, 'history.overtake', [], [largest, h.largestClan], { size: largestSize });
  }
  h.largestClan = largest;

  // --- Firsts.
  const firstOf: [string, EventType, (e: SimEvent) => boolean][] = [
    ['first killing', 'agent.died', (e) => (e.data as { cause?: string }).cause === 'violence'],
    ['first fission', 'clan.fission', () => true],
    ['first leader', 'leader.changed', (e) => (e.data as { leader: number }).leader >= 0],
    ['first cross-clan marriage', 'pair.formed', (e) => e.clans![0] !== e.clans![1]],
    ['first expulsion', 'agent.expelled', () => true],
    ['first clan to vanish', 'clan.dissolved', () => true],
  ];
  for (const [name, type, pred] of firstOf) {
    if (h.firsts.includes(name)) continue;
    const e = yearEvents.find((x) => x.type === type && pred(x));
    if (!e) continue;
    h.firsts.push(name);
    label(sim, 'history.first', [e.id], e.clans ?? [], { what: name });
  }
  void year;
}

function label(sim: Simulation, type: EventType, causes: number[], clans: number[], data: Record<string, unknown>): number {
  const id = sim.events.emit(sim.tick, { type, causes: causes.filter((c) => c > 0), clans, data });
  for (const c of clans) sim.clans.get(c)?.history.push(id);
  return id;
}

/** Macro events of the year just closed. */
function eventsInLastYear(sim: Simulation): SimEvent[] {
  const from = sim.tick - sim.cfg.time.daysPerYear;
  const out: SimEvent[] = [];
  for (const e of sim.events.macro.values()) if (e.tick >= from && e.tick <= sim.tick) out.push(e);
  return out;
}

function intermarriages(sim: Simulation, a: number, b: number, years: number): number[] {
  const from = sim.tick - years * sim.cfg.time.daysPerYear;
  const out: number[] = [];
  for (const e of sim.events.macro.values()) {
    if (e.type !== 'pair.formed' || e.tick < from) continue;
    const [ca, cb] = e.clans!;
    if ((ca === a && cb === b) || (ca === b && cb === a)) out.push(e.id);
  }
  return out;
}

/** Regime label from deference inequality, leader tenure and kin succession. */
export function regimeOf(sim: Simulation, clanId: number): { label: string; gini: number; kinShare: number; meanTenure: number; causes: number[] } {
  const members = sim.clanMembers.get(clanId) ?? [];
  const defs = members.map((m) => (m < sim.clanDeference.length ? sim.clanDeference[m] : 0)).sort((a, b) => a - b);
  const gini = giniOf(defs);
  const tenures = sim.leaderTenures().filter((t) => t.clan === clanId);
  const meanTenure = tenures.length ? tenures.reduce((a, t) => a + t.years, 0) / tenures.length : 0;
  let kin = 0;
  let succ = 0;
  for (let k = 1; k < tenures.length; k++) {
    succ++;
    if (sim.relatedness(tenures[k - 1].leader, tenures[k].leader) >= 0.25) kin++;
  }
  const kinShare = succ > 0 ? kin / succ : 0;
  const hasLeader = sim.leaders.has(clanId);
  const causes = sim.clans.get(clanId)!.history.filter((id) => sim.events.macro.get(id)?.type === 'leader.changed').slice(-3);
  const hc = sim.cfg.historian;
  let lbl = 'egalitarian band';
  if (hasLeader && kinShare >= hc.dynastyKinShare && succ >= 2) lbl = 'hereditary chiefdom';
  else if (hasLeader && gini >= hc.chiefGini) lbl = 'chiefly band';
  else if (hasLeader) lbl = 'big-man band';
  else if (gini >= hc.chiefGini) lbl = 'contested hierarchy';
  return { label: lbl, gini, kinShare, meanTenure, causes };
}

export function giniOf(sorted: number[]): number {
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (n === 0 || sum <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (2 * (i + 1) - n - 1) * sorted[i];
  return acc / (n * sum);
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ---------- Narration (pure functions of the log) ----------

const RARITY: Partial<Record<string, number>> = {
  'history.first': 5, 'clan.fission': 4, 'clan.dissolved': 4, 'history.feud': 4, 'history.blood_feud': 4, 'history.alliance': 4,
  'history.famine': 3, 'history.regime': 3, 'leader.changed': 2.5, 'history.overtake': 2, 'agent.expelled': 2,
  'leader.challenged': 0.8, 'epidemic.outbreak': 2, 'climate.drought_began': 1.5, 'clan.camp_moved': 1,
  'agent.died': 0.5, 'pair.formed': 0.2, 'agent.joined_clan': 0.4, 'history.alliance_ended': 2, 'history.feud_ended': 2,
};

/** Significance = rarity x affected count x status (§12). */
export function significance(sim: Simulation, e: SimEvent): number {
  const rarity = RARITY[e.type] ?? 0.1;
  let affected = e.agents?.length ?? 0;
  if (e.type === 'clan.fission' || e.type === 'clan.dissolved') affected = Math.max(affected, 10);
  if (e.type.startsWith('history.')) affected = Math.max(affected, 5 * (e.clans?.length ?? 1));
  let status = 1;
  if (e.type === 'agent.died') {
    const s = (e.data as { status?: number }).status ?? 0;
    status = 1 + 10 * s;
    if ((e.data as { cause?: string }).cause === 'violence') status *= 3;
  }
  return rarity * Math.log2(2 + affected) * status;
}

export function describe(sim: Simulation, e: SimEvent): string {
  const y = Math.floor(e.tick / sim.cfg.time.daysPerYear);
  const n = (id: number | undefined) => (id !== undefined && id >= 0 ? sim.agents.displayName(id) : 'someone');
  const cl = (id: number | undefined) => (id !== undefined ? sim.clans.label(id) : 'a clan');
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'sim.start': return `Year ${y}: the world began (seed ${d.seed}).`;
    case 'clan.founded': return d.initial ? `Year ${y}: ${cl(e.clans![0])} is among the first clans.` : `Year ${y}: ${n(e.agents?.[0])} led a group out of ${cl(e.clans![1])} and founded ${cl(e.clans![0])}.`;
    case 'clan.fission': return `Year ${y}: ${cl(e.clans![0])} split (${d.size} adults left; community structure ${d.modularity}).`;
    case 'clan.dissolved': {
      // wentTo and died cover the clan's last 20 years.
      const parts = [d.wentTo ? `members went to ${d.wentTo}` : '', d.died ? `${d.died} died` : ''].filter(Boolean);
      const why = d.wentTo ? parts.join('; ') : d.died ? `its last members died; ${d.died} deaths in its final years` : '';
      return `Year ${y}: ${cl(e.clans![0])} dissolved${why ? ` (${why})` : ''}.`;
    }
    case 'clan.camp_moved': return `Year ${y}: ${cl(e.clans![0])} moved camp (foraging returns had fallen to ${d.meanYield}).`;
    case 'agent.died': {
      const lead = sim.leaderAt(e.clans![0], e.tick) === e.agents![0] ? "'s leader" : '';
      const killer = d.killer as number | undefined;
      const factors = (d.factors as string[]) ?? [];
      const during = factors.includes('drought') ? ' during drought' : '';
      const who = e.clans![0] < 0 ? n(e.agents![0]) : lead ? `${cl(e.clans![0])}${lead} ${n(e.agents![0])}` : `${n(e.agents![0])} of ${cl(e.clans![0])}`;
      return `Year ${y}: ${who} died at age ${d.age} (${d.cause}${killer !== undefined ? `, killed by ${n(killer)}` : ''}${during}).`;
    }
    case 'agent.born': return `Year ${y}: ${n(e.agents![0])} was born to ${n(e.agents![1])}.`;
    case 'pair.formed': return `Year ${y}: ${n(e.agents![0])} and ${n(e.agents![1])} paired${e.clans![0] !== e.clans![1] ? ` across clans (${cl(e.clans![0])} / ${cl(e.clans![1])})` : ''}.`;
    case 'agent.joined_clan': return `Year ${y}: ${n(e.agents![0])} joined ${cl(e.clans![0])} (${d.reason}).`;
    case 'agent.left_clan': return `Year ${y}: ${n(e.agents![0])} left ${cl(e.clans![0])}${d.to === -1 ? ' to live alone' : ''} (${d.reason}).`;
    case 'agent.expelled': return `Year ${y}: ${n(e.agents![0])} was driven out of ${cl(e.clans![0])}.`;
    case 'leader.changed': return (d.leader as number) >= 0
      ? `Year ${y}: ${n(d.leader as number)} became leader of ${cl(e.clans![0])} (${Math.round(100 * (d.share as number))}% of deference${d.basis ? `; supporters valued ${d.basis}` : ''}).`
      : `Year ${y}: ${cl(e.clans![0])} became leaderless.`;
    case 'leader.challenged': return `Year ${y}: ${n(e.agents![0])} challenged ${n(e.agents![1])} for leadership.`;
    case 'conflict.attack': return `Year ${y}: ${n(e.agents![0])} and ${n(e.agents![1])} fought (${d.context}); ${n(d.winner as number)} won${d.ambush ? ' in an ambush' : ''}.`;
    case 'conflict.threat': return `Year ${y}: ${n(e.agents![0])} threatened ${n(e.agents![1])} (${d.context}).`;
    case 'food.theft': return `Year ${y}: ${n(e.agents![0])} took food from ${n(e.agents![1])}.`;
    case 'climate.drought_began': return `Year ${y}: a drought began.`;
    case 'climate.drought_ended': return `Year ${y}: the drought ended.`;
    case 'epidemic.outbreak': return `Year ${y}: an epidemic broke out (first case: ${n(e.agents?.[0])}).`;
    case 'epidemic.ended': return `Year ${y}: the epidemic ended.`;
    case 'history.alliance': return `Year ${y}: ${cl(e.clans![0])} and ${cl(e.clans![1])} became allies (${d.years} years of goodwill, ${d.marriages} marriages).`;
    case 'history.alliance_ended': return `Year ${y}: the alliance of ${cl(e.clans![0])} and ${cl(e.clans![1])} faded.`;
    case 'history.feud': return `Year ${y}: a feud raged between ${cl(e.clans![0])} and ${cl(e.clans![1])} (${d.killings} killings).`;
    case 'history.blood_feud': return `Year ${y}: a blood feud tore through ${cl(e.clans![0])} (${d.killings} killings).`;
    case 'history.feud_ended': return `Year ${y}: the feud ${e.clans!.length > 1 ? `between ${cl(e.clans![0])} and ${cl(e.clans![1])}` : `in ${cl(e.clans![0])}`} died down.`;
    case 'history.famine': return `Year ${y}: famine — ${d.starved} starved.`;
    case 'history.regime': return `Year ${y}: ${cl(e.clans![0])} became ${article(String(d.regime))} ${d.regime}${d.previous ? ` (was ${d.previous})` : ''}.`;
    case 'history.overtake': return `Year ${y}: ${cl(e.clans![0])} overtook ${cl(e.clans![1])} as the largest clan (${d.size}).`;
    case 'history.first': {
      const cause = e.causes.length ? sim.events.get(e.causes[0]) : undefined;
      return `Year ${y}: the ${d.what}${cause ? `: ${describe(sim, cause).replace(/^Year \d+: /, '').replace(/\.$/, '')}` : ''}.`;
    }
    default: return `Year ${y}: ${e.type}.`;
  }
}

/** Chronicle: the most significant macro events, in time order. */
export function chronicle(sim: Simulation, opts: { limit?: number; minSignificance?: number; clan?: number } = {}): string[] {
  const scored: [SimEvent, number][] = [];
  for (const e of sim.events.macro.values()) {
    if (e.type === 'year.end' || e.type === 'agent.born') continue;
    if (opts.clan !== undefined && !(e.clans ?? []).includes(opts.clan)) continue;
    const s = significance(sim, e);
    if (s >= (opts.minSignificance ?? 3)) scored.push([e, s]);
  }
  const top = scored.sort((a, b) => b[1] - a[1] || a[0].id - b[0].id).slice(0, opts.limit ?? 200);
  return top.sort((a, b) => a[0].id - b[0].id).map(([e]) => describe(sim, e));
}

export interface WhyStep {
  depth: number;
  event: SimEvent;
  text: string;
}

/** Walks the causal graph backwards from an event (breadth-first, each event once). */
export function whyQuery(sim: Simulation, eventId: number, maxDepth = 8): WhyStep[] {
  const out: WhyStep[] = [];
  const seen = new Set<number>();
  let frontier = [eventId];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = sim.events.get(id);
      if (!e) continue;
      out.push({ depth, event: e, text: describe(sim, e) });
      next.push(...e.causes);
    }
    frontier = next;
  }
  return out;
}

/** "Who founded clan N?" */
export function whoFounded(sim: Simulation, clanId: number): WhyStep[] {
  const clan = sim.clans.get(clanId);
  return clan ? whyQuery(sim, clan.founding.eventId) : [];
}

/** "Why did clan N dissolve?" */
export function whyDissolved(sim: Simulation, clanId: number): WhyStep[] {
  const clan = sim.clans.get(clanId);
  if (!clan) return [];
  const ev = clan.history.map((id) => sim.events.macro.get(id)).find((e) => e?.type === 'clan.dissolved');
  return ev ? whyQuery(sim, ev.id, 3) : [];
}

/** "How did leader X gain power?": the first leader.changed record naming X, and its causes. */
export function howGainedPower(sim: Simulation, leaderId: number): WhyStep[] {
  for (const e of sim.events.macro.values()) {
    if (e.type === 'leader.changed' && (e.data as { leader: number }).leader === leaderId) return whyQuery(sim, e.id, 4);
  }
  return [];
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}
