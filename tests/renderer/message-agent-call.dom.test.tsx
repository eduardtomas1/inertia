import { readFileSync } from "node:fs";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { MessageAgentCall } from "../../src/renderer/src/components/response-timeline/MessageAgentCall";
import { DelegationSurfaceProvider } from "../../src/renderer/src/components/orchestration/delegation-surface";
import type { DelegationCommandRunner } from "../../src/renderer/src/components/orchestration/delegation-model";
import type { AgentTurn, ChatMessage, SubagentTrace } from "../../src/shared/contracts";
import type { CustomAgentCallAttribution } from "../../src/shared/custom-agents";
import { taskTrace } from "./background-task-fixtures";

const conversationId = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

const attribution: CustomAgentCallAttribution = {
  agentId: AGENT_ID,
  revision: 4,
  handle: "code-reviewer",
  name: "Code reviewer",
  icon: { kind: "symbol", name: "shield" },
  accent: "teal",
  delivery: "subagent",
};

function agentTurn(index: number): AgentTurn {
  const requestedAt = `2026-07-29T10:00:0${index}.000Z`;
  return {
    id: `turn-${index}`,
    conversationId,
    runId: `run-${index}`,
    userMessageId: `user-${index}`,
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: null,
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: null,
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt,
    startedAt: requestedAt,
    completedAt: requestedAt,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
}

function userMessage(index: number, content: string): ChatMessage {
  return {
    id: `user-${index}`,
    conversationId,
    turnId: `turn-${index}`,
    role: "user",
    content,
    attachments: [],
    createdAt: `2026-07-29T10:00:0${index}.000Z`,
  };
}

function renderTimeline(messages: ChatMessage[], turns: AgentTurn[], subagents: SubagentTrace[] = [], run?: DelegationCommandRunner): void {
  const timeline = (
    <ResponseTimeline
      turns={turns}
      messages={messages}
      activities={[]}
      subagents={subagents}
      customAgents={[]}
      reasonings={[]}
      plans={[]}
      checkpoints={[]}
      projectRoot="/workspace"
      projectId="project-1"
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
      checkpointRestoreDisabled={false}
      onRespondToApproval={async () => undefined}
      onRespondToInput={async () => undefined}
      onRevertCheckpoint={() => undefined}
      onOpenTurnDiff={() => undefined}
      onCompareTurnArtifacts={() => undefined}
      onOpenTurnFile={() => undefined}
      onStop={() => undefined}
    />
  );
  render(run
    ? <DelegationSurfaceProvider conversationId={conversationId} delegation={undefined} conversations={undefined} run={run}
      openConversation={undefined}>{timeline}</DelegationSurfaceProvider>
    : timeline);
}

describe("called agent badge", () => {
  it("renders the frozen attribution and marks in-role delivery honestly", () => {
    const { container, rerender } = render(<MessageAgentCall attribution={attribution} />);
    expect(container.querySelector(".message-agent-call")).toHaveTextContent("Called Code reviewer");
    expect(container.querySelector(".custom-agent-avatar")).toHaveAttribute("aria-hidden", "true");
    expect(container).not.toHaveTextContent("in role");
    rerender(<MessageAgentCall attribution={{ ...attribution, delivery: "in-role" }} />);
    expect(container.querySelector(".message-agent-call-delivery")).toHaveTextContent(/^in role$/u);
  });

  it("wears a 24 px mark without an inset, live ring or glow, with the separator drawn in CSS", () => {
    const { container } = render(<MessageAgentCall attribution={{ ...attribution, icon: { kind: "mark", name: "guard" }, delivery: "in-role" }} />);
    const avatar = container.querySelector<HTMLElement>(".custom-agent-avatar")!;
    expect(avatar).toHaveAttribute("data-mark", "guard");
    expect(avatar).not.toHaveAttribute("data-live");
    expect(avatar.style.getPropertyValue("--agent-avatar-size")).toBe("24px");
    expect(avatar.style.getPropertyValue("--agent-mark-inset")).toBe("0px");
    expect(avatar.querySelector("img")).toBeNull();
    const css = readFileSync("src/renderer/src/components/response-timeline/MessageAgentCall.css", "utf8").replaceAll("\r\n", "\n");
    expect(css).toMatch(/\.message-agent-call \.custom-agent-avatar::before,\n\.message-agent-call \.custom-agent-avatar::after \{\n  content: none;/u);
    expect(css).toMatch(/\.message-agent-call-delivery::before \{\n  color: var\(--text-faint\);\n  content: "· ";/u);
  });

  it("shows the badge above the request and the call block even after the agent was deleted", async () => {
    const turn = { ...agentTurn(1), terminalAssistantMessageId: "assistant-1" };
    const request = { ...userMessage(1, "Review the staged diff"), customAgentCall: { ...attribution, delivery: "in-role" as const } };
    const answer: ChatMessage = {
      id: "assistant-1",
      conversationId,
      turnId: "turn-1",
      role: "assistant",
      content: "The reviewer found nothing to fix.",
      attachments: [],
      createdAt: "2026-07-29T10:00:05.000Z",
    };
    const trace = taskTrace({
      id: "call-1",
      conversationId,
      turnId: "turn-1",
      customAgentId: AGENT_ID,
      status: "completed",
      isLive: false,
      result: "No regressions.",
      createdAt: "2026-07-29T10:00:02.000Z",
      updatedAt: "2026-07-29T10:00:04.000Z",
    });
    renderTimeline([request, answer], [turn], [trace]);
    const requestRow = await screen.findByRole("article", { name: "Your request" });
    const badge = requestRow.querySelector(".message-agent-call")!;
    expect(badge).toHaveTextContent("Called Code reviewerin role");
    expect(badge.compareDocumentPosition(requestRow.querySelector(".message-body")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("region", { name: "Called agent Code reviewer" })).toBeInTheDocument();
    expect(screen.queryByText(/1 agent finished/u)).toBeNull();
  });

  it("keeps Agent details on a turn whose only subagents are custom agent calls", async () => {
    const turn = { ...agentTurn(1), terminalAssistantMessageId: "assistant-1" };
    const request = { ...userMessage(1, "Review the staged diff"), customAgentCall: attribution };
    const answer: ChatMessage = {
      id: "assistant-1", conversationId, turnId: "turn-1", role: "assistant",
      content: "The reviewer found nothing to fix.", attachments: [], createdAt: "2026-07-29T10:00:05.000Z",
    };
    const trace = taskTrace({
      id: "call-1", conversationId, turnId: "turn-1", customAgentId: AGENT_ID, status: "completed", isLive: false,
      result: "No regressions.", createdAt: "2026-07-29T10:00:02.000Z", updatedAt: "2026-07-29T10:00:04.000Z",
    });
    renderTimeline([request, answer], [turn], [trace], vi.fn<DelegationCommandRunner>());
    await screen.findByRole("region", { name: "Called agent Code reviewer" });
    const fold = document.querySelector<HTMLButtonElement>(".turn-fold-toggle");
    if (fold?.getAttribute("aria-expanded") === "false") fireEvent.click(fold);
    expect(await screen.findByRole("button", { name: "Agent details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^\d+ subagents?, /u })).toBeNull();
  });
});

describe("observed agent details in a settled fold", () => {
  it("sits in the region the fold toggle controls and keeps its open state while the fold is closed", async () => {
    const turn = { ...agentTurn(1), terminalAssistantMessageId: "assistant-1" };
    const answer: ChatMessage = {
      id: "assistant-1", conversationId, turnId: "turn-1", role: "assistant",
      content: "The subagent found the cause.", attachments: [], createdAt: "2026-07-29T10:00:05.000Z",
    };
    const trace = taskTrace({
      id: "task-1", conversationId, turnId: "turn-1", status: "completed", isLive: false,
      result: "Cause found.", createdAt: "2026-07-29T10:00:02.000Z", updatedAt: "2026-07-29T10:00:04.000Z",
    });
    renderTimeline([userMessage(1, "Find the cause"), answer], [turn], [trace], vi.fn<DelegationCommandRunner>());
    await screen.findByText("The subagent found the cause.");
    const toggle = document.querySelector<HTMLButtonElement>(".turn-fold-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(region).not.toBeNull();
    expect(region.hidden).toBe(true);
    // Mounted inside the fold's region while it is closed, so the toggle hides and shows it.
    expect(region.querySelector(".subagent-group-inspect")?.textContent).toBe("Agent details");

    fireEvent.click(toggle);
    expect(region.hidden).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Agent details" }));
    expect(screen.getByRole("button", { name: "Hide agent details" })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(region.hidden).toBe(true);
    expect(region.querySelector(".subagent-group-inspect")?.textContent).toBe("Hide agent details");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide agent details" })).toBeInTheDocument();
    expect(document.querySelectorAll(".subagent-group-inspect")).toHaveLength(1);
  });
});
