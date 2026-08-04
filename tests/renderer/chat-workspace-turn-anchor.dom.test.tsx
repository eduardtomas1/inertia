import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace } from "../../src/renderer/src/components/ChatWorkspace";
import type {
  ChatMessage,
  Conversation,
  Project,
  TurnGitArtifact,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import type {
  TranscriptMessageSendAcceptance,
} from "../../src/renderer/src/utils/transcriptNavigation";

vi.mock("../../src/renderer/src/hooks/useNativePreviewSuspension", () => ({
  useNativePreviewSuspension: () => undefined,
}));

vi.mock("../../src/renderer/src/components/Composer", () => ({
  Composer: ({
    onSend,
  }: {
    onSend(content: string, attachments: []): Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() => void onSend("Materialize this draft", [])}
    >
      Send materialized draft
    </button>
  ),
}));

vi.mock("../../src/renderer/src/components/ResponseTimeline", () => ({
  ResponseTimeline: ({ turnAnchorId }: { turnAnchorId: string | null }) => (
    <div data-testid="turn-anchor-projection">{turnAnchorId ?? "none"}</div>
  ),
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

function conversation(id: string): Conversation {
  return {
    id,
    projectId: project.id,
    title: id,
    providerId: "codex",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "provider-default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "medium",
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
  vi.restoreAllMocks();
});

describe("draft turn anchoring", () => {
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
