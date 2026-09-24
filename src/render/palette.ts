/** Colors shared by the renderer and UI. Purely visual. */
import * as THREE from 'three';

export const CLAN_COLORS = [
  '#d9573f', '#e3b341', '#4f9fe0', '#b46fd6', '#3fb8a8', '#8cc152', '#e08a3c', '#e8e2d0',
  '#f27ab2', '#5ad1e8', '#c9a26b', '#9aa7ff', '#ff8e6e', '#7fdc9a', '#d4d46a', '#b0b0b0',
];

export function clanColor(id: number): string {
  return id < 0 ? '#8a857a' : CLAN_COLORS[(id - 1) % CLAN_COLORS.length];
}

export function clanColor3(id: number): THREE.Color {
  return new THREE.Color(clanColor(id));
}

/** Biome base colors: grassland, forest, hills, scrub, water. */
export const BIOME = [
  new THREE.Color('#8fb35a'), new THREE.Color('#4d7f3a'), new THREE.Color('#9a8d6c'),
  new THREE.Color('#c9b777'), new THREE.Color('#3f79a6'),
];
export const DRY = new THREE.Color('#c8b56a');
export const WINTER = new THREE.Color('#a9a58c');
export const DIRT = new THREE.Color('#8a6a45');

/** Body-paint palettes for marker patterns (marker id -> color). */
export const PAINT = ['#f4efe2', '#c9422f', '#1c1a18', '#e2a33b', '#3b6fb0', '#d9d9d9', '#7a3f8f', '#2f8f5f'];
