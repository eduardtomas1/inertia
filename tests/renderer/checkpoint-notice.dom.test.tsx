import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentActivity, AgentTurn, ChatAttachment, ChatMessage, CheckpointSummary } from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestedAt = "2026-07-23T10:00:00.000Z";

function turn(checkpointId: string | null = null): AgentTurn {
  return {
    id: "turn-1",
    conversationId,
    runId: "run-1",
    userMessageId: "user-1",
    terminalAssistantMessageId: null,
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
    requestedAt,
    startedAt: "2026-07-23T10:00:01.000Z",
    completedAt: "2026-07-23T10:00:02.000Z",
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 3,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: "2026-07-23T10:00:02.000Z",
  };
}

function message(content: string, attachments: ChatAttachment[] = []): ChatMessage {
  return {
    id: "user-1",
    conversationId,
    turnId: "turn-1",
    role: "user",
    content,
    attachments,
    createdAt: requestedAt,
  };
}

const notice: AgentActivity = {
  id: "activity-checkpoint",
  conversationId,
  runId: "run-1",
  turnId: "turn-1",
  kind: "status",
  title: "No checkpoint for this turn",
  detail: "Checkpoint operation timed out.",
  status: "completed",
  createdAt: "2026-07-23T10:00:01.000Z",
};

function checkpoint(id: string, label: string, createdAt: string): CheckpointSummary {
  return {
    id,
    conversationId,
    turnId: "turn-1",
    ref: `refs/inertia/checkpoints/${id}`,
    label,
    turnIndex: 1,
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
    createdAt,
  };
}

function timeline(props: {
  checkpointId: string | null;
  checkpoints: CheckpointSummary[];
  activities?: AgentActivity[];
  checkpointRestoreDisabled?: boolean;
  onRevertCheckpoint?: (checkpoint: CheckpointSummary) => void;
}): React.ReactElement {
  return createElement(ResponseTimeline, {
    turns: [turn(props.checkpointId)],
    messages: [message("Change the build.")],
    activities: props.activities ?? [],
    reasonings: [],
    plans: [],
    checkpoints: props.checkpoints,
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
    checkpointRestoreDisabled: props.checkpointRestoreDisabled ?? false,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onRevertCheckpoint: props.onRevertCheckpoint ?? (() => undefined),
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
    onStop: () => undefined,
  });
}

describe("attributed recovery checkpoints", () => {
  afterEach(cleanup);

  const own = checkpoint("own", "Turn 1", "2026-07-23T10:00:00.000Z");
  const fileRestore = checkpoint("file-restore", "Before file restore", "2026-07-23T10:05:00.000Z");
  const checkpointRestore = checkpoint("checkpoint-restore", "Before checkpoint restore", "2026-07-23T10:09:00.000Z");

  it("offers each recovery checkpoint next to Revert, in order, from the keyboard", async () => {
    const user = userEvent.setup();
    const onRevertCheckpoint = vi.fn();
    render(timeline({
      checkpointId: own.id,
      checkpoints: [checkpointRestore, own, fileRestore],
      onRevertCheckpoint,
    }));

    const actions = screen.getAllByRole("button", { name: /^Revert$|^Restore checkpoint:/u });
    expect(actions.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Revert",
      "Restore checkpoint: Before file restore",
      "Restore checkpoint: Before checkpoint restore",
    ]);
    expect(actions[1]).toHaveTextContent("Before file restore");
    expect(actions[1]).toHaveAccessibleDescription("Restore the project to this checkpoint");
    expect(screen.queryByText("Recovered legacy history")).toBeNull();

    actions[0]!.focus();
    await user.tab();
    expect(actions[1]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRevertCheckpoint).toHaveBeenCalledWith(fileRestore);
  });

  it("shows a recovery checkpoint on a turn without its own checkpoint and disables it with Revert", () => {
    const onRevertCheckpoint = vi.fn();
    render(timeline({
      checkpointId: null,
      checkpoints: [fileRestore, checkpointRestore],
      checkpointRestoreDisabled: true,
      onRevertCheckpoint,
    }));

    expect(screen.getByRole("button", { name: /^Revert$/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore checkpoint: Before checkpoint restore" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Restore checkpoint: Before file restore" })).toBeNull();
    expect(screen.queryByText("Recovered legacy history")).toBeNull();
  });
});

describe("missing checkpoint notice", () => {
  afterEach(cleanup);

  it("gives keyboard and screen-reader users the reason, not only a hover title", () => {
    const { container } = render(createElement(ResponseTimeline, {
    turns: [turn()],
    messages: [message("Change the build.")],
    activities: [notice],
    reasonings: [],
    plans: [],
    checkpoints: [],
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
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
    onStop: () => undefined,
    }));

    const label = container.querySelector(".message-checkpoint-missing");
    expect(label?.textContent).toBe("No checkpoint for this turn: Checkpoint operation timed out.");
    expect(label?.getAttribute("title")).toBeNull();
    expect(screen.getByText(": Checkpoint operation timed out.").classList.contains("visually-hidden")).toBe(true);
  });
});
