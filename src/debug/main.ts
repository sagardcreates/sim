/**
 * M0 debug view: top-down 2D canvas, terrain + agent dots. Pure observer of
 * worker messages; it has no access to sim state at all.
 */
import { ATTR_STRIDE, type DayMsg, type FromWorker, type ToWorker, type WorldMsg } from '../worker/protocol';

const SCALE = 8;
const BIOME_COLORS = ['#8fae5d', '#4f7a3a', '#9a8b6a', '#c8b77a', '#3f6f9a'];
const CLAN_COLORS = ['#e06c5a', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#98c379', '#d19a66', '#f0f0f0'];
const SPEEDS: [string, number][] = [
  ['pause', 0], ['1x', 1 / 15], ['10x', 10 / 15], ['100x', 100 / 15], ['max', Infinity],
];

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const clansEl = document.getElementById('clans')!;
const inspectEl = document.getElementById('inspect')!;
const seedInput = document.getElementById('seed') as HTMLInputElement;

/** Minimal channel shared by the real Worker and the main-thread fallback. */
interface SimChannel {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null;
}

async function mainThreadChannel(): Promise<SimChannel> {
  const { handleMessage } = await import('../worker/host');
  const ch: SimChannel = {
    onmessage: null,
    postMessage: (msg) => handleMessage(msg, (out) => ch.onmessage?.({ data: out } as MessageEvent<FromWorker>)),
    terminate: () => handleMessage({ type: 'speed', daysPerSecond: 0 }, () => {}),
  };
  return ch;
}

let worker: SimChannel | undefined;
let world: WorldMsg | undefined;
let terrain: HTMLCanvasElement | undefined;
let cur: DayMsg | undefined;
let dayArrivedAt = 0;
let daysPerSecond = 0;
let selectedId = -1;
let fps = 0;

function clanColor(id: number): string {
  return id < 0 ? '#777' : CLAN_COLORS[(id - 1) % CLAN_COLORS.length];
}

function send(msg: ToWorker): void {
  worker?.postMessage(msg);
}

async function start(seed: number): Promise<void> {
  worker?.terminate();
  cur = undefined;
  selectedId = -1;
  try {
    const w = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    // A worker blocked by the host page fails asynchronously; fall back to the main thread.
    w.addEventListener('error', () => {
      if (worker === (w as unknown as SimChannel) && !cur) void startOnMainThread(seed);
    });
    worker = w as unknown as SimChannel;
  } catch {
    worker = await mainThreadChannel();
  }
  wire(seed);
}

async function startOnMainThread(seed: number): Promise<void> {
  worker?.terminate();
  worker = await mainThreadChannel();
  wire(seed);
}

function wire(seed: number): void {
  if (!worker) return;
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    if (m.type === 'world') {
      world = m;
      buildTerrain(m);
    } else {
      cur = m;
      dayArrivedAt = performance.now();
    }
  };
  send({ type: 'init', seed });
  send({ type: 'speed', daysPerSecond });
}

function buildTerrain(w: WorldMsg): void {
  canvas.width = w.width * SCALE;
  canvas.height = w.height * SCALE;
  terrain = document.createElement('canvas');
  terrain.width = canvas.width;
  terrain.height = canvas.height;
  const t = terrain.getContext('2d')!;
  for (let y = 0; y < w.height; y++) {
    for (let x = 0; x < w.width; x++) {
      const i = y * w.width + x;
      t.fillStyle = BIOME_COLORS[w.biome[i]];
      t.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
      // Elevation shading.
      t.fillStyle = `rgba(0,0,0,${(0.35 * (1 - w.elevation[i])).toFixed(3)})`;
      t.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    }
  }
  clansEl.innerHTML = w.camps
    .map((c) => `<div><span class="swatch" style="background:${clanColor(c.id)}"></span>${c.label}</div>`)
    .join('');
}

/** Position of agent slot i at fractional sub-step f within the current day. */
function positionAt(d: DayMsg, i: number, f: number): [number, number] {
  const n = d.ids.length;
  const s0 = Math.min(d.subSteps - 1, Math.floor(f));
  const s1 = Math.min(d.subSteps - 1, s0 + 1);
  const t = f - s0;
  const a = s0 * n * 2 + 2 * i;
  const b = s1 * n * 2 + 2 * i;
  return [d.frames[a] + (d.frames[b] - d.frames[a]) * t, d.frames[a + 1] + (d.frames[b + 1] - d.frames[a + 1]) * t];
}

function subStepPhase(d: DayMsg): number {
  // Slow speeds: play the day's sub-steps back over the day's duration. Fast: show the last frame.
  if (daysPerSecond <= 0 || daysPerSecond > 2) return d.subSteps - 1;
  const secsPerDay = 1 / daysPerSecond;
  const p = Math.min(1, (performance.now() - dayArrivedAt) / 1000 / secsPerDay);
  return p * (d.subSteps - 1);
}

let lastFrame = performance.now();
function draw(): void {
  const now = performance.now();
  fps = fps * 0.9 + (1000 / Math.max(1, now - lastFrame)) * 0.1;
  lastFrame = now;
  if (terrain && world && cur) {
    ctx.drawImage(terrain, 0, 0);
    for (const c of world.camps) {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(c.x * SCALE - 7, c.y * SCALE - 7, 14, 14);
      ctx.fillStyle = clanColor(c.id);
      ctx.fillRect(c.x * SCALE - 5, c.y * SCALE - 5, 10, 10);
    }
    const f = subStepPhase(cur);
    const n = cur.ids.length;
    for (let i = 0; i < n; i++) {
      const [x, y] = positionAt(cur, i, f);
      const clanId = cur.attrs[i * ATTR_STRIDE];
      const age = cur.attrs[i * ATTR_STRIDE + 2];
      const r = age < 15 ? 1.8 : 2.8;
      ctx.beginPath();
      ctx.arc(x * SCALE, y * SCALE, r, 0, Math.PI * 2);
      ctx.fillStyle = clanColor(clanId);
      ctx.fill();
      if (cur.ids[i] === selectedId) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x * SCALE, y * SCALE, 7, 0, Math.PI * 2);
        ctx.stroke();
        inspectEl.textContent = describe(cur, i);
      }
    }
    hud.textContent =
      `year ${cur.year}  day ${cur.dayOfYear}\n` +
      `tick ${cur.tick}\n` +
      `living ${n}\n` +
      `fps ${fps.toFixed(0)}`;
  }
  requestAnimationFrame(draw);
}

function describe(d: DayMsg, i: number): string {
  const a = d.attrs;
  return (
    `#${d.ids[i]} ${d.names[i]}\n` +
    `${a[i * ATTR_STRIDE + 1] === 0 ? 'female' : 'male'}, age ${a[i * ATTR_STRIDE + 2].toFixed(1)}\n` +
    `${world?.camps.find((c) => c.id === a[i * ATTR_STRIDE])?.label ?? 'loner'}`
  );
}

canvas.addEventListener('click', (ev) => {
  if (!cur) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ((ev.clientX - rect.left) / rect.width) * canvas.width / SCALE;
  const my = ((ev.clientY - rect.top) / rect.height) * canvas.height / SCALE;
  const f = subStepPhase(cur);
  let best = -1;
  let bestD = 1.5;
  for (let i = 0; i < cur.ids.length; i++) {
    const [x, y] = positionAt(cur, i, f);
    const dd = Math.hypot(x - mx, y - my);
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  }
  selectedId = best >= 0 ? cur.ids[best] : -1;
  if (best < 0) inspectEl.textContent = 'click an agent to inspect';
});

const speedsEl = document.getElementById('speeds')!;
for (const [label, dps] of SPEEDS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => {
    daysPerSecond = dps;
    send({ type: 'speed', daysPerSecond: dps });
    for (const el of speedsEl.children) el.classList.toggle('active', el === b);
  };
  if (dps === 0) b.classList.add('active');
  speedsEl.appendChild(b);
}
document.getElementById('restart')!.onclick = () => void start(Number(seedInput.value) || 1);

void start(1);
requestAnimationFrame(draw);
