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
import {
  ResponseTimeline,
  turnGitArtifactCompletenessWarning,
  turnGitArtifactPatchAvailable,
} from "../../src/renderer/src/components/ResponseTimeline";
import {
  activityNeedsAttention,
  buildResponseTimeline,
  buildTurnExecutionStream,
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

function artifact(
  id: string,
  turnId: string,
  path: string,
  update: Partial<TurnGitArtifactSummary> = {},
): TurnGitArtifactSummary {
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
    ...update,
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

  it("keeps parent follow-ups inside their authoritative turn and execution order", () => {
    const turn = agentTurn("turn-follow-up", "user-primary", {
      status: "running",
      completedAt: null,
    });
    const timeline = buildResponseTimeline({
      turns: [turn],
      messages: [
        message("user-primary", turn.id, "user", "Start the investigation.", "2026-07-23T10:00:00.000Z"),
        message("commentary-before", turn.id, "assistant", "I found the relevant path.", "2026-07-23T10:00:02.000Z"),
        message("user-follow-up", turn.id, "user", "Please include the Windows path too.", "2026-07-23T10:00:04.000Z"),
        message("commentary-after", turn.id, "assistant", "I am checking both platforms.", "2026-07-23T10:00:06.000Z"),
      ],
      activities: [
        activity("call-before", turn.id, { createdAt: "2026-07-23T10:00:03.000Z" }),
        activity("call-after", turn.id, { createdAt: "2026-07-23T10:00:05.000Z" }),
      ],
      reasonings: [],
      checkpoints: [],
    });
    const response = timelineTurn(timeline, turn.id);
    const compatibility = timeline.find(({ kind }) => kind === "compatibility");

    expect(response.followUpMessages.map(({ id }) => id)).toEqual(["user-follow-up"]);
    expect(compatibility).toBeUndefined();
    expect(buildTurnExecutionStream(response).map((entry) => (
      entry.kind === "activity-group" ? entry.activities[0]?.id : entry.id
    ))).toEqual([
      "commentary-before",
      "call-before",
      "user-follow-up",
      "call-after",
      "commentary-after",
    ]);
  });

  it("groups only adjacent calls and preserves commentary between work phases", () => {
    const turn = agentTurn("turn-interleaved", "user-interleaved", {
      status: "running",
      completedAt: null,
    });
    const response = timelineTurn(buildResponseTimeline({
      turns: [turn],
      messages: [
        message("user-interleaved", turn.id, "user", "Investigate", "2026-07-23T10:00:00.000Z"),
        message("commentary-one", turn.id, "assistant", "I found the entry point.", "2026-07-23T10:00:02.000Z"),
        message("commentary-two", turn.id, "assistant", "The first check passed.", "2026-07-23T10:00:05.000Z"),
      ],
      activities: [
        activity("call-one", turn.id, { createdAt: "2026-07-23T10:00:03.000Z" }),
        activity("call-two", turn.id, { createdAt: "2026-07-23T10:00:04.000Z" }),
        activity("call-three", turn.id, { createdAt: "2026-07-23T10:00:06.000Z" }),
      ],
      reasonings: [],
      checkpoints: [],
    }), turn.id);

    const stream = buildTurnExecutionStream(response, { liveContent: "Preparing the answer." });
    expect(stream.map(({ kind }) => kind)).toEqual([
      "commentary",
      "activity-group",
      "commentary",
      "activity-group",
      "commentary",
    ]);
    expect(stream[1]).toMatchObject({
      kind: "activity-group",
      activities: [{ id: "call-one" }, { id: "call-two" }],
    });
    expect(stream[3]).toMatchObject({
      kind: "activity-group",
      activities: [{ id: "call-three" }],
    });
    expect(stream.at(-1)).toMatchObject({
      kind: "commentary",
      content: "Preparing the answer.",
      streaming: true,
    });
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
      onStop: () => undefined,
    }));

    expect(html).toContain('data-terminal-answer-id="assistant-final"');
    expect(html).toContain('data-turn-request-context="turn-1"');
    expect(html).toContain('data-turn-layer="user-request"');
    expect(html).toContain('data-turn-layer="agent-execution"');
    expect(html).toContain('data-turn-layer="final-answer"');
    expect(html).toContain('data-turn-layer="supporting-ledger"');
    expect(html).toContain('data-answer-phase="persisted"');
    expect(html).toContain("reference.png");
    expect(html).toContain("Run details");
    expect(html).toContain("Terminal answer stays visible");
    expect(html).not.toContain("Working note");
    expect(html).not.toContain("<dt>Harness ID</dt>");
    expect(html).toContain("Changed by this turn");
    expect(html).toContain("Open exact turn diff");
    expect(html).toContain("src/history.ts");
    expect(html.indexOf('data-turn-layer="agent-execution"'))
      .toBeGreaterThan(html.indexOf('data-turn-layer="user-request"'));
    expect(html.indexOf('data-turn-layer="final-answer"'))
      .toBeGreaterThan(html.indexOf('data-turn-layer="agent-execution"'));
    expect(html.indexOf('data-turn-layer="supporting-ledger"'))
      .toBeGreaterThan(html.indexOf('data-turn-layer="final-answer"'));
  });

  it("keeps active commentary in the execution stream and reserves the answer document for persistence", () => {
    const renderTurn = (
      turn: AgentTurn,
      messages: ChatMessage[],
      streamingText: string,
    ) => renderToStaticMarkup(createElement(ResponseTimeline, {
      turns: [turn],
      messages,
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
      projectRoot: "/workspace",
      projectId: "project-1",
      conversationId,
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
    const active = agentTurn("turn-active", "user-active", {
      status: "running",
      completedAt: null,
    });
    const activeHtml = renderTurn(
      active,
      [message("user-active", active.id, "user", "Stream it", active.requestedAt)],
      "Answer in progress",
    );
    const settled = agentTurn("turn-settled", "user-settled", {
      terminalAssistantMessageId: "assistant-settled",
    });
    const settledHtml = renderTurn(
      settled,
      [
        message("user-settled", settled.id, "user", "Finish it", settled.requestedAt),
        message("assistant-settled", settled.id, "assistant", "Persisted answer", settled.completedAt!),
      ],
      "",
    );

    expect(activeHtml).not.toContain("turn-final-answer-document");
    expect(activeHtml).toContain("turn-commentary-row is-streaming");
    expect(activeHtml).toContain('data-turn-layer="agent-execution"');
    expect(activeHtml).toContain("Answer in progress");
    expect(activeHtml).not.toContain('aria-label="Final answer actions and run metadata"');
    expect(activeHtml).not.toContain('data-turn-layer="supporting-ledger"');
    expect(settledHtml).toContain("turn-final-answer-document");
    expect(settledHtml).toContain('data-turn-layer="final-answer"');
    expect(settledHtml).toContain('data-turn-layer="supporting-ledger"');
    expect(settledHtml.indexOf('data-turn-layer="final-answer"'))
      .toBeGreaterThan(settledHtml.indexOf('data-turn-layer="user-request"'));
    expect(settledHtml).toContain('data-answer-phase="persisted"');
    expect(settledHtml).toContain('data-terminal-answer-id="assistant-settled"');
  });

  it("interleaves commentary with adjacent compact call groups and keeps secondary work in Details", () => {
    const turn = agentTurn("turn-active-rail", "user-active-rail", {
      status: "running",
      completedAt: null,
    });
    const at = (seconds: number) => `2026-07-23T10:00:${String(seconds).padStart(2, "0")}.000Z`;
    const html = renderToStaticMarkup(createElement(ResponseTimeline, {
      turns: [turn],
      messages: [
        message("user-active-rail", turn.id, "user", "Build the rail", turn.requestedAt),
        message("commentary-active-rail", turn.id, "assistant", "Checking the existing presentation.", at(2)),
      ],
      activities: [
        activity("old-running", turn.id, { title: "Inspect package", status: "running", createdAt: at(1) }),
        activity("recent-read", turn.id, { title: "Read source", status: "running", createdAt: at(2) }),
        activity("older-duplicate", turn.id, { kind: "command", title: "Run tests", status: "running", createdAt: at(3) }),
        activity("recent-edit", turn.id, { kind: "file", title: "Edit layer", status: "running", createdAt: at(4) }),
        activity("completed-command", turn.id, { kind: "command", title: "Completed command", createdAt: at(5) }),
        activity("neutral-status", turn.id, { kind: "status", title: "Provider heartbeat", status: "running", createdAt: at(6) }),
        activity("failed-command", turn.id, { kind: "command", title: "Build failed", status: "failed", createdAt: at(7) }),
        activity("warning", turn.id, { kind: "status", title: "Unsupported option skipped", createdAt: at(8) }),
        activity("recent-command", turn.id, { kind: "command", title: "Run tests", status: "running", createdAt: at(9) }),
      ],
      reasonings: [{
        id: "reasoning-active-rail",
        conversationId,
        runId: turn.runId,
        turnId: turn.id,
        content: "Private working summary",
        status: "running",
        createdAt: at(2),
      }],
      plans: [{
        conversationId,
        runId: turn.runId,
        turnId: turn.id,
        explanation: "Keep the live surface quiet",
        steps: [{ step: "Render recent work", status: "inProgress" }],
      }],
      checkpoints: [],
      projectRoot: "/workspace",
      projectId: "project-1",
      conversationId,
      streamingText: "",
      streamingReasoning: "",
      approvals: [],
      inputRequests: [],
      showTimestamps: false,
      showThinking: true,
      defaultCodeWrap: false,
      autoCollapseWorkLog: true,
      showChangedFileSummaries: false,
      checkpointRestoreDisabled: true,
      onRespondToApproval: async () => undefined,
      onRespondToInput: async () => undefined,
      onRevertCheckpoint: () => undefined,
      onOpenTurnDiff: () => undefined,
      onCompareTurnArtifacts: () => undefined,
      onOpenTurnFile: () => undefined,
      onStop: () => undefined,
    }));

    expect(html).toContain("turn-execution-rail is-live");
    expect(html).toContain("Codex · Codex App Server is working");
    expect(html.match(/Codex · Codex App Server is working/g)).toHaveLength(1);
    expect(html).toContain('data-active-work-region=""');
    expect(html).toContain('data-active-work-state="running"');
    expect(html).toContain('data-work-identity-source="persisted-model-selection"');
    expect(html).toContain('aria-label="Stop Codex · Codex App Server run"');
    expect(html).toContain(">Stop</span></button>");
    expect(html.match(/data-activity-group=/g)).toHaveLength(5);
    expect(html).toContain("+3 previous tool calls");
    expect(html.indexOf("Completed command")).toBeLessThan(html.indexOf("+3 previous tool calls"));
    expect(html).toContain("Inspect package");
    expect(html).toContain("Checking the existing presentation.");
    expect(html.indexOf("Inspect package")).toBeLessThan(html.indexOf("Checking the existing presentation."));
    expect(html.indexOf("Checking the existing presentation.")).toBeLessThan(html.indexOf("Build failed"));
    expect(html.indexOf("+3 previous tool calls")).toBeLessThan(html.indexOf("Build failed"));
    expect(html.indexOf("Build failed")).toBeLessThan(html.indexOf("Unsupported option skipped"));
    expect(html.indexOf("Unsupported option skipped")).toBeLessThan(html.indexOf("Run tests"));

    const detailsStart = html.indexOf('class="turn-work-details"');
    const detailsEnd = html.indexOf("</details>", detailsStart);
    const details = html.slice(detailsStart, detailsEnd);
    expect(html).toContain('aria-expanded="false"');
    expect(details).not.toContain("Provider heartbeat");
    expect(details).not.toContain("Private working summary");
    expect(details).not.toContain("Keep the live surface quiet");
    expect(details).not.toContain("Checking the existing presentation.");

    const failedIndex = html.indexOf("Build failed");
    const warningIndex = html.indexOf("Unsupported option skipped");
    expect(failedIndex).toBeLessThan(detailsStart);
    expect(warningIndex).toBeLessThan(detailsStart);
    expect(html.match(/data-activity-visibility="important"/g)).toHaveLength(2);
  });

  it("hides expected non-Git artifacts while preserving real capture failures", () => {
    const turn = agentTurn("turn-no-git", "user-no-git", {
      terminalAssistantMessageId: "assistant-no-git",
    });
    const renderArtifact = (gitArtifact: TurnGitArtifactSummary) => renderToStaticMarkup(
      createElement(ResponseTimeline, {
        turns: [turn],
        messages: [
          message("user-no-git", turn.id, "user", "Answer this", turn.requestedAt),
          message("assistant-no-git", turn.id, "assistant", "Done", turn.completedAt!),
        ],
        activities: [],
        reasonings: [],
        plans: [],
        checkpoints: [],
        gitArtifacts: [gitArtifact],
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
        autoCollapseWorkLog: true,
        showChangedFileSummaries: true,
        checkpointRestoreDisabled: false,
        onRespondToApproval: async () => undefined,
        onRespondToInput: async () => undefined,
        onRevertCheckpoint: () => undefined,
        onOpenTurnDiff: () => undefined,
        onCompareTurnArtifacts: () => undefined,
        onOpenTurnFile: () => undefined,
        onStop: () => undefined,
      }),
    );
    const unavailable = {
      status: "unavailable" as const,
      completeness: "unavailable" as const,
      repositoryIdentity: null,
      worktreeIdentity: null,
      branch: null,
      patchState: "none" as const,
      patchDigest: null,
      capturedAt: null,
      files: [],
      insertions: 0,
      deletions: 0,
    };

    const nonGitHtml = renderArtifact(artifact("artifact-no-git", turn.id, "", {
      ...unavailable,
      failureReason: "This workspace is not a Git repository.",
      absenceReason: "not-repository",
    }));
    expect(nonGitHtml).toContain('aria-label="Final answer actions and run metadata"');
    expect(nonGitHtml).not.toContain("Turn changes unavailable");
    expect(nonGitHtml).not.toContain("This workspace is not a Git repository.");
    expect(nonGitHtml).not.toContain("<dt>Artifact completeness</dt>");

    const pendingHtml = renderArtifact(artifact("artifact-pending", turn.id, "", {
      status: "pending",
      completeness: "partial",
      afterFingerprint: null,
      patchState: "none",
      patchDigest: null,
      capturedAt: null,
      terminalAssistantMessageId: "assistant-no-git",
      files: [],
      insertions: 0,
      deletions: 0,
    }));
    expect(pendingHtml).toContain("Capturing changes…");
    expect(pendingHtml).toContain("Git history will appear here when ready.");
    expect(pendingHtml).not.toContain("is working");
    expect(pendingHtml).not.toContain(">Stop</span></button>");

    const untypedLegacyTextHtml = renderArtifact(artifact(
      "artifact-untyped-no-git-text",
      turn.id,
      "",
      {
        ...unavailable,
        failureReason: "This workspace is not a Git repository.",
        absenceReason: null,
      },
    ));
    expect(untypedLegacyTextHtml).toContain("Turn changes unavailable");

    const failedCaptureHtml = renderArtifact(artifact("artifact-failed", turn.id, "", {
      ...unavailable,
      failureReason: "The repository snapshot could not be captured.",
    }));
    expect(failedCaptureHtml).toContain("Turn changes unavailable");
    expect(failedCaptureHtml).toContain("The repository snapshot could not be captured.");
  });

  it("renders changed files as a quiet disclosure with exact actions and completeness context", () => {
    const turn = agentTurn("turn-files", "user-files", {
      terminalAssistantMessageId: "assistant-files",
    });
    const firstFile = artifact("artifact-files", turn.id, "src/history.ts").files[0]!;
    const gitArtifact = artifact("artifact-files", turn.id, firstFile.path, {
      status: "partial",
      completeness: "truncated",
      patchState: "truncated",
      failureReason: "The complete file summary is retained, but the stored patch reached its size limit.",
      insertions: 84,
      deletions: 21,
      files: [
        { ...firstFile, status: "modified", insertions: 64, deletions: 9 },
        {
          ...firstFile,
          path: "src/new-file.ts",
          status: "added",
          insertions: 20,
          deletions: 12,
        },
      ],
    });
    const html = renderToStaticMarkup(createElement(ResponseTimeline, {
      turns: [turn],
      messages: [
        message("user-files", turn.id, "user", "Change the files", turn.requestedAt),
        message("assistant-files", turn.id, "assistant", "Changed.", turn.completedAt!),
      ],
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
      gitArtifacts: [gitArtifact],
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
      autoCollapseWorkLog: true,
      showChangedFileSummaries: true,
      checkpointRestoreDisabled: false,
      onRespondToApproval: async () => undefined,
      onRespondToInput: async () => undefined,
      onRevertCheckpoint: () => undefined,
      onOpenTurnDiff: () => undefined,
      onCompareTurnArtifacts: () => undefined,
      onOpenTurnFile: () => undefined,
      onStop: () => undefined,
    }));

    expect(html).toContain('class="turn-changed-files"');
    expect(html).toContain('aria-label="Changed by this turn"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("<strong>2 files changed</strong><small>· +84 −21 · main</small>");
    expect(html).toContain("View");
    expect(html).toContain('class="turn-changed-files-list"');
    expect(html).toContain("modified · +64 −9");
    expect(html).toContain("added · +20 −12");
    expect(html).toContain("Open exact turn diff");
    expect(html).toContain('aria-label="Open src/history.ts"');
    expect(html).toContain("The complete file summary is retained, but the stored patch reached its size limit.");
    expect(html.indexOf("2 files changed")).toBeGreaterThan(html.indexOf('aria-label="Final answer actions and run metadata"'));

    const expired = {
      ...gitArtifact,
      failureReason: null,
      completeness: "complete" as const,
      patchState: "expired" as const,
    };
    expect(turnGitArtifactPatchAvailable(expired)).toBe(false);
    expect(turnGitArtifactCompletenessWarning(expired)).toBe(
      "The stored patch has expired; the historical file summary is still available.",
    );
    expect(turnGitArtifactCompletenessWarning({
      ...expired,
      completeness: "partial",
    })).toBe(
      "Only a partial historical Git capture is available for this turn. The stored patch has expired; the historical file summary is still available.",
    );
    expect(turnGitArtifactPatchAvailable({
      ...expired,
      patchState: "truncated",
    })).toBe(true);
  });

  it("offers comparison with the nearest earlier compatible worktree", () => {
    const turns = [
      agentTurn("turn-1", "user-1"),
      agentTurn("turn-2", "user-2"),
      agentTurn("turn-3", "user-3"),
    ];
    const first = artifact("artifact-1", turns[0]!.id, "src/first.ts");
    const unrelated = artifact("artifact-2", turns[1]!.id, "src/unrelated.ts", {
      repositoryIdentity: "f".repeat(64),
      worktreeIdentity: "e".repeat(64),
    });
    const compatible = artifact("artifact-3", turns[2]!.id, "src/latest.ts");
    const html = renderToStaticMarkup(createElement(ResponseTimeline, {
      turns,
      messages: turns.map((turn, index) => message(
        `user-${index + 1}`,
        turn.id,
        "user",
        `Request ${index + 1}`,
        turn.requestedAt,
      )),
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
      gitArtifacts: [first, unrelated, compatible],
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
      autoCollapseWorkLog: true,
      showChangedFileSummaries: true,
      checkpointRestoreDisabled: false,
      onRespondToApproval: async () => undefined,
      onRespondToInput: async () => undefined,
      onRevertCheckpoint: () => undefined,
      onOpenTurnDiff: () => undefined,
      onCompareTurnArtifacts: () => undefined,
      onOpenTurnFile: () => undefined,
      onStop: () => undefined,
    }));

    expect(html.match(/Compare with previous turn/gu)).toHaveLength(1);
    expect(html.indexOf("Compare with previous turn")).toBeGreaterThan(html.indexOf("src/latest.ts"));
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

    expect(html).toContain('data-final-answer-identity="historical-model-selection">Claude · Kimi · K3</span>');
    expect(html).toContain("<span>Run details</span>");
    expect(html).not.toContain("Claude harness ·");
  });

  it("keeps answer actions quiet and exposes persisted technical metadata through an accessible Run details disclosure", () => {
    const turn = agentTurn("turn-footer", "user-footer", {
      harnessId: "legacy-harness-projection",
      backendProfileId: "legacy-backend-projection",
      model: "legacy-model-projection",
      reasoningEffort: "legacy-reasoning-projection",
      providerSessionBefore: "provider-session-before-secret",
      providerSessionAfter: "provider-session-after-secret",
      configurationRevision: 987,
      terminalAssistantMessageId: "assistant-footer",
      modelSelection: {
        harnessId: "vendor-harness-v2",
        backendProfileId: "custom:acme",
        backendProfileDisplayName: "Acme Gateway",
        modelId: "acme/code-pro",
        alias: "Code Pro",
        reasoningEffort: "medium",
        contextWindowOverride: null,
        providerOptions: {},
        capabilities: [],
        backendConfigurationRevision: 42,
      },
    });
    const gitArtifact = artifact("artifact-footer", turn.id, "src/footer.ts", {
      status: "partial",
      completeness: "partial",
      patchState: "available",
    });
    const html = renderToStaticMarkup(createElement(ResponseTimeline, {
      turns: [turn],
      messages: [
        message("user-footer", turn.id, "user", "Polish the footer", turn.requestedAt),
        message("assistant-footer", turn.id, "assistant", "Footer complete.", turn.completedAt!),
      ],
      activities: [],
      reasonings: [],
      plans: [],
      checkpoints: [],
      gitArtifacts: [gitArtifact],
      projectRoot: "/workspace",
      projectId: "project-1",
      conversationId,
      streamingText: "",
      streamingReasoning: "",
      approvals: [],
      inputRequests: [],
      showTimestamps: true,
      showThinking: false,
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
      onStop: () => undefined,
    }));

    const footerStart = html.indexOf('aria-label="Final answer actions and run metadata"');
    const primaryEnd = html.indexOf("</div>", footerStart);
    const detailsEnd = html.indexOf("</dl>", primaryEnd);
    const footerPrimary = html.slice(footerStart, primaryEnd);
    const runDetails = html.slice(primaryEnd, detailsEnd);

    expect(footerStart).toBeGreaterThan(html.indexOf("Footer complete."));
    expect(html.indexOf("1 file changed")).toBeGreaterThan(footerStart);
    expect(footerPrimary).toContain('aria-label="Copy final answer"');
    expect(footerPrimary).toContain(`dateTime="${turn.completedAt}"`);
    expect(footerPrimary).toContain('data-turn-status="completed">Completed</span>');
    expect(footerPrimary).toContain('class="turn-duration">Worked 7s</span>');
    expect(footerPrimary).toContain('aria-expanded="false"');
    expect(footerPrimary).toContain('aria-controls="turn-run-details-turn-footer"');
    expect(footerPrimary).toContain("<span>Run details</span>");
    expect(footerPrimary).not.toContain("vendor-harness-v2");
    expect(runDetails).toContain(
      'id="turn-run-details-turn-footer" aria-labelledby="turn-run-details-turn-footer-label" hidden=""',
    );
    expect(runDetails).not.toContain("<dt>");
    expect(html).not.toContain("provider-session-before-secret");
    expect(html).not.toContain("provider-session-after-secret");
    expect(html).not.toContain("legacy-harness-projection");
    expect(html).not.toContain("legacy-backend-projection");
    expect(html).not.toContain("legacy-model-projection");
    expect(html).not.toContain("legacy-reasoning-projection");
    expect(html).not.toContain(">987<");
    expect(html).not.toContain(">42<");
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
    expect(workSummaryLabel(response)).toBe("Completed without tool activity");
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
    expect(markers[0]).toMatchObject({
      index: 0,
      id: "turn-000",
      label: "Request 0 with a stable label",
    });
    expect(markers.at(-1)).toMatchObject({ index: 119, id: "turn-119" });
    expect(shouldVirtualizeTimeline(9)).toBe(false);
    expect(shouldVirtualizeTimeline(10)).toBe(true);
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
    expect(estimateTimelineRowSize(timeline[0]!)).toBeGreaterThanOrEqual(190);
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
