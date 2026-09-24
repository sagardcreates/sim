/**
 * Terrain, water and trees. Low-poly flat-shaded heightfield with vertex
 * colors; season/drought tint and worn footpaths recolor it periodically.
 * Everything here is visual; it reads world data sent by the worker.
 */
import * as THREE from 'three';
import type { WorldMsg } from '../worker/protocol';
import { BIOME, DIRT, DRY, WINTER } from './palette';

export const HEIGHT_SCALE = 5;
const WATER = 4;

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
  /** Visual traffic per tile (worn paths); renderer-side accumulation only. */
  readonly traffic: Float32Array;
  waterLevel = 0;

  constructor(private world: WorldMsg) {
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
        uniform float uTime; varying vec2 vXZ; varying float vWave;
        void main(){ vec3 p = position; vXZ = p.xz;
          vWave = sin(p.x*1.7 + uTime*1.3) * 0.5 + sin(p.z*2.3 - uTime*1.1) * 0.5;
          p.y += vWave * 0.03;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform float uDaylight; varying vec2 vXZ; varying float vWave;
        void main(){ vec3 deep = vec3(0.16,0.36,0.55); vec3 light = vec3(0.45,0.70,0.85);
          float shimmer = smoothstep(0.55, 1.0, sin(vXZ.x*5.0 + vXZ.y*3.0 + uTime*2.0) * 0.5 + 0.5);
          vec3 col = mix(deep, light, 0.35 + 0.25*vWave) + shimmer*0.12;
          gl_FragColor = vec4(col * (0.35 + 0.65*uDaylight), 0.88); }`,
    });
    this.buildWater();
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
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  private buildMesh() {
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
    const spots: [number, number, number][] = [];
    // Deterministic pseudo-random placement (visual only).
    let seed = 12345 + this.world.seed * 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let t = 0; t < W * H; t++) {
      const b = this.world.biome[t];
      const n = b === 1 ? (rnd() < 0.8 ? 2 : 1) : b === 0 ? (rnd() < 0.08 ? 1 : 0) : b === 2 ? (rnd() < 0.15 ? 1 : 0) : 0;
      for (let k = 0; k < n; k++) spots.push([(t % W) + 0.15 + rnd() * 0.7, ((t / W) | 0) + 0.15 + rnd() * 0.7, 0.7 + rnd() * 0.6]);
    }
    const coneGeo = new THREE.ConeGeometry(0.32, 0.9, 6);
    coneGeo.translate(0, 0.75, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.05, 0.07, 0.35, 5);
    trunkGeo.translate(0, 0.17, 0);
    const foliage = new THREE.InstancedMesh(coneGeo, new THREE.MeshLambertMaterial({ color: '#3f7a35', flatShading: true }), spots.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#6b4a2f' }), spots.length);
    const m = new THREE.Matrix4();
    spots.forEach(([x, y, s], i) => {
      m.makeScale(s, s, s).setPosition(x, this.heightAt(x, y) - 0.02, y);
      foliage.setMatrixAt(i, m);
      trunks.setMatrixAt(i, m);
    });
    this.foliage = foliage;
    this.group.add(foliage, trunks);
  }

  update(time: number, daylight: number): void {
    this.waterMat.uniforms.uTime.value = time;
    this.waterMat.uniforms.uDaylight.value = daylight;
  }
}
