import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import {
  providerHostToolAccepted,
  type ProviderHostToolCall,
  type ProviderHostToolDefinition,
} from "../../src/server/provider/contracts";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import {
  AGENT_BROWSER_TOOL_DEFINITIONS,
  AGENT_BROWSER_TOOL_NAMES,
  AgentBrowserHostTools,
  RETIRED_AGENT_BROWSER_TOOL_DEFINITIONS,
} from "../../src/server/runtime/agent-browser-host-tools";
import { createInertiaHarnessCapabilities } from "../../src/server/runtime/inertia-harness-capabilities";
import type { Conversation } from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const tabId = "22222222-2222-4222-8222-222222222222";
const identity = {
  conversationId,
  runId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
};
const state = {
  activeTabId: tabId,
  tabs: [{ id: tabId, title: "Local page", url: "http://127.0.0.1:3000", loading: false }],
  activity: null,
};

function call(tool: string, args: unknown): ProviderHostToolCall {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: crypto.randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => "approve" as const),
  };
}

function schemaProperties(definition: ProviderHostToolDefinition): string[] {
  return Object.keys((definition.inputSchema.properties ?? {}) as Record<string, unknown>).sort();
}

function schemaRequired(definition: ProviderHostToolDefinition): string[] {
  return [...((definition.inputSchema.required ?? []) as string[])].sort();
}

function registry() {
  return createInertiaHarnessCapabilities({
    orchestrationTools: [],
    browserEnabled: true,
    invoke: async (_context, toolCall) => ({ success: true, text: toolCall.tool }),
  });
}

describe("agent browser tool contract", () => {
  it("advertises one flat object schema per action with its exact required arguments", () => {
    expect(AGENT_BROWSER_TOOL_DEFINITIONS.map((definition) => [
      definition.name,
      schemaRequired(definition),
      definition.readOnly,
    ])).toEqual([
      ["inertia_browser_navigate", ["url"], false],
      ["inertia_browser_snapshot", [], true],
      ["inertia_browser_click", ["ref"], false],
      ["inertia_browser_type", ["ref", "text"], false],
      ["inertia_browser_press", ["key"], false],
      ["inertia_browser_scroll", ["deltaY"], false],
      ["inertia_browser_wait_for", [], true],
      ["inertia_browser_screenshot", [], true],
      ["inertia_browser_tabs", [], true],
      ["inertia_browser_open_tab", [], false],
      ["inertia_browser_select_tab", ["tabId"], false],
      ["inertia_browser_close_tab", ["tabId"], false],
    ]);
    for (const definition of AGENT_BROWSER_TOOL_DEFINITIONS) {
      expect(definition.inputSchema, definition.name).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(JSON.stringify(definition.inputSchema), definition.name)
        .not.toMatch(/"(?:oneOf|anyOf|allOf)"/u);
    }
  });

  it("keeps each advertised schema and its runtime validator describing the same arguments", () => {
    for (const definition of AGENT_BROWSER_TOOL_DEFINITIONS) {
      expect(definition.inputValidator, definition.name).toBeInstanceOf(z.ZodObject);
      const derived = z.toJSONSchema(definition.inputValidator!, { io: "input" }) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(derived.properties ?? {}).sort(), definition.name)
        .toEqual(schemaProperties(definition));
      expect([...(derived.required ?? [])].sort(), definition.name)
        .toEqual(schemaRequired(definition));
    }
  });

  it("shows Claude every argument through its real in-process MCP server", async () => {
    const bridge = registry().bridgeFor({ conversation: {}, turn: {} } as never);
    const runtime = new ProviderHostToolRuntime({
      bridge,
      conversationId: "claude-parent",
      turnId: "claude-turn",
      cwd: "/project",
      onApproval: () => undefined,
      onApprovalResolved: () => undefined,
    });
    const tools = createClaudeHostTools(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inertia-schema-test", version: "1.0.0" });
    await tools.config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      expect([...listed.keys()].sort())
        .toEqual(AGENT_BROWSER_TOOL_DEFINITIONS.map(({ name }) => name).sort());
      for (const definition of AGENT_BROWSER_TOOL_DEFINITIONS) {
        const advertised = listed.get(definition.name)!.inputSchema;
        expect(Object.keys(advertised.properties ?? {}).sort(), definition.name)
          .toEqual(schemaProperties(definition));
        expect([...(advertised.required ?? [])].sort(), definition.name)
          .toEqual(schemaRequired(definition));
      }
      await expect(client.callTool({
        name: "inertia_browser_click",
        arguments: { ref: "e1" },
      })).resolves.toMatchObject({ content: [{ type: "text", text: "inertia_browser_click" }] });
      await expect(client.callTool({ name: "inertia_browser_click", arguments: {} }))
        .resolves.toMatchObject({ isError: true });
    } finally {
      await tools.close();
      await client.close().catch(() => undefined);
    }
  });

  it("keeps retired tools callable for sessions that registered them without advertising them", async () => {
    const capabilities = registry();
    const bridge = capabilities.bridgeFor({ conversation: {}, turn: {} } as never);
    const advertised = bridge.definitions.map(({ name }) => name);
    expect(RETIRED_AGENT_BROWSER_TOOL_DEFINITIONS.map(({ name }) => name))
      .toEqual(["inertia_browser_interact"]);
    expect(advertised).not.toContain("inertia_browser_interact");
    expect(capabilities.manifest().packs.flatMap(({ toolNames }) => toolNames))
      .not.toContain("inertia_browser_interact");
    expect(AGENT_BROWSER_TOOL_NAMES.has("inertia_browser_interact")).toBe(true);
    expect(providerHostToolAccepted(bridge, "inertia_browser_interact")).toBe(true);
    expect(providerHostToolAccepted(bridge, "inertia_browser_click")).toBe(true);
    expect(providerHostToolAccepted(bridge, "inertia_browser_evaluate")).toBe(false);
    await expect(bridge.invoke(call("inertia_browser_interact", { action: "click", ref: "e1" })))
      .resolves.toEqual({ success: true, text: "inertia_browser_interact" });

    const runtime = new ProviderHostToolRuntime({
      bridge,
      conversationId: "codex-thread",
      turnId: "codex-turn",
      cwd: "/project",
      onApproval: () => undefined,
      onApprovalResolved: () => undefined,
    });
    await expect(runtime.invoke({
      callId: "retired-call",
      tool: "inertia_browser_interact",
      arguments: { action: "press", key: "Enter" },
    })).resolves.toEqual({ success: true, text: "inertia_browser_interact" });
    await expect(runtime.invoke({
      callId: "unknown-call",
      tool: "inertia_browser_evaluate",
      arguments: {},
    })).resolves.toMatchObject({ success: false });
  });

  it("tells every provider to navigate first and to follow failure messages", () => {
    const [instruction] = registry().instructions()
      .filter(({ label }) => label === "inertia-frontend-workbench");
    expect(instruction?.text).toContain("inertia_browser_navigate before anything else");
    expect(instruction?.text).toContain("whether or not its panel is showing");
    expect(instruction?.text).toContain("its message says what to do next");
    expect(instruction?.text).not.toContain("inertia_browser_interact");
  });

  it.each([
    ["inertia_browser_navigate", { url: "http://localhost:3000" }, { action: "navigate", url: "http://localhost:3000" }],
    ["inertia_browser_click", { ref: "e1" }, { action: "click", ref: "e1" }],
    ["inertia_browser_type", { ref: "e2", text: "hello" }, { action: "type", ref: "e2", text: "hello", replace: true }],
    ["inertia_browser_type", { ref: "e2", text: "", replace: false }, { action: "type", ref: "e2", text: "", replace: false }],
    ["inertia_browser_press", { key: "Enter" }, { action: "press", key: "Enter" }],
    ["inertia_browser_scroll", { deltaY: -300 }, { action: "scroll", deltaY: -300 }],
    ["inertia_browser_wait_for", {}, { action: "wait", state: "present", timeoutMs: 10_000 }],
    ["inertia_browser_wait_for", { text: "  Saved  ", state: "absent", timeoutMs: 250 }, { action: "wait", text: "Saved", state: "absent", timeoutMs: 250 }],
    ["inertia_browser_tabs", {}, { action: "tabs" }],
    ["inertia_browser_open_tab", {}, { action: "tab-open" }],
    ["inertia_browser_open_tab", { url: "http://localhost:3000" }, { action: "tab-open", url: "http://localhost:3000" }],
    ["inertia_browser_select_tab", { tabId }, { action: "tab-activate", tabId }],
    ["inertia_browser_close_tab", { tabId }, { action: "tab-close", tabId }],
    ["inertia_browser_interact", { action: "scroll", deltaY: 400 }, { action: "scroll", deltaY: 400 }],
    ["inertia_browser_interact", { action: "type", ref: "e3", text: "a" }, { action: "type", ref: "e3", text: "a", replace: true }],
    ["inertia_browser_tabs", { action: "list" }, { action: "tabs" }],
    ["inertia_browser_tabs", { action: "open" }, { action: "tab-open" }],
    ["inertia_browser_tabs", { action: "activate", tabId }, { action: "tab-activate", tabId }],
    ["inertia_browser_tabs", { action: "close", tabId }, { action: "tab-close", tabId }],
  ])("maps %s %j to one exact Browser command", async (tool, args, command) => {
    const broker = { perform: vi.fn(async () => ({ ok: true as const, text: JSON.stringify(state), state })) };
    const request = call(tool, args);
    await expect(new AgentBrowserHostTools(broker)
      .invoke({ id: conversationId, accessMode: "full" } as Conversation, request, identity))
      .resolves.toMatchObject({ success: true });
    expect(broker.perform).toHaveBeenCalledExactlyOnceWith(identity, command, request.signal);
  });

  it.each([
    ["inertia_browser_click", {}],
    ["inertia_browser_click", { ref: "e1", extra: true }],
    ["inertia_browser_type", { ref: "e1" }],
    ["inertia_browser_press", { key: "F5" }],
    ["inertia_browser_scroll", { deltaY: 0 }],
    ["inertia_browser_wait_for", { timeoutMs: 60_000 }],
    ["inertia_browser_wait_for", { text: "   " }],
    ["inertia_browser_select_tab", { tabId: "not-a-tab" }],
    ["inertia_browser_interact", { action: "click" }],
    ["inertia_browser_tabs", { action: "activate" }],
    ["inertia_browser_snapshot", { selector: "body" }],
  ])("explains rejected arguments for %s %j without reaching the Browser", async (tool, args) => {
    const broker = { perform: vi.fn() };
    const result = await new AgentBrowserHostTools(broker)
      .invoke({ id: conversationId, accessMode: "full" } as Conversation, call(tool, args), identity);
    expect(result.success).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      error: {
        code: "invalid",
        message: expect.stringContaining("Check the tool's input schema"),
      },
    });
    expect(broker.perform).not.toHaveBeenCalled();
  });

  it("returns the tab state with every successful result and names the tab a snapshot describes", async () => {
    const texts: Record<string, string> = {
      inertia_browser_press: JSON.stringify({ pressed: "Enter" }),
      inertia_browser_navigate: JSON.stringify(state),
      inertia_browser_click: JSON.stringify({ clicked: "e1", state }),
      inertia_browser_screenshot: "captured",
    };
    const results: Record<string, unknown> = {};
    for (const [tool, text] of Object.entries(texts)) {
      const broker = { perform: vi.fn(async () => ({ ok: true as const, text, state })) };
      const args = tool === "inertia_browser_press" ? { key: "Enter" }
        : tool === "inertia_browser_navigate" ? { url: "http://localhost:3000" }
          : tool === "inertia_browser_click" ? { ref: "e1" } : {};
      const result = await new AgentBrowserHostTools(broker)
        .invoke({ id: conversationId, accessMode: "full" } as Conversation, call(tool, args), identity);
      results[tool] = result.text;
    }
    expect(JSON.parse(String(results.inertia_browser_press))).toEqual({ pressed: "Enter", state });
    expect(results.inertia_browser_navigate).toBe(texts.inertia_browser_navigate);
    expect(results.inertia_browser_click).toBe(texts.inertia_browser_click);
    expect(results.inertia_browser_screenshot).toBe("captured");

    const page = { title: "Local app", url: "http://127.0.0.1:3000", viewport: {}, text: "Hi", elements: [], truncated: false };
    const snapshotBroker = { perform: vi.fn(async () => ({ ok: true as const, text: JSON.stringify(page), state })) };
    const snapshot = await new AgentBrowserHostTools(snapshotBroker)
      .invoke({ id: conversationId, accessMode: "full" } as Conversation, call("inertia_browser_snapshot", {}), identity);
    expect(JSON.parse(snapshot.text)).toMatchObject({ tabId, title: "Local app", inertiaAudit: { version: 1 } });

    const blank = { blank: true, nextStep: "Navigate first." };
    const blankBroker = { perform: vi.fn(async () => ({ ok: true as const, text: JSON.stringify(blank), state })) };
    const blankSnapshot = await new AgentBrowserHostTools(blankBroker)
      .invoke({ id: conversationId, accessMode: "full" } as Conversation, call("inertia_browser_snapshot", {}), identity);
    expect(blankSnapshot.success).toBe(true);
    expect(JSON.parse(blankSnapshot.text)).toEqual({ ...blank, state });
  });

  it("asks for approval only for actions that change the page or its tabs", async () => {
    const approvalsByTool: Record<string, number> = {};
    for (const [tool, args] of [
      ["inertia_browser_snapshot", {}],
      ["inertia_browser_screenshot", {}],
      ["inertia_browser_tabs", {}],
      ["inertia_browser_wait_for", { text: "Saved" }],
      ["inertia_browser_navigate", { url: "http://localhost:3000" }],
      ["inertia_browser_click", { ref: "e1" }],
      ["inertia_browser_type", { ref: "e1", text: "a" }],
      ["inertia_browser_press", { key: "Tab" }],
      ["inertia_browser_scroll", { deltaY: 100 }],
      ["inertia_browser_open_tab", {}],
      ["inertia_browser_select_tab", { tabId }],
      ["inertia_browser_close_tab", { tabId }],
    ] as const) {
      const token = crypto.randomUUID();
      const broker = { perform: vi.fn(async (_identity: unknown, request: { action: string }) => ({
        ok: true as const,
        text: request.action === "prepare-approval" ? JSON.stringify({ token, detail: "Browser tab 1" }) : JSON.stringify(state),
        state,
      })) };
      const request = call(tool, args);
      await new AgentBrowserHostTools(broker as never)
        .invoke({ id: conversationId, accessMode: "supervised" } as Conversation, request, identity);
      approvalsByTool[tool] = (request.requestApproval as ReturnType<typeof vi.fn>).mock.calls.length;
    }
    expect(approvalsByTool).toEqual({
      inertia_browser_snapshot: 0,
      inertia_browser_screenshot: 0,
      inertia_browser_tabs: 0,
      inertia_browser_wait_for: 0,
      inertia_browser_navigate: 1,
      inertia_browser_click: 1,
      inertia_browser_type: 1,
      inertia_browser_press: 1,
      inertia_browser_scroll: 1,
      inertia_browser_open_tab: 1,
      inertia_browser_select_tab: 1,
      inertia_browser_close_tab: 1,
    });
  });
});
