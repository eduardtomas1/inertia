// @inertia-test-suite portable
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it, vi } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import {
  AGENT_BROWSER_TOOL_DEFINITIONS,
  AgentBrowserHostTools,
} from "../../src/server/runtime/agent-browser-host-tools";

const tabId = "22222222-2222-4222-8222-222222222222";
const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
};
const cases: Array<{
  tool: string;
  args: Record<string, unknown> | null;
  valid: boolean;
  advertised?: boolean;
}> = [
  { tool: "snapshot", args: {}, valid: true },
  { tool: "screenshot", args: {}, valid: true },
  { tool: "snapshot", args: { extra: true }, valid: false },
  { tool: "navigate", args: { url: "http://localhost:3000/" }, valid: true },
  { tool: "navigate", args: {}, valid: false },
  { tool: "navigate", args: { url: "" }, valid: false },
  { tool: "navigate", args: { url: "http://localhost/\0" }, valid: false },
  { tool: "navigate", args: { url: "x".repeat(4_097) }, valid: false },
  { tool: "click", args: { ref: "r1" }, valid: true },
  { tool: "click", args: {}, valid: false },
  { tool: "click", args: { ref: "r1", text: "wrong action" }, valid: false },
  { tool: "click", args: { ref: "bad ref" }, valid: false },
  { tool: "click", args: { ref: "x".repeat(65) }, valid: false },
  { tool: "type", args: { ref: "r1", text: "" }, valid: true },
  { tool: "type", args: { ref: "r1", text: "hello", replace: false }, valid: true },
  { tool: "type", args: { ref: "r1" }, valid: false },
  { tool: "type", args: { ref: "r1", text: "\0" }, valid: false },
  { tool: "type", args: { ref: "r1", text: "x".repeat(4_001) }, valid: false },
  { tool: "press", args: { key: "Enter" }, valid: true },
  { tool: "press", args: {}, valid: false },
  { tool: "press", args: { key: "F1" }, valid: false },
  { tool: "scroll", args: { deltaY: -2_000 }, valid: true },
  { tool: "scroll", args: { deltaY: 2_000 }, valid: true },
  { tool: "scroll", args: {}, valid: false },
  { tool: "scroll", args: { deltaY: 0 }, valid: false, advertised: true },
  { tool: "scroll", args: { deltaY: 1.5 }, valid: false },
  { tool: "scroll", args: { deltaY: 2_001 }, valid: false },
  { tool: "scroll", args: { deltaY: -2_001 }, valid: false },
  { tool: "wait_for", args: {}, valid: true },
  { tool: "wait_for", args: { text: "Saved", state: "absent", timeoutMs: 250 }, valid: true },
  { tool: "wait_for", args: { text: "   " }, valid: false, advertised: true },
  { tool: "wait_for", args: { state: "gone" }, valid: false },
  { tool: "wait_for", args: { timeoutMs: 60_000 }, valid: false },
  { tool: "tabs", args: {}, valid: true },
  { tool: "tabs", args: { tabId }, valid: false },
  { tool: "tabs", args: null, valid: false },
  { tool: "open_tab", args: {}, valid: true },
  { tool: "open_tab", args: { url: "http://localhost:3000/" }, valid: true },
  { tool: "open_tab", args: { url: "" }, valid: false },
  { tool: "select_tab", args: { tabId }, valid: true },
  { tool: "select_tab", args: {}, valid: false },
  { tool: "close_tab", args: { tabId }, valid: true },
  { tool: "close_tab", args: { tabId: "not-a-uuid" }, valid: false },
];

function fixture() {
  const perform = vi.fn(async () => ({
    ok: true as const, text: "performed", state: { activeTabId: tabId, tabs: [], activity: null },
  }));
  const browser = new AgentBrowserHostTools({ perform });
  const conversation = { id: identity.conversationId, accessMode: "full" } as Conversation;
  const bridge: ProviderHostToolBridge = {
    definitions: AGENT_BROWSER_TOOL_DEFINITIONS,
    invoke: (call) => browser.invoke(conversation, call, identity),
  };
  const runtime = new ProviderHostToolRuntime({
    bridge, conversationId: "provider-thread", turnId: "provider-turn", cwd: "/project",
    onApproval: () => undefined, onApprovalResolved: () => undefined,
  });
  return { runtime, perform };
}

const INTERACTIONS = new Set(["click", "type", "press", "scroll"]);
const ROOT_COMBINATORS = new Set(["allOf", "anyOf", "oneOf", "not", "if", "then", "else"]);

function assertContract(schemas: ReadonlyMap<string, Record<string, unknown>>) {
  const json = new AjvJsonSchemaValidator();
  for (const { tool, args, valid, advertised = valid } of cases) {
    const name = `inertia_browser_${tool}`;
    const definition = AGENT_BROWSER_TOOL_DEFINITIONS.find((entry) => entry.name === name)!;
    const label = `${name}: ${JSON.stringify(args).slice(0, 150)}`;
    expect(definition.inputValidator!.safeParse(args).success, label).toBe(valid);
    const schema = schemas.get(name)!;
    expect(schema.type, name).toBe("object");
    expect(Object.keys(schema).filter((key) => ROOT_COMBINATORS.has(key)), name).toEqual([]);
    expect(json.getValidator(schema)(args).valid, label).toBe(advertised);
  }
}

describe("browser contracts received by providers", () => {
  it("advertises the same accepted actions and required fields as the runtime", () => {
    assertContract(new Map(AGENT_BROWSER_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema])));
  });

  it("lists the full contracts through Claude's real SDK and validates before execution", async () => {
    const { runtime, perform } = fixture();
    const tools = createClaudeHostTools(runtime);
    const client = new Client({ name: "browser-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      assertContract(new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema])));
      for (const { tool, args, valid } of cases.filter((entry) => INTERACTIONS.has(entry.tool))) {
        const result = await client.callTool({ name: `inertia_browser_${tool}`, arguments: args ?? {} });
        expect(result.isError === true, JSON.stringify(args).slice(0, 150)).toBe(!valid);
      }
      expect(perform).toHaveBeenCalledTimes(6);
      expect(perform).toHaveBeenCalledWith(identity,
        { action: "type", ref: "r1", text: "", replace: true }, expect.any(AbortSignal));
      expect(perform).toHaveBeenCalledWith(identity,
        { action: "type", ref: "r1", text: "hello", replace: false }, expect.any(AbortSignal));
    } finally {
      await tools.close();
      await client.close();
    }
  });

  it("lists the full contracts on the HTTP bridge used by ACP and OpenCode", async () => {
    const { runtime, perform } = fixture();
    const session = createProviderHostToolMcpSession(runtime);
    try {
      const connection = await session.start();
      let id = 0;
      const post = async (method: string, params?: Record<string, unknown>) => {
        const response = await fetch(connection.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${connection.bearerToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        expect(response.status).toBe(200);
        return await response.json() as { result: unknown };
      };
      const listed = ListToolsResultSchema.parse((await post("tools/list")).result);
      assertContract(new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema])));
      expect((await post("tools/call", {
        name: "inertia_browser_click", arguments: {},
      })).result).toMatchObject({ isError: true });
      expect(perform).not.toHaveBeenCalled();
      expect((await post("tools/call", {
        name: "inertia_browser_click", arguments: { ref: "r1" },
      })).result).toMatchObject({ content: [{ type: "text", text: "performed" }] });
      expect(perform).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });
});
