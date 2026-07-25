import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  AgentActivity,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
  CheckpointSummary,
} from "../../src/shared/contracts";
import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import {
  activityNeedsAttention,
  buildResponseTimeline,
  buildTimelineMinimapMarkers,
  estimateTimelineRowSize,
  formatElapsed,
  resolveTimelineKeyboardIntent,
  shouldFollowTimeline,
  shouldShowTimelineMinimap,
  shouldVirtualizeTimeline,
  stabilizeResponseTimeline,
  turnExecutionElapsedMs,
  turnQueueElapsedMs,
  turnTimingLabels,
  workSummaryLabel,
  type ResponseTurn,
  type TurnGitArtifactSummary,
} from "../../src/renderer/src/utils/responseTimeline";

const conversationId = "11111111-1111-4111-8111-111111111111";

function message(
  id: string,
  turnId: string | null,
  role: ChatMessage["role"],
  content: string,
  createdAt: string,
): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt };
}

function agentTurn(id: string, userMessageId: string, update: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id,
    conversationId,
    runId: `run-${id}`,
    userMessageId,
    terminalAssistantMessageId: null,
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
    requestedAt: "2026-07-23T10:00:00.000Z",
    startedAt: "2026-07-23T10:00:05.000Z",
    completedAt: "2026-07-23T10:00:12.000Z",
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 3,
    association: "authoritative",
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:12.000Z",
    ...update,
  };
}

function activity(id: string, turnId: string | null, update: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id,
    conversationId,
    runId: turnId ? `run-${turnId}` : "orphan-run",
    turnId,
    kind: "tool",
    title: "Read files",
    detail: null,
    status: "completed",
    createdAt: "2026-07-23T10:00:07.000Z",
    ...update,
  };
}

function timelineTurn(items: ReturnType<typeof buildResponseTimeline>, id: string): ResponseTurn {
  const item = items.find((candidate) => candidate.kind === "turn" && candidate.turn.id === id);
  expect(item?.kind).toBe("turn");
  if (item?.kind !== "turn") throw new Error(`Missing turn ${id}`);
  return item.turn;
}

function artifact(id: string, turnId: string, path: string): TurnGitArtifactSummary {
  return {
    id,
    turnId,
    conversationId,
    runId: `run-${turnId}`,
    repositoryIdentity: "a".repeat(64),
    worktreeIdentity: "b".repeat(64),
    branch: "main",
    beforeCheckpointId: null,
    beforeFingerprint: "c".repeat(64),
    afterFingerprint: "d".repeat(64),
    status: "ready",
    completeness: "complete",
    patchState: "available",
    patchDigest: "e".repeat(64),
    capturedAt: "2026-07-23T10:00:12.000Z",
    terminalAssistantMessageId: null,
    failureReason: null,
    insertions: 1,
    deletions: 0,
    files: [{
      path,
      previousPath: null,
      status: "M",
      insertions: 1,
      deletions: 0,
      binary: false,
      untracked: false,
      staged: false,
      unstaged: true,
      indexStatus: " ",
      worktreeStatus: "M",
    }],
  };
}

describe("authoritative response timeline", () => {
  it("uses explicit turn ownership for close timestamps and delayed old events", () => {
    const turn1 = agentTurn("turn-1", "user-1", {
      requestedAt: "2026-07-23T10:00:00.000Z",
      startedAt: "2026-07-23T10:00:00.002Z",
      completedAt: "2026-07-23T10:00:00.008Z",
    });
    const turn2 = agentTurn("turn-2", "user-2", {
      requestedAt: "2026-07-23T10:00:00.001Z",
      startedAt: "2026-07-23T10:00:00.003Z",
      completedAt: "2026-07-23T10:00:00.009Z",
    });
    const timeline = buildResponseTimeline({
      turns: [turn2, turn1],
      messages: [
        message("user-1", "turn-1", "user", "First", turn1.requestedAt),
        message("user-2", "turn-2", "user", "Second", turn2.requestedAt),
        message("assistant-1", "turn-1", "assistant", "First done", "2026-07-23T10:00:00.008Z"),
        message("assistant-2", "turn-2", "assistant", "Second done", "2026-07-23T10:00:00.009Z"),
      ],
      activities: [
        activity("delayed-old", "turn-1", { createdAt: "2026-07-23T10:30:00.000Z" }),
        activity("new", "turn-2", { createdAt: "2026-07-23T10:00:00.004Z" }),
      ],
      reasonings: [],
      checkpoints: [],
    });

    expect(timeline.filter(({ kind }) => kind === "turn").map(({ id }) => id)).toEqual(["turn-1", "turn-2"]);
    expect(timelineTurn(timeline, "turn-1").activities.map(({ id }) => id)).toEqual(["delayed-old"]);
    expect(timelineTurn(timeline, "turn-2").activities.map(({ id }) => id)).toEqual(["new"]);
  });

  it("keeps multiple assistant messages and identifies only the persisted terminal answer", () => {
    const turn = agentTurn("turn-1", "user-1", { terminalAssistantMessageId: "assistant-final" });
    const timeline = buildResponseTimeline({
      turns: [turn],
      messages: [
        message("user-1", turn.id, "user", "Inspect this", turn.requestedAt),
        message("assistant-commentary-1", turn.id, "assistant", "I am checking.", "2026-07-23T10:00:06.000Z"),
        message("assistant-final", turn.id, "assistant", "Done.", "2026-07-23T10:00:10.000Z"),
        message("assistant-commentary-2", turn.id, "assistant", "One more detail.", "2026-07-23T10:00:11.000Z"),
      ],
      activities: [],
      reasonings: [],
      checkpoints: [],
    });
    const response = timelineTurn(timeline, turn.id);
    expect(response.assistantMessages.map(({ id }) => id)).toEqual([
      "assistant-commentary-1",
      "assistant-final",
      "assistant-commentary-2",
    ]);
    expect(response.commentaryMessages.map(({ id }) => id)).toEqual([
      "assistant-commentary-1",
      "assistant-commentary-2",
    ]);
    expect(response.terminalAssistantMessage?.id).toBe("assistant-final");
  });

  it("renders the terminal answer outside collapsed work while preserving exact historical configuration", () => {
    const turn = agentTurn("turn-1", "user-1", { terminalAssistantMessageId: "assistant-final" });
    const html = renderToStaticMarkup(createElement(ResponseTimeline, {
      turns: [turn],
      messages: [
        {
          ...message("user-1", turn.id, "user", "Build it", turn.requestedAt),
          attachments: [{
            id: "attachment-1",
            name: "reference.png",
            path: "/workspace/reference.png",
            mimeType: "image/png",
            size: 1_024,
          }],
        },
        message("assistant-commentary", turn.id, "assistant", "Working note", "2026-07-23T10:00:07.000Z"),
        message("assistant-final", turn.id, "assistant", "Terminal answer stays visible", "2026-07-23T10:00:11.000Z"),
      ],
      activities: [activity("tool", turn.id)],
      reasonings: [],
      plans: [],
      checkpoints: [],
      gitArtifacts: [artifact("artifact-1", turn.id, "src/history.ts")],
      projectRoot: "/workspace",
      projectId: "project-1",
      conversationId,
      providers: [],
      streamingText: "",
      streamingReasoning: "",
      approvals: [],
      inputRequests: [],
      showTimestamps: false,
      showThinking: true,
      defaultCodeWrap: false,
      autoCollapseWorkLog: true,
      showChangedFileSummaries: true,
      checkpointRestoreDisabled: false,
      onRespondToApproval: async () => undefined,
      onRespondToInput: async () => undefined,
      onRevertCheckpoint: () => undefined,
      onOpenTurnDiff: () => undefined,
      onCompareTurnArtifacts: () => undefined,
      onOpenTurnFile: () => undefined,
    }));

    expect(html).toContain('data-terminal-answer-id="assistant-final"');
    expect(html).toContain('data-turn-request-context="turn-1"');
    expect(html).toContain("reference.png");
    expect(html).toContain("<details><summary>");
    expect(html).toContain("Terminal answer stays visible");
    expect(html).toContain("Working note");
    expect(html).toContain("<strong>Harness</strong><code>codex-app-server</code>");
    expect(html).toContain("<strong>Backend</strong><code>native:codex:app-server</code>");
    expect(html).toContain("<strong>Model</strong><code>gpt-5.6</code>");
    expect(html).toContain("Changed by this turn");
    expect(html).toContain("Open exact turn diff");
    expect(html).toContain("src/history.ts");
    expect(html.indexOf("Terminal answer stays visible")).toBeGreaterThan(html.indexOf("Working note"));
  });

  it("labels a historical Kimi turn from its persisted selection", () => {
    const turn = agentTurn("turn-kimi", "user-kimi", {
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfileId: "kimi:historical",
      model: "k3",
      modelAlias: null,
      reasoningEffort: "high",
      terminalAssistantMessageId: "assistant-kimi",
      modelSelection: {
        harnessId: "claude-agent-sdk",
        backendProfileId: "kimi:historical",
        backendProfileDisplayName: "Kimi",
        modelId: "k3",
        alias: null,
        reasoningEffort: "high",
        contextWindowOverride: 1_048_576,
        providerOptions: {},
        capabilities: [],
        backendConfigurationRevision: 7,
      },
      continuationIdentity: {
        harnessId: "claude-agent-sdk",
        backendProfileId: "kimi:historical",
        backendConfigurationRevision: 7,
        modelIdentity: "k3",
        endpointIdentity: "kimi-code:anthropic-messages-v1",
      },
      configurationRevision: 7,
    });
    const html = renderToStaticMarkup(createElement(ResponseTimeline, {
      turns: [turn],
      messages: [
        message("user-kimi", turn.id, "user", "Use Kimi", turn.requestedAt),
        message("assistant-kimi", turn.id, "assistant", "Kimi answer", turn.completedAt!),
      ],
      activities: [],
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
    }));

    expect(html).toContain("Claude harness · Kimi · K3");
    expect(html).not.toContain("Claude harness · Anthropic");
  });

  it("keeps completed timing and configuration immutable after unrelated conversation mutation and activity", () => {
    const turn = agentTurn("turn-1", "user-1");
    const base = {
      turns: [turn],
      messages: [message("user-1", turn.id, "user", "Run it", turn.requestedAt)],
      activities: [],
      reasonings: [],
      checkpoints: [],
    };
    const first = timelineTurn(buildResponseTimeline(base), turn.id);
    const mutatedConversation = {
      title: "Renamed later",
      archivedAt: "2030-01-01T00:00:00.000Z",
      model: "future-model",
      updatedAt: "2030-01-01T00:00:00.000Z",
    };
    const second = timelineTurn(buildResponseTimeline({
      ...base,
      activities: [activity("later-orphan", null, { createdAt: mutatedConversation.updatedAt })],
    }), turn.id);

    expect(second.completedAt).toBe(first.completedAt);
    expect(second.agentTurn.model).toBe("gpt-5.6");
    expect(second.agentTurn.harnessId).toBe("codex-app-server");
    expect(second.activities).toEqual([]);
  });

  it("separates requested-to-started queue delay from started-to-completed work time", () => {
    const turn = agentTurn("turn-1", "user-1");
    const response = timelineTurn(buildResponseTimeline({
      turns: [turn],
      messages: [message("user-1", turn.id, "user", "Run it", turn.requestedAt)],
      activities: [],
      reasonings: [],
      checkpoints: [],
    }), turn.id);

    expect(turnQueueElapsedMs(response)).toBe(5_000);
    expect(turnExecutionElapsedMs(response)).toBe(7_000);
    expect(turnTimingLabels(response)).toEqual(["Queued 5s", "Worked 7s"]);
    expect(workSummaryLabel(response)).toBe("Worked for 7s");
  });

  it("renders plans only for their explicit owning turn and quarantines nullable legacy plans", () => {
    const first = agentTurn("first", "first-user");
    const second = agentTurn("second", "second-user");
    const secondPlan = {
      conversationId,
      runId: second.runId,
      turnId: second.id,
      explanation: "Second turn plan",
      steps: [{ step: "Implement", status: "inProgress" as const }],
    };
    const legacyPlan = {
      conversationId,
      runId: "legacy-run",
      turnId: null,
      explanation: "Unowned legacy plan",
      steps: [],
    };
    const timeline = buildResponseTimeline({
      turns: [first, second],
      messages: [
        message("first-user", first.id, "user", "First", first.requestedAt),
        message("second-user", second.id, "user", "Second", second.requestedAt),
      ],
      activities: [],
      reasonings: [],
      plans: [secondPlan, legacyPlan],
      checkpoints: [],
    });

    expect(timelineTurn(timeline, first.id).plans).toEqual([]);
    expect(timelineTurn(timeline, second.id).plans).toEqual([secondPlan]);
    const compatibility = timeline.find(({ kind }) => kind === "compatibility");
    expect(compatibility?.kind).toBe("compatibility");
    if (compatibility?.kind === "compatibility") {
      expect(compatibility.compatibility.plans).toEqual([legacyPlan]);
    }
  });

  it("uses honest stopped and failed lifecycle labels", () => {
    const failed = agentTurn("failed", "failed-user", { status: "failed" });
    const cancelled = agentTurn("cancelled", "cancelled-user", { status: "cancelled" });
    const interrupted = agentTurn("interrupted", "interrupted-user", { status: "interrupted" });
    const timeline = buildResponseTimeline({
      turns: [failed, cancelled, interrupted],
      messages: [
        message("failed-user", failed.id, "user", "Fail", failed.requestedAt),
        message("cancelled-user", cancelled.id, "user", "Cancel", cancelled.requestedAt),
        message("interrupted-user", interrupted.id, "user", "Interrupt", interrupted.requestedAt),
      ],
      activities: [],
      reasonings: [],
      checkpoints: [],
    });

    expect(workSummaryLabel(timelineTurn(timeline, failed.id))).toBe("Failed after 7s");
    expect(workSummaryLabel(timelineTurn(timeline, cancelled.id))).toBe("Stopped after 7s");
    expect(workSummaryLabel(timelineTurn(timeline, interrupted.id))).toBe("Stopped after 7s");
  });

  it("quarantines inferred turns and every unowned record in one compatibility section", () => {
    const authoritative = agentTurn("authoritative", "authoritative-user");
    const inferred = agentTurn("inferred", "inferred-user", { association: "inferred" });
    const malformed = agentTurn("malformed", "missing-user");
    const orphanReasoning: AgentReasoning = {
      id: "orphan-reasoning",
      conversationId,
      runId: "legacy-run",
      turnId: null,
      content: "Recovered reasoning",
      status: "completed",
      createdAt: "2026-07-23T10:00:07.000Z",
    };
    const timeline = buildResponseTimeline({
      turns: [authoritative, inferred, malformed],
      messages: [
        message("authoritative-user", authoritative.id, "user", "New request", authoritative.requestedAt),
        message("inferred-user", inferred.id, "user", "Old request", inferred.requestedAt),
        message("orphan-assistant", null, "assistant", "Unowned answer", "2026-07-23T10:00:06.000Z"),
      ],
      activities: [activity("orphan-activity", null)],
      reasonings: [orphanReasoning],
      checkpoints: [],
    });

    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.kind).toBe("compatibility");
    if (timeline[0]?.kind !== "compatibility") return;
    expect(timeline[0].compatibility.inferredTurns.map(({ id }) => id)).toEqual(["inferred"]);
    expect(timeline[0].compatibility.malformedTurns.map(({ id }) => id)).toEqual(["malformed"]);
    expect(timeline[0].compatibility.messages.map(({ id }) => id)).toEqual(["orphan-assistant"]);
    expect(timeline[0].compatibility.activities.map(({ id }) => id)).toEqual(["orphan-activity"]);
    expect(timeline[0].compatibility.reasonings.map(({ id }) => id)).toEqual(["orphan-reasoning"]);
    expect(timeline[1]).toMatchObject({ kind: "turn", id: "authoritative" });
  });

  it("accepts only exact turn-owned Git artifacts and never current workspace changes", () => {
    const oldTurn = agentTurn("old", "old-user");
    const newTurn = agentTurn("new", "new-user");
    const timeline = buildResponseTimeline({
      turns: [oldTurn, newTurn],
      messages: [
        message("old-user", oldTurn.id, "user", "Old", oldTurn.requestedAt),
        message("new-user", newTurn.id, "user", "New", newTurn.requestedAt),
      ],
      activities: [],
      reasonings: [],
      checkpoints: [],
      gitArtifacts: [artifact("old-artifact", oldTurn.id, "historical.ts")],
    });

    expect(timelineTurn(timeline, oldTurn.id).gitArtifact?.files[0]?.path).toBe("historical.ts");
    expect(timelineTurn(timeline, newTurn.id).gitArtifact).toBeNull();
  });

  it("never folds failures or important warnings into the successful work row", () => {
    const warning = activity("warning", "turn", { kind: "status", title: "Unsupported interaction was skipped" });
    const failure = activity("failure", "turn", { kind: "error", title: "Command failed", status: "failed" });
    const success = activity("success", "turn");
    const turn = agentTurn("turn", "user", { status: "failed" });
    const timeline = buildResponseTimeline({
      turns: [turn],
      messages: [message("user", turn.id, "user", "Try it", turn.requestedAt)],
      activities: [success, warning, failure],
      reasonings: [],
      checkpoints: [],
    });
    const response = timelineTurn(timeline, turn.id);
    expect(response.foldableActivities.map(({ id }) => id)).toEqual(["success"]);
    expect(response.importantActivities.map(({ id }) => id)).toEqual(["failure", "warning"]);
    expect(activityNeedsAttention(warning)).toBe(true);
  });

  it("associates checkpoints only through explicit turn identity, never turn index", () => {
    const turn = agentTurn("turn", "user");
    const checkpoint: CheckpointSummary = {
      id: "checkpoint",
      conversationId,
      turnId: null,
      ref: "refs/checkpoint",
      label: "Misleading ordinal",
      turnIndex: 1,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      createdAt: "2026-07-23T09:59:00.000Z",
    };
    const timeline = buildResponseTimeline({
      turns: [turn],
      messages: [message("user", turn.id, "user", "Try it", turn.requestedAt)],
      activities: [],
      reasonings: [],
      checkpoints: [checkpoint],
    });
    expect(timelineTurn(timeline, turn.id).checkpoint).toBeNull();
    expect(timeline[0]?.kind).toBe("compatibility");
  });

  it("reuses settled row objects while allowing the active turn to advance", () => {
    const settled = agentTurn("settled", "settled-user", {
      requestedAt: "2026-07-23T09:00:00.000Z",
    });
    const active = agentTurn("active", "active-user", {
      requestedAt: "2026-07-23T10:00:00.000Z",
      completedAt: null,
      status: "running",
    });
    const settledRequest = message("settled-user", settled.id, "user", "Settled", settled.requestedAt);
    const activeRequest = message("active-user", active.id, "user", "Active", active.requestedAt);
    const firstBuilt = buildResponseTimeline({
      turns: [settled, active],
      messages: [settledRequest, activeRequest],
      activities: [],
      reasonings: [],
      checkpoints: [],
    });
    const first = stabilizeResponseTimeline(firstBuilt, []);
    const repeated = stabilizeResponseTimeline(buildResponseTimeline({
      turns: [settled, active],
      messages: [settledRequest, activeRequest],
      activities: [],
      reasonings: [],
      checkpoints: [],
    }), first);
    expect(repeated).toBe(first);

    const advancedActive = { ...active, updatedAt: "2026-07-23T10:00:01.000Z" };
    const activeAnswer = message(
      "active-answer",
      active.id,
      "assistant",
      "Streaming persistence advanced",
      advancedActive.updatedAt,
    );
    const advanced = stabilizeResponseTimeline(buildResponseTimeline({
      turns: [settled, advancedActive],
      messages: [settledRequest, activeRequest, activeAnswer],
      activities: [],
      reasonings: [],
      checkpoints: [],
    }), first);

    expect(advanced).not.toBe(first);
    expect(advanced.find(({ id }) => id === settled.id)).toBe(first.find(({ id }) => id === settled.id));
    expect(advanced.find(({ id }) => id === active.id)).not.toBe(first.find(({ id }) => id === active.id));
    expect(timelineTurn(advanced, active.id).assistantMessages).toEqual([activeAnswer]);
  });

  it("bounds the minimap and exposes deterministic keyboard navigation", () => {
    const turns = Array.from({ length: 120 }, (_, index) => {
      const turn = agentTurn(`turn-${String(index).padStart(3, "0")}`, `user-${index}`, {
        requestedAt: new Date(Date.parse("2026-07-23T10:00:00.000Z") + index * 1_000).toISOString(),
      });
      return timelineTurn(buildResponseTimeline({
        turns: [turn],
        messages: [message(
          `user-${index}`,
          turn.id,
          "user",
          `Request ${index} with a stable label`,
          turn.requestedAt,
        )],
        activities: [],
        reasonings: [],
        checkpoints: [],
      }), turn.id);
    });
    const markers = buildTimelineMinimapMarkers(turns);
    expect(markers).toHaveLength(48);
    expect(markers[0]).toMatchObject({ index: 0, id: "turn-000" });
    expect(markers.at(-1)).toMatchObject({ index: 119, id: "turn-119" });
    expect(shouldVirtualizeTimeline(39)).toBe(false);
    expect(shouldVirtualizeTimeline(40)).toBe(true);
    expect(shouldShowTimelineMinimap(120, 47)).toBe(false);
    expect(shouldShowTimelineMinimap(120, 48)).toBe(true);

    const keyboard = (key: string, update: Partial<KeyboardEvent> = {}) => ({
      key,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...update,
    });
    expect(resolveTimelineKeyboardIntent(keyboard("ArrowDown"), 12, 120))
      .toEqual({ index: 13, target: "turn" });
    expect(resolveTimelineKeyboardIntent(keyboard("ArrowUp"), 0, 120))
      .toEqual({ index: 0, target: "turn" });
    expect(resolveTimelineKeyboardIntent(keyboard("Home"), 12, 120))
      .toEqual({ index: 12, target: "request" });
    expect(resolveTimelineKeyboardIntent(keyboard("End"), 12, 120))
      .toEqual({ index: 12, target: "final" });
    expect(resolveTimelineKeyboardIntent(keyboard("g"), 12, 120))
      .toEqual({ index: 12, target: "artifact" });
    expect(resolveTimelineKeyboardIntent(keyboard("ArrowDown", { altKey: false }), 12, 120))
      .toBeNull();
  });

  it("builds thousands of authoritative rows without quadratic rescanning", () => {
    const count = 3_000;
    const baseTime = Date.parse("2026-07-23T10:00:00.000Z");
    const turns = Array.from({ length: count }, (_, index) => agentTurn(
      `turn-${String(index).padStart(4, "0")}`,
      `user-${index}`,
      { requestedAt: new Date(baseTime + index * 1_000).toISOString() },
    ));
    const messages = turns.map((turn, index) =>
      message(`user-${index}`, turn.id, "user", `Request ${index}`, turn.requestedAt));
    const started = performance.now();
    const timeline = buildResponseTimeline({
      turns,
      messages,
      activities: [],
      reasonings: [],
      checkpoints: [],
    });
    const elapsed = performance.now() - started;
    expect(timeline).toHaveLength(count);
    expect(timeline[0]?.id).toBe("turn-0000");
    expect(timeline.at(-1)?.id).toBe("turn-2999");
    expect(estimateTimelineRowSize(timeline[0]!)).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("follows only near the bottom and formats bounded elapsed labels", () => {
    expect(shouldFollowTimeline(1_380, 500, 2_000)).toBe(true);
    expect(shouldFollowTimeline(900, 500, 2_000)).toBe(false);
    expect(shouldFollowTimeline(Number.NaN, 500, 2_000)).toBe(true);
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(125_000)).toBe("2m 5s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
  });
});
