import { act, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace } from "../../src/renderer/src/components/ChatWorkspace";
import {
  streamingReaderActivityReceiptStage,
} from "../../src/renderer/src/utils/testStreamingTrace";
import type {
  AgentTurn,
  ChatMessage,
  Conversation,
  ConversationLatestTurnSummary,
  Project,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

vi.mock("../../src/renderer/src/hooks/useNativePreviewSuspension", () => ({
  useNativePreviewSuspension: () => undefined,
}));

vi.mock("../../src/renderer/src/components/Composer", () => ({
  Composer: () => <div data-testid="hydration-composer" />,
}));

const finalAnswerAnchorStarts = vi.hoisted(() => vi.fn());

vi.mock(
  "../../src/renderer/src/components/response-timeline/final-answer-anchor",
  async (importOriginal) => {
    const actual = await importOriginal<typeof import(
      "../../src/renderer/src/components/response-timeline/final-answer-anchor"
    )>();
    return {
      ...actual,
      startFinalAnswerAnchor: (
        ...args: Parameters<typeof actual.startFinalAnswerAnchor>
      ) => {
        finalAnswerAnchorStarts(...args);
        return actual.startFinalAnswerAnchor(...args);
      },
    };
  },
);

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Hydration project",
  path: "/hydration-project",
  normalizedPath: "/hydration-project",
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

function conversation(id: string): Conversation {
  return {
    id,
    projectId: project.id,
    title: id,
    providerId: "codex",
    modelSelection: providerNativeModelSelection({
      providerId: "codex",
      modelId: "provider-default",
      reasoningEffort: "high",
    }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    status: "running",
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

function turn(
  activeConversation: Conversation,
  index: number,
  status: "running" | "completed",
): AgentTurn {
  const at = `2026-08-02T10:00:${String(index).padStart(2, "0")}.000Z`;
  const completed = status === "completed";
  return {
    id: `${activeConversation.id}-turn-${index}`,
    conversationId: activeConversation.id,
    runId: `${activeConversation.id}-run-${index}`,
    userMessageId: `${activeConversation.id}-request-${index}`,
    terminalAssistantMessageId: completed
      ? `${activeConversation.id}-answer-${index}`
      : null,
    providerId: "codex",
    modelSelection: activeConversation.modelSelection,
    continuationIdentity: {
      harnessId: activeConversation.modelSelection.harnessId,
      backendProfileId: activeConversation.modelSelection.backendProfileId,
      backendConfigurationRevision:
        activeConversation.modelSelection.backendConfigurationRevision,
      endpointIdentity: null,
      modelIdentity: activeConversation.modelSelection.modelId,
    },
    harnessId: activeConversation.modelSelection.harnessId,
    backendProfileId: activeConversation.modelSelection.backendProfileId,
    model: activeConversation.modelSelection.modelId,
    modelAlias: activeConversation.modelSelection.alias,
    reasoningEffort: activeConversation.reasoningEffort,
    interactionMode: activeConversation.interactionMode,
    accessMode: activeConversation.accessMode,
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: at,
    startedAt: at,
    completedAt: completed ? at : null,
    status,
    terminalReason: completed ? "provider-completed" : null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at,
    updatedAt: at,
  };
}

function messagesForTurn(agentTurn: AgentTurn): ChatMessage[] {
  const request: ChatMessage = {
    id: agentTurn.userMessageId,
    conversationId: agentTurn.conversationId,
    turnId: agentTurn.id,
    role: "user",
    content: `Request ${agentTurn.id}`,
    attachments: [],
    createdAt: agentTurn.requestedAt,
  };
  if (!agentTurn.terminalAssistantMessageId) return [request];
  return [request, {
    id: agentTurn.terminalAssistantMessageId,
    conversationId: agentTurn.conversationId,
    turnId: agentTurn.id,
    role: "assistant",
    content: `Final answer ${agentTurn.id}`,
    attachments: [],
    createdAt: agentTurn.completedAt ?? agentTurn.updatedAt,
  }];
}

function latestTurnSummary(
  agentTurn: AgentTurn,
  status: "running" | "completed",
): ConversationLatestTurnSummary {
  return {
    id: agentTurn.id,
    runId: agentTurn.runId,
    status,
    providerId: agentTurn.providerId,
    harnessId: agentTurn.harnessId,
    backendProfileId: agentTurn.backendProfileId,
    modelSelection: agentTurn.modelSelection,
    continuationIdentity: agentTurn.continuationIdentity,
    model: agentTurn.model,
    reasoningEffort: agentTurn.reasoningEffort,
    requestedAt: agentTurn.requestedAt,
    startedAt: agentTurn.startedAt,
    completedAt: status === "completed" ? agentTurn.updatedAt : null,
    terminalReason: status === "completed" ? "provider-completed" : null,
    updatedAt: agentTurn.updatedAt,
  };
}

function workspaceProps(
  activeConversation: Conversation,
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
    onSendMessage: async () => null,
    onListSkills: async () => undefined,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onUpdateConversation: async () => undefined,
    onCreateConversationForSelection: async () => undefined,
    onChooseAttachments: async () => null,
    onImportAttachments: async () => null,
    onReleaseAttachment: async () => undefined,
    onRunAction: () => undefined,
    onMentionQuery: () => undefined,
    onConnectProvider: () => undefined,
    onRefreshProvider: () => undefined,
    onOpenProviderSetup: () => undefined,
    onOpenBackendSetup: () => undefined,
    onProbeBackendProfile: async () => undefined,
    onRefreshProviderMaintenance: async () => undefined,
    onUpdateProvider: async () => undefined,
    onCancelProviderUpdate: async () => undefined,
    onOpenProviderUpdateInstructions: () => undefined,
    onOpenResume: () => undefined,
    onUsageDisplayModeChange: () => undefined,
    onStop: async () => undefined,
    onStopSubagent: async () => undefined,
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
  };
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 800,
    bottom: top + height,
    left: 0,
    width: 800,
    height,
    toJSON: () => ({}),
  };
}

function installGeometry(targetAnswerId: string): {
  flushFrames: () => Promise<void>;
  setScrollTop: (value: number) => void;
} {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  let scrollTop = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("message-scroll") ? 600 : 120;
    });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("message-scroll")) return rect(100, 600);
      if (this.dataset.terminalAnswerId === targetAnswerId) {
        return rect(2_100 - scrollTop, 2_400);
      }
      return rect(0, 120);
    });
  vi.spyOn(HTMLElement.prototype, "scrollTo")
    .mockImplementation(function (
      this: HTMLElement,
      options?: ScrollToOptions | number,
      y?: number,
    ) {
      scrollTop = typeof options === "number"
        ? y ?? 0
        : options?.top ?? scrollTop;
      this.scrollTop = scrollTop;
    });
  return {
    setScrollTop: (value) => {
      scrollTop = value;
    },
    flushFrames: async () => {
      await act(async () => {
        let remaining = 300;
        while (frames.size > 0 && remaining > 0) {
          const [id, callback] = frames.entries().next().value!;
          frames.delete(id);
          callback(performance.now());
          remaining -= 1;
          await Promise.resolve();
        }
      });
    },
  };
}

async function expectLoadingConversation(): Promise<void> {
  const loading = await screen.findAllByRole("status", {
    name: "Loading conversation",
  });
  expect(loading.length).toBeGreaterThan(0);
  for (const marker of loading) expect(marker).toBeVisible();
}

async function expectVirtualWindow(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    expect(container.querySelector(".response-virtual-window")).not.toBeNull();
  }, { timeout: 5_000 });
}

afterEach(() => {
  finalAnswerAnchorStarts.mockReset();
  Reflect.deleteProperty(globalThis, "__inertiaTestStreamingTrace");
  vi.restoreAllMocks();
});

describe("ChatWorkspace final-answer hydration", () => {
  it("marks only the exact trailing reader activity committed at the workspace boundary", async () => {
    const activeConversation = conversation("conversation-stream-commit");
    const runningTurn = turn(activeConversation, 1, "running");
    const beforeMarker = "STREAM_PROVIDER_READER_ACTIVITY_1_BEFORE";
    const awayMarker = "STREAM_PROVIDER_READER_ACTIVITY_1_AWAY";
    const trace = vi.fn();
    Reflect.set(globalThis, "__inertiaTestStreamingTrace", trace);
    const props = workspaceProps(activeConversation);
    const view = render(
      <ChatWorkspace
        {...props}
        latestTurnSummary={latestTurnSummary(runningTurn, "running")}
        turns={[runningTurn]}
        messages={messagesForTurn(runningTurn)}
        streamingText={`${"earlier provider text ".repeat(20)}${beforeMarker} `}
      />,
    );
    await waitFor(() => expect(trace).toHaveBeenCalledWith(
      streamingReaderActivityReceiptStage(beforeMarker),
    ));
    trace.mockClear();

    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={latestTurnSummary(runningTurn, "running")}
        turns={[runningTurn]}
        messages={messagesForTurn(runningTurn)}
        streamingText={`${beforeMarker} ${awayMarker} pending unrelated content`}
      />,
    );
    await act(async () => Promise.resolve());
    expect(trace).not.toHaveBeenCalled();

    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={latestTurnSummary(runningTurn, "running")}
        turns={[runningTurn]}
        messages={messagesForTurn(runningTurn)}
        streamingText={`${beforeMarker} STREAM_PROVIDER_READER_ACTIVITY_10000_AWAY `}
      />,
    );
    await act(async () => Promise.resolve());
    expect(trace).not.toHaveBeenCalled();

    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={latestTurnSummary(runningTurn, "running")}
        turns={[runningTurn]}
        messages={messagesForTurn(runningTurn)}
        streamingText={`${beforeMarker} ${awayMarker} `}
      />,
    );
    await waitFor(() => expect(trace).toHaveBeenCalledWith(
      streamingReaderActivityReceiptStage(awayMarker),
    ));
  });

  it("anchors one virtualized answer from an owner-scoped running shell", async () => {
    const activeConversation = conversation("conversation-shell-live");
    const staleConversation = conversation("conversation-shell-stale");
    const staleTurn = turn(staleConversation, 1, "completed");
    const historicalTurns = Array.from(
      { length: 14 },
      (_, index) => turn(activeConversation, index + 1, "completed"),
    );
    const runningTurn = turn(activeConversation, 15, "running");
    const settledTurn = turn(activeConversation, 15, "completed");
    const settledTurns = [...historicalTurns, settledTurn];
    const settledMessages = settledTurns.flatMap(messagesForTurn);
    const runningSummary = latestTurnSummary(runningTurn, "running");
    const terminalSummary = latestTurnSummary(settledTurn, "completed");
    const geometry = installGeometry(settledTurn.terminalAssistantMessageId!);
    const visible = vi.fn();
    const props = workspaceProps(activeConversation);
    const view = render(
      <ChatWorkspace
        {...props}
        latestTurnSummary={runningSummary}
        turns={[staleTurn]}
        messages={messagesForTurn(staleTurn)}
        loading
        detailLoading
        onLatestContentVisibilityChange={visible}
      />,
    );

    await expectLoadingConversation();
    expect(screen.queryByText(`Request ${staleTurn.id}`)).toBeNull();
    const transcript = screen.getByLabelText("Thread transcript");
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 5_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    await geometry.flushFrames();

    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={runningSummary}
        turns={settledTurns}
        messages={settledMessages}
        onLatestContentVisibilityChange={visible}
      />,
    );
    await geometry.flushFrames();
    await expectVirtualWindow(view.container);
    geometry.setScrollTop(1_500);
    transcript.scrollTop = 1_500;
    visible.mockClear();

    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={terminalSummary}
        turns={settledTurns}
        messages={settledMessages}
        onLatestContentVisibilityChange={visible}
      />,
    );
    await geometry.flushFrames();

    expect(finalAnswerAnchorStarts).toHaveBeenCalledTimes(1);
    expect(finalAnswerAnchorStarts).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: activeConversation.id,
      answerId: settledTurn.terminalAssistantMessageId,
    }));
    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={terminalSummary}
        turns={settledTurns}
        messages={settledMessages}
        onLatestContentVisibilityChange={visible}
      />,
    );
    await geometry.flushFrames();
    expect(finalAnswerAnchorStarts).toHaveBeenCalledTimes(1);
  });

  it("leaves a virtualized terminal shell hydration in history", async () => {
    const activeConversation = conversation("conversation-shell-history");
    const settledTurns = Array.from(
      { length: 15 },
      (_, index) => turn(activeConversation, index + 1, "completed"),
    );
    const latestTurn = settledTurns.at(-1)!;
    const terminalSummary = latestTurnSummary(latestTurn, "completed");
    const geometry = installGeometry(latestTurn.terminalAssistantMessageId!);
    const visible = vi.fn();
    const props = workspaceProps(activeConversation);
    const view = render(
      <ChatWorkspace
        {...props}
        latestTurnSummary={terminalSummary}
        loading
        detailLoading
        onLatestContentVisibilityChange={visible}
      />,
    );
    await expectLoadingConversation();
    const transcript = screen.getByLabelText("Thread transcript");
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 5_000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    await geometry.flushFrames();
    visible.mockClear();

    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={terminalSummary}
        turns={settledTurns}
        messages={settledTurns.flatMap(messagesForTurn)}
        onLatestContentVisibilityChange={visible}
      />,
    );
    await geometry.flushFrames();

    await expectVirtualWindow(view.container);
    expect(finalAnswerAnchorStarts).not.toHaveBeenCalled();
  });
});
