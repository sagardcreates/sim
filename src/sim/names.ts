/**
 * Procedural syllable names (§6). Each clan gets its own syllable set, so
 * names carry a clan "accent"; children draw from their clan's set.
 */
import { Rng } from './rng';

const ONSETS = ['', 'b', 'd', 'g', 'h', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'z', 'sh', 'th', 'kr', 'tr', 'dr'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'aa', 'ei', 'ou'];
const CODAS = ['', '', '', 'n', 'r', 'l', 's', 'k', 'm'];

export interface SyllableSet {
  syllables: string[];
}

export function makeSyllableSet(rng: Rng, size = 10): SyllableSet {
  const set = new Set<string>();
  while (set.size < size) set.add(rng.pick(ONSETS) + rng.pick(VOWELS) + rng.pick(CODAS));
  return { syllables: [...set] };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function makePersonName(rng: Rng, set: SyllableSet): string {
  const n = rng.chance(0.6) ? 2 : rng.chance(0.7) ? 1 : 3;
  let s = '';
  for (let i = 0; i < n; i++) s += rng.pick(set.syllables);
  if (s.length < 3) s += rng.pick(set.syllables);
  return capitalize(s);
}

export function makeClanName(rng: Rng, set: SyllableSet): string {
  const suffixes = ['i', 'ari', 'en', 'oth', 'ani', 'uk'];
  return capitalize(rng.pick(set.syllables) + rng.pick(set.syllables) + rng.pick(suffixes));
}
