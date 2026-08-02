import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace } from "../../src/renderer/src/components/ChatWorkspace";
import type {
  Conversation,
  Project,
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
});
