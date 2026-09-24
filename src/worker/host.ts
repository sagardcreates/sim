/**
 * Sim host: runs inside the Web Worker (see sim.worker.ts) or, as a fallback,
 * on the main thread. Wrapper around the pure sim. It only READS sim state (via the
 * onSubStep observer) to build render buffers; it never writes to it.
 */
import { makeConfig } from '../sim/config';
import { Simulation } from '../sim/sim';
import { ATTR_STRIDE, type DayMsg, type FromWorker, type ToWorker } from './protocol';

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
    attrs[i * ATTR_STRIDE] = c.clanId[id];
    attrs[i * ATTR_STRIDE + 1] = c.sex[id];
    attrs[i * ATTR_STRIDE + 2] = (s.tick - c.birthTick[id]) / s.cfg.time.daysPerYear;
    names.push(s.agents.names[id]);
  }
  const msg: DayMsg = {
    type: 'day', tick: s.tick, year: s.year, dayOfYear: s.dayOfYear, subSteps: s.cfg.time.subStepsPerDay,
    ids, attrs, frames, names,
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
  } else if (msg.type === 'speed') {
    daysPerSecond = msg.daysPerSecond;
    carry = 0;
  }
}
