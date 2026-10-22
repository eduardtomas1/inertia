import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTurn, ChatMessage, ConversationDetail, ConversationDetailViewState, ServerEvent } from "../../src/shared/contracts";
import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { useConversationHistory } from "../../src/renderer/src/hooks/useConversationHistory";
import { useOlderHistoryNearTop } from "../../src/renderer/src/hooks/useOlderHistoryNearTop";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
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

  it("retries an interrupted older page once after the reconnected chat's detail becomes ready again", async () => {
    const dropped = deferred();
    const retried = deferred();
    const request = vi.fn().mockImplementationOnce(() => dropped.promise).mockImplementationOnce(() => retried.promise);
    const hook = renderHook(({ conversationId, online }) => {
      const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
      return { state, setState, history: useConversationHistory({ conversationId, online, detailState: state, setDetailState: setState, request }) };
    }, { initialProps: { conversationId: "chat", online: true } });
    act(() => hook.result.current.history.loadOlder());
    hook.rerender({ conversationId: "chat", online: false });
    act(() => hook.result.current.setState({ conversationId: "chat", state: "loading" }));
    hook.rerender({ conversationId: "chat", online: true });
    const loadOlder = hook.result.current.history.loadOlder;
    expect(request).toHaveBeenCalledOnce();
    act(() => hook.result.current.setState({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") }));
    expect(hook.result.current.history.loadOlder).toBe(loadOlder);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[0]).toMatchObject({ payload: { conversationId: "chat", history: { before: cursor } } });
    act(() => hook.result.current.setState({ conversationId: "chat", state: "loading" }));
    act(() => hook.result.current.setState({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") }));
    await act(async () => retried.resolve(ready("old")));
    await act(async () => dropped.resolve(ready("stale")));
    expect(loadedMessageIds(hook.result.current.state)).toEqual(["message-old", "message-recent"]);
    act(() => hook.result.current.setState({ conversationId: "chat", state: "loading" }));
    act(() => hook.result.current.setState({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retry an interrupted page when another chat's detail becomes ready", () => {
    const request = vi.fn(() => deferred().promise);
    const hook = renderHook(({ conversationId, online }) => {
      const [state, setState] = useState<ConversationDetailViewState | null>({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") });
      return { setState, history: useConversationHistory({ conversationId, online, detailState: state, setDetailState: setState, request }) };
    }, { initialProps: { conversationId: "chat", online: true } });
    act(() => hook.result.current.history.loadOlder());
    hook.rerender({ conversationId: "chat", online: false });
    act(() => hook.result.current.setState(null));
    hook.rerender({ conversationId: "other", online: true });
    act(() => hook.result.current.setState({ kind: "conversation.detail", conversationId: "other", state: "ready", detail: { ...detail("other"), conversation: { id: "other" } } as ConversationDetail }));
    hook.rerender({ conversationId: "chat", online: true });
    act(() => hook.result.current.setState({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("recent") }));
    expect(request).toHaveBeenCalledOnce();
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

function historyTurn(id: string, at: string): { turn: AgentTurn; request: ChatMessage } {
  const turn = { id, conversationId: "chat", runId: `${id}-run`, userMessageId: `${id}-request`,
    terminalAssistantMessageId: null, providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" }),
    continuationIdentity: { harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1, modelIdentity: "gpt-test", endpointIdentity: null },
    harnessId: "codex-app-server", backendProfileId: "native:codex:app-server", model: "gpt-test", modelAlias: null,
    reasoningEffort: "high", interactionMode: "build", accessMode: "supervised", providerSessionBefore: null,
    providerSessionAfter: null, requestedAt: at, startedAt: at, completedAt: at, status: "completed",
    terminalReason: "provider-completed", checkpointId: null, usageAtStart: null, usageAtCompletion: null,
    configurationRevision: 1, association: "authoritative", createdAt: at, updatedAt: at } as AgentTurn;
  const request: ChatMessage = { id: `${id}-request`, conversationId: "chat", turnId: id, role: "user",
    content: `Request ${id}`, attachments: [], createdAt: at };
  return { turn, request };
}

describe("older history prepend restoration", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("stops holding the reader's place once the latest content is requested", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const older = historyTurn("older", "2030-01-01T00:00:00.000Z");
    const recent = historyTurn("recent", "2030-01-01T00:01:00.000Z");
    const documentTops = new Map([["recent", 0]]);
    const scrollElementRef = { current: null as HTMLDivElement | null };
    const timelineElementRef = { current: null as HTMLDivElement | null };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const scrollTop = scrollElementRef.current?.scrollTop ?? 0;
      const rowId = this.dataset.responseRowId;
      const top = this === scrollElementRef.current ? 0 : rowId ? (documentTops.get(rowId) ?? 0) - scrollTop : 0;
      const height = this === scrollElementRef.current ? 600 : 200;
      return { x: 0, y: top, top, left: 0, right: 800, bottom: top + height, width: 800, height, toJSON: () => ({}) };
    });
    const timeline = (turns: { turn: AgentTurn; request: ChatMessage }[], followsLatest: boolean) => (
      <div ref={scrollElementRef}>
        <div ref={timelineElementRef}>
          <ResponseTimeline turns={turns.map(({ turn }) => turn)} messages={turns.map(({ request }) => request)}
            activities={[]} reasonings={[]} plans={[]} checkpoints={[]} projectRoot="/workspace" projectId="project"
            conversationId="chat" streamingText="" streamingReasoning="" approvals={[]} inputRequests={[]}
            showTimestamps={false} showThinking={false} defaultCodeWrap={false} autoCollapseWorkLog
            showChangedFileSummaries={false} checkpointRestoreDisabled followsLatest={followsLatest}
            scrollElementRef={scrollElementRef} timelineElementRef={timelineElementRef}
            onRespondToApproval={async () => undefined} onRespondToInput={async () => undefined}
            onRevertCheckpoint={() => undefined} onOpenTurnDiff={() => undefined}
            onCompareTurnArtifacts={() => undefined} onOpenTurnFile={() => undefined} onStop={() => undefined} />
        </div>
      </div>
    );
    const runFrames = async (): Promise<void> => {
      await act(async () => { while (frames.length > 0) frames.shift()!(performance.now()); });
    };
    const view = render(timeline([recent], false));
    await runFrames();
    const scroll = scrollElementRef.current!;
    Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 2_000 });
    scroll.scrollTop = 0;

    act(() => prepareConversationHistoryPrepend("chat"));
    documentTops.set("older", 0).set("recent", 400);
    view.rerender(timeline([older, recent], false));
    scroll.scrollTop = 1_400;
    view.rerender(timeline([older, recent], true));
    await runFrames();

    expect(scroll.scrollTop).toBe(1_400);
  });
});

type PageCursor = { at: string; id: string; kind: "turn" };
const pageCursor = (page: number): PageCursor => ({ at: `2030-01-01T00:00:${String(60 - page).padStart(2, "0")}.000Z`, id: `cursor-${page}`, kind: "turn" });

function pageDetail(conversationId: string, page: number, older: PageCursor | null): ConversationDetail {
  const at = `2030-01-01T00:00:${String(60 - page).padStart(2, "0")}.000Z`;
  return { conversation: { id: conversationId }, agentTurns: [{ id: `turn-${page}`, conversationId, requestedAt: at }],
    messages: [{ id: `message-${page}`, conversationId, turnId: `turn-${page}`, createdAt: at }],
    turnGitArtifacts: [], activities: [], subagents: [], reasonings: [], usage: [], plans: [], goals: [], checkpoints: [],
    reviewSummaries: [], reviewStates: [], reviewNotes: [], history: { older } } as unknown as ConversationDetail;
}

function pageReady(conversationId: string, page: number, older: PageCursor | null): ServerEvent {
  return { type: "request.result", requestId: "history",
    result: { kind: "conversation.detail", conversationId, state: "ready", detail: pageDetail(conversationId, page, older) } } as ServerEvent;
}

const idleCallbacks = new Map<number, IdleRequestCallback>();
let nextIdle = 1;
function runIdle() {
  const callbacks = [...idleCallbacks.values()];
  idleCallbacks.clear();
  act(() => { for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 50 }); });
}


function pagedHistory() {
  const pending: { before: string; conversationId: string; resolve: (event: ServerEvent) => void }[] = [];
  const request = vi.fn((command: CommandWithoutId) => {
    if (command.type !== "conversation.detail.load") throw new Error(`Unexpected ${command.type}.`);
    return new Promise<ServerEvent>((resolve) => pending.push({
      before: command.payload.history?.before?.id ?? "", conversationId: command.payload.conversationId, resolve }));
  });
  const hook = renderHook(({ conversationId }) => {
    const [state, setState] = useState<ConversationDetailViewState | null>(
      { kind: "conversation.detail", conversationId, state: "ready", detail: pageDetail(conversationId, 0, pageCursor(1)) });
    const current = state?.conversationId === conversationId ? state
      : { kind: "conversation.detail" as const, conversationId, state: "ready" as const, detail: pageDetail(conversationId, 0, pageCursor(1)) };
    return { state: current, setState, history: useConversationHistory({ conversationId, online: true, detailState: current, setDetailState: setState, request }) };
  }, { initialProps: { conversationId: "chat" } });
  const answer = async (page: number, older: PageCursor | null) => {
    const entry = pending.shift()!;
    expect(entry.before).toBe(`cursor-${page}`);
    await act(async () => entry.resolve(pageReady(entry.conversationId, page, older)));
  };
  const turnIds = () => hook.result.current.state.state === "ready"
    ? hook.result.current.state.detail.agentTurns.map(({ id }) => id) : [];
  return { hook, pending, request, answer, turnIds };
}

describe("older history prefetch", () => {
  beforeEach(() => {
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      const handle = nextIdle++;
      idleCallbacks.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelIdleCallback", (handle: number) => { idleCallbacks.delete(handle); });
  });
  afterEach(() => { idleCallbacks.clear(); vi.unstubAllGlobals(); });

  it("fetches the next older page at idle and shows it on request without another round trip", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, pageCursor(2));
    expect(chat.turnIds()).toEqual(["turn-1", "turn-0"]);
    expect(chat.request).toHaveBeenCalledTimes(1);
    runIdle();
    expect(chat.request).toHaveBeenCalledTimes(2);
    await chat.answer(2, pageCursor(3));
    expect(chat.turnIds()).toEqual(["turn-1", "turn-0"]);
    act(() => chat.hook.result.current.history.loadOlder());
    expect(chat.turnIds()).toEqual(["turn-2", "turn-1", "turn-0"]);
    expect(chat.hook.result.current.history.loading).toBe(false);
    expect(chat.request).toHaveBeenCalledTimes(2);
    runIdle();
    expect(chat.request).toHaveBeenCalledTimes(3);
    expect(chat.pending[0]?.before).toBe("cursor-3");
  });

  it("refetches a prefetched page that is older than a minute", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, pageCursor(2));
    runIdle();
    await chat.answer(2, pageCursor(3));
    expect(chat.request).toHaveBeenCalledTimes(2);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    act(() => chat.hook.result.current.history.loadOlder());
    expect(chat.request).toHaveBeenCalledTimes(3);
    expect(chat.pending[0]?.before).toBe("cursor-2");
    clock.mockRestore();
    chat.hook.unmount();
  });

  it("does not request the page it just applied before the timeline commits", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, pageCursor(2));
    runIdle();
    await chat.answer(2, pageCursor(3));
    expect(chat.request).toHaveBeenCalledTimes(2);
    act(() => {
      chat.hook.result.current.history.loadOlder();
      chat.hook.result.current.history.loadOlder();
    });
    expect(chat.turnIds()).toEqual(["turn-2", "turn-1", "turn-0"]);
    expect(chat.request).toHaveBeenCalledTimes(2);
    chat.hook.unmount();
  });

  it("keeps a single older request in flight and applies each page once", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, pageCursor(2));
    runIdle();
    act(() => chat.hook.result.current.history.loadOlder());
    act(() => chat.hook.result.current.history.loadOlder());
    expect(chat.request).toHaveBeenCalledTimes(2);
    expect(chat.hook.result.current.history.loading).toBe(true);
    await chat.answer(2, null);
    expect(chat.turnIds()).toEqual(["turn-2", "turn-1", "turn-0"]);
    expect(chat.hook.result.current.history.loading).toBe(false);
    expect(chat.hook.result.current.history.hasOlder).toBe(false);
    runIdle();
    act(() => chat.hook.result.current.history.loadOlder());
    expect(chat.request).toHaveBeenCalledTimes(2);
  });

  it("cancels a scheduled or in-flight prefetch when the chat changes", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, pageCursor(2));
    chat.hook.rerender({ conversationId: "other" });
    runIdle();
    expect(chat.request).toHaveBeenCalledTimes(1);
    chat.hook.rerender({ conversationId: "chat" });
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(2, pageCursor(3));
    runIdle();
    expect(chat.request).toHaveBeenCalledTimes(3);
    chat.hook.rerender({ conversationId: "other" });
    await chat.answer(3, null);
    expect(chat.hook.result.current.history.loading).toBe(false);
    act(() => chat.hook.result.current.history.loadOlder());
    expect(chat.request).toHaveBeenCalledTimes(4);
    expect(chat.pending[0]).toMatchObject({ conversationId: "other", before: "cursor-1" });
  });

  it("drops a prefetched page whose cursor no longer matches the loaded history", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, pageCursor(2));
    runIdle();
    await chat.answer(2, pageCursor(3));
    act(() => chat.hook.result.current.setState({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: pageDetail("chat", 0, pageCursor(1)) }));
    act(() => chat.hook.result.current.history.loadOlder());
    expect(chat.turnIds()).toEqual(["turn-0"]);
    expect(chat.request).toHaveBeenCalledTimes(3);
    expect(chat.pending[0]?.before).toBe("cursor-1");
  });
});

function NearTop({ history }: { history: Parameters<typeof useOlderHistoryNearTop>[1] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useOlderHistoryNearTop(scrollRef, history);
  return <div ref={scrollRef} data-testid="scroll" />;
}

describe("older history near the top", () => {
  function scrollTo(element: HTMLElement, top: number) {
    element.scrollTop = top;
    fireEvent.scroll(element);
  }
  function scene(loading = false, hasOlder = true, online = true, error: string | null = null) {
    const loadOlder = vi.fn();
    const view = render(<NearTop history={{ hasOlder, loading, error, online, loadOlder }} />);
    const element = view.getByTestId("scroll");
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 6_000 });
    return { view, element, loadOlder };
  }

  it("asks for older messages when the reader scrolls up within one viewport of the top", () => {
    const { element, loadOlder } = scene();
    scrollTo(element, 3_000);
    scrollTo(element, 1_200);
    expect(loadOlder).not.toHaveBeenCalled();
    scrollTo(element, 500);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    scrollTo(element, 550);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while a page is loading, offline, failed, or when nothing older exists", () => {
    for (const [loading, hasOlder, online, error] of [[true, true, true, null], [false, false, true, null], [false, true, false, null], [false, true, true, "Earlier messages could not be loaded."]] as const) {
      const { element, loadOlder, view } = scene(loading, hasOlder, online, error);
      scrollTo(element, 900);
      scrollTo(element, 100);
      expect(loadOlder).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});
