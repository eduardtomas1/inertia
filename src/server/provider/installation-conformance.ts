import type { ProviderCapabilityContractView } from "../../shared/contracts/app";
import {
  ProviderRuntimeError,
  type ProviderDetection,
  type ProviderId,
} from "./contracts";
import type {
  ProviderInstallationIdentity,
  ProviderInstallationVerificationAuthority,
} from "./installation-lease";
import type {
  ProviderManagerDetectionOptions,
  ProviderManagerMetadataRequestOptions,
} from "./provider-manager-types";

export interface ProviderInstallationConformanceRuntime {
  detect(
    providerId: ProviderId,
    options: ProviderManagerDetectionOptions,
  ): Promise<ProviderDetection>;
  metadata(
    providerId: ProviderId,
    cwd: string,
    options: ProviderManagerMetadataRequestOptions,
  ): Promise<unknown>;
  providerCapabilityContract(providerId: ProviderId): ProviderCapabilityContractView;
  providerInstallationIdentityForMaintenance(
    providerId: ProviderId,
    executable: string | null,
    version: string | null,
  ): ProviderInstallationIdentity;
}

export async function verifyProviderInstallationConformance(
  runtime: ProviderInstallationConformanceRuntime,
  providerId: ProviderId,
  cwd: string,
  authority: ProviderInstallationVerificationAuthority,
): Promise<ProviderInstallationIdentity> {
  if (authority.providerId !== providerId) {
    throw new ProviderRuntimeError(
      "lifecycle_corruption",
      "Provider installation verification authority has the wrong owner.",
    );
  }
  const context = { installationVerificationAuthority: authority };
  const detection = await runtime.detect(providerId, {
    ...context,
    cwd,
    refreshEnvironment: true,
    probeAuthentication: true,
  });
  if (
    !detection.available
    || !(detection.protocolVerified ?? detection.canRun)
    || !(detection.canRun || detection.authState === "unauthenticated")
    || !detection.executable
    || !detection.version
    || !detection.cleanupConfirmed
  ) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The provider installation failed its native protocol conformance probe.",
    );
  }
  if (detection.canRun) await runtime.metadata(providerId, cwd, { ...context, force: true });
  if (!runtime.providerCapabilityContract(providerId).installationVerified) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "The provider installation could not produce a verified capability contract.",
    );
  }
  return runtime.providerInstallationIdentityForMaintenance(
    providerId,
    detection.executable,
    detection.version,
  );
}
