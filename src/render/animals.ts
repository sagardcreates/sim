/**
 * Animals (play mode): the sim's game density drawn as creatures. Which
 * animals stand on which tile comes from sim/play/animals.ts (pure), so what
 * you see is what you can hunt; hunting depletes the tile and they thin out.
 * Their wandering and shying from the player are visual only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ANIMALS, animalsOnTile, tileHash } from '../sim/play/animals';
import type { Terrain } from './terrain';

const MAX = 600;

export interface AnimalSpot {
  tile: number;
  k: number;
  kind: number;
  x: number;
  y: number;
}

function quadruped(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };
  box(0.9, 0.42, 0.4, 0, 0.62, 0); // body
  box(0.32, 0.28, 0.26, 0.56, 0.78, 0); // head
  box(0.12, 0.1, 0.1, 0.74, 0.92, 0); // snout/ears
  for (const [x, z] of [[0.3, 0.13], [0.3, -0.13], [-0.3, 0.13], [-0.3, -0.13]]) box(0.1, 0.45, 0.1, x, 0.22, z); // legs
  box(0.14, 0.1, 0.08, -0.5, 0.72, 0); // tail
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  g.computeVertexNormals();
  return g;
}

export class Animals {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  spots: AnimalSpot[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private colors = ANIMALS.map((a) => new THREE.Color(a.color));
  private dead: THREE.InstancedMesh;
  private carcasses: { x: number; y: number; kind: number; at: number; heading: number }[] = [];

  constructor(private terrain: Terrain, private biome: Uint8Array, private W: number, private H: number) {
    this.mesh = new THREE.InstancedMesh(quadruped(), new THREE.MeshLambertMaterial({ flatShading: true }), MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.dead = new THREE.InstancedMesh(this.mesh.geometry, new THREE.MeshLambertMaterial({ flatShading: true }), 64);
    this.dead.count = 0;
    this.dead.frustumCulled = false;
    this.group.add(this.mesh, this.dead);
  }

  /** A killed animal lies on its side for ~45 s. */
  addCarcass(x: number, y: number, kind: number): void {
    this.carcasses.push({ x: x + 0.2, y: y + 0.1, kind, at: performance.now(), heading: (x * 7 + y * 3) % 6.28 });
    if (this.carcasses.length > 64) this.carcasses.shift();
  }

  private drawCarcasses(): void {
    const now = performance.now();
    this.carcasses = this.carcasses.filter((c) => now - c.at < 45000);
    const e = new THREE.Euler();
    let n = 0;
    for (const c of this.carcasses) {
      const age = (now - c.at) / 1000;
      const fall = Math.min(1, age / 0.6); // topples over
      const fade = age > 42 ? Math.max(0.01, 1 - (age - 42) / 3) : 1;
      const s = ANIMALS[c.kind].size * 0.9 * fade;
      e.set(fall * Math.PI / 2, c.heading, 0, 'YXZ');
      this.q.setFromEuler(e);
      this.m.compose(new THREE.Vector3(c.x, this.terrain.heightAt(c.x, c.y) + 0.05, c.y), this.q, new THREE.Vector3(s, s, s));
      this.dead.setMatrixAt(n, this.m);
      this.dead.setColorAt(n, this.colors[c.kind]);
      n++;
    }
    this.dead.count = n;
    this.dead.instanceMatrix.needsUpdate = true;
    if (this.dead.instanceColor) this.dead.instanceColor.needsUpdate = true;
  }

  /** Rebuilds the animals within `radius` tiles of (cx, cy) from the current game density. */
  update(density: Float32Array | undefined, cx: number, cy: number, radius: number, time: number, px: number, py: number, tileRate: number): void {
    this.spots.length = 0;
    this.drawCarcasses();
    if (!density) {
      this.mesh.count = 0;
      return;
    }
    const W = this.W;
    let n = 0;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(W - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(this.H - 1, Math.ceil(cy + radius));
    for (let ty = y0; ty <= y1 && n < MAX; ty++) {
      for (let tx = x0; tx <= x1 && n < MAX; tx++) {
        const t = ty * W + tx;
        const kinds = animalsOnTile(t, this.biome[t], density[t], tileRate);
        for (let k = 0; k < kinds.length && n < MAX; k++) {
          const kind = ANIMALS[kinds[k]];
          const ph = tileHash(t, 20 + k) * 6.28;
          const sp = 0.12 + 0.1 * tileHash(t, 30 + k);
          // Graze in a slow loop around the tile; herds stay together.
          let x = tx + 0.5 + 0.32 * Math.cos(time * sp + ph) + (k - 1) * 0.35;
          let y = ty + 0.5 + 0.32 * Math.sin(time * sp * 0.8 + ph) + (tileHash(t, 40 + k) - 0.5) * 0.5;
          let heading = time * sp + ph + Math.PI / 2;
          // Shy away from the player (visual; the sim only knows the tile).
          const dx = x - px;
          const dy = y - py;
          const d = Math.hypot(dx, dy);
          if (d < 2.2 && d > 0.01) {
            const push = (2.2 - d) * 0.35;
            x += (dx / d) * push;
            y += (dy / d) * push;
            heading = Math.atan2(dx, dy) + Math.PI / 2;
          }
          const s = kind.size * 0.9;
          this.q.setFromAxisAngle(this.up, heading);
          this.m.compose(new THREE.Vector3(x, this.terrain.heightAt(x, y), y), this.q, new THREE.Vector3(s, s, s));
          this.mesh.setMatrixAt(n, this.m);
          this.mesh.setColorAt(n, this.colors[kinds[k]]);
          this.spots.push({ tile: t, k, kind: kinds[k], x, y });
          n++;
        }
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Nearest animal to a screen point, or null. */
  pick(clientX: number, clientY: number, camera: THREE.Camera, rect: DOMRect): AnimalSpot | null {
    const v = new THREE.Vector3();
    let best: AnimalSpot | null = null;
    let bd = 22;
    for (const a of this.spots) {
      v.set(a.x, this.terrain.heightAt(a.x, a.y) + 0.4 * ANIMALS[a.kind].size, a.y).project(camera);
      const sx = rect.left + ((v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bd) [bd, best] = [d, a];
    }
    return best;
  }

  setDaylight(daylight: number): void {
    (this.mesh.material as THREE.MeshLambertMaterial).color.setScalar(0.45 + 0.55 * daylight);
  }
}
