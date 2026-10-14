import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import type { ResponseTimelineProps } from "../../src/renderer/src/components/ResponseTimeline";
import {
  estimateTimelineItemRenderWeight,
  estimateTimelineRowSize,
} from "../../src/renderer/src/utils/responseTimeline";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";

vi.mock("../../src/renderer/src/utils/responseTimeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/utils/responseTimeline")>();
  return {
    ...actual,
    estimateTimelineRowSize: vi.fn(actual.estimateTimelineRowSize),
    estimateTimelineItemRenderWeight: vi.fn(actual.estimateTimelineItemRenderWeight),
  };
});

const conversationId = "13131313-1313-4131-8131-131313131313";

function at(index: number): string {
  return new Date(Date.UTC(2030, 2, 1, 10, 0, index)).toISOString();
}

function settledTurn(index: number): AgentTurn {
  const id = `turn-${index}`;
  return {
    id, conversationId, runId: `run-${index}`, userMessageId: `request-${index}`,
    terminalAssistantMessageId: `answer-${index}`, providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server", backendConfigurationRevision: 1, modelId: "gpt-5.6",
      alias: null, reasoningEffort: "high", contextWindowOverride: null, providerOptions: {}, capabilities: [],
    },
    continuationIdentity: {
      harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1, endpointIdentity: null, modelIdentity: "gpt-5.6",
    },
    harnessId: "codex-app-server", backendProfileId: "native:codex:app-server", model: "gpt-5.6",
    modelAlias: null, reasoningEffort: "high", interactionMode: "build", accessMode: "supervised",
    providerSessionBefore: null, providerSessionAfter: null, requestedAt: at(index), startedAt: at(index),
    completedAt: at(index), status: "completed", terminalReason: null, checkpointId: null,
    usageAtStart: null, usageAtCompletion: null, configurationRevision: 1, association: "authoritative",
    createdAt: at(index), updatedAt: at(index),
  };
}

function turnMessages(index: number): ChatMessage[] {
  return [
    { id: `request-${index}`, conversationId, turnId: `turn-${index}`, role: "user",
      content: `Request ${index}`, attachments: [], createdAt: at(index) },
    { id: `answer-${index}`, conversationId, turnId: `turn-${index}`, role: "assistant",
      content: `Answer ${index}\n\n${"A settled paragraph. ".repeat(12)}`, attachments: [], createdAt: at(index) },
  ];
}

const noop = (): void => undefined;
const respond = async (): Promise<void> => undefined;

const turns = Array.from({ length: 80 }, (_, index) => settledTurn(index));
const messages = turns.map((_, index) => turnMessages(index));

function props(indexes: number[]): ResponseTimelineProps {
  return {
    turns: indexes.map((index) => turns[index]!), messages: indexes.flatMap((index) => messages[index]!),
    activities: [], reasonings: [],
    plans: [], checkpoints: [], projectRoot: "/workspace", projectId: "project-history-prepend", conversationId,
    streamingText: "", streamingReasoning: "", streamingChannel: null, approvals: [], inputRequests: [],
    showTimestamps: false, showThinking: false, defaultCodeWrap: false, autoCollapseWorkLog: true,
    showChangedFileSummaries: false, checkpointRestoreDisabled: false, onRespondToApproval: respond,
    onRespondToInput: respond, onRevertCheckpoint: noop, onOpenTurnDiff: noop, onCompareTurnArtifacts: noop,
    onOpenTurnFile: noop, onStop: noop,
  };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, offset) => from + offset);
}

function estimatedTurnIds(spy: typeof estimateTimelineRowSize | typeof estimateTimelineItemRenderWeight): Set<string> {
  return new Set(vi.mocked(spy).mock.calls.map(([item]) => item.id));
}

afterEach(() => {
  cleanup();
  vi.mocked(estimateTimelineRowSize).mockClear();
  vi.mocked(estimateTimelineItemRenderWeight).mockClear();
});

describe("response timeline history prepend", () => {
  it("estimates only the rows of an older page when it is prepended", () => {
    const view = render(<ResponseTimeline {...props(range(40, 80))} />);
    expect(estimatedTurnIds(estimateTimelineRowSize).size).toBeGreaterThan(0);
    vi.mocked(estimateTimelineRowSize).mockClear();
    vi.mocked(estimateTimelineItemRenderWeight).mockClear();

    view.rerender(<ResponseTimeline {...props(range(0, 80))} />);

    const olderPage = new Set(range(0, 40).map((index) => `turn-${index}`));
    expect([...estimatedTurnIds(estimateTimelineItemRenderWeight)].filter((id) => !olderPage.has(id))).toEqual([]);
    expect([...estimatedTurnIds(estimateTimelineRowSize)].filter((id) => !olderPage.has(id))).toEqual([]);
    expect(document.querySelector('[role="feed"]')?.getAttribute("aria-label")).toBe("80 conversation turns");
  });
});
