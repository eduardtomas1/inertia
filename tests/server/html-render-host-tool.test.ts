// @inertia-test-suite portable
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge, ProviderHostToolCall } from "../../src/server/provider/contracts";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import {
  HTML_RENDER_RESULT_MESSAGE,
  HTML_RENDER_TOOL_DEFINITION,
  HtmlRenderHostTool,
} from "../../src/server/runtime/html-render-host-tool";
import { createInertiaHarnessCapabilities } from "../../src/server/runtime/inertia-harness-capabilities";
import { HtmlRenderTurnInactiveError } from "../../src/server/persistence/html-render-repository";
import type { AgentTurn, ChatMessage, Conversation, RuntimeMutationEvent } from "../../src/shared/contracts";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";
import {
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HTML_BYTES,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
  htmlRenderPlaceholderText,
  isHtmlRenderTitle,
} from "../../src/shared/html-render";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

type Schema = Record<string, unknown>;

const roots: string[] = [];
const PAGE = "<!doctype html><html><head><title>t</title></head><body><svg width=\"10\" height=\"10\"></svg></body></html>";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function call(args: unknown, signal: AbortSignal = new AbortController().signal): ProviderHostToolCall {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: "tool-render",
    tool: HTML_RENDER_TOOL_NAME,
    arguments: args,
    signal,
    requestApproval: vi.fn(async () => "approve" as const),
  };
}

function error(text: string): { code: string; message: string } {
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), "inertia-html-render-tool-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
  const project = store.createProject("Visual replies", workspace);
  const conversation = store.createConversation(project.id, "Charts", {
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
  });
  const turn = store.beginAgentTurn({
    conversationId: conversation.id,
    runId: "run-render",
    content: "Chart the benchmark.",
    providerId: "claude",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    interactionMode: "plan",
    accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
  const broadcast = vi.fn<(event: RuntimeMutationEvent) => void>();
  const manager = new AgentThreadManager({
    store,
    providers: {} as never,
    backendProfileController: {} as never,
    creation: {} as never,
    turns: {} as never,
    providerTerminalResumes: {} as never,
    contextRequests: { cancelForTurn: vi.fn() } as never,
    providerInfo: () => [],
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast,
  });
  const settle = (status: "completed" | "cancelled") => {
    const now = new Date().toISOString();
    store.settleAgentTurn(turn.id, {
      status,
      terminalAssistantMessageId: null,
      providerSessionAfter: null,
      terminalReason: status === "completed" ? "provider-completed" : "user-cancelled",
      checkpointId: null,
      usageAtCompletion: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
  };
  const renderCount = () => (store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } })
    .database.prepare("SELECT COUNT(*) AS count FROM html_renders").get().count;
  return { store, conversation, turn, broadcast, manager, settle, renderCount, bridge: manager.bridgeFor({ conversation, turn }) };
}

describe("inertia_render_html definition", () => {
  it("is a read-only, non-destructive tool whose description carries the shared guidance", () => {
    expect(HTML_RENDER_TOOL_DEFINITION).toMatchObject({ name: "inertia_render_html", readOnly: true, destructive: false });
    expect(HTML_RENDER_TOOL_DEFINITION.description).toContain(HTML_RENDER_LAYOUT_GUIDE);
    expect(HTML_RENDER_TOOL_DEFINITION.description).toContain(HTML_RENDER_THEME_GUIDE);
    expect(HTML_RENDER_TOOL_DEFINITION.description).toContain("call it before writing that reply");
    expect(HTML_RENDER_TOOL_DEFINITION.description.length).toBeLessThanOrEqual(2_000);
    expect(HTML_RENDER_TOOL_DEFINITION.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["html", "title"],
      properties: {
        html: { type: "string", minLength: 1, maxLength: 262_144 },
        title: { type: "string", minLength: 1, maxLength: 120 },
        height: { type: "integer", minimum: 80, maximum: 2_000, default: 360 },
      },
    });
  });

  it("is composed as the always-on inertia.visual-replies pack without private instructions", () => {
    for (const browserEnabled of [false, true]) {
      const registry = createInertiaHarnessCapabilities({
        orchestrationTools: [],
        browserEnabled,
        invoke: async () => ({ success: true, text: "" }),
      });
      expect(registry.manifest().packs.find(({ id }) => id === "inertia.visual-replies")).toEqual({
        id: "inertia.visual-replies",
        revision: 1,
        title: "Inertia visual replies",
        summary: expect.any(String),
        toolNames: ["inertia_render_html"],
        evaluation: expect.objectContaining({ evidenceKinds: ["host-tool-result"] }),
      });
      expect(registry.instructions().map(({ label }) => label)).not.toContain("inertia-visual-replies");
      expect(registry.bridgeFor({ conversation: {}, turn: {} } as never).definitions.map(({ name }) => name))
        .toContain("inertia_render_html");
    }
  });
});

const KNOWN_MULTIBYTE = "html:é*262144";

function htmlCandidates(): Array<[string, string]> {
  return [
    ["html:empty", ""],
    ["html:page", PAGE],
    ["html:max", "x".repeat(HTML_RENDER_MAX_HTML_BYTES)],
    ["html:over", "x".repeat(HTML_RENDER_MAX_HTML_BYTES + 1)],
    [KNOWN_MULTIBYTE, "é".repeat(HTML_RENDER_MAX_HTML_BYTES)],
  ];
}

const TITLES = [
  "", " ", " ", "﻿", "a", " padded ", "a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb",
  "x".repeat(120), "x".repeat(121), "\u{1F600}".repeat(120), "\u{1F600}".repeat(121), "Über chart",
];
const HEIGHTS: unknown[] = [undefined, 79, 80, 360, 2_000, 2_001, 80.5, "360", -0];

function inputs(): Array<[string, Record<string, unknown>]> {
  const result: Array<[string, Record<string, unknown>]> = [];
  for (const [label, html] of htmlCandidates()) result.push([label, { html, title: "Chart" }]);
  for (const title of TITLES) result.push([`title:${JSON.stringify(title).slice(0, 40)}`, { html: PAGE, title }]);
  for (const height of HEIGHTS) {
    result.push([`height:${String(height)}`, height === undefined ? { html: PAGE, title: "Chart" } : { html: PAGE, title: "Chart", height }]);
  }
  result.push(["extra", { html: PAGE, title: "Chart", theme: "dark" }]);
  result.push(["missing-title", { html: PAGE }]);
  return result;
}

function fakeHandler() {
  const created: Array<{ title: string; html: string; height: number }> = [];
  const tool = new HtmlRenderHostTool({
    store: {
      htmlRenders: {
        create: (input: { title: string; html: string; height: number }) => {
          created.push(input);
          return { renderId: "6f9619ff-8b86-4d01-b42d-00c04fc964ff", message: {} as ChatMessage };
        },
      },
    } as never,
    broadcast: vi.fn(),
  });
  return { tool, created };
}

const SOURCE = {
  conversation: { id: "11111111-1111-4111-8111-111111111111" } as Conversation,
  turn: { id: "turn", runId: "run" } as AgentTurn,
};

function divergences(schema: Schema): string[] {
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  const { tool, created } = fakeHandler();
  const found: string[] = [];
  for (const [label, input] of inputs()) {
    if (!validate(input).valid) continue;
    if (!HTML_RENDER_TOOL_DEFINITION.inputValidator!.safeParse(input).success) {
      found.push(label);
      continue;
    }
    created.length = 0;
    const result = tool.invoke(SOURCE, call(input));
    if (!result.success || created.length !== 1 || !isHtmlRenderTitle(created[0]!.title)) found.push(`main ${label}`);
  }
  return found;
}

function bridgeRuntime(): ProviderHostToolRuntime {
  const { tool } = fakeHandler();
  const bridge: ProviderHostToolBridge = {
    definitions: [HTML_RENDER_TOOL_DEFINITION],
    invoke: async (toolCall) => tool.invoke(SOURCE, toolCall),
  };
  return new ProviderHostToolRuntime({
    bridge, conversationId: "thread", turnId: "turn", cwd: "/project",
    onApproval: () => undefined, onApprovalResolved: () => undefined,
  });
}

describe("every schema-valid render input is accepted by the runtime and by the handler", () => {
  it("raw definition (also sent verbatim to Codex thread/start dynamicTools)", () => {
    expect(divergences(HTML_RENDER_TOOL_DEFINITION.inputSchema as Schema)).toEqual([KNOWN_MULTIBYTE]);
  });

  it("Claude SDK tools/list override and in-process call", async () => {
    const tools = createClaudeHostTools(bridgeRuntime());
    const client = new Client({ name: "inertia-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = (await client.listTools()).tools.find(({ name }) => name === HTML_RENDER_TOOL_NAME)!;
      expect(listed.inputSchema).toEqual(HTML_RENDER_TOOL_DEFINITION.inputSchema);
      expect(listed.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(divergences(listed.inputSchema as Schema)).toEqual([KNOWN_MULTIBYTE]);
      const result = await client.callTool({ name: HTML_RENDER_TOOL_NAME, arguments: { html: PAGE, title: "Chart" } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ rendered: true, title: "Chart" });
    } finally {
      await tools.close();
      await client.close();
    }
  });

  it("HTTP bridge providerMcpTools", async () => {
    const session = createProviderHostToolMcpSession(bridgeRuntime());
    try {
      const connection = await session.start();
      const response = await fetch(connection.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const listed = ListToolsResultSchema.parse(((await response.json()) as { result: unknown }).result)
        .tools.find(({ name }) => name === HTML_RENDER_TOOL_NAME)!;
      expect(listed.inputSchema).toEqual(HTML_RENDER_TOOL_DEFINITION.inputSchema);
      expect(divergences(listed.inputSchema as Schema)).toEqual([KNOWN_MULTIBYTE]);
    } finally {
      await session.close();
    }
  });
});

describe("inertia_render_html handler", () => {
  it("stores the page and its system message, broadcasts it, and tells the model not to describe it", async () => {
    const { store, conversation, turn, broadcast, bridge } = await runtime();
    try {
      const result = await bridge.invoke(call({ html: PAGE, title: "  Benchmark chart ", height: 420 }));
      expect(result.success).toBe(true);
      const body = JSON.parse(result.text) as Record<string, unknown>;
      expect(body).toEqual({
        rendered: true,
        renderId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        title: "Benchmark chart",
        message: HTML_RENDER_RESULT_MESSAGE,
      });
      expect(HTML_RENDER_RESULT_MESSAGE).toBe(
        "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
      );
      expect(store.htmlRenders.read(body.renderId as string)).toEqual({
        conversationId: conversation.id, title: "Benchmark chart", html: PAGE,
      });
      const message = store.conversationDetail(conversation.id)!.messages.find(({ htmlRender }) => htmlRender)!;
      expect(message).toMatchObject({
        role: "system",
        turnId: turn.id,
        content: htmlRenderPlaceholderText("Benchmark chart"),
        htmlRender: { renderId: body.renderId, title: "Benchmark chart", height: 420 },
      });
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith({ type: "conversation.message.persisted", message });
      expect(chatMessageSchema(message)).toBe(true);
      expect(result.text).not.toContain(PAGE);
    } finally {
      store.close();
    }
  });

  it("uses the default height and still succeeds when the broadcast fails", async () => {
    const { store, conversation, broadcast, bridge } = await runtime();
    try {
      broadcast.mockImplementation(() => { throw new Error("socket closed"); });
      const result = await bridge.invoke(call({ html: PAGE, title: "Chart" }));
      expect(result.success).toBe(true);
      expect(store.conversationDetail(conversation.id)!.messages.find(({ htmlRender }) => htmlRender)?.htmlRender?.height)
        .toBe(360);
    } finally {
      store.close();
    }
  });

  it("rejects invalid arguments without storing anything or echoing the page", async () => {
    const { store, broadcast, bridge, renderCount } = await runtime();
    try {
      for (const args of [
        undefined,
        "page",
        { html: PAGE },
        { html: "", title: "Chart" },
        { html: PAGE, title: "two\nlines" },
        { html: PAGE, title: "   " },
        { html: PAGE, title: "x".repeat(121) },
        { html: PAGE, title: "Chart", height: 79 },
        { html: PAGE, title: "Chart", height: 360.5 },
        { html: PAGE, title: "Chart", script: "alert(1)" },
      ]) {
        const result = await bridge.invoke(call(args));
        expect(result.success, JSON.stringify(args)).toBe(false);
        expect(error(result.text).code, JSON.stringify(args)).toBe("invalid_arguments");
        expect(result.text).not.toContain("<svg");
      }
      expect(renderCount()).toBe(0);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("rejects a page over the byte limit, counting UTF-8 bytes", async () => {
    const { store, bridge, renderCount } = await runtime();
    try {
      for (const html of ["x".repeat(HTML_RENDER_MAX_HTML_BYTES + 1), "é".repeat(HTML_RENDER_MAX_HTML_BYTES / 2 + 1)]) {
        const result = await bridge.invoke(call({ html, title: "Too big" }));
        expect(result.success).toBe(false);
        expect(error(result.text)).toEqual({ code: "html_too_large", message: expect.stringContaining("262144 UTF-8 bytes") });
      }
      expect((await bridge.invoke(call({ html: "x".repeat(HTML_RENDER_MAX_HTML_BYTES), title: "Exactly max" }))).success)
        .toBe(true);
      expect(renderCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it("refuses a call whose source turn already settled", async () => {
    const { store, bridge, settle, renderCount } = await runtime();
    try {
      settle("cancelled");
      const result = await bridge.invoke(call({ html: PAGE, title: "Late" }));
      expect(result.success).toBe(false);
      expect(error(result.text)).toEqual({ code: "host_tool_failed", message: "The originating Inertia turn is no longer active." });
      expect(renderCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("reports turn_not_active when the turn settles between dispatch and storage", async () => {
    const { store, conversation, turn, settle, renderCount } = await runtime();
    try {
      const tool = new HtmlRenderHostTool({ store, broadcast: vi.fn() });
      settle("completed");
      const result = tool.invoke({ conversation, turn }, call({ html: PAGE, title: "Late" }));
      expect(result.success).toBe(false);
      expect(error(result.text)).toEqual({ code: "turn_not_active", message: new HtmlRenderTurnInactiveError().message });
      expect(renderCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("refuses a source identity that does not own the turn", async () => {
    const { store, manager, turn, renderCount } = await runtime();
    try {
      const forged = { ...turn, runId: "forged-run" };
      const result = await manager.bridgeFor({ conversation: store.conversation(turn.conversationId), turn: forged })
        .invoke(call({ html: PAGE, title: "Forged" }));
      expect(result.success).toBe(false);
      expect(error(result.text).code).toBe("host_tool_failed");
      expect(renderCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it("does not store a page for a cancelled call", async () => {
    const { store, conversation, turn, bridge, broadcast, renderCount } = await runtime();
    try {
      const controller = new AbortController();
      controller.abort();
      const viaBridge = await bridge.invoke(call({ html: PAGE, title: "Cancelled" }, controller.signal));
      expect(error(viaBridge.text).code).toBe("call_cancelled");
      const direct = new HtmlRenderHostTool({ store, broadcast }).invoke({ conversation, turn }, call({ html: PAGE, title: "Cancelled" }, controller.signal));
      expect(direct.success).toBe(false);
      expect(error(direct.text).code).toBe("call_cancelled");
      expect(renderCount()).toBe(0);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("reports a storage failure without leaking its detail", async () => {
    const broadcast = vi.fn();
    const tool = new HtmlRenderHostTool({
      store: { htmlRenders: { create: () => { throw new Error("SQLITE_FULL: /secret/path/inertia.sqlite"); } } } as never,
      broadcast,
    });
    const result = tool.invoke(SOURCE, call({ html: PAGE, title: "Chart" }));
    expect(result.success).toBe(false);
    expect(error(result.text)).toEqual({ code: "render_not_saved", message: expect.any(String) });
    expect(result.text).not.toContain("/secret/path");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
