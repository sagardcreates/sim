/** Deep-merge plain objects (arrays and scalars replace). */
export function mergeDeep(a: unknown, b: unknown): unknown {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b === undefined ? a : b;
  const o: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) o[k] = mergeDeep(o[k], v);
  return o;
}
