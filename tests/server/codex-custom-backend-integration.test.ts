import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import {
  modelSelectionSchema,
  type ModelBackendProfile,
} from "../../src/shared/model-routing";
import { ProviderManager } from "../../src/server/providers";
import { probeBackendCompatibility } from "../../src/server/runtime/backends/backend-compatibility-probe";
import { createCodexResponsesBackendLaunchResolver } from "../../src/server/runtime/backends/codex-responses-adapter";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

describe.sequential("Codex custom Responses backend integration", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("routes App Server through a tool-attested Responses provider", async () => {
    const root = portableFixtureRoot("codex custom responses");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    const capturePath = join(root, "capture.json");
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
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: profile.configurationRevision,
    });
    const probeRequests: Record<string, unknown>[] = [];
    const handleProbeRequest = async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      const body = await requestJson(request);
      probeRequests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (Array.isArray(body.input)) {
        const output = (body.input as Array<{ type?: string; output?: string }>)
          .find(({ type }) => type === "function_call_output")?.output;
        response.end(responsesContinuationStream(modelSelection.modelId, output!));
        return;
      }
      if (!Array.isArray(body.tools)) {
        response.end(responsesStream(modelSelection.modelId));
        return;
      }
      const tool = body.tools[0] as {
        name: string;
        parameters: { properties: { nonce: { enum: string[] } } };
      };
      response.end(responsesToolStream(
        modelSelection.modelId,
        tool.name,
        tool.parameters.properties.nonce.enum[0]!,
      ));
    };
    const probeServer = createServer((request, response) => {
      void handleProbeRequest(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error("Probe fixture failed."));
      });
    });
    servers.push(probeServer);
    await new Promise<void>((resolve, reject) => {
      probeServer.once("error", reject);
      probeServer.listen(0, "127.0.0.1", () => resolve());
    });
    const probeAddress = probeServer.address() as AddressInfo;
    const probeEndpoint = `http://127.0.0.1:${probeAddress.port}/v1`;
    profile.endpointIdentity = backendEndpointIdentity(probeEndpoint);
    const probe = await probeBackendCompatibility({
      profile,
      endpointUrl: probeEndpoint,
      modelId: modelSelection.modelId,
      secretReference: "secret:responses",
      allowInsecureLocalhost: true,
      capabilityHints: [],
      contextWindowHint: null,
    }, {
      resolveCredential: async () => "owned-integration-secret",
    });
    expect(probeRequests).toHaveLength(3);
    expect(probe.capabilities.find(({ id }) => id === "tools")).toMatchObject({
      state: "verified",
      provenance: "probe",
    });
    const privilegedResolver = createCodexResponsesBackendLaunchResolver({
      profiles: [{
        profile,
        baseUrl: probeEndpoint,
        secretReference: "secret:responses",
        allowInsecureLocalhost: true,
      }],
      resolveSecret: async () => "owned-integration-secret",
    });
    const manager = ProviderManager.createForTests({
      commands: { codex: command },
      backendProfiles: [profile],
      backendProbeResults: [probe],
      detectProvider: async () => ({
        provider: { id: "codex", name: "Codex", command },
        available: true,
        executable: command,
        version: "1.0.0",
        installState: "installed",
        authState: "authenticated",
        canRun: true,
        cleanupConfirmed: true,
        statusMessage: "Connected",
      }),
      resolveBackendLaunchOptions: async (input, environment, context) => {
        const launch = await privilegedResolver(input, environment, context);
        launch.environment.INERTIA_CODEX_CUSTOM_CAPTURE = capturePath;
        const releaseAfterStart = launch.releaseAfterStart;
        return {
          ...launch,
          releaseAfterStart: () => {
            delete launch.environment.INERTIA_CODEX_CUSTOM_CAPTURE;
            releaseAfterStart?.();
          },
        };
      },
    });
    managers.push(manager);
    await manager.detect("codex");
    const installationFingerprint = manager.providerInstallationFingerprint("codex");
    expect(installationFingerprint).not.toBeNull();
    manager.removeBackendProbeResults(profile.id);
    manager.recordBackendProbeResult({
      ...probe,
      authority: {
        ...probe.authority!,
        installationFingerprint,
      },
    });
    const route = manager.resolveModelRoute(modelSelection);
    const usage: number[] = [];
    const result = await manager.run({
      providerId: route.providerId,
      harnessId: route.harnessId,
      backendProfile: route.backendProfile,
      backendCompatibility: route.compatibility,
      modelSelection,
      continuationIdentity: route.continuationIdentity,
      conversationId: "conversation-custom",
      runId: "run-conversation-custom",
      turnId: "turn-conversation-custom",
      cwd: root,
      prompt: "Inspect",
      model: modelSelection.modelId,
      interactionMode: "build",
      access: "supervised",
    }, {
      onUsage: (event) => usage.push(event.usage.usedTokens ?? -1),
    });

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "thread-custom",
      text: "Custom response",
    });
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
          base_url: probeEndpoint,
          wire_api: "responses",
          requires_openai_auth: false,
          env_key: "INERTIA_CODEX_BACKEND_TOKEN",
        },
      },
    });
    expect(JSON.stringify(captured.message)).not.toContain("owned-integration-secret");
  });
});

async function requestJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function responsesStream(model: string): string {
  return [
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "response-text", model },
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "response-text",
        model,
        output: [],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

function responsesToolStream(model: string, name: string, nonce: string): string {
  const item = {
    id: "function-call-item",
    call_id: "function-call",
    type: "function_call",
    name,
    arguments: JSON.stringify({ nonce }),
  };
  return [
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "response-tool", model },
    })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { id: "response-tool", model, output: [item] },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

function responsesContinuationStream(model: string, resultNonce: string): string {
  const item = {
    id: "continuation-message",
    type: "message",
    content: [{ type: "output_text", text: resultNonce }],
  };
  return [
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "response-continuation", model },
    })}`,
    "",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: resultNonce })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "response-continuation",
        model,
        output: [item],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}
