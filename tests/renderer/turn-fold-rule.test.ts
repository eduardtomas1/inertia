import { describe, expect, it } from "vitest";

import {
  activitySentenceText,
  activitySummarySentence,
  activitySummarySentenceLabel,
  buildResponseTimeline,
  isQuietSettledTurn,
  needsStaticFoldRow,
  shouldFoldSettledTurn,
  summarizeActivities,
  turnFoldLabel,
  turnHasFoldableWork,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentActivity,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const conversationId = "17171717-1717-4171-8171-171717171717";

function activity(id: string, overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id,
    conversationId,
    runId: "run-1",
    turnId: "turn-1",
    kind: "command",
    title: "Command",
    detail: null,
    status: "completed",
    createdAt: "2030-05-01T10:00:10.000Z",
    ...overrides,
  };
}

const kinds = {
  command: (id: string) => activity(id, { detail: "Command:\nnpm test" }),
  edit: (id: string) => activity(id, { kind: "file", title: `src/${id}.ts` }),
  read: (id: string) => activity(id, { kind: "tool", title: "Read", detail: `Path:\nsrc/${id}.ts` }),
  search: (id: string) => activity(id, { kind: "tool", title: "Grep" }),
  browser: (id: string) => activity(id, { kind: "tool", title: "mcp__inertia-chat-manager__inertia_browser_snapshot" }),
  tool: (id: string) => activity(id, { kind: "tool", title: "MCP · github/search_issues" }),
};

function sentence(counts: Partial<Record<keyof typeof kinds, number>>): string {
  const activities = Object.entries(counts).flatMap(([kind, count]) =>
    Array.from({ length: count ?? 0 }, (_, index) =>
      kinds[kind as keyof typeof kinds](`${kind}-${index}`)));
  return activitySentenceText(activitySummarySentence(summarizeActivities(activities)));
}

describe("activity group sentences", () => {
  it("names a single category with the right verb and number", () => {
    expect(sentence({ command: 1 })).toBe("Ran 1 command");
    expect(sentence({ command: 3 })).toBe("Ran 3 commands");
    expect(sentence({ edit: 1 })).toBe("Edited 1 file");
    expect(sentence({ edit: 2 })).toBe("Edited 2 files");
    expect(sentence({ read: 1 })).toBe("Read 1 file");
    expect(sentence({ read: 4 })).toBe("Read 4 files");
    expect(sentence({ search: 1 })).toBe("Searched 1 time");
    expect(sentence({ search: 2 })).toBe("Searched 2 times");
    expect(sentence({ browser: 1 })).toBe("Took 1 browser action");
    expect(sentence({ browser: 5 })).toBe("Took 5 browser actions");
    expect(sentence({ tool: 1 })).toBe("Called 1 tool");
    expect(sentence({ tool: 2 })).toBe("Called 2 tools");
  });

  it("joins the top two categories by priority and counts the rest as other actions", () => {
    expect(sentence({ command: 3, edit: 2 })).toBe("Ran 3 commands, edited 2 files");
    expect(sentence({ edit: 1, read: 1 })).toBe("Edited 1 file, read 1 file");
    expect(sentence({ read: 2, search: 1 })).toBe("Read 2 files, searched 1 time");
    expect(sentence({ search: 2, browser: 1 })).toBe("Searched 2 times, took 1 browser action");
    expect(sentence({ command: 1, tool: 2 })).toBe("Ran 1 command and 2 other actions");
    expect(sentence({ browser: 1, tool: 1 })).toBe("Took 1 browser action and 1 other action");
    expect(sentence({ command: 3, edit: 2, read: 1 })).toBe("Ran 3 commands, edited 2 files and 1 other action");
    expect(sentence({ command: 1, read: 2, search: 3, browser: 1, tool: 4 }))
      .toBe("Ran 1 command, read 2 files and 8 other actions");
    expect(sentence({ tool: 1, read: 1 })).toBe("Read 1 file and 1 other action");
  });

  it("falls back to updates and keeps failures and warnings in the accessible label", () => {
    expect(sentence({})).toBe("");
    expect(activitySentenceText(activitySummarySentence(summarizeActivities([
      activity("status-one", { kind: "status", title: "Connected" }),
      activity("status-two", { kind: "status", title: "Reconnected" }),
    ])))).toBe("2 updates");
    expect(activitySummarySentenceLabel(summarizeActivities([
      activity("failed-build", { detail: "Command:\nant compile", status: "failed" }),
      activity("provider-warning", { kind: "status", title: "Warning: fallback used" }),
      activity("second-warning", { kind: "status", title: "Warning: retry skipped" }),
    ]))).toBe("Ran 1 command, 1 failed, 2 warnings");
    expect(activitySummarySentenceLabel(summarizeActivities([
      activity("provider-warning", { kind: "status", title: "Warning: fallback used" }),
      activity("provider-status", { kind: "status", title: "Connected" }),
    ]))).toBe("1 warning");
  });

  it("counts distinct files when every edit or read names its path", () => {
    expect(activitySentenceText(activitySummarySentence(summarizeActivities([
      activity("edit-1", { kind: "file", title: "src/parser.ts" }),
      activity("edit-2", { kind: "file", title: "./src/parser.ts" }),
      activity("edit-3", { kind: "file", title: "src\\lexer.ts" }),
      activity("read-1", { kind: "tool", title: "View image", detail: "Path:\ndocs/a.png" }),
      activity("read-2", { kind: "tool", title: "Read", detail: "File: docs/a.png\n\nAfter:\nx" }),
    ])))).toBe("Edited 2 files, read 1 file");
    const summary = summarizeActivities([
      activity("edit-a", { kind: "file", title: "src/a.ts" }),
      activity("edit-b", { kind: "file", title: "src/a.ts" }),
    ]);
    expect(summary.edit).toBe(2);
    expect(summary.editedFiles).toBe(1);
    expect(summary.readFiles).toBeNull();
  });

  it("falls back to counting edits and reads when an activity does not name its file", () => {
    expect(activitySentenceText(activitySummarySentence(summarizeActivities([
      activity("edit-1", { kind: "tool", title: "Edit" }),
      activity("edit-2", { kind: "tool", title: "Edit" }),
    ])))).toBe("Made 2 edits");
    expect(activitySentenceText(activitySummarySentence(summarizeActivities([
      activity("edit-1", { kind: "file", title: "src/parser.ts" }),
      activity("edit-2", { kind: "tool", title: "Write" }),
    ])))).toBe("Made 2 edits");
    expect(activitySentenceText(activitySummarySentence(summarizeActivities([
      activity("read-1", { kind: "tool", title: "Read" }),
    ])))).toBe("Did 1 read");
    expect(activitySentenceText(activitySummarySentence(summarizeActivities([
      activity("cmd", { detail: "Command:\nnpm test" }),
      activity("read-1", { detail: "Command:\ncat a.ts" }),
      activity("read-2", { detail: "Command:\ncat b.ts" }),
    ])))).toBe("Ran 1 command, did 2 reads");
  });

  it("counts browser tools separately from other tool calls", () => {
    const summary = summarizeActivities([kinds.browser("b"), kinds.tool("t"), kinds.read("r")]);
    expect(summary.browser).toBe(1);
    expect(summary.tool).toBe(1);
    expect(summary.read).toBe(1);
  });
});

function agentTurn(update: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: "turn-1",
    conversationId,
    runId: "run-1",
    userMessageId: "request",
    terminalAssistantMessageId: "answer",
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
    requestedAt: "2030-05-01T10:00:00.000Z",
    startedAt: "2030-05-01T10:00:00.000Z",
    completedAt: "2030-05-01T10:03:43.000Z",
    status: "completed",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: "2030-05-01T10:00:00.000Z",
    updatedAt: "2030-05-01T10:03:43.000Z",
    ...update,
  };
}

function message(id: string, role: ChatMessage["role"], content: string, seconds: number): ChatMessage {
  return {
    id,
    conversationId,
    turnId: "turn-1",
    role,
    content,
    attachments: [],
    createdAt: `2030-05-01T10:00:${String(seconds).padStart(2, "0")}.000Z`,
  };
}

function responseTurn(input: {
  turn?: Partial<AgentTurn>;
  messages?: ChatMessage[];
  activities?: AgentActivity[];
  reasonings?: AgentReasoning[];
  plans?: AgentPlan[];
} = {}): ResponseTurn {
  const item = buildResponseTimeline({
    turns: [agentTurn(input.turn)],
    messages: [
      message("request", "user", "Fix it.", 0),
      ...(input.messages ?? []),
      message("answer", "assistant", "Fixed.", 50),
    ],
    activities: input.activities ?? [],
    reasonings: input.reasonings ?? [],
    plans: input.plans ?? [],
    checkpoints: [],
  })[0];
  if (item?.kind !== "turn") throw new Error("Expected one turn.");
  return item.turn;
}

describe("finished-turn fold rule", () => {
  it("labels the fold by duration and outcome", () => {
    expect(turnFoldLabel(responseTurn())).toBe("Worked for 3m 43s");
    expect(turnFoldLabel(responseTurn({ turn: {
      status: "cancelled",
      completedAt: "2030-05-01T10:00:12.000Z",
    } }))).toBe("Stopped after 12s");
    expect(turnFoldLabel(responseTurn({ turn: { status: "interrupted", completedAt: null } }))).toBe("Stopped");
    expect(turnFoldLabel(responseTurn({ turn: { completedAt: null } }))).toBe("Worked");
    expect(turnFoldLabel(responseTurn({ turn: { startedAt: null } }))).toBe("Worked");
  });

  it("never measures a settled turn that started but recorded no completion against the clock", () => {
    const started = responseTurn({ turn: { completedAt: null } });
    expect(started.startedAt).toBe("2030-05-01T10:00:00.000Z");
    expect(started.completedAt).toBeNull();
    const later = Date.parse("2030-05-01T12:00:00.000Z");
    expect(turnFoldLabel(started, later)).toBe("Worked");
    expect(turnFoldLabel(started, later + 60_000)).toBe("Worked");
    const stopped = responseTurn({ turn: { status: "cancelled", completedAt: null } });
    expect(turnFoldLabel(stopped, later)).toBe("Stopped");
  });

  it("folds only settled turns that did not fail and do not wait on the reader", () => {
    expect(shouldFoldSettledTurn(responseTurn())).toBe(true);
    expect(shouldFoldSettledTurn(responseTurn({ turn: { status: "cancelled" } }))).toBe(true);
    expect(shouldFoldSettledTurn(responseTurn({ turn: { status: "interrupted" } }))).toBe(true);
    expect(shouldFoldSettledTurn(responseTurn({ turn: { status: "failed" } }))).toBe(false);
    expect(shouldFoldSettledTurn(responseTurn({ turn: { status: "running", completedAt: null } }))).toBe(false);
    expect(shouldFoldSettledTurn(responseTurn({ turn: { status: "waiting-for-input", completedAt: null } }))).toBe(false);
  });

  it("has something to fold only when interim work, thinking or plans exist", () => {
    expect(turnHasFoldableWork(responseTurn(), { showThinking: true })).toBe(false);
    expect(turnHasFoldableWork(responseTurn({
      messages: [message("interim", "assistant", "Looking first.", 5)],
    }), { showThinking: false })).toBe(true);
    expect(turnHasFoldableWork(responseTurn({
      activities: [activity("read", { kind: "tool", title: "Read" })],
    }), { showThinking: false })).toBe(true);
    expect(turnHasFoldableWork(responseTurn({
      activities: [activity("failed", { status: "failed" })],
    }), { showThinking: false })).toBe(false);
    expect(turnHasFoldableWork(responseTurn({
      activities: [activity("compacted", { kind: "status", title: "Context compacted" })],
    }), { showThinking: false })).toBe(false);
    const reasoning: AgentReasoning = {
      id: "reasoning",
      conversationId,
      runId: "run-1",
      turnId: "turn-1",
      content: "Weighing the change.",
      status: "completed",
      createdAt: "2030-05-01T10:00:02.000Z",
    };
    expect(turnHasFoldableWork(responseTurn({ reasonings: [reasoning] }), { showThinking: true })).toBe(true);
    expect(turnHasFoldableWork(responseTurn({ reasonings: [reasoning] }), { showThinking: false })).toBe(false);
    expect(turnHasFoldableWork(responseTurn({
      messages: [
        message("earlier-answer", "assistant", "Done with the first part.", 5),
        message("follow-up", "user", "Also the second part.", 6),
      ],
    }), { showThinking: false })).toBe(false);
  });

  it("keeps a static duration row only for a completed turn without an answer or work", () => {
    const silent = responseTurn({ turn: { terminalAssistantMessageId: null } });
    expect(silent.terminalAssistantMessage).toBeNull();
    expect(needsStaticFoldRow(silent, false)).toBe(true);
    expect(needsStaticFoldRow(silent, true)).toBe(false);
    expect(isQuietSettledTurn(silent, false)).toBe(false);
    expect(needsStaticFoldRow(responseTurn(), false)).toBe(false);
    expect(isQuietSettledTurn(responseTurn(), false)).toBe(true);
    expect(needsStaticFoldRow(responseTurn({ turn: { status: "cancelled", terminalAssistantMessageId: null } }), false)).toBe(false);
  });
});
