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
      />
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

  it("retries an ambiguously delivered tab close after authoritative reattach", async () => {
    const terminalIds = [
      "63000000-0000-4000-8000-000000000001",
      "63000000-0000-4000-8000-000000000002",
    ];
    let createIndex = 0;
    let closeAttempts = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        const terminalId = terminalIds[createIndex++]!;
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "terminal.close") {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          throw new RuntimeCommandError(
            "The request took too long to complete.",
            "ambiguous",
          );
        }
        return { type: "request.ok", requestId: sent.requestId };
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
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      projectName: "Inertia",
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      sendCommand,
      subscribe: () => () => undefined,
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} status="online" />);
    await screen.findByRole("button", { name: "New terminal" });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    const close = await screen.findByRole("button", { name: "Close Terminal 2" });
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-id", terminalIds[1]));
    fireEvent.click(close);
    await waitFor(() => expect(closeAttempts).toBe(1));
    expect(close).toBeDisabled();

    view.rerender(<TerminalPanel {...props} status="offline" />);
    view.rerender(<TerminalPanel {...props} status="online" />);

    await waitFor(() => expect(closeAttempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole("tab", {
      name: "Terminal 2",
    })).toBeNull());
  });

  it("closes the replacement before retiring a tab with an in-flight close", async () => {
    const terminalId = "63500000-0000-4000-8000-000000000001";
    const replacementId = "63500000-0000-4000-8000-000000000002";
    let settleAction!: (event: ServerEvent) => void;
    let rejectOriginalClose!: (error: Error) => void;
    let settleReplacementClose!: (event: ServerEvent) => void;
    const action = new Promise<ServerEvent>((resolve) => { settleAction = resolve; });
    const originalClose = new Promise<ServerEvent>((_resolve, reject) => {
      rejectOriginalClose = reject;
    });
    const replacementClose = new Promise<ServerEvent>((resolve) => {
      settleReplacementClose = resolve;
    });
    const onClose = vi.fn();
    let originalCloseAttempts = 0;
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId,
        });
      }
      if (sent.type === "project.action.run") return action;
      if (sent.type === "terminal.close") {
        if (sent.payload.terminalId === terminalId) {
          originalCloseAttempts += 1;
          return originalCloseAttempts === 1
            ? originalClose
            : Promise.resolve({ type: "request.ok", requestId: sent.requestId });
        }
        return replacementClose;
      }
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
    });
    let view!: ReturnType<typeof render>;
    const panel = (actionId: string | null): React.JSX.Element => (
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        actionId={actionId}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onActionStarted={() => view.rerender(panel(null))}
        onClose={onClose}
      />
    );
    view = render(panel("check"));
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "project.action.run",
    )).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === terminalId
    ))).toBe(true));

    await act(async () => {
      settleAction({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId: replacementId,
      });
      await action;
    });
    await waitFor(() => expect(sendCommand.mock.calls.filter(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === replacementId
    ))).toHaveLength(1));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close Terminal 1" })).toBeDisabled();

    await act(async () => {
      settleReplacementClose({ type: "request.ok", requestId: crypto.randomUUID() });
      await replacementClose;
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close Terminal 1" })).toBeDisabled();

    await act(async () => {
      rejectOriginalClose(new RuntimeCommandError(
        "The terminal could not be confirmed stopped.",
        "rejected",
      ));
      await originalClose.catch(() => undefined);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The terminal could not be confirmed stopped.",
    );
    const retry = screen.getByRole("button", { name: "Close Terminal 1" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(originalCloseAttempts).toBe(2);
  });

  it("retries an ambiguous original close after its replacement exits", async () => {
    const terminalId = "63600000-0000-4000-8000-000000000001";
    const replacementId = "63600000-0000-4000-8000-000000000002";
    const listeners = new Set<(event: ServerEvent) => void>();
    let settleAction!: (event: ServerEvent) => void;
    const action = new Promise<ServerEvent>((resolve) => { settleAction = resolve; });
    let originalCloseAttempts = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "project.action.run") return action;
      if (sent.type === "terminal.close") {
        if (sent.payload.terminalId === terminalId && ++originalCloseAttempts > 1) {
          return { type: "request.ok", requestId: sent.requestId };
        }
        throw new RuntimeCommandError(
          "The request took too long to complete.",
          "ambiguous",
        );
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const onClose = vi.fn();
    let view!: ReturnType<typeof render>;
    const panel = (
      actionId: string | null,
      visible = true,
    ): React.JSX.Element => (
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible={visible}
        actionId={actionId}
        sendCommand={sendCommand}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        onActionStarted={() => view.rerender(panel(null))}
        onClose={onClose}
      />
    );
    view = render(panel("check"));
    onClose.mockImplementation(() => view.rerender(panel(null, false)));
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "project.action.run",
    )).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(originalCloseAttempts).toBe(1));

    await act(async () => {
      settleAction({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId: replacementId,
      });
      await action;
    });
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === replacementId
    ))).toBe(true));

    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.exit",
        terminalId: replacementId,
        exitCode: 0,
      });
    });

    await waitFor(() => expect(originalCloseAttempts).toBe(2));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("tab", {
      name: "Terminal 1",
    })).toBeNull());
  });

  it("retires an exited original when its in-flight action returns a replacement", async () => {
    const terminalId = "63700000-0000-4000-8000-000000000001";
    const replacementId = "63700000-0000-4000-8000-000000000002";
    const listeners = new Set<(event: ServerEvent) => void>();
    let settleAction!: (event: ServerEvent) => void;
    const action = new Promise<ServerEvent>((resolve) => { settleAction = resolve; });
    let originalCloseAttempts = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "project.action.run") return action;
      if (sent.type === "terminal.close") {
        if (sent.payload.terminalId === replacementId) {
          return { type: "request.ok", requestId: sent.requestId };
        }
        originalCloseAttempts += 1;
        throw new RuntimeCommandError(
          "The request took too long to complete.",
          "ambiguous",
        );
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const onClose = vi.fn();
    let view!: ReturnType<typeof render>;
    const panel = (
      actionId: string | null,
      visible = true,
    ): React.JSX.Element => (
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible={visible}
        actionId={actionId}
        sendCommand={sendCommand}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        onActionStarted={() => view.rerender(panel(null, visible))}
        onClose={onClose}
      />
    );
    view = render(panel("check"));
    onClose.mockImplementation(() => view.rerender(panel(null, false)));
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "project.action.run",
    )).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(originalCloseAttempts).toBe(1));

    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.exit",
        terminalId,
        exitCode: 0,
      });
      settleAction({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId: replacementId,
      });
      await action;
    });

    await waitFor(() => expect(sendCommand.mock.calls.filter(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === replacementId
    ))).toHaveLength(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(originalCloseAttempts).toBe(1);
    await waitFor(() => expect(screen.queryByRole("tab", {
      name: "Terminal 1",
    })).toBeNull());
  });

  it("retires an old terminal that exits after its replacement is current", async () => {
    const terminalId = "63750000-0000-4000-8000-000000000001";
    const replacementId = "63750000-0000-4000-8000-000000000002";
    const listeners = new Set<(event: ServerEvent) => void>();
    let settleAction!: (event: ServerEvent) => void;
    let settleReplacementClose!: (event: ServerEvent) => void;
    const action = new Promise<ServerEvent>((resolve) => { settleAction = resolve; });
    const replacementClose = new Promise<ServerEvent>((resolve) => {
      settleReplacementClose = resolve;
    });
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "project.action.run") return action;
      if (sent.type === "terminal.close") {
        if (sent.payload.terminalId === replacementId) return replacementClose;
        throw new RuntimeCommandError(
          "The request took too long to complete.",
          "ambiguous",
        );
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const onClose = vi.fn();
    let view!: ReturnType<typeof render>;
    const panel = (
      actionId: string | null,
      visible = true,
    ): React.JSX.Element => (
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible={visible}
        actionId={actionId}
        sendCommand={sendCommand}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        onActionStarted={() => view.rerender(panel(null, visible))}
        onClose={onClose}
      />
    );
    view = render(panel("check"));
    onClose.mockImplementation(() => view.rerender(panel(null, false)));
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "project.action.run",
    )).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === terminalId
    ))).toBe(true));

    await act(async () => {
      settleAction({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId: replacementId,
      });
      await action;
    });
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === replacementId
    ))).toBe(true));

    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.exit",
        terminalId,
        exitCode: 0,
      });
      settleReplacementClose({ type: "request.ok", requestId: crypto.randomUUID() });
      await replacementClose;
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("tab", {
      name: "Terminal 1",
    })).toBeNull());
  });

  it("fails a fifth unresolved replacement closed without evicting tracked terminals", async () => {
    const terminalIds = [
      "63770000-0000-4000-8000-000000000001",
      "63770000-0000-4000-8000-000000000002",
      "63770000-0000-4000-8000-000000000003",
      "63770000-0000-4000-8000-000000000004",
      "63770000-0000-4000-8000-000000000005",
    ];
    const listeners = new Set<(event: ServerEvent) => void>();
    let actionIndex = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId: terminalIds[0] };
      }
      if (sent.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
        };
      }
      if (sent.type === "project.action.run") {
        actionIndex += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: terminalIds[actionIndex]!,
        };
      }
      if (sent.type === "terminal.close") {
        throw new RuntimeCommandError("Close rejected.", "rejected");
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const onClose = vi.fn();
    const onActionStarted = vi.fn();
    let view!: ReturnType<typeof render>;
    const panel = (
      actionId: string | null,
      visible = true,
    ): React.JSX.Element => (
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible={visible}
        actionId={actionId}
        sendCommand={sendCommand}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        onActionStarted={() => {
          onActionStarted();
          window.queueMicrotask(() => view.rerender(panel(
            actionIndex < 4 ? `action-${actionIndex + 1}` : null,
            visible,
          )));
        }}
        onClose={onClose}
      />
    );
    view = render(panel(null));
    onClose.mockImplementation(() => view.rerender(panel(null, false)));
    const close = await screen.findByRole("button", { name: "Close Terminal 1" });
    fireEvent.click(close);
    await waitFor(() => expect(close).toBeEnabled());

    view.rerender(panel("action-1"));
    await waitFor(() => expect(actionIndex).toBe(4));
    await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === terminalIds[4]
    ))).toBe(true));
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(
      "inertia:terminal-sessions:v1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
    ) ?? "[]")).toEqual([terminalIds[3]]));
    expect(onActionStarted).toHaveBeenCalledTimes(4);

    await act(async () => {
      for (const terminalId of terminalIds.slice(0, 4)) {
        for (const listener of listeners) listener({
          type: "terminal.exit",
          terminalId,
          exitCode: 0,
        });
      }
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("tab", {
      name: "Terminal 1",
    })).toBeNull());
  });

  it("ignores a close settlement from a superseded panel owner", async () => {
    const terminalId = "63800000-0000-4000-8000-000000000001";
    let settleClose!: (event: ServerEvent) => void;
    const close = new Promise<ServerEvent>((resolve) => { settleClose = resolve; });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create" || sent.type === "terminal.attach") {
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId,
        });
      }
      if (sent.type === "terminal.close") return close;
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
      sendCommand,
      subscribe: () => () => undefined,
    };
    const oldOnClose = vi.fn();
    const oldPanel = render(<TerminalPanel {...props} onClose={oldOnClose} />);
    const oldClose = await screen.findByRole("button", { name: "Close Terminal 1" });
    fireEvent.click(oldClose);
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.close",
    )).toBe(true));
    oldPanel.unmount();

    const newOnClose = vi.fn();
    render(<TerminalPanel {...props} onClose={newOnClose} />);
    await screen.findByRole("button", { name: "Close Terminal 1" });
    await act(async () => {
      settleClose({ type: "request.ok", requestId: crypto.randomUUID() });
      await close;
    });

    expect(oldOnClose).not.toHaveBeenCalled();
    expect(newOnClose).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
  });

  it("persists a late close settlement without updating an unmounted panel", async () => {
    const terminalId = "63900000-0000-4000-8000-000000000001";
    let settleClose!: (event: ServerEvent) => void;
    const close = new Promise<ServerEvent>((resolve) => { settleClose = resolve; });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId,
        });
      }
      if (sent.type === "terminal.close") return close;
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
    });
    const onClose = vi.fn();
    const view = render(
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={onClose}
      />,
    );
    const closeButton = await screen.findByRole("button", {
      name: "Close Terminal 1",
    });
    fireEvent.click(closeButton);
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.close",
    )).toBe(true));
    view.unmount();

    await act(async () => {
      settleClose({ type: "request.ok", requestId: crypto.randomUUID() });
      await close;
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(
      "inertia:terminal-sessions:v1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
    )).toBeNull();
  });

  it("keeps a definitely rejected tab close visible and retryable", async () => {
    const terminalIds = [
      "64000000-0000-4000-8000-000000000001",
      "64000000-0000-4000-8000-000000000002",
    ];
    const listeners = new Set<(event: ServerEvent) => void>();
    let createIndex = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        const terminalId = terminalIds[createIndex++]!;
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "terminal.close") {
        throw new RuntimeCommandError(
          "The terminal could not be confirmed stopped.",
          "rejected",
        );
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
        sendCommand={sendCommand}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole("button", { name: "New terminal" });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    const close = await screen.findByRole("button", { name: "Close Terminal 2" });
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-id", terminalIds[1]));
    fireEvent.click(close);

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The terminal could not be confirmed stopped.",
    );
    expect(screen.getByRole("tab", { name: "Terminal 2" })).toBeVisible();
    expect(close).toBeEnabled();

    await act(async () => {
      for (const listener of listeners) listener({
        type: "terminal.exit",
        terminalId: terminalIds[1]!,
        exitCode: 0,
      });
    });
    await waitFor(() => expect(screen.queryByRole("tab", {
      name: "Terminal 2",
    })).toBeNull());
    expect(screen.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
