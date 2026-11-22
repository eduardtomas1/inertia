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
import type { CustomAgent } from "../../src/shared/custom-agents";
import { taskTrace } from "./background-task-fixtures";

const conversationId = "44444444-4444-4444-8444-444444444444";
const reviewer: CustomAgent = {
  id: "6f1c2a64-5d1e-4c55-9d43-1a2b3c4d5e6f",
  name: "Code reviewer",
  handle: "code-reviewer",
  description: "Reviews diffs",
  icon: { kind: "symbol", name: "shield" },
  accent: null,
  blocks: [],
  skills: [],
  position: 0,
  revision: 1,
  createdAt: "2026-08-12T11:00:00.000Z",
  updatedAt: "2026-08-12T11:00:00.000Z",
};

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

function renderTurn(
  owner: AgentTurn,
  subagents: SubagentTrace[],
  activities: AgentActivity[],
  customAgents: CustomAgent[] = [],
  commentary: ChatMessage[] = [],
) {
  return render(timeline(owner, subagents, activities, customAgents, commentary));
}

function timeline(
  owner: AgentTurn,
  subagents: SubagentTrace[],
  activities: AgentActivity[],
  customAgents: CustomAgent[] = [],
  commentary: ChatMessage[] = [],
) {
  return (<ResponseTimeline
    customAgents={customAgents}
    turns={[owner]}
    messages={[...messages(owner), ...commentary]}
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

describe("called custom agents in a whole turn", () => {
  it.each([
    ["Claude, by the Agent row it replaces", "claude", "activity-agent-call"],
    ["Codex, which has no tool row", "codex", null],
  ] as const)("draws a called agent from %s once, as its call block", (_label, providerId, activityId) => {
    const owner = turn(providerId);
    const called = taskTrace({
      id: "trace-called",
      conversationId,
      runId: owner.runId,
      turnId: owner.id,
      providerId,
      activityId,
      customAgentId: reviewer.id,
      description: "Review the parser change",
      status: "completed",
    });
    renderTurn(owner, [called], activityId ? [agentRow(owner)] : [], [reviewer]);
    expect(screen.getAllByRole("region", { name: "Called agent Code reviewer" })).toHaveLength(1);
    expect(document.querySelector('[data-subagent-trace="trace-called"]')).toBeNull();
    expect(document.querySelector(".subagent-unlinked-rows")).toBeNull();
    expect(document.querySelector(".agent-activity")).toBeNull();
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

describe("delegated tasks in the transcript's order", () => {
  const at = (seconds: number): string => `2026-08-12T12:00:${String(seconds).padStart(2, "0")}.000Z`;
  const prose = (owner: AgentTurn, id: string, content: string, seconds: number): ChatMessage => ({
    id, conversationId, turnId: owner.id, role: "assistant", content, attachments: [], createdAt: at(seconds),
  });
  const commentary = (owner: AgentTurn): ChatMessage[] => [
    prose(owner, "before", "Splitting the review across helpers.", 2),
    prose(owner, "after", "Meanwhile I am reading the tests.", 20),
  ];
  const codexChild = (owner: AgentTurn, id: string, seconds: number, update: Partial<SubagentTrace> = {}): SubagentTrace => taskTrace({
    id,
    conversationId,
    runId: owner.runId,
    turnId: owner.id,
    providerId: "codex",
    providerToolUseId: `collab-${id}`,
    activityId: null,
    providerName: `Helper ${id}`,
    createdAt: at(seconds),
    updatedAt: at(seconds),
    ...update,
  });
  const follows = (first: Element, second: Element): boolean =>
    Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
  const group = (name: string): Element => screen.getByRole("button", { name }).closest(".subagent-group")!;
  function expectBetweenProse(element: Element): void {
    expect(follows(screen.getByText("Splitting the review across helpers."), element)).toBe(true);
    expect(follows(element, screen.getByText("Meanwhile I am reading the tests."))).toBe(true);
  }

  it("shows a running child agent where it started, between the prose around it, not at the bottom", () => {
    const owner = turn("codex", "running");
    renderTurn(owner, [codexChild(owner, "child", 8)], [], [], commentary(owner));
    expectBetweenProse(group("1 subagent, 1 working"));
    expectBetweenProse(document.querySelector('[data-subagent-trace="child"]')!);
  });

  it("keeps a child agent where it started once it finishes and after the chat reloads", () => {
    const owner = turn("codex", "running");
    const running = codexChild(owner, "child", 8);
    const view = renderTurn(owner, [running], [], [], commentary(owner));
    const finished = { ...running, status: "completed" as const, isLive: false, sequence: 2, updatedAt: at(40) };
    view.rerender(timeline(owner, [finished], [], [], commentary(owner)));
    expectBetweenProse(group("1 subagent, 1 done"));
    view.unmount();

    const settled = turn("codex", "completed");
    renderTurn(settled, [{ ...finished, turnId: settled.id, runId: settled.runId }], [], [], commentary(settled));
    const placed = group("1 subagent, 1 done");
    expect(placed.closest(".turn-fold-body")).not.toBeNull();
    expectBetweenProse(placed);
  });

  it("draws a Claude agent's group right after the tool call that started it", () => {
    const owner = turn("claude", "running");
    const linked = taskTrace({
      id: "trace-linked",
      conversationId,
      runId: owner.runId,
      turnId: owner.id,
      activityId: "activity-agent-call",
      description: "Audit the tokenizer",
      createdAt: at(6),
    });
    renderTurn(owner, [linked], [agentRow(owner)], [], commentary(owner));
    const row = document.querySelector('[data-subagent-trace="trace-linked"]')!;
    const placed = group("1 subagent, 1 working");
    expectBetweenProse(row);
    expect(follows(row, placed)).toBe(true);
    expectBetweenProse(placed);
  });

  it("leaves the live work group before a just-started agent open, as the newest work", () => {
    const owner = turn("codex", "running");
    const command = (id: string, seconds: number): AgentActivity => ({
      id, conversationId, runId: owner.runId, turnId: owner.id, kind: "command", title: `Run ${id}`, detail: null, status: "completed", createdAt: at(seconds),
    });
    renderTurn(owner, [codexChild(owner, "child", 12)], [command("lint", 10), command("test", 11)], [], [commentary(owner)[0]!]);
    const work = document.querySelector("[data-activity-group]")!;
    expect(follows(work, group("1 subagent, 1 working"))).toBe(true);
    expect(work).toHaveAttribute("data-activity-group-state", "live");
  });

  it("groups agents started together, keeps nested agents with their parent and places later agents apart", () => {
    const owner = turn("codex", "running");
    renderTurn(owner, [
      codexChild(owner, "first", 8),
      codexChild(owner, "second", 9),
      codexChild(owner, "nested", 30, { parentTraceId: "first" }),
      codexChild(owner, "later", 25),
    ], [], [], commentary(owner));
    expect(document.querySelectorAll(".subagent-group")).toHaveLength(2);
    expectBetweenProse(group("3 subagents, 3 working"));
    const later = group("1 subagent, 1 working");
    expect(follows(screen.getByText("Meanwhile I am reading the tests."), later)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "3 subagents, 3 working" }));
    expect(screen.getByRole("button", { name: "3 subagents, 3 working" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "1 subagent, 1 working" })).toHaveAttribute("aria-expanded", "false");
  });
});
