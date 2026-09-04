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
  const refreshCore: RefreshProviderInfo = async (
    providerId,
    refreshEnvironment = false,
    forceMetadata = false,
    verificationAuthority,
  ) => {
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
      const previous = dependencies.providerInfo().find(
        ({ id }) => id === providerId,
      );
      const detected = retainMaintenance(previous, providerSnapshot(
        detection,
        dependencies.providers.cachedMetadata(detection.provider.id),
        dependencies.providers.providerCapabilityContract(detection.provider.id),
      ));
      dependencies.replaceProviderInfo(dependencies.providerInfo().map(
        (current) => current.id === providerId ? detected : current,
      ));
      if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
      if (!detection.canRun) return;
      const next = retainMaintenance(previous, await enrichedSnapshot(detection));
      dependencies.replaceProviderInfo(dependencies.providerInfo().map(
        (current) => current.id === providerId ? next : current,
      ));
    } else {
      const detections = await dependencies.providers.detectAll({
        cwd: dependencies.defaultWorkspacePath,
        timeoutMs: 4_000,
        refreshEnvironment,
        signal: dependencies.lifetimeSignal,
      });
      const previous = new Map(dependencies.providerInfo().map(
        (provider) => [provider.id, provider],
      ));
      dependencies.replaceProviderInfo(detections.map((detection) => (
        retainMaintenance(previous.get(detection.provider.id), providerSnapshot(
          detection,
          dependencies.providers.cachedMetadata(detection.provider.id),
          dependencies.providers.providerCapabilityContract(detection.provider.id),
        ))
      )));
      if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
      dependencies.replaceProviderInfo(await Promise.all(detections.map(
        async (detection) => retainMaintenance(
          previous.get(detection.provider.id),
          await enrichedSnapshot(detection),
        ),
      )));
    }
    if (!dependencies.isClosed()) dependencies.broadcastSnapshot();
  };

  return async (...args) => {
    await dependencies.track(async () => {
      dependencies.onActivityChange(1);
      try {
        await dependencies.beforeRefresh?.(dependencies.lifetimeSignal);
        if (dependencies.isClosed()) return;
        await refreshCore(...args);
      } finally {
        dependencies.onActivityChange(-1);
      }
    });
  };
}
