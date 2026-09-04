import type { ProviderCapabilityContractView } from "../../shared/contracts/app";
import {
  resolveHarnessBackendCompatibility,
  nativeBackendProfile,
  nativeHarnessId,
  type HarnessBackendCompatibility,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelCapability,
} from "../../shared/model-routing";
import {
  attestProviderCapabilities,
  attestedProviderCapability,
  providerCapabilityManifest,
  type ProviderCapabilityAttestation,
  type ProviderCapabilityId,
} from "./capability-manifest";
import type { ProviderId } from "./contracts";

export interface ProviderProtocolInstallationEvidence {
  executable: string;
  version: string;
  harnessId: KnownHarnessId;
  manifestDigest: string;
  installationFingerprint: string;
}

export interface RuntimeProviderCapabilityInput {
  providerId: ProviderId;
  harnessId: KnownHarnessId;
  backendProfile: ModelBackendProfile;
  compatibility: HarnessBackendCompatibility;
  executable: string | undefined;
  installation: { executable: string | null; version: string | null };
  installationFingerprint: string | null;
  protocolEvidence: ProviderProtocolInstallationEvidence | undefined;
  evidenceTrusted: boolean;
  additionalConfigured?: readonly ProviderCapabilityId[];
  additionalNegotiated?: Readonly<Partial<Record<ProviderCapabilityId, boolean>>>;
  customProbeCapabilities?: readonly ModelCapability[];
}

const CUSTOM_BACKEND_BASELINE_CAPABILITIES = new Set<ProviderCapabilityId>([
  "cancellation",
  "process-cleanup",
  "native-session-id",
  "custom-backend",
  "endpoint-selection",
]);

const CUSTOM_MODEL_CAPABILITY_MAP: Readonly<
  Partial<Record<ModelCapability["id"], readonly ProviderCapabilityId[]>>
> = {
  streaming: ["text-streaming"],
  tools: ["tool-activity", "provider-native-tools"],
  images: ["images"],
  reasoning: ["reasoning"],
  usage: ["usage-tokens"],
  subagents: ["subagent-create", "subagent-stop"],
  compaction: ["compaction"],
  "session-continuation": ["session-resume"],
};

export function customBackendObservedCapabilities(
  capabilities: readonly ModelCapability[],
): readonly ProviderCapabilityId[] {
  const observed = new Set(CUSTOM_BACKEND_BASELINE_CAPABILITIES);
  for (const capability of capabilities) {
    if (
      capability.state !== "verified"
      || capability.provenance !== "probe"
    ) continue;
    for (const id of CUSTOM_MODEL_CAPABILITY_MAP[capability.id] ?? []) {
      observed.add(id);
    }
  }
  return Object.freeze([...observed]);
}

export function runtimeProviderCapabilityAttestation(
  input: RuntimeProviderCapabilityInput,
): ProviderCapabilityAttestation | null {
  if (!input.evidenceTrusted) return null;
  const manifest = providerCapabilityManifest(input.harnessId);
  const protocolVerified = (
    (
      input.compatibility.state === "verified"
      || input.compatibility.state === "partially-compatible"
    )
    && input.compatibility.provenance === "built-in"
  ) || (
    input.compatibility.state === "partially-compatible"
    && input.compatibility.provenance === "probe"
  );
  if (
    !manifest
    || manifest.providerId !== input.providerId
    || !input.executable
    || input.installation.executable !== input.executable
    || input.installation.version === null
    || input.installationFingerprint === null
    || input.protocolEvidence?.executable !== input.executable
    || input.protocolEvidence.version !== input.installation.version
    || input.protocolEvidence.harnessId !== input.harnessId
    || input.protocolEvidence.manifestDigest !== manifest.digest
    || input.protocolEvidence.installationFingerprint
      !== input.installationFingerprint
    || !protocolVerified
  ) return null;

  const configured = new Set<ProviderCapabilityId>(input.additionalConfigured);
  const negotiated: Partial<Record<ProviderCapabilityId, boolean>> = {
    ...input.additionalNegotiated,
  };
  let observed: readonly ProviderCapabilityId[] | undefined;
  if (input.backendProfile.source === "custom") {
    observed = customBackendObservedCapabilities(
      input.customProbeCapabilities ?? [],
    );
    configured.add("custom-backend");
    negotiated["custom-backend"] = true;
    if (input.backendProfile.endpointIdentity !== null) {
      configured.add("endpoint-selection");
      negotiated["endpoint-selection"] = true;
    }
  }
  try {
    return attestProviderCapabilities(manifest, {
      installationIdentity: input.installationFingerprint,
      installationVersion: input.installation.version,
      protocolVerifiedInstallationVersion: input.protocolEvidence.version,
      backendConfigurationRevision:
        input.backendProfile.configurationRevision,
      protocolVerified,
      observation: {
        configured: [...configured],
        negotiated,
        ...(observed ? { observed } : {}),
      },
    });
  } catch {
    return null;
  }
}

export function runtimeProviderCapabilityContract(
  providerId: ProviderId,
  attestation: ProviderCapabilityAttestation | null,
): ProviderCapabilityContractView {
  const harnessId = nativeHarnessId(providerId);
  const manifest = providerCapabilityManifest(harnessId);
  if (!attestation || !manifest || manifest.providerId !== providerId) {
    return {
      schemaVersion: 1,
      harnessId,
      manifestDigest: manifest?.digest ?? "unregistered",
      installationVerified: false,
      installedVersion: null,
      currentlyAvailableCount: 0,
      declaredCapabilityCount: manifest?.capabilities.length ?? 0,
      hostToolBridgeAvailable: false,
    };
  }
  return {
    schemaVersion: 1,
    harnessId,
    manifestDigest: attestation.manifestDigest,
    installationVerified: true,
    installedVersion: attestation.installationVersion,
    currentlyAvailableCount: attestation.capabilities.filter(
      ({ currentlyAvailable }) => currentlyAvailable,
    ).length,
    declaredCapabilityCount: attestation.capabilities.length,
    hostToolBridgeAvailable: attestedProviderCapability(
      attestation,
      "host-tool-bridge",
    ).currentlyAvailable,
  };
}

export function nativeRuntimeCapabilityInput(
  providerId: ProviderId,
): Pick<
  RuntimeProviderCapabilityInput,
  "harnessId" | "backendProfile" | "compatibility"
> {
  const harnessId = nativeHarnessId(providerId);
  const backendProfile = nativeBackendProfile(providerId);
  return {
    harnessId,
    backendProfile,
    compatibility: resolveHarnessBackendCompatibility(
      harnessId,
      backendProfile,
    ),
  };
}
