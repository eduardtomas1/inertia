import { createHash } from "node:crypto";

import type { KnownHarnessId } from "../../shared/model-routing";
import type { ProviderId } from "./contracts";

export const PROVIDER_CAPABILITY_IDS = [
  "text-streaming",
  "reasoning",
  "tool-activity",
  "file-changes",
  "images",
  "plans",
  "goals",
  "approvals",
  "structured-input",
  "follow-up-steer",
  "session-resume",
  "compaction",
  "usage-tokens",
  "rate-limits",
  "subagent-create",
  "subagent-stop",
  "host-tool-bridge",
  "provider-native-tools",
  "model-discovery",
  "auth-state-discovery",
  "cancellation",
  "process-cleanup",
  "provider-owned-server",
  "maintenance-update",
  "custom-backend",
  "endpoint-selection",
  "performance-modes",
  "native-session-id",
] as const;

export type ProviderCapabilityId = (typeof PROVIDER_CAPABILITY_IDS)[number];

export type ProviderCapabilitySupport =
  | "native"
  | "host-exact-turn"
  | "negotiated"
  | "unavailable";

export type ProviderCapabilityFallback =
  | "none"
  | "host-exact-turn"
  | "reject-until-negotiated"
  | "reject-unsupported-operation"
  | "start-fresh-session";

export interface ProviderCapabilityDeclaration {
  readonly id: ProviderCapabilityId;
  readonly support: ProviderCapabilitySupport;
  readonly requiresConfiguration: boolean;
  readonly contractTest: string;
  readonly fallback: ProviderCapabilityFallback;
  readonly unavailableReasonCode:
    | "configuration-required"
    | "installation-unverified"
    | "negotiation-required"
    | "unsupported-operation";
}

export interface ProviderCapabilityManifest {
  readonly schemaVersion: 1;
  readonly providerId: ProviderId;
  readonly harnessId: KnownHarnessId;
  readonly implementationRevision: number;
  readonly protocolRevision: string;
  readonly bundledSdkVersion: string | null;
  readonly installationVersionSource: "provider-executable";
  readonly capabilities: readonly ProviderCapabilityDeclaration[];
  readonly digest: string;
}

export interface ProviderCapabilityObservation {
  readonly negotiated?: Partial<Record<ProviderCapabilityId, boolean>>;
  readonly configured?: readonly ProviderCapabilityId[];
  /**
   * Optional positive observation ceiling. When present, declarations remain
   * unavailable unless their exact capability id was observed as well. This
   * keeps a narrowly exercised custom backend from inheriting every native
   * capability of the local harness.
   */
  readonly observed?: readonly ProviderCapabilityId[];
}

export interface ProviderCapabilityAttestationInput {
  /** Opaque input which may contain a path; only its digest is returned. */
  readonly installationIdentity: string;
  readonly installationVersion: string | null;
  /** Exact version for which this protocol route was exercised successfully. */
  readonly protocolVerifiedInstallationVersion: string | null;
  readonly backendConfigurationRevision: number;
  readonly protocolVerified: boolean;
  readonly observation?: ProviderCapabilityObservation;
}

export interface AttestedProviderCapability
  extends ProviderCapabilityDeclaration {
  readonly installedVersionCompatible: boolean;
  readonly configurationAvailable: boolean;
  readonly observedAvailable: boolean;
  readonly currentlyAvailable: boolean;
}

export interface ProviderCapabilityAttestation {
  readonly schemaVersion: 1;
  readonly providerId: ProviderId;
  readonly harnessId: KnownHarnessId;
  readonly installationVersion: string | null;
  readonly backendConfigurationRevision: number;
  readonly protocolRevision: string;
  readonly implementationRevision: number;
  readonly manifestDigest: string;
  readonly installationDigest: string;
  readonly capabilities: readonly AttestedProviderCapability[];
  readonly attestationDigest: string;
}

type ProductionHarnessId =
  | "codex-app-server"
  | "claude-agent-sdk"
  | "cursor-acp"
  | "gemini-acp"
  | "kimi-acp"
  | "opencode-sdk";

interface ManifestDefinition {
  readonly providerId: ProviderId;
  readonly harnessId: ProductionHarnessId;
  readonly implementationRevision: number;
  readonly protocolRevision: string;
  readonly bundledSdkVersion: string | null;
  readonly requiresConfiguration?: readonly ProviderCapabilityId[];
  readonly support: Readonly<Partial<Record<ProviderCapabilityId, ProviderCapabilitySupport>>>;
}

const MAX_INSTALLATION_IDENTITY_CHARS = 2_048;
const MAX_INSTALLATION_VERSION_CHARS = 200;
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

const MANIFEST_KEYS = [
  "bundledSdkVersion",
  "capabilities",
  "digest",
  "harnessId",
  "implementationRevision",
  "installationVersionSource",
  "protocolRevision",
  "providerId",
  "schemaVersion",
] as const;

const DECLARATION_KEYS = [
  "contractTest",
  "fallback",
  "id",
  "requiresConfiguration",
  "support",
  "unavailableReasonCode",
] as const;

const ATTESTATION_INPUT_KEYS = [
  "backendConfigurationRevision",
  "installationIdentity",
  "installationVersion",
  "observation",
  "protocolVerified",
  "protocolVerifiedInstallationVersion",
] as const;

const OBSERVATION_KEYS = ["configured", "negotiated", "observed"] as const;
const ATTESTATION_KEYS = [
  "attestationDigest",
  "backendConfigurationRevision",
  "capabilities",
  "harnessId",
  "implementationRevision",
  "installationDigest",
  "installationVersion",
  "manifestDigest",
  "protocolRevision",
  "providerId",
  "schemaVersion",
] as const;
const ATTESTED_CAPABILITY_KEYS = [
  ...DECLARATION_KEYS,
  "configurationAvailable",
  "currentlyAvailable",
  "installedVersionCompatible",
  "observedAvailable",
] as const;

const PROVIDER_IDS = new Set<ProviderId>([
  "codex",
  "claude",
  "cursor",
  "gemini",
  "kimi",
  "opencode",
]);
const CAPABILITY_IDS = new Set<ProviderCapabilityId>(PROVIDER_CAPABILITY_IDS);
const SUPPORT_VALUES = new Set<ProviderCapabilitySupport>([
  "native",
  "host-exact-turn",
  "negotiated",
  "unavailable",
]);
const FALLBACK_VALUES = new Set<ProviderCapabilityFallback>([
  "none",
  "host-exact-turn",
  "reject-until-negotiated",
  "reject-unsupported-operation",
  "start-fresh-session",
]);
const REASON_CODES = new Set<
  ProviderCapabilityDeclaration["unavailableReasonCode"]
>([
  "configuration-required",
  "installation-unverified",
  "negotiation-required",
  "unsupported-operation",
]);

const BASE_REQUIRES_CONFIGURATION: readonly ProviderCapabilityId[] = [
  "host-tool-bridge",
];

const CONTRACT_TESTS: Readonly<Record<ProductionHarnessId, string>> = {
  "codex-app-server": "tests/server/codex-app-server.test.ts",
  "claude-agent-sdk": "tests/server/claude-agent-sdk-harness.test.ts",
  "cursor-acp": "tests/server/cursor-acp-harness.test.ts",
  "gemini-acp": "tests/server/gemini-acp-harness.test.ts",
  "kimi-acp": "tests/server/kimi-acp-harness.test.ts",
  "opencode-sdk": "tests/server/opencode-sdk-harness.test.ts",
};

const CORE_NATIVE = {
  "text-streaming": "native",
  "reasoning": "native",
  "tool-activity": "native",
  "file-changes": "native",
  images: "negotiated",
  plans: "native",
  approvals: "native",
  "structured-input": "native",
  "session-resume": "native",
  compaction: "native",
  "provider-native-tools": "native",
  "model-discovery": "native",
  "auth-state-discovery": "native",
  cancellation: "native",
  "native-session-id": "native",
  "host-tool-bridge": "host-exact-turn",
  "process-cleanup": "host-exact-turn",
  "maintenance-update": "negotiated",
} as const satisfies Partial<Record<ProviderCapabilityId, ProviderCapabilitySupport>>;

const DEFINITIONS: readonly ManifestDefinition[] = [
  {
    providerId: "codex",
    harnessId: "codex-app-server",
    implementationRevision: 1,
    protocolRevision: "codex-app-server/version-specific-v1",
    bundledSdkVersion: null,
    requiresConfiguration: ["custom-backend", "endpoint-selection"],
    support: {
      ...CORE_NATIVE,
      images: "native",
      goals: "native",
      "follow-up-steer": "native",
      "usage-tokens": "native",
      "rate-limits": "negotiated",
      "subagent-create": "native",
      "custom-backend": "negotiated",
      "endpoint-selection": "negotiated",
      "performance-modes": "negotiated",
    },
  },
  {
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    implementationRevision: 1,
    protocolRevision: "claude-agent-sdk/messages-v1",
    bundledSdkVersion: "0.3.259",
    requiresConfiguration: ["custom-backend", "endpoint-selection"],
    support: {
      ...CORE_NATIVE,
      images: "native",
      "follow-up-steer": "native",
      "usage-tokens": "native",
      "rate-limits": "negotiated",
      "subagent-create": "native",
      "subagent-stop": "native",
      "custom-backend": "negotiated",
      "endpoint-selection": "negotiated",
      "performance-modes": "negotiated",
    },
  },
  {
    providerId: "cursor",
    harnessId: "cursor-acp",
    implementationRevision: 1,
    protocolRevision: "acp-v1/sdk-1.4.0/cursor",
    bundledSdkVersion: "1.4.0",
    support: {
      ...CORE_NATIVE,
      images: "negotiated",
      "structured-input": "negotiated",
      "session-resume": "negotiated",
      compaction: "negotiated",
      "usage-tokens": "negotiated",
      "model-discovery": "negotiated",
      "subagent-create": "negotiated",
    },
  },
  {
    providerId: "gemini",
    harnessId: "gemini-acp",
    implementationRevision: 1,
    protocolRevision: "acp-v1/sdk-1.4.0/gemini-cli-0.58",
    bundledSdkVersion: "1.4.0",
    support: {
      "text-streaming": "native",
      reasoning: "native",
      "tool-activity": "native",
      "file-changes": "native",
      images: "negotiated",
      plans: "negotiated",
      approvals: "native",
      "usage-tokens": "negotiated",
      "host-tool-bridge": "host-exact-turn",
      "provider-native-tools": "native",
      "model-discovery": "negotiated",
      cancellation: "native",
      "process-cleanup": "host-exact-turn",
      "maintenance-update": "negotiated",
    },
  },
  {
    providerId: "kimi",
    harnessId: "kimi-acp",
    implementationRevision: 1,
    protocolRevision: "acp-v1/sdk-1.4.0/kimi",
    bundledSdkVersion: "1.4.0",
    support: {
      ...CORE_NATIVE,
      images: "negotiated",
      "session-resume": "negotiated",
      compaction: "negotiated",
      "usage-tokens": "negotiated",
      "model-discovery": "negotiated",
      "maintenance-update": "unavailable",
    },
  },
  {
    providerId: "opencode",
    harnessId: "opencode-sdk",
    implementationRevision: 1,
    protocolRevision: "opencode-owned-server/sdk-1.18.27",
    bundledSdkVersion: "1.18.27",
    support: {
      ...CORE_NATIVE,
      "follow-up-steer": "native",
      "usage-tokens": "native",
      "provider-owned-server": "native",
    },
  },
];

function fallbackFor(
  id: ProviderCapabilityId,
  support: ProviderCapabilitySupport,
  requiresConfiguration: boolean,
): Pick<ProviderCapabilityDeclaration, "fallback" | "unavailableReasonCode"> {
  if (support === "unavailable") {
    return {
      fallback: id === "session-resume"
        ? "start-fresh-session"
        : "reject-unsupported-operation",
      unavailableReasonCode: "unsupported-operation",
    };
  }
  if (support === "host-exact-turn") {
    return {
      fallback: "host-exact-turn",
      unavailableReasonCode: requiresConfiguration
        ? "configuration-required"
        : "installation-unverified",
    };
  }
  if (support === "negotiated") {
    return {
      fallback: "reject-until-negotiated",
      unavailableReasonCode: "negotiation-required",
    };
  }
  return {
    fallback: requiresConfiguration ? "reject-unsupported-operation" : "none",
    unavailableReasonCode: requiresConfiguration
      ? "configuration-required"
      : "installation-unverified",
  };
}

function canonicalManifest(
  manifest: Omit<ProviderCapabilityManifest, "digest">,
): string {
  return JSON.stringify(manifest);
}

function digestManifest(
  manifest: Omit<ProviderCapabilityManifest, "digest">,
): string {
  return createHash("sha256")
    .update("inertia.provider-capability-manifest.v1\0", "utf8")
    .update(canonicalManifest(manifest), "utf8")
    .digest("hex");
}

function manifestFrom(
  definition: ManifestDefinition,
): ProviderCapabilityManifest {
  const configured = new Set([
    ...BASE_REQUIRES_CONFIGURATION,
    ...(definition.requiresConfiguration ?? []),
  ]);
  const capabilities = Object.freeze(PROVIDER_CAPABILITY_IDS.map((id) => {
    const support = definition.support[id] ?? "unavailable";
    const requiresConfiguration = configured.has(id);
    return Object.freeze({
      id,
      support,
      requiresConfiguration,
      contractTest: CONTRACT_TESTS[definition.harnessId],
      ...fallbackFor(id, support, requiresConfiguration),
    });
  }));
  const unsigned = {
    schemaVersion: 1 as const,
    providerId: definition.providerId,
    harnessId: definition.harnessId,
    implementationRevision: definition.implementationRevision,
    protocolRevision: definition.protocolRevision,
    bundledSdkVersion: definition.bundledSdkVersion,
    installationVersionSource: "provider-executable" as const,
    capabilities,
  };
  const digest = digestManifest(unsigned);
  return Object.freeze({ ...unsigned, digest });
}

const MANIFESTS = Object.freeze(DEFINITIONS.map(manifestFrom));
const MANIFEST_BY_HARNESS = new Map(
  MANIFESTS.map((manifest) => [manifest.harnessId, manifest]),
);

export function productionProviderCapabilityManifests(): readonly ProviderCapabilityManifest[] {
  return MANIFESTS;
}

export function providerCapabilityManifest(
  harnessId: KnownHarnessId,
): ProviderCapabilityManifest | null {
  return typeof harnessId === "string"
    ? MANIFEST_BY_HARNESS.get(harnessId as ProductionHarnessId) ?? null
    : null;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function boundedControlFreeText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

function safeConfigurationRevision(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function unsignedManifest(
  manifest: ProviderCapabilityManifest,
): Omit<ProviderCapabilityManifest, "digest"> {
  return {
    schemaVersion: manifest.schemaVersion,
    providerId: manifest.providerId,
    harnessId: manifest.harnessId,
    implementationRevision: manifest.implementationRevision,
    protocolRevision: manifest.protocolRevision,
    bundledSdkVersion: manifest.bundledSdkVersion,
    installationVersionSource: manifest.installationVersionSource,
    capabilities: manifest.capabilities.map((capability) => ({
      id: capability.id,
      support: capability.support,
      requiresConfiguration: capability.requiresConfiguration,
      contractTest: capability.contractTest,
      fallback: capability.fallback,
      unavailableReasonCode: capability.unavailableReasonCode,
    })),
  };
}

function declarationMatches(
  value: unknown,
  expected: ProviderCapabilityDeclaration,
): value is ProviderCapabilityDeclaration {
  if (
    !plainRecord(value)
    || !exactObjectKeys(value, DECLARATION_KEYS)
    || !CAPABILITY_IDS.has(value.id as ProviderCapabilityId)
    || !SUPPORT_VALUES.has(value.support as ProviderCapabilitySupport)
    || typeof value.requiresConfiguration !== "boolean"
    || !boundedControlFreeText(value.contractTest, 300)
    || !FALLBACK_VALUES.has(value.fallback as ProviderCapabilityFallback)
    || !REASON_CODES.has(
      value.unavailableReasonCode as
        ProviderCapabilityDeclaration["unavailableReasonCode"],
    )
  ) return false;
  return value.id === expected.id
    && value.support === expected.support
    && value.requiresConfiguration === expected.requiresConfiguration
    && value.contractTest === expected.contractTest
    && value.fallback === expected.fallback
    && value.unavailableReasonCode === expected.unavailableReasonCode;
}

function trustedManifest(value: unknown): ProviderCapabilityManifest | null {
  if (
    !plainRecord(value)
    || !exactObjectKeys(value, MANIFEST_KEYS)
    || value.schemaVersion !== 1
    || !PROVIDER_IDS.has(value.providerId as ProviderId)
    || typeof value.harnessId !== "string"
    || !Number.isSafeInteger(value.implementationRevision)
    || (value.implementationRevision as number) < 1
    || !boundedControlFreeText(value.protocolRevision, 200)
    || !(
      value.bundledSdkVersion === null
      || boundedControlFreeText(value.bundledSdkVersion, 200)
    )
    || value.installationVersionSource !== "provider-executable"
    || !Array.isArray(value.capabilities)
    || value.capabilities.length !== PROVIDER_CAPABILITY_IDS.length
    || typeof value.digest !== "string"
    || !DIGEST_PATTERN.test(value.digest)
  ) return null;
  const expected = MANIFEST_BY_HARNESS.get(
    value.harnessId as ProductionHarnessId,
  );
  if (
    !expected
    || value.providerId !== expected.providerId
    || value.implementationRevision !== expected.implementationRevision
    || value.protocolRevision !== expected.protocolRevision
    || value.bundledSdkVersion !== expected.bundledSdkVersion
    || value.digest !== expected.digest
    || !value.capabilities.every((declaration, index) =>
      declarationMatches(declaration, expected.capabilities[index]!))
  ) return null;
  const candidate = value as unknown as ProviderCapabilityManifest;
  return digestManifest(unsignedManifest(candidate)) === candidate.digest
    ? expected
    : null;
}

interface ValidatedObservation {
  readonly configured: ReadonlySet<ProviderCapabilityId>;
  readonly negotiated: Readonly<Partial<Record<ProviderCapabilityId, boolean>>>;
  readonly observed: ReadonlySet<ProviderCapabilityId> | null;
}

interface ValidatedAttestationInput {
  readonly installationIdentity: string;
  readonly installationVersion: string | null;
  readonly protocolVerifiedInstallationVersion: string | null;
  readonly backendConfigurationRevision: number;
  readonly protocolVerified: boolean;
  readonly observation: ValidatedObservation;
}

function validatedObservation(
  value: unknown,
  manifest: ProviderCapabilityManifest,
): ValidatedObservation | null {
  if (value === undefined) {
    return {
      configured: new Set(),
      negotiated: Object.freeze({}),
      observed: null,
    };
  }
  if (!plainRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !OBSERVATION_KEYS.includes(
      key as (typeof OBSERVATION_KEYS)[number],
    ))
  ) return null;

  const configuredValue = value.configured;
  if (
    configuredValue !== undefined
    && (
      !Array.isArray(configuredValue)
      || configuredValue.length > PROVIDER_CAPABILITY_IDS.length
      || configuredValue.some((id) =>
        typeof id !== "string" || !CAPABILITY_IDS.has(id as ProviderCapabilityId))
      || new Set(configuredValue).size !== configuredValue.length
    )
  ) return null;
  const configured = new Set(
    (configuredValue ?? []) as readonly ProviderCapabilityId[],
  );
  if ([...configured].some((id) =>
    !manifest.capabilities.find((entry) => entry.id === id)
      ?.requiresConfiguration)) return null;

  const negotiatedValue = value.negotiated;
  if (negotiatedValue !== undefined && !plainRecord(negotiatedValue)) {
    return null;
  }
  if (
    negotiatedValue
    && Object.keys(negotiatedValue).length > PROVIDER_CAPABILITY_IDS.length
  ) return null;
  const negotiated: Partial<Record<ProviderCapabilityId, boolean>> = {};
  for (const [id, available] of Object.entries(negotiatedValue ?? {})) {
    const declaration = manifest.capabilities.find((entry) => entry.id === id);
    if (
      !CAPABILITY_IDS.has(id as ProviderCapabilityId)
      || declaration?.support !== "negotiated"
      || typeof available !== "boolean"
    ) return null;
    negotiated[id as ProviderCapabilityId] = available;
  }

  const observedValue = value.observed;
  if (
    observedValue !== undefined
    && (
      !Array.isArray(observedValue)
      || observedValue.length > PROVIDER_CAPABILITY_IDS.length
      || observedValue.some((id) =>
        typeof id !== "string" || !CAPABILITY_IDS.has(id as ProviderCapabilityId))
      || new Set(observedValue).size !== observedValue.length
    )
  ) return null;
  const observed = observedValue === undefined
    ? null
    : new Set(observedValue as readonly ProviderCapabilityId[]);
  if ([...(observed ?? [])].some((id) =>
    manifest.capabilities.find((entry) => entry.id === id)?.support
      === "unavailable")) return null;

  return {
    configured,
    negotiated: Object.freeze(negotiated),
    observed,
  };
}

function validatedAttestationInput(
  value: unknown,
  manifest: ProviderCapabilityManifest,
): ValidatedAttestationInput | null {
  if (!plainRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.some((key) => !ATTESTATION_INPUT_KEYS.includes(
      key as (typeof ATTESTATION_INPUT_KEYS)[number],
    ))
    || ![
      "installationIdentity",
      "installationVersion",
      "backendConfigurationRevision",
      "protocolVerified",
      "protocolVerifiedInstallationVersion",
    ].every((key) => Object.hasOwn(value, key))
    || !boundedControlFreeText(
      value.installationIdentity,
      MAX_INSTALLATION_IDENTITY_CHARS,
    )
    || !(
      value.installationVersion === null
      || boundedControlFreeText(
        value.installationVersion,
        MAX_INSTALLATION_VERSION_CHARS,
      )
    )
    || !(
      value.protocolVerifiedInstallationVersion === null
      || boundedControlFreeText(
        value.protocolVerifiedInstallationVersion,
        MAX_INSTALLATION_VERSION_CHARS,
      )
    )
    || !safeConfigurationRevision(value.backendConfigurationRevision)
    || typeof value.protocolVerified !== "boolean"
  ) return null;
  const observation = validatedObservation(value.observation, manifest);
  if (!observation) return null;
  return {
    installationIdentity: value.installationIdentity,
    installationVersion: value.installationVersion,
    protocolVerifiedInstallationVersion:
      value.protocolVerifiedInstallationVersion,
    backendConfigurationRevision: value.backendConfigurationRevision,
    protocolVerified: value.protocolVerified,
    observation,
  };
}

function unavailableReason(
  declaration: ProviderCapabilityDeclaration,
  installedVersionCompatible: boolean,
  configurationAvailable: boolean,
  observedAvailable: boolean,
): ProviderCapabilityDeclaration["unavailableReasonCode"] {
  if (!installedVersionCompatible) return "installation-unverified";
  if (!configurationAvailable) return "configuration-required";
  if (declaration.support === "unavailable") return "unsupported-operation";
  if (!observedAvailable) return "negotiation-required";
  return declaration.unavailableReasonCode;
}

function canonicalAttestationPayload(
  attestation: Omit<ProviderCapabilityAttestation, "attestationDigest">,
): Omit<ProviderCapabilityAttestation, "attestationDigest"> {
  return {
    schemaVersion: attestation.schemaVersion,
    providerId: attestation.providerId,
    harnessId: attestation.harnessId,
    installationVersion: attestation.installationVersion,
    backendConfigurationRevision: attestation.backendConfigurationRevision,
    protocolRevision: attestation.protocolRevision,
    implementationRevision: attestation.implementationRevision,
    manifestDigest: attestation.manifestDigest,
    installationDigest: attestation.installationDigest,
    capabilities: attestation.capabilities.map((capability) => ({
      id: capability.id,
      support: capability.support,
      requiresConfiguration: capability.requiresConfiguration,
      contractTest: capability.contractTest,
      fallback: capability.fallback,
      unavailableReasonCode: capability.unavailableReasonCode,
      installedVersionCompatible: capability.installedVersionCompatible,
      configurationAvailable: capability.configurationAvailable,
      observedAvailable: capability.observedAvailable,
      currentlyAvailable: capability.currentlyAvailable,
    })),
  };
}

function digestAttestation(
  attestation: Omit<ProviderCapabilityAttestation, "attestationDigest">,
): string {
  return createHash("sha256")
    .update("inertia.provider-capability-attestation.v1\0", "utf8")
    .update(JSON.stringify(canonicalAttestationPayload(attestation)), "utf8")
    .digest("hex");
}

export function attestProviderCapabilities(
  manifest: ProviderCapabilityManifest,
  input: ProviderCapabilityAttestationInput,
): ProviderCapabilityAttestation {
  const trusted = trustedManifest(manifest);
  if (!trusted) {
    throw new Error("The provider capability manifest is invalid.");
  }
  const validated = validatedAttestationInput(input, trusted);
  if (!validated) {
    throw new Error("The provider capability attestation input is invalid.");
  }
  const versionCompatible = validated.protocolVerified
    && validated.installationVersion !== null
    && validated.protocolVerifiedInstallationVersion
      === validated.installationVersion;
  const capabilities = Object.freeze(trusted.capabilities.map((declaration) => {
    const configurationAvailable = !declaration.requiresConfiguration
      || validated.observation.configured.has(declaration.id);
    const declaredObservationAvailable = declaration.support === "negotiated"
      ? validated.observation.negotiated[declaration.id] === true
      : declaration.support !== "unavailable";
    const observedAvailable = declaredObservationAvailable
      && (
        validated.observation.observed === null
        || validated.observation.observed.has(declaration.id)
      );
    return Object.freeze({
      ...declaration,
      installedVersionCompatible: versionCompatible,
      configurationAvailable,
      observedAvailable,
      currentlyAvailable: versionCompatible
        && configurationAvailable
        && observedAvailable,
      unavailableReasonCode: unavailableReason(
        declaration,
        versionCompatible,
        configurationAvailable,
        observedAvailable,
      ),
    });
  }));
  const installationDigest = createHash("sha256")
    .update("inertia.provider-installation-attestation.v1\0", "utf8")
    .update(JSON.stringify([
      trusted.providerId,
      trusted.harnessId,
      validated.installationIdentity,
      validated.installationVersion,
      validated.backendConfigurationRevision,
      trusted.protocolRevision,
      trusted.implementationRevision,
      trusted.digest,
    ]), "utf8")
    .digest("hex");
  const unsignedAttestation = {
    schemaVersion: 1,
    providerId: trusted.providerId,
    harnessId: trusted.harnessId,
    installationVersion: validated.installationVersion,
    backendConfigurationRevision: validated.backendConfigurationRevision,
    protocolRevision: trusted.protocolRevision,
    implementationRevision: trusted.implementationRevision,
    manifestDigest: trusted.digest,
    installationDigest,
    capabilities,
  } as const;
  return Object.freeze({
    ...unsignedAttestation,
    attestationDigest: digestAttestation(unsignedAttestation),
  });
}

function attestationCapabilityMatches(
  value: unknown,
  declaration: ProviderCapabilityDeclaration,
  installedVersionCompatible: boolean,
): value is AttestedProviderCapability {
  if (
    !plainRecord(value)
    || !exactObjectKeys(value, ATTESTED_CAPABILITY_KEYS)
    || value.id !== declaration.id
    || value.support !== declaration.support
    || value.requiresConfiguration !== declaration.requiresConfiguration
    || value.contractTest !== declaration.contractTest
    || value.fallback !== declaration.fallback
    || !REASON_CODES.has(
      value.unavailableReasonCode as
        ProviderCapabilityDeclaration["unavailableReasonCode"],
    )
    || value.installedVersionCompatible !== installedVersionCompatible
    || typeof value.configurationAvailable !== "boolean"
    || typeof value.observedAvailable !== "boolean"
    || typeof value.currentlyAvailable !== "boolean"
    || (!declaration.requiresConfiguration && !value.configurationAvailable)
    || value.currentlyAvailable !== (
      installedVersionCompatible
      && value.configurationAvailable
      && value.observedAvailable
    )
    || (declaration.support === "unavailable"
      && (value.observedAvailable || value.currentlyAvailable))
  ) return false;
  return value.unavailableReasonCode === unavailableReason(
    declaration,
    installedVersionCompatible,
    value.configurationAvailable,
    value.observedAvailable,
  );
}

function trustedAttestation(value: unknown): ProviderCapabilityAttestation | null {
  if (
    !plainRecord(value)
    || !exactObjectKeys(value, ATTESTATION_KEYS)
    || value.schemaVersion !== 1
    || !PROVIDER_IDS.has(value.providerId as ProviderId)
    || typeof value.harnessId !== "string"
    || !(
      value.installationVersion === null
      || boundedControlFreeText(
        value.installationVersion,
        MAX_INSTALLATION_VERSION_CHARS,
      )
    )
    || !safeConfigurationRevision(value.backendConfigurationRevision)
    || typeof value.protocolRevision !== "string"
    || !Number.isSafeInteger(value.implementationRevision)
    || typeof value.manifestDigest !== "string"
    || typeof value.installationDigest !== "string"
    || typeof value.attestationDigest !== "string"
    || !DIGEST_PATTERN.test(value.installationDigest)
    || !DIGEST_PATTERN.test(value.attestationDigest)
    || !Array.isArray(value.capabilities)
    || value.capabilities.length !== PROVIDER_CAPABILITY_IDS.length
  ) return null;
  const manifest = MANIFEST_BY_HARNESS.get(
    value.harnessId as ProductionHarnessId,
  );
  if (
    !manifest
    || value.providerId !== manifest.providerId
    || value.protocolRevision !== manifest.protocolRevision
    || value.implementationRevision !== manifest.implementationRevision
    || value.manifestDigest !== manifest.digest
  ) return null;
  const installedVersionCompatible = value.capabilities[0]
    && plainRecord(value.capabilities[0])
    && typeof value.capabilities[0].installedVersionCompatible === "boolean"
    ? value.capabilities[0].installedVersionCompatible
    : null;
  if (
    installedVersionCompatible === null
    || (value.installationVersion === null && installedVersionCompatible)
  ) return null;
  if (!value.capabilities.every((capability, index) =>
    attestationCapabilityMatches(
      capability,
      manifest.capabilities[index]!,
      installedVersionCompatible,
  ))) return null;
  const candidate = value as unknown as ProviderCapabilityAttestation;
  const { attestationDigest } = candidate;
  return digestAttestation(candidate) === attestationDigest
    ? candidate
    : null;
}

export function attestedProviderCapability(
  attestation: ProviderCapabilityAttestation,
  id: ProviderCapabilityId,
): AttestedProviderCapability {
  const trusted = trustedAttestation(attestation);
  if (!trusted || !CAPABILITY_IDS.has(id)) {
    throw new Error("The provider capability attestation is invalid.");
  }
  const capability = trusted.capabilities.find((entry) => entry.id === id);
  if (!capability) {
    throw new Error("The provider capability attestation is incomplete.");
  }
  return Object.isFrozen(capability)
    ? capability
    : Object.freeze({ ...capability });
}

/**
 * Opaque continuation identity for one exact verified installation and
 * capability boundary. Per-session negotiations are not supplied when this
 * token is minted, while custom-backend probe observations are, so losing a
 * probed capability forces a fresh provider session.
 */
export function providerContinuationCompatibilityToken(
  attestation: ProviderCapabilityAttestation,
): string | null {
  let trusted: ProviderCapabilityAttestation | null = null;
  try {
    trusted = trustedAttestation(attestation);
  } catch {
    return null;
  }
  return trusted
    && trusted.installationVersion !== null
    && trusted.capabilities.every(({ installedVersionCompatible }) =>
      installedVersionCompatible)
    ? trusted.attestationDigest
    : null;
}
