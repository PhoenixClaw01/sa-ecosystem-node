/** Short in-memory cache. Entries die with the process and after the TTL. */
export function createTtlCache<T>(ttlMs: number, maxEntries: number): {
  get(key: string, now: number): T | undefined;
  set(key: string, value: T, now: number): void;
} {
  const entries = new Map<string, { at: number; value: T }>();
  return {
    get(key: string, now: number): T | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now - hit.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: T, now: number): void {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, { at: now, value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
