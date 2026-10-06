import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextMenuAction, ContextMenuRequest } from "../../src/shared/context-menu";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const terminals = vi.hoisted(() => ({
  instances: [] as Array<{
    keyHandler: ((event: KeyboardEvent) => boolean) | null;
    selection: string;
    focus: ReturnType<typeof vi.fn>;
    selectAll: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    selection = "";
    focus = vi.fn();
    selectAll = vi.fn();
    clear = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terminals.instances.push(this);
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.keyHandler = handler;
    }
    hasSelection(): boolean { return this.selection.length > 0; }
    getSelection(): string { return this.selection; }
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose: () => void } { return { dispose: () => undefined }; }
    writeln(): void {}
    write(): void {}
    dispose(): void {}
  },
}));

const { TerminalSession } = await import("../../src/renderer/src/components/TerminalPanelSession");

const terminalId = "44444444-4444-4444-8444-444444444444";
const bridge = {
  platform: "linux" as NodeJS.Platform,
  showContextMenu: vi.fn<(request: ContextMenuRequest) => Promise<ContextMenuAction | null>>(),
  copyText: vi.fn(async (_text: string) => true),
  getPlatform: () => bridge.platform,
};

function renderTerminal() {
  const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => (
    sent.type === "terminal.create"
      ? { type: "terminal.created", requestId: sent.requestId, terminalId }
      : { type: "request.ok", requestId: sent.requestId }
  ));
  render(
    <TerminalSession
      projectId="11111111-1111-4111-8111-111111111111"
      conversationId="22222222-2222-4222-8222-222222222222"
      projectName="Inertia" status="online" fontSize={13} theme="light"
      colorTheme="inertia" lightColorTheme="inertia" darkColorTheme="inertia"
      sendCommand={sendCommand} subscribe={() => () => undefined}
      initialTerminalId={null} siblingResumedConversationIds={new Set()}
      onRestorableTerminalChange={() => undefined} onTerminalReplaced={() => true}
      onProviderResumeStarted={() => undefined} onClose={() => undefined}
    />,
  );
  return { mount: document.querySelector(".terminal-mount")!, terminal: terminals.instances[0]! };
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

const settleMenu = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  terminals.instances = [];
  vi.clearAllMocks();
  bridge.platform = "linux";
  bridge.showContextMenu.mockResolvedValue(null);
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
  vi.stubGlobal("ResizeObserver", class { disconnect(): void {} observe(): void {} unobserve(): void {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspace terminal context menu", () => {
  it("focuses the terminal so native Paste reaches it and reports only the selection flag", async () => {
    const { mount, terminal } = renderTerminal();
    await waitFor(() => expect(document.querySelector(".terminal-panel")).toHaveAttribute("data-terminal-state", "ready"));
    terminal.selection = "secret output";
    const event = fireEvent.contextMenu(mount, { clientX: 30, clientY: 50 });
    expect(event).toBe(false);
    expect(terminal.focus).toHaveBeenCalled();
    expect(bridge.showContextMenu).toHaveBeenCalledExactlyOnceWith({
      kind: "terminal", hasSelection: true, clearable: true, anchor: { x: 30, y: 50 },
    });
  });

  it("copies the terminal selection, selects all and clears", async () => {
    const { mount, terminal } = renderTerminal();
    await waitFor(() => expect(document.querySelector(".terminal-panel")).toHaveAttribute("data-terminal-state", "ready"));
    terminal.selection = "line one";
    const clears = terminal.clear.mock.calls.length;
    for (const action of ["terminal-copy", "terminal-select-all", "terminal-clear"] as const) {
      bridge.showContextMenu.mockResolvedValueOnce(action);
      fireEvent.contextMenu(mount);
      await settleMenu();
    }
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith("line one");
    expect(terminal.selectAll).toHaveBeenCalledOnce();
    expect(terminal.clear.mock.calls.length).toBe(clears + 1);
  });

  it("announces a terminal copy the clipboard refused", async () => {
    const { mount, terminal } = renderTerminal();
    terminal.selection = "x".repeat(16);
    bridge.copyText.mockResolvedValueOnce(false);
    bridge.showContextMenu.mockResolvedValueOnce("terminal-copy");
    fireEvent.contextMenu(mount);
    await settleMenu();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't copy. Try again or select the text manually.");
  });

  it("lets Ctrl+V paste into the workspace shell on Windows instead of sending ^V", () => {
    bridge.platform = "win32";
    const { terminal } = renderTerminal();
    expect(terminal.keyHandler!(key({ ctrlKey: true, code: "KeyV", key: "v" }))).toBe(false);
    expect(terminal.keyHandler!(key({ ctrlKey: true, shiftKey: true, code: "KeyV", key: "V" }))).toBe(true);
    expect(terminal.keyHandler!(key({ ctrlKey: true, code: "KeyC", key: "c" }))).toBe(true);
    expect(terminal.keyHandler!(key({ ctrlKey: true, altKey: true, code: "KeyV", key: "v" }))).toBe(true);
  });

  it.each([
    ["the V key on Dvorak", { ctrlKey: true, code: "Period", key: "v", keyCode: 86 }, false],
    ["the physical V key typing k on Dvorak", { ctrlKey: true, code: "KeyV", key: "k", keyCode: 75 }, true],
    ["the V key on a Cyrillic layout", { ctrlKey: true, code: "KeyV", key: "м", keyCode: 86 }, false],
  ])("follows the layout on Windows for %s", (_name, init, handledByTerminal) => {
    bridge.platform = "win32";
    const { terminal } = renderTerminal();
    expect(terminal.keyHandler!(key(init))).toBe(handledByTerminal);
  });

  it.each(["linux", "darwin"] as const)("keeps Ctrl+V as a terminal key on %s", (platform) => {
    bridge.platform = platform;
    const { terminal } = renderTerminal();
    expect(terminal.keyHandler!(key({ ctrlKey: true, code: "KeyV", key: "v" }))).toBe(true);
  });
});
