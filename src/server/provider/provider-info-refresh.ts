import type { ProviderInfo } from "../../shared/contracts";
import { ProviderReadinessIncidents } from "./readiness-incidents";
import type { IncidentObservation } from "../../node/application-incidents";
import type { ProviderManager, ProviderDetection } from "../providers";
import { providerSnapshot } from "../runtime-snapshots";
import type { ProviderInstallationVerificationAuthority } from
  "./installation-lease";
import { PROVIDER_METADATA_TIMEOUT_MS } from "./metadata";
import { MAX_PROBE_DEADLINE_MS, slowMachineProbeDeadline } from "./probe-deadline";

const DETECTION_TIMEOUT_MS = 4_000;
const DETECTION_RETRY_TIMEOUTS_MS = [8_000, 12_000];
const DETECTION_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
const REDISCOVERY_DELAY_MS = 2_000;
const RESUME_REDISCOVERY_AGE_MS = 10 * 60_000;

export interface ProviderInfoRefreshDependencies {
  reportIncident?: (observation: IncidentObservation) => unknown;
  enabled: boolean;
  providers: ProviderManager;
  defaultWorkspacePath: string;
  lifetimeSignal: AbortSignal;
  providerInfo(): readonly ProviderInfo[];
  replaceProviderInfo(value: ProviderInfo[]): void;
  broadcastSnapshot(): void;
  isClosed(): boolean;
  track(operation: () => Promise<void>): Promise<void>;
  beforeRefresh?(signal: AbortSignal): Promise<void>;
  onActivityChange(delta: 1 | -1): void;
  detectionRetryDelaysMs?: readonly number[];
  now?: () => number;
}

export type RefreshProviderInfo = (
  providerId?: ProviderInfo["id"],
  refreshEnvironment?: boolean,
  forceMetadata?: boolean,
  verificationAuthority?: ProviderInstallationVerificationAuthority,
) => Promise<void>;

export type ProviderInfoRefresh = RefreshProviderInfo & {
  rediscoverAfterSystemResume(): void;
};

async function pause(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const settle = (elapsed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(elapsed);
    };
    const abort = (): void => settle(false);
    const timer = setTimeout(() => settle(true), delayMs);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
  });
}

function retainMaintenance(
  current: ProviderInfo | undefined,
  next: ProviderInfo,
): ProviderInfo {
  return current?.maintenance
    ? { ...next, maintenance: current.maintenance }
    : next;
}

export function createProviderInfoRefresh(
  dependencies: ProviderInfoRefreshDependencies,
): ProviderInfoRefresh {
  const incidents = dependencies.reportIncident ? new ProviderReadinessIncidents(dependencies.reportIncident) : null;
  const now = dependencies.now ?? Date.now;
  const refreshedAt = new Map<ProviderInfo["id"], number>();
  const owners = new Map<ProviderInfo["id"], symbol>();
  const pendingRetries = new Map<ProviderInfo["id"], AbortController>();
  const retryAttempts = new Map<ProviderInfo["id"], Promise<void>>();
  const claim = (
    providerId?: ProviderInfo["id"],
  ): { owner: symbol; providerIds: ProviderInfo["id"][] } => {
    const owner = Symbol("provider-info-refresh");
    const providerIds = providerId
      ? [providerId]
      : dependencies.providerInfo().map(({ id }) => id);
    for (const id of providerIds) {
      owners.set(id, owner);
      pendingRetries.get(id)?.abort();
      pendingRetries.delete(id);
    }
    return { owner, providerIds };
  };
  const replaceOwned = (
    owner: symbol,
    candidates: readonly ProviderInfo[],
  ): boolean => {
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    let replaced = false;
    const next = dependencies.providerInfo().map((current) => {
      const candidate = byId.get(current.id);
      if (!candidate || owners.get(current.id) !== owner) return current;
      replaced = true;
      refreshedAt.set(current.id, now());
      return retainMaintenance(current, candidate);
    });
    if (replaced) {
      dependencies.replaceProviderInfo(next);
      incidents?.observe(next);
    }
    return replaced;
  };

  const refreshCore = async (
    owner: symbol,
    providerId?: ProviderInfo["id"],
    refreshEnvironment = false,
    forceMetadata = false,
    verificationAuthority?: ProviderInstallationVerificationAuthority,
  ): Promise<void> => {
    if (!dependencies.enabled) return;
    if (verificationAuthority && providerId !== verificationAuthority.providerId) {
      throw new Error(
        "Provider maintenance verification authority does not match the requested provider.",
      );
    }
    const enrichedSnapshot = async (
      detection: ProviderDetection,
      attempt: number,
    ): Promise<ProviderInfo> => {
      if (!detection.canRun) {
        return providerSnapshot(
          detection,
          dependencies.providers.cachedMetadata(detection.provider.id),
          dependencies.providers.providerCapabilityContract(detection.provider.id),
        );
      }
      const metadataRead = dependencies.providers.metadata(
        detection.provider.id,
        dependencies.defaultWorkspacePath,
        {
          force: forceMetadata,
          signal: dependencies.lifetimeSignal,
          timeoutMs: Math.min(
            MAX_PROBE_DEADLINE_MS,
            slowMachineProbeDeadline(PROVIDER_METADATA_TIMEOUT_MS, detection.probeLatencyMs) * 2 ** attempt,
          ),
          ...(verificationAuthority
            ? { installationVerificationAuthority: verificationAuthority }
            : {}),
        },
      );
      const metadata = verificationAuthority
        ? await metadataRead
        : await metadataRead.catch(() => (
            dependencies.providers.cachedMetadata(detection.provider.id)
          ));
      return providerSnapshot(
        detection,
        metadata,
        dependencies.providers.providerCapabilityContract(detection.provider.id),
      );
    };

    const retryDelaysMs = dependencies.detectionRetryDelaysMs
      ?? DETECTION_RETRY_DELAYS_MS;
    const retrying = (detection: ProviderDetection, attempt: number): boolean => (
      !verificationAuthority
      && detection.probeTimedOut === true
      && attempt < Math.min(retryDelaysMs.length, DETECTION_RETRY_TIMEOUTS_MS.length)
    );
    const detectedSnapshot = (
      detection: ProviderDetection,
      attempt: number,
    ): ProviderInfo => providerSnapshot(
      retrying(detection, attempt)
        ? {
            ...detection,
            installState: detection.installState === "installed"
              ? "installed"
              : "checking",
            authState: "checking",
            canRun: false,
            statusMessage: `${detection.provider.name} is slow to respond; checking again`,
          }
        : detection,
      dependencies.providers.cachedMetadata(detection.provider.id),
      dependencies.providers.providerCapabilityContract(detection.provider.id),
    );
    let broadcastPending = false;
    const broadcast = (): void => {
      broadcastPending = false;
      if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
    };
    const publish = (snapshot: ProviderInfo): void => {
      if (dependencies.isClosed()) return;
      if (replaceOwned(owner, [snapshot])) broadcast();
    };
    const later = (
      id: ProviderInfo["id"],
      attempt: number,
      operation: () => Promise<void>,
      onFailure: () => void,
    ): void => {
      const cancellation = new AbortController();
      pendingRetries.set(id, cancellation);
      void pause(
        retryDelaysMs[attempt]!,
        AbortSignal.any([cancellation.signal, dependencies.lifetimeSignal]),
      ).then(async (elapsed) => {
        if (pendingRetries.get(id) === cancellation) pendingRetries.delete(id);
        if (!elapsed || owners.get(id) !== owner || dependencies.isClosed()) return;
        const running = dependencies.track(async () => {
          dependencies.onActivityChange(1);
          try {
            await operation();
          } finally {
            dependencies.onActivityChange(-1);
          }
        });
        const settled = running.then(() => undefined, () => {
          if (owners.get(id) === owner) onFailure();
        });
        retryAttempts.set(id, settled);
        await settled;
        if (retryAttempts.get(id) === settled) retryAttempts.delete(id);
      });
    };
    const settle = async (detection: ProviderDetection, attempt = 0): Promise<void> => {
      if (!detection.canRun) return;
      const id = detection.provider.id;
      const enriched = await enrichedSnapshot(detection, attempt);
      if (replaceOwned(owner, [enriched]) && !dependencies.isClosed()) broadcast();
      if (
        !verificationAuthority
        && attempt < retryDelaysMs.length
        && owners.get(id) === owner
        && !dependencies.isClosed()
        && dependencies.providers.metadataReadTimedOut(id)
      ) {
        later(id, attempt, async () => await settle(detection, attempt + 1), () => undefined);
      }
    };
    const retry = async (
      previous: ProviderDetection,
      attempt: number,
    ): Promise<void> => {
      const id = previous.provider.id;
      const detection = await dependencies.providers.detect(id, {
        cwd: dependencies.defaultWorkspacePath,
        timeoutMs: DETECTION_RETRY_TIMEOUTS_MS[attempt - 1]!,
        refreshEnvironment: false,
        signal: dependencies.lifetimeSignal,
      });
      if (owners.get(id) !== owner) return;
      publish(detectedSnapshot(detection, attempt));
      if (retrying(detection, attempt)) schedule(detection, attempt);
      else await settle(detection);
    };
    const schedule = (previous: ProviderDetection, attempt: number): void => {
      later(
        previous.provider.id,
        attempt,
        async () => await retry(previous, attempt + 1),
        () => publish(detectedSnapshot(previous, retryDelaysMs.length)),
      );
    };
    const settleOrSchedule = async (detection: ProviderDetection): Promise<void> => {
      if (!retrying(detection, 0)) await settle(detection);
      else if (owners.get(detection.provider.id) === owner) schedule(detection, 0);
    };

    if (providerId) {
      const detection = await dependencies.providers.detect(providerId, {
        cwd: dependencies.defaultWorkspacePath,
        timeoutMs: DETECTION_TIMEOUT_MS,
        refreshEnvironment,
        signal: dependencies.lifetimeSignal,
        ...(verificationAuthority
          ? { installationVerificationAuthority: verificationAuthority }
          : {}),
      });
      if (!replaceOwned(owner, [detectedSnapshot(detection, 0)])) return;
      if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
      await settleOrSchedule(detection);
    } else {
      const arrived = new Map<ProviderInfo["id"], ProviderDetection>();
      const settling: Promise<void>[] = [];
      const flush = (): void => {
        if (broadcastPending) broadcast();
      };
      const arrive = (detection: ProviderDetection): void => {
        if (arrived.has(detection.provider.id)) return;
        arrived.set(detection.provider.id, detection);
        if (replaceOwned(owner, [detectedSnapshot(detection, 0)]) && !broadcastPending) {
          broadcastPending = true;
          setImmediate(flush);
        }
        const settled = settleOrSchedule(detection);
        settled.catch(() => undefined);
        settling.push(settled);
      };
      let failure: { error: unknown } | null = null;
      try {
        const detections = await dependencies.providers.detectAll({
          cwd: dependencies.defaultWorkspacePath,
          timeoutMs: DETECTION_TIMEOUT_MS,
          refreshEnvironment,
          signal: dependencies.lifetimeSignal,
          onDetection: arrive,
        });
        for (const detection of detections) arrive(detection);
      } catch (error) {
        failure = { error };
      }
      flush();
      await Promise.all(settling);
      if (!failure) return;
      if (dependencies.lifetimeSignal.aborted || dependencies.isClosed()) throw failure.error;
      const failed = dependencies.providerInfo()
        .filter(({ id }) => !arrived.has(id))
        .map((current): ProviderInfo => ({
          ...current,
          installState: "error",
          authState: "error",
          canRun: false,
          statusMessage: "Agent discovery failed",
        }));
      if (replaceOwned(owner, failed)) broadcast();
    }
  };

  const refresh: RefreshProviderInfo = async (...args) => {
    // Claim synchronously at invocation so an older broad refresh can still
    // publish untouched providers without overwriting a newer targeted result.
    const { owner, providerIds } = claim(args[0]);
    await dependencies.track(async () => {
      dependencies.onActivityChange(1);
      try {
        await Promise.all(providerIds.flatMap((id) => retryAttempts.get(id) ?? []));
        await dependencies.beforeRefresh?.(dependencies.lifetimeSignal);
        if (dependencies.isClosed()) return;
        await refreshCore(owner, ...args);
      } finally {
        dependencies.onActivityChange(-1);
      }
    });
  };

  const scheduled = new Map<ProviderInfo["id"], NodeJS.Timeout>();
  const rediscover = (providerId: ProviderInfo["id"]): void => {
    if (
      !dependencies.enabled
      || dependencies.isClosed()
      || dependencies.lifetimeSignal.aborted
      || scheduled.has(providerId)
    ) return;
    const timer = setTimeout(() => {
      scheduled.delete(providerId);
      if (dependencies.isClosed() || dependencies.lifetimeSignal.aborted) return;
      void refresh(providerId, true).catch(() => undefined);
    }, REDISCOVERY_DELAY_MS);
    timer.unref();
    scheduled.set(providerId, timer);
  };
  const stopObserving = dependencies.providers.observeInstallationEvents((event) => {
    if (event.kind !== "probe-cleanup-unconfirmed") {
      rediscover(event.providerId);
      return;
    }
    dependencies.reportIncident?.({
      code: "provider.discovery-cleanup-unconfirmed",
      outcome: "unknown",
      context: { providerId: event.providerId },
    });
  });
  dependencies.lifetimeSignal.addEventListener("abort", () => {
    stopObserving();
    for (const timer of scheduled.values()) clearTimeout(timer);
    scheduled.clear();
  }, { once: true });
  return Object.assign(refresh, {
    rediscoverAfterSystemResume: (): void => {
      for (const { id } of dependencies.providerInfo()) {
        const lastRefreshedAt = refreshedAt.get(id);
        if (lastRefreshedAt === undefined) continue;
        if (
          dependencies.providers.providerInstallationState(id) !== "current"
          || now() - lastRefreshedAt >= RESUME_REDISCOVERY_AGE_MS
        ) rediscover(id);
      }
    },
  });
}

export function providerInstallationVerifier(
  providers: Pick<ProviderManager, "providerInstallationState" | "invalidateInstallationEvidence">,
  refresh: RefreshProviderInfo,
): (providerId: ProviderInfo["id"]) => Promise<void> {
  const pending = new Map<ProviderInfo["id"], Promise<void>>();
  return async (providerId) => {
    const existing = pending.get(providerId);
    if (existing) return await existing;
    const state = providers.providerInstallationState(providerId);
    if (state === "current") return;
    // Resolve an unverified installation from its configured command again, as at
    // startup. A removed PATH target must not lend its old physical identity
    // to the new probe. This drops capability evidence, never cleanup leases
    // or quarantine; admission stays closed until discovery verifies it.
    providers.invalidateInstallationEvidence(providerId);
    const verification = refresh(providerId, true)
      .catch(() => undefined)
      .finally(() => { pending.delete(providerId); });
    pending.set(providerId, verification);
    await verification;
  };
}
