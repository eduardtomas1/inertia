import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ObservedChildView } from "../../src/renderer/src/components/orchestration/observed-child-view";
import { DelegationSurfaceProvider } from "../../src/renderer/src/components/orchestration/delegation-surface";
import type { DelegationCommandRunner } from "../../src/renderer/src/components/orchestration/delegation-model";
import { TurnAgentsLine } from "../../src/renderer/src/components/response-timeline/TurnAgentsLine";
import { SubagentTraceDetails } from "../../src/renderer/src/components/SubagentTraceDetails";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import {
  OBSERVED_CHILD_READ_ONLY_REASON,
  observedChildReadResultSchema,
  type ObservedChildControlSet,
  type ObservedChildThread,
} from "../../src/shared/observed-child-thread";
import { taskTrace } from "./background-task-fixtures";
import { resultEvent } from "./delegation-fixtures";

const conversationId = "50505050-5050-4050-8050-505050505050";
const turnId = "turn-2";
const quiet = { reportError: false };
const unsupported = (code: string, reason: string) => ({ supported: false as const, code, reason });

function controls(stop: ObservedChildControlSet["stop"]): ObservedChildControlSet {
  return {
    stop,
    send: { supported: false, code: "read-only", reason: OBSERVED_CHILD_READ_ONLY_REASON },
    transcript: unsupported("transcript-unavailable", "Native transcripts are not stored."),
    pin: unsupported("not-a-conversation", "Observed agents are not chats."),
    snooze: unsupported("not-a-conversation", "Observed agents are not chats."),
    archive: unsupported("not-a-conversation", "Observed agents are not chats."),
    settle: unsupported("not-a-conversation", "Observed agents are not chats."),
    manage: unsupported("not-a-delegated-task", "Observed agents are not delegated tasks."),
    wake: unsupported("not-a-delegated-task", "Observed agents are not delegated tasks."),
  } as ObservedChildControlSet;
}

const STOPPABLE = controls({ supported: true, code: null, reason: null });
const UNSTOPPABLE = controls(unsupported("provider-unsupported", "Codex agents cannot be stopped individually.") as never);

function child(id: string, overrides: Partial<ObservedChildThread> = {}): ObservedChildThread {
  return {
    id, authority: "observed", transcript: "unavailable",
    parent: { conversationId, runId: "run-2", turnId, parentTraceId: null },
    depth: 1, lineage: "complete", providerId: "claude",
    nativeRef: { taskId: `task-${id}`, agentId: null, toolUseId: null, strongest: "task" },
    role: null, name: "Evidence scout", description: "Inspect the provider lifecycle.", model: "fixture-model",
    status: "running", providerStatus: "in_progress", isLive: true,
    progress: "Reading the event store.", result: null,
    truncated: { description: false, progress: false, result: false },
    usage: { totalTokens: 12_400, inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null,
      reasoningOutputTokens: null, contextTokens: null, maxContextTokens: null },
    toolUseCount: 3, durationMs: 4_000, controls: STOPPABLE,
    createdAt: "2026-10-31T10:00:00.000Z", updatedAt: "2026-10-31T10:00:01.000Z",
    ...overrides,
  };
}

const root = child("trace-root");
const nested = child("trace-nested", {
  parent: { conversationId, runId: "run-2", turnId, parentTraceId: "trace-root" }, depth: 2, providerId: "codex",
  name: "Fixture writer", model: null, status: "completed", providerStatus: null, isLive: false, progress: null,
  result: "Wrote four fixtures.", usage: null, toolUseCount: null, controls: UNSTOPPABLE,
  nativeRef: { taskId: null, agentId: "agent-nested", toolUseId: null, strongest: "agent" },
});

function readResult(children = [root, nested]) {
  return resultEvent(observedChildReadResultSchema.parse({ kind: "observed-child.read", conversationId, turnId, children,
    controls: Object.fromEntries(children.map((entry) => [entry.id, entry.controls])), omitted: 0, truncated: false }));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("observed child view", () => {
  it("shows a read-only lineage view with Stop only where the provider supports it", async () => {
    const run = vi.fn<DelegationCommandRunner>().mockResolvedValue(readResult());
    render(<ObservedChildView conversationId={conversationId} turnId={turnId} turnLabel="Turn 2" run={run} />);
    const scout = await screen.findByRole("article", { name: "Evidence scout" });
    const writer = screen.getByRole("article", { name: "Fixture writer" });
    expect(run).toHaveBeenCalledWith(`observed-child.read:${conversationId}:${turnId}`,
      { type: "observed-child.read", payload: { conversationId, turnId } }, quiet);
    for (const view of [scout, writer]) expect(view).toHaveTextContent("Provider-managed · read-only");
    expect(within(within(writer).getByRole("list", { name: "Agent lineage" })).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["This chat", "Turn 2", "Evidence scout", "Fixture writer"]);
    expect(within(writer).getByText("Fixture writer", { selector: "li" })).toHaveAttribute("aria-current", "location");
    expect(scout).toHaveTextContent("Provider statusin_progress");
    expect(scout).toHaveTextContent("Modelfixture-model");
    expect(scout).toHaveTextContent("Usage12,400 tokens · 3 tool uses");
    expect(scout).toHaveTextContent("ProgressReading the event store.");
    expect(writer).toHaveTextContent("ResultWrote four fixtures.");
    expect(within(scout).getByRole("button", { name: "Stop Evidence scout" })).toBeTruthy();
    expect(within(writer).queryByRole("button", { name: /Stop/u })).toBeNull();
    expect(writer).toHaveTextContent("Stop unavailable: Codex agents cannot be stopped individually.");
  });

  it("stops through the existing subagent stop command and rereads, with refusals shown inline", async () => {
    const run = vi.fn<DelegationCommandRunner>().mockResolvedValue(readResult());
    render(<ObservedChildView conversationId={conversationId} turnId={turnId} run={run} />);
    const user = userEvent.setup();
    await screen.findByRole("article", { name: "Evidence scout" });
    run.mockResolvedValueOnce(resultEvent({ kind: "agent.subagent.stop" }));
    await user.click(screen.getByRole("button", { name: "Stop Evidence scout" }));
    expect(run).toHaveBeenCalledWith("agent.subagent.stop:trace-root",
      { type: "agent.subagent.stop", payload: { conversationId, traceId: "trace-root" } }, quiet);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    run.mockRejectedValueOnce(new RuntimeCommandError("The agent already finished.", "rejected"));
    await user.click(await screen.findByRole("button", { name: "Stop Evidence scout" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The agent already finished.");
  });

  it("rereads after a refused stop so the server's current reason replaces Stop", async () => {
    const run = vi.fn<DelegationCommandRunner>().mockResolvedValue(readResult());
    render(<ObservedChildView conversationId={conversationId} turnId={turnId} run={run} />);
    const user = userEvent.setup();
    const scout = await screen.findByRole("article", { name: "Evidence scout" });
    const finished = child("trace-root", { status: "completed", isLive: false,
      controls: controls(unsupported("not-live", "This agent has already finished.") as never) });
    run.mockRejectedValueOnce(new RuntimeCommandError("That delegated Claude task is no longer live or cannot be stopped.", "rejected"))
      .mockResolvedValueOnce(readResult([finished, nested]));
    await user.click(within(scout).getByRole("button", { name: "Stop Evidence scout" }));
    expect(await within(scout).findByText("Stop unavailable: This agent has already finished.")).toBeTruthy();
    expect(within(scout).queryByRole("button", { name: /Stop/u })).toBeNull();
    expect(within(scout).getByRole("alert")).toHaveTextContent("That delegated Claude task is no longer live or cannot be stopped.");
    expect(run.mock.calls.map(([key]) => key)).toEqual([`observed-child.read:${conversationId}:${turnId}`,
      "agent.subagent.stop:trace-root", `observed-child.read:${conversationId}:${turnId}`]);
  });

  it("opens from the turn agents line by keyboard and reaches Stop with Tab", async () => {
    const run = vi.fn<DelegationCommandRunner>().mockResolvedValue(readResult());
    render(<DelegationSurfaceProvider conversationId={conversationId} delegation={undefined}
      conversations={undefined} run={run} openConversation={undefined}>
      <TurnAgentsLine conversationId={conversationId} turnId={turnId} turnIndex={2}
        subagents={[taskTrace({ id: "a", conversationId, turnId })]} onOpenSurface={() => undefined} />
    </DelegationSurfaceProvider>);
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Agent details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Hide agent details" })).toHaveAttribute("aria-expanded", "true");
    const view = await screen.findByRole("region", { name: "Provider-managed agents" });
    await within(view).findByRole("article", { name: "Evidence scout" });
    expect(within(view).getAllByText("Turn 2")).toHaveLength(2);
    await user.tab();
    expect(within(view).getByRole("button", { name: "Stop Evidence scout" })).toHaveFocus();
  });

  it("keeps the turn agents line unchanged without a command runner", () => {
    render(<TurnAgentsLine conversationId={conversationId} turnId={turnId} subagents={[taskTrace({ id: "a" })]} />);
    expect(screen.queryByRole("button", { name: "Agent details" })).toBeNull();
  });

  it("opens a single agent's provider view from its trace details", async () => {
    const run = vi.fn<DelegationCommandRunner>().mockResolvedValue(readResult());
    const trace = taskTrace({ id: "trace-nested", conversationId, turnId });
    render(<SubagentTraceDetails id="details" trace={trace} traces={[trace]} turns={[]} run={run} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Provider view" }));
    const view = await screen.findByRole("article", { name: "Fixture writer" });
    expect(screen.queryByRole("article", { name: "Evidence scout" })).toBeNull();
    expect(view).toHaveTextContent("Provider-managed · read-only");
    expect(view).toHaveTextContent("Stop unavailable: Codex agents cannot be stopped individually.");
  });
});
