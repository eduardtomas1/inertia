import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type {
  AgentActivity,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  SubagentTrace,
} from "../../src/shared/contracts";

const conversationId = "33333333-3333-4333-8333-333333333333";

function agentTurn(status: AgentTurn["status"] = "running"): AgentTurn {
  return {
    id: "turn-agent-loading",
    conversationId,
    runId: "run-agent-loading",
    userMessageId: "user-agent-loading",
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: "latest",
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 4,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 4,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: "latest",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2026-08-12T12:00:00.000Z",
    startedAt: status === "queued" ? null : "2026-08-12T12:00:02.000Z",
    completedAt: null,
    status,
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 4,
    association: "authoritative",
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:08.000Z",
  };
}

function userMessage(): ChatMessage {
  return {
    id: "user-agent-loading",
    conversationId,
    turnId: "turn-agent-loading",
    role: "user",
    content: "Inspect the live agent state.",
    attachments: [],
    createdAt: "2026-08-12T12:00:00.000Z",
  };
}

function commentaryMessage(content: string): ChatMessage {
  return {
    id: "commentary-agent-loading",
    conversationId,
    turnId: "turn-agent-loading",
    role: "assistant",
    content,
    attachments: [],
    createdAt: "2026-08-12T12:00:04.000Z",
  };
}

function activity(title: string, kind: AgentActivity["kind"] = "tool"): AgentActivity {
  return {
    id: "activity-agent-loading",
    conversationId,
    runId: "run-agent-loading",
    turnId: "turn-agent-loading",
    kind,
    title,
    detail: null,
    status: "running",
    createdAt: "2026-08-12T12:00:06.000Z",
  };
}

function reasoning(): AgentReasoning {
  return {
    id: "reasoning-agent-loading",
    conversationId,
    runId: "run-agent-loading",
    turnId: "turn-agent-loading",
    content: "**Inspecting state ownership**\nThe provider summary is safe to show.",
    status: "running",
    createdAt: "2026-08-12T12:00:05.000Z",
  };
}

interface StateInput {
  status?: AgentTurn["status"];
  activities?: AgentActivity[];
  reasonings?: AgentReasoning[];
  showThinking?: boolean;
  streamingText?: string;
  streamingReasoning?: string;
  streamingChannel?: "text" | "reasoning" | null;
  commentaryContent?: string;
}

function stateProps(
  input: StateInput,
  onStop: () => void,
): React.ComponentProps<typeof ResponseTimeline> {
  return {
    turns: [agentTurn(input.status)],
    messages: [
      userMessage(),
      ...(input.commentaryContent
        ? [commentaryMessage(input.commentaryContent)]
        : []),
    ],
    activities: input.activities ?? [],
    reasonings: input.reasonings ?? [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-agent-loading",
    conversationId,
    streamingText: input.streamingText ?? "",
    streamingReasoning: input.streamingReasoning ?? "",
    streamingChannel: input.streamingChannel ?? null,
    approvals: [],
    inputRequests: [],
    showTimestamps: false,
    showThinking: input.showThinking ?? true,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: false,
    checkpointRestoreDisabled: true,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
    onStop,
  };
}

function renderState(input: StateInput = {}) {
  const onStop = vi.fn<() => void>();
  const result = render(<ResponseTimeline {...stateProps(input, onStop)} />);
  return { ...result, onStop };
}

afterEach(() => cleanup());

describe("agent loading and trace DOM", () => {
  it("renders an inert pixel grid, stable live label, exact activity, and quiet timer", () => {
    const { container, onStop } = renderState({
      activities: [activity("Web search")],
    });
    const rail = container.querySelector("[data-active-work-region]");
    const grid = container.querySelector(".agent-pixel-loader");

    expect(rail).toHaveAttribute("data-active-agent-phase", "searching");
    expect(container.querySelector(".turn-working-status")).toHaveTextContent(
      "Codex · Codex App Server is searching",
    );
    expect(container.querySelector(".turn-working-copy small"))
      .toHaveTextContent("Web search");
    expect(grid).toHaveAttribute("aria-hidden", "true");
    expect(grid).toHaveAttribute("data-animated", "true");
    expect(grid?.querySelectorAll(":scope > span")).toHaveLength(9);
    expect(container.querySelector(".turn-working-elapsed"))
      .toHaveAttribute("aria-live", "off");
    expect(container.querySelector('[data-activity-category="searching"]'))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "Stop Codex · Codex App Server run",
    }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("keeps historical reasoning collapsed without claiming current thought", () => {
    const { container } = renderState({ reasonings: [reasoning()] });

    expect(container.querySelector("[data-active-agent-phase=working]"))
      .toBeInTheDocument();
    const trace = container.querySelector("[data-agent-trace=reasoning] > summary");
    expect(trace).not.toBeNull();
    if (!trace) throw new Error("Expected a reasoning trace disclosure.");
    expect(trace).toHaveTextContent("Reasoningreasoning summary");
    expect(trace).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Inspecting state ownership")).not
      .toBeInTheDocument();

    fireEvent.click(trace);
    expect(trace).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Inspecting state ownership"))
      .toBeInTheDocument();
    expect(screen.getByText("The provider summary is safe to show."))
      .toBeInTheDocument();
  });

  it("claims current thought only while a live reasoning delta owns the channel", () => {
    const { container } = renderState({
      reasonings: [reasoning()],
      streamingReasoning: "Live provider summary",
      streamingChannel: "reasoning",
    });

    expect(container.querySelector("[data-active-agent-phase=thinking]"))
      .toBeInTheDocument();
    expect(container.querySelector("[data-agent-trace=thinking] > summary"))
      .toHaveTextContent("Thinkingreasoning summary");
  });

  it("presents retained reconnect text as historical until text owns the channel", () => {
    const input = {
      streamingText: [
        "Visible before reconnect.",
        "",
        "```ts",
        "const historical = true;",
        "```",
        "",
        "| State | Live |",
        "| --- | --- |",
        "| Retained | No |",
      ].join("\n"),
    };
    const { onStop, rerender } = renderState(input);

    const historical = screen.getByLabelText("Agent update");
    expect(historical).not.toHaveClass("is-streaming");
    expect(historical).not.toHaveAttribute("role", "status");
    expect(historical).not.toHaveAttribute("aria-live");
    expect(historical.querySelector("[aria-live]")).toBeNull();
    expect(historical.querySelector("[role=status]")).toBeNull();
    expect(within(historical).getByTitle("Copy code")).toBeInTheDocument();
    expect(within(historical).getByRole("button", { name: "Markdown" }))
      .toBeInTheDocument();
    expect(historical.querySelector(".response-markdown"))
      .not.toHaveClass("is-streaming");
    expect(screen.queryByLabelText("Live agent update")).not
      .toBeInTheDocument();

    rerender(<ResponseTimeline {...stateProps({
      ...input,
      streamingChannel: "text",
    }, onStop)} />);

    const live = screen.getByLabelText("Live agent update");
    expect(live).toHaveClass("is-streaming");
    expect(live.querySelector(".response-markdown"))
      .toHaveClass("is-streaming");
  });

  it("retains copy-feedback announcements for persisted commentary", () => {
    const { container } = renderState({
      commentaryContent: [
        "```ts",
        "const persisted = true;",
        "```",
        "",
        "| State |",
        "| --- |",
        "| Persisted |",
      ].join("\n"),
    });
    const persisted = container.querySelector(
      '[data-assistant-commentary-id="commentary-agent-loading"]',
    );
    expect(persisted).not.toBeNull();
    expect(persisted?.querySelectorAll('[role="status"][aria-live="polite"]'))
      .toHaveLength(2);
  });

  it("rerenders a channel-only transition back to honest generic work", () => {
    const input = {
      reasonings: [reasoning()],
      streamingReasoning: "Live provider summary",
    };
    const { container, onStop, rerender } = renderState({
      ...input,
      streamingChannel: "reasoning",
    });
    expect(container.querySelector("[data-active-agent-phase=thinking]"))
      .toBeInTheDocument();

    rerender(<ResponseTimeline {...stateProps({
      ...input,
      streamingChannel: null,
    }, onStop)} />);

    expect(container.querySelector("[data-active-agent-phase=working]"))
      .toBeInTheDocument();
    expect(container.querySelector("[data-agent-trace=reasoning]"))
      .toBeInTheDocument();
  });

  it("removes live work and Stop for projected terminal outcomes", () => {
    const { container, onStop, rerender } = renderState({
      status: "completed",
    });

    expect(container.querySelector("[data-active-work-region]"))
      .not.toBeInTheDocument();
    expect(container.querySelector(".turn-working-status"))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Stop Codex · Codex App Server run",
    })).not.toBeInTheDocument();

    rerender(<ResponseTimeline {...stateProps({ status: "failed" }, onStop)} />);

    expect(container.querySelector("[data-active-work-region]"))
      .not.toBeInTheDocument();
    expect(container.querySelector(".turn-working-status"))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Stop Codex · Codex App Server run",
    })).not.toBeInTheDocument();
  });

  it("settles nested subagent controls while a newer turn remains active", () => {
    const baseTurn = agentTurn();
    const staleTurn: AgentTurn = {
      ...baseTurn,
      id: "turn-stale-projected",
      runId: "run-stale-projected",
      userMessageId: "user-stale-projected",
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      model: "sonnet",
      modelAlias: null,
      modelSelection: {
        ...baseTurn.modelSelection,
        harnessId: "claude-agent-sdk",
        backendProfileId: "builtin:claude",
        backendProfileDisplayName: "Claude",
        modelId: "sonnet",
        alias: null,
      },
      continuationIdentity: {
        harnessId: "claude-agent-sdk",
        backendProfileId: "builtin:claude",
        backendConfigurationRevision: 4,
        endpointIdentity: "native:claude",
        modelIdentity: null,
      },
    };
    const currentTurn: AgentTurn = {
      ...baseTurn,
      id: "turn-current-active",
      runId: "run-current-active",
      userMessageId: "user-current-active",
      requestedAt: "2026-08-12T12:01:00.000Z",
      startedAt: "2026-08-12T12:01:02.000Z",
      createdAt: "2026-08-12T12:01:00.000Z",
      updatedAt: "2026-08-12T12:01:08.000Z",
    };
    const delegated: SubagentTrace = {
      id: "trace-stale-projected",
      conversationId,
      runId: staleTurn.runId,
      turnId: staleTurn.id,
      providerId: "claude",
      providerTaskId: "task-stale-projected",
      providerAgentId: "agent-stale-projected",
      parentTraceId: null,
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: "tool-stale-projected",
      providerRole: "reviewer",
      providerName: "Settled reviewer",
      providerStatus: "running",
      status: "running",
      isLive: true,
      description: "Review the prior turn.",
      progress: "Waiting for terminal persistence.",
      result: null,
      sequence: 1,
      createdAt: "2026-08-12T12:00:03.000Z",
      updatedAt: "2026-08-12T12:00:07.000Z",
    };
    const onStop = vi.fn<() => void>();
    const owner = `${staleTurn.runId}\0${staleTurn.id}`;

    const { container } = render(<ResponseTimeline
      {...stateProps({}, onStop)}
      turns={[staleTurn, currentTurn]}
      messages={[
        {
          ...userMessage(),
          id: staleTurn.userMessageId,
          turnId: staleTurn.id,
        },
        {
          ...userMessage(),
          id: currentTurn.userMessageId,
          turnId: currentTurn.id,
          content: "Continue with the next turn.",
          createdAt: currentTurn.createdAt,
        },
      ]}
      subagents={[delegated]}
      terminalProjections={{
        [owner]: { owner, status: "completed", terminalReason: null },
      }}
      onFollowUpSubagent={vi.fn()}
      onStopSubagent={vi.fn(async () => undefined)}
    />);

    expect(container.querySelector(
      `[data-turn-id="${staleTurn.id}"] [data-active-work-region]`,
    )).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Settled reviewer" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guide parent" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Stop Codex · Codex App Server run",
    })).toBeInTheDocument();
  });

  it("pauses the loader for waiting states and announces no timer changes", () => {
    const { container } = renderState({ status: "waiting-for-approval" });
    const grid = container.querySelector(".agent-pixel-loader");

    expect(container.querySelector("[data-active-agent-phase=waiting-for-approval]"))
      .toBeInTheDocument();
    expect(container.querySelector(".turn-working-status"))
      .toHaveTextContent("Codex · Codex App Server needs approval");
    expect(grid).toHaveAttribute("data-animated", "false");
    expect(container.querySelector(".turn-working-elapsed"))
      .toHaveAttribute("aria-live", "off");
  });
});
