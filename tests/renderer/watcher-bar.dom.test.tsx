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
  options: {
    privateConnectConfigured?: boolean;
    resumeBlocked?: string | null;
    usageTokens?: number | null;
    onError?: (message: string | null) => void;
  } = {},
) {
  return (
    <WatcherBar
      link={current}
      watched={shell(WATCHED_ID, "Refactor parser")}
      watcher={current.status === "waking" ? runningWatcher() : shell(WATCHER_ID, "Watcher")}
      agentLabel="Team Codex · fixture-model"
      headingId="watcher-heading"
      closed={false}
      actions={createWatcherActions(runtime.request, current.id)}
      privateConnectConfigured={options.privateConnectConfigured ?? false}
      resumeBlocked={options.resumeBlocked ?? null}
      usageTokens={options.usageTokens ?? null}
      onCollapse={vi.fn()}
      onOpenWatcherChat={vi.fn()}
      onResumeRequest={onResumeRequest}
      onError={options.onError ?? vi.fn()}
    />
  );
}

const liveRegion = () => document.querySelector<HTMLElement>('.watcher-bar [role="status"]')!;

beforeEach(() => resetWatcherLiveStore());
afterEach(() => {
  vi.useRealTimers();
  resetWatcherLiveStore();
});

describe("watcher bar", () => {
  it("names the watched chat and keeps the live region separate from the visible status", () => {
    render(bar(link()));
    const heading = screen.getByRole("heading", { name: "Watching Refactor parser" });
    expect(heading).toHaveAttribute("id", "watcher-heading");
    expect(heading).toHaveAttribute("title", "Refactor parser");
    expect(heading.querySelector(".visually-hidden")).toHaveTextContent("Watching");
    expect(screen.getByRole("group", { name: "Watcher for Refactor parser: Team Codex · fixture-model, Reviewer" })).toBeInTheDocument();
    expect(document.querySelector(".watcher-bar-state")).toHaveTextContent(/^Team Codex · fixture-model · Reviewer · Watching$/u);
    expect(screen.queryByText(/checks left this turn/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Watching · /u)).not.toBeInTheDocument();
    expect(liveRegion()).toHaveAttribute("aria-live", "polite");
    expect(liveRegion()).toHaveClass("visually-hidden");
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it("keeps one primary text action beside the title, with the rest and the numbers in More", async () => {
    render(bar(link({ quietSince: "2026-10-19T10:50:00.000Z" }), undefined, undefined, { privateConnectConfigured: true, usageTokens: 48_200 }));
    const actions = document.querySelector<HTMLElement>(".watcher-bar-actions")!;
    const [primary, more] = within(actions).getAllByRole("button");
    expect(primary).toHaveTextContent(/^Check now$/u);
    expect(primary).toHaveAccessibleName("Check now");
    expect(more).toHaveAccessibleName("More watcher actions");
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    const menu = await screen.findByRole("menu", { name: "More watcher actions" });
    expect([...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent)).toEqual([
      "Pause",
      "Review the last turn",
      "Open watcher chat",
      "Send findings automatically",
      "Hide from paired devices",
      "Collapse",
      "Stop watching…",
      "27 of 30 checks left this turn",
      "2 events waiting",
      expect.stringMatching(/^Last check /u),
      expect.stringMatching(/^Main chat quiet since /u),
      "Used 48.2K tokens",
    ]);
    expect(within(menu).getByRole("menuitem", { name: "2 events waiting" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Used 48.2K tokens" })).toHaveAttribute("aria-disabled", "true");
  });

  it("asks for a review of the last turn from the More menu", async () => {
    const runtime = watcherRuntime();
    render(bar(link(), runtime));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Review the last turn" }));
    await vi.waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.review"]));
    expect(payloadOf(runtime.commands[0])).toEqual({ linkId: LINK_ID });
    expect(screen.getByRole("button", { name: "More watcher actions" })).toHaveFocus();
  });

  it.each([
    ["paused", link({ status: "paused", pauseReason: "user" })],
    ["mid-check", link({ status: "waking" })],
  ])("offers no review of the last turn while %s", async (_case, current) => {
    const runtime = watcherRuntime({ link: () => current });
    render(bar(current, runtime));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    const item = await screen.findByRole("menuitem", { name: "Review the last turn" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    await act(async () => { await Promise.resolve(); });
    expect(runtime.commands).toEqual([]);
  });

  it("reports the runtime's refusal of a review in the dock's error line", async () => {
    const refusal = "The watched chat has no turn to review yet.";
    const runtime = watcherRuntime();
    const request = vi.fn(async (command: Parameters<typeof runtime.request>[0]) => {
      if (command.type === "watcher.review") throw new Error(refusal);
      return runtime.request(command);
    });
    const onError = vi.fn();
    render(bar(link(), { ...runtime, request }, undefined, { onError }));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Review the last turn" }));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(refusal));
  });

  it("shows no usage line until the watcher's token use is known", async () => {
    render(bar(link(), undefined, undefined, { usageTokens: null }));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    const menu = await screen.findByRole("menu", { name: "More watcher actions" });
    expect(menu).not.toHaveTextContent(/tokens/u);
  });

  it("turns automatic sending on and off from the More menu and says so in the bar", async () => {
    const runtime = watcherRuntime();
    const view = render(bar(link(), runtime));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    const off = await screen.findByRole("menuitemcheckbox", { name: "Send findings automatically" });
    expect(off).toHaveAttribute("aria-checked", "false");
    fireEvent.click(off);
    await vi.waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.update"]));
    expect(payloadOf(runtime.commands[0])).toEqual({ linkId: LINK_ID, delivery: "auto" });
    expect(screen.getByRole("button", { name: "More watcher actions" })).toHaveFocus();
    await act(async () => { await Promise.resolve(); });

    view.rerender(bar(link({ delivery: "auto" }), runtime));
    expect(document.querySelector(".watcher-bar-state")).toHaveTextContent(/ · Reviewer · Sends findings automatically$/u);
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    const on = await screen.findByRole("menuitemcheckbox", { name: "Send findings automatically" });
    expect(on).toHaveAttribute("aria-checked", "true");
    fireEvent.click(on);
    await vi.waitFor(() => expect(runtime.commands).toHaveLength(2));
    expect(payloadOf(runtime.commands[1])).toEqual({ linkId: LINK_ID, delivery: "manual" });
    view.rerender(bar(link({ delivery: "auto", status: "paused", pauseReason: "user" }), runtime));
    expect(document.querySelector(".watcher-bar-state")).toHaveTextContent(/ · Paused$/u);
  });

  it("collapses from the More menu", async () => {
    const onCollapse = vi.fn();
    render(
      <WatcherBar
        link={link()}
        watched={shell(WATCHED_ID, "Refactor parser")}
        watcher={shell(WATCHER_ID, "Watcher")}
        agentLabel="Team Codex"
        headingId="watcher-heading"
        closed={false}
        actions={createWatcherActions(watcherRuntime().request, LINK_ID)}
        privateConnectConfigured={false}
        resumeBlocked={null}
        usageTokens={null}
        onCollapse={onCollapse}
        onOpenWatcherChat={null}
        onResumeRequest={vi.fn()}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse" }));
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("drops the checks-left count while paused for using its checks", async () => {
    render(bar(link({ status: "paused", pauseReason: "wake-budget" })));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    const menu = await screen.findByRole("menu", { name: "More watcher actions" });
    expect(menu).not.toHaveTextContent(/checks left/u);
    expect(document.querySelector(".watcher-bar-state")).toHaveTextContent(/ · Paused$/u);
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
    expect(liveRegion()).toHaveTextContent("Paused. It used its checks for this turn. It still makes the final check, and resumes when the next turn starts or when you choose Resume.");
  });

  it("announces the runtime's own words for a pause it explains", () => {
    const detail = "The watcher used its checks for this turn. It still makes the final check, and resumes when the next turn starts or when you choose Resume.";
    const view = render(bar(link()));
    view.rerender(bar(link({ status: "paused", pauseReason: "wake-budget", pauseDetail: detail })));
    expect(liveRegion()).toHaveTextContent(`Paused. ${detail}`);
  });

  it("announces a second finding and a repeated failure again", () => {
    const view = render(bar(link()));
    const finding = (at: string) => link({ latest: { outcome: "finding", at, text: "A risk" }, latestFindingAt: at });
    const failed = (at: string) => link({ latest: { outcome: "failed", at, text: "" }, latestFindingAt: "2026-10-19T10:50:00.000Z" });
    const announced = [
      finding("2026-10-19T10:44:00.000Z"),
      { ...finding("2026-10-19T10:44:00.000Z"), status: "waking" as const },
      finding("2026-10-19T10:50:00.000Z"),
      failed("2026-10-19T10:51:00.000Z"),
      failed("2026-10-19T10:52:00.000Z"),
    ].map((next) => {
      view.rerender(bar(next));
      return liveRegion().textContent;
    });
    expect(announced[0]).toMatch(/^New finding\.?$/u);
    expect(announced[1]).toBe(announced[0]);
    expect(announced[2]).toMatch(/^New finding\.?$/u);
    expect(announced[2]).not.toBe(announced[1]);
    expect(announced[3]).toMatch(/^The check failed\.?$/u);
    expect(announced[4]).toMatch(/^The check failed\.?$/u);
    expect(announced[4]).not.toBe(announced[3]);
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
    expect(document.querySelector(".watcher-bar-state")).toHaveAttribute("data-phase", "waking");
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
    view.rerender(bar(link()));
    act(() => clearWatcherLive(LINK_ID));
    expect(screen.queryByText("Writing its review")).not.toBeInTheDocument();
    view.rerender(bar(link({ status: "waking" })));
    expect(document.querySelector(".watcher-bar-phase-text")).toHaveTextContent(/^Checking…$/u);
  });

  it("dispatches Pause and Check now, and routes Resume through the dock", async () => {
    const runtime = watcherRuntime();
    const onResumeRequest = vi.fn();
    const view = render(bar(link(), runtime, onResumeRequest));
    fireEvent.click(screen.getByRole("button", { name: "More watcher actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "More watcher actions" })).toHaveFocus();
    await vi.waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.pause"]));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await vi.waitFor(() => expect(runtime.commands.map(({ type }) => type)).toEqual(["watcher.pause", "watcher.wake"]));
    expect(runtime.commands.every((command) => payloadOf(command).linkId === LINK_ID)).toBe(true);
    view.rerender(bar(link({ status: "paused", pauseReason: "user" }), runtime, onResumeRequest));
    expect(screen.queryByRole("button", { name: "Check now" })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Resume" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResumeRequest).toHaveBeenCalledOnce();
    view.rerender(bar(link({ status: "paused", pauseReason: "write-detected" }), runtime, onResumeRequest));
    fireEvent.click(screen.getByRole("button", { name: "Resume…" }));
    expect(onResumeRequest).toHaveBeenCalledTimes(2);
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
        closed={false}
        actions={createWatcherActions(request, current.id)}
        privateConnectConfigured={false}
        resumeBlocked={null}
        usageTokens={null}
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
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(screen.getByRole("button", { name: "Check now" })).toHaveAttribute("aria-disabled", "true");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Check now" })).not.toHaveAttribute("aria-disabled"));
  });

  it("does not offer Resume when the runtime would refuse it, and says why", () => {
    const onResumeRequest = vi.fn();
    render(bar(
      link({ status: "paused", pauseReason: "watched-archived" }),
      undefined,
      onResumeRequest,
      { resumeBlocked: "Unarchive the main chat to resume its watcher." },
    ));
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(resume).toHaveAccessibleDescription("Unarchive the main chat to resume its watcher.");
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
