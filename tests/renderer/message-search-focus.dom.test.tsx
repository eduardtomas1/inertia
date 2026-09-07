import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMessageSearchFocus } from "../../src/renderer/src/components/response-timeline/useMessageSearchFocus";
import { clearMessageSearchFocus, pendingMessageSearchFocus, requestMessageSearchFocus } from "../../src/renderer/src/utils/messageSearchFocus";
import type { ChatMessage } from "../../src/shared/contracts";
import type { ResponseTimelineItem } from "../../src/renderer/src/utils/responseTimeline";

const target = { projectId: "project", conversationId: "chat", turnId: null, messageId: "message" };
const message: ChatMessage = { id: "message", conversationId: "chat", turnId: null, role: "user", content: "needle", attachments: [], createdAt: "2026-09-07T00:00:00Z" };
afterEach(() => clearMessageSearchFocus());

describe("deferred message-search focus", () => {
  it("waits for the right detail and handles an inferred legacy turn by message identity", () => {
    const focus = vi.fn();
    const reading = vi.fn();
    const timeline = [{ kind: "turn", turn: { id: "inferred-turn", userMessage: message } }] as ResponseTimelineItem[];
    requestMessageSearchFocus(target);
    const hook = renderHook(({ messages, projectId }) => useMessageSearchFocus(
      { conversationId: "chat", projectId, messages }, timeline, reading, focus,
    ), { initialProps: { messages: [] as ChatMessage[], projectId: "project" } });
    expect(focus).not.toHaveBeenCalled();
    hook.rerender({ messages: [message], projectId: "other" });
    expect(focus).not.toHaveBeenCalled();
    hook.rerender({ messages: [message], projectId: "project" });
    expect(reading).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith(0, "turn");
    expect(pendingMessageSearchFocus("chat")).toBeNull();
    hook.rerender({ messages: [message], projectId: "project" });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("does not redirect another timeline or outlive the requesting navigation", () => {
    const focus = vi.fn();
    let current = true;
    const timeline = [{ kind: "compatibility", compatibility: { messages: [message] } }] as ResponseTimelineItem[];
    renderHook(() => useMessageSearchFocus({ conversationId: "other", projectId: "project", messages: [message] }, timeline, vi.fn(), focus));
    act(() => requestMessageSearchFocus(target, () => current));
    expect(focus).not.toHaveBeenCalled();
    current = false;
    expect(pendingMessageSearchFocus("chat")).toBeNull();
  });
});
