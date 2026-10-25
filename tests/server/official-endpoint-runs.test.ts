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
