import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import { CompatibilityTimeline } from "../../src/renderer/src/components/response-timeline/compatibility";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/response-timeline/types";
import { buildResponseTimeline } from "../../src/renderer/src/utils/responseTimeline";

const legacyMessage: ChatMessage = {
  id: "legacy-message",
  conversationId: "conversation-1",
  turnId: null,
  role: "user",
  content: "Recovered history stays lazy.",
  attachments: [],
  createdAt: "2026-08-03T12:00:00.000Z",
};
const largeLegacyHistory = Array.from({ length: 120 }, (_, index): ChatMessage => ({
  ...legacyMessage,
  id: `legacy-message-${index}`,
  content: `${legacyMessage.content} ${index}`,
}));

function inferredTurnWithLargeAnswer() {
  const turnId = "inferred-heavy-turn";
  const request: ChatMessage = {
    ...legacyMessage,
    id: "inferred-heavy-request",
    turnId,
    content: "Recover the large inferred answer.",
  };
  const answer: ChatMessage = {
    ...legacyMessage,
    id: "inferred-heavy-answer",
    turnId,
    role: "assistant",
    content: `INFERRED_HEAVY_ANSWER ${"x".repeat(400_000)}`,
  };
  const turn: AgentTurn = {
    id: turnId,
    conversationId: legacyMessage.conversationId,
    runId: "inferred-heavy-run",
    userMessageId: request.id,
    terminalAssistantMessageId: answer.id,
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
      backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: "latest",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: request.createdAt,
    startedAt: request.createdAt,
    completedAt: answer.createdAt,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "inferred",
    createdAt: request.createdAt,
    updatedAt: answer.createdAt,
  };
  const item = buildResponseTimeline({
    turns: [turn],
    messages: [request, answer],
    activities: [],
    reasonings: [],
    checkpoints: [],
  })[0];
  if (item?.kind !== "compatibility" || item.compatibility.inferredTurns.length !== 1) {
    throw new Error("Expected one inferred compatibility turn");
  }
  return item.compatibility.inferredTurns[0]!;
}

function timelineProps(messages: ChatMessage[]): ResponseTimelineProps {
  return {
    turns: [],
    messages,
    activities: [],
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-1",
    conversationId: "conversation-1",
    streamingText: "",
    streamingReasoning: "",
    approvals: [],
    inputRequests: [],
    showTimestamps: false,
    showThinking: false,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: false,
    checkpointRestoreDisabled: false,
    onRespondToApproval: vi.fn(async () => undefined),
    onRespondToInput: vi.fn(async () => undefined),
    onRevertCheckpoint: vi.fn(),
    onOpenTurnDiff: vi.fn(),
    onCompareTurnArtifacts: vi.fn(),
    onOpenTurnFile: vi.fn(),
    onStop: vi.fn(),
  };
}

describe("CompatibilityTimeline", () => {
  it("keeps an ordinary recovered history visible", () => {
    render(
      <CompatibilityTimeline
        compatibility={{
          inferredTurns: [],
          malformedTurns: [],
          messages: [legacyMessage],
          activities: [],
          reasonings: [],
          plans: [],
          checkpoints: [],
        }}
        props={timelineProps([legacyMessage])}
      />,
    );

    expect(screen.getByText(legacyMessage.content)).toBeInTheDocument();
  });

  it("does not mount a large recovered history until the disclosure is opened", () => {
    const { container } = render(
      <CompatibilityTimeline
        compatibility={{
          inferredTurns: [],
          malformedTurns: [],
          messages: largeLegacyHistory,
          activities: [],
          reasonings: [],
          plans: [],
          checkpoints: [],
        }}
        props={timelineProps(largeLegacyHistory)}
      />,
    );

    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.queryByText(`${legacyMessage.content} 0`)).not.toBeInTheDocument();

    details!.open = true;
    fireEvent(details!, new Event("toggle"));
    expect(screen.getByText(`${legacyMessage.content} 0`)).toBeInTheDocument();

    details!.open = false;
    fireEvent(details!, new Event("toggle"));
    expect(screen.queryByText(`${legacyMessage.content} 0`)).not.toBeInTheDocument();
  });

  it("collapses immediately when recovered history grows from ordinary to expensive", () => {
    const ordinaryCompatibility = {
      inferredTurns: [],
      malformedTurns: [],
      messages: [legacyMessage],
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
    };
    const expensiveCompatibility = {
      ...ordinaryCompatibility,
      messages: largeLegacyHistory,
    };
    const { container, rerender } = render(
      <CompatibilityTimeline
        compatibility={ordinaryCompatibility}
        props={timelineProps(ordinaryCompatibility.messages)}
      />,
    );

    expect(screen.getByText(legacyMessage.content)).toBeInTheDocument();

    rerender(
      <CompatibilityTimeline
        compatibility={expensiveCompatibility}
        props={timelineProps(expensiveCompatibility.messages)}
      />,
    );

    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(screen.queryByText(`${legacyMessage.content} 0`))
      .not.toBeInTheDocument();
  });

  it("preserves an explicit expansion while expensive history keeps growing", () => {
    const expensiveCompatibility = {
      inferredTurns: [],
      malformedTurns: [],
      messages: largeLegacyHistory,
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
    };
    const { container, rerender } = render(
      <CompatibilityTimeline
        compatibility={expensiveCompatibility}
        props={timelineProps(expensiveCompatibility.messages)}
      />,
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    details!.open = true;
    fireEvent(details!, new Event("toggle"));
    expect(screen.getByText(`${legacyMessage.content} 0`)).toBeInTheDocument();

    const growingCompatibility = {
      ...expensiveCompatibility,
      messages: [
        ...largeLegacyHistory,
        {
          ...legacyMessage,
          id: "legacy-message-latest",
          content: "Recovered while the disclosure is open.",
        },
      ],
    };
    rerender(
      <CompatibilityTimeline
        compatibility={growingCompatibility}
        props={timelineProps(growingCompatibility.messages)}
      />,
    );

    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.getByText("Recovered while the disclosure is open."))
      .toBeInTheDocument();
  });

  it("does not mount a single expensive inferred turn by default", () => {
    const inferredTurn = inferredTurnWithLargeAnswer();
    const { container } = render(
      <CompatibilityTimeline
        compatibility={{
          inferredTurns: [inferredTurn],
          malformedTurns: [],
          messages: [],
          activities: [],
          reasonings: [],
          plans: [],
          checkpoints: [],
        }}
        props={timelineProps([])}
      />,
    );

    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(container.textContent).not.toContain("INFERRED_HEAVY_ANSWER");
  });

  it.each([
    {
      label: "reasoning",
      marker: "HEAVY_ORPHAN_REASONING",
      compatibility: {
        inferredTurns: [],
        malformedTurns: [],
        messages: [],
        activities: [],
        reasonings: [{
          id: "heavy-reasoning",
          conversationId: legacyMessage.conversationId,
          runId: "heavy-reasoning-run",
          turnId: null,
          content: `HEAVY_ORPHAN_REASONING ${"x".repeat(400_000)}`,
          status: "completed" as const,
          createdAt: legacyMessage.createdAt,
        }],
        plans: [],
        checkpoints: [],
      },
    },
    {
      label: "plan",
      marker: "HEAVY_ORPHAN_PLAN",
      compatibility: {
        inferredTurns: [],
        malformedTurns: [],
        messages: [],
        activities: [],
        reasonings: [],
        plans: [{
          conversationId: legacyMessage.conversationId,
          runId: "heavy-plan-run",
          turnId: null,
          explanation: null,
          steps: [{
            step: `HEAVY_ORPHAN_PLAN ${"x".repeat(400_000)}`,
            status: "pending" as const,
          }],
        }],
        checkpoints: [],
      },
    },
  ])("does not mount expensive orphan $label content by default", ({
    compatibility,
    marker,
  }) => {
    const { container } = render(
      <CompatibilityTimeline
        compatibility={compatibility}
        props={timelineProps([])}
      />,
    );

    expect(container.querySelector("details")).not.toHaveAttribute("open");
    expect(container.textContent).not.toContain(marker);
  });
});
