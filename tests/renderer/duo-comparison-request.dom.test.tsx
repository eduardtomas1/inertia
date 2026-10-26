import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import type { DuoComparisonBrief } from "../../src/shared/duo-comparison-brief";

const conversationId = "11111111-1111-4111-8111-111111111111";
const JUDGE_PROMPT = "# Independent Duo comparison\nCompare the two attributed results below and give a decisive judgment.";

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

function brief(overrides: Partial<DuoComparisonBrief["sides"][number]>[] = [{}, {}]): DuoComparisonBrief {
  return {
    launchId: "launch-1",
    sides: [
      { conversationId: "side-a", providerId: "codex", title: "Simplify sign-up", status: "completed", filesChanged: 2, ...overrides[0] },
      { conversationId: "side-b", providerId: "claude", title: "Simplify sign-up", status: "completed", filesChanged: 1, ...overrides[1] },
    ],
  };
}

function renderTimeline(messages: ChatMessage[], turns = [agentTurn(1)]): void {
  render(
    <ResponseTimeline
      turns={turns}
      messages={messages}
      activities={[]}
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
    />,
  );
}

describe("Duo comparison request card", () => {
  it("opens the judge chat on both compared chats instead of the prompt plumbing", async () => {
    renderTimeline([{ ...userMessage(1, JUDGE_PROMPT), duoComparison: brief([{}, { status: "failed", filesChanged: 0 }]) }]);
    const card = await screen.findByRole("article", { name: "Comparing A and B" });
    expect(screen.queryByRole("article", { name: "Your request" })).toBeNull();
    expect(card).not.toHaveTextContent("Independent Duo comparison");
    const rows = within(within(card).getByRole("list", { name: "Compared chats" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Chat A: Simplify sign-up");
    expect(rows[0]).toHaveTextContent("Completed");
    expect(rows[0]).toHaveTextContent("2 files");
    expect(within(rows[0]!).getByRole("img", { name: "OpenAI" })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Chat B: Simplify sign-up");
    expect(rows[1]).toHaveTextContent("Failed");
    expect(rows[1]).toHaveTextContent("No changes");
    expect(rows[1]).toHaveAttribute("data-status", "failed");
  });

  it("reveals the full brief from the keyboard through a disclosure button", async () => {
    const user = userEvent.setup();
    renderTimeline([{ ...userMessage(1, JUDGE_PROMPT), duoComparison: brief() }]);
    const disclosure = await screen.findByRole("button", { name: "Show the full brief" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(disclosure.getAttribute("aria-controls")!)!;
    expect(region).not.toBeVisible();
    disclosure.focus();
    await act(async () => { await user.keyboard("{Enter}"); });
    expect(screen.getByRole("button", { name: "Hide the full brief" })).toHaveAttribute("aria-expanded", "true");
    expect(region).toBeVisible();
    expect(region).toHaveTextContent("Independent Duo comparison");
    await act(async () => { await user.keyboard(" "); });
    expect(screen.getByRole("button", { name: "Show the full brief" })).toHaveAttribute("aria-expanded", "false");
    expect(region).not.toHaveTextContent("Independent Duo comparison");
  });

  it("shows only what the brief recorded when a side's details are missing", async () => {
    renderTimeline([{ ...userMessage(1, JUDGE_PROMPT), duoComparison: brief([{ providerId: null, title: "", filesChanged: null, status: "interrupted" }, {}]) }]);
    const card = await screen.findByRole("article", { name: "Comparing A and B" });
    const [first] = within(card).getAllByRole("listitem");
    expect(first).toHaveTextContent("Untitled chat");
    expect(first).toHaveTextContent("Interrupted");
    expect(first).not.toHaveTextContent(/file|changes/u);
    expect(within(first!).queryByRole("img")).toBeNull();
  });

  it("keeps a plain prompt with the same text as an ordinary request", async () => {
    renderTimeline([userMessage(1, JUDGE_PROMPT)]);
    expect(await screen.findByRole("article", { name: "Your request" })).toHaveTextContent("Independent Duo comparison");
    expect(screen.queryByRole("article", { name: "Comparing A and B" })).toBeNull();
  });
});
