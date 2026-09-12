import type { ProviderInfo } from "../../shared/contracts";
import type { TurnMetadataRefreshHookInput } from "./turns/turn-controller-types";

type ProviderId = ProviderInfo["id"];
type MetadataField = "models" | "rateLimits";

interface MetadataFieldState {
  freshness: string;
  updatedAt: string | null;
}

export interface ProviderUsageRefreshDependencies<Metadata> {
  enabled: boolean;
  signal: AbortSignal;
  isClosed(): boolean;
  cachedState(providerId: ProviderId): {
    models: MetadataFieldState;
    rateLimits: MetadataFieldState;
  };
  read(providerId: ProviderId, fields: MetadataField[]): Promise<Metadata>;
  apply(providerId: ProviderId, metadata: Metadata): void;
  broadcastSnapshot(): void;
  isExternalTurn(turnId: string): boolean;
  canRun(providerId: ProviderId): boolean;
  activeProviderIds(): ReadonlySet<ProviderId>;
  track(operation: () => Promise<void>): Promise<void>;
  now?(): number;
}

const RATE_LIMIT_PROVIDER_IDS: readonly ProviderId[] = ["codex", "claude"];
export const IDLE_RATE_LIMIT_REFRESH_INTERVAL_MS = 3 * 60 * 1_000;
const MAX_IDLE_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1_000;

/**
 * Refreshes provider usage after a settled turn (#344). Failed, cancelled and
 * interrupted turns still used quota, so rate limits refresh after every
 * settled turn; the model catalog only after a successful one.
 */
export function createTurnUsageRefresh<Metadata>(
  dependencies: ProviderUsageRefreshDependencies<Metadata>,
): (input: TurnMetadataRefreshHookInput) => Promise<void> {
  return async ({ providerId, turnId, runStartedAt, status }) => {
    if (!dependencies.enabled || dependencies.isExternalTurn(turnId)) return;
    const state = dependencies.cachedState(providerId);
    const fields: MetadataField[] = [];
    if (
      status === "completed"
      && state.models.freshness !== "fresh"
      && providerId !== "cursor"
    ) {
      fields.push("models");
    }
    const rateLimitsUpdatedAt = state.rateLimits.updatedAt
      ? Date.parse(state.rateLimits.updatedAt)
      : Number.NaN;
    if (
      RATE_LIMIT_PROVIDER_IDS.includes(providerId)
      && !(rateLimitsUpdatedAt >= runStartedAt)
    ) {
      fields.push("rateLimits");
    }
    if (fields.length === 0) return;
    dependencies.apply(providerId, await dependencies.read(providerId, fields));
    // Settlement was broadcast before this refresh finished; publish the
    // refreshed quota now instead of waiting for an unrelated snapshot.
    if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
  };
}

/**
 * Account quota also changes between turns (#344). Refreshes stale rate limits
 * for idle, runnable providers that have reported limits before, and backs off
 * after failures. Live rate-limit events cover providers with active turns.
 * Returns a stop function; aborting the signal also stops it.
 */
export function startIdleRateLimitRefresh<Metadata>(
  dependencies: ProviderUsageRefreshDependencies<Metadata>,
  intervalMs = IDLE_RATE_LIMIT_REFRESH_INTERVAL_MS,
): () => void {
  const now = dependencies.now ?? Date.now;
  const retry = new Map<ProviderId, { at: number; delayMs: number }>();
  let refreshing = false;
  const tick = (): void => {
    if (dependencies.isClosed() || refreshing) return;
    const busy = dependencies.activeProviderIds();
    const due = RATE_LIMIT_PROVIDER_IDS.filter((providerId) => {
      const rateLimits = dependencies.cachedState(providerId).rateLimits;
      return dependencies.canRun(providerId)
        && !busy.has(providerId)
        && (retry.get(providerId)?.at ?? 0) <= now()
        && rateLimits.updatedAt !== null
        && rateLimits.freshness !== "fresh";
    });
    if (due.length === 0) return;
    refreshing = true;
    void dependencies.track(async () => {
      for (const providerId of due) {
        if (dependencies.isClosed()) return;
        const metadata = await dependencies.read(providerId, ["rateLimits"])
          .catch(() => null);
        if (dependencies.isClosed()) return;
        if (metadata !== null) dependencies.apply(providerId, metadata);
        if (dependencies.cachedState(providerId).rateLimits.freshness === "fresh") {
          retry.delete(providerId);
        } else {
          const delayMs = Math.min(
            MAX_IDLE_RATE_LIMIT_BACKOFF_MS,
            (retry.get(providerId)?.delayMs ?? intervalMs) * 2,
          );
          retry.set(providerId, { at: now() + delayMs, delayMs });
        }
        if (metadata !== null) dependencies.broadcastSnapshot();
      }
    }).catch(() => undefined).finally(() => {
      refreshing = false;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const stop = (): void => clearInterval(timer);
  dependencies.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
