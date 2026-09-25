# Performance (§14)

Command: `npm run perf -- --years 2 --warmup 1` (headless Node 22, single thread, seed 1).
Measured on a 4-core cloud container **while a 4-thread acceptance batch was also running**,
so the absolute rates are pessimistic, roughly 1.5–2× below an idle machine.

Density is held at the calibrated default (4 clans × 50 people on a 96² map).
The map side scales with √(target/200) and the clan count scales linearly.
The timed window therefore measures a viable population rather than a famine.
In a first attempt that packed 1,000 or 2,000 people onto the 96² map, the populations
crashed to 661 and 277 within the warmup year.

| target agents | map | mean living (timed) | sim-years/s | ms per sim-day | per agent-day |
|---|---|---|---|---|---|
| 200 | 96² | 201 | 0.50 | 5.5 | 27.2 µs |
| 1000 | 215² | 956 | 0.10 | 28.1 | 29.4 µs |
| 2000 | 304² | 1847 | 0.05 | 55.0 | 29.8 µs |

**Scaling is linear** in living agents, at about 29 µs per agent-day across the range.
The spatial hash, cached flow fields, staggered night social, lazy relationship decay
and weekly leadership derivation keep the per-agent cost flat.
Batch experiments parallelise across seeds (`src/cli/pool.ts`, one worker thread per core).
A 20-seed × 300-year batch at the default scale therefore takes about 1–2 h of wall time on 4 cores.

## Profile (200 agents, 3 years, `node --cpu-prof`)

The profile is flat. No function takes more than about 5% of self time:

- garbage collector: 8.4%
- memory salience (gossip): 5.2%
- relationship-slot allocate: 5.0%
- provisioning: 4.7%
- night socialize: 4.2%
- gossip: 4.0%
- place choice: 3.9%
- night contacts: 3.8%
- relationship update: 3.6%
- softmax: 3.2%
- adult decisions: 3.1%

Further speed-up would need broad work: fewer allocations in the relationship and memory stores,
or moving the decision loop to typed-array utilities. It would not come from fixing one hotspot.
That is deferred; the cost is linear and the renderer runs the sim in a worker,
so it never blocks frames.

## Renderer

Main-thread JS costs 2–3 ms per frame at 1,000 agents, measured in headless Chromium with
software GL, so GPU time is not representative. That covers instanced
bodies (one draw call per body part), LOD points at chronicle speeds, no animation off screen,
and attribute buffers streamed from the worker.
