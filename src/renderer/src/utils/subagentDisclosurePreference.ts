const STORAGE_PREFIX = "inertia:subagent-disclosure:v1:";
const MAX_STORED_OPEN_DISCLOSURES = 256;

export interface SubagentDisclosurePreferenceIdentity {
  conversationId: string;
  turnId: string;
}

function storageKey({
  conversationId,
  turnId,
}: SubagentDisclosurePreferenceIdentity): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(conversationId)}:${encodeURIComponent(turnId)}`;
}

function storedTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

export function readSubagentDisclosureOpen(
  storage: Storage,
  identity: SubagentDisclosurePreferenceIdentity,
): boolean {
  try {
    return storedTimestamp(storage.getItem(storageKey(identity))) !== null;
  } catch {
    return false;
  }
}

function pruneStoredOpenDisclosures(storage: Storage): void {
  const entries: Array<{ key: string; updatedAt: number }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    entries.push({
      key,
      updatedAt: storedTimestamp(storage.getItem(key)) ?? 0,
    });
  }
  if (entries.length <= MAX_STORED_OPEN_DISCLOSURES) return;
  entries.sort((left, right) => (
    left.updatedAt - right.updatedAt || left.key.localeCompare(right.key)
  ));
  for (const { key } of entries.slice(
    0,
    entries.length - MAX_STORED_OPEN_DISCLOSURES,
  )) {
    storage.removeItem(key);
  }
}

export function writeSubagentDisclosureOpen(
  storage: Storage,
  identity: SubagentDisclosurePreferenceIdentity,
  open: boolean,
  updatedAt = Date.now(),
): void {
  try {
    const key = storageKey(identity);
    if (!open) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, String(Math.max(1, Math.trunc(updatedAt))));
    pruneStoredOpenDisclosures(storage);
  } catch {
    // This preference is best effort in hardened or quota-limited renderers.
  }
}
