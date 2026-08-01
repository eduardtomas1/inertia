import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import {
  buildResponseTimeline,
  shouldConsolidateSettledWorkIntoRunDetails,
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
const activitySource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
  "utf8",
);
const viewportSource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/viewport.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

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
  const messages = [
    message(agentTurn.userMessageId, agentTurn.id, "user", "Do the work", agentTurn.requestedAt),
  ];
  if (agentTurn.terminalAssistantMessageId && agentTurn.completedAt) {
    messages.push(message(
      agentTurn.terminalAssistantMessageId,
      agentTurn.id,
      "assistant",
      "The final answer is editorial.",
      agentTurn.completedAt,
    ));
  }
  const item = buildResponseTimeline({
    turns: [agentTurn],
    messages,
    activities,
    reasonings: [],
    checkpoints: [],
  })[0];
  if (item?.kind !== "turn") throw new Error("Expected an authoritative response turn.");
  return item.turn;
}

function renderTurn(
  agentTurn: AgentTurn,
  activities: AgentActivity[],
  autoCollapseWorkLog = true,
): string {
  return renderTurns([agentTurn], activities, autoCollapseWorkLog);
}

function renderTurns(
  agentTurns: AgentTurn[],
  activities: AgentActivity[],
  autoCollapseWorkLog = true,
): string {
  const messages = agentTurns.flatMap((agentTurn) => {
    const turnMessages = [
      message(agentTurn.userMessageId, agentTurn.id, "user", "Do the work", agentTurn.requestedAt),
    ];
    if (agentTurn.terminalAssistantMessageId && agentTurn.completedAt) {
      turnMessages.push(message(
        agentTurn.terminalAssistantMessageId,
        agentTurn.id,
        "assistant",
        "The final answer is editorial.",
        agentTurn.completedAt,
      ));
    }
    return turnMessages;
  });
  return renderToStaticMarkup(createElement(ResponseTimeline, {
    turns: agentTurns,
    messages,
    activities,
    reasonings: [],
    plans: [],
    checkpoints: [],
    projectRoot: "/workspace",
    projectId: "project-1",
    conversationId,
    streamingText: "",
    streamingReasoning: "",
    approvals: [],
    inputRequests: [],
    showTimestamps: false,
    showThinking: false,
    defaultCodeWrap: false,
    autoCollapseWorkLog,
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
    const queued = responseTurn(turn("queued", {
      status: "queued",
      terminalAssistantMessageId: null,
      providerSessionAfter: null,
      startedAt: null,
      completedAt: null,
      updatedAt: requestedAt,
      terminalReason: null,
    }));
    const queuedNow = Date.parse("2026-07-23T10:00:12.000Z");

    expect(workSummaryLabel(failed)).toBe("Failed after 36s · 1 action");
    expect(workSummaryLabel(stopped)).toBe("Stopped after 18s · 2 actions");
    expect(turnExecutionElapsedMs(beforeStarting)).toBeNull();
    expect(turnQueueElapsedMs(beforeStarting)).toBe(4_000);
    expect(workSummaryLabel(beforeStarting)).toBe("Stopped before starting");
    expect(turnTimingLabels(beforeStarting)).toEqual([
      "Queued 4s",
      "Stopped before starting",
    ]);
    expect(noTools.toolCallCount).toBe(0);
    expect(workSummaryLabel(noTools)).toBe("Completed without tool activity");
    expect(turnExecutionElapsedMs(queued, queuedNow)).toBeNull();
    expect(turnQueueElapsedMs(queued, queuedNow)).toBe(12_000);
    expect(workSummaryLabel(queued, queuedNow)).toBe("Queued for 12s");
    expect(turnTimingLabels(queued, queuedNow)).toEqual(["Queued 12s"]);

    const queuedHtml = renderTurn(queued.agentTurn, []);
    expect(queuedHtml).toContain('data-active-work-state="queued"');
    expect(queuedHtml).toContain("Codex · Codex App Server is queued");
    expect(queuedHtml).not.toContain("turn-settled-summary");
  });

  it("consolidates only clean successful history with a persisted answer", () => {
    const clean = responseTurn(turn("clean"), [activity("read-clean", "clean")]);
    expect(shouldConsolidateSettledWorkIntoRunDetails(clean)).toBe(true);

    const exceptionalTurns: ResponseTurn[] = [
      { ...clean, importantActivities: [activity("warning-clean", "clean", {
        kind: "status",
        title: "Warning: fallback used",
      })] },
      { ...clean, agentTurn: turn("failed-clean", { status: "failed" }) },
      { ...clean, agentTurn: turn("stopped-clean", { status: "cancelled" }) },
      { ...clean, terminalAssistantMessage: null },
      { ...clean, approvals: [{} as ResponseTurn["approvals"][number]] },
      { ...clean, inputRequests: [{} as ResponseTurn["inputRequests"][number]] },
      { ...clean, systemMessages: [message(
        "notice-clean",
        "clean",
        "system",
        "Provider resumed the run.",
        requestedAt,
      )] },
    ];
    for (const exceptional of exceptionalTurns) {
      expect(shouldConsolidateSettledWorkIntoRunDetails(exceptional)).toBe(false);
    }
  });

  it("keeps a partial completed turn provider-scoped with important activity once beneath collapsed Details", () => {
    const agentTurn = turn("rendered");
    const html = renderTurn(agentTurn, [
      activity("successful-read", agentTurn.id),
      activity("warning", agentTurn.id, {
        kind: "status",
        title: "Warning: provider fallback used",
        detail: "The provider ignored one optional capability.",
        createdAt: "2026-07-23T10:00:30.000Z",
      }),
      activity("failed-command", agentTurn.id, {
        kind: "command",
        title: "Tests failed",
        detail: "npm test exited with status 1.",
        status: "failed",
        createdAt: "2026-07-23T10:00:40.000Z",
      }),
    ]);

    expect(html).toContain('class="turn-execution-rail is-settled"');
    expect(html).toContain('data-settled-work-status="completed"');
    expect(html).toContain('data-settled-work-visibility="collapsed"');
    expect(html).toContain("Codex App Server");
    expect(html).toContain("Worked for 1m 42s · 2 actions");
    expect(html).toContain('class="turn-settled-summary" aria-expanded="false"');
    expect(html).toContain('aria-controls="turn-work-details-rendered"');
    expect(html).toContain('id="turn-work-details-rendered"');
    expect(html).toContain(">Details</small>");

    const detailsStart = html.indexOf("<details");
    const detailsEnd = html.indexOf("</details>", detailsStart);
    const details = html.slice(detailsStart, detailsEnd);
    expect(details).not.toContain("Read source");
    expect(details).not.toContain("Warning: provider fallback used");
    expect(details).not.toContain("Tests failed");
    expect(html.indexOf("Warning: provider fallback used")).toBeGreaterThan(detailsEnd);
    expect(html.indexOf("Tests failed")).toBeGreaterThan(detailsEnd);
    expect(html.match(/data-activity-severity="warning"/g)).toHaveLength(1);
    expect(html.match(/data-activity-severity="failure"/g)).toHaveLength(1);
    expect(html.match(/class="agent-activity-technical"/g)).toHaveLength(2);
    expect(html).toContain("<summary><span>Full output</span>");
    expect(html).toContain("<summary><span>Full command output</span>");
    expect(html.match(/npm test exited with status 1\./g)).toHaveLength(2);
    expect(html.match(/The provider ignored one optional capability\./g)).toHaveLength(2);
    expect(html.indexOf('data-turn-layer="final-answer"'))
      .toBeGreaterThan(html.indexOf('data-turn-layer="agent-execution"'));
  });

  it("removes the redundant settled row while keeping status and duration once in the footer", () => {
    const html = renderTurn(turn("no-detail-render"), []);

    expect(html).toContain("turn-agent-execution is-quiet-settled");
    expect(html).not.toContain('class="turn-execution-rail is-settled"');
    expect(html).not.toContain("turn-settled-summary");
    expect(html).not.toContain("Completed without tool activity");
    expect(html.match(/class="turn-duration">Worked 1m 42s/g)).toHaveLength(1);
    expect(html.match(/Worked for 1m 42s/g) ?? []).toHaveLength(0);
    expect(html).toContain('data-turn-status="completed">Completed');
    expect(html).toContain('aria-controls="turn-run-details-no-detail-render"');
    expect(html).toContain('data-turn-layer="final-answer"');
  });

  it("moves successful work behind Run details and follows the work-log collapse setting", () => {
    const successful = turn("auto-collapse");
    const activities = [activity("read", successful.id)];
    const collapsed = renderTurn(successful, activities, true);
    const expanded = renderTurn(successful, activities, false);

    expect(collapsed).not.toContain("turn-settled-summary");
    expect(collapsed).toContain(
      'class="turn-run-details-toggle" id="turn-run-details-auto-collapse-label" aria-expanded="false"',
    );
    expect(collapsed).toContain(
      'class="turn-run-details" id="turn-run-details-auto-collapse" aria-labelledby="turn-run-details-auto-collapse-label" hidden=""',
    );
    expect(collapsed).not.toContain("Execution transcript");
    expect(collapsed).not.toContain("Read source");
    expect(expanded).not.toContain("turn-settled-summary");
    expect(expanded).toContain(
      'class="turn-run-details-toggle" id="turn-run-details-auto-collapse-label" aria-expanded="true"',
    );
    expect(expanded).toContain(
      'class="turn-run-details" id="turn-run-details-auto-collapse" aria-labelledby="turn-run-details-auto-collapse-label"',
    );
    expect(expanded).not.toContain('aria-labelledby="turn-run-details-auto-collapse-label" hidden=""');
    expect(activitySource).toContain("onKeyDownCapture: (event) =>");
    expect(activitySource).toContain('event.key === "Enter" || event.key === " "');
    expect(viewportSource).toContain("onBeforeToggle={captureExpansionAnchor}");
    expect(viewportSource).toContain("onAfterToggle={restoreExpansionAnchor}");
  });

  it("settles three consecutive successful turns without duplicate work rows or durations", () => {
    const successfulTurns = ["success-a", "success-b", "success-c"].map((id) => turn(id));
    const html = renderTurns(
      successfulTurns,
      successfulTurns.map((successful) =>
        activity(`read-${successful.id}`, successful.id)),
    );

    expect(html.match(/turn-agent-execution is-quiet-settled/g)).toHaveLength(3);
    expect(html).not.toContain("turn-settled-summary");
    expect(html).not.toContain("Worked for");
    expect(html.match(/class="turn-duration">Worked 1m 42s/g)).toHaveLength(3);
    expect(html).not.toContain(">Execution transcript<");
  });

  it("keeps historical summaries static and never derives terminal time from a mutable clock", () => {
    const incomplete = responseTurn(turn("incomplete-terminal", {
      status: "failed",
      terminalAssistantMessageId: null,
      completedAt: null,
      terminalReason: "provider-failed",
      updatedAt: "2030-01-01T00:00:00.000Z",
    }), [activity("failed-call", "incomplete-terminal", {
      kind: "command",
      status: "failed",
      title: "Verification failed",
    })]);
    const earlyNow = Date.parse("2026-07-23T11:00:00.000Z");
    const lateNow = Date.parse("2036-07-23T11:00:00.000Z");

    expect(turnQueueElapsedMs(incomplete, earlyNow)).toBe(8_000);
    expect(turnQueueElapsedMs(incomplete, lateNow)).toBe(8_000);
    expect(turnExecutionElapsedMs(incomplete, earlyNow)).toBeNull();
    expect(turnExecutionElapsedMs(incomplete, lateNow)).toBeNull();
    expect(workSummaryLabel(incomplete, earlyNow)).toBe("Failed · 1 action");
    expect(workSummaryLabel(incomplete, lateNow)).toBe("Failed · 1 action");

    const historicalHtml = renderTurn(turn("historical-static"), [
      activity("historical-read", "historical-static"),
    ]);
    expect(historicalHtml).not.toContain("is-settling");
    expect(historicalHtml).not.toContain("turn-settled-summary");
    expect(historicalHtml).toContain('data-turn-completion-announcement=""></span>');
  });

  it("styles the summary as quiet divider text rather than a card", () => {
    const summaryRule = styles.slice(
      styles.indexOf(".turn-work-log.is-settled .turn-settled-summary {"),
      styles.indexOf(
        ".turn-work-log.is-settled details > summary.turn-settled-summary:hover",
      ),
    );

    expect(summaryRule).toContain("min-height: 26px");
    expect(summaryRule).toContain("border-bottom: 1px solid");
    expect(summaryRule).toContain("border-radius: 0");
    expect(summaryRule).not.toContain("box-shadow");
    expect(summaryRule).not.toContain("background:");
  });
});
