import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

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

vi.mock("@xterm/xterm", async () => {
  const module = (await import("./support/textarea-terminal-mock")).createTextareaTerminalModule(terminalState);
  return {
    Terminal: class extends module.Terminal {
      cols = 600;
      rows = 300;
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

it("keeps a very wide terminal within the sizes the runtime accepts", async () => {
  const sendCommand = vi.fn(async (sent: ClientCommand): Promise<ServerEvent> => {
    if (sent.type === "terminal.create" || sent.type === "terminal.provider.resume") {
      return {
        type: "terminal.created",
        requestId: sent.requestId,
        terminalId: sent.type === "terminal.create"
          ? "44444444-4444-4444-8444-444444444444"
          : "55555555-5555-4555-8555-555555555555",
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
          sessionId: "66666666-6666-4666-8666-666666666666",
        },
        reason: null,
      }}
      sendCommand={sendCommand}
      subscribe={() => () => undefined}
      onClose={() => undefined}
    />,
  );

  await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.resize")).toBe(true));
  const resume = await screen.findByRole("button", { name: "Resume Claude session in Inertia" });
  await waitFor(() => expect(resume).toBeEnabled());
  fireEvent.click(resume);
  await waitFor(() => expect(sendCommand.mock.calls.some(([sent]) => sent.type === "terminal.provider.resume")).toBe(true));

  const sized = sendCommand.mock.calls.map(([sent]) => sent).filter((sent) => (
    sent.type === "terminal.create" || sent.type === "terminal.resize" || sent.type === "terminal.provider.resume"
  ));
  expect(sized.map((sent) => sent.type)).toEqual(expect.arrayContaining([
    "terminal.create", "terminal.resize", "terminal.provider.resume",
  ]));
  for (const sent of sized) expect(sent.payload).toMatchObject({ cols: 400, rows: 200 });
});
