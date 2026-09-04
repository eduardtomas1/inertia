import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentInputRequest, RuntimeMutationEvent } from "../../src/shared/contracts";
import {
  ConversationContextRequestCoordinator,
  type ConversationContextAuthorizationScope,
} from "../../src/server/runtime/conversation-context-request-coordinator";
import {
  pendingInteractionForOwner,
  registerPendingInteraction,
} from "../../src/server/runtime/pending-interaction-registry";

const scope: ConversationContextAuthorizationScope = {
  contextRequestId: "ce11f2e6-f879-474d-9eb6-d8c5a78dc79a",
  targetConversationId: "99185440-7d51-4361-9a06-1a17f6373917",
  targetTurnId: "d72b2707-c76a-4a07-bef1-c6d22fd719bf",
  targetRunId: "run-context",
  toolCallIdHash: "a".repeat(64),
};
const sourceConversationId = "ba30e50d-66b0-4019-b33f-156733e65bd7";
const sourceMessageId = "79235532-5538-4d22-a66a-836bc28f97f3";

function fixture(timeoutMs = 1_000) {
  const pendingInputs = new Map<string, AgentInputRequest>();
  const events: RuntimeMutationEvent[] = [];
  const coordinator = new ConversationContextRequestCoordinator({
    pendingInputs,
    broadcast: (event) => events.push(event),
    broadcastConversationShell: vi.fn(),
    timeoutMs,
  });
  return { coordinator, events, pendingInputs };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationContextRequestCoordinator", () => {
  it("mints an unforgeable exact one-shot receipt only after renderer selection", async () => {
    const { coordinator, events, pendingInputs } = fixture();
    const controller = new AbortController();
    const outcomePromise = coordinator.request({
      scope,
      providerId: "codex",
      requestedSourceConversationId: sourceConversationId,
      createdAt: "2026-08-20T10:00:00.000Z",
      signal: controller.signal,
    });

    expect(pendingInteractionForOwner(pendingInputs, {
      providerId: "codex",
      conversationId: scope.targetConversationId,
      runId: scope.targetRunId,
      turnId: scope.targetTurnId,
    }, scope.contextRequestId)).toMatchObject({
      questions: [],
      conversationContextRequest: {
        requestedSourceConversationId: sourceConversationId,
      },
    });
    expect(coordinator.sourceAllowed(
      scope.contextRequestId,
      scope.targetConversationId,
      "84b91623-f909-4ddf-8246-34635034405f",
    )).toBe(false);
    expect(coordinator.consume({}, scope)).toBeNull();
    expect(coordinator.respond({
      requestId: scope.contextRequestId,
      targetConversationId: scope.targetConversationId,
      selection: {
        sourceConversationId,
        sourceMessageIds: [sourceMessageId],
        acknowledgedWorkspaceDifference: true,
      },
    })).toBe(true);

    const outcome = await outcomePromise;
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") throw new Error("Expected selection");
    expect(coordinator.consume(outcome.authorization.receipt, {
      ...scope,
      targetTurnId: "9ceba9aa-ffab-455f-b59a-f08ed942653d",
    })).toBeNull();
    expect(coordinator.consume(outcome.authorization.receipt, scope)).toEqual({
      sourceConversationId,
      sourceMessageIds: [sourceMessageId],
      acknowledgedWorkspaceDifference: true,
    });
    expect(coordinator.consume(outcome.authorization.receipt, scope)).toBeNull();
    expect(pendingInputs.size).toBe(0);
    expect(events.map(({ type }) => type)).toEqual([
      "agent.input.requested",
      "agent.input.resolved",
    ]);
  });

  it("settles cancellation, timeout, and turn interruption without leaving UI state", async () => {
    vi.useFakeTimers();
    const cancelled = fixture();
    const cancelledPromise = cancelled.coordinator.request({
      scope,
      providerId: "claude",
      requestedSourceConversationId: null,
      createdAt: "2026-08-20T10:00:00.000Z",
      signal: new AbortController().signal,
    });
    expect(cancelled.coordinator.respond({
      requestId: scope.contextRequestId,
      targetConversationId: scope.targetConversationId,
      selection: null,
    })).toBe(true);
    await expect(cancelledPromise).resolves.toEqual({
      kind: "cancelled",
      reason: "cancelled",
    });

    const expired = fixture(20);
    const expiredPromise = expired.coordinator.request({
      scope: { ...scope, contextRequestId: "3674a434-c57a-4e4c-a841-98e4966ec6b7" },
      providerId: "cursor",
      requestedSourceConversationId: null,
      createdAt: "2026-08-20T10:00:00.000Z",
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(20);
    await expect(expiredPromise).resolves.toEqual({
      kind: "cancelled",
      reason: "expired",
    });
    expect(expired.pendingInputs.size).toBe(0);

    const interrupted = fixture();
    const interruptedScope = {
      ...scope,
      contextRequestId: "fc3fdc33-d168-4d13-b284-b93fb1c8dd29",
    };
    const interruptedPromise = interrupted.coordinator.request({
      scope: interruptedScope,
      providerId: "opencode",
      requestedSourceConversationId: null,
      createdAt: "2026-08-20T10:00:00.000Z",
      signal: new AbortController().signal,
    });
    expect(interrupted.coordinator.cancelForTurn(
      scope.targetConversationId,
      scope.targetTurnId,
    )).toBe(1);
    await expect(interruptedPromise).resolves.toEqual({
      kind: "cancelled",
      reason: "interrupted",
    });
    expect(interrupted.pendingInputs.size).toBe(0);

    const deletedSource = fixture();
    const deletedPromise = deletedSource.coordinator.request({
      scope: { ...scope, contextRequestId: "31d1b339-caf6-45b4-8621-6fd73dc99526" },
      providerId: "codex",
      requestedSourceConversationId: sourceConversationId,
      createdAt: "2026-08-20T10:00:00.000Z",
      signal: new AbortController().signal,
    });
    expect(deletedSource.coordinator.cancelForSource(sourceConversationId))
      .toBe(1);
    await expect(deletedPromise).resolves.toEqual({
      kind: "cancelled",
      reason: "interrupted",
    });
  });

  it("does not overwrite or clean up another turn with the same request id", async () => {
    const { coordinator, pendingInputs } = fixture();
    const otherTurn = {
      id: scope.contextRequestId,
      providerId: "claude" as const,
      conversationId: "conversation-other",
      runId: "run-other",
      turnId: "turn-other",
      questions: [],
      autoResolutionMs: null,
    };
    expect(registerPendingInteraction(pendingInputs, otherTurn)).toBe(true);

    const outcomePromise = coordinator.request({
      scope,
      providerId: "codex",
      requestedSourceConversationId: null,
      createdAt: "2026-08-20T10:00:00.000Z",
      signal: new AbortController().signal,
    });
    expect(pendingInputs.size).toBe(2);
    expect(coordinator.respond({
      requestId: scope.contextRequestId,
      targetConversationId: scope.targetConversationId,
      selection: null,
    })).toBe(true);

    await expect(outcomePromise).resolves.toEqual({
      kind: "cancelled",
      reason: "cancelled",
    });
    expect(pendingInputs.size).toBe(1);
    expect(pendingInteractionForOwner(
      pendingInputs,
      otherTurn,
      otherTurn.id,
    )).toBe(otherTurn);
  });
});
