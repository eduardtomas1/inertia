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
import {
  useDetachedChatWindows,
  useDockedTerminalOpen,
} from "../../src/renderer/src/hooks/useDetachedChatWindows";
import type { AppSnapshot, ClientCommand, ServerEvent } from "../../src/shared/contracts";
import type {
  DetachedChatWindowSummary,
  DetachedChatDraftHandoff,
  DetachedChatTerminalHandoff,
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
  onTerminalHandoff = vi.fn(() => vi.fn()),
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
  onTerminalHandoff?: (
    listener: (handoff: DetachedChatTerminalHandoff) => void,
  ) => () => void;
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
      onDetachedChatTerminalHandoff: onTerminalHandoff,
      openDetachedChat: vi.fn(),
      focusDetachedChat: vi.fn(),
      reportValidationDiagnostic: vi.fn(async () => null),
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
    const storageWrite = vi.spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });
    try {
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
    } finally {
      storageWrite.mockRestore();
    }
  });

  it("keeps a terminal handoff that arrives before the first runtime snapshot", async () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    const storageKey = `inertia:terminal-sessions:v1:${projectId}:${CONVERSATION_ID}`;
    let publish: ((handoff: DetachedChatTerminalHandoff) => void) | undefined;
    installDetachedChatBridge({
      onTerminalHandoff: vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      }),
    });
    const snapshot = {
      conversations: [{ id: CONVERSATION_ID, projectId }],
    } as unknown as AppSnapshot;
    const hook = renderHook(
      ({ current }: { current: AppSnapshot | null }) => useDetachedChatWindows(current),
      { initialProps: { current: null as AppSnapshot | null } },
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    act(() => publish?.({ conversationId: CONVERSATION_ID, terminalIds: [terminalId], dock: true }));
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(hook.result.current.dockedTerminalConversationId).toBeNull();

    hook.rerender({ current: snapshot });
    await waitFor(() => expect(hook.result.current.dockedTerminalConversationId).toBe(CONVERSATION_ID));
    expect(window.sessionStorage.getItem(storageKey)).toBe(JSON.stringify([terminalId]));
    window.sessionStorage.clear();
  });

  it("seeds the returned terminal ids and asks to open the terminal only on dock", async () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    const storageKey = `inertia:terminal-sessions:v1:${projectId}:${CONVERSATION_ID}`;
    let publish: ((handoff: DetachedChatTerminalHandoff) => void) | undefined;
    installDetachedChatBridge({
      onTerminalHandoff: vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      }),
    });
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify(["55555555-5555-4555-8555-555555555555"]),
    );
    const snapshot = {
      conversations: [{ id: CONVERSATION_ID, projectId }],
    } as unknown as AppSnapshot;
    const hook = renderHook(() => useDetachedChatWindows(snapshot));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    act(() => publish?.({
      conversationId: OTHER_CONVERSATION_ID,
      terminalIds: [terminalId],
      dock: true,
    }));
    expect(hook.result.current.dockedTerminalConversationId).toBeNull();

    act(() => publish?.({
      conversationId: CONVERSATION_ID,
      terminalIds: [terminalId],
      dock: false,
    }));
    expect(window.sessionStorage.getItem(storageKey)).toBe(JSON.stringify([terminalId]));
    expect(hook.result.current.dockedTerminalConversationId).toBeNull();

    act(() => publish?.({
      conversationId: CONVERSATION_ID,
      terminalIds: [],
      dock: true,
    }));
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    expect(hook.result.current.dockedTerminalConversationId).toBeNull();

    act(() => publish?.({
      conversationId: CONVERSATION_ID,
      terminalIds: [terminalId],
      dock: true,
    }));
    expect(window.sessionStorage.getItem(storageKey)).toBe(JSON.stringify([terminalId]));
    expect(hook.result.current.dockedTerminalConversationId).toBe(CONVERSATION_ID);
    act(() => hook.result.current.consumeDockedTerminal());
    expect(hook.result.current.dockedTerminalConversationId).toBeNull();
    window.sessionStorage.clear();
  });

  it("takes ownership of terminals handed back without docking, and leaves docked ones to the panel", async () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const terminalIds = [
      "44444444-4444-4444-8444-444444444444",
      "66666666-6666-4666-8666-666666666666",
    ];
    let publish: ((handoff: DetachedChatTerminalHandoff) => void) | undefined;
    installDetachedChatBridge({
      onTerminalHandoff: vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      }),
    });
    const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => ({
      type: "terminal.created",
      requestId: command.requestId,
      terminalId: (command as unknown as { payload: { terminalId: string } }).payload.terminalId,
    } as ServerEvent));
    const snapshot = {
      conversations: [{ id: CONVERSATION_ID, projectId }],
    } as unknown as AppSnapshot;
    const hook = renderHook(() => useDetachedChatWindows(snapshot, sendCommand));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    act(() => publish?.({ conversationId: CONVERSATION_ID, terminalIds, dock: true }));
    expect(sendCommand).not.toHaveBeenCalled();

    act(() => publish?.({ conversationId: CONVERSATION_ID, terminalIds, dock: false }));
    expect(sendCommand.mock.calls.map(([command]) => command)).toEqual(terminalIds.map((terminalId) => ({
      type: "terminal.attach",
      requestId: expect.any(String),
      payload: {
        projectId,
        conversationId: CONVERSATION_ID,
        terminalId,
        background: true,
        cols: 80,
        rows: 24,
      },
    })));
    expect(window.inertia.reportValidationDiagnostic).not.toHaveBeenCalled();
    window.sessionStorage.clear();
  });

  it("records a diagnostic once when the main window cannot take back a closed window's terminals", async () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    let publish: ((handoff: DetachedChatTerminalHandoff) => void) | undefined;
    installDetachedChatBridge({
      onTerminalHandoff: vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      }),
    });
    const sendCommand = vi.fn(async (): Promise<ServerEvent> => {
      throw new Error("This window already has the maximum number of terminals.");
    });
    const snapshot = {
      conversations: [{ id: CONVERSATION_ID, projectId }],
    } as unknown as AppSnapshot;
    const hook = renderHook(() => useDetachedChatWindows(snapshot, sendCommand));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    act(() => publish?.({
      conversationId: CONVERSATION_ID,
      terminalIds: ["44444444-4444-4444-8444-444444444444", "66666666-6666-4666-8666-666666666666"],
      dock: false,
    }));
    await waitFor(() => expect(window.inertia.reportValidationDiagnostic).toHaveBeenCalledOnce());
    expect(window.inertia.reportValidationDiagnostic).toHaveBeenCalledWith({
      code: "terminal.handoff-unowned",
      correlationId: expect.any(String),
      context: { projectId, conversationId: CONVERSATION_ID },
    });
    window.sessionStorage.clear();
  });
});

describe("useDockedTerminalOpen", () => {
  it("opens the main terminal once the docked chat is the one shown", () => {
    const openTerminal = vi.fn();
    const consumeDockedTerminal = vi.fn();
    const hook = renderHook(
      ({ requested, shown }: { requested: string | null; shown: string | null }) =>
        useDockedTerminalOpen(
          { dockedTerminalConversationId: requested, consumeDockedTerminal },
          shown,
          openTerminal,
        ),
      { initialProps: { requested: null as string | null, shown: CONVERSATION_ID as string | null } },
    );
    expect(openTerminal).not.toHaveBeenCalled();
    hook.rerender({ requested: CONVERSATION_ID, shown: OTHER_CONVERSATION_ID });
    hook.rerender({ requested: CONVERSATION_ID, shown: null });
    expect(openTerminal).not.toHaveBeenCalled();
    hook.rerender({ requested: CONVERSATION_ID, shown: CONVERSATION_ID });
    expect(consumeDockedTerminal).toHaveBeenCalledOnce();
    expect(openTerminal).toHaveBeenCalledOnce();
  });
});

describe("DetachedConversationPlaceholder", () => {
  it("focuses a live detached window from one line and one button", () => {
    const onActivate = vi.fn();
    render(
      <DetachedConversationPlaceholder
        title="Long-running refactor"
        windowOpen
        onActivate={onActivate}
      />,
    );

    expect(screen.getByRole("heading", { name: "Chat window active" })).toBeVisible();
    const placeholder = screen.getByRole("region", { name: "Detached chat: Long-running refactor" });
    expect(placeholder).toHaveTextContent(/^Chat window activeFocus chat window$/u);
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

    expect(screen.getByRole("heading", { name: "Chat window closed" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Detached chat: Long-running refactor" }))
      .toHaveTextContent(/^Chat window closedOpen chat here$/u);
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open chat here" }));

    expect(onActivate).toHaveBeenCalledOnce();
  });
});
