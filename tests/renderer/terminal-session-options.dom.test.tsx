import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const terminals = vi.hoisted(() => ({
  instances: [] as Array<{
    options: { fontSize: number; theme: Record<string, string> };
    writes: string[];
    clears: number;
  }>,
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
    options: { fontSize: number; theme: Record<string, string> };
    writes: string[] = [];
    clears = 0;

    constructor(options: { fontSize: number; theme: Record<string, string> }) {
      this.options = { ...options };
      terminals.instances.push(this);
    }

    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    open(): void {}
    focus(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    clear(): void {
      this.clears += 1;
    }
    writeln(data: string): void {
      this.writes.push(data);
    }
    write(data: string): void {
      this.writes.push(data);
    }
    dispose(): void {}
  },
}));

const { TerminalSession } = await import("../../src/renderer/src/components/TerminalPanelSession");

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const terminalId = "44444444-4444-4444-8444-444444444444";

function session(
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>,
  overrides: { projectName?: string; lightColorTheme?: "inertia" | "ocean" } = {},
): React.JSX.Element {
  return (
    <TerminalSession
      projectId={projectId}
      conversationId={conversationId}
      projectName={overrides.projectName ?? "Inertia"}
      status="online"
      fontSize={13}
      theme="light"
      colorTheme="inertia"
      lightColorTheme={overrides.lightColorTheme ?? "inertia"}
      darkColorTheme="inertia"
      sendCommand={sendCommand}
      subscribe={() => () => undefined}
      initialTerminalId={null}
      siblingResumedConversationIds={new Set()}
      onRestorableTerminalChange={() => undefined}
      onTerminalReplaced={() => true}
      onProviderResumeStarted={() => undefined}
      onClose={() => undefined}
    />
  );
}

describe("TerminalSession live options", () => {
  beforeEach(() => {
    terminals.instances = [];
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--terminal-bg");
    vi.unstubAllGlobals();
  });

  it("repaints an open terminal when only the light color theme changes", async () => {
    document.documentElement.style.setProperty("--terminal-bg", "#ffffff");
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => (
      sent.type === "terminal.create"
        ? { type: "terminal.created", requestId: sent.requestId, terminalId }
        : { type: "request.ok", requestId: sent.requestId }
    ));
    const view = render(session(sendCommand));
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId));
    expect(terminals.instances[0]!.options.theme.background).toBe("#ffffff");

    document.documentElement.style.setProperty("--terminal-bg", "#fdf6e3");
    view.rerender(session(sendCommand, { lightColorTheme: "ocean" }));

    expect(terminals.instances[0]!.options.theme.background).toBe("#fdf6e3");
  });

  it("keeps the attached shell when the project is renamed", async () => {
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => (
      sent.type === "terminal.create"
        ? { type: "terminal.created", requestId: sent.requestId, terminalId }
        : { type: "request.ok", requestId: sent.requestId }
    ));
    const view = render(session(sendCommand));
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-state", "ready"));
    const terminal = terminals.instances[0]!;
    const clears = terminal.clears;
    const shellStarts = () => sendCommand.mock.calls
      .filter(([sent]) => sent.type === "terminal.create" || sent.type === "terminal.attach");
    expect(shellStarts()).toHaveLength(1);

    view.rerender(session(sendCommand, { projectName: "Inertia renamed" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shellStarts()).toHaveLength(1);
    expect(terminal.clears).toBe(clears);
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-state", "ready");
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId);
  });
});
