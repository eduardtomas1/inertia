import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AppSnapshot,
  type ConversationShell,
  type ServerEvent,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

const primaryId = "11111111-1111-4111-8111-111111111111";
const secondaryId = "22222222-2222-4222-8222-222222222222";

function conversation(id: string): ConversationShell {
  return {
    id,
    projectId: `${id}-project`,
    title: id === primaryId ? "Primary" : "Secondary",
    providerId: "codex",
    model: "default",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    branch: null,
    worktreePath: null,
    status: "needs-input",
    attentionKind: "approval",
    settledAt: null,
    archivedAt: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    completedAt: null,
    lastViewedAt: null,
    providerSessionId: null,
    latestTurn: null,
    pendingApproval: true,
    pendingInput: true,
  };
}

const snapshot: AppSnapshot = {
  projects: [],
  conversations: [
    conversation(primaryId),
    conversation(secondaryId),
  ],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: `${primaryId}-project`,
  activeConversationId: primaryId,
  settings: { ...defaultSettings },
};

function approval(
  conversationId: string,
  id = `${conversationId}-approval`,
): AgentApprovalRequest {
  return {
    id,
    providerId: "codex",
    conversationId,
    runId: `${conversationId}-run`,
    turnId: `${conversationId}-turn`,
    kind: "command",
    title: "Run tests",
    detail: null,
    command: "npm test",
    cwd: "/workspace",
    reason: null,
    networkScope: null,
    permissionRoots: [],
    availableDecisions: ["approve", "deny"],
  };
}

function inputRequest(conversationId: string): AgentInputRequest {
  return {
    id: `${conversationId}-input`,
    providerId: "codex",
    conversationId,
    runId: `${conversationId}-run`,
    turnId: `${conversationId}-turn`,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: [{
        id: "yes",
        label: "Yes",
        description: "Continue the run.",
      }],
    }],
    autoResolutionMs: null,
  };
}

function createEventSource() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe(listener: (event: ServerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: ServerEvent) {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
  };
}

function renderProjection(
  source: ReturnType<typeof createEventSource>,
  initialProps: {
    enabled: boolean;
    targetConversationId: string | null;
  },
) {
  const request = vi.fn(
    async (_command: CommandWithoutId): Promise<ServerEvent> => {
      throw new Error("Offline projections must not load detail.");
    },
  );
  return renderHook(
    (props: {
      enabled: boolean;
      targetConversationId: string | null;
    }) => useConversationProjection({
      snapshot,
      status: "offline",
      request,
      subscribe: source.subscribe,
      targetConversationId: props.targetConversationId,
      enabled: props.enabled,
      autoOpenPlan: false,
      onOpenPlan: vi.fn(),
      onTerminal: vi.fn(),
    }),
    { initialProps },
  );
}

describe("useConversationProjection pending interactions", () => {
  it("retains hydrated requests while a secondary pane is closed and reopened", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: false,
      targetConversationId: null,
    });
    const pendingApproval = approval(secondaryId);
    const pendingInput = inputRequest(secondaryId);

    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
    });
    source.emit({
      type: "agent.approval.requested",
      request: pendingApproval,
    });
    source.emit({
      type: "agent.input.requested",
      request: pendingInput,
    });

    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([pendingApproval]);
    expect(hook.result.current.pendingInputs).toEqual([pendingInput]);

    hook.rerender({
      enabled: false,
      targetConversationId: null,
    });
    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([pendingApproval]);
    expect(hook.result.current.pendingInputs).toEqual([pendingInput]);

    hook.rerender({
      enabled: false,
      targetConversationId: null,
    });
    source.emit({
      type: "agent.approval.resolved",
      conversationId: secondaryId,
      runId: pendingApproval.runId,
      turnId: pendingApproval.turnId,
      requestId: pendingApproval.id,
      decision: "approve",
    });
    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.pendingInputs).toEqual([pendingInput]);

    hook.rerender({
      enabled: false,
      targetConversationId: null,
    });
    source.emit({
      type: "agent.input.resolved",
      conversationId: secondaryId,
      runId: pendingInput.runId,
      turnId: pendingInput.turnId,
      requestId: pendingInput.id,
    });
    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.pendingInputs).toEqual([]);
  });

  it("retains hydrated background requests without exposing another chat's controls", () => {
    const source = createEventSource();
    const hook = renderProjection(source, {
      enabled: true,
      targetConversationId: primaryId,
    });
    const primaryApproval = approval(primaryId);
    const secondaryApproval = approval(secondaryId);
    const secondaryInput = inputRequest(secondaryId);

    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
    });
    source.emit({
      type: "agent.approval.requested",
      request: primaryApproval,
    });
    source.emit({
      type: "agent.approval.requested",
      request: secondaryApproval,
    });
    source.emit({
      type: "agent.input.requested",
      request: secondaryInput,
    });

    expect(hook.result.current.pendingApprovals).toEqual([primaryApproval]);
    expect(hook.result.current.pendingInputs).toEqual([]);

    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([
      secondaryApproval,
    ]);
    expect(hook.result.current.pendingInputs).toEqual([secondaryInput]);

    source.emit({
      type: "server.welcome",
      protocolVersion: 1,
      snapshot,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);
    expect(hook.result.current.pendingInputs).toEqual([]);

    source.emit({
      type: "agent.approval.requested",
      request: secondaryApproval,
    });
    hook.rerender({
      enabled: true,
      targetConversationId: primaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([]);

    hook.rerender({
      enabled: true,
      targetConversationId: secondaryId,
    });
    expect(hook.result.current.pendingApprovals).toEqual([
      secondaryApproval,
    ]);
  });
});
