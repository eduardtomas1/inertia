import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  modelBackendProfileProbeSchema,
  modelSelectionForBackendProfile,
} from "../../src/shared/backend-profile-settings";
import type { ProviderInfo } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import {
  BackendProfileController,
  type BackendCredentialBroker,
} from "../../src/server/runtime/backends/backend-profile-controller";

const SECRET = "key-check-secret";
const directories: string[] = [];
const stores = new Set<RuntimeStore>();
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

interface Observed {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sse(response: ServerResponse, events: readonly Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

function completed(model: string, output: unknown[]): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      model,
      output,
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    },
  };
}

interface BackendOptions {
  modelsStatus?: number;
  modelsBody?: string;
  probeStatus?: number;
}

async function responsesBackend(options: BackendOptions = {}): Promise<{ url: string; observed: Observed[] }> {
  const observed: Observed[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      observed.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      if (request.method === "GET") {
        response.writeHead(options.modelsStatus ?? 200, { "content-type": "application/json" });
        response.end(options.modelsBody ?? JSON.stringify({ object: "list", data: [{ id: "gpt-keycheck" }] }));
        return;
      }
      if (options.probeStatus) {
        response.writeHead(options.probeStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: "authentication_error", message: "Invalid key." } }));
        return;
      }
      const model = String(body?.model);
      const created = { type: "response.created", response: { id: "resp_1", status: "in_progress", model } };
      const tools = body?.tools as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(body?.input)) {
        const output = (body.input as Array<Record<string, unknown>>)
          .find((item) => item.type === "function_call_output")?.output;
        const message = { type: "message", content: [{ type: "output_text", text: String(output) }] };
        sse(response, [created, completed(model, [message])]);
        return;
      }
      if (tools && body?.tool_choice !== "none") {
        const tool = tools[0]!;
        const nonce = (tool.parameters as { properties: { nonce: { enum: string[] } } }).properties.nonce.enum[0];
        const call = {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: tool.name,
          arguments: JSON.stringify({ nonce }),
        };
        sse(response, [created, { type: "response.output_item.done", item: call }, completed(model, [call])]);
        return;
      }
      sse(response, [created, completed(model, [])]);
    }).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("Fixture failed."));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, observed };
}

async function runtimeStore(): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-key-check-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), directory);
  stores.add(store);
  return store;
}

function broker(): BackendCredentialBroker & { generation: string } {
  const credentials = {
    generation: "generation:one",
    resolve: async () => SECRET,
    status: async () => ({ hasSecret: true, credentialGeneration: credentials.generation }),
    forget: async () => true,
  };
  return credentials;
}

function codexProvider(): ProviderInfo {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "1.0.0",
    executable: "/opt/bin/codex",
    installState: "installed",
    authState: "unauthenticated",
    canRun: false,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: {
      models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
    },
  };
}

async function keyRoute(url: string) {
  const store = await runtimeStore();
  const credentials = broker();
  const controller = await BackendProfileController.create({ store, credentials });
  const created = await controller.createProfile({
    displayName: "Local Responses",
    harnessId: "codex-app-server",
    protocol: "openai-responses",
    authenticationMode: "bearer-token",
    preset: "custom",
    baseUrl: url,
    allowInsecureLocalhost: true,
    models: ["gpt-keycheck", "gpt-other"].map((id) => ({
      id,
      displayName: id,
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    })),
    routing: { mode: "simple", primaryModelId: "gpt-keycheck" },
    capabilityHints: [],
  });
  await controller.reconcileCredentialRevision(created.id, "generation:one");
  return { store, credentials, controller, profileId: created.id };
}

describe("key check before first use", () => {
  it("accepts an empty model list as a key check in the command schema", () => {
    expect(modelBackendProfileProbeSchema.safeParse({ profileId: "custom:key", modelIds: [] }).success).toBe(true);
  });

  it("checks the key through the model list, not a probe of every model", async () => {
    const backend = await responsesBackend();
    const { controller, profileId } = await keyRoute(backend.url);

    const result = await controller.probeWithOutcome(profileId, []);

    expect(backend.observed).toEqual([
      expect.objectContaining({ method: "GET", url: "/v1/models", authorization: `Bearer ${SECRET}` }),
    ]);
    expect(result.skippedModelIds).toEqual([]);
    expect(result.profile).toMatchObject({ keyVerified: true });
    expect(result.profile.models.every(({ latestProbe }) => latestProbe === null)).toBe(true);
  });

  it.each([
    ["has no model list endpoint", { modelsStatus: 404, modelsBody: JSON.stringify({ error: { type: "not_found" } }) }],
    ["answers the model list with something other than JSON", { modelsBody: "<html>Not here</html>" }],
    ["returns an empty model list", { modelsBody: JSON.stringify({ object: "list", data: [] }) }],
  ])("checks the key by probing the primary model when the backend %s", async (_case, options) => {
    const backend = await responsesBackend(options);
    const { controller, profileId } = await keyRoute(backend.url);

    const result = await controller.probeWithOutcome(profileId, []);

    expect(backend.observed[0]).toMatchObject({ method: "GET", url: "/v1/models" });
    const probed = backend.observed.slice(1);
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every(({ method, body }) => method === "POST" && body?.model === "gpt-keycheck")).toBe(true);
    expect(result.profile).toMatchObject({ keyVerified: true });
    expect(result.profile.models.find(({ id }) => id === "gpt-keycheck")?.latestProbe).not.toBeNull();
    expect(result.profile.models.find(({ id }) => id === "gpt-other")?.latestProbe).toBeNull();
  });

  it("reports the primary model's rejection when the backend has no model list", async () => {
    const backend = await responsesBackend({ modelsStatus: 404, modelsBody: "{}", probeStatus: 401 });
    const { controller, profileId } = await keyRoute(backend.url);

    await expect(controller.probeWithOutcome(profileId, []))
      .rejects.toThrow("The backend rejected the configured credential.");
    expect(controller.detail(profileId).keyVerified).toBe(false);
  });

  it("refuses to enable before the key is checked and enables after it", async () => {
    const backend = await responsesBackend();
    const { controller, profileId } = await keyRoute(backend.url);

    await expect(controller.updateProfile(profileId, { enabled: true }))
      .rejects.toThrow("Test this backend before enabling it.");
    await controller.probeWithOutcome(profileId, []);
    const enabled = await controller.updateProfile(profileId, { enabled: true });
    expect(enabled).toMatchObject({ enabled: true, keyVerified: true });
    expect(enabled.models.map(({ compatibility }) => compatibility.reasonCode))
      .toEqual(["probe-required", "probe-required"]);
  });

  it("reports a rejected key and leaves the route unverified", async () => {
    const backend = await responsesBackend({ modelsStatus: 401 });
    const { controller, profileId } = await keyRoute(backend.url);

    await expect(controller.probeWithOutcome(profileId, []))
      .rejects.toThrow("The backend rejected the configured credential.");
    expect(controller.detail(profileId).keyVerified).toBe(false);
  });

  it("forgets the key check when the key changes", async () => {
    const backend = await responsesBackend();
    const { controller, credentials, profileId } = await keyRoute(backend.url);
    await controller.probeWithOutcome(profileId, []);

    credentials.generation = "generation:two";
    await controller.reconcileCredentialRevision(profileId, "generation:two");

    expect(controller.detail(profileId).keyVerified).toBe(false);
  });

  it("runs the full Responses probe, tool stage included, before the first launch", async () => {
    const backend = await responsesBackend();
    const { controller, store, profileId } = await keyRoute(backend.url);
    await controller.probeWithOutcome(profileId, []);
    await controller.updateProfile(profileId, { enabled: true });
    const selection = modelSelectionForBackendProfile(store.modelBackendProfile(profileId).profile, "gpt-keycheck");

    await expect(controller.readiness(selection, codexProvider()))
      .resolves.toEqual({ ready: true, message: null });

    const posts = backend.observed.filter(({ method }) => method === "POST");
    expect(posts).toHaveLength(3);
    expect(Array.isArray(posts[1]?.body?.tools)).toBe(true);
    expect(Array.isArray(posts[2]?.body?.input)).toBe(true);
    const model = controller.detail(profileId).models.find(({ id }) => id === "gpt-keycheck");
    expect(model?.latestProbe?.capabilities.find(({ id }) => id === "tools")).toMatchObject({
      state: "verified",
      provenance: "probe",
    });
    expect(model?.compatibility).toMatchObject({ reasonCode: "responses-probe-verified" });
  });
});
