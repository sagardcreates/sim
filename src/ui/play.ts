/**
 * Play mode UI: you are one person in the living world. Your avatar moves
 * client-side (responsive) and reports its position to the sim; everything
 * you do is sent as an action that the worker resolves against what you
 * were looking at (proximity, witnesses) and applies through the sim's own
 * mechanisms. The UI never touches sim state.
 */
import { MOUSE } from 'three';
import cfgJson from '../../configs/default.json';
import { clanColor } from '../render/palette';
import { G_NONE, G_OFFER } from '../render/humans';
import { TerrariumView } from '../render/view';
import { MOTIVE_ICONS, MOTIVE_SHORT } from '../sim/play/motive-codes';
import { ANIMALS, huntChance } from '../sim/play/animals';
import type { HelpVerb } from '../sim/play/player';
import {
  A_AGE, A_CLAN, ATTR_STRIDE,
  type ActResultMsg, type DayMsg, type FromWorker, type PersonMsg, type PlayView, type ToWorker, type UiAction, type WorldMsg,
} from '../worker/protocol';

interface SimChannel {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<FromWorker>) => void) | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SPEEDS: [string, number][] = [['❚❚', 0], ['1×', 1 / 30], ['2×', 1 / 15], ['4×', 1 / 7.5]];
/** Walking speed in tiles per second on open ground. */
const WALK = 3.4;
const LABEL_RANGE = 13;
/** Motives shown floating over heads: the ones the player can do something about, and leaders. */
const FLOATING = new Set([1, 2, 3, 4, 5, 6, 7, 9, 11]);
const MAX_LABELS = 14;

const view = new TerrariumView($('canvas-host'));
view.controls.enablePan = false;
view.controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE } as unknown as typeof view.controls.mouseButtons;
let worker: SimChannel | undefined;
let world: WorldMsg | undefined;
let day: DayMsg | undefined;
let play: PlayView | undefined;
let index = new Map<number, number>();
let speed = SPEEDS[1][1];
let selected = -1;
/** Selected animal (tile, k) and its kind, or null. */
let beast: { tile: number; k: number; kind: number } | null = null;
let approachBeast = false;
let person: PersonMsg | undefined;
let lastPersonAsk = 0;
let female = true;
let wasLargest = false;
const me = {
  x: 0, y: 0, heading: 0, anim: 0, gesture: G_NONE, gestureUntil: 0,
  /** Final destination and the waypoints (A*) that lead there. */
  target: null as { x: number; y: number } | null,
  path: [] as { x: number; y: number }[],
  approach: -1, approachPathAt: 0, lastSent: 0, dirty: false,
};
const keys = new Set<string>();

// ------------------------------------------------------------------ start / loading

function send(msg: ToWorker): void {
  worker?.postMessage(msg);
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

async function begin(): Promise<void> {
  const name = ($<HTMLInputElement>('in-name').value.trim() || 'Ashka').slice(0, 16);
  const seed = Math.max(1, Number($<HTMLInputElement>('in-seed').value) || 1);
  $('start').hidden = true;
  $('loading').hidden = false;
  try {
    const w = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
    worker = w as unknown as SimChannel;
    w.addEventListener('error', async () => {
      if (play) return;
      worker = await mainThreadChannel();
      wire(name, seed);
    });
  } catch {
    worker = await mainThreadChannel();
  }
  wire(name, seed);
}

function wire(name: string, seed: number): void {
  if (!worker) return;
  worker.onmessage = (ev) => onMessage(ev.data);
  send({ type: 'play', seed, name, female });
}

function onMessage(m: FromWorker): void {
  if (m.type === 'loading') {
    $('load-fill').style.width = `${(100 * m.year) / m.total}%`;
    $('load-year').textContent = `Year ${Math.floor(m.year)} of ${m.total}: the clans live their lives…`;
    const ol = $('load-lines');
    for (const l of m.lines.slice(-6)) {
      const li = document.createElement('li');
      li.textContent = l;
      ol.prepend(li);
    }
    while (ol.children.length > 14) ol.lastElementChild!.remove();
  } else if (m.type === 'world') {
    world = m;
    view.setWorld(m);
  } else if (m.type === 'day') {
    onDay(m);
  } else if (m.type === 'playState') {
    setPlay(m.play);
    if (!arrived) arrive();
  } else if (m.type === 'actResult') {
    onResult(m);
  } else if (m.type === 'person') {
    if (m.id === selected) {
      person = m;
      renderCard();
    }
  }
}

let arrived = false;
function arrive(): void {
  if (!play || !world) return;
  arrived = true;
  $('loading').hidden = true;
  me.x = play.x;
  me.y = play.y;
  view.player = { id: play.playerId, x: me.x, y: me.y, heading: 0, speed: 0, gesture: G_NONE };
  view.setPlayerRings(play.interactRadius, play.witnessRadius, clanColor(play.clanId));
  view.animalTileRate = play.animalTileRate;
  view.mode = 'follow';
  view.followId = play.playerId;
  view.focusOn(me.x, me.y);
  view.camera.zoom = 4.5;
  view.camera.updateProjectionMatrix();
  setSpeed(SPEEDS[1][1]);
  toast(`You arrive alone and make camp. You found ${play.clanLabel}.`, 'good');
  toast('Watch the icons over people’s heads. Click someone to learn what they want; call out 📣 and they will wait for you.', '');
  toast('Click an animal to hunt. Start with hares 🐇; your skill grows with every hunt.', '');
  try {
    if (!localStorage.getItem('terrarium-howto')) {
      $('howto').hidden = false;
      localStorage.setItem('terrarium-howto', '1');
    }
  } catch {
    /* storage unavailable: skip the one-time help */
  }
}

// ------------------------------------------------------------------ sim updates

function onDay(d: DayMsg): void {
  day = d;
  index = new Map();
  for (let i = 0; i < d.ids.length; i++) index.set(d.ids[i], i);
  view.onDay(d);
  const season = ['spring', 'summer', 'autumn', 'winter'][Math.floor(d.dayOfYear / 91.25) % 4];
  $('date').textContent = `Year ${d.year} · ${season} · day ${d.dayOfYear}${d.climate.droughtActive ? ' · drought' : ''}${d.climate.epidemicActive ? ' · fever' : ''}`;
  for (const e of d.events) {
    if (e.type.startsWith('toast') && e.text) toast(e.text, e.type === 'toast-good' ? 'good' : e.type === 'toast-bad' ? 'bad' : '');
  }
  if (d.play) {
    setPlay(d.play);
    if (!arrived) arrive();
  }
  if (selected >= 0 && performance.now() - lastPersonAsk > 600) askPerson();
}

function setPlay(p: PlayView): void {
  const prev = play;
  play = p;
  $('me').textContent = p.name;
  $('stat-clan').innerHTML = `<span style="color:${clanColor(p.clanId)}">■</span> ${esc(p.clanLabel)} · <b>${p.members}</b> people`;
  $('stat-rank').textContent = p.rank === 1 ? `Largest of ${p.clanCount} clans` : `#${p.rank} of ${p.clanCount} · largest ${p.largest.size}`;
  $('stat-food').textContent = `🍖 ${p.carried.toFixed(0)} · camp ${p.store.toFixed(0)}`;
  $('food-fill').style.width = `${(100 * p.carried) / p.carryCapacity}%`;
  $('stat-body').innerHTML = `${p.hunger > 0.5 ? '😫 starving' : p.hunger > 0.15 ? '😐 hungry' : '🙂 fed'} · ❤️ ${Math.round(100 * p.health)}%`;
  $('stat-body').className = p.hunger > 0.5 || p.health < 0.5 ? 'warn-text' : '';
  $('stat-skills').textContent = `🏹 ${Math.round(100 * p.skills.hunt)} · 🌿 ${Math.round(100 * p.skills.gather)} · 🪓 ${Math.round(100 * p.skills.wood)} · 🪵 ${p.wood.toFixed(0)}`;
  $('btn-wood').innerHTML = `<kbd>C</kbd> Cut wood (${p.woodLeft})`;
  ($('btn-wood') as HTMLButtonElement).disabled = p.woodLeft <= 0;
  $('btn-gather').innerHTML = `<kbd>G</kbd> Gather (${p.gathersLeft})`;
  ($('btn-gather') as HTMLButtonElement).disabled = p.gathersLeft <= 0;
  $('suspicion').innerHTML = p.suspicion
    .filter((s) => s.value > 0.005 || p.suspicion.length <= 6)
    .sort((a, b) => b.value - a.value)
    .map((s) => `<div class="susp ${s.value >= 0.7 ? 'hot' : ''}" title="${esc(s.label)}: ${Math.round(100 * s.value)}%">
        <span class="sw" style="background:${clanColor(s.clan)}"></span><span>${esc(s.label.replace(/^Clan \d+ · /, ''))}</span>
        <span class="track"><span class="fill" style="width:${Math.min(100, 100 * s.value)}%"></span></span></div>`)
    .join('') || '<div class="small">No clan suspects you.</div>';
  if (prev) {
    for (const s of p.suspicion) {
      const before = prev.suspicion.find((x) => x.clan === s.clan)?.value ?? 0;
      if (before < 0.7 && s.value >= 0.7 && s.value < 1) toast(`${s.label} is watching you closely. Lie low, or they will strike.`, 'warn');
      if (before < 1 && s.value >= 1) toast(`${s.label} is furious. They will come for your people tonight!`, 'bad');
    }
  }
  if (p.rank === 1 && p.clanCount > 1 && !wasLargest) {
    wasLargest = true;
    toast(`Your clan is now the largest in the valley (${p.members} people).`, 'good');
  } else if (p.rank !== 1) {
    wasLargest = false;
  }
  if (!$('clanpanel').hidden) renderClanPanel();
}

function onResult(m: ActResultMsg): void {
  if (m.text) toast(m.text, m.ok ? '' : 'bad');
  for (const s of m.seenBy) {
    toast(`${s.witnesses > 1 ? `${s.witnesses} of ${s.label} saw you` : `${s.label} noticed`} (+${Math.round(100 * s.amount)}% suspicion).`, 'warn');
  }
  askPerson();
}

// ------------------------------------------------------------------ actions

function act(action: UiAction): void {
  sendPos(true);
  send({ type: 'act', action, subStep: view.shownSubStep() });
  if (action.kind === 'help' || action.kind === 'invite') {
    me.gesture = G_OFFER;
    me.gestureUntil = performance.now() + 1200;
  }
}

function askPerson(): void {
  if (selected < 0) return;
  lastPersonAsk = performance.now();
  send({ type: 'person', id: selected });
}

function select(id: number): void {
  if (!play || id === play.playerId) return;
  selected = id;
  view.selectedId = id;
  person = undefined;
  beast = null;
  approachBeast = false;
  $('clanpanel').hidden = true;
  $('card').hidden = false;
  $('card-name').textContent = '…';
  $('card-body').innerHTML = '';
  lastCardHtml = '';
  askPerson();
}

function startApproach(id: number): void {
  me.approach = id;
  me.approachPathAt = 0;
}

function deselect(): void {
  beast = null;
  approachBeast = false;
  selected = -1;
  view.selectedId = -1;
  person = undefined;
  me.approach = -1;
  $('card').hidden = true;
}

const VERB_LABEL: Record<HelpVerb, string> = { talk: '💬 Talk', give: '🍖 Give food', tend: '🩹 Tend', back: '🗡️ Back their grudge' };
const VERB_HINT: Record<HelpVerb, string> = {
  talk: 'Spend time together. Small, but it adds up.',
  give: 'Give some of the food you carry. Worth most to the hungry.',
  tend: 'Treat their wound or sickness.',
  back: 'Promise to stand with them. Their enemy will hate you for it.',
};

function renderCard(): void {
  const p = person;
  if (!p || !play) return;
  $('card-name').textContent = `${p.isLeader ? '👑 ' : ''}${p.name}`;
  if (!p.alive) {
    lastCardHtml = '';
    $('card-body').innerHTML = '<p class="sub">Dead.</p>';
    return;
  }
  const feel = p.feeling;
  const feelCls = feel.grudge > 0.3 || feel.aff < -0.1 ? 'bad' : feel.aff > 0.3 ? 'good' : '';
  const help = new Set(p.help);
  const verbs: HelpVerb[] = ['talk', 'give', 'tend', 'back'];
  const buttons = verbs.map((v) => `<button data-verb="${v}" data-able="${help.has(v) ? 1 : 0}" title="${VERB_HINT[v]}" disabled>${VERB_LABEL[v]}</button>`).join('');
  let invite = '';
  if (p.inYourClan) invite = '<p class="feel good">One of your people.</p>';
  else if (p.invite) {
    const pct = Math.round(100 * p.invite.p);
    invite = `<button class="wide ${pct < 20 ? 'danger' : ''}" data-invite data-able="1" disabled>🤝 Invite to your clan (${pct}% chance)</button>
      <div class="odds wide"><div class="label">What they weigh</div>${p.invite.parts.map((x) => `<div class="part"><span>${esc(x.label)}</span><span>${x.value >= 0 ? '+' : ''}${x.value.toFixed(2)}</span></div>`).join('')}</div>`;
  }
  const html = `
    <div class="sub">${p.female ? 'Woman' : 'Man'}, ${p.age} · <span style="color:${p.clan >= 0 ? clanColor(p.clan) : 'inherit'}">${esc(p.clanLabel)}</span>${p.partner ? ` · partner ${esc(p.partner)}` : ''}${p.children ? ` · ${p.children} children` : ''}</div>
    <div class="doing">Now: <b>${esc(p.doing)}</b>${p.why.length ? `<div class="why">because: ${p.why.map(esc).join(', ')}</div>` : ''}</div>
    ${p.motives.length ? `<ul class="motives">${p.motives.map((mo) => `<li>${MOTIVE_ICONS[mo.code]} ${esc(p.name.split(' ')[0])} ${esc(mo.text)}</li>`).join('')}</ul>` : '<p class="sub">Nothing troubles them right now.</p>'}
    <div class="feel ${feelCls}">${esc(p.name.split(' ')[0])} ${esc(feel.text)}.</div>
    <div class="actions"><button class="wide" data-hail disabled title="Call out so they stop and wait for you">📣 Call out to ${esc(p.name.split(' ')[0])}</button>${buttons}${invite}</div>
    <div class="reach"><span class="reach-text"></span> <button data-approach hidden>Walk to them</button></div>`;
  if (html !== lastCardHtml) {
    lastCardHtml = html;
    $('card-body').innerHTML = html;
  }
  updateReach();
}

function selectBeast(spot: { tile: number; k: number; kind: number }): void {
  deselect();
  beast = { tile: spot.tile, k: spot.k, kind: spot.kind };
  $('clanpanel').hidden = true;
  $('card').hidden = false;
  const a = ANIMALS[spot.kind];
  $('card-name').textContent = `${a.icon} ${a.name[0].toUpperCase()}${a.name.slice(1)}`;
  lastCardHtml = '';
  $('card-body').innerHTML = `<div class="beast"></div>
    <div class="actions"><button class="wide" data-hunt disabled>🏹 Hunt it</button></div>
    <div class="reach"><span class="reach-text"></span> <button data-approach-beast hidden>Walk to it</button></div>`;
  updateBeast();
}

function updateBeast(): void {
  if (!beast || !play) return;
  const a = ANIMALS[beast.kind];
  const pos = view.animalAt(beast.tile, beast.k);
  const body = $('card-body');
  const info = body.querySelector('.beast');
  if (!pos) {
    if (info) info.innerHTML = '<p class="sub">It is gone.</p>';
    body.querySelector<HTMLButtonElement>('button[data-hunt]')!.disabled = true;
    body.querySelector<HTMLButtonElement>('button[data-approach-beast]')!.hidden = true;
    return;
  }
  const skill = play.skills.hunt;
  const chance = huntChance(a, skill) * (1 - 0.5 * play.hunger);
  const danger = a.risk === 0 ? 'harmless' : a.risk < 0.1 ? 'can kick' : a.risk < 0.25 ? 'dangerous' : 'very dangerous';
  const html = `<div class="sub">${a.food} food · ${danger} · needs hunting skill ${Math.round(100 * a.req)} (yours ${Math.round(100 * skill)})</div>
    <div class="odds"><b>${Math.round(100 * chance)}%</b> chance to bring it down${play.hunger > 0.15 ? ' (hunger weakens you)' : ''}. ${play.huntsLeft} hunts left today.</div>`;
  if (info && info.innerHTML !== html) info.innerHTML = html;
  const dist = Math.hypot(pos.x - me.x, pos.y - me.y);
  const inRange = dist <= play.huntRange - 0.4;
  body.querySelector<HTMLButtonElement>('button[data-hunt]')!.disabled = !inRange || play.huntsLeft <= 0;
  const txt = body.querySelector('.reach-text');
  if (txt) txt.textContent = inRange ? 'Within reach.' : `${Math.ceil(dist)} steps away.`;
  body.querySelector<HTMLButtonElement>('button[data-approach-beast]')!.hidden = inRange || approachBeast;
}

/** Cheap per-frame card update: distance and which buttons are usable (no re-render, so clicks land). */
function updateReach(): void {
  if (!person || !play || !person.alive) return;
  const pos = view.positionOf(person.id);
  const dist = pos ? Math.hypot(pos.x - me.x, pos.y - me.y) : Infinity;
  const inReach = dist <= play.interactRadius;
  const body = $('card-body');
  for (const b of body.querySelectorAll<HTMLButtonElement>('button[data-able]')) b.disabled = b.dataset.able !== '1' || !inReach;
  const hailB = body.querySelector<HTMLButtonElement>('button[data-hail]');
  if (hailB) hailB.disabled = dist > play.hailRadius || play.night;
  const txt = body.querySelector('.reach-text');
  if (txt) txt.textContent = inReach ? 'Within reach.' : `${Number.isFinite(dist) ? Math.ceil(dist) : '?'} steps away.`;
  const walk = body.querySelector<HTMLButtonElement>('button[data-approach]');
  if (walk) walk.hidden = inReach || me.approach === person.id;
}
let lastCardHtml = '';

$('card-body').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (b && beast) {
    if (b.hasAttribute('data-hunt')) {
      act({ kind: 'hunt', tile: beast.tile, k: beast.k });
      me.gesture = G_OFFER;
      me.gestureUntil = performance.now() + 900;
    } else if (b.hasAttribute('data-approach-beast')) approachBeast = true;
    return;
  }
  if (!b || selected < 0) return;
  if (b.hasAttribute('data-hail')) act({ kind: 'hail', target: selected });
  else if (b.dataset.verb) act({ kind: 'help', verb: b.dataset.verb as HelpVerb, target: selected });
  else if (b.hasAttribute('data-invite')) act({ kind: 'invite', target: selected });
  else if (b.hasAttribute('data-approach')) startApproach(selected);
});
$('card-close').addEventListener('click', deselect);

function renderClanPanel(): void {
  if (!play) return;
  const p = play;
  const planned = p.raidPlanned >= 0 ? p.raids.find((r) => r.clan === p.raidPlanned)?.label : '';
  const html = `
    <p class="sub">${esc(p.clanLabel)}: ${p.members} people, ${p.adults} grown. Camp store ${p.store.toFixed(0)} food.
      ${p.caught ? `Caught ${p.caught}×. ` : ''}${p.raidsWon + p.raidsLost ? `Raids: ${p.raidsWon} won, ${p.raidsLost} lost.` : ''}</p>
    ${planned ? `<p class="feel bad">Your people raid ${esc(planned)} tonight.</p>` : ''}
    <div class="label">Your camp</div>
    <p class="sub">🛖 ${p.shelters} of ${p.maxShelters} shelters · 🪵 ${p.campWood.toFixed(0)} wood at camp (+${p.wood.toFixed(0)} in hand). Each shelter makes your camp more tempting to join.</p>
    <button data-build ${p.campWood >= p.shelterWood && p.shelters < p.maxShelters ? '' : 'disabled'}>🛖 Build a shelter (${p.shelterWood} wood)</button>
    <div class="label" style="margin-top:10px">Raid a camp</div>
    ${p.raids.sort((a, b) => b.odds - a.odds).map((r) => `<div class="raid-row">
      <span class="sw" style="background:${clanColor(r.clan)}"></span>
      <span>${esc(r.label)} · ${r.size} people</span>
      <button data-raid="${r.clan}" ${r.ok ? '' : 'disabled'} title="Win chance ${Math.round(100 * r.odds)}%">Raid (${Math.round(100 * r.odds)}%)</button>
      ${r.ok ? '' : `<span class="why">${esc(r.reason)}</span>`}
    </div>`).join('')}
    <p class="small">A raid happens at night: win and you take much of their store; win or lose, blood is spilled, and blood is remembered.</p>`;
  if (html !== lastClanHtml) {
    lastClanHtml = html;
    $('clan-body').innerHTML = html;
  }
}

let lastClanHtml = '';
$('clan-body').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (b?.hasAttribute('data-build')) act({ kind: 'build' });
  if (b?.dataset.raid) act({ kind: 'raid', clan: Number(b.dataset.raid) });
});

function toggleClanPanel(): void {
  const panel = $('clanpanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    $('card').hidden = true;
    renderClanPanel();
  }
}
$('clan-close').addEventListener('click', () => ($('clanpanel').hidden = true));

// ------------------------------------------------------------------ movement

const biomeCost = [cfgJson.world.biomes.grassland.movementCost, cfgJson.world.biomes.forest.movementCost, cfgJson.world.biomes.hills.movementCost,
  cfgJson.world.biomes.scrub.movementCost, 99];

/** Walking cost of the ground at (x, y); Infinity where you cannot go. */
function groundCost(x: number, y: number): number {
  if (!world) return Infinity;
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return Infinity;
  const t = Math.floor(y) * world.width + Math.floor(x);
  if (world.river[t] === 2 || world.biome[t] === 4) return Infinity;
  return world.river[t] ? cfgJson.world.riverMovementCost * 0.6 : biomeCost[world.biome[t]];
}

function step(dt: number): void {
  let dx = 0;
  let dy = 0;
  if (keys.size) {
    let fx = 0;
    let fz = 0;
    if (keys.has('w') || keys.has('arrowup')) fz -= 1;
    if (keys.has('s') || keys.has('arrowdown')) fz += 1;
    if (keys.has('a') || keys.has('arrowleft')) fx -= 1;
    if (keys.has('d') || keys.has('arrowright')) fx += 1;
    if (fx || fz) {
      const az = view.azimuth();
      // Screen-relative: "up" moves away from the camera.
      dx = fx * Math.cos(az) + fz * Math.sin(az);
      dy = -fx * Math.sin(az) + fz * Math.cos(az);
      walkTo(null);
      approachBeast = false;
    }
  }
  if (!dx && !dy && approachBeast && beast && play) {
    const pos = view.animalAt(beast.tile, beast.k);
    if (!pos) approachBeast = false;
    else if (Math.hypot(pos.x - me.x, pos.y - me.y) <= play.huntRange - 0.8) {
      walkTo(null);
      approachBeast = false;
    } else if (performance.now() - me.approachPathAt > 700) {
      me.approachPathAt = performance.now();
      walkTo(pos);
    }
  }
  if (!dx && !dy && me.approach >= 0 && play) {
    const pos = view.positionOf(me.approach);
    if (!pos) me.approach = -1;
    else if (Math.hypot(pos.x - me.x, pos.y - me.y) <= play.interactRadius * 0.7) {
      walkTo(null);
      me.approach = -1;
      updateReach();
    } else if (performance.now() - me.approachPathAt > 700) {
      // They move: re-plan now and then.
      me.approachPathAt = performance.now();
      const keep = me.approach;
      walkTo(pos);
      me.approach = keep;
    }
  }
  if (!dx && !dy && me.target) {
    const wp = me.path[0] ?? me.target;
    dx = wp.x - me.x;
    dy = wp.y - me.y;
    if (Math.hypot(dx, dy) < 0.2) {
      if (me.path.length) me.path.shift();
      else walkTo(null);
      dx = dy = 0;
    }
  }
  const len = Math.hypot(dx, dy);
  let moving = false;
  if (len > 0) {
    const cost = groundCost(me.x, me.y);
    const body = play ? (1 - 0.45 * play.hunger) * (0.6 + 0.4 * play.health) : 1;
    const v = ((WALK * body) / (Number.isFinite(cost) ? cost : 1)) * dt;
    const sx = (dx / len) * Math.min(v, me.target ? len : v);
    const sy = (dy / len) * Math.min(v, me.target ? len : v);
    // Slide along obstacles.
    if (Number.isFinite(groundCost(me.x + sx, me.y + sy))) {
      me.x += sx;
      me.y += sy;
      moving = true;
    } else if (Number.isFinite(groundCost(me.x + sx, me.y))) {
      me.x += sx;
      moving = true;
    } else if (Number.isFinite(groundCost(me.x, me.y + sy))) {
      me.y += sy;
      moving = true;
    } else {
      me.target = null;
    }
    if (moving) {
      me.heading = Math.atan2(dx, dy);
      me.dirty = true;
    }
  }
  me.anim += ((moving ? 1 : 0) - me.anim) * Math.min(1, dt * 8);
  if (view.player) {
    view.player.x = me.x;
    view.player.y = me.y;
    view.player.heading = me.heading;
    view.player.speed = me.anim;
    view.player.gesture = performance.now() < me.gestureUntil ? me.gesture : G_NONE;
  }
  sendPos(false);
}

/** Sets a destination and plans a path around water (A* on the tile grid); null stops. */
function walkTo(dest: { x: number; y: number } | null): void {
  me.approach = -1;
  me.target = dest;
  me.path = dest ? findPath(me.x, me.y, dest.x, dest.y) : [];
  if (dest && me.path.length === 0 && Math.hypot(dest.x - me.x, dest.y - me.y) > 1.5) me.target = null; // unreachable
}

function findPath(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  if (!world) return [];
  const W = world.width;
  const H = world.height;
  const start = Math.floor(y0) * W + Math.floor(x0);
  let goal = Math.floor(y1) * W + Math.floor(x1);
  const passable = (t: number) => Number.isFinite(groundCost((t % W) + 0.5, Math.floor(t / W) + 0.5));
  if (!passable(goal)) {
    // Nearest passable tile to the clicked one.
    let best = -1;
    let bd = Infinity;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = Math.floor(x1) + dx;
      const y = Math.floor(y1) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const t = y * W + x;
      if (passable(t) && Math.hypot(dx, dy) < bd) [bd, best] = [Math.hypot(dx, dy), t];
    }
    if (best < 0) return [];
    goal = best;
  }
  if (start === goal) return [{ x: x1, y: y1 }];
  const g = new Float64Array(W * H).fill(Infinity);
  const from = new Int32Array(W * H).fill(-1);
  const heap: [number, number][] = [];
  const push = (f: number, t: number) => {
    heap.push([f, t]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const gx = goal % W;
  const gy = Math.floor(goal / W);
  const h = (t: number) => Math.hypot((t % W) - gx, Math.floor(t / W) - gy);
  g[start] = 0;
  push(h(start), start);
  let expanded = 0;
  while (heap.length && expanded < 20000) {
    const [, t] = pop();
    if (t === goal) break;
    expanded++;
    const tx = t % W;
    const ty = Math.floor(t / W);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      const c = groundCost(nx + 0.5, ny + 0.5);
      if (!Number.isFinite(c)) continue;
      // No corner cutting past water.
      if (dx && dy && (!passable(ty * W + nx) || !passable(ny * W + tx))) continue;
      const ng = g[t] + c * (dx && dy ? Math.SQRT2 : 1);
      if (ng < g[n]) {
        g[n] = ng;
        from[n] = t;
        push(ng + h(n), n);
      }
    }
  }
  if (from[goal] < 0) return [];
  const tiles: number[] = [];
  for (let t = goal; t !== start && t >= 0; t = from[t]) tiles.push(t);
  tiles.reverse();
  const pts = tiles.map((t) => ({ x: (t % W) + 0.5, y: Math.floor(t / W) + 0.5 }));
  pts[pts.length - 1] = { x: x1, y: y1 };
  if (!Number.isFinite(groundCost(x1, y1))) pts[pts.length - 1] = { x: (goal % W) + 0.5, y: Math.floor(goal / W) + 0.5 };
  // Drop waypoints that a straight walk can skip.
  const clear = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    for (let k = 1; k < L * 3; k++) {
      const f = k / (L * 3);
      if (!Number.isFinite(groundCost(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f))) return false;
    }
    return true;
  };
  const out: { x: number; y: number }[] = [];
  let from0 = { x: x0, y: y0 };
  for (let i = 0; i < pts.length; i++) {
    if (i === pts.length - 1 || !clear(from0, pts[i + 1])) {
      out.push(pts[i]);
      from0 = pts[i];
    }
  }
  return out;
}

function sendPos(force: boolean): void {
  const now = performance.now();
  if (!me.dirty || (!force && now - me.lastSent < 200)) return;
  me.lastSent = now;
  me.dirty = false;
  send({ type: 'pos', x: me.x, y: me.y });
}

// ------------------------------------------------------------------ labels, watchers

const labelPool: HTMLDivElement[] = [];

function renderLabels(): void {
  const host = $('labels');
  const d = day;
  const shown = d && play ? view.nearby(me.x, me.y, LABEL_RANGE).filter((n) => n.id !== play!.playerId) : [];
  let k = 0;
  let watchers = 0;
  const placed: { x: number; y: number }[] = [];
  const byClan = new Map<number, number>();
  for (const n of shown) {
    const i = index.get(n.id);
    if (i === undefined || !d) continue;
    const clan = d.attrs[i * ATTR_STRIDE + A_CLAN];
    const age = d.attrs[i * ATTR_STRIDE + A_AGE];
    if (n.dist <= play!.witnessRadius && clan !== play!.clanId && clan >= 0 && age >= 12) {
      watchers++;
      byClan.set(clan, (byClan.get(clan) ?? 0) + 1);
    }
    if (k >= MAX_LABELS) continue;
    const raw = d.motives?.[i] ?? 0;
    // Floating tags only for what you can act on (and leaders); the card has the rest.
    const code = FLOATING.has(raw) ? raw : 0;
    const mine = clan === play!.clanId;
    const isSel = n.id === selected;
    if (!code && !mine && !isSel) continue;
    // Skip tags that would sit on top of one already placed.
    if (!isSel && placed.some((q) => Math.abs(q.x - n.sx) < 70 && Math.abs(q.y - n.sy) < 17)) continue;
    placed.push({ x: n.sx, y: n.sy });
    const fr = d.friendly?.[i] ?? 0;
    let el = labelPool[k];
    if (!el) {
      el = document.createElement('div');
      labelPool.push(el);
      host.appendChild(el);
    }
    el.className = `tag${mine ? ' mine' : fr > 0.3 ? ' friend' : fr < -0.1 ? ' foe' : ''}${code === 9 ? ' leader' : ''}`;
    el.style.left = `${n.sx}px`;
    el.style.top = `${n.sy}px`;
    el.style.display = '';
    const name = isSel ? `<b>${esc(d.names[i] ?? '')}</b> ` : '';
    el.innerHTML = code ? `${name}<span class="ic">${MOTIVE_ICONS[code]}</span>${MOTIVE_SHORT[code]}` : isSel ? name : '<span class="ic">•</span>yours';
    k++;
  }
  for (; k < labelPool.length; k++) labelPool[k].style.display = 'none';
  renderCampMarkers();
  const w = $('watchers');
  if (!play) return;
  if (watchers === 0) {
    w.textContent = 'No outsiders can see you.';
    w.className = '';
  } else {
    const names = [...byClan.entries()].map(([cl, n]) => `${n} of ${play!.suspicion.find((s) => s.clan === cl)?.label.replace(/^Clan \d+ · /, '') ?? 'a clan'}`);
    w.textContent = `Watched by ${names.join(', ')}.`;
    w.className = 'seen';
  }
}

const campPool: HTMLDivElement[] = [];

/** Clan camps: a banner over each; off-screen ones sit at the edge, pointing the way. */
function renderCampMarkers(): void {
  const host = $('labels');
  const d = day;
  let k = 0;
  if (d && play) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    for (const c of d.clans) {
      if (c.size <= 0) continue;
      const p = view.toScreen(c.x, c.y, 2.2);
      const dist = Math.hypot(c.x - me.x, c.y - me.y);
      let el = campPool[k];
      if (!el) {
        el = document.createElement('div');
        campPool.push(el);
        host.appendChild(el);
      }
      const mine = c.id === play.clanId;
      let sx = p.sx;
      let sy = p.sy;
      let arrow = '';
      if (!p.on) {
        // Clamp to the screen edge along the direction from the centre.
        const cx = W / 2;
        const cy = H / 2;
        const dx = p.sx - cx;
        const dy = p.sy - cy;
        const t = Math.min((W / 2 - 80) / Math.max(1, Math.abs(dx)), (dy > 0 ? H / 2 - 120 : H / 2 - 80) / Math.max(1, Math.abs(dy)));
        sx = cx + dx * t;
        sy = cy + dy * t;
        arrow = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][Math.round(((Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4)) % 8];
      }
      const susp = play.suspicion.find((x) => x.clan === c.id)?.value ?? 0;
      el.className = `camp-tag${mine ? ' mine' : ''}${susp >= 0.7 ? ' hot' : ''}${p.on ? '' : ' edge'}`;
      el.style.left = `${sx}px`;
      el.style.top = `${sy}px`;
      el.style.display = '';
      el.style.borderColor = clanColor(c.id);
      el.innerHTML = `${arrow ? `<span class="arrow">${arrow}</span>` : ''}${mine ? '⌂ ' : ''}${esc(c.label.replace(/^Clan \d+ · /, ''))}<span class="n">${c.size}${mine ? '' : ` · ${Math.round(dist)} steps`}</span>`;
      k++;
    }
  }
  for (; k < campPool.length; k++) campPool[k].style.display = 'none';
}

// ------------------------------------------------------------------ input

function setSpeed(dps: number): void {
  speed = dps;
  view.daysPerSecond = dps;
  send({ type: 'speed', daysPerSecond: dps });
  for (const b of $('speeds').querySelectorAll('button')) b.classList.toggle('active', Number(b.dataset.dps) === dps);
}

$('speeds').innerHTML = SPEEDS.map(([l, v]) => `<button data-dps="${v}" title="${v ? `${Math.round(1 / v)} seconds per day` : 'Pause'}">${l}</button>`).join('');
$('speeds').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest('button');
  if (b) setSpeed(Number(b.dataset.dps));
});

let down: { x: number; y: number; t: number } | null = null;
const canvas = view.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || e.button !== 0 || !play) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 6) return;
  const id = view.pick(e.clientX, e.clientY);
  if (id >= 0 && id !== play.playerId) {
    select(id);
    return;
  }
  const spot = view.pickAnimal(e.clientX, e.clientY);
  if (spot) {
    selectBeast(spot);
    return;
  }
  const g = view.groundAt(e.clientX, e.clientY);
  if (g) {
    walkTo(g);
    approachBeast = false;
  }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    keys.add(k);
    e.preventDefault();
    return;
  }
  if (!play) return;
  if (k === 'g') act({ kind: 'gather' });
  else if (k === 'f') act({ kind: 'take', amount: 8 });
  else if (k === 'c') act({ kind: 'wood' });
  else if (k === 'v') act({ kind: 'deposit' });
  else if (k === 'b') goHome();
  else if (k === 'r') toggleClanPanel();
  else if (k === 'h' || k === '?') $('howto').hidden = !$('howto').hidden;
  else if (k === 'escape') {
    deselect();
    $('clanpanel').hidden = true;
    $('howto').hidden = true;
  } else if (k === ' ') {
    setSpeed(speed ? 0 : SPEEDS[1][1]);
    e.preventDefault();
  } else if (k === 't' && selected >= 0) act({ kind: 'help', verb: 'talk', target: selected });
  else if (k === 'e' && selected >= 0) startApproach(selected);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function goHome(): void {
  if (!play) return;
  walkTo({ x: play.campX, y: play.campY });
}

$('btn-gather').addEventListener('click', () => act({ kind: 'gather' }));
$('btn-take').addEventListener('click', () => act({ kind: 'take', amount: 8 }));
$('btn-wood').addEventListener('click', () => act({ kind: 'wood' }));
$('btn-store').addEventListener('click', () => act({ kind: 'deposit' }));
$('btn-home').addEventListener('click', goHome);
$('btn-clan').addEventListener('click', toggleClanPanel);
$('btn-help').addEventListener('click', () => ($('howto').hidden = false));
$('howto-close').addEventListener('click', () => ($('howto').hidden = true));
$('btn-begin').addEventListener('click', () => void begin());
$('in-female').addEventListener('click', () => setSex(true));
$('in-male').addEventListener('click', () => setSex(false));
function setSex(f: boolean): void {
  female = f;
  $('in-female').classList.toggle('active', f);
  $('in-male').classList.toggle('active', !f);
  $('in-female').setAttribute('aria-pressed', String(f));
  $('in-male').setAttribute('aria-pressed', String(!f));
}

// ------------------------------------------------------------------ misc

function toast(text: string, tone: '' | 'good' | 'bad' | 'warn'): void {
  const ol = $('toasts');
  const li = document.createElement('li');
  li.textContent = text;
  if (tone) li.className = tone;
  ol.prepend(li);
  setTimeout(() => li.remove(), 9000);
  while (ol.children.length > 6) ol.lastElementChild!.remove();
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

let lastT = performance.now();
let lastCard = 0;
function loop(): void {
  const now = performance.now();
  const dt = Math.min(0.25, (now - lastT) / 1000);
  lastT = now;
  if (play) step(dt);
  view.frame();
  if (play) renderLabels();
  // Keep the reach line of an open card fresh while walking.
  if ((person || beast) && now - lastCard > 200) {
    lastCard = now;
    if (beast) updateBeast();
    else updateReach();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Deep link: ?seed=N&name=X&autostart=1 (used by tests/screenshots).
const params = new URLSearchParams(location.search);
if (params.get('seed')) $<HTMLInputElement>('in-seed').value = params.get('seed')!;
if (params.get('name')) $<HTMLInputElement>('in-name').value = params.get('name')!;
if (params.get('autostart')) void begin();
if (params.get('autostart')) {
  // Test hook (screenshots / scripted play-throughs only).
  (window as unknown as { __terrarium: unknown }).__terrarium = {
    goTo: (x: number, y: number) => walkTo({ x, y }),
    me: () => ({ x: me.x, y: me.y }),
    play: () => play,
    day: () => (day ? { clans: day.clans } : null),
    nearest: () => (play ? view.nearby(me.x, me.y, 30).filter((n) => n.id !== play!.playerId).map((n) => ({ id: n.id, dist: n.dist, sx: n.sx, sy: n.sy })) : []),
    select,
    beasts: () => view.animalSpots().map((a) => ({ ...a, dist: Math.hypot(a.x - me.x, a.y - me.y) })).sort((a, b) => a.dist - b.dist),
    selectBeast,
    act,
  };
}
