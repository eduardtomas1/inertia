import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, clientCommandSchema, type AppSnapshot, type ChatMessage, type ConversationDetail, type ConversationShell, type ServerEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import { MAX_HISTORY_NAVIGATION_SELECTIONS, useConversationHistoryNavigation } from "../../src/renderer/src/hooks/useConversationHistoryNavigation";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { clearMessageSearchFocus, requestMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";

const primaryId = "11111111-1111-4111-8111-111111111111";
const secondaryId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-09-01T00:00:00.000Z";
const shell = (id: string): ConversationShell => ({
  id, projectId, title: "History", providerId: "codex", model: "gpt", reasoningEffort: "high",
  modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt", reasoningEffort: "high" }),
  continuationIdentity: null, interactionMode: "build", accessMode: "supervised", status: "idle", attentionKind: null,
  branch: null, worktreePath: null, providerSessionId: null, archivedAt: null, settledAt: null, completedAt: null, lastViewedAt: null,
  createdAt: timestamp, updatedAt: timestamp, latestTurn: null, pendingApproval: false, pendingInput: false,
});
const snapshot: AppSnapshot = { projects: [], conversations: [shell(primaryId), shell(secondaryId)], providers: [], backendProfiles: [], backendDefaults: [], runs: [], activeProjectId: projectId, activeConversationId: primaryId, settings: { ...defaultSettings } };
const message = (id: string, conversationId = primaryId): ChatMessage => ({ id, conversationId, turnId: null, role: "assistant", content: id, attachments: [], createdAt: timestamp });
const detail = (conversationId: string, messages: ChatMessage[], older: string | null = "older", newer: string | null = null): ConversationDetail => ({
  conversation: shell(conversationId), messages, agentTurns: [], turnGitArtifacts: [], activities: [], subagents: [], reasonings: [], usage: [], plans: [], goals: [], checkpoints: [], reviewSummaries: [], reviewStates: [], reviewNotes: [],
  history: { olderCursor: older, newerCursor: newer, recordCount: messages.length },
});
const response = (value: ConversationDetail): ServerEvent => ({ type: "request.result", requestId: crypto.randomUUID(), result: { kind: "conversation.detail", conversationId: value.conversation.id, state: "ready", detail: value } });
type DetailCommand = Extract<CommandWithoutId, { type: "conversation.detail.load" }>;
function setup(load: (command: DetailCommand) => ServerEvent | Promise<ServerEvent>, target: string | undefined = undefined) {
  const listeners = new Set<(event: ServerEvent) => void>();
  const subscribe = (listener: (event: ServerEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "conversation.detail.load") {
      expect(clientCommandSchema.safeParse({ ...command, requestId: crypto.randomUUID() }).success).toBe(true);
      return await load(command);
    }
    return { type: "request.ok", requestId: crypto.randomUUID() };
  });
  const hook = renderHook(({ targetConversationId }: { targetConversationId: string | undefined }) => useConversationProjection({ snapshot, status: "online", request, subscribe, targetConversationId, autoOpenPlan: false, onOpenPlan: vi.fn(), onTerminal: vi.fn() }), { initialProps: { targetConversationId: target } });
  return { hook, request, emit: (event: ServerEvent) => act(() => { for (const listener of listeners) listener(event); }) };
}
afterEach(clearMessageSearchFocus);

describe("bounded history projection navigation", () => {
  it("restores each chat's older-page selection after navigating both chats", async () => {
    const { hook, request } = setup((command) => {
      const id = command.payload.conversationId;
      return response(detail(id, [message(command.payload.cursor ? `${id}-older` : `${id}-latest`, id)], `${id}-cursor`, command.payload.cursor ? "newer" : null));
    }, primaryId);
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${primaryId}-latest`));
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${primaryId}-older`));
    hook.rerender({ targetConversationId: secondaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${secondaryId}-latest`));
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${secondaryId}-older`));
    hook.rerender({ targetConversationId: primaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${primaryId}-older`));
    expect(hook.result.current.viewingHistory).toBe(true);
    expect(request.mock.calls.filter(([command]) => command.type === "conversation.detail.load").at(-1)?.[0]).toEqual({ type: "conversation.detail.load", payload: { conversationId: primaryId, cursor: `${primaryId}-cursor` } });
    act(() => hook.result.current.loadLatestHistory());
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${primaryId}-latest`));
    const before = request.mock.calls.length;
    act(() => hook.result.current.loadLatestHistory());
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(before));
    hook.rerender({ targetConversationId: secondaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${secondaryId}-older`));
  });

  it("prioritizes a new search anchor over remembered history without undoing Latest", async () => {
    const { hook } = setup((command) => {
      const id = command.payload.conversationId;
      return response(detail(id, [message(command.payload.anchorMessageId ?? (command.payload.cursor ? "older" : "latest"), id)]));
    }, primaryId);
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe("latest"));
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe("older"));
    hook.rerender({ targetConversationId: secondaryId });
    await waitFor(() => expect(hook.result.current.conversation?.id).toBe(secondaryId));
    act(() => requestMessageSearchFocus({ projectId, conversationId: primaryId, turnId: null, messageId: "search-anchor" }));
    hook.rerender({ targetConversationId: primaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe("search-anchor"));
    act(clearMessageSearchFocus);
    hook.rerender({ targetConversationId: secondaryId });
    await waitFor(() => expect(hook.result.current.conversation?.id).toBe(secondaryId));
    hook.rerender({ targetConversationId: primaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe("search-anchor"));
    act(() => hook.result.current.loadLatestHistory());
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe("latest"));
    expect(hook.result.current.viewingHistory).toBe(false);
  });

  it("invalidates inactive chats' remembered cursors when the runtime restarts", async () => {
    let restarted = false;
    const { hook, emit, request } = setup((command) => {
      const id = command.payload.conversationId;
      if (restarted && command.payload.cursor) return {
        type: "request.result", requestId: crypto.randomUUID(),
        result: { kind: "conversation.detail", conversationId: id, state: "failed", message: "This history cursor has expired." },
      };
      return response(detail(id, [message(command.payload.cursor ? `${id}-older` : `${id}-latest`, id)], `${id}-cursor`));
    }, primaryId);
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${primaryId}-latest`));
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${primaryId}-older`));
    hook.rerender({ targetConversationId: secondaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${secondaryId}-latest`));
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${secondaryId}-older`));
    restarted = true;
    emit({ type: "server.welcome", protocolVersion: 1, snapshot, sync: { runtimeGeneration: "replacement-runtime", latestSequence: 0 } });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${secondaryId}-latest`));
    hook.rerender({ targetConversationId: primaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(`${primaryId}-latest`));
    expect(hook.result.current.detailState?.state).toBe("ready");
    expect(hook.result.current.historyError).toBeNull();
    expect(request.mock.calls.filter(([command]) => command.type === "conversation.detail.load").at(-1)?.[0]).toEqual({ type: "conversation.detail.load", payload: { conversationId: primaryId } });
  });

  it("bounds remembered navigation metadata and evicts the least recently selected chat", () => {
    const request = vi.fn(async (): Promise<ServerEvent> => ({ type: "request.ok", requestId: crypto.randomUUID() }));
    const hook = renderHook(({ id }) => useConversationHistoryNavigation(id, detail(id, [], `${id}-older`), request), { initialProps: { id: primaryId } });
    act(() => hook.result.current.loadOlderHistory());
    for (let index = 0; index < MAX_HISTORY_NAVIGATION_SELECTIONS; index += 1) {
      hook.rerender({ id: `chat-${index}` });
      act(() => hook.result.current.loadOlderHistory());
    }
    hook.rerender({ id: primaryId });
    expect(hook.result.current.historyRequest).toEqual({});
    expect(hook.result.current.historyRevision).toBe(0);
    hook.rerender({ id: `chat-${MAX_HISTORY_NAVIGATION_SELECTIONS - 1}` });
    expect(hook.result.current.historyRequest).toEqual({ cursor: `chat-${MAX_HISTORY_NAVIGATION_SELECTIONS - 1}-older` });
    expect(request).not.toHaveBeenCalled();
  });

  it("replaces the live view with older history and resumes only after Latest", async () => {
    let latest = [message("latest")];
    const { hook, emit } = setup((command) => response(command.payload.cursor
      ? detail(primaryId, [message("older")], null, "newer") : detail(primaryId, latest)));
    await waitFor(() => expect(hook.result.current.messages).toEqual(expect.arrayContaining(latest)));
    emit({ type: "agent.text", conversationId: primaryId, runId: "run", turnId: "turn", text: "Live" });
    expect(hook.result.current.streaming.getSnapshot()[0]).toBe("Live");
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.messages.map((entry) => entry.id)).toEqual(["older"]));
    expect(hook.result.current.viewingHistory).toBe(true);
    expect(hook.result.current.streaming.getSnapshot()[0]).toBe("");
    emit({ type: "conversation.message.persisted", message: message("arrived-while-older") });
    emit({ type: "agent.text", conversationId: primaryId, runId: "run", turnId: "turn", text: "Ignored" });
    expect(hook.result.current.messages.map((entry) => entry.id)).toEqual(["older"]);
    expect(hook.result.current.streaming.getSnapshot()[0]).toBe("");
    latest = [message("latest"), message("arrived-while-older")];
    act(() => hook.result.current.loadLatestHistory());
    await waitFor(() => expect(hook.result.current.messages).toEqual(expect.arrayContaining(latest)));
    expect(hook.result.current.viewingHistory).toBe(false);
    emit({ type: "conversation.message.persisted", message: message("new-live") });
    expect(hook.result.current.messages.map((entry) => entry.id)).toContain("new-live");
  });

  it("loads a legacy non-UUID search anchor directly in a detached pane", async () => {
    const target = { projectId, conversationId: secondaryId, turnId: null, messageId: "imported-message-42" };
    requestMessageSearchFocus(target);
    const { hook, request } = setup((command) => response(detail(command.payload.conversationId, [message(command.payload.anchorMessageId ?? "latest", command.payload.conversationId)], null, "newer")), secondaryId);
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(target.messageId));
    expect(request.mock.calls.filter(([command]) => command.type === "conversation.detail.load").map(([command]) => command)).toEqual([{ type: "conversation.detail.load", payload: { conversationId: secondaryId, anchorMessageId: target.messageId } }]);
    act(() => requestMessageSearchFocus({ ...target, messageId: "another-old-message" }));
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe("another-old-message"));
  });

  it("does not admit an older-page response after switching conversations", async () => {
    let resolveOlder: ((event: ServerEvent) => void) | undefined;
    const { hook } = setup((command) => command.payload.cursor
      ? new Promise((resolve) => { resolveOlder = resolve; })
      : response(detail(command.payload.conversationId, [message(command.payload.conversationId, command.payload.conversationId)])), primaryId);
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(primaryId));
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(resolveOlder).toBeDefined());
    hook.rerender({ targetConversationId: secondaryId });
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe(secondaryId));
    await act(async () => { resolveOlder!(response(detail(primaryId, [message("stale-old")], null, "newer"))); });
    expect(hook.result.current.messages[0]?.id).toBe(secondaryId);
    expect(hook.result.current.historyLoading).toBe(false);
  });

  it("keeps an expired cursor recoverable and reconnects on the latest page", async () => {
    const { hook, emit, request } = setup((command) => command.payload.cursor ? {
      type: "request.result", requestId: crypto.randomUUID(), result: { kind: "conversation.detail", conversationId: primaryId, state: "failed", message: "This history cursor has expired." },
    } : response(detail(primaryId, [message("latest")])));
    await waitFor(() => expect(hook.result.current.messages[0]?.id).toBe("latest"));
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.historyError).toMatch(/expired/));
    expect(hook.result.current.historyLoading).toBe(false);
    expect(hook.result.current.detail).not.toBeNull();
    act(() => hook.result.current.loadLatestHistory());
    await waitFor(() => expect(hook.result.current.historyError).toBeNull());
    act(() => hook.result.current.loadOlderHistory());
    await waitFor(() => expect(hook.result.current.historyError).toMatch(/expired/));
    emit({ type: "server.welcome", protocolVersion: 1, snapshot, sync: { runtimeGeneration: "new-runtime", latestSequence: 0 } });
    await waitFor(() => expect(hook.result.current.viewingHistory).toBe(false));
    await waitFor(() => expect(hook.result.current.historyLoading).toBe(false));
    expect(hook.result.current.historyError).toBeNull();
    expect(request.mock.calls.filter(([command]) => command.type === "conversation.detail.load").at(-1)?.[0]).toEqual({ type: "conversation.detail.load", payload: { conversationId: primaryId } });
  });
});
