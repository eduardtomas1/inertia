import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
import type { ServerEvent } from "../../src/shared/contracts";

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
});
