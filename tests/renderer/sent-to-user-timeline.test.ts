import { describe, expect, it } from "vitest";

import type { AgentActivity, AgentTurn, ChatMessage } from "../../src/shared/contracts";
import {
  buildResponseTimeline,
  buildTurnExecutionStream,
  estimateTimelineRowSize,
  isQuietSettledTurn,
  stabilizeResponseTimeline,
  type ResponseTimelineItem,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";
import { isSettledExchangeEntry } from "../../src/renderer/src/utils/response-timeline/execution";

const conversationId = "17171717-1717-4171-8171-171717171717";
const turnId = "turn-sent-model";
const runId = "run-sent-model";

function at(seconds: number): string {
  return `2030-07-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function agentTurn(status: AgentTurn["status"] = "completed"): AgentTurn {
  const settled = status !== "running";
  return {
    id: turnId,
    conversationId,
    runId,
    userMessageId: "request",
    terminalAssistantMessageId: status === "completed" ? "answer" : null,
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
    requestedAt: at(0),
    startedAt: at(1),
    completedAt: settled ? at(30) : null,
    status,
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(0),
    updatedAt: settled ? at(30) : at(20),
  };
}

function message(id: string, role: ChatMessage["role"], content: string, seconds: number, update: Partial<ChatMessage> = {}): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt: at(seconds), ...update };
}

function tool(id: string, seconds: number): AgentActivity {
  return { id, conversationId, runId, turnId, kind: "tool", title: id, detail: null, status: "completed", createdAt: at(seconds) };
}

const request = message("request", "user", "Draft it.", 0);
const answer = message("answer", "assistant", "Should I publish it?", 25);
const sent = (id: string, seconds: number, content = "## Draft\n\nText.") =>
  message(id, "system", content, seconds, { sentToUser: true });

const TURNS = { completed: agentTurn("completed"), running: agentTurn("running") };

function timeline(messages: ChatMessage[], activities: AgentActivity[] = [], status: keyof typeof TURNS = "completed"): ResponseTimelineItem[] {
  return buildResponseTimeline({
    turns: [TURNS[status]],
    messages: [request, ...messages, ...(status === "completed" ? [answer] : [])],
    activities,
    reasonings: [],
    checkpoints: [],
  });
}

function onlyTurn(items: ResponseTimelineItem[]): ResponseTurn {
  const turns = items.filter((item) => item.kind === "turn");
  expect(items).toHaveLength(1);
  if (turns[0]?.kind !== "turn") throw new Error("Expected one authoritative turn.");
  return turns[0].turn;
}

describe("messages to the user in the response timeline model", () => {
  it("are split from system notices and claimed by their turn, never as its reply", () => {
    const notice = message("notice", "system", "Provider reconnected.", 7);
    const shown = sent("sent", 6);
    const turn = onlyTurn(timeline([shown, notice]));
    expect(turn.sentMessages).toEqual([shown]);
    expect(turn.systemMessages).toEqual([notice]);
    expect(turn.terminalAssistantMessage?.id).toBe("answer");
    expect(turn.commentaryMessages).toEqual([]);
  });

  it("ignore a flag on anything but a turn-scoped system message", () => {
    const unscoped = { ...sent("unscoped", 6), turnId: null };
    const items = timeline([unscoped, message("fake", "assistant", "Not a message to the user.", 7, { sentToUser: true })]);
    const turn = items.find((item) => item.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("Expected a turn.");
    expect(turn.turn.sentMessages).toEqual([]);
  });

  it("break the work stream at their place, after the call that showed them", () => {
    const turn = onlyTurn(timeline(
      [sent("sent", 5)],
      [tool("read", 3), tool("send", 5), tool("edit", 8)],
      "running",
    ));
    expect(buildTurnExecutionStream(turn).map((entry) => entry.kind === "activity-group"
      ? entry.activities.map(({ id }) => id).join("+")
      : entry.id)).toEqual(["read+send", "sent-message:sent", "edit"]);
  });

  it("are kept in view when a settled turn folds its work", () => {
    const turn = onlyTurn(timeline([sent("sent", 5)], [tool("send", 4)]));
    const stream = buildTurnExecutionStream(turn);
    expect(stream.filter(isSettledExchangeEntry).map(({ id }) => id)).toEqual(["sent-message:sent"]);
  });

  it("keep a turn without other work from consolidating away", () => {
    expect(isQuietSettledTurn(onlyTurn(timeline([])), false)).toBe(true);
    expect(isQuietSettledTurn(onlyTurn(timeline([sent("sent", 5)])), false)).toBe(false);
  });

  it("keep unchanged turns stable and reflect a new message", () => {
    const shown = sent("sent", 5);
    const stable = timeline([shown]);
    expect(stabilizeResponseTimeline(timeline([shown]), stable)).toBe(stable);
    expect(onlyTurn(stabilizeResponseTimeline(timeline([shown, sent("second", 6)]), stable)).sentMessages).toHaveLength(2);
  });

  it("reserve their height in the row estimate, settled and folded open alike", () => {
    const options = { availableWidth: 900 };
    const long = Array.from({ length: 30 }, (_, index) => `- Line ${index} of the draft`).join("\n");
    const [plain] = timeline([], [tool("send", 4)]);
    const [shown] = timeline([sent("sent", 5, long)], [tool("send", 4)]);
    const base = estimateTimelineRowSize(plain!, options);
    expect(estimateTimelineRowSize(shown!, options)).toBeGreaterThan(base + 300);
    expect(estimateTimelineRowSize(shown!, { ...options, turnFoldExpanded: true })).toBeGreaterThan(base + 300);
    const [running] = timeline([sent("sent", 5, long)], [tool("send", 4)], "running");
    const [runningPlain] = timeline([], [tool("send", 4)], "running");
    expect(estimateTimelineRowSize(running!, options)).toBeGreaterThan(estimateTimelineRowSize(runningPlain!, options) + 300);
  });
});
