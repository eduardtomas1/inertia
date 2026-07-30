import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, type Mock, vi } from "vitest";

import type {
  ChatAttachment,
  ClientCommand,
  ProviderSkillInput,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  createTurnInteractionCommandHandler,
  type TurnInteractionCommandDependencies,
} from "../../src/server/runtime/commands/turn-interaction-commands";

const conversationId = "11111111-1111-4111-8111-111111111111";
const execFileAsync = promisify(execFile);
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

function messageCommand(
  activate?: boolean,
): Extract<ClientCommand, { type: "message.send" }> {
  return {
    type: "message.send",
    requestId: "33333333-3333-4333-8333-333333333333",
    payload: {
      conversationId,
      content: "Use the selected attachment.",
      attachments: [requestAttachment],
      ...(activate === undefined ? {} : { activate }),
    },
  };
}

function dependencies(options: {
  queue: ReturnType<typeof vi.fn>;
  relinquishAll: ReturnType<typeof vi.fn>;
  readiness?: ReturnType<typeof vi.fn>;
  resolveSkills?: Mock<(
    conversationId: string,
    skillIds: readonly string[],
  ) => Promise<ProviderSkillInput[]>>;
  assertTurnSkillsCurrent?: Mock<(
    conversationId: string,
    routeKey: string | null,
  ) => void>;
  conversationPath?: string;
  checkpointCount?: Mock<() => number>;
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
      conversationPath: vi.fn(() => options.conversationPath ?? tmpdir()),
      checkpointCount: options.checkpointCount ?? vi.fn(() => 0),
      addCheckpoint: vi.fn(() => ({
        id: "55555555-5555-4555-8555-555555555555",
      })),
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
    workflows: {
      resolveTurnSkills: vi.fn(async (
        selectedConversationId: string,
        skillIds: readonly string[],
      ) => ({
        inputs: await (
          options.resolveSkills ?? vi.fn(() => [])
        )(selectedConversationId, skillIds),
        routeKey: skillIds.length > 0 ? "test-route" : null,
      })),
      assertTurnSkillsCurrent:
        options.assertTurnSkillsCurrent ?? vi.fn(),
    } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerInfo: () => [provider],
    broadcast: vi.fn(),
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

  it("rejects stale skills before attempting a reversal checkpoint", async () => {
    const relinquishAll = vi.fn(async () => undefined);
    const queue = vi.fn();
    const resolveSkills = vi.fn(async () => {
      throw new Error("Selected skill is no longer available.");
    });
    const handlerDependencies = dependencies({
      queue,
      relinquishAll,
      resolveSkills,
    });
    const command = messageCommand();
    command.payload.skillIds = ["skill-1"];
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, command)).rejects.toThrow(
      "Selected skill is no longer available.",
    );
    expect(resolveSkills).toHaveBeenCalledWith(conversationId, ["skill-1"]);
    expect(handlerDependencies.store.conversationPath).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
  });

  it("revalidates skills before checkpoint work and passes them to the turn", async () => {
    const skill = {
      source: "codex-native" as const,
      name: "review",
      path: "/workspace/project/.codex/skills/review/SKILL.md",
    };
    const resolveSkills = vi.fn(async () => [skill]);
    const queue = vi.fn(() => ({
      turn: { id: "44444444-4444-4444-8444-444444444444" },
    }));
    const handlerDependencies = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
      resolveSkills,
    });
    const command = messageCommand();
    command.payload.skillIds = ["skill-1"];
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, command)).resolves.toBe("handled");
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      skills: [skill],
    }));
    expect(resolveSkills.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(handlerDependencies.store.conversationPath)
        .mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(handlerDependencies.workflows.assertTurnSkillsCurrent)
        .mock.invocationCallOrder[0],
    ).toBeLessThan(queue.mock.invocationCallOrder[0]!);
    expect(handlerDependencies.broadcast).toHaveBeenCalledWith({
      type: "conversation.detail.invalidated",
      conversationId,
    });
  });

  it("rejects a changed skill route before persisting its checkpoint", async () => {
    const repository = await mkdtemp(join(tmpdir(), "inertia-skill-route-"));
    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, "request.txt"), "pending\n");
      const relinquishAll = vi.fn(async () => undefined);
      const queue = vi.fn();
      const assertTurnSkillsCurrent = vi.fn(() => {
        throw new Error("The provider route changed.");
      });
      const handlerDependencies = dependencies({
        queue,
        relinquishAll,
        conversationPath: repository,
        resolveSkills: vi.fn(async () => [{
          source: "codex-native" as const,
          name: "review",
          path: join(repository, ".codex", "skills", "review", "SKILL.md"),
        }]),
        assertTurnSkillsCurrent,
      });
      const command = messageCommand();
      command.payload.skillIds = ["skill-1"];
      const handler = createTurnInteractionCommandHandler(
        handlerDependencies,
      );

      await expect(handler({} as never, command)).rejects.toThrow(
        "The provider route changed.",
      );
      expect(assertTurnSkillsCurrent).toHaveBeenCalledWith(
        conversationId,
        "test-route",
      );
      expect(handlerDependencies.store.addCheckpoint).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
      expect(relinquishAll).toHaveBeenCalledWith([trustedAttachment.id]);
      const { stdout } = await execFileAsync("git", [
        "-C",
        repository,
        "for-each-ref",
        "--format=%(refname)",
        `refs/inertia/checkpoints/${conversationId}/`,
      ]);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("removes a captured checkpoint when its metadata cannot be counted", async () => {
    const repository = await mkdtemp(join(tmpdir(), "inertia-checkpoint-count-"));
    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, "request.txt"), "pending\n");
      const queue = vi.fn(() => ({
        turn: { id: "44444444-4444-4444-8444-444444444444" },
      }));
      const handlerDependencies = dependencies({
        queue,
        relinquishAll: vi.fn(async () => undefined),
        conversationPath: repository,
        checkpointCount: vi.fn(() => {
          throw new Error("checkpoint count unavailable");
        }),
      });
      const handler = createTurnInteractionCommandHandler(
        handlerDependencies,
      );

      await expect(handler({} as never, messageCommand())).resolves.toBe(
        "handled",
      );
      expect(handlerDependencies.store.addCheckpoint).not.toHaveBeenCalled();
      expect(queue).toHaveBeenCalledOnce();
      const { stdout } = await execFileAsync("git", [
        "-C",
        repository,
        "for-each-ref",
        "--format=%(refname)",
        `refs/inertia/checkpoints/${conversationId}/`,
      ]);
      expect(stdout.trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
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

  it("preserves a background conversation when queueing a split-pane turn", async () => {
    const queue = vi.fn(() => ({
      turn: { id: "44444444-4444-4444-8444-444444444444" },
    }));
    const handlerDependencies = dependencies({
      queue,
      relinquishAll: vi.fn(async () => undefined),
    });
    const handler = createTurnInteractionCommandHandler(handlerDependencies);

    await expect(handler({} as never, messageCommand(false))).resolves.toBe(
      "handled",
    );
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({
      conversationId,
      activateConversation: false,
    }));
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
