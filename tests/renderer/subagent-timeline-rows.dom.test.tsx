import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { SubagentActivityRow } from "../../src/renderer/src/components/response-timeline/SubagentActivityRow";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
  SubagentTrace,
} from "../../src/shared/contracts";
import { taskTrace } from "./background-task-fixtures";

const conversationId = "44444444-4444-4444-8444-444444444444";

function turn(providerId: "claude" | "codex", status: AgentTurn["status"] = "completed"): AgentTurn {
  const harnessId = providerId === "claude" ? "claude-agent-sdk" : "codex-app-server";
  const backendProfileId = providerId === "claude" ? "builtin:claude" : "native:codex:app-server";
  return {
    id: "turn-legacy",
    conversationId,
    runId: "run-legacy",
    userMessageId: "user-legacy",
    terminalAssistantMessageId: status === "completed" ? "answer-legacy" : null,
    providerId,
    modelSelection: {
      harnessId,
      backendProfileId,
      backendProfileDisplayName: providerId === "claude" ? "Claude" : "Codex App Server",
      modelId: "provider-default",
      alias: null,
      reasoningEffort: "",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId,
      backendProfileId,
      backendConfigurationRevision: 1,
      modelIdentity: null,
      endpointIdentity: null,
    },
    harnessId,
    backendProfileId,
    model: "provider-default",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2026-08-12T12:00:00.000Z",
    startedAt: "2026-08-12T12:00:01.000Z",
    completedAt: status === "completed" ? "2026-08-12T12:01:00.000Z" : null,
    status,
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:01:00.000Z",
  };
}

function messages(owner: AgentTurn): ChatMessage[] {
  return [
    { id: owner.userMessageId, conversationId, turnId: owner.id, role: "user", content: "Review the parser.", attachments: [], createdAt: owner.requestedAt },
    ...(owner.terminalAssistantMessageId
      ? [{ id: owner.terminalAssistantMessageId, conversationId, turnId: owner.id, role: "assistant" as const, content: "Reviewed.", attachments: [], createdAt: owner.completedAt! }]
      : []),
  ];
}

function agentRow(owner: AgentTurn): AgentActivity {
  return {
    id: "activity-agent-call",
    conversationId,
    runId: owner.runId,
    turnId: owner.id,
    kind: "tool",
    title: "Agent",
    detail: null,
    status: owner.status === "completed" ? "completed" : "running",
    createdAt: "2026-08-12T12:00:05.000Z",
  };
}

function renderTurn(owner: AgentTurn, subagents: SubagentTrace[], activities: AgentActivity[]) {
  return render(<ResponseTimeline
    turns={[owner]}
    messages={messages(owner)}
    activities={activities}
    reasonings={[]}
    plans={[]}
    checkpoints={[]}
    projectRoot="/workspace"
    projectId="project-legacy"
    conversationId={conversationId}
    streamingText=""
    streamingReasoning=""
    streamingChannel={null}
    approvals={[]}
    inputRequests={[]}
    showTimestamps={false}
    showThinking
    defaultCodeWrap={false}
    autoCollapseWorkLog={false}
    showChangedFileSummaries={false}
    checkpointRestoreDisabled
    subagents={subagents}
    onRespondToApproval={async () => undefined}
    onRespondToInput={async () => undefined}
    onRevertCheckpoint={() => undefined}
    onOpenTurnDiff={() => undefined}
    onCompareTurnArtifacts={() => undefined}
    onOpenTurnFile={() => undefined}
    onStop={vi.fn()}
    onOpenSurface={vi.fn()}
  />);
}

afterEach(() => cleanup());

describe("delegated task rows in a whole turn", () => {
  it.each(["completed", "running"] as const)("shows a legacy %s Claude agent once, by its own Agent row", (status) => {
    const owner = turn("claude", status);
    const legacy = taskTrace({
      id: "trace-legacy",
      conversationId,
      runId: owner.runId,
      turnId: owner.id,
      activityId: null,
      description: "Audit the tokenizer",
      status,
      isLive: status === "running",
    });
    renderTurn(owner, [legacy], [agentRow(owner)]);
    expect(document.querySelector(".subagent-unlinked-rows")).toBeNull();
    expect(document.querySelector('[data-subagent-trace="trace-legacy"]')).toBeNull();
    expect(screen.queryByText("Audit the tokenizer")).toBeNull();
    expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
  });

  it("shows a Codex child agent, which has no tool row, as one compact row", () => {
    const owner = turn("codex");
    const child = taskTrace({
      id: "trace-codex",
      conversationId,
      runId: owner.runId,
      turnId: owner.id,
      providerId: "codex",
      providerToolUseId: "collab-1",
      activityId: null,
      description: "Codex child review",
      status: "completed",
    });
    renderTurn(owner, [child], []);
    const rows = document.querySelectorAll('[data-subagent-trace="trace-codex"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closest(".subagent-unlinked-rows")).not.toBeNull();
  });
});

describe("delegated task rows under virtualization", () => {
  const live = taskTrace({
    id: "trace-live",
    activityId: "activity-agent-call",
    description: "Survey the repository",
    steps: [{ label: "Read · src/index.ts", status: "running" }],
  });
  const settledTrace = { ...live, isLive: false, status: "completed" as const, sequence: 2 };
  const element = (): HTMLElement => document.querySelector<HTMLElement>('[data-subagent-trace="trace-live"]')!;

  it("anchors a steps toggle around the height change", async () => {
    const order: string[] = [];
    render(<SubagentActivityRow trace={live} onBeforeToggle={() => order.push("before")} onAfterToggle={() => order.push("after")} />);
    fireEvent.click(within(element()).getByRole("button", { name: /^Steps for/u }));
    expect(order).toEqual(["before"]);
    await waitFor(() => expect(order).toEqual(["before", "after"]));
  });

  it("leaves open steps open when the task ends, so the row does not shrink on its own", () => {
    const onBeforeToggle = vi.fn();
    const { rerender } = render(<SubagentActivityRow trace={live} onBeforeToggle={onBeforeToggle} />);
    const steps = within(element()).getByRole("button", { name: /^Steps for/u });
    fireEvent.click(steps);
    onBeforeToggle.mockClear();
    rerender(<SubagentActivityRow trace={settledTrace} onBeforeToggle={onBeforeToggle} />);
    expect(steps.getAttribute("aria-expanded")).toBe("true");
    expect(element().querySelector(".subagent-activity-steps")).not.toBeNull();
    expect(onBeforeToggle).not.toHaveBeenCalled();
  });

  it("keeps the doing line's height once shown and adds none to a row that never had one", () => {
    const { rerender } = render(<SubagentActivityRow trace={live} />);
    expect(element().querySelector(".subagent-activity-doing")?.textContent).toBe("Read · src/index.ts");
    rerender(<SubagentActivityRow trace={settledTrace} />);
    const reserved = element().querySelector<HTMLElement>(".subagent-activity-doing");
    expect(reserved?.textContent).toBe(" ");
    expect(reserved?.getAttribute("aria-hidden")).toBe("true");
    cleanup();
    render(<SubagentActivityRow trace={settledTrace} />);
    expect(element().querySelector(".subagent-activity-doing")).toBeNull();
  });
});
