import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { useStableActions } from "../../src/renderer/src/hooks/useStableController";
import type {
  AgentTurn,
  ChatMessage,
  SubagentTrace,
} from "../../src/shared/contracts";

const renderCounts = vi.hoisted(() => ({
  row: 0,
  profiler: 0,
}));

vi.mock("../../src/renderer/src/components/response-timeline/turn", async (
  importOriginal,
) => {
  const actual = await importOriginal<typeof import(
    "../../src/renderer/src/components/response-timeline/turn"
  )>();
  return {
    ...actual,
    TurnTimeline: () => {
      renderCounts.row += 1;
      return (
        <Profiler
          id="historical-row"
          onRender={() => {
            renderCounts.profiler += 1;
          }}
        >
          <article data-testid="historical-row" />
        </Profiler>
      );
    },
  };
});

const conversationId = "30303030-3030-4030-8030-303030303030";
const requestedAt = "2026-07-30T10:00:00.000Z";
const completedAt = "2026-07-30T10:00:02.000Z";
const turns: AgentTurn[] = [{
  id: "stable-turn",
  conversationId,
  runId: "stable-run",
  userMessageId: "stable-request",
  terminalAssistantMessageId: "stable-answer",
  providerId: "codex",
  modelSelection: {
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    backendProfileDisplayName: "Codex App Server",
    modelId: "gpt-test",
    alias: null,
    reasoningEffort: "high",
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
    backendConfigurationRevision: 1,
  },
  continuationIdentity: {
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    backendConfigurationRevision: 1,
    modelIdentity: "gpt-test",
    endpointIdentity: null,
  },
  harnessId: "codex-app-server",
  backendProfileId: "native:codex:app-server",
  model: "gpt-test",
  modelAlias: null,
  reasoningEffort: "high",
  interactionMode: "build",
  accessMode: "supervised",
  providerSessionBefore: null,
  providerSessionAfter: null,
  requestedAt,
  startedAt: requestedAt,
  completedAt,
  status: "completed",
  terminalReason: "provider-completed",
  checkpointId: null,
  usageAtStart: null,
  usageAtCompletion: null,
  configurationRevision: 1,
  association: "authoritative",
  createdAt: requestedAt,
  updatedAt: completedAt,
}];
const messages: ChatMessage[] = [
  {
    id: "stable-request",
    conversationId,
    turnId: "stable-turn",
    role: "user",
    content: "Keep this row stable.",
    attachments: [],
    createdAt: requestedAt,
  },
  {
    id: "stable-answer",
    conversationId,
    turnId: "stable-turn",
    role: "assistant",
    content: "Stable.",
    attachments: [],
    createdAt: completedAt,
  },
];
const subagent: SubagentTrace = {
  id: "stable-subagent",
  conversationId,
  runId: "stable-run",
  turnId: "stable-turn",
  providerId: "codex",
  providerTaskId: null,
  providerAgentId: null,
  parentTraceId: null,
  parentProviderAgentId: null,
  parentProviderToolUseId: null,
  providerToolUseId: null,
  providerRole: null,
  providerName: null,
  providerStatus: null,
  status: "completed",
  isLive: false,
  description: "Stable delegation",
  progress: null,
  result: "Done",
  sequence: 1,
  createdAt: requestedAt,
  updatedAt: completedAt,
};
const empty: never[] = [];
const respondToApproval = async (): Promise<void> => undefined;
const respondToInput = async (): Promise<void> => undefined;
const noop = (): void => undefined;

function Harness({
  backgroundRevision,
  showThinking = false,
  onFollowUp,
}: {
  backgroundRevision: number;
  showThinking?: boolean;
  onFollowUp: (revision: number) => void;
}): React.JSX.Element {
  const actions = useStableActions({
    followUp: (_trace: SubagentTrace) => onFollowUp(backgroundRevision),
    stopSubagent: async (_trace: SubagentTrace) => undefined,
  });
  return (
    <>
      <button type="button" onClick={() => actions.followUp(subagent)}>
        Follow up
      </button>
      <ResponseTimeline
        turns={turns}
        messages={messages}
        activities={empty}
        reasonings={empty}
        plans={empty}
        checkpoints={empty}
        projectRoot="/workspace"
        projectId="project-stable"
        conversationId={conversationId}
        streamingText=""
        streamingReasoning=""
        approvals={empty}
        inputRequests={empty}
        showTimestamps={false}
        showThinking={showThinking}
        defaultCodeWrap={false}
        autoCollapseWorkLog
        showChangedFileSummaries={false}
        checkpointRestoreDisabled
        onRespondToApproval={respondToApproval}
        onRespondToInput={respondToInput}
        onRevertCheckpoint={noop}
        onOpenTurnDiff={noop}
        onCompareTurnArtifacts={noop}
        onOpenTurnFile={noop}
        onStop={noop}
        onFollowUpSubagent={actions.followUp}
        onStopSubagent={actions.stopSubagent}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  renderCounts.row = 0;
  renderCounts.profiler = 0;
});

describe("workspace scene timeline rendering", () => {
  it("keeps settled rows mounted across unrelated background revisions", () => {
    const followedRevisions: number[] = [];
    const onFollowUp = (revision: number): void => {
      followedRevisions.push(revision);
    };
    const view = render(
      <Harness backgroundRevision={1} onFollowUp={onFollowUp} />,
    );
    expect(renderCounts).toEqual({ row: 1, profiler: 1 });

    view.rerender(
      <Harness backgroundRevision={2} onFollowUp={onFollowUp} />,
    );
    expect(renderCounts).toEqual({ row: 1, profiler: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Follow up" }));
    expect(followedRevisions).toEqual([2]);

    view.rerender(
      <Harness
        backgroundRevision={2}
        showThinking
        onFollowUp={onFollowUp}
      />,
    );
    expect(renderCounts).toEqual({ row: 2, profiler: 2 });
  });
});
