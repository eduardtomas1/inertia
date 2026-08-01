import { describe, expect, it } from "vitest";

import {
  responseTimelineArticleLabel,
  sameTurnTimelineProps,
  type ResponseTimelineProps,
} from "../../src/renderer/src/components/ResponseTimeline";
import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
  ChatMessage,
  SubagentTrace,
  TurnGitArtifact,
} from "../../src/shared/contracts";
import {
  buildResponseTimeline,
  buildTimelineMinimapMarkers,
  estimateCompletedTurnSpacing,
  estimateTimelineRenderWeight,
  estimateTimelineRowSize,
  shouldAdjustTimelineScrollPosition,
  shouldFollowTimeline,
  shouldShowTurnGitArtifactSummary,
  shouldVirtualizeTimeline,
  stabilizeResponseTimeline,
  updateResponseTimelineForActivityDelta,
  type ResponseTimelineItem,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";

const conversationId = "22222222-2222-4222-8222-222222222222";
const requestedAt = "2026-07-26T10:00:00.000Z";
const startedAt = "2026-07-26T10:00:01.000Z";
const completedAt = "2026-07-26T10:00:04.000Z";

function agentTurn(
  id: string,
  status: AgentTurn["status"] = "completed",
  terminalAssistantMessageId: string | null = `${id}-answer`,
): AgentTurn {
  return {
    id,
    conversationId,
    runId: `${id}-run`,
    userMessageId: `${id}-request`,
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
    modelAlias: "latest",
    reasoningEffort: "xhigh",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: "session-after",
    requestedAt,
    startedAt,
    completedAt: status === "running" || status === "waiting-for-approval" || status === "waiting-for-input"
      ? null
      : completedAt,
    status,
    terminalReason: status === "completed" ? "provider-completed" : null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: completedAt,
  };
}

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
    createdAt: role === "user" ? requestedAt : completedAt,
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
    runId: `${turnId}-run`,
    turnId,
    kind: "tool",
    title: "Read a source file",
    detail: null,
    status: "completed",
    createdAt: completedAt,
    ...update,
  };
}

function artifact(turnId: string, fileCount: number): TurnGitArtifact {
  return {
    id: `${turnId}-artifact`,
    turnId,
    conversationId,
    runId: `${turnId}-run`,
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
    capturedAt: completedAt,
    terminalAssistantMessageId: `${turnId}-answer`,
    failureReason: null,
    insertions: fileCount,
    deletions: 0,
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `src/file-${index}.ts`,
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
    })),
  };
}

function approval(turnId: string): AgentApprovalRequest {
  return {
    id: `${turnId}-approval`,
    providerId: "codex",
    conversationId,
    runId: `${turnId}-run`,
    turnId,
    kind: "command",
    title: "Approve the verification command",
    detail: null,
    command: "npm run typecheck\nnpm run test",
    cwd: "/workspace/inertia",
    reason: "The command needs supervised execution.",
    networkScope: null,
    permissionRoots: [],
    availableDecisions: ["approve", "deny", "cancel"],
  };
}

function inputRequest(turnId: string): AgentInputRequest {
  return {
    id: `${turnId}-input`,
    providerId: "codex",
    conversationId,
    runId: `${turnId}-run`,
    turnId,
    autoResolutionMs: null,
    questions: [{
      id: "question-1",
      header: "Direction",
      question: "Which implementation should be used for the long-history fixture?",
      isOther: true,
      isSecret: false,
      allowMultiple: false,
      options: [
        { id: "quiet", label: "Quiet ledger", description: "Keep successful operational work collapsed." },
        { id: "expanded", label: "Expanded", description: "Show the complete work history." },
      ],
    }],
  };
}

function buildItem({
  id,
  request = "Please fix this.",
  answer = "Done.",
  status = "completed",
  activities = [],
  commentary = [],
  approvals = [],
  inputRequests = [],
  gitArtifact,
}: {
  id: string;
  request?: string;
  answer?: string;
  status?: AgentTurn["status"];
  activities?: AgentActivity[];
  commentary?: string[];
  approvals?: AgentApprovalRequest[];
  inputRequests?: AgentInputRequest[];
  gitArtifact?: TurnGitArtifact;
}): ResponseTimelineItem {
  const terminalAnswerId = answer ? `${id}-answer` : null;
  const turn = agentTurn(id, status, terminalAnswerId);
  const timeline = buildResponseTimeline({
    turns: [turn],
    messages: [
      message(`${id}-request`, id, "user", request),
      ...commentary.map((content, index) =>
        message(`${id}-commentary-${index}`, id, "assistant", content)),
      ...(answer ? [message(`${id}-answer`, id, "assistant", answer)] : []),
    ],
    activities,
    reasonings: [],
    approvals,
    inputRequests,
    checkpoints: [],
    gitArtifacts: gitArtifact ? [gitArtifact] : [],
  });
  const item = timeline.find((candidate) => candidate.kind === "turn");
  if (!item) throw new Error(`Missing timeline item ${id}`);
  return item;
}

function responseTurns(items: ResponseTimelineItem[]): ResponseTurn[] {
  return items.flatMap((item) => item.kind === "turn" ? [item.turn] : []);
}

describe("quiet-ledger timeline virtualization estimates", () => {
  it("gives every virtualized feed article a stable request-derived name", () => {
    expect(responseTimelineArticleLabel(buildItem({
      id: "named",
      request: "  Preserve   focus\nacross the virtual window.  ",
    }))).toBe("Turn 1: Preserve focus across the virtual window.");
    expect(responseTimelineArticleLabel(buildItem({
      id: "bounded-name",
      request: "x".repeat(120),
    }))).toBe(`Turn 1: ${"x".repeat(95)}…`);
    expect(responseTimelineArticleLabel(buildItem({
      id: "empty-name",
      request: "  ",
    }))).toBe("Turn 1: Request");
  });

  it("virtualizes short histories when mounted content weight exceeds ordinary rows", () => {
    const turns = Array.from({ length: 36 }, (_, index) =>
      agentTurn(`weighted-${index}`));
    const messages = turns.flatMap((turn, index) => {
      const commentaryCount = index < 29 ? 3 : 2;
      return [
        message(turn.userMessageId, turn.id, "user", `Request ${index}`),
        ...Array.from({ length: commentaryCount }, (_, commentaryIndex) =>
          message(
            `${turn.id}-commentary-${commentaryIndex}`,
            turn.id,
            "assistant",
            `Commentary ${index}.${commentaryIndex}`,
          )),
        message(turn.terminalAssistantMessageId!, turn.id, "assistant", `Answer ${index}`),
      ];
    });
    const activities = turns.flatMap((turn, turnIndex) =>
      Array.from({ length: 34 }, (_, activityIndex) =>
        activity(`weighted-${turnIndex}-${activityIndex}`, turn.id, {
          detail: "x".repeat(2_778),
        })));
    const startedAt = performance.now();
    const timeline = buildResponseTimeline({
      turns,
      messages,
      activities,
      reasonings: [],
      checkpoints: [],
    });
    const weight = estimateTimelineRenderWeight(timeline);
    const elapsed = performance.now() - startedAt;

    expect(timeline).toHaveLength(36);
    expect(messages.filter(({ role }) => role === "assistant")).toHaveLength(137);
    expect(activities).toHaveLength(1_224);
    expect(activities.reduce(
      (total, entry) => total + (entry.detail?.length ?? 0),
      0,
    )).toBeGreaterThan(3_400_000);
    expect(shouldVirtualizeTimeline(timeline.length)).toBe(true);
    expect(weight).toBeGreaterThan(40);
    expect(shouldVirtualizeTimeline(timeline.length, weight)).toBe(true);
    expect(shouldVirtualizeTimeline(9, 9)).toBe(false);
    expect(shouldVirtualizeTimeline(9, 10)).toBe(false);
    expect(shouldVirtualizeTimeline(10, 10)).toBe(true);
    expect(elapsed).toBeLessThan(250);
  });

  it("keeps compact answers compact and scales with structurally long Markdown", () => {
    const short = buildItem({ id: "short" });
    const longMarkdown = Array.from({ length: 36 }, (_, index) => [
      `## Section ${index + 1}`,
      "",
      "This paragraph explains a focused implementation detail with enough text to wrap naturally in the editorial answer column.",
      "",
      "- Preserve stable row identities",
      "- Measure rendered content",
      "- Keep the reader's scroll anchor",
      "",
      "```ts",
      `const section${index + 1} = "verified";`,
      "```",
    ].join("\n")).join("\n\n");
    const long = buildItem({ id: "long", answer: longMarkdown });

    const shortEstimate = estimateTimelineRowSize(short);
    const longEstimate = estimateTimelineRowSize(long);
    expect(shortEstimate).toBeLessThan(320);
    expect(longEstimate).toBeGreaterThan(shortEstimate * 8);
    expect(longEstimate).toBeLessThanOrEqual(12_400);
  });

  it("accounts for wrapping, interface scale, and response density using integer CSS-pixel estimates", () => {
    const item = buildItem({
      id: "scaled",
      request: "Review the Linux fractional-pixel layout and preserve the visible anchor.",
      answer: Array.from({ length: 18 }, () =>
        "Measured editorial wrapping ".repeat(10).trim()).join("\n\n"),
    });
    const widths = [760, 760 / 1.25, 760 / 1.5];
    const estimates = widths.map((availableWidth) =>
      estimateTimelineRowSize(item, { availableWidth: availableWidth + 0.25 }));

    expect(estimates.every(Number.isFinite)).toBe(true);
    expect(estimates.every(Number.isInteger)).toBe(true);
    expect(estimates[1]).toBeGreaterThan(estimates[0]!);
    expect(estimates[2]).toBeGreaterThan(estimates[1]!);

    const compact = estimateTimelineRowSize(item, {
      availableWidth: 720,
      interfaceScale: "compact",
      responseDensity: "compact",
    });
    const defaultSize = estimateTimelineRowSize(item, {
      availableWidth: 720,
      interfaceScale: "default",
      responseDensity: "default",
    });
    const largeComfortable = estimateTimelineRowSize(item, {
      availableWidth: 720,
      interfaceScale: "large",
      responseDensity: "comfortable",
    });
    expect(compact).toBeLessThan(defaultSize);
    expect(largeComfortable).toBeGreaterThan(defaultSize);
  });

  it("prices completed layer, footer, and artifact gaps without collapsing exceptional work", () => {
    const clean = buildItem({
      id: "completed-spacing-clean",
      answer: "A concise successful answer.",
      activities: [activity("clean-tool", "completed-spacing-clean")],
      gitArtifact: artifact("completed-spacing-clean", 1),
    });
    const exceptional = buildItem({
      id: "completed-spacing-exceptional",
      answer: "A concise answer with an actionable failure.",
      activities: [
        activity("exception-tool", "completed-spacing-exceptional"),
        activity("exception-failure", "completed-spacing-exceptional", {
          kind: "command",
          title: "Verification failed",
          detail: "One focused assertion failed.",
          status: "failed",
        }),
      ],
      gitArtifact: artifact("completed-spacing-exceptional", 1),
    });

    expect(estimateCompletedTurnSpacing("compact").layer)
      .toBeLessThan(estimateCompletedTurnSpacing("default").layer);
    expect(estimateCompletedTurnSpacing("default").layer)
      .toBeLessThan(estimateCompletedTurnSpacing("comfortable").layer);
    expect(estimateTimelineRowSize(exceptional))
      .toBeGreaterThan(estimateTimelineRowSize(clean) + 40);
    expect(estimateTimelineRowSize(clean, { responseDensity: "compact" }))
      .toBeLessThan(estimateTimelineRowSize(clean));
    expect(estimateTimelineRowSize(clean, { responseDensity: "comfortable" }))
      .toBeGreaterThan(estimateTimelineRowSize(clean));
  });

  it("prices nested disclosures by their actual collapsed and expanded states", () => {
    const turnId = "details";
    const activities = Array.from({ length: 120 }, (_, index) =>
      activity(`activity-${index}`, turnId));
    const item = buildItem({ id: turnId, activities });
    const collapsed = estimateTimelineRowSize(item);
    const expandedWork = estimateTimelineRowSize(item, { workDetailsExpanded: true });
    const expandedGroups = estimateTimelineRowSize(item, {
      workDetailsExpanded: true,
      activityGroupsExpanded: true,
    });
    const expandedRun = estimateTimelineRowSize(item, { runDetailsExpanded: true });

    expect(collapsed).toBeLessThan(380);
    expect(expandedWork).toBeGreaterThan(collapsed);
    expect(expandedWork).toBeLessThan(collapsed + 200);
    expect(expandedGroups).toBeGreaterThan(expandedWork + 2_000);
    expect(expandedRun).toBeGreaterThan(collapsed + 100);
    const mediumRun = estimateTimelineRowSize(item, {
      availableWidth: 600,
      runDetailsExpanded: true,
    });
    const narrowRun = estimateTimelineRowSize(item, {
      availableWidth: 400,
      runDetailsExpanded: true,
    });
    expect(mediumRun).toBeGreaterThan(expandedRun + 100);
    expect(narrowRun).toBeGreaterThan(mediumRun + 150);

    const oneFile = buildItem({ id: "one-file", gitArtifact: artifact("one-file", 1) });
    const manyFiles = buildItem({ id: "many-files", gitArtifact: artifact("many-files", 80) });
    expect(estimateTimelineRowSize(manyFiles)).toBe(estimateTimelineRowSize(oneFile));
    expect(estimateTimelineRowSize(manyFiles, { changedFilesExpanded: true }))
      .toBeGreaterThan(estimateTimelineRowSize(manyFiles) + 300);
  });

  it("keeps raw tool output virtualization bounded to the compact preview", () => {
    const bounded = buildItem({
      id: "bounded-output",
      activities: [activity("bounded-command", "bounded-output", {
        kind: "command",
        title: "Run verification",
        detail: `Command:\nnpm test\nOutput:\n${"x".repeat(32 * 1024)}`,
      })],
    });
    const enormous = buildItem({
      id: "enormous-output",
      activities: [activity("enormous-command", "enormous-output", {
        kind: "command",
        title: "Run verification",
        detail: `Command:\nnpm test\nOutput:\n${"x".repeat(1024 * 1024)}`,
      })],
    });

    expect(estimateTimelineRowSize(enormous, { workDetailsExpanded: true }))
      .toBe(estimateTimelineRowSize(bounded, { workDetailsExpanded: true }));
  });

  it("prices visible attention boundaries without expanding collapsed adjacent calls", () => {
    const successActivities = Array.from({ length: 8 }, (_, index) =>
      activity(`success-${index}`, "successes", {
        createdAt: `2026-07-26T10:00:${String(index).padStart(2, "0")}.000Z`,
      }));
    const boundedActivities = successActivities.map((item, index) =>
      index === 3
        ? {
            ...item,
            id: "warning-boundary",
            kind: "status" as const,
            title: "Unsupported option skipped",
          }
        : index === 6
          ? {
              ...item,
              id: "failure-boundary",
              title: "Verification failed",
              status: "failed" as const,
            }
          : item);
    const collapsedSuccesses = buildItem({
      id: "successes",
      status: "running",
      answer: "",
      activities: successActivities,
    });
    const collapsedBoundaries = buildItem({
      id: "boundaries",
      status: "running",
      answer: "",
      activities: boundedActivities.map((item) => ({ ...item, turnId: "boundaries" })),
    });

    expect(estimateTimelineRowSize(collapsedSuccesses)).toBeLessThan(380);
    expect(estimateTimelineRowSize(collapsedBoundaries))
      .toBeGreaterThan(estimateTimelineRowSize(collapsedSuccesses) + 40);
    expect(estimateTimelineRowSize(collapsedBoundaries, { activityGroupsExpanded: true }))
      .toBeGreaterThan(estimateTimelineRowSize(collapsedBoundaries));
  });

  it("does not reserve a virtualized rail for quiet success but keeps exceptional history measurable", () => {
    const quiet = buildItem({
      id: "quiet-settled-estimate",
      activities: [activity("quiet-read", "quiet-settled-estimate")],
    });
    const warning = buildItem({
      id: "warning-settled-estimate",
      activities: [
        activity("warning-read", "warning-settled-estimate"),
        activity("warning-boundary", "warning-settled-estimate", {
          kind: "status",
          title: "Warning: optional provider feature skipped",
        }),
      ],
    });

    const quietEstimate = estimateTimelineRowSize(quiet);
    expect(estimateTimelineRowSize(warning)).toBeGreaterThanOrEqual(quietEstimate + 50);
    expect(estimateTimelineRowSize(quiet, { runDetailsExpanded: true }))
      .toBeGreaterThan(quietEstimate + 100);
  });

  it("models commentary growth without inflating collapsed settled history", () => {
    const shortActive = buildItem({
      id: "commentary-short",
      status: "running",
      answer: "",
      commentary: ["Inspecting the current virtual window."],
    });
    const longActive = buildItem({
      id: "commentary-long",
      status: "running",
      answer: "",
      commentary: [Array.from({ length: 24 }, () =>
        "Streaming commentary grows while the reader remains anchored.").join(" ")],
    });
    const settled = buildItem({
      id: "commentary-settled",
      commentary: Array.from({ length: 18 }, (_, index) =>
        `Persisted commentary segment ${index + 1} with enough text to wrap.`),
    });

    expect(estimateTimelineRowSize(longActive))
      .toBeGreaterThan(estimateTimelineRowSize(shortActive) + 250);
    expect(estimateTimelineRowSize(settled)).toBeLessThan(380);
    expect(estimateTimelineRowSize(settled, { workDetailsExpanded: true }))
      .toBeGreaterThan(estimateTimelineRowSize(settled) + 500);
  });

  it("reserves visible space for approvals, provider questions, warnings, and failures", () => {
    const base = buildItem({ id: "base-active", status: "running", answer: "" });
    const approvalItem = buildItem({
      id: "approval",
      status: "waiting-for-approval",
      answer: "",
      approvals: [approval("approval")],
    });
    const questionItem = buildItem({
      id: "question",
      status: "waiting-for-input",
      answer: "",
      inputRequests: [inputRequest("question")],
    });
    const failedItem = buildItem({
      id: "failure",
      status: "failed",
      answer: "",
      activities: [
        activity("failed-command", "failure", {
          kind: "command",
          title: "Verification failed",
          detail: "The renderer returned an actionable failure that must remain visible.",
          status: "failed",
        }),
        activity("warning", "failure", {
          kind: "status",
          title: "Unsupported option skipped",
        }),
        activity("blocked-command", "failure", {
          kind: "command",
          title: "Upload blocked",
        }),
      ],
    });
    const failedBase = buildItem({ id: "failed-base", status: "failed", answer: "" });

    const baseEstimate = estimateTimelineRowSize(base);
    expect(estimateTimelineRowSize(base, { runDetailsExpanded: true })).toBe(baseEstimate);
    expect(estimateTimelineRowSize(approvalItem)).toBeGreaterThan(baseEstimate + 100);
    expect(estimateTimelineRowSize(questionItem)).toBeGreaterThan(baseEstimate + 180);
    const visibleFailureDelta = estimateTimelineRowSize(failedItem)
      - estimateTimelineRowSize(failedBase);
    expect(visibleFailureDelta).toBeGreaterThanOrEqual(50);
    expect(visibleFailureDelta).toBeLessThanOrEqual(80);
  });

  it("does not reserve a hidden row for an expected non-Git artifact absence", () => {
    const unavailable = {
      ...artifact("not-repository", 0),
      repositoryIdentity: null,
      worktreeIdentity: null,
      beforeFingerprint: null,
      afterFingerprint: null,
      status: "unavailable" as const,
      completeness: "unavailable" as const,
      patchState: "none" as const,
      patchDigest: null,
      absenceReason: "not-repository" as const,
      failureReason: "No Git repository was found.",
    };
    const item = buildItem({
      id: "not-repository",
      gitArtifact: unavailable,
    });

    expect(shouldShowTurnGitArtifactSummary(unavailable)).toBe(false);
    expect(estimateTimelineRowSize(item, { showChangedFiles: true }))
      .toBe(estimateTimelineRowSize(item, { showChangedFiles: false }));
  });

  it("preserves user-controlled scroll during streaming and resize measurement changes", () => {
    const base = {
      scrollOffset: 1_000,
      scrollDirection: "forward" as const,
      manuallyAnchored: false,
    };

    expect(shouldAdjustTimelineScrollPosition({
      ...base,
      itemStart: 700,
      itemSize: 500,
      firstMeasurement: false,
    })).toBe(false);
    expect(shouldAdjustTimelineScrollPosition({
      ...base,
      itemStart: 700,
      itemSize: 200,
      firstMeasurement: false,
    })).toBe(true);
    expect(shouldAdjustTimelineScrollPosition({
      ...base,
      itemStart: 700,
      itemSize: 200,
      firstMeasurement: false,
      scrollDirection: "backward",
    })).toBe(false);
    expect(shouldAdjustTimelineScrollPosition({
      ...base,
      itemStart: 700,
      itemSize: 500,
      firstMeasurement: true,
    })).toBe(true);
    expect(shouldAdjustTimelineScrollPosition({
      ...base,
      itemStart: 700,
      itemSize: 200,
      firstMeasurement: true,
      manuallyAnchored: true,
    })).toBe(false);

    expect(shouldFollowTimeline(1_380, 500, 2_000)).toBe(true);
    expect(shouldFollowTimeline(1_200, 500, 2_000)).toBe(false);
  });

  it("keeps hundreds of rows and thousands of events bounded, keyed, and memoizable", () => {
    const count = 600;
    const turns = Array.from({ length: count }, (_, index) =>
      agentTurn(`turn-${String(index).padStart(3, "0")}`));
    const messages = turns.flatMap((turn, index) => [
      message(turn.userMessageId, turn.id, "user", `Request ${index}`),
      message(turn.terminalAssistantMessageId!, turn.id, "assistant", index % 100 === 0
        ? Array.from({ length: 80 }, () => "Long historical answer paragraph.").join("\n\n")
        : `Final answer ${index}.`),
    ]);
    const activities = turns.flatMap((turn, turnIndex) =>
      Array.from({ length: 5 }, (_, activityIndex) =>
        activity(`activity-${turnIndex}-${activityIndex}`, turn.id, {
          createdAt: new Date(
            Date.parse(startedAt) + activityIndex * 100,
          ).toISOString(),
        })));
    const timeline = buildResponseTimeline({
      turns,
      messages,
      activities,
      reasonings: [],
      checkpoints: [],
    });
    const estimates = timeline.map((item) => estimateTimelineRowSize(item, {
      availableWidth: 704.25,
    }));

    expect(timeline).toHaveLength(count);
    expect(activities).toHaveLength(3_000);
    expect(timeline[0]?.id).toBe("turn-000");
    expect(timeline.at(-1)?.id).toBe("turn-599");
    expect(shouldVirtualizeTimeline(timeline.length)).toBe(true);
    expect(buildTimelineMinimapMarkers(responseTurns(timeline))).toHaveLength(48);
    expect(estimates.every((estimate) => Number.isInteger(estimate) && estimate >= 190)).toBe(true);
    expect(estimates.reduce((total, estimate) => total + estimate, 0)).toBeLessThan(count * 430);

    const stable = stabilizeResponseTimeline(timeline, []);
    expect(stabilizeResponseTimeline(timeline, stable)).toBe(stable);

    const changedActivities = activities.map((item) =>
      item.id === "activity-599-4"
        ? { ...item, detail: "Only the newest event changed." }
        : item);
    const advancedBuild = updateResponseTimelineForActivityDelta({
      turns,
      messages,
      activities: changedActivities,
      reasonings: [],
      checkpoints: [],
    }, activities, stable);
    expect(advancedBuild).not.toBeNull();
    const advanced = stabilizeResponseTimeline(advancedBuild!, stable);
    expect(advanced).not.toBe(stable);
    expect(advanced.slice(0, -1).every((item, index) => item === stable[index])).toBe(true);
    expect(advanced.at(-1)).not.toBe(stable.at(-1));

    const orphanedActivities = [
      ...changedActivities,
      {
        ...activity("orphan", "turn-599", {
          detail: "Compatibility activity.",
        }),
        turnId: null,
      },
    ];
    expect(updateResponseTimelineForActivityDelta({
      turns,
      messages,
      activities: orphanedActivities,
      reasonings: [],
      checkpoints: [],
    }, changedActivities, advanced)).toBeNull();
  });

  it("memoizes settled rows across provider refreshes and isolates live-stream invalidation", () => {
    const settled = responseTurns([buildItem({ id: "memo-settled" })])[0]!;
    const active = responseTurns([buildItem({
      id: "memo-active",
      status: "running",
      answer: "",
    })])[0]!;
    const baseProps = {
      streamingText: "first",
      streamingReasoning: "reasoning",
      showTimestamps: false,
      showThinking: false,
      defaultCodeWrap: false,
      autoCollapseWorkLog: true,
      showChangedFileSummaries: true,
      checkpointRestoreDisabled: false,
    } as unknown as ResponseTimelineProps;
    const memoInput = (
      turn: ResponseTurn,
      props: ResponseTimelineProps,
      subagents?: SubagentTrace[],
    ) => ({
      turn,
      props,
      previousArtifactTurnId: null,
      subagents,
    });

    expect(sameTurnTimelineProps(
      memoInput(settled, baseProps),
      memoInput(settled, { ...baseProps, streamingText: "second" }),
    )).toBe(true);
    expect(sameTurnTimelineProps(
      memoInput(active, baseProps),
      memoInput(active, { ...baseProps, streamingText: "second" }),
    )).toBe(false);
    expect(sameTurnTimelineProps(
      memoInput(settled, baseProps),
      memoInput(settled, { ...baseProps, showTimestamps: true }),
    )).toBe(false);
    const localSubagents: SubagentTrace[] = [];
    expect(sameTurnTimelineProps(
      memoInput(settled, {
        ...baseProps,
        subagents: [],
      }, localSubagents),
      memoInput(settled, {
        ...baseProps,
        subagents: [],
      }, localSubagents),
    )).toBe(true);
    expect(sameTurnTimelineProps(
      memoInput(settled, baseProps, localSubagents),
      memoInput(settled, baseProps, [...localSubagents]),
    )).toBe(false);
  });
});
