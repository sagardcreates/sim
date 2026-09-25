/**
 * Sim host: runs inside the Web Worker (see sim.worker.ts) or, as a fallback,
 * on the main thread. It only READS sim state (via the onSubStep observer, the
 * event bus and queries) to build render buffers; it never writes to it.
 * The one exception is scrubbing, which replaces the whole simulation with a
 * restored snapshot (not a mutation of the running history).
 */
import { makeConfig } from '../sim/config';
import type { SimEvent } from '../sim/history/events';
import { Simulation, type SimSnapshot } from '../sim/sim';
import { CAUSE_NAMES, GOAL_NAMES, NO_ID } from '../sim/state/agents';
import { MEM_CAP } from '../sim/state/mind';
import { WHY_LABELS } from '../sim/systems/decision';
import { MEM_NAMES } from '../sim/systems/gossip';
import { describe } from '../sim/history/historian';
import {
  A_AGE, A_BUILD, A_CLAN, A_ENERGY, A_FEAR, A_FOLLOW, A_GOAL, A_HAIR, A_HEALTH, A_HEIGHT, A_INJURY, A_LEADER, A_MARKER, A_PHASE,
  A_REP, A_SEX, A_SKIN, A_STATUS, ATTR_STRIDE,
  type ClanInspectMsg, type ClanView, type DayEvent, type DayMsg, type FromWorker, type InspectMsg, type ToWorker,
} from './protocol';

let sim: Simulation | undefined;
let looping = false;
let daysPerSecond = 0;
let carry = 0;
let last = 0;
let frames: Float32Array = new Float32Array(0);
let ids: Int32Array = new Int32Array(0);
let ticker: string[] = [];
let dayEvents: DayEvent[] = [];
let oldCamps: { x: number; y: number; clan: number }[] = [];
let graveCount = 0;
let sentYears = 0;
let seed = 1;
let config: unknown = {};
/** In-memory snapshots for scrubbing, every SNAPSHOT_EVERY years. */
const SNAPSHOT_EVERY = 10;
let snapshots = new Map<number, SimSnapshot>();
let post: (msg: FromWorker, transfer?: Transferable[]) => void = () => {};

const GESTURE_EVENTS = new Set(['conflict.threat', 'conflict.attack', 'food.theft', 'pair.formed', 'agent.born', 'agent.died', 'hunt.party_kill', 'leader.challenged']);

/** Event types shown in the live chronicle ticker. */
const TICKER = new Set([
  'agent.died', 'clan.camp_moved', 'climate.drought_began', 'climate.drought_ended', 'epidemic.outbreak', 'clan.dissolved',
  'clan.founded', 'agent.expelled', 'leader.changed', 'leader.challenged', 'conflict.attack',
  'history.alliance', 'history.alliance_ended', 'history.feud', 'history.blood_feud', 'history.feud_ended', 'history.famine',
  'history.regime', 'history.overtake', 'history.first',
]);

function describeEvent(s: Simulation, e: SimEvent): string | undefined {
  if (!TICKER.has(e.type)) return undefined;
  if (e.type === 'agent.died' && (e.data as { killer?: number }).killer === undefined && (e.data as { age: number }).age < 50) {
    // Ordinary deaths are too frequent for the ticker; keep violent, leader and elder deaths.
    const lead = s.leaderAt(e.clans![0], e.tick) === e.agents![0];
    if (!lead) return undefined;
  }
  return describe(s, e);
}

function captureSubStep(s: Simulation, subStep: number): void {
  const living = s.agents.living;
  const n = living.length;
  if (subStep === 0) {
    ids = Int32Array.from(living);
    frames = new Float32Array(s.cfg.time.subStepsPerDay * n * 2);
  }
  // Births/deaths happen after movement, so the living list is fixed within a day.
  const { x, y } = s.agents.cols;
  const base = subStep * ids.length * 2;
  for (let i = 0; i < ids.length && i < n; i++) {
    frames[base + 2 * i] = x[ids[i]];
    frames[base + 2 * i + 1] = y[ids[i]];
  }
}

function clanViews(s: Simulation): ClanView[] {
  const c = s.agents.cols;
  return s.clans.extant().map((cl) => {
    const L = s.leaders.get(cl.id) ?? NO_ID;
    const members = s.clanMembers.get(cl.id) ?? [];
    const markers = new Map<number, number>();
    for (const m of members) markers.set(c.cMarker[m], (markers.get(c.cMarker[m]) ?? 0) + 1);
    let marker = 0;
    let best = -1;
    for (const [k, v] of markers) if (v > best) [best, marker] = [v, k];
    return {
      id: cl.id, label: s.clans.label(cl.id), x: cl.campX, y: cl.campY, size: members.length, store: cl.foodStore,
      leader: L, leaderName: L >= 0 ? s.agents.names[L] : '', leaderShare: L >= 0 ? s.statusOf(L) : 0,
      parent: cl.founding.parentClanId, marker,
    };
  });
}

function postDay(s: Simulation): void {
  const n = ids.length;
  const attrs = new Float32Array(n * ATTR_STRIDE);
  const c = s.agents.cols;
  const names: string[] = [];
  const dpy = s.cfg.time.daysPerYear;
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const o = i * ATTR_STRIDE;
    attrs[o + A_CLAN] = c.clanId[id];
    attrs[o + A_SEX] = c.sex[id];
    attrs[o + A_AGE] = (s.tick - c.birthTick[id]) / dpy;
    attrs[o + A_GOAL] = c.goal[id];
    attrs[o + A_ENERGY] = c.energy[id];
    attrs[o + A_HEALTH] = c.health[id];
    attrs[o + A_REP] = c.repState[id];
    attrs[o + A_MARKER] = c.cMarker[id];
    attrs[o + A_INJURY] = c.injury[id];
    attrs[o + A_SKIN] = c.gSkin[id];
    attrs[o + A_HAIR] = c.gHair[id];
    attrs[o + A_HEIGHT] = c.gHeight[id];
    attrs[o + A_BUILD] = c.build[id];
    attrs[o + A_STATUS] = c.alive[id] ? s.statusOf(id) : 0;
    attrs[o + A_LEADER] = s.leaders.get(c.clanId[id]) === id ? 1 : 0;
    attrs[o + A_FOLLOW] = c.goal[id] === 5 ? c.followId[id] : NO_ID;
    attrs[o + A_PHASE] = c.phase[id];
    attrs[o + A_FEAR] = c.fear[id];
    names.push(s.agents.names[id]);
  }
  const newGraves = new Float32Array((s.graves.length - graveCount) * 2);
  for (let k = graveCount; k < s.graves.length; k++) {
    newGraves[(k - graveCount) * 2] = s.graves[k].x;
    newGraves[(k - graveCount) * 2 + 1] = s.graves[k].y;
  }
  graveCount = s.graves.length;
  const yearly = s.stats.years.slice(sentYears).map((y) => ({
    year: y.year, population: y.population, clans: y.clans, killings: y.killings, births: y.births,
  }));
  sentYears = s.stats.years.length;
  const msg: DayMsg = {
    type: 'day', tick: s.tick, year: s.year, dayOfYear: s.dayOfYear, subSteps: s.cfg.time.subStepsPerDay,
    ids, attrs, frames, names,
    population: s.agents.living.length,
    clans: clanViews(s),
    climate: {
      season: s.climate.season, drought: s.climate.drought, droughtActive: s.climate.droughtActive,
      epidemicActive: s.climate.epidemicActive, droughtMult: s.climate.droughtMult,
    },
    ticker: ticker.slice(-14),
    events: dayEvents,
    newGraves,
    oldCamps,
    relations: [...s.clanRelations.entries()],
    snapshotYears: [...snapshots.keys()].sort((a, b) => a - b),
    yearly,
  };
  dayEvents = [];
  oldCamps = [];
  post(msg, [ids.buffer, attrs.buffer, frames.buffer, newGraves.buffer]);
}

function stepOnce(s: Simulation): void {
  s.step();
  if (s.dayOfYear === 0 && s.year % SNAPSHOT_EVERY === 0 && !snapshots.has(s.year)) snapshots.set(s.year, s.snapshot());
}

function loop(): void {
  if (!sim) return;
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  if (daysPerSecond > 0) {
    carry += Number.isFinite(daysPerSecond) ? dt * daysPerSecond : Infinity;
    const budgetEnd = now + 30;
    let ran = 0;
    while (carry >= 1 && performance.now() < budgetEnd) {
      stepOnce(sim);
      carry -= 1;
      ran++;
    }
    if (!Number.isFinite(carry) || carry > 5) carry = 0; // don't accumulate debt when we can't keep up
    if (ran > 0) postDay(sim);
  }
  setTimeout(loop, 4);
}

function inspect(s: Simulation, id: number): InspectMsg {
  const c = s.agents.cols;
  const empty: InspectMsg = { type: 'inspect', id, lines: [], name: '', alive: false, family: [], relations: [], why: [], goal: '', memories: [] };
  if (id < 0 || id >= s.agents.count) return empty;
  const dpy = s.cfg.time.daysPerYear;
  const age = (((c.alive[id] ? s.tick : c.deathTick[id]) - c.birthTick[id]) / dpy).toFixed(1);
  const lines = [`${c.sex[id] ? 'male' : 'female'}, age ${age} · ${s.clans.label(c.clanId[id])}`];
  const out: InspectMsg = { ...empty, name: s.agents.names[id], alive: c.alive[id] === 1, lines };
  const fam = (role: string, x: number) => {
    if (x !== NO_ID && x >= 0) out.family.push({ role, id: x, name: s.agents.names[x], alive: c.alive[x] === 1 });
  };
  const m = c.motherId[id];
  const f = c.fatherId[id];
  fam('mother', m);
  fam('father', f);
  for (const p of [m, f]) if (p !== NO_ID) { fam('grandparent', c.motherId[p]); fam('grandparent', c.fatherId[p]); }
  if (m !== NO_ID) for (const sib of s.pedigree.childrenOf(m)) if (sib !== id) fam('sibling', sib);
  fam('partner', c.partnerId[id]);
  for (const k of s.pedigree.childrenOf(id)) fam('child', k);
  if (!c.alive[id]) {
    lines.push(`died: ${CAUSE_NAMES[c.deathCause[id]]}${c.killerId[id] !== NO_ID ? ` (killed by ${s.agents.names[c.killerId[id]]})` : ''}`);
    return out;
  }
  const slot = c.slot[id];
  out.goal = GOAL_NAMES[c.goal[id]];
  for (let k = 0; k < 3; k++) {
    const t = s.mind.whyTerm[slot * 3 + k];
    if (t) out.why.push({ label: WHY_LABELS[t], value: s.mind.whyVal[slot * 3 + k] });
  }
  lines.push(`energy ${c.energy[id].toFixed(2)} · health ${c.health[id].toFixed(2)} · skill ${c.foragingSkill[id].toFixed(2)}`);
  lines.push(`carrying ${c.carriedFood[id].toFixed(1)} food${c.repState[id] === 2 ? ' · pregnant' : ''}${c.repState[id] === 3 ? ' · nursing' : ''}${c.injury[id] > 0.1 ? ' · injured' : ''}`);
  lines.push(`status ${(100 * s.statusOf(id)).toFixed(1)}% of clan deference${s.leaders.get(c.clanId[id]) === id ? ' · LEADER' : ''}`);
  lines.push(`sharing ${c.cSharing[id].toFixed(2)} · violence tolerance ${c.cViolence[id].toFixed(2)} · marker #${c.cMarker[id]}`);
  lines.push(`bold ${c.boldness[id].toFixed(2)} · temper ${c.temper[id].toFixed(2)} · sociable ${c.sociability[id].toFixed(2)}`);
  const p = c.partnerId[id];
  s.rel.forEach(slot, s.tick, (o, v) => {
    if (!c.alive[o]) return;
    const label = o === p ? 'partner' : v.grudge > 0.4 || v.aff < -0.4 ? 'enemy' : v.grudge > 0.15 ? 'rival'
      : v.def > 0.25 ? 'respected' : v.aff > 0.5 ? 'friend' : 'acquaintance';
    out.relations.push({ id: o, name: s.agents.names[o], label, aff: v.aff, def: v.def, grudge: v.grudge, clan: c.clanId[o] });
  });
  out.relations.sort((a, b) => Math.abs(b.aff) + b.def + b.grudge - (Math.abs(a.aff) + a.def + a.grudge));
  const mm = s.mind;
  for (let k = 0; k < mm.memCount[slot]; k++) {
    const i = slot * MEM_CAP + k;
    const subj = mm.memSubject[i];
    const obj = mm.memObject[i];
    const yr = Math.floor(mm.memTick[i] / dpy);
    const src = mm.memHops[i] === 0 ? 'saw' : `heard (${mm.memHops[i]} hops)`;
    out.memories.push(`${src}: ${s.agents.names[subj] ?? '?'} — ${MEM_NAMES[mm.memType[i]]}${obj >= 0 ? ` (${s.agents.names[obj]})` : ''}, year ${yr}`);
  }
  return out;
}

function inspectClan(s: Simulation, id: number): ClanInspectMsg {
  const c = s.agents.cols;
  const clan = s.clans.get(id);
  const out: ClanInspectMsg = { type: 'clanInspect', id, lines: [], culture: [], markers: [], history: [] };
  if (!clan) return out;
  const members = s.clanMembers.get(id) ?? [];
  const L = s.leaders.get(id);
  out.lines.push(s.clans.label(id));
  out.lines.push(`${members.length} people · store ${clan.foodStore.toFixed(0)} · founded year ${Math.floor(clan.founding.tick / s.cfg.time.daysPerYear)}${clan.founding.parentClanId > 0 ? ` from ${s.clans.label(clan.founding.parentClanId)}` : ''}`);
  out.lines.push(L !== undefined ? `leader: ${s.agents.names[L]} (${(100 * s.statusOf(L)).toFixed(0)}% of deference)` : 'no leader (distributed)');
  const mean = (f: keyof typeof c) => members.reduce((a, m) => a + (c[f] as Float64Array)[m], 0) / Math.max(1, members.length);
  out.culture = [
    { name: 'sharing norm', value: mean('cSharing') }, { name: 'violence tolerance', value: mean('cViolence') },
    { name: 'outgroup trust', value: mean('cOutgroupTrust') }, { name: 'kin weight', value: mean('cKinWeight') },
    { name: 'legitimacy: strength', value: mean('cLegStrength') }, { name: 'legitimacy: generosity', value: mean('cLegGenerosity') },
    { name: 'legitimacy: lineage', value: mean('cLegLineage') }, { name: 'legitimacy: age', value: mean('cLegAge') },
  ];
  const mk = new Map<number, number>();
  for (const m of members) mk.set(c.cMarker[m], (mk.get(c.cMarker[m]) ?? 0) + 1);
  out.markers = [...mk.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of s.clanRelations) {
    const [a, b] = k.split('>').map(Number);
    if (a === id && s.clans.get(b)?.dissolvedTick === -1) out.lines.push(`feels ${v >= 0 ? '+' : ''}${v.toFixed(2)} toward ${s.clans.label(b)}`);
  }
  for (const evId of clan.history.slice(-14).reverse()) {
    const e = s.events.macro.get(evId);
    if (!e) continue;
    const line = describeEvent(s, e);
    if (line) out.history.push(line);
  }
  return out;
}

function start(s: Simulation): void {
  sim = s;
  s.onSubStep = captureSubStep;
  ticker = [];
  dayEvents = [];
  oldCamps = [];
  graveCount = 0;
  sentYears = 0;
  s.events.subscribe((e) => {
    const line = describeEvent(s, e);
    if (line) {
      ticker.push(line);
      if (ticker.length > 60) ticker = ticker.slice(-30);
    }
    if (GESTURE_EVENTS.has(e.type) && e.agents) dayEvents.push({ type: e.type, agents: e.agents.slice(0, 4), x: e.x, y: e.y });
    if (e.type === 'clan.camp_moved') {
      const from = (e.data as { from: { x: number; y: number } }).from;
      oldCamps.push({ x: from.x, y: from.y, clan: e.clans![0] });
    }
    if (e.type === 'clan.dissolved' && e.x !== undefined) oldCamps.push({ x: e.x, y: e.y!, clan: e.clans![0] });
  });
  const w = s.world;
  post({
    type: 'world', width: w.width, height: w.height, biome: w.biome, river: w.river, elevation: w.elevation,
    plantCapacity: w.plantCapacity, seed,
    camps: s.clans.extant().map((c) => ({ id: c.id, label: s.clans.label(c.id), x: c.campX, y: c.campY })),
  });
  // Emit current positions so the view has something to draw while paused.
  for (let k = 0; k < s.cfg.time.subStepsPerDay; k++) captureSubStep(s, k);
  // Graves and camp history already present (after a scrub) are sent in full.
  postDay(s);
}

/** Handles one UI message. `send` delivers sim output back to the UI. */
export function handleMessage(msg: ToWorker, send: (msg: FromWorker, transfer?: Transferable[]) => void): void {
  post = send;
  if (msg.type === 'init') {
    seed = msg.seed;
    config = msg.config ?? {};
    snapshots = new Map();
    const s = Simulation.create(msg.seed, makeConfig(config));
    snapshots.set(0, s.snapshot());
    start(s);
    last = performance.now();
    carry = 0;
    if (!looping) {
      looping = true;
      loop();
    }
  } else if (msg.type === 'inspect') {
    if (sim) post(inspect(sim, msg.id));
  } else if (msg.type === 'inspectClan') {
    if (sim) post(inspectClan(sim, msg.id));
  } else if (msg.type === 'speed') {
    daysPerSecond = msg.daysPerSecond;
    carry = 0;
  } else if (msg.type === 'runTo') {
    if (!sim) return;
    while (sim.tick < msg.tick) stepOnce(sim);
    post({ type: 'hash', tick: sim.tick, hash: sim.stateHash() });
    postDay(sim);
  } else if (msg.type === 'scrub') {
    // Restore the nearest earlier snapshot, then fast-forward deterministically.
    const years = [...snapshots.keys()].filter((y) => y <= msg.year).sort((a, b) => b - a);
    if (!sim || years.length === 0) return;
    const s = Simulation.fromSnapshot(snapshots.get(years[0])!);
    const target = msg.year * s.cfg.time.daysPerYear;
    while (s.tick < target) stepOnce(s);
    start(s);
  }
}
