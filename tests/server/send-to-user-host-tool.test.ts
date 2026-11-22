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
import { SentToUserTurnInactiveError } from "../../src/server/persistence/sent-to-user-repository";
import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge, ProviderHostToolCall } from "../../src/server/provider/contracts";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { createInertiaHarnessCapabilities } from "../../src/server/runtime/inertia-harness-capabilities";
import {
  SEND_TO_USER_RESULT_MESSAGE,
  SEND_TO_USER_TOOL_DEFINITION,
  SendToUserHostTool,
} from "../../src/server/runtime/send-to-user-host-tool";
import type { AgentTurn, ChatMessage, Conversation, RuntimeMutationEvent } from "../../src/shared/contracts";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  SEND_TO_USER_MAX_LENGTH,
  SEND_TO_USER_MAX_PER_TURN,
  SEND_TO_USER_TOOL_NAME,
  isSendToUserContent,
} from "../../src/shared/send-to-user";

type Schema = Record<string, unknown>;

const roots: string[] = [];
const DRAFT = "## Release note\n\n- Exports keep UTF-8.\n\n```ts\nwrite(file, \"utf8\");\n```";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function call(args: unknown, signal: AbortSignal = new AbortController().signal): ProviderHostToolCall {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: "tool-send",
    tool: SEND_TO_USER_TOOL_NAME,
    arguments: args,
    signal,
    requestApproval: vi.fn(async () => "approve" as const),
  };
}

function error(text: string): { code: string; message: string } {
  return (JSON.parse(text) as { error: { code: string; message: string } }).error;
}

async function runtime(options: { secret?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "inertia-send-to-user-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const databasePath = join(root, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
  const project = store.createProject("Messages", workspace);
  const conversation = store.createConversation(project.id, "Release notes", {
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
  });
  const turn = store.beginAgentTurn({
    conversationId: conversation.id,
    runId: "run-send",
    content: "Draft the release note, then ask me before publishing.",
    providerId: "claude",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    // Plan mode and supervised access: the tool writes only the caller's own turn.
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
    ...(options.secret
      ? {
          agentSecrets: {
            containsSecret: (value: unknown) => JSON.stringify(value).includes(options.secret!),
            invoke: vi.fn(),
          },
        }
      : {}),
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
  const sent = (target = store) => target.conversationDetail(conversation.id)!.messages.filter(({ sentToUser }) => sentToUser);
  return {
    store, databasePath, workspace, conversation, turn, broadcast, manager, settle, sent,
    bridge: manager.bridgeFor({ conversation, turn }),
  };
}

describe("inertia_send_to_user definition", () => {
  it("is a read-only, non-destructive, non-idempotent tool that Claude always loads", () => {
    expect(SEND_TO_USER_TOOL_DEFINITION).toMatchObject({
      name: "inertia_send_to_user",
      readOnly: true,
      destructive: false,
      idempotent: false,
      alwaysLoad: true,
    });
    expect(SEND_TO_USER_TOOL_DEFINITION.description).toBe(
      "Show the user a Markdown message in this chat, exactly as written, before your turn ends. Use it for content the user must read in full mid-turn, such as a draft, a code block, or what a question you are about to ask refers to. Don't repeat it in your reply.",
    );
    expect(SEND_TO_USER_TOOL_DEFINITION.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          pattern: "^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$",
          description: "Markdown, shown verbatim.",
        },
      },
      required: ["message"],
    });
    expect(SEND_TO_USER_RESULT_MESSAGE).toBe("Shown to the user. Don't repeat it in your reply.");
  });

  it("is offered with inertia_render_html in inertia.visual-replies revision 3, whatever the Browser setting", () => {
    for (const browserEnabled of [false, true]) {
      const registry = createInertiaHarnessCapabilities({
        orchestrationTools: [],
        browserEnabled,
        invoke: async () => ({ success: true, text: "" }),
      });
      expect(registry.manifest().packs.find(({ id }) => id === "inertia.visual-replies")).toMatchObject({
        revision: 3,
        toolNames: ["inertia_render_html", "inertia_send_to_user"],
      });
      expect(registry.instructions().map(({ label }) => label)).not.toContain("inertia-visual-replies");
      expect(registry.bridgeFor({ conversation: {}, turn: {} } as never).definitions.map(({ name }) => name))
        .toEqual(expect.arrayContaining(["inertia_render_html", "inertia_send_to_user"]));
    }
  });
});

const ASTRAL = "\u{1F600}";
const MESSAGES: Array<[string, string]> = [
  ["empty", ""],
  ["space", " "],
  ["blank-lines", "\n\n\t "],
  ["nbsp", " "],
  ["bom", "﻿"],
  ["nul", "a\u0000b"],
  ["nul-only", "\u0000"],
  ["one", "a"],
  ["padded", "  keep my spacing  "],
  ["markdown", DRAFT],
  ["raw-html", "<script>alert(1)</script> *hi*"],
  ["max", "x".repeat(SEND_TO_USER_MAX_LENGTH)],
  ["over", "x".repeat(SEND_TO_USER_MAX_LENGTH + 1)],
  ["astral-max", ASTRAL.repeat(SEND_TO_USER_MAX_LENGTH)],
  ["astral-over", ASTRAL.repeat(SEND_TO_USER_MAX_LENGTH + 1)],
];

function inputs(): Array<[string, unknown]> {
  return [
    ...MESSAGES.map(([label, message]): [string, unknown] => [label, { message }]),
    ["extra", { message: "hi", title: "Note" }],
    ["missing", {}],
    ["number", { message: 4 }],
  ];
}

function fakeHandler() {
  const created: Array<{ content: string }> = [];
  const tool = new SendToUserHostTool({
    store: {
      sentToUser: {
        create: (input: { content: string }) => {
          created.push(input);
          return { id: "message" } as ChatMessage;
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

/** Inputs the advertised schema accepts but the runtime or the handler refuses. */
function divergences(schema: Schema): string[] {
  const validate = new AjvJsonSchemaValidator().getValidator(schema);
  const { tool, created } = fakeHandler();
  const found: string[] = [];
  for (const [label, input] of inputs()) {
    const advertised = validate(input).valid;
    const accepted = SEND_TO_USER_TOOL_DEFINITION.inputValidator!.safeParse(input).success;
    if (advertised !== accepted) found.push(`${advertised ? "schema-only" : "runtime-only"} ${label}`);
    if (!accepted) continue;
    created.length = 0;
    const result = tool.invoke(SOURCE, call(input));
    if (!result.success || created.length !== 1 || !isSendToUserContent(created[0]!.content)) found.push(`handler ${label}`);
  }
  return found;
}

function bridgeRuntime(): ProviderHostToolRuntime {
  const { tool } = fakeHandler();
  const bridge: ProviderHostToolBridge = {
    definitions: [SEND_TO_USER_TOOL_DEFINITION],
    invoke: async (toolCall) => tool.invoke(SOURCE, toolCall),
  };
  return new ProviderHostToolRuntime({
    bridge, conversationId: "thread", turnId: "turn", cwd: "/project",
    onApproval: () => undefined, onApprovalResolved: () => undefined,
  });
}

describe("the advertised schema and the runtime accept exactly the same messages", () => {
  it("counts the length in code points, like JSON Schema, and refuses blank or NUL-bearing text", () => {
    const accepted = (message: string) => SEND_TO_USER_TOOL_DEFINITION.inputValidator!.safeParse({ message }).success;
    expect(accepted(ASTRAL.repeat(SEND_TO_USER_MAX_LENGTH))).toBe(true);
    expect(ASTRAL.repeat(SEND_TO_USER_MAX_LENGTH).length).toBe(2 * SEND_TO_USER_MAX_LENGTH);
    expect(accepted(ASTRAL.repeat(SEND_TO_USER_MAX_LENGTH + 1))).toBe(false);
    expect(accepted("x".repeat(SEND_TO_USER_MAX_LENGTH + 1))).toBe(false);
    for (const blank of ["", " ", "\n\t", " ", "﻿", "\u0000", "a\u0000"]) expect(accepted(blank), JSON.stringify(blank)).toBe(false);
  });

  it("raw definition (also sent verbatim to Codex thread/start dynamicTools)", () => {
    expect(divergences(SEND_TO_USER_TOOL_DEFINITION.inputSchema as Schema)).toEqual([]);
  });

  it("Claude SDK tools/list carries the alwaysLoad meta, and an in-process call shows the message", async () => {
    const tools = createClaudeHostTools(bridgeRuntime());
    const client = new Client({ name: "inertia-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = (await client.listTools()).tools.find(({ name }) => name === SEND_TO_USER_TOOL_NAME)!;
      expect(listed.inputSchema).toEqual(SEND_TO_USER_TOOL_DEFINITION.inputSchema);
      expect(listed.annotations).toEqual({
        readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      });
      expect(listed._meta).toEqual({ "anthropic/alwaysLoad": true });
      expect(divergences(listed.inputSchema as Schema)).toEqual([]);
      const result = await client.callTool({ name: SEND_TO_USER_TOOL_NAME, arguments: { message: DRAFT } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
        sent: true, message: SEND_TO_USER_RESULT_MESSAGE,
      });
    } finally {
      await tools.close();
      await client.close();
    }
  });

  it("HTTP bridge tools/list, without the Claude-only meta", async () => {
    const session = createProviderHostToolMcpSession(bridgeRuntime());
    try {
      const connection = await session.start();
      const response = await fetch(connection.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const listed = ListToolsResultSchema.parse(((await response.json()) as { result: unknown }).result)
        .tools.find(({ name }) => name === SEND_TO_USER_TOOL_NAME)!;
      expect(listed.inputSchema).toEqual(SEND_TO_USER_TOOL_DEFINITION.inputSchema);
      expect(listed).not.toHaveProperty("_meta");
      expect(divergences(listed.inputSchema as Schema)).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe("inertia_send_to_user handler", () => {
  it("stores the Markdown verbatim as a turn-scoped system message, broadcasts it, and tells the model not to repeat it", async () => {
    const { store, conversation, turn, broadcast, bridge, sent } = await runtime();
    try {
      const message = `  ${DRAFT}\n`;
      const result = await bridge.invoke(call({ message }));
      expect(result).toEqual({ success: true, text: JSON.stringify({ sent: true, message: SEND_TO_USER_RESULT_MESSAGE }) });
      const [stored] = sent();
      expect(stored).toEqual({
        id: expect.any(String),
        conversationId: conversation.id,
        turnId: turn.id,
        role: "system",
        content: message,
        attachments: [],
        createdAt: expect.any(String),
        sentToUser: true,
      });
      expect(chatMessageSchema(stored)).toBe(true);
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith({ type: "conversation.message.persisted", message: stored });
      // The message is not the turn's reply.
      expect(store.agentTurn(turn.id).terminalAssistantMessageId).toBeNull();
      expect(store.conversationDetail(conversation.id)!.messages.filter(({ role }) => role === "assistant")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps the message across a restart", async () => {
    const { store, databasePath, workspace, bridge, sent } = await runtime();
    expect((await bridge.invoke(call({ message: DRAFT }))).success).toBe(true);
    const before = sent();
    store.close();
    const reopened = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
    try {
      expect(sent(reopened)).toEqual(before);
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ content: DRAFT, sentToUser: true });
    } finally {
      reopened.close();
    }
  });

  it("still succeeds when the broadcast fails", async () => {
    const { store, broadcast, bridge, sent } = await runtime();
    try {
      broadcast.mockImplementation(() => { throw new Error("socket closed"); });
      expect((await bridge.invoke(call({ message: "Saved anyway." }))).success).toBe(true);
      expect(sent().map(({ content }) => content)).toEqual(["Saved anyway."]);
    } finally {
      store.close();
    }
  });

  it("rejects invalid arguments field by field, without storing or broadcasting anything", async () => {
    const { store, broadcast, bridge, sent } = await runtime();
    try {
      const cases: Array<[unknown, string]> = [
        [{}, "message: required"],
        [{ message: 7 }, "message: expected string"],
        [{ message: "" }, "message: must not be empty"],
        [{ message: " \n\t" }, "message: must not be only whitespace"],
        [{ message: "a\u0000b" }, "message: must not contain NUL characters"],
        [{ message: "x".repeat(SEND_TO_USER_MAX_LENGTH + 1) }, `message: at most ${SEND_TO_USER_MAX_LENGTH} characters`],
        [{ message: "hi", title: "Note" }, "\"title\": unknown field; accepted: message"],
      ];
      for (const [args, line] of cases) {
        const result = await bridge.invoke(call(args));
        expect(result.success, JSON.stringify(args)).toBe(false);
        expect(error(result.text), JSON.stringify(args)).toEqual({
          code: "invalid_arguments",
          message: `${line}\nFix it and call inertia_send_to_user again.`,
        });
      }
      expect(sent()).toEqual([]);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("refuses a call whose source turn already settled", async () => {
    const { store, bridge, settle, sent } = await runtime();
    try {
      settle("cancelled");
      const result = await bridge.invoke(call({ message: "Too late." }));
      expect(error(result.text)).toEqual({ code: "host_tool_failed", message: "The originating Inertia turn is no longer active." });
      expect(sent()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("reports turn_not_active when the turn settles between dispatch and storage", async () => {
    const { store, conversation, turn, settle, broadcast, sent } = await runtime();
    try {
      const tool = new SendToUserHostTool({ store, broadcast });
      settle("completed");
      const result = tool.invoke({ conversation, turn }, call({ message: "Too late." }));
      expect(error(result.text)).toEqual({ code: "turn_not_active", message: new SentToUserTurnInactiveError().message });
      expect(sent()).toEqual([]);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it(`reports message_limit_reached once the turn showed ${SEND_TO_USER_MAX_PER_TURN} messages`, async () => {
    const { store, bridge, broadcast, sent } = await runtime();
    try {
      expect(SEND_TO_USER_MAX_PER_TURN).toBe(20);
      for (let index = 1; index <= SEND_TO_USER_MAX_PER_TURN; index += 1) {
        expect((await bridge.invoke(call({ message: `Step ${index}` }))).success).toBe(true);
      }
      broadcast.mockClear();
      const result = await bridge.invoke(call({ message: "One too many" }));
      expect(JSON.parse(result.text)).toEqual({
        error: {
          code: "message_limit_reached",
          message: "This turn already showed its maximum of 20 messages to the user. Put anything else in your written reply.",
        },
      });
      expect(sent()).toHaveLength(SEND_TO_USER_MAX_PER_TURN);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("does not store a message for a cancelled call", async () => {
    const { store, conversation, turn, bridge, broadcast, sent } = await runtime();
    try {
      const controller = new AbortController();
      controller.abort();
      expect(error((await bridge.invoke(call({ message: "Cancelled." }, controller.signal))).text).code).toBe("call_cancelled");
      const direct = new SendToUserHostTool({ store, broadcast })
        .invoke({ conversation, turn }, call({ message: "Cancelled." }, controller.signal));
      expect(error(direct.text)).toEqual({
        code: "call_cancelled",
        message: "The message was not shown because the call was cancelled.",
      });
      expect(sent()).toEqual([]);
      expect(broadcast).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("refuses a message that contains a secret the user gave the agent", async () => {
    const { store, bridge, sent } = await runtime({ secret: "sk-live-7f3a9" });
    try {
      const result = await bridge.invoke(call({ message: "Your key is sk-live-7f3a9." }));
      expect(error(result.text).code).toBe("secret_value_not_allowed");
      expect(sent()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("refuses a source identity that does not own the turn", async () => {
    const { store, manager, turn, sent } = await runtime();
    try {
      const forged = { ...turn, runId: "forged-run" };
      const result = await manager.bridgeFor({ conversation: store.conversation(turn.conversationId), turn: forged })
        .invoke(call({ message: "Forged." }));
      expect(error(result.text).code).toBe("host_tool_failed");
      expect(sent()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("reports a storage failure without leaking its detail", () => {
    const broadcast = vi.fn();
    const tool = new SendToUserHostTool({
      store: { sentToUser: { create: () => { throw new Error("SQLITE_FULL: /secret/path/inertia.sqlite"); } } } as never,
      broadcast,
    });
    const result = tool.invoke(SOURCE, call({ message: "Hello." }));
    expect(error(result.text)).toEqual({
      code: "message_not_saved",
      message: "Inertia could not save the message. Put it in your written reply instead.",
    });
    expect(result.text).not.toContain("/secret/path");
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("stored messages to the user", () => {
  it("are written only as turn-scoped system messages with valid Markdown", async () => {
    const { store, conversation, turn } = await runtime();
    try {
      const create = (role: ChatMessage["role"], turnId: string | null, content = "Draft") =>
        () => store.createMessage(conversation.id, content, role, [], turnId, undefined, { sentToUser: true });
      expect(create("assistant", turn.id)).toThrow("Invalid message to the user.");
      expect(create("user", null)).toThrow("Invalid message to the user.");
      expect(create("system", null)).toThrow("Invalid message to the user.");
      expect(create("system", turn.id, " ")).toThrow("Invalid message to the user.");
      expect(create("system", turn.id, "x".repeat(SEND_TO_USER_MAX_LENGTH + 1))).toThrow("Invalid message to the user.");
      expect(() => store.sentToUser.create({
        conversationId: conversation.id, runId: turn.runId, turnId: turn.id, content: "",
      })).toThrow("Invalid message to the user.");
      expect(() => store.sentToUser.create({
        conversationId: conversation.id, runId: "other-run", turnId: turn.id, content: "Draft",
      })).toThrow();
      expect(store.conversationDetail(conversation.id)!.messages.filter(({ role }) => role === "system")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("are refused by the message schema unless system-role and turn-scoped", () => {
    const base = {
      id: "m", conversationId: "c", turnId: "t", role: "system", content: "Draft", attachments: [], createdAt: "2030-01-01T00:00:00.000Z",
    };
    expect(chatMessageSchema({ ...base, sentToUser: true })).toBe(true);
    expect(chatMessageSchema({ ...base, sentToUser: false })).toBe(false);
    expect(chatMessageSchema({ ...base, sentToUser: 1 })).toBe(false);
    expect(chatMessageSchema({ ...base, role: "assistant", sentToUser: true })).toBe(false);
    expect(chatMessageSchema({ ...base, turnId: null, sentToUser: true })).toBe(false);
    expect(chatMessageSchema({
      ...base, sentToUser: true, htmlRender: { renderId: "6f9619ff-8b86-4d01-b42d-00c04fc964ff", title: "Chart", height: 360 },
    })).toBe(false);
  });
});
