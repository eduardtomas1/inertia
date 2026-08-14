import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type WebSocket from "ws";
import type {
  Options as ClaudeOptions,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ProviderInfo,
  ProviderId,
  ServerEvent,
  ThreadUsageSnapshot,
} from "../../src/shared/contracts";
import {
  nativeModelSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";
import {
  AgentHarnessRegistry,
  ProviderManager,
} from "../../src/server/providers";
import type { AgentHarness } from "../../src/server/provider/agent-harness";
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  createClaudeAgentSdkHarness,
} from "../../src/server/provider/claude-agent-sdk-harness";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { ConversationWorkAuthority } from "../../src/server/runtime/conversation-work-authority";
import {
  createConversationCompactionCommandHandler,
  type ConversationCompactionCommandDependencies,
} from "../../src/server/runtime/commands/conversation-compaction-commands";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { resolveNativeModelRoute } from "./model-route-fixture";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

function fixture(options: {
  sessionId?: string | null;
  compactStatus?: "completed" | "failed";
  cleanupConfirmed?: boolean;
  acquire?: boolean;
  duoReserved?: boolean;
  reconfigured?: boolean;
  providerDefault?: boolean;
  providerId?: ProviderId;
  accessMode?: "supervised" | "auto-edit" | "full";
  fastMode?: "standard" | "fast";
} = {}) {
  const providerId = options.providerId ?? "claude";
  const baseSelection = nativeModelSelection({
    providerId,
    modelId: options.providerDefault ? "provider-default" : "claude-test",
    reasoningEffort: null,
  });
  const fastModeValue = providerId === "codex" ? "priority" : "fast";
  const selection = options.fastMode === "fast"
    ? withModelSelectionFastMode(baseSelection, fastModeValue)
    : baseSelection;
  const route = resolveNativeModelRoute(selection);
  const compact = vi.fn(async () => ({
    providerId,
    conversationId,
    status: options.compactStatus ?? "completed",
    instructionForwarded: true,
    message: options.compactStatus === "failed"
      ? "Claude could not compact the context."
      : "Context compacted with the focus instruction.",
    cleanupConfirmed: options.cleanupConfirmed ?? true,
  }));
  const release = vi.fn();
  const send = vi.fn((_socket: WebSocket, _event: ServerEvent) => undefined);
  const broadcast = vi.fn();
  const conversation = {
    id: conversationId,
    providerId,
    providerSessionId: options.sessionId === undefined
      ? "claude-session"
      : options.sessionId,
    modelSelection: selection,
    continuationIdentity: route.continuationIdentity,
    interactionMode: "build",
    accessMode: options.accessMode ?? "supervised",
  };
  const conversationLookup = vi.fn(() => options.reconfigured
    ? conversationLookup.mock.calls.length === 1
      ? conversation
      : { ...conversation, providerSessionId: "replacement-session" }
    : conversation);
  const existingUsage = {
    conversationId,
    turnId: "33333333-3333-4333-8333-333333333333",
    usedTokens: 12_000,
    totalProcessedTokens: 18_000,
    totalProcessedScope: "thread" as const,
    maxTokens: 200_000,
    inputTokens: 11_000,
    cachedInputTokens: 1_000,
    cacheWriteInputTokens: 0,
    outputTokens: 1_000,
    reasoningOutputTokens: 100,
    compactsAutomatically: false,
    updatedAt: "2026-08-12T10:00:00.000Z",
  };
  const upsertUsage = vi.fn((usage: Omit<
    ThreadUsageSnapshot,
    "updatedAt" | "turnId"
  > & { turnId?: string | null }) => ({
    ...usage,
    turnId: usage.turnId ?? null,
    updatedAt: "2026-08-12T10:01:00.000Z",
  }));
  const dependencies = {
    store: {
      conversation: conversationLookup,
      conversationPath: vi.fn(() => "/workspace"),
      assertDuoComparisonTurnAllowed: vi.fn(() => {
        if (options.duoReserved) {
          throw new Error(
            "This judge chat is reserved for its locked Duo comparison.",
          );
        }
      }),
      latestAgentTurnForConversation: vi.fn(() => ({
        modelSelection: selection,
        continuationIdentity: route.continuationIdentity,
      })),
      usageForConversation: vi.fn(() => existingUsage),
      upsertUsage,
    },
    providers: {
      resolveModelRoute: vi.fn(() => route),
      compact,
      isRunning: vi.fn(() => options.cleanupConfirmed === false),
      stopOwned: vi.fn(async () => "force-detached"),
    },
    backendProfileController: {
      validateSelection: vi.fn(() => selection),
      readiness: vi.fn(async () => null),
    },
    turns: { isActive: vi.fn(() => false) },
    isolatedRuns: { has: vi.fn(() => false) },
    providerTerminalResumes: {
      isActive: vi.fn(() => false),
      acquire: vi.fn(() => options.acquire ?? true),
      release,
    },
    enableProviders: true,
    providerInfo: () => [{
      id: providerId,
      canRun: true,
      statusMessage: null,
      models: options.fastMode
        ? [{
            id: "claude-test",
            isDefault: true,
            fastMode: {
              providerValue: fastModeValue,
              label: "Fast",
              description: "Faster responses with increased usage.",
              isDefault: false,
            },
          }]
        : [],
    } as unknown as ProviderInfo],
    broadcast,
    send,
  } as unknown as ConversationCompactionCommandDependencies;
  return {
    broadcast,
    compact,
    dependencies,
    release,
    send,
    upsertUsage,
  };
}

describe("conversation compaction command", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(
    roots.splice(0).map(removePortableFixture),
  ));

  it("launches the real provider compaction boundary without inventing a durable turn", async () => {
    const { dependencies, send } = fixture();
    let launches = 0;
    dependencies.providers = new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => {
          launches += 1;
          return fixtureClaudeQuery(
            (async function* (): AsyncGenerator<SDKMessage> {
              yield {
                ...claudeSystem("status", {
                  status: null,
                  compact_result: "success",
                }),
                session_id: "claude-session",
              } as SDKMessage;
              yield {
                ...claudeSuccessResult("Compacted"),
                session_id: "claude-session",
              } as SDKMessage;
            })(),
          );
        },
      })]),
    );
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).resolves.toBe("handled");

    expect(launches).toBe(1);
    expect(dependencies.providers.isRunning(conversationId)).toBe(false);
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "request.result",
      requestId,
    }));
  });

  it.each(["standard", "fast"] as const)(
    "attests %s speed while compacting a Fast-capable Claude session",
    async (speed) => {
      const { dependencies, send } = fixture({ fastMode: speed });
      let capturedOptions: ClaudeOptions | undefined;
      dependencies.providers = new ProviderManager(
        { commands: { claude: "/fake/claude" } },
        new AgentHarnessRegistry([createClaudeAgentSdkHarness({
          createQuery: ({ options }) => {
            capturedOptions = options;
            return fixtureClaudeQuery(
              (async function* (): AsyncGenerator<SDKMessage> {
                yield {
                  ...claudeSystem("init", {
                    fast_mode_state: speed === "fast" ? "on" : "off",
                  }),
                  session_id: "claude-session",
                } as SDKMessage;
                yield {
                  ...claudeSystem("status", {
                    status: null,
                    compact_result: "success",
                  }),
                  session_id: "claude-session",
                } as SDKMessage;
                yield {
                  ...claudeSuccessResult("Compacted"),
                  session_id: "claude-session",
                } as SDKMessage;
              })(),
            );
          },
        })]),
      );
      const handler = createConversationCompactionCommandHandler(dependencies);

      await expect(handler({} as WebSocket, {
        type: "conversation.compact",
        requestId,
        payload: { conversationId },
      })).resolves.toBe("handled");

      expect(capturedOptions?.settings).toMatchObject({
        fastMode: speed === "fast",
        fastModePerSessionOptIn: true,
      });
      expect(send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "request.result", requestId }),
      );
    },
  );

  it.each(["auto-edit", "full"] as const)(
    "cancels an unanswerable Cursor approval from %s access and releases checkout authority",
    async (accessMode) => {
    const root = portableFixtureRoot(`Cursor compact ${accessMode} approval`);
    roots.push(root);
    const capturePath = join(root, "capture.jsonl");
    const command = portableNodeExecutable(root, "cursor");
    writeNodeSubcommand(root, "acp", `
const fs = require("node:fs");
const readline = require("node:readline");
let promptId;
let promptSettled = false;
const capture = (message) => fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(message) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const finishPrompt = () => {
  if (promptSettled || promptId === undefined) return;
  promptSettled = true;
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "Cursor", version: "test" } } });
  if (message.method === "session/load") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "summarize", description: "Summarize" }] } } });
    return send({ jsonrpc: "2.0", id: message.id, result: { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, configOptions: [] } });
  }
  if (message.method === "session/prompt") {
    promptId = message.id;
    return send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "compact-tool", title: "Write summary", kind: "edit", status: "pending", rawInput: { path: "summary.md" } }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject once", kind: "reject_once" }] } });
  }
  if (message.id === 900 || message.method === "session/cancel") finishPrompt();
});
`);
    const { dependencies, release, send } = fixture({
      providerId: "cursor",
      providerDefault: true,
      accessMode,
    });
    const manager = new ProviderManager(
      { commands: { cursor: command }, cancelGraceMs: 100 },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    dependencies.providers = manager;
    dependencies.store.conversationPath = vi.fn(() => root);
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).rejects.toThrow("interactive approval");

    const messages = readFileSync(capturePath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line)) as Array<{
      id?: number;
      method?: string;
      result?: { outcome?: { outcome?: string } };
    }>;
    expect(messages.some(({ method }) => method === "session/prompt")).toBe(true);
    expect(messages.some(({ id, result }) =>
      id === 900 && result?.outcome?.outcome === "cancelled"
    )).toBe(true);
    expect(manager.isRunning(conversationId)).toBe(false);
    expect(release).toHaveBeenCalledWith(conversationId);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a provider that compacts a different resumed session", async () => {
    const { dependencies, release, send } = fixture();
    dependencies.providers = new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("status", {
              status: null,
              compact_result: "success",
            });
            yield claudeSuccessResult("Compacted the wrong session");
          })(),
        ),
      })]),
    );
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).rejects.toThrow("exact selected session");

    expect(dependencies.store.conversation(conversationId).providerSessionId)
      .toBe("claude-session");
    expect(release).toHaveBeenCalledWith(conversationId);
    expect(send).not.toHaveBeenCalled();
  });

  it("retains checkout authority when exact provider cleanup stays unconfirmed", async () => {
    const { dependencies, send } = fixture();
    const authority = new ConversationWorkAuthority(() => ({
      projectId: "project-1",
      checkoutPath: "/workspace",
    }));
    const reservations = new ProviderTerminalResumeRegistry(authority);
    const cancel = vi.fn();
    const harness: AgentHarness = {
      id: "claude-agent-sdk",
      providerId: "claude",
      capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
      supports: (input) => input.providerId === "claude",
      start: ({ input }) => ({
        harnessId: "claude-agent-sdk",
        providerId: "claude",
        result: Promise.resolve({
          providerId: "claude",
          conversationId,
          status: "completed",
          sessionId: input.sessionId,
          text: "",
          textTruncated: false,
          exitCode: null,
          signal: null,
          cleanupConfirmed: false,
        }),
        cancel,
        extension: {
          kind: "claude-agent-sdk",
          respondToApproval: () => false,
          respondToInput: () => false,
        },
      }),
    };
    const manager = new ProviderManager(
      { commands: { claude: "/fake/claude" }, cancelGraceMs: 100 },
      new AgentHarnessRegistry([harness]),
    );
    dependencies.providers = manager;
    dependencies.providerTerminalResumes = reservations;
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).rejects.toThrow("checkout remain locked");

    expect(cancel).toHaveBeenCalledWith(true);
    expect(manager.isRunning(conversationId)).toBe(true);
    expect(reservations.isActive(conversationId)).toBe(true);
    expect(authority.hasConversation(conversationId)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("holds and releases provider/workspace authority around compaction", async () => {
    const {
      broadcast,
      compact,
      dependencies,
      release,
      send,
      upsertUsage,
    } = fixture();
    const handler = createConversationCompactionCommandHandler(dependencies);
    const socket = {} as WebSocket;

    await expect(handler(socket, {
      type: "conversation.compact",
      requestId,
      payload: {
        conversationId,
        instruction: "remember retrieval exactly",
      },
    })).resolves.toBe("handled");

    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        runId: expect.any(String),
        sessionId: "claude-session",
      }),
      "remember retrieval exactly",
      expect.objectContaining({ onUsage: expect.any(Function) }),
    );
    expect(release).toHaveBeenCalledWith(conversationId);
    expect(send).toHaveBeenCalledWith(socket, {
      type: "request.result",
      requestId,
      result: {
        kind: "conversation.compacted",
        conversationId,
        providerId: "claude",
        instructionForwarded: true,
        message: "Context compacted with the focus instruction.",
      },
    });
    expect(upsertUsage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId,
      usedTokens: null,
      maxTokens: 200_000,
    }));
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent.usage",
      usage: expect.objectContaining({ usedTokens: null }),
    }));
  });

  it("rejects chats without a provider session before taking authority", async () => {
    const { compact, dependencies, release } = fixture({ sessionId: null });
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).rejects.toThrow("does not have a provider session");
    expect(compact).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("rejects a reserved Duo judge before readiness or provider authority", async () => {
    const { compact, dependencies, release } = fixture({ duoReserved: true });
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).rejects.toThrow("reserved for its locked Duo comparison");

    expect(dependencies.backendProfileController.readiness).not
      .toHaveBeenCalled();
    expect(dependencies.providerTerminalResumes.acquire).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(dependencies.store.conversation(conversationId).providerSessionId)
      .toBe("claude-session");
    expect(release).not.toHaveBeenCalled();
  });

  it("preserves provider-default identity while resuming compaction", async () => {
    const { compact, dependencies } = fixture({ providerDefault: true });
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).resolves.toBe("handled");
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        model: undefined,
        modelSelection: expect.objectContaining({
          modelId: "provider-default",
        }),
      }),
      undefined,
      expect.any(Object),
    );
  });

  it("releases authority when the provider reports failure", async () => {
    const { dependencies, release, send } = fixture({
      compactStatus: "failed",
    });
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).rejects.toThrow("could not compact");
    expect(release).toHaveBeenCalledWith(conversationId);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a session configuration that changes during readiness", async () => {
    const { compact, dependencies, release } = fixture({
      reconfigured: true,
    });
    const handler = createConversationCompactionCommandHandler(dependencies);

    await expect(handler({} as WebSocket, {
      type: "conversation.compact",
      requestId,
      payload: { conversationId },
    })).rejects.toThrow("configuration changed");
    expect(compact).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(conversationId);
  });
});
