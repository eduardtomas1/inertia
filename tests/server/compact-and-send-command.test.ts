import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";

import type {
  ChatAttachment,
  ClientCommand,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { ProviderAccountKind } from "../../src/shared/provider";
import type { ProviderManager } from "../../src/server/providers";
import {
  COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS,
  createConversationCompactionCommandHandler,
  type ConversationCompactionCommandDependencies,
} from "../../src/server/runtime/commands/conversation-compaction-commands";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { ConversationCompactionStates } from "../../src/server/runtime/conversation-compaction-states";
import { resolveNativeModelRoute } from "./model-route-fixture";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const turnId = "44444444-4444-4444-8444-444444444444";
const userMessageId = "99999999-9999-4999-8999-999999999999";
const attachment: ChatAttachment = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "screen.png",
  path: "opaque-renderer-path",
  mimeType: "image/png",
  size: 8,
};
const trustedAttachment: ChatAttachment = { ...attachment, path: "/private/runtime/screen.png" };
const context = { fileReferences: [{ path: "src/app.ts", lineStart: 3 }] };

interface FixtureOptions {
  providerId?: "claude" | "codex";
  preset?: string;
  protocol?: string;
  routeKind?: "account" | "api-key";
  accountKind?: ProviderAccountKind;
  compactStatus?: "completed" | "failed";
  archived?: boolean;
  watcher?: boolean;
  latestTurn?: Record<string, unknown> | null;
  setting?: "offer" | "never";
  sessionId?: string | null;
  turnActive?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const providerId = options.providerId ?? "claude";
  const selection = providerNativeModelSelection({
    providerId,
    modelId: providerId === "claude" ? "claude-test" : "gpt-test",
    reasoningEffort: null,
  });
  const route = resolveNativeModelRoute(selection);
  const held = new Set<string>();
  const compactions = new ConversationCompactionStates();
  const timeline: string[] = [];
  const conversation = {
    id: conversationId,
    title: "Long chat",
    providerId,
    providerSessionId: options.sessionId === undefined ? "provider-session" : options.sessionId,
    modelSelection: selection,
    continuationIdentity: route.continuationIdentity,
    interactionMode: "build",
    accessMode: "supervised",
    archivedAt: options.archived ? "2026-10-25T08:00:00.000Z" : null,
    model: null,
    reasoningEffort: "",
  };
  const compact = vi.fn<ProviderManager["compact"]>(async (input) => {
    timeline.push(`compact:${compactions.state(conversationId).state}:${held.has(conversationId)}`);
    return {
      providerId,
      conversationId,
      runId: input.runId,
      turnId: input.turnId,
      status: options.compactStatus ?? "completed",
      terminalReason: { outcome: "completed", reason: "provider-completed" },
      instructionForwarded: false,
      message: options.compactStatus === "failed" ? "Claude could not compact the context." : "Context compacted.",
      cleanupConfirmed: true,
    } as Awaited<ReturnType<ProviderManager["compact"]>>;
  });
  const queue = vi.fn((input: Record<string, unknown>) => {
    timeline.push(`queue:${compactions.state(conversationId).state}:${held.has(conversationId)}`);
    return {
      turn: { id: turnId, conversationId: input.conversationId },
      message: { id: userMessageId, conversationId, turnId },
    };
  });
  const providerTerminalResumes = {
    isActive: vi.fn((id: string) => held.has(id)),
    acquire: vi.fn((id: string) => {
      if (held.has(id)) return false;
      held.add(id);
      return true;
    }),
    acquireWhenAvailable: vi.fn(async () => false),
    release: vi.fn((id: string) => {
      held.delete(id);
    }),
  };
  const send = vi.fn((_socket: WebSocket, _event: ServerEvent) => undefined);
  const broadcast = vi.fn();
  const broadcastConversationShell = vi.fn((id: string) => {
    timeline.push(`shell:${compactions.state(id).state}`);
  });
  const provider = {
    id: providerId,
    canRun: true,
    statusMessage: null,
    models: [{ id: selection.modelId, isDefault: true, inputModalities: ["text", "image"] }],
    ...(options.accountKind ? { accountKind: options.accountKind } : {}),
  } as unknown as ProviderInfo;
  const store = {
    conversation: vi.fn(() => conversation),
    conversationPath: vi.fn(() => tmpdir()),
    cliConversationImport: vi.fn(() => null),
    assertDuoComparisonTurnAllowed: vi.fn(),
    latestAgentTurnForConversation: vi.fn(() => ({
      modelSelection: selection,
      continuationIdentity: route.continuationIdentity,
      providerSessionAfter: conversation.providerSessionId,
    })),
    conversationShell: vi.fn(() => ({ ...conversation, latestTurn: options.latestTurn ?? { status: "completed" } })),
    watcherLinks: { findByWatcher: vi.fn(() => options.watcher ? { id: "link" } : null) },
    usageForConversation: vi.fn(() => ({ conversationId, turnId: null, usedTokens: 240_000 })),
    upsertUsage: vi.fn(),
    createMessage: vi.fn((id, content, role, attachments, messageTurnId, createdAt, extra) => ({
      id: "55555555-5555-4555-8555-555555555555", conversationId: id, content, role, attachments,
      turnId: messageTurnId, createdAt: createdAt ?? "2026-10-25T09:00:00.000Z", ...extra,
    })),
    hasConversationMessages: vi.fn(() => true),
    updateConversation: vi.fn(),
    evictableAttachmentIds: vi.fn(() => []),
  };
  const backendProfileController = {
    validateSelection: vi.fn(() => selection),
    readiness: vi.fn(async () => null),
    isExternalSelection: vi.fn(() => false),
    profiles: vi.fn(() => [{
      id: selection.backendProfileId,
      preset: options.preset ?? "anthropic-api-key",
      protocol: options.protocol ?? "anthropic-messages",
      providerId,
      routeKind: options.routeKind ?? "api-key",
    }]),
  };
  const turns = {
    isActive: vi.fn(() => options.turnActive ?? false),
    acquireTurnAdmission: vi.fn(async () => ({ conversationId, token: Symbol("admission"), release: vi.fn() })),
    queue,
    start: vi.fn(() => {
      timeline.push(`start:${held.has(conversationId)}`);
      return true;
    }),
    failBeforeStart: vi.fn(),
  };
  const isolatedRuns = { has: vi.fn(() => false) };
  const handoffExpiresAt = Date.now() + 210_000;
  const attachmentResolver = {
    resolvePayloads: vi.fn(async () => {
      timeline.push("attachments");
      if (Date.now() > handoffExpiresAt) throw new Error("Attachment handoff is unavailable.");
      return [{ attachment: trustedAttachment, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }];
    }),
    relinquishAll: vi.fn(async () => undefined),
    releaseAll: vi.fn(async () => undefined),
  };
  const interaction = {
    store,
    conversationAttachments: {
      retain: vi.fn(async (payloads: Array<{ attachment: ChatAttachment }>) => payloads.map((payload) => payload.attachment)),
      release: vi.fn(async () => undefined),
      acceptRetention: vi.fn(),
      releaseRetention: vi.fn(async () => undefined),
    },
    backendProfileController,
    turns,
    isolatedRuns,
    workspaceRuns: {},
    pendingApprovals: new Map(),
    pendingInputs: new Map(),
    dataDirectory: tmpdir(),
    enableProviders: true,
    attachmentResolver,
    generatedAttachments: { release: vi.fn(async () => undefined) },
    prepareDocumentAttachments: vi.fn(async () => ({ contexts: [], generatedImagePaths: [], imagePaths: [trustedAttachment.path] })),
    workflows: {
      resolveTurnSkills: vi.fn(async () => ({ inputs: [], routeKey: null })),
      assertTurnSkillsCurrent: vi.fn(),
    },
    providerTerminalResumes,
    providerInfo: () => [provider],
    broadcast,
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
  } as unknown as TurnInteractionCommandDependencies;
  const dependencies = {
    store,
    providers: {
      resolveModelRoute: vi.fn(() => route),
      compact,
      stopOwned: vi.fn(async () => "settled"),
    },
    backendProfileController,
    turns,
    isolatedRuns,
    providerTerminalResumes,
    enableProviders: true,
    compactions,
    interaction,
    settings: () => ({ compactOnReturn: options.setting ?? "offer" }),
    providerInfo: () => [provider],
    broadcast,
    broadcastConversationShell,
    send,
  } as unknown as ConversationCompactionCommandDependencies;
  return { dependencies, compact, queue, send, broadcastConversationShell, compactions, held, timeline, attachmentResolver, turns, store, providerTerminalResumes, provider };
}

function compactAndSend(): Extract<ClientCommand, { type: "conversation.compact-and-send" }> {
  return {
    type: "conversation.compact-and-send",
    requestId,
    payload: {
      conversationId,
      content: "Pick up where we left off.",
      attachments: [attachment],
      activate: false,
      context,
      reason: "on-return",
    },
  };
}

function sentResult(send: ReturnType<typeof fixture>["send"]) {
  return send.mock.calls.map(([, event]) => event).find((event) => event.type === "request.result");
}

function compactionFailed(message: string) {
  return {
    type: "request.result",
    requestId,
    result: {
      kind: "conversation.compact-and-send",
      conversationId,
      outcome: "compaction-failed",
      message: expect.stringContaining(message),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("conversation.compact-and-send", () => {
  it("compacts under the chat lock and then sends the full message while still holding it", async () => {
    const { dependencies, compact, queue, send, compactions, held, timeline, attachmentResolver, store, providerTerminalResumes } = fixture();
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]![1]).toBeUndefined();
    expect(store.createMessage).toHaveBeenCalledWith(conversationId, "/compact", "system", [], null, undefined, {
      compaction: { providerId: "claude", beforeTokens: 240_000, afterTokens: null, instructionForwarded: false, trigger: "on-return", sessionInstructionDigest: null },
    });
    expect(attachmentResolver.resolvePayloads).toHaveBeenCalledWith([attachment], requestId, expect.any(AbortSignal));
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      conversationId,
      content: "Pick up where we left off.",
      attachments: [trustedAttachment],
      activateConversation: false,
      context,
      contextRequestId: requestId,
    }), expect.any(Function), expect.anything());
    expect(timeline).toEqual([
      "attachments",
      "shell:compacting",
      "compact:compacting:true",
      "queue:compacting:true",
      "start:true",
      "shell:idle",
    ]);
    expect(providerTerminalResumes.acquire).toHaveBeenCalledOnce();
    expect(providerTerminalResumes.acquireWhenAvailable).not.toHaveBeenCalled();
    expect(providerTerminalResumes.release).toHaveBeenCalledOnce();
    expect(held.size).toBe(0);
    expect(compactions.state(conversationId)).toEqual({ state: "idle", trigger: null, startedAt: null });
    expect(sentResult(send)).toEqual({
      type: "request.result",
      requestId,
      result: {
        kind: "conversation.compact-and-send",
        outcome: "sent",
        conversationId,
        turnId,
        userMessageId,
        disposition: "new-turn",
        compaction: { providerId: "claude", beforeTokens: 240_000, afterTokens: null, instructionForwarded: false, trigger: "on-return", sessionInstructionDigest: null },
      },
    });
  });

  it("reports the compaction state with its trigger while the provider works", async () => {
    const { dependencies, compact, compactions } = fixture();
    let during: unknown;
    compact.mockImplementationOnce(async (input) => {
      during = compactions.state(conversationId);
      return {
        providerId: "claude", conversationId, runId: input.runId, turnId: input.turnId, status: "completed",
        terminalReason: { outcome: "completed", reason: "provider-completed" }, instructionForwarded: false,
        message: "Context compacted.", cleanupConfirmed: true,
      } as Awaited<ReturnType<ProviderManager["compact"]>>;
    });
    await createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    expect(during).toEqual({ state: "compacting", trigger: "on-return", startedAt: expect.any(String) });
  });

  it("sends nothing and leaves the chat usable when the provider compaction fails", async () => {
    const { dependencies, queue, send, compactions, held, attachmentResolver, store } = fixture({ compactStatus: "failed" });
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(sentResult(send)).toEqual({
      type: "request.result",
      requestId,
      result: {
        kind: "conversation.compact-and-send",
        conversationId,
        outcome: "compaction-failed",
        message: "Claude could not compact the context. Nothing was sent.",
      },
    });
    expect(queue).not.toHaveBeenCalled();
    expect(attachmentResolver.relinquishAll).toHaveBeenCalledExactlyOnceWith([attachment.id]);
    expect(attachmentResolver.releaseAll).not.toHaveBeenCalled();
    expect(store.createMessage).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    expect(compactions.isCompacting(conversationId)).toBe(false);
  });

  it("reports a provider exception as a failed compaction", async () => {
    const { dependencies, compact, queue, send, held } = fixture();
    compact.mockRejectedValueOnce(new Error("socket closed /private/path"));
    await createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    expect(sentResult(send)).toMatchObject({ result: { outcome: "compaction-failed", message: expect.stringMatching(/Nothing was sent\.$/u) } });
    expect(JSON.stringify(send.mock.calls)).not.toContain("/private/path");
    expect(queue).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
  });

  it("stops a compaction that runs past its deadline and sends nothing", async () => {
    vi.useFakeTimers();
    const { dependencies, compact, queue, send, held, compactions } = fixture();
    let finish!: () => void;
    compact.mockImplementationOnce((input) => new Promise((resolve) => {
      finish = () => resolve({
        providerId: "claude", conversationId, runId: input.runId, turnId: input.turnId, status: "cancelled",
        terminalReason: { outcome: "cancelled", reason: "user-cancelled" }, instructionForwarded: false,
        message: "The provider could not compact this chat.", cleanupConfirmed: false,
      } as unknown as Awaited<ReturnType<ProviderManager["compact"]>>);
    }));
    vi.mocked(dependencies.providers.stopOwned).mockImplementation(async () => {
      finish();
      return "settled";
    });
    const handled = createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    await vi.advanceTimersByTimeAsync(0);
    expect(compactions.isCompacting(conversationId)).toBe(true);
    await vi.advanceTimersByTimeAsync(COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS);
    await expect(handled).resolves.toBe("handled");
    expect(dependencies.providers.stopOwned).toHaveBeenCalledWith(conversationId, expect.objectContaining({ runId: expect.any(String) }));
    expect(sentResult(send)).toMatchObject({
      result: { outcome: "compaction-failed", message: "Compaction did not finish in time. Nothing was sent." },
    });
    expect(queue).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    expect(compactions.isCompacting(conversationId)).toBe(false);
  });

  it("claims the attachments before compacting so a compaction longer than the handoff still sends them", async () => {
    vi.useFakeTimers();
    const { dependencies, compact, queue, send, timeline } = fixture();
    compact.mockImplementationOnce((input) => new Promise((resolve) => {
      setTimeout(() => resolve({
        providerId: "claude", conversationId, runId: input.runId, turnId: input.turnId, status: "completed",
        terminalReason: { outcome: "completed", reason: "provider-completed" }, instructionForwarded: false,
        message: "Context compacted.", cleanupConfirmed: true,
      } as Awaited<ReturnType<ProviderManager["compact"]>>), 300_000);
    }));
    const handled = createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(handled).resolves.toBe("handled");
    expect(timeline.indexOf("attachments")).toBe(0);
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ attachments: [trustedAttachment] }), expect.any(Function), expect.anything());
    expect(sentResult(send)).toMatchObject({ result: { outcome: "sent", turnId } });
  });

  it("returns the claimed attachments when the send fails before taking them", async () => {
    const { dependencies, send, attachmentResolver, turns } = fixture();
    turns.isActive.mockImplementation(() => attachmentResolver.resolvePayloads.mock.calls.length > 0
      && vi.mocked(dependencies.store.createMessage).mock.calls.length > 0);
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .rejects.toThrow("The chat changed while it was compacting.");
    expect(attachmentResolver.relinquishAll).toHaveBeenCalledExactlyOnceWith([attachment.id]);
    expect(sentResult(send)).toBeUndefined();
  });

  it("answers within the deadline when backend readiness never settles", async () => {
    vi.useFakeTimers();
    const { dependencies, compact, send, attachmentResolver } = fixture();
    vi.mocked(dependencies.backendProfileController.readiness).mockImplementation(() => new Promise(() => undefined));
    const handled = createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    await vi.advanceTimersByTimeAsync(COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS);
    await expect(handled).resolves.toBe("handled");
    expect(sentResult(send)).toMatchObject({
      result: { outcome: "compaction-failed", message: "Compaction did not finish in time. Nothing was sent." },
    });
    expect(compact).not.toHaveBeenCalled();
    expect(attachmentResolver.relinquishAll).toHaveBeenCalledExactlyOnceWith([attachment.id]);
  });

  it("keeps a completed compaction and still sends when the deadline passes during cleanup confirmation", async () => {
    vi.useFakeTimers();
    const { dependencies, compact, send, store, queue } = fixture();
    compact.mockImplementationOnce(async (input) => ({
      providerId: "claude", conversationId, runId: input.runId, turnId: input.turnId, status: "completed",
      terminalReason: { outcome: "completed", reason: "provider-completed" }, instructionForwarded: false,
      message: "Context compacted.", cleanupConfirmed: false,
    } as Awaited<ReturnType<ProviderManager["compact"]>>));
    vi.mocked(dependencies.providers.stopOwned).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve("settled"), COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS + 1_000);
    }));
    const handled = createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    await vi.advanceTimersByTimeAsync(COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS + 1_000);
    await expect(handled).resolves.toBe("handled");
    expect(store.createMessage).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledOnce();
    expect(sentResult(send)).toMatchObject({ result: { outcome: "sent", compaction: { trigger: "on-return" } } });
  });

  it("fails closed when the native sign-in cannot be read again", async () => {
    const { dependencies, compact, providerTerminalResumes, send, attachmentResolver } = fixture({ preset: "native", routeKind: "account", accountKind: "Console API key" });
    dependencies.refreshProviderAccount = vi.fn(async () => {
      throw new Error("claude auth status exited with 1 /private/home");
    });
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(sentResult(send)).toMatchObject({
      result: {
        outcome: "compaction-failed",
        message: "Inertia could not confirm which Claude sign-in this chat uses. Nothing was sent.",
      },
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain("/private/home");
    expect(compact).not.toHaveBeenCalled();
    expect(providerTerminalResumes.acquire).not.toHaveBeenCalled();
    expect(attachmentResolver.relinquishAll).toHaveBeenCalledExactlyOnceWith([attachment.id]);
  });

  it("claims the attachments before the sign-in check and backend readiness", async () => {
    const { dependencies, send, timeline } = fixture({ preset: "native", routeKind: "account", accountKind: "Console API key" });
    dependencies.refreshProviderAccount = vi.fn(async () => {
      timeline.push("sign-in");
    });
    vi.mocked(dependencies.backendProfileController.readiness).mockImplementation(async () => {
      timeline.push("readiness");
      return null;
    });
    await createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    expect(timeline.slice(0, 4)).toEqual(["attachments", "sign-in", "readiness", "shell:compacting"]);
    expect(sentResult(send)).toMatchObject({ result: { outcome: "sent" } });
  });

  it("does not claim attachments for a request refused by the cheap checks", async () => {
    const { dependencies, attachmentResolver, send } = fixture({ preset: "kimi-code" });
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(sentResult(send)).toEqual(compactionFailed("Kimi manages its own context"));
    expect(attachmentResolver.resolvePayloads).not.toHaveBeenCalled();
  });

  it("checks the Claude sign-in again before compacting a native route", async () => {
    const { dependencies, compact, providerTerminalResumes, provider, send, queue } = fixture({ preset: "native", routeKind: "account", accountKind: "Console API key" });
    const refreshProviderAccount = vi.fn(async () => {
      Object.assign(provider, { accountKind: "Claude account" });
    });
    dependencies.refreshProviderAccount = refreshProviderAccount;
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(sentResult(send)).toEqual(compactionFailed("Console API key"));
    expect(queue).not.toHaveBeenCalled();
    expect(refreshProviderAccount).toHaveBeenCalledExactlyOnceWith("claude");
    expect(compact).not.toHaveBeenCalled();
    expect(providerTerminalResumes.acquire).not.toHaveBeenCalled();
  });

  it("does not re-check sign-in for an API key preset", async () => {
    const { dependencies, send } = fixture();
    const refreshProviderAccount = vi.fn(async () => undefined);
    dependencies.refreshProviderAccount = refreshProviderAccount;
    await createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    expect(refreshProviderAccount).not.toHaveBeenCalled();
    expect(sentResult(send)).toMatchObject({ result: { outcome: "sent" } });
  });

  it("bounds the whole operation within the shared request timeout", async () => {
    const { CONVERSATION_COMPACT_AND_SEND_REQUEST_TIMEOUT_MS, MESSAGE_SEND_PREPARATION_TIMEOUT_MS } = await import("../../src/shared/runtime-command-timeouts");
    expect(COMPACT_ON_RETURN_COMPACTION_DEADLINE_MS + MESSAGE_SEND_PREPARATION_TIMEOUT_MS)
      .toBeLessThan(CONVERSATION_COMPACT_AND_SEND_REQUEST_TIMEOUT_MS);
  });

  it("keeps the compaction and reports the send failure when the message cannot start", async () => {
    const { dependencies, queue, send, store, held } = fixture();
    queue.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .rejects.toThrow();
    expect(store.createMessage).toHaveBeenCalledOnce();
    expect(sentResult(send)).toBeUndefined();
    expect(held.size).toBe(0);
  });

  it.each([
    ["the Kimi preset", { preset: "kimi-code" }, "Kimi manages its own context"],
    ["a custom gateway", { preset: "custom" }, "Custom gateways do not publish a prompt cache lifetime"],
    ["native Claude on a Claude account", { preset: "native", routeKind: "account" as const, accountKind: "Claude account" as const }, "Console API key"],
    ["native Codex", { providerId: "codex" as const, preset: "native", protocol: "openai-responses", routeKind: "account" as const, accountKind: "ChatGPT account" as const }, "Anthropic or OpenAI API key"],
  ])("offers sending without compacting for %s before taking the chat lock", async (_label, options, message) => {
    const { dependencies, compact, providerTerminalResumes, send, queue } = fixture(options);
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(sentResult(send)).toEqual(compactionFailed(message));
    expect(compact).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(providerTerminalResumes.acquire).not.toHaveBeenCalled();
  });

  it("offers sending without compacting for a chat with no provider session", async () => {
    const { dependencies, compact, providerTerminalResumes, send, queue, attachmentResolver } = fixture({ sessionId: null });
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(sentResult(send)).toEqual(compactionFailed("This chat does not have a provider session to compact yet. Nothing was sent."));
    expect(compact).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(providerTerminalResumes.acquire).not.toHaveBeenCalled();
    expect(attachmentResolver.resolvePayloads).not.toHaveBeenCalled();
  });

  it("offers sending without compacting when the next turn must start a new provider session", async () => {
    const { dependencies, compact, providerTerminalResumes, send, queue, store, attachmentResolver } = fixture();
    const previous = store.latestAgentTurnForConversation();
    store.latestAgentTurnForConversation.mockReturnValue({
      ...previous,
      continuationIdentity: { ...previous.continuationIdentity, backendProfileId: "an-earlier-account-route" },
    } as never);
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .resolves.toBe("handled");
    expect(sentResult(send)).toEqual(compactionFailed("The model backend changed. The next turn will start a fresh provider session and preserve this chat's history. Nothing was sent."));
    expect(compact).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(providerTerminalResumes.acquire).not.toHaveBeenCalled();
    expect(attachmentResolver.relinquishAll).toHaveBeenCalledExactlyOnceWith([attachment.id]);
  });

  it.each([
    ["native Claude on a Console API key", { preset: "native", routeKind: "account" as const, accountKind: "Console API key" as const }],
    ["the OpenAI key preset on Codex", { providerId: "codex" as const, preset: "openai-api-key", protocol: "openai-responses" }],
  ])("accepts %s", async (_label, options) => {
    const { dependencies, send } = fixture(options);
    await createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend());
    expect(sentResult(send)).toMatchObject({ result: { outcome: "sent" } });
  });

  it.each<[string, FixtureOptions, string]>([
    ["an archived chat", { archived: true }, "Unarchive this chat"],
    ["a watcher chat", { watcher: true }, "Watcher chats are not compacted on return."],
    ["a usage-limited chat", { latestTurn: { status: "failed", usageLimited: true } }, "The last turn stopped on a usage limit, billing, sign-in or rate-limit problem. Resolve it before compacting this chat."],
    ...(["billing", "authentication", "rate-limited"] as const).map((failureKind) =>
      [`a ${failureKind} failure`, { latestTurn: { status: "failed", failureKind } }, "The last turn stopped on a usage limit, billing, sign-in or rate-limit problem. Resolve it before compacting this chat."] as [string, FixtureOptions, string]),
    ["the setting turned off", { setting: "never" as const }, "Compacting on return is set to Never in Settings → Chats."],
    ["an active turn", { turnActive: true }, "Wait for the current provider"],
  ])("refuses %s", async (_label, options, message) => {
    const { dependencies, compact, providerTerminalResumes, send } = fixture(options);
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .rejects.toThrow(message);
    expect(compact).not.toHaveBeenCalled();
    expect(providerTerminalResumes.acquire).not.toHaveBeenCalled();
    expect(sentResult(send)).toBeUndefined();
  });

  it("refuses a reserved Duo judge", async () => {
    const { dependencies, compact } = fixture();
    vi.mocked(dependencies.store.assertDuoComparisonTurnAllowed).mockImplementation(() => {
      throw new Error("This judge chat is reserved for its locked Duo comparison.");
    });
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .rejects.toThrow("reserved for its locked Duo comparison");
    expect(compact).not.toHaveBeenCalled();
  });

  it("refuses while another operation holds the chat lock", async () => {
    const { dependencies, compact, held } = fixture();
    held.add(conversationId);
    await expect(createConversationCompactionCommandHandler(dependencies)({} as WebSocket, compactAndSend()))
      .rejects.toThrow("Wait for the current provider or workspace operation");
    expect(compact).not.toHaveBeenCalled();
  });
});

describe("manual compaction state", () => {
  it("broadcasts compacting with the manual trigger and returns to idle", async () => {
    const { dependencies, compact, compactions, timeline, store, send } = fixture();
    let during: unknown;
    compact.mockImplementationOnce(async (input) => {
      during = compactions.state(conversationId);
      return {
        providerId: "claude", conversationId, runId: input.runId, turnId: input.turnId, status: "completed",
        terminalReason: { outcome: "completed", reason: "provider-completed" }, instructionForwarded: true,
        message: "Context compacted with the focus instruction.", cleanupConfirmed: true,
      } as Awaited<ReturnType<ProviderManager["compact"]>>;
    });
    await createConversationCompactionCommandHandler(dependencies)({} as WebSocket, {
      type: "conversation.compact", requestId, payload: { conversationId, instruction: "keep the tests" },
    });
    expect(during).toEqual({ state: "compacting", trigger: "manual", startedAt: expect.any(String) });
    expect(timeline).toEqual(["shell:compacting", "shell:idle"]);
    expect(store.createMessage).toHaveBeenCalledWith(conversationId, "/compact keep the tests", "system", [], null, undefined, {
      compaction: { providerId: "claude", beforeTokens: 240_000, afterTokens: null, instructionForwarded: true, trigger: "manual", sessionInstructionDigest: null },
    });
    expect(sentResult(send)).toMatchObject({ result: { kind: "conversation.compacted" } });
    expect(compactions.isCompacting(conversationId)).toBe(false);
  });

  it("runs manual compaction without watcher, archive or route refusals", async () => {
    const { dependencies, compact } = fixture({ preset: "kimi-code", watcher: true, setting: "never" });
    await createConversationCompactionCommandHandler(dependencies)({} as WebSocket, {
      type: "conversation.compact", requestId, payload: { conversationId },
    });
    expect(compact).toHaveBeenCalledOnce();
  });
});

describe("compaction state registry", () => {
  it("notifies listeners once when a compaction settles", () => {
    const states = new ConversationCompactionStates();
    const settled = vi.fn();
    states.onSettled(settled);
    expect(states.begin(conversationId, "on-return", "2026-10-25T09:00:00.000Z")).toBe(true);
    expect(states.begin(conversationId, "manual")).toBe(false);
    expect(states.state(conversationId)).toEqual({ state: "compacting", trigger: "on-return", startedAt: "2026-10-25T09:00:00.000Z" });
    states.end(conversationId);
    states.end(conversationId);
    expect(settled).toHaveBeenCalledExactlyOnceWith(conversationId);
    expect(states.state(conversationId)).toEqual({ state: "idle", trigger: null, startedAt: null });
  });
});
