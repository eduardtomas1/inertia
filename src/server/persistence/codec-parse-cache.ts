import type {
  ContinuationIdentity,
  ModelSelection,
} from "../../shared/contracts";
import {
  modelSelectionSchema,
  versionedContinuationIdentitySchema,
} from "../../shared/model-routing";

export const MAX_CODEC_PARSE_CACHE_ENTRIES = 256;

const modelSelectionCache = new Map<string, ModelSelection | null>();
const continuationIdentityCache = new Map<string, ContinuationIdentity | null>();

function cloneJsonValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item)) as unknown as T;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneJsonValue(entry);
  }
  return copy as T;
}

function cloneModelSelection(selection: ModelSelection): ModelSelection {
  return {
    ...selection,
    providerOptions: cloneJsonValue(selection.providerOptions),
    capabilities: cloneJsonValue(selection.capabilities),
  };
}

function cloneContinuationIdentity(
  identity: ContinuationIdentity,
): ContinuationIdentity {
  return { ...identity };
}

function lruGet<T>(cache: Map<string, T>, key: string): { hit: true; value: T } | { hit: false } {
  if (!cache.has(key)) return { hit: false };
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return { hit: true, value };
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CODEC_PARSE_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(key, value);
}

/**
 * Memoizes validated `ModelSelection` parses by raw JSON string. Most chats
 * and turns share a handful of identical model selection payloads, so skipping
 * repeated `JSON.parse` + Zod validation eliminates the dominant per-row cost
 * of `shellSnapshot()`.
 */
export function parseCachedModelSelectionJson(
  value: string,
): ModelSelection | null {
  const cached = lruGet(modelSelectionCache, value);
  if (cached.hit) {
    return cached.value ? cloneModelSelection(cached.value) : null;
  }
  let resolved: ModelSelection | null = null;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    if (parsed.success) resolved = parsed.data;
  } catch {
    // Preserve readable historical state through the safe flattened fallback.
  }
  lruSet(modelSelectionCache, value, resolved);
  return resolved ? cloneModelSelection(resolved) : null;
}

/**
 * Memoizes validated `ContinuationIdentity` parses by raw JSON string.
 */
export function parseCachedContinuationIdentityJson(
  value: string,
): ContinuationIdentity | null {
  const cached = lruGet(continuationIdentityCache, value);
  if (cached.hit) {
    return cached.value ? cloneContinuationIdentity(cached.value) : null;
  }
  let resolved: ContinuationIdentity | null = null;
  try {
    const parsed = versionedContinuationIdentitySchema.safeParse(JSON.parse(value));
    if (parsed.success) resolved = parsed.data;
  } catch {
    // A persisted but unreadable identity must never be guessed.
  }
  lruSet(continuationIdentityCache, value, resolved);
  return resolved ? cloneContinuationIdentity(resolved) : null;
}

export function clearCodecParseCaches(): void {
  modelSelectionCache.clear();
  continuationIdentityCache.clear();
}
