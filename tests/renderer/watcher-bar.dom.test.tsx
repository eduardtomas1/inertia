import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationLatestTurnSummary, ConversationShell } from "../../src/shared/contracts";
import type { WatcherLinkView } from "../../src/shared/watcher";
import { WatcherBar } from "../../src/renderer/src/components/watcher/WatcherBar";
import { createWatcherActions } from "../../src/renderer/src/hooks/useWatcherActions";
import { clearWatcherLive, publishWatcherLive, resetWatcherLiveStore } from "../../src/renderer/src/utils/watcherLiveStore";
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

function bar(
  current: WatcherLinkView,
  runtime = watcherRuntime({ link: () => current }),
  onResumeRequest = vi.fn(),
  options: { privateConnectConfigured?: boolean; resumeBlocked?: string | null } = {},
) {
  return (
    <WatcherBar
      link={current}
      watched={shell(WATCHED_ID, "Refactor parser")}
      watcher={current.status === "waking" ? runningWatcher() : shell(WATCHER_ID, "Watcher")}
      agentLabel="Team Codex · fixture-model"
      headingId="watcher-heading"
      actions={createWatcherActions(runtime.request, current.id)}
      privateConnectConfigured={options.privateConnectConfigured ?? false}
      resumeBlocked={options.resumeBlocked ?? null}
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
    const heading = screen.getByRole("heading", { name: "Watching Refactor parser" });
    expect(heading).toHaveAttribute("id", "watcher-heading");
    expect(heading).toHaveAttribute("title", "Refactor parser");
    expect(heading.querySelector(".visually-hidden")).toHaveTextContent("Watching");
    expect(screen.getByRole("group", { name: "Watcher for Refactor parser: Team Codex · fixture-model, Reviewer" })).toBeInTheDocument();
    expect(screen.getByText("Watching · Team Codex · fixture-model · Reviewer")).toBeInTheDocument();
    expect(screen.getByText(/^Last check /u)).toBeInTheDocument();
    expect(screen.getByText("9 of 12 checks left this turn")).toBeInTheDocument();
    expect(screen.getByText("9 events seen")).toBeInTheDocument();
    expect(screen.getByText("2 waiting")).toBeInTheDocument();
    expect(liveRegion()).toHaveAttribute("aria-live", "polite");
    expect(liveRegion()).toHaveClass("visually-hidden");
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it("keeps only More and Collapse beside the title, and orders the More menu", async () => {
    render(bar(link(), undefined, undefined, { privateConnectConfigured: true }));
    const identity = document.querySelector<HTMLElement>(".watcher-bar-identity")!;
    expect(within(identity).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["More watcher actions", "Collapse"]);
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    const menu = await screen.findByRole("menu", { name: "More watcher actions" });
    expect([...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent))
      .toEqual(["Open watcher chat", "Hide from paired devices", "Stop watching…"]);
  });

  it("announces findings, failures and pauses only, never routine checks", () => {
    const view = render(bar(link()));
    view.rerender(bar(link({ status: "waking" })));
    expect(liveRegion()).toBeEmptyDOMElement();
    view.rerender(bar(link({ latest: { outcome: "silent", at: "2026-10-19T10:43:00.000Z", text: "" } })));
    expect(liveRegion()).toBeEmptyDOMElement();
    view.rerender(bar(link({
      latest: { outcome: "finding", at: "2026-10-19T10:44:00.000Z", text: "A risk" },
      latestFindingAt: "2026-10-19T10:44:00.000Z",
    })));
    expect(liveRegion()).toHaveTextContent(/^New finding$/u);
    view.rerender(bar(link({
      latest: { outcome: "failed", at: "2026-10-19T10:45:00.000Z", text: "" },
      latestFindingAt: "2026-10-19T10:44:00.000Z",
    })));
    expect(liveRegion()).toHaveTextContent(/^The check failed\.$/u);
    view.rerender(bar(link({
      status: "paused",
      pauseReason: "wake-budget",
      latest: { outcome: "failed", at: "2026-10-19T10:45:00.000Z", text: "" },
      latestFindingAt: "2026-10-19T10:44:00.000Z",
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

  it("never shows the previous check's phase when the next check starts", () => {
    const view = render(bar(link({ status: "waking" })));
    act(() => publishWatcherLive({
      type: "watcher.live",
      linkId: LINK_ID,
      watcherConversationId: WATCHER_ID,
      turnId: "watcher-turn-4",
      phase: "writing",
      label: null,
      at: STARTED,
    }));
    expect(screen.getByText("Writing its review")).toBeInTheDocument();
    // The check settles: the shell's link update drops its phase.
    view.rerender(bar(link()));
    act(() => clearWatcherLive(LINK_ID));
    expect(screen.queryByText("Writing its review")).not.toBeInTheDocument();
    // The next check starts before its turn reaches the shell.
    view.rerender(bar(link({ status: "waking" })));
    expect(document.querySelector(".watcher-bar-phase-text")).toHaveTextContent(/^Checking$/u);
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
    expect(screen.getByRole("button", { name: "Check now" })).toHaveAttribute("aria-disabled", "true");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResumeRequest).toHaveBeenCalledOnce();
  });

  it("keeps focus on a pending action: aria-disabled, never disabled", async () => {
    let release: () => void = () => undefined;
    const current = link();
    const runtime = watcherRuntime({ link: () => current });
    const request = vi.fn(async (command: Parameters<typeof runtime.request>[0]) => {
      if (command.type === "watcher.wake") await new Promise<void>((resolve) => { release = resolve; });
      return runtime.request(command);
    });
    render(
      <WatcherBar
        link={current}
        watched={shell(WATCHED_ID, "Refactor parser")}
        watcher={shell(WATCHER_ID, "Watcher")}
        agentLabel="Team Codex"
        headingId="watcher-heading"
        actions={createWatcherActions(request, current.id)}
        privateConnectConfigured={false}
        resumeBlocked={null}
        onCollapse={vi.fn()}
        onOpenWatcherChat={null}
        onResumeRequest={vi.fn()}
        onError={vi.fn()}
      />,
    );
    const check = screen.getByRole("button", { name: "Check now" });
    check.focus();
    fireEvent.click(check);
    expect(check).toHaveAttribute("aria-disabled", "true");
    expect(check).not.toBeDisabled();
    expect(check).toHaveFocus();
    fireEvent.click(check);
    expect(request.mock.calls.filter(([command]) => command.type === "watcher.wake")).toHaveLength(1);
    await act(async () => { release(); await Promise.resolve(); });
    await vi.waitFor(() => expect(check).not.toHaveAttribute("aria-disabled"));
    expect(check).toHaveFocus();
  });

  it("re-enables its actions after they settle under StrictMode", async () => {
    const runtime = watcherRuntime();
    render(<StrictMode>{bar(link(), runtime)}</StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-disabled", "true");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Pause" })).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByRole("button", { name: "Check now" })).not.toHaveAttribute("aria-disabled");
  });

  it("does not offer Resume when the runtime would refuse it, and says why", () => {
    const onResumeRequest = vi.fn();
    render(bar(
      link({ status: "paused", pauseReason: "watched-archived" }),
      undefined,
      onResumeRequest,
      { resumeBlocked: "Unarchive the watched chat to resume its watcher." },
    ));
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(resume).toHaveAttribute("title", "Unarchive the watched chat to resume its watcher.");
    fireEvent.click(resume);
    expect(onResumeRequest).not.toHaveBeenCalled();
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
