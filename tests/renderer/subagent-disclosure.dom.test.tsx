import { render, screen, within } from "@testing-library/react";
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
      "4 delegated tasks · 4 active",
    ).closest("details");
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Claude · Agent SDK · Running · 10s")).toHaveAttribute(
      "title",
      "Exact provider state: running",
    );
    expect(screen.getByText("Claude · Agent SDK · Waiting (paused) · 10s")).toHaveAttribute(
      "title",
      "Exact provider state: paused",
    );
    expect(screen.getByText("Codex · App Server · Queued (pendingInit) · 10s")).toHaveAttribute(
      "title",
      "Exact provider state: pendingInit",
    );
    expect(screen.getByText("Claude · Agent SDK · Unknown (futureState) · 10s"))
      .toHaveAttribute("title", "Exact provider state: futureState");
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
    await user.click(within(childRow).getByRole("button", {
      name: "Guide parent",
    }));
    expect(onFollowUp).toHaveBeenCalledWith(child);
    await user.click(within(childRow).getByRole("button", {
      name: "Details",
    }));
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

    const summary = screen.getByText("1 delegated task").closest("summary");
    const disclosure = summary?.closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    summary?.focus();
    await user.keyboard("{Enter}");
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByText("Codex · App Server · Completed · 7s"))
      .toBeInTheDocument();
    expect(screen.getByText("All checks passed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop /u }))
      .not.toBeInTheDocument();
  });
});
