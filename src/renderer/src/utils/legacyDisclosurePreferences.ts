const LEGACY_PREFIX = "inertia:subagent-disclosure:v1:";
const MAX_SCANNED_KEYS = 4_096;

export function removeLegacyDisclosurePreferences(storage: () => Storage): void {
  try {
    const store = storage();
    const keys: string[] = [];
    for (let index = 0; index < Math.min(store.length, MAX_SCANNED_KEYS); index += 1) {
      const key = store.key(index);
      if (key?.startsWith(LEGACY_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    return;
  }
}
