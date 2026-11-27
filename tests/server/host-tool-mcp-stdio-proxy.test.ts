import { spawn } from "node:child_process";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ProviderHostToolBridge, ProviderHostToolCall } from "../../src/server/provider/contracts";
import { acpHostMcpServers } from "../../src/server/provider/host-tool-mcp-config";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import { SECRET_REQUEST_TOOL_NAME } from "../../src/node/agent-secrets";

const sessions: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
});

function createProxyHarness(
  invoke: (call: ProviderHostToolCall) => ReturnType<ProviderHostToolBridge["invoke"]>,
) {
  const bridge: ProviderHostToolBridge = {
    definitions: [
      {
        name: SECRET_REQUEST_TOOL_NAME,
        description: "Ask for a secret.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        inputValidator: z.object({}).strict(),
        readOnly: true,
      },
      {
        name: "inertia_list_conversations",
        description: "List chats.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        inputValidator: z.object({}).strict(),
        readOnly: true,
      },
    ],
    invoke,
  };
  const owner = new ProviderHostToolRuntime({
    bridge,
    conversationId: "conv-1",
    turnId: "turn-1",
    cwd: "/project",
    onApproval: () => undefined,
    onApprovalResolved: () => undefined,
  });
  const session = createProviderHostToolMcpSession(owner);
  sessions.push(session);
  return { session, owner };
}

function spawnStdioProxy(connection: { url: string; bearerToken: string }) {
  const [server] = acpHostMcpServers(connection, false, process.env);
  if (!server || !("command" in server)) throw new Error("Expected stdio proxy config.");
  const child = spawn(server.command, server.args, {
    env: {
      ...process.env,
      ...Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  return { child, lines, closed, source: server.args[2] ?? "" };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for stdio proxy condition.");
}

describe("ACP host-tool MCP stdio proxy concurrency and timeout", () => {
  it("uses node:http with setTimeout(0) instead of undici fetch", () => {
    const [server] = acpHostMcpServers(
      { url: "http://127.0.0.1:41234/mcp", bearerToken: "token" },
      false,
      process.env,
    );
    expect(server && "args" in server ? server.args[2] : "").toContain('require("node:http")');
    expect(server && "args" in server ? server.args[2] : "").toContain("req.setTimeout(0)");
    expect(server && "args" in server ? server.args[2] : "").not.toContain("fetch(");
  });

  it("forwards ping and notifications/cancelled immediately while inertia_request_secret is waiting", async () => {
    let secretStarted = false;
    let secretAborted = false;
    const { session } = createProxyHarness(async (call) => {
      if (call.tool === SECRET_REQUEST_TOOL_NAME) {
        secretStarted = true;
        await new Promise<void>((resolve) => {
          if (call.signal.aborted) {
            secretAborted = true;
            resolve();
            return;
          }
          call.signal.addEventListener("abort", () => {
            secretAborted = true;
            resolve();
          }, { once: true });
        });
        return { success: false, text: JSON.stringify({ status: "ended", reason: "cancelled" }) };
      }
      return { success: true, text: JSON.stringify({ ok: true }) };
    });
    const connection = await session.start();
    const proxy = spawnStdioProxy(connection);
    try {
      proxy.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "secret-1",
        method: "tools/call",
        params: { name: SECRET_REQUEST_TOOL_NAME, arguments: {} },
      })}\n`);
      await waitFor(() => secretStarted);

      // Ping must resolve immediately while the secret request is still blocked.
      proxy.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "ping-1", method: "ping" })}\n`);
      await waitFor(() => proxy.lines.some((line) => line.id === "ping-1"));
      expect(proxy.lines.find((line) => line.id === "ping-1")).toEqual({
        jsonrpc: "2.0",
        id: "ping-1",
        result: {},
      });
      expect(secretAborted).toBe(false);

      // Cancellation notification must also be forwarded immediately and abort the blocked call.
      proxy.child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "secret-1", reason: "user stopped" },
      })}\n`);
      await waitFor(() => secretAborted);
      await waitFor(() => proxy.lines.some((line) => line.id === "secret-1"));
      expect(proxy.lines.find((line) => line.id === "secret-1")).toMatchObject({
        jsonrpc: "2.0",
        id: "secret-1",
        result: { isError: true },
      });

      proxy.child.stdin.end();
      const [code] = await proxy.closed;
      expect(code).toBe(0);
    } finally {
      if (proxy.child.exitCode === null) proxy.child.kill();
    }
  });

  it("serializes stdout lines cleanly across concurrent in-flight calls and enforces MAX_QUEUE backpressure", async () => {
    const releases: Array<() => void> = [];
    const { session } = createProxyHarness(async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { success: true, text: JSON.stringify({ payload: "x".repeat(4_096) }) };
    });
    const connection = await session.start();
    const proxy = spawnStdioProxy(connection);
    try {
      for (let index = 0; index < 4; index += 1) {
        proxy.child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: `concurrent-${index}`,
          method: "tools/call",
          params: { name: "inertia_list_conversations", arguments: {} },
        })}\n`);
      }
      await waitFor(() => releases.length === 4);
      for (const release of releases.splice(0)) release();
      await waitFor(() => proxy.lines.length === 4);
      expect(proxy.lines.map((line) => line.id).sort()).toEqual([
        "concurrent-0",
        "concurrent-1",
        "concurrent-2",
        "concurrent-3",
      ]);

      proxy.child.stdin.end();
      const [code] = await proxy.closed;
      expect(code).toBe(0);
    } finally {
      if (proxy.child.exitCode === null) proxy.child.kill();
    }
  });
});
