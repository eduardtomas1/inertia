import type {
  ModelBackendProfileView,
  ModelSelection,
  ThreadUsageSnapshot,
  UsageDisplayMode,
} from "@shared/contracts";

export const RECOMMENDED_USAGE_DISPLAY_MODE: UsageDisplayMode = "compact";

export interface PersistedUsageDisplayPreference {
  /** The v0.0.8 preference. Unknown values are treated as missing. */
  usageDisplayMode?: unknown;
  /** Compatibility input for databases that predate usageDisplayMode. */
  showUsage?: unknown;
}

export type UsageDisplaySurface = "hidden" | "circle" | "circle-with-value";

export interface UsageDisplayBehavior {
  readonly mode: UsageDisplayMode;
  readonly surface: UsageDisplaySurface;
  readonly showCircle: boolean;
  readonly showAdjacentValue: boolean;
  /** Usage is an anchored control, never a permanently visible detail strip. */
  readonly showPermanentStrip: false;
}

export type ContextUsageDataQuality = "current" | "stale" | "unavailable";
export type UsageQuotaSource = "selected-route" | "isolated";

export interface ContextUsageDisplayValue {
  readonly quality: ContextUsageDataQuality;
  readonly remainingPercent: number | null;
  readonly valueLabel: string;
  readonly accessibleLabel: string;
}

const usageDisplayBehaviors: Readonly<Record<UsageDisplayMode, UsageDisplayBehavior>> = {
  hidden: {
    mode: "hidden",
    surface: "hidden",
    showCircle: false,
    showAdjacentValue: false,
    showPermanentStrip: false,
  },
  compact: {
    mode: "compact",
    surface: "circle",
    showCircle: true,
    showAdjacentValue: false,
    showPermanentStrip: false,
  },
  expanded: {
    mode: "expanded",
    surface: "circle-with-value",
    showCircle: true,
    showAdjacentValue: true,
    showPermanentStrip: false,
  },
};

const nativeQuotaProfileIds = new Set([
  "builtin:openai",
  "builtin:anthropic",
  "builtin:cursor",
  "builtin:opencode",
]);

/**
 * Native account limits are valid only for the exact built-in provider route.
 * A deleted or temporarily missing custom profile must stay isolated instead
 * of falling back to whichever native harness quota is still in memory.
 */
export function usageQuotaSourceForSelection(
  selection: Pick<ModelSelection, "backendProfileId">,
  profile: Pick<ModelBackendProfileView, "id" | "preset"> | undefined,
): UsageQuotaSource {
  if (!nativeQuotaProfileIds.has(selection.backendProfileId)) return "isolated";
  if (!profile) return "selected-route";
  return profile.id === selection.backendProfileId && profile.preset === "native"
    ? "selected-route"
    : "isolated";
}

function isUsageDisplayMode(value: unknown): value is UsageDisplayMode {
  return value === "hidden" || value === "compact" || value === "expanded";
}

/**
 * Keeps every v0.0.8 mode intact. A legacy enabled boolean maps to the former
 * expanded presentation, while genuinely new or malformed preferences use the
 * recommended compact default.
 */
export function resolveUsageDisplayPreference(
  preference: PersistedUsageDisplayPreference,
): UsageDisplayMode {
  if (isUsageDisplayMode(preference.usageDisplayMode)) {
    return preference.usageDisplayMode;
  }
  if (preference.showUsage === false) return "hidden";
  if (preference.showUsage === true) return "expanded";
  return RECOMMENDED_USAGE_DISPLAY_MODE;
}

export function usageDisplayBehavior(mode: UsageDisplayMode): UsageDisplayBehavior {
  return usageDisplayBehaviors[mode];
}

/**
 * A persisted snapshot remains authoritative for the turn that produced it.
 * While a newer turn is starting or resuming, keep that last value visible but
 * label it stale until the provider reports usage owned by the newer turn.
 */
export function contextUsageQualityForTurn(
  usage: Pick<ThreadUsageSnapshot, "turnId"> | null,
  latestTurnId: string | null,
): ContextUsageDataQuality {
  if (!usage) return "unavailable";
  if (latestTurnId && usage.turnId !== latestTurnId) return "stale";
  return "current";
}

/**
 * Resolves only context-window occupancy. Provider account quota and processed
 * token totals are intentionally absent from this input, so neither can stand
 * in for an unavailable context percentage.
 */
export function contextUsageDisplayValue(
  usage: Pick<ThreadUsageSnapshot, "usedTokens" | "maxTokens"> | null,
  quality: ContextUsageDataQuality,
): ContextUsageDisplayValue {
  const usedTokens = usage?.usedTokens;
  const maxTokens = usage?.maxTokens;

  if (
    quality === "unavailable"
    || typeof usedTokens !== "number"
    || !Number.isSafeInteger(usedTokens)
    || usedTokens < 0
    || typeof maxTokens !== "number"
    || !Number.isSafeInteger(maxTokens)
    || maxTokens <= 0
    || usedTokens > maxTokens
  ) {
    return {
      quality: "unavailable",
      remainingPercent: null,
      valueLabel: "Unavailable",
      accessibleLabel: "Context usage unavailable",
    };
  }

  const remainingPercent = Math.round(100 - (usedTokens / maxTokens) * 100);
  const staleSuffix = quality === "stale" ? " · stale" : "";
  return {
    quality,
    remainingPercent,
    valueLabel: `${remainingPercent}%${staleSuffix}`,
    accessibleLabel: `Context ${remainingPercent}% remaining${quality === "stale" ? ", stale" : ""}`,
  };
}
