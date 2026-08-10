import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace } from "../../src/renderer/src/components/ChatWorkspace";
import type {
  AgentWorkflowState,
  AgentInputRequest,
  ChatMessage,
  Conversation,
  Project,
  TurnGitArtifact,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import type {
  TranscriptMessageSendAcceptance,
} from "../../src/renderer/src/utils/transcriptNavigation";
import type { FinalAnswerAutoScrollEvent } from "../../src/renderer/src/components/response-timeline/types";

vi.mock("../../src/renderer/src/hooks/useNativePreviewSuspension", () => ({
  useNativePreviewSuspension: () => undefined,
}));

const composerRenderCount = vi.hoisted(() => ({ value: 0 }));
const timelineCallbacks = new Map<
  string,
  (event: FinalAnswerAutoScrollEvent) => void
>();

vi.mock("../../src/renderer/src/components/Composer", async () => {
  const { memo } = await import("react");
  return {
    Composer: memo(function MockComposer({
      onSend,
    }: {
      onSend(content: string, attachments: []): Promise<void>;
    }): React.JSX.Element {
      composerRenderCount.value += 1;
      return (
        <button
          type="button"
          onClick={() => void onSend("Materialize this draft", [])}
        >
          Send materialized draft
        </button>
      );
    }),
  };
});

vi.mock("../../src/renderer/src/components/ResponseTimeline", () => ({
  ResponseTimeline: ({
    conversationId,
    turnAnchorId,
    inputRequests,
    onFinalAnswerAutoScroll,
  }: {
    conversationId: string;
    turnAnchorId: string | null;
    inputRequests: AgentInputRequest[];
    onFinalAnswerAutoScroll?: (event: FinalAnswerAutoScrollEvent) => void;
  }) => {
    if (onFinalAnswerAutoScroll) {
      timelineCallbacks.set(conversationId, onFinalAnswerAutoScroll);
    }
    return (
      <>
        <div data-testid="turn-anchor-projection">{turnAnchorId ?? "none"}</div>
        {inputRequests.map((request) => (
          <section id={`agent-input-request-${request.id}`} key={request.id}>
            <input aria-label={request.questions[0]?.question} />
          </section>
        ))}
      </>
    );
  },
}));

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Anchor project",
  path: "/anchor-project",
  normalizedPath: "/anchor-project",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#5555ff",
  status: "ready",
  createdAt: "2026-08-02T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
};

function conversation(
  id: string,
  providerId: Conversation["providerId"] = "codex",
  reasoningEffort = "medium",
): Conversation {
  return {
    id,
    projectId: project.id,
    title: id,
    providerId,
    modelSelection: nativeModelSelection({
      providerId,
      modelId: "provider-default",
      reasoningEffort,
    }),
    continuationIdentity: null,
    model: "",
    reasoningEffort,
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:00:00.000Z",
  };
}

function workspaceProps(
  activeConversation: Conversation,
  onSendMessage: ComponentProps<typeof ChatWorkspace>["onSendMessage"],
): ComponentProps<typeof ChatWorkspace> {
  return {
    project,
    conversation: activeConversation,
    latestTurnSummary: null,
    turns: [],
    messages: [],
    activities: [],
    subagents: [],
    reasonings: [],
    plans: [],
    checkpoints: [],
    turnGitArtifacts: [],
    streamingText: "",
    streamingReasoning: "",
    usage: null,
    skills: [],
    skillsCapability: null,
    selectedSkillIds: [],
    skillsLoading: false,
    skillsError: null,
    approvals: [],
    inputRequests: [],
    providers: [],
    backendProfiles: [],
    maintenanceStatus: null,
    maintenanceOperation: null,
    actions: [],
    mentionResults: [],
    showTimestamps: false,
    showThinking: false,
    usageDisplayMode: "compact",
    responseDensity: "default",
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: false,
    autoScrollToFinalAnswer: true,
    loading: false,
    sending: false,
    onAddProject: () => undefined,
    onCreateConversation: () => undefined,
    onSendMessage,
    onListSkills: async () => undefined,
    onToggleSkill: () => undefined,
    onClearSelectedSkills: () => undefined,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onUpdateConversation: async () => undefined,
    onCreateConversationForSelection: async () => undefined,
    onChooseAttachments: async () => [],
    onImportAttachments: async () => [],
    onReleaseAttachment: async () => undefined,
    onRunAction: () => undefined,
    onMentionQuery: () => undefined,
    onConnectProvider: () => undefined,
    onRefreshProvider: () => undefined,
    onOpenProviderSetup: () => undefined,
    onOpenBackendSetup: () => undefined,
    onOpenResume: () => undefined,
    onProbeBackendProfile: async () => undefined,
    onRefreshProviderMaintenance: async () => undefined,
    onUpdateProvider: async () => undefined,
    onCancelProviderUpdate: async () => undefined,
    onOpenProviderUpdateInstructions: () => undefined,
    onUsageDisplayModeChange: () => undefined,
    onStop: async () => undefined,
    onStopSubagent: async () => undefined,
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
  };
}

afterEach(() => {
  timelineCallbacks.clear();
  vi.restoreAllMocks();
});

describe("draft turn anchoring", () => {
  it("ignores a completed-answer callback owned by the previous conversation", async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const visible = vi.fn();
    const first = conversation("conversation-1");
    const second = conversation("conversation-2");
    const view = render(
      <ChatWorkspace
        {...workspaceProps(first, async () => null)}
        onLatestContentVisibilityChange={visible}
      />,
    );
    await screen.findByTestId("turn-anchor-projection");
    const firstCallback = timelineCallbacks.get(first.id)!;
    act(() => {
      firstCallback({
        status: "started",
        conversationId: first.id,
        answerId: "answer-1",
      });
    });

    view.rerender(
      <ChatWorkspace
        {...workspaceProps(second, async () => null)}
        onLatestContentVisibilityChange={visible}
      />,
    );
    await waitFor(() => expect(timelineCallbacks.has(second.id)).toBe(true));
    visible.mockClear();
    act(() => {
      firstCallback({
        status: "positioned",
        conversationId: first.id,
        answerId: "answer-1",
        followsLatest: false,
      });
    });

    expect(visible).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "cursor", "opencode"] as const)(
    "marks %s ultra reasoning for the animated frame",
    (providerId) => {
      const ultra = conversation(
        `conversation-ultra-${providerId}`,
        providerId,
        " Ultra ",
      );
      const view = render(
        <ChatWorkspace {...workspaceProps(ultra, async () => null)} />,
      );

      expect(view.container.querySelector(".chat-workspace"))
        .toHaveAttribute("data-reasoning-effort", "ultra");

      const high = conversation(
        `conversation-high-${providerId}`,
        providerId,
        "high",
      );
      view.rerender(
        <ChatWorkspace {...workspaceProps(high, async () => null)} />,
      );
      expect(view.container.querySelector(".chat-workspace"))
        .toHaveAttribute("data-reasoning-effort", "high");
    },
  );

  it("keeps a pending provider question actionable beside the composer", async () => {
    const request: AgentInputRequest = {
      id: "question-1",
      providerId: "codex",
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
      questions: [{
        id: "scope",
        header: "Scope",
        question: "Which module should change?",
        isOther: false,
        isSecret: false,
        allowMultiple: false,
        options: [],
      }],
      autoResolutionMs: null,
    };
    HTMLElement.prototype.scrollTo = vi.fn();
    render(
      <ChatWorkspace
        {...workspaceProps(conversation("conversation-1"), async () => null)}
        inputRequests={[request]}
      />,
    );

    expect(screen.getByText("Agent needs your answer")).toBeVisible();
    expect(screen.getByRole("button", { name: "Answer" }))
      .toHaveAttribute("aria-controls", "agent-input-request-question-1");
  });

  it("projects the accepted turn after the draft becomes server-owned", async () => {
    const draft = conversation("draft-conversation");
    const persisted = conversation("conversation-1");
    const acceptance: TranscriptMessageSendAcceptance = {
      kind: "message.accepted",
      conversationId: persisted.id,
      turnId: "turn-2",
      userMessageId: "message-2",
      disposition: "new-turn",
      materializedFromConversationId: draft.id,
    };
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    const onSendMessage = vi.fn(async () => acceptance);
    const view = render(
      <ChatWorkspace {...workspaceProps(draft, onSendMessage)} />,
    );

    await screen.findByTestId("turn-anchor-projection");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {
        name: "Send materialized draft",
      }));
      await Promise.resolve();
    });
    expect(onSendMessage).toHaveBeenCalledOnce();
    expect(screen.getByTestId("turn-anchor-projection")).toHaveTextContent(
      "none",
    );

    view.rerender(
      <ChatWorkspace {...workspaceProps(persisted, onSendMessage)} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("turn-anchor-projection")).toHaveTextContent(
        "turn-2",
      );
    });
    expect(scrollTo).toHaveBeenCalled();
  });

  it("does not carry a materialized draft anchor into an unrelated chat", async () => {
    const draft = conversation("draft-conversation");
    const persisted = conversation("conversation-1");
    const unrelated = conversation("conversation-unrelated");
    const acceptance: TranscriptMessageSendAcceptance = {
      kind: "message.accepted",
      conversationId: persisted.id,
      turnId: "turn-draft",
      userMessageId: "message-draft",
      disposition: "new-turn",
      materializedFromConversationId: draft.id,
    };
    let settleAcceptance!: (
      value: TranscriptMessageSendAcceptance,
    ) => void;
    const onSendMessage = vi.fn(() => (
      new Promise<TranscriptMessageSendAcceptance>((resolve) => {
        settleAcceptance = resolve;
      })
    ));
    const view = render(
      <ChatWorkspace {...workspaceProps(draft, onSendMessage)} />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", {
        name: "Send materialized draft",
      }));
    });
    expect(onSendMessage).toHaveBeenCalledOnce();

    view.rerender(
      <ChatWorkspace {...workspaceProps(unrelated, onSendMessage)} />,
    );
    await act(async () => {
      settleAcceptance(acceptance);
      await Promise.resolve();
    });
    expect(screen.getByTestId("turn-anchor-projection")).toHaveTextContent(
      "none",
    );

    view.rerender(
      <ChatWorkspace {...workspaceProps(persisted, onSendMessage)} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("turn-anchor-projection")).toHaveTextContent(
        "none",
      );
    });
  });
});

describe("transcript following motion", () => {
  it("keeps goal controls behind the Composer streaming boundary", async () => {
    const activeConversation = conversation("conversation-goal-boundary");
    const workflow: AgentWorkflowState = {
      conversationId: activeConversation.id,
      goalCapability: {
        kind: "inertia-local",
        available: true,
        label: "Inertia local goal",
        reason: "This route uses local objective tracking.",
      },
      goals: [],
      skills: [],
      skillsCapability: {
        kind: "unavailable",
        available: false,
        label: "Skills unavailable",
        reason: "Not part of this regression.",
      },
      goalRefreshWarning: null,
      skillDiscovery: {
        truncated: false,
        warningCount: 0,
        synchronizedAt: null,
      },
      refreshedAt: "2026-08-08T10:00:00.000Z",
    };
    const props = workspaceProps(activeConversation, async () => null);
    composerRenderCount.value = 0;
    const view = render(
      <ChatWorkspace
        {...props}
        goal={{
          workflow,
          loading: false,
          busy: false,
          error: null,
          onRetry: async () => undefined,
          onSetGoal: async () => undefined,
          onClearGoal: async () => undefined,
        }}
      />,
    );
    await screen.findByTestId("turn-anchor-projection");
    const initialRenderCount = composerRenderCount.value;

    view.rerender(
      <ChatWorkspace
        {...props}
        streamingText="partial response"
        goal={{
          workflow,
          loading: false,
          busy: false,
          error: null,
          onRetry: async () => undefined,
          onSetGoal: async () => undefined,
          onClearGoal: async () => undefined,
        }}
      />,
    );

    expect(composerRenderCount.value).toBe(initialRenderCount);
  });

  it("uses instant following through settlement and an explicit Jump", async () => {
    const activeConversation = conversation("conversation-follow");
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const props = workspaceProps(activeConversation, async () => null);
    const view = render(<ChatWorkspace {...props} streamingText="partial" />);
    await screen.findByTestId("turn-anchor-projection");
    scrollTo.mockClear();

    const terminalMessage: ChatMessage = {
      id: "terminal-message",
      conversationId: activeConversation.id,
      turnId: null,
      role: "assistant",
      content: "Settled answer",
      attachments: [],
      createdAt: "2026-08-02T10:00:01.000Z",
    };
    view.rerender(
      <ChatWorkspace
        {...props}
        messages={[terminalMessage]}
        streamingText=""
      />,
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(scrollTo.mock.calls.every(([options]) =>
      options?.behavior === "auto")).toBe(true);

    const settledArtifact: TurnGitArtifact = {
      id: "artifact-follow",
      turnId: "turn-follow",
      conversationId: activeConversation.id,
      runId: "run-follow",
      repositoryIdentity: null,
      worktreeIdentity: null,
      branch: "main",
      beforeCheckpointId: null,
      beforeFingerprint: null,
      afterFingerprint: null,
      files: [],
      insertions: 0,
      deletions: 0,
      status: "ready",
      completeness: "complete",
      patchState: "none",
      patchDigest: null,
      capturedAt: "2026-08-02T10:00:02.000Z",
      terminalAssistantMessageId: terminalMessage.id,
      failureReason: null,
      absenceReason: null,
    };
    scrollTo.mockClear();
    view.rerender(
      <ChatWorkspace
        {...props}
        messages={[terminalMessage]}
        turnGitArtifacts={[settledArtifact]}
        streamingText=""
      />,
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());

    const transcript = screen.getByLabelText("Thread transcript");
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.wheel(transcript);
    fireEvent.scroll(transcript);
    const jump = await screen.findByRole("button", { name: "Jump to latest" });
    scrollTo.mockClear();
    fireEvent.click(jump);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({
      behavior: "auto",
    }));
  });

  it("keeps correcting delayed virtual measurements until reader intent", async () => {
    const activeConversation = conversation("conversation-delayed-measurement");
    const scheduled = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const frameId = ++nextFrameId;
      scheduled.set(frameId, callback);
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frameId) => {
      scheduled.delete(frameId);
    });
    let height = 500;
    let scrollTop = 0;
    const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      const top = typeof options === "number" ? y ?? 0 : options?.top ?? 0;
      scrollTop = Math.min(Number(top), height - 100);
    });
    HTMLElement.prototype.scrollTo = scrollTo as typeof HTMLElement.prototype.scrollTo;
    const props = workspaceProps(activeConversation, async () => null);
    const view = render(<ChatWorkspace {...props} />);
    const transcript = screen.getByLabelText("Thread transcript");
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => height },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    const message: ChatMessage = {
      id: "delayed-measurement-message",
      conversationId: activeConversation.id,
      turnId: null,
      role: "assistant",
      content: "Measured on a later frame.",
      attachments: [],
      createdAt: "2026-08-02T10:00:01.000Z",
    };
    view.rerender(<ChatWorkspace {...props} messages={[message]} />);

    const firstFrame = [...scheduled.entries()].at(-1)!;
    scheduled.delete(firstFrame[0]);
    firstFrame[1](0);
    expect(scrollTop).toBe(400);
    expect(scheduled.size).toBe(1);

    height = 650;
    const secondFrame = [...scheduled.entries()].at(-1)!;
    scheduled.delete(secondFrame[0]);
    secondFrame[1](16);
    expect(scrollTop).toBe(550);
    expect(scheduled.size).toBe(1);

    fireEvent.wheel(transcript);
    height = 800;
    expect(scrollTop).toBe(550);
    expect(scheduled.size).toBe(0);

    scrollTo.mockClear();
    const lateMessage: ChatMessage = {
      ...message,
      id: "late-measurement-message",
      content: "A late content signal must not reclaim the reader.",
      createdAt: "2026-08-02T10:00:02.000Z",
    };
    view.rerender(
      <ChatWorkspace {...props} messages={[message, lateMessage]} />,
    );
    const lateContentFrame = [...scheduled.entries()].at(-1)!;
    scheduled.delete(lateContentFrame[0]);
    lateContentFrame[1](32);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollTop).toBe(550);
    expect(scheduled.size).toBe(0);
  });
});
