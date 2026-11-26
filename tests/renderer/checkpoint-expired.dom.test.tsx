import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS } from "../../src/renderer/src/components/Tooltip";
import type {
  AgentTurn,
  ChatMessage,
  CheckpointSummary,
  TurnGitArtifact,
} from "../../src/shared/contracts";
import {
  CHECKPOINT_EXPIRED_DESCRIPTION,
  CHECKPOINT_EXPIRED_LABEL,
  TURN_COMPARE_EXPIRED_DESCRIPTION,
} from "../../src/shared/turn-checkpoint";

const conversationId = "11111111-1111-4111-8111-111111111111";

function makeTurn(id: string, userMessageId: string, checkpointId: string | null, at: string): AgentTurn {
  return {
    id,
    conversationId,
    runId: `run-${id}`,
    userMessageId,
    terminalAssistantMessageId: `assistant-${id}`,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: "latest",
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 3,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 3,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: "latest",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: "session-after",
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 3,
    association: "authoritative",
    createdAt: at,
    updatedAt: at,
  };
}

function makeMessage(id: string, turnId: string, role: "user" | "assistant", content: string, at: string): ChatMessage {
  return {
    id,
    conversationId,
    turnId,
    role,
    content,
    attachments: [],
    createdAt: at,
  };
}

function makeArtifact(turnId: string, afterSnapshotExpired?: boolean): TurnGitArtifact {
  return {
    id: `artifact-${turnId}`,
    turnId,
    conversationId,
    runId: `run-${turnId}`,
    repositoryIdentity: "a".repeat(64),
    worktreeIdentity: "b".repeat(64),
    branch: "main",
    beforeCheckpointId: null,
    beforeFingerprint: "c".repeat(64),
    afterFingerprint: "d".repeat(64),
    files: [{
      path: "src/app.ts",
      previousPath: null,
      status: "modified",
      insertions: 2,
      deletions: 1,
      binary: false,
      untracked: false,
      staged: false,
      unstaged: true,
      indexStatus: ".",
      worktreeStatus: "M",
    }],
    insertions: 2,
    deletions: 1,
    status: "ready",
    completeness: "complete",
    patchState: "available",
    patchDigest: "e".repeat(64),
    capturedAt: "2026-07-23T10:01:00.000Z",
    terminalAssistantMessageId: `assistant-${turnId}`,
    failureReason: null,
    absenceReason: null,
    ...(afterSnapshotExpired ? { afterSnapshotExpired: true } : {}),
  };
}

describe("expired checkpoint UI state", () => {
  afterEach(() => {
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_WARM_MS + 1);
    });
    vi.useRealTimers();
    cleanup();
  });

  it("disables expired turn checkpoints and recovered restore backups with an accessible explanation", () => {
    vi.useFakeTimers();
    const onRevertCheckpoint = vi.fn();
    const expiredTurnCheckpoint: CheckpointSummary = {
      id: "cp-turn-expired",
      conversationId,
      turnId: "turn-1",
      ref: `refs/inertia/checkpoints/${conversationId}/22222222-2222-4222-8222-222222222222`,
      label: "Before turn 1",
      turnIndex: 1,
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
      createdAt: "2026-07-23T10:00:00.000Z",
      expiredAt: "2026-07-24T10:00:00.000Z",
    };
    const expiredBackupCheckpoint: CheckpointSummary = {
      id: "cp-backup-expired",
      conversationId,
      turnId: null,
      ref: `refs/inertia/checkpoints/${conversationId}/33333333-3333-4333-8333-333333333333`,
      label: "Before checkpoint restore",
      turnIndex: 2,
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      createdAt: "2026-07-23T10:05:00.000Z",
      expiredAt: "2026-07-24T10:00:00.000Z",
    };

    render(createElement(ResponseTimeline, {
      turns: [makeTurn("turn-1", "user-1", expiredTurnCheckpoint.id, "2026-07-23T10:00:00.000Z")],
      messages: [
        makeMessage("user-1", "turn-1", "user", "Update config", "2026-07-23T10:00:00.000Z"),
        makeMessage("assistant-turn-1", "turn-1", "assistant", "Updated.", "2026-07-23T10:00:05.000Z"),
      ],
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [expiredTurnCheckpoint, expiredBackupCheckpoint],
      projectRoot: "/workspace",
      projectId: "project-1",
      conversationId,
      streamingText: "",
      streamingReasoning: "",
      approvals: [],
      inputRequests: [],
      showTimestamps: true,
      showThinking: false,
      defaultCodeWrap: false,
      autoCollapseWorkLog: true,
      showChangedFileSummaries: false,
      checkpointRestoreDisabled: false,
      onRespondToApproval: async () => undefined,
      onRespondToInput: async () => undefined,
      onRevertCheckpoint,
      onOpenTurnDiff: () => undefined,
      onCompareTurnArtifacts: () => undefined,
      onOpenTurnFile: () => undefined,
      onStop: () => undefined,
    }));

    const turnButton = screen.getByRole("button", { name: `Revert (${CHECKPOINT_EXPIRED_LABEL.toLowerCase()})` });
    expect(turnButton).toBeDisabled();
    expect(turnButton).toHaveTextContent(CHECKPOINT_EXPIRED_LABEL);
    expect(turnButton).toHaveAccessibleDescription(CHECKPOINT_EXPIRED_DESCRIPTION);

    const backupButton = screen.getByRole("button", { name: `Restore checkpoint (${CHECKPOINT_EXPIRED_LABEL.toLowerCase()})` });
    expect(backupButton).toBeDisabled();
    expect(backupButton).toHaveTextContent(CHECKPOINT_EXPIRED_LABEL);
    expect(backupButton).toHaveAccessibleDescription(CHECKPOINT_EXPIRED_DESCRIPTION);

    fireEvent.click(turnButton);
    fireEvent.click(backupButton);
    expect(onRevertCheckpoint).not.toHaveBeenCalled();

    fireEvent.pointerEnter(turnButton, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector('[role="tooltip"]')).toHaveTextContent(CHECKPOINT_EXPIRED_DESCRIPTION);
  });

  it("disables cross-turn compare when a turn post-snapshot has expired", () => {
    vi.useFakeTimers();
    const onCompareTurnArtifacts = vi.fn();

    render(createElement(ResponseTimeline, {
      turns: [
        makeTurn("turn-1", "user-1", null, "2026-07-23T10:00:00.000Z"),
        makeTurn("turn-2", "user-2", null, "2026-07-23T10:01:00.000Z"),
      ],
      messages: [
        makeMessage("user-1", "turn-1", "user", "First", "2026-07-23T10:00:00.000Z"),
        makeMessage("assistant-turn-1", "turn-1", "assistant", "Done 1", "2026-07-23T10:00:10.000Z"),
        makeMessage("user-2", "turn-2", "user", "Second", "2026-07-23T10:01:00.000Z"),
        makeMessage("assistant-turn-2", "turn-2", "assistant", "Done 2", "2026-07-23T10:01:10.000Z"),
      ],
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
      gitArtifacts: [
        makeArtifact("turn-1", true),
        makeArtifact("turn-2", false),
      ],
      projectRoot: "/workspace",
      projectId: "project-1",
      conversationId,
      streamingText: "",
      streamingReasoning: "",
      approvals: [],
      inputRequests: [],
      showTimestamps: true,
      showThinking: false,
      defaultCodeWrap: false,
      autoCollapseWorkLog: true,
      showChangedFileSummaries: true,
      checkpointRestoreDisabled: false,
      onRespondToApproval: async () => undefined,
      onRespondToInput: async () => undefined,
      onRevertCheckpoint: () => undefined,
      onOpenTurnDiff: () => undefined,
      onCompareTurnArtifacts,
      onOpenTurnFile: () => undefined,
      onStop: () => undefined,
    }));

    const compareButton = screen.getByRole("button", { name: "Compare unavailable" });
    expect(compareButton).toBeDisabled();
    expect(compareButton).toHaveAccessibleDescription(TURN_COMPARE_EXPIRED_DESCRIPTION);
    fireEvent.click(compareButton);
    expect(onCompareTurnArtifacts).not.toHaveBeenCalled();
  });
});
