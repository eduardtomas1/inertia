import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_SEND_FEEDBACK_MS,
  COMPOSER_SEND_FEEDBACK_RETENTION_MS,
  useComposerSendFeedback,
} from "../../src/renderer/src/components/composer/useComposerSendFeedback";

afterEach(() => vi.useRealTimers());

describe("composer send feedback ownership", () => {
  it("expires definite acceptance and hides it from another conversation", () => {
    vi.useFakeTimers();
    const view = renderHook(
      ({ conversationId }) => useComposerSendFeedback(conversationId),
      { initialProps: { conversationId: "conversation-one" } },
    );
    act(() => view.result.current[1]({
      kind: "message.accepted",
      conversationId: "conversation-one",
      turnId: "turn-one",
      userMessageId: "message-one",
      disposition: "new-turn",
    }));
    expect(view.result.current[0]).toEqual({
      conversationId: "conversation-one",
      disposition: "new-turn",
      sequence: 1,
      turnId: "turn-one",
      visible: true,
    });

    view.rerender({ conversationId: "conversation-two" });
    expect(view.result.current[0]).toBeNull();
    view.rerender({ conversationId: "conversation-one" });
    act(() => {
      vi.advanceTimersByTime(COMPOSER_SEND_FEEDBACK_MS);
    });
    expect(view.result.current[0]?.visible).toBe(false);
    act(() => {
      vi.advanceTimersByTime(
        COMPOSER_SEND_FEEDBACK_RETENTION_MS - COMPOSER_SEND_FEEDBACK_MS,
      );
    });
    expect(view.result.current[0]).toBeNull();
  });

  it("ignores legacy acknowledgements and clears its timer on unmount", () => {
    vi.useFakeTimers();
    const view = renderHook(() => useComposerSendFeedback("conversation-one"));
    act(() => view.result.current[1](null));
    expect(view.result.current[0]).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => view.result.current[1]({
      kind: "message.accepted",
      conversationId: "conversation-one",
      turnId: "turn-one",
      userMessageId: "message-one",
      disposition: "follow-up",
    }));
    expect(vi.getTimerCount()).toBe(2);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears retained acceptance before the next submission", () => {
    vi.useFakeTimers();
    const view = renderHook(() => useComposerSendFeedback("conversation-one"));
    act(() => view.result.current[1]({
      kind: "message.accepted",
      conversationId: "conversation-one",
      turnId: "turn-one",
      userMessageId: "message-one",
      disposition: "new-turn",
    }));
    expect(view.result.current[0]?.turnId).toBe("turn-one");

    act(() => view.result.current[2]());

    expect(view.result.current[0]).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
