import {
  fastModeProviderValue,
  routeSupportsNativeFastModeIdentity,
  withModelSelectionFastMode,
  type ContinuationIdentity,
  type ModelSelection,
} from "../../../shared/model-routing";
import type { ModelFavoriteConfiguration, ModelSearchRoute } from "./modelSearch";
export type { ModelFavoriteConfiguration } from "./modelSearch";

export const MODEL_FAVORITES_STORAGE_KEY = "inertia:model-favorites:v2";
export const MAX_MODEL_FAVORITES = 24;

const LEGACY_MODEL_FAVORITES_STORAGE_KEY = "inertia:model-favorites:v1";
const MAX_STORED_FAVORITES_BYTES = 32_768;
const boundedIdentity = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;
const boundedReasoningEffort = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

export type ModelFavoriteReference = Pick<
  ModelSelection,
  "harnessId" | "backendProfileId" | "modelId" | "reasoningEffort"
> & { configuration?: ModelFavoriteConfiguration };

export interface ModelFavoriteStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface ResolvedModelFavorite<Route extends ModelSearchRoute> {
  key: string;
  reference: ModelFavoriteReference;
  route: Route | null;
}

function parsedReference(
  value: unknown,
  legacy = false,
): ModelFavoriteReference | null {
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
    || (
      !legacy
      && candidate.reasoningEffort !== null
      && (
        typeof candidate.reasoningEffort !== "string"
        || !boundedReasoningEffort.test(candidate.reasoningEffort)
      )
    )
  ) {
    return null;
  }
  let configuration: ModelFavoriteConfiguration | undefined;
  if (!legacy && candidate.configuration !== undefined) {
    if (!candidate.configuration || typeof candidate.configuration !== "object") return null;
    const saved = candidate.configuration as Record<string, unknown>;
    if (
      !["supervised", "auto-edit", "full"].includes(saved.accessMode as string)
      || !["build", "plan"].includes(saved.interactionMode as string)
      || (saved.fastMode !== undefined && typeof saved.fastMode !== "boolean")
      || (saved.fastMode !== undefined && !routeSupportsNativeFastModeIdentity({
        harnessId: candidate.harnessId,
        backendProfileId: candidate.backendProfileId,
      }))
    ) return null;
    configuration = {
      accessMode: saved.accessMode as ModelFavoriteConfiguration["accessMode"],
      interactionMode: saved.interactionMode as ModelFavoriteConfiguration["interactionMode"],
      ...(saved.fastMode !== undefined ? { fastMode: saved.fastMode as boolean } : {}),
    };
  }
  return {
    harnessId: candidate.harnessId,
    backendProfileId: candidate.backendProfileId,
    modelId: candidate.modelId,
    reasoningEffort: legacy
      ? null
      : candidate.reasoningEffort as string | null,
    ...(configuration ? { configuration } : {}),
  };
}

function normalizedReferences(
  values: readonly unknown[],
  legacy = false,
): ModelFavoriteReference[] {
  const seen = new Set<string>();
  const references: ModelFavoriteReference[] = [];
  for (const value of values) {
    const reference = parsedReference(value, legacy);
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
    reference.reasoningEffort,
    ...(reference.configuration ? [reference.configuration.accessMode,
      reference.configuration.interactionMode, reference.configuration.fastMode ?? null] : []),
  ]);
}

export function modelRouteIdentityKey(
  reference: Pick<
    ModelFavoriteReference,
    "harnessId" | "backendProfileId" | "modelId"
  >,
): string {
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
    const current = storage.getItem(MODEL_FAVORITES_STORAGE_KEY);
    const legacy = current
      ? false
      : true;
    const raw = current
      ?? storage.getItem(LEGACY_MODEL_FAVORITES_STORAGE_KEY);
    if (!raw || raw.length > MAX_STORED_FAVORITES_BYTES) return [];
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object") return [];
    const record = payload as Record<string, unknown>;
    if (
      record.version !== (legacy ? 1 : 2)
      || !Array.isArray(record.favorites)
    ) return [];
    return normalizedReferences(record.favorites, legacy);
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
      version: 2,
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
      modelRouteIdentityKey(route),
      route,
    ]),
  );
  return normalizedReferences(favorites).map((reference) => {
    const key = modelFavoriteKey(reference);
    const baseRoute = routesByKey.get(modelRouteIdentityKey(reference)) ?? null;
    const reasoningOptions = baseRoute?.reasoningOptions;
    const reasoningSupported = reference.reasoningEffort === null
      || (
        Array.isArray(reasoningOptions)
        && reasoningOptions.includes(reference.reasoningEffort)
      );
    const fastSupported = reference.configuration?.fastMode !== true
      || (baseRoute && "supportsNativeFastModeControl" in baseRoute
        && baseRoute.supportsNativeFastModeControl === true);
    let selection = baseRoute && "selection" in baseRoute
      ? { ...(baseRoute.selection as ModelSelection), reasoningEffort: reference.reasoningEffort }
      : null;
    if (selection && reference.configuration?.fastMode !== undefined) {
      selection = withModelSelectionFastMode(selection, reference.configuration.fastMode
        ? reference.harnessId === "codex-app-server" ? "priority" : "fast"
        : null);
    }
    const route = baseRoute && reasoningSupported && fastSupported
      ? {
          ...baseRoute,
          key,
          reasoningEffort: reference.reasoningEffort,
          configuration: reference.configuration,
          ...(selection ? { selection } : {}),
          ...(reference.configuration?.fastMode !== undefined && selection ? {
            responseSpeed: reference.configuration.fastMode ? "Fast" : "Standard",
            speedChangeNote: undefined,
            ...("continuationIdentity" in baseRoute ? {
              continuationIdentity: {
                ...(baseRoute.continuationIdentity as ContinuationIdentity),
                performanceModeIdentity: fastModeProviderValue(selection)
                  ? `fast:${fastModeProviderValue(selection)}` : null,
              },
            } : {}),
          } : {}),
        } as Route
      : null;
    return {
      key,
      reference,
      route,
    };
  });
}
