import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_SEND_FEEDBACK_MS,
  COMPOSER_SEND_FEEDBACK_RETENTION_MS,
  useComposerSendFeedback,
} from "../../src/renderer/src/components/composer/useComposerSendFeedback";

afterEach(() => vi.useRealTimers());

describe("composer send feedback ownership", () => {
  it("expires definite acceptance", () => {
    vi.useFakeTimers();
    const acceptance = {
      kind: "message.accepted" as const,
      conversationId: "conversation-one",
      turnId: "turn-one",
      userMessageId: "message-one",
      disposition: "new-turn" as const,
    };
    const view = renderHook(
      ({ conversationId, currentAcceptance }) => useComposerSendFeedback(
        conversationId,
        currentAcceptance,
      ),
      {
        initialProps: {
          conversationId: "conversation-one",
          currentAcceptance: acceptance,
        },
      },
    );
    expect(view.result.current).toEqual({
      disposition: "new-turn",
      turnId: "turn-one",
      visible: true,
    });

    act(() => {
      vi.advanceTimersByTime(COMPOSER_SEND_FEEDBACK_MS);
    });
    expect(view.result.current?.visible).toBe(false);
    act(() => {
      vi.advanceTimersByTime(
        COMPOSER_SEND_FEEDBACK_RETENTION_MS - COMPOSER_SEND_FEEDBACK_MS,
      );
    });
    expect(view.result.current).toBeNull();
  });

  it("does not replay acceptance after switching conversations", () => {
    vi.useFakeTimers();
    const acceptance = {
      kind: "message.accepted" as const,
      conversationId: "conversation-one",
      turnId: "turn-one",
      userMessageId: "message-one",
      disposition: "new-turn" as const,
    };
    const view = renderHook(
      ({ conversationId }) => useComposerSendFeedback(conversationId, acceptance),
      { initialProps: { conversationId: "conversation-one" } },
    );

    view.rerender({ conversationId: "conversation-two" });
    expect(view.result.current).toBeNull();
    view.rerender({ conversationId: "conversation-one" });

    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores legacy acknowledgements and clears its timer on unmount", () => {
    vi.useFakeTimers();
    const view = renderHook(
      ({ acceptance }) => useComposerSendFeedback("conversation-one", acceptance),
      { initialProps: { acceptance: null as Parameters<typeof useComposerSendFeedback>[1] } },
    );
    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    view.rerender({ acceptance: {
      kind: "message.accepted",
      conversationId: "conversation-one",
      turnId: "turn-one",
      userMessageId: "message-one",
      disposition: "follow-up" as const,
    } });
    expect(vi.getTimerCount()).toBe(2);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an acceptance owned by another conversation", () => {
    vi.useFakeTimers();
    const view = renderHook(() => useComposerSendFeedback("conversation-one", {
      kind: "message.accepted",
      conversationId: "conversation-two",
      turnId: "turn-two",
      userMessageId: "message-two",
      disposition: "new-turn",
    }));

    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears retained acceptance before the next submission", () => {
    vi.useFakeTimers();
    const acceptance = {
      kind: "message.accepted",
      conversationId: "conversation-one",
      turnId: "turn-one",
      userMessageId: "message-one",
      disposition: "new-turn" as const,
    } as const;
    const view = renderHook(
      ({ currentAcceptance }) => useComposerSendFeedback(
        "conversation-one",
        currentAcceptance,
      ),
      { initialProps: { currentAcceptance: acceptance as typeof acceptance | null } },
    );
    expect(view.result.current?.turnId).toBe("turn-one");

    view.rerender({ currentAcceptance: null });

    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
