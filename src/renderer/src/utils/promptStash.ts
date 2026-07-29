import type { ModelSelection } from "../../../shared/model-routing";
import { MAX_CHAT_MESSAGE_CHARS } from "../../../shared/diff-review";

export const PROMPT_STASH_STORAGE_KEY = "inertia:prompt-stash:v1";
export const PROMPT_STASH_CHANGED_EVENT = "inertia:prompt-stash-changed";
export const MAX_PROMPT_STASH_ENTRIES = 12;

const MAX_STORED_PROMPT_STASH_BYTES = 256 * 1024;
const boundedIdentity = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;
const boundedEntryId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type PromptStashRoute = Pick<
  ModelSelection,
  "harnessId" | "backendProfileId" | "modelId" | "reasoningEffort"
>;

export interface PromptStashEntry {
  id: string;
  content: string;
  createdAt: string;
  route: PromptStashRoute;
}

export interface PromptStashStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function promptStashRouteMatches(
  selection: PromptStashRoute,
  route: PromptStashRoute,
): boolean {
  return selection.harnessId === route.harnessId
    && selection.backendProfileId === route.backendProfileId
    && selection.modelId === route.modelId
    && selection.reasoningEffort === route.reasoningEffort;
}

function parsedRoute(value: unknown): PromptStashRoute | null {
  if (!value || typeof value !== "object") return null;
  const route = value as Record<string, unknown>;
  if (
    typeof route.harnessId !== "string"
    || !boundedIdentity.test(route.harnessId)
    || typeof route.backendProfileId !== "string"
    || !boundedIdentity.test(route.backendProfileId)
    || typeof route.modelId !== "string"
    || route.modelId.trim().length === 0
    || route.modelId.length > 300
    || (
      route.reasoningEffort !== null
      && (
        typeof route.reasoningEffort !== "string"
        || route.reasoningEffort.length > 100
      )
    )
  ) return null;
  return {
    harnessId: route.harnessId,
    backendProfileId: route.backendProfileId,
    modelId: route.modelId,
    reasoningEffort: route.reasoningEffort as string | null,
  };
}

function parsedEntry(value: unknown): PromptStashEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const route = parsedRoute(entry.route);
  if (
    typeof entry.id !== "string"
    || !boundedEntryId.test(entry.id)
    || typeof entry.content !== "string"
    || entry.content.trim().length === 0
    || entry.content.length > MAX_CHAT_MESSAGE_CHARS
    || typeof entry.createdAt !== "string"
    || !Number.isFinite(Date.parse(entry.createdAt))
    || !route
  ) return null;
  return {
    id: entry.id,
    content: entry.content,
    createdAt: entry.createdAt,
    route,
  };
}

function normalizedEntries(values: readonly unknown[]): PromptStashEntry[] {
  const seen = new Set<string>();
  const entries: PromptStashEntry[] = [];
  for (const value of values) {
    const entry = parsedEntry(value);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length === MAX_PROMPT_STASH_ENTRIES) break;
  }
  return entries;
}

function storedPayload(entries: readonly PromptStashEntry[]): string {
  return JSON.stringify({ version: 1, entries });
}

function storageBoundedEntries(
  values: readonly unknown[],
): PromptStashEntry[] {
  const entries: PromptStashEntry[] = [];
  for (const entry of normalizedEntries(values)) {
    const candidate = [...entries, entry];
    if (
      new TextEncoder().encode(storedPayload(candidate)).byteLength
      > MAX_STORED_PROMPT_STASH_BYTES
    ) break;
    entries.push(entry);
  }
  return entries;
}

export function readPromptStash(
  storage: Pick<PromptStashStorage, "getItem">,
): PromptStashEntry[] {
  try {
    const raw = storage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (
      !raw
      || new TextEncoder().encode(raw).byteLength
        > MAX_STORED_PROMPT_STASH_BYTES
    ) return [];
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object") return [];
    const record = payload as Record<string, unknown>;
    return record.version === 1 && Array.isArray(record.entries)
      ? storageBoundedEntries(record.entries)
      : [];
  } catch {
    return [];
  }
}

export function writePromptStash(
  storage: Pick<PromptStashStorage, "setItem">,
  entries: readonly PromptStashEntry[],
): boolean {
  try {
    storage.setItem(
      PROMPT_STASH_STORAGE_KEY,
      storedPayload(storageBoundedEntries(entries)),
    );
    return true;
  } catch {
    return false;
  }
}

export function persistPromptStashUpdate(
  storage: Pick<PromptStashStorage, "setItem">,
  current: readonly PromptStashEntry[],
  update: (entries: readonly PromptStashEntry[]) => PromptStashEntry[],
): PromptStashEntry[] | null {
  const next = update(current);
  return writePromptStash(storage, next) ? next : null;
}

export function addPromptStashEntry(
  entries: readonly PromptStashEntry[],
  content: string,
  selection: PromptStashRoute,
  options: { id?: string; now?: string } = {},
): PromptStashEntry[] {
  const normalizedContent = content.trim();
  if (
    !normalizedContent
    || normalizedContent.length > MAX_CHAT_MESSAGE_CHARS
  ) return normalizedEntries(entries);
  const route = parsedRoute(selection);
  if (!route) return normalizedEntries(entries);
  const entry = parsedEntry({
    id: options.id ?? crypto.randomUUID(),
    content: normalizedContent,
    createdAt: options.now ?? new Date().toISOString(),
    route,
  });
  if (!entry) return normalizedEntries(entries);
  return storageBoundedEntries([entry, ...normalizedEntries(entries)]);
}

export function removePromptStashEntry(
  entries: readonly PromptStashEntry[],
  entryId: string,
): PromptStashEntry[] {
  return storageBoundedEntries(entries).filter(({ id }) => id !== entryId);
}
