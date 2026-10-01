import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnAgentsLine } from "../../src/renderer/src/components/response-timeline/TurnAgentsLine";
import { taskTrace } from "./background-task-fixtures";

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

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("turn agents line", () => {
  it("renders nothing for a turn without agents", () => {
    const view = render(<TurnAgentsLine subagents={[]} onOpenSurface={vi.fn()} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("is one quiet button that says how many agents are working, with the shared thinking sweep", () => {
    render(<TurnAgentsLine subagents={working} onOpenSurface={vi.fn()} />);
    const line = screen.getByRole("button", { name: "Open Background tasks, 2 agents working" });
    expect(line).toHaveTextContent(/^2 agents working$/u);
    expect(screen.getByText("2 agents working")).toHaveClass("background-task-live");
    expect(line.querySelector("svg, button, a")).toBeNull();
    expect(line.parentElement?.closest("button, a")).toBeNull();
  });

  it("says how many agents finished and names failures in words, without animation", () => {
    render(<TurnAgentsLine subagents={settled} onOpenSurface={vi.fn()} />);
    const line = screen.getByRole("button", { name: "Open Background tasks, 4 agents finished · 1 failed" });
    expect(line).toHaveTextContent(/^4 agents finished · 1 failed$/u);
    expect(screen.getByText("1 failed")).toHaveClass("turn-agents-danger");
    expect(line.querySelector(".background-task-live")).toBeNull();
    const single = render(<TurnAgentsLine subagents={[taskTrace({ status: "completed" })]} onOpenSurface={vi.fn()} />);
    expect(single.container).toHaveTextContent(/^1 agent finished$/u);
  });

  it("opens the Background tasks surface and moves focus to its tab", async () => {
    const user = userEvent.setup();
    const onOpenSurface = vi.fn(() => {
      const tab = document.createElement("button");
      tab.dataset.workspaceTab = "agents";
      tab.textContent = "Background tasks";
      document.body.append(tab);
    });
    render(<TurnAgentsLine subagents={working} onOpenSurface={onOpenSurface} />);
    await user.click(screen.getByRole("button", { name: /^Open Background tasks/u }));
    expect(onOpenSurface).toHaveBeenCalledWith("agents");
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(document.activeElement).toBe(document.querySelector('[data-workspace-tab="agents"]'));
  });

  it("opens from the keyboard", async () => {
    const user = userEvent.setup();
    const onOpenSurface = vi.fn();
    render(<TurnAgentsLine subagents={working} onOpenSurface={onOpenSurface} />);
    screen.getByRole("button").focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onOpenSurface).toHaveBeenCalledTimes(2);
  });

  it("returns a detached chat to the main window when that is the only way to see the panel", async () => {
    const user = userEvent.setup();
    const onOpenSurface = vi.fn();
    render(<TurnAgentsLine subagents={working} onOpenSurface={onOpenSurface} opensInMainWindow />);
    await user.click(screen.getByRole("button", { name: "Return chat to main window, 2 agents working" }));
    expect(onOpenSurface).toHaveBeenCalledOnce();
  });

  it("is plain status text when nothing can open the panel", () => {
    render(<TurnAgentsLine subagents={working} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("2 agents working")).toHaveClass("background-task-live");
  });
});
