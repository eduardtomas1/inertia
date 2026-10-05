import { describe, expect, it } from "vitest";

import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import { buildResponseTimeline } from "../../src/renderer/src/utils/responseTimeline";

const conversationId = "conversation-cli-import";
const minute = (index: number): string => new Date(Date.UTC(2026, 8, 25, 10, index)).toISOString();

function importedExchange(index: number): { turn: AgentTurn; messages: ChatMessage[] } {
  const turnId = `imported-turn-${index}`;
  const user: ChatMessage = { id: `imported-user-${index}`, conversationId, turnId, role: "user", content: `Imported request ${index}`, attachments: [], createdAt: minute(index * 2) };
  const reply: ChatMessage = { id: `imported-reply-${index}`, conversationId, turnId, role: "assistant", content: `Imported reply ${index}`, attachments: [], createdAt: minute(index * 2 + 1) };
  const turn: AgentTurn = {
    id: turnId,
    conversationId,
    runId: `imported-run-${index}`,
    userMessageId: user.id,
    terminalAssistantMessageId: reply.id,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      modelId: "gpt-5.6",
      alias: "latest",
      reasoningEffort: "medium",
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
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: user.createdAt,
    startedAt: user.createdAt,
    completedAt: reply.createdAt,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    origin: "cli-import",
    createdAt: user.createdAt,
    updatedAt: reply.createdAt,
  };
  return { turn, messages: [user, reply] };
}

describe("imported CLI history in the response timeline", () => {
  it("projects every imported exchange as an ordinary turn with no compatibility history", () => {
    const exchanges = Array.from({ length: 8 }, (_, index) => importedExchange(index));
    const items = buildResponseTimeline({
      turns: exchanges.map(({ turn }) => turn),
      messages: exchanges.flatMap(({ messages }) => messages),
      activities: [],
      reasonings: [],
      checkpoints: [],
    });
    expect(items.some(({ kind }) => kind === "compatibility")).toBe(false);
    expect(items.map((item) => item.kind === "turn" ? [item.turn.userMessage.content, item.turn.terminalAssistantMessage?.content] : item.kind))
      .toEqual(exchanges.map((_, index) => [`Imported request ${index}`, `Imported reply ${index}`]));
  });
});
