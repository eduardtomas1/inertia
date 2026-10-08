import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import { providerNativeBackendProfile } from "../../src/shared/model-routing";

const conversationId = "44444444-4444-4444-8444-444444444444";

function turn(
  id: string,
  providerId: "claude" | "codex",
  requestedAt: string,
  update: Partial<AgentTurn> = {},
): AgentTurn {
  const harnessId = providerId === "claude" ? "claude-agent-sdk" : "codex-app-server";
  const backendProfileId = providerNativeBackendProfile(providerId).id;
  const model = providerId === "claude" ? "claude-sonnet-4-6" : "gpt-5.6";
  return {
    id,
    conversationId,
    runId: `run-${id}`,
    userMessageId: `user-${id}`,
    terminalAssistantMessageId: `assistant-${id}`,
    providerId,
    modelSelection: {
      harnessId,
      backendProfileId,
      backendProfileDisplayName: providerNativeBackendProfile(providerId).displayName,
      modelId: model,
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId,
      backendProfileId,
      backendConfigurationRevision: 1,
      modelIdentity: model,
      endpointIdentity: null,
    },
    harnessId,
    backendProfileId,
    model,
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: `session-${id}`,
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
    ...update,
  };
}

function messages(agentTurn: AgentTurn, request: string, answer: string): ChatMessage[] {
  return [
    { id: agentTurn.userMessageId, conversationId, turnId: agentTurn.id, role: "user", content: request, attachments: [], createdAt: agentTurn.requestedAt },
    { id: agentTurn.terminalAssistantMessageId!, conversationId, turnId: agentTurn.id, role: "assistant", content: answer, attachments: [], createdAt: agentTurn.completedAt! },
  ];
}

function timeline(turns: AgentTurn[], providerIdentityLabels?: Record<string, string>) {
  return render(<ResponseTimeline
    turns={turns}
    messages={turns.flatMap((agentTurn) => messages(agentTurn, `Request ${agentTurn.id}`, `Answer ${agentTurn.id}`))}
    activities={[]}
    reasonings={[]}
    plans={[]}
    checkpoints={[]}
    projectRoot="/workspace"
    projectId="project-provider-handoff"
    conversationId={conversationId}
    streamingText=""
    streamingReasoning=""
    streamingChannel={null}
    approvals={[]}
    inputRequests={[]}
    showTimestamps={false}
    showThinking
    defaultCodeWrap={false}
    autoCollapseWorkLog
    showChangedFileSummaries={false}
    checkpointRestoreDisabled
    providerIdentityLabels={providerIdentityLabels}
    onRespondToApproval={async () => undefined}
    onRespondToInput={async () => undefined}
    onRevertCheckpoint={() => undefined}
    onOpenTurnDiff={() => undefined}
    onCompareTurnArtifacts={() => undefined}
    onOpenTurnFile={() => undefined}
    onStop={() => undefined}
  />);
}

describe("provider handoff divider", () => {
  const claude = turn("turn-claude", "claude", "2026-09-01T10:00:00.000Z");
  const codex = turn("turn-codex", "codex", "2026-09-01T10:05:00.000Z", {
    continuationReasonCode: "harness-changed",
    sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 },
  });

  it("names the switch, both routes, and the carried messages between the two turns", () => {
    const { container } = timeline([codex, claude]);

    const separator = screen.getByRole("separator", {
      name: "Context handoff: Claude · claude-sonnet-4-6 to Codex · gpt-5.6 · 2 earlier messages carried",
    });
    const row = separator.closest<HTMLElement>("section.provider-handoff-row")!;
    expect(row).toHaveAttribute("data-response-row-id", "handoff:turn-codex");
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row).toHaveAttribute("aria-label", separator.getAttribute("aria-label"));
    const pill = row.querySelector(".provider-handoff-marker")!;
    expect(pill).toHaveAttribute("aria-hidden", "true");
    expect(pill).toHaveTextContent("Context handoff·Claude · claude-sonnet-4-6Codex · gpt-5.6·2 earlier messages carried");

    const before = container.querySelector('[data-turn-id="turn-claude"]')!;
    const after = container.querySelector('[data-turn-id="turn-codex"]')!;
    expect(before.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves the session recovery note off the receiving turn because the divider carries it", () => {
    timeline([claude, codex]);
    const receiving = document.querySelector<HTMLElement>('[data-turn-id="turn-codex"]')!;
    expect(receiving.querySelector("[data-session-recovery]")).toBeNull();
    expect(within(receiving).queryByText(/New provider session|Provider changed/u)).not.toBeInTheDocument();
  });

  it("uses configured provider labels and says when nothing was carried", () => {
    timeline([claude, { ...codex, sessionRecovery: { restoredMessageCount: 0, omittedMessageCount: 0 } }], {
      codex: "Team Codex",
    });
    expect(screen.getByRole("separator", {
      name: "Context handoff: Claude · claude-sonnet-4-6 to Team Codex · gpt-5.6 · nothing carried",
    })).toBeInTheDocument();
  });

  it.each([
    [{ restoredMessageCount: 11, omittedMessageCount: 2 }, "11 earlier messages carried · 2 left behind"],
    [{ restoredMessageCount: 1, omittedMessageCount: 0, withheldMessageCount: 3 }, "1 earlier message carried · 3 left behind"],
    [{ restoredMessageCount: 4, omittedMessageCount: 1, withheldMessageCount: 2 }, "4 earlier messages carried · 3 left behind"],
    [{ restoredMessageCount: 0, omittedMessageCount: 7 }, "nothing carried · 7 left behind"],
  ])("counts what stayed behind on the divider for %o", (sessionRecovery, detail) => {
    timeline([claude, { ...codex, sessionRecovery }]);
    const separator = screen.getByRole("separator", {
      name: `Context handoff: Claude · claude-sonnet-4-6 to Codex · gpt-5.6 · ${detail}`,
    });
    expect(separator.querySelector(".provider-handoff-marker")).toHaveTextContent(detail);
  });

  it("draws no divider and names a same-provider harness switch as such", () => {
    timeline([claude, turn("turn-claude-2", "claude", "2026-09-01T10:05:00.000Z", {
      continuationReasonCode: "harness-changed",
      sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 },
    })]);
    expect(screen.queryByRole("separator", { name: /Context handoff/u })).not.toBeInTheDocument();
    const receiving = document.querySelector<HTMLElement>('[data-turn-id="turn-claude-2"]')!;
    expect(within(receiving).getByText(/Agent harness changed · 2 earlier messages restored/u)).toBeInTheDocument();
    expect(screen.queryByText(/Provider changed/u)).not.toBeInTheDocument();
  });

  it.each([
    ["the Kimi route on the Claude harness", "builtin:kimi-code", "Kimi", "Claude · Kimi"],
    ["a custom Claude-compatible backend", "custom-team-proxy", "Team Proxy", "Claude · Team Proxy"],
  ])("names the backend for %s on both sides of the divider", (_route, backendProfileId, backendProfileDisplayName, label) => {
    const onBackend = (agentTurn: AgentTurn, id: string, requestedAt: string): AgentTurn => ({
      ...agentTurn,
      id,
      userMessageId: `user-${id}`,
      terminalAssistantMessageId: `assistant-${id}`,
      requestedAt,
      backendProfileId,
      model: "k3",
      modelSelection: { ...agentTurn.modelSelection, backendProfileId, backendProfileDisplayName, modelId: "k3" },
    });
    const handedBack = turn("turn-codex-2", "codex", "2026-09-01T10:15:00.000Z", {
      continuationReasonCode: "harness-changed",
      sessionRecovery: { restoredMessageCount: 4, omittedMessageCount: 0 },
    });
    timeline([codex, onBackend(claude, "turn-claude-backend", "2026-09-01T10:10:00.000Z"), handedBack]);

    const into = screen.getByRole("separator", { name: `Context handoff: Codex · gpt-5.6 to ${label} · k3` });
    expect(into.querySelector(".provider-handoff-marker")).toHaveTextContent(`${label} · k3`);
    expect(screen.getByRole("separator", {
      name: `Context handoff: ${label} · k3 to Codex · gpt-5.6 · 4 earlier messages carried`,
    })).toBeInTheDocument();
  });

  it("labels each route with its model alias when the turn recorded one", () => {
    timeline([{ ...claude, modelAlias: "Claude Sonnet 4.6" }, { ...codex, modelAlias: "GPT-5.6" }]);
    expect(screen.getByRole("separator", {
      name: "Context handoff: Claude · Claude Sonnet 4.6 to Codex · GPT-5.6 · 2 earlier messages carried",
    })).toBeInTheDocument();
  });
});
