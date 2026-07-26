import { describe, expect, it, vi } from "vitest";

import {
  claudeHarnessBackendCompatibility,
  createKimiClaudeBackendProfile,
  modelBackendProfileForClaudeProfile,
  nativeAnthropicBackendProfile,
  type ClaudeCompatibleBackendProfile,
} from "../../src/shared/claude-backend-profiles";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
} from "../../src/shared/model-routing";
import type {
  AgentHarness,
  AgentHarnessStartOptions,
} from "../../src/server/provider/agent-harness";
import { AgentHarnessRegistry } from "../../src/server/provider/agent-harness-registry";
import { CLAUDE_AGENT_SDK_CAPABILITIES } from "../../src/server/provider/claude-agent-sdk-harness";
import type {
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  claudeBackendProfileRegistrations,
  createClaudeBackendLaunchResolver,
} from "../../src/server/runtime/backends/claude-compatible-adapter";
import { ProviderManager } from "../../src/server/providers";

const SECRET_REFERENCE = "secret:integration-kimi";
const SECRET_VALUE = "integration-secret-value";

function runInput(
  profile: ClaudeCompatibleBackendProfile,
  modelId = profile.primaryModelId,
  identity: {
    conversationId?: string;
    runId?: string;
    turnId?: string;
  } = {},
): ProviderRunInput {
  const backendProfile = modelBackendProfileForClaudeProfile(profile);
  const backendCompatibility = claudeHarnessBackendCompatibility(profile);
  const modelSelection = modelSelectionSchema.parse({
    harnessId: "claude-agent-sdk",
    backendProfileId: profile.id,
    backendProfileDisplayName: profile.displayName,
    modelId,
    alias: null,
    reasoningEffort: "high",
    contextWindowOverride: profile.contextWindowTokens,
    providerOptions: {},
    capabilities: profile.capabilityOverrides,
    backendConfigurationRevision: profile.configurationRevision,
  });
  return {
    providerId: "claude",
    harnessId: "claude-agent-sdk",
    backendProfile,
    backendCompatibility,
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(
      modelSelection,
      backendProfile.endpointIdentity,
      true,
    ),
    conversationId: identity.conversationId ?? "conversation-integration",
    runId: identity.runId ?? "run-integration",
    turnId: identity.turnId ?? "turn-integration",
    cwd: "/workspace",
    prompt: "Inspect this project",
    model: modelId,
    reasoningEffort: "high",
    interactionMode: "build",
    access: "supervised",
  };
}

function completedResult(input: ProviderRunInput): ProviderRunResult {
  return {
    providerId: "claude",
    conversationId: input.conversationId!,
    status: "completed",
    text: "Done",
    textTruncated: false,
    exitCode: 0,
    signal: null,
  };
}

function capturingHarness(
  capture: (options: AgentHarnessStartOptions) => void,
  result: (input: ProviderRunInput) => Promise<ProviderRunResult>,
): AgentHarness {
  return {
    id: "claude-agent-sdk",
    providerId: "claude",
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    supports: (input) => input.harnessId === "claude-agent-sdk",
    start: (options) => {
      capture(options);
      return {
        harnessId: "claude-agent-sdk",
        providerId: "claude",
        result: result(options.input),
        cancel: () => undefined,
        extension: {
          kind: "claude-agent-sdk",
          respondToApproval: () => false,
          respondToInput: () => false,
        },
      };
    },
  };
}

describe("Claude backend launch integration", () => {
  it("gives the harness a credential copy and scrubs the resolver-owned object immediately", async () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:integration",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3-256k",
    });
    const registrations = claudeBackendProfileRegistrations([profile]);
    const privilegedResolver = createClaudeBackendLaunchResolver({
      profiles: [profile],
      resolveSecret: async (reference) =>
        reference === SECRET_REFERENCE ? SECRET_VALUE : null,
    });
    const captured: {
      resolverEnvironment?: NodeJS.ProcessEnv;
      harnessEnvironment?: NodeJS.ProcessEnv;
      harnessModel?: string;
    } = {};
    const harness = capturingHarness(
      (options) => {
        captured.harnessEnvironment = options.environment;
        captured.harnessModel = options.input.model;
        expect(options.environment.ANTHROPIC_API_KEY).toBe(SECRET_VALUE);
      },
      async (input) => completedResult(input),
    );
    const manager = new ProviderManager({
      ...registrations,
      resolveBackendLaunchOptions: async (input, environment, context) => {
        const resolved = await privilegedResolver(input, environment, context);
        captured.resolverEnvironment = resolved.environment;
        return resolved;
      },
    }, new AgentHarnessRegistry([harness]));

    const result = manager.run(runInput(profile));

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(captured.resolverEnvironment?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured.harnessEnvironment?.ANTHROPIC_API_KEY).toBe(SECRET_VALUE);
    expect(captured.harnessModel).toBe("k3-256k");
  });

  it("preserves the native Anthropic environment exactly through the manager hook", async () => {
    const profile = nativeAnthropicBackendProfile();
    const expectedEnvironment = { ...process.env };
    let harnessEnvironment: NodeJS.ProcessEnv | null = null;
    const harness = capturingHarness(
      (options) => {
        harnessEnvironment = options.environment;
      },
      async (input) => completedResult(input),
    );
    const manager = new ProviderManager({
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver(),
    }, new AgentHarnessRegistry([harness]));

    await manager.run(runInput(profile, "claude-sonnet"));

    expect(harnessEnvironment).toEqual(expectedEnvironment);
  });

  it("isolates concurrent native Anthropic and Kimi launch environments", async () => {
    const kimi = createKimiClaudeBackendProfile({
      id: "kimi:concurrent-isolation",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
    });
    const native = nativeAnthropicBackendProfile();
    const registrations = claudeBackendProfileRegistrations([kimi]);
    const environments = new Map<string, NodeJS.ProcessEnv>();
    const completions = new Map<
      string,
      (result: ProviderRunResult) => void
    >();
    const inherited = Object.fromEntries([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
    ].map((key) => [key, process.env[key]]));
    const harness = capturingHarness(
      (options) => {
        environments.set(options.input.conversationId!, options.environment);
      },
      (input) => new Promise<ProviderRunResult>((resolve) => {
        completions.set(input.conversationId!, resolve);
      }),
    );
    const manager = new ProviderManager({
      ...registrations,
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
        profiles: [kimi],
        resolveSecret: () => SECRET_VALUE,
      }),
    }, new AgentHarnessRegistry([harness]));

    const kimiInput = runInput(kimi, "k3", {
      conversationId: "conversation-kimi",
      runId: "run-kimi",
      turnId: "turn-kimi",
    });
    const nativeInput = runInput(native, "claude-sonnet", {
      conversationId: "conversation-anthropic",
      runId: "run-anthropic",
      turnId: "turn-anthropic",
    });
    const kimiRun = manager.run(kimiInput);
    const nativeRun = manager.run(nativeInput);

    const kimiEnvironment = environments.get("conversation-kimi");
    const nativeEnvironment = environments.get("conversation-anthropic");
    expect(kimiEnvironment).toMatchObject({
      ANTHROPIC_API_KEY: SECRET_VALUE,
      ANTHROPIC_BASE_URL: kimi.baseUrl,
      ANTHROPIC_MODEL: "k3",
    });
    expect(nativeEnvironment).toEqual({ ...process.env });
    expect(nativeEnvironment).not.toBe(kimiEnvironment);
    expect(Object.fromEntries(
      Object.keys(inherited).map((key) => [key, process.env[key]]),
    )).toEqual(inherited);

    completions.get("conversation-kimi")?.(completedResult(kimiInput));
    completions.get("conversation-anthropic")?.(completedResult(nativeInput));
    await expect(Promise.all([kimiRun, nativeRun])).resolves.toEqual([
      expect.objectContaining({ conversationId: "conversation-kimi", status: "completed" }),
      expect.objectContaining({ conversationId: "conversation-anthropic", status: "completed" }),
    ]);
    expect(manager.activeConversationIds()).toEqual([]);
  });

  it("contains a Kimi credential failure and leaves native Anthropic runnable", async () => {
    const kimi = createKimiClaudeBackendProfile({
      id: "kimi:failed-isolation",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
    });
    const native = nativeAnthropicBackendProfile();
    const registrations = claudeBackendProfileRegistrations([kimi]);
    const starts: string[] = [];
    const harness = capturingHarness(
      (options) => starts.push(options.input.backendProfile.id),
      async (input) => completedResult(input),
    );
    const manager = new ProviderManager({
      ...registrations,
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
        profiles: [kimi],
        resolveSecret: () => {
          throw new Error("secret store internal detail");
        },
      }),
    }, new AgentHarnessRegistry([harness]));

    expect(() => manager.run(runInput(kimi))).toThrow(
      "The Kimi credential could not be read from secure storage.",
    );
    expect(manager.isRunning("conversation-integration")).toBe(false);
    await expect(manager.run(runInput(native, "claude-sonnet", {
      conversationId: "conversation-native-after-kimi",
      runId: "run-native-after-kimi",
      turnId: "turn-native-after-kimi",
    }))).resolves.toMatchObject({
      conversationId: "conversation-native-after-kimi",
      status: "completed",
    });
    expect(starts).toEqual(["builtin:anthropic"]);
  });

  it("cancels credential resolution before process launch", async () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:cancel-before-launch",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
    });
    const registrations = claudeBackendProfileRegistrations([profile]);
    const start = vi.fn();
    const harness: AgentHarness = {
      ...capturingHarness(() => undefined, async (input) => completedResult(input)),
      start,
    };
    const manager = new ProviderManager({
      ...registrations,
      resolveBackendLaunchOptions: createClaudeBackendLaunchResolver({
        profiles: [profile],
        resolveSecret: (_reference, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
      }),
    }, new AgentHarnessRegistry([harness]));

    const result = manager.run(runInput(profile));
    expect(manager.cancel("conversation-integration")).toBe(true);
    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(start).not.toHaveBeenCalled();
    expect(manager.isRunning("conversation-integration")).toBe(false);
  });

  it("releases async launch secrets and resources exactly once", async () => {
    const profile = createKimiClaudeBackendProfile({
      id: "kimi:async-cleanup",
      secretReference: SECRET_REFERENCE,
      primaryModelId: "k3",
    });
    const registrations = claudeBackendProfileRegistrations([profile]);
    const releaseAfterStart = vi.fn();
    const dispose = vi.fn();
    const harness = capturingHarness(
      () => undefined,
      async (input) => completedResult(input),
    );
    const manager = new ProviderManager({
      ...registrations,
      resolveBackendLaunchOptions: async (_input, environment) => ({
        environment: {
          ...environment,
          ANTHROPIC_API_KEY: SECRET_VALUE,
        },
        releaseAfterStart,
        dispose,
      }),
    }, new AgentHarnessRegistry([harness]));

    await expect(manager.run(runInput(profile))).resolves.toMatchObject({
      status: "completed",
    });
    expect(releaseAfterStart).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
