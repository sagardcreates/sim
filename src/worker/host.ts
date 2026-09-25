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
import { applyPlayerAction, availableHelp, courtable, inviteOdds, proposeOdds, raidCheck, raidOdds, walkOdds, type PlayerAction } from '../sim/play/player';
import { doingText, feelingText, motivesOf, primaryMotive, whyText } from '../sim/play/motives';
import { ageYears } from '../sim/systems/common';
import {
  A_AGE, A_BUILD, A_CLAN, A_ENERGY, A_FEAR, A_FOLLOW, A_GOAL, A_HAIR, A_HEALTH, A_HEIGHT, A_INJURY, A_LEADER, A_MARKER, A_PHASE,
  A_REP, A_SEX, A_SKIN, A_STATUS, ATTR_STRIDE,
  type ClanInspectMsg, type ClanView, type DayEvent, type DayMsg, type FromWorker, type InspectMsg, type ToWorker,
  type PersonMsg, type PlayView, type UiAction,
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
/** Play mode: the frames last sent to the view (what the player saw), for proximity and witnesses. */
let playMode = false;
let shownIds: Int32Array = new Int32Array(0);
let shownFrames: Float32Array = new Float32Array(0);

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
      leader: L, leaderName: L >= 0 ? s.agents.displayName(L) : '', leaderShare: L >= 0 ? s.statusOf(L) : 0,
      parent: cl.founding.parentClanId, marker,
    };
  });
}

function postDay(s: Simulation, extra: Partial<DayMsg> = {}): void {
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
    names.push(s.agents.displayName(id));
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
  const transfer: Transferable[] = [ids.buffer, attrs.buffer, frames.buffer, newGraves.buffer];
  if (playMode && s.player) {
    shownIds = ids.slice();
    shownFrames = frames.slice();
    const motives = new Uint8Array(n);
    const friendly = new Float32Array(n);
    const me = s.player.id;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      if (!c.alive[id] || id === me) continue;
      motives[i] = primaryMotive(s, id);
      friendly[i] = s.rel.affinity(c.slot[id], me, s.tick);
    }
    msg.play = playView(s);
    msg.motives = motives;
    msg.friendly = friendly;
    msg.gameDensity = Float32Array.from(s.world.gameDensity);
    transfer.push(motives.buffer, friendly.buffer, msg.gameDensity.buffer);
  }
  Object.assign(msg, extra);
  dayEvents = [];
  oldCamps = [];
  post(msg, transfer);
}

function stepOnce(s: Simulation): void {
  s.step();
  if (!playMode && s.dayOfYear === 0 && s.year % SNAPSHOT_EVERY === 0 && !snapshots.has(s.year)) snapshots.set(s.year, s.snapshot());
}

function loop(): void {
  if (!sim) return;
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  if (playMode) {
    playTick(sim, dt);
    setTimeout(loop, 4);
    return;
  }
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
  const out: InspectMsg = { ...empty, name: s.agents.displayName(id), alive: c.alive[id] === 1, lines };
  const fam = (role: string, x: number) => {
    if (x !== NO_ID && x >= 0) out.family.push({ role, id: x, name: s.agents.displayName(x), alive: c.alive[x] === 1 });
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
    lines.push(`died: ${CAUSE_NAMES[c.deathCause[id]]}${c.killerId[id] !== NO_ID ? ` (killed by ${s.agents.displayName(c.killerId[id])})` : ''}`);
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
    out.relations.push({ id: o, name: s.agents.displayName(o), label, aff: v.aff, def: v.def, grudge: v.grudge, clan: c.clanId[o] });
  });
  out.relations.sort((a, b) => Math.abs(b.aff) + b.def + b.grudge - (Math.abs(a.aff) + a.def + a.grudge));
  const mm = s.mind;
  for (let k = 0; k < mm.memCount[slot]; k++) {
    const i = slot * MEM_CAP + k;
    const subj = mm.memSubject[i];
    const obj = mm.memObject[i];
    const yr = Math.floor(mm.memTick[i] / dpy);
    const src = mm.memHops[i] === 0 ? 'saw' : `heard (${mm.memHops[i]} hops)`;
    out.memories.push(`${src}: ${s.agents.displayName(subj)} — ${MEM_NAMES[mm.memType[i]]}${obj >= 0 ? ` (${s.agents.displayName(obj)})` : ''}, year ${yr}`);
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
  out.lines.push(L !== undefined ? `leader: ${s.agents.displayName(L)} (${(100 * s.statusOf(L)).toFixed(0)}% of deference)` : 'no leader (distributed)');
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
    if (playMode && s.player && e.type === 'player.kill') {
      dayEvents.push({ type: 'kill', agents: [], x: e.x, y: e.y, text: String((e.data as { kind: number }).kind) });
    }
    if (playMode && s.player) {
      const toast = playerToast(s, e);
      if (toast) dayEvents.push({ type: toast.tone, agents: e.agents?.slice(0, 2) ?? [], text: toast.text });
    }
    // Migration streams (world view): camp moves and people changing clans.
    if (e.type === 'clan.camp_moved') {
      const d = e.data as { from: { x: number; y: number }; to: { x: number; y: number } };
      dayEvents.push({ type: e.type, agents: [], from: d.from, to: d.to });
    }
    if (e.type === 'agent.joined_clan') {
      const from = s.clans.get((e.data as { from: number }).from);
      const to = s.clans.get(e.clans![0]);
      if (from && to) dayEvents.push({ type: e.type, agents: e.agents ?? [], from: { x: from.campX, y: from.campY }, to: { x: to.campX, y: to.campY } });
    }
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
  if (playMode) {
    s.onSubStep = undefined;
    postPlayFrame(s, new Map(), 0);
    return;
  }
  // Emit current positions so the view has something to draw while paused.
  for (let k = 0; k < s.cfg.time.subStepsPerDay; k++) captureSubStep(s, k);
  // Graves and camp history already present (after a scrub) are sent in full.
  postDay(s);
}

/** Handles one UI message. `send` delivers sim output back to the UI. */
export function handleMessage(msg: ToWorker, send: (msg: FromWorker, transfer?: Transferable[]) => void): void {
  post = send;
  if (msg.type === 'play') {
    startPlay(msg.seed, msg.name, msg.female, msg.warmupYears);
    return;
  }
  if (msg.type === 'pos') {
    if (sim?.player) applyPlayerAction(sim, { kind: 'pos', x: msg.x, y: msg.y });
    return;
  }
  if (msg.type === 'act') {
    if (sim?.player) act(sim, msg.action, msg.subStep);
    return;
  }
  if (msg.type === 'person') {
    if (sim?.player) post(person(sim, msg.id));
    return;
  }
  if (msg.type === 'init') {
    playMode = false;
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

// ------------------------------------------------------------------ play mode

function startPlay(newSeed: number, name: string, female: boolean, warmupYears?: number): void {
  playMode = true;
  seed = newSeed;
  config = {};
  snapshots = new Map();
  daysPerSecond = 0;
  config = { world: makeConfig().play.world };
  const s = Simulation.create(newSeed, makeConfig(config));
  sim = undefined; // not observable until the player arrives
  const total = warmupYears ?? s.cfg.play.warmupYears;
  const lines: string[] = [];
  s.events.subscribe((e) => {
    if (e.type === 'agent.died' || e.type === 'conflict.attack' || e.type === 'leader.challenged') {
      if (e.type !== 'agent.died' || (e.data as { killer?: number }).killer === undefined) return;
    }
    const line = describeEvent(s, e);
    if (line) lines.push(line);
  });
  const days = total * s.cfg.time.daysPerYear;
  const chunk = () => {
    const end = Math.min(days, s.tick + 36);
    while (s.tick < end) s.step();
    post({ type: 'loading', year: s.tick / s.cfg.time.daysPerYear, total, lines: lines.splice(0) });
    if (s.tick < days) setTimeout(chunk, 0);
    else {
      applyPlayerAction(s, { kind: 'spawn', name, female });
      start(s);
      post({ type: 'playState', play: playView(s) });
      last = performance.now();
      carry = 0;
      if (!looping) {
        looping = true;
        loop();
      }
    }
  };
  setTimeout(chunk, 0);
}

/** Where the player saw agent `id` (the displayed frame), falling back to its current position. */
function shownPos(s: Simulation, id: number, subStep: number): { x: number; y: number } {
  const n = shownIds.length;
  const k = shownIds.indexOf(id);
  const sub = Math.max(0, Math.min(s.cfg.time.subStepsPerDay - 1, subStep | 0));
  if (k >= 0 && shownFrames.length >= (sub + 1) * n * 2) {
    return { x: shownFrames[(sub * n + k) * 2], y: shownFrames[(sub * n + k) * 2 + 1] };
  }
  return { x: s.agents.cols.x[id], y: s.agents.cols.y[id] };
}

function act(s: Simulation, a: UiAction, subStep: number): void {
  const p = s.player!;
  const c = s.agents.cols;
  const pc = s.cfg.play;
  const px = c.x[p.id];
  const py = c.y[p.id];
  let action: PlayerAction;
  if (a.kind === 'help' || a.kind === 'invite' || a.kind === 'walk' || a.kind === 'court' || a.kind === 'propose') {
    const t = shownPos(s, a.target, subStep);
    if (Math.hypot(t.x - px, t.y - py) > pc.interactRadius + 0.75) {
      post({ type: 'actResult', ok: false, text: 'Too far away. Walk closer first.', seenBy: [] });
      return;
    }
    // Everyone near the player at that moment could see it.
    const witnesses: number[] = [];
    const n = shownIds.length;
    for (let k = 0; k < n; k++) {
      const w = shownIds[k];
      if (w === p.id || w === a.target || !c.alive[w]) continue;
      const q = shownPos(s, w, subStep);
      if (Math.hypot(q.x - px, q.y - py) <= pc.witnessRadius) witnesses.push(w);
    }
    action = a.kind === 'help' ? { kind: 'help', verb: a.verb, target: a.target, witnesses } : { kind: a.kind, target: a.target, witnesses };
  } else if (a.kind === 'take' || a.kind === 'deposit' || a.kind === 'build') {
    const camp = s.clans.get(p.clanId)!;
    if (Math.hypot(camp.campX - px, camp.campY - py) > 3.5) {
      post({ type: 'actResult', ok: false, text: 'Go back to your camp first.', seenBy: [] });
      return;
    }
    action = a;
  } else if (a.kind === 'hail') {
    const t = shownPos(s, a.target, subStep);
    if (Math.hypot(t.x - px, t.y - py) > pc.hailRadius) {
      post({ type: 'actResult', ok: false, text: 'They are too far to hear you.', seenBy: [] });
      return;
    }
    action = a;
  } else if (a.kind === 'hunt') {
    const W = s.world.width;
    if (Math.hypot((a.tile % W) + 0.5 - px, Math.floor(a.tile / W) + 0.5 - py) > pc.huntRange) {
      post({ type: 'actResult', ok: false, text: 'Get closer to the animal first.', seenBy: [] });
      return;
    }
    action = a;
  } else {
    action = a;
  }
  const r = applyPlayerAction(s, action);
  post({
    type: 'actResult', ok: r.ok, text: r.text,
    seenBy: (r.seenBy ?? []).map((x) => ({ ...x, label: s.clans.label(x.clan) })),
  });
  post({ type: 'playState', play: playView(s) });
}

function playView(s: Simulation): PlayView {
  const p = s.player!;
  const c = s.agents.cols;
  const pc = s.cfg.play;
  const camp = s.clans.get(p.clanId)!;
  const members = s.clanMembers.get(p.clanId) ?? [];
  const sizes = s.clans.extant().map((cl) => ({ id: cl.id, label: s.clans.label(cl.id), size: s.clanMembers.get(cl.id)?.length ?? 0 }))
    .sort((a, b) => b.size - a.size || a.id - b.id);
  const others = s.clans.extant().filter((cl) => cl.id !== p.clanId);
  return {
    playerId: p.id, name: s.agents.displayName(p.id), clanId: p.clanId, clanLabel: s.clans.label(p.clanId),
    x: c.x[p.id], y: c.y[p.id], campX: camp.campX, campY: camp.campY,
    carried: c.carriedFood[p.id], carryCapacity: pc.carryCapacity, store: camp.foodStore,
    members: members.length, adults: members.filter((m) => ageYears(s, m) >= s.cfg.life.adultAgeYears).length,
    rank: sizes.findIndex((x) => x.id === p.clanId) + 1, clanCount: sizes.length,
    largest: { label: sizes[0]?.label ?? '', size: sizes[0]?.size ?? 0 },
    suspicion: others.map((cl) => ({ clan: cl.id, label: s.clans.label(cl.id), value: p.suspicion[cl.id] ?? 0 })),
    raids: others.map((cl) => {
      const chk = raidCheck(s, cl.id);
      return { clan: cl.id, label: s.clans.label(cl.id), size: s.clanMembers.get(cl.id)?.length ?? 0, odds: raidOdds(s, cl.id), ok: chk.ok, reason: chk.reason, x: cl.campX, y: cl.campY };
    }),
    raidPlanned: p.raidTarget,
    gathersLeft: p.gatherTick === s.tick ? Math.max(0, pc.gatherActionsPerDay - p.gathersToday) : pc.gatherActionsPerDay,
    caught: p.caught, raidsWon: p.raidsWon, raidsLost: p.raidsLost,
    interactRadius: pc.interactRadius, witnessRadius: pc.witnessRadius,
    skills: { ...p.skills }, hunger: p.hunger, health: c.health[p.id],
    wood: p.wood, woodCarry: pc.woodCarry, campWood: p.campWood, shelters: p.shelters, shelterWood: pc.shelterWood, maxShelters: pc.maxShelters,
    huntsLeft: p.effortTick === s.tick ? Math.max(0, pc.huntsPerDay - p.huntsToday) : pc.huntsPerDay,
    woodLeft: p.effortTick === s.tick ? Math.max(0, pc.woodActionsPerDay - p.woodToday) : pc.woodActionsPerDay,
    hailRadius: pc.hailRadius, huntRange: pc.huntRange, animalTileRate: pc.animalTileRate,
    night: s.nextSubStep < 0 || s.nextSubStep >= s.cfg.time.subStepsPerDay,
    renown: p.renown, female: c.sex[p.id] === 0,
    spouse: c.partnerId[p.id] >= 0 && c.alive[c.partnerId[p.id]] ? s.agents.displayName(c.partnerId[p.id]) : '',
    companions: s.agents.living.filter((id) => c.escortUntil[id] > s.tick * s.cfg.time.subStepsPerDay + Math.max(0, s.nextSubStep)),
    felled: Object.entries(p.felled).map(([t, f]) => [Number(t), f[0]] as [number, number]),
  };
}

// ---------------------------------------------------------------- play-mode streaming

/**
 * Play mode streams the day one slot at a time (each movement sub-step, then
 * the night), so the player acts in the present and whoever they call out to
 * stops right there. Each frame carries the previous and current positions;
 * the view interpolates between them over the slot's duration.
 */
let slotCarry = 0;

function playTick(s: Simulation, dt: number): void {
  if (daysPerSecond <= 0) return;
  const slots = s.cfg.time.subStepsPerDay + 1;
  const slotSeconds = 1 / (daysPerSecond * slots);
  slotCarry += dt / slotSeconds;
  if (slotCarry > 3) slotCarry = 1; // can't keep up: don't pile up debt
  if (slotCarry >= 1) {
    slotCarry -= 1;
    advanceSlot(s, slotSeconds);
  }
}

function advanceSlot(s: Simulation, slotSeconds: number): void {
  const S = s.cfg.time.subStepsPerDay;
  const c = s.agents.cols;
  const before = new Map<number, [number, number]>();
  for (const id of s.agents.living) before.set(id, [c.x[id], c.y[id]]);
  const from = s.nextSubStep < 0 ? 0 : s.nextSubStep;
  if (s.nextSubStep < 0) {
    s.beginDay();
    s.subStep(0);
  } else if (s.nextSubStep < S) {
    s.subStep(s.nextSubStep);
  } else {
    s.endDay();
  }
  const to = s.nextSubStep < 0 ? S + 1 : s.nextSubStep;
  postPlayFrame(s, before, slotSeconds, from / (S + 1), to / (S + 1));
}

function postPlayFrame(s: Simulation, before: Map<number, [number, number]>, slotSeconds: number, f0 = 0, f1 = 0): void {
  const c = s.agents.cols;
  ids = Int32Array.from(s.agents.living);
  const n = ids.length;
  frames = new Float32Array(2 * n * 2);
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const b = before.get(id);
    frames[2 * i] = b ? b[0] : c.x[id];
    frames[2 * i + 1] = b ? b[1] : c.y[id];
    frames[(n + i) * 2] = c.x[id];
    frames[(n + i) * 2 + 1] = c.y[id];
  }
  postDay(s, { subSteps: 2, frameSeconds: slotSeconds, dayFraction: [f0, f1] });
}

function person(s: Simulation, id: number): PersonMsg {
  const c = s.agents.cols;
  const p = s.player!;
  const alive = id >= 0 && id < s.agents.count && c.alive[id] === 1;
  const clan = alive ? c.clanId[id] : -1;
  const inYourClan = clan === p.clanId;
  const partner = c.partnerId[id];
  return {
    type: 'person', id, name: s.agents.displayName(id), alive, clan, clanLabel: s.clans.label(clan),
    age: alive ? Math.floor(ageYears(s, id)) : 0, female: c.sex[id] === 0,
    isLeader: clan >= 0 && s.leaders.get(clan) === id,
    doing: alive ? doingText(s, id) : 'dead', why: alive ? whyText(s, id) : [],
    motives: alive ? motivesOf(s, id) : [],
    feeling: alive ? feelingText(s, id, p.id) : { text: '', aff: 0, def: 0, grudge: 0 },
    help: alive ? availableHelp(s, id) : [],
    invite: alive && !inYourClan && ageYears(s, id) >= s.cfg.life.independentAgeYears ? inviteOdds(s, id) : null,
    inYourClan,
    partner: partner >= 0 && c.alive[partner] ? (partner === p.id ? 'you' : s.agents.displayName(partner)) : '',
    children: s.pedigree.childrenOf(id).filter((k) => c.alive[k]).length,
    courtable: alive ? courtable(s, id) : '',
    courtship: p.courtship[id] ?? 0,
    proposeOdds: alive && courtable(s, id) === 'yes' ? proposeOdds(s, id) : 0,
    walkOdds: alive ? walkOdds(s, id) : 0,
    withYou: alive && c.escortUntil[id] > s.tick * s.cfg.time.subStepsPerDay + Math.max(0, s.nextSubStep),
  };
}

/** Things the player should hear about at once: what happens to their clan and their doings. */
function playerToast(s: Simulation, e: SimEvent): { tone: 'toast-good' | 'toast-bad' | 'toast'; text: string } | undefined {
  const p = s.player!;
  const c = s.agents.cols;
  const mine = (e.clans ?? []).includes(p.clanId);
  const strip = (t: string) => t.replace(/^Year \d+: /, '');
  switch (e.type) {
    case 'player.caught': return { tone: 'toast-bad', text: strip(describe(s, e)) };
    case 'player.visit': return { tone: 'toast', text: `${s.agents.displayName(e.agents![0])} has heard of you and comes to find you.` };
    case 'player.raid': return { tone: (e.data as { won: boolean }).won ? 'toast-good' : 'toast-bad', text: strip(describe(s, e)) };
    case 'agent.joined_clan':
      if (e.clans![0] !== p.clanId || (e.data as { reason: string }).reason === 'joined the stranger') return undefined;
      return { tone: 'toast-good', text: `${s.agents.displayName(e.agents![0])} joined your clan (${(e.data as { reason: string }).reason}).` };
    case 'agent.left_clan':
      return mine ? { tone: 'toast-bad', text: `${s.agents.displayName(e.agents![0])} left your clan (${(e.data as { reason: string }).reason}).` } : undefined;
    case 'agent.died':
      if (!mine || e.agents![0] === p.id) return undefined;
      return { tone: 'toast-bad', text: strip(describe(s, e)) };
    case 'agent.born': {
      const kid = e.agents![0];
      return c.clanId[kid] === p.clanId ? { tone: 'toast-good', text: `${s.agents.displayName(kid)} was born into your clan.` } : undefined;
    }
    case 'clan.dissolved':
    case 'leader.changed':
    case 'clan.founded':
      return e.agents?.[0] === p.id ? undefined : { tone: 'toast', text: strip(describe(s, e)) };
  }
  return undefined;
}
