import type { ProviderId } from "../provider";
import type { RoutingCatalogEntry, RoutingCatalogModel } from "./routing-catalog";
import type { PickerResult } from "./routing-rules-picker";
import {
  boundedRoutingReason,
  ROUTING_TASK_KIND_LABELS,
  ROUTING_TIER_LABELS,
  ROUTING_TIERS,
  type RoutingPreset,
  type RoutingSettings,
  type RoutingTier,
} from "./routing-policy";

/** The chat's route before this decision, with provider defaults resolved. */
export interface RoutingCurrentRoute {
  providerId: ProviderId;
  backendProfileId: string;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
}

export interface RoutingCandidate {
  tier: RoutingTier;
  presetIndex: number;
  preset: RoutingPreset;
  entry: RoutingCatalogEntry;
  model: RoutingCatalogModel;
  score: number;
}

export interface RoutingCandidateOptions {
  quotaReservePercent: number;
  requiresVision: boolean;
  /** Runtime validation hook (the authoritative selection validator); returns a refusal or null. */
  validate?: (candidate: Omit<RoutingCandidate, "score">) => string | null;
}

export interface RoutingPlanInput {
  settings: Pick<RoutingSettings, "confidenceThreshold" | "fallbackTier" | "stickiness" | "quotaReservePercent">;
  picked: PickerResult;
  presets: Readonly<Record<RoutingTier, readonly RoutingPreset[]>>;
  catalog: readonly RoutingCatalogEntry[];
  current: RoutingCurrentRoute;
  /** Stickiness only protects an established provider session. */
  hasPriorTurns: boolean;
  requiresVision: boolean;
  validate?: RoutingCandidateOptions["validate"];
}

export interface RoutingPlan {
  requestedTier: RoutingTier;
  tier: RoutingTier;
  lowConfidence: boolean;
  /** No valid candidate existed in the requested tier. */
  fallback: boolean;
  candidate: RoutingCandidate | null;
  changesRoute: boolean;
  reason: string;
  trace: string[];
}

const WEIGHT_RANKS: Readonly<Record<RoutingPreset["weight"], number>> = {
  prefer: 3,
  normal: 2,
  less: 1,
  never: 0,
};
/** Large enough that sticky mode only leaves the provider when nothing else qualifies. */
export const ROUTING_STICKINESS_PENALTY = 10;
/** Below one weight step, so quota only breaks ties between equally weighted presets. */
export const ROUTING_MAX_QUOTA_PENALTY = 0.5;

export function routingCandidateRejection(
  preset: RoutingPreset,
  entry: RoutingCatalogEntry | undefined,
  model: RoutingCatalogModel | undefined,
  options: Pick<RoutingCandidateOptions, "quotaReservePercent" | "requiresVision">,
): string | null {
  if (preset.weight === "never") return "weight is Never";
  if (!entry) return "provider route is unavailable";
  if (!entry.ready) return `${entry.label} is not signed in or cannot run`;
  if (!model) return `${entry.label} no longer offers ${preset.modelId}`;
  if (preset.reasoningEffort !== null && !model.reasoningOptions.includes(preset.reasoningEffort)) {
    return `${model.label} has no ${preset.reasoningEffort} reasoning`;
  }
  if (preset.fastMode && !model.fastMode) return `${model.label} has no Fast mode`;
  if (options.requiresVision && !model.vision) return `${model.label} cannot read images`;
  if (entry.usageLimited) return `${entry.label} is usage limited`;
  if (entry.remainingPercent !== null && entry.remainingPercent < options.quotaReservePercent) {
    return `${entry.label} is below the ${options.quotaReservePercent}% quota reserve`;
  }
  return null;
}

/** Valid candidates for one tier, in preset order, plus the reasons others were skipped. */
export function routingTierCandidates(
  tier: RoutingTier,
  presets: readonly RoutingPreset[],
  catalog: readonly RoutingCatalogEntry[],
  options: RoutingCandidateOptions,
): { candidates: Array<Omit<RoutingCandidate, "score">>; rejected: string[] } {
  const candidates: Array<Omit<RoutingCandidate, "score">> = [];
  const rejected: string[] = [];
  presets.forEach((preset, presetIndex) => {
    const entry = catalog.find((candidate) =>
      candidate.providerId === preset.providerId && candidate.backendProfileId === preset.backendProfileId);
    const model = entry?.models.find(({ id }) => id === preset.modelId);
    const refusal = routingCandidateRejection(preset, entry, model, options)
      ?? (entry && model ? options.validate?.({ tier, presetIndex, preset, entry, model }) ?? null : null);
    if (refusal) {
      rejected.push(`${tier}#${presetIndex + 1} ${preset.modelId}: ${refusal}`);
      return;
    }
    candidates.push({ tier, presetIndex, preset, entry: entry!, model: model! });
  });
  return { candidates, rejected };
}

export function scoreRoutingCandidate(
  candidate: Omit<RoutingCandidate, "score">,
  context: { stickyProviderId: ProviderId | null },
): number {
  let score = WEIGHT_RANKS[candidate.preset.weight];
  if (context.stickyProviderId !== null && candidate.preset.providerId !== context.stickyProviderId) {
    score -= ROUTING_STICKINESS_PENALTY;
  }
  if (candidate.entry.remainingPercent !== null) {
    score -= ((100 - candidate.entry.remainingPercent) / 100) * ROUTING_MAX_QUOTA_PENALTY;
  }
  return Math.round(score * 1_000) / 1_000;
}

/** The requested tier, then one step at a time toward Standard. */
export function routingTierFallbackChain(tier: RoutingTier): RoutingTier[] {
  const standard = ROUTING_TIERS.indexOf("standard");
  const chain: RoutingTier[] = [];
  let index = ROUTING_TIERS.indexOf(tier);
  chain.push(ROUTING_TIERS[index]!);
  while (index !== standard) {
    index += index > standard ? -1 : 1;
    chain.push(ROUTING_TIERS[index]!);
  }
  return chain;
}

/** Every tier, nearest to the requested one first; used after the chain is exhausted. */
function anyTierOrder(tier: RoutingTier): RoutingTier[] {
  const origin = ROUTING_TIERS.indexOf(tier);
  return [...ROUTING_TIERS].sort((left, right) =>
    Math.abs(ROUTING_TIERS.indexOf(left) - origin) - Math.abs(ROUTING_TIERS.indexOf(right) - origin)
    || ROUTING_TIERS.indexOf(left) - ROUTING_TIERS.indexOf(right));
}

export function sameRoutingRoute(
  candidate: Pick<RoutingCandidate, "preset">,
  current: RoutingCurrentRoute,
): boolean {
  return candidate.preset.providerId === current.providerId
    && candidate.preset.backendProfileId === current.backendProfileId
    && candidate.preset.modelId === current.modelId
    && candidate.preset.reasoningEffort === current.reasoningEffort
    && candidate.preset.fastMode === current.fastMode;
}

/** Resolves a stored selection's "provider-default" model and null effort against the catalog. */
export function effectiveRoutingRoute(
  route: RoutingCurrentRoute,
  catalog: readonly RoutingCatalogEntry[],
): RoutingCurrentRoute {
  const entry = catalog.find((candidate) =>
    candidate.providerId === route.providerId && candidate.backendProfileId === route.backendProfileId);
  const model = route.modelId === "provider-default"
    ? entry?.models.find(({ isDefault }) => isDefault) ?? entry?.models[0]
    : entry?.models.find(({ id }) => id === route.modelId);
  return {
    ...route,
    modelId: model?.id ?? route.modelId,
    reasoningEffort: route.reasoningEffort ?? model?.defaultReasoningEffort ?? null,
  };
}

type TierPool = Array<Omit<RoutingCandidate, "score">>;

/** The best candidate in a pool, optionally only on one provider; ties keep the earlier preset. */
function best(
  pool: TierPool,
  stickyProviderId: ProviderId | null,
  onlyProviderId: ProviderId | null,
): RoutingCandidate | null {
  let chosen: RoutingCandidate | null = null;
  for (const candidate of pool) {
    if (onlyProviderId !== null && candidate.preset.providerId !== onlyProviderId) continue;
    const scored = { ...candidate, score: scoreRoutingCandidate(candidate, { stickyProviderId }) };
    if (!chosen || scored.score > chosen.score) chosen = scored;
  }
  return chosen;
}

function routeLabel(candidate: RoutingCandidate): string {
  return `${candidate.model.label}${candidate.preset.reasoningEffort ? ` · ${candidate.preset.reasoningEffort}` : ""}`;
}

function heldPlan(input: RoutingPlanInput, trace: string[], reason: string): RoutingPlan {
  return {
    requestedTier: input.picked.tier,
    tier: input.picked.tier,
    lowConfidence: false,
    fallback: false,
    candidate: null,
    changesRoute: false,
    reason: boundedRoutingReason(reason),
    trace,
  };
}

export function planRoutingDecision(input: RoutingPlanInput): RoutingPlan {
  const trace = [...input.picked.trace];
  const kind = ROUTING_TASK_KIND_LABELS[input.picked.taskKind];
  const confidence = `${Math.round(input.picked.confidence * 100)}% confidence`;
  const head = `${kind}, ${confidence}`;
  const currentEntry = input.catalog.find((entry) =>
    entry.providerId === input.current.providerId && entry.backendProfileId === input.current.backendProfileId);
  if (currentEntry?.checking) {
    // A probe in progress is not evidence that the provider is gone; never leave it mid-check.
    trace.push(`${currentEntry.label} is being checked; keeping the current route`);
    return heldPlan(input, trace, `${head}. ${currentEntry.label} is being checked, so the current model stays.`);
  }
  // The gate only matters when it changes the tier; a matching fallback is an ordinary decision.
  const belowThreshold = input.picked.confidence < input.settings.confidenceThreshold;
  const lowConfidence = belowThreshold && input.settings.fallbackTier !== input.picked.tier;
  const requestedTier = lowConfidence ? input.settings.fallbackTier : input.picked.tier;
  if (belowThreshold) {
    trace.push(`confidence ${input.picked.confidence} below ${input.settings.confidenceThreshold}; using ${requestedTier}`);
  }
  const stickyProviderId = input.settings.stickiness === "sticky" && input.hasPriorTurns
    ? input.current.providerId
    : null;
  const order = [...new Set([...routingTierFallbackChain(requestedTier), ...anyTierOrder(requestedTier)])];
  const pools = new Map<RoutingTier, TierPool>();
  const pool = (tier: RoutingTier): TierPool => {
    const cached = pools.get(tier);
    if (cached) return cached;
    const { candidates, rejected } = routingTierCandidates(tier, input.presets[tier], input.catalog, {
      quotaReservePercent: input.settings.quotaReservePercent,
      requiresVision: input.requiresVision,
      validate: input.validate,
    });
    trace.push(...rejected.map((entry) => `skipped ${entry}`));
    for (const candidate of candidates) {
      const score = scoreRoutingCandidate(candidate, { stickyProviderId });
      trace.push(`candidate ${tier}#${candidate.presetIndex + 1} ${candidate.preset.modelId} score ${score}`);
    }
    pools.set(tier, candidates);
    return candidates;
  };
  const search = (onlyProviderId: ProviderId | null): { tier: RoutingTier; candidate: RoutingCandidate } | null => {
    for (const tier of order) {
      const candidate = best(pool(tier), stickyProviderId, onlyProviderId);
      if (candidate) return { tier, candidate };
    }
    return null;
  };
  // Sticky mode walks the whole fallback order on the current provider before leaving it.
  const sticky = stickyProviderId === null ? null : search(stickyProviderId);
  const found = sticky ?? search(null);
  const candidate = found?.candidate ?? null;
  const tier = found?.tier ?? requestedTier;
  const fallback = !candidate || tier !== requestedTier;
  const stayedOnProvider = sticky !== null && fallback && pool(requestedTier).length > 0;
  let reason: string;
  if (!candidate) {
    reason = `${head}. No preset in any tier is available, so the current model stays.`;
  } else if (stayedOnProvider) {
    reason = `${head}. No ${ROUTING_TIER_LABELS[requestedTier]} preset is available on ${candidate.entry.label}; staying there with ${ROUTING_TIER_LABELS[tier]}: ${routeLabel(candidate)}.`;
  } else if (fallback) {
    reason = `${head}. No ${ROUTING_TIER_LABELS[requestedTier]} preset is available; using ${ROUTING_TIER_LABELS[tier]}: ${routeLabel(candidate)}.`;
  } else if (lowConfidence) {
    reason = `${head}, so the ${ROUTING_TIER_LABELS[tier]} fallback tier applies: ${routeLabel(candidate)}.`;
  } else {
    reason = `${head} → ${ROUTING_TIER_LABELS[tier]} tier: ${routeLabel(candidate)}.`;
  }
  return {
    requestedTier,
    tier,
    lowConfidence,
    fallback,
    candidate,
    changesRoute: candidate !== null && !sameRoutingRoute(candidate, input.current),
    reason: boundedRoutingReason(reason),
    trace,
  };
}
