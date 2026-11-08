import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink, ILinkProvider } from "@xterm/xterm";

import type { ContextMenuAction, ContextMenuRequest } from "../../src/shared/context-menu";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import {
  COMPOSER_PREFILL_EVENT,
  registerComposerPrefillTarget,
  type ComposerPrefillDetail,
} from "../../src/renderer/src/utils/composerPrefill";

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    keyHandler: ((event: KeyboardEvent) => boolean) | null;
    selection: string;
    selectionListeners: Array<() => void>;
    linkProviders: ILinkProvider[];
    focus: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    rowsText: string[];
  }>,
  search: [] as Array<{
    findNext: ReturnType<typeof vi.fn>;
    findPrevious: ReturnType<typeof vi.fn>;
    clearDecorations: ReturnType<typeof vi.fn>;
  }>,
  webLinkHandlers: [] as Array<(event: MouseEvent, uri: string) => void>,
}));

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn((query: string) => query !== "absent");
    findPrevious = vi.fn((query: string) => query !== "absent");
    clearDecorations = vi.fn();
    constructor() { xterm.search.push(this); }
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) { xterm.webLinkHandlers.push(handler); }
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 40;
    rows = 24;
    options: Record<string, unknown>;
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    selection = "";
    selectionListeners: Array<() => void> = [];
    linkProviders: ILinkProvider[] = [];
    focus = vi.fn();
    clearSelection = vi.fn();
    rowsText: string[] = [];
    get buffer() {
      const rows = this.rowsText;
      const cell = { chars: "", getChars: () => cell.chars, getWidth: () => 1 };
      return {
        active: {
          getNullCell: () => cell,
          getLine: (row: number) => rows[row] === undefined ? undefined : {
            isWrapped: false,
            length: 40,
            getCell: (x: number) => { cell.chars = rows[row]![x] ?? ""; return cell; },
          },
        },
      };
    }
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.instances.push(this);
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { this.keyHandler = handler; }
    registerLinkProvider(provider: ILinkProvider): { dispose: () => void } {
      this.linkProviders.push(provider);
      return { dispose: () => undefined };
    }
    onSelectionChange(listener: () => void): { dispose: () => void } {
      this.selectionListeners.push(listener);
      return { dispose: () => undefined };
    }
    hasSelection(): boolean { return this.selection.length > 0; }
    getSelection(): string { return this.selection; }
    selectAll(): void {}
    clear(): void {}
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose: () => void } { return { dispose: () => undefined }; }
    writeln(): void {}
    write(): void {}
    dispose(): void {}
  },
}));

type TerminalPanelProps = import("../../src/renderer/src/components/TerminalPanelSupport").TerminalPanelProps;
const { TerminalSession } = await import("../../src/renderer/src/components/TerminalPanelSession");

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const terminalId = "44444444-4444-4444-8444-444444444444";
const bridge = {
  platform: "linux" as NodeJS.Platform,
  showContextMenu: vi.fn<(request: ContextMenuRequest) => Promise<ContextMenuAction | null>>(),
  openExternal: vi.fn(async (_url: string) => undefined),
  getPlatform: () => bridge.platform,
};

type TerminalInstance = (typeof xterm.instances)[number];

function renderTerminal(options: {
  conversation?: string;
  onOpenWorkspaceFile?: TerminalPanelProps["onOpenWorkspaceFile"];
  resolve?: (text: string) => unknown;
} = {}) {
  const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
    if (sent.type === "terminal.create") return { type: "terminal.created", requestId: sent.requestId, terminalId };
    if (sent.type === "workspace.path.resolve") {
      return {
        type: "request.result",
        requestId: sent.requestId,
        result: { kind: "workspace.path", resolution: (options.resolve?.(sent.payload.text) ?? null) as never },
      };
    }
    return { type: "request.ok", requestId: sent.requestId };
  });
  render(
    <TerminalSession
      projectId={projectId}
      conversationId={"conversation" in options ? options.conversation : conversationId}
      projectName="Inertia" status="online" fontSize={13} theme="light"
      colorTheme="inertia" lightColorTheme="inertia" darkColorTheme="inertia"
      sendCommand={sendCommand} subscribe={() => () => undefined}
      initialTerminalId={null} siblingResumedConversationIds={new Set()}
      onRestorableTerminalChange={() => undefined} onTerminalReplaced={() => true}
      onProviderResumeStarted={() => undefined} onClose={() => undefined}
      tabLabel="Terminal 2"
      onOpenWorkspaceFile={options.onOpenWorkspaceFile}
    />,
  );
  return {
    sendCommand,
    mount: document.querySelector(".terminal-mount")!,
    terminal: xterm.instances[0] as TerminalInstance,
    search: xterm.search[0]!,
  };
}

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", { cancelable: true, ...init });

function select(terminal: TerminalInstance, text: string): void {
  act(() => {
    terminal.selection = text;
    for (const listener of terminal.selectionListeners) listener();
  });
}

/** Stands in for this chat's open message box and records what it receives. */
function capturePrefills(): ComposerPrefillDetail[] {
  const details: ComposerPrefillDetail[] = [];
  cleanups.push(registerComposerPrefillTarget({
    conversationId: () => conversationId,
    receive: (text) => details.push({ conversationId, text }),
  }));
  return details;
}

function observePrefillRequests(): ComposerPrefillDetail[] {
  const details: ComposerPrefillDetail[] = [];
  const listener = (event: Event) => details.push((event as CustomEvent<ComposerPrefillDetail>).detail);
  window.addEventListener(COMPOSER_PREFILL_EVENT, listener);
  cleanups.push(() => window.removeEventListener(COMPOSER_PREFILL_EVENT, listener));
  return details;
}

const cleanups: Array<() => void> = [];
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  xterm.instances = [];
  xterm.search = [];
  xterm.webLinkHandlers = [];
  vi.clearAllMocks();
  bridge.platform = "linux";
  bridge.showContextMenu.mockResolvedValue(null);
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
  vi.stubGlobal("ResizeObserver", class { disconnect(): void {} observe(): void {} unobserve(): void {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  cleanup();
  vi.unstubAllGlobals();
});

describe("terminal selection to prompt", () => {
  it("enables the toolbar action with a selection and prefills this chat's composer", async () => {
    const prefills = capturePrefills();
    const { terminal } = renderTerminal();
    const button = screen.getByRole("button", { name: "Add selection to prompt" });
    expect(button).toBeDisabled();
    select(terminal, "$ npm test\nFAIL ```weird``` output");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(prefills).toEqual([{
      conversationId,
      text: "Terminal output (Terminal 2):\n````text\n$ npm test\nFAIL ```weird``` output\n````",
    }]);
    select(terminal, "");
    expect(button).toBeDisabled();
  });

  it("bounds the excerpt it sends", () => {
    const prefills = capturePrefills();
    const { terminal } = renderTerminal();
    select(terminal, Array.from({ length: 500 }, (_, index) => `row ${index}`).join("\n"));
    fireEvent.click(screen.getByRole("button", { name: "Add selection to prompt" }));
    const [detail] = prefills;
    expect(detail!.text.split("\n")[0]).toBe("Terminal output (Terminal 2, last 200 of 500 lines):");
    expect(new TextEncoder().encode(detail!.text).byteLength).toBeLessThanOrEqual(8 * 1_024 + 128);
  });

  it("offers Add selection to prompt in the terminal menu", async () => {
    const prefills = capturePrefills();
    const { mount, terminal } = renderTerminal();
    await waitFor(() => expect(document.querySelector(".terminal-panel")).toHaveAttribute("data-terminal-state", "ready"));
    terminal.selection = "error: boom";
    bridge.showContextMenu.mockResolvedValueOnce("terminal-add-to-prompt");
    fireEvent.contextMenu(mount, { clientX: 4, clientY: 8 });
    await settle();
    expect(bridge.showContextMenu).toHaveBeenCalledExactlyOnceWith({
      kind: "terminal", conversationId, hasSelection: true, clearable: true, promptable: true, anchor: { x: 4, y: 8 },
    });
    expect(prefills).toEqual([{
      conversationId,
      text: "Terminal output (Terminal 2):\n```text\nerror: boom\n```",
    }]);
  });

  it("keeps the selection and says so when no message box for the chat is open", () => {
    const requests = observePrefillRequests();
    const { terminal } = renderTerminal();
    select(terminal, "error: boom");
    const button = screen.getByRole("button", { name: "Add selection to prompt" });
    fireEvent.click(button);
    expect(requests).toHaveLength(1);
    expect(screen.getByText("Open this chat's message box to add the selection.").closest("[role='status']")).not.toBeNull();
    expect(terminal.selection).toBe("error: boom");
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(button).toBeEnabled();

    const prefills = capturePrefills();
    fireEvent.click(button);
    expect(prefills).toEqual([{ conversationId, text: "Terminal output (Terminal 2):\n```text\nerror: boom\n```" }]);
    expect(screen.queryByText("Open this chat's message box to add the selection.")).toBeNull();
  });

  it("lets the undelivered notice be dismissed", () => {
    const { terminal } = renderTerminal();
    select(terminal, "x");
    fireEvent.click(screen.getByRole("button", { name: "Add selection to prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByText("Open this chat's message box to add the selection.")).toBeNull();
  });

  it("keeps a terminal without a chat out of the prompt", async () => {
    const prefills = capturePrefills();
    const { mount, terminal } = renderTerminal({ conversation: undefined });
    expect(screen.queryByRole("button", { name: "Add selection to prompt" })).toBeNull();
    terminal.selection = "x";
    bridge.showContextMenu.mockResolvedValueOnce("terminal-add-to-prompt");
    fireEvent.contextMenu(mount, { clientX: 1, clientY: 1 });
    await settle();
    expect(bridge.showContextMenu.mock.calls[0]![0]).not.toHaveProperty("promptable");
    expect(prefills).toEqual([]);
  });
});

describe("terminal find", () => {
  it("opens with Ctrl+Shift+F from the terminal, searches and closes with Escape", async () => {
    const { terminal, search } = renderTerminal();
    const event = key({ ctrlKey: true, shiftKey: true, key: "F", code: "KeyF" });
    let handled = true;
    act(() => { handled = terminal.keyHandler!(event); });
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    const input = screen.getByRole("textbox", { name: "Find in terminal" });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: "error" } });
    expect(search.findNext).toHaveBeenLastCalledWith("error", { caseSensitive: false, incremental: true });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(search.findNext).toHaveBeenLastCalledWith("error", { caseSensitive: false, incremental: false });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(search.findPrevious).toHaveBeenLastCalledWith("error", { caseSensitive: false, incremental: false });
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(search.findPrevious).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(search.findNext).toHaveBeenCalledTimes(3);
    expect(document.querySelector(".terminal-find-status")).toBeEmptyDOMElement();

    fireEvent.change(input, { target: { value: "absent" } });
    expect(await screen.findByText("No matches")).toBeInTheDocument();

    search.clearDecorations.mockClear();
    fireEvent.change(input, { target: { value: "" } });
    expect(search.clearDecorations).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
    expect(screen.queryByText("No matches")).toBeNull();

    terminal.focus.mockClear();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Terminal find" })).toBeNull();
    expect(search.clearDecorations).toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalled();
  });

  it("uses Cmd+F on macOS and leaves Ctrl+F to the shell there", () => {
    bridge.platform = "darwin";
    const { terminal } = renderTerminal();
    let handled = false;
    act(() => { handled = terminal.keyHandler!(key({ ctrlKey: true, key: "f" })); });
    expect(handled).toBe(true);
    expect(screen.queryByRole("search", { name: "Terminal find" })).toBeNull();
    act(() => { handled = terminal.keyHandler!(key({ metaKey: true, shiftKey: true, key: "f" })); });
    expect(handled).toBe(true);
    act(() => { handled = terminal.keyHandler!(key({ metaKey: true, key: "f" })); });
    expect(handled).toBe(false);
    expect(screen.getByRole("search", { name: "Terminal find" })).toBeInTheDocument();
  });

  it("leaves Ctrl+F to the shell, ignores other modifiers and keeps paste handling", () => {
    const { terminal } = renderTerminal();
    for (const init of [
      { ctrlKey: true, key: "f" },
      { ctrlKey: true, shiftKey: true, altKey: true, key: "F" },
      { ctrlKey: true, altKey: true, key: "f" },
      { metaKey: true, key: "f" },
      { key: "f" },
      { ctrlKey: true, key: "v" },
    ]) {
      let handled = false;
      act(() => { handled = terminal.keyHandler!(key(init)); });
      expect(handled).toBe(true);
    }
    expect(screen.queryByRole("search", { name: "Terminal find" })).toBeNull();
  });

  it("opens from the toolbar button", async () => {
    renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: "Find in terminal" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Find in terminal" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Close find" }));
    expect(screen.queryByRole("textbox", { name: "Find in terminal" })).toBeNull();
  });
});

describe("terminal links", () => {
  it("routes web links through the desktop bridge", () => {
    const open = vi.spyOn(window, "open");
    renderTerminal();
    const handler = xterm.webLinkHandlers[0]!;
    const event = new MouseEvent("click", { cancelable: true });
    handler(event, "https://example.com/build/42");
    handler(new MouseEvent("click"), "javascript:alert(1)");
    expect(event.defaultPrevented).toBe(true);
    expect(bridge.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/build/42");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("routes OSC 8 hyperlinks through the same desktop bridge", () => {
    const open = vi.spyOn(window, "open");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const { terminal } = renderTerminal();
    const linkHandler = terminal.options.linkHandler as {
      activate: (event: MouseEvent, uri: string) => void;
      allowNonHttpProtocols?: boolean;
    };
    expect(linkHandler.allowNonHttpProtocols).toBe(false);
    const event = new MouseEvent("click", { cancelable: true });
    linkHandler.activate(event, "https://example.com/docs");
    linkHandler.activate(new MouseEvent("click"), "file:///etc/passwd");
    expect(event.defaultPrevented).toBe(true);
    expect(bridge.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    expect(open).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("resolves file paths in the runtime and opens them in Files at their line", async () => {
    const onOpenWorkspaceFile = vi.fn();
    const { terminal, sendCommand } = renderTerminal({
      onOpenWorkspaceFile,
      resolve: (text) => text === "src/app.ts:12:3"
        ? { projectPath: "src/app.ts", line: 12, column: 3 }
        : null,
    });
    await waitFor(() => expect(document.querySelector(".terminal-panel")).toHaveAttribute("data-terminal-state", "ready"));
    terminal.rowsText = ["FAIL src/app.ts:12:3 ../escape.ts"];
    const links = await new Promise<ILink[] | undefined>((resolve) => terminal.linkProviders[0]!.provideLinks(1, resolve));
    const lookups = sendCommand.mock.calls
      .map(([sent]) => sent)
      .filter((sent) => sent.type === "workspace.path.resolve");
    expect(lookups.map((sent) => sent.payload)).toEqual([
      { projectId, conversationId, text: "src/app.ts:12:3" },
      { projectId, conversationId, text: "../escape.ts" },
    ]);
    expect(links?.map((link) => link.text)).toEqual(["src/app.ts:12:3"]);
    links![0]!.activate(new MouseEvent("click"), "src/app.ts:12:3");
    expect(onOpenWorkspaceFile).toHaveBeenCalledExactlyOnceWith(
      "src/app.ts",
      { startLine: 12, startColumn: 3, endLine: 12 },
      true,
    );

    await new Promise<ILink[] | undefined>((resolve) => terminal.linkProviders[0]!.provideLinks(1, resolve));
    expect(sendCommand.mock.calls.filter(([sent]) => sent.type === "workspace.path.resolve")).toHaveLength(2);
  });

  it("offers no file links where Files cannot open them", async () => {
    const { terminal, sendCommand } = renderTerminal();
    terminal.rowsText = ["src/app.ts"];
    await expect(new Promise((resolve) => terminal.linkProviders[0]!.provideLinks(1, resolve))).resolves.toBeUndefined();
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "workspace.path.resolve")).toBe(false);
  });
});
