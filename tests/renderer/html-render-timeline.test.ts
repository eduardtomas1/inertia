import { describe, expect, it } from "vitest";

import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import {
  buildResponseTimeline,
  estimateTimelineRowSize,
  shouldConsolidateSettledWorkIntoRunDetails,
  stabilizeResponseTimeline,
  type ResponseTimelineItem,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";
import { htmlRenderUrl } from "../../src/renderer/src/utils/htmlRenderUrl";

const conversationId = "14141414-1414-4141-8141-141414141414";
const turnId = "turn-render-model";
const renderId = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

function at(seconds: number): string {
  return `2030-04-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function settledTurn(): AgentTurn {
  return {
    id: turnId,
    conversationId,
    runId: "run-render-model",
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
    requestedAt: at(0),
    startedAt: at(1),
    completedAt: at(9),
    status: "completed",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(0),
    updatedAt: at(9),
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  seconds: number,
  update: Partial<ChatMessage> = {},
): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt: at(seconds), ...update };
}

function render(id: string, seconds: number, height = 360, title = "Latency chart"): ChatMessage {
  return message(id, "system", `Rendered page: ${title}`, seconds, {
    htmlRender: { renderId, title, height },
  });
}

const request = message("request", "user", "Plot request latency.", 0);
const answer = message("answer", "assistant", "p99 doubled after the deploy.", 8);
const agentTurn = settledTurn();

function timeline(messages: ChatMessage[]): ResponseTimelineItem[] {
  return buildResponseTimeline({
    turns: [agentTurn],
    messages: [request, ...messages, answer],
    activities: [],
    reasonings: [],
    checkpoints: [],
  });
}

function onlyTurn(items: ResponseTimelineItem[]): ResponseTurn {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item?.kind !== "turn") throw new Error("Expected one authoritative turn.");
  return item.turn;
}

describe("visual replies in the response timeline model", () => {
  it("splits renders from system notices so clean work still consolidates", () => {
    const second = render("render-2", 6, 480, "Error budget");
    const first = render("render-1", 5);
    const turn = onlyTurn(timeline([second, first]));

    expect(turn.htmlRenders).toEqual([first, second]);
    expect(turn.systemMessages).toEqual([]);
    expect(shouldConsolidateSettledWorkIntoRunDetails(turn)).toBe(true);
  });

  it("keeps plain and malformed system messages as notices and never quarantines renders", () => {
    const notice = message("notice", "system", "Provider session restarted.", 4);
    const malformed = message("malformed", "system", "Rendered page: Broken", 5, {
      htmlRender: { renderId: "not-a-uuid", title: "Broken", height: 360 },
    });
    const valid = render("render", 6);
    const items = timeline([notice, malformed, valid]);
    const turn = onlyTurn(items);

    expect(turn.systemMessages).toEqual([notice, malformed]);
    expect(turn.htmlRenders).toEqual([valid]);
    expect(shouldConsolidateSettledWorkIntoRunDetails(turn)).toBe(false);
    expect(items.some(({ kind }) => kind === "compatibility")).toBe(false);
  });

  it("treats a changed render as a turn change and an identical one as stable", () => {
    const original = render("render", 5);
    const first = stabilizeResponseTimeline(timeline([original]), []);

    expect(stabilizeResponseTimeline(timeline([original]), first)).toBe(first);

    const resized = render("render", 5, 720);
    const changed = stabilizeResponseTimeline(timeline([resized]), first);
    expect(changed).not.toBe(first);
    expect(onlyTurn(changed).htmlRenders).toEqual([resized]);

    const added = stabilizeResponseTimeline(timeline([original, render("render-2", 6)]), first);
    expect(onlyTurn(added)).not.toBe(onlyTurn(first));
  });

  it("reserves each frame's height in the row estimate", () => {
    const [plain] = timeline([]);
    const [one] = timeline([render("render", 5, 400)]);
    const [two] = timeline([render("render", 5, 400), render("render-2", 6, 600)]);
    const options = { availableWidth: 900 };

    const base = estimateTimelineRowSize(plain!, options);
    expect(estimateTimelineRowSize(one!, options)).toBeGreaterThanOrEqual(base + 400);
    expect(estimateTimelineRowSize(two!, options)).toBeGreaterThanOrEqual(base + 1_000);
  });

  it("serves the page from the privileged render route of the running build", () => {
    expect(htmlRenderUrl(renderId)).toBe(`inertia://render/${renderId}`);
  });
});
