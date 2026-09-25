/**
 * Ground-level ambience for the third-person game view: sky dome, fog colours
 * through the day, grass tufts and rocks near the player, and soft blob
 * shadows under people. Visual only.
 */
import * as THREE from 'three';
import type { WorldMsg } from '../worker/protocol';
import type { Terrain } from './terrain';

const GRASS_MAX = 9000;
const SHADOW_MAX = 1024;

function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Ambience {
  readonly group = new THREE.Group();
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private grass: THREE.InstancedMesh;
  private grassMat: THREE.MeshLambertMaterial;
  private rocks: THREE.InstancedMesh;
  private shadows: THREE.InstancedMesh;
  private grassCenter = { x: -999, y: -999 };
  private m = new THREE.Matrix4();
  readonly fog: THREE.Fog;

  constructor(private world: WorldMsg, private terrain: Terrain) {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color('#4f86c6') },
        uHorizon: { value: new THREE.Color('#cfe0ea') },
        uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2).normalize() },
        uSun: { value: 1 },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform float uSun; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
          float s = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
          col += vec3(1.0, 0.85, 0.6) * (pow(s, 400.0) * 1.5 + pow(s, 12.0) * 0.25) * uSun;
          // A few stars at night.
          float star = step(0.9985, fract(sin(dot(floor(vDir * 300.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453));
          col += vec3(star) * (1.0 - uSun) * h;
          gl_FragColor = vec4(col, 1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.fog = new THREE.Fog('#cfe0ea', 30, 110);

    // Grass: three crossed blades per tuft.
    const blade = (a: number) => {
      const g = new THREE.PlaneGeometry(0.07, 0.22, 1, 2);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) + 0.11;
        pos.setY(i, y);
        pos.setX(i, pos.getX(i) * (1 - y / 0.4) + y * y * 0.4); // taper and bend
      }
      g.rotateY(a);
      return g;
    };
    const tuft = mergeAll([blade(0), blade(2.1), blade(4.2)]);
    // Light grass like the ground it grows from (normals up).
    const nrm = tuft.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    // Self-lit a little so blade backs never go black.
    this.grassMat = new THREE.MeshLambertMaterial({ color: '#7fae4f', emissive: '#2c4a1a', side: THREE.DoubleSide });
    this.grass = new THREE.InstancedMesh(tuft, this.grassMat, GRASS_MAX);
    this.grass.count = 0;
    this.grass.frustumCulled = false;

    const rockGeo = new THREE.DodecahedronGeometry(0.22, 0);
    this.rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: '#8b877e', flatShading: true }), 1500);
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
    this.placeRocks();

    const disc = new THREE.CircleGeometry(0.28, 16);
    disc.rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.28, depthWrite: false }), SHADOW_MAX);
    this.shadows.count = 0;
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 2;
    this.group.add(this.sky, this.grass, this.rocks, this.shadows);
  }

  private placeRocks(): void {
    const { width: W, height: H, biome } = this.world;
    let n = 0;
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (let t = 0; t < W * H && n < 1500; t++) {
      const b = biome[t];
      const p = b === 2 ? 0.35 : b === 3 ? 0.08 : b === 0 ? 0.02 : 0;
      if (hash(t, 91) >= p) continue;
      const x = (t % W) + hash(t, 92);
      const y = Math.floor(t / W) + hash(t, 93);
      const s = 0.6 + hash(t, 94) * 1.6;
      e.set(hash(t, 95) * 3, hash(t, 96) * 3, 0);
      q.setFromEuler(e);
      this.m.compose(new THREE.Vector3(x, this.terrain.heightAt(x, y) - 0.05, y), q, new THREE.Vector3(s, s * 0.7, s));
      this.rocks.setMatrixAt(n++, this.m);
    }
    this.rocks.count = n;
  }

  /** Grass tufts around (cx, cy); rebuilt when the player has moved on. */
  private placeGrass(cx: number, cy: number): void {
    const { width: W, height: H, biome } = this.world;
    const R = 20;
    let n = 0;
    for (let ty = Math.max(0, Math.floor(cy - R)); ty < Math.min(H, cy + R) && n < GRASS_MAX; ty++) {
      for (let tx = Math.max(0, Math.floor(cx - R)); tx < Math.min(W, cx + R) && n < GRASS_MAX; tx++) {
        const t = ty * W + tx;
        const b = biome[t];
        const per = b === 0 ? 7 : b === 1 ? 3 : b === 3 ? 2 : 0;
        for (let k = 0; k < per && n < GRASS_MAX; k++) {
          const x = tx + hash(t, k * 3 + 1);
          const y = ty + hash(t, k * 3 + 2);
          if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
          const s = 0.7 + hash(t, k * 3 + 3) * 0.8;
          this.m.makeRotationY(hash(t, k + 40) * 6.28).scale(new THREE.Vector3(s, s * (b === 3 ? 0.7 : 1), s));
          this.m.setPosition(x, this.terrain.heightAt(x, y) - 0.02, y);
          this.grass.setMatrixAt(n++, this.m);
        }
      }
    }
    this.grass.count = n;
    this.grass.instanceMatrix.needsUpdate = true;
    this.grassCenter = { x: cx, y: cy };
  }

  /** Per frame: sky and fog follow the time of day; grass follows the player; shadows under people. */
  update(camera: THREE.Camera, daylight: number, cx: number, cy: number, feet: { x: number; y: number; z: number; s: number }[], season: number): void {
    this.sky.position.copy(camera.position);
    const top = new THREE.Color('#0b1224').lerp(new THREE.Color('#4f86c6'), daylight);
    const horizon = new THREE.Color('#1a2233').lerp(new THREE.Color('#d6e3ea'), daylight);
    if (daylight > 0.25 && daylight < 0.7) horizon.lerp(new THREE.Color('#e7a86a'), (0.7 - daylight) * 0.8); // dawn/dusk glow
    this.skyMat.uniforms.uTop.value.copy(top);
    this.skyMat.uniforms.uHorizon.value.copy(horizon);
    this.skyMat.uniforms.uSun.value = daylight;
    this.fog.color.copy(horizon);
    if (Math.hypot(cx - this.grassCenter.x, cy - this.grassCenter.y) > 4) this.placeGrass(cx, cy);
    this.grassMat.color.set('#7fae4f').lerp(new THREE.Color('#b4a863'), Math.max(0, Math.min(1, (1 - season) * 0.8)));
    this.grassMat.emissive.set('#2c4a1a').multiplyScalar(0.3 + 0.7 * daylight);
    let n = 0;
    for (const f of feet) {
      if (n >= SHADOW_MAX) break;
      this.m.makeScale(f.s, 1, f.s).setPosition(f.x, f.y + 0.03, f.z);
      this.shadows.setMatrixAt(n++, this.m);
    }
    this.shadows.count = n;
    this.shadows.instanceMatrix.needsUpdate = true;
    (this.shadows.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.2 * daylight;
  }

  setSunDirection(dir: THREE.Vector3): void {
    this.skyMat.uniforms.uSunDir.value.copy(dir).normalize();
  }
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  for (const p of parts) {
    const g = p.index ? p.toNonIndexed() : p;
    g.computeVertexNormals();
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
