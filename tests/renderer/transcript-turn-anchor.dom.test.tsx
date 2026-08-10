import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";

function turn(index: number): AgentTurn {
  const at = `2026-08-01T10:00:0${index}.000Z`;
  const id = `turn-${index}`;
  return {
    id,
    conversationId,
    runId: `run-${index}`,
    userMessageId: `message-${index}`,
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      backendConfigurationRevision: 1,
      modelId: "gpt-5.6",
      alias: null,
      reasoningEffort: "xhigh",
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
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at,
    updatedAt: at,
  };
}

function message(index: number): ChatMessage {
  return {
    id: `message-${index}`,
    conversationId,
    turnId: `turn-${index}`,
    role: "user",
    content: `Request ${index}`,
    attachments: [],
    createdAt: `2026-08-01T10:00:0${index}.000Z`,
  };
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 800,
    bottom: top + height,
    left: 0,
    width: 800,
    height,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("accepted turn viewport anchoring", () => {
  function renderTimeline(
    onTurnAnchorSettled: (turnId: string) => void,
    onTurnAnchorCancelled: (turnId: string) => void,
    count = 2,
    turnAnchorId = `turn-${count}`,
  ) {
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    render(
      <div ref={scrollElementRef} className="anchor-test-scroll">
        <div ref={timelineElementRef}>
          <ResponseTimeline
            turns={Array.from({ length: count }, (_, index) => turn(index + 1))}
            messages={Array.from({ length: count }, (_, index) => message(index + 1))}
            activities={[]}
            reasonings={[]}
            plans={[]}
            checkpoints={[]}
            projectRoot="/workspace"
            projectId="project-1"
            conversationId={conversationId}
            streamingText=""
            streamingReasoning=""
            approvals={[]}
            inputRequests={[]}
            showTimestamps={false}
            showThinking={false}
            defaultCodeWrap={false}
            autoCollapseWorkLog
            showChangedFileSummaries={false}
            checkpointRestoreDisabled={false}
            turnAnchorId={turnAnchorId}
            scrollElementRef={scrollElementRef}
            timelineElementRef={timelineElementRef}
            onTurnAnchorSettled={onTurnAnchorSettled}
            onTurnAnchorCancelled={onTurnAnchorCancelled}
            onRespondToApproval={async () => undefined}
            onRespondToInput={async () => undefined}
            onRevertCheckpoint={() => undefined}
            onOpenTurnDiff={() => undefined}
            onCompareTurnArtifacts={() => undefined}
            onOpenTurnFile={() => undefined}
            onStop={() => undefined}
          />
        </div>
      </div>,
    );
    return { scrollElementRef, timelineElementRef };
  }

  it("places the exact accepted turn at a stable viewport offset", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const settled = vi.fn();
    const cancelled = vi.fn();
    const { scrollElementRef, timelineElementRef } = renderTimeline(
      settled,
      cancelled,
    );
    const scroll = scrollElementRef.current!;
    const acceptedTurn = timelineElementRef.current!
      .querySelector<HTMLElement>('[data-turn-id="turn-2"]')!;
    scroll.getBoundingClientRect = () => rect(0, 600);
    acceptedTurn.getBoundingClientRect = () =>
      rect(408 - scroll.scrollTop, 120);

    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(scroll.scrollTop).toBe(400);
    expect(acceptedTurn.getBoundingClientRect().top).toBe(8);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith("turn-2");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("keeps a clamped short-row anchor pending until the row can settle", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const settled = vi.fn();
    const cancelled = vi.fn();
    const { scrollElementRef, timelineElementRef } = renderTimeline(
      settled,
      cancelled,
    );
    const scroll = scrollElementRef.current!;
    const acceptedTurn = timelineElementRef.current!
      .querySelector<HTMLElement>('[data-turn-id="turn-2"]')!;
    let scrollTop = 0;
    let maximumScrollTop = 100;
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        scrollTop = Math.max(0, Math.min(next, maximumScrollTop));
      },
    });
    scroll.getBoundingClientRect = () => rect(0, 600);
    acceptedTurn.getBoundingClientRect = () =>
      rect(408 - scrollTop, 120);

    await act(async () => {
      let attempt = 0;
      while (frames.length > 0 && attempt < 35) {
        frames.shift()!(attempt * 25);
        attempt += 1;
      }
    });

    expect(scroll.scrollTop).toBe(100);
    expect(acceptedTurn.getBoundingClientRect().top).toBe(308);
    expect(settled).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);

    maximumScrollTop = 400;
    await act(async () => {
      acceptedTurn.append(document.createTextNode("Expanded answer"));
      await Promise.resolve();
      let remaining = 4;
      while (frames.length > 0 && remaining > 0) {
        frames.shift()!(1_000 + remaining);
        remaining -= 1;
      }
    });

    expect(scroll.scrollTop).toBe(400);
    expect(acceptedTurn.getBoundingClientRect().top).toBe(8);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith("turn-2");
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("releases a pending anchor when the reader deliberately scrolls", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const settled = vi.fn();
    const cancelled = vi.fn();
    const { scrollElementRef } = renderTimeline(settled, cancelled);

    fireEvent.wheel(scrollElementRef.current!);

    expect(cancelled).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledWith("turn-2");
    expect(settled).not.toHaveBeenCalled();
  });

  it("settles an exact turn while the transcript remains virtualized", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("anchor-test-scroll") ? 600 : 120;
      });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const scroll = this.closest<HTMLElement>(".anchor-test-scroll");
        return this.dataset.turnId === "turn-1"
          ? rect(408 - (scroll?.scrollTop ?? 0), 120)
          : rect(0, this.classList.contains("anchor-test-scroll") ? 600 : 120);
      });
    vi.spyOn(HTMLElement.prototype, "scrollTo")
      .mockImplementation(function (
        this: HTMLElement,
        options?: ScrollToOptions | number,
        y?: number,
      ) {
        this.scrollTop = typeof options === "number"
          ? y ?? 0
          : options?.top ?? this.scrollTop;
        this.dispatchEvent(new Event("scroll"));
      });
    const settled = vi.fn();
    const cancelled = vi.fn();
    const { scrollElementRef, timelineElementRef } = renderTimeline(
      settled,
      cancelled,
      16,
      "turn-1",
    );

    await act(async () => {
      let remaining = 100;
      while (frames.length > 0 && remaining > 0) {
        frames.shift()!(performance.now());
        remaining -= 1;
        await Promise.resolve();
      }
    });

    const virtualWindow = timelineElementRef.current!
      .querySelector<HTMLElement>(".response-virtual-window");
    expect(virtualWindow).not.toBeNull();
    expect(virtualWindow!.querySelectorAll(".response-virtual-item").length)
      .toBeLessThan(16);
    expect(scrollElementRef.current!.scrollTop).toBe(400);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith("turn-1");
    expect(cancelled).not.toHaveBeenCalled();
  });
});

describe("completed answer positioning", () => {
  function renderAnswerTimeline(
    enabled: boolean,
    onFinalAnswerAutoScroll: (followsLatest: boolean | null) => void,
    settledInitially = false,
  ) {
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const runningTurn: AgentTurn = {
      ...turn(1),
      completedAt: null,
      status: "running",
      terminalReason: null,
    };
    const answer: ChatMessage = {
      id: "answer-1",
      conversationId,
      turnId: runningTurn.id,
      role: "assistant",
      content: "A long final answer",
      attachments: [],
      createdAt: "2026-08-01T10:00:02.000Z",
    };
    const settledTurn: AgentTurn = {
      ...turn(1),
      terminalAssistantMessageId: answer.id,
    };
    const scene = (settled: boolean): React.JSX.Element => (
      <div ref={scrollElementRef}>
        <div ref={timelineElementRef}>
          <ResponseTimeline
            turns={[settled ? settledTurn : runningTurn]}
            messages={settled ? [message(1), answer] : [message(1)]}
            activities={[]}
            reasonings={[]}
            plans={[]}
            checkpoints={[]}
            projectRoot="/workspace"
            projectId="project-1"
            conversationId={conversationId}
            streamingText=""
            streamingReasoning=""
            approvals={[]}
            inputRequests={[]}
            showTimestamps={false}
            showThinking={false}
            defaultCodeWrap={false}
            autoCollapseWorkLog
            showChangedFileSummaries={false}
            autoScrollToFinalAnswer={enabled}
            checkpointRestoreDisabled={false}
            scrollElementRef={scrollElementRef}
            timelineElementRef={timelineElementRef}
            onFinalAnswerAutoScroll={onFinalAnswerAutoScroll}
            onRespondToApproval={async () => undefined}
            onRespondToInput={async () => undefined}
            onRevertCheckpoint={() => undefined}
            onOpenTurnDiff={() => undefined}
            onCompareTurnArtifacts={() => undefined}
            onOpenTurnFile={() => undefined}
            onStop={() => undefined}
          />
        </div>
      </div>
    );
    const view = render(scene(settledInitially));
    return {
      answer,
      scrollElementRef,
      timelineElementRef,
      settle: () => view.rerender(scene(true)),
    };
  }

  it("places a newly persisted final answer at the viewport top", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const harness = renderAnswerTimeline(true, positioned);
    const scroll = harness.scrollElementRef.current!;
    let scrollTop = 1_500;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 5_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    scroll.getBoundingClientRect = () => rect(100, 400);
    scroll.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      if (typeof options !== "number" && options?.top !== undefined) {
        scrollTop = options.top;
      }
    });

    harness.settle();
    const answer = harness.timelineElementRef.current!
      .querySelector<HTMLElement>(`[data-terminal-answer-id="${harness.answer.id}"]`)!;
    answer.getBoundingClientRect = () => rect(2_100 - scrollTop, 2_400);
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(scroll.scrollTo).toHaveBeenCalledWith({
      top: 1_992,
      behavior: "auto",
    });
    expect(scrollTop).toBe(1_992);
    expect(positioned.mock.calls).toEqual([[null], [false]]);
  });

  it("does not reposition disabled or already-loaded answers", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const disabled = vi.fn();
    const disabledHarness = renderAnswerTimeline(false, disabled);
    disabledHarness.settle();
    const historical = vi.fn();
    renderAnswerTimeline(true, historical, true);
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(disabled).not.toHaveBeenCalled();
    expect(historical).not.toHaveBeenCalled();
  });
});
