import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type {
  AgentActivity,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
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
}

function stateProps(
  input: StateInput,
  onStop: () => void,
): React.ComponentProps<typeof ResponseTimeline> {
  return {
    turns: [agentTurn(input.status)],
    messages: [userMessage()],
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
    const input = { streamingText: "Visible before reconnect." };
    const { onStop, rerender } = renderState(input);

    const historical = screen.getByLabelText("Agent update");
    expect(historical).not.toHaveClass("is-streaming");
    expect(historical).not.toHaveAttribute("role", "status");
    expect(historical).not.toHaveAttribute("aria-live");
    expect(historical.querySelector("[aria-live]")).toBeNull();
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
