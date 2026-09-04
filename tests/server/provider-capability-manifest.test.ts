// @inertia-test-suite portable

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  attestProviderCapabilities,
  attestedProviderCapability,
  productionProviderCapabilityManifests,
  PROVIDER_CAPABILITY_IDS,
  providerCapabilityManifest,
  providerContinuationCompatibilityToken,
  type ProviderCapabilityAttestationInput,
  type ProviderCapabilityId,
  type ProviderCapabilityManifest,
} from "../../src/server/provider/capability-manifest";

const productionMappings = [
  ["codex", "codex-app-server"],
  ["claude", "claude-agent-sdk"],
  ["cursor", "cursor-acp"],
  ["gemini", "gemini-acp"],
  ["kimi", "kimi-acp"],
  ["opencode", "opencode-sdk"],
] as const;

function manifest(harnessId: (typeof productionMappings)[number][1]) {
  const value = providerCapabilityManifest(harnessId);
  expect(value).not.toBeNull();
  return value!;
}

function capability(
  value: ProviderCapabilityManifest,
  id: ProviderCapabilityId,
) {
  const declaration = value.capabilities.find((entry) => entry.id === id);
  expect(declaration, `${value.harnessId}:${id}`).toBeDefined();
  return declaration!;
}

function input(
  overrides: Record<string, unknown> = {},
): ProviderCapabilityAttestationInput {
  return {
    installationIdentity: "/home/alice/.local/bin/codex#2049:91",
    installationVersion: "1.2.3",
    protocolVerifiedInstallationVersion: "1.2.3",
    backendConfigurationRevision: 7,
    protocolVerified: true,
    ...overrides,
  } as ProviderCapabilityAttestationInput;
}

function canonicalManifestDigest(value: ProviderCapabilityManifest): string {
  const unsigned = {
    schemaVersion: value.schemaVersion,
    providerId: value.providerId,
    harnessId: value.harnessId,
    implementationRevision: value.implementationRevision,
    protocolRevision: value.protocolRevision,
    bundledSdkVersion: value.bundledSdkVersion,
    installationVersionSource: value.installationVersionSource,
    capabilities: value.capabilities.map((entry) => ({
      id: entry.id,
      support: entry.support,
      requiresConfiguration: entry.requiresConfiguration,
      contractTest: entry.contractTest,
      fallback: entry.fallback,
      unavailableReasonCode: entry.unavailableReasonCode,
    })),
  };
  return createHash("sha256")
    .update("inertia.provider-capability-manifest.v1\0", "utf8")
    .update(JSON.stringify(unsigned), "utf8")
    .digest("hex");
}

describe("provider capability manifests", () => {
  it("publishes exactly six complete canonical provider-harness mappings", () => {
    const manifests = productionProviderCapabilityManifests();
    expect(manifests.map(({ providerId, harnessId }) =>
      [providerId, harnessId])).toEqual(productionMappings);
    expect(new Set(manifests.map(({ providerId }) => providerId)).size).toBe(6);
    expect(new Set(manifests.map(({ harnessId }) => harnessId)).size).toBe(6);

    for (const value of manifests) {
      expect(value.schemaVersion).toBe(1);
      expect(value.implementationRevision).toBeGreaterThan(0);
      expect(value.installationVersionSource).toBe("provider-executable");
      expect(value.capabilities.map(({ id }) => id))
        .toEqual(PROVIDER_CAPABILITY_IDS);
      expect(new Set(value.capabilities.map(({ id }) => id)).size)
        .toBe(PROVIDER_CAPABILITY_IDS.length);
      expect(value.digest).toBe(canonicalManifestDigest(value));
      expect(value.digest).toMatch(/^[0-9a-f]{64}$/u);
      for (const declaration of value.capabilities) {
        expect(existsSync(join(process.cwd(), declaration.contractTest))).toBe(true);
      }
    }

    expect(providerCapabilityManifest("codex-cli")).toBeNull();
    expect(providerCapabilityManifest("claude-cli")).toBeNull();
    expect(providerCapabilityManifest("cursor-cli")).toBeNull();
    expect(providerCapabilityManifest("opencode-cli")).toBeNull();
    expect(providerCapabilityManifest("unknown" as never)).toBeNull();
    expect(providerCapabilityManifest(null as never)).toBeNull();
  });

  it("keeps the SDK protocol identities aligned with exact package pins", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest("codex-app-server").bundledSdkVersion).toBeNull();
    expect(manifest("claude-agent-sdk").bundledSdkVersion)
      .toBe(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"]);
    expect(manifest("cursor-acp").bundledSdkVersion)
      .toBe(packageJson.dependencies["@agentclientprotocol/sdk"]);
    expect(manifest("gemini-acp").bundledSdkVersion)
      .toBe(packageJson.dependencies["@agentclientprotocol/sdk"]);
    expect(manifest("kimi-acp").bundledSdkVersion)
      .toBe(packageJson.dependencies["@agentclientprotocol/sdk"]);
    expect(manifest("opencode-sdk").bundledSdkVersion)
      .toBe(packageJson.dependencies["@opencode-ai/sdk"]);
  });

  it("deep-freezes canonical manifests and generated attestations", () => {
    const manifests = productionProviderCapabilityManifests();
    const codex = manifest("codex-app-server");
    expect(Object.isFrozen(manifests)).toBe(true);
    expect(Object.isFrozen(codex)).toBe(true);
    expect(Object.isFrozen(codex.capabilities)).toBe(true);
    expect(codex.capabilities.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(codex, "providerId", "kimi")).toBe(false);
    expect(Reflect.set(codex.capabilities[0]!, "support", "unavailable"))
      .toBe(false);

    const attestation = attestProviderCapabilities(codex, input());
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(Object.isFrozen(attestation.capabilities)).toBe(true);
    expect(attestation.capabilities.every(Object.isFrozen)).toBe(true);
    expect(Reflect.set(attestation, "backendConfigurationRevision", 8))
      .toBe(false);
  });

  it("records only source-backed native and negotiated capability claims", () => {
    const codex = manifest("codex-app-server");
    expect(capability(codex, "images").support).toBe("native");
    expect(capability(codex, "goals").support).toBe("native");
    expect(capability(codex, "subagent-create").support).toBe("native");
    expect(capability(codex, "subagent-stop").support).toBe("unavailable");
    expect(capability(codex, "provider-owned-server").support)
      .toBe("unavailable");
    expect(capability(codex, "custom-backend").support).toBe("negotiated");
    expect(capability(codex, "endpoint-selection").support).toBe("negotiated");

    const claude = manifest("claude-agent-sdk");
    expect(capability(claude, "images").support).toBe("native");
    expect(capability(claude, "subagent-create").support).toBe("native");
    expect(capability(claude, "subagent-stop").support).toBe("native");
    expect(capability(claude, "custom-backend").support).toBe("negotiated");

    const cursor = manifest("cursor-acp");
    for (const id of [
      "images",
      "structured-input",
      "compaction",
      "usage-tokens",
      "model-discovery",
    ] as const) expect(capability(cursor, id).support).toBe("negotiated");
    expect(capability(cursor, "follow-up-steer").support).toBe("unavailable");

    const gemini = manifest("gemini-acp");
    for (const id of [
      "images",
      "plans",
      "usage-tokens",
      "model-discovery",
      "maintenance-update",
    ] as const) expect(capability(gemini, id).support).toBe("negotiated");
    expect(capability(gemini, "provider-native-tools").support).toBe("native");
    expect(capability(gemini, "host-tool-bridge").support)
      .toBe("host-exact-turn");
    expect(capability(gemini, "session-resume").support).toBe("unavailable");
    expect(capability(gemini, "native-session-id").support).toBe("unavailable");

    const kimi = manifest("kimi-acp");
    expect(capability(kimi, "structured-input").support).toBe("native");
    expect(capability(kimi, "images").support).toBe("negotiated");
    expect(capability(kimi, "compaction").support).toBe("negotiated");
    expect(capability(kimi, "model-discovery").support).toBe("negotiated");
    expect(capability(kimi, "maintenance-update").support)
      .toBe("unavailable");

    const openCode = manifest("opencode-sdk");
    expect(capability(openCode, "images").support).toBe("negotiated");
    expect(capability(openCode, "provider-owned-server").support).toBe("native");
    expect(capability(openCode, "subagent-create").support).toBe("unavailable");
    expect(capability(openCode, "custom-backend").support).toBe("unavailable");
    expect(capability(openCode, "endpoint-selection").support)
      .toBe("unavailable");
  });

  it("distinguishes native, configured, negotiated, and unavailable states", () => {
    const codex = manifest("codex-app-server");
    const baseline = attestProviderCapabilities(codex, input());
    expect(attestedProviderCapability(baseline, "text-streaming"))
      .toMatchObject({
        support: "native",
        installedVersionCompatible: true,
        configurationAvailable: true,
        observedAvailable: true,
        currentlyAvailable: true,
      });
    expect(attestedProviderCapability(baseline, "host-tool-bridge"))
      .toMatchObject({
        support: "host-exact-turn",
        requiresConfiguration: true,
        configurationAvailable: false,
        currentlyAvailable: false,
        unavailableReasonCode: "configuration-required",
      });
    expect(attestedProviderCapability(baseline, "custom-backend"))
      .toMatchObject({
        support: "negotiated",
        requiresConfiguration: true,
        configurationAvailable: false,
        currentlyAvailable: false,
        unavailableReasonCode: "configuration-required",
      });
    expect(attestedProviderCapability(baseline, "rate-limits"))
      .toMatchObject({
        support: "negotiated",
        configurationAvailable: true,
        observedAvailable: false,
        currentlyAvailable: false,
        unavailableReasonCode: "negotiation-required",
      });
    expect(attestedProviderCapability(baseline, "subagent-stop"))
      .toMatchObject({
        support: "unavailable",
        configurationAvailable: true,
        observedAvailable: false,
        currentlyAvailable: false,
        unavailableReasonCode: "unsupported-operation",
      });

    const configuredOnly = attestProviderCapabilities(codex, input({
      observation: { configured: ["custom-backend"] },
    }));
    expect(attestedProviderCapability(configuredOnly, "custom-backend"))
      .toMatchObject({
        configurationAvailable: true,
        observedAvailable: false,
        currentlyAvailable: false,
        unavailableReasonCode: "negotiation-required",
      });

    const available = attestProviderCapabilities(codex, input({
      observation: {
        configured: [
          "host-tool-bridge",
          "custom-backend",
          "endpoint-selection",
        ],
        negotiated: {
          "custom-backend": true,
          "endpoint-selection": true,
          "rate-limits": true,
        },
      },
    }));
    expect(attestedProviderCapability(available, "host-tool-bridge"))
      .toMatchObject({
        configurationAvailable: true,
        currentlyAvailable: true,
      });
    expect(attestedProviderCapability(available, "custom-backend"))
      .toMatchObject({
        configurationAvailable: true,
        observedAvailable: true,
        currentlyAvailable: true,
      });
    expect(attestedProviderCapability(available, "rate-limits"))
      .toMatchObject({ observedAvailable: true, currentlyAvailable: true });

    const explicitlyUnavailable = attestProviderCapabilities(codex, input({
      observation: { negotiated: { "rate-limits": false } },
    }));
    expect(attestedProviderCapability(explicitlyUnavailable, "rate-limits")
      .currentlyAvailable).toBe(false);
  });

  it("uses an explicit observation ceiling for partially exercised routes", () => {
    const codex = manifest("codex-app-server");
    const observed = attestProviderCapabilities(codex, input({
      observation: {
        configured: [
          "host-tool-bridge",
          "custom-backend",
          "endpoint-selection",
        ],
        negotiated: {
          "custom-backend": true,
          "endpoint-selection": true,
        },
        observed: [
          "text-streaming",
          "usage-tokens",
          "custom-backend",
          "endpoint-selection",
          "cancellation",
          "process-cleanup",
          "native-session-id",
        ],
      },
    }));

    for (const id of [
      "text-streaming",
      "usage-tokens",
      "custom-backend",
      "endpoint-selection",
      "cancellation",
      "process-cleanup",
      "native-session-id",
    ] as const) {
      expect(attestedProviderCapability(observed, id).currentlyAvailable)
        .toBe(true);
    }
    for (const id of [
      "images",
      "goals",
      "plans",
      "approvals",
      "compaction",
      "host-tool-bridge",
    ] as const) {
      expect(attestedProviderCapability(observed, id)).toMatchObject({
        observedAvailable: false,
        currentlyAvailable: false,
      });
    }
  });

  it("closes every capability when protocol or installation version is unverified", () => {
    const codex = manifest("codex-app-server");
    for (const unavailableInput of [
      input({ protocolVerified: false }),
      input({ installationVersion: null }),
      input({ protocolVerifiedInstallationVersion: null }),
      input({ protocolVerifiedInstallationVersion: "1.2.4" }),
    ]) {
      const result = attestProviderCapabilities(codex, unavailableInput);
      expect(result.capabilities.every((entry) =>
        !entry.installedVersionCompatible && !entry.currentlyAvailable))
        .toBe(true);
      expect(result.capabilities.every((entry) =>
        entry.unavailableReasonCode === "installation-unverified"))
        .toBe(true);
    }
  });

  it("rejects malformed, unbounded, or control-bearing public inputs", () => {
    const codex = manifest("codex-app-server");
    const invalidInputs: readonly Record<string, unknown>[] = [
      { installationIdentity: "" },
      { installationIdentity: " identity" },
      { installationIdentity: `identity\nsecret` },
      { installationIdentity: "x".repeat(2_049) },
      { installationIdentity: 42 },
      { installationVersion: "" },
      { installationVersion: " version" },
      { installationVersion: "1.2.3\u001b[31m" },
      { installationVersion: "v".repeat(201) },
      { installationVersion: 123 },
      { backendConfigurationRevision: -1 },
      { backendConfigurationRevision: 1.5 },
      { backendConfigurationRevision: Number.MAX_SAFE_INTEGER + 1 },
      { protocolVerified: "yes" },
      { unexpected: "field" },
      { observation: { configured: ["unknown-capability"] } },
      { observation: { configured: ["text-streaming"] } },
      { observation: { configured: ["custom-backend", "custom-backend"] } },
      { observation: { negotiated: { unknown: true } } },
      { observation: { negotiated: { "text-streaming": true } } },
      { observation: { negotiated: { "rate-limits": "yes" } } },
      { observation: { configured: "custom-backend" } },
      { observation: { observed: "text-streaming" } },
      { observation: { observed: ["unknown-capability"] } },
      { observation: { observed: ["text-streaming", "text-streaming"] } },
      { observation: { observed: ["subagent-stop"] } },
      { observation: { extra: true } },
    ];
    for (const overrides of invalidInputs) {
      expect(() => attestProviderCapabilities(codex, input(overrides)),
        JSON.stringify(overrides)).toThrow(
        "provider capability attestation input is invalid",
      );
    }
    expect(() => attestProviderCapabilities(codex, null as never))
      .toThrow("provider capability attestation input is invalid");
  });

  it("accepts only complete canonical manifests at the attestation boundary", () => {
    const codex = manifest("codex-app-server");
    expect(attestProviderCapabilities(structuredClone(codex), input()))
      .toMatchObject({ providerId: "codex", harnessId: "codex-app-server" });

    const mutations: readonly ((value: Record<string, unknown>) => void)[] = [
      (value) => { value.digest = "f".repeat(64); },
      (value) => { value.extra = true; },
      (value) => { value.providerId = "kimi"; },
      (value) => { value.protocolRevision = "forged"; },
      (value) => {
        (value.capabilities as unknown[]).pop();
      },
      (value) => {
        const capabilities = value.capabilities as unknown[];
        [capabilities[0], capabilities[1]] = [capabilities[1], capabilities[0]];
      },
      (value) => {
        const first = (value.capabilities as Record<string, unknown>[])[0]!;
        first.support = "unavailable";
      },
      (value) => {
        const first = (value.capabilities as Record<string, unknown>[])[0]!;
        first.extra = true;
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(codex) as unknown as Record<string, unknown>;
      mutate(candidate);
      expect(() => attestProviderCapabilities(
        candidate as unknown as ProviderCapabilityManifest,
        input(),
      )).toThrow("provider capability manifest is invalid");
    }
  });

  it("hashes installation identity without returning or echoing the raw value", () => {
    const codex = manifest("codex-app-server");
    const rawIdentity = "/Users/alice/Private Provider/codex.exe#credential-looking-name";
    const first = attestProviderCapabilities(codex, input({
      installationIdentity: rawIdentity,
    }));
    const duplicate = attestProviderCapabilities(codex, input({
      installationIdentity: rawIdentity,
    }));
    const changedIdentity = attestProviderCapabilities(codex, input({
      installationIdentity: `${rawIdentity}-replacement`,
    }));
    const changedVersion = attestProviderCapabilities(codex, input({
      installationIdentity: rawIdentity,
      installationVersion: "1.2.4",
    }));
    const changedConfiguration = attestProviderCapabilities(codex, input({
      installationIdentity: rawIdentity,
      backendConfigurationRevision: 8,
    }));

    expect(first.installationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.attestationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(duplicate.installationDigest).toBe(first.installationDigest);
    expect(changedIdentity.installationDigest).not.toBe(first.installationDigest);
    expect(changedVersion.installationDigest).not.toBe(first.installationDigest);
    expect(changedConfiguration.installationDigest)
      .not.toBe(first.installationDigest);
    expect(JSON.stringify(first)).not.toContain(rawIdentity);

    const rejectedIdentity = "raw-identity\nthat-must-not-leak";
    try {
      attestProviderCapabilities(codex, input({
        installationIdentity: rejectedIdentity,
      }));
      throw new Error("expected invalid identity rejection");
    } catch (error) {
      expect(String(error)).not.toContain(rejectedIdentity);
    }
  });

  it("validates accessor inputs instead of trusting mutable attestations", () => {
    const result = attestProviderCapabilities(
      manifest("codex-app-server"),
      input(),
    );
    expect(attestedProviderCapability(result, "text-streaming").id)
      .toBe("text-streaming");
    expect(() => attestedProviderCapability(result, "unknown" as never))
      .toThrow("provider capability attestation is invalid");

    const tampered = structuredClone(result) as unknown as Record<string, unknown>;
    const entries = tampered.capabilities as Record<string, unknown>[];
    entries[0]!.currentlyAvailable = false;
    expect(() => attestedProviderCapability(
      tampered as unknown as typeof result,
      "text-streaming",
    )).toThrow("provider capability attestation is invalid");

    const extra = structuredClone(result) as unknown as Record<string, unknown>;
    extra.installationIdentity = "must-not-be-accepted";
    expect(() => attestedProviderCapability(
      extra as unknown as typeof result,
      "text-streaming",
    )).toThrow("provider capability attestation is invalid");
  });

  it("returns a continuation token only for an intact, verified boundary", () => {
    const codex = manifest("codex-app-server");
    const verified = attestProviderCapabilities(codex, input());
    expect(providerContinuationCompatibilityToken(verified))
      .toBe(verified.attestationDigest);
    expect(providerContinuationCompatibilityToken(structuredClone(verified)))
      .toBe(verified.attestationDigest);

    const textOnly = attestProviderCapabilities(codex, input({
      observation: { observed: ["text-streaming"] },
    }));
    const textAndUsage = attestProviderCapabilities(codex, input({
      observation: { observed: ["text-streaming", "usage-tokens"] },
    }));
    expect(textOnly.installationDigest).toBe(textAndUsage.installationDigest);
    expect(providerContinuationCompatibilityToken(textOnly))
      .not.toBe(providerContinuationCompatibilityToken(textAndUsage));

    expect(providerContinuationCompatibilityToken(
      attestProviderCapabilities(codex, input({ protocolVerified: false })),
    )).toBeNull();
    expect(providerContinuationCompatibilityToken(
      attestProviderCapabilities(codex, input({ installationVersion: null })),
    )).toBeNull();

    const tamperedValues: Record<string, unknown>[] = [];
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.installationDigest = "f".repeat(64);
      },
      (value: Record<string, unknown>) => {
        value.installationVersion = "9.9.9";
      },
      (value: Record<string, unknown>) => {
        value.attestationDigest = "0".repeat(64);
      },
      (value: Record<string, unknown>) => {
        const entries = value.capabilities as Record<string, unknown>[];
        entries[0]!.currentlyAvailable = false;
      },
      (value: Record<string, unknown>) => {
        value.extra = true;
      },
    ]) {
      const candidate = structuredClone(verified) as unknown as Record<string, unknown>;
      mutate(candidate);
      tamperedValues.push(candidate);
    }
    for (const candidate of tamperedValues) {
      expect(providerContinuationCompatibilityToken(
        candidate as unknown as typeof verified,
      )).toBeNull();
    }
    expect(providerContinuationCompatibilityToken(null as never)).toBeNull();
  });
});
