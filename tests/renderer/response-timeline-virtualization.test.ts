import { describe, expect, it } from "vitest";

import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
  ChatMessage,
  TurnGitArtifact,
} from "../../src/shared/contracts";
import {
  buildResponseTimeline,
  buildTimelineMinimapMarkers,
  estimateTimelineRowSize,
  shouldVirtualizeTimeline,
  stabilizeResponseTimeline,
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
  approvals = [],
  inputRequests = [],
  gitArtifact,
}: {
  id: string;
  request?: string;
  answer?: string;
  status?: AgentTurn["status"];
  activities?: AgentActivity[];
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

  it("accounts for wrapping at 100%, 125%, and 150% zoom using integer CSS-pixel estimates", () => {
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
  });

  it("does not price collapsed history like a large panel but models expanded detail potential", () => {
    const turnId = "details";
    const activities = Array.from({ length: 120 }, (_, index) =>
      activity(`activity-${index}`, turnId));
    const item = buildItem({ id: turnId, activities });
    const collapsed = estimateTimelineRowSize(item);
    const expandedWork = estimateTimelineRowSize(item, { workDetailsExpanded: true });
    const expandedRun = estimateTimelineRowSize(item, { runDetailsExpanded: true });

    expect(collapsed).toBeLessThan(380);
    expect(expandedWork).toBeGreaterThan(collapsed + 2_000);
    expect(expandedRun).toBeGreaterThan(collapsed + 100);

    const oneFile = buildItem({ id: "one-file", gitArtifact: artifact("one-file", 1) });
    const manyFiles = buildItem({ id: "many-files", gitArtifact: artifact("many-files", 80) });
    expect(estimateTimelineRowSize(manyFiles)).toBe(estimateTimelineRowSize(oneFile));
    expect(estimateTimelineRowSize(manyFiles, { changedFilesExpanded: true }))
      .toBeGreaterThan(estimateTimelineRowSize(manyFiles) + 300);
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
      activities: [activity("failed-command", "failure", {
        kind: "command",
        title: "Verification failed",
        detail: "The renderer returned an actionable failure that must remain visible.",
        status: "failed",
      })],
    });
    const failedBase = buildItem({ id: "failed-base", status: "failed", answer: "" });

    const baseEstimate = estimateTimelineRowSize(base);
    expect(estimateTimelineRowSize(base, { runDetailsExpanded: true })).toBe(baseEstimate);
    expect(estimateTimelineRowSize(approvalItem)).toBeGreaterThan(baseEstimate + 100);
    expect(estimateTimelineRowSize(questionItem)).toBeGreaterThan(baseEstimate + 180);
    expect(estimateTimelineRowSize(failedItem)).toBeGreaterThan(estimateTimelineRowSize(failedBase) + 20);
  });

  it("keeps hundreds of rows bounded, keyed, virtualizable, and memoizable", () => {
    const count = 600;
    const turns = Array.from({ length: count }, (_, index) =>
      agentTurn(`turn-${String(index).padStart(3, "0")}`));
    const messages = turns.flatMap((turn, index) => [
      message(turn.userMessageId, turn.id, "user", `Request ${index}`),
      message(turn.terminalAssistantMessageId!, turn.id, "assistant", index % 100 === 0
        ? Array.from({ length: 80 }, () => "Long historical answer paragraph.").join("\n\n")
        : `Final answer ${index}.`),
    ]);
    const activities = turns.map((turn, index) =>
      activity(`activity-${index}`, turn.id));
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
    expect(timeline[0]?.id).toBe("turn-000");
    expect(timeline.at(-1)?.id).toBe("turn-599");
    expect(shouldVirtualizeTimeline(timeline.length)).toBe(true);
    expect(buildTimelineMinimapMarkers(responseTurns(timeline))).toHaveLength(48);
    expect(estimates.every((estimate) => Number.isInteger(estimate) && estimate >= 190)).toBe(true);
    expect(estimates.reduce((total, estimate) => total + estimate, 0)).toBeLessThan(count * 430);

    const stable = stabilizeResponseTimeline(timeline, []);
    expect(stabilizeResponseTimeline(timeline, stable)).toBe(stable);
  });
});
