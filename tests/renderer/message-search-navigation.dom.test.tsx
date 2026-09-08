import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationNavigation } from "../../src/renderer/src/hooks/useConversationNavigation";
import { clearMessageSearchFocus, pendingMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";
import type { AppSnapshot, Conversation, ServerEvent } from "../../src/shared/contracts";
import type { MessageSearchHit } from "../../src/shared/message-search";
import { conversation, deferred } from "./composer-fixtures";

const primary = conversation("primary");
const other = conversation("other");
const hit: MessageSearchHit = { projectId: other.projectId, conversationId: other.id, turnId: "turn", messageId: "message", role: "assistant", createdAt: other.createdAt, snippet: "needle", matchStart: 0, matchEnd: 6 };
const ok: ServerEvent = { type: "request.ok", requestId: "request" };
function fixture(splitConversation: Conversation | null = null, detached = false) {
  const generation = { current: 0 };
  const selected = deferred<ServerEvent>();
  const revealed = deferred<ServerEvent>();
  const focus = vi.fn(async () => detached);
  const select = vi.fn(() => selected.promise);
  const request = vi.fn(() => revealed.promise);
  const secondaryFirst = vi.fn();
  const error = vi.fn();
  const hook = renderHook(() => useConversationNavigation({
    snapshot: { conversations: [primary, other] } as AppSnapshot,
    conversation: primary, splitConversation,
    detachedChats: { ready: true, windows: [], conversationIds: new Set(detached ? [other.id] : []), atLimit: false, focus, open: vi.fn() },
    exitGlobalChat: () => { generation.current += 1; },
    conversationSelectionGenerationRef: generation, splitSelectionTransitionsRef: { current: 0 },
    setSuppressedMainConversationIds: vi.fn(), setSecondaryPaneFirst: secondaryFirst,
    selectConversationCommand: select, updateSplitConversationId: vi.fn(), request, setActionError: error,
  }));
  return { hook, generation, selected, revealed, focus, select, request, secondaryFirst, error };
}
afterEach(() => { clearMessageSearchFocus(); vi.restoreAllMocks(); });

describe("message search navigation", () => {
  it("validates before navigation, waits for authoritative selection, then retains focus until detail arrives", async () => {
    const f = fixture();
    await act(async () => { f.hook.result.current.selectMessage(hit); await vi.dynamicImportSettled(); });
    expect(f.select).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    expect(f.request).toHaveBeenCalledWith({ type: "conversation.message.reveal", payload: { projectId: other.projectId, conversationId: other.id, turnId: "turn", messageId: "message" } });
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    await act(async () => f.revealed.resolve(ok));
    expect(f.select).toHaveBeenCalledWith("conversation.select", other.id);
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    await act(async () => f.selected.resolve(ok));
    expect(pendingMessageSearchFocus(other.id)?.messageId).toBe(hit.messageId);
    f.generation.current += 1;
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("does not steal focus when another navigation overtakes validation", async () => {
    const f = fixture();
    await act(async () => { f.hook.result.current.selectMessage(hit); await vi.dynamicImportSettled(); });
    act(() => f.hook.result.current.selectConversation(primary));
    await act(async () => f.revealed.resolve(ok));
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
    expect(f.select).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the current workspace when persisted validation fails (detached: %s)", async (detached) => {
    const f = fixture(null, detached);
    const ready = vi.fn();
    await act(async () => { f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.reject(new Error("Deleted result")));
    expect(f.select).not.toHaveBeenCalled();
    expect(f.focus).not.toHaveBeenCalled();
    expect(f.secondaryFirst).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenCalledWith(expect.stringContaining("could not be opened"));
  });

  it("promotes an existing split pane without changing its conversation controllers", async () => {
    const f = fixture(other);
    await act(async () => { f.hook.result.current.selectMessage(hit); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.secondaryFirst).toHaveBeenCalledWith(true);
    expect(f.select).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)?.messageId).toBe(hit.messageId);
  });

  it("routes detached results to their owning window without selecting the main chat", async () => {
    const f = fixture(null, true);
    const ready = vi.fn();
    await act(async () => { f.hook.result.current.selectMessage(hit, ready); await vi.dynamicImportSettled(); });
    await act(async () => f.revealed.resolve(ok));
    expect(f.focus).toHaveBeenCalledWith(other.id);
    expect(f.request).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
    expect(pendingMessageSearchFocus(other.id)).toBeNull();
  });

  it("rejects a stale shell identity without navigation", async () => {
    const f = fixture();
    await act(async () => { f.hook.result.current.selectMessage({ ...hit, projectId: "foreign" }); await vi.dynamicImportSettled(); });
    expect(f.error).toHaveBeenCalledWith("This search result is no longer available.");
    expect(f.select).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });
});
