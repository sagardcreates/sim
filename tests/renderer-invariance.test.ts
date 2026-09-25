import { describe, expect, it } from 'vitest';
import { makeConfig } from '../src/sim/config';
import { Simulation } from '../src/sim/sim';
import { handleMessage } from '../src/worker/host';
import type { FromWorker } from '../src/worker/protocol';

/**
 * M5 acceptance: the renderer/worker is a pure observer. Driving the sim
 * through the worker host (render buffers, event capture, inspector queries,
 * yearly snapshots) must give exactly the same state as a headless run.
 */
describe('renderer invariance', () => {
  it('host-driven run (with inspections) matches headless state hash', () => {
    const days = 2 * 365 + 17;
    const headless = Simulation.create(9, makeConfig());
    headless.run(days);
    const out: FromWorker[] = [];
    const send = (m: FromWorker) => out.push(m);
    handleMessage({ type: 'init', seed: 9 }, send);
    handleMessage({ type: 'speed', daysPerSecond: 0 }, send);
    // Interleave queries (inspect people and clans) with stepping, as a UI would.
    for (const t of [30, 200, 365, 500, days]) {
      handleMessage({ type: 'runTo', tick: t }, send);
      const day = [...out].reverse().find((m) => m.type === 'day');
      if (day && day.type === 'day' && day.ids.length > 0) {
        handleMessage({ type: 'inspect', id: day.ids[0] }, send);
        handleMessage({ type: 'inspectClan', id: day.clans[0]?.id ?? 1 }, send);
      }
    }
    const hash = [...out].reverse().find((m) => m.type === 'hash');
    expect(hash && hash.type === 'hash' && hash.tick).toBe(days);
    expect(hash && hash.type === 'hash' && hash.hash).toBe(headless.stateHash());
  });

  it('scrubbing restores a saved year and replays identically', () => {
    const out: FromWorker[] = [];
    const send = (m: FromWorker) => out.push(m);
    handleMessage({ type: 'init', seed: 10 }, send);
    handleMessage({ type: 'speed', daysPerSecond: 0 }, send);
    handleMessage({ type: 'runTo', tick: 365 * 12 }, send);
    const first = [...out].reverse().find((m) => m.type === 'hash')!;
    // Jump back to year 10 (a saved year) and replay to the same tick.
    handleMessage({ type: 'scrub', year: 10 }, send);
    handleMessage({ type: 'runTo', tick: 365 * 12 }, send);
    const second = [...out].reverse().find((m) => m.type === 'hash')!;
    expect(second).toEqual(first);
  });
});
