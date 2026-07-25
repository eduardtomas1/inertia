import { describe, expect, it } from "vitest";

import {
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeResult,
} from "../../src/shared/backend-probe";
import {
  MODEL_CAPABILITY_IDS,
  modelSelectionSchema,
  type ModelBackendProfile,
} from "../../src/shared/model-routing";
import { ProviderManager } from "../../src/server/providers";
import {
  AgentHarnessRegistry,
} from "../../src/server/provider/agent-harness-registry";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
} from "../../src/server/provider/agent-harness";
import { CLAUDE_AGENT_SDK_CAPABILITIES } from "../../src/server/provider/claude-agent-sdk-harness";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { resolveOpenCodeModel } from "../../src/server/provider/opencode-sdk-harness";
import { findCursorAdvertisedConfigValue } from "../../src/server/provider/cursor-acp-harness";

const checkedAt = "2026-07-25T08:00:00.000Z";

function profile(
  protocol: "openai-responses" | "anthropic-messages",
): ModelBackendProfile {
  return {
    id: `custom:${protocol}`,
    displayName: protocol === "openai-responses" ? "Responses gateway" : "Messages gateway",
    protocol,
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 2,
    endpointIdentity: `endpoint:${protocol}:2`,
  };
}

function probe(
  backend: ModelBackendProfile,
  modelId: string,
): BackendCompatibilityProbeResult {
  return backendCompatibilityProbeResultSchema.parse({
    profileId: backend.id,
    backendConfigurationRevision: backend.configurationRevision,
    endpointIdentity: backend.endpointIdentity,
    protocol: backend.protocol,
    modelId,
    compatibility: "partially-compatible",
    protocolVerified: true,
    modelVerified: true,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
      id,
      state: id === "streaming" ? "verified" : "unknown",
      provenance: id === "streaming" ? "probe" : "unknown",
      detail: null,
      checkedAt,
    })),
    contextWindow: {
      tokens: null,
      state: "unknown",
      provenance: "unknown",
      detail: null,
      checkedAt,
    },
    failure: null,
    checkedAt,
  });
}

function selection(
  backend: ModelBackendProfile,
  harnessId: "codex-app-server" | "claude-agent-sdk",
  modelId: string,
) {
  return modelSelectionSchema.parse({
    harnessId,
    backendProfileId: backend.id,
    backendProfileDisplayName: backend.displayName,
    modelId,
    alias: null,
    reasoningEffort: null,
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: backend.configurationRevision,
  });
}

describe("ProviderManager harness backend routing", () => {
  it.each([
    ["openai-responses", "codex-app-server", "responses-probe-verified"],
    ["anthropic-messages", "claude-agent-sdk", "anthropic-probe-verified"],
  ] as const)(
    "routes a current %s probe only through its matching harness",
    (protocol, harnessId, reasonCode) => {
      const backend = profile(protocol);
      const modelId = `${protocol}-model`;
      const manager = new ProviderManager({
        backendProfiles: [backend],
        backendProbeResults: [probe(backend, modelId)],
      });

      expect(manager.resolveModelRoute(selection(
        backend,
        harnessId,
        modelId,
      )).compatibility).toMatchObject({
        state: "partially-compatible",
        provenance: "probe",
        reasonCode,
      });
    },
  );

  it("never lets an optimistic custom registration bypass exact probe evidence", () => {
    const backend = profile("openai-responses");
    const manager = new ProviderManager({
      backendProfiles: [backend],
      backendCompatibilities: [{
        harnessId: "codex-app-server",
        backendProfileId: backend.id,
        backendProtocol: backend.protocol,
        state: "verified",
        provenance: "user",
        allowsModelSwitchWithinSession: true,
        reasonCode: "native-backend",
        reason: "Optimistic caller declaration.",
      }],
    });
    expect(manager.resolveModelRoute(selection(
      backend,
      "codex-app-server",
      "model",
    )).compatibility).toMatchObject({
      state: "unknown",
      reasonCode: "probe-required",
    });
  });

  it("invalidates recorded evidence when the profile revision changes", () => {
    const backend = profile("anthropic-messages");
    const result = probe(backend, "model");
    const revised = { ...backend, configurationRevision: 3 };
    const manager = new ProviderManager({
      backendProfiles: [revised],
      backendProbeResults: [result],
    });
    expect(manager.resolveModelRoute(selection(
      revised,
      "claude-agent-sdk",
      "model",
    )).compatibility).toMatchObject({
      state: "unknown",
      reasonCode: "probe-required",
    });
  });

  it("refreshes one exact model without enabling a different model", () => {
    const backend = profile("openai-responses");
    const manager = new ProviderManager({ backendProfiles: [backend] });
    manager.recordBackendProbeResult(probe(backend, "verified-model"));

    expect(manager.resolveModelRoute(selection(
      backend,
      "codex-app-server",
      "verified-model",
    )).compatibility.state).toBe("partially-compatible");
    expect(manager.resolveModelRoute(selection(
      backend,
      "codex-app-server",
      "other-model",
    )).compatibility.reasonCode).toBe("probe-required");
  });

  it("supports safe profile CRUD while protecting built-ins and clearing stale evidence", () => {
    const backend = profile("openai-responses");
    const manager = new ProviderManager({
      backendProfiles: [backend],
      backendProbeResults: [probe(backend, "model")],
    });
    const revised = {
      ...backend,
      configurationRevision: backend.configurationRevision + 1,
      endpointIdentity: "endpoint:openai-responses:3",
    };
    manager.upsertBackendProfile(revised);
    expect(manager.resolveModelRoute(selection(
      revised,
      "codex-app-server",
      "model",
    )).compatibility.reasonCode).toBe("probe-required");

    manager.removeBackendProfile(revised.id);
    expect(() => manager.resolveModelRoute(selection(
      revised,
      "codex-app-server",
      "model",
    ))).toThrow("unavailable");
    expect(() => manager.removeBackendProfile("builtin:openai"))
      .toThrow("cannot be removed");
    expect(() => manager.upsertBackendProfile({
      ...nativeBackendProfileForTest(),
      source: "custom",
    })).toThrow("cannot be replaced");
  });

  it("accepts OpenCode models only by native provider/model catalog identity", () => {
    const model = { id: "claude", name: "Claude" };
    const providers = [{
      id: "anthropic",
      models: { claude: model },
    }] as never;
    expect(resolveOpenCodeModel("anthropic/claude", providers)).toBe(model);
    expect(() => resolveOpenCodeModel("claude", providers))
      .toThrow("native provider/model catalog");
    expect(() => resolveOpenCodeModel("other/claude", providers))
      .toThrow("does not advertise");
  });

  it("exposes Cursor model selection only from explicit ACP config options", () => {
    expect(findCursorAdvertisedConfigValue([], "model", "model-a"))
      .toBeUndefined();
    expect(findCursorAdvertisedConfigValue([{
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "model-a",
      options: [{ value: "model-a", name: "Model A" }],
    }] as never, "model", "model-a")).toEqual({
      id: "model",
      value: "model-a",
    });
    expect(findCursorAdvertisedConfigValue([{
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: "build",
      options: [{ value: "build", name: "Build" }],
    }] as never, "model", "model-a")).toBeUndefined();
  });

  it("learns custom run metadata only inside the exact backend/model scope", async () => {
    const backend = profile("anthropic-messages");
    const selected = selection(
      backend,
      "claude-agent-sdk",
      "kimi-model",
    );
    const metadataCache = new ProviderMetadataCache();
    metadataCache.correlate("claude", {
      executable: "claude",
      version: "2.1.0",
      authState: "authenticated",
    });
    metadataCache.learn("claude", "claude", {
      models: [providerModel("claude-native")],
      rateLimits: [{
        id: "anthropic",
        label: "Anthropic",
        usedPercent: 20,
        remainingPercent: 80,
        windowMinutes: 300,
        resetsAt: null,
      }],
    }, "provider");
    const harness: AgentHarness = {
      id: "claude-agent-sdk",
      providerId: "claude",
      capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
      supports: (input) => input.harnessId === "claude-agent-sdk",
      start: (options) => {
        const conversationId = options.input.conversationId!;
        const emitter = createAgentHarnessEmitter(
          "claude",
          conversationId,
          options.callbacks,
          options.input.runId,
          options.input.turnId ?? null,
        );
        emitter.rich({
          type: "metadata",
          metadata: { models: [providerModel("kimi-model")] },
          source: "session",
          complete: true,
        });
        return {
          harnessId: "claude-agent-sdk",
          providerId: "claude",
          cancel: () => undefined,
          extension: {
            kind: "claude-agent-sdk",
            respondToApproval: () => false,
            respondToInput: () => false,
          },
          result: Promise.resolve({
            providerId: "claude",
            conversationId,
            status: "completed",
            text: "",
            textTruncated: false,
            exitCode: 0,
            signal: null,
          }),
        };
      },
    };
    const manager = new ProviderManager({
      commands: { claude: "claude" },
      backendProfiles: [backend],
      backendProbeResults: [probe(backend, selected.modelId)],
      metadataCache,
    }, new AgentHarnessRegistry([harness]));
    const route = manager.resolveModelRoute(selected);
    const observedMetadata: string[] = [];
    await manager.run({
      providerId: route.providerId,
      harnessId: route.harnessId,
      backendProfile: route.backendProfile,
      backendCompatibility: route.compatibility,
      modelSelection: selected,
      continuationIdentity: route.continuationIdentity,
      conversationId: "custom-metadata",
      runId: "run-custom-metadata",
      turnId: "turn-custom-metadata",
      cwd: "/workspace",
      prompt: "Inspect",
      model: selected.modelId,
      interactionMode: "build",
      access: "supervised",
    }, {
      onMetadata: (event) => {
        observedMetadata.push(event.metadata.models?.[0]?.id ?? "");
      },
    });

    expect(manager.cachedMetadata("claude")).toMatchObject({
      models: [expect.objectContaining({ id: "claude-native" })],
      rateLimits: [expect.objectContaining({ id: "anthropic" })],
    });
    expect(manager.cachedMetadataForSelection(selected)).toMatchObject({
      models: [expect.objectContaining({ id: "kimi-model" })],
      rateLimits: [],
      metadataState: { rateLimits: { freshness: "unavailable" } },
    });
    expect(observedMetadata).toEqual(["kimi-model"]);
  });
});

function nativeBackendProfileForTest(): ModelBackendProfile {
  return {
    id: "builtin:openai",
    displayName: "OpenAI",
    protocol: "openai-responses",
    authenticationMode: "harness-managed",
    source: "built-in",
    enabled: true,
    configurationRevision: 0,
    endpointIdentity: null,
  };
}

function providerModel(id: string) {
  return {
    id,
    label: id,
    description: `${id} model`,
    isDefault: true,
    inputModalities: ["text"] as Array<"text" | "image">,
    reasoningOptions: [],
    defaultReasoningEffort: "",
  };
}
