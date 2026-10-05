import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentActivity, AgentTurn, ChatAttachment, ChatMessage } from "../../src/shared/contracts";

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
    expect(label?.getAttribute("title")).toBe("Checkpoint operation timed out.");
    expect(screen.getByText(": Checkpoint operation timed out.").classList.contains("visually-hidden")).toBe(true);
  });
});
