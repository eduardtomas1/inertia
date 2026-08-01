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
  vi.unstubAllGlobals();
});

describe("long user request expansion", () => {
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
