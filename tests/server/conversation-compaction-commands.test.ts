import { describe, expect, it, vi } from "vitest";

import type WebSocket from "ws";

import type {
  ProviderInfo,
  ServerEvent,
  ThreadUsageSnapshot,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import {
  createConversationCompactionCommandHandler,
  type ConversationCompactionCommandDependencies,
} from "../../src/server/runtime/commands/conversation-compaction-commands";
import { resolveNativeModelRoute } from "./model-route-fixture";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

function fixture(options: {
  sessionId?: string | null;
  compactStatus?: "completed" | "failed";
  acquire?: boolean;
  reconfigured?: boolean;
  providerDefault?: boolean;
} = {}) {
  const selection = nativeModelSelection({
    providerId: "claude",
    modelId: options.providerDefault ? "provider-default" : "claude-test",
    reasoningEffort: null,
  });
  const route = resolveNativeModelRoute(selection);
  const compact = vi.fn(async () => ({
    providerId: "claude" as const,
    conversationId,
    status: options.compactStatus ?? "completed",
    instructionForwarded: true,
    message: options.compactStatus === "failed"
      ? "Claude could not compact the context."
      : "Context compacted with the focus instruction.",
    cleanupConfirmed: true,
  }));
  const release = vi.fn();
  const send = vi.fn((_socket: WebSocket, _event: ServerEvent) => undefined);
  const broadcast = vi.fn();
  const conversation = {
    id: conversationId,
    providerId: "claude",
    providerSessionId: options.sessionId === undefined
      ? "claude-session"
      : options.sessionId,
    modelSelection: selection,
    continuationIdentity: route.continuationIdentity,
    interactionMode: "build",
    accessMode: "supervised",
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
      id: "claude",
      canRun: true,
      statusMessage: null,
      models: [],
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
