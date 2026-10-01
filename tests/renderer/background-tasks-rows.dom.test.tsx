import { act, render, screen } from "@testing-library/react";
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
const conversation = { id: "conversation-1", modelSelection: { harnessId: "claude-agent-sdk" } };

function surface(overrides: Partial<BackgroundTasksSurfaceProps>): React.JSX.Element {
  return (
    <BackgroundTasksSurface
      runtimeStatus="online"
      subagents={[]}
      turns={turns}
      runs={[]}
      conversation={conversation}
      onStopCommand={vi.fn()}
      onDismissCommand={vi.fn()}
      {...overrides}
    />
  );
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
});

describe("Background task rows", () => {
  it("re-renders only the row whose trace changed", () => {
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

  it("ticks elapsed text without re-rendering rows", () => {
    vi.useFakeTimers({ now: Date.parse("2030-01-01T00:01:00.000Z") });
    const traces = Array.from({ length: 16 }, (_, index) => taskTrace({
      id: `trace-${index}`,
      providerName: `Task ${index}`,
      sequence: index + 1,
    }));
    const view = render(surface({ subagents: traces }));
    const first = view.container.querySelector(".subagent-elapsed")!;
    const before = first.textContent;
    titleCalls.count = 0;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(titleCalls.count).toBe(0);
    expect(first.textContent).not.toBe(before);
  });

  it("keeps focus on a task's control when the task moves from Active to Finished", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const other = taskTrace({ id: "b", providerName: "Beta" });
    const view = render(surface({ subagents: [live, other] }));
    screen.getByRole("button", { name: "Details for Alpha" }).focus();
    view.rerender(surface({
      subagents: [{ ...live, status: "completed", isLive: false, sequence: 5 }, other],
    }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Details for Alpha" }));
  });

  it("moves focus to the row's next control when the focused Stop disappears", () => {
    const run = workspaceRun({ id: "dev", label: "npm run dev" });
    const view = render(surface({ runs: [run] }));
    screen.getByRole("button", { name: "Stop npm run dev" }).focus();
    view.rerender(surface({
      runs: [{ ...run, status: "failed", canStop: false, finishedAt: "2030-01-01T00:00:30.000Z" }],
    }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss npm run dev" }));
  });

  it("moves focus to the section heading when the focused task's row is gone", () => {
    const run = workspaceRun({ id: "dev", label: "npm run dev" });
    const kept = workspaceRun({ id: "lint", label: "npm run lint", status: "succeeded", finishedAt: "2030-01-01T00:00:40.000Z" });
    const view = render(surface({ runs: [run, kept] }));
    screen.getByRole("button", { name: "Stop npm run dev" }).focus();
    view.rerender(surface({ runs: [kept] }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Commands" }));
  });

  it("leaves focus alone when the user moved it out of the panel", () => {
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const view = render(<>{surface({ subagents: [live] })}<button type="button">Elsewhere</button></>);
    screen.getByRole("button", { name: "Details for Alpha" }).focus();
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    (document.activeElement as HTMLElement).blur();
    view.rerender(<>{surface({ subagents: [{ ...live, status: "completed", isLive: false }] })}<button type="button">Elsewhere</button></>);
    expect(document.activeElement).toBe(document.body);
  });

  it("renders each section once while agents and commands update together", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const live = taskTrace({ id: "a", providerName: "Alpha" });
    const run = workspaceRun({ id: "dev", label: "npm run dev" });
    const view = render(surface({ subagents: [live], runs: [run] }));
    view.rerender(surface({
      subagents: [{ ...live, status: "completed", isLive: false, sequence: 2 }],
      runs: [{ ...run, status: "succeeded", canStop: false, finishedAt: "2030-01-01T00:00:40.000Z" }],
    }));
    expect(screen.getAllByRole("heading", { name: "Agents" })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Commands" })).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("compacts finished commands beyond five like finished agents", () => {
    const runs = Array.from({ length: 8 }, (_, index) => workspaceRun({
      id: `done-${index}`,
      label: `Check ${index}`,
      status: "succeeded",
      startedAt: `2030-01-01T00:00:0${index}.000Z`,
      finishedAt: "2030-01-01T00:00:30.000Z",
    }));
    render(surface({ runs: [workspaceRun({ id: "live", label: "npm run dev" }), ...runs] }));
    const list = screen.getByRole("list", { name: "Commands" });
    expect(list.querySelectorAll("li")).toHaveLength(6);
    const toggle = screen.getByRole("button", { name: "Show 3 more finished commands" });
    expect(toggle).toHaveAttribute("aria-controls", list.id);
    act(() => toggle.click());
    expect(list.querySelectorAll("li")).toHaveLength(9);
    expect(screen.getByText("1 active · 8 finished")).toBeVisible();
  });
});
