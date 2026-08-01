import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const conversationId = "77777777-7777-4777-8777-777777777777";
const requestedAt = "2030-01-01T10:00:00.000Z";
const completedAt = "2030-01-01T10:00:08.000Z";

function turn(): AgentTurn {
  return {
    id: "turn-performance-disclosure",
    conversationId,
    runId: "run-performance-disclosure",
    userMessageId: "user-performance-disclosure",
    terminalAssistantMessageId: "answer-performance-disclosure",
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
    providerSessionAfter: "session-after",
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
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id,
    conversationId,
    turnId: "turn-performance-disclosure",
    role,
    content,
    attachments: [],
    createdAt: role === "user" ? requestedAt : completedAt,
  };
}

function activity(): AgentActivity {
  return {
    id: "activity-performance-disclosure",
    conversationId,
    runId: "run-performance-disclosure",
    turnId: "turn-performance-disclosure",
    kind: "command",
    title: "Ran performance fixture",
    detail: [
      "Command: benchmark",
      "Output:",
      "bounded preview",
      `UNMOUNTED_SENTINEL_${"x".repeat(250_000)}`,
    ].join("\n"),
    status: "completed",
    createdAt: completedAt,
  };
}

afterEach(cleanup);

describe("historical execution disclosure performance", () => {
  it("mounts closed execution and tool output only after each explicit disclosure", () => {
    render(
      <ResponseTimeline
        turns={[turn()]}
        messages={[
          message("user-performance-disclosure", "user", "Run the fixture."),
          message("answer-performance-disclosure", "assistant", "Fixture complete."),
        ]}
        activities={[activity()]}
        reasonings={[]}
        plans={[]}
        checkpoints={[]}
        projectRoot="/workspace"
        projectId="project-performance"
        conversationId={conversationId}
        streamingText=""
        streamingReasoning=""
        approvals={[]}
        inputRequests={[]}
        showTimestamps={false}
        showThinking={false}
        defaultCodeWrap={false}
        autoCollapseWorkLog
        showChangedFileSummaries={false}
        checkpointRestoreDisabled
        onRespondToApproval={async () => undefined}
        onRespondToInput={async () => undefined}
        onRevertCheckpoint={() => undefined}
        onOpenTurnDiff={() => undefined}
        onCompareTurnArtifacts={() => undefined}
        onOpenTurnFile={() => undefined}
        onStop={() => undefined}
      />,
    );

    expect(screen.queryByText("Ran performance fixture")).toBeNull();
    expect(document.body.textContent).not.toContain("UNMOUNTED_SENTINEL");

    fireEvent.click(screen.getByRole("button", { name: "Run details" }));

    expect(screen.getByTitle(/^Ran performance fixture/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain("UNMOUNTED_SENTINEL");

    const summary = screen.getByText("Full command output");
    const disclosure = summary.closest("details");
    if (!disclosure) throw new Error("Expected the command disclosure.");
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));

    expect(document.body.textContent).toContain("UNMOUNTED_SENTINEL");
  });
});
