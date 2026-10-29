import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SubagentTrace } from "../../src/shared/contracts";
import type { CustomAgent, CustomAgentCallAttribution } from "../../src/shared/custom-agents";
import { SubagentCallBlock, SubagentCallList } from "../../src/renderer/src/components/response-timeline/SubagentCallBlock";
import { SubagentCallContext, type SubagentCallContextValue } from "../../src/renderer/src/components/response-timeline/subagentCallContext";
import { createSubagentCallMemory } from "../../src/renderer/src/components/response-timeline/subagentCallMemory";
import { workspaceSceneCallbacks, type WorkspaceSceneActions } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import {
  customAgentsById,
  partitionSubagentCalls,
  sameSubagentCallsForTurn,
  withSubagentCalls,
  type SubagentCallEntry,
} from "../../src/renderer/src/utils/response-timeline/subagentCalls";
import { taskTrace } from "./background-task-fixtures";
import { formatElapsed } from "../../src/renderer/src/utils/response-timeline/timing";

const AGENT_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

const reviewer: CustomAgent = {
  id: AGENT_ID,
  name: "Code reviewer",
  handle: "code-reviewer",
  description: "Reviews diffs",
  icon: { kind: "symbol", name: "shield" },
  accent: "teal",
  blocks: [],
  skills: [],
  position: 0,
  revision: 3,
  createdAt: "2026-10-29T08:00:00.000Z",
  updatedAt: "2026-10-29T08:00:00.000Z",
};

const attribution: CustomAgentCallAttribution = {
  agentId: AGENT_ID,
  revision: 2,
  handle: "code-reviewer",
  name: "Old reviewer",
  icon: { kind: "symbol", name: "eye" },
  accent: null,
  delivery: "subagent",
};

function call(update: Partial<SubagentTrace> = {}): SubagentTrace {
  return taskTrace({
    id: "call-1",
    customAgentId: AGENT_ID,
    providerName: "inertia-code-reviewer",
    description: "Review the staged diff for regressions.",
    createdAt: "2026-10-29T08:00:05.000Z",
    updatedAt: "2026-10-29T08:00:05.000Z",
    ...update,
  });
}

function context(update: Partial<SubagentCallContextValue> = {}): SubagentCallContextValue {
  return {
    autoCollapse: true,
    projectRoot: "/tmp/project",
    projectId: "project-1",
    conversationId: "conversation-1",
    defaultCodeWrap: false,
    onOpenProjectFile: () => undefined,
    ...update,
  };
}

function entryFor(traces: SubagentTrace[], agents: CustomAgent[] = [reviewer]): SubagentCallEntry {
  return partitionSubagentCalls(traces, customAgentsById(agents), attribution).entries[0]!;
}

function renderBlock(entry: SubagentCallEntry, value: SubagentCallContextValue, onBeforeToggle = vi.fn(), onAfterToggle = vi.fn()) {
  return render(
    <SubagentCallContext.Provider value={value}>
      <SubagentCallBlock entry={entry} onBeforeToggle={onBeforeToggle} onAfterToggle={onAfterToggle} />
    </SubagentCallContext.Provider>,
  );
}

describe("subagent call partition", () => {
  it("keeps plain traces for the agents line and nests children under the called agent", () => {
    const plain = taskTrace({ id: "plain", createdAt: "2026-10-29T08:00:01.000Z" });
    const root = call({ status: "running", isLive: true });
    const child = taskTrace({ id: "child", parentTraceId: "call-1", customAgentId: AGENT_ID, providerName: "helper" });
    const grandchild = taskTrace({ id: "grandchild", parentTraceId: "child", customAgentId: AGENT_ID, providerName: "deep" });
    const traces = [plain, root, child, grandchild];
    const { entries, remaining } = partitionSubagentCalls(traces, customAgentsById([reviewer]), attribution);
    expect(remaining).toEqual([plain]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent.name).toBe("Code reviewer");
    expect(entries[0]!.children.map(({ trace, depth }) => [trace.id, depth])).toEqual([["child", 0], ["grandchild", 1]]);

    const onlyPlain = [plain];
    expect(partitionSubagentCalls(onlyPlain, new Map(), undefined).remaining).toBe(onlyPlain);
  });

  it("places the call in the stream at its creation time", () => {
    const stream = [
      { kind: "commentary", id: "before", createdAt: "2026-10-29T08:00:00.000Z" },
      { kind: "commentary", id: "after", createdAt: "2026-10-29T08:00:09.000Z" },
    ];
    const merged = withSubagentCalls(stream, [call()], customAgentsById([reviewer]), attribution);
    expect(merged.map(({ id }) => id)).toEqual(["before", "subagent-call:call-1", "after"]);
    expect(withSubagentCalls(stream, [], new Map(), undefined)).toBe(stream);
  });

  it("repaints a turn only when its traces change identity", () => {
    const traces = [call()];
    const agents = [reviewer];
    expect(sameSubagentCallsForTurn(traces, traces, agents, agents)).toBe(true);
    expect(sameSubagentCallsForTurn(traces, [...traces], agents, agents)).toBe(false);
    expect(sameSubagentCallsForTurn([], undefined, [reviewer], [])).toBe(true);
    expect(sameSubagentCallsForTurn(traces, traces, [reviewer], [{ ...reviewer, name: "Renamed" }])).toBe(false);
    const plain = [taskTrace()];
    expect(sameSubagentCallsForTurn(plain, plain, [reviewer], [])).toBe(true);
    const working = taskTrace({ id: "working", status: "running", isLive: true });
    expect(sameSubagentCallsForTurn([working], [{ ...working, activity: "Editing", sequence: 9 }], [reviewer], [reviewer])).toBe(true);
    expect(sameSubagentCallsForTurn([working], [{ ...working, status: "completed", isLive: false }], [reviewer], [reviewer])).toBe(false);
  });

  it("keeps the stop and custom agent settings callbacks stable across scene rebuilds", async () => {
    const stopSubagent = vi.fn(async () => {
      throw new Error("Already stopped.");
    });
    const openSettings = vi.fn();
    const actions = { stopSubagent, openSettings } as unknown as WorkspaceSceneActions;
    const setActionError = vi.fn();
    const first = workspaceSceneCallbacks(actions, setActionError);
    const second = workspaceSceneCallbacks(actions, setActionError);
    expect(second.stopSubagent).toBe(first.stopSubagent);
    expect(second.openCustomAgentSettings).toBe(first.openCustomAgentSettings);
    second.openCustomAgentSettings();
    expect(openSettings).toHaveBeenCalledWith({ section: "custom-agents" });
    await expect(second.stopSubagent(call())).rejects.toThrow("Already stopped.");
    expect(setActionError).toHaveBeenCalledWith("Already stopped.");
    expect(workspaceSceneCallbacks(actions, vi.fn()).stopSubagent).not.toBe(first.stopSubagent);
  });
});

describe("SubagentCallBlock", () => {
  it("renders a live header with the avatar, status, rail state and activity", () => {
    const entry = entryFor([call({ status: "running", isLive: true, activity: "Reading activity.tsx", model: "sonnet" })]);
    const { container } = renderBlock(entry, context());
    const block = screen.getByRole("region", { name: "Called agent Code reviewer" });
    expect(block).toHaveAttribute("data-live", "true");
    expect(block.querySelector('.custom-agent-avatar[data-live="true"]')).not.toBeNull();
    const header = within(block).getByRole("button", { name: /Code reviewer/u });
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).toHaveTextContent("Running");
    const body = container.querySelector(`#${CSS.escape(header.getAttribute("aria-controls")!)}`)!;
    expect(body).not.toHaveAttribute("inert");
    expect(body).toHaveTextContent("Review the staged diff for regressions.");
    expect(body).toHaveTextContent("Reading activity.tsx");
    expect(body).toHaveTextContent("sonnet");
  });

  it("collapses on completion when work logs auto-collapse and stays open otherwise", () => {
    const live = entryFor([call({ status: "running", isLive: true })]);
    const done = entryFor([call({ status: "completed", isLive: false, result: "No regressions found.\nDetails follow.", toolUseCount: 4, durationMs: 12_000 })]);
    const view = renderBlock(live, context({ autoCollapse: true }));
    view.rerender(
      <SubagentCallContext.Provider value={context({ autoCollapse: true })}>
        <SubagentCallBlock entry={done} />
      </SubagentCallContext.Provider>,
    );
    const header = screen.getByRole("button", { name: /Code reviewer/u });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("No regressions found.")).toHaveClass("subagent-call-line");
    view.unmount();

    const kept = renderBlock(live, context({ autoCollapse: false }));
    kept.rerender(
      <SubagentCallContext.Provider value={context({ autoCollapse: false })}>
        <SubagentCallBlock entry={done} />
      </SubagentCallContext.Provider>,
    );
    expect(screen.getByRole("button", { name: /Code reviewer/u })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/4 tool uses/u)).toBeInTheDocument();
  });

  it("toggles through the anchored scroll callbacks and folds the body inert", () => {
    const onBeforeToggle = vi.fn();
    const onAfterToggle = vi.fn();
    const rafs: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafs.push(callback);
      return rafs.length;
    });
    const entry = entryFor([call({ status: "completed", isLive: false, result: "Done." })]);
    const { container } = renderBlock(entry, context({ autoCollapse: true }), onBeforeToggle, onAfterToggle);
    const header = screen.getByRole("button", { name: /Code reviewer/u });
    expect(header).toHaveAttribute("aria-expanded", "false");
    const body = container.querySelector(`#${CSS.escape(header.getAttribute("aria-controls")!)}`)!;
    expect(body).toHaveAttribute("inert");
    fireEvent.click(header);
    expect(onBeforeToggle).toHaveBeenCalledTimes(1);
    rafs.forEach((callback) => callback(0));
    expect(onAfterToggle).toHaveBeenCalledTimes(1);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(body).not.toHaveAttribute("inert");
    vi.restoreAllMocks();
  });

  it("falls back to the frozen message attribution when the agent was deleted", () => {
    const entry = entryFor([call({ status: "failed", isLive: false })], []);
    expect(entry.agent).toMatchObject({ name: "Old reviewer", handle: "code-reviewer" });
    const { container } = renderBlock(entry, context());
    expect(screen.getByRole("region", { name: "Called agent Old reviewer" })).toBeInTheDocument();
    expect(container.querySelector(".subagent-call-line")).toHaveTextContent("Failed");
    expect(container.querySelector(".subagent-call-line")).toHaveAttribute("data-tone", "danger");
  });

  it("shows stopped calls muted and offers Stop only while the trace can be stopped", () => {
    const stopped = entryFor([call({ status: "cancelled", isLive: false })]);
    const first = renderBlock(stopped, context());
    expect(first.container.querySelector(".subagent-call-line")).toHaveTextContent("Stopped");
    expect(first.container.querySelector(".subagent-call-line")).toHaveAttribute("data-tone", "muted");
    first.unmount();

    const onStopSubagent = vi.fn(async () => undefined);
    const trace = call({ status: "running", isLive: true });
    renderBlock({ ...entryFor([trace]), canStop: true }, context({ onStopSubagent }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Code reviewer" }));
    expect(onStopSubagent).toHaveBeenCalledWith(trace);
  });

  it("lists nested agents started by the called agent", () => {
    const root = call({ status: "running", isLive: true });
    const child = taskTrace({ id: "child", parentTraceId: "call-1", customAgentId: AGENT_ID, providerName: "test runner", status: "completed", isLive: false });
    render(
      <SubagentCallContext.Provider value={context()}>
        <SubagentCallList entries={partitionSubagentCalls([root, child], customAgentsById([reviewer]), attribution).entries} />
      </SubagentCallContext.Provider>,
    );
    const list = screen.getByRole("list", { name: "Agents started by Code reviewer" });
    expect(within(list).getByRole("listitem")).toHaveTextContent("Test runner");
    expect(within(list).getByRole("listitem")).toHaveTextContent("Completed");
  });

  it("keeps a call's open state across the settle remount and plays the entrance once", () => {
    const memory = createSubagentCallMemory();
    const value = context({ autoCollapse: true, memory });
    const live = render(
      <SubagentCallContext.Provider value={value}>
        <SubagentCallList entries={[entryFor([call({ id: "settle-failed", status: "running", isLive: true })])]} />
      </SubagentCallContext.Provider>,
    );
    expect(live.container.querySelector(".subagent-call")).toHaveClass("is-entering");
    live.unmount();
    const settled = render(
      <SubagentCallContext.Provider value={value}>
        <SubagentCallList entries={[entryFor([call({ id: "settle-failed", status: "failed", isLive: false })])]} />
      </SubagentCallContext.Provider>,
    );
    expect(screen.getByRole("button", { name: /Code reviewer/u })).toHaveAttribute("aria-expanded", "true");
    expect(settled.container.querySelector(".subagent-call")).not.toHaveClass("is-entering");
    settled.unmount();

    const done = entryFor([call({ id: "hand-opened", status: "completed", isLive: false, result: "Done." })]);
    const first = renderBlock(done, value);
    fireEvent.click(screen.getByRole("button", { name: /Code reviewer/u }));
    expect(screen.getByRole("button", { name: /Code reviewer/u })).toHaveAttribute("aria-expanded", "true");
    first.unmount();
    const again = renderBlock(done, value);
    expect(screen.getByRole("button", { name: /Code reviewer/u })).toHaveAttribute("aria-expanded", "true");
    expect(again.container.querySelector(".subagent-call")).not.toHaveClass("is-entering");
    again.unmount();

    renderBlock(entryFor([call({ id: "settle-done", status: "running", isLive: true })]), value).unmount();
    renderBlock(entryFor([call({ id: "settle-done", status: "completed", isLive: false, result: "Done." })]), value);
    expect(screen.getByRole("button", { name: /Code reviewer/u })).toHaveAttribute("aria-expanded", "false");
  });

  it("follows a later change to the auto-collapse setting", () => {
    const entry = entryFor([call({ status: "completed", isLive: false, result: "Done." })]);
    const view = renderBlock(entry, context({ autoCollapse: true }));
    const header = screen.getByRole("button", { name: /Code reviewer/u });
    expect(header).toHaveAttribute("aria-expanded", "false");
    view.rerender(
      <SubagentCallContext.Provider value={context({ autoCollapse: false })}>
        <SubagentCallBlock entry={entry} />
      </SubagentCallContext.Provider>,
    );
    expect(header).toHaveAttribute("aria-expanded", "true");
    view.rerender(
      <SubagentCallContext.Provider value={context({ autoCollapse: true })}>
        <SubagentCallBlock entry={entry} />
      </SubagentCallContext.Provider>,
    );
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("names the stop button by its visible state and shows the measured duration in the header", async () => {
    let finish: () => void = () => undefined;
    const onStopSubagent = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const trace = call({ status: "running", isLive: true });
    const view = renderBlock({ ...entryFor([trace]), canStop: true }, context({ onStopSubagent }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Code reviewer" }));
    const stopping = screen.getByRole("button", { name: "Stopping Code reviewer" });
    expect(stopping).toHaveTextContent("Stopping");
    finish();
    await screen.findByRole("button", { name: "Stop Code reviewer" });
    view.unmount();

    renderBlock(entryFor([call({
      status: "completed",
      isLive: false,
      createdAt: "2026-10-29T08:00:00.000Z",
      updatedAt: "2026-10-29T08:05:00.000Z",
      durationMs: 12_000,
    })]), context({ autoCollapse: false }));
    const header = screen.getByRole("button", { name: /Code reviewer/u });
    expect(header.querySelector(".subagent-elapsed")).toHaveTextContent(formatElapsed(12_000));
  });
});
