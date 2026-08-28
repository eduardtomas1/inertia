import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit(): void {} },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { fontSize: 13, theme: {} };
    loadAddon(): void {}
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

class TestResizeObserver implements ResizeObserver {
  readonly root = null;
  readonly thresholds = [];
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
  takeRecords(): ResizeObserverEntry[] { return []; }
}

const projectId = "11111111-1111-4111-8111-111111111111";
const firstConversationId = "22222222-2222-4222-8222-222222222222";
const secondConversationId = "33333333-3333-4333-8333-333333333333";
const firstTerminalId = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  window.sessionStorage.clear();
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

describe("TerminalPanel retained ownership", () => {
  it("closes a delayed creation when the user explicitly removed its tab", async () => {
    let resolveCreate!: (event: ServerEvent) => void;
    const create = new Promise<ServerEvent>((resolve) => {
      resolveCreate = resolve;
    });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => (
      sent.type === "terminal.create"
        ? create
        : Promise.resolve({ type: "request.ok", requestId: sent.requestId })
    ));
    function Harness(): React.JSX.Element {
      const [visible, setVisible] = useState(true);
      return <TerminalPanel
        projectId={projectId}
        conversationId={firstConversationId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible={visible}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => setVisible(false)}
      />;
    }
    render(<Harness />);
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.create",
    )).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await act(async () => resolveCreate({
      type: "terminal.created",
      requestId: crypto.randomUUID(),
      terminalId: firstTerminalId,
    }));

    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close"
      && sent.payload.terminalId === firstTerminalId
    ))).toBe(true));
    expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.detach"
      && sent.payload.terminalId === firstTerminalId
    ))).toBe(false);
    expect(window.sessionStorage.getItem(
      `inertia:terminal-sessions:v1:${projectId}:${firstConversationId}`,
    )).toBeNull();
  });

  it("detaches on scope navigation and reattaches the persisted capability", async () => {
    let created = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: created === 1
            ? firstTerminalId
            : "55555555-5555-4555-8555-555555555555",
        };
      }
      if (sent.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const props = {
      projectId,
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      sendCommand,
      subscribe: () => () => undefined,
      onClose: () => undefined,
    };
    const view = render(
      <TerminalPanel {...props} conversationId={firstConversationId} />,
    );
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", firstTerminalId));

    view.rerender(
      <TerminalPanel {...props} conversationId={secondConversationId} />,
    );
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.detach"
      && sent.payload.terminalId === firstTerminalId
    ))).toBe(true));
    view.rerender(
      <TerminalPanel {...props} conversationId={firstConversationId} />,
    );
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.attach"
      && sent.payload.terminalId === firstTerminalId
    ))).toBe(true));
  });

  it("closes a superseded late creation instead of replacing the visible shell", async () => {
    const oldTerminalId = firstTerminalId;
    const currentTerminalId = "55555555-5555-4555-8555-555555555555";
    let firstScopeCreation = true;
    let resolveOld!: (event: ServerEvent) => void;
    const oldCreation = new Promise<ServerEvent>((resolve) => {
      resolveOld = resolve;
    });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        if (
          sent.payload.conversationId === firstConversationId
          && firstScopeCreation
        ) {
          firstScopeCreation = false;
          return oldCreation;
        }
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: currentTerminalId,
        });
      }
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
    });
    const props = {
      projectId,
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      sendCommand,
      subscribe: () => () => undefined,
      onClose: () => undefined,
    };
    const view = render(
      <TerminalPanel {...props} conversationId={firstConversationId} />,
    );
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.create"
      && sent.payload.conversationId === firstConversationId
    ))).toBe(true));
    view.rerender(
      <TerminalPanel {...props} conversationId={secondConversationId} />,
    );
    view.rerender(
      <TerminalPanel {...props} conversationId={firstConversationId} />,
    );
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", currentTerminalId));

    await act(async () => resolveOld({
      type: "terminal.created",
      requestId: crypto.randomUUID(),
      terminalId: oldTerminalId,
    }));
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close"
      && sent.payload.terminalId === oldTerminalId
    ))).toBe(true));
    expect(window.sessionStorage.getItem(
      `inertia:terminal-sessions:v1:${projectId}:${firstConversationId}`,
    )).toBe(JSON.stringify([currentTerminalId]));
  });
});
