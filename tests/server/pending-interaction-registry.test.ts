// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
} from "../../src/shared/contracts";
import { createPrivateConnectInputResponder } from "../../src/server/private-connect/input-response-admission";
import { resolvePersistedDuoInteractions } from "../../src/server/runtime/duo/duo-active-turn-quarantine";
import {
  deletePendingInteraction,
  pendingInteractionForConversation,
  pendingInteractionForOwner,
  registerPendingInteraction,
} from "../../src/server/runtime/pending-interaction-registry";

function inputRequest(overrides: Partial<AgentInputRequest> = {}): AgentInputRequest {
  return {
    id: "shared-request",
    providerId: "codex",
    conversationId: "conversation-a",
    runId: "run-a",
    turnId: "turn-a",
    questions: [],
    autoResolutionMs: null,
    ...overrides,
  };
}

function approvalRequest(
  overrides: Partial<AgentApprovalRequest> = {},
): AgentApprovalRequest {
  return {
    id: "shared-request",
    providerId: "codex",
    conversationId: "conversation-a",
    runId: "run-a",
    turnId: "turn-a",
    kind: "command",
    title: "Run command",
    detail: null,
    command: null,
    cwd: null,
    reason: null,
    networkScope: null,
    permissionRoots: [],
    availableDecisions: ["approve", "deny"],
    ...overrides,
  };
}

describe("pending interaction registry", () => {
  it("isolates the same provider request id across exact turn owners", () => {
    const pending = new Map<string, AgentInputRequest>();
    const first = inputRequest();
    const second = inputRequest({
      providerId: "claude",
      conversationId: "conversation-b",
      runId: "run-b",
      turnId: "turn-b",
    });

    expect(registerPendingInteraction(pending, first)).toBe(true);
    expect(registerPendingInteraction(pending, second)).toBe(true);
    expect(pending.size).toBe(2);
    expect(pendingInteractionForOwner(pending, first, first.id)).toBe(first);
    expect(pendingInteractionForOwner(pending, second, second.id)).toBe(second);

    expect(deletePendingInteraction(pending, first, first.id)).toBe(true);
    expect(pendingInteractionForOwner(pending, first, first.id)).toBeUndefined();
    expect(pendingInteractionForOwner(pending, second, second.id)).toBe(second);
  });

  it("fails closed when a renderer-scoped request is ambiguous", () => {
    const pending = new Map<string, AgentInputRequest>();
    const first = inputRequest();
    const second = inputRequest({ runId: "run-b", turnId: "turn-b" });

    registerPendingInteraction(pending, first);
    registerPendingInteraction(pending, second);

    expect(pendingInteractionForConversation(
      pending,
      first.conversationId,
      first.id,
    )).toBeUndefined();
  });

  it("rejects only exact duplicate ownership and preserves arbitrary ids", () => {
    const pending = new Map<string, AgentInputRequest>();
    const first = inputRequest({
      providerId: "claude",
      conversationId: "conversation|[\"a\"]",
      runId: "run|b",
      turnId: "turn|c",
      id: "request|d",
    });
    const duplicate = { ...first, questions: [{
      id: "question",
      header: "Header",
      question: "Question?",
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: [],
    }] };

    expect(registerPendingInteraction(pending, first)).toBe(true);
    expect(registerPendingInteraction(pending, duplicate)).toBe(false);
    expect(pending.size).toBe(1);
    expect(pendingInteractionForConversation(
      pending,
      first.conversationId,
      first.id,
    )).toBe(first);
  });

  it("settles persisted duo interactions without deleting a colliding turn", () => {
    const pendingApprovals = new Map<string, AgentApprovalRequest>();
    const target = approvalRequest();
    const collision = approvalRequest({
      providerId: "claude",
      conversationId: "conversation-b",
      runId: "run-b",
    });
    registerPendingInteraction(pendingApprovals, target);
    registerPendingInteraction(pendingApprovals, collision);
    const broadcast = vi.fn();

    resolvePersistedDuoInteractions({
      id: target.turnId,
      providerId: target.providerId,
      conversationId: target.conversationId,
      runId: target.runId,
    } as AgentTurn, {
      pendingApprovals,
      pendingInputs: new Map(),
      hooks: { broadcast } as never,
    });

    expect(pendingInteractionForOwner(
      pendingApprovals,
      target,
      target.id,
    )).toBeUndefined();
    expect(pendingInteractionForOwner(
      pendingApprovals,
      collision,
      collision.id,
    )).toBe(collision);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("scopes private-connect responses and rejects same-conversation ambiguity", () => {
    const pending = new Map<string, AgentInputRequest>();
    const first = inputRequest();
    const second = inputRequest({
      conversationId: "conversation-b",
      runId: "run-b",
      turnId: "turn-b",
    });
    registerPendingInteraction(pending, first);
    registerPendingInteraction(pending, second);
    const respondToInput = vi.fn(() => true);
    const respond = createPrivateConnectInputResponder(
      pending,
      { respondToInput },
    );

    expect(respond(second.conversationId, second.id, {})).toBe(true);
    expect(respondToInput).toHaveBeenLastCalledWith(
      second.conversationId,
      second.id,
      {},
    );

    registerPendingInteraction(pending, inputRequest({
      runId: "run-c",
      turnId: "turn-c",
    }));
    expect(respond(first.conversationId, first.id, {})).toBe(false);
    expect(respondToInput).toHaveBeenCalledTimes(1);
  });
});
