import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  backendCompatibilityProbeResultSchema,
} from "../../src/shared/backend-probe";
import {
  MODEL_CAPABILITY_IDS,
  modelSelectionSchema,
  type ModelBackendProfile,
} from "../../src/shared/model-routing";
import { ProviderManager } from "../../src/server/providers";
import { createCodexResponsesBackendLaunchResolver } from "../../src/server/runtime/backends/codex-responses-adapter";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const checkedAt = "2026-07-25T08:00:00.000Z";

describe.sequential("Codex custom Responses backend integration", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapturePath = process.env.INERTIA_CODEX_CUSTOM_CAPTURE;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
    if (originalCapturePath === undefined) delete process.env.INERTIA_CODEX_CUSTOM_CAPTURE;
    else process.env.INERTIA_CODEX_CUSTOM_CAPTURE = originalCapturePath;
  });

  it("keeps App Server richness while routing through a probed Responses provider", async () => {
    const root = portableFixtureRoot("codex custom responses");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    const capturePath = join(root, "capture.json");
    process.env.INERTIA_CODEX_CUSTOM_CAPTURE = capturePath;
    writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    fs.writeFileSync(process.env.INERTIA_CODEX_CUSTOM_CAPTURE, JSON.stringify({
      message,
      credentialPresent: process.env.INERTIA_CODEX_BACKEND_TOKEN === "owned-integration-secret"
    }));
    return send({ id: message.id, result: { thread: { id: "thread-custom" }, model: "responses-model" } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-custom", status: "inProgress", items: [], error: null } } });
    send({ method: "turn/started", params: { threadId: "thread-custom", turn: { id: "turn-custom", status: "inProgress", items: [], error: null } } });
    send({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-custom", turnId: "turn-custom", itemId: "reasoning", summaryIndex: 0, delta: "Reasoning survived." } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-custom", turnId: "turn-custom", tokenUsage: { total: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, last: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-custom", turnId: "turn-custom", itemId: "message", delta: "Custom response" } });
    return send({ method: "turn/completed", params: { threadId: "thread-custom", turn: { id: "turn-custom", status: "completed", items: [], error: null } } });
  }
});
`);

    const profile: ModelBackendProfile = {
      id: "custom:responses",
      displayName: "Responses gateway",
      protocol: "openai-responses",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 1,
      endpointIdentity: "endpoint:responses:1",
    };
    const modelSelection = modelSelectionSchema.parse({
      harnessId: "codex-app-server",
      backendProfileId: profile.id,
      backendProfileDisplayName: profile.displayName,
      modelId: "responses-model",
      alias: null,
      reasoningEffort: "high",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: profile.configurationRevision,
    });
    const probe = backendCompatibilityProbeResultSchema.parse({
      profileId: profile.id,
      backendConfigurationRevision: profile.configurationRevision,
      endpointIdentity: profile.endpointIdentity,
      protocol: profile.protocol,
      modelId: modelSelection.modelId,
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
    const manager = new ProviderManager({
      commands: { codex: command },
      backendProfiles: [profile],
      backendProbeResults: [probe],
      resolveBackendLaunchOptions: createCodexResponsesBackendLaunchResolver({
        profiles: [{
          profile,
          baseUrl: "http://127.0.0.1:4312/v1",
          secretReference: "secret:responses",
          allowInsecureLocalhost: true,
        }],
        resolveSecret: async () => "owned-integration-secret",
      }),
    });
    managers.push(manager);
    const route = manager.resolveModelRoute(modelSelection);
    const reasoning: string[] = [];
    const usage: number[] = [];
    const result = await manager.run({
      providerId: route.providerId,
      harnessId: route.harnessId,
      backendProfile: route.backendProfile,
      backendCompatibility: route.compatibility,
      modelSelection,
      continuationIdentity: route.continuationIdentity,
      conversationId: "conversation-custom",
      cwd: root,
      prompt: "Inspect",
      model: modelSelection.modelId,
      reasoningEffort: "high",
      interactionMode: "build",
      access: "supervised",
    }, {
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => usage.push(event.usage.usedTokens ?? -1),
    });

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "thread-custom",
      text: "Custom response",
    });
    expect(reasoning).toEqual(["Reasoning survived."]);
    expect(usage).toEqual([3]);
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      credentialPresent: boolean;
      message: { params: Record<string, unknown> };
    };
    expect(captured.credentialPresent).toBe(true);
    expect(captured.message.params).toMatchObject({
      model: "responses-model",
      modelProvider: "inertia_custom_responses",
      config: {
        "model_providers.inertia_custom_responses": {
          name: "Responses gateway",
          base_url: "http://127.0.0.1:4312/v1",
          wire_api: "responses",
          requires_openai_auth: false,
          env_key: "INERTIA_CODEX_BACKEND_TOKEN",
        },
      },
    });
    expect(JSON.stringify(captured.message)).not.toContain("owned-integration-secret");
  });
});
