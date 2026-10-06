import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderAuthDialog } from "../../src/renderer/src/components/ProviderAuthDialog";
import type {
  ClientCommand,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";

const TERMINAL_ID = "22222222-2222-4222-8222-222222222222";
const keyHandlers = vi.hoisted(() => [] as Array<(event: KeyboardEvent) => boolean>);

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

vi.mock("@xterm/xterm", async () => {
  const actual = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  return {
    Terminal: class extends actual.Terminal {
      private helper: HTMLTextAreaElement | null = null;
      constructor(options: ConstructorParameters<typeof actual.Terminal>[0]) {
        super({ ...options, cols: 90, rows: 24 });
      }
      override loadAddon(): void {}
      override attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
        keyHandlers.push(handler);
        super.attachCustomKeyEventHandler(handler);
      }
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

function renderDialog(platform = "darwin") {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      copyText: vi.fn(async () => true),
      openExternal: vi.fn(async () => undefined),
      getPlatform: () => platform,
    },
  });
  const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => ({
    type: "terminal.created",
    requestId: sent.requestId,
    terminalId: TERMINAL_ID,
  }));
  const behind = document.createElement("button");
  behind.textContent = "Behind the dialog";
  document.body.prepend(behind);
  const view = render(
    <ProviderAuthDialog
      provider={provider}
      status="online"
      theme="dark"
      fontSize={13}
      sendCommand={sendCommand}
      subscribe={() => () => undefined}
      onClose={vi.fn()}
    />,
  );
  return { behind, sendCommand, view };
}

function terminalInput(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Terminal input" }) as HTMLTextAreaElement;
}

describe("ProviderAuthDialog keyboard focus", () => {
  beforeEach(() => {
    keyHandlers.length = 0;
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
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "inertia");
  });

  it("focuses the sign-in terminal once the provider session is ready", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(terminalInput()).toHaveFocus();
  });

  it("returns focus to the sign-in terminal when the window restores focus behind the dialog", async () => {
    const { behind } = renderDialog();
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());
    terminalInput().focus();

    behind.focus();

    expect(terminalInput()).toHaveFocus();
  });

  it("returns focus to the sign-in terminal after a click on inert dialog chrome", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());
    terminalInput().focus();

    terminalInput().blur();

    await waitFor(() => expect(terminalInput()).toHaveFocus());
  });

  it("restores the last focused dialog control instead of the terminal", async () => {
    const { behind } = renderDialog();
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();

    behind.focus();

    expect(close).toHaveFocus();
  });

  it("releases focus containment once the dialog closes", async () => {
    const { behind, view } = renderDialog();
    await waitFor(() => expect(screen.getByText("Waiting for sign-in")).toBeInTheDocument());
    terminalInput().focus();
    view.unmount();

    behind.focus();

    expect(behind).toHaveFocus();
  });

  it("leaves Control+V to the browser paste command outside macOS", () => {
    renderDialog("linux");
    const handler = keyHandlers.at(-1)!;

    expect(handler(new KeyboardEvent("keydown", { ctrlKey: true, code: "KeyV", key: "v" }))).toBe(false);
    expect(handler(new KeyboardEvent("keydown", { ctrlKey: true, code: "KeyC", key: "c" }))).toBe(true);
    expect(handler(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, code: "KeyV", key: "V" }))).toBe(true);
  });

  it.each(["linux", "win32"])("follows the keyboard layout for the paste key on %s", (platform) => {
    renderDialog(platform);
    const handler = keyHandlers.at(-1)!;

    expect(handler(new KeyboardEvent("keydown", { ctrlKey: true, code: "Period", key: "v", keyCode: 86 }))).toBe(false);
    expect(handler(new KeyboardEvent("keydown", { ctrlKey: true, code: "KeyV", key: "k", keyCode: 75 }))).toBe(true);
    expect(handler(new KeyboardEvent("keydown", { ctrlKey: true, code: "KeyV", key: "м", keyCode: 86 }))).toBe(false);
  });

  it("keeps Control+V as a terminal control character on macOS", () => {
    renderDialog("darwin");
    const handler = keyHandlers.at(-1)!;

    expect(handler(new KeyboardEvent("keydown", { ctrlKey: true, code: "KeyV", key: "v" }))).toBe(true);
    expect(handler(new KeyboardEvent("keydown", { metaKey: true, code: "KeyV", key: "v" }))).toBe(true);
  });
});
