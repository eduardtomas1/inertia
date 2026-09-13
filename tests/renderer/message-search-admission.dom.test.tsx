import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationNavigation } from "../../src/renderer/src/hooks/useConversationNavigation";
import { useAsyncOperationQueue, useWorkspaceAuthorityCommandQueue } from "../../src/renderer/src/hooks/useConversationSelectionQueue";
import { clearMessageSearchFocus, pendingMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";
import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { MessageSearchHit } from "../../src/shared/message-search";
import { conversation, deferred } from "./composer-fixtures";

const primary = conversation("primary");
const other = conversation("other");
const later = conversation("later");
const latest = conversation("latest");
const ok: ServerEvent = { type: "request.ok", requestId: "request" };
const hit: MessageSearchHit = {
  projectId: other.projectId, conversationId: other.id, turnId: "turn", messageId: "message",
  role: "assistant", createdAt: other.createdAt, snippet: "needle", matchStart: 0, matchEnd: 6,
};

function fixture(holdSearchSelection = false) {
  const blocked = deferred<void>();
  const revealed = deferred<ServerEvent>();
  const accepted = deferred<void>();
  const dispatched: string[] = [];
  const ready = vi.fn();
  const error = vi.fn();
  const hook = renderHook(() => {
    const [snapshot, setSnapshot] = useState({
      activeConversationId: primary.id, conversations: [primary, other, later, latest],
    } as AppSnapshot);
    const generation = useRef(0);
    const transitions = useRef(0);
    const enqueue = useAsyncOperationQueue();
    const queue = useWorkspaceAuthorityCommandQueue(async (_key, command: CommandWithoutId) => {
      if (command.type === "conversation.select") {
        dispatched.push(command.payload.conversationId);
        if (holdSearchSelection && command.payload.conversationId === other.id) await accepted.promise;
        // A real accepted command changes the authoritative snapshot before
        // navigation's promise continuation can discard an obsolete response.
        setSnapshot((current) => ({ ...current, activeConversationId: command.payload.conversationId }));
      }
      return ok;
    }, snapshot, enqueue);
    const navigation = useConversationNavigation({
      snapshot, conversation: snapshot.conversations.find(({ id }) => id === snapshot.activeConversationId)!,
      splitConversation: null,
      detachedChats: {
        ready: true, windows: [], conversationIds: new Set(), atLimit: false,
        focus: vi.fn(async () => false), open: vi.fn(),
      },
      exitGlobalChat: () => { generation.current += 1; },
      conversationSelectionGenerationRef: generation, splitSelectionTransitionsRef: transitions,
      setSuppressedMainConversationIds: vi.fn(), setSecondaryPaneFirst: vi.fn(),
      selectConversationCommand: (key, id, isCurrent) => queue(key, {
        type: "conversation.select", payload: { conversationId: id },
      }, isCurrent),
      updateSplitConversationId: vi.fn(), request: () => revealed.promise, setActionError: error,
    });
    return { snapshot, enqueue, navigation, transitions };
  });
  async function start(controller = new AbortController()) {
    await act(async () => { void hook.result.current.enqueue(() => blocked.promise); });
    let opened!: Promise<boolean>;
    await act(async () => {
      opened = hook.result.current.navigation.selectMessage(hit, ready, controller.signal);
      await vi.dynamicImportSettled();
    });
    await act(async () => revealed.resolve(ok));
    expect(dispatched).toEqual([]);
    expect(hook.result.current.transitions.current).toBe(1);
    return { controller, opened };
  }
  return { hook, blocked, accepted, dispatched, ready, error, start };
}

afterEach(() => { clearMessageSearchFocus(); });

describe("saved-message selection admission", () => {
  it.each(["abort", "reselect primary"])("does not dispatch a queued search after %s", async (reason) => {
    const f = fixture();
    const { controller, opened } = await f.start();
    await act(async () => {
      if (reason === "abort") controller.abort();
      else f.hook.result.current.navigation.selectConversation(primary);
    });
    await act(async () => { f.blocked.resolve(); await opened; });
    expect(await opened).toBe(false);
    expect(f.dispatched).toEqual(reason === "abort" ? [] : [primary.id]);
    expect(f.hook.result.current.snapshot.activeConversationId).toBe(primary.id);
    expect(f.hook.result.current.transitions.current).toBe(0);
    expect(f.ready).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalledWith(expect.any(String));
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("admits a still-current search after earlier workspace work completes", async () => {
    const f = fixture();
    const { opened } = await f.start();
    await act(async () => { f.blocked.resolve(); await opened; });
    expect(await opened).toBe(true);
    expect(f.dispatched).toEqual([other.id]);
    expect(f.hook.result.current.snapshot.activeConversationId).toBe(other.id);
    expect(f.hook.result.current.transitions.current).toBe(0);
    expect(f.ready).toHaveBeenCalledOnce();
    expect(pendingMessageSearchFocus(other.id)?.messageId).toBe(hit.messageId);
  });

  it("serializes a same-chat reselection after an already-admitted search", async () => {
    const f = fixture(true);
    const { opened } = await f.start();
    await act(async () => f.blocked.resolve());
    expect(f.dispatched).toEqual([other.id]);
    expect(f.hook.result.current.snapshot.activeConversationId).toBe(primary.id);
    await act(async () => f.hook.result.current.navigation.selectConversation(primary));
    // The prior command owns the FIFO until its accepted identity arrives.
    expect(f.dispatched).toEqual([other.id]);
    await act(async () => { f.accepted.resolve(); await opened; });
    expect(await opened).toBe(false);
    expect(f.dispatched).toEqual([other.id, primary.id]);
    expect(f.hook.result.current.snapshot.activeConversationId).toBe(primary.id);
    expect(f.hook.result.current.transitions.current).toBe(0);
    expect(f.ready).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("releases rejected search work without dropping later ordinary FIFO selections", async () => {
    const f = fixture();
    const { opened } = await f.start();
    await act(async () => {
      f.hook.result.current.navigation.selectConversation(later);
      f.hook.result.current.navigation.selectConversation(latest);
    });
    await act(async () => { f.blocked.resolve(); await opened; });
    expect(await opened).toBe(false);
    expect(f.dispatched).toEqual([later.id, latest.id]);
    expect(f.hook.result.current.snapshot.activeConversationId).toBe(latest.id);
    expect(f.hook.result.current.transitions.current).toBe(0);
    expect(f.ready).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });
});
