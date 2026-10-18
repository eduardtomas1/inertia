import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPanel } from "../../src/renderer/src/components/TerminalPanel";
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

vi.mock("@xterm/xterm", async () => (
  (await import("./support/textarea-terminal-mock")).createTextareaTerminalModule(terminalState)
));

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

describe("TerminalPanel resume capacity", () => {
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

  it("explains a composer resume that cannot start while four resumed providers hold every terminal", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const requestedConversationId = "40000000-0000-4000-8000-000000000001";
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
          providerResume: { providerId: "claude", providerLabel: "Claude", sessionId: `session-${index + 1}` },
          providerResumeConversationId: `30000000-0000-4000-8000-00000000000${index + 1}`,
        };
      }
      return { type: "request.ok", requestId: sent.requestId };
    });
    const onResumeRequestHandled = vi.fn();
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
        conversationId: requestedConversationId,
        conversationTitle: "Another chat",
        availability: {
          kind: "available" as const,
          resume: { providerId: "claude" as const, providerLabel: "Claude", sessionId: "88888888-8888-4888-8888-888888888888" },
          reason: null,
        },
      }],
      sendCommand,
      subscribe: () => () => undefined,
      onResumeRequestHandled,
      onClose: () => undefined,
    };
    const view = render(<TerminalPanel {...props} />);
    await waitFor(() => expect(document.querySelectorAll('.terminal-panel[data-terminal-state="ready"]')).toHaveLength(4));
    view.rerender(<TerminalPanel {...props} resumeRequestConversationId={requestedConversationId} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("End a resumed provider terminal before resuming another chat.");
    expect(onResumeRequestHandled).toHaveBeenCalledOnce();
    expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.provider.resume")).toBe(false);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });
});
