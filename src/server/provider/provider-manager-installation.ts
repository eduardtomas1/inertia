import { statSync } from "node:fs";

import type { ModelBackendProfile } from "../../shared/model-routing";
import {
  ProviderRuntimeError,
  type ProviderDetection,
  type ProviderId,
  type ProviderInstallationUseTransfer,
} from "./contracts";
import {
  canonicalProviderExecutable,
  ProviderInstallationLeaseCoordinator,
  providerInstallationIdentity,
  providerInstallationPackageIdentity,
  sameProviderInstallationScope,
  type ProviderInstallationIdentity,
  type ProviderInstallationUseKind,
  type ProviderInstallationUseLease,
  type ProviderInstallationUseOwner,
  type ProviderInstallationVerificationAuthority,
} from "./installation-lease";
import type { ProviderMetadataCache } from "./metadata";

function providerExecutableFileIdentity(
  executable: string | null,
): string | null {
  if (!executable) return null;
  try {
    const stat = statSync(executable, { bigint: true });
    if (!stat.isFile()) return null;
    return [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(":");
  } catch {
    return null;
  }
}

export interface ProviderInstallationUseAdmission {
  identity: ProviderInstallationIdentity;
  owner: ProviderInstallationUseOwner;
  lease: ProviderInstallationUseLease;
}

export interface ProviderManagerInstallationOptions {
  leases?: ProviderInstallationLeaseCoordinator;
  metadataCache: ProviderMetadataCache;
  operationId(): string;
  configuredBoundary(providerId: ProviderId): string;
  invalidateEvidence(providerId: ProviderId): void;
}

export class ProviderManagerInstallationAuthority {
  private authorityUncertain = false;

  constructor(private readonly options: ProviderManagerInstallationOptions) {}

  get uncertain(): boolean {
    return this.authorityUncertain;
  }

  identity(
    providerId: ProviderId,
    executableInput: string,
    backendProfile: ModelBackendProfile,
    versionOverride?: string | null,
    replacementBoundaryInput?: string,
  ): ProviderInstallationIdentity {
    const canonical = canonicalProviderExecutable(executableInput);
    const metadata = this.options.metadataCache.nativeScope(providerId);
    const metadataExecutable = metadata.executable
      ? canonicalProviderExecutable(metadata.executable) ?? metadata.executable
      : null;
    const version = versionOverride === undefined
      ? canonical && metadataExecutable === canonical
        ? metadata.version
        : null
      : versionOverride;
    return providerInstallationIdentity({
      providerId,
      executable: canonical,
      installationRootIdentity: canonical
        ? null
        : `provider-command:${executableInput.trim()}`,
      packageIdentity: providerInstallationPackageIdentity(providerId),
      version,
      directFileIdentity: providerExecutableFileIdentity(canonical),
      backendConfigurationIdentity: JSON.stringify([
        backendProfile.protocol,
        backendProfile.configurationRevision,
        backendProfile.endpointIdentity,
        backendProfile.authenticationMode,
      ]),
      profileIdentity: backendProfile.id,
      environmentIdentity: "runtime-provider-environment:v1",
      replacementBoundaryIdentity: replacementBoundaryInput
        ?? this.options.configuredBoundary(providerId),
    });
  }

  acquire(
    providerId: ProviderId,
    executable: string,
    backendProfile: ModelBackendProfile,
    kind: ProviderInstallationUseKind,
    operationId: string,
    verificationAuthority?: ProviderInstallationVerificationAuthority,
    versionOverride?: string | null,
    replacementBoundaryInput?: string,
  ): ProviderInstallationUseAdmission | null {
    if (!this.options.leases) return null;
    const identity = this.identity(
      providerId,
      executable,
      backendProfile,
      versionOverride,
      replacementBoundaryInput,
    );
    const owner = { kind, operationId } satisfies ProviderInstallationUseOwner;
    return {
      identity,
      owner,
      lease: this.options.leases.acquireUse(
        identity,
        owner,
        verificationAuthority ? { verificationAuthority } : {},
      ),
    };
  }

  operationIdentity(
    kind: ProviderInstallationUseKind,
    authority?: ProviderInstallationVerificationAuthority,
  ): string {
    return authority?.operationId ?? `${kind}:${this.options.operationId()}`;
  }

  release(admission: ProviderInstallationUseAdmission | null): boolean {
    if (!admission) return true;
    const released = admission.lease.release({ cleanupConfirmed: true });
    if (!released) {
      this.authorityUncertain = true;
      this.options.invalidateEvidence(admission.identity.providerId);
      this.options.leases?.quarantineObservation(
        admission.identity,
        admission.owner,
        "provider-installation-release-mismatch",
      );
    }
    return released;
  }

  quarantine(
    admission: ProviderInstallationUseAdmission | null,
    reason: string,
    observedIdentity?: ProviderInstallationIdentity,
  ): void {
    if (!admission) return;
    this.authorityUncertain = true;
    this.options.invalidateEvidence(admission.identity.providerId);
    admission.lease.quarantine(reason);
    if (
      observedIdentity
      && !sameProviderInstallationScope(admission.identity, observedIdentity)
    ) {
      this.options.leases?.quarantineObservation(
        observedIdentity,
        admission.owner,
        reason,
      );
    }
  }

  transfer(
    admission: ProviderInstallationUseAdmission | null,
  ): ProviderInstallationUseTransfer {
    let state: "pending" | "accepted" | "settled" = "pending";
    return Object.freeze({
      accept: () => {
        if (state !== "pending") return null;
        state = "accepted";
        return Object.freeze({
          release: () => {
            if (state !== "accepted") return false;
            state = "settled";
            return this.release(admission);
          },
          quarantine: (reason: string) => {
            if (state !== "accepted") return false;
            state = "settled";
            this.quarantine(admission, reason);
            return true;
          },
        });
      },
      abandonBeforeSpawn: () => {
        if (state !== "pending") return false;
        state = "settled";
        return this.release(admission);
      },
    });
  }

  settleDetection(
    admission: ProviderInstallationUseAdmission | null,
    detection: ProviderDetection,
    backendProfile: ModelBackendProfile,
    verificationAuthority?: ProviderInstallationVerificationAuthority,
    allowUnboundInitialResolution = false,
  ): void {
    if (!admission) return;
    const observedIdentity = detection.executable
      ? this.identity(
          detection.provider.id,
          detection.executable,
          backendProfile,
          detection.version ?? null,
        )
      : undefined;
    if (!detection.cleanupConfirmed) {
      this.quarantine(
        admission,
        "provider-discovery-cleanup-unconfirmed",
        observedIdentity,
      );
      return;
    }
    if (
      !observedIdentity
      || sameProviderInstallationScope(admission.identity, observedIdentity)
    ) {
      if (!this.release(admission)) {
        throw new ProviderRuntimeError(
          "lifecycle_corruption",
          "Provider discovery could not release exact installation authority.",
        );
      }
      return;
    }
    if (!verificationAuthority && !allowUnboundInitialResolution) {
      this.quarantine(
        admission,
        "provider-discovery-crossed-installation-authority",
        observedIdentity,
      );
      throw new ProviderRuntimeError(
        "lifecycle_corruption",
        "Provider discovery observed a different installation without replacement authority.",
      );
    }

    let observedAdmission: ProviderInstallationUseAdmission;
    try {
      observedAdmission = {
        identity: observedIdentity,
        owner: admission.owner,
        lease: this.options.leases!.acquireUse(
          observedIdentity,
          admission.owner,
          verificationAuthority ? { verificationAuthority } : {},
        ),
      };
    } catch (error) {
      this.release(admission);
      this.authorityUncertain = true;
      this.options.leases?.quarantineObservation(
        observedIdentity,
        admission.owner,
        "provider-discovery-crossed-installation-authority",
      );
      throw error;
    }
    const initialReleased = this.release(admission);
    const observedReleased = this.release(observedAdmission);
    if (!initialReleased || !observedReleased) {
      throw new ProviderRuntimeError(
        "lifecycle_corruption",
        "Provider discovery could not transfer exact installation authority.",
      );
    }
  }
}
