import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { ActivityGroup } from "../../src/renderer/src/components/response-timeline/activity";
import {
  THINKING_LINE_MAX_DWELL_MS,
  THINKING_LINE_MIN_DWELL_MS,
  thinkingLineDwellMs,
} from "../../src/renderer/src/utils/reasoningSummary";
import type {
  AgentActivity,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  SubagentTrace,
} from "../../src/shared/contracts";

const conversationId = "33333333-3333-4333-8333-333333333333";

function agentTurn(
  status: AgentTurn["status"] = "running",
  runState?: AgentTurn["runState"],
): AgentTurn {
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
    ...(runState ? { runState } : {}),
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
  runState?: AgentTurn["runState"];
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
    turns: [agentTurn(input.status, input.runState)],
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
  it("reveals older running operations independently of completed history and folds them after settlement", () => {
    const activities = Array.from({ length: 20 }, (_, index) => ({
      ...activity(`Operation ${index}`), id: `operation-${index}`,
      status: index < 8 ? "running" as const : "completed" as const,
    }));
    const entry = { kind: "activity-group" as const, id: "active-group", createdAt: activities[0]!.createdAt, activities };
    const view = render(<ActivityGroup entry={entry} settled />);
    const visible = (): Element[] => [...view.container.querySelectorAll('[data-folded="false"]')];
    expect(visible()).toHaveLength(8);
    expect(visible()[0]).toHaveTextContent("Operation 0");
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more running operations" }));
    expect(visible()).toHaveLength(12);
    expect(view.container).not.toHaveTextContent("Operation 10");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer running operations" }));
    expect(visible()).toHaveLength(8);
    view.rerender(<ActivityGroup entry={{ ...entry, activities: activities.map((row) => ({ ...row, status: "completed" })) }} settled />);
    expect(visible()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /running operations/u })).not.toBeInTheDocument();
  });

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
    expect(grid).toHaveAttribute("data-phase", "searching");
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

  it("keeps a bounded live window under one summary control that expands and folds the full history", () => {
    const activities = [
      "Read package metadata",
      "Read response timeline",
      "Grep activity rows",
      "Inspect layers",
      "Inspect viewport",
      "Inspect motion",
    ].map((title, index) => ({
      ...activity(title),
      id: `activity-history-${index + 1}`,
      status: index < 2 ? "completed" as const : "running" as const,
    }));
    const { container } = renderState({ activities });
    const group = container.querySelector(".turn-activity-group");
    const rows = () => [...(group?.querySelectorAll<HTMLElement>(".turn-activity-group-row") ?? [])];
    const summary = screen.getByRole("button", {
      name: "2 files read, 1 search, 3 tool calls",
    });

    expect(group).toHaveAttribute("data-activity-group-state", "live");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(rows()).toHaveLength(5);
    expect(rows().filter((row) => row.dataset.folded === "false")).toHaveLength(4);
    const folded = rows().find((row) => row.dataset.folded === "true");
    expect(folded).toHaveAttribute("aria-hidden", "true");
    expect(folded?.hasAttribute("inert")).toBe(true);
    expect(screen.queryByText("package metadata")).toBeNull();

    fireEvent.click(summary);

    expect(group).toHaveAttribute("data-activity-group-expanded", "true");
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(rows()).toHaveLength(6);
    expect(rows().every((row) => row.dataset.folded === "false")).toBe(true);
    expect(rows().every((row) => row.getAttribute("style") === null)).toBe(true);

    fireEvent.click(summary);

    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(rows().filter((row) => row.dataset.folded === "false")).toHaveLength(4);
  });

  it("keeps historical reasoning collapsed without claiming current thought", () => {
    const { container } = renderState({ reasonings: [reasoning()] });

    expect(container.querySelector("[data-active-agent-phase=working]"))
      .toBeInTheDocument();
    const trace = container.querySelector("[data-agent-trace=reasoning] > summary");
    expect(trace).not.toBeNull();
    if (!trace) throw new Error("Expected a reasoning trace disclosure.");
    expect(trace).toHaveTextContent("Thoughtreasoning summary");
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
    expect(container.querySelector(".agent-pixel-loader"))
      .toHaveAttribute("data-phase", "thinking");
    expect(container.querySelectorAll(".turn-working-status .agent-pixel-loader > span"))
      .toHaveLength(9);
    expect(container.querySelector("[data-agent-trace=thinking] > summary"))
      .toHaveTextContent(/^Thinking·\s*\d+\.\ds\s*Live provider summary/u);
  });

  it("streams the newest readable reasoning sentence in a paced brain strip, then folds to its duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-12T12:00:10.000Z"));
    try {
      const first = "**Tracing ownership**\nReading the pane reducer.";
      const firstDwell = thinkingLineDwellMs("Reading the pane reducer.");
      const { container, onStop, rerender } = renderState({
        streamingReasoning: first,
        streamingChannel: "reasoning",
      });
      const summary = container.querySelector<HTMLElement>(
        '[data-thinking-state="live"] > summary',
      );
      if (!summary) throw new Error("Expected a live thinking strip.");
      const entering = (): Element | null =>
        summary.querySelector(".turn-thinking-line > .is-entering");
      expect(summary.querySelector(".lucide-brain")).toBeInTheDocument();
      expect(summary.querySelector(".turn-thinking-label")).toHaveTextContent("Thinking");
      expect(summary.querySelector(".turn-thinking-line")).toHaveAttribute("aria-hidden", "true");
      expect(summary.querySelector(".agent-pixel-loader")).toBeNull();
      expect(container.querySelectorAll(".agent-pixel-loader")).toHaveLength(1);
      const pulse = summary.querySelector(".turn-thinking-pulse");
      expect(pulse?.querySelector(".lucide-brain")).toBeInTheDocument();
      expect(pulse?.querySelector(".turn-thinking-label")).toBeInTheDocument();
      const elapsed = pulse?.querySelector(".turn-thinking-elapsed");
      expect(elapsed).toHaveTextContent(/^·\s*\d+\.\ds$/u);
      expect(
        elapsed!.compareDocumentPosition(summary.querySelector(".turn-thinking-line")!)
          & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(entering()).toHaveTextContent("Reading the pane reducer.");

      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: `${first} Checking the drop plans.`,
        streamingChannel: "reasoning",
      }, onStop)} />);
      expect(entering()).toHaveTextContent("Reading the pane reducer.");
      act(() => {
        vi.advanceTimersByTime(firstDwell - 1);
      });
      expect(entering()).toHaveTextContent("Reading the pane reducer.");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(entering()).toHaveTextContent("Checking the drop plans.");
      expect(summary.querySelector(".turn-thinking-line > .is-leaving"))
        .toHaveTextContent("Reading the pane reducer.");

      act(() => {
        vi.advanceTimersByTime(12_000 - firstDwell);
      });
      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: `${first} Checking the drop plans.`,
        streamingChannel: null,
      }, onStop)} />);
      const folded = container.querySelector<HTMLElement>(
        '[data-thinking-state="folded"] > summary',
      );
      expect(folded).toBe(summary);
      expect(folded).toHaveTextContent(/^Thought for 12s/u);
      expect(folded?.querySelector(".turn-thinking-elapsed")).toBeNull();
      expect(folded?.querySelector(".turn-thinking-line")).toBeNull();
      const styles = readFileSync("src/renderer/src/styles.css", "utf8");
      expect(styles).toMatch(
        /\.turn-thinking\[data-thinking-state="live"\] \.turn-thinking-pulse \{[^}]*animation: turn-thinking-sweep 3400ms/u,
      );
      expect(styles).toContain(
        "mask-image: linear-gradient(100deg, rgb(0 0 0 / 0.38) 34%, #000 50%, rgb(0 0 0 / 0.38) 66%);",
      );
      expect(styles).toMatch(
        /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.turn-thinking\[data-thinking-state="live"\] \.turn-thinking-pulse \{[^}]*animation: none/u,
      );
      expect(styles).toMatch(
        /\.turn-thinking-line \{[^}]*min-height: 3em;[^}]*align-items: center;/u,
      );
      expect(styles).toMatch(
        /\.turn-thinking-line > span \{[^}]*overflow: hidden;[^}]*-webkit-line-clamp: 2;/u,
      );
      expect(styles).toMatch(
        /\.turn-thinking\[data-thinking-state="live"\]\[data-thinking-hold\] \.turn-thinking-pulse \{\s*animation-play-state: paused;/u,
      );
      expect(screen.queryByText("Tracing ownership")).not.toBeInTheDocument();
      fireEvent.click(summary);
      expect(screen.getByText("Tracing ownership")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a mid-sentence fragment back until it finishes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-12T12:00:10.000Z"));
    try {
      const first = "**Tracing ownership**\nReading the pane reducer.";
      const { container, onStop, rerender } = renderState({
        streamingReasoning: first,
        streamingChannel: "reasoning",
      });
      const summary = container.querySelector<HTMLElement>(
        '[data-thinking-state="live"] > summary',
      );
      if (!summary) throw new Error("Expected a live thinking strip.");
      const entering = (): Element | null =>
        summary.querySelector(".turn-thinking-line > .is-entering");
      expect(entering()).toHaveTextContent("Reading the pane reducer.");

      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: `${first} Checking`,
        streamingChannel: "reasoning",
      }, onStop)} />);
      act(() => {
        vi.advanceTimersByTime(THINKING_LINE_MAX_DWELL_MS * 4);
      });
      expect(entering()).toHaveTextContent("Reading the pane reducer.");
      expect(summary.querySelector(".turn-thinking-line > .is-leaving")).toBeNull();

      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: `${first} Checking the drop plans.`,
        streamingChannel: "reasoning",
      }, onStop)} />);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(entering()).toHaveTextContent("Checking the drop plans.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a short finished sentence its minimum reading time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-12T12:00:10.000Z"));
    try {
      const first = "**Tracing ownership**\nRun tests.";
      const { container, onStop, rerender } = renderState({
        streamingReasoning: first,
        streamingChannel: "reasoning",
      });
      const summary = container.querySelector<HTMLElement>(
        '[data-thinking-state="live"] > summary',
      );
      if (!summary) throw new Error("Expected a live thinking strip.");
      const entering = (): Element | null =>
        summary.querySelector(".turn-thinking-line > .is-entering");
      expect(entering()).toHaveTextContent("Run tests.");

      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: `${first} Read the failures.`,
        streamingChannel: "reasoning",
      }, onStop)} />);
      act(() => {
        vi.advanceTimersByTime(THINKING_LINE_MIN_DWELL_MS - 1);
      });
      expect(entering()).toHaveTextContent("Run tests.");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(entering()).toHaveTextContent("Read the failures.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the last sentence through a pause, then folds once it has been readable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-12T12:00:10.000Z"));
    try {
      const first = "Reading the pane reducer.";
      const second = `${first} Checking the drop plans.`;
      const { container, onStop, rerender } = renderState({
        streamingReasoning: first,
        streamingChannel: "reasoning",
      });
      const details = container.querySelector<HTMLElement>("details.turn-thinking");
      if (!details) throw new Error("Expected a thinking disclosure.");
      const entering = (): Element | null =>
        details.querySelector(".turn-thinking-line > .is-entering");
      const elapsed = (): string =>
        details.querySelector(".turn-thinking-elapsed")?.textContent ?? "";

      act(() => {
        vi.advanceTimersByTime(500);
      });
      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: first,
        streamingChannel: null,
      }, onStop)} />);
      expect(details).toHaveAttribute("data-thinking-state", "live");
      expect(details).toHaveAttribute("data-thinking-hold", "");
      expect(details).toHaveAttribute("data-agent-trace", "reasoning");
      expect(details.querySelector(".turn-thinking-label")).toHaveTextContent("Thinking");
      expect(entering()).toHaveTextContent(first);
      const paused = elapsed();
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(elapsed()).toBe(paused);

      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: second,
        streamingChannel: "reasoning",
      }, onStop)} />);
      expect(details).not.toHaveAttribute("data-thinking-hold");
      expect(details).toHaveAttribute("data-agent-trace", "thinking");
      expect(entering()).toHaveTextContent(first);
      act(() => {
        vi.advanceTimersByTime(thinkingLineDwellMs(first) - 1_500);
      });
      expect(entering()).toHaveTextContent("Checking the drop plans.");

      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: second,
        streamingChannel: null,
      }, onStop)} />);
      expect(details).toHaveAttribute("data-thinking-hold", "");
      act(() => {
        vi.advanceTimersByTime(thinkingLineDwellMs("Checking the drop plans.") - 1);
      });
      expect(details).toHaveAttribute("data-thinking-state", "live");
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(details).toHaveAttribute("data-thinking-state", "folded");
      expect(details).not.toHaveAttribute("data-thinking-hold");
      expect(details.querySelector("summary")).toHaveTextContent(
        /^Thought for \d+sreasoning summary/u,
      );
      expect(details.querySelector(".turn-thinking-line")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      rerender(<ResponseTimeline {...stateProps({
        streamingReasoning: `${second}\n\nThe tests pass`,
        streamingChannel: "reasoning",
      }, onStop)} />);
      expect(details).toHaveAttribute("data-thinking-state", "live");
      expect(entering()).toHaveTextContent("The tests pass");
      expect(details.querySelector(".turn-thinking-line > .is-leaving")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    expect(grid).toHaveAttribute("data-phase", "waiting-for-approval");
    expect(container.querySelector(".turn-working-elapsed"))
      .toHaveAttribute("aria-live", "off");
  });

  it("renders delegated, retrying, and exact-process cancellation as live states", () => {
    const { container, onStop, rerender } = renderState({
      runState: {
        state: "delegated",
        providerState: "thread/running",
        revision: 3,
      },
    });
    expect(container.querySelector("[data-active-work-region]"))
      .toHaveAttribute("data-active-work-state", "delegated");
    expect(container.querySelector(".turn-working-status"))
      .toHaveTextContent("Codex · Codex App Server delegating");

    rerender(<ResponseTimeline {...stateProps({
      runState: {
        state: "retrying",
        providerState: "error/willRetry",
        revision: 4,
      },
    }, onStop)} />);
    expect(container.querySelector("[data-active-agent-phase=retrying]"))
      .toBeInTheDocument();
    expect(container.querySelector(".turn-working-status"))
      .toHaveTextContent("Codex · Codex App Server retrying");

    rerender(<ResponseTimeline {...stateProps({
      runState: {
        state: "cancelling",
        providerState: "cancel/requested",
        revision: 5,
      },
    }, onStop)} />);
    expect(container.querySelector("[data-active-work-state=cancelling]"))
      .toBeInTheDocument();
    expect(container.querySelector(".turn-working-status"))
      .toHaveTextContent("Codex · Codex App Server stopping");
    const stopping = screen.getByRole("button", {
      name: "Stop Codex · Codex App Server run",
    });
    expect(stopping).toBeDisabled();
    expect(stopping).toHaveTextContent("Stopping");
    fireEvent.click(stopping);
    expect(onStop).not.toHaveBeenCalled();
  });
});
