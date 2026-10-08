import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/ResponseTimeline";
import { StreamingPlainText } from "../../src/renderer/src/components/response-timeline/activity";
import { CONVERSATION_HISTORY_PREPEND_EVENT } from "../../src/renderer/src/utils/conversationHistoryNavigation";
import { summarizeActivities } from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

vi.mock("../../src/renderer/src/utils/responseTimeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/utils/responseTimeline")>();
  return { ...actual, summarizeActivities: vi.fn(actual.summarizeActivities) };
});

const conversationId = "12121212-1212-4121-8121-121212121212";
const turnId = "turn-render-stability";
const runId = "run-render-stability";

function at(seconds: number): string {
  return `2030-03-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function runningTurn(): AgentTurn {
  return {
    id: turnId,
    conversationId,
    runId,
    userMessageId: "request-render-stability",
    terminalAssistantMessageId: null,
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
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(0),
    updatedAt: at(1),
  };
}

function chatMessage(id: string, role: ChatMessage["role"], content: string, createdAt: string): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt };
}

function command(id: string, seconds: number): AgentActivity {
  return {
    id,
    conversationId,
    runId,
    turnId,
    kind: "command",
    title: `Run check ${id}`,
    detail: null,
    status: "completed",
    createdAt: at(seconds),
  };
}

const turns = [runningTurn()];
const messages = [
  chatMessage("request-render-stability", "user", "Inspect the project.", at(0)),
  chatMessage("commentary-render-stability", "assistant", "Checking the first results.", at(4)),
];
const noop = (): void => undefined;
const respond = async (): Promise<void> => undefined;

function timelineProps(
  activities: AgentActivity[],
  streamingText: string,
  overrides: Partial<ResponseTimelineProps> = {},
): ResponseTimelineProps {
  return {
    turns,
    messages,
    activities,
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-render-stability",
    conversationId,
    streamingText,
    streamingReasoning: "",
    streamingChannel: streamingText ? "text" : null,
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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(summarizeActivities).mockClear();
});

describe("response timeline render stability", () => {
  it("keeps the history prepend listener registered across streaming deltas", () => {
    const scrollElementRef = createRef<HTMLDivElement>();
    const timelineElementRef = createRef<HTMLDivElement>();
    const refs = { scrollElementRef, timelineElementRef, onReaderNavigationIntent: noop };
    const activities = [command("activity-1", 2)];
    const scene = (text: string) => (
      <div ref={scrollElementRef}>
        <div ref={timelineElementRef}>
          <ResponseTimeline {...timelineProps(activities, text, refs)} />
        </div>
      </div>
    );
    const view = render(scene("Streaming"));
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");

    view.rerender(scene("Streaming a"));
    view.rerender(scene("Streaming a longer"));
    view.rerender(scene("Streaming a longer answer"));

    const prependCalls = (spy: typeof added) => spy.mock.calls
      .filter(([type]) => type === CONVERSATION_HISTORY_PREPEND_EVENT);
    expect(document.querySelector(".turn-commentary-row.is-streaming")?.textContent)
      .toContain("Streaming a longer answer");
    expect(prependCalls(added)).toHaveLength(0);
    expect(prependCalls(removed)).toHaveLength(0);
  });

  it("summarizes only the activity group that changed when a live turn gains an activity", () => {
    const first = [command("activity-1", 2), command("activity-2", 3)];
    const second = [command("activity-3", 5), command("activity-4", 6)];
    const view = render(<ResponseTimeline {...timelineProps([...first, ...second], "")} />);
    expect(document.querySelectorAll("[data-activity-group]")).toHaveLength(2);
    const summarize = vi.mocked(summarizeActivities);
    summarize.mockClear();

    view.rerender(<ResponseTimeline {...timelineProps(
      [...first, ...second, command("activity-5", 7)],
      "",
    )} />);

    expect(document.querySelectorAll("[data-activity-group]")).toHaveLength(2);
    expect(summarize.mock.calls.map(([activities]) => activities.map(({ id }) => id)))
      .toEqual([["activity-3", "activity-4", "activity-5"]]);
  });

  it("keeps live paragraphs mounted as text streams and adds one block per new paragraph", () => {
    const view = render(<StreamingPlainText content="First paragraph" />);
    const blocks = () => [...document.querySelectorAll(".response-stream-block")];
    const first = blocks()[0];
    expect(blocks()).toHaveLength(1);

    view.rerender(<StreamingPlainText content="First paragraph keeps growing" />);
    expect(blocks()).toHaveLength(1);
    expect(blocks()[0]).toBe(first);

    view.rerender(<StreamingPlainText content={"First paragraph keeps growing\n\nSecond"} />);
    expect(blocks()).toHaveLength(2);
    expect(blocks()[0]).toBe(first);
    expect(blocks()[1]?.textContent).toBe("Second");
    expect(document.querySelector("p")?.textContent).toBe("First paragraph keeps growing\n\nSecond");
    expect(document.querySelectorAll(".response-stream-word")).toHaveLength(0);
  });
});
