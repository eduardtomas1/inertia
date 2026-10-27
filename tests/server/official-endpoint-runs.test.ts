import { describe, expect, it, vi } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  createDefaultAgentHarnessRegistry,
  type AgentHarness,
  type ProviderBackendLaunchOptions,
  type ProviderRunInput,
  type ProviderRunResult,
} from "../../src/server/providers";
import { providerRunTerminal } from "../../src/server/provider/contracts";
import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { providerCapabilityManifest } from "../../src/server/provider/capability-manifest";
import { officialEndpointObservedCapabilities } from "../../src/server/provider/runtime-capability-attestation";
import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import { backendCompatibilityProbeResultSchema } from "../../src/shared/backend-probe";
import {
  MODEL_CAPABILITY_IDS,
  modelSelectionSchema,
  type KnownHarnessId,
  type ModelBackendProfile,
} from "../../src/shared/model-routing";
import { backendProbeTestAuthority } from "../helpers/backend-probe-authority";
import { nativeProviderRunInput } from "./model-route-fixture";

const CHECKED_AT = "2031-05-01T08:00:00.000Z";
const PROBE_OBSERVED_CAPABILITIES: ReadonlySet<string> = new Set(["streaming", "tools", "usage"]);

interface RouteCase {
  label: string;
  providerId: "claude" | "codex";
  harnessId: Extract<KnownHarnessId, "claude-agent-sdk" | "codex-app-server">;
  profile: ModelBackendProfile;
  modelId: string;
  expectedState: "verified" | "partially-compatible";
}

const CASES: readonly RouteCase[] = [
  {
    label: "the Anthropic API key preset",
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    profile: {
      id: "custom:anthropic-key",
      displayName: "Anthropic API key",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 1,
      endpointIdentity: backendEndpointIdentity("https://api.anthropic.com"),
    },
    modelId: "claude-opus-5-5",
    expectedState: "verified",
  },
  {
    label: "the OpenAI API key preset",
    providerId: "codex",
    harnessId: "codex-app-server",
    profile: {
      id: "custom:openai-key",
      displayName: "OpenAI API key",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      source: "custom",
      enabled: true,
      configurationRevision: 1,
      endpointIdentity: backendEndpointIdentity("https://api.openai.com/v1"),
    },
    modelId: "gpt-6.1-sol",
    expectedState: "verified",
  },
  {
    label: "a custom profile at the official Anthropic address",
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    profile: {
      id: "custom:anthropic-direct",
      displayName: "Direct Anthropic",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 3,
      endpointIdentity: backendEndpointIdentity("https://api.anthropic.com"),
    },
    modelId: "claude-sonnet-5-5",
    expectedState: "verified",
  },
  {
    label: "a custom gateway",
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    profile: {
      id: "custom:gateway",
      displayName: "Gateway",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 2,
      endpointIdentity: backendEndpointIdentity("https://gateway.example.test"),
    },
    modelId: "gateway-model",
    expectedState: "partially-compatible",
  },
];

function probeFor(route: RouteCase, installationFingerprint: string | null) {
  return backendCompatibilityProbeResultSchema.parse({
    profileId: route.profile.id,
    backendConfigurationRevision: route.profile.configurationRevision,
    endpointIdentity: route.profile.endpointIdentity,
    protocol: route.profile.protocol,
    modelId: route.modelId,
    compatibility: "protocol-compatible",
    protocolVerified: true,
    modelVerified: true,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => {
      const observed = PROBE_OBSERVED_CAPABILITIES.has(id);
      return {
        id,
        state: observed ? "verified" : "unknown",
        provenance: observed ? "probe" : "unknown",
        detail: null,
        checkedAt: CHECKED_AT,
      };
    }),
    contextWindow: {
      tokens: 200_000,
      state: "verified",
      provenance: "probe",
      detail: null,
      checkedAt: CHECKED_AT,
    },
    failure: null,
    checkedAt: CHECKED_AT,
    authority: backendProbeTestAuthority(CHECKED_AT, 1, installationFingerprint),
  });
}

function managerFor(route: RouteCase) {
  const production = createDefaultAgentHarnessRegistry().list()
    .find(({ id }) => id === route.harnessId)!;
  const starts: Parameters<AgentHarness["start"]>[0][] = [];
  let resolveRun!: (result: ProviderRunResult) => void;
  const harness: AgentHarness = {
    id: route.harnessId,
    providerId: route.providerId,
    capabilities: production.capabilities,
    supports: () => true,
    start: (options) => {
      starts.push(options);
      return {
        harnessId: route.harnessId,
        providerId: route.providerId,
        result: new Promise<ProviderRunResult>((resolve) => {
          resolveRun = resolve;
        }),
        cancel: () => undefined,
        extension: route.harnessId === "codex-app-server"
          ? {
              kind: "codex-app-server",
              respondToApproval: () => false,
              respondToInput: () => false,
              steer: async () => false,
              setGoal: async () => {
                throw new Error("Goals are not exercised here.");
              },
              clearGoal: async () => false,
            }
          : {
              kind: "claude-agent-sdk",
              respondToApproval: () => false,
              respondToInput: () => false,
              steer: async () => false,
            },
      };
    },
  };
  const launches: ProviderRunInput[] = [];
  const resolveBackendLaunchOptions = vi.fn((
    input: ProviderRunInput,
    environment: NodeJS.ProcessEnv,
  ): ProviderBackendLaunchOptions => {
    launches.push(input);
    return { environment: { ...environment } };
  });
  const manager = ProviderManager.createForTests({
    cancelGraceMs: 30_000,
    commands: { [route.providerId]: `/tools/${route.providerId}` },
    installationLeases: new ProviderInstallationLeaseCoordinator(),
    detectProvider: async () => ({
      provider: { id: route.providerId, name: route.providerId, command: route.providerId },
      available: true,
      version: "1.0.0",
      executable: `/tools/${route.providerId}`,
      installState: "installed" as const,
      authState: "unauthenticated" as const,
      canRun: false,
      protocolVerified: true,
      cleanupConfirmed: true,
    }),
    backendProfiles: [route.profile],
    backendProbeNow: () => new Date(CHECKED_AT),
    resolveBackendLaunchOptions,
  }, new AgentHarnessRegistry([harness]));
  return { manager, starts, launches, finish: (result: ProviderRunResult) => resolveRun(result) };
}

describe("custom key routes through the real capability authority", () => {
  it.each(CASES)("launches $label", async (route) => {
    const { manager, starts, launches, finish } = managerFor(route);
    await manager.detect(route.providerId);
    manager.recordBackendProbeResult(
      probeFor(route, manager.providerInstallationFingerprint(route.providerId)),
    );
    const modelSelection = modelSelectionSchema.parse({
      harnessId: route.harnessId,
      backendProfileId: route.profile.id,
      backendProfileDisplayName: route.profile.displayName,
      modelId: route.modelId,
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: route.profile.configurationRevision,
    });
    const resolved = manager.resolveModelRoute(modelSelection);
    expect(resolved.compatibility).toMatchObject({ state: route.expectedState, provenance: "probe" });
    const input: ProviderRunInput = {
      ...nativeProviderRunInput({
        providerId: route.providerId,
        harnessId: route.harnessId,
        conversationId: `conversation-${route.profile.id}`,
        cwd: "/workspace",
        prompt: "Reply with OK.",
        interactionMode: "build",
        access: "supervised",
      }),
      backendProfile: resolved.backendProfile,
      backendCompatibility: resolved.compatibility,
      modelSelection,
      continuationIdentity: resolved.continuationIdentity,
      model: route.modelId,
    };
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);

    const running = manager.run(input);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(launches).toHaveLength(1);
    expect(launches[0]?.backendProfile.id).toBe(route.profile.id);
    finish({
      ...providerRunTerminal(input, "completed"),
      text: "OK",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await expect(running).resolves.toMatchObject({ terminalReason: { outcome: "completed" } });
  });
});

const OFFICIAL_CASES = CASES.filter(({ expectedState }) => expectedState === "verified");
const GATEWAY_CASE = CASES.find(({ expectedState }) => expectedState === "partially-compatible")!;

function selectionFor(route: RouteCase, reasoningEffort: string | null) {
  return modelSelectionSchema.parse({
    harnessId: route.harnessId,
    backendProfileId: route.profile.id,
    backendProfileDisplayName: route.profile.displayName,
    modelId: route.modelId,
    alias: null,
    reasoningEffort,
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: route.profile.configurationRevision,
  });
}

function runInputFor(
  manager: ReturnType<typeof managerFor>["manager"],
  route: RouteCase,
  overrides: Partial<ProviderRunInput> = {},
): ProviderRunInput {
  const modelSelection = selectionFor(route, "low");
  const resolved = manager.resolveModelRoute(modelSelection);
  return {
    ...nativeProviderRunInput({
      providerId: route.providerId,
      harnessId: route.harnessId,
      conversationId: `conversation-${route.profile.id}`,
      cwd: "/workspace",
      prompt: "ola",
      interactionMode: "build",
      access: "supervised",
    }),
    backendProfile: resolved.backendProfile,
    backendCompatibility: resolved.compatibility,
    modelSelection,
    continuationIdentity: resolved.continuationIdentity,
    model: route.modelId,
    reasoningEffort: "low",
    ...overrides,
  };
}

async function detectedManager(route: RouteCase, fingerprint?: string) {
  const fixture = managerFor(route);
  await fixture.manager.detect(route.providerId);
  fixture.manager.recordBackendProbeResult(probeFor(
    route,
    fingerprint ?? fixture.manager.providerInstallationFingerprint(route.providerId),
  ));
  return fixture;
}

describe("official API key routes keep the provider's own capabilities", () => {
  it.each(OFFICIAL_CASES)("starts a turn with a chosen reasoning level on $label", async (route) => {
    const { manager, starts, finish } = await detectedManager(route);
    const input = runInputFor(manager, route);
    expect(manager.providerCapabilityAdmissible(input, "reasoning")).toBe(true);

    const running = manager.run(input);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    finish({
      ...providerRunTerminal(input, "completed"),
      text: "Hola",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await expect(running).resolves.toMatchObject({ terminalReason: { outcome: "completed" } });
  });

  it.each(OFFICIAL_CASES)("admits plans, images, resume, compaction and native tools on $label", async (route) => {
    const { manager } = await detectedManager(route);
    const input = runInputFor(manager, route);
    for (const capability of [
      "plans",
      "images",
      "session-resume",
      "compaction",
      "provider-native-tools",
      "tool-activity",
      "approvals",
      "usage-tokens",
    ] as const) {
      expect(manager.providerCapabilityAdmissible(input, capability), capability).toBe(true);
    }
    for (const capability of [
      "rate-limits",
      "performance-modes",
      "model-discovery",
      "host-tool-bridge",
    ] as const) {
      expect(manager.providerCapabilityAvailable(input, capability, [capability]), capability).toBe(false);
    }
    expect(input.continuationIdentity?.providerCompatibilityToken).toEqual(expect.any(String));
  });

  it.each(OFFICIAL_CASES)("falls back to the probed baseline when the probe came from another installation on $label", async (route) => {
    const { manager } = await detectedManager(route, "f".repeat(64));
    const input = runInputFor(manager, route);
    expect(manager.providerCapabilityAdmissible(input, "reasoning")).toBe(false);
    expect(manager.providerCapabilityAdmissible(input, "session-resume")).toBe(false);
  });

  it("keeps a third-party gateway limited to what its probe verified", async () => {
    const { manager } = await detectedManager(GATEWAY_CASE);
    const input = runInputFor(manager, GATEWAY_CASE);
    expect(manager.providerCapabilityAdmissible(input, "text-streaming")).toBe(true);
    for (const capability of ["reasoning", "plans", "images", "session-resume"] as const) {
      expect(manager.providerCapabilityAdmissible(input, capability), capability).toBe(false);
    }
    expect(input.continuationIdentity?.providerCompatibilityToken ?? null).toBeNull();
  });
});

describe("official endpoint capability ceiling", () => {
  const streaming = [{
    id: "streaming" as const,
    state: "verified" as const,
    provenance: "probe" as const,
    detail: null,
    checkedAt: CHECKED_AT,
  }];

  it.each(["claude-agent-sdk", "codex-app-server"] as const)("grants %s its native capabilities except account features", (harnessId) => {
    const manifest = providerCapabilityManifest(harnessId)!;
    const observed = officialEndpointObservedCapabilities(manifest, streaming)!;
    expect(observed).toEqual(expect.arrayContaining(["reasoning", "plans", "images", "session-resume", "compaction"]));
    for (const excluded of [
      "rate-limits",
      "performance-modes",
      "model-discovery",
      "auth-state-discovery",
      "maintenance-update",
      "provider-owned-server",
      "host-tool-bridge",
    ] as const) {
      expect(observed).not.toContain(excluded);
    }
  });

  it("grants nothing extra until the probe verified streaming", () => {
    const manifest = providerCapabilityManifest("claude-agent-sdk")!;
    expect(officialEndpointObservedCapabilities(manifest, [])).toBeNull();
    expect(officialEndpointObservedCapabilities(manifest, [{ ...streaming[0]!, state: "unknown", provenance: "unknown" }])).toBeNull();
  });
});
