import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversationId,
  detachedBridge,
  detachedSnapshot,
  detail,
  projectId,
  recordingConnection,
  windowContext,
  type DetachedBridge,
} from "./detached-chat-fixtures";
import { taskTrace, taskTurn } from "./background-task-fixtures";

const harness = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
  useInertiaConnection: () => harness.connection,
}));

let bridge: DetachedBridge;

beforeEach(() => {
  bridge = detachedBridge();
  bridge.install();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
  window.localStorage.clear();
});

async function renderWindow(live = recordingConnection(detachedSnapshot())) {
  harness.connection = live.connection;
  const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
  render(<DetachedChatApp initialWindowContext={windowContext} />);
  await screen.findByRole("textbox", { name: "Message" });
  await act(async () => { await vi.dynamicImportSettled(); });
  return live;
}

async function openPanel(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /^Toggle right panel/u }));
  await act(async () => { await vi.dynamicImportSettled(); });
  return await screen.findByRole("complementary", { name: "Workspace tools" });
}

describe("detached chat tools panel", () => {
  it("opens the main window's tool surfaces beside the chat, without the Browser", async () => {
    await renderWindow();
    const toggle = screen.getByRole("button", { name: /^Toggle right panel/u });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    const panel = await openPanel();
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const launcher = await within(panel).findByRole("group", { name: "Open a surface" });
    const labels = within(launcher).getAllByRole("button").map((button) => button.textContent?.replace(/[A-Z]$/u, ""));
    expect(labels).toEqual([
      "Changes",
      "Files",
      "Terminal",
      "Attachments",
      "Background tasks",
      "Usage",
      "Goal",
      "Plan",
    ]);
    expect(within(panel).queryByText("Browser")).toBeNull();

    fireEvent.click(within(launcher).getByRole("button", { name: /^Plan/u }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(within(panel).getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
    expect(await within(panel).findByRole("tabpanel", { name: "Plan" })).toBeVisible();

    fireEvent.click(within(panel).getByRole("button", { name: "Add panel surface" }));
    await act(async () => { await vi.dynamicImportSettled(); });
    const addMenu = within(panel).getByRole("menu", { name: "Add panel surface" });
    expect(within(addMenu).queryByRole("menuitem", { name: /Browser/u })).toBeNull();
    fireEvent.click(within(addMenu).getByRole("menuitem", { name: /^Goal/u }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(within(panel).getByRole("tab", { name: "Goal" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(toggle);
    expect(panel).not.toBeVisible();
  });

  it("opens the Plan tab when a plan arrives and the setting asks for it", async () => {
    const live = await renderWindow(recordingConnection(detachedSnapshot({ autoOpenPlan: true })));
    live.emit({
      type: "agent.plan.updated",
      plan: {
        conversationId,
        runId: "plan-run",
        turnId: "plan-turn",
        explanation: null,
        steps: [{ step: "Map the detached window", status: "inProgress" }],
      },
    });
    await act(async () => { await vi.dynamicImportSettled(); });
    const panel = await screen.findByRole("complementary", { name: "Workspace tools" });
    await waitFor(() => expect(within(panel).getByRole("tab", { name: /^Plan/u }))
      .toHaveAttribute("aria-selected", "true"));
  });

  it("keeps the panel closed when a plan arrives and the setting is off", async () => {
    const live = await renderWindow(recordingConnection(detachedSnapshot({ autoOpenPlan: false })));
    live.emit({
      type: "agent.plan.updated",
      plan: {
        conversationId,
        runId: "plan-run",
        turnId: "plan-turn",
        explanation: null,
        steps: [{ step: "Map the detached window", status: "inProgress" }],
      },
    });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(screen.queryByRole("complementary", { name: "Workspace tools" })).toBeNull();
  });

  it("opens Background tasks from a turn's agents line", async () => {
    const turn = taskTurn({
      id: "detached-turn",
      conversationId,
      userMessageId: "detached-message",
      status: "completed",
      completedAt: "2030-01-01T00:02:00.000Z",
    });
    const live = recordingConnection(detachedSnapshot(), undefined, {
      ...detail,
      agentTurns: [turn],
      messages: [{
        id: "detached-message",
        conversationId,
        turnId: turn.id,
        role: "user",
        content: "Split the work across helpers.",
        attachments: [],
        createdAt: turn.requestedAt,
      }],
      subagents: [
        taskTrace({ id: "done", conversationId, turnId: turn.id, runId: turn.runId, status: "completed" }),
      ],
    });
    await renderWindow(live);
    fireEvent.click(await screen.findByRole("button", { name: /^Open Background tasks/u }));
    await act(async () => { await vi.dynamicImportSettled(); });
    const panel = await screen.findByRole("complementary", { name: "Workspace tools" });
    expect(within(panel).getByRole("tab", { name: /^Background tasks/u }))
      .toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(live.types()).toContain("conversation.background-tasks.get"));
    expect(live.commands.find(({ type }) => type === "conversation.background-tasks.get"))
      .toMatchObject({ payload: { conversationId } });
  });

  it("loads this chat's Git status and project actions like the main window", async () => {
    const live = await renderWindow();
    await waitFor(() => expect(live.types()).toEqual(expect.arrayContaining([
      "git.refresh",
      "project.actions",
    ])));
    expect(live.commands.find(({ type }) => type === "git.refresh"))
      .toMatchObject({ payload: { projectId, conversationId } });
  });
});

describe("detached chat keyboard", () => {
  function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key,
      code: `Key${key.toUpperCase()}`,
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    screen.getByRole("textbox", { name: "Message" }).dispatchEvent(event);
    return event;
  }

  it("toggles the terminal with the user's terminal shortcut", async () => {
    await renderWindow(recordingConnection(detachedSnapshot({
      keybindings: { search: "k", "new-chat": "n", "toggle-sidebar": "b", "toggle-terminal": "y", tasks: "t", "open-surface": "g" },
    })));
    const terminal = screen.getByRole("button", { name: "Toggle terminal" });
    expect(terminal).toHaveAttribute("aria-pressed", "false");
    act(() => { press("j"); });
    expect(terminal).toHaveAttribute("aria-pressed", "false");
    act(() => { press("y"); });
    expect(terminal).toHaveAttribute("aria-pressed", "true");
    act(() => { press("y"); });
    expect(terminal).toHaveAttribute("aria-pressed", "false");
  });

  it("hands new chat and settings to the main window and keeps search, tasks and sidebar quiet", async () => {
    await renderWindow();
    expect(press("n").defaultPrevented).toBe(true);
    expect(press(",", { code: "Comma" }).defaultPrevented).toBe(true);
    await waitFor(() => expect(bridge.openedInMain).toEqual([
      { kind: "new-chat", projectId },
      { kind: "settings", page: "appearance" },
    ]));
    for (const key of ["k", "t", "b"]) press(key);
    await act(async () => { await Promise.resolve(); });
    expect(bridge.openedInMain).toHaveLength(2);
    expect(bridge.docked).toEqual([]);
  });

  it("closes the active panel tab before the window with Command+W", async () => {
    const closes: string[] = [];
    await renderWindow();
    const base = window.inertia as unknown as object;
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: new Proxy({}, {
        get: (_target, key) => key === "closeDetachedChat"
          ? (draft: string) => {
            closes.push(draft);
            return Promise.resolve();
          }
          : Reflect.get(base, key),
      }),
    });
    const panel = await openPanel();
    fireEvent.click(await within(panel).findByRole("button", { name: /^Goal/u }));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(within(panel).getByRole("tab", { name: "Goal" })).toBeInTheDocument();
    act(() => { press("w"); });
    expect(within(panel).queryByRole("tab", { name: "Goal" })).toBeNull();
    expect(closes).toEqual([]);
    act(() => { press("w"); });
    expect(closes).toEqual([""]);
  });
});
