import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
    terminal.selection = "line one";
    for (const action of ["terminal-copy", "terminal-select-all", "terminal-clear"] as const) {
      bridge.showContextMenu.mockResolvedValueOnce(action);
      fireEvent.contextMenu(mount);
      await act(async () => undefined);
    }
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith("line one");
    expect(terminal.selectAll).toHaveBeenCalledOnce();
    expect(terminal.clear.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it.each(["linux", "win32"] as const)("lets Ctrl+V paste on %s instead of sending ^V", (platform) => {
    bridge.platform = platform;
    const { terminal } = renderTerminal();
    expect(terminal.keyHandler!(key({ ctrlKey: true, code: "KeyV", key: "v" }))).toBe(false);
    expect(terminal.keyHandler!(key({ ctrlKey: true, shiftKey: true, code: "KeyV", key: "V" }))).toBe(true);
    expect(terminal.keyHandler!(key({ ctrlKey: true, code: "KeyC", key: "c" }))).toBe(true);
    expect(terminal.keyHandler!(key({ ctrlKey: true, altKey: true, code: "KeyV", key: "v" }))).toBe(true);
  });

  it("keeps Ctrl+V as a terminal key on macOS where Cmd+V pastes", () => {
    bridge.platform = "darwin";
    const { terminal } = renderTerminal();
    expect(terminal.keyHandler!(key({ ctrlKey: true, code: "KeyV", key: "v" }))).toBe(true);
  });
});
