import type { ProviderHostToolRuntime } from "./host-tool-runtime";

const MCP_DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const MAX_MCP_BATCH_MESSAGES = 32;

type JsonRpcId = string | number;
type JsonRpcResponse = Record<string, unknown>;

type ParsedMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "response" }
  | { kind: "invalid"; id: JsonRpcId | null };

export interface ProviderMcpProtocolResult {
  status: number;
  body?: JsonRpcResponse | JsonRpcResponse[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function response(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(
  id: JsonRpcId | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parse(raw: unknown): ParsedMessage {
  const value = record(raw);
  if (!value || value.jsonrpc !== "2.0") return { kind: "invalid", id: null };
  const rawId = value.id;
  const id = typeof rawId === "string" || typeof rawId === "number"
    ? rawId
    : null;
  if (typeof value.method !== "string" || value.method.length < 1 || value.method.length > 128) {
    if ("result" in value || "error" in value) return { kind: "response" };
    return { kind: "invalid", id };
  }
  const params = record(value.params) ?? {};
  if (rawId === undefined) {
    return { kind: "notification", method: value.method, params };
  }
  if (id === null) return { kind: "invalid", id: null };
  return { kind: "request", id, method: value.method, params };
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function callId(id: JsonRpcId): string {
  return `mcp:${idKey(id)}`;
}

function initializeResult(requested: unknown): Record<string, unknown> {
  const protocolVersion = typeof requested === "string"
    && MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : MCP_DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: "inertia-chat-manager",
      title: "Inertia chat manager",
      version: "1.0.0",
    },
    instructions: "These tools manage bounded top-level Inertia chats in the current project. Mutating actions require an exact user approval in Inertia.",
  };
}

async function handleRequest(
  message: Extract<ParsedMessage, { kind: "request" }>,
  runtime: ProviderHostToolRuntime,
  signal: AbortSignal,
): Promise<JsonRpcResponse> {
  switch (message.method) {
    case "initialize":
      return response(message.id, initializeResult(message.params.protocolVersion));
    case "ping":
      return response(message.id, {});
    case "tools/list":
      return response(message.id, {
        tools: runtime.definitions().map(({ name, description, inputSchema, readOnly }) => ({
          name,
          description,
          inputSchema,
          annotations: {
            readOnlyHint: readOnly,
            destructiveHint: false,
            idempotentHint: readOnly,
            openWorldHint: false,
          },
        })),
      });
    case "tools/call": {
      const tool = message.params.name;
      const args = message.params.arguments;
      if (typeof tool !== "string" || tool.length < 1 || tool.length > 128) {
        return error(message.id, -32602, "Missing or invalid tool name.");
      }
      if (args !== undefined && record(args) === null) {
        return error(message.id, -32602, "Tool arguments must be an object.");
      }
      const result = await runtime.invoke({
        callId: callId(message.id),
        tool,
        arguments: args ?? {},
        signal,
      });
      return response(message.id, {
        content: [{ type: "text", text: result.text }],
        ...(result.success ? {} : { isError: true }),
      });
    }
    default:
      return error(message.id, -32601, `Method "${message.method}" is not supported.`);
  }
}

export async function handleProviderMcpBody(
  body: unknown,
  runtime: ProviderHostToolRuntime,
  signal: AbortSignal,
): Promise<ProviderMcpProtocolResult> {
  const rawMessages = Array.isArray(body) ? body : [body];
  if (rawMessages.length === 0 || rawMessages.length > MAX_MCP_BATCH_MESSAGES) {
    return {
      status: 400,
      body: error(null, -32600, rawMessages.length === 0
        ? "Empty JSON-RPC batch."
        : `JSON-RPC batches may contain at most ${MAX_MCP_BATCH_MESSAGES} messages.`),
    };
  }
  const messages = rawMessages.map(parse);
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "request") continue;
    const key = idKey(message.id);
    if (ids.has(key)) {
      return {
        status: 400,
        body: error(message.id, -32600, "Duplicate JSON-RPC request id in one batch."),
      };
    }
    ids.add(key);
  }

  const slots = messages.map((message) => {
    if (message.kind === "request") {
      return handleRequest(message, runtime, signal);
    }
    if (message.kind === "invalid") {
      return Promise.resolve(error(message.id, -32600, "Invalid JSON-RPC request."));
    }
    return null;
  });
  for (const message of messages) {
    if (
      message.kind === "notification"
      && message.method === "notifications/cancelled"
      && (typeof message.params.requestId === "string" || typeof message.params.requestId === "number")
    ) {
      runtime.cancelCall(callId(message.params.requestId));
    }
  }
  const settled = await Promise.all(slots.map(async (slot) => slot ? await slot : null));
  const responses = settled.filter((value): value is JsonRpcResponse => value !== null);
  if (responses.length === 0) return { status: 204 };
  return {
    status: 200,
    body: Array.isArray(body) ? responses : responses[0],
  };
}
