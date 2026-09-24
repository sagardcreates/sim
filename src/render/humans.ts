/**
 * GPU-instanced procedural humanoids (§13): head, torso, four limb capsules
 * (+ a leader headdress), one draw call per body part. Gait and gestures are
 * sine-driven in the vertex shader; no skeletal rig. Per-instance attributes
 * encode clan (clothing), marker (body paint pattern), sex (shoulder/hip
 * silhouette), age (scale, hunch, grey hair), pregnancy (belly), injury (limp),
 * starvation (pallor). A point-sprite LOD takes over at world zoom.
 */
import * as THREE from 'three';

export const PART_LEG_L = 0;
export const PART_LEG_R = 1;
export const PART_TORSO = 2;
export const PART_ARM_L = 3;
export const PART_ARM_R = 4;
export const PART_HEAD = 5;
export const PART_HEADDRESS = 6;

/** Gesture codes (renderer-side choreography). */
export const G_NONE = 0;
export const G_OFFER = 1;
export const G_LUNGE = 2;
export const G_RUN = 3;
export const G_SIT = 4;

const VERT = /* glsl */ `
uniform float uTime;
uniform int uPart;
attribute vec3 iPos;      // world position of the feet
attribute vec4 iAnim;     // heading, phase offset, speed (0..1), gesture code
attribute vec4 iBody;     // scale, femininity (0..1), hunch (rad), belly (0..1)
attribute vec3 iCloth;
attribute vec3 iSkin;
attribute vec3 iHair;
attribute vec4 iMisc;     // paint id, limp (0..1), pallor (0..1), headdress size
varying vec3 vNormal;
varying vec3 vLocal;
varying vec3 vCloth;
varying vec3 vSkin;
varying vec3 vHair;
varying float vPaint;
varying float vPallor;

mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }

void main(){
  float scale = iBody.x;
  float fem = iBody.y;
  float hunch = iBody.z;
  float belly = iBody.w;
  float gesture = iAnim.w;
  float speed = iAnim.z;
  float phase = iAnim.y + uTime * (4.0 + 6.0 * speed);
  float swing = sin(phase) * 0.75 * speed;
  float limp = iMisc.y;
  float hipW = mix(0.13, 0.19, fem);
  float shW = mix(0.27, 0.21, fem);
  vec3 p = position;
  vec3 n = normal;
  vLocal = position;
  vec3 pivot = vec3(0.);
  mat3 R = mat3(1.);
  bool upper = false;
  if (uPart == 0 || uPart == 1) {
    float side = uPart == 0 ? -1. : 1.;
    float s = swing * side * (uPart == 1 ? (1. - 0.7 * limp) : 1.);
    if (gesture == 4.) s = -1.4;               // sitting: legs forward
    R = rotX(s);
    pivot = vec3(side * hipW * 0.5, 0.46, 0.);
  } else if (uPart == 2) {
    float t = clamp(p.y / 0.36, 0., 1.);
    p.x *= mix(hipW, shW, t) / 0.2;
    if (p.z > 0.) p.z *= 1. + belly * 1.6 * sin(3.14159 * clamp((0.26 - p.y) / 0.26, 0., 1.));
    pivot = vec3(0., 0.46, 0.);
    upper = true;
  } else if (uPart == 3 || uPart == 4) {
    float side = uPart == 3 ? -1. : 1.;
    float a = -swing * side * 0.8;
    if (gesture == 1.) a = -1.25;               // offer: arm forward
    if (gesture == 2.) a = -1.6 - 0.3 * sin(uTime * 14.);  // lunge
    if (gesture == 3.) a = -swing * side * 1.4; // run
    R = rotX(a);
    pivot = vec3(side * (shW * 0.5 + 0.035), 0.8, 0.);
    upper = true;
  } else if (uPart == 5) {
    pivot = vec3(0., 0.88, 0.);
    upper = true;
  } else {
    p *= iMisc.w;
    pivot = vec3(0., 0.97, 0.);
    upper = true;
  }
  vec3 bp = R * p + pivot;
  vec3 bn = R * n;
  if (upper) {
    float lean = hunch + (gesture == 2. ? 0.45 : 0.) + (gesture == 3. ? 0.25 : 0.);
    vec3 hip = vec3(0., 0.46, 0.);
    bp = rotX(lean) * (bp - hip) + hip;
    bn = rotX(lean) * bn;
  }
  float bob = abs(sin(phase)) * 0.025 * speed + limp * 0.03 * abs(sin(phase * 0.5));
  if (gesture == 4.) bob -= 0.34;
  bp.y += bob;
  mat3 H = rotY(iAnim.x);
  vec3 world = iPos + H * (bp * scale);
  vNormal = normalize(H * bn);
  vCloth = iCloth;
  vSkin = iSkin;
  vHair = iHair;
  vPaint = iMisc.x;
  vPallor = iMisc.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform int uPart;
uniform float uDaylight;
uniform vec3 uPaintColors[8];
varying vec3 vNormal;
varying vec3 vLocal;
varying vec3 vCloth;
varying vec3 vSkin;
varying vec3 vHair;
varying float vPaint;
varying float vPallor;

float paintMask(vec3 q, float id){
  float style = mod(id, 4.);
  if (style < 0.5) return step(0.5, fract(q.y * 18.));                  // horizontal stripes
  if (style < 1.5) return step(0.55, fract(q.x * 16.));                  // vertical stripes
  if (style < 2.5) return step(0.72, fract(q.x * 14.) * fract(q.y * 14.) * 4.); // dots
  return step(abs(q.y - 0.24), 0.035);                                   // band
}

void main(){
  vec3 skin = mix(vSkin, vec3(0.78, 0.76, 0.72), vPallor * 0.6);
  vec3 base = skin;
  vec3 paint = uPaintColors[int(mod(floor(vPaint / 4.), 8.))];
  if (uPart == 0 || uPart == 1) base = vCloth * 0.85;             // leggings
  else if (uPart == 2) {
    base = vLocal.y < 0.24 ? vCloth : skin;                        // tunic below the shoulders
    if (vLocal.y >= 0.24 && paintMask(vLocal, vPaint) > 0.5) base = paint;
  } else if (uPart == 3 || uPart == 4) {
    if (paintMask(vLocal * 1.3 + vec3(0., 0.3, 0.), vPaint) > 0.5) base = paint;  // painted arms
  } else if (uPart == 5) {
    base = vLocal.y > 0.1 ? vHair : skin;
    if (vLocal.y <= 0.1 && vLocal.z > 0.02 && paintMask(vLocal * 1.6, vPaint) > 0.5) base = paint;
  } else if (uPart == 6) base = vec3(0.95, 0.78, 0.25);
  vec3 L = normalize(vec3(0.4, 0.9, 0.3));
  float diff = max(dot(normalize(vNormal), L), 0.) * 0.6 + 0.5;
  gl_FragColor = vec4(base * diff * (0.4 + 0.6 * uDaylight), 1.0);
}
`;

function partGeometry(part: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (part) {
    case PART_LEG_L:
    case PART_LEG_R:
      g = new THREE.CapsuleGeometry(0.055, 0.36, 2, 6);
      g.translate(0, -0.23, 0);
      break;
    case PART_TORSO:
      g = new THREE.CapsuleGeometry(0.1, 0.18, 2, 8);
      g.scale(1, 1, 0.55);
      g.translate(0, 0.18, 0);
      break;
    case PART_ARM_L:
    case PART_ARM_R:
      g = new THREE.CapsuleGeometry(0.042, 0.3, 2, 6);
      g.translate(0, -0.19, 0);
      break;
    case PART_HEAD:
      g = new THREE.IcosahedronGeometry(0.095, 1);
      g.translate(0, 0.1, 0);
      break;
    default:
      g = new THREE.ConeGeometry(0.08, 0.22, 5);
      g.translate(0, 0.19, 0);
  }
  return g;
}

export interface HumanInstance {
  x: number;
  y: number;
  z: number;
  heading: number;
  phase: number;
  speed: number;
  gesture: number;
  scale: number;
  fem: number;
  hunch: number;
  belly: number;
  cloth: THREE.Color;
  skin: THREE.Color;
  hair: THREE.Color;
  paint: number;
  limp: number;
  pallor: number;
  headdress: number;
}

export class Humans {
  readonly group = new THREE.Group();
  private capacity = 0;
  private meshes: THREE.InstancedMesh[] = [];
  private attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  private material: THREE.ShaderMaterial[] = [];
  private points: THREE.Points;
  private pointPos: THREE.BufferAttribute;
  private pointCol: THREE.BufferAttribute;
  private pointMat: THREE.ShaderMaterial;
  count = 0;

  constructor() {
    this.pointMat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 6 }, uDaylight: { value: 1 } },
      vertexShader: `uniform float uSize; attribute vec3 color; varying vec3 vC;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.); gl_Position = projectionMatrix * mv; gl_PointSize = uSize; }`,
      fragmentShader: `uniform float uDaylight; varying vec3 vC; void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d,d) > 0.25) discard;
        gl_FragColor = vec4(vC * (0.45 + 0.55*uDaylight), 1.); }`,
    });
    this.pointPos = new THREE.BufferAttribute(new Float32Array(0), 3);
    this.pointCol = new THREE.BufferAttribute(new Float32Array(0), 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', this.pointPos);
    pg.setAttribute('color', this.pointCol);
    this.points = new THREE.Points(pg, this.pointMat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.ensure(512);
  }

  private ensure(n: number): void {
    if (n <= this.capacity) return;
    let cap = Math.max(512, this.capacity);
    while (cap < n) cap *= 2;
    for (const m of this.meshes) {
      this.group.remove(m);
      m.dispose();
    }
    this.meshes = [];
    this.material = [];
    const mk = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage);
    this.attrs = { iPos: mk(3), iAnim: mk(4), iBody: mk(4), iCloth: mk(3), iSkin: mk(3), iHair: mk(3), iMisc: mk(4) };
    const paintColors = ['#f4efe2', '#c9422f', '#1c1a18', '#e2a33b', '#3b6fb0', '#d9d9d9', '#7a3f8f', '#2f8f5f'].map((h) => new THREE.Color(h));
    for (let part = 0; part <= PART_HEADDRESS; part++) {
      const geo = partGeometry(part);
      for (const [k, a] of Object.entries(this.attrs)) geo.setAttribute(k, a);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uPart: { value: part }, uDaylight: { value: 1 }, uPaintColors: { value: paintColors } },
        vertexShader: VERT,
        fragmentShader: FRAG,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.meshes.push(mesh);
      this.material.push(mat);
      this.group.add(mesh);
    }
    this.pointPos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.pointCol = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.points.geometry.setAttribute('position', this.pointPos);
    this.points.geometry.setAttribute('color', this.pointCol);
    this.capacity = cap;
  }

  /** Writes all instances for this frame. `lod` = points only (world zoom / chronicle mode). */
  set(instances: HumanInstance[], lod: boolean, pointColors: THREE.Color[], headdressCount: number): void {
    const n = instances.length;
    this.ensure(n);
    this.count = n;
    const a = this.attrs;
    const P = a.iPos.array as Float32Array;
    const A = a.iAnim.array as Float32Array;
    const B = a.iBody.array as Float32Array;
    const C = a.iCloth.array as Float32Array;
    const S = a.iSkin.array as Float32Array;
    const Hh = a.iHair.array as Float32Array;
    const M = a.iMisc.array as Float32Array;
    const pp = this.pointPos.array as Float32Array;
    const pc = this.pointCol.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const h = instances[i];
      P[i * 3] = h.x; P[i * 3 + 1] = h.y; P[i * 3 + 2] = h.z;
      A[i * 4] = h.heading; A[i * 4 + 1] = h.phase; A[i * 4 + 2] = h.speed; A[i * 4 + 3] = h.gesture;
      B[i * 4] = h.scale; B[i * 4 + 1] = h.fem; B[i * 4 + 2] = h.hunch; B[i * 4 + 3] = h.belly;
      C[i * 3] = h.cloth.r; C[i * 3 + 1] = h.cloth.g; C[i * 3 + 2] = h.cloth.b;
      S[i * 3] = h.skin.r; S[i * 3 + 1] = h.skin.g; S[i * 3 + 2] = h.skin.b;
      Hh[i * 3] = h.hair.r; Hh[i * 3 + 1] = h.hair.g; Hh[i * 3 + 2] = h.hair.b;
      M[i * 4] = h.paint; M[i * 4 + 1] = h.limp; M[i * 4 + 2] = h.pallor; M[i * 4 + 3] = h.headdress;
      pp[i * 3] = h.x; pp[i * 3 + 1] = h.y + 0.3; pp[i * 3 + 2] = h.z;
      const col = pointColors[i];
      pc[i * 3] = col.r; pc[i * 3 + 1] = col.g; pc[i * 3 + 2] = col.b;
    }
    for (const attr of Object.values(a)) {
      attr.needsUpdate = true;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
    }
    this.pointPos.needsUpdate = true;
    this.pointCol.needsUpdate = true;
    this.points.geometry.setDrawRange(0, lod ? n : 0);
    for (let part = 0; part < this.meshes.length; part++) {
      // Headdress instances: leaders are sorted to the front by the caller.
      this.meshes[part].count = lod ? 0 : part === PART_HEADDRESS ? headdressCount : n;
    }
  }

  update(time: number, daylight: number, pointSize: number): void {
    for (const m of this.material) {
      m.uniforms.uTime.value = time;
      m.uniforms.uDaylight.value = daylight;
    }
    this.pointMat.uniforms.uSize.value = pointSize;
    this.pointMat.uniforms.uDaylight.value = daylight;
  }
}
