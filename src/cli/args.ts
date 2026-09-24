/** Minimal `--key value` / `--flag` parser. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Parses "1..50", "1,4,7" or "3". */
export function parseSeeds(spec: string): number[] {
  const range = /^(\d+)\.\.(\d+)$/.exec(spec);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }
  return spec.split(',').map((s) => Number(s.trim()));
}
