import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationDetailViewState, ServerEvent } from "../../src/shared/contracts";
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
  const promise = new Promise<ServerEvent>((done) => { resolve = done; });
  return { resolve, promise };
}
afterEach(() => { clearMessageSearchFocus(); clearTimelineFocus(); });

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
});
