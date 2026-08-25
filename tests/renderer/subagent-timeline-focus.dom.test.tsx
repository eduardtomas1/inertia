import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type {
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";
import { requestTimelineFocus } from "../../src/renderer/src/utils/timelineFocus";

function turn(conversationId: string, id: string): AgentTurn {
  const at = "2030-01-01T00:00:00.000Z";
  return {
    id,
    conversationId,
    runId: `run-${id}`,
    userMessageId: `message-${id}`,
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      backendConfigurationRevision: 0,
      modelId: "gpt-test",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 0,
      endpointIdentity: null,
      modelIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-test",
    modelAlias: null,
    reasoningEffort: "",
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
    configurationRevision: 0,
    association: "authoritative",
    createdAt: at,
    updatedAt: at,
  };
}

function message(conversationId: string, turnId: string): ChatMessage {
  return {
    id: `message-${turnId}`,
    conversationId,
    turnId,
    role: "user",
    content: `Request for ${turnId}`,
    attachments: [],
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("delegated-agent parent-turn navigation", () => {
  it("focuses only the matching split transcript and ignores malformed requests", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);
    const firstConversation = "11111111-1111-4111-8111-111111111111";
    const secondConversation = "22222222-2222-4222-8222-222222222222";
    const firstTurn = turn(firstConversation, "turn-first");
    const secondTurn = turn(secondConversation, "turn-second");
    const firstTimeline = createRef<HTMLDivElement>();
    const secondTimeline = createRef<HTMLDivElement>();
    const firstNavigationIntent = vi.fn();
    const secondNavigationIntent = vi.fn();
    const common = {
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
      projectRoot: "/workspace",
      projectId: "project-1",
      streamingText: "",
      streamingReasoning: "",
      approvals: [],
      inputRequests: [],
      showTimestamps: false,
      showThinking: false,
      defaultCodeWrap: false,
      autoCollapseWorkLog: true,
      showChangedFileSummaries: false,
      checkpointRestoreDisabled: false,
      onRespondToApproval: async () => undefined,
      onRespondToInput: async () => undefined,
      onRevertCheckpoint: () => undefined,
      onOpenTurnDiff: () => undefined,
      onCompareTurnArtifacts: () => undefined,
      onOpenTurnFile: () => undefined,
      onStop: () => undefined,
    };

    render(
      <>
        <div ref={firstTimeline}>
          <ResponseTimeline
            {...common}
            conversationId={firstConversation}
            turns={[firstTurn]}
            messages={[message(firstConversation, firstTurn.id)]}
            timelineElementRef={firstTimeline}
            onReaderNavigationIntent={firstNavigationIntent}
          />
        </div>
        <div ref={secondTimeline}>
          <ResponseTimeline
            {...common}
            conversationId={secondConversation}
            turns={[secondTurn]}
            messages={[message(secondConversation, secondTurn.id)]}
            timelineElementRef={secondTimeline}
            onReaderNavigationIntent={secondNavigationIntent}
          />
        </div>
      </>,
    );

    act(() => requestTimelineFocus({
      conversationId: secondConversation,
      turnId: secondTurn.id,
    }));
    expect(document.activeElement).toHaveAttribute("data-turn-id", secondTurn.id);
    expect(secondNavigationIntent).toHaveBeenCalledTimes(1);
    expect(firstNavigationIntent).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new CustomEvent("inertia:timeline-focus", {
        detail: { conversationId: secondConversation, turnId: 42 },
      }));
    });
    expect(document.activeElement).toHaveAttribute("data-turn-id", secondTurn.id);
    expect(secondNavigationIntent).toHaveBeenCalledTimes(1);

    act(() => requestTimelineFocus({
      conversationId: firstConversation,
      turnId: firstTurn.id,
    }));
    expect(document.activeElement).toHaveAttribute("data-turn-id", firstTurn.id);
    expect(firstNavigationIntent).toHaveBeenCalledTimes(1);
  });
});
