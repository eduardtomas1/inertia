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
  DetachedChatWindowRequest,
  DetachedChatWindowSummary,
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
  onWindowsChanged = vi.fn(() => vi.fn()),
  open = vi.fn(),
  focus = vi.fn(),
}: {
  getWindows?: () => Promise<DetachedChatWindowSummary[]>;
  onWindowsChanged?: (
    listener: (windows: DetachedChatWindowSummary[]) => void,
  ) => () => void;
  open?: (
    request: DetachedChatWindowRequest,
  ) => Promise<DetachedChatWindowOpenResult>;
  focus?: (conversationId: string) => Promise<boolean>;
} = {}): void {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getDetachedChatWindows: getWindows,
      onDetachedChatWindowsChanged: onWindowsChanged,
      openDetachedChat: open,
      focusDetachedChat: focus,
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
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
    expect(hook.result.current.ready).toBe(true);
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
    const unsubscribe = vi.fn();
    installDetachedChatBridge({
      onWindowsChanged: vi.fn(() => unsubscribe),
    });

    const hook = renderHook(() => useDetachedChatWindows());
    hook.unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("forwards open and focus requests to the desktop bridge", async () => {
    const request: DetachedChatWindowRequest = {
      conversationId: CONVERSATION_ID,
      title: "Detached ownership",
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
