import {
  providerIdForHarness,
  providerNativeBackendProfile,
} from "../model-routing";
import type { ProviderId } from "../provider";
import {
  ROUTING_PROVIDER_IDS,
  ROUTING_TIERS,
  type RoutingPreset,
  type RoutingSettings,
  type RoutingTier,
} from "./routing-policy";

export interface RoutingCatalogModel {
  id: string;
  label: string;
  isDefault: boolean;
  vision: boolean;
  reasoningOptions: readonly string[];
  defaultReasoningEffort: string | null;
  fastMode: boolean;
}

/** One provider route (a native provider or a custom backend) as Auto routing sees it. */
export interface RoutingCatalogEntry {
  providerId: ProviderId;
  backendProfileId: string;
  label: string;
  native: boolean;
  /** Signed in (or configured) and runnable right now. */
  ready: boolean;
  /** A temporary probe state (install or sign-in check, unresponsive CLI); readiness may return shortly. */
  checking: boolean;
  usageLimited: boolean;
  /** Lowest remaining percentage across the account's usage windows, when known. */
  remainingPercent: number | null;
  models: readonly RoutingCatalogModel[];
}

/** Structural subset of ProviderInfo; kept local so shared modules stay acyclic. */
export interface RoutingProviderSource {
  id: ProviderId;
  label: string;
  available: boolean;
  installState: string;
  authState: string;
  canRun: boolean;
  models: readonly {
    id: string;
    label: string;
    isDefault: boolean;
    inputModalities: readonly string[];
    reasoningOptions: readonly { value: string }[];
    defaultReasoningEffort: string;
    fastMode?: { providerValue: string } | null;
  }[];
  rateLimits: readonly { remainingPercent: number }[];
}

/** Structural subset of ModelBackendProfileView. */
export interface RoutingBackendProfileSource {
  id: string;
  harnessId: string;
  displayName: string;
  enabled: boolean;
  authState: string;
  connectionState: string;
  models: readonly {
    id: string;
    displayName: string;
    reasoningOptions: readonly { value: string }[];
    capabilities: readonly { id: string; state: string }[];
  }[];
}

const SIGNED_IN_AUTH_STATES = new Set(["authenticated", "configured", "unknown"]);
const READY_BACKEND_AUTH_STATES = new Set(["harness-managed", "not-required", "configured"]);
const TEMPORARY_INSTALL_STATES = new Set(["checking", "unresponsive"]);

function providerChecking(provider: Pick<RoutingProviderSource, "installState" | "authState"> | undefined): boolean {
  return provider !== undefined
    && (TEMPORARY_INSTALL_STATES.has(provider.installState) || provider.authState === "checking");
}

function providerReady(provider: RoutingProviderSource): boolean {
  return provider.available
    && provider.installState === "installed"
    && provider.canRun
    && SIGNED_IN_AUTH_STATES.has(provider.authState);
}

function remainingPercent(rateLimits: RoutingProviderSource["rateLimits"]): number | null {
  const values = rateLimits
    .map(({ remainingPercent: value }) => value)
    .filter((value) => Number.isFinite(value));
  return values.length === 0 ? null : Math.max(0, Math.min(100, Math.min(...values)));
}

function nativeEntry(provider: RoutingProviderSource): RoutingCatalogEntry {
  const remaining = remainingPercent(provider.rateLimits);
  return {
    providerId: provider.id,
    backendProfileId: providerNativeBackendProfile(provider.id).id,
    label: provider.label,
    native: true,
    ready: providerReady(provider),
    checking: providerChecking(provider),
    usageLimited: remaining !== null && remaining <= 0,
    remainingPercent: remaining,
    models: provider.models.map((model) => {
      const reasoningOptions = model.reasoningOptions.map(({ value }) => value);
      return {
        id: model.id,
        label: model.label || model.id,
        isDefault: model.isDefault,
        vision: model.inputModalities.includes("image"),
        reasoningOptions,
        defaultReasoningEffort: reasoningOptions.includes(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : null,
        fastMode: Boolean(model.fastMode?.providerValue),
      };
    }),
  };
}

function backendEntry(
  profile: RoutingBackendProfileSource,
  providers: readonly RoutingProviderSource[],
): RoutingCatalogEntry | null {
  const providerId = providerIdForHarness(profile.harnessId);
  if (!providerId || !(ROUTING_PROVIDER_IDS as readonly string[]).includes(providerId)) return null;
  if (profile.id === providerNativeBackendProfile(providerId).id) return null;
  const host = providers.find(({ id }) => id === providerId);
  return {
    providerId,
    backendProfileId: profile.id,
    label: profile.displayName,
    native: false,
    ready: profile.enabled
      && READY_BACKEND_AUTH_STATES.has(profile.authState)
      && profile.connectionState !== "failed"
      && Boolean(host?.available && host.installState === "installed"),
    checking: profile.authState === "checking" || profile.connectionState === "testing" || providerChecking(host),
    usageLimited: false,
    remainingPercent: null,
    models: profile.models.map((model, index) => {
      const images = model.capabilities.find(({ id }) => id === "images");
      return {
        id: model.id,
        label: model.displayName || model.id,
        isDefault: index === 0,
        vision: images !== undefined && images.state !== "unknown" && images.state !== "unavailable",
        reasoningOptions: model.reasoningOptions.map(({ value }) => value),
        defaultReasoningEffort: null,
        fastMode: false,
      };
    }),
  };
}

/** Builds the same catalog in the runtime and in the Settings preview. */
export function routingCatalogFromProviders(
  providers: readonly RoutingProviderSource[],
  backendProfiles: readonly RoutingBackendProfileSource[] = [],
): RoutingCatalogEntry[] {
  return [
    ...providers
      .filter(({ id }) => (ROUTING_PROVIDER_IDS as readonly string[]).includes(id))
      .map(nativeEntry),
    ...backendProfiles.flatMap((profile) => {
      const entry = backendEntry(profile, providers);
      return entry ? [entry] : [];
    }),
  ];
}

const LOW_TOKENS = new Set(["mini", "nano", "haiku", "flash", "lite", "small", "fast"]);
const TOP_TOKENS = new Set(["fable", "astra", "max", "ultra"]);
const HIGH_TOKENS = new Set(["opus", "sol", "pro", "large"]);
const MID_TOKENS = new Set(["sonnet", "terra", "default", "medium"]);

function modelTokens(model: Pick<RoutingCatalogModel, "id" | "label">): Set<string> {
  return new Set(`${model.id} ${model.label}`.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
}

/**
 * Capability heuristic over a provider's advertised models: 1 low, 2 mid,
 * 3 high, 4 top. Unrecognised names rank by position around the provider
 * default, which stays mid; earlier entries rank slightly higher.
 */
export function routingModelRank(
  model: Pick<RoutingCatalogModel, "id" | "label">,
  index: number,
  defaultIndex: number,
): number {
  const tokens = modelTokens(model);
  const has = (set: ReadonlySet<string>): boolean => [...tokens].some((token) => set.has(token));
  if (has(LOW_TOKENS)) return 1;
  if (has(TOP_TOKENS)) return 4;
  if (has(HIGH_TOKENS)) return 3;
  if (has(MID_TOKENS) || index === defaultIndex) return 2;
  return Math.max(1.1, Math.min(2.9, 2 + (defaultIndex - index) * 0.1));
}

const EFFORT_RANKS: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

function effortRank(value: string, index: number): number {
  return EFFORT_RANKS[value.toLowerCase()] ?? index;
}

function effortExtreme(options: readonly string[], highest: boolean): string | null {
  if (options.length === 0) return null;
  const ranked = options.map((value, index) => ({ value, rank: effortRank(value, index) }));
  ranked.sort((left, right) => highest ? right.rank - left.rank : left.rank - right.rank);
  return ranked[0]!.value;
}

function heavyEffort(options: readonly string[]): string | null {
  return options.find((value) => value.toLowerCase() === "high") ?? effortExtreme(options, true);
}

function defaultModelIndex(models: readonly RoutingCatalogModel[]): number {
  const index = models.findIndex(({ isDefault }) => isDefault);
  return index >= 0 ? index : 0;
}

function rankedModels(entry: RoutingCatalogEntry): Array<{ model: RoutingCatalogModel; rank: number; index: number }> {
  const defaultIndex = defaultModelIndex(entry.models);
  return entry.models.map((model, index) => ({ model, index, rank: routingModelRank(model, index, defaultIndex) }));
}

function preset(
  entry: RoutingCatalogEntry,
  model: RoutingCatalogModel,
  reasoningEffort: string | null,
  weight: RoutingPreset["weight"],
): RoutingPreset {
  return {
    providerId: entry.providerId,
    backendProfileId: entry.backendProfileId,
    modelId: model.id,
    reasoningEffort,
    fastMode: false,
    weight,
  };
}

/**
 * Derives one preset per tier for every native provider that advertises
 * models. The user's default provider is preferred and listed first.
 */
export function deriveDefaultRoutingPresets(
  catalog: readonly RoutingCatalogEntry[],
  defaultProvider: ProviderId,
): Record<RoutingTier, RoutingPreset[]> {
  const result: Record<RoutingTier, RoutingPreset[]> = { light: [], standard: [], heavy: [], max: [] };
  const entries = catalog
    .filter((entry) => entry.native && entry.models.length > 0)
    .sort((left, right) => Number(right.providerId === defaultProvider) - Number(left.providerId === defaultProvider));
  for (const entry of entries) {
    const weight = entry.providerId === defaultProvider ? "prefer" : "normal";
    const ranked = rankedModels(entry);
    const lowest = [...ranked].sort((left, right) => left.rank - right.rank || left.index - right.index)[0]!;
    const highest = [...ranked].sort((left, right) => right.rank - left.rank || left.index - right.index)[0]!;
    const standard = entry.models[defaultModelIndex(entry.models)]!;
    result.light.push(preset(entry, lowest.model, effortExtreme(lowest.model.reasoningOptions, false), weight));
    result.standard.push(preset(entry, standard, standard.defaultReasoningEffort, weight));
    result.heavy.push(preset(entry, highest.model, heavyEffort(highest.model.reasoningOptions), weight));
    result.max.push(preset(entry, highest.model, effortExtreme(highest.model.reasoningOptions, true), weight));
  }
  return result;
}

/** A tier the user has not customised (presets === null) uses the derived defaults. */
export function effectiveRoutingPresets(
  settings: Pick<RoutingSettings, "tiers">,
  catalog: readonly RoutingCatalogEntry[],
  defaultProvider: ProviderId,
): Record<RoutingTier, RoutingPreset[]> {
  const derived = deriveDefaultRoutingPresets(catalog, defaultProvider);
  return Object.fromEntries(ROUTING_TIERS.map((tier) => [
    tier,
    settings.tiers[tier].presets?.map((entry) => ({ ...entry })) ?? derived[tier],
  ])) as Record<RoutingTier, RoutingPreset[]>;
}
