// @inertia-test-suite portable
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import { createOpenCodeHostTools } from "../../src/server/provider/opencode-host-tools";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import { APP_UNDER_TEST_TOOL_DEFINITIONS } from "../../src/server/runtime/app-under-test/host-tools";

const DESTRUCTIVE = new Set([
  "inertia_app_launch", "inertia_app_stop", "inertia_app_click",
  "inertia_app_type", "inertia_app_press", "inertia_app_scroll",
]);
const READ_ONLY = new Set([
  "inertia_app_status", "inertia_app_logs", "inertia_app_windows",
  "inertia_app_snapshot", "inertia_app_wait_for", "inertia_app_screenshot",
]);

function bridge(): ProviderHostToolBridge {
  return { definitions: APP_UNDER_TEST_TOOL_DEFINITIONS, invoke: async () => ({ success: true, text: "{}" }) };
}

function runtime(): ProviderHostToolRuntime {
  return new ProviderHostToolRuntime({
    bridge: bridge(), conversationId: "thread", turnId: "turn", cwd: "/project",
    onApproval: () => undefined, onApprovalResolved: () => undefined,
  });
}

function expected(name: string, destructiveHints: boolean) {
  return {
    readOnlyHint: READ_ONLY.has(name),
    destructiveHint: destructiveHints && DESTRUCTIVE.has(name),
    idempotentHint: READ_ONLY.has(name),
    openWorldHint: false,
  };
}

async function listed(url: string, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return ListToolsResultSchema.parse(((await response.json()) as { result: unknown }).result).tools;
}

describe("App under test tool annotations", () => {
  it("covers every tool as exactly one of read-only or destructive", () => {
    expect(APP_UNDER_TEST_TOOL_DEFINITIONS.map(({ name }) => name).sort())
      .toEqual([...DESTRUCTIVE, ...READ_ONLY].sort());
  });

  it("marks process and input tools destructive and inspection tools read-only for Claude", async () => {
    const tools = createClaudeHostTools(runtime());
    const client = new Client({ name: "annotation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools;
      expect(advertised).toHaveLength(APP_UNDER_TEST_TOOL_DEFINITIONS.length);
      for (const tool of advertised) expect(tool.annotations, tool.name).toEqual(expected(tool.name, true));
    } finally {
      await tools.close();
      await client.close();
    }
  });

  it("marks destructive tools on the HTTP bridge only when the transport opts in", async () => {
    for (const destructiveHints of [true, false]) {
      const session = createProviderHostToolMcpSession(runtime(), {}, { destructiveHints });
      try {
        const connection = await session.start();
        const tools = await listed(connection.url, { Authorization: `Bearer ${connection.bearerToken}` });
        expect(tools).toHaveLength(APP_UNDER_TEST_TOOL_DEFINITIONS.length);
        for (const tool of tools) expect(tool.annotations, tool.name).toEqual(expected(tool.name, destructiveHints));
      } finally {
        await session.close();
      }
    }
  });

  it("gives OpenCode destructive hints because its Inertia allow rule owns the prompt", async () => {
    const tools = createOpenCodeHostTools({
      bridge: bridge(), conversationId: "thread", turnId: "turn", cwd: "/project",
      onApproval: () => undefined, onApprovalResolved: () => undefined,
    })!;
    let config: { url: string; headers: Record<string, string> } | undefined;
    const client = { mcp: { add: async (request: { config: typeof config; name: string }) => {
      config = request.config;
      return { data: { [request.name]: { status: "connected" } } };
    } } };
    try {
      await tools.install(client as never, async (_label, operation) => await operation(new AbortController().signal));
      for (const tool of await listed(config!.url, config!.headers)) {
        expect(tool.annotations, tool.name).toEqual(expected(tool.name, true));
      }
    } finally {
      await tools.revoke();
    }
  });
});
