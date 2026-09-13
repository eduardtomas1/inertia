import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationNavigation } from "../../src/renderer/src/hooks/useConversationNavigation";
import { clearMessageSearchFocus, pendingMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";
import type { AppSnapshot, Conversation, ServerEvent } from "../../src/shared/contracts";
import type { MessageSearchHit } from "../../src/shared/message-search";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { conversation, deferred } from "./composer-fixtures";

const originalBridge = window.inertia;
const primary = conversation("primary");
const other = conversation("other");
const hit: MessageSearchHit = { projectId: other.projectId, conversationId: other.id, turnId: "turn", messageId: "message", role: "assistant", createdAt: other.createdAt, snippet: "needle", matchStart: 0, matchEnd: 6 };
const ok: ServerEvent = { type: "request.ok", requestId: "request" };
function fixture(splitConversation: Conversation | null = null, detached = false) {
  const generation = { current: 0 };
  const selected = deferred<ServerEvent>();
  const revealed = deferred<ServerEvent>();
  const focus = vi.fn(async () => detached);
  const nativeWindows = vi.fn(async () => detached ? [{ conversationId: other.id, alwaysOnTop: false }] : []);
  window.inertia = { ...originalBridge, getDetachedChatWindows: nativeWindows };
  const select = vi.fn(() => selected.promise);
  const request = vi.fn((_command: CommandWithoutId) => revealed.promise);
  const secondaryFirst = vi.fn();
  const error = vi.fn();
  const exitGlobalChat = vi.fn(() => { generation.current += 1; });
  const hook = renderHook(() => useConversationNavigation({
    snapshot: { conversations: [primary, other] } as AppSnapshot,
    conversation: primary, splitConversation,
    detachedChats: { ready: true, windows: [], conversationIds: new Set(detached ? [other.id] : []), atLimit: false, focus, open: vi.fn() },
    exitGlobalChat,
    conversationSelectionGenerationRef: generation, splitSelectionTransitionsRef: { current: 0 },
    setSuppressedMainConversationIds: vi.fn(), setSecondaryPaneFirst: secondaryFirst,
    selectConversationCommand: select, updateSplitConversationId: vi.fn(), request, setActionError: error,
  }));
  return { hook, generation, selected, revealed, focus, nativeWindows, select, request, secondaryFirst, error, exitGlobalChat };
}
afterEach(() => { clearMessageSearchFocus(); window.inertia = originalBridge; vi.restoreAllMocks(); });

describe("message search navigation", () => {
  it.each(["cancelled", "superseded"])("does not admit %s navigation after the lazy helper loads", async (reason) => {
    const f = fixture();
    const ready = vi.fn();
    const controller = new AbortController();
    let opened: Promise<boolean>;
    await act(async () => {
      opened = f.hook.result.current.selectMessage(hit, ready, controller.signal);
      if (reason === "cancelled") controller.abort();
      else f.generation.current += 1;
      await vi.dynamicImportSettled();
    });
    expect(await opened!).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
    expect(f.exitGlobalChat).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it("reports selection failure while retaining the current view and active draft", async () => {
    const f = fixture();
    const ready = vi.fn();
    await act(async () => { void f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    await act(async () => f.selected.reject(new Error("Runtime disconnected")));
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining("could not be opened"));
    expect(ready).not.toHaveBeenCalled();
    expect(f.exitGlobalChat).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("validates before navigation, waits for authoritative selection, then retains focus until detail arrives", async () => {
    const f = fixture();
    const ready = vi.fn();
    await act(async () => { void f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    expect(f.select).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    expect(f.request).toHaveBeenCalledWith({ type: "conversation.message.reveal", payload: { projectId: other.projectId, conversationId: other.id, turnId: "turn", messageId: "message" } });
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    await act(async () => f.revealed.resolve(ok));
    expect(f.select).toHaveBeenCalledWith("conversation.select", other.id, expect.any(Function));
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    expect(ready).not.toHaveBeenCalled();
    expect(f.exitGlobalChat).not.toHaveBeenCalled();
    await act(async () => f.selected.resolve(ok));
    expect(ready).toHaveBeenCalledOnce();
    expect(f.exitGlobalChat).toHaveBeenCalledWith(true);
    expect(pendingMessageSearchFocus(other.id)?.messageId).toBe(hit.messageId);
    f.generation.current += 1;
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("cancels pending selection without changing the view, draft, or focus", async () => {
    const f = fixture();
    const ready = vi.fn();
    const controller = new AbortController();
    let opened: Promise<boolean>;
    await act(async () => { opened = f.hook.result.current.selectMessage(hit, ready, controller.signal); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.select).toHaveBeenCalledOnce();
    act(() => controller.abort());
    await act(async () => f.selected.resolve(ok));
    expect(await opened!).toBe(false);
    expect(ready).not.toHaveBeenCalled();
    expect(f.exitGlobalChat).not.toHaveBeenCalled();
    expect(f.secondaryFirst).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalledWith(expect.any(String));
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("does not steal focus when another navigation overtakes validation", async () => {
    const f = fixture();
    await act(async () => { void f.hook.result.current.selectMessage(hit); await vi.dynamicImportSettled(); });
    act(() => f.hook.result.current.selectConversation(primary));
    await act(async () => f.revealed.resolve(ok));
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    expect(f.select).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the current workspace when persisted validation fails (detached: %s)", async (detached) => {
    const f = fixture(null, detached);
    const ready = vi.fn();
    await act(async () => { void f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.reject(new Error("Deleted result")));
    expect(f.select).not.toHaveBeenCalled();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.secondaryFirst).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining("could not be opened"));
  });

  it("promotes an existing split pane without changing its conversation controllers", async () => {
    const f = fixture(other);
    await act(async () => { void f.hook.result.current.selectMessage(hit); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.secondaryFirst).toHaveBeenCalledWith(true);
    expect(f.select).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)?.messageId).toBe(hit.messageId);
  });

  it("routes detached results to their owning window without selecting the main chat", async () => {
    const f = fixture(null, true);
    const ready = vi.fn();
    await act(async () => { void f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.focus).toHaveBeenCalledWith(other.id);
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenLastCalledWith({ type: "conversation.message.reveal", payload: {
      projectId: hit.projectId, conversationId: hit.conversationId, turnId: hit.turnId, messageId: hit.messageId, focusDetached: true,
    } });
    expect(ready).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("falls back to the main workspace without queuing focus when the detached window closes", async () => {
    const f = fixture(null, true);
    f.focus.mockResolvedValue(false);
    await act(async () => { void f.hook.result.current.selectMessage(hit); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    await act(async () => f.selected.resolve(ok));
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.select).toHaveBeenCalledWith("conversation.select", other.id, expect.any(Function));
    expect(pendingMessageSearchFocus(other.id)?.messageId).toBe(hit.messageId);
  });

  it.each(["accepted", "rejected"])("waits for %s main selection if the detached owner closes during reveal", async (outcome) => {
    const f = fixture(null, true);
    const delivered = deferred<ServerEvent>();
    const ready = vi.fn();
    f.request.mockImplementation((command) => command.type === "conversation.message.reveal" && command.payload.focusDetached ? delivered.promise : f.revealed.promise);
    f.nativeWindows.mockResolvedValue([]);
    let opened: Promise<boolean>;
    await act(async () => { opened = f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.focus).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.select).not.toHaveBeenCalled();
    await act(async () => delivered.resolve(ok));
    expect(f.select).toHaveBeenCalledWith("conversation.select", other.id, expect.any(Function));
    expect(ready).not.toHaveBeenCalled();
    expect(f.exitGlobalChat).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "accepted") f.selected.resolve(ok);
      else f.selected.reject(new Error("Selection rejected"));
    });
    expect(await opened!).toBe(outcome === "accepted");
    if (outcome === "accepted") {
      expect(ready).toHaveBeenCalledOnce();
      expect(f.exitGlobalChat).toHaveBeenCalledWith(true);
      expect(pendingMessageSearchFocus(other.id)?.messageId).toBe(hit.messageId);
    } else {
      expect(ready).not.toHaveBeenCalled();
      expect(f.exitGlobalChat).not.toHaveBeenCalled();
      expect(f.error).toHaveBeenCalledWith(expect.stringContaining("could not be opened"));
      expect(pendingMessageSearchFocus(other.id)).toBeNull();
    }
    expect(f.focus).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "superseded"])("does not fall back after %s navigation during the native ownership recheck", async (reason) => {
    const f = fixture(null, true);
    const windows = deferred<Awaited<ReturnType<typeof f.nativeWindows>>>();
    const controller = new AbortController();
    const ready = vi.fn();
    f.nativeWindows.mockReturnValue(windows.promise);
    let opened: Promise<boolean>;
    await act(async () => { opened = f.hook.result.current.selectMessage(hit, ready, controller.signal); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.nativeWindows).toHaveBeenCalledOnce();
    act(() => { if (reason === "cancelled") controller.abort(); else f.generation.current += 1; });
    await act(async () => windows.resolve([]));
    expect(await opened!).toBe(false);
    expect(f.focus).toHaveBeenCalledOnce();
    expect(f.select).not.toHaveBeenCalled();
    expect(f.exitGlobalChat).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("keeps the view and draft when the post-reveal native ownership read fails", async () => {
    const f = fixture(null, true);
    const ready = vi.fn();
    f.nativeWindows.mockRejectedValue(new Error("Private native failure details"));
    let opened: Promise<boolean>;
    await act(async () => { opened = f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(await opened!).toBe(false);
    expect(f.focus).toHaveBeenCalledOnce();
    expect(f.select).not.toHaveBeenCalled();
    expect(f.exitGlobalChat).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenLastCalledWith("This search result could not be opened. Search again to refresh it.");
  });

  it("does not queue detached focus after a newer navigation overtakes the native window request", async () => {
    const f = fixture(null, true);
    const focused = deferred<boolean>();
    f.focus.mockReturnValue(focused.promise);
    await act(async () => { void f.hook.result.current.selectMessage(hit); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.focus).toHaveBeenCalledOnce();
    act(() => f.hook.result.current.selectConversation(primary));
    await act(async () => focused.resolve(true));
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.select).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("rejects a stale shell identity without navigation", async () => {
    const f = fixture();
    await act(async () => { void f.hook.result.current.selectMessage({ ...hit, projectId: "foreign" }); await vi.dynamicImportSettled(); });
    expect(f.error).toHaveBeenCalledWith("This search result is no longer available.");
    expect(f.select).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
});
