// @vitest-environment happy-dom

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetachedConversationPlaceholder } from "../../src/renderer/src/components/DetachedConversationPlaceholder";
import { useDetachedChatWindows } from "../../src/renderer/src/hooks/useDetachedChatWindows";
import type {
  DetachedChatWindowOpenResult,
  DetachedChatWindowOpenRequest,
  DetachedChatWindowSummary,
  DetachedChatDraftHandoff,
  PendingDetachedChatDraft,
} from "../../src/shared/desktop";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

const lifecycleWindow: DetachedChatWindowSummary = {
  conversationId: CONVERSATION_ID,
  alwaysOnTop: false,
};
const staleSnapshotWindow: DetachedChatWindowSummary = {
  conversationId: OTHER_CONVERSATION_ID,
  alwaysOnTop: true,
};

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installDetachedChatBridge({
  getWindows = vi.fn(async () => []),
  getPendingDrafts = vi.fn(async () => []),
  acknowledgeDraft = vi.fn(async () => true),
  onWindowsChanged = vi.fn(() => vi.fn()),
  onDraftChanged = vi.fn(() => vi.fn()),
  onDraftMirrored = vi.fn(() => vi.fn()),
  open = vi.fn(),
  focus = vi.fn(),
}: {
  getWindows?: () => Promise<DetachedChatWindowSummary[]>;
  getPendingDrafts?: () => Promise<PendingDetachedChatDraft[]>;
  acknowledgeDraft?: (request: {
    conversationId: string;
    handoffId: string;
  }) => Promise<boolean>;
  onWindowsChanged?: (
    listener: (windows: DetachedChatWindowSummary[]) => void,
  ) => () => void;
  onDraftChanged?: (
    listener: (handoff: PendingDetachedChatDraft) => void,
  ) => () => void;
  onDraftMirrored?: (
    listener: (handoff: DetachedChatDraftHandoff) => void,
  ) => () => void;
  open?: (
    request: DetachedChatWindowOpenRequest,
  ) => Promise<DetachedChatWindowOpenResult>;
  focus?: (conversationId: string) => Promise<boolean>;
} = {}): void {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getDetachedChatWindows: getWindows,
      getPendingDetachedChatDrafts: getPendingDrafts,
      acknowledgeDetachedChatDraft: acknowledgeDraft,
      onDetachedChatWindowsChanged: onWindowsChanged,
      onDetachedChatDraftChanged: onDraftChanged,
      onDetachedChatDraftMirrored: onDraftMirrored,
      openDetachedChat: open,
      focusDetachedChat: focus,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "inertia");
  window.localStorage.clear();
});

describe("useDetachedChatWindows", () => {
  it("subscribes before requesting the snapshot and never lets it overwrite a newer event", async () => {
    const initial = deferred<DetachedChatWindowSummary[]>();
    const callOrder: string[] = [];
    let publish: ((windows: DetachedChatWindowSummary[]) => void) | undefined;
    installDetachedChatBridge({
      getWindows: vi.fn(() => {
        callOrder.push("snapshot");
        return initial.promise;
      }),
      onWindowsChanged: vi.fn((listener) => {
        callOrder.push("subscribe");
        publish = listener;
        return vi.fn();
      }),
    });

    const hook = renderHook(() => useDetachedChatWindows());

    expect(callOrder).toEqual(["subscribe", "snapshot"]);
    act(() => publish?.([lifecycleWindow]));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.windows).toEqual([lifecycleWindow]);

    await act(async () => {
      initial.resolve([staleSnapshotWindow]);
      await initial.promise;
    });

    expect(hook.result.current.windows).toEqual([lifecycleWindow]);
    expect(hook.result.current.conversationIds).toEqual(
      new Set([CONVERSATION_ID]),
    );
  });

  it("finishes hydration when the initial snapshot request fails", async () => {
    installDetachedChatBridge({
      getWindows: vi.fn(async () => {
        throw new Error("main process unavailable");
      }),
    });

    const hook = renderHook(() => useDetachedChatWindows());

    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.windows).toEqual([]);
    expect(hook.result.current.conversationIds.size).toBe(0);
    expect(hook.result.current.atLimit).toBe(false);
  });

  it("unsubscribes from lifecycle events when its owner unmounts", () => {
    const unsubscribeWindows = vi.fn();
    const unsubscribeDrafts = vi.fn();
    const unsubscribeMirrors = vi.fn();
    installDetachedChatBridge({
      onWindowsChanged: vi.fn(() => unsubscribeWindows),
      onDraftChanged: vi.fn(() => unsubscribeDrafts),
      onDraftMirrored: vi.fn(() => unsubscribeMirrors),
    });

    const hook = renderHook(() => useDetachedChatWindows());
    hook.unmount();

    expect(unsubscribeWindows).toHaveBeenCalledOnce();
    expect(unsubscribeDrafts).toHaveBeenCalledOnce();
    expect(unsubscribeMirrors).toHaveBeenCalledOnce();
  });

  it("stores and acknowledges the exact draft returned by its popup", async () => {
    let publishDraft: ((handoff: PendingDetachedChatDraft) => void) | undefined;
    const acknowledgeDraft = vi.fn(async () => true);
    installDetachedChatBridge({
      acknowledgeDraft,
      onDraftChanged: vi.fn((listener) => {
        publishDraft = listener;
        return vi.fn();
      }),
    });
    renderHook(() => useDetachedChatWindows());

    act(() => publishDraft?.({
      conversationId: CONVERSATION_ID,
      draft: "returned without loss",
      handoffId: "33333333-3333-4333-8333-333333333333",
    }));

    expect(window.localStorage.getItem(
      `inertia:draft:${CONVERSATION_ID}`,
    )).toBe("returned without loss");
    await waitFor(() => expect(acknowledgeDraft).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      handoffId: "33333333-3333-4333-8333-333333333333",
    }));
  });

  it("mirrors an active popup draft without acknowledging a handoff", () => {
    let publishMirror: ((handoff: DetachedChatDraftHandoff) => void) | undefined;
    const acknowledgeDraft = vi.fn(async () => true);
    installDetachedChatBridge({
      acknowledgeDraft,
      onDraftMirrored: vi.fn((listener) => {
        publishMirror = listener;
        return vi.fn();
      }),
    });
    renderHook(() => useDetachedChatWindows());

    act(() => publishMirror?.({
      conversationId: CONVERSATION_ID,
      draft: "latest live popup edit",
    }));

    expect(window.localStorage.getItem(
      `inertia:draft:${CONVERSATION_ID}`,
    )).toBe("latest live popup edit");
    expect(acknowledgeDraft).not.toHaveBeenCalled();
  });

  it("hydrates pending drafts before ready without overwriting a newer event", async () => {
    const pending = deferred<PendingDetachedChatDraft[]>();
    const acknowledgeDraft = vi.fn(async () => true);
    let publishDraft: ((handoff: PendingDetachedChatDraft) => void) | undefined;
    installDetachedChatBridge({
      getPendingDrafts: vi.fn(() => pending.promise),
      acknowledgeDraft,
      onDraftChanged: vi.fn((listener) => {
        publishDraft = listener;
        return vi.fn();
      }),
    });
    const hook = renderHook(() => useDetachedChatWindows());
    expect(hook.result.current.ready).toBe(false);

    act(() => publishDraft?.({
      conversationId: CONVERSATION_ID,
      draft: "newer event draft",
      handoffId: "44444444-4444-4444-8444-444444444444",
    }));
    await act(async () => {
      pending.resolve([{
        conversationId: CONVERSATION_ID,
        draft: "stale snapshot draft",
        handoffId: "55555555-5555-4555-8555-555555555555",
      }]);
      await pending.promise;
    });

    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(window.localStorage.getItem(
      `inertia:draft:${CONVERSATION_ID}`,
    )).toBe("newer event draft");
    expect(acknowledgeDraft).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      handoffId: "44444444-4444-4444-8444-444444444444",
    });
    expect(acknowledgeDraft).not.toHaveBeenCalledWith(expect.objectContaining({
      handoffId: "55555555-5555-4555-8555-555555555555",
    }));
  });

  it("does not let an older pending snapshot overwrite a live mirror", async () => {
    const pending = deferred<PendingDetachedChatDraft[]>();
    let publishMirror: ((handoff: DetachedChatDraftHandoff) => void) | undefined;
    installDetachedChatBridge({
      getPendingDrafts: vi.fn(() => pending.promise),
      onDraftMirrored: vi.fn((listener) => {
        publishMirror = listener;
        return vi.fn();
      }),
    });
    const hook = renderHook(() => useDetachedChatWindows());

    act(() => publishMirror?.({
      conversationId: CONVERSATION_ID,
      draft: "new live mirror",
    }));
    await act(async () => {
      pending.resolve([{
        conversationId: CONVERSATION_ID,
        draft: "older durable handoff",
        handoffId: "77777777-7777-4777-8777-777777777777",
      }]);
      await pending.promise;
    });

    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(window.localStorage.getItem(
      `inertia:draft:${CONVERSATION_ID}`,
    )).toBe("new live mirror");
  });

  it("leaves a pending handoff unacknowledged when storage is unavailable", async () => {
    const acknowledgeDraft = vi.fn(async () => true);
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    installDetachedChatBridge({
      acknowledgeDraft,
      getPendingDrafts: vi.fn(async () => [{
        conversationId: CONVERSATION_ID,
        draft: "retry after reload",
        handoffId: "66666666-6666-4666-8666-666666666666",
      }]),
    });

    const hook = renderHook(() => useDetachedChatWindows());

    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(acknowledgeDraft).not.toHaveBeenCalled();
  });

  it("forwards open and focus requests to the desktop bridge", async () => {
    const request: DetachedChatWindowOpenRequest = {
      conversationId: CONVERSATION_ID,
      title: "Detached ownership",
      draft: "exact draft",
    };
    const opened: DetachedChatWindowOpenResult = {
      conversationId: CONVERSATION_ID,
      alwaysOnTop: false,
      disposition: "opened",
    };
    const open = vi.fn(async () => opened);
    const focus = vi.fn(async () => true);
    installDetachedChatBridge({ open, focus });
    const hook = renderHook(() => useDetachedChatWindows());

    await expect(hook.result.current.open(request)).resolves.toEqual(opened);
    await expect(hook.result.current.focus(CONVERSATION_ID)).resolves.toBe(true);

    expect(open).toHaveBeenCalledWith(request);
    expect(focus).toHaveBeenCalledWith(CONVERSATION_ID);
  });
});

describe("DetachedConversationPlaceholder", () => {
  it("focuses a live detached window and explains that its work continues", () => {
    const onActivate = vi.fn();
    render(
      <DetachedConversationPlaceholder
        title="Long-running refactor"
        windowOpen
        onActivate={onActivate}
      />,
    );

    expect(screen.getByText("Chat window active")).toBeVisible();
    expect(screen.getByText(/work continues independently/iu)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Focus chat window" }));

    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("offers an explicit return to the main workspace after a window closes", () => {
    const onActivate = vi.fn();
    render(
      <DetachedConversationPlaceholder
        title="Long-running refactor"
        windowOpen={false}
        onActivate={onActivate}
      />,
    );

    expect(screen.getByText("Chat window closed")).toBeVisible();
    expect(screen.getByText(
      /Closing the window left this workspace unchanged/iu,
    )).toBeVisible();
    expect(screen.getByText(
      /Any active work keeps running in the background/iu,
    )).toBeVisible();
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open chat here" }));

    expect(onActivate).toHaveBeenCalledOnce();
  });
});
