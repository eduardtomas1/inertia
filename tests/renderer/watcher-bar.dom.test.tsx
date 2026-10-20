import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationLatestTurnSummary, ConversationShell } from "../../src/shared/contracts";
import type { WatcherLinkView } from "../../src/shared/watcher";
import { WatcherBar } from "../../src/renderer/src/components/watcher/WatcherBar";
import { createWatcherActions } from "../../src/renderer/src/hooks/useWatcherActions";
import { publishWatcherLive, resetWatcherLiveStore } from "../../src/renderer/src/utils/watcherLiveStore";
import { LINK_ID, WATCHED_ID, WATCHER_ID, link, payloadOf, shell, watcherRuntime } from "./watcher-fixtures";

const STARTED = "2026-10-19T10:42:00.000Z";

function runningWatcher(): ConversationShell {
  const base = shell(WATCHER_ID, "Watcher · Reviewer · Refactor parser");
  const latestTurn = {
    id: "watcher-turn-4",
    runId: "run-4",
    status: "running",
    providerId: base.providerId,
    harnessId: base.modelSelection.harnessId,
    backendProfileId: base.modelSelection.backendProfileId,
    modelSelection: base.modelSelection,
    continuationIdentity: { harnessId: base.modelSelection.harnessId, backendProfileId: base.modelSelection.backendProfileId, backendConfigurationRevision: 1, modelIdentity: "fixture-model", endpointIdentity: null },
    model: "fixture-model",
    reasoningEffort: "",
    requestedAt: STARTED,
    startedAt: STARTED,
    completedAt: null,
    terminalReason: null,
    updatedAt: STARTED,
  } as ConversationLatestTurnSummary;
  return { ...base, status: "running", latestTurn };
}

function bar(current: WatcherLinkView, runtime = watcherRuntime({ link: () => current }), onResumeRequest = vi.fn()) {
  return (
    <WatcherBar
      link={current}
      watched={shell(WATCHED_ID, "Refactor parser")}
      watcher={current.status === "waking" ? runningWatcher() : shell(WATCHER_ID, "Watcher")}
      agentLabel="Team Codex fixture-model"
      headingId="watcher-heading"
      actions={createWatcherActions(runtime.request, current.id)}
      privateConnectConfigured={false}
      onCollapse={vi.fn()}
      onOpenWatcherChat={vi.fn()}
      onResumeRequest={onResumeRequest}
      onError={vi.fn()}
    />
  );
}

const liveRegion = () => document.querySelector<HTMLElement>('.watcher-bar [role="status"]')!;

beforeEach(() => resetWatcherLiveStore());
afterEach(() => {
  vi.useRealTimers();
  resetWatcherLiveStore();
});

describe("WatcherBar", () => {
  it("names the watched chat and keeps the live region separate from the visible status", () => {
    render(bar(link()));
    expect(screen.getByRole("heading", { name: "Watching Refactor parser" })).toHaveAttribute("id", "watcher-heading");
    expect(screen.getByRole("group", { name: "Watcher for Refactor parser: Team Codex fixture-model, Reviewer" })).toBeInTheDocument();
    expect(screen.getByText("Checks 3 / 12")).toBeInTheDocument();
    expect(screen.getByText("9 seen")).toBeInTheDocument();
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    expect(liveRegion()).toHaveAttribute("aria-live", "polite");
    expect(liveRegion()).toHaveClass("visually-hidden");
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it("announces transitions only: checking, nothing to report, a finding and a pause", () => {
    const view = render(bar(link()));
    view.rerender(bar(link({ status: "waking" })));
    expect(liveRegion()).toHaveTextContent("Watcher checking");
    view.rerender(bar(link({ status: "waking", counters: { ...link().counters, eventsSeen: 12 } })));
    expect(liveRegion()).toHaveTextContent(/^Watcher checking$/u);
    view.rerender(bar(link({ latest: { outcome: "silent", at: "2026-10-19T10:43:00.000Z", text: "" } })));
    expect(liveRegion()).toHaveTextContent(/^Nothing to report$/u);
    view.rerender(bar(link({ latest: { outcome: "finding", at: "2026-10-19T10:44:00.000Z", text: "A risk" } })));
    expect(liveRegion()).toHaveTextContent(/^New finding$/u);
    view.rerender(bar(link({
      status: "paused",
      pauseReason: "wake-budget",
      latest: { outcome: "finding", at: "2026-10-19T10:44:00.000Z", text: "A risk" },
    })));
    expect(liveRegion()).toHaveTextContent("Paused: It used its checks for this turn.");
  });

  it("ticks the elapsed time outside React render and outside the live region", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:42:05.000Z"));
    let commits = 0;
    render(
      <Profiler id="watcher-bar" onRender={() => { commits += 1; }}>
        {bar(link({ status: "waking" }))}
      </Profiler>,
    );
    const elapsed = document.querySelector<HTMLElement>(".watcher-bar-elapsed")!;
    expect(elapsed).toHaveAttribute("aria-hidden", "true");
    expect(elapsed).toHaveTextContent("5s");
    const announced = liveRegion().textContent;
    const committed = commits;
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(elapsed).toHaveTextContent("8s");
    expect(commits).toBe(committed);
    expect(liveRegion().textContent).toBe(announced);
  });

  it("shows the live phase of the running check from the live store", () => {
    render(bar(link({ status: "waking" })));
    act(() => publishWatcherLive({
      type: "watcher.live",
      linkId: LINK_ID,
      watcherConversationId: WATCHER_ID,
      turnId: "watcher-turn-4",
      phase: "reading",
      label: "Reading src/parser.ts",
      at: STARTED,
    }));
    expect(screen.getByText("Reading src/parser.ts")).toBeInTheDocument();
    expect(document.querySelector(".watcher-bar-phase")).toHaveAttribute("data-phase", "waking");
  });

  it("dispatches Pause and Check now, and routes Resume through the dock", async () => {
    const runtime = watcherRuntime();
    const onResumeRequest = vi.fn();
    const view = render(bar(link(), runtime, onResumeRequest));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await vi.waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.pause"]));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await vi.waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.pause", "watcher.wake"]));
    expect(runtime.commands.every((command) => payloadOf(command).linkId === LINK_ID)).toBe(true);
    view.rerender(bar(link({ status: "paused", pauseReason: "user" }), runtime, onResumeRequest));
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResumeRequest).toHaveBeenCalledOnce();
  });

  it("asks before Stop watching and detaches only after confirmation", async () => {
    const runtime = watcherRuntime();
    render(bar(link(), runtime));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop watching…" }));
    const confirm = screen.getByRole("group", { name: "Stop watching" });
    expect(confirm).toHaveTextContent("the watcher becomes an ordinary chat");
    expect(screen.getByRole("button", { name: "Keep watching" })).toHaveFocus();
    expect(runtime.commands).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    await vi.waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.detach"]));
  });
});
