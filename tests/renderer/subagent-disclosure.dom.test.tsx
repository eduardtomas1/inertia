import {
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SubagentDisclosure } from "../../src/renderer/src/components/SubagentDisclosure";
import type {
  AgentTurn,
  SubagentTrace,
} from "../../src/shared/contracts";

const NOW = Date.parse("2030-01-01T00:00:10.000Z");

function trace(update: Partial<SubagentTrace> = {}): SubagentTrace {
  const status = update.status ?? "running";
  return {
    id: "trace-parent",
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerId: "claude",
    providerTaskId: "task-parent",
    providerAgentId: "agent-parent",
    parentTraceId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: "tool-parent",
    providerRole: "researcher",
    providerName: "Evidence scout",
    providerStatus: "running",
    status,
    isLive: update.isLive ?? [
      "queued", "spawned", "running", "waiting",
    ].includes(status),
    description: "Inspect the repository.",
    progress: "Reading the provider adapter.",
    result: null,
    sequence: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:05.000Z",
    ...update,
  };
}

function turn(update: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: "turn-1",
    conversationId: "conversation-1",
    runId: "run-1",
    userMessageId: "message-1",
    terminalAssistantMessageId: null,
    providerId: "claude",
    modelSelection: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendProfileDisplayName: "Claude",
      backendConfigurationRevision: 0,
      modelId: "sonnet",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:claude",
      backendConfigurationRevision: 0,
      endpointIdentity: "native:claude",
      modelIdentity: null,
    },
    harnessId: "claude-agent-sdk",
    backendProfileId: "builtin:claude",
    model: "sonnet",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2030-01-01T00:00:00.000Z",
    startedAt: "2030-01-01T00:00:00.000Z",
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 0,
    association: "authoritative",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...update,
  };
}

describe("delegated-agent timeline disclosure", () => {
  it("opens live work, exposes hierarchy and exact provider metadata, and scopes Stop", async () => {
    const user = userEvent.setup();
    let acknowledgeStop!: () => void;
    const onStop = vi.fn(async () =>
      await new Promise<void>((resolve) => {
        acknowledgeStop = resolve;
      }));
    const onFollowUp = vi.fn();
    const parent = trace();
    const child = trace({
      id: "trace-child",
      providerTaskId: "task-child",
      providerAgentId: "agent-child",
      parentTraceId: parent.id,
      parentProviderAgentId: parent.providerAgentId,
      providerToolUseId: "tool-child",
      providerName: "Policy reader",
      providerStatus: "paused",
      status: "waiting",
      progress: "Waiting for the coordinator.",
      sequence: 2,
    });
    const unsupportedCodex = trace({
      id: "trace-codex",
      providerId: "codex",
      providerTaskId: null,
      providerAgentId: "codex-child",
      providerToolUseId: "spawn-codex",
      providerName: "Build verifier",
      turnId: "turn-codex",
      providerStatus: "pendingInit",
      status: "queued",
      sequence: 3,
    });
    const futureClaude = trace({
      id: "trace-future",
      providerTaskId: "task-future",
      providerAgentId: null,
      providerToolUseId: "tool-future",
      providerName: "Future-state worker",
      providerStatus: "futureState",
      status: "unknown",
      isLive: true,
      sequence: 4,
    });

    render(
      <SubagentDisclosure
        subagents={[parent, child, unsupportedCodex, futureClaude]}
        turns={[
          turn(),
          turn({
            id: "turn-codex",
            providerId: "codex",
            harnessId: "codex-app-server",
          }),
        ]}
        onFollowUpSubagent={onFollowUp}
        onStopSubagent={onStop}
        now={NOW}
      />,
    );

    const disclosure = screen.getByText(
      "4 delegated tasks · 4 working",
    ).closest("details");
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByTitle("Exact provider state: running"))
      .toHaveTextContent("Claude · Agent SDK · 10s");
    expect(screen.getByTitle("Exact provider state: paused"))
      .toHaveTextContent("Claude · Agent SDK · 10s");
    expect(screen.getByTitle("Exact provider state: pendingInit"))
      .toHaveTextContent("Codex · App Server · 10s");
    expect(screen.getByTitle("Exact provider state: futureState"))
      .toHaveTextContent("Claude · Agent SDK · 10s");
    expect(screen.getByText("Child of Evidence scout")).toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "Stop Build verifier",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "Stop Future-state worker",
    })).toBeInTheDocument();

    const childRow = screen.getByRole("listitem", {
      name: /Policy reader/u,
    });
    expect(within(childRow).getByText("Waiting")).toHaveClass(
      "subagent-state-pill",
    );
    expect(childRow.querySelector(".subagent-status-mark"))
      .toHaveAttribute("data-live", "true");
    expect(childRow).toHaveStyle({ "--motion-index": "1" });
    await user.click(within(childRow).getByRole("button", {
      name: "Guide parent",
    }));
    expect(onFollowUp).toHaveBeenCalledWith(child);
    await user.click(within(childRow).getByRole("button", {
      name: "Details",
    }));
    expect(childRow).toHaveAttribute("data-expanded", "true");
    expect(childRow.querySelector(".subagent-detail-reveal"))
      .toBeInTheDocument();
    expect(within(childRow).getByText("Relationship")).toBeInTheDocument();
    expect(within(childRow).getByText("Recent activity")).toBeInTheDocument();
    expect(within(childRow).queryByText(/agent-child|task-child/u))
      .not.toBeInTheDocument();

    await user.click(within(childRow).getByRole("button", {
      name: "Stop Policy reader",
    }));
    expect(onStop).toHaveBeenCalledWith(child);
    expect(within(childRow).getByRole("button", {
      name: "Stopping Policy reader",
    })).toBeDisabled();
    acknowledgeStop();
    expect(screen.queryByRole("button", { name: /retry/iu }))
      .not.toBeInTheDocument();
  });

  it("keeps completed history collapsed until the keyboard-accessible summary opens it", async () => {
    const user = userEvent.setup();
    const completed = trace({
      providerId: "codex",
      providerTaskId: null,
      providerAgentId: "codex-complete",
      providerName: "Completed verifier",
      providerStatus: "completed",
      status: "completed",
      isLive: false,
      progress: null,
      result: "All checks passed.",
      updatedAt: "2030-01-01T00:00:07.000Z",
    });
    render(
      <SubagentDisclosure
        subagents={[completed]}
        turns={[turn({
          providerId: "codex",
          harnessId: "codex-app-server",
          status: "completed",
          completedAt: "2030-01-01T00:00:08.000Z",
        })]}
        now={NOW}
      />,
    );

    const summary = screen.getByText(
      "1 delegated task · 1 settled",
    ).closest("summary");
    const disclosure = summary?.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    summary?.focus();
    await user.keyboard("{Enter}");
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByTitle("Exact provider state: completed"))
      .toHaveTextContent("Codex · App Server · 7s");
    const completedRow = screen.getByRole("listitem", {
      name: /Completed verifier/u,
    });
    expect(within(completedRow).getByText("Completed")).toHaveClass(
      "subagent-state-pill",
    );
    expect(completedRow.querySelector(".subagent-status-mark"))
      .toHaveAttribute("data-status", "completed");
    expect(screen.getByText("All checks passed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop /u }))
      .not.toBeInTheDocument();
  });

  it("keeps the roster open when live work settles into a reviewable failure", () => {
    const active = trace({ providerName: "Lifecycle audit" });
    const view = render(
      <SubagentDisclosure
        subagents={[active]}
        turns={[turn()]}
        now={NOW}
      />,
    );
    const disclosure = screen.getByText(
      "1 delegated task · 1 working",
    ).closest("details");
    expect(disclosure).toHaveAttribute("open");

    view.rerender(
      <SubagentDisclosure
        subagents={[trace({
          providerName: "Lifecycle audit",
          providerStatus: "failed",
          status: "failed",
          isLive: false,
          progress: null,
          result: "The provider rejected the child task.",
          sequence: 2,
        })]}
        turns={[turn({ status: "failed" })]}
        now={NOW}
      />,
    );

    expect(disclosure).toHaveAttribute("open");
    expect(disclosure).toHaveAttribute("data-needs-review", "true");
    expect(screen.getByText(
      "1 delegated task · 1 needs review",
    )).toBeInTheDocument();
    expect(screen.getByText("The provider rejected the child task."))
      .toBeInTheDocument();
  });

  it("bounds a large live roster until the user explicitly asks for all rows", async () => {
    const user = userEvent.setup();
    const onBeforeToggle = vi.fn();
    const onAfterToggle = vi.fn();
    const traces = Array.from({ length: 8 }, (_, index) => trace({
      id: `trace-${index}`,
      providerTaskId: `task-${index}`,
      providerAgentId: `agent-${index}`,
      providerName: `Worker ${index}`,
      sequence: index + 1,
    }));
    render(
      <SubagentDisclosure
        subagents={traces}
        turns={[turn()]}
        now={NOW}
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
      />,
    );

    const tree = screen.getByRole("list", { name: "Delegated agent tree" });
    expect(tree.children).toHaveLength(6);
    expect(screen.getByText("Worker 7")).toBeInTheDocument();
    const toggle = screen.getByRole("button", {
      name: "Show 2 more delegated tasks",
    });
    await user.click(toggle);
    expect(onBeforeToggle).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onAfterToggle).toHaveBeenCalledTimes(1));
    expect(tree.children).toHaveLength(8);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("reserves compact roster slots for separate urgent branches", () => {
    const deepBranch = Array.from({ length: 11 }, (_, index) => trace({
      id: `deep-${index}`,
      providerTaskId: `deep-task-${index}`,
      providerAgentId: `deep-agent-${index}`,
      parentTraceId: index === 0 ? null : `deep-${index - 1}`,
      providerName: `Deep worker ${index}`,
      providerStatus: index % 2 === 0 ? "running" : "completed",
      status: index % 2 === 0 ? "running" : "completed",
      isLive: index % 2 === 0,
      sequence: index + 2,
    }));
    const failedSibling = trace({
      id: "failed-sibling",
      providerTaskId: "failed-task",
      providerAgentId: "failed-agent",
      providerName: "Failed sibling",
      providerStatus: "failed",
      status: "failed",
      isLive: false,
      sequence: 1,
    });
    render(
      <SubagentDisclosure
        subagents={[failedSibling, ...deepBranch]}
        turns={[turn()]}
        now={NOW}
      />,
    );

    const tree = screen.getByRole("list", { name: "Delegated agent tree" });
    expect(tree.children).toHaveLength(6);
    expect(screen.getByText("Failed sibling")).toBeInTheDocument();
    expect(screen.getByText("Deep worker 10")).toBeInTheDocument();
  });

  it("ticks live elapsed text without requiring a parent state update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:10.000Z"));
    try {
      render(
        <SubagentDisclosure
          subagents={[trace()]}
          turns={[turn()]}
        />,
      );
      expect(screen.getByText("10s")).toBeInTheDocument();
      vi.advanceTimersByTime(1_000);
      expect(screen.getByText("11s")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one elapsed clock across live delegated rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:10.000Z"));
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    try {
      const view = render(
        <SubagentDisclosure
          subagents={[
            trace(),
            trace({
              id: "trace-second",
              providerTaskId: "task-second",
              providerAgentId: "agent-second",
              providerName: "Second worker",
            }),
          ]}
          turns={[turn()]}
        />,
      );
      expect(screen.getAllByText("10s")).toHaveLength(2);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      expect(screen.getAllByText("11s")).toHaveLength(2);
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps disclosure relationships instance-scoped across split panes", () => {
    const item = trace({ status: "completed", isLive: false });
    const { container } = render(
      <>
        <SubagentDisclosure subagents={[item]} turns={[turn()]} now={NOW} />
        <SubagentDisclosure subagents={[item]} turns={[turn()]} now={NOW} />
      </>,
    );
    const ids = [...container.querySelectorAll<HTMLElement>("[id]")]
      .map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    const controls = [...container.querySelectorAll<HTMLElement>(
      "[aria-controls]",
    )].map((control) => control.getAttribute("aria-controls"));
    expect(new Set(controls).size).toBe(controls.length);
  });
});
