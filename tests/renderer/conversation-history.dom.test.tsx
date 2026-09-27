import { useState } from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTurn, ChatMessage, ConversationDetail, ConversationDetailViewState, ServerEvent } from "../../src/shared/contracts";
import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { useConversationHistory } from "../../src/renderer/src/hooks/useConversationHistory";
import { clearMessageSearchFocus, requestMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";
import { clearTimelineFocus, requestTimelineFocus } from "../../src/renderer/src/utils/timelineFocus";
import { useMessageSearchFocus } from "../../src/renderer/src/components/response-timeline/useMessageSearchFocus";
import { prepareConversationHistoryPrepend } from "../../src/renderer/src/utils/conversationHistoryNavigation";
import type { ResponseTimelineItem } from "../../src/renderer/src/utils/responseTimeline";

const cursor = { at: "2030-01-01T00:00:00.000Z", id: "older", kind: "turn" as const };
function detail(id: string): ConversationDetail {
  return { conversation: { id: "chat" }, agentTurns: [{ id, conversationId: "chat", requestedAt: cursor.at }],
    messages: [{ id: `message-${id}`, conversationId: "chat", turnId: id, createdAt: cursor.at }],
    turnGitArtifacts: [], activities: [], subagents: [], reasonings: [], usage: [], plans: [], goals: [], checkpoints: [],
    reviewSummaries: [], reviewStates: [], reviewNotes: [], history: { older: cursor } } as unknown as ConversationDetail;
}
function ready(id: string): ServerEvent {
  return { type: "request.result", requestId: "history", result: { kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail(id) } };
}
function deferred() {
  let resolve!: (event: ServerEvent) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ServerEvent>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
}
function connectedHistory(request: (command: unknown) => Promise<ServerEvent>) {
  return renderHook(({ conversationId, online }) => {
    const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
    return { state, history: useConversationHistory({ conversationId, online, detailState: state, setDetailState: setState, request }) };
  }, { initialProps: { conversationId: "chat", online: true } });
}
function loadedMessageIds(state: ConversationDetailViewState | null) {
  return state?.state === "ready" ? state.detail.messages.map(({ id }) => id) : [];
}
afterEach(() => { cleanup(); clearMessageSearchFocus(); clearTimelineFocus(); });

describe("history navigation lifecycle", () => {
  it("captures a prepend before update and restores only after the new timeline commits", () => {
    const initial: ResponseTimelineItem[] = [];
    const next = [{}] as ResponseTimelineItem[];
    const capture = vi.fn();
    const restore = vi.fn();
    const reading = vi.fn();
    const hook = renderHook(({ timeline }) => useMessageSearchFocus(
      { conversationId: "chat", projectId: "project", messages: [] },
      timeline, reading, vi.fn(), capture, restore,
    ), { initialProps: { timeline: initial } });
    act(() => prepareConversationHistoryPrepend("another-chat"));
    expect(capture).not.toHaveBeenCalled();
    act(() => prepareConversationHistoryPrepend("chat"));
    expect(capture).toHaveBeenCalledOnce();
    expect(reading).toHaveBeenCalledOnce();
    hook.rerender({ timeline: initial });
    expect(restore).not.toHaveBeenCalled();
    hook.rerender({ timeline: next });
    expect(restore).toHaveBeenCalledOnce();
    hook.rerender({ timeline: next });
    expect(restore).toHaveBeenCalledOnce();
  });
  it("ignores an old page after switching chats and maintains stable control identity", async () => {
    const response = deferred();
    const request = vi.fn(() => response.promise);
    const hook = renderHook(({ conversationId }) => {
      const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
      return { state, history: useConversationHistory({ conversationId, online: true, detailState: state, setDetailState: setState, request }) };
    }, { initialProps: { conversationId: "chat" } });
    const controls = hook.result.current.history;
    hook.rerender({ conversationId: "chat" });
    expect(hook.result.current.history).toBe(controls);
    act(() => hook.result.current.history.loadOlder());
    expect(request).toHaveBeenCalledOnce();
    hook.rerender({ conversationId: "other" });
    await act(async () => response.resolve(ready("old")));
    expect(hook.result.current.state?.state === "ready" && hook.result.current.state.detail.messages).toHaveLength(1);
    expect(hook.result.current.history.loading).toBe(false);
  });

  it("loads the latest search target after an in-flight older page completes", async () => {
    const response = deferred();
    const request = vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValue(ready("target"));
    const hook = renderHook(() => {
      const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
      return useConversationHistory({ conversationId: "chat", online: true, detailState: state, setDetailState: setState, request });
    });
    act(() => hook.result.current.loadOlder());
    act(() => requestMessageSearchFocus({ conversationId: "chat", projectId: "project", turnId: "target", messageId: "message-target" }));
    expect(request).toHaveBeenCalledOnce();
    await act(async () => response.resolve(ready("old")));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0]).toMatchObject({ payload: { history: { messageId: "message-target" } } });
  });

  it("retains a timeline jump until its requested page is mounted", async () => {
    const request = vi.fn().mockResolvedValue(ready("target"));
    const focus = vi.fn();
    const reading = vi.fn();
    renderHook(() => {
      const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
      useConversationHistory({ conversationId: "chat", online: true, detailState: state, setDetailState: setState, request });
      const loaded = state?.state === "ready" ? state.detail : detail("recent");
      const timeline = loaded.agentTurns.map((turn) => ({ kind: "turn", turn })) as unknown as ResponseTimelineItem[];
      useMessageSearchFocus({ conversationId: "chat", projectId: "project", messages: loaded.messages }, timeline, reading, focus);
    });
    act(() => requestTimelineFocus({ conversationId: "chat", turnId: "target" }));
    await waitFor(() => expect(focus).toHaveBeenCalledWith(1, "turn"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("reports a missing search result without a retry loop and permits explicit retry", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Deleted message"));
    const hook = renderHook(() => {
      const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
      return useConversationHistory({ conversationId: "chat", online: true, detailState: state, setDetailState: setState, request });
    });
    act(() => requestMessageSearchFocus({ conversationId: "chat", projectId: "project", turnId: null, messageId: "missing" }));
    await waitFor(() => expect(hook.result.current.error).toBe("Deleted message"));
    hook.rerender();
    expect(request).toHaveBeenCalledOnce();
    act(() => requestMessageSearchFocus({ conversationId: "chat", projectId: "project", turnId: null, messageId: "missing" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it("exposes omitted turns and does not reload a target that stays omitted", async () => {
    const omittedPage = { ...detail("target"), messages: [], history: { older: cursor, omittedTurnIds: ["target"] } };
    const request = vi.fn().mockResolvedValue({ type: "request.result", requestId: "history",
      result: { kind: "conversation.detail", conversationId: "chat", state: "ready", detail: omittedPage } });
    const hook = renderHook(() => {
      const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
      return useConversationHistory({ conversationId: "chat", online: true, detailState: state, setDetailState: setState, request });
    });
    act(() => requestMessageSearchFocus({ conversationId: "chat", projectId: "project", turnId: "target", messageId: "answer-in-target" }));
    await waitFor(() => expect(hook.result.current.omittedTurnIds).toEqual(["target"]));
    hook.rerender();
    await act(async () => undefined);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("history loads interrupted by the connection", () => {
  it("retries an older page once when the connection returns before the dropped request settles", async () => {
    const dropped = deferred();
    const request = vi.fn().mockImplementationOnce(() => dropped.promise).mockResolvedValue(ready("old"));
    const hook = connectedHistory(request);
    act(() => hook.result.current.history.loadOlder());
    expect(hook.result.current.history.loading).toBe(true);
    hook.rerender({ conversationId: "chat", online: false });
    expect(hook.result.current.history.loading).toBe(false);
    expect(request).toHaveBeenCalledOnce();
    hook.rerender({ conversationId: "chat", online: true });
    await waitFor(() => expect(loadedMessageIds(hook.result.current.state)).toEqual(["message-old", "message-recent"]));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ payload: { conversationId: "chat", history: { before: cursor } } });
    await act(async () => dropped.resolve(ready("stale")));
    hook.rerender({ conversationId: "chat", online: true });
    expect(loadedMessageIds(hook.result.current.state)).toEqual(["message-old", "message-recent"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(hook.result.current.history).toMatchObject({ loading: false, error: null });
  });

  it("retries an older page once when the disconnect rejects the request before the status changes", async () => {
    const dropped = deferred();
    const request = vi.fn().mockImplementationOnce(() => dropped.promise).mockResolvedValue(ready("old"));
    const hook = connectedHistory(request);
    act(() => hook.result.current.history.loadOlder());
    await act(async () => dropped.reject(new Error("The local service disconnected before finishing the request.")));
    hook.rerender({ conversationId: "chat", online: false });
    expect(request).toHaveBeenCalledOnce();
    hook.rerender({ conversationId: "chat", online: true });
    await waitFor(() => expect(loadedMessageIds(hook.result.current.state)).toEqual(["message-old", "message-recent"]));
    hook.rerender({ conversationId: "chat", online: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect(hook.result.current.history).toMatchObject({ loading: false, error: null });
  });

  it("does not carry an interrupted page into another chat or back after leaving it", async () => {
    const dropped = deferred();
    const request = vi.fn().mockImplementationOnce(() => dropped.promise).mockResolvedValue(ready("old"));
    const hook = connectedHistory(request);
    act(() => hook.result.current.history.loadOlder());
    hook.rerender({ conversationId: "chat", online: false });
    hook.rerender({ conversationId: "other", online: false });
    hook.rerender({ conversationId: "other", online: true });
    hook.rerender({ conversationId: "chat", online: true });
    await act(async () => dropped.resolve(ready("stale")));
    expect(request).toHaveBeenCalledOnce();
    expect(loadedMessageIds(hook.result.current.state)).toEqual(["message-recent"]);
    expect(hook.result.current.history.loading).toBe(false);
  });

  it("reports whether history can be requested and ignores older loads while offline", () => {
    const request = vi.fn().mockResolvedValue(ready("old"));
    const hook = connectedHistory(request);
    hook.rerender({ conversationId: "chat", online: false });
    expect(hook.result.current.history.online).toBe(false);
    act(() => hook.result.current.history.loadOlder());
    expect(request).not.toHaveBeenCalled();
    hook.rerender({ conversationId: "chat", online: true });
    expect(hook.result.current.history.online).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("omitted history turns", () => {
  it("keeps the request readable and explains why the turn body is not shown", () => {
    const at = "2030-01-01T00:00:00.000Z";
    const turn = { id: "large-turn", conversationId: "chat", runId: "large-run", userMessageId: "large-request",
      terminalAssistantMessageId: "large-answer", providerId: "codex",
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }),
      continuationIdentity: { harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
        backendConfigurationRevision: 1, modelIdentity: "gpt-test", endpointIdentity: null },
      harnessId: "codex-app-server", backendProfileId: "native:codex:app-server", model: "gpt-test", modelAlias: null,
      reasoningEffort: "high", interactionMode: "build", accessMode: "supervised", providerSessionBefore: null,
      providerSessionAfter: null, requestedAt: at, startedAt: at, completedAt: at, status: "completed",
      terminalReason: "provider-completed", checkpointId: null, usageAtStart: null, usageAtCompletion: null,
      configurationRevision: 1, association: "authoritative", createdAt: at, updatedAt: at } as AgentTurn;
    const request: ChatMessage = { id: "large-request", conversationId: "chat", turnId: "large-turn", role: "user",
      content: "Summarize the huge log", attachments: [], createdAt: at };
    render(<ResponseTimeline turns={[turn]} messages={[request]} activities={[]} reasonings={[]} plans={[]}
      checkpoints={[]} projectRoot="/workspace" projectId="project" conversationId="chat" streamingText=""
      streamingReasoning="" approvals={[]} inputRequests={[]} showTimestamps={false} showThinking={false}
      defaultCodeWrap={false} autoCollapseWorkLog showChangedFileSummaries={false} checkpointRestoreDisabled
      omittedTurnIds={["large-turn"]} onRespondToApproval={async () => undefined}
      onRespondToInput={async () => undefined} onRevertCheckpoint={() => undefined} onOpenTurnDiff={() => undefined}
      onCompareTurnArtifacts={() => undefined} onOpenTurnFile={() => undefined} onStop={() => undefined} />);
    const section = screen.getByRole("region", { name: "Turn 1" });
    expect(section).toHaveTextContent("Summarize the huge log");
    expect(screen.getByRole("note")).toHaveTextContent("This turn is too large to display. Your history is saved.");
    expect(screen.queryByRole("article", { name: "Final assistant answer" })).toBeNull();
  });
});
