import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import {
  backendProbeMatchesProfile,
  type BackendCompatibilityProbeRequest,
} from "../../src/shared/backend-probe";
import type { ModelBackendProtocol, ModelCapability } from "../../src/shared/model-routing";
import * as compatibilityProbeEntryPoint from "../../src/server/runtime/backends/backend-compatibility-probe";
import {
  nativeModelCatalogProbeAdapter,
  probeBackendCompatibility,
  type BackendCompatibilityProbeDependencies,
} from "../../src/server/runtime/backends/backend-compatibility-probe";

const SECRET_REFERENCE = "secret:probe-profile";
const SECRET = "never-return-this-probe-secret";
const FIXED_NOW = new Date("2026-07-25T10:00:00.000Z");
const servers: ReturnType<typeof createServer>[] = [];

describe("backend compatibility probe entrypoint", () => {
  it("preserves the public runtime export surface", () => {
    expect(Object.keys(compatibilityProbeEntryPoint).sort()).toEqual([
      "nativeModelCatalogProbeAdapter",
      "probeBackendCompatibility",
    ]);
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function requestFor(
  protocol: ModelBackendProtocol,
  endpointUrl: string | null,
  overrides: Partial<BackendCompatibilityProbeRequest> = {},
): BackendCompatibilityProbeRequest {
  return {
    profile: {
      id: `custom:${protocol}`,
      displayName: "Probe backend",
      protocol,
      authenticationMode: protocol === "cursor-managed" || protocol === "opencode-native"
        ? "harness-managed"
        : "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 1,
      endpointIdentity: endpointUrl === null
        ? `probe:${protocol}:1`
        : backendEndpointIdentity(endpointUrl),
    },
    endpointUrl,
    modelId: "expected-model",
    secretReference: protocol === "cursor-managed" || protocol === "opencode-native"
      ? null
      : SECRET_REFERENCE,
    allowInsecureLocalhost: endpointUrl?.startsWith("http://") ?? false,
    capabilityHints: [],
    contextWindowHint: null,
    ...overrides,
  };
}

function dependencies(
  overrides: BackendCompatibilityProbeDependencies = {},
): BackendCompatibilityProbeDependencies {
  return {
    resolveCredential: async () => SECRET,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

async function localServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("Probe fixture failed."));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/`;
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function anthropicStream(
  model = "expected-model",
  usage = true,
): string {
  return [
    "event: message_start",
    `data: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_probe",
        type: "message",
        model,
        usage: usage ? { input_tokens: 3, output_tokens: 0 } : undefined,
      },
    })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "OK" },
    })}`,
    "",
    "event: message_delta",
    `data: ${JSON.stringify({
      type: "message_delta",
      usage: usage ? { output_tokens: 1 } : undefined,
    })}`,
    "",
    "event: message_stop",
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
    "",
  ].join("\n");
}

function openAiStream(model = "expected-model"): string {
  return [
    "event: response.created",
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "resp_probe", model },
    })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_probe",
        model,
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

function openAiToolStream(
  name: string,
  nonce: string,
  model = "expected-model",
): string {
  const item = {
    id: "fc_probe",
    call_id: "call_probe",
    type: "function_call",
    name,
    arguments: JSON.stringify({ nonce }),
  };
  return [
    "event: response.created",
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "resp_tool_probe", model },
    })}`,
    "",
    "event: response.output_item.done",
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_tool_probe",
        model,
        output: [item],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

function openAiContinuationStream(
  resultNonce: string,
  model = "expected-model",
): string {
  const item = {
    id: "msg_probe_continuation",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: resultNonce, annotations: [] }],
  };
  return [
    "event: response.created",
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "resp_probe_continuation", model },
    })}`,
    "",
    "event: response.output_text.delta",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: resultNonce })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_probe_continuation",
        model,
        output: [item],
        usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

describe("backend compatibility probe", () => {
  it("verifies only observed Anthropic capabilities and preserves the Kimi base path", async () => {
    let receivedPath = "";
    let receivedSecret = "";
    const endpoint = await localServer((request, response) => {
      receivedPath = request.url ?? "";
      receivedSecret = String(request.headers["x-api-key"] ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(anthropicStream());
    });

    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", `${endpoint}coding/`, {
        capabilityHints: [{
          id: "tools",
          state: "partially-compatible",
          provenance: "provider",
          detail: "Documented by this provider.",
        }],
        contextWindowHint: {
          tokens: 262_144,
          provenance: "provider",
          detail: "Provider documentation.",
        },
      }),
      dependencies(),
    );

    expect(receivedPath).toBe("/coding/v1/messages");
    expect(receivedSecret).toBe(SECRET);
    expect(result).toMatchObject({
      profileId: "custom:anthropic-messages",
      backendConfigurationRevision: 1,
      endpointIdentity: backendEndpointIdentity(`${endpoint}coding/`),
      compatibility: "partially-compatible",
      protocolVerified: true,
      modelVerified: true,
      failure: null,
      checkedAt: FIXED_NOW.toISOString(),
      contextWindow: {
        tokens: 262_144,
        state: "partially-compatible",
        provenance: "provider",
      },
    });
    expect(result.capabilities).toHaveLength(12);
    expect(result.capabilities.find(({ id }) => id === "streaming")).toMatchObject({
      state: "verified",
      provenance: "probe",
      checkedAt: FIXED_NOW.toISOString(),
    });
    expect(result.capabilities.find(({ id }) => id === "usage")).toMatchObject({
      state: "verified",
      provenance: "probe",
    });
    expect(result.capabilities.find(({ id }) => id === "tools")).toMatchObject({
      state: "partially-compatible",
      provenance: "provider",
    });
    expect(result.capabilities.find(({ id }) => id === "images")).toMatchObject({
      state: "unknown",
      provenance: "unknown",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("normalizes root, versioned, and matching full Anthropic endpoints without escaping a base path", async () => {
    const receivedPaths: string[] = [];
    const endpoint = await localServer((request, response) => {
      receivedPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(anthropicStream());
    });
    const cases = [
      ["", "/v1/messages"],
      ["v1/", "/v1/messages"],
      ["v1/messages", "/v1/messages"],
      ["coding/", "/coding/v1/messages"],
      ["coding/v1/", "/coding/v1/messages"],
      ["coding/v1/messages", "/coding/v1/messages"],
    ] as const;
    for (const [suffix] of cases) {
      const result = await probeBackendCompatibility(
        requestFor("anthropic-messages", `${endpoint}${suffix}`),
        dependencies(),
      );
      expect(result.failure).toBeNull();
    }
    expect(receivedPaths).toEqual(cases.map(([, path]) => path));

    const wrong = await probeBackendCompatibility(
      requestFor("anthropic-messages", `${endpoint}coding/v1/responses`),
      dependencies(),
    );
    expect(wrong.failure?.code).toBe("unsupported-protocol");
    expect(receivedPaths).toHaveLength(cases.length);
  });

  it("uses the OpenAI Responses path and bearer authentication without duplicating v1", async () => {
    let receivedPath = "";
    let authorization = "";
    const endpoint = await localServer((request, response) => {
      receivedPath = request.url ?? "";
      authorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.end(openAiStream());
    });

    const result = await probeBackendCompatibility(
      requestFor("openai-responses", `${endpoint}v1/`, {
        profile: {
          ...requestFor("openai-responses", endpoint).profile,
          authenticationMode: "bearer-token",
          endpointIdentity: backendEndpointIdentity(`${endpoint}v1/`),
        },
      }),
      dependencies(),
    );

    expect(receivedPath).toBe("/v1/responses");
    expect(authorization).toBe(`Bearer ${SECRET}`);
    expect(result).toMatchObject({
      protocolVerified: true,
      modelVerified: true,
      failure: null,
    });
  });

  it("attests Responses tools only after an exact inert call/result continuation", async () => {
    const bodies: Record<string, unknown>[] = [];
    const authorizations: string[] = [];
    const endpoint = await localServer(async (request, response) => {
      const body = await requestJson(request);
      bodies.push(body);
      authorizations.push(String(request.headers.authorization ?? ""));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (bodies.length === 1) {
        response.end(openAiStream());
        return;
      }
      if (bodies.length === 3) {
        const input = body.input as Array<{ type?: string; output?: string }>;
        const output = input.find(({ type }) => type === "function_call_output")?.output;
        response.end(openAiContinuationStream(output!));
        return;
      }
      const tools = body.tools as Array<{
        name: string;
        parameters: { properties: { nonce: { enum: string[] } } };
      }>;
      response.end(openAiToolStream(
        tools[0]!.name,
        tools[0]!.parameters.properties.nonce.enum[0]!,
      ));
    });

    const result = await probeBackendCompatibility(
      requestFor("openai-responses", endpoint),
      dependencies(),
    );

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).not.toHaveProperty("tools");
    expect(bodies[1]).toMatchObject({
      model: "expected-model",
      stream: true,
      store: false,
      parallel_tool_calls: false,
      tools: [{
        type: "function",
        strict: true,
        parameters: {
          required: ["nonce"],
          additionalProperties: false,
        },
      }],
    });
    const tool = (bodies[1]!.tools as Array<{ name: string }>)[0]!;
    expect(bodies[1]!.tool_choice).toEqual({ type: "function", name: tool.name });
    const continuation = bodies[2]!.input as Array<Record<string, unknown>>;
    const call = continuation.find(({ type }) => type === "function_call")!;
    const output = continuation.find(({ type }) => type === "function_call_output")!;
    expect(call).toMatchObject({
      call_id: "call_probe",
      name: tool.name,
    });
    expect(output).toMatchObject({
      call_id: "call_probe",
      output: expect.stringMatching(/^[a-f0-9]{32}$/u),
    });
    expect(continuation.find(({ role }) => role === "user")?.content)
      .not.toContain(output.output);
    expect(JSON.stringify(bodies[2]).split(String(output.output))).toHaveLength(2);
    expect(bodies[2]).toMatchObject({
      model: "expected-model",
      stream: true,
      store: false,
      tools: [{ name: tool.name, type: "function" }],
      tool_choice: "none",
    });
    expect(authorizations).toEqual([
      `Bearer ${SECRET}`,
      `Bearer ${SECRET}`,
      `Bearer ${SECRET}`,
    ]);
    expect(result.failure).toBeNull();
    expect(result.capabilities.find(({ id }) => id === "tools")).toMatchObject({
      state: "verified",
      provenance: "probe",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("keeps Responses text compatibility when the inert tool check is unsupported or inexact", async () => {
    let unsupportedRequests = 0;
    const unsupportedEndpoint = await localServer(async (request, response) => {
      await requestJson(request);
      unsupportedRequests += 1;
      if (unsupportedRequests === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(openAiStream());
        return;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "unsupported_tool_choice" } }));
    });
    const unsupported = await probeBackendCompatibility(
      requestFor("openai-responses", unsupportedEndpoint),
      dependencies(),
    );
    expect(unsupportedRequests).toBe(2);
    expect(unsupported.failure).toBeNull();
    expect(unsupported.capabilities.find(({ id }) => id === "streaming")?.state)
      .toBe("verified");
    expect(unsupported.capabilities.find(({ id }) => id === "tools")?.state)
      .toBe("unknown");

    let inexactRequests = 0;
    const inexactEndpoint = await localServer(async (request, response) => {
      const body = await requestJson(request);
      inexactRequests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (inexactRequests === 1) {
        response.end(openAiStream());
        return;
      }
      const tools = body.tools as Array<{
        name: string;
        parameters: { properties: { nonce: { enum: string[] } } };
      }>;
      response.end(openAiToolStream(
        tools[0]!.name,
        `${tools[0]!.parameters.properties.nonce.enum[0]!}-wrong`,
      ));
    });
    const inexact = await probeBackendCompatibility(
      requestFor("openai-responses", inexactEndpoint),
      dependencies(),
    );
    expect(inexactRequests).toBe(2);
    expect(inexact.failure).toBeNull();
    expect(inexact.capabilities.find(({ id }) => id === "tools")?.state)
      .toBe("unknown");

    let continuationRequests = 0;
    const continuationEndpoint = await localServer(async (request, response) => {
      const body = await requestJson(request);
      continuationRequests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (continuationRequests === 1) {
        response.end(openAiStream());
        return;
      }
      if (continuationRequests === 2) {
        const tools = body.tools as Array<{
          name: string;
          parameters: { properties: { nonce: { enum: string[] } } };
        }>;
        response.end(openAiToolStream(
          tools[0]!.name,
          tools[0]!.parameters.properties.nonce.enum[0]!,
        ));
        return;
      }
      response.end(openAiContinuationStream("wrong-result"));
    });
    const invalidContinuation = await probeBackendCompatibility(
      requestFor("openai-responses", continuationEndpoint),
      dependencies(),
    );
    expect(continuationRequests).toBe(3);
    expect(invalidContinuation.failure).toBeNull();
    expect(invalidContinuation.capabilities.find(({ id }) => id === "streaming")?.state)
      .toBe("verified");
    expect(invalidContinuation.capabilities.find(({ id }) => id === "tools")?.state)
      .toBe("unknown");
  });

  it.each([
    {
      label: "credentials in a URL",
      endpoint: "https://user:password@example.com/",
      allowInsecureLocalhost: false,
      code: "invalid-url",
    },
    {
      label: "plain HTTP to a public host",
      endpoint: "http://example.com/",
      allowInsecureLocalhost: true,
      code: "insecure-url",
    },
    {
      label: "local HTTPS without advanced local mode",
      endpoint: "https://127.0.0.1/",
      allowInsecureLocalhost: false,
      code: "private-network",
    },
    {
      label: "a URL query",
      endpoint: "https://example.com/?token=unsafe",
      allowInsecureLocalhost: false,
      code: "invalid-url",
    },
  ])("rejects $label before network access", async ({ endpoint, allowInsecureLocalhost, code }) => {
    let resolved = false;
    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", endpoint, { allowInsecureLocalhost }),
      dependencies({
        resolveAddresses: async () => {
          resolved = true;
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    );
    expect(result.failure?.code).toBe(code);
    expect(resolved).toBe(false);
  });

  it("sanitizes a malformed endpoint before network or raw-input disclosure", async () => {
    const rawEndpoint = "not a URL Authorization: Bearer raw-input-secret";
    let resolved = false;
    const result = await probeBackendCompatibility({
      ...requestFor("anthropic-messages", "https://backend.example/"),
      endpointUrl: rawEndpoint,
    }, dependencies({
      resolveAddresses: async () => {
        resolved = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    }));

    expect(result.failure).toMatchObject({ code: "invalid-url" });
    expect(JSON.stringify(result)).not.toContain(rawEndpoint);
    expect(JSON.stringify(result)).not.toContain("raw-input-secret");
    expect(resolved).toBe(false);
  });

  it("rejects endpoint substitution against the persisted custom identity", async () => {
    let resolved = false;
    const request = requestFor(
      "anthropic-messages",
      "https://original-backend.example/v1",
    );
    const result = await probeBackendCompatibility({
      ...request,
      endpointUrl: "https://replacement-backend.example/v1",
    }, dependencies({
      resolveAddresses: async () => {
        resolved = true;
        return [{ address: "93.184.216.34", family: 4 }];
      },
    }));

    expect(result.failure).toMatchObject({ code: "invalid-url" });
    expect(resolved).toBe(false);
  });

  it("rejects every private or mixed DNS result before opening a request", async () => {
    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", "https://backend.example/"),
      dependencies({
        resolveAddresses: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      }),
    );
    expect(result.failure?.code).toBe("private-network");
  });

  it.each([
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::7f00:1",
    "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    "2002:7f00:0001::",
    "fec0::1",
  ])("rejects IPv6 transition or retired-private address %s", async (address) => {
    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", "https://backend.example/"),
      dependencies({
        resolveAddresses: async () => [{ address, family: 6 }],
      }),
    );
    expect(result.failure?.code).toBe("private-network");
  });

  it("pins the validated address while retaining the original hostname", async () => {
    let hostHeader = "";
    const endpoint = await localServer((request, response) => {
      hostHeader = String(request.headers.host ?? "");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(anthropicStream());
    });
    const localhostEndpoint = endpoint.replace("127.0.0.1", "localhost");
    const order: string[] = [];
    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", localhostEndpoint),
      dependencies({
        resolveCredential: async () => {
          order.push("credential");
          return SECRET;
        },
        resolveAddresses: async () => {
          order.push("dns");
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
    );
    expect(result.failure).toBeNull();
    expect(order).toEqual(["dns", "credential"]);
    expect(hostHeader.startsWith("localhost:")).toBe(true);
  });

  it("does not follow redirects or forward credentials to their destination", async () => {
    let requests = 0;
    const endpoint = await localServer((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
    });
    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", endpoint),
      dependencies(),
    );
    expect(result.failure?.code).toBe("unsafe-redirect");
    expect(requests).toBe(1);
  });

  it("bounds time, response size, and malformed protocol bodies", async () => {
    const timeoutEndpoint = await localServer(() => {
      // Deliberately keep the request open until the probe cancels it.
    });
    const timeout = await probeBackendCompatibility(
      requestFor("anthropic-messages", timeoutEndpoint),
      dependencies({ timeoutMs: 25 }),
    );
    expect(timeout.failure?.code).toBe("timeout");

    const oversizedEndpoint = await localServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-length": "4096",
      });
      response.end("x".repeat(4096));
    });
    const oversized = await probeBackendCompatibility(
      requestFor("anthropic-messages", oversizedEndpoint),
      dependencies({ maxResponseBytes: 128 }),
    );
    expect(oversized.failure?.code).toBe("response-too-large");

    const malformedEndpoint = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: message_start\ndata: not-json\n\n");
    });
    const malformed = await probeBackendCompatibility(
      requestFor("anthropic-messages", malformedEndpoint),
      dependencies(),
    );
    expect(malformed.failure?.code).toBe("malformed-response");
  });

  it.each([
    [401, {}, "invalid-credentials"],
    [403, {}, "invalid-credentials"],
    [429, { "retry-after": "12" }, "rate-limited"],
    [503, {}, "server-error"],
  ] as const)("classifies sanitized HTTP %i failures", async (status, headers, code) => {
    const endpoint = await localServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify({ error: { message: `reflected ${SECRET}` } }));
    });
    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", endpoint),
      dependencies(),
    );
    expect(result.failure?.code).toBe(code);
    if (status === 429) expect(result.failure?.retryAfterSeconds).toBe(12);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("distinguishes a missing model from an unsupported endpoint", async () => {
    const modelEndpoint = await localServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "invalid_request_error", code: "model_not_found", param: "model" },
      }));
    });
    const modelResult = await probeBackendCompatibility(
      requestFor("openai-responses", modelEndpoint),
      dependencies(),
    );
    expect(modelResult.failure?.code).toBe("missing-model");

    const endpointEndpoint = await localServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "not_found_error" } }));
    });
    const endpointResult = await probeBackendCompatibility(
      requestFor("anthropic-messages", endpointEndpoint),
      dependencies(),
    );
    expect(endpointResult.failure?.code).toBe("unsupported-protocol");
  });

  it("keeps successful text from implying unobserved usage or richer capabilities", async () => {
    const endpoint = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(anthropicStream("expected-model", false));
    });
    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", endpoint),
      dependencies(),
    );
    expect(result.failure).toBeNull();
    expect(result.capabilities.find(({ id }) => id === "streaming")?.state).toBe("verified");
    for (const id of ["usage", "tools", "images", "reasoning", "structured-output"] as const) {
      expect(result.capabilities.find((capability) => capability.id === id)?.state).toBe("unknown");
    }
  });

  it("uses bounded native provider metadata without inventing HTTP compatibility", async () => {
    const capabilities: ModelCapability[] = [
      {
        id: "images",
        state: "verified",
        provenance: "provider",
        detail: "Advertised by ACP initialization.",
      },
      {
        id: "session-continuation",
        state: "verified",
        provenance: "harness",
        detail: "Advertised by ACP loadSession.",
      },
    ];
    const adapter = nativeModelCatalogProbeAdapter(async () => [{
      id: "expected-model",
      capabilities,
      contextWindowTokens: 200_000,
    }]);
    const result = await probeBackendCompatibility(
      requestFor("cursor-managed", null),
      dependencies({ nativeAdapters: { "cursor-managed": adapter } }),
    );
    expect(result).toMatchObject({
      protocolVerified: true,
      modelVerified: true,
      failure: null,
      contextWindow: {
        tokens: 200_000,
        state: "verified",
        provenance: "provider",
      },
    });
    expect(result.capabilities.find(({ id }) => id === "images")).toMatchObject({
      state: "verified",
      provenance: "provider",
    });
    expect(result.capabilities.find(({ id }) => id === "tools")?.state).toBe("unknown");
  });

  it("cancels native adapters that do not settle and reports missing native models", async () => {
    const hanging = nativeModelCatalogProbeAdapter(
      async () => await new Promise<never>(() => undefined),
    );
    const timedOut = await probeBackendCompatibility(
      requestFor("opencode-native", null),
      dependencies({
        timeoutMs: 20,
        nativeAdapters: { "opencode-native": hanging },
      }),
    );
    expect(timedOut.failure?.code).toBe("timeout");

    const missing = await probeBackendCompatibility(
      requestFor("opencode-native", null),
      dependencies({
        nativeAdapters: {
          "opencode-native": nativeModelCatalogProbeAdapter(async () => []),
        },
      }),
    );
    expect(missing.failure?.code).toBe("missing-model");
  });

  it("sanitizes malformed native adapter data and external cancellation", async () => {
    const malformed = await probeBackendCompatibility(
      requestFor("cursor-managed", null),
      dependencies({
        nativeAdapters: {
          "cursor-managed": {
            probe: async () => ({
              protocolVerified: true,
              modelVerified: true,
              capabilities: "not-an-array",
            }) as never,
          },
        },
      }),
    );
    expect(malformed.failure?.code).toBe("malformed-response");

    const controller = new AbortController();
    const cancelledPromise = probeBackendCompatibility(
      requestFor("cursor-managed", null),
      dependencies({
        timeoutMs: 5_000,
        nativeAdapters: {
          "cursor-managed": {
            probe: async () => await new Promise<never>(() => undefined),
          },
        },
      }),
      controller.signal,
    );
    controller.abort();
    await expect(cancelledPromise).resolves.toMatchObject({
      failure: { code: "cancelled" },
    });
  });

  it("honors a signal already aborted before DNS or credential access", async () => {
    const controller = new AbortController();
    controller.abort();
    let resolved = false;
    let credentialRead = false;

    const result = await probeBackendCompatibility(
      requestFor("anthropic-messages", "https://cancelled.example/v1"),
      dependencies({
        resolveAddresses: async () => {
          resolved = true;
          return [{ address: "93.184.216.34", family: 4 }];
        },
        resolveCredential: async () => {
          credentialRead = true;
          return SECRET;
        },
      }),
      controller.signal,
    );

    expect(result).toMatchObject({
      protocolVerified: false,
      modelVerified: false,
      failure: { code: "cancelled" },
    });
    expect(resolved).toBe(false);
    expect(credentialRead).toBe(false);
  });

  it("binds evidence to the exact profile revision and endpoint identity", async () => {
    const endpoint = await localServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(anthropicStream());
    });
    const request = requestFor("anthropic-messages", endpoint);
    const result = await probeBackendCompatibility(request, dependencies());

    expect(backendProbeMatchesProfile(
      result,
      request.profile,
      request.modelId,
      FIXED_NOW,
    )).toBe(true);
    expect(backendProbeMatchesProfile(result, {
      ...request.profile,
      configurationRevision: request.profile.configurationRevision + 1,
    }, request.modelId, FIXED_NOW)).toBe(false);
    expect(backendProbeMatchesProfile(result, {
      ...request.profile,
      endpointIdentity: "probe:anthropic-messages:replacement",
    }, request.modelId, FIXED_NOW)).toBe(false);
    expect(backendProbeMatchesProfile(
      result,
      request.profile,
      "replacement-model",
      FIXED_NOW,
    )).toBe(false);
  });
});
