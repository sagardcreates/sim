/**
 * Debug view: top-down 2D canvas, terrain + agent dots. Pure observer of
 * worker messages; it has no access to sim state at all.
 */
import { ATTR_STRIDE, type DayMsg, type FromWorker, type ToWorker, type WorldMsg } from '../worker/protocol';

const SCALE = 8;
const BIOME_COLORS = ['#8fae5d', '#4f7a3a', '#9a8b6a', '#c8b77a', '#3f6f9a'];
const CLAN_COLORS = ['#e06c5a', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#98c379', '#d19a66', '#f0f0f0', '#ff9df0', '#9dffcb'];
const GOAL_COLORS = ['#b8b8b8', '#7fd36b', '#ff6b5b', '#f2c14e', '#6bc6ff', '#ffffff', '#d58cff', '#ff2020'];
const GOAL_LABELS = ['resting', 'foraging', 'hunting', 'caring for children', 'following caregiver', 'carried infant', 'socializing', 'seeking revenge'];
const SPEEDS: [string, number][] = [
  ['pause', 0], ['1x', 1 / 15], ['10x', 10 / 15], ['100x', 100 / 15], ['max', Infinity],
];
type ColorMode = 'clan' | 'activity' | 'hunger';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const clansEl = document.getElementById('clans')!;
const inspectEl = document.getElementById('inspect')!;
const tickerEl = document.getElementById('ticker')!;
const legendEl = document.getElementById('legend')!;
const seedInput = document.getElementById('seed') as HTMLInputElement;
const modeSelect = document.getElementById('mode') as HTMLSelectElement;
const popCanvas = document.getElementById('pop') as HTMLCanvasElement;

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
let mode: ColorMode = 'activity';
const popHistory: number[] = [];
let lastPopTick = -1;

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
  popHistory.length = 0;
  lastPopTick = -1;
  inspectEl.textContent = 'Click a person to see what they are doing and why.';
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
    } else if (m.type === 'inspect') {
      if (m.id === selectedId) {
        const why = m.why.map((w) => `${w.label} (${w.value >= 0 ? '+' : ''}${w.value.toFixed(2)})`).join(', ');
        inspectEl.textContent = [m.name, ...m.lines, m.goal ? `doing: ${m.goal}` : '', why ? `because: ${why}` : ''].filter(Boolean).join('\n');
      }
    } else if (m.type === 'day') {
      cur = m;
      dayArrivedAt = performance.now();
      if (m.tick - lastPopTick >= 30 || lastPopTick < 0) {
        popHistory.push(m.population);
        if (popHistory.length > 400) popHistory.shift();
        lastPopTick = m.tick;
        drawPop();
      }
      renderPanels(m);
      if (selectedId >= 0) send({ type: 'inspect', id: selectedId });
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
      t.fillStyle = `rgba(0,0,0,${(0.35 * (1 - w.elevation[i])).toFixed(3)})`;
      t.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    }
  }
}

function renderPanels(d: DayMsg): void {
  clansEl.innerHTML = d.clans
    .map((c) => `<div><span class="swatch" style="background:${clanColor(c.id)}"></span>${c.label}<span class="num">${c.size} people · store ${c.store.toFixed(0)}</span></div>`)
    .join('');
  tickerEl.textContent = d.ticker.slice().reverse().join('\n');
}

function drawPop(): void {
  const g = popCanvas.getContext('2d')!;
  const W = popCanvas.width;
  const H = popCanvas.height;
  g.clearRect(0, 0, W, H);
  if (popHistory.length < 2) return;
  const max = Math.max(...popHistory) * 1.1;
  g.strokeStyle = '#d8a657';
  g.lineWidth = 1.5;
  g.beginPath();
  popHistory.forEach((p, i) => {
    const x = (i / (popHistory.length - 1)) * (W - 2) + 1;
    const y = H - 2 - (p / max) * (H - 4);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
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

function agentColor(d: DayMsg, i: number): string {
  const o = i * ATTR_STRIDE;
  if (mode === 'clan') return clanColor(d.attrs[o]);
  if (mode === 'activity') return GOAL_COLORS[d.attrs[o + 3]] ?? '#fff';
  const e = d.attrs[o + 4];
  const r = Math.round(255 * (1 - e));
  const g = Math.round(200 * e + 40);
  return `rgb(${r},${g},70)`;
}

let lastFrame = performance.now();
function draw(): void {
  const now = performance.now();
  fps = fps * 0.9 + (1000 / Math.max(1, now - lastFrame)) * 0.1;
  lastFrame = now;
  if (terrain && world && cur) {
    ctx.drawImage(terrain, 0, 0);
    if (cur.climate.droughtActive) {
      ctx.fillStyle = 'rgba(200,160,40,0.18)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    for (const c of cur.clans) {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(c.x * SCALE - 7, c.y * SCALE - 7, 14, 14);
      ctx.fillStyle = clanColor(c.id);
      ctx.fillRect(c.x * SCALE - 5, c.y * SCALE - 5, 10, 10);
    }
    const f = subStepPhase(cur);
    const n = cur.ids.length;
    for (let i = 0; i < n; i++) {
      const [x, y] = positionAt(cur, i, f);
      const age = cur.attrs[i * ATTR_STRIDE + 2];
      const r = age < 3 ? 1.4 : age < 13 ? 2 : 2.9;
      ctx.beginPath();
      ctx.arc(x * SCALE, y * SCALE, r, 0, Math.PI * 2);
      ctx.fillStyle = agentColor(cur, i);
      ctx.fill();
      if (mode !== 'clan') {
        ctx.strokeStyle = clanColor(cur.attrs[i * ATTR_STRIDE]);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      if (cur.ids[i] === selectedId) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x * SCALE, y * SCALE, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const season = ['spring', 'summer', 'autumn', 'winter'][Math.floor(cur.dayOfYear / 91.25) % 4];
    hud.textContent =
      `year ${cur.year} · day ${cur.dayOfYear} (${season})\n` +
      `population ${cur.population}\n` +
      `${cur.climate.droughtActive ? 'drought' : 'no drought'}${cur.climate.epidemicActive ? ' · epidemic' : ''}\n` +
      `${fps.toFixed(0)} fps`;
  }
  requestAnimationFrame(draw);
}

function renderLegend(): void {
  if (mode === 'activity') {
    legendEl.innerHTML = GOAL_LABELS.map((l, k) => `<div><span class="swatch" style="background:${GOAL_COLORS[k]}"></span>${l}</div>`).join('') +
      '<div class="muted">ring = clan color</div>';
  } else if (mode === 'hunger') {
    legendEl.innerHTML = '<div><span class="swatch" style="background:rgb(40,240,70)"></span>well fed</div><div><span class="swatch" style="background:rgb(255,40,70)"></span>starving</div>';
  } else {
    legendEl.innerHTML = '';
  }
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
  if (selectedId >= 0) send({ type: 'inspect', id: selectedId });
  else inspectEl.textContent = 'Click a person to see what they are doing and why.';
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
modeSelect.value = mode;
modeSelect.onchange = () => {
  mode = modeSelect.value as ColorMode;
  renderLegend();
};
document.getElementById('restart')!.onclick = () => void start(Number(seedInput.value) || 1);

renderLegend();
void start(1);
requestAnimationFrame(draw);
