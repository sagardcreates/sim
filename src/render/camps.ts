/**
 * Camps (tents, fire, clan banner), graves and abandoned fire rings: the
 * terrain's memory. Visual only.
 */
import * as THREE from 'three';
import type { ClanView } from '../worker/protocol';
import { clanColor } from './palette';
import type { Terrain } from './terrain';

const MAX_GRAVES = 8000;
const MAX_RINGS = 400;

export class Camps {
  readonly group = new THREE.Group();
  private camps = new Map<number, THREE.Group>();
  private graves: THREE.InstancedMesh;
  private graveCount = 0;
  private rings: THREE.InstancedMesh;
  private ringCount = 0;
  private fires: THREE.Mesh[] = [];
  private glowMat: THREE.SpriteMaterial;
  private glows: THREE.Sprite[] = [];

  constructor(private terrain: Terrain) {
    const stone = new THREE.DodecahedronGeometry(0.07, 0);
    stone.scale(1, 1.4, 0.6);
    this.graves = new THREE.InstancedMesh(stone, new THREE.MeshLambertMaterial({ color: '#8d8a84', flatShading: true }), MAX_GRAVES);
    this.graves.count = 0;
    this.graves.frustumCulled = false;
    const ringStone = new THREE.DodecahedronGeometry(0.06, 0);
    this.rings = new THREE.InstancedMesh(ringStone, new THREE.MeshLambertMaterial({ color: '#5d5a55', flatShading: true }), MAX_RINGS * 8);
    this.rings.count = 0;
    this.rings.frustumCulled = false;
    this.group.add(this.graves, this.rings);
    // Soft radial glow texture for fires.
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,200,110,0.9)');
    grad.addColorStop(0.4, 'rgba(255,140,50,0.35)');
    grad.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.glowMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthWrite: false, blending: THREE.AdditiveBlending, transparent: true });
  }

  private makeCamp(c: ClanView): THREE.Group {
    const g = new THREE.Group();
    const color = new THREE.Color(clanColor(c.id));
    const hide = new THREE.Color('#b99c74').lerp(color, 0.25);
    const tentGeo = new THREE.ConeGeometry(0.42, 0.62, 5);
    tentGeo.translate(0, 0.31, 0);
    const tentMat = new THREE.MeshLambertMaterial({ color: hide, flatShading: true });
    const nTents = 4;
    for (let k = 0; k < nTents; k++) {
      const a = (k / nTents) * Math.PI * 2 + 0.4;
      const t = new THREE.Mesh(tentGeo, tentMat);
      t.position.set(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5);
      t.rotation.y = a;
      g.add(t);
    }
    const fire = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 5), new THREE.MeshBasicMaterial({ color: '#ffb347' }));
    fire.position.y = 0.15;
    g.add(fire);
    this.fires.push(fire);
    const glow = new THREE.Sprite(this.glowMat);
    glow.scale.set(2.2, 2.2, 1);
    glow.position.y = 0.3;
    g.add(glow);
    this.glows.push(glow);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 4), new THREE.MeshLambertMaterial({ color: '#5a4030' }));
    pole.position.set(0.9, 0.8, -0.3);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.35), new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    flag.position.set(1.18, 1.4, -0.3);
    flag.name = 'flag';
    g.add(pole, flag);
    g.userData.clanId = c.id;
    return g;
  }

  update(clans: ClanView[]): void {
    const seen = new Set<number>();
    for (const c of clans) {
      seen.add(c.id);
      let g = this.camps.get(c.id);
      if (!g) {
        g = this.makeCamp(c);
        this.camps.set(c.id, g);
        this.group.add(g);
      }
      g.position.set(c.x, this.terrain.heightAt(c.x, c.y), c.y);
      g.visible = c.size > 0;
    }
    for (const [id, g] of this.camps) {
      if (!seen.has(id)) {
        this.group.remove(g);
        this.camps.delete(id);
      }
    }
  }

  addGraves(xy: Float32Array): void {
    const m = new THREE.Matrix4();
    for (let k = 0; k + 1 < xy.length && this.graveCount < MAX_GRAVES; k += 2) {
      const x = xy[k];
      const y = xy[k + 1];
      const rot = new THREE.Matrix4().makeRotationY((x * 13.1 + y * 7.7) % 6.28);
      m.makeTranslation(x, this.terrain.heightAt(x, y) + 0.05, y).multiply(rot);
      this.graves.setMatrixAt(this.graveCount++, m);
    }
    this.graves.count = this.graveCount;
    this.graves.instanceMatrix.needsUpdate = true;
  }

  addFireRing(x: number, y: number): void {
    if (this.ringCount >= MAX_RINGS) return;
    const m = new THREE.Matrix4();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = x + Math.cos(a) * 0.3;
      const py = y + Math.sin(a) * 0.3;
      m.makeTranslation(px, this.terrain.heightAt(px, py) + 0.03, py);
      this.rings.setMatrixAt(this.ringCount * 8 + k, m);
    }
    this.ringCount++;
    this.rings.count = this.ringCount * 8;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  resetMemory(): void {
    this.graveCount = 0;
    this.graves.count = 0;
    this.ringCount = 0;
    this.rings.count = 0;
  }

  /** Flicker and night glow; banners flutter. */
  animate(time: number, daylight: number): void {
    this.fires.forEach((f, k) => {
      const s = 0.85 + 0.25 * Math.sin(time * 9 + k) + 0.1 * Math.sin(time * 23 + k * 3);
      f.scale.set(s, 0.8 + 0.4 * s, s);
    });
    for (const gl of this.glows) {
      const night = 1 - daylight;
      const s = 1.4 + 2.2 * night;
      gl.scale.set(s, s, 1);
      gl.material.opacity = 0.35 + 0.65 * night;
    }
    for (const g of this.camps.values()) {
      const flag = g.getObjectByName('flag');
      if (flag) flag.rotation.y = 0.25 * Math.sin(time * 2 + g.position.x);
    }
  }

  campAt(point: THREE.Vector3): number {
    for (const [id, g] of this.camps) if (g.visible && g.position.distanceTo(point) < 2) return id;
    return -1;
  }
}
