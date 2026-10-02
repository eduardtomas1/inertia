import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackgroundTasksSurface } from "../../src/renderer/src/components/BackgroundTasksSurface";
import { TurnAgentsLine } from "../../src/renderer/src/components/response-timeline/TurnAgentsLine";
import { takeBackgroundTaskReveal } from "../../src/renderer/src/utils/backgroundTaskReveal";
import { taskTrace, taskTurn } from "./background-task-fixtures";

const working = [
  taskTrace({ id: "a" }),
  taskTrace({ id: "b", status: "waiting" }),
  taskTrace({ id: "c", status: "completed" }),
];

const settled = [
  taskTrace({ id: "a", status: "completed" }),
  taskTrace({ id: "b", status: "completed" }),
  taskTrace({ id: "c", status: "completed" }),
  taskTrace({ id: "d", status: "failed" }),
];

const line = { conversationId: "conversation-1", turnId: "turn-1" };

async function frames(count: number): Promise<void> {
  await act(async () => {
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}

function manualFrames(): { flush: () => void } {
  const queued = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    next += 1;
    queued.set(next, callback);
    return next;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    queued.delete(id);
  });
  return {
    flush: () => {
      const callbacks = [...queued.values()];
      queued.clear();
      act(() => {
        for (const callback of callbacks) callback(performance.now());
      });
    },
  };
}

function addAgentsTab(): HTMLButtonElement {
  const tab = document.createElement("button");
  tab.dataset.workspaceTab = "agents";
  tab.textContent = "Background tasks";
  document.body.append(tab);
  return tab;
}

afterEach(() => {
  takeBackgroundTaskReveal("conversation-1");
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("turn agents line", () => {
  it("renders nothing for a turn without agents", () => {
    const view = render(<TurnAgentsLine {...line} subagents={[]} onOpenSurface={vi.fn()} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("is one quiet button that says how many agents are working, with the shared thinking sweep", () => {
    render(<TurnAgentsLine {...line} subagents={working} onOpenSurface={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Open Background tasks, 2 agents working" });
    expect(button).toHaveTextContent(/^2 agents working$/u);
    expect(screen.getByText("2 agents working")).toHaveClass("background-task-live");
    expect(button.querySelector("svg, button, a")).toBeNull();
    expect(button.parentElement?.closest("button, a")).toBeNull();
  });

  it("keeps a failed sibling visible while other agents work, sweeping only the working count", () => {
    render(<TurnAgentsLine {...line} subagents={[...working, taskTrace({ id: "d", status: "failed" })]} onOpenSurface={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Open Background tasks, 2 agents working · 1 failed" });
    expect(button).toHaveTextContent(/^2 agents working · 1 failed$/u);
    expect(screen.getByText("2 agents working")).toHaveClass("background-task-live");
    expect(screen.getByText("1 failed")).toHaveClass("turn-agents-danger");
    expect(screen.getByText("1 failed")).not.toHaveClass("background-task-live");
    expect(button.querySelectorAll(".background-task-live")).toHaveLength(1);
  });

  it("sweeps only while an agent is running, like the panel's cards", () => {
    const view = render(<TurnAgentsLine {...line} subagents={[taskTrace({ id: "a", status: "waiting" }), taskTrace({ id: "b", status: "queued" })]} onOpenSurface={vi.fn()} />);
    expect(screen.getByText("2 agents working")).not.toHaveClass("background-task-live");
    view.rerender(<TurnAgentsLine {...line} subagents={[taskTrace({ id: "a", status: "waiting" }), taskTrace({ id: "b", status: "spawned" })]} onOpenSurface={vi.fn()} />);
    expect(screen.getByText("2 agents working")).toHaveClass("background-task-live");
  });

  it("says how many agents finished and names failures in words, without animation", () => {
    render(<TurnAgentsLine {...line} subagents={settled} onOpenSurface={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Open Background tasks, 4 agents finished · 1 failed" });
    expect(button).toHaveTextContent(/^4 agents finished · 1 failed$/u);
    expect(screen.getByText("1 failed")).toHaveClass("turn-agents-danger");
    expect(button.querySelector(".background-task-live")).toBeNull();
    const single = render(<TurnAgentsLine {...line} subagents={[taskTrace({ status: "completed" })]} onOpenSurface={vi.fn()} />);
    expect(single.container).toHaveTextContent(/^1 agent finished$/u);
  });

  it("opens the Background tasks surface and moves focus to its tab", async () => {
    const user = userEvent.setup();
    const onOpenSurface = vi.fn(() => {
      addAgentsTab();
    });
    render(<TurnAgentsLine {...line} subagents={working} onOpenSurface={onOpenSurface} />);
    await user.click(screen.getByRole("button", { name: /^Open Background tasks/u }));
    expect(onOpenSurface).toHaveBeenCalledWith("agents");
    await frames(2);
    expect(document.activeElement).toBe(document.querySelector('[data-workspace-tab="agents"]'));
  });

  it("waits for the panel's tab to appear before focusing it", () => {
    const frames = manualFrames();
    render(<TurnAgentsLine {...line} subagents={working} onOpenSurface={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open Background tasks/u }));
    frames.flush();
    const tab = addAgentsTab();
    frames.flush();
    expect(document.activeElement).toBe(tab);
  });

  it("leaves focus where the person moved it while the panel was still opening", () => {
    const frames = manualFrames();
    const elsewhere = document.createElement("input");
    elsewhere.setAttribute("aria-label", "Elsewhere");
    document.body.append(elsewhere);
    render(<TurnAgentsLine {...line} subagents={working} onOpenSurface={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Open Background tasks/u }));
    frames.flush();
    act(() => elsewhere.focus());
    const tab = addAgentsTab();
    frames.flush();
    frames.flush();
    expect(document.activeElement).toBe(elsewhere);
    expect(document.activeElement).not.toBe(tab);
  });

  it("opens from the keyboard", async () => {
    const user = userEvent.setup();
    const onOpenSurface = vi.fn();
    render(<TurnAgentsLine {...line} subagents={working} onOpenSurface={onOpenSurface} />);
    screen.getByRole("button").focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onOpenSurface).toHaveBeenCalledTimes(2);
  });

  it("is plain status text when nothing can open the panel", () => {
    render(<TurnAgentsLine {...line} subagents={[...working, taskTrace({ id: "d", status: "failed" })]} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("2 agents working")).toHaveClass("background-task-live");
    expect(screen.getByText("1 failed")).toHaveClass("turn-agents-danger");
  });

  it("shows a settled turn's cards in the panel it opens", async () => {
    const user = userEvent.setup();
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    const earlier = taskTurn({ id: "turn-0", status: "completed" });
    const current = taskTurn({ id: "turn-1", status: "completed" });
    const traces = [
      taskTrace({ id: "other", turnId: "turn-0", providerName: "Earlier helper", status: "completed" }),
      taskTrace({ id: "done", providerName: "Contract reader", status: "completed" }),
      taskTrace({ id: "broken", providerName: "Migration verifier", status: "failed" }),
    ];
    render(
      <>
        <TurnAgentsLine {...line} subagents={traces.slice(1)} onOpenSurface={vi.fn()} />
        <BackgroundTasksSurface
          runtimeStatus="online"
          subagents={traces}
          turns={[earlier, current]}
          runs={[]}
          conversationId="conversation-1"
          now={Date.parse("2030-01-01T00:01:00.000Z")}
        />
      </>,
    );
    const finished = screen.getByRole("button", { name: /^Finished 3/u });
    expect(finished).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Contract reader")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open Background tasks, 2 agents finished · 1 failed" }));

    expect(finished).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Contract reader")).toBeVisible();
    expect(screen.getByText("Migration verifier")).toBeVisible();
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toHaveTextContent(/Contract reader/u);
    expect(scrolled[0]).not.toHaveTextContent(/Earlier helper/u);
  });

  it("reveals a request made before the panel was mounted, once", async () => {
    const user = userEvent.setup();
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const traces = [taskTrace({ id: "done", providerName: "Contract reader", status: "completed" })];
    render(<TurnAgentsLine {...line} subagents={traces} onOpenSurface={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Open Background tasks, 1 agent finished" }));
    const props = {
      runtimeStatus: "online" as const,
      subagents: traces,
      turns: [taskTurn({ status: "completed" })],
      runs: [],
      conversationId: "conversation-1",
      now: Date.parse("2030-01-01T00:01:00.000Z"),
    };
    const first = render(<BackgroundTasksSurface {...props} />);
    expect(screen.getByText("Contract reader")).toBeVisible();
    expect(scrolled).toHaveBeenCalledOnce();
    first.unmount();
    render(<BackgroundTasksSurface {...props} />);
    expect(screen.getByRole("button", { name: /^Finished 1/u })).toHaveAttribute("aria-expanded", "false");
    expect(scrolled).toHaveBeenCalledOnce();
  });
});
