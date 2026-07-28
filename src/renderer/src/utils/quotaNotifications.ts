import type {
  ProviderInfo,
  ProviderMetadataFieldState,
  ProviderRateLimit,
} from "@shared/contracts";

export const QUOTA_NOTIFICATION_THRESHOLDS = [25, 15, 5] as const;
export const QUOTA_NOTIFICATION_STORAGE_KEY =
  "inertia:provider-quota-notifications:v1";

const MAX_PERSISTED_WINDOWS = 64;
const FIVE_HOURS_MINUTES = 300;
const WEEK_MINUTES = 10_080;

export type QuotaNotificationThreshold =
  (typeof QUOTA_NOTIFICATION_THRESHOLDS)[number];

export interface QuotaNotification {
  id: string;
  providerId: ProviderInfo["id"];
  providerLabel: string;
  limitId: string;
  windowLabel: "5-hour" | "weekly";
  threshold: QuotaNotificationThreshold;
  remainingPercent: number;
  resetsAt: string | null;
}

interface PersistedQuotaWindow {
  resetIdentity: string;
  remainingPercent: number;
  announced: QuotaNotificationThreshold[];
  observedAt: string;
}

export interface PersistedQuotaNotificationState {
  version: 1;
  windows: Record<string, PersistedQuotaWindow>;
}

export interface QuotaNotificationEvaluation {
  state: PersistedQuotaNotificationState;
  notices: QuotaNotification[];
}

function emptyState(): PersistedQuotaNotificationState {
  return { version: 1, windows: {} };
}

function validPercent(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= 100;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && Number.isFinite(Date.parse(value));
}

function isThreshold(value: unknown): value is QuotaNotificationThreshold {
  return QUOTA_NOTIFICATION_THRESHOLDS.some((threshold) => threshold === value);
}

export function parseQuotaNotificationState(
  value: string | null,
): PersistedQuotaNotificationState {
  if (!value || value.length > 131_072) return emptyState();
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown;
      windows?: unknown;
    };
    if (parsed.version !== 1 || !parsed.windows || typeof parsed.windows !== "object") {
      return emptyState();
    }
    const windows = Object.entries(parsed.windows)
      .slice(-MAX_PERSISTED_WINDOWS)
      .flatMap(([key, candidate]) => {
        if (
          key.length > 360
          || !candidate
          || typeof candidate !== "object"
          || Array.isArray(candidate)
        ) return [];
        const record = candidate as Partial<PersistedQuotaWindow>;
        if (
          typeof record.resetIdentity !== "string"
          || record.resetIdentity.length > 96
          || !validPercent(record.remainingPercent)
          || !validTimestamp(record.observedAt)
          || !Array.isArray(record.announced)
        ) return [];
        const normalized: PersistedQuotaWindow = {
          resetIdentity: record.resetIdentity,
          remainingPercent: record.remainingPercent,
          announced: [...new Set(record.announced.filter(isThreshold))],
          observedAt: record.observedAt,
        };
        return [[key, normalized] as [string, PersistedQuotaWindow]];
      });
    return { version: 1, windows: Object.fromEntries(windows) };
  } catch {
    return emptyState();
  }
}

export function serializeQuotaNotificationState(
  state: PersistedQuotaNotificationState,
): string {
  return JSON.stringify(state);
}

function quotaWindowLabel(
  limit: ProviderRateLimit,
): QuotaNotification["windowLabel"] | null {
  if (limit.windowMinutes === FIVE_HOURS_MINUTES) return "5-hour";
  if (limit.windowMinutes === WEEK_MINUTES) return "weekly";
  return null;
}

function authoritativeQuota(
  state: ProviderMetadataFieldState,
): boolean {
  return state.freshness === "fresh"
    && (state.provenance === "provider" || state.provenance === "session");
}

function resetIdentity(limit: ProviderRateLimit): string {
  return validTimestamp(limit.resetsAt)
    ? new Date(limit.resetsAt).toISOString()
    : "provider-reset-unavailable";
}

function crossedThreshold(
  previousRemaining: number | null,
  remaining: number,
): QuotaNotificationThreshold | null {
  const crossed = QUOTA_NOTIFICATION_THRESHOLDS
    .filter((threshold) => (
      remaining <= threshold
      && (previousRemaining === null || previousRemaining > threshold)
    ));
  return crossed.at(-1) ?? null;
}

function boundedWindows(
  windows: Record<string, PersistedQuotaWindow>,
): Record<string, PersistedQuotaWindow> {
  return Object.fromEntries(
    Object.entries(windows)
      .sort(([, left], [, right]) =>
        left.observedAt.localeCompare(right.observedAt))
      .slice(-MAX_PERSISTED_WINDOWS),
  );
}

/**
 * Account quota remains scoped to the native provider metadata projection.
 * Custom backend profiles never enter this evaluator, and stale/cached data
 * never creates a new notice.
 */
export function evaluateQuotaNotifications(
  providers: readonly ProviderInfo[],
  previous: PersistedQuotaNotificationState,
  observedAt = new Date().toISOString(),
): QuotaNotificationEvaluation {
  const nextWindows = { ...previous.windows };
  const notices: QuotaNotification[] = [];

  for (const provider of providers) {
    if (!authoritativeQuota(provider.metadataState.rateLimits)) continue;
    for (const limit of provider.rateLimits) {
      const windowLabel = quotaWindowLabel(limit);
      if (!windowLabel || !validPercent(limit.remainingPercent)) continue;

      const key = `${provider.id}:builtin:${limit.id}`;
      const identity = resetIdentity(limit);
      const prior = nextWindows[key];
      const resetChanged = prior?.resetIdentity !== identity;
      const inferredReset = Boolean(
        prior
        && identity === "provider-reset-unavailable"
        && limit.remainingPercent > 25
        && limit.remainingPercent > prior.remainingPercent,
      );
      const activePrior = resetChanged || inferredReset ? undefined : prior;
      const threshold = crossedThreshold(
        activePrior?.remainingPercent ?? null,
        limit.remainingPercent,
      );
      const alreadyAnnounced = new Set(activePrior?.announced ?? []);

      if (threshold !== null && !alreadyAnnounced.has(threshold)) {
        for (const candidate of QUOTA_NOTIFICATION_THRESHOLDS) {
          if (candidate >= threshold) alreadyAnnounced.add(candidate);
        }
        notices.push({
          id: `${key}:${identity}:${threshold}`,
          providerId: provider.id,
          providerLabel: provider.label,
          limitId: limit.id,
          windowLabel,
          threshold,
          remainingPercent: Math.round(limit.remainingPercent),
          resetsAt: validTimestamp(limit.resetsAt)
            ? new Date(limit.resetsAt).toISOString()
            : null,
        });
      }

      nextWindows[key] = {
        resetIdentity: identity,
        remainingPercent: limit.remainingPercent,
        announced: [...alreadyAnnounced].sort((left, right) => right - left),
        observedAt,
      };
    }
  }

  return {
    state: { version: 1, windows: boundedWindows(nextWindows) },
    notices,
  };
}
