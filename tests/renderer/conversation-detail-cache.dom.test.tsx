import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentTurnStatus,
  type AppSnapshot,
  type ConversationDetail,
  type ConversationLatestTurnSummary,
  type ConversationShell,
  type ServerEvent,
} from "../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { conversationDetailVersion, createConversationDetailCache } from "../../src/renderer/src/utils/conversationDetailCache";

const modelSelection = providerNativeModelSelection({ providerId: "codex", modelId: "default", reasoningEffort: "medium" });
const chats = ["chat-a", "chat-b", "chat-c", "chat-d"];
const olderCursor = { at: "2026-07-28T11:00:00.000Z", id: "older-turn", kind: "turn" as const };

function latestTurn(conversationId: string, status: AgentTurnStatus = "completed", updatedAt = "2026-07-28T12:00:30.000Z"): ConversationLatestTurnSummary {
  return {
    id: `${conversationId}-latest`, runId: `${conversationId}-run`, status, providerId: "codex",
    harnessId: modelSelection.harnessId, backendProfileId: modelSelection.backendProfileId, modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection), model: modelSelection.modelId,
    reasoningEffort: "medium", requestedAt: "2026-07-28T12:00:00.000Z", startedAt: "2026-07-28T12:00:01.000Z",
    completedAt: status === "completed" ? updatedAt : null, terminalReason: null, updatedAt,
  };
}

function shell(id: string, overrides: Partial<ConversationShell> = {}): ConversationShell {
  return {
    id, projectId: "project", title: id, providerId: "codex", model: "default", modelSelection,
    continuationIdentity: null, reasoningEffort: "medium", interactionMode: "build", accessMode: "supervised",
    branch: null, worktreePath: null, status: "idle", attentionKind: null, settledAt: null, archivedAt: null,
    createdAt: "2026-07-28T11:00:00.000Z", updatedAt: "2026-07-28T12:00:30.000Z", completedAt: null,
    lastViewedAt: null, providerSessionId: null, latestTurn: latestTurn(id), pendingApproval: false, pendingInput: false,
    ...overrides,
  };
}

function snapshot(activeConversationId: string, shells: Record<string, Partial<ConversationShell>> = {}): AppSnapshot {
  return {
    projects: [], providers: [], backendProfiles: [], backendDefaults: [], runs: [],
    conversations: chats.map((id) => shell(id, shells[id])),
    activeProjectId: "project", activeConversationId, settings: { ...defaultSettings },
  } as unknown as AppSnapshot;
}

function page(conversationId: string, turnIds: string[], older: typeof olderCursor | null): ConversationDetail {
  return {
    conversation: shell(conversationId),
    agentTurns: turnIds.map((id, index) => ({
      id, conversationId, runId: `${id}-run`, status: "completed",
      requestedAt: `2026-07-28T1${index}:00:00.000Z`, updatedAt: `2026-07-28T1${index}:00:00.000Z`,
    })),
    messages: turnIds.map((id, index) => ({
      id: `${id}-message`, conversationId, turnId: id, role: "user", content: id, attachments: [],
      createdAt: `2026-07-28T1${index}:00:00.000Z`,
    })),
    turnGitArtifacts: [], activities: [], subagents: [], reasonings: [], usage: [], plans: [], goals: [],
    checkpoints: [], reviewSummaries: [], reviewStates: [], reviewNotes: [],
    history: { older },
  } as unknown as ConversationDetail;
}

function result(conversationId: string, detail: ConversationDetail): ServerEvent {
  return { type: "request.result", requestId: crypto.randomUUID(),
    result: { kind: "conversation.detail", conversationId, state: "ready", detail } } as ServerEvent;
}

function harness() {
  const listeners = new Set<(event: ServerEvent) => void>();
  const pending: { command: CommandWithoutId; resolve: (event: ServerEvent) => void }[] = [];
  const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type !== "conversation.detail.load") return Promise.resolve({ type: "request.ok", requestId: "ok" } as ServerEvent);
    return new Promise((resolve) => pending.push({ command, resolve }));
  });
  const hook = renderHook(({ current, status }: { current: AppSnapshot; status: "online" | "offline" }) => useConversationProjection({
    snapshot: current, status, request,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    autoOpenPlan: false, onOpenPlan: vi.fn(), onTerminal: vi.fn(),
  }), { initialProps: { current: snapshot("chat-a"), status: "online" as "online" | "offline" } });
  const answer = async (conversationId: string, detail: ConversationDetail) => {
    const index = pending.findIndex(({ command }) => command.type === "conversation.detail.load"
      && command.payload.conversationId === conversationId);
    expect(index).toBeGreaterThanOrEqual(0);
    const [entry] = pending.splice(index, 1);
    await act(async () => entry!.resolve(result(conversationId, detail)));
  };
  const open = async (conversationId: string, shells: Record<string, Partial<ConversationShell>> = {}) => {
    hook.rerender({ current: snapshot(conversationId, shells), status: "online" });
    await act(async () => undefined);
  };
  const turnIds = () => {
    const state = hook.result.current.detailState;
    return state?.state === "ready" ? state.detail.agentTurns.map(({ id }) => id) : state?.state ?? null;
  };
  const emit = (event: ServerEvent) => act(() => { for (const listener of listeners) listener(event); });
  return { hook, pending, request, answer, open, turnIds, emit };
}

async function visitWithOlderPage(chat: ReturnType<typeof harness>, conversationId: string) {
  await chat.answer(conversationId, page(conversationId, [`${conversationId}-2`], olderCursor));
  act(() => chat.hook.result.current.history.loadOlder());
  await chat.answer(conversationId, page(conversationId, [`${conversationId}-1`], null));
  expect(chat.turnIds()).toEqual([`${conversationId}-1`, `${conversationId}-2`]);
}

afterEach(() => cleanup());

describe("conversation detail cache", () => {
  it("reopens a recent chat with its loaded older pages before the latest page returns", async () => {
    const chat = harness();
    await visitWithOlderPage(chat, "chat-a");
    await chat.open("chat-b");
    expect(chat.turnIds()).toBe("loading");
    await chat.answer("chat-b", page("chat-b", ["chat-b-1"], null));
    await chat.open("chat-a");
    expect(chat.turnIds()).toEqual(["chat-a-1", "chat-a-2"]);
    expect(chat.hook.result.current.history.hasOlder).toBe(false);
    expect(chat.pending.filter(({ command }) => command.type === "conversation.detail.load")).toHaveLength(1);
    await chat.answer("chat-a", page("chat-a", ["chat-a-2"], olderCursor));
    expect(chat.turnIds()).toEqual(["chat-a-1", "chat-a-2"]);
  });

  it("waits for the latest page when the chat changed while it was closed", async () => {
    const cases: Record<string, Partial<ConversationShell>>[] = [
      { "chat-a": { updatedAt: "2026-07-28T13:00:00.000Z", latestTurn: latestTurn("chat-a", "completed", "2026-07-28T13:00:00.000Z") } },
      { "chat-a": { latestTurn: latestTurn("chat-a", "running") } },
      { "chat-a": { archivedAt: "2026-07-28T13:00:00.000Z", updatedAt: "2026-07-28T13:00:00.000Z" } },
    ];
    for (const shells of cases) {
      const chat = harness();
      await visitWithOlderPage(chat, "chat-a");
      await chat.open("chat-b");
      await chat.answer("chat-b", page("chat-b", ["chat-b-1"], null));
      await chat.open("chat-a", shells);
      expect(chat.turnIds()).toBe("loading");
      cleanup();
    }
  });

  it("drops a chat whose detail was invalidated while it was open", async () => {
    const chat = harness();
    await visitWithOlderPage(chat, "chat-a");
    chat.emit({ type: "conversation.detail.invalidated", conversationId: "chat-a" } as ServerEvent);
    await act(async () => undefined);
    await chat.open("chat-b");
    await chat.answer("chat-b", page("chat-b", ["chat-b-1"], null));
    await chat.open("chat-a");
    expect(chat.turnIds()).toBe("loading");
  });

  it("does not paint cached content while the local service is offline", async () => {
    const chat = harness();
    await visitWithOlderPage(chat, "chat-a");
    await chat.open("chat-b");
    await chat.answer("chat-b", page("chat-b", ["chat-b-1"], null));
    chat.hook.rerender({ current: snapshot("chat-a"), status: "offline" });
    await act(async () => undefined);
    expect(chat.turnIds()).toBe("loading");
  });

  it("forgets every cached chat after the runtime reconnects", async () => {
    const chat = harness();
    await visitWithOlderPage(chat, "chat-a");
    await chat.open("chat-b");
    await chat.answer("chat-b", page("chat-b", ["chat-b-1"], null));
    chat.emit({ type: "server.welcome", snapshot: snapshot("chat-b") } as unknown as ServerEvent);
    await chat.open("chat-a");
    expect(chat.turnIds()).toBe("loading");
  });

  it("keeps only the most recent chats", async () => {
    const chat = harness();
    await visitWithOlderPage(chat, "chat-a");
    for (const id of ["chat-b", "chat-c", "chat-d"]) {
      await chat.open(id);
      await chat.answer(id, page(id, [`${id}-1`], null));
    }
    await chat.open("chat-a");
    expect(chat.turnIds()).toBe("loading");
    await chat.answer("chat-a", page("chat-a", ["chat-a-2"], olderCursor));
    await chat.open("chat-d");
    expect(chat.turnIds()).toEqual(["chat-d-1"]);
  });
});

describe("conversation detail cache entries", () => {
  it("serves an entry only for the version it was read at and evicts the least recent", () => {
    const cache = createConversationDetailCache(2);
    const version = conversationDetailVersion(shell("chat-a"));
    expect(version).not.toBeNull();
    cache.remember("chat-a", version, page("chat-a", ["a"], null));
    cache.remember("chat-b", version, page("chat-b", ["b"], null));
    expect(cache.read("chat-a", version)?.agentTurns).toHaveLength(1);
    cache.remember("chat-c", version, page("chat-c", ["c"], null));
    expect(cache.read("chat-b", version)).toBeNull();
    expect(cache.read("chat-a", "other")).toBeNull();
    expect(cache.read("chat-a", version)).toBeNull();
    expect(cache.read("chat-c", version)).not.toBeNull();
    cache.remember("chat-c", null, page("chat-c", ["c"], null));
    expect(cache.read("chat-c", version)).toBeNull();
    expect(conversationDetailVersion(shell("chat-a", { latestTurn: latestTurn("chat-a", "running") }))).toBeNull();
    expect(conversationDetailVersion(null)).toBeNull();
  });
});
