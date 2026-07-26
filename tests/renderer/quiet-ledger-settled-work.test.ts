import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import {
  buildResponseTimeline,
  turnExecutionElapsedMs,
  turnQueueElapsedMs,
  turnTimingLabels,
  workSummaryLabel,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const conversationId = "11111111-1111-4111-8111-111111111111";
const requestedAt = "2026-07-23T10:00:00.000Z";

function turn(
  id: string,
  update: Partial<AgentTurn> = {},
): AgentTurn {
  return {
    id,
    conversationId,
    runId: `run-${id}`,
    userMessageId: `user-${id}`,
    terminalAssistantMessageId: `answer-${id}`,
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
    providerSessionAfter: "session-after",
    requestedAt,
    startedAt: "2026-07-23T10:00:08.000Z",
    completedAt: "2026-07-23T10:01:50.000Z",
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 3,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: "2026-07-23T10:01:50.000Z",
    ...update,
  };
}

function message(
  id: string,
  turnId: string,
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
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
  update: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id,
    conversationId,
    runId: `run-${turnId}`,
    turnId,
    kind: "tool",
    title: "Read source",
    detail: null,
    status: "completed",
    createdAt: "2026-07-23T10:00:20.000Z",
    ...update,
  };
}

function responseTurn(agentTurn: AgentTurn, activities: AgentActivity[] = []): ResponseTurn {
  const item = buildResponseTimeline({
    turns: [agentTurn],
    messages: [
      message(agentTurn.userMessageId, agentTurn.id, "user", "Do the work", agentTurn.requestedAt),
      message(
        agentTurn.terminalAssistantMessageId!,
        agentTurn.id,
        "assistant",
        "The final answer is editorial.",
        agentTurn.completedAt!,
      ),
    ],
    activities,
    reasonings: [],
    checkpoints: [],
  })[0];
  if (item?.kind !== "turn") throw new Error("Expected an authoritative response turn.");
  return item.turn;
}

function renderTurn(agentTurn: AgentTurn, activities: AgentActivity[]): string {
  return renderToStaticMarkup(createElement(ResponseTimeline, {
    turns: [agentTurn],
    messages: [
      message(agentTurn.userMessageId, agentTurn.id, "user", "Do the work", agentTurn.requestedAt),
      message(
        agentTurn.terminalAssistantMessageId!,
        agentTurn.id,
        "assistant",
        "The final answer is editorial.",
        agentTurn.completedAt!,
      ),
    ],
    activities,
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-1",
    conversationId,
    providers: [],
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
  }));
}

describe("Quiet Ledger settled work summary", () => {
  it("uses authoritative queue/execution timing and counts only tool activity as actions", () => {
    const completed = responseTurn(turn("completed"), [
      activity("read", "completed"),
      activity("edit", "completed", { kind: "file", title: "Edit source" }),
      activity("status", "completed", { kind: "status", title: "Provider settled" }),
    ]);

    expect(turnQueueElapsedMs(completed)).toBe(8_000);
    expect(turnExecutionElapsedMs(completed)).toBe(102_000);
    expect(turnTimingLabels(completed)).toEqual(["Queued 8s", "Worked 1m 42s"]);
    expect(workSummaryLabel(completed)).toBe("Worked for 1m 42s · 2 actions");
  });

  it("labels failed, stopped, never-started, and no-tool terminal states", () => {
    const failed = responseTurn(turn("failed", {
      status: "failed",
      completedAt: "2026-07-23T10:00:44.000Z",
      updatedAt: "2026-07-23T10:00:44.000Z",
      terminalReason: "provider-failed",
    }), [activity("failed-command", "failed", { kind: "command", status: "failed" })]);
    const stopped = responseTurn(turn("stopped", {
      status: "cancelled",
      completedAt: "2026-07-23T10:00:26.000Z",
      updatedAt: "2026-07-23T10:00:26.000Z",
      terminalReason: "user-cancelled",
    }), [
      activity("read-stopped", "stopped"),
      activity("edit-stopped", "stopped", { kind: "file" }),
    ]);
    const beforeStarting = responseTurn(turn("before-starting", {
      status: "interrupted",
      startedAt: null,
      completedAt: "2026-07-23T10:00:04.000Z",
      updatedAt: "2026-07-23T10:00:04.000Z",
      terminalReason: "provider-interrupted",
    }));
    const noTools = responseTurn(turn("no-tools"), [
      activity("warning-only", "no-tools", {
        kind: "status",
        title: "Warning: fallback used",
      }),
    ]);

    expect(workSummaryLabel(failed)).toBe("Failed after 36s · 1 action");
    expect(workSummaryLabel(stopped)).toBe("Stopped after 18s · 2 actions");
    expect(turnExecutionElapsedMs(beforeStarting)).toBeNull();
    expect(turnQueueElapsedMs(beforeStarting)).toBe(4_000);
    expect(workSummaryLabel(beforeStarting)).toBe("Stopped before starting");
    expect(noTools.toolCallCount).toBe(0);
    expect(workSummaryLabel(noTools)).toBe("Completed without tool activity");
  });

  it("renders one quiet settled row, collapsed Details, and important activity beneath it", () => {
    const agentTurn = turn("rendered");
    const html = renderTurn(agentTurn, [
      activity("successful-read", agentTurn.id),
      activity("warning", agentTurn.id, {
        kind: "status",
        title: "Warning: provider fallback used",
        createdAt: "2026-07-23T10:00:30.000Z",
      }),
      activity("failed-command", agentTurn.id, {
        kind: "command",
        title: "Tests failed",
        status: "failed",
        createdAt: "2026-07-23T10:00:40.000Z",
      }),
    ]);

    expect(html).toContain('class="turn-execution-rail is-settled"');
    expect(html).toContain('data-settled-work-status="completed"');
    expect(html).toContain("Worked for 1m 42s · 2 actions");
    expect(html).toContain('class="turn-settled-summary" aria-expanded="false"');
    expect(html).toContain(">Details</small>");

    const detailsStart = html.indexOf("<details");
    const detailsEnd = html.indexOf("</details>", detailsStart);
    const details = html.slice(detailsStart, detailsEnd);
    expect(details).toContain("Read source");
    expect(details).not.toContain("Warning: provider fallback used");
    expect(details).not.toContain("Tests failed");
    expect(html.indexOf("Warning: provider fallback used")).toBeGreaterThan(detailsEnd);
    expect(html.indexOf("Tests failed")).toBeGreaterThan(detailsEnd);
    expect(html.indexOf('data-turn-layer="final-answer"'))
      .toBeGreaterThan(html.indexOf('data-turn-layer="agent-execution"'));
  });

  it("renders a settled ledger row even when a completed turn has no work details", () => {
    const html = renderTurn(turn("no-detail-render"), []);

    expect(html).toContain('class="turn-execution-rail is-settled"');
    expect(html).toContain('data-settled-work-summary="static"');
    expect(html).toContain("Completed without tool activity");
    expect(html).toContain('data-turn-layer="final-answer"');
  });
});
