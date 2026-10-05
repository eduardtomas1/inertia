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
import { AGENT_BROWSER_TOOL_DEFINITIONS } from "../../src/server/runtime/agent-browser-host-tools";

const DESTRUCTIVE = new Set([
  "inertia_browser_navigate", "inertia_browser_click", "inertia_browser_type",
  "inertia_browser_press", "inertia_browser_open_tab", "inertia_browser_close_tab",
]);
const READ_ONLY = new Set([
  "inertia_browser_snapshot", "inertia_browser_screenshot", "inertia_browser_tabs", "inertia_browser_wait_for",
]);

type Annotations = Record<string, unknown> | undefined;

function runtime(): ProviderHostToolRuntime {
  const bridge: ProviderHostToolBridge = {
    definitions: AGENT_BROWSER_TOOL_DEFINITIONS,
    invoke: async () => ({ success: true, text: "{}" }),
  };
  return new ProviderHostToolRuntime({
    bridge, conversationId: "thread", turnId: "turn", cwd: "/project",
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

async function httpAnnotations(destructiveHints: boolean): Promise<Map<string, Annotations>> {
  const session = createProviderHostToolMcpSession(runtime(), {}, { destructiveHints });
  try {
    const connection = await session.start();
    const response = await fetch(connection.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.bearerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listed = ListToolsResultSchema.parse(((await response.json()) as { result: unknown }).result);
    return new Map(listed.tools.map((tool) => [tool.name, tool.annotations as Annotations]));
  } finally {
    await session.close();
  }
}

describe("Browser tool annotations", () => {
  it("marks page-changing tools destructive and inspection tools read-only for Claude", async () => {
    const tools = createClaudeHostTools(runtime());
    const client = new Client({ name: "annotation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = (await client.listTools()).tools;
      expect(listed).toHaveLength(AGENT_BROWSER_TOOL_DEFINITIONS.length);
      for (const tool of listed) expect(tool.annotations, tool.name).toEqual(expected(tool.name, true));
    } finally {
      await tools.close();
      await client.close();
    }
  });

  it("marks destructive tools on the HTTP bridge only when the transport opts in", async () => {
    for (const destructiveHints of [true, false]) {
      const annotations = await httpAnnotations(destructiveHints);
      expect(annotations.size).toBe(AGENT_BROWSER_TOOL_DEFINITIONS.length);
      for (const [name, value] of annotations) expect(value, name).toEqual(expected(name, destructiveHints));
    }
  });

  it("gives OpenCode destructive hints because its Inertia allow rule owns the prompt", async () => {
    const bridge: ProviderHostToolBridge = {
      definitions: AGENT_BROWSER_TOOL_DEFINITIONS,
      invoke: async () => ({ success: true, text: "{}" }),
    };
    const tools = createOpenCodeHostTools({
      bridge, conversationId: "thread", turnId: "turn", cwd: "/project",
      onApproval: () => undefined, onApprovalResolved: () => undefined,
    })!;
    let config: { url: string; headers: Record<string, string> } | undefined;
    const client = { mcp: { add: async (request: { config: typeof config; name: string }) => {
      config = request.config;
      return { data: { [request.name]: { status: "connected" } } };
    } } };
    try {
      await tools.install(client as never, async (_label, operation) => await operation(new AbortController().signal));
      const response = await fetch(config!.url, {
        method: "POST",
        headers: { ...config!.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const listed = ListToolsResultSchema.parse(((await response.json()) as { result: unknown }).result);
      for (const tool of listed.tools) expect(tool.annotations, tool.name).toEqual(expected(tool.name, true));
    } finally {
      await tools.revoke();
    }
  });
});
