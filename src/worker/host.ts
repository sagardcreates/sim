/**
 * Sim host: runs inside the Web Worker (see sim.worker.ts) or, as a fallback,
 * on the main thread. Wrapper around the pure sim. It only READS sim state (via the
 * onSubStep observer) to build render buffers; it never writes to it.
 */
import { makeConfig } from '../sim/config';
import { Simulation } from '../sim/sim';
import { ATTR_STRIDE, type DayMsg, type FromWorker, type ToWorker } from './protocol';
import { CAUSE_NAMES, GOAL_NAMES, NO_ID } from '../sim/state/agents';
import { WHY_LABELS } from '../sim/systems/decision';
import type { SimEvent } from '../sim/history/events';

let ticker: string[] = [];

function describeEvent(s: Simulation, e: SimEvent): string | undefined {
  const y = Math.floor(e.tick / s.cfg.time.daysPerYear);
  const n = (id: number) => s.agents.names[id];
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'agent.died': return `Year ${y}: ${n(e.agents![0])} (${s.clans.label(e.clans![0])}) died at ${d.age} (${d.cause}${(d.factors as string[]).length ? ', ' + (d.factors as string[]).join(', ') : ''}).`;
    case 'pair.formed': return `Year ${y}: ${n(e.agents![0])} and ${n(e.agents![1])} paired.`;
    case 'clan.camp_moved': return `Year ${y}: ${s.clans.label(e.clans![0])} moved camp.`;
    case 'climate.drought_began': return `Year ${y}: a drought began.`;
    case 'climate.drought_ended': return `Year ${y}: the drought ended.`;
    case 'epidemic.outbreak': return `Year ${y}: an epidemic broke out in ${s.clans.label(e.clans![0])}.`;
    case 'clan.dissolved': return `Year ${y}: ${s.clans.label(e.clans![0])} dissolved.`;
    default: return undefined;
  }
}

function inspect(s: Simulation, id: number): string[] {
  const c = s.agents.cols;
  if (id < 0 || id >= s.agents.count) return [];
  const age = ((s.tick - c.birthTick[id]) / s.cfg.time.daysPerYear).toFixed(1);
  const lines = [`${s.agents.names[id]} (#${id})`, `${c.sex[id] ? 'male' : 'female'}, age ${age}, ${s.clans.label(c.clanId[id])}`];
  if (!c.alive[id]) {
    lines.push(`died: ${CAUSE_NAMES[c.deathCause[id]]}`);
    return lines;
  }
  const slot = c.slot[id];
  lines.push(`doing: ${GOAL_NAMES[c.goal[id]]}`);
  const why: string[] = [];
  for (let k = 0; k < 3; k++) {
    const t = s.mind.whyTerm[slot * 3 + k];
    if (t) why.push(`${WHY_LABELS[t]} (${s.mind.whyVal[slot * 3 + k] >= 0 ? '+' : ''}${s.mind.whyVal[slot * 3 + k].toFixed(2)})`);
  }
  if (why.length) lines.push(`because: ${why.join(', ')}`);
  lines.push(`energy ${c.energy[id].toFixed(2)} · health ${c.health[id].toFixed(2)} · skill ${c.foragingSkill[id].toFixed(2)}`);
  lines.push(`carrying ${c.carriedFood[id].toFixed(1)} food`);
  if (c.repState[id] === 2) lines.push('pregnant');
  if (c.repState[id] === 3) lines.push('nursing');
  const p = c.partnerId[id];
  if (p !== NO_ID) lines.push(`partner: ${s.agents.names[p]}`);
  const kids = s.pedigree.childrenOf(id);
  if (kids.length) lines.push(`children: ${kids.map((k) => s.agents.names[k] + (c.alive[k] ? '' : ' †')).join(', ')}`);
  const m = c.motherId[id];
  if (m !== NO_ID) lines.push(`mother: ${s.agents.names[m]}${c.alive[m] ? '' : ' †'}`);
  return lines;
}

let sim: Simulation | undefined;
let looping = false;
let daysPerSecond = 0;
let carry = 0;
let last = 0;
let frames: Float32Array = new Float32Array(0);
let ids: Int32Array = new Int32Array(0);

let post: (msg: FromWorker, transfer?: Transferable[]) => void = () => {};

function captureSubStep(s: Simulation, subStep: number): void {
  const living = s.agents.living;
  const n = living.length;
  if (subStep === 0) {
    ids = Int32Array.from(living);
    frames = new Float32Array(s.cfg.time.subStepsPerDay * n * 2);
  }
  const { x, y } = s.agents.cols;
  const base = subStep * n * 2;
  for (let i = 0; i < n; i++) {
    frames[base + 2 * i] = x[living[i]];
    frames[base + 2 * i + 1] = y[living[i]];
  }
}

function postDay(s: Simulation): void {
  const n = ids.length;
  const attrs = new Float32Array(n * ATTR_STRIDE);
  const c = s.agents.cols;
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    const o = i * ATTR_STRIDE;
    attrs[o] = c.clanId[id];
    attrs[o + 1] = c.sex[id];
    attrs[o + 2] = (s.tick - c.birthTick[id]) / s.cfg.time.daysPerYear;
    attrs[o + 3] = c.goal[id];
    attrs[o + 4] = c.energy[id];
    attrs[o + 5] = c.health[id];
    attrs[o + 6] = c.repState[id];
    attrs[o + 7] = c.cMarker[id];
    names.push(s.agents.names[id]);
  }
  const msg: DayMsg = {
    type: 'day', tick: s.tick, year: s.year, dayOfYear: s.dayOfYear, subSteps: s.cfg.time.subStepsPerDay,
    ids, attrs, frames, names,
    population: s.agents.living.length,
    clans: s.clans.extant().map((cl) => ({
      id: cl.id, label: s.clans.label(cl.id), x: cl.campX, y: cl.campY,
      size: s.clanMembers.get(cl.id)?.length ?? 0, store: cl.foodStore,
    })),
    climate: { season: s.climate.season, drought: s.climate.drought, droughtActive: s.climate.droughtActive, epidemicActive: s.climate.epidemicActive },
    ticker: ticker.slice(-12),
  };
  post(msg, [ids.buffer, attrs.buffer, frames.buffer]);
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
      sim.step();
      carry -= 1;
      ran++;
    }
    if (!Number.isFinite(carry) || carry > 5) carry = 0; // don't accumulate debt when we can't keep up
    if (ran > 0) postDay(sim);
  }
  setTimeout(loop, 4);
}

/** Handles one UI message. `send` delivers sim output back to the UI. */
export function handleMessage(msg: ToWorker, send: (msg: FromWorker, transfer?: Transferable[]) => void): void {
  post = send;
  if (msg.type === 'init') {
    sim = Simulation.create(msg.seed, makeConfig(msg.config ?? {}));
    sim.onSubStep = captureSubStep;
    ticker = [];
    const s0 = sim;
    s0.events.subscribe((e) => {
      const line = describeEvent(s0, e);
      if (line) {
        ticker.push(line);
        if (ticker.length > 40) ticker = ticker.slice(-20);
      }
    });
    const w = sim.world;
    post({
      type: 'world', width: w.width, height: w.height, biome: w.biome, elevation: w.elevation,
      camps: sim.clans.extant().map((c) => ({ id: c.id, label: sim!.clans.label(c.id), x: c.campX, y: c.campY })),
    });
    // Emit day-0 positions so the view has something to draw while paused.
    for (let s = 0; s < sim.cfg.time.subStepsPerDay; s++) captureSubStep(sim, s);
    postDay(sim);
    last = performance.now();
    carry = 0;
    if (!looping) {
      looping = true;
      loop();
    }
  } else if (msg.type === 'inspect') {
    if (sim) post({ type: 'inspect', id: msg.id, lines: inspect(sim, msg.id) });
  } else if (msg.type === 'speed') {
    daysPerSecond = msg.daysPerSecond;
    carry = 0;
  }
}
