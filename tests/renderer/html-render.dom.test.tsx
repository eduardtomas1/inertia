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
const TOKEN = "0123456789abcdef0123456789abcdef";

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

function announce(source: unknown, token = TOKEN): void {
  postFromFrame(source, { type: `${MESSAGE}hello`, token });
}

function requestLink(source: unknown, url: string, token: string | null = TOKEN): void {
  postFromFrame(source, token === null
    ? { type: `${MESSAGE}open-link`, url }
    : { type: `${MESSAGE}open-link`, url, token });
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

/** Queues animation frames so a test decides when one runs. */
function queueAnimationFrames(): { pending: () => number; flush: () => void } {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextId += 1;
    frames.set(nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return {
    pending: () => frames.size,
    flush: () => act(() => {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback(performance.now());
    }),
  };
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
  vi.restoreAllMocks();
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
    const frames = queueAnimationFrames();
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    const figure = screen.getByRole("figure", { name: title });
    expect(figure).toHaveAttribute("data-html-render-state", "pending");
    const report = (height: unknown, source: unknown = frameWindow, origin?: string) => {
      postFromFrame(source, { type: `${MESSAGE}size`, height }, origin);
      frames.flush();
    };

    report(640, { postMessage: vi.fn() });
    report(640, frameWindow, "inertia://render");
    expect(frame.style.height).toBe("360px");
    expect(figure).toHaveAttribute("data-html-render-state", "pending");

    report(5_000);
    expect(frame.style.height).toBe("2000px");
    expect(figure).toHaveAttribute("data-html-render-state", "ready");

    report(12);
    expect(frame.style.height).toBe("80px");

    report(412.4);
    expect(frame.style.height).toBe("412px");

    report("900");
    expect(frame.style.height).toBe("412px");
  });

  it("applies only the latest size report once per animation frame", async () => {
    const frames = queueAnimationFrames();
    const { unmount } = render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    const figure = screen.getByRole("figure", { name: title });
    const heights: string[] = [];
    const observer = new MutationObserver(() => heights.push(frame.style.height));
    observer.observe(frame, { attributes: true, attributeFilter: ["style"] });

    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 500 });
    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 640 });
    expect(frames.pending()).toBe(1);
    // Nothing changes, and the page stays hidden, until the frame runs.
    expect(frame.style.height).toBe("360px");
    expect(figure).toHaveAttribute("data-html-render-state", "pending");

    frames.flush();
    await Promise.resolve();
    expect(frame.style.height).toBe("640px");
    expect(figure).toHaveAttribute("data-html-render-state", "ready");
    expect(heights).toEqual(["640px"]);

    // A report that rounds to the current height schedules a frame but changes nothing.
    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 640.3 });
    frames.flush();
    await Promise.resolve();
    expect(heights).toEqual(["640px"]);
    observer.disconnect();

    // A report still waiting for its frame is dropped on unmount.
    postFromFrame(frameWindow, { type: `${MESSAGE}size`, height: 700 });
    expect(frames.pending()).toBe(1);
    unmount();
    expect(frames.pending()).toBe(0);
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
    announce(frameWindow);

    requestLink(frameWindow, "javascript:alert(1)");
    requestLink(frameWindow, "file:///etc/passwd");
    requestLink(frameWindow, "inertia://bundle/index.html");
    expect(openExternal).not.toHaveBeenCalled();

    requestLink(frameWindow, "https://example.com/report?q=1");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/report?q=1");

    requestLink(frameWindow, "https://example.com/again");
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
    announce(frameWindow);

    requestLink(frameWindow, "https://example.com/");

    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens nothing for a link request a page script posts without the bootstrap's token", () => {
    vi.useFakeTimers();
    userActivation(true);
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    act(() => frame.focus());

    requestLink(frameWindow, "https://example.com/before-hello");
    announce(frameWindow);
    requestLink(frameWindow, "https://example.com/no-token", null);
    requestLink(frameWindow, "https://example.com/forged", "f".repeat(32));
    requestLink(frameWindow, "https://example.com/short", "abc");
    expect(openExternal).not.toHaveBeenCalled();

    requestLink(frameWindow, "https://example.com/clicked");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/clicked");

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    requestLink(frameWindow, "https://example.com/same-activation", null);
    requestLink(frameWindow, "https://example.com/same-activation", "f".repeat(32));
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("keeps the token the frame announced first", () => {
    userActivation(true);
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    act(() => frame.focus());
    const replacement = "a".repeat(32);

    announce(frameWindow);
    announce(frameWindow, replacement);
    requestLink(frameWindow, "https://example.com/replaced", replacement);
    expect(openExternal).not.toHaveBeenCalled();

    requestLink(frameWindow, "https://example.com/first");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/first");
  });

  it("ignores link requests while the user is interacting with the app outside the frame", () => {
    userActivation(true);
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frameWindow = attachFrameWindow(inlineFrame());
    const elsewhere = screen.getByRole("button", { name: `Open ${title} full size` });
    act(() => elsewhere.focus());
    announce(frameWindow);

    // Typing or clicking elsewhere activates the app window too; it is not a gesture in the page.
    requestLink(frameWindow, "https://example.com/");

    expect(openExternal).not.toHaveBeenCalled();
  });

  it("fails closed when the user activation state is unavailable", () => {
    render(<ResponseTimeline {...timelineProps([renderMessage()])} />);
    const frame = inlineFrame();
    const frameWindow = attachFrameWindow(frame);
    act(() => frame.focus());
    announce(frameWindow);
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: undefined });

    requestLink(frameWindow, "https://example.com/");

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

  it("shrink-wraps the full-size dialog to the height its own frame reports", async () => {
    const user = userEvent.setup();
    render(<ResponseTimeline {...timelineProps([renderMessage({ renderId, title, height: 300 })])} />);
    await user.click(screen.getByRole("button", { name: `Open ${title} full size` }));
    await screen.findByRole("dialog", { name: title }, { timeout: 10_000 });
    const frames = queueAnimationFrames();
    const dialogFrame = screen.getByTestId("html-render-dialog-frame") as HTMLIFrameElement;
    const contentHeight = () => dialogFrame.style.getPropertyValue("--html-render-content-height");
    const dialogWindow = attachFrameWindow(dialogFrame);
    // Until the page measures itself, the agent's requested height stands in.
    expect(contentHeight()).toBe("300px");

    // The inline frame's report sizes only the inline frame.
    postFromFrame(attachFrameWindow(inlineFrame()), { type: `${MESSAGE}size`, height: 900 });
    frames.flush();
    expect(contentHeight()).toBe("300px");

    postFromFrame(dialogWindow, { type: `${MESSAGE}size`, height: 150 });
    postFromFrame(dialogWindow, { type: `${MESSAGE}size`, height: 180.2 });
    frames.flush();
    expect(contentHeight()).toBe("181px");

    // Taller than the inline cap: the stylesheet caps the dialog and the page scrolls inside it.
    postFromFrame(dialogWindow, { type: `${MESSAGE}size`, height: 4_800 });
    frames.flush();
    expect(contentHeight()).toBe("4800px");
  });
});
