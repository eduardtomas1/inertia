import type { ProviderInfo } from "../../shared/contracts";
import { ProviderReadinessIncidents } from "./readiness-incidents";
import type { IncidentObservation } from "../../node/application-incidents";
import type { ProviderManager, ProviderDetection } from "../providers";
import { providerSnapshot } from "../runtime-snapshots";
import type { ProviderInstallationVerificationAuthority } from
  "./installation-lease";

const DETECTION_TIMEOUT_MS = 4_000;
const MAX_DETECTION_TIMEOUT_MS = 10_000;
const DETECTION_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];

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
}

export type RefreshProviderInfo = (
  providerId?: ProviderInfo["id"],
  refreshEnvironment?: boolean,
  forceMetadata?: boolean,
  verificationAuthority?: ProviderInstallationVerificationAuthority,
) => Promise<void>;

function detectionTimeoutMs(attempt: number): number {
  return Math.min(DETECTION_TIMEOUT_MS * 2 ** attempt, MAX_DETECTION_TIMEOUT_MS);
}

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
): RefreshProviderInfo {
  const incidents = dependencies.reportIncident ? new ProviderReadinessIncidents(dependencies.reportIncident) : null;
  const owners = new Map<ProviderInfo["id"], symbol>();
  const claim = (providerId?: ProviderInfo["id"]): symbol => {
    const owner = Symbol("provider-info-refresh");
    const providerIds = providerId
      ? [providerId]
      : dependencies.providerInfo().map(({ id }) => id);
    for (const id of providerIds) owners.set(id, owner);
    return owner;
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
      && attempt < retryDelaysMs.length
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
    const settle = async (initial: ProviderDetection): Promise<void> => {
      const id = initial.provider.id;
      let detection = initial;
      let attempt = 0;
      while (retrying(detection, attempt)) {
        const elapsed = await pause(
          retryDelaysMs[attempt]!,
          dependencies.lifetimeSignal,
        );
        if (!elapsed || owners.get(id) !== owner || dependencies.isClosed()) return;
        attempt += 1;
        detection = await dependencies.providers.detect(id, {
          cwd: dependencies.defaultWorkspacePath,
          timeoutMs: detectionTimeoutMs(attempt),
          refreshEnvironment: false,
          signal: dependencies.lifetimeSignal,
        });
        if (!replaceOwned(owner, [detectedSnapshot(detection, attempt)])) return;
        if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
      }
      if (!detection.canRun) return;
      const enriched = await enrichedSnapshot(detection);
      if (replaceOwned(owner, [enriched]) && !dependencies.isClosed()) {
        dependencies.broadcastSnapshot();
      }
    };

    if (providerId) {
      const detection = await dependencies.providers.detect(providerId, {
        cwd: dependencies.defaultWorkspacePath,
        timeoutMs: detectionTimeoutMs(0),
        refreshEnvironment,
        signal: dependencies.lifetimeSignal,
        ...(verificationAuthority
          ? { installationVerificationAuthority: verificationAuthority }
          : {}),
      });
      if (!replaceOwned(owner, [detectedSnapshot(detection, 0)])) return;
      if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
      await settle(detection);
    } else {
      const detections = await dependencies.providers.detectAll({
        cwd: dependencies.defaultWorkspacePath,
        timeoutMs: detectionTimeoutMs(0),
        refreshEnvironment,
        signal: dependencies.lifetimeSignal,
      });
      const detected = detections.map((detection) => (
        detectedSnapshot(detection, 0)
      ));
      if (replaceOwned(owner, detected) && !dependencies.isClosed()) {
        dependencies.broadcastSnapshot();
      }
      // Each provider owns its catalog. A different provider's pending
      // metadata must not hide this completed read from Settings/composers.
      // Keep joining every read so refresh activity and shutdown retain
      // their original lifetime, and recheck ownership before publication.
      await Promise.all(detections.map(settle));
    }
  };

  return async (...args) => {
    // Claim synchronously at invocation so an older broad refresh can still
    // publish untouched providers without overwriting a newer targeted result.
    const owner = claim(args[0]);
    await dependencies.track(async () => {
      dependencies.onActivityChange(1);
      try {
        await dependencies.beforeRefresh?.(dependencies.lifetimeSignal);
        if (dependencies.isClosed()) return;
        await refreshCore(owner, ...args);
      } finally {
        dependencies.onActivityChange(-1);
      }
    });
  };
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
