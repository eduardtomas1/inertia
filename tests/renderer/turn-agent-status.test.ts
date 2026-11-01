import { describe, expect, it } from "vitest";

import { subagentNeedsReview } from "../../src/renderer/src/utils/subagentDisclosure";
import {
  sameSubagentPanelTraces,
  sameTurnAgentTraces,
  subagentCountLabel,
  subagentGroupFoldable,
  subagentGroupSettledDone,
  subagentGroupElapsedMs,
  subagentGroupSpan,
  subagentRowDetail,
  subagentRowName,
  subagentStatusWord,
  subagentTone,
  turnAgentStatus,
  turnAgentStatusParts,
  turnAgentStatusText,
} from "../../src/renderer/src/utils/turnAgentStatus";
import { taskTrace } from "./background-task-fixtures";

describe("turn agent status", () => {
  it("is absent for a turn without delegated agents", () => {
    expect(turnAgentStatus([])).toBeNull();
  });

  it("counts working, waiting, queued, done, stopped, failed and review agents apart", () => {
    expect(turnAgentStatus([
      taskTrace({ id: "a" }),
      taskTrace({ id: "b", status: "waiting" }),
      taskTrace({ id: "q", status: "queued" }),
      taskTrace({ id: "c", status: "completed" }),
      taskTrace({ id: "d", status: "failed" }),
    ])).toEqual({ live: 1, waiting: 1, queued: 1, total: 5, done: 1, stopped: 0, failed: 1, review: 0 });
    expect(turnAgentStatus([
      taskTrace({ id: "a", status: "completed" }),
      taskTrace({ id: "b", status: "failed" }),
      taskTrace({ id: "c", status: "interrupted" }),
      taskTrace({ id: "d", status: "lost", isLive: false }),
      taskTrace({ id: "e", status: "cancelled" }),
      taskTrace({ id: "f", status: "unknown", isLive: false }),
    ])).toEqual({ live: 0, waiting: 0, queued: 0, total: 6, done: 1, stopped: 1, failed: 3, review: 1 });
  });

  it("treats authoritative liveness as working whatever the status says, except waiting and queued", () => {
    expect(subagentTone(taskTrace({ status: "unknown", isLive: true }))).toBe("working");
    expect(subagentTone(taskTrace({ status: "waiting", isLive: true }))).toBe("waiting");
    expect(subagentTone(taskTrace({ status: "queued", isLive: true }))).toBe("queued");
    expect(subagentTone(taskTrace({ status: "running", isLive: false }))).toBe("done");
    expect(subagentTone(taskTrace({ status: "lost", isLive: false }))).toBe("failed");
    expect(subagentTone(taskTrace({ status: "unknown", isLive: false }))).toBe("review");
    expect(subagentTone(taskTrace({ status: "cancelled" }))).toBe("stopped");
  });

  it("keeps an unknown outcome out of the fold with failures, as Background tasks marks it for review", () => {
    const unknown = taskTrace({ status: "unknown", isLive: false });
    expect(subagentNeedsReview(unknown)).toBe(true);
    expect(subagentGroupFoldable(turnAgentStatus([unknown]))).toBe(false);
    expect(subagentGroupFoldable(turnAgentStatus([taskTrace({ status: "failed" })]))).toBe(false);
    expect(subagentGroupFoldable(turnAgentStatus([taskTrace({ status: "completed" })]))).toBe(true);
    expect(subagentGroupFoldable(turnAgentStatus([taskTrace({ status: "waiting" })]))).toBe(true);
    expect(subagentGroupFoldable(turnAgentStatus([taskTrace({ status: "running" })]))).toBe(false);
    expect(subagentGroupFoldable(null)).toBe(false);
  });

  it("dims a group only when every agent is done", () => {
    const done = taskTrace({ id: "done", status: "completed" });
    expect(subagentGroupSettledDone(turnAgentStatus([done, { ...done, id: "done-2" }])!)).toBe(true);
    for (const other of [
      taskTrace({ id: "o", status: "failed" }),
      taskTrace({ id: "o", status: "cancelled" }),
      taskTrace({ id: "o", status: "unknown", isLive: false }),
      taskTrace({ id: "o", status: "waiting" }),
      taskTrace({ id: "o", status: "queued" }),
      taskTrace({ id: "o", status: "running" }),
    ]) {
      expect(subagentGroupSettledDone(turnAgentStatus([done, other])!), other.status).toBe(false);
    }
  });

  it("says the group size and its states in words, skipping empty states", () => {
    expect(subagentCountLabel(1)).toBe("1 subagent");
    expect(subagentCountLabel(3)).toBe("3 subagents");
    const empty = { live: 0, waiting: 0, queued: 0, total: 0, done: 0, stopped: 0, failed: 0, review: 0 };
    const status = { ...empty, live: 1, total: 4, done: 2, failed: 1 };
    expect(turnAgentStatusParts(status)).toEqual([
      { tone: "working", text: "1 working" },
      { tone: "done", text: "2 done" },
      { tone: "failed", text: "1 failed" },
    ]);
    expect(turnAgentStatusText(status)).toBe("1 working · 2 done · 1 failed");
    expect(turnAgentStatusText({ ...empty, total: 3, done: 3 })).toBe("3 done");
    expect(turnAgentStatusText({ ...empty, live: 2, total: 3, stopped: 1 })).toBe("2 working · 1 stopped");
    expect(turnAgentStatusText({ ...empty, live: 1, waiting: 1, queued: 2, total: 4 }))
      .toBe("1 working · 1 waiting · 2 queued");
    expect(turnAgentStatusText({ ...empty, done: 1, review: 1, total: 2 })).toBe("1 done · 1 needs review");
    expect(turnAgentStatusText({ ...empty, review: 2, total: 2 })).toBe("2 need review");
    expect(turnAgentStatusParts({ ...empty, review: 1, total: 1 }))
      .toEqual([{ tone: "review", text: "1 needs review" }]);
  });

  it("names each agent's state with a word", () => {
    expect(subagentStatusWord(taskTrace({ status: "running" }))).toBe("Working");
    expect(subagentStatusWord(taskTrace({ status: "spawned" }))).toBe("Working");
    expect(subagentStatusWord(taskTrace({ status: "waiting" }))).toBe("Waiting");
    expect(subagentStatusWord(taskTrace({ status: "queued" }))).toBe("Queued");
    expect(subagentStatusWord(taskTrace({ status: "completed" }))).toBe("Done");
    expect(subagentStatusWord(taskTrace({ status: "cancelled" }))).toBe("Stopped");
    expect(subagentStatusWord(taskTrace({ status: "failed" }))).toBe("Failed");
    expect(subagentStatusWord(taskTrace({ status: "lost", isLive: false }))).toBe("Lost");
    expect(subagentStatusWord(taskTrace({ status: "unknown", isLive: false }))).toBe("Needs review");
    expect(subagentStatusWord(taskTrace({ status: "running", isLive: false }))).toBe("Finished");
  });

  it("names a row by provider name, then humanised role, then Agent", () => {
    expect(subagentRowName(taskTrace({ providerName: "Sidebar" }))).toBe("Sidebar");
    expect(subagentRowName(taskTrace({ providerName: null, providerRole: "general_purpose" }))).toBe("General purpose");
    expect(subagentRowName(taskTrace({ providerName: null, providerRole: null }))).toBe("Agent");
  });

  it("shows progress while working, then the result, then the task, on one line", () => {
    const base = { description: "Inspect the sidebar.", progress: "Reading rows", result: "Rows are virtualised." };
    expect(subagentRowDetail({ ...base, isLive: true })).toBe("Reading rows");
    expect(subagentRowDetail({ ...base, isLive: true, progress: "  " })).toBe("Rows are virtualised.");
    expect(subagentRowDetail({ ...base, isLive: false })).toBe("Rows are virtualised.");
    expect(subagentRowDetail({ ...base, isLive: false, result: null })).toBe("Inspect the sidebar.");
    expect(subagentRowDetail({ isLive: false, description: null, progress: null, result: null })).toBeNull();
    expect(subagentRowDetail({ ...base, isLive: false, result: "Confirmed.\n\n**Rendering:**\tdone" }))
      .toBe("Confirmed. **Rendering:** done");
  });

  it("middle-truncates long paths and bounds the line", () => {
    const path = "apps/web/src/components/sidebar/AppSidebarLayout.tsx";
    const detail = subagentRowDetail({ isLive: false, description: null, progress: null, result: `Read ${path} first` })!;
    expect(detail).toMatch(/^Read apps\/web\/src\/co.*….*SidebarLayout\.tsx first$/u);
    expect(Array.from(detail.split(" ")[1]!)).toHaveLength(40);
    expect(subagentRowDetail({ isLive: false, description: null, progress: null, result: "short/path.ts" }))
      .toBe("short/path.ts");
    const long = subagentRowDetail({ isLive: false, description: null, progress: null, result: "word ".repeat(200) })!;
    expect(Array.from(long)).toHaveLength(280);
    expect(long.endsWith("…")).toBe(true);
  });

  it("spans the group from the first start to the last end, or stays open while any agent works", () => {
    const first = taskTrace({ id: "a", status: "completed", createdAt: "2030-01-01T00:00:00.000Z", durationMs: 20_000 });
    const last = taskTrace({ id: "b", status: "failed", createdAt: "2030-01-01T00:00:10.000Z", updatedAt: "2030-01-01T00:01:00.000Z" });
    const span = subagentGroupSpan([last, first])!;
    expect(span).toEqual({ startedAt: Date.parse(first.createdAt), endedAt: Date.parse(last.updatedAt) });
    expect(subagentGroupElapsedMs(span, Number.MAX_SAFE_INTEGER)).toBe(60_000);
    const live = subagentGroupSpan([first, taskTrace({ id: "c", createdAt: "2030-01-01T00:00:05.000Z" })])!;
    expect(live.endedAt).toBeNull();
    expect(subagentGroupElapsedMs(live, Date.parse("2030-01-01T00:02:00.000Z"))).toBe(120_000);
  });

  it("leaves waiting and queued agents out of the live span, so the timer stops once only they remain", () => {
    const done = taskTrace({ id: "done", status: "completed", createdAt: "2030-01-01T00:00:00.000Z", durationMs: 20_000 });
    const waiting = taskTrace({ id: "waiting", status: "waiting", createdAt: "2030-01-01T00:00:05.000Z", updatedAt: "2030-01-01T00:00:40.000Z" });
    const queued = taskTrace({ id: "queued", status: "queued", createdAt: "2030-01-01T00:00:10.000Z", updatedAt: "2030-01-01T00:00:10.000Z" });
    expect(subagentGroupSpan([done, waiting, queued])).toEqual({
      startedAt: Date.parse(done.createdAt),
      endedAt: Date.parse(waiting.updatedAt),
    });
    const working = taskTrace({ id: "live", createdAt: "2030-01-01T00:00:15.000Z" });
    expect(subagentGroupSpan([done, waiting, working])?.endedAt).toBeNull();
  });

  it("leaves a lost agent's downtime out of the group span", () => {
    const lost = taskTrace({ id: "lost", status: "lost", isLive: false, updatedAt: "2030-01-04T00:00:00.000Z" });
    expect(subagentGroupSpan([lost])).toBeNull();
    const done = taskTrace({ id: "done", status: "completed", durationMs: 4_000 });
    expect(subagentGroupSpan([lost, done])).toEqual({
      startedAt: Date.parse(done.createdAt),
      endedAt: Date.parse(done.createdAt) + 4_000,
    });
    expect(subagentGroupSpan([taskTrace({ createdAt: "not a date" })])).toBeNull();
  });

  it("re-renders a turn only when something the collapsed row shows has changed", () => {
    const traces = [taskTrace({ id: "a" }), taskTrace({ id: "b", status: "completed" })];
    expect(sameTurnAgentTraces(traces, traces)).toBe(true);
    expect(sameTurnAgentTraces(undefined, [])).toBe(true);
    expect(sameTurnAgentTraces(traces, [{ ...traces[0]!, sequence: 9, usage: null, updatedAt: "2030-01-01T00:05:00.000Z" }, traces[1]!])).toBe(true);
    expect(sameTurnAgentTraces(traces, [{ ...traces[0]!, progress: "Reading", activity: "Read" }, traces[1]!])).toBe(true);
    expect(sameTurnAgentTraces(traces, [traces[0]!, { ...traces[1]!, result: "Done.", providerName: "Renamed" }])).toBe(true);
    expect(sameTurnAgentTraces(traces, [{ ...traces[0]!, status: "waiting" }, traces[1]!])).toBe(false);
    expect(sameTurnAgentTraces(traces, [{ ...traces[0]!, isLive: false }, traces[1]!])).toBe(false);
    expect(sameTurnAgentTraces(traces, [{ ...traces[0]!, providerId: "codex" }, traces[1]!])).toBe(false);
    expect(sameTurnAgentTraces(traces, [traces[0]!, { ...traces[1]!, updatedAt: "2030-01-01T00:05:00.000Z" }])).toBe(false);
    expect(sameTurnAgentTraces(traces, [traces[0]!, { ...traces[1]!, durationMs: 9_000 }])).toBe(false);
    expect(sameTurnAgentTraces(traces, traces.slice(0, 1))).toBe(false);
  });

  it("re-renders the open panel when a row's name, line or result changes", () => {
    const traces = [taskTrace({ id: "a" }), taskTrace({ id: "b", status: "completed" })];
    expect(sameSubagentPanelTraces(traces, [{ ...traces[0]!, sequence: 9, usage: null }, traces[1]!])).toBe(true);
    expect(sameSubagentPanelTraces(traces, [{ ...traces[0]!, progress: "Reading" }, traces[1]!])).toBe(false);
    expect(sameSubagentPanelTraces(traces, [traces[0]!, { ...traces[1]!, result: "Done." }])).toBe(false);
    expect(sameSubagentPanelTraces(traces, [traces[0]!, { ...traces[1]!, providerName: "Renamed" }])).toBe(false);
    expect(sameSubagentPanelTraces(traces, [{ ...traces[0]!, description: "New task" }, traces[1]!])).toBe(false);
  });
});
