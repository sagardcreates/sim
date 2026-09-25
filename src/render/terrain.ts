/**
 * Terrain, water and trees. Low-poly flat-shaded heightfield with vertex
 * colors; season/drought tint and worn footpaths recolor it periodically.
 * Everything here is visual; it reads world data sent by the worker.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldMsg } from '../worker/protocol';
import { BIOME, DIRT, DRY, WINTER } from './palette';

export const HEIGHT_SCALE = 5;
const WATER = 4;

/** Smooth deterministic value noise in [-1, 1] (visual ground detail). */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}

export interface TreeSpot {
  x: number;
  y: number;
  s: number;
  tile: number;
  /** Index among the trees on its tile (felling order). */
  k: number;
  broad: boolean;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly W: number;
  readonly H: number;
  /** Height at tile corners, (W+1)*(H+1). */
  private corner: Float32Array;
  private mesh: THREE.Mesh;
  private colors: Float32Array;
  /** Per non-indexed vertex: tile index it belongs to (for recoloring). */
  private vertexTile: Int32Array;
  private waterMesh?: THREE.Mesh;
  private waterMat: THREE.ShaderMaterial;
  private foliage?: THREE.InstancedMesh;
  private trunks?: THREE.InstancedMesh;
  private crowns?: THREE.InstancedMesh;
  private stumps?: THREE.InstancedMesh;
  private logs?: THREE.InstancedMesh;
  treeSpots: TreeSpot[] = [];
  /** Tile -> felled count currently drawn; felling animations in flight. */
  private felledShown = new Map<number, number>();
  private falling: { spot: number; start: number }[] = [];
  private fellTime = new Map<number, number>();
  private oceanMesh?: THREE.Mesh;
  /** Subdivisions per tile (1 = low-poly overview; 3+ = ground-level detail with smooth shading). */
  readonly detail: number;
  /** Tree scale (bigger for ground-level views). */
  private treeScale: number;
  /** Visual traffic per tile (worn paths); renderer-side accumulation only. */
  readonly traffic: Float32Array;
  waterLevel = 0;

  constructor(private world: WorldMsg, opts: { detail?: number; treeScale?: number; ocean?: boolean } = {}) {
    this.detail = opts.detail ?? 1;
    this.treeScale = opts.treeScale ?? 1;
    this.W = world.width;
    this.H = world.height;
    this.traffic = new Float32Array(this.W * this.H);
    this.corner = this.cornerHeights();
    const { mesh, colors, vertexTile } = this.buildMesh();
    this.mesh = mesh;
    this.colors = colors;
    this.vertexTile = vertexTile;
    this.group.add(mesh);
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uDaylight: { value: 1 } },
      transparent: true,
      vertexShader: `
        #include <fog_pars_vertex>
        uniform float uTime; varying vec2 vXZ; varying float vWave;
        void main(){ vec3 p = position; vXZ = p.xz;
          vWave = sin(p.x*1.7 + uTime*1.3) * 0.5 + sin(p.z*2.3 - uTime*1.1) * 0.5;
          p.y += vWave * 0.03;
          vec4 mvPosition = modelViewMatrix * vec4(p,1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <fog_pars_fragment>
        uniform float uTime; uniform float uDaylight; varying vec2 vXZ; varying float vWave;
        void main(){ vec3 deep = vec3(0.16,0.36,0.55); vec3 light = vec3(0.45,0.70,0.85);
          float shimmer = smoothstep(0.55, 1.0, sin(vXZ.x*5.0 + vXZ.y*3.0 + uTime*2.0) * 0.5 + 0.5);
          vec3 col = mix(deep, light, 0.35 + 0.25*vWave) + shimmer*0.12;
          gl_FragColor = vec4(col * (0.35 + 0.65*uDaylight), 0.88);
          #include <fog_fragment>
        }`,
    });
    this.waterMat.fog = true;
    this.waterMat.uniforms = { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...this.waterMat.uniforms };
    this.buildWater();
    if (opts.ocean) this.buildOcean();
    this.buildTrees();
  }

  /** Visual height of a tile (land rises with elevation, water sits flat). */
  private tileHeight(i: number): number {
    const e = this.world.elevation[i];
    if (this.world.biome[i] === WATER) return this.world.river[i] === 1 ? 0.05 + e * 0.6 : 0;
    return 0.15 + Math.max(0, e - 0.28) * HEIGHT_SCALE;
  }

  private cornerHeights(): Float32Array {
    const { W, H } = this;
    const out = new Float32Array((W + 1) * (H + 1));
    for (let y = 0; y <= H; y++) {
      for (let x = 0; x <= W; x++) {
        let s = 0;
        let n = 0;
        for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          s += this.tileHeight(ty * W + tx);
          n++;
        }
        out[y * (W + 1) + x] = s / n;
      }
    }
    return out;
  }

  /** Bilinear ground height at continuous tile coordinates. */
  heightAt(x: number, y: number): number {
    const W = this.W;
    const cx = Math.max(0, Math.min(W - 0.001, x));
    const cy = Math.max(0, Math.min(this.H - 0.001, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const fx = cx - x0;
    const fy = cy - y0;
    const h = this.corner;
    const a = h[y0 * (W + 1) + x0];
    const b = h[y0 * (W + 1) + x0 + 1];
    const c = h[(y0 + 1) * (W + 1) + x0];
    const d = h[(y0 + 1) * (W + 1) + x0 + 1];
    const base = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    return this.detail > 1 ? base + this.bump(cx, cy) : base;
  }

  /** Small ground relief for detailed terrain (none on water; more on hills). */
  private bump(x: number, y: number): number {
    const t = Math.min(this.W * this.H - 1, Math.floor(y) * this.W + Math.floor(x));
    const b = this.world.biome[t];
    if (b === WATER) return 0;
    const amp = b === 2 ? 0.28 : 0.09;
    return (valueNoise(x * 1.3, y * 1.3) * 0.7 + valueNoise(x * 3.7 + 17, y * 3.7 + 5) * 0.3) * amp;
  }

  private buildMesh() {
    if (this.detail > 1) return this.buildDetailedMesh();
    const { W, H } = this;
    const nTiles = W * H;
    const pos = new Float32Array(nTiles * 6 * 3);
    const colors = new Float32Array(nTiles * 6 * 3);
    const vertexTile = new Int32Array(nTiles * 6);
    let v = 0;
    const put = (x: number, y: number, tile: number) => {
      pos[v * 3] = x;
      pos[v * 3 + 1] = this.corner[y * (W + 1) + x];
      pos[v * 3 + 2] = y;
      vertexTile[v] = tile;
      v++;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = y * W + x;
        // Alternate the diagonal for a less regular low-poly look.
        if ((x + y) % 2 === 0) {
          put(x, y, t); put(x, y + 1, t); put(x + 1, y, t);
          put(x + 1, y, t); put(x, y + 1, t); put(x + 1, y + 1, t);
        } else {
          put(x, y, t); put(x, y + 1, t); put(x + 1, y + 1, t);
          put(x, y, t); put(x + 1, y + 1, t); put(x + 1, y, t);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    return { mesh, colors, vertexTile };
  }

  /** Smooth, subdivided ground for close views: indexed grid, per-vertex colour blended across tiles. */
  private buildDetailedMesh() {
    const { W, H } = this;
    const D = this.detail;
    const NX = W * D + 1;
    const NY = H * D + 1;
    const pos = new Float32Array(NX * NY * 3);
    const colors = new Float32Array(NX * NY * 3);
    const vertexTile = new Int32Array(NX * NY);
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const x = i / D;
        const y = j / D;
        const v = j * NX + i;
        pos[v * 3] = x;
        pos[v * 3 + 1] = this.heightAt(x, y);
        pos[v * 3 + 2] = y;
        vertexTile[v] = Math.min(H - 1, Math.floor(y)) * W + Math.min(W - 1, Math.floor(x));
      }
    }
    const idx = new Uint32Array((NX - 1) * (NY - 1) * 6);
    let k = 0;
    for (let j = 0; j < NY - 1; j++) {
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i;
        const b = a + 1;
        const c = a + NX;
        const d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return { mesh, colors, vertexTile };
  }

  /** Recolor for season (0..2 growth multiplier), drought (0..1) and worn paths. */
  recolor(season: number, droughtMult: number): void {
    const { W, H } = this;
    const tileCol = new Float32Array(W * H * 3);
    const tmp = new THREE.Color();
    const winter = Math.max(0, Math.min(1, (1 - season) * 1.2));
    const dry = Math.max(0, Math.min(1, (1 - droughtMult) * 1.5));
    for (let t = 0; t < W * H; t++) {
      const b = this.world.biome[t];
      tmp.copy(BIOME[b]);
      if (b !== WATER) {
        if (b === 0 || b === 1) tmp.lerp(WINTER, winter * 0.45).lerp(DRY, dry * 0.6);
        const e = this.world.elevation[t];
        tmp.multiplyScalar(0.8 + 0.35 * e);
        const wear = Math.min(1, this.traffic[t] / 60);
        tmp.lerp(DIRT, wear * 0.55);
      }
      tileCol[t * 3] = tmp.r;
      tileCol[t * 3 + 1] = tmp.g;
      tileCol[t * 3 + 2] = tmp.b;
    }
    if (this.detail > 1) {
      // Blend the four nearest tiles' colours at each vertex, with a little mottling.
      const pos = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < pos.count; v++) {
        const x = pos.getX(v) - 0.5;
        const y = pos.getZ(v) - 0.5;
        const x0 = Math.max(0, Math.min(W - 1, Math.floor(x)));
        const y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
        const x1 = Math.min(W - 1, x0 + 1);
        const y1 = Math.min(H - 1, y0 + 1);
        const fx = Math.max(0, Math.min(1, x - x0));
        const fy = Math.max(0, Math.min(1, y - y0));
        const m = 1 + valueNoise(x * 2.1 + 3, y * 2.1 + 9) * 0.07;
        for (let ch = 0; ch < 3; ch++) {
          const a = tileCol[(y0 * W + x0) * 3 + ch];
          const b = tileCol[(y0 * W + x1) * 3 + ch];
          const c = tileCol[(y1 * W + x0) * 3 + ch];
          const d = tileCol[(y1 * W + x1) * 3 + ch];
          this.colors[v * 3 + ch] = (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy) * m;
        }
      }
      (this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      if (this.foliage) {
        const mat = this.foliage.material as THREE.MeshLambertMaterial;
        mat.color.set('#3f7a35').lerp(new THREE.Color('#9b8a4a'), winter * 0.5 + dry * 0.4);
      }
      return;
    }
    const vt = this.vertexTile;
    for (let v = 0; v < vt.length; v++) {
      const t = vt[v];
      this.colors[v * 3] = tileCol[t * 3];
      this.colors[v * 3 + 1] = tileCol[t * 3 + 1];
      this.colors[v * 3 + 2] = tileCol[t * 3 + 2];
    }
    (this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    if (this.foliage) {
      const mat = this.foliage.material as THREE.MeshLambertMaterial;
      mat.color.set('#3f7a35').lerp(new THREE.Color('#9b8a4a'), winter * 0.5 + dry * 0.4);
    }
  }

  /** Accumulate visual traffic (worn paths) from agent positions; slowly fades. */
  addTraffic(x: number, y: number): void {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.W || ty >= this.H) return;
    this.traffic[ty * this.W + tx] += 1;
  }

  fadeTraffic(f: number): void {
    for (let i = 0; i < this.traffic.length; i++) this.traffic[i] *= f;
  }

  private buildWater(): void {
    const { W } = this;
    const quads: number[] = [];
    for (let t = 0; t < this.W * this.H; t++) {
      if (this.world.biome[t] !== WATER) continue;
      const x = t % W;
      const y = (t / W) | 0;
      const h = this.world.river[t] === 1 ? this.tileHeight(t) + 0.06 : 0.12;
      quads.push(x, h, y, x, h, y + 1, x + 1, h, y, x + 1, h, y, x, h, y + 1, x + 1, h, y + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads), 3));
    this.waterMesh = new THREE.Mesh(geo, this.waterMat);
    this.waterMesh.renderOrder = 1;
    this.group.add(this.waterMesh);
  }

  private buildTrees(): void {
    const { W, H } = this;
    const spots: TreeSpot[] = [];
    // Deterministic pseudo-random placement (visual only).
    let seed = 12345 + this.world.seed * 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let t = 0; t < W * H; t++) {
      const b = this.world.biome[t];
      let n = b === 1 ? (rnd() < 0.8 ? 2 : 1) : b === 0 ? (rnd() < 0.08 ? 1 : 0) : b === 2 ? (rnd() < 0.15 ? 1 : 0) : 0;
      // Ground-level views: open forest you can see and walk through (the draws above stay, so felling indices match).
      if (this.detail > 1 && n === 2 && rnd() < 0.55) n = 1;
      for (let k = 0; k < n; k++) {
        spots.push({ x: (t % W) + 0.15 + rnd() * 0.7, y: ((t / W) | 0) + 0.15 + rnd() * 0.7, s: 0.7 + rnd() * 0.6, tile: t, k, broad: b === 0 || rnd() < 0.3 });
      }
    }
    this.treeSpots = spots;
    const ts = this.treeScale;
    const coneGeo = new THREE.ConeGeometry(0.32, 0.9, this.detail > 1 ? 8 : 6);
    coneGeo.translate(0, 0.75, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.35, 6);
    trunkGeo.translate(0, 0.17, 0);
    const crownGeo = new THREE.IcosahedronGeometry(0.42, 1);
    crownGeo.translate(0, 0.85, 0);
    if (this.detail > 1) {
      // Ground level: tall bare trunks, needles/leaves high above head height, slimmer crowns.
      const low = new THREE.ConeGeometry(0.2, 0.55, 8);
      low.translate(0, 0.95, 0);
      const mid = new THREE.ConeGeometry(0.16, 0.5, 8);
      mid.translate(0, 1.22, 0);
      const top = new THREE.ConeGeometry(0.1, 0.4, 7);
      top.translate(0, 1.48, 0);
      coneGeo.copy(mergeGeos([low, mid, top]));
      const trunk = new THREE.CylinderGeometry(0.035, 0.055, 1.1, 7);
      trunk.translate(0, 0.55, 0);
      trunkGeo.copy(trunk);
      const crown = new THREE.IcosahedronGeometry(0.34, 1);
      crown.scale(1, 0.85, 1);
      crown.translate(0, 1.15, 0);
      crownGeo.copy(crown);
    }
    const pines = spots.filter((p) => !p.broad || this.detail === 1);
    const broads = this.detail > 1 ? spots.filter((p) => p.broad) : [];
    const foliage = new THREE.InstancedMesh(coneGeo, new THREE.MeshLambertMaterial({ color: '#3f7a35', flatShading: true }), Math.max(1, pines.length));
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: '#4f8a3a', flatShading: true }), Math.max(1, broads.length));
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#6b4a2f' }), spots.length);
    const m = new THREE.Matrix4();
    const place = (p: TreeSpot, mesh: THREE.InstancedMesh, i: number, sy = 1) => {
      const s = p.s * ts;
      m.makeScale(s, s * sy, s).setPosition(p.x, this.heightAt(p.x, p.y) - 0.02, p.y);
      mesh.setMatrixAt(i, m);
    };
    pines.forEach((p, i) => place(p, foliage, i));
    broads.forEach((p, i) => place(p, crowns, i));
    spots.forEach((p, i) => place(p, trunks, i));
    foliage.count = pines.length;
    crowns.count = broads.length;
    for (const mesh of [foliage, crowns, trunks]) {
      mesh.castShadow = this.detail > 1;
      mesh.receiveShadow = this.detail > 1;
    }
    this.foliage = foliage;
    this.crowns = crowns;
    this.trunks = trunks;
    this.pineIndex = new Map(pines.map((p, i) => [p, i]));
    this.broadIndex = new Map(broads.map((p, i) => [p, i]));
    this.group.add(foliage, crowns, trunks);
    if (this.detail > 1) {
      const stumpGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.12, 7);
      stumpGeo.translate(0, 0.06, 0);
      this.stumps = new THREE.InstancedMesh(stumpGeo, new THREE.MeshLambertMaterial({ color: '#8a6a45' }), 512);
      this.stumps.count = 0;
      const logGeo = new THREE.CylinderGeometry(0.06, 0.07, 1.1, 6);
      logGeo.rotateZ(Math.PI / 2);
      logGeo.translate(0.55, 0.07, 0);
      this.logs = new THREE.InstancedMesh(logGeo, new THREE.MeshLambertMaterial({ color: '#6b4a2f' }), 256);
      this.logs.count = 0;
      this.group.add(this.stumps, this.logs);
    }
  }

  private pineIndex = new Map<TreeSpot, number>();
  private broadIndex = new Map<TreeSpot, number>();

  /**
   * Felled trees (play mode): the k-th trees of a tile are down. Newly felled
   * trees topple over (animation), lie as a log for a while, and leave a stump.
   */
  setFelled(felled: [number, number][], now: number): void {
    if (!this.stumps) return;
    const want = new Map(felled);
    for (let i = 0; i < this.treeSpots.length; i++) {
      const p = this.treeSpots[i];
      const had = (this.felledShown.get(p.tile) ?? 0) > p.k;
      const has = (want.get(p.tile) ?? 0) > p.k;
      if (has && !had) {
        this.falling.push({ spot: i, start: now });
        this.fellTime.set(i, now);
      }
      if (!has && had) this.showTree(i, true);
    }
    this.felledShown = want;
    this.rebuildStumps();
  }

  private showTree(i: number, on: boolean, tilt = 0): void {
    const p = this.treeSpots[i];
    const s = on ? p.s * this.treeScale : 0;
    const m = new THREE.Matrix4();
    const base = new THREE.Vector3(p.x, this.heightAt(p.x, p.y) - 0.02, p.y);
    const rot = new THREE.Matrix4().makeRotationZ(-tilt);
    const put = (mesh: THREE.InstancedMesh | undefined, idx: number | undefined, sy: number) => {
      if (!mesh || idx === undefined) return;
      m.makeScale(s, s * sy, s).premultiply(rot).setPosition(base);
      mesh.setMatrixAt(idx, m);
      mesh.instanceMatrix.needsUpdate = true;
    };
    put(this.foliage, this.pineIndex.get(p), 1);
    put(this.crowns, this.broadIndex.get(p), 1);
    put(this.trunks, i, 1);
  }

  private rebuildStumps(): void {
    if (!this.stumps) return;
    const m = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < this.treeSpots.length && n < 512; i++) {
      const p = this.treeSpots[i];
      if ((this.felledShown.get(p.tile) ?? 0) <= p.k) continue;
      m.makeScale(this.treeScale, this.treeScale, this.treeScale).setPosition(p.x, this.heightAt(p.x, p.y) - 0.02, p.y);
      this.stumps.setMatrixAt(n++, m);
    }
    this.stumps.count = n;
    this.stumps.instanceMatrix.needsUpdate = true;
  }

  private animateFelling(now: number): void {
    if (!this.logs) return;
    const still: { spot: number; start: number }[] = [];
    for (const f of this.falling) {
      const t = (now - f.start) / 1400;
      if (t >= 1) {
        this.showTree(f.spot, false);
        continue;
      }
      // Topple with a little acceleration.
      this.showTree(f.spot, true, (t * t) * Math.PI / 2);
      still.push(f);
    }
    this.falling = still;
    // Logs lie where trees fell for 40 s.
    const m = new THREE.Matrix4();
    let n = 0;
    for (const [i, at] of this.fellTime) {
      const age = now - at;
      if (age > 40000) {
        this.fellTime.delete(i);
        continue;
      }
      if (age < 1400 || n >= 256) continue;
      const p = this.treeSpots[i];
      const s = p.s * this.treeScale;
      m.makeScale(s, s, s).setPosition(p.x, this.heightAt(p.x, p.y), p.y);
      this.logs.setMatrixAt(n++, m);
    }
    this.logs.count = n;
    this.logs.instanceMatrix.needsUpdate = true;
  }

  private cutHidden = new Set<number>();

  /**
   * Ground-level camera: trees standing between the camera and the player are
   * hidden while they block the view (restored once the view is clear).
   */
  cutaway(cx: number, cz: number, px: number, pz: number): void {
    if (this.detail === 1) return;
    const dx = px - cx;
    const dz = pz - cz;
    const L2 = dx * dx + dz * dz;
    const now = new Set<number>();
    if (L2 > 0.01) {
      const minX = Math.min(cx, px) - 2;
      const maxX = Math.max(cx, px) + 2;
      const minZ = Math.min(cz, pz) - 2;
      const maxZ = Math.max(cz, pz) + 2;
      const reach = 0.75 * this.treeScale;
      for (let i = 0; i < this.treeSpots.length; i++) {
        const p = this.treeSpots[i];
        if (p.x < minX || p.x > maxX || p.y < minZ || p.y > maxZ) continue;
        const t = ((p.x - cx) * dx + (p.y - cz) * dz) / L2;
        if (t < -0.05 || t > 1.02) continue;
        const qx = cx + dx * t - p.x;
        const qz = cz + dz * t - p.y;
        if (qx * qx + qz * qz < reach * reach) now.add(i);
      }
    }
    for (const i of this.cutHidden) if (!now.has(i) && !this.isFelled(i)) this.showTree(i, true);
    for (const i of now) if (!this.cutHidden.has(i)) this.showTree(i, false);
    this.cutHidden = now;
  }

  private isFelled(i: number): boolean {
    const p = this.treeSpots[i];
    return (this.felledShown.get(p.tile) ?? 0) > p.k;
  }

  /** Open sea around the map (island worlds), out to the horizon. */
  private buildOcean(): void {
    const geo = new THREE.PlaneGeometry(900, 900, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(this.W / 2, 0.1, this.H / 2);
    this.oceanMesh = new THREE.Mesh(geo, this.waterMat);
    this.oceanMesh.renderOrder = 0;
    this.group.add(this.oceanMesh);
  }

  update(time: number, daylight: number): void {
    this.animateFelling(performance.now());
    this.waterMat.uniforms.uTime.value = time;
    this.waterMat.uniforms.uDaylight.value = daylight;
  }
}

function mergeGeos(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
}
