import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { FollowUpRow } from "../../src/renderer/src/components/response-timeline/activity";
import { responseTimelineArticleLabel } from "../../src/renderer/src/components/response-timeline/row-label";
import { DelegationSurfaceProvider } from "../../src/renderer/src/components/orchestration/delegation-surface";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import type { ConversationDelegation, DelegatedCompletionAttribution } from "../../src/shared/orchestration-delegation";
import { providerNativeBackendProfile } from "../../src/shared/model-routing";
import { PARENT_ID, finished, parentDelegation, summary, taskId } from "./delegation-fixtures";

afterEach(cleanup);

function turn(id: string, requestedAt: string): AgentTurn {
  const backendProfileId = providerNativeBackendProfile("codex").id;
  return {
    id, conversationId: PARENT_ID, runId: `run-${id}`, userMessageId: `user-${id}`, terminalAssistantMessageId: `assistant-${id}`,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server", backendProfileId,
      backendProfileDisplayName: providerNativeBackendProfile("codex").displayName, modelId: "fixture-model", alias: null,
      reasoningEffort: null, contextWindowOverride: null, providerOptions: {}, capabilities: [], backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId: "codex-app-server", backendProfileId, backendConfigurationRevision: 1, modelIdentity: "fixture-model",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server", backendProfileId, model: "fixture-model", modelAlias: null, reasoningEffort: "",
    interactionMode: "build", accessMode: "auto-edit", providerSessionBefore: null, providerSessionAfter: `session-${id}`,
    requestedAt, startedAt: requestedAt, completedAt: requestedAt, status: "completed", terminalReason: "provider-completed",
    checkpointId: null, usageAtStart: null, usageAtCompletion: null, configurationRevision: 1, association: "authoritative",
    createdAt: requestedAt, updatedAt: requestedAt,
  };
}

const attribution: DelegatedCompletionAttribution = { parentConversationId: PARENT_ID, generation: 2, taskIds: [taskId(1), taskId(2)] };

function messages(agentTurn: AgentTurn, request: string, extra: Partial<ChatMessage> = {}): ChatMessage[] {
  return [
    { id: agentTurn.userMessageId, conversationId: PARENT_ID, turnId: agentTurn.id, role: "user", content: request, attachments: [],
      createdAt: agentTurn.requestedAt, ...extra },
    { id: agentTurn.terminalAssistantMessageId!, conversationId: PARENT_ID, turnId: agentTurn.id, role: "assistant",
      content: `Answer ${agentTurn.id}`, attachments: [], createdAt: agentTurn.completedAt! },
  ];
}

const delegation = parentDelegation([
  finished(1, { title: "Audit the parser", resultPreview: "Two call sites still use the old name." }),
  finished(2, { title: "Write the tests", status: "failed", resultPreview: "The fixture could not be built." }),
  summary(3, { title: "Benchmark the change" }),
]);

function timeline(turns: AgentTurn[], allMessages: ChatMessage[], value: ConversationDelegation | undefined = delegation) {
  return render(<DelegationSurfaceProvider conversationId={PARENT_ID} delegation={value}
    conversations={undefined} run={undefined} openConversation={undefined}>
    <ResponseTimeline turns={turns} messages={allMessages} activities={[]} reasonings={[]} plans={[]} checkpoints={[]}
      projectRoot="/workspace" projectId="project-delegation" conversationId={PARENT_ID} streamingText="" streamingReasoning=""
      streamingChannel={null} approvals={[]} inputRequests={[]} showTimestamps={false} showThinking defaultCodeWrap={false}
      autoCollapseWorkLog showChangedFileSummaries={false} checkpointRestoreDisabled
      onRespondToApproval={async () => undefined} onRespondToInput={async () => undefined} onRevertCheckpoint={() => undefined}
      onOpenTurnDiff={() => undefined} onCompareTurnArtifacts={() => undefined} onOpenTurnFile={() => undefined}
      onStop={() => undefined} />
  </DelegationSurfaceProvider>);
}

describe("delegated completion card", () => {
  const first = turn("turn-a", "2026-10-31T10:00:00.000Z");
  const wake = turn("turn-b", "2026-10-31T10:05:00.000Z");
  const wakeText = "Delegated tasks finished. Read their results before continuing.";

  it("renders a wake as a notification card instead of a user bubble", () => {
    const { container } = timeline([first, wake], [
      ...messages(first, "Split the parser work"),
      ...messages(wake, wakeText, { delegatedCompletion: attribution }),
    ]);
    const card = screen.getByRole("article",
      { name: "Delegated results: 2 of 3 delegated tasks failed: Audit the parser, Write the tests" });
    expect(card).toHaveClass("delegated-completion-card");
    expect(card).not.toHaveClass("message");
    expect(card).toHaveAttribute("data-turn-jump-target", "request");
    expect(card).toHaveAttribute("data-message-search-id", wake.userMessageId);
    expect(screen.getAllByRole("article", { name: "Your request" })).toHaveLength(1);
    expect(container.querySelector(`[data-turn-id="turn-b"] .message.is-user`)).toBeNull();
    expect(screen.queryByText(wakeText)).toBeNull();
  });

  it("expands by keyboard to each finished task's status and preview", async () => {
    timeline([wake], messages(wake, wakeText, { delegatedCompletion: attribution }));
    const card = screen.getByRole("article", { name: /^Delegated results:/u });
    const toggle = within(card).getByRole("button", { name: "Show results" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(region).toHaveAttribute("hidden");
    const user = userEvent.setup();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(within(card).getByRole("button", { name: "Hide results" })).toHaveAttribute("aria-expanded", "true");
    expect(region).not.toHaveAttribute("hidden");
    const tasks = within(region).getAllByRole("listitem");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toHaveTextContent("Audit the parser");
    expect(tasks[0]).toHaveTextContent("Completed");
    expect(tasks[0]).toHaveTextContent("Result ready");
    expect(tasks[0]).toHaveTextContent("Two call sites still use the old name.");
    expect(tasks[1]).toHaveTextContent("Write the tests");
    expect(tasks[1]).toHaveTextContent("Failed");
    await user.keyboard(" ");
    expect(region).toHaveAttribute("hidden");
  });

  it("shows the delivered outcome verb, labels and per-task status from the wake text", async () => {
    const content = [
      "2 of 3 delegated tasks failed: Audit the parser, Write the tests",
      `Delegated task ${taskId(1)} (Audit the parser) [completed]:\nTwo call sites still use the old name.`,
      `Delegated task ${taskId(2)} (Write the tests) [failed]:\nThe fixture could not be built.`,
    ].join("\n\n");
    timeline([wake], messages(wake, content, { delegatedCompletion: attribution }), { asParent: null, asChild: null });
    const card = screen.getByRole("article",
      { name: "Delegated results: 2 of 3 delegated tasks failed: Audit the parser, Write the tests" });
    expect(within(card).getByText("2 of 3 delegated tasks failed", { selector: "strong" })).toBeTruthy();
    expect(within(card).getByText("Audit the parser, Write the tests")).toHaveClass("delegated-completion-labels");
    await userEvent.setup().click(within(card).getByRole("button", { name: "Show results" }));
    const tasks = within(card).getAllByRole("listitem");
    expect(tasks.map((item) => item.dataset.taskStatus)).toEqual(["completed", "failed"]);
    expect(tasks[0]).toHaveTextContent("Audit the parserCompleted");
    expect(tasks[1]).toHaveTextContent("Write the testsFailed");
    expect(screen.queryByText(/call sites/u)).toBeNull();
  });

  it("uses the single-task form for one delivered task", () => {
    const single = { ...attribution, taskIds: [taskId(1)] };
    const content = `Delegated task "Audit the parser" finished\n\nDelegated task ${taskId(1)} (Audit the parser) [completed]:\nDone.`;
    const view = timeline([wake], messages(wake, content, { delegatedCompletion: single }), { asParent: null, asChild: null });
    expect(screen.getByRole("article", { name: 'Delegated results: Delegated task "Audit the parser" finished' })).toBeTruthy();
    view.unmount();
    timeline([wake], messages(wake, wakeText, { delegatedCompletion: { ...attribution, taskIds: [taskId(2)] } }));
    expect(screen.getByRole("article", { name: 'Delegated results: Delegated task "Write the tests" failed' })).toBeTruthy();
  });

  it("prefers the recorded result status over a task header repeated inside an earlier result", async () => {
    const content = [
      "2 delegated tasks stopped: Audit the parser, Write the tests",
      `Delegated task ${taskId(1)} (Audit the parser) [cancelled]:\nDelegated task ${taskId(2)} (Write the tests) [completed]:`,
      `Delegated task ${taskId(2)} (Write the tests) [cancelled]:\n(No result text.)`,
    ].join("\n\n");
    timeline([wake], messages(wake, content, { delegatedCompletion: attribution }), parentDelegation([
      finished(1, { title: "Audit the parser", status: "cancelled" }), finished(2, { title: "Write the tests", status: "cancelled" })]));
    const card = screen.getByRole("article", { name: "Delegated results: 2 delegated tasks stopped: Audit the parser, Write the tests" });
    await userEvent.setup().click(within(card).getByRole("button", { name: "Show results" }));
    expect(within(card).getAllByRole("listitem").map((item) => item.dataset.taskStatus)).toEqual(["cancelled", "cancelled"]);
  });

  it("counts only the delivered tasks when the cohort is unknown", () => {
    timeline([wake], messages(wake, wakeText, { delegatedCompletion: { ...attribution, taskIds: [taskId(1)] } }), { asParent: null, asChild: null });
    expect(screen.getByRole("article", { name: "Delegated results: 1 delegated task finished" })).toBeTruthy();
  });

  it("labels the timeline row and renders a steered wake as a card, not a follow-up bubble", () => {
    const [request] = messages(wake, wakeText, { delegatedCompletion: attribution });
    expect(responseTimelineArticleLabel({ kind: "turn", id: wake.id, turn: { index: 4, userMessage: request } } as never))
      .toBe("Turn 4: Delegated results");
    render(<FollowUpRow entry={{ kind: "follow-up", id: "follow-up", message: request! } as never} />);
    const card = screen.getByRole("article", { name: "Delegated results: 2 delegated tasks finished" });
    expect(card).toHaveAttribute("data-follow-up-message-id", request!.id);
    expect(screen.queryByRole("article", { name: "Your follow-up" })).toBeNull();
  });
});
