import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderAuthDialog } from "../../src/renderer/src/components/ProviderAuthDialog";
import type { ContextMenuAction, ContextMenuRequest } from "../../src/shared/context-menu";
import type { ClientCommand, ProviderInfo, ServerEvent } from "../../src/shared/contracts";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge";
const TERMINAL_ID = "22222222-2222-4222-8222-222222222222";
const terminals = vi.hoisted(() => [] as XtermTerminal[]);

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/xterm", async () => {
  const actual = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  return {
    Terminal: class extends actual.Terminal {
      private helper: HTMLTextAreaElement | null = null;
      constructor(options: ConstructorParameters<typeof actual.Terminal>[0]) {
        super({ ...options, cols: 90, rows: 24 });
        terminals.push(this);
      }
      override loadAddon(): void {}
      override open(parent: HTMLElement): void {
        const helper = document.createElement("textarea");
        helper.className = "xterm-helper-textarea";
        helper.setAttribute("aria-label", "Terminal input");
        parent.append(helper);
        this.helper = helper;
      }
      override focus(): void {
        this.helper?.focus();
      }
      override dispose(): void {
        this.helper?.remove();
        super.dispose();
      }
    },
  };
});

const provider = {
  id: "claude", label: "Claude", command: "claude", available: true, version: "2.1.234",
  executable: "/opt/bin/claude", installState: "installed", authState: "unauthenticated",
  canRun: false, statusMessage: "Sign in required", models: [], rateLimits: [],
  metadataState: {
    models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
    rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
  },
} satisfies ProviderInfo;

const bridge = {
  copyText: vi.fn(async (_text: string) => true),
  openExternal: vi.fn(async (_url: string) => undefined),
  showContextMenu: vi.fn<(request: ContextMenuRequest) => Promise<ContextMenuAction | null>>(),
  getPlatform: () => "darwin" as NodeJS.Platform,
};

function renderDialog({ created = true } = {}) {
  let subscriber: ((event: ServerEvent) => void) | null = null;
  let createTerminal: (() => void) | null = null;
  const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
    if (sent.type !== "provider.auth.start") return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
    const event = { type: "terminal.created", requestId: sent.requestId, terminalId: TERMINAL_ID } as const;
    if (created) return Promise.resolve(event);
    return new Promise((resolve) => { createTerminal = () => resolve(event); });
  });
  const behind = document.createElement("button");
  behind.textContent = "Behind the dialog";
  document.body.prepend(behind);
  render(
    <ProviderAuthDialog
      provider={provider} status="online" theme="dark" fontSize={13}
      sendCommand={sendCommand}
      subscribe={(listener) => { subscriber = listener; return () => { subscriber = null; }; }}
      onClose={vi.fn()}
    />,
  );
  return {
    behind,
    sendCommand,
    emit: (event: ServerEvent) => subscriber?.(event),
    create: () => createTerminal?.(),
    inputs: () => sendCommand.mock.calls.flatMap(([sent]) => sent.type === "terminal.input" ? [sent.payload.data] : []),
  };
}

const terminalInput = () => screen.getByRole("textbox", { name: "Terminal input" });

async function showHelperBar(dialog: ReturnType<typeof renderDialog>): Promise<void> {
  await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());
  act(() => dialog.emit({ type: "terminal.output", terminalId: TERMINAL_ID, data: `${AUTH_URL}\r\nPaste code here if prompted > ` }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument());
}

beforeEach(() => {
  terminals.length = 0;
  vi.clearAllMocks();
  bridge.showContextMenu.mockResolvedValue(null);
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
  vi.stubGlobal("ResizeObserver", class { disconnect(): void {} observe(): void {} unobserve(): void {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "inertia");
  vi.unstubAllGlobals();
});

describe("provider sign-in paste", () => {
  it.each(["Copy link", "Open again"])("hands focus to the terminal after %s so a paste on return reaches it", async (name) => {
    const dialog = renderDialog();
    await showHelperBar(dialog);
    const button = screen.getByRole("button", { name });
    button.focus();
    fireEvent.click(button);
    await act(async () => undefined);
    expect(terminalInput()).toHaveFocus();

    dialog.behind.focus();
    expect(terminalInput()).toHaveFocus();
  });

  it("restores the terminal instead of a helper-bar button the user left focused", async () => {
    const dialog = renderDialog();
    await showHelperBar(dialog);
    screen.getByRole("button", { name: "Open again" }).focus();

    dialog.behind.focus();

    expect(terminalInput()).toHaveFocus();
  });

  it("offers the terminal menu without Clear and keeps the sign-in output", async () => {
    const dialog = renderDialog();
    await showHelperBar(dialog);
    bridge.showContextMenu.mockResolvedValueOnce("terminal-select-all");
    const event = fireEvent.contextMenu(document.querySelector(".provider-auth-terminal")!, { clientX: 12, clientY: 40 });
    expect(event).toBe(false);
    expect(bridge.showContextMenu).toHaveBeenCalledExactlyOnceWith({
      kind: "terminal", hasSelection: false, clearable: false, anchor: { x: 12, y: 40 },
    });
    expect(terminalInput()).toHaveFocus();
    const terminal = terminals[0]!;
    const selectAll = vi.spyOn(terminal, "selectAll");
    await act(async () => undefined);
    expect(selectAll).toHaveBeenCalledOnce();
    vi.spyOn(terminal, "hasSelection").mockReturnValue(true);
    vi.spyOn(terminal, "getSelection").mockReturnValue("Paste code here if prompted >");
    const clear = vi.spyOn(terminal, "clear");
    bridge.showContextMenu.mockResolvedValueOnce("terminal-copy").mockResolvedValueOnce("terminal-clear");
    fireEvent.contextMenu(document.querySelector(".provider-auth-terminal")!);
    expect(bridge.showContextMenu.mock.calls.at(-1)![0]).toMatchObject({ hasSelection: true });
    await act(async () => undefined);
    expect(bridge.copyText).toHaveBeenLastCalledWith("Paste code here if prompted >");
    fireEvent.contextMenu(document.querySelector(".provider-auth-terminal")!);
    await act(async () => undefined);
    expect(clear).not.toHaveBeenCalled();
  });

  it("holds input typed before the sign-in terminal exists and sends it once created", async () => {
    const dialog = renderDialog({ created: false });
    await waitFor(() => expect(dialog.sendCommand).toHaveBeenCalled());
    act(() => {
      terminals[0]!.input("early-", true);
      terminals[0]!.input("code", true);
    });
    expect(dialog.inputs()).toEqual([]);
    await act(async () => dialog.create());
    await waitFor(() => expect(dialog.inputs()).toEqual(["early-code"]));
  });

  it("sends nothing partial when early input overflows its bound or the attempt ends first", async () => {
    const dialog = renderDialog({ created: false });
    await waitFor(() => expect(dialog.sendCommand).toHaveBeenCalled());
    act(() => {
      terminals[0]!.input("a".repeat(8_000), true);
      terminals[0]!.input("b".repeat(500), true);
      terminals[0]!.input("c".repeat(10), true);
    });
    await act(async () => dialog.create());
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());
    expect(dialog.inputs()).toEqual([]);
    act(() => terminals[0]!.input("after", true));
    expect(dialog.inputs()).toEqual(["after"]);

    document.body.replaceChildren();
    const ended = renderDialog({ created: false });
    await waitFor(() => expect(ended.sendCommand).toHaveBeenCalled());
    act(() => {
      terminals.at(-1)!.input("never-sent", true);
      ended.emit({ type: "terminal.exit", terminalId: TERMINAL_ID, exitCode: 1 });
    });
    await act(async () => ended.create());
    expect(ended.inputs()).toEqual([]);
  });
});
