/**
 * The terrarium view: scene, tilted orthographic camera, controls, and the
 * per-frame choreography (interpolation between sub-steps, headings, carried
 * infants, gestures, night gatherings). Reads worker messages only; it never
 * writes to sim state.
 */
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import {
  A_AGE, A_CLAN, A_ENERGY, A_FOLLOW, A_GOAL, A_HAIR, A_HEALTH, A_HEIGHT, A_INJURY, A_LEADER, A_MARKER, A_REP, A_SEX, A_SKIN,
  A_STATUS, ATTR_STRIDE, type DayMsg, type WorldMsg,
} from '../worker/protocol';
import { Camps } from './camps';
import { G_LUNGE, G_NONE, G_OFFER, G_RUN, G_SIT, Humans, type HumanInstance } from './humans';
import { clanColor } from './palette';
import { Terrain } from './terrain';

export type ViewMode = 'world' | 'clan' | 'follow';

const GREY = new THREE.Color('#cfcac2');
const GOAL_COLORS = ['#c9c4b8', '#7fd36b', '#ff6b5b', '#f2c14e', '#6bc6ff', '#ffffff', '#d58cff', '#ff2020'];

export class TerrariumView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly controls: MapControls;
  terrain?: Terrain;
  camps?: Camps;
  humans = new Humans();
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private overlay = new THREE.Group();
  private territoryMesh?: THREE.Mesh;
  private territoryTex?: THREE.DataTexture;
  private relationLines = new THREE.Group();
  /** Migration streams: fading arcs for camp moves and clan changes (visual only). */
  private streams = new THREE.Group();
  private selectionRing: THREE.Mesh;
  /** Selected person (highlighted with a ring). */
  selectedId = -1;
  /** Renderer-side territory heat per clan (from observed positions), for the overlay only. */
  private territoryHeat = new Map<number, Float32Array>();
  cur?: DayMsg;
  prev?: DayMsg;
  dayArrivedAt = 0;
  daysPerSecond = 0;
  mode: ViewMode = 'world';
  followId = -1;
  showTerritory = false;
  showRelations = false;
  chronicle = false;
  private gestures = new Map<number, { code: number; until: number }>();
  private headings = new Map<number, number>();
  private instances: HumanInstance[] = [];
  private instanceIds: number[] = [];
  private pointColors: THREE.Color[] = [];
  private lastRecolorTick = -999;
  private timer = new THREE.Timer();
  private tmpColor = new THREE.Color();
  /** Per-agent colors computed once per day (skin, hair, clothing, dot). */
  private colorCache = new Map<number, { skin: THREE.Color; hair: THREE.Color; cloth: THREE.Color; dotClan: THREE.Color; dotGoal: THREE.Color }>();
  /** Milliseconds of JS spent building instances last frame (excludes GPU). */
  lastBuildMs = 0;
  /** Screen position of the followed agent (for the thought bubble), or null. */
  followScreen: { x: number; y: number } | null = null;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#1b2230');
    const aspect = container.clientWidth / Math.max(1, container.clientHeight);
    const size = 60;
    this.camera = new THREE.OrthographicCamera(-size * aspect / 2, size * aspect / 2, size / 2, -size / 2, -500, 500);
    this.camera.position.set(48 + 60, 80, 48 + 60);
    this.camera.zoom = 1;
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.target.set(48, 0, 48);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minZoom = 0.5;
    this.controls.maxZoom = 12;
    this.controls.maxPolarAngle = Math.PI * 0.42;
    this.controls.minPolarAngle = Math.PI * 0.12;
    this.controls.update();
    this.hemi = new THREE.HemisphereLight('#dfe8ff', '#5a4a36', 0.9);
    this.sun = new THREE.DirectionalLight('#fff4de', 1.4);
    this.sun.position.set(-40, 80, 20);
    this.selectionRing = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.42, 24), new THREE.MeshBasicMaterial({ color: '#f5c451', transparent: true, opacity: 0.9, depthTest: false }));
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.renderOrder = 10;
    this.selectionRing.visible = false;
    this.scene.add(this.hemi, this.sun, this.humans.group, this.overlay, this.relationLines, this.selectionRing, this.streams);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    const aspect = w / h;
    const size = 60;
    this.camera.left = (-size * aspect) / 2;
    this.camera.right = (size * aspect) / 2;
    this.camera.top = size / 2;
    this.camera.bottom = -size / 2;
    this.camera.updateProjectionMatrix();
  }

  setWorld(w: WorldMsg): void {
    if (this.terrain) this.scene.remove(this.terrain.group);
    if (this.camps) this.scene.remove(this.camps.group);
    this.terrain = new Terrain(w);
    this.camps = new Camps(this.terrain);
    this.scene.add(this.terrain.group, this.camps.group);
    this.terrain.recolor(1, 1);
    this.territoryHeat.clear();
    this.headings.clear();
    this.gestures.clear();
    this.cur = this.prev = undefined;
    this.buildTerritoryOverlay(w.width, w.height);
  }

  onDay(d: DayMsg): void {
    this.prev = this.cur;
    this.cur = d;
    this.refreshColors(d);
    this.dayArrivedAt = performance.now();
    if (!this.terrain || !this.camps) return;
    this.camps.update(d.clans);
    this.camps.addGraves(d.newGraves);
    for (const oc of d.oldCamps) this.camps.addFireRing(oc.x, oc.y);
    // Worn paths and territory: accumulate what the renderer observes (visual only).
    const n = d.ids.length;
    const last = (d.subSteps - 1) * n * 2;
    for (let i = 0; i < n; i++) {
      const clan = d.attrs[i * ATTR_STRIDE + A_CLAN];
      for (let s = 1; s < d.subSteps; s += 3) {
        const x = d.frames[s * n * 2 + 2 * i];
        const y = d.frames[s * n * 2 + 2 * i + 1];
        this.terrain.addTraffic(x, y);
        if (clan >= 0) {
          let heat = this.territoryHeat.get(clan);
          if (!heat) this.territoryHeat.set(clan, (heat = new Float32Array(this.terrain.W * this.terrain.H)));
          const t = Math.floor(y) * this.terrain.W + Math.floor(x);
          if (t >= 0 && t < heat.length) heat[t] += 1;
        }
      }
      void last;
    }
    // Gestures from today's interactions (choreography only).
    const until = performance.now() + Math.min(4000, 1500 + 1000 / Math.max(0.1, this.daysPerSecond));
    for (const e of d.events) {
      const [a, b] = e.agents;
      if (e.type === 'conflict.threat' || e.type === 'conflict.attack') {
        if (a >= 0) this.gestures.set(a, { code: G_LUNGE, until });
        if (b >= 0) this.gestures.set(b, { code: e.type === 'conflict.attack' ? G_RUN : G_OFFER, until });
      } else if (e.type === 'pair.formed' || e.type === 'hunt.party_kill') {
        for (const x of e.agents) this.gestures.set(x, { code: G_OFFER, until });
      } else if (e.type === 'food.theft' && b >= 0) {
        this.gestures.set(b, { code: G_LUNGE, until });
      }
    }
    for (const e of d.events) if (e.from && e.to) this.addStream(e.from, e.to, e.type === 'clan.camp_moved' ? '#f2c14e' : '#9ad0ff');
    // Recolor terrain monthly (season, drought, paths).
    if (d.tick - this.lastRecolorTick >= 30 || d.tick < this.lastRecolorTick) {
      this.lastRecolorTick = d.tick;
      this.terrain.fadeTraffic(0.97);
      this.terrain.recolor(d.climate.season, d.climate.droughtMult);
      for (const heat of this.territoryHeat.values()) for (let k = 0; k < heat.length; k++) heat[k] *= 0.84; // ~180-day memory
      if (this.showTerritory) this.updateTerritoryOverlay();
    }
    if (this.showRelations) this.updateRelationLines();
  }

  private refreshColors(d: DayMsg): void {
    const A = d.attrs;
    const keep = new Set<number>();
    for (let i = 0; i < d.ids.length; i++) {
      const o = i * ATTR_STRIDE;
      const id = d.ids[i];
      keep.add(id);
      const age = A[o + A_AGE];
      const elder = Math.max(0, Math.min(1, (age - 50) / 25));
      let e = this.colorCache.get(id);
      if (!e) {
        e = { skin: new THREE.Color(), hair: new THREE.Color(), cloth: new THREE.Color(), dotClan: new THREE.Color(), dotGoal: new THREE.Color() };
        this.colorCache.set(id, e);
      }
      e.skin.setHSL(0.07, 0.45, 0.28 + 0.38 * A[o + A_SKIN]);
      e.hair.setHSL(0.08, 0.35, 0.08 + 0.3 * A[o + A_HAIR]).lerp(GREY, elder);
      e.cloth.set(clanColor(A[o + A_CLAN]));
      e.dotClan.copy(e.cloth);
      e.dotGoal.set(GOAL_COLORS[A[o + A_GOAL]] ?? '#fff');
    }
    for (const id of this.colorCache.keys()) if (!keep.has(id)) this.colorCache.delete(id);
  }

  /** Fractional sub-step within the current day (playback at slow speeds). */
  private phase(d: DayMsg): number {
    if (this.daysPerSecond <= 0 || this.daysPerSecond > 2) return d.subSteps - 1;
    const p = Math.min(1, (performance.now() - this.dayArrivedAt) / 1000 * this.daysPerSecond);
    return p * (d.subSteps - 1);
  }

  private positionAt(d: DayMsg, i: number, f: number): [number, number] {
    const n = d.ids.length;
    const s0 = Math.min(d.subSteps - 1, Math.floor(f));
    const s1 = Math.min(d.subSteps - 1, s0 + 1);
    const t = f - s0;
    const a = s0 * n * 2 + 2 * i;
    const b = s1 * n * 2 + 2 * i;
    return [d.frames[a] + (d.frames[b] - d.frames[a]) * t, d.frames[a + 1] + (d.frames[b + 1] - d.frames[a + 1]) * t];
  }

  /** Time of day in [0,1] for lighting: sub-steps span dawn..dusk; fast speeds stay in daylight. */
  daylight(): number {
    if (!this.cur || this.daysPerSecond > 2 || this.daysPerSecond <= 0) return 1;
    const t = this.phase(this.cur) / (this.cur.subSteps - 1);
    return 0.25 + 0.75 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.9 + 0.05))), 0.6);
  }

  frame(): void {
    this.timer.update();
    const time = this.timer.getElapsed();
    const daylight = this.daylight();
    this.sun.intensity = 0.3 + 1.2 * daylight;
    this.hemi.intensity = 0.35 + 0.6 * daylight;
    this.scene.background = new THREE.Color('#0e1420').lerp(new THREE.Color('#1f2a3a'), daylight);
    this.terrain?.update(time, daylight);
    this.camps?.animate(time, daylight);
    const t0 = performance.now();
    this.buildInstances(time);
    const lod = this.chronicle || this.camera.zoom < 1.6;
    const headdress = this.instances.findIndex((h) => h.headdress <= 0);
    this.humans.set(this.instances, lod, this.pointColors, headdress < 0 ? this.instances.length : headdress);
    this.lastBuildMs = performance.now() - t0;
    this.humans.update(time, daylight, Math.max(5, 3 * this.camera.zoom) * this.renderer.getPixelRatio());
    // Selection ring.
    const sk = this.selectedId >= 0 ? this.instanceIds.indexOf(this.selectedId) : -1;
    this.selectionRing.visible = sk >= 0;
    if (sk >= 0) {
      const h = this.instances[sk];
      this.selectionRing.position.set(h.x, h.y + 0.03, h.z);
      const pulse = 1 + 0.15 * Math.sin(time * 5);
      this.selectionRing.scale.setScalar(pulse * (lod ? 2.5 : 1));
    }
    // Follow-cam.
    this.followScreen = null;
    if (this.mode === 'follow' && this.followId >= 0) {
      const k = this.instanceIds.indexOf(this.followId);
      if (k >= 0) {
        const h = this.instances[k];
        const target = new THREE.Vector3(h.x, h.y, h.z);
        const delta = target.clone().sub(this.controls.target).multiplyScalar(0.08);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
        const v = target.clone().setY(h.y + 1.2 * h.scale).project(this.camera);
        const r = this.renderer.domElement.getBoundingClientRect();
        this.followScreen = { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      }
    }
    this.fadeStreams();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private buildInstances(time: number): void {
    const d = this.cur;
    this.instances.length = 0;
    this.instanceIds.length = 0;
    this.pointColors.length = 0;
    if (!d || !this.terrain) return;
    const f = this.phase(d);
    const n = d.ids.length;
    const A = d.attrs;
    const now = performance.now();
    const index = new Map<number, number>();
    const pos: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      index.set(d.ids[i], i);
      pos.push(this.positionAt(d, i, f));
    }
    const campOf = new Map(d.clans.map((c) => [c.id, c]));
    const leaders: HumanInstance[] = [];
    const others: HumanInstance[] = [];
    const leaderIds: number[] = [];
    const otherIds: number[] = [];
    const leaderCols: THREE.Color[] = [];
    const otherCols: THREE.Color[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * ATTR_STRIDE;
      const id = d.ids[i];
      const age = A[o + A_AGE];
      let [x, y] = pos[i];
      // Heading from motion; at camp, face the fire.
      const [x2, y2] = this.positionAt(d, i, Math.min(d.subSteps - 1, f + 0.25));
      const dx = x2 - x;
      const dy = y2 - y;
      const moving = Math.hypot(dx, dy) > 0.01;
      let heading = this.headings.get(id) ?? 0;
      const clan = campOf.get(A[o + A_CLAN]);
      if (moving) heading = Math.atan2(dx, dy);
      else if (clan && Math.hypot(clan.x - x, clan.y - y) < 3) heading = Math.atan2(clan.x - x, clan.y - y);
      this.headings.set(id, heading);
      let scale = (0.42 + 0.58 * Math.min(1, age / 16)) * (0.92 + 0.16 * A[o + A_HEIGHT]) * 1.05;
      let gesture = G_NONE;
      const g = this.gestures.get(id);
      if (g && g.until > now) gesture = g.code;
      else if (g) this.gestures.delete(id);
      // Infants ride on their mother.
      const mom = A[o + A_FOLLOW];
      let speed = moving ? Math.min(1, Math.hypot(dx, dy) * 3) : 0;
      if (mom >= 0 && index.has(mom)) {
        const mi = index.get(mom)!;
        const mh = this.headings.get(mom) ?? heading;
        [x, y] = pos[mi];
        x -= Math.sin(mh) * 0.12;
        y -= Math.cos(mh) * 0.12;
        heading = mh;
        scale *= 0.8;
        speed = 0;
      } else if (!moving && this.daysPerSecond > 0 && this.daysPerSecond <= 2 && this.daylight() < 0.45 && clan) {
        gesture = gesture || G_SIT; // evening gathering around the fire
      }
      const lift = mom >= 0 && index.has(mom) ? 0.35 : 0;
      const sex = A[o + A_SEX];
      const fem = sex === 0 ? Math.min(1, age / 14) : 0;
      const elder = Math.max(0, Math.min(1, (age - 50) / 25));
      const col = this.colorCache.get(id)!;
      const isLeader = A[o + A_LEADER] > 0;
      const inst: HumanInstance = {
        x, y: this.terrain.heightAt(x, y) + lift, z: y,
        heading, phase: (id * 1.7) % 6.28, speed: gesture === G_RUN ? 1 : speed, gesture,
        scale, fem, hunch: elder * 0.45 + (1 - A[o + A_HEALTH]) * 0.2, belly: A[o + A_REP] === 2 ? 1 : 0,
        cloth: col.cloth, skin: col.skin, hair: col.hair, paint: A[o + A_MARKER],
        limp: Math.min(1, A[o + A_INJURY] * 2), pallor: Math.max(0, 1 - A[o + A_ENERGY] * 3),
        headdress: isLeader ? 0.8 + 3 * A[o + A_STATUS] : 0,
      };
      const pc = this.chronicle ? col.dotClan : col.dotGoal;
      if (isLeader) {
        leaders.push(inst);
        leaderIds.push(id);
        leaderCols.push(pc);
      } else {
        others.push(inst);
        otherIds.push(id);
        otherCols.push(pc);
      }
    }
    void time;
    this.instances.push(...leaders, ...others);
    this.instanceIds.push(...leaderIds, ...otherIds);
    this.pointColors.push(...leaderCols, ...otherCols);
    void this.tmpColor;
  }

  private addStream(from: { x: number; y: number }, to: { x: number; y: number }, color: string): void {
    if (!this.terrain || this.streams.children.length > 60) return;
    const a = new THREE.Vector3(from.x, this.terrain.heightAt(from.x, from.y) + 0.3, from.y);
    const b = new THREE.Vector3(to.x, this.terrain.heightAt(to.x, to.y) + 0.3, to.y);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 2 + a.distanceTo(b) * 0.25;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    line.userData.born = performance.now();
    this.streams.add(line);
  }

  private fadeStreams(): void {
    const now = performance.now();
    for (const l of [...this.streams.children] as THREE.Line[]) {
      const age = (now - l.userData.born) / 8000;
      if (age >= 1) {
        this.streams.remove(l);
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      } else {
        (l.material as THREE.LineBasicMaterial).opacity = 0.9 * (1 - age);
      }
    }
  }

  /** Nearest agent to a screen point (for selection), or -1. */
  pick(clientX: number, clientY: number): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = -1;
    let bestD = 18;
    for (let k = 0; k < this.instances.length; k++) {
      const h = this.instances[k];
      v.set(h.x, h.y + 0.5 * h.scale, h.z).project(this.camera);
      const sx = r.left + ((v.x + 1) / 2) * r.width;
      const sy = r.top + ((1 - v.y) / 2) * r.height;
      const dd = Math.hypot(sx - clientX, sy - clientY);
      if (dd < bestD) {
        bestD = dd;
        best = this.instanceIds[k];
      }
    }
    return best;
  }

  /** Clan camp under a screen point, or -1. */
  pickCamp(clientX: number, clientY: number): number {
    if (!this.cur || !this.terrain) return -1;
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    for (const c of this.cur.clans) {
      v.set(c.x, this.terrain.heightAt(c.x, c.y) + 0.5, c.y).project(this.camera);
      const sx = r.left + ((v.x + 1) / 2) * r.width;
      const sy = r.top + ((1 - v.y) / 2) * r.height;
      if (Math.hypot(sx - clientX, sy - clientY) < 26) return c.id;
    }
    return -1;
  }

  focusOn(x: number, y: number): void {
    if (!this.terrain) return;
    const target = new THREE.Vector3(x, this.terrain.heightAt(x, y), y);
    const delta = target.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  private buildTerritoryOverlay(W: number, H: number): void {
    if (this.territoryMesh) this.overlay.remove(this.territoryMesh);
    const data = new Uint8Array(W * H * 4);
    this.territoryTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    this.territoryTex.magFilter = THREE.NearestFilter;
    const geo = new THREE.PlaneGeometry(W, H);
    geo.rotateX(-Math.PI / 2);
    geo.translate(W / 2, 0, H / 2);
    const mat = new THREE.MeshBasicMaterial({ map: this.territoryTex, transparent: true, depthWrite: false });
    this.territoryMesh = new THREE.Mesh(geo, mat);
    this.territoryMesh.position.y = 3.2;
    this.territoryMesh.visible = false;
    this.territoryMesh.renderOrder = 5;
    this.overlay.add(this.territoryMesh);
  }

  /** Territory = the clan whose members were most present at a tile over ~180 days (overlay only). */
  updateTerritoryOverlay(): void {
    if (!this.territoryTex || !this.terrain || !this.territoryMesh) return;
    const W = this.terrain.W;
    const H = this.terrain.H;
    const data = this.territoryTex.image.data as Uint8Array;
    data.fill(0);
    const alive = new Set(this.cur?.clans.map((c) => c.id) ?? []);
    for (let t = 0; t < W * H; t++) {
      let best = -1;
      let bestV = 2;
      for (const [clan, heat] of this.territoryHeat) {
        if (!alive.has(clan)) continue;
        if (heat[t] > bestV) {
          bestV = heat[t];
          best = clan;
        }
      }
      if (best < 0) continue;
      this.tmpColor.set(clanColor(best));
      // Texture rows run bottom-up; the plane maps v to z.
      const row = H - 1 - ((t / W) | 0);
      const k = (row * W + (t % W)) * 4;
      data[k] = this.tmpColor.r * 255;
      data[k + 1] = this.tmpColor.g * 255;
      data[k + 2] = this.tmpColor.b * 255;
      data[k + 3] = Math.min(150, 40 + bestV * 3);
    }
    this.territoryTex.flipY = false;
    this.territoryTex.needsUpdate = true;
    this.territoryMesh.visible = this.showTerritory;
  }

  setTerritory(on: boolean): void {
    this.showTerritory = on;
    if (on) this.updateTerritoryOverlay();
    if (this.territoryMesh) this.territoryMesh.visible = on;
  }

  setRelations(on: boolean): void {
    this.showRelations = on;
    this.updateRelationLines();
  }

  /** Lines between camps colored by derived clan-to-clan affinity. */
  private updateRelationLines(): void {
    this.relationLines.clear();
    if (!this.showRelations || !this.cur || !this.terrain) return;
    const camps = new Map(this.cur.clans.map((c) => [c.id, c]));
    const done = new Set<string>();
    for (const [key, v] of this.cur.relations) {
      const [a, b] = key.split('>').map(Number);
      const k2 = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (done.has(k2)) continue;
      done.add(k2);
      const ca = camps.get(a);
      const cb = camps.get(b);
      if (!ca || !cb) continue;
      const back = this.cur.relations.find(([kk]) => kk === `${b}>${a}`)?.[1] ?? v;
      const m = (v + back) / 2;
      const color = m >= 0 ? new THREE.Color('#7fe08a') : new THREE.Color('#ff5a4a');
      const pts = [
        new THREE.Vector3(ca.x, this.terrain.heightAt(ca.x, ca.y) + 2.5, ca.y),
        new THREE.Vector3(cb.x, this.terrain.heightAt(cb.x, cb.y) + 2.5, cb.y),
      ];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, 0.25 + Math.abs(m) * 3) }));
      this.relationLines.add(line);
    }
  }
}
