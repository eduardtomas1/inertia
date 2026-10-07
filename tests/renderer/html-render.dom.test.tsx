/**
 * @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/ResponseTimeline";
import { HTML_RENDER_REVEAL_FALLBACK_MS } from "../../src/renderer/src/components/response-timeline/html-render";
import {
  NATIVE_PREVIEW_OVERLAY_CLOSED,
  NATIVE_PREVIEW_OVERLAY_OPENED,
} from "../../src/renderer/src/utils/nativePreviewOverlay";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";
import type {
  HtmlRenderReference,
  HtmlRenderTheme,
} from "../../src/shared/html-render";

const conversationId = "13131313-1313-4131-8131-131313131313";
const turnId = "turn-visual-reply";
const runId = "run-visual-reply";
const renderId = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const title = "Quarterly revenue chart";
const MESSAGE = "inertia-html-render:";

function at(seconds: number): string {
  return `2030-03-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function settledTurn(): AgentTurn {
  return {
    id: turnId,
    conversationId,
    runId,
    userMessageId: "request-visual-reply",
    terminalAssistantMessageId: "answer-visual-reply",
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      backendConfigurationRevision: 1,
      modelId: "gpt-5.6",
      alias: null,
      reasoningEffort: "high",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1,
      endpointIdentity: null,
      modelIdentity: "gpt-5.6",
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: null,
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: at(0),
    startedAt: at(1),
    completedAt: at(9),
    status: "completed",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(0),
    updatedAt: at(9),
  };
}

function chatMessage(
  id: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
  update: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt, ...update };
}

function renderMessage(reference: HtmlRenderReference = { renderId, title, height: 360 }): ChatMessage {
  return chatMessage("render-visual-reply", "system", `Rendered page: ${reference.title}`, at(5), {
    htmlRender: reference,
  });
}

const failedCommand: AgentActivity = {
  id: "activity-visual-reply",
  conversationId,
  runId,
  turnId,
  kind: "command",
  title: "Run the report script",
  detail: "exit code 1",
  status: "failed",
  createdAt: at(3),
};

const noop = (): void => undefined;
const respond = async (): Promise<void> => undefined;

function timelineProps(extraMessages: ChatMessage[]): ResponseTimelineProps {
  return {
    turns: [settledTurn()],
    messages: [
      chatMessage("request-visual-reply", "user", "Chart revenue by quarter.", at(0)),
      ...extraMessages,
      chatMessage("answer-visual-reply", "assistant", "Q3 carried the year.", at(8)),
    ],
    activities: [failedCommand],
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-visual-reply",
    conversationId,
    streamingText: "",
    streamingReasoning: "",
    streamingChannel: null,
    approvals: [],
    inputRequests: [],
    showTimestamps: false,
    showThinking: false,
    defaultCodeWrap: false,
    autoCollapseWorkLog: true,
    showChangedFileSummaries: false,
    checkpointRestoreDisabled: false,
    onRespondToApproval: respond,
    onRespondToInput: respond,
    onRevertCheckpoint: noop,
    onOpenTurnDiff: noop,
    onCompareTurnArtifacts: noop,
    onOpenTurnFile: noop,
    onStop: noop,
  };
}

type FakeFrameWindow = { postMessage: ReturnType<typeof vi.fn> };

/** Happy DOM cannot load the privileged route, so each frame gets a scripted window. */
function attachFrameWindow(frame: HTMLIFrameElement): FakeFrameWindow {
  const frameWindow: FakeFrameWindow = { postMessage: vi.fn() };
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: frameWindow });
  return frameWindow;
}

function postFromFrame(source: unknown, data: unknown, origin = "null"): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      data,
      origin,
      source: source as MessageEventSource,
    }));
  });
}

function inlineFrame(): HTMLIFrameElement {
  const frame = screen.getByTestId("html-render-frame") as HTMLIFrameElement;
  expect(frame).toHaveAttribute("title", title);
  return frame;
}

function postedThemes(frameWindow: FakeFrameWindow): HtmlRenderTheme[] {
  return frameWindow.postMessage.mock.calls
    .map(([message]) => message as { type: string; theme: HtmlRenderTheme })
    .filter(({ type }) => type === `${MESSAGE}theme`)
    .map(({ theme }) => theme);
}

const openExternal = vi.fn(async (_url: string) => undefined);

function userActivation(isActive: boolean): void {
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive, hasBeenActive: isActive },
  });
}

beforeEach(() => {
  openExternal.mockClear();
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: { openExternal },
  });
});

afterEach(() => {
  vi.useRealTimers();
  const root = document.documentElement;
  delete root.dataset.theme;
  root.removeAttribute("style");
  Reflect.deleteProperty(navigator, "userActivation");
});

describe("visual replies in the response timeline", () => {
  it("shows the page between the work log and the final answer with an accessible frame", () => {
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);

    const figure = screen.getByRole("figure", { name: title });
    const frame = inlineFrame();
    const execution = document.querySelector("[data-turn-layer='agent-execution']")!;
    const answer = document.querySelector("[data-turn-layer='final-answer']")!;
    expect(execution.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(figure.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(figure).toHaveAttribute("data-render-id", renderId);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame).toHaveAttribute("loading", "lazy");
    expect(frame).toHaveAttribute("allow", "");
    expect(frame.getAttribute("src")).toMatch(
      new RegExp(`^inertia://render/${renderId}#theme=`, "u"),
    );
    expect(frame.style.height).toBe("360px");
    expect(screen.getByRole("button", { name: `Open ${title} full size` })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Agent system notice" })).not.toBeInTheDocument();
    expect(screen.queryByText(`Rendered page: ${title}`)).not.toBeInTheDocument();
  });

  it("keeps a system message without a visual reply as a system notice", () => {
    render(<ResponseTimeline {...timelineProps([
      chatMessage("notice-visual-reply", "system", "Earlier messages were not imported.", at(4)),
    ])} />);

    expect(screen.getByRole("article", { name: "Agent system notice" }))
      .toHaveTextContent("Earlier messages were not imported.");
    expect(screen.queryByTestId("html-render")).not.toBeInTheDocument();
  });

  it("posts the theme on load and again when the app theme changes", async () => {
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    expect(frameWindow.postMessage).not.toHaveBeenCalled();

    act(() => {
      frame.dispatchEvent(new Event("load"));
    });

    expect(postedThemes(frameWindow)).toHaveLength(1);
    expect(postedThemes(frameWindow)[0]?.scheme).toBe("light");
    expect(frameWindow.postMessage.mock.calls[0]?.[1]).toBe("*");

    const root = document.documentElement;
    act(() => {
      root.dataset.theme = "dark";
      root.style.setProperty("--text", "rgb(250, 250, 250)");
    });

    await waitFor(() => {
      const latest = postedThemes(frameWindow).at(-1);
      expect(latest?.scheme).toBe("dark");
      expect(latest?.variables["--foreground"]).toBe("rgb(250, 250, 250)");
    });
    const src = frame.getAttribute("src");
    expect(src).not.toContain("rgb(250");
  });

  it("fits the frame to clamped size reports from its own window only", () => {
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    const figure = screen.getByRole("figure", { name: title });
    expect(figure).toHaveAttribute("data-html-render-state", "pending");

    postFromFrame({ postMessage: vi.fn() }, { type: `${MESSAGE}size`, height: 640 });
    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 640 }, "inertia://render");
    expect(frame.style.height).toBe("360px");
    expect(figure).toHaveAttribute("data-html-render-state", "pending");

    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 5_000 });
    expect(frame.style.height).toBe("2000px");
    expect(figure).toHaveAttribute("data-html-render-state", "ready");

    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 12 });
    expect(frame.style.height).toBe("80px");

    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 412.4 });
    expect(frame.style.height).toBe("412px");

    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: "900" });
    expect(frame.style.height).toBe("412px");
  });

  it("reveals a page that never reports its size after the fallback delay", () => {
    vi.useFakeTimers();
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const figure = screen.getByRole("figure", { name: title });
    expect(figure).toHaveAttribute("data-html-render-state", "pending");

    act(() => {
      vi.advanceTimersByTime(HTML_RENDER_REVEAL_FALLBACK_MS);
    });

    expect(figure).toHaveAttribute("data-html-render-state", "ready");
  });

  it("opens only http(s) links through the external-link bridge", () => {
    userActivation(true);
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    act(() => frame.focus());

    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "javascript:alert(1)" });
    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "file:///etc/passwd" });
    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "inertia://bundle/index.html" });
    expect(openExternal).not.toHaveBeenCalled();

    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "https://example.com/report?q=1" });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/report?q=1");

    // A page script repeating the request cannot open a burst of windows.
    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "https://example.com/again" });
    expect(openExternal).toHaveBeenCalledOnce();

    // Escape is meaningful only to the full-size dialog.
    postFromFrame(frameWindow, { type: `${MESSAGE}escape` });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ignores link requests that arrive without a user gesture", () => {
    userActivation(false);
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    act(() => frame.focus());

    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "https://example.com/" });

    expect(openExternal).not.toHaveBeenCalled();
  });

  it("ignores link requests while the user is interacting with the app outside the frame", () => {
    userActivation(true);
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frameWindow = attachFrameWindow(inlineFrame());
    const elsewhere = screen.getByRole("button", { name: `Open ${title} full size` });
    act(() => elsewhere.focus());

    // Typing or clicking elsewhere activates the app window too; it is not a gesture in the page.
    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "https://example.com/" });

    expect(openExternal).not.toHaveBeenCalled();
  });

  it("fails closed when the user activation state is unavailable", () => {
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    act(() => frame.focus());
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: undefined });

    postFromFrame(frameWindow, { type: `${MESSAGE}open-link`, url: "https://example.com/" });

    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens a focus-trapped full-size dialog that closes on Escape and on the page's escape", async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    const closed = vi.fn();
    window.addEventListener(NATIVE_PREVIEW_OVERLAY_OPENED, opened);
    window.addEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, closed);
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const trigger = screen.getByRole("button", { name: `Open ${title} full size` });

    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: title }, { timeout: 10_000 });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(opened).toHaveBeenCalledOnce();
    const close = screen.getByRole("button", { name: `Close ${title}` });
    await waitFor(() => expect(close).toHaveFocus());
    const dialogFrame = screen.getByTestId("html-render-dialog-frame");
    expect(dialogFrame).toHaveAttribute("title", title);
    expect(dialogFrame).toHaveAttribute("sandbox", "allow-scripts");
    expect(dialogFrame.getAttribute("src")).toMatch(
      new RegExp(`^inertia://render/${renderId}#theme=`, "u"),
    );

    await user.tab({ shift: true });
    expect(dialogFrame).toHaveFocus();
    // Tab inside the frame belongs to the page's document; leaving it lands
    // on a guard that returns focus inside the dialog.
    act(() => {
      (document.querySelectorAll<HTMLElement>(".html-render-dialog-guard")[1])?.focus();
    });
    expect(close).toHaveFocus();
    act(() => {
      (document.querySelectorAll<HTMLElement>(".html-render-dialog-guard")[0])?.focus();
    });
    expect(dialogFrame).toHaveFocus();

    act(() => close.focus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(closed).toHaveBeenCalledOnce();

    await user.click(trigger);
    await screen.findByRole("dialog", { name: title });
    const reopenedFrame = screen.getByTestId("html-render-dialog-frame") as HTMLIFrameElement;
    const dialogWindow = attachFrameWindow(reopenedFrame);
    // The inline frame's escape is not the dialog's.
    postFromFrame(attachFrameWindow(inlineFrame()), { type: `${MESSAGE}escape` });
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();

    postFromFrame(dialogWindow, { type: `${MESSAGE}escape` });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    window.removeEventListener(NATIVE_PREVIEW_OVERLAY_OPENED, opened);
    window.removeEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, closed);
  });
});
