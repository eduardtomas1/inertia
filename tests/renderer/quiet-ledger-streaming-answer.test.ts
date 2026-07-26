import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import {
  ResponseTimeline,
  resolveFinalAnswerPresentation,
} from "../../src/renderer/src/components/ResponseTimeline";

const conversationId = "11111111-1111-4111-8111-111111111111";

function message(
  id: string,
  turnId: string,
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id,
    conversationId,
    turnId,
    role,
    content,
    attachments: [],
    createdAt: "2026-07-26T10:00:08.000Z",
  };
}

function agentTurn(
  status: AgentTurn["status"],
  terminalAssistantMessageId: string | null,
): AgentTurn {
  return {
    id: "turn-streaming-answer",
    conversationId,
    runId: "run-streaming-answer",
    userMessageId: "user-streaming-answer",
    terminalAssistantMessageId,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: "latest",
      reasoningEffort: "xhigh",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 3,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 3,
      modelIdentity: "gpt-5.6",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: "latest",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: status === "completed" ? "session-after" : null,
    requestedAt: "2026-07-26T10:00:00.000Z",
    startedAt: "2026-07-26T10:00:02.000Z",
    completedAt: status === "completed" ? "2026-07-26T10:00:10.000Z" : null,
    status,
    terminalReason: status === "completed" ? "provider-completed" : null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 3,
    association: "authoritative",
    createdAt: "2026-07-26T10:00:00.000Z",
    updatedAt: "2026-07-26T10:00:08.000Z",
  };
}

function renderTimeline(
  turn: AgentTurn,
  messages: ChatMessage[],
  streamingText: string,
): string {
  return renderToStaticMarkup(createElement(ResponseTimeline, {
    turns: [turn],
    messages,
    activities: [],
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-1",
    conversationId,
    providers: [],
    streamingText,
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
  }));
}

describe("Quiet Ledger streaming answer handoff", () => {
  it("keeps active prose in the work transcript and retains it through the persistence gap on settle", () => {
    const draft = "Draft answer\n\n```ts\nconst stable = true;";
    const streaming = resolveFinalAnswerPresentation({
      isActive: true,
      terminalAssistantMessage: null,
    }, draft, "");
    expect(streaming).toBeNull();

    const settling = resolveFinalAnswerPresentation({
      isActive: false,
      terminalAssistantMessage: null,
    }, "", draft);
    expect(settling).toMatchObject({
      content: draft,
      phase: "settling",
      markdownStreaming: true,
      showCaret: false,
      terminalAnswer: null,
    });
  });

  it("renders live prose in sequence and promotes only the persisted terminal message to the answer document", () => {
    const userMessage = message(
      "user-streaming-answer",
      "turn-streaming-answer",
      "user",
      "Show the answer separately",
    );
    const liveHtml = renderTimeline(
      agentTurn("running", null),
      [userMessage],
      "Live answer\n\n```futurelang\nsome <unsafe> code",
    );

    const terminalMessage = message(
      "assistant-streaming-answer",
      "turn-streaming-answer",
      "assistant",
      "Authoritative persisted answer",
    );
    const handoffHtml = renderTimeline(
      agentTurn("running", terminalMessage.id),
      [userMessage, terminalMessage],
      "STALE STREAM MUST NOT RENDER",
    );

    expect(liveHtml).not.toContain("turn-final-answer-document");
    expect(liveHtml).toContain("turn-commentary-row is-streaming");
    expect(liveHtml).toContain('aria-label="Live agent update"');
    expect(liveHtml).toContain("response-code-block");
    expect(liveHtml).toContain("some &lt;unsafe&gt; code");
    expect(liveHtml.match(/streaming-caret/gu)).toHaveLength(1);

    expect(handoffHtml.match(/turn-final-answer-document/gu)).toHaveLength(1);
    expect(handoffHtml).toContain('data-turn-layer="final-answer"');
    expect(handoffHtml).toContain('data-answer-phase="persisted"');
    expect(handoffHtml).toContain('data-terminal-answer-id="assistant-streaming-answer"');
    expect(handoffHtml.match(/Authoritative persisted answer/gu)).toHaveLength(1);
    expect(handoffHtml).not.toContain("STALE STREAM MUST NOT RENDER");
    expect(handoffHtml).not.toContain("streaming-caret");
  });
});
