import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const titleCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/renderer/src/utils/backgroundTasks", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/renderer/src/utils/backgroundTasks")>();
  return {
    ...original,
    backgroundTaskTitle: (...args: Parameters<typeof original.backgroundTaskTitle>) => {
      titleCalls.count += 1;
      return original.backgroundTaskTitle(...args);
    },
  };
});

import {
  BackgroundTasksSurface,
  type BackgroundTasksSurfaceProps,
} from "../../src/renderer/src/components/BackgroundTasksSurface";
import { taskTrace, taskTurn, taskUsage, workspaceRun } from "./background-task-fixtures";

const turns = [taskTurn()];

function surface(overrides: Partial<BackgroundTasksSurfaceProps>): React.JSX.Element {
  return (
    <BackgroundTasksSurface
      runtimeStatus="online"
      subagents={[]}
      turns={turns}
      runs={[]}
      conversationId="conversation-1"
      onOpenSubagent={vi.fn()}
      onStopCommand={vi.fn()}
      onDismissCommand={vi.fn()}
      {...overrides}
    />
  );
}

function toggle(title: string): HTMLElement {
  return screen.getByRole("button", { name: `View transcript for ${title}` });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Background task cards", () => {
  it("re-renders only the card whose trace changed", () => {
    const traces = Array.from({ length: 128 }, (_, index) => taskTrace({
      id: `trace-${String(index).padStart(3, "0")}`,
      providerName: `Task ${index}`,
      usage: taskUsage({ totalTokens: index }),
      sequence: index + 1,
    }));
    const view = render(surface({ subagents: traces }));
    titleCalls.count = 0;
    const next = traces.map((trace, index) => index === 7
      ? { ...trace, usage: taskUsage({ totalTokens: 999 }), sequence: 1_000 }
      : trace);
    view.rerender(surface({ subagents: next }));
    expect(titleCalls.count).toBe(1);
  });

  it("keeps cards in place when telemetry bumps a sequence", () => {
    const first = taskTrace({ id: "a", providerName: "Alpha", sequence: 1 });
    const second = taskTrace({ id: "b", providerName: "Beta", sequence: 2 });
    const order = () => [...document.querySelectorAll<HTMLElement>("[data-focus-row]")]
      .map((item) => item.dataset.focusRow);
    const view = render(surface({ subagents: [first, second] }));
    expect(order()).toEqual(["agent:a", "agent:b"]);
    view.rerender(surface({ subagents: [second, { ...first, sequence: 3 }] }));
    expect(order()).toEqual(["agent:a", "agent:b"]);
  });

  it("ticks elapsed text without re-rendering cards", () => {
    vi.useFakeTimers({ now: Date.parse("2030-01-01T00:01:00.000Z") });
    const traces = Array.from({ length: 16 }, (_, index) => taskTrace({
      id: `trace-${index}`,
      providerName: `Task ${index}`,
    }));
    const view = render(surface({ subagents: traces }));
    const first = view.container.querySelector(".subagent-elapsed")!;
    const before = first.textContent;
    titleCalls.count = 0;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(titleCalls.count).toBe(0);
    expect(first.textContent).not.toBe(before);
  });

  it("moves focus to the Finished row when the focused card settles into it while collapsed", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const other = taskTrace({ id: "b", providerName: "Beta" });
    const view = render(surface({ subagents: [live, other] }));
    toggle("Alpha").focus();
    view.rerender(surface({ subagents: [{ ...live, status: "completed", isLive: false }, other] }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Finished 1/u }));
  });

  it("keeps focus on the same card when it settles into an open Finished list", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const done = taskTrace({ id: "b", providerName: "Beta", status: "completed" });
    const view = render(surface({ subagents: [live, done] }));
    act(() => screen.getByRole("button", { name: /^Finished 1/u }).click());
    toggle("Alpha").focus();
    view.rerender(surface({ subagents: [{ ...live, status: "completed", isLive: false }, done] }));
    expect(document.activeElement).toBe(toggle("Alpha"));
  });

  it("moves focus to the Finished row when a card with an open transcript settles into it while collapsed", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const view = render(surface({ subagents: [live] }));
    act(() => toggle("Alpha").click());
    expect(toggle("Alpha")).toHaveAttribute("aria-expanded", "true");
    toggle("Alpha").focus();
    view.rerender(surface({ subagents: [{ ...live, status: "completed", isLive: false }] }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Finished 1/u }));
    act(() => screen.getByRole("button", { name: /^Finished 1/u }).click());
    expect(toggle("Alpha")).toHaveAttribute("aria-expanded", "true");
  });

  it("moves focus to the card's transcript toggle when its focused Stop disappears", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha", providerTaskId: "task-a" });
    const view = render(surface({
      subagents: [live],
      turns: [taskTurn({ status: "running" })],
      onStopSubagent: vi.fn(async () => undefined),
      canStopSubagent: () => true,
    }));
    screen.getByRole("button", { name: "Stop Alpha" }).focus();
    view.rerender(surface({
      subagents: [live],
      turns: [taskTurn({ status: "running" })],
      onStopSubagent: vi.fn(async () => undefined),
      canStopSubagent: () => false,
    }));
    expect(document.activeElement).toBe(toggle("Alpha"));
  });

  it("moves focus to the Finished row when a focused command's Stop goes with it", () => {
    const run = workspaceRun({ id: "dev", label: "npm run dev" });
    const view = render(surface({ runs: [run] }));
    screen.getByRole("button", { name: "Stop npm run dev" }).focus();
    view.rerender(surface({
      runs: [{ ...run, status: "failed", canStop: false, finishedAt: "2030-01-01T00:00:30.000Z" }],
    }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Finished 1/u }));
  });

  it("keeps keyboard focus in the panel after dismissing finished commands", async () => {
    const user = userEvent.setup();
    const done = workspaceRun({ id: "build", label: "npm run build", status: "succeeded", canStop: false, finishedAt: "2030-01-01T00:00:40.000Z" });
    const finishedAgent = taskTrace({ id: "b", providerName: "Beta", status: "completed" });
    const onDismissCommand = vi.fn();
    const view = render(surface({ subagents: [finishedAgent], runs: [done], onDismissCommand }));
    screen.getByRole("button", { name: "Dismiss finished commands" }).focus();
    await user.keyboard("{Enter}");
    expect(onDismissCommand).toHaveBeenCalledWith(done);
    view.rerender(surface({ subagents: [finishedAgent], runs: [], onDismissCommand }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Finished 1/u }));
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    view.rerender(surface({ subagents: [live], runs: [done], onDismissCommand }));
    screen.getByRole("button", { name: "Dismiss finished commands" }).focus();
    view.rerender(surface({ subagents: [live], runs: [], onDismissCommand }));
    expect(document.activeElement).toBe(toggle("Alpha"));
  });

  it("keeps focus in the panel when Show more finished tasks goes away", () => {
    const finished = Array.from({ length: 21 }, (_, index) => taskTrace({
      id: `done-${String(index).padStart(2, "0")}`,
      providerName: `Done ${index}`,
      status: "completed",
      createdAt: `2030-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    const view = render(surface({ subagents: finished }));
    act(() => screen.getByRole("button", { name: /^Finished 21/u }).click());
    const more = screen.getByRole("button", { name: "Show 1 more finished task" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    more.focus();
    view.rerender(surface({ subagents: finished.slice(1) }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Finished 20/u }));
  });

  it("moves focus to View transcript, never Stop, when the progress Show more goes away", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function scrollHeight(this: HTMLElement) {
      return this.classList.contains("background-task-clamp") && (this.textContent ?? "").length > 100 ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
    const live = taskTrace({ id: "a", providerName: "Alpha", providerTaskId: "task-a", description: "Short task.", progress: "Long progress ".repeat(20) });
    const props = {
      turns: [taskTurn({ status: "running" })],
      onStopSubagent: vi.fn(async () => undefined),
      canStopSubagent: () => true,
    };
    const view = render(surface({ ...props, subagents: [live] }));
    act(() => toggle("Alpha").click());
    screen.getByRole("button", { name: "Show more of the progress for Alpha" }).focus();
    view.rerender(surface({ ...props, subagents: [{ ...live, progress: "Short.", sequence: 2 }] }));
    expect(screen.queryByRole("button", { name: /^Show more/u })).toBeNull();
    view.rerender(surface({ ...props, subagents: [{ ...live, progress: "Short.", toolUseCount: 2, sequence: 3 }] }));
    expect(document.activeElement).toBe(toggle("Alpha"));
  });

  it("forgets the focused card when nothing in the panel can take focus", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const view = render(surface({ subagents: [live] }));
    toggle("Alpha").focus();
    view.rerender(surface({ subagents: [] }));
    expect(document.activeElement).toBe(document.body);
    view.rerender(surface({ subagents: [taskTrace({ id: "b", providerName: "Beta" })] }));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone when the user moved it out of the panel", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const view = render(<>{surface({ subagents: [live] })}<button type="button">Elsewhere</button></>);
    toggle("Alpha").focus();
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    (document.activeElement as HTMLElement).blur();
    view.rerender(<>{surface({ subagents: [{ ...live, status: "completed", isLive: false }] })}<button type="button">Elsewhere</button></>);
    expect(document.activeElement).toBe(document.body);
  });

  it("renders each list once while agents and commands update together", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const run = workspaceRun({ id: "dev", label: "npm run dev" });
    const view = render(surface({ subagents: [live], runs: [run] }));
    view.rerender(surface({
      subagents: [{ ...live, status: "completed", isLive: false, sequence: 2 }],
      runs: [{ ...run, status: "succeeded", canStop: false, finishedAt: "2030-01-01T00:00:40.000Z" }],
    }));
    expect(screen.getAllByRole("button", { name: /^Finished/u })).toHaveLength(1);
    expect(screen.queryByRole("list", { name: "Running" })).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
