import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { FinalAnswerAutoScrollEvent } from "../../src/renderer/src/components/response-timeline/types";
import type {
  AgentTurn,
  ChatMessage,
  ConversationLatestTurnSummary,
} from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";

function turn(index: number): AgentTurn {
  const at = `2026-08-01T10:00:${String(index).padStart(2, "0")}.000Z`;
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
    createdAt: `2026-08-01T10:00:${String(index).padStart(2, "0")}.000Z`,
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function drainVirtualizerTimers(): Promise<void> {
  await act(async () => {
    vi.runOnlyPendingTimers();
    await Promise.resolve();
  });
  vi.useRealTimers();
}

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
    vi.useFakeTimers();
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
    await drainVirtualizerTimers();
  });
});

describe("completed answer positioning", () => {
  function renderAnswerTimeline(
    enabled: boolean,
    onFinalAnswerAutoScroll: (event: FinalAnswerAutoScrollEvent) => void,
    settledInitially = false,
    count = 1,
    onReaderNavigationIntent?: () => void,
  ) {
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const runningTurn: AgentTurn = {
      ...turn(count),
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
      ...turn(count),
      terminalAssistantMessageId: answer.id,
    };
    const historicalTurns = Array.from(
      { length: Math.max(0, count - 1) },
      (_, index) => turn(index + 1),
    );
    const historicalMessages = Array.from(
      { length: Math.max(0, count - 1) },
      (_, index) => message(index + 1),
    );
    const scene = (
      settled: boolean,
      detailLoading = false,
    ): React.JSX.Element => (
      <div ref={scrollElementRef} className="anchor-test-scroll">
        <div ref={timelineElementRef}>
          <ResponseTimeline
            turns={[
              ...historicalTurns,
              settled ? settledTurn : runningTurn,
            ]}
            messages={[
              ...historicalMessages,
              message(count),
              ...(settled ? [answer] : []),
            ]}
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
            detailLoading={detailLoading}
            checkpointRestoreDisabled={false}
            scrollElementRef={scrollElementRef}
            timelineElementRef={timelineElementRef}
            onFinalAnswerAutoScroll={onFinalAnswerAutoScroll}
            onReaderNavigationIntent={onReaderNavigationIntent}
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
      rerenderSettledDetail: () => view.rerender(scene(true, true)),
      unmount: () => view.unmount(),
    };
  }

  type HydrationSceneState =
    | "loading"
    | "running"
    | "settled-loading"
    | "settled";

  function hydrationScene(
    targetConversationId: string,
    state: HydrationSceneState,
    scrollElementRef: React.RefObject<HTMLDivElement | null>,
    timelineElementRef: React.RefObject<HTMLDivElement | null>,
    onFinalAnswerAutoScroll: (event: FinalAnswerAutoScrollEvent) => void,
    latestTurnSummary: ConversationLatestTurnSummary | null = null,
    latestTurnSummaryOwner = targetConversationId,
  ): React.JSX.Element {
    const turnId = `${targetConversationId}-turn`;
    const request: ChatMessage = {
      ...message(1),
      id: `${targetConversationId}-request`,
      conversationId: targetConversationId,
      turnId,
    };
    const answer: ChatMessage = {
      id: `${targetConversationId}-answer`,
      conversationId: targetConversationId,
      turnId,
      role: "assistant",
      content: "A completed answer owned by the hydrated conversation",
      attachments: [],
      createdAt: "2026-08-01T10:00:02.000Z",
    };
    const settledTurn: AgentTurn = {
      ...turn(1),
      id: turnId,
      conversationId: targetConversationId,
      userMessageId: request.id,
      terminalAssistantMessageId: answer.id,
    };
    const runningTurn: AgentTurn = {
      ...settledTurn,
      completedAt: null,
      status: "running",
      terminalReason: null,
      terminalAssistantMessageId: null,
    };
    const hasTurn = state !== "loading";
    const hasSettledDetail = state === "settled"
      || state === "settled-loading";
    return (
      <div ref={scrollElementRef} className="anchor-test-scroll">
        <div ref={timelineElementRef}>
          <ResponseTimeline
            turns={hasTurn
              ? [hasSettledDetail ? settledTurn : runningTurn]
              : []}
            messages={hasTurn
              ? [request, ...(hasSettledDetail ? [answer] : [])]
              : []}
            activities={[]}
            reasonings={[]}
            plans={[]}
            checkpoints={[]}
            projectRoot="/workspace"
            projectId="project-1"
            conversationId={targetConversationId}
            latestTurnSummary={latestTurnSummary ? {
              conversationId: latestTurnSummaryOwner,
              turn: latestTurnSummary,
            } : null}
            streamingText=""
            streamingReasoning=""
            approvals={[]}
            inputRequests={[]}
            showTimestamps={false}
            showThinking={false}
            defaultCodeWrap={false}
            autoCollapseWorkLog
            showChangedFileSummaries={false}
            autoScrollToFinalAnswer
            detailLoading={state !== "settled"}
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
  }

  function hydrationLatestTurnSummary(
    targetConversationId: string,
    status: AgentTurn["status"],
    runId = "run-1",
  ): ConversationLatestTurnSummary {
    const source = turn(1);
    const terminal = status === "completed"
      || status === "failed"
      || status === "cancelled"
      || status === "interrupted";
    return {
      id: `${targetConversationId}-turn`,
      runId,
      status,
      providerId: source.providerId,
      harnessId: source.harnessId,
      backendProfileId: source.backendProfileId,
      modelSelection: source.modelSelection,
      continuationIdentity: source.continuationIdentity,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      requestedAt: source.requestedAt,
      startedAt: source.startedAt,
      completedAt: terminal ? source.completedAt : null,
      terminalReason: terminal ? source.terminalReason : null,
      updatedAt: source.updatedAt,
    };
  }

  it("keeps positioning a persisted answer across a detail rerender", async () => {
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

    harness.settle();
    const answer = harness.timelineElementRef.current!
      .querySelector<HTMLElement>(`[data-terminal-answer-id="${harness.answer.id}"]`)!;
    answer.getBoundingClientRect = () => rect(2_100 - scrollTop, 2_400);
    await act(async () => {
      let remaining = 20;
      while (frames.length > 0 && scrollTop !== 1_992 && remaining > 0) {
        frames.shift()!(performance.now());
        remaining -= 1;
      }
    });
    expect(scrollTop).toBe(1_992);
    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started"]);

    harness.rerenderSettledDetail();
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(scrollTop).toBe(1_992);
    expect(positioned.mock.calls).toEqual([
      [{
        status: "started",
        conversationId,
        answerId: harness.answer.id,
      }],
      [{
        status: "positioned",
        conversationId,
        answerId: harness.answer.id,
        followsLatest: false,
      }],
    ]);
  });

  it("cancels a pending final-answer anchor for fresh reader intent", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const harness = renderAnswerTimeline(true, positioned);

    harness.settle();
    fireEvent.wheel(harness.scrollElementRef.current!);
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started", "cancelled"]);
  });

  it("cancels an active final-answer anchor before Alt timeline navigation", () => {
    const sequence: string[] = [];
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const harness = renderAnswerTimeline(
      true,
      (event) => sequence.push(event.status),
      false,
      1,
      () => sequence.push("intent"),
    );

    harness.settle();
    expect(sequence).toEqual(["started"]);
    fireEvent.keyDown(harness.scrollElementRef.current!, {
      altKey: true,
      key: "g",
    });

    expect(sequence).toEqual(["started", "cancelled", "intent"]);
  });

  it("cancels cleanup without reporting a false positioned answer", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const harness = renderAnswerTimeline(true, positioned);

    harness.settle();
    harness.unmount();
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(positioned.mock.calls).toEqual([
      [{
        status: "started",
        conversationId,
        answerId: harness.answer.id,
      }],
      [{
        status: "cancelled",
        conversationId,
        answerId: harness.answer.id,
      }],
    ]);
  });

  it("waits for a delayed final answer while the transcript stays virtualized", async () => {
    vi.useFakeTimers();
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
        if (this.dataset.terminalAnswerId === "answer-1") {
          return rect(408 - (scroll?.scrollTop ?? 0), 1_200);
        }
        return rect(0, this.classList.contains("anchor-test-scroll") ? 600 : 120);
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
    const positioned = vi.fn();
    const harness = renderAnswerTimeline(true, positioned, false, 16);
    Object.defineProperties(harness.scrollElementRef.current!, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 5_000 },
    });

    await act(async () => {
      harness.settle();
      await Promise.resolve();
    });
    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started"]);
    const answer = harness.timelineElementRef.current!
      .querySelector<HTMLElement>('[data-terminal-answer-id="answer-1"]')!;
    answer.removeAttribute("data-terminal-answer-id");
    await act(async () => {
      let remaining = 4;
      while (frames.length > 0 && remaining > 0) {
        frames.shift()!(performance.now());
        remaining -= 1;
        await Promise.resolve();
      }
    });
    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started"]);

    answer.dataset.terminalAnswerId = "answer-1";
    await act(async () => {
      let remaining = 100;
      while (frames.length > 0 && remaining > 0) {
        frames.shift()!(performance.now());
        remaining -= 1;
        await Promise.resolve();
      }
    });

    const virtualWindow = harness.timelineElementRef.current!
      .querySelector<HTMLElement>(".response-virtual-window");
    expect(virtualWindow).not.toBeNull();
    expect(virtualWindow!.querySelectorAll(".response-virtual-item").length)
      .toBeLessThan(16);
    expect(harness.scrollElementRef.current!.scrollTop).toBe(400);
    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started", "positioned"]);
    await drainVirtualizerTimers();
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

  it("does not reposition historical detail that hydrates after a conversation switch", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const nextConversationId = "22222222-2222-4222-8222-222222222222";
    const view = render(hydrationScene(
      conversationId,
      "settled",
      scrollElementRef,
      timelineElementRef,
      positioned,
    ));
    await act(async () => {
      view.rerender(hydrationScene(
        nextConversationId,
        "loading",
        scrollElementRef,
        timelineElementRef,
        positioned,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      view.rerender(hydrationScene(
        nextConversationId,
        "settled-loading",
        scrollElementRef,
        timelineElementRef,
        positioned,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      view.rerender(hydrationScene(
        nextConversationId,
        "settled",
        scrollElementRef,
        timelineElementRef,
        positioned,
      ));
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(positioned).not.toHaveBeenCalled();
  });

  it("positions a subscribed running turn that settles with hydration", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const targetConversationId = "33333333-3333-4333-8333-333333333333";
    const view = render(hydrationScene(
      targetConversationId,
      "loading",
      scrollElementRef,
      timelineElementRef,
      positioned,
    ));
    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "running",
        scrollElementRef,
        timelineElementRef,
        positioned,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "settled-loading",
        scrollElementRef,
        timelineElementRef,
        positioned,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "settled",
        scrollElementRef,
        timelineElementRef,
        positioned,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started", "positioned"]);
  });

  it("retains an owner-scoped shell subscription until matching detail settles", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const targetConversationId = "44444444-4444-4444-8444-444444444444";
    let scrollTop = 1_500;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("anchor-test-scroll")) {
          return rect(100, 400);
        }
        if (this.dataset.terminalAnswerId === `${targetConversationId}-answer`) {
          return rect(2_100 - scrollTop, 2_400);
        }
        return rect(0, 120);
      });
    const runningSummary = hydrationLatestTurnSummary(
      targetConversationId,
      "running",
    );
    const terminalSummary = hydrationLatestTurnSummary(
      targetConversationId,
      "completed",
    );
    const view = render(hydrationScene(
      targetConversationId,
      "loading",
      scrollElementRef,
      timelineElementRef,
      positioned,
      runningSummary,
    ));
    Object.defineProperties(scrollElementRef.current!, {
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

    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "settled-loading",
        scrollElementRef,
        timelineElementRef,
        positioned,
        runningSummary,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "settled",
        scrollElementRef,
        timelineElementRef,
        positioned,
        terminalSummary,
      ));
      await Promise.resolve();
    });
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started", "positioned"]);
    view.rerender(hydrationScene(
      targetConversationId,
      "settled",
      scrollElementRef,
      timelineElementRef,
      positioned,
      terminalSummary,
    ));
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });
    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started", "positioned"]);
  });

  it("cancels a pending answer when the authoritative run advances", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const targetConversationId = "66666666-6666-4666-8666-666666666666";
    const runningSummary = hydrationLatestTurnSummary(
      targetConversationId,
      "running",
      "run-1",
    );
    const terminalSummary = hydrationLatestTurnSummary(
      targetConversationId,
      "completed",
      "run-1",
    );
    const replacementSummary = hydrationLatestTurnSummary(
      targetConversationId,
      "completed",
      "run-2",
    );
    const view = render(hydrationScene(
      targetConversationId,
      "loading",
      scrollElementRef,
      timelineElementRef,
      positioned,
      runningSummary,
    ));

    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "settled",
        scrollElementRef,
        timelineElementRef,
        positioned,
        terminalSummary,
      ));
      await Promise.resolve();
    });
    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started"]);

    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "settled",
        scrollElementRef,
        timelineElementRef,
        positioned,
        replacementSummary,
      ));
      await Promise.resolve();
    });
    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started", "cancelled"]);
    await act(async () => {
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(positioned.mock.calls.map(([event]) => event.status))
      .toEqual(["started", "cancelled"]);
  });

  it("keeps an already-terminal shell hydration historical", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const positioned = vi.fn();
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const targetConversationId = "55555555-5555-4555-8555-555555555555";
    const terminalSummary = hydrationLatestTurnSummary(
      targetConversationId,
      "completed",
    );
    const view = render(hydrationScene(
      targetConversationId,
      "loading",
      scrollElementRef,
      timelineElementRef,
      positioned,
      terminalSummary,
    ));
    await act(async () => {
      view.rerender(hydrationScene(
        targetConversationId,
        "settled",
        scrollElementRef,
        timelineElementRef,
        positioned,
        terminalSummary,
      ));
      while (frames.length > 0) frames.shift()!(performance.now());
    });

    expect(positioned).not.toHaveBeenCalled();
  });

  it("does not cross-fire an owner, turn, or run mismatched shell", async () => {
    for (const mismatch of ["owner", "turn", "run"] as const) {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.stubGlobal("cancelAnimationFrame", () => undefined);
      const positioned = vi.fn();
      const scrollElementRef = createRef<HTMLDivElement>();
      const timelineElementRef = createRef<HTMLDivElement>();
      const targetConversationId = `shell-mismatch-${mismatch}`;
      let runningSummary = hydrationLatestTurnSummary(
        targetConversationId,
        "running",
      );
      let terminalSummary = hydrationLatestTurnSummary(
        targetConversationId,
        "completed",
      );
      let owner = targetConversationId;
      if (mismatch === "owner") owner = "different-owner";
      if (mismatch === "turn") {
        runningSummary = { ...runningSummary, id: "different-turn" };
        terminalSummary = { ...terminalSummary, id: "different-turn" };
      }
      if (mismatch === "run") {
        runningSummary = { ...runningSummary, runId: "different-run" };
        terminalSummary = { ...terminalSummary, runId: "different-run" };
      }
      const view = render(hydrationScene(
        targetConversationId,
        "loading",
        scrollElementRef,
        timelineElementRef,
        positioned,
        runningSummary,
        owner,
      ));
      await act(async () => {
        view.rerender(hydrationScene(
          targetConversationId,
          "settled",
          scrollElementRef,
          timelineElementRef,
          positioned,
          terminalSummary,
          owner,
        ));
        await Promise.resolve();
      });
      await act(async () => {
        while (frames.length > 0) frames.shift()!(performance.now());
      });

      expect(positioned, mismatch).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});
