import type { ProviderInfo } from "../../shared/contracts";
import type { ProviderManager, ProviderDetection } from "../providers";
import { providerSnapshot } from "../runtime-snapshots";
import type { ProviderInstallationVerificationAuthority } from
  "./installation-lease";

export interface ProviderInfoRefreshDependencies {
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
}

export type RefreshProviderInfo = (
  providerId?: ProviderInfo["id"],
  refreshEnvironment?: boolean,
  forceMetadata?: boolean,
  verificationAuthority?: ProviderInstallationVerificationAuthority,
) => Promise<void>;

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
    if (replaced) dependencies.replaceProviderInfo(next);
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

    if (providerId) {
      const detection = await dependencies.providers.detect(providerId, {
        cwd: dependencies.defaultWorkspacePath,
        timeoutMs: 4_000,
        refreshEnvironment,
        signal: dependencies.lifetimeSignal,
        ...(verificationAuthority
          ? { installationVerificationAuthority: verificationAuthority }
          : {}),
      });
      const detected = providerSnapshot(
        detection,
        dependencies.providers.cachedMetadata(detection.provider.id),
        dependencies.providers.providerCapabilityContract(detection.provider.id),
      );
      if (!replaceOwned(owner, [detected])) return;
      if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
      if (!detection.canRun) return;
      const next = await enrichedSnapshot(detection);
      if (!replaceOwned(owner, [next])) return;
      if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
    } else {
      const detections = await dependencies.providers.detectAll({
        cwd: dependencies.defaultWorkspacePath,
        timeoutMs: 4_000,
        refreshEnvironment,
        signal: dependencies.lifetimeSignal,
      });
      const detected = detections.map((detection) => (
        providerSnapshot(
          detection,
          dependencies.providers.cachedMetadata(detection.provider.id),
          dependencies.providers.providerCapabilityContract(detection.provider.id),
        )
      ));
      if (replaceOwned(owner, detected) && !dependencies.isClosed()) {
        dependencies.broadcastSnapshot();
      }
      const enriched = await Promise.all(detections.map(enrichedSnapshot));
      if (replaceOwned(owner, enriched) && !dependencies.isClosed()) {
        dependencies.broadcastSnapshot();
      }
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
