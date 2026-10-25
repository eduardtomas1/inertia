import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import type { BackendCompatibilityProbeRequest } from "../../src/shared/backend-probe";
import type { ModelBackendProtocol } from "../../src/shared/model-routing";
import { probeBackendCompatibility } from "../../src/server/runtime/backends/backend-compatibility-probe";

const SECRET = "stream-shape-secret";
const FIXED_NOW = new Date("2030-04-01T10:00:00.000Z");
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

type Handler = (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>;

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function server(handler: Handler): Promise<{ url: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const instance = createServer((request, response) => {
    void readBody(request).then(async (body) => {
      bodies.push(body);
      await handler(body, response);
    }).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error("Fixture failed."));
    });
  });
  servers.push(instance);
  await new Promise<void>((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => resolve());
  });
  return { url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}/v1`, bodies };
}

function request(
  protocol: ModelBackendProtocol,
  endpointUrl: string,
  modelId: string,
): BackendCompatibilityProbeRequest {
  return {
    profile: {
      id: `custom:${protocol}`,
      displayName: "Stream shapes",
      protocol,
      authenticationMode: protocol === "anthropic-messages" ? "api-key" : "bearer-token",
      source: "custom",
      enabled: true,
      configurationRevision: 1,
      endpointIdentity: backendEndpointIdentity(endpointUrl),
    },
    endpointUrl,
    modelId,
    secretReference: "secret:stream-shapes",
    allowInsecureLocalhost: true,
    capabilityHints: [],
    contextWindowHint: null,
  };
}

function sse(response: ServerResponse, events: readonly Record<string, unknown>[]): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.end(events.map((event) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

function delayed(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseObject(model: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_0123",
    object: "response",
    created_at: 1_900_000_000,
    status,
    model,
    output: [],
    usage: null,
    ...extra,
  };
}

const usage = {
  input_tokens: 12,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 18,
  output_tokens_details: { reasoning_tokens: 16 },
  total_tokens: 30,
};

function openAiText(model: string, terminal: "completed" | "incomplete", text = "OK") {
  const message = {
    id: "msg_0123",
    type: "message",
    status: terminal === "completed" ? "completed" : "incomplete",
    role: "assistant",
    content: [{ type: "output_text", annotations: [], text }],
  };
  return [
    { type: "response.created", sequence_number: 0, response: responseObject(model, "in_progress") },
    { type: "response.in_progress", sequence_number: 1, response: responseObject(model, "in_progress") },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { id: "rs_0123", type: "reasoning", summary: [] },
    },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item: { id: "rs_0123", type: "reasoning", summary: [] },
    },
    {
      type: "response.output_item.added",
      sequence_number: 4,
      output_index: 1,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      sequence_number: 5,
      item_id: "msg_0123",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", annotations: [], text: "" },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 6,
      item_id: "msg_0123",
      output_index: 1,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      sequence_number: 7,
      item_id: "msg_0123",
      output_index: 1,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      sequence_number: 8,
      item_id: "msg_0123",
      output_index: 1,
      content_index: 0,
      part: { type: "output_text", annotations: [], text },
    },
    { type: "response.output_item.done", sequence_number: 9, output_index: 1, item: message },
    terminal === "completed"
      ? {
          type: "response.completed",
          sequence_number: 10,
          response: responseObject(model, "completed", {
            output: [{ id: "rs_0123", type: "reasoning", summary: [] }, message],
            usage,
          }),
        }
      : {
          type: "response.incomplete",
          sequence_number: 10,
          response: responseObject(model, "incomplete", {
            incomplete_details: { reason: "max_output_tokens" },
            output: [{ id: "rs_0123", type: "reasoning", summary: [] }, message],
            usage,
          }),
        },
  ];
}

function openAiToolCall(model: string, name: string, nonce: string) {
  const call = {
    id: "fc_0123",
    type: "function_call",
    status: "completed",
    arguments: JSON.stringify({ nonce }),
    call_id: "call_0123",
    name,
  };
  return [
    { type: "response.created", sequence_number: 0, response: responseObject(model, "in_progress") },
    { type: "response.in_progress", sequence_number: 1, response: responseObject(model, "in_progress") },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { ...call, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      sequence_number: 3,
      item_id: "fc_0123",
      output_index: 0,
      delta: call.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 4,
      item_id: "fc_0123",
      output_index: 0,
      arguments: call.arguments,
    },
    { type: "response.output_item.done", sequence_number: 5, output_index: 0, item: call },
    {
      type: "response.completed",
      sequence_number: 6,
      response: responseObject(model, "completed", { output: [call], usage }),
    },
  ];
}

function toolChallenge(body: Record<string, unknown>): { name: string; nonce: string } | null {
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (!tools || body.tool_choice === "none") return null;
  const tool = tools[0]!;
  const parameters = tool.parameters as { properties: { nonce: { enum: string[] } } };
  return { name: String(tool.name), nonce: parameters.properties.nonce.enum[0]! };
}

function continuationOutput(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.input)) return null;
  const output = (body.input as Array<Record<string, unknown>>)
    .find((item) => item.type === "function_call_output");
  return output ? String(output.output) : null;
}

function realisticOpenAi(model: string, terminal: "completed" | "incomplete" = "completed"): Handler {
  return (body, response) => {
    const challenge = toolChallenge(body);
    if (challenge) {
      sse(response, openAiToolCall(model, challenge.name, challenge.nonce));
      return;
    }
    const result = continuationOutput(body);
    if (result !== null) {
      sse(response, openAiText(model, "completed", result));
      return;
    }
    sse(response, openAiText(model, terminal));
  };
}

function anthropicStream(model: string) {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_01ABC",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "ping" },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "max_tokens", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
}

const dependencies = {
  resolveCredential: async () => SECRET,
  now: () => FIXED_NOW,
};

describe("probes against real provider stream shapes", () => {
  it("verifies an OpenAI Responses stream that answers with a dated snapshot", async () => {
    const backend = await server(realisticOpenAi("gpt-5-2025-08-07"));

    const result = await probeBackendCompatibility(request("openai-responses", backend.url, "gpt-5"), dependencies);

    expect(result).toMatchObject({ failure: null, protocolVerified: true, modelVerified: true });
    expect(result.capabilities.find(({ id }) => id === "tools")).toMatchObject({
      state: "verified",
      provenance: "probe",
    });
    expect(result.capabilities.find(({ id }) => id === "usage")?.state).toBe("verified");
    expect(backend.bodies[0]?.max_output_tokens).toBeGreaterThanOrEqual(256);
    expect(backend.bodies[1]?.max_output_tokens).toBeGreaterThanOrEqual(1_024);
    expect(backend.bodies[2]?.max_output_tokens).toBeGreaterThanOrEqual(1_024);
  });

  it("accepts a reasoning model that stops at the output limit", async () => {
    const backend = await server(realisticOpenAi("o9-mini-2030-01-31", "incomplete"));

    const result = await probeBackendCompatibility(request("openai-responses", backend.url, "o9-mini"), dependencies);

    expect(result).toMatchObject({ failure: null, protocolVerified: true, modelVerified: true });
  });

  it("does not accept another model or a non-date suffix as the requested model", async () => {
    for (const returned of ["gpt-5-mini", "gpt-5-2025-08-07-preview", "gpt-50"]) {
      const backend = await server(realisticOpenAi(returned));
      const result = await probeBackendCompatibility(request("openai-responses", backend.url, "gpt-5"), dependencies);
      expect(result.failure?.code).toBe("missing-model");
    }
  });

  it("refuses an incomplete response stopped for any other reason", async () => {
    const backend = await server((_body, response) => {
      const events = openAiText("gpt-5", "incomplete");
      const terminal = events.at(-1) as unknown as { response: { incomplete_details: { reason: string } } };
      terminal.response.incomplete_details.reason = "content_filter";
      sse(response, events);
    });

    const result = await probeBackendCompatibility(request("openai-responses", backend.url, "gpt-5"), dependencies);

    expect(result.failure?.code).toBe("malformed-response");
  });

  it("verifies an Anthropic Messages stream stopped at max_tokens with a dated snapshot", async () => {
    const backend = await server((_body, response) => {
      sse(response, anthropicStream("claude-opus-4-1-20250805"));
    });

    const result = await probeBackendCompatibility(
      request("anthropic-messages", backend.url, "claude-opus-4-1"),
      dependencies,
    );

    expect(result).toMatchObject({ failure: null, protocolVerified: true, modelVerified: true });
    expect(result.capabilities.find(({ id }) => id === "usage")?.state).toBe("verified");
  });

  it("gives the tool check and its continuation their own time budgets", async () => {
    const realistic = realisticOpenAi("gpt-5");
    const backend = await server(async (body, response) => {
      await delayed(150);
      await realistic(body, response);
    });

    const result = await probeBackendCompatibility(request("openai-responses", backend.url, "gpt-5"), {
      ...dependencies,
      stageTimeoutMs: 400,
    });

    expect(result.failure).toBeNull();
    expect(result.capabilities.find(({ id }) => id === "tools")?.state).toBe("verified");
  });

  it("keeps a text result when only the tool stage runs out of time", async () => {
    const realistic = realisticOpenAi("gpt-5");
    const backend = await server(async (body, response) => {
      if (toolChallenge(body)) await delayed(1_000);
      await realistic(body, response);
    });
    const started = Date.now();

    const result = await probeBackendCompatibility(request("openai-responses", backend.url, "gpt-5"), {
      ...dependencies,
      stageTimeoutMs: 200,
    });

    expect(Date.now() - started).toBeLessThan(900);
    expect(result).toMatchObject({ failure: null, modelVerified: true });
    expect(result.capabilities.find(({ id }) => id === "tools")?.state).not.toBe("verified");
  });

  it("reports a timeout when the text stage runs out of time", async () => {
    const backend = await server(async (body, response) => {
      await delayed(1_000);
      await realisticOpenAi("gpt-5")(body, response);
    });

    const result = await probeBackendCompatibility(request("openai-responses", backend.url, "gpt-5"), {
      ...dependencies,
      stageTimeoutMs: 200,
    });

    expect(result.failure?.code).toBe("timeout");
  });
});
