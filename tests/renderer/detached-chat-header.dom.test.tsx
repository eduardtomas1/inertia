import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import {
  conversationId,
  detachedBridge,
  detachedSnapshot,
  projectId,
  recordingConnection,
  windowContext,
  type DetachedBridge,
  type RecordingConnection,
} from "./detached-chat-fixtures";

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

const acknowledged = (command: { type: string }): null | undefined =>
  command.type.startsWith("conversation.") ? null : undefined;

async function renderWindow(
  live: RecordingConnection = recordingConnection(detachedSnapshot(), acknowledged),
): Promise<RecordingConnection> {
  harness.connection = live.connection;
  const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
  render(<DetachedChatApp initialWindowContext={windowContext} />);
  await screen.findByRole("textbox", { name: "Message" });
  await act(async () => { await vi.dynamicImportSettled(); });
  return live;
}

async function openTitleMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Detached chat" }), { detail: 1 });
  await act(async () => { await vi.dynamicImportSettled(); });
  return await screen.findByRole("menu", { name: "Thread actions for Detached chat" });
}

const MENU_COMMANDS = new Set([
  "conversation.update",
  "conversation.settle",
  "conversation.unsettle",
  "conversation.mark-unread",
  "conversation.regenerate-title",
]);

function updates(live: RecordingConnection): unknown[] {
  return live.commands
    .filter(({ type }) => MENU_COMMANDS.has(type))
    .map((command) => ({ type: command.type, payload: "payload" in command ? command.payload : undefined }));
}

describe("detached chat header", () => {
  it("keeps one breadcrumb line with the window controls and no project navigation", async () => {
    await renderWindow();
    const breadcrumb = screen.getByRole("navigation", { name: "Chat breadcrumb" });
    expect(breadcrumb).toHaveTextContent(/^Inertia\/Detached chat/u);
    expect(within(breadcrumb).getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Detached chat" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Toggle project navigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: /new chat/iu })).toBeNull();
    for (const name of ["Keep chat window on top", "Return chat to main window", "Close chat window"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });

  it("offers the chat's own actions and hides window placement and removal", async () => {
    await renderWindow();
    const menu = await openTitleMenu();
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(expect.arrayContaining([
      "Pin thread",
      "Settle thread",
      "Snooze",
      "Rename thread",
      "Regenerate title",
      "Mark unread",
      "Copy",
    ]));
    expect(items.some((item) => /split view|new window|chat window|archive|delete/iu.test(item ?? ""))).toBe(false);
    expect(menu.querySelectorAll('[role="separator"] + [role="separator"]')).toHaveLength(0);
    expect(menu.lastElementChild).not.toHaveAttribute("role", "separator");
  });

  it("sends the main window's commands for pin, settle, unread and title regeneration", async () => {
    const live = await renderWindow();
    for (const name of ["Pin thread", "Settle thread", "Mark unread", "Regenerate title"]) {
      const menu = await openTitleMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name }));
    }
    await waitFor(() => expect(updates(live)).toEqual([
      { type: "conversation.update", payload: { conversationId, pinned: true } },
      { type: "conversation.settle", payload: { conversationId } },
      { type: "conversation.mark-unread", payload: { conversationId } },
      { type: "conversation.regenerate-title", payload: { conversationId } },
    ]));
  });

  it("snoozes the chat from the menu", async () => {
    const live = await renderWindow();
    const menu = await openTitleMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Snooze" }));
    const choices = within(screen.getByRole("menu", { name: "Snooze" })).getAllByRole("menuitem");
    fireEvent.click(choices[0]!);
    await waitFor(() => expect(updates(live)).toEqual([{
      type: "conversation.update",
      payload: { conversationId, snoozedUntil: expect.any(String) },
    }]));
  });

  it("renames the chat with F2 and with a double-click", async () => {
    const live = await renderWindow();
    const title = screen.getByRole("button", { name: "Detached chat" });
    fireEvent.keyDown(title, { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Chat title" });
    fireEvent.change(input, { target: { value: "Renamed in the window" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.doubleClick(screen.getByRole("button", { name: "Detached chat" }));
    const second = screen.getByRole("textbox", { name: "Chat title" });
    fireEvent.change(second, { target: { value: "Renamed again" } });
    fireEvent.keyDown(second, { key: "Enter" });
    await waitFor(() => expect(updates(live)).toEqual([
      { type: "conversation.update", payload: { conversationId, title: "Renamed in the window" } },
      { type: "conversation.update", payload: { conversationId, title: "Renamed again" } },
    ]));
  });

  it("copies the chat's thread ID and path", async () => {
    await renderWindow();
    let menu = await openTitleMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Thread ID" }));
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    menu = await openTitleMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Path" }));
    await waitFor(() => expect(bridge.copied).toEqual([conversationId, "/workspace/inertia"]));
  });

  it("opens the chat's checkout folder through the project path bridge", async () => {
    const opened: unknown[] = [];
    const base = window.inertia as unknown as object;
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: new Proxy({}, {
        get: (_target, key) => key === "openProjectPath"
          ? (request: unknown) => {
            opened.push(request);
            return Promise.resolve();
          }
          : Reflect.get(base, key),
      }),
    });
    await renderWindow();
    fireEvent.click(await screen.findByRole("button", { name: "Open Inertia in Folder" }));
    await waitFor(() => expect(opened).toEqual([{
      projectId,
      conversationId,
      relativePath: ".",
      action: "open-externally",
    }]));
  });
});

describe("detached chat hand-offs", () => {
  it("opens the Duo judge in the main window instead of selecting it here", async () => {
    const launchId = "63636363-6363-4363-8363-636363636363";
    const judgeId = "64646464-6464-4464-8464-646464646464";
    const live = recordingConnection(detachedSnapshot(), (command) => {
      if (command.type === "duo.pending") {
        return {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "duo.pending", launchIds: [launchId], hasMore: false },
        };
      }
      if (command.type === "duo.status") {
        return {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "duo.status",
            launchId,
            state: "running",
            error: null,
            sides: [
              { ordinal: 0, conversationId, turnId: null, dispatchState: "started" },
              { ordinal: 1, conversationId: "65656565-6565-4565-8565-656565656565", turnId: null, dispatchState: "started" },
            ],
            comparison: {
              state: "running",
              conversationId: judgeId,
              turnId: null,
              attempt: 1,
              error: null,
            },
          },
        } as ServerEvent;
      }
      return undefined;
    });
    await renderWindow(live);
    fireEvent.click(await screen.findByRole("button", { name: "Open judge" }));
    await waitFor(() => expect(bridge.openedInMain).toEqual([
      { kind: "conversation", conversationId: judgeId },
    ]));
    expect(live.types()).not.toContain("conversation.select");
  });

  it("hands provider limits to the main window from the Usage tab", async () => {
    await renderWindow();
    fireEvent.click(screen.getByRole("button", { name: /^Toggle right panel/u }));
    await act(async () => { await vi.dynamicImportSettled(); });
    fireEvent.click(await screen.findByRole("button", { name: /^Usage/u }));
    await act(async () => { await vi.dynamicImportSettled(); });
    const all = await screen.findByRole("button", { name: "All accounts" });
    fireEvent.click(all);
    expect(bridge.openedInMain).toEqual([{ kind: "usage-limits" }]);
  });

  it("returns the chat with its draft through the existing dock request", async () => {
    await renderWindow();
    fireEvent.click(screen.getByRole("button", { name: "Return chat to main window" }));
    await waitFor(() => expect(bridge.docked).toEqual([["", []]]));
    expect(bridge.openedInMain).toEqual([]);
  });

  it("sends a diagnostics request from this window to the main window", async () => {
    await renderWindow();
    const { navigateDiagnosticContext } = await import("../../src/renderer/src/utils/diagnosticNavigation");
    act(() => {
      navigateDiagnosticContext({ section: "help", anchor: "diagnostics-incidents" });
      navigateDiagnosticContext({
        section: "help",
        anchor: "diagnostics-incidents",
        selection: { turnId: "66666666-6666-4666-8666-666666666666" },
      });
    });
    expect(bridge.openedInMain).toEqual([
      { kind: "diagnostics" },
      { kind: "diagnostics", turnId: "66666666-6666-4666-8666-666666666666" },
    ]);
  });

  it("keeps the selected incident and the requested settings page when handing off", async () => {
    await renderWindow();
    const { navigateDiagnosticContext } = await import("../../src/renderer/src/utils/diagnosticNavigation");
    act(() => {
      navigateDiagnosticContext({
        section: "help",
        anchor: "diagnostics-incidents",
        selection: { incidentId: "77777777-7777-4777-8777-777777777777" },
      });
      navigateDiagnosticContext({ section: "providers" });
      navigateDiagnosticContext({ section: "discord" });
      navigateDiagnosticContext({ section: "support" });
    });
    expect(bridge.openedInMain).toEqual([
      { kind: "diagnostics", incidentId: "77777777-7777-4777-8777-777777777777" },
      { kind: "settings", page: "agents" },
      { kind: "settings", page: "devices" },
      { kind: "settings", page: "help" },
    ]);
  });
});
