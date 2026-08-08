import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const terminalState = vi.hoisted(() => ({
  textarea: null as HTMLTextAreaElement | null,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {
      fontSize: 13,
      theme: {},
    };

    loadAddon(): void {}

    open(container: HTMLElement): void {
      const textarea = document.createElement("textarea");
      textarea.setAttribute("aria-label", "Terminal input");
      container.append(textarea);
      terminalState.textarea = textarea;
    }

    focus(): void {
      terminalState.textarea?.focus();
    }

    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }

    clear(): void {}
    writeln(): void {}
    write(): void {}
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

describe("TerminalPanel focus lifecycle", () => {
  beforeEach(() => {
    terminalState.textarea = null;
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

  it("does not steal focus when the lazy terminal mounts after another control is active", async () => {
    const sendCommand = vi.fn(() => new Promise<ServerEvent>(() => undefined));
    const view = render(<button type="button">Composer menu item</button>);
    const composerMenuItem = screen.getByRole("button", {
      name: "Composer menu item",
    });
    composerMenuItem.focus();

    view.rerender(
      <>
        <button type="button">Composer menu item</button>
        <TerminalPanel
          projectId="project-1"
          projectName="Inertia"
          status="online"
          fontSize={13}
          theme="dark"
          sendCommand={sendCommand}
          subscribe={() => () => undefined}
          onClose={() => undefined}
        />
      </>,
    );

    await waitFor(() => expect(sendCommand).toHaveBeenCalled());
    expect(screen.getByRole("button", {
      name: "Composer menu item",
    })).toHaveFocus();
  });

  it("does not reclaim focus when delayed terminal creation completes", async () => {
    let completeCreation: ((event: ServerEvent) => void) | undefined;
    const sendCommand = vi.fn(() => new Promise<ServerEvent>((resolve) => {
      completeCreation = resolve;
    }));

    render(
      <>
        <button type="button">Palette search</button>
        <TerminalPanel
          projectId="project-1"
          projectName="Inertia"
          status="online"
          fontSize={13}
          theme="dark"
          sendCommand={sendCommand}
          subscribe={() => () => undefined}
          onClose={() => undefined}
        />
      </>,
    );

    await waitFor(() => expect(sendCommand).toHaveBeenCalled());
    const paletteSearch = screen.getByRole("button", {
      name: "Palette search",
    });
    paletteSearch.focus();
    expect(paletteSearch).toHaveFocus();

    await act(async () => {
      completeCreation?.({
        type: "terminal.created",
        requestId: "request-1",
        terminalId: "terminal-1",
      });
      await Promise.resolve();
    });

    expect(paletteSearch).toHaveFocus();
  });

  it("does not attach a delayed project action to a newly selected chat", async () => {
    let settleOldAction: ((event: ServerEvent) => void) | undefined;
    const sendCommand = vi.fn((command: ClientCommand): Promise<ServerEvent> => {
      if (command.type === "terminal.create") {
        const owner = command.payload.projectId === "project-1"
          ? "alpha"
          : "beta";
        return Promise.resolve({
          type: "terminal.created",
          requestId: command.requestId,
          terminalId: `terminal-${owner}`,
        });
      }
      if (command.type === "project.action.run") {
        return new Promise((resolve) => {
          settleOldAction = resolve;
        });
      }
      return Promise.resolve({
        type: "request.ok",
        requestId: command.requestId,
      });
    });
    const onActionStarted = vi.fn();
    const view = render(
      <TerminalPanel
        projectId="project-1"
        conversationId="conversation-1"
        projectName="Alpha"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        actionId="dev"
        onActionStarted={onActionStarted}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(sendCommand.mock.calls.some(
        ([command]) => command.type === "project.action.run",
      )).toBe(true);
    });
    view.rerender(
      <TerminalPanel
        projectId="project-2"
        conversationId="conversation-2"
        projectName="Beta"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        actionId={null}
        onActionStarted={onActionStarted}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(document.querySelector(".terminal-panel"))
        .toHaveAttribute("data-terminal-id", "terminal-beta");
    });

    await act(async () => {
      settleOldAction?.({
        type: "terminal.created",
        requestId: "old-action-request",
        terminalId: "terminal-old-action",
      });
      await Promise.resolve();
    });

    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", "terminal-beta");
    expect(onActionStarted).not.toHaveBeenCalled();
  });
});
