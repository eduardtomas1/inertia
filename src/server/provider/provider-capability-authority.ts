import type { ProviderCapabilityContractView } from "../../shared/contracts/app";
import {
  knownHarnessIdSchema,
  nativeHarnessId,
  type HarnessBackendCompatibility,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelCapability,
} from "../../shared/model-routing";
import { validateProviderRunInput } from "./adapters";
import {
  attestedProviderCapability,
  providerCapabilityManifest,
  providerContinuationCompatibilityToken,
  type ProviderCapabilityId,
} from "./capability-manifest";
import type {
  ProviderDetection,
  ProviderId,
  ProviderRunInput,
} from "./contracts";
import type { ProviderMetadataCache } from "./metadata";
import {
  nativeRuntimeCapabilityInput,
  runtimeProviderCapabilityAttestation,
  runtimeProviderCapabilityContract,
  type ProviderProtocolInstallationEvidence,
} from "./runtime-capability-attestation";

export interface ProviderCapabilityAuthorityOptions {
  metadataCache: ProviderMetadataCache;
  resolvedExecutable(providerId: ProviderId): string | undefined;
  installationFingerprint(
    providerId: ProviderId,
    executable: string,
    version: string,
  ): string;
  customProbeCapabilities(
    providerId: ProviderId,
    backendProfile: ModelBackendProfile,
    modelId: string,
  ): readonly ModelCapability[];
  evidenceTrusted(): boolean;
}

/**
 * Owns installation-bound protocol evidence and produces capability answers.
 * Negotiated observations are supplied per query and are never retained here,
 * so one run cannot grant availability to another run.
 */
export class ProviderCapabilityAuthority {
  private readonly protocolVerifiedInstallations =
    new Map<ProviderId, ProviderProtocolInstallationEvidence>();

  constructor(private readonly options: ProviderCapabilityAuthorityOptions) {}

  contract(providerId: ProviderId): ProviderCapabilityContractView {
    const native = nativeRuntimeCapabilityInput(providerId);
    return runtimeProviderCapabilityContract(
      providerId,
      this.attestation(
        providerId,
        native.harnessId,
        native.backendProfile,
        native.compatibility,
        ["host-tool-bridge"],
      ),
    );
  }

  maintenanceAvailable(
    providerId: ProviderId,
    executable: string | null,
    updateActionVerified: boolean,
  ): boolean {
    const native = nativeRuntimeCapabilityInput(providerId);
    if (
      !updateActionVerified
      || !executable
      || executable !== this.options.resolvedExecutable(providerId)
    ) return false;
    const attestation = this.attestation(
      providerId,
      native.harnessId,
      native.backendProfile,
      native.compatibility,
      [],
      { "maintenance-update": true },
    );
    return attestation
      ? attestedProviderCapability(attestation, "maintenance-update")
        .currentlyAvailable
      : false;
  }

  available(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured: readonly ProviderCapabilityId[] = [],
    negotiated: readonly ProviderCapabilityId[] = [],
  ): boolean {
    return this.capabilityForInput(
      input,
      capabilityId,
      configured,
      negotiated,
    )?.currentlyAvailable === true;
  }

  admissible(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured: readonly ProviderCapabilityId[] = [],
  ): boolean {
    const capability = this.capabilityForInput(
      input,
      capabilityId,
      configured,
    );
    return capability?.currentlyAvailable === true
      || (
        capability?.installedVersionCompatible === true
        && capability.support === "negotiated"
      );
  }

  continuationToken(
    providerId: ProviderId,
    harnessId: KnownHarnessId,
    backendProfile: ModelBackendProfile,
    compatibility: HarnessBackendCompatibility,
    modelId: string,
  ): string | null {
    const attestation = this.attestation(
      providerId,
      harnessId,
      backendProfile,
      compatibility,
      [],
      {},
      modelId,
    );
    if (!attestation) return null;
    if (
      backendProfile.source === "custom"
      && !attestedProviderCapability(attestation, "session-resume")
        .currentlyAvailable
    ) return null;
    return providerContinuationCompatibilityToken(attestation);
  }

  invalidate(providerId: ProviderId): void {
    this.protocolVerifiedInstallations.delete(providerId);
  }

  installationFingerprint(providerId: ProviderId): string | null {
    return this.protocolVerifiedInstallations.get(providerId)
      ?.installationFingerprint ?? null;
  }

  rememberDetection(detection: ProviderDetection): void {
    const providerId = detection.provider.id;
    const harnessId = nativeHarnessId(providerId);
    const manifest = providerCapabilityManifest(harnessId);
    if (
      !manifest
      || !(detection.protocolVerified ?? detection.canRun)
      || !detection.cleanupConfirmed
      || !detection.executable
      || !detection.version
    ) {
      this.invalidate(providerId);
      return;
    }
    this.protocolVerifiedInstallations.set(providerId, {
      executable: detection.executable,
      version: detection.version,
      harnessId,
      manifestDigest: manifest.digest,
      installationFingerprint: this.options.installationFingerprint(
        providerId,
        detection.executable,
        detection.version,
      ),
    });
  }

  private capabilityForInput(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured: readonly ProviderCapabilityId[],
    negotiated: readonly ProviderCapabilityId[] = [],
  ) {
    try {
      validateProviderRunInput(input);
      const harnessId = knownHarnessIdSchema.parse(input.harnessId);
      const attestation = this.attestation(
        input.providerId,
        harnessId,
        input.backendProfile,
        input.backendCompatibility,
        configured,
        Object.fromEntries(
          negotiated.map((id) => [id, true]),
        ) as Partial<Record<ProviderCapabilityId, boolean>>,
        input.modelSelection.modelId,
      );
      return attestation
        ? attestedProviderCapability(attestation, capabilityId)
        : null;
    } catch {
      return null;
    }
  }

  private attestation(
    providerId: ProviderId,
    harnessId: KnownHarnessId,
    backendProfile: ModelBackendProfile,
    compatibility: HarnessBackendCompatibility,
    additionalConfigured: readonly ProviderCapabilityId[] = [],
    additionalNegotiated: Readonly<Partial<
      Record<ProviderCapabilityId, boolean>
    >> = {},
    modelId: string | null = null,
  ) {
    const executable = this.options.resolvedExecutable(providerId);
    const installation = this.options.metadataCache.nativeScope(providerId);
    const installationFingerprint = executable && installation.version
      ? this.options.installationFingerprint(
          providerId,
          executable,
          installation.version,
        )
      : null;
    return runtimeProviderCapabilityAttestation({
      providerId,
      harnessId,
      backendProfile,
      compatibility,
      executable,
      installation,
      installationFingerprint,
      protocolEvidence: this.protocolVerifiedInstallations.get(providerId),
      evidenceTrusted: this.options.evidenceTrusted(),
      additionalConfigured,
      additionalNegotiated,
      customProbeCapabilities: backendProfile.source === "custom" && modelId
        ? this.options.customProbeCapabilities(providerId, backendProfile, modelId)
        : [],
    });
  }
}
