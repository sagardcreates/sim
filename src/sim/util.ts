/** Deep clone for JSON-safe sim data (structuredClone is a host API, not ES). */
export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
