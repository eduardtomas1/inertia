import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
import type {
  ClientCommand,
  ProviderTerminalResumeAvailability,
  ServerEvent,
} from "../../src/shared/contracts";

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
        return {
          type: "terminal.created",
          requestId: command.requestId,
          terminalId: `${created}0000000-0000-4000-8000-000000000000`,
          ...(command.type === "terminal.provider.resume"
            ? {
                providerResume: {
                  providerId: "claude" as const,
                  providerLabel: "Claude",
                  sessionId: authoritativeSessionId,
                },
              }
            : {}),
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
    expect(screen.queryByText(sessionId, { selector: "code" })).toBeNull();
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
