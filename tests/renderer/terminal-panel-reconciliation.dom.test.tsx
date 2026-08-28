import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
import {
  replaceTerminalTabWithoutHiding,
  type TerminalTab,
} from "../../src/renderer/src/components/TerminalPanelSupport";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";

const terminalState = vi.hoisted(() => ({
  textarea: null as HTMLTextAreaElement | null,
  onData: null as ((data: string) => void) | null,
  writes: [] as string[],
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
    options = { fontSize: 13, theme: {} };

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
    onData(callback: (data: string) => void): { dispose: () => void } {
      terminalState.onData = callback;
      return { dispose: () => undefined };
    }
    clear(): void {
      terminalState.writes = [];
    }
    writeln(data: string): void {
      terminalState.writes.push(data);
    }
    write(data: string): void {
      terminalState.writes.push(data);
    }
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

describe("TerminalPanel replacement reconciliation", () => {
  it("discards a concurrent empty tab before preserving a Darwin replacement shell", () => {
    const tabs: TerminalTab[] = [
      { id: "source", label: "Terminal 1", terminalId: "60000000-0000-4000-8000-000000000001" },
      { id: "live", label: "Terminal 2", terminalId: "60000000-0000-4000-8000-000000000002" },
      { id: "empty", label: "Terminal 3", terminalId: null },
      { id: "other", label: "Terminal 4", terminalId: "60000000-0000-4000-8000-000000000004" },
    ];

    const result = replaceTerminalTabWithoutHiding(
      tabs,
      "source",
      "60000000-0000-4000-8000-000000000001",
      "60000000-0000-4000-8000-000000000005",
      true,
    );

    expect(result).toHaveLength(4);
    expect(result?.some(({ id }) => id === "empty")).toBe(false);
    expect(result?.map(({ terminalId }) => terminalId)).toEqual([
      "60000000-0000-4000-8000-000000000005",
      "60000000-0000-4000-8000-000000000002",
      "60000000-0000-4000-8000-000000000004",
      "60000000-0000-4000-8000-000000000001",
    ]);
  });

  beforeEach(() => {
    terminalState.textarea = null;
    terminalState.onData = null;
    terminalState.writes = [];
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

  it("reconciles an ambiguously delivered action to its distinct Darwin terminal", async () => {
    const terminalId = "60000000-0000-4000-8000-000000000001";
    const replacementId = "60000000-0000-4000-8000-000000000002";
    const listeners = new Set<(event: ServerEvent) => void>();
    let actionRequestId = "";
    let settleAttach!: (event: ServerEvent) => void;
    const exactAttach = new Promise<ServerEvent>((resolve) => { settleAttach = resolve; });
    let created = false;
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created = true;
        return Promise.resolve({ type: "terminal.created", requestId: sent.requestId, terminalId });
      }
      if (sent.type === "project.action.run") {
        actionRequestId = sent.requestId;
        return Promise.reject(new RuntimeCommandError(
          "The request took too long to complete.",
          "ambiguous",
        ));
      }
      if (sent.type === "terminal.attach") {
        if (sent.payload.replacementRequestId) return exactAttach;
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
        });
      }
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
    });
    const props = {
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      onActionStarted: vi.fn(),
      sendCommand,
      subscribe: (listener: (event: ServerEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose: () => undefined,
    };
    render(
      <TerminalPanel
        {...props}
        actionId="check"
      />,
    );

    await waitFor(() => expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "project.action.run",
    )).toHaveLength(1));
    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.created",
        requestId: actionRequestId,
        terminalId: replacementId,
      });
    });
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.attach"
        && sent.payload.replacementRequestId === actionRequestId,
    )).toBe(true));
    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.created",
        requestId: actionRequestId,
        terminalId: replacementId,
      });
    });
    expect(sendCommand.mock.calls.filter(([sent]) => (
      sent.type === "terminal.attach"
      && sent.payload.replacementRequestId === actionRequestId
    ))).toHaveLength(1);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    await act(async () => {
      settleAttach({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId: replacementId,
      });
      await exactAttach;
    });
    expect(created).toBe(true);
    expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "project.action.run",
    )).toHaveLength(1);
    expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "terminal.create",
    )).toHaveLength(1);
    expect(sendCommand.mock.calls.find(
      ([sent]) => sent.type === "terminal.attach",
    )?.[0]).toMatchObject({
      type: "terminal.attach",
      payload: { terminalId, replacementRequestId: expect.any(String) },
    });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(document.querySelector('[role="tabpanel"]:not([hidden]) .terminal-panel'))
      .toHaveAttribute("data-terminal-id", replacementId);
    expect(screen.queryByText(/request took too long|may still be running/iu)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-id", terminalId));
  });

  it("falls back to the preserved terminal when exact action reconciliation is not recorded", async () => {
    const terminalId = "60500000-0000-4000-8000-000000000001";
    const listeners = new Set<(event: ServerEvent) => void>();
    let actionRequestId = "";
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "project.action.run") {
        actionRequestId = sent.requestId;
        throw new RuntimeCommandError("The request took too long to complete.", "ambiguous");
      }
      if (sent.type === "terminal.attach" && sent.payload.replacementRequestId) {
        throw new RuntimeCommandError("Terminal replacement not found.", "rejected");
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
    render(
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        actionId="check"
        sendCommand={sendCommand}
        subscribe={(listener) => { listeners.add(listener); return () => listeners.delete(listener); }}
        onActionStarted={() => undefined}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(actionRequestId).not.toBe(""));
    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.created",
        requestId: actionRequestId,
        terminalId,
      });
    });
    await waitFor(() => expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "terminal.attach",
    )).toHaveLength(2));
    expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "terminal.create",
    )).toHaveLength(1);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId);
  });

  it("reconciles an ambiguously delivered provider resume to its distinct Darwin terminal", async () => {
    const terminalId = "61000000-0000-4000-8000-000000000001";
    const replacementId = "61000000-0000-4000-8000-000000000002";
    const sessionId = "62000000-0000-4000-8000-000000000001";
    const listeners = new Set<(event: ServerEvent) => void>();
    let resumeRequestId = "";
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "terminal.provider.resume") {
        resumeRequestId = sent.requestId;
        throw new RuntimeCommandError("The request took too long to complete.", "ambiguous");
      }
      if (sent.type === "terminal.attach") {
        if (sent.payload.replacementRequestId) {
          return {
            type: "terminal.created",
            requestId: sent.requestId,
            terminalId: replacementId,
            providerResumeConversationId: "22222222-2222-4222-8222-222222222222",
            providerResume: { providerId: "claude", providerLabel: "Claude", sessionId },
          };
        }
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    render(
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        providerResume={{ kind: "available", resume: {
          providerId: "claude", providerLabel: "Claude", sessionId,
        }, reason: null }}
        sendCommand={sendCommand}
        subscribe={(listener) => { listeners.add(listener); return () => listeners.delete(listener); }}
        onClose={() => undefined}
      />,
    );

    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);

    await waitFor(() => expect(resumeRequestId).not.toBe(""));
    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.created",
        requestId: resumeRequestId,
        terminalId: replacementId,
        providerResumeConversationId: "22222222-2222-4222-8222-222222222222",
        providerResume: { providerId: "claude", providerLabel: "Claude", sessionId },
      });
    });
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(sendCommand.mock.calls.find(
      ([sent]) => sent.type === "terminal.attach" && sent.payload.replacementRequestId,
    )?.[0]).toMatchObject({
      type: "terminal.attach",
      payload: { terminalId, replacementRequestId: resumeRequestId },
    });
    expect(document.querySelector('[role="tabpanel"]:not([hidden]) .terminal-panel'))
      .toHaveAttribute("data-terminal-id", replacementId);
    expect(screen.getByRole("button", {
      name: "Claude session is resumed in Inertia",
    })).toBeDisabled();
    expect(screen.queryByText(/request took too long|could not resume/iu)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-id", terminalId));
  });
});
