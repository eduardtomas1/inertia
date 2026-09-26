import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResponseTimeline,
} from "../../src/renderer/src/components/ResponseTimeline";
import type {
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";
import { clearMessageSearchFocus, requestMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";

const conversationId = "11111111-1111-4111-8111-111111111111";

function agentTurn(index: number): AgentTurn {
  const requestedAt = `2026-07-29T10:00:0${index}.000Z`;
  return {
    id: `turn-${index}`,
    conversationId,
    runId: `run-${index}`,
    userMessageId: `user-${index}`,
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: null,
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
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
    requestedAt,
    startedAt: requestedAt,
    completedAt: requestedAt,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
}

function userMessage(index: number, content: string): ChatMessage {
  return {
    id: `user-${index}`,
    conversationId,
    turnId: `turn-${index}`,
    role: "user",
    content,
    attachments: [],
    createdAt: `2026-07-29T10:00:0${index}.000Z`,
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
  clearMessageSearchFocus();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("long user request expansion", () => {
  it("lets search reveal a nested follow-up without restoring the disclosure's old position", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const runFrames = async (): Promise<void> => {
      for (let attempt = 0; frames.size && attempt < 100; attempt += 1) {
        const [id, callback] = frames.entries().next().value!;
        frames.delete(id);
        await act(async () => callback(performance.now()));
      }
      expect(frames.size).toBe(0);
    };
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const answer: ChatMessage = { ...userMessage(1, "The saved answer."), id: "answer-1", role: "assistant" };
    const followUp: ChatMessage = { ...userMessage(1, "Bound the maximum recovery delay."), id: "follow-up-1" };
    render(<div ref={scrollElementRef}><div ref={timelineElementRef}>
      <ResponseTimeline
        turns={[{ ...agentTurn(1), terminalAssistantMessageId: answer.id }, agentTurn(2)]}
        messages={[userMessage(1, "Original request."), answer, followUp, userMessage(2, "Next request.")]}
        activities={[]} reasonings={[]} plans={[]} checkpoints={[]}
        projectRoot="/workspace" projectId="project-1" conversationId={conversationId}
        streamingText="" streamingReasoning="" approvals={[]} inputRequests={[]}
        showTimestamps={false} showThinking={false} defaultCodeWrap={false}
        autoCollapseWorkLog showChangedFileSummaries={false} checkpointRestoreDisabled={false}
        scrollElementRef={scrollElementRef} timelineElementRef={timelineElementRef}
        onRespondToApproval={async () => undefined} onRespondToInput={async () => undefined}
        onRevertCheckpoint={() => undefined} onOpenTurnDiff={() => undefined}
        onCompareTurnArtifacts={() => undefined} onOpenTurnFile={() => undefined} onStop={() => undefined}
      />
    </div></div>);
    await runFrames();
    const scroll = scrollElementRef.current!;
    const root = timelineElementRef.current!;
    const rows = root.querySelectorAll<HTMLElement>("[data-response-row-id]");
    const toggle = root.querySelector<HTMLButtonElement>(".turn-run-details-toggle")!;
    const expanded = (): boolean => toggle.getAttribute("aria-expanded") === "true";
    let scrollTop = 0;
    const positions: number[] = [];
    Object.defineProperty(scroll, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value; positions.push(value); } });
    scroll.getBoundingClientRect = () => rect(0, 600);
    rows[0]!.getBoundingClientRect = () => rect(40 - scrollTop, expanded() ? 1_400 : 100);
    rows[1]!.getBoundingClientRect = () => rect((expanded() ? 1_500 : 200) - scrollTop, 100);
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.dataset.followUpMessageId === followUp.id ? rect(1_200 - scrollTop, 60) : originalBounds.call(this);
    });
    vi.spyOn(scroll, "scrollTo").mockImplementation((options?: ScrollToOptions | number, top?: number) => {
      scroll.scrollTop = typeof options === "object" ? options.top ?? scroll.scrollTop : top ?? scroll.scrollTop;
    });
    act(() => requestMessageSearchFocus({ projectId: "project-1", conversationId, turnId: "turn-1", messageId: followUp.id }));
    await runFrames();
    const destination = root.querySelector<HTMLElement>(`[data-follow-up-message-id="${followUp.id}"]`)!;
    expect(destination).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(destination.getBoundingClientRect().top).toBe(0);
    const exactNavigation = positions.indexOf(1_200);
    expect(exactNavigation).toBeGreaterThanOrEqual(0);
    expect(positions.slice(exactNavigation).every((position) => position === 1_200)).toBe(true);
  });

  it("restores the following turn to its captured viewport position", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    render(
      <div ref={scrollElementRef}>
        <div ref={timelineElementRef}>
          <ResponseTimeline
            turns={[agentTurn(1), agentTurn(2)]}
            messages={[
              userMessage(1, "Long pasted requirement. ".repeat(100)),
              userMessage(2, "Keep this request anchored."),
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
            checkpointRestoreDisabled={false}
            scrollElementRef={scrollElementRef}
            timelineElementRef={timelineElementRef}
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
    const runFrames = async (): Promise<void> => {
      await act(async () => {
        while (frames.length > 0) frames.shift()!(performance.now());
      });
    };
    await runFrames();

    const scroll = scrollElementRef.current!;
    const rows = timelineElementRef.current!
      .querySelectorAll<HTMLElement>("[data-response-row-id]");
    const first = rows[0]!;
    const second = rows[1]!;
    let firstHeight = 100;
    let secondDocumentTop = 200;
    scroll.getBoundingClientRect = () => rect(0, 600);
    first.getBoundingClientRect = () =>
      rect(40 - scroll.scrollTop, firstHeight);
    second.getBoundingClientRect = () =>
      rect(secondDocumentTop - scroll.scrollTop, 100);

    fireEvent.click(screen.getByRole("button", {
      name: "Show full message",
    }));
    firstHeight = 400;
    secondDocumentTop = 500;
    await runFrames();

    expect(screen.getByRole("button", { name: "Show less" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(scroll.scrollTop).toBe(300);
    expect(second.getBoundingClientRect().top).toBe(200);
  });
});
