export interface BoundedCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
}

export function createBoundedCache<V>(
  maxEntries: number,
  maxWeight: number,
  weigh: (key: string, value: V) => number,
): BoundedCache<V> {
  const entries = new Map<string, { value: V; weight: number }>();
  let totalWeight = 0;
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      const previous = entries.get(key);
      if (previous) {
        entries.delete(key);
        totalWeight -= previous.weight;
      }
      const weight = weigh(key, value);
      if (weight > maxWeight) return;
      entries.set(key, { value, weight });
      totalWeight += weight;
      for (const [oldestKey, oldest] of entries) {
        if (entries.size <= maxEntries && totalWeight <= maxWeight) break;
        entries.delete(oldestKey);
        totalWeight -= oldest.weight;
      }
    },
  };
}
