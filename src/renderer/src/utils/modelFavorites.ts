import type { ModelSelection } from "../../../shared/model-routing";
import type { ModelSearchRoute } from "./modelSearch";

export const MODEL_FAVORITES_STORAGE_KEY = "inertia:model-favorites:v1";
export const MAX_MODEL_FAVORITES = 24;

const MAX_STORED_FAVORITES_BYTES = 32_768;
const boundedIdentity = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;

export type ModelFavoriteReference = Pick<
  ModelSelection,
  "harnessId" | "backendProfileId" | "modelId"
>;

export interface ModelFavoriteStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface ResolvedModelFavorite<Route extends ModelSearchRoute> {
  key: string;
  reference: ModelFavoriteReference;
  route: Route | null;
}

function parsedReference(value: unknown): ModelFavoriteReference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.harnessId !== "string"
    || !boundedIdentity.test(candidate.harnessId)
    || typeof candidate.backendProfileId !== "string"
    || !boundedIdentity.test(candidate.backendProfileId)
    || typeof candidate.modelId !== "string"
    || candidate.modelId.length === 0
    || candidate.modelId.length > 300
    || candidate.modelId.trim().length === 0
  ) {
    return null;
  }
  return {
    harnessId: candidate.harnessId,
    backendProfileId: candidate.backendProfileId,
    modelId: candidate.modelId,
  };
}

function normalizedReferences(
  values: readonly unknown[],
): ModelFavoriteReference[] {
  const seen = new Set<string>();
  const references: ModelFavoriteReference[] = [];
  for (const value of values) {
    const reference = parsedReference(value);
    if (!reference) continue;
    const key = modelFavoriteKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
    if (references.length === MAX_MODEL_FAVORITES) break;
  }
  return references;
}

export function modelFavoriteReference(
  selection: ModelFavoriteReference,
): ModelFavoriteReference {
  const reference = parsedReference(selection);
  if (!reference) throw new Error("Invalid model favorite identity.");
  return reference;
}

export function modelFavoriteKey(reference: ModelFavoriteReference): string {
  return JSON.stringify([
    reference.harnessId,
    reference.backendProfileId,
    reference.modelId,
  ]);
}

export function readModelFavorites(
  storage: Pick<ModelFavoriteStorage, "getItem">,
): ModelFavoriteReference[] {
  try {
    const raw = storage.getItem(MODEL_FAVORITES_STORAGE_KEY);
    if (!raw || raw.length > MAX_STORED_FAVORITES_BYTES) return [];
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object") return [];
    const record = payload as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.favorites)) return [];
    return normalizedReferences(record.favorites);
  } catch {
    return [];
  }
}

export function writeModelFavorites(
  storage: Pick<ModelFavoriteStorage, "setItem">,
  favorites: readonly ModelFavoriteReference[],
): boolean {
  try {
    const normalized = normalizedReferences(favorites);
    storage.setItem(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify({
      version: 1,
      favorites: normalized,
    }));
    return true;
  } catch {
    return false;
  }
}

export function toggleModelFavorite(
  favorites: readonly ModelFavoriteReference[],
  favorite: ModelFavoriteReference,
): ModelFavoriteReference[] {
  const current = normalizedReferences(favorites);
  const reference = modelFavoriteReference(favorite);
  const key = modelFavoriteKey(reference);
  const existingIndex = current.findIndex(
    (candidate) => modelFavoriteKey(candidate) === key,
  );
  if (existingIndex >= 0) {
    return current.filter((_, index) => index !== existingIndex);
  }
  return [...current, reference].slice(-MAX_MODEL_FAVORITES);
}

export function resolveModelFavorites<Route extends ModelSearchRoute>(
  favorites: readonly ModelFavoriteReference[],
  routes: readonly Route[],
): ResolvedModelFavorite<Route>[] {
  const routesByKey = new Map(
    routes.map((route) => [
      modelFavoriteKey(route),
      route,
    ]),
  );
  return normalizedReferences(favorites).map((reference) => {
    const key = modelFavoriteKey(reference);
    return {
      key,
      reference,
      route: routesByKey.get(key) ?? null,
    };
  });
}
