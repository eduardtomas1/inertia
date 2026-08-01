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
            providers={[]}
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
