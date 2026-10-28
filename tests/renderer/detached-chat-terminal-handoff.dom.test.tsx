import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
import {
  adoptTerminalHandoff,
  liveTerminalIdsForHandoff,
  terminalStorageKey,
} from "../../src/renderer/src/components/terminalTabStorage";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import {
  conversationId,
  detachedBridge,
  detachedSnapshot,
  projectId,
  recordingConnection,
  windowContext,
  type DetachedBridge,
} from "./detached-chat-fixtures";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit(): void {} },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { fontSize: 13, theme: {} };
    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    open(container: HTMLElement): void {
      container.append(document.createElement("textarea"));
    }
    focus(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    clear(): void {}
    writeln(): void {}
    write(): void {}
    dispose(): void {}
  },
}));

const harness = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
  useInertiaConnection: () => harness.connection,
}));

class TestResizeObserver implements ResizeObserver {
  readonly root = null;
  readonly thresholds = [];
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): ResizeObserverEntry[] { return []; }
}

const terminalIds = [
  "71717171-7171-4171-8171-717171717171",
  "72727272-7272-4272-8272-727272727272",
];
const storageKey = terminalStorageKey(projectId, conversationId);

let bridge: DetachedBridge;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  bridge = detachedBridge();
  bridge.install();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "inertia");
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const attachingConnection = () => recordingConnection(detachedSnapshot(), (command) => {
  if (command.type === "terminal.attach") {
    return {
      type: "terminal.created",
      requestId: command.requestId,
      terminalId: command.payload.terminalId,
    } as ServerEvent;
  }
  return undefined;
});

function attachedIds(commands: readonly ClientCommand[]): string[] {
  return commands.flatMap((command) => command.type === "terminal.attach"
    ? [command.payload.terminalId]
    : []);
}

async function renderWindow(
  live: ReturnType<typeof recordingConnection>,
  ids: readonly string[],
): Promise<void> {
  harness.connection = live.connection;
  const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
  render(<DetachedChatApp initialWindowContext={{ ...windowContext, terminalIds: ids }} />);
  await screen.findByRole("textbox", { name: "Message" });
  await act(async () => { await vi.dynamicImportSettled(); });
}

describe("terminal handoff between windows", () => {
  it("offers terminal ids for handoff only while their panel is mounted", async () => {
    window.sessionStorage.setItem(storageKey, JSON.stringify([terminalIds[0], null]));
    expect(liveTerminalIdsForHandoff(projectId, conversationId)).toEqual([]);
    const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> =>
      command.type === "terminal.attach"
        ? { type: "terminal.created", requestId: command.requestId, terminalId: command.payload.terminalId }
        : new Promise<ServerEvent>(() => undefined));
    const panel = render(<TerminalPanel projectId={projectId} conversationId={conversationId}
      projectName="Inertia" status="online" fontSize={13} theme="dark" visible
      sendCommand={sendCommand} subscribe={() => () => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(liveTerminalIdsForHandoff(projectId, conversationId))
      .toEqual([terminalIds[0]]));
    panel.unmount();
    expect(liveTerminalIdsForHandoff(projectId, conversationId)).toEqual([]);
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
  });

  it("adopts handed-over ids once and never over a window's own terminals", () => {
    expect(adoptTerminalHandoff(storageKey, [])).toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(adoptTerminalHandoff(storageKey, terminalIds)).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem(storageKey)!)).toEqual(terminalIds);
    window.sessionStorage.removeItem(storageKey);
    expect(adoptTerminalHandoff(storageKey, terminalIds)).toBe(false);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();

    const otherKey = terminalStorageKey(projectId, "73737373-7373-4373-8373-737373737373");
    window.sessionStorage.setItem(otherKey, JSON.stringify([null]));
    expect(adoptTerminalHandoff(otherKey, terminalIds)).toBe(false);
    expect(JSON.parse(window.sessionStorage.getItem(otherKey)!)).toEqual([null]);
  });

  it("opens the popped-out terminal on the main window's live sessions", async () => {
    const live = attachingConnection();
    await renderWindow(live, terminalIds);
    await waitFor(() => expect(attachedIds(live.commands)).toEqual(terminalIds));
    expect(live.types()).not.toContain("terminal.create");
    expect(screen.getByRole("button", { name: "Toggle terminal" }))
      .toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getAllByRole("tab", { name: /^Terminal \d/u })).toHaveLength(2));
    expect(liveTerminalIdsForHandoff(projectId, conversationId)).toEqual(terminalIds);

    fireEvent.click(screen.getByRole("button", { name: "Return chat to main window" }));
    await waitFor(() => expect(bridge.docked).toEqual([["", terminalIds]]));
  });

  it("neither re-seeds nor re-opens the terminal after a reload", async () => {
    const first = attachingConnection();
    await renderWindow(first, terminalIds);
    await waitFor(() => expect(attachedIds(first.commands)).toEqual(terminalIds));
    cleanup();
    window.sessionStorage.removeItem(storageKey);
    window.localStorage.clear();

    const reloaded = attachingConnection();
    await renderWindow(reloaded, terminalIds);
    expect(screen.getByRole("button", { name: "Toggle terminal" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(attachedIds(reloaded.commands)).toEqual([]);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("keeps the terminal closed when the main window had no live terminals", async () => {
    const live = attachingConnection();
    await renderWindow(live, []);
    expect(screen.getByRole("button", { name: "Toggle terminal" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(live.types().filter((type) => type.startsWith("terminal."))).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Return chat to main window" }));
    await waitFor(() => expect(bridge.docked).toEqual([["", []]]));
  });
});
