import { spawn } from "node:child_process";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  ProviderHostToolBridge,
  ProviderHostToolCall,
} from "../../src/server/provider/contracts";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import {
  acpHostMcpServers,
  openCodeHostMcpConfig,
} from "../../src/server/provider/host-tool-mcp-config";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import type { AgentApprovalRequest } from "../../src/server/provider/interactions";

const sessions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
});

function bridge(
  invoke?: (call: ProviderHostToolCall) => ReturnType<ProviderHostToolBridge["invoke"]>,
): ProviderHostToolBridge {
  return {
    definitions: [
      {
        name: "inertia_list_conversations",
        description: "List chats.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer", minimum: 1, maximum: 25 } },
        },
        inputValidator: z.object({ limit: z.number().int().min(1).max(25).optional() }).strict(),
        readOnly: true,
      },
      {
        name: "inertia_create_conversation",
        description: "Create a chat after approval.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string", maxLength: 120 } },
          required: ["title"],
        },
        inputValidator: z.object({ title: z.string().max(120) }).strict(),
        readOnly: false,
      },
    ],
    invoke: invoke ?? (async (call) => {
      if (call.tool === "inertia_create_conversation") {
        const decision = await call.requestApproval({
          title: "Create chat",
          detail: "Create one independent chat.",
          reason: "The agent requested it.",
          permissionRoots: [],
        });
        if (decision !== "approve") return { success: false, text: decision };
      }
      return { success: true, text: JSON.stringify({ ok: true }) };
    }),
  };
}

function runtime(input: {
  invoke?: (call: ProviderHostToolCall) => ReturnType<ProviderHostToolBridge["invoke"]>;
  approvalTimeoutMs?: number;
} = {}) {
  const approvals: AgentApprovalRequest[] = [];
  const resolved: Array<[string, string]> = [];
  const owner = new ProviderHostToolRuntime({
    bridge: bridge(input.invoke),
    conversationId: "conversation-parent",
    turnId: "turn-parent",
    cwd: "/project",
    onApproval: (request) => approvals.push(request),
    onApprovalResolved: (requestId, decision) => resolved.push([requestId, decision]),
    approvalTimeoutMs: input.approvalTimeoutMs,
  });
  return { approvals, owner, resolved };
}

async function started(input: Parameters<typeof runtime>[0] = {}) {
  const state = runtime(input);
  const session = createProviderHostToolMcpSession(state.owner);
  sessions.push(session);
  const connection = await session.start();
  const post = async (body: unknown, token = connection.bearerToken) => await fetch(
    connection.url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return { ...state, connection, post, session };
}

function paddedCall(id: number, bytes: number) {
  const body = {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "inertia_list_conversations", arguments: { padding: "" } },
  };
  body.params.arguments.padding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(body), "utf8"));
  expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBe(bytes);
  return body;
}

const BODY_LIMIT = 6 * 256 * 1024 + 64 * 1024;
const WORST_CASE_PAGE = "\u0001".repeat(256 * 1024);

function stdioProxy(connection: Awaited<ReturnType<typeof started>>["connection"]) {
  const fallback = acpHostMcpServers(connection, false)[0]!;
  if (!("command" in fallback)) throw new Error("Expected the shared ACP stdio fallback.");
  const child = spawn(fallback.command, fallback.args, {
    env: {
      ...process.env,
      ...Object.fromEntries(fallback.env.map(({ name, value }) => [name, value])),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  return {
    child,
    closed,
    responses: () => stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Condition was not observed.");
}

describe("provider host-tool MCP transport", () => {
  it("returns host-owned images through the shared Cursor, Kimi, and OpenCode transport", async () => {
    const image = Buffer.from("png-evidence").toString("base64");
    const photo = Buffer.from("gif-evidence").toString("base64");
    const { post } = await started({
      invoke: async () => ({
        success: true,
        text: "captured",
        images: [{ mimeType: "image/png", data: image }, { mimeType: "image/gif", data: photo }],
      }),
    });
    const response = await post({
      jsonrpc: "2.0",
      id: "browser-image",
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: {} },
    });
    expect(await response.json()).toMatchObject({
      id: "browser-image",
      result: {
        content: [
          { type: "text", text: "captured" },
          { type: "image", mimeType: "image/png", data: image },
          { type: "image", mimeType: "image/gif", data: photo },
        ],
      },
    });
  });

  it("refuses host images beyond the per-result count, byte, and type bounds", async () => {
    const small = Buffer.from("png-evidence").toString("base64");
    const cases = [
      Array.from({ length: 5 }, () => ({ mimeType: "image/png" as const, data: small })),
      [
        { mimeType: "image/png" as const, data: Buffer.alloc(3 * 1024 * 1024, 1).toString("base64") },
        { mimeType: "image/png" as const, data: Buffer.alloc(1024 * 1024 + 1, 1).toString("base64") },
      ],
      [{ mimeType: "image/svg+xml" as "image/png", data: small }],
    ];
    for (const images of cases) {
      const { post } = await started({ invoke: async () => ({ success: true, text: "captured", images }) });
      const body = await (await post({
        jsonrpc: "2.0",
        id: "bounded-images",
        method: "tools/call",
        params: { name: "inertia_list_conversations", arguments: {} },
      })).json() as { result: { content: Array<{ type: string; text?: string }>; isError?: boolean } };
      expect(body.result.isError).toBe(true);
      expect(body.result.content).toEqual([
        { type: "text", text: expect.stringContaining("returned invalid images") },
      ]);
    }
  });

  it("negotiates Cursor HTTP with an owned stdio fallback and isolates OpenCode config", () => {
    const connection = {
      url: "http://127.0.0.1:41234/mcp",
      bearerToken: "run-secret-token",
    };
    expect(acpHostMcpServers(connection, true)).toEqual([{
      type: "http",
      name: "inertia-chat-manager",
      url: connection.url,
      headers: [{ name: "Authorization", value: `Bearer ${connection.bearerToken}` }],
    }]);
    const fallback = acpHostMcpServers(connection, false)[0]!;
    expect(fallback).toMatchObject({
      name: "inertia-chat-manager",
      command: process.execPath,
    });
    expect("args" in fallback ? fallback.args.join(" ") : "").not.toContain(connection.bearerToken);
    expect("args" in fallback ? fallback.args.join(" ") : "").not.toContain(connection.url);
    expect(fallback).toMatchObject({
      env: expect.arrayContaining([
        { name: "INERTIA_HOST_MCP_URL", value: connection.url },
        { name: "INERTIA_HOST_MCP_TOKEN", value: connection.bearerToken },
      ]),
    });
    expect(openCodeHostMcpConfig(connection)).toEqual({
      type: "remote",
      url: connection.url,
      enabled: true,
      headers: { Authorization: `Bearer ${connection.bearerToken}` },
      oauth: false,
      // Covers the Browser broker's 20 second request deadline and the main
      // process's longest 30 second navigation settlement window.
      timeout: 30_000,
    });
  });

  it("authenticates one run and publishes bounded read/mutation annotations", async () => {
    const { connection, post } = await started();
    const unauthorized = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong");
    expect(unauthorized.status).toBe(401);
    const unauthorizedText = await unauthorized.text();
    expect(unauthorizedText).not.toContain(connection.bearerToken);
    expect(unauthorizedText).not.toContain(connection.url);

    const initialized = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(await initialized.json()).toMatchObject({
      id: 2,
      result: { protocolVersion: "2025-06-18" },
    });
    const listed = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(await listed.json()).toMatchObject({
      result: {
        tools: [
          { name: "inertia_list_conversations", annotations: { readOnlyHint: true } },
          { name: "inertia_create_conversation", annotations: { readOnlyHint: false } },
        ],
      },
    });
  });

  it("closes and drains rejected HTTP requests before another request is admitted", async () => {
    const { connection, post } = await started();
    const rejected = await Promise.all([
      post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong"),
      fetch(connection.url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${connection.bearerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
      fetch(connection.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.bearerToken}`,
          "Content-Type": "text/plain",
        },
        body: "rejected body",
      }),
    ]);
    expect(rejected.map((response) => response.status)).toEqual([401, 405, 415]);
    expect(rejected.every((response) => response.headers.get("connection") === "close"))
      .toBe(true);
    expect(await (await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })).json()).toMatchObject({ id: 3, result: { tools: expect.any(Array) } });
  });

  it("routes one mutating call through exactly one host-owned approval", async () => {
    const { approvals, owner, post, resolved } = await started();
    const response = post({
      jsonrpc: "2.0",
      id: "mutation-1",
      method: "tools/call",
      params: { name: "inertia_create_conversation", arguments: { title: "Verifier" } },
    });
    await waitFor(() => approvals.length === 1);
    expect(approvals[0]?.requestId).toMatch(/^inertia-host-tool:/u);
    expect(approvals[0]?.requestId).not.toContain("mutation-1");
    expect(owner.respondToApproval(approvals[0]!.requestId, "approve")).toBe(true);
    expect(await (await response).json()).toMatchObject({
      id: "mutation-1",
      result: { content: [{ text: JSON.stringify({ ok: true }) }] },
    });
    expect(approvals).toHaveLength(1);
    expect(resolved).toEqual([[approvals[0]!.requestId, "approve"]]);
  });

  it("fails closed when a tools/call JSON-RPC id is reused later in the run", async () => {
    const { post } = await started();
    const call = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: {} },
    };
    expect(await (await post(call)).json()).toMatchObject({
      id: 7,
      result: { content: [{ text: JSON.stringify({ ok: true }) }] },
    });
    expect(await (await post(call)).json()).toMatchObject({
      id: 7,
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("reused") }],
      },
    });
  });

  it("revokes late calls and aborts in-flight work before closing the endpoint", async () => {
    let observedSignal: AbortSignal | undefined;
    const { connection, post, session } = await started({
      invoke: async (call) => {
        observedSignal = call.signal;
        await new Promise<void>((resolve) => {
          if (call.signal.aborted) resolve();
          else call.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { success: false, text: "late secret result" };
      },
    });
    const inFlight = post({
      jsonrpc: "2.0",
      id: "slow",
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: {} },
    }).catch(() => null);
    await waitFor(() => observedSignal !== undefined);
    const cancelledClose = session.close();
    const terminalClose = session.close();
    expect(terminalClose).toBe(cancelledClose);
    await terminalClose;
    expect(observedSignal?.aborted).toBe(true);
    await inFlight;
    await expect(fetch(connection.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    })).rejects.toThrow();
  });

  it("bounds request bodies at six times a maximum page plus 64 KiB and closes an oversized keep-alive request", async () => {
    const received: number[] = [];
    const { post } = await started({
      invoke: async (call) => {
        received.push(((call.arguments as { padding: string }).padding).length);
        return { success: true, text: "ok" };
      },
    });
    const accepted = await post(paddedCall(10, BODY_LIMIT));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ id: 10, result: { content: [{ type: "text", text: "ok" }] } });
    expect(received).toHaveLength(1);

    const response = await post(paddedCall(11, BODY_LIMIT + 1));
    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toMatchObject({ error: { message: "MCP request body exceeds the 1600 KiB limit." } });
    expect(received).toHaveLength(1);
  });

  it("accepts a maximum page that every JSON encoder escapes to six times its size", async () => {
    let received = "";
    const { connection, post } = await started({
      invoke: async (call) => {
        received = (call.arguments as { padding: string }).padding;
        return { success: true, text: "rendered" };
      },
    });
    const call = (id: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: { padding: WORST_CASE_PAGE } },
    });
    const line = JSON.stringify(call("stdio-worst"));
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(6 * 256 * 1024);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(BODY_LIMIT);

    const http = await post(call("http-worst"));
    expect(http.status).toBe(200);
    expect(received).toBe(WORST_CASE_PAGE);
    received = "";

    const proxy = stdioProxy(connection);
    proxy.child.stdin.end(`${line}\n`);
    const [code] = await proxy.closed;
    expect(code).toBe(0);
    expect(proxy.responses()).toEqual([
      expect.objectContaining({ id: "stdio-worst", result: { content: [{ type: "text", text: "rendered" }] } }),
    ]);
    expect(received).toBe(WORST_CASE_PAGE);
  });

  it("fails only an over-bound stdio request, whichever end carries its id, and keeps serving the run's other calls", async () => {
    const { connection } = await started();
    const proxy = stdioProxy(connection);
    const idFirst = JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: { padding: "x".repeat(BODY_LIMIT) } },
    });
    const idLast = JSON.stringify({
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: { padding: "x".repeat(BODY_LIMIT), id: 7 } },
      jsonrpc: "2.0",
      id: "sdk-order",
    });
    const idLastWhole = idLast.replace("\"sdk-order\"", "43");
    const half = Math.floor(idFirst.length / 2);
    proxy.child.stdin.write(idFirst.slice(0, half));
    proxy.child.stdin.write(`${idFirst.slice(half)}\n${idLast.slice(0, half)}`);
    proxy.child.stdin.write(idLast.slice(half, -5));
    proxy.child.stdin.write(`${idLast.slice(-5)}\n${idLastWhole}\n`);
    proxy.child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: "after", method: "tools/list" })}\n`);
    const [code] = await proxy.closed;
    expect(code).toBe(0);
    const responses = proxy.responses();
    expect(responses).toHaveLength(4);
    const limit = { code: -32600, message: "MCP request body exceeds the 1600 KiB limit." };
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: 41, error: limit });
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: "sdk-order", error: limit });
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: 43, error: limit });
    expect(responses).toContainEqual(expect.objectContaining({ id: "after", result: { tools: expect.any(Array) } }));
  });

  it("carries a maximum visual-reply page through Cursor and Kimi's stdio fallback", async () => {
    const unit = "<div class=\"cell\">é</div>\n";
    const page = unit.repeat(Math.floor(256 * 1024 / Buffer.byteLength(unit, "utf8")));
    expect(Buffer.byteLength(page, "utf8")).toBeLessThanOrEqual(256 * 1024);
    let received = "";
    const { connection } = await started({
      invoke: async (call) => {
        received = (call.arguments as { padding: string }).padding;
        return { success: true, text: "rendered" };
      },
    });
    const fallback = acpHostMcpServers(connection, false)[0]!;
    if (!("command" in fallback)) throw new Error("Expected the shared ACP stdio fallback.");
    const child = spawn(fallback.command, fallback.args, {
      env: {
        ...process.env,
        ...Object.fromEntries(fallback.env.map(({ name, value }) => [name, value])),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "stdio-page",
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: { padding: page } },
    });
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(256 * 1024);
    child.stdin.end(`${line}\n`);
    const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      id: "stdio-page",
      result: { content: [{ type: "text", text: "rendered" }] },
    });
    expect(received).toBe(page);
  });

  it("lets Cursor's stdio proxy drain a valid in-flight request after stdin EOF", async () => {
    const { connection } = await started();
    const fallback = acpHostMcpServers(connection, false)[0]!;
    if (!("command" in fallback)) throw new Error("Expected Cursor's stdio fallback.");
    const child = spawn(fallback.command, fallback.args, {
      env: {
        ...process.env,
        ...Object.fromEntries(fallback.env.map(({ name, value }) => [name, value])),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "stdio-eof",
      method: "tools/list",
    })}\n`);
    const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      id: "stdio-eof",
      result: { tools: expect.any(Array) },
    });
  });

  it("carries bounded Browser PNG evidence through Cursor and Kimi's stdio fallback", async () => {
    const image = Buffer.alloc(96 * 1024, 0x5a).toString("base64");
    const { connection } = await started({
      invoke: async () => ({
        success: true,
        text: "captured",
        images: [{ mimeType: "image/png", data: image }],
      }),
    });
    const fallback = acpHostMcpServers(connection, false)[0]!;
    if (!("command" in fallback)) throw new Error("Expected the shared ACP stdio fallback.");
    const child = spawn(fallback.command, fallback.args, {
      env: {
        ...process.env,
        ...Object.fromEntries(fallback.env.map(({ name, value }) => [name, value])),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "stdio-image",
      method: "tools/call",
      params: { name: "inertia_list_conversations", arguments: {} },
    })}\n`);
    const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toMatchObject({
      id: "stdio-image",
      result: {
        content: [
          { type: "text", text: "captured" },
          { type: "image", mimeType: "image/png", data: image },
        ],
      },
    });
  });

  it("rejects batched screenshot calls before the ACP stdio response is constructed", async () => {
    const invoke = vi.fn(async () => ({
      success: true,
      text: "captured",
      images: [{
        mimeType: "image/png" as const,
        data: Buffer.alloc(4 * 1024 * 1024, 0x5a).toString("base64"),
      }],
    }));
    const { connection } = await started({ invoke });
    const fallback = acpHostMcpServers(connection, false)[0]!;
    if (!("command" in fallback)) throw new Error("Expected the shared ACP stdio fallback.");
    const child = spawn(fallback.command, fallback.args, {
      env: {
        ...process.env,
        ...Object.fromEntries(fallback.env.map(({ name, value }) => [name, value])),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stdin.end(`${JSON.stringify([
      {
        jsonrpc: "2.0",
        id: "stdio-image-a",
        method: "tools/call",
        params: { name: "inertia_list_conversations", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: "stdio-image-b",
        method: "tools/call",
        params: { name: "inertia_list_conversations", arguments: {} },
      },
    ])}\n`);
    const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual([
      {
        jsonrpc: "2.0",
        id: "stdio-image-a",
        error: {
          code: -32600,
          message: "Send batched tools/call requests as separate MCP messages.",
        },
      },
      {
        jsonrpc: "2.0",
        id: "stdio-image-b",
        error: {
          code: -32600,
          message: "Send batched tools/call requests as separate MCP messages.",
        },
      },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shares a concurrent close failure instead of falsely confirming cleanup", async () => {
    const { owner } = runtime();
    const session = createProviderHostToolMcpSession(owner, {
      closeServer: (server, settled) => {
        server.close(() => settled(new Error("fixture close failure")));
        server.closeAllConnections();
      },
    });
    sessions.push(session);
    await session.start();
    const cancelClose = session.close();
    const terminalClose = session.close();
    expect(terminalClose).toBe(cancelClose);
    await expect(cancelClose).rejects.toThrow("could not be confirmed closed");
    await expect(terminalClose).rejects.toThrow("could not be confirmed closed");
  });
});
