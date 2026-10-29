import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatWorkspace } from "../../src/renderer/src/components/ChatWorkspace";
import { createStreamingAgentStore } from "../../src/renderer/src/hooks/useStreamingAgentState";
import type { SecretRequestReference } from "../../src/shared/agent-secrets";
import type {
  AgentTurn,
  ChatMessage,
  Conversation,
  ConversationLatestTurnSummary,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { SecretRequestCommandRunner } from "../../src/renderer/src/utils/response-timeline/secretRequests";

vi.mock("../../src/renderer/src/hooks/useNativePreviewSuspension", () => ({
  useNativePreviewSuspension: () => undefined,
}));

vi.mock("../../src/renderer/src/components/Composer", () => ({
  Composer: () => (
    <section aria-label="Message composer">
      <textarea aria-label="Message" defaultValue="" />
    </section>
  ),
}));

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
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
  };
}

const SECRET = "tskey-auth-workspace-VALUE";
const REQUEST_ID = "0d9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

function secretMessage(agentTurn: AgentTurn, update: Partial<SecretRequestReference> = {}): ChatMessage {
  const secretRequest: SecretRequestReference = {
    requestId: REQUEST_ID,
    title: "Tailscale auth key",
    description: "Create a reusable, ephemeral key tagged tag:ci.",
    ttlHours: 24,
    status: "pending",
    answeredAt: null,
    expiresAt: null,
    storage: null,
    ...update,
  };
  return {
    id: `${agentTurn.id}-secret`,
    conversationId: agentTurn.conversationId,
    turnId: agentTurn.id,
    role: "system",
    content: `Asked for a secret: ${secretRequest.title}`,
    attachments: [],
    createdAt: agentTurn.requestedAt.replace(".000Z", ".500Z"),
    secretRequest,
  };
}

function requestMessage(agentTurn: AgentTurn): ChatMessage {
  return {
    id: agentTurn.userMessageId,
    conversationId: agentTurn.conversationId,
    turnId: agentTurn.id,
    role: "user",
    content: "Join the CI VMs to the tailnet.",
    attachments: [],
    createdAt: agentTurn.requestedAt,
  };
}

let saveAgentSecret: ReturnType<typeof vi.fn>;
let onSecretRequestCommand: ReturnType<typeof vi.fn<SecretRequestCommandRunner>>;

function renderWorkspace(messages: (agentTurn: AgentTurn) => ChatMessage[]) {
  const activeConversation = conversation("12121212-1212-4121-8121-121212121212");
  const runningTurn = turn(activeConversation, 1, "running");
  const props = workspaceProps(activeConversation);
  const view = render(
    <ChatWorkspace
      {...props}
      latestTurnSummary={latestTurnSummary(runningTurn, "running")}
      turns={[runningTurn]}
      messages={[requestMessage(runningTurn), ...messages(runningTurn)]}
      onSecretRequestCommand={onSecretRequestCommand}
    />,
  );
  return { view, runningTurn, activeConversation, props };
}

beforeAll(async () => {
  await import("../../src/renderer/src/components/ResponseTimeline");
});

beforeEach(() => {
  saveAgentSecret = vi.fn(async () => ({ status: "saved", expiresAt: "2026-10-30T12:00:00.000Z", storage: "keychain" }));
  onSecretRequestCommand = vi.fn<SecretRequestCommandRunner>(async () => ({ type: "request.ok", requestId: "ok" }) as ServerEvent);
  Object.defineProperty(window, "inertia", {
    configurable: true,
    writable: true,
    value: { saveAgentSecret, getPlatform: () => "linux" },
  });
  HTMLElement.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "inertia", { configurable: true, writable: true, value: undefined });
});

describe("secret requests in the chat workspace", () => {
  it("renders the card inline and a composer notice that reveals it", async () => {
    renderWorkspace((agentTurn) => [secretMessage(agentTurn)]);
    const card = await screen.findByRole("region", { name: "Tailscale auth key" }, { timeout: 5_000 });
    expect(card).toHaveAttribute("id", `secret-request-${REQUEST_ID}`);
    expect(card.closest('[aria-label="Agent work transcript"]')).not.toBeNull();
    expect(screen.queryByRole("article", { name: "Agent system notice" })).toBeNull();
    const notice = screen.getByText("Agent is asking for a secret").closest(".pending-input-notice")!;
    expect(notice).toHaveTextContent("Enter it in the private card, not here");
    const reveal = screen.getByRole("button", { name: "Enter secret" });
    expect(reveal).toHaveAttribute("aria-controls", `secret-request-${REQUEST_ID}`);
    const field = await screen.findByLabelText("Tailscale auth key", { selector: "input" });
    screen.getByLabelText("Message").focus();
    fireEvent.click(reveal);
    expect(field).toHaveFocus();
  });

  it("saves through the bridge and declines through the scene's runtime command runner", async () => {
    renderWorkspace((agentTurn) => [secretMessage(agentTurn)]);
    const field = await screen.findByLabelText("Tailscale auth key", { selector: "input" }, { timeout: 5_000 });
    fireEvent.change(field, { target: { value: SECRET } });
    await act(async () => { fireEvent.submit(field.closest("form")!); });
    expect(saveAgentSecret).toHaveBeenCalledWith({
      conversationId: "12121212-1212-4121-8121-121212121212",
      requestId: REQUEST_ID,
      secret: SECRET,
    });
    expect((field as HTMLInputElement).value).toBe("");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Decline" })); });
    expect(onSecretRequestCommand).toHaveBeenCalledWith("secret-request.decline", {
      type: "secret-request.decline",
      payload: { conversationId: "12121212-1212-4121-8121-121212121212", requestId: REQUEST_ID },
    });
    expect(JSON.stringify(onSecretRequestCommand.mock.calls)).not.toContain(SECRET);
  });

  it("drops the notice and shows a quiet row once the request is answered", async () => {
    const { view, runningTurn, props } = renderWorkspace((agentTurn) => [secretMessage(agentTurn)]);
    await screen.findByRole("region", { name: "Tailscale auth key" }, { timeout: 5_000 });
    view.rerender(
      <ChatWorkspace
        {...props}
        latestTurnSummary={latestTurnSummary(runningTurn, "running")}
        turns={[runningTurn]}
        messages={[requestMessage(runningTurn), secretMessage(runningTurn, { status: "declined", answeredAt: runningTurn.requestedAt })]}
        onSecretRequestCommand={onSecretRequestCommand}
      />,
    );
    await waitFor(() => expect(screen.queryByText("Agent is asking for a secret")).toBeNull());
    expect(screen.queryByRole("region", { name: /Tailscale auth key/u })).toBeNull();
    const row = document.getElementById(`secret-request-${REQUEST_ID}`)!;
    expect(row).toHaveAttribute("data-secret-request-state", "declined");
    expect(row).toHaveTextContent("Declined");
  });

  it("keeps earlier prose above a pending card and later streamed text below it without remounting the card", async () => {
    const activeConversation = conversation("13131313-1313-4131-8131-131313131313");
    const runningTurn = turn(activeConversation, 1, "running");
    const props = workspaceProps(activeConversation);
    const streaming = createStreamingAgentStore();
    const prose = "I need the Tailscale auth key before the VMs can join.";
    const later = "Thanks, joining the VMs to the tailnet now.";
    const commentary: ChatMessage = {
      id: `${runningTurn.id}-plan`,
      conversationId: activeConversation.id,
      turnId: runningTurn.id,
      role: "assistant",
      content: prose,
      attachments: [],
      createdAt: runningTurn.requestedAt.replace(".000Z", ".499Z"),
    };
    const workspace = (messages: ChatMessage[]) => (
      <ChatWorkspace
        {...props}
        latestTurnSummary={latestTurnSummary(runningTurn, "running")}
        turns={[runningTurn]}
        messages={[requestMessage(runningTurn), ...messages]}
        streaming={streaming}
        onSecretRequestCommand={onSecretRequestCommand}
      />
    );
    const view = render(workspace([]));
    act(() => streaming.update([prose, "", "text"]));
    await screen.findByText(prose, undefined, { timeout: 5_000 });

    act(() => streaming.update(["", "", null]));
    view.rerender(workspace([commentary, secretMessage(runningTurn)]));
    const field = await screen.findByLabelText("Tailscale auth key", { selector: "input" }, { timeout: 5_000 });
    const card = document.getElementById(`secret-request-${REQUEST_ID}`)!;
    expect(screen.getAllByText(prose)).toHaveLength(1);
    const before = screen.getByText(prose);
    expect(before.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    field.focus();
    fireEvent.change(field, { target: { value: "tskey-par" } });
    act(() => streaming.update([later, "", "text"]));
    const after = await screen.findByText(later);
    expect(card.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.getElementById(`secret-request-${REQUEST_ID}`)).toBe(card);
    expect(screen.getByLabelText("Tailscale auth key", { selector: "input" })).toBe(field);
    expect(field).toHaveValue("tskey-par");
    expect(field).toHaveFocus();
  });
});
