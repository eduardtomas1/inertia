import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";
import {
  ResponseTimeline,
  resolveFinalAnswerPresentation,
} from "../../src/renderer/src/components/ResponseTimeline";
import {
  MAX_ANIMATED_STREAM_WORDS,
  StreamingPlainText,
} from "../../src/renderer/src/components/response-timeline/activity";
import {
  buildResponseTimeline,
  buildTurnExecutionStream,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";

const conversationId = "11111111-1111-4111-8111-111111111111";

function message(
  id: string,
  turnId: string,
  role: ChatMessage["role"],
  content: string,
  createdAt = "2026-07-26T10:00:08.000Z",
): ChatMessage {
  return {
    id,
    conversationId,
    turnId,
    role,
    content,
    attachments: [],
    createdAt,
  };
}

function activity(
  id: string,
  turnId: string,
  createdAt: string,
): AgentActivity {
  return {
    id,
    conversationId,
    runId: "run-streaming-answer",
    turnId,
    kind: "tool",
    title: "Read source",
    detail: null,
    status: "completed",
    createdAt,
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
  activities: AgentActivity[] = [],
  streamingChannel: "text" | null = null,
): string {
  return renderToStaticMarkup(createElement(ResponseTimeline, {
    turns: [turn],
    messages,
    activities,
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-1",
    conversationId,
    streamingText,
    streamingReasoning: "",
    streamingChannel,
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

function authoritativeTurn(
  turn: AgentTurn,
  messages: ChatMessage[],
  activities: AgentActivity[],
): ResponseTurn {
  const item = buildResponseTimeline({
    turns: [turn],
    messages,
    activities,
    reasonings: [],
    checkpoints: [],
  }).find((candidate) => candidate.kind === "turn");
  if (!item || item.kind !== "turn") throw new Error("Expected an authoritative turn.");
  return item.turn;
}

describe("Quiet Ledger streaming answer handoff", () => {
  it("keeps active prose in the work transcript and waits for the authoritative terminal message", () => {
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
    expect(settling).toBeNull();
  });

  it("renders live prose in sequence and promotes only a settled persisted terminal message", () => {
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
      [],
      "text",
    );

    const terminalMessage = message(
      "assistant-streaming-answer",
      "turn-streaming-answer",
      "assistant",
      "Authoritative persisted answer",
    );
    const activeTerminalHtml = renderTimeline(
      agentTurn("running", terminalMessage.id),
      [userMessage, terminalMessage],
      "STALE STREAM MUST NOT RENDER",
    );
    const handoffHtml = renderTimeline(
      agentTurn("completed", terminalMessage.id),
      [userMessage, terminalMessage],
      "STALE STREAM MUST NOT RENDER",
    );

    expect(liveHtml).not.toContain("turn-final-answer-document");
    expect(liveHtml).toContain("turn-commentary-row is-streaming");
    expect(liveHtml).toContain('aria-label="Live agent update"');
    expect(liveHtml).toContain('data-stream-renderer="plain-text"');
    expect(liveHtml).toContain('data-stream-motion="word-reveal"');
    expect(liveHtml).not.toContain("response-code-block");
    expect(liveHtml).toContain(
      '<span class="response-stream-word">&lt;unsafe&gt;</span>',
    );
    expect(liveHtml).not.toContain("<unsafe>");
    expect(liveHtml.match(/response-markdown is-streaming is-plain-stream/gu)).toHaveLength(1);
    expect(liveHtml).not.toContain('class="streaming-caret"');

    expect(activeTerminalHtml).not.toContain("turn-final-answer-document");
    expect(activeTerminalHtml).not.toContain("Authoritative persisted answer");
    expect(activeTerminalHtml).not.toContain("STALE STREAM MUST NOT RENDER");

    expect(handoffHtml.match(/turn-final-answer-document/gu)).toHaveLength(1);
    expect(handoffHtml).toContain('data-turn-layer="final-answer"');
    expect(handoffHtml).toContain('data-answer-phase="persisted"');
    expect(handoffHtml).toContain('data-terminal-answer-id="assistant-streaming-answer"');
    expect(handoffHtml.match(/Authoritative persisted answer/gu)).toHaveLength(1);
    expect(handoffHtml).not.toContain("STALE STREAM MUST NOT RENDER");
    expect(handoffHtml).not.toContain("streaming-caret");
  });

  it("bounds animated live words while preserving the complete escaped stream", () => {
    const words = Array.from({ length: 120 }, (_, index) => `word-${index}`);
    const content = `${words.join(" ")} <unsafe>`;
    const html = renderToStaticMarkup(createElement(StreamingPlainText, {
      content,
    }));

    expect(html.match(/class="response-stream-word"/gu)).toHaveLength(
      MAX_ANIMATED_STREAM_WORDS,
    );
    expect(html).toContain("word-0 word-1");
    expect(html).toContain("word-119");
    expect(html).toContain("&lt;unsafe&gt;");
    expect(html).not.toContain("<unsafe>");
  });

  it("keeps commentary, activity, later commentary, and the transient tail in chronological segments", () => {
    const turn = agentTurn("running", null);
    const at = (seconds: number): string =>
      `2026-07-26T10:00:${String(seconds).padStart(2, "0")}.000Z`;
    const messages = [
      message(
        "user-streaming-answer",
        turn.id,
        "user",
        "Inspect, then explain.",
        at(0),
      ),
      message(
        "assistant-commentary-before",
        turn.id,
        "assistant",
        "I’m checking the implementation.",
        at(3),
      ),
      message(
        "assistant-commentary-after",
        turn.id,
        "assistant",
        "The source confirms the behavior.",
        at(7),
      ),
    ];
    const activities = [activity("activity-between-commentary", turn.id, at(5))];
    const responseTurn = authoritativeTurn(turn, messages, activities);
    const stream = buildTurnExecutionStream(responseTurn, {
      liveContent: "I’m writing the final response.",
    });

    expect(stream.map(({ kind, id }) => [kind, id])).toEqual([
      ["commentary", "assistant-commentary-before"],
      ["activity-group", "activity-group:activity-between-commentary"],
      ["commentary", "assistant-commentary-after"],
      ["commentary", `live-commentary:${turn.id}`],
    ]);

    const html = renderTimeline(
      turn,
      messages,
      "I’m writing the final response.",
      activities,
      "text",
    );
    const before = html.indexOf("I’m checking the implementation.");
    const work = html.indexOf("Read source");
    const after = html.indexOf("The source confirms the behavior.");
    const live = html.indexOf(
      `data-assistant-commentary-id="live-commentary:${turn.id}"`,
    );
    expect(before).toBeGreaterThanOrEqual(0);
    expect(work).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(work);
    expect(live).toBeGreaterThan(after);
    expect(html).toContain('<span class="response-stream-word">I’m</span>');
    expect(html).toContain(
      'data-assistant-commentary-id="assistant-commentary-before"',
    );
    expect(html).toContain(
      'data-assistant-commentary-id="assistant-commentary-after"',
    );
    expect(html).toContain(
      `data-assistant-commentary-id="live-commentary:${turn.id}"`,
    );
    expect(html.match(/turn-commentary-row is-streaming/gu)).toHaveLength(1);
    expect(html.match(/response-markdown is-streaming/gu)).toHaveLength(1);
    expect(html).not.toContain('class="streaming-caret"');
    expect(html).not.toContain("turn-final-answer-document");
  });

  it("shows no surrogate answer during the settlement gap", () => {
    const turn = {
      ...agentTurn("completed", null),
      updatedAt: "2026-07-26T10:00:10.000Z",
    };
    const html = renderTimeline(
      turn,
      [message(
        "user-streaming-answer",
        turn.id,
        "user",
        "Wait for persistence.",
      )],
      "STALE DRAFT MUST NOT SURVIVE SETTLEMENT",
    );

    expect(html).toContain(`data-response-row-id="${turn.id}"`);
    expect(html).not.toContain("STALE DRAFT MUST NOT SURVIVE SETTLEMENT");
    expect(html).not.toContain("turn-commentary-row");
    expect(html).not.toContain("turn-final-answer-document");
    expect(html).not.toContain("data-turn-layer=\"supporting-ledger\"");
  });

  it("renders terminal text once even when the cleared transient tail has identical content", () => {
    const terminalText = "Authoritative persisted answer";
    const terminalMessage = message(
      "assistant-streaming-answer",
      "turn-streaming-answer",
      "assistant",
      terminalText,
    );
    const html = renderTimeline(
      agentTurn("completed", terminalMessage.id),
      [
        message(
          "user-streaming-answer",
          "turn-streaming-answer",
          "user",
          "Do not duplicate the final response.",
        ),
        terminalMessage,
      ],
      terminalText,
    );

    expect(html.match(/turn-final-answer-document/gu)).toHaveLength(1);
    expect(html.match(/Authoritative persisted answer/gu)).toHaveLength(1);
    expect(html).toContain('data-answer-phase="persisted"');
    expect(html).not.toContain("turn-commentary-row is-streaming");
    expect(html).not.toContain("streaming-caret");
    expect(html).not.toContain("turn-working-status");
  });

  it("keeps streamed tokens out of live regions and preserves stable keyed source contracts", () => {
    const turn = agentTurn("running", null);
    const html = renderTimeline(
      turn,
      [message(
        "user-streaming-answer",
        turn.id,
        "user",
        "Stream quietly.",
      )],
      "Token-by-token prose",
      [],
      "text",
    );
    const commentaryStart = html.indexOf('aria-label="Live agent update"');
    const commentaryEnd = html.indexOf("</article>", commentaryStart);
    const commentary = html.slice(commentaryStart, commentaryEnd);

    expect(commentary).toContain(
      `data-assistant-commentary-id="live-commentary:${turn.id}"`,
    );
    expect(commentary).not.toContain("aria-live");
    expect(commentary).not.toContain('role="status"');
    expect(commentary).toContain("response-markdown is-streaming");
    expect(commentary).not.toContain('class="streaming-caret"');

    const workstreamSource = readFileSync(
      new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
      "utf8",
    );
    const projectionSource = readFileSync(
      new URL("../../src/renderer/src/utils/response-timeline/execution.ts", import.meta.url),
      "utf8",
    );
    const projectionHookSource = readFileSync(
      new URL("../../src/renderer/src/hooks/useConversationProjection.ts", import.meta.url),
      "utf8",
    );
    expect(workstreamSource).toContain('key={entry.id}');
    expect(workstreamSource).toContain(
      'data-assistant-commentary-id={entry.message?.id ?? entry.id}',
    );
    expect(projectionSource).toContain('id: `live-commentary:${turn.id}`');
    expect(projectionHookSource).toMatch(
      /event\.type === "agent\.activity"[\s\S]*?closeTextStream\(\);[\s\S]*?event\.type === "agent\.text"/u,
    );
    expect(projectionHookSource).toMatch(
      /event\.type === "agent\.completed" \|\| event\.type === "agent\.failed"[\s\S]*?setStreaming\(closeStreamingChannelState\)[\s\S]*?setTerminalProjections/u,
    );
  });
});
