import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
import {
  replaceTerminalTabWithoutHiding,
  type TerminalTab,
} from "../../src/renderer/src/components/TerminalPanelSupport";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import type {
  ClientCommand,
  ProviderTerminalResumeAvailability,
  ServerEvent,
} from "../../src/shared/contracts";

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

describe("TerminalPanel focus lifecycle", () => {
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

  it("reattaches a bounded persisted terminal before creating a new shell", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:${conversationId}`,
      JSON.stringify([terminalId]),
    );
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        conversationId={conversationId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId));
    expect(sendCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "terminal.attach",
      payload: { projectId, conversationId, terminalId, cols: 80, rows: 24 },
    });
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.create"))
      .toBe(false);
  });

  it("keeps one bounded replay when an ambiguous reattach succeeds on retry", async () => {
    vi.useFakeTimers();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([terminalId]),
    );
    const listeners = new Set<(event: ServerEvent) => void>();
    let attempts = 0;
    let settleSecond!: (event: ServerEvent) => void;
    const secondResult = new Promise<ServerEvent>((resolve) => {
      settleSecond = resolve;
    });
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type !== "terminal.attach") {
        return { type: "request.ok", requestId: sent.requestId };
      }
      attempts += 1;
      for (const listener of listeners) {
        listener({ type: "terminal.output", terminalId, data: "restored output" });
      }
      if (attempts === 1) {
        throw new RuntimeCommandError("The request took too long to complete.", "ambiguous");
      }
      return await secondResult;
    });

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={(next) => {
          listeners.add(next);
          return () => listeners.delete(next);
        }}
        onClose={() => undefined}
      />,
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await act(async () => {
      settleSecond({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId,
      });
      await secondResult;
    });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();

    expect(attempts).toBe(2);
    await waitFor(() => expect(terminalState.writes).toEqual(["restored output"]));
  });

  it("does not trust duplicate persisted terminal identities", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([terminalId, terminalId]),
    );
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => (
      sent.type === "terminal.create"
        ? { type: "terminal.created", requestId: sent.requestId, terminalId }
        : { type: "request.ok", requestId: sent.requestId }
    ));

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(sendCommand).toHaveBeenCalled());
    expect(sendCommand.mock.calls.filter(([sent]) => sent.type === "terminal.attach"))
      .toHaveLength(0);
    expect(sendCommand.mock.calls.filter(([sent]) => sent.type === "terminal.create"))
      .toHaveLength(1);
  });

  it("does not send terminal input until reattach ownership is confirmed", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([terminalId]),
    );
    let settle!: (event: ServerEvent) => void;
    const pending = new Promise<ServerEvent>((resolve) => { settle = resolve; });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => (
      sent.type === "terminal.attach"
        ? pending
        : Promise.resolve({ type: "request.ok", requestId: sent.requestId })
    ));

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(terminalState.onData).not.toBeNull());
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-state", "starting");
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("aria-busy", "true");
    terminalState.onData?.("pwd\r");
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.input"))
      .toBe(false);

    settle({ type: "terminal.created", requestId: crypto.randomUUID(), terminalId });
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-state", "ready"));
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("aria-busy", "false");
    terminalState.onData?.("pwd\r");
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.input",
    )).toBe(true));
  });

  it("creates once after the server authoritatively rejects a stale persisted terminal", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const staleId = "44444444-4444-4444-8444-444444444444";
    const replacementId = "55555555-5555-4555-8555-555555555555";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([staleId]),
    );
    const sentTypes: string[] = [];
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      sentTypes.push(sent.type);
      if (sent.type === "terminal.attach") {
        throw new RuntimeCommandError("Terminal not found.", "rejected");
      }
      if (sent.type === "terminal.create") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: replacementId,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", replacementId));
    expect(sentTypes.slice(0, 2)).toEqual(["terminal.attach", "terminal.create"]);
  });

  it("retries an in-progress replacement before one authoritative fallback", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const staleId = "44444444-4444-4444-8444-444444444444";
    const replacementId = "55555555-5555-4555-8555-555555555555";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([staleId]),
    );
    let attachAttempts = 0;
    const sentTypes: string[] = [];
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      sentTypes.push(sent.type);
      if (sent.type === "terminal.attach") {
        attachAttempts += 1;
        throw new RuntimeCommandError(
          attachAttempts === 1
            ? "The terminal process is still stopping. Retry reconnecting."
            : "Terminal not found.",
          "rejected",
        );
      }
      if (sent.type === "terminal.create") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: replacementId,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", replacementId), { timeout: 2_000 });
    expect(sentTypes.slice(0, 3)).toEqual([
      "terminal.attach",
      "terminal.attach",
      "terminal.create",
    ]);
    expect(sendCommand.mock.calls.filter(([sent]) => sent.type === "terminal.create"))
      .toHaveLength(1);
  });

  it("never discards a stable terminal while replacement remains in progress", async () => {
    vi.useFakeTimers();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([terminalId]),
    );
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.attach") {
        throw new RuntimeCommandError(
          "The terminal process is still stopping. Retry reconnecting.",
          "rejected",
        );
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    await act(async () => Promise.resolve());
    for (const delay of [400, 900, 900]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }

    expect(sendCommand.mock.calls.filter(([sent]) => sent.type === "terminal.attach"))
      .toHaveLength(4);
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.create"))
      .toBe(false);
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId);
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-state", "error");
  });

  it("reattaches a healthy replacement that settles after the Windows deadline", async () => {
    vi.useFakeTimers();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([terminalId]),
    );
    let attempts = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.attach") {
        attempts += 1;
        if (attempts < 4) {
          throw new RuntimeCommandError(
            "The terminal process is still stopping. Retry reconnecting.",
            "rejected",
          );
        }
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    await act(async () => Promise.resolve());
    for (const delay of [400, 900, 900]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }

    expect(attempts).toBe(4);
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.create"))
      .toBe(false);
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId);
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-state", "ready");
  });

  it("retains a failed-retirement terminal identity for authoritative cleanup", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([terminalId]),
    );
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.attach") {
        throw new RuntimeCommandError(
          "A terminal process ownership claim could not be retired during runtime shutdown.",
          "rejected",
        );
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-state", "error"));
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId);
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.create"))
      .toBe(false);
  });

  it("preserves a live terminal across an offline reconnect without closing it", async () => {
    const terminalId = "11111111-1111-4111-8111-111111111111";
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create" || sent.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const panel = (status: "online" | "offline") => (
      <TerminalPanel
        projectId="project-1"
        projectName="Inertia"
        status={status}
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />
    );
    const view = render(panel("online"));
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId));

    view.rerender(panel("offline"));
    await act(async () => Promise.resolve());
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.close"))
      .toBe(false);
    view.rerender(panel("online"));
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.attach",
    )).toBe(true));
    expect(sendCommand.mock.calls.filter(([sent]) => sent.type === "terminal.create"))
      .toHaveLength(1);
  });

  it("never creates a duplicate after an ambiguously delivered reattach", async () => {
    vi.useFakeTimers();
    const projectId = "11111111-1111-4111-8111-111111111111";
    const terminalId = "33333333-3333-4333-8333-333333333333";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
      JSON.stringify([terminalId]),
    );
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.attach") {
        throw new RuntimeCommandError(
          "The request took too long to complete.",
          "ambiguous",
        );
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await act(async () => vi.advanceTimersByTimeAsync(900));

    expect(sendCommand.mock.calls.filter(([sent]) => sent.type === "terminal.attach"))
      .toHaveLength(3);
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.create"))
      .toBe(false);
    expect(screen.getByText("The request took too long to complete."))
      .toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      `inertia:terminal-sessions:v1:${projectId}:project`,
    )).toContain(terminalId);
  });

  it("preserves a terminal on page teardown but closes it on an ordinary unmount", async () => {
    const terminalId = "11111111-1111-4111-8111-111111111111";
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const props = {
      projectId: "project-1",
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      sendCommand,
      subscribe: () => () => undefined,
      onClose: () => undefined,
    };
    const reloading = render(<TerminalPanel {...props} />);
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId));
    fireEvent(window, new Event("pagehide"));
    reloading.unmount();
    await act(async () => Promise.resolve());
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.close"))
      .toBe(false);
    expect(window.sessionStorage.getItem(
      "inertia:terminal-sessions:v1:project-1:project",
    )).toContain(terminalId);

    window.sessionStorage.clear();
    sendCommand.mockClear();
    const navigating = render(<TerminalPanel {...props} />);
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", terminalId));
    navigating.unmount();
    await act(async () => Promise.resolve());
    expect(sendCommand.mock.calls.some(([sent]) => (
      sent.type === "terminal.close" && sent.payload.terminalId === terminalId
    ))).toBe(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a terminal twice when creation loses the transport before delivery", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type !== "terminal.create") {
        return { type: "request.ok", requestId: sent.requestId };
      }
      attempts += 1;
      if (attempts < 3) {
        throw new RuntimeCommandError("The local service is reconnecting.", "not-sent");
      }
      return {
        type: "terminal.created",
        requestId: sent.requestId,
        terminalId: "11111111-1111-4111-8111-111111111111",
      };
    });

    render(
      <TerminalPanel
        projectId="project-1"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    await act(async () => Promise.resolve());
    expect(attempts).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(attempts).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(attempts).toBe(3);
    expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", "11111111-1111-4111-8111-111111111111");
  });

  it("does not retry an ambiguously delivered terminal creation", async () => {
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        throw new RuntimeCommandError("The request took too long to complete.", "ambiguous");
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId="project-1"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("The request took too long to complete."))
      .toBeInTheDocument();
    expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "terminal.create",
    )).toHaveLength(1);
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

  it("shows the exact provider session and sends only owning resume identifiers", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const providerResume: ProviderTerminalResumeAvailability = {
      kind: "available",
      resume: {
        providerId: "claude",
        providerLabel: "Claude",
        sessionId,
      },
      reason: null,
    };
    const authoritativeSessionId = "44444444-4444-4444-8444-444444444444";
    let created = 0;
    const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => {
      if (command.type === "terminal.create" || command.type === "terminal.provider.resume") {
        created += 1;
        const terminalId = `${created}0000000-0000-4000-8000-000000000000`;
        if (command.type === "terminal.provider.resume") {
          return {
            type: "terminal.created",
            requestId: command.requestId,
            terminalId,
            providerResumeConversationId: command.payload.conversationId,
            providerResume: {
              providerId: "claude",
              providerLabel: "Claude",
              sessionId: authoritativeSessionId,
            },
          };
        }
        return {
          type: "terminal.created",
          requestId: command.requestId,
          terminalId,
        };
      }
      if (command.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: command.requestId,
          terminalId: command.payload.terminalId,
        };
      }
      return { type: "request.ok", requestId: command.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        conversationId={conversationId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        providerResume={providerResume}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText(sessionId, { selector: "code" })).toBeVisible();
    const resumeButton = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resumeButton).toBeEnabled());
    fireEvent.click(resumeButton);

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal.provider.resume" }),
    ));
    const resumeCommand = sendCommand.mock.calls
      .map(([sent]) => sent)
      .find((sent) => sent.type === "terminal.provider.resume");
    expect(resumeCommand).toEqual({
      type: "terminal.provider.resume",
      requestId: expect.any(String),
      payload: {
        projectId,
        conversationId,
        terminalId: "10000000-0000-4000-8000-000000000000",
        cols: 80,
        rows: 24,
      },
    });
    expect(JSON.stringify(resumeCommand)).not.toContain(sessionId);
    expect(JSON.stringify(resumeCommand)).not.toContain("prompt");
    expect(JSON.stringify(resumeCommand)).not.toContain("executable");
    expect(JSON.stringify(resumeCommand)).not.toContain("credential");
    expect(await screen.findByText(authoritativeSessionId, { selector: "code" })).toBeVisible();
    expect(screen.getByText(sessionId, { selector: "code" })).not.toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Terminal 1" }))
      .toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-state", "ready"));
    expect(document.querySelector('[role="tabpanel"]:not([hidden]) .terminal-panel'))
      .toHaveAttribute("data-terminal-id", "10000000-0000-4000-8000-000000000000");
  });

  it("can resume any provider chat from the terminal's current directory", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const otherProjectId = "33333333-3333-4333-8333-333333333333";
    const otherConversationId = "44444444-4444-4444-8444-444444444444";
    let created = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: "55555555-5555-4555-8555-555555555555",
        };
      }
      if (sent.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: "66666666-6666-4666-8666-666666666666",
          providerResumeConversationId: sent.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "77777777-7777-4777-8777-777777777777",
          },
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });

    render(
      <TerminalPanel
        projectId={projectId}
        conversationId={conversationId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        providerResumes={[
          {
            projectId,
            projectName: "Inertia",
            conversationId,
            conversationTitle: "Current chat",
            availability: {
              kind: "available",
              resume: {
                providerId: "claude",
                providerLabel: "Claude",
                sessionId: "88888888-8888-4888-8888-888888888888",
              },
              reason: null,
            },
          },
          {
            projectId: otherProjectId,
            projectName: "Shared checkout",
            conversationId: otherConversationId,
            conversationTitle: "Earlier investigation",
            availability: {
              kind: "available",
              resume: {
                providerId: "claude",
                providerLabel: "Claude",
                sessionId: "99999999-9999-4999-8999-999999999999",
              },
              reason: null,
            },
          },
        ]}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    const picker = await screen.findByRole("button", {
      name: "Chat to resume: Current chat in Inertia",
    });
    expect(picker).toHaveTextContent("Current chat");
    fireEvent.click(picker);
    const search = await screen.findByRole("searchbox", {
      name: "Search resumable chats",
    });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(picker).toHaveFocus());
    fireEvent.click(picker);
    const options = await screen.findByRole("listbox", {
      name: "Resumable provider chats",
    });
    expect(options).toHaveTextContent("Current chat");
    expect(options).toHaveTextContent("Earlier investigation");
    fireEvent.click(screen.getByRole("option", { name: /Earlier investigation/u }));
    await waitFor(() => expect(picker).toHaveFocus());
    expect(picker).toHaveAccessibleName(
      "Chat to resume: Earlier investigation in Shared checkout",
    );
    const resume = await screen.findByRole("button", {
      name: "Resume Claude chat Earlier investigation in Shared checkout",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "terminal.provider.resume",
      payload: expect.objectContaining({
        projectId: otherProjectId,
        conversationId: otherConversationId,
        terminalId: "55555555-5555-4555-8555-555555555555",
      }),
    })));
    expect(created).toBe(1);
  });

  it("accepts the same composer resume request again after its parent clears it", async () => {
    const conversationId = "22222222-2222-4222-8222-222222222222";
    let resumeAttempts = 0;
    const onResumeRequestHandled = vi.fn();
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: "55555555-5555-4555-8555-555555555555",
        };
      }
      if (sent.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        resumeAttempts += 1;
        if (resumeAttempts === 1) throw new Error("Provider was temporarily busy.");
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: "66666666-6666-4666-8666-666666666666",
          providerResumeConversationId: sent.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "77777777-7777-4777-8777-777777777777",
          },
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const props = {
      projectId: "11111111-1111-4111-8111-111111111111",
      conversationId,
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      providerResumes: [{
        projectId: "11111111-1111-4111-8111-111111111111",
        projectName: "Inertia",
        conversationId,
        conversationTitle: "Current chat",
        availability: {
          kind: "available" as const,
          resume: {
            providerId: "claude" as const,
            providerLabel: "Claude",
            sessionId: "88888888-8888-4888-8888-888888888888",
          },
          reason: null,
        },
      }],
      sendCommand,
      subscribe: () => () => undefined,
      onResumeRequestHandled,
      onClose: () => undefined,
    };
    const view = render(
      <TerminalPanel {...props} resumeRequestConversationId={conversationId} />,
    );

    await waitFor(() => expect(resumeAttempts).toBe(1));
    expect(onResumeRequestHandled).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Provider was temporarily busy."))
      .toBeVisible();

    view.rerender(<TerminalPanel {...props} resumeRequestConversationId={null} />);
    view.rerender(
      <TerminalPanel {...props} resumeRequestConversationId={conversationId} />,
    );
    await waitFor(() => expect(resumeAttempts).toBe(2));
    expect(onResumeRequestHandled).toHaveBeenCalledTimes(2);
  });

  it("explains unsupported or stale sessions without exposing a resume action", async () => {
    const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => ({
      type: "terminal.created",
      requestId: command.requestId,
      terminalId: "44444444-4444-4444-8444-444444444444",
    }));
    render(
      <TerminalPanel
        projectId="11111111-1111-4111-8111-111111111111"
        conversationId="22222222-2222-4222-8222-222222222222"
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        providerResume={{
          kind: "unavailable",
          resume: {
            providerId: "cursor",
            providerLabel: "Cursor",
            sessionId: "33333333-3333-4333-8333-333333333333",
          },
          reason: "This installed Cursor version cannot resume its ACP session ID.",
        }}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText(
      "This installed Cursor version cannot resume its ACP session ID.",
    )).toBeVisible();
    expect(screen.queryByRole("button", {
      name: "Resume Cursor session in Inertia",
    })).toBeNull();
  });

  it("locks restart during discovery, uses the authoritative response, and does not steal focus", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    let completeResume!: (event: ServerEvent) => void;
    const sendCommand = vi.fn((command: ClientCommand): Promise<ServerEvent> => {
      if (command.type === "terminal.provider.resume") {
        return new Promise((resolve) => {
          completeResume = resolve;
        });
      }
      return Promise.resolve({
        type: "terminal.created",
        requestId: command.requestId,
        terminalId: "66666666-6666-4666-8666-666666666666",
      });
    });
    render(
      <>
        <button type="button">Composer</button>
        <TerminalPanel
          projectId="11111111-1111-4111-8111-111111111111"
          conversationId="22222222-2222-4222-8222-222222222222"
          projectName="Inertia"
          status="online"
          fontSize={13}
          theme="dark"
          visible
          providerResume={{
            kind: "available",
            resume: {
              providerId: "claude",
              providerLabel: "Claude",
              sessionId,
            },
            reason: null,
          }}
          sendCommand={sendCommand}
          subscribe={() => () => undefined}
          onClose={() => undefined}
        />
      </>,
    );

    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeDisabled();
    const composer = screen.getByRole("button", { name: "Composer" });
    composer.focus();

    await act(async () => {
      completeResume({
        type: "terminal.created",
        requestId: "77777777-7777-4777-8777-777777777777",
        terminalId: "88888888-8888-4888-8888-888888888888",
        providerResumeConversationId: "22222222-2222-4222-8222-222222222222",
        providerResume: {
          providerId: "claude",
          providerLabel: "Claude",
          sessionId: "99999999-9999-4999-8999-999999999999",
        },
      });
      await Promise.resolve();
    });

    expect(composer).toHaveFocus();
    expect(screen.getByText("99999999-9999-4999-8999-999999999999", {
      selector: "code",
    })).toBeVisible();
    expect(screen.getByRole("button", { name: "Restart terminal" })).toBeEnabled();
  });

  it("retains same-ID provider startup output emitted before resume settles", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const terminalId = "33333333-3333-4333-8333-333333333333";
    const listeners = new Set<(event: ServerEvent) => void>();
    let settleResume!: (event: ServerEvent) => void;
    const resumed = new Promise<ServerEvent>((resolve) => {
      settleResume = resolve;
    });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId,
        });
      }
      if (sent.type === "terminal.provider.resume") return resumed;
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
    });
    render(
      <TerminalPanel
        projectId={projectId}
        conversationId={conversationId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        providerResume={{
          kind: "available",
          resume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "44444444-4444-4444-8444-444444444444",
          },
          reason: null,
        }}
        sendCommand={sendCommand}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        onClose={() => undefined}
      />,
    );

    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.provider.resume",
    )).toBe(true));
    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "terminal.output",
          terminalId,
          data: "provider startup prompt",
        });
      }
    });
    expect(terminalState.writes).not.toContain("provider startup prompt");

    await act(async () => {
      settleResume({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId,
        providerResume: {
          providerId: "claude",
          providerLabel: "Claude",
          sessionId: "55555555-5555-4555-8555-555555555555",
        },
        providerResumeConversationId: conversationId,
      });
      await resumed;
    });
    await waitFor(() => expect(terminalState.writes.filter(
      (value) => value === "provider startup prompt",
    )).toHaveLength(1));
  });

  it("reconciles a zero-output provider exit that precedes a distinct resume response", async () => {
    const originalId = "33333333-3333-4333-8333-333333333333";
    const replacementId = "44444444-4444-4444-8444-444444444444";
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const listeners = new Set<(event: ServerEvent) => void>();
    let settleResume!: (event: ServerEvent) => void;
    const resumed = new Promise<ServerEvent>((resolve) => { settleResume = resolve; });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return Promise.resolve({ type: "terminal.created", requestId: sent.requestId, terminalId: originalId });
      }
      if (sent.type === "terminal.provider.resume") return resumed;
      if (sent.type === "terminal.attach") {
        return Promise.resolve({ type: "terminal.created", requestId: sent.requestId, terminalId: sent.payload.terminalId });
      }
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
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
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.provider.resume",
    )).toBe(true));
    await act(async () => {
      for (const listener of listeners) {
        listener({ type: "terminal.exit", terminalId: replacementId, exitCode: 9 });
      }
      settleResume({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId: replacementId,
        providerResumeConversationId: "22222222-2222-4222-8222-222222222222",
        providerResume: { providerId: "claude", providerLabel: "Claude", sessionId },
      });
      await resumed;
    });

    expect(await screen.findByText(
      `Claude could not resume session ${sessionId}. The saved session may be stale or unavailable; review the provider output above.`,
    )).toBeVisible();
    expect(screen.getByRole("button", { name: "Start again" })).toBeVisible();
    expect(document.querySelector(`[data-terminal-id="${replacementId}"]`)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-state", "ready"));
  });

  it("keeps the original terminal visible when a distinct resume races the tab limit", async () => {
    const terminalIds = Array.from(
      { length: 4 },
      (_, index) => `${index + 1}0000000-0000-4000-8000-000000000000`,
    );
    const replacementId = "90000000-0000-4000-8000-000000000000";
    let created = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        const terminalId = terminalIds[created++];
        if (!terminalId) throw new Error("unexpected terminal creation");
        return { type: "terminal.created", requestId: sent.requestId, terminalId };
      }
      if (sent.type === "terminal.attach") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: replacementId,
          providerResumeConversationId: sent.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
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
          providerId: "claude", providerLabel: "Claude",
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }, reason: null }}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    for (let count = 2; count <= 4; count += 1) {
      await waitFor(() => expect(screen.getByRole("button", { name: "New terminal" }))
        .toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(count));
    }
    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);

    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.close"
        && sent.payload.terminalId === replacementId,
    )).toBe(true));
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-id", terminalIds[3]));
    expect(document.querySelector(`[data-terminal-id="${replacementId}"]`)).toBeNull();
    expect(await screen.findByText(
      "The provider could not open because the terminal tab limit was reached.",
    )).toBeVisible();
  });

  it("creates a usable local shell after provider replacement teardown fails", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const originalId = "33333333-3333-4333-8333-333333333333";
    const replacementId = "44444444-4444-4444-8444-444444444444";
    let creates = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        creates += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: creates === 1 ? originalId : replacementId,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        throw new RuntimeCommandError(
          "Unable to start the provider terminal.",
          "rejected",
        );
      }
      if (sent.type === "terminal.attach") {
        throw new RuntimeCommandError("Terminal not found.", "rejected");
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    render(
      <TerminalPanel
        projectId={projectId}
        conversationId={conversationId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        providerResume={{
          kind: "available",
          resume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "55555555-5555-4555-8555-555555555555",
          },
          reason: null,
        }}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);

    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", replacementId));
    expect(sendCommand.mock.calls.map(([sent]) => sent.type).filter((type) => (
      type !== "terminal.resize"
    )).slice(0, 4))
      .toEqual([
        "terminal.create",
        "terminal.provider.resume",
        "terminal.attach",
        "terminal.create",
      ]);
    expect(await screen.findByText("Unable to start the provider terminal."))
      .toBeVisible();
    terminalState.onData?.("pwd\r");
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.input"
        && sent.payload.terminalId === replacementId,
    )).toBe(true));
  });

  it("explains a nonzero provider exit as a possibly stale saved session", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const listeners = new Set<(event: ServerEvent) => void>();
    let created = 0;
    const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => {
      if (command.type === "terminal.create") {
        return {
          type: "terminal.created",
          requestId: command.requestId,
          terminalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        };
      }
      if (command.type === "terminal.provider.resume") {
        created += 1;
        return {
          type: "terminal.created",
          requestId: command.requestId,
          terminalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          providerResumeConversationId: command.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId,
          },
        };
      }
      return { type: "request.ok", requestId: command.requestId };
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
        providerResume={{
          kind: "available",
          resume: { providerId: "claude", providerLabel: "Claude", sessionId },
          reason: null,
        }}
        sendCommand={sendCommand}
        subscribe={(next) => {
          listeners.add(next);
          return () => listeners.delete(next);
        }}
        onClose={() => undefined}
      />,
    );

    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);
    await waitFor(() => expect(created).toBe(1));
    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "terminal.exit",
          terminalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          exitCode: 1,
        });
      }
    });

    expect(await screen.findByText(
      `Claude could not resume session ${sessionId}. The saved session may be stale or unavailable; review the provider output above.`,
    )).toBeVisible();
    expect(screen.getByRole("button", { name: "Start again" })).toBeVisible();
  });

  it("shares resumed-session ownership across sibling terminal tabs", async () => {
    const listeners = new Set<(event: ServerEvent) => void>();
    let created = 0;
    const resumedTerminalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: `${created}0000000-0000-4000-8000-000000000000`,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: resumedTerminalId,
          providerResumeConversationId: sent.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          },
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
        providerResume={{
          kind: "available",
          resume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          },
          reason: null,
        }}
        sendCommand={sendCommand}
        subscribe={(listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }}
        onClose={() => undefined}
      />,
    );

    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Claude session is resumed in Inertia",
    })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    const siblingResume = await screen.findByRole("button", {
      name: "Claude session is resumed in another Inertia terminal",
    });
    expect(siblingResume).toBeDisabled();
    expect(siblingResume).toHaveTextContent("Resumed elsewhere");
    fireEvent.click(siblingResume);
    expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "terminal.provider.resume",
    )).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.close"
        && sent.payload.terminalId === resumedTerminalId,
    )).toBe(true));
    expect(screen.getByRole("button", {
      name: "Claude session is resumed in another Inertia terminal",
    })).toBeDisabled();

    await act(async () => {
      for (const listener of listeners) {
        listener({
          type: "terminal.exit",
          terminalId: resumedTerminalId,
          exitCode: 0,
        });
      }
    });
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Resume Claude session in Inertia",
    })).toBeEnabled());
  });

  it("allows sibling terminals to resume different chats from one directory", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const primaryConversationId = "22222222-2222-4222-8222-222222222222";
    const secondaryConversationId = "33333333-3333-4333-8333-333333333333";
    let created = 0;
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: `${created}0000000-0000-4000-8000-000000000000`,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        const secondary = sent.payload.conversationId === secondaryConversationId;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: secondary
            ? "44444444-4444-4444-8444-444444444444"
            : "55555555-5555-4555-8555-555555555555",
          providerResumeConversationId: sent.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: secondary
              ? "66666666-6666-4666-8666-666666666666"
              : "77777777-7777-4777-8777-777777777777",
          },
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const providerResumes = [
      {
        projectId,
        projectName: "Inertia",
        conversationId: primaryConversationId,
        conversationTitle: "Primary chat",
        availability: {
          kind: "available" as const,
          resume: {
            providerId: "claude" as const,
            providerLabel: "Claude",
            sessionId: "77777777-7777-4777-8777-777777777777",
          },
          reason: null,
        },
      },
      {
        projectId,
        projectName: "Inertia",
        conversationId: secondaryConversationId,
        conversationTitle: "Secondary chat",
        availability: {
          kind: "available" as const,
          resume: {
            providerId: "claude" as const,
            providerLabel: "Claude",
            sessionId: "66666666-6666-4666-8666-666666666666",
          },
          reason: null,
        },
      },
    ];

    render(
      <TerminalPanel
        projectId={projectId}
        conversationId={primaryConversationId}
        projectName="Inertia"
        status="online"
        fontSize={13}
        theme="dark"
        visible
        providerResumes={providerResumes}
        sendCommand={sendCommand}
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );

    const primaryResume = await screen.findByRole("button", {
      name: "Resume Claude chat Primary chat in Inertia",
    });
    await waitFor(() => expect(primaryResume).toBeEnabled());
    fireEvent.click(primaryResume);
    await waitFor(() => expect(primaryResume).toHaveTextContent("Resumed"));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(await screen.findByRole("button", {
      name: "Claude session is resumed in another Inertia terminal",
    })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Chat to resume:/u }));
    fireEvent.click(await screen.findByRole("option", { name: /Secondary chat/u }));
    const secondaryResume = await screen.findByRole("button", {
      name: "Resume Claude chat Secondary chat in Inertia",
    });
    expect(secondaryResume).toBeEnabled();
    fireEvent.click(secondaryResume);

    await waitFor(() => expect(sendCommand.mock.calls
      .map(([sent]) => sent)
      .filter((sent) => sent.type === "terminal.provider.resume")
      .map((sent) => sent.payload.conversationId))
      .toEqual([primaryConversationId, secondaryConversationId]));
  });

  it("routes a composer request to the terminal already resuming that chat", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    let created = 0;
    const onResumeRequestHandled = vi.fn();
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: `created-${created}`,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
          providerResumeConversationId: sent.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "session-primary",
          },
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const props = {
      projectId,
      conversationId,
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      providerResumes: [{
        projectId,
        projectName: "Inertia",
        conversationId,
        conversationTitle: "Primary chat",
        availability: {
          kind: "available" as const,
          resume: {
            providerId: "claude" as const,
            providerLabel: "Claude",
            sessionId: "session-primary",
          },
          reason: null,
        },
      }],
      sendCommand,
      subscribe: () => () => undefined,
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} />);

    const resume = await screen.findByRole("button", {
      name: "Resume Claude session in Inertia",
    });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);
    await waitFor(() => expect(resume).toHaveTextContent("Resumed"));

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Terminal 2/u }))
      .toHaveAttribute("aria-selected", "true"));
    view.rerender(
      <TerminalPanel
        {...props}
        resumeRequestConversationId={conversationId}
        onResumeRequestHandled={onResumeRequestHandled}
      />,
    );

    await waitFor(() => expect(screen.getByRole("tab", { name: /Terminal 1/u }))
      .toHaveAttribute("aria-selected", "true"));
    expect(onResumeRequestHandled).toHaveBeenCalled();
    expect(sendCommand.mock.calls.filter(
      ([sent]) => sent.type === "terminal.provider.resume",
    )).toHaveLength(1);
  });

  it("opens a fresh terminal for a composer request when the active tab is resumed", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const primaryConversationId = "22222222-2222-4222-8222-222222222222";
    const secondaryConversationId = "33333333-3333-4333-8333-333333333333";
    let created = 0;
    const onResumeRequestHandled = vi.fn();
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created += 1;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: `created-${created}`,
        };
      }
      if (sent.type === "terminal.provider.resume") {
        const secondary = sent.payload.conversationId === secondaryConversationId;
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
          providerResumeConversationId: sent.payload.conversationId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: secondary ? "session-secondary" : "session-primary",
          },
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const providerResumes = [
      {
        projectId,
        projectName: "Inertia",
        conversationId: primaryConversationId,
        conversationTitle: "Primary chat",
        availability: {
          kind: "available" as const,
          resume: {
            providerId: "claude" as const,
            providerLabel: "Claude",
            sessionId: "session-primary",
          },
          reason: null,
        },
      },
      {
        projectId,
        projectName: "Inertia",
        conversationId: secondaryConversationId,
        conversationTitle: "Secondary chat",
        availability: {
          kind: "available" as const,
          resume: {
            providerId: "claude" as const,
            providerLabel: "Claude",
            sessionId: "session-secondary",
          },
          reason: null,
        },
      },
    ];
    const props = {
      projectId,
      conversationId: primaryConversationId,
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      providerResumes,
      sendCommand,
      subscribe: () => () => undefined,
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} />);

    const primaryResume = await screen.findByRole("button", {
      name: "Resume Claude chat Primary chat in Inertia",
    });
    await waitFor(() => expect(primaryResume).toBeEnabled());
    fireEvent.click(primaryResume);
    await waitFor(() => expect(primaryResume).toHaveTextContent("Resumed"));

    view.rerender(
      <TerminalPanel
        {...props}
        resumeRequestConversationId={secondaryConversationId}
        onResumeRequestHandled={onResumeRequestHandled}
      />,
    );

    await waitFor(() => expect(sendCommand.mock.calls
      .map(([sent]) => sent)
      .filter((sent) => sent.type === "terminal.provider.resume")
      .map((sent) => sent.payload.conversationId))
      .toEqual([primaryConversationId, secondaryConversationId]));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Terminal 2/u }))
      .toHaveAttribute("aria-selected", "true");
    expect(onResumeRequestHandled).toHaveBeenCalled();
  });

  it("waits for authoritative close before releasing the four-terminal capacity", async () => {
    let created = 0;
    let confirmClose: (() => void) | undefined;
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        created += 1;
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: `${created}0000000-0000-4000-8000-000000000000`,
        });
      }
      if (sent.type === "terminal.close") {
        return new Promise((resolve) => {
          confirmClose = () => resolve({
            type: "request.ok",
            requestId: sent.requestId,
          });
        });
      }
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
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
        subscribe={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(created).toBe(1));
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await waitFor(() => expect(created).toBe(index + 2));
    }
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    const maximum = screen.getByRole("button", {
      name: "Maximum of 4 terminals open",
    });
    expect(maximum).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 4" }));
    await waitFor(() => expect(confirmClose).toBeTypeOf("function"));
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(maximum).toBeDisabled();

    await act(async () => {
      confirmClose?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(created).toBe(5));
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("runs a project action from four normal tabs by replacing the active terminal", async () => {
    const terminalIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
    ];
    let created = 0;
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: terminalIds[created++]!,
        });
      }
      if (sent.type === "project.action.run") return new Promise(() => undefined);
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
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} />);
    await waitFor(() => expect(created).toBe(1));
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
      await waitFor(() => expect(created).toBe(index + 2));
    }

    view.rerender(<TerminalPanel {...props} actionId="check" />);
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "project.action.run",
    )).toBe(true));
    const action = sendCommand.mock.calls.find(
      ([sent]) => sent.type === "project.action.run",
    )?.[0];
    expect(action).toMatchObject({
      type: "project.action.run",
      payload: { terminalId: terminalIds[3], actionId: "check" },
    });
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.close"))
      .toBe(false);
  });

  it("keeps a macOS shell visible when a project action starts in a new terminal", async () => {
    const shellId = "90000000-0000-4000-8000-000000000001";
    const actionTerminalId = "90000000-0000-4000-8000-000000000002";
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId: shellId };
      }
      if (sent.type === "project.action.run") {
        return { type: "terminal.created", requestId: sent.requestId, terminalId: actionTerminalId };
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
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      sendCommand,
      subscribe: () => () => undefined,
      onActionStarted: vi.fn(),
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} />);
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", shellId));

    view.rerender(<TerminalPanel {...props} actionId="check" />);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(document.querySelector('[role="tabpanel"]:not([hidden]) .terminal-panel'))
      .toHaveAttribute("data-terminal-id", actionTerminalId);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-id", shellId));
    await waitFor(() => expect(JSON.parse(window.sessionStorage.getItem(
      "inertia:terminal-sessions:v1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
    ) ?? "[]")).toEqual([actionTerminalId, shellId]));

    fireEvent(window, new Event("pagehide"));
    view.unmount();
    sendCommand.mockClear();
    render(<TerminalPanel {...props} />);
    await waitFor(() => expect(sendCommand.mock.calls.flatMap(([sent]) =>
      sent.type === "terminal.attach" ? [sent.payload.terminalId] : [])).toEqual(
      expect.arrayContaining([actionTerminalId, shellId]),
    ));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "terminal.close"
        && sent.payload.terminalId === actionTerminalId,
    )).toBe(true));
  });

  it("reconciles a zero-output project-action exit before its distinct response", async () => {
    const shellId = "90000000-0000-4000-8000-000000000011";
    const actionTerminalId = "90000000-0000-4000-8000-000000000012";
    const listeners = new Set<(event: ServerEvent) => void>();
    let settleAction!: (event: ServerEvent) => void;
    const action = new Promise<ServerEvent>((resolve) => { settleAction = resolve; });
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.create") {
        return Promise.resolve({ type: "terminal.created", requestId: sent.requestId, terminalId: shellId });
      }
      if (sent.type === "project.action.run") return action;
      if (sent.type === "terminal.attach") {
        return Promise.resolve({ type: "terminal.created", requestId: sent.requestId, terminalId: sent.payload.terminalId });
      }
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
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

    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "project.action.run",
    )).toBe(true));
    await act(async () => {
      for (const listener of listeners) {
        listener({ type: "terminal.exit", terminalId: actionTerminalId, exitCode: 17 });
      }
      settleAction({
        type: "terminal.created",
        requestId: crypto.randomUUID(),
        terminalId: actionTerminalId,
      });
      await action;
    });

    expect(screen.getByRole("button", { name: "Start again" })).toBeVisible();
    expect(document.querySelector(`[data-terminal-id="${actionTerminalId}"]`)).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem(
      "inertia:terminal-sessions:v1:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222",
    ) ?? "[]")).toEqual([null, shellId]);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    await waitFor(() => expect(document.querySelector(
      '[role="tabpanel"]:not([hidden]) .terminal-panel',
    )).toHaveAttribute("data-terminal-state", "ready"));
  });

  it("routes a project action away from the only resumed terminal", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const resumedTerminalId = "40000000-0000-4000-8000-000000000001";
    const idleTerminalId = "40000000-0000-4000-8000-000000000002";
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:${conversationId}`,
      JSON.stringify([resumedTerminalId]),
    );
    const sendCommand = vi.fn((sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.attach") {
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: resumedTerminalId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: "session-resumed",
          },
          providerResumeConversationId: "50000000-0000-4000-8000-000000000001",
        });
      }
      if (sent.type === "terminal.create") {
        return Promise.resolve({
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: idleTerminalId,
        });
      }
      if (sent.type === "project.action.run") return new Promise(() => undefined);
      return Promise.resolve({ type: "request.ok", requestId: sent.requestId });
    });
    const props = {
      projectId,
      conversationId,
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      sendCommand,
      subscribe: () => () => undefined,
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} />);
    await waitFor(() => expect(document.querySelector(".terminal-panel"))
      .toHaveAttribute("data-terminal-id", resumedTerminalId));

    view.rerender(<TerminalPanel {...props} actionId="check" />);
    await waitFor(() => expect(sendCommand.mock.calls.some(
      ([sent]) => sent.type === "project.action.run",
    )).toBe(true));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: /Terminal 2/u }))
      .toHaveAttribute("aria-selected", "true");
    const action = sendCommand.mock.calls.find(
      ([sent]) => sent.type === "project.action.run",
    )?.[0];
    expect(action).toMatchObject({
      type: "project.action.run",
      payload: { terminalId: idleTerminalId },
    });
    expect(action).not.toMatchObject({
      payload: { terminalId: resumedTerminalId },
    });
  });

  it("refuses a project action without disturbing four resumed terminals", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const terminalIds = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
      "20000000-0000-4000-8000-000000000004",
    ];
    window.sessionStorage.setItem(
      `inertia:terminal-sessions:v1:${projectId}:${conversationId}`,
      JSON.stringify(terminalIds),
    );
    const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
      if (sent.type === "terminal.attach") {
        const index = terminalIds.indexOf(sent.payload.terminalId);
        return {
          type: "terminal.created",
          requestId: sent.requestId,
          terminalId: sent.payload.terminalId,
          providerResume: {
            providerId: "claude",
            providerLabel: "Claude",
            sessionId: `session-${index + 1}`,
          },
          providerResumeConversationId: `30000000-0000-4000-8000-00000000000${index + 1}`,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const onActionStarted = vi.fn();
    const props = {
      projectId,
      conversationId,
      projectName: "Inertia",
      status: "online" as const,
      fontSize: 13,
      theme: "dark" as const,
      visible: true,
      sendCommand,
      subscribe: () => () => undefined,
      onActionStarted,
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} />);
    await waitFor(() => expect(document.querySelectorAll(
      '.terminal-panel[data-terminal-state="ready"]',
    )).toHaveLength(4));

    view.rerender(<TerminalPanel {...props} actionId="check" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "End a resumed provider terminal before starting this project action.",
    );
    expect(onActionStarted).toHaveBeenCalledOnce();
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "project.action.run"))
      .toBe(false);
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.close"))
      .toBe(false);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
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
