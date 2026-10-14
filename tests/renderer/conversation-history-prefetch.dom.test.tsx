import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationDetailViewState, ServerEvent } from "../../src/shared/contracts";
import { useConversationHistory } from "../../src/renderer/src/hooks/useConversationHistory";
import { useOlderHistoryNearTop } from "../../src/renderer/src/hooks/useOlderHistoryNearTop";

type Cursor = { at: string; id: string; kind: "turn" };
const cursor = (page: number): Cursor => ({ at: `2030-01-01T00:00:${String(60 - page).padStart(2, "0")}.000Z`, id: `cursor-${page}`, kind: "turn" });

function detail(conversationId: string, page: number, older: Cursor | null): ConversationDetail {
  const at = `2030-01-01T00:00:${String(60 - page).padStart(2, "0")}.000Z`;
  return { conversation: { id: conversationId }, agentTurns: [{ id: `turn-${page}`, conversationId, requestedAt: at }],
    messages: [{ id: `message-${page}`, conversationId, turnId: `turn-${page}`, createdAt: at }],
    turnGitArtifacts: [], activities: [], subagents: [], reasonings: [], usage: [], plans: [], goals: [], checkpoints: [],
    reviewSummaries: [], reviewStates: [], reviewNotes: [], history: { older } } as unknown as ConversationDetail;
}

function ready(conversationId: string, page: number, older: Cursor | null): ServerEvent {
  return { type: "request.result", requestId: "history",
    result: { kind: "conversation.detail", conversationId, state: "ready", detail: detail(conversationId, page, older) } } as ServerEvent;
}

const idleCallbacks = new Map<number, IdleRequestCallback>();
let nextIdle = 1;
function runIdle() {
  const callbacks = [...idleCallbacks.values()];
  idleCallbacks.clear();
  act(() => { for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 50 }); });
}

beforeEach(() => {
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    const handle = nextIdle++;
    idleCallbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => { idleCallbacks.delete(handle); });
});
afterEach(() => { cleanup(); idleCallbacks.clear(); vi.unstubAllGlobals(); });

function pagedHistory() {
  const pending: { before: string; conversationId: string; resolve: (event: ServerEvent) => void }[] = [];
  const request = vi.fn((command: { payload: { conversationId: string; history: { before?: Cursor } } }) =>
    new Promise<ServerEvent>((resolve) => pending.push({
      before: command.payload.history.before?.id ?? "", conversationId: command.payload.conversationId, resolve })));
  const hook = renderHook(({ conversationId }) => {
    const [state, setState] = useState<ConversationDetailViewState | null>(
      { kind: "conversation.detail", conversationId, state: "ready", detail: detail(conversationId, 0, cursor(1)) });
    const current = state?.conversationId === conversationId ? state
      : { kind: "conversation.detail" as const, conversationId, state: "ready" as const, detail: detail(conversationId, 0, cursor(1)) };
    return { state: current, setState, history: useConversationHistory({ conversationId, online: true, detailState: current, setDetailState: setState, request }) };
  }, { initialProps: { conversationId: "chat" } });
  const answer = async (page: number, older: Cursor | null) => {
    const entry = pending.shift()!;
    expect(entry.before).toBe(`cursor-${page}`);
    await act(async () => entry.resolve(ready(entry.conversationId, page, older)));
  };
  const turnIds = () => hook.result.current.state.state === "ready"
    ? hook.result.current.state.detail.agentTurns.map(({ id }) => id) : [];
  return { hook, pending, request, answer, turnIds };
}

describe("older history prefetch", () => {
  it("fetches the next older page at idle and shows it on request without another round trip", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, cursor(2));
    expect(chat.turnIds()).toEqual(["turn-1", "turn-0"]);
    expect(chat.request).toHaveBeenCalledTimes(1);
    runIdle();
    expect(chat.request).toHaveBeenCalledTimes(2);
    await chat.answer(2, cursor(3));
    expect(chat.turnIds()).toEqual(["turn-1", "turn-0"]);
    act(() => chat.hook.result.current.history.loadOlder());
    expect(chat.turnIds()).toEqual(["turn-2", "turn-1", "turn-0"]);
    expect(chat.hook.result.current.history.loading).toBe(false);
    expect(chat.request).toHaveBeenCalledTimes(2);
    runIdle();
    expect(chat.request).toHaveBeenCalledTimes(3);
    expect(chat.pending[0]?.before).toBe("cursor-3");
  });

  it("keeps a single older request in flight and applies each page once", async () => {
    const chat = pagedHistory();
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(1, cursor(2));
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
    await chat.answer(1, cursor(2));
    chat.hook.rerender({ conversationId: "other" });
    runIdle();
    expect(chat.request).toHaveBeenCalledTimes(1);
    chat.hook.rerender({ conversationId: "chat" });
    act(() => chat.hook.result.current.history.loadOlder());
    await chat.answer(2, cursor(3));
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
    await chat.answer(1, cursor(2));
    runIdle();
    await chat.answer(2, cursor(3));
    act(() => chat.hook.result.current.setState({ kind: "conversation.detail", conversationId: "chat", state: "ready", detail: detail("chat", 0, cursor(1)) }));
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
  function scene(loading = false, hasOlder = true, online = true) {
    const loadOlder = vi.fn();
    const view = render(<NearTop history={{ hasOlder, loading, online, loadOlder }} />);
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

  it("stays quiet while a page is loading, offline, or when nothing older exists", () => {
    for (const [loading, hasOlder, online] of [[true, true, true], [false, false, true], [false, true, false]] as const) {
      const { element, loadOlder, view } = scene(loading, hasOlder, online);
      scrollTo(element, 900);
      scrollTo(element, 100);
      expect(loadOlder).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});
