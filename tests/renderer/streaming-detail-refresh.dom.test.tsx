import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentActivity,
  type AgentTurn,
  type AppSnapshot,
  type ChatMessage,
  type ConversationLatestTurnSummary,
  type ConversationShell,
  type ServerEvent,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { StreamingResponseTimeline } from "../../src/renderer/src/components/response-timeline/streaming-timeline";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { continuedLiveSegment } from "../../src/renderer/src/utils/response-timeline/execution";

const conversationId = "61616161-6161-4161-8161-616161616161";
const turnId = "62626262-6262-4262-8262-626262626262";
const runId = "63636363-6363-4363-8363-636363636363";
const requestId = "64646464-6464-4464-8464-646464646464";
const partialId = "65656565-6565-4565-8565-656565656565";
const modelSelection = providerNativeModelSelection({
  providerId: "codex",
  modelId: "default",
  reasoningEffort: "medium",
});

function at(seconds: number): string {
  return `2030-04-01T09:00:${String(seconds).padStart(2, "0")}.000Z`;
}

const latestTurn: ConversationLatestTurnSummary = {
  id: turnId,
  runId,
  status: "running",
  providerId: "codex",
  harnessId: modelSelection.harnessId,
  backendProfileId: modelSelection.backendProfileId,
  modelSelection,
  continuationIdentity: continuationIdentityForSelection(modelSelection),
  model: modelSelection.modelId,
  reasoningEffort: "medium",
  requestedAt: at(0),
  startedAt: at(1),
  completedAt: null,
  terminalReason: null,
  updatedAt: at(1),
};

const shell: ConversationShell = {
  id: conversationId,
  projectId: "project",
  title: "Release coordination",
  providerId: "codex",
  model: "default",
  modelSelection,
  continuationIdentity: null,
  reasoningEffort: "medium",
  interactionMode: "build",
  accessMode: "supervised",
  branch: null,
  worktreePath: null,
  status: "running",
  attentionKind: null,
  settledAt: null,
  archivedAt: null,
  createdAt: at(0),
  updatedAt: at(1),
  completedAt: null,
  lastViewedAt: null,
  providerSessionId: null,
  latestTurn,
  pendingApproval: false,
  pendingInput: false,
};

const snapshot: AppSnapshot = {
  projects: [],
  conversations: [shell],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: "project",
  activeConversationId: conversationId,
  settings: { ...defaultSettings },
};

const agentTurn: AgentTurn = {
  id: turnId,
  conversationId,
  runId,
  userMessageId: requestId,
  terminalAssistantMessageId: null,
  providerId: "codex",
  modelSelection,
  continuationIdentity: continuationIdentityForSelection(modelSelection),
  harnessId: modelSelection.harnessId,
  backendProfileId: modelSelection.backendProfileId,
  model: modelSelection.modelId,
  modelAlias: null,
  reasoningEffort: "medium",
  interactionMode: "build",
  accessMode: "supervised",
  providerSessionBefore: null,
  providerSessionAfter: null,
  requestedAt: at(0),
  startedAt: at(1),
  completedAt: null,
  status: "running",
  terminalReason: null,
  checkpointId: null,
  usageAtStart: null,
  usageAtCompletion: null,
  configurationRevision: 1,
  association: "authoritative",
  createdAt: at(0),
  updatedAt: at(1),
};

function message(id: string, role: ChatMessage["role"], content: string, createdAt: string): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt };
}

const userMessage = message(requestId, "user", "Coordinate the 2.4 release audit.", at(0));

function toolActivity(id: string, seconds: number): AgentActivity {
  return {
    id,
    conversationId,
    runId,
    turnId,
    kind: "tool",
    title: "Delegate task",
    detail: null,
    status: "completed",
    createdAt: at(seconds),
  };
}

interface StoredDetail {
  messages: ChatMessage[];
  activities: AgentActivity[];
}

function harness(initial: StoredDetail) {
  const stored: StoredDetail = { ...initial };
  const listeners = new Set<(event: ServerEvent) => void>();
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> =>
    command.type === "conversation.detail.load"
      ? {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.detail",
            conversationId,
            state: "ready",
            detail: {
              conversation: shell,
              agentTurns: [agentTurn],
              turnGitArtifacts: [],
              messages: [userMessage, ...stored.messages],
              activities: stored.activities,
              subagents: [],
              reasonings: [],
              usage: [],
              plans: [],
              goals: [],
              checkpoints: [],
              reviewSummaries: [],
              reviewStates: [],
              reviewNotes: [],
            },
          },
        } as unknown as ServerEvent
      : { type: "request.ok", requestId: crypto.randomUUID() });
  const subscribe = (listener: (event: ServerEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = (event: ServerEvent): void => act(() => {
    for (const listener of listeners) listener(event);
  });
  const text = (value: string): void => emit({ type: "agent.text", conversationId, runId, turnId, text: value });
  const refresh = async (): Promise<void> => {
    const loads = request.mock.calls.length;
    emit({ type: "conversation.detail.invalidated", conversationId });
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(loads));
    await act(async () => {
      await Promise.resolve();
    });
  };
  return { stored, request, subscribe, emit, text, refresh };
}

const noop = (): void => undefined;
const respond = async (): Promise<void> => undefined;
const quiet = (): undefined => undefined;

function Transcript({ connection }: { connection: ReturnType<typeof harness> }): React.JSX.Element {
  const projection = useConversationProjection({
    snapshot,
    status: "online",
    request: connection.request,
    subscribe: connection.subscribe,
    enabled: true,
    autoOpenPlan: false,
    onOpenPlan: noop,
    onTerminal: noop,
  });
  return (
    <StreamingResponseTimeline
      ResponseTimeline={ResponseTimeline}
      streaming={projection.streaming}
      onStreamingContent={quiet}
      turns={projection.turns}
      messages={projection.messages}
      activities={projection.activities}
      reasonings={projection.reasonings}
      plans={projection.plans}
      checkpoints={projection.checkpoints}
      projectRoot="/workspace"
      projectId="project"
      conversationId={conversationId}
      approvals={[]}
      inputRequests={[]}
      showTimestamps={false}
      showThinking={false}
      defaultCodeWrap={false}
      autoCollapseWorkLog={false}
      showChangedFileSummaries={false}
      checkpointRestoreDisabled={false}
      onRespondToApproval={respond}
      onRespondToInput={respond}
      onRevertCheckpoint={noop}
      onOpenTurnDiff={noop}
      onCompareTurnArtifacts={noop}
      onOpenTurnFile={noop}
      onStop={noop}
    />
  );
}

function rendered(text: string): Element[] {
  return [...document.querySelectorAll(".turn-commentary-row")]
    .filter((row) => row.textContent?.includes(text));
}

afterEach(cleanup);

describe("a detail refresh while a turn streams", () => {
  it("renders the streamed segment once when the refreshed detail carries its persisted partial", async () => {
    const connection = harness({ messages: [], activities: [toolActivity("delegate", 2)] });
    render(<Transcript connection={connection} />);
    await waitFor(() => expect(screen.getByText("Coordinate the 2.4 release audit.")).toBeTruthy());

    connection.text("Delegated audit changelog.");
    await waitFor(() => expect(rendered("Delegated audit changelog.")).toHaveLength(1));

    connection.stored.messages = [message(partialId, "assistant", "Delegated audit changelog.", at(3))];
    await connection.refresh();
    await waitFor(() => expect(connection.request).toHaveBeenCalled());
    expect(rendered("Delegated audit changelog.")).toHaveLength(1);
    expect(document.querySelectorAll(".turn-commentary-row.is-streaming")).toHaveLength(1);

    connection.text(" Waiting for the result.");
    await waitFor(() => expect(rendered("Delegated audit changelog. Waiting for the result.")).toHaveLength(1));
    expect(rendered("Delegated audit changelog.")).toHaveLength(1);

    connection.stored.messages = [
      message(partialId, "assistant", "Delegated audit changelog. Waiting", at(3)),
    ];
    await connection.refresh();
    expect(rendered("Delegated audit changelog.")).toHaveLength(1);
    expect(rendered("Delegated audit changelog. Waiting for the result.")).toHaveLength(1);

    const answer = message(partialId, "assistant", "Delegated audit changelog. Waiting for the result.", at(3));
    connection.emit({
      type: "agent.completed",
      conversationId,
      runId,
      turnId,
      status: "completed",
      terminalReason: "completed",
      terminalAssistantMessageId: partialId,
      terminalAssistantMessage: answer,
    });
    await waitFor(() => expect(document.querySelectorAll(".turn-commentary-row.is-streaming")).toHaveLength(0));
    expect(document.body.textContent?.split("Delegated audit changelog.").length).toBe(2);
  });

  it("hands the segment to its persisted message once the segment closes", async () => {
    const connection = harness({ messages: [], activities: [toolActivity("delegate", 2)] });
    render(<Transcript connection={connection} />);
    await waitFor(() => expect(screen.getByText("Coordinate the 2.4 release audit.")).toBeTruthy());

    connection.text("Checking the changelog.");
    connection.stored.messages = [message(partialId, "assistant", "Checking the changelog.", at(3))];
    await connection.refresh();
    expect(rendered("Checking the changelog.")).toHaveLength(1);

    connection.emit({
      type: "agent.commentary.persisted",
      message: message(partialId, "assistant", "Checking the changelog.", at(3)),
    });
    await waitFor(() => expect(document.querySelectorAll(".turn-commentary-row.is-streaming")).toHaveLength(0));
    expect(rendered("Checking the changelog.")).toHaveLength(1);
  });

  it("keeps an earlier closed segment when the live segment follows later work", async () => {
    const connection = harness({
      messages: [message(partialId, "assistant", "Looking.", at(2))],
      activities: [toolActivity("delegate", 3)],
    });
    render(<Transcript connection={connection} />);
    await waitFor(() => expect(rendered("Looking.")).toHaveLength(1));

    connection.text("Looking. Again.");
    await connection.refresh();
    expect(rendered("Looking.")).toHaveLength(2);
    expect(rendered("Looking. Again.")).toHaveLength(1);
  });
});

describe("continuedLiveSegment", () => {
  it("lets the live segment take over a persisted prefix", () => {
    expect(continuedLiveSegment("Delegated", "Delegated audit changelog.")).toBe("Delegated audit changelog.");
    expect(continuedLiveSegment("Delegated audit changelog.", "Delegated audit changelog.")).toBe("Delegated audit changelog.");
  });

  it("joins a live segment that resumed inside the persisted text", () => {
    const persisted = "The changelog lists fourteen entries and two of them are missing their issue links.";
    const live = "two of them are missing their issue links. I will add them now.";
    expect(continuedLiveSegment(persisted, live))
      .toBe("The changelog lists fourteen entries and two of them are missing their issue links. I will add them now.");
  });

  it("leaves unrelated text alone", () => {
    expect(continuedLiveSegment("Looking at the parser.", "Found it.")).toBeNull();
    expect(continuedLiveSegment("Done.", "Do")).toBeNull();
    expect(continuedLiveSegment("", "Anything")).toBeNull();
    expect(continuedLiveSegment("Ends with a dot.", ". Next")).toBeNull();
  });
});
