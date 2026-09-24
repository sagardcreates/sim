/**
 * Terrarium UI: wires the sim worker to the 3D view and the custom panels.
 * The UI only sends requests (speed, inspect, scrub); it never touches sim state.
 */
import { clanColor, PAINT } from '../render/palette';
import { TerrariumView } from '../render/view';
import type { ClanInspectMsg, DayMsg, FromWorker, InspectMsg, ToWorker } from '../worker/protocol';

interface SimChannel {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SPEEDS: [string, number][] = [['❚❚', 0], ['1×', 1 / 15], ['10×', 10 / 15], ['100×', 100 / 15], ['max', Infinity]];
const GOAL_COLORS = ['#c9c4b8', '#7fd36b', '#ff6b5b', '#f2c14e', '#6bc6ff', '#ffffff', '#d58cff', '#ff2020'];
const GOAL_LABELS = ['resting', 'foraging', 'hunting', 'minding children', 'learning', 'carried', 'socializing', 'seeking revenge'];
const CHRONICLE_ABOVE = 50 / 15; // days per second

const view = new TerrariumView($('canvas-host'));
let worker: SimChannel | undefined;
let cur: DayMsg | undefined;
let selected = -1;
let selectedClan = -1;
let daysPerSecond = 0;
let yearly: DayMsg['yearly'] = [];
let lastInspectAt = 0;
let lastInspect: InspectMsg | undefined;

async function mainThreadChannel(): Promise<SimChannel> {
  const { handleMessage } = await import('../worker/host');
  const ch: SimChannel = {
    onmessage: null,
    postMessage: (msg) => handleMessage(msg, (out) => ch.onmessage?.({ data: out } as MessageEvent<FromWorker>)),
    terminate: () => handleMessage({ type: 'speed', daysPerSecond: 0 }, () => {}),
  };
  return ch;
}

function send(msg: ToWorker): void {
  worker?.postMessage(msg);
}

async function start(seed: number): Promise<void> {
  worker?.terminate();
  cur = undefined;
  yearly = [];
  selected = -1;
  selectedClan = -1;
  $('inspector').hidden = true;
  $('clan-inspector').hidden = true;
  try {
    const w = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('error', () => {
      if (worker === (w as unknown as SimChannel) && !cur) void fallback(seed);
    });
    worker = w as unknown as SimChannel;
  } catch {
    worker = await mainThreadChannel();
  }
  wire(seed);
}

async function fallback(seed: number): Promise<void> {
  worker?.terminate();
  worker = await mainThreadChannel();
  wire(seed);
}

function wire(seed: number): void {
  if (!worker) return;
  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    if (m.type === 'world') view.setWorld(m);
    else if (m.type === 'day') onDay(m);
    else if (m.type === 'inspect') renderInspector(m);
    else if (m.type === 'clanInspect') renderClan(m);
  };
  send({ type: 'init', seed });
  send({ type: 'speed', daysPerSecond });
}

function onDay(d: DayMsg): void {
  if (cur && d.tick < cur.tick) {
    yearly = yearly.filter((y) => y.year < d.year);
  }
  cur = d;
  view.onDay(d);
  yearly.push(...d.yearly);
  const season = ['spring', 'summer', 'autumn', 'winter'][Math.floor(d.dayOfYear / 91.25) % 4];
  $('date').textContent = `Year ${d.year} · day ${d.dayOfYear} · ${season} · ${d.population} people`;
  $('badges').innerHTML = (d.climate.droughtActive ? '<span class="badge drought">Drought</span>' : '')
    + (d.climate.epidemicActive ? '<span class="badge epidemic">Epidemic</span>' : '');
  renderClanList(d);
  renderTicker(d);
  renderStream();
  const scrub = $<HTMLInputElement>('scrub');
  const years = d.snapshotYears;
  scrub.max = String(Math.max(0, d.year));
  if (document.activeElement !== scrub) scrub.value = String(d.year);
  $('scrub-label').textContent = years.length > 1 ? `Jump to a saved year (every 10: ${years[0]}–${years[years.length - 1]})` : 'Saved years appear every 10 years';
  const now = performance.now();
  if (selected >= 0 && now - lastInspectAt > 400) {
    lastInspectAt = now;
    send({ type: 'inspect', id: selected });
  }
  if (selectedClan >= 0 && now - lastInspectAt > 400) send({ type: 'inspectClan', id: selectedClan });
}

function renderClanList(d: DayMsg): void {
  $('clan-list').innerHTML = d.clans
    .filter((c) => c.size > 0)
    .map((c) => `<div class="clan-row" data-clan="${c.id}">
        <span class="sw" style="background:${clanColor(c.id)}"></span>
        <span>${c.label}</span><span class="meta">${c.size}</span>
        <span class="lead">${c.leader >= 0 ? `led by ${c.leaderName} (${Math.round(c.leaderShare * 100)}%)` : 'no leader'} · marker <span class="dot" style="background:${PAINT[Math.floor(c.marker / 4) % 8]}"></span></span>
      </div>`)
    .join('');
}

function renderTicker(d: DayMsg): void {
  $('ticker').innerHTML = d.ticker.slice().reverse().map((l) => `<li>${escapeHtml(l)}</li>`).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

/** Stacked population by clan over years. */
function renderStream(): void {
  const cv = $<HTMLCanvasElement>('stream');
  const W = cv.clientWidth * devicePixelRatio;
  const H = cv.clientHeight * devicePixelRatio;
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  if (yearly.length < 2) return;
  const maxPop = Math.max(...yearly.map((y) => y.population)) * 1.08;
  const clanIds = [...new Set(yearly.flatMap((y) => y.clans.map((c) => c.id)))].sort((a, b) => a - b);
  const xAt = (k: number) => (k / (yearly.length - 1)) * (W - 4) + 2;
  const base = new Float64Array(yearly.length);
  for (const id of clanIds) {
    g.beginPath();
    for (let k = 0; k < yearly.length; k++) {
      const size = yearly[k].clans.find((c) => c.id === id)?.size ?? 0;
      const y = H - ((base[k] + size) / maxPop) * (H - 4);
      if (k === 0) g.moveTo(xAt(k), y);
      else g.lineTo(xAt(k), y);
    }
    for (let k = yearly.length - 1; k >= 0; k--) g.lineTo(xAt(k), H - (base[k] / maxPop) * (H - 4));
    g.closePath();
    g.fillStyle = clanColor(id);
    g.globalAlpha = 0.85;
    g.fill();
    for (let k = 0; k < yearly.length; k++) base[k] += yearly[k].clans.find((c) => c.id === id)?.size ?? 0;
  }
  g.globalAlpha = 1;
  // Killings as red ticks along the bottom.
  g.fillStyle = '#ff6b5b';
  yearly.forEach((y, k) => {
    if (y.killings > 0) g.fillRect(xAt(k) - 1, H - 3 - Math.min(20, y.killings * 3), 2, Math.min(20, y.killings * 3));
  });
  const lastY = yearly[yearly.length - 1];
  $('tl-readout').textContent = `year ${lastY.year} · ${lastY.population} people · ${lastY.clans.filter((c) => c.size > 0).length} clans`;
}

function renderInspector(m: InspectMsg): void {
  if (m.id !== selected) return;
  lastInspect = m;
  $('inspector').hidden = false;
  $('hint').hidden = true;
  $('insp-name').textContent = m.name + (m.alive ? '' : ' †');
  const maxWhy = Math.max(0.01, ...m.why.map((w) => Math.abs(w.value)));
  const why = m.why.map((w) => `<div class="bar"><span>${escapeHtml(w.label)}</span>
      <span class="track"><span class="fill ${w.value < 0 ? 'neg' : ''}" style="left:0;width:${(Math.abs(w.value) / maxWhy) * 100}%"></span></span></div>`).join('');
  const fam = m.family.map((f) => `<span class="chip ${f.alive ? '' : 'dead'}" data-person="${f.id}" title="${f.role}">${escapeHtml(f.name)} <small>${f.role}</small></span>`).join('');
  $('insp-body').innerHTML = `
    ${m.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
    ${m.goal ? `<div class="section"><div class="label">Doing: ${escapeHtml(m.goal)} — because</div><div class="why">${why}</div></div>` : ''}
    <div class="section"><div class="label">Family</div><div class="chips">${fam || '<span class="hint">no known family</span>'}</div></div>
    <div class="section"><div class="label">Relationships</div>${relationshipWeb(m)}</div>
    ${m.memories.length ? `<div class="section"><div class="label">Remembers</div>${m.memories.slice(-8).reverse().map((x) => `<div class="mem">${escapeHtml(x)}</div>`).join('')}</div>` : ''}
  `;
}

/** Radial relationship web: closeness = familiarity-ish, color = affinity, ring = deference. */
function relationshipWeb(m: InspectMsg): string {
  const rels = m.relations.slice(0, 14);
  if (rels.length === 0) return '<p class="hint">knows no one yet</p>';
  const W = 300;
  const H = 230;
  const cx = W / 2;
  const cy = H / 2;
  const nodes = rels.map((r, k) => {
    const a = (k / rels.length) * Math.PI * 2 - Math.PI / 2;
    const strength = Math.min(1, Math.abs(r.aff) + r.def + r.grudge);
    const rad = 95 - strength * 45;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad * 0.85;
    const col = r.grudge > 0.15 || r.aff < -0.2 ? '#e0624d' : r.aff > 0.3 ? '#7fd36b' : '#9aa3a8';
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${col}" stroke-width="${1 + strength * 3}" opacity=".7"/>
      <circle cx="${x}" cy="${y}" r="${5 + r.def * 10}" fill="${clanColor(r.clan)}" stroke="#0e1420" data-person="${r.id}" style="cursor:pointer"/>
      <text x="${x}" y="${y - 9 - r.def * 10}" fill="#ebe4d3" font-size="10" text-anchor="middle">${escapeHtml(r.name)}</text>
      <text x="${x}" y="${y + 17 + r.def * 8}" fill="#9aa3a8" font-size="9" text-anchor="middle">${r.label}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Relationship web">${nodes}
    <circle cx="${cx}" cy="${cy}" r="8" fill="#d9a441"/></svg>
    <p class="hint">Line color: liking (green) or grudge (red). Node size: deference. Nearer = stronger tie.</p>`;
}

function renderClan(m: ClanInspectMsg): void {
  if (m.id !== selectedClan) return;
  $('clan-inspector').hidden = false;
  $('hint').hidden = true;
  $('clan-name').innerHTML = `<span class="dot" style="background:${clanColor(m.id)}"></span> ${escapeHtml(m.lines[0] ?? '')}`;
  $('clan-body').innerHTML = `
    ${m.lines.slice(1).map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
    <div class="section"><div class="label">Culture (clan means)</div>
      ${m.culture.map((c) => `<div class="culture-row"><span>${c.name}</span><span class="track"><span class="fill" style="width:${Math.round(c.value * 100)}%"></span></span><span class="num">${c.value.toFixed(2)}</span></div>`).join('')}
    </div>
    <div class="section"><div class="label">Body paint in use</div><div class="chips">${m.markers.slice(0, 8).map(([mk, n]) => `<span class="chip"><span class="dot" style="background:${PAINT[Math.floor(mk / 4) % 8]}"></span> #${mk} · ${n}</span>`).join('')}</div></div>
    <div class="section"><div class="label">History</div>${m.history.map((h) => `<div class="mem">${escapeHtml(h)}</div>`).join('')}</div>
  `;
}

function select(id: number): void {
  selected = id;
  view.selectedId = id;
  selectedClan = -1;
  $('clan-inspector').hidden = true;
  if (id >= 0) send({ type: 'inspect', id });
  else {
    $('inspector').hidden = true;
    $('bubble').hidden = true;
  }
}

function selectClan(id: number): void {
  selectedClan = id;
  selected = -1;
  $('inspector').hidden = true;
  send({ type: 'inspectClan', id });
  const c = cur?.clans.find((x) => x.id === id);
  if (c) view.focusOn(c.x, c.y);
}

function setMode(mode: 'world' | 'clan' | 'follow'): void {
  view.mode = mode;
  view.followId = mode === 'follow' ? selected : -1;
  view.setTerritory(mode === 'clan');
  view.setRelations(mode === 'clan');
  for (const [id, m] of [['view-world', 'world'], ['view-clan', 'clan'], ['view-follow', 'follow']] as const) $(id).classList.toggle('active', m === mode);
  if (mode === 'follow' && selected >= 0) view.camera.zoom = Math.max(view.camera.zoom, 4);
  view.camera.updateProjectionMatrix();
}

function renderLegend(): void {
  $('legend').innerHTML = view.chronicle
    ? '<span>dots = people, colored by clan</span>'
    : GOAL_LABELS.map((l, k) => `<span><i class="dot" style="background:${GOAL_COLORS[k]}"></i>${l}</span>`).join('') + '<span>(dot colors at world zoom; clothing = clan)</span>';
}

// --- Controls ---
const speedsEl = $('speeds');
for (const [label, dps] of SPEEDS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = dps === 0 ? 'Pause' : dps === Infinity ? 'As fast as possible' : `${label} speed`;
  b.onclick = () => {
    daysPerSecond = dps;
    view.daysPerSecond = dps;
    view.chronicle = dps > CHRONICLE_ABOVE;
    $('chronicle-overlay').hidden = !view.chronicle;
    renderLegend();
    send({ type: 'speed', daysPerSecond: dps });
    for (const el of speedsEl.children) el.classList.toggle('active', el === b);
  };
  if (dps === 0) b.classList.add('active');
  speedsEl.appendChild(b);
}
$('view-world').onclick = () => setMode('world');
$('view-clan').onclick = () => setMode('clan');
$('view-follow').onclick = () => setMode('follow');
$('restart').onclick = () => void start(Number($<HTMLInputElement>('seed').value) || 1);
$('insp-close').onclick = () => select(-1);
$('clan-close').onclick = () => {
  selectedClan = -1;
  $('clan-inspector').hidden = true;
};
$('clan-list').addEventListener('click', (ev) => {
  const row = (ev.target as HTMLElement).closest('[data-clan]') as HTMLElement | null;
  if (row) selectClan(Number(row.dataset.clan));
});
$('drawer').addEventListener('click', (ev) => {
  const p = (ev.target as Element).closest('[data-person]') as HTMLElement | SVGElement | null;
  if (p) select(Number((p as HTMLElement).dataset.person));
});
$<HTMLInputElement>('scrub').addEventListener('change', (ev) => {
  const year = Math.floor(Number((ev.target as HTMLInputElement).value) / 10) * 10;
  send({ type: 'scrub', year });
});
let downAt = { x: 0, y: 0 };
view.renderer.domElement.addEventListener('pointerdown', (ev) => (downAt = { x: ev.clientX, y: ev.clientY }));
view.renderer.domElement.addEventListener('pointerup', (ev) => {
  if (Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 5) return; // a drag, not a click
  const camp = view.pickCamp(ev.clientX, ev.clientY);
  const id = view.pick(ev.clientX, ev.clientY);
  if (id >= 0) {
    select(id);
    if (view.mode === 'follow') view.followId = id;
  } else if (camp >= 0) selectClan(camp);
});

function animate(): void {
  view.frame();
  const bubble = $('bubble');
  if (view.followScreen && lastInspect && lastInspect.id === selected && lastInspect.alive) {
    bubble.hidden = false;
    bubble.style.left = `${view.followScreen.x}px`;
    bubble.style.top = `${view.followScreen.y - 8}px`;
    bubble.innerHTML = `<div class="who">${escapeHtml(lastInspect.name)} — ${escapeHtml(lastInspect.goal)}</div>`
      + lastInspect.why.map((w) => `<div>${w.value >= 0 ? '+' : '−'} ${escapeHtml(w.label)}</div>`).join('');
  } else {
    bubble.hidden = true;
  }
  requestAnimationFrame(animate);
}

renderLegend();
void start(1);
requestAnimationFrame(animate);
