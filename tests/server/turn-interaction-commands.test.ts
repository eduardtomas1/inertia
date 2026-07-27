import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import type {
  ChatAttachment,
  ClientCommand,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  createTurnInteractionCommandHandler,
  type TurnInteractionCommandDependencies,
} from "../../src/server/runtime/commands/turn-interaction-commands";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestAttachment: ChatAttachment = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "request.png",
  path: "opaque-renderer-path",
  mimeType: "image/png",
  size: 8,
};
const trustedAttachment: ChatAttachment = {
  ...requestAttachment,
  path: "/private/runtime/request.png",
};

function messageCommand(): Extract<ClientCommand, { type: "message.send" }> {
  return {
    type: "message.send",
    requestId: "33333333-3333-4333-8333-333333333333",
    payload: {
      conversationId,
      content: "Use the selected attachment.",
      attachments: [requestAttachment],
    },
  };
}

function dependencies(options: {
  queue: ReturnType<typeof vi.fn>;
  relinquishAll: ReturnType<typeof vi.fn>;
  readiness?: ReturnType<typeof vi.fn>;
}): TurnInteractionCommandDependencies {
  const provider = {
    id: "codex",
    canRun: true,
    statusMessage: null,
    models: [],
  } as unknown as ProviderInfo;
  return {
    store: {
      conversation: vi.fn(() => ({
        id: conversationId,
        title: "Existing conversation",
        providerId: "codex",
        model: null,
        reasoningEffort: "",
        modelSelection: {
          providerId: "codex",
          harnessId: "codex-app-server",
          backendProfileId: "builtin:openai",
          modelId: "gpt-test",
          alias: null,
          reasoningEffort: null,
          backendConfigurationRevision: 0,
        },
      })),
      conversationPath: vi.fn(() => tmpdir()),
    } as unknown as TurnInteractionCommandDependencies["store"],
    backendProfileController: {
      validateSelection: vi.fn(),
      readiness: options.readiness ?? vi.fn(async () => null),
    } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    turns: {
      isActive: vi.fn(() => false),
      queue: options.queue,
      start: vi.fn(() => true),
      failBeforeStart: vi.fn(() => true),
    } as unknown as TurnInteractionCommandDependencies["turns"],
    isolatedRuns: {
      has: vi.fn(() => false),
    } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(),
    pendingInputs: new Map(),
    dataDirectory: tmpdir(),
    enableProviders: true,
    attachmentResolver: {
      resolveAll: vi.fn(async () => [trustedAttachment]),
      relinquishAll: options.relinquishAll,
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"],
    providerInfo: () => [provider],
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
  };
}

describe("message attachment ownership transfer", () => {
  it("relinquishes ownership when provider readiness rejects the send", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn();
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
      readiness: vi.fn(async () => ({
        ready: false,
        message: "Selected backend is unavailable.",
      })),
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "Selected backend is unavailable.",
    );
    expect(queue).not.toHaveBeenCalled();
    expect(relinquishAll).toHaveBeenCalledOnce();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
  });

  it("keeps a rejected capability available for a renderer retry", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("queue preparation rejected");
      })
      .mockImplementationOnce(() => ({
        turn: { id: "44444444-4444-4444-8444-444444444444" },
      }));
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "queue preparation rejected",
    );
    expect(queue).toHaveBeenCalledTimes(1);
    expect(relinquishAll).toHaveBeenCalledOnce();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);

    await expect(handler({} as never, messageCommand())).resolves.toBe(
      "handled",
    );
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({
      attachments: [trustedAttachment],
    }));
    expect(relinquishAll).toHaveBeenCalledOnce();
  });

  it("does not release after an authoritative turn accepts ownership", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn(() => ({
      turn: { id: "44444444-4444-4444-8444-444444444444" },
    }));
    const handlerDependencies = dependencies({ queue, relinquishAll });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).resolves.toBe(
      "handled",
    );
    expect(relinquishAll).not.toHaveBeenCalled();
    expect(handlerDependencies.turns.start).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("settles an accepted queued turn if acknowledgement work throws before start", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn(() => ({
      turn: { id: "55555555-5555-4555-8555-555555555555" },
    }));
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
    });
    vi.mocked(handlerDependencies.send).mockImplementation(() => {
      throw new Error("renderer acknowledgement failed");
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand())).rejects.toThrow(
      "renderer acknowledgement failed",
    );
    expect(handlerDependencies.turns.failBeforeStart).toHaveBeenCalledWith(
      conversationId,
      "renderer acknowledgement failed",
    );
    expect(relinquishAll).not.toHaveBeenCalled();
  });
});
