import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_DISCOVERED_BACKEND_MODELS } from "../../src/shared/backend-profile-settings";
import { RuntimeStore } from "../../src/server/database";
import { BackendProfileController } from "../../src/server/runtime/backends/backend-profile-controller";
import {
  discoverHttpBackendModels,
  type BackendModelDiscoveryRequest,
} from "../../src/server/runtime/backends/backend-compatibility-probe/discovery";

const SECRET = "discovery-secret-value";
const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
const stores = new Set<RuntimeStore>();

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

interface ObservedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
}

async function modelServer(
  respond: (response: ServerResponse) => void,
): Promise<{ origin: string; requests: ObservedRequest[] }> {
  const requests: ObservedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    respond(response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
  };
}

function json(value: unknown, status = 200): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
}

function request(
  endpointUrl: string,
  overrides: Partial<BackendModelDiscoveryRequest> = {},
): BackendModelDiscoveryRequest {
  return {
    protocol: "openai-responses",
    authenticationMode: "bearer-token",
    endpointUrl,
    secretReference: "secret:discovery",
    allowInsecureLocalhost: true,
    allowPrivateNetwork: false,
    ...overrides,
  };
}

const credentials = { resolveCredential: async () => SECRET };

describe("backend model discovery", () => {
  it("reads an Anthropic model list with the API key headers", async () => {
    const server = await modelServer(json({
      data: [
        { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model" },
        { id: "claude-haiku-5-5", display_name: "Claude\u0007 Haiku\n5.5" },
        { id: "claude-opus-5-5", display_name: "Duplicate" },
        { id: "bad\u0000id", display_name: "Bad" },
        { id: "", display_name: "Empty" },
        { display_name: "Missing" },
        "not-a-model",
      ],
      has_more: false,
    }));

    const models = await discoverHttpBackendModels(request(server.origin, {
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
    }), credentials);

    expect(models).toEqual([
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: "/v1/models?limit=1000",
      headers: {
        "x-api-key": SECRET,
        "anthropic-version": "2023-06-01",
        accept: "application/json",
      },
    });
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("reads an OpenAI-compatible model list with a bearer token", async () => {
    const server = await modelServer(json({
      object: "list",
      data: [{ id: "gpt-6.1-sol", object: "model", owned_by: "openai" }],
    }));

    const models = await discoverHttpBackendModels(request(`${server.origin}/v1`), credentials);

    expect(models).toEqual([{ id: "gpt-6.1-sol", displayName: "gpt-6.1-sol" }]);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(server.requests[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("uses a bearer token for Anthropic-compatible gateways that ask for one", async () => {
    const server = await modelServer(json({ data: [{ id: "gateway-model" }] }));

    await discoverHttpBackendModels(request(`${server.origin}/v1/messages`, {
      protocol: "anthropic-messages",
      authenticationMode: "bearer-token",
    }), credentials);

    expect(server.requests[0]).toMatchObject({
      url: "/v1/models?limit=1000",
      headers: { authorization: `Bearer ${SECRET}`, "anthropic-version": "2023-06-01" },
    });
  });

  it("drops ids and strips names that hide bidirectional or zero-width characters", async () => {
    const server = await modelServer(json({
      data: [
        { id: "safe-model", display_name: "Safe\u200b \u202eledom\u202c Model\ufeff" },
        { id: "spoof\u202e-model" },
        { id: "zero\u200dwidth" },
        { id: "isolate\u2066-model" },
        { id: "\u200b", display_name: "Only zero width" },
      ],
    }));

    const models = await discoverHttpBackendModels(request(server.origin), credentials);

    expect(models).toEqual([{ id: "safe-model", displayName: "Safe ledom Model" }]);
  });

  it("caps the number of models it returns", async () => {
    const server = await modelServer(json({
      data: Array.from({ length: MAX_DISCOVERED_BACKEND_MODELS + 200 }, (_, index) => ({
        id: `model-${index}`,
      })),
    }));

    const models = await discoverHttpBackendModels(request(server.origin), credentials);

    expect(models).toHaveLength(MAX_DISCOVERED_BACKEND_MODELS);
  });

  it("refuses a model list larger than the response bound", async () => {
    const server = await modelServer(json({
      data: Array.from({ length: 200 }, (_, index) => ({ id: `model-${index}` })),
    }));

    await expect(discoverHttpBackendModels(request(server.origin), {
      ...credentials,
      maxResponseBytes: 512,
    })).rejects.toMatchObject({
      code: "response-too-large",
      message: "The backend's model list is too large to load.",
    });
  });

  it.each([
    ["malformed JSON", (response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"data\": [");
    }],
    ["an HTML page", (response: ServerResponse) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>Gateway</body></html>");
    }],
    ["JSON without a model list", json({ models: [] })],
  ])("refuses %s", async (_label, respond) => {
    const server = await modelServer(respond);

    await expect(discoverHttpBackendModels(request(server.origin), credentials))
      .rejects.toMatchObject({
        code: "malformed-response",
        message: "The backend returned a model list Inertia could not read.",
      });
  });

  it("explains missing model lists and rejected keys without echoing the body", async () => {
    const missing = await modelServer(json({ error: { message: SECRET } }, 404));
    await expect(discoverHttpBackendModels(request(missing.origin), credentials))
      .rejects.toMatchObject({
        message: "This backend does not offer a model list. Enter the model IDs yourself.",
      });
    const rejected = await modelServer(json({ error: { message: SECRET } }, 401));
    await expect(discoverHttpBackendModels(request(rejected.origin), credentials))
      .rejects.toMatchObject({
        code: "invalid-credentials",
        message: "The backend rejected the configured credential.",
      });
  });

  it("applies the probe network policy before reading the credential", async () => {
    const server = await modelServer(json({ data: [] }));
    let credentialRead = false;
    const watched = {
      resolveCredential: async () => {
        credentialRead = true;
        return SECRET;
      },
    };

    await expect(discoverHttpBackendModels(request(server.origin, {
      allowInsecureLocalhost: false,
    }), watched)).rejects.toMatchObject({ code: "insecure-url" });
    await expect(discoverHttpBackendModels(request("https://gateway.lan/v1", {
      allowInsecureLocalhost: false,
    }), {
      ...watched,
      resolveAddresses: async () => [{ address: "10.0.0.8", family: 4 }],
    })).rejects.toMatchObject({ code: "private-network" });
    expect(credentialRead).toBe(false);
    expect(server.requests).toEqual([]);
  });

  it("returns discovered models through the controller without saving them", async () => {
    const server = await modelServer(json({ data: [{ id: "local-model", display_name: "Local model" }] }));
    const directory = await mkdtemp(join(tmpdir(), "inertia-model-discovery-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), directory);
    stores.add(store);
    const controller = await BackendProfileController.create({
      store,
      credentials: {
        resolve: async () => SECRET,
        status: async () => ({ hasSecret: true, credentialGeneration: null }),
        forget: async () => true,
      },
    });
    const created = await controller.createProfile({
      displayName: "Local gateway",
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      preset: "custom",
      baseUrl: server.origin,
      allowInsecureLocalhost: true,
      models: [{
        id: "configured-model",
        displayName: "Configured model",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      }],
      routing: { mode: "simple", primaryModelId: "configured-model" },
      capabilityHints: [],
    });

    await expect(controller.discoverModels(created.id)).resolves.toEqual({
      kind: "backend.profile.models",
      profileId: created.id,
      models: [{ id: "local-model", displayName: "Local model" }],
    });
    expect(store.modelBackendProfile(created.id).profile.models.map(({ id }) => id))
      .toEqual(["configured-model"]);
    expect(server.requests[0]).toMatchObject({
      url: "/v1/models",
      headers: { authorization: `Bearer ${SECRET}` },
    });
  });
});
