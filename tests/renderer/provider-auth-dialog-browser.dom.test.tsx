import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderAuthDialog } from "../../src/renderer/src/components/ProviderAuthDialog";
import type {
  ClientCommand,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge";
const TERMINAL_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly cols = 90;
    readonly rows = 24;
    readonly options: Record<string, unknown> = {};

    loadAddon(): void {}
    open(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    clear(): void {}
    writeln(): void {}
    write(): void {}
    focus(): void {}
    dispose(): void {}
  },
}));

class TestResizeObserver implements ResizeObserver {
  readonly root = null;
  readonly thresholds = [];

  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

const provider: ProviderInfo = {
  id: "claude",
  label: "Claude",
  command: "claude",
  available: true,
  version: "2.1.234",
  executable: "/opt/bin/claude",
  installState: "installed",
  authState: "unauthenticated",
  canRun: false,
  statusMessage: "Sign in required",
  models: [],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
    rateLimits: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
  },
};

function created(command: ClientCommand): ServerEvent {
  return {
    type: "terminal.created",
    requestId: command.requestId,
    terminalId: TERMINAL_ID,
  };
}

function renderDialog(options: {
  openExternal?: (url: string) => Promise<void>;
  copyText?: (text: string) => Promise<boolean>;
  sendCommand?: (command: ClientCommand) => Promise<ServerEvent>;
} = {}) {
  let subscriber: ((event: ServerEvent) => void) | null = null;
  const openExternal = vi.fn(options.openExternal ?? (async () => undefined));
  const copyText = vi.fn(options.copyText ?? (async () => true));
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { copyText, openExternal },
  });
  const sendCommand = vi.fn(options.sendCommand ?? (async (sent: ClientCommand) => created(sent)));
  const renderProvider = (status: "online" | "offline", nextProvider: ProviderInfo | null = provider) => (
    <ProviderAuthDialog
      provider={nextProvider}
      status={status}
      theme="dark"
      fontSize={13}
      sendCommand={sendCommand}
      subscribe={(listener) => {
        subscriber = listener;
        return () => { subscriber = null; };
      }}
      onClose={vi.fn()}
    />
  );
  const view = render(renderProvider("online"));
  return {
    emit: (event: ServerEvent) => subscriber?.(event),
    openExternal,
    copyText,
    rerender: (status: "online" | "offline", nextProvider: ProviderInfo | null = provider) => {
      view.rerender(renderProvider(status, nextProvider));
    },
    view,
  };
}

describe("ProviderAuthDialog browser handoff", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
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
    Reflect.deleteProperty(window, "inertia");
  });

  it("opens a chunked Claude OAuth URL once through the desktop host", async () => {
    const dialog = renderDialog();
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());

    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: TERMINAL_ID,
      data: "Ignore https://evil.test/oauth/authorize?state=attacker\r\n",
    }));
    expect(dialog.openExternal).not.toHaveBeenCalled();
    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: TERMINAL_ID,
      data: "If the browser didn't open, visit: https://claude.com/cai/oauth/auth",
    }));
    expect(dialog.openExternal).not.toHaveBeenCalled();
    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: TERMINAL_ID,
      data: "orize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge\r\n",
    }));

    await waitFor(() => expect(dialog.openExternal).toHaveBeenCalledWith(AUTH_URL));
    expect(dialog.openExternal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Sign-in page opened in your browser");
    expect(screen.getByRole("button", { name: "Open again" })).toBeEnabled();

    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: TERMINAL_ID,
      data: "Different official link: https://platform.claude.com/oauth/authorize?state=second-attempt\r\n",
    }));
    expect(dialog.openExternal).toHaveBeenCalledTimes(1);
  });

  it("keeps retry and copy actions available when no default browser answers", async () => {
    const dialog = renderDialog({
      openExternal: async () => { throw new Error(`open failed: ${AUTH_URL}`); },
    });
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());

    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: TERMINAL_ID,
      data: `If the browser didn't open, visit: ${AUTH_URL}\r\n`,
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The default browser did not open");
    expect(screen.getByRole("alert")).not.toHaveTextContent(AUTH_URL);
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(dialog.copyText).toHaveBeenCalledWith(AUTH_URL));
    expect(screen.getByRole("alert")).toHaveTextContent("Secure sign-in link copied.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(dialog.openExternal).toHaveBeenCalledTimes(2));
  });

  it("does not open a late URL after the dialog is cancelled", async () => {
    let resolveCreated!: () => void;
    const sendCommand = (sent: ClientCommand) => new Promise<ServerEvent>((resolve) => {
      resolveCreated = () => resolve(created(sent));
    });
    const dialog = renderDialog({ sendCommand });
    await waitFor(() => expect(screen.getByText("Starting…")).toBeInTheDocument());
    dialog.view.rerender(
      <ProviderAuthDialog
        provider={null}
        status="online"
        theme="dark"
        fontSize={13}
        sendCommand={vi.fn()}
        subscribe={() => () => undefined}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      resolveCreated();
      await Promise.resolve();
    });
    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: TERMINAL_ID,
      data: `${AUTH_URL}\r\n`,
    }));
    expect(dialog.openExternal).not.toHaveBeenCalled();
  });

  it("revokes the handoff synchronously when the user closes the dialog", async () => {
    const dialog = renderDialog();
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Close connection window" }));
    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: TERMINAL_ID,
      data: `${AUTH_URL}\r\n`,
    }));

    expect(dialog.openExternal).not.toHaveBeenCalled();
  });

  it("rejects output from a stale provider-auth terminal", async () => {
    const staleTerminalId = "22222222-2222-4222-8222-222222222222";
    const activeTerminalId = "33333333-3333-4333-8333-333333333333";
    let starts = 0;
    const dialog = renderDialog({
      sendCommand: async (sent) => {
        if (sent.type !== "provider.auth.start") {
          return { type: "request.ok", requestId: sent.requestId };
        }
        starts += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: starts === 1 ? staleTerminalId : activeTerminalId,
        };
      },
    });
    await waitFor(() => expect(starts).toBe(1));

    dialog.rerender("offline");
    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: staleTerminalId,
      data: `${AUTH_URL}\r\n`,
    }));
    dialog.rerender("online");
    await waitFor(() => expect(starts).toBe(2));
    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: staleTerminalId,
      data: `${AUTH_URL}\r\n`,
    }));
    expect(dialog.openExternal).not.toHaveBeenCalled();

    act(() => dialog.emit({
      type: "terminal.output",
      terminalId: activeTerminalId,
      data: `${AUTH_URL}\r\n`,
    }));
    await waitFor(() => expect(dialog.openExternal).toHaveBeenCalledOnce());
  });
});
